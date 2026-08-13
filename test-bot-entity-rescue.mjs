// test-bot-entity-rescue.mjs — Node smoke tests for stepBotPhysics's below-terrain floor rescue.
// A capsule that tunnels a thin terrain sheet lands on the map's catch slab and reads `grounded`
// forever, hundreds of metres under the real ground; the opt-in `rescueHeightAt` option lifts it
// back. Runs with a stub collider — no GPU, no BVH, no browser.
import { registerHooks } from 'node:module';

// The repo's local `three` install ships empty examples/jsm stubs (the browser loads addons from a
// CDN importmap), so bot-entity.js's Capsule import is redirected to a minimal equivalent here.
const CAPSULE_STUB = 'data:text/javascript,' + encodeURIComponent(`export class Capsule {
  constructor(start, end, radius) { this.start = start; this.end = end; this.radius = radius; }
  translate(v) { this.start.add(v); this.end.add(v); return this; }
}`);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'three/addons/math/Capsule.js') return { url: CAPSULE_STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { createBotEntity, stepBotPhysics, FLOOR_RESCUE_DEPTH, FLOOR_RESCUE_WARN_COOLDOWN_S } = await import('./bot-entity.js');

let fail = 0, pass = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// Rescue warnings are the feature working, not test noise: count them instead of printing.
let warnCount = 0;
const realWarn = console.warn;
console.warn = () => { warnCount++; };

const REF_Y = 4;                       // flat reference ground for every case below
const flatGround = () => REF_Y;
const collider = (grounded) => ({ resolveCapsule: () => ({ grounded }) });
// Drops the capsule to `feetY` (its own convention: start.y = feet + radius) without touching height.
function placeFeet(bot, feetY) {
  const h = bot.capsule.end.y - bot.capsule.start.y;
  bot.capsule.start.y = feetY + bot.capsule.radius;
  bot.capsule.end.y = bot.capsule.start.y + h;
}
function freshBot(id, feetY) {
  const bot = createBotEntity(id, { x: 2, y: REF_Y, z: -3 });
  placeFeet(bot, feetY);
  bot.onFloor = true;                  // suppress the gravity term so each case's geometry is exact
  bot.velocity.set(0, 0, 0);
  return bot;
}

// ---- 0: the constant sits between legitimate deviation and a catch-slab rest ----
ok(FLOOR_RESCUE_DEPTH === 0.75, '0: FLOOR_RESCUE_DEPTH is 0.75 m');
ok(FLOOR_RESCUE_DEPTH > 0.35 && FLOOR_RESCUE_DEPTH < 1.0,
  '0: threshold clears worst-case legitimate deviation (~0.35 m) and stays under the >=1 m slab deficit');
ok(createBotEntity('shape', { x: 0, y: 0, z: 0 }).floorRescues === 0, '0: new entities start with floorRescues 0');

// ---- 1: a capsule ~1 m under the ground, still reading grounded, is lifted back ----
{
  const bot = freshBot('bot-1', REF_Y - 1.0);
  const height = bot.capsule.end.y - bot.capsule.start.y;
  bot.velocity.y = -3;                 // a fall still in progress when the slab caught it
  warnCount = 0;
  stepBotPhysics(bot, 1 / 60, { mapCollider: collider(true), rescueHeightAt: flatGround });
  ok(near(bot.capsule.start.y, REF_Y + bot.capsule.radius), '1: capsule rests at refY + radius after the rescue');
  ok(near(bot.capsule.end.y - bot.capsule.start.y, height), '1: capsule height is unchanged by the lift');
  ok(bot.velocity.y === 0, '1: downward velocity is zeroed');
  ok(bot.onFloor === true, '1: onFloor is forced true');
  ok(bot.floorRescues === 1, '1: floorRescues incremented');
  ok(warnCount === 1, '1: one console.warn per rescue');
}

// ---- 2: a legitimate slope-band deviation (~0.3 m under) is left alone ----
{
  const bot = freshBot('bot-2', REF_Y - 0.3);
  const before = bot.capsule.start.y;
  stepBotPhysics(bot, 1 / 60, { mapCollider: collider(true), rescueHeightAt: flatGround });
  ok(near(bot.capsule.start.y, before), '2: capsule 0.3 m under the field is not moved');
  ok(bot.floorRescues === 0, '2: no rescue counted inside the legitimate band');
}
// Just under the threshold stays put; just over it fires — the boundary is where it is claimed to be.
{
  const under = freshBot('bot-2b', REF_Y - (FLOOR_RESCUE_DEPTH - 0.01));
  const beforeY = under.capsule.start.y;
  stepBotPhysics(under, 0, { mapCollider: collider(true), rescueHeightAt: flatGround });
  ok(near(under.capsule.start.y, beforeY), '2: 0.74 m under is below the trigger');
  const over = freshBot('bot-2c', REF_Y - (FLOOR_RESCUE_DEPTH + 0.01));
  stepBotPhysics(over, 0, { mapCollider: collider(true), rescueHeightAt: flatGround });
  ok(over.floorRescues === 1, '2: 0.76 m under trips the trigger');
}

// ---- 3: callers that do not opt in see zero behaviour change ----
{
  const bot = freshBot('bot-3', REF_Y - 400);   // as deep as a real catch-slab rest gets
  const before = bot.capsule.start.y;
  warnCount = 0;
  stepBotPhysics(bot, 1 / 60, { mapCollider: collider(true) });
  ok(near(bot.capsule.start.y, before), '3: no rescueHeightAt means no lift, however deep the capsule is');
  ok(bot.floorRescues === 0, '3: no rescue counted');
  ok(warnCount === 0, '3: silent for callers that did not opt in');
}

// ---- 4: the pre-existing heightAt fallback (no mapCollider) is untouched ----
{
  const bot = freshBot('bot-4', REF_Y - 2);
  bot.velocity.y = -5;
  stepBotPhysics(bot, 1 / 60, { heightAt: flatGround });
  ok(near(bot.capsule.start.y, REF_Y + bot.capsule.radius), '4: heightAt fallback still snaps to the ground');
  ok(bot.velocity.y === 0 && bot.onFloor === true, '4: fallback still zeroes velocity and grounds the bot');
  ok(bot.floorRescues === 0, '4: the fallback path is not counted as a rescue');

  // Same inputs plus rescueHeightAt: the rescue lives in the mapCollider branch, so nothing differs.
  const twin = freshBot('bot-4b', REF_Y - 2);
  twin.velocity.y = -5;
  stepBotPhysics(twin, 1 / 60, { heightAt: flatGround, rescueHeightAt: flatGround });
  ok(near(twin.capsule.start.y, bot.capsule.start.y) && twin.floorRescues === 0,
    '4: passing rescueHeightAt with no mapCollider changes nothing');

  // Above the ground with no collider: the fallback must still report airborne.
  const air = freshBot('bot-4c', REF_Y + 5);
  air.onFloor = false;
  stepBotPhysics(air, 1 / 60, { heightAt: flatGround, rescueHeightAt: flatGround });
  ok(air.onFloor === false && air.velocity.y < 0, '4: an airborne bot with no collider still falls');
}

// ---- 5: the check is ungated on onFloor, so a capsule that tunnelled the slab too is caught ----
{
  const bot = freshBot('bot-5', REF_Y - 60);
  bot.onFloor = false;
  bot.velocity.y = -40;
  stepBotPhysics(bot, 1 / 60, { mapCollider: collider(false), rescueHeightAt: flatGround });
  ok(near(bot.capsule.start.y, REF_Y + bot.capsule.radius), '5: an ungrounded free-faller is rescued too');
  ok(bot.onFloor === true && bot.velocity.y === 0, '5: free-faller is regrounded and stopped');
  ok(bot.floorRescues === 1, '5: rescue counted for the ungrounded case');
}

// ---- 6: repeated rescues accumulate, and a settled bot stops triggering ----
{
  const bot = freshBot('bot-6', REF_Y - 3);
  stepBotPhysics(bot, 0, { mapCollider: collider(true), rescueHeightAt: flatGround });
  stepBotPhysics(bot, 0, { mapCollider: collider(true), rescueHeightAt: flatGround });
  ok(bot.floorRescues === 1, '6: a bot already lifted onto the ground does not re-trigger');
  placeFeet(bot, REF_Y - 3);
  stepBotPhysics(bot, 0, { mapCollider: collider(true), rescueHeightAt: flatGround });
  ok(bot.floorRescues === 2, '6: a second tunnel-through counts a second rescue');
}

// ---- 7: a non-finite reference height never moves the capsule ----
{
  const bot = freshBot('bot-7', REF_Y - 50);
  const before = bot.capsule.start.y;
  stepBotPhysics(bot, 0, { mapCollider: collider(true), rescueHeightAt: () => NaN });
  ok(near(bot.capsule.start.y, before) && bot.floorRescues === 0, '7: NaN reference height is a no-op');
}

// ---- 8: the console.warn is throttled per bot, but the lift itself never is ----
{
  const bot = freshBot('bot-8', REF_Y - 3);
  warnCount = 0;
  stepBotPhysics(bot, 0, { mapCollider: collider(true), rescueHeightAt: flatGround });
  ok(warnCount === 1 && bot.floorRescues === 1, '8: first rescue always warns');

  // Re-tunnel immediately (well inside the cooldown window): still corrected, still counted, silent.
  placeFeet(bot, REF_Y - 3);
  stepBotPhysics(bot, 0.1, { mapCollider: collider(true), rescueHeightAt: flatGround });
  ok(near(bot.capsule.start.y, REF_Y + bot.capsule.radius), '8: throttled rescue still corrects the capsule');
  ok(bot.floorRescues === 2, '8: throttled rescue still counts');
  ok(warnCount === 1, '8: second rescue inside the cooldown window does not warn again');

  // Advance past the cooldown, then re-tunnel: warns again.
  placeFeet(bot, REF_Y - 3);
  stepBotPhysics(bot, FLOOR_RESCUE_WARN_COOLDOWN_S, { mapCollider: collider(true), rescueHeightAt: flatGround });
  ok(warnCount === 2, '8: a rescue after the cooldown elapses warns again');
  ok(bot.floorRescues === 3, '8: third rescue counted');

  // A bot that's never been rescued starts with a cooldown of 0, not stuck warming up.
  const fresh = createBotEntity('bot-8b', { x: 0, y: 0, z: 0 });
  ok(fresh.floorRescueWarnAt === 0, '8: a fresh entity has no warm-up delay on its first rescue');
}

console.warn = realWarn;
console.log(`bot-entity floor rescue: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
