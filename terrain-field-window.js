// terrain-field-window.js — a toroidal window of terrain FIELDS around the player (plants plan F2).
//
// One clipmap window (terrain-clipmap-window.js) carrying any of heights / surfaceHeights /
// biomeIds / moisture, filled through the shared scheduler, uploaded as one texture per field, and
// readable from both sides: CPU for placement and gates, TSL for grass and water.
//
// Two rules the shape follows:
//   - A toroidal window can never be sampled with normalized uv. The texel under a uv moves as the
//     window recentres, so the seam smears. Every read here is a wrap-aware textureLoad.
//   - Ids are nearest, values are bilinear. The average of two biome numbers is a third, unrelated
//     biome.
//
// Windows are reference counted: water, weather and flora ask for the resolution they need and the
// same window serves all of them, streaming while anyone holds it.

import * as THREE from 'three';
import { Fn, float, vec2, ivec2, floor, fract, mix, uniform, textureLoad, select, int } from 'three/tsl';
import { createClipmapWindow, WINDOW_FIELD_KINDS } from './terrain-clipmap-window.js';
import { FIELD_PRIORITY } from './terrain-field-scheduler.js';
import { tileKey } from './terrain-source.js';

export const FIELD_WINDOW_DEFAULTS = Object.freeze({
  post: 8,               // metres between posts
  tileIntervals: 16,
  tilesPerSide: 16,      // 256 posts = 2 km at an 8 m post
  maxRequestsPerUpdate: 6,
  priority: FIELD_PRIORITY.placement,
});

// Uint8 fields ride an r8unorm texture: r184 maps RedIntegerFormat for IntType/UnsignedIntType
// only (three.webgpu.js), so a Uint8Array integer texture is rejected outright. One byte per texel,
// read back normalized, decoded by x255.
const U8_SCALE = 255;

export function createFieldWindow({ source, descriptor = null, scheduler, fields = ['heights'], derived = [], derive = null, lod = null, label = 'field', ...opts } = {}) {
  if (!source || typeof source.buildTile !== 'function') throw new TypeError('a field window needs a terrain source');
  if (!scheduler || typeof scheduler.request !== 'function') throw new TypeError('a field window needs a field scheduler');
  const cfg = { ...FIELD_WINDOW_DEFAULTS, ...opts };
  // Derived channels live in the window like any other field, but the source is never asked for
  // them: a hook fills them from the tile that just arrived (flora cover over biome + splat).
  const sourceFields = fields.filter(f => !derived.includes(f));
  const win = createClipmapWindow({ level: 0, post: cfg.post, tileIntervals: cfg.tileIntervals, tilesPerSide: cfg.tilesPerSide, fields: [...sourceFields, ...derived], lod });
  const res = win.res;
  const owner = Symbol(label);

  let currentSource = source;
  let currentDescriptor = descriptor ?? source.descriptor;
  let epoch = 0, refs = 0, focus = [0, 0], uploadedVersion = -1, disposed = false;
  const stats = { tilesBuilt: 0, tilesRequested: 0, refs: 0, uploads: 0, bytes: 0, lastError: null };

  const uniforms = {
    origin: uniform(new THREE.Vector2()),
    res: uniform(res),
    post: uniform(cfg.post),
  };

  // One texture per field. Float fields are R32F, id fields r8unorm.
  const textures = new Map();
  for (const name of win.fields) {
    const isU8 = WINDOW_FIELD_KINDS[name].Array === Uint8Array;
    const tex = new THREE.DataTexture(win.array(name), res, res, THREE.RedFormat, isU8 ? THREE.UnsignedByteType : THREE.FloatType);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    textures.set(name, tex);
    stats.bytes += win.array(name).byteLength;
  }

  function requestTiles() {
    if (disposed || refs <= 0) return 0;
    const missing = win.missingTiles(focus[0], focus[1]);
    let sent = 0;
    for (const { ix, iz } of missing) {
      if (sent >= cfg.maxRequestsPerUpdate) break;
      const req = { ...win.tileRequest(ix, iz), fields: sourceFields.includes('heights') ? sourceFields.slice() : ['heights', ...sourceFields] };
      const key = `${tileKey(currentDescriptor, epoch, req.lod, ix, iz)}|${req.fields.join(',')}`;
      const jobEpoch = epoch;
      scheduler.request({
        key, priority: cfg.priority, descriptor: currentDescriptor, request: req, epoch: jobEpoch, owner,
        onTile: tile => {
          if (disposed || jobEpoch !== epoch) return;      // a source swap invalidates the answer
          if (derive) { try { derive(tile); } catch (err) { stats.lastError = String(err?.message ?? err); return; } }
          if (win.commitTile(tile)) stats.tilesBuilt++;
        },
        onError: err => { stats.lastError = err; },
      });
      stats.tilesRequested++;
      sent++;
    }
    return sent;
  }

  function recentre(x, z) {
    focus = [x, z];
    if (win.recentre(x, z)) scheduler.cancelOwner(owner);   // the old window's pending tiles are moot
    uniforms.origin.value.set(win.originPX, win.originPZ);
  }

  function update(x = focus[0], z = focus[1]) {
    if (disposed || refs <= 0) return false;
    recentre(x, z);
    requestTiles();
    if (win.version !== uploadedVersion) {
      uploadedVersion = win.version;
      for (const tex of textures.values()) tex.needsUpdate = true;
      stats.uploads++;
    }
    return win.coverage >= 1;
  }

  // TSL: wrap-aware read of one field at a GLOBAL xz, falling back outside the window. Bilinear for
  // values, nearest for ids; ids come back decoded (0..255), not normalized.
  function gpuSampler(name) {
    const tex = textures.get(name);
    if (!tex) throw new TypeError(`field window has no field ${name}`);
    const nearest = WINDOW_FIELD_KINDS[name].sampling === 'nearest';
    const isU8 = WINDOW_FIELD_KINDS[name].Array === Uint8Array;
    return Fn(([xz, fallback = float(-1000)]) => {
      const p = xz.div(uniforms.post).sub(uniforms.origin);
      const c = floor(p), f = fract(p), r = uniforms.res;
      const inside = c.x.greaterThanEqual(0).and(c.y.greaterThanEqual(0)).and(c.x.lessThan(r.sub(1))).and(c.y.lessThan(r.sub(1)));
      const wrap = v => ivec2(v.sub(floor(v.div(r)).mul(r)));
      const gi = c.add(uniforms.origin);
      const i0 = wrap(gi), i1 = wrap(gi.add(1));
      const load = (a, b) => {
        const raw = textureLoad(tex, ivec2(a, b)).x;
        return isU8 ? raw.mul(U8_SCALE) : raw;
      };
      if (nearest) {
        const nx = select(f.x.lessThan(0.5), i0.x, i1.x);
        const nz = select(f.y.lessThan(0.5), i0.y, i1.y);
        return select(inside, load(nx, nz), fallback);
      }
      const v00 = load(i0.x, i0.y), v10 = load(i1.x, i0.y);
      const v01 = load(i0.x, i1.y), v11 = load(i1.x, i1.y);
      return select(inside, mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y), fallback);
    });
  }

  // The adapter grass and rain want: candidates are render-local, this window is indexed globally.
  // `renderOrigin` is a vec2 uniform the caller mutates on rebase; the graph is built once.
  function gpuSamplerRenderLocal(name, renderOriginXZ) {
    const sampler = gpuSampler(name);
    return Fn(([x, z, fallback = float(-1000)]) => sampler(vec2(x, z).add(renderOriginXZ), fallback));
  }

  return {
    win, uniforms, stats, owner,
    get post() { return win.post; },
    get res() { return res; },
    get extent() { return res * win.post; },
    get lod() { return win.lod; },
    get fields() { return win.fields; },
    get coverage() { return win.coverage; },
    get version() { return win.version; },
    get refs() { return refs; },
    texture: name => textures.get(name) ?? null,
    array: name => win.array(name),
    // CPU reads. null means "not resident": a caller deciding where a tree goes must defer, not
    // substitute a default, or the world records a candidate that missing data invented.
    sampleAt: (name, x, z) => win.sampleField(name, x, z),
    ready: (x, z) => win.resolved(x, z) !== null,
    covers: (x, z) => win.covers(x, z),
    gpuSampler, gpuSamplerRenderLocal,
    recentre, update, requestTiles,
    acquire() { refs++; stats.refs = refs; return () => { refs = Math.max(0, refs - 1); stats.refs = refs; }; },
    setSource(next, nextDescriptor = null) {
      currentSource = next;
      currentDescriptor = nextDescriptor ?? next.descriptor;
      epoch++;
      scheduler.cancelOwner(owner);
      win.clear();
      uploadedVersion = -1;
      for (const tex of textures.values()) tex.needsUpdate = true;
    },
    get source() { return currentSource; },
    clear() { win.clear(); uploadedVersion = -1; for (const tex of textures.values()) tex.needsUpdate = true; },
    dispose() {
      disposed = true;
      scheduler.cancelOwner(owner);
      for (const tex of textures.values()) tex.dispose();
      textures.clear();
    },
  };
}

// Keyed cache so water, weather and flora asking for the same resolution share one window instead
// of streaming the same tiles twice. The caller releases its reference; the last one out disposes.
export function createFieldWindowRegistry({ scheduler }) {
  const windows = new Map();
  return {
    get size() { return windows.size; },
    keys: () => [...windows.keys()],
    acquire(key, factory) {
      let entry = windows.get(key);
      if (!entry) {
        entry = { window: factory({ scheduler }), holders: 0 };
        windows.set(key, entry);
      }
      entry.holders++;
      const release = entry.window.acquire();
      let released = false;
      return {
        window: entry.window,
        release() {
          if (released) return;
          released = true;
          release();
          entry.holders--;
          if (entry.holders <= 0) { entry.window.dispose(); windows.delete(key); }
        },
      };
    },
    update(x, z) { for (const { window } of windows.values()) window.update(x, z); },
    dispose() { for (const { window } of windows.values()) window.dispose(); windows.clear(); },
  };
}
