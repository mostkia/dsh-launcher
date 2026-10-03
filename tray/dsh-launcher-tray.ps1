# dsh-launcher-tray.ps1 - DSH tray launcher / supervisor (Windows PowerShell 5.1 + WinForms)
#
# Port of the proven tool\dsh-launcher\dsh-tray.ps1 into the @mostkia/dsh-launcher
# plugin package. The external "launcher" concept is gone: this tray ALWAYS runs
# `cmd /c dsh web --port <port>` itself (working directory = -Dir) and owns the
# "exit code 42 -> relaunch" protocol.
#
# This file is PURE ASCII ON PURPOSE. Windows PowerShell 5.1 decodes a BOM-less
# UTF-8 script as ANSI/GBK, so any Chinese literal in a .ps1 is a syntax hazard
# here - and the DSH edit tool drops a UTF-8 BOM. All user-visible Chinese lives
# in dsh-launcher-tray.strings.txt, which is read explicitly as UTF-8 at runtime.
#
# What it does:
#   1. Starts `dsh web` with no console window, with DSH_LAUNCHER_SUPERVISED=1 in
#      the child environment, so the plugin's POST /_dsh-launcher/restart is
#      allowed to exit with 42 and this tray relaunches it.
#   2. Captures everything dsh prints, keeps it in memory and appends it to a log.
#   3. Lives in the notification area: double-click the icon (or use the menu)
#      to read that console output in a window.
#   4. Owns the "start at logon" registration (HKCU ...\Run, value name
#      DSHLauncher - the exact value name the plugin side uses, so the tray menu
#      and the DSH power dialog always show the same state).
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -File dsh-launcher-tray.ps1
#   Debug: -Headless (no UI, echo the output to the console)
#          -ShowWindowOnStart, -AutoExitSeconds N, -TestRestartSeconds N, -TestAutoStart
#
# Defaults: -Dir / -Port come from %LOCALAPPDATA%\DSH-Launcher\install.json (written
# by install.ps1) and fall back to $env:USERPROFILE and 3080.

param(
    [string]$Dir = '',
    [int]$Port = 0,
    [string]$StateDir = '',
    [string]$StringsFile = '',
    [switch]$Headless,
    [switch]$ShowWindowOnStart,
    [int]$AutoExitSeconds = 0,
    [int]$TestRestartSeconds = 0,
    [switch]$TestAutoStart
)

$ErrorActionPreference = 'Continue'
# No progress bar anywhere: Invoke-WebRequest writes its progress through the
# host, and when the tray runs without a usable console (Task Scheduler, a hidden
# runner, a piped stdout) that write fails with "Access is denied while reading
# the console output buffer" - the request is then reported as failed even though
# the server received it, which silently turns a graceful restart into a forced
# one. Silencing progress removes that whole failure mode.
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace DshTray -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
'@

# ------------------------------------------------------- install facts (JSON)
# install.json is the single source of truth shared with the plugin host half.
# It is optional: a hand-copied tray folder still runs on the fallbacks below.
$script:InstallDir  = Join-Path $env:LOCALAPPDATA 'DSH-Launcher'
$script:InstallJson = Join-Path $script:InstallDir 'install.json'
$script:InstallInfo = $null
function Read-InstallInfo {
    try {
        if (-not (Test-Path -LiteralPath $script:InstallJson)) { return $null }
        $text = [System.IO.File]::ReadAllText($script:InstallJson, [System.Text.Encoding]::UTF8)
        if ([string]::IsNullOrWhiteSpace($text)) { return $null }
        return ($text | ConvertFrom-Json)
    } catch { return $null }
}
$script:InstallInfo = Read-InstallInfo

if ([string]::IsNullOrWhiteSpace($Dir)) {
    $d = ''
    try {
        if ($null -ne $script:InstallInfo -and ($script:InstallInfo.PSObject.Properties.Name -contains 'dir')) {
            $d = [string]$script:InstallInfo.dir
        }
    } catch { }
    if ([string]::IsNullOrWhiteSpace($d)) { $d = $env:USERPROFILE }
    $Dir = $d
}
if ($Port -le 0) {
    $p = 0
    try {
        if ($null -ne $script:InstallInfo -and ($script:InstallInfo.PSObject.Properties.Name -contains 'port')) {
            $p = [int]$script:InstallInfo.port
        }
    } catch { $p = 0 }
    if ($p -le 0) { $p = 3080 }
    $Port = $p
}
if ([string]::IsNullOrWhiteSpace($StateDir)) { $StateDir = Join-Path $script:InstallDir 'state' }

# ---------------------------------------------------------------- UI strings
$script:S = @{}
function Get-UiStrings([string]$path) {
    $map = @{}
    if (-not (Test-Path -LiteralPath $path)) { return $map }
    try {
        $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)
        foreach ($line in ($text -split "`r?`n")) {
            $t = $line.Trim()
            if ($t.Length -eq 0 -or $t.StartsWith('#')) { continue }
            $i = $t.IndexOf('=')
            if ($i -lt 1) { continue }
            $map[$t.Substring(0, $i).Trim()] = $t.Substring($i + 1)
        }
    } catch { }
    return $map
}
if ([string]::IsNullOrWhiteSpace($StringsFile)) { $StringsFile = Join-Path $PSScriptRoot 'dsh-launcher-tray.strings.txt' }
$script:S = Get-UiStrings $StringsFile
function T([string]$key) {
    if ($script:S.ContainsKey($key)) { return $script:S[$key] }
    return $key
}

# ---------------------------------------------------------------- supervisor (C#)
# C# owns the child process and the redirected streams: .NET events run on
# thread-pool threads, which avoids the "no runspace available" problem a
# PowerShell script-block handler would hit. The UI only polls this buffer from
# a WinForms timer, i.e. always on the UI thread.
$csharp = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

public class DshSupervisor
{
    private Process proc;
    private StreamWriter log;
    private readonly StringBuilder sb = new StringBuilder();
    private readonly object gate = new object();
    private long baseIndex = 0;
    private Encoding legacy;
    private const int MaxChars = 2000000;
    private const int TrimChars = 1000000;

    public long Length { get { lock (gate) { return baseIndex + sb.Length; } } }

    public string ReadFrom(long index, out long next)
    {
        lock (gate)
        {
            long end = baseIndex + sb.Length;
            if (index < baseIndex) index = baseIndex;
            if (index > end) index = end;
            next = end;
            return sb.ToString((int)(index - baseIndex), (int)(end - index));
        }
    }

    public bool Running
    {
        get { try { return proc != null && !proc.HasExited; } catch { return false; } }
    }

    public int ExitCode
    {
        get { try { return (proc != null && proc.HasExited) ? proc.ExitCode : -1; } catch { return -1; } }
    }

    public int ProcId
    {
        get { try { return proc != null ? proc.Id : 0; } catch { return 0; } }
    }

    public void Start(string exe, string args, string logPath, int codePage, string workingDir, string envName, string envValue)
    {
        ProcessStartInfo psi = new ProcessStartInfo(exe, args);
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.RedirectStandardInput = true;
        if (workingDir != null && workingDir.Length > 0) psi.WorkingDirectory = workingDir;
        // UseShellExecute=false is required for this to work at all. The marker is
        // what lets the plugin's /_dsh-launcher/restart endpoint really restart:
        // without it the plugin answers "unsupervised" and stays up.
        if (envName != null && envName.Length > 0) psi.EnvironmentVariables[envName] = envValue;
        legacy = Encoding.GetEncoding(codePage);
        // UTF-8 with BOM: notepad and Get-Content then show Chinese correctly.
        // StreamWriter only emits the preamble for a new/empty file, so appends stay clean.
        log = new StreamWriter(new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite), new UTF8Encoding(true));
        log.AutoFlush = true;
        proc = new Process();
        proc.StartInfo = psi;
        proc.Start();
        // Close stdin right away: a child that reads stdin then sees EOF and returns,
        // instead of blocking forever on a console we do not have.
        proc.StandardInput.Close();
        // Read the pipes as raw BYTES and decode per line: dsh (Node) writes UTF-8,
        // while other tools may write the OEM code page (936 on this box).
        // A single fixed StandardOutputEncoding would garble one of the two.
        PumpAsync(proc.StandardOutput.BaseStream);
        PumpAsync(proc.StandardError.BaseStream);
    }

    private void PumpAsync(Stream s)
    {
        Thread t = new Thread(delegate() { Pump(s); });
        t.IsBackground = true;
        t.Start();
    }

    private void Pump(Stream s)
    {
        byte[] buf = new byte[8192];
        byte[] line = new byte[8192];
        int lineLen = 0;
        int n;
        while ((n = s.Read(buf, 0, buf.Length)) > 0)
        {
            for (int i = 0; i < n; i++)
            {
                byte b = buf[i];
                if (b == 10)
                {
                    EmitLine(line, lineLen);
                    lineLen = 0;
                }
                else
                {
                    if (lineLen == line.Length) Array.Resize(ref line, line.Length * 2);
                    line[lineLen++] = b;
                }
            }
        }
        if (lineLen > 0) EmitLine(line, lineLen);
    }

    private void EmitLine(byte[] line, int len)
    {
        if (len > 0 && line[len - 1] == 13) len--;
        Emit(Decode(line, len));
    }

    private string Decode(byte[] bytes, int len)
    {
        // Strict UTF-8 first: valid UTF-8 wins, anything else is the OEM page
        // (pure ASCII decodes identically either way).
        bool ascii = true;
        for (int i = 0; i < len; i++) { if (bytes[i] > 127) { ascii = false; break; } }
        if (ascii) return Encoding.ASCII.GetString(bytes, 0, len);
        try { return new UTF8Encoding(false, true).GetString(bytes, 0, len); }
        catch { return legacy.GetString(bytes, 0, len); }
    }

    private void Emit(string line)
    {
        lock (gate)
        {
            sb.Append(line).Append("\r\n");
            if (sb.Length > MaxChars) { sb.Remove(0, TrimChars); baseIndex += TrimChars; }
            try { log.WriteLine(line); } catch { }
        }
    }

    public void CloseLog()
    {
        try { if (log != null) { log.Flush(); log.Dispose(); } } catch { }
        log = null;
    }
}
'@
Add-Type -TypeDefinition $csharp -Language CSharp

# One instance per port: never start a second dsh by accident.
$script:SingleMutex = New-Object System.Threading.Mutex($false, ('Local\dsh-tray-launcher-' + $Port))
if (-not $script:SingleMutex.WaitOne(0)) {
    Write-Host ('[dsh-tray] another tray instance is already running on port ' + $Port + '; exiting')
    if (-not $Headless) {
        # Tell the user why nothing seemed to happen; the running tray is in the
        # notification area already.
        try { $null = [System.Windows.Forms.MessageBox]::Show((T 'msg.trayrunning'), (T 'balloon.title'), 'OK', 'Information') } catch { }
    }
    exit 0
}

# ---------------------------------------------------------------- helpers
if (-not (Test-Path -LiteralPath $StateDir)) { New-Item -ItemType Directory -Force -Path $StateDir | Out-Null }
$script:LogFile    = Join-Path $StateDir 'dsh-web.log'
$script:TrayLog    = Join-Path $StateDir 'dsh-tray.log'
$script:Offset     = [long]0
$script:AutoExitAt = $null
$script:Quitting   = $false
$script:ExitWhenChildEnds = $false
$script:WasRunning = $false
$script:ChildEndedHandled = $false
$script:RestartExitCode = 42
$script:TestRestartAt = $null
$script:Supervised = $true
$script:StatusEndpoint = '/_dsh-launcher/status'
$script:RestartEndpoint = '/_dsh-launcher/restart'
$script:ShutdownEndpoint = '/_dsh-launcher/shutdown'
$script:AutoStartSubKey = 'Software\Microsoft\Windows\CurrentVersion\Run'
$script:AutoStartValue = 'DSHLauncher'
$script:AutoStartOn    = $false
$script:AutoStartCommand = ''

$script:CodePage = [System.Text.Encoding]::Default.CodePage
try {
    $oem = [System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage
    if ($oem -gt 0) { $script:CodePage = $oem }
} catch { }

function Write-TrayLog([string]$m) {
    try {
        $utf8 = New-Object System.Text.UTF8Encoding($true)
        [System.IO.File]::AppendAllText($script:TrayLog, ("[{0}] {1}`r`n" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m), $utf8)
    } catch { }
}

function Rotate-Log {
    try {
        if ((Test-Path -LiteralPath $script:LogFile) -and ((Get-Item -LiteralPath $script:LogFile).Length -gt 5MB)) {
            $bak = $script:LogFile + '.1'
            if (Test-Path -LiteralPath $bak) { Remove-Item -LiteralPath $bak -Force }
            Move-Item -LiteralPath $script:LogFile -Destination $bak -Force
        }
    } catch { }
}

function Test-PortUp([int]$p) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $r = $c.BeginConnect('127.0.0.1', $p, $null, $null)
        if ($r.AsyncWaitHandle.WaitOne(400)) { $c.EndConnect($r); $c.Close(); return $true }
        $c.Close()
        return $false
    } catch { return $false }
}

function Wait-PortFree([int]$p, [int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-PortUp $p)) { return $true }
        Start-Sleep -Milliseconds 300
    }
    return (-not (Test-PortUp $p))
}

function Invoke-DshEndpoint([string]$path) {
    try {
        $null = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}{1}" -f $Port, $path) -Method POST -UseBasicParsing -TimeoutSec 10
        return $true
    } catch { return $false }
}

# --------------------------------------------------- plugin endpoints (own namespace)
function Get-DshStatus {
    try {
        $r = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}{1}" -f $Port, $script:StatusEndpoint) -Method GET -UseBasicParsing -TimeoutSec 5
        if ($r.Content.Length -eq 0) { return $null }
        return ($r.Content | ConvertFrom-Json)
    } catch { return $null }
}

# A restart through the plugin only works when the plugin agrees it is supervised
# (it sees DSH_LAUNCHER_SUPERVISED=1, which this tray sets on the child). When the
# status endpoint does not answer - plugin not installed, failed to load, removed
# from the profile, or the route is taken by another plugin - there is nothing to
# ask, so the tray forces the restart. That does interrupt running sessions, which
# is why the forced path logs it and shows a balloon instead of pretending the
# restart was graceful.
#
# An earlier version tried to read the marker back out of the child's
# Process.StartInfo. That can never work: fetching a process by id yields a fresh
# Process whose StartInfo is a default object, so the lookup always came up empty.
# Found by the 2026-10-03 adversarial review.
function Test-Supervised {
    $st = Get-DshStatus
    if ($null -eq $st) {
        Write-TrayLog ('status endpoint (' + $script:StatusEndpoint + ') did not answer; supervision cannot be confirmed')
        return $false
    }
    $names = $st.PSObject.Properties.Name
    if ($names -contains 'supervised') { return ($st.supervised -eq $true) }
    return $false
}

# ------------------------------------------------- start-at-logon (HKCU Run)
# Same key and same value name as the plugin host half (index.js), so the tray
# menu and the DSH power dialog never disagree about the state.
function Get-AutoStartState {
    # .NET registry access on purpose. The stored value is a quoted command line,
    # and Windows PowerShell 5.1 mangles embedded quotes while marshalling
    # arguments to reg.exe (it stored the command WITHOUT its quotes, which only
    # works while both paths happen to contain no spaces). Talking to the
    # registry API directly stores and reads the exact string.
    $script:AutoStartCommand = ''
    try {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($script:AutoStartSubKey)
        if ($null -eq $key) { return $false }
        try {
            $value = $key.GetValue($script:AutoStartValue, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
            if ($null -eq $value) { return $false }
            $script:AutoStartCommand = [string]$value
            return (-not [string]::IsNullOrWhiteSpace($script:AutoStartCommand))
        } finally { $key.Close() }
    } catch {
        Write-TrayLog ('autostart read failed: ' + $_.Exception.Message)
        return $false
    }
}

function Set-AutoStart([bool]$enable) {
    $wscript = ''
    $vbs = ''
    try {
        if ($null -ne $script:InstallInfo) {
            if ($script:InstallInfo.PSObject.Properties.Name -contains 'wscript') { $wscript = [string]$script:InstallInfo.wscript }
            if ($script:InstallInfo.PSObject.Properties.Name -contains 'vbs') { $vbs = [string]$script:InstallInfo.vbs }
        }
    } catch { }
    if ([string]::IsNullOrWhiteSpace($wscript)) { $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe' }
    if ([string]::IsNullOrWhiteSpace($vbs)) { $vbs = Join-Path $PSScriptRoot 'dsh-launcher-tray.vbs' }
    $cmd = '"' + $wscript + '" "' + $vbs + '"'
    try {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($script:AutoStartSubKey, $true)
        if ($null -eq $key) {
            Write-TrayLog 'autostart write failed: the Run key is not readable'
            return $false
        }
        try {
            if ($enable) {
                $key.SetValue($script:AutoStartValue, $cmd, [Microsoft.Win32.RegistryValueKind]::String)
            } elseif ($null -ne $key.GetValue($script:AutoStartValue)) {
                $key.DeleteValue($script:AutoStartValue, $false)
            }
        } finally { $key.Close() }
        if ($enable) {
            # Read the value back and compare: a silent quoting or encoding
            # mismatch must never be reported as success.
            $present = Get-AutoStartState
            if (-not $present -or $script:AutoStartCommand -ne $cmd) {
                Write-TrayLog ('autostart verify failed: stored=[' + $script:AutoStartCommand + '] expected=[' + $cmd + ']')
                return $false
            }
            return $true
        }
        return (-not (Get-AutoStartState))
    } catch {
        Write-TrayLog ('autostart set failed: ' + $_.Exception.Message)
        return $false
    }
}

function Sync-AutoStartItem {
    if ($null -eq $miAuto) { return }
    try {
        $script:AutoStartOn = Get-AutoStartState
        if ($script:AutoStartOn) { $miAuto.Text = (T 'menu.autostart.on') } else { $miAuto.Text = (T 'menu.autostart.off') }
        $miAuto.Checked = $script:AutoStartOn
    } catch {
        Write-TrayLog ('autostart menu sync failed: ' + $_.Exception.Message)
    }
}

# ---------------------------------------------------------------- supervision
$script:Sup = New-Object DshSupervisor

function Start-Dsh {
    $script:ChildEndedHandled = $false
    Rotate-Log
    $cmdExe = Join-Path $env:SystemRoot 'System32\cmd.exe'
    # Direct mode only: "cmd /c" propagates dsh's exit code, including 42, and the
    # tray owns the relaunch loop - no external launcher file is involved.
    $childArgs = '/c dsh web --port {0}' -f $Port
    try {
        $script:Sup.Start($cmdExe, $childArgs, $script:LogFile, $script:CodePage, $Dir, 'DSH_LAUNCHER_SUPERVISED', '1')
        # Mark the started state here: a child that exits almost immediately (for
        # example an instant 42) must still be seen by the timer as a
        # running -> exited transition, otherwise the relaunch never fires.
        $script:WasRunning = $true
        $script:Supervised = $true
        Write-TrayLog ('started mode=direct supervised=1 pid={0} port={1} codepage={2} cwd={3}' -f $script:Sup.ProcId, $Port, $script:CodePage, $Dir)
        return $true
    } catch {
        Write-TrayLog ('start failed: ' + $_.Exception.Message)
        return $false
    }
}

function Stop-DshGraceful {
    if (-not $script:Sup.Running) { return }
    Write-TrayLog 'graceful stop requested'
    $asked = $false
    if (Test-PortUp $Port) { $asked = Invoke-DshEndpoint $script:ShutdownEndpoint }
    if ($asked) {
        # The launcher plugin owns a real shutdown; give it a moment.
        $deadline = (Get-Date).AddSeconds(8)
        while ((Get-Date) -lt $deadline -and $script:Sup.Running) {
            Start-Sleep -Milliseconds 200
            if (-not $Headless) { [System.Windows.Forms.Application]::DoEvents() }
        }
    } else {
        Write-TrayLog 'shutdown endpoint unavailable (plugin not installed?); stopping without waiting'
    }
    if ($script:Sup.Running) {
        Write-TrayLog 'killing process tree'
        Kill-DshTree
    } else {
        Write-TrayLog 'child exited cleanly'
    }
}

function Kill-DshTree {
    try {
        $p = $script:Sup.ProcId
        if ($p -gt 0) { $null = & taskkill.exe /PID $p /T /F 2>&1 }
    } catch { }
    try { $script:Sup.CloseLog() } catch { }
}

# Restart through the plugin endpoint when the child really is supervised
# (graceful: the plugin exits 42 and the relaunch loop picks it up), otherwise
# kill the tree and start again ourselves. Returns 'plugin', 'forced' or 'failed'.
function Restart-Dsh {
    if ($script:Sup.Running -and (Test-PortUp $Port)) {
        if (-not (Test-Supervised)) {
            Write-TrayLog ('restart refused by endpoint (' + $script:RestartEndpoint + '): supervision not confirmed; forcing a restart')
        } elseif (Invoke-DshEndpoint $script:RestartEndpoint) {
            Write-TrayLog ('restart requested through ' + $script:RestartEndpoint + ' (exit code 42 expected)')
            return 'plugin'
        } else {
            Write-TrayLog 'restart endpoint unavailable; forcing a restart'
        }
    } else {
        Write-TrayLog 'restart endpoint unavailable; forcing a restart'
    }
    if (-not $Headless) {
        $tb.AppendText((("`r`n" + (T 'log.restartforce') + "`r`n") -f (Get-Date -Format 'HH:mm:ss')))
    }
    if ($script:Sup.Running) { Kill-DshTree }
    $script:Sup.CloseLog()
    $null = Wait-PortFree $Port 10
    if (Start-Dsh) { return 'forced' }
    return 'failed'
}

# ------------------------------------------------------- start-at-logon check
# Non-interactive proof of the logon-start path: read, add, verify the stored
# string byte for byte, remove, verify gone. An existing entry is never touched.
if ($TestAutoStart) {
    Write-Host ('[dsh-tray] autostart self-test; value={0} key=HKCU\{1}' -f $script:AutoStartValue, $script:AutoStartSubKey)
    $presentBefore = Get-AutoStartState
    Write-Host ('  before  : present={0} command=[{1}]' -f $presentBefore, $script:AutoStartCommand)
    if ($presentBefore) {
        Write-Host '  an entry already exists; leaving it untouched'
        exit 3
    }
    $enabled = Set-AutoStart $true
    Write-Host ('  enable  : ok={0} command=[{1}]' -f $enabled, $script:AutoStartCommand)
    $disabled = Set-AutoStart $false
    $presentAfter = Get-AutoStartState
    Write-Host ('  disable : ok={0} present-after={1}' -f $disabled, $presentAfter)
    if ($enabled -and $disabled -and (-not $presentAfter)) {
        Write-Host '  AUTOSTART SELF-TEST PASS'
        exit 0
    }
    Write-Host '  AUTOSTART SELF-TEST FAIL'
    exit 2
}

# ---------------------------------------------------------------- headless mode
if ($Headless) {
    Write-Host ('[dsh-tray] headless; port={0} dir={1} endpoints={2}' -f $Port, $Dir, $script:StatusEndpoint)
    if (-not (Start-Dsh)) { Write-Host '[dsh-tray] start failed'; exit 3 }
    if ($AutoExitSeconds -gt 0) { $script:AutoExitAt = (Get-Date).AddSeconds($AutoExitSeconds) }
    if ($TestRestartSeconds -gt 0) { $script:TestRestartAt = (Get-Date).AddSeconds($TestRestartSeconds) }
    $next = [long]0
    $code = 0
    while ($true) {
        while ($script:Sup.Running) {
            $new = $script:Sup.ReadFrom($script:Offset, [ref]$next)
            if ($new) { $script:Offset = $next; Write-Host $new.TrimEnd() }
            Start-Sleep -Milliseconds 300
            if ($script:TestRestartAt -ne $null -and (Get-Date) -gt $script:TestRestartAt) {
                $script:TestRestartAt = $null
                Write-Host ('[dsh-tray] self-test restart -> ' + (Restart-Dsh))
            }
            if ($script:AutoExitAt -ne $null -and (Get-Date) -gt $script:AutoExitAt) { break }
        }
        $new = $script:Sup.ReadFrom($script:Offset, [ref]$next)
        if ($new) { $script:Offset = $next; Write-Host $new.TrimEnd() }
        if ($script:TestRestartAt -ne $null -and (Get-Date) -gt $script:TestRestartAt) {
            $script:TestRestartAt = $null
            Write-Host ('[dsh-tray] self-test restart -> ' + (Restart-Dsh))
            continue
        }
        $code = $script:Sup.ExitCode
        if ($code -eq $script:RestartExitCode -and ($script:AutoExitAt -eq $null -or (Get-Date) -lt $script:AutoExitAt)) {
            Write-Host ('[dsh-tray] exit code 42 -> relaunching (port free: {0})' -f (Wait-PortFree $Port 10))
            if (Start-Dsh) { continue }
            Write-Host '[dsh-tray] relaunch failed'
            exit 3
        }
        break
    }
    Write-Host ('[dsh-tray] child exited with code {0}' -f $code)
    $script:Sup.CloseLog()
    if ($script:Sup.Running) { Kill-DshTree }
    if ($code -eq 0 -or $code -eq $script:RestartExitCode) { exit 0 } else { exit 1 }
}

# ---------------------------------------------------------------- UI
# Official DSH whale mark (black), rendered from the frontend favicon.svg into a
# multi-size .ico by tools\make-icon.ps1; fall back to the stock icon when absent.
$script:IconPath = Join-Path $PSScriptRoot 'dsh.ico'
$script:TrayIcon = $null
try {
    if (Test-Path -LiteralPath $script:IconPath) { $script:TrayIcon = New-Object System.Drawing.Icon($script:IconPath) }
} catch { $script:TrayIcon = $null }
if ($null -eq $script:TrayIcon) { $script:TrayIcon = [System.Drawing.SystemIcons]::Application }

$form = New-Object System.Windows.Forms.Form
$form.Text = (T 'form.title.base')
$form.Size = [System.Drawing.Size]::new(960, 640)
$form.StartPosition = 'CenterScreen'
$form.ShowInTaskbar = $false
$form.Icon = $script:TrayIcon

$tb = New-Object System.Windows.Forms.TextBox
$tb.Multiline = $true
$tb.ReadOnly = $true
$tb.ScrollBars = 'Vertical'
$tb.WordWrap = $false
$tb.Dock = 'Fill'
$tb.BackColor = [System.Drawing.Color]::FromArgb(16, 16, 16)
$tb.ForeColor = [System.Drawing.Color]::Gainsboro
$tb.Font = [System.Drawing.Font]::new('Consolas', 9.5)
$form.Controls.Add($tb)

$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = $script:TrayIcon
$ni.Text = (T 'balloon.title')
$ni.Visible = $true

$menu   = New-Object System.Windows.Forms.ContextMenuStrip
$miShow = $menu.Items.Add((T 'menu.toggle'))
$miRun  = $menu.Items.Add((T 'menu.run'))
$miRest = $menu.Items.Add((T 'menu.restart'))
$miAuto = $menu.Items.Add((T 'menu.autostart.off'))
$miAuto.CheckOnClick = $false
$miOpen = $menu.Items.Add((T 'menu.open'))
$miLog  = $menu.Items.Add((T 'menu.log'))
$null   = $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$miQuit = $menu.Items.Add((T 'menu.quit'))
$ni.ContextMenuStrip = $menu

# Read the logon-start state once at startup (a failure counts as "off" and is
# logged); every toggle re-reads it so the menu never shows a stale check.
Sync-AutoStartItem

function Show-TrayWindow {
    try {
        $form.Show()
        if ($form.WindowState -eq 'Minimized') { $form.WindowState = 'Normal' }
        # A process started with STARTUPINFO SW_HIDE (wscript "Run ..., 0" plus
        # powershell -WindowStyle Hidden) can swallow the first window show, so
        # force this one visible instead of trusting the startup info.
        $h = $form.Handle
        $null = [DshTray.Win]::ShowWindow($h, 5)
        $null = [DshTray.Win]::SetForegroundWindow($h)
        $form.Activate()
        $tb.SelectionStart = $tb.TextLength
        $tb.ScrollToCaret()
        Write-TrayLog ('show window: visible={0} state={1} handle={2}' -f $form.Visible, $form.WindowState, $h)
    } catch {
        Write-TrayLog ('show window failed: ' + $_.Exception.Message)
    }
}

function Update-Status {
    $running = $script:Sup.Running
    if ($running) {
        $tip = (T 'tray.tip.running') -f $script:Sup.ProcId
        $form.Text = (T 'form.title.running') -f $script:Sup.ProcId
    } elseif ($script:Sup.ProcId -eq 0) {
        # No child was ever started (e.g. the port was already serving).
        $tip = (T 'tray.tip.unmanaged')
        $form.Text = (T 'form.title.unmanaged')
    } else {
        $code = $script:Sup.ExitCode
        $tip = (T 'tray.tip.stopped') -f $code
        $form.Text = (T 'form.title.stopped') -f $code
    }
    if ($tip.Length -gt 62) { $tip = $tip.Substring(0, 62) }
    $ni.Text = $tip
    $miRun.Enabled  = -not $running
    $miRest.Enabled = $running
}

function Quit-Tray {
    if ($script:Quitting) { return }
    $script:Quitting = $true
    $timer.Stop()
    Write-TrayLog 'quitting tray; stopping child if any'
    Stop-DshGraceful
    if ($script:Sup.Running) { Kill-DshTree }
    $script:Sup.CloseLog()
    $ni.Visible = $false
    [System.Windows.Forms.Application]::ExitThread()
}

function Update-Ui {
    if ($script:Quitting) { return }
    try {
        $next = [long]0
        $new = $script:Sup.ReadFrom($script:Offset, [ref]$next)
        if ($new) {
            $script:Offset = $next
            $tb.AppendText($new)
            if ($tb.TextLength -gt 400000) { $tb.Text = $tb.Text.Substring($tb.TextLength - 200000) }
            if ($form.Visible) {
                $tb.SelectionStart = $tb.TextLength
                $tb.ScrollToCaret()
            }
        }
        $running = $script:Sup.Running
        if ($running -ne $script:WasRunning) {
            $script:WasRunning = $running
            Update-Status
            if (-not $running -and -not $script:ChildEndedHandled) {
                $script:ChildEndedHandled = $true
                $code = $script:Sup.ExitCode
                Write-TrayLog ('child exited with code {0}' -f $code)
                if ($script:ExitWhenChildEnds) { Quit-Tray; return }
                if ($code -eq $script:RestartExitCode) {
                    # Exit code 42 is the plugin's "restart me" signal. The port must
                    # really be free before a new child starts: starting one anyway
                    # leaves it unable to bind while the old listener keeps serving,
                    # and the tray would then believe DSH is gone while it is not.
                    $tb.AppendText((("`r`n" + (T 'log.relaunch') + "`r`n") -f (Get-Date -Format 'HH:mm:ss')))
                    $free = Wait-PortFree $Port 10
                    if (-not $free) {
                        Write-TrayLog ('exit code 42 but port {0} is still in use; killing the tree and waiting again' -f $Port)
                        if ($script:Sup.Running) { Kill-DshTree }
                        $free = Wait-PortFree $Port 10
                    }
                    Write-TrayLog ('restart requested (42); port free=' + $free)
                    if (-not $free) {
                        Write-TrayLog ('port {0} is still busy; not relaunching' -f $Port)
                        $ni.ShowBalloonTip(5000, (T 'balloon.title'), ((T 'balloon.portbusy') -f $Port), 'Error')
                        Update-Status
                        return
                    }
                    if (-not (Start-Dsh)) {
                        $ni.ShowBalloonTip(5000, (T 'balloon.title'), (T 'balloon.startfail'), 'Error')
                    }
                    Update-Status
                    return
                }
                if (Test-PortUp $Port) {
                    $ni.ShowBalloonTip(5000, (T 'balloon.title'), (T 'balloon.unmanaged'), 'Warning')
                } else {
                    $ni.ShowBalloonTip(5000, (T 'balloon.stopped.title'), ((T 'balloon.stopped') -f $code), 'Warning')
                }
            }
        }
        if ($script:AutoExitAt -ne $null -and (Get-Date) -gt $script:AutoExitAt) { Quit-Tray }
    } catch {
        Write-TrayLog ('ui tick error: ' + $_.Exception.Message)
    }
}

$miShow.add_Click({
    if ($form.Visible) { $form.Hide() } else { Show-TrayWindow }
})
$miRun.add_Click({
    if ($script:Sup.Running) { return }
    $tb.AppendText((("`r`n" + (T 'log.run') + "`r`n") -f (Get-Date -Format 'HH:mm:ss')))
    if (-not (Start-Dsh)) {
        $ni.ShowBalloonTip(5000, (T 'balloon.title'), (T 'balloon.startfail'), 'Error')
    }
    Update-Status
})
$miRest.add_Click({
    if (-not $script:Sup.Running) { return }
    $tb.AppendText((("`r`n" + (T 'log.restart') + "`r`n") -f (Get-Date -Format 'HH:mm:ss')))
    $mode = Restart-Dsh
    if ($mode -eq 'plugin') {
        $ni.ShowBalloonTip(3000, (T 'balloon.title'), (T 'balloon.restartok'), 'Info')
    } elseif ($mode -eq 'forced') {
        $ni.ShowBalloonTip(3000, (T 'balloon.title'), (T 'balloon.restartforced'), 'Info')
    } else {
        $ni.ShowBalloonTip(5000, (T 'balloon.title'), (T 'balloon.restartfail'), 'Error')
    }
    Update-Status
})
$miAuto.add_Click({
    # Never auto-register at install time: only this explicit click flips it.
    $target = -not $script:AutoStartOn
    $key = 'balloon.autostart.off'
    if ($target) { $key = 'balloon.autostart.on' }
    try {
        if (Set-AutoStart $target) {
            $script:AutoStartOn = $target
            $ni.ShowBalloonTip(3000, (T 'balloon.title'), (T $key), 'Info')
        } else {
            $ni.ShowBalloonTip(5000, (T 'balloon.title'), (T 'balloon.autostart.failed'), 'Error')
        }
    } catch {
        Write-TrayLog ('autostart toggle failed: ' + $_.Exception.Message)
        $ni.ShowBalloonTip(5000, (T 'balloon.title'), (T 'balloon.autostart.failed'), 'Error')
    }
    Sync-AutoStartItem
})
$miOpen.add_Click({
    try { Start-Process ("http://127.0.0.1:{0}" -f $Port) } catch { }
})
$miLog.add_Click({
    try { Start-Process 'notepad.exe' $script:LogFile } catch { }
})
$miQuit.add_Click({
    $r = [System.Windows.Forms.MessageBox]::Show((T 'quit.text'), (T 'quit.title'), 'YesNo', 'Question')
    if ($r -eq 'Yes') { $script:ExitWhenChildEnds = $true; Quit-Tray }
})
$ni.add_MouseDoubleClick({
    if ($form.Visible) { $form.Hide() } else { Show-TrayWindow }
})
$form.add_FormClosing({
    param($sender, $e)
    $e.Cancel = $true
    $form.Hide()
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 400
$timer.add_Tick({ Update-Ui })
$timer.Start()

Write-TrayLog ('tray starting (pid {0}); port={1} dir={2} state={3} mode=direct supervised=1 status={4} restart={5} strings={6}' -f $PID, $Port, $Dir, $StateDir, $script:StatusEndpoint, $script:RestartEndpoint, $StringsFile)

if (Test-PortUp $Port) {
    $body = @(
        ((T 'already.head') -f $Port),
        '',
        (T 'already.p1'),
        (T 'already.p2'),
        (T 'already.p3'),
        '',
        (T 'already.p4')
    ) -join "`r`n"
    $tb.AppendText($body + "`r`n")
    Write-TrayLog 'port already serving; not starting a second dsh'
    Show-TrayWindow
    Update-Status
} else {
    if (-not (Start-Dsh)) {
        $tb.AppendText((T 'startfail.body') + "`r`n")
        Show-TrayWindow
    } else {
        $ni.ShowBalloonTip(3000, (T 'balloon.starting'), (T 'balloon.startingtip'), 'Info')
        if ($ShowWindowOnStart) { Show-TrayWindow }
    }
    Update-Status
}

if ($AutoExitSeconds -gt 0) { $script:AutoExitAt = (Get-Date).AddSeconds($AutoExitSeconds) }

[System.Windows.Forms.Application]::Run()
