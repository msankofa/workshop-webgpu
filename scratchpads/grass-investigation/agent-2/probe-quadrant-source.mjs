// agent-2: does the RAW v5 draft source (no windowing at all) already read differently by the sign
// of x/z? If height/biome/moisture themselves are quadrant-symmetric, the bug is downstream in the
// windows/cull; if not, it's upstream in the source/noise/biome-classifier.
import { DEFAULT_CONFIG, DENSITY_DEFAULT_CONFIG } from '../../../terrain-generator-js.js';
import { defaultStack, makeLayer } from '../../../terrain-stack.js';
import { normalizeProject, PROJECT_APP, PROJECT_ALGORITHM_UNBOUNDED } from '../../../terrain-project-v5.js';
import { v5Descriptor, createV5Source } from '../../../terrain-source-v5.js';
import { createAnalyticSource, analyticDescriptor } from '../../../terrain-source-analytic.js';

function project({ seed = 1337, layers = null } = {}) {
  const stack = defaultStack();
  if (layers) stack.layers.push(...layers);
  return normalizeProject({ app: PROJECT_APP, version: 1, algorithmVersion: PROJECT_ALGORITHM_UNBOUNDED, name: 'Quad Probe',
    cfg: { ...DEFAULT_CONFIG, seed }, density: { ...DENSITY_DEFAULT_CONFIG }, stack, paint: null, imports: {} }).project;
}
const richLayers = () => [
  makeLayer('domainWarp', { id: 'W1', params: { amount: 40 } }),
  makeLayer('fbm', { id: 'F1', params: { amplitude: 35, scale: 300, seedOffset: 3 } }),
  makeLayer('ridged', { id: 'R1', params: { amplitude: 50, scale: 900 }, blendMode: 'max' }),
];

const v5 = createV5Source(v5Descriptor(project({ layers: richLayers() })));
const analytic = createAnalyticSource(analyticDescriptor({ key: 'quad-src', seaLevel: 0 }));

function probeSource(label, src) {
  console.log(`\n--- ${label}: raw source, no windowing ---`);
  const rays = [
    ['+x', 1, 0], ['-x', -1, 0], ['+z', 0, 1], ['-z', 0, -1],
    ['+x+z', 1, 1], ['+x-z', 1, -1], ['-x+z', -1, 1], ['-x-z', -1, -1],
  ];
  for (const R of [50, 200, 1000, 5000, 20000]) {
    const row = rays.map(([name, sx, sz]) => {
      const x = sx * R / Math.hypot(sx, sz), z = sz * R / Math.hypot(sx, sz);
      const h = src.heightAt(x, z);
      const b = src.biomeAt ? src.biomeAt(x, z) : null;
      return `${name}:h=${h.toFixed(1)},b=${b?.biome ?? b ?? '?'}`;
    });
    console.log(`R=${R}`, row.join('  '));
  }
}
probeSource('v5 draft', v5);
probeSource('analytic', analytic);

// Averages over many random points in each quadrant at a fixed radius band, height + moisture.
function quadrantAverages(label, src, rMin, rMax, n = 4000) {
  const buckets = { pp: [], pn: [], np: [], nn: [] };
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = rMin + Math.random() * (rMax - rMin);
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    const key = (x >= 0 ? 'p' : 'n') + (z >= 0 ? 'p' : 'n');
    const h = src.heightAt(x, z);
    const m = src.moistureAt ? src.moistureAt(x, z) : null;
    buckets[key].push([h, m]);
  }
  console.log(`\n--- ${label}: quadrant averages over r in [${rMin},${rMax}], n=${n} ---`);
  for (const [k, arr] of Object.entries(buckets)) {
    const hAvg = arr.reduce((s, [h]) => s + h, 0) / arr.length;
    const mAvg = arr.every(([, m]) => m != null) ? arr.reduce((s, [, m]) => s + m, 0) / arr.length : null;
    console.log(`  ${k}: n=${arr.length} heightAvg=${hAvg.toFixed(3)} moistureAvg=${mAvg == null ? 'n/a' : mAvg.toFixed(3)}`);
  }
}
quadrantAverages('v5 draft near', v5, 0, 300);
quadrantAverages('v5 draft far', v5, 5000, 6000);
quadrantAverages('analytic near', analytic, 0, 300);
quadrantAverages('analytic far', analytic, 5000, 6000);
