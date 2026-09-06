// forest-palette-io.js — a content key for a species palette bake and a binary round trip for the
// baked variants, so a palette generated once can be loaded by every host (see
// docs/forest/palette-worker-and-bake-cache-plan.md). Pure: no DOM, no renderer.
import * as THREE from 'three';

const TIERS = ['branches', 'branchesLod1', 'branchesLod2', 'leaves', 'leavesMid', 'shadow', 'leavesCoarse'];
const MAGIC = 0x50414c31; // 'PAL1'
const TYPED = { Float32Array, Uint32Array, Uint16Array, Uint8Array, Int32Array, Int16Array, Int8Array };

// The palette params that shape geometry. Anything else (colours, brightness) is applied at bind time.
const GEOMETRY_PARAMS = [
  'branchLods', 'coarseLeafRatio', 'coarseLeafSizeMult', 'midLeafRatio', 'midLeafSizeMult',
  'leafShadowPct', 'leafCount', 'leafSize', 'leafStart', 'leafSpread',
];

// Sorted-key JSON so property order never changes the key; textures are dropped, as species saves do.
export function canonicalJson(value) {
  return JSON.stringify(value, (key, val) => {
    if (key === 'map' || key === 'normalMap' || typeof val === 'function') return undefined;
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      const out = {};
      for (const k of Object.keys(val).sort()) if (val[k] !== undefined) out[k] = val[k];
      return out;
    }
    return val;
  });
}

// Everything the bake of one species depends on, as one string; the key is its SHA-1.
export function paletteKeyInput({ species, params = {}, masterSeed, speciesIdx, variantsPerSpecies, texMode = 'procedural', leafAtlas = null, barkVScale, treesVersion }) {
  const geometryParams = {};
  for (const k of GEOMETRY_PARAMS) if (params[k] !== undefined) geometryParams[k] = params[k];
  return canonicalJson({
    treesVersion, species, geometryParams, masterSeed, speciesIdx, variantsPerSpecies,
    texMode: texMode === 'procedural' ? 'procedural' : 'authored',
    leafAtlas: leafAtlas ? { cols: leafAtlas.cols, rows: leafAtlas.rows } : null,
    barkVScale: barkVScale ?? null,
  });
}

// Node's subtle.digest hops threads; the sync hash keeps headless builds on microtasks.
const nodeCrypto = globalThis.process?.versions?.node ? await import('node:crypto') : null;

async function sha1Hex(text) {
  const bytes = new TextEncoder().encode(text);
  if (nodeCrypto) return nodeCrypto.createHash('sha1').update(bytes).digest('hex');
  const digest = await globalThis.crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function paletteKey(inputs) {
  return sha1Hex(paletteKeyInput(inputs));
}

function attributeEntries(geo) {
  const out = [];
  if (geo.index) out.push(['index', geo.index]);
  for (const name of Object.keys(geo.attributes)) out.push([name, geo.attributes[name]]);
  return out;
}

const pad4 = n => (n + 3) & ~3;

// One ArrayBuffer: u32 magic, u32 header byte length, JSON header, then every attribute array
// 4-byte aligned, attributes in their original order. Tiers sharing one geometry object are stored once.
export function serializePalette(variants, meta = {}) {
  const chunks = [];
  let offset = 0;
  const geoIds = new Map();
  const geometries = [];
  const place = arr => {
    const at = offset;
    chunks.push(arr);
    offset += pad4(arr.byteLength);
    return at;
  };
  const describe = geo => {
    if (geoIds.has(geo)) return geoIds.get(geo);
    const id = geometries.length;
    geoIds.set(geo, id);
    const attrs = attributeEntries(geo).map(([name, attr]) => ({
      name, itemSize: attr.itemSize, normalized: !!attr.normalized,
      type: attr.array.constructor.name, count: attr.array.length, offset: place(attr.array),
    }));
    geometries.push({ attrs });
    return id;
  };
  const variantHeaders = variants.map(v => {
    const tiers = {};
    for (const t of TIERS) tiers[t] = v[t] ? describe(v[t]) : null;
    return { speciesIdx: v.speciesIdx, variant: v.variant, tiers };
  });
  const header = new TextEncoder().encode(JSON.stringify({ ...meta, geometries, variants: variantHeaders }));
  const headerBytes = pad4(header.byteLength);
  const dataStart = 8 + headerBytes;
  const out = new ArrayBuffer(dataStart + offset);
  const view = new DataView(out);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, header.byteLength, true);
  new Uint8Array(out, 8, header.byteLength).set(header);
  const bytes = new Uint8Array(out);
  let at = dataStart;
  for (const arr of chunks) {
    bytes.set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), at);
    at += pad4(arr.byteLength);
  }
  return out;
}

// Attributes are views into `buffer` (no copy); the geometries keep the buffer alive.
export function deserializePalette(buffer) {
  const view = new DataView(buffer);
  if (buffer.byteLength < 8 || view.getUint32(0, true) !== MAGIC) throw new Error('not a palette file');
  const headerLen = view.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, headerLen)));
  const dataStart = 8 + pad4(headerLen);
  const geometries = header.geometries.map(({ attrs }) => {
    const geo = new THREE.BufferGeometry();
    for (const a of attrs) {
      const Ctor = TYPED[a.type];
      if (!Ctor) throw new Error(`unknown attribute array type ${a.type}`);
      const arr = new Ctor(buffer, dataStart + a.offset, a.count);
      const attr = new THREE.BufferAttribute(arr, a.itemSize, a.normalized);
      if (a.name === 'index') geo.setIndex(attr); else geo.setAttribute(a.name, attr);
    }
    return geo;
  });
  const variants = header.variants.map(h => {
    const v = { speciesIdx: h.speciesIdx, variant: h.variant };
    for (const t of TIERS) v[t] = h.tiers[t] === null ? null : geometries[h.tiers[t]];
    return v;
  });
  const { geometries: _g, variants: _v, ...meta } = header;
  return { variants, meta };
}

export { TIERS as PALETTE_TIERS };

// ---- Cache tiers (browser only; every function resolves null / false instead of throwing) ----
const IDB_NAME = 'forest-palettes', IDB_STORE = 'palettes';

function openIdb() {
  return new Promise(resolve => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}
function idbRequest(mode, run) {
  return openIdb().then(db => new Promise(resolve => {
    if (!db) return resolve(null);
    try {
      const req = run(db.transaction(IDB_STORE, mode).objectStore(IDB_STORE));
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  }));
}

// Disk first (`families/palettes/<key>.bin`, served statically), then this browser's IndexedDB.
export async function loadCachedPalette(key, { baseUrl = '/families/palettes/', fetchFn = globalThis.location ? globalThis.fetch : null } = {}) {
  if (typeof fetchFn === 'function') {
    try {
      const res = await fetchFn(`${baseUrl}${key}.bin`, { cache: 'no-cache' });
      if (res.ok) return { buffer: await res.arrayBuffer(), source: 'disk' };
    } catch { /* not served, or offline */ }
  }
  if (globalThis.indexedDB) {
    const buffer = await idbRequest('readonly', store => store.get(key));
    if (buffer) return { buffer, source: 'indexeddb' };
  }
  return null;
}

// Write a bake back so the next run anywhere is a load: the serve.py route when a server answers,
// and IndexedDB always. Returns which tiers took it.
export async function storeCachedPalette(key, buffer, { saveUrl = '/api/save-palette', fetchFn = globalThis.location ? globalThis.fetch : null } = {}) {
  const stored = { disk: false, indexeddb: false };
  if (typeof fetchFn === 'function') {
    try {
      const res = await fetchFn(`${saveUrl}?key=${key}`, { method: 'POST', body: buffer, headers: { 'Content-Type': 'application/octet-stream' } });
      stored.disk = res.ok;
    } catch { /* no server */ }
  }
  if (globalThis.indexedDB) stored.indexeddb = (await idbRequest('readwrite', store => store.put(buffer, key))) !== null;
  return stored;
}
