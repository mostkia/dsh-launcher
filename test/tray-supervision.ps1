# Regression test for the tray's supervision probe and both restart paths.
#
# The tray decides between a *graceful* restart (ask the plugin, which exits with
# the restart code 42 and the relaunch loop picks it up) and a *forced* one (kill
# the process tree and start again). A wrong decision is invisible in normal use
# until a restart silently does nothing, so it is pinned here.
#
# Runs the tray headless against test/fake-dsh.mjs on a scratch port with a fake
# dsh.cmd on PATH: a real DSH is never started, killed or restarted.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\tray-supervision.ps1
#
# Known sandbox limit: when this runner itself runs inside a confined DSH shell,
# taskkill is denied, so the kill step of the forced path cannot be observed here
# (the fake child exits on its own instead). Everything else is asserted.
[CmdletBinding()]
param(
    [int]$Port = 3599,
    [string]$TrayPath = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $here
if ([string]::IsNullOrWhiteSpace($TrayPath)) { $TrayPath = Join-Path $repo 'tray\dsh-launcher-tray.ps1' }
if (-not (Test-Path -LiteralPath $TrayPath)) { Write-Host "tray script not found: $TrayPath"; exit 2 }

$work = Join-Path $env:TEMP ('dsh-launcher-traytest-' + $PID)
New-Item -ItemType Directory -Force -Path $work | Out-Null
Copy-Item (Join-Path $here 'fake-dsh.mjs') (Join-Path $work 'fake-dsh.mjs') -Force
$cmdText = "@echo off`r`necho CALL %* >> `"%~dp0calls.log`"`r`nnode `"%~dp0fake-dsh.mjs`" %*`r`n"
[System.IO.File]::WriteAllText((Join-Path $work 'dsh.cmd'), $cmdText, (New-Object System.Text.UTF8Encoding($false)))
$env:PATH = $work + ';' + $env:PATH

$script:Failures = 0
function Assert([string]$label, [bool]$ok) {
    if ($ok) { Write-Host ('  PASS  ' + $label) } else { Write-Host ('  FAIL  ' + $label); $script:Failures++ }
}

# The tray only manages a child when it owns the port. A leftover child from an
# earlier run (or any other listener) makes it take the already-serving branch, so
# every assertion below would fail for a reason that has nothing to do with the
# code. Wait for the port instead, and say so when it never frees up.
function Test-PortFree([int]$port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect('127.0.0.1', $port)
        return $false
    } catch {
        return $true
    } finally {
        $client.Close()
    }
}

$waited = 0
while (-not (Test-PortFree $Port)) {
    if ($waited -ge 60) {
        Write-Host ('port ' + $Port + ' is still in use after ' + $waited + 's; something else is listening there')
        Write-Host 'TRAY SUPERVISION TEST FAIL (precondition); work dir kept: ' + $work
        exit 1
    }
    if ($waited -eq 0) { Write-Host ('waiting for port ' + $Port + ' to become free ...') }
    Start-Sleep -Seconds 2
    $waited += 2
}

function Run-Case([string]$mode) {
    Write-Host ('== case: ' + $mode + ' ==')
    Remove-Item (Join-Path $work 'requests.log') -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $work 'calls.log') -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $work 'state') -Recurse -Force -ErrorAction SilentlyContinue
    [System.IO.File]::WriteAllText((Join-Path $work 'mode.txt'), $mode, (New-Object System.Text.UTF8Encoding($false)))
    $out = & powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File $TrayPath -Headless -Port $Port `
        -Dir $env:USERPROFILE -StateDir (Join-Path $work 'state') -TestRestartSeconds 4 -AutoExitSeconds 26 2>&1
    $stdout = ($out | Out-String)
    $requests = ''
    $requestLog = Join-Path $work 'requests.log'
    if (Test-Path -LiteralPath $requestLog) { $requests = [System.IO.File]::ReadAllText($requestLog) }
    $trayLog = ''
    $trayLogPath = Join-Path $work 'state\dsh-tray.log'
    if (Test-Path -LiteralPath $trayLogPath) { $trayLog = [System.IO.File]::ReadAllText($trayLogPath, [System.Text.Encoding]::UTF8) }
    $calls = @()
    $callsPath = Join-Path $work 'calls.log'
    if (Test-Path -LiteralPath $callsPath) { $calls = @(Get-Content -LiteralPath $callsPath) }

    if ($mode -eq 'supervised') {
        Assert 'tray chose the graceful path' ($stdout -match 'self-test restart -> plugin')
        Assert 'the restart endpoint was called' ($requests -match 'POST /_dsh-launcher/restart')
        Assert 'the tray logged the endpoint restart' ($trayLog -match 'restart requested through /_dsh-launcher/restart')
        Assert 'exit code 42 relaunched the child' ($stdout -match 'exit code 42 -> relaunching')
        Assert 'the child was started twice' ($calls.Count -eq 2)
    } else {
        Assert 'tray refused the endpoint and forced' ($stdout -match 'self-test restart -> forced')
        Assert 'the restart endpoint was NOT called' (-not ($requests -match 'POST /_dsh-launcher/restart'))
        Assert 'the tray logged why it refused' ($trayLog -match 'child not supervised; forcing a restart')
        Assert 'the child was replaced by a new one' ($calls.Count -eq 2)
    }
}

try {
    Write-Host ('tray : ' + $TrayPath)
    Write-Host ('port : ' + $Port + '  work: ' + $work)
    Run-Case 'supervised'
    Run-Case 'unsupervised'
} finally {
    if ($script:Failures -eq 0) {
        Write-Host 'TRAY SUPERVISION TEST PASS'
        Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
        exit 0
    }
    Write-Host ('TRAY SUPERVISION TEST FAIL (' + $script:Failures + ' assertion(s)); work dir kept: ' + $work)
    exit 1
}
