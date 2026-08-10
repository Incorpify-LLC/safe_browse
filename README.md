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

## Install on a child’s Windows PC (verified)

**Child machines do not need Git, a repo clone, or Node.**

These steps were run end-to-end on the lab VM (`win11-vm`, Windows 11) against production.

### Parent first

1. Open **https://safebrowse.incorpify.in** → Sign up / Log in  
2. **Add a child** → set categories  
3. **Generate setup code** (format `ABCD-EFGH-JKMN`)  
4. Codes are **single-use** and valid for **24 hours** (you can generate a new one any time)

### Child PC — recommended (elevated PowerShell, one script)

On the child PC: **Start → PowerShell → Run as administrator**, then paste **exactly** (two lines):

```powershell
$env:SAFE_BROWSE_ENROLL = 'PASTE-YOUR-CODE-HERE'
irm https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/Install.ps1 | iex
```

That script (in order):

1. Downloads **SafeBrowseSetup.msi** (~143 MB) from Cloudflare R2  
2. Quiet-installs it (`msiexec /qn` — **no installer wizard UI**)  
3. Writes production **ApiBaseUrl** into `appsettings.json`  
4. Starts **Safe Browse Protection**  
5. **Enrolls** with your code (needs working internet)  
6. Hardens DNS last; if the local filter does not answer, it **restores public DNS** so the PC is not left offline  

**Do not** use the old nested form `iex "& { $(irm $u) } -EnrollCode ..."` — it is easy to paste wrong and fails when `$u` is empty.

### More reliable PowerShell (if `| iex` is blocked)

```powershell
irm https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/Install.ps1 -OutFile $env:TEMP\sb-install.ps1
powershell -ExecutionPolicy Bypass -File $env:TEMP\sb-install.ps1 -EnrollCode 'PASTE-YOUR-CODE-HERE'
```

### MSI double-click (no PowerShell for install)

| | |
| :--- | :--- |
| **Latest MSI** | [Download SafeBrowseSetup.msi](https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/SafeBrowseSetup.msi) |
| **SHA-256 (0.1.0)** | `93fb439ea9daa620637bdfea643f143ad7c0708bd70c02afaebd518638388abb` |

- Double-click the MSI. Current package has **no custom wizard** (SmartScreen may warn; choose Run anyway / More info).  
- Then **enroll in elevated PowerShell** (current `Enroll.exe` needs **two** arguments — API URL and code):

```powershell
& "C:\Program Files\Safe Browse\SafeBrowse.Enroll.exe" "https://safebrowse.incorpify.in/api/v1/device" "PASTE-YOUR-CODE-HERE"
Restart-Service "Safe Browse Protection" -Force
```

Passing only the code crashes the current MSI binary (`IndexOutOfRangeException`). Always pass the API URL first.

Optional harden after enroll (can break internet if the local filter fails — prefer the full `Install.ps1` which rolls back):

```powershell
irm https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/configure-protection.ps1 -OutFile $env:TEMP\sb-harden.ps1
powershell -ExecutionPolicy Bypass -File $env:TEMP\sb-harden.ps1 -Action Install
Restart-Service "Safe Browse Protection" -Force
```

### Quick check on the child PC

```powershell
Get-Service "Safe Browse Protection"
Test-Path "C:\ProgramData\SafeBrowse\device.credential"
Test-Path "C:\ProgramData\SafeBrowse\policy.json"
nslookup example.com 127.0.0.1
```

Expected: service **Running**, both files **True**. `nslookup` via `127.0.0.1` works only if DNS was hardened **and** the filter is healthy.

### If the child PC has “no internet” after install

Hardening points DNS at `127.0.0.1` and blocks direct DNS. If the filter is not resolving, the PC looks offline. **Elevated PowerShell:**

```powershell
foreach ($n in @(
  'Safe Browse - Allow Service DNS UDP','Safe Browse - Allow Service DNS TCP',
  'Safe Browse - Block direct DNS UDP','Safe Browse - Block direct DNS TCP'
)) { Remove-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue }

Get-NetAdapter | Where-Object Status -eq 'Up' | ForEach-Object {
  Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ServerAddresses 1.1.1.1,8.8.8.8
}
Clear-DnsClientCache
```

SSH/RDP by **IP** still works when DNS is broken.

### Helper files on R2

| File | Role |
| :--- | :--- |
| [Install.ps1](https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/Install.ps1) | Preferred full install (API + enroll + safe harden) |
| [SafeBrowseSetup.msi](https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/SafeBrowseSetup.msi) | Package only |
| [configure-protection.ps1](https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/configure-protection.ps1) | Harden / unharden |

> **Developers only:** cloning this repo is for building cloud/agent code — not for installing on a child’s PC.

---

## What is in the box

| Component | Path | Role |
| :--- | :--- | :--- |
| **Worker API + dashboard** | `apps/worker`, `apps/dashboard` | Parent console, device sync, D1 history, R2 blocklists |
| **Windows agent** | `apps/windows` | Service (DNS proxy), native host, enroll, tray, WiX MSI |
| **One-shot bootstrap** | `apps/windows/releases/bootstrap/Install.ps1` | Verified child install from R2 |
| **Browser extension** | `apps/extension` | Top-level hostname telemetry (optional) |
| **Contracts** | `packages/contracts` | Shared TypeScript policy/API schemas |
| **Blocklist tools** | `tools/blocklists` | Deterministic feed compile + signed manifests |

---

## Self-host (advanced)

```bash
git clone https://github.com/Incorpify-LLC/safe_browse.git
cd safe_browse
bash tools/deploy.sh
```

Point child installs at your Worker:

```powershell
$env:SAFE_BROWSE_API = 'https://YOUR-WORKER.workers.dev/api/v1/device/'
$env:SAFE_BROWSE_ENROLL = 'CODE'
irm https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/Install.ps1 | iex
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

```bash
npx wrangler d1 migrations apply safe-browse --local --config apps/worker/wrangler.jsonc
```

---

## Publish a new Windows MSI to R2

```bash
bash tools/upload-windows-release.sh --version 0.1.0
npx wrangler r2 object put safe-browse-releases/releases/latest/Install.ps1 \
  --file=apps/windows/releases/bootstrap/Install.ps1 \
  --content-type="text/plain; charset=utf-8" --remote
```

Bucket: **`safe-browse-releases`**. Public base: `apps/windows/releases/R2_PUBLIC_BASE_URL.txt`.

---

## Docs

| Doc | Description |
| :--- | :--- |
| [docs/child_install_one_liner.md](docs/child_install_one_liner.md) | Child install (verified) |
| [docs/windows_remote_access_setup.md](docs/windows_remote_access_setup.md) | SSH + install walkthrough |
| [docs/production.md](docs/production.md) | Live SaaS URLs & redeploy |
| [docs/architecture.md](docs/architecture.md) | Trust boundaries & data flow |
| [docs/test_setup_win11.md](docs/test_setup_win11.md) | Lab Win11 VM |

---

## License

Application code: **Apache-2.0**. Blocklist data is separately identified per source in each artifact manifest — Block List Project (**Unlicense**), StevenBlack/hosts (**MIT**), dibdot DoH-IP-blocklists (**GPL-3.0**). See [NOTICE](NOTICE).
