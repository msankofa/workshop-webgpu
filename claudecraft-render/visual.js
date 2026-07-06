// claudecraft-render/visual.js
// Skinned-GLB mob visuals for the ClaudeCraft creature system, adapted to the
// workshop's Three.js r184 WebGPU backend. This replaces ClaudeCraft's r165-welded
// asset loader (assets.ts / preload gate) with the workshop's own GLTFLoader and
// drives an AnimationMixer per mob, selecting idle/walk/run via the ported
// anim_state.js pose machine.
//
// Scope: renders + animates locomotion (idle/walk/run). Weapon attachments, show
// allowlists, tints, skins, and attack/hit one-shots from the source visual.ts are
// out of scope for this integration (the wire snapshot carries no attack events).
//
// Robustness: every GLB load is async and guarded. Until a mob's model resolves (or
// if it fails to load) the mob has no mesh; the caller keeps its placeholder box for
// unloaded ids. A load failure logs once and never throws, so a wrong asset path can
// never break the frame loop.
//
// Per src/render/characters/CLAUDE.md: geometry/materials are shared per-asset caches
// and never disposed; dispose() only releases this clone's mixer + skeleton.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { VISUALS, visualKeyForMob, hasWalkBack } from './manifest.js';
import { desiredBaseState, locomotionTimeScale } from './anim_state.js';

const CROSSFADE = 0.2;

// Per-key GLB cache: key -> Promise<{ scene, animations, normScale, normOffset }>.
// The normalize transform (scale to def.height, feet to y=0, centered in x/z) is
// computed once per asset from the source scene, then applied to every clone.
const _assetCache = new Map();
// The ClaudeCraft creature GLBs are meshopt-compressed (EXT_meshopt_compression),
// so the shared loader must have the Meshopt decoder registered — otherwise every
// loadAsync throws "setMeshoptDecoder must be called before loading compressed
// files" and each mob falls back to a red placeholder box. (The workshop's own map
// GLBs are uncompressed, which is why their bare GLTFLoader never needed this.)
const _loader = new GLTFLoader();
_loader.setMeshoptDecoder(MeshoptDecoder);

function loadAsset(key) {
  let p = _assetCache.get(key);
  if (p) return p;
  const def = VISUALS[key];
  p = _loader.loadAsync(def.url).then((gltf) => {
    const src = gltf.scene;
    const box = new THREE.Box3().setFromObject(src);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const rawH = size.y > 1e-4 ? size.y : 1;
    const normScale = def.height / rawH; // scale so the model stands def.height yards tall
    // After scaling, translate so feet (box.min.y) sit at y=0 and x/z are centered.
    const normOffset = new THREE.Vector3(
      -center.x * normScale,
      -box.min.y * normScale + (def.hover ?? 0),
      -center.z * normScale,
    );
    return { scene: src, animations: gltf.animations ?? [], normScale, normOffset };
  }).catch((err) => {
    console.warn(`[claudecraft] mob visual load failed for ${key} (${def?.url}):`, err?.message ?? err);
    return null; // sentinel: never retried, caller keeps placeholder
  });
  _assetCache.set(key, p);
  return p;
}

function findClip(animations, name) {
  if (!name) return null;
  return THREE.AnimationClip.findByName(animations, name)
    ?? animations.find((c) => c.name === name)
    ?? null;
}

class MobVisual {
  constructor(key, worldScale) {
    this.key = key;
    this.worldScale = worldScale;
    this.root = new THREE.Group();
    this.root.name = `cc_mob_${key}`;
    this.mixer = null;
    this.actions = new Map();   // baseState -> AnimationAction
    this.clipMap = VISUALS[key]?.clips ?? {};
    this.baseState = 'idle';
    this.current = null;
    this.ready = false;
    this._disposed = false;
    this._skinnedRoot = null;
  }

  async load() {
    const asset = await loadAsset(this.key);
    if (this._disposed || !asset) return;
    const clip = cloneSkeleton(asset.scene);
    clip.scale.setScalar(asset.normScale * this.worldScale);
    clip.position.copy(asset.normOffset).multiplyScalar(this.worldScale);
    clip.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.frustumCulled = false; } });
    this._skinnedRoot = clip;
    this.root.add(clip);
    this.mixer = new THREE.AnimationMixer(clip);
    this._animations = asset.animations;
    this.ready = true;
    this._playBase('idle', true);
  }

  _action(state) {
    if (this.actions.has(state)) return this.actions.get(state);
    // Resolve the clip name for this base state, aliasing missing states to idle/walk.
    const name = this.clipMap[state] ?? this.clipMap.idle;
    const clip = findClip(this._animations, name) ?? findClip(this._animations, this.clipMap.idle);
    const action = clip ? this.mixer.clipAction(clip) : null;
    this.actions.set(state, action);
    return action;
  }

  _playBase(state, immediate = false) {
    if (!this.mixer) return;
    const next = this._action(state);
    if (!next) return;
    if (this.current === next) return;
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.play();
    if (this.current && !immediate) {
      this.current.crossFadeTo(next, CROSSFADE, false);
    } else if (this.current) {
      this.current.stop();
    }
    this.current = next;
    this.baseState = state;
  }

  update(dt, animState) {
    if (!this.ready || !this.mixer) return;
    const state = desiredBaseState(animState, hasWalkBack(this.key));
    // Collapse authored states we do not drive (cast/sit/swim/jump/walkBack) onto the
    // locomotion states so a mob without those clips still reads idle/walk/run.
    const base = (state === 'run' || state === 'walk') ? state : 'idle';
    this._playBase(base);
    const ts = locomotionTimeScale(base, animState);
    if (this.current && ts != null) this.current.setEffectiveTimeScale(Math.abs(ts));
    this.mixer.update(dt);
  }

  dispose() {
    this._disposed = true;
    if (this.mixer) {
      this.mixer.stopAllAction();
      this.mixer.uncacheRoot(this.mixer.getRoot());
    }
    if (this._skinnedRoot) this.root.remove(this._skinnedRoot);
    if (this.root.parent) this.root.parent.remove(this.root);
  }
}

/**
 * Create the mob-visual adapter.
 *   scene       - THREE.Scene to add mob roots to
 *   worldScale  - the bridge SCALE (sim yards -> workshop units), from claudecraftCreatures.scale.SCALE
 * Returns { update(mobs, dt), dispose() }. `mobs` is the world-space wire array
 * ({ id, tid, p:[x,y,z], q:[x,y,z,w], hp, dead }) from claudecraftCreatures.mobs().
 * Returns the Set of mob ids that currently have a live GLB visual, so the caller can
 * suppress the placeholder box for exactly those ids.
 */
// The sim steps at a fixed 20 Hz but we render at display rate (~60 Hz), and the
// mob snapshot only changes on a sim tick. Writing snapshot positions straight to
// the mesh makes each mob teleport in discrete 20 Hz jumps (frozen 2 of every 3
// frames), and deriving anim speed from raw snapshot deltas reads ~3x too high on
// a step frame and exactly 0 between steps — which strobes the walk/idle cycle.
// So we smooth the rendered pose toward the latest snapshot each frame with an
// exponential follower, and derive the anim speed from that *smoothed* motion.
const SMOOTH_TAU = 0.09;   // follower time constant (s); ~1.8 sim ticks — smooth but responsive
const SNAP_DIST = 4;       // world units; a jump larger than this is a teleport (spawn/revive), snap don't glide

export function createClaudecraftVisuals({ scene, worldScale }) {
  const visuals = new Map();  // mobId -> MobVisual
  const _rpos = new Map();    // mobId -> [x,y,z] smoothed render position
  const _rprev = new Map();   // mobId -> [x,y,z] smoothed render position last frame (for speed)
  const _tq = new THREE.Quaternion(); // target quaternion (scratch)

  function update(mobs, dt) {
    const seen = new Set();
    const rendered = new Set();
    // Exponential smoothing factor for this frame's dt (frame-rate independent).
    const alpha = dt > 1e-4 ? 1 - Math.exp(-dt / SMOOTH_TAU) : 1;
    for (const m of mobs) {
      seen.add(m.id);
      let v = visuals.get(m.id);
      const fresh = !v;
      if (!v) {
        const key = visualKeyForMob(m.tid);
        v = new MobVisual(key, worldScale);
        scene.add(v.root);
        visuals.set(m.id, v);
        v.load(); // async; ready flips true when the GLB resolves
      }
      const tx = m.p[0], ty = m.p[1], tz = m.p[2];
      // Advance the smoothed render position toward the snapshot target. On first
      // sight, or on a teleport-sized jump, snap so the mob doesn't glide across
      // the world.
      let rp = _rpos.get(m.id);
      if (fresh || !rp || Math.hypot(tx - rp[0], ty - rp[1], tz - rp[2]) > SNAP_DIST) {
        rp = [tx, ty, tz];
      } else {
        rp[0] += (tx - rp[0]) * alpha;
        rp[1] += (ty - rp[1]) * alpha;
        rp[2] += (tz - rp[2]) * alpha;
      }
      _rpos.set(m.id, rp);
      v.root.position.set(rp[0], rp[1], rp[2]);
      // Smoothly turn toward the snapshot facing (slerp by the same factor).
      _tq.set(m.q[0], m.q[1], m.q[2], m.q[3]);
      if (fresh) v.root.quaternion.copy(_tq);
      else v.root.quaternion.slerp(_tq, alpha);
      // Per-mob scale multiplier (template scale or spawn-panel override). The
      // skinned clip already carries normScale*worldScale; this root scale layers
      // the mob's own size multiplier on top (defaults to 1 when absent).
      v.root.scale.setScalar(m.s != null && m.s > 0 ? m.s : 1);
      // Derive horizontal speed from the SMOOTHED render delta, so the anim
      // timescale tracks the mob's actual on-screen motion rather than the 20 Hz
      // snapshot staircase.
      const prev = _rprev.get(m.id);
      let speed = 0;
      if (prev && !fresh && dt > 1e-4) {
        speed = Math.hypot(rp[0] - prev[0], rp[2] - prev[2]) / dt;
      }
      _rprev.set(m.id, [rp[0], rp[1], rp[2]]);
      v.update(dt, {
        speed, moving: speed > 0.05, airborne: false, backwards: false,
        dead: !!m.dead, casting: false, swimming: false, sitting: false,
      });
      if (v.ready) rendered.add(m.id);
    }
    for (const [id, v] of visuals) {
      if (!seen.has(id)) { v.dispose(); visuals.delete(id); _rpos.delete(id); _rprev.delete(id); }
    }
    return rendered;
  }

  function dispose() {
    for (const v of visuals.values()) v.dispose();
    visuals.clear();
    _rpos.clear();
    _rprev.clear();
  }

  return { update, dispose };
}
