# Session handoff — Safe Browse

**Last updated:** 2026-08-11
**Branch:** `main` (pushed to `origin/main`)
**Remote:** `https://github.com/Incorpify-LLC/safe_browse.git`
**Local origin protocol:** HTTPS (SSH push failed in agent environment; HTTPS works via `gh`)

---

## Headline

**Category filtering now works in production.** It never had before. The cause was
not configuration: the HaGeZi upstream feeds were deleted, the nightly compile had
been failing every run, so `lists/latest.json` never existed, so the Worker
reported `listVersion: "bootstrap"`, so the agent skipped list sync entirely and
every category set was empty. The service still reported `healthy` throughout.

Verified on `win11-vm` against the loopback proxy:

| Domain | Result | Why |
| :--- | :--- | :--- |
| `pornhub.com`, `xvideos.com` | BLOCKED | adult, enabled |
| `bet365.com` | BLOCKED | gambling, enabled |
| `nordvpn.com` | BLOCKED | bypass, enabled |
| `crunchyroll.com` | RESOLVED | anime, **not** enabled |
| `example.com` | RESOLVED | uncategorised |

---

## Live production state

| Thing | State |
| :--- | :--- |
| Worker | deployed, migration `0006` applied |
| Session expiry | live — 7-day idle inside 30-day absolute cap |
| Turnstile | fails **closed** in production; secret confirmed set |
| Parent email | Cloudflare Email Sending binding live, `noreply@incorpify.in` |
| MSI | **0.1.1** on R2, sha256 `2255cd01ef445ea929820e5bc2943a1facefec5a8870b43c0d1ec6b8488f495f` |
| Blocklists | published, version `20260811T050212Z`, 10 artifacts, ~3.8 MB gzipped |
| Enrolled devices | 1 (`WIN11-KVM`), upgraded to 0.1.1, offline only because the VM is shut down |
| CI | green on `main` |

---

## Shipped this session

| Area | Change |
| :--- | :--- |
| Build | 25 worker type errors → 0; `check` reordered to build-before-test so a clean checkout works |
| Sessions | expiry added; all five session-minting call sites routed through `createSession()` |
| Turnstile | fails closed in prod, open only in development |
| Email | `send_email` binding added; `alerts.ts` moved off the legacy Email Routing API, which cannot reach unverified recipients |
| Installer | GUI enrollment dialog, MSI wizard, finish-page launch, Start Menu shortcut, elevation manifest |
| Blocklists | sources rebuilt on maintained feeds + rescued HaGeZi snapshots; list faults no longer kill the agent's sync loop |
| Release | 0.1.1 published; in-place upgrade proven from 0.1.0 |

---

## Risks and open items

### 1. Blocklist signing key — highest risk

The ES256 private key was generated this session and **must** live in GitHub secret
`BLOCKLIST_SIGNING_KEY_PEM`. Its public half is baked into the 0.1.1 MSI now
installed on devices. If the private key is lost, **no future blocklist can be
signed for those agents** and recovery requires cutting and distributing a new MSI.
Until the secret is set, the nightly `blocklists.yml` workflow keeps failing.

### 2. Unverified by machine

The MSI wizard's appearance, the finish-page checkbox actually launching the dialog,
and the UAC prompt were never seen — SSH has no interactive desktop
(`MainWindowHandle` was 0). Everything structural beneath them is verified. Needs a
human at the VM console once.

### 3. Coverage regressions vs the old feeds

`bypass` and `social` depend partly on frozen snapshots that can never update.
`threats` deliberately uses phishing + ransomware + scam rather than Block List
Project's full malware list, which is 2.65M domains and would cost roughly 170 MB
of RAM in the agent's `HashSet<string>`.

### 4. Smaller

- `apps/dashboard/src/App.tsx` still uncommitted; not reviewed this session.
- Dashboard shows `bypass`/`social` toggles without indicating they are thinner than the other categories.
- MSI is 170 MB (self-contained WinForms). Trimming or framework-dependent publish would cut it.
- `docs/release-test-report.md` is a historical record and still cites the old IP and 0.1.0 — left as-is deliberately.

---

## Lab environment

| Item | Value |
| :--- | :--- |
| Win11 VM | `win11-vm` (virsh), **currently shut off** |
| IP | **DHCP — do not hardcode.** Was `.160`, was `.173` on 2026-08-11. See `docs/test_setup_win11.md` for MAC-based lookup. |
| SSH | creds via `.env.keep` → `SAFE_BROWSE_SSH_*` |
| Shutdown | `virsh shutdown` may be ignored; use `ssh <user>@<ip> 'shutdown /s /t 5'` |
| Build | `.NET 8.0.423` + `9.0.316` on the VM; WiX is Windows-only, so MSI packaging must happen there |

---

## Do not regress

- Hostname-only telemetry privacy boundary
- Device tokens hashed in D1; parent sessions expire
- Setup must stay **one-shot** (public re-setup = takeover)
- TOTP must remain **required** for password-based console
- Policy wire format must stay aligned with `@safe-browse/contracts`
- `ENVIRONMENT` must never be widened to `string` — see `isDevelopment()` in `apps/worker/src/types.ts`
- Blocklist rollout order: ship MSI (public key) → update devices → publish lists
- A blocklist fault must never terminate the agent's sync loop
