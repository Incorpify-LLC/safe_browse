param([ValidateSet('Install','Remove')] [string]$Action)
$ErrorActionPreference = 'Stop'
$dataDirectory = Join-Path $env:ProgramData 'SafeBrowse'
$backupPath = Join-Path $dataDirectory 'dns-backup.json'
$serviceExe = Join-Path $env:ProgramFiles 'Safe Browse\SafeBrowse.Service.exe'

function Set-SafeBrowseDataAcl {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return }
  # SYSTEM + Administrators only — non-admin children must not rewrite policy/credentials
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $system = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
  $admins = New-Object System.Security.Principal.SecurityIdentifier([System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($system, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($admins, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  Set-Acl -Path $Path -AclObject $acl
}

function Set-FirefoxDohOff {
  $policyDir = Join-Path $env:ProgramFiles 'Mozilla Firefox\distribution'
  New-Item -ItemType Directory -Force -Path $policyDir | Out-Null
  $policyPath = Join-Path $policyDir 'policies.json'
  $payload = @{
    policies = @{
      DNSOverHTTPS = @{ Enabled = $false; Locked = $true }
      Preferences = @{
        'network.trr.mode' = @{ Value = 5; Status = 'locked' }
      }
    }
  } | ConvertTo-Json -Depth 6
  # Preserve existing policies if present: merge DNS keys only when file is ours/empty
  if (-not (Test-Path $policyPath)) {
    Set-Content -Path $policyPath -Value $payload -Encoding UTF8
  } else {
    try {
      $existing = Get-Content $policyPath -Raw | ConvertFrom-Json
      if (-not $existing.policies) { $existing | Add-Member -NotePropertyName policies -NotePropertyValue ([pscustomobject]@{}) }
      $existing.policies | Add-Member -NotePropertyName DNSOverHTTPS -NotePropertyValue ([pscustomobject]@{ Enabled = $false; Locked = $true }) -Force
      $existing | ConvertTo-Json -Depth 8 | Set-Content -Path $policyPath -Encoding UTF8
    } catch {
      Set-Content -Path $policyPath -Value $payload -Encoding UTF8
    }
  }
  New-Item -Force 'HKLM:\Software\Policies\Mozilla\Firefox' | Out-Null
  New-ItemProperty -Force 'HKLM:\Software\Policies\Mozilla\Firefox' -Name 'DNSOverHTTPS' -PropertyType String -Value '{"Enabled":false,"Locked":true}' -ErrorAction SilentlyContinue | Out-Null
}

function Remove-FirefoxDohPolicy {
  $policyPath = Join-Path $env:ProgramFiles 'Mozilla Firefox\distribution\policies.json'
  if (Test-Path $policyPath) {
    try {
      $existing = Get-Content $policyPath -Raw | ConvertFrom-Json
      if ($existing.policies.DNSOverHTTPS) {
        $existing.policies.PSObject.Properties.Remove('DNSOverHTTPS')
        $existing | ConvertTo-Json -Depth 8 | Set-Content -Path $policyPath -Encoding UTF8
      }
    } catch { Remove-Item $policyPath -Force -ErrorAction SilentlyContinue }
  }
  Remove-ItemProperty 'HKLM:\Software\Policies\Mozilla\Firefox' -Name 'DNSOverHTTPS' -ErrorAction SilentlyContinue
}

if ($Action -eq 'Install') {
  New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
  Set-SafeBrowseDataAcl -Path $dataDirectory
  Get-DnsClientServerAddress | Where-Object AddressFamily -in 2,23 | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 $backupPath
  Get-DnsClient | Where-Object InterfaceOperationalStatus -eq 'Up' | ForEach-Object {
    Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ServerAddresses @('127.0.0.1','::1')
  }
  New-Item -Force 'HKLM:\Software\Policies\Microsoft\Edge' | Out-Null
  New-ItemProperty -Force 'HKLM:\Software\Policies\Microsoft\Edge' -Name DnsOverHttpsMode -Value off | Out-Null
  New-Item -Force 'HKLM:\Software\Policies\Google\Chrome' | Out-Null
  New-ItemProperty -Force 'HKLM:\Software\Policies\Google\Chrome' -Name DnsOverHttpsMode -Value off | Out-Null
  Set-FirefoxDohOff
  @(
    @{ Name='Safe Browse - Allow Service DNS UDP'; Protocol='UDP'; Ports=@('53','853'); Action='Allow' },
    @{ Name='Safe Browse - Allow Service DNS TCP'; Protocol='TCP'; Ports=@('53','853'); Action='Allow' },
    @{ Name='Safe Browse - Block direct DNS UDP'; Protocol='UDP'; Ports=@('53','853'); Action='Block' },
    @{ Name='Safe Browse - Block direct DNS TCP'; Protocol='TCP'; Ports=@('53','853'); Action='Block' }
  ) | ForEach-Object {
    Remove-NetFirewallRule -DisplayName $_.Name -ErrorAction SilentlyContinue
    if ($_.Action -eq 'Allow') {
      New-NetFirewallRule -DisplayName $_.Name -Direction Outbound -Action Allow -Protocol $_.Protocol -RemotePort $_.Ports -Program $serviceExe | Out-Null
    } else {
      New-NetFirewallRule -DisplayName $_.Name -Direction Outbound -Action Block -Protocol $_.Protocol -RemotePort $_.Ports | Out-Null
    }
  }
} else {
  if (Test-Path $backupPath) {
    Get-Content $backupPath -Raw | ConvertFrom-Json | ForEach-Object {
      $addresses = @($_.ServerAddresses)
      if ($addresses.Count -gt 0) { Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ServerAddresses $addresses }
      else { Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ResetServerAddresses }
    }
  } else {
    # No backup: reset adapters that still point only at loopback
    Get-DnsClient | Where-Object InterfaceOperationalStatus -eq 'Up' | ForEach-Object {
      $servers = @(Get-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv4 | Select-Object -ExpandProperty ServerAddresses)
      if ($servers -contains '127.0.0.1' -and $servers.Count -le 2) {
        Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ResetServerAddresses
      }
    }
  }
  Remove-ItemProperty 'HKLM:\Software\Policies\Microsoft\Edge' -Name DnsOverHttpsMode -ErrorAction SilentlyContinue
  Remove-ItemProperty 'HKLM:\Software\Policies\Google\Chrome' -Name DnsOverHttpsMode -ErrorAction SilentlyContinue
  Remove-FirefoxDohPolicy
  Remove-NetFirewallRule -DisplayName 'Safe Browse - Allow Service DNS UDP' -ErrorAction SilentlyContinue
  Remove-NetFirewallRule -DisplayName 'Safe Browse - Allow Service DNS TCP' -ErrorAction SilentlyContinue
  Remove-NetFirewallRule -DisplayName 'Safe Browse - Block direct DNS UDP' -ErrorAction SilentlyContinue
  Remove-NetFirewallRule -DisplayName 'Safe Browse - Block direct DNS TCP' -ErrorAction SilentlyContinue
}
