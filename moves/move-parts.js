/**
 * move-parts.js — the shared kit behind the five `fx-*.js` move effects, lifted out so the next eleven
 * effects import instead of copy-pasting. Every part below is generalised math pulled from one named
 * source module; the docblock on each function says which. Nothing here is a new idea.
 *
 * Same rule as the fx modules: `THREE`, `TSL`, `NODES` are injected arguments, never imported, so every
 * part constructs in Node without a GPU. The file's only top-level import is `./move-core.js`, for
 * `Easing`/`saturate` (used by the flash-sphere pop). Node cannot compile WGSL — a node graph building
 * here proves the graph is well-formed, not that it renders.
 *
 * Determinism: every random draw takes an injected `rnd()` — this file never calls `Math.random`. Two
 * exceptions are noted where the spec'd call signature left no room for one: `createSpriteParticles`'s
 * `emit()` (fixed to `x,y,z,vx,vy,vz,size,life`, no seed slot) derives its per-instance `aSeed` from a
 * deterministic golden-ratio sequence over the emit index instead; `walkPath` accepts `rnd` only for
 * signature symmetry with `radialWalks` and never calls it, matching `fx-fissure.js`'s `walkCrack`, which
 * took no rnd either — all the randomness in the source happened in the caller before invoking it.
 *
 * Where more than one fx module has a "things fly out and settle" system, they are not actually the same
 * idea and are kept as two parts: `createSpriteParticles` (part 5) is fx-stream's billboarded gas —
 * camera-facing quads under `SpriteNodeMaterial` with per-instance attributes, the *only* safe shape for
 * a particle system with per-instance positioning under WebGPU (an `InstancedMesh`'s `positionNode`
 * discards `instanceMatrix` — see fx-stream.js's header). `createDebrisPool` (part 8) is fx-crystals'
 * tumbling rock chips — rigid bodies with gravity and a ground bounce, posed as `InstancedMesh` matrices,
 * which is the right shape for something that spins and lands rather than fades. fx-bolt's crossed-quad
 * sparks and fx-fissure's per-instance-color embers are each a further variant of "CPU-driven instanced
 * bits"; they were not folded in here because neither generalises without losing what makes it look
 * right (sparks need to survive being seen edge-on with no camera in `deps`; embers carry a 4-channel
 * color attribute driven by a blackbody ramp that is specific to the crack shader) — a future part could
 * factor their *physics* out the way `createDebrisPool` does, but that was not asked for here.
 *
 * Left out entirely (effect-specific, not reusable): fx-bolt's ladder-strip ribbon and its lightning
 * vertex/fragment shaders; fx-stream's beam column (Gram-Schmidt axis + cone radius shader) and its
 * noise-displaced burst dome; fx-fissure's crack ribbon materials (`buildCoreMaterial`/`buildUnderMaterial`)
 * and its spike/branch placement math; fx-crystals' band/crown/front-bias spike layout and its eruption
 * timing; fx-aurora's curtain wave shader. Only the ten parts named in the brief are exported.
 */

const TAU = Math.PI * 2;

import { Easing, saturate } from './move-core.js';

// Live diagnostic budget shared by every effect that uses the common particle/debris kits.
// Keeping it module-level means existing and future effect instances respond immediately.
const MOVE_COMPONENT_RUNTIME = { particles: true, particleScale: 1 };

export function setMoveComponentRuntime({ particles, particleScale } = {}) {
  if (particles !== undefined) MOVE_COMPONENT_RUNTIME.particles = !!particles;
  if (particleScale !== undefined) {
    MOVE_COMPONENT_RUNTIME.particleScale = Math.max(0, Math.min(1, Number(particleScale) || 0));
  }
}

export function getMoveComponentRuntime() {
  return { ...MOVE_COMPONENT_RUNTIME };
}

// ---------------------------------------------------------------------------------------------
// 1-2. Ring / arc paths — from fx-aurora.js `buildRing`. The ring closes because every wave that
// reads `u` around it uses an integer harmonic (see `harmonic` below); the arc is the same sampler
// over a partial angle range, so unlike the ring its first and last points are not the same place.
// ---------------------------------------------------------------------------------------------

/** One point on a circle of `radius` around (ox, oy, oz), in group-local space, on the terrain. */
function ringPoint(a, radius, ox, oy, oz, terrainHeight) {
  const cx = Math.cos(a), cz = Math.sin(a);
  const x = ox + cx * radius, z = oz + cz * radius;
  return { x: cx * radius, y: terrainHeight(x, z) - oy, z: cz * radius, sx: cx, sz: cz };
}

/** Closed ring, `segments` + 1 points; column 0 and column N sit at the same place (the seam). */
export function buildRing({ segments, radius, ox = 0, oy = 0, oz = 0, terrainHeight = () => 0 }) {
  const cols = segments + 1;
  const pts = new Array(cols);
  for (let i = 0; i < cols; i++) {
    const u = i / segments;
    pts[i] = { ...ringPoint(u * TAU, radius, ox, oy, oz, terrainHeight), u };
  }
  return pts;
}

/** Open arc from `angleFrom` to `angleTo`; no seam, so first and last points are not repeated. */
export function buildArc({ segments, radius, angleFrom = 0, angleTo = Math.PI, ox = 0, oy = 0, oz = 0, terrainHeight = () => 0 }) {
  const cols = segments + 1;
  const pts = new Array(cols);
  for (let i = 0; i < cols; i++) {
    const u = i / segments;
    const a = angleFrom + (angleTo - angleFrom) * u;
    pts[i] = { ...ringPoint(a, radius, ox, oy, oz, terrainHeight), u };
  }
  return pts;
}

/** Snap a wave count to a whole number: the trick that keeps a closed ring's shader seamless. */
export function harmonic(n) {
  return Math.max(1, Math.round(n));
}

// ---------------------------------------------------------------------------------------------
// 3-4. Ground walks — from fx-fissure.js `walkCrack` (main crack + branches) and `growBurst` (the
// radial impact cluster). `walkPath` re-samples `terrainHeight` at every step, so a walk always
// follows the ground even where the ground itself is uneven.
// ---------------------------------------------------------------------------------------------

/**
 * Walk a crack-like path across the ground from (x, z), veering by `curvature` rad/step. `steps` is
 * a point count (not a distance) so the caller does not have to reason about float loop bounds; the
 * source's `maxWalk` field survives per-point as `steps * step`, since downstream shaders taper by it.
 */
export function walkPath({ x, z, dirX, dirZ, steps, step = 0.16, curvature = 0, rnd, terrainHeight = () => 0, baseDist = 0, rank = 0 }) {
  const pts = [];
  let dx = dirX, dz = dirZ;
  const maxWalk = steps * step;
  for (let i = 0; i <= steps; i++) {
    const walked = i * step;
    pts.push({ x, y: terrainHeight(x, z), z, tx: dx, tz: dz, sx: -dz, sz: dx, dist: baseDist + walked, walked, maxWalk, rank });
    x += dx * step; z += dz * step;
    const a = curvature * step, ca = Math.cos(a), sa = Math.sin(a);
    const nx = dx * ca - dz * sa; dz = dx * sa + dz * ca; dx = nx;
  }
  return pts;
}

/** A burst of short walks radiating out from any (x, z), evenly spaced with angle/length jitter. */
export function radialWalks({
  x, z, count, rnd, terrainHeight = () => 0, baseDist = 0, step = 0.16,
  length = 1.3, lengthMin = 0.6, lengthMax = 1.4, curvatureScale = 2.4, angleJitter = 0.5, rank = 0.0005,
}) {
  const out = [];
  const base = rnd() * TAU;
  for (let i = 0; i < count; i++) {
    const a = base + (i / count) * TAU + (rnd() - 0.5) * angleJitter;
    const len = length * (lengthMin + rnd() * (lengthMax - lengthMin));
    const steps = Math.max(1, Math.round(len / step));
    const pts = walkPath({
      x, z, dirX: Math.cos(a), dirZ: Math.sin(a), steps, step,
      curvature: (rnd() - 0.5) * curvatureScale, rnd, terrainHeight, baseDist, rank,
    });
    if (pts.length >= 2) out.push(pts);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 5. Billboarded particles — from fx-stream.js's puffs. InstancedBufferGeometry of quads under
// SpriteNodeMaterial with per-instance aPos/aLife/aSize/aSeed, NOT an InstancedMesh (setting
// positionNode on an InstancedMesh material discards instanceMatrix under WebGPU).
// ---------------------------------------------------------------------------------------------

/**
 * A pool of `cap` camera-facing quads. `emit` takes fully-resolved kinematics (the caller owns its
 * own `rnd()` for spread/speed/size/life jitter, matching how fx-stream's callers randomize before
 * calling `emitPuff`); `step` integrates gravity/drag and swap-removes the dead, alloc-free.
 */
export function createSpriteParticles({
  THREE, TSL, NODES, cap = 300, colorA = 0xffffff, colorB = 0x000000, aspect = [1, 1],
  gravity = 0, drag = 0, additive = true, growAtBirth = 0.35, growAtDeath = 1.35, colorEase = 0.6,
}) {
  const { attribute, mix, pow, smoothstep, uv, vec2, float, uniform } = TSL;

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0,
  ]), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  geo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));

  const pPos = new Float32Array(cap * 3), pVel = new Float32Array(cap * 3);
  const pLife = new Float32Array(cap), pRate = new Float32Array(cap);
  const pSize = new Float32Array(cap), pSeed = new Float32Array(cap);
  const aPos = new THREE.InstancedBufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage);
  const aLife = new THREE.InstancedBufferAttribute(pLife, 1).setUsage(THREE.DynamicDrawUsage);
  const aSize = new THREE.InstancedBufferAttribute(pSize, 1).setUsage(THREE.DynamicDrawUsage);
  const aSeed = new THREE.InstancedBufferAttribute(pSeed, 1).setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aPos', aPos); geo.setAttribute('aLife', aLife);
  geo.setAttribute('aSize', aSize); geo.setAttribute('aSeed', aSeed);
  geo.instanceCount = 0;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4); // placed by the shader, never culled

  const nLife = attribute('aLife', 'float');
  const nSize = attribute('aSize', 'float');
  const nSeed = attribute('aSeed', 'float');
  const grow = mix(float(growAtDeath), float(growAtBirth), nLife); // life=1 at birth, 0 at death
  const disc = smoothstep(0.5, 0.06, uv().sub(0.5).length());
  const fadeU = uniform(1);
  const cA = uniform(new THREE.Color(colorA));
  const cB = uniform(new THREE.Color(colorB));

  const mat = new NODES.SpriteNodeMaterial({ transparent: true, depthWrite: false });
  mat.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
  mat.toneMapped = false;
  mat.positionNode = attribute('aPos', 'vec3');
  mat.scaleNode = vec2(nSize.mul(grow).mul(aspect[0]), nSize.mul(grow).mul(aspect[1]));
  mat.rotationNode = nSeed.mul(TAU);
  mat.colorNode = mix(cB, cA, pow(nLife, colorEase));
  mat.opacityNode = disc.mul(smoothstep(0, 0.3, nLife)).mul(smoothstep(1, 0.88, nLife)).mul(fadeU);

  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.userData.moveComponent = 'particles';
  mesh.userData.moveParticleRuntimeManaged = true;

  let count = 0, cursor = 0, emissionCarry = 0;
  const GOLDEN = 0.6180339887498949;

  function emit(x, y, z, vx, vy, vz, size, life) {
    if (!MOVE_COMPONENT_RUNTIME.particles || MOVE_COMPONENT_RUNTIME.particleScale <= 0) return;
    emissionCarry += MOVE_COMPONENT_RUNTIME.particleScale;
    if (emissionCarry < 1) return;
    emissionCarry -= 1;
    const i = count < cap ? count++ : (cursor = (cursor + 1) % cap);
    const j = i * 3;
    pPos[j] = x; pPos[j + 1] = y; pPos[j + 2] = z;
    pVel[j] = vx; pVel[j + 1] = vy; pVel[j + 2] = vz;
    pLife[i] = 1;
    pRate[i] = 1 / Math.max(1e-3, life);
    pSize[i] = size;
    pSeed[i] = (i * GOLDEN) % 1; // deterministic low-discrepancy seed, no rnd() slot in this signature
  }

  function step(dt) {
    if (!MOVE_COMPONENT_RUNTIME.particles || MOVE_COMPONENT_RUNTIME.particleScale <= 0) {
      reset();
      return;
    }
    const damp = 1 - Math.min(0.95, drag * dt);
    const g = gravity * dt;
    let n = count;
    for (let i = 0; i < n; i++) {
      const l = pLife[i] - pRate[i] * dt;
      if (l <= 0) {
        n--;
        const a = i * 3, b = n * 3;
        pPos[a] = pPos[b]; pPos[a + 1] = pPos[b + 1]; pPos[a + 2] = pPos[b + 2];
        pVel[a] = pVel[b]; pVel[a + 1] = pVel[b + 1]; pVel[a + 2] = pVel[b + 2];
        pLife[i] = pLife[n]; pRate[i] = pRate[n]; pSize[i] = pSize[n]; pSeed[i] = pSeed[n];
        i--; continue;
      }
      pLife[i] = l;
      const j = i * 3;
      pVel[j] *= damp; pVel[j + 1] = pVel[j + 1] * damp + g; pVel[j + 2] *= damp;
      pPos[j] += pVel[j] * dt; pPos[j + 1] += pVel[j + 1] * dt; pPos[j + 2] += pVel[j + 2] * dt;
    }
    count = n;
    if (cursor >= n) cursor = 0;
    geo.instanceCount = n;
    mesh.visible = n > 0;
    aPos.needsUpdate = true; aLife.needsUpdate = true; aSize.needsUpdate = true; aSeed.needsUpdate = true;
  }

  function setFade(v) { fadeU.value = v; }
  function reset() { count = 0; cursor = 0; emissionCarry = 0; geo.instanceCount = 0; mesh.visible = false; }
  function dispose() { geo.dispose(); mat.dispose(); }

  return { mesh, emit, step, setFade, reset, dispose };
}

// ---------------------------------------------------------------------------------------------
// 6. Crystal geometry — from fx-crystals.js `makeCrystalGeometry`. Hexagonal-by-default quartz
// point: jittered facet columns, taper into an off-axis apex, non-indexed for true flat facets.
// ---------------------------------------------------------------------------------------------

export function makeCrystalGeometry(THREE, rnd, options = {}) {
  const {
    sides = 6, shaftRange = [0.55, 0.75], taperRange = [0.78, 0.94],
    apexJitter = 0.14, baseRadius = [0.16, 0.26],
  } = options;
  const baseR = baseRadius[0] + rnd() * (baseRadius[1] - baseRadius[0]);
  const shaftH = shaftRange[0] + rnd() * (shaftRange[1] - shaftRange[0]);
  const taper = taperRange[0] + rnd() * (taperRange[1] - taperRange[0]);
  const apex = [(rnd() - 0.5) * apexJitter, 1, (rnd() - 0.5) * apexJitter];
  const lower = [], upper = [];
  for (let i = 0; i < sides; i++) {
    const a = ((i + (rnd() - 0.5) * 0.34) / sides) * TAU;
    const r = baseR * (0.8 + rnd() * 0.4);
    const c = Math.cos(a), s = Math.sin(a);
    lower.push([c * r, 0, s * r]);
    upper.push([c * r * taper, shaftH, s * r * taper]);
  }
  const p = [];
  const push = (a, b, c) => { p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]); };
  const bottom = [0, -0.02, 0]; // a hair below the base, so a tilted crystal still closes
  for (let i = 0; i < sides; i++) {
    const j = (i + 1) % sides;
    push(lower[i], upper[i], upper[j]);
    push(lower[i], upper[j], lower[j]);
    push(upper[i], apex, upper[j]);
    push(lower[j], bottom, lower[i]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------------------------
// 7. Rock chunk geometry — from fx-fissure.js `makeRockGeometry`. A jittered, flattened box so
// shared vertices move together (no cracks in the facets) but every rock still reads as unique.
// ---------------------------------------------------------------------------------------------

export function makeRockGeometry(THREE, rnd, options = {}) {
  const { flatten = 0.55, jitter = [0.45, 0.3, 0.4] } = options;
  const geo = new THREE.BoxGeometry(1, flatten, 0.7, 2, 1, 1).toNonIndexed();
  const pos = geo.getAttribute('position');
  const seen = new Map();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
    let d = seen.get(key);
    if (!d) { d = [(rnd() - 0.5) * jitter[0], (rnd() - 0.5) * jitter[1], (rnd() - 0.5) * jitter[2]]; seen.set(key, d); }
    pos.setXYZ(i, pos.getX(i) + d[0], pos.getY(i) * (0.7 + rnd() * 0.1) + d[1] * 0.5 + 0.25, pos.getZ(i) + d[2]);
  }
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------------------------
// 8. Debris pool — from fx-crystals.js `emitChips`/`updateChips`, generalised to any geometry and
// material. Rigid chips with gravity and a single ground bounce, posed as InstancedMesh matrices.
// ---------------------------------------------------------------------------------------------

/**
 * `rnd` is required even though it is not in the brief's constructor list, because emission (the
 * launch angle, speed spread, spin, life) has to come from an injected source per the file's own
 * determinism rule, and the spec's `emit(x, y, z, n, speed)` leaves no per-call slot for one.
 */
export function createDebrisPool({
  THREE, geometry, material, max = 180, gravity = -11, bounce = 0.28, drag = 0.6, spin = 9,
  size = 0.09, scaleY = 1.6, life = [0.6, 1.4], rnd,
}) {
  // A kit pooled across casts must follow the current cast's seed, or the second cast of a palette
  // draws from wherever the first one left the generator. Modules that pool call setRnd() per cast.
  let draw = rnd;
  const mesh = new THREE.InstancedMesh(geometry, material, max);
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.userData.moveComponent = 'particles';
  mesh.userData.moveParticleRuntimeManaged = true;
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < max; i++) mesh.setMatrixAt(i, zero);

  const px = new Float32Array(max), py = new Float32Array(max), pz = new Float32Array(max);
  const vx = new Float32Array(max), vy = new Float32Array(max), vz = new Float32Array(max);
  const gy = new Float32Array(max), lifeArr = new Float32Array(max), spinArr = new Float32Array(max);
  const ang = new Float32Array(max), ax = new Float32Array(max), az = new Float32Array(max);
  let cursor = 0, live = 0, emissionCarry = 0;
  const m = new THREE.Matrix4(), q = new THREE.Quaternion();
  const axis = new THREE.Vector3(), pos = new THREE.Vector3(), scl = new THREE.Vector3();

  function emit(x, y, z, n, speed) {
    if (!MOVE_COMPONENT_RUNTIME.particles || MOVE_COMPONENT_RUNTIME.particleScale <= 0) return;
    const scaled = n * MOVE_COMPONENT_RUNTIME.particleScale + emissionCarry;
    n = Math.floor(scaled);
    emissionCarry = scaled - n;
    for (let k = 0; k < n; k++) {
      const i = cursor; cursor = (cursor + 1) % max;
      if (lifeArr[i] <= 0) live++;
      const a = draw() * TAU, sp = speed * (0.5 + draw());
      px[i] = x + Math.cos(a) * 0.05; py[i] = y; pz[i] = z + Math.sin(a) * 0.05;
      vx[i] = Math.cos(a) * sp * 0.45; vy[i] = sp * (0.8 + draw() * 0.6); vz[i] = Math.sin(a) * sp * 0.45;
      gy[i] = y - 0.04; lifeArr[i] = life[0] + draw() * (life[1] - life[0]);
      spinArr[i] = (draw() * 2 - 1) * spin; ang[i] = draw() * TAU;
      ax[i] = draw() * 2 - 1; az[i] = draw() * 2 - 1;
    }
    if (n > 0) mesh.visible = true;
  }

  function step(dt) {
    if (!MOVE_COMPONENT_RUNTIME.particles || MOVE_COMPONENT_RUNTIME.particleScale <= 0) {
      reset();
      mesh.visible = false;
      return;
    }
    if (live === 0) return;
    let n = 0;
    for (let i = 0; i < max; i++) {
      if (lifeArr[i] <= 0) continue;
      lifeArr[i] -= dt;
      if (lifeArr[i] <= 0) { mesh.setMatrixAt(i, zero); continue; }
      n++;
      vy[i] += gravity * dt;
      px[i] += vx[i] * dt; py[i] += vy[i] * dt; pz[i] += vz[i] * dt;
      if (py[i] < gy[i]) { py[i] = gy[i]; vy[i] *= -bounce; vx[i] *= drag; vz[i] *= drag; }
      ang[i] += spinArr[i] * dt;
      const s = size * Math.min(1, lifeArr[i] * 4);
      axis.set(ax[i], 1, az[i]).normalize();
      pos.set(px[i], py[i], pz[i]);
      q.setFromAxisAngle(axis, ang[i]);
      m.compose(pos, q, scl.set(s, s * scaleY, s));
      mesh.setMatrixAt(i, m);
    }
    live = n;
    mesh.visible = n > 0;
    mesh.instanceMatrix.needsUpdate = true;
  }

  function reset() {
    for (let i = 0; i < max; i++) { lifeArr[i] = 0; mesh.setMatrixAt(i, zero); }
    live = 0; cursor = 0; emissionCarry = 0; mesh.visible = false;
    mesh.instanceMatrix.needsUpdate = true;
  }
  function dispose() { mesh.dispose(); }

  function setRnd(fn) { draw = fn || rnd; } // re-point at the current cast's generator

  return { mesh, emit, step, reset, dispose, setRnd };
}

// ---------------------------------------------------------------------------------------------
// 9. Flash sphere — from fx-bolt.js `additiveMaterial(pal.muzzle/impact)` + `popFlash`. A simple
// pop-and-fade icosahedron used for muzzle/impact flashes.
// ---------------------------------------------------------------------------------------------

export function makeFlashSphere({ THREE, NODES, color = 0xffffff, detail = 2 }) {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const mat = new NODES.MeshBasicNodeMaterial();
  mat.color = new THREE.Color(color);
  mat.transparent = true;
  mat.depthWrite = false;
  mat.blending = THREE.AdditiveBlending;
  mat.toneMapped = false;
  mat.opacity = 0;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.visible = false;
  return mesh;
}

/** Scale up on Easing.outCubic, fade on Easing.inQuad, hide once `age` passes `life`. */
export function popFlash(mesh, x, y, z, size, age, life) {
  if (age < 0) { mesh.visible = false; return; }
  const k = saturate(age / life);
  mesh.visible = true;
  mesh.position.set(x, y, z);
  mesh.scale.setScalar(size * (0.25 + 0.95 * Easing.outCubic(k)));
  mesh.material.opacity = (1 - Easing.inQuad(k)) * 0.95;
  if (k >= 1) mesh.visible = false;
}

// ---------------------------------------------------------------------------------------------
// 10. Ground decal — from fx-stream.js's scorch/wet disc. A flat, mottled, radially-fading circle.
// ---------------------------------------------------------------------------------------------

export function makeGroundDecal({ THREE, TSL, NODES, radius = 1, color = 0x000000, mottle = 7, seed = 0 }) {
  const { uv, vec3, smoothstep, mx_noise_float, uniform } = TSL;
  const geo = new THREE.CircleGeometry(1, 40);
  const mat = new NODES.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  mat.toneMapped = false;
  const opacityU = uniform(1);
  const cDecal = uniform(new THREE.Color(color));
  const dR = uv().sub(0.5).length().mul(2);
  const mottleNode = mx_noise_float(vec3(uv().x.mul(mottle), uv().y.mul(mottle), seed)).mul(0.5).add(0.6);
  mat.colorNode = cDecal.mul(mottleNode);
  mat.opacityNode = smoothstep(1, 0.2, dR).mul(mottleNode).mul(opacityU);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.frustumCulled = false;
  mesh.userData.moveComponent = 'decals';
  mesh.scale.setScalar(radius);
  return {
    mesh,
    setOpacity(v) { opacityU.value = v; },
    dispose() { geo.dispose(); mat.dispose(); },
  };
}
