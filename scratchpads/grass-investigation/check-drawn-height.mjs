// How far the height the far rings DRAW (clipmap.drawnHeightAt, the phase-5 grass source) sits
// from the true ground, by distance band, beside the 8 m placement field it replaces.
// node scratchpads/grass-investigation/check-drawn-height.mjs
import * as THREE from 'three';
import { createBaseGameTerrain } from '../../base-game-terrain.js';
import { createWorldQueryService } from '../../world-query.js';
import { createWorldCoordinateSpace } from '../../world-coordinates.js';
import { analyticDescriptor } from '../../terrain-source-analytic.js';
import { createBaseGameFlora } from '../../base-game-flora.js';

const scene = new THREE.Scene();
const worldCoordinates = createWorldCoordinateSpace();
const terrain = createBaseGameTerrain({ scene, worldQuery: createWorldQueryService(), worldCoordinates,
  source: analyticDescriptor({ key: 'drawn-check', seaLevel: 0 }), useWorker: false, farLod: true });
terrain.setActive(true);
const flora = createBaseGameFlora({ scene, camera: new THREE.PerspectiveCamera(), terrain, worldCoordinates });
flora.setEnabled(true);
for (let i = 0; i < 400; i++) { terrain.update([0, 0, 0], 1 / 60); terrain.fieldScheduler.pump(); }
const bands = [[70, 150], [150, 300], [300, 600]];
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
for (const [r0, r1] of bands) {
  const drawn = [], field = [];
  let n = 0, miss = 0;
  for (let i = 0; i < 4000; i++) {
    const a = Math.random() * Math.PI * 2, r = r0 + Math.random() * (r1 - r0);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const g = terrain.groundHeight(x, z);
    const d = terrain.drawnHeightAt(x, z);
    const f = terrain.fields?.sampleAt(terrain.fields.fields.includes('surfaceHeights') ? 'surfaceHeights' : 'heights', x, z);
    n++;
    if (d == null) { miss++; continue; }
    drawn.push(d - g);
    if (f != null) field.push(f - g);
  }
  const fmt = a => a.length ? `p5 ${q(a, 0.05).toFixed(2)} p50 ${q(a, 0.5).toFixed(2)} p95 ${q(a, 0.95).toFixed(2)} |>0.3| ${(a.filter(v => Math.abs(v) > 0.3).length / a.length * 100).toFixed(0)}%` : 'none';
  console.log(`${r0}-${r1} m  drawn minus ground: ${fmt(drawn)}   (${miss} of ${n} unresolved)\n           field minus ground: ${fmt(field)}`);
}
terrain.dispose();
