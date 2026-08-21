/**
 * fx-crystals.js — a crystal field that tears out of the ground along the cast line.
 *
 * The picture is one beat drawn out: a fracture front races away from the caster, spikes punch up
 * behind it as the front passes over them, the field stands while the hit registers, then it sinks
 * back into the floor and the chips it threw are all that is left.
 *
 * Two references are fused here. The *crystals* are ported from GeometryPainterThreeJS's
 * `modes/crystals.ts`: the hexagonal quartz point (jittered facet columns, slight taper, off-axis
 * pyramidal termination, non-indexed so every facet is genuinely flat), the palette-tint-in-the-
 * instance-color rule (tinting the material as well multiplies the tint into itself and the glass
 * goes dark), and the easeOutBack growth keyed off a per-crystal birth distance.
 *
 * The *placement and timing* are from LinearAbiltyCastingThreeJS's `IceAbility.js`: a band whose
 * half-width and spike height both open up from the caster toward the target (small and dense at
 * your feet, a wall of blades at the far end), a terminal cluster scattered around the impact point
 * on a sqrt-distributed radius, `frontBias` crowding the field forward, a domed crown so the flanks
 * are shorter than the spine, per-spike stagger off the front, and Easing.inCubic retraction.
 *
 * A spike stores its resolved position/height/lean once at cast time (the line does not move, unlike
 * the reference's live-tuned editor) and only its matrix is touched per frame, so the update loop is
 * a matrix compose per instance and nothing else. Geometry and materials are shared across casts.
 *
 * Palettes: `ice` (transmissive iridescent glass), `stone` (opaque flat-shaded rock, no light),
 * `psychic` (emissive magenta/violet). The palette picks the material; the geometry is the same.
 */

import { createPhaseMachine, mulberry32, Easing, saturate } from './move-core.js';

const TAU = Math.PI * 2;
const VARIANTS = 3;
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => { const t = saturate((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export const PALETTES = {
  // Refractive glass: white base + colored absorption, exactly as the reference's Ice.
  ice: {
    kind: 'physical', base: 0xcfe8ff, attenuation: 0x5aa6e8, emissive: 0x7fc4ff, emissiveIntensity: 0.12,
    hueJitter: 0.03, satMul: 1.1, transmission: 0.72, roughness: 0.05, ior: 1.55, thickness: 0.4,
    iridescence: 0.45, dispersion: 0.3, chip: 0xdff0ff, chipEmissive: 0x2a6fa8,
    light: { color: 0x9fd4ff, mul: 1 },
  },
  // Stone Edge: opaque rough rock. Flat shading is what makes the facets read without any gloss.
  stone: {
    kind: 'standard', base: 0x8b8175, emissive: 0x000000, emissiveIntensity: 0,
    hueJitter: 0.05, satMul: 0.7, roughness: 0.92, metalness: 0.02,
    chip: 0x6f665c, chipEmissive: 0x000000,
    light: null,
  },
  // Psychic: half-clear violet glass lit from inside, so it blooms without washing out its facets.
  psychic: {
    kind: 'physical', base: 0xd07aff, attenuation: 0x8a1fd6, emissive: 0xff3ce0, emissiveIntensity: 1.7,
    hueJitter: 0.09, satMul: 1.2, transmission: 0.45, roughness: 0.09, ior: 1.6, thickness: 0.5,
    iridescence: 0.6, dispersion: 0.45, chip: 0xff9cf0, chipEmissive: 0xd020c0,
    light: { color: 0xff44dd, mul: 1.15 },
  },
};

const DEFAULTS = {
  palette: 'ice',
  count: 60, maxCount: 240,              // spikes at power 1, and the hard ceiling
  travelSpeed: 13, holdTime: 0.9,        // front speed (m/s) and how long the field stands
  shatterDelay: 0.25, sinkTime: 1.0,     // fade = delay + sink
  riseTime: 0.24, riseStagger: 0.14,     // per-spike eruption, and the spread of trigger times
  height: 1.6, heightNear: 0.34, heightCurve: 1.2,
  radius: 0.2, radiusJitter: 0.3, heightJitter: 0.35,
  width: 1.5, widthNear: 0.32, widthCurve: 1.35,
  peak: 1.5, peakWidth: 0.28, crown: 0.45,
  frontBias: 0.85, clumping: 1.4, scatter: 0.3, impactFraction: 0.22,
  rubbleChance: 0.28, rubbleScale: 0.38,
  lean: 0.32, leanJitter: 0.5, twist: 1,
  chips: true, chipsPerSpike: 3, maxChips: 180, chipSize: 0.09,
  chipSpeed: 3.2, chipGravity: -11, chipLife: 0.8,
  lightIntensity: 14, lightDistance: 10, lightHeight: 0.9,
};

// Scratch, filled from deps.THREE on the first factory call — nothing here allocates per frame.
let S = null;
function ensureScratch(THREE) {
  if (S) return S;
  S = {
    v: new THREE.Vector3(), lean: new THREE.Vector3(), axis: new THREE.Vector3(),
    up: new THREE.Vector3(0, 1, 0), pos: new THREE.Vector3(), scale: new THREE.Vector3(),
    q: new THREE.Quaternion(), spin: new THREE.Quaternion(), m: new THREE.Matrix4(),
    zero: new THREE.Matrix4().makeScale(0, 0, 0), color: new THREE.Color(), hsl: { h: 0, s: 0, l: 0 },
  };
  return S;
}

/**
 * A quartz point: hexagonal prism, one jitter per facet column so the edges stay straight top to
 * bottom, a taper into an off-axis apex. Non-indexed → true flat facets. Height 1, base at y = 0.
 */
function makeCrystalGeometry(THREE, rnd) {
  const sides = 6;
  const baseR = 0.16 + rnd() * 0.1;
  const shaftH = 0.55 + rnd() * 0.2;
  const taper = 0.78 + rnd() * 0.16;
  const apex = [(rnd() - 0.5) * 0.14, 1, (rnd() - 0.5) * 0.14];
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

export function createCrystalsFx(deps, options = {}) {
  const { THREE, NODES, scene, terrainHeight = () => 0, lights } = deps;
  const base = { ...DEFAULTS, ...options };
  ensureScratch(THREE);

  const geoRnd = mulberry32(0xc0ffee);
  const geos = [];
  for (let v = 0; v < VARIANTS; v++) geos.push(makeCrystalGeometry(THREE, geoRnd));
  const chipGeo = new THREE.TetrahedronGeometry(0.5);
  const matCache = new Map();

  function materialsFor(name, pal) {
    let m = matCache.get(name);
    if (m) return m;
    const Physical = NODES?.MeshPhysicalNodeMaterial || THREE.MeshPhysicalMaterial;
    const Standard = NODES?.MeshStandardNodeMaterial || THREE.MeshStandardMaterial;
    const crystal = pal.kind === 'physical'
      ? new Physical({
        color: 0xffffff, metalness: 0, roughness: pal.roughness, transmission: pal.transmission,
        ior: pal.ior, thickness: pal.thickness, attenuationColor: new THREE.Color(pal.attenuation),
        attenuationDistance: 0.6, dispersion: pal.dispersion, iridescence: pal.iridescence,
        iridescenceIOR: 1.3, clearcoat: 0.5, clearcoatRoughness: 0.12,
        emissive: new THREE.Color(pal.emissive), emissiveIntensity: pal.emissiveIntensity,
        envMapIntensity: 1.6,
      })
      : new Standard({
        color: 0xffffff, roughness: pal.roughness, metalness: pal.metalness, flatShading: true,
        emissive: new THREE.Color(pal.emissive), emissiveIntensity: pal.emissiveIntensity,
      });
    const chip = new Standard({
      color: new THREE.Color(pal.chip), roughness: 0.5, metalness: 0, flatShading: true,
      emissive: new THREE.Color(pal.chipEmissive), emissiveIntensity: pal.kind === 'physical' ? 0.8 : 0,
    });
    m = { crystal, chip };
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

    const wanted = clamp(Math.round(o.count * power), 1, o.maxCount);
    const impactStart = Math.max(1, wanted - Math.round(wanted * o.impactFraction));
    const slots = Math.ceil(wanted / VARIANTS);

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

    const halfWidth = (s) => lerp(o.widthNear, o.width, Math.pow(saturate(s), o.widthCurve)) * size;
    const records = new Array(wanted);
    for (let i = 0; i < wanted; i++) {
      const impact = i >= impactStart;
      const along = impact ? 1 : Math.pow((i + rnd()) / impactStart, o.frontBias);
      const raw = rnd() * 2 - 1;
      const clumped = Math.sign(raw) * Math.pow(Math.abs(raw), o.clumping);
      const lat = clumped + (rnd() * 2 - 1) * o.scatter;
      const angle = rnd() * TAU;
      const radial = Math.sqrt(rnd()); // even density, not piled in the middle
      const rubble = rnd() < o.rubbleChance;

      line.pointAt(along, S.v);
      let x = S.v.x, z = S.v.z;
      if (impact) {
        const reach = halfWidth(1) * 1.25 * radial;
        x += Math.cos(angle) * reach; z += Math.sin(angle) * reach;
      } else {
        const off = lat * halfWidth(along);
        x += line.side.x * off; z += line.side.z * off;
      }

      let h = lerp(o.heightNear, o.height, Math.pow(saturate(along), o.heightCurve));
      h *= 1 + (o.peak - 1) * smoothstep(1 - o.peakWidth, 1, along);      // swell at the impact point
      const edge = impact ? radial : saturate(Math.abs(lat));
      h *= lerp(1, 1 - saturate(o.crown), Math.pow(edge, 1.4));           // domed: flanks under the spine
      h *= 1 + (rnd() * 2 - 1) * o.heightJitter;
      if (rubble) h *= o.rubbleScale;
      h = Math.max(0.03, h * size);

      const grow = lerp(0.72, 1.15, Math.pow(saturate(along), 0.6));
      const r = Math.max(0.015, o.radius * grow * (1 + (rnd() * 2 - 1) * o.radiusJitter) * (rubble ? 1.3 : 1) * size);

      // Lean away from the caster and outward across the band, then spin about its own axis.
      const outward = impact ? Math.sign(Math.cos(angle)) * radial : lat;
      S.lean.set(line.dir.x, 0, line.dir.z).multiplyScalar(0.75)
        .addScaledVector(S.v.set(line.side.x, 0, line.side.z), outward * 0.85);
      if (S.lean.lengthSq() < 1e-6) S.lean.set(line.dir.x, 0, line.dir.z);
      S.lean.normalize();
      S.axis.crossVectors(S.up, S.lean).normalize();
      const leanAngle = o.lean * (0.35 + 0.65 * along) * (1 + (rnd() * 2 - 1) * o.leanJitter);
      const quat = new THREE.Quaternion().setFromAxisAngle(S.axis, leanAngle);
      quat.multiply(S.spin.setFromAxisAngle(S.up, rnd() * TAU * o.twist));

      records[i] = {
        along, impact, x, z, baseY: terrainHeight(x, z), height: h, radius: r, quat,
        stagger: rnd(), eruptTime: -1, breached: false,
        variant: i % VARIANTS, slot: (i / VARIANTS) | 0,
      };

      // Palette tint lives in the instance color; the material stays white (see the header docblock).
      S.color.set(pal.base).getHSL(S.hsl);
      S.color.setHSL(
        (S.hsl.h + (rnd() - 0.5) * pal.hueJitter + 1) % 1,
        clamp(S.hsl.s * pal.satMul * (0.85 + rnd() * 0.4), 0, 1),
        clamp(S.hsl.l * (0.78 + rnd() * 0.5), 0, 1),
      );
      meshes[records[i].variant].setColorAt(records[i].slot, S.color);
    }
    for (let v = 0; v < VARIANTS; v++) if (meshes[v].instanceColor) meshes[v].instanceColor.needsUpdate = true;

    // Chip pool: a flat ring of shards, reused round-robin, integrated with gravity and a bounce.
    const chipCount = o.chips ? Math.min(o.maxChips, Math.max(8, wanted * o.chipsPerSpike)) : 0;
    let chipMesh = null, chipCursor = 0, chipsLive = 0;
    const chip = chipCount ? {
      px: new Float32Array(chipCount), py: new Float32Array(chipCount), pz: new Float32Array(chipCount),
      vx: new Float32Array(chipCount), vy: new Float32Array(chipCount), vz: new Float32Array(chipCount),
      gy: new Float32Array(chipCount), life: new Float32Array(chipCount), spin: new Float32Array(chipCount),
      ang: new Float32Array(chipCount), ax: new Float32Array(chipCount), az: new Float32Array(chipCount),
    } : null;
    if (chipCount) {
      chipMesh = new THREE.InstancedMesh(chipGeo, mats.chip, chipCount);
      chipMesh.frustumCulled = false;
      chipMesh.userData.moveComponent = 'particles';
      for (let i = 0; i < chipCount; i++) chipMesh.setMatrixAt(i, S.zero);
      group.add(chipMesh);
    }

    function emitChips(x, y, z, n, speed) {
      if (!chipCount) return;
      for (let k = 0; k < n; k++) {
        const i = chipCursor; chipCursor = (chipCursor + 1) % chipCount;
        if (chip.life[i] <= 0) chipsLive++;
        const a = rnd() * TAU, sp = speed * (0.5 + rnd());
        chip.px[i] = x + Math.cos(a) * 0.05; chip.py[i] = y; chip.pz[i] = z + Math.sin(a) * 0.05;
        chip.vx[i] = Math.cos(a) * sp * 0.45; chip.vy[i] = sp * (0.8 + rnd() * 0.6); chip.vz[i] = Math.sin(a) * sp * 0.45;
        chip.gy[i] = y - 0.04; chip.life[i] = o.chipLife * (0.6 + rnd() * 0.8);
        chip.spin[i] = (rnd() * 2 - 1) * 9; chip.ang[i] = rnd() * TAU;
        chip.ax[i] = rnd() * 2 - 1; chip.az[i] = rnd() * 2 - 1;
      }
    }

    function updateChips(dt) {
      if (!chipCount || chipsLive === 0) return;
      let live = 0;
      for (let i = 0; i < chipCount; i++) {
        if (chip.life[i] <= 0) continue;
        chip.life[i] -= dt;
        if (chip.life[i] <= 0) { chipMesh.setMatrixAt(i, S.zero); continue; }
        live++;
        chip.vy[i] += o.chipGravity * dt;
        chip.px[i] += chip.vx[i] * dt; chip.py[i] += chip.vy[i] * dt; chip.pz[i] += chip.vz[i] * dt;
        if (chip.py[i] < chip.gy[i]) { chip.py[i] = chip.gy[i]; chip.vy[i] *= -0.28; chip.vx[i] *= 0.6; chip.vz[i] *= 0.6; }
        chip.ang[i] += chip.spin[i] * dt;
        const s = o.chipSize * size * Math.min(1, chip.life[i] * 4);
        S.axis.set(chip.ax[i], 1, chip.az[i]).normalize();
        S.pos.set(chip.px[i], chip.py[i], chip.pz[i]);
        S.q.setFromAxisAngle(S.axis, chip.ang[i]);
        S.m.compose(S.pos, S.q, S.scale.set(s, s * 1.6, s));
        chipMesh.setMatrixAt(i, S.m);
      }
      chipsLive = live;
      chipMesh.instanceMatrix.needsUpdate = true;
    }

    function triggerUpTo(limit, includeImpact, age) {
      for (let i = 0; i < wanted; i++) {
        const r = records[i];
        if (r.eruptTime >= 0) continue;
        if (r.impact && !includeImpact) continue;
        if (!r.impact && r.along > limit) continue;
        r.eruptTime = age + r.stagger * o.riseStagger;
      }
    }

    /** 0 → 1 with an easeOutBack punch through the surface; negative while still buried. */
    function emergence(r, age) {
      if (r.eruptTime < 0) return -1;
      const e = age - r.eruptTime;
      if (e < 0) return -1;
      const t = saturate(e / Math.max(0.02, o.riseTime));
      return t >= 1 ? 1 : Easing.outBack(t);
    }

    function poseSpikes(age, retract) {
      const sink = retract > 0 ? Easing.inCubic(retract) : 0;
      for (let i = 0; i < wanted; i++) {
        const r = records[i];
        const mesh = meshes[r.variant];
        const emerge = emergence(r, age);
        if (emerge < 0) { mesh.setMatrixAt(r.slot, S.zero); continue; }
        if (!r.breached && emerge > 0.3) { r.breached = true; emitChips(r.x, r.baseY + 0.05, r.z, o.chipsPerSpike, o.chipSpeed); }
        const k = Math.min(1, emerge);
        const w = r.radius * lerp(0.68, 1, k) * (1 - 0.3 * sink);
        S.pos.set(r.x, r.baseY + (emerge - 1) * r.height * 0.85 - sink * (r.height + 0.4), r.z);
        S.m.compose(S.pos, r.quat, S.scale.set(w, r.height * lerp(0.9, 1, k) * (1 - 0.2 * sink), w));
        mesh.setMatrixAt(r.slot, S.m);
      }
      for (let v = 0; v < VARIANTS; v++) meshes[v].instanceMatrix.needsUpdate = true;
    }

    let light = pal.light && lights ? (lights.acquire?.() || null) : null;
    if (light) {
      light.color.set(pal.light.color);
      light.intensity = 0;
      light.distance = o.lightDistance * size;
      line.pointAt(0, S.v);
      light.position.set(S.v.x, S.v.y + o.lightHeight, S.v.z);
    }
    function releaseLight() {
      if (!light) return;
      light.intensity = 0;
      lights?.release?.(light);
      light = null;
    }

    const inst = {
      group, machine: null, onImpact: null, onDone: null,
      update(dt, time) {
        const alive = inst.machine.update(dt, time);
        updateChips(dt);
        return alive;
      },
      dispose() {
        releaseLight();
        group.removeFromParent();
        for (let v = 0; v < VARIANTS; v++) meshes[v].dispose();
        if (chipMesh) chipMesh.dispose();
      },
    };

    let shattered = false;
    const machine = createPhaseMachine({
      travelSpeed: o.travelSpeed, impactTime: o.holdTime, fadeTime: o.shatterDelay + o.sinkTime,
      onTravel(dt) {
        triggerUpTo(this.u, false, this.age);
        poseSpikes(this.age, 0);
        if (light) {
          this.line.pointAt(this.u, S.v);
          light.position.set(S.v.x, S.v.y + o.lightHeight, S.v.z);
          light.intensity = o.lightIntensity * pal.light.mul * power * saturate(this.age / 0.12);
        }
      },
      onImpact() {
        triggerUpTo(1, true, this.age);   // everything still buried goes up now, cluster included
        this.line.pointAt(1, S.v);
        emitChips(S.v.x, S.v.y + 0.2, S.v.z, Math.min(24, Math.round(14 * power)), o.chipSpeed * 1.8);
        if (light) light.position.set(S.v.x, S.v.y + o.lightHeight, S.v.z);
        inst.onImpact?.();
      },
      onFade(dt, t) {
        const fadeAge = t > 1 ? (t - 1) * (o.shatterDelay + o.sinkTime) : 0;
        const retract = saturate((fadeAge - o.shatterDelay) / Math.max(0.05, o.sinkTime));
        if (retract > 0 && !shattered) {
          shattered = true;
          for (let i = 0; i < wanted; i += 3) emitChips(records[i].x, records[i].baseY + records[i].height * 0.4, records[i].z, 1, o.chipSpeed * 0.7);
        }
        poseSpikes(this.age, retract);
        if (light) {
          const flash = t < 1 ? lerp(1.9, 1, Easing.outCubic(t)) : (1 - saturate(fadeAge / (o.shatterDelay + o.sinkTime)));
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
    for (let v = 0; v < VARIANTS; v++) geos[v].dispose();
    chipGeo.dispose();
    for (const m of matCache.values()) { m.crystal.dispose(); m.chip.dispose(); }
    matCache.clear();
  }

  return { cast, dispose };
}
