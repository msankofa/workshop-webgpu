// bot-voice-intensity.js: tier-to-target mapping, alert-line floor, and the reduced tierForScore
// ladder in bot-alert.js it is fed from. This covers what a Node test actually CAN prove: that
// resolveVoiceIntensity is correct given its inputs. It cannot prove the viewer's frame loop
// delivers the right inputs at the right time -- the frame-order fix (event-triggered lines calling
// tierForScore(alertEscalation(...)) fresh instead of reading a stale cached tier) is a code-review
// check against the line numbers recorded in docs/superpowers/plans/2026-08-03-bot-voice-intensity-
// plan.md Chapter 5, not something this suite exercises.

import { resolveVoiceIntensity } from './bot-voice-intensity.js';
import { tierForScore, ALERT_DEFENSIVE_SCORE, ALERT_PUSH_SCORE } from './bot-alert.js';
import { SOUND_PARAMS } from './sound-params.js';

let failures = 0;
function ok(cond, label) {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}`); }
}

console.log('tierForScore');
ok(tierForScore(0) === null, 'score 0 is calm (null)');
ok(tierForScore(1) === 'wary', 'a positive score below the defensive threshold is wary');
ok(tierForScore(ALERT_DEFENSIVE_SCORE) === 'defensive', 'the defensive threshold itself is defensive');
ok(tierForScore(ALERT_DEFENSIVE_SCORE - 1) === 'wary', 'just under the defensive threshold is still wary');
ok(tierForScore(ALERT_PUSH_SCORE) === 'push', 'the push threshold itself is push');
ok(tierForScore(ALERT_PUSH_SCORE - 1) === 'defensive', 'just under the push threshold is still defensive');

console.log('resolveVoiceIntensity: tier -> target');
const p = SOUND_PARAMS.voiceIntensity;
ok(resolveVoiceIntensity({ lineId: 'firing', alertTier: null }) === p.anchorCalm, 'null tier resolves to the calm anchor');
ok(resolveVoiceIntensity({ lineId: 'firing', alertTier: 'wary' }) === p.anchorWary, 'wary tier resolves to the wary anchor');
ok(resolveVoiceIntensity({ lineId: 'firing', alertTier: 'defensive' }) === p.anchorDefensive, 'defensive tier resolves to the defensive anchor');
ok(resolveVoiceIntensity({ lineId: 'firing', alertTier: 'push' }) === p.anchorPush, 'push tier resolves to the push anchor');
ok(resolveVoiceIntensity({ lineId: 'firing', alertTier: 'not-a-real-tier' }) === p.anchorCalm, 'an unrecognised tier falls back to calm rather than throwing');

console.log('alert-line floor');
// grenade_warn/man_down/contact/enemy_down sit at or above the director's default alert rank
// (bot-voice-director.js LINE_PRIORITY vs. SOUND_PARAMS.director.alertRank, 100/90/80/70 vs. 70)
// -- these must never resolve below the defensive anchor, regardless of how calm the read is.
for (const lineId of ['grenade_warn', 'man_down', 'contact', 'enemy_down']) {
  ok(resolveVoiceIntensity({ lineId, alertTier: null }) >= p.anchorDefensive,
    `${lineId} is floored at the defensive anchor even when calm`);
}
// Bark lines -- no_ammo (66) included, below the 70 alert rank -- carry no such floor and read
// the full range, including near-zero.
for (const lineId of ['firing', 'moving', 'overwatch', 'reloading', 'no_ammo']) {
  ok(resolveVoiceIntensity({ lineId, alertTier: null }) === p.anchorCalm,
    `${lineId} is NOT floored -- it reads calm when the situation is calm`);
}
// A floored line can still read above the floor when the situation genuinely warrants it.
ok(resolveVoiceIntensity({ lineId: 'grenade_warn', alertTier: 'push' }) === p.anchorPush,
  'a floored line still reflects push intensity above its floor, not clamped down to it');

console.log(failures ? `\n${failures} failure(s)` : '\nall bot-voice-intensity checks passed');
process.exit(failures ? 1 : 0);
