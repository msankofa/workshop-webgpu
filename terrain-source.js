// terrain-source.js — pure terrain-source contract (plan: base-game terrain Phase 1).
// No three.js, scene, camera, worker or network objects. Validates descriptors,
// tile requests and tile results, builds tile keys, and keeps a registry of
// source kinds so a worker or server can build a source from a descriptor alone.

export const SOURCE_CONTRACT_VERSION = 1;
export const SOURCE_KINDS = Object.freeze(['analytic', 'finite-map', 'v5-recipe']);
export const TILE_FIELDS = Object.freeze(['heights', 'normals', 'biomeIds', 'materialFields', 'moisture', 'holeMask', 'volume']);

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);

export class TerrainSourceError extends Error {
  constructor(message) { super(message); this.name = 'TerrainSourceError'; }
}

function fail(msg) { throw new TerrainSourceError(msg); }

// Bounds are either null (unbounded) or a finite axis-aligned XZ box.
export function normalizeBounds(bounds) {
  if (bounds == null) return null;
  const { minX, maxX, minZ, maxZ } = bounds;
  if (![minX, maxX, minZ, maxZ].every(isFiniteNum)) fail('bounds must be finite numbers');
  if (!(minX < maxX && minZ < maxZ)) fail('bounds must have positive extent');
  return Object.freeze({ minX, maxX, minZ, maxZ });
}

// Returns a frozen, validated copy. `config` is the reproducible source
// configuration (seed, analytic params, map key…) and is passed through as-is.
export function normalizeDescriptor(d) {
  if (!d || typeof d !== 'object') fail('descriptor must be an object');
  const cv = d.contractVersion ?? SOURCE_CONTRACT_VERSION;
  if (cv !== SOURCE_CONTRACT_VERSION) fail(`unsupported contractVersion ${cv}`);
  if (!SOURCE_KINDS.includes(d.kind)) fail(`unknown source kind ${String(d.kind)}`);
  for (const f of ['key', 'sourceVersion', 'algorithmVersion']) {
    if (typeof d[f] !== 'string' || !d[f]) fail(`descriptor.${f} must be a non-empty string`);
  }
  if (/[|@]/.test(d.key) || /[|@]/.test(d.sourceVersion)) fail('key/sourceVersion must not contain | or @');
  const bounds = normalizeBounds(d.bounds);
  const capabilities = Array.isArray(d.capabilities) ? d.capabilities.slice() : [];
  if (!capabilities.every(c => typeof c === 'string')) fail('capabilities must be strings');
  if (capabilities.includes('infinite') && bounds) fail('a bounded source cannot claim infinite capability');
  const config = d.config == null ? {} : d.config;
  if (typeof config !== 'object') fail('descriptor.config must be an object');
  return Object.freeze({
    contractVersion: SOURCE_CONTRACT_VERSION,
    kind: d.kind,
    key: d.key,
    sourceVersion: d.sourceVersion,
    algorithmVersion: d.algorithmVersion,
    bounds,
    capabilities: Object.freeze(capabilities),
    config: Object.freeze({ ...config }),
  });
}

export function normalizeTileRequest(r) {
  if (!r || typeof r !== 'object') fail('tile request must be an object');
  const { ix, iz, xMin, zMin, size, intervals } = r;
  const lod = r.lod ?? 0;
  const apron = r.apron ?? 1;
  if (!isInt(ix) || !isInt(iz)) fail('ix/iz must be integers');
  if (!isInt(lod) || lod < 0) fail('lod must be a non-negative integer');
  if (!isFiniteNum(xMin) || !isFiniteNum(zMin)) fail('xMin/zMin must be finite');
  if (!isFiniteNum(size) || size <= 0) fail('size must be positive');
  if (!isInt(intervals) || intervals < 1) fail('intervals must be a positive integer');
  if (!isInt(apron) || apron < 0) fail('apron must be a non-negative integer');
  const fields = r.fields == null ? ['heights'] : r.fields.slice();
  if (!fields.includes('heights')) fields.unshift('heights');
  for (const f of fields) if (!TILE_FIELDS.includes(f)) fail(`unknown tile field ${f}`);
  return Object.freeze({ ix, iz, lod, xMin, zMin, size, intervals, apron, fields: Object.freeze(fields) });
}

// Key identifies source, version, epoch, LOD and integer tile coords. Render
// origin is never part of the key.
export function tileKey(descriptor, epoch, lod, ix, iz) {
  return `${descriptor.key}@${descriptor.sourceVersion}|e${epoch}|l${lod}|${ix},${iz}`;
}

export function parseTileKey(key) {
  const m = /^(.+)@(.+)\|e(-?\d+)\|l(\d+)\|(-?\d+),(-?\d+)$/.exec(key);
  if (!m) fail(`malformed tile key ${key}`);
  return { sourceKey: m[1], sourceVersion: m[2], epoch: +m[3], lod: +m[4], ix: +m[5], iz: +m[6] };
}

// Validates typed-array dimensions against the request. Optional fields must be
// absent or correctly sized; they are never zero-filled by the validator.
export function validateTileResult(t, req) {
  if (!t || typeof t !== 'object') fail('tile result must be an object');
  const texels = req.intervals + 1 + req.apron * 2;
  const n = texels * texels;
  if (t.texels !== texels) fail(`tile texels ${t.texels} != ${texels}`);
  if (t.intervals !== req.intervals || t.apron !== req.apron) fail('tile intervals/apron mismatch');
  if (t.ix !== req.ix || t.iz !== req.iz || t.lod !== req.lod) fail('tile coords/lod mismatch');
  if (t.xMin !== req.xMin || t.zMin !== req.zMin || t.size !== req.size) fail('tile bounds mismatch');
  if (!isFiniteNum(t.step) || !isFiniteNum(t.originX) || !isFiniteNum(t.originZ)) fail('tile step/origin must be finite');
  if (!(t.heights instanceof Float32Array) || t.heights.length !== n) fail('heights must be Float32Array of texels^2');
  if (t.normals != null && !(t.normals instanceof Float32Array && t.normals.length === n * 3)) fail('normals must be Float32Array of texels^2*3');
  if (t.biomeIds != null && !(ArrayBuffer.isView(t.biomeIds) && t.biomeIds.length === n)) fail('biomeIds must be a typed array of texels^2');
  if (t.moisture != null && !(t.moisture instanceof Float32Array && t.moisture.length === n)) fail('moisture must be Float32Array of texels^2');
  if (t.holeMask != null && !(t.holeMask instanceof Uint8Array && t.holeMask.length === n)) fail('holeMask must be Uint8Array of texels^2');
  if (t.materialFields != null && !(t.materialFields instanceof Float32Array && t.materialFields.length % n === 0)) fail('materialFields must be Float32Array of k*texels^2');
  if (t.volume != null) {
    const v = t.volume;
    if (!v || typeof v !== 'object') fail('volume must be an object');
    if (!(v.positions instanceof Float32Array) || v.positions.length % 3 !== 0) fail('volume.positions must be Float32Array of 3*vertices');
    if (!(v.normals instanceof Float32Array) || v.normals.length !== v.positions.length) fail('volume.normals must match volume.positions');
    if (!(v.indices instanceof Uint32Array) || v.indices.length % 3 !== 0) fail('volume.indices must be Uint32Array of 3*triangles');
    for (const k of ['yMin', 'yMax', 'spacing']) if (!isFiniteNum(v[k])) fail(`volume.${k} must be finite`);
  }
  for (const f of req.fields) if (t[f] == null) fail(`requested field ${f} missing from tile`);
  return t;
}

// Transferable buffers for a validated tile result.
export function tileTransferables(t) {
  const out = [];
  for (const f of TILE_FIELDS) if (t[f] && t[f].buffer) out.push(t[f].buffer);
  if (t.volume) for (const k of ['positions', 'normals', 'indices']) if (t.volume[k] && t.volume[k].buffer) out.push(t.volume[k].buffer);
  return out;
}

// Every source must expose this surface; optional methods are checked when present.
export function validateSource(src) {
  if (!src || typeof src !== 'object') fail('source must be an object');
  normalizeDescriptor(src.descriptor);
  for (const m of ['contains', 'heightAt', 'normalAt', 'buildTile']) {
    if (typeof src[m] !== 'function') fail(`source.${m} must be a function`);
  }
  for (const m of ['surfaceAt', 'holeAt']) {
    if (src[m] != null && typeof src[m] !== 'function') fail(`source.${m} must be a function`);
  }
  return src;
}

const kinds = new Map();

export function registerSourceKind(kind, factory) {
  if (!SOURCE_KINDS.includes(kind)) fail(`unknown source kind ${kind}`);
  if (typeof factory !== 'function') fail('factory must be a function');
  kinds.set(kind, factory);
}

export function hasSourceKind(kind) { return kinds.has(kind); }

// Builds a source from a descriptor. Factories receive the normalized descriptor.
export function createSource(descriptor) {
  const d = normalizeDescriptor(descriptor);
  const factory = kinds.get(d.kind);
  if (!factory) fail(`no factory registered for source kind ${d.kind}`);
  return validateSource(factory(d));
}
