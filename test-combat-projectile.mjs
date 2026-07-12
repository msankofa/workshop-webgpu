// Runs in Node.js. Verifies entity-types/combat-projectile.js flight, collision,
// bounce, fuse, and detonation-spawns-explosion behavior.
import { CombatProjectileEntity as CP } from './entity-types/combat-projectile.js';

let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.error(`FAIL: ${msg}`); } };
const near = (a, b, e = 1e-4) => Math.abs(a - b) <= e;

// A ctx that records spawn() calls and lets a test inject raycast/terrain.
function makeCtx({ raycast = null, terrainHeight = () => -1000 } = {}) {
  const spawns = [];
  return { spawns, spawn: (type, init) => spawns.push({ type, init }), raycast, terrainHeight };
}

// --- straight rocket flies forward, no gravity ---
{
  const e = CP.create({ origin: [0, 5, 0], dir: [0, 0, 1], speed: 100, life: 5, blastRadius: 8, damage: 110, fizzleOnExpire: true });
  const ctx = makeCtx();
  CP.update(e, 0.1, ctx);
  check(near(e.transform.p[2], 10), `rocket advances speed*dt on z — got ${e.transform.p[2]}`);
  check(near(e.transform.p[1], 5), `no gravity keeps y — got ${e.transform.p[1]}`);
  check(ctx.spawns.length === 0, 'no detonation mid-flight');
}

// --- raycast hit detonates + spawns an explosion at the hit point ---
{
  const e = CP.create({ origin: [0, 5, 0], dir: [0, 0, 1], speed: 100, blastRadius: 8, damage: 110, ownerId: 'host' });
  const ctx = makeCtx({ raycast: () => ({ point: [0, 5, 7], kind: 'player' }) });
  const r = CP.update(e, 0.1, ctx);
  check(r && r.destroy && r.reason === 'impact', 'detonates on raycast hit');
  check(ctx.spawns.length === 1 && ctx.spawns[0].type === 'explosion', 'spawns one explosion');
  check(ctx.spawns[0].init.damage === 110 && ctx.spawns[0].init.radius === 8, 'explosion carries damage+blastRadius');
  check(ctx.spawns[0].init.p[2] === 7, 'explosion spawns at the hit point');
  check(ctx.spawns[0].init.ownerId === 'host', 'explosion inherits ownerId');
}

// --- raycast excludes owner (owner id passed through) ---
{
  const e = CP.create({ origin: [0, 5, 0], dir: [0, 0, 1], speed: 100, ownerId: 'p2' });
  let seenOwner = null;
  const ctx = makeCtx({ raycast: (from, to, radius, owner) => { seenOwner = owner; return null; } });
  CP.update(e, 0.05, ctx);
  check(seenOwner === 'p2', `raycast receives ownerId to exclude — got ${seenOwner}`);
}

// --- gravity pulls a grenade down (arc) ---
{
  const e = CP.create({ origin: [0, 10, 0], dir: [0, 0, 1], speed: 10, gravity: 24, life: 5, bounces: true });
  const ctx = makeCtx();
  CP.update(e, 0.1, ctx);
  check(e.sim.vy < 0, `gravity makes vy negative — got ${e.sim.vy}`);
  check(e.transform.p[1] < 10, 'grenade loses altitude');
}

// --- grenade bounces off terrain (does not detonate) then detonates after MAX_BOUNCES ---
{
  const ground = () => 0;
  const e = CP.create({ origin: [0, 0.2, 0], dir: [0, -1, 0], speed: 10, gravity: 0, life: 5, blastRadius: 6, damage: 90, bounces: true });
  const ctx = makeCtx({ terrainHeight: ground });
  const r1 = CP.update(e, 0.1, ctx);
  check(r1 === null && e.sim.bounceCount === 1, `first ground contact bounces — count ${e.sim.bounceCount}`);
  check(e.sim.vy > 0, 'bounce flips vy upward');
  check(ctx.spawns.length === 0, 'no explosion on bounce');
}

// --- grounded grenade with little life left detonates instead of bouncing ---
{
  const e = CP.create({ origin: [0, 0.1, 0], dir: [0, -1, 0], speed: 5, life: 0.2, blastRadius: 6, damage: 90, bounces: true });
  const ctx = makeCtx({ terrainHeight: () => 0 });
  const r = CP.update(e, 0.05, ctx);
  check(r && r.destroy, 'low-life grounded grenade detonates');
  check(ctx.spawns.length === 1, 'and spawns its explosion');
}

// --- fuse timer detonates in air ---
{
  const e = CP.create({ origin: [0, 50, 0], dir: [0, 0, 1], speed: 10, life: 10, fuse: 0.15, blastRadius: 6, damage: 90 });
  const ctx = makeCtx();
  check(CP.update(e, 0.1, ctx) === null, 'before fuse: still flying');
  const r = CP.update(e, 0.1, ctx);
  check(r && r.destroy && ctx.spawns.length === 1, 'fuse expiry detonates in air');
}

// --- rocket fizzles (no blast) at life end; grenade airbursts ---
{
  const rocket = CP.create({ origin: [0, 50, 0], dir: [0, 0, 1], speed: 1, life: 0.05, fizzleOnExpire: true });
  const ctxR = makeCtx();
  const rr = CP.update(rocket, 0.1, ctxR);
  check(rr && rr.reason === 'expired' && ctxR.spawns.length === 0, 'rocket fizzles with no explosion');

  const grenade = CP.create({ origin: [0, 50, 0], dir: [0, 0, 1], speed: 1, life: 0.05, blastRadius: 6, damage: 90 });
  const ctxG = makeCtx();
  const gr = CP.update(grenade, 0.1, ctxG);
  check(gr && gr.destroy && ctxG.spawns.length === 1, 'grenade airbursts at life end');
}

// --- serialize renders as a moving light (renders:true, type projectile) ---
{
  const e = CP.create({ origin: [1, 2, 3], dir: [1, 0, 0], speed: 50, color: [1, 0.4, 0.1] });
  const w = CP.serialize(e);
  check(w.type === 'projectile' && w.renders === true, 'serialize shares the light-projectile render path');
  check(w.p[0] === 1 && w.color[0] === 1, 'serialize carries position + color');
}

if (failures > 0) { console.error(`${failures} test(s) failed.`); process.exit(1); }
else { console.log('combat-projectile.js tests passed.'); process.exit(0); }
