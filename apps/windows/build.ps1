$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$artifacts = Join-Path $root 'artifacts'
dotnet test (Join-Path $root 'tests\SafeBrowse.Core.Tests\SafeBrowse.Core.Tests.csproj') -c Release
@('Service','NativeHost','Enroll','Tray') | ForEach-Object {
  $project = Join-Path $root "src\SafeBrowse.$_\SafeBrowse.$_.csproj"
  $output = Join-Path $artifacts $_.ToLowerInvariant().Replace('nativehost','native-host')
  dotnet publish $project -c Release -r win-x64 --self-contained true -o $output
}
dotnet build (Join-Path $root 'installer\SafeBrowse.Installer.wixproj') -c Release
