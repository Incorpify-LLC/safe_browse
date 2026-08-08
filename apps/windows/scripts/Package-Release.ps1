#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Publish Safe Browse binaries and assemble a release folder for Win10/11 x64.

.PARAMETER RepoWindowsRoot
  Path to apps\windows on the build machine.

.PARAMETER OutDir
  Output release directory.
#>
param(
  [Parameter(Mandatory = $true)][string]$RepoWindowsRoot,
  [string]$OutDir = ""
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path $RepoWindowsRoot).Path
if (-not $OutDir) {
  $OutDir = Join-Path $root 'release\SafeBrowse-0.1.0-win-x64'
}
Write-Host "Building release into $OutDir"

# Unit tests
dotnet test (Join-Path $root 'tests\SafeBrowse.Core.Tests\SafeBrowse.Core.Tests.csproj') -c Release --verbosity minimal
if ($LASTEXITCODE -ne 0) { throw 'Unit tests failed' }

$artifacts = Join-Path $root 'artifacts'
New-Item -ItemType Directory -Path $artifacts -Force | Out-Null

$map = @{
  'Service'    = @{ Proj = 'src\SafeBrowse.Service\SafeBrowse.Service.csproj'; Out = 'service' }
  'NativeHost' = @{ Proj = 'src\SafeBrowse.NativeHost\SafeBrowse.NativeHost.csproj'; Out = 'native-host' }
  'Enroll'     = @{ Proj = 'src\SafeBrowse.Enroll\SafeBrowse.Enroll.csproj'; Out = 'enroll' }
  'Tray'       = @{ Proj = 'src\SafeBrowse.Tray\SafeBrowse.Tray.csproj'; Out = 'tray' }
}

foreach ($key in $map.Keys) {
  $m = $map[$key]
  $out = Join-Path $artifacts $m.Out
  Write-Host "Publish $key -> $out"
  dotnet publish (Join-Path $root $m.Proj) -c Release -r win-x64 --self-contained true -o $out
  if ($LASTEXITCODE -ne 0) { throw "Publish $key failed" }
}

Copy-Item (Join-Path $root 'native-host\*.json') (Join-Path $artifacts 'native-host') -Force
if (Test-Path (Join-Path $root 'installer\blocklist-public-key.pem.example')) {
  Copy-Item (Join-Path $root 'installer\blocklist-public-key.pem.example') (Join-Path $artifacts 'service\blocklist-public-key.pem.example') -Force
}

# Assemble flat bin + scripts layout
if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
$bin = Join-Path $OutDir 'bin'
$scripts = Join-Path $OutDir 'scripts'
New-Item -ItemType Directory -Path $bin, $scripts -Force | Out-Null

Copy-Item (Join-Path $artifacts 'service\SafeBrowse.Service.exe') $bin -Force
Copy-Item (Join-Path $artifacts 'service\appsettings.json') $bin -Force
Copy-Item (Join-Path $artifacts 'native-host\SafeBrowse.NativeHost.exe') $bin -Force
Copy-Item (Join-Path $artifacts 'enroll\SafeBrowse.Enroll.exe') $bin -Force
Copy-Item (Join-Path $artifacts 'tray\SafeBrowse.Tray.exe') $bin -Force
Copy-Item (Join-Path $artifacts 'native-host\com.incorpify.safebrowse.*.json') $bin -Force
Copy-Item (Join-Path $root 'scripts\configure-protection.ps1') $bin -Force
Copy-Item (Join-Path $root 'scripts\configure-protection.ps1') $scripts -Force
Copy-Item (Join-Path $root 'scripts\Install-SafeBrowse.ps1') $scripts -Force
Copy-Item (Join-Path $root 'scripts\Uninstall-SafeBrowse.ps1') $scripts -Force

# Convenience copies at release root
Copy-Item (Join-Path $scripts 'Install-SafeBrowse.ps1') $OutDir -Force
Copy-Item (Join-Path $scripts 'Uninstall-SafeBrowse.ps1') $OutDir -Force

@'
# Safe Browse — Windows 10 / Windows 11 (x64) Release

## Requirements
- Windows 10 or Windows 11 **x64**
- Local Administrator rights for install/uninstall
- Child accounts should be **standard (non-admin)** users

## Install (elevated PowerShell)

```powershell
cd <this-folder>
Set-ExecutionPolicy -Scope Process Bypass
.\Install-SafeBrowse.ps1 -Harden
```

Without system DNS hardening (service-only, for lab testing):

```powershell
.\Install-SafeBrowse.ps1
```

## Enroll device (after parent creates a 6-digit code)

```powershell
& "C:\Program Files\Safe Browse\SafeBrowse.Enroll.exe" "https://YOUR-WORKER/api/v1/device" 123456
Restart-Service "Safe Browse Protection"
```

## Uninstall

```powershell
cd <this-folder>
.\Uninstall-SafeBrowse.ps1
```

Keep policy/credentials:

```powershell
.\Uninstall-SafeBrowse.ps1 -KeepData
```

## What gets installed
| Path | Purpose |
|------|---------|
| `C:\Program Files\Safe Browse\` | Service, NativeHost, Enroll, Tray, manifests |
| `C:\ProgramData\SafeBrowse\` | Policy, credentials, lists (ACL: SYSTEM + Admins) |
| Service `Safe Browse Protection` | DNS proxy on 127.0.0.1:53 |

With `-Harden`: system DNS → 127.0.0.1, Chrome/Edge/Firefox DoH disabled, outbound DNS 53/853 blocked except the service.

## Residual bypasses (honest threat model)
VPN, Tor, mobile hotspot, hard-coded IPs, and local admin can bypass filtering.

## Version
0.1.0 — win-x64 self-contained (.NET 8 runtime included)
'@ | Set-Content (Join-Path $OutDir 'README.md') -Encoding UTF8

# Optional MSI if WiX is installed
$wixProj = Join-Path $root 'installer\SafeBrowse.Installer.wixproj'
try {
  Write-Host 'Attempting WiX MSI build...'
  dotnet build $wixProj -c Release
  $msi = Get-ChildItem (Join-Path $root 'installer') -Recurse -Filter 'SafeBrowseSetup.msi' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($msi) {
    Copy-Item $msi.FullName (Join-Path $OutDir 'SafeBrowseSetup.msi') -Force
    Write-Host "MSI copied: $($msi.FullName)"
  } else {
    Write-Host 'MSI not produced (WiX may be missing) — script installer is primary.'
  }
} catch {
  Write-Host "WiX MSI skipped: $_"
}

Write-Host ""
Write-Host "RELEASE_OK $OutDir"
Get-ChildItem $OutDir -Recurse | Select-Object FullName, Length | Format-Table -AutoSize
