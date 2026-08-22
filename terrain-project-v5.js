// terrain-project-v5.js — renderer-free Terrain Generator v5 project model shared
// by the standalone editor, the embedded Terrain Studio, Base Game state files,
// publishing and (later) terrain-source-v5.js. Owns normalization, validation,
// canonical serialization, content hashing and capability classification.
// Unknown fields are rejected, never silently replaced; missing fields are filled
// from defaults and reported in `report.filledDefaults`.

import { DEFAULT_CONFIG, DENSITY_DEFAULT_CONFIG } from './terrain-generator-js.js';
import { LAYER_TYPES, MAX_LAYERS, normalizeStack, defaultStack, STREAMABLE_LAYER_TYPES } from './terrain-stack.js';
import { base64ToBytes } from './terrain-paint.js';

export const PROJECT_APP = 'terrain-generator-v5';
export const PROJECT_FORMAT_VERSION = 1;          // the editor's `version` field; unchanged for compatibility
export const PROJECT_ALGORITHM_VERSION = 'v5-bounded-1';   // legacy: bounded 1,200 m climate lattice (editor preview only)
export const PROJECT_ALGORITHM_UNBOUNDED = 'v5-unbounded-1'; // coordinate-hashed climate fields; streamable at any global coordinate
export const PROJECT_ALGORITHM_VERSIONS = Object.freeze([PROJECT_ALGORITHM_VERSION, PROJECT_ALGORITHM_UNBOUNDED]);
const TOP_KEYS = new Set(['app', 'version', 'savedAt', 'name', 'algorithmVersion', 'cfg', 'density', 'stack', 'paint', 'imports']);
const SAFE_NAME = /^[A-Za-z0-9 _-]+$/;

export class TerrainProjectError extends Error {
  constructor(message, field) { super(message); this.name = 'TerrainProjectError'; this.field = field || null; }
}
const fail = (msg, field) => { throw new TerrainProjectError(msg, field); };

function normalizeNumericGroup(raw, defaults, groupName, report) {
  const out = {};
  const src = raw == null ? {} : raw;
  if (typeof src !== 'object' || Array.isArray(src)) fail(`${groupName} must be an object`, groupName);
  for (const k of Object.keys(src)) if (!(k in defaults)) fail(`unknown ${groupName} field ${k}`, `${groupName}.${k}`);
  for (const k of Object.keys(defaults)) {
    if (src[k] === undefined) { out[k] = defaults[k]; report.filledDefaults.push(`${groupName}.${k}`); continue; }
    if (typeof src[k] !== 'number' || !Number.isFinite(src[k])) fail(`${groupName}.${k} must be a finite number`, `${groupName}.${k}`);
    out[k] = src[k];
  }
  return out;
}

function normalizeStackStrict(raw, report) {
  if (raw == null) { report.filledDefaults.push('stack'); return defaultStack(); }
  if (typeof raw !== 'object' || !Array.isArray(raw.layers)) fail('stack.layers must be an array', 'stack');
  if (raw.layers.length > MAX_LAYERS) fail(`stack has ${raw.layers.length} layers; max ${MAX_LAYERS}`, 'stack');
  const ids = new Set();
  raw.layers.forEach((l, i) => {
    if (!l || typeof l !== 'object') fail(`stack.layers[${i}] must be an object`, `stack.layers[${i}]`);
    if (!LAYER_TYPES[l.type]) fail(`stack.layers[${i}] has unsupported type ${String(l.type)}`, `stack.layers[${i}].type`);
    if (typeof l.id !== 'string' || !l.id) fail(`stack.layers[${i}] needs a string id`, `stack.layers[${i}].id`);
    if (ids.has(l.id)) fail(`duplicate layer id ${l.id}`, `stack.layers[${i}].id`);
    ids.add(l.id);
    for (const k of Object.keys(l.params || {})) {
      if (!(k in LAYER_TYPES[l.type].params)) fail(`layer ${l.id} has unknown param ${k}`, `stack.layers[${i}].params.${k}`);
    }
  });
  const stack = normalizeStack(raw);
  if (stack.layers.length !== raw.layers.length) fail('stack normalization dropped a layer', 'stack');
  return stack;
}

function byteLength(b64, field) {
  if (typeof b64 !== 'string') fail(`${field} must be a base64 string`, field);
  try { return base64ToBytes(b64).length; } catch { fail(`${field} is not valid base64`, field); }
}

function normalizePaint(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'object') fail('paint must be an object or null', 'paint');
  const res = raw.resolution;
  if (!Number.isInteger(res) || res < 2) fail('paint.resolution must be an integer >= 2', 'paint.resolution');
  const n = res * res;
  const out = { version: 1, resolution: res };
  if (raw.heightDelta != null) {
    if (byteLength(raw.heightDelta, 'paint.heightDelta') !== n * 4) fail(`paint.heightDelta must hold ${n} float32`, 'paint.heightDelta');
    out.heightDelta = raw.heightDelta;
  }
  if (raw.biomeOverride != null) {
    if (byteLength(raw.biomeOverride, 'paint.biomeOverride') !== n) fail(`paint.biomeOverride must hold ${n} bytes`, 'paint.biomeOverride');
    out.biomeOverride = raw.biomeOverride;
  }
  return out;
}

function normalizeImports(raw, stack) {
  if (raw == null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('imports must be an object', 'imports');
  const layerIds = new Set(stack.layers.filter(l => l.type === 'import').map(l => l.id));
  const out = {};
  for (const [id, v] of Object.entries(raw)) {
    if (!layerIds.has(id)) fail(`imports.${id} has no import layer`, `imports.${id}`);
    if (!v || typeof v !== 'object') fail(`imports.${id} must be an object`, `imports.${id}`);
    const res = v.resolution;
    if (!Number.isInteger(res) || res < 2) fail(`imports.${id}.resolution must be an integer >= 2`, `imports.${id}.resolution`);
    if (byteLength(v.data, `imports.${id}.data`) !== res * res * 4) fail(`imports.${id}.data must hold ${res * res} float32`, `imports.${id}.data`);
    out[id] = { resolution: res, source: typeof v.source === 'string' ? v.source : 'import', data: v.data };
  }
  return out;
}

// Returns { project, report }. `project` is a plain JSON-safe object the editor
// can load unchanged; `report.filledDefaults` lists every field that came from defaults.
export function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('project must be an object');
  if (raw.app !== PROJECT_APP) fail(`not a ${PROJECT_APP} project (app=${String(raw.app)})`, 'app');
  const version = raw.version ?? PROJECT_FORMAT_VERSION;
  if (version !== PROJECT_FORMAT_VERSION) fail(`unsupported project version ${version}`, 'version');
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) fail(`unknown project field ${k}`, k);
  const algorithmVersion = raw.algorithmVersion ?? PROJECT_ALGORITHM_VERSION;
  if (!PROJECT_ALGORITHM_VERSIONS.includes(algorithmVersion)) fail(`unsupported algorithmVersion ${algorithmVersion}`, 'algorithmVersion');
  if (raw.name != null && (typeof raw.name !== 'string' || !SAFE_NAME.test(raw.name))) fail('name must use only letters, digits, spaces, underscores or hyphens', 'name');

  const report = { filledDefaults: [] };
  const cfg = normalizeNumericGroup(raw.cfg, DEFAULT_CONFIG, 'cfg', report);
  const density = normalizeNumericGroup(raw.density, DENSITY_DEFAULT_CONFIG, 'density', report);
  const stack = normalizeStackStrict(raw.stack, report);
  const paint = normalizePaint(raw.paint);
  const imports = normalizeImports(raw.imports, stack);

  const project = { app: PROJECT_APP, version: PROJECT_FORMAT_VERSION, algorithmVersion, cfg, density, stack, paint, imports };
  if (raw.name != null) project.name = raw.name;
  if (typeof raw.savedAt === 'string') project.savedAt = raw.savedAt;
  return { project, report };
}

// Deterministic JSON: sorted keys, no whitespace, `savedAt` excluded (not reproducible config).
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const keys = Object.keys(v).filter(k => k !== 'savedAt' && v[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}
export function canonicalProjectJson(project) { return canonical(project); }

// Pure-JS SHA-256 so hashing is synchronous and identical in Node, workers and browsers.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
export function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const len = bytes.length;
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
  padded.set(bytes); padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, (len * 8) >>> 0); dv.setUint32(padded.length - 8, Math.floor((len * 8) / 0x100000000));
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  return [...H].map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

export function hashProject(project) { return sha256Hex(canonicalProjectJson(project)); }

// Explicit copy of a project on the unbounded algorithm (same layers, cfg, density;
// climate fields re-drawn per cell). Paint and imports are dropped only when the caller
// says so — otherwise the migrated project keeps them and stays finite.
export function migrateProjectToUnbounded(project, { dropBoundedData = false } = {}) {
  const next = { ...project, algorithmVersion: PROJECT_ALGORITHM_UNBOUNDED };
  if (dropBoundedData) { next.paint = null; next.imports = {}; next.stack = { ...project.stack, layers: project.stack.layers.filter(l => l.type !== 'import') }; }
  return normalizeProject(next).project;
}

// What the project can be used for at runtime. `runtimeSupported` means
// terrain-source-v5.js can stream it at any global coordinate: unbounded algorithm, only
// streamable layer types (classic included — it uses the unbounded climate sampler), no
// paint, no imports. `reasons` names every blocker; `omitted` names the bounded finishing
// stages (erosion, hydrology, derived masks) the runtime does not apply, so nothing is
// approximated silently.
export function classifyProject(project) {
  const reasons = [];
  const omitted = [];
  const c = project.cfg;
  const unbounded = project.algorithmVersion === PROJECT_ALGORITHM_UNBOUNDED;
  if (!unbounded) reasons.push(`algorithm ${project.algorithmVersion} uses the bounded 1,200 m climate lattice; migrate to ${PROJECT_ALGORITHM_UNBOUNDED}`);
  if (project.paint) reasons.push('paint rasters are bounded');
  if (Object.keys(project.imports).length) reasons.push('imported grids are bounded');
  for (const l of project.stack.layers) {
    if (!l.enabled) continue;
    if (l.type === 'import') reasons.push(`layer ${l.id}: import layer is bounded`);
    else if (l.type !== 'classic' && !STREAMABLE_LAYER_TYPES.includes(l.type)) reasons.push(`layer ${l.id}: ${l.type} has no point evaluator`);
  }
  if (c.hydraulic_erosion_strength > 0) omitted.push('hydraulic erosion (bounded; preview only)');
  if (c.thermal_erosion_iterations > 0) omitted.push('thermal erosion (bounded; preview only)');
  omitted.push('lake discovery, flow and hydrology (bounded; preview only)');
  omitted.push('biome, material and grass masks (not streamed yet)');
  const runtimeSupported = reasons.length === 0;
  return {
    kind: runtimeSupported ? 'infinite' : 'finite',
    infiniteCompatible: runtimeSupported,
    runtimeSupported,
    reasons,
    omitted,
    bounds: runtimeSupported ? null : { minX: -c.world_x / 2, maxX: c.world_x / 2, minZ: -c.world_z / 2, maxZ: c.world_z / 2 },
  };
}

// One-call summary for state files, room descriptors and perf records.
export function describeProject(project) {
  const hash = hashProject(project);
  const cls = classifyProject(project);
  return {
    name: project.name ?? null,
    version: project.version,
    algorithmVersion: project.algorithmVersion,
    hash,
    kind: cls.kind,
    runtimeSupported: cls.runtimeSupported,
    seed: project.cfg.seed,
    world: [project.cfg.world_x, project.cfg.world_z],
    layers: project.stack.layers.map(l => `${l.id}:${l.type}${l.enabled ? '' : '(off)'}`),
    painted: !!project.paint,
    importCount: Object.keys(project.imports).length,
  };
}

// Validates a project against a hash it was stored with (state files, publish artifacts).
export function verifyProjectHash(project, expectedHash) {
  const actual = hashProject(project);
  if (actual !== expectedHash) fail(`project hash ${actual} does not match expected ${expectedHash}`, 'hash');
  return actual;
}
