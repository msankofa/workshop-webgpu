// Base game trigger step, shared by the relay (authority) and the browser (prediction).
// Everything that already exists is reused: combat.js validateShot gates the cadence and dead
// shooters, player-ammo.js owns magazines. This file only adds what lockstep needs and nothing
// had: the semi-auto press edge and the reload window measured in ticks.
import { validateShot } from './combat.js';
import { getWeapon, swapMsFor } from './weapons.js';
import { AIM_DEFAULTS, spreadHalfAngleRad, bloomAfterShot, decayBloomDeg, dispersedDirection } from './bot-aim.js';
import { mulberry32, hashSeed } from './biome-classifier-js.js';
import { BASE_GAME_RELOAD_TICKS, BASE_GAME_SIM_HZ } from './base-game-protocol.mjs';
import { SHOT_SPREAD_DEFAULTS, normalizeShotSpread } from './shot-spread.js';

// The accuracy numbers, shared by every trigger on this side of the wire. The relay sets them from
// shot-spread.json at startup and the page from its own copy of the same file; both sides must hold
// the same values or the shooter's predicted tracer is not the ray the server fired.
let spread = { ...SHOT_SPREAD_DEFAULTS };
export function setShotSpread(values) { spread = normalizeShotSpread(values); return spread; }
export function getShotSpread() { return { ...spread }; }
// bot-aim.js's settings shape, built from the tuned numbers. `weaponId` supplies the base cone.
function aimSettingsFor(weapon) {
  return {
    ...AIM_DEFAULTS,
    baseSpreadDeg: (weapon?.spreadRad ?? 0) * 180 / Math.PI * spread.spreadScale,
    moveSpreadDeg: spread.moveSpreadDeg,
    firstShotSpreadDeg: spread.firstShotSpreadDeg,
    settleMs: spread.settleMs,
    bloomPerShotDeg: spread.bloomPerShotDeg,
    bloomMaxDeg: spread.bloomMaxDeg,
    bloomDecayDegPerSecond: spread.bloomDecayDegPerSecond,
  };
}

// Per-player trigger state. `lastShot` is the combat.js shape validateShot reads.
export function createTriggerState() {
  return { held: false, lastShot: null, reloadUntilTick: 0, reloadWeapon: null, bloomDeg: 0, contactSinceTick: -1 };
}

// One tick of trigger handling for `playerId` holding `weaponId`.
// Returns { fired, dry, reloadStarted, reloadDone, reason }.
export function stepTrigger(trigger, ammo, { playerId, weaponId, tick, fire, reload, aim = false, alive = true, blocked = false, simHz = BASE_GAME_SIM_HZ, reloadTicks = BASE_GAME_RELOAD_TICKS }) {
  const out = { fired: false, dry: false, reloadStarted: false, reloadDone: false, reason: null };
  if (trigger.reloadUntilTick > 0 && tick >= trigger.reloadUntilTick) {
    if (trigger.reloadWeapon) ammo.reloadAmmo(playerId, trigger.reloadWeapon);
    trigger.reloadUntilTick = 0; trigger.reloadWeapon = null;
    out.reloadDone = true;
  }
  const weapon = weaponId ? getWeapon(weaponId) : null;
  const edge = !!fire && (weapon?.automatic || !trigger.held);
  trigger.held = !!fire;
  // bot-aim.js bloom decays every tick; "contact" (the first-shot settle timer) runs from the
  // first tick the player holds aim or the trigger and resets when both are released.
  trigger.bloomDeg = decayBloomDeg(trigger.bloomDeg, 1 / simHz, aimSettingsFor(weapon));
  if (aim || fire) { if (trigger.contactSinceTick < 0) trigger.contactSinceTick = tick; } else trigger.contactSinceTick = -1;
  if (!weapon || !alive) return out;
  const reloading = trigger.reloadUntilTick > tick;
  const usesAmmo = (weapon.mode || 'hitscan') !== 'melee';
  if (!reloading && reload && usesAmmo && !blocked) {
    const a = ammo.ensureAmmo(playerId, weaponId);
    // A bottomless magazine has nothing to reload into, and the window would only gate firing.
    if (a.reserve > 0 && a.mag !== Infinity) { trigger.reloadUntilTick = tick + reloadTicks; trigger.reloadWeapon = weaponId; out.reloadStarted = true; return out; }
  }
  if (!edge || reloading || blocked) return out;
  const nowMs = tick * 1000 / simHz;
  const shooter = { alive, weapon: weaponId, p: [0, 0, 0], h: 0 };
  const intent = { weapon: weaponId, shotSeq: tick, origin: [0, 0, 0], dir: [0, 0, -1] };
  const v = validateShot({ shooter, weapon, intent, nowMs, lastShot: trigger.lastShot });
  if (!v.ok) { out.reason = v.reason; return out; }
  if (usesAmmo && ammo.ensureAmmo(playerId, weaponId).mag <= 0) {
    out.dry = true;
    if (ammo.ensureAmmo(playerId, weaponId).reserve > 0) { trigger.reloadUntilTick = tick + reloadTicks; trigger.reloadWeapon = weaponId; out.reloadStarted = true; }
    trigger.lastShot = { at: nowMs, shotSeq: tick };
    return out;
  }
  if (usesAmmo) ammo.consumeAmmo(playerId, weaponId);
  trigger.lastShot = { at: nowMs, shotSeq: tick };
  trigger.bloomDeg = bloomAfterShot(trigger.bloomDeg, aimSettingsFor(weapon));
  out.fired = true;
  return out;
}

// ---- weapon swaps -------------------------------------------------------------------------
// Putting one weapon away and bringing the next up, in ticks so both sides land on the same frame.
// The swap is the ONLY thing that gates the trigger besides a reload: you cannot shoot with a gun
// halfway to your back.
export function createSwapState() { return { active: false, startTick: 0, drawAtTick: 0, untilTick: 0, from: null, to: null }; }

export function swapTicks(ms, simHz = BASE_GAME_SIM_HZ) { return Math.max(1, Math.round(ms * simHz / 1000)); }

// Starts a swap at `tick`. A refused swap (mid-reload) leaves the state untouched and returns false.
export function beginSwap(swap, { tick, from, to, reloading = false, simHz = BASE_GAME_SIM_HZ }) {
  if (reloading) return false;   // both hands are busy; the plan's rule, enforced on both sides
  const holster = from ? swapTicks(swapMsFor(from).holsterMs, simHz) : 0;
  const draw = to ? swapTicks(swapMsFor(to).drawMs, simHz) : 0;
  swap.active = holster + draw > 0;
  swap.startTick = tick;
  swap.drawAtTick = tick + holster;
  swap.untilTick = tick + holster + draw;
  swap.from = from ?? null;
  swap.to = to ?? null;
  return swap.active;
}

// 'idle' | 'holster' | 'draw'. Pure: asking what phase a swap is in must never change it, or the
// answer depends on who asked first.
export function swapPhase(swap, tick) {
  if (!swap?.active || tick >= swap.untilTick) return 'idle';
  return tick < swap.drawAtTick ? 'holster' : 'draw';
}

// What the mount's `drawBlend` should be: 1 = the live hold, 0 = the weapon down at its stow point.
// Holster runs 1 -> 0 on the outgoing weapon, draw 0 -> 1 on the incoming one.
export function drawBlendFor(swap, tick) {
  const phase = swapPhase(swap, tick);
  if (phase === 'idle') return 1;
  if (phase === 'holster') {
    const span = swap.drawAtTick - swap.startTick;
    return span > 0 ? Math.max(0, 1 - (tick - swap.startTick) / span) : 0;
  }
  const span = swap.untilTick - swap.drawAtTick;
  return span > 0 ? Math.min(1, (tick - swap.drawAtTick) / span) : 1;
}

// The same curve for a remote, whose only evidence is the replicated action and the tick it began.
export function remoteDrawBlend(action, actionTick, tick, weaponId, simHz = BASE_GAME_SIM_HZ) {
  if (action !== 3 && action !== 4) return 1;
  const ms = swapMsFor(weaponId);
  const span = swapTicks(action === 3 ? ms.holsterMs : ms.drawMs, simHz);
  const t = Math.max(0, Math.min(1, (tick - actionTick) / span));
  return action === 3 ? 1 - t : t;
}

// A quick-throw of the throwable slot: the same trigger step on its own state, so cadence comes
// from weapons.js fireIntervalMs and the count from player-ammo.js. Nothing is held, so there is
// no reload -- the pouch puts the next grenade in the hand the moment one leaves it.
export function stepThrow(trigger, ammo, opts) {
  const weapon = opts.weaponId ? getWeapon(opts.weaponId) : null;
  if (!weapon || (weapon.mode || 'hitscan') !== 'projectile') return { fired: false, dry: false, reloadStarted: false, reloadDone: false, reason: 'not-throwable' };
  const out = stepTrigger(trigger, ammo, { ...opts, reload: false });
  if (out.fired) ammo.reloadAmmo(opts.playerId, opts.weaponId);
  return out;
}

// Dispersion for one shot, bot-aim.js's cone with weapons.js's authored `spreadRad` as the base
// angle: move widens it, an aim hold tightens the first-shot term, bloom climbs per shot. The two
// rolls come from a stream seeded on (seed, tick), so the server and the shooter's client draw the
// same ray. Both sides call it right after stepTrigger reports `fired` for the tick.
export function shotDirectionFor(trigger, { yaw, pitch, weaponId, tick, seed = 0, moveSpeed01 = 0, simHz = BASE_GAME_SIM_HZ }) {
  const weapon = weaponId ? getWeapon(weaponId) : null;
  const look = lookDirection(yaw, pitch);
  const settings = aimSettingsFor(weapon);
  const heldMs = trigger.contactSinceTick >= 0 ? (tick - trigger.contactSinceTick) * 1000 / simHz : 0;
  const half = spreadHalfAngleRad({ moveSpeed01, heldMs, bloomDeg: trigger.bloomDeg }, settings);
  const roll = mulberry32(hashSeed(seed, tick));
  const out = dispersedDirection({ x: look[0], y: look[1], z: look[2] }, half, roll(), roll());
  return [out.x, out.y, out.z];
}

// The live dispersion cone for the weapon in hand, in radians (half-angle) -- the same number
// shotDirectionFor draws inside, exposed so a reticle can show the cone rather than guess at it.
export function spreadHalfAngleFor(trigger, { weaponId, tick, moveSpeed01 = 0, simHz = BASE_GAME_SIM_HZ }) {
  const weapon = weaponId ? getWeapon(weaponId) : null;
  if (!weapon) return 0;
  const heldMs = trigger?.contactSinceTick >= 0 ? (tick - trigger.contactSinceTick) * 1000 / simHz : 0;
  return spreadHalfAngleRad({ moveSpeed01, heldMs, bloomDeg: trigger?.bloomDeg ?? 0 }, aimSettingsFor(weapon));
}

// The look vector from yaw/pitch in the base-game player-view convention.
export function lookDirection(yaw, pitch) {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}
