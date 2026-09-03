// Does the residency mask agree with tile presence in all four world quadrants? The GPU index is
// mirrored here exactly as gpuSampler computes it.
import { createFieldScheduler } from '../../terrain-field-scheduler.js';
import { createFieldWindow } from '../../terrain-field-window.js';
import { createAnalyticSource, analyticDescriptor } from '../../terrain-source-analytic.js';
const descriptor = analyticDescriptor({ key: 'quad', seaLevel: 0 });
const source = createAnalyticSource(descriptor);
const scheduler = createFieldScheduler({ useWorker: false, maxInFlight: 64, syncBudgetMs: 1000 });
for (const [post, n, tiles, label] of [[8, 16, 16, 'placement'], [1.25, 16, 8, 'contact']]) {
  const fw = createFieldWindow({ source, descriptor, scheduler, label, fields: ['heights'], post, tileIntervals: n, tilesPerSide: tiles, maxRequestsPerUpdate: 64 });
  const release = fw.acquire();
  for (let i = 0; i < 40; i++) { fw.update(3, -5); scheduler.pump(); }
  const res = fw.res, origin = [fw.win.originPX, fw.win.originPZ];
  const wrap = (v, r) => v - Math.floor(v / r) * r;
  const bad = { pp: 0, pn: 0, np: 0, nn: 0 }, seen = { pp: 0, pn: 0, np: 0, nn: 0 };
  const half = fw.extent / 2 - fw.tileSize;
  for (let i = 0; i < 20000; i++) {
    const x = (Math.random() * 2 - 1) * half, z = (Math.random() * 2 - 1) * half;
    const q = (x >= 0 ? 'p' : 'n') + (z >= 0 ? 'p' : 'n');
    // gpuSampler: p = xz/post - origin; c = floor(p); gi = c + origin (global post)
    const gi = [Math.floor(x / post - origin[0]) + origin[0], Math.floor(z / post - origin[1]) + origin[1]];
    const tileOf = g => [wrap(Math.floor(g[0] / n), tiles), wrap(Math.floor(g[1] / n), tiles)];
    const t00 = tileOf(gi), t11 = tileOf([gi[0] + 1, gi[1] + 1]);
    const landed = t => fw.residency[t[1] * tiles + t[0]] > 127;
    const gpuInside = landed(t00) && landed(t11) && landed([t11[0], t00[1]]) && landed([t00[0], t11[1]]);
    const cpuInside = fw.win.resolved(x, z) !== null;
    seen[q]++;
    if (gpuInside !== cpuInside) bad[q]++;
  }
  console.log(`${label}: coverage ${fw.coverage.toFixed(2)} origin ${origin} mismatches by quadrant`, bad, 'of', seen);
  release(); fw.dispose();
}
scheduler.dispose();

// A source swap: the window clears and refills; the mask must follow both steps.
{
  const scheduler2 = createFieldScheduler({ useWorker: false, maxInFlight: 64, syncBudgetMs: 1000 });
  const fw = createFieldWindow({ source, descriptor, scheduler: scheduler2, label: 'swap', fields: ['heights'], post: 8, tileIntervals: 16, tilesPerSide: 16, maxRequestsPerUpdate: 64 });
  const release = fw.acquire();
  for (let i = 0; i < 40; i++) { fw.update(3, -5); scheduler2.pump(); }
  const before = fw.residency.filter(v => v === 255).length;
  const other = createAnalyticSource(analyticDescriptor({ key: 'quad-2', seaLevel: 5 }));
  fw.setSource(other);
  fw.update(3, -5);
  const cleared = fw.residency.filter(v => v === 255).length;
  for (let i = 0; i < 40; i++) { fw.update(3, -5); scheduler2.pump(); }
  const after = fw.residency.filter(v => v === 255).length;
  console.log(`swap: mask landed ${before} -> ${cleared} after the swap -> ${after} refilled (coverage ${fw.coverage.toFixed(2)}, revision ${fw.residencyRevision})`);
  release(); fw.dispose(); scheduler2.dispose();
}
