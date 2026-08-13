// bot-alert.js — pure, THREE-free squad-alert math: ally-hit reports, exposure bit tests, and
// the alert-hold stepper that stops a concealed bot from patrolling into a fresh kill zone.
// Node-tested in test-bot-alert.mjs; consumed by bot-viewer.html's sentry wiring.

import { cellIndexAt } from './nav-visibility.js';

export const ALLY_ALERT_WINDOW_MS = 3000;   // a non-lethal hit report stays actionable this long
export const ALLY_DEATH_WINDOW_MS = 8000;   // an ally death nearby stays actionable much longer
export const ALERT_HOLD_MAX_MS = 20000;     // freeze backstop; alert windows expire on their own first
export const ALERT_HOLD_COOLDOWN_MS = 4000; // suppression after a capped episode, so bots never freeze

// ---- near miss (shot at, not hit) ----
export const NEAR_MISS_RADIUS = 1.5;      // m, an enemy bullet passing this close counts as being shot at
export const NEAR_MISS_WINDOW_MS = 1500;  // weakest evidence: half the graze window, one wary-pause long
export const NEAR_MISS_KIND = 'nearmiss';

// ---- contact report (saw an enemy, nobody hit yet) ----
export const CONTACT_KIND = 'contact';
export const CONTACT_WINDOW_MS = 4000;          // a sighting call-out stays actionable this long
export const CONTACT_REPORT_INTERVAL_MS = 1000; // max content-update rate per reporter (full-auto guard)
export const CONTACT_MOVE_EPS = 1.5;            // m the threat must move to earn an early re-report
export const CONTACT_SHARE_RADIUS = 18;         // m, default call-out range (caller may pass its own)

// A near-miss report is not a casualty: it never escalates and never counts as a squad alert.
export function isNearMiss(rep) { return rep.kind === NEAR_MISS_KIND; }
// Nor is a sighting: nobody has been shot, so it feeds latestContactNear and nothing else.
export function isContact(rep) { return rep.kind === CONTACT_KIND; }

// Actionable lifetime of one report: deaths stay actionable much longer than grazes.
export function alertWindowMs(rep) {
  if (isContact(rep)) return CONTACT_WINDOW_MS;
  if (isNearMiss(rep)) return NEAR_MISS_WINDOW_MS;
  return rep.lethal ? ALLY_DEATH_WINDOW_MS : ALLY_ALERT_WINDOW_MS;
}

// Publish/refresh `reporter`'s ({id, team, x, z}) sighting of a threat ({x, z}) on the shared ring.
// Exactly one contact record per reporter ever exists in `hits`: a repeat sighting rewrites that
// record in place, so a full-auto bot cannot flood the 64-slot ring. `at` is bumped every call
// (the bot IS still looking at the enemy), but the position content is rewritten at most once per
// CONTACT_REPORT_INTERVAL_MS unless the threat moved CONTACT_MOVE_EPS. `push` is the ring's own
// bounded push (the harness's pushAllyReport); it is only used for a reporter's first record.
// `threatId` (optional) names WHO was seen, so a call-out seeds a receiver's contact memory with an
// identity rather than an anonymous position. Rate-limiting still keys on the reporter, not the
// threat: one bot spamming sightings of two enemies is still one bot talking.
export function recordContact(hits, reporter, threatXZ, now, push, threatId = null) {
  let prior = null;
  for (const rep of hits) if (isContact(rep) && rep.victimId === reporter.id) { prior = rep; break; }
  if (prior) {
    const moved = Math.hypot(threatXZ.x - prior.threat.x, threatXZ.z - prior.threat.z);
    prior.at = now;
    if (now - prior.updatedAt < CONTACT_REPORT_INTERVAL_MS && moved < CONTACT_MOVE_EPS) return prior;
    prior.team = reporter.team; prior.x = reporter.x; prior.z = reporter.z;
    prior.threat.x = threatXZ.x; prior.threat.z = threatXZ.z;
    prior.threatId = threatId;
    prior.updatedAt = now;
    return prior;
  }
  const rec = { kind: CONTACT_KIND, victimId: reporter.id, team: reporter.team,
    x: reporter.x, z: reporter.z, threat: { x: threatXZ.x, z: threatXZ.z }, threatId,
    at: now, updatedAt: now, lethal: false };
  if (push) push(rec); else hits.push(rec);
  return rec;
}

// Freshest in-window SAME-TEAM sighting reported by someone else within `radius` of `me`
// ({id, team, x, z}) — the squad's "contact, north hallway". Radius is measured to the REPORTER
// (call-out range), not to the threat, exactly like latestAlertNear.
export function latestContactNear(hits, me, now, radius) {
  let best = null;
  for (const rep of hits) {
    if (!isContact(rep) || rep.victimId === me.id || rep.team !== me.team) continue;
    if (now - rep.at > CONTACT_WINDOW_MS) continue;
    if (Math.hypot(rep.x - me.x, rep.z - me.z) > radius) continue;
    if (!best || rep.at > best.at) best = rep;
  }
  return best;
}

// Freshest actionable CASUALTY report near `me` ({id, team, x, z}); deaths use the longer window.
export function latestAlertNear(hits, me, now, radius) {
  let best = null;
  for (const hit of hits) {
    if (isNearMiss(hit) || isContact(hit)) continue; // neither is a casualty: cover/hold stay damage-driven
    if (now - hit.at > alertWindowMs(hit) || hit.victimId === me.id || hit.team !== me.team) continue;
    if (Math.hypot(hit.x - me.x, hit.z - me.z) > radius) continue;
    if (!best || hit.at > best.at) best = hit;
  }
  return best;
}

// Freshest in-window near miss on `me` ({id}) — the inverse self-filter: a bullet whistling past
// is only perceivable by the bot it passed, so no radius and no teammate lookup.
export function latestNearMiss(hits, me, now) {
  let best = null;
  for (const rep of hits) {
    if (!isNearMiss(rep) || rep.victimId !== me.id || now - rep.at > NEAR_MISS_WINDOW_MS) continue;
    if (!best || rep.at > best.at) best = rep;
  }
  return best;
}

// Freshest in-window report about ME: my own graze/death report, or a round that whistled past.
// latestAlertNear deliberately skips self (it answers "was a TEAMMATE hit"), so without this a bot
// that is actually shot learns no bearing at all — only near misses ever reached their own victim.
export function latestSelfThreat(hits, me, now) {
  let best = null;
  for (const rep of hits) {
    if (isContact(rep)) continue; // my own sighting is not me being shot at
    if (rep.victimId !== me.id || now - rep.at > alertWindowMs(rep)) continue;
    if (!best || rep.at > best.at) best = rep;
  }
  return best;
}

// Distance from `p` to the shot segment origin -> origin + dir*len (`dir` unit, `len` = travelled).
export function shotMissDistance(origin, dir, len, p) {
  const ox = p.x - origin.x, oy = p.y - origin.y, oz = p.z - origin.z;
  const t = Math.min(Math.max(ox * dir.x + oy * dir.y + oz * dir.z, 0), len);
  return Math.hypot(ox - dir.x * t, oy - dir.y * t, oz - dir.z * t);
}

// ---- semi-alert (secondhand) tiering ----
export const SEMI_ALERT_SHARE_RADIUS = 6; // m, semi-alert spreads from an alerted teammate within this
export const ESCALATION_RADIUS = 18;      // m, same-team casualty reports around me that count toward escalation
export const SEMI_ALERT_WARY_MS = 1500;   // brief heads-up pause at the lowest escalation tier
export const ALERT_DEFENSIVE_SCORE = 2;   // escalation score from which a semi-alert acts like a firsthand one
export const ALERT_PUSH_SCORE = 4;        // score from which a backed group advances on the reported threat
export const SUPPORT_GROUP_MIN = 3;       // living teammates (incl. self) required nearby to push
export const SUPPORT_RADIUS = 10;         // m, radius that support group is counted in

// Score-only approximation of updateBotSentry's real tier ladder, for callers that need a tier
// from a FRESH alertEscalation() call outside the sentry tick (see bot-voice-intensity.js). The
// real ladder also gates 'push' on a living-teammate support count and 'wary' on a per-bot
// alertWarySince timestamp that only exists on the sentry-tick actor -- neither is reconstructible
// from a bare score, and neither matters for voice delivery: whether a bot has enough backup to
// physically push on a threat is a BEHAVIOR question, not a "how urgent should this sound" one.
// Deliberately NOT the same function the sentry tick uses -- this is a documented simplification,
// not a shared implementation, because the real ladder's extra inputs don't apply here.
export function tierForScore(score) {
  if (score >= ALERT_PUSH_SCORE) return 'push';
  if (score >= ALERT_DEFENSIVE_SCORE) return 'defensive';
  if (score > 0) return 'wary';
  return null;
}

// Local escalation: in-window reports whose same-team victim fell within `radius` of `me`
// ({x, z, team}). Deaths weigh double; successive reports stack (a prolonged fight scores high).
// Near misses and contacts weigh 0 — nobody was hit, so the tiers keep meaning casualties.
export function alertEscalation(hits, me, now, radius) {
  let deaths = 0, nHits = 0;
  for (const hit of hits) {
    if (isNearMiss(hit) || isContact(hit)) continue;
    if (hit.team !== me.team || now - hit.at > alertWindowMs(hit)) continue;
    if (Math.hypot(hit.x - me.x, hit.z - me.z) > radius) continue;
    if (hit.lethal) deaths++; else nHits++;
  }
  return { deaths, hits: nHits, score: nHits + 2 * deaths };
}

// Report routing per escalation tier: both armed tiers arm the cover rung; wary flinch-holds
// on the report; push advances and never holds (it still holds on its own self-threat).
export function alertTierChannels(tier, report, into = {}) {
  into.coverAlert = (tier === 'defensive' || tier === 'push') ? report : null;
  into.holdAlert = tier === 'wary' ? report : (tier === 'push' ? null : into.coverAlert);
  return into;
}

// Baked-field exposure: can the reported threat see `pos`? Fails open to false ("not confidently
// exposed", so callers keep their pre-gate behavior) unless both points quantize to walkable cells.
export function exposedToThreat({ field, navGrid }, pos, threatPos) {
  if (!field || !navGrid || !pos || !threatPos) return false;
  const threatCell = cellIndexAt(navGrid, threatPos.x, threatPos.z);
  const posCell = cellIndexAt(navGrid, pos.x, pos.z);
  if (threatCell === -1 || posCell === -1) return false;
  if (navGrid.cells[threatCell] !== 1 || navGrid.cells[posCell] !== 1) return false;
  return field.canSee(threatCell, posCell) === true;
}

// Hold stepper (mutates st = {holdSince, cooldownUntil}). Returns true while the bot should
// stand at its concealed spot facing the threat; a capped episode stamps a cooldown so a
// persistent shooter can't pin a bot in place forever.
export function stepAlertHold(st, wantHold, now) {
  if (!wantHold) { st.holdSince = null; return false; }
  if (st.cooldownUntil != null && now < st.cooldownUntil) { st.holdSince = null; return false; }
  if (st.holdSince == null) st.holdSince = now;
  if (now - st.holdSince >= ALERT_HOLD_MAX_MS) {
    st.holdSince = null;
    st.cooldownUntil = now + ALERT_HOLD_COOLDOWN_MS;
    return false;
  }
  return true;
}

// ---- split attention ----
// Perception is gated by the body's yaw cone, so a bot that holds one bearing is blind everywhere
// else. These split the dwell between the reported threat and wherever the bot is actually going.
export const ATTENTION_THREAT_MS = 1200; // dwell holding the threat bearing
export const ATTENTION_AHEAD_MS = 800;   // glance down the travel heading (>= a 180 deg turn at 4.5 rad/s)
export const ATTENTION_SWEEP_MS = 2800;  // period of the standing left-right sweep
export const ATTENTION_SWEEP_RAD = 0.95; // ~54 deg amplitude: the swept arc adds about one cone width

// Alternating dwell (mutates st). 'ahead' = look where you are walking, 'threat' = back on the
// reported bearing. With no travel heading it pins to the threat and resets the cycle.
export function stepAttention(st, canLookAhead, now) {
  if (!canLookAhead) { st.phase = null; st.until = 0; return 'threat'; }
  if (st.phase == null) { st.phase = 'threat'; st.until = now + ATTENTION_THREAT_MS; }
  else if (now >= st.until) {
    st.phase = st.phase === 'threat' ? 'ahead' : 'threat';
    st.until = now + (st.phase === 'threat' ? ATTENTION_THREAT_MS : ATTENTION_AHEAD_MS);
  }
  return st.phase;
}

// Triangle-wave yaw offset (rad) for a standing bot: moves the blind arc rather than pinning it.
export function attentionSweep(st, now) {
  st.sweepSince ??= now;
  const t = ((now - st.sweepSince) % ATTENTION_SWEEP_MS) / ATTENTION_SWEEP_MS;
  const tri = t < 0.25 ? t * 4 : t < 0.75 ? 2 - t * 4 : t * 4 - 4;
  return tri * ATTENTION_SWEEP_RAD;
}

// ---- wave 4: patrol scan + tier perception ----
// A4: a patroller's yaw is welded to its velocity, so its 120 deg cone leaves a permanent 240 deg
// blind arc — you can follow one at 3 m forever. A5/S7: sweeps seeded off `now` put a co-located
// group on the same blind bearing at the same instant. A6: alert tiers move markers, cover and
// holds but never perception, so a bot that watched a squadmate die scans like an oblivious one.

export const PATROL_SCAN_RAD = 0.5;   // ~29 deg each way: half the standing sweep, enough to break the blind arc
export const PATROL_SCAN_MS = 3600;   // slower than the standing sweep; peak 0.55 rad/s, well under TURN_RATE_RAD_S 4.5

export const TIER_FOV_WARY = 140;     // heads-up: a bit wider than the 120 deg default cone
export const TIER_FOV_ALERTED = 160;  // defensive/push: nearly a hemisphere, still short of omniscient
export const TIER_STRIDE_WARY = 3;    // re-scan candidates a little more often than the default 4
export const TIER_STRIDE_ALERTED = 2; // halved: an alerted bot acquires in ~2 frames, not ~4

const PHASE_GOLDEN = 0.6180339887498949; // low-discrepancy multiplier: consecutive spawn seeds land far apart

// Deterministic phase fraction in [0, 1) for a bot seed (harness passes botSeedFromId(bot.id)).
function phaseFraction(seed) {
  const s = Number(seed);
  const x = (Number.isFinite(s) ? s : 0) * PHASE_GOLDEN;
  return x - Math.floor(x);
}

// Same wave shape attentionSweep uses, kept separate so that function stays untouched.
function triangleWave(t) { return t < 0.25 ? t * 4 : t < 0.75 ? 2 - t * 4 : t * 4 - 4; }

// A5/S7: per-bot offset into the standing sweep. The harness subtracts it from `sweepSince` when it
// creates/resets the attention state; attentionSweep itself is unchanged.
export function sweepPhaseMs(seed) { return phaseFraction(seed) * ATTENTION_SWEEP_MS; }

// A4: yaw offset (rad) to ADD to a moving bot's travel heading so it glances off-axis while walking.
// `st` is its own {sweepSince} state, NOT the attention state (that one is nulled every moving frame).
export function patrolScanOffset(st, seed, now) {
  st.sweepSince ??= now;
  let t = ((now - st.sweepSince) / PATROL_SCAN_MS + phaseFraction(seed)) % 1;
  if (t < 0) t += 1; // a clock that ran backwards must not flip the wave
  return triangleWave(t) * PATROL_SCAN_RAD;
}

// A6: the perceptual half of an alert tier, alloc-free via `into`. null fields mean "keep the
// defaults" (the harness slider / TARGET_SCAN_STRIDE), so a tier can never narrow a bot's cone:
// compose as fovDegrees = max(botBehaviorSettings.fovDegrees, tier.fovDegrees) and
// scanStride = min(TARGET_SCAN_STRIDE, tier.scanStride).
export function perceptionForTier(tier, into = {}) {
  if (tier === 'wary') { into.fovDegrees = TIER_FOV_WARY; into.scanStride = TIER_STRIDE_WARY; }
  else if (tier === 'defensive' || tier === 'push') { into.fovDegrees = TIER_FOV_ALERTED; into.scanStride = TIER_STRIDE_ALERTED; }
  else { into.fovDegrees = null; into.scanStride = null; }
  return into;
}
