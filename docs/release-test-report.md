# Windows Release Test Report

**Date:** 2026-08-08  
**Target:** `win11-vm` / WIN11-KVM (Windows 11 Pro 24H2) at `192.168.2.160`  
**Release:** `release/SafeBrowse-0.1.0-win-x64/`  

## Fixes applied before packaging (this session)

| ID | Fix |
| :--- | :--- |
| **P0-1** | Windows `Policy` JSON aligned with Worker/contracts (`enabledCategories`, `schedules`, `domainRules`, `generatedAt`); legacy aliases still accepted; case-insensitive category enum |
| **P0-2** | `POST /api/v1/auth/setup` returns `409 already_configured` if password already set |
| **P0-3** | `Install-SafeBrowse.ps1` + `Uninstall-SafeBrowse.ps1` + `Package-Release.ps1`; harden/unharden; ProgramData ACL |
| **P1-6** | Firefox DoH disable in `configure-protection.ps1` |
| **P1-5** | `ProgramData\SafeBrowse` ACL SYSTEM+Administrators on install/harden |

## Unit tests (on VM)

```
Passed!  Failed: 0, Passed: 9, Skipped: 0
```

Includes golden-file deserialize tests for Worker contract JSON and legacy aliases.

## Remote functional suite

```
Summary: 20 PASSED, 0 FAILED
```

Includes DNS pass-through, custom block, category block, **adult domain blocks** (`pornhub.com`, `xvideos.com`, `www.pornhub.com`), named pipe, NativeHost, emergency, protection script, restart.

## Install / block / uninstall cycles (release scripts)

| Cycle | Uninstall pre | Install | Policy inject | DNS (allow + adult + custom + anime) | Final uninstall |
| :---: | :---: | :---: | :---: | :---: | :---: |
| 1 | PASS (service ABSENT) | PASS | PASS | PASS (6/6) | PASS (service+files ABSENT) |
| 2 | PASS | PASS | PASS | PASS (6/6) | PASS |
| 3 | PASS | PASS | PASS | PASS (6/6) | PASS |

**Failed steps: 0**

Adult domains verified NXDOMAIN via `nslookup … 127.0.0.1` after policy inject of sample `adult.txt.gz` list (not full HaGeZi feed).

## Release folder contents

```
release/SafeBrowse-0.1.0-win-x64/
  Install-SafeBrowse.ps1
  Uninstall-SafeBrowse.ps1
  README.md
  SafeBrowseSetup.msi          (~144 MB WiX MSI)
  bin/                         self-contained win-x64 exes + manifests + configure-protection.ps1
  scripts/                     Install / Uninstall / configure-protection
```

**Total size on disk:** ~583 MB (self-contained .NET 8 runtimes in each exe + MSI).

### Primary install path (recommended)

```powershell
# Elevated PowerShell on Windows 10/11 x64
cd <release-folder>
Set-ExecutionPolicy -Scope Process Bypass
.\Install-SafeBrowse.ps1 -Harden
```

### Uninstall

```powershell
.\Uninstall-SafeBrowse.ps1
```

## Remaining open items (not fixed this session)

See [release-review-priority.md](./release-review-priority.md):

- **P1-1** Turnstile secret in wrangler vars (rotate / secret put)
- **P1-2** Default ENVIRONMENT=development
- **P1-3 / P1-4** Password KDF + durable rate limits
- **P2-*** SafeSearch/YouTube, schedules, session TTL, heartbeat honesty

## Rebuild release

On a Windows 10/11 x64 machine with .NET 8 SDK:

```powershell
cd apps\windows
.\scripts\Package-Release.ps1 -RepoWindowsRoot (Get-Location) -OutDir .\release\SafeBrowse-0.1.0-win-x64
```

Or from Linux host against the lab VM:

```bash
# source .env.keep for SAFE_BROWSE_SSH_*
python3 tools/remote_windows_test_suite.py --action all
# then Package-Release.ps1 on the VM as in Package-Release.ps1 docs
```
