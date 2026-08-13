// Node tests for bot-damage-audio.js (mechanical bot damage/death voices + the pure tier table)
// against a fake AudioContext. Run: node test-bot-damage-audio.mjs
import {
  botDamageVoice, BOT_DAMAGE_EVENT_IDS, BOT_HIT_TIER_IDS,
  botHitTier, botDeathSirenVoice, botDamageLoopVoice, botAudioSeed,
} from './bot-damage-audio.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

// ---- Minimal fake WebAudio (harness shared with test-weapon-sfx-synth.mjs) ----
class FakeParam {
  constructor(node, name) { this.node = node; this.name = name; this.value = 0; this.calls = []; }
  record(method, value, time) {
    this.calls.push({ method, value, time });
    this.node.ctx.paramCalls.push({ node: this.node, param: this.name, method, value, time });
    if (value !== undefined) this.value = value;
    return this;
  }
  setValueAtTime(v, t) { return this.record('setValueAtTime', v, t); }
  linearRampToValueAtTime(v, t) { return this.record('linearRampToValueAtTime', v, t); }
  exponentialRampToValueAtTime(v, t) { return this.record('exponentialRampToValueAtTime', v, t); }
  setTargetAtTime(v, t) { return this.record('setTargetAtTime', v, t); }
  // Sustained voices cancel their pre-scheduled automation when they are stopped early.
  cancelScheduledValues(t) { return this.record('cancelScheduledValues', undefined, t); }
}

class FakeNode {
  constructor(ctx, type) {
    this.ctx = ctx;
    this.type = type;
    // `kind` survives the builders' own `osc.type = 'square'` writes, which clobber `type`.
    // (test-weapon-sfx-synth.mjs never noticed: every voice there also has a bufferSource.)
    this.kind = type;
    this.outputs = [];
    this.startTime = null;
    this.stopTime = null;
    this.stopCalls = 0;
    ctx.nodes.push(this);
  }
  connect(target) { this.outputs.push(target); return target; }
  disconnect() { this.outputs.length = 0; }
  start(when, offset) { this.startTime = when; this.startOffset = offset; }
  stop(when) { this.stopTime = when; this.stopCalls++; }
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
  createWaveShaper() { return new FakeNode(this, 'waveShaper'); }
}

// Walks outputs to see whether a node's signal eventually reaches `destination`.
function reaches(node, destination, seen = new Set()) {
  if (node === destination) return true;
  if (seen.has(node)) return false;
  seen.add(node);
  return (node.outputs || []).some(out => reaches(out, destination, seen));
}

function runVoice(eventId, ctx, t0) {
  const before = ctx.nodes.length;
  const beforeParams = ctx.paramCalls.length;
  const destination = new FakeNode(ctx, 'destination');
  const build = botDamageVoice(eventId);
  const duration = build(ctx, destination, t0);
  return {
    duration,
    destination,
    nodes: ctx.nodes.slice(before + 1),                 // +1 skips the destination itself
    paramCalls: ctx.paramCalls.slice(beforeParams),
  };
}

function runSustained(build, ctx, t0) {
  const before = ctx.nodes.length;
  const beforeParams = ctx.paramCalls.length;
  const destination = new FakeNode(ctx, 'destination');
  const inner = build(ctx, destination, t0);
  return {
    inner,
    destination,
    nodes: ctx.nodes.slice(before + 1),
    paramCallsAt: beforeParams,
    paramCalls: ctx.paramCalls.slice(beforeParams),
    ctx,
  };
}

// ---- id lookup -------------------------------------------------------------
ok(BOT_DAMAGE_EVENT_IDS.length === 9, `BOT_DAMAGE_EVENT_IDS covers all 9 one-shots (got ${BOT_DAMAGE_EVENT_IDS.length})`);
ok(botDamageVoice('definitely_not_a_sound') === null, 'unknown id yields null');
ok(botDamageVoice('') === null, 'empty id yields null');
ok(botDamageVoice('toString') === null, 'inherited object keys are not treated as voices');
ok(botDamageVoice('bot_damage_loop') === null, 'sustained ids are not one-shot builders');
ok(botDamageVoice('bot_death_siren') === null, 'the siren is not a one-shot builder');
for (const id of BOT_DAMAGE_EVENT_IDS) {
  ok(typeof botDamageVoice(id) === 'function', `botDamageVoice('${id}') returns a builder`);
}
for (const id of BOT_HIT_TIER_IDS) {
  ok(BOT_DAMAGE_EVENT_IDS.includes(id), `${id} (a tier result) has a voice`);
}

// ---- per-voice structure: duration, graph reachability, scheduling window ----
const T0 = 3.75;
for (const id of BOT_DAMAGE_EVENT_IDS) {
  const ctx = new FakeCtx();
  const { duration, destination, nodes, paramCalls } = runVoice(id, ctx, T0);

  ok(Number.isFinite(duration) && duration > 0, `${id}: returns a positive finite duration`);
  ok(nodes.length > 0, `${id}: creates at least one node`);

  for (const node of nodes) {
    ok(reaches(node, destination), `${id}: ${node.kind} node reaches destination (not orphaned)`);
  }

  const sources = nodes.filter(n => n.kind === 'bufferSource' || n.kind === 'oscillator');
  ok(sources.length > 0, `${id}: creates at least one source node`);
  for (const src of sources) {
    ok(src.startTime !== null, `${id}: ${src.kind} is started`);
    ok(src.stopTime !== null, `${id}: ${src.kind} is stopped (nothing runs forever)`);
    ok(src.startTime >= T0 - 1e-9, `${id}: ${src.kind} does not start before t0`);
    ok(src.stopTime <= T0 + duration + 1e-9, `${id}: ${src.kind} stops within t0 + duration`);
    ok(src.stopTime >= src.startTime, `${id}: ${src.kind} stop is not before its start`);
  }

  ok(paramCalls.length > 0, `${id}: schedules AudioParam automation`);
  for (const call of paramCalls) {
    ok(Number.isFinite(call.time), `${id}: ${call.param}.${call.method} time is finite`);
    ok(call.time >= T0 - 1e-9, `${id}: ${call.param}.${call.method} is not scheduled before t0`);
    ok(call.time <= T0 + duration + 1e-9, `${id}: ${call.param}.${call.method} stays inside the voice window`);
    if (call.method === 'exponentialRampToValueAtTime') {
      ok(call.value > 0, `${id}: exponential ramp target on ${call.param} is > 0`);
    }
  }
}

// ---- documented durations --------------------------------------------------
const EXPECTED_DURATIONS = {
  bot_hit_light: 0.16,
  bot_hit_heavy: 0.62,
  bot_hit_critical: 0.8,
  bot_hit_ricochet: 0.3,
  bot_hit_blast: 0.52,
  bot_damage_spark: 0.24,
  bot_death_sting: 0.72,
  bot_death_powerdown: 1.35,
  bot_revived: 0.9,
};
for (const [id, expected] of Object.entries(EXPECTED_DURATIONS)) {
  ok(BOT_DAMAGE_EVENT_IDS.includes(id), `${id} is listed in BOT_DAMAGE_EVENT_IDS`);
  const ctx = new FakeCtx();
  const { duration } = runVoice(id, ctx, 0);
  ok(Math.abs(duration - expected) < 1e-9, `${id}: duration is ${expected}s (got ${duration})`);
}
// A light tink must stay shorter than a heavy clang, or the tiers read backwards.
ok(EXPECTED_DURATIONS.bot_hit_light < EXPECTED_DURATIONS.bot_hit_heavy, 'light is shorter than heavy');
ok(EXPECTED_DURATIONS.bot_hit_heavy < EXPECTED_DURATIONS.bot_hit_critical, 'heavy is shorter than critical');

// ---- the shared noise buffer is created once per context, not per hit -------
{
  const ctx = new FakeCtx();
  runVoice('bot_hit_light', ctx, 1);
  ok(ctx.createBufferCalls === 1, 'first noise-using voice creates one buffer');
  runVoice('bot_hit_blast', ctx, 2);
  runVoice('bot_damage_spark', ctx, 3);
  ok(ctx.createBufferCalls === 1, 'later voices on the same ctx reuse the cached noise buffer');

  const other = new FakeCtx();
  runVoice('bot_hit_blast', other, 0);
  ok(other.createBufferCalls === 1, 'a different ctx gets its own noise buffer');

  const noiseSources = ctx.nodes.filter(n => n.type === 'bufferSource');
  const buffers = new Set(noiseSources.map(n => n.buffer));
  ok(noiseSources.length > 1 && buffers.size === 1, 'all noise sources share one buffer instance');
}

// ---- per-hit variation actually varies -------------------------------------
for (const id of BOT_DAMAGE_EVENT_IDS) {
  const ctx = new FakeCtx();
  const a = runVoice(id, ctx, 0);
  const b = runVoice(id, ctx, 0);
  const key = calls => calls.map(c => `${c.param}:${c.method}:${c.value}:${c.time}`).join('|');
  ok(key(a.paramCalls) !== key(b.paramCalls), `${id}: two invocations differ in scheduled params`);
}

// ---- builders touch nothing outside the ctx/destination they are handed -----
{
  const ctx = new FakeCtx(44100);
  const { nodes, destination } = runVoice('bot_hit_critical', ctx, 0);
  ok(nodes.every(n => n.ctx === ctx), 'all nodes come from the passed context');
  ok(nodes.every(n => n.outputs.every(o => o === destination || nodes.includes(o))), 'connections stay within the built graph');
  ok(destination.outputs.length === 0, 'the builder does not connect the destination onward');
}

// ---- sustained voices ------------------------------------------------------
const SUSTAINED = [
  ['bot_death_siren', () => botDeathSirenVoice({ seed: botAudioSeed('alpha-3'), windowS: 12 })],
  ['bot_damage_loop', () => botDamageLoopVoice({ seed: botAudioSeed('bravo-7'), severity01: 0.7 })],
];
const ST0 = 2.5;
for (const [label, make] of SUSTAINED) {
  {
    const ctx = new FakeCtx();
    const { inner, destination, nodes, paramCalls } = runSustained(make(), ctx, ST0);
    ok(inner && typeof inner.stop === 'function', `${label}: builder returns an object with a callable stop`);
    ok(typeof inner.stop === 'function' && inner.stop.length <= 1, `${label}: stop takes the context time`);
    ok(nodes.length > 0, `${label}: creates nodes`);
    for (const node of nodes) ok(reaches(node, destination), `${label}: ${node.kind} reaches destination (not orphaned)`);

    const sources = nodes.filter(n => n.kind === 'bufferSource' || n.kind === 'oscillator');
    ok(sources.length > 0, `${label}: creates at least one source`);
    for (const src of sources) {
      ok(src.startTime >= ST0 - 1e-9, `${label}: ${src.kind} does not start before t0`);
      ok(src.stopTime === null, `${label}: ${src.kind} runs open-ended until stop() (that is the contract)`);
    }
    for (const call of paramCalls) {
      ok(Number.isFinite(call.time), `${label}: ${call.param}.${call.method} time is finite`);
      ok(call.time >= ST0 - 1e-9, `${label}: ${call.param}.${call.method} is not scheduled before t0`);
      if (call.method === 'exponentialRampToValueAtTime') {
        ok(call.value > 0, `${label}: exponential ramp target on ${call.param} is > 0`);
      }
    }
  }

  // stop(at) schedules at or after `at`, never before, and stops every source.
  {
    const ctx = new FakeCtx();
    const run = runSustained(make(), ctx, ST0);
    const beforeStop = ctx.paramCalls.length;
    const AT = ST0 + 4.25;
    run.inner.stop(AT);
    const after = ctx.paramCalls.slice(beforeStop);
    ok(after.length > 0, `${label}: stop() schedules a fade`);
    for (const call of after) {
      ok(call.time >= AT - 1e-9, `${label}: stop-time ${call.param}.${call.method} is not before the stop time`);
      if (call.method === 'exponentialRampToValueAtTime') ok(call.value > 0, `${label}: stop ramp target > 0`);
    }
    const sources = run.nodes.filter(n => n.kind === 'bufferSource' || n.kind === 'oscillator');
    for (const src of sources) {
      ok(src.stopTime !== null && src.stopTime >= AT - 1e-9, `${label}: ${src.kind} is stopped at or after the stop time`);
    }

    // Idempotence: the environment-audio controller handle calls stop() and the frame sweep may too.
    const paramsAfterFirst = ctx.paramCalls.length;
    const stopCallsAfterFirst = sources.map(s => s.stopCalls);
    let threw = false;
    try { run.inner.stop(AT + 1); } catch { threw = true; }
    ok(!threw, `${label}: a second stop() does not throw`);
    ok(ctx.paramCalls.length === paramsAfterFirst, `${label}: a second stop() schedules nothing more`);
    ok(sources.every((s, i) => s.stopCalls === stopCallsAfterFirst[i]), `${label}: a second stop() does not re-stop sources`);
  }

  // stop() before the start time still cannot schedule anything before t0.
  {
    const ctx = new FakeCtx();
    const run = runSustained(make(), ctx, ST0);
    const beforeStop = ctx.paramCalls.length;
    run.inner.stop(0);
    for (const call of ctx.paramCalls.slice(beforeStop)) {
      ok(call.time >= ST0 - 1e-9, `${label}: an early stop still schedules at or after t0`);
    }
  }

  // Per-bot seeding is deterministic: same seed, same graph.
  {
    const a = runSustained(make(), new FakeCtx(), ST0);
    const b = runSustained(make(), new FakeCtx(), ST0);
    const key = r => r.paramCalls.map(c => `${c.param}:${c.method}:${c.value}:${c.time}`).join('|');
    ok(key(a) === key(b), `${label}: the same seed rebuilds the same voice`);
  }
}

// Different bots must not wail in unison.
{
  const key = seed => {
    const ctx = new FakeCtx();
    const r = runSustained(botDeathSirenVoice({ seed, windowS: 12 }), ctx, 0);
    return r.paramCalls.map(c => `${c.param}:${c.method}:${c.value}:${c.time}`).join('|');
  };
  ok(key(botAudioSeed('alpha-1')) !== key(botAudioSeed('alpha-2')), 'two bots get differently-tuned sirens');
  ok(botAudioSeed('alpha-1') === botAudioSeed('alpha-1'), 'botAudioSeed is stable for an id');
  ok(botAudioSeed('alpha-1') !== botAudioSeed('alpha-2'), 'botAudioSeed separates ids');
}

// The siren winds down: alternation slows across the revive window.
{
  const ctx = new FakeCtx();
  const r = runSustained(botDeathSirenVoice({ seed: 1234, windowS: 12 }), ctx, 0);
  const toggles = r.paramCalls
    .filter(c => c.param === 'gain' && c.method === 'linearRampToValueAtTime' && c.value > 0.1)
    .map(c => c.time)
    .sort((a, b) => a - b);
  ok(toggles.length > 6, `siren schedules a run of alternations (got ${toggles.length})`);
  const first = toggles[1] - toggles[0];
  const last = toggles[toggles.length - 1] - toggles[toggles.length - 2];
  ok(last > first, `siren alternation slows over the window (${first.toFixed(3)}s -> ${last.toFixed(3)}s)`);

  const oscRamps = r.paramCalls.filter(c => c.param === 'frequency' && c.method === 'linearRampToValueAtTime');
  // The beacon must read as machinery, not as an animal. These are the properties that separate
  // "computer fault alarm" from "air-raid siren", and the wailing first version failed all three.
  ok(oscRamps.length === 0, 'no pitch ramps: a glide is what makes a siren wail');
  const steps = r.paramCalls.filter(c => c.param === 'frequency' && c.method === 'setValueAtTime');
  ok(steps.length > 6, `pitch moves in discrete steps (got ${steps.length})`);
  const freqs = [...new Set(steps.map(c => Math.round(c.value)))];
  ok(freqs.length > 2, `the beacon steps through several pitches (${freqs.length} distinct)`);
  ok(Math.max(...freqs) > Math.min(...freqs), 'and it steps downward as power fails');

  // Real silence between beeps is the other half of reading as digital.
  const gateOff = r.paramCalls.filter(c => c.param === 'gain' && c.value <= 1e-3);
  ok(gateOff.length > 6, `the gate closes fully between beeps (${gateOff.length} silences)`);

  // Beeps get quieter as the window elapses.
  const levels = r.paramCalls
    .filter(c => c.param === 'gain' && c.method === 'linearRampToValueAtTime' && c.value > 0.05)
    .map(c => c.value);
  ok(levels.length > 4 && levels[levels.length - 1] < levels[0],
    `beacon level falls over the window (${levels[0]?.toFixed(3)} -> ${levels[levels.length - 1]?.toFixed(3)})`);
}

// ---- the pure tier table ---------------------------------------------------
// Anchored to the game's own numbers: max HP 100 (DUMMY_MAX_HEALTH) and threshold01 0.60
// (botHealthSettings.threshold01, the fraction at which a bot breaks off to heal).
{
  const CFG = { maxHp: 100, threshold01: 0.60 };
  const TABLE = [
    // amount, hpBefore01, hpAfter01, cause, expected, why
    [20, 1.00, 0.80, 'bullet', 'bot_hit_light', 'five_seven on a healthy bot'],
    [24, 1.00, 0.76, 'bullet', 'bot_hit_light', 'cz_805_bren on a healthy bot'],
    [33, 1.00, 0.67, 'bullet', 'bot_hit_light', 'm1911 leaves it above the heal threshold'],
    [24, 0.80, 0.56, 'bullet', 'bot_hit_heavy', 'the shot that crosses threshold01 reads heavy'],
    [20, 0.60, 0.40, 'bullet', 'bot_hit_heavy', 'already below the heal threshold'],
    [20, 0.45, 0.25, 'bullet', 'bot_hit_critical', 'under half the heal threshold'],
    [50, 1.00, 0.50, 'knife', 'bot_hit_critical', 'knife: half the bar in one blow'],
    [95, 1.00, 0.05, 'bullet', 'bot_hit_critical', 'm24 sniper'],
    [95, 1.00, 0.05, 'blast', 'bot_hit_blast', 'grenade: cause wins over amount'],
    [110, 1.00, 0.00, 'blast', 'bot_hit_blast', 'rpg direct'],
    [3, 1.00, 0.97, 'blast', 'bot_hit_blast', 'far blast falloff is still a blast, not a ricochet'],
    [3, 1.00, 0.97, 'bullet', 'bot_hit_ricochet', 'negligible damage reads as deflected'],
    [40, 1.00, 0.60, 'ricochet', 'bot_hit_ricochet', 'an explicit ricochet cause always wins'],
    [0, 1.00, 1.00, 'bullet', 'bot_hit_ricochet', 'a zero-damage hit is never a clang'],
  ];
  for (const [amount, before, after, cause, expected, why] of TABLE) {
    const got = botHitTier(amount, before, after, cause, CFG);
    ok(got === expected, `tier(${amount}, ${before}, ${after}, ${cause}) = ${expected} (${why}) -- got ${got}`);
  }

  // The light/heavy boundary IS threshold01: move the slider, move the boundary.
  ok(botHitTier(20, 0.80, 0.60, 'bullet', { maxHp: 100, threshold01: 0.60 }) === 'bot_hit_heavy',
    'exactly at threshold01 reads heavy');
  ok(botHitTier(20, 0.80, 0.60, 'bullet', { maxHp: 100, threshold01: 0.50 }) === 'bot_hit_light',
    'lowering threshold01 makes the same hit read light');
  ok(botHitTier(20, 0.80, 0.60, 'bullet', { maxHp: 100, threshold01: 0.70 }) === 'bot_hit_heavy',
    'raising threshold01 makes the same hit read heavy');

  // Purity + robustness.
  ok(botHitTier(20, 1, 0.8, 'bullet', CFG) === botHitTier(20, 1, 0.8, 'bullet', CFG), 'the tier function is pure');
  ok(BOT_HIT_TIER_IDS.includes(botHitTier(NaN, 1.0, 0.5, 'bullet', CFG)), 'a non-finite amount still yields a tier');
  ok(botHitTier(NaN, 1.0, 0.5, 'bullet', CFG) === 'bot_hit_critical',
    'a missing amount falls back to the HP delta (0.5 of the bar = critical)');
  ok(BOT_HIT_TIER_IDS.includes(botHitTier(20, 1, 0.8, undefined, CFG)), 'a missing cause still yields a tier');
  ok(botHitTier(20, 1, 0.8, 'bullet') !== null, 'a missing cfg falls back to defaults');
  // maxHp scaling: the same absolute damage is a bigger deal on a smaller bar.
  ok(botHitTier(30, 1.0, 0.85, 'bullet', { maxHp: 200, threshold01: 0.6 }) === 'bot_hit_light',
    '30 damage off a 200 HP bar is light');
  ok(botHitTier(30, 1.0, 0.40, 'bullet', { maxHp: 50, threshold01: 0.6 }) === 'bot_hit_critical',
    '30 damage off a 50 HP bar is critical');
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log('bot-damage-audio: all assertions passed.');
