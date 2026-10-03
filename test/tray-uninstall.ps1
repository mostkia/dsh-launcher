# Regression test for tray/uninstall.ps1.
#
# Everything happens in scratch locations: a scratch install directory, a scratch
# .lnk, a scratch registry key and a scratch tray process. The guards in
# uninstall.ps1 are what makes that possible - and this suite is what proves the
# guards work, because a test that could delete a real installation would be worse
# than no test at all.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File test\tray-uninstall.ps1
#
# Cases:
#   1. -DryRun changes nothing (files, shortcut and registry value all survive)
#   2. a real run removes the install directory, the shortcut and the value
#   3. -KeepState keeps state\ (the tray and console logs) and removes the rest
#   4. a second run is harmless (nothing left to do, exit 0)
#   5. a running tray started from that directory is stopped, its files go with it,
#      and the DSH it supervised keeps running
#   6. a shortcut and a value that point somewhere else are reported, never removed
[CmdletBinding()]
param(
    # A port of its own: the supervision suite runs first in the same CI job and
    # leaves a fake DSH behind for a few seconds, so sharing its port would make
    # this suite fail on a leftover instead of on its own behaviour.
    [int]$TrayPort = 3598
)

$ErrorActionPreference = 'Stop'
$script:Failures = 0
function Assert([string]$label, [bool]$ok, [string]$detail = '') {
    if ($ok) { Write-Host ('  PASS  ' + $label) } else { Write-Host ('  FAIL  ' + $label + $(if ($detail) { '  -> ' + $detail } else { '' })); $script:Failures++ }
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $here
$traySource = Join-Path $repo 'tray'
$uninstaller = Join-Path $traySource 'uninstall.ps1'
if (-not (Test-Path -LiteralPath $uninstaller)) { Write-Host ('uninstaller not found: ' + $uninstaller); exit 2 }

$work = Join-Path $env:TEMP ('dsh-launcher-uninstall-test-' + $PID)
$scratchKey = 'Software\DSH-Launcher-UninstallTest-' + $PID
$runKey = [Microsoft.Win32.Registry]::CurrentUser

function Invoke-Uninstaller([string[]]$Extra) {
    $args = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $uninstaller) + $Extra
    $output = & powershell.exe @args 2>&1 | Out-String
    return @{ code = $LASTEXITCODE; output = $output }
}

# Liveness of the supervised child is checked through its listening port: process
# command lines are brittle to match (spacing, quoting), a listening socket is not.
function Test-PortUp([int]$port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try { $client.Connect('127.0.0.1', $port); return $true } catch { return $false } finally { $client.Close() }
}
function Wait-PortFree([int]$port, [int]$seconds) {
    for ($i = 0; $i -lt $seconds * 2; $i++) { if (-not (Test-PortUp $port)) { return $true }; Start-Sleep -Milliseconds 500 }
    return (-not (Test-PortUp $port))
}

# "Is the tray running" is asked through its single-instance mutex rather than by
# scanning command lines: the mutex is what actually keeps a second tray out, and it
# works on hosts where process command lines are not readable.
function Test-TrayRunning([int]$port) {
    $mutex = New-Object System.Threading.Mutex($false, ('Local\dsh-tray-launcher-' + $port))
    $free = $mutex.WaitOne(0)
    if ($free) { [void]$mutex.ReleaseMutex() }
    $mutex.Dispose()
    return (-not $free)
}

# Build a scratch installation that looks like the real one.
function New-ScratchInstall([string]$name, [switch]$WithShortcut, [string]$ShortcutTarget) {
    $dir = Join-Path $work $name
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    Copy-Item (Join-Path $traySource 'dsh-launcher-tray.ps1') $dir -Force
    Copy-Item (Join-Path $traySource 'dsh-launcher-tray.strings.txt') $dir -Force
    Copy-Item (Join-Path $traySource 'dsh-launcher-tray.vbs') $dir -Force
    Copy-Item (Join-Path $traySource 'dsh-whale.ico') $dir -Force
    New-Item -ItemType Directory -Force -Path (Join-Path $dir 'state') | Out-Null
    [System.IO.File]::WriteAllText((Join-Path $dir 'state\dsh-tray.log'), 'scratch log', (New-Object System.Text.UTF8Encoding($false)))
    $vbs = Join-Path $dir 'dsh-launcher-tray.vbs'
    $json = [ordered]@{ name = 'dsh-launcher-tray'; version = 'test'; wscript = (Join-Path $env:SystemRoot 'System32\wscript.exe'); vbs = $vbs; trayPs1 = (Join-Path $dir 'dsh-launcher-tray.ps1'); ico = (Join-Path $dir 'dsh-whale.ico'); dir = $env:USERPROFILE; port = $TrayPort }
    [System.IO.File]::WriteAllText((Join-Path $dir 'install.json'), ($json | ConvertTo-Json -Depth 4), (New-Object System.Text.UTF8Encoding($false)))
    $lnk = ''
    if ($WithShortcut) {
        $lnk = Join-Path $dir 'test shortcut.lnk'
        $shell = New-Object -ComObject WScript.Shell
        $link = $shell.CreateShortcut($lnk)
        $link.TargetPath = (Join-Path $env:SystemRoot 'System32\wscript.exe')
        $link.Arguments = '"' + $(if ($ShortcutTarget) { $ShortcutTarget } else { $vbs }) + '"'
        $link.IconLocation = (Join-Path $dir 'dsh-whale.ico') + ',0'
        $link.Save()
    }
    return @{ dir = $dir; lnk = $lnk; vbs = $vbs }
}

function Set-ScratchRunValue([string]$value) {
    $key = $runKey.CreateSubKey($scratchKey)
    $key.SetValue('TestLauncher', $value, [Microsoft.Win32.RegistryValueKind]::String)
    $key.Close()
}
function Get-ScratchRunValue() {
    try { $key = $runKey.OpenSubKey($scratchKey); if ($null -eq $key) { return $null }; $v = $key.GetValue('TestLauncher'); $key.Close(); return $v } catch { return $null }
}

New-Item -ItemType Directory -Force -Path $work | Out-Null
$common = @{ InstallDir = ''; ShortcutPath = ''; RunKeyPath = $scratchKey; RunValueName = 'TestLauncher' }
Write-Host ('work: ' + $work)
Write-Host ('scratch registry key: HKCU\' + $scratchKey)

try {
    # ---------------------------------------------------------------- case 1
    Write-Host '== case 1: -DryRun changes nothing =='
    $s = New-ScratchInstall 'dry' -WithShortcut
    Set-ScratchRunValue ('"' + (Join-Path $env:SystemRoot 'System32\wscript.exe') + '" "' + $s.vbs + '"')
    $r = Invoke-Uninstaller (@('-InstallDir', $s.dir, '-ShortcutPath', $s.lnk, '-RunKeyPath', $scratchKey, '-RunValueName', 'TestLauncher', '-DryRun'))
    Assert 'dry run reports success' ($r.code -eq 0) ('exit=' + $r.code)
    Assert 'dry run kept the install directory' (Test-Path -LiteralPath (Join-Path $s.dir 'dsh-launcher-tray.ps1'))
    Assert 'dry run kept the shortcut' (Test-Path -LiteralPath $s.lnk)
    Assert 'dry run kept the registry value' ((Get-ScratchRunValue) -like ('*' + $s.vbs + '*'))

    # ---------------------------------------------------------------- case 2
    Write-Host '== case 2: a real run removes everything that belongs to it =='
    $r = Invoke-Uninstaller (@('-InstallDir', $s.dir, '-ShortcutPath', $s.lnk, '-RunKeyPath', $scratchKey, '-RunValueName', 'TestLauncher'))
    Assert 'real run reports success' ($r.code -eq 0) ('exit=' + $r.code + ' out=' + $r.output.Trim())
    Assert 'install directory is gone' (-not (Test-Path -LiteralPath $s.dir))
    Assert 'shortcut is gone' (-not (Test-Path -LiteralPath $s.lnk))
    Assert 'registry value is gone' ($null -eq (Get-ScratchRunValue))

    # ---------------------------------------------------------------- case 3
    Write-Host '== case 3: -KeepState keeps the logs =='
    $s3 = New-ScratchInstall 'keepstate'
    $r = Invoke-Uninstaller (@('-InstallDir', $s3.dir, '-ShortcutPath', (Join-Path $s3.dir 'none.lnk'), '-RunKeyPath', $scratchKey, '-RunValueName', 'TestLauncher', '-KeepState'))
    Assert 'keep-state reports success' ($r.code -eq 0) ('exit=' + $r.code)
    Assert 'state\ survived' (Test-Path -LiteralPath (Join-Path $s3.dir 'state\dsh-tray.log'))
    Assert 'the tray scripts are gone' (-not (Test-Path -LiteralPath (Join-Path $s3.dir 'dsh-launcher-tray.ps1')))
    Assert 'install.json is gone' (-not (Test-Path -LiteralPath (Join-Path $s3.dir 'install.json')))

    # ---------------------------------------------------------------- case 4
    Write-Host '== case 4: a second run is harmless =='
    $r = Invoke-Uninstaller (@('-InstallDir', $s3.dir, '-ShortcutPath', (Join-Path $s3.dir 'none.lnk'), '-RunKeyPath', $scratchKey, '-RunValueName', 'TestLauncher', '-KeepState'))
    Assert 'second run reports success' ($r.code -eq 0) ('exit=' + $r.code)
    # With -KeepState the directory stays behind for its logs, so the second run may
    # legitimately say either that it is absent or that it was kept for the logs.
    Assert 'second run finds nothing left to remove' ($r.output -match '(install directory: (not present|removed))|(install directory kept for its logs)') $r.output.Trim()

    # ---------------------------------------------------------------- case 5
    Write-Host '== case 5: a running tray is stopped, its DSH keeps running =='
    $s5 = New-ScratchInstall 'running'
    $fakeBin = Join-Path $work 'fakebin'
    New-Item -ItemType Directory -Force -Path $fakeBin | Out-Null
    Copy-Item (Join-Path $here 'fake-dsh.mjs') $fakeBin -Force
    # The fake DSH listens on the scratch port, which is how this test tells whether
    # the supervised child survived the uninstall.
    $fakeDsh = "@echo off`r`nnode `"%~dp0fake-dsh.mjs`" --port $TrayPort`r`n"
    [System.IO.File]::WriteAllText((Join-Path $fakeBin 'dsh.cmd'), $fakeDsh, (New-Object System.Text.UTF8Encoding($false)))
    $env:PATH = $fakeBin + ';' + $env:PATH
    Assert 'the scratch port is free before the tray starts' (Wait-PortFree $TrayPort 30)
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', (Join-Path $s5.dir 'dsh-launcher-tray.ps1'), '-Headless', '-Port', $TrayPort, '-Dir', $work, '-StateDir', (Join-Path $s5.dir 'state'), '-AutoExitSeconds', '180') -WindowStyle Hidden | Out-Null
    $trayUp = $false
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        $trayUp = Test-TrayRunning $TrayPort
        if ($trayUp) { break }
    }
    Assert 'the scratch tray is running before the uninstall' $trayUp
    $childUp = $false
    for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 500; if (Test-PortUp $TrayPort) { $childUp = $true; break } }
    Assert 'its fake DSH child is listening on the scratch port' $childUp
    $r = Invoke-Uninstaller (@('-InstallDir', $s5.dir, '-ShortcutPath', (Join-Path $s5.dir 'none.lnk'), '-RunKeyPath', $scratchKey, '-RunValueName', 'TestLauncher'))
    Assert 'uninstall with a running tray reports success' ($r.code -eq 0) ('exit=' + $r.code + ' out=' + $r.output.Trim())
    $trayGone = $false
    for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 500; if (-not (Test-TrayRunning $TrayPort)) { $trayGone = $true; break } }
    Assert 'the tray is gone (its mutex was released)' $trayGone
    Assert 'its files could be removed (so the log handle was released)' (-not (Test-Path -LiteralPath $s5.dir))
    Assert 'the DSH it supervised is still listening' (Test-PortUp $TrayPort)

    # ---------------------------------------------------------------- case 6
    Write-Host '== case 6: entries pointing elsewhere are left alone =='
    $s6 = New-ScratchInstall 'guards'
    $other = Join-Path $work 'somewhere-else.vbs'
    [System.IO.File]::WriteAllText($other, "' not ours", (New-Object System.Text.UTF8Encoding($false)))
    $lnk6 = Join-Path $work 'other shortcut.lnk'
    $shell = New-Object -ComObject WScript.Shell
    $link6 = $shell.CreateShortcut($lnk6)
    $link6.TargetPath = (Join-Path $env:SystemRoot 'System32\wscript.exe')
    $link6.Arguments = '"' + $other + '"'
    $link6.Save()
    Set-ScratchRunValue ('"C:\Windows\System32\wscript.exe" "' + $other + '"')
    $r = Invoke-Uninstaller (@('-InstallDir', $s6.dir, '-ShortcutPath', $lnk6, '-RunKeyPath', $scratchKey, '-RunValueName', 'TestLauncher'))
    Assert 'guard run reports success' ($r.code -eq 0) ('exit=' + $r.code)
    Assert 'the foreign shortcut is untouched' (Test-Path -LiteralPath $lnk6)
    Assert 'the foreign registry value is untouched' ((Get-ScratchRunValue) -like ('*' + $other + '*'))
    Assert 'the installed directory is still removed' (-not (Test-Path -LiteralPath $s6.dir))
} finally {
    try { $runKey.DeleteSubKeyTree($scratchKey, $false) } catch { }
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and ($_.CommandLine -like ('*' + $work + '*')) } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } catch { } }
    Start-Sleep -Milliseconds 500
    Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

if ($script:Failures -eq 0) { Write-Host 'TRAY UNINSTALL TEST PASS'; exit 0 }
Write-Host ('TRAY UNINSTALL TEST FAIL (' + $script:Failures + ' assertion(s))')
exit 1
