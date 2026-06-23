# TSL Night Sky Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full procedural night sky (gradient dome, twinkling stars, Milky Way, extra moons/planets, and a sun/moon disc locked to the scene light) to `environment-viewer.html`, rebuilt in WebGPU/TSL.

**Architecture:** One pure-JS generator module (`sky-field.js`, Node-tested — no three import, mirrors `particle-field.js`) holds all deterministic math: palette, radius, sprite placement, star/Milky-Way/celestial-body generation. Three TSL rendering modules consume it: `sky.js` (dome + primary sun/moon sprite + camera-following group + lifecycle, owns canvas-texture painting), `stars.js` (star Points + Milky-Way gas/band, GPU twinkle), `celestial-bodies.js` (extra moon/planet sprites). The viewer wires a `moonLight`, the camera-follow + `setSunDir` calls, and a "SKY" control panel.

**Tech Stack:** three@0.184.0 `three/webgpu` (`MeshBasicNodeMaterial`, `PointsNodeMaterial`, `SpriteNodeMaterial`), `three/tsl` nodes, HTML canvas 2D for sprite textures, Node for unit tests (`node test-*.mjs`).

---

## File Structure

- **Create `sky-field.js`** — pure JS, no three. Exports: `DEFAULT_PALETTE`, `makePalette()`, `skyRadius()`, `isMoonBody()`, `sunSpritePlacement()`, `makeRng()`, `generateStars()`, `generateMilkyWay()`, `generateCelestialBodies()`. The CPU source of truth; Node-tested.
- **Create `test-sky-field.mjs`** — Node tests for every `sky-field.js` export.
- **Create `stars.js`** — TSL. Exports `createSkyStars(starData, palette)`, `createMilkyWay(milkyData, palette)`. Returns `THREE.Points` / `THREE.Group` with node materials; GPU twinkle via the built-in `time` node.
- **Create `celestial-bodies.js`** — TSL. Exports `createCelestialBodies(bodyData)` → `THREE.Group` of sprites; owns planet/moon canvas painters.
- **Create `sky.js`** — TSL. Exports `createSky({ scene, camera, size, palette, sunDir })` → `{ group, setSunDir, setPalette, setCelestialType, rebuild, update, dispose }`. Owns the dome material, the primary sun/moon sprite + `makeSkySunTexture`, and composes `stars.js` + `celestial-bodies.js`.
- **Modify `environment-viewer.html`** — add `moonLight`; import + build `sky`; camera-follow + `setSunDir` + `update` in `animate()`; rebuild on view-distance change; "SKY" control-panel section.

Convention notes (match existing code): tests are flat `.mjs` files using a local `ok()` helper and run with `node test-foo.mjs`; TSL modules import from `'three'`, `'three/webgpu'`, `'three/tsl'`; canvas textures get `texture.userData.proceduralSkyTexture = true` and are `.dispose()`d on teardown.

---

## Task 1: Pure palette + radius + sprite-placement math

**Files:**
- Create: `sky-field.js`
- Test: `test-sky-field.mjs`

- [ ] **Step 1: Write the failing test**

Create `test-sky-field.mjs`:

```js
import { DEFAULT_PALETTE, makePalette, skyRadius, isMoonBody, sunSpritePlacement } from './sky-field.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
const approx = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// ---- palette ----
ok(DEFAULT_PALETTE.celestialType === 'sun', 'default body is the sun');
ok(makePalette().starCount === DEFAULT_PALETTE.starCount, 'makePalette() clones defaults');
ok(makePalette({ starCount: 42 }).starCount === 42, 'makePalette() applies overrides');
ok(makePalette({ starCount: 42 }).top === DEFAULT_PALETTE.top, 'unspecified fields keep defaults');
ok(makePalette() !== DEFAULT_PALETTE, 'makePalette() returns a fresh object');

// ---- radius: min(far*0.88, max(420, size*2.65)) ----
ok(skyRadius(1000, 120) === Math.min(880, 420), 'small size clamps to floor 420');
ok(skyRadius(1000, 300) === Math.min(880, 795), 'far*0.88 wins when nearer than size band');
ok(skyRadius(2000, 300) === Math.min(1760, 795), 'size band wins when far is huge');
ok(skyRadius(100, 0) === Math.min(88, 420), 'zero/undefined size falls back to 120 floor');

// ---- isMoonBody: explicit type, else sunOpacity<0.6 inference ----
ok(isMoonBody({ celestialType: 'moon', sunOpacity: 1 }) === true, 'explicit moon type');
ok(isMoonBody({ celestialType: 'sun', sunOpacity: 0.1 }) === false, 'explicit sun type overrides opacity');
ok(isMoonBody({ sunOpacity: 0.4 }) === true, 'low opacity infers moon');
ok(isMoonBody({ sunOpacity: 0.9 }) === false, 'high opacity infers sun');

// ---- sprite placement: pos = dir*radius*0.74; scale = radius*sunSize*2.15*(moon?2.4:1) ----
{
  const dir = [0.6, 0.55, 0.58];
  const len = Math.hypot(...dir);
  const p = sunSpritePlacement(dir, 1000, { sunSize: 0.06, celestialType: 'sun', sunOpacity: 1 });
  ok(approx(p.position.x, dir[0] / len * 740) && approx(p.position.y, dir[1] / len * 740), 'sun sits along normalized dir at 0.74R');
  ok(approx(p.scale, 1000 * 0.06 * 2.15), 'sun scale = R*sunSize*2.15');
  const m = sunSpritePlacement(dir, 1000, { sunSize: 0.06, celestialType: 'moon', sunOpacity: 1 });
  ok(approx(m.scale, 1000 * 0.06 * 2.15 * 2.4), 'moon scale is 2.4x the sun');
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-sky-field.mjs`
Expected: FAIL — `Cannot find module './sky-field.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `sky-field.js`:

```js
// sky-field.js
// Pure-JS night-sky generators — NO three.js import. CPU source of truth the TSL
// rendering modules (sky.js / stars.js / celestial-bodies.js) consume, and the
// Node-tested guard. Mirrors particle-field.js: deterministic math, no DOM/GPU.

// A single tunable night palette (this project has one continuous environment, so
// there are no per-map presets). Colors are hex strings; three parses them later.
export const DEFAULT_PALETTE = {
  top:        '#0a1026',   // zenith
  horizon:    '#243b66',   // horizon band
  bottom:     '#0b1430',   // below horizon
  glow:       '#3a5a8c',   // horizon glow tint
  sun:        '#fff4e0',   // warm sun disc
  moonColor:  '#dfe7ff',   // cool moon disc
  sunSize:    0.06,        // sprite size as a fraction of sky radius
  sunOpacity: 1.0,         // <0.6 infers a moon when celestialType is unset
  celestialType: 'sun',    // 'sun' | 'moon' — explicit primary-body choice
  starColor:  '#dfe8ff',
  starCount:  1400,
  starOpacity: 1.0,
  starSize:   2.2,         // base point size in px (size attenuation off)
  milkyWay:   true,
  milkyWayIntensity: 0.7,
};

export function makePalette(overrides = {}) {
  return Object.assign({}, DEFAULT_PALETTE, overrides);
}

// Sky dome radius (faithful to the source spec).
export function skyRadius(far, size) {
  return Math.min(far * 0.88, Math.max(420, (Number(size) || 120) * 2.65));
}

// Primary body identity: explicit type wins; otherwise infer from sun opacity.
export function isMoonBody(palette) {
  if (palette.celestialType === 'moon') return true;
  if (palette.celestialType === 'sun') return false;
  return palette.sunOpacity < 0.6;
}

// Sprite world placement along the (un-normalized) light direction.
export function sunSpritePlacement(dir, radius, palette) {
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const r = radius * 0.74;
  const moon = isMoonBody(palette);
  return {
    position: { x: dir[0] / len * r, y: dir[1] / len * r, z: dir[2] / len * r },
    scale: radius * palette.sunSize * 2.15 * (moon ? 2.4 : 1),
    isMoon: moon,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-sky-field.mjs`
Expected: PASS — `all passed`.

- [ ] **Step 5: Commit**

```bash
git add sky-field.js test-sky-field.mjs
git commit -m "SP6: sky-field palette/radius/sprite-placement math + Node tests"
```

---

## Task 2: Deterministic RNG + star-field generation

**Files:**
- Modify: `sky-field.js`
- Test: `test-sky-field.mjs` (append)

- [ ] **Step 1: Write the failing test** — append before the final summary lines in `test-sky-field.mjs`:

```js
import { makeRng, generateStars } from './sky-field.js';

// ---- makeRng: deterministic, in [0,1) ----
{
  const a = makeRng(7), b = makeRng(7);
  const va = [a(), a(), a()], vb = [b(), b(), b()];
  ok(va.every((v, i) => v === vb[i]), 'same seed → same stream');
  ok(va.every(v => v >= 0 && v < 1), 'rng values in [0,1)');
  ok(makeRng(8)() !== va[0], 'different seed → different stream');
}

// ---- generateStars: counts, hemisphere, radius shell, attribute ranges ----
{
  const pal = makePalette({ starCount: 1000, starSize: 2 });
  const s = generateStars(1000, pal, makeRng(1));
  ok(s.count === 1000, 'star count matches palette');
  ok(s.position.length === 3000 && s.size.length === 1000, 'typed arrays sized to count');
  let aboveHorizon = true, onShell = true, brightOk = true;
  const R = 1000 * 0.83;
  for (let i = 0; i < s.count; i++) {
    const x = s.position[i * 3], y = s.position[i * 3 + 1], z = s.position[i * 3 + 2];
    if (y < 0.06 * R - 1e-3) aboveHorizon = false;        // upper hemisphere only
    if (Math.abs(Math.hypot(x, y, z) - R) > 1e-2) onShell = false;
    if (s.brightness[i] < 0.62 - 1e-6 || s.brightness[i] > 1.0 + 1e-6) brightOk = false;
  }
  ok(aboveHorizon, 'all stars above the horizon (y >= 0.06R)');
  ok(onShell, 'all stars on the 0.83R shell');
  ok(brightOk, 'brightness within [0.62, 1.0]');
  ok(generateStars(1000, pal, makeRng(1)).position[0] === s.position[0], 'generation is deterministic per seed');
  ok(s.clusterCount >= 1 && s.clusterCount <= 3, 'dense sky reserves 1-3 clusters');
  const sparse = generateStars(1000, makePalette({ starCount: 200 }), makeRng(1));
  ok(sparse.clusterCount === 0, 'sparse sky reserves no clusters');
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-sky-field.mjs`
Expected: FAIL — `makeRng is not a function` / `generateStars is not a function`.

- [ ] **Step 3: Write minimal implementation** — append to `sky-field.js`:

```js
// Mulberry32: tiny deterministic PRNG → () => [0,1).
export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// One unit-sphere point on the upper hemisphere (y in [0.06, 0.96]).
function hemiDir(rng) {
  const theta = rng() * Math.PI * 2;
  const y = 0.06 + rng() * 0.9;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  return { x: Math.cos(theta) * r, y, z: Math.sin(theta) * r };
}

// Generate the star point cloud: positions on the 0.83R shell plus per-star twinkle
// attributes. A dense sky reserves a few stars for 1-3 Pleiades-like clusters; clustered
// and background stars share one geometry (one draw call downstream).
export function generateStars(radius, palette, rng) {
  const count = palette.starCount | 0;
  const shell = radius * 0.83;
  const position = new Float32Array(count * 3);
  const brightness = new Float32Array(count);
  const phase = new Float32Array(count);
  const speed = new Float32Array(count);
  const strength = new Float32Array(count);
  const size = new Float32Array(count);

  // Decide cluster reservation (only for reasonably dense skies).
  const clusterCount = count >= 800 ? 1 + ((rng() * 3) | 0) : 0;
  const clusters = [];
  let reserved = 0;
  for (let c = 0; c < clusterCount; c++) {
    const core = 6 + ((rng() * 5) | 0);     // tight bright core
    const ring = 10 + ((rng() * 11) | 0);   // looser faint halo
    if (reserved + core + ring > count) break;
    clusters.push({ center: hemiDir(rng), core, ring, start: reserved });
    reserved += core + ring;
  }

  const writeStar = (i, dir, bright, big) => {
    position[i * 3] = dir.x * shell;
    position[i * 3 + 1] = dir.y * shell;
    position[i * 3 + 2] = dir.z * shell;
    brightness[i] = bright;
    phase[i] = rng() * Math.PI * 2;
    speed[i] = 0.5 + rng() * 2.0;
    strength[i] = 0.15 + rng() * 0.5;
    const prominent = big || rng() < 0.04;
    size[i] = palette.starSize * (prominent ? 2.0 + rng() * 2.0 : 0.6 + rng() * 0.8);
  };

  // Clustered stars first (indices [0, reserved)).
  for (const cl of clusters) {
    let i = cl.start;
    for (let k = 0; k < cl.core; k++, i++) {
      const d = jitterDir(cl.center, 0.012, rng);
      writeStar(i, d, 0.85 + rng() * 0.15, true);
    }
    for (let k = 0; k < cl.ring; k++, i++) {
      const d = jitterDir(cl.center, 0.05, rng);
      writeStar(i, d, 0.62 + rng() * 0.3, false);
    }
  }
  // Background stars fill the rest.
  for (let i = reserved; i < count; i++) {
    writeStar(i, hemiDir(rng), 0.62 + rng() * 0.38, false);
  }

  return { count, position, brightness, phase, speed, strength, size, clusterCount };
}

// Nudge a unit direction by a small angular spread, re-projected onto the sphere.
function jitterDir(center, spread, rng) {
  const x = center.x + (rng() * 2 - 1) * spread;
  const y = Math.max(0.06, center.y + (rng() * 2 - 1) * spread);
  const z = center.z + (rng() * 2 - 1) * spread;
  const len = Math.hypot(x, y, z) || 1;
  return { x: x / len, y: y / len, z: z / len };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-sky-field.mjs`
Expected: PASS — `all passed`.

- [ ] **Step 5: Commit**

```bash
git add sky-field.js test-sky-field.mjs
git commit -m "SP6: deterministic RNG + star-field generation (clusters) + tests"
```

---

## Task 3: Milky-Way band + celestial-body generation

**Files:**
- Modify: `sky-field.js`
- Test: `test-sky-field.mjs` (append)

- [ ] **Step 1: Write the failing test** — append to `test-sky-field.mjs`:

```js
import { generateMilkyWay, generateCelestialBodies } from './sky-field.js';

// ---- Milky Way: only for night/dusk palettes; band on a tilted great circle ----
{
  const mw = generateMilkyWay(1000, makePalette({ milkyWay: true }), makeRng(2));
  ok(mw && mw.bandCount > 0, 'milky way present when enabled');
  ok(mw.position.length === mw.bandCount * 3, 'band positions sized to count');
  ok(typeof mw.tilt === 'number', 'band carries a tilt angle');
  let onShell = true;
  for (let i = 0; i < mw.bandCount; i++) {
    const x = mw.position[i*3], y = mw.position[i*3+1], z = mw.position[i*3+2];
    if (Math.abs(Math.hypot(x, y, z) - 1000 * 0.82) > 2) onShell = false;
  }
  ok(onShell, 'band stars lie on the ~0.82R shell');
  ok(generateMilkyWay(1000, makePalette({ milkyWay: false }), makeRng(2)) === null, 'no band when disabled');
}

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
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-sky-field.mjs`
Expected: FAIL — `generateMilkyWay is not a function`.

- [ ] **Step 3: Write minimal implementation** — append to `sky-field.js`:

```js
// Milky Way band: a dense ring of points on a tilted great circle (the galactic plane),
// each spread off-plane by a falloff so it reads as a band, not a wire. Returns null for
// bright/day palettes (milkyWay === false).
export function generateMilkyWay(radius, palette, rng) {
  if (!palette.milkyWay) return null;
  const shell = radius * 0.82;
  const bandCount = Math.round((palette.starCount || 1400) * 1.1);
  const position = new Float32Array(bandCount * 3);
  const brightness = new Float32Array(bandCount);
  const phase = new Float32Array(bandCount);
  const speed = new Float32Array(bandCount);
  const size = new Float32Array(bandCount);
  const tilt = 0.5 + rng() * 0.5;            // radians, band tilt across the sky
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
  for (let i = 0; i < bandCount; i++) {
    const a = rng() * Math.PI * 2;
    // Off-plane gaussian-ish spread (sum of uniforms) → denser core, soft edges.
    const off = ((rng() + rng() + rng()) / 3 * 2 - 1) * 0.16;
    let x = Math.cos(a), y = off, z = Math.sin(a);
    const len = Math.hypot(x, y, z); x /= len; y /= len; z /= len;
    // Tilt the plane about the X axis.
    const ty = y * cosT - z * sinT, tz = y * sinT + z * cosT;
    position[i*3] = x * shell; position[i*3+1] = ty * shell; position[i*3+2] = tz * shell;
    brightness[i] = 0.35 + rng() * 0.5;       // dimmer than foreground stars
    phase[i] = rng() * Math.PI * 2;
    speed[i] = 0.3 + rng() * 1.0;             // gentler twinkle
    size[i] = (palette.starSize || 2) * (0.4 + rng() * 0.6);
    void x;
  }
  return { bandCount, position, brightness, phase, speed, size, tilt };
}

const PLANET_COLORS = ['#b07a55', '#7d8aa0', '#c9a06a', '#6a8f7d', '#9a6b8c', '#5f7bbf'];

// Extra moons + distant/near planets + the near planet's companion moons. Each body is a
// plain descriptor (type, world position on its own radius, size, color, flags) the TSL
// celestial-bodies module turns into a sprite. Night/dusk only (caller gates on palette).
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

  // 1-2 extra moons.
  const moonN = 1 + ((rng() * 2) | 0);
  for (let i = 0; i < moonN; i++) {
    const r = radius * (0.7 + rng() * 0.08);
    out.push({ type: 'moon', companion: false, position: place(dir(), r), radius: r,
      size: radius * (0.018 + rng() * 0.02), color: '#d7dcea', phase: rng() });
  }
  // 2-4 small distant planets.
  const distN = 2 + ((rng() * 3) | 0);
  for (let i = 0; i < distN; i++) {
    const r = radius * (0.72 + rng() * 0.06);
    out.push({ type: 'planet', scaleClass: 'distant', position: place(dir(), r), radius: r,
      size: radius * (0.01 + rng() * 0.015), color: pick(PLANET_COLORS),
      gas: rng() < 0.5, rings: false, glow: rng() < 0.3 });
  }
  // Exactly one large near planet.
  const nearDir = dir();
  const nearR = radius * 0.6;
  const nearSize = radius * (0.06 + rng() * 0.04);
  const near = { type: 'planet', scaleClass: 'near', position: place(nearDir, nearR), radius: nearR,
    size: nearSize, color: pick(PLANET_COLORS), gas: rng() < 0.6, rings: rng() < 0.4, glow: true };
  out.push(near);
  // 1-3 companion moons orbiting the near planet (offset around its screen position).
  const compN = 1 + ((rng() * 3) | 0);
  for (let i = 0; i < compN; i++) {
    const d = { x: nearDir.x + (rng() * 2 - 1) * 0.06, y: nearDir.y + (rng() * 2 - 1) * 0.06,
      z: nearDir.z + (rng() * 2 - 1) * 0.06 };
    out.push({ type: 'moon', companion: true, position: place(d, nearR), radius: nearR,
      size: nearSize * (0.12 + rng() * 0.1), color: '#cdd3e0', phase: rng() });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-sky-field.mjs`
Expected: PASS — `all passed`.

- [ ] **Step 5: Commit**

```bash
git add sky-field.js test-sky-field.mjs
git commit -m "SP6: Milky-Way band + celestial-body generation + tests"
```

---

## Task 4: Stars + Milky Way TSL rendering module

**Files:**
- Create: `stars.js`

This module has no Node test (it builds GPU node materials — verified by running the viewer). Build it in one focused step, then sanity-check it imports.

- [ ] **Step 1: Write `stars.js`**

```js
// stars.js
// TSL rendering of the star field + Milky Way for the WebGPU sky. Geometry/attributes
// come from sky-field.js (pure, Node-tested); this file only builds node materials.
// Twinkle runs entirely on the GPU via the built-in `time` node — no per-frame JS.
import * as THREE from 'three';
import { PointsNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu';
import { Fn, attribute, uniform, float, vec3, vec4, sin, length, smoothstep, mix,
  positionLocal, normalize, uv, max, dot, time } from 'three/tsl';

// Shared builder: a Points cloud with per-star twinkle attributes → GPU-animated size +
// brightness, soft round sprites. `data` is a generateStars()/generateMilkyWay() result.
function buildPoints(data, { color, opacity, twinkle, renderOrder }) {
  const count = data.count ?? data.bandCount;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
  geom.setAttribute('aBright', new THREE.BufferAttribute(data.brightness, 1));
  geom.setAttribute('aPhase',  new THREE.BufferAttribute(data.phase, 1));
  geom.setAttribute('aSpeed',  new THREE.BufferAttribute(data.speed, 1));
  geom.setAttribute('aSize',   new THREE.BufferAttribute(data.size, 1));
  // strength is foreground-only; default to a constant for the band.
  const strengthArr = data.strength || new Float32Array(count).fill(twinkle);
  geom.setAttribute('aStrength', new THREE.BufferAttribute(strengthArr, 1));

  const mat = new PointsNodeMaterial({ transparent: true, depthWrite: false });
  mat.fog = false;
  mat.sizeAttenuation = false;   // fixed screen-space size at huge sky radius
  const uColor = uniform(new THREE.Color(color));
  const uOpacity = uniform(opacity);

  // twinkle factor in ~[1-strength, 1+strength]
  const tw = float(1).add(attribute('aStrength').mul(sin(time.mul(attribute('aSpeed')).add(attribute('aPhase')))));
  mat.sizeNode = attribute('aSize').mul(tw.max(0.2));
  // Soft round point: radial falloff across the point sprite UV; modulated by brightness+twinkle.
  const d = length(uv().sub(0.5));
  const soft = smoothstep(0.5, 0.1, d);
  mat.colorNode = vec4(uColor.mul(attribute('aBright')), soft.mul(attribute('aBright')).mul(tw).mul(uOpacity));

  const pts = new THREE.Points(geom, mat);
  pts.frustumCulled = false;
  pts.renderOrder = renderOrder;
  pts.material._uColor = uColor;
  pts.material._uOpacity = uOpacity;
  return pts;
}

// Foreground sky stars (strong twinkle).
export function createSkyStars(starData, palette) {
  return buildPoints(starData, {
    color: palette.starColor, opacity: palette.starOpacity, twinkle: 0.3, renderOrder: -995,
  });
}

// Milky Way: a dim back-side gas sphere (layered noise) + the dense band points.
export function createMilkyWay(milkyData, palette) {
  if (!milkyData) return null;
  const group = new THREE.Group();
  const radius = Math.hypot(milkyData.position[0], milkyData.position[1], milkyData.position[2]) / 0.82;

  // ---- Gas inner sphere ----
  const gas = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false,
    side: THREE.BackSide, blending: THREE.AdditiveBlending });
  gas.fog = false;
  const uIntensity = uniform(palette.milkyWayIntensity);
  const uTilt = uniform(milkyData.tilt);
  const warm = new THREE.Color('#5a4636'), cool = new THREE.Color('#2c3a5a');
  // value-noise hash → smooth 3D noise (compact, GPU-cheap; enough for soft gas)
  const hash = Fn(([p]) => fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))).mul(43758.5453)));
  const noise3 = Fn(([p]) => {
    const i = floor(p), f = fract(p);
    const u = f.mul(f).mul(float(3).sub(f.mul(2)));
    const n000 = hash(i.add(vec3(0,0,0))), n100 = hash(i.add(vec3(1,0,0)));
    const n010 = hash(i.add(vec3(0,1,0))), n110 = hash(i.add(vec3(1,1,0)));
    const n001 = hash(i.add(vec3(0,0,1))), n101 = hash(i.add(vec3(1,0,1)));
    const n011 = hash(i.add(vec3(0,1,1))), n111 = hash(i.add(vec3(1,1,1)));
    const x00 = mix(n000, n100, u.x), x10 = mix(n010, n110, u.x);
    const x01 = mix(n001, n101, u.x), x11 = mix(n011, n111, u.x);
    return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
  });
  gas.colorNode = Fn(() => {
    const dir = normalize(positionLocal);
    // distance from the tilted galactic plane (band about X axis tilted by uTilt)
    const plane = dir.y.mul(cos(uTilt)).sub(dir.z.mul(sin(uTilt)));
    const band = smoothstep(0.35, 0.0, abs(plane));
    const p = dir.mul(2.5);
    let n = noise3(p).mul(0.6).add(noise3(p.mul(2.1)).mul(0.3)).add(noise3(p.mul(4.3)).mul(0.1));
    const dust = smoothstep(0.0, 0.08, abs(plane.add(n.mul(0.05).sub(0.025)))); // dark central lane
    const col = mix(vec3(cool.r, cool.g, cool.b), vec3(warm.r, warm.g, warm.b), n);
    return col.mul(band).mul(n).mul(dust).mul(uIntensity);
  })();
  gas.opacityNode = float(1);
  const gasMesh = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.995, 40, 18), gas);
  gasMesh.renderOrder = -997; gasMesh.frustumCulled = false;
  gasMesh.material._uIntensity = uIntensity;

  // ---- Band points ----
  const band = buildPoints(milkyData, {
    color: palette.starColor, opacity: 0.9, twinkle: 0.15, renderOrder: -996,
  });

  group.add(gasMesh, band);
  group.userData.gas = gasMesh;
  return group;
}
```

> Note: this file also needs `fract, floor, cos, abs` from `three/tsl` — add them to the import. (They are confirmed present in 0.184.) Final import line:
> `import { Fn, attribute, uniform, float, vec3, vec4, sin, cos, floor, fract, abs, length, smoothstep, mix, positionLocal, normalize, uv, max, dot, time } from 'three/tsl';`

- [ ] **Step 2: Sanity-check it parses under Node** (imports resolve; node materials construct)

Run:
```bash
node -e "import('./stars.js').then(m=>console.log('exports:', Object.keys(m).join(',')||'(none)')).catch(e=>{console.error('LOAD FAIL', e.message); process.exit(1)})"
```
Expected: `exports: createSkyStars,createMilkyWay` (no throw). If it throws on a missing TSL name, add that name to the import line and re-run.

- [ ] **Step 3: Commit**

```bash
git add stars.js
git commit -m "SP6: TSL star-field + Milky-Way rendering module (GPU twinkle)"
```

---

## Task 5: Celestial-bodies TSL module (extra moons/planets)

**Files:**
- Create: `celestial-bodies.js`

- [ ] **Step 1: Write `celestial-bodies.js`**

```js
// celestial-bodies.js
// TSL rendering of extra moons + distant/near planets as camera-following sprites.
// Body descriptors come from sky-field.js generateCelestialBodies(); this file owns the
// canvas painters and sprite assembly. Canvas textures are flagged for disposal.
import * as THREE from 'three';
import { SpriteNodeMaterial } from 'three/webgpu';

function markTex(tex) {
  tex.userData.proceduralSkyTexture = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// A soft shaded sphere (moon/rocky planet) with optional bands/rings/glow.
function paintBody(body) {
  const S = 256;
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const cx = S / 2, cy = S / 2, R = S * 0.32;
  // atmospheric glow
  if (body.glow) {
    const gl = g.createRadialGradient(cx, cy, R * 0.8, cx, cy, R * 1.9);
    gl.addColorStop(0, hexA(body.color, 0.5)); gl.addColorStop(1, hexA(body.color, 0));
    g.fillStyle = gl; g.fillRect(0, 0, S, S);
  }
  // body disc with lit upper-left
  const sh = g.createRadialGradient(cx - R * 0.4, cy - R * 0.4, R * 0.1, cx, cy, R);
  sh.addColorStop(0, lighten(body.color, 0.35));
  sh.addColorStop(0.7, body.color);
  sh.addColorStop(1, darken(body.color, 0.55));
  g.fillStyle = sh;
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
  // surface detail
  g.save(); g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();
  if (body.gas) {
    for (let i = 0; i < 6; i++) {
      const y = cy - R + (i + 0.5) * (2 * R / 6);
      g.fillStyle = (i % 2 ? lighten(body.color, 0.12) : darken(body.color, 0.18));
      g.fillRect(cx - R, y - R / 8, 2 * R, R / 4);
    }
    g.fillStyle = darken(body.color, 0.3);
    g.beginPath(); g.ellipse(cx + R * 0.3, cy + R * 0.2, R * 0.18, R * 0.1, 0, 0, Math.PI * 2); g.fill();
  } else {
    for (let i = 0; i < 7; i++) {
      const a = Math.random() * Math.PI * 2, rr = Math.random() * R * 0.8;
      g.fillStyle = darken(body.color, 0.2 + Math.random() * 0.2);
      g.beginPath(); g.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, R * (0.06 + Math.random() * 0.12), 0, Math.PI * 2); g.fill();
    }
  }
  g.restore();
  // limb darkening
  const ld = g.createRadialGradient(cx, cy, R * 0.6, cx, cy, R);
  ld.addColorStop(0, 'rgba(0,0,0,0)'); ld.addColorStop(1, 'rgba(0,0,0,0.45)');
  g.fillStyle = ld; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
  // rings
  if (body.rings) {
    g.save(); g.translate(cx, cy); g.rotate(-0.5); g.scale(1, 0.32);
    g.strokeStyle = hexA(lighten(body.color, 0.3), 0.7); g.lineWidth = S * 0.03;
    g.beginPath(); g.arc(0, 0, R * 1.5, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = hexA(body.color, 0.5); g.lineWidth = S * 0.015;
    g.beginPath(); g.arc(0, 0, R * 1.75, 0, Math.PI * 2); g.stroke();
    g.restore();
  }
  return markTex(new THREE.CanvasTexture(cv));
}

export function createCelestialBodies(bodyData) {
  const group = new THREE.Group();
  for (const body of bodyData) {
    const tex = paintBody(body);
    const mat = new SpriteNodeMaterial({ map: tex, transparent: true, depthWrite: false });
    mat.fog = false;
    const spr = new THREE.Sprite(mat);
    spr.position.set(body.position.x, body.position.y, body.position.z);
    const s = body.size * (body.rings ? 4 : body.glow ? 3 : 2.4);
    spr.scale.set(s, s, 1);
    spr.renderOrder = -996;
    group.add(spr);
  }
  return group;
}

// ---- small color helpers (hex string → adjusted rgba) ----
function parse(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function clamp8(v) { return Math.max(0, Math.min(255, v | 0)); }
function lighten(hex, t) { const [r, g, b] = parse(hex); return `rgb(${clamp8(r + (255 - r) * t)},${clamp8(g + (255 - g) * t)},${clamp8(b + (255 - b) * t)})`; }
function darken(hex, t) { const [r, g, b] = parse(hex); return `rgb(${clamp8(r * (1 - t))},${clamp8(g * (1 - t))},${clamp8(b * (1 - t))})`; }
function hexA(color, a) {
  if (color.startsWith('rgb')) return color.replace('rgb(', 'rgba(').replace(')', `,${a})`);
  const [r, g, b] = parse(color); return `rgba(${r},${g},${b},${a})`;
}
```

- [ ] **Step 2: Sanity-check exports resolve** (no DOM call at import time)

Run:
```bash
node -e "import('./celestial-bodies.js').then(m=>console.log('exports:', Object.keys(m).join(','))).catch(e=>{console.error('LOAD FAIL', e.message); process.exit(1)})"
```
Expected: `exports: createCelestialBodies` (no throw — `document` is only touched when the function runs, not at import).

- [ ] **Step 3: Commit**

```bash
git add celestial-bodies.js
git commit -m "SP6: TSL celestial-bodies module (extra moons/planets, canvas painters)"
```

---

## Task 6: Sky owner module — dome + primary sun/moon + lifecycle

**Files:**
- Create: `sky.js`

- [ ] **Step 1: Write `sky.js`**

```js
// sky.js
// Owner module for the WebGPU procedural sky: a camera-following group holding a gradient
// sky dome, the primary sun/moon sprite (locked to the scene light direction), and the
// composed star field + Milky Way + extra celestial bodies. Pure math is in sky-field.js;
// this file builds node materials + canvas textures and manages the lifecycle.
import * as THREE from 'three';
import { MeshBasicNodeMaterial, SpriteNodeMaterial } from 'three/webgpu';
import { Fn, uniform, float, vec3, vec4, mix, smoothstep, positionLocal, normalize, pow, max } from 'three/tsl';
import { makePalette, skyRadius, isMoonBody, sunSpritePlacement, makeRng,
  generateStars, generateMilkyWay, generateCelestialBodies } from './sky-field.js';
import { createSkyStars, createMilkyWay } from './stars.js';
import { createCelestialBodies } from './celestial-bodies.js';

const _c = hex => new THREE.Color(hex);
const v3 = c => vec3(c.r, c.g, c.b);

// Gradient dome: bottom→horizon→top by view-direction Y, plus a horizon glow band.
function makeSkyDomeMaterial(palette) {
  const mat = new MeshBasicNodeMaterial({ side: THREE.BackSide, depthTest: false, depthWrite: false });
  mat.fog = false;
  const top = _c(palette.top), hor = _c(palette.horizon), bot = _c(palette.bottom), glow = _c(palette.glow);
  mat.colorNode = Fn(() => {
    const y = normalize(positionLocal).y;                       // -1 .. 1
    const upper = smoothstep(0.0, 0.5, y);                      // horizon → zenith
    const lower = smoothstep(-0.25, 0.0, y);                    // nadir → horizon
    const base = mix(v3(bot), mix(v3(hor), v3(top), upper), lower);
    const glowBand = pow(max(float(1).sub(y.abs().mul(6.0)), float(0)), float(2.0)); // tight band at y≈0
    return mix(base, v3(glow), glowBand.mul(0.6));
  })();
  return mat;
}

// 256² sun (warm disc + corona) or 512² moon (glow + shaded sphere + maria).
function makeSkySunTexture(color, { moon }) {
  const S = moon ? 512 : 256;
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const cx = S / 2, cy = S / 2;
  if (moon) {
    const R = S * 0.3;
    const glow = g.createRadialGradient(cx, cy, R, cx, cy, R * 1.7);
    glow.addColorStop(0, hexA(color, 0.4)); glow.addColorStop(1, hexA(color, 0));
    g.fillStyle = glow; g.fillRect(0, 0, S, S);
    const sh = g.createRadialGradient(cx - R * 0.35, cy - R * 0.35, R * 0.1, cx, cy, R);
    sh.addColorStop(0, lighten(color, 0.4)); sh.addColorStop(0.75, color); sh.addColorStop(1, darken(color, 0.5));
    g.fillStyle = sh; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
    g.save(); g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2, rr = Math.random() * R * 0.7;
      g.fillStyle = hexA(darken(color, 0.25), 0.5);
      g.beginPath(); g.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, R * (0.08 + Math.random() * 0.16), 0, Math.PI * 2); g.fill();
    }
    g.restore();
    const ld = g.createRadialGradient(cx, cy, R * 0.6, cx, cy, R);
    ld.addColorStop(0, 'rgba(0,0,0,0)'); ld.addColorStop(1, 'rgba(0,0,0,0.4)');
    g.fillStyle = ld; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
  } else {
    const R = S * 0.22;
    const cor = g.createRadialGradient(cx, cy, R * 0.5, cx, cy, R * 2.2);
    cor.addColorStop(0, hexA(color, 0.9)); cor.addColorStop(0.4, hexA(color, 0.25)); cor.addColorStop(1, hexA(color, 0));
    g.fillStyle = cor; g.fillRect(0, 0, S, S);
    const disc = g.createRadialGradient(cx - R * 0.2, cy - R * 0.2, R * 0.1, cx, cy, R);
    disc.addColorStop(0, '#ffffff'); disc.addColorStop(0.5, color); disc.addColorStop(1, hexA(color, 0.85));
    g.fillStyle = disc; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.userData.proceduralSkyTexture = true; tex.colorSpace = THREE.SRGBColorSpace; tex.needsUpdate = true;
  return tex;
}

export function createSky({ scene, camera, size, palette: overrides, sunDir }) {
  let palette = makePalette(overrides);
  const group = new THREE.Group();
  group.userData.followCamera = true;
  let radius = skyRadius(camera.far, size);
  let dir = (sunDir || new THREE.Vector3(0.6, 0.55, 0.58)).clone().normalize();

  let dome, sun, sunTex, stars, milky, bodies;

  function build() {
    // dome
    dome = new THREE.Mesh(new THREE.SphereGeometry(radius, 40, 18), makeSkyDomeMaterial(palette));
    dome.renderOrder = -1000; dome.frustumCulled = false;
    group.add(dome);
    // primary sun/moon
    const moon = isMoonBody(palette);
    sunTex = makeSkySunTexture(moon ? palette.moonColor : palette.sun, { moon });
    const sm = new SpriteNodeMaterial({ map: sunTex, transparent: true, depthWrite: false }); sm.fog = false;
    sun = new THREE.Sprite(sm); sun.renderOrder = -996;
    group.add(sun);
    placeSun();
    // stars
    const rng = makeRng((palette.starCount | 0) ^ 0x5a17);
    stars = createSkyStars(generateStars(radius, palette, rng), palette);
    group.add(stars);
    // milky way
    milky = createMilkyWay(generateMilkyWay(radius, palette, makeRng(0xb1a5)), palette);
    if (milky) group.add(milky);
    // celestial bodies (night/dusk only — gate on milkyWay flag as the night marker)
    if (palette.milkyWay) {
      bodies = createCelestialBodies(generateCelestialBodies(radius, palette, makeRng(0xc0de)));
      group.add(bodies);
    }
    if (scene) scene.background = _c(palette.bottom);
  }

  function placeSun() {
    const p = sunSpritePlacement([dir.x, dir.y, dir.z], radius, palette);
    sun.position.set(p.position.x, p.position.y, p.position.z);
    sun.scale.set(p.scale, p.scale, 1);
  }

  function disposeChildren() {
    group.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      const mat = o.material;
      if (mat) {
        if (mat.map && mat.map.userData?.proceduralSkyTexture) mat.map.dispose();
        mat.dispose();
      }
    });
    group.clear();
    if (sunTex) sunTex.dispose();
  }

  build();

  return {
    group,
    setSunDir(v) { dir.copy(v).normalize(); if (sun) placeSun(); },
    setPalette(o) { palette = makePalette(o); rebuild(radius); },
    setCelestialType(type) { palette.celestialType = type; rebuild(radius); },
    rebuild(r) { radius = r ?? skyRadius(camera.far, size); disposeChildren(); build(); },
    update(/* seconds */) { /* twinkle/gas animate on the GPU via the `time` node */ },
    dispose() { disposeChildren(); group.removeFromParent(); },
    get radius() { return radius; },
    get isMoon() { return isMoonBody(palette); },
  };
}

function parse(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function c8(v) { return Math.max(0, Math.min(255, v | 0)); }
function lighten(hex, t) { const [r, g, b] = parse(hex); return `rgb(${c8(r + (255 - r) * t)},${c8(g + (255 - g) * t)},${c8(b + (255 - b) * t)})`; }
function darken(hex, t) { const [r, g, b] = parse(hex); return `rgb(${c8(r * (1 - t))},${c8(g * (1 - t))},${c8(b * (1 - t))})`; }
function hexA(color, a) { if (color.startsWith('rgb')) return color.replace('rgb(', 'rgba(').replace(')', `,${a})`); const [r, g, b] = parse(color); return `rgba(${r},${g},${b},${a})`; }
```

- [ ] **Step 2: Sanity-check exports resolve**

Run:
```bash
node -e "import('./sky.js').then(m=>console.log('exports:', Object.keys(m).join(','))).catch(e=>{console.error('LOAD FAIL', e.message); process.exit(1)})"
```
Expected: `exports: createSky` (no throw). Fix any missing TSL import name reported.

- [ ] **Step 3: Commit**

```bash
git add sky.js
git commit -m "SP6: sky owner module — TSL dome + sun/moon sprite + lifecycle"
```

---

## Task 7: Wire sky into the viewer (group, light coupling, animate)

**Files:**
- Modify: `environment-viewer.html`

- [ ] **Step 1: Add the moon light** — after the rig shadow setup block (`environment-viewer.html:79`, the line `rig.dirLight.shadow.camera.top = 90; ... = -90;`), insert:

```js
// Dedicated cool moonlight, swapped in when the primary sky body is the Moon. Lives in the
// scene (NOT the camera-following sky group), tracks the rig direction, starts disabled.
const moonLight = new THREE.DirectionalLight(0xaec6ff, 0.0);
moonLight.castShadow = true;
moonLight.shadow.mapSize.set(2048, 2048);
moonLight.shadow.camera.near = 1; moonLight.shadow.camera.far = 260;
moonLight.shadow.camera.left = -90; moonLight.shadow.camera.right = 90;
moonLight.shadow.camera.top = 90; moonLight.shadow.camera.bottom = -90;
scene.add(moonLight, moonLight.target);
```

- [ ] **Step 2: Build the sky** — find the clouds dynamic-import block (`environment-viewer.html:1243`, `import('./clouds.js').then(...)`). Immediately BEFORE it, add:

```js
// ---- procedural night sky (dome + stars + Milky Way + moon/sun + planets) ----
let skyRef = null;
const SKY_PARAMS = { primaryBody: 'sun', starCount: 1400, starSize: 2.2, sunSize: 0.06,
  milkyWayIntensity: 0.7 };
function toLightDir() {            // same direction the rig feeds water + shadows
  const a = rig.azimuth * Math.PI / 180, e = rig.elevation * Math.PI / 180;
  return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
}
function applyCelestialLight() {   // swap warm sun <-> cool moon as the key light
  const moon = SKY_PARAMS.primaryBody === 'moon';
  rig.setSunIntensity(moon ? 0.15 : (rigP.sunIntensity || 1.8));
  moonLight.intensity = moon ? 0.35 : 0.0;
}
import('./sky.js').then(({ createSky }) => {
  skyRef = createSky({ scene, camera, size: terrain.size, sunDir: toLightDir(),
    palette: { celestialType: SKY_PARAMS.primaryBody, starCount: SKY_PARAMS.starCount,
      starSize: SKY_PARAMS.starSize, sunSize: SKY_PARAMS.sunSize,
      milkyWayIntensity: SKY_PARAMS.milkyWayIntensity } });
  scene.add(skyRef.group);
  applyCelestialLight();
}).catch(err => { console.warn('sky module failed:', err); });   // sky is optional
```

- [ ] **Step 3: Drive the sky per frame** — in `animate()` (`environment-viewer.html:1553`), right after `const now = performance.now();`, add:

```js
  if (skyRef) {
    if (skyRef.group.userData.followCamera) skyRef.group.position.copy(camera.position);
    const d = toLightDir();
    skyRef.setSunDir(d);
    moonLight.position.copy(camera.position).addScaledVector(d, 120);
    moonLight.target.position.copy(camera.position);
    moonLight.target.updateMatrixWorld(); moonLight.updateMatrixWorld();
    skyRef.update(now / 1000);
  }
```

- [ ] **Step 4: Rebuild sky on view-distance change** — find the View-distance handler that sets `camera.far` (`environment-viewer.html:305`, `camera.far = far; camera.updateProjectionMatrix();`). Immediately after that line, add:

```js
  if (skyRef) skyRef.rebuild();
```

- [ ] **Step 5: Verify it loads + renders** — open `environment-viewer.html` in a WebGPU browser (Chrome/Edge). 

Expected: the viewport shows a dark gradient sky with a glowing horizon, a star field, the Milky Way band, a warm **sun disc sitting exactly where the bright spot in the water reflection points**, and a few planets/moons. Dragging the **Azimuth/Elevation** lighting sliders moves the sun disc, the shadows, AND the water highlight together. The `#info` bar shows no `⚠` error.

If the page is blank, read the `#info` bar / devtools console; the most likely causes are a missing TSL import name (add it) or a node-material property typo. Fix and reload.

- [ ] **Step 6: Commit**

```bash
git add environment-viewer.html
git commit -m "SP6: wire night sky into viewer — group, moon light, camera-follow + sun-dir coupling"
```

---

## Task 8: "SKY" control-panel section + Sun/Moon toggle

**Files:**
- Modify: `environment-viewer.html`

- [ ] **Step 1: Add the panel section** — find the clouds panel sliders (the block ending around `environment-viewer.html:1263`, the `cloudSpeed` slider inside the clouds `import().then`). After the clouds block's sliders — but using the same `slider`/`select` helpers already in scope — add a SKY section. Place this right after the `import('./sky.js').then(...)` block from Task 7 Step 2:

```js
// ---- SKY control-panel section ----
if (typeof section === 'function') section('Sky');
select('primaryBody', 'Primary body', ['sun', 'moon'], () => {
  if (!skyRef) return;
  skyRef.setCelestialType(SKY_PARAMS.primaryBody);
  applyCelestialLight();
}, SKY_PARAMS);
slider('starCount', 'Star count', 200, 3000, 50, fi,
  () => skyRef && skyRef.setPalette(skyPaletteOverrides()), SKY_PARAMS);
slider('starSize', 'Star size', 0.5, 5, 0.1, f2,
  () => skyRef && skyRef.setPalette(skyPaletteOverrides()), SKY_PARAMS);
slider('sunSize', 'Body size', 0.02, 0.2, 0.005, f2,
  () => skyRef && skyRef.setPalette(skyPaletteOverrides()), SKY_PARAMS);
slider('milkyWayIntensity', 'Milky Way', 0, 1.5, 0.05, f2,
  () => skyRef && skyRef.setPalette(skyPaletteOverrides()), SKY_PARAMS);
function skyPaletteOverrides() {
  return { celestialType: SKY_PARAMS.primaryBody, starCount: SKY_PARAMS.starCount,
    starSize: SKY_PARAMS.starSize, sunSize: SKY_PARAMS.sunSize,
    milkyWayIntensity: SKY_PARAMS.milkyWayIntensity };
}
```

> The `select(...)` and `slider(...)` signatures and the `fi`/`f2` formatters are the ones already used at `environment-viewer.html:955`/`936` and the lighting/cloud sliders. `section('Sky')` is guarded with `typeof` in case the panel has no section helper; if there is none, the sliders simply append to the current panel. Verify the helper name by reading the existing panel code before editing (it may be `addSection`, `group`, or a header div) and use whatever exists; if nothing exists, drop the `section(...)` line.

- [ ] **Step 2: Verify the controls work** — reload `environment-viewer.html`:
  - Switch **Primary body → moon**: the disc becomes a larger pale moon, the scene cools/darkens (warm sun drops, cool moonlight rises), shadows persist.
  - **Star count / Star size / Body size / Milky Way** sliders visibly change the sky (the sky rebuilds on change).
  - No `⚠` in the info bar; no console errors.

- [ ] **Step 3: Commit**

```bash
git add environment-viewer.html
git commit -m "SP6: SKY control-panel section + Sun/Moon toggle"
```

---

## Task 9: Full-suite regression + final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the night-sky unit tests**

Run: `node test-sky-field.mjs`
Expected: `all passed`.

- [ ] **Step 2: Run the existing Node test suite to confirm no regressions** — the new modules don't touch terrain/grass/collision, but confirm nothing broke:

Run (PowerShell): `Get-ChildItem test-*.mjs | ForEach-Object { node $_.Name }`
Expected: each existing `test-*.mjs` ends with its pass line (no `FAIL`).

- [ ] **Step 3: Visual acceptance** — open `environment-viewer.html`, then verify against the spec's acceptance points:
  - sun disc aligns with the water-reflection highlight; moving Azimuth/Elevation moves both together;
  - stars twinkle without stutter; Milky Way band visible and tilted; planets/moons present;
  - Sun⇄Moon toggle swaps disc + lighting mood;
  - press **F** to walk (FPS mode): the sky stays infinitely distant (no parallax), follows the player.

- [ ] **Step 4: Final commit (notes/handoff if the repo tracks them)** — if `docs/superpowers/HANDOFF.md` exists, add a one-line SP6 entry; otherwise skip.

```bash
git add -A
git commit -m "SP6: night sky complete — verification pass"
```

---

## Self-Review Notes (addressed)

- **Spec coverage:** dome ✓ (T6), stars+clusters ✓ (T2/T4), Milky Way ✓ (T3/T4), primary sun/moon locked to light dir ✓ (T1/T6/T7), moon's own light ✓ (T7), extra moons/planets/rings/companions ✓ (T3/T5), camera-follow ✓ (T7), palette + UI ✓ (T8), render-order/depth table ✓ (materials in T4/T5/T6), disposal of flagged canvas textures ✓ (T6 `disposeChildren`), Node tests for pure helpers ✓ (T1–T3). GLB-skybox / multi-map presets intentionally omitted per spec.
- **Type consistency:** `generateStars` returns `{count, position, brightness, phase, speed, strength, size, clusterCount}` and `buildPoints` reads exactly those; `generateMilkyWay` returns `{bandCount, position, brightness, phase, speed, size, tilt}` (no `strength` → `buildPoints` synthesizes it). `sunSpritePlacement` returns `{position, scale, isMoon}`, consumed in `placeSun`. `createSky` API (`setSunDir/setPalette/setCelestialType/rebuild/update/dispose/group`) matches all viewer call sites in T7/T8.
- **Known runtime risks called out inline:** (a) point-sprite `uv()` round falloff depends on WebGPU point UVs — visually verified in T7/T8, fall back to plain points if flat; (b) exact panel `section`/formatter helper names must be confirmed against the existing panel before editing (noted in T8 Step 1).
