// node scratchpads/spawn-atrium/count-growth.mjs -- headless count of what the viewer's flora rules build.
import { generateEco, soilTopAt } from '../../base-game-spawn-layout.js';
import { blockerRects, buildBlockerIndex, isBlocked, vineAnchors, bladeBudget } from '../../bot-flora-place.js';

const kind = process.argv[2] || 'complex';
const band = Number(process.argv[3] ?? Infinity);   // outdoor growth band in m; Infinity = whole bounds
const g = generateEco(kind, {}, 1);
const r = g.radius + 14;
const bounds = { minX: -r, maxX: r, minZ: -r, maxZ: r };
const toBox = (q) => ({ x: q.x, y: q.y + q.h / 2, z: q.z, w: q.w, h: q.h, d: q.d });
const walls = g.walls.filter((q) => q.y >= -1e-6 && q.h >= 1.2).map(toBox);
const covers = g.covers.map(toBox);
const vineBoxes = g.walls.filter((q) => q.y > 1.0 && q.h < 1.2 && q.w * q.d > 4).map(toBox);
const footprints = [...g.walls.filter((q) => q.y < 0), ...g.water];
const near = (x, z, pad) => footprints.some((f) => Math.abs(x - f.x) <= f.w / 2 + pad && Math.abs(z - f.z) <= f.d / 2 + pad);
const clearFn = (x, z) => soilTopAt(g.planters, x, z) == null && (near(x, z, 0.4) || !near(x, z, band));
const PAD = 3;
const padded = { minX: bounds.minX - PAD, maxX: bounds.maxX + PAD, minZ: bounds.minZ - PAD, maxZ: bounds.maxZ + PAD };
const index = buildBlockerIndex(blockerRects([...walls, ...covers], 0.3), padded, 2);
const extent = padded.maxX - padded.minX;
const asked = bladeBudget(padded, 36, 720000);
let seed = 7; const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
let kept = 0; const N = 200000;
for (let i = 0; i < N; i++) {
  const x = padded.minX + rng() * extent, z = padded.minZ + rng() * extent;
  if (clearFn(x, z) || isBlocked(index, x, z)) continue;
  kept++;
}
const vines = vineAnchors([...walls, ...vineBoxes], { density: 0.7, length: 3.4, lengthVar: 0.5, clump: 0.45, seed: 1 });
console.log(`${kind}: bounds ${(2 * r).toFixed(0)} m, blades asked ${asked.toLocaleString()} (${(asked / (extent * extent)).toFixed(1)}/m2), kept ${(asked * kept / N).toFixed(0).toLocaleString()} (${(100 * kept / N).toFixed(1)}% of the square), vines ${vines.length}`);
