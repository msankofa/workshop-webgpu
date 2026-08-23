// terrain-sea-depth.js — the ground height around the player for water: one toroidal clipmap
// window (terrain-clipmap-window.js) at a coarse post spacing, filled by band-limited source
// tiles off-thread, uploaded as a float texture. The water surface reads it on the GPU for
// thickness (shore foam, depth colour, dry-land cutoff); the page reads it on the CPU for the
// "any water in view" gate. Shorelines match the far cascade because both use heightAtSpacing.

import * as THREE from 'three';
import { Fn, float, vec2, ivec2, floor, fract, mix, uniform, textureLoad, select } from 'three/tsl';
import { createClipmapWindow } from './terrain-clipmap-window.js';
import { tileKey } from './terrain-source.js';

export const SEA_DEPTH_DEFAULTS = Object.freeze({
  spacing: 16,          // metres between posts
  tileIntervals: 16,    // posts per tile side (tile = 256 m at 16 m)
  tilesPerSide: 20,     // window = 320 posts = 5120 m, past the far cascade extent
  maxInFlight: 6,       // worker jobs at once
  syncBuildsPerUpdate: 2,
});

export function createSeaDepthMap({ source, descriptor = null, useWorker = true, ...opts } = {}) {
  if (!source || typeof source.buildTile !== 'function') throw new TypeError('sea depth map needs a terrain source with buildTile()');
  const cfg = { ...SEA_DEPTH_DEFAULTS, ...opts };
  // level 0 → the request's lod is 1, so the source band-limits at `spacing`
  const win = createClipmapWindow({ level: 0, post: cfg.spacing, tileIntervals: cfg.tileIntervals, tilesPerSide: cfg.tilesPerSide });
  const res = win.res;
  const texture = new THREE.DataTexture(win.heights, res, res, THREE.RedFormat, THREE.FloatType);
  texture.magFilter = THREE.NearestFilter; texture.minFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  const uniforms = { origin: uniform(new THREE.Vector2()), res: uniform(res), post: uniform(cfg.spacing) };
  let currentSource = source, currentDescriptor = descriptor ?? source.descriptor;
  let epoch = 0, uploadedVersion = -1, focus = [0, 0];
  const tileMins = new Map();   // "ix,iz" -> min height of that tile
  let minCache = null;
  const stats = { tilesBuilt: 0, tilesInFlight: 0, lastError: null };

  let worker = null;
  const inFlight = new Map();
  if (useWorker && typeof Worker !== 'undefined') {
    try {
      worker = new Worker(new URL('./terrain-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = e => onTile(e.data);
      worker.onerror = () => { worker = null; inFlight.clear(); };
    } catch { worker = null; }
  }

  function commit(tile) {
    if (!win.commitTile(tile)) return false;
    // interior posts only: the apron belongs to the neighbours
    let m = Infinity;
    const pad = tile.apron ?? 0, n = tile.texels;
    for (let z = pad; z < n - pad; z++) for (let x = pad; x < n - pad; x++) { const h = tile.heights[z * n + x]; if (h < m) m = h; }
    tileMins.set(`${tile.ix},${tile.iz}`, m);
    minCache = null;
    stats.tilesBuilt++;
    return true;
  }
  function onTile(data) {
    const job = inFlight.get(data.key);
    inFlight.delete(data.key);
    stats.tilesInFlight = inFlight.size;
    if (!job || data.epoch !== epoch) return;
    if (data.error) { stats.lastError = data.error; return; }
    commit(data);
  }
  function dispatch(ix, iz) {
    const req = win.tileRequest(ix, iz);
    const key = tileKey(currentDescriptor, epoch, req.lod, ix, iz) + '|sea';
    if (inFlight.has(key)) return false;
    if (worker) {
      inFlight.set(key, { ix, iz });
      stats.tilesInFlight = inFlight.size;
      worker.postMessage({ jobType: 'sourceTile', key, epoch, descriptor: currentDescriptor, request: req });
      return true;
    }
    commit(currentSource.buildTile(req));
    return true;
  }

  function recentre(x, z) {
    focus = [x, z];
    if (!win.recentre(x, z)) return false;
    for (const key of [...tileMins.keys()]) { const [ix, iz] = key.split(',').map(Number); if (!win.tileInside(ix, iz)) tileMins.delete(key); }
    minCache = null;
    return true;
  }

  const totalTiles = cfg.tilesPerSide * cfg.tilesPerSide;
  // Request what the window lacks (nearest first, within budget) and push finished heights to the GPU.
  function update() {
    if (!win.placed) win.recentre(focus[0], focus[1]);
    if (win.presentCount === totalTiles) {
      if (win.version !== uploadedVersion) { texture.needsUpdate = true; uploadedVersion = win.version; }
      uniforms.origin.value.set(win.originPX, win.originPZ);
      return true;
    }
    const missing = win.missingTiles(focus[0], focus[1]);
    let budget = worker ? Math.max(0, cfg.maxInFlight - inFlight.size) : cfg.syncBuildsPerUpdate;
    for (const t of missing) { if (budget <= 0) break; if (dispatch(t.ix, t.iz)) budget--; }
    if (win.version !== uploadedVersion) { texture.needsUpdate = true; uploadedVersion = win.version; }
    uniforms.origin.value.set(win.originPX, win.originPZ);
    return missing.length === 0;
  }

  function minHeight() {
    if (minCache == null) { let m = Infinity; for (const v of tileMins.values()) if (v < m) m = v; minCache = m; }
    return minCache;
  }

  // TSL: bilinear ground height at a global xz from the window, or `fallback` outside the window.
  function gpuHeightAt(xz, fallback = float(-1000)) {
    const p = xz.div(uniforms.post).sub(uniforms.origin);
    const c = floor(p), f = fract(p), r = uniforms.res;
    const inside = c.x.greaterThanEqual(0).and(c.y.greaterThanEqual(0)).and(c.x.lessThan(r.sub(1))).and(c.y.lessThan(r.sub(1)));
    const wrap = n => ivec2(n.sub(floor(n.div(r)).mul(r)));
    const gi = c.add(uniforms.origin);
    const i0 = wrap(gi), i1 = wrap(gi.add(1));
    const h00 = textureLoad(texture, ivec2(i0.x, i0.y)).x, h10 = textureLoad(texture, ivec2(i1.x, i0.y)).x;
    const h01 = textureLoad(texture, ivec2(i0.x, i1.y)).x, h11 = textureLoad(texture, ivec2(i1.x, i1.y)).x;
    const h = mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
    return select(inside, h, fallback);
  }

  return {
    texture, uniforms, window: win, stats,
    get spacing() { return cfg.spacing; },
    get res() { return res; },
    get extent() { return res * cfg.spacing; },
    get coverage() { return win.coverage; },
    get version() { return win.version; },
    recentre, update, gpuHeightAt,
    heightAt: (x, z) => win.sample(x, z),
    covers: (x, z) => win.covers(x, z),
    minHeight,
    setSource(next, nextDescriptor = null) {
      currentSource = next; currentDescriptor = nextDescriptor ?? next.descriptor;
      epoch++; inFlight.clear(); stats.tilesInFlight = 0;
      win.clear(); tileMins.clear(); minCache = null;
      texture.needsUpdate = true;
    },
    clear() { win.clear(); tileMins.clear(); minCache = null; texture.needsUpdate = true; },
    dispose() { if (worker) worker.terminate(); worker = null; inFlight.clear(); texture.dispose(); },
  };
}
