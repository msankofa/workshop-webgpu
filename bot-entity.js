// bot-entity.js — capsule state + physics for FSM-driven combat bots. Browser/THREE only:
// stepBotPhysics needs a mapCollider built from real mesh geometry (three-mesh-bvh), so unlike
// bot-activity.js (Phase 1) this isn't Node-testable the same way creature-activity.js is.
import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';

const DEFAULT_RADIUS = 0.3;
const DEFAULT_STAND_HEIGHT = 1.8; // matches the player/body-preview authored hold height
const GRAVITY = 30;

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
export function stepBotPhysics(bot, dt, { mapCollider, slopeLimitY = 0.5, heightAt } = {}) {
  if (!bot.onFloor) bot.velocity.y -= GRAVITY * dt;
  bot.capsule.translate(_delta.copy(bot.velocity).multiplyScalar(dt));
  if (mapCollider) {
    const contact = mapCollider.resolveCapsule(bot.capsule, bot.velocity, { slopeLimitY });
    bot.onFloor = contact.grounded;
  } else if (typeof heightAt === 'function') {
    const floorY = heightAt(bot.capsule.start.x, bot.capsule.start.z) + bot.capsule.radius;
    if (bot.capsule.start.y <= floorY) {
      const lift = floorY - bot.capsule.start.y;
      bot.capsule.start.y += lift;
      bot.capsule.end.y += lift;
      if (bot.velocity.y < 0) bot.velocity.y = 0;
      bot.onFloor = true;
    } else {
      bot.onFloor = false;
    }
  }
}

// Bot-bot pushout/steering + movement-goal claims live in bot-separation.js (pure, THREE-free,
// Node-tested); re-exported so bot consumers keep a single entity-module import.
export { resolveBotPairs, separationXZ, blendSeparationDir, waypointContested, createGoalClaims } from './bot-separation.js';
// Spatial-hash-backed variants of the same three neighbor queries (see bot-spatial-hash.js).
export { resolveBotPairsHashed, separationXZHashed, waypointContestedHashed } from './bot-separation.js';

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
export function toWirePose(bot) {
  const halfYaw = (bot.yaw + Math.PI) * 0.5;
  const height = Math.max(0.1, bot.capsule.end.y - bot.capsule.start.y);
  const mid = bot.capsule.start.clone().add(bot.capsule.end).multiplyScalar(0.5);
  const crouch01 = bot.crouch01, prone01 = bot.prone01;
  return {
    ...(crouch01 > 0 ? { crouch: crouch01 } : null),
    ...(prone01 > 0 ? { prone: prone01 } : null),
    ...(bot.standHeight > 0 ? { standFullHeight: bot.standHeight + bot.capsule.radius * 2 } : null),
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
