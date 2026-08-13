// Full corner bake vs footprint-local update, at the scale bot-viewer-v3 actually runs.
// Run: node bench-corners.mjs [sizeMetres] [wallCount]
//
// The question it answers: when one wall comes down mid-fight, is re-baking the whole corner map
// affordable, or does the destruction path need updateCornerMapInBounds? See
// docs/wall-destruction-plan.md.
import { buildNavGrid } from './nav-grid.js';
import { buildSightGrid, buildLazyVisibilityField, buildHeightGrid } from './nav-visibility.js';
import { buildCornerMap, updateCornerMapInBounds } from './nav-corners.js';

const SIZE = Number(process.argv[2] || 200);
const WALLS = Number(process.argv[3] || 900);
const CELL = 0.5;

// Deterministic scatter: fins on a jittered lattice, roughly what a maze emits.
let s = 0x2545f491;
const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const half = SIZE / 2;
const rects = [];
for (let i = 0; i < WALLS; i++) {
  const vertical = rnd() < 0.5;
  const len = 3 + rnd() * 6;
  rects.push({
    x: -half + rnd() * SIZE, z: -half + rnd() * SIZE,
    w: vertical ? 0.3 : len, d: vertical ? len : 0.3, h: 3,
  });
}
const bounds = { minX: -half, maxX: half, minZ: -half, maxZ: half };

const inRect = (r, x, z) => Math.abs(x - r.x) <= r.w / 2 && Math.abs(z - r.z) <= r.d / 2;
const walkable = (list) => (x, z) => !list.some(r => inRect(r, x, z));

const t = (label, fn) => { const t0 = performance.now(); const v = fn(); const ms = performance.now() - t0; return { label, ms, v }; };

const MARGIN = 0.55;   // WALL_MARGIN in bot-viewer-v3
const scanTest = (x, z) => !rects.some(r => Math.abs(x - r.x) <= r.w / 2 + MARGIN && Math.abs(z - r.z) <= r.d / 2 + MARGIN);
const gScan = t('nav grid (per-cell scan)', () => buildNavGrid(scanTest, bounds, CELL));
const gRast = t('nav grid (rasterized)', () => buildNavGrid(() => true, bounds, CELL,
  { blockers: rects, blockerMargin: MARGIN }));
console.log(`nav bake: scan ${gScan.ms.toFixed(1)} ms vs rasterized ${gRast.ms.toFixed(1)} ms `
  + `(${(gScan.ms / Math.max(gRast.ms, 1e-6)).toFixed(1)}x), identical cells: `
  + `${gScan.v.cells.every((v, i) => v === gRast.v.cells[i])}`);

const g = t('nav grid', () => buildNavGrid(walkable(rects), bounds, CELL));
const heights = buildHeightGrid(g.v, (x, z) => Math.sin(x * 0.08) * 3 + Math.cos(z * 0.06) * 2.5);
const f = t('vis field', () => buildLazyVisibilityField(g.v, buildSightGrid(g.v, rects), { terrain: { heights } }));
const b = t('corner bake (full)', () => buildCornerMap(g.v, rects, f.v, { heights }));

console.log(`map ${SIZE} m, ${WALLS} walls, ${g.v.cols}x${g.v.rows} cells (${g.v.cols * g.v.rows} total)`);
console.log(`  ${g.label.padEnd(20)} ${g.ms.toFixed(1)} ms`);
console.log(`  ${f.label.padEnd(20)} ${f.ms.toFixed(1)} ms  (${f.v.walkableCount} walkable)`);
console.log(`  ${b.label.padEnd(20)} ${b.ms.toFixed(1)} ms  (${b.v.corners.length} records)`);

// One wall destroyed: rebake everything downstream vs update only its footprint.
const victim = rects[Math.floor(WALLS / 2)];
const after = rects.filter(r => r !== victim);
const dirty = { minX: victim.x - victim.w / 2, maxX: victim.x + victim.w / 2,
  minZ: victim.z - victim.d / 2, maxZ: victim.z + victim.d / 2 };

const g2 = t('nav grid', () => buildNavGrid(walkable(after), bounds, CELL));
const f2 = t('vis field', () => buildLazyVisibilityField(g2.v, buildSightGrid(g2.v, after), { terrain: { heights } }));
const rebake = t('corner bake (full)', () => buildCornerMap(g2.v, after, f2.v, { heights }));
const local = t('corner update (local)', () => updateCornerMapInBounds(b.v, g2.v, after, f2.v, dirty, { heights }));

console.log(`\none wall destroyed:`);
console.log(`  ${rebake.label.padEnd(24)} ${rebake.ms.toFixed(1)} ms  (${rebake.v.corners.length} records)`);
console.log(`  ${local.label.padEnd(24)} ${local.ms.toFixed(1)} ms  (${local.v.corners.length} records, crests ${local.v.crestExact ? 'untouched' : 'rescanned'})`);
console.log(`  speedup ${(rebake.ms / Math.max(local.ms, 1e-6)).toFixed(1)}x`);
console.log(`  (nav rebuild ${g2.ms.toFixed(1)} ms and field rebuild ${f2.ms.toFixed(1)} ms are still whole-map here)`);

// Equivalence at scale, not just in the unit test's small worlds.
const key = r => [r.kind, r.corner.x.toFixed(4), r.corner.z.toFixed(4), r.anchorCell, r.peekCell, r.peekDir.x, r.peekDir.z].join('|');
const A = new Set(rebake.v.corners.filter(r => r.kind === 'wall').map(key));
const B = new Set(local.v.corners.filter(r => r.kind === 'wall').map(key));
const missing = [...A].filter(k => !B.has(k)).length, extra = [...B].filter(k => !A.has(k)).length;
console.log(`  wall-record equivalence: ${missing} missing, ${extra} extra ${missing || extra ? '<-- MISMATCH' : 'OK'}`);
