# Safe Browse — Flaws, Root Causes, and Fix Precedence

**Audience:** human review before release  
**Date:** 2026-08-08  
**Scope:** Worker, dashboard, Windows agent, installer, extension  
**Related review:** full findings also summarized from project security review  

This document explains **what is wrong**, **why it matters**, and **what must change** in strict precedence order. Items marked **MUST** block any real-family pilot. Items marked **SHOULD** block production marketing. Items marked **LATER** can follow a closed pilot.

---

## How to read precedence

| Priority | Meaning | Release rule |
| :--- | :--- | :--- |
| **P0 — MUST** | Core product broken or trivial account/device takeover | Fix before any install/test that claims “protection works” |
| **P1 — MUST for pilot** | High-likelihood bypass or secret exposure | Fix before external pilot families |
| **P2 — SHOULD** | Wrong product behavior / incomplete features | Fix before public release notes |
| **P3 — LATER** | Hardening, polish, multi-tenant scale | Track; not blocking closed pilot |

---

## P0 — Must change (product-breaking)

### P0-1. Cloud policy JSON does not match Windows agent

| | |
| :--- | :--- |
| **Where** | Worker `apps/worker/src/policy.ts` + contracts `packages/contracts` vs Windows `apps/windows/src/SafeBrowse.Core/PolicyModels.cs` |
| **What is wrong** | API emits `enabledCategories`, `schedules`, `domainRules`, `generatedAt`. Agent deserializes `blockedCategories`, `schedule`, `rules`, `updatedAt`. After enroll or `/sync`, category lists, schedules, and custom domain rules bind as **null**. |
| **Why it matters** | The parent dashboard “works”, the agent “runs”, DNS “resolves”, but **category blocks and parent allow/block rules never apply**. Filtering appears successful only when local test fixtures use the agent’s private JSON names. |
| **Secondary bug** | Categories on the wire are lowercase (`"adult"`). C# enum is `Adult` with default string enum conversion (case-sensitive). Even after renaming properties, values can fail unless camelCase/case-insensitive enum parsing is enabled. |
| **Evidence** | Contracts `policySchema`; `buildPolicy()` return shape; `PolicyModels.cs` `JsonPropertyName` attributes; unit tests construct `Policy` in-memory and never deserialize Worker JSON. |
| **Fix** | 1) Align Windows `JsonPropertyName` with contracts (`enabledCategories`, `schedules`, `domainRules`, `generatedAt`). 2) Deserialize categories case-insensitively (camelCase enum converter). 3) Optionally accept legacy aliases for one release. 4) Add golden-file test: deserialize a sample Worker policy and assert `Evaluate("blocked-anime-site.test")` blocks. 5) Update remote test suite inject payload to contract names. |
| **Done when** | Enroll → restart service → `nslookup` of a category-listed domain returns NXDOMAIN without hand-written C#-only JSON. |

---

### P0-2. Parent auth ladder (email-less) — product intent clarified

| | |
| :--- | :--- |
| **Product model** | No email login. **Key A** PIN daily · **Key B** TOTP forgot-PIN · **Key C** Cloudflare `deploy.sh --reset-parent-auth` if phone lost. |
| **What was wrong originally** | Public `/setup` could run again and overwrite PIN (internet takeover). TOTP was skippable. |
| **Fix (implemented)** | Setup once → `409 already_configured`. Mandatory TOTP before console APIs. TOTP recover is primary. Operator wipe is explicit and token-gated. PBKDF2 + D1 rate limits. |
| **Docs** | [parent-auth.md](./parent-auth.md) |

---

### P0-3. Installer / uninstall incomplete for real Windows lifecycle

| | |
| :--- | :--- |
| **Where** | `apps/windows/installer/Package.wxs`, lack of install/uninstall scripts in release folder |
| **What is wrong** | MSI installs service + files + native-messaging registry, but does **not** run `configure-protection.ps1` (system DNS → 127.0.0.1, firewall, browser DoH). Uninstall removes service via `ServiceControl` but does **not** reverse DNS/firewall/DoH hardening or clean `ProgramData\SafeBrowse`. Manual copy-deploy path has no symmetric uninstall. |
| **Why it matters** | Without hardening, children keep using system/ISP DNS and bypass the proxy. Without clean uninstall, leftover DNS=127.0.0.1 breaks internet after removal. |
| **Fix** | Ship a `release/` folder with: self-contained binaries, `Install-SafeBrowse.ps1`, `Uninstall-SafeBrowse.ps1`, optional MSI, README. Install script: copy files, create service, NM registry, optional `-Harden`, start service. Uninstall: stop service, remove service, reverse harden, remove Program Files, optional data wipe, remove registry. |
| **Done when** | Install → block test domain → uninstall restores DNS/internet; cycle repeatable ≥3 times. |

---

## P1 — Must for pilot (security / secrets / bypass)

### P1-1. Turnstile secret (and production keys) in `wrangler.jsonc` vars

| | |
| :--- | :--- |
| **Where** | `apps/worker/wrangler.jsonc` `vars.TURNSTILE_SECRET_KEY` (and site key) |
| **What is wrong** | CAPTCHA **secret** is not a public var. Committed secrets allow server-side forge of siteverify success. Deploy script has historically rewritten keys into jsonc. |
| **Fix** | `wrangler secret put TURNSTILE_SECRET_KEY`; site key may stay as var. Rotate any committed production keys. Never commit real secrets. |
| **Done when** | Secret only via Workers secrets API; repo has placeholders or empty. |

---

### P1-2. Default `ENVIRONMENT=development` disables parent same-origin checks

| | |
| :--- | :--- |
| **Where** | `wrangler.jsonc` + `routes/parent.ts` middleware |
| **What is wrong** | When `ENVIRONMENT === "development"`, CSRF/same-origin rejection is skipped. One-click deploy can leave this on in “production” Worker. |
| **Fix** | Production deploy sets `ENVIRONMENT=production`. Fail closed if production lacks required secrets. Local wrangler only uses development. |

---

### P1-3. Parent password hashing is not a password hash

| | |
| :--- | :--- |
| **Where** | `auth.ts` + `crypto.ts`: `sha256("sb_salt_" + password)`, min length 4 |
| **What is wrong** | Fixed global prefix is not a salt. SHA-256 is fast → offline cracking of PINs is trivial. Login matches **hash only** (no email). |
| **Fix** | Argon2id or scrypt with per-user salt; store `algorithm|salt|hash`. Raise minimum strength (or require TOTP for short PIN). Login by email/identifier + password. |

---

### P1-4. No durable rate limit / lockout on auth or enroll

| | |
| :--- | :--- |
| **Where** | `auth.ts` in-memory `Map`; public `device.ts` `/enroll` |
| **What is wrong** | Worker isolates do not share memory; map never locks out. Recovery/TOTP recover unlimited. Enrollment is 6 digits (~20 bits) with no rate limit. |
| **Fix** | Cloudflare Rate Limiting or D1/KV counters with lockout windows. Stronger enroll codes (8–10 alphanumeric). Check `UPDATE ... consumed_at` rows-changed to prevent double consume. |

---

### P1-5. `ProgramData\SafeBrowse` not ACL-locked; LocalMachine DPAPI

| | |
| :--- | :--- |
| **Where** | `CredentialStore.cs`, Enroll, install scripts |
| **What is wrong** | Device bearer token protected with `DataProtectionScope.LocalMachine`. Any process that can read the file can unprotect on that machine. Default ACLs often allow Authenticated Users read. Child can steal token or rewrite `policy.json` / lists if writable. |
| **Fix** | On install, ACL directory to SYSTEM + Administrators only. Document that non-admin child must not have write access. Prefer service-only access. |

---

### P1-6. Firefox DoH not disabled by hardening script

| | |
| :--- | :--- |
| **Where** | `configure-protection.ps1` (Chrome/Edge only) |
| **What is wrong** | Architecture claims Firefox DoH off; script does not set Firefox enterprise policy. Child can bypass local DNS over HTTPS:443. |
| **Fix** | Deploy Firefox `policies.json` / registry policies for `DNSOverHTTPS` / `network.trr.mode`. Document residual VPN/Tor/hotspot limits honestly. |

---

## P2 — Should change (correctness / product honesty)

### P2-1. `safeSearch` and `youtubeRestricted` never enforced

Stored and shown in dashboard; DNS proxy never rewrites to SafeSearch / Restricted YouTube endpoints.  
**Fix:** implement DNS redirects **or** hide toggles until implemented.

### P2-2. Schedule semantics mismatch + no dashboard UI

Evaluator treats schedules as **allow windows** (skip block inside window). Docs describe **block windows** (e.g. block gaming 21:00–07:00). Overnight ranges forbidden by schema (`end > start`). No schedule UI in dashboard.  
**Fix:** pick one semantic, support wrap-around, wire UI, tests.

### P2-3. “Rest of day” approval uses UTC end-of-day

`endOfDayMs` uses `setUTCHours` — wrong for most families.  
**Fix:** child’s IANA timezone.

### P2-4. Heartbeat always reports `healthy`

Emergency bypass and DNS/firewall tamper never surface to parent.  
**Fix:** report `emergency_bypass` while active; optional integrity checks → `tampered`.

### P2-5. Parent sessions never expire

Single hashed token column, `localStorage`, no TTL.  
**Fix:** expiry + idle timeout; optional Secure cookie if same-site deploy.

### P2-6. Event queue is in-memory only

Reboot loses unsent events; agent generates new Idempotency-Key every upload.  
**Fix:** durable queue + stable batch key.

### P2-7. Dual email send paths may be inconsistent

`email.ts` vs `alerts.ts` different binding shapes — verify both against Cloudflare Email Service.

### P2-8. TOTP recovery is single-tenant `LIMIT 1`

Works for one-family deploy only. Secret stored plaintext in D1.  
**Fix:** document single-household; or require account id + encrypt secret at rest.

---

## P3 — Later (hardening / scale)

| ID | Item |
| :--- | :--- |
| P3-1 | Security headers / CSP on Worker + assets |
| P3-2 | `Content-Length`-only body size check → stream limit |
| P3-3 | Embed blocklist public key in signed binary |
| P3-4 | Multi-session parent table; revoke all sessions on recovery |
| P3-5 | VPN / new-adapter detection and parent alert |
| P3-6 | Mobile (iOS/Android) radius |
| P3-7 | Slight bias in `sixDigitCode` modulo |

---

## What is already solid (do not regress)

1. **Privacy boundary** — hostname-only telemetry; no paths/query/page content in MVP events.  
2. **Device tokens** — 256-bit random, SHA-256 hashed in D1.  
3. **Enrollment codes** — hashed, short TTL, re-enroll revokes prior device (once consume is race-safe).  
4. **Parameterized SQL + Zod** — no classic SQLi found on reviewed routes.  
5. **Blocklist supply chain** — ES256 manifest + per-file SHA-256 on agent.  
6. **DNS proxy** — DoH + UDP fallback, timeouts, fail-closed on bad packets.  
7. **Emergency bypass** — requires Windows Administrator via pipe impersonation.  
8. **Offline enforcement** — local policy continues when cloud is down (once policy shape is correct).  
9. **Extension non-authority** — removing extension does not remove DNS enforcement.  
10. **Retention cron** — events/audit/requests cleaned on schedule.

---

## Recommended fix sequence (engineering)

```
P0-1 Policy JSON + enum casing + golden test
P0-2 Lock /auth/setup
P0-3 Release install/uninstall scripts + harden/unharden
  ↓ smoke on Win11 VM: install → block → uninstall ×3
P1-1 Secrets out of repo + rotate
P1-2 ENVIRONMENT=production on deploy
P1-5 ProgramData ACL
P1-6 Firefox DoH
P1-3 / P1-4 Password KDF + rate limits (can parallelize)
P2-* product honesty and sessions
```

---

## Acceptance criteria for “Windows release folder ready”

| # | Criterion |
| :---: | :--- |
| 1 | `release/` contains Win10/11 x64 setup (scripts and/or MSI), uninstall, README |
| 2 | Fresh install creates service **Running**, DNS on 127.0.0.1:53 |
| 3 | Injected or enrolled policy with **adult** (or test) category blocks listed domains (NXDOMAIN) |
| 4 | Allow-listed / unlisted domains still resolve |
| 5 | Uninstall stops service, removes install dir components, restores DNS if hardened |
| 6 | Install → test → uninstall cycle succeeds **3 times** without manual cleanup |
| 7 | Documented residual bypasses (VPN, Tor, phone hotspot) |

---

## Threat model honesty (keep in release notes)

Safe Browse MVP is designed for **non-admin child accounts** on Windows 10/11. It is **not** a full SWG:

- VPN apps, Tor, mobile hotspots, and hard-coded IPs bypass DNS filtering.  
- DoH over 443 from unhardened clients bypasses port-53 controls.  
- Local admin can stop the service or undo firewall rules.  
- Cloud outage does not stop local enforcement, but list/policy updates pause.

Parents should be told this clearly; overclaiming “uncircumventable” is itself a product flaw.

---

## Changelog for this document

| Date | Note |
| :--- | :--- |
| 2026-08-08 | Initial precedence doc from full project review + Windows release plan |
