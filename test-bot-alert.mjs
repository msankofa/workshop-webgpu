// Node tests for the squad-alert module (lemming fix): ally-hit windows (deaths outlive
// grazes), baked-field exposure checks on a hand-built hallway, and the alert-hold stepper
// (hold cap + cooldown so a sustained firefight can't freeze a bot).
// Run: node test-bot-alert.mjs
import { buildNavGrid } from './nav-grid.js';
import { buildSightGrid, buildVisibilityField, cellIndexAt } from './nav-visibility.js';
import {
  latestAlertNear, exposedToThreat, stepAlertHold, alertWindowMs, alertEscalation, alertTierChannels,
  latestNearMiss, latestSelfThreat, shotMissDistance, isNearMiss,
  ALLY_ALERT_WINDOW_MS, ALLY_DEATH_WINDOW_MS, ALERT_HOLD_MAX_MS, ALERT_HOLD_COOLDOWN_MS,
  ALERT_DEFENSIVE_SCORE, ALERT_PUSH_SCORE, NEAR_MISS_WINDOW_MS, NEAR_MISS_RADIUS, NEAR_MISS_KIND,
  stepAttention, attentionSweep,
  ATTENTION_THREAT_MS, ATTENTION_AHEAD_MS, ATTENTION_SWEEP_MS, ATTENTION_SWEEP_RAD,
  isContact, recordContact, latestContactNear,
  CONTACT_KIND, CONTACT_WINDOW_MS, CONTACT_REPORT_INTERVAL_MS, CONTACT_MOVE_EPS, CONTACT_SHARE_RADIUS,
} from './bot-alert.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

// ---- latestAlertNear: windows, filters, freshest-wins ----
{
  const me = { id: 'b1', team: 'red', x: 0, z: 0 };
  const hit = (over = {}) => ({ victimId: 'b2', team: 'red', x: 3, z: 0, threat: { x: 20, z: 0 }, at: 1000, lethal: false, ...over });
  ok(latestAlertNear([hit()], me, 1000 + ALLY_ALERT_WINDOW_MS - 1, 12), 'fresh graze is actionable');
  ok(!latestAlertNear([hit()], me, 1000 + ALLY_ALERT_WINDOW_MS + 1, 12), 'graze expires at the short window');
  ok(latestAlertNear([hit({ lethal: true })], me, 1000 + ALLY_DEATH_WINDOW_MS - 1, 12), 'death stays actionable past the graze window');
  ok(!latestAlertNear([hit({ lethal: true })], me, 1000 + ALLY_DEATH_WINDOW_MS + 1, 12), 'death expires at the long window');
  ok(!latestAlertNear([hit({ victimId: 'b1' })], me, 1500, 12), 'own hits are not squad alerts');
  ok(!latestAlertNear([hit({ team: 'blue' })], me, 1500, 12), 'enemy hits are not squad alerts');
  ok(!latestAlertNear([hit({ x: 50 })], me, 1500, 12), 'out-of-radius hits are ignored');
  const got = latestAlertNear([hit(), hit({ at: 1200, threat: { x: 9, z: 9 } })], me, 1500, 12);
  ok(got?.at === 1200 && got.threat.x === 9, 'freshest report wins');
}

// ---- escalation scoring: same-team, in-window, in-radius reports; deaths weigh double ----
{
  const me = { x: 0, z: 0, team: 'red' };
  const hit = (over = {}) => ({ victimId: 'v', team: 'red', x: 2, z: 0, threat: { x: 9, z: 0 }, at: 1000, lethal: false, ...over });
  ok(alertWindowMs(hit()) === ALLY_ALERT_WINDOW_MS && alertWindowMs(hit({ lethal: true })) === ALLY_DEATH_WINDOW_MS,
    'alertWindowMs picks the graze vs death window');
  let esc = alertEscalation([hit()], me, 1500, 18);
  ok(esc.deaths === 0 && esc.hits === 1 && esc.score === 1, 'single graze scores 1 (wary tier)');
  esc = alertEscalation([hit(), hit({ lethal: true, at: 1200 })], me, 1500, 18);
  ok(esc.score === 3 && esc.score >= ALERT_DEFENSIVE_SCORE, 'graze + death scores 3 (defensive tier)');
  esc = alertEscalation([hit({ lethal: true }), hit({ lethal: true, at: 1100 }), hit({ at: 1200 })], me, 1500, 18);
  ok(esc.score === 5 && esc.score >= ALERT_PUSH_SCORE, 'two deaths + a graze reaches the push tier');
  ok(alertEscalation([hit({ team: 'blue' })], me, 1500, 18).score === 0, 'enemy casualties never escalate');
  ok(alertEscalation([hit({ x: 40 })], me, 1500, 18).score === 0, 'out-of-radius reports never escalate');
  esc = alertEscalation([hit(), hit({ lethal: true, at: 1010 })], me, 1000 + ALLY_ALERT_WINDOW_MS + 500, 18);
  ok(esc.hits === 0 && esc.deaths === 1, 'expired grazes drop out while the death still counts');
}

// ---- near miss: own window, inverted self-filter, zero escalation weight ----
{
  const me = { id: 'b1', team: 'red', x: 0, z: 0 };
  const miss = (over = {}) => ({ victimId: 'b1', team: 'red', x: 0, z: 0, threat: { x: 9, z: 0 }, at: 1000, lethal: false, kind: NEAR_MISS_KIND, ...over });
  ok(isNearMiss(miss()) && !isNearMiss({ lethal: false }), 'isNearMiss keys off the report kind');
  ok(alertWindowMs(miss()) === NEAR_MISS_WINDOW_MS && NEAR_MISS_WINDOW_MS < ALLY_ALERT_WINDOW_MS,
    'near misses use their own window, shorter than a graze');
  ok(latestNearMiss([miss()], me, 1000 + NEAR_MISS_WINDOW_MS - 1), 'fresh near miss is actionable');
  ok(!latestNearMiss([miss()], me, 1000 + NEAR_MISS_WINDOW_MS + 1), 'near miss expires at its own window');
  // Inverted self-filter: a near miss is firsthand-only, the mirror of the casualty rule.
  ok(!latestNearMiss([miss({ victimId: 'b2' })], me, 1500), "a teammate's near miss is not actionable for me");
  ok(!latestNearMiss([{ victimId: 'b1', team: 'red', x: 0, z: 0, threat: { x: 9, z: 0 }, at: 1000, lethal: false }], me, 1500),
    'a casualty report is never returned as a near miss');
  ok(!latestAlertNear([miss({ victimId: 'b2' })], me, 1500, 12), 'near misses never read as squad alerts');
  ok(!latestAlertNear([miss()], me, 1500, 12), 'my own near miss never reads as a squad alert either');
  const got = latestNearMiss([miss(), miss({ at: 1200, threat: { x: 4, z: 4 } })], me, 1500);
  ok(got?.at === 1200 && got.threat.x === 4, 'freshest near miss wins');
}

// ---- regression: near misses must never move the escalation tiers ----
{
  const me = { x: 0, z: 0, team: 'red' };
  const miss = (id) => ({ victimId: id, team: 'red', x: 1, z: 0, threat: { x: 9, z: 0 }, at: 1000, lethal: false, kind: NEAR_MISS_KIND });
  const hit = (over = {}) => ({ victimId: 'v', team: 'red', x: 2, z: 0, threat: { x: 9, z: 0 }, at: 1000, lethal: false, ...over });
  const many = ['a', 'b', 'c', 'd', 'e', 'f'].map(miss);
  let esc = alertEscalation(many, me, 1500, 18);
  ok(esc.score === 0 && esc.hits === 0 && esc.deaths === 0, 'a barrage of near misses scores 0');
  ok(esc.score < ALERT_DEFENSIVE_SCORE && esc.score < ALERT_PUSH_SCORE, 'near misses alone reach neither tier');
  esc = alertEscalation([...many, hit()], me, 1500, 18);
  ok(esc.score === 1 && esc.hits === 1, 'near misses do not inflate a real graze past the wary tier');
  esc = alertEscalation([...many, hit(), hit({ at: 1100 })], me, 1500, 18);
  ok(esc.score === 2 && esc.score >= ALERT_DEFENSIVE_SCORE, 'two grazes still land exactly on the defensive tier');
}

// ---- shotMissDistance: clamped point-to-segment from the shot ray ----
{
  const origin = { x: 0, y: 1, z: 0 };
  const dir = { x: 0, y: 0, z: 1 };
  ok(Math.abs(shotMissDistance(origin, dir, 20, { x: 1, y: 1, z: 10 }) - 1) < 1e-9, 'perpendicular offset is the miss distance');
  ok(Math.abs(shotMissDistance(origin, dir, 20, { x: 0, y: 1, z: 10 })) < 1e-9, 'a bot on the ray misses by 0');
  ok(Math.abs(shotMissDistance(origin, dir, 5, { x: 0, y: 1, z: 30 }) - 25) < 1e-9, 'past the travelled length clamps to the end point');
  ok(Math.abs(shotMissDistance(origin, dir, 20, { x: 0, y: 1, z: -4 }) - 4) < 1e-9, 'behind the shooter clamps to the origin');
  ok(shotMissDistance(origin, dir, 20, { x: NEAR_MISS_RADIUS + 0.01, y: 1, z: 8 }) > NEAR_MISS_RADIUS &&
    shotMissDistance(origin, dir, 20, { x: NEAR_MISS_RADIUS - 0.01, y: 1, z: 8 }) < NEAR_MISS_RADIUS,
    'the radius threshold brackets a bot standing just outside/inside the bullet path');
}

// ---- exposedToThreat on a real bake: straight hallway with one side pocket ----
{
  // 12x4m hallway; a 1.6m-tall block at x=6 leaves a concealed pocket behind it (z side).
  const bounds = { minX: 0, maxX: 12, minZ: -2, maxZ: 2 };
  const walls = [{ x: 6, z: -1, w: 1, d: 1.4, h: 1.6 }];
  const inRect = (rc, x, z) => Math.abs(x - rc.x) <= rc.w / 2 && Math.abs(z - rc.z) <= rc.d / 2;
  const navGrid = buildNavGrid((x, z) => !walls.some(rc => inRect(rc, x, z)), bounds, 0.5);
  const sight = buildSightGrid(navGrid, walls);
  const field = buildVisibilityField(navGrid, sight);
  const bake = { field, navGrid };
  const threat = { x: 0.5, z: -1 }; // shooter at the hallway mouth, block side
  ok(exposedToThreat(bake, { x: 10, z: -1.8 }, threat) === false, 'cell behind the block is concealed');
  ok(exposedToThreat(bake, { x: 3, z: 0 }, threat) === true, 'open hallway cell is exposed');
  ok(exposedToThreat(bake, { x: 999, z: 999 }, threat) === false, 'off-grid position degrades to not-exposed');
  ok(exposedToThreat(bake, { x: 3, z: 0 }, { x: -50, z: 0 }) === false, 'off-grid threat degrades to not-exposed');
  // The block cell itself is unwalkable: a verdict about it is meaningless, so the guard fails open.
  ok(navGrid.cells[cellIndexAt(navGrid, 6, -1)] !== 1, 'the block rasterizes to an unwalkable cell');
  ok(exposedToThreat(bake, { x: 6, z: -1 }, threat) === false, 'unwalkable position degrades to not-exposed');
  ok(exposedToThreat(bake, { x: 3, z: 0 }, { x: 6, z: -1 }) === false, 'unwalkable threat degrades to not-exposed');
  ok(exposedToThreat({ field: null, navGrid }, { x: 3, z: 0 }, threat) === false, 'a missing bake degrades to not-exposed');
  ok(exposedToThreat({ field, navGrid: null }, { x: 3, z: 0 }, threat) === false, 'a missing nav grid degrades to not-exposed');
  ok(exposedToThreat(bake, { x: 3, z: 0 }, null) === false, 'a missing threat position degrades to not-exposed');
}

// ---- stepAlertHold: hold, cap, cooldown, reset ----
{
  const st = { holdSince: null, cooldownUntil: null };
  ok(stepAlertHold(st, true, 0) === true && st.holdSince === 0, 'hold engages and stamps its start');
  ok(stepAlertHold(st, true, ALERT_HOLD_MAX_MS - 1) === true, 'hold persists under the cap');
  ok(stepAlertHold(st, true, ALERT_HOLD_MAX_MS) === false, 'hold releases at the cap');
  ok(st.cooldownUntil === ALERT_HOLD_MAX_MS + ALERT_HOLD_COOLDOWN_MS, 'capped episode stamps the cooldown');
  ok(stepAlertHold(st, true, ALERT_HOLD_MAX_MS + 10) === false, 'cooldown suppresses a fresh hold');
  ok(stepAlertHold(st, true, st.cooldownUntil + 1) === true, 'hold re-engages after the cooldown');
  ok(stepAlertHold(st, false, st.cooldownUntil + 2) === false && st.holdSince === null, 'dropping the want resets the episode');
  ok(stepAlertHold(st, true, st.cooldownUntil + 3) === true && st.holdSince === st.cooldownUntil + 3, 'next episode restarts its own clock');
}

// ---- latestSelfThreat: a bot must be able to read reports about ITSELF ----
{
  const me = { id: 'b1', team: 0, x: 0, z: 0 };
  const graze = { victimId: 'b1', team: 0, x: 0, z: 0, threat: { x: 5, z: 0 }, at: 1000, lethal: false };
  const miss = { victimId: 'b1', team: 0, x: 0, z: 0, threat: { x: -5, z: 0 }, at: 1200, lethal: false, kind: NEAR_MISS_KIND };
  const allyHit = { victimId: 'b2', team: 0, x: 1, z: 0, threat: { x: 9, z: 0 }, at: 1500, lethal: false };
  // The regression this exists for: latestAlertNear skips self, so a hit on me was invisible to me.
  ok(latestAlertNear([graze], me, 1100, 12) === null, 'latestAlertNear still ignores my own hit (teammates only)');
  ok(latestSelfThreat([graze], me, 1100) === graze, 'but latestSelfThreat surfaces my own hit');
  ok(latestSelfThreat([graze], me, 1000 + ALLY_ALERT_WINDOW_MS + 1) === null, 'my hit expires on the graze window');
  ok(latestSelfThreat([miss], me, 1300) === miss, 'a round that whistled past me also counts');
  ok(latestSelfThreat([miss], me, 1200 + NEAR_MISS_WINDOW_MS + 1) === null, 'near miss expires on its shorter window');
  ok(latestSelfThreat([graze, miss], me, 1300) === miss, 'freshest self report wins');
  ok(latestSelfThreat([allyHit], me, 1600) === null, 'a teammate being hit is not a self threat');
  ok(latestSelfThreat([], me, 0) === null, 'no reports, no self threat');
  // Attribution round-trip: the accessors return the record itself, so contact memory can ask a
  // report WHO did it and not merely from where. Guards against a future accessor that copies
  // fields into a fresh object and silently drops the id.
  const attributed = { ...graze, attackerId: 'e3' };
  ok(latestSelfThreat([attributed], me, 1100).attackerId === 'e3',
    'latestSelfThreat preserves attackerId: who shot me, not just the bearing');
  const attributedAlly = { ...allyHit, attackerId: 'e4' };
  ok(latestAlertNear([attributedAlly], me, 1600, 12).attackerId === 'e4',
    'latestAlertNear preserves attackerId: who is shooting my teammate');
}

// ---- stepAttention: alternating dwell, and pinning when there is nowhere to walk ----
{
  const st = { phase: null, until: 0, sweepSince: null };
  ok(stepAttention(st, true, 0) === 'threat', 'a moving bot starts on the threat bearing');
  ok(stepAttention(st, true, ATTENTION_THREAT_MS - 1) === 'threat', 'threat dwell holds for its full window');
  ok(stepAttention(st, true, ATTENTION_THREAT_MS) === 'ahead', 'dwell expiry glances down the travel heading');
  ok(stepAttention(st, true, ATTENTION_THREAT_MS + ATTENTION_AHEAD_MS - 1) === 'ahead', 'glance holds for its own window');
  ok(stepAttention(st, true, ATTENTION_THREAT_MS + ATTENTION_AHEAD_MS) === 'threat', 'glance returns to the threat');
  // The glance must outlast a 180 deg turn at TURN_RATE_RAD_S 4.5, or the bot never actually looks.
  ok(ATTENTION_AHEAD_MS >= (Math.PI / 4.5) * 1000, 'ahead glance outlasts a half turn');
}
{
  const st = { phase: null, until: 0, sweepSince: null };
  ok(stepAttention(st, true, 0) === 'threat' && stepAttention(st, true, ATTENTION_THREAT_MS) === 'ahead', 'cycle running');
  ok(stepAttention(st, false, ATTENTION_THREAT_MS + 1) === 'threat', 'a standing bot pins to the threat');
  ok(st.phase === null, 'standing still resets the dwell cycle');
  ok(stepAttention(st, true, ATTENTION_THREAT_MS + 2) === 'threat', 'moving again restarts on the threat, not mid-glance');
}

// ---- attentionSweep: bounded triangle wave, centred at the episode start ----
{
  const st = { phase: null, until: 0, sweepSince: null };
  const at = (t) => attentionSweep(st, t);
  ok(Math.abs(at(0)) < 1e-9, 'sweep starts centred on the threat bearing');
  ok(Math.abs(at(ATTENTION_SWEEP_MS * 0.25) - ATTENTION_SWEEP_RAD) < 1e-9, 'peaks left at a quarter period');
  ok(Math.abs(at(ATTENTION_SWEEP_MS * 0.5)) < 1e-9, 'recentres at the half period');
  ok(Math.abs(at(ATTENTION_SWEEP_MS * 0.75) + ATTENTION_SWEEP_RAD) < 1e-9, 'peaks right at three quarters');
  ok(Math.abs(at(ATTENTION_SWEEP_MS)) < 1e-9, 'wraps back to centre after a full period');
  let bounded = true;
  for (let t = 0; t <= ATTENTION_SWEEP_MS * 3; t += 17) if (Math.abs(at(t)) > ATTENTION_SWEEP_RAD + 1e-9) bounded = false;
  ok(bounded, 'sweep never exceeds its amplitude across three periods');
  ok(st.sweepSince === 0, 'sweep anchors to the first sample, so a fresh hold starts centred');
}

// ---- alertTierChannels: the tier -> report routing table ----
{
  const report = { threat: { x: 5, z: 5 }, at: 1000 };
  const t = (tier) => alertTierChannels(tier, report);
  ok(t(null).coverAlert === null && t(null).holdAlert === null, 'no tier routes nothing');
  ok(t('wary').coverAlert === null && t('wary').holdAlert === report, 'wary flinch-holds but takes no cover rung');
  ok(t('defensive').coverAlert === report && t('defensive').holdAlert === report, 'defensive arms cover and hold');
  ok(t('push').coverAlert === report && t('push').holdAlert === null, 'push arms cover but never holds');
  const into = { coverAlert: 'stale', holdAlert: 'stale' };
  ok(alertTierChannels(null, report, into) === into && into.coverAlert === null && into.holdAlert === null,
    'out-param is returned and fully overwritten');
}

// ---- contact reports: publish/refresh semantics on the shared ring ----
{
  const r1 = { id: 'b1', team: 'red', x: 0, z: 0 };
  const hits = [];
  const rec = recordContact(hits, r1, { x: 10, z: 0 }, 1000);
  ok(hits.length === 1 && hits[0] === rec, 'a first sighting pushes one record');
  ok(rec.kind === CONTACT_KIND && rec.victimId === 'b1' && rec.team === 'red' && rec.lethal === false,
    'the record is ring-shaped: kind/victimId=reporter/team/lethal false');
  ok(rec.x === 0 && rec.z === 0 && rec.threat.x === 10 && rec.threat.z === 0 && rec.at === 1000,
    'x/z carry the reporter, threat carries the sighting');
  ok(isContact(rec) && !isContact({ lethal: false }) && !isNearMiss(rec), 'isContact keys off the report kind and is disjoint from near miss');
  ok(alertWindowMs(rec) === CONTACT_WINDOW_MS && CONTACT_WINDOW_MS > CONTACT_REPORT_INTERVAL_MS,
    'contacts get their own window, longer than the report interval so a live contact never lapses');
  // Rate limit: inside the interval and a barely-moved threat refreshes freshness, not content.
  r1.x = 5; r1.z = 5;
  const same = recordContact(hits, r1, { x: 10 + CONTACT_MOVE_EPS - 0.01, z: 0 }, 1500);
  ok(hits.length === 1 && same === rec, 'a repeat sighting refreshes in place, never a second record');
  ok(rec.at === 1500 && rec.updatedAt === 1000, 'rate-limited call bumps `at` only');
  ok(rec.threat.x === 10 && rec.x === 0, 'rate-limited call leaves the reported positions alone');
  // Past the interval: full content rewrite.
  recordContact(hits, r1, { x: 11, z: 1 }, 1000 + CONTACT_REPORT_INTERVAL_MS);
  ok(rec.updatedAt === 1000 + CONTACT_REPORT_INTERVAL_MS && rec.threat.x === 11 && rec.threat.z === 1 && rec.x === 5 && rec.z === 5,
    'past the interval the record rewrites reporter + threat position');
  // A big threat jump beats the rate limit: stale bearings are worse than an extra write.
  recordContact(hits, r1, { x: 11 + CONTACT_MOVE_EPS, z: 1 }, 1000 + CONTACT_REPORT_INTERVAL_MS + 1);
  ok(rec.threat.x === 11 + CONTACT_MOVE_EPS && rec.updatedAt === 1000 + CONTACT_REPORT_INTERVAL_MS + 1,
    'a threat that moved CONTACT_MOVE_EPS re-reports immediately');
  // Attribution: a call-out names WHO was seen, and re-naming survives the content rewrite so a
  // reporter that swings onto a second enemy does not leave the first one's id attached.
  const idHits = [];
  const idRec = recordContact(idHits, r1, { x: 10, z: 0 }, 5000, null, 'e7');
  ok(idRec.threatId === 'e7', 'a contact report carries the id of the enemy that was seen');
  recordContact(idHits, r1, { x: 30, z: 30 }, 5000 + CONTACT_REPORT_INTERVAL_MS + 1, null, 'e9');
  ok(idRec.threatId === 'e9', 'a content rewrite re-attributes the sighting');
  ok(recordContact([], r1, { x: 1, z: 1 }, 1).threatId === null,
    'threatId defaults to null, so pre-attribution callers still produce well-formed records');
  // Full-auto spam: one record, and a bounded number of content writes.
  const spam = [];
  const shooter = { id: 'b9', team: 'red', x: 0, z: 0 };
  let writes = 0, prevUpdated = -1;
  for (let t = 0; t <= 5000; t += 16) {
    const r = recordContact(spam, shooter, { x: 10 + t * 0.0001, z: 0 }, t);
    if (r.updatedAt !== prevUpdated) { writes++; prevUpdated = r.updatedAt; }
  }
  ok(spam.length === 1, '300+ ticks of sighting produce exactly one ring record');
  ok(writes <= Math.ceil(5000 / CONTACT_REPORT_INTERVAL_MS) + 1, 'content writes stay at the rate limit');
  ok(spam[0].at === 4992, 'the record stays fresh at the last tick, so it never lapses mid-burst');
  // The push hook is what keeps the ring bounded; it must be used for new records only.
  const ring = [];
  let pushed = 0;
  const push = (rec2) => { pushed++; ring.push(rec2); };
  recordContact(ring, { id: 'b2', team: 'red', x: 1, z: 1 }, { x: 4, z: 4 }, 100, push);
  recordContact(ring, { id: 'b2', team: 'red', x: 1, z: 1 }, { x: 4, z: 4 }, 9000, push);
  ok(pushed === 1 && ring.length === 1, 'the bounded push runs once per reporter, refresh reuses the slot');
}

// ---- contact exclusions: contacts are not casualties, not near misses, not self threats ----
{
  const me = { id: 'b1', team: 'red', x: 0, z: 0 };
  const hits = [];
  recordContact(hits, { id: 'b2', team: 'red', x: 2, z: 0 }, { x: 20, z: 0 }, 1000);
  recordContact(hits, me, { x: 20, z: 0 }, 1000); // my own call-out
  ok(latestAlertNear(hits, me, 1100, 12) === null, "a teammate's contact never reads as a casualty alert");
  ok(alertEscalation(hits, { x: 0, z: 0, team: 'red' }, 1100, 18).score === 0, 'contacts never move the escalation tiers');
  ok(latestSelfThreat(hits, me, 1100) === null, 'my own contact report is not me being shot at');
  ok(latestNearMiss(hits, me, 1100) === null, 'a contact is never returned as a near miss');
  // ...and the casualty machinery still works with contacts sharing the ring.
  const graze = { victimId: 'b3', team: 'red', x: 1, z: 0, threat: { x: 9, z: 0 }, at: 1000, lethal: false };
  hits.push(graze);
  ok(latestAlertNear(hits, me, 1100, 12) === graze, 'the casualty report is still found alongside contacts');
  ok(alertEscalation(hits, { x: 0, z: 0, team: 'red' }, 1100, 18).score === 1, 'the graze scores 1 and the contacts add nothing');
}

// ---- latestContactNear: same team, in radius, not mine, freshest wins ----
{
  const me = { id: 'b1', team: 'red', x: 0, z: 0 };
  const contact = (over = {}) => ({ kind: CONTACT_KIND, victimId: 'b2', team: 'red', x: 3, z: 0,
    threat: { x: 20, z: 0 }, at: 1000, updatedAt: 1000, lethal: false, ...over });
  ok(latestContactNear([contact()], me, 1000 + CONTACT_WINDOW_MS - 1, 12), 'a fresh contact is actionable');
  ok(!latestContactNear([contact()], me, 1000 + CONTACT_WINDOW_MS + 1, 12), 'a contact expires at its own window');
  ok(!latestContactNear([contact({ victimId: 'b1' })], me, 1500, 12), 'my own call-out is not news to me');
  ok(!latestContactNear([contact({ team: 'blue' })], me, 1500, 12), 'enemy call-outs are never heard');
  ok(!latestContactNear([contact({ x: 40 })], me, 1500, 12), 'a reporter out of call-out range is ignored');
  ok(latestContactNear([contact({ x: 0, z: 11.9 })], me, 1500, 12), 'radius measures to the reporter, not the threat');
  ok(!!latestContactNear([contact({ threat: { x: 999, z: 999 } })], me, 1500, 12),
    'a far-off threat is still reportable (only the reporter must be in range)');
  const got = latestContactNear([contact(), contact({ victimId: 'b3', at: 1200, threat: { x: 9, z: 9 } })], me, 1500, 12);
  ok(got?.at === 1200 && got.threat.x === 9, 'freshest contact wins');
  // Casualty/near-miss reports must never leak out of this query.
  const graze = { victimId: 'b2', team: 'red', x: 3, z: 0, threat: { x: 9, z: 0 }, at: 1400, lethal: false };
  const miss = { victimId: 'b2', team: 'red', x: 3, z: 0, threat: { x: 9, z: 0 }, at: 1400, lethal: false, kind: NEAR_MISS_KIND };
  ok(latestContactNear([graze, miss], me, 1500, 12) === null, 'only contact-kind reports answer latestContactNear');
  ok(CONTACT_SHARE_RADIUS > 0, 'a default call-out radius is exported for the harness');
}

// ---- regression: non-contact kinds behave exactly as before contacts existed ----
{
  const me = { id: 'b1', team: 'red', x: 0, z: 0 };
  const hit = (over = {}) => ({ victimId: 'b2', team: 'red', x: 3, z: 0, threat: { x: 20, z: 0 }, at: 1000, lethal: false, ...over });
  const miss = (over = {}) => ({ victimId: 'b1', team: 'red', x: 0, z: 0, threat: { x: 9, z: 0 }, at: 1000, lethal: false, kind: NEAR_MISS_KIND, ...over });
  ok(alertWindowMs(hit()) === ALLY_ALERT_WINDOW_MS, 'graze window unchanged');
  ok(alertWindowMs(hit({ lethal: true })) === ALLY_DEATH_WINDOW_MS, 'death window unchanged');
  ok(alertWindowMs(miss()) === NEAR_MISS_WINDOW_MS, 'near-miss window unchanged');
  ok(latestAlertNear([hit()], me, 1500, 12)?.at === 1000, 'latestAlertNear still returns teammate casualties');
  ok(latestNearMiss([miss()], me, 1500)?.at === 1000, 'latestNearMiss still returns my own near miss');
  ok(latestSelfThreat([miss()], me, 1500)?.at === 1000, 'latestSelfThreat still returns my own near miss');
  ok(latestSelfThreat([hit({ victimId: 'b1' })], me, 1500)?.at === 1000, 'latestSelfThreat still returns my own graze');
  const esc = alertEscalation([hit(), hit({ lethal: true, at: 1100 }), miss()], { x: 0, z: 0, team: 'red' }, 1500, 18);
  ok(esc.deaths === 1 && esc.hits === 1 && esc.score === 3, 'escalation scoring unchanged (near miss still weighs 0)');
}

// ---- wave 4: patrol scan (A4), sweep phase offsets (A5/S7), tier perception (A6) ----
// Own import block so this section stays independent of the header's import list.
import {
  patrolScanOffset, sweepPhaseMs, perceptionForTier,
  PATROL_SCAN_RAD, PATROL_SCAN_MS,
  TIER_FOV_WARY, TIER_FOV_ALERTED, TIER_STRIDE_WARY, TIER_STRIDE_ALERTED,
} from './bot-alert.js';

// ---- patrolScanOffset: bounded triangle wave on the travel heading ----
{
  const st = { sweepSince: null };
  const at = (t) => patrolScanOffset(st, 0, t);
  ok(Math.abs(at(0)) < 1e-9, 'scan starts centred on the travel heading');
  ok(st.sweepSince === 0, 'scan anchors to its first sample');
  ok(Math.abs(at(PATROL_SCAN_MS * 0.25) - PATROL_SCAN_RAD) < 1e-9, 'peaks left at a quarter period');
  ok(Math.abs(at(PATROL_SCAN_MS * 0.5)) < 1e-9, 'recentres at the half period');
  ok(Math.abs(at(PATROL_SCAN_MS * 0.75) + PATROL_SCAN_RAD) < 1e-9, 'peaks right at three quarters');
  ok(Math.abs(at(PATROL_SCAN_MS)) < 1e-9, 'wraps back to centre after a full period');
  let bounded = true;
  for (let t = 0; t <= PATROL_SCAN_MS * 3; t += 17) if (Math.abs(at(t)) > PATROL_SCAN_RAD + 1e-9) bounded = false;
  ok(bounded, 'scan never exceeds its amplitude across three periods');
  // A patroller glances, it does not whip its head: gentler and slower than the standing sweep.
  ok(PATROL_SCAN_RAD < ATTENTION_SWEEP_RAD && PATROL_SCAN_MS > ATTENTION_SWEEP_MS,
    'patrol scan is smaller-amplitude and slower than the standing sweep');
  // The yaw slew (TURN_RATE_RAD_S 4.5) must be able to track the wave, or the offset never lands.
  ok((4 * PATROL_SCAN_RAD) / (PATROL_SCAN_MS / 1000) < 4.5, 'peak scan rate stays inside the turn rate');
  // A4 is only fixed if the swept arc actually clears the default 120 deg cone's blind sector.
  ok(PATROL_SCAN_RAD * 2 > 0.5, 'the swept arc widens the effective cone by ~33 deg');
}
{
  // Determinism + per-bot phase: same seed replays exactly, different seeds sit on different bearings.
  const a1 = { sweepSince: null }, a2 = { sweepSince: null }, b = { sweepSince: null };
  const sample = (st, seed) => [0, 400, 900, 1700, 2600, 3300].map(t => patrolScanOffset(st, seed, t));
  const s1 = sample(a1, 3), s2 = sample(a2, 3), sb = sample(b, 4);
  ok(s1.every((v, i) => Math.abs(v - s2[i]) < 1e-12), 'same seed is deterministic across fresh states');
  ok(s1.some((v, i) => Math.abs(v - sb[i]) > 1e-6), 'a different seed rides a different phase');
  // The A5 failure: eight bots spawned together must not share one bearing at t=0.
  const spawn = Array.from({ length: 8 }, (_, i) => patrolScanOffset({ sweepSince: null }, i, 0));
  ok(new Set(spawn.map(v => v.toFixed(6))).size === 8, 'eight co-spawned bots start on eight distinct scan bearings');
  ok(Math.abs(patrolScanOffset({ sweepSince: null }, undefined, 0)) < 1e-9, 'a missing seed degrades to phase 0');
  // A clock that steps backwards (rebind/reset) must stay inside the amplitude, not flip sign wildly.
  const back = { sweepSince: 5000 };
  ok(Math.abs(patrolScanOffset(back, 2, 1000)) <= PATROL_SCAN_RAD + 1e-9, 'a backwards clock stays bounded');
}

// ---- sweepPhaseMs: bounds, determinism, spread over a spawn batch ----
{
  const seeds = [0, 1, 2, 3, 4, 5, 6, 7];
  const phases = seeds.map(sweepPhaseMs);
  ok(phases.every(p => p >= 0 && p < ATTENTION_SWEEP_MS), 'every phase lands inside one sweep period');
  ok(phases.every((p, i) => p === sweepPhaseMs(seeds[i])), 'phases are deterministic per seed');
  ok(new Set(phases).size === 8, 'eight seeds give eight distinct phases');
  // Distribution: the whole point is that no two bots share a blind arc, so the worst gap in the
  // ring must stay well under a uniform quarter-period (a naive seed%4 would leave 3 empty quarters).
  const sorted = [...phases].sort((a, b) => a - b);
  let maxGap = ATTENTION_SWEEP_MS - sorted[sorted.length - 1] + sorted[0];
  for (let i = 1; i < sorted.length; i++) maxGap = Math.max(maxGap, sorted[i] - sorted[i - 1]);
  ok(maxGap < ATTENTION_SWEEP_MS * 0.25, 'phases cover the period with no quarter-period hole');
  ok(sweepPhaseMs(0) === 0 && sweepPhaseMs(null) === 0 && sweepPhaseMs(NaN) === 0, 'a missing seed degrades to phase 0');
  // Contract: sweepSince -= sweepPhaseMs(seed) must land the sweep somewhere legal in the wave.
  const st = { sweepSince: 1000 - sweepPhaseMs(5) };
  ok(Math.abs(attentionSweep(st, 1000)) <= ATTENTION_SWEEP_RAD + 1e-9, 'an offset sweepSince still yields a bounded sweep');
  const st2 = { sweepSince: 1000 - sweepPhaseMs(6) };
  ok(Math.abs(attentionSweep(st, 1000) - attentionSweep(st2, 1000)) > 1e-6, 'two offset bots sweep different bearings at the same instant');
}

// ---- perceptionForTier: the tier -> perception table (A6) ----
{
  const p = (tier) => perceptionForTier(tier);
  ok(p(null).fovDegrees === null && p(null).scanStride === null, 'no tier defers to the harness defaults');
  ok(p('none').fovDegrees === null && p(undefined).scanStride === null, 'an unknown tier also defers to the defaults');
  ok(p('wary').fovDegrees === TIER_FOV_WARY && p('wary').scanStride === TIER_STRIDE_WARY, 'wary gets a modest bump');
  ok(p('defensive').fovDegrees === TIER_FOV_ALERTED && p('defensive').scanStride === TIER_STRIDE_ALERTED, 'defensive widens and re-scans faster');
  ok(p('push').fovDegrees === TIER_FOV_ALERTED && p('push').scanStride === TIER_STRIDE_ALERTED, 'push perceives like defensive');
  // Monotone by threat level, and strictly wider/faster than the shipped defaults or A6 is unfixed.
  ok(TIER_FOV_WARY < TIER_FOV_ALERTED && TIER_STRIDE_WARY > TIER_STRIDE_ALERTED, 'perception sharpens with the tier');
  ok(TIER_FOV_WARY > 120 && TIER_STRIDE_ALERTED === 2, 'tiers beat the 120 deg cone and halve the 4-frame stride');
  ok(TIER_STRIDE_ALERTED >= 1 && Number.isInteger(TIER_STRIDE_ALERTED) && Number.isInteger(TIER_STRIDE_WARY), 'strides are usable frame moduli');
  // max(slider, tier) composition: a wide slider must never be narrowed by a tier.
  const compose = (slider, tier) => Math.max(slider, perceptionForTier(tier).fovDegrees ?? slider);
  ok(compose(120, null) === 120 && compose(120, 'push') === TIER_FOV_ALERTED && compose(360, 'push') === 360,
    'max(slider, tier) widens the default cone and never narrows a 360 deg one');
  // Alloc-free reuse: the out-param is returned and every field overwritten, including back to null.
  const into = { fovDegrees: 999, scanStride: 99 };
  ok(perceptionForTier('push', into) === into && into.fovDegrees === TIER_FOV_ALERTED, 'out-param is returned and filled');
  ok(perceptionForTier(null, into) === into && into.fovDegrees === null && into.scanStride === null, 'a stale out-param is cleared, not left armed');
}

if (failed) { console.error(`test-bot-alert: ${failed} failure(s)`); process.exit(1); }
console.log('test-bot-alert: all passing');
