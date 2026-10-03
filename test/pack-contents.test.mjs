/**
 * Published-contents check: the tarball must carry the runtime files and nothing
 * that belongs to the repository only.
 *
 * Usage (the JSON is what npm prints, so this also documents what users get):
 *   npm pack --dry-run --json > pack.json          # add --cache <dir> in a confined shell
 *   node test/pack-contents.test.mjs pack.json
 *
 * Also run by .github/workflows/tests.yml, which is why it is a script instead of
 * a `node -e` one-liner: a repository with "type": "module" makes `require`
 * unavailable to `--eval`, and this file is plain ESM.
 */
import { readFileSync } from 'node:fs';

const target = process.argv[2];
if (target === undefined) {
  console.error('usage: node test/pack-contents.test.mjs <pack.json>');
  process.exit(2);
}

const results = [];
function check(name, ok, detail) {
  results.push(ok);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined || detail === '' ? '' : '  -> ' + detail));
}

const [entry] = JSON.parse(readFileSync(target, 'utf8'));
const paths = entry.files.map((file) => file.path);
const tray = paths.filter((path) => path.startsWith('tray/'));
const locale = paths.filter((path) => path.startsWith('locale/'));

check('carries the runtime entry points', ['index.js', 'client.js', 'cordis.patch.yml', 'package.json', 'icon.svg'].every((path) => paths.includes(path)));
check('carries both locale files', locale.length === 2, locale.join(', '));
check('carries the whole tray (script, strings, vbs, icon, installer, uninstaller)', tray.length === 8, String(tray.length));
check('carries both READMEs and the licence', ['README.md', 'README.zh.md', 'LICENSE'].every((path) => paths.includes(path)));

const forbidden = paths.filter((path) => /^(test|tools|docs|\.github|node_modules)\//.test(path) || path.endsWith('.tgz'));
check('carries nothing repository-only', forbidden.length === 0, forbidden.join(', '));
check('entry count matches the documented package (18)', entry.files.length === 18, String(entry.files.length));

const failed = results.filter((ok) => !ok).length;
console.log('\n' + (failed === 0 ? 'PACK CONTENTS PASS' : 'PACK CONTENTS FAIL: ' + failed + ' check(s)'));
process.exit(failed === 0 ? 0 : 1);
