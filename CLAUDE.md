# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Safe Browse — transparent parental controls for Windows 10/11. A C# Windows service does the actual enforcement (local DNS proxy + policy engine) and keeps working offline; a Cloudflare Worker serves the parent dashboard, device sync API, and signed blocklists. Live SaaS: https://safebrowse.incorpify.in (Worker `safe-browse-api`, D1 `safe-browse`, R2 `safe-browse-lists` + `safe-browse-releases`).

**Privacy boundary (enforced, not aspirational):** only top-level hostnames and blocked DNS attempts are ever recorded — never paths, query strings, titles, or page content. Do not add telemetry that crosses this line.

## Commands

npm workspaces at the root (`apps/*`, `packages/*`, `tools/*`), Node >= 22.

```bash
npm run check                    # typecheck + build + test across all workspaces (what CI runs)
                                 # build MUST precede test: the worker's integration test boots
                                 # Miniflare from wrangler.jsonc, whose assets.directory points at
                                 # apps/dashboard/dist, absent on a never-built checkout
npm run typecheck                # or -w a single workspace
npm test

npm run dev --workspace @safe-browse/worker      # wrangler dev
npm run dev --workspace @safe-browse/dashboard   # vite
npm run db:local --workspace @safe-browse/worker # apply D1 migrations to local Miniflare DB

# single test file / single test
npx vitest run apps/worker/src/crypto.test.ts --root apps/worker
npx vitest run apps/worker/src/isolation.integration.test.ts -t "cannot read another household" --root apps/worker
```

Windows agent (must run on Windows with .NET 8 SDK):

```powershell
dotnet test apps/windows/tests/SafeBrowse.Core.Tests/SafeBrowse.Core.Tests.csproj -c Release
pwsh apps/windows/build.ps1      # test + self-contained publish of all 4 exes + WiX MSI
```

Blocklists: `SAFE_BROWSE_SIGNING_KEY=/path/key.pem npm run compile --workspace @safe-browse/blocklists -- ./out`

Deploy: `bash tools/deploy.sh` (idempotent — creates/patches D1, R2, Turnstile widget in `wrangler.jsonc`, builds dashboard, migrates, deploys). `--reset-parent-auth` is the operator break-glass that wipes parent PIN/TOTP/recovery/sessions in remote D1. Manual redeploy steps are in `docs/production.md`.

## Architecture

Four layers; the important thing is that **enforcement is local and cloud-independent**.

- **`apps/worker`** — Hono on Cloudflare Workers. `src/index.ts` mounts `/api/v1/auth`, `/api/v1/parent`, `/api/v1/device`; anything unmatched falls through to the `ASSETS` binding, which serves the built dashboard as an SPA (`run_worker_first` covers `/api/*` and `/health`). Two cron triggers in `src/scheduled.ts`: `*/5 * * * *` marks devices offline and emails, `17 2 * * *` runs data retention (30-day events/audit, expired codes/rules).
- **`apps/dashboard`** — React + Vite. Built into `dist/`, which the Worker serves; it is not deployed separately.
- **`apps/windows`** — .NET 8, four executables sharing `SafeBrowse.Core` (`PolicyEvaluator`, `DomainNormalizer`, `DnsMessage`): `Service` (SYSTEM service, DNS proxy on `127.0.0.1:53`, named-pipe host, 60s sync), `NativeHost` (stdio↔pipe relay for the extension), `Enroll`, `Tray`. Device token is DPAPI-encrypted at `C:\ProgramData\SafeBrowse\device.credential`; policy cached at `policy.json`.
- **`apps/extension`** — MV3, esbuild to `dist/chromium` and `dist/firefox` from shared `src/` + per-target `manifests/`. Telemetry and block UI only — disabling it does not bypass DNS enforcement.
- **`packages/contracts`** — the single source of truth for policy/event/enrollment shapes (Zod). Consumed by worker and dashboard as TypeScript source (`main` points at `src/index.ts`); the C# agent mirrors these names by hand, so a rename here needs a matching change in `PolicyModels.cs`/`PolicyEvaluator.cs`.
- **`tools/blocklists`** — compiles upstream feeds (`sources.json`) into deterministic `*.txt.gz` per category plus an ES256-signed `manifest.json`. Agents verify the signature before loading.

### Blocklist pipeline (fails silently when broken — check it deliberately)

Every link here degrades quietly rather than erroring, which is how category blocking stayed non-functional in production without anyone noticing:

- No `lists/latest.json` in R2 → `latestListVersion()` returns `"bootstrap"` → `ProtectionWorker` **skips list sync entirely** → category sets stay empty while the service still reports `healthy`. Custom domain rules keep working, so a test against a hand-added domain passes and proves nothing.
- The signing keypair is ES256/P-256. The private key belongs in GitHub secret `BLOCKLIST_SIGNING_KEY_PEM`; the matching public key ships in the MSI as `blocklist-public-key.pem` and `appsettings.json` points `ManifestPublicKeyPath` at it. **Losing the private key means no future list can be signed for already-installed agents** — recovery requires a new MSI release.
- `data/hagezi-*-snapshot.txt` are frozen, vendored copies rescued from a CDN cache after the HaGeZi upstream was deleted in August 2026. They cannot update; each category pairs them with a maintained live source. `nordvpn.com` blocking comes from these, not from dibdot's DoH-only feed.
- Rollout order is load-bearing: ship the MSI (public key) → update devices → *then* publish lists. Publishing first hands old agents a real `listVersion` they cannot verify.

### Auth model (read `apps/worker/src/auth.ts` before touching any route)

`parentAuth` accepts, in order: session bearer token (SHA-256 hash stored in `parents.session_token`), Cloudflare Access JWT assertion, and — only when `isDevelopment(env)` and Host is localhost — an auto-provisioned dev parent. Password-based parents with no `totp_secret` get `403 totp_required`: TOTP linking is mandatory and lives under `/api/v1/auth/*`, which deliberately does **not** use this middleware. The shipped product is multi-tenant email + PIN (PBKDF2-SHA256, 80k iterations for the Workers CPU budget) + TOTP.

**Never widen `ENVIRONMENT` to `string`.** `wrangler types` generates it as the literal `"production"`, so `=== "development"` looks unsatisfiable and tempting to "fix" in the Env declaration. Doing so silently re-arms both the parent auth bypass and the CSRF same-origin skip in production. The single reviewable cast lives in `isDevelopment()` in `src/types.ts`. Secrets and optional bindings are declaration-merged in `src/env.d.ts`, which survives type regeneration.

Sessions expire (`src/session.ts`): 7-day idle inside a 30-day absolute cap, sliding on use but throttled to at most one D1 write per hour. Every login path must mint through `createSession()` — session creation was previously duplicated across five call sites, and three of them would otherwise still issue immortal tokens. Expiry is enforced in three places: `parentAuth`, the TOTP-enrollment guard in `routes/auth.ts`, and `/status`. Rows predating migration `0006` have NULL timestamps and are treated as expired.

`deviceAuth` matches an opaque 256-bit bearer against `devices.credential_hash`; D1 never stores the token itself. Enrollment codes are single-use, hashed, 12-char Crockford-style (`ABCD-EFGH-JKMN`), 24h TTL; the 6-digit legacy format is still accepted by `enrollmentSchema`.

**Every parent query must be scoped by `householdId`.** `src/isolation.integration.test.ts` spins up a real Miniflare worker via `unstable_dev` and asserts cross-tenant reads/writes fail — extend it when adding parent routes.

Rate limiting is D1-backed (`rate_limits` table, migration `0005`), not in-memory, because isolates are ephemeral.

### Policy flow

Parent edits → `incrementPolicy()` bumps `children.policy_version` → device `/sync` compares `policyVersion`/`listVersion` and gets `304` when unchanged → `buildPolicy()` assembles categories, schedules, and domain rules into the `policySchema` object the agent consumes. Age-band defaults live in `presetCategories` in contracts.

## Conventions and gotchas

- TS is strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`; C# builds with `TreatWarningsAsErrors`.
- Worker vitest runs with `fileParallelism: false` and 60s timeouts — the integration tests share one local D1.
- `wrangler.jsonc` top level **is** production. `tools/deploy.sh` rewrites `database_id` and Turnstile keys in place, so expect that file to show diffs after a deploy. Turnstile *site* key is committed; the secret goes through `wrangler secret put TURNSTILE_SECRET_KEY` only.
- `apps/windows/releases/**/*.msi` is Git LFS, but 0.1.1 (~170 MB) is deliberately **not** committed — R2 is the distribution channel and LFS has a 1 GB free allowance. Child PCs install from R2, never from a clone — see `apps/windows/releases/bootstrap/Install.ps1`, the verified one-shot path, which rolls DNS back to public resolvers if the local filter is unhealthy.
- Bump `Version` in `Package.wxs` for any MSI change that must reach existing installs. `MajorUpgrade` only fires on a version *increase*; republishing the same version leaves `msiexec` refusing to install over it (error 1638), so the package silently cannot upgrade anyone. Keep `AgentVersion` in `appsettings.json` and the `agentVersion` sent by `Enroll.exe` in step with it.
- WiX only runs on Windows. The C# projects build on Linux with `EnableWindowsTargeting`, but the distro .NET SDK may omit the WindowsDesktop targets that the WinForms `Enroll` project needs — the official SDK in `~/.dotnet` has them. MSI packaging needs the Win11 VM (see `docs/test_setup_win11.md`).
- `SafeBrowse.Enroll.exe` currently requires **two** args (API URL then code); passing only the code throws `IndexOutOfRangeException`.
- DNS hardening (`configure-protection.ps1`) points system DNS at `127.0.0.1`, disables browser DoH via policy registry keys, and firewalls outbound 53/853 except the service. A broken filter therefore looks like "no internet" — README has the recovery snippet.
- `docs/SESSION_HANDOFF.md` carries current in-flight state; `docs/production.md` has live resource IDs and smoke checks.
