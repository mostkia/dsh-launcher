/**
 * A fake DSH that actually serves the plugin's endpoints, so the tray's
 * supervision probe and both restart paths can be exercised without touching a
 * real DSH. Mode comes from mode.txt next to this file:
 *   supervised   -> status reports supervised:true; POST /restart exits 42
 *   unsupervised -> status reports supervised:false; POST /restart answers ok:false
 * Every request is appended to requests.log for assertions.
 */
import { createServer } from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const portFlag = argv.indexOf('--port');
const port = portFlag >= 0 ? Number(argv[portFlag + 1]) : 3599;
let mode = 'supervised';
try {
  mode = readFileSync(join(here, 'mode.txt'), 'utf8').trim() || mode;
} catch {
  /* keep the default */
}
const supervised = mode === 'supervised';
const log = (line) => appendFileSync(join(here, 'requests.log'), line + '\r\n');

const server = createServer((req, res) => {
  log(`${req.method} ${req.url} (mode=${mode})`);
  if (mode === 'foreign') {
    // A listener that is not our plugin (the route belongs to another plugin, or
    // the plugin failed to load): the tray must fall back to a forced restart and
    // must never claim the plugin confirmed anything.
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }
  if (req.method === 'GET' && req.url === '/_dsh-launcher/status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        platform: 'win32',
        pid: process.pid,
        supervised,
        autostart: { supported: true, enabled: false, reason: 'not-registered' },
      }),
    );
    return;
  }
  if (req.method === 'POST' && req.url === '/_dsh-launcher/restart') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(supervised ? { ok: true, action: 'restart' } : { ok: false, action: 'restart', reason: 'unsupervised' }));
    if (supervised) {
      setTimeout(() => {
        log('exiting with code 42');
        process.exit(42);
      }, 300);
    }
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{}');
});

server.listen(port, '127.0.0.1', () => log(`listening on ${port} mode=${mode}`));

if (!supervised) {
  // A sandboxed test runner cannot taskkill, so in unsupervised mode the child
  // dies on its own shortly after the tray decides to force a restart; the rest
  // of the forced path (wait for the port, start again) is then exercised.
  setTimeout(() => {
    log('self-exit at 10s (unsupervised)');
    process.exit(0);
  }, 10000);
}

// Never outlive the test run.
setTimeout(() => {
  log('self-timeout');
  process.exit(0);
}, 45000);
