// claudecraft-bridge/claudecraft-creatures.js
// Top-level factory for the ClaudeCraft mob system inside the workshop. Owns the
// Sim instance, the fixed 20 Hz step loop, the three injected seams (terrain
// height, water level, collider), the external-player mirror, and the combat
// readback. Mirrors the shape of port-creature-bridge.js. Host/solo only — the
// guest path never constructs this (it renders replicated mob snapshots).
//
// Verified against the vendored sim source (claudecraft-sim/sim.ts):
//   - sim.players / sim.entities are public Maps keyed by entity id.
//   - addPlayer(cls, name, opts?) returns the new pid (player.id); pid ===
//     entityId, so players.get(pid).entityId === pid.
//   - removePlayer(pid) exists.
//   - setPlayerPose(pid,x,y,z,facing) and reviveExternalPlayer(pid,x,y,z) exist.
import {
  Sim, MOBS, createMob, setActiveWorldContent, setHeightProvider, setWaterLevelProvider,
  setExternalColliderResolver,
} from '../claudecraft-sim.bundle.js';
import { makeScale } from './sim-scale.js';
import { buildClaudecraftWorldContent } from './sim-world-content.js';
import { serializeMobs } from './sim-mob-snapshot.js';

const SIM_DT = 1 / 20; // the sim is a fixed 20 Hz step; never call tick faster.
// Spiral-of-death guards: never accumulate more than a quarter second of real
// time in one frame, and never run more than 5 catch-up ticks per frame.
const MAX_FRAME_DT = 0.25;
const MAX_STEPS_PER_FRAME = 5;

export function createClaudecraftCreatures({
  workshopPlayerHeight,   // world units, from the live player-size setting
  terrainHeight,          // (x,z) -> world height, covers procedural AND authored
  waterLevelWorld,        // world height of water
  trunkResolve,           // (x,z,r) -> {x,z} in world units (collision.js trunkIndex.resolve)
  camps,                  // [{ mobId, count, centerWorld, radiusWorld }]
  playerStartWorld,       // {x,z}
  seed = 1,
  localPlayerId = 'host', // workshop id of the local player (mirrored into localPid)
}) {
  const scale = makeScale(workshopPlayerHeight);

  // Wire the three seams (all in SIM units at the sim boundary).
  setHeightProvider((sx, sz) => scale.toSim(terrainHeight(scale.toWorld(sx), scale.toWorld(sz))));
  setWaterLevelProvider(() => scale.toSim(waterLevelWorld));
  setExternalColliderResolver((sx, sz, sr) => {
    const w = trunkResolve(scale.toWorld(sx), scale.toWorld(sz), scale.toWorld(sr));
    return { x: scale.toSim(w.x), z: scale.toSim(w.z) };
  });

  setActiveWorldContent(buildClaudecraftWorldContent({
    scale, waterLevelWorld, playerStartWorld, camps,
  }));

  const sim = new Sim({ seed, playerClass: 'warrior' });

  // The primary auto-added player becomes the local workshop player, mirrored in.
  const localPid = [...sim.players.keys()][0];
  sim.players.get(localPid).external = true;
  const remotePids = new Map(); // workshop playerId -> sim pid

  let acc = 0;
  const mobs = []; // latest wire snapshot, refreshed each sim tick

  // --- runtime manual-mob control (spawn panel) --------------------------------
  // Ids the panel spawned at runtime (separate from the seeded camp mobs, so
  // "clear all spawned" never nukes the camps). Behavior is a bridge-owned concept
  // re-asserted each tick, because the sim's locomotion has a self-healing safety
  // net that force-re-hostiles any owner-less mob every tick (mob/locomotion.ts
  // ~line 135) and its idle detection scan ignores the `hostile` flag entirely, so
  // `hostile=false` alone neither sticks nor stops aggro.
  const spawnedIds = new Set();          // runtime-spawned mob ids
  const behaviorById = new Map();        // mob id -> 'hostile' | 'passive' | 'hold'
  const VALID_BEHAVIORS = new Set(['hostile', 'passive', 'hold']);
  const AGGRO_STATES = new Set(['chase', 'attack', 'flee', 'evade']);

  function refreshMobs() {
    mobs.length = 0;
    for (const m of serializeMobs(sim.entities, scale)) mobs.push(m);
  }

  // Set a mob's steady-state fields for its behavior. Called on assignment and
  // (for passive/hold) re-asserted every tick by enforceSpawnedBehaviors.
  function applyBehaviorFields(e, behavior) {
    if (behavior === 'hostile') {
      e.hostile = true;
      if (e.aiState === 'hold') e.aiState = 'idle'; // release the pin
    } else if (behavior === 'passive') {
      // Wanders around spawn but never chases: each tick the enforcement below
      // snaps it back to idle before it can take a chase step (the idle detection
      // re-aggros harmlessly but idle takes no movement step that same tick).
      e.hostile = false;
      if (AGGRO_STATES.has(e.aiState)) {
        e.aiState = 'idle';
        e.aggroTargetId = null;
        e.inCombat = false;
        e.threat.clear();
      }
    } else if (behavior === 'hold') {
      // 'hold' is a non-matching aiState: updateMob's switch has no case for it, so
      // the mob runs no wander, no detection, no movement — fully inert AND ignores
      // players (strictly stronger than moveSpeed=0, which still lets it melee).
      e.hostile = false;
      e.aiState = 'hold';
      e.aggroTargetId = null;
      e.inCombat = false;
      e.threat.clear();
    }
  }

  // Re-assert passive/hold invariants right before each sim tick. Prunes ids whose
  // entity has vanished (removed/despawned).
  function enforceSpawnedBehaviors() {
    if (behaviorById.size === 0) return;
    for (const [id, behavior] of behaviorById) {
      const e = sim.entities.get(id);
      if (!e) { behaviorById.delete(id); continue; }
      if (behavior === 'passive' || behavior === 'hold') applyBehaviorFields(e, behavior);
    }
  }

  refreshMobs(); // seed mobs() with the camp roster before the first frame/tick

  function addRemotePlayer(workshopId) {
    const pid = sim.addPlayer('warrior', String(workshopId), { external: true });
    remotePids.set(workshopId, pid);
    return pid;
  }
  function removeRemotePlayer(workshopId) {
    const pid = remotePids.get(workshopId);
    if (pid != null) { sim.removePlayer(pid); remotePids.delete(workshopId); }
  }

  // Called once per workshop frame with the real dt and the live player poses.
  function update(dt, { localPlayerWorld, remotePlayersWorld = [] } = {}) {
    // Mirror poses in SIM units before stepping.
    const mirror = (pid, w) => sim.setPlayerPose(
      pid, scale.toSim(w.x), scale.toSim(w.y), scale.toSim(w.z), w.facing ?? 0,
    );
    // Clamp incoming dt and cap catch-up steps so a backgrounded/stalled tab
    // (dt of seconds) can't synchronously replay hundreds of ticks in one frame
    // (spiral-of-death). Excess accumulated time is dropped, not replayed.
    acc += Math.min(dt, MAX_FRAME_DT);
    let steps = 0;
    let stepped = false;
    while (acc >= SIM_DT && steps < MAX_STEPS_PER_FRAME) {
      if (localPlayerWorld) mirror(localPid, localPlayerWorld);
      for (const rp of remotePlayersWorld) {
        let pid = remotePids.get(rp.id);
        if (pid == null) pid = addRemotePlayer(rp.id);
        mirror(pid, rp);
      }
      enforceSpawnedBehaviors(); // re-assert passive/hold before the sim drives AI
      sim.tick();
      acc -= SIM_DT;
      steps++;
      stepped = true;
    }
    // If we hit the step cap there is leftover time we will never catch up on;
    // drop it so acc doesn't grow unbounded and pin us at the cap forever.
    if (steps >= MAX_STEPS_PER_FRAME) acc = 0;
    if (stepped) refreshMobs();
    return mobs;
  }

  // --- runtime manual-mob API (spawn panel) ------------------------------------
  // The MOBS keys, annotated with display name + family so the UI can group the
  // 112 templates by family. `id` is what spawnMob/visualKeyForMob consume.
  function listSpawnableMobs() {
    return Object.keys(MOBS).map((id) => ({
      id, name: MOBS[id].name ?? id, family: MOBS[id].family ?? 'other',
    }));
  }

  // Spawn one mob at a world point, sitting on the injected terrain. Returns the
  // new sim id, or null for an unknown mobId.
  function spawnMob({ mobId, world, level = 1, scale: mobScale, behavior = 'hostile' } = {}) {
    const template = MOBS[mobId];
    if (!template || !world) return null;
    const beh = VALID_BEHAVIORS.has(behavior) ? behavior : 'hostile';
    const wx = world.x, wz = world.z;
    const pos = {
      x: scale.toSim(wx),
      y: scale.toSim(terrainHeight(wx, wz)), // sit on the ground at spawn
      z: scale.toSim(wz),
    };
    const id = sim.nextId++;
    const mob = createMob(id, template, level, pos); // seeds spawnPos=pos, leashAnchor=null
    if (Number.isFinite(mobScale) && mobScale > 0) mob.scale = mobScale;
    sim.entities.set(id, mob);
    spawnedIds.add(id);
    behaviorById.set(id, beh);
    applyBehaviorFields(mob, beh);
    refreshMobs(); // so mobs() reflects the new mob before the next tick
    return id;
  }

  function setMobBehavior(id, behavior) {
    if (!VALID_BEHAVIORS.has(behavior)) return false;
    const e = sim.entities.get(id);
    if (!e) return false;
    behaviorById.set(id, behavior);
    applyBehaviorFields(e, behavior);
    return true;
  }

  function setMobScale(id, s) {
    const e = sim.entities.get(id);
    if (!e || !Number.isFinite(s) || s <= 0) return false;
    e.scale = s;
    refreshMobs();
    return true;
  }

  // Remove a mob. The sim's own target/threat handling prunes any dangling
  // reference: highestThreatTarget/updateMobTarget drop ids whose entity is
  // missing, and a mob whose aggroTargetId now resolves to undefined retargets or
  // evades on its next tick — so no manual cross-reference nulling is needed.
  function removeMob(id) {
    const existed = sim.entities.delete(id);
    spawnedIds.delete(id);
    behaviorById.delete(id);
    if (existed) refreshMobs();
    return existed;
  }

  // Remove every runtime-spawned mob (leaves the seeded camp mobs untouched).
  function clearSpawnedMobs() {
    let n = 0;
    for (const id of spawnedIds) {
      if (sim.entities.delete(id)) n++;
      behaviorById.delete(id);
    }
    spawnedIds.clear();
    if (n > 0) refreshMobs();
    return n;
  }

  function spawnedMobIds() { return [...spawnedIds]; }

  // Combat readback for the local player.
  function localPlayerCombat() {
    const meta = sim.players.get(localPid);
    const e = sim.entities.get(meta.entityId);
    return { hp: e.maxHp > 0 ? e.hp / e.maxHp : 0, dead: !!e.dead };
  }
  function reviveLocalPlayer(worldPos) {
    sim.reviveExternalPlayer(
      localPid, scale.toSim(worldPos.x), scale.toSim(worldPos.y), scale.toSim(worldPos.z),
    );
  }

  // --- player-combat facade adapter -------------------------------------------
  // player-combat.js delegates the workshop's single source of player HP truth to
  // this adapter when a ClaudeCraft bridge is active, so BOTH mob damage (resolved
  // inside sim.tick against the mirrored player entity) and gun PvP damage land on
  // one HP pool. Workshop player ids map to sim pids: the local id -> localPid, any
  // other id -> a remote external sim player (created on first sight).
  function pidFor(id, createIfMissing) {
    if (id === localPlayerId) return localPid;
    let pid = remotePids.get(id);
    if (pid == null && createIfMissing) pid = addRemotePlayer(id);
    return pid;
  }
  function playerEntity(id, createIfMissing = false) {
    const pid = pidFor(id, createIfMissing);
    if (pid == null) return null;
    const meta = sim.players.get(pid);
    if (!meta) return null;
    return sim.entities.get(meta.entityId) ?? null;
  }
  // Facade hooks (see player-combat.js createPlayerCombatFacade delegated branch).
  function ensurePlayer(id) { pidFor(id, true); }
  function getPlayerCombat(id) {
    const e = playerEntity(id);
    if (!e) return null;
    return { hp: e.hp, maxHp: e.maxHp, alive: !e.dead };
  }
  function damagePlayer(id, { amount } = {}) {
    const e = playerEntity(id, true);
    if (!e) return;
    const dmg = Number.isFinite(amount) ? amount : 0;
    e.hp = Math.max(0, e.hp - dmg);
    if (e.hp <= 0) e.dead = true;
  }
  function revivePlayer(id, worldPose) {
    const pid = pidFor(id, true);
    if (pid == null) return;
    const w = worldPose ?? { x: 0, y: 0, z: 0 };
    sim.reviveExternalPlayer(pid, scale.toSim(w.x), scale.toSim(w.y), scale.toSim(w.z));
  }
  function removeExternalPlayer(id) { removeRemotePlayer(id); }

  return {
    update, mobs: () => mobs, scale,
    localPlayerCombat, reviveLocalPlayer,
    // runtime manual-mob control (spawn panel):
    listSpawnableMobs, spawnMob, setMobBehavior, setMobScale, removeMob,
    clearSpawnedMobs, spawnedMobIds,
    addRemotePlayer, removeRemotePlayer,
    // player-combat.js facade adapter surface:
    ensurePlayer, getPlayerCombat, damagePlayer, revivePlayer, removeExternalPlayer,
    _sim: sim, // escape hatch for debugging only
  };
}
