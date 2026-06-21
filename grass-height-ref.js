// grass-height-ref.js
// Independent re-derivation of terrain-field.js terrainHeightAt(), written with the
// exact ops we transcribe into the TSL grass-compute height function. Node-tested
// against the canonical terrainHeightAt so the shader provably matches the terrain.
// Keep in sync with terrain-field.js if the terrain formula changes.

function lakeHash(ix, iz) {
  let h = (Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function lakeNoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = lakeHash(ix, iz), b = lakeHash(ix + 1, iz);
  const c = lakeHash(ix, iz + 1), d = lakeHash(ix + 1, iz + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

const smoothstep = (e0, e1, x) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export function grassHeightRef(params, x, z) {
  const h = (Math.sin(x * 0.10) * 1.1 + Math.cos(z * 0.085) * 1.0 + Math.sin((x + z) * 0.16) * 0.5
           + Math.cos((x - z) * 0.22 + 0.8) * 0.35 + Math.sin(x * 0.38 + z * 0.27) * 0.18
           + Math.cos(z * 0.44 - x * 0.19) * 0.14) * params.baseAmp;
  const t = 1 - params.lake;
  const basin = smoothstep(t, t + 0.15, lakeNoise(x * 0.045 + 10.5, z * 0.045 - 7.2));
  return h - basin * params.lakeDepth;
}
