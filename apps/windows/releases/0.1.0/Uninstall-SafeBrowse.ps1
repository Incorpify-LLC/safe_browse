#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Uninstall Safe Browse Protection (service, files, registry, optional hardening reverse, optional data wipe).

.PARAMETER InstallDir
  Install directory (default Program Files\Safe Browse).

.PARAMETER KeepData
  Keep ProgramData\SafeBrowse (policy, credentials, lists).

.PARAMETER SkipUnharden
  Do not reverse DNS/firewall/DoH changes.
#>
param(
  [string]$InstallDir = (Join-Path $env:ProgramFiles 'Safe Browse'),
  [switch]$KeepData,
  [switch]$SkipUnharden
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'Safe Browse Protection'
$dataDir = Join-Path $env:ProgramData 'SafeBrowse'

Write-Host "Uninstalling Safe Browse..."

# Stop service
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
  try { Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue } catch {}
  Start-Sleep -Seconds 1
}
Get-Process SafeBrowse.Service,SafeBrowse.Tray,SafeBrowse.NativeHost -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# Reverse hardening first (while we still know install path for firewall allow rule)
if (-not $SkipUnharden) {
  $hardenScript = Join-Path $InstallDir 'configure-protection.ps1'
  if (-not (Test-Path $hardenScript)) {
    $hardenScript = Join-Path $PSScriptRoot 'configure-protection.ps1'
  }
  if (Test-Path $hardenScript) {
    Write-Host 'Reverting network hardening...'
    try {
      & powershell -NoProfile -ExecutionPolicy Bypass -File $hardenScript -Action Remove
    } catch {
      Write-Warning "Harden reverse reported: $_"
    }
  } else {
    # Best-effort firewall cleanup without script
    foreach ($name in @(
      'Safe Browse - Allow Service DNS UDP',
      'Safe Browse - Allow Service DNS TCP',
      'Safe Browse - Block direct DNS UDP',
      'Safe Browse - Block direct DNS TCP'
    )) {
      Remove-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
    }
  }
}

# Remove Windows service
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  sc.exe delete "$ServiceName" | Out-Null
  Start-Sleep -Seconds 1
}

# Native messaging registry
foreach ($path in @(
  'HKLM:\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.incorpify.safebrowse',
  'HKLM:\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.incorpify.safebrowse',
  'HKLM:\SOFTWARE\Mozilla\NativeMessagingHosts\com.incorpify.safebrowse'
)) {
  Remove-Item -Path $path -Recurse -Force -ErrorAction SilentlyContinue
}

# Program Files
if (Test-Path $InstallDir) {
  # Retry delete (service handle release)
  for ($i = 0; $i -lt 5; $i++) {
    try {
      Remove-Item -Path $InstallDir -Recurse -Force -ErrorAction Stop
      break
    } catch {
      Start-Sleep -Seconds 2
      Get-Process SafeBrowse.Service -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
      if ($i -eq 4) { Write-Warning "Could not fully remove $InstallDir : $_" }
    }
  }
}

if (-not $KeepData -and (Test-Path $dataDir)) {
  Remove-Item -Path $dataDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "Removed data directory $dataDir"
} elseif ($KeepData) {
  Write-Host "Kept data directory $dataDir (-KeepData)"
}

# MSI product (if installed via WiX)
$msi = Get-CimInstance Win32_Product -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'Safe Browse' }
if ($msi) {
  Write-Host 'Removing MSI product entry...'
  foreach ($p in $msi) { $p.Uninstall() | Out-Null }
}

Write-Host 'Safe Browse uninstalled.'
