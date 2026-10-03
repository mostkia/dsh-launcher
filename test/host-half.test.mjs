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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

// Autostart endpoints without an installation -> 409 tray-not-installed, no registry write.
{
  const res = makeRes();
  routes.get(PREFIX + '/autostart/enable')(makeReq('POST', 'http://127.0.0.1:3080'), res);
  await new Promise((r) => setTimeout(r, 200));
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { parsed = null; }
  check('autostart/enable without tray -> 409 tray-not-installed',
    res.statusCode === 409 && parsed !== null && parsed.error === 'tray-not-installed', JSON.stringify(parsed));
}

// A malformed install.json must be treated as "not installed", never crash.
{
  const base = SANDBOX_HOME;
  mkdirSync(base + '\\DSH-Launcher', { recursive: true });
  writeFileSync(base + '\\DSH-Launcher\\install.json', '{ this is not json', 'utf8');
  process.env.LOCALAPPDATA = base;
  const res = makeRes();
  routes.get(PREFIX + '/status')(makeReq('GET'), res);
  await new Promise((r) => setTimeout(r, 80));
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { parsed = null; }
  check('malformed install.json -> still 200, autostart unsupported',
    res.statusCode === 200 && parsed !== null && parsed.autostart.supported === false, JSON.stringify(parsed && parsed.autostart));
  // A well-formed marker is recognised (the registry read stays read-only).
  writeFileSync(base + '\\DSH-Launcher\\install.json', JSON.stringify({ vbs: 'C:\\tmp\\x.vbs', wscript: 'C:\\Windows\\System32\\wscript.exe' }), 'utf8');
  const res2 = makeRes();
  routes.get(PREFIX + '/status')(makeReq('GET'), res2);
  await new Promise((r) => setTimeout(r, 600));
  let parsed2 = null;
  try { parsed2 = JSON.parse(res2.body); } catch { parsed2 = null; }
  check('valid install.json -> status body is the status document (raw: ' + res2.body + ')',
    parsed2 !== null && parsed2.autostart !== undefined && parsed2.autostart.supported === true && parsed2.autostart.target === 'C:\\tmp\\x.vbs',
    JSON.stringify(parsed2));
}

const failed = results.filter((r) => !r.ok);
rmSync(SANDBOX_HOME, { recursive: true, force: true });
console.log('\n' + (failed.length === 0 ? 'ALL PASS' : 'FAILURES: ' + failed.length) + '  (' + results.length + ' checks)');
process.exit(failed.length === 0 ? 0 : 1);
