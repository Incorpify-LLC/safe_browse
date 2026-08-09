#Requires -RunAsAdministrator
<#
.SYNOPSIS
  One-shot Safe Browse install for a child Windows PC (no Git required).

.DESCRIPTION
  Downloads the MSI from Cloudflare R2, installs quietly, points the agent at
  the production (or custom) API, hardens system DNS, and optionally enrolls
  with a parent-console code — all in one elevated PowerShell run.

.PARAMETER EnrollCode
  Enrollment code from the parent dashboard (e.g. AB3K-M9NP-Q2VX). Optional;
  you can enroll later with SafeBrowse.Enroll.exe.

.PARAMETER ApiBaseUrl
  Device API base (default: Incorpify SaaS).

.PARAMETER MsiUrl
  MSI download URL (default: latest public R2 release).

.PARAMETER SkipHarden
  Skip DNS / firewall / browser-DoH hardening.

.EXAMPLE
  # Install + harden only
  irm https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/Install.ps1 | iex

.EXAMPLE
  # Install + harden + enroll
  $u='https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/Install.ps1'
  iex "& { $(irm $u) } -EnrollCode 'AB3K-M9NP-Q2VX'"
#>
param(
  [string]$EnrollCode = "",
  [string]$ApiBaseUrl = "https://safebrowse.incorpify.in/api/v1/device/",
  [string]$MsiUrl = "https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/SafeBrowseSetup.msi",
  [string]$HardenScriptUrl = "https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/configure-protection.ps1",
  [switch]$SkipHarden
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ServiceName = 'Safe Browse Protection'
$InstallDir = Join-Path $env:ProgramFiles 'Safe Browse'
$temp = Join-Path $env:TEMP 'SafeBrowse-Install'
New-Item -ItemType Directory -Path $temp -Force | Out-Null

function Write-Step([string]$msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }

# ── Admin check ──────────────────────────────────────────────────────────────
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script in an elevated PowerShell (Run as administrator)."
}

Write-Host "Safe Browse — one-shot child PC installer" -ForegroundColor Green
Write-Host "  API:  $ApiBaseUrl"
Write-Host "  MSI:  $MsiUrl"
if ($EnrollCode) { Write-Host "  Code: $EnrollCode" }

# ── Download MSI ─────────────────────────────────────────────────────────────
Write-Step "Downloading installer"
$msi = Join-Path $temp 'SafeBrowseSetup.msi'
Invoke-WebRequest -Uri $MsiUrl -OutFile $msi -UseBasicParsing
$sizeMb = [math]::Round((Get-Item $msi).Length / 1MB, 1)
if ((Get-Item $msi).Length -lt 1MB) { throw "MSI download looks too small ($sizeMb MB). Check the URL." }
Write-Host "  Downloaded ${sizeMb} MB"

# ── Quiet MSI install ────────────────────────────────────────────────────────
Write-Step "Installing MSI (quiet)"
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  try { Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue } catch {}
  Get-Process SafeBrowse.Service -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

$p = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', $msi, '/qn', '/norestart') -Wait -PassThru
if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
  throw "msiexec failed with exit code $($p.ExitCode)"
}
Write-Host "  msiexec exit $($p.ExitCode)"

if (-not (Test-Path (Join-Path $InstallDir 'SafeBrowse.Service.exe'))) {
  throw "Install finished but SafeBrowse.Service.exe not found under $InstallDir"
}

# ── Configure API base at install time ───────────────────────────────────────
Write-Step "Writing production API URL into appsettings.json"
$settingsPath = Join-Path $InstallDir 'appsettings.json'
if (-not (Test-Path $settingsPath)) {
  # Create minimal settings if MSI omitted it
  @{
    Agent = @{
      ApiBaseUrl = $ApiBaseUrl
      UpstreamDohUrl = 'https://cloudflare-dns.com/dns-query'
      DataDirectory = 'C:\ProgramData\SafeBrowse'
      ManifestPublicKeyPath = 'C:\Program Files\Safe Browse\blocklist-public-key.pem'
      AgentVersion = '0.1.0'
    }
  } | ConvertTo-Json -Depth 5 | Set-Content $settingsPath -Encoding UTF8
} else {
  $json = Get-Content $settingsPath -Raw | ConvertFrom-Json
  $json.Agent.ApiBaseUrl = $ApiBaseUrl
  $json | ConvertTo-Json -Depth 6 | Set-Content $settingsPath -Encoding UTF8
}
Write-Host "  ApiBaseUrl = $ApiBaseUrl"

# ── Harden DNS / DoH / outbound DNS (default on) ─────────────────────────────
if (-not $SkipHarden) {
  Write-Step "Hardening network (system DNS → 127.0.0.1, block direct DNS, disable browser DoH)"
  $harden = Join-Path $temp 'configure-protection.ps1'
  try {
    Invoke-WebRequest -Uri $HardenScriptUrl -OutFile $harden -UseBasicParsing
  } catch {
    # Fallback: script next to MSI layout on same release folder
    $alt = $HardenScriptUrl -replace '/configure-protection.ps1$', '/../latest/configure-protection.ps1'
    Write-Host "  Primary harden URL failed; trying release 0.1.0 path already set..."
    throw
  }
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $harden -Action Install
  Write-Host "  Hardening applied"
} else {
  Write-Host "Skipping harden (-SkipHarden)"
}

# ── Ensure service running ───────────────────────────────────────────────────
Write-Step "Starting service"
try { Start-Service -Name $ServiceName -ErrorAction Stop } catch {
  # Service might already be running or MSI created it
  try { Restart-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue } catch {}
}
Start-Sleep -Seconds 3
$st = (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue).Status
Write-Host "  Service status: $st"

# ── Optional enroll ──────────────────────────────────────────────────────────
if ($EnrollCode) {
  Write-Step "Enrolling device with parent code"
  $enroll = Join-Path $InstallDir 'SafeBrowse.Enroll.exe'
  if (-not (Test-Path $enroll)) { throw "SafeBrowse.Enroll.exe missing after install" }
  $p2 = Start-Process -FilePath $enroll -ArgumentList @($ApiBaseUrl, $EnrollCode) -Wait -PassThru -NoNewWindow
  if ($p2.ExitCode -ne 0) {
    Write-Warning "Enroll exited $($p2.ExitCode). Generate a fresh code in the parent console and run:"
    Write-Warning "  & `"$enroll`" `"$ApiBaseUrl`" `"YOUR-CODE`""
  } else {
    Write-Host "  Enrolled successfully"
    Restart-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
}

# ── Summary ──────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host " Safe Browse is installed on this PC"
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Files:   $InstallDir"
Write-Host "  Service: $ServiceName / $st"
Write-Host "  API:     $ApiBaseUrl"
if (-not $EnrollCode) {
  Write-Host ""
  Write-Host "Next (parent console → Generate setup code), then:"
  Write-Host "  & `"$InstallDir\SafeBrowse.Enroll.exe`" `"$ApiBaseUrl`" `"CODE`""
  Write-Host "  Restart-Service '$ServiceName' -Force"
}
Write-Host ""
Write-Host "Quick check:"
Write-Host "  nslookup example.com 127.0.0.1"
Write-Host ""
