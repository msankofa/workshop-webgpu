// Base Game sound director: decides WHICH sound event fires WHEN, for the local player, every
// remote player and the menus. It owns no Web Audio; the environment-audio.js controller (or a
// test fake) is injected as `audio`, so every rule here runs headless in Node.
//
// A local footstep is a literal foot plant: the procedural body's gait scheduler marks each foot
// `stepping` while it swings, and the frame that flag drops is the plant, at `foot.current`. The
// sound plays there, panned toward that side (html-game-v2's placement and profile), a sample first
// and the v2 noise+tone synth second. Without a body (`feet` null) it falls back to v2's bob-phase
// cadence. Remote players have no feet on the wire, so they keep the distance-stride cadence the
// environment viewer and bot-viewer-v3 use. Jump and
// landing fire on grounded transitions (landing scaled by fall speed), every event has a per-100 ms
// voice budget, and positional sounds are culled before any node graph is built.

export const BASE_GAME_WEAPON_FIRE_EVENTS = Object.freeze({
  m24: 'sniper_shoot', cz_805_bren: 'rifle_shoot', rpg: 'rocket_launch',
  grenade: 'grenade_throw', knife: 'knife_swing',
});
export const weaponFireEvent = weaponId => BASE_GAME_WEAPON_FIRE_EVENTS[weaponId] || 'pistol_shoot';

// BASE_GAME_WEAPON_ACTIONS from base-game-player-bodies.js: idle 0, reload 1, fire 2, holster 3, draw 4.
const ACTION_EVENTS = Object.freeze({ 1: 'weapon_reload', 2: null, 3: null, 4: 'weapon_draw' });

export const BASE_GAME_AUDIO_DEFAULTS = Object.freeze({
  sfxEnabled: true,
  footstepsEnabled: true,
  remoteSfxEnabled: true,
  synthFallback: true,
  walkStride: 1.7,          // remote players: metres between footsteps (environment viewer value)
  sprintStride: 2.4,
  minStepSpeed: 0.5,        // m/s; below this a walker counts as stopped
  stepSideOffset: 0.32,     // html-game-v2: each step lands this far beside the player
  stepHeight: 0.16,         // ...and this far above the feet
  stepStereoPan: 0.18,      // ...panned a little toward that side
  footstepVolume: 0.4,      // v2 sample levels
  jumpVolume: 0.7,
  landingVolume: 0.65,
  cullDistance: 70,         // metres from the listener beyond which a positional sound is skipped
  minAirTime: 0.15,         // seconds airborne before touching down counts as a landing (grounded flickers on slopes)
  budgetWindowMs: 100,
});

// Panner profiles in metres. The arena-scaled numbers bot-viewer-v3 reads from sound-params.js
// are right for a player standing near other players too; the 1 km outdoor set is not.
export const BASE_GAME_SFX_PROFILES = Object.freeze({
  gunshot: { distanceModel: 'inverse', refDistance: 8, maxDistance: 90, rolloffFactor: 0.9 },
  launch: { distanceModel: 'inverse', refDistance: 9, maxDistance: 90, rolloffFactor: 0.85 },
  step: { distanceModel: 'inverse', refDistance: 2.5, maxDistance: 26, rolloffFactor: 1.5 },
  // html-game-v2's own-footstep panner: no rolloff, just the HRTF placement beside the head.
  ownStep: { distanceModel: 'inverse', refDistance: 6, maxDistance: 16, rolloffFactor: 0, volumeScale: 1.45 },
  handling: { distanceModel: 'inverse', refDistance: 3, maxDistance: 30, rolloffFactor: 1.3 },
  // environment-audio.js's largeExplosion / minor (the outdoor set): blasts carry, impacts do not.
  explosion: { distanceModel: 'inverse', refDistance: 38, maxDistance: 1100, rolloffFactor: 0.15 },
  impact: { distanceModel: 'inverse', refDistance: 12, maxDistance: 100, rolloffFactor: 0.85 },
});

const BUDGET = Object.freeze({ footstep: 4, weapon_reload: 4, weapon_draw: 4, jump: 4, landing: 4, default: 8 });

export function createBaseGameAudioDirector({
  audio,                                  // { play, playAt, hasSfxEvent, playSynthAt }
  synthVoice = () => null,                // eventId -> builder | null (weapon-sfx-synth.js)
  getListenerPosition = () => null,       // {x,y,z} in render-local space
  now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  settings = {},
} = {}) {
  if (!audio?.play || !audio?.playAt) throw new TypeError('audio director requires an audio controller');
  const cfg = { ...BASE_GAME_AUDIO_DEFAULTS, ...settings };
  const local = { stepDist: 0, wasGrounded: null, stepIndex: null, airTime: 0, leftStepping: false, rightStepping: false };
  const _stepPos = { x: 0, y: 0, z: 0 };
  const remotes = new Map();
  const windows = new Map();
  const fired = [];   // last call's events, for tests and the diagnostics line

  function budgetOk(eventId) {
    const t = now();
    let w = windows.get(eventId);
    if (!w || t - w.start > cfg.budgetWindowMs) { w = { start: t, count: 0 }; windows.set(eventId, w); }
    if (w.count >= (BUDGET[eventId] ?? BUDGET.default)) return false;
    w.count++;
    return true;
  }

  function emit(eventId, position = null, profile = null, volume = undefined) {
    if (!cfg.sfxEnabled) return false;
    if (position) {
      const l = getListenerPosition();
      if (l) {
        const dx = position.x - l.x, dy = position.y - l.y, dz = position.z - l.z;
        if (dx * dx + dy * dy + dz * dz > cfg.cullDistance * cfg.cullDistance) return false;
      }
    }
    if (!budgetOk(eventId)) return false;
    fired.push(eventId);
    const hasSample = audio.hasSfxEvent ? audio.hasSfxEvent(eventId) : true;
    if (hasSample) {
      if (position) audio.playAt(eventId, position, volume, profile || undefined);
      else audio.play(eventId, volume);
      return true;
    }
    if (!cfg.synthFallback || !audio.playSynthAt) return false;
    const voice = synthVoice(eventId);
    if (!voice) return false;
    const at = position || getListenerPosition();
    if (!at) return false;
    audio.playSynthAt(voice, at, {
      profile: profile || BASE_GAME_SFX_PROFILES.handling,
      volume: volume ?? 0.75,
      volumeScale: profile?.volumeScale,
    });
    return true;
  }

  // Jump on leaving the ground while rising; landing only after real air time, because the
  // controller's grounded flag flickers on slopes and a landing per flicker sounds like footsteps.
  function groundTransitions(state, dt, grounded, rising, position, profile, landingVolume) {
    let landed = false;
    if (state.wasGrounded !== null && state.wasGrounded !== grounded) {
      if (!grounded && rising) emit('jump', position, profile, cfg.jumpVolume);
      else if (grounded && state.airTime >= cfg.minAirTime) { emit('landing', position, profile, landingVolume); landed = true; }
    }
    state.wasGrounded = grounded;
    state.airTime = grounded ? 0 : state.airTime + dt;
    return landed;
  }

  const _ownStepLeft = { ...BASE_GAME_SFX_PROFILES.ownStep, stereoPan: -cfg.stepStereoPan };
  const _ownStepRight = { ...BASE_GAME_SFX_PROFILES.ownStep, stereoPan: cfg.stepStereoPan };
  function plantStep(foot) {
    _stepPos.x = foot.current.x; _stepPos.y = foot.current.y + cfg.stepHeight; _stepPos.z = foot.current.z;
    emit('footstep', _stepPos, foot.side < 0 ? _ownStepLeft : _ownStepRight, cfg.footstepVolume);
  }

  // Footstep cadence + grounded transitions for one walker; `state` is per-player scratch.
  function stride(state, { dt, distance, grounded, sprint, rising }, position, profile) {
    groundTransitions(state, dt, grounded, rising, position, profile, cfg.landingVolume);
    if (!cfg.footstepsEnabled || !grounded) { state.stepDist = 0; return; }
    state.stepDist += distance;
    if (state.stepDist >= (sprint ? cfg.sprintStride : cfg.walkStride)) {
      state.stepDist = 0;
      emit('footstep', position, profile);
    }
  }

  return {
    settings: cfg,
    get lastFired() { return fired; },

    // Local player, once per frame. `feet` is the body's gait state ({ left, right }, each with
    // `stepping` and `current` in render-local space): a footstep plays the frame a foot stops
    // stepping, at that foot. Without feet, `bobPhase` (the weapon view-model's bob clock) plays one
    // each time floor((phase - pi/2) / pi) changes, alternating sides, placed beside `position` along
    // the camera's horizontal `right`. `fallSpeed` scales the landing.
    updateLocal(dt, {
      speed = 0, grounded = true, rising = false, feet = null, bobPhase = null,
      position = null, right = null, fallSpeed = 0,
    } = {}) {
      fired.length = 0;
      groundTransitions(local, dt, grounded, rising, null, null, Math.min(1, cfg.landingVolume + fallSpeed * 0.03));
      const moving = speed >= cfg.minStepSpeed;
      if (feet) {
        const leftNow = !!feet.left?.stepping, rightNow = !!feet.right?.stepping;
        const leftPlanted = local.leftStepping && !leftNow, rightPlanted = local.rightStepping && !rightNow;
        local.leftStepping = leftNow; local.rightStepping = rightNow;
        local.stepIndex = null;
        // Settling shuffles while standing still are not steps; an airborne body does not plant.
        if (!cfg.footstepsEnabled || !grounded || !moving) return fired;
        if (leftPlanted) plantStep(feet.left);
        if (rightPlanted) plantStep(feet.right);
        return fired;
      }
      if (!cfg.footstepsEnabled || !grounded || !moving || !Number.isFinite(bobPhase)) { local.stepIndex = null; return fired; }
      const stepIndex = Math.floor((bobPhase - Math.PI * 0.5) / Math.PI);
      if (local.stepIndex === null) { local.stepIndex = stepIndex; return fired; }   // first moving frame sets the phase
      if (stepIndex === local.stepIndex) return fired;
      local.stepIndex = stepIndex;
      const side = stepIndex % 2 === 0 ? -1 : 1;
      if (position && right) {
        let rx = right.x, rz = right.z;
        const len = Math.hypot(rx, rz);
        if (len > 1e-4) { rx /= len; rz /= len; } else { rx = 1; rz = 0; }
        _stepPos.x = position.x + rx * side * cfg.stepSideOffset;
        _stepPos.y = position.y + cfg.stepHeight;
        _stepPos.z = position.z + rz * side * cfg.stepSideOffset;
        emit('footstep', _stepPos, side < 0 ? _ownStepLeft : _ownStepRight, cfg.footstepVolume);
      } else {
        emit('footstep', null, null, cfg.footstepVolume);
      }
      return fired;
    },
    localReload() { fired.length = 0; emit('weapon_reload'); return fired; },
    localDamage() { fired.length = 0; emit('player_damage'); return fired; },
    // A server hit event on someone else: the flesh impact at the hit point (environment viewer's rule).
    hitAt(position) { fired.length = 0; emit('enemy_hit', position, BASE_GAME_SFX_PROFILES.handling); return fired; },
    impactAt(position) { fired.length = 0; emit('bullet_impact', position, BASE_GAME_SFX_PROFILES.impact); return fired; },
    explosionAt(position) { fired.length = 0; emit('explosion', position, BASE_GAME_SFX_PROFILES.explosion); return fired; },
    localSlotChange() { fired.length = 0; emit('weapon_draw'); return fired; },
    localFire(weaponId) { fired.length = 0; emit(weaponFireEvent(weaponId)); return fired; },
    resetLocal() { local.stepDist = 0; local.wasGrounded = null; local.stepIndex = null; local.airTime = 0; local.leftStepping = local.rightStepping = false; },

    // One remote player, once per frame, from its interpolated sample in render-local space.
    updateRemote(id, { position, grounded = true, action = 0, actionTick = null, weapon = null, sprint = false, dt = 1 / 60 } = {}) {
      fired.length = 0;
      if (!cfg.remoteSfxEnabled || !position) return fired;
      let r = remotes.get(id);
      if (!r) { r = { prev: { ...position }, stepDist: 0, wasGrounded: null, airTime: 0, lastActionTick: actionTick ?? -1 }; remotes.set(id, r); }
      const dx = position.x - r.prev.x, dz = position.z - r.prev.z;
      const rising = position.y - r.prev.y > 0.01;
      r.prev.x = position.x; r.prev.y = position.y; r.prev.z = position.z;
      stride(r, { dt, distance: Math.sqrt(dx * dx + dz * dz), grounded, sprint, rising }, position, BASE_GAME_SFX_PROFILES.step);
      if (actionTick != null && actionTick !== r.lastActionTick) {
        r.lastActionTick = actionTick;
        if (action === 2) emit(weaponFireEvent(weapon), position, weapon === 'rpg' || weapon === 'grenade' ? BASE_GAME_SFX_PROFILES.launch : BASE_GAME_SFX_PROFILES.gunshot);
        else if (ACTION_EVENTS[action]) emit(ACTION_EVENTS[action], position, BASE_GAME_SFX_PROFILES.handling);
      }
      return fired;
    },
    releaseRemote(id) { return remotes.delete(id); },
    clearRemotes() { remotes.clear(); },
    get remoteCount() { return remotes.size; },

    menuOpen() { fired.length = 0; emit('pause_open'); return fired; },
    menuClose() { fired.length = 0; emit('pause_close'); return fired; },
  };
}
