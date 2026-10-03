# install.ps1 - install the DSH Launcher tray into %LOCALAPPDATA%\DSH-Launcher.
#
# Pure ASCII on purpose: Windows PowerShell 5.1 decodes a BOM-less UTF-8 script
# as ANSI/GBK, so no Chinese literal may appear here (install.cmd is ASCII too).
#
# What it does (idempotent - safe to run again for an upgrade):
#   1. Copies dsh-launcher-tray.ps1 / .strings.txt / .vbs / dsh-whale.ico into
#      %LOCALAPPDATA%\DSH-Launcher (created if missing, overwritten if present).
#   2. Writes %LOCALAPPDATA%\DSH-Launcher\install.json - the shared source of
#      truth between this tray and the @mostkia/dsh-launcher plugin host half.
#      Field names (name/version/wscript/vbs/trayPs1/ico/dir/port/installedAt)
#      are a contract: do not rename them.
#   3. Creates or overwrites the desktop shortcut "DSH Launcher.lnk".
#
# It NEVER registers start-at-logon: that stays an explicit user action in the
# tray context menu or the DSH power dialog.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 [-Dir <workdir>] [-Port 3080] [-NoShortcut]

param(
    [string]$Dir = '',
    [int]$Port = 3080,
    [switch]$NoShortcut
)

$ErrorActionPreference = 'Stop'

$Here = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($Here)) { $Here = (Get-Location).Path }
if ([string]::IsNullOrWhiteSpace($Dir)) { $Dir = (Get-Location).Path }

$TargetDir = Join-Path $env:LOCALAPPDATA 'DSH-Launcher'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

Write-Host '[install] DSH Launcher tray'
Write-Host ('[install] source : ' + $Here)
Write-Host ('[install] target : ' + $TargetDir)

if (-not (Test-Path -LiteralPath $TargetDir)) {
    New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null
    Write-Host '[install] created install directory'
}

# ------------------------------------------------------------- copy the files
$Files = @('dsh-launcher-tray.ps1', 'dsh-launcher-tray.strings.txt', 'dsh-launcher-tray.vbs', 'dsh-whale.ico')
foreach ($f in $Files) {
    $src = Join-Path $Here $f
    if (-not (Test-Path -LiteralPath $src)) { throw ('missing source file: ' + $src) }
    Copy-Item -LiteralPath $src -Destination (Join-Path $TargetDir $f) -Force
    Write-Host ('[install] copied ' + $f)
}

# ------------------------------------------------------------- version + paths
$Version = '0.0.0'
try {
    $pkgPath = Join-Path (Split-Path -Parent $Here) 'package.json'
    if (Test-Path -LiteralPath $pkgPath) {
        $pkgText = [System.IO.File]::ReadAllText($pkgPath, [System.Text.Encoding]::UTF8)
        $pkg = $pkgText | ConvertFrom-Json
        if ($null -ne $pkg -and ($pkg.PSObject.Properties.Name -contains 'version')) {
            $v = [string]$pkg.version
            if (-not [string]::IsNullOrWhiteSpace($v)) { $Version = $v }
        }
    }
} catch {
    Write-Warning ('could not read ..\package.json version; using 0.0.0 (' + $_.Exception.Message + ')')
}

$Wscript  = Join-Path $env:SystemRoot 'System32\wscript.exe'
$VbsPath  = Join-Path $TargetDir 'dsh-launcher-tray.vbs'
$Ps1Path  = Join-Path $TargetDir 'dsh-launcher-tray.ps1'
$IcoPath  = Join-Path $TargetDir 'dsh-whale.ico'

# ------------------------------------------------------------- install.json
# Same JSON layout the plugin host half reads (index.js readInstallInfo).
$info = [ordered]@{
    name        = 'dsh-launcher-tray'
    version     = $Version
    wscript     = $Wscript
    vbs         = $VbsPath
    trayPs1     = $Ps1Path
    ico         = $IcoPath
    dir         = $Dir
    port        = $Port
    installedAt = (Get-Date).ToString('o')
}
$jsonPath = Join-Path $TargetDir 'install.json'
$jsonText = ($info | ConvertTo-Json -Depth 4)
[System.IO.File]::WriteAllText($jsonPath, $jsonText, $Utf8NoBom)
Write-Host ('[install] wrote ' + $jsonPath)

# ------------------------------------------------------------- desktop shortcut
$ShortcutCreated = $false
$ShortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'DSH Launcher.lnk'
if ($NoShortcut) {
    Write-Host '[install] -NoShortcut: skipping the desktop shortcut'
} else {
    try {
        $sh = New-Object -ComObject WScript.Shell
        $lnk = $sh.CreateShortcut($ShortcutPath)
        $lnk.TargetPath = $Wscript
        $lnk.Arguments = '"' + $VbsPath + '"'
        $lnk.WorkingDirectory = $Dir
        # Plain "path,index" with no surrounding quotes: the shell parses this form
        # and adds its own quoting when it stores the link. Literal quotes around
        # the path made Explorer fail to resolve the icon and fall back to the
        # generic document icon - the blank desktop shortcut.
        $lnk.IconLocation = $IcoPath + ',0'
        $lnk.Description = 'DSH Launcher (tray)'
        $lnk.Save()
        $ShortcutCreated = $true
        Write-Host ('[install] shortcut: ' + $ShortcutPath)
        # Best effort: nudge the shell to rebuild its icon cache, so the whale shows
        # without a re-login. The icon file name changed as well, which gives the
        # entry a fresh cache key either way.
        try {
            $ie4u = Join-Path $env:SystemRoot 'System32\ie4uinit.exe'
            if (Test-Path -LiteralPath $ie4u) {
                Start-Process -FilePath $ie4u -ArgumentList '-show' -WindowStyle Hidden -ErrorAction SilentlyContinue
            }
        } catch { }
    } catch {
        # Not fatal: install.json is already written, so the plugin half and a
        # manual wscript call both still work.
        Write-Warning ('could not create the desktop shortcut: ' + $_.Exception.Message)
        Write-Warning ('start the tray manually with: wscript.exe "' + $VbsPath + '"')
    }
}

# ------------------------------------------------------------- summary
Write-Host ''
Write-Host '[install] done.'
Write-Host ('  install dir : ' + $TargetDir)
Write-Host ('  install.json: ' + $jsonPath)
Write-Host ('  working dir : ' + $Dir)
Write-Host ('  port        : ' + $Port)
if ($NoShortcut) {
    Write-Host '  shortcut    : skipped (-NoShortcut)'
} elseif ($ShortcutCreated) {
    Write-Host ('  shortcut    : ' + $ShortcutPath)
} else {
    Write-Host '  shortcut    : NOT created (see the warning above)'
}
Write-Host '  start at logon is OFF until you enable it: use the tray context menu'
Write-Host '  "Start at logon" item, or the power dialog switch in the DSH sidebar.'
