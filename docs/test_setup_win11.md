# Windows 11 KVM Test Environment & Deployment Guide

This document outlines the setup, architecture, saved image templates, remote deployment, and automated testing for the Windows 11 KVM environment used to build and validate **Safe Browse**.

**Last updated:** 2026-08-08 (Deployment, full bug-fix verification, and 18-step test suite green)

---

## 1. Active Test Environment (`win11-vm`)

| Parameter | Configuration |
| :--- | :--- |
| **VM Name** | `win11-vm` |
| **OS Version** | Windows 11 Pro 24H2 (Build 26100) |
| **Hostname** | `WIN11-KVM` |
| **IP Address** | DHCP on `br0` — **do not hardcode.** Was `192.168.2.160`, was `192.168.2.173` on 2026-08-11. Find it with the snippet below. |
| **Local Admin User** | `********` |
| **Password** | `************` |
| **SSH Access** | `ssh <user>@<current-ip>` (Port 22, OpenSSH Server) |
| **RDP Access** | `<current-ip>:3389` (NLA disabled, user authorized) |
| **SPICE Display** | `spice://localhost:5901` |
| **Hardware Specs** | 8 vCPUs, 8 GB RAM, 64 GB virtio/SATA qcow2 disk, TPM 2.0 (`swtpm`), OVMF UEFI |
| **Disk image** | `/home/sanjayu/vm-images/win11.qcow2` |
| **.NET on VM** | SDK 8.0.423 + 9.0.316 (used for remote build) |
| **WSL** | WSL 2.7.11 (default version **2**), kernel `6.18.33.2-microsoft-standard-WSL2` |
| **WSL distro** | `Ubuntu-26.04` — Ubuntu 26.04 LTS (*Resolute Raccoon*), default user `sanjayu` |

### Finding the VM's current IP

The guest is bridged, not on a libvirt NAT network, so `virsh domifaddr` and
`virsh net-dhcp-leases` both return nothing. Look it up by MAC instead:

```bash
MAC=$(virsh dumpxml win11-vm | grep -oP "(?<=mac address=')[^']+")
ip neigh | grep -i "$MAC"                      # if already in the ARP cache

# not cached? sweep the subnet first, then look again
for i in $(seq 1 254); do (ping -c1 -W1 192.168.2.$i >/dev/null 2>&1 &); done
sleep 10 && ip neigh | grep -i "$MAC"
```

### Host networking notes

- Host bridge IP: `192.168.2.159/24` on `br0`
- ICMP ping to the guest may fail (Windows firewall); **SSH is the connectivity check**
- Manage VM: `virsh list --all`, `virsh start win11-vm`, `virsh shutdown win11-vm`
- `virsh shutdown` (ACPI) may go unacknowledged. If the guest is still running
  after a few minutes, shut down from inside instead:
  `ssh <user>@<ip> 'shutdown /s /t 5'`

---

## 2. Saved Assets & Location

All installation media, drivers, and pre-configured golden image templates are saved on the host at `/home/sanjayu/vm-images/`:

| Asset | Path |
| :--- | :--- |
| **Golden template disk** | `/home/sanjayu/vm-images/win11-golden-template.qcow2` (~14 GB; Win11 Pro, user `<user>`, RDP + OpenSSH) |
| **Active VM disk** | `/home/sanjayu/vm-images/win11.qcow2` |
| **Windows 11 Setup ISO** | `/home/sanjayu/vm-images/uup-download/26100.1_PROFESSIONAL_X64_EN-US.ISO` |
| **VirtIO Drivers ISO** | `/home/sanjayu/vm-images/virtio-win.iso` |
| **Unattended helpers** | `autounattend.xml`, `unattend.vfd`, `unattend.iso`, `tools.iso` |

---

## 3. Spawning Additional Windows 11 VMs

### Option A: Instant Linked Clones (< 5 seconds setup)

```bash
# 1. Create a lightweight overlay disk
qemu-img create -f qcow2 -b /home/sanjayu/vm-images/win11-golden-template.qcow2 -F qcow2 /home/sanjayu/vm-images/win11-vm2.qcow2

# 2. Launch the new VM instance
virt-install \
  --name win11-vm2 \
  --ram 8192 \
  --vcpus 8 \
  --cpu host-passthrough \
  --os-variant win11 \
  --boot uefi \
  --tpm backend.type=emulator,backend.version=2.0,model=tpm-tis \
  --disk path=/home/sanjayu/vm-images/win11-vm2.qcow2,bus=sata,format=qcow2 \
  --network bridge=br0,model=virtio \
  --graphics spice,listen=0.0.0.0 \
  --video qxl \
  --import \
  --noautoconsole
```

After first boot, set a unique IP (DHCP or static) and re-run the remote suite against that host.

### Option B: Unattended Fresh Installation from ISO

```bash
qemu-img create -f qcow2 /home/sanjayu/vm-images/win11-fresh.qcow2 64G

virt-install \
  --name win11-vm-fresh \
  --ram 8192 \
  --vcpus 8 \
  --cpu host-passthrough \
  --os-variant win11 \
  --boot uefi \
  --tpm backend.type=emulator,backend.version=2.0,model=tpm-tis \
  --disk path=/home/sanjayu/vm-images/win11-fresh.qcow2,bus=sata,format=qcow2 \
  --disk path=/home/sanjayu/vm-images/unattend.vfd,device=floppy \
  --disk path=/home/sanjayu/vm-images/uup-download/26100.1_PROFESSIONAL_X64_EN-US.ISO,device=cdrom,bus=sata \
  --disk path=/home/sanjayu/vm-images/virtio-win.iso,device=cdrom,bus=sata \
  --network bridge=br0,model=virtio \
  --graphics spice,listen=0.0.0.0 \
  --video qxl \
  --noautoconsole
```

---

## 4. Remote Deploy + Automated Test Suite

Remote execution uses SSH (`sshpass` or keys) from the Linux host (or any machine that can reach the Windows target).

### Prerequisites (controller machine)

```bash
# Fedora/RHEL example
sudo dnf install -y sshpass openssh-clients python3
```

### Prerequisites (Windows target)

- Windows 10/11 x64
- OpenSSH Server running and reachable
- Local admin account (service install + port 53 bind)
- .NET SDK 8+ **if using remote build/deploy** (`--action deploy` / `all`)
- Outbound HTTPS (Cloudflare DoH: `https://cloudflare-dns.com/dns-query`)

### One-shot verify connectivity

```bash
sshpass -p '************' ssh -o StrictHostKeyChecking=no <user>@192.168.2.160 "whoami && hostname"
```

### Suite location

`tools/remote_windows_test_suite.py`

### Usage

```bash
cd /path/to/safe_browse

# Functional tests only (agent already installed)
python3 tools/remote_windows_test_suite.py \
  --host 192.168.2.160 \
  --user <user> \
  --password '************' \
  --action test

# Build on the Windows machine + install + test
python3 tools/remote_windows_test_suite.py \
  --host 192.168.2.160 \
  --user <user> \
  --password '************' \
  --action all

# Deploy only
python3 tools/remote_windows_test_suite.py --host <IP> --user <USER> --password '<PW>' --action deploy
```

Environment variables (optional, avoid putting secrets on the CLI):

| Variable | Meaning |
| :--- | :--- |
| `SAFE_BROWSE_SSH_HOST` | Target IP/hostname (default: `192.168.2.160`) |
| `SAFE_BROWSE_SSH_USER` | SSH username |
| `SAFE_BROWSE_SSH_PASSWORD` | SSH password |

### What `--action deploy` does

1. Packages `apps/windows` source (excludes `bin`/`obj`/`artifacts`)
2. SCPs tarball to the Windows user profile
3. Extracts under `C:\Users\<user>\safebrowse-build\safebrowse-windows-src`
4. Runs `dotnet test` on `SafeBrowse.Core.Tests`
5. Publishes self-contained `win-x64` Service, NativeHost, Enroll, Tray
6. Force-stops `Safe Browse Protection` if needed
7. Copies binaries into `C:\Program Files\Safe Browse`
8. Ensures native-messaging registry keys (Chrome, Edge, Firefox)
9. Creates the Windows service if missing; starts it

### What `--action test` verifies (18 Comprehensive Checks)

| # | Check | Description |
| :---: | :--- | :--- |
| 1 | Service `Safe Browse Protection` status | Verified **Running** state via PowerShell `Get-Service` |
| 2 | Required install files present | Checks Service, NativeHost, Enroll, Tray, appsettings, NM manifests |
| 3 | NativeMessagingHosts registry keys | Validates `HKLM\...\NativeMessagingHosts\com.incorpify.safebrowse` for Chrome, Edge, Firefox |
| 4 | DNS listener on 127.0.0.1:53 | Verifies proxy is listening on loopback port 53 via `netstat` |
| 5 | Inject test policy & category blocklist | Writes `policy.json` and decompressed `anime.txt.gz` (with comments) then restarts service |
| 6 | DNS pass-through (`example.com`) | `nslookup example.com 127.0.0.1` resolves cleanly |
| 7 | DNS custom block (`blocked-test-domain.com`) | `nslookup blocked-test-domain.com 127.0.0.1` returns NXDOMAIN |
| 8 | DNS category block (`blocked-anime-site.test`) | Verifies category blocklist decompression & comment stripping |
| 9 | Named pipe `evaluate` action | Sends `{"action":"evaluate"}` over `safe-browse-native` pipe -> returns `custom_block` |
| 10 | Named pipe `navigation` telemetry | Sends `{"action":"navigation"}` over pipe -> verified accepted without block |
| 11 | Named pipe `request` access request | Sends `{"action":"request"}` over pipe -> verifies enqueued with local `requestId` |
| 12 | NativeHost stdio protocol relay | Executes `SafeBrowse.NativeHost.exe` stdio 4-byte LE protocol -> verifies native messaging JSON response |
| 13 | Named pipe emergency bypass | Verifies admin authorization -> returns `{ ok: true, until }` |
| 14 | DNS health during emergency | `nslookup example.com 127.0.0.1` resolves during emergency bypass |
| 15 | No proxy hang after emergency | Previously blocked domain does not hang proxy after emergency |
| 16 | Protection script toggle (`configure-protection.ps1`) | Verifies `configure-protection.ps1 -Action Install` and `-Action Remove` execution & firewall rules |
| 17 | Service restart health | Verifies clean service stop & restart |
| 18 | Post-restart block & pass-through | Re-verifies custom block + category block + pass-through after service restart |

**Exit code:** `0` all pass, `1` test failures, `2` SSH failure, `3` timeout, `4` deploy/runtime error.

### Latest run (2026-08-08)

```
Summary: 18 PASSED, 0 FAILED
Target: <user>@192.168.2.160
```

---

## 5. Product install layout on Windows

| Path | Purpose |
| :--- | :--- |
| `C:\Program Files\Safe Browse\SafeBrowse.Service.exe` | Windows service (DNS proxy + sync + pipe) |
| `C:\Program Files\Safe Browse\SafeBrowse.NativeHost.exe` | Browser native messaging host |
| `C:\Program Files\Safe Browse\SafeBrowse.Enroll.exe` | Device enrollment CLI |
| `C:\Program Files\Safe Browse\SafeBrowse.Tray.exe` | Tray UI |
| `C:\Program Files\Safe Browse\appsettings.json` | Agent config (API base, DoH URL, data dir) |
| `C:\ProgramData\SafeBrowse\policy.json` | Cached policy |
| `C:\ProgramData\SafeBrowse\lists\*.txt.gz` | Category blocklists (when enrolled) |
| Service name | `Safe Browse Protection` |
| Named pipe | `safe-browse-native` |

Hardening script (points system DNS at the local proxy, disables browser DoH, blocks direct outbound DNS while allowing `SafeBrowse.Service.exe`):

```powershell
# Elevated
.\apps\windows\scripts\configure-protection.ps1 -Action Install
# Revert
.\apps\windows\scripts\configure-protection.ps1 -Action Remove
```

---

## 6. Bugs found during VM testing (fixed in tree)

These were identified while validating against `win11-vm` and fixed before the suite went green.

| Bug | Symptom | Fix |
| :--- | :--- | :--- |
| **Impersonation Fallback Security Bug** | Non-admin caller gained emergency bypass if pipe client impersonation failed | Initialized `isAdministrator = false;` and set `false` on exception handler |
| **Domain Normalization Pipe Crash** | Invalid domain in pipe request dropped pipe connection | Wrapped `DomainNormalizer.Normalize` in `try/catch` returning `{"error":"invalid_domain"}` |
| **Domain Normalizer Space Bypass** | Space in domain string passed normalization | Added `candidate.Contains(' ')` check to `DomainNormalizer.Normalize` |
| **Timezone Fallback Exception** | Invalid/unknown timezone string crashed `PolicyEvaluator` | Wrapped `FindSystemTimeZoneById` in `try/catch` with `TimeZoneInfo.Utc` fallback |
| **Category List Comment Parsing** | Comments (`# ...`) in `*.txt.gz` were added as block entries | Added `Trim()` and `#` comment line filter in `PolicyStore.LoadLists()` |
| **Enroll API Base URL Duplication** | Passing `/api/v1/device` to `SafeBrowse.Enroll` duplicated URL path | Added URL path normalization before appending `/enroll` |
| **Firewall Rule Blocked Service DNS** | Direct outbound DNS block rule blocked `SafeBrowse.Service.exe` UDP fallback | Added explicit outbound `Allow` rule for `SafeBrowse.Service.exe` |
| **Null policy arrays crash DNS** | Every DNS query timed out; Event Log: `ArgumentNullException` in `PolicyEvaluator.Evaluate` | Null-coalesce `DomainRules`, `EnabledCategories`, `Schedules`; tolerant `PolicyStore.Load` |
| **Policy JSON property names** | PowerShell-written `policy.json` did not bind to C# records | `[JsonPropertyName]` on policy models (`rules`, `blockedCategories`, `schedule`, …) |
| **DoH failure took down resolve** | Hard failure on DoH with no fallback | DoH try/catch + UDP fallback to `1.1.1.1:53` with **timeouts** |
| **UDP fallback hung forever** | After emergency bypass of non-existent domain, all DNS hung | Per-request 3s cancel tokens on DoH + UDP; SERVFAIL/NXDOMAIN on failure |
| **Service would not stop** | `net stop` stuck in `STOP_PENDING`; binary locked | Dispose UDP/TCP listeners on cancel; dispose named-pipe waiters on stop; suite force-kills if needed |
| **Named pipe only for current user** | Pipe ACL too tight (`CurrentUserOnly`) | Explicit pipe ACL for Authenticated Users + SYSTEM + Administrators |
| **Unenrolled default was block-all** | No policy → all DNS blocked | Default `bootstrap_unenrolled` → allow until enrolled |
| **Installer missing NM registry** | No Chrome/Edge/Firefox native host keys | WiX components + registry values; deploy script mirrors them |

Unit coverage: `SafeBrowse.Core.Tests` now includes 7 automated unit tests covering null policy, custom block, invalid timezone fallback, domain normalizer exceptions, and DNS packet creation.

---

## 7. Session handoff / current state

| Item | State |
| :--- | :--- |
| VM `win11-vm` | Running, SSH OK at `192.168.2.160` |
| Safe Browse service | Installed and **Running** with latest built bits |
| Remote suite | `tools/remote_windows_test_suite.py` — deploy + 18 functional checks (**18 PASSED, 0 FAILED**) |
| Unit tests | `SafeBrowse.Core.Tests` — 7 tests (**7 PASSED, 0 FAILED**) |
| Docs | `docs/test_setup_win11.md` updated |

### Suggested next steps

1. Point `appsettings.json` `ApiBaseUrl` at a staging Worker and exercise enrollment (`SafeBrowse.Enroll.exe`)
2. Install browser extension + verify native messaging round-trip
3. Run `configure-protection.ps1 -Action Install` and re-run the suite (system DNS → 127.0.0.1)
4. Add WiX to the Windows build image if MSI packaging is required in CI

---

## 8. Manual smoke commands (quick debug)

```bash
# Service status
sshpass -p '************' ssh <user>@192.168.2.160 'sc query "Safe Browse Protection"'

# DNS allow / block checks
sshpass -p '************' ssh <user>@192.168.2.160 'nslookup example.com 127.0.0.1'
sshpass -p '************' ssh <user>@192.168.2.160 'nslookup blocked-test-domain.com 127.0.0.1'
sshpass -p '************' ssh <user>@192.168.2.160 'nslookup blocked-anime-site.test 127.0.0.1'

# Event log (policy/DNS errors)
sshpass -p '************' ssh <user>@192.168.2.160 'powershell -NoProfile -Command "Get-WinEvent -FilterHashtable @{LogName=\"Application\"; ProviderName=\"SafeBrowse.Service\"} -MaxEvents 20 | Format-List TimeCreated,Message"'
```

