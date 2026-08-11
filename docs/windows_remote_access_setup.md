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

Safe Browse installs as a Windows service named **Safe Browse Protection**.  
**No Git on the child PC.** Prefer the R2 one-shot script (lab-verified on `win11-vm`).

Full notes: [child_install_one_liner.md](./child_install_one_liner.md)

---

## B1. Recommended: one-shot Install.ps1 (R2)

1. Parent: https://safebrowse.incorpify.in → child → **Generate setup code** (valid **24 hours**, single-use).  
2. On the kid’s PC, open **PowerShell as Administrator**.  
3. Paste **exactly** (two lines):

```powershell
$env:SAFE_BROWSE_ENROLL = 'PASTE-CODE-FROM-PARENT-CONSOLE'
irm https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/Install.ps1 | iex
```

What it does: download MSI → quiet install (no wizard) → set production API → start service → **enroll** → harden DNS (rolls back to public DNS if the local filter fails).

**Do not** use nested `iex "& { $(irm $u) } -EnrollCode ..."` — fragile and easy to paste wrong.

---

## B2. MSI double-click, then enroll by hand

```powershell
# Download (browser or PowerShell)
$msi = "$env:USERPROFILE\Downloads\SafeBrowseSetup.msi"
Invoke-WebRequest `
  -Uri "https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/SafeBrowseSetup.msi" `
  -OutFile $msi
# Double-click the MSI, or: msiexec /i $msi /qn
```

From 0.1.1 the MSI **does** have a wizard, and its finish page offers "Link this PC
to a child profile now", which opens the enrollment dialog. Everything below is
the command-line alternative; it is not required. Note that a plain MSI install
does **not** harden DNS — use `Install.ps1` or `configure-protection.ps1` for that.

After install (elevated PowerShell):

```powershell
& "C:\Program Files\Safe Browse\SafeBrowse.Enroll.exe" `
  "https://safebrowse.incorpify.in/api/v1/device" `
  "PASTE-CODE-FROM-PARENT-CONSOLE"
Restart-Service -Name "Safe Browse Protection" -Force
```

From 0.1.1 a bare code also works (`SafeBrowse.Enroll.exe "CODE"`), and running it
with no arguments opens a dialog. Earlier builds threw `IndexOutOfRangeException`
for both. The two-argument form above stays correct and is what you want when
enrolling against a self-hosted Worker.

---

## B3. Verify

```powershell
Get-Service -Name "Safe Browse Protection"
Test-Path "C:\ProgramData\SafeBrowse\device.credential"
Test-Path "C:\ProgramData\SafeBrowse\policy.json"
Get-ChildItem "C:\Program Files\Safe Browse" | Select-Object Name
netstat -ano | findstr ":53 "
nslookup example.com 127.0.0.1
```

Expected: service **Running**, credential + policy present. `nslookup` via `127.0.0.1` only if harden applied and the filter is healthy.

---

## B4. Restore internet if harden left the PC offline

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

SSH/RDP by **IP** still works when DNS names fail.

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
cd C:\Users\Public\SafeBrowse-0.1.1-win-x64
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
| Service installed but sites not filtered | Prefer full Install.ps1 (B1); enroll with two args (B2); check `device.credential` |
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
| [apps/windows/releases/0.1.1/README.md](../apps/windows/releases/0.1.1/README.md) | Short MSI / script notes for the release folder |
| [deployment.md](./deployment.md) | Parent cloud (Cloudflare Worker) one-click deploy |
| [parent-auth.md](./parent-auth.md) | Parent PIN + TOTP recovery |
| [test_setup_win11.md](./test_setup_win11.md) | Lab VM + remote test suite |
| `tools/remote_windows_test_suite.py` | Automated deploy/test from the parent Linux machine |
