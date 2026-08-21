/**
 * fx-skyfall.js — a barrage of solid bodies dropped from above the line and landed on the ground.
 *
 * This is fx-crystals with the vertical motion and its trigger cut out and swapped: crystals erupts
 * spikes up out of the ground on a timer; this drops bodies down onto the ground on a timer. Both
 * reviews of crystals that proposed a fall variant converged on the same seam — keep the per-body
 * record schema and the instanced draw, replace only the vertical motion and what triggers it — and
 * both flagged that a horizontal throw is the wrong reading for these moves. This builds the rain:
 * every body falls straight down (no XZ drift), because a barrage of falling rock/ice/stone reads as
 * weather, not as thrown projectiles.
 *
 * Placement reuses crystals' band-and-cluster layout verbatim: bodies scatter along a corridor that
 * widens from the caster toward the target, with the last slice clustered around the impact point on
 * a sqrt-distributed radius. What crystals called "erection height" is repurposed here as "drop
 * height" — the corridor still grows near the target, so the barrage rains from higher and harder
 * where it lands.
 *
 * The drop anchor is invented, not given: nothing upstream (the cast line, `terrainHeight`) has a
 * notion of a point above the ground. `options.dropHeight` (default 7 m, scaled per palette and by
 * `power`) is that anchor, added to `terrainHeight(x, z)` sampled at each body's own landing point —
 * not the line's midpoint or a global Y — so a body dropped over a ridge still starts above the ridge
 * and one dropped over a valley still starts above the valley.
 *
 * Timing: the phase machine's front schedules LAUNCHES, not landings. As `u` advances it un-pauses
 * bodies whose horizontal position it has passed (mirroring crystals' `triggerUpTo`, renamed
 * `launchUpTo`), each with its own small stagger off the front. A body's landing time is then
 * `launchTime + fallTime`, where `fallTime = sqrt(2 * dropHeight / gravity)` — real falling-body
 * kinematics under a stylised gravity constant (`DEFAULTS.gravity`, faster than 9.8 so a barrage does
 * not take forever), not a portion of the travel time. This is the deliberate choice: scheduling
 * LANDINGS on the front instead (and back-solving a launch time by subtracting `fallTime`) would make
 * far bodies start falling before the front has reached them, which reads as debris flying backward
 * out of the sky toward the caster. Scheduling launches keeps the rain's landing order consistent
 * with the front's sweep while letting each body's own drop height and fall time still govern exactly
 * when it lands.
 *
 * A body that only translates downward reads as teleporting, so every falling body gets two motion
 * cues: a continuous tumble (axis-angle rotation about a fixed per-body random axis, rate scaled by
 * `tumbleSpeed`) and a vertical stretch that grows with `sqrt` of fall progress (falling bodies
 * accelerate, so the stretch — a pure matrix scale, no extra geometry — grows fastest right before
 * impact, reading as a motion streak). The `meteor` palette additionally trails a short line of
 * emissive sprite particles behind each falling body, because "fewer, larger, glowing, with a trail"
 * is asked for by name.
 *
 * Landing is a fixed sequence, all matrix-only: a body settles from its landing tumble angle into a
 * fixed resting orientation over `settleTime`, embeds `embedDepth` into the ground as it settles (a
 * point-down palette's shard tip is the part that embeds, via a 180 degree flip baked into its
 * landing quaternion), throws chips from `createDebrisPool` and a dust puff from a shared
 * `createSpriteParticles` pool, and — for a handful of the largest bodies only — fades in a
 * `makeGroundDecal` scorch/crater mark and flashes a pooled light. On FADE the whole field sinks
 * further into the ground on `Easing.inCubic`, exactly like crystals' retraction, so a still-falling
 * body is unaffected (it keeps falling on its own clock) while a landed one is pulled under.
 *
 * Only the one or two biggest bodies (by radius * height, ranked once at cast) get a light: there are
 * six lights shared by the whole scene and a barrage can be dozens of landings, so most landings are
 * lit by nothing. Only `meteor` carries a `light` palette entry at all — the other three palettes
 * never touch the pool. `inst.onImpact` (the harness's hit hook) fires once, when the single largest
 * body across the whole cast lands — not the first body to land — because a barrage's damage should
 * read from its most significant piece connecting, and "biggest" is a property fixed at cast time
 * rather than an artifact of scatter order (the first body to land is often a stray pebble at the
 * near edge of the corridor).
 *
 * Palettes: `stone` (grey flat-shaded boulders, no light) for Rock Slide / Rock Throw; `ice`
 * (transmissive point-down shards) for Icicle Crash / Avalanche; `meteor` (few, large, emissive
 * boulders with a trail and up to two lit landings) for Draco Meteor / Meteor Beam; `gem` (small,
 * bright, faceted, many) for Diamond Storm. Geometry and materials are the ones move-parts.js already
 * generalised out of fx-crystals.js and fx-fissure.js: `makeCrystalGeometry` for point-down shards,
 * `makeRockGeometry` for tumbling boulders. Nothing here writes a custom shader; only instance
 * matrices, colors and pooled-particle/decal/light state change per frame. No CPU/GPU mirror is
 * introduced — placement and motion are matrix math only, never duplicated shader logic.
 */

import { createPhaseMachine, mulberry32, Easing, saturate } from './move-core.js';
import { makeRockGeometry, makeCrystalGeometry, createDebrisPool, createSpriteParticles, makeGroundDecal } from './move-parts.js';

const TAU = Math.PI * 2;
const VARIANTS = 3;
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export const PALETTES = {
  // Rock Slide / Rock Throw: opaque flat-shaded rock, no light, heavy dust, many mid-size boulders.
  stone: {
    kind: 'standard', shape: 'rock', pointDown: false,
    base: 0x8d8375, emissive: 0x000000, emissiveIntensity: 0,
    hueJitter: 0.05, satMul: 0.7, roughness: 0.9, metalness: 0.03,
    chip: 0x6f665c, chipEmissive: 0x000000,
    light: null, trail: false,
    countMul: 1.25, sizeMul: 1.15, dropHeightMul: 1, chipMul: 1.15, dustMul: 1.3, decalMul: 1,
  },
  // Icicle Crash / Avalanche: refractive point-down shards (flipped crystal geometry), light chips.
  ice: {
    kind: 'physical', shape: 'crystal', pointDown: true,
    base: 0xdff4ff, attenuation: 0x6db6e8, emissive: 0x8fd0ff, emissiveIntensity: 0.12,
    hueJitter: 0.03, satMul: 1.05, transmission: 0.7, roughness: 0.06, ior: 1.5, thickness: 0.32,
    iridescence: 0.3, dispersion: 0.22,
    chip: 0xeaf7ff, chipEmissive: 0x2f7fb0,
    light: null, trail: false,
    countMul: 1, sizeMul: 0.9, dropHeightMul: 1.15, chipMul: 1.4, dustMul: 0.6, decalMul: 0.6,
  },
  // Draco Meteor / Meteor Beam: few, large, glowing rocks with a trail; the only palette with a light.
  meteor: {
    kind: 'standard', shape: 'rock', pointDown: false,
    base: 0x4a2418, emissive: 0xff6a1f, emissiveIntensity: 2.4,
    hueJitter: 0.04, satMul: 1.1, roughness: 0.72, metalness: 0.05,
    chip: 0x3a1c12, chipEmissive: 0xff8b3a,
    light: { color: 0xff8a3a, mul: 1 }, trail: true,
    countMul: 0.16, sizeMul: 2.6, dropHeightMul: 2.3, chipMul: 0.8, dustMul: 1.6, decalMul: 2.2,
  },
  // Diamond Storm: many small bright faceted shards, point-down, light debris, no light budget spent.
  gem: {
    kind: 'physical', shape: 'crystal', pointDown: true,
    base: 0xffffff, attenuation: 0xbfe0ff, emissive: 0xdff2ff, emissiveIntensity: 0.35,
    hueJitter: 0.12, satMul: 1.3, transmission: 0.55, roughness: 0.04, ior: 1.9, thickness: 0.22,
    iridescence: 0.7, dispersion: 0.55,
    chip: 0xf3fbff, chipEmissive: 0xbfe4ff,
    light: null, trail: false,
    countMul: 1.7, sizeMul: 0.45, dropHeightMul: 0.9, chipMul: 0.6, dustMul: 0.4, decalMul: 0.4,
  },
};

const DEFAULTS = {
  palette: 'stone',
  count: 34, maxCount: 140,               // bodies at power 1, and the hard ceiling
  travelSpeed: 11, holdTime: 0.9,         // front speed and how long the field stands once landed
  shatterDelay: 0.2, sinkTime: 0.85,      // fade = delay + sink, mirrors crystals' retraction
  launchStagger: 0.55,                    // spread of launch times behind the front, seconds
  dropHeight: 7, dropHeightNear: 3, dropHeightCurve: 1.1, dropHeightJitter: 0.3,
  gravity: 20,                            // stylised, not 9.8 — a real-gravity barrage reads too slow
  radius: 0.22, radiusJitter: 0.32,
  bodyHeight: 0.5, bodyHeightJitter: 0.3,
  width: 1.6, widthNear: 0.35, widthCurve: 1.3,
  frontBias: 0.85, clumping: 1.3, scatter: 0.32, impactFraction: 0.22, impactSpread: 1.3,
  bigFraction: 0.12, maxBig: 6,           // how many landings are "big" (decal/light eligible)
  tumbleSpeed: 5, streak: 0.55, lean: 0.3, embedDepth: 0.18, settleTime: 0.16,
  chips: true, chipsPerLanding: 3, maxChips: 220, chipSize: 0.09, chipSpeed: 3.2, chipGravity: -12, chipLife: 0.75,
  dust: true, dustPerLanding: 4, dustSize: 0.55, dustLife: 0.6, dustSpeed: 1.5, maxDust: 200,
  decals: true, maxDecals: 3, decalSize: 1, decalFadeIn: 0.1, decalHold: 1.2, decalFadeOut: 0.5,
  trailSize: 0.32, trailLife: 0.32, maxTrail: 150,
  lightIntensity: 22, lightDistance: 9, lightHeight: 0.6, maxLitLandings: 2, flashTime: 0.4,
};

// Scratch, filled from deps.THREE on the first factory call — nothing here allocates per frame.
let S = null;
function ensureScratch(THREE) {
  if (S) return S;
  S = {
    v: new THREE.Vector3(), pos: new THREE.Vector3(), scale: new THREE.Vector3(),
    axis: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0),
    q: new THREE.Quaternion(), qStart: new THREE.Quaternion(), tilt: new THREE.Quaternion(),
    flipDown: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI),
    m: new THREE.Matrix4(), zero: new THREE.Matrix4().makeScale(0, 0, 0),
    color: new THREE.Color(), hsl: { h: 0, s: 0, l: 0 },
  };
  return S;
}

export function createSkyfallFx(deps, options = {}) {
  const { THREE, TSL, NODES, scene, terrainHeight = () => 0, lights } = deps;
  const base = { ...DEFAULTS, ...options };
  ensureScratch(THREE);

  // Two shared geometry sets, built once and reused by every cast: tumbling rocks for stone/meteor,
  // point-down shards for ice/gem. Each palette picks one set via `pal.shape`.
  const rockRnd = mulberry32(0x5eed10c5);
  const crystalRnd = mulberry32(0xc0ffee);
  const rockGeos = [], crystalGeos = [];
  for (let v = 0; v < VARIANTS; v++) {
    rockGeos.push(makeRockGeometry(THREE, rockRnd, { flatten: 0.62, jitter: [0.4, 0.32, 0.4] }));
    crystalGeos.push(makeCrystalGeometry(THREE, crystalRnd, { sides: 6, shaftRange: [0.5, 0.7], apexJitter: 0.16 }));
  }
  const chipGeo = new THREE.TetrahedronGeometry(0.5);
  const matCache = new Map();

  function materialsFor(name, pal) {
    let m = matCache.get(name);
    if (m) return m;
    const Physical = NODES?.MeshPhysicalNodeMaterial || THREE.MeshPhysicalMaterial;
    const Standard = NODES?.MeshStandardNodeMaterial || THREE.MeshStandardMaterial;
    const body = pal.kind === 'physical'
      ? new Physical({
        color: 0xffffff, metalness: 0, roughness: pal.roughness, transmission: pal.transmission,
        ior: pal.ior, thickness: pal.thickness, attenuationColor: new THREE.Color(pal.attenuation),
        attenuationDistance: 0.6, dispersion: pal.dispersion, iridescence: pal.iridescence,
        iridescenceIOR: 1.3, clearcoat: 0.5, clearcoatRoughness: 0.1,
        emissive: new THREE.Color(pal.emissive), emissiveIntensity: pal.emissiveIntensity,
        envMapIntensity: 1.4,
      })
      : new Standard({
        color: 0xffffff, roughness: pal.roughness, metalness: pal.metalness, flatShading: true,
        emissive: new THREE.Color(pal.emissive), emissiveIntensity: pal.emissiveIntensity,
      });
    const chip = new Standard({
      color: new THREE.Color(pal.chip), roughness: 0.55, metalness: 0, flatShading: true,
      emissive: new THREE.Color(pal.chipEmissive), emissiveIntensity: pal.kind === 'physical' ? 0.6 : (pal.chipEmissive ? 1.2 : 0),
    });
    m = { body, chip };
    matCache.set(name, m);
    return m;
  }

  function cast({ line, seed = 1, palette = base.palette, power = 1, sourceY = 0.6, targetY = 0.6 } = {}) {
    const o = base;
    const palName = PALETTES[palette] ? palette : base.palette;
    const pal = PALETTES[palName];
    const mats = materialsFor(palName, pal);
    const rnd = mulberry32(seed >>> 0);
    const size = 0.72 + 0.28 * power;
    const group = new THREE.Group();
    group.frustumCulled = false;

    const geos = pal.shape === 'rock' ? rockGeos : crystalGeos;
    const wanted = clamp(Math.round(o.count * pal.countMul * power), 1, o.maxCount);
    const impactStart = Math.max(1, wanted - Math.round(wanted * o.impactFraction));
    const slots = Math.ceil(wanted / VARIANTS);

    const meshes = [];
    for (let v = 0; v < VARIANTS; v++) {
      const mesh = new THREE.InstancedMesh(geos[v], mats.body, slots);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.kind = 'body';
      for (let i = 0; i < slots; i++) mesh.setMatrixAt(i, S.zero);
      group.add(mesh);
      meshes.push(mesh);
    }

    const halfWidth = (s) => lerp(o.widthNear, o.width, Math.pow(saturate(s), o.widthCurve)) * size;
    const records = new Array(wanted);
    for (let i = 0; i < wanted; i++) {
      const impact = i >= impactStart;
      const along = impact ? 1 : Math.pow((i + rnd()) / impactStart, o.frontBias);
      const raw = rnd() * 2 - 1;
      const clumped = Math.sign(raw) * Math.pow(Math.abs(raw), o.clumping);
      const lat = clumped + (rnd() * 2 - 1) * o.scatter;
      const angle = rnd() * TAU;
      const radial = Math.sqrt(rnd());

      line.pointAt(along, S.v);
      let x = S.v.x, z = S.v.z;
      if (impact) {
        const reach = halfWidth(1) * o.impactSpread * radial;
        x += Math.cos(angle) * reach; z += Math.sin(angle) * reach;
      } else {
        const off = lat * halfWidth(along);
        x += line.side.x * off; z += line.side.z * off;
      }

      const grow = lerp(0.75, 1.15, Math.pow(saturate(along), 0.6));
      const r = Math.max(0.02, o.radius * pal.sizeMul * grow * (1 + (rnd() * 2 - 1) * o.radiusJitter) * size);
      const bh = Math.max(0.05, o.bodyHeight * pal.sizeMul * (1 + (rnd() * 2 - 1) * o.bodyHeightJitter) * (impact ? 1.15 : 1) * size);

      const dropH = Math.max(0.4, lerp(o.dropHeightNear, o.dropHeight, Math.pow(saturate(along), o.dropHeightCurve))
        * pal.dropHeightMul * (impact ? 1.15 : 1) * (1 + (rnd() * 2 - 1) * o.dropHeightJitter) * size);
      const groundY = terrainHeight(x, z); // this body's own landing point, not the line's midpoint
      const dropY = groundY + dropH;
      const fallDist = dropY - groundY;
      const fallTime = Math.sqrt(2 * fallDist / o.gravity);

      const ax = rnd() * 2 - 1, ay = rnd() * 2 - 1, az = rnd() * 2 - 1;
      const alen = Math.hypot(ax, ay, az) || 1;
      const axis = { x: ax / alen, y: ay / alen, z: az / alen };
      const tumbleRate = (0.6 + rnd() * 0.8) * o.tumbleSpeed * (rnd() < 0.5 ? -1 : 1);

      const landYaw = rnd() * TAU;
      const leanAngle = o.lean * (rnd() * 2 - 1);
      const lx = rnd() * 2 - 1, lz = rnd() * 2 - 1;
      const llen = Math.hypot(lx, 0, lz) || 1;
      S.axis.set(lx / llen, 0, lz / llen);
      S.q.setFromAxisAngle(S.up, landYaw);
      S.tilt.setFromAxisAngle(S.axis, leanAngle);
      S.q.multiply(S.tilt);
      if (pal.pointDown) S.q.multiply(S.flipDown); // apex-down: the tip is what embeds on landing
      const landQuat = S.q.clone();

      records[i] = {
        along, impact, x, z, groundY, dropY, fallDist, fallTime, r, bh, axis, tumbleRate, landQuat,
        stagger: rnd(), launchTime: -1, landed: false, landAt: -1, big: false, lit: -1, decalIdx: -1,
        variant: i % VARIANTS, slot: (i / VARIANTS) | 0,
      };

      // Palette tint lives in the instance color; the material stays white (see fx-crystals' header).
      S.color.set(pal.base).getHSL(S.hsl);
      S.color.setHSL(
        (S.hsl.h + (rnd() - 0.5) * pal.hueJitter + 1) % 1,
        clamp(S.hsl.s * pal.satMul * (0.85 + rnd() * 0.4), 0, 1),
        clamp(S.hsl.l * (0.8 + rnd() * 0.45), 0, 1),
      );
      meshes[records[i].variant].setColorAt(records[i].slot, S.color);
    }
    for (let v = 0; v < VARIANTS; v++) if (meshes[v].instanceColor) meshes[v].instanceColor.needsUpdate = true;

    // Rank once at cast: the largest body fires onImpact on landing, and the top `bigFraction` share
    // the small decal/light budget. "Largest" is fixed here, not discovered by landing order.
    const order = records.map((_, i) => i).sort((a, b) => (records[b].r * records[b].bh) - (records[a].r * records[a].bh));
    const mainIdx = order[0];
    const bigCount = clamp(Math.round(wanted * o.bigFraction), 1, Math.min(o.maxBig, wanted));
    for (let k = 0; k < bigCount; k++) records[order[k]].big = true;

    // Only meteor carries a light entry; budget at most maxLitLandings of the biggest bodies.
    const litLights = [];
    if (pal.light && lights) {
      const litCount = Math.min(o.maxLitLandings, bigCount);
      for (let k = 0; k < litCount; k++) {
        const l = lights.acquire?.() || null;
        if (!l) continue; // pool exhausted — this landing is simply lit by nothing
        l.color.set(pal.light.color); l.intensity = 0; l.distance = o.lightDistance * size;
        records[order[k]].lit = litLights.length;
        litLights.push({ light: l, landAt: -1 });
      }
    }

    // A scorch/crater decal for the biggest few landings only; everything else just throws dust.
    const decals = [];
    if (o.decals) {
      const decalCount = clamp(Math.round(bigCount * pal.decalMul), 0, o.maxDecals);
      for (let k = 0; k < decalCount; k++) {
        const rec = records[order[k]];
        const d = makeGroundDecal({ THREE, TSL, NODES, radius: Math.max(0.35, rec.r * 3 * o.decalSize), color: pal.chip, mottle: 6, seed: (order[k] * 0.37 + seed * 0.001) % 7 });
        d.mesh.position.set(rec.x, rec.groundY + 0.01, rec.z);
        d.mesh.userData.kind = 'decal';
        d.setOpacity(0);
        group.add(d.mesh);
        rec.decalIdx = decals.length;
        decals.push({ mesh: d.mesh, setOpacity: d.setOpacity, dispose: d.dispose, landAt: -1 });
      }
    }

    const chipCount = o.chips ? clamp(Math.round(wanted * o.chipsPerLanding * pal.chipMul), 8, o.maxChips) : 0;
    const chips = chipCount ? createDebrisPool({
      THREE, geometry: chipGeo, material: mats.chip, max: chipCount,
      gravity: o.chipGravity, bounce: 0.3, drag: 0.6, spin: 10,
      size: o.chipSize * pal.sizeMul * size, scaleY: 1.5, life: [o.chipLife * 0.6, o.chipLife * 1.4], rnd,
    }) : null;
    if (chips) { chips.mesh.userData.kind = 'chip'; group.add(chips.mesh); }

    const dustCount = o.dust ? clamp(Math.round(wanted * o.dustPerLanding * pal.dustMul * 0.5), 12, o.maxDust) : 0;
    const dust = dustCount ? createSpriteParticles({
      THREE, TSL, NODES, cap: dustCount, colorA: pal.chip, colorB: pal.base,
      gravity: 0.6, drag: 1.4, additive: pal.shape === 'crystal', growAtBirth: 0.3, growAtDeath: 1.6, colorEase: 0.5,
    }) : null;
    if (dust) { dust.mesh.userData.kind = 'dust'; group.add(dust.mesh); }

    const trail = pal.trail ? createSpriteParticles({
      THREE, TSL, NODES, cap: o.maxTrail, colorA: pal.emissive, colorB: pal.base,
      gravity: 0, drag: 0.5, additive: true, growAtBirth: 0.2, growAtDeath: 1.2, colorEase: 0.4,
    }) : null;
    if (trail) { trail.mesh.userData.kind = 'trail'; group.add(trail.mesh); }

    function launchUpTo(limit, includeImpact, age) {
      for (let i = 0; i < wanted; i++) {
        const r = records[i];
        if (r.launchTime >= 0) continue;
        if (r.impact && !includeImpact) continue;
        if (!r.impact && r.along > limit) continue;
        r.launchTime = age + r.stagger * o.launchStagger;
      }
    }

    let mainHit = false;
    function onLand(i, age) {
      const r = records[i];
      r.landed = true; r.landAt = age;
      if (chips) chips.emit(r.x, r.groundY + r.bh * 0.15, r.z, Math.round(o.chipsPerLanding * (r.big ? 1.4 : 1)), o.chipSpeed * (r.big ? 1.25 : 1) * size);
      if (dust) {
        const n = Math.max(1, Math.round(o.dustPerLanding * pal.dustMul * (r.big ? 1.6 : 1)));
        for (let k = 0; k < n; k++) {
          const a = rnd() * TAU, sp = o.dustSpeed * (0.4 + rnd() * 0.8) * size;
          dust.emit(r.x, r.groundY + 0.05, r.z, Math.cos(a) * sp, sp * (0.6 + rnd() * 0.6), Math.sin(a) * sp,
            o.dustSize * pal.sizeMul * (0.7 + rnd() * 0.6) * size, o.dustLife * (0.7 + rnd() * 0.5));
        }
      }
      if (r.decalIdx >= 0) decals[r.decalIdx].landAt = age;
      if (r.lit >= 0) {
        litLights[r.lit].landAt = age;
        litLights[r.lit].light.position.set(r.x, r.groundY + o.lightHeight, r.z);
      }
      if (!mainHit && i === mainIdx) { mainHit = true; inst.onImpact?.(); }
    }

    function poseBodies(age, retract) {
      for (let i = 0; i < wanted; i++) {
        const r = records[i];
        const mesh = meshes[r.variant];
        if (r.launchTime < 0) { mesh.setMatrixAt(r.slot, S.zero); continue; }
        const since = age - r.launchTime;
        if (since < 0) { mesh.setMatrixAt(r.slot, S.zero); continue; }
        if (!r.landed && since >= r.fallTime) onLand(i, age);
        if (!r.landed) {
          // Constant-acceleration fall: k = t^2 (== Easing.inQuad), so the body lands exactly on time.
          const k = Easing.inQuad(saturate(since / r.fallTime));
          const y = r.dropY - r.fallDist * k;
          const stretch = 1 + o.streak * Math.sqrt(k); // motion-streak cue: elongates as it accelerates
          S.axis.set(r.axis.x, r.axis.y, r.axis.z);
          S.q.setFromAxisAngle(S.axis, r.tumbleRate * since); // tumble cue
          S.pos.set(r.x, y, r.z);
          S.scale.set(r.r, r.bh * stretch, r.r);
          S.m.compose(S.pos, S.q, S.scale);
          mesh.setMatrixAt(r.slot, S.m);
          if (pal.trail && trail) trail.emit(r.x, y, r.z, 0, -1.2 * size, 0, o.trailSize * size, o.trailLife);
          continue;
        }
        const sink = retract > 0 ? Easing.inCubic(retract) : 0;
        const settleT = saturate((age - r.landAt) / o.settleTime);
        S.axis.set(r.axis.x, r.axis.y, r.axis.z);
        S.qStart.setFromAxisAngle(S.axis, r.tumbleRate * r.fallTime); // tumble angle at the moment of landing
        if (settleT < 1) S.q.copy(S.qStart).slerp(r.landQuat, settleT); else S.q.copy(r.landQuat);
        const embed = o.embedDepth * r.bh * settleT;
        const y = r.groundY - embed - sink * (r.bh + 0.5);
        S.pos.set(r.x, y, r.z);
        const shrink = 1 - 0.2 * sink;
        S.scale.set(r.r * shrink, r.bh * (1 - 0.15 * settleT) * shrink, r.r * shrink);
        S.m.compose(S.pos, S.q, S.scale);
        mesh.setMatrixAt(r.slot, S.m);
      }
      for (let v = 0; v < VARIANTS; v++) meshes[v].instanceMatrix.needsUpdate = true;
    }

    function updateLights() {
      for (const entry of litLights) {
        if (entry.landAt < 0) { entry.light.intensity = 0; continue; }
        const t = machine.age - entry.landAt;
        entry.light.intensity = t < o.flashTime ? o.lightIntensity * pal.light.mul * (1 - t / o.flashTime) : 0;
      }
    }

    function updateDecals(globalFade) {
      for (const d of decals) {
        if (d.landAt < 0) { d.setOpacity(0); continue; }
        const t = machine.age - d.landAt;
        const envIn = saturate(t / o.decalFadeIn);
        const envOut = 1 - saturate((t - o.decalFadeIn - o.decalHold) / o.decalFadeOut);
        d.setOpacity(Math.max(0, envIn * Math.min(1, envOut)) * (1 - globalFade));
      }
    }

    function releaseLights() {
      for (const entry of litLights) {
        entry.light.intensity = 0;
        lights?.release?.(entry.light);
      }
      litLights.length = 0;
    }

    const inst = {
      group, machine: null, onImpact: null, onDone: null,
      update(dt, time) {
        const alive = inst.machine.update(dt, time);
        if (chips) chips.step(dt);
        if (dust) dust.step(dt);
        if (trail) trail.step(dt);
        return alive;
      },
      dispose() {
        releaseLights();
        group.removeFromParent();
        for (let v = 0; v < VARIANTS; v++) meshes[v].dispose();
        if (chips) chips.dispose();
        if (dust) dust.dispose();
        if (trail) trail.dispose();
        for (const d of decals) d.dispose();
      },
    };

    const machine = createPhaseMachine({
      travelSpeed: o.travelSpeed, impactTime: o.holdTime, fadeTime: o.shatterDelay + o.sinkTime,
      onTravel() {
        launchUpTo(this.u, false, this.age);
        poseBodies(this.age, 0);
        updateLights();
        updateDecals(0);
      },
      onImpact() {
        launchUpTo(1, true, this.age); // everything still grounded-out at the caster is released now
      },
      onFade(dt, t) {
        const fadeAge = t > 1 ? (t - 1) * (o.shatterDelay + o.sinkTime) : 0;
        const retract = saturate((fadeAge - o.shatterDelay) / Math.max(0.05, o.sinkTime));
        poseBodies(this.age, retract);
        updateLights();
        updateDecals(saturate(fadeAge / (o.shatterDelay + o.sinkTime)));
      },
      onDestroy() {
        releaseLights();
        inst.onDone?.();
      },
    });

    inst.machine = machine;
    scene?.add(group);
    machine.spawn(line);
    poseBodies(0, 0);
    return inst;
  }

  function dispose() {
    for (let v = 0; v < VARIANTS; v++) { rockGeos[v].dispose(); crystalGeos[v].dispose(); }
    chipGeo.dispose();
    for (const m of matCache.values()) { m.body.dispose(); m.chip.dispose(); }
    matCache.clear();
  }

  return { cast, dispose };
}
