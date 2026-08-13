// bot-entity.js — capsule state + physics for FSM-driven combat bots. Browser/THREE first:
// stepBotPhysics normally resolves against a mapCollider built from real mesh geometry
// (three-mesh-bvh), but a stub collider makes it Node-testable (see test-bot-entity-rescue.mjs).
import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import {
  FLAG_ON_FLOOR_IN, FLAG_GROUNDED_RAW, FLAG_ON_FLOOR_OUT,
  FLAG_RESCUED, FLAG_HAS_COLLIDER, FLAG_HAS_GROUND_REF,
} from './bot-forensics.js';

const DEFAULT_RADIUS = 0.3;
const DEFAULT_STAND_HEIGHT = 1.8; // matches the player/body-preview authored hold height
const GRAVITY = 30;
// Metres a capsule's rest height may sit under the reference ground before stepBotPhysics's opt-in
// rescue lifts it: above legitimate slope/mesh-vs-field deviation, under a catch-slab rest (>=1 m).
export const FLOOR_RESCUE_DEPTH = 0.75;
// Seconds between console.warn calls for the SAME bot's rescue. The lift itself is never throttled
// (every rescue still corrects the capsule immediately) -- only the log, so a bot stuck retriggering
// every frame (root cause of the tunnelling is still unconfirmed) can't spam the console forever.
export const FLOOR_RESCUE_WARN_COOLDOWN_S = 3;

// spawnPos is the ground-contact point {x, y, z} (y = floor height under the spawn, not the
// capsule center) -- same convention environment-viewer.html uses for playerCollider (:4780).
export function createBotEntity(id, spawnPos, opts = {}) {
  const radius = opts.radius ?? DEFAULT_RADIUS;
  const standHeight = opts.standHeight ?? DEFAULT_STAND_HEIGHT;
  const start = new THREE.Vector3(spawnPos.x, spawnPos.y + radius, spawnPos.z);
  const end = new THREE.Vector3(spawnPos.x, spawnPos.y + standHeight - radius, spawnPos.z);
  return {
    id,
    capsule: new Capsule(start, end, radius),
    velocity: new THREE.Vector3(),
    onFloor: false,
    floorRescues: 0,   // times stepBotPhysics's opt-in rescue lifted this capsule back onto the ground
    floorRescueWarnAt: 0, // dt-banked cooldown gating the rescue's console.warn (see FLOOR_RESCUE_WARN_COOLDOWN_S)
    yaw: 0,
    pitch: 0,
    weapon: null,
    tool: null,
    isBot: true,
  };
}

const _delta = new THREE.Vector3();

// Gravity + map collision only -- no movement input here, Phase 1/2 set bot.velocity.x/z from
// FSM output before calling this each frame. Mirrors updateFPSPlayer's body
// (environment-viewer.html:6850) minus every camera/fpsKeys/stance reference, none of which
// exist for a bot.
//
// `heightAt(x,z)` is an optional fallback ground test for maps with no BVH `mapCollider` (open
// procedural terrain loaded with no authored mapKey never builds one) -- a flat snap-to-height,
// not full slope physics, since bots on open terrain are steering/wandering, not indoor pathing.
//
// `rescueHeightAt(x,z)` is a separate, opt-in ground reference used ONLY by the below-terrain
// rescue in the `mapCollider` branch. It is deliberately not the same option as `heightAt`: a
// caller whose height function returns the topmost surface (authored maps with roofs/mezzanines)
// must not opt in, or bots legitimately standing indoors get lifted onto the roof.
//
// `forensics` is an opt-in bot-forensics.js recorder (BB-004). It is sampled from INSIDE this
// function because this is the only place preY, the integrated velocity.y (before the rescue zeroes
// it), the raw `contact.grounded` (before the rescue forces onFloor true) and the already-computed
// ground reference all exist at once -- sampling from the caller would need a second ground-height
// call per bot per frame and would lose the two pre-rescue values entirely. The locals below are
// latched wherever their value still exists; when `forensics` is absent nothing else changes.
export function stepBotPhysics(bot, dt, { mapCollider, slopeLimitY = 0.5, heightAt, rescueHeightAt, forensics } = {}) {
  const preY = bot.capsule.start.y;
  const onFloorIn = bot.onFloor;
  let groundY = NaN, hasGroundRef = false, groundedRaw = bot.onFloor, rescued = false;
  bot.floorRescueWarnAt = Math.max(0, (bot.floorRescueWarnAt ?? 0) - dt); // dt-banked, not wall-clock: stays Node-testable
  if (!bot.onFloor) bot.velocity.y -= GRAVITY * dt;
  const velY = bot.velocity.y;   // the value actually integrated below, before any rescue zeroes it
  bot.capsule.translate(_delta.copy(bot.velocity).multiplyScalar(dt));
  if (mapCollider) {
    const contact = mapCollider.resolveCapsule(bot.capsule, bot.velocity, { slopeLimitY });
    bot.onFloor = contact.grounded;
    groundedRaw = contact.grounded;
    // A capsule that tunnels the thin terrain sheet lands on the map's catch slab and reads
    // grounded forever, far under the real ground -- lift it back onto the height field.
    // Ungated on `onFloor` on purpose: tunnelling the slab too would otherwise mean free fall.
    if (typeof rescueHeightAt === 'function') {
      groundY = rescueHeightAt(bot.capsule.start.x, bot.capsule.start.z);
      hasGroundRef = true;
      const restY = groundY + bot.capsule.radius;
      const under = restY - bot.capsule.start.y;
      if (under > FLOOR_RESCUE_DEPTH) {
        bot.capsule.start.y += under;
        bot.capsule.end.y += under;
        if (bot.velocity.y < 0) bot.velocity.y = 0;
        bot.onFloor = true;
        rescued = true;
        bot.floorRescues = (bot.floorRescues ?? 0) + 1;
        if (bot.floorRescueWarnAt <= 0) {
          bot.floorRescueWarnAt = FLOOR_RESCUE_WARN_COOLDOWN_S;
          console.warn(`[bot-entity] floor rescue: ${bot.id} was ${under.toFixed(2)}m under the ground at `
            + `(${bot.capsule.start.x.toFixed(1)}, ${bot.capsule.start.z.toFixed(1)}), `
            + `${bot.floorRescues} total this session`);
        }
      }
    }
  } else if (typeof heightAt === 'function') {
    groundY = heightAt(bot.capsule.start.x, bot.capsule.start.z);
    hasGroundRef = true;
    const floorY = groundY + bot.capsule.radius;
    if (bot.capsule.start.y <= floorY) {
      const lift = floorY - bot.capsule.start.y;
      bot.capsule.start.y += lift;
      bot.capsule.end.y += lift;
      if (bot.velocity.y < 0) bot.velocity.y = 0;
      bot.onFloor = true;
    } else {
      bot.onFloor = false;
    }
    groundedRaw = bot.onFloor;   // no rescue on this path, so the raw verdict is the final one
  }
  if (forensics) {
    forensics.sample(bot, dt, preY, velY, groundY,
      (onFloorIn ? FLAG_ON_FLOOR_IN : 0) | (groundedRaw ? FLAG_GROUNDED_RAW : 0)
      | (bot.onFloor ? FLAG_ON_FLOOR_OUT : 0) | (rescued ? FLAG_RESCUED : 0)
      | (mapCollider ? FLAG_HAS_COLLIDER : 0) | (hasGroundRef ? FLAG_HAS_GROUND_REF : 0));
  }
}

// Bot-bot pushout/steering + movement-goal claims live in bot-separation.js (pure, THREE-free,
// Node-tested); re-exported so bot consumers keep a single entity-module import.
export { resolveBotPairs, separationXZ, blendSeparationDir, waypointContested, createGoalClaims } from './bot-separation.js';
// Spatial-hash-backed variants of the same three neighbor queries (see bot-spatial-hash.js).
export { resolveBotPairsHashed, separationXZHashed, waypointContestedHashed } from './bot-separation.js';
// The BB-004 forensic ring (also pure, THREE-free, Node-tested) rides along the same way.
export { createBotForensics, FORENSIC_RING, FORENSIC_MAX_SLOTS, FORENSIC_STRIDE, FORENSIC_COLUMNS } from './bot-forensics.js';

// Same field shape getLocalPlayerState returns (environment-viewer.html:432) so a bot can be
// pushed into the game's players list unchanged once wired in (spec's "Bot state shape").
//
// bot.yaw follows bot-activity.js's aimAnglesTo convention (0 = +Z, i.e. dz-forward), but the
// wire quaternion's convention (matching camera.rotation.y, which THREE's default camera applies
// to local -Z) treats 0 as -Z-forward -- a fixed pi offset apart. Skipping the +pi here was the
// original bug: the mesh's -Z face (where the ghost's eyes sit, see multiplayer.js) pointed
// opposite the bot's actual aim/movement direction.
// `crouch`/`prone` (0..1 stance pose weights, bot-stance.js) and `standFullHeight` are only emitted
// when a caller has actually stamped them on the entity, so a viewer that never set a stance
// produces the exact wire pose it always did and GhostRenderer's `?? 0` defaults read upright.
// `h`/`fullHeight` stay the LIVE capsule (a crouched bot really is a shorter hit/LOS target);
// `standFullHeight` is the standing profile the rig poses from, so the renderer's own crouch
// channel isn't doubled up by an already-shrunk capsule.
// Phase E adds three more stamped-only fields, all optional with safe renderer defaults:
// `team` (side identity -> GhostRenderer's body palette), `alertTier` (overhead "!" mode:
// 'seen'|'heard'|'push'|'near'), and `deathImpulse` ([x,y,z] m/s of the killing blow, read once on
// the alive->dead edge to kick the death ragdoll).
export function toWirePose(bot) {
  const halfYaw = (bot.yaw + Math.PI) * 0.5;
  const height = Math.max(0.1, bot.capsule.end.y - bot.capsule.start.y);
  const mid = bot.capsule.start.clone().add(bot.capsule.end).multiplyScalar(0.5);
  const crouch01 = bot.crouch01, prone01 = bot.prone01;
  return {
    ...(crouch01 > 0 ? { crouch: crouch01 } : null),
    ...(prone01 > 0 ? { prone: prone01 } : null),
    ...(bot.standHeight > 0 ? { standFullHeight: bot.standHeight + bot.capsule.radius * 2 } : null),
    ...(bot.team ? { team: bot.team } : null),
    // role rides the wire so a guest's ghosts get the same role kit (packs, medic crosses,
    // launcher tubes, sniper helmet) the host renders. Omitted when unset, like the fields above.
    ...(bot.role ? { role: bot.role } : null),
    ...(bot.alertTier ? { alertTier: bot.alertTier } : null),
    ...(bot.deathImpulse ? { deathImpulse: bot.deathImpulse } : null),
    id: bot.id,
    p: [mid.x, mid.y, mid.z],
    q: [0, Math.sin(halfYaw), 0, Math.cos(halfYaw)],
    h: height,
    r: bot.capsule.radius,
    isBot: true,
    fullHeight: height + bot.capsule.radius * 2,
    onFloor: bot.onFloor,
    velocity: [bot.velocity.x, bot.velocity.y, bot.velocity.z],
    weapon: bot.weapon,
    tool: bot.tool,
    aimPitch: bot.pitch,
  };
}
