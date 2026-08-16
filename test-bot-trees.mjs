// Node test for bot-trees-place.js plus its integration with forest-placement.js and the
// bot-flora-place.js exclusion primitives it reuses. Run: node test-bot-trees.mjs
import {
  TRUNK_SIDES, trunkProxyTriangles, trunkTriangleCost, maxTreesForBudget,
  trunkRadiusFor, trunkHeightFor, trunkNavRects, stampCluster,
  resolvePlacedRecords, tagAutoRecords, serializePlaced, nearestPlacedIndex,
  treeBudget, densityForCount, TREE_CAP,
} from './bot-trees-place.js';
import { blockerRects, buildBlockerIndex, isBlocked, inRect, floraChunk, makeRng } from './bot-flora-place.js';
import { placementRecords } from './forest-placement.js';
import { speciesTableFor } from './tree-families-store.js';
import { EZ_TREE_FAMILIES } from './tree-presets.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log('  FAIL:', msg); } };
const section = (name) => console.log(`\n[${name}]`);

const TABLE = speciesTableFor(EZ_TREE_FAMILIES);
const BOUNDS = { minX: -40, maxX: 40, minZ: -30, maxZ: 30 };
const flat = () => 0;
const hilly = (x, z) => Math.sin(x * 0.1) * 2 + Math.cos(z * 0.13) * 1.5;

// forest-placement.js computes `waterLevel + shoreMargin` and rejects anything below it. Omit
// either and that sum is NaN, every `height >= NaN` is false, and the forest comes out silently
// EMPTY rather than erroring. The bot viewer has no water, so it must still pass them explicitly.
const DRY = { waterLevel: -1e6, shoreMargin: 0 };

section('1. trunk proxy triangle budget');
{
  ok(trunkProxyTriangles(8) === 16, 'an 8-sided open cylinder is 16 triangles');
  ok(trunkProxyTriangles() === trunkProxyTriangles(TRUNK_SIDES), 'the default matches TRUNK_SIDES');
  ok(trunkProxyTriangles(2) === 6, 'degenerate side counts clamp to 3 sides, not 0 triangles');
  ok(trunkTriangleCost(1000) === 16000, '1000 trees cost 16k triangles');
  ok(trunkTriangleCost(0) === 0, 'no trees cost nothing');
  ok(trunkTriangleCost(-5) === 0, 'a negative count cannot credit triangles back');

  // The headroom that motivates the whole proxy design: 250k cap, ~112k taken by terrain+walls.
  const free = 250000 - 112000;
  const fits = maxTreesForBudget(free);
  ok(fits > 4000 && fits < 12000, `proxies fit thousands of trees in the headroom (got ${fits})`);
  // And the counterfactual: rendered geometry would not.
  ok(Math.floor(free / 5000) < 30, 'rendered tree geometry at ~5k tris would cap out under 30 trees');
  ok(maxTreesForBudget(0) === 0, 'no headroom means no trees');
}

section('2. trunk dimensions come from what renders');
{
  const oak = TABLE.find(s => s._tag.id.includes('oak_large'));
  ok(oak, 'found the large oak preset');
  ok(Math.abs(trunkRadiusFor(oak, 1) - oak.radius[0]) < 1e-9, 'radius at scale 1 is the preset radius[0]');
  ok(Math.abs(trunkRadiusFor(oak, 2) - oak.radius[0] * 2) < 1e-9, 'radius scales linearly with the record scale');
  ok(Math.abs(trunkHeightFor(oak, 1) - oak.length[0]) < 1e-9, 'height at scale 1 is the preset length[0]');
  ok(trunkRadiusFor({}, 1) > 0, 'a species with no radius still yields a positive radius');
  ok(trunkRadiusFor(oak, 0) > 0, 'a zero scale cannot produce a zero-radius trunk');
  ok(trunkRadiusFor({ radius: 0.5 }, 1) === 0.5, 'a scalar radius is accepted as well as an array');
}

section('3. nav rects');
{
  const recs = [
    { x: 5, z: 5, scale: 1, speciesIdx: 0 },
    { x: -8, z: 2, scale: 2, speciesIdx: 1 },
  ];
  const rects = trunkNavRects(recs, TABLE, 0.4);
  ok(rects.length === 2, 'one rect per tree');
  ok(rects[0].x === 5 && rects[0].z === 5, 'the rect is centred on the trunk');
  const bare = trunkNavRects(recs, TABLE, 0);
  ok(rects[0].w > bare[0].w, 'the capsule radius widens the rect');
  ok(rects[1].w > rects[0].w, 'a bigger scale gives a wider rect');
  ok(trunkNavRects([{ x: 0, z: 0, scale: 1, speciesIdx: 999 }], TABLE).length === 0,
    'a record pointing at a missing species is skipped, not crashed on');
  ok(trunkNavRects(null, TABLE).length === 0, 'null records yield no rects');
}

section('4. stampCluster');
{
  const rng = makeRng(11);
  const pts = stampCluster({ x: 10, z: -4 }, { count: 20, radius: 6 }, rng);
  ok(pts.length === 20, 'produces the asked-for count when there is room');
  ok(pts.every(p => Math.hypot(p.x - 10, p.z + 4) <= 6 + 1e-9), 'every point lands inside the radius');

  // Determinism: same seed, same stamp.
  const a = stampCluster({ x: 0, z: 0 }, { count: 15, radius: 5 }, makeRng(7));
  const b = stampCluster({ x: 0, z: 0 }, { count: 15, radius: 5 }, makeRng(7));
  ok(JSON.stringify(a) === JSON.stringify(b), 'the same seed reproduces the stamp exactly');
  const c = stampCluster({ x: 0, z: 0 }, { count: 15, radius: 5 }, makeRng(8));
  ok(JSON.stringify(a) !== JSON.stringify(c), 'a different seed gives a different stamp');

  // Uniform-by-area: with falloff 0, roughly half the points should fall outside r/sqrt(2).
  const many = stampCluster({ x: 0, z: 0 }, { count: 600, radius: 10, falloff: 0 }, makeRng(3));
  const inner = many.filter(p => Math.hypot(p.x, p.z) < 10 / Math.SQRT2).length;
  ok(inner > 240 && inner < 360, `falloff 0 is uniform by area, not bunched (inner half = ${inner}/600)`);

  // falloff 1 must visibly concentrate toward the middle.
  const tight = stampCluster({ x: 0, z: 0 }, { count: 600, radius: 10, falloff: 1 }, makeRng(3));
  const tightInner = tight.filter(p => Math.hypot(p.x, p.z) < 10 / Math.SQRT2).length;
  ok(tightInner > inner + 60, `falloff 1 pulls toward the centre (${tightInner} vs ${inner})`);

  // minSeparation must actually be honoured by every surviving pair.
  const spaced = stampCluster({ x: 0, z: 0 }, { count: 25, radius: 10, minSeparation: 2.5 }, makeRng(5));
  let closest = Infinity;
  for (let i = 0; i < spaced.length; i++) {
    for (let j = i + 1; j < spaced.length; j++) {
      closest = Math.min(closest, Math.hypot(spaced[i].x - spaced[j].x, spaced[i].z - spaced[j].z));
    }
  }
  ok(closest >= 2.5 - 1e-9, `no pair is closer than minSeparation (closest ${closest.toFixed(3)})`);

  // An impossible ask thins out rather than hanging.
  const crowded = stampCluster({ x: 0, z: 0 }, { count: 500, radius: 2, minSeparation: 3 }, makeRng(5));
  ok(crowded.length < 500, 'an over-tight ask returns fewer trees instead of spinning');
  ok(crowded.length >= 1, 'and still places what it can');

  // The accept gate is what keeps a stamp out of walls.
  const gated = stampCluster({ x: 0, z: 0 }, { count: 100, radius: 10, accept: (x) => x > 0 }, makeRng(9));
  ok(gated.length > 0 && gated.every(p => p.x > 0), 'the accept gate rejects points it refuses');
  ok(stampCluster({ x: 0, z: 0 }, { count: 0, radius: 5 }, makeRng(1)).length === 0, 'count 0 places nothing');
}

section('5. auto placement runs on a bounded arena and respects walls');
{
  const walls = [
    { x: 0, z: 0, w: 20, d: 4 },
    { x: -20, z: 10, w: 6, d: 18 },
  ];
  const index = buildBlockerIndex(blockerRects(walls, 1.0), BOUNDS, 2);
  const chunk = floraChunk(BOUNDS, 2, 'arena');
  const params = {
    masterSeed: 99, count: 300, placement: 'random', maxSize: 1.2, sizeVar: 0.3,
    targetChunkCount: 1, speciesTable: TABLE, ...DRY,
  };
  const raw = placementRecords([chunk], params, flat);
  ok(raw.length > 0, `placementRecords produces trees on a single arena chunk (${raw.length})`);

  const padded = { minX: BOUNDS.minX - 2, maxX: BOUNDS.maxX + 2, minZ: BOUNDS.minZ - 2, maxZ: BOUNDS.maxZ + 2 };
  const kept = raw.filter(r => inRect(padded, r.x, r.z) && !isBlocked(index, r.x, r.z));
  ok(kept.length > 0, `some trees survive the wall filter (${kept.length}/${raw.length})`);
  ok(kept.length < raw.length, 'and the filter genuinely removes some');
  ok(kept.every(r => !isBlocked(index, r.x, r.z)), 'no surviving tree stands inside a wall');
  ok(kept.every(r => inRect(padded, r.x, r.z)), 'no surviving tree lies outside the padded arena');

  // Determinism, which is what lets auto trees persist as a seed rather than a list.
  const again = placementRecords([chunk], params, flat);
  ok(JSON.stringify(raw) === JSON.stringify(again), 'the same seed rebuilds an identical forest');
  const other = placementRecords([chunk], { ...params, masterSeed: 100 }, flat);
  ok(JSON.stringify(raw) !== JSON.stringify(other), 'a different seed builds a different forest');

  // The family filter has to reach the actual placed species.
  const pineOnly = speciesTableFor(EZ_TREE_FAMILIES, [EZ_TREE_FAMILIES.find(f => f.id.includes('pine')).id]);
  const pineRecs = placementRecords([chunk], { ...params, speciesTable: pineOnly }, flat);
  ok(pineRecs.every(r => r.speciesIdx < pineOnly.length), 'every record indexes inside the filtered table');
  const tagged = tagAutoRecords(pineRecs, pineOnly, flat);
  ok(tagged.every(t => t.speciesId?.includes('pine')), 'family-specific placement really does place only that family');
}

section('6. records carry no baked ground height');
{
  const chunk = floraChunk(BOUNDS, 0, 'arena');
  const params = { masterSeed: 4, count: 40, placement: 'random', maxSize: 1, targetChunkCount: 1, speciesTable: TABLE, ...DRY };
  const raw = placementRecords([chunk], params, flat);

  const onFlat = tagAutoRecords(raw, TABLE, flat);
  const onHills = tagAutoRecords(raw, TABLE, hilly);
  ok(onFlat.length === onHills.length, 'the same trees appear on either terrain');
  ok(onFlat.every((r, i) => r.x === onHills[i].x && r.z === onHills[i].z), 'XZ is terrain-independent');
  ok(onHills.some((r, i) => r.y !== onFlat[i].y), 'y is re-derived from the ground, not stored');
  ok(onHills.every((r, i) => Math.abs(r.y - hilly(r.x, r.z)) < 1e-9), 'y matches the sampled height exactly');
  ok(onFlat.every(r => r.origin === 'auto'), 'auto records are tagged as auto');
  ok(onFlat.every(r => typeof r.speciesId === 'string'), 'auto records carry a resolvable species id');
}

section('7. hand-placed records resolve by id, not index');
{
  const id = TABLE[4]._tag.id;
  const placed = [{ x: 3, z: -7, speciesId: id, scale: 1.4, yaw: 0.5 }];
  const r = resolvePlacedRecords(placed, TABLE, hilly);
  ok(r.length === 1, 'a placed record resolves');
  ok(r[0].speciesIdx === 4, 'against the right species index');
  ok(Math.abs(r[0].y - hilly(3, -7)) < 1e-9, 'and is draped onto the ground at load');
  ok(r[0].origin === 'placed', 'tagged as placed');

  // Drop the first family: the id must still find its species at a shifted index.
  const shifted = speciesTableFor(EZ_TREE_FAMILIES.slice(1));
  const reResolved = resolvePlacedRecords(placed, shifted, flat);
  if (reResolved.length) {
    ok(shifted[reResolved[0].speciesIdx]._tag.id === id, 'a changed family set still resolves to the SAME species');
    ok(reResolved[0].speciesIdx !== 4, 'even though the index moved, which is why ids are stored');
  } else {
    ok(id.startsWith(EZ_TREE_FAMILIES[0].id + '/'), 'only a species from the dropped family fails to resolve');
  }

  ok(resolvePlacedRecords([{ x: 0, z: 0, speciesId: 'gone/missing' }], TABLE, flat).length === 0,
    'a record whose species no longer exists is dropped, never remapped to a wrong tree');
  ok(resolvePlacedRecords([{ x: 1, z: 1, speciesId: id }], TABLE, flat)[0].scale === 1,
    'a record with no scale defaults to 1 rather than 0');
}

section('8. only hand-placed trees persist');
{
  const chunk = floraChunk(BOUNDS, 0, 'arena');
  const auto = tagAutoRecords(
    placementRecords([chunk], { masterSeed: 2, count: 30, placement: 'random', maxSize: 1, targetChunkCount: 1, speciesTable: TABLE, ...DRY }, flat),
    TABLE, flat);
  const placed = resolvePlacedRecords([
    { x: 1, z: 2, speciesId: TABLE[0]._tag.id, scale: 1, yaw: 0 },
    { x: 4, z: 5, speciesId: TABLE[1]._tag.id, scale: 1.2, yaw: 1 },
  ], TABLE, flat);

  const saved = serializePlaced([...auto, ...placed]);
  ok(saved.length === 2, `only the two hand-placed trees serialize, not the ${auto.length} auto ones`);
  ok(saved.every(s => !('y' in s)), 'no y is written, so a saved forest re-drapes on load');
  ok(saved.every(s => typeof s.speciesId === 'string'), 'each saved record names its species');
  ok(saved[1].scale === 1.2, 'per-tree scale survives the round trip');

  const restored = resolvePlacedRecords(saved, TABLE, hilly);
  ok(restored.length === 2, 'and the saved records resolve again');
  ok(Math.abs(restored[0].y - hilly(1, 2)) < 1e-9, 're-draped onto the new terrain, not the old one');
  ok(JSON.stringify(serializePlaced(restored)) === JSON.stringify(saved), 'save -> load -> save is stable');
}

section('9. click-to-erase finds only hand-placed trees');
{
  const recs = [
    { x: 0, z: 0, origin: 'auto' },
    { x: 1, z: 1, origin: 'placed' },
    { x: 9, z: 9, origin: 'placed' },
  ];
  ok(nearestPlacedIndex(recs, 1.1, 1.1, 2) === 1, 'finds the nearby placed tree');
  ok(nearestPlacedIndex(recs, 0, 0, 0.5) === -1, 'ignores an auto tree sitting right under the cursor');
  ok(nearestPlacedIndex(recs, 50, 50, 2) === -1, 'reports -1 when nothing is in range');
  ok(nearestPlacedIndex(recs, 5, 5, 100) === 1, 'picks the nearest of several in range');
  ok(nearestPlacedIndex([], 0, 0, 5) === -1, 'an empty forest erases nothing');
  ok(nearestPlacedIndex([{ x: 0, z: 0, origin: 'placed' }, { x: 0, z: 0, origin: 'placed' }], 0, 0, 5) === 0,
    'an exact tie keeps the first match, so the pick is stable');

  // Why eraseAt must scan the stored list rather than the resolved one: resolving DROPS records
  // whose species is gone, which shifts every later index. Erasing by a resolved index would then
  // delete the wrong tree.
  const stored = [
    { x: 0, z: 0, speciesId: 'gone/missing' },
    { x: 20, z: 20, speciesId: TABLE[0]._tag.id },
  ];
  const resolved = resolvePlacedRecords(stored, TABLE, flat);
  ok(resolved.length === 1, 'resolving drops the record with a dead species');
  ok(resolved[0].x === 20, 'so the survivor now sits at index 0, not index 1');
  const storedIdx = nearestPlacedIndex(stored.map(p => ({ ...p, origin: 'placed' })), 20, 20, 2);
  ok(storedIdx === 1, 'scanning the STORED list gives the index that is safe to splice');
}

section('10. the live module builds, plants, erases and tears down');
{
  // bot-trees.js pulls in three/tsl and three/webgpu, which resolve in Node, so the real module is
  // exercised here rather than a mirror of it. No GPU is touched: TSL only builds a node graph.
  const THREE = await import('three');
  const { createTree } = await import('./trees.js');
  const { createBotTrees, TREE_DEFAULTS } = await import('./bot-trees.js');

  const scene = new THREE.Group();
  const oneFamily = speciesTableFor(EZ_TREE_FAMILIES, [EZ_TREE_FAMILIES[2].id]);
  const trees = createBotTrees({ THREE, parent: scene, createTree });
  const built = trees.rebuild({
    bounds: BOUNDS,
    wallBoxes: [{ x: 0, z: 0, w: 30, d: 6 }],
    coverBoxes: [], pads: [],
    groundHeight: hilly,
    speciesTable: oneFamily,
    settings: { ...TREE_DEFAULTS, enabled: true, density: 2, seed: 3 },
  });
  ok(built.total > 0, `an enabled forest places trees (${built.total})`);
  ok(built.auto === built.total, 'all of them are auto before anything is planted');
  ok(built.draws > 0 && built.draws <= oneFamily.length * TREE_DEFAULTS.variants * 2,
    `draw calls stay within species x variants x 2 (${built.draws})`);
  ok(trees.root.children.length === built.draws, 'every draw is a child of the tree group');
  ok(trees.navRects().length === built.total, 'one nav rect per tree');

  // The collider proxy is the load-bearing budget claim, so it is counted the way
  // createMapCollider counts it rather than trusted from the module's own stat.
  const countTris = () => {
    let t = 0;
    trees.colliderRoot.traverse(o => {
      if (!o.isMesh) return;
      const g = o.geometry;
      const per = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
      t += per * (o.isInstancedMesh ? o.count : 1);
    });
    return t;
  };
  ok(countTris() === built.colliderTriangles, 'the reported collider cost matches an independent traverse');
  ok(countTris() === built.total * 16, 'and works out at 16 triangles per tree');
  ok(countTris() < 250000, 'well inside the collider cap');
  ok(!trees.colliderRoot.parent, 'the proxy root stays out of the scene, so it costs no draws');

  const planted = trees.plantAt(25, 20, { count: 12, radius: 5, minSeparation: 1 });
  ok(planted > 0, `a clump plants (${planted})`);
  ok(trees.stats().placed === planted, 'and shows up as placed, not auto');
  ok(trees.stats().auto === built.auto, 'without disturbing the auto trees');
  ok(trees.serialize().length === planted, 'only the planted ones serialize');

  ok(trees.eraseAt(25, 20, 8) === true, 'erasing near the clump removes one');
  ok(trees.stats().placed === planted - 1, 'the placed count drops by exactly one');
  ok(trees.eraseAt(-500, -500, 2) === false, 'erasing in empty space removes nothing');

  const cleared = trees.clearPlaced();
  ok(cleared === planted - 1, 'clearing removes every remaining planted tree');
  ok(trees.stats().placed === 0 && trees.stats().auto > 0, 'and leaves the auto forest standing');

  // Height normalization. The stock presets are 19.7-96.2 units tall naturally, so a flat
  // multiplier cannot serve them; and sizeFor IGNORES maxSize once a family sizeRange is present,
  // which is how the first version shipped trees at full 40-100 m ez scale.
  const heights = trees.speciesHeights.filter(Number.isFinite);
  ok(heights.length > 0, 'the bake measures a natural height per species');
  ok(Math.max(...heights) / Math.min(...heights) > 1.3,
    'species genuinely differ in natural height, which is why one multiplier will not do');

  // Measured on FLAT ground: Box3.setFromObject spans every instance of an InstancedMesh, so on
  // hilly terrain the box height is the tree plus the ground relief and reads far too tall.
  const measure = (target) => {
    trees.rebuild({ groundHeight: flat, settings: { height: target, sizeVar: 0 } });
    const box = new THREE.Box3();
    let tallest = 0;
    for (const m of trees.root.children) {
      box.setFromObject(m);
      tallest = Math.max(tallest, box.max.y - box.min.y);
    }
    return tallest;
  };
  const at7 = measure(7);
  const at14 = measure(14);
  ok(at7 > 3 && at7 < 12, `height 7 renders trees near 7 m, not 40+ (tallest ${at7.toFixed(1)} m)`);
  ok(at14 > at7 * 1.6, 'doubling the height slider roughly doubles what is drawn');

  // The bug the user caught on screen: planted trees came out a different size from scattered ones,
  // because plantAt baked a size multiplier into the stored scale that the scatter never applied.
  // Read the trunk proxies' instance scales: they are built from the same normalized scale the
  // rendered meshes use, and unlike the records they are reachable from outside the module.
  const trunkScales = () => {
    const out = [];
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    trees.colliderRoot.traverse(o => {
      if (!o.isInstancedMesh) return;
      for (let i = 0; i < o.count; i++) { o.getMatrixAt(i, m); m.decompose(p, q, s); out.push(s.y); }
    });
    return out;
  };

  const sameSpecies = oneFamily[0]._tag.id;
  // Scattered only, one species, no variation.
  trees.clearPlaced();
  trees.rebuild({
    settings: { height: 8, sizeVar: 0, enabled: true, count: 30, seed: 3 },
    speciesTable: speciesTableFor(EZ_TREE_FAMILIES, [EZ_TREE_FAMILIES[2].id]).slice(0, 1),
  });
  const scattered = trunkScales();
  // Planted only, same species, same settings.
  trees.rebuild({ settings: { count: 0 } });
  trees.plantAt(0, 0, { count: 6, radius: 4, speciesId: sameSpecies });
  const plantedScales = trunkScales();

  ok(scattered.length > 0 && plantedScales.length > 0, 'both paths produced trunks to compare');
  // sizeFor does Math.exp(p.skew * 1.5); an undefined skew makes that NaN and poisons every scale.
  // It surfaced as merely-inconsistent sizes rather than a crash, so it is asserted directly.
  ok(scattered.every(Number.isFinite), 'every scattered trunk has a finite scale (no NaN from a missing skew)');
  ok(plantedScales.every(Number.isFinite), 'every planted trunk has a finite scale');
  if (scattered.length && plantedScales.length) {
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const ratio = avg(plantedScales) / avg(scattered);
    ok(Math.abs(ratio - 1) < 0.02,
      `a planted tree is the same size as a scattered one of the same species (ratio ${ratio.toFixed(3)})`);
  }
  ok(trees.serialize()[0].scale !== undefined && Math.abs(trees.serialize()[0].scale - 1) < 0.3,
    'a planted tree serializes its VARIATION near 1, not the normalized scale — otherwise reloading normalizes twice');

  const off = trees.rebuild({ settings: { enabled: false } });
  ok(off.total === 0 && trees.root.children.length === 0, 'disabling clears the scene group');
  trees.dispose();
  ok(scene.children.length === 0, 'dispose detaches the tree group from its parent');
}

section('11. an authored species keeps its OWN leaf atlas cell');
{
  // The ez families pin oak 0 / aspen 1 / ash 2 / pine 3, matching tree-textures.js's LEAF_FILES.
  // forest-palette used to overwrite that with `spIdx % cells`, which silently handed pine_small
  // aspen leaves and pine_medium ash leaves. Nothing looks broken when this is wrong — the tree
  // renders fine, just wearing another species' foliage — so it has to be asserted.
  const THREE = await import('three');
  const { createTree } = await import('./trees.js');
  const { createForestPalette } = await import('./forest-palette.js');

  const fakeTex = { isTexture: true, wrapS: 0, wrapT: 0 };
  const fakeSet = {
    mode: 'authored', ready: true, leafAtlas: { cols: 2, rows: 2 }, leafAlphaTest: 0.5,
    leafMap: fakeTex, barkMap: fakeTex, barkNormalMap: fakeTex, barkVScale: 2,
  };
  const pal = createForestPalette({
    createTree, params: { speciesTable: TABLE, leafSize: 1, leafShadowPct: 0 },
    masterSeed: 5, variantsPerSpecies: 1, texSet: fakeSet,
  });

  // Which 2x2 cell a variant's leaf UVs actually occupy. Cells number row-major from the image's
  // TOP-left while v runs up, so the row is mirrored — the same convention trees.js applies.
  const cellOf = (geo) => {
    const uv = geo.attributes.uv;
    let uMin = 9, vMin = 9;
    for (let i = 0; i < uv.count; i++) { uMin = Math.min(uMin, uv.getX(i)); vMin = Math.min(vMin, uv.getY(i)); }
    const cx = Math.round(uMin / 0.5);
    const cy = Math.round(vMin / 0.5);
    return (2 - 1 - cy) * 2 + cx;
  };

  let matched = 0, checked = 0;
  for (const v of pal.variants) {
    const sp = TABLE[v.speciesIdx];
    const want = sp.leaves?.atlas?.cell;
    if (!Number.isInteger(want)) continue;
    checked++;
    if (cellOf(v.leaves) === want) matched++;
  }
  ok(checked === TABLE.length, `every stock species pins a cell (${checked}/${TABLE.length})`);
  ok(matched === checked, `every species draws from the cell it authored (${matched}/${checked})`);

  // Named species, so a regression names the actual tree rather than a count.
  for (const name of ['pine_small', 'pine_medium', 'pine_large', 'oak_small', 'ash_small', 'aspen_small']) {
    const idx = TABLE.findIndex(s => s._tag.id.endsWith('/ez-' + name));
    const v = pal.variants.find(x => x.speciesIdx === idx);
    ok(v && cellOf(v.leaves) === TABLE[idx].leaves.atlas.cell,
      `${name} uses cell ${TABLE[idx]?.leaves?.atlas?.cell} (its own), not index % 4`);
  }

  // And the fallback still holds for procedural species, which carry no atlas at all.
  const noAtlas = TABLE.slice(0, 3).map(s => ({ ...s, leaves: { ...s.leaves, atlas: null } }));
  const pal2 = createForestPalette({
    createTree, params: { speciesTable: noAtlas, leafSize: 1, leafShadowPct: 0 },
    masterSeed: 5, variantsPerSpecies: 1, texSet: fakeSet,
  });
  const cells2 = pal2.variants.map(v => cellOf(v.leaves));
  ok(cells2.every((c, i) => c === i % 4),
    'a species with no authored cell still falls back to spIdx % cells, so env-viewer is unchanged');
  void THREE;
}

// ---- 12: density is per area, and the scatter pattern is selectable ----
section('12: density budget and placement patterns');
{
  // The panel asks for trees per 100 m^2 because an absolute count meant a different forest on
  // every map size. The budget is sized to the SQUARE that placement actually covers, not to the
  // rectangle, for the same reason bladeBudget is: the overspill is dropped afterwards, so sizing
  // to the rectangle would thin the forest by the arena's aspect ratio.
  const square = { minX: -50, maxX: 50, minZ: -50, maxZ: 50 };   // 100 x 100 = 10,000 m^2
  ok(treeBudget(square, 1) === 100, `1 per 100 m^2 over 10,000 m^2 asks for 100 (got ${treeBudget(square, 1)})`);
  ok(treeBudget(square, 0) === 0, 'zero density asks for nothing');
  ok(treeBudget(square, -5) === 0, 'a negative density cannot ask for a negative forest');
  ok(treeBudget(null, 2) === 0, 'a missing rect asks for nothing rather than throwing');

  const wide = { minX: -50, maxX: 50, minZ: -10, maxZ: 10 };     // same extent, a fifth the area
  ok(treeBudget(wide, 1) === treeBudget(square, 1),
    'a long thin arena asks for the same number as the square it sits in, because the overspill is dropped after');

  ok(treeBudget(square, 1000) === TREE_CAP, `density is capped at ${TREE_CAP} trees (got ${treeBudget(square, 1000)})`);

  // Round-trip: the legacy conversion has to land back on the count it came from, or loading an
  // old slot quietly resizes its forest.
  for (const count of [0, 37, 250]) {
    const back = treeBudget(square, densityForCount(square, count));
    ok(back === count, `${count} trees converts to a density and back (got ${back})`);
  }
  ok(densityForCount({ minX: 0, maxX: 0, minZ: 0, maxZ: 0 }, 50) === 0,
    'a zero-extent arena converts to zero density rather than dividing by zero');

  // All four patterns reach forest-placement and each produces its own arrangement.
  const chunk = floraChunk(BOUNDS, 3, 'arena');
  const runs = {};
  for (const placement of ['clustered', 'scattered', 'random', 'ring']) {
    runs[placement] = placementRecords([chunk], {
      masterSeed: 4, count: 60, placement, maxSize: 1, skew: 0, varPattern: 'random',
      sizeVar: 0.3, targetChunkCount: 1, speciesTable: TABLE, waterLevel: -1e6, shoreMargin: 0,
    }, flat);
    ok(runs[placement].length > 0, `${placement} places trees`);
  }
  const sig = r => r.map(p => `${p.x.toFixed(2)},${p.z.toFixed(2)}`).join(';');
  const sigs = Object.values(runs).map(sig);
  ok(new Set(sigs).size === sigs.length, 'the four patterns produce four different arrangements');

  // Ring really is a ring. The property is a BAND, not a large radius: it sits at 32% of the chunk
  // extent, which is actually nearer the centre than a uniform fill averages, because a uniform
  // fill reaches into the corners at 71%. What separates them is spread, so measure spread.
  const radii = r => r.map(p => Math.hypot(p.x - chunk.centerX, p.z - chunk.centerZ));
  const sd = (xs) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
  };
  const ringSd = sd(radii(runs.ring)), randSd = sd(radii(runs.random));
  ok(ringSd < randSd * 0.6, `ring holds its trees in a band, random does not (radius sd ${ringSd.toFixed(1)} m vs ${randSd.toFixed(1)} m)`);

  // clusterSize/clusterSpread reach the clustered branch. Tighter clumps mean each tree sits nearer
  // its own nearest neighbour, which is the thing "clump spread" is supposed to control.
  const clustered = (spread) => placementRecords([chunk], {
    masterSeed: 4, count: 60, placement: 'clustered', clusterSize: 5, clusterSpread: spread,
    maxSize: 1, skew: 0, varPattern: 'random', sizeVar: 0.3, targetChunkCount: 1,
    speciesTable: TABLE, waterLevel: -1e6, shoreMargin: 0,
  }, flat);
  const meanNearest = (r) => {
    let sum = 0;
    for (const a of r) {
      let best = Infinity;
      for (const b of r) if (a !== b) best = Math.min(best, Math.hypot(a.x - b.x, a.z - b.z));
      sum += best;
    }
    return sum / r.length;
  };
  const tight = meanNearest(clustered(0.04)), loose = meanNearest(clustered(0.35));
  ok(tight < loose, `a smaller clump spread packs trees closer (${tight.toFixed(2)} m vs ${loose.toFixed(2)} m)`);

  // clusterSize is the OTHER half: it divides the same trees into fewer, fuller stands. Same count
  // and same spread, so any difference is the clump count alone.
  const sized = (per) => placementRecords([chunk], {
    masterSeed: 4, count: 60, placement: 'clustered', clusterSize: per, clusterSpread: 0.14,
    maxSize: 1, skew: 0, varPattern: 'random', sizeVar: 0.3, targetChunkCount: 1,
    speciesTable: TABLE, waterLevel: -1e6, shoreMargin: 0,
  }, flat);
  const few = meanNearest(sized(20)), many = meanNearest(sized(2));
  ok(few < many, `20 to a clump makes fuller stands than 2 to a clump (${few.toFixed(2)} m vs ${many.toFixed(2)} m apart)`);

  // The defaults must reproduce the old hardcoded constants exactly, or environment-viewer's
  // forest moves the day someone adds a cluster slider it never asked for.
  const withDefaults = placementRecords([chunk], {
    masterSeed: 9, count: 60, placement: 'clustered',
    maxSize: 1, skew: 0, varPattern: 'random', sizeVar: 0.3, targetChunkCount: 1,
    speciesTable: TABLE, waterLevel: -1e6, shoreMargin: 0,
  }, flat);
  const withExplicit = placementRecords([chunk], {
    masterSeed: 9, count: 60, placement: 'clustered', clusterSize: 5, clusterSpread: 0.14,
    maxSize: 1, skew: 0, varPattern: 'random', sizeVar: 0.3, targetChunkCount: 1,
    speciesTable: TABLE, waterLevel: -1e6, shoreMargin: 0,
  }, flat);
  ok(sig(withDefaults) === sig(withExplicit) && withDefaults.length > 0,
    'passing no cluster params is identical to passing the old constants, so env-viewer is unchanged');
}

// ---- 13: species mixing, in both the scatter and the brush ----
section('13: the scatter and the brush both mix species');
{
  // The scatter draws a species per tree from the whole table, so "all families" really does mean
  // all of them and one family really does mean only its own.
  const chunk = floraChunk(BOUNDS, 3, 'arena');
  const scatterWith = (table) => {
    const recs = placementRecords([chunk], {
      masterSeed: 1, count: 88, placement: 'clustered', maxSize: 1, skew: 0, varPattern: 'random',
      sizeVar: 0.35, targetChunkCount: 1, speciesTable: table, ...DRY,
    }, flat);
    return new Set(recs.map(r => table[r.speciesIdx]._tag.id));
  };
  const allIds = scatterWith(TABLE);
  ok(allIds.size === TABLE.length, `all ${TABLE.length} species appear in one scatter (got ${allIds.size})`);
  const fams = new Set([...allIds].map(id => id.split('/')[0]));
  ok(fams.size === EZ_TREE_FAMILIES.length, `and every family is represented (${fams.size})`);

  const pineTable = speciesTableFor(EZ_TREE_FAMILIES, ['ez-family-pine']);
  const pineIds = scatterWith(pineTable);
  ok(pineIds.size === pineTable.length, `picking one family scatters only its ${pineTable.length} species`);
  ok([...pineIds].every(id => id.startsWith('ez-family-pine/')), 'and nothing from any other family');

  const THREE = await import('three');
  const { createTree } = await import('./trees.js');
  const { createBotTrees, TREE_DEFAULTS } = await import('./bot-trees.js');
  const scene = new THREE.Group();
  const trees = createBotTrees({ THREE, parent: scene, createTree });
  const base = {
    bounds: BOUNDS, wallBoxes: [], coverBoxes: [], pads: [], groundHeight: flat,
    speciesTable: TABLE, settings: { ...TREE_DEFAULTS, enabled: true, density: 0, seed: 3 },
  };
  trees.rebuild(base);

  // Unpinned, the brush rolls a species per tree, so one clump comes out mixed rather than being
  // one species repeated.
  trees.plantAt(0, 0, { count: 30, radius: 12, minSeparation: 0 });
  const mixed = new Set(trees.serialize().map(r => r.speciesId));
  ok(mixed.size > 1, `an unpinned clump plants more than one species (${mixed.size} of ${TABLE.length})`);
  trees.clearPlaced();

  // Pinned, every tree in the clump is that species.
  const pin = TABLE.find(s => s._tag.id.includes('pine_large'))._tag.id;
  trees.plantAt(0, 0, { count: 20, radius: 12, minSeparation: 0, speciesId: pin });
  const pinnedIds = trees.serialize().map(r => r.speciesId);
  ok(pinnedIds.length > 0, `a pinned clump plants (${pinnedIds.length})`);
  ok(pinnedIds.every(id => id === pin), 'and every tree in it is the pinned species');
  trees.clearPlaced();

  // A pinned id that no longer exists — the family was switched — must still plant. Dropping the
  // click would read as a broken tool.
  trees.plantAt(0, 0, { count: 8, radius: 10, minSeparation: 0, speciesId: 'ez-family-gone/ez-nothing' });
  const fallback = trees.serialize();
  ok(fallback.length > 0, `a stale pinned species falls back to a random roll rather than planting nothing (${fallback.length})`);
  ok(fallback.every(r => TABLE.some(s => s._tag.id === r.speciesId)), 'and the fallback trees are real species');
  trees.dispose();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
