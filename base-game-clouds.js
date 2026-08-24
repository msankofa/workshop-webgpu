// base-game-clouds.js — the Base Game cloud decks: two `clouds.js` planes that follow the camera,
// tint with the sun, dim at night, and grey over as the weather closes in.
//
// Three things this owns that the raw module does not: the render-origin offset (Base Game rebases,
// so the noise field would teleport under a plain `Clouds`), the day/night tint (a `Clouds` is white
// on its own and would glow at midnight), and the far-plane distance the page needs so a deck's far
// corner is not clipped.

import * as THREE from 'three';
import { Clouds } from './clouds.js';

export const CLOUD_DECK_DEFAULTS = Object.freeze({
  visible: true,
  height: 900,        // metres; a deck you could fly through, not a ceiling over a sandbox
  extent: 20000,      // metres across
  cover: 0.42,
  puff: 1.6,
  softness: 0.3,
  opacity: 0.88,
  fade: 0.5,
  speed: 1.0,
  octaves: 4,         // changing this rebuilds the deck's material: it is baked into the TSL graph
});

export const CLOUD_DEFAULTS = Object.freeze({
  enabled: true,
  depthWrite: false,
  tintFollowsSun: true,
  tint: '#ffffff',      // used when tintFollowsSun is off
  nightDim: 0.85,       // how far the tint falls toward black at full nightness
  overcastTint: 0.55,   // how grey a fully overcast deck goes
});

const DECK_KEYS = ['visible', 'height', 'extent', 'cover', 'puff', 'softness', 'opacity', 'fade', 'speed', 'octaves'];

export function createBaseGameClouds({ scene, worldCoordinates = null, deckCount = 2 } = {}) {
  if (!scene) throw new TypeError('base game clouds need a scene');

  const shared = { ...CLOUD_DEFAULTS };
  const decks = [];
  const tint = new THREE.Color();
  const manualTint = new THREE.Color(CLOUD_DEFAULTS.tint);
  let elapsed = 0, overcast = 0, enabled = CLOUD_DEFAULTS.enabled;

  function build(deck) {
    const mesh = new Clouds({ octaves: deck.cfg.octaves });
    mesh.rotation.x = -Math.PI / 2;   // lay the quad flat overhead
    mesh.frustumCulled = false;
    mesh.renderOrder = 5;             // after opaque, before the rain quads
    mesh.material.depthWrite = shared.depthWrite;
    scene.add(mesh);
    deck.mesh = mesh;
    applyDeck(deck);
  }

  function applyDeck(deck) {
    const { mesh, cfg } = deck;
    mesh.position.y = cfg.height;
    mesh.setExtent(cfg.extent);
    mesh.setCoverage(cfg.cover);
    mesh.setPuff(cfg.puff);
    mesh.setSoftness(cfg.softness);
    mesh.setOpacity(cfg.opacity);
    mesh.setFade(cfg.fade);
    mesh.setSpeed(cfg.speed);
    mesh.visible = enabled && cfg.visible;
  }

  for (let i = 0; i < deckCount; i++) {
    const deck = { mesh: null, cfg: { ...CLOUD_DECK_DEFAULTS } };
    decks.push(deck);
    build(deck);
  }
  // Deck B starts higher, wider, thinner and softer, so the two read as a sky rather than a texture.
  if (decks[1]) {
    Object.assign(decks[1].cfg, { height: 2200, extent: 40000, cover: 0.30, puff: 4.0, opacity: 0.50, speed: 0.6, octaves: 3 });
    rebuild(1);
  }

  function rebuild(i) {
    const deck = decks[i];
    if (!deck) return;
    scene.remove(deck.mesh);
    deck.mesh.material.dispose();
    deck.mesh.geometry.dispose();
    build(deck);
  }

  return {
    decks,
    get shared() { return shared; },

    // Per-deck settings. An octave change rebuilds that deck's material; everything else is a uniform.
    setDeck(i, patch = {}) {
      const deck = decks[i];
      if (!deck) return;
      let rebuildNeeded = false;
      for (const key of DECK_KEYS) {
        if (patch[key] === undefined || patch[key] === deck.cfg[key]) continue;
        deck.cfg[key] = patch[key];
        if (key === 'octaves') rebuildNeeded = true;
      }
      if (rebuildNeeded) rebuild(i);
      else applyDeck(deck);
    },

    setShared(patch = {}) {
      Object.assign(shared, patch);
      if (patch.tint !== undefined) manualTint.set(patch.tint);
      for (const deck of decks) {
        deck.mesh.material.depthWrite = shared.depthWrite;
        deck.mesh.material.needsUpdate = true;
      }
    },

    setEnabled(on) {
      enabled = !!on;
      for (const deck of decks) deck.mesh.visible = enabled && deck.cfg.visible;
    },

    // 0 clear .. 1 storm. The page drives this from the weather master; the decks grey and the
    // per-deck coverage response is the page's job (it owns the master slider).
    setOvercast(v) {
      overcast = Math.max(0, Math.min(1, v));
      for (const deck of decks) deck.mesh.setOvercast(overcast * shared.overcastTint);
    },

    // Far distance the camera must reach for the farthest deck corner not to be clipped.
    get farExtent() {
      let far = 0;
      for (const deck of decks) {
        if (!deck.cfg.visible) continue;
        far = Math.max(far, Math.hypot(deck.cfg.extent / 2, deck.cfg.height));
      }
      return enabled ? far : 0;
    },

    // `sunColor` is the rig's current key-light colour, `nightness` the sky's 0..1 night factor.
    update(dt, camera, { sunColor = null, nightness = 0 } = {}) {
      if (!enabled) return;
      elapsed += dt;
      if (shared.tintFollowsSun && sunColor) tint.copy(sunColor);
      else tint.copy(manualTint);
      tint.multiplyScalar(1 - shared.nightDim * Math.max(0, Math.min(1, nightness)));
      const o = worldCoordinates ? worldCoordinates.getOrigin() : [0, 0, 0];
      for (const deck of decks) {
        if (!deck.mesh.visible) continue;
        deck.mesh.position.set(camera.position.x, deck.cfg.height - o[1], camera.position.z);
        deck.mesh.setOffset(o[0], o[2]);
        deck.mesh.setTint(tint);
        deck.mesh.update(elapsed, camera.position);
      }
    },

    dispose() {
      for (const deck of decks) {
        scene.remove(deck.mesh);
        deck.mesh.material.dispose();
        deck.mesh.geometry.dispose();
      }
      decks.length = 0;
    },
  };
}
