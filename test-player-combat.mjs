// Runs in Node.js. Verifies player-combat.js facade (Milestone M2).
import { createPlayerCombatFacade } from './player-combat.js';

let failures = 0;
function check(cond, msg) {
  if (!cond) {
    failures++;
    console.error(`FAIL: ${msg}`);
  }
}

function sameKeys(a, b) {
  const ak = Object.keys(a).sort();
  const bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((k, i) => k === bk[i]);
}

// --- Fallback: applyDamage reduces HP ---
{
  const combat = createPlayerCombatFacade();
  combat.ensurePlayer('p1');
  const snap = combat.applyDamage({ targetId: 'p1', amount: 30, source: 'gun', attackerId: 'p2', weaponId: 'm1911' });
  check(snap.hp === 70, `expected hp 70 after 30 damage, got ${snap.hp}`);
  check(snap.alive === true, 'player should still be alive after 30 damage');
  check(snap.maxHp === 100, `expected maxHp 100, got ${snap.maxHp}`);
}

// --- Fallback: damage past 0 sets alive:false and clamps hp to 0 ---
{
  const combat = createPlayerCombatFacade();
  combat.ensurePlayer('p1');
  const snap = combat.applyDamage({ targetId: 'p1', amount: 500, source: 'gun' });
  check(snap.hp === 0, `expected hp clamped to 0, got ${snap.hp}`);
  check(snap.alive === false, 'player should be dead after lethal damage');
}

// --- Fallback: revive restores HP and alive ---
{
  const combat = createPlayerCombatFacade();
  combat.ensurePlayer('p1');
  combat.applyDamage({ targetId: 'p1', amount: 500 });
  const revived = combat.revive('p1', { p: [0, 1, 0] });
  check(revived.hp === 100, `expected hp 100 after revive, got ${revived.hp}`);
  check(revived.alive === true, 'player should be alive after revive');
}

// --- Fallback: getSnapshot on a never-seen id initializes safely (no throw) ---
{
  const combat = createPlayerCombatFacade();
  let snap;
  try {
    snap = combat.getSnapshot('never-seen');
  } catch (e) {
    check(false, `getSnapshot on unseen id should not throw — got ${e}`);
  }
  check(snap && snap.hp === 100 && snap.alive === true, `unseen id should normalize to full hp/alive — got ${JSON.stringify(snap)}`);
}

// --- Delegated: fake ClaudeCraft adapter receives calls with expected args ---
{
  const calls = { getPlayerCombat: [], damagePlayer: [], revivePlayer: [], removeExternalPlayer: [] };
  const fakeAdapter = {
    _state: new Map(),
    ensurePlayer(id) {
      if (!this._state.has(id)) this._state.set(id, { hp: 100, maxHp: 100, alive: true });
    },
    getPlayerCombat(id) {
      calls.getPlayerCombat.push(id);
      return this._state.get(id) || { hp: 100, maxHp: 100, alive: true };
    },
    damagePlayer(id, packet) {
      calls.damagePlayer.push({ id, packet });
      const rec = this._state.get(id) || { hp: 100, maxHp: 100, alive: true };
      rec.hp = Math.max(0, rec.hp - packet.amount);
      rec.alive = rec.hp > 0;
      this._state.set(id, rec);
    },
    revivePlayer(id, pose) {
      calls.revivePlayer.push({ id, pose });
      const rec = this._state.get(id) || { hp: 100, maxHp: 100, alive: true };
      rec.hp = rec.maxHp;
      rec.alive = true;
      this._state.set(id, rec);
    },
    removeExternalPlayer(id) {
      calls.removeExternalPlayer.push(id);
      this._state.delete(id);
    },
  };

  const combat = createPlayerCombatFacade({ claudecraftCreatures: fakeAdapter });
  combat.ensurePlayer('g1');
  const dmgSnap = combat.applyDamage({ targetId: 'g1', amount: 40, source: 'gun', attackerId: 'g2', hitPoint: [1, 2, 3], weaponId: 'm24' });
  check(calls.damagePlayer.length === 1, `expected damagePlayer called once, got ${calls.damagePlayer.length}`);
  check(calls.damagePlayer[0].id === 'g1', `damagePlayer should be called with target id — got ${calls.damagePlayer[0].id}`);
  check(calls.damagePlayer[0].packet.amount === 40, `damagePlayer packet.amount should be 40 — got ${calls.damagePlayer[0].packet.amount}`);
  check(calls.damagePlayer[0].packet.attackerId === 'g2', `damagePlayer packet.attackerId should be g2 — got ${calls.damagePlayer[0].packet.attackerId}`);
  check(calls.damagePlayer[0].packet.weaponId === 'm24', `damagePlayer packet.weaponId should be m24 — got ${calls.damagePlayer[0].packet.weaponId}`);
  check(dmgSnap.hp === 60, `delegated applyDamage should return resulting snapshot hp 60 — got ${dmgSnap.hp}`);

  const worldPose = { p: [0, 1, 0] };
  const revivedSnap = combat.revive('g1', worldPose);
  check(calls.revivePlayer.length === 1, `expected revivePlayer called once, got ${calls.revivePlayer.length}`);
  check(calls.revivePlayer[0].id === 'g1', 'revivePlayer should be called with target id');
  check(calls.revivePlayer[0].pose === worldPose, 'revivePlayer should be called with the given worldPose');
  check(revivedSnap.hp === 100 && revivedSnap.alive === true, `delegated revive should restore full hp/alive — got ${JSON.stringify(revivedSnap)}`);

  combat.removePlayer('g1');
  check(calls.removeExternalPlayer.length === 1 && calls.removeExternalPlayer[0] === 'g1',
    `removePlayer should forward to removeExternalPlayer with id — got ${JSON.stringify(calls.removeExternalPlayer)}`);
}

// --- Snapshot shape is identical (same keys) in fallback and delegated mode ---
{
  const fallbackCombat = createPlayerCombatFacade();
  fallbackCombat.ensurePlayer('p1');
  const fallbackSnap = fallbackCombat.getSnapshot('p1');

  const fakeAdapter = {
    getPlayerCombat() { return { hp: 100, maxHp: 100, alive: true }; },
    damagePlayer() {},
    revivePlayer() {},
    removeExternalPlayer() {},
  };
  const delegatedCombat = createPlayerCombatFacade({ claudecraftCreatures: fakeAdapter });
  const delegatedSnap = delegatedCombat.getSnapshot('p1');

  check(sameKeys(fallbackSnap, delegatedSnap),
    `fallback and delegated snapshots should have identical keys — got ${JSON.stringify(Object.keys(fallbackSnap))} vs ${JSON.stringify(Object.keys(delegatedSnap))}`);
  check('hp' in fallbackSnap && 'maxHp' in fallbackSnap && 'alive' in fallbackSnap,
    'snapshot should have hp/maxHp/alive keys');
}

if (failures > 0) {
  console.error(`${failures} test(s) failed.`);
  process.exit(1);
} else {
  console.log('player-combat.js tests passed.');
  process.exit(0);
}
