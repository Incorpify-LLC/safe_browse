# Child PC install — one command (no Git)

Child machines should **never** need Git or a repo clone.

## Recommended: one-shot PowerShell (elevated)

```powershell
# Install MSI + set production API + harden DNS
irm https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/Install.ps1 | iex
```

With enroll code from the parent console:

```powershell
$u='https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/Install.ps1'
iex "& { $(irm $u) } -EnrollCode 'AB3K-M9NP-Q2VX'"
```

That single script:

1. Downloads `SafeBrowseSetup.msi` from R2  
2. Quiet-installs it  
3. Writes `ApiBaseUrl` → `https://safebrowse.incorpify.in/api/v1/device/`  
4. Runs DNS hardening (system DNS → 127.0.0.1, block direct DNS, disable browser DoH)  
5. Optionally enrolls and restarts the service  

## Alternative: double-click MSI only

[SafeBrowseSetup.msi](https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/latest/SafeBrowseSetup.msi)

Then still run the one-liner (or at least harden + set API) until the next packaged MSI ships with production defaults baked in.

## Parent side (still separate)

1. https://safebrowse.incorpify.in → Sign up / Log in  
2. Add child → Generate setup code  
3. Run the one-liner on the child PC with that code  

## Uninstall

```powershell
# If you still have the release scripts folder:
.\Uninstall-SafeBrowse.ps1

# Or MSI:
msiexec /x SafeBrowseSetup.msi /qn
# and reverse harden if needed:
irm https://pub-2c62cb4c92de4a818a9abc3ff05b4526.r2.dev/releases/0.1.0/configure-protection.ps1 -OutFile $env:TEMP\sb-harden.ps1
powershell -ExecutionPolicy Bypass -File $env:TEMP\sb-harden.ps1 -Action Remove
```
