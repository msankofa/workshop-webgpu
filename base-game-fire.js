// Base game trigger step, shared by the relay (authority) and the browser (prediction).
// Everything that already exists is reused: combat.js validateShot gates the cadence and dead
// shooters, player-ammo.js owns magazines. This file only adds what lockstep needs and nothing
// had: the semi-auto press edge and the reload window measured in ticks.
import { validateShot } from './combat.js';
import { getWeapon } from './weapons.js';
import { AIM_DEFAULTS, spreadHalfAngleRad, bloomAfterShot, decayBloomDeg, dispersedDirection } from './bot-aim.js';
import { mulberry32, hashSeed } from './biome-classifier-js.js';
import { BASE_GAME_RELOAD_TICKS, BASE_GAME_SIM_HZ } from './base-game-protocol.mjs';

// Per-player trigger state. `lastShot` is the combat.js shape validateShot reads.
export function createTriggerState() {
  return { held: false, lastShot: null, reloadUntilTick: 0, reloadWeapon: null, bloomDeg: 0, contactSinceTick: -1 };
}

// One tick of trigger handling for `playerId` holding `weaponId`.
// Returns { fired, dry, reloadStarted, reloadDone, reason }.
export function stepTrigger(trigger, ammo, { playerId, weaponId, tick, fire, reload, aim = false, alive = true, simHz = BASE_GAME_SIM_HZ, reloadTicks = BASE_GAME_RELOAD_TICKS }) {
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
  trigger.bloomDeg = decayBloomDeg(trigger.bloomDeg, 1 / simHz);
  if (aim || fire) { if (trigger.contactSinceTick < 0) trigger.contactSinceTick = tick; } else trigger.contactSinceTick = -1;
  if (!weapon || !alive) return out;
  const reloading = trigger.reloadUntilTick > tick;
  const usesAmmo = (weapon.mode || 'hitscan') !== 'melee';
  if (!reloading && reload && usesAmmo) {
    const a = ammo.ensureAmmo(playerId, weaponId);
    if (a.reserve > 0) { trigger.reloadUntilTick = tick + reloadTicks; trigger.reloadWeapon = weaponId; out.reloadStarted = true; return out; }
  }
  if (!edge || reloading) return out;
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
  trigger.bloomDeg = bloomAfterShot(trigger.bloomDeg);
  out.fired = true;
  return out;
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
  const settings = { ...AIM_DEFAULTS, baseSpreadDeg: (weapon?.spreadRad ?? 0) * 180 / Math.PI };
  const heldMs = trigger.contactSinceTick >= 0 ? (tick - trigger.contactSinceTick) * 1000 / simHz : 0;
  const half = spreadHalfAngleRad({ moveSpeed01, heldMs, bloomDeg: trigger.bloomDeg }, settings);
  const roll = mulberry32(hashSeed(seed, tick));
  const out = dispersedDirection({ x: look[0], y: look[1], z: look[2] }, half, roll(), roll());
  return [out.x, out.y, out.z];
}

// The look vector from yaw/pitch in the base-game player-view convention.
export function lookDirection(yaw, pitch) {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}
