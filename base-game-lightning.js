// base-game-lightning.js — storms in Base Game: a strike schedule every client computes for itself,
// the bolt, the flash, and the cue for thunder.
//
// Nothing about lightning is sent over the wire. A strike is a pure function of the shared weather
// seed and its own index, so two clients in one room see the same bolt in the same place at the same
// moment because they computed it, not because anyone told them. That also puts a late joiner in
// phase immediately: it does not have to be told what it missed, it can work out where the sequence
// is. The clock is `playerController.waterTime` — the lockstep tick the swell already rides, which is
// the one clock the client and the server agree on.
//
// The schedule is a FIXED GRID, not an accumulation. The plan wanted the gap between strikes to
// shorten with the rain, but that makes strike n's time depend on the whole history of the rain
// slider, so an owner dragging it mid-storm would move strikes that had already happened, and two
// clients that saw different slider histories would diverge. Instead the grid depends only on
// (seed, index, interval, spread) — all shared — and rain decides whether a scheduled strike fires
// at all. Frequency still follows the weather, through the threshold and the interval slider.

import * as THREE from 'three';
import { createLightningBolt } from './rain.js';

export const LIGHTNING_DEFAULTS = Object.freeze({
  enabled: true,
  threshold: 0.3,        // no strikes below this much weather
  interval: 9,           // mean seconds between strikes
  intervalSpread: 0.7,   // 0 metronome .. 1 anywhere in its slot
  distMin: 800,          // metres from the player
  distMax: 4000,
  flash: 1,              // rain.flash strength
  decay: 3.5,
  boltScale: 1,
  sunLift: 4,            // extra key-light intensity at the peak of a flash
  soundSpeed: 340,       // m/s; the delay between the flash and the clap is the whole effect
});

// A 32-bit integer hash of (seed, index, salt). Deterministic across engines: everything stays in
// int32 through Math.imul, so there is no float rounding to disagree about.
export function strikeHash(seed, index, salt = 0) {
  let h = (seed | 0) ^ Math.imul(index | 0, 0x9e3779b1) ^ Math.imul(salt | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;   // [0, 1)
}

// When strike `index` happens, in seconds on the shared clock. Slot `index` spans
// [index·interval, (index+1)·interval) and the hash places the strike inside it, so strikes stay in
// index order and each one fires exactly once however the window is walked.
export function strikeTime(index, { seed, interval, intervalSpread }) {
  const slot = Math.max(0.05, interval);
  const jitter = (strikeHash(seed, index, 1) - 0.5) * Math.max(0, Math.min(1, intervalSpread));
  return (index + 0.5 + jitter) * slot;
}

// Where it lands, relative to the listener: a bearing and a distance, both from the same hash.
// sqrt on the radius keeps strikes uniform over the annulus rather than crowding the inner edge.
export function strikePlacement(index, { seed, distMin, distMax }) {
  const lo = Math.max(0, Math.min(distMin, distMax));
  const hi = Math.max(lo + 1, Math.max(distMin, distMax));
  const t = strikeHash(seed, index, 3);
  return {
    bearingDeg: strikeHash(seed, index, 2) * 360,
    distance: Math.sqrt(lo * lo + t * (hi * hi - lo * lo)),
  };
}

// Every strike whose time falls in (from, to]. Returns indices, in order. The candidate range is
// derived from the slot width, so this is O(1) in the age of the room — a client that has been in
// the world for hours does not walk its whole history to find the next bolt.
export function strikesBetween(config, from, to, out = []) {
  out.length = 0;
  if (!(to > from)) return out;
  const slot = Math.max(0.05, Math.max(0.05, config.interval));
  // A strike sits within half a slot of its slot centre, so two slots either side covers every
  // candidate whatever the spread.
  const first = Math.max(0, Math.floor(from / slot) - 2);
  const last = Math.floor(to / slot) + 2;
  for (let index = first; index <= last; index++) {
    const t = strikeTime(index, config);
    if (t > from && t <= to) out.push(index);
  }
  out.sort((a, b) => strikeTime(a, config) - strikeTime(b, config));
  return out;
}

export function createBaseGameLightning({ scene, terrain, rain, worldCoordinates = null } = {}) {
  if (!scene || !rain) throw new TypeError('base game lightning needs a scene and the rain system');
  const bolt = createLightningBolt(scene);
  const cfg = { ...LIGHTNING_DEFAULTS, seed: 7, cloudBase: 900, rain: 0 };
  const pending = [];              // thunder claps in flight: { at, distance }
  const scratch = [];
  let lastTime = null;             // shared-clock seconds at the previous update
  let sunLift = 0, sunLiftDecay = 0;
  let lastStrike = null;
  const stats = { strikes: 0, thunder: 0, lastIndex: -1 };
  const _top = new THREE.Vector3(), _hit = new THREE.Vector3();

  // The strike point in SCENE space, and its distance from the listener. Ground comes from the
  // sea-depth window the rain already streams (16 m posts, 5 km radius — every strike is inside it).
  function place(index, listener, origin) {
    const { bearingDeg, distance } = strikePlacement(index, cfg);
    const a = bearingDeg * Math.PI / 180;
    const x = listener.x + Math.cos(a) * distance;
    const z = listener.z + Math.sin(a) * distance;
    const globalGround = terrain?.seaDepth?.heightAt(x + origin[0], z + origin[2]);
    const groundY = Number.isFinite(globalGround) ? globalGround - origin[1] : listener.y;
    return { x, z, groundY, distance };
  }

  return {
    bolt, stats,
    get group() { return bolt.group; },
    get sunLift() { return sunLift; },
    get lastStrike() { return lastStrike; },

    set(patch = {}) { Object.assign(cfg, patch); },
    get config() { return cfg; },

    // Drop the clock reference without firing everything in between — used when the world changes
    // under the player (a respawn, a new room) so a stale `lastTime` does not unleash a barrage.
    resync(now) { lastTime = Number.isFinite(now) ? now : null; },

    // Fire the strike at `index` regardless of the schedule (the panel's Strike now button).
    strike(index, listener, { onThunder = null } = {}) {
      const origin = worldCoordinates ? worldCoordinates.getOrigin() : [0, 0, 0];
      const { x, z, groundY, distance } = place(index, listener, origin);
      const top = _top.set(x + (strikeHash(cfg.seed, index, 4) - 0.5) * distance * 0.1, cfg.cloudBase - origin[1], z + (strikeHash(cfg.seed, index, 5) - 0.5) * distance * 0.1);
      _hit.set(x, groundY, z);
      bolt.strike(top, _hit, { duration: 0.1 + strikeHash(cfg.seed, index, 6) * 0.12 });
      rain.system.flash(cfg.flash * (0.7 + strikeHash(cfg.seed, index, 7) * 0.6), cfg.decay);
      bolt.group.scale.setScalar(Math.max(0.05, cfg.boltScale));
      sunLift = cfg.sunLift;
      sunLiftDecay = Math.max(0.2, cfg.decay);
      stats.strikes++;
      stats.lastIndex = index;
      lastStrike = { index, distance, x, z, groundY };
      // Sound travels: the clap is queued, not played. That delay IS the effect.
      pending.push({ at: distance / Math.max(1, cfg.soundSpeed), distance });
      if (onThunder && pending.length === 0) onThunder(distance);
      return lastStrike;
    },

    // `now` is the shared clock in seconds; `listener` a scene-space position (the camera).
    // `onThunder(distance)` fires when a queued clap arrives.
    update(dt, now, listener, { onThunder = null } = {}) {
      bolt.update(dt);
      if (sunLift > 0) sunLift = Math.max(0, sunLift - dt * sunLiftDecay * sunLift);
      for (let i = pending.length - 1; i >= 0; i--) {
        pending[i].at -= dt;
        if (pending[i].at > 0) continue;
        const { distance } = pending.splice(i, 1)[0];
        stats.thunder++;
        onThunder?.(distance);
      }
      if (!Number.isFinite(now)) return;
      if (lastTime === null) { lastTime = now; return; }
      // A pause, a tab switch or a reconciliation can jump the clock. Firing every strike in a
      // ten-second gap at once would be a machine-gun of bolts, so a jump resyncs instead.
      if (now < lastTime || now - lastTime > 2) { lastTime = now; return; }
      const from = lastTime;
      lastTime = now;
      if (!cfg.enabled || cfg.rain < cfg.threshold) return;
      for (const index of strikesBetween(cfg, from, now, scratch)) this.strike(index, listener, { onThunder });
    },

    setVisible(on) { bolt.group.visible = !!on && bolt.active; },
    dispose() {
      for (const child of bolt.group.children) child.geometry.dispose();
      bolt.group.clear();
      scene.remove(bolt.group);
      bolt.material.dispose();
    },
  };
}
