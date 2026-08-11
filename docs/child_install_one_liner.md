# Child PC install (verified — no Git)

Lab-tested on `win11-vm` (Windows 11) against **https://safebrowse.incorpify.in**.

## Parent first

1. https://safebrowse.incorpify.in → Sign up / Log in  
2. Add child → categories → **Generate setup code**  
3. Code format: `ABCD-EFGH-JKMN`  
4. **Valid 24 hours**, single-use; regenerate anytime  

## Recommended: one elevated PowerShell script

**Run as Administrator** on the child PC:

```powershell
$env:SAFE_BROWSE_ENROLL = 'PASTE-YOUR-CODE-HERE'
irm https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/Install.ps1 | iex
```

Or download-then-run (parameters work reliably):

```powershell
irm https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/Install.ps1 -OutFile $env:TEMP\sb-install.ps1
powershell -ExecutionPolicy Bypass -File $env:TEMP\sb-install.ps1 -EnrollCode 'PASTE-YOUR-CODE-HERE'
```

### What Install.ps1 does (order matters)

1. Download MSI from R2 (~143 MB)  
2. Quiet install (`msiexec /qn` — **no wizard UI**)  
3. Write production API URL  
4. Start **Safe Browse Protection**  
5. **Enroll** (needs public internet)  
6. Harden DNS last; if `127.0.0.1` does not resolve, **restore public DNS** (do not brick the PC)  

### Do not use

```powershell
# BROKEN / fragile — do not paste this
iex "& { $(irm $u) } -EnrollCode 'CODE'"
```

## MSI double-click path

1. Download: https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/SafeBrowseSetup.msi  
2. Double-click → install (SmartScreen may warn). **No custom setup wizard** today.  
3. Enroll with **two** arguments (API + code):

```powershell
& "C:\Program Files\Safe Browse\SafeBrowse.Enroll.exe" "https://safebrowse.incorpify.in/api/v1/device" "PASTE-YOUR-CODE-HERE"
Restart-Service "Safe Browse Protection" -Force
```

**Fixed in 0.1.1.** Earlier builds threw `IndexOutOfRangeException` when given zero or one argument. From 0.1.1 all three forms work:

```powershell
& "C:\Program Files\Safe Browse\SafeBrowse.Enroll.exe"                    # opens a dialog
& "C:\Program Files\Safe Browse\SafeBrowse.Enroll.exe" "YOUR-CODE"
& "C:\Program Files\Safe Browse\SafeBrowse.Enroll.exe" "<apiBaseUrl>" "YOUR-CODE"
```

Pass the API URL only when enrolling against a self-hosted Worker; otherwise the
installed `appsettings.json` already supplies it. Enroll.exe restarts the service
itself, so the explicit `Restart-Service` above is belt-and-braces.

There is also **Start menu → Safe Browse → Link this PC to Safe Browse**, which
opens the same dialog without any command line.

## Verify

```powershell
Get-Service "Safe Browse Protection"
Test-Path C:\ProgramData\SafeBrowse\device.credential
Test-Path C:\ProgramData\SafeBrowse\policy.json
nslookup example.com 127.0.0.1
```

## Restore internet if DNS harden left the PC offline

```powershell
foreach ($n in @(
  'Safe Browse - Allow Service DNS UDP','Safe Browse - Allow Service DNS TCP',
  'Safe Browse - Block direct DNS UDP','Safe Browse - Block direct DNS TCP'
)) { Remove-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue }
Get-NetAdapter | ? Status -eq 'Up' | % {
  Set-DnsClientServerAddress -InterfaceIndex $_.ifIndex -ServerAddresses 1.1.1.1,8.8.8.8
}
Clear-DnsClientCache
```

SSH/RDP by IP still works when names do not resolve.

## Uninstall

```powershell
# Product uninstall via Apps & Features, or:
Get-ItemProperty HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\* |
  Where-Object DisplayName -like '*Safe Browse*' |
  ForEach-Object { msiexec /x $_.PSChildName /qn }

# Reverse harden:
irm https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/configure-protection.ps1 -OutFile $env:TEMP\sb-harden.ps1
powershell -ExecutionPolicy Bypass -File $env:TEMP\sb-harden.ps1 -Action Remove
```
