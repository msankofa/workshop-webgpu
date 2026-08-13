// Node tests for bot-health-packs.js (pure pack inventory + charge math).
// Run: node test-bot-health-packs.mjs
import {
  MAX_HELD_PACKS, PACK_FULL_HEAL_HP, REVIVE_KIT_PACK_COST,
  makePack, packHp, packsTotalHp, hasHealResource, canHold, addPack, drawFromPacks,
  hasReviveMaterials, consumeRevivePacks,
  packClaimIntent, packRunSafe, PACK_RUN_SAFETY,
} from './bot-health-packs.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// makePack clamps to [0,1]
ok(makePack().charge01 === 1, 'default pack is full');
ok(makePack(1.5).charge01 === 1, 'over-full charge clamps to 1');
ok(makePack(-0.2).charge01 === 0, 'negative charge clamps to 0');

// hp conversion
ok(packHp(makePack(1)) === PACK_FULL_HEAL_HP, 'full pack is worth PACK_FULL_HEAL_HP');
ok(approx(packHp(makePack(0.4)), 40), 'a 40% pack is worth 40 HP');
ok(packsTotalHp([makePack(0.5), makePack(0.25)]) === 75, 'total HP sums across packs');
ok(packsTotalHp([]) === 0, 'empty inventory has no HP');

// resource / capacity predicates
ok(hasHealResource([makePack(0.01)]) === true, 'any charge counts as a heal resource');
ok(hasHealResource([]) === false, 'no packs = no heal resource');
ok(hasHealResource([makePack(0)]) === false, 'a zero-charge pack is not a resource');
ok(canHold([]) && canHold([makePack()]), 'room below the cap');
ok(!canHold([makePack(), makePack()]), `no room at the cap of ${MAX_HELD_PACKS}`);

// addPack respects the cap
{
  const inv = [];
  ok(addPack(inv, makePack()) === true && inv.length === 1, 'first pack is accepted');
  ok(addPack(inv, makePack(0.5)) === true && inv.length === 2, 'second pack is accepted');
  ok(addPack(inv, makePack()) === false && inv.length === 2, 'third pack is rejected at the cap');
}

// partial heal leaves a partially-charged pack in place (droppable)
{
  const inv = [makePack(1)];
  const applied = drawFromPacks(inv, 12); // heal only 12 HP
  ok(applied === 12, 'draws exactly the wanted HP when charge is plentiful');
  ok(inv.length === 1 && approx(inv[0].charge01, 0.88), 'pack is left partially used, not consumed');
}

// a heal larger than the front pack spills into the next pack and removes the empty one
{
  const inv = [makePack(0.1), makePack(1)]; // 10 HP + 100 HP
  const applied = drawFromPacks(inv, 35);
  ok(applied === 35, 'draws across packs to satisfy the request');
  ok(inv.length === 1, 'the depleted front pack is removed');
  ok(approx(inv[0].charge01, 0.75), 'remaining 25 HP came out of the second pack');
}

// draw capped by available charge when packs run dry mid-heal
{
  const inv = [makePack(0.2)]; // only 20 HP available
  const applied = drawFromPacks(inv, 50);
  ok(applied === 20, 'applied is capped at the total available charge');
  ok(inv.length === 0, 'inventory empties when fully drained');
}

// zero request is a no-op
{
  const inv = [makePack(0.5)];
  ok(drawFromPacks(inv, 0) === 0 && inv.length === 1 && inv[0].charge01 === 0.5, 'a zero heal draws nothing');
}

// per-holder capacity: a medic-sized cap accepts beyond the default cap
{
  const inv = [makePack(), makePack()];
  ok(!canHold(inv), 'full at the default cap');
  ok(canHold(inv, 4), 'still room under a raised (medic) cap');
  ok(addPack(inv, makePack(), 4) === true && inv.length === 3, 'raised cap accepts a 3rd pack');
  ok(addPack(inv, makePack(), 4) === true && inv.length === 4, 'raised cap accepts a 4th pack');
  ok(addPack(inv, makePack(), 4) === false && inv.length === 4, 'raised cap rejects the 5th');
}

// revive-kit assembly consumes whole packs off the front, regardless of charge
{
  const inv = [makePack(0.2), makePack(1), makePack(0.5), makePack(1)];
  ok(hasReviveMaterials(inv) === true, `4 packs satisfy the ${REVIVE_KIT_PACK_COST}-pack revive cost`);
  ok(consumeRevivePacks(inv) === true && inv.length === 1, 'building a kit removes exactly the cost in packs');
  ok(hasReviveMaterials(inv) === false, 'one leftover pack is not enough for another kit');
  ok(consumeRevivePacks(inv) === false && inv.length === 1, 'a failed build leaves the inventory intact');
}

// ---- packClaimIntent: only consuming states may claim (C1) ----
{
  ok(packClaimIntent('patrol'), 'patrol always claims (opportunistic top-up)');
  ok(packClaimIntent('flee', true, false), 'flee claims when wounded and packless');
  ok(!packClaimIntent('flee', true, true), 'flee with a pack in hand heals instead');
  ok(!packClaimIntent('flee', false, false), 'healthy flee (kite) never detours');
  for (const s of ['fire', 'aim', 'pursue', 'knife', 'heal', 'cover-move', 'cover-hold',
    'medic-move', 'medic-tend', 'reposition', 'alert', 'seek', 'dead', undefined]) {
    ok(!packClaimIntent(s, true, false), `state ${s} never claims a pack`);
  }
}

// ---- packRunSafe: closing-bearing + standoff retention (C10) ----
{
  const bot = { x: 0, z: 0 };
  const threat = { x: 20, z: 0 };
  ok(packRunSafe(bot, { x: -5, z: 0 }, threat), 'pack behind the bot is always safe');
  ok(packRunSafe(bot, { x: 0, z: 5 }, threat), 'perpendicular grab is safe');
  ok(!packRunSafe(bot, { x: 19, z: 0 }, threat), "pack at the threat's feet is rejected");
  ok(!packRunSafe(bot, { x: 14, z: 0 }, threat), 'run that lands inside the danger band is rejected');
  ok(packRunSafe(bot, { x: 1.5, z: 0.5 }, threat), 'underfoot pack is grabbed regardless of bearing');
  ok(packRunSafe(bot, { x: 5, z: 0 }, null), 'no threat means any run is safe');
  ok(packRunSafe(bot, { x: 5, z: 0 }, { x: NaN, z: 0 }), 'non-finite threat is treated as absent');
  ok(packRunSafe(bot, bot, threat), 'zero-length run is degenerate-safe');
  ok(packRunSafe(bot, { x: 5, z: 0 }, { x: 0, z: 0 }), 'threat on top of the bot has no bearing to judge');
  const far = { x: 40, z: 0 };
  ok(packRunSafe(bot, { x: 8, z: 0 }, far), 'closing run that keeps standoff past both floors is allowed');
  ok(!packRunSafe(bot, { x: 30, z: 0 }, far), 'giving up over half the standoff is rejected even outside the danger band');
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('bot-health-packs: all assertions passed');
