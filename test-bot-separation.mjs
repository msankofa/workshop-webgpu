// Node tests for bot-bot separation (Task 0 of the cover/corners plan): pairwise pushout,
// doorway squeeze vs. wall rects, separation steering, and movement-goal claims.
// Run: node test-bot-separation.mjs
import { resolveBotPairs, separationXZ, blendSeparationDir, createGoalClaims } from './bot-separation.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

const R = 0.3; // default capsule radius in bot-entity.js
// Plain-object twin of createBotEntity's capsule shape (bot-entity.js needs THREE, so Node
// tests build the same {capsule:{start,end,radius}} contract directly).
function makeBot(id, { x, y = 0, z }, radius = R) {
  return {
    id, alive: true,
    capsule: { radius, start: { x, y: y + radius, z }, end: { x, y: y + 1.8 - radius, z } },
  };
}
function xzDist(a, b) {
  return Math.hypot(b.capsule.start.x - a.capsule.start.x, b.capsule.start.z - a.capsule.start.z);
}

// ---- pairwise pushout ----
{
  const a = makeBot('a', { x: 0, y: 0, z: 0 });
  const b = makeBot('b', { x: 0.1, y: 0, z: 0.05 });
  const aEndY = a.capsule.end.y;
  const moved = resolveBotPairs([a, b]);
  ok(xzDist(a, b) >= 2 * R - 1e-9, 'overlapping pair separates to >= 2r');
  ok(moved.has(a) && moved.has(b), 'both bots of an overlapping pair are reported moved');
  ok(a.capsule.end.x === a.capsule.start.x && a.capsule.end.z === a.capsule.start.z, 'capsule end translates rigidly with start');
  ok(a.capsule.end.y === aEndY && a.capsule.start.y === R, 'pushout never touches Y');
}
{
  const a = makeBot('a', { x: 2, y: 0, z: 2 });
  const b = makeBot('b', { x: 2, y: 0, z: 2 });
  resolveBotPairs([a, b]);
  ok(xzDist(a, b) >= 2 * R - 1e-9, 'coincident bots still separate to >= 2r');
}
{
  const a = makeBot('a', { x: 0, y: 0, z: 0 });
  const b = makeBot('b', { x: 1.0, y: 0, z: 0 });
  const moved = resolveBotPairs([a, b]);
  ok(moved.size === 0, 'non-overlapping pair is untouched');
  ok(a.capsule.start.x === 0 && b.capsule.start.x === 1.0, 'non-overlapping positions unchanged');
}
{
  const a = makeBot('a', { x: 0, y: 0, z: 0 });
  const b = makeBot('b', { x: 0.2, y: 0, z: 0 });
  const c = makeBot('c', { x: 0.4, y: 0, z: 0 });
  for (let frame = 0; frame < 10; frame++) resolveBotPairs([a, b, c]); // one pass per frame, as wired
  ok(xzDist(a, b) >= 2 * R - 1e-3 && xzDist(b, c) >= 2 * R - 1e-3 && xzDist(a, c) >= 2 * R - 1e-3,
    'three-bot pileup separates to within a millimeter over a few frames');
}
{
  const a = makeBot('a', { x: 0, y: 0, z: 0 });
  const b = makeBot('b', { x: 0.1, y: 0, z: 0 });
  const moved = resolveBotPairs([a, b], 0.5);
  ok(moved.size === 2 && xzDist(a, b) >= 1.0 - 1e-9, 'explicit radius overrides the capsule radius');
}

// ---- doorway squeeze: pushout + wall re-resolve never leaves a bot inside a wall rect ----
// Stand-in for mapCollider.resolveCapsule: XZ circle-vs-rect pushout (the viewer re-resolves
// pushed bots against the BVH collider; walls there are these same axis-aligned rects).
function resolveWallRects(entity, rects, r) {
  const p = entity.capsule.start;
  for (const w of rects) {
    const cx = Math.min(Math.max(p.x, w.x - w.w / 2), w.x + w.w / 2);
    const cz = Math.min(Math.max(p.z, w.z - w.d / 2), w.z + w.d / 2);
    const dx = p.x - cx, dz = p.z - cz;
    const d = Math.hypot(dx, dz);
    if (d >= r) continue;
    let px, pz;
    if (d < 1e-9) {
      const exitX = w.w / 2 - Math.abs(p.x - w.x) + r;
      const exitZ = w.d / 2 - Math.abs(p.z - w.z) + r;
      if (exitX < exitZ) { px = Math.sign(p.x - w.x || 1) * exitX; pz = 0; }
      else { px = 0; pz = Math.sign(p.z - w.z || 1) * exitZ; }
    } else {
      px = (dx / d) * (r - d); pz = (dz / d) * (r - d);
    }
    entity.capsule.start.x += px; entity.capsule.start.z += pz;
    entity.capsule.end.x += px; entity.capsule.end.z += pz;
  }
}
function wallPenetration(entity, rects, r) {
  let worst = 0;
  const p = entity.capsule.start;
  for (const w of rects) {
    const cx = Math.min(Math.max(p.x, w.x - w.w / 2), w.x + w.w / 2);
    const cz = Math.min(Math.max(p.z, w.z - w.d / 2), w.z + w.d / 2);
    worst = Math.max(worst, r - Math.hypot(p.x - cx, p.z - cz));
  }
  return worst;
}
{
  // 1.0 m doorway at x=3 (two bots abreast need 1.2 m -> they must squeeze single file).
  const walls = [
    { x: 3, z: -2.75, w: 0.2, d: 4.5 }, // north jamb, gap z in (-0.5, 0.5)
    { x: 3, z: 2.75, w: 0.2, d: 4.5 },  // south jamb
  ];
  const a = makeBot('a', { x: 1.0, y: 0, z: -0.31 });
  const b = makeBot('b', { x: 1.0, y: 0, z: 0.31 });
  const dt = 1 / 60, speed = 2.4, goal = { x: 6, z: 0 };
  let maxPen = 0;
  for (let frame = 0; frame < 360; frame++) {
    for (const e of [a, b]) {
      const dx = goal.x - e.capsule.start.x, dz = goal.z - e.capsule.start.z;
      const d = Math.hypot(dx, dz) || 1;
      e.capsule.start.x += (dx / d) * speed * dt; e.capsule.start.z += (dz / d) * speed * dt;
      e.capsule.end.x += (dx / d) * speed * dt; e.capsule.end.z += (dz / d) * speed * dt;
      resolveWallRects(e, walls, R); // per-bot wall resolve, as stepBotPhysics does
    }
    const moved = resolveBotPairs([a, b]);
    for (const e of moved) resolveWallRects(e, walls, R); // the wired follow-up wall re-resolve
    maxPen = Math.max(maxPen, wallPenetration(a, walls, R), wallPenetration(b, walls, R));
  }
  ok(maxPen <= 1e-6, `doorway squeeze never penetrates a wall rect (worst ${maxPen.toFixed(5)} m)`);
}

// ---- separation steering ----
{
  const self = makeBot('s', { x: 0, y: 0, z: 0 });
  const near = makeBot('n', { x: 0.8, y: 0, z: 0 });
  const far = makeBot('f', { x: 10, y: 0, z: 0 });
  const sep = separationXZ(self, [self, near, far], 1.5);
  ok(sep && sep.x < 0 && Math.abs(sep.z) < 1e-9, 'separation points away from a near neighbor');
  ok(separationXZ(self, [self, far], 1.5) === null, 'no neighbors in radius -> null');
  const dead = makeBot('d', { x: 0.5, y: 0, z: 0 });
  dead.alive = false;
  ok(separationXZ(self, [self, dead], 1.5) === null, 'dead neighbors are ignored');
  const nearer = makeBot('n2', { x: 0.4, y: 0, z: 0 });
  const sepNearer = separationXZ(self, [self, nearer], 1.5);
  ok(Math.abs(sepNearer.x) > Math.abs(sep.x), 'closer neighbors repel harder (1/dist weighting)');
}

// ---- separation blend: deflection, jam-dissolving reversal, walkability gate ----
{
  const mild = blendSeparationDir(1, 0, { x: -0.2, z: 0.4 }, 0.5, null);
  ok(mild.x > 0 && mild.z > 0, 'mild separation deflects the heading');
  // Contact-range 1/d^2 spikes MAY reverse the heading -- that reversal is what dissolves
  // corner jams (harness-verified); the caller damps the speed instead of banning it.
  const spike = blendSeparationDir(1, 0, { x: -4.0, z: 0.1 }, 0.5, null);
  ok(spike.x < 0, 'a strong contact spike is allowed to reverse the heading');
  const blocked = blendSeparationDir(1, 0, { x: -0.2, z: 0.4 }, 0.5, () => true);
  ok(blocked.x === 1 && blocked.z === 0, 'walkability gate overrides any deflection');
}

// ---- goal claims ----
{
  const alive = new Set(['b1', 'b2']);
  const claims = createGoalClaims((id) => alive.has(id));
  const pickGoal = (id) => [55, 99].find((cell) => !claims.isClaimedByOther(cell, id)) ?? null;

  let g1 = pickGoal('b1'); claims.claim('b1', 'flee', g1);
  let g2 = pickGoal('b2'); claims.claim('b2', 'flee', g2);
  ok(g1 === 55 && g2 === 99, 'two bots offered the same goal cells resolve to different cells');
  ok(!claims.isClaimedByOther(55, 'b1'), 'a bot is never blocked by its own claim');

  claims.claim('b1', 'flee', 77); // replan: new commit replaces the old claim
  ok(!claims.isClaimedByOther(55, 'b2'), 'replan releases the previously claimed cell');
  ok(claims.isClaimedByOther(77, 'b2'), 'replan holds the new cell');

  claims.claim('b1', 'pack', 12);
  claims.release('b1', 'pack'); // kind-scoped release keeps the flee claim
  ok(!claims.isClaimedByOther(12, 'b2') && claims.isClaimedByOther(77, 'b2'), 'kind-scoped release leaves other kinds claimed');

  alive.delete('b1'); // death: liveness gate stops a stale claim from blocking anyone
  ok(!claims.isClaimedByOther(77, 'b2'), 'a dead owner no longer blocks its claimed cell');
  claims.release('b1');
  ok(claims.size === 1, 'release-all on death drops every claim the bot held');

  claims.clear();
  ok(claims.size === 0 && !claims.isClaimedByOther(99, 'b1'), 'layout reset clears all claims');
}

// ---- goal claims: cross-kind self-eviction (L9) ----
// One bot claiming the same cell under two kinds must not have its surviving claim deleted by
// the other kind's release -- wave 3 adds a 'seek' kind alongside 'flee'/'cover'.
{
  const alive = new Set(['b1', 'b2']);
  const claims = createGoalClaims((id) => alive.has(id));

  claims.claim('b1', 'flee', 40);
  claims.claim('b1', 'cover', 40); // same owner, second kind, same cell: last writer owns the record
  claims.release('b1', 'flee');
  ok(claims.isClaimedByOther(40, 'b2'), 'releasing kind A leaves the same owner kind-B claim on that cell');
  ok(claims.size === 1, 'cross-kind claim on one cell keeps exactly one cell record');
  claims.release('b1', 'cover');
  ok(!claims.isClaimedByOther(40, 'b2') && claims.size === 0, 'releasing the owning kind frees the cell');

  claims.claim('b1', 'seek', 41);
  claims.release('b1', 'cover'); // never claimed under this kind
  ok(claims.isClaimedByOther(41, 'b2') && claims.size === 1, 'release with a kind the bot never claimed is a no-op');
  claims.release('b2', 'seek'); // unknown owner
  ok(claims.isClaimedByOther(41, 'b2'), 'release by a non-owner leaves the claim intact');

  // Different-owner overwrite: unchanged last-writer-wins, and the loser cannot evict the winner.
  claims.claim('b2', 'seek', 41);
  ok(claims.isClaimedByOther(41, 'b1'), 'a later claim by another bot takes the cell');
  claims.release('b1', 'seek');
  ok(claims.isClaimedByOther(41, 'b1'), 'the overwritten owner cannot evict the newer claim');

  // Death: releaseAll frees every record the bot still owns, across kinds and same-cell overlaps.
  claims.clear();
  claims.claim('b1', 'flee', 50);
  claims.claim('b1', 'cover', 50);
  claims.claim('b1', 'seek', 51);
  claims.release('b1');
  ok(claims.size === 0, 'release-all frees same-cell multi-kind claims and every other kind');
  ok(!claims.isClaimedByOther(50, 'b2') && !claims.isClaimedByOther(51, 'b2'), 'no cell stays blocked after release-all');
  // release-all must still leave another owner's record standing.
  claims.claim('b1', 'flee', 60);
  claims.claim('b2', 'flee', 60);
  claims.release('b1');
  ok(claims.isClaimedByOther(60, 'b1') && claims.size === 1, 'release-all does not evict another bot newer claim');

  // Re-claiming the same cell+kind is idempotent, and the owner is still never self-blocked.
  claims.clear();
  claims.claim('b1', 'seek', 70);
  claims.claim('b1', 'seek', 70);
  ok(claims.size === 1 && !claims.isClaimedByOther(70, 'b1') && claims.isClaimedByOther(70, 'b2'),
    're-claiming the same cell under the same kind is idempotent');
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('bot-separation: all assertions passed');
