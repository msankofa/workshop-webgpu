// Which files count as "Pokemon Lab", and which are the neighbours. Pure: no THREE, no DOM, no fetch.
//
// This is a set of RULES rather than a list of filenames, because the list goes stale faster than anyone
// updates it — the Lab gained five modules in one night. A rule picks up `pokemon-gates.js` the day it is
// written, and a file that stops matching drops out on its own.
//
// Group is a ROLE and path is a FACT, and where they disagree the path wins: the moves tests physically
// live in `pokemon-park-old/`, so they are drawn inside the archive with a note saying what they are.
// Making the toggles follow location keeps them predictable — turning off `old` empties that cluster and
// nothing else.

/** A file's extension, for the collapsed-directory label. Local so this module imports nothing. */
function extOf(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '(none)';
}

/** Directories shown as a single weighted node rather than expanded into their contents. */
export const COLLAPSE = ['models/stadium'];

export const GROUPS = [
  { id: 'lab', label: 'Lab', color: 0x5fd08a, on: true, locked: true,
    hint: 'The page, its modules and their tests.' },
  { id: 'docs', label: 'Docs', color: 0x5fa8d0, on: true,
    hint: 'The subsystem reference, the v1 plan, the maths and the pipeline map.' },
  { id: 'data', label: 'Data', color: 0xc98fd0, on: true,
    hint: 'The 151 models and the directory the annotation library is saved into.' },
  { id: 'borrowed', label: 'Borrowed', color: 0xd8a657, on: true,
    hint: 'Owned by other subsystems, imported by this one. The edges worth watching.' },
  { id: 'moves', label: 'Moves', color: 0xd07a9f, on: false,
    hint: 'The sixteen TSL effects v3 will read. Nothing imports them yet.' },
  { id: 'old', label: 'Archive', color: 0x6b7480, on: false,
    hint: 'Pokemon Park, superseded and moved aside. No import edge in either direction.' },
];

export const GROUP_BY_ID = new Map(GROUPS.map(g => [g.id, g]));
export const defaultToggles = () => Object.fromEntries(GROUPS.map(g => [g.id, g.on]));

/** Files this subsystem borrows from elsewhere. The only hand-written list, because there is no rule. */
const BORROWED = new Set([
  'stadium-glb.js', 'disk-store.js', 'ragdoll.js', 'environment-audio.js', 'serve.py',
  'stadium-rig-map.js', 'creature-locomotion.js', 'gait-diagnostics.js',
  // The Map tab is this page in an iframe. Owned by infra, used here, so it is drawn as borrowed.
  'tools/filesystem-map.html',
  // The panel look, shared with the environment and bot viewers rather than invented here.
  'workshop-panel-theme.js',
]);

const RULES = [
  // Location first, so a file inside the archive is drawn in the archive whatever it is about.
  { group: 'old', test: (p) => p.startsWith('pokemon-park-old/') },
  { group: 'old', test: (p) => p === 'demos/pokemon-park-old-fail.html' || p === 'docs/subsystems/pokemon-park.md' },

  { group: 'moves', test: (p) => p.startsWith('moves/') },
  { group: 'moves', test: (p) => p === 'demos/pokemon-moves.html' || p === 'docs/subsystems/pokemon-moves.md' },

  { group: 'lab', test: (p) => /^pokemon-[a-z0-9-]+\.js$/.test(p) },
  { group: 'lab', test: (p) => p === 'pokemon-lab.html' },
  { group: 'lab', test: (p) => /^test-pokemon-[a-z0-9-]+\.mjs$/.test(p) },
  { group: 'lab', test: (p) => p === '_check_pokemon-lab.html.mjs' },
  { group: 'lab', test: (p) => p === 'test-pokemon-map-scope.mjs' },

  { group: 'docs', test: (p) => p.startsWith('docs/pokemon-lab/') },
  { group: 'docs', test: (p) => p === 'docs/subsystems/pokemon-lab.md' },

  { group: 'data', test: (p) => p === 'models/stadium' || p.startsWith('models/stadium/') },
  { group: 'data', test: (p) => p === 'stadium-saves' || p.startsWith('stadium-saves/') },

  { group: 'borrowed', test: (p) => BORROWED.has(p) },
];

/** A note explaining a node that is somewhere surprising. Shown in the tooltip, nowhere else. */
const NOTES = [
  { test: (p) => /^pokemon-park-old\/test-(fx|move)/.test(p),
    note: 'A moves test. It was swept into the archive with Park rather than kept beside moves/.' },
  { test: (p) => p === 'pokemon-pose.js' || p === 'test-pokemon-pose.mjs',
    note: 'Written and tested, imported by nothing — the page does not load it.' },
  { test: (p) => p === 'workshop-panel-theme.js',
    note: 'The shared panel look. The environment viewer, bot viewer, base game and code map wear it too.' },
  { test: (p) => p === 'tools/filesystem-map.html',
    note: 'The Map tab is this page in an iframe, with ?scope=pokemon narrowing its scan to these files.' },
  { test: (p) => p === 'serve.py',
    note: 'Not an import. It carries the save route and the filename whitelist the library is written through.' },
  { test: (p) => p === 'models/stadium',
    note: 'Collapsed. Expanding it puts 151 model files against twenty code files and tells you nothing.' },
];

export function groupOf(path) {
  for (const rule of RULES) if (rule.test(path)) return rule.group;
  return null;
}

export function noteOf(path) {
  for (const n of NOTES) if (n.test(path)) return n.note;
  return null;
}

/**
 * The scoped entry list, from whatever `/api/fs-scan` returned.
 *
 * Collapsed directories are emitted as one node carrying the size and file count of everything beneath
 * them, and their contents are dropped. Directories that would end up empty are dropped too, so turning
 * a group off does not leave an unlabelled hub floating where its files used to be.
 */
export function selectEntries(entries, toggles = defaultToggles()) {
  const on = (g) => !!toggles[g];
  const collapsed = new Map(COLLAPSE.map(p =>
    [p, { path: p, type: 'dir', size: 0, count: 0, exts: new Map(), mtime: 0, ctime: 0 }]));

  const kept = [];
  for (const e of entries || []) {
    const path = e.path;
    if (!path) continue;

    const inside = COLLAPSE.find(c => path.startsWith(`${c}/`));
    if (inside) {
      const node = collapsed.get(inside);
      if (e.type === 'file') {
        node.count++;
        node.size += Number(e.size) || 0;
        const ext = extOf(path);
        node.exts.set(ext, (node.exts.get(ext) || 0) + 1);
      }
      node.mtime = Math.max(node.mtime, Number(e.mtime) || 0);
      continue;                                   // contents never become nodes of their own
    }

    const group = groupOf(path);
    if (!group || !on(group)) continue;
    if (collapsed.has(path)) { Object.assign(collapsed.get(path), { mtime: e.mtime, ctime: e.ctime }); continue; }
    kept.push({ ...e, group, note: noteOf(path) });
  }

  for (const [path, node] of collapsed) {
    const group = groupOf(path);
    if (!group || !on(group) || !node.count) continue;
    kept.push({ ...node, group, note: noteOf(path), label: collapsedLabel(node) });
  }

  return withParents(kept);
}

/**
 * What a collapsed directory says it stands for, by counting extensions rather than assuming.
 *
 * `models/stadium` holds 151 models, the manifest and the generated phenomena sidecar. Counting all 153
 * files as models would be wrong in a way nobody would ever check.
 */
function collapsedLabel(node) {
  const sorted = [...node.exts].sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return '0 files';
  const [ext, n] = sorted[0];
  const rest = node.count - n;
  return rest ? `${n} .${ext} and ${rest} more` : `${n} .${ext}`;
}

/**
 * Add the directory entries a scoped list needs to hang together.
 *
 * The scan lists every directory, but scoping throws most of them away, and `buildTree` would then attach
 * `moves/fx-bolt.js` straight to the root. Re-adding only the ancestors of something kept means the tree
 * has exactly the folders the visible files actually live in.
 */
function withParents(entries) {
  const have = new Set(entries.map(e => e.path));
  const out = [...entries];
  for (const e of entries) {
    const parts = e.path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (have.has(dir)) continue;
      have.add(dir);
      out.push({ path: dir, type: 'dir', size: 0, mtime: e.mtime, ctime: e.ctime, group: e.group, note: null });
    }
  }
  // Shallowest first, so a parent is always created before the child that needs it.
  return out.sort((a, b) => a.path.split('/').length - b.path.split('/').length || a.path.localeCompare(b.path));
}

/**
 * What imports what. Hand-written, because these are facts about the code rather than about the
 * filesystem, and nothing in a directory listing can tell you them.
 *
 * Kept short on purpose: a test asserts every path here exists and every module the page imports appears,
 * so it fails rather than quietly going stale.
 */
export const IMPORT_EDGES = [
  ['pokemon-lab.html', 'pokemon-rig.js'],
  ['pokemon-lab.html', 'pokemon-annotation.js'],
  ['pokemon-lab.html', 'pokemon-suggest.js'],
  ['pokemon-lab.html', 'pokemon-lab-io.js'],
  ['pokemon-lab.html', 'pokemon-select.js'],
  ['pokemon-lab.html', 'pokemon-ik.js'],
  ['pokemon-lab.html', 'pokemon-hang.js'],
  ['pokemon-lab.html', 'pokemon-drive.js'],
  ['pokemon-lab.html', 'pokemon-phenomena.js'],
  ['pokemon-lab.html', 'pokemon-lab-runtime.js'],
  ['pokemon-lab.html', 'pokemon-lab-ground-map.js'],
  ['pokemon-lab.html', 'pokemon-movement.js'],
  ['pokemon-lab.html', 'stadium-rig-map.js'],
  ['pokemon-lab.html', 'creature-locomotion.js'],
  ['pokemon-lab.html', 'gait-diagnostics.js'],
  ['pokemon-lab.html', 'disk-store.js'],
  ['pokemon-lab.html', 'environment-audio.js'],
  ['pokemon-lab.html', 'workshop-panel-theme.js'],
  ['pokemon-rig.js', 'stadium-glb.js'],
  ['pokemon-lab-io.js', 'pokemon-annotation.js'],
  ['pokemon-lab-io.js', 'disk-store.js'],
  ['pokemon-hang.js', 'pokemon-ik.js'],
  ['pokemon-hang.js', 'ragdoll.js'],
  // The map tool imports the scope rules, not the other way round: the Lab embeds the page, and the page
  // asks this module what to show.
  ['tools/filesystem-map.html', 'pokemon-map-scope.js'],
];

/** A test and the thing it checks, derived rather than listed so a new test needs no edit here. */
export function testEdges(paths) {
  const have = new Set(paths);
  const out = [];
  for (const p of paths) {
    let subject = null;
    if (/^test-pokemon-[a-z0-9-]+\.mjs$/.test(p)) subject = `${p.slice(5, -4)}.js`;
    else if (p === '_check_pokemon-lab.html.mjs') subject = 'pokemon-lab.html';
    if (subject && have.has(subject)) out.push([p, subject]);
  }
  return out;
}

/** Every edge to draw, filtered to what is actually on screen. */
export function edgesFor(paths, { imports = true, tests = true } = {}) {
  const have = new Set(paths);
  const out = [];
  if (imports) for (const [a, b] of IMPORT_EDGES) if (have.has(a) && have.has(b)) out.push({ from: a, to: b, kind: 'import' });
  if (tests) for (const [a, b] of testEdges(paths)) out.push({ from: a, to: b, kind: 'test' });
  return out;
}

/** One line per group for the panel: how many nodes it contributed. */
export function groupCounts(entries) {
  const counts = Object.fromEntries(GROUPS.map(g => [g.id, 0]));
  for (const e of entries || []) {
    if (e.type === 'file' && counts[e.group] !== undefined) counts[e.group]++;
  }
  return counts;
}
