// Headless: how far the 8 m placement field (what blades beyond the contact ring stand on) sits
// from the true ground, in blade heights. node scratchpads/grass-investigation/check-height-mismatch.mjs
import * as THREE from 'three';
import { createBaseGameFlora } from '../../base-game-flora.js';
import { createBaseGameTerrain } from '../../base-game-terrain.js';
import { createWorldQueryService } from '../../world-query.js';
import { createWorldCoordinateSpace } from '../../world-coordinates.js';
import { analyticDescriptor } from '../../terrain-source-analytic.js';

const scene = new THREE.Scene();
const worldQuery = createWorldQueryService();
const worldCoordinates = createWorldCoordinateSpace();
const terrain = createBaseGameTerrain({ scene, worldQuery, worldCoordinates,
  source: analyticDescriptor({ key: 'mismatch', seaLevel: 0 }), useWorker: false });
terrain.setActive(true);
const flora = createBaseGameFlora({ scene, camera: new THREE.PerspectiveCamera(), terrain, worldCoordinates });
flora.setEnabled(true);
for (let i = 0; i < 400; i++) { terrain.update([0, 0, 0], 1 / 60); terrain.fieldScheduler.pump(); }
console.log('contact coverage', terrain.contactField.coverage.toFixed(2), 'placement coverage', terrain.fields.coverage.toFixed(2));
const near = terrain.contactField, far = terrain.fields;
const hf = far.fields.includes('surfaceHeights') ? 'surfaceHeights' : 'heights';
const bands = [[0, 60], [60, 70], [70, 150], [150, 300], [300, 600]];
for (const [r0, r1] of bands) {
  const diffs = [];
  let missing = 0, n = 0;
  for (let k = 0; k < 4000; k++) {
    const a = Math.random() * Math.PI * 2, r = r0 + Math.random() * (r1 - r0);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const truth = terrain.groundHeight(x, z);
    const h8 = far.sampleAt(hf, x, z);
    if (h8 == null || truth == null) { missing++; continue; }
    n++;
    diffs.push(h8 - truth);
  }
  diffs.sort((p, q) => p - q);
  const q = f => diffs[Math.min(diffs.length - 1, Math.floor(f * diffs.length))];
  const buried = diffs.filter(d => d < -0.5).length / diffs.length;      // field under the ground by > half a 1 m blade
  const deep = diffs.filter(d => d < -1).length / diffs.length;          // a whole blade under
  const floating = diffs.filter(d => d > 0.3).length / diffs.length;
  console.log(`${r0}-${r1} m: n=${n} missing=${missing} field-truth p5=${q(0.05).toFixed(2)} p50=${q(0.5).toFixed(2)} p95=${q(0.95).toFixed(2)} | >0.5 m under ${(buried*100).toFixed(0)}%  >1 m under ${(deep*100).toFixed(0)}%  >0.3 m floating ${(floating*100).toFixed(0)}%`);
}
// And the contact window against truth, for the near ring.
{
  const diffs = [];
  for (let k = 0; k < 4000; k++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * 60;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const h = near.sampleAt(near.fields[0], x, z), t = terrain.groundHeight(x, z);
    if (h == null) continue;
    diffs.push(h - t);
  }
  diffs.sort((p, q) => p - q);
  const q = f => diffs[Math.min(diffs.length - 1, Math.floor(f * diffs.length))];
  console.log(`contact (1.25 m) 0-60 m: p5=${q(0.05).toFixed(3)} p50=${q(0.5).toFixed(3)} p95=${q(0.95).toFixed(3)}`);
}
terrain.dispose();
