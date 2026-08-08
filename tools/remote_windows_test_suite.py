#!/usr/bin/env python3
"""
Safe Browse remote Windows deploy + test suite.

Runs over SSH against any Windows 10/11 host with OpenSSH Server.
Supports:
  - deploy: sync source, build, install/update the service binary
  - test:   end-to-end functional checks (service, files, registry, DNS, pipe)
  - all:    deploy then test

Examples:
  python3 tools/remote_windows_test_suite.py --host 192.168.2.156 --action test
  python3 tools/remote_windows_test_suite.py --host 192.168.2.156 --action all
  SAFE_BROWSE_SSH_PASSWORD=... python3 tools/remote_windows_test_suite.py --host <ip> --user <user> --action all
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import shlex
import subprocess
import sys
import tarfile
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

REPO_ROOT = Path(__file__).resolve().parents[1]
WINDOWS_SRC = REPO_ROOT / "apps" / "windows"
REMOTE_SRC = r"C:\Users\{user}\safebrowse-build\safebrowse-windows-src"
INSTALL_DIR = r"C:\Program Files\Safe Browse"
DATA_DIR = r"C:\ProgramData\SafeBrowse"
SERVICE_NAME = "Safe Browse Protection"


@dataclass
class Result:
    name: str
    passed: bool
    detail: str = ""


@dataclass
class SuiteReport:
    results: list[Result] = field(default_factory=list)

    def add(self, name: str, passed: bool, detail: str = "") -> None:
        self.results.append(Result(name, passed, detail))
        mark = "PASS" if passed else "FAIL"
        suffix = f" — {detail}" if detail else ""
        print(f"  [{mark}] {name}{suffix}")

    @property
    def failed(self) -> int:
        return sum(1 for r in self.results if not r.passed)

    @property
    def passed(self) -> int:
        return sum(1 for r in self.results if r.passed)


class Remote:
    def __init__(self, host: str, user: str, password: str, timeout: int = 120):
        self.host = host
        self.user = user
        self.password = password
        self.timeout = timeout

    def _ssh_base(self) -> list[str]:
        return [
            "sshpass",
            "-p",
            self.password,
            "ssh",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
            "-o",
            "ConnectTimeout=20",
            "-o",
            "ServerAliveInterval=10",
            f"{self.user}@{self.host}",
        ]

    def run(self, command: str, timeout: int | None = None) -> tuple[int, str, str]:
        cmd = self._ssh_base() + [command]
        res = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=timeout or self.timeout,
        )
        # Strip OpenSSH host-key warnings; keep the rest of stderr
        # (Windows nslookup often prints NXDOMAIN on stderr).
        stderr_lines = [
            line
            for line in res.stderr.splitlines()
            if "Warning: Permanently added" not in line and "known hosts" not in line
        ]
        stderr = "\n".join(stderr_lines).strip()
        stdout = res.stdout.strip()
        return res.returncode, stdout, stderr

    @staticmethod
    def combined(stdout: str, stderr: str) -> str:
        return "\n".join(part for part in (stdout, stderr) if part)
    def run_ps(self, script: str, timeout: int | None = None) -> tuple[int, str, str]:
        """Run PowerShell via EncodedCommand (UTF-16LE)."""
        encoded = base64.b64encode(script.encode("utf-16le")).decode("ascii")
        return self.run(f"powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand {encoded}", timeout=timeout)

    def scp_to(self, local: Path, remote: str) -> None:
        cmd = [
            "sshpass",
            "-p",
            self.password,
            "scp",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
            str(local),
            f"{self.user}@{self.host}:{remote}",
        ]
        subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300)

    def remote_src(self) -> str:
        return REMOTE_SRC.format(user=self.user)


def package_source(dest_tar: Path) -> None:
    """Create a source tarball excluding bin/obj/artifacts."""
    with tarfile.open(dest_tar, "w:gz") as tar:
        for path in WINDOWS_SRC.rglob("*"):
            if not path.is_file():
                continue
            rel = path.relative_to(WINDOWS_SRC)
            parts = set(rel.parts)
            if parts & {"bin", "obj", "artifacts", ".vs"}:
                continue
            if path.suffix in {".user", ".pdb"} and "bin" in path.parts:
                continue
            tar.add(path, arcname=str(Path("safebrowse-windows-src") / rel))


def force_stop_service(remote: Remote) -> None:
    remote.run(f'net stop "{SERVICE_NAME}"', timeout=30)
    remote.run('taskkill /F /IM SafeBrowse.Service.exe', timeout=20)
    time.sleep(2)


def deploy(remote: Remote) -> None:
    print("\n== Deploy: package source ==")
    with tempfile.TemporaryDirectory() as tmp:
        tar_path = Path(tmp) / "safebrowse-windows-src.tar.gz"
        package_source(tar_path)
        print(f"  Packaged {tar_path.stat().st_size} bytes")
        print("== Deploy: upload ==")
        remote_tar = f"C:/Users/{remote.user}/safebrowse-windows-src.tar.gz"
        remote.scp_to(tar_path, remote_tar)

    print("== Deploy: extract ==")
    extract_ps = rf"""
$ErrorActionPreference = 'Stop'
$root = 'C:\Users\{remote.user}\safebrowse-build'
if (Test-Path $root) {{ Remove-Item $root -Recurse -Force }}
New-Item -ItemType Directory -Path $root -Force | Out-Null
tar -xzf 'C:\Users\{remote.user}\safebrowse-windows-src.tar.gz' -C $root
if (-not (Test-Path (Join-Path $root 'safebrowse-windows-src\SafeBrowse.sln'))) {{ throw 'extract failed' }}
Write-Output 'EXTRACT_OK'
"""
    code, out, err = remote.run_ps(extract_ps, timeout=60)
    if code != 0 or "EXTRACT_OK" not in out:
        raise RuntimeError(f"Extract failed: code={code} out={out} err={err}")

    print("== Deploy: unit tests ==")
    src = remote.remote_src()
    code, out, err = remote.run(
        f'cd /d "{src}" && dotnet test tests\\SafeBrowse.Core.Tests\\SafeBrowse.Core.Tests.csproj -c Release --verbosity minimal',
        timeout=300,
    )
    print(out)
    if code != 0:
        raise RuntimeError(f"Unit tests failed: {err}")

    print("== Deploy: publish service ==")
    code, out, err = remote.run(
        f'cd /d "{src}" && if not exist artifacts mkdir artifacts && '
        f'dotnet publish src\\SafeBrowse.Service\\SafeBrowse.Service.csproj -c Release -r win-x64 --self-contained true -o artifacts\\service',
        timeout=600,
    )
    print(out[-2000:] if len(out) > 2000 else out)
    if code != 0:
        raise RuntimeError(f"Publish failed: {err}")

    # Publish remaining components if present (best-effort for full install dir)
    for name, proj, outdir in [
        ("NativeHost", r"src\SafeBrowse.NativeHost\SafeBrowse.NativeHost.csproj", "native-host"),
        ("Enroll", r"src\SafeBrowse.Enroll\SafeBrowse.Enroll.csproj", "enroll"),
        ("Tray", r"src\SafeBrowse.Tray\SafeBrowse.Tray.csproj", "tray"),
    ]:
        print(f"== Deploy: publish {name} ==")
        code, out, err = remote.run(
            f'cd /d "{src}" && dotnet publish {proj} -c Release -r win-x64 --self-contained true -o artifacts\\{outdir}',
            timeout=600,
        )
        if code != 0:
            print(f"  Warning: {name} publish failed: {err or out}")
        else:
            print(f"  {name} published")

    print("== Deploy: install binaries ==")
    install_ps = rf"""
$ErrorActionPreference = 'Stop'
$src = '{src}'
$install = '{INSTALL_DIR}'
$svc = '{SERVICE_NAME}'

# Stop service (force if needed)
try {{ Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue }} catch {{}}
Start-Sleep -Seconds 1
Get-Process SafeBrowse.Service -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

New-Item -ItemType Directory -Path $install -Force | Out-Null

# Core service
Copy-Item (Join-Path $src 'artifacts\service\SafeBrowse.Service.exe') (Join-Path $install 'SafeBrowse.Service.exe') -Force
Copy-Item (Join-Path $src 'artifacts\service\appsettings.json') (Join-Path $install 'appsettings.json') -Force

# Optional clients
foreach ($pair in @(
  @('artifacts\native-host\SafeBrowse.NativeHost.exe','SafeBrowse.NativeHost.exe'),
  @('artifacts\enroll\SafeBrowse.Enroll.exe','SafeBrowse.Enroll.exe'),
  @('artifacts\tray\SafeBrowse.Tray.exe','SafeBrowse.Tray.exe')
)) {{
  $from = Join-Path $src $pair[0]
  if (Test-Path $from) {{ Copy-Item $from (Join-Path $install $pair[1]) -Force }}
}}

# Native messaging manifests
$nh = Join-Path $src 'native-host'
if (Test-Path $nh) {{
  Copy-Item (Join-Path $nh 'com.incorpify.safebrowse.chromium.json') $install -Force
  Copy-Item (Join-Path $nh 'com.incorpify.safebrowse.firefox.json') $install -Force
}}

# Registry for native messaging (idempotent)
$chromeManifest = Join-Path $install 'com.incorpify.safebrowse.chromium.json'
$firefoxManifest = Join-Path $install 'com.incorpify.safebrowse.firefox.json'
New-Item -Path 'HKLM:\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.incorpify.safebrowse' -Force | Out-Null
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.incorpify.safebrowse' -Name '(default)' -Value $chromeManifest
New-Item -Path 'HKLM:\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.incorpify.safebrowse' -Force | Out-Null
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.incorpify.safebrowse' -Name '(default)' -Value $chromeManifest
New-Item -Path 'HKLM:\SOFTWARE\Mozilla\NativeMessagingHosts\com.incorpify.safebrowse' -Force | Out-Null
Set-ItemProperty -Path 'HKLM:\SOFTWARE\Mozilla\NativeMessagingHosts\com.incorpify.safebrowse' -Name '(default)' -Value $firefoxManifest

# Ensure Windows service exists
$existing = Get-Service -Name $svc -ErrorAction SilentlyContinue
if (-not $existing) {{
  $exe = Join-Path $install 'SafeBrowse.Service.exe'
  New-Service -Name $svc -BinaryPathName "`"$exe`"" -DisplayName $svc -Description 'Local parental-control DNS filtering' -StartupType Automatic | Out-Null
}}

# Seed data directory
New-Item -ItemType Directory -Path '{DATA_DIR}' -Force | Out-Null

Start-Service -Name $svc
Start-Sleep -Seconds 3
$status = (Get-Service -Name $svc).Status
if ($status -ne 'Running') {{ throw "Service not running: $status" }}
Write-Output 'DEPLOY_OK'
"""
    code, out, err = remote.run_ps(install_ps, timeout=120)
    print(out)
    if code != 0 or "DEPLOY_OK" not in out:
        raise RuntimeError(f"Install failed: code={code} out={out} err={err}")
    print("== Deploy complete ==")


def inject_test_policy(remote: Remote) -> None:
    policy_ps = rf"""
$ErrorActionPreference = 'Stop'
$dir = '{DATA_DIR}'
New-Item -ItemType Directory -Path $dir -Force | Out-Null
$policy = @{{
  version = 1
  childId = '00000000-0000-0000-0000-000000000001'
  ageBand = 'age_10_12'
  timezone = 'UTC'
  blockedCategories = @('Anime')
  schedule = @()
  rules = @(
    @{{ domain = 'blocked-test-domain.com'; action = 'block'; expiresAt = $null }},
    @{{ domain = 'allow-override.example'; action = 'allow'; expiresAt = $null }}
  )
  safeSearch = $true
  youtubeRestricted = $true
  paused = $false
  listVersion = 'test'
  updatedAt = (Get-Date).ToUniversalTime().ToString('o')
}} | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText((Join-Path $dir 'policy.json'), $policy)

# Create category list file with comments to test GZip + comment stripping
$listsDir = Join-Path $dir 'lists'
New-Item -ItemType Directory -Path $listsDir -Force | Out-Null
$animeGz = Join-Path $listsDir 'anime.txt.gz'
$rawText = "# Comment line`nblocked-anime-site.test`n"
$bytes = [System.Text.Encoding]::UTF8.GetBytes($rawText)
$ms = New-Object System.IO.MemoryStream
$gz = New-Object System.IO.Compression.GZipStream($ms, [System.IO.Compression.CompressionLevel]::Optimal)
$gz.Write($bytes, 0, $bytes.Length)
$gz.Close()
[System.IO.File]::WriteAllBytes($animeGz, $ms.ToArray())

# Restart service so policy is loaded (force if needed)
$svc = '{SERVICE_NAME}'
try {{ Restart-Service -Name $svc -Force -ErrorAction Stop }}
catch {{
  Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue
  Get-Process SafeBrowse.Service -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Start-Service -Name $svc
}}
Start-Sleep -Seconds 4
Write-Output 'POLICY_OK'
"""
    code, out, err = remote.run_ps(policy_ps, timeout=90)
    if code != 0 or "POLICY_OK" not in out:
        raise RuntimeError(f"Policy inject failed: {out} {err}")


def run_tests(remote: Remote) -> SuiteReport:
    report = SuiteReport()
    print("\n==================================================")
    print(" Safe Browse Remote Windows Test Suite")
    print(f" Target: {remote.user}@{remote.host}")
    print("==================================================\n")

    # 1. Service running
    print("[1] Service status")
    code, out, err = remote.run_ps(f"(Get-Service -Name '{SERVICE_NAME}').Status")
    report.add("Service is Running", code == 0 and out.strip() == "Running", out or err)

    # 2. Binaries present
    print("[2] Installed artifacts")
    files_ps = rf"""
$files = @(
  'SafeBrowse.Service.exe','SafeBrowse.NativeHost.exe','SafeBrowse.Enroll.exe',
  'SafeBrowse.Tray.exe','appsettings.json',
  'com.incorpify.safebrowse.chromium.json','com.incorpify.safebrowse.firefox.json'
)
$missing = @($files | Where-Object {{ -not (Test-Path (Join-Path '{INSTALL_DIR}' $_)) }})
if ($missing.Count -eq 0) {{ 'OK' }} else {{ 'MISSING: ' + ($missing -join ', ') }}
"""
    code, out, err = remote.run_ps(files_ps)
    report.add("Required install files present", code == 0 and out.strip() == "OK", out or err)

    # 3. Registry
    print("[3] Native messaging registry")
    reg_ps = r"""
$c = Get-ItemPropertyValue 'HKLM:\SOFTWARE\Google\Chrome\NativeMessagingHosts\com.incorpify.safebrowse' '(default)' -ErrorAction SilentlyContinue
$e = Get-ItemPropertyValue 'HKLM:\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\com.incorpify.safebrowse' '(default)' -ErrorAction SilentlyContinue
$f = Get-ItemPropertyValue 'HKLM:\SOFTWARE\Mozilla\NativeMessagingHosts\com.incorpify.safebrowse' '(default)' -ErrorAction SilentlyContinue
if ($c -and $e -and $f) { 'OK' } else { "MISSING Chrome=$c Edge=$e Firefox=$f" }
"""
    code, out, err = remote.run_ps(reg_ps)
    report.add("NativeMessagingHosts registry keys", code == 0 and out.strip() == "OK", out or err)

    # 4. DNS listener
    print("[4] DNS listener on 127.0.0.1:53")
    listen_ps = r"""
$lines = netstat -ano | Select-String '127.0.0.1:53'
if ($lines) { 'OK' } else { 'NOT_LISTENING' }
"""
    code, out, err = remote.run_ps(listen_ps)
    report.add("DNS proxy listening on loopback:53", code == 0 and "OK" in out, out or err)

    # Inject policy for filter tests
    print("[5] Inject test policy + category blocklist + restart")
    try:
        inject_test_policy(remote)
        report.add("Test policy and category blocklist injected", True)
    except Exception as ex:
        report.add("Test policy and category blocklist injected", False, str(ex))
        print("\n==================================================")
        print(f" Summary: {report.passed} PASSED, {report.failed} FAILED")
        print("==================================================")
        return report

    # 6. DNS allow
    print("[6] DNS pass-through (example.com)")
    code, out, err = remote.run("nslookup example.com 127.0.0.1", timeout=30)
    text = remote.combined(out, err)
    allow_ok = (
        "Non-authoritative answer" in text
        or ("example.com" in text and "timed out" not in text.lower() and "Non-existent" not in text)
    )
    report.add("DNS pass-through for unblocked domain", allow_ok, text[:400])

    # 7. DNS custom block
    print("[7] DNS block (blocked-test-domain.com)")
    code, out, err = remote.run("nslookup blocked-test-domain.com 127.0.0.1", timeout=30)
    text = remote.combined(out, err)
    block_ok = (
        "Non-existent domain" in text
        or "NXDOMAIN" in text
        or "can't find" in text.lower()
    )
    report.add("DNS NXDOMAIN for custom-blocked domain", block_ok, text[:400])

    # 8. DNS category block
    print("[8] DNS category block (blocked-anime-site.test)")
    code, out, err = remote.run("nslookup blocked-anime-site.test 127.0.0.1", timeout=30)
    text = remote.combined(out, err)
    cat_block_ok = (
        "Non-existent domain" in text
        or "NXDOMAIN" in text
        or "can't find" in text.lower()
    )
    report.add("DNS NXDOMAIN for category-blocked domain", cat_block_ok, text[:400])

    # 9. Named pipe evaluate
    print("[9] Named pipe evaluate")
    pipe_eval_ps = r"""
$ErrorActionPreference = 'Stop'
try {
  $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'safe-browse-native', [System.IO.Pipes.PipeDirection]::InOut)
  $client.Connect(8000)
  $writer = New-Object System.IO.StreamWriter($client); $writer.AutoFlush = $true
  $reader = New-Object System.IO.StreamReader($client)
  $writer.WriteLine('{"action":"evaluate","domain":"blocked-test-domain.com"}')
  $line = $reader.ReadLine()
  $client.Dispose()
  Write-Output $line
} catch {
  Write-Output ("ERROR: " + $_.Exception.Message)
}
"""
    code, out, err = remote.run_ps(pipe_eval_ps, timeout=30)
    eval_ok = '"blocked":true' in out.replace(" ", "") or '"blocked": true' in out
    if not eval_ok:
        eval_ok = "blocked" in out and "true" in out and "custom_block" in out
    report.add("Named pipe evaluate returns custom_block", eval_ok, out[:300] if out else err)

    # 10. Named pipe navigation telemetry
    print("[10] Named pipe navigation telemetry")
    pipe_nav_ps = r"""
$ErrorActionPreference = 'Stop'
try {
  $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'safe-browse-native', [System.IO.Pipes.PipeDirection]::InOut)
  $client.Connect(8000)
  $writer = New-Object System.IO.StreamWriter($client); $writer.AutoFlush = $true
  $reader = New-Object System.IO.StreamReader($client)
  $writer.WriteLine('{"action":"navigation","domain":"wikipedia.org","browser":"chrome"}')
  $line = $reader.ReadLine()
  $client.Dispose()
  Write-Output $line
} catch {
  Write-Output ("ERROR: " + $_.Exception.Message)
}
"""
    code, out, err = remote.run_ps(pipe_nav_ps, timeout=30)
    nav_ok = "wikipedia.org" in out and ("" if "blocked" not in out else "true" not in out.lower())
    report.add("Named pipe navigation telemetry accepted", nav_ok, out[:300] if out else err)

    # 11. Named pipe access request
    print("[11] Named pipe access request")
    pipe_req_ps = r"""
$ErrorActionPreference = 'Stop'
try {
  $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'safe-browse-native', [System.IO.Pipes.PipeDirection]::InOut)
  $client.Connect(8000)
  $writer = New-Object System.IO.StreamWriter($client); $writer.AutoFlush = $true
  $reader = New-Object System.IO.StreamReader($client)
  $writer.WriteLine('{"action":"request","domain":"request-domain.com","category":"Social","reason":"Homework"}')
  $line = $reader.ReadLine()
  $client.Dispose()
  Write-Output $line
} catch {
  Write-Output ("ERROR: " + $_.Exception.Message)
}
"""
    code, out, err = remote.run_ps(pipe_req_ps, timeout=30)
    req_ok = "ok" in out.lower() and "requestid" in out.lower()
    report.add("Named pipe access request enqueued", req_ok, out[:300] if out else err)

    # 12. SafeBrowse.NativeHost stdio protocol
    print("[12] SafeBrowse.NativeHost.exe stdio protocol")
    nh_ps = rf"""
$ErrorActionPreference = 'Stop'
$nhExe = Join-Path '{INSTALL_DIR}' 'SafeBrowse.NativeHost.exe'
$jsonStr = '{{"action":"evaluate","domain":"blocked-test-domain.com"}}'
$jsonBytes = [System.Text.Encoding]::UTF8.GetBytes($jsonStr)
$lenBytes = [System.BitConverter]::GetBytes([int]$jsonBytes.Length)

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $nhExe
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$proc = [System.Diagnostics.Process]::Start($psi)

$proc.StandardInput.BaseStream.Write($lenBytes, 0, 4)
$proc.StandardInput.BaseStream.Write($jsonBytes, 0, $jsonBytes.Length)
$proc.StandardInput.BaseStream.Flush()
$proc.StandardInput.Close()

$respLenBytes = New-Object byte[] 4
$bytesRead = $proc.StandardOutput.BaseStream.Read($respLenBytes, 0, 4)
if ($bytesRead -eq 4) {{
  $respLen = [System.BitConverter]::ToInt32($respLenBytes, 0)
  $respBytes = New-Object byte[] $respLen
  $proc.StandardOutput.BaseStream.Read($respBytes, 0, $respLen) | Out-Null
  $respStr = [System.Text.Encoding]::UTF8.GetString($respBytes)
  Write-Output ("RESP: " + $respStr)
}} else {{
  Write-Output "READ_FAILED"
}}
$proc.WaitForExit(5000)
"""
    code, out, err = remote.run_ps(nh_ps, timeout=30)
    nh_ok = "RESP:" in out and ("custom_block" in out or "blocked" in out)
    report.add("NativeHost stdio protocol relay works", nh_ok, out[:300] if out else err)

    # 13. Named pipe emergency bypass
    print("[13] Named pipe emergency bypass")
    pipe_em_ps = r"""
$ErrorActionPreference = 'Stop'
try {
  $client = New-Object System.IO.Pipes.NamedPipeClientStream('.', 'safe-browse-native', [System.IO.Pipes.PipeDirection]::InOut)
  $client.Connect(8000)
  $writer = New-Object System.IO.StreamWriter($client); $writer.AutoFlush = $true
  $reader = New-Object System.IO.StreamReader($client)
  $writer.WriteLine('{"action":"emergency"}')
  $line = $reader.ReadLine()
  $client.Dispose()
  Write-Output $line
} catch {
  Write-Output ("ERROR: " + $_.Exception.Message)
}
"""
    code, out, err = remote.run_ps(pipe_em_ps, timeout=30)
    em_ok = "ok" in out.lower() and "until" in out.lower()
    report.add("Emergency bypass via named pipe", em_ok, out[:300] if out else err)

    if em_ok:
        print("[14] DNS allow during emergency bypass (example.com still resolves)")
        code, out, err = remote.run("nslookup example.com 127.0.0.1", timeout=30)
        text = remote.combined(out, err)
        still_ok = "timed out" not in text.lower() and ("example.com" in text or "Non-authoritative" in text)
        report.add("DNS still healthy after emergency", still_ok, text[:400])

        print("[15] Blocked domain allowed during emergency (no DNS proxy hang)")
        code, out, err = remote.run("nslookup blocked-test-domain.com 127.0.0.1", timeout=30)
        text = remote.combined(out, err)
        no_hang = "timed out" not in text.lower()
        report.add("No DNS hang after emergency for previously blocked domain", no_hang, text[:400])

    # 16. Protection script toggle check
    print("[16] Protection configuration script (configure-protection.ps1)")
    script_ps = rf"""
$ErrorActionPreference = 'Stop'
$src = '{remote.remote_src()}'
$psScript = Join-Path $src 'scripts\configure-protection.ps1'
if (Test-Path $psScript) {{
  & $psScript -Action Install
  $rules = Get-NetFirewallRule -DisplayName 'Safe Browse*' -ErrorAction SilentlyContinue
  & $psScript -Action Remove
  Write-Output ("SCRIPT_OK RulesCount=" + $rules.Count)
}} else {{
  Write-Output "SCRIPT_NOT_FOUND"
}}
"""
    code, out, err = remote.run_ps(script_ps, timeout=60)
    script_ok = "SCRIPT_OK" in out
    report.add("Protection script Install & Remove executed", script_ok, out or err)

    # 17. Service stop/start health
    print("[17] Service restart health")
    restart_ps = rf"""
$ErrorActionPreference = 'Stop'
$svc = '{SERVICE_NAME}'
$sw = [Diagnostics.Stopwatch]::StartNew()
try {{
  Restart-Service -Name $svc -Force -ErrorAction Stop
}} catch {{
  Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue
  Get-Process SafeBrowse.Service -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  Start-Service -Name $svc
}}
Start-Sleep -Seconds 3
$sw.Stop()
$status = (Get-Service -Name $svc).Status
Write-Output ("STATUS=$status ELAPSED_MS=$($sw.ElapsedMilliseconds)")
"""
    code, out, err = remote.run_ps(restart_ps, timeout=90)
    report.add("Service restarts successfully", code == 0 and "STATUS=Running" in out, out or err)

    # 18. Re-inject policy after restart (emergency cleared) and re-verify block
    print("[18] Post-restart block still works")
    try:
        inject_test_policy(remote)
        code, out, err = remote.run("nslookup blocked-test-domain.com 127.0.0.1", timeout=30)
        text = remote.combined(out, err)
        block_ok = "Non-existent domain" in text or "can't find" in text.lower()
        report.add("Custom block works after restart", block_ok, text[:400])
        code, out, err = remote.run("nslookup example.com 127.0.0.1", timeout=30)
        text = remote.combined(out, err)
        allow_ok = "timed out" not in text.lower() and ("example.com" in text or "Non-authoritative" in text)
        report.add("Pass-through works after restart", allow_ok, text[:400])
    except Exception as ex:
        report.add("Custom block works after restart", False, str(ex))

    print("\n==================================================")
    print(f" Summary: {report.passed} PASSED, {report.failed} FAILED")
    print("==================================================")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="Safe Browse remote Windows deploy + test suite")
    parser.add_argument("--host", default=os.environ.get("SAFE_BROWSE_SSH_HOST", "192.168.2.160"))
    parser.add_argument("--user", default=os.environ.get("SAFE_BROWSE_SSH_USER", "admin"), help="SSH username")
    parser.add_argument(
        "--password",
        default=os.environ.get("SAFE_BROWSE_SSH_PASSWORD", ""),
        help="SSH password (prefer SAFE_BROWSE_SSH_PASSWORD env var)",
    )
    parser.add_argument(
        "--action",
        choices=("deploy", "test", "all"),
        default="test",
        help="deploy=build+install, test=functional suite, all=both",
    )
    args = parser.parse_args()

    remote = Remote(args.host, args.user, args.password)

    # Connectivity check
    print(f"Connecting to {args.user}@{args.host} ...")
    code, out, err = remote.run("echo CONNECTED && whoami && hostname", timeout=30)
    if code != 0 or "CONNECTED" not in out:
        print(f"SSH connection failed: code={code} out={out} err={err}", file=sys.stderr)
        return 2
    print(f"  {out.replace(chr(10), ' | ')}")

    try:
        if args.action in ("deploy", "all"):
            deploy(remote)
        if args.action in ("test", "all"):
            report = run_tests(remote)
            return 0 if report.failed == 0 else 1
    except subprocess.TimeoutExpired as ex:
        print(f"Timeout: {ex}", file=sys.stderr)
        return 3
    except Exception as ex:
        print(f"Fatal: {ex}", file=sys.stderr)
        return 4
    return 0


if __name__ == "__main__":
    sys.exit(main())
