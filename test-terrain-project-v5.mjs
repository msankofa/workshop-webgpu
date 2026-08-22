// Checks for the shared v5 project model. Run: node test-terrain-project-v5.mjs
import { createHash } from 'node:crypto';
import { DEFAULT_CONFIG, DENSITY_DEFAULT_CONFIG } from './terrain-generator-js.js';
import { defaultStack, makeLayer } from './terrain-stack.js';
import { PaintLayers, bytesToBase64 } from './terrain-paint.js';
import {
  normalizeProject, canonicalProjectJson, hashProject, sha256Hex, classifyProject, describeProject, verifyProjectHash,
  TerrainProjectError, PROJECT_APP, PROJECT_ALGORITHM_VERSION, migrateProjectToUnbounded,
} from './terrain-project-v5.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const rejects = (fn, field, msg) => {
  let e = null; try { fn(); } catch (x) { e = x; }
  ok(e instanceof TerrainProjectError && (!field || e.field === field), `${msg} -> ${e ? `${e.field}: ${e.message}` : 'no throw'}`);
};

// The same shape terrain-generator-v5.html's projectJson() produces.
function editorProject(overrides = {}) {
  const stack = defaultStack();
  stack.layers.push(makeLayer('fbm', { id: 'L7', params: { amplitude: 40 } }));
  return {
    app: PROJECT_APP, version: 1, savedAt: '2026-08-22T00:00:00.000Z',
    cfg: { ...DEFAULT_CONFIG, preview_resolution: 160, seed: 42 },
    density: { ...DENSITY_DEFAULT_CONFIG },
    stack, paint: null, imports: {},
    ...overrides,
  };
}

console.log('\n[1] editor project normalizes and round-trips');
{
  const raw = editorProject();
  const { project, report } = normalizeProject(raw);
  ok(project.cfg.seed === 42 && project.cfg.preview_resolution === 160, 'cfg values preserved');
  ok(report.filledDefaults.length === 0, `no defaults filled (${report.filledDefaults.join(',')})`);
  ok(project.stack.layers.length === 2 && project.stack.layers[1].params.amplitude === 40, 'stack preserved');
  ok(project.algorithmVersion === PROJECT_ALGORITHM_VERSION && project.version === 1, 'version fields set');
  ok(project.savedAt === raw.savedAt, 'savedAt carried on the project');
  const again = normalizeProject(JSON.parse(JSON.stringify(project))).project;
  ok(canonicalProjectJson(again) === canonicalProjectJson(project), 'normalize is idempotent (byte-equal canonical form)');
  ok(hashProject(again) === hashProject(project), 'hash stable across round-trip');
  const shuffled = JSON.parse(JSON.stringify(project));
  shuffled.cfg = Object.fromEntries(Object.entries(shuffled.cfg).reverse());
  ok(hashProject(normalizeProject(shuffled).project) === hashProject(project), 'key order does not change the hash');
  const later = { ...project, savedAt: '2030-01-01T00:00:00.000Z' };
  ok(hashProject(later) === hashProject(project), 'savedAt excluded from the hash');
  ok(!canonicalProjectJson(project).includes('savedAt'), 'canonical JSON omits savedAt');
}

console.log('\n[2] sha256 matches node:crypto');
{
  for (const text of ['', 'abc', 'x'.repeat(1000), canonicalProjectJson(normalizeProject(editorProject()).project)]) {
    ok(sha256Hex(text) === createHash('sha256').update(text).digest('hex'), `sha256 of ${text.length} chars matches`);
  }
}

console.log('\n[3] missing fields fill from defaults and are reported; unknown fields are rejected');
{
  const raw = editorProject();
  delete raw.cfg.beach_width; delete raw.density.cave_period; delete raw.stack;
  const { project, report } = normalizeProject(raw);
  ok(project.cfg.beach_width === DEFAULT_CONFIG.beach_width, 'missing cfg field filled');
  ok(report.filledDefaults.includes('cfg.beach_width') && report.filledDefaults.includes('density.cave_period') && report.filledDefaults.includes('stack'), `filled: ${report.filledDefaults.join(', ')}`);
  rejects(() => normalizeProject(editorProject({ cfg: { ...DEFAULT_CONFIG, mystery: 1 } })), 'cfg.mystery', 'unknown cfg field');
  rejects(() => normalizeProject(editorProject({ extra: true })), 'extra', 'unknown top-level field');
  rejects(() => normalizeProject(editorProject({ cfg: { ...DEFAULT_CONFIG, seed: 'abc' } })), 'cfg.seed', 'wrong-typed cfg field');
  rejects(() => normalizeProject(editorProject({ cfg: { ...DEFAULT_CONFIG, seed: NaN } })), 'cfg.seed', 'non-finite cfg field');
  rejects(() => normalizeProject(editorProject({ app: 'other' })), 'app', 'wrong app');
  rejects(() => normalizeProject(editorProject({ version: 2 })), 'version', 'unsupported version');
  rejects(() => normalizeProject(editorProject({ algorithmVersion: 'v9' })), 'algorithmVersion', 'unsupported algorithm');
  rejects(() => normalizeProject(editorProject({ name: '../x' })), 'name', 'unsafe name');
  ok(normalizeProject(editorProject({ name: 'Hill Country 2' })).project.name === 'Hill Country 2', 'safe name kept');
}

console.log('\n[4] stack validation');
{
  const bad = editorProject(); bad.stack.layers.push({ id: 'L9', type: 'lava', params: {} });
  rejects(() => normalizeProject(bad), 'stack.layers[2].type', 'unsupported layer type');
  const dup = editorProject(); dup.stack.layers.push(makeLayer('fbm', { id: 'L7' }));
  rejects(() => normalizeProject(dup), 'stack.layers[2].id', 'duplicate layer id');
  const badParam = editorProject(); badParam.stack.layers[1].params.bogus = 1;
  rejects(() => normalizeProject(badParam), 'stack.layers[1].params.bogus', 'unknown layer param');
  const clamped = editorProject(); clamped.stack.layers[1].params.amplitude = 5000;
  ok(normalizeProject(clamped).project.stack.layers[1].params.amplitude === 300, 'out-of-range param clamped by normalizeStack');
  const tooMany = editorProject(); for (let i = 0; i < 12; i++) tooMany.stack.layers.push(makeLayer('fbm', { id: `M${i}` }));
  rejects(() => normalizeProject(tooMany), 'stack', 'too many layers');
}

console.log('\n[5] paint and imports survive with exact byte lengths');
{
  const paint = new PaintLayers(16, 1200, 1200);
  paint.heightDelta[5] = 3.5; paint.biomeOverride[7] = 2;
  const raw = editorProject({ paint: paint.serialize() });
  const { project } = normalizeProject(raw);
  ok(project.paint && project.paint.resolution === 16, 'paint kept');
  const back = PaintLayers.deserialize(project.paint, 1200, 1200);
  ok(back.heightDelta[5] === 3.5 && back.biomeOverride[7] === 2, 'paint data round-trips through the editor deserializer');
  const shortPaint = { ...project.paint, heightDelta: bytesToBase64(new Uint8Array(8)) };
  rejects(() => normalizeProject(editorProject({ paint: shortPaint })), 'paint.heightDelta', 'wrong paint byte length');
  rejects(() => normalizeProject(editorProject({ paint: { resolution: 16, heightDelta: '!!notbase64' } })), 'paint.heightDelta', 'invalid base64');

  const withImport = editorProject();
  withImport.stack.layers.push(makeLayer('import', { id: 'L3' }));
  const grid = new Float32Array(4 * 4); grid[3] = 0.25;
  withImport.imports = { L3: { resolution: 4, source: 'png', data: bytesToBase64(new Uint8Array(grid.buffer)) } };
  const p2 = normalizeProject(withImport).project;
  ok(p2.imports.L3 && p2.imports.L3.resolution === 4 && p2.imports.L3.source === 'png', 'import kept');
  rejects(() => normalizeProject(editorProject({ imports: { L3: { resolution: 4, data: bytesToBase64(new Uint8Array(64)) } } })), 'imports.L3', 'import without a matching import layer');
  const badLen = JSON.parse(JSON.stringify(withImport)); badLen.imports.L3.resolution = 5;
  rejects(() => normalizeProject(badLen), 'imports.L3.data', 'import data length mismatch');
  ok(hashProject(p2) !== hashProject(normalizeProject(editorProject()).project), 'imports change the hash');
}

console.log('\n[6] classification and description');
{
  const p = normalizeProject(editorProject()).project;
  const c = classifyProject(p);
  ok(c.kind === 'finite' && c.runtimeSupported === false && c.infiniteCompatible === false, 'bounded-algorithm projects are finite and not runtime-supported');
  ok(c.reasons.length === 1 && c.reasons[0].includes('v5-unbounded-1'), `the only blocker is the bounded algorithm (${c.reasons.join('; ')})`);
  ok(c.omitted.some(r => r.includes('erosion')) && c.omitted.some(r => r.includes('hydrology')), 'omitted finishing stages are named explicitly');
  ok(c.bounds.maxX === 600 && c.bounds.minZ === -600, 'bounds from world_x/world_z');
  const mig = migrateProjectToUnbounded(p);
  const cm = classifyProject(mig);
  ok(mig.algorithmVersion === 'v5-unbounded-1' && cm.runtimeSupported === true && cm.kind === 'infinite' && cm.bounds === null, 'migrated project is runtime-supported and unbounded');
  ok(hashProject(mig) !== hashProject(p), 'migration changes the hash');
  const painted = migrateProjectToUnbounded(normalizeProject(editorProject({ paint: new PaintLayers(8, 1200, 1200).serialize() || { resolution: 8 } })).project);
  ok(classifyProject(painted).runtimeSupported === false && classifyProject(painted).reasons.some(r => r.includes('paint')), 'paint keeps a migrated project finite');
  const dropped = migrateProjectToUnbounded(painted, { dropBoundedData: true });
  ok(dropped.paint === null && classifyProject(dropped).runtimeSupported === true, 'dropBoundedData strips paint so it becomes streamable');
  let bad = null; try { normalizeProject(editorProject({ algorithmVersion: 'v5-unbounded-9' })); } catch (e) { bad = e; }
  ok(bad instanceof TerrainProjectError, 'unknown unbounded version rejected');
  const d = describeProject(p);
  ok(d.hash === hashProject(p) && d.seed === 42 && d.layers.join(',') === 'classic:classic,L7:fbm' && d.painted === false, 'describeProject summary');
  ok(verifyProjectHash(p, d.hash) === d.hash, 'verifyProjectHash accepts the right hash');
  rejects(() => verifyProjectHash(p, 'deadbeef'), 'hash', 'verifyProjectHash rejects a wrong hash');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
