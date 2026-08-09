# Enable remote access on a kid’s Windows PC

Use this page on each child’s Windows 10/11 PC so the parent admin machine can install and test **Safe Browse** over the home LAN (`192.168.2.0/24`).

**Who runs this:** a parent / local **Administrator** account (or Microsoft account that is an admin).

**Time:** about 5 minutes per PC.

---

## 1. Open PowerShell as Administrator

1. Press **Start**, type **PowerShell**.
2. Right-click **Windows PowerShell** (or **Terminal**) → **Run as administrator**.
3. If User Account Control asks, choose **Yes**.

Copy and paste the blocks below **one section at a time**, press **Enter**, and wait for each to finish.

---

## 2. Install and start OpenSSH Server (required)

This opens **port 22** so the lab/admin machine can connect with SSH.

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

## 3. Optional: enable Remote Desktop (RDP)

Only if you also want desktop login from another PC (port **3389**).

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

## 4. Confirm this PC is on the home LAN

```powershell
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -like '192.168.2.*' } |
  Select-Object InterfaceAlias, IPAddress, PrefixLength
```

**Expected:** at least one address in **`192.168.2.x`**.

If you see only `192.168.29.x` or another range, connect Wi‑Fi/Ethernet to the **same network** the admin machine uses (`192.168.2.0/24`), then run the command again.

Also note:

```powershell
hostname
whoami
```

Write down **hostname** and **IPv4** (for the parent machine).

---

## 5. Quick self-test on this PC

```powershell
# SSH listening?
netstat -ano | findstr ':22 '

# Optional: RDP listening?
netstat -ano | findstr ':3389 '
```

You should see a line with `LISTENING` for port **22** (and **3389** if you enabled RDP).

---

## 6. What the parent needs from you

After the steps above, send or write down:

| Item | Example |
| :--- | :--- |
| **Hostname** | `KIDS-LAPTOP` |
| **IP address** | `192.168.2.xx` |
| **Windows username** | local name **or** Microsoft account e.g. `someone@outlook.com` |
| **Password** | the password for that admin-capable account |

The parent admin tools load credentials from a private file (not committed to git) and connect over SSH to install/test Safe Browse.

---

## 7. Troubleshooting

| Problem | What to try |
| :--- | :--- |
| `Add-WindowsCapability` fails / needs Windows Update | Connect to the internet, run Windows Update, reboot, retry as Administrator |
| `sshd` not found after install | Reboot once, then `Start-Service sshd` again |
| Firewall still blocks | Confirm the OpenSSH rule: `Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP'` |
| Wrong IP range | Join the home `192.168.2.0/24` Wi‑Fi/LAN, not guest or phone hotspot |
| Microsoft account SSH fails | Prefer a local admin account for SSH, or ensure the Microsoft password is current and the account is an admin |

---

## 8. Security notes (home LAN)

- These rules allow access **from your home network**. Do not expose ports 22/3389 to the public internet (router port-forwarding) unless you know what you are doing.
- Use a **strong password** on every admin account.
- When testing is done, you can disable RDP again if you do not need it; keeping OpenSSH is useful for Safe Browse maintenance.

Disable RDP later (optional):

```powershell
Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' `
  -Name 'fDenyTSConnections' -Value 1
Disable-NetFirewallRule -DisplayGroup 'Remote Desktop'
```

---

## Related

- Lab VM and remote test suite: [test_setup_win11.md](./test_setup_win11.md)
- Automated suite (parent machine): `tools/remote_windows_test_suite.py`
