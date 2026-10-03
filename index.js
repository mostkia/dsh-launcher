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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
 * Accept only same-origin callers. A browser always sends Origin on a POST, so
 * an external page is rejected; requests without Origin (scripts, curl) pass.
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
  if (LOOPBACK_HOSTS.includes(parsed.hostname)) return true;
  const host = req.headers && req.headers.host;
  return typeof host === 'string' && host !== '' && parsed.host === host;
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
        const code = error !== null && error !== undefined && typeof error.code === 'number' ? error.code : 0;
        resolve({ ok: error === null || error === undefined, code });
      });
    } catch {
      resolve({ ok: false, code: -1 });
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
function autostartTarget() {
  const info = readInstallInfo();
  if (info === null || typeof info.vbs !== 'string' || info.vbs === '') return null;
  const wscript = typeof info.wscript === 'string' && info.wscript !== '' ? info.wscript : 'wscript.exe';
  return { wscript, vbs: info.vbs };
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
    await runReg(['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
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
    const disposers = [
      register(server, 'GET', PREFIX + '/status', async (req, res) => {
        sendJson(res, 200, {
          ok: true,
          platform: process.platform,
          pid: process.pid,
          supervised: process.env[SUPERVISOR_ENV] === '1',
          autostart: await autostartState(),
        });
      }),
      register(server, 'POST', PREFIX + '/shutdown', (req, res) => {
        sendJson(res, 200, { ok: true, action: 'shutdown' });
        setTimeout(() => exitApp(ctx, 0), RESPONSE_GRACE_MS);
      }),
      register(server, 'POST', PREFIX + '/restart', (req, res) => {
        if (process.env[SUPERVISOR_ENV] !== '1') {
          sendJson(res, 200, { ok: false, action: 'restart', reason: 'unsupervised' });
          return;
        }
        sendJson(res, 200, { ok: true, action: 'restart' });
        setTimeout(() => exitApp(ctx, RESTART_EXIT_CODE), RESPONSE_GRACE_MS);
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
 * Request a bounded, graceful process exit through the launcher's controller,
 * falling back to a plain exit only when the host provided no controller.
 * @param ctx - the plugin context.
 * @param code - the process exit code.
 */
function exitApp(ctx, code) {
  const exit = ctx.get('appExit');
  if (typeof exit === 'function') exit(code);
  else process.exit(code);
}
