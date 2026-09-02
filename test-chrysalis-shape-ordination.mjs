// Point-cloud embedding + ordination for Chrysalis Engine shapes (sabosugi-visuals/hybrids). The
// field itself has no mesh, so shapes are compared by sphere-tracing a point cloud, reducing it to
// a fixed-length descriptor (chrysalis-shape-embed.mjs), then running the same Gram/PCA machinery
// code-ordination.html uses for source files (ordination-vectors.js) -- that half is generic over
// any vector, not text-specific, so it is exercised here unmodified.
import { tracePointCloud } from './sabosugi-visuals/hybrids/chrysalis-point-cloud.mjs';
import { embedPointCloud, toSparseRow, DEFAULT_BINS } from './sabosugi-visuals/hybrids/chrysalis-shape-embed.mjs';
import { buildCorpus, RANGES } from './sabosugi-visuals/hybrids/chrysalis-shape-corpus.mjs';
import { buildGram, gramDistance, eigenCoords } from './ordination-vectors.js';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) { failures++; console.error(`FAIL ${name} ${detail}`); }
  else console.log(`ok   ${name}`);
};

const DIM = DEFAULT_BINS + 5;
const TRACE_OPTS = { rayCount: 500, outerSteps: 64 };
const EMBED_OPTS = { pairSamples: 3000 };

function embedEntry(entry) {
  const cloud = tracePointCloud(entry.config, entry.seeds, TRACE_OPTS);
  const vector = embedPointCloud(cloud, entry.seeds, EMBED_OPTS);
  return { ...entry, cloud, row: toSparseRow(vector) };
}

// --- Main corpus: real saved states + a handful of synthetic ones ---
const corpus = buildCorpus({ syntheticCount: 8 }).map(embedEntry);
check('corpus has real and synthetic entries', corpus.some((e) => e.real) && corpus.some((e) => !e.real));

for (const entry of corpus) {
  check(`${entry.name}: point cloud got hits`, entry.cloud.points.length > entry.cloud.missCount,
    `${entry.cloud.points.length} hits / ${entry.cloud.missCount} misses of ${entry.cloud.rayCount}`);
}

const G = buildGram(corpus.map((e) => e.row), DIM);

let maxSelfDistance = 0;
for (let i = 0; i < corpus.length; i++) maxSelfDistance = Math.max(maxSelfDistance, gramDistance(G, i, i));
check('self-distance is ~0', maxSelfDistance < 1e-6, `max ${maxSelfDistance}`);

let maxAsymmetry = 0;
for (let i = 0; i < corpus.length; i++) for (let j = 0; j < corpus.length; j++) {
  maxAsymmetry = Math.max(maxAsymmetry, Math.abs(G[i][j] - G[j][i]));
}
check('Gram matrix is symmetric', maxAsymmetry < 1e-9, `max asymmetry ${maxAsymmetry}`);

const { coords } = eigenCoords(G, 2);
check('PCA produced one 2D point per shape', coords.length === corpus.length);
check('PCA coords are finite', coords.every((c) => c.every(Number.isFinite)));

console.log('\nlabel/coords (PCA, not distances -- for eyeballing only):');
corpus.forEach((entry, i) => {
  const [x, y] = coords[i];
  console.log(`  ${entry.real ? 'real  ' : 'synth '} ${entry.name.padEnd(20)} ${x.toFixed(3)}, ${y.toFixed(3)}`);
});

// --- Structural sanity: an all-crystal shape should sit farther from an all-organic one than
// from a second, differently-oriented all-crystal shape. ---
function midpointConfig() {
  const config = { outerSteps: 64, stepSafety: 0.46 };
  for (const [key, [min, max]] of Object.entries(RANGES)) config[key] = (min + max) / 2;
  return config;
}

const base = midpointConfig();
const organic = { ...base, globalGrowth: 0 };
const crystalA = { ...base, globalGrowth: 1 };
const crystalB = { ...base, globalGrowth: 1, crystalRotZ: base.crystalRotZ + 0.6, facetFrequency: base.facetFrequency * 1.3 };

const structural = [
  { name: 'organic', config: organic, seeds: [] },
  { name: 'crystalA', config: crystalA, seeds: [] },
  { name: 'crystalB', config: crystalB, seeds: [] },
].map(embedEntry);

const Gs = buildGram(structural.map((e) => e.row), DIM);
const dOrganicCrystalA = gramDistance(Gs, 0, 1);
const dCrystalACrystalB = gramDistance(Gs, 1, 2);
check('all-crystal sits farther from all-organic than from another crystal variant',
  dOrganicCrystalA > dCrystalACrystalB,
  `organic~crystalA ${dOrganicCrystalA.toFixed(4)} vs crystalA~crystalB ${dCrystalACrystalB.toFixed(4)}`);

console.log(failures === 0 ? '\nall shape-ordination checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
