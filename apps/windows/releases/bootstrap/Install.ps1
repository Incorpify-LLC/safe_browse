#Requires -RunAsAdministrator
# One-shot Safe Browse install for a child Windows PC (no Git).
#
# VERIFIED order (do not reorder):
#   1) Download MSI
#   2) Quiet install (msiexec /qn -- no wizard UI)
#   3) Write production ApiBaseUrl into appsettings.json
#   4) Start service
#   5) Enroll with setup code WHILE public DNS still works
#   6) Harden DNS last (system DNS -> 127.0.0.1, block direct DNS)
#
# Enroll.exe accepts any of these (0.1.1 and later):
#   SafeBrowse.Enroll.exe                          -> GUI dialog asking for the code
#   SafeBrowse.Enroll.exe <code>
#   SafeBrowse.Enroll.exe <apiBaseUrl> <code> [deviceName]
# This script uses the two-argument form so it can point a self-hosted install at
# its own Worker. Earlier builds crashed with IndexOutOfRangeException when given
# only the code; that is fixed, but the two-argument form remains correct.
#
# A parent who prefers not to use PowerShell at all can instead double-click the
# MSI: the wizard offers to open the enrollment dialog on its finish page, and a
# "Link this PC to Safe Browse" shortcut is installed in the Start Menu for
# re-enrolling later. That path does NOT harden DNS -- run this script, or
# configure-protection.ps1, for that.
#
# Simple remote install:
#   $env:SAFE_BROWSE_ENROLL = 'AB3K-M9NP-Q2VX'
#   irm https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/Install.ps1 | iex
#
# More reliable (parameters work):
#   irm .../Install.ps1 -OutFile $env:TEMP\sb-install.ps1
#   powershell -ExecutionPolicy Bypass -File $env:TEMP\sb-install.ps1 -EnrollCode 'AB3K-M9NP-Q2VX'

param(
  [string]$EnrollCode = "",
  [string]$ApiBaseUrl = "https://safebrowse.incorpify.in/api/v1/device/",
  [string]$MsiUrl = "https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/SafeBrowseSetup.msi",
  [string]$HardenScriptUrl = "https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/configure-protection.ps1",
  [switch]$SkipHarden,
  [switch]$SkipEnroll
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

if (-not $EnrollCode -and $env:SAFE_BROWSE_ENROLL) {
  $EnrollCode = $env:SAFE_BROWSE_ENROLL.Trim()
}
if ($env:SAFE_BROWSE_API) {
  $ApiBaseUrl = $env:SAFE_BROWSE_API.Trim()
}
$ApiBaseUrl = $ApiBaseUrl.TrimEnd("/") + "/"
$ApiForEnroll = $ApiBaseUrl.TrimEnd("/")

$ServiceName = "Safe Browse Protection"
$InstallDir = Join-Path $env:ProgramFiles "Safe Browse"
$temp = Join-Path $env:TEMP "SafeBrowse-Install"
New-Item -ItemType Directory -Path $temp -Force | Out-Null

function Write-Step([string]$msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

$principal = New-Object Security.Principal.WindowsPrincipal(
  [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script in an elevated PowerShell (Run as administrator)."
}

Write-Host "Safe Browse - child PC installer" -ForegroundColor Green
Write-Host "  API:  $ApiBaseUrl"
Write-Host "  MSI:  $MsiUrl"
if ($EnrollCode) { Write-Host "  Code: $EnrollCode" }

# ---- Download MSI ----------------------------------------------------------
Write-Step "Downloading installer"
$msi = Join-Path $temp "SafeBrowseSetup.msi"
try {
  Invoke-WebRequest -Uri $MsiUrl -OutFile $msi -UseBasicParsing
} catch {
  Write-Host "Download failed. Restore public DNS if a previous harden broke the network:" -ForegroundColor Yellow
  Write-Host '  foreach ($n in @('
  Write-Host '    "Safe Browse - Allow Service DNS UDP","Safe Browse - Allow Service DNS TCP",'
  Write-Host '    "Safe Browse - Block direct DNS UDP","Safe Browse - Block direct DNS TCP"'
  Write-Host '  )) { Remove-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue }'
  Write-Host '  Get-NetAdapter | ? Status -eq "Up" | % {'
  Write-Host '    Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ServerAddresses 1.1.1.1,8.8.8.8'
  Write-Host '  }'
  Write-Host "  Clear-DnsClientCache"
  throw
}
$sizeMb = [math]::Round((Get-Item $msi).Length / 1MB, 1)
if ((Get-Item $msi).Length -lt 1MB) {
  throw "MSI download looks too small ($sizeMb MB)."
}
Write-Host "  Downloaded ${sizeMb} MB"

# ---- Quiet MSI install -----------------------------------------------------
Write-Step "Installing MSI (quiet, no wizard UI)"
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  try { Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue } catch {}
  Get-Process SafeBrowse.Service -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

$msiArgs = "/i `"$msi`" /qn /norestart"
$p = Start-Process -FilePath "msiexec.exe" -ArgumentList $msiArgs -Wait -PassThru
if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) {
  throw "msiexec failed with exit code $($p.ExitCode)"
}
Write-Host "  msiexec exit $($p.ExitCode)"

if (-not (Test-Path (Join-Path $InstallDir "SafeBrowse.Service.exe"))) {
  throw "Install finished but SafeBrowse.Service.exe not found under $InstallDir"
}

# ---- Configure API base ----------------------------------------------------
Write-Step "Writing production API URL into appsettings.json"
$settingsPath = Join-Path $InstallDir "appsettings.json"
if (-not (Test-Path $settingsPath)) {
  @{
    Agent = @{
      ApiBaseUrl = $ApiBaseUrl
      UpstreamDohUrl = "https://cloudflare-dns.com/dns-query"
      DataDirectory = "C:\ProgramData\SafeBrowse"
      ManifestPublicKeyPath = "C:\Program Files\Safe Browse\blocklist-public-key.pem"
      AgentVersion = "0.1.0"
    }
  } | ConvertTo-Json -Depth 5 | Set-Content $settingsPath -Encoding UTF8
} else {
  $json = Get-Content $settingsPath -Raw | ConvertFrom-Json
  $json.Agent.ApiBaseUrl = $ApiBaseUrl
  $json | ConvertTo-Json -Depth 6 | Set-Content $settingsPath -Encoding UTF8
}
Write-Host "  ApiBaseUrl = $ApiBaseUrl"

# ---- Start service ---------------------------------------------------------
Write-Step "Starting service"
try {
  Start-Service -Name $ServiceName -ErrorAction Stop
} catch {
  try { Restart-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue } catch {}
}
Start-Sleep -Seconds 2
$st = (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue).Status
Write-Host "  Service status: $st"

# ---- Enroll BEFORE harden (needs public internet) --------------------------
# Two-argument form so a self-hosted install enrolls against its own Worker
# rather than the SaaS default. Enroll.exe is a WinExe from 0.1.1 on, but stdout
# and stderr are still captured correctly because this redirects both.
if ($EnrollCode -and -not $SkipEnroll) {
  Write-Step "Enrolling device with parent setup code"
  $enroll = Join-Path $InstallDir "SafeBrowse.Enroll.exe"
  if (-not (Test-Path $enroll)) {
    throw "SafeBrowse.Enroll.exe missing after install"
  }

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $enroll
  $psi.Arguments = "`"$ApiForEnroll`" `"$EnrollCode`""
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $proc = [System.Diagnostics.Process]::Start($psi)
  $stdout = $proc.StandardOutput.ReadToEnd()
  $stderr = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()
  if ($stdout) { Write-Host $stdout.TrimEnd() }
  if ($stderr) { Write-Host $stderr.TrimEnd() }
  if ($proc.ExitCode -ne 0) {
    Write-Warning "Enroll exited $($proc.ExitCode). Codes are single-use and expire after 24 hours."
    Write-Warning "Generate a fresh one in the parent console, then either:"
    Write-Warning "  Start menu -> Safe Browse -> Link this PC to Safe Browse   (dialog)"
    Write-Warning "  & `"$enroll`" `"YOUR-CODE`"                                  (command line)"
  } else {
    Write-Host "  Enrolled successfully" -ForegroundColor Green
    # Enroll.exe restarts the service itself, but only on a best-effort basis --
    # it swallows failures so a restart problem cannot fail an otherwise good
    # enrollment. Repeat it here so the new policy is definitely picked up.
    Restart-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
  }
} elseif (-not $EnrollCode) {
  Write-Host ""
  Write-Host "No enroll code provided. To link this PC to a child profile, either:" -ForegroundColor Yellow
  Write-Host "  Start menu -> Safe Browse -> Link this PC to Safe Browse   (dialog)"
  Write-Host "  & `"$InstallDir\SafeBrowse.Enroll.exe`" `"YOUR-CODE`""
}

# ---- Harden DNS LAST -------------------------------------------------------
if (-not $SkipHarden) {
  Write-Step "Hardening network (system DNS -> 127.0.0.1, block direct DNS, disable browser DoH)"
  $harden = Join-Path $temp "configure-protection.ps1"
  Invoke-WebRequest -Uri $HardenScriptUrl -OutFile $harden -UseBasicParsing
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $harden -Action Install
  Write-Host "  Hardening applied"
  # Service must be fully up after DNS is pointed at loopback (DoH upstream needs a moment).
  Restart-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 6

  Write-Step "Verifying local DNS filter still works"
  $dnsOk = $false
  for ($i = 1; $i -le 3; $i++) {
    try {
      $null = Resolve-DnsName example.com -Server 127.0.0.1 -DnsOnly -ErrorAction Stop
      $dnsOk = $true
      Write-Host "  127.0.0.1 resolved example.com OK (attempt $i)"
      break
    } catch {
      Write-Host "  attempt $i failed, waiting..."
      Start-Sleep -Seconds 3
      try { Restart-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue } catch {}
      Start-Sleep -Seconds 4
    }
  }
  if (-not $dnsOk) {
    Write-Warning "Local DNS filter failed after harden - restoring public DNS so the PC keeps internet."
  }
  if (-not $dnsOk) {
    foreach ($n in @(
      "Safe Browse - Allow Service DNS UDP",
      "Safe Browse - Allow Service DNS TCP",
      "Safe Browse - Block direct DNS UDP",
      "Safe Browse - Block direct DNS TCP"
    )) {
      Remove-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue
    }
    Get-NetAdapter | Where-Object Status -eq "Up" | ForEach-Object {
      Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ServerAddresses @("1.1.1.1", "8.8.8.8")
    }
    Clear-DnsClientCache
    Write-Warning "Protection service may need debugging; internet was restored."
  }
} else {
  Write-Host "Skipping harden (-SkipHarden)"
}

$st = (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue).Status
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host " Safe Browse is installed on this PC"
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Files:   $InstallDir"
Write-Host "  Service: $ServiceName / $st"
Write-Host "  API:     $ApiBaseUrl"
Write-Host ""
Write-Host "Quick check:"
Write-Host "  nslookup example.com 127.0.0.1"
Write-Host "  Get-Service 'Safe Browse Protection'"
Write-Host ""
