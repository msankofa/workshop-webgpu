import {
  BASE_GAME_PROTOCOL_VERSION,
  BASE_GAME_DEFAULT_LOADOUT, BASE_GAME_WEAPON_ACTION, BASE_GAME_WEAPON_SLOTS, BASE_GAME_RELOAD_TICKS, sanitizeBaseGameLoadout, weaponForSlot, stanceName, stanceIndex, isBaseGameGadget,
  BASE_GAME_GADGET_THROW_TICKS, BASE_GAME_GADGET_THROW_ACTION_TICKS, BASE_GAME_GADGET_RELOAD_TICKS, defaultGadgetStock,
  BASE_GAME_LAG_COMP_MS, BASE_GAME_RESPAWN_TICKS, BASE_GAME_FIRE_ACTION_TICKS, wireAmmo,
  BASE_GAME_POSITION_HISTORY,
  BASE_GAME_TEAMS, sanitizeBaseGameNpcRequest, sanitizeBaseGameVehicleRequest, sanitizeBaseGameDroneRequest, BASE_GAME_WORLD_DRONE_CAP,
  DEFAULT_BASE_GAME_BODY_MODEL, bodyModelById, hitProfileForBodyModel, sanitizeBaseGameBodyModel,
  BASE_GAME_ROOM_GRACE_MS,
  BASE_GAME_ROOM_PLAYER_CAP,
  BASE_GAME_SIM_HZ,
  BASE_GAME_STALL_TICKS,
  BASE_GAME_TICK_QUEUE_DRAIN,
  advanceBaseGameWorld,
  createBaseGameRateLimiter,
  isAcceptableBaseGameTick,
  neutralBaseGameInput,
  normalizeBaseGameRoomCode,
  sanitizeBaseGameInputPacket,
  sanitizeBaseGameWorldPatch,
  sanitizeBaseGameTerrainConfig,
  describeBaseGameTerrainConfig,
  publicBaseGameTerrainConfig,
  waveOptionsFromWorld,
} from '../base-game-protocol.mjs';
import { createBaseGameWaterSim } from '../base-game-water-sim.js';
import { createTerrainStore } from './terrain-store.js';
import { createBaseGamePlayerController } from '../base-game-player-controller.js';
// Firing reuses the multiplayer-guns stack: combat.js (hitscan, validation, pose history for lag
// compensation), player-combat.js (hp/alive/revive) and player-ammo.js (magazines).
import { resolveHitscan } from '../combat.js';
import { createPlayerBodyPose, playerPoseAnchor, stepPlayerBodyPose } from '../player-body-pose.js';
import {
  createPlayerHitRigHistory,
  distanceToPlayerHitRig,
  pushPlayerHitRigPose,
  samplePlayerHitRigPose,
} from '../player-hit-rig.js';
import { createPlayerCombatFacade } from '../player-combat.js';
import { createAmmoStore } from '../player-ammo.js';
import { createTriggerState, stepTrigger, stepThrow, shotDirectionFor, createSwapState, beginSwap, swapPhase, lookDirection } from '../base-game-fire.js';
import { createBaseGameDrone, spawnWorldDrone, stepBaseGameDrone, sendDroneTo, recallDrone, takeOverDrone, releaseDrone, droneWireState, fireAgm, stepGuidedProjectiles, droneHitVolumes, blastDamageOnDrone, damageBaseGameDrone } from '../base-game-drones.js';
import {
  VEHICLE_UGV, VEHICLE_BUGGY, createBaseGameVehicle, stepBaseGameVehicle, stepVehicleSeat,
  sendVehicleTo, recallVehicle, takeOverVehicle, releaseVehicle, vehicleWireState, vehicleSeatState,
  fireVehicleTurret,
} from '../base-game-vehicles.js';
import { createProjectileManager } from '../bot-projectiles.js';
import { blastDamageAt } from '../entity-types/explosion.js';
import { isSurfaceDetonation } from '../entity-types/combat-projectile.js';
import { botSeedFromId } from '../bot-activity.js';
import { aimSettingsForAccuracy } from '../bot-aim.js';
import { BASE_GAME_PLAYER_DEFAULT_CONFIG } from '../base-game-player-controller.js';
import { getWeapon } from '../weapons.js';
import { createRoomNpcs, findNpcSpawn, appearanceFor, NPC_WALK_SPEED, NPC_RUN_MULTIPLIER } from './base-game-npcs.js';
import { randomUUID } from 'node:crypto';

function defaultToken() {
  return `${randomUUID()}-${randomUUID()}`;
}

export function formatBaseGameNpcProfStats(s, f = value => Number(value).toFixed(1)) {
  if (!s) return '';
  return ` sync ${f(s.syncMs)} brain ${f(s.thinkMs)} input ${f(s.inputMs)} rays ${s.raycasts} heightAt ${s.heights} bakes ${s.bakes}`;
}

// Builds the authoritative world for a sanitized terrain config. Traversal Lab is the exact
// collision the browser renders; terrain rooms use the same pure source + heightfield provider
// Solo uses (the heightfield is infinite, so nothing has to stream on the server). Built lazily
// so tests that never create a room do not pay for the BVH bake.
async function defaultWorldFactory(config = { kind: 'traversalLab' }) {
  const { createWorldQueryService } = await import('../world-query.js');
  const worldQuery = createWorldQueryService();
  if (config.kind === 'terrain') {
    const [{ createSource }, , , { createHeightfieldWorldQueryProvider }] = await Promise.all([
      import('../terrain-source.js'),
      import('../terrain-source-analytic.js'),
      import('../terrain-source-v5.js'),
      import('../world-query-heightfield-provider.js'),
    ]);
    const source = createSource(config.descriptor);
    const killBelow = 80;
    const seaLevel = config.descriptor.seaLevel ?? 0;
    if (config.volumetric) {
      // Volumetric rooms collide against the same marching-cubes tiles the clients stream,
      // built synchronously around the players each step (terrain-volume-collision.js).
      const { createVolumeCollision } = await import('../terrain-volume-collision.js');
      const volume = createVolumeCollision(source, { worldQuery });
      const surface = (x, z) => source.surfaceYAt(x, z);
      const floorY = source.project?.density?.y_min;
      return {
        worldQuery,
        spawn: [0, Math.max(surface(0, 0), seaLevel) + 1.5, 0],
        seaLevel,
        killPlaneYAt: (x, z) => Math.min(surface(x, z) - killBelow, Number.isFinite(floorY) ? floorY - 10 : Infinity),
        heightAt: surface,
        worldVersion: config.worldVersion,
        terrain: config,
        volume,
        prepare: positions => volume.ensure(positions),
        covers: (x, z) => volume.covers(x, z),
      };
    }
    const provider = createHeightfieldWorldQueryProvider(source, { id: 'terrain' });
    worldQuery.registerProvider(provider);
    return {
      worldQuery,
      spawn: [0, Math.max(source.heightAt(0, 0), seaLevel) + 1.5, 0],
      seaLevel,
      killPlaneYAt: (x, z) => source.heightAt(x, z) - killBelow,
      heightAt: (x, z) => source.heightAt(x, z),
      worldVersion: config.worldVersion,
      terrain: config,
    };
  }
  const { createTraversalLabWorldQuery } = await import('../traversal-lab-collider.js');
  const lab = createTraversalLabWorldQuery(worldQuery);
  return {
    worldQuery,
    spawn: lab.layout.spawn,
    killPlaneY: lab.layout.killPlaneY,
    worldVersion: `traversal-lab-v${lab.layout.version}`,
    terrain: config,
  };
}

export function createBaseGameRoomService({
  now = () => Date.now(),
  makeToken = defaultToken,
  graceMs = BASE_GAME_ROOM_GRACE_MS,
  playerCap = BASE_GAME_ROOM_PLAYER_CAP,
  simHz = BASE_GAME_SIM_HZ,
  stallTicks = BASE_GAME_STALL_TICKS,
  drainDepth = BASE_GAME_TICK_QUEUE_DRAIN,
  world = null,
  worldFactory = defaultWorldFactory,
  // Published v5 projects by hash; rooms and packets carry the hash, not the body.
  terrainStore = createTerrainStore(),
} = {}) {
  const rooms = new Map();
  const socketClients = new Map();
  const tokenClients = new Map();
  const stepMs = 1000 / simHz;
  // Worlds are immutable per config, so rooms that pick the same terrain share one instance.
  const worlds = new Map();   // worldVersion -> { world: ready world | null, pending: Promise }

  const send = (ws, payload) => {
    if (ws?.readyState === 1) ws.send(JSON.stringify(payload));
  };

  // Movement never runs against a substitute floor: until the room's authoritative world is
  // resident, players keep their spawn state and snapshots say so. An injected `world` (tests)
  // serves every room regardless of config.
  function buildWorld(config) {
    if (world) return Promise.resolve(world);
    let entry = worlds.get(config.worldVersion);
    if (!entry) {
      entry = { world: null, pending: null };
      entry.pending = Promise.resolve(worldFactory(config)).then(result => {
        entry.world = result;
        for (const r of rooms.values()) if (r.terrain.worldVersion === config.worldVersion && !r.sim) { r.sim = result; attachRoomControllers(r); }
        return result;
      }, err => { entry.error = err; throw err; });
      worlds.set(config.worldVersion, entry);
    }
    return entry.pending;
  }
  function ensureWorld(room) {
    const config = room.terrain;
    if (world) { room.sim = world; attachRoomControllers(room); return Promise.resolve(world); }
    const pending = buildWorld(config);
    const entry = worlds.get(config.worldVersion);
    if (entry?.world && !room.sim) { room.sim = entry.world; attachRoomControllers(room); }
    return pending;
  }

  function attachRoomControllers(room) {
    syncRoomWater(room);
    for (const client of room.clients.values()) attachController(client);
    attachProjectiles(room);
  }

  // The room's sea: level from the terrain descriptor (worlds without one — the lab — have none),
  // spectrum from the shared world keys. Players swim against this, so it is authoritative here
  // and every client predicts with the same module and the same tick clock.
  function syncRoomWater(room) {
    const level = room.sim?.seaLevel;
    const hasSea = Number.isFinite(level);
    room.water.setLevel(hasSea ? level : 0);
    room.water.setEnabled(hasSea && room.world.waterEnabled !== false);
    room.water.setWaves(waveOptionsFromWorld(room.world));
  }

  // Server projectiles: bot-projectiles.js flying the weapons.js specs, environment-viewer's
  // raycast rule (bodies and walls detonate; ground hits are left to the entity's own terrain
  // contact so grenades bounce) and its blast curve (entity-types/explosion.js).
  function attachProjectiles(room) {
    const sim = room.sim;
    if (room.projectiles || !sim) return;
    const terrainHeight = typeof sim.heightAt === 'function' ? sim.heightAt : null;
    room.projectiles = createProjectileManager({
      terrainHeight,
      raycast(from, to, radius, ownerId, proj) {
        const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
        const range = Math.hypot(dx, dy, dz);
        if (!(range > 0)) return null;
        const dir = [dx / range, dy / range, dz / range];
        const players = [];
        for (const other of room.clients.values()) {
          if (!other.controller) continue;
          updateClientHitPose(other);
          players.push({ id: other.id, rig: other.hitPose, alive: other.hitPose.alive });
        }
        // Never the aircraft that fired it: a missile leaves from inside its launcher's hit sphere.
        const mobs = droneHitVolumes(room.drones, proj?.guide?.droneId ?? null);
        const hit = resolveHitscan({ shooterId: ownerId, origin: from, dir, range, players, mobs, playerInflate: radius, occluder: worldOccluder(room) });
        if (!hit || hit.kind === 'none') return null;
        if (hit.kind === 'world' && terrainHeight && hit.normal && hit.normal[1] > 0.5) return null;   // ground: the entity bounces or detonates itself
        return { point: hit.point, kind: hit.kind, id: hit.id };
      },
      onDetonate(point, proj, init) { detonateProjectile(room, point, proj, init); },
    });
  }

  function worldOccluder(room) {
    const worldQuery = room.sim?.worldQuery ?? null;
    if (!worldQuery) return undefined;
    return (o, d, range) => { try { const h = worldQuery.raycast({ origin: o, direction: d, maxDistance: range }); return h ? { distance: h.distance, point: h.point, normal: h.normal } : null; } catch { return null; } };
  }

  // Damage onto one drone, from a bullet or a blast. A drone that dies falls and goes off where it
  // lands (base-game-drones.js owns that), so nothing here has to decide where the explosion is.
  function hitDrone(room, id, damage, point, weaponId, shooterId) {
    const rec = room.drones.get(id);
    if (!rec || rec.done) return;
    const before = rec.d.hp;
    const res = damageBaseGameDrone(rec, damage, { roll: Math.random() });
    // A hit event so every client flashes the drone the same way it flashes a player.
    room.events.hits.push({ victim: id, shooter: shooterId ?? null, point: [...point], weapon: weaponId ?? null, damage: Math.min(before, damage), tick: room.tick });
    if (res.dead && rec.done && rec.crash && rec.def.crashBlast) {
      detonateBlast(room, rec.crash, { ...rec.def.crashBlast, ownerId: rec.ownerId, weaponId: `${rec.kind}_crash`, contact: true });
      room.drones.delete(id);
    }
  }

  // environment-viewer's applyExplosionBlast on the room roster: blastDamageAt falloff, friendly
  // fire and self-damage on, every victim gets a hit event so clients flash the same way.
  function detonateProjectile(room, point, proj, init = null) {
    detonateBlast(room, point, { radius: proj.state.blastRadius, damage: proj.state.damage, ownerId: proj.ownerId, weaponId: proj.weaponId, contact: isSurfaceDetonation(init?.cause) });
  }
  // One blast: the event every client presents, and the damage to every rig in reach. Projectiles
  // and crashing drones both come through here.
  function detonateBlast(room, point, { radius, damage, ownerId = null, weaponId = null, contact = true }) {
    const weapon = weaponId ? getWeapon(weaponId) : null;
    const owner = ownerId ? room.clients.get(ownerId) ?? null : null;
    room.events.explosions.push({ p: [...point], radius, owner: ownerId, weapon: weaponId, contact, tick: room.tick });
    for (const victim of room.clients.values()) {
      if (!victim.controller) continue;
      updateClientHitPose(victim);
      if (!victim.hitPose.alive) continue;
      const dmg = blastDamageAt(damage, distanceToPlayerHitRig(point, victim.hitPose), radius);
      if (dmg <= 0) continue;
      applyDamage(room, victim, dmg, { shooter: owner, point, weaponId: weapon?.id ?? weaponId, source: 'explosion' });
    }
    // Drones take the blast too, so a missile that lands beside one brings it down, and so does a
    // drone going off next to another one. A drone already ending its own life is skipped, or two
    // crashing together would detonate each other forever.
    for (const rec of [...room.drones.values()]) {
      if (rec.done || `${rec.kind}_crash` === weaponId) continue;
      const dmg = blastDamageOnDrone(rec, point, radius, damage);
      if (dmg > 0) hitDrone(room, rec.id, dmg, point, weaponId, ownerId);
    }
  }

  function applyDamage(room, victim, amount, { shooter = null, point = null, normal = null, weaponId = null, source = 'gun', zone = null, side = 'center' } = {}) {
    const wasAlive = room.combat.getSnapshot(victim.id).alive;
    if (!wasAlive) return;
    // Friendly fire is a room rule (default on); self-damage always counts.
    if (room.world.npcFriendlyFire === false && shooter && shooter !== victim && (shooter.team ?? BASE_GAME_TEAMS.friendly) === (victim.team ?? BASE_GAME_TEAMS.friendly)) return;
    const after = room.combat.applyDamage({ targetId: victim.id, amount, source, attackerId: shooter?.id ?? null, hitPoint: point, weaponId });
    room.npcs?.damaged(victim, shooter, amount);
    room.events.hits.push({ shooter: shooter?.id ?? null, victim: victim.id, point: point ?? victim.controller.getPosition(), normal, damage: amount, zone, side, head: zone === 'head', tick: room.tick });
    if (after.alive) return;
    victim.deaths++;
    if (shooter && shooter !== victim) shooter.kills++;
    victim.respawnAtTick = room.tick + BASE_GAME_RESPAWN_TICKS;
    victim.action = BASE_GAME_WEAPON_ACTION.idle;
    dropStick(victim);
    room.events.deaths.push({ victim: victim.id, killer: shooter?.id ?? null, tick: room.tick });
  }

  function attachController(client) {
    const sim = client.room.sim;
    if (client.controller || !sim) return;
    client.controller = createBaseGamePlayerController({
      worldQuery: sim.worldQuery,
      spawn: sim.spawn,
      config: { fixedHz: simHz, ...playerConfigFromWorld(client.room.world) },
      waterSurfaceAt: (x, z, t) => client.room.water.heightAt(x, z, t),
    });
    updateClientHitPose(client);
  }

  function playerConfigFromWorld(world) {
    const fields = {
      playerMoveSpeed: 'moveSpeed', playerSprintMultiplier: 'sprintMultiplier',
      playerJumpSpeed: 'jumpSpeed', playerGravity: 'gravity',
      playerGroundDeceleration: 'groundDeceleration',
      playerSlopeSlideDeceleration: 'slopeSlideDeceleration',
      playerSlopeLimit: 'slopeLimitDegrees', playerStepHeight: 'stepHeight',
      playerSnapDistance: 'snapDistance',
    };
    const config = {};
    for (const [key, field] of Object.entries(fields)) if (Number.isFinite(world?.[key])) config[field] = world[key];
    return config;
  }

  function syncRoomPlayerConfig(room) {
    const config = playerConfigFromWorld(room.world);
    for (const client of room.clients.values()) client.controller?.configure(config);
  }

  function updateClientHitPose(client) {
    if (!client.controller) return null;
    const combat = client.room.combat.getSnapshot(client.id);
    return stepPlayerBodyPose(client.hitPose, {
      position: client.controller.getPosition(),
      velocity: client.controller.getVelocity(),
      yaw: client.lastInput.yaw,
      pitch: client.lastInput.pitch,
      grounded: client.controller.grounded,
      swimming: client.controller.swimming,
      aiming: client.aiming,
      tick: client.lastConsumedTick,
      fixedHz: simHz,
      poseEpoch: client.poseEpoch,
      profileId: client.hitProfile,
      alive: combat.alive,
      hp: combat.hp,
    });
  }

  function advance(room, at = now()) {
    advanceBaseGameWorld(room.world, at - room.worldUpdatedAt);
    room.worldUpdatedAt = at;
  }

  function connectedClients(room) {
    return [...room.clients.values()].filter(client => client.ws?.readyState === 1);
  }

  function playerEntry(client, room) {
    const controller = client.controller;
    const controlledVehicle = client.controlling ? room.vehicles.get(client.controlling) : null;
    return {
      id: client.id,
      connected: !!client.npc || client.ws?.readyState === 1,
      owner: client.id === room.ownerId,
      spawnRevision: client.spawnRevision,
      tick: room.tick,
      lastProcessedTick: client.lastConsumedTick,
      queueDepth: client.queue.length,
      lastInputClientTime: client.lastInputClientTime,
      position: controller ? controller.getPosition() : [...(room.sim?.spawn ?? [0, 0, 0])],
      velocity: controller ? controller.getVelocity() : [0, 0, 0],
      yaw: client.lastInput.yaw,
      pitch: client.lastInput.pitch,
      grounded: controller ? controller.grounded : false,
      slot: client.slot,
      // What is IN HAND, which during a holster is still the weapon being put away: the slot moved
      // on the key press, but the gun has not left the hands yet, and a remote that swapped the
      // model now would play the holster on the wrong weapon.
      weapon: heldWeapon(client),
      loadout: { ...client.loadout },   // the stowed guns are the slots that are not in hand
      aiming: client.aiming,
      stance: stanceIndex(client.controller?.stance ?? 'stand'),
      action: client.action,
      actionTick: client.actionTick,
      health: room.combat.getSnapshot(client.id).hp,
      dead: !room.combat.getSnapshot(client.id).alive,
      ammo: wireAmmo(heldWeapon(client) ? room.ammo.ensureAmmo(client.id, heldWeapon(client)) : null),
      bodyModel: client.bodyModel,
      hitProfile: client.hitProfile,
      poseEpoch: client.poseEpoch,
      controlling: client.controlling,
      vehicle: controlledVehicle?.driver === client.id ? vehicleSeatState(controlledVehicle) : null,
      gadgets: { ...client.gadgets },
      gadgetReady: client.gadgetReady,
      team: client.team ?? BASE_GAME_TEAMS.friendly,
      npc: !!client.npc,
      appearance: client.appearance ?? null,
    };
  }

  // One-shot hit/death events ride the next broadcast snapshot and are then cleared. The
  // per-client snapshot a joiner receives (drain=false) leaves them for everyone else's broadcast.
  function snapshot(room, drain = true) {
    advance(room);
    const { hits, deaths, shots, explosions } = room.events;
    if (drain) room.events = emptyEvents();
    return {
      type: 'base:snapshot',
      protocol: BASE_GAME_PROTOCOL_VERSION,
      room: room.code,
      revision: room.revision,
      serverTime: now(),
      tick: room.tick,
      simHz,
      worldVersion: room.sim?.worldVersion ?? null,
      worldReady: !!room.sim,
      terrain: describeBaseGameTerrainConfig(room.terrain),
      ownerId: room.ownerId,
      world: { ...room.world },
      players: [...room.clients.values()].map(client => playerEntry(client, room)),
      hits,
      deaths,
      shots,
      explosions,
      projectiles: room.projectiles ? room.projectiles.list.map(projectileEntry) : [],
      drones: [...room.drones.values()].map(droneWireState),
      vehicles: [...room.vehicles.values()].map(vehicleWireState),
    };
  }
  function emptyEvents() { return { hits: [], deaths: [], shots: [], explosions: [] }; }
  function projectileEntry(proj) {
    return { id: proj.id, p: [...proj.transform.p], v: [proj.sim.vx, proj.sim.vy, proj.sim.vz], color: proj.state.color, weapon: proj.weaponId, owner: proj.ownerId, radius: proj.state.radius };
  }

  function broadcast(room, payload = snapshot(room)) {
    for (const client of connectedClients(room)) send(client.ws, payload);
  }

  function fail(ws, code, message) {
    send(ws, { type: 'base:error', protocol: BASE_GAME_PROTOCOL_VERSION, code, message });
  }

  function validateHandshake(ws, msg) {
    if (msg.protocol !== BASE_GAME_PROTOCOL_VERSION) {
      fail(ws, 'protocol_mismatch', `Base-game protocol ${BASE_GAME_PROTOCOL_VERSION} required`);
      return false;
    }
    return true;
  }

  // A resync adopts the client's next tick numbering and bumps the spawn revision so the client
  // hard-snaps and clears its prediction history. Used at join, resume, and after the server has
  // had to run steps the client never sent.
  function requestResync(client) {
    client.awaitingResync = true;
    client.queue.length = 0;
    client.stalledTicks = 0;
  }

  function makeClient(ws, room) {
    const id = `p_${makeToken().replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}`;
    const token = makeToken();
    const client = {
      id, token, room, ws,
      disconnectedAt: null,
      controller: null,
      queue: [],
      lastConsumedTick: 0,
      lastInput: neutralBaseGameInput(),
      lastInputClientTime: null,
      awaitingResync: true,
      stalledTicks: 0,
      spawnRevision: 1,
      rate: createBaseGameRateLimiter(),
      rejectedInputs: 0,
      serverSteps: 0,
      loadout: { ...BASE_GAME_DEFAULT_LOADOUT },
      slot: 0,
      aiming: false,
      action: BASE_GAME_WEAPON_ACTION.idle,
      actionTick: 0,
      actionUntilTick: 0,
      respawnAtTick: 0,
      kills: 0,
      deaths: 0,
      trigger: createTriggerState(),
      throwTrigger: createTriggerState(),
      swap: createSwapState(),
      bodyModel: DEFAULT_BASE_GAME_BODY_MODEL,
      pendingBodyModel: null,
      hitProfile: hitProfileForBodyModel(DEFAULT_BASE_GAME_BODY_MODEL),
      poseEpoch: 1,
      hitPose: createPlayerBodyPose(),
      rewindPose: createPlayerBodyPose(),
      controlling: null,    // id of the drone this player is flying
      gadgetHeld: false,    // fire edge for the gadget slot
      gadgets: defaultGadgetStock(),   // drones left this life, per kind
      gadgetReady: true,    // one is in the hands
      gadgetThrow: null,    // { kind, atTick, yaw, pitch }: a wind-up in progress
      gadgetReloadAt: 0,    // tick the next one is in the hands
    };
    room.combat.ensurePlayer(id);
    room.clients.set(id, client);
    socketClients.set(ws, client);
    tokenClients.set(token, client);
    attachController(client);
    return client;
  }

  function sendJoined(client) {
    send(client.ws, {
      type: 'base:joined',
      protocol: BASE_GAME_PROTOCOL_VERSION,
      room: client.room.code,
      clientId: client.id,
      resumeToken: client.token,
      owner: client.room.ownerId === client.id,
      simHz,
      playerCap,
      // The room terrain config travels once, here (v5 bodies by hash); snapshots carry identity only.
      terrain: publicBaseGameTerrainConfig(client.room.terrain),
    });
    send(client.ws, snapshot(client.room, false));
  }

  function createRoom(ws, msg) {
    if (!validateHandshake(ws, msg)) return true;
    const code = normalizeBaseGameRoomCode(msg.room);
    if (!code) { fail(ws, 'invalid_room', 'Room codes use 2-16 letters, numbers, _ or -'); return true; }
    if (rooms.has(code)) { fail(ws, 'room_exists', 'That room already exists'); return true; }
    const terrain = acceptTerrain(msg.terrain);
    if (terrain.error) { fail(ws, terrain.code ?? 'invalid_terrain', terrain.error); return true; }
    const at = now();
    const room = {
      code,
      clients: new Map(),
      ownerId: null,
      revision: 1,
      terrain: terrain.config,
      terrainRequest: 0,
      sim: null,
      world: sanitizeBaseGameWorldPatch(msg.world),
      water: createBaseGameWaterSim({ level: 0, waves: waveOptionsFromWorld(sanitizeBaseGameWorldPatch(msg.world)), enabled: false }),
      worldUpdatedAt: at,
      emptySince: null,
      tick: 0,
      accumulatorMs: 0,
      lastStepAt: at,
      events: emptyEvents(),
      combat: createPlayerCombatFacade(),
      ammo: createAmmoStore(),
      poseHistory: new Map(),
      projectiles: null,   // bot-projectiles.js manager, built with the world in attachProjectiles
      drones: new Map(),   // id -> base-game-drones.js record; stepped after the players each tick
      vehicles: new Map(), // id -> base-game-vehicles.js record; driven seats step with their player
      npcs: null,          // server/base-game-npcs.js: the room's bot brain, built with the world
      npcSeq: 0,
    };
    room.ammo.setUnlimited(room.world.unlimitedAmmo === true);   // the creator's match rule, before anyone joins
    rooms.set(code, room);
    ensureWorld(room).catch(err => {
      // The world could not be built: tell everyone and drop the room so nobody stays on spawn forever.
      for (const c of connectedClients(room)) fail(c.ws, 'world_failed', `Room world failed to load: ${err.message}`);
      rooms.delete(code);
    });
    const client = makeClient(ws, room);
    room.ownerId = client.id;
    sendJoined(client);
    broadcast(room);
    return true;
  }

  function joinRoom(ws, msg) {
    if (!validateHandshake(ws, msg)) return true;
    const code = normalizeBaseGameRoomCode(msg.room);
    const room = code ? rooms.get(code) : null;
    if (!room) { fail(ws, 'room_missing', 'No active room has that code'); return true; }
    if (room.clients.size >= playerCap) { fail(ws, 'room_full', `Rooms hold at most ${playerCap} players`); return true; }
    const client = makeClient(ws, room);
    room.emptySince = null;
    sendJoined(client);
    broadcast(room);
    return true;
  }

  function resumeRoom(ws, msg) {
    if (!validateHandshake(ws, msg)) return true;
    const client = tokenClients.get(String(msg.resumeToken ?? ''));
    if (!client) { fail(ws, 'resume_expired', 'The previous room session has expired'); return true; }
    if (client.ws && client.ws !== ws && client.ws.readyState === 1) client.ws.close(4001, 'resumed elsewhere');
    client.ws = ws;
    client.disconnectedAt = null;
    client.room.emptySince = null;
    socketClients.set(ws, client);
    requestResync(client);
    sendJoined(client);
    broadcast(client.room);
    return true;
  }

  function updateWorld(ws, msg) {
    if (!validateHandshake(ws, msg)) return true;
    const client = socketClients.get(ws);
    if (!client) { fail(ws, 'not_joined', 'Join a base-game room first'); return true; }
    const room = client.room;
    if (room.ownerId !== client.id) { fail(ws, 'not_owner', 'Only the room owner can change shared world state'); return true; }
    advance(room);
    const patch = sanitizeBaseGameWorldPatch(msg.patch);
    if (Object.keys(patch).length === 0) return true;
    Object.assign(room.world, patch);
    syncRoomWater(room);
    syncRoomPlayerConfig(room);
    syncNpcSettings(room);
    room.ammo.setUnlimited(room.world.unlimitedAmmo === true);
    room.revision++;
    room.worldUpdatedAt = now();
    broadcast(room);
    return true;
  }

  // The owner replaces the room's ground. The new world is built (or taken from the cache) before
  // anything changes; then every player is moved to its spawn, the revision bumps, and the full
  // config goes out as `base:terrain` so each client rebuilds the same source.
  function setTerrain(ws, msg) {
    if (!validateHandshake(ws, msg)) return true;
    const client = socketClients.get(ws);
    if (!client) { fail(ws, 'not_joined', 'Join a base-game room first'); return true; }
    const room = client.room;
    if (room.ownerId !== client.id) { fail(ws, 'not_owner', 'Only the room owner can change the world'); return true; }
    if (!client.rate.allow(now())) { client.rejectedInputs++; return true; }
    const terrain = acceptTerrain(msg.terrain);
    if (terrain.error) { fail(ws, terrain.code ?? 'invalid_terrain', terrain.error); return true; }
    if (terrain.config.worldVersion === room.terrain.worldVersion) { send(ws, terrainPacket(room)); return true; }
    const requestRevision = ++room.terrainRequest;
    buildWorld(terrain.config).then(sim => {
      if (room.terrainRequest !== requestRevision || !rooms.has(room.code)) return;   // superseded or room gone
      room.terrain = terrain.config;
      room.sim = sim;
      syncRoomWater(room);
      room.revision++;
      room.projectiles = null;   // the manager holds the old ground; rebuild on the new one
      attachProjectiles(room);
      for (const c of [...room.clients.values()]) if (c.npc) removeNpc(c);   // bots belong to the ground they were placed on
      room.npcs = null;
      for (const c of room.clients.values()) {
        c.controller = null;
        c.poseEpoch++;
        room.poseHistory.delete(c.id);
        attachController(c);
        c.lastInput = neutralBaseGameInput(c.lastInput.yaw, c.lastInput.pitch);
        c.spawnRevision++;
        requestResync(c);
      }
      broadcast(room, terrainPacket(room));
      broadcast(room);
    }, err => fail(ws, 'world_failed', `World failed to load: ${err.message}`));
    return true;
  }
  function terrainPacket(room) {
    return { type: 'base:terrain', protocol: BASE_GAME_PROTOCOL_VERSION, room: room.code, revision: room.revision, terrain: publicBaseGameTerrainConfig(room.terrain) };
  }
  // A terrain config from a client: hashes resolve through the store, inline bodies are stored
  // so later joiners can fetch them by hash.
  function acceptTerrain(input) {
    const result = sanitizeBaseGameTerrainConfig(input, { resolveProject: hash => terrainStore.get(hash) });
    if (result.error) return result;
    if (result.config.projectHash) terrainStore.put(result.config.descriptor.config.project, now());
    return result;
  }
  // base:terrain_put { project } -> base:terrain_ref { projectHash }; idempotent.
  function putTerrain(ws, msg) {
    if (!validateHandshake(ws, msg)) return true;
    const client = socketClients.get(ws);
    if (client && !client.rate.allow(now())) { client.rejectedInputs++; return true; }
    const result = terrainStore.put(msg.project, now());
    if (result.error) { fail(ws, 'invalid_terrain', result.error); return true; }
    send(ws, { type: 'base:terrain_ref', protocol: BASE_GAME_PROTOCOL_VERSION, projectHash: result.projectHash });
    return true;
  }
  // base:terrain_get { projectHash } -> base:terrain_project { projectHash, project } | unknown_terrain.
  function getTerrain(ws, msg) {
    if (!validateHandshake(ws, msg)) return true;
    const client = socketClients.get(ws);
    if (client && !client.rate.allow(now())) { client.rejectedInputs++; return true; }
    const projectHash = typeof msg.projectHash === 'string' ? msg.projectHash : '';
    const project = terrainStore.get(projectHash);
    if (!project) { fail(ws, 'unknown_terrain', `terrain project ${projectHash.slice(0, 12)}… is not published here`); return true; }
    send(ws, { type: 'base:terrain_project', protocol: BASE_GAME_PROTOCOL_VERSION, projectHash, project });
    return true;
  }

  // Input is the only client-to-server movement message. Malformed, over-rate, wrong-socket, and
  // wrong-protocol packets are dropped whole; already-consumed or already-queued ticks are ignored
  // individually because clients resend unacknowledged ticks on purpose.
  function receiveInput(ws, msg) {
    const client = socketClients.get(ws);
    if (!client || client.ws !== ws) return true;
    if (msg.protocol !== BASE_GAME_PROTOCOL_VERSION) { client.rejectedInputs++; return true; }
    const packet = sanitizeBaseGameInputPacket(msg);
    if (!packet) { client.rejectedInputs++; return true; }
    if (!client.rate.allow(now())) { client.rejectedInputs++; return true; }
    if (client.awaitingResync) {
      client.awaitingResync = false;
      client.lastConsumedTick = packet.ticks[0].tick - 1;
      client.spawnRevision++;
    }
    client.lastInputClientTime = packet.clientTime;
    // Lockstep means no gaps: a tick is queued only when it is exactly the next one expected.
    let expected = (client.queue.length ? client.queue[client.queue.length - 1].tick : client.lastConsumedTick) + 1;
    for (const tick of packet.ticks) {
      if (tick.tick < expected) continue;
      if (tick.tick !== expected || !isAcceptableBaseGameTick(tick.tick, client.lastConsumedTick)) { client.rejectedInputs++; break; }
      client.queue.push(tick);
      expected++;
    }
    return true;
  }

  function resync(ws, msg) {
    const client = socketClients.get(ws);
    if (!client || client.ws !== ws) return true;
    if (msg.protocol !== BASE_GAME_PROTOCOL_VERSION) { client.rejectedInputs++; return true; }
    if (!client.rate.allow(now())) { client.rejectedInputs++; return true; }
    requestResync(client);
    return true;
  }

  // Respawn is a request, not a transform: the server resets the controller to its own spawn,
  // bumps the spawn revision, and resyncs the client's tick numbering.
  function respawnClient(client) {
    client.controller?.reset(client.npc ? client.npcSpawn : client.room.sim?.spawn);
    client.lastInput = neutralBaseGameInput(client.lastInput.yaw, client.lastInput.pitch);
    client.room.combat.revive(client.id);
    client.room.ammo.resetPlayer(client.id);
    client.trigger = createTriggerState();
    client.throwTrigger = createTriggerState();
    client.swap = createSwapState();
    client.respawnAtTick = 0;
    client.action = BASE_GAME_WEAPON_ACTION.idle;
    dropStick(client);
    client.gadgetHeld = false;
    client.gadgets = defaultGadgetStock(); client.gadgetReady = true; client.gadgetThrow = null; client.gadgetReloadAt = 0;
    if (client.pendingBodyModel) {
      client.bodyModel = client.pendingBodyModel;
      client.hitProfile = hitProfileForBodyModel(client.bodyModel);
      client.pendingBodyModel = null;
    }
    client.poseEpoch++;
    client.room.poseHistory.delete(client.id);
    updateClientHitPose(client);
    rememberPose(client);
    client.spawnRevision++;
    client.respawns = (client.respawns ?? 0) + 1;
    if (client.npc) { client.room.npcs?.revived(client); return; }
    requestResync(client);
  }

  function respawn(ws, msg) {
    const client = socketClients.get(ws);
    if (!client || client.ws !== ws) return true;
    if (msg.protocol !== BASE_GAME_PROTOCOL_VERSION) { client.rejectedInputs++; return true; }
    if (!client.rate.allow(now())) { client.rejectedInputs++; return true; }
    respawnClient(client);
    broadcast(client.room);
    return true;
  }

  // Authoritative kill plane: anyone below the world's floor limit respawns, connected or not.
  // Terrain worlds give a surface-relative limit (killPlaneYAt); the lab gives a constant.
  function enforceKillPlane(client) {
    const sim = client.room.sim;
    if (!sim || !client.controller) return false;
    const p = client.controller.getPosition();
    const limit = typeof sim.killPlaneYAt === 'function' ? sim.killPlaneYAt(p[0], p[2]) : sim.killPlaneY;
    if (!Number.isFinite(limit) || p[1] >= limit) return false;
    respawnClient(client);
    return true;
  }

  function handle(ws, msg) {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.type === 'base:respawn') return respawn(ws, msg);
    if (msg.type === 'base:loadout') return setLoadout(ws, msg);
    if (msg.type === 'base:set_body') return setBodyModel(ws, msg);
    if (msg.type === 'base:resync') return resync(ws, msg);
    if (msg.type === 'base:create') return createRoom(ws, msg);
    if (msg.type === 'base:join') return joinRoom(ws, msg);
    if (msg.type === 'base:resume') return resumeRoom(ws, msg);
    if (msg.type === 'base:set_world') return updateWorld(ws, msg);
    if (msg.type === 'base:set_terrain') return setTerrain(ws, msg);
    if (msg.type === 'base:terrain_put') return putTerrain(ws, msg);
    if (msg.type === 'base:terrain_get') return getTerrain(ws, msg);
    if (msg.type === 'base:input') return receiveInput(ws, msg);
    if (msg.type === 'base:npc') return npcCommand(ws, msg);
    if (msg.type === 'base:vehicle') return vehicleCommand(ws, msg);
    if (msg.type === 'base:drone') return droneCommand(ws, msg);
    return false;
  }

  // ─── NPC bots ──────────────────────────────────────────────────────────────
  // A bot is a client with no socket: bot-brain.js decides, the same controller, trigger, hurt
  // rig and snapshot as a player do the rest. See server/base-game-npcs.js.
  function attachNpcs(room) {
    if (room.npcs || !room.sim) return;
    room.npcs = createRoomNpcs({
      room,
      heightAt: roomGroundY(room),
      raycast: worldOccluder(room) ?? (() => null),
      seaLevel: () => (room.water?.enabled ? room.water.level : -Infinity),
      roomMs: () => roomMs(room),
      log: process.env.BASE_GAME_NPC_LOG ? (...a) => console.log('[npc]', ...a) : null,
    });
    syncNpcSettings(room);
  }
  function syncNpcSettings(room) {
    if (!room.npcs) return;
    const w = room.world;
    const patch = {};
    const aim = {};
    if (Number.isFinite(w.npcNoticeMs)) aim.reactionMs = w.npcNoticeMs;
    if (Number.isFinite(w.npcAccuracy)) Object.assign(aim, aimSettingsForAccuracy(w.npcAccuracy));
    if (Object.keys(aim).length) patch.botAimSettings = aim;
    room.npcs.configure(patch);
  }
  function makeNpcClient(room, { team, role, spawn }) {
    const id = `npc_${team === BASE_GAME_TEAMS.enemy ? 'e' : 'f'}_${++room.npcSeq}`;
    const client = {
      id, token: null, room, ws: null, npc: { team, role },
      team,
      disconnectedAt: null, controller: null, queue: [], lastConsumedTick: 0,
      lastInput: neutralBaseGameInput(), lastInputClientTime: null, awaitingResync: false, stalledTicks: 0,
      spawnRevision: 1, rate: createBaseGameRateLimiter(), rejectedInputs: 0, serverSteps: 0,
      loadout: { ...BASE_GAME_DEFAULT_LOADOUT, gadget: 'none', gadget2: 'none', launcher: 'none' },
      slot: 0, aiming: false, action: BASE_GAME_WEAPON_ACTION.idle, actionTick: 0, actionUntilTick: 0,
      respawnAtTick: 0, kills: 0, deaths: 0,
      trigger: createTriggerState(), throwTrigger: createTriggerState(), swap: createSwapState(),
      bodyModel: DEFAULT_BASE_GAME_BODY_MODEL, pendingBodyModel: null, hitProfile: hitProfileForBodyModel(DEFAULT_BASE_GAME_BODY_MODEL),
      poseEpoch: 1, hitPose: createPlayerBodyPose(), rewindPose: createPlayerBodyPose(),
      controlling: null, gadgetHeld: false, gadgets: defaultGadgetStock(), gadgetReady: false, gadgetThrow: null, gadgetReloadAt: 0,
      appearance: appearanceFor(id),
      npcSpawn: [...spawn],
    };
    const role$ = getRoleWeapon(role);
    if (role$) client.loadout.primary = role$;
    room.combat.ensurePlayer(id);
    room.clients.set(id, client);
    client.controller = createBaseGamePlayerController({
      worldQuery: room.sim.worldQuery, spawn,
      config: { fixedHz: simHz, ...playerConfigFromWorld(room.world), moveSpeed: NPC_WALK_SPEED, sprintMultiplier: NPC_RUN_MULTIPLIER },
      waterSurfaceAt: (x, z, t) => room.water.heightAt(x, z, t),
    });
    updateClientHitPose(client);
    room.npcs.attach(client, { team, roleId: role, spawn });
    return client;
  }
  function getRoleWeapon(role) { return role === 'medic' ? 'five_seven' : role === 'sniper' ? 'm24' : null; }
  // Where the requester is looking: the world query first, then the ground marched out along the
  // look (the drone send-point rule), so a bot can be placed on a far hill.
  function aimedGroundPoint(room, client) {
    if (!client?.controller) return null;
    updateClientHitPose(client);
    const origin = playerPoseAnchor(client.hitPose, 'eye');
    const dir = lookDirection(client.lastInput.yaw, client.lastInput.pitch);
    const ray = worldOccluder(room);
    const hit = ray ? ray(origin, dir, 300) : null;
    if (hit?.point) return [hit.point[0], hit.point[1], hit.point[2]];
    const ground = roomGroundY(room);
    let prev = origin;
    for (let d = 10; d <= 1500; d += 10) {
      const p = [origin[0] + dir[0] * d, origin[1] + dir[1] * d, origin[2] + dir[2] * d];
      if (p[1] <= ground(p[0], p[2])) return [p[0], ground(p[0], p[2]), p[2]];
      prev = p;
    }
    return null;
  }
  function npcSideMarker(room, team, requester) {
    const from = requester?.controller?.getPosition() ?? room.sim.spawn;
    if (team === BASE_GAME_TEAMS.friendly) return [from[0] + 3, from[1], from[2] + 3];
    const d = Number.isFinite(room.world.npcSpawnDistance) ? room.world.npcSpawnDistance : 60;
    const yaw = requester?.lastInput?.yaw ?? 0;
    // ahead of the requester along their look, on the ground
    const x = from[0] - Math.sin(yaw) * d, z = from[2] - Math.cos(yaw) * d;
    return [x, roomGroundY(room)(x, z), z];
  }
  function spawnNpcs(room, req, requester) {
    attachNpcs(room);
    if (!room.npcs) return [];
    const ground = roomGroundY(room);
    const sea = room.water?.enabled ? room.water.level : -Infinity;
    const aimed = req.aimed ? aimedGroundPoint(room, requester) : null;
    const near = aimed ?? (req.at ? [req.at[0], ground(req.at[0], req.at[2]), req.at[2]] : npcSideMarker(room, req.team, requester));
    const bodies = [...room.clients.values()].map(c => c.controller?.getPosition()).filter(Boolean);
    room.npcs.noteSpawnAnchor(near);
    const made = [];
    for (let i = 0; i < req.count; i++) {
      const spawn = findNpcSpawn({ near, spread: req.at ? 2.5 : 6, heightAt: ground, seaLevel: sea, bodies });
      spawn[1] += 0.05;
      const client = makeNpcClient(room, { team: req.team, role: req.role, spawn });
      bodies.push(spawn);
      made.push(client);
    }
    room.revision++;
    return made;
  }
  function removeNpc(client) {
    const room = client.room;
    room.npcs?.detach(client);
    room.clients.delete(client.id);
    room.combat.removePlayer(client.id);
    room.poseHistory.delete(client.id);
    room.revision++;
  }
  function npcCommand(ws, msg) {
    if (!validateHandshake(ws, msg)) return true;
    const client = socketClients.get(ws);
    if (!client) { fail(ws, 'not_joined', 'Join a base-game room first'); return true; }
    const room = client.room;
    if (room.ownerId !== client.id) { fail(ws, 'not_owner', 'Only the room owner can add or remove bots'); return true; }
    if (!client.rate.allow(now())) { client.rejectedInputs++; return true; }
    if (!room.sim) { fail(ws, 'world_not_ready', 'The world is still loading'); return true; }
    const req = sanitizeBaseGameNpcRequest(msg);
    if (!req) { fail(ws, 'invalid_npc', 'Bad NPC request'); return true; }
    advance(room);
    if (req.action === 'clear') {
      for (const c of [...room.clients.values()]) if (c.npc && (req.team === null || c.team === req.team)) removeNpc(c);
    } else {
      if (req.aimed && !aimedGroundPoint(room, client)) { fail(ws, 'no_ground', 'Nothing under the aim to stand on'); return true; }
      spawnNpcs(room, req, client);
    }
    broadcast(room);
    return true;
  }

  function vehicleCommand(ws, msg) {
    if (!validateHandshake(ws, msg)) return true;
    const client = socketClients.get(ws);
    if (!client) { fail(ws, 'not_joined', 'Join a base-game room first'); return true; }
    const room = client.room;
    if (room.ownerId !== client.id) { fail(ws, 'not_owner', 'Only the room owner can add or remove vehicles'); return true; }
    if (!client.rate.allow(now())) { client.rejectedInputs++; return true; }
    if (!room.sim) { fail(ws, 'world_not_ready', 'The world is still loading'); return true; }
    const req = sanitizeBaseGameVehicleRequest(msg);
    if (!req) { fail(ws, 'invalid_vehicle', 'Bad vehicle request'); return true; }
    advance(room);
    if (req.action === 'clear') {
      for (const [id, rec] of room.vehicles) {
        if (req.kind && rec.kind !== req.kind) continue;
        const driver = rec.driver ? room.clients.get(rec.driver) : null;
        if (driver?.controlling === id) { const exit = vehicleSeatPointSafe(rec); driver.controller?.pin(exit.position, exit.velocity); driver.controlling = null; }
        room.vehicles.delete(id);
      }
    } else {
      const point = req.aimed ? aimedGroundPoint(room, client) : req.at;
      if (!point) { fail(ws, 'no_ground', 'Nothing under the aim to place a vehicle on'); return true; }
      const groundY = roomGroundY(room);
      const rec = createBaseGameVehicle(req.kind, {
        ownerId: null, team: 0, from: [point[0], groundY(point[0], point[2]), point[2]], yaw: client.lastInput.yaw,
        groundY, id: `v${room.tick.toString(36)}-${req.kind}-${room.vehicles.size.toString(36)}`,
      });
      room.vehicles.set(rec.id, rec);
    }
    room.revision++; broadcast(room); return true;
  }

  // World drones: the owner's dev gun puts a Sentinel into orbit over the owner (never thrown, never
  // flown by hand), or clears them. Capped per room; the record is owned by the sender so the orbit
  // follows them and a dead or departed owner parks it where it is, as the UAV does.
  function droneCommand(ws, msg) {
    if (!validateHandshake(ws, msg)) return true;
    const client = socketClients.get(ws);
    if (!client) { fail(ws, 'not_joined', 'Join a base-game room first'); return true; }
    const room = client.room;
    if (room.ownerId !== client.id) { fail(ws, 'not_owner', 'Only the room owner can spawn or clear world drones'); return true; }
    if (!client.rate.allow(now())) { client.rejectedInputs++; return true; }
    if (!room.sim) { fail(ws, 'world_not_ready', 'The world is still loading'); return true; }
    const req = sanitizeBaseGameDroneRequest(msg);
    if (!req) { fail(ws, 'invalid_drone', 'Bad drone request'); return true; }
    advance(room);
    if (req.action === 'clear') {
      for (const [id, rec] of room.drones) if (rec.def.world && (!req.kind || rec.kind === req.kind)) room.drones.delete(id);
    } else {
      let aloft = 0;
      for (const rec of room.drones.values()) if (rec.def.world && !rec.done) aloft++;
      if (aloft >= BASE_GAME_WORLD_DRONE_CAP) { fail(ws, 'drone_cap', `At most ${BASE_GAME_WORLD_DRONE_CAP} world drones per room`); return true; }
      const at = client.controller?.getPosition();
      if (!at) { fail(ws, 'no_body', 'No body to spawn over'); return true; }
      const rec = spawnWorldDrone(req.kind, {
        ownerId: client.id, team: 0, at, look: lookDirection(client.lastInput.yaw, 0), alt: req.alt, radius: req.radius,
        groundAt: roomGroundY(room), id: `w${room.tick.toString(36)}-${req.kind}-${room.drones.size.toString(36)}`,
      });
      room.drones.set(rec.id, rec);
    }
    room.revision++; broadcast(room); return true;
  }

  function vehicleSeatPointSafe(rec) {
    const sy = Math.sin(rec.body.yaw), cy = Math.cos(rec.body.yaw), o = rec.def.exitOffset;
    return { position: [rec.body.x + o[0] * cy + o[2] * sy, rec.y + o[1], rec.body.z - o[0] * sy + o[2] * cy], velocity: [rec.body.vx, rec.airV, rec.body.vz] };
  }
  // One sim tick for a bot: the brain's intent becomes this tick's input, then the ordinary path.
  function stepNpcClient(client) {
    const room = client.room;
    const alive = room.combat.getSnapshot(client.id).alive;
    if (!alive) {
      client.controller.stepOnce(neutralBaseGameInput(client.lastInput.yaw, client.lastInput.pitch), false);
      rememberPose(client);
      if (room.tick >= client.respawnAtTick) {
        if (room.world.npcRespawn === false) removeNpc(client);
        else respawnClient(client);
      }
      return;
    }
    const next = room.npcs.tickInputFor(client, client.lastConsumedTick + 1);
    client.queue.push(next);
    consumeTick(client);
  }

  function consumeTick(client) {
    const next = client.queue.shift();
    client.lastConsumedTick = next.tick;
    client.lastInput = next;
    const controlledVehicle = client.controlling ? client.room.vehicles.get(client.controlling) : null;
    if (controlledVehicle?.driver === client.id) {
      const ownerPos = client.controller.getPosition();
      const seat = stepVehicleSeat(controlledVehicle, next, stepMs / 1000, vehicleWorld(client.room, controlledVehicle, client, ownerPos));
      if (seat) client.controller.pin(seat.position, seat.velocity, next.tick);
    } else {
      // A remote aircraft operator stands still; its movement keys belong to the stick.
      const flying = !!client.controlling;
      client.controller.stepOnce({ tick: next.tick, moveX: flying ? 0 : next.moveX, moveZ: flying ? 0 : next.moveZ, yaw: next.yaw, sprint: flying ? false : next.sprint, crouch: next.crouch, stance: stanceName(next.stance) }, flying ? false : next.jump);
    }
    // Slot and aim are taken as sent. The trigger step (base-game-fire.js, on combat.js's
    // validateShot and player-ammo.js) decides whether a round leaves; hits resolve below.
    // A swap puts one weapon away and brings the next up, and neither can shoot on the way. It is
    // refused outright mid-reload: both hands are already busy.
    if (next.slot !== client.slot) {
      const from = weaponForSlot(client.loadout, client.slot);
      const to = weaponForSlot(client.loadout, next.slot);
      if (beginSwap(client.swap, { tick: next.tick, from, to, reloading: client.trigger.reloadUntilTick > next.tick, simHz })) {
        client.slot = next.slot;
        client.trigger.held = true;   // the slot change eats the press edge
        client.action = BASE_GAME_WEAPON_ACTION.holster;
        client.actionTick = next.tick;
        client.actionUntilTick = client.swap.drawAtTick;
      }
    }
    const phase = swapPhase(client.swap, next.tick);
    if (phase === 'draw' && client.action !== BASE_GAME_WEAPON_ACTION.draw) {
      client.action = BASE_GAME_WEAPON_ACTION.draw;
      client.actionTick = next.tick;
      client.actionUntilTick = client.swap.untilTick;
    }
    client.aiming = next.aim;
    if (client.action !== BASE_GAME_WEAPON_ACTION.idle && next.tick >= client.actionUntilTick) client.action = BASE_GAME_WEAPON_ACTION.idle;
    const room = client.room;
    const weaponId = weaponForSlot(client.loadout, client.slot);
    // A gadget in hand is not a gun: fire launches the drone, and the trigger steps with no weapon.
    const gadget = isBaseGameGadget(weaponId);
    if (gadget) launchGadget(client, weaponId, next, phase);
    stepGadgetTimers(client, next);
    applyDroneInput(client, next);
    const shot = stepTrigger(client.trigger, room.ammo, { playerId: client.id, weaponId: gadget ? null : weaponId, tick: next.tick, fire: gadget ? false : next.fire, reload: next.reload, aim: next.aim, alive: room.combat.getSnapshot(client.id).alive, blocked: phase !== 'idle', simHz });
    if (shot.reloadStarted) {
      client.action = BASE_GAME_WEAPON_ACTION.reload;
      client.actionTick = next.tick;
      client.actionUntilTick = next.tick + BASE_GAME_RELOAD_TICKS;
    }
    if (shot.fired) {
      client.action = BASE_GAME_WEAPON_ACTION.fire;
      client.actionTick = next.tick;
      client.actionUntilTick = next.tick + BASE_GAME_FIRE_ACTION_TICKS;   // outlives a snapshot interval so remotes see every shot
      fireShot(client, weaponId, next);
    }
    // Quick-throw: the throwable slot leaves the hand without ever becoming the held weapon, so it
    // runs its own trigger and never disturbs the held weapon's action unless nothing else is playing.
    const throwable = weaponForSlot(client.loadout, BASE_GAME_WEAPON_SLOTS.indexOf('throwable'));
    const lob = stepThrow(client.throwTrigger, room.ammo, { playerId: client.id, weaponId: throwable, tick: next.tick, fire: next.throw, aim: false, alive: room.combat.getSnapshot(client.id).alive, simHz });
    if (lob.fired) {
      if (client.action === BASE_GAME_WEAPON_ACTION.idle) {
        client.action = BASE_GAME_WEAPON_ACTION.throw;
        client.actionTick = next.tick;
        client.actionUntilTick = next.tick + BASE_GAME_FIRE_ACTION_TICKS;
      }
      fireShot(client, throwable, next, client.throwTrigger);
    }
    rememberPose(client);
  }

  // ─── drones ────────────────────────────────────────────────────────────────
  // Ground under a drone: the terrain source when there is one, the lab's spawn floor otherwise.
  function roomGroundY(room) {
    const sim = room.sim;
    if (typeof sim?.heightAt === 'function') return sim.heightAt;
    const floor = (sim?.spawn?.[1] ?? 1.5) - 1.5;
    return () => floor;
  }
  function ownedDrone(room, ownerId, kind) {
    for (const rec of room.drones.values()) if (rec.ownerId === ownerId && rec.kind === kind && !rec.done) return rec;
    for (const rec of room.vehicles.values()) if (rec.ownerId === ownerId && rec.kind === kind && !rec.done) return rec;
    return null;
  }
  // Fire edge on the gadget slot, once the draw has finished and with one in the hands: the throw
  // starts (the arm action), and the drone leaves THROW_TICKS later from spawnGadget. R with empty
  // hands and stock left brings the next one out over RELOAD_TICKS. One of each kind aloft per player.
  function launchGadget(client, kind, next, phase) {
    const edge = next.fire && !client.gadgetHeld;
    client.gadgetHeld = next.fire;
    const room = client.room;
    const alive = room.combat.getSnapshot(client.id).alive;
    if (next.reload && alive && phase === 'idle' && !client.gadgetReady && !client.gadgetThrow && !client.gadgetReloadAt && (client.gadgets[kind] ?? 0) > 0 && client.action === BASE_GAME_WEAPON_ACTION.idle) {
      client.action = BASE_GAME_WEAPON_ACTION.reload;
      client.actionTick = next.tick;
      client.actionUntilTick = next.tick + BASE_GAME_GADGET_RELOAD_TICKS;
      client.gadgetReloadAt = client.actionUntilTick;
    }
    if (!edge || phase !== 'idle') return;
    if (!alive || !client.gadgetReady || client.gadgetThrow || client.gadgetReloadAt || (client.gadgets[kind] ?? 0) <= 0 || ownedDrone(room, client.id, kind)) return;
    client.gadgets[kind] -= 1;
    client.gadgetReady = false;
    client.gadgetThrow = { kind, atTick: next.tick + BASE_GAME_GADGET_THROW_TICKS };
    client.action = BASE_GAME_WEAPON_ACTION.throw;
    client.actionTick = next.tick;
    client.actionUntilTick = next.tick + BASE_GAME_GADGET_THROW_ACTION_TICKS;
  }
  function stepGadgetTimers(client, next) {
    if (client.gadgetThrow && next.tick >= client.gadgetThrow.atTick) { const t = client.gadgetThrow; client.gadgetThrow = null; spawnGadget(client, t.kind, next); }
    if (client.gadgetReloadAt && next.tick >= client.gadgetReloadAt) { client.gadgetReloadAt = 0; client.gadgetReady = true; }
  }
  function spawnGadget(client, kind, next) {
    const room = client.room;
    if (!room.combat.getSnapshot(client.id).alive || ownedDrone(room, client.id, kind)) return;
    const groundY = roomGroundY(room);
    if (kind === VEHICLE_UGV) {
      const p = client.controller.getPosition();
      const rec = createBaseGameVehicle(kind, {
        ownerId: client.id, team: 0, from: p, yaw: next.yaw, groundY,
        id: `v${room.tick.toString(36)}-${client.id.slice(0, 6)}-${kind}`,
      });
      room.vehicles.set(rec.id, rec);
      return;
    }
    updateClientHitPose(client);
    const eye = playerPoseAnchor(client.hitPose, 'eye');
    const look = lookDirection(next.yaw, next.pitch);
    const rec = createBaseGameDrone(kind, {
      ownerId: client.id, team: 0,
      from: [eye[0], eye[1] + 0.5, eye[2]], look, throwSpeed: 8,
      groundY: groundY(eye[0], eye[2]),
      id: `d${room.tick.toString(36)}-${client.id.slice(0, 6)}-${kind}`,
    });
    room.drones.set(rec.id, rec);
  }
  function dropStick(client) {
    if (!client.controlling) return;
    const drone = client.room.drones.get(client.controlling);
    const vehicle = client.room.vehicles.get(client.controlling);
    if (drone) releaseDrone(drone);
    if (vehicle) {
      const exit = vehicleSeatPointSafe(vehicle);
      releaseVehicle(vehicle);
      if (vehicle.def.seat === 'onboard') client.controller?.pin(exit.position, exit.velocity);
    }
    client.controlling = null;
  }
  // Orders and the stick. Only the owner's input reaches a drone; mode 0 while flying releases it.
  function applyDroneInput(client, next) {
    const di = next.drone;
    const room = client.room;
    const drone = di?.id ? room.drones.get(di.id) : null;
    const vehicle = di?.id ? room.vehicles.get(di.id) : null;
    const rec = drone ?? vehicle;
    const owns = rec?.ownerId === client.id;
    const canSeat = vehicle?.kind === VEHICLE_BUGGY && !vehicle.done && (!vehicle.driver || vehicle.driver === client.id)
      && Math.hypot(vehicle.body.x - client.controller.getPosition()[0], vehicle.body.z - client.controller.getPosition()[2]) <= 3;
    if (!di || !rec || rec.done || (!owns && !canSeat)) { if (client.controlling) dropStick(client); return; }
    if (di.send) { if (drone) sendDroneTo(rec, di.send); else sendVehicleTo(rec, di.send); if (client.controlling === rec.id) client.controlling = null; return; }
    if (di.recall) { if (drone) recallDrone(rec); else recallVehicle(rec); if (client.controlling === rec.id) client.controlling = null; return; }
    if (di.mode !== 1) { if (client.controlling === rec.id) dropStick(client); return; }
    if (rec.mode !== 'manual') {
      if (client.controlling && client.controlling !== rec.id) dropStick(client);
      const taken = drone ? takeOverDrone(rec, { groundY: roomGroundY(room) }) : takeOverVehicle(rec, client.id);
      if (taken) client.controlling = rec.id;
    }
    if (drone && rec.mode === 'manual') { rec.input.pitch = di.pitch; rec.input.roll = di.roll; rec.input.yaw = di.yaw; rec.input.throttle = di.throttle; rec.input.sweep = di.sweep; rec.input.flap = di.flap; }
    if (drone) applyDroneAim(room, rec, di);
    // A ground station has no rounds in the air to steer: the aim is stored and the turret trains
    // toward it inside the vehicle's own fixed step, so the slew is deterministic like the drive.
    else if (rec.def.turret) {
      if (di.aim) rec.aim = di.aim;
      rec.firing = di.mode === 1 && di.fire === true;
    }
  }

  // The sensor and the trigger. The aim is stored on the record and copied into every missile this
  // drone already has in the air, which is what makes it steerable after launch rather than a
  // fire-and-forget shot at wherever the crosshair happened to be.
  function applyDroneAim(room, rec, di) {
    if (di.aim) rec.aim = di.aim;
    if (rec.aim) {
      for (const proj of room.projectiles?.list ?? []) {
        if (proj.guide && proj.guide.droneId === rec.id) { proj.guide.aim[0] = rec.aim[0]; proj.guide.aim[1] = rec.aim[1]; proj.guide.aim[2] = rec.aim[2]; }
      }
    }
    if (!di.fire || !rec.aim) return;
    const shot = fireAgm(rec, rec.aim, roomMs(room) / 1000);
    if (shot) room.projectiles?.spawn({ ...shot, color: [1, 0.72, 0.4], throwerActorId: rec.ownerId });
  }
  const _droneWorld = { ownerPos: null, ownerYaw: 0, ownerAlive: false, groundY: null, input: null };
  function stepDrones(room) {
    if (!room.drones.size) return;
    const dt = stepMs / 1000;
    const groundY = roomGroundY(room);
    for (const rec of room.drones.values()) {
      const owner = room.clients.get(rec.ownerId);
      const alive = !!owner?.controller && room.combat.getSnapshot(owner.id).alive;
      _droneWorld.ownerPos = alive ? owner.controller.getPosition() : null;
      _droneWorld.ownerYaw = alive ? owner.lastInput.yaw : 0;
      _droneWorld.ownerAlive = alive;
      _droneWorld.groundY = groundY;
      _droneWorld.input = rec.input;
      stepBaseGameDrone(rec, dt, _droneWorld);
      // The module can drop the stick on its own (a crash, a dead owner); the roster follows it.
      if (owner && owner.controlling === rec.id && rec.mode !== 'manual') owner.controlling = null;
      if (rec.done) {
        // Into the ground, or shot to pieces: it goes off where it ends, on whoever is standing there.
        if (rec.crash && rec.def.crashBlast) detonateBlast(room, rec.crash, { ...rec.def.crashBlast, ownerId: rec.ownerId, weaponId: `${rec.kind}_crash`, contact: true });
        room.drones.delete(rec.id);
      }
    }
  }

  const _vehicleWorld = { ownerPos: null, ownerYaw: 0, ownerAlive: false, groundY: null, seaLevel: -Infinity };
  function vehicleWorld(room, rec, owner = null, ownerPos = null) {
    owner ??= room.clients.get(rec.ownerId);
    const alive = !!owner?.controller && room.combat.getSnapshot(owner.id).alive;
    _vehicleWorld.ownerPos = ownerPos ?? (alive ? owner.controller.getPosition() : null);
    _vehicleWorld.ownerYaw = alive ? owner.lastInput.yaw : 0;
    _vehicleWorld.ownerVel = alive ? owner.controller.getVelocity() : null;
    _vehicleWorld.ownerAlive = alive;
    _vehicleWorld.groundY = roomGroundY(room);
    _vehicleWorld.seaLevel = room.water?.enabled ? room.water.level : -Infinity;
    return _vehicleWorld;
  }
  function stepVehicles(room) {
    if (!room.vehicles.size) return;
    const dt = stepMs / 1000;
    for (const rec of room.vehicles.values()) {
      if (!rec.driver) stepBaseGameVehicle(rec, dt, vehicleWorld(room, rec));
      // The station only fires while its owner is connected and at the stick: a stale trigger on a
      // vanished operator would leave a UGV shooting at whatever it was last pointed at.
      const gunner = rec.firing ? room.clients.get(rec.ownerId) : null;
      if (rec.firing && (!gunner || gunner.controlling !== rec.id)) rec.firing = false;
      const shot = fireVehicleTurret(rec);
      if (shot) {
        const weapon = getWeapon(shot.weaponId);
        if (weapon) resolveHitscanShot(room, gunner, shot.weaponId, weapon, shot.origin, shot.dir, rec.id);
      }
      const driver = rec.driver ? room.clients.get(rec.driver) : null;
      if (driver && (rec.mode !== 'manual' || rec.driver !== driver.id)) driver.controlling = null;
      if (rec.done) {
        if (rec.crash && rec.def.crashBlast) detonateBlast(room, rec.crash, { ...rec.def.crashBlast, ownerId: rec.ownerId, weaponId: `${rec.kind}_crash`, contact: true });
        if (driver?.controlling === rec.id) driver.controlling = null;
        room.vehicles.delete(rec.id);
      }
    }
  }

  // Fixed-capacity articulated hit-pose history, keyed on room time for deterministic rewind.
  // The weapon actually in the hands right now: the outgoing one until the holster finishes.
  function heldWeapon(client) {
    if (swapPhase(client.swap, client.lastConsumedTick) === 'holster' && client.swap.from) return client.swap.from;
    return weaponForSlot(client.loadout, client.slot);
  }

  function roomMs(room) { return room.tick * stepMs; }
  function rememberPose(client) {
    const room = client.room;
    const pose = updateClientHitPose(client);
    if (!pose) return;
    let history = room.poseHistory.get(client.id);
    if (!history) {
      history = createPlayerHitRigHistory(BASE_GAME_POSITION_HISTORY);
      room.poseHistory.set(client.id, history);
    }
    pushPlayerHitRigPose(history, pose, roomMs(room));
  }

  // How fast the shooter is moving, 0..1 of full sprint, for bot-aim.js's move spread.
  function moveSpeed01(client) {
    const v = client.controller.getVelocity();
    const cfg = BASE_GAME_PLAYER_DEFAULT_CONFIG;
    return Math.min(1, Math.hypot(v[0], v[2]) / (cfg.moveSpeed * cfg.sprintMultiplier));
  }

  function fireShot(client, weaponId, input, trigger = client.trigger) {
    const weapon = weaponId ? getWeapon(weaponId) : null;
    const mode = weapon?.mode || 'hitscan';
    if (!weapon) return;
    // Hitscan and melee both resolve a ray; melee just uses the weapon's short range (env-viewer's
    // rule). Only the client's presentation differs — a knife draws no tracer.
    const room = client.room;
    updateClientHitPose(client);
    const origin = playerPoseAnchor(client.hitPose, mode === 'melee' ? 'eye' : 'muzzle');
    const dir = shotDirectionFor(trigger, { yaw: input.yaw, pitch: input.pitch, weaponId, tick: input.tick, seed: botSeedFromId(client.id), moveSpeed01: moveSpeed01(client), simHz });
    if (mode === 'projectile') {
      // environment-viewer's spawnCombatProjectile field forwarding; damage lands on detonation.
      const pr = weapon.projectile || {};
      room.projectiles?.spawn({
        origin, dir, speed: pr.speed, blastRadius: pr.blastRadius, life: pr.life, radius: pr.radius,
        gravity: pr.gravity, arc: pr.arc, fuse: pr.fuse, bounces: pr.bounces === true, fizzleOnExpire: pr.fizzleOnExpire === true,
        damage: weapon.damage, color: weapon.tracerColor, ownerId: client.id, weaponId, throwerActorId: client.id,
      });
      return;
    }
    // Victims as the shooter saw them: rewound by the client interpolation delay.
    resolveHitscanShot(room, client, weaponId, weapon, origin, dir, client.controlling);
  }

  // One hitscan round from an arbitrary origin. Extracted from fireShot so the UGV's weapon station
  // resolves through exactly the same lag compensation a hand weapon does: victims rewound by the
  // client interpolation delay, drones as mobs, one shot event for everyone to draw.
  function resolveHitscanShot(room, shooter, weaponId, weapon, origin, dir, excludeMobId = null) {
    const at = roomMs(room) - BASE_GAME_LAG_COMP_MS;
    const players = [];
    for (const other of room.clients.values()) {
      if (other === shooter || !other.controller) continue;
      updateClientHitPose(other);
      const history = room.poseHistory.get(other.id);
      const past = history ? samplePlayerHitRigPose(history, at, other.rewindPose) : null;
      const rig = past || other.hitPose;
      players.push({ id: other.id, rig, alive: rig.alive });
    }
    // Drones ride in as mobs, which is the capsule list resolveHitscan already has. A drone with a
    // body radius and nothing reading it was scenery you could shoot straight through.
    const mobs = droneHitVolumes(room.drones, excludeMobId);
    const shooterId = shooter?.id ?? null;
    const hit = resolveHitscan({ shooterId, origin, dir, range: weapon.range ?? 300, players, mobs, occluder: worldOccluder(room) });
    room.events.shots.push({ shooter: shooterId, weapon: weaponId, origin, dir, end: hit.point, normal: hit.normal ?? null, kind: hit.kind, tick: room.tick });
    if (hit.kind === 'mob') { hitDrone(room, hit.id, weapon.damage, hit.point, weaponId, shooterId); return hit; }
    if (hit.kind !== 'player') return hit;
    const victim = room.clients.get(hit.id);
    if (victim) applyDamage(room, victim, weapon.damage, {
      shooter,
      point: hit.point,
      normal: hit.normal ?? null,
      weaponId,
      zone: hit.zone ?? null,
      side: hit.side ?? 'center',
    });
    return hit;
  }

  function setLoadout(ws, msg) {
    const client = socketClients.get(ws);
    if (!client || client.ws !== ws) return true;
    if (msg.protocol !== BASE_GAME_PROTOCOL_VERSION) { client.rejectedInputs++; return true; }
    if (!client.rate.allow(now())) { client.rejectedInputs++; return true; }
    client.loadout = sanitizeBaseGameLoadout(msg.loadout);
    client.action = BASE_GAME_WEAPON_ACTION.idle;
    client.room.ammo.resetPlayer(client.id);
    broadcast(client.room);
    return true;
  }

  function setBodyModel(ws, msg) {
    const client = socketClients.get(ws);
    if (!client || client.ws !== ws) return true;
    if (msg.protocol !== BASE_GAME_PROTOCOL_VERSION) { client.rejectedInputs++; return true; }
    if (!client.rate.allow(now())) { client.rejectedInputs++; return true; }
    if (!bodyModelById(msg.bodyModel)) { client.rejectedInputs++; return true; }
    const bodyModel = sanitizeBaseGameBodyModel(msg.bodyModel);
    if (bodyModel === client.bodyModel) return true;
    const nextProfile = hitProfileForBodyModel(bodyModel);
    if (nextProfile !== client.hitProfile && client.room.combat.getSnapshot(client.id).alive) {
      client.pendingBodyModel = bodyModel;
      return true;
    }
    client.bodyModel = bodyModel;
    client.hitProfile = nextProfile;
    client.poseEpoch++;
    client.room.poseHistory.delete(client.id);
    updateClientHitPose(client);
    rememberPose(client);
    broadcast(client.room);
    return true;
  }

  // Each simulation step consumes exactly one queued tick per player. A deep queue drains two per
  // step; an empty queue freezes the player briefly, then the server runs neutral steps and asks
  // the client to resync. Disconnected players always run neutral steps.
  function stepClient(client) {
    const controller = client.controller;
    if (!controller) return;
    if (client.npc) return stepNpcClient(client);
    const connected = client.ws?.readyState === 1;
    if (!client.room.combat.getSnapshot(client.id).alive) {
      // A dead body holds still; its ticks are consumed so numbering stays in step, then the
      // respawn resyncs it like any server-initiated move.
      if (client.queue.length) { const next = client.queue.shift(); client.lastConsumedTick = next.tick; client.lastInput = next; }
      controller.stepOnce(neutralBaseGameInput(client.lastInput.yaw, client.lastInput.pitch), false);
      rememberPose(client);
      if (client.room.tick >= client.respawnAtTick) respawnClient(client);
      return;
    }
    if (!connected) {
      controller.stepOnce(neutralBaseGameInput(client.lastInput.yaw, client.lastInput.pitch), false);
      client.serverSteps++;
      rememberPose(client);
      if (!client.awaitingResync) requestResync(client);
      return;
    }
    if (client.queue.length === 0) {
      client.stalledTicks++;
      if (client.stalledTicks > stallTicks) {
        controller.stepOnce(neutralBaseGameInput(client.lastInput.yaw, client.lastInput.pitch), false);
        client.serverSteps++;
        rememberPose(client);
        if (!client.awaitingResync) requestResync(client);
      }
      return;
    }
    client.stalledTicks = 0;
    consumeTick(client);
    if (client.queue.length > drainDepth) consumeTick(client);
  }

  // Service profiler: one log line per second whenever a wake-up ran long, with the phase split,
  // so a laggy session says where the server's time went instead of leaving us to guess.
  const prof = { lastWake: 0, maxGap: 0, maxWake: 0, sumWake: 0, wakes: 0, ticks: 0, prepare: 0, think: 0, clients: 0, projectiles: 0, drones: 0, vehicles: 0, bcast: 0, bytes: 0, since: 0 };
  const PROF_WAKE_WARN_MS = 12;
  function profReport(at) {
    if (at - prof.since < 1000) return;
    const npcs = [...rooms.values()].reduce((n, r) => n + (r.npcs?.count?.() ?? 0), 0);
    if (prof.maxWake >= PROF_WAKE_WARN_MS || prof.maxGap >= 50 || (npcs && process.env.BASE_GAME_PROF)) {
      const f = v => v.toFixed(1);
      const s = [...rooms.values()].find(r => r.npcs)?.npcs?.stats;
      console.log(`[base-game prof] wake max ${f(prof.maxWake)} ms avg ${f(prof.sumWake / Math.max(1, prof.wakes))} ms gap max ${f(prof.maxGap)} ms | ticks ${prof.ticks} prepare ${f(prof.prepare)} think ${f(prof.think)} clients ${f(prof.clients)} proj ${f(prof.projectiles)} drones ${f(prof.drones)} vehicles ${f(prof.vehicles)} | snapshots ${f(prof.bcast)} ms ${(prof.bytes / 1024).toFixed(0)} KB | npcs ${npcs}`
        + formatBaseGameNpcProfStats(s, f));
      for (const r of rooms.values()) r.npcs?.resetStats?.();
    }
    for (const k of Object.keys(prof)) if (k !== 'lastWake') prof[k] = 0;
    prof.since = at;
  }

  function stepRoom(room, at) {
    const elapsed = Math.max(0, at - room.lastStepAt);
    room.lastStepAt = at;
    // Late service ticks are bounded: at most a quarter second of catch-up per wake-up.
    room.accumulatorMs = Math.min(room.accumulatorMs + elapsed, stepMs * simHz / 4);
    const sim = room.sim;
    while (room.accumulatorMs + 1e-6 >= stepMs) {
      room.accumulatorMs -= stepMs;
      room.tick++; prof.ticks++;
      let t = performance.now();
      // Volumetric worlds build collision around the players first; a player whose chunk is not
      // collidable yet holds this tick (input stays queued) rather than moving on no ground.
      if (sim.prepare) sim.prepare([...room.clients.values()].filter(c => c.controller).map(c => c.controller.getPosition()));
      let t2 = performance.now(); prof.prepare += t2 - t; t = t2;
      room.npcs?.think(stepMs / 1000);   // every bot decides before any body moves this tick
      t2 = performance.now(); prof.think += t2 - t; t = t2;
      for (const client of [...room.clients.values()]) {
        if (sim.covers && client.controller) { const p = client.controller.getPosition(); if (!sim.covers(p[0], p[2])) continue; }
        stepClient(client); enforceKillPlane(client);
      }
      t2 = performance.now(); prof.clients += t2 - t; t = t2;
      if (room.projectiles?.list.length) { stepGuidedProjectiles(room.projectiles.list, stepMs / 1000); room.projectiles.update(stepMs / 1000); }
      t2 = performance.now(); prof.projectiles += t2 - t; t = t2;
      stepDrones(room);
      t2 = performance.now(); prof.drones += t2 - t; t = t2;
      stepVehicles(room);
      prof.vehicles += performance.now() - t;
    }
  }

  function step(at = now()) {
    const t0 = performance.now();
    if (prof.lastWake) prof.maxGap = Math.max(prof.maxGap, t0 - prof.lastWake);
    prof.lastWake = t0;
    for (const room of rooms.values()) if (room.sim) stepRoom(room, at);
    const wake = performance.now() - t0;
    prof.maxWake = Math.max(prof.maxWake, wake); prof.sumWake += wake; prof.wakes++;
    profReport(t0);
  }

  function transferOwner(room) {
    const next = connectedClients(room)[0] ?? [...room.clients.values()][0] ?? null;
    room.ownerId = next?.id ?? null;
    if (next) room.revision++;
  }

  function disconnect(ws) {
    const client = socketClients.get(ws);
    if (!client) return false;
    socketClients.delete(ws);
    if (client.ws !== ws) return true;
    dropStick(client);
    client.ws = null;
    client.disconnectedAt = now();
    requestResync(client);
    if (connectedClients(client.room).length === 0) client.room.emptySince = now();
    broadcast(client.room);
    return true;
  }

  function cleanup() {
    const at = now();
    for (const [code, room] of rooms) {
      let changed = false;
      for (const [id, client] of room.clients) {
        if (client.ws || client.disconnectedAt == null || at - client.disconnectedAt < graceMs) continue;
        room.clients.delete(id);
        tokenClients.delete(client.token);
        room.combat.removePlayer(id);
        room.ammo.removePlayer(id);
        room.poseHistory.delete(id);
        if (room.ownerId === id) transferOwner(room);
        changed = true;
      }
      if (room.clients.size === 0 && room.emptySince != null && at - room.emptySince >= graceMs) rooms.delete(code);
      else if (changed) broadcast(room);
    }
  }

  function broadcastSnapshots() {
    const t0 = performance.now();
    for (const room of rooms.values()) {
      const clients = connectedClients(room);
      if (!clients.length) continue;
      const payload = JSON.stringify(snapshot(room));
      prof.bytes += payload.length * clients.length;
      for (const client of clients) if (client.ws.readyState === 1) client.ws.send(payload);
    }
    prof.bcast += performance.now() - t0;
  }

  return {
    handle, disconnect, cleanup, step, broadcastSnapshots, rooms,
    // Resolves when every room's world is resident (tests); no rooms -> resolved.
    ensureWorld() { return Promise.all([...rooms.values()].map(room => ensureWorld(room))); },
    get worldReady() { return [...rooms.values()].every(room => !!room.sim); },
    get worldCount() { return worlds.size; },
    get terrainStore() { return terrainStore; },
    // Pre-build the default lab world (server startup).
    warmTraversalLab() {
      if (world) return Promise.resolve(world);
      const config = sanitizeBaseGameTerrainConfig(undefined).config;
      let entry = worlds.get(config.worldVersion);
      if (!entry) {
        entry = { world: null, pending: null };
        entry.pending = Promise.resolve(worldFactory(config)).then(result => { entry.world = result; return result; });
        worlds.set(config.worldVersion, entry);
      }
      return entry.pending;
    },
  };
}
