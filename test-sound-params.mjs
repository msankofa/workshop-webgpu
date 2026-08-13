// Node test for the shared sound parameter registry.
//
// This is the file that stops sound-params.json and sound-params.js drifting apart. The JSON is
// fetched by the browser and cannot be imported here, so it is read with fs and checked against
// the schema: every key known, every value in range, and the cross-section invariants that no
// single range check can catch.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  SOUND_PARAM_SCHEMA, SOUND_PARAMS, SECTION_IDS, MAP_SECTION_IDS,
  applyParamOverrides, exportParams, resetParams, setParam, setMapOverride,
  validateParamDoc, auditParams, coerceParam, sectionIsDirty, paramSpec,
} from './sound-params.js';
import { LINE_IDS, buildVoiceLine, voiceLineDurationS, rhythmDistance, MIN_RHYTHM_DISTANCE } from './bot-voice.js';
import { linePriority, lineCooldownMs, createVoiceDirector } from './bot-voice-director.js';
import { createAudioBudget, loopVoiceCap, audioBudgetDefaults } from './combat-audio-budget.js';
import { botDeathSirenVoice } from './bot-damage-audio.js';

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  passed++;
}

// --- schema is well-formed --------------------------------------------------
for (const [sectionId, section] of Object.entries(SOUND_PARAM_SCHEMA)) {
  ok(typeof section.label === 'string' && section.label, `${sectionId} has a label`);
  for (const [key, spec] of Object.entries(section.params)) {
    const path = `${sectionId}.${key}`;
    ok(spec.min < spec.max, `${path} has min below max`);
    ok(spec.step > 0, `${path} has a positive step`);
    ok(typeof spec.label === 'string' && spec.label, `${path} has a label`);
    const items = Array.isArray(spec.default) ? spec.default : [spec.default];
    for (const d of items) {
      ok(Number.isFinite(d), `${path} default is a number`);
      ok(d >= spec.min && d <= spec.max, `${path} default ${d} sits inside ${spec.min}..${spec.max}`);
    }
  }
}

// --- the shipped defaults pass their own audit ------------------------------
{
  const issues = auditParams();
  assert.deepEqual(issues, [], `shipped defaults must pass auditParams, got: ${issues.join(' | ')}`);
  passed++;
}

// --- the audit actually catches the bugs that shipped -----------------------
{
  // The real bug: voices were capped at 55 m while gunfire carried 90 m, so the listener heard
  // the firefight and none of the callouts about it.
  setParam('ranges', 'voiceMax', 55);
  const issues = auditParams();
  ok(issues.some(s => s.includes('voice range')), 'audit catches a voice range shorter than gunshot range');
  resetParams('ranges');
  ok(auditParams().length === 0, 'resetting the section clears the finding');
}
{
  setParam('damage', 'maxSirens', 8);
  setParam('damage', 'maxDamageLoops', 4);
  const issues = auditParams();
  ok(issues.some(s => s.includes('maxSirens')), 'audit catches sirens able to fill the sustained ceiling');
  resetParams('damage');
}
{
  setParam('voice', 'radioHighpassHz', 2000);
  setParam('voice', 'radioLowpassHz', 1000);
  ok(auditParams().some(s => s.includes('radio chain passes nothing')), 'audit catches an inverted radio band');
  resetParams('voice');
}

// --- coercion clamps rather than trusting ------------------------------------
{
  const hi = coerceParam('voice', 'makeup', 999);
  ok(hi.value === paramSpec('voice', 'makeup').max, 'an out-of-range scalar is clamped, not accepted');
  ok(hi.note && hi.note.includes('clamped'), 'and the clamp is reported');

  ok(coerceParam('voice', 'makeup', 'banana').value === null, 'a non-number is refused');
  ok(coerceParam('voice', 'nonesuch', 1).value === null, 'an unknown key is refused');
  ok(coerceParam('voice', 'formantQ', [5, 6]).value === null, 'a wrong-arity array is refused');
  assert.deepEqual(coerceParam('voice', 'formantQ', [5, 6, 7]).value, [5, 6, 7], 'a correct array passes through');
  passed++;
}

// --- overrides reach code that already imported ------------------------------
{
  const before = SOUND_PARAMS.voice.makeup;
  const res = applyParamOverrides({ voice: { makeup: 4 } });
  ok(res.applied === 1, 'one value applied');
  ok(SOUND_PARAMS.voice.makeup === 4, 'the live object was mutated in place');

  // The point of mutating in place: a module that grabbed the section at import time still sees it.
  const heldReference = SOUND_PARAMS.voice;
  applyParamOverrides({ voice: { makeup: 5 } });
  ok(heldReference.makeup === 5, 'a reference held from before the override still reads current values');

  resetParams('voice');
  ok(SOUND_PARAMS.voice.makeup === before, 'reset restores the schema default');
}
{
  const res = applyParamOverrides({ nosuchsection: { a: 1 }, voice: { nosuchkey: 1 } });
  ok(res.warnings.length === 2, 'unknown sections and keys are reported');
  ok(res.applied === 0, 'and nothing unknown is applied');
  ok(applyParamOverrides(null).warnings.length === 1, 'a non-object document is refused, not thrown on');
}

// --- an override genuinely changes synthesis ---------------------------------
{
  // Rate scales the whole phrase, so a slower speaker takes strictly longer to say the same line.
  const fast = voiceLineDurationS('contact');
  applyParamOverrides({ voice: { rateMin: 0.46, rateSpan: 0.08 } });
  const slow = voiceLineDurationS('contact');
  ok(slow > fast * 1.3, `halving the speaking rate lengthens the line (${fast.toFixed(3)}s -> ${slow.toFixed(3)}s)`);
  resetParams('voice');
}
{
  // The siren schedules its whole pattern up front, so its beep count is observable without audio.
  const countBeeps = () => {
    let beeps = 0;
    const fakeParam = () => ({
      setValueAtTime() { return this; },
      linearRampToValueAtTime() { beeps++; return this; },
      exponentialRampToValueAtTime() { return this; },
      cancelScheduledValues() { return this; },
      value: 0,
    });
    const node = () => ({
      gain: fakeParam(), frequency: fakeParam(), Q: fakeParam(), detune: fakeParam(),
      connect() {}, start() {}, stop() {}, type: '',
    });
    const ctx = { createGain: node, createOscillator: node, createBiquadFilter: node, sampleRate: 48000 };
    botDeathSirenVoice({ seed: 3, windowS: 12 })(ctx, node(), 0);
    return beeps;
  };
  const normal = countBeeps();
  applyParamOverrides({ siren: { restBaseS: 2.5, restGrowthS: 3 } });
  const sparse = countBeeps();
  ok(sparse < normal, `a longer rest yields fewer beeps in the same window (${normal} -> ${sparse})`);
  resetParams('siren');
}

// --- map sections override the owning module's table -------------------------
{
  const base = linePriority('firing');
  setMapOverride('linePriority', 'firing', 99);
  ok(linePriority('firing') === 99, 'a linePriority override wins over the module default');
  setMapOverride('linePriority', 'firing', undefined);
  ok(linePriority('firing') === base, 'clearing the override restores the module default');

  const baseCd = lineCooldownMs('firing');
  setMapOverride('lineCooldownMs', 'firing', 1234);
  ok(lineCooldownMs('firing') === 1234, 'a lineCooldownMs override wins');
  setMapOverride('lineCooldownMs', 'firing', undefined);
  ok(lineCooldownMs('firing') === baseCd, 'and clears cleanly');
}
{
  // A lexicon override has to survive synthesis, not just lookup.
  setMapOverride('voiceLines', 'firing', {
    event: 'bot_vo_firing', text: 'test', contour: [1, 1], drive: 4,
    syllables: [{ vowel: 'ah', durMs: 500, gapMs: 0, peak: 0.8 }],
  });
  ok(voiceLineDurationS('firing') > 0.4, 'an overridden line reports its new duration');
  ok(typeof buildVoiceLine('firing') === 'function', 'and still produces a builder');
  setMapOverride('voiceLines', 'firing', undefined);
}

// --- one number governs voice concurrency ------------------------------------
{
  // There used to be two: budget.voiceCap and director.speakerCap, and the director overwrote the
  // budget's copy at construction, so editing budget.voiceCap did nothing at all.
  ok(!('voiceCap' in SOUND_PARAMS.budget), 'the budget has no separate voice cap');
  ok(audioBudgetDefaults().categoryCaps.voice === SOUND_PARAMS.director.speakerCap,
    'the budget voice cap IS director.speakerCap');

  const budget = createAudioBudget();
  applyParamOverrides({ director: { speakerCap: 1 } });
  ok(budget.getLimits().categoryCaps.voice === 1, 'a budget built earlier tracks the new speaker cap');
  const first = budget.reserve('voice', 60);
  ok(first !== null, 'the first voice fits');
  ok(budget.reserve('voice', 60) === null, 'the second is refused at a cap of 1');
  resetParams('director');
  ok(budget.getLimits().categoryCaps.voice === SOUND_PARAMS.director.speakerCap, 'and follows the reset back');
  budget.reset();
}
{
  const budget = createAudioBudget({ categoryCaps: { voice: 5 } });
  applyParamOverrides({ director: { speakerCap: 1 } });
  ok(budget.getLimits().categoryCaps.voice === 5, 'an explicitly pinned cap ignores later param changes');
  resetParams('director');
}
{
  ok(loopVoiceCap() === SOUND_PARAMS.budget.loopCap, 'environment-audio.js reads the live sustained ceiling');
  applyParamOverrides({ budget: { loopCap: 2 } });
  ok(loopVoiceCap() === 2, 'and follows an override');
  resetParams('budget');
}

// --- the director tracks live params -----------------------------------------
{
  const d = createVoiceDirector();
  ok(d.getConfig().maxDistance === SOUND_PARAMS.director.maxDistance, 'an unpinned director reads the live cutoff');
  applyParamOverrides({ director: { maxDistance: 200 } });
  ok(d.getConfig().maxDistance === 200, 'and follows an override applied after construction');
  resetParams('director');

  const pinned = createVoiceDirector({ maxDistance: 30 });
  applyParamOverrides({ director: { maxDistance: 200 } });
  ok(pinned.getConfig().maxDistance === 30, 'a director given an explicit cutoff keeps it');
  resetParams('director');
}
{
  // The rate bucket must read its window live rather than snapshotting it at construction.
  const d = createVoiceDirector({ maxDistance: 1000 });
  applyParamOverrides({ director: { globalRateMax: 1, globalRateWindowMs: 1000 } });
  const a = d.request({ lineId: 'contact', botId: 'b1', now: 0, distance: 1, durationS: 0.5 });
  const b = d.request({ lineId: 'contact', botId: 'b2', teamId: 2, now: 10, distance: 1, durationS: 0.5 });
  ok(a.ok, 'the first line is granted');
  ok(!b.ok && b.reason === 'globalRate', `the second is refused by the live rate cap (got ${b.reason})`);
  resetParams('director');
}

// --- export round-trips -------------------------------------------------------
{
  resetParams();
  assert.deepEqual(exportParams(), {}, 'an unedited registry exports no overrides at all');
  ok(!sectionIsDirty('voice'), 'and reports no section dirty');

  setParam('voice', 'makeup', 3.5);
  setParam('voice', 'formantQ', [4, 5, 6]);
  ok(sectionIsDirty('voice'), 'an edited section reads dirty');
  const doc = exportParams();
  assert.deepEqual(doc, { voice: { makeup: 3.5, formantQ: [4, 5, 6] } }, 'export contains only what changed');

  resetParams();
  applyParamOverrides(doc);
  assert.deepEqual(exportParams(), doc, 'export -> apply -> export is stable');
  ok(validateParamDoc(doc).ok, 'an exported document validates');
  resetParams();
}
{
  const bad = validateParamDoc({ voice: { makeup: 999 }, nope: {} });
  ok(!bad.ok, 'validation rejects an out-of-range value');
  ok(bad.errors.some(e => e.includes('outside')), 'and says which bound was missed');
  ok(bad.errors.some(e => e.includes('unknown section')), 'and flags the unknown section');
}

// --- the checked-in JSON is loadable -----------------------------------------
{
  const raw = readFileSync(join(here, 'sound-params.json'), 'utf8');
  let doc;
  assert.doesNotThrow(() => { doc = JSON.parse(raw); }, 'sound-params.json is valid JSON');
  passed++;

  const result = validateParamDoc(doc);
  assert.ok(result.ok, `sound-params.json must validate against the schema:\n  ${result.errors.join('\n  ')}`);
  passed++;

  // Whatever the file says, the resulting mix has to survive the audit -- this is the check that
  // makes the JSON safe to hand-edit.
  resetParams();
  applyParamOverrides(doc);
  const issues = auditParams();
  assert.deepEqual(issues, [], `sound-params.json must pass auditParams:\n  ${issues.join('\n  ')}`);
  passed++;

  // A lexicon override may not make two lines sound alike -- the whole point of the rhythm
  // signatures is that a half-heard fragment is still identifiable.
  for (let i = 0; i < LINE_IDS.length; i++) {
    for (let j = i + 1; j < LINE_IDS.length; j++) {
      const d = rhythmDistance(LINE_IDS[i], LINE_IDS[j]);
      assert.ok(d >= MIN_RHYTHM_DISTANCE,
        `${LINE_IDS[i]} and ${LINE_IDS[j]} are only ${d.toFixed(3)} apart after applying sound-params.json`);
    }
  }
  passed++;
  resetParams();
}

// --- section ids line up -------------------------------------------------------
{
  ok(SECTION_IDS.every(id => id in SOUND_PARAMS), 'every schema section exists in the live object');
  ok(MAP_SECTION_IDS.every(id => id in SOUND_PARAMS), 'every map section exists in the live object');
  ok(MAP_SECTION_IDS.every(id => !SECTION_IDS.includes(id)), 'map sections and scalar sections do not overlap');
}

console.log(`sound-params: ${passed} checks passed`);
