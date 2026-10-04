/**
 * Zero-risk harness for the @mostkia/dsh-launcher host half.
 * Stubs the cordis context and the web server, then exercises every endpoint:
 * routing, method guard, CSRF guard, supervisor detection and graceful exit.
 *
 * Hermetic on purpose: %LOCALAPPDATA% is redirected to a scratch directory before
 * any check runs. Without that, a machine that really has the tray installed
 * makes the "no tray yet" checks false - and the autostart-enable check would
 * write the runner's own HKCU Run entry, i.e. the test would change the machine
 * it is testing on. With the redirection the "not installed" state is true here
 * and the enable path is rejected before it can reach the registry.
 *
 * Run: node test/host-half.test.mjs
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'dsh-launcher-hosttest-'));
process.env.LOCALAPPDATA = SANDBOX_HOME;

const MODULE_URL = new URL('../index.js', import.meta.url).href;
const PREFIX = '/_dsh-launcher';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : '  -> ' + detail));
}

function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) { this.headers[key] = value; },
    end(chunk) { this.body = chunk === undefined ? '' : String(chunk); },
  };
}

function makeReq(method, origin, host) {
  const headers = {};
  if (origin !== undefined) headers.origin = origin;
  headers.host = host === undefined ? '127.0.0.1:3080' : host;
  return { method, headers };
}

const routes = new Map();
const exits = [];
const appExit = (code) => exits.push(code);
const ctx = {
  inject(names, callback) {
    if (!names.includes('webServer')) throw new Error('unexpected inject: ' + names.join(','));
    return callback({
      webServer: {
        register(spec) {
          if (routes.has(spec.path)) throw new Error('duplicate route: ' + spec.path);
          routes.set(spec.path, spec.handler);
          return () => routes.delete(spec.path);
        },
      },
    });
  },
  get(name) { return name === 'appExit' ? appExit : undefined; },
};

// The plugin installs and removes its own tray half at runtime, and apply() starts
// those timers. Point both steps at scratch scripts BEFORE apply() runs: the default
// would invoke the real tray/install.ps1, which creates a desktop shortcut.
//
// The documented opt-out is set for the whole harness so the background install can
// never race the checks below; the lifecycle block turns it off for its own calls.
const LIFECYCLE_CALLS = join(SANDBOX_HOME, 'lifecycle-calls.txt');
const FAKE_INSTALLER = join(SANDBOX_HOME, 'fake-install.ps1');
const INSTALLED_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
writeFileSync(
  FAKE_INSTALLER,
  [
    "$dir = Join-Path $env:LOCALAPPDATA 'DSH-Launcher'",
    'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
    // WriteAllText, not Set-Content: Windows PowerShell 5.1 writes a BOM with
    // -Encoding UTF8, and a BOM makes the marker unparseable for JSON.parse.
    "[System.IO.File]::WriteAllText((Join-Path $dir 'install.json'), '{\"version\":\"" + INSTALLED_VERSION + "\"}')",
    "New-Item -ItemType File -Force -Path (Join-Path $dir 'dsh-launcher-tray.ps1') | Out-Null",
    "New-Item -ItemType File -Force -Path (Join-Path $dir 'uninstall.ps1') | Out-Null",
    "Add-Content -LiteralPath '" + LIFECYCLE_CALLS + "' -Value 'install'",
    '',
  ].join('\r\n'),
  'utf8',
);
process.env.DSH_LAUNCHER_TRAY_INSTALLER = FAKE_INSTALLER;
process.env.DSH_LAUNCHER_NO_TRAY_INSTALL = '1';

const mod = await import(MODULE_URL);
await mod.apply(ctx);
check('exports apply', typeof mod.apply === 'function');
check('registers 5 endpoints', routes.size === 5, [...routes.keys()].join(' '));
check('owns its namespace only', [...routes.keys()].every((p) => p.startsWith(PREFIX)));

// GET status -> 200 with the documented shape.
{
  const res = makeRes();
  routes.get(PREFIX + '/status')(makeReq('GET'), res);
  await new Promise((r) => setTimeout(r, 60));
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { parsed = null; }
  check('GET /status -> 200', res.statusCode === 200, 'status=' + res.statusCode);
  check('status body shape', parsed !== null && parsed.ok === true && typeof parsed.pid === 'number' && typeof parsed.supervised === 'boolean',
    JSON.stringify(parsed));
  check('no install.json -> autostart unsupported',
    parsed !== null && parsed.autostart && parsed.autostart.supported === false && parsed.autostart.enabled === false,
    parsed === null ? 'no body' : JSON.stringify(parsed.autostart));
}

// GET on a POST-only path -> 405.
{
  const res = makeRes();
  routes.get(PREFIX + '/shutdown')(makeReq('GET'), res);
  check('GET /shutdown -> 405', res.statusCode === 405, 'status=' + res.statusCode);
}

// Foreign Origin -> 403.
{
  const res = makeRes();
  routes.get(PREFIX + '/shutdown')(makeReq('POST', 'http://evil.example'), res);
  check('cross-origin POST -> 403', res.statusCode === 403, 'status=' + res.statusCode);
}

// Same-origin (loopback) is accepted.
{
  const res = makeRes();
  routes.get(PREFIX + '/shutdown')(makeReq('POST', 'http://127.0.0.1:3080'), res);
  await new Promise((r) => setTimeout(r, 30));
  check('loopback-origin POST -> 200', res.statusCode === 200, 'status=' + res.statusCode + ' body=' + res.body);
  await new Promise((r) => setTimeout(r, 420));
  check('shutdown asks appExit(0) after the grace delay', exits.includes(0), 'exits=' + JSON.stringify(exits));
}

// Restart without a supervisor must not exit.
{
  delete process.env.DSH_LAUNCHER_SUPERVISED;
  const before = exits.length;
  const res = makeRes();
  routes.get(PREFIX + '/restart')(makeReq('POST', 'http://127.0.0.1:3080'), res);
  await new Promise((r) => setTimeout(r, 420));
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { parsed = null; }
  check('unsupervised restart -> 200 ok:false', res.statusCode === 200 && parsed !== null && parsed.ok === false && parsed.reason === 'unsupervised',
    JSON.stringify(parsed));
  check('unsupervised restart never exits', exits.length === before, 'exits=' + JSON.stringify(exits));
}

// Restart with the supervisor marker exits with 42.
{
  process.env.DSH_LAUNCHER_SUPERVISED = '1';
  const res = makeRes();
  routes.get(PREFIX + '/restart')(makeReq('POST', 'http://127.0.0.1:3080'), res);
  await new Promise((r) => setTimeout(r, 420));
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { parsed = null; }
  check('supervised restart -> 200 ok:true', res.statusCode === 200 && parsed !== null && parsed.ok === true, JSON.stringify(parsed));
  check('supervised restart asks appExit(42)', exits.includes(42), 'exits=' + JSON.stringify(exits));
  delete process.env.DSH_LAUNCHER_SUPERVISED;
}

// Autostart is Windows-only, and the plugin says so instead of pretending. These
// assertions therefore have two arms: the CI matrix runs this suite on Linux too,
// where the first push showed them expecting Windows behaviour everywhere.
const ON_WINDOWS = process.platform === 'win32';

// Without an installation the plugin cannot register anything: 409 tray-not-installed
// on Windows, 409 windows-only elsewhere - either way nothing reaches a registry.
{
  const res = makeRes();
  routes.get(PREFIX + '/autostart/enable')(makeReq('POST', 'http://127.0.0.1:3080'), res);
  await new Promise((r) => setTimeout(r, 200));
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { parsed = null; }
  const expected = ON_WINDOWS ? 'tray-not-installed' : 'windows-only';
  check('autostart/enable without a tray -> 409 ' + expected,
    res.statusCode === 409 && parsed !== null && parsed.error === expected, JSON.stringify(parsed));
}

// A malformed install.json must be treated as "not installed", never crash.
{
  const base = SANDBOX_HOME;
  // join(), not string concatenation with a backslash: on Linux a hardcoded "\\"
  // is a literal character in a file name, so the directory the test created and
  // the one the plugin looks for were different and the Linux CI job failed.
  mkdirSync(join(base, 'DSH-Launcher'), { recursive: true });
  writeFileSync(join(base, 'DSH-Launcher', 'install.json'), '{ this is not json', 'utf8');
  process.env.LOCALAPPDATA = base;
  const res = makeRes();
  routes.get(PREFIX + '/status')(makeReq('GET'), res);
  await new Promise((r) => setTimeout(r, 80));
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { parsed = null; }
  check('malformed install.json -> still 200, autostart unsupported',
    res.statusCode === 200 && parsed !== null && parsed.autostart.supported === false, JSON.stringify(parsed && parsed.autostart));
  // A well-formed marker is recognised (the registry read stays read-only).
  writeFileSync(join(base, 'DSH-Launcher', 'install.json'), JSON.stringify({ vbs: 'C:\\tmp\\x.vbs', wscript: 'C:\\Windows\\System32\\wscript.exe' }), 'utf8');
  const res2 = makeRes();
  routes.get(PREFIX + '/status')(makeReq('GET'), res2);
  await new Promise((r) => setTimeout(r, 600));
  let parsed2 = null;
  try { parsed2 = JSON.parse(res2.body); } catch { parsed2 = null; }
  check('valid install.json -> status body is the status document (raw: ' + res2.body + ')',
    parsed2 !== null && parsed2.autostart !== undefined && (ON_WINDOWS
      ? parsed2.autostart.supported === true && parsed2.autostart.target === 'C:\\tmp\\x.vbs'
      : parsed2.autostart.supported === false && parsed2.autostart.reason === 'windows-only'),
    JSON.stringify(parsed2));

  // Disabling when nothing is registered must report success *and* not write: the
  // value is genuinely absent on this machine, so `reg delete` would fail and the
  // old code reported that as a failure (and would have been a false one).
  const res3 = makeRes();
  routes.get(PREFIX + '/autostart/disable')(makeReq('POST', 'http://127.0.0.1:3080'), res3);
  await new Promise((r) => setTimeout(r, 600));
  let parsed3 = null;
  try { parsed3 = JSON.parse(res3.body); } catch { parsed3 = null; }
  check(ON_WINDOWS ? 'autostart/disable while absent -> 200 ok:true' : 'autostart/disable off Windows -> 409 windows-only',
    ON_WINDOWS
      ? res3.statusCode === 200 && parsed3 !== null && parsed3.ok === true && parsed3.enabled === false
      : res3.statusCode === 409 && parsed3 !== null && parsed3.error === 'windows-only',
    JSON.stringify(parsed3));
}

// A rebinding-shaped Origin (the page's host resolves to the loopback address) must
// not be accepted just because it matches the Host header: that was the hole the
// 2026-10-03 review found.
{
  const res = makeRes();
  routes.get(PREFIX + '/shutdown')(makeReq('POST', 'http://evil.example', 'evil.example'), res);
  check('rebinding origin (origin host == Host) -> 403', res.statusCode === 403, 'status=' + res.statusCode + ' body=' + res.body);
  const res2 = makeRes();
  routes.get(PREFIX + '/shutdown')(makeReq('POST', 'https://evil.example:3080', 'evil.example:3080'), res2);
  check('rebinding origin with port -> 403', res2.statusCode === 403, 'status=' + res2.statusCode);
  const res3 = makeRes();
  routes.get(PREFIX + '/shutdown')(makeReq('POST', 'null'), res3);
  check('opaque origin ("null") -> 403', res3.statusCode === 403, 'status=' + res3.statusCode);
}

// Without the host's exit controller the endpoints must refuse instead of
// answering 200 and leaving the process running ("reported shutdown" was the
// false-success shape the review flagged).
{
  const plainRoutes = new Map();
  const noExitCtx = {
    inject(names, callback) {
      return callback({
        webServer: {
          register(spec) {
            plainRoutes.set(spec.path, spec.handler);
            return () => plainRoutes.delete(spec.path);
          },
        },
      });
    },
    get() {
      return undefined;
    },
  };
  await mod.apply(noExitCtx);
  const res = makeRes();
  plainRoutes.get(PREFIX + '/shutdown')(makeReq('POST', 'http://127.0.0.1:3080'), res);
  await new Promise((r) => setTimeout(r, 60));
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { parsed = null; }
  check('no exit controller -> shutdown answers 503, not 200',
    res.statusCode === 503 && parsed !== null && parsed.ok === false && parsed.error === 'no-exit-controller', JSON.stringify(parsed));
  process.env.DSH_LAUNCHER_SUPERVISED = '1';
  const res2 = makeRes();
  plainRoutes.get(PREFIX + '/restart')(makeReq('POST', 'http://127.0.0.1:3080'), res2);
  await new Promise((r) => setTimeout(r, 60));
  let parsed2 = null;
  try { parsed2 = JSON.parse(res2.body); } catch { parsed2 = null; }
  check('no exit controller -> restart answers 503, not 200',
    res2.statusCode === 503 && parsed2 !== null && parsed2.error === 'no-exit-controller', JSON.stringify(parsed2));
  delete process.env.DSH_LAUNCHER_SUPERVISED;
}

// ---------------------------------------------------------------- tray lifecycle
// Adding the package should be enough: the plugin installs its own tray half, and
// takes it away again when the package is removed. Both steps run here against the
// scratch scripts set up at the top, so no real tray is installed or removed - and
// the whole block is Windows-only, because the tray is: on Linux both steps must
// report `windows-only` instead of pretending (the CI matrix runs this suite there).
if (ON_WINDOWS) {
  const { ensureTrayInstalled, trayState } = mod;
  const trayDir = join(SANDBOX_HOME, 'DSH-Launcher');
  const callLines = () => (existsSync(LIFECYCLE_CALLS) ? readFileSync(LIFECYCLE_CALLS, 'utf8').split(/\r?\n/).filter(Boolean) : []);

  // Let the install timer apply() started run its course: with the opt-out in place it
  // must report the skip, which is what proves the timer is wired and reporting.
  await new Promise((r) => setTimeout(r, 1700));
  {
    const res = makeRes();
    routes.get(PREFIX + '/status')(makeReq('GET'), res);
    await new Promise((r) => setTimeout(r, 60));
    const parsed = JSON.parse(res.body);
    check('status reports what the automatic install did',
      parsed.tray !== undefined && parsed.tray.install !== undefined && parsed.tray.install.reason === 'disabled-by-env',
      JSON.stringify(parsed.tray && parsed.tray.install));
  }

  delete process.env.DSH_LAUNCHER_NO_TRAY_INSTALL;
  rmSync(trayDir, { recursive: true, force: true });
  check('a tray that is not there does not read as installed', trayState().installed === false, JSON.stringify(trayState()));

  const first = await ensureTrayInstalled();
  check('missing tray -> installed automatically', first.action === 'installed' && first.version === INSTALLED_VERSION, JSON.stringify(first));
  check('the installer really ran', callLines().filter((l) => l === 'install').length === 1, callLines().join(','));
  check('and the tray now reads as up to date', trayState().upToDate === true, JSON.stringify(trayState()));

  const second = await ensureTrayInstalled();
  check('an up-to-date tray is left alone', second.action === 'skipped' && second.reason === 'already-installed', JSON.stringify(second));
  check('so the installer did not run again', callLines().filter((l) => l === 'install').length === 1, callLines().join(','));

  // A tray from an older release is updated in place. (mkdirSync first: if an earlier
  // install failed - a sandbox that refuses to spawn PowerShell, say - these checks
  // should report failures rather than crash the suite with ENOENT.)
  mkdirSync(trayDir, { recursive: true });
  writeFileSync(join(trayDir, 'install.json'), JSON.stringify({ version: '0.0.1' }), 'utf8');
  const third = await ensureTrayInstalled();
  check('a tray from an older release is updated', third.action === 'updated' && third.version === INSTALLED_VERSION, JSON.stringify(third));

  writeFileSync(join(trayDir, 'install.json'), JSON.stringify({ version: '0.0.1' }), 'utf8');
  process.env.DSH_LAUNCHER_NO_TRAY_INSTALL = '1';
  const fourth = await ensureTrayInstalled();
  delete process.env.DSH_LAUNCHER_NO_TRAY_INSTALL;
  check('DSH_LAUNCHER_NO_TRAY_INSTALL=1 disables the automatic install',
    fourth.action === 'skipped' && fourth.reason === 'disabled-by-env', JSON.stringify(fourth));

  // Installing always installs everything: a removed tray therefore comes back on the
  // next DSH start, which is what a reinstall should do.
  rmSync(trayDir, { recursive: true, force: true });
  const fifth = await ensureTrayInstalled();
  check('a removed tray is installed again on the next start',
    fifth.action === 'installed' && fifth.version === INSTALLED_VERSION, JSON.stringify(fifth));

  {
    const res = makeRes();
    routes.get(PREFIX + '/status')(makeReq('GET'), res);
    await new Promise((r) => setTimeout(r, 60));
    const parsed = JSON.parse(res.body);
    check('status carries the tray state for diagnosis',
      parsed.tray !== undefined && parsed.tray.installed === true && parsed.tray.expected === INSTALLED_VERSION,
      JSON.stringify(parsed.tray));
  }
} else {
  const skipped = await mod.ensureTrayInstalled();
  check('off Windows the automatic install reports windows-only',
    skipped.action === 'skipped' && skipped.reason === 'windows-only', JSON.stringify(skipped));
  const state = mod.trayState();
  check('off Windows the tray state says unsupported', state.supported === false && state.installed === false, JSON.stringify(state));
}

const failed = results.filter((r) => !r.ok);
rmSync(SANDBOX_HOME, { recursive: true, force: true });
console.log('\n' + (failed.length === 0 ? 'ALL PASS' : 'FAILURES: ' + failed.length) + '  (' + results.length + ' checks)');
process.exit(failed.length === 0 ? 0 : 1);
