// terrain-lod-coverage.js — per-chunk coverage for LOD dissolves. One map per chunk streamer: a
// small texture with one texel per chunk around the player holding how "present" that chunk is,
// ramping 0→1 after it lands (snapping to 0 when it unloads: the mesh is already gone). A level's
// material dissolves its own chunks IN over the first half of the ramp and the coarser level
// dissolves OUT over the second half, so the ground is never open to the void mid-fade.
// Pure apart from the DataTexture it owns; Node-testable.

import * as THREE from 'three';

export const LOD_COVERAGE_DEFAULTS = Object.freeze({
  texels: 96,        // chunks per side covered by the map (±48 around the player's chunk)
  fadeSeconds: 0.6,  // 0→1 ramp time (fine fades in over the first half, coarse out over the second)
});

export function createLodCoverage({ chunkSize, texels = LOD_COVERAGE_DEFAULTS.texels, fadeSeconds = LOD_COVERAGE_DEFAULTS.fadeSeconds } = {}) {
  if (!(chunkSize > 0)) throw new TypeError('lod coverage needs a chunk size');
  const data = new Uint8Array(texels * texels);
  const texture = new THREE.DataTexture(data, texels, texels, THREE.RedFormat, THREE.UnsignedByteType);
  texture.magFilter = THREE.NearestFilter; texture.minFilter = THREE.NearestFilter;
  texture.needsUpdate = true;
  const values = new Map();   // "ix,iz" -> { t, target }
  let originX = 0, originZ = 0;   // chunk index at texel (0,0)
  let dirty = true;

  function recentre(x, z) {
    const cx = Math.floor(x / chunkSize) - (texels >> 1), cz = Math.floor(z / chunkSize) - (texels >> 1);
    if (cx === originX && cz === originZ) return false;
    originX = cx; originZ = cz;
    dirty = true;
    return true;
  }

  // Advance every tracked chunk toward its target; `present` is the set of chunk keys that should
  // be covered (resident, visible). Returns true when the texture changed.
  function update(present, dt) {
    const step = fadeSeconds > 0 ? dt / fadeSeconds : 1;
    for (const key of present) if (!values.has(key)) values.set(key, { t: 0, target: 1 });
    let changed = dirty;
    for (const [key, v] of values) {
      v.target = present.has(key) ? 1 : 0;
      if (v.t !== v.target) {
        v.t = v.target > v.t ? Math.min(1, v.t + step) : 0;
        changed = true;
      }
      if (v.t === 0 && v.target === 0) values.delete(key);
    }
    if (!changed) return false;
    data.fill(0);
    for (const [key, v] of values) {
      const c = key.indexOf(','), ix = +key.slice(0, c) - originX, iz = +key.slice(c + 1) - originZ;
      if (ix < 0 || iz < 0 || ix >= texels || iz >= texels) continue;
      data[iz * texels + ix] = Math.round(v.t * 255);
    }
    texture.needsUpdate = true;
    dirty = false;
    return true;
  }

  function coverageAt(x, z) {
    const v = values.get(`${Math.floor(x / chunkSize)},${Math.floor(z / chunkSize)}`);
    return v ? v.t : 0;
  }

  return {
    texture, chunkSize, texels, fadeSeconds,
    get originX() { return originX; },
    get originZ() { return originZ; },
    get trackedCount() { return values.size; },
    recentre, update, coverageAt,
    // everything fully present at once (e.g. after a source swap there is nothing to dissolve from)
    settle() { for (const v of values) { if (v[1].target === 1) v[1].t = 1; } dirty = true; },
    clear() { values.clear(); data.fill(0); texture.needsUpdate = true; dirty = false; },
    dispose() { texture.dispose(); values.clear(); },
  };
}
