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
  Sim, setActiveWorldContent, setHeightProvider, setWaterLevelProvider,
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
      sim.tick();
      acc -= SIM_DT;
      steps++;
      stepped = true;
    }
    // If we hit the step cap there is leftover time we will never catch up on;
    // drop it so acc doesn't grow unbounded and pin us at the cap forever.
    if (steps >= MAX_STEPS_PER_FRAME) acc = 0;
    if (stepped) {
      mobs.length = 0;
      for (const m of serializeMobs(sim.entities, scale)) mobs.push(m);
    }
    return mobs;
  }

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

  return {
    update, mobs: () => mobs, scale,
    localPlayerCombat, reviveLocalPlayer,
    addRemotePlayer, removeRemotePlayer,
    _sim: sim, // escape hatch for debugging only
  };
}
