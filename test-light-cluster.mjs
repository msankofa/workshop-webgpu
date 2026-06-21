import {
  zSlice, sliceDepthRange, froxelViewAABB, sphereIntersectsAABB,
  assignLightsExact, buildZBins, buildTileBitmask, froxelLightSet,
} from './light-cluster.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };

// small, hand-reasonable grid
const cfg = {
  tile: 32, screenW: 128, screenH: 128,   // -> 4x4 tiles
  zSlices: 4, near: 1, far: 100,
  tanHalfFovY: Math.tan(30 * Math.PI / 180), aspect: 1,
};
const tilesX = Math.ceil(cfg.screenW / cfg.tile);  // 4
const tilesY = Math.ceil(cfg.screenH / cfg.tile);  // 4

// ---- exponential depth slicing ----
ok(zSlice(cfg.near, cfg) === 0, 'zSlice(near) = 0');
ok(zSlice(0.5, cfg) === 0, 'zSlice(<near) clamps to 0');
ok(zSlice(cfg.far - 0.01, cfg) === cfg.zSlices - 1, 'zSlice(~far) = last slice');
ok(zSlice(cfg.far + 50, cfg) === cfg.zSlices - 1, 'zSlice(>far) clamps to last');
let mono = true; let prev = -1;
for (let d = 1; d <= 100; d += 1) { const s = zSlice(d, cfg); if (s < prev) mono = false; prev = s; }
ok(mono, 'zSlice monotonic non-decreasing in depth');
{
  const r0 = sliceDepthRange(0, cfg), r3 = sliceDepthRange(3, cfg);
  ok(Math.abs(r0.dNear - 1) < 1e-9, 'slice 0 starts at near');
  ok(Math.abs(r3.dFar - 100) < 1e-6, 'last slice ends at far');
  // a depth inside slice s maps back to s
  let inv = true;
  for (let s = 0; s < cfg.zSlices; s++) {
    const r = sliceDepthRange(s, cfg);
    const mid = Math.sqrt(r.dNear * r.dFar);
    if (zSlice(mid, cfg) !== s) inv = false;
  }
  ok(inv, 'sliceDepthRange inverts zSlice (mid of slice s -> s)');
}

// ---- froxel view-space AABB ----
{
  const a0 = froxelViewAABB(1, 1, 0, cfg);
  const a3 = froxelViewAABB(1, 1, 3, cfg);
  ok(a0.max[0] - a0.min[0] < a3.max[0] - a3.min[0], 'deeper froxel is wider in x (perspective)');
  ok(Math.abs(a0.min[2] - (-sliceDepthRange(0, cfg).dFar)) < 1e-6, 'froxel min z = -dFar');
  ok(Math.abs(a0.max[2] - (-sliceDepthRange(0, cfg).dNear)) < 1e-6, 'froxel max z = -dNear');
  // adjacent tiles in x share an x-face at the same slice
  const left = froxelViewAABB(1, 1, 2, cfg);
  const right = froxelViewAABB(2, 1, 2, cfg);
  ok(Math.abs(left.max[0] - right.min[0]) < 1e-6, 'adjacent froxels share an x face (no gap/overlap)');
}

// ---- sphere vs AABB ----
ok(sphereIntersectsAABB([0, 0, 0], 1, [-1, -1, -1], [1, 1, 1]), 'sphere center inside AABB');
ok(sphereIntersectsAABB([2, 0, 0], 1.01, [-1, -1, -1], [1, 1, 1]), 'sphere just touching face');
ok(!sphereIntersectsAABB([3, 0, 0], 1, [-1, -1, -1], [1, 1, 1]), 'sphere clearly outside');

// ---- light assignment: exact vs Z-bin∩bitmask (conservative superset) ----
{
  // view space: camera looks down -Z; lights in front have negative z
  const lights = [
    { v: [0, 0, -10], r: 6 },      // center, mid depth
    { v: [-8, 0, -40], r: 5 },     // left, deeper
    { v: [0, 0, 200], r: 5 },      // BEHIND camera (+z) -> nowhere
  ];
  const exact = assignLightsExact(lights, cfg, tilesX, tilesY);
  // every froxel the exact test assigns must be reproduced by zbin ∩ bitmask (no misses)
  const sorted = lights.map((l, i) => ({ ...l, i })).sort((a, b) => (-a.v[2] - a.r) - (-b.v[2] - b.r));
  const order = sorted.map(s => s.i);
  const zBins = buildZBins(sorted, cfg);
  const bitmask = buildTileBitmask(lights, cfg, tilesX, tilesY);

  let superset = true, anyAssigned = false, behindLeak = false;
  for (let s = 0; s < cfg.zSlices; s++) {
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        const ex = exact[`${tx},${ty},${s}`] || [];
        if (ex.length) anyAssigned = true;
        const got = froxelLightSet(tx, ty, s, zBins, bitmask, order, tilesX);
        const gotSet = new Set(got);
        for (const li of ex) if (!gotSet.has(li)) superset = false;     // no missed light
        if (gotSet.has(2)) behindLeak = true;                          // light 2 is behind camera
      }
    }
  }
  ok(anyAssigned, 'exact assignment puts lights in some froxels');
  ok(superset, 'Z-bin ∩ bitmask is a conservative superset of the exact froxel-AABB set (no dark froxels)');
  ok(!behindLeak, 'a light behind the camera is assigned to no froxel');
}

// ---- capacity: bitmask sized to hold CAP_LIGHTS bits, no overflow ----
{
  const many = Array.from({ length: 100 }, (_, i) => ({ v: [0, 0, -10 - i * 0.1], r: 3 }));
  const bm = buildTileBitmask(many, cfg, tilesX, tilesY);
  const words = Math.ceil(100 / 32);
  ok(bm.wordsPerTile === words, `bitmask has ceil(N/32) words per tile (${bm.wordsPerTile})`);
  ok(bm.bits.length === words * tilesX * tilesY, 'bitmask buffer sized words*tiles');
}

process.exit(fail ? 1 : 0);
