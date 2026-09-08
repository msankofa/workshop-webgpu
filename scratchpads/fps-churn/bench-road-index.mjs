import { createRoadNetwork } from '../../road-network.js';
import { createRoadIndex } from '../../road-index.js';
import { samplePathOnGround } from '../../road-path.js';
const p = (x, z) => ({ x, y: 0, z });
const net = createRoadNetwork();
let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
for (let r = 0; r < 12; r++) { const pts = []; let x = rnd() * 800 - 400, z = rnd() * 800 - 400; for (let k = 0; k < 4; k++) { pts.push(p(x, z)); x += rnd() * 300 - 150; z += rnd() * 300 - 150; } net.addRoadPath(pts, 4); }
for (const e of net.edges.values()) e.sampledPath = samplePathOnGround(e.controlPoints, 1.15, () => 0);   // 1.15 m samples like a placed trail
const idx = createRoadIndex(net.nodes.values(), net.edges.values());
let pts = 0; for (const e of net.edges.values()) pts += e.sampledPath.length;
const N = 200000; const xs = new Float64Array(N), zs = new Float64Array(N);
for (let i = 0; i < N; i++) { xs[i] = rnd() * 1000 - 500; zs[i] = rnd() * 1000 - 500; }
let acc = 0; const t0 = performance.now();
for (let i = 0; i < N; i++) acc += idx.nearestDistance(xs[i], zs[i], 8) < 8 ? 1 : 0;
const ms = performance.now() - t0;
console.log(`${net.edges.size} edges, ${pts} samples; ${N} bounded queries (r=8): ${ms.toFixed(0)} ms, ${(1000 * ms / N).toFixed(2)} us/query, ${acc} near`);
