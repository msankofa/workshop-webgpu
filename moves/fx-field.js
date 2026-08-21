/**
 * fx-field.js — the arena-wide status effects: the four Room moves, Gravity, Rain Dance, Sunny Day,
 * Sandstorm, Hail, and the four Terrains. Every other effect in this set travels from a caster to a
 * target and resolves; this one covers the ground the fight is standing on and stays there. It is built
 * for `hold: true` moves — the harness parks the phase machine in IMPACT until something releases it,
 * and a long or indefinite hold has to look exactly as good at second 2 as at second 200.
 *
 * SHAPE. Three static meshes anchored at the arena's centre, not at either creature (`line.origin`/
 * `line.target` are unused for placement — only `line.length` is read, harmlessly, by the phase machine
 * itself; see the cast() comment):
 *   - SHEET — one large horizontal plane covering the arena floor, subdivided so a per-vertex arrival
 *     lift is possible, coloured entirely in the fragment stage.
 *   - EDGE — a thin glowing ring built from `buildRing` (move-parts.js), so the field reads as a bounded
 *     area rather than a colour that fades into nothing. Present for every palette.
 *   - WALL — a taller vertical extrude on the same ring, built only for palettes whose brief calls for
 *     walls (`warp`, `sand`). This is what turns the flat sheet into "a room" for Trick/Magic/Wonder Room,
 *     and into a blowing dust curtain at the arena's edge for Sandstorm.
 * A handful of palettes add a particle layer on top (rain streaks, blowing grit, drifting light shafts,
 * falling hail) — see PARTICLES below. Following Aurora's approach, every mesh's geometry is built once
 * at cast and never touched again; all motion lives in `positionNode` (arrival lift, wall turbulence) and
 * `colorNode` (every ground pattern) over that static grid.
 *
 * ENVELOPE. One scalar, `env`, replaces Aurora's separate grown/fade tracking because a field has no
 * travelling front to sweep — the whole arena arrives at once. `env` ramps 0→1 during TRAVEL (arrival),
 * pins at 1 for the entire IMPACT phase no matter how long it holds (nothing here accumulates with time,
 * so a `maxHold` of 5s or 500s renders identically), and ramps 1→0 during FADE (the lift). Every opacity,
 * light intensity and emission rate multiplies by `env`, so "does it look right sitting there" reduces to
 * "is env pinned at 1", which it provably is.
 *
 * GRID LINES, ONE FORMULA. `thinLines(coord, freq, width)` is a single thin-line-at-integer-boundaries
 * mask (distance to the nearest boundary, thresholded). It draws the warp room's floor and wall lattice,
 * the circuit terrain's grid, and — repurposed with a radial coordinate instead of a Cartesian one — the
 * concentric rings for `gravity` (pressing inward) and `rain` (rippling outward). One helper, four looks.
 *
 * GRAZING-ANGLE FIX. A large additive sheet with depth writing off streaks and blows out when the camera
 * looks nearly along it, because grazing rays cross far more of the (constant-thickness-in-screen-space)
 * translucent surface than rays that hit it face-on. Two things avoid that here: the sheet itself uses
 * plain alpha (`NormalBlending`), which does not compound the way additive does at glancing angles, and
 * its opacity is additionally scaled by `dot(normalWorld, viewDir)` so it fades out entirely as the view
 * angle goes edge-on instead of flaring. Additive is kept only for the EDGE/WALL meshes and particles,
 * which are vertical or camera-facing and do not present this problem the way a horizontal floor does.
 *
 * WEATHER PARTICLE BUDGET. Every particle-bearing palette names a hard cap below and never exceeds it —
 * power scales emission *rate*, not the cap, exactly like fx-cloud. One live cast, worst case: rain 480
 * streak sprites, sand 360 grit sprites, sun 60 light-shaft sprites, misty terrain 260 fog sprites, hail
 * 240 falling stones (a hand-rolled instanced pool, see HAIL below). No two field moves are meant to be
 * held at once in practice (the harness's `releaseHeld` retires the previous cast of the same move name
 * before a new one starts), so this module does not try to cap the *sum* across simultaneous casts.
 *
 * HAIL is the one part with no shared home. `createDebrisPool` (move-parts.js part 8) looks like the
 * right tool — instanced rigid chips with gravity and a bounce — but its bounce floor is pinned four
 * centimetres below each chip's *spawn* height (`gy[i] = y - 0.04`), because it was built for chips
 * erupting up from a breach and falling back to the ground they came from, not stones falling from a
 * height and bouncing on the ground below them. Reusing it for hail would either drop stones with no
 * fall or bounce them near the sky. `createHailPool` below is a deliberately small, single-purpose copy
 * of the same instanced-matrix technique with the one physics difference hail actually needs: a real
 * ground height passed in at emit time, and a bounce flag so the *second* contact settles instead of
 * bouncing again — "bounce once" as the brief asks for, not damped-forever.
 *
 * LIGHTS. Only `warp` (violet, 2 lights breathing around the room) and `sun` (one warm overhead-ish
 * light) acquire from the shared pool — every other palette is either colourless (`gravity`) or reads
 * fine from its ground pattern and particles alone. That is at most 2 of the pool's 6 lights per field
 * cast, and 0 for seven of the ten palettes.
 *
 * Palettes: warp (Trick/Magic/Wonder Room), gravity (Gravity), rain (Rain Dance), sun (Sunny Day), sand
 * (Sandstorm), hail (Hail), terrainElectric/terrainGrassy/terrainMisty/terrainPsychic (the four Terrains
 * — one ground-pattern function, `terrainPattern`, parameterised by look instead of four code paths).
 */

import { createPhaseMachine, mulberry32, saturate, createRateEmitter } from './move-core.js';
import { buildRing, createSpriteParticles } from './move-parts.js';

const TAU = Math.PI * 2;

export const PALETTES = {
  warp:            { kind: 'warp',    tint: 0x160a2a, glow: 0x9a5bff, wallHeight: 2.4, lightCount: 2, lightColor: 0xa06bff, lightIntensity: 2.2 },
  gravity:         { kind: 'gravity', tint: 0x2a2e35, glow: 0xc7ccd6, wallHeight: 0 },
  rain:            { kind: 'rain',    tint: 0x0c1620, glow: 0x6fa8c9, wallHeight: 0, dropA: 0xdff3ff, dropB: 0x3f7a9c },
  sun:             { kind: 'sun',     tint: 0x362609, glow: 0xffd27a, wallHeight: 0, shaftA: 0xfff3cf, shaftB: 0xffb04d, lightCount: 1, lightColor: 0xffb85c, lightIntensity: 1.7 },
  sand:            { kind: 'sand',    tint: 0x2c210d, glow: 0xd8b978, wallHeight: 1.3, gritA: 0xe8cf94, gritB: 0x8a6a35 },
  hail:            { kind: 'hail',    tint: 0x122029, glow: 0xbfe4ff, wallHeight: 0, stone: 0xdff4ff },
  terrainElectric: { kind: 'terrain', pattern: 'circuit', tint: 0x241f08, glow: 0xffe34d, wallHeight: 0 },
  terrainGrassy:   { kind: 'terrain', pattern: 'veins',   tint: 0x0e2210, glow: 0x74ff8f, wallHeight: 0 },
  terrainMisty:    { kind: 'terrain', pattern: 'mist',    tint: 0x241a26, glow: 0xffb8f0, wallHeight: 0, mistA: 0xffe3fb, mistB: 0xc98adf },
  terrainPsychic:  { kind: 'terrain', pattern: 'swirl',   tint: 0x1a0e34, glow: 0xd07bff, wallHeight: 0 },
};

const DEFAULTS = {
  radius: 8.5,        // the harness's ground is a CircleGeometry(9, 96) — this sits a half-metre in from its edge
  segments: 40,        // sheet plane subdivisions per side
  ringSegments: 64,     // edge/wall ring columns
  wallRows: 5,
  edgeWidth: 0.35,
  edgeFeather: 0.7,     // metres the sheet fades over at its rim
  grazeStart: 0.16,     // dot(normalWorld, viewDir) below which the sheet starts fading toward edge-on
  sinkDist: 0.4,        // metres the sheet/edge sink below ground at env=0
  flow: 1,
  brightness: 1,
  travelTime: 0.7,
  impactTime: 6,        // a sane standalone default; the harness overrides via machine.hold/maxHold
  fadeTime: 1.1,
  lightRange: 9,
  rainCap: 480, rainRate: 150,
  sandCap: 360, sandRate: 90,
  sunCap: 60, sunRate: 3,
  mistCap: 260, mistRate: 60,
  hailCap: 240, hailRate: 55,
};

/** Distance-to-nearest-integer-boundary line mask: 1 right at coord*freq crossing an integer, 0 past `width`. */
function thinLines(TSL, coord, freq, width) {
  const f = TSL.fract(coord.mul(freq));
  const d = TSL.min(f, f.oneMinus());
  return TSL.smoothstep(width, 0, d);
}

/** Same formula, radial: concentric rings at `distXZ * freq - T * speed` crossing an integer. */
function ringLines(TSL, distXZ, T, freq, speed, width) {
  const f = TSL.fract(distXZ.mul(freq).sub(T.mul(speed)));
  const d = TSL.min(f, f.oneMinus());
  return TSL.smoothstep(width, 0, d);
}

/** One ground-pattern function per palette kind; JS picks the shader graph, nothing branches at runtime. */
function fieldPattern(TSL, pal, pos, T) {
  const { abs, atan, mx_noise_float, sin, vec3 } = TSL;
  const distXZ = pos.xz.length();
  switch (pal.kind) {
    case 'warp': {
      const grid = thinLines(TSL, pos.x, 0.9, 0.05).max(thinLines(TSL, pos.z, 0.9, 0.05));
      return grid.mul(sin(T.mul(1.3).add(distXZ.mul(0.5))).mul(0.15).add(0.85));
    }
    case 'gravity':
      return ringLines(TSL, distXZ, T, 1.0, -1.6, 0.12); // negative speed: rings read as pressing inward
    case 'rain':
      return ringLines(TSL, distXZ, T, 0.85, 2.0, 0.1).mul(0.85);
    case 'sun':
      return mx_noise_float(vec3(pos.x.mul(0.3), pos.z.mul(0.3), T.mul(0.15))).mul(0.5).add(0.6);
    case 'sand':
      return mx_noise_float(vec3(pos.x.mul(0.5).add(T.mul(0.7)), pos.z.mul(0.5), 0)).mul(0.5).add(0.5);
    case 'hail':
      return abs(mx_noise_float(vec3(pos.x.mul(4), pos.z.mul(4), T.mul(0.35)))).pow(6);
    case 'terrain':
      return terrainPattern(TSL, pal.pattern, pos, T, distXZ);
    default:
      return sin(distXZ.sub(T)).mul(0.5).add(0.5);
  }
}

function terrainPattern(TSL, kind, pos, T, distXZ) {
  const { mx_noise_float, sin, atan, vec3 } = TSL;
  if (kind === 'circuit') {
    const grid = thinLines(TSL, pos.x, 1.4, 0.05).max(thinLines(TSL, pos.z, 1.4, 0.05));
    const pulse = sin(T.mul(2).sub(pos.x.add(pos.z).mul(0.7))).mul(0.5).add(0.5);
    return grid.mul(pulse.mul(0.6).add(0.4));
  }
  if (kind === 'veins') {
    const n = mx_noise_float(vec3(pos.x.mul(0.8), pos.z.mul(0.8), 0));
    const veins = TSL.abs(n).oneMinus().pow(10);
    return veins.mul(sin(T.mul(0.6).add(pos.x.mul(2))).mul(0.1).add(0.9));
  }
  if (kind === 'mist') {
    return mx_noise_float(vec3(pos.x.mul(0.35).add(T.mul(0.2)), pos.z.mul(0.35), T.mul(0.1))).mul(0.5).add(0.5);
  }
  // swirl (psychic): angle winds with radius and drifts with time.
  const ang = atan(pos.z, pos.x);
  return sin(ang.mul(5).add(distXZ.mul(1.6)).sub(T.mul(1.1))).mul(0.5).add(0.5);
}

/** The ground sheet: a big flat plane, coloured entirely in colorNode, lifted/sunk by env in positionNode. */
function buildSheetGeometry(THREE, R, segs) {
  return new THREE.PlaneGeometry(2 * R, 2 * R, segs, segs).rotateX(-Math.PI / 2);
}

function buildSheetMaterial(THREE, TSL, NODES, pal, o, R, u) {
  const { cameraPosition, dot, mix, normalWorld, positionLocal, positionWorld, smoothstep, time, vec3 } = TSL;
  const mat = new NODES.MeshBasicNodeMaterial();
  mat.transparent = true; mat.depthWrite = false; mat.side = THREE.DoubleSide; mat.toneMapped = false;
  mat.blending = THREE.NormalBlending; // additive would compound at grazing angles across a sheet this large

  const T = time.mul(u.uFlow);
  const distXZ = positionLocal.xz.length();
  const edge = smoothstep(R, R - o.edgeFeather, distXZ);
  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const graze = smoothstep(0, o.grazeStart, dot(normalWorld, viewDir).abs());

  const pattern = fieldPattern(TSL, pal, positionLocal, T);
  mat.colorNode = mix(vec3(u.uTint), vec3(u.uGlow), pattern).mul(u.uBright);
  mat.opacityNode = edge.mul(graze).mul(u.uEnv).mul(0.55);
  mat.positionNode = positionLocal.add(vec3(0, u.uLift, 0));
  return mat;
}

/** Thin glowing ring on the ground, from `buildRing`'s points — every palette gets an edge. */
function buildEdgeGeometry(THREE, ring, width) {
  const cols = ring.length;
  const pos = new Float32Array(cols * 2 * 3);
  const across = new Float32Array(cols * 2);
  const us = new Float32Array(cols * 2);
  const idx = [];
  for (let i = 0; i < cols; i++) {
    const p = ring[i];
    for (let k = 0; k < 2; k++) {
      const vi = i * 2 + k;
      const off = (k === 0 ? -1 : 1) * width * 0.5;
      pos[vi * 3] = p.x + p.sx * off; pos[vi * 3 + 1] = p.y; pos[vi * 3 + 2] = p.z + p.sz * off;
      across[vi] = k === 0 ? -1 : 1;
      us[vi] = p.u;
    }
  }
  for (let i = 0; i < cols - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aAcross', new THREE.BufferAttribute(across, 1));
  geo.setAttribute('aU', new THREE.BufferAttribute(us, 1));
  geo.setIndex(idx);
  return geo;
}

function buildEdgeMaterial(THREE, TSL, NODES, u) {
  const { abs, attribute, float, sin, time, vec3 } = TSL;
  const mat = new NODES.MeshBasicNodeMaterial();
  mat.transparent = true; mat.depthWrite = false; mat.side = THREE.DoubleSide; mat.blending = THREE.AdditiveBlending;
  mat.toneMapped = false;
  const aAcross = float(attribute('aAcross', 'float'));
  const aU = float(attribute('aU', 'float'));
  const T = time.mul(u.uFlow);
  const falloff = abs(aAcross).oneMinus().max(0).pow(1.6);
  const shimmer = sin(aU.mul(30).add(T.mul(1.4))).mul(0.25).add(0.75);
  mat.positionNode = TSL.positionLocal.add(vec3(0, u.uLift, 0));
  mat.colorNode = vec3(u.uGlow).mul(falloff).mul(shimmer).mul(u.uBright);
  mat.opacityNode = falloff.mul(u.uEnv).mul(0.9);
  return mat;
}

/** Vertical extrude on the same ring: warp's lattice room walls, sand's blowing dust curtain. */
function buildWallGeometry(THREE, ring, rows) {
  const cols = ring.length;
  const n = cols * rows;
  const pos = new Float32Array(n * 3), side = new Float32Array(n * 3), us = new Float32Array(n), vs = new Float32Array(n);
  const idx = [];
  for (let i = 0; i < cols; i++) {
    const p = ring[i];
    for (let r = 0; r < rows; r++) {
      const vi = i * rows + r;
      pos[vi * 3] = p.x; pos[vi * 3 + 1] = p.y; pos[vi * 3 + 2] = p.z; // height added in positionNode via aV
      side[vi * 3] = p.sx; side[vi * 3 + 1] = 0; side[vi * 3 + 2] = p.sz;
      us[vi] = p.u; vs[vi] = r / (rows - 1);
    }
  }
  for (let i = 0; i < cols - 1; i++) {
    for (let r = 0; r < rows - 1; r++) {
      const a = i * rows + r, b = (i + 1) * rows + r;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSide', new THREE.BufferAttribute(side, 3));
  geo.setAttribute('aU', new THREE.BufferAttribute(us, 1));
  geo.setAttribute('aV', new THREE.BufferAttribute(vs, 1));
  geo.setIndex(idx);
  return geo;
}

function buildWallMaterial(THREE, TSL, NODES, pal, o, u) {
  const { abs, attribute, float, mix, mx_noise_float, sin, smoothstep, time, vec3 } = TSL;
  const mat = new NODES.MeshBasicNodeMaterial();
  mat.transparent = true; mat.depthWrite = false; mat.side = THREE.DoubleSide; mat.blending = THREE.AdditiveBlending;
  mat.toneMapped = false;
  const aU = float(attribute('aU', 'float'));
  const aV = float(attribute('aV', 'float'));
  const aSide = vec3(attribute('aSide', 'vec3'));
  const T = time.mul(u.uFlow);

  const height = u.uWallHeight.mul(u.uEnv);
  const turbulence = pal.kind === 'sand'
    ? sin(aU.mul(40).add(T.mul(3))).mul(0.22).add(sin(aU.mul(11).sub(T.mul(1.7))).mul(0.4))
    : sin(aU.mul(22).add(T.mul(1.1))).mul(0.05);
  mat.positionNode = TSL.positionLocal.add(vec3(0, 1, 0).mul(aV.mul(height))).add(aSide.mul(turbulence).mul(aV));

  const pattern = pal.kind === 'warp'
    ? thinLines(TSL, aV, o.wallRows - 1, 0.08).max(thinLines(TSL, aU, o.ringSegments / 4, 0.08))
      .mul(sin(T.mul(1.3).add(aU.mul(6))).mul(0.15).add(0.85))
    : mx_noise_float(vec3(aU.mul(6).add(T.mul(0.8)), aV.mul(4), 0)).mul(0.5).add(0.5);
  mat.colorNode = mix(vec3(u.uTint), vec3(u.uGlow), pattern).mul(u.uBright);
  const fadeTop = smoothstep(1, 0.15, aV); // thins toward the top so it doesn't read as a hard-capped wall
  mat.opacityNode = fadeTop.mul(u.uEnv).mul(pal.kind === 'sand' ? 0.32 : 0.55);
  return mat;
}

/**
 * A minimal instanced pool for falling, once-bouncing bodies — hail. See the file header for why
 * `createDebrisPool` does not fit: its bounce floor is locked near the spawn height, built for chips
 * erupting up from the ground rather than stones falling onto it from above.
 */
function createHailPool({ THREE, geometry, material, max }) {
  const mesh = new THREE.InstancedMesh(geometry, material, max);
  mesh.frustumCulled = false;
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < max; i++) mesh.setMatrixAt(i, zero);
  const px = new Float32Array(max), py = new Float32Array(max), pz = new Float32Array(max);
  const vy = new Float32Array(max), life = new Float32Array(max), bounced = new Uint8Array(max);
  const ang = new Float32Array(max), spin = new Float32Array(max), gy = new Float32Array(max), size = new Float32Array(max);
  let cursor = 0;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), axisUp = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3(), scl = new THREE.Vector3();

  /** `groundY` is the real ground height under (x, z) — the whole reason this pool exists over the shared one. */
  function emit(x, y, z, groundY, sz, vy0, life0, spin0, ang0) {
    const i = cursor; cursor = (cursor + 1) % max;
    px[i] = x; py[i] = y; pz[i] = z; vy[i] = vy0; life[i] = life0; bounced[i] = 0;
    gy[i] = groundY; ang[i] = ang0; spin[i] = spin0; size[i] = sz;
  }

  function step(dt, gravity, bounceRestitution) {
    for (let i = 0; i < max; i++) {
      if (life[i] <= 0) continue;
      life[i] -= dt;
      if (life[i] <= 0) { mesh.setMatrixAt(i, zero); continue; }
      vy[i] += gravity * dt;
      py[i] += vy[i] * dt;
      ang[i] += spin[i] * dt;
      if (py[i] <= gy[i]) {
        py[i] = gy[i];
        if (!bounced[i]) { vy[i] = -vy[i] * bounceRestitution; bounced[i] = 1; }
        else { vy[i] = 0; life[i] = Math.min(life[i], 0.12); } // settle briefly on the second contact, then vanish
      }
      const s = size[i];
      pos.set(px[i], py[i], pz[i]);
      q.setFromAxisAngle(axisUp, ang[i]);
      m.compose(pos, q, scl.set(s, s, s));
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  function reset() { for (let i = 0; i < max; i++) { life[i] = 0; mesh.setMatrixAt(i, zero); } mesh.instanceMatrix.needsUpdate = true; cursor = 0; }
  function dispose() { mesh.dispose(); }
  return { mesh, emit, step, reset, dispose };
}

export function createFieldFx(deps, options = {}) {
  const { THREE, TSL, NODES, scene } = deps;
  const terrainHeight = deps.terrainHeight || (() => 0);
  const lightPool = deps.lights || { acquire: () => null, release: () => {} };
  const o = { ...DEFAULTS, ...options };

  // The field is centred on the arena, not on either creature. `demos/pokemon-moves.html` puts its
  // ground circle at the scene's world origin with the fighters offset to x = ±1.5, so (0, 0) is the
  // arena's centre in that harness. A deps-supplied `arenaCenter`/`arenaRadius` would remove this
  // assumption — see the report for what a non-demo harness would need to provide instead.
  const arenaX = 0, arenaZ = 0;

  function cast({ line, seed = 1, palette = 'gravity', power = 1 }) {
    // `line` is still handed to the phase machine below (it needs a length for its internal math), but
    // its origin/target are not used for placement — this effect ignores where the caster and target
    // stand. `sourceY`/`targetY` are likewise not read: nothing here is anchored to a creature's height.
    const rnd = mulberry32(seed >>> 0);
    const pal = PALETTES[palette] || PALETTES.gravity;
    const pw = Math.max(0.15, power);
    const rateScale = Math.min(2.2, pw);
    const bright = o.brightness * (0.8 + 0.3 * Math.min(pw, 2));
    const R = o.radius;
    const cy = terrainHeight(arenaX, arenaZ);

    const group = new THREE.Group();
    group.position.set(arenaX, cy, arenaZ);
    scene.add(group);

    const ring = buildRing({ segments: o.ringSegments, radius: R, ox: arenaX, oy: cy, oz: arenaZ, terrainHeight });
    const materials = [];
    const geometries = [];

    const uEnv = TSL.uniform(0);
    const uLift = TSL.uniform(-o.sinkDist);
    const uFlow = TSL.uniform(o.flow);
    const uBright = TSL.uniform(bright);
    const uTint = TSL.uniform(new THREE.Color(pal.tint));
    const uGlow = TSL.uniform(new THREE.Color(pal.glow));
    const uWallHeight = TSL.uniform(pal.wallHeight * (0.85 + 0.3 * Math.min(pw, 2)));
    const u = { uEnv, uLift, uFlow, uBright, uTint, uGlow, uWallHeight };

    const sheetGeo = buildSheetGeometry(THREE, R, o.segments);
    const sheetMat = buildSheetMaterial(THREE, TSL, NODES, pal, o, R, u);
    materials.push(sheetMat); geometries.push(sheetGeo);
    const sheetMesh = new THREE.Mesh(sheetGeo, sheetMat);
    sheetMesh.renderOrder = 1; sheetMesh.frustumCulled = false;
    group.add(sheetMesh);

    const edgeGeo = buildEdgeGeometry(THREE, ring, o.edgeWidth);
    const edgeMat = buildEdgeMaterial(THREE, TSL, NODES, u);
    materials.push(edgeMat); geometries.push(edgeGeo);
    const edgeMesh = new THREE.Mesh(edgeGeo, edgeMat);
    edgeMesh.renderOrder = 2; edgeMesh.frustumCulled = false;
    group.add(edgeMesh);

    let wallMesh = null;
    if (pal.wallHeight > 0) {
      const wallGeo = buildWallGeometry(THREE, ring, o.wallRows);
      const wallMat = buildWallMaterial(THREE, TSL, NODES, pal, o, u);
      materials.push(wallMat); geometries.push(wallGeo);
      wallMesh = new THREE.Mesh(wallGeo, wallMat);
      wallMesh.renderOrder = 3; wallMesh.frustumCulled = false;
      group.add(wallMesh);
    }

    // ----- particle / instanced layers, one per palette kind that the brief calls for -----
    let rainKit = null, sandKit = null, sunKit = null, mistKit = null;
    let hailPool = null, hailGeo = null, hailMat = null;
    const emitters = {};

    if (pal.kind === 'rain') {
      rainKit = createSpriteParticles({ THREE, TSL, NODES, cap: o.rainCap, colorA: pal.dropA, colorB: pal.dropB, aspect: [0.14, 1.6], gravity: -14, drag: 0.05, additive: false });
      group.add(rainKit.mesh);
      emitters.rain = createRateEmitter(120);
    }
    if (pal.kind === 'sand') {
      sandKit = createSpriteParticles({ THREE, TSL, NODES, cap: o.sandCap, colorA: pal.gritA, colorB: pal.gritB, aspect: [1, 0.4], gravity: 0, drag: 0.05, additive: false });
      group.add(sandKit.mesh);
      emitters.sand = createRateEmitter(80);
    }
    if (pal.kind === 'sun') {
      sunKit = createSpriteParticles({ THREE, TSL, NODES, cap: o.sunCap, colorA: pal.shaftA, colorB: pal.shaftB, aspect: [0.4, 3.2], gravity: -0.15, drag: 0.05, additive: true, growAtBirth: 0.6, growAtDeath: 1.0 });
      group.add(sunKit.mesh);
      emitters.sun = createRateEmitter(30);
    }
    if (pal.kind === 'terrain' && pal.pattern === 'mist') {
      mistKit = createSpriteParticles({ THREE, TSL, NODES, cap: o.mistCap, colorA: pal.mistA, colorB: pal.mistB, aspect: [2.2, 1.2], gravity: 0, drag: 0.3, additive: false, growAtBirth: 0.3, growAtDeath: 1.4 });
      group.add(mistKit.mesh);
      emitters.mist = createRateEmitter(70);
    }
    if (pal.kind === 'hail') {
      hailGeo = new THREE.IcosahedronGeometry(1, 0);
      hailMat = new NODES.MeshBasicNodeMaterial();
      hailMat.color = new THREE.Color(pal.stone);
      hailMat.toneMapped = false;
      hailPool = createHailPool({ THREE, geometry: hailGeo, material: hailMat, max: o.hailCap });
      group.add(hailPool.mesh);
      emitters.hail = createRateEmitter(60);
    }

    // ----- lights: warp and sun only, at most 2 -----
    const spill = [];
    if (pal.lightCount > 0) {
      for (let i = 0; i < pal.lightCount; i++) {
        const light = lightPool.acquire();
        if (!light) break;
        const a = (i / Math.max(1, pal.lightCount)) * TAU + rnd() * 0.5;
        light.color.set(pal.lightColor);
        light.distance = o.lightRange;
        light.intensity = 0;
        spill.push({ light, a, phase: rnd() * TAU });
      }
    }

    // ----- envelope-driven phase machine -----
    let env = 0, hitPending = false, donePending = false;
    const machine = createPhaseMachine({
      travelTime: o.travelTime, impactTime: o.impactTime, fadeTime: o.fadeTime, easeIn: 0.05,
      onTravel() { env = this.u; },
      onImpact() { env = 1; hitPending = true; },
      onFade(dt, t) { env = t <= 1 ? 1 : 1 - saturate(t - 1); }, // pinned at 1 for the whole hold, however long it runs
      onDestroy() { donePending = true; },
    });
    machine.spawn(line);

    function emitRain(dt) {
      const n = emitters.rain.take(o.rainRate * rateScale, dt);
      for (let i = 0; i < n; i++) {
        const a = rnd() * TAU, r = Math.sqrt(rnd()) * R;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        rainKit.emit(x, 2.6 + rnd() * 1.4, z, (rnd() - 0.5) * 0.3, -9 - rnd() * 3, (rnd() - 0.5) * 0.3, 0.045 + rnd() * 0.05, 0.5 + rnd() * 0.3);
      }
    }
    function emitSand(dt) {
      const n = emitters.sand.take(o.sandRate * rateScale, dt);
      const windA = 0.6; // fixed wind heading; deterministic from the module, not per-cast, so it reads consistently
      for (let i = 0; i < n; i++) {
        const along = rnd() * TAU, r = R * (0.85 + rnd() * 0.2);
        const x = Math.cos(along) * r, z = Math.sin(along) * r;
        const sp = 2.5 + rnd() * 2;
        sandKit.emit(x, 0.2 + rnd() * 1.6, z, -Math.cos(windA) * sp, (rnd() - 0.5) * 0.3, -Math.sin(windA) * sp, 0.35 + rnd() * 0.35, 1.4 + rnd() * 0.8);
      }
    }
    function emitSun(dt) {
      const n = emitters.sun.take(o.sunRate * rateScale, dt);
      for (let i = 0; i < n; i++) {
        const a = rnd() * TAU, r = Math.sqrt(rnd()) * R * 0.8;
        sunKit.emit(Math.cos(a) * r, 3.2 + rnd() * 1.2, Math.sin(a) * r, 0, -0.35 - rnd() * 0.2, 0, 0.5 + rnd() * 0.6, 3 + rnd() * 2);
      }
    }
    function emitMist(dt) {
      const n = emitters.mist.take(o.mistRate * rateScale, dt);
      for (let i = 0; i < n; i++) {
        const a = rnd() * TAU, r = Math.sqrt(rnd()) * R;
        mistKit.emit(Math.cos(a) * r, 0.1 + rnd() * 0.5, Math.sin(a) * r, (rnd() - 0.5) * 0.4, 0.03, (rnd() - 0.5) * 0.4, 0.7 + rnd() * 0.6, 2.4 + rnd() * 1.2);
      }
    }
    function emitHail(dt) {
      const n = emitters.hail.take(o.hailRate * rateScale, dt);
      for (let i = 0; i < n; i++) {
        const a = rnd() * TAU, r = Math.sqrt(rnd()) * R;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        const groundY = terrainHeight(arenaX + x, arenaZ + z) - cy;
        hailPool.emit(x, 2.4 + rnd() * 1.2, z, groundY, 0.045 + rnd() * 0.03, -0.15, 0.7 + rnd() * 0.4, (rnd() * 2 - 1) * 8, rnd() * TAU);
      }
    }

    function updateLights(t) {
      for (const s of spill) {
        const breathe = 0.75 + 0.25 * Math.sin(t * 0.8 * o.flow + s.phase);
        s.light.position.set(Math.cos(s.a) * R * 0.5, cy + (pal.wallHeight > 0 ? pal.wallHeight * 0.45 : 3.4), Math.sin(s.a) * R * 0.5);
        s.light.intensity = pal.lightIntensity * bright * env * breathe;
      }
    }

    const inst = {
      group,
      machine,
      onImpact: null,
      onDone: null,
      update(dt, t = 0) {
        const alive = machine.update(dt, t);
        uEnv.value = env;
        uLift.value = (env - 1) * o.sinkDist;
        const active = env > 0.01;
        if (rainKit) { if (active) emitRain(dt); rainKit.step(dt); rainKit.setFade(env); }
        if (sandKit) { if (active) emitSand(dt); sandKit.step(dt); sandKit.setFade(env); }
        if (sunKit) { if (active) emitSun(dt); sunKit.step(dt); sunKit.setFade(env); }
        if (mistKit) { if (active) emitMist(dt); mistKit.step(dt); mistKit.setFade(env); }
        if (hailPool) { if (active) emitHail(dt); hailPool.step(dt, -16, 0.14); }
        if (spill.length) updateLights(t);
        if (hitPending) { hitPending = false; this.onImpact?.(); }
        if (!alive && donePending) { donePending = false; this.onDone?.(); }
        return alive;
      },
      dispose() {
        machine.destroy();
        donePending = false;
        for (const s of spill) { s.light.intensity = 0; lightPool.release(s.light); }
        spill.length = 0;
        group.removeFromParent();
        for (const g of geometries) g.dispose();
        for (const m of materials) m.dispose();
        if (rainKit) rainKit.dispose();
        if (sandKit) sandKit.dispose();
        if (sunKit) sunKit.dispose();
        if (mistKit) mistKit.dispose();
        if (hailPool) { hailPool.dispose(); hailGeo.dispose(); hailMat.dispose(); }
      },
    };
    return inst;
  }

  return { cast, dispose() {} };
}
