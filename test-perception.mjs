// Node tests for perception.js (pure FOV/range/LOS candidate selection).
// Run: node test-perception.mjs
import {
  DEFAULT_FOV_DEGREES, withinFov, resolveRange, distanceSq,
  scanCandidates, firstVisible, selectVisibleEntry, selectNearestVisible,
} from './perception.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const at = (x, z, extra = {}) => ({ pos: { x, y: 0, z }, ...extra });

// ---------------------------------------------------------------- FOV cone
{
  const from = { x: 0, y: 0, z: 0 };
  ok(DEFAULT_FOV_DEGREES === 360, 'default FOV is omnidirectional');
  // yaw 0 = +Z
  ok(withinFov(from, { x: 0, z: 10 }, 0, 120), 'dead ahead is inside a 120 cone');
  ok(!withinFov(from, { x: 0, z: -10 }, 0, 120), 'directly behind is outside a 120 cone');
  ok(withinFov(from, { x: 10, z: 10 }, 0, 120), '45 deg off axis inside a 120 cone');
  ok(!withinFov(from, { x: 10, z: 1 }, 0, 120), '84 deg off axis outside a 120 cone');
  // exact edge: half-angle 60 deg
  const edge = { x: Math.sin(60 * Math.PI / 180) * 10, z: Math.cos(60 * Math.PI / 180) * 10 };
  ok(withinFov(from, edge, 0, 120), 'exact cone edge counts as inside');
  const justOutside = { x: Math.sin(60.5 * Math.PI / 180) * 10, z: Math.cos(60.5 * Math.PI / 180) * 10 };
  ok(!withinFov(from, justOutside, 0, 120), 'half a degree past the edge is outside');
  // 360 passes everything, including behind
  ok(withinFov(from, { x: 0, z: -10 }, 0, 360), '360 FOV passes a target behind');
  ok(withinFov(from, { x: 0, z: -10 }, 0), 'omitted FOV defaults to omnidirectional');
  ok(withinFov(from, { x: 0, z: -10 }, 0, 720), 'FOV above 360 still passes everything');
  // coincident / degenerate
  ok(withinFov(from, { x: 0, z: 0 }, 0, 1), 'coincident target has no bearing, passes');
  ok(withinFov(from, { x: 0, z: -10 }, undefined, 90), 'missing yaw disables the cone');
  // yaw wrapping: same geometry at yaw and yaw + 2pi
  const rand = mulberry(7);
  for (let i = 0; i < 200; i++) {
    const yaw = (rand() - 0.5) * 20; // includes values well past +-2pi
    const p = { x: (rand() - 0.5) * 40, z: (rand() - 0.5) * 40 };
    const a = withinFov(from, p, yaw, 120);
    const b = withinFov(from, p, yaw + Math.PI * 2, 120);
    const c = withinFov(from, p, yaw - Math.PI * 4, 120);
    if (a !== b || a !== c) { ok(false, 'FOV is invariant under 2pi yaw wrapping'); break; }
  }
  // facing behind: yaw = pi looks down -Z
  ok(withinFov(from, { x: 0, z: -10 }, Math.PI, 120), 'yaw pi sees -Z');
  ok(!withinFov(from, { x: 0, z: 10 }, Math.PI, 120), 'yaw pi does not see +Z');
  // yaw = pi/2 looks down +X
  ok(withinFov(from, { x: 10, z: 0 }, Math.PI / 2, 90), 'yaw pi/2 sees +X');
  ok(!withinFov(from, { x: -10, z: 0 }, Math.PI / 2, 90), 'yaw pi/2 does not see -X');
}

// ---------------------------------------------------------------- distance
{
  ok(distanceSq({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }) === 25, '3D distance uses y');
  ok(distanceSq({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }, true) === 9, 'planar distance ignores y');
  ok(distanceSq({ x: 0, z: 0 }, { x: 0, z: 5 }) === 25, 'missing y counts as 0');
}

// ---------------------------------------------------------------- range resolution
{
  ok(resolveRange(null) === Infinity, 'null ranges is uncapped');
  ok(resolveRange(undefined, 'hunt') === Infinity, 'undefined ranges is uncapped');
  ok(resolveRange(30) === 30, 'numeric ranges is the cap');
  ok(resolveRange(Infinity) === Infinity, 'Infinity cap stays uncapped');
  ok(resolveRange({ hunt: 18, social: 14 }, 'hunt') === 18, 'named range resolves by key');
  ok(resolveRange({ hunt: 18 }, 'missing') === Infinity, 'unknown key is uncapped');
  ok(resolveRange({ hunt: 18 }) === Infinity, 'named map with no key is uncapped');
}

// ---------------------------------------------------------------- range cap on/off
{
  const self = at(0, 0);
  const cands = [at(0, 5, { id: 'near' }), at(0, 25, { id: 'far' })];
  const capped = scanCandidates(self, cands, { ranges: 10 });
  ok(capped.length === 1 && capped[0].candidate.id === 'near', 'range cap drops the far candidate');
  const uncapped = scanCandidates(self, cands, {});
  ok(uncapped.length === 2, 'no ranges option means no cap');
  ok(scanCandidates(self, cands, { ranges: 25 }).length === 2, 'a candidate exactly at range is kept');
  // named ranges, key chosen per candidate
  const named = scanCandidates(self, cands, {
    ranges: { hunt: 18, social: 4 },
    rangeKey: c => (c.id === 'near' ? 'social' : 'hunt'),
  });
  ok(named.length === 0, 'per-candidate range keys cull both (5 > social 4, 25 > hunt 18)');
  ok(scanCandidates(self, cands, { ranges: { hunt: 18 }, rangeKey: 'hunt' }).length === 1,
    'a single named key applies to the whole scan');
}

// ---------------------------------------------------------------- ordering, filter, empties
{
  const self = at(0, 0);
  const cands = [at(0, 9, { id: 'c' }), at(0, 3, { id: 'a' }), at(0, 6, { id: 'b' })];
  const order = scanCandidates(self, cands, {}).map(e => e.candidate.id).join('');
  ok(order === 'abc', 'entries are sorted nearest first');
  ok(selectNearestVisible(self, cands, {}).id === 'a', 'nearest candidate wins by default');
  ok(selectNearestVisible(self, [], {}) === null, 'empty candidate list selects null');
  ok(selectNearestVisible(self, cands, { filter: () => false }) === null, 'all-filtered selects null');
  ok(selectNearestVisible(self, cands, { filter: c => c.id !== 'a' }).id === 'b',
    'filter removes a candidate before scoring');
  ok(selectVisibleEntry(self, [], {}) === null, 'entry form returns null on empty');
  // self is never its own candidate
  ok(selectNearestVisible(self, [self, ...cands], {}).id === 'a', 'self is skipped');
  // minRange drops coincident candidates
  const coincident = at(0, 0, { id: 'same' });
  ok(selectNearestVisible(self, [coincident, ...cands], { minRange: 1e-4 }).id === 'a',
    'minRange drops a coincident candidate');
  ok(selectNearestVisible(self, [coincident, ...cands], {}).id === 'same',
    'without minRange a coincident candidate is legal');
  // ties keep source order (stable sort)
  const tied = [at(0, 5, { id: 'first' }), at(5, 0, { id: 'second' })];
  ok(scanCandidates(self, tied, {})[0].candidate.id === 'first', 'ties keep source order');
}

// ---------------------------------------------------------------- losCheck
{
  const self = at(0, 0);
  const cands = [at(0, 3, { id: 'a' }), at(0, 6, { id: 'b' }), at(0, 9, { id: 'c' })];
  const blocked = new Set(['a', 'b']);
  const seen = [];
  const losCheck = (from, to, entry) => { seen.push(entry.candidate.id); return !blocked.has(entry.candidate.id); };
  ok(selectNearestVisible(self, cands, { losCheck }).id === 'c', 'LOS rejection falls through to next-nearest');
  ok(seen.join('') === 'abc', 'LOS is tested nearest-first and stops at the first pass');
  ok(selectNearestVisible(self, cands, { losCheck: () => false }) === null, 'all-occluded selects null');
  // losCheck receives usable geometry
  let sawDistance = null, sawFrom = null, sawTo = null;
  selectNearestVisible(self, [at(0, 4, { id: 'd' })], {
    losCheck: (from, to, entry) => { sawFrom = from; sawTo = to; sawDistance = entry.distance; return true; },
  });
  ok(Math.abs(sawDistance - 4) < 1e-9, 'losCheck entry carries the precomputed distance');
  ok(sawFrom.x === 0 && sawFrom.z === 0, 'losCheck receives the self position');
  ok(sawTo.x === 0 && sawTo.z === 4, 'losCheck receives the candidate position');
  // building blocks compose: scan then firstVisible by hand
  const entries = scanCandidates(self, cands, {});
  ok(firstVisible(self.pos, entries, (f, t, e) => e.candidate.id === 'b').candidate.id === 'b',
    'firstVisible is usable standalone');
  ok(firstVisible(self.pos, entries, null).candidate.id === 'a', 'firstVisible with no LOS takes the best entry');
  ok(firstVisible(self.pos, [], null) === null, 'firstVisible on an empty scan is null');
}

// ---------------------------------------------------------------- positions are snapshots
{
  const scratch = { x: 0, y: 0, z: 0 }; // mimics eyePosInto(), a reused vector
  const cands = [{ id: 'a', x: 0, z: 3 }, { id: 'b', x: 0, z: 6 }];
  const entries = scanCandidates(at(0, 0), cands, {
    positionOf: c => { if (!c.pos) { scratch.x = c.x; scratch.z = c.z; return scratch; } return c.pos; },
  });
  ok(entries[0].pos.z === 3 && entries[1].pos.z === 6, 'entry positions do not alias a reused scratch vector');
}

// ---------------------------------------------------------------- weak-target bonus
{
  const self = at(0, 0);
  const cands = [at(0, 5, { id: 'close' }), at(0, 5.5, { id: 'weak', weak: true })];
  ok(selectNearestVisible(self, cands, {}).id === 'close', 'pure distance picks the closer target');
  const bonus = c => (c.weak ? -0.9 : 0);
  ok(selectNearestVisible(self, cands, { scoreBonus: bonus }).id === 'weak',
    'weak bonus flips the pick away from pure distance');
  // bonus is not enough to overcome a big gap
  const far = [at(0, 5, { id: 'close' }), at(0, 9, { id: 'weak', weak: true })];
  ok(selectNearestVisible(self, far, { scoreBonus: bonus }).id === 'close',
    'weak bonus is bounded, a distant weak target does not win');
  ok(Math.abs(scanCandidates(self, cands, { scoreBonus: bonus })[0].score - 4.6) < 1e-9,
    'score is distance plus bonus');
}

// ================================================================ parity: bot-shaped config
// Mirrors selectBotTarget() (bot-viewer-v2.html:4431): 3D eye-to-eye distance, sightDistance cap,
// 120 deg horizontal cone, 1e-8 coincidence guard, nearest-first, first candidate with a clear ray.
{
  const SIGHT = 40, FOV = 120;
  const eye = e => ({ x: e.x, y: e.y + 1.6, z: e.z });

  function referenceSelectBotTarget(bot, live, rayBlocked) {
    const origin = eye(bot);
    const sightSq = SIGHT ** 2;
    const cands = [], distsSq = [];
    for (const target of live) {
      if (target.alive === false) continue;
      const targetEye = eye(target);
      const dx = targetEye.x - origin.x, dy = targetEye.y - origin.y, dz = targetEye.z - origin.z;
      const dsq = dx * dx + dy * dy + dz * dz;
      if (dsq < 1e-8 || dsq > sightSq) continue;
      const hx = targetEye.x - origin.x, hz = targetEye.z - origin.z;
      const len = Math.hypot(hx, hz);
      if (len >= 1e-6) {
        const cosToTarget = (Math.sin(bot.yaw) * hx + Math.cos(bot.yaw) * hz) / len;
        if (cosToTarget < Math.cos((FOV * Math.PI / 180) * 0.5)) continue;
      }
      cands.push(target); distsSq.push(dsq);
    }
    for (let i = 1; i < cands.length; i++) { // insertion sort, nearest first
      const t = cands[i], d = distsSq[i];
      let j = i - 1;
      while (j >= 0 && distsSq[j] > d) { distsSq[j + 1] = distsSq[j]; cands[j + 1] = cands[j]; j--; }
      distsSq[j + 1] = d; cands[j + 1] = t;
    }
    for (let i = 0; i < cands.length; i++) if (!rayBlocked(cands[i])) return cands[i];
    return null;
  }

  const botOptions = (bot, rayBlocked) => ({
    selfPosition: eye(bot),
    yaw: bot.yaw,
    fovDegrees: FOV,
    ranges: SIGHT,
    minRange: 1e-4, // 1e-8 squared, matching the coincidence guard
    filter: t => t.alive !== false,
    positionOf: eye,
    losCheck: (from, to, entry) => !rayBlocked(entry.candidate),
  });

  const rand = mulberry(1234);
  let mismatches = 0;
  for (let trial = 0; trial < 400; trial++) {
    const bot = { id: 'bot', x: 0, y: 0, z: 0, yaw: (rand() - 0.5) * 12, alive: true };
    const live = [];
    for (let i = 0; i < 8; i++) {
      live.push({
        id: i,
        x: (rand() - 0.5) * 100,
        y: (rand() - 0.5) * 4,
        z: (rand() - 0.5) * 100,
        alive: rand() > 0.15,
        blocked: rand() > 0.6,
      });
    }
    const rayBlocked = t => t.blocked;
    const expected = referenceSelectBotTarget(bot, live, rayBlocked);
    const actual = selectNearestVisible(bot, live, botOptions(bot, rayBlocked));
    if (expected !== actual) mismatches++;
  }
  ok(mismatches === 0, `bot-shaped config matches selectBotTarget (${mismatches} mismatches / 400)`);

  // hand-checked scenario: nearest is behind, next is occluded, third wins
  const bot = { id: 'bot', x: 0, y: 0, z: 0, yaw: 0, alive: true };
  const live = [
    { id: 'behind', x: 0, y: 0, z: -2, alive: true, blocked: false },
    { id: 'occluded', x: 0, y: 0, z: 5, alive: true, blocked: true },
    { id: 'clear', x: 0, y: 0, z: 12, alive: true, blocked: false },
    { id: 'toofar', x: 0, y: 0, z: 90, alive: true, blocked: false },
    { id: 'dead', x: 0, y: 0, z: 1, alive: false, blocked: false },
  ];
  const pick = selectNearestVisible(bot, live, botOptions(bot, t => t.blocked));
  ok(pick && pick.id === 'clear', 'bot scenario: behind/dead/occluded/out-of-range all skipped');
  ok(pick === referenceSelectBotTarget(bot, live, t => t.blocked), 'bot scenario matches the reference');
}

// ================================================================ parity: creature-shaped config
// Mirrors enemyTarget() (port-creature-system.js:2153): planar XZ distance, no cap, no FOV,
// no LOS, opposing-team combat-active only, -0.9 weak bonus, strict-less-than tie-break.
{
  const HUNT_SENSE = 18; // creature-activity.js sense range, used by the updateActivity variant

  function referenceEnemyTarget(self, list) {
    let best = null, bestScore = Infinity;
    for (const other of list) {
      if (other === self || !other.combatActive || other.teamId === self.teamId) continue;
      const d = Math.hypot(other.pos.x - self.pos.x, other.pos.z - self.pos.z);
      const score = d + (other.weak ? -0.9 : 0);
      if (score < bestScore) { bestScore = score; best = other; }
    }
    return best;
  }

  const creatureOptions = self => ({
    fovDegrees: 360,
    planar: true,
    filter: c => c.combatActive && c.teamId !== self.teamId,
    scoreBonus: c => (c.weak ? -0.9 : 0),
  });

  const rand = mulberry(99);
  let mismatches = 0;
  for (let trial = 0; trial < 400; trial++) {
    const self = { id: 'self', pos: { x: 0, y: 2, z: 0 }, teamId: 0, combatActive: true };
    const list = [self];
    for (let i = 0; i < 10; i++) {
      list.push({
        id: i,
        pos: { x: (rand() - 0.5) * 60, y: (rand() - 0.5) * 30, z: (rand() - 0.5) * 60 },
        teamId: rand() > 0.5 ? 0 : 1,
        combatActive: rand() > 0.2,
        weak: rand() > 0.7,
      });
    }
    const expected = referenceEnemyTarget(self, list);
    const actual = selectNearestVisible(self, list, creatureOptions(self));
    if (expected !== actual) mismatches++;
  }
  ok(mismatches === 0, `creature-shaped config matches enemyTarget (${mismatches} mismatches / 400)`);

  // y is ignored: a candidate far above but close in XZ still wins
  const self = { id: 'self', pos: { x: 0, y: 0, z: 0 }, teamId: 0, combatActive: true };
  const high = { id: 'high', pos: { x: 0, y: 50, z: 3 }, teamId: 1, combatActive: true };
  const flat = { id: 'flat', pos: { x: 0, y: 0, z: 6 }, teamId: 1, combatActive: true };
  ok(selectNearestVisible(self, [flat, high], creatureOptions(self)).id === 'high',
    'planar mode ignores a large y separation');
  // no distance cap: a very distant enemy is still acquired
  const distant = { id: 'distant', pos: { x: 0, y: 0, z: 5000 }, teamId: 1, combatActive: true };
  ok(selectNearestVisible(self, [distant], creatureOptions(self)).id === 'distant',
    'creature config has no sight cap');
  // sense-range variant (updateActivity prey scan) does cap
  ok(selectNearestVisible(self, [distant], { ...creatureOptions(self), ranges: { hunt: HUNT_SENSE }, rangeKey: 'hunt' }) === null,
    'a named HUNT_SENSE range caps the same scan');
}

if (failed === 0) console.log('perception: all tests passed');
else { console.error(`perception: ${failed} test(s) failed`); process.exit(1); }
