// Runs in Node.js. Verifies entity-types/explosion.js falloff math + lifecycle.
import { ExplosionEntity, blastFalloff, blastDamageAt } from './entity-types/explosion.js';

let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.error(`FAIL: ${msg}`); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// --- falloff curve: center=1.0, edge->0.45, outside=0 ---
check(near(blastFalloff(0, 10), 1.0), `center falloff should be 1.0 — got ${blastFalloff(0, 10)}`);
check(near(blastFalloff(5, 10), 0.725), `half-radius falloff should be 0.725 — got ${blastFalloff(5, 10)}`);
check(blastFalloff(9.99, 10) > 0.45 && blastFalloff(9.99, 10) < 0.46, 'near-edge falloff just above 0.45');
check(blastFalloff(10, 10) === 0, 'at-edge falloff is 0 (exclusive)');
check(blastFalloff(11, 10) === 0, 'outside radius falloff is 0');
check(blastFalloff(1, 0) === 0, 'zero radius yields 0');

// --- scaled damage: center full, floor enforced ---
check(blastDamageAt(100, 0, 10) === 100, `center damage full — got ${blastDamageAt(100, 0, 10)}`);
check(blastDamageAt(100, 5, 10) === 73, `half-radius 100 base -> 73 — got ${blastDamageAt(100, 5, 10)}`);
check(blastDamageAt(100, 11, 10) === 0, 'outside radius -> 0 damage');
// Low base damage at the edge is floored (default floor 12).
check(blastDamageAt(10, 9, 10) === 12, `tiny base at edge floored to 12 — got ${blastDamageAt(10, 9, 10)}`);
// Custom floor honored.
check(blastDamageAt(10, 9, 10, 3) === 5, `custom floor: round(10*0.505)=5 — got ${blastDamageAt(10, 9, 10, 3)}`);

// --- create() applies blast ONCE via ctx.applyBlast ---
{
  const calls = [];
  const e = ExplosionEntity.create(
    { p: [1, 2, 3], radius: 8, damage: 120, ownerId: 'host', color: [1, 0, 0] },
    { applyBlast: (args) => calls.push(args) }
  );
  check(calls.length === 1, `applyBlast called exactly once — got ${calls.length}`);
  check(calls[0].radius === 8 && calls[0].damage === 120, 'applyBlast receives radius+damage');
  check(calls[0].center[0] === 1 && calls[0].center[2] === 3, 'applyBlast receives center');
  check(calls[0].ownerId === 'host', 'applyBlast receives ownerId (for friendly-fire/self-damage logic)');
  check(e.state.radius === 8 && e.state.damage === 120, 'entity stores radius+damage');
}

// --- create() without applyBlast is safe (no throw) ---
{
  let ok = true;
  try { ExplosionEntity.create({ p: [0, 0, 0], radius: 5, damage: 50 }, {}); } catch { ok = false; }
  check(ok, 'create() without ctx.applyBlast does not throw');
}

// --- update() ages and destroys at life ---
{
  const e = ExplosionEntity.create({ p: [0, 0, 0], radius: 5, damage: 10, life: 0.5 }, {});
  check(ExplosionEntity.update(e, 0.2) === null, 'alive before life elapses');
  check(ExplosionEntity.update(e, 0.2) === null, 'still alive at 0.4s');
  const r = ExplosionEntity.update(e, 0.2);
  check(r && r.destroy, 'destroyed once age >= life');
}

// --- serialize() renders:true + fading intensity ---
{
  const e = ExplosionEntity.create({ p: [4, 5, 6], radius: 7, damage: 10, life: 1.0, color: [0.2, 0.4, 0.6] }, {});
  const w0 = ExplosionEntity.serialize(e);
  check(w0.type === 'explosion' && w0.renders === true, 'serialize marks renders:true');
  check(w0.radius === 7 && w0.p[0] === 4, 'serialize carries radius + position');
  check(near(w0.intensity, 1), `fresh intensity ~1 — got ${w0.intensity}`);
  ExplosionEntity.update(e, 0.5);
  check(ExplosionEntity.serialize(e).intensity < w0.intensity, 'intensity fades with age');
}

if (failures > 0) { console.error(`${failures} test(s) failed.`); process.exit(1); }
else { console.log('explosion.js tests passed.'); process.exit(0); }
