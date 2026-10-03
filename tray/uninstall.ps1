# uninstall.ps1 - remove the DSH Launcher tray that install.ps1 put on this machine.
#
# Pure ASCII on purpose (see the README): Windows PowerShell 5.1 decodes a
# BOM-less UTF-8 script as GBK, and the DSH edit tool drops the BOM.
#
# What it does, in order:
#   1. stops the tray process that runs from this install directory (if any).
#      The DSH it supervised keeps running - this script never stops DSH.
#   2. removes the start-at-logon value, but only when it points at this install.
#   3. removes the desktop shortcut, but only when it points at this install.
#   4. removes the install directory (with -KeepState, keeps state\ for its logs).
#
# Everything it touches is guarded by "does it belong to this install", so running
# it with a scratch -InstallDir cannot damage a real installation, and an entry
# that points somewhere else is reported instead of deleted.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File uninstall.ps1
#   uninstall.ps1 -KeepState          keep state\ (tray and console logs)
#   uninstall.ps1 -NoStop             never stop a running tray process
#   uninstall.ps1 -DryRun             report what would happen, change nothing
#
# -InstallDir / -ShortcutPath / -RunKeyPath / -RunValueName exist so the test suite
# can point the whole thing at scratch locations.
[CmdletBinding()]
param(
    [string]$InstallDir = '',
    [string]$ShortcutPath = '',
    [string]$RunKeyPath = 'Software\Microsoft\Windows\CurrentVersion\Run',
    [string]$RunValueName = 'DSHLauncher',
    [switch]$KeepState,
    [switch]$NoStop,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$script:Warnings = @()
function Report([string]$text) { Write-Host ('[uninstall] ' + $text) }
function Warn([string]$text) { Write-Host ('[uninstall] WARNING: ' + $text); $script:Warnings += $text }

if ([string]::IsNullOrWhiteSpace($InstallDir)) { $InstallDir = Join-Path $env:LOCALAPPDATA 'DSH-Launcher' }
if ([string]::IsNullOrWhiteSpace($ShortcutPath)) {
    $ShortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'DSH Launcher.lnk'
}
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)
if ($InstallDir.EndsWith('\')) { $InstallDir = $InstallDir.TrimEnd('\') }

Report ('install directory: ' + $InstallDir)
if ($DryRun) { Report 'dry run: nothing will be changed' }

# ---------------------------------------------------------------- install facts
# install.json records where the tray lives; without it we fall back to the file
# names install.ps1 copies, which is enough for the guards below.
$info = $null
$jsonPath = Join-Path $InstallDir 'install.json'
if (Test-Path -LiteralPath $jsonPath) {
    try { $info = [System.IO.File]::ReadAllText($jsonPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json } catch { $info = $null }
}
$expectedVbs = Join-Path $InstallDir 'dsh-launcher-tray.vbs'
if ($null -ne $info -and ($info.PSObject.Properties.Name -contains 'vbs') -and -not [string]::IsNullOrWhiteSpace([string]$info.vbs)) {
    $expectedVbs = [string]$info.vbs
}

# ------------------------------------------------------------- 1. stop the tray
# Only processes whose command line mentions THIS install directory are touched,
# so a parallel installation (or the user's real one, during a test run) is safe.
if ($NoStop) {
    Report 'not stopping any tray process (-NoStop)'
} else {
    $candidates = @()
    try {
        $candidates = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
            $_.CommandLine -and ($_.CommandLine -like ('*' + $InstallDir + '*')) -and
            ($_.CommandLine -match 'dsh-launcher-tray\.(ps1|vbs)')
        })
    } catch {
        Warn ('could not list processes: ' + $_.Exception.Message)
    }
    if ($candidates.Count -eq 0) {
        Report 'tray process: not running'
    } else {
        foreach ($candidate in $candidates) {
            Report ('stopping tray process ' + $candidate.ProcessId + ' (' + $candidate.Name + ')')
            if (-not $DryRun) {
                try { Stop-Process -Id $candidate.ProcessId -Force -ErrorAction Stop } catch { Warn ('could not stop ' + $candidate.ProcessId + ': ' + $_.Exception.Message) }
            }
        }
        if (-not $DryRun) {
            # Give the stopped processes a moment to release their log handles.
            for ($i = 0; $i -lt 20; $i++) {
                Start-Sleep -Milliseconds 250
                $alive = @(Get-Process -Id ($candidates | ForEach-Object { $_.ProcessId }) -ErrorAction SilentlyContinue)
                if ($alive.Count -eq 0) { break }
            }
        }
    }
}

# ------------------------------------------------------- 2. start-at-logon value
try {
    $runKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($RunKeyPath, (-not $DryRun))
    if ($null -eq $runKey) {
        Report ('start-at-logon: key not readable (' + $RunKeyPath + ')')
    } else {
        try {
            $current = [string]$runKey.GetValue($RunValueName, '')
            if ([string]::IsNullOrWhiteSpace($current)) {
                Report 'start-at-logon: not registered'
            } elseif ($current -like ('*' + $InstallDir + '*')) {
                if (-not $DryRun) { $runKey.DeleteValue($RunValueName, $false) }
                Report 'start-at-logon: removed'
            } else {
                Report ('start-at-logon: left alone, it points elsewhere (' + $current + ')')
            }
        } finally { $runKey.Close() }
    }
} catch {
    Warn ('start-at-logon could not be handled: ' + $_.Exception.Message)
}

# --------------------------------------------------------------- 3. the shortcut
if (-not (Test-Path -LiteralPath $ShortcutPath)) {
    Report 'desktop shortcut: not present'
} else {
    try {
        $shell = New-Object -ComObject WScript.Shell
        $link = $shell.CreateShortcut($ShortcutPath)
        $pointsAtUs = (([string]$link.Arguments) -like ('*' + $InstallDir + '*')) -or
                      (([string]$link.IconLocation) -like ('*' + $InstallDir + '*')) -or
                      (([string]$link.TargetPath) -like ('*' + $InstallDir + '*'))
        if ($pointsAtUs) {
            if (-not $DryRun) { Remove-Item -LiteralPath $ShortcutPath -Force }
            Report 'desktop shortcut: removed'
        } else {
            Report ('desktop shortcut: left alone, it does not point at this install (' + $ShortcutPath + ')')
        }
    } catch {
        Warn ('desktop shortcut could not be handled: ' + $_.Exception.Message)
    }
}

# ----------------------------------------------------------- 4. the install dir
# Never stand inside the tree that is about to be deleted.
Set-Location $env:TEMP
if (-not (Test-Path -LiteralPath $InstallDir)) {
    Report 'install directory: not present'
} else {
    $targets = @(Get-ChildItem -LiteralPath $InstallDir -Force | Where-Object { -not ($KeepState -and $_.Name -eq 'state') })
    foreach ($pass in 1..2) {
        foreach ($target in $targets) {
            if ((-not $DryRun) -and (Test-Path -LiteralPath $target.FullName)) {
                try { Remove-Item -LiteralPath $target.FullName -Recurse -Force -ErrorAction Stop } catch { }
            }
        }
        if ($pass -eq 1) { Start-Sleep -Milliseconds 600 }
    }
    if ($DryRun) {
        Report ('would remove ' + $targets.Count + ' item(s) from the install directory')
    } else {
        $left = @(Get-ChildItem -LiteralPath $InstallDir -Force)
        if ($left.Count -eq 0) {
            try { Remove-Item -LiteralPath $InstallDir -Force -ErrorAction Stop; Report 'install directory: removed' }
            catch { Warn ('install directory could not be removed: ' + $_.Exception.Message) }
        } elseif ($KeepState -and (@($left | Where-Object { $_.Name -ne 'state' }).Count -eq 0)) {
            Report ('install directory kept for its logs: ' + (Join-Path $InstallDir 'state'))
        } else {
            Warn ('some files could not be removed: ' + (($left | ForEach-Object { $_.Name }) -join ', '))
        }
    }
}

# ------------------------------------------------------------------- 5. summary
Report 'the DSH that the tray supervised is still running: stop it with the power button or by closing it'
Report 'to remove the plugin itself: dsh plugin --profile web remove @mostkia/dsh-launcher'
if ($script:Warnings.Count -gt 0) {
    Report ('finished with ' + $script:Warnings.Count + ' warning(s)')
    exit 1
}
Report 'done'
exit 0
