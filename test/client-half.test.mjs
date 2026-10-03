/**
 * Offline test for the client half: no browser and no DSH.
 *
 * client.js is a browser artifact, so it is exercised here by stubbing the module
 * loader and the client context. That pins the things that would otherwise only
 * be visible in a running page: which seat it registers into, that both locale
 * dictionaries carry the same keys (a missing string shows up as a raw key in
 * the dialog), and that nothing beyond react/react-dom is imported - the plugin
 * rules forbid importing the host's client packages.
 *
 * Run: node test/client-half.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'client.js'), 'utf8');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail === undefined ? '' : '  -> ' + detail));
}

let captured = null;
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      captured = spec;
    },
  },
};
await import(new URL('../client.js', import.meta.url).href);

check('registers a lazy client factory', captured !== null);
check('factory id equals the package name', captured !== null && captured.id === '@mostkia/dsh-launcher', captured === null ? 'no capture' : captured.id);

const required = [];
function fakeRequire(name) {
  required.push(name);
  if (name === 'react') {
    return {
      createElement: () => null,
      Fragment: {},
      useState: (value) => [value, () => {}],
      useEffect: () => {},
      useRef: (value) => ({ current: value }),
      useMemo: (fn) => fn(),
    };
  }
  if (name === 'react-dom') return { createPortal: (element) => element };
  throw new Error('unexpected import: ' + name);
}

const dictionaries = {};
let injectedSlot = null;
let registration = null;
let applied = false;
const ctx = {
  effect(fn) {
    fn();
    return () => {};
  },
  locale: {
    register(namespace, dict) {
      dictionaries[namespace] = dict;
      return () => {};
    },
  },
  slots: {
    inject(name, factory) {
      injectedSlot = name;
      registration = factory();
    },
    register(options, component) {
      registration = { options, component };
      return registration;
    },
  },
};

let plugin = null;
try {
  plugin = captured.factory(fakeRequire);
  check('factory builds a plugin object', plugin !== null && typeof plugin.apply === 'function');
  check('declares the client services it uses', Array.isArray(plugin.inject) && plugin.inject.includes('slots') && plugin.inject.includes('locale'), JSON.stringify(plugin.inject));
  plugin.apply(ctx);
  applied = true;
} catch (error) {
  check('factory + apply run without a browser', false, String((error && error.message) || error));
}

check('registers into the official footer seat', injectedSlot === 'sidebar.footer.action', String(injectedSlot));
check('registration keeps the seat name and an id', applied && registration !== null && registration.options.name === 'sidebar.footer.action' && typeof registration.options.id === 'string', applied && registration !== null ? JSON.stringify(registration.options) : 'not registered');

const dict = dictionaries['dsh-launcher'];
check('registers the zh + en dictionaries', dict !== undefined && dict.zh !== undefined && dict.en !== undefined, Object.keys(dictionaries).join(', '));
if (dict !== undefined && dict.zh !== undefined && dict.en !== undefined) {
  const zhKeys = Object.keys(dict.zh).sort();
  const enKeys = Object.keys(dict.en).sort();
  const missingInZh = enKeys.filter((key) => !(key in dict.zh));
  const missingInEn = zhKeys.filter((key) => !(key in dict.en));
  check('every key exists in both languages', missingInZh.length === 0 && missingInEn.length === 0, 'missing zh: ' + missingInZh.join(',') + ' | missing en: ' + missingInEn.join(','));
  check('dictionary is not empty', zhKeys.length >= 20, zhKeys.length + ' keys');
  const untranslated = zhKeys.filter((key) => dict.zh[key] === dict.en[key]);
  check('no zh string is a copy of the en one', untranslated.length === 0, untranslated.join(', '));
}

check('imports nothing beyond react/react-dom', required.every((name) => name === 'react' || name === 'react-dom'), required.join(', '));
check('never imports a host client package', !/require\(\s*['"]@deepseek-ai/.test(source));
check('power glyph follows the host icon language', source.includes("viewBox: '0 0 16 16'") && source.includes("stroke: 'currentColor'") && source.includes('strokeLinecap'));
check('styles come from theme tokens only', !/#[0-9a-fA-F]{6}\b/.test(source.replace(/\/\*[\s\S]*?\*\//g, '')));

const failed = results.filter((r) => !r.ok);
console.log('\n' + (failed.length === 0 ? 'ALL PASS' : 'FAILURES: ' + failed.length) + '  (' + results.length + ' checks)');
process.exit(failed.length === 0 ? 0 : 1);
