# Safe Browse

Transparent parental controls for **Windows 10 / Windows 11**. Filtering runs locally on the PC (DNS + policy engine), keeps working when the cloud is offline, and is managed from a parent dashboard on Cloudflare.

**Privacy boundary (MVP):** only top-level browser hostnames and blocked DNS attempts are recorded. No page paths, query strings, titles, or page content.

---

## Live SaaS (Incorpify-hosted)

| | |
| :--- | :--- |
| **Parent app** | **https://safebrowse.incorpify.in** |
| **Also** | https://safe-browse-api.saneax.workers.dev |
| **Mode** | Multi-tenant: **Sign up** / **Log in** with email + PIN + authenticator |
| **Device API** | `https://safebrowse.incorpify.in/api/v1/device/` |

---

## Install on a child’s Windows PC (no Git)

**Child machines do not need Git, a repo clone, or Node.**  
Installation is a single elevated PowerShell command that downloads the MSI, installs it, writes the production API URL, hardens DNS, and can enroll in one shot.

### Recommended: one-shot installer

**PowerShell → Run as administrator**

```powershell
# Install + configure production API + harden DNS
irm https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/Install.ps1 | iex
```

**With enrollment code** from the parent console (e.g. `AB3K-M9NP-Q2VX`):

```powershell
$u = 'https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/Install.ps1'
iex "& { $(irm $u) } -EnrollCode 'AB3K-M9NP-Q2VX'"
```

What that does:

1. Downloads **SafeBrowseSetup.msi** from Cloudflare R2  
2. Quiet-installs the agent service  
3. Sets **ApiBaseUrl** → `https://safebrowse.incorpify.in/api/v1/device/`  
4. Hardens network (system DNS → `127.0.0.1`, block direct DNS, disable browser DoH)  
5. Optionally enrolls with the parent code and restarts the service  

**No Git. No clone. No multi-step script hunting.**

Full notes: [docs/child_install_one_liner.md](docs/child_install_one_liner.md)

### Parent side (before the child install)

1. Open **https://safebrowse.incorpify.in** → Sign up / Log in  
2. Add a child → set categories → **Generate setup code**  
3. On the child PC, run the one-liner with that code  

### Quick check on the child PC

```powershell
Get-Service "Safe Browse Protection"
nslookup example.com 127.0.0.1
```

### Alternative: MSI only

| | |
| :--- | :--- |
| **Latest MSI** | [Download SafeBrowseSetup.msi](https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/SafeBrowseSetup.msi) |
| **Versioned (0.1.0)** | [SafeBrowseSetup.msi (0.1.0)](https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/0.1.0/SafeBrowseSetup.msi) |
| **Manifest** | [latest.json](https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest.json) |
| **SHA-256 (0.1.0)** | `93fb439ea9daa620637bdfea643f143ad7c0708bd70c02afaebd518638388abb` |

Double-click the MSI for a basic install, then still run the **Install.ps1** one-liner so API URL + DNS hardening are applied (until the next packaged MSI ships with production defaults fully baked in).

```powershell
# Optional integrity check
Get-FileHash .\SafeBrowseSetup.msi -Algorithm SHA256
```

### After install — enroll only (if you skipped `-EnrollCode`)

```powershell
& "C:\Program Files\Safe Browse\SafeBrowse.Enroll.exe" "YOUR-CODE"
Restart-Service "Safe Browse Protection" -Force
```

(`SafeBrowse.Enroll.exe` defaults to the production API when only a code is passed.)

### Helper / bootstrap scripts on R2

| Script | Role | Link |
| :--- | :--- | :--- |
| **Install.ps1** | **One-shot child install (preferred)** | [latest/Install.ps1](https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/Install.ps1) |
| configure-protection.ps1 | DNS harden / unharden only | [latest/configure-protection.ps1](https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/configure-protection.ps1) |
| Uninstall-SafeBrowse.ps1 | Clean uninstall (release folder) | [0.1.0](https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/0.1.0/Uninstall-SafeBrowse.ps1) |

> **Developers only:** cloning this repo is for building the cloud or the Windows agent—not for installing on a child’s PC.

---

## What is in the box

| Component | Path | Role |
| :--- | :--- | :--- |
| **Worker API + dashboard** | `apps/worker`, `apps/dashboard` | Parent console, device sync, D1 history, R2 blocklists |
| **Windows agent** | `apps/windows` | Service (DNS proxy), native messaging host, enroll, tray, WiX MSI |
| **One-shot bootstrap** | `apps/windows/releases/bootstrap/Install.ps1` | Child PC install from R2 (no Git) |
| **Browser extension** | `apps/extension` | Top-level hostname telemetry (optional; DNS still enforces) |
| **Contracts** | `packages/contracts` | Shared TypeScript policy/API schemas |
| **Blocklist tools** | `tools/blocklists` | Deterministic feed compile + signed manifests |

---

## Self-host (advanced — parents who want their own Cloudflare)

```bash
git clone https://github.com/Incorpify-LLC/safe_browse.git
cd safe_browse
# Create a token: docs/cloudflare-api-token.md
bash tools/deploy.sh
```

Then point child installs at your Worker:

```powershell
$u = 'https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/Install.ps1'
iex "& { $(irm $u) } -ApiBaseUrl 'https://YOUR-WORKER.workers.dev/api/v1/device/' -EnrollCode 'CODE'"
```

Details: [docs/deployment.md](docs/deployment.md) · [docs/parent-auth.md](docs/parent-auth.md) · [docs/saas-multitenant-plan.md](docs/saas-multitenant-plan.md)

---

## Local development

```bash
npm install
npm run check
npm run dev --workspace @safe-browse/worker
npm run dev --workspace @safe-browse/dashboard
```

Apply local D1 migrations:

```bash
npx wrangler d1 migrations apply safe-browse --local --config apps/worker/wrangler.jsonc
```

`Cf-Access-Authenticated-User-Email` is accepted only when `ENVIRONMENT=development`. Production expects a verified Cloudflare Access JWT only if you enable Access (`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`).

---

## Publish a new Windows MSI to R2

On a machine with the built release folder and Wrangler auth:

```bash
# Default: apps/windows/releases/0.1.0
bash tools/upload-windows-release.sh --version 0.1.0

# Also upload the one-shot bootstrap
npx wrangler r2 object put safe-browse-releases/releases/latest/Install.ps1 \
  --file=apps/windows/releases/bootstrap/Install.ps1 \
  --content-type="text/plain; charset=utf-8" --remote
```

Bucket: **`safe-browse-releases`** (public via `r2.dev`).  
Public base: see `apps/windows/releases/R2_PUBLIC_BASE_URL.txt`.

---

## Docs

| Doc | Description |
| :--- | :--- |
| [docs/child_install_one_liner.md](docs/child_install_one_liner.md) | **Child PC one-shot install (no Git)** |
| [docs/windows_remote_access_setup.md](docs/windows_remote_access_setup.md) | SSH + install + enroll walkthrough |
| [docs/production.md](docs/production.md) | Live SaaS URLs & redeploy |
| [docs/deployment.md](docs/deployment.md) | Cloudflare deploy, R2 free tier |
| [docs/architecture.md](docs/architecture.md) | Trust boundaries & data flow |
| [docs/parent-auth.md](docs/parent-auth.md) | PIN + TOTP recovery ladder |
| [docs/saas-multitenant-plan.md](docs/saas-multitenant-plan.md) | Multi-tenant SaaS plan |
| [docs/test_setup_win11.md](docs/test_setup_win11.md) | Lab Win11 VM + remote test suite |

---

## License

Application code: **Apache-2.0**. HaGeZi-derived blocklist data remains separately identified **GPL-3.0** where applicable — see blocklist tooling and manifests.
