param([ValidateSet('Install','Remove')] [string]$Action)
$ErrorActionPreference = 'Stop'
$dataDirectory = Join-Path $env:ProgramData 'SafeBrowse'
$backupPath = Join-Path $dataDirectory 'dns-backup.json'

if ($Action -eq 'Install') {
  New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
  Get-DnsClientServerAddress | Where-Object AddressFamily -in 2,23 | ConvertTo-Json -Depth 4 | Set-Content -Encoding UTF8 $backupPath
  Get-DnsClient | Where-Object InterfaceOperationalStatus -eq 'Up' | ForEach-Object {
    Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ServerAddresses @('127.0.0.1','::1')
  }
  New-Item -Force 'HKLM:\Software\Policies\Microsoft\Edge' | Out-Null
  New-ItemProperty -Force 'HKLM:\Software\Policies\Microsoft\Edge' -Name DnsOverHttpsMode -Value off | Out-Null
  New-Item -Force 'HKLM:\Software\Policies\Google\Chrome' | Out-Null
  New-ItemProperty -Force 'HKLM:\Software\Policies\Google\Chrome' -Name DnsOverHttpsMode -Value off | Out-Null
  @(
    @{ Name='Safe Browse - Block direct DNS UDP'; Protocol='UDP'; Ports='53,853' },
    @{ Name='Safe Browse - Block direct DNS TCP'; Protocol='TCP'; Ports='53,853' }
  ) | ForEach-Object {
    Remove-NetFirewallRule -DisplayName $_.Name -ErrorAction SilentlyContinue
    New-NetFirewallRule -DisplayName $_.Name -Direction Outbound -Action Block -Protocol $_.Protocol -RemotePort $_.Ports | Out-Null
  }
} else {
  if (Test-Path $backupPath) {
    Get-Content $backupPath -Raw | ConvertFrom-Json | ForEach-Object {
      $addresses = @($_.ServerAddresses)
      if ($addresses.Count -gt 0) { Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ServerAddresses $addresses }
      else { Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ResetServerAddresses }
    }
  }
  Remove-ItemProperty 'HKLM:\Software\Policies\Microsoft\Edge' -Name DnsOverHttpsMode -ErrorAction SilentlyContinue
  Remove-ItemProperty 'HKLM:\Software\Policies\Google\Chrome' -Name DnsOverHttpsMode -ErrorAction SilentlyContinue
  Remove-NetFirewallRule -DisplayName 'Safe Browse - Block direct DNS UDP' -ErrorAction SilentlyContinue
  Remove-NetFirewallRule -DisplayName 'Safe Browse - Block direct DNS TCP' -ErrorAction SilentlyContinue
}
