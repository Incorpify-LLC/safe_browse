# Safe Browse Windows installer (Win10 / Win11 x64)

## Public download (Cloudflare R2)

| Asset | URL |
| :--- | :--- |
| **Latest MSI** | https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/SafeBrowseSetup.msi |
| **This version (0.1.1)** | https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/0.1.1/SafeBrowseSetup.msi |
| **Manifest** | https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest.json |
| **SHA-256 (0.1.1)** | `2255cd01ef445ea929820e5bc2943a1facefec5a8870b43c0d1ec6b8488f495f` |

Re-upload after building: `bash tools/upload-windows-release.sh --version 0.1.1`

## MSI (recommended)

```powershell
# Elevated PowerShell (local file)
msiexec /i SafeBrowseSetup.msi /qn
# or double-click SafeBrowseSetup.msi

# Or download + install from R2:
# Invoke-WebRequest -Uri "https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/SafeBrowseSetup.msi" -OutFile .\SafeBrowseSetup.msi
# msiexec /i .\SafeBrowseSetup.msi /qn
```

Uninstall via **Settings → Apps**, or:

```powershell
msiexec /x SafeBrowseSetup.msi /qn
```

The MSI installs the Windows service (`Safe Browse Protection`), Native Host, Enroll, and Tray under `C:\Program Files\Safe Browse`.

For system DNS hardening (point DNS at 127.0.0.1, block direct DNS, disable browser DoH), after install run elevated:

```powershell
& "C:\Program Files\Safe Browse\configure-protection.ps1" -Action Install
# reverse:
& "C:\Program Files\Safe Browse\configure-protection.ps1" -Action Remove
```

> Note: WiX MSI may not yet embed `configure-protection.ps1` in Program Files; use the scripts in this folder or rebuild with `Package-Release.ps1`.

## Script installer (includes harden option)

Build a full `bin/` layout with `apps/windows/scripts/Package-Release.ps1`, then:

```powershell
.\Install-SafeBrowse.ps1 -Harden
.\Uninstall-SafeBrowse.ps1
```

## Rebuild

On Windows with .NET 8 SDK + WiX:

```powershell
cd apps\windows
.\scripts\Package-Release.ps1 -RepoWindowsRoot (Get-Location)
```

## Version

0.1.1 — self-contained win-x64 (.NET runtime included in MSI).

**Git LFS:** `SafeBrowseSetup.msi` is stored with Git LFS (~143 MB). Clone with `git lfs install` and `git lfs pull`.
