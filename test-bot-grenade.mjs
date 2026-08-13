// Node tests for bot-grenade.js (pure grenade-secondary decision math).
// Run: node test-bot-grenade.mjs
import { GRENADE_DEFAULTS, chooseGrenadeThrow, grenadeEvade, throwCountFor } from './bot-grenade.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

// Most cases use a 6 m blast so the self-veto ring (7.5 m) sits under minRange (8 m); the real
// 15 m grenade is exercised separately below, where the self veto is what actually binds.
const CFG = GRENADE_DEFAULTS;
const R = 6;
const SELF = { id: 'bot-1', team: 'red', p: [0, 1, 0] };

// A throw that passes every gate: two enemies clustered 12 m out, allies far away.
function base(over = {}) {
  return {
    self: SELF,
    target: { id: 'e1', p: [12, 1, 0], visible: true, lastKnownP: null, lastKnownAt: null, velocity: null },
    enemies: [{ id: 'e1', p: [12, 1, 0] }, { id: 'e2', p: [14, 1, 1] }],
    allies: [{ id: 'bot-2', p: [-20, 1, 0] }],
    blastRadius: R,
    grenadesLeft: 2,
    lastThrowAt: null,
    lastTeamThrowAt: null,
    now: 100000,
    ...over,
  };
}

// ---- defaults --------------------------------------------------------------------------------
{
  const keys = ['perBotCount', 'cooldownMs', 'teamCooldownMs', 'minRange', 'maxRange',
    'friendlyRadiusScale', 'selfRadiusScale', 'clusterWeight', 'blindThrowMaxAgeMs',
    'blindThrowChance', 'minEnemiesForVisibleThrow', 'aimLeadS', 'evadeExitScale'];
  for (const k of keys) ok(Number.isFinite(GRENADE_DEFAULTS[k]), `GRENADE_DEFAULTS.${k} is a finite number`);
  ok(Object.keys(GRENADE_DEFAULTS).length === keys.length, 'GRENADE_DEFAULTS has exactly the documented keys');
  ok(Object.isFrozen(GRENADE_DEFAULTS), 'GRENADE_DEFAULTS is frozen');
  ok(GRENADE_DEFAULTS.minRange < GRENADE_DEFAULTS.maxRange, 'min/max range are ordered');
  ok(GRENADE_DEFAULTS.blindThrowChance > 0 && GRENADE_DEFAULTS.blindThrowChance <= 1, 'blindThrowChance is a 0..1 multiplier');
  ok(GRENADE_DEFAULTS.selfRadiusScale >= GRENADE_DEFAULTS.friendlyRadiusScale, 'the thrower keeps at least the ally standoff');
}

// ---- throwCountFor ---------------------------------------------------------------------------
{
  ok(throwCountFor() === GRENADE_DEFAULTS.perBotCount, 'throwCountFor defaults to perBotCount');
  ok(throwCountFor({ perBotCount: 5 }) === 5, 'throwCountFor honours an override');
  ok(throwCountFor({}) === GRENADE_DEFAULTS.perBotCount, 'a partial settings object falls back to the default count');
  ok(throwCountFor(null) === GRENADE_DEFAULTS.perBotCount, 'a null settings object falls back to the default count');
}

// ---- the happy path (needed as the control for every gate below) -----------------------------
{
  const r = chooseGrenadeThrow(base(), CFG);
  ok(r !== null, 'the control scenario produces a throw');
  ok(r && r.targetId === 'e1', 'the throw carries the target id');
  ok(r && r.reason === 'cluster', 'a visible multi-enemy throw reads as cluster');
  ok(r && Math.abs(r.score - 3) < 1e-9, `two covered enemies score covered + (covered-1)*clusterWeight = 3 (got ${r && r.score})`);
  ok(r && r.aimPoint.length === 3 && r.aimPoint[1] === 1, 'aimPoint keeps the source Y for the viewer arc solve');
}

// ---- early-return gates, each in isolation ---------------------------------------------------
{
  ok(chooseGrenadeThrow(base({ grenadesLeft: 0 }), CFG) === null, 'no grenades left -> null');
  ok(chooseGrenadeThrow(base({ grenadesLeft: -1 }), CFG) === null, 'a negative grenade count -> null');
  // per-bot cooldown: just inside blocks, exactly at the cooldown passes
  ok(chooseGrenadeThrow(base({ lastThrowAt: 100000 - (CFG.cooldownMs - 1) }), CFG) === null, 'inside the per-bot cooldown -> null');
  ok(chooseGrenadeThrow(base({ lastThrowAt: 100000 - CFG.cooldownMs }), CFG) !== null, 'exactly at the per-bot cooldown throws');
  // team cooldown is independent of the bot's own
  ok(chooseGrenadeThrow(base({ lastTeamThrowAt: 100000 - (CFG.teamCooldownMs - 1) }), CFG) === null, 'inside the team cooldown -> null');
  ok(chooseGrenadeThrow(base({ lastTeamThrowAt: 100000 - CFG.teamCooldownMs }), CFG) !== null, 'exactly at the team cooldown throws');
  ok(chooseGrenadeThrow(base({ target: null }), CFG) === null, 'no target -> null');
  ok(chooseGrenadeThrow(base({ blastRadius: 0 }), CFG) === null, 'a zero blast radius -> null');
  ok(chooseGrenadeThrow(null, CFG) === null, 'a missing input object -> null');
  ok(chooseGrenadeThrow({ self: null }, CFG) === null, 'a missing self -> null');
  // range gate, both ends, measured to the aim point
  ok(chooseGrenadeThrow(base({ target: { id: 'e1', p: [4, 1, 0], visible: true }, enemies: [{ id: 'e1', p: [4, 1, 0] }, { id: 'e2', p: [5, 1, 0] }] }), CFG) === null, 'inside minRange -> null');
  ok(chooseGrenadeThrow(base({ target: { id: 'e1', p: [40, 1, 0], visible: true }, enemies: [{ id: 'e1', p: [40, 1, 0] }, { id: 'e2', p: [41, 1, 0] }] }), CFG) === null, 'beyond maxRange -> null');
  // a visible target with no enemy anywhere near the aim point is not worth a nade
  ok(chooseGrenadeThrow(base({ enemies: [] }), CFG) === null, 'an empty blast (no enemies covered) -> null');
}

// ---- the single-visible-enemy rule -----------------------------------------------------------
{
  const lone = base({ enemies: [{ id: 'e1', p: [12, 1, 0] }] });
  ok(chooseGrenadeThrow(lone, CFG) === null, 'one VISIBLE enemy is not worth a grenade');
  ok(chooseGrenadeThrow(base(), CFG) !== null, 'two clustered visible enemies are worth a grenade');
  // the threshold is a tunable, not a constant
  ok(chooseGrenadeThrow(lone, { ...CFG, minEnemiesForVisibleThrow: 1 }) !== null, 'lowering minEnemiesForVisibleThrow admits the lone visible enemy');
  ok(chooseGrenadeThrow(base(), { ...CFG, minEnemiesForVisibleThrow: 3 }) === null, 'raising minEnemiesForVisibleThrow rejects the pair');
}

// ---- friendly-fire veto ----------------------------------------------------------------------
{
  const ring = R * CFG.friendlyRadiusScale; // 6.9 m
  const justInside = base({ allies: [{ id: 'bot-2', p: [12 + ring - 0.05, 1, 0] }] });
  const justOutside = base({ allies: [{ id: 'bot-2', p: [12 + ring + 0.05, 1, 0] }] });
  ok(chooseGrenadeThrow(justInside, CFG) === null, 'a teammate just inside the friendly ring vetoes the throw');
  ok(chooseGrenadeThrow(justOutside, CFG) !== null, 'a teammate just outside the friendly ring does not veto');
  ok(chooseGrenadeThrow(base({ allies: [] }), CFG) !== null, 'no allies at all never vetoes');
  ok(chooseGrenadeThrow(base({ allies: null }), CFG) !== null, 'a missing allies array is tolerated');
  // the ring really is blastRadius-scaled: a bare blastRadius would let this one through
  const between = base({ allies: [{ id: 'bot-2', p: [12 + R + 0.2, 1, 0] }] });
  ok(chooseGrenadeThrow(between, CFG) === null, 'the veto ring is blastRadius * friendlyRadiusScale, not the bare blast');
  ok(chooseGrenadeThrow(between, { ...CFG, friendlyRadiusScale: 1 }) !== null, 'friendlyRadiusScale 1 shrinks the ring back to the bare blast');
}

// ---- self veto -------------------------------------------------------------------------------
{
  // drop minRange so the range gate cannot mask the self test
  const close = { ...CFG, minRange: 0 };
  const selfRing = R * CFG.selfRadiusScale; // 7.5 m
  const near = (d) => base({
    target: { id: 'e1', p: [d, 1, 0], visible: true },
    enemies: [{ id: 'e1', p: [d, 1, 0] }, { id: 'e2', p: [d + 1, 1, 0] }],
  });
  ok(chooseGrenadeThrow(near(selfRing - 0.05), close) === null, 'an aim point inside the thrower ring vetoes the throw');
  ok(chooseGrenadeThrow(near(selfRing + 0.05), close) !== null, 'an aim point just outside the thrower ring is allowed');
  ok(chooseGrenadeThrow(near(selfRing), close) === null, 'exactly on the thrower ring still vetoes (inclusive)');
}

// ---- blind / cover throws --------------------------------------------------------------------
{
  const blindAt = (ageMs, over = {}) => base({
    target: { id: 'e1', p: [12, 1, 0], visible: false, lastKnownP: [12, 1, 0], lastKnownAt: 100000 - ageMs, velocity: null },
    enemies: [{ id: 'e1', p: [12.5, 1, 0] }],
    ...over,
  });
  const fresh = chooseGrenadeThrow(blindAt(1000), CFG);
  ok(fresh !== null, 'a blind throw at a recently seen point is accepted');
  ok(fresh && fresh.reason === 'cover', 'a very fresh memory reads as a cover throw');
  ok(fresh && Math.abs(fresh.score - 1 * CFG.blindThrowChance) < 1e-9, `a blind throw is discounted by blindThrowChance (got ${fresh && fresh.score})`);
  ok(fresh && fresh.aimPoint[0] === 12 && fresh.aimPoint[2] === 0, 'a blind throw aims at the remembered point, not the true position');

  const stale = chooseGrenadeThrow(blindAt(3000), CFG);
  ok(stale !== null && stale.reason === 'blind', 'an older but in-window memory reads as a blind throw');

  ok(chooseGrenadeThrow(blindAt(CFG.blindThrowMaxAgeMs), CFG) !== null, 'exactly at blindThrowMaxAgeMs is still accepted');
  ok(chooseGrenadeThrow(blindAt(CFG.blindThrowMaxAgeMs + 1), CFG) === null, 'one ms past blindThrowMaxAgeMs -> null');
  ok(chooseGrenadeThrow(base({ target: { id: 'e1', p: [12, 1, 0], visible: false, lastKnownP: null, lastKnownAt: null } }), CFG) === null,
    'invisible target with no remembered point -> null');
  // the single-enemy rule is deliberately NOT applied to blind throws
  ok(chooseGrenadeThrow(blindAt(1000), { ...CFG, minEnemiesForVisibleThrow: 3 }) !== null, 'minEnemiesForVisibleThrow never gates a blind throw');
  // ...but the friendly and range gates still do
  ok(chooseGrenadeThrow(blindAt(1000, { allies: [{ id: 'bot-2', p: [13, 1, 0] }] }), CFG) === null, 'the friendly veto applies to blind throws too');
}

// ---- velocity lead ---------------------------------------------------------------------------
{
  const moving = base({
    target: { id: 'e1', p: [12, 1, 0], visible: true, velocity: { x: 0, z: 5 } },
    enemies: [{ id: 'e1', p: [12, 1, 0] }, { id: 'e2', p: [13, 1, 2] }],
  });
  const r = chooseGrenadeThrow(moving, CFG);
  ok(r !== null, 'a moving visible cluster still throws');
  ok(r && Math.abs(r.aimPoint[2] - 5 * CFG.aimLeadS) < 1e-9, `lead is velocity * aimLeadS on Z (got ${r && r.aimPoint[2]})`);
  ok(r && r.aimPoint[0] === 12, 'no lead is applied on an axis with no velocity');
  ok(r && r.aimPoint[1] === 1, 'lead never touches Y');
  // a null velocity is inert, and so is aimLeadS 0
  const still = chooseGrenadeThrow(base(), CFG);
  ok(still && still.aimPoint[2] === 0, 'a null velocity leads by nothing');
  const noLead = chooseGrenadeThrow(moving, { ...CFG, aimLeadS: 0 });
  ok(noLead && noLead.aimPoint[2] === 0, 'aimLeadS 0 disables the lead');
  // a blind throw is never led (the remembered point is already stale, not a live track)
  const blindMoving = chooseGrenadeThrow(base({
    target: { id: 'e1', p: [12, 1, 0], visible: false, lastKnownP: [12, 1, 0], lastKnownAt: 99000, velocity: { x: 0, z: 5 } },
    enemies: [{ id: 'e1', p: [12, 1, 0] }],
  }), CFG);
  ok(blindMoving && blindMoving.aimPoint[2] === 0, 'a blind throw is not led by a stale velocity');
}

// ---- cluster scoring is monotonic in enemy count ---------------------------------------------
{
  const scoreFor = (n) => {
    const enemies = [];
    for (let i = 0; i < n; i++) enemies.push({ id: `e${i}`, p: [12 + i * 0.5, 1, 0] });
    const r = chooseGrenadeThrow(base({ enemies }), CFG);
    return r ? r.score : null;
  };
  const scores = [2, 3, 4, 5].map(scoreFor);
  for (const s of scores) ok(s !== null, 'each cluster size produces a throw');
  for (let i = 1; i < scores.length; i++) ok(scores[i] > scores[i - 1], `score is monotonic in covered count (${scores.join(',')})`);
  ok(Math.abs(scores[0] - 3) < 1e-9, '2 covered -> 3');
  ok(Math.abs(scores[1] - 5) < 1e-9, '3 covered -> 5');
  // clusterWeight 0 collapses the score to the plain head count
  const flat = chooseGrenadeThrow(base({ enemies: [{ id: 'a', p: [12, 1, 0] }, { id: 'b', p: [12.5, 1, 0] }, { id: 'c', p: [13, 1, 0] }] }), { ...CFG, clusterWeight: 0 });
  ok(flat && Math.abs(flat.score - 3) < 1e-9, 'clusterWeight 0 scores the bare covered count');
  // enemies outside the blast do not count
  const spread = chooseGrenadeThrow(base({ enemies: [{ id: 'a', p: [12, 1, 0] }, { id: 'b', p: [12.5, 1, 0] }, { id: 'c', p: [12 + R + 1, 1, 0] }] }), CFG);
  ok(spread && Math.abs(spread.score - 3) < 1e-9, 'an enemy outside the blast radius is not counted');
}

// ---- no mutation of the caller's input --------------------------------------------------------
{
  const input = base();
  const snapshot = JSON.stringify(input);
  chooseGrenadeThrow(input, CFG);
  ok(JSON.stringify(input) === snapshot, 'chooseGrenadeThrow never mutates its input');
}

// ---- partial / junk settings ------------------------------------------------------------------
{
  ok(chooseGrenadeThrow(base(), {}) !== null, 'an empty settings object falls back to every default');
  ok(chooseGrenadeThrow(base(), { minRange: NaN, maxRange: undefined }) !== null, 'junk tunables fall back to defaults rather than producing NaN gates');
  ok(chooseGrenadeThrow(base()) !== null, 'settings defaults to GRENADE_DEFAULTS');
}

// ---- the real 15 m grenade: the self veto is what actually binds --------------------------------
// weapons.js grenade has blastRadius 15, so the thrower ring is 18.75 m -- wider than minRange 8.
{
  const big = (dist) => ({
    self: SELF,
    target: { id: 'e1', p: [dist, 1, 0], visible: true, velocity: null },
    enemies: [{ id: 'e1', p: [dist, 1, 0] }, { id: 'e2', p: [dist + 2, 1, 0] }],
    allies: [],
    blastRadius: 15,
    grenadesLeft: 2,
    lastThrowAt: null,
    lastTeamThrowAt: null,
    now: 100000,
  });
  ok(chooseGrenadeThrow(big(12), CFG) === null, 'at the authored 15 m blast, a 12 m throw is self-vetoed even though it clears minRange');
  const far = chooseGrenadeThrow(big(20), CFG);
  ok(far !== null, 'a 20 m throw clears the 18.75 m thrower ring');
  ok(far && far.reason === 'cluster' && Math.abs(far.score - 3) < 1e-9, 'the 20 m throw scores as a normal visible cluster');
  ok(chooseGrenadeThrow(big(26), CFG) === null, 'past maxRange the 15 m grenade is still refused');
  ok(15 * CFG.selfRadiusScale > CFG.minRange, 'documented: with the authored blast the self ring dominates minRange');
}

// ---- grenadeEvade ------------------------------------------------------------------------------
{
  const here = [0, 1, 0];
  ok(grenadeEvade(here, [], CFG) === null, 'no threats -> null');
  ok(grenadeEvade(here, null, CFG) === null, 'a missing threat array -> null');
  ok(grenadeEvade(here, [{ p: [20, 1, 0], blastRadius: 6, fuseRemainingS: 1 }], CFG) === null, 'a grenade whose blast does not reach the bot -> null');
  ok(grenadeEvade(null, [{ p: [1, 1, 0], blastRadius: 6, fuseRemainingS: 1 }], CFG) === null, 'a missing self position -> null');

  const covering = grenadeEvade(here, [{ p: [3, 1, 0], blastRadius: 6, fuseRemainingS: 1 }], CFG);
  ok(covering !== null, 'a grenade covering the bot is reported');
  ok(covering && covering.from[0] === 3 && covering.from.length === 3, 'from is the grenade position');
  ok(covering && covering.radius === 6, 'radius is the grenade blast radius');
  ok(covering && covering.urgency > 0 && covering.urgency <= 1, 'urgency is in 0..1');

  // urgency rises as the fuse runs down, at a fixed distance
  const urg = [2, 1.5, 1, 0.5, 0].map((f) => grenadeEvade(here, [{ p: [3, 1, 0], blastRadius: 6, fuseRemainingS: f }], CFG).urgency);
  for (let i = 1; i < urg.length; i++) ok(urg[i] > urg[i - 1], `urgency rises as the fuse runs down (${urg.map((u) => u.toFixed(3)).join(',')})`);
  ok(urg[urg.length - 1] <= 1, 'urgency never exceeds 1 at fuse 0');

  // urgency rises as the bot sits nearer the centre, at a fixed fuse
  const near = [5, 4, 3, 2, 1, 0].map((d) => grenadeEvade(here, [{ p: [d, 1, 0], blastRadius: 6, fuseRemainingS: 1 }], CFG).urgency);
  for (let i = 1; i < near.length; i++) ok(near[i] > near[i - 1], `urgency rises closer to the centre (${near.map((u) => u.toFixed(3)).join(',')})`);

  // exactly on the blast edge still counts as covered
  ok(grenadeEvade(here, [{ p: [6, 1, 0], blastRadius: 6, fuseRemainingS: 1 }], CFG) !== null, 'exactly at the blast edge is covered (inclusive)');

  // the MOST urgent wins, even when it is the farther grenade
  {
    const pick = grenadeEvade(here, [
      { p: [1, 1, 0], blastRadius: 6, fuseRemainingS: 1.9 },
      { p: [5, 1, 0], blastRadius: 6, fuseRemainingS: 0.2 },
    ], CFG);
    ok(pick && pick.from[0] === 5, 'a farther grenade with a nearly spent fuse outranks a close fresh one');
  }
  // ties on urgency go to the nearer grenade (same fuse, same proximity fraction)
  {
    const pick = grenadeEvade(here, [
      { p: [3, 1, 0], blastRadius: 6, fuseRemainingS: 1 },
      { p: [2, 1, 0], blastRadius: 4, fuseRemainingS: 1 },
    ], CFG);
    ok(pick && pick.from[0] === 2, 'equal urgency resolves to the nearer grenade');
  }
  // junk / spent entries are skipped rather than thrown on
  {
    const pick = grenadeEvade(here, [
      null,
      { p: [1, 1, 0] },
      { p: [1, 1, 0], blastRadius: 0, fuseRemainingS: 1 },
      { p: [1, 1, 0], blastRadius: 6, fuseRemainingS: -0.2 },
      { p: [2, 1, 0], blastRadius: 6, fuseRemainingS: 1 },
    ], CFG);
    ok(pick && pick.from[0] === 2, 'malformed, radius-less and already-detonated threats are skipped');
  }
  // a missing fuse reads as a full fuse rather than NaN
  {
    const pick = grenadeEvade(here, [{ p: [2, 1, 0], blastRadius: 6 }], CFG);
    ok(pick && Number.isFinite(pick.urgency), 'a missing fuseRemainingS still yields a finite urgency');
  }
  // evade is horizontal: a grenade directly overhead/below still covers the bot
  ok(grenadeEvade(here, [{ p: [0, 40, 0], blastRadius: 6, fuseRemainingS: 1 }], CFG) !== null, 'coverage is horizontal (XZ) like every other gate');
  // settings is optional
  ok(grenadeEvade(here, [{ p: [2, 1, 0], blastRadius: 6, fuseRemainingS: 1 }]) !== null, 'settings defaults to GRENADE_DEFAULTS');
  // the picked threat reports its id, so the caller can tell which grenade it is engaged with
  ok(grenadeEvade(here, [{ id: 'bp7', p: [2, 1, 0], blastRadius: 6, fuseRemainingS: 1 }], CFG).id === 'bp7', 'the winning threat carries its id back');
  ok(grenadeEvade(here, [{ p: [2, 1, 0], blastRadius: 6, fuseRemainingS: 1 }], CFG).id === null, 'an id-less threat reports a null id');
}

// ---- blastReaches occlusion hook -----------------------------------------------------------------
{
  // Hook that says a listed id is behind a wall from the aim point. The rings are unchanged; what
  // changes is which bodies inside them count.
  const shelter = (...ids) => (point, entry) => !ids.includes(entry.id);
  const seen = [];
  const record = (point, entry) => { seen.push([point[0], entry.id]); return true; };

  ok(chooseGrenadeThrow(base(), CFG) !== null, 'control: the base case throws with no hook at all');
  ok(chooseGrenadeThrow(base({ blastReaches: () => true }), CFG) !== null, 'an all-visible hook matches no hook');

  // Enemies the blast cannot reach must not count toward the cluster.
  ok(chooseGrenadeThrow(base({ blastReaches: shelter('e2') }), CFG) === null,
    'a sheltered enemy stops counting, dropping the pair under minEnemiesForVisibleThrow');
  ok(chooseGrenadeThrow(base({ blastReaches: shelter('e1', 'e2') }), CFG) === null,
    'every enemy sheltered reads as an empty blast, not a cluster');
  ok(chooseGrenadeThrow(base({ blastReaches: shelter('e2') }), { ...CFG, minEnemiesForVisibleThrow: 1 }) !== null,
    'the surviving enemy still counts: the hook filters, it does not zero the count');

  // An ally the blast cannot reach must not veto.
  const ring = R * CFG.friendlyRadiusScale;
  const allyInside = { allies: [{ id: 'bot-2', p: [12 + ring - 0.05, 1, 0] }] };
  ok(chooseGrenadeThrow(base(allyInside), CFG) === null, 'control: an exposed ally in the ring still vetoes');
  ok(chooseGrenadeThrow(base({ ...allyInside, blastReaches: shelter('bot-2') }), CFG) !== null,
    'an ally sheltered from the blast no longer vetoes the throw');

  // Nor must the thrower, which is what allows cooking one around a corner.
  const close = { ...CFG, minRange: 0 };
  const near = (over = {}) => base({
    target: { id: 'e1', p: [4, 1, 0], visible: true },
    enemies: [{ id: 'e1', p: [4, 1, 0] }, { id: 'e2', p: [5, 1, 0] }],
    ...over,
  });
  ok(chooseGrenadeThrow(near(), close) === null, 'control: an exposed thrower inside its own ring vetoes');
  ok(chooseGrenadeThrow(near({ blastReaches: shelter('bot-1') }), close) !== null,
    'a thrower sheltered from its own aim point may throw short');
  ok(chooseGrenadeThrow(near({ blastReaches: shelter('bot-1') }), CFG) === null,
    'minRange still holds the floor for that short throw -- occlusion waives the self ring, not the range gate');

  // Cost contract: the hook is consulted only for bodies already inside the ring.
  chooseGrenadeThrow(base({ allies: [{ id: 'far', p: [-500, 1, 0] }], blastReaches: record }), CFG);
  ok(seen.length > 0, 'the hook is actually called');
  ok(!seen.some(([, id]) => id === 'far'), 'a body outside the ring is never handed to the hook');
  ok(seen.every(([x]) => Math.abs(x - 12) < 2), 'the hook is asked about the aim point, not the thrower');

  // A hook that returns a non-boolean must not be read as "reaches".
  ok(chooseGrenadeThrow(base({ blastReaches: () => undefined }), CFG) === null,
    'a hook returning undefined reads as unreachable, never as a pass');
}

// ---- evade hysteresis (evadeExitScale) -----------------------------------------------------------
{
  const here = [0, 1, 0];
  // 7 m out with a 6 m blast: outside the engage ring, inside the 1.25x release ring (7.5 m).
  const justOut = [{ id: 'bp1', p: [7, 1, 0], blastRadius: 6, fuseRemainingS: 1 }];
  ok(grenadeEvade(here, justOut, GRENADE_DEFAULTS) === null, 'a bot not yet evading is not grabbed outside the blast radius');
  ok(grenadeEvade(here, justOut, GRENADE_DEFAULTS, 'bp1') !== null, 'a bot ALREADY evading that grenade keeps evading past the edge');
  ok(grenadeEvade(here, justOut, GRENADE_DEFAULTS, 'bp9') === null, 'the wider ring applies only to the grenade being evaded, not every threat');
  // Past the release ring the hold ends even while engaged.
  const wellOut = [{ id: 'bp1', p: [8, 1, 0], blastRadius: 6, fuseRemainingS: 1 }];
  ok(grenadeEvade(here, wellOut, GRENADE_DEFAULTS, 'bp1') === null, 'past blastRadius * evadeExitScale the engaged hold releases');
  // Scale of 1 restores the old hard cutoff.
  ok(grenadeEvade(here, justOut, { ...GRENADE_DEFAULTS, evadeExitScale: 1 }, 'bp1') === null, 'evadeExitScale 1 disables the hysteresis');
  // A scale below 1 must not shrink the ring under the engage radius.
  ok(grenadeEvade(here, [{ id: 'bp1', p: [5, 1, 0], blastRadius: 6, fuseRemainingS: 1 }], { ...GRENADE_DEFAULTS, evadeExitScale: 0.2 }, 'bp1') !== null,
    'an evadeExitScale below 1 is clamped, never narrowing the ring');
  // Urgency still measures against the real blast radius, so the widened band reads as zero proximity.
  const held = grenadeEvade(here, justOut, GRENADE_DEFAULTS, 'bp1');
  ok(held.urgency >= 0 && held.urgency <= 1, 'urgency stays in 0..1 outside the damage ring');
  ok(held.radius === 6, 'the reported radius is the damage ring, not the widened release ring');
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('bot-grenade: all assertions passed');
