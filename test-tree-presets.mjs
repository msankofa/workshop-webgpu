// test-tree-presets.mjs -- the baked ez-tree preset families (tree-presets.js) and the
// evergreen branching mode they need (trees.js).
//
// The presets are generated data, so what matters is that they stay usable by their two
// consumers without any translation: tree-viewer.html's Species tab (which binds a slider to
// every path in a species' opts, so a missing key shows as NaN, not as a crash) and
// forest-placement.js's buildSpeciesFromFamilies (which reads the family/species metadata).
import { createTree } from './trees.js';
import { EZ_TREE_FAMILIES } from './tree-presets.js';
import { buildSpeciesFromFamilies } from './forest-placement.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

// ---- 1: family / species shape ----
{
  ok(EZ_TREE_FAMILIES.length === 6, `1: 6 families (got ${EZ_TREE_FAMILIES.length})`);
  const all = EZ_TREE_FAMILIES.flatMap(f => f.species);
  ok(all.length === 16, `1: 16 species, one per upstream preset (got ${all.length})`);

  const ids = [...EZ_TREE_FAMILIES.map(f => f.id), ...all.map(s => s.id)];
  ok(new Set(ids).size === ids.length, '1: family and species ids are unique');
  ok(ids.every(id => id.startsWith('ez-')), '1: ids carry the ez- prefix the viewer matches on when seeding');

  for (const s of all) {
    ok(typeof s.name === 'string' && s.name.length > 0, `1: ${s.id} has a name`);
    ok(Array.isArray(s.biomes) && s.biomes.length === 0, `1: ${s.id} has an empty biome list (= every biome)`);
    ok(s.density === 1, `1: ${s.id} has a density`);
    ok(Array.isArray(s.sizeRange) && s.sizeRange.length === 2, `1: ${s.id} has a size range`);
    ok(s.parentSpeciesId === null, `1: ${s.id} has no parent`);
  }
}

// ---- 2: every preset is a COMPLETE trees.js options object ----
// Not "createTree accepts it" -- merge() would happily fill any gap from DEFAULTS and render
// fine. The viewer is the strict consumer: it makes the species opts its live `opts` and binds
// controls straight to paths in it, so a key the preset omits has no slider behind it.
{
  const reference = createTree({}).options;
  const paths = obj => {
    const out = [];
    const walk = (o, prefix) => {
      for (const [k, v] of Object.entries(o)) {
        const p = prefix ? `${prefix}.${k}` : k;
        out.push(p);
        if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, p);
      }
    };
    walk(obj, '');
    return out;
  };
  const want = paths(reference).filter(p => !p.startsWith('leaves.atlas'));   // atlas is null by default
  for (const s of EZ_TREE_FAMILIES.flatMap(f => f.species)) {
    const have = new Set(paths(s.opts));
    const missing = want.filter(p => !have.has(p));
    ok(missing.length === 0, `2: ${s.id} covers every DEFAULTS path (missing ${missing.join(', ')})`);
  }
}

// ---- 3: every preset builds real geometry ----
{
  for (const s of EZ_TREE_FAMILIES.flatMap(f => f.species)) {
    const tree = createTree(s.opts);
    const branch = tree.branchesMesh.geometry.getAttribute('position');
    const leaf = tree.leavesMesh.geometry.getAttribute('position');
    ok(branch && branch.count > 0, `3: ${s.id} generates branch vertices`);
    ok(leaf && leaf.count > 0, `3: ${s.id} generates leaf vertices`);
    ok([...branch.array].every(Number.isFinite), `3: ${s.id} branch positions are finite`);
    ok([...leaf.array].every(Number.isFinite), `3: ${s.id} leaf positions are finite`);
    const cell = s.opts.leaves.atlas;
    ok(cell && cell.cols === 2 && cell.rows === 2 && cell.cell >= 0 && cell.cell <= 3,
      `3: ${s.id} pins a leaf atlas cell in tree-textures.js's 2x2 pack`);
    tree.dispose();
  }
}

// ---- 4: evergreen branching (ez-tree TreeType.Evergreen, ported for the pine/bush_3 presets) ----
// Two distinct behaviours, checked separately because a preset can look conical from either one.
const trunkOnly = {
  seed: 7, levels: 1, length: [10, 5], radius: [1, 0.5], taper: [0.5, 0.5],
  children: [0], sections: [4, 4], segments: [6, 6], branchStart: [0, 0],
  angle: [0, 90], gnarliness: [0, 0], twist: [0, 0],
  force: { direction: [0, 1, 0], strength: 0 }, leaves: { enabled: false },
};
// Rings are emitted base-to-tip, segments+1 vertices each (the tube duplicates its seam vertex).
// perRing is passed in rather than divided out of the buffer length: cap fans are appended after
// the wall, so total/rings stopped being a whole number once open ends started getting closed.
function ringRadius(geo, ring, perRing) {
  const p = geo.getAttribute('position').array;
  let max = 0;
  for (let j = 0; j < perRing; j++) {
    const i = (ring * perRing + j) * 3;
    max = Math.max(max, Math.hypot(p[i], p[i + 2]));
  }
  return max;
}
{
  // 4a: taper. Deciduous keeps taper[level]; evergreen ignores it and narrows to a point.
  // Measured mid-trunk, not at the tip: `trunkOnly` spawns no children, so the trunk is terminal
  // and its tip now pinches shut in BOTH modes (that is what stops it rendering as a cut pipe).
  // Ring 3 of 4 is the last ring the taper table alone decides.
  const PER = 6 + 1;
  const dec = createTree({ ...trunkOnly, evergreen: false });
  const eve = createTree({ ...trunkOnly, evergreen: true });
  const decMid = ringRadius(dec.branchesMesh.geometry, 3, PER);
  const eveMid = ringRadius(eve.branchesMesh.geometry, 3, PER);
  ok(Math.abs(decMid - 0.625) < 1e-6, `4a: deciduous trunk keeps 1 - taper*t of its radius (got ${decMid.toFixed(4)})`);
  ok(Math.abs(eveMid - 0.25) < 1e-6, `4a: evergreen trunk ignores the taper table and narrows harder (got ${eveMid.toFixed(4)})`);
  const decTip = ringRadius(dec.branchesMesh.geometry, 4, PER);
  const eveTip = ringRadius(eve.branchesMesh.geometry, 4, PER);
  ok(decTip < 1e-2, `4a: a terminal deciduous tip pinches shut (got ${decTip.toFixed(4)})`);
  ok(eveTip < 1e-2, `4a: a terminal evergreen tip pinches shut (got ${eveTip.toFixed(4)})`);
  ok(Math.abs(ringRadius(dec.branchesMesh.geometry, 0, PER) - ringRadius(eve.branchesMesh.geometry, 0, PER)) < 1e-6,
    '4a: both modes start from the same trunk base radius');
  dec.dispose(); eve.dispose();
}
{
  // 4b: child length. Evergreen scales each child by (1 - its height along the parent), so the
  // canopy tapers instead of running as a cylinder. Same seed both ways, so the length jitter
  // is identical and the reach difference is only the evergreen factor.
  const withKids = { ...trunkOnly, children: [4] };
  const reach = tree => {
    const p = tree.branchesMesh.geometry.getAttribute('position').array;
    let max = 0;
    for (let i = 0; i < p.length; i += 3) max = Math.max(max, Math.hypot(p[i], p[i + 2]));
    return max;
  };
  const dec = createTree({ ...withKids, evergreen: false });
  const eve = createTree({ ...withKids, evergreen: true });
  const decReach = reach(dec), eveReach = reach(eve);
  ok(decReach > 4, `4b: deciduous children reach roughly their full length (got ${decReach.toFixed(2)})`);
  ok(eveReach > 0, '4b: evergreen children are still generated');
  ok(eveReach < decReach, `4b: evergreen children are shortened toward the tip (${eveReach.toFixed(2)} < ${decReach.toFixed(2)})`);
  dec.dispose(); eve.dispose();
}
{
  // 4c: the presets that need it actually carry it.
  const byId = Object.fromEntries(EZ_TREE_FAMILIES.flatMap(f => f.species).map(s => [s.id, s]));
  for (const id of ['ez-pine_small', 'ez-pine_medium', 'ez-pine_large', 'ez-bush_3']) {
    ok(byId[id]?.opts.evergreen === true, `4c: ${id} is baked as evergreen`);
  }
  for (const id of ['ez-oak_large', 'ez-ash_small', 'ez-aspen_medium', 'ez-trellis']) {
    ok(byId[id]?.opts.evergreen === false, `4c: ${id} is baked as deciduous`);
  }
}

// ---- 5: children are not arranged in a helix around the parent ----
// The bug: height slot and azimuth slot both indexed by the child's loop counter, so child k sat
// at height k AND angle k. On a pine (~100 children off one trunk, evergreen length tracking
// height) that reads as a spiral staircase rather than a tree.
//
// Measured, not eyeballed. Children are emitted in loop order after the trunk and each occupies a
// fixed vertex run, so each child's centroid gives its azimuth. The statistic is the mean
// resultant length of the STEP between successive children's azimuths: a helix takes the same
// step every time (R ~ 1) whichever way it winds, uncorrelated slots spread the step around the
// circle (R ~ 1/sqrt(count)). Comparing each azimuth against k directly would not work — the
// child frame reflects the angle, so a helix reads as a constant step of the wrong sign and
// scores near zero on that test while looking exactly as wrong on screen.
{
  const COUNT = 32, SEC0 = 6, SEG0 = 5, SEC1 = 2, SEG1 = 3;
  const tree = createTree({
    seed: 11, levels: 1, length: [20, 5], radius: [1, 0.3], taper: [0.5, 0.5],
    children: [COUNT], sections: [SEC0, SEC1], segments: [SEG0, SEG1],
    branchStart: [0, 0], angle: [0, 90], gnarliness: [0, 0], twist: [0, 0],
    force: { direction: [0, 1, 0], strength: 0 }, leaves: { enabled: false },
  });
  const p = tree.branchesMesh.geometry.getAttribute('position').array;
  // The trunk's wall is followed by its two cap fans (tip and base, SEG+1 vertices each: the ring
  // plus a centre), and only then by the children. The trunk has children so its tip stays wide
  // and gets capped; the children are terminal, so they pinch shut and are capped by neither.
  const capVerts = SEG0 + 1;
  const trunkVerts = (SEC0 + 1) * (SEG0 + 1) + 2 * capVerts;
  const childVerts = (SEC1 + 1) * (SEG1 + 1);
  // If this fails the vertex layout changed and every index below is meaningless — so assert it.
  ok(p.length / 3 === trunkVerts + COUNT * childVerts,
    `5: trunk + ${COUNT} children fill the expected vertex runs (got ${p.length / 3}, want ${trunkVerts + COUNT * childVerts})`);

  const azimuths = [];
  for (let k = 0; k < COUNT; k++) {
    let cx = 0, cz = 0;
    for (let v = 0; v < childVerts; v++) {
      const i = (trunkVerts + k * childVerts + v) * 3;
      cx += p[i]; cz += p[i + 2];
    }
    azimuths.push(Math.atan2(cz / childVerts, cx / childVerts));
  }
  const wrap = d => { while (d <= -Math.PI) d += 2 * Math.PI; while (d > Math.PI) d -= 2 * Math.PI; return d; };
  let sumRe = 0, sumIm = 0, ascending = 0;
  for (let k = 1; k < COUNT; k++) {
    const d = wrap(azimuths[k] - azimuths[k - 1]);
    sumRe += Math.cos(d); sumIm += Math.sin(d);
    if (d > 0) ascending++;
  }
  const steps = COUNT - 1;
  const R = Math.hypot(sumRe, sumIm) / steps;
  ok(R < 0.5, `5: successive children step by an inconsistent amount around the trunk (mean resultant ${R.toFixed(3)}, helix would be ~1)`);
  ok(ascending > 3 && ascending < steps - 3,
    `5: successive children do not all wind the same way (${ascending}/${steps} ascending)`);
  tree.dispose();
}

// ---- 6: leaf atlas cells address the row the packer drew them into ----
// tree-textures.js paints cell i at canvas cell (i % cols, floor(i / cols)) with y running DOWN
// from the top-left. Texture v runs UP (flipY, three's default, and nothing here overrides it),
// so trees.js has to mirror the row when it turns a cell index into a UV rect. It did not, and
// every species drew the other row's leaf: the pine preset (cell 3, bottom-right of the atlas)
// sampled the top-right cell and grew aspen leaves.
{
  const COLS = 2, ROWS = 2;
  for (let cell = 0; cell < COLS * ROWS; cell++) {
    const tree = createTree({
      seed: 5, levels: 0, length: [8], radius: [1], sections: [3], segments: [4],
      leaves: { enabled: true, count: 6, shape: 'quad', doubleBillboard: false, spread: 1,
        atlas: { cols: COLS, rows: ROWS, cell } },
    });
    const uv = tree.leavesMesh.geometry.getAttribute('uv').array;
    ok(uv.length > 0, `6: cell ${cell} emits leaf UVs`);
    // Expected rect for a top-left-origin cell index, expressed in v-up texture space.
    const cx = cell % COLS, cyTop = Math.floor(cell / COLS);
    const wantU = [cx / COLS, (cx + 1) / COLS];
    const wantV = [1 - (cyTop + 1) / ROWS, 1 - cyTop / ROWS];
    let inside = true;
    for (let i = 0; i < uv.length; i += 2) {
      if (uv[i] < wantU[0] - 1e-6 || uv[i] > wantU[1] + 1e-6) inside = false;
      if (uv[i + 1] < wantV[0] - 1e-6 || uv[i + 1] > wantV[1] + 1e-6) inside = false;
    }
    ok(inside, `6: cell ${cell} samples u ${wantU.join('..')} / v ${wantV.join('..')} — the cell the packer drew it into`);
    // And actually spans the cell, so "inside" is not passing on a degenerate rect.
    const us = [], vs = [];
    for (let i = 0; i < uv.length; i += 2) { us.push(uv[i]); vs.push(uv[i + 1]); }
    ok(Math.abs(Math.min(...us) - wantU[0]) < 1e-6 && Math.abs(Math.max(...us) - wantU[1]) < 1e-6,
      `6: cell ${cell} spans the full cell horizontally`);
    ok(Math.abs(Math.min(...vs) - wantV[0]) < 1e-6 && Math.abs(Math.max(...vs) - wantV[1]) < 1e-6,
      `6: cell ${cell} spans the full cell vertically`);
    tree.dispose();
  }
  // The baked presets pin the cell that matches their leaf type, so the mapping above is what
  // decides whether a pine grows pine leaves.
  const byId = Object.fromEntries(EZ_TREE_FAMILIES.flatMap(f => f.species).map(s => [s.id, s]));
  const LEAF_FILES = ['oak', 'aspen', 'ash', 'pine'];   // tree-textures.js pack order
  for (const [id, leaf] of [['ez-oak_large', 'oak'], ['ez-aspen_large', 'aspen'], ['ez-ash_large', 'ash'], ['ez-pine_large', 'pine']]) {
    ok(LEAF_FILES[byId[id].opts.leaves.atlas.cell] === leaf, `6: ${id} pins the ${leaf} cell`);
  }
}

// ---- 7: the families feed forest-placement.js unchanged ----
{
  const table = buildSpeciesFromFamilies(EZ_TREE_FAMILIES);
  ok(table.length === 16, `7: buildSpeciesFromFamilies yields one entry per species (got ${table.length})`);
  ok(table.every(e => e._tag && Array.isArray(e._tag.biomes) && e._tag.density === 1), '7: every entry carries its placement tag');
  ok(table.every(e => Number.isFinite(e.seed) && Array.isArray(e.length)), '7: every entry is still a usable createTree() options object');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
