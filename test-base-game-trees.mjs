// test-base-game-trees.mjs — tree plan T1: which trees exist, and where.
//
// The renderer is T2 and needs a GPU. Placement does not, and placement is the half multiplayer
// has to agree on, so this is where the determinism claims are actually checked.
//
// node test-base-game-trees.mjs

import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import {
  createBaseGameTrees, expectedTreesPerChunk, treeSeedFor,
  BASE_GAME_TREE_DEFAULTS, TREE_IDENTITY_KEYS,
} from './base-game-trees.js';
import { createBaseGameTerrain } from './base-game-terrain.js';
import { createWorldQueryService } from './world-query.js';
import { createWorldCoordinateSpace } from './world-coordinates.js';
import { analyticDescriptor } from './terrain-source-analytic.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const section = name => console.log(`\n${name}`);

function rig(settings = {}) {
  const scene = new THREE.Scene();
  const terrain = createBaseGameTerrain({
    scene,
    worldQuery: createWorldQueryService(),
    worldCoordinates: createWorldCoordinateSpace(),
    source: analyticDescriptor({ key: 'trees-test', seaLevel: 0 }),
    useWorker: false,
  });
  terrain.setActive(true);
  const trees = createBaseGameTrees({ terrain, settings });
  return { scene, terrain, trees };
}

// Streams the fields in, then places until the queue stops draining. Placement is budgeted, so a
// single update() only builds a chunk or two by design.
function settle(terrain, trees, at = [0, 0, 0], frames = 400) {
  for (let i = 0; i < frames; i++) {
    terrain.update(at, 1 / 60);
    terrain.fieldScheduler.pump();
    trees.update(at[0], at[2]);
  }
}

const keyOf = r => `${r.chunkKey}:${r.slot}`;
const sig = recs => recs.map(r => `${keyOf(r)}|${r.x.toFixed(4)},${r.z.toFixed(4)},${r.speciesIdx},${r.scale.toFixed(5)},${r.yaw.toFixed(5)}`).sort().join('\n');

section('per-area density, not per-window');
{
  // The bug this guards: forest-placement's treeCountForChunk divides an absolute count by the
  // resident chunk count, so an absolute count makes the forest a function of the draw radius.
  const near = rig({ treesEnabled: true, treeRadius: 200 });
  const far = rig({ treesEnabled: true, treeRadius: 400 });
  near.trees.setEnabled(true);
  far.trees.setEnabled(true);
  check('a larger draw radius means a larger window', far.trees.stats.radiusChunks > near.trees.stats.radiusChunks,
    `${near.trees.stats.radiusChunks} vs ${far.trees.stats.radiusChunks}`);
  settle(near.terrain, near.trees);
  settle(far.terrain, far.trees);

  const shared = near.trees.residentKeys.filter(k => far.trees.recordsFor(k));
  check('the two windows overlap, so there is something to compare', shared.length > 4, `${shared.length} shared chunks`);
  let identical = 0, differing = 0;
  for (const key of shared) {
    if (sig(near.trees.recordsFor(key)) === sig(far.trees.recordsFor(key))) identical++;
    else differing++;
  }
  check('every shared chunk holds the identical forest at both radii', differing === 0,
    `${identical} identical, ${differing} differing`);
  check('and the chunks are not empty', near.trees.stats.trees > 0, `${near.trees.stats.trees} trees`);
  near.terrain.dispose(); far.terrain.dispose();
}

section('the same seed is the same forest');
{
  const a = rig({ treesEnabled: true });
  const b = rig({ treesEnabled: true });
  a.trees.setEnabled(true); b.trees.setEnabled(true);
  settle(a.terrain, a.trees); settle(b.terrain, b.trees);
  check('two independently built peers agree on the seed', a.trees.seed === b.trees.seed, `${a.trees.seed} vs ${b.trees.seed}`);
  const ka = a.trees.residentKeys.sort().join(',');
  const kb = b.trees.residentKeys.sort().join(',');
  check('and on which chunks are resident', ka === kb);
  check('and on every record in them', sig(a.trees.allRecords()) === sig(b.trees.allRecords()),
    `${a.trees.stats.trees} vs ${b.trees.stats.trees} trees`);

  const c = rig({ treesEnabled: true, treeSeedOffset: 1 });
  c.trees.setEnabled(true);
  settle(c.terrain, c.trees);
  check('the owner seed offset changes the forest', c.trees.seed !== a.trees.seed
    && sig(c.trees.allRecords()) !== sig(a.trees.allRecords()));
  a.terrain.dispose(); b.terrain.dispose(); c.terrain.dispose();
}

section('the ecology gate thins rather than only vetoing');
{
  const { terrain, trees } = rig({ treesEnabled: true });
  trees.setEnabled(true);
  settle(terrain, trees);
  const recs = trees.allRecords();
  check('there is a forest to inspect', recs.length > 20, `${recs.length} records`);

  // D2: the accept probability IS coverTree, so nothing may stand where cover is zero.
  let onZero = 0, coverSum = 0, sampled = 0;
  for (const r of recs) {
    const cover = terrain.coverAt(r.x, r.z);
    if (cover == null) continue;
    sampled++;
    coverSum += cover.tree;
    if (cover.tree <= 0) onZero++;
  }
  check('every record was sampled against a resident field', sampled === recs.length, `${sampled}/${recs.length}`);
  check('no tree stands where tree cover is zero', onZero === 0, `${onZero} on bare ground`);

  // The gradient claim, and the one measurement that actually separates a gradient from a veto.
  // Comparing accepted cover against ambient cover does NOT: clustered placement alone produces a
  // ratio near 1.5 either way, so that assertion cannot fail and was removed.
  //
  // What does separate them is how many trees survive. Under a veto the dart-throw accepts every
  // candidate on non-zero cover and placement reaches its requested count. Under a gradient the
  // accept probability IS the cover, so the forest lands materially short of it — measured at
  // roughly 14% of requested on this analytic terrain, against 100% for a veto.
  check('the cover gate thins the forest well below the requested count',
    trees.stats.coverThinning > 0.4,
    `requested ${trees.stats.requestedTrees.toFixed(0)}, standing ${trees.stats.trees}, thinning ${(trees.stats.coverThinning * 100).toFixed(0)}%`);
  check('and the shortfall is reported rather than silent',
    trees.stats.requestedTrees > trees.stats.trees && Number.isFinite(trees.stats.coverThinning));

  // Cover-weighted acceptance also means the mean cover under a tree exceeds the mean cover of the
  // vegetated ground, sampled on a real grid over exactly the resident chunks rather than at
  // offsets that wander into other terrain.
  const meanAccepted = coverSum / Math.max(1, sampled);
  const size = trees.stats.chunkSize;
  let uniformSum = 0, uniformN = 0;
  for (const key of trees.residentKeys) {
    const [ix, iz] = key.split(',').map(Number);
    for (let a = 0; a < 12; a++) for (let b = 0; b < 12; b++) {
      const cover = terrain.coverAt(ix * size + (a + 0.5) * size / 12, iz * size + (b + 0.5) * size / 12);
      if (cover != null && cover.tree > 0) { uniformSum += cover.tree; uniformN++; }
    }
  }
  const meanNonZero = uniformSum / Math.max(1, uniformN);
  check('a tree stands on better ground than the average vegetated post',
    meanAccepted > meanNonZero, `accepted ${meanAccepted.toFixed(4)} vs vegetated ${meanNonZero.toFixed(4)}`);

  // Below the shoreline nothing roots, whatever the biome says.
  const drowned = recs.filter(r => r.y < terrain.seaLevel);
  check('nothing roots below sea level', drowned.length === 0, `${drowned.length} submerged`);
  terrain.dispose();
}

section('records are complete and global');
{
  const { terrain, trees } = rig({ treesEnabled: true });
  trees.setEnabled(true);
  settle(terrain, trees);
  const recs = trees.allRecords();
  const bad = recs.filter(r => !Number.isFinite(r.x) || !Number.isFinite(r.z) || !Number.isFinite(r.y)
    || !Number.isFinite(r.scale) || !Number.isFinite(r.yaw) || !Number.isInteger(r.speciesIdx));
  check('every record is finite and fully populated', bad.length === 0, `${bad.length} malformed`);
  check('scales are positive', recs.every(r => r.scale > 0));
  check('species indices are inside the species count', recs.every(r => r.speciesIdx >= 0 && r.speciesIdx < BASE_GAME_TREE_DEFAULTS.treeSpecies));

  // Record Y is the DRAWN surface plus the low bias, carried so the renderer never re-queries it.
  // The 8 m placement posts gate where a tree may stand; they are not where it is drawn.
  let matched = 0, postGap = 0;
  for (const r of recs.slice(0, 50)) {
    const h = terrain.groundHeight(r.x, r.z);
    if (Math.abs(r.ground - h) < 1e-6 && Math.abs(r.y - (h + BASE_GAME_TREE_DEFAULTS.treeVerticalOffset)) < 1e-6) matched++;
    const post = terrain.fieldSurfaceAt(r.x, r.z);
    if (post != null) postGap = Math.max(postGap, Math.abs(post - h));
  }
  check('record ground and Y are the drawn surface plus the low bias', matched === Math.min(50, recs.length), `${matched}/${Math.min(50, recs.length)}`);
  console.log(`  (placement posts sit up to ${postGap.toFixed(2)} m off the drawn surface here, which is why the record carries the source height)`);
  check('and the bias is negative, never positive', BASE_GAME_TREE_DEFAULTS.treeVerticalOffset < 0);

  // Records are global, so a record's XZ must lie inside its own chunk's global bounds.
  const size = trees.stats.chunkSize;
  let outside = 0;
  for (const r of recs) {
    const [ix, iz] = r.chunkKey.split(',').map(Number);
    if (r.x < ix * size || r.x > (ix + 1) * size || r.z < iz * size || r.z > (iz + 1) * size) outside++;
  }
  check('every record lies inside its own chunk, in global coordinates', outside === 0, `${outside} outside`);
  terrain.dispose();
}

section('a chunk waits for its field instead of guessing');
{
  const { terrain, trees } = rig({ treesEnabled: true });
  trees.setEnabled(true);
  // One placement pass before anything has streamed: nothing may be built, and the queue defers.
  trees.update(0, 0);
  check('nothing is placed before the field arrives', trees.stats.trees === 0, `${trees.stats.trees} trees`);
  check('and the chunks are deferred, not dropped', trees.stats.deferred > 0 || trees.stats.queued > 0,
    `deferred ${trees.stats.deferred} queued ${trees.stats.queued}`);
  settle(terrain, trees);
  check('once the field is resident they build', trees.stats.trees > 0, `${trees.stats.trees} trees`);
  terrain.dispose();
}

section('the placement budget holds');
{
  const { terrain, trees } = rig({ treesEnabled: true, treeBudgetChunks: 1 });
  trees.setEnabled(true);
  for (let i = 0; i < 200; i++) { terrain.update([0, 0, 0], 1 / 60); terrain.fieldScheduler.pump(); }
  let maxBuiltInOneFrame = 0;
  for (let i = 0; i < 200; i++) {
    const before = trees.stats.resident;
    trees.update(0, 0);
    maxBuiltInOneFrame = Math.max(maxBuiltInOneFrame, trees.stats.resident - before);
  }
  check('no frame places more chunks than the budget allows', maxBuiltInOneFrame <= 1, `${maxBuiltInOneFrame} in one frame`);
  check('but the window does fill over frames', trees.stats.resident > 1, `${trees.stats.resident} resident`);
  terrain.dispose();
}

section('the NaN traps are closed');
{
  // All three of these are silent in forest-placement: a NaN waterLevel empties the forest with no
  // error, a NaN skew poisons every scale. The module refuses rather than producing either.
  for (const [key, value] of [['treeShoreMargin', undefined], ['treeSkew', NaN], ['treeMaxSize', undefined], ['treeSizeVar', NaN]]) {
    const { terrain, trees } = rig({ treesEnabled: true, [key]: value });
    trees.setEnabled(true);
    let threw = false;
    try { settle(terrain, trees, [0, 0, 0], 200); } catch (err) { threw = /non-finite|is NaN|is undefined/.test(String(err.message)); }
    check(`a bad ${key} throws instead of yielding a silent or poisoned forest`, threw);
    terrain.dispose();
  }
  // And the healthy path does not throw.
  const { terrain, trees } = rig({ treesEnabled: true });
  trees.setEnabled(true);
  let ok = true;
  try { settle(terrain, trees, [0, 0, 0], 200); } catch { ok = false; }
  check('the default params place without throwing', ok);
  terrain.dispose();
}

section('identity keys are the ones that change the forest');
{
  const { terrain, trees } = rig({ treesEnabled: true });
  trees.setEnabled(true);
  settle(terrain, trees);
  const before = sig(trees.allRecords());

  // A local quality change must not touch a single record.
  trees.apply({ treeBudgetChunks: 4, treeBudgetMs: 8 }, [0, 0]);
  settle(terrain, trees, [0, 0, 0], 100);
  check('a budget change leaves every record alone', sig(trees.allRecords()) === before);

  trees.apply({ treeRadius: BASE_GAME_TREE_DEFAULTS.treeRadius * 2 }, [0, 0]);
  settle(terrain, trees, [0, 0, 0], 300);
  const grown = trees.allRecords();
  const stillThere = new Set(grown.map(keyOf));
  const originals = before.split('\n').map(line => line.split('|')[0]);
  check('growing the draw radius adds trees without moving the old ones',
    originals.every(k => stillThere.has(k)) && grown.length > originals.length,
    `${originals.length} -> ${grown.length}`);

  // An identity change must change them.
  const changed = trees.apply({ treesPerHectare: BASE_GAME_TREE_DEFAULTS.treesPerHectare * 2 }, [0, 0]);
  check('a density change reports as an identity change', changed === true);
  settle(terrain, trees, [0, 0, 0], 400);
  check('and produces a denser forest', trees.allRecords().length > grown.length,
    `${grown.length} -> ${trees.allRecords().length}`);

  check('the draw radius is not an identity key', !TREE_IDENTITY_KEYS.includes('treeRadius'));
  check('nor are the frame budgets',
    !TREE_IDENTITY_KEYS.includes('treeBudgetChunks') && !TREE_IDENTITY_KEYS.includes('treeBudgetMs'));
  check('but density and seed offset are',
    TREE_IDENTITY_KEYS.includes('treesPerHectare') && TREE_IDENTITY_KEYS.includes('treeSeedOffset'));
  check('and an explicit species selection changes tree identity', TREE_IDENTITY_KEYS.includes('treeSpeciesSelection'));
  terrain.dispose();
}

section('the derived numbers are what they claim');
{
  check('a hectare of trees over a 100 m chunk is the per-hectare figure',
    Math.abs(expectedTreesPerChunk(45, 100) - 45) < 1e-9, `${expectedTreesPerChunk(45, 100)}`);
  check('and it scales with area, not with edge',
    Math.abs(expectedTreesPerChunk(45, 200) - 180) < 1e-9, `${expectedTreesPerChunk(45, 200)}`);
  check('zero density is zero trees', expectedTreesPerChunk(0, 96) === 0);
  check('a negative density cannot make negative trees', expectedTreesPerChunk(-10, 96) === 0);
  check('the seed is a pure function of the descriptor and the offset',
    treeSeedFor({ key: 'a', seed: 1 }, 0) === treeSeedFor({ key: 'a', seed: 1 }, 0)
    && treeSeedFor({ key: 'a', seed: 1 }, 0) !== treeSeedFor({ key: 'b', seed: 1 }, 0));

  // The window must reach at least as far as the trees draw, or the forest ends on an invisible
  // line. This is the invariant the derived radius exists to hold.
  const { terrain, trees } = rig({ treesEnabled: true, treeRadius: 700, treeChunkSize: 96 });
  trees.setEnabled(true);
  const reach = trees.stats.radiusChunks * trees.stats.chunkSize;
  check('the derived chunk window covers the draw radius', reach >= 700, `reach ${reach} for radius 700`);
  terrain.dispose();
}

section('the placement controls the Plants panel surfaces (2026-09-01)');
{
  const PANEL_KEYS = ['treePlacement', 'treeClusterSize', 'treeClusterSpread', 'treeShoreMargin',
    'treeChunkSize', 'treeSeedOffset', 'treeSizeVar', 'treeSkew'];
  for (const key of PANEL_KEYS) check(`${key} changes tree identity`, TREE_IDENTITY_KEYS.includes(key));

  const grow = (settings = {}) => {
    const r = rig({ treesEnabled: true, treeRadius: 200, ...settings });
    r.trees.setEnabled(true);
    settle(r.terrain, r.trees);
    return r;
  };
  const base = grow();
  const baseSig = sig(base.trees.allRecords());
  check('the default forest has trees to compare', base.trees.allRecords().length > 20, `${base.trees.allRecords().length}`);
  const switched = base.trees.apply({ treePlacement: 'random' }, [0, 0]);
  check('a pattern change reports as an identity change', switched === true);
  settle(base.terrain, base.trees);
  check('and moves the trees', sig(base.trees.allRecords()) !== baseSig);
  base.terrain.dispose();

  const sigs = {};
  for (const placement of ['clustered', 'random', 'scattered', 'ring']) {
    const r = grow({ treePlacement: placement });
    sigs[placement] = sig(r.trees.allRecords());
    check(`${placement} places trees`, r.trees.allRecords().length > 0, `${r.trees.allRecords().length}`);
    r.terrain.dispose();
  }
  check('the four patterns are four different forests', new Set(Object.values(sigs)).size === 4);
  check('and the default is the stands pattern', sigs.clustered === baseSig);

  // Stand shape only acts in the stands pattern, which is why the panel greys it out elsewhere.
  const a = grow({ treePlacement: 'clustered', treeClusterSize: 12, treeClusterSpread: 0.05 });
  check('stand size and radius move a clustered forest', sig(a.trees.allRecords()) !== sigs.clustered);
  a.terrain.dispose();
  const b = grow({ treePlacement: 'random', treeClusterSize: 12, treeClusterSpread: 0.05 });
  check('and leave a uniform one alone', sig(b.trees.allRecords()) === sigs.random);
  b.terrain.dispose();

  const wet = grow({ treeShoreMargin: 0 }), dry = grow({ treeShoreMargin: 25 });
  check('a taller shore margin keeps fewer trees', dry.trees.allRecords().length < wet.trees.allRecords().length,
    `${wet.trees.allRecords().length} -> ${dry.trees.allRecords().length}`);
  check('and none of them roots below it', dry.trees.allRecords().every(r => r.ground >= 25));
  wet.terrain.dispose(); dry.terrain.dispose();

  const flat = grow({ treeSizeVar: 0 });
  check('size variation 0 makes every tree max size',
    flat.trees.allRecords().every(r => Math.abs(r.scale - BASE_GAME_TREE_DEFAULTS.treeMaxSize) < 1e-9));
  flat.terrain.dispose();
  const mean = recs => recs.reduce((sum, r) => sum + r.scale, 0) / Math.max(1, recs.length);
  const small = grow({ treeSkew: 3 }), large = grow({ treeSkew: -3 });
  check('positive skew grows a smaller forest than negative skew', mean(small.trees.allRecords()) < mean(large.trees.allRecords()),
    `${mean(small.trees.allRecords()).toFixed(3)} vs ${mean(large.trees.allRecords()).toFixed(3)}`);
  small.terrain.dispose(); large.terrain.dispose();

  const cell = grow({ treeChunkSize: 48 });
  check('a smaller placement cell rebuilds the window on it', cell.trees.stats.chunkSize === 48 && cell.trees.allRecords().length > 0,
    `cell ${cell.trees.stats.chunkSize}, ${cell.trees.allRecords().length} trees`);
  const resized = cell.trees.apply({ treeChunkSize: 96 }, [0, 0]);
  settle(cell.terrain, cell.trees);
  check('and changing it live is an identity change that lands the default forest',
    resized === true && cell.trees.stats.chunkSize === 96 && sig(cell.trees.allRecords()) === baseSig);
  cell.terrain.dispose();

  // The page wires every one of them: a default, a control, and the forest apply list.
  const html = readFileSync(new URL('./base-game.html', import.meta.url), 'utf8');
  const applyList = html.match(/const FOREST_APPLY_KEYS = \[([\s\S]*?)\];/)?.[1] ?? '';
  const defaults = html.match(/const DEFAULT_SETTINGS = Object\.freeze\(\{([\s\S]*?)\n\}\);/)?.[1] ?? '';
  for (const key of PANEL_KEYS) {
    check(`${key} has a page default, a control and a forest apply entry`,
      new RegExp(`^  ${key}: BASE_GAME_TREE_DEFAULTS\\.${key},`, 'm').test(defaults)
      && new RegExp(`add(CommitRange|Select)\\((treePlaceSec|treeLookSec), '${key}'`).test(html)
      && applyList.includes(`'${key}'`));
  }
  check('the placement pattern is validated on load', /treePlacement: \['clustered', 'random', 'scattered', 'ring'\]/.test(html));
  check('the placement controls commit on release, never on drag',
    !/addRange\((treePlaceSec|treeLookSec), 'tree(ClusterSize|ClusterSpread|Placement|ShoreMargin|ChunkSize|SeedOffset|SizeVar|Skew)'/.test(html));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
