# Safe Browse Windows installer (Win10 / Win11 x64)

## MSI (recommended)

```powershell
# Elevated PowerShell
msiexec /i SafeBrowseSetup.msi /qn
# or double-click SafeBrowseSetup.msi
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

0.1.0 — self-contained win-x64 (.NET runtime included in MSI).

**Git LFS:** `SafeBrowseSetup.msi` is stored with Git LFS (~143 MB). Clone with `git lfs install` and `git lfs pull`.
