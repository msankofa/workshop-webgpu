// Checks for pokemon-map-scope.js — what counts as this subsystem, and what imports what.
//
// These run against the REAL repo listing rather than a fixture, for the same reason the rig tests read
// the real models: a fixture built from my idea of what is on disk would agree with my idea. That also
// makes them catch the thing most likely to go wrong — a rule that stops matching after a rename, or an
// import edge that outlives the import.
//
// The layout and rendering are NOT tested here, because they are not ours: the Map tab is
// `tools/filesystem-map.html` in an iframe, and this module only tells that page what to show.

import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import {
  GROUPS, GROUP_BY_ID, defaultToggles, groupOf, noteOf, selectEntries, edgesFor, testEdges,
  IMPORT_EDGES, COLLAPSE, groupCounts,
} from './pokemon-map-scope.js';

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
};
const eq = (a, b, label) => ok(Object.is(a, b), `${label}${Object.is(a, b) ? '' : ` — got ${a}, wanted ${b}`}`);

// ===================== a real scan of this repo =====================
// Same walk /api/fs-scan does: skip dotfiles, node_modules and __pycache__.

const SKIP = new Set(['node_modules', '__pycache__']);
function walk(dir, base = '', out = []) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || SKIP.has(name)) continue;
    const full = `${dir}/${name}`;
    const rel = base ? `${base}/${name}` : name;
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      out.push({ path: rel, type: 'dir', size: 0, mtime: st.mtimeMs / 1000, ctime: st.ctimeMs / 1000 });
      walk(full, rel, out);
    } else {
      out.push({ path: rel, type: 'file', size: st.size, mtime: st.mtimeMs / 1000, ctime: st.ctimeMs / 1000 });
    }
  }
  return out;
}

console.log('\nscanning the repo…');
const entries = walk('.');
console.log(`  ${entries.length} entries\n`);

// ===================== scope: the rules =====================
console.log('\npokemon-map-scope — the rules');

eq(groupOf('pokemon-rig.js'), 'lab', 'a lab module is in the lab');
eq(groupOf('pokemon-lab.html'), 'lab', 'the page is in the lab');
eq(groupOf('test-pokemon-hang.mjs'), 'lab', 'a lab test is in the lab');
eq(groupOf('_check_pokemon-lab.html.mjs'), 'lab', 'the static check is in the lab');
eq(groupOf('docs/pokemon-lab/math.md'), 'docs', 'a lab doc is in docs');
eq(groupOf('docs/subsystems/pokemon-lab.md'), 'docs', 'the subsystem doc is in docs');
eq(groupOf('stadium-glb.js'), 'borrowed', 'a borrowed module is marked borrowed');
eq(groupOf('ragdoll.js'), 'borrowed', 'ragdoll.js is borrowed, not owned');
eq(groupOf('moves/fx-bolt.js'), 'moves', 'a moves effect is in moves');
eq(groupOf('pokemon-park-old/park-species.js'), 'old', 'an archived module is in the archive');
eq(groupOf('models/stadium/001_bulbasaur.glb'), 'data', 'a model is data');
eq(groupOf('bot-entity.js'), null, 'an unrelated file belongs to no group');
eq(groupOf('docs/subsystems/terrain.md'), null, 'an unrelated doc belongs to no group');

// Location beats role, which is what keeps the toggles predictable.
eq(groupOf('pokemon-park-old/test-fx-bolt.mjs'), 'old',
  'a moves test living in the archive is drawn in the archive');
ok(/archive/i.test(noteOf('pokemon-park-old/test-fx-bolt.mjs') || ''),
  'and a note says what it actually is');
ok(/imported by nothing/i.test(noteOf('pokemon-pose.js') || ''), 'the orphan module is called out');
ok(noteOf('pokemon-rig.js') === null, 'an ordinary file gets no note');

// The rules have to match what is actually on disk today.
console.log('\npokemon-map-scope — against the real repo');
{
  const paths = entries.map(e => e.path);
  const labFiles = paths.filter(p => groupOf(p) === 'lab');
  ok(labFiles.includes('pokemon-lab.html'), 'the real page is picked up');
  ok(labFiles.includes('pokemon-rig.js'), 'the real rig module is picked up');
  // Every pokemon-*.js at the root must be caught, or a new module silently misses the map.
  const rootModules = paths.filter(p => /^pokemon-[a-z0-9-]+\.js$/.test(p));
  ok(rootModules.length >= 8, `every root pokemon module matches the rule (${rootModules.length} found)`);
  ok(rootModules.every(p => groupOf(p) === 'lab'), 'and all of them land in the lab group');
  const labTests = paths.filter(p => /^test-pokemon-/.test(p));
  ok(labTests.length >= 8 && labTests.every(p => groupOf(p) === 'lab'),
    `every lab test matches (${labTests.length} found)`);
}

{
  // Borrowed files are the one hand-written list, so assert they still exist.
  for (const p of ['stadium-glb.js', 'disk-store.js', 'ragdoll.js', 'environment-audio.js', 'serve.py', 'tools/filesystem-map.html', 'workshop-panel-theme.js']) {
    ok(existsSync(p), `the borrowed file ${p} still exists`);
  }
}

{
  // Import edges are facts about the code. If one goes stale the map lies, so check them against source.
  for (const [from, to] of IMPORT_EDGES) {
    ok(existsSync(from), `${from} exists`);
    const src = readFileSync(from, 'utf8');
    ok(src.includes(`./${to}`), `${from} really imports ${to}`);
  }
}

{
  // And the other direction: every module the page imports must appear as an edge, so a new import
  // cannot quietly go undrawn.
  const page = readFileSync('pokemon-lab.html', 'utf8');
  const imported = [...page.matchAll(/from '\.\/([a-z0-9.-]+\.js)'/g)].map(m => m[1]);
  const drawn = new Set(IMPORT_EDGES.filter(([f]) => f === 'pokemon-lab.html').map(([, t]) => t));
  for (const mod of new Set(imported)) {
    ok(drawn.has(mod), `the page's import of ${mod} is drawn on the map`);
  }
}

// ===================== scope: selection and toggles =====================
console.log('\npokemon-map-scope — selection');

{
  const all = selectEntries(entries, defaultToggles());
  const paths = new Set(all.map(e => e.path));
  ok(paths.has('pokemon-lab.html'), 'the default selection includes the page');
  ok(!paths.has('moves/fx-bolt.js'), 'moves is off by default');
  ok(!paths.has('pokemon-park-old/park-species.js'), 'the archive is off by default');
  ok(paths.has('models/stadium'), 'the collapsed model directory is present as one node');
  ok(![...paths].some(p => p.startsWith('models/stadium/')), 'and none of its 151 files are');
  const collapsed = all.find(e => e.path === 'models/stadium');
  eq(collapsed.count, 153, 'the collapsed node counts every file, including both data files');
  ok(collapsed.size > 1e7, 'and the real total size');
  // The label must not round the manifest and phenomena sidecar into the model count — 153 models is a lie.
  eq(collapsed.label, '151 .glb and 2 more', 'the label counts extensions rather than assuming');
}

{
  const on = selectEntries(entries, { ...defaultToggles(), moves: true, old: true });
  const paths = new Set(on.map(e => e.path));
  ok(paths.has('moves/fx-bolt.js'), 'turning moves on brings the effects in');
  ok(paths.has('moves'), 'and the directory they live in');
  ok(paths.has('pokemon-park-old/park-species.js'), 'turning the archive on brings it in');
  ok(paths.has('pokemon-park-old'), 'and its directory');
}

{
  // A group turned off must take its folder with it, or an unlabelled hub floats where files were.
  const off = selectEntries(entries, { ...defaultToggles(), moves: false });
  ok(!off.some(e => e.path === 'moves'), 'turning moves off removes its directory too');
}

{
  const none = selectEntries(entries, { lab: false, docs: false, data: false, borrowed: false, moves: false, old: false });
  eq(none.length, 0, 'turning everything off yields an empty map rather than an error');
}

eq(selectEntries(null, defaultToggles()).length, 0, 'a null scan does not throw');
eq(selectEntries([{ type: 'file' }], defaultToggles()).length, 0, 'an entry with no path is skipped');

{
  const counts = groupCounts(selectEntries(entries, { ...defaultToggles(), moves: true, old: true }));
  ok(counts.lab >= 15, `the lab group counts its files (${counts.lab})`);
  ok(counts.moves >= 19, `the moves group counts its files (${counts.moves})`);
  ok(counts.old >= 30, `the archive counts its files (${counts.old})`);
  eq(counts.borrowed, 10, 'the borrowed group is exactly the hand-listed files');
}

// ===================== scope: edges =====================
console.log('\npokemon-map-scope — edges');

{
  const paths = selectEntries(entries, defaultToggles()).map(e => e.path);
  const edges = edgesFor(paths);
  ok(edges.length > 0, 'the default view has edges to draw');
  ok(edges.every(e => paths.includes(e.from) && paths.includes(e.to)),
    'every edge joins two nodes that are actually on screen');
  ok(edges.some(e => e.kind === 'import'), 'import edges are drawn');
  ok(edges.some(e => e.kind === 'test'), 'test edges are drawn');
}

{
  const pairs = testEdges(['test-pokemon-rig.mjs', 'pokemon-rig.js', 'test-pokemon-gone.mjs']);
  eq(pairs.length, 1, 'a test whose subject is not on screen draws no edge');
  eq(pairs[0][1], 'pokemon-rig.js', 'a test points at the module it checks');
  const check = testEdges(['_check_pokemon-lab.html.mjs', 'pokemon-lab.html']);
  eq(check[0][1], 'pokemon-lab.html', 'the static check points at the page');
}

{
  const paths = selectEntries(entries, defaultToggles()).map(e => e.path);
  eq(edgesFor(paths, { imports: false, tests: false }).length, 0, 'both edge kinds can be turned off');
  ok(edgesFor(paths, { imports: true, tests: false }).every(e => e.kind === 'import'),
    'turning tests off leaves only imports');
}

// ===================== groups =====================
console.log('\npokemon-map-scope — the groups');

ok(GROUPS.length === 6, 'there are six groups');
ok(GROUPS.every(g => g.label && g.hint && Number.isInteger(g.color)),
  'every group has a label, a hint and a colour');
ok(GROUP_BY_ID.get('lab').locked, 'the lab group cannot be turned off');
ok(GROUPS.filter(g => g.on).map(g => g.id).join(',') === 'lab,docs,data,borrowed',
  'moves and the archive are the two that start off');
ok(COLLAPSE.includes('models/stadium'), 'the model directory is the one that collapses');
{
  const t = defaultToggles();
  eq(Object.keys(t).length, 6, 'the default toggles cover every group');
  ok(t.lab === true && t.moves === false, 'and match what the groups declare');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
