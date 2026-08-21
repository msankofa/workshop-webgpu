// A resident of the park, from a dex number to something walking about with a model on.

import { parseGLB, nodeWorldMatrices } from './stadium-glb.js';
import { mapStadiumRig, pivotTree } from './stadium-rig-map.js';
import { createStadiumWalker } from './stadium-walker.js';
import { GAITS } from './creature-locomotion.js';
import { createMover, MOVER_STYLES } from './park-movement.js';
import { MOVEMENT } from './park-species.js';

const LEGGED = new Set(['quad', 'biped', 'multi']);

/** Species whose ROM idle clip fights the gait rather than decorating it. */
const IDLE_FIGHTS_GAIT = new Set(['086', '128', '033', '058']);

export const CREATURE_DEFAULTS = Object.freeze({
  // Model scale. The walker takes a total height in world units, which is exactly the Pokedex height.
  modelPath: './models/stadium/',
  // How far a resident wanders from where it was planned. A park animal has a patch, not the run of the map.
  roamRadius: 26,
  // Beyond this, step the gait on a stride instead of every frame.
  strideDistance: 55,
  // Beyond this, no ROM clip: the mixer is per-instance and buys nothing you can see at range.
  idleDistance: 42,
  // Beyond this the creature is hidden.
  drawDistance: 220,
  // Radians of half-angle past which a creature behind the camera stops being posed at all.
  behindCosine: -0.35,
  // Inside this, drawn whatever the frustum says, so a shadow you would notice never blinks out.
  cullKeepDistance: 55,
  // Added to the species half-height, for a bent spine or a wing the Pokedex number does not cover.
  cullPad: 3,
});

/** The park's creature factory. */
export function createParkCreatures({
  THREE,
  scene,
  GLTFLoader,
  skeletonClone,
  terrainHeight = () => 0,
  waterHeight = null,
  waterLevel = 0,
  worldRadius = 1800,
  rng = Math.random,
  warmMaterials = null,
  atlasSpecies = null,
  options = {},
} = {}) {
  if (!THREE?.Vector3) throw new Error('createParkCreatures needs { THREE }');
  if (!scene) throw new Error('createParkCreatures needs { scene }');
  const O = { ...CREATURE_DEFAULTS, ...options };

  const loader = new GLTFLoader();
  const speciesCache = new Map();
  const pending = new Map();
  const failures = new Map();
  const live = new Map();
  const warnings = [];
  const stats = {
    loaded: 0, failed: 0, live: 0, walkers: 0, movers: 0, posed: 0, hidden: 0,
    offscreen: 0, strided: 0, fallbacks: 0, drawsSaved: 0,
    spawns: 0, spawnLastMs: 0, spawnPeakMs: 0,
  };

  const _v = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  // The meshes carry frustumCulled = false, so the cull happens here, per creature, in world space.
  const _frustum = new THREE.Frustum();
  const _projScreen = new THREE.Matrix4();
  const _cullSphere = new THREE.Sphere();
  const _spine = { x: 0, y: 0, z: 0 };

  /** Read a species' glb once */
  async function ensureSpecies(species) {
    const key = species.key;
    if (speciesCache.has(key)) return speciesCache.get(key);
    if (pending.has(key)) return pending.get(key);
    if (failures.has(key)) throw failures.get(key).error;

    const job = (async () => {
      const res = await fetch(`${O.modelPath}${species.file}`);
      if (!res.ok) throw new Error(`${species.file}: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const { json, bin } = parseGLB(bytes);
      const map = mapStadiumRig(json, bin, { source: key });

      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const gltf = await loader.parseAsync(buf, '');
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        // Both of these are load-bearing and both come from the file format
        o.frustumCulled = false;
        o.castShadow = true;
        o.receiveShadow = true;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m) m.side = THREE.DoubleSide;
      });

      // One draw instead of ten to eighteen. Optional: without it the species renders unmerged.
      let atlasTextures = null;
      if (atlasSpecies) {
        try {
          const merged = atlasSpecies(gltf.scene);
          if (merged) { stats.drawsSaved += merged.before - merged.after; atlasTextures = merged.textures; }
          else warnings.push(`${species.name}: not safe to merge, drawing it unmerged`);
        } catch (e) { warnings.push(`${species.name}: atlas failed (${e.message})`); }
      }

      // Compile the pipeline here rather than on the frame the first one of these walks into view.
      if (warmMaterials) {
        try { await warmMaterials(gltf.scene); }
        catch (e) { warnings.push(`${species.name}: warm-up failed (${e.message})`); }
      }

      const entry = { key, species, map, template: gltf.scene, clips: gltf.animations || [], legs: map.legs.length, atlasTextures };
      if (LEGGED.has(species.move) && !map.legs.length) {
        warnings.push(`${species.name}: authored as ${species.move} but the rig maps no legs — using the ground fallback`);
      }
      speciesCache.set(key, entry);
      stats.loaded++;
      return entry;
    })();

    pending.set(key, job);
    try {
      return await job;
    } catch (value) {
      const error = value instanceof Error ? value : new Error(String(value));
      failures.set(key, { error, species, failedAt: Date.now() });
      stats.failed = failures.size;
      throw error;
    } finally {
      pending.delete(key);
    }
  }

  /** A failed species is terminal until an explicit retry; streaming must not hammer it every tick. */
  async function retrySpecies(species) {
    failures.delete(species.key);
    stats.failed = failures.size;
    return ensureSpecies(species);
  }

  /** Which solver a species actually gets, once its rig is known. */
  function resolveStyle(species, entry) {
    if (LEGGED.has(species.move)) return entry.legs > 0 ? 'walker' : 'ground';
    return MOVER_STYLES.includes(species.move) ? species.move : 'ground';
  }

  /** Put one resident in the world. */
  function spawn(resident) {
    const entry = speciesCache.get(resident.key);
    if (!entry || live.has(resident.id)) return null;
    const spawnStartedAt = performance.now();
    const species = resident.species;
    const style = resolveStyle(species, entry);

    const root = skeletonClone(entry.template);
    const c = {
      id: resident.id, resident, species, entry, style,
      group: null, walker: null, mover: null, mixer: null, action: null,
      home: { x: resident.x, z: resident.z },
      wanderTimer: rng() * 4,
      castTimer: 6 + rng() * 22,
      tier: 0, visible: true, strideAcc: 0,
      cullRadius: species.heightM * 0.85 + O.cullPad,
      spineBones: null,
    };

    if (style === 'walker') {
      const walker = createStadiumWalker({
        THREE, scene: root, map: entry.map, terrainHeight,
        // The Pokedex height, in metres
        worldHeight: species.heightM,
        gait: GAITS.walk,
        // Past the map's own diagonal, so the origin leash in `steer()` can never fire. See the header.
        roamRadius: worldRadius,
        rng,
      });
      c.walker = walker;
      c.group = walker.object;
      walker.placeAt(resident.x, resident.z, resident.yaw);
      stats.walkers++;
    } else {
      // Everything bodiless hangs under a plain group this file owns
      const holder = new THREE.Group();
      holder.name = `park-${species.slug}`;
      const unit = species.heightM / Math.max(1e-6, entry.map.units.height);
      root.scale.multiplyScalar(unit);
      root.position.set(
        -entry.map.bodyCentroid.x * unit,
        -entry.map.bodyCentroid.y * unit,
        -entry.map.bodyCentroid.z * unit,
      );
      holder.add(root);
      const mover = createMover({
        style, heightM: species.heightM,
        lengthM: species.move === 'slither' ? species.heightM : null,
        terrainHeight, waterHeight, waterLevel,
        roamRadius: O.roamRadius, rng,
      });
      mover.placeAt(resident.x, resident.z, resident.yaw);
      c.mover = mover;
      c.group = holder;
      c.root = root;
      c.unit = unit;
      if (style === 'slither') c.spineBones = collectSpine(root, entry.map);
      if (style !== species.move) stats.fallbacks++;
      stats.movers++;
    }

    attachIdle(c, root, entry);
    scene.add(c.group);
    live.set(c.id, c);
    stats.live = live.size;
    stats.spawns++;
    stats.spawnLastMs = performance.now() - spawnStartedAt;
    stats.spawnPeakMs = Math.max(stats.spawnPeakMs, stats.spawnLastMs);
    return c;
  }

  /** The ROM idle, minus the legs. */
  function attachIdle(c, root, entry) {
    if (IDLE_FIGHTS_GAIT.has(entry.key) && c.walker) return;
    const idle = entry.clips.find((k) => /idle/i.test(k.name)) || entry.clips[0];
    if (!idle) return;
    const clip = idle.clone();
    if (c.walker) {
      const legBones = new Set(entry.map.legs.flatMap((l) => l.bones).map((b) => entry.map.names[b]));
      clip.tracks = clip.tracks.filter((t) => !legBones.has(t.name.split('.')[0]));
    }
    if (!clip.tracks.length) return;
    c.mixer = new THREE.AnimationMixer(root);
    c.action = c.mixer.clipAction(clip);
    // Offset the phase or every Caterpie in a clearing breathes in unison, which reads as a texture.
    c.action.time = rng() * clip.duration;
    c.action.play();
  }

  /** The spine chain as Object3Ds, root-first — what a slitherer lays along its own trail. */
  function collectSpine(root, map) {
    const names = (map.spine || []).map((b) => map.names[b]).filter(Boolean);
    const out = [];
    for (const n of names) {
      const o = root.getObjectByName(n);
      if (o) out.push(o);
    }
    return out.length > 1 ? out : null;
  }

  function despawn(id) {
    const c = live.get(id);
    if (!c) return false;
    if (c.mixer) c.mixer.stopAllAction();
    scene.remove(c.group);
    // Geometry, materials and textures belong to the species template and are
    live.delete(id);
    if (c.walker) stats.walkers--; else stats.movers--;
    stats.live = live.size;
    return true;
  }

  /** Wander: pick somewhere in this creature's own patch and head for it. */
  function wander(c, dt) {
    c.wanderTimer -= dt;
    if (c.wanderTimer > 0) return;
    c.wanderTimer = 5 + rng() * 9;
    const r = O.roamRadius * (0.25 + 0.7 * rng());
    const a = rng() * Math.PI * 2;
    let tx = c.home.x + Math.cos(a) * r;
    let tz = c.home.z + Math.sin(a) * r;
    if (c.walker) c.walker.setTarget(tx, tz);
    else c.mover.setTarget(tx, tz);
  }

  /** Lay a slitherer's spine along the track its head has already covered. */
  function applySpine(c) {
    if (!c.spineBones || !c.mover.trail) return;
    const n = c.spineBones.length;
    const span = c.species.heightM;
    for (let i = 0; i < n; i++) {
      const back = (i / Math.max(1, n - 1)) * span;
      const p = c.mover.spineAt(back, _spine);
      if (!p) break;
      // World-space target converted into the bone's own parent space
      _v.set(p.x, p.y, p.z);
      const b = c.spineBones[n - 1 - i];
      if (b.parent) b.parent.worldToLocal(_v);
      b.position.lerp(_v, 0.35);
    }
  }

  /** Write the mover's body onto the group. Only this function knows which driver a creature has. */
  function applyMoverPose(c) {
    const b = c.mover.body;
    c.group.position.set(b.x, b.y, b.z);
    c.group.rotation.set(b.pitch, b.yaw, b.roll, 'YXZ');
    const e = c.mover.extra;
    if (c.style === 'roll') {
      // Spin about the axis across the direction of travel
      c.root.rotation.set(e.spin, 0, 0);
    } else if (c.style === 'hop') {
      c.root.scale.set(c.unit / Math.sqrt(Math.max(1e-3, e.squash)), c.unit * e.squash, c.unit / Math.sqrt(Math.max(1e-3, e.squash)));
    }
  }

  /** Step every live creature. */
  function update(dt, camera, { cast = null, castingEnabled = true, paused = false } = {}) {
    stats.posed = 0; stats.hidden = 0; stats.strided = 0; stats.offscreen = 0;
    if (!camera) return stats;
    camera.getWorldDirection(_fwd);
    _projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _frustum.setFromProjectionMatrix(_projScreen);
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;

    for (const c of live.values()) {
      const p = c.walker ? c.walker.body.pos : c.mover.body;
      const dx = p.x - cx, dy = (p.y ?? 0) - cy, dz = p.z - cz;
      const dist = Math.hypot(dx, dy, dz);

      if (dist > O.drawDistance) {
        if (c.group.visible) { c.group.visible = false; }
        stats.hidden++;
        continue;
      }
      // Off screen stops the draw but not the walk: freezing at the screen edge is visible when you pan.
      let drawn = true;
      if (dist > O.cullKeepDistance) {
        _cullSphere.center.set(p.x, (p.y ?? 0) + c.cullRadius * 0.5, p.z);
        _cullSphere.radius = c.cullRadius;
        drawn = _frustum.intersectsSphere(_cullSphere);
      }
      if (c.group.visible !== drawn) c.group.visible = drawn;
      if (!drawn) { stats.hidden++; stats.offscreen++; }

      // Behind the camera and not close enough to be in peripheral vision: skip the pose entirely.
      const inv = dist > 1e-3 ? 1 / dist : 0;
      const facing = (dx * _fwd.x + dy * _fwd.y + dz * _fwd.z) * inv;
      if (facing < O.behindCosine && dist > 12) continue;
      if (paused) continue;

      // Stride the gait past a distance rather than dropping it
      let step = dt;
      if (dist > O.strideDistance) {
        c.strideAcc += dt;
        if (c.strideAcc < 1 / 20) { stats.strided++; continue; }
        step = c.strideAcc;
        c.strideAcc = 0;
      }

      wander(c, step);

      // The mixer runs FIRST and the driver second
      if (c.mixer && dist < O.idleDistance) c.mixer.update(step);

      if (c.walker) {
        c.walker.update(step);
      } else {
        c.mover.step(step);
        applyMoverPose(c);
        if (c.spineBones) applySpine(c);
      }
      stats.posed++;

      if (castingEnabled && cast) {
        c.castTimer -= step;
        if (c.castTimer <= 0) {
          c.castTimer = 14 + rng() * 40;
          cast(c);
        }
      }
    }
    return stats;
  }

  /** Where a move should leave from: the creature's own head height, not the ground under it. */
  function castOrigin(c, out = { x: 0, y: 0, z: 0 }) {
    const p = c.walker ? c.walker.body.pos : c.mover.body;
    out.x = p.x; out.z = p.z;
    out.y = (p.y ?? terrainHeight(p.x, p.z)) + c.species.heightM * 0.45;
    return out;
  }

  function nearest(c, maxDist = 40) {
    let best = null, bestD = maxDist;
    const a = c.walker ? c.walker.body.pos : c.mover.body;
    for (const o of live.values()) {
      if (o === c) continue;
      const b = o.walker ? o.walker.body.pos : o.mover.body;
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      if (d < bestD) { bestD = d; best = o; }
    }
    return best;
  }

  function dispose() {
    for (const id of [...live.keys()]) despawn(id);
    for (const e of speciesCache.values()) {
      e.template.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry?.dispose?.();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (!m) continue;
          for (const k of ['map', 'normalMap', 'emissiveMap', 'roughnessMap', 'metalnessMap']) m[k]?.dispose?.();
          m.dispose?.();
        }
      });
      // The atlas hangs off a colorNode, not material.map, so the loop above never reaches it.
      for (const t of e.atlasTextures || []) t.dispose?.();
    }
    speciesCache.clear();
    pending.clear();
    failures.clear();
    stats.failed = 0;
  }

  return {
    ensureSpecies, retrySpecies, spawn, despawn, update, dispose,
    castOrigin, nearest,
    live, speciesCache, failures, warnings, stats,
    isLoaded: (key) => speciesCache.has(key),
    hasFailed: (key) => failures.has(key),
    failureFor: (key) => failures.get(key) || null,
    get(id) { return live.get(id); },
    options: O,
  };
}

/** Human-readable description of what a species will actually be driven by, for the field guide. */
export function describeDriver(species, entry) {
  if (LEGGED.has(species.move)) {
    if (!entry || entry.legs > 0) return `${MOVEMENT[species.move].label} — ${entry ? entry.legs : species.rigLegs} legs on the leg solver`;
    return `${MOVEMENT[species.move].label} — rig maps no legs, using the ground fallback`;
  }
  return MOVEMENT[species.move]?.label ?? species.move;
}
