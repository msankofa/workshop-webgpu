import { levelRanges, nodeSize, minDistToCell, selectNodes, nodeCountForViewDistance } from './cdlod-select.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
const cfg = { leafSize: 16, levels: 7, patchQuads: 16, lodScale: 2.5, morphStart: 0.6, windowCells: 8 };

// ranges are geometric: range[L] = leafSize * 2^L * lodScale
const r = levelRanges(cfg);
ok(Math.abs(r[0] - 16 * 1 * 2.5) < 1e-9, 'range[0] = 40');
ok(Math.abs(r[3] - 16 * 8 * 2.5) < 1e-9, 'range[3] = 320');
ok(nodeSize(cfg, 2) === 64, 'nodeSize(2) = 64');

// minDistToCell: 0 inside the cell, exact edge distance outside
ok(minDistToCell(0, 0, 16, 8, 8) === 0, 'distance 0 when camera inside cell');
ok(Math.abs(minDistToCell(0, 0, 16, 32, 0) - 16) < 1e-9, 'distance to cell to the right');

// COVERAGE PARTITION: every sampled point near the camera is inside exactly one node.
function selectedCovering(nodes, px, pz) {
  let n = 0;
  for (const nd of nodes) {
    if (px >= nd.originX && px < nd.originX + nd.size && pz >= nd.originZ && pz < nd.originZ + nd.size) n++;
  }
  return n;
}
for (const [cx, cz] of [[0, 0], [37.5, -12.25], [123.4, 456.7]]) {
  const nodes = selectNodes(cfg, cx, cz);
  let exactlyOne = true;
  let bad = null;
  // sample a dense disk of radius ~range[levels-2] around the camera (inside coverage)
  const R = levelRanges(cfg)[cfg.levels - 2];
  for (let a = 0; a < 360 && exactlyOne; a += 7) {
    for (let rr = 2; rr < R; rr += R / 25) {
      const px = cx + Math.cos(a * Math.PI / 180) * rr;
      const pz = cz + Math.sin(a * Math.PI / 180) * rr;
      const c = selectedCovering(nodes, px, pz);
      if (c !== 1) { exactlyOne = false; bad = { px, pz, c }; break; }
    }
  }
  ok(exactlyOne, `coverage is a partition near camera (${cx},${cz})` + (bad ? ` [pt ${bad.px.toFixed(1)},${bad.pz.toFixed(1)} covered ${bad.c}x]` : ''));
}

// FINEST near camera, COARSER far: the node containing the camera is level 0.
{
  const nodes = selectNodes(cfg, 0.5, 0.5);
  const here = nodes.find(n => 0.5 >= n.originX && 0.5 < n.originX + n.size && 0.5 >= n.originZ && 0.5 < n.originZ + n.size);
  ok(here && here.level === 0, 'camera sits on a level-0 (finest) node');
}

// BOUNDED COST (THE GATE): node count never exceeds levels*windowCells^2 and is flat as
// view distance doubles (more levels add one bounded ring each, not area growth).
{
  const cap = cfg.levels * cfg.windowCells * cfg.windowCells;
  const n7 = nodeCountForViewDistance({ ...cfg, levels: 7 }, 0, 0);
  const n9 = nodeCountForViewDistance({ ...cfg, levels: 9 }, 0, 0);
  ok(n7 <= cap, `node count within candidate cap (${n7} <= ${cap})`);
  ok(n9 - n7 <= 2 * cfg.windowCells * cfg.windowCells, `adding 2 levels adds <= 2 rings (${n9}-${n7})`);
  ok(n9 < 4 * n7, `doubling distance does NOT quadruple node count (${n7} -> ${n9})`);
}

// SNAPPING STABILITY: nudging the camera < one leaf cell leaves coarse-node origins put.
{
  const a = selectNodes(cfg, 100, 100).filter(n => n.level >= 3).map(n => `${n.level}:${n.originX},${n.originZ}`).sort();
  const b = selectNodes(cfg, 100 + cfg.leafSize * 0.4, 100).filter(n => n.level >= 3).map(n => `${n.level}:${n.originX},${n.originZ}`).sort();
  ok(JSON.stringify(a) === JSON.stringify(b), 'sub-leaf camera move keeps coarse nodes stable (no shimmer)');
}

process.exit(fail ? 1 : 0);
