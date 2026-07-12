// test-combat.mjs — pure hitscan combat math (multiplayer guns M1). No renderer/network
// involved; exercises ray/capsule geometry, shot validation, damage, and pose history.
import {
  rayCapsuleHit,
  findPlayerHit,
  validateShot,
  applyGunDamage,
  normalizeDir,
  pushPlayerPose,
  samplePlayerPose,
  prunePlayerPoseHistory,
  rayVerticalCylinderHit,
  raymarchTerrainHit,
  resolveHitscan,
} from './combat.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('FAIL:', m); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

const WEAPON = { id: 'rifle', damage: 25, range: 120, fireIntervalMs: 220 };

// 1. Ray straight through a capsule hits.
{
  const capsule = { p: [0, 1, 10], r: 0.35, h: 1.8 };
  const res = rayCapsuleHit([0, 1, 0], [0, 0, 1], 50, capsule);
  ok(res.hit === true, '1: straight-through ray hits capsule');
  ok(near(res.distance, 10 - 0.35), `1: hit distance at capsule surface — got ${res.distance}`);
}

// 2. Ray beside a capsule misses.
{
  const capsule = { p: [5, 1, 10], r: 0.35, h: 1.8 };
  const res = rayCapsuleHit([0, 1, 0], [0, 0, 1], 50, capsule);
  ok(res.hit === false, '2: ray beside capsule misses');
}

// 3. Nearest of two aligned targets wins.
{
  const players = [
    { id: 'far', p: [0, 1, 20], r: 0.35, h: 1.8, alive: true },
    { id: 'near', p: [0, 1, 8], r: 0.35, h: 1.8, alive: true },
  ];
  const hit = findPlayerHit({ shooterId: 'shooter', players, origin: [0, 1, 0], dir: [0, 0, 1], range: 50 });
  ok(hit !== null && hit.targetId === 'near', `3: nearest aligned target wins — got ${hit && hit.targetId}`);
}

// 4. Shooter cannot hit self.
{
  const players = [
    { id: 'shooter', p: [0, 1, 5], r: 0.35, h: 1.8, alive: true },
    { id: 'other', p: [0, 1, 10], r: 0.35, h: 1.8, alive: true },
  ];
  const hit = findPlayerHit({ shooterId: 'shooter', players, origin: [0, 1, 0], dir: [0, 0, 1], range: 50 });
  ok(hit !== null && hit.targetId === 'other', `4: shooter is skipped, other player is hit — got ${hit && hit.targetId}`);
}

// 5. Dead target ignored.
{
  const players = [
    { id: 'dead', p: [0, 1, 5], r: 0.35, h: 1.8, alive: false },
    { id: 'alive', p: [0, 1, 10], r: 0.35, h: 1.8, alive: true },
  ];
  const hit = findPlayerHit({ shooterId: 'shooter', players, origin: [0, 1, 0], dir: [0, 0, 1], range: 50 });
  ok(hit !== null && hit.targetId === 'alive', `5: dead target ignored — got ${hit && hit.targetId}`);

  const onlyDead = findPlayerHit({
    shooterId: 'shooter',
    players: [{ id: 'dead', p: [0, 1, 5], r: 0.35, h: 1.8, alive: false }],
    origin: [0, 1, 0], dir: [0, 0, 1], range: 50,
  });
  ok(onlyDead === null, '5b: only-dead-target scene returns no hit');
}

// 6. Cooldown rejection (shot within fireIntervalMs rejected).
{
  const shooter = { id: 's1', p: [0, 1, 0], h: 1.8, r: 0.35, alive: true, weapon: 'rifle' };
  const intent = { weapon: 'rifle', shotSeq: 2, origin: [0, 1.9, 0], dir: [0, 0, 1] };
  const lastShot = { shotSeq: 1, at: 1000 };
  const tooSoon = validateShot({ shooter, weapon: WEAPON, intent, nowMs: 1100, lastShot });
  ok(tooSoon.ok === false && tooSoon.reason === 'cooldown', `6: rapid refire rejected — got ${JSON.stringify(tooSoon)}`);

  const okAfter = validateShot({ shooter, weapon: WEAPON, intent, nowMs: 1000 + WEAPON.fireIntervalMs + 1, lastShot });
  ok(okAfter.ok === true, `6b: refire after cooldown accepted — got ${JSON.stringify(okAfter)}`);
}

// 7. Duplicate/stale shotSeq rejected.
{
  const shooter = { id: 's1', p: [0, 1, 0], h: 1.8, r: 0.35, alive: true, weapon: 'rifle' };
  const lastShot = { shotSeq: 5, at: 0 };
  const dup = validateShot({
    shooter, weapon: WEAPON, nowMs: 10000,
    intent: { weapon: 'rifle', shotSeq: 5, origin: [0, 1.9, 0], dir: [0, 0, 1] },
    lastShot,
  });
  ok(dup.ok === false && dup.reason === 'stale-shot-seq', `7: duplicate shotSeq rejected — got ${JSON.stringify(dup)}`);

  const stale = validateShot({
    shooter, weapon: WEAPON, nowMs: 10000,
    intent: { weapon: 'rifle', shotSeq: 3, origin: [0, 1.9, 0], dir: [0, 0, 1] },
    lastShot,
  });
  ok(stale.ok === false && stale.reason === 'stale-shot-seq', `7b: stale (older) shotSeq rejected — got ${JSON.stringify(stale)}`);
}

// Extra validateShot coverage: shooter dead, unknown weapon, bad dir, origin drift.
{
  const deadShooter = { id: 's1', p: [0, 1, 0], h: 1.8, r: 0.35, alive: false, weapon: 'rifle' };
  const deadRes = validateShot({
    shooter: deadShooter, weapon: WEAPON, nowMs: 1000,
    intent: { weapon: 'rifle', shotSeq: 1, origin: [0, 1.9, 0], dir: [0, 0, 1] },
    lastShot: null,
  });
  ok(deadRes.ok === false && deadRes.reason === 'shooter-dead', `extra: dead shooter rejected — got ${JSON.stringify(deadRes)}`);

  const noWeaponRes = validateShot({
    shooter: { id: 's1', p: [0, 1, 0], h: 1.8, r: 0.35, alive: true, weapon: 'rifle' },
    weapon: null, nowMs: 1000,
    intent: { weapon: 'rifle', shotSeq: 1, origin: [0, 1.9, 0], dir: [0, 0, 1] },
    lastShot: null,
  });
  ok(noWeaponRes.ok === false && noWeaponRes.reason === 'unknown-weapon', `extra: unknown weapon rejected — got ${JSON.stringify(noWeaponRes)}`);

  const badDirRes = validateShot({
    shooter: { id: 's1', p: [0, 1, 0], h: 1.8, r: 0.35, alive: true, weapon: 'rifle' },
    weapon: WEAPON, nowMs: 1000,
    intent: { weapon: 'rifle', shotSeq: 1, origin: [0, 1.9, 0], dir: [0, 0, 0] },
    lastShot: null,
  });
  ok(badDirRes.ok === false && badDirRes.reason === 'invalid-dir', `extra: zero dir rejected — got ${JSON.stringify(badDirRes)}`);

  const driftRes = validateShot({
    shooter: { id: 's1', p: [0, 1, 0], h: 1.8, r: 0.35, alive: true, weapon: 'rifle' },
    weapon: WEAPON, nowMs: 1000,
    intent: { weapon: 'rifle', shotSeq: 1, origin: [10, 10, 10], dir: [0, 0, 1] },
    lastShot: null,
  });
  ok(driftRes.ok === false && driftRes.reason === 'origin-too-far', `extra: origin drift rejected — got ${JSON.stringify(driftRes)}`);
}

// applyGunDamage: reduces hp, marks dead at 0, never goes negative.
{
  const hit = applyGunDamage({ hp: 100 }, WEAPON);
  ok(near(hit.hp, 75) && hit.alive === true, `extra: damage reduces hp — got ${JSON.stringify(hit)}`);
  const killed = applyGunDamage({ hp: 10 }, WEAPON);
  ok(killed.hp === 0 && killed.alive === false, `extra: lethal damage clamps to 0 and sets alive false — got ${JSON.stringify(killed)}`);
}

// normalizeDir: null on zero/non-finite, unit vector otherwise.
{
  ok(normalizeDir([0, 0, 0]) === null, 'extra: normalizeDir rejects zero vector');
  ok(normalizeDir([NaN, 0, 1]) === null, 'extra: normalizeDir rejects non-finite');
  const n = normalizeDir([0, 0, 5]);
  ok(n && near(n[2], 1) && near(n[0], 0), `extra: normalizeDir produces unit vector — got ${JSON.stringify(n)}`);
}

// 8. Pose history interpolates position by time (sample between two poses gives midpoint).
{
  const history = new Map();
  pushPlayerPose(history, 'p1', { p: [0, 1, 0], q: [0, 0, 0, 1], h: 1.8, r: 0.35, alive: true, hp: 100 }, 1000);
  pushPlayerPose(history, 'p1', { p: [10, 1, 0], q: [0, 0, 0, 1], h: 1.8, r: 0.35, alive: true, hp: 80 }, 1100);

  const mid = samplePlayerPose(history, 'p1', 1050);
  ok(mid !== null && near(mid.p[0], 5), `8: pose history interpolates midpoint x — got ${mid && mid.p[0]}`);

  const before = samplePlayerPose(history, 'p1', 900);
  ok(before !== null && near(before.p[0], 0), `8b: sample before range clamps to first sample — got ${before && before.p[0]}`);

  const after = samplePlayerPose(history, 'p1', 5000);
  ok(after !== null && near(after.p[0], 10), `8c: sample after range clamps to last sample — got ${after && after.p[0]}`);

  const missing = samplePlayerPose(history, 'nope', 1050);
  ok(missing === null, '8d: sampling an unknown id returns null');

  // Pruning drops samples older than maxAgeMs but always keeps at least the newest.
  prunePlayerPoseHistory(history, 5000, 750);
  const pruned = samplePlayerPose(history, 'p1', 1050);
  ok(pruned !== null && near(pruned.p[0], 10), `8e: pruning old samples still returns the newest — got ${pruned && pruned.p[0]}`);
}

// 9. Ray into a vertical cylinder (trunk/rock column) hits the near face.
{
  const col = { x: 0, z: 10, r: 0.4, minY: 0, maxY: 12 };
  const res = rayVerticalCylinderHit([0, 1, 0], [0, 0, 1], 50, col);
  ok(res.hit === true, '9: ray hits cylinder body');
  ok(near(res.distance, 10 - 0.4), `9: hit at near face — got ${res.distance}`);
  ok(res.normal && near(res.normal[2], -1), `9: outward normal faces the shooter — got ${JSON.stringify(res.normal)}`);
}

// 9b. Shot passing above a short column (rock) misses; a tall column (tree) is hit.
{
  const shortCol = { x: 0, z: 10, r: 0.5, minY: 0, maxY: 1.5 };
  const tallCol = { x: 0, z: 10, r: 0.5, minY: 0, maxY: 12 };
  const overShort = rayVerticalCylinderHit([0, 4, 0], [0, 0, 1], 50, shortCol);
  ok(overShort.hit === false, '9b: shot above a short rock misses its body');
  const intoTall = rayVerticalCylinderHit([0, 4, 0], [0, 0, 1], 50, tallCol);
  ok(intoTall.hit === true, '9b: same shot hits a tall trunk');
}

// 9c. Downward shot onto a column top hits the cap with an upward normal.
{
  const col = { x: 0, z: 5, r: 1, minY: 0, maxY: 2 };
  const res = rayVerticalCylinderHit([0, 6, 5], [0, -1, 0], 50, col);
  ok(res.hit === true && res.normal && near(res.normal[1], 1), `9c: top-cap hit with up normal — got ${JSON.stringify(res && res.normal)}`);
}

// 10. Terrain raymarch finds the ground crossing on a downward ray over a flat field.
{
  const flat = () => 0;
  const res = raymarchTerrainHit([0, 5, 0], [0, -1, 0], 20, flat, null, 0.25);
  ok(res.hit === true && near(res.point[1], 0, 0.26), `10: flat-ground crossing near y=0 — got ${res.hit && res.point[1]}`);
  const miss = raymarchTerrainHit([0, 5, 0], [0, 1, 0], 20, flat, null, 0.25);
  ok(miss.hit === false, '10b: upward ray never crosses flat ground');
}

// 11. resolveHitscan picks the nearest surface and reports its kind.
{
  const flat = () => 0;
  const players = [{ id: 'p2', p: [0, 1, 30], r: 0.35, h: 1.8, alive: true }];
  const creatures = [{ id: 'c1', p: [0, 1, 12], r: 0.6, h: 1.6, alive: true }];
  const obstacles = [{ id: 't1', x: 0, z: 8, r: 0.4, minY: 0, maxY: 12 }];
  // Obstacle at z=8 is nearest.
  const h1 = resolveHitscan({ shooterId: 's', origin: [0, 1, 0], dir: [0, 0, 1], range: 50, players, creatures, obstacles, heightAt: flat });
  ok(h1.kind === 'obstacle' && h1.id === 't1', `11: nearest is the tree — got ${h1.kind}/${h1.id}`);
  // Remove the obstacle: creature at z=12 wins over the far player.
  const h2 = resolveHitscan({ shooterId: 's', origin: [0, 1, 0], dir: [0, 0, 1], range: 50, players, creatures, obstacles: [], heightAt: flat });
  ok(h2.kind === 'creature' && h2.id === 'c1', `11b: creature beats the farther player — got ${h2.kind}/${h2.id}`);
  // Aim at empty air over flat ground → terrain or none, never a phantom entity hit.
  const h3 = resolveHitscan({ shooterId: 's', origin: [0, 1, 0], dir: [1, 0, 0], range: 50, players, creatures, obstacles, heightAt: flat });
  ok(h3.kind === 'none' || h3.kind === 'terrain', `11c: clear shot hits nothing solid — got ${h3.kind}`);
  ok(Array.isArray(h3.point) && h3.point.length === 3, '11d: always returns a tracer endpoint');
  // A ClaudeCraft mob nearer than everything else wins with kind 'mob'.
  const mobs = [{ id: 'wolf1', p: [0, 1, 5], r: 0.5, h: 1.8, alive: true }];
  const h4 = resolveHitscan({ shooterId: 's', origin: [0, 1, 0], dir: [0, 0, 1], range: 50, players, creatures, mobs, obstacles: [], heightAt: flat });
  ok(h4.kind === 'mob' && h4.id === 'wolf1', `11e: nearest mob wins with kind 'mob' — got ${h4.kind}/${h4.id}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
