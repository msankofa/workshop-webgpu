// terrain-clipmap.js — far-distance terrain as geometry clipmap rings fed by the terrain source
// (Base Game terrain Phase 9). Source-independent: every level owns a toroidal height window
// (terrain-clipmap-window.js) filled from lod-(L+1) source tiles — the same `sourceTile` worker
// job the near chunks use, so the far ground is the recipe band-limited to the ring's spacing,
// never a second transcription of it. Near-field collision and the exact lod-0 chunks are not
// touched: the innermost ring has a hole the size of the chunk draw radius and everything here
// is visual only.
//
// Rings: level L is a grid of `ringCells` cells at `post0 · 2^L` metres, centred on the focus
// snapped to two cells (so the lattice never swims under the camera). Levels overlap by two
// cells and each vertex morphs toward the next coarser level's height across the ring's outer
// band, so level boundaries never crack. Vertex positions are GLOBAL; the root group carries
// −renderOrigin like the chunks, so rebasing is a translation, not a re-key.

import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  Fn, If, Discard, uniform, attribute, varying, float, vec2, vec3, ivec2, floor, clamp, mix, max, abs,
  smoothstep, normalize, textureLoad,
} from 'three/tsl';
import { createClipmapLevels } from './terrain-clipmap-window.js';
import { tileKey } from './terrain-source.js';

export const CLIPMAP_DEFAULTS = Object.freeze({
  levels: 6,          // outermost half-extent = ringCells/2 · post0 · 2^(levels-1) = 96 · 2 · 32 = 6.1 km
  post0: 2,           // metres per cell on the innermost ring
  ringCells: 192,     // cells per ring side (must fit the window with snapping slack)
  overlapCells: 2,    // how far a finer ring reaches under the coarser one
  morphStart: 0.70,   // fraction of the half-extent where the morph toward the coarser level begins
  morphEnd: 0.95,
  maxInFlight: 12,    // worker tile jobs at once
  maxDispatchPerUpdate: 6,
  yBias: -0.25,       // rings sit just under the exact chunks where they overlap
});

// Unit grid over [-1, 1] with N cells; `holeHalf` cells (from the centre) are left out. Ring 0's
// hole for the exact chunks is a fragment discard instead (it follows the chunk window, which is
// not centred on the player), so its geometry is a full square.
function buildRingGeometry(N, holeHalf) {
  const g = N + 1, pos = new Float32Array(g * g * 3);
  for (let j = 0, k = 0; j <= N; j++) for (let i = 0; i <= N; i++, k += 3) {
    pos[k] = (i / N) * 2 - 1; pos[k + 1] = 0; pos[k + 2] = (j / N) * 2 - 1;
  }
  const idx = [];
  const c = N / 2;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    if (holeHalf > 0 && i >= c - holeHalf && i < c + holeHalf && j >= c - holeHalf && j < c + holeHalf) continue;
    const a = i + g * j, b = i + g * (j + 1), cc = i + 1 + g * (j + 1), d = i + 1 + g * j;
    idx.push(a, b, d, b, cc, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return geo;
}

export function createTerrainClipmap({ source, descriptor = null, useWorker = true, ...opts } = {}) {
  if (!source || typeof source.buildTile !== 'function') throw new TypeError('terrain clipmap needs a terrain source with buildTile()');
  const cfg = { ...CLIPMAP_DEFAULTS, ...opts };
  const N = cfg.ringCells;
  const windows = createClipmapLevels({ levels: cfg.levels, post0: cfg.post0, ringCells: N });
  const root = new THREE.Group();
  root.name = 'terrain-clipmap';
  let currentSource = source;
  let currentDescriptor = descriptor ?? source.descriptor;
  let epoch = 0;
  let focus = [0, 0];
  let visible = true;
  let wireframe = false;
  const stats = { tilesBuilt: 0, tilesInFlight: 0, lastBuildMs: 0, uploads: 0 };

  // --- worker ---------------------------------------------------------------------------------
  let worker = null;
  const inFlight = new Map();   // key -> { level, ix, iz }
  function initWorker() {
    if (!useWorker || typeof Worker === 'undefined') return;
    try {
      worker = new Worker(new URL('./terrain-worker.js', import.meta.url), { type: 'module' });
      worker.onmessage = e => onTile(e.data);
      worker.onerror = () => { worker = null; inFlight.clear(); };
    } catch { worker = null; }
  }
  initWorker();

  function onTile(data) {
    const job = inFlight.get(data.key);
    inFlight.delete(data.key);
    stats.tilesInFlight = inFlight.size;
    if (!job || data.epoch !== epoch) return;
    if (data.error) { stats.lastError = data.error; return; }
    if (windows[job.level].commitTile(data)) { stats.tilesBuilt++; levels[job.level].dirty = true; }
  }

  function dispatch(level, ix, iz) {
    const w = windows[level];
    const req = w.tileRequest(ix, iz);
    const key = tileKey(currentDescriptor, epoch, req.lod, ix, iz) + `|L${level}`;
    if (inFlight.has(key)) return;
    if (worker) {
      inFlight.set(key, { level, ix, iz });
      stats.tilesInFlight = inFlight.size;
      worker.postMessage({ jobType: 'sourceTile', key, epoch, descriptor: currentDescriptor, request: req });
    } else {
      const t0 = performance.now();
      const tile = currentSource.buildTile(req);
      stats.lastBuildMs = performance.now() - t0;
      if (w.commitTile(tile)) { stats.tilesBuilt++; levels[level].dirty = true; }
    }
  }

  // --- per-level GPU state --------------------------------------------------------------------
  const aPos = attribute('position', 'vec3');
  const uFocus = uniform(new THREE.Vector2());   // for the debug/shading only
  // Global XZ rectangle the exact near chunks cover; ring fragments inside it are discarded.
  const uHoleMin = uniform(new THREE.Vector2(1, 1));
  const uHoleMax = uniform(new THREE.Vector2(0, 0));   // min > max = no hole
  const levels = [];
  for (let L = 0; L < cfg.levels; L++) {
    const w = windows[L];
    const tex = new THREE.DataTexture(w.heights, w.res, w.res, THREE.RedFormat, THREE.FloatType);
    tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    levels.push({
      window: w, tex, dirty: false,
      half: (N / 2) * w.post,
      uCenter: uniform(new THREE.Vector2()),
      uOrigin: uniform(new THREE.Vector2()),
      uHalf: uniform((N / 2) * w.post),
      uPost: uniform(w.post),
      uRes: uniform(w.res),
      mesh: null, mat: null,
    });
  }

  // Four wrapped integer fetches + two lerps from a level's window, in GLOBAL post coordinates.
  function levelHeight(lv) {
    return Fn(([p]) => {
      const f = p.div(lv.uPost);
      const g = floor(f);
      const hi = lv.uOrigin.add(lv.uRes).sub(2);
      const c = clamp(g, lv.uOrigin, hi);
      const t = clamp(f.sub(c), vec2(0, 0), vec2(1, 1));
      const r = lv.uRes;
      const wrap = n => ivec2(n.sub(floor(n.div(r)).mul(r)));
      const i0 = wrap(c), i1 = wrap(c.add(1));
      const h00 = textureLoad(lv.tex, ivec2(i0.x, i0.y)).x;
      const h10 = textureLoad(lv.tex, ivec2(i1.x, i0.y)).x;
      const h01 = textureLoad(lv.tex, ivec2(i0.x, i1.y)).x;
      const h11 = textureLoad(lv.tex, ivec2(i1.x, i1.y)).x;
      return mix(mix(h00, h10, t.x), mix(h01, h11, t.x), t.y);
    });
  }

  const TINT = { water: [0.16, 0.32, 0.42], sand: [0.72, 0.66, 0.46], grass: [0.30, 0.48, 0.22], dry: [0.46, 0.44, 0.28], rock: [0.42, 0.40, 0.38], snow: [0.92, 0.93, 0.95] };
  const v3 = a => vec3(a[0], a[1], a[2]);

  for (let L = 0; L < cfg.levels; L++) {
    const lv = levels[L];
    const coarse = levels[L + 1] ?? null;
    const hOwn = levelHeight(lv);
    const hCoarse = coarse ? levelHeight(coarse) : null;

    const heightAt = Fn(([xz]) => {
      const h = hOwn(xz);
      if (!hCoarse) return h;
      // morph toward the coarser level across the outer band of this ring (chebyshev distance)
      const d = max(abs(xz.x.sub(lv.uCenter.x)), abs(xz.y.sub(lv.uCenter.y))).div(lv.uHalf);
      const m = smoothstep(cfg.morphStart, cfg.morphEnd, d);
      return mix(h, hCoarse(xz), m);
    });

    const worldPos = Fn(() => {
      const xz = aPos.xz.mul(lv.uHalf).add(lv.uCenter);
      return vec3(xz.x, heightAt(xz).add(cfg.yBias), xz.y);
    })();
    const eps = lv.window.post;
    const normal = Fn(() => {
      const xz = aPos.xz.mul(lv.uHalf).add(lv.uCenter);
      const hL = heightAt(xz.add(vec2(-eps, 0))), hR = heightAt(xz.add(vec2(eps, 0)));
      const hD = heightAt(xz.add(vec2(0, -eps))), hU = heightAt(xz.add(vec2(0, eps)));
      return normalize(vec3(hL.sub(hR), float(2 * eps), hD.sub(hU)));
    })();
    const vWorld = varying(worldPos, `vClipWorld${L}`);
    const vNormal = varying(normal, `vClipNormal${L}`);
    // Same readability tint as the near chunks (base-game-terrain.js colorizeGeometry).
    const color = Fn(() => {
      if (L === 0) {
        const inside = vWorld.x.greaterThan(uHoleMin.x).and(vWorld.x.lessThan(uHoleMax.x)).and(vWorld.z.greaterThan(uHoleMin.y)).and(vWorld.z.lessThan(uHoleMax.y));
        If(inside, () => { Discard(); });
      }
      const y = vWorld.y, ny = clamp(vNormal.y, 0, 1);
      let c = mix(v3(TINT.water), v3(TINT.sand), clamp(float(1).add(y.div(6)), 0, 1));
      c = mix(c, v3(TINT.grass), clamp(y.div(2), 0, 1));
      c = mix(c, v3(TINT.dry), clamp(y.sub(20).div(40), 0, 1));
      c = mix(c, v3(TINT.snow), clamp(y.sub(60).div(40), 0, 1));
      const rock = clamp(float(0.82).sub(ny).div(0.25), 0, 1);
      return mix(c, v3(TINT.rock), rock);
    })();

    const mat = new MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
    mat.positionNode = worldPos;
    mat.normalNode = normal;
    mat.colorNode = color;
    const mesh = new THREE.Mesh(buildRingGeometry(N, L === 0 ? 0 : N / 4 - cfg.overlapCells), mat);
    mesh.name = `terrain-clipmap-ring-${L}`;
    mesh.frustumCulled = false;   // geometry sits at the origin; the uniforms move it
    mesh.renderOrder = -20 + L;
    mesh.receiveShadow = true;
    lv.mesh = mesh; lv.mat = mat;
    root.add(mesh);
  }

  // The exact chunks' global XZ extent (null = no hole). Rings reach `overlapCells` under its edge.
  let holeRect = null;
  function setHoleRect(rect) {
    holeRect = rect ? [...rect] : null;
    if (!holeRect) { uHoleMin.value.set(1, 1); uHoleMax.value.set(0, 0); return; }
    const inset = cfg.overlapCells * cfg.post0;
    uHoleMin.value.set(holeRect[0] + inset, holeRect[1] + inset);
    uHoleMax.value.set(holeRect[2] - inset, holeRect[3] - inset);
  }

  // Per frame with the GLOBAL focus position. Re-centres windows, dispatches missing tiles
  // (nearest, finest-first), uploads dirty windows, snaps ring centres. Returns true if anything changed.
  function update(globalPosition) {
    focus = [globalPosition[0], globalPosition[2]];
    uFocus.value.set(focus[0], focus[1]);
    let budget = cfg.maxDispatchPerUpdate;
    let changed = false;
    for (const lv of levels) {
      const w = lv.window;
      if (w.recentre(focus[0], focus[1])) { lv.uOrigin.value.set(w.originPX, w.originPZ); changed = true; }
      if (budget > 0 && inFlight.size < cfg.maxInFlight) {
        for (const t of w.missingTiles(focus[0], focus[1])) {
          if (budget <= 0 || inFlight.size >= cfg.maxInFlight) break;
          dispatch(lv.window.level, t.ix, t.iz);
          budget--;
        }
      }
      if (lv.dirty) { lv.tex.needsUpdate = true; lv.dirty = false; stats.uploads++; changed = true; }
      const snap = w.post * 2;
      const cx = Math.round(focus[0] / snap) * snap, cz = Math.round(focus[1] / snap) * snap;
      if (lv.uCenter.value.x !== cx || lv.uCenter.value.y !== cz) { lv.uCenter.value.set(cx, cz); changed = true; }
      lv.mesh.visible = visible && w.presentCount > 0;
    }
    return changed;
  }

  function restream() {
    epoch++;
    inFlight.clear();
    stats.tilesInFlight = 0;
    for (const lv of levels) { lv.window.clear(); lv.dirty = true; }
  }

  return {
    root,
    windows,
    get levels() { return levels.length; },
    get outerHalfExtent() { return levels[levels.length - 1].half; },
    get epoch() { return epoch; },
    get focus() { return focus; },
    get source() { return currentSource; },
    get descriptor() { return currentDescriptor; },
    get worker() { return !!worker; },
    // Windows are re-filled from the new source; old heights stay on screen until replaced.
    setSource(nextSource, nextDescriptor = nextSource.descriptor) {
      currentSource = nextSource;
      currentDescriptor = nextDescriptor;
      restream();
    },
    setVisible(v) { visible = !!v; for (const lv of levels) lv.mesh.visible = visible && lv.window.presentCount > 0; },
    setWireframe(v) { wireframe = !!v; for (const lv of levels) lv.mat.wireframe = wireframe; },
    setHoleRect,
    get holeRect() { return holeRect ? [...holeRect] : null; },
    update,
    restream,
    get stats() {
      let triangles = 0;
      for (const lv of levels) if (lv.mesh.visible) triangles += lv.mesh.geometry.index.count / 3;
      return {
        levels: levels.length, post0: cfg.post0, ringCells: N, holeRect: holeRect ? [...holeRect] : null,
        outerHalfExtent: this.outerHalfExtent, triangles, draws: levels.filter(lv => lv.mesh.visible).length,
        coverage: levels.map(lv => +lv.window.coverage.toFixed(2)),
        tilesBuilt: stats.tilesBuilt, tilesInFlight: stats.tilesInFlight, uploads: stats.uploads,
        lastBuildMs: +stats.lastBuildMs.toFixed(2), worker: !!worker, lastError: stats.lastError ?? null,
      };
    },
    dispose() {
      if (worker) { worker.terminate(); worker = null; }
      for (const lv of levels) { lv.mesh.geometry.dispose(); lv.mat.dispose(); lv.tex.dispose(); }
      root.removeFromParent();
    },
  };
}
