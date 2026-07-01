# HD Planet/Moon Painter + Standalone Stellar Object Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat-gradient planet/moon painter in `celestial-bodies.js` with a per-pixel, sphere-shaded HD painter across five body kinds (terrestrial/gas/ice/volcanic/rocky), and ship `stellar-viewer.html`, a standalone dev tool that imports the real `sky-field.js`/`celestial-bodies.js` modules directly so tuning the look never drifts from the game.

**Architecture:** `sky-field.js` gains a weighted `kind` pick + per-kind palettes + a `detail: 'high'|'low'` flag on every generated body (near planet + its moons get `'high'`; everything else keeps the cheap existing painter). `celestial-bodies.js` splits into `paintBodySimple` (today's existing painter, renamed, unchanged) and `paintBodyHD` (new, dispatched by kind, tunable via an exported `PAINTER_TUNING` object). `stellar-viewer.html` is a new standalone page, served by the existing `python serve.py`, that imports both modules with zero duplicated logic.

**Tech Stack:** Plain JS ES modules, Three.js r0.184 WebGPU/TSL (`three/webgpu`), Canvas 2D for texture painting, Node (`node <file>.mjs`) for the existing no-framework test scripts.

---

## Full spec reference

See `docs/superpowers/specs/2026-06-30-stellar-object-viewer-design.md` for the approved design this plan implements. Read it first — this plan assumes its content.

## Task 1: `sky-field.js` — kind/detail/seed on every generated body

**Files:**
- Modify: `sky-field.js:170-220` (the `PLANET_COLORS` constant and `generateCelestialBodies` function)
- Test: `test-sky-field.mjs` (append to the existing "Celestial bodies" block, ~line 88-101)

- [ ] **Step 1: Write the failing tests**

Open `test-sky-field.mjs`. Replace the existing "Celestial bodies" block (lines 88-101) with this expanded version (it keeps every existing assertion and adds new ones for `kind`/`detail`/`seed`):

```js
// ---- Celestial bodies: counts within spec ranges, near planet has companions ----
{
  const bodies = generateCelestialBodies(1000, makePalette(), makeRng(3));
  const moons = bodies.filter(b => b.type === 'moon' && !b.companion);
  const distant = bodies.filter(b => b.type === 'planet' && b.scaleClass === 'distant');
  const near = bodies.filter(b => b.type === 'planet' && b.scaleClass === 'near');
  const comp = bodies.filter(b => b.companion);
  ok(moons.length >= 1 && moons.length <= 2, '1-2 extra moons');
  ok(distant.length >= 2 && distant.length <= 4, '2-4 distant planets');
  ok(near.length === 1, 'exactly one near planet');
  ok(comp.length >= 1 && comp.length <= 3, '1-3 companion moons on the near planet');
  ok(bodies.every(b => Math.abs(Math.hypot(b.position.x, b.position.y, b.position.z) - b.radius) < 1e-3), 'each body sits on its own radius');
  ok(generateCelestialBodies(1000, makePalette(), makeRng(3)).length === bodies.length, 'deterministic per seed');

  ok(bodies.every(b => typeof b.kind === 'string'), 'every body has a kind string');
  ok(moons.every(b => ['ice', 'rocky'].includes(b.kind)), 'extra moons only roll ice/rocky kinds');
  ok(comp.every(b => ['ice', 'rocky'].includes(b.kind)), 'companion moons only roll ice/rocky kinds');
  ok(distant.every(b => ['terrestrial', 'gas', 'ice', 'volcanic', 'rocky'].includes(b.kind)), 'distant planets roll from the full kind set');
  ok(near.every(b => ['terrestrial', 'gas', 'ice', 'volcanic', 'rocky'].includes(b.kind)), 'near planet rolls from the full kind set');
  ok(distant.every(b => b.detail === 'low'), 'distant planets are low detail');
  ok(moons.every(b => b.detail === 'low'), 'extra moons are low detail');
  ok(near.every(b => b.detail === 'high'), 'near planet is high detail');
  ok(comp.every(b => b.detail === 'high'), 'companion moons are high detail');
  ok(bodies.every(b => b.gas === (b.kind === 'gas')), 'gas boolean stays derived from kind (paintBodySimple compat)');
  ok(bodies.every(b => typeof b.seed === 'number' && b.seed >= 0 && b.seed < 1), 'every body carries a [0,1) seed');
}

// ---- Celestial body kind variety: all 5 planet kinds appear over many seeds ----
{
  const seen = new Set();
  for (let s = 0; s < 200; s++) {
    const bodies = generateCelestialBodies(1000, makePalette(), makeRng(1000 + s));
    for (const b of bodies) if (b.type === 'planet') seen.add(b.kind);
  }
  ok(['terrestrial', 'gas', 'ice', 'volcanic', 'rocky'].every(k => seen.has(k)), 'all 5 planet kinds appear across 200 seeds');
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test-sky-field.mjs`
Expected: FAIL — multiple lines like `FAIL every body has a kind string` (property doesn't exist yet on returned objects), since `kind`/`detail`/`seed` aren't produced by `generateCelestialBodies` yet.

- [ ] **Step 3: Implement `kind`/`detail`/`seed`/per-kind palettes in `sky-field.js`**

Replace line 170 (`const PLANET_COLORS = [...]`) with:

```js
const PLANET_KINDS = ['terrestrial', 'gas', 'ice', 'volcanic', 'rocky'];
const KIND_WEIGHTS = [0.28, 0.22, 0.18, 0.12, 0.20];
const MOON_KINDS = ['ice', 'rocky'];
const MOON_WEIGHTS = [0.55, 0.45];

const KIND_PALETTES = {
  terrestrial: ['#2f5d8a', '#3a6e4f', '#4a7a5a', '#355f7d', '#3f6b4a'],
  gas:         ['#b07a55', '#7d8aa0', '#c9a06a', '#6a8f7d', '#9a6b8c', '#5f7bbf'],
  ice:         ['#dce8f2', '#c9d8e8', '#e7eef5', '#b9cfe0', '#d3e2ee'],
  volcanic:    ['#33201a', '#4a2a20', '#5a2f22', '#3a1c14', '#4f2818'],
  rocky:       ['#9a958c', '#8a7f6e', '#a89f8f', '#7d7468', '#938a7c'],
};

function weightedPick(rng, items, weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}
```

Then replace the whole `generateCelestialBodies` function (lines 175-220 in the original) with:

```js
export function generateCelestialBodies(radius, palette, rng) {
  const out = [];
  const place = (dir, r) => {
    const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
    return { x: dir.x / len * r, y: dir.y / len * r, z: dir.z / len * r };
  };
  const dir = () => {
    const theta = rng() * Math.PI * 2;
    const y = 0.15 + rng() * 0.7;
    const rr = Math.sqrt(Math.max(0, 1 - y * y));
    return { x: Math.cos(theta) * rr, y, z: Math.sin(theta) * rr };
  };
  const pick = arr => arr[(rng() * arr.length) | 0];

  // 1-2 extra moons (ice/rocky only — "gas moon" or "terrestrial moon" don't read as sensible).
  const moonN = 1 + ((rng() * 2) | 0);
  for (let i = 0; i < moonN; i++) {
    const r = radius * (0.7 + rng() * 0.08);
    const kind = weightedPick(rng, MOON_KINDS, MOON_WEIGHTS);
    out.push({ type: 'moon', companion: false, kind, detail: 'low', gas: kind === 'gas',
      position: place(dir(), r), radius: r,
      size: radius * (0.018 + rng() * 0.02), color: pick(KIND_PALETTES[kind]),
      phase: rng(), seed: rng() });
  }
  // 2-4 small distant planets.
  const distN = 2 + ((rng() * 3) | 0);
  for (let i = 0; i < distN; i++) {
    const r = radius * (0.72 + rng() * 0.06);
    const kind = weightedPick(rng, PLANET_KINDS, KIND_WEIGHTS);
    out.push({ type: 'planet', scaleClass: 'distant', kind, detail: 'low', gas: kind === 'gas',
      position: place(dir(), r), radius: r,
      size: radius * (0.01 + rng() * 0.015), color: pick(KIND_PALETTES[kind]),
      rings: false, glow: rng() < 0.3, seed: rng() });
  }
  // Exactly one large near planet.
  const nearDir = dir();
  const nearR = radius * 0.6;
  const nearSize = radius * (0.06 + rng() * 0.04);
  const nearKind = weightedPick(rng, PLANET_KINDS, KIND_WEIGHTS);
  const near = { type: 'planet', scaleClass: 'near', kind: nearKind, detail: 'high', gas: nearKind === 'gas',
    position: place(nearDir, nearR), radius: nearR,
    size: nearSize, color: pick(KIND_PALETTES[nearKind]), rings: rng() < 0.4, glow: true, seed: rng() };
  out.push(near);
  // 1-3 companion moons orbiting the near planet (offset around its screen position).
  const compN = 1 + ((rng() * 3) | 0);
  for (let i = 0; i < compN; i++) {
    const d = { x: nearDir.x + (rng() * 2 - 1) * 0.06, y: nearDir.y + (rng() * 2 - 1) * 0.06,
      z: nearDir.z + (rng() * 2 - 1) * 0.06 };
    const kind = weightedPick(rng, MOON_KINDS, MOON_WEIGHTS);
    out.push({ type: 'moon', companion: true, kind, detail: 'high', gas: kind === 'gas',
      position: place(d, nearR), radius: nearR,
      size: nearSize * (0.12 + rng() * 0.1), color: pick(KIND_PALETTES[kind]), phase: rng(), seed: rng() });
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test-sky-field.mjs`
Expected: `all passed` (all `ok` lines, `fail` count 0, exit code 0).

- [ ] **Step 5: Commit**

```bash
git add sky-field.js test-sky-field.mjs
git commit -m "feat(sky): add planet kind/detail/palette generation to generateCelestialBodies"
```

## Task 2: Smoke-test harness for `celestial-bodies.js` (baseline, before the painter changes)

**Files:**
- Create: `test-celestial-bodies-smoke.mjs`

This is not a pixel-correctness test (canvas output has no automated coverage in this codebase — see `docs/subsystems/sky.md`, "No dedicated tests exist for ... celestial-bodies.js"). It exercises the *actual* production module with a minimal `document.createElement('canvas')` stub (2D canvas needs a DOM; nothing else in the file does) so a thrown exception in any kind's paint path is caught before you ever open a browser. Run it again after every later task in this plan.

- [ ] **Step 1: Write the smoke test**

```js
// test-celestial-bodies-smoke.mjs
// Exercises the REAL celestial-bodies.js (not a copy) with a minimal canvas stub —
// catches thrown exceptions in any kind's paint path without needing a browser/GPU.
// Does not assert pixel content: that's verified visually via stellar-viewer.html.
function makeCtx() {
  return new Proxy({}, {
    get(target, prop) {
      if (prop === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      if (prop === 'createRadialGradient') return () => ({ addColorStop: () => {} });
      return (...args) => undefined;
    },
  });
}
function makeCanvas() {
  let w = 0, h = 0;
  return {
    get width() { return w; }, set width(v) { w = v; },
    get height() { return h; }, set height(v) { h = v; },
    getContext: () => makeCtx(),
  };
}
global.document = { createElement: (tag) => (tag === 'canvas' ? makeCanvas() : {}) };

const { makeRng, makePalette, generateCelestialBodies } = await import('./sky-field.js');
const { createCelestialBodies } = await import('./celestial-bodies.js');

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };

const bodies = generateCelestialBodies(1000, makePalette(), makeRng(42));
const group = createCelestialBodies(bodies);
ok(group.children.length === bodies.length, 'one sprite per generated body');
ok(group.children.every(s => s.isSprite), 'every child is a THREE.Sprite');
ok(group.children.every(s => s.material.map && s.material.map.isTexture), 'every sprite has a texture map');

// Every kind must paint without throwing, at both detail levels, regardless of what
// generateCelestialBodies happened to roll above.
for (const kind of ['terrestrial', 'gas', 'ice', 'volcanic', 'rocky']) {
  for (const detail of ['high', 'low']) {
    const body = { type: 'planet', scaleClass: detail === 'high' ? 'near' : 'distant', kind, detail,
      gas: kind === 'gas', position: { x: 500, y: 300, z: 400 }, radius: 700,
      size: 50, color: '#8899aa', rings: false, glow: false, seed: 0.42 };
    let threw = false;
    try { createCelestialBodies([body]); } catch (e) { threw = true; console.error(e); }
    ok(!threw, `kind=${kind} detail=${detail} paints without throwing`);
  }
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run it against the current (unmodified) `celestial-bodies.js`**

Run: `node test-celestial-bodies-smoke.mjs`
Expected: `all passed` — today's `paintBody()` ignores `kind`/`detail` entirely, so every case trivially succeeds. This is the baseline; it must keep passing after Tasks 3 and 4.

- [ ] **Step 3: Commit**

```bash
git add test-celestial-bodies-smoke.mjs
git commit -m "test(sky): add a no-GPU smoke test for celestial-bodies.js paint dispatch"
```

## Task 3: `celestial-bodies.js` — noise helpers, `PAINTER_TUNING`, dispatch, terrestrial + gas kinds

**Files:**
- Modify: `celestial-bodies.js` (whole file except the color-helper section at the bottom, which is untouched)

- [ ] **Step 1: Rename `paintBody` to `paintBodySimple` and add noise/tuning infrastructure**

Replace the line `function paintBody(body) {` (and nothing else in that function) with `function paintBodySimple(body) {` — the body of the function is otherwise unchanged.

Then, directly above the (now renamed) `paintBodySimple` function, insert:

```js
// ---- fractal/cellular noise for the HD painter (canvas-only; no TSL/GPU dependency) ----
function hash3(x, y, z, seed) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed * 91.7) * 43758.5453;
  return s - Math.floor(s);
}
function lerp(a, b, t) { return a + (b - a) * t; }
function noise3(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const n000 = hash3(xi, yi, zi, seed), n100 = hash3(xi + 1, yi, zi, seed);
  const n010 = hash3(xi, yi + 1, zi, seed), n110 = hash3(xi + 1, yi + 1, zi, seed);
  const n001 = hash3(xi, yi, zi + 1, seed), n101 = hash3(xi + 1, yi, zi + 1, seed);
  const n011 = hash3(xi, yi + 1, zi + 1, seed), n111 = hash3(xi + 1, yi + 1, zi + 1, seed);
  const x00 = lerp(n000, n100, u), x10 = lerp(n010, n110, u);
  const x01 = lerp(n001, n101, u), x11 = lerp(n011, n111, u);
  const y0 = lerp(x00, x10, v), y1 = lerp(x01, x11, v);
  return lerp(y0, y1, w);
}
function fbm3(x, y, z, seed, octaves) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise3(x * freq, y * freq, z * freq, seed) * amp;
    norm += amp;
    amp *= 0.5; freq *= 2.15;
  }
  return sum / norm;
}
function smoothstep(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
function mixRGB(c0, c1, t) { return [lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t)]; }
// Worley F1 (distance to nearest jittered point) — isolated round blobs, used for craters.
function worleyF1(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let best = 1e9;
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = xi + dx, cy = yi + dy, cz = zi + dz;
    const jx = hash3(cx, cy, cz, seed), jy = hash3(cx, cy, cz, seed + 17.3), jz = hash3(cx, cy, cz, seed + 41.9);
    const px = cx + jx, py = cy + jy, pz = cz + jz;
    const ddx = px - x, ddy = py - y, ddz = pz - z;
    const d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
    if (d < best) best = d;
  }
  return best;
}
// Worley F1/F2 (distance to nearest AND second-nearest point) — F2-F1 is ~0 on cell
// boundaries, giving a connected crack/vein network, used for ice cracks and lava veins.
function worleyF1F2(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let best1 = 1e9, best2 = 1e9;
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = xi + dx, cy = yi + dy, cz = zi + dz;
    const jx = hash3(cx, cy, cz, seed), jy = hash3(cx, cy, cz, seed + 17.3), jz = hash3(cx, cy, cz, seed + 41.9);
    const px = cx + jx, py = cy + jy, pz = cz + jz;
    const ddx = px - x, ddy = py - y, ddz = pz - z;
    const d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
    if (d < best1) { best2 = best1; best1 = d; } else if (d < best2) { best2 = d; }
  }
  return [best1, best2];
}
const LX = -0.55, LY = 0.6, LZ = 0.6;
const LLEN = Math.hypot(LX, LY, LZ);
const lightDir = [LX / LLEN, LY / LLEN, LZ / LLEN];

// Tunable visual constants, read at paint time (not captured as literals) so
// stellar-viewer.html's sliders mutate this object and the next repaint reflects it.
// Production code (createCelestialBodies) never writes to this object.
export const PAINTER_TUNING = {
  terrestrial: { cloudThreshold: [0.56, 0.78], iceCapLatitude: [0.74, 0.9], continentThreshold: [0.46, 0.52], specularPower: 50 },
  gas:         { warpAmount: 1.4, warpFreq: 2.5, bandFreq: 6.5, bandThreshold: [0.3, 0.7] },
  ice:         { crackFreq: 4.5, crackWidth: 0.06 },
  volcanic:    { veinFreq: 4, veinWidth: 0.05, hotWidth: 0.025, ambient: 0.12 },
  rocky:       { craterFreq: 5, rimBand: [0.32, 0.22], floorBand: [0.14, 0.05], continentThreshold: [0.42, 0.58] },
};

// Per-pixel atmosphere tint for the Fresnel rim glow — only kinds with a real
// atmosphere get one (gas giants already get the existing halo via body.glow).
const ATMO_COLOR = {
  terrestrial: [159, 208, 255],
  ice: [210, 230, 255],
};
```

- [ ] **Step 2: Add `paintBodyHD` with terrestrial + gas kinds (rocky as the temporary fallback for ice/volcanic)**

Directly below the block from Step 1 (still above `paintBodySimple`), add:

```js
function paintBodyHD(body) {
  const S = 256;
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const cx = S / 2, cy = S / 2, R = S * 0.26;
  const seed = (body.seed || 0) * 53.7;
  const kind = body.kind;
  const tuning = PAINTER_TUNING[kind] || PAINTER_TUNING.rocky;
  const atmo = ATMO_COLOR[kind];

  const base = parse(body.color);
  // NOTE: lighten()/darken() return CSS "rgb(...)" strings for canvas fillStyle use —
  // NOT hex, so they can't be round-tripped through parse(). Compute the same math
  // (mix toward white/black) directly as numeric [r,g,b] via mixRGB instead.
  const hi = mixRGB(base, [255, 255, 255], 0.45);
  const lo = mixRGB(base, [0, 0, 0], 0.55);

  if (body.glow) {
    const gl = g.createRadialGradient(cx, cy, R * 0.8, cx, cy, Math.min(R * 1.8, S * 0.49));
    gl.addColorStop(0, hexA(body.color, 0.5)); gl.addColorStop(1, hexA(body.color, 0));
    g.fillStyle = gl; g.fillRect(0, 0, S, S);
  }

  const bx0 = Math.max(0, Math.floor(cx - R) - 1), by0 = Math.max(0, Math.floor(cy - R) - 1);
  const bw = Math.min(S, Math.ceil(R * 2) + 2), bh = Math.min(S, Math.ceil(R * 2) + 2);
  const img = g.getImageData(bx0, by0, bw, bh);
  const data = img.data;

  for (let py = 0; py < bh; py++) {
    for (let px = 0; px < bw; px++) {
      const x = bx0 + px, y = by0 + py;
      const nx = (x + 0.5 - cx) / R, ny = (y + 0.5 - cy) / R;
      const d2 = nx * nx + ny * ny;
      if (d2 > 1) continue;
      const nz = Math.sqrt(Math.max(0, 1 - d2));

      let r, gC, b, emissive = [0, 0, 0];

      if (kind === 'terrestrial') {
        const ct = tuning.continentThreshold;
        const land = fbm3(nx * 2.3 + seed, ny * 2.3 + seed, nz * 2.3 + seed, seed, 5);
        const continent = smoothstep(ct[0], ct[1], land);
        const biome = fbm3(nx * 3.7 + seed * 7, ny * 3.7 + seed * 7, nz * 3.7 + seed * 7, seed + 9, 3);
        const landColor = mixRGB(lo, hi, smoothstep(0.3, 0.7, biome));
        [r, gC, b] = mixRGB(base, landColor, continent);
        const lat = Math.abs(ny);
        const capT = tuning.iceCapLatitude;
        const iceCap = smoothstep(capT[0], capT[1], lat);
        [r, gC, b] = mixRGB([r, gC, b], [238, 243, 250], iceCap);
        const cloudT = tuning.cloudThreshold;
        const cloudN = fbm3(nx * 3.1 + seed * 13, ny * 3.1 + seed * 13, nz * 3.1 + seed * 13, seed + 13, 4);
        const cloud = smoothstep(cloudT[0], cloudT[1], cloudN);
        [r, gC, b] = mixRGB([r, gC, b], [255, 255, 255], cloud * 0.8);
        const hx = lightDir[0], hy = lightDir[1], hz = lightDir[2] + 1;
        const hlen = Math.hypot(hx, hy, hz) || 1;
        const ndoth = Math.max(0, (nx * hx + ny * hy + nz * hz) / hlen);
        const spec = Math.pow(ndoth, tuning.specularPower) * (1 - continent) * (1 - cloud);
        emissive = [spec * 255, spec * 255, spec * 255];
      } else if (kind === 'gas') {
        const warp = (noise3(nx * tuning.warpFreq + seed, ny * tuning.warpFreq + seed, nz * tuning.warpFreq + seed, seed + 11) - 0.5) * tuning.warpAmount;
        const n = fbm3((nx + warp) * 1.2, (ny + warp * 0.6) * tuning.bandFreq, (nz - warp) * 1.2, seed, 4);
        const bt = tuning.bandThreshold;
        const t = smoothstep(bt[0], bt[1], n);
        [r, gC, b] = mixRGB(lo, hi, t);
        [r, gC, b] = mixRGB([r, gC, b], base, 0.25);
        const sx = nx - 0.25, sy = ny + 0.1;
        const spot = smoothstep(0.16, 0.08, Math.hypot(sx, sy * 1.8));
        [r, gC, b] = mixRGB([r, gC, b], lo, spot * 0.6);
      } else {
        // Temporary fallback for ice/volcanic (added in Task 4) and the real rocky kind.
        const ct = tuning.continentThreshold || PAINTER_TUNING.rocky.continentThreshold;
        const land = fbm3(nx * 2.1 + seed, ny * 2.1 + seed, nz * 2.1 + seed, seed, 4);
        const continent = smoothstep(ct[0], ct[1], land);
        [r, gC, b] = mixRGB(lo, base, continent);
        const craterFreq = tuning.craterFreq || PAINTER_TUNING.rocky.craterFreq;
        const wd = worleyF1(nx * craterFreq + seed, ny * craterFreq + seed, nz * craterFreq + seed, seed + 5);
        const rb = tuning.rimBand || PAINTER_TUNING.rocky.rimBand, fb = tuning.floorBand || PAINTER_TUNING.rocky.floorBand;
        const rim = smoothstep(rb[0], rb[1], wd), floor = smoothstep(fb[0], fb[1], wd);
        [r, gC, b] = mixRGB([r, gC, b], hi, rim * 0.4);
        [r, gC, b] = mixRGB([r, gC, b], lo, floor * 0.7);
      }

      const diffuse = Math.max(0, nx * lightDir[0] + ny * lightDir[1] + nz * lightDir[2]);
      const ambient = kind === 'volcanic' ? (tuning.ambient ?? 0.22) : 0.22;
      const shade = ambient + (1 - ambient) * diffuse;
      const limb = 0.55 + 0.45 * Math.pow(nz, 0.6);
      const k = shade * limb;

      let rimGlow = [0, 0, 0];
      if (atmo) {
        const fres = Math.pow(1 - nz, 4) * Math.max(0.15, diffuse);
        rimGlow = [atmo[0] * fres * 0.7, atmo[1] * fres * 0.7, atmo[2] * fres * 0.7];
      }

      const idx = (py * bw + px) * 4;
      data[idx] = clamp8(r * k + emissive[0] + rimGlow[0]);
      data[idx + 1] = clamp8(gC * k + emissive[1] + rimGlow[1]);
      data[idx + 2] = clamp8(b * k + emissive[2] + rimGlow[2]);
      data[idx + 3] = 255;
    }
  }
  g.putImageData(img, bx0, by0);

  if (body.rings) {
    g.save(); g.translate(cx, cy); g.rotate(-0.5); g.scale(1, 0.32);
    g.strokeStyle = hexA(lighten(body.color, 0.3), 0.7); g.lineWidth = S * 0.026;
    g.beginPath(); g.arc(0, 0, R * 1.4, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = hexA(body.color, 0.5); g.lineWidth = S * 0.013;
    g.beginPath(); g.arc(0, 0, R * 1.62, 0, Math.PI * 2); g.stroke();
    g.restore();
  }
  return markTex(new THREE.CanvasTexture(cv));
}
```

- [ ] **Step 3: Wire dispatch into `createCelestialBodies`**

In `createCelestialBodies`, replace the line `const tex = paintBody(body);` with:

```js
    const tex = body.detail === 'high' ? paintBodyHD(body) : paintBodySimple(body);
```

- [ ] **Step 4: Run the smoke test**

Run: `node test-celestial-bodies-smoke.mjs`
Expected: `all passed` — terrestrial and gas now render through the real HD math; ice/volcanic still render (via the rocky fallback branch) without throwing.

- [ ] **Step 5: Commit**

```bash
git add celestial-bodies.js
git commit -m "feat(sky): add HD sphere-shaded painter (terrestrial, gas) dispatched by body.detail"
```

## Task 4: `celestial-bodies.js` — add ice + volcanic kinds

**Files:**
- Modify: `celestial-bodies.js` (the `paintBodyHD` function added in Task 3)

- [ ] **Step 1: Insert ice and volcanic branches before the fallback `else`**

In `paintBodyHD`, find:

```js
      } else {
        // Temporary fallback for ice/volcanic (added in Task 4) and the real rocky kind.
```

Replace that line and the comment with:

```js
      } else if (kind === 'ice') {
        const [f1, f2] = worleyF1F2(nx * tuning.crackFreq + seed, ny * tuning.crackFreq + seed, nz * tuning.crackFreq + seed, seed + 3);
        const crack = smoothstep(tuning.crackWidth, 0.0, f2 - f1);
        [r, gC, b] = mixRGB(base, hi, crack);
      } else if (kind === 'volcanic') {
        const crust = fbm3(nx * 2.6 + seed, ny * 2.6 + seed, nz * 2.6 + seed, seed, 4);
        [r, gC, b] = mixRGB(lo, base, smoothstep(0.3, 0.7, crust));
        const [f1, f2] = worleyF1F2(nx * tuning.veinFreq + seed, ny * tuning.veinFreq + seed, nz * tuning.veinFreq + seed, seed + 3);
        const vein = smoothstep(tuning.veinWidth, 0.0, f2 - f1);
        const hot = smoothstep(tuning.hotWidth, 0.0, f2 - f1);
        emissive = mixRGB(mixRGB([0, 0, 0], [255, 130, 20], vein), [255, 220, 90], hot);
      } else {
        // rocky (also the only kind reaching this branch now — ice/volcanic have their own above).
```

Also update the ambient line — volcanic should use its own low ambient (`0.12`) instead of falling back to `0.22`:

Find:
```js
      const ambient = kind === 'volcanic' ? (tuning.ambient ?? 0.22) : 0.22;
```
Replace with:
```js
      const ambient = kind === 'volcanic' ? tuning.ambient : 0.22;
```

- [ ] **Step 2: Run the smoke test**

Run: `node test-celestial-bodies-smoke.mjs`
Expected: `all passed` — all 5 kinds now exercise their real dedicated code path.

- [ ] **Step 3: Commit**

```bash
git add celestial-bodies.js
git commit -m "feat(sky): add ice (cell-edge cracks) and volcanic (emissive veins) HD kinds"
```

## Task 5: `stellar-viewer.html` — scaffold + Gallery mode

**Files:**
- Create: `stellar-viewer.html`

- [ ] **Step 1: Write the file**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Stellar Object Viewer</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #05060a; font: 13px/1.4 system-ui, sans-serif; color: #cdd3e0; }
  #ui { position: fixed; top: 10px; left: 10px; z-index: 5; background: rgba(10,12,20,0.85);
    border: 1px solid #232838; border-radius: 8px; padding: 10px 14px; max-width: 340px; }
  #ui h2 { font-size: 13px; margin: 0 0 8px; color: #aab2c8; }
  #ui label { display: block; margin: 6px 0 2px; font-size: 11px; color: #8a93a3; }
  #ui input[type=range] { width: 100%; }
  #ui button { background: #232838; color: #cdd3e0; border: 1px solid #343b52; border-radius: 4px;
    padding: 4px 10px; margin: 4px 6px 4px 0; cursor: pointer; font-size: 12px; }
  #ui button:hover { background: #2d3348; }
  #ui input[type=text] { width: 90px; background: #11131c; color: #cdd3e0; border: 1px solid #343b52; border-radius: 4px; padding: 3px 6px; }
  .kindRow label { display: inline-block; margin-right: 10px; font-size: 12px; }
  #labels { position: fixed; inset: 0; pointer-events: none; z-index: 4; }
  #labels div { position: absolute; transform: translate(-50%, 4px); font-size: 11px; color: #8a93a3;
    text-align: center; white-space: nowrap; pointer-events: auto; cursor: pointer; }
  #labels div:hover { color: #fff; }
</style>
</head>
<body>
<div id="ui"></div>
<div id="labels"></div>

<script type="importmap">
{ "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.webgpu.js",
    "three/webgpu": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.webgpu.js",
    "three/tsl": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.tsl.js"
} }
</script>

<script type="module">
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { makeRng, makePalette, generateCelestialBodies } from './sky-field.js';
import { createCelestialBodies } from './celestial-bodies.js';

const renderer = new WebGPURenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05060a);

const VIEW = 1400; // world units visible across the vertical axis
let aspect = window.innerWidth / window.innerHeight;
const camera = new THREE.OrthographicCamera(-VIEW * aspect / 2, VIEW * aspect / 2, VIEW / 2, -VIEW / 2, 0.1, 5000);
camera.position.set(0, 0, 1000);
camera.lookAt(0, 0, 0);

window.addEventListener('resize', () => {
  aspect = window.innerWidth / window.innerHeight;
  camera.left = -VIEW * aspect / 2; camera.right = VIEW * aspect / 2;
  camera.top = VIEW / 2; camera.bottom = -VIEW / 2;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const RADIUS = 1000;
const PALETTE = makePalette();
const KINDS = ['terrestrial', 'gas', 'ice', 'volcanic', 'rocky'];

let currentSeed = 1;
let galleryGroup = null;
let kindFilter = new Set(KINDS);

const labelsEl = document.getElementById('labels');
const uiEl = document.getElementById('ui');

function clearLabels() { labelsEl.innerHTML = ''; }

function worldToScreen(pos) {
  const v = pos.clone().project(camera);
  return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (1 - (v.y * 0.5 + 0.5)) * window.innerHeight };
}

function buildGallery(seed) {
  if (galleryGroup) { scene.remove(galleryGroup); galleryGroup = null; }
  clearLabels();
  const rng = makeRng(seed);
  // Force every displayed body through paintBodyHD — this gallery exists to showcase
  // the detailed painter across kinds, unlike the game where only the near planet +
  // its moons are worth the extra per-pixel cost.
  const bodies = generateCelestialBodies(RADIUS, PALETTE, rng)
    .filter(b => kindFilter.has(b.kind))
    .map(b => ({ ...b, detail: 'high' }));
  const cols = Math.ceil(Math.sqrt(bodies.length)) || 1;
  const spacing = 220;
  galleryGroup = createCelestialBodies(bodies);
  galleryGroup.children.forEach((spr, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    spr.position.set((col - (cols - 1) / 2) * spacing, ((cols - 1) / 2 - row) * spacing, 0);
    // The gallery is for close inspection of the painted texture, not for preserving
    // the game's distance-based scale differences — fill most of each grid cell instead.
    const s = spacing * 0.8;
    spr.scale.set(s, s, 1);
  });
  scene.add(galleryGroup);

  bodies.forEach((b, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const pos = new THREE.Vector3((col - (cols - 1) / 2) * spacing, ((cols - 1) / 2 - row) * spacing, 0);
    const div = document.createElement('div');
    div.textContent = b.kind;
    div._worldPos = pos;
    labelsEl.appendChild(div);
  });
  positionLabels();
}

function positionLabels() {
  for (const div of labelsEl.children) {
    const s = worldToScreen(div._worldPos);
    div.style.left = s.x + 'px';
    div.style.top = s.y + 'px';
  }
}

function renderUi() {
  uiEl.innerHTML = '';
  const h = document.createElement('h2');
  h.textContent = 'Stellar Object Viewer — Gallery';
  uiEl.appendChild(h);

  const kindRow = document.createElement('div'); kindRow.className = 'kindRow';
  for (const k of KINDS) {
    const lbl = document.createElement('label');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = kindFilter.has(k);
    cb.addEventListener('change', () => { cb.checked ? kindFilter.add(k) : kindFilter.delete(k); buildGallery(currentSeed); });
    lbl.appendChild(cb); lbl.appendChild(document.createTextNode(' ' + k));
    kindRow.appendChild(lbl);
  }
  uiEl.appendChild(kindRow);

  const seedInput = document.createElement('input'); seedInput.type = 'text'; seedInput.value = String(currentSeed);
  const reroll = document.createElement('button'); reroll.textContent = 'Reroll';
  reroll.addEventListener('click', () => { currentSeed = (Math.random() * 0xffffffff) >>> 0; seedInput.value = String(currentSeed); buildGallery(currentSeed); });
  const goBtn = document.createElement('button'); goBtn.textContent = 'Go';
  goBtn.addEventListener('click', () => { currentSeed = (Number(seedInput.value) >>> 0) || 1; buildGallery(currentSeed); });
  uiEl.appendChild(reroll); uiEl.appendChild(seedInput); uiEl.appendChild(goBtn);
}

buildGallery(currentSeed);
renderUi();

function animate() {
  positionLabels();
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(animate);
</script>
</body>
</html>
```

- [ ] **Step 2: Verify it loads**

Run: `python serve.py` (from `workshop-webgpu/`)
Open: `http://127.0.0.1:8080/stellar-viewer.html`
Expected: a grid of planet/moon sprites renders with text labels underneath each (kind name, `★` marker on the one high-detail body), kind checkboxes toggle bodies in/out, Reroll produces a new layout, typing a number into the seed field + Go reproduces a specific layout. No console errors.

- [ ] **Step 3: Commit**

```bash
git add stellar-viewer.html
git commit -m "feat(sky): add stellar-viewer.html gallery mode, importing production sky-field/celestial-bodies"
```

## Task 6: `stellar-viewer.html` — Solo mode

**Files:**
- Modify: `stellar-viewer.html`

- [ ] **Step 1: Import `PAINTER_TUNING` and add solo-mode state**

Find:
```js
import { createCelestialBodies } from './celestial-bodies.js';
```
Replace with:
```js
import { createCelestialBodies, PAINTER_TUNING } from './celestial-bodies.js';
```

Find:
```js
let currentSeed = 1;
let galleryGroup = null;
let kindFilter = new Set(KINDS);
```
Replace with:
```js
let currentSeed = 1;
let galleryGroup = null;
let kindFilter = new Set(KINDS);
let mode = 'gallery';   // 'gallery' | 'solo'
let soloGroup = null;
let soloBody = null;
```

- [ ] **Step 2: Make labels clickable and add solo enter/exit/repaint functions**

Find, inside `buildGallery`:
```js
    const div = document.createElement('div');
    div.textContent = b.kind;
    div._worldPos = pos;
    labelsEl.appendChild(div);
```
Replace with:
```js
    const div = document.createElement('div');
    div.textContent = b.kind;
    div._worldPos = pos;
    div.addEventListener('click', () => enterSolo(b));
    labelsEl.appendChild(div);
```

Then, directly after the `positionLabels` function, add:

```js
function enterSolo(body) {
  mode = 'solo';
  soloBody = body;
  if (galleryGroup) { scene.remove(galleryGroup); galleryGroup = null; }
  clearLabels();
  soloGroup = createCelestialBodies([body]);
  soloGroup.children[0].position.set(0, 0, 0);
  soloGroup.children[0].scale.set(500, 500, 1);
  scene.add(soloGroup);
  renderUi();
}

function exitSolo() {
  mode = 'gallery';
  if (soloGroup) { scene.remove(soloGroup); soloGroup = null; }
  soloBody = null;
  buildGallery(currentSeed);
  renderUi();
}

function repaintSolo() {
  if (!soloGroup) return;
  scene.remove(soloGroup);
  soloGroup = createCelestialBodies([soloBody]);
  soloGroup.children[0].position.set(0, 0, 0);
  soloGroup.children[0].scale.set(500, 500, 1);
  scene.add(soloGroup);
}
```

- [ ] **Step 3: Branch `renderUi` on `mode` and add tuning sliders**

Replace the entire `renderUi` function with:

```js
function renderUi() {
  uiEl.innerHTML = '';
  const h = document.createElement('h2');
  h.textContent = mode === 'gallery' ? 'Stellar Object Viewer — Gallery' : `Solo: ${soloBody.kind}`;
  uiEl.appendChild(h);

  if (mode === 'gallery') {
    const kindRow = document.createElement('div'); kindRow.className = 'kindRow';
    for (const k of KINDS) {
      const lbl = document.createElement('label');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = kindFilter.has(k);
      cb.addEventListener('change', () => { cb.checked ? kindFilter.add(k) : kindFilter.delete(k); buildGallery(currentSeed); });
      lbl.appendChild(cb); lbl.appendChild(document.createTextNode(' ' + k));
      kindRow.appendChild(lbl);
    }
    uiEl.appendChild(kindRow);

    const seedInput = document.createElement('input'); seedInput.type = 'text'; seedInput.value = String(currentSeed);
    const reroll = document.createElement('button'); reroll.textContent = 'Reroll';
    reroll.addEventListener('click', () => { currentSeed = (Math.random() * 0xffffffff) >>> 0; seedInput.value = String(currentSeed); buildGallery(currentSeed); });
    const goBtn = document.createElement('button'); goBtn.textContent = 'Go';
    goBtn.addEventListener('click', () => { currentSeed = (Number(seedInput.value) >>> 0) || 1; buildGallery(currentSeed); });
    uiEl.appendChild(reroll); uiEl.appendChild(seedInput); uiEl.appendChild(goBtn);
    return;
  }

  const back = document.createElement('button'); back.textContent = '← Back to gallery';
  back.addEventListener('click', exitSolo);
  uiEl.appendChild(back);

  const tuning = PAINTER_TUNING[soloBody.kind];
  if (tuning) {
    for (const key of Object.keys(tuning)) {
      const val = tuning[key];
      if (Array.isArray(val)) {
        val.forEach((v, i) => {
          const lbl = document.createElement('label'); lbl.textContent = `${key}[${i}] = ${v.toFixed(3)}`;
          const inp = document.createElement('input'); inp.type = 'range'; inp.min = '0'; inp.max = '1'; inp.step = '0.01'; inp.value = String(v);
          inp.addEventListener('input', () => { tuning[key][i] = Number(inp.value); lbl.textContent = `${key}[${i}] = ${Number(inp.value).toFixed(3)}`; repaintSolo(); });
          uiEl.appendChild(lbl); uiEl.appendChild(inp);
        });
      } else {
        const lbl = document.createElement('label'); lbl.textContent = `${key} = ${val.toFixed(3)}`;
        const inp = document.createElement('input'); inp.type = 'range'; inp.min = '0'; inp.max = String(Math.max(1, val * 3)); inp.step = '0.01'; inp.value = String(val);
        inp.addEventListener('input', () => { tuning[key] = Number(inp.value); lbl.textContent = `${key} = ${Number(inp.value).toFixed(3)}`; repaintSolo(); });
        uiEl.appendChild(lbl); uiEl.appendChild(inp);
      }
    }
  }

  const reroll = document.createElement('button'); reroll.textContent = 'Reroll this body';
  reroll.style.marginTop = '8px';
  reroll.addEventListener('click', () => {
    const rng = makeRng((Math.random() * 0xffffffff) >>> 0);
    const bodies = generateCelestialBodies(RADIUS, PALETTE, rng).filter(b => b.kind === soloBody.kind);
    // Force high detail — a freshly generated body of this kind may naturally roll as
    // a distant/extra body (detail: 'low'), which would silently fall back to the cheap
    // painter here even though this is Solo mode's whole point.
    soloBody = bodies[0] ? { ...bodies[0], detail: 'high' } : soloBody;
    repaintSolo();
  });
  uiEl.appendChild(document.createElement('br'));
  uiEl.appendChild(reroll);
}
```

- [ ] **Step 4: Only reposition labels in gallery mode**

Find:
```js
function animate() {
  positionLabels();
  renderer.render(scene, camera);
}
```
Replace with:
```js
function animate() {
  if (mode === 'gallery') positionLabels();
  renderer.render(scene, camera);
}
```

- [ ] **Step 5: Verify it loads**

Run: `python serve.py` (if not already running)
Open: `http://127.0.0.1:8080/stellar-viewer.html`
Expected: clicking any body's label switches to Solo mode (single large sprite, back button, sliders labeled with that body's `PAINTER_TUNING` keys). Dragging a slider repaints the body live with no full-page reload. "Reroll this body" swaps in a freshly generated body of the same kind. Back button returns to the gallery at the same seed/filter state.

- [ ] **Step 6: Commit**

```bash
git add stellar-viewer.html
git commit -m "feat(sky): add stellar-viewer.html solo mode with live PAINTER_TUNING sliders"
```

## Task 7: Docs + agent log

**Files:**
- Modify: `docs/subsystems/sky.md`
- Modify: `agent_log.csv`

- [ ] **Step 1: Update the `celestial-bodies.js` row in the Files table**

Find:
```
| `celestial-bodies.js` | TSL rendering of extra moons/planets as camera-following sprites; canvas-painted textures (shaded sphere, optional bands/rings/glow). | 94 |
```
Replace with:
```
| `celestial-bodies.js` | TSL rendering of extra moons/planets as camera-following sprites. Two painters dispatched by `body.detail`: `paintBodySimple` (cheap, unchanged, for distant/tiny bodies) and `paintBodyHD` (per-pixel sphere-normal shading, fbm/Worley surface detail per `body.kind`, for the near planet + its moons). Visual constants live in exported `PAINTER_TUNING`, mutated live by `stellar-viewer.html`. | ~330 |
```

- [ ] **Step 2: Update the Public API section**

Find:
```
**celestial-bodies.js**
```js
export function createCelestialBodies(bodyData)
```
```
Replace with:
```
**celestial-bodies.js**
```js
export function createCelestialBodies(bodyData)
export const PAINTER_TUNING   // { terrestrial, gas, ice, volcanic, rocky } visual constants, mutable
```
```

- [ ] **Step 3: Update the "Celestial bodies" architecture note**

Find:
```
- **Celestial bodies**: `generateCelestialBodies` produces 1-2 extra moons, 2-4
  distant planets, exactly one "near" planet (size ~0.06-0.10 R, may have rings/glow),
  and 1-3 companion moons orbiting near the near planet's screen position — gated by
  the caller on `palette.milkyWay` (i.e. only at night/dusk). `celestial-bodies.js`
  paints each as a canvas-shaded sphere sprite with optional gas bands, rings, and
  glow halo.
```
Replace with:
```
- **Celestial bodies**: `generateCelestialBodies` produces 1-2 extra moons, 2-4
  distant planets, exactly one "near" planet (size ~0.06-0.10 R, may have rings/glow),
  and 1-3 companion moons orbiting near the near planet's screen position — gated by
  the caller on `palette.milkyWay` (i.e. only at night/dusk). Every body also carries
  a `kind` (`terrestrial | gas | ice | volcanic | rocky`, weighted random; moons only
  roll `ice`/`rocky`), a `detail` flag (`'high'` for the near planet + its companion
  moons, `'low'` for everything else), and a `seed` in `[0,1)` used to vary the HD
  painter's noise per body. `celestial-bodies.js` dispatches `detail === 'high'` bodies
  to `paintBodyHD` (real sphere-normal Lambertian shading + fbm continents/clouds/polar
  caps/specular for terrestrial, domain-warped turbulent bands for gas, Worley
  cell-edge cracks for ice, emissive Worley veins for volcanic, Worley craters for
  rocky, plus a Fresnel rim glow for atmosphere-bearing kinds) and everything else to
  the original `paintBodySimple`.
- **Dev tool — `stellar-viewer.html`** (repo root, served by `python serve.py`, same
  import map as `environment-viewer.html`): imports `sky-field.js`/`celestial-bodies.js`
  directly (no duplicated logic). Gallery mode shows a grid of generated bodies with
  kind filters and a reroll/seed control; clicking one opens Solo mode, which exposes
  `PAINTER_TUNING`'s fields as live sliders — moving one repaints that body's texture
  immediately, since the slider mutates the same exported object the game reads.
```

- [ ] **Step 4: Update the Tests section**

Find:
```
- `generateCelestialBodies(radius, palette, rng)` — moon count (1-2), distant planet
  count (2-4), exactly one near planet, companion moon count (1-3), every body sits
  on its own declared `radius`, per-seed determinism.
```
Replace with:
```
- `generateCelestialBodies(radius, palette, rng)` — moon count (1-2), distant planet
  count (2-4), exactly one near planet, companion moon count (1-3), every body sits
  on its own declared `radius`, per-seed determinism, every body has a `kind` (moons
  restricted to `ice`/`rocky`), `detail` matches near/companion vs. distant/extra, all
  5 planet kinds appear across 200 seeds, `gas` stays derived from `kind` for
  `paintBodySimple` backward-compatibility, every body carries a `[0,1)` `seed`.

`test-celestial-bodies-smoke.mjs` (repo root, plain Node script) exercises the real
`celestial-bodies.js` paint dispatch with a minimal `document.createElement('canvas')`
stub — confirms every `kind` × `detail` combination paints without throwing. It does
not assert pixel content (no automated coverage exists for that — see below).
```

- [ ] **Step 5: Append the agent log row**

Run (from `workshop-webgpu/`):

```bash
printf '2026-06-30T00:00,sky,"sky-field.js;celestial-bodies.js;stellar-viewer.html;test-sky-field.mjs;test-celestial-bodies-smoke.mjs;docs/subsystems/sky.md",Replaced the flat-gradient planet/moon painter with a per-pixel HD painter across 5 kinds (terrestrial/gas/ice/volcanic/rocky) and shipped stellar-viewer.html, a standalone dev tool importing the production sky modules directly so tuning never drifts from the game.\n' >> agent_log.csv
```

- [ ] **Step 6: Commit**

```bash
git add docs/subsystems/sky.md agent_log.csv
git commit -m "docs(sky): document HD painter kinds/tuning and stellar-viewer.html"
```

## Task 8: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run both Node test scripts**

Run: `node test-sky-field.mjs && node test-celestial-bodies-smoke.mjs`
Expected: both print `all passed` and exit 0.

- [ ] **Step 2: Manually verify `stellar-viewer.html`**

Run: `python serve.py`
Open: `http://127.0.0.1:8080/stellar-viewer.html`
Check: all 5 kinds appear when rerolling a few times (uncheck/recheck kind filters to confirm each renders distinctly — terrestrial has continents/clouds/ice caps, gas has swirling bands, ice has crack networks, volcanic has glowing veins even on the unlit side, rocky has round craters). Click into Solo mode for one of each kind, drag a couple of sliders, confirm the texture repaints live. No console errors in the browser dev tools.

- [ ] **Step 3: Confirm no regression in the main game**

Open: `http://127.0.0.1:8080/environment-viewer.html`
Check: night sky still loads (planets/moons visible, no console errors), toggling `primaryBody`/`starCount` sliders in the Sky panel still works as before. This confirms `sky.js`'s existing call site (`createCelestialBodies(generateCelestialBodies(...))`) needed no changes and the new dispatch logic didn't break the production path.
