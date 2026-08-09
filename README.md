# Safe Browse

Transparent parental controls for **Windows 10 / Windows 11**. Filtering runs locally on the PC (DNS + policy engine), keeps working when the cloud is offline, and is managed from a parent dashboard on Cloudflare.

**Privacy boundary (MVP):** only top-level browser hostnames and blocked DNS attempts are recorded. No page paths, query strings, titles, or page content.

---

## Download Windows installer

| | |
| :--- | :--- |
| **Latest MSI (Win10/11 x64)** | [**Download SafeBrowseSetup.msi**](https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/SafeBrowseSetup.msi) |
| **Versioned MSI (0.1.0)** | [SafeBrowseSetup.msi (0.1.0)](https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/0.1.0/SafeBrowseSetup.msi) |
| **Release manifest (JSON)** | [latest.json](https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest.json) |
| **Size** | ~144 MB (self-contained; .NET runtime included) |
| **SHA-256 (0.1.0)** | `93fb439ea9daa620637bdfea643f143ad7c0708bd70c02afaebd518638388abb` |

Installers are hosted on **Cloudflare R2** (public `r2.dev` URL). After download, verify the hash if you want:

```powershell
# PowerShell
Get-FileHash .\SafeBrowseSetup.msi -Algorithm SHA256
```

### Install on a kid’s PC (elevated PowerShell)

```powershell
# 1) Download MSI
Invoke-WebRequest -Uri "https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/SafeBrowseSetup.msi" `
  -OutFile "$env:USERPROFILE\Downloads\SafeBrowseSetup.msi"

# 2) Quiet install
msiexec /i "$env:USERPROFILE\Downloads\SafeBrowseSetup.msi" /qn

# 3) Harden system DNS (point at local filter, disable browser DoH)
#    Download the hardening script from the same release:
Invoke-WebRequest -Uri "https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/0.1.0/configure-protection.ps1" `
  -OutFile "$env:TEMP\configure-protection.ps1"
Set-ExecutionPolicy -Scope Process Bypass
& "$env:TEMP\configure-protection.ps1" -Action Install
```

Or use the scripted installer (when you have the full release folder with `bin\`):

```powershell
.\Install-SafeBrowse.ps1 -Harden
```

**Full walkthrough** (OpenSSH + install + enroll):  
[docs/windows_remote_access_setup.md](docs/windows_remote_access_setup.md)

### Helper scripts (same R2 release)

| Script | Link |
| :--- | :--- |
| Install-SafeBrowse.ps1 | [download](https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/0.1.0/Install-SafeBrowse.ps1) |
| Uninstall-SafeBrowse.ps1 | [download](https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/0.1.0/Uninstall-SafeBrowse.ps1) |
| configure-protection.ps1 | [download](https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/0.1.0/configure-protection.ps1) |

---

## What is in the box

| Component | Path | Role |
| :--- | :--- | :--- |
| **Worker API + dashboard** | `apps/worker`, `apps/dashboard` | Parent console, device sync, D1 history, R2 blocklists |
| **Windows agent** | `apps/windows` | Service (DNS proxy), native messaging host, enroll, tray, WiX MSI |
| **Browser extension** | `apps/extension` | Top-level hostname telemetry (optional; DNS still enforces) |
| **Contracts** | `packages/contracts` | Shared TypeScript policy/API schemas |
| **Blocklist tools** | `tools/blocklists` | Deterministic feed compile + signed manifests |

---

## Live SaaS (Incorpify-hosted)

| | |
| :--- | :--- |
| **Parent app** | **https://safebrowse.incorpify.in** |
| **Also** | https://safe-browse-api.saneax.workers.dev |
| **Mode** | Multi-tenant: **Sign up** / **Log in** with email + PIN + authenticator |

Device API base for agents:

```text
https://safebrowse.incorpify.in/api/v1/device/
```

### Self-host (advanced)

```bash
git clone https://github.com/Incorpify-LLC/safe_browse.git
cd safe_browse
# Create a token: docs/cloudflare-api-token.md
bash tools/deploy.sh
```

Details: [docs/deployment.md](docs/deployment.md) · Parent auth: [docs/parent-auth.md](docs/parent-auth.md) · SaaS plan: [docs/saas-multitenant-plan.md](docs/saas-multitenant-plan.md)

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

`Cf-Access-Authenticated-User-Email` is accepted only when `ENVIRONMENT=development`. Production expects a verified Cloudflare Access JWT (`ACCESS_TEAM_DOMAIN` / `ACCESS_AUD`).

---

## Publish a new Windows MSI to R2

On a machine with the built release folder and Wrangler auth:

```bash
# Default: apps/windows/releases/0.1.0
bash tools/upload-windows-release.sh --version 0.1.0

# Custom path
bash tools/upload-windows-release.sh --version 0.2.0 --dir path/to/SafeBrowse-0.2.0-win-x64
```

This uploads:

- `releases/<version>/SafeBrowseSetup.msi`
- `releases/latest/SafeBrowseSetup.msi`
- helper scripts + `releases/latest.json` manifest (version, size, SHA-256, URLs)

Then update the download links in this README if the public base URL changes  
(`apps/windows/releases/R2_PUBLIC_BASE_URL.txt`).

Bucket: **`safe-browse-releases`** (public via `r2.dev`).

---

## Docs

| Doc | Description |
| :--- | :--- |
| [docs/windows_remote_access_setup.md](docs/windows_remote_access_setup.md) | Kid PC: SSH + install + enroll (copy-paste) |
| [docs/deployment.md](docs/deployment.md) | Cloudflare deploy, R2 free tier notes |
| [docs/architecture.md](docs/architecture.md) | Trust boundaries & data flow |
| [docs/parent-auth.md](docs/parent-auth.md) | PIN + TOTP recovery ladder |
| [docs/test_setup_win11.md](docs/test_setup_win11.md) | Lab Win11 VM + remote test suite |
| [apps/windows/releases/0.1.0/README.md](apps/windows/releases/0.1.0/README.md) | In-folder MSI notes |

---

## License

Application code: **Apache-2.0**. HaGeZi-derived blocklist data remains separately identified **GPL-3.0** where applicable — see blocklist tooling and manifests.
