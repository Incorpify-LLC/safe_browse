#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Install Safe Browse Protection on Windows 10 / Windows 11 (x64).

.PARAMETER SourceDir
  Folder containing published binaries (default: parent of this script when laid out as release\scripts).

.PARAMETER InstallDir
  Target install directory (default: Program Files\Safe Browse).

.PARAMETER Harden
  Point system DNS at 127.0.0.1, disable browser DoH, block direct outbound DNS.

.PARAMETER ApiBaseUrl
  Optional device API base URL written into appsettings.json.
#>
param(
  [string]$SourceDir = "",
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'Safe Browse'),
  [switch]$Harden,
  [string]$ApiBaseUrl = ""
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'Safe Browse Protection'

function Resolve-SourceDir {
  if ($SourceDir) { return (Resolve-Path $SourceDir).Path }
  $here = $PSScriptRoot
  # release layout: release\scripts\Install-SafeBrowse.ps1 + release\bin\*
  $candidate = Join-Path (Split-Path $here -Parent) 'bin'
  if (Test-Path (Join-Path $candidate 'SafeBrowse.Service.exe')) { return $candidate }
  # repo layout: apps\windows\scripts + apps\windows\artifacts\service
  $artifacts = Join-Path (Split-Path $here -Parent) 'artifacts'
  if (Test-Path (Join-Path $artifacts 'service\SafeBrowse.Service.exe')) {
    return $artifacts
  }
  throw "Cannot find SafeBrowse.Service.exe. Pass -SourceDir to the folder with published binaries."
}

$src = Resolve-SourceDir
Write-Host "Source: $src"
Write-Host "Install: $InstallDir"

# Stop previous install
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  try { Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue } catch {}
  Start-Sleep -Seconds 1
}
Get-Process SafeBrowse.Service -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null

function Copy-FromLayout {
  param([string]$FromRelative, [string]$ToName)
  $paths = @(
    (Join-Path $src $FromRelative),
    (Join-Path $src $ToName),
    (Join-Path $src "service\$ToName"),
    (Join-Path $src "native-host\$ToName"),
    (Join-Path $src "enroll\$ToName"),
    (Join-Path $src "tray\$ToName")
  )
  foreach ($p in $paths) {
    if (Test-Path $p) {
      Copy-Item $p (Join-Path $InstallDir $ToName) -Force
      return $true
    }
  }
  return $false
}

$required = @(
  @{ Rel = 'SafeBrowse.Service.exe'; Name = 'SafeBrowse.Service.exe' },
  @{ Rel = 'appsettings.json'; Name = 'appsettings.json' }
)
foreach ($item in $required) {
  if (-not (Copy-FromLayout $item.Rel $item.Name)) {
    throw "Missing required file: $($item.Name)"
  }
}

foreach ($name in @(
  'SafeBrowse.NativeHost.exe',
  'SafeBrowse.Enroll.exe',
  'SafeBrowse.Tray.exe',
  'com.incorpify.safebrowse.chromium.json',
  'com.incorpify.safebrowse.firefox.json',
  'blocklist-public-key.pem',
  'configure-protection.ps1'
)) {
  [void](Copy-FromLayout $name $name)
}

# Also copy configure-protection from scripts sibling if present
$hardenScript = Join-Path $InstallDir 'configure-protection.ps1'
if (-not (Test-Path $hardenScript)) {
  $fromScripts = Join-Path $PSScriptRoot 'configure-protection.ps1'
  if (Test-Path $fromScripts) { Copy-Item $fromScripts $hardenScript -Force }
}

if ($ApiBaseUrl) {
  $settingsPath = Join-Path $InstallDir 'appsettings.json'
  $json = Get-Content $settingsPath -Raw | ConvertFrom-Json
  $json.Agent.ApiBaseUrl = $ApiBaseUrl
  $json | ConvertTo-Json -Depth 6 | Set-Content $settingsPath -Encoding UTF8
}

# Native messaging registry
$chromeManifest = Join-Path $InstallDir 'com.incorpify.safebrowse.chromium.json'
$firefoxManifest = Join-Path $InstallDir 'com.incorpify.safebrowse.firefox.json'
if (Test-Path $chromeManifest) {
  New-Item -Path 'HKLM:\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.incorpify.safebrowse' -Force | Out-Null
  Set-ItemProperty -Path 'HKLM:\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.incorpify.safebrowse' -Name '(default)' -Value $chromeManifest
  New-Item -Path 'HKLM:\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.incorpify.safebrowse' -Force | Out-Null
  Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.incorpify.safebrowse' -Name '(default)' -Value $chromeManifest
}
if (Test-Path $firefoxManifest) {
  New-Item -Path 'HKLM:\SOFTWARE\Mozilla\NativeMessagingHosts\com.incorpify.safebrowse' -Force | Out-Null
  Set-ItemProperty -Path 'HKLM:\SOFTWARE\Mozilla\NativeMessagingHosts\com.incorpify.safebrowse' -Name '(default)' -Value $firefoxManifest
}

# Data directory + ACL
$dataDir = Join-Path $env:ProgramData 'SafeBrowse'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
$system = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
$admins = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($admins, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
Set-Acl -Path $dataDir -AclObject $acl

$exe = Join-Path $InstallDir 'SafeBrowse.Service.exe'
if (-not $existing) {
  New-Service -Name $ServiceName -BinaryPathName "`"$exe`"" -DisplayName $ServiceName `
    -Description 'Local parental-control DNS filtering' -StartupType Automatic | Out-Null
} else {
  # Ensure path points at current binary
  sc.exe config "$ServiceName" binPath= "`"$exe`"" | Out-Null
}

if ($Harden -and (Test-Path $hardenScript)) {
  Write-Host 'Applying network hardening...'
  & powershell -NoProfile -ExecutionPolicy Bypass -File $hardenScript -Action Install
}

Start-Service -Name $ServiceName
Start-Sleep -Seconds 3
$status = (Get-Service -Name $ServiceName).Status
if ($status -ne 'Running') { throw "Service failed to start: $status" }

Write-Host ""
Write-Host "Safe Browse installed successfully."
Write-Host "  Service: $ServiceName ($status)"
Write-Host "  Files:   $InstallDir"
Write-Host "  Data:    $dataDir"
Write-Host ""
Write-Host "Next: enroll device with SafeBrowse.Enroll.exe <apiBaseUrl> <6-digit-code>"
Write-Host "Uninstall: Uninstall-SafeBrowse.ps1"
