// Pure-math tests for world-map.js: the minimap affine must agree with the finder's own
// marker projection (so terrain and friend dots align), the big-map projection must be
// north-up / east-right, and the bake must shade by slope. Plain Node, no framework.
import {
  bakeMapPixels, minimapImageAffine, bigMapImageAffine, worldToBigMap,
  overlayColorizer, MAP_OVERLAYS,
} from './world-map.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };
const close = (a, b, t = 1e-6) => Math.abs(a - b) < t;
const normalizeAngle = a => Math.atan2(Math.sin(a), Math.cos(a));

// Replica of the finder marker formula (unclamped) from environment-viewer.html.
const S = 70 / 140; // px per world unit (radius 70, view 140)
function finderMarker(wx, wz, heading, px, pz, cx, cy) {
  const dx = wx - px, dz = wz - pz;
  const dist = Math.hypot(dx, dz);
  const bearing = normalizeAngle(-Math.atan2(dx, dz));
  const rel = normalizeAngle(bearing - heading);
  return { x: cx + Math.sin(rel) * S * dist, y: cy - Math.cos(rel) * S * dist };
}

// --- Test A: minimap affine agrees with the finder marker formula --------------------------
{
  const cases = [
    { heading: 0, px: 0, pz: 0, wx: 30, wz: -12 },
    { heading: Math.PI / 2, px: 5, pz: -8, wx: -40, wz: 60 },
    { heading: -2.1, px: -100, pz: 33, wx: 12, wz: 9 },
    { heading: 2.9, px: 200, pz: -50, wx: 240, wz: -80 },
  ];
  const cx = 110, cy = 108;
  // arbitrary bake grid metadata; image pixel (ix,iz) <-> world via wx0/sxu
  const wx0 = -600, wz0 = -600, sxu = 1200 / 384, szv = 1200 / 384;
  for (const c of cases) {
    const m = minimapImageAffine({ s: S, heading: c.heading, px: c.px, pz: c.pz, cx, cy, wx0, wz0, sxu, szv });
    const ix = (c.wx - wx0) / sxu, iz = (c.wz - wz0) / szv;
    const X = m[0] * ix + m[2] * iz + m[4];
    const Y = m[1] * ix + m[3] * iz + m[5];
    const want = finderMarker(c.wx, c.wz, c.heading, c.px, c.pz, cx, cy);
    ok(close(X, want.x) && close(Y, want.y), `A affine matches marker heading=${c.heading}`);
  }
  // At heading 0 the player sits at screen center regardless of world position.
  const m0 = minimapImageAffine({ s: S, heading: 0, px: 77, pz: -33, cx, cy, wx0, wz0, sxu, szv });
  const ixp = (77 - wx0) / sxu, izp = (-33 - wz0) / szv;
  ok(close(m0[0] * ixp + m0[2] * izp + m0[4], cx) && close(m0[1] * ixp + m0[3] * izp + m0[5], cy),
    'A player projects to minimap center');
}

// --- Test B: big-map is north-up (N=+Z up), east-right (E=-X right) -------------------------
{
  const proj = { scale: 0.4, cx: 300, cy: 300 };
  const north = worldToBigMap(0, 100, proj); // +Z
  const east = worldToBigMap(-100, 0, proj); // E = -X
  ok(north.y < proj.cy, 'B north is up');
  ok(close(north.x, proj.cx), 'B north has no horizontal shift');
  ok(east.x > proj.cx, 'B east is right');
  ok(close(east.y, proj.cy), 'B east has no vertical shift');

  // big-map image affine places the map corner (pixel 0,0 -> world wx0,wz0) correctly
  const wx0 = -600, wz0 = -600, sxu = 1200 / 384, szv = 1200 / 384;
  const bm = bigMapImageAffine({ scale: proj.scale, cx: proj.cx, cy: proj.cy, wx0, wz0, sxu, szv });
  const corner = { x: bm[4], y: bm[5] }; // ix=0,iz=0
  const wantCorner = worldToBigMap(wx0, wz0, proj);
  ok(close(corner.x, wantCorner.x) && close(corner.y, wantCorner.y), 'B image corner maps to world corner');
}

// --- Test C: bake of a flat single-biome grid is uniform and brightened --------------------
{
  const res = 8;
  const color = [100, 120, 140];
  const b = bakeMapPixels({
    res, cellWorld: 3,
    sampleBiomeColor: () => color,
    sampleHeight: () => 0,
  });
  const p0 = [b.data[0], b.data[1], b.data[2]];
  let uniform = true, opaque = true;
  for (let i = 0; i < res * res; i++) {
    if (b.data[i * 4] !== p0[0] || b.data[i * 4 + 1] !== p0[1] || b.data[i * 4 + 2] !== p0[2]) uniform = false;
    if (b.data[i * 4 + 3] !== 255) opaque = false;
  }
  ok(opaque, 'C all pixels opaque');
  ok(uniform, 'C flat grid is uniform');
  ok(p0[0] > color[0] && p0[1] > color[1] && p0[2] > color[2], 'C flat grid brightened by ambient light');
}

// --- Test D: a slope rising toward +x (faces west) is brighter than flat --------------------
{
  const res = 8;
  const color = [120, 120, 120];
  const flat = bakeMapPixels({ res, cellWorld: 3, sampleBiomeColor: () => color, sampleHeight: () => 0 });
  const slope = bakeMapPixels({ res, cellWorld: 3, sampleBiomeColor: () => color, sampleHeight: (ix) => ix });
  // interior cell (light comes from -x, a west-facing slope catches more light)
  const idx = (4 * res + 4) * 4;
  ok(slope.data[idx] > flat.data[idx], 'D west-facing slope brighter than flat');
}

// --- Test E: water cells get flattened shade -----------------------------------------------
{
  const res = 8;
  const color = [40, 80, 160];
  // Curved height so slope (and thus land shade) varies cell-to-cell.
  const height = (ix) => ix * ix;
  const land = bakeMapPixels({ res, cellWorld: 3, sampleBiomeColor: () => color, sampleHeight: height });
  const water = bakeMapPixels({ res, cellWorld: 3, sampleBiomeColor: () => color, sampleHeight: height, isWater: () => true });
  // Compare a gentle-slope cell (ix=2) against a steep-slope cell (ix=6) in the same row.
  const gentle = (r, ix) => (r * res + ix) * 4;
  const landSpread = Math.abs(land.data[gentle(4, 2)] - land.data[gentle(4, 6)]);
  const waterSpread = Math.abs(water.data[gentle(4, 2)] - water.data[gentle(4, 6)]);
  ok(landSpread > 3, 'E land shade varies with slope');
  ok(waterSpread < landSpread, 'E water shade flatter than land shade');
}

// --- Test F: overlayColorizer covers every MAP_OVERLAYS id and reflects the sampled data ---
{
  // Fake authored map: a slope rising toward +x, water in the -x half, biome/density ramps.
  const fakeMap = {
    worldX: 1200, worldZ: 1200, resolution: 96, seaLevel: 0,
    heightAt: (x) => x * 0.1,                       // -60..60 across the map
    biomeAt: (x) => (x < 0 ? 'ocean' : 'plains'),
    grassDensityAt: (x) => clamp01((x + 600) / 1200),
    treeDensityAt: (x) => clamp01((x + 600) / 1200),
    surfaceField: () => ({ materialColor: [0.4, 0.6, 0.3] }),
  };
  function clamp01(v) { return Math.min(1, Math.max(0, v)); }

  for (const o of MAP_OVERLAYS) {
    const c = overlayColorizer(fakeMap, o.id);
    const rgb = c.color(100, 0);
    const valid = Array.isArray(rgb) && rgb.length === 3 && rgb.every(v => Number.isFinite(v) && v >= 0 && v <= 255);
    ok(valid && typeof c.shaded === 'boolean', `F overlay ${o.id} returns a valid color + shaded flag`);
  }
  // Data overlays are flat (unshaded); the map-like layers get relief.
  ok(overlayColorizer(fakeMap, 'slope').shaded === false, 'F slope is unshaded');
  ok(overlayColorizer(fakeMap, 'biome').shaded === true, 'F biome is shaded');
  // Water depth: deeper (more negative height) reads a different (darker) blue than shallow.
  const water = overlayColorizer(fakeMap, 'water');
  const deep = water.color(-500, 0), shallow = water.color(-50, 0);
  ok(deep[2] !== shallow[2], 'F water depth varies with height');
  // Grass density: low vs high density differ.
  const grass = overlayColorizer(fakeMap, 'grass');
  ok(grass.color(-500, 0)[1] !== grass.color(500, 0)[1], 'F grass density varies');
  // Material overlay scales the 0..1 surfaceField color into 0..255.
  const mat = overlayColorizer(fakeMap, 'material').color(100, 0);
  ok(Math.abs(mat[0] - 0.4 * 255) < 1 && Math.abs(mat[1] - 0.6 * 255) < 1, 'F material scales 0..1 to 0..255');
}

// --- Test G: bakeMapPixels shaded:false emits the sampled color verbatim -------------------
{
  const res = 6;
  const color = [90, 130, 60];
  const b = bakeMapPixels({ res, cellWorld: 3, sampleBiomeColor: () => color, sampleHeight: (ix) => ix * ix, shaded: false });
  let exact = true, opaque = true;
  for (let i = 0; i < res * res; i++) {
    if (b.data[i * 4] !== color[0] || b.data[i * 4 + 1] !== color[1] || b.data[i * 4 + 2] !== color[2]) exact = false;
    if (b.data[i * 4 + 3] !== 255) opaque = false;
  }
  ok(exact, 'G unshaded bake emits the sampled color unchanged (no hillshade)');
  ok(opaque, 'G unshaded bake is opaque');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
