// Static checks on demos/stadium-walker.html: does its module parse, and is the session actually going to
// disk. The store itself is tested by test-disk-store.mjs; this covers the wiring, which Node cannot import.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const html = readFileSync(new URL('./demos/stadium-walker.html', import.meta.url), 'utf8');
let pass = 0, fail = 0;
const problems = [];
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; return true; }
  fail++; problems.push(`${label}${detail ? ' — ' + detail : ''}`);
  return false;
};

const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
ok(!!m, 'the page has a module script');
const js = m[1];

const tmp = join(tmpdir(), 'stadium-walker-check.mjs');
try {
  writeFileSync(tmp, js);
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  ok(true, 'the module script parses');
} catch (e) {
  ok(false, 'the module script parses', String(e.stderr || e.message).replace(/\s+/g, ' ').slice(0, 240));
} finally {
  try { unlinkSync(tmp); } catch {}
}

// ---- the session goes to a file ---------------------------------------------------------------------
ok(/from '\.\.\/disk-store\.js'/.test(js), 'the page uses the disk store');
ok(/await Promise\.all\(\[store\.load\(\), trialStore\.load\(\)\]\)/.test(js),
  'both documents are read before anything uses them',
  'reading them later would let an empty default overwrite the file');

// The four things this page authors, each pointing at the document rather than at a storage key.
for (const [name, expr] of [['bone roles', 'const roleDocs = session.roles'], ['poses', 'const poseSets = session.poses'],
                            ['setpoints', 'const setpoints = session.setpoints'], ['panel state', 'session.prefs = data']]) {
  ok(js.includes(expr), `${name} live in the saved document`, expr);
}
ok(/createTrialLog\(trialStore\.asStorage\(\)\)/.test(js), 'the trial log writes through the store too');

// localStorage may appear ONLY as the store's fallback cache and in the one-time carry-over. Anything else
// is a page saving somewhere that does not survive a cleared browser, which is the bug this fixes.
const uses = [...js.matchAll(/localStorage/g)].map((x) => {
  const line = js.slice(0, x.index).split('\n').length;
  return js.split('\n')[line - 1].trim();
});
const stray = uses.filter((l) => !/^storage: localStorage/.test(l) && !/legacyDoc|const get = \(k\)/.test(l)
  && !l.startsWith('//'));
ok(stray.length === 0, 'localStorage is only the fallback cache, never a store', stray.join(' | '));
ok(/function legacyDoc\(\)/.test(js), 'the four old browser keys still carry over once, so nothing is lost');

// ---- the panel says where it went --------------------------------------------------------------------
const domIds = new Set([...html.matchAll(/\sid="([\w-]+)"/g)].map((x) => x[1]));
for (const id of ['saveState', 'saveNow', 'saveSnapshot']) {
  ok(domIds.has(id) && js.includes(`'${id}'`), `#${id} exists and is wired`);
}
ok(/store\.onStatus\(refreshSaveState\)/.test(js), 'the status line follows the store rather than a timer');
ok(/addEventListener\('pagehide'/.test(js) && /sendBeacon/.test(js),
  'a closing tab flushes with a beacon',
  'fetch is cancelled during unload, so a debounced autosave would lose the last edit');

// ---- the server accepts exactly these names ----------------------------------------------------------
const serve = readFileSync(new URL('./serve.py', import.meta.url), 'utf8');
ok(/_SAFE_STADIUM_FILENAME/.test(serve) && /def save_stadium/.test(serve), 'serve.py has the write route');
// The page posts template literals, so compare the constants behind them against the server's whitelist —
// a rename on one side and not the other is a silent 400 and a lost session.
const names = [...js.matchAll(/const (?:TUNING|TRIALS)_FILE = '([^']+)'/g)].map((x) => x[1]);
ok(names.length === 2, 'the page names both files as constants', names.join(', '));
const pattern = serve.match(/_SAFE_STADIUM_FILENAME = re\.compile\(\s*r'([^']+)'/s)?.[1] ?? '';
const re = new RegExp(pattern);
for (const n of names) ok(re.test(n), `the server accepts ${n}`, `against ${pattern}`);
const snapshot = js.match(/`stadium-tuning-\$\{stamp\}\.json`/) ? 'stadium-tuning-20260818-120000.json' : null;
ok(snapshot && re.test(snapshot), 'and the timestamped snapshot name the button builds');

console.log(`${pass}/${pass + fail} static checks passed on demos/stadium-walker.html`);
if (fail) {
  console.log('\nPROBLEMS:');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
