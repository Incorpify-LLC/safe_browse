# Kid’s Windows PC setup: remote access + Safe Browse install

Use this page **on each child’s Windows 10/11 (x64) PC**. It has two parts:

| Part | Purpose |
| :--- | :--- |
| **A — Remote access** | Open SSH (and optional RDP) so the parent machine can maintain the PC over the home LAN |
| **B — Install Safe Browse** | Install the protection agent, harden DNS, enroll the device with the parent dashboard |

**Who runs this:** a parent / **Administrator** account (local admin or Microsoft account that is an admin).

**Time:** about 10–15 minutes per PC.

**Home LAN:** `192.168.2.0/24` (PC should get an address like `192.168.2.x`).

---

# Part A — Enable remote access

## A1. Open PowerShell as Administrator

1. Press **Start**, type **PowerShell**.
2. Right-click **Windows PowerShell** (or **Terminal**) → **Run as administrator**.
3. If User Account Control asks, choose **Yes**.

Copy and paste the blocks below **one section at a time**, press **Enter**, and wait for each to finish.

---

## A2. Install and start OpenSSH Server (required for remote maintenance)

This opens **port 22** so the parent/admin machine can connect with SSH.

```powershell
# Install OpenSSH Server (Windows optional feature)
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0

# Start now and on every boot
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic

# Allow SSH through Windows Firewall
New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' `
  -DisplayName 'OpenSSH Server (sshd)' `
  -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 `
  -ErrorAction SilentlyContinue

# Confirm service is running
Get-Service sshd
```

**Expected:** `Status` is **Running**.

---

## A3. Optional: enable Remote Desktop (RDP)

Only if you also want a full desktop from another PC (port **3389**).

```powershell
# Allow remote desktop connections
Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' `
  -Name 'fDenyTSConnections' -Value 0

# Firewall rule for RDP
Enable-NetFirewallRule -DisplayGroup 'Remote Desktop'

# Confirm
Get-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' `
  -Name 'fDenyTSConnections'
```

**Expected:** `fDenyTSConnections` is **0**.

---

## A4. Confirm this PC is on the home LAN

```powershell
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -like '192.168.2.*' } |
  Select-Object InterfaceAlias, IPAddress, PrefixLength

hostname
whoami
```

**Expected:** at least one address in **`192.168.2.x`**.

If you only see another range (for example `192.168.29.x`), connect Wi‑Fi/Ethernet to the **same network** the admin machine uses, then run the commands again.

Write down **hostname** and **IPv4** for the parent machine.

---

## A5. Quick self-test (remote access)

```powershell
# SSH listening?
netstat -ano | findstr ':22 '

# Optional: RDP listening?
netstat -ano | findstr ':3389 '
```

You should see `LISTENING` for port **22** (and **3389** if you enabled RDP).

---

# Part B — Install Safe Browse on this PC

Safe Browse installs as a Windows service named **Safe Browse Protection**. It filters DNS locally (even offline after policies are cached).

You need the **installer** on this PC first. Prefer the **Cloudflare R2 download** (no Git required).

### Fast path: download MSI from R2

```powershell
# Elevated PowerShell optional for download; required for install
$uri = "https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/SafeBrowseSetup.msi"
$msi = "$env:USERPROFILE\Downloads\SafeBrowseSetup.msi"
Invoke-WebRequest -Uri $uri -OutFile $msi
# Optional integrity check:
# Get-FileHash $msi -Algorithm SHA256
# Expected 0.1.0: 93fb439ea9daa620637bdfea643f143ad7c0708bd70c02afaebd518638388abb
```

Manifest (version, SHA-256, script URLs):  
https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest.json

### What a full release folder looks like

```
SafeBrowse-0.1.0-win-x64\          (or apps\windows\releases\0.1.0\)
  SafeBrowseSetup.msi              ≈ 144 MB
  Install-SafeBrowse.ps1
  Uninstall-SafeBrowse.ps1
  configure-protection.ps1
  README.md
  bin\                             (present in full release package)
```

| How to get the package | Notes |
| :--- | :--- |
| **R2 (recommended)** | [Latest MSI](https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/SafeBrowseSetup.msi) · [latest.json](https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest.json) |
| **GitHub (with LFS)** | `git lfs install` then `git lfs pull` — MSI is large |
| **Repo path** | `apps/windows/releases/0.1.0/` |
| **USB / network share** | Copy the whole release folder to the kid’s PC |

---

## B1. Recommended: script install + DNS hardening

This is the best path for a kid’s PC: installs files, service, native-messaging registry, starts protection, and points system DNS at the local filter.

1. Copy the release folder onto the PC (example: `C:\Users\Public\SafeBrowse-0.1.0-win-x64`).
2. Open **PowerShell as Administrator**.
3. Run:

```powershell
# Go to the folder that contains Install-SafeBrowse.ps1
cd C:\Users\Public\SafeBrowse-0.1.0-win-x64

# Allow this session to run the install script
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

# Install + harden (DNS → 127.0.0.1, block direct DNS, disable browser DoH)
.\Install-SafeBrowse.ps1 -Harden
```

If the layout is only the smaller `apps\windows\releases\0.1.0` folder (MSI + scripts, no `bin\`), either:

- use the **MSI method (B2)** below, then run hardening, **or**
- point the script at published binaries:

```powershell
.\Install-SafeBrowse.ps1 -SourceDir "C:\path\to\bin" -Harden
```

### Optional: point the agent at your family’s cloud API

If the parent dashboard / Worker is already deployed, set the device API URL at install time:

```powershell
.\Install-SafeBrowse.ps1 -Harden -ApiBaseUrl "https://YOUR-WORKER.workers.dev/api/v1/device/"
```

(Replace with your real device API base URL from the parent deploy output.)

---

## B2. Alternative: MSI installer (including R2 download)

Simplest path: download MSI → install → harden. **Hardening is a second step.**

```powershell
# Download latest MSI from Cloudflare R2
$msi = "$env:USERPROFILE\Downloads\SafeBrowseSetup.msi"
Invoke-WebRequest `
  -Uri "https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/SafeBrowseSetup.msi" `
  -OutFile $msi

# Quiet install (elevated)
msiexec /i $msi /qn

# Harden DNS (elevated)
Invoke-WebRequest `
  -Uri "https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/0.1.0/configure-protection.ps1" `
  -OutFile "$env:TEMP\configure-protection.ps1"
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
& "$env:TEMP\configure-protection.ps1" -Action Install
```

Or double-click **`SafeBrowseSetup.msi`**, finish the wizard, then run `configure-protection.ps1 -Action Install` elevated.

---

## B3. Enroll this device with the parent dashboard

Protection policies come from the parent console. After install:

1. On the **parent phone/PC**, open the Safe Browse dashboard.
2. Create / select the **child**, then create an **enrollment code** (short-lived, single use — usually about 10 minutes).
3. On the **kid’s PC** (still elevated PowerShell):

```powershell
cd "C:\Program Files\Safe Browse"

# Replace CODE with the enrollment code from the dashboard
# (format like AB3K-M9NP-Q2VX — hyphens optional)
# Replace API with your device API base (same host as parent deploy)
.\SafeBrowse.Enroll.exe "https://YOUR-WORKER.workers.dev/api/v1/device/" "CODE"

# Restart the service so it loads credentials + policy
Restart-Service -Name "Safe Browse Protection" -Force
```

**Expected:** message like `Enrolled device …`. Service status **Running**.

If you are only testing **local** DNS filtering without cloud enroll yet, you can skip B3 and inject a test policy later from the parent tools (lab/dev only).

---

## B4. Verify Safe Browse is running

```powershell
# Service
Get-Service -Name "Safe Browse Protection"

# Files
Get-ChildItem "C:\Program Files\Safe Browse" | Select-Object Name

# DNS proxy listening on loopback
netstat -ano | findstr ":53 "

# Quick filter check (after enroll or test policy):
# Unblocked site should resolve; a policy-blocked domain should show Non-existent domain
nslookup example.com 127.0.0.1
```

| Check | Expected |
| :--- | :--- |
| Service | **Running** |
| Install folder | `SafeBrowse.Service.exe`, `SafeBrowse.Enroll.exe`, etc. |
| Port 53 on `127.0.0.1` | `LISTENING` |
| After harden | Adapter DNS servers include `127.0.0.1` |

System DNS servers after harden:

```powershell
Get-DnsClientServerAddress -AddressFamily IPv4 |
  Where-Object { $_.ServerAddresses } |
  Format-Table InterfaceAlias, ServerAddresses -AutoSize
```

---

## B5. Uninstall (if you need to remove Safe Browse)

Use the matching uninstall so DNS is restored:

```powershell
cd C:\Users\Public\SafeBrowse-0.1.0-win-x64
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\Uninstall-SafeBrowse.ps1
```

MSI-only path:

```powershell
msiexec /x SafeBrowseSetup.msi /qn
# If you hardened earlier, reverse it:
.\configure-protection.ps1 -Action Remove
```

Or: **Settings → Apps → Safe Browse → Uninstall**, then reverse hardening if internet breaks (DNS still on `127.0.0.1`).

---

# Part C — What to send the parent

After Parts A and B:

| Item | Example |
| :--- | :--- |
| **Hostname** | `KIDS-LAPTOP` |
| **IP address** | `192.168.2.xx` |
| **Windows username** | local name **or** Microsoft account e.g. `someone@outlook.com` |
| **Password** | admin-capable account password (share privately, not in chat if possible) |
| **Safe Browse service** | Running / not running |
| **Enrolled?** | Yes (device id) / not yet |

The parent can store credentials in a private local file (for example `.env.windows-login` — **never committed to git**) and use SSH + deploy tools to update or re-test later.

---

# Troubleshooting

| Problem | What to try |
| :--- | :--- |
| `Add-WindowsCapability` fails | Internet + Windows Update, reboot, retry as Administrator |
| `sshd` not found after install | Reboot, then `Start-Service sshd` |
| Firewall still blocks SSH | `Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP'` |
| Wrong IP range | Join home `192.168.2.0/24`, not guest Wi‑Fi / hotspot |
| Microsoft account SSH fails | Prefer a local admin for SSH, or confirm MS password + admin role |
| `Install-SafeBrowse.ps1` cannot find binaries | Use full release with `bin\`, or pass `-SourceDir`, or use MSI (B2) |
| MSI missing / tiny file after git clone | Run `git lfs install` and `git lfs pull` (MSI is Git LFS) |
| Service installed but sites not filtered | Run harden (`-Harden` or `configure-protection.ps1 -Action Install`); enroll device (B3) |
| Internet broken after uninstall | `.\configure-protection.ps1 -Action Remove` or `.\Uninstall-SafeBrowse.ps1` |
| Enrollment code fails | Code expired (≈10 min) or already used — create a new code in the dashboard |
| Port 53 not listening | `Get-Service 'Safe Browse Protection'`; check Event Viewer → Application for `SafeBrowse.Service` |

---

# Security notes (home LAN)

- SSH/RDP rules allow access **from your home network**. Do **not** port-forward 22/3389 to the public internet unless you understand the risk.
- Use strong passwords on admin accounts.
- Safe Browse needs **Administrator** to install the service and harden DNS; the child account should remain a **standard user** when possible.
- After testing, you can leave OpenSSH enabled for maintenance and turn RDP off if you do not need it.

Disable RDP later (optional):

```powershell
Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' `
  -Name 'fDenyTSConnections' -Value 1
Disable-NetFirewallRule -DisplayGroup 'Remote Desktop'
```

---

# Related docs

| Doc | Topic |
| :--- | :--- |
| [apps/windows/releases/0.1.0/README.md](../apps/windows/releases/0.1.0/README.md) | Short MSI / script notes for the release folder |
| [deployment.md](./deployment.md) | Parent cloud (Cloudflare Worker) one-click deploy |
| [parent-auth.md](./parent-auth.md) | Parent PIN + TOTP recovery |
| [test_setup_win11.md](./test_setup_win11.md) | Lab VM + remote test suite |
| `tools/remote_windows_test_suite.py` | Automated deploy/test from the parent Linux machine |
