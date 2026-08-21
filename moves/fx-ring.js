/**
 * fx-ring.js — a field of spikes erupting around a ring instead of along a line: hazards planted on
 * the target's ground and defensive walls raised around the caster.
 *
 * `fx-crystals.js` is the donor. Its picture is one beat: a front races away from the caster, spikes
 * punch up as it passes over them, the field stands, then it sinks back and the chips it threw are all
 * that is left. Two reviews of that file agreed on the seam to cut along: keep the per-spike record
 * (position, height, radius, lean quaternion, stagger, eruption time, breach flag, variant/slot) and
 * the eruption timing (`emergence`/`poseSpikes`, outBack rise, inCubic sink) untouched in spirit, and
 * swap only the block that decides where a spike goes and when it fires. Here that block places spikes
 * on a closed circle (`buildRing`, from `move-parts.js`) instead of a band that opens toward a target,
 * and — following `fx-aurora.js`'s lead on treating the phase machine's `u` as a swept angle rather than
 * a travelled distance — triggers each spike by the ring angle it sits at instead of by distance along
 * a line. There is no terminal "impact cluster" the way crystals has one at the far end of its line;
 * a ring has no far end, so that field of the donor's record is dropped rather than carried over unused.
 *
 * Two centres, one module. `centre: 'target'` plants the ring on the ground under the opponent (a
 * hazard); `centre: 'origin'` raises it around the caster (a defensive buff). Each palette below picks
 * a sensible default and a per-cast option can still override it. The harness never has a `move.self`
 * flag to hand `cast()` (see `demos/pokemon-moves.html`'s `castMove`), so this module uses the resolved
 * centre as a stand-in for "is this a self-cast": `origin` casts use an explicit `travelTime` for the
 * sweep, the way `fx-aurora.js` does, because a self move's line is clamped to `makeLine`'s 5 cm minimum
 * length and a speed-based sweep over that distance would finish in a single frame; `target` casts use
 * `travelSpeed` against the real attacker-to-target distance, the way `fx-crystals.js` does. That
 * assumption holds for every row the registry can add under this module's contract (hazards are cast on
 * the target, buffs on the caster) but it is a proxy, not a real flag, and it is worth knowing about if a
 * future move ever wants a `target`-centred ring on a `self` cast.
 *
 * Geometry is one shared part doing five jobs: `makeCrystalGeometry` (`move-parts.js`) builds a faceted
 * prism inside a unit cube (base at y=0, apex at y=1), and every palette below is nothing but a
 * different set of options into it plus a different outer (width, height) scale at placement time — a
 * barb is thin and short, a plate is wide and flat with almost no taper, a shard is the tall chunky cage
 * spike crystals already shipped. `stone` leans its spikes toward the ring's centre (a closing cage);
 * `steel` leans its plates away from it (a fanned-out shield). Chips are `createDebrisPool`
 * (`move-parts.js`) instead of crystals' hand-rolled pool, per the brief. `web`'s pegs are the same
 * shared geometry, very short and blunt; the strands between them are this module's own addition (no
 * shared part covers "thin quad between two moving points") — a box per ring-adjacent pair, oriented and
 * scaled every frame from the two pegs' current emergence height, hidden whenever either peg has not
 * yet broken the surface or the field is retracting. That per-frame lookup re-derives the same
 * (position, scale) pair `poseSpikes` computes for the pegs themselves; both call the same `spikePose`
 * helper so there is exactly one formula for "where is this spike right now," not two copies to keep in
 * sync.
 *
 * A ring effect has no travelling front for a light to ride, so unlike crystals' light that chases the
 * front along the line, this module's one pooled light (acquired only for palettes that want a glow) sits
 * fixed at the centre for the whole cast and only its intensity animates.
 */

import { createPhaseMachine, mulberry32, hashSeed, Easing, saturate, lerp } from './move-core.js';
import { buildRing, makeCrystalGeometry, createDebrisPool } from './move-parts.js';

const TAU = Math.PI * 2;
const VARIANTS = 3;
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export const PALETTES = {
  // Stealth Rock, Rock Tomb: a cage of rock closing in over the target. Tall, chunky, leans inward.
  stone: {
    kind: 'standard', base: 0x8b8175, emissive: 0x000000, emissiveIntensity: 0,
    hueJitter: 0.05, satMul: 0.7, roughness: 0.92, metalness: 0.03,
    chip: 0x6f665c, chipEmissive: 0x000000,
    geo: { sides: 6, shaftRange: [0.55, 0.75], taperRange: [0.72, 0.88], apexJitter: 0.16, baseRadius: [0.2, 0.3] },
    heightRange: [1.05, 1.65], radiusRange: [0.15, 0.23], lean: -0.4,
    count: 26, ringRadius: 1.3, centre: 'target', light: null,
  },
  // Toxic Spikes: small purple barbs, dense and low, a faint poisoned glow seeping out of them.
  toxic: {
    kind: 'standard', base: 0x8a3fd0, emissive: 0xb060ff, emissiveIntensity: 0.4,
    hueJitter: 0.08, satMul: 1.1, roughness: 0.5, metalness: 0,
    chip: 0x7a2fc0, chipEmissive: 0x9040e0,
    geo: { sides: 4, shaftRange: [0.4, 0.6], taperRange: [0.5, 0.68], apexJitter: 0.24, baseRadius: [0.08, 0.13] },
    heightRange: [0.26, 0.46], radiusRange: [0.045, 0.08], lean: 0.15,
    count: 64, ringRadius: 0.9, centre: 'target', light: { color: 0xb060ff, mul: 0.6 },
  },
  // Sticky Web: low anchor pegs joined by translucent strands, not spikes so much as a snare.
  web: {
    kind: 'standard', base: 0xd8d0c0, emissive: 0x000000, emissiveIntensity: 0,
    hueJitter: 0.03, satMul: 0.4, roughness: 0.8, metalness: 0,
    chip: 0xc8c0b0, chipEmissive: 0x000000,
    geo: { sides: 4, shaftRange: [0.78, 0.92], taperRange: [0.86, 0.98], apexJitter: 0.05, baseRadius: [0.06, 0.1] },
    heightRange: [0.14, 0.24], radiusRange: [0.04, 0.065], lean: 0,
    count: 30, ringRadius: 1.4, centre: 'target', light: null,
    strand: { color: 0xf2ede0, opacity: 0.35, width: 0.028 },
  },
  // Iron Defense: flat plates fanned outward around the body, short and wide, not pointed.
  steel: {
    kind: 'standard', base: 0xb9c2cc, emissive: 0x000000, emissiveIntensity: 0,
    hueJitter: 0.02, satMul: 0.3, roughness: 0.35, metalness: 0.85,
    chip: 0x9aa4ad, chipEmissive: 0x000000,
    geo: { sides: 4, shaftRange: [0.84, 0.94], taperRange: [0.94, 1.0], apexJitter: 0.02, baseRadius: [0.4, 0.55] },
    heightRange: [0.3, 0.44], radiusRange: [0.4, 0.56], lean: 0.4,
    count: 12, ringRadius: 0.95, centre: 'origin', light: null,
  },
  // Barrier / Withdraw / Harden / Cotton Guard: translucent panels standing up around the caster.
  glass: {
    kind: 'physical', base: 0xdfeeff, attenuation: 0x8fbfe8, emissive: 0x9fd0ff, emissiveIntensity: 0.1,
    hueJitter: 0.02, satMul: 1.0, transmission: 0.75, roughness: 0.08, ior: 1.5, thickness: 0.35,
    iridescence: 0.2, dispersion: 0.15, chip: 0xeaf6ff, chipEmissive: 0x3f8fd0,
    geo: { sides: 4, shaftRange: [0.82, 0.92], taperRange: [0.94, 1.0], apexJitter: 0.02, baseRadius: [0.28, 0.4] },
    heightRange: [0.85, 1.25], radiusRange: [0.28, 0.4], lean: 0.12,
    count: 14, ringRadius: 1.1, centre: 'origin', light: { color: 0xbfe0ff, mul: 0.85 },
  },
};

const DEFAULTS = {
  palette: 'stone',
  count: 30, maxCount: 200,               // spikes at power 1, and the hard ceiling
  ringRadius: 1.2, radialJitter: 0.3, angleJitter: 0.35, heightJitter: 0.3, radiusJitter: 0.25,
  travelSpeed: 10, travelTimeSelf: 0.85,  // hazard sweep speed (m/s) vs. self-buff sweep duration (s)
  holdTime: 1.1, shatterDelay: 0.22, sinkTime: 0.9,
  riseTime: 0.22, riseStagger: 0.16,      // per-spike eruption, and the spread of trigger times
  leanJitter: 0.4, twist: 1,
  rubbleChance: 0.2, rubbleScale: 0.42,
  chips: true, chipsPerSpike: 3, maxChips: 160, chipSize: 0.08,
  chipSpeed: 2.6, chipGravity: -10, chipLife: 0.75,
  lightIntensity: 10, lightDistance: 8, lightHeight: 0.6,
};

// Scratch, filled from deps.THREE on the first factory call — nothing here allocates per frame.
let S = null;
function ensureScratch(THREE) {
  if (S) return S;
  S = {
    v: new THREE.Vector3(), lean: new THREE.Vector3(), axis: new THREE.Vector3(),
    up: new THREE.Vector3(0, 1, 0), right: new THREE.Vector3(1, 0, 0),
    pos: new THREE.Vector3(), scale: new THREE.Vector3(),
    q: new THREE.Quaternion(), spin: new THREE.Quaternion(), m: new THREE.Matrix4(),
    zero: new THREE.Matrix4().makeScale(0, 0, 0), color: new THREE.Color(), hsl: { h: 0, s: 0, l: 0 },
  };
  return S;
}

export function createRingFx(deps, options = {}) {
  const { THREE, NODES, scene } = deps;
  const terrainHeight = deps.terrainHeight || (() => 0);
  const lightPool = deps.lights || { acquire: () => null, release: () => {} };
  const base = { ...DEFAULTS, ...options };
  ensureScratch(THREE);

  const chipGeo = new THREE.TetrahedronGeometry(0.5);
  const strandGeo = new THREE.BoxGeometry(1, 1, 1); // stretched per-instance into a strand
  const geoCache = new Map();   // palette name -> VARIANTS geometries, built once, seed independent of cast
  const matCache = new Map();   // palette name -> { crystal, chip, strand }

  function geosFor(name, pal) {
    let g = geoCache.get(name);
    if (g) return g;
    const grnd = mulberry32(hashSeed(`ring-geo:${name}`));
    g = [];
    for (let v = 0; v < VARIANTS; v++) g.push(makeCrystalGeometry(THREE, grnd, pal.geo));
    geoCache.set(name, g);
    return g;
  }

  function materialsFor(name, pal) {
    let m = matCache.get(name);
    if (m) return m;
    const Physical = NODES?.MeshPhysicalNodeMaterial || THREE.MeshPhysicalMaterial;
    const Standard = NODES?.MeshStandardNodeMaterial || THREE.MeshStandardMaterial;
    const Basic = NODES?.MeshBasicNodeMaterial || THREE.MeshBasicMaterial;
    const crystal = pal.kind === 'physical'
      ? new Physical({
        color: 0xffffff, metalness: 0, roughness: pal.roughness, transmission: pal.transmission,
        ior: pal.ior, thickness: pal.thickness, attenuationColor: new THREE.Color(pal.attenuation),
        attenuationDistance: 0.6, dispersion: pal.dispersion, iridescence: pal.iridescence,
        iridescenceIOR: 1.3, clearcoat: 0.4, clearcoatRoughness: 0.15,
        emissive: new THREE.Color(pal.emissive), emissiveIntensity: pal.emissiveIntensity,
        envMapIntensity: 1.5,
      })
      : new Standard({
        color: 0xffffff, roughness: pal.roughness, metalness: pal.metalness, flatShading: true,
        emissive: new THREE.Color(pal.emissive), emissiveIntensity: pal.emissiveIntensity,
      });
    const chip = new Standard({
      color: new THREE.Color(pal.chip), roughness: 0.5, metalness: 0, flatShading: true,
      emissive: new THREE.Color(pal.chipEmissive), emissiveIntensity: pal.kind === 'physical' ? 0.8 : 0,
    });
    const strand = pal.strand ? new Basic({
      color: new THREE.Color(pal.strand.color), transparent: true, opacity: pal.strand.opacity,
      depthWrite: false,
    }) : null;
    m = { crystal, chip, strand };
    matCache.set(name, m);
    return m;
  }

  function cast({ line, seed = 1, palette = base.palette, power = 1 } = {}) {
    // sourceY/targetY are unused: like crystals and aurora, a ring sits on the ground, not at mouth height.
    const o = base;
    const palName = PALETTES[palette] ? palette : base.palette;
    const pal = PALETTES[palName];
    const mats = materialsFor(palName, pal);
    const geos = geosFor(palName, pal);
    const rnd = mulberry32(seed >>> 0);
    const size = 0.75 + 0.25 * power;

    const centreMode = options.centre || pal.centre || 'target';
    const anchor = centreMode === 'origin' ? line.origin : line.target;
    const centre = { x: anchor.x, y: anchor.y, z: anchor.z };
    const ringRadius = (pal.ringRadius ?? o.ringRadius) * Math.pow(clamp(power, 0.05, 4), 0.3);

    const group = new THREE.Group();
    group.frustumCulled = false;
    group.position.set(centre.x, centre.y, centre.z);

    const wanted = clamp(Math.round((pal.count ?? o.count) * power), 1, o.maxCount);
    const slots = Math.ceil(wanted / VARIANTS);
    const ring = buildRing({ segments: wanted, radius: ringRadius, ox: centre.x, oy: centre.y, oz: centre.z, terrainHeight });

    const meshes = [];
    for (let v = 0; v < VARIANTS; v++) {
      const mesh = new THREE.InstancedMesh(geos[v], mats.crystal, slots);
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      for (let i = 0; i < slots; i++) mesh.setMatrixAt(i, S.zero);
      group.add(mesh);
      meshes.push(mesh);
    }

    const records = new Array(wanted);
    for (let i = 0; i < wanted; i++) {
      const p = ring[i]; // local {x, y, z, u, sx, sz} around the ring, from buildRing
      const rubble = rnd() < o.rubbleChance;

      // Jitter the angle by rotating the ring's own radial direction, then jitter the radius along it.
      const slotAngle = (TAU / wanted) * o.angleJitter * (rnd() - 0.5);
      const ca = Math.cos(slotAngle), sa = Math.sin(slotAngle);
      const sx = p.sx * ca - p.sz * sa, sz = p.sx * sa + p.sz * ca;
      const rad = ringRadius * (1 + (rnd() * 2 - 1) * o.radialJitter);
      const x = sx * rad, z = sz * rad;
      const baseY = terrainHeight(centre.x + x, centre.z + z) - centre.y;

      let h = lerp(pal.heightRange[0], pal.heightRange[1], rnd());
      h *= 1 + (rnd() * 2 - 1) * o.heightJitter;
      if (rubble) h *= o.rubbleScale;
      h = Math.max(0.02, h * size);
      const r = Math.max(0.012, lerp(pal.radiusRange[0], pal.radiusRange[1], rnd())
        * (1 + (rnd() * 2 - 1) * o.radiusJitter) * (rubble ? 1.25 : 1) * size);

      // Lean toward the centre (pal.lean < 0, a closing cage) or away from it (pal.lean > 0, a fanned shield).
      const leanSign = Math.sign(pal.lean) || 1;
      S.lean.set(sx * leanSign, 0, sz * leanSign);
      if (S.lean.lengthSq() < 1e-6) S.lean.set(0, 0, 1);
      S.lean.normalize();
      S.axis.crossVectors(S.up, S.lean).normalize();
      const leanAngle = Math.abs(pal.lean) * (1 + (rnd() * 2 - 1) * o.leanJitter);
      const quat = new THREE.Quaternion();
      if (S.axis.lengthSq() > 1e-6) quat.setFromAxisAngle(S.axis, leanAngle);
      quat.multiply(S.spin.setFromAxisAngle(S.up, rnd() * TAU * o.twist));

      records[i] = {
        along: p.u, x, z, baseY, height: h, radius: r, quat,
        stagger: rnd(), eruptTime: -1, breached: false,
        variant: i % VARIANTS, slot: (i / VARIANTS) | 0,
      };

      S.color.set(pal.base).getHSL(S.hsl);
      S.color.setHSL(
        (S.hsl.h + (rnd() - 0.5) * pal.hueJitter + 1) % 1,
        clamp(S.hsl.s * pal.satMul * (0.85 + rnd() * 0.4), 0, 1),
        clamp(S.hsl.l * (0.78 + rnd() * 0.5), 0, 1),
      );
      meshes[records[i].variant].setColorAt(records[i].slot, S.color);
    }
    for (let v = 0; v < VARIANTS; v++) if (meshes[v].instanceColor) meshes[v].instanceColor.needsUpdate = true;

    // Strands (web only): one box per ring-adjacent pair, closing the loop, hidden until both pegs are up.
    let strandMesh = null;
    if (mats.strand && wanted >= 2) {
      strandMesh = new THREE.InstancedMesh(strandGeo, mats.strand, wanted);
      strandMesh.frustumCulled = false;
      for (let i = 0; i < wanted; i++) strandMesh.setMatrixAt(i, S.zero);
      group.add(strandMesh);
    }

    const debris = createDebrisPool({
      THREE, geometry: chipGeo, material: mats.chip, max: o.maxChips,
      gravity: o.chipGravity, bounce: 0.28, drag: 0.6, size: o.chipSize * size, life: [o.chipLife * 0.7, o.chipLife * 1.4], rnd,
    });
    if (o.chips) group.add(debris.mesh);

    /** 0 -> 1 with an easeOutBack punch through the surface; negative while still buried. */
    function emergence(r, age) {
      if (r.eruptTime < 0) return -1;
      const e = age - r.eruptTime;
      if (e < 0) return -1;
      const t = saturate(e / Math.max(0.02, o.riseTime));
      return t >= 1 ? 1 : Easing.outBack(t);
    }

    /** The single formula for "where is this spike right now" — poseSpikes and the strands both read it. */
    function spikePose(r, emerge, sink) {
      const k = Math.min(1, emerge);
      const y = r.baseY + (emerge - 1) * r.height * 0.85 - sink * (r.height + 0.4);
      const w = r.radius * lerp(0.68, 1, k) * (1 - 0.3 * sink);
      const h = r.height * lerp(0.9, 1, k) * (1 - 0.2 * sink);
      return { y, w, h };
    }

    function triggerUpTo(limit, age) {
      for (let i = 0; i < wanted; i++) {
        const r = records[i];
        if (r.eruptTime >= 0) continue;
        if (r.along > limit) continue;
        r.eruptTime = age + r.stagger * o.riseStagger;
      }
    }

    function poseSpikes(age, retract) {
      const sink = retract > 0 ? Easing.inCubic(retract) : 0;
      for (let i = 0; i < wanted; i++) {
        const r = records[i];
        const mesh = meshes[r.variant];
        const emerge = emergence(r, age);
        if (emerge < 0) { mesh.setMatrixAt(r.slot, S.zero); continue; }
        if (!r.breached && emerge > 0.3) { r.breached = true; debris.emit(r.x, r.baseY + 0.05, r.z, o.chipsPerSpike, o.chipSpeed); }
        const p = spikePose(r, emerge, sink);
        S.pos.set(r.x, p.y, r.z);
        S.m.compose(S.pos, r.quat, S.scale.set(p.w, p.h, p.w));
        mesh.setMatrixAt(r.slot, S.m);
      }
      for (let v = 0; v < VARIANTS; v++) meshes[v].instanceMatrix.needsUpdate = true;

      if (strandMesh) {
        for (let i = 0; i < wanted; i++) {
          const a = records[i], b = records[(i + 1) % wanted];
          const ea = emergence(a, age), eb = emergence(b, age);
          if (ea <= 0 || eb <= 0 || sink > 0.35) { strandMesh.setMatrixAt(i, S.zero); continue; }
          const pa = spikePose(a, ea, sink), pb = spikePose(b, eb, sink);
          const ax = a.x, az = a.z, ay = pa.y + pa.h, bx = b.x, bz = b.z, by = pb.y + pb.h; // approx tip of each peg
          const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5, mz = (az + bz) * 0.5;
          const dx = bx - ax, dy = by - ay, dz = bz - az;
          const len = Math.max(1e-4, Math.hypot(dx, dy, dz));
          S.axis.set(dx / len, dy / len, dz / len);
          S.q.setFromUnitVectors(S.right, S.axis);
          S.pos.set(mx, my, mz);
          S.m.compose(S.pos, S.q, S.scale.set(len, pal.strand.width, pal.strand.width));
          strandMesh.setMatrixAt(i, S.m);
        }
        strandMesh.instanceMatrix.needsUpdate = true;
      }
    }

    let light = pal.light && lightPool ? (lightPool.acquire?.() || null) : null;
    if (light) {
      light.color.set(pal.light.color);
      light.intensity = 0;
      light.distance = o.lightDistance * size;
      light.position.set(centre.x, centre.y + o.lightHeight, centre.z); // fixed at the ring's centre — no front to chase
    }
    function releaseLight() {
      if (!light) return;
      light.intensity = 0;
      lightPool?.release?.(light);
      light = null;
    }

    const inst = {
      group, machine: null, onImpact: null, onDone: null,
      update(dt, time) {
        const alive = inst.machine.update(dt, time);
        if (o.chips) debris.step(dt);
        return alive;
      },
      dispose() {
        releaseLight();
        group.removeFromParent();
        for (let v = 0; v < VARIANTS; v++) meshes[v].dispose();
        if (strandMesh) strandMesh.dispose();
        debris.dispose();
      },
    };

    // origin (self) casts get an explicit sweep duration, since their line is clamped to ~5cm and a
    // speed-based sweep over that distance would close the ring in a single frame — see the header note.
    const machine = createPhaseMachine({
      travelSpeed: centreMode === 'origin' ? 0 : o.travelSpeed,
      travelTime: centreMode === 'origin' ? o.travelTimeSelf : 0,
      impactTime: o.holdTime, fadeTime: o.shatterDelay + o.sinkTime, easeIn: 0.06,
      onTravel() {
        triggerUpTo(this.u, this.age);
        poseSpikes(this.age, 0);
        if (light) light.intensity = o.lightIntensity * pal.light.mul * power * saturate(this.age / 0.12);
      },
      onImpact() {
        triggerUpTo(1, this.age); // close the seam: anything still buried near u=1 goes up now
        if (light) light.intensity = o.lightIntensity * pal.light.mul * power;
        inst.onImpact?.();
      },
      onFade(dt, t) {
        const fadeAge = t > 1 ? (t - 1) * (o.shatterDelay + o.sinkTime) : 0;
        const retract = saturate((fadeAge - o.shatterDelay) / Math.max(0.05, o.sinkTime));
        poseSpikes(this.age, retract);
        if (light) {
          const flash = t < 1 ? lerp(1.6, 1, Easing.outCubic(t)) : (1 - saturate(fadeAge / (o.shatterDelay + o.sinkTime)));
          light.intensity = o.lightIntensity * pal.light.mul * power * Math.max(0, flash);
        }
      },
      onDestroy() {
        releaseLight();
        inst.onDone?.();
      },
    });

    inst.machine = machine;
    scene?.add(group);
    machine.spawn(line);
    poseSpikes(0, 0);
    return inst;
  }

  function dispose() {
    chipGeo.dispose();
    strandGeo.dispose();
    for (const g of geoCache.values()) for (const geo of g) geo.dispose();
    geoCache.clear();
    for (const m of matCache.values()) { m.crystal.dispose(); m.chip.dispose(); m.strand?.dispose(); }
    matCache.clear();
  }

  return { cast, dispose };
}
