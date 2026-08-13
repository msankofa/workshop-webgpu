// Node tests for bot-voice.js (robotic callout synthesis) and bot-voice-director.js (arbitration).
// The WebAudio half runs against a fake AudioContext copied from test-weapon-sfx-synth.mjs; the
// director half is pure logic and needs no fake at all.
// Run: node test-bot-voice.mjs
import {
  VOICE_LINES, LINE_IDS, VOWEL_FORMANTS, MIN_RHYTHM_DISTANCE, REFLEX_LINES,
  voiceEventId, voiceLine, rhythmSignature, rhythmDistance, lineIds, lineText,
  voiceIdentity, voiceSeedFromId, voiceLineDurationS, buildVoiceLine,
  lineVariants, voiceLexiconVariants, peekVariantIndex, commitVariantIndex, resetVariantRotation,
  variantRhythmDistance, seedSyllables,
} from './bot-voice.js';
import {
  createVoiceDirector, LINE_PRIORITY, LINE_COOLDOWN_MS, AMBIENT_LINES,
  budgetPriorityFor, linePriority, knownLine, VOICE_DIRECTOR_DEFAULTS,
} from './bot-voice-director.js';
import { createAudioBudget, AUDIO_PRIORITY } from './combat-audio-budget.js';
import { setMapOverride } from './sound-params.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

// ---- Minimal fake WebAudio: records every node, connection and scheduled param call ----
class FakeParam {
  constructor(node, name) { this.node = node; this.name = name; this.value = 0; this.calls = []; }
  record(method, value, time) {
    this.calls.push({ method, value, time });
    this.node.ctx.paramCalls.push({ node: this.node, param: this.name, method, value, time });
    this.value = value;
    return this;
  }
  setValueAtTime(v, t) { return this.record('setValueAtTime', v, t); }
  linearRampToValueAtTime(v, t) { return this.record('linearRampToValueAtTime', v, t); }
  exponentialRampToValueAtTime(v, t) { return this.record('exponentialRampToValueAtTime', v, t); }
  setTargetAtTime(v, t) { return this.record('setTargetAtTime', v, t); }
}

class FakeNode {
  constructor(ctx, type) {
    this.ctx = ctx;
    this.type = type;
    // Builders overwrite `.type` on oscillators ('sawtooth') and filters ('bandpass'), so the
    // node's identity is kept separately -- otherwise nothing can be counted by node class.
    this.kind = type;
    this.outputs = [];
    this.startTime = null;
    this.stopTime = null;
    ctx.nodes.push(this);
  }
  connect(target) { this.outputs.push(target); return target; }
  disconnect() { this.outputs.length = 0; }
  start(when, offset) { this.startTime = when; this.startOffset = offset; }
  stop(when) { this.stopTime = when; }
}

class FakeCtx {
  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
    this.currentTime = 0;
    this.nodes = [];
    this.paramCalls = [];
    this.createBufferCalls = 0;
  }
  createBuffer(channels, length, rate) {
    this.createBufferCalls++;
    const data = new Float32Array(length);
    return { numberOfChannels: channels, length, sampleRate: rate, getChannelData: () => data };
  }
  createBufferSource() { return new FakeNode(this, 'bufferSource'); }
  createGain() { const n = new FakeNode(this, 'gain'); n.gain = new FakeParam(n, 'gain'); return n; }
  createOscillator() {
    const n = new FakeNode(this, 'oscillator');
    n.frequency = new FakeParam(n, 'frequency');
    n.detune = new FakeParam(n, 'detune');
    return n;
  }
  createBiquadFilter() {
    const n = new FakeNode(this, 'biquad');
    n.frequency = new FakeParam(n, 'frequency');
    n.Q = new FakeParam(n, 'Q');
    n.gain = new FakeParam(n, 'gain');
    return n;
  }
  // The radio stage soft-clips through a WaveShaper; the weapon harness never needed one.
  createWaveShaper() { const n = new FakeNode(this, 'waveShaper'); n.curve = null; return n; }
}

function reaches(node, destination, seen = new Set()) {
  if (node === destination) return true;
  if (seen.has(node)) return false;
  seen.add(node);
  return (node.outputs || []).some(out => reaches(out, destination, seen));
}

function runVoice(lineId, ctx, t0, identity, opts) {
  const before = ctx.nodes.length;
  const beforeParams = ctx.paramCalls.length;
  const destination = new FakeNode(ctx, 'destination');
  const build = buildVoiceLine(lineId, identity, opts);
  const duration = build(ctx, destination, t0);
  return {
    duration,
    destination,
    nodes: ctx.nodes.slice(before + 1),                 // +1 skips the destination itself
    paramCalls: ctx.paramCalls.slice(beforeParams),
  };
}

// =====================================================================================
// 1. lexicon integrity
// =====================================================================================
ok(LINE_IDS.length === 22, `22 lines are defined (got ${LINE_IDS.length})`);
ok(voiceLine('definitely_not_a_line') === null, 'unknown line id yields null');
ok(voiceLine('toString') === null, 'inherited object keys are not treated as lines');
ok(buildVoiceLine('definitely_not_a_line') === null, 'unknown line id builds no voice');

for (const id of LINE_IDS) {
  const line = VOICE_LINES[id];
  ok(voiceEventId(id) === `bot_vo_${id}`, `${id}: event id is bot_vo_${id}`);
  ok(Array.isArray(line.syllables) && line.syllables.length > 0, `${id}: has at least one syllable`);
  ok(typeof line.text === 'string' && line.text.length > 0, `${id}: carries its source text`);
  ok(Array.isArray(line.contour) && line.contour.length === 2, `${id}: has a two-point pitch contour`);
  for (let i = 0; i < line.syllables.length; i++) {
    const s = line.syllables[i];
    ok(s.durMs > 0, `${id}[${i}]: positive duration`);
    ok(s.gapMs >= 0, `${id}[${i}]: non-negative gap`);
    ok(s.peak > 0 && s.peak <= 1, `${id}[${i}]: peak in (0, 1]`);
    ok(Array.isArray(s.formant) && s.formant.length === 3, `${id}[${i}]: three formants`);
    for (let k = 0; k < 3; k++) {
      const hz = s.formant[k];
      ok(Number.isFinite(hz) && hz >= 150 && hz <= 4000, `${id}[${i}]: F${k + 1} ${hz} Hz is in 150-4000`);
    }
    ok(s.formant[0] < s.formant[1] && s.formant[1] < s.formant[2], `${id}[${i}]: formants ascend F1<F2<F3`);
  }
  ok(line.syllables[line.syllables.length - 1].gapMs === 0, `${id}: last syllable has no trailing gap`);
}

// Every vowel used comes from the Peterson & Barney table, unmodified.
for (const id of LINE_IDS) {
  for (const s of VOICE_LINES[id].syllables) {
    ok(VOWEL_FORMANTS[s.vowel] === s.formant, `${id}: syllable vowel /${s.vowel}/ points at the P&B table entry`);
  }
}

// =====================================================================================
// 2. rhythmic signatures -- the regression guard for "recognisable by ear"
// =====================================================================================
{
  let worst = { d: Infinity, a: null, b: null };
  for (let i = 0; i < LINE_IDS.length; i++) {
    for (let j = i + 1; j < LINE_IDS.length; j++) {
      const a = LINE_IDS[i], b = LINE_IDS[j];
      const d = rhythmDistance(a, b);
      ok(d >= MIN_RHYTHM_DISTANCE, `rhythm: ${a} vs ${b} differ by ${d.toFixed(3)} (>= ${MIN_RHYTHM_DISTANCE})`);
      if (d < worst.d) worst = { d, a, b };
    }
  }
  ok(worst.d >= MIN_RHYTHM_DISTANCE, `closest pair ${worst.a}/${worst.b} at ${worst.d.toFixed(3)}`);
  ok(rhythmDistance('contact', 'contact') === 0, 'a line is rhythmically identical to itself');
}
{
  // "Grenade!" is the one line that must cut through: shortest phrase, front-loaded, loudest onset.
  const warn = rhythmSignature('grenade_warn');
  for (const id of LINE_IDS) {
    if (id === 'grenade_warn') continue;
    ok(warn.totalMs < rhythmSignature(id).totalMs, `grenade_warn is shorter than ${id}`);
  }
  const syl = VOICE_LINES.grenade_warn.syllables;
  ok(syl[0].durMs > syl[1].durMs, 'grenade_warn is front-loaded in duration');
  ok(syl[0].peak > syl[1].peak, 'grenade_warn is front-loaded in level');
  ok(syl[0].peak >= 1, 'grenade_warn opens at full level');
  // ...and "reloading" is the counterexample: long and metrically even.
  const reload = VOICE_LINES.reloading.syllables.map(s => s.durMs);
  ok(Math.max(...reload) === Math.min(...reload), 'reloading is metrically even');
  ok(rhythmSignature('reloading').totalMs > 2 * warn.totalMs, 'reloading is more than twice grenade_warn');
}

// =====================================================================================
// 3. identity determinism
// =====================================================================================
{
  ok(voiceSeedFromId('bot-7') === 7, "voiceSeedFromId('bot-7') === 7 (botSeedFromId parity)");
  ok(voiceSeedFromId('bot-42') === 42, "voiceSeedFromId('bot-42') === 42");
  ok(voiceSeedFromId(null) === 0, 'a missing id seeds 0 rather than NaN');
  ok(voiceSeedFromId(13) === 13, 'a numeric id passes through');

  const a1 = voiceIdentity('bot-3', 0), a2 = voiceIdentity('bot-3', 0);
  ok(a1.f0 === a2.f0 && a1.formantScale === a2.formantScale && a1.rate === a2.rate && a1.buzz === a2.buzz,
    'same bot id + team yields an identical identity');

  const seen = new Set();
  let minF0 = Infinity, maxF0 = -Infinity;
  for (let i = 0; i < 40; i++) {
    const id = voiceIdentity(`bot-${i}`, 0);
    ok(Number.isFinite(id.f0) && id.f0 > 60 && id.f0 < 200, `bot-${i}: f0 ${id.f0.toFixed(1)} is a plausible fundamental`);
    ok(id.formantScale > 0.85 && id.formantScale < 1.15, `bot-${i}: formant scale stays near 1`);
    ok(id.rate > 0.8 && id.rate < 1.2, `bot-${i}: speaking rate stays near 1`);
    seen.add(id.f0.toFixed(4));
    minF0 = Math.min(minF0, id.f0); maxF0 = Math.max(maxF0, id.f0);
  }
  ok(seen.size >= 35, `40 bots produce at least 35 distinct fundamentals (got ${seen.size})`);
  ok(maxF0 - minF0 > 40, `fundamentals actually spread across the roster (${(maxF0 - minF0).toFixed(1)} Hz)`);

  // Different seeds must differ MEASURABLY, not merely be unequal.
  const b1 = voiceIdentity('bot-1', 0), b2 = voiceIdentity('bot-2', 0);
  ok(Math.abs(b1.f0 - b2.f0) > 1, 'two neighbouring bots differ audibly in pitch');

  // Team timbre is a coarse offset on top: the same bot number on two sides is not the same voice.
  const t0 = voiceIdentity('bot-5', 0), t1 = voiceIdentity('bot-5', 1);
  ok(t0.f0 !== t1.f0, 'team changes the fundamental');
  ok(t0.formantScale !== t1.formantScale, 'team changes the vocal-tract scale');
  ok(Math.abs(t0.f0 - t1.f0) > 0.5, 'the team pitch offset is not a rounding artefact');
}

// =====================================================================================
// 4. synthesis graph battery
// =====================================================================================
const T0 = 3.75;
const IDENT = voiceIdentity('bot-9', 1);
for (const id of LINE_IDS) {
  for (const radio of [true, false]) {
    const label = `${id}${radio ? ' (radio)' : ' (clean)'}`;
    const ctx = new FakeCtx();
    const { duration, destination, nodes, paramCalls } = runVoice(id, ctx, T0, IDENT, { radio });

    ok(Number.isFinite(duration) && duration > 0, `${label}: returns a positive finite duration`);
    ok(duration < 3, `${label}: no callout runs longer than 3 s (got ${duration.toFixed(3)})`);
    ok(nodes.length > 0, `${label}: creates at least one node`);

    for (const node of nodes) {
      ok(reaches(node, destination), `${label}: ${node.kind} node reaches destination (not orphaned)`);
    }

    const sources = nodes.filter(n => n.kind === 'bufferSource' || n.kind === 'oscillator');
    ok(sources.length > 0, `${label}: creates at least one source node`);
    for (const src of sources) {
      ok(src.startTime !== null, `${label}: ${src.kind} is started`);
      ok(src.stopTime !== null, `${label}: ${src.kind} is stopped (nothing runs forever)`);
      ok(src.startTime >= T0 - 1e-9, `${label}: ${src.kind} does not start before t0`);
      ok(src.stopTime <= T0 + duration + 1e-9, `${label}: ${src.kind} stops within t0 + duration`);
      ok(src.stopTime >= src.startTime, `${label}: ${src.kind} stop is not before its start`);
    }

    ok(paramCalls.length > 0, `${label}: schedules AudioParam automation`);
    for (const call of paramCalls) {
      ok(Number.isFinite(call.time), `${label}: ${call.param}.${call.method} time is finite`);
      ok(call.time >= T0 - 1e-9, `${label}: ${call.param}.${call.method} is not scheduled before t0`);
      ok(call.time <= T0 + duration + 1e-9, `${label}: ${call.param}.${call.method} stays inside the voice window`);
      if (call.method === 'exponentialRampToValueAtTime') {
        ok(call.value > 0, `${label}: exponential ramp target on ${call.param} is > 0`);
      }
    }

    // The formant bank must actually sweep: three bandpasses, each with more than one frequency event.
    const bandpasses = nodes.filter(n => n.kind === 'biquad' && n.frequency.calls.length > 1);
    ok(bandpasses.length >= 3, `${label}: at least three swept formant filters`);
    for (const bp of bandpasses.slice(0, 3)) {
      for (const c of bp.frequency.calls) {
        ok(c.value >= 150 && c.value <= 4000, `${label}: scheduled formant ${c.value.toFixed(0)} Hz stays in 150-4000`);
      }
    }

    // Carrier oscillators sit in the documented fundamental band.
    const oscs = nodes.filter(n => n.kind === 'oscillator');
    ok(oscs.length === 2, `${label}: saw + square carrier pair`);
    for (const o of oscs) {
      for (const c of o.frequency.calls) {
        ok(c.value > 50 && c.value < 250, `${label}: carrier ${c.value.toFixed(1)} Hz is a plausible fundamental`);
      }
    }

    // Radio treatment is a flag, not a default: no radio drive and no noise on the clean path.
    // The OUTPUT LIMITER is unconditional, so a clean voice still has exactly one shaper -- the
    // makeup gain that makes callouts carry drags peaks to 0 dBFS against a -30 dBFS RMS, and
    // without a soft clip after it the loudest lines clip on their own before any mixing.
    const shapers = nodes.filter(n => n.kind === 'waveShaper');
    const noise = nodes.filter(n => n.kind === 'bufferSource');
    ok(shapers.every(s => s.curve && s.curve.length > 0), `${label}: every saturator carries a sampled curve`);
    if (radio) {
      ok(shapers.length === 2, `${label}: radio drive plus the output limiter`);
      ok(noise.length >= 3, `${label}: squelch clicks + hiss tail are present`);
    } else {
      ok(shapers.length === 1, `${label}: the output limiter alone, with no radio drive`);
      ok(noise.length === 0, `${label}: no squelch noise without the radio flag`);
      ok(ctx.createBufferCalls === 0, `${label}: a clean voice never allocates the noise buffer`);
    }

    // Builders touch nothing outside what they were handed.
    ok(nodes.every(n => n.ctx === ctx), `${label}: all nodes come from the passed context`);
    ok(nodes.every(n => n.outputs.every(o => o === destination || nodes.includes(o))), `${label}: connections stay within the built graph`);
    ok(destination.outputs.length === 0, `${label}: the builder does not connect the destination onward`);
  }
}

// Reported duration matches what the director is told to budget for.
for (const id of LINE_IDS) {
  for (const radio of [true, false]) {
    const ctx = new FakeCtx();
    const { duration } = runVoice(id, ctx, 0, IDENT, { radio });
    const predicted = voiceLineDurationS(id, IDENT, { radio });
    ok(Math.abs(duration - predicted) / predicted < 0.05,
      `${id} (${radio ? 'radio' : 'clean'}): voiceLineDurationS ${predicted.toFixed(3)} matches the built ${duration.toFixed(3)}`);
  }
}

// Shared noise buffer: once per context, never per utterance.
{
  const ctx = new FakeCtx();
  runVoice('contact', ctx, 1, IDENT, { radio: true });
  ok(ctx.createBufferCalls === 1, 'the first radio voice creates one noise buffer');
  runVoice('cover', ctx, 2, IDENT, { radio: true });
  runVoice('man_down', ctx, 3, IDENT, { radio: true });
  ok(ctx.createBufferCalls === 1, 'later voices on the same ctx reuse the cached noise buffer');

  const other = new FakeCtx();
  runVoice('contact', other, 0, IDENT, { radio: true });
  ok(other.createBufferCalls === 1, 'a different ctx gets its own noise buffer');

  const noiseSources = ctx.nodes.filter(n => n.kind === 'bufferSource');
  const buffers = new Set(noiseSources.map(n => n.buffer));
  ok(noiseSources.length > 1 && buffers.size === 1, 'all noise sources share one buffer instance');
}

// Per-call variation: two utterances of the same line by the same bot are not bit-identical.
for (const id of LINE_IDS) {
  const ctx = new FakeCtx();
  const a = runVoice(id, ctx, 0, IDENT, { radio: true });
  const b = runVoice(id, ctx, 0, IDENT, { radio: true });
  const key = calls => calls.map(c => `${c.param}:${c.method}:${c.value}:${c.time}`).join('|');
  ok(key(a.paramCalls) !== key(b.paramCalls), `${id}: two utterances differ in scheduled params`);
}

// Two different bots saying the same line are measurably different voices.
{
  const ctxA = new FakeCtx(), ctxB = new FakeCtx();
  const a = runVoice('contact', ctxA, 0, voiceIdentity('bot-1', 0), { radio: false });
  const b = runVoice('contact', ctxB, 0, voiceIdentity('bot-2', 0), { radio: false });
  const firstFormant = r => r.nodes.find(n => n.kind === 'biquad').frequency.calls[0].value;
  const firstCarrier = r => r.nodes.find(n => n.kind === 'oscillator').frequency.calls[0].value;
  ok(Math.abs(firstFormant(a) - firstFormant(b)) > 1, 'two bots differ in formant placement');
  ok(Math.abs(firstCarrier(a) - firstCarrier(b)) > 1, 'two bots differ in carrier pitch');
}

// =====================================================================================
// 5. director arbitration
// =====================================================================================
ok(LINE_IDS.every(id => id in LINE_PRIORITY), 'every lexicon line has a priority');
ok(LINE_IDS.every(id => id in LINE_COOLDOWN_MS), 'every lexicon line has a per-type cooldown');
ok(linePriority('grenade_warn') > linePriority('man_down'), 'grenade_warn outranks man_down');
ok(linePriority('man_down') > linePriority('contact'), 'man_down outranks contact');
ok(linePriority('contact') > linePriority('cover'), 'contact outranks tactical lines');
ok(linePriority('cover') > linePriority('moving'), 'tactical lines outrank ambient flavour');
ok(budgetPriorityFor('grenade_warn') === AUDIO_PRIORITY.voiceAlert, 'grenade_warn maps to voiceAlert');
ok(budgetPriorityFor('moving') === AUDIO_PRIORITY.voiceBark, 'moving maps to voiceBark');
ok([...AMBIENT_LINES].every(id => id in LINE_PRIORITY), 'ambient lines are real lines');

function req(over = {}) {
  return {
    lineId: 'firing', botId: 'bot-1', teamId: 0, squadId: null,
    eventKey: null, now: 0, distance: 5, durationS: 0.6, ...over,
  };
}

// -- concurrent cap is never exceeded, under a 90-bot burst --
{
  // teamId is per bot here so the per-team line cooldown cannot mask the concurrency cap:
  // this case is about the ceiling, and the cooldowns get their own cases below.
  const dir = createVoiceDirector({ speakerCap: 3, globalRate: { windowMs: 2000, max: 1000 }, botCooldownMs: 4000 });
  let granted = 0, maxActive = 0;
  for (let i = 0; i < 90; i++) {
    const r = dir.request(req({ botId: `bot-${i}`, teamId: i, lineId: 'cover', now: 0, eventKey: `cover:${i}` }));
    if (r.ok) granted++;
    maxActive = Math.max(maxActive, dir.activeCount());
    ok(dir.activeCount() <= 3, `90-bot burst: active speakers stay at or under the cap (saw ${dir.activeCount()})`);
  }
  ok(granted <= 3, `90-bot burst at one instant grants at most 3 lines (granted ${granted})`);
  ok(maxActive === 3, 'the cap is actually reached, not just respected by accident');
  ok(dir.getStats().dropped >= 87, 'the rest are dropped, not queued');
}

// -- a bot never speaks twice inside its cooldown --
{
  const dir = createVoiceDirector({ speakerCap: 8, botCooldownMs: 4000, globalRate: { windowMs: 1000, max: 1000 } });
  const first = dir.request(req({ botId: 'bot-1', lineId: 'contact', now: 0 }));
  ok(first.ok, 'first line from a bot is granted');
  for (const t of [10, 500, 1500, 3999]) {
    const r = dir.request(req({ botId: 'bot-1', lineId: 'man_down', now: t }));
    ok(!r.ok && r.reason === 'botCooldown', `bot-1 is silent at t=${t} (reason ${r.reason})`);
  }
  const later = dir.request(req({ botId: 'bot-1', lineId: 'man_down', now: 4100 }));
  ok(later.ok, 'the same bot may speak again once its cooldown expires');
}

// -- per-line cooldown is scoped per team --
{
  const dir = createVoiceDirector({ speakerCap: 8, botCooldownMs: 0, globalRate: { windowMs: 1000, max: 1000 } });
  ok(dir.request(req({ botId: 'a', teamId: 0, lineId: 'cover', now: 0 })).ok, 'team 0 says "taking cover"');
  const sameTeam = dir.request(req({ botId: 'b', teamId: 0, lineId: 'cover', now: 100 }));
  ok(!sameTeam.ok && sameTeam.reason === 'lineCooldown', 'a second bot on team 0 is held off by the line cooldown');
  const otherTeam = dir.request(req({ botId: 'c', teamId: 1, lineId: 'cover', now: 100 }));
  ok(otherTeam.ok, "one team's line cooldown does not silence the other team");
  const otherLine = dir.request(req({ botId: 'd', teamId: 0, lineId: 'contact', now: 100 }));
  ok(otherLine.ok, 'a different line on the same team is unaffected');
}

// -- a grenade warning preempts a lower-priority line at the cap --
{
  const dir = createVoiceDirector({ speakerCap: 2, botCooldownMs: 0, globalRate: { windowMs: 5000, max: 100 } });
  const a = dir.request(req({ botId: 'a', teamId: 0, lineId: 'moving', now: 0, durationS: 2 }));
  const b = dir.request(req({ botId: 'b', teamId: 1, lineId: 'moving', now: 1, durationS: 2 }));
  ok(a.ok && b.ok, 'two ambient barks fill the cap');
  const blocked = dir.request(req({ botId: 'c', teamId: 0, lineId: 'reloading', now: 2, durationS: 2 }));
  ok(!blocked.ok && blocked.reason === 'busy', 'another bark at the cap is refused');
  const warn = dir.request(req({ botId: 'd', teamId: 0, lineId: 'grenade_warn', now: 3, durationS: 0.5 }));
  ok(warn.ok, 'a grenade warning gets in at the cap');
  ok(warn.evicted && warn.evicted.lineId === 'moving', 'the warning displaced an ambient bark');
  ok(dir.activeCount() === 2, 'preemption keeps the active count at the cap, it does not exceed it');
  const speakers = dir.activeSpeakers().map(s => s.lineId);
  ok(speakers.includes('grenade_warn'), 'the warning is now one of the live speakers');
}

// -- same event key collapses to exactly one speaker, nearest to the listener --
{
  const dir = createVoiceDirector({ speakerCap: 8, botCooldownMs: 0, globalRate: { windowMs: 5000, max: 100 } });
  const candidates = [
    req({ botId: 'far', lineId: 'man_down', eventKey: 'man_down:victim-3', distance: 30, now: 0 }),
    req({ botId: 'near', lineId: 'man_down', eventKey: 'man_down:victim-3', distance: 4, now: 0 }),
    req({ botId: 'mid', lineId: 'man_down', eventKey: 'man_down:victim-3', distance: 12, now: 0 }),
  ];
  const chosen = dir.requestBest(candidates);
  ok(chosen.ok && chosen.botId === 'near', 'the closest candidate is the one that speaks');
  let extra = 0;
  for (const c of candidates) if (dir.request({ ...c, now: 10 }).ok) extra++;
  ok(extra === 0, 'no other bot repeats the same event inside the dedup window');
  const other = dir.request(req({ botId: 'x', lineId: 'man_down', eventKey: 'man_down:victim-9', teamId: 1, distance: 3, now: 10 }));
  ok(other.ok, 'a different casualty is still reported');
  const late = dir.request(req({ botId: 'far', lineId: 'man_down', eventKey: 'man_down:victim-3', teamId: 1, distance: 3, now: 4000 }));
  ok(late.ok, 'the dedup window expires rather than blocking the key forever');
  ok(dir.requestBest([]).ok === false, 'an empty candidate list is a clean refusal');
}

// -- rate buckets hold --
{
  const dir = createVoiceDirector({
    speakerCap: 90, botCooldownMs: 0, globalRate: { windowMs: 1000, max: 4 }, squadRate: { windowMs: 1000, max: 2 },
  });
  let ok0 = 0;
  for (let i = 0; i < 20; i++) {
    if (dir.request(req({ botId: `b${i}`, teamId: i, lineId: 'contact', eventKey: `contact:${i}`, now: 0, durationS: 0.1 })).ok) ok0++;
  }
  ok(ok0 === 4, `global rate holds at 4 per window (got ${ok0})`);
  let ok1 = 0;
  for (let i = 0; i < 20; i++) {
    if (dir.request(req({ botId: `c${i}`, teamId: 100 + i, lineId: 'contact', eventKey: `contact:b${i}`, now: 1500, durationS: 0.1 })).ok) ok1++;
  }
  ok(ok1 === 4, `the global window rolls over rather than latching shut (got ${ok1})`);

  const sq = createVoiceDirector({
    speakerCap: 90, botCooldownMs: 0, globalRate: { windowMs: 1000, max: 100 }, squadRate: { windowMs: 1000, max: 2 },
  });
  let sqOk = 0, otherOk = 0;
  for (let i = 0; i < 10; i++) {
    if (sq.request(req({ botId: `s${i}`, teamId: `a${i}`, squadId: 'sq-1', lineId: 'contact', eventKey: `k${i}`, now: 0, durationS: 0.1 })).ok) sqOk++;
    if (sq.request(req({ botId: `t${i}`, teamId: `b${i}`, squadId: 'sq-2', lineId: 'contact', eventKey: `j${i}`, now: 0, durationS: 0.1 })).ok) otherOk++;
  }
  ok(sqOk === 2, `squad sq-1 is capped at 2 per window (got ${sqOk})`);
  ok(otherOk === 2, `squad sq-2 has its own bucket (got ${otherOk})`);
}

// -- expiring a slot lets the next request in --
{
  const dir = createVoiceDirector({ speakerCap: 1, botCooldownMs: 0, globalRate: { windowMs: 10000, max: 100 } });
  const a = dir.request(req({ botId: 'a', teamId: 0, lineId: 'firing', now: 0, durationS: 0.5 }));
  ok(a.ok, 'the single slot is taken');
  const b = dir.request(req({ botId: 'b', teamId: 1, lineId: 'firing', now: 100, durationS: 0.5 }));
  ok(!b.ok && b.reason === 'busy', 'while it is held, the next request is refused');
  const c = dir.request(req({ botId: 'c', teamId: 1, lineId: 'firing', now: 600, durationS: 0.5 }));
  ok(c.ok, 'once the line finishes, the slot is free again');
  ok(dir.activeCount() === 1, 'the expired speaker was retired, not accumulated');

  // An explicit release does the same thing without waiting for the clock.
  dir.release(c.token);
  ok(dir.activeCount() === 0, 'release() frees the slot immediately');
  ok(dir.request(req({ botId: 'd', teamId: 2, lineId: 'firing', now: 601, durationS: 0.5 })).ok, 'the freed slot is reusable');
}

// -- chattiness --
{
  const dir = createVoiceDirector({ speakerCap: 8, botCooldownMs: 0 });
  dir.setChattiness(0);
  ok(!dir.request(req({ lineId: 'contact', now: 0 })).ok, 'chattiness 0 silences everything');
  dir.setChattiness(0.2);
  ok(!dir.request(req({ lineId: 'moving', now: 0 })).ok, 'low chattiness gates ambient flavour');
  ok(dir.request(req({ lineId: 'grenade_warn', now: 0, botId: 'z' })).ok, 'low chattiness still lets alerts through');
  dir.setChattiness(1);
  ok(dir.getChattiness() === 1, 'chattiness round-trips');
}

// -- reflex lines (pain/death) are exempt from the chattiness dial --
{
  for (const id of ['hit', 'grenade_hit', 'near_miss', 'death']) ok(REFLEX_LINES.has(id), `${id} is a reflex line`);
  for (const id of ['contact', 'ally_hit', 'spawn', 'man_down']) ok(!REFLEX_LINES.has(id), `${id} is NOT a reflex line`);

  const dir = createVoiceDirector({ speakerCap: 8, botCooldownMs: 0, globalRate: { windowMs: 1000, max: 1000 } });
  dir.setChattiness(0);
  ok(!dir.request(req({ lineId: 'contact', now: 0 })).ok, 'chattiness 0 still silences an ordinary line');
  ok(dir.request(req({ lineId: 'death', now: 0, botId: 'r1' })).ok, 'chattiness 0 does NOT silence a reflex line');
  ok(dir.request(req({ lineId: 'hit', now: 0, botId: 'r2' })).ok, 'chattiness 0 does NOT silence hit either');

  // Cooldown must not be chattiness-stretched for a reflex line: at low chattiness, cooldownScale()
  // would multiply a non-reflex line's cooldown well past its base value, but a reflex line keeps
  // its raw LINE_COOLDOWN_MS. hit's base cooldown is 2800ms; request again just after that and it
  // must be granted, proving the cooldown wasn't stretched to whatever cooldownScale(0.1) would give.
  const dir2 = createVoiceDirector({ speakerCap: 8, botCooldownMs: 0, globalRate: { windowMs: 1000, max: 1000 } });
  dir2.setChattiness(0.1);
  ok(dir2.request(req({ lineId: 'hit', teamId: 5, now: 0, botId: 'r3' })).ok, 'first hit at low chattiness is granted');
  const tooSoon = dir2.request(req({ lineId: 'hit', teamId: 5, now: 2799, botId: 'r4' }));
  ok(!tooSoon.ok && tooSoon.reason === 'lineCooldown', 'still inside the raw (un-stretched) line cooldown');
  const afterRawCooldown = dir2.request(req({ lineId: 'hit', teamId: 5, now: 2801, botId: 'r5' }));
  ok(afterRawCooldown.ok, 'granted right after the RAW cooldown elapses, not the chattiness-stretched one');
}

// -- distance culling, unknown lines, disabled --
{
  const dir = createVoiceDirector({ speakerCap: 8, botCooldownMs: 0 });
  const far = dir.request(req({ distance: 400, now: 0 }));
  ok(!far.ok && far.reason === 'distance', 'a distant callout is culled before anything is built');
  const bogus = dir.request(req({ lineId: 'nope', now: 0 }));
  ok(!bogus.ok && bogus.reason === 'unknownLine', 'an unknown line id is refused');

  // A line added through the studio exists only in the override document, never in LINE_PRIORITY.
  // The typo gate used to reject exactly those, so the add-a-line feature could not reach the game
  // at all: synthesis worked, and every director request was dropped as unknownLine.
  setMapOverride('voiceLines', 'test_added_line', {
    event: 'bot_vo_test_added_line', text: 'test added line', contour: [1, 0.95], drive: 4,
    syllables: [{ vowel: 'ah', durMs: 150, gapMs: 45, peak: 0.85 }, { vowel: 'ih', durMs: 260, gapMs: 0, peak: 0.7 }],
  });
  const added = createVoiceDirector({}).request(req({ lineId: 'test_added_line', now: 0 }));
  ok(added.ok, 'a line added through the override document is allowed to speak');
  ok(added.priority === 10, 'an added line takes the default priority, not a built-in ranking');
  ok(lineIds().includes('test_added_line'), 'lineIds() sees the added line');
  ok(lineText('test_added_line') === 'test added line', 'lineText() returns the authored text for it');
  ok(voiceEventId('test_added_line') === 'bot_vo_test_added_line', 'its sample event id comes from the override');
  ok(buildVoiceLine('test_added_line') !== null, 'it builds a synth voice');
  // Ranking an added line without redefining it must also register it as real.
  setMapOverride('voiceLines', 'test_added_line', undefined);
  setMapOverride('linePriority', 'ranked_only_line', 55);
  ok(createVoiceDirector({}).request(req({ lineId: 'ranked_only_line', now: 0 })).ok,
    'a line that only appears in the priority map is real too');
  setMapOverride('linePriority', 'ranked_only_line', undefined);
  ok(!createVoiceDirector({}).request(req({ lineId: 'ranked_only_line', now: 0 })).ok,
    'and it goes back to being a typo once the override is gone');
  const off = createVoiceDirector({ enabled: false });
  ok(!off.request(req({ now: 0 })).ok, 'a disabled director speaks nothing');
}

// -- the director shares one budget with the other combat audio tracks --
{
  const budget = createAudioBudget({ globalCap: 32, categoryCaps: { voice: 3, ballistic: 20 } });
  const dir = createVoiceDirector({ budget, speakerCap: 2, botCooldownMs: 0, globalRate: { windowMs: 5000, max: 100 } });
  ok(budget.getLimits().categoryCaps.voice === 2, 'the director clamps the shared budget to its speaker cap');
  dir.request(req({ botId: 'a', teamId: 0, lineId: 'firing', now: 0, durationS: 1 }));
  ok(budget.activeCount('voice') === 1, 'a granted line holds a voice reservation on the shared budget');
  dir.reset();
  ok(budget.activeCount('voice') === 0, 'reset() hands every reservation back');
}

// -- prune keeps the bookkeeping bounded over a long session --
{
  const dir = createVoiceDirector({ speakerCap: 8, botCooldownMs: 100, dedupMs: 100, globalRate: { windowMs: 10, max: 1000 } });
  for (let i = 0; i < 200; i++) {
    dir.request(req({ botId: `b${i}`, teamId: i, lineId: 'contact', eventKey: `e${i}`, now: i * 20, durationS: 0.05 }));
    dir.request(req({ botId: `b${i}`, teamId: i, lineId: 'contact', eventKey: `e${i}`, now: i * 20, durationS: 0.05 })); // duplicate: must be refused
  }
  dir.prune(1e6);
  ok(dir.activeCount() === 0, 'nothing is left speaking after the session ends');
  const stats = dir.getStats();
  ok(stats.spoken > 0 && stats.dropped > 0, 'stats record both sides of the arbitration');
}

// -- defaults are the documented ones --
ok(VOICE_DIRECTOR_DEFAULTS.speakerCap === 3, 'default concurrent speaker cap is 3');
ok(VOICE_DIRECTOR_DEFAULTS.botCooldownMs === 4000, 'default per-bot cooldown is 4 s');

// -- lineVariants: base variant, auto-seeding, invalid-variant exclusion --
{
  ok(lineVariants('contact').length === 1, 'a line with no authored variants has exactly the base');
  ok(lineVariants('contact')[0].intensity === 0.5, 'the base variant defaults to a neutral 0.5 intensity');
  ok(lineVariants('nonexistent-line-id').length === 0, 'an unknown lineId resolves to an empty variant list, not a throw');

  const withVariants = JSON.parse(JSON.stringify(VOICE_LINES.contact));
  withVariants.variants = [
    { text: 'hostile, dead ahead', intensity: 0.9 },                          // no syllables: must auto-seed
    { text: 'no intensity here' },                                            // invalid: excluded
    { text: 'out of range', intensity: 1.4 },                                 // invalid: excluded
    { text: 'quiet contact', intensity: 0.1, syllables: seedSyllables('quiet contact') },
  ];
  setMapOverride('voiceLines', 'contact', withVariants);
  const variants = lineVariants('contact');
  ok(variants.length === 3, 'invalid variants (missing/out-of-range intensity) are excluded, valid ones kept');
  ok(variants[1].syllables && variants[1].syllables.length > 0, 'a variant missing syllables gets them auto-seeded from its text');
  setMapOverride('voiceLines', 'contact', undefined);
  ok(lineVariants('contact').length === 1, 'clearing the override returns the line to just its base variant');
}

// -- auto-seeded rhythm distinctiveness: a confirmed limitation, not a guarantee --
// The plan doc's Chapter 4/5 flagged as genuinely unverified whether seedSyllables produces enough
// rhythm diversity once pooled across many lines' variants. It does not: seedSyllables' timing
// (durMs/gapMs) is a pure function of vowel-GROUP COUNT alone (1-6), never of the actual words, so
// any two texts with the same group count are rhythmically identical regardless of wording --
// confirmed directly ("GRENADE!" and "engaging" both seed to [150,45]/[150,45]/[260,0]). With only
// 6 possible buckets and a realistic pool of a dozen-plus lines' variants, pigeonhole guarantees
// collisions. This is a real, accepted limitation of the auto-seed convenience path, not something
// this suite can or should assert away -- the studio's existing warn-highlight (renderLexList's
// nearest-neighbour report) is the actual mitigation, not a hard guarantee. What IS tested: the
// distance function itself correctly DETECTS a collision when auto-seeding produces one, so that
// warning mechanism has something real to warn about.
{
  const a = { syllables: seedSyllables('GRENADE!') };
  const b = { syllables: seedSyllables('engaging') };
  ok(variantRhythmDistance(a, b) === 0,
    'two auto-seeded variants with the same vowel-group count are correctly detected as indistinguishable (not silently treated as different)');
  ok(variantRhythmDistance({ syllables: seedSyllables('a') }, { syllables: seedSyllables('a b c d e f g') }) > 0,
    'auto-seeded variants with genuinely different group counts ARE detected as different');
}

// -- pooled rhythm distance across HAND-AUTHORED variants (real syllables, not auto-seeded) still
// holds the full guarantee -- this is what a variant meant to carry the synth voice should use.
{
  let worst = { d: 1, a: null, b: null };
  const pooled = [];
  for (const id of LINE_IDS) for (const v of VOICE_LINES[id].variants || [{ syllables: VOICE_LINES[id].syllables }]) pooled.push({ id, v });
  for (let i = 0; i < pooled.length; i++) {
    for (let j = i + 1; j < pooled.length; j++) {
      if (pooled[i].id === pooled[j].id) continue;
      const d = variantRhythmDistance(pooled[i].v, pooled[j].v);
      if (d < worst.d) worst = { d, a: pooled[i].id, b: pooled[j].id };
    }
  }
  ok(worst.d >= MIN_RHYTHM_DISTANCE || worst.a === null,
    `pooled hand-authored variants clear MIN_RHYTHM_DISTANCE (closest: ${worst.a} vs ${worst.b} at ${worst.d.toFixed(3)})`);
}

// -- variant picker: nearest match, epsilon tie round-robin, out-of-range clamp --
{
  const contactOverride = JSON.parse(JSON.stringify(VOICE_LINES.contact));
  contactOverride.variants = [
    { text: 'urgent a', intensity: 0.9 },
    { text: 'calm', intensity: 0.1 },
    { text: 'urgent b', intensity: 0.88 },
  ];
  setMapOverride('voiceLines', 'contact', contactOverride);
  const variants = lineVariants('contact');
  resetVariantRotation();

  ok(peekVariantIndex(variants, 0.1, 'test|k1') === 2, 'nearest-match picks the single closest variant deterministically');

  const key = 'test|k2';
  const seen = new Set();
  for (let i = 0; i < 4; i++) {
    const idx = peekVariantIndex(variants, 0.9, key);
    seen.add(idx);
    commitVariantIndex(key, idx);
  }
  ok(seen.has(1) && seen.has(3), 'variants within epsilon of the target round-robin rather than always picking one');
  ok(!seen.has(2), 'a variant well outside epsilon is never selected even when it ties on nothing');

  const dropped = peekVariantIndex(variants, 0.9, 'test|k3');
  ok(dropped === peekVariantIndex(variants, 0.9, 'test|k3'), 'peeking twice without a commit in between re-offers the same index (a dropped request must not burn a rotation step)');

  ok(peekVariantIndex(lineVariants('firing'), 0.99, 'test|k4') === 0, 'a single-variant line always resolves to the base regardless of target');
  ok(peekVariantIndex([], 0.5, 'test|k5') === 0, 'an empty variant list resolves to 0 rather than throwing');

  setMapOverride('voiceLines', 'contact', undefined);
  resetVariantRotation();
}

// -- voiceLexiconVariants: per-ElevenLabs-voice text, falling back to the shared lexicon --
{
  ok(voiceLexiconVariants('eleven/nobody-authored-anything', 'firing')[0].text === lineText('firing'),
    'a voice with nothing authored for a line falls back to the shared lexicon text');

  setMapOverride('voiceLexicon', 'eleven/harry', {
    contact: { variants: [{ text: 'contact, dead ahead', intensity: 0.6 }, { text: 'CONTACT! multiple hostiles!', intensity: 1.0 }] },
  });
  const harryContact = voiceLexiconVariants('eleven/harry', 'contact');
  ok(harryContact.length === 2 && harryContact[0].text === 'contact, dead ahead', 'a voice with authored content uses its own variants');
  ok(voiceLexiconVariants('eleven/sarah', 'contact')[0].text === lineText('contact'), 'a DIFFERENT voice with nothing authored still falls back, unaffected by harry\'s content');

  setMapOverride('voiceLexicon', 'eleven/adam', { firing: { variants: [{ text: 'no intensity tag' }] } });
  ok(voiceLexiconVariants('eleven/adam', 'firing')[0].text === lineText('firing'),
    'a voice whose only authored variant is invalid (no intensity) falls back rather than serving unvalidated text');

  setMapOverride('voiceLexicon', 'eleven/harry', undefined);
  setMapOverride('voiceLexicon', 'eleven/adam', undefined);
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log('bot-voice: all assertions passed.');
