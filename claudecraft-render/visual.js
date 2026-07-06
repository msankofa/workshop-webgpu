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
import { VISUALS, visualKeyForMob, hasWalkBack } from './manifest.js';
import { desiredBaseState, locomotionTimeScale } from './anim_state.js';

const CROSSFADE = 0.2;

// Per-key GLB cache: key -> Promise<{ scene, animations, normScale, normOffset }>.
// The normalize transform (scale to def.height, feet to y=0, centered in x/z) is
// computed once per asset from the source scene, then applied to every clone.
const _assetCache = new Map();
const _loader = new GLTFLoader();

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
export function createClaudecraftVisuals({ scene, worldScale }) {
  const visuals = new Map();  // mobId -> MobVisual
  const _prevPos = new Map(); // mobId -> [x,y,z] (for speed derivation)
  const _q = new THREE.Quaternion();

  function update(mobs, dt) {
    const seen = new Set();
    const rendered = new Set();
    for (const m of mobs) {
      seen.add(m.id);
      let v = visuals.get(m.id);
      if (!v) {
        const key = visualKeyForMob(m.tid);
        v = new MobVisual(key, worldScale);
        scene.add(v.root);
        visuals.set(m.id, v);
        v.load(); // async; ready flips true when the GLB resolves
      }
      v.root.position.set(m.p[0], m.p[1], m.p[2]);
      _q.set(m.q[0], m.q[1], m.q[2], m.q[3]);
      v.root.quaternion.copy(_q);
      // Per-mob scale multiplier (template scale or spawn-panel override). The
      // skinned clip already carries normScale*worldScale; this root scale layers
      // the mob's own size multiplier on top (defaults to 1 when absent).
      v.root.scale.setScalar(m.s != null && m.s > 0 ? m.s : 1);
      // Derive horizontal speed from the world-space delta for the anim state.
      const prev = _prevPos.get(m.id);
      let speed = 0;
      if (prev && dt > 1e-4) {
        const dx = m.p[0] - prev[0], dz = m.p[2] - prev[2];
        speed = Math.hypot(dx, dz) / dt;
      }
      _prevPos.set(m.id, [m.p[0], m.p[1], m.p[2]]);
      v.update(dt, {
        speed, moving: speed > 0.05, airborne: false, backwards: false,
        dead: !!m.dead, casting: false, swimming: false, sitting: false,
      });
      if (v.ready) rendered.add(m.id);
    }
    for (const [id, v] of visuals) {
      if (!seen.has(id)) { v.dispose(); visuals.delete(id); _prevPos.delete(id); }
    }
    return rendered;
  }

  function dispose() {
    for (const v of visuals.values()) v.dispose();
    visuals.clear();
    _prevPos.clear();
  }

  return { update, dispose };
}
