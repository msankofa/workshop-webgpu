// Phase 7 checks: Terrain Generator v5 project as a streamable terrain source.
// Run: node test-terrain-source-v5.mjs
import { DEFAULT_CONFIG, DENSITY_DEFAULT_CONFIG, generateNoiseFields, composeClassicHeight } from './terrain-generator-js.js';
import { defaultStack, makeLayer, evaluateStackGrid } from './terrain-stack.js';
import { PaintLayers } from './terrain-paint.js';
import { normalizeProject, migrateProjectToUnbounded, classifyProject, PROJECT_APP, PROJECT_ALGORITHM_UNBOUNDED } from './terrain-project-v5.js';
import { createSource, TerrainSourceError } from './terrain-source.js';
import { v5Descriptor, createV5Source, V5_SOURCE_ALGORITHM_VERSION } from './terrain-source-v5.js';
import { sampleHeightTileBilinear } from './terrain-field.js';
import { createUnboundedFieldSampler, createFieldSampler } from './biome-classifier-js.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const throws = (fn, msg) => { let e = null; try { fn(); } catch (x) { e = x; } ok(e instanceof TerrainSourceError, `${msg} -> ${e ? e.message.slice(0, 90) : 'no throw'}`); };

function project({ seed = 1337, layers = null, algorithmVersion = PROJECT_ALGORITHM_UNBOUNDED, name = 'Test Hills', ...rest } = {}) {
  const stack = defaultStack();
  if (layers) stack.layers.push(...layers);
  return normalizeProject({ app: PROJECT_APP, version: 1, algorithmVersion, name, cfg: { ...DEFAULT_CONFIG, seed }, density: { ...DENSITY_DEFAULT_CONFIG }, stack, paint: null, imports: {}, ...rest }).project;
}
const richLayers = () => [
  makeLayer('domainWarp', { id: 'W1', params: { amount: 40 } }),
  makeLayer('fbm', { id: 'F1', params: { amplitude: 35, scale: 300, seedOffset: 3 } }),
  makeLayer('ridged', { id: 'R1', params: { amplitude: 50, scale: 900 }, blendMode: 'max' }),
  makeLayer('voronoi', { id: 'V1', params: { amplitude: 12, scale: 150 }, mask: { enabled: true, lo: 10, hi: 60, feather: 10 } }),
  makeLayer('terrace', { id: 'T1', params: { stepHeight: 8, strength: 0.5 } }),
];
const size = 30, intervals = 24, apron = 1;
const req = (ix, iz, fields) => ({ ix, iz, xMin: ix * size, zMin: iz * size, size, intervals, apron, fields });

console.log('\n[1] descriptor and source construction');
{
  const p = project({ layers: richLayers() });
  const d = v5Descriptor(p);
  ok(d.kind === 'v5-recipe' && d.key === 'Test-Hills' && d.sourceVersion.length === 16 && d.algorithmVersion === V5_SOURCE_ALGORITHM_VERSION, `descriptor ${d.key}@${d.sourceVersion}`);
  ok(d.capabilities.includes('infinite') && d.bounds === null, 'claims infinite, no bounds');
  const src = createSource(JSON.parse(JSON.stringify(d)));
  ok(typeof src.heightAt(0, 0) === 'number' && src.classification.runtimeSupported, 'registry builds the source from JSON');
  throws(() => v5Descriptor(project({ algorithmVersion: 'v5-bounded-1' })), 'bounded-algorithm project rejected');
  throws(() => v5Descriptor(project({ layers: [makeLayer('import', { id: 'I1' })] })), 'import layer rejected');
  const painted = project({ paint: { resolution: 8 } });
  throws(() => v5Descriptor(painted), 'painted project rejected');
  throws(() => createV5Source({ ...d, config: { ...d.config, projectHash: 'deadbeef' } }), 'hash mismatch rejected');
  throws(() => createV5Source({ ...d, algorithmVersion: 'other' }), 'unknown source algorithm rejected');
}

console.log('\n[2] point and tile evaluation agree exactly at tile samples');
{
  const src = createV5Source(project({ layers: richLayers() }));
  for (const [ix, iz] of [[0, 0], [-2, 3], [40, -17]]) {
    const t = src.buildTile(req(ix, iz, ['heights', 'normals']));
    let maxH = 0, maxN = 0;
    const n = [0, 0, 0];
    for (let tz = 0; tz < t.texels; tz += 5) for (let tx = 0; tx < t.texels; tx += 5) {
      const x = t.originX + tx * t.step, z = t.originZ + tz * t.step;
      maxH = Math.max(maxH, Math.abs(t.heights[tz * t.texels + tx] - Math.fround(src.heightAt(x, z))));
      src.normalAt(x, z, n);
      for (let k = 0; k < 3; k++) maxN = Math.max(maxN, Math.abs(t.normals[(tz * t.texels + tx) * 3 + k] - Math.fround(n[k])));
    }
    ok(maxH === 0 && maxN === 0, `tile (${ix},${iz}) samples identical to point evaluation`);
  }
}

console.log('\n[3] borders and corners agree across positive and negative coordinates');
{
  const src = createV5Source(project({ layers: richLayers() }));
  const pairs = [[[0, 0], [1, 0]], [[-1, -1], [0, -1]], [[-5, 2], [-5, 3]], [[7, -9], [8, -9]]];
  for (const [[ax, az], [bx, bz]] of pairs) {
    const a = src.buildTile(req(ax, az)), b = src.buildTile(req(bx, bz));
    const vertical = ax !== bx;
    let maxD = 0;
    for (let i = 0; i <= intervals; i++) {
      const x = vertical ? bx * size : ax * size + i * (size / intervals);
      const z = vertical ? az * size + i * (size / intervals) : bz * size;
      maxD = Math.max(maxD, Math.abs(sampleHeightTileBilinear(a, x, z) - sampleHeightTileBilinear(b, x, z)));
    }
    ok(maxD === 0, `shared edge (${ax},${az})|(${bx},${bz}) delta ${maxD}`);
  }
  const corner = [[-1, -1], [0, -1], [-1, 0], [0, 0]].map(([ix, iz]) => sampleHeightTileBilinear(src.buildTile(req(ix, iz)), 0, 0));
  ok(Math.max(...corner) - Math.min(...corner) === 0, 'four-tile corner at the origin agrees');
}

console.log('\n[4] generation order and instance count do not change output');
{
  const p = project({ layers: richLayers() });
  const a = createV5Source(p), b = createV5Source(p);
  const keys = [[3, 3], [-2, 0], [0, -2], [9, 9], [-7, 4]];
  const fwd = keys.map(([ix, iz]) => a.buildTile(req(ix, iz)).heights);
  const rev = [...keys].reverse().map(([ix, iz]) => b.buildTile(req(ix, iz)).heights).reverse();
  ok(fwd.every((h, i) => h.every((v, k) => v === rev[i][k])), 'reverse order on a second instance is bit-identical');
  // save/load: the descriptor JSON round-trips to the same heights
  const d = JSON.parse(JSON.stringify(v5Descriptor(p)));
  const c = createSource(d);
  ok(c.heightAt(123.4, -56.7) === a.heightAt(123.4, -56.7) && c.descriptor.sourceVersion === a.descriptor.sourceVersion, 'descriptor save/load reproduces heights and version');
  const other = createV5Source(project({ layers: richLayers(), seed: 99 }));
  ok(other.heightAt(123.4, -56.7) !== a.heightAt(123.4, -56.7) && other.descriptor.sourceVersion !== a.descriptor.sourceVersion, 'a different seed is a different source');
}

console.log('\n[5] migrated preview (pre-erosion stack height, unbounded fields) agrees with the source over the preview bounds');
{
  const p = project({ layers: richLayers() });
  const res = 48;
  const fields = generateNoiseFields(p.cfg, res, { unbounded: true });
  const classic = composeClassicHeight(fields, p.cfg);
  const target = evaluateStackGrid(p.stack, { resolution: res, worldX: p.cfg.world_x, worldZ: p.cfg.world_z, seed: p.cfg.seed, classicHeight: classic });
  const src = createV5Source(p);
  let maxD = 0;
  for (let iz = 0; iz < res; iz++) for (let ix = 0; ix < res; ix++) {
    const x = (ix / (res - 1) - 0.5) * p.cfg.world_x, z = (iz / (res - 1) - 0.5) * p.cfg.world_z;
    maxD = Math.max(maxD, Math.abs(target[iz * res + ix] - src.heightAt(x, z)));
  }
  ok(maxD < 1e-2, `max |preview - source| over the board = ${maxD.toExponential(2)} m (float32 field storage only)`);
  // and the bounded preview differs (different climate lattice), proving the migration matters
  const boundedFields = generateNoiseFields(p.cfg, res);
  const boundedClassic = composeClassicHeight(boundedFields, p.cfg);
  let diff = 0; for (let i = 0; i < classic.length; i++) diff = Math.max(diff, Math.abs(classic[i] - boundedClassic[i]));
  ok(diff > 1, `bounded vs unbounded climate differ (max ${diff.toFixed(1)} m), as documented`);
}

console.log('\n[6] far coordinates keep varying; nothing clamps at the old ±600 m board');
{
  const src = createV5Source(project({ layers: richLayers() }));
  const edge = src.heightAt(600, 600);
  const far = [700, 1500, 4000, 25000, -9000].map(x => src.heightAt(x, x * 0.37));
  ok(far.every(h => Number.isFinite(h)) && new Set(far.map(h => h.toFixed(3))).size === far.length, `far samples all distinct (${far.map(h => h.toFixed(1)).join(', ')})`);
  ok(far.every(h => h !== edge), 'no far sample equals the old edge value');
  const s = createUnboundedFieldSampler(7);
  const a = s.sample('continentalness', 5000, -3000, 1180, 4), b = s.sample('continentalness', 5001, -3000, 1180, 4);
  ok(Math.abs(a) <= 1 && Math.abs(b) <= 1 && a !== b && Math.abs(a - b) < 0.05, 'unbounded climate sampler is continuous and in range far out');
  const bounded = createFieldSampler(7);
  ok(bounded.sample('continentalness', 5000, 0, 1180, 4) === bounded.sample('continentalness', 9000, 0, 1180, 4), 'legacy bounded sampler still clamps (unchanged)');
}

console.log('\n[7] worker sourceTile builds a v5 tile from the descriptor alone');
{
  let posted = null, transfer = null;
  globalThis.self = { onmessage: null, postMessage(m, t) { posted = m; transfer = t; } };
  await import(`./terrain-worker.js?v5-test=${Date.now()}`);
  const p = project({ layers: richLayers() });
  const descriptor = JSON.parse(JSON.stringify(v5Descriptor(p)));
  self.onmessage({ data: { jobType: 'sourceTile', epoch: 2, descriptor, request: req(-3, 5, ['heights', 'normals']) } });
  ok(posted && !posted.error && posted.sourceKey === 'Test-Hills' && posted.heights.length === (intervals + 1 + 2 * apron) ** 2, `worker tile ok (${posted && posted.error})`);
  const ref = createV5Source(p).buildTile(req(-3, 5));
  ok(posted.heights[200] === ref.heights[200] && transfer.length === 2, 'worker tile matches a local build; both buffers transferred');
  delete globalThis.self;
}

console.log('\n[8] classification of a default editor project after migration');
{
  const bounded = project({ algorithmVersion: 'v5-bounded-1' });
  ok(classifyProject(bounded).runtimeSupported === false, 'fresh editor project (bounded) is not streamable');
  const mig = migrateProjectToUnbounded(bounded);
  const cls = classifyProject(mig);
  ok(cls.runtimeSupported === true && cls.omitted.length >= 3, `migrated default project streams; omitted: ${cls.omitted.length} stages`);
  const src = createV5Source(mig);
  ok(Number.isFinite(src.heightAt(0, 0)) && Math.abs(src.heightAt(0, 0)) < 200, `default project height at origin ${src.heightAt(0, 0).toFixed(2)} m`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
