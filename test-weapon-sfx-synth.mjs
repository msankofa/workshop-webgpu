// Node tests for weapon-sfx-synth.js (procedural weapon voices) against a fake AudioContext.
// Run: node test-weapon-sfx-synth.mjs
import { synthVoice, SYNTH_EVENT_IDS } from './weapon-sfx-synth.js';

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
    // `kind` is the node class; `type` is the waveform/filter mode a builder overwrites.
    this.kind = type;
    this.type = type;
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
  const build = synthVoice(eventId);
  const duration = build(ctx, destination, t0);
  return {
    duration,
    destination,
    nodes: ctx.nodes.slice(before + 1),                 // +1 skips the destination itself
    paramCalls: ctx.paramCalls.slice(beforeParams),
  };
}

// ---- id lookup ----
ok(SYNTH_EVENT_IDS.length > 0, 'SYNTH_EVENT_IDS is non-empty');
ok(synthVoice('definitely_not_a_sound') === null, 'unknown id yields null');
ok(synthVoice('') === null, 'empty id yields null');
ok(synthVoice('toString') === null, 'inherited object keys are not treated as voices');
for (const id of SYNTH_EVENT_IDS) {
  ok(typeof synthVoice(id) === 'function', `synthVoice('${id}') returns a builder`);
}

// ---- per-voice structure: duration, graph reachability, scheduling window ----
const T0 = 3.75;
for (const id of SYNTH_EVENT_IDS) {
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

// ---- documented durations ----
const EXPECTED_DURATIONS = {
  rocket_launch: 0.8,
  explosion: 1.4,
  grenade_throw: 0.25,
  grenade_bounce: 0.12,
};
for (const [id, expected] of Object.entries(EXPECTED_DURATIONS)) {
  ok(SYNTH_EVENT_IDS.includes(id), `${id} is listed in SYNTH_EVENT_IDS`);
  const ctx = new FakeCtx();
  const { duration } = runVoice(id, ctx, 0);
  ok(Math.abs(duration - expected) < 1e-9, `${id}: duration is ${expected}s (got ${duration})`);
}

// ---- the shared noise buffer is created once per context, not per shot ----
{
  const ctx = new FakeCtx();
  runVoice('rocket_launch', ctx, 1);
  ok(ctx.createBufferCalls === 1, 'first noise-using voice creates one buffer');
  runVoice('explosion', ctx, 2);
  runVoice('grenade_throw', ctx, 3);
  ok(ctx.createBufferCalls === 1, 'later voices on the same ctx reuse the cached noise buffer');

  const other = new FakeCtx();
  runVoice('explosion', other, 0);
  ok(other.createBufferCalls === 1, 'a different ctx gets its own noise buffer');

  const noiseSources = ctx.nodes.filter(n => n.kind === 'bufferSource');
  const buffers = new Set(noiseSources.map(n => n.buffer));
  ok(noiseSources.length > 1 && buffers.size === 1, 'all noise sources share one buffer instance');
}

// ---- per-shot variation actually varies ----
for (const id of SYNTH_EVENT_IDS) {
  const ctx = new FakeCtx();
  const a = runVoice(id, ctx, 0);
  const b = runVoice(id, ctx, 0);
  const key = calls => calls.map(c => `${c.param}:${c.method}:${c.value}:${c.time}`).join('|');
  ok(key(a.paramCalls) !== key(b.paramCalls), `${id}: two invocations differ in scheduled params`);
}

// ---- builders touch nothing outside the ctx/destination they are handed ----
{
  const ctx = new FakeCtx(44100);
  const { nodes, destination } = runVoice('explosion', ctx, 0);
  ok(nodes.every(n => n.ctx === ctx), 'all nodes come from the passed context');
  ok(nodes.every(n => n.outputs.every(o => o === destination || nodes.includes(o))), 'connections stay within the built graph');
  ok(destination.outputs.length === 0, 'the builder does not connect the destination onward');
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log('weapon-sfx-synth: all assertions passed.');
