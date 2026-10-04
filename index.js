/**
 * @mostkia/dsh-launcher - host half.
 *
 * Same-origin endpoints under `/_dsh-launcher` (the plugin uses its own
 * namespace on purpose: it never claims a path another plugin may own):
 *
 *   GET  /status                    supervisor detection + autostart state
 *   POST /shutdown                  graceful exit, code 0
 *   POST /restart                   graceful exit, restart code 42
 *   POST /autostart/enable          register the Windows tray as a logon start
 *   POST /autostart/disable         remove that registration
 *
 * Both exits go through the host's own bounded shutdown controller
 * (`ctx.appExit`), so the application tree is disposed and the port released
 * before the process leaves - never a raw `process.exit`.
 *
 * A restart is only performed when a supervisor is actually there to relaunch
 * the process: the tray sets `DSH_LAUNCHER_SUPERVISED=1` on the child it starts.
 * Without that marker the endpoint reports `unsupervised` and does nothing, so a
 * user who never installed the tray cannot lose a running session by clicking
 * restart.
 *
 * The host half has no runtime dependencies on purpose: `@deepseek-ai/*` values
 * stay peerDependencies so a package manager can never install a second physical
 * copy of a shared DSH package into the profile (that is what breaks private
 * Symbols and the scheduler lookup).
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'dsh-launcher';
export const inject = [];

/** Endpoint namespace owned by this plugin. */
const PREFIX = '/_dsh-launcher';
/** Delay between the HTTP reply and the exit request, so the page receives it. */
const RESPONSE_GRACE_MS = 300;
/** Exit code the supervisor understands as "relaunch me". */
const RESTART_EXIT_CODE = 42;
/** Environment marker the tray launcher sets on the process it supervises. */
const SUPERVISOR_ENV = 'DSH_LAUNCHER_SUPERVISED';
/** Windows logon-start registry location and value name. */
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'DSHLauncher';
/** Same-origin hosts accepted for the destructive endpoints (CSRF guard). */
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1', '[::1]'];
const IS_WINDOWS = process.platform === 'win32';
/**
 * Set to `1` to keep the plugin from installing the tray by itself. This is the
 * documented opt-out; the one that follows is a test seam - it points the install at
 * a scratch script so the suite never installs a real tray.
 */
const NO_AUTO_INSTALL_ENV = 'DSH_LAUNCHER_NO_TRAY_INSTALL';
const INSTALLER_ENV = 'DSH_LAUNCHER_TRAY_INSTALLER';
/** How long after startup the automatic tray install runs (it never blocks boot). */
const TRAY_INSTALL_DELAY_MS = 1500;
/** This package's own directory: the tray ships inside it, so the install starts here. */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url));
/** Folder the tray installer uses under %LOCALAPPDATA%. */
const TRAY_DIR_NAME = 'DSH-Launcher';

/**
 * Accept only same-origin callers: a browser always sends `Origin` on a POST, and
 * only a page served from this machine's loopback address may change state.
 * Requests without Origin (scripts, curl) pass - the standard CSRF reasoning, and
 * what the README promises.
 *
 * An earlier version also accepted an Origin whose host equalled the request's
 * Host header. That is not same-origin. With DNS rebinding the attacking page is
 * served from a name that resolves to 127.0.0.1, so its Origin and the Host header
 * agree, and every destructive endpoint became reachable from that page. The
 * review that found it also showed the "same host" branch accepting
 * `Origin: http://evil.example` with `Host: evil.example`.
 * @param req - the incoming request.
 * @returns whether the request may perform a state change.
 */
function isTrustedOrigin(req) {
  const origin = req.headers && req.headers.origin;
  if (origin === undefined || origin === null || origin === '') return true;
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return LOOPBACK_HOSTS.includes(parsed.hostname);
}

/**
 * Write one JSON response.
 * @param res - the response to fill.
 * @param status - HTTP status code.
 * @param body - JSON-serializable body.
 */
function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * Run `reg.exe` with an argument vector (no shell, so quoting stays literal).
 *
 * `stdio: 'ignore'` is deliberate: a spawn that redirects the child's output
 * through pipes needs named pipes, which confined/sandboxed environments deny
 * (`spawn EPERM`). Only the exit code matters here, so the plugin never asks for
 * a pipe - that keeps autostart working wherever DSH itself can run.
 * @param args - argument vector.
 * @returns whether the command succeeded, plus its exit code.
 */
function runReg(args) {
  return new Promise((resolve) => {
    try {
      execFile('reg.exe', args, { windowsHide: true, stdio: 'ignore' }, (error) => {
        if (error === null || error === undefined) {
          resolve({ ok: true, code: 0 });
          return;
        }
        // `error.code` is a string for spawn failures (EPERM) and a number for a
        // non-zero exit. Never flatten "could not run at all" into exit code 0:
        // callers decide on `ok`, but the code must stay truthful.
        resolve({ ok: false, code: typeof error.code === 'number' ? error.code : null });
      });
    } catch {
      resolve({ ok: false, code: null });
    }
  });
}

/**
 * Read the tray installer's marker file, which records where the tray was
 * installed. The plugin never guesses that path.
 * @returns the parsed marker, or null when the tray is not installed.
 */
function readInstallInfo() {
  const base = process.env.LOCALAPPDATA;
  if (typeof base !== 'string' || base === '') return null;
  try {
    return JSON.parse(readFileSync(join(base, 'DSH-Launcher', 'install.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Resolve the command that starts the installed tray, if any.
 * @returns `{ wscript, vbs }` or null.
 */
function autostartTarget() {  const info = readInstallInfo();
  if (info === null || typeof info.vbs !== 'string' || info.vbs === '') return null;
  const wscript = typeof info.wscript === 'string' && info.wscript !== '' ? info.wscript : 'wscript.exe';
  return { wscript, vbs: info.vbs };
}

/** Cache for packageVersion(): read once, this file never changes under us. */
let packageVersionCache;
/**
 * This package's version - the same string install.ps1 records in the tray marker,
 * which is how "the tray matches the plugin that installed it" is decided.
 * @returns the version, or null when it cannot be read.
 */
function packageVersion() {
  if (packageVersionCache !== undefined) return packageVersionCache;
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8'));
    packageVersionCache = typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    packageVersionCache = null;
  }
  return packageVersionCache;
}

/**
 * @returns the folder the tray installer writes to, or null without a profile.
 */
function trayInstallDir() {
  const base = process.env.LOCALAPPDATA;
  if (typeof base !== 'string' || base === '') return null;
  return join(base, TRAY_DIR_NAME);
}

/**
 * What the tray half looks like right now. "Installed" means the marker is readable
 * *and* the files the plugin has to drive are there: a marker left behind after a
 * manual cleanup must not read as a working tray.
 * @returns `{ supported, installed, version, expected, upToDate, dir }`.
 */
function trayState() {
  const dir = trayInstallDir();
  const info = readInstallInfo();
  const expected = packageVersion();
  const version = info !== null && typeof info.version === 'string' ? info.version : null;
  const filesThere = dir !== null
    && existsSync(join(dir, 'dsh-launcher-tray.ps1'))
    && existsSync(join(dir, 'uninstall.ps1'));
  const installed = info !== null && filesThere;
  return {
    supported: IS_WINDOWS,
    installed,
    version,
    expected,
    upToDate: installed && expected !== null && version === expected,
    dir,
  };
}

/**
 * Run a PowerShell script file and report only whether it succeeded.
 *
 * Same reasoning as runReg: `stdio: 'ignore'` plus `windowsHide` keeps this working
 * in confined environments, and the exit code is the entire result.
 * @param script - absolute path of the script.
 * @param args - extra argument vector.
 * @param timeoutMs - how long to let it run.
 * @returns whether the script succeeded, plus its exit code.
 */
function runPowerShellFile(script, args, timeoutMs) {
  return new Promise((settle) => {
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
        { windowsHide: true, stdio: 'ignore', timeout: timeoutMs },
        (error) => {
          if (error === null || error === undefined) {
            settle({ ok: true, code: 0 });
            return;
          }
          settle({ ok: false, code: typeof error.code === 'number' ? error.code : null });
        },
      );
    } catch {
      settle({ ok: false, code: null });
    }
  });
}

/**
 * Install or update the tray half, so that adding the plugin is a one-step install.
 *
 * The package manager cannot do this for us: pnpm 10+ refuses to run a dependency's
 * lifecycle scripts unless it is allowlisted, and the DSH plugin command has no
 * hooks. What is left is the honest one - the plugin installs its own companion from
 * the copy shipped inside the package, on the first start after the package was
 * added. Nothing here needs elevation (the tray lives entirely in the user's
 * profile), and `DSH_LAUNCHER_NO_TRAY_INSTALL=1` turns it off.
 * @returns what happened, for the status document and the log.
 */
async function ensureTrayInstalled() {
  if (!IS_WINDOWS) return { action: 'skipped', reason: 'windows-only' };
  if (process.env[NO_AUTO_INSTALL_ENV] === '1') return { action: 'skipped', reason: 'disabled-by-env' };
  const before = trayState();
  if (before.installed && before.upToDate) {
    return { action: 'skipped', reason: 'already-installed', version: before.version };
  }
  const override = process.env[INSTALLER_ENV];
  const script = typeof override === 'string' && override !== '' ? override : join(PACKAGE_DIR, 'tray', 'install.ps1');
  if (!existsSync(script)) return { action: 'failed', reason: 'installer-missing' };
  const result = await runPowerShellFile(script, ['-Dir', process.cwd()], 180000);
  if (!result.ok) return { action: 'failed', reason: 'installer-failed', exitCode: result.code };
  const after = trayState();
  if (!after.installed) return { action: 'failed', reason: 'installer-did-not-install' };
  return { action: before.installed ? 'updated' : 'installed', version: after.version };
}

/**
 * Report the logon-start state.
 * @returns `{ supported, enabled, reason, target? }`.
 */
async function autostartState() {
  if (!IS_WINDOWS) return { supported: false, enabled: false, reason: 'windows-only' };
  const target = autostartTarget();
  if (target === null) return { supported: false, enabled: false, reason: 'tray-not-installed' };
  const query = await runReg(['query', RUN_KEY, '/v', RUN_VALUE]);
  return {
    supported: true,
    enabled: query.ok,
    reason: query.ok ? 'registered' : 'not-registered',
    target: target.vbs,
  };
}

/**
 * Register or remove the logon-start entry.
 * @param enabled - true to register, false to remove.
 * @returns a result object for the HTTP layer.
 */
async function setAutostart(enabled) {
  if (!IS_WINDOWS) return { ok: false, error: 'windows-only' };
  const target = autostartTarget();
  if (target === null) return { ok: false, error: 'tray-not-installed' };
  if (!enabled) {
    // `reg delete` fails when the value is already absent; that is the desired
    // end state, so ask first instead of reporting a false failure.
    const current = await runReg(['query', RUN_KEY, '/v', RUN_VALUE]);
    if (!current.ok) return { ok: true, enabled: false, reason: 'not-registered' };
    const removed = await runReg(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
    if (!removed.ok) return { ok: false, error: 'registry-delete-failed', exitCode: removed.code };
    return { ok: true, enabled: false };
  }
  const command = '"' + target.wscript + '" "' + target.vbs + '"';
  const added = await runReg(['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', command, '/f']);
  if (!added.ok) return { ok: false, error: 'registry-write-failed', exitCode: added.code };
  return { ok: true, enabled: true };
}

/**
 * Register one exact-path endpoint with the method and origin guards applied.
 * @param webServer - the host web server service.
 * @param method - the only accepted HTTP method.
 * @param path - the exact path to claim.
 * @param handler - the handler for accepted requests.
 * @returns the disposer returned by the web server.
 */
function register(webServer, method, path, handler) {
  return webServer.register({
    kind: 'exact',
    path,
    handler: (req, res) => {
      if (req.method !== method) {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
        return;
      }
      if (!isTrustedOrigin(req)) {
        sendJson(res, 403, { ok: false, error: 'cross-origin-forbidden' });
        return;
      }
      Promise.resolve()
        .then(() => handler(req, res))
        .catch((error) => {
          // The handler may already have answered and failed afterwards; writing
          // again would throw inside this catch and leave an unhandled rejection.
          if (res.writableEnded === true) return;
          sendJson(res, 500, {
            ok: false,
            error: 'handler-failed',
            detail: String((error && error.message) || error),
          });
        });
    },
  });
}

/**
 * Mount the endpoints. Every registration rides `ctx.inject`, so the plugin is
 * inert on a host without a web server.
 * @param ctx - the plugin context.
 */
export async function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    const server = webCtx.webServer;
    // Resolve the host's bounded shutdown controller once, before any request can
    // claim success. "Reported shutdown, process still running" is exactly the
    // false success this plugin must never produce, so a missing controller is
    // answered honestly rather than papered over with a raw process.exit, which
    // would also skip the web server's asynchronous disposal.
    const exitController = ctx.get('appExit');
    const exitApp = typeof exitController === 'function' ? exitController : null;
    // One lifecycle step rides along with the web server: install the tray half when
    // this package is added. It reports into the status document, so a failure is
    // diagnosable instead of silent. Removing the tray stays a deliberate act - the
    // tray menu, or uninstall.cmd in the install directory - because the plugin cannot
    // reliably notice its own removal: measured on a real machine, the running process
    // kept the plugin and never saw the profile change, so a "detect it and clean up"
    // step was removed in 0.2.1 rather than left in as a promise it could not keep.
    const trayLifecycle = { install: { action: 'pending' } };
    const installTimer = setTimeout(() => {
      ensureTrayInstalled()
        .then((result) => { trayLifecycle.install = result; })
        .catch((error) => { trayLifecycle.install = { action: 'failed', reason: String((error && error.message) || error) }; });
    }, TRAY_INSTALL_DELAY_MS);
    if (typeof installTimer.unref === 'function') installTimer.unref();
    const disposers = [
      register(server, 'GET', PREFIX + '/status', async (req, res) => {
        sendJson(res, 200, {
          ok: true,
          platform: process.platform,
          pid: process.pid,
          supervised: process.env[SUPERVISOR_ENV] === '1',
          autostart: await autostartState(),
          tray: { ...trayState(), install: trayLifecycle.install },
        });
      }),
      register(server, 'POST', PREFIX + '/shutdown', (req, res) => {
        if (exitApp === null) {
          sendJson(res, 503, { ok: false, action: 'shutdown', error: 'no-exit-controller' });
          return;
        }
        sendJson(res, 200, { ok: true, action: 'shutdown' });
        setTimeout(() => requestExit(exitApp, 0), RESPONSE_GRACE_MS);
      }),
      register(server, 'POST', PREFIX + '/restart', (req, res) => {
        if (process.env[SUPERVISOR_ENV] !== '1') {
          sendJson(res, 200, { ok: false, action: 'restart', reason: 'unsupervised' });
          return;
        }
        if (exitApp === null) {
          sendJson(res, 503, { ok: false, action: 'restart', error: 'no-exit-controller' });
          return;
        }
        sendJson(res, 200, { ok: true, action: 'restart' });
        setTimeout(() => requestExit(exitApp, RESTART_EXIT_CODE), RESPONSE_GRACE_MS);
      }),
      register(server, 'POST', PREFIX + '/autostart/enable', async (req, res) => {
        const result = await setAutostart(true);
        sendJson(res, result.ok ? 200 : 409, result);
      }),
      register(server, 'POST', PREFIX + '/autostart/disable', async (req, res) => {
        const result = await setAutostart(false);
        sendJson(res, result.ok ? 200 : 409, result);
      }),
    ];
    return () => {
      clearTimeout(installTimer);
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          /* a failed disposer must not mask the others */
        }
      }
    };
  });
}

/**
 * Ask the host to exit. A controller failure can no longer be reported (the reply
 * is already on the wire) and must not escape: an exception thrown from a timer
 * callback has no catcher. The client therefore verifies the outcome itself.
 * @param exit - the host's exit controller.
 * @param code - the process exit code.
 */
function requestExit(exit, code) {
  try {
    exit(code);
  } catch {
    /* the process stays alive; the client's verification step surfaces that */
  }
}

/**
 * Test seam: the suite drives the automatic install directly, against a scratch
 * script and a scratch %LOCALAPPDATA%, instead of installing a real tray.
 */
export { ensureTrayInstalled, trayState };
