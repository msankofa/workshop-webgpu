// Host-owned player combat facade (Milestone M2 of the multiplayer guns plan).
// No THREE, no DOM — pure/Node-testable. One source of truth for player
// hp/alive/revive so gun damage and (future) ClaudeCraft mob damage share
// the same authority instead of creating a second HP owner.
//
// Two backends, identical normalized behavior:
//   - Fallback:   host-owned Map<id, { hp, maxHp, alive }> (used when no
//                 ClaudeCraft creature bridge is active).
//   - Delegated:  forwards to a `claudecraftCreatures` adapter's hooks
//                 (getPlayerCombat/damagePlayer/revivePlayer/removeExternalPlayer)
//                 when that system owns player HP/death/revive instead.
//
// See docs/superpowers/specs/2026-07-05-multiplayer-guns-design.md
// ("Player Combat State", "Host State Ownership",
//  "Compatibility With ClaudeCraft Creature Integration") and
// docs/superpowers/plans/2026-07-05-multiplayer-guns-implementation.md
// (Milestone M2) for the full design.

const DEFAULT_HP = 100;

function normalizeSnapshot(raw) {
  if (!raw) return { hp: DEFAULT_HP, maxHp: DEFAULT_HP, alive: true };
  const maxHp = typeof raw.maxHp === 'number' ? raw.maxHp : DEFAULT_HP;
  const hp = typeof raw.hp === 'number' ? raw.hp : maxHp;
  const alive = typeof raw.alive === 'boolean' ? raw.alive : hp > 0;
  return { hp, maxHp, alive };
}

export function createPlayerCombatFacade({ claudecraftCreatures } = {}) {
  const delegated = !!claudecraftCreatures;
  const fallback = new Map(); // id -> { hp, maxHp, alive }

  function ensureFallbackRecord(id, opts) {
    let rec = fallback.get(id);
    if (!rec) {
      const maxHp = (opts && typeof opts.maxHp === 'number') ? opts.maxHp : DEFAULT_HP;
      const hp = (opts && typeof opts.hp === 'number') ? opts.hp : maxHp;
      rec = { hp, maxHp, alive: hp > 0 };
      fallback.set(id, rec);
    }
    return rec;
  }

  function ensurePlayer(id, opts) {
    if (delegated) {
      if (typeof claudecraftCreatures.ensurePlayer === 'function') {
        claudecraftCreatures.ensurePlayer(id, opts);
      }
      return getSnapshot(id);
    }
    return normalizeSnapshot(ensureFallbackRecord(id, opts));
  }

  function getSnapshot(id) {
    if (delegated) {
      const raw = claudecraftCreatures.getPlayerCombat(id);
      return normalizeSnapshot(raw);
    }
    return normalizeSnapshot(ensureFallbackRecord(id));
  }

  function applyDamage({ targetId, amount, source, attackerId, hitPoint, weaponId }) {
    if (delegated) {
      claudecraftCreatures.damagePlayer(targetId, { amount, source, attackerId, hitPoint, weaponId });
      return getSnapshot(targetId);
    }
    const rec = ensureFallbackRecord(targetId);
    const dmg = typeof amount === 'number' && Number.isFinite(amount) ? amount : 0;
    rec.hp = Math.max(0, rec.hp - dmg);
    rec.alive = rec.hp > 0;
    return normalizeSnapshot(rec);
  }

  function revive(id, worldPose) {
    if (delegated) {
      claudecraftCreatures.revivePlayer(id, worldPose);
      return getSnapshot(id);
    }
    const rec = ensureFallbackRecord(id);
    rec.hp = rec.maxHp;
    rec.alive = true;
    return normalizeSnapshot(rec);
  }

  function removePlayer(id) {
    if (delegated) {
      claudecraftCreatures.removeExternalPlayer(id);
      return;
    }
    fallback.delete(id);
  }

  return {
    ensurePlayer,
    getSnapshot,
    applyDamage,
    revive,
    removePlayer,
  };
}
