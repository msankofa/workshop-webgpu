// test-claudecraft-seams.mjs
import {
  Sim,
  setHeightProvider,
  setWaterLevelProvider,
  setExternalColliderResolver,
} from './claudecraft-sim.bundle.js';

// TODO wave2: replace stub with `import { makeScale } from './claudecraft-bridge/sim-scale.js'`.
// The claudecraft-bridge/ modules are owned by a different agent and do not exist in this
// worktree yet. SCALE derives from the workshop player height / 2.6 (sim humanoid yards).
function makeScale(workshopPlayerHeight) {
  const SCALE = workshopPlayerHeight / 2.6;
  return { SCALE, toWorld: (v) => v * SCALE, toSim: (v) => v / SCALE };
}

// ---------------------------------------------------------------------------
// Height seam (Task 1.3)
// ---------------------------------------------------------------------------
{
  const s = makeScale(2.6); // SCALE = 1 for a clean assertion
  // A flat workshop terrain at world-height 5 everywhere.
  setHeightProvider((sx, sz) => s.toSim(5));
  setWaterLevelProvider(() => s.toSim(-2));

  const sim = new Sim({ seed: 1, playerClass: 'warrior' });
  for (let i = 0; i < 10; i++) sim.tick();
  let checked = 0;
  for (const e of sim.entities.values()) {
    if (e.kind !== 'mob') continue;
    console.assert(Math.abs(e.pos.y - 5) < 0.5, `mob y should track injected terrain (~5), got ${e.pos.y}`);
    checked++;
  }
  console.assert(checked > 0, 'had mobs to check');
  console.log('height seam OK, mobs on injected terrain:', checked);
}

// ---------------------------------------------------------------------------
// Collider seam (Task 3.1 Step 5)
// ---------------------------------------------------------------------------
{
  let resolverCalls = 0;
  // A resolver that pins everything to a fixed point proves it is consulted.
  setExternalColliderResolver((x, z, r) => {
    resolverCalls++;
    return { x: 1, z: 1 };
  });
  const sim2 = new Sim({ seed: 2, playerClass: 'warrior' });
  for (let i = 0; i < 40; i++) sim2.tick(); // let wandering mobs move -> resolveMovePoint
  console.assert(resolverCalls > 0, 'external collider resolver was consulted during movement');
  setExternalColliderResolver(null); // reset for other tests
  console.log('collider seam OK, calls:', resolverCalls);
}

// ---------------------------------------------------------------------------
// Combat mirror + external player (Task 4.1 Step 6)
//
// The plan's version seeds a one-mob camp via buildClaudecraftWorldContent
// (a claudecraft-bridge/ module not present in this worktree). We instead run
// the built-in world and pin the mirrored external player onto a real mob each
// tick — this genuinely exercises setPlayerPose (external mirror), the
// external-flag movement bypass, and mob aggro against the mirrored player.
// ---------------------------------------------------------------------------
{
  setHeightProvider((x, z) => 0);
  const sim3 = new Sim({ seed: 3, playerClass: 'warrior' });
  // Mark the primary auto-player external so the sim stops integrating its movement.
  const pid = [...sim3.players.keys()][0];
  sim3.players.get(pid).external = true;
  const pEnt = sim3.entities.get(sim3.players.get(pid).entityId);

  // Lock onto the mob nearest the player and follow it, standing the player on it.
  let target = null;
  let best = Infinity;
  for (const e of sim3.entities.values()) {
    if (e.kind !== 'mob' || e.dead) continue;
    const d = Math.hypot(e.pos.x - pEnt.pos.x, e.pos.z - pEnt.pos.z);
    if (d < best) {
      best = d;
      target = e;
    }
  }
  console.assert(target, 'built-in world had a mob to target');

  let sawAggro = false;
  for (let i = 0; i < 200; i++) {
    if (target && !target.dead) sim3.setPlayerPose(pid, target.pos.x, 0, target.pos.z, 0);
    sim3.tick();
    for (const e of sim3.entities.values()) {
      if (e.kind === 'mob' && (e.aiState === 'chase' || e.aiState === 'attack')) sawAggro = true;
    }
  }
  console.assert(sawAggro, 'mob should aggro the mirrored player');

  // Revive path: kill the external player entity, then revive it.
  pEnt.hp = 0;
  pEnt.dead = true;
  sim3.reviveExternalPlayer(pid, 7, 0, 9);
  console.assert(!pEnt.dead && pEnt.hp === pEnt.maxHp, 'reviveExternalPlayer restores hp + clears dead');
  console.assert(pEnt.pos.x === 7 && pEnt.pos.z === 9, 'reviveExternalPlayer moves entity to respawn point');
  console.log('combat mirror OK');
}
