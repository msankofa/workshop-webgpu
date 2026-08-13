// bot-voice-intensity.js -- translates a bot's alert tier into a 0..1 voice-delivery target, used
// to pick which line variant (calm vs. urgent wording/tone) fits the current moment.
//
// Pure, no THREE, no DOM: the module never reaches into a bot actor or the alert-report ring
// itself. The caller (bot-viewer-v2.html / environment-viewer-v2.html) resolves its own alertTier
// -- the cached one for a sentry-cadence line, or tierForScore(alertEscalation(...).score) freshly
// for an event-triggered line -- and passes just that string in. This is what keeps the module
// genuinely testable and keeps it from needing to know alertEscalation exists at all.
//
// Sits at the seam between three already-separated concerns rather than folding into any one of
// them: bot-alert.js owns perception, bot-voice-director.js owns arbitration (and this module
// depends on its budgetPriorityFor, so it can't BE that file), bot-voice.js owns synthesis and is
// deliberately dependency-free of gameplay state. See docs/superpowers/plans/2026-08-03-bot-voice-
// intensity-plan.md Chapter 1 §4 for the full reasoning.

import { SOUND_PARAMS } from './sound-params.js';
import { budgetPriorityFor } from './bot-voice-director.js';
import { AUDIO_PRIORITY } from './combat-audio-budget.js';

const TIER_ANCHOR_KEY = {
  push: 'anchorPush',
  defensive: 'anchorDefensive',
  wary: 'anchorWary',
};

// { lineId, alertTier } -> 0..1. alertTier is 'push' | 'defensive' | 'wary' | null/anything else
// (treated as calm). Alert-priority lines (budgetPriorityFor === voiceAlert) are floored at the
// defensive anchor -- derived from the tier table, not a second independently-chosen number -- so
// a genuinely urgent line can never resolve to a calm-tagged variant regardless of the read.
export function resolveVoiceIntensity({ lineId, alertTier } = {}) {
  const p = SOUND_PARAMS.voiceIntensity;
  const key = TIER_ANCHOR_KEY[alertTier];
  let target = key ? p[key] : p.anchorCalm;
  if (budgetPriorityFor(lineId) === AUDIO_PRIORITY.voiceAlert) target = Math.max(target, p.anchorDefensive);
  return Math.min(1, Math.max(0, target));
}
