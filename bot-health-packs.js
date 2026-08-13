// Pure, THREE-free health-pack inventory + charge math for the combat bots. Kept out of
// bot-viewer.html so the consumable arithmetic is unit-testable in Node (test-bot-health-packs.mjs),
// mirroring the pure-logic split in bot-activity.js. World meshes, pickup pathing, and rendering
// stay in the viewer; only "how much does a heal draw from which pack" lives here.

export const MAX_HELD_PACKS = 2;         // default capacity; roles (e.g. medic) raise it via the `max` args below
export const PACK_FULL_HEAL_HP = 100;    // a full (charge01 = 1) pack can restore up to this many HP total
export const REVIVE_KIT_PACK_COST = 3;   // packs a medic fuses into one revive kit

// A pack is a plain { charge01 } record so it round-trips through drop -> world -> pickup unchanged.
export function makePack(charge01 = 1) { return { charge01: Math.max(0, Math.min(1, charge01)) }; }

export function packHp(pack) { return Math.max(0, (pack?.charge01 ?? 0)) * PACK_FULL_HEAL_HP; }
export function packsTotalHp(packs) { return (packs || []).reduce((sum, p) => sum + packHp(p), 0); }
export function hasHealResource(packs) { return packsTotalHp(packs) > 1e-4; }
// Capacity is per-holder now: riflemen pass the default, medics pass their larger cap.
export function canHold(packs, max = MAX_HELD_PACKS) { return (packs?.length ?? 0) < max; }

// Add a pack if there's room; returns true when accepted. Mutates `packs`.
export function addPack(packs, pack, max = MAX_HELD_PACKS) {
  if (!canHold(packs, max)) return false;
  packs.push(pack);
  return true;
}

// --- pack-seek intent (audit C1) -------------------------------------------------------------
// Only two FSM branches ever walk a bot to a dropped pack: the out-of-combat PATROL branch (pack
// seek is its first priority) and FLEE while wounded-and-packless. Claiming the pack's nav cell
// from any other state (FIRE / COVER_HOLD / PURSUE / ...) is a phantom claim: nothing moves toward
// it, yet the shared goal-claim namespace blocks that cell for every other picker and starves
// wounded bots. `state` is the plain state string (BOT_* from bot-activity.js, MEDIC_* from
// bot-medic.js, or a harness pseudo-state like 'reposition'/'alert'); unknown states claim nothing.
export const PACK_SEEK_STATE_PATROL = 'patrol';  // BOT_PATROL: the out-of-combat / else branch
export const PACK_SEEK_STATE_FLEE = 'flee';      // BOT_FLEE: detours only when wounded and empty

export function packClaimIntent(state, wantsHeal = false, hasPack = false) {
  if (state === PACK_SEEK_STATE_PATROL) return true;             // opportunistic top-up walk
  if (state === PACK_SEEK_STATE_FLEE) return !!wantsHeal && !hasPack; // survival detour
  return false;
}

// --- pack-run safety (audit C10) -------------------------------------------------------------
// The commonest pack source is a fresh corpse at the enemy's feet, so a flee detour to a pack can
// point straight at the shooter. Reject a run whose bearing closes on the threat and gives up real
// standoff; a pack behind or beside the bot is always fine. Threat-distance terms are measured
// along the bot->threat bearing, which also rejects runs that overshoot past the threat.
export const PACK_RUN_SAFETY = Object.freeze({
  closingDot: 0.5,   // cos(bot->pack, bot->threat) above this counts as "running at the threat"
  minRunM: 2,        // a pack this close is grabbed regardless of bearing (barely any movement)
  dangerM: 8.5,      // never end the run inside the heal-unsafe band (mirrors healUnsafe)
  holdFrac: 0.5,     // and never give up more than this fraction of the current standoff
});

// botXZ/packXZ/threatXZ are any objects with .x/.z. Null/absent/non-finite threat => safe.
// Allocation-free: scalar math only, no vector temporaries.
export function packRunSafe(botXZ, packXZ, threatXZ, cfg = PACK_RUN_SAFETY) {
  if (!botXZ || !packXZ) return true;
  const tx = threatXZ?.x, tz = threatXZ?.z;
  if (!Number.isFinite(tx) || !Number.isFinite(tz)) return true;
  const px = packXZ.x - botXZ.x, pz = packXZ.z - botXZ.z;
  const qx = tx - botXZ.x, qz = tz - botXZ.z;
  const packDist = Math.hypot(px, pz);
  const threatDist = Math.hypot(qx, qz);
  if (!(packDist > 1e-6) || !(threatDist > 1e-6)) return true;   // degenerate: no bearing to judge
  const advance = (px * qx + pz * qz) / threatDist;              // metres closed along the threat bearing
  if (advance <= 0) return true;                                 // moving away from the threat
  if (advance / packDist <= cfg.closingDot) return true;          // lateral / perpendicular grab
  if (packDist <= cfg.minRunM) return true;                      // effectively underfoot
  const standoffLeft = threatDist - advance;
  return standoffLeft > cfg.dangerM && standoffLeft > cfg.holdFrac * threatDist;
}

// A revive kit costs `cost` whole packs regardless of their remaining charge (it's a fused item,
// not a charge pool). hasReviveMaterials just checks count; consumeRevivePacks removes them off the
// front of the inventory (same queue end drawFromPacks spends) and returns true when it did.
export function hasReviveMaterials(packs, cost = REVIVE_KIT_PACK_COST) { return (packs?.length ?? 0) >= cost; }
export function consumeRevivePacks(packs, cost = REVIVE_KIT_PACK_COST) {
  if (!hasReviveMaterials(packs, cost)) return false;
  packs.splice(0, cost);
  return true;
}

// Draw up to `hpWanted` health from the front of the inventory, spilling into the next pack when
// one empties. Removes depleted packs. Mutates `packs`; returns the HP actually applied (<= hpWanted,
// capped by remaining charge). A bot does not have to spend a whole pack -- a small heal leaves the
// pack partially charged, which is exactly what gets dropped on death.
export function drawFromPacks(packs, hpWanted) {
  let applied = 0;
  let want = Math.max(0, hpWanted);
  while (want > 1e-6 && packs.length > 0) {
    const available = packHp(packs[0]);
    const take = Math.min(want, available);
    applied += take;
    want -= take;
    packs[0].charge01 -= take / PACK_FULL_HEAL_HP;
    if (packs[0].charge01 <= 1e-4) packs.shift();
  }
  return applied;
}
