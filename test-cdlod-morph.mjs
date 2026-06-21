import { morphGridCoord, nodeSize } from './cdlod-select.js';
import { grassHeightRef } from './grass-height-ref.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
const cfg = { leafSize: 16, levels: 7, patchQuads: 16, lodScale: 2.5, morphStart: 0.6, windowCells: 8 };
const N = cfg.patchQuads;

// At morphK=0 the grid coord is unchanged.
for (const g of [0, 0.3125, 0.5, 1]) ok(Math.abs(morphGridCoord(g, N, 0) - g) < 1e-12, `morphK=0 identity at g=${g}`);

// At morphK=1 every grid coord lands on the EVEN (parent) lattice — multiples of 2/N.
let onParent = true;
for (let i = 0; i <= N; i++) {
  const g = i / N;
  const m = morphGridCoord(g, N, 1);
  const onEven = Math.abs((m * N / 2) - Math.round(m * N / 2)) < 1e-9;
  if (!onEven) onParent = false;
}
ok(onParent, 'morphK=1 snaps all vertices onto the parent (even) lattice');

// CRACK-FREE: a level-L node fully morphed (k=1) samples heights along its shared edge at
// exactly the parent lattice points -> identical to the coarser neighbor -> no gap.
{
  const L = 2, s = nodeSize(cfg, L), ox = 0, oz = 0;
  const params = { baseAmp: 1, lake: 0.45, lakeDepth: 3.2 };
  let maxGap = 0;
  for (let i = 0; i <= N; i++) {
    const gFine = i / N;
    const wxFine = ox + morphGridCoord(gFine, N, 1) * s;       // morphed (snaps odd verts down to even)
    // the coarser neighbor (size 2s, N quads) has vertices at ox + k*(2s/N); the morphed fine
    // vertex lands on one of them (k = floor(i/2)). Heights there must agree => no crack.
    const wxCoarse = ox + Math.floor(i / 2) * (2 / N) * s;
    maxGap = Math.max(maxGap, Math.abs(grassHeightRef(params, wxFine, oz) - grassHeightRef(params, wxCoarse, oz)));
  }
  ok(maxGap < 1e-6, `fully-morphed edge heights match the parent lattice (crack-free, gap=${maxGap.toExponential(2)})`);
}

process.exit(fail ? 1 : 0);
