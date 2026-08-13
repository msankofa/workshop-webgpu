// Node tests for ballistic-audio.js (closest-approach geometry, whizz/ricochet gating, and the
// two procedural voices) against a fake AudioContext.
// Run: node test-ballistic-audio.mjs
import {
  closestApproach, evaluateWhizz, evaluateRicochet, ricochetChance, pickImpactVoice,
  grazingFactor, surfaceClass, bulletSpeedFor, createWhizzVoice, createProjectileWhizzTracker,
  synthVoice, SYNTH_EVENT_IDS,
  WHIZZ_MAX_DIST, WHIZZ_MAX_DELAY_S, DEFAULT_BULLET_SPEED, RICOCHET_BASE,
} from './ballistic-audio.js';
import { shotMissDistance } from './bot-alert.js';
import { WEAPONS } from './weapons.js';

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
    // `kind` survives the builders' own `osc.type = 'sawtooth'` writes, which clobber `type`.
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
}

// Walks outputs to see whether a node's signal eventually reaches `destination`.
function reaches(node, destination, seen = new Set()) {
  if (node === destination) return true;
  if (seen.has(node)) return false;
  seen.add(node);
  return (node.outputs || []).some(out => reaches(out, destination, seen));
}

// ---- harness: run an arbitrary builder, not just a registry id ----
function runBuild(build, ctx, t0) {
  const before = ctx.nodes.length;
  const beforeParams = ctx.paramCalls.length;
  const destination = new FakeNode(ctx, 'destination');
  const duration = build(ctx, destination, t0);
  return {
    duration,
    destination,
    nodes: ctx.nodes.slice(before + 1),                 // +1 skips the destination itself
    paramCalls: ctx.paramCalls.slice(beforeParams),
  };
}
function runVoice(eventId, ctx, t0) { return runBuild(synthVoice(eventId), ctx, t0); }

// Deterministic rng so ricochet assertions are never flaky.
function lcg(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const constRng = v => () => v;

// ========================= geometry =========================
{
  const origin = { x: 0, y: 0, z: 0 };
  const dir = { x: 1, y: 0, z: 0 };

  // Perpendicular miss mid-segment.
  const mid = closestApproach(origin, dir, 100, { x: 30, y: 0, z: 2 });
  ok(Math.abs(mid.t - 30) < 1e-9, 'closestApproach: t is the projection along dir');
  ok(Math.abs(mid.distance - 2) < 1e-9, 'closestApproach: perpendicular distance');
  ok(Math.abs(mid.point.x - 30) < 1e-9 && Math.abs(mid.point.z) < 1e-9, 'closestApproach: point sits on the segment');

  // Clamp at the near end (listener behind the muzzle).
  const behind = closestApproach(origin, dir, 100, { x: -5, y: 0, z: 0 });
  ok(behind.t === 0, 'closestApproach: clamps t at 0 behind the origin');
  ok(Math.abs(behind.distance - 5) < 1e-9, 'closestApproach: distance measured from the origin when clamped low');

  // Clamp at the far end (listener past where the round stopped).
  const past = closestApproach(origin, dir, 10, { x: 40, y: 0, z: 3 });
  ok(Math.abs(past.t - 10) < 1e-9, 'closestApproach: clamps t at travelled');
  ok(Math.abs(past.distance - Math.hypot(30, 3)) < 1e-9, 'closestApproach: distance measured from the endpoint when clamped high');
  ok(Math.abs(past.point.x - 10) < 1e-9, 'closestApproach: clamped point is the segment end');

  // Zero / non-finite travelled degrades to the origin rather than exploding.
  ok(closestApproach(origin, dir, 0, { x: 5, y: 0, z: 0 }).t === 0, 'closestApproach: travelled 0 clamps everything to the origin');
  ok(closestApproach(origin, dir, NaN, { x: 5, y: 0, z: 0 }).t === 0, 'closestApproach: non-finite travelled is treated as 0');

  // Array vectors read identically to {x,y,z} ones (combat.js speaks arrays).
  const asArrays = closestApproach([0, 0, 0], [1, 0, 0], 100, [30, 0, 2]);
  ok(Math.abs(asArrays.distance - mid.distance) < 1e-12, 'closestApproach: accepts [x,y,z] and {x,y,z} interchangeably');
}

// Agreement with bot-alert.js's shotMissDistance across randomized geometry: the two must never
// drift, since the alert FSM and the whizz are describing the same event.
{
  const rnd = lcg(20260731);
  let worst = 0;
  for (let i = 0; i < 2000; i++) {
    const origin = { x: (rnd() - 0.5) * 60, y: (rnd() - 0.5) * 10, z: (rnd() - 0.5) * 60 };
    let dx = rnd() - 0.5, dy = (rnd() - 0.5) * 0.4, dz = rnd() - 0.5;
    const dl = Math.hypot(dx, dy, dz) || 1;
    const dir = { x: dx / dl, y: dy / dl, z: dz / dl };
    const travelled = rnd() * 120;
    const p = { x: (rnd() - 0.5) * 120, y: (rnd() - 0.5) * 20, z: (rnd() - 0.5) * 120 };
    const diff = Math.abs(closestApproach(origin, dir, travelled, p).distance - shotMissDistance(origin, dir, travelled, p));
    if (diff > worst) worst = diff;
  }
  ok(worst < 1e-9, `closestApproach matches bot-alert.shotMissDistance (worst delta ${worst})`);
}

// ========================= whizz gating =========================
{
  const origin = [0, 1.6, 0];
  const dir = [0, 0, 1];
  const base = { origin, dir, travelled: 100, listenerPos: [1, 1.6, 40] };

  const hit = evaluateWhizz(base);
  ok(hit && Math.abs(hit.distance - 1) < 1e-9, 'evaluateWhizz: a 1 m miss inside maxDist produces an event');
  ok(hit && Math.abs(hit.point.z - 40) < 1e-9, 'evaluateWhizz: point is the closest point on the shot line');

  ok(evaluateWhizz({ ...base, listenerPos: [WHIZZ_MAX_DIST + 0.5, 1.6, 40] }) === null,
    'evaluateWhizz: beyond maxDist returns null');
  ok(evaluateWhizz({ ...base, maxDist: 0.5 }) === null, 'evaluateWhizz: a tighter maxDist gates it out');
  ok(evaluateWhizz({ ...base, shooterId: 'host', listenerId: 'host' }) === null,
    'evaluateWhizz: your own round never whizzes past you');
  ok(evaluateWhizz({ ...base, shooterId: 'bot3', listenerId: 'host' }) !== null,
    'evaluateWhizz: someone else\'s round still whizzes');
  ok(evaluateWhizz({ ...base, shooterId: null, listenerId: null }) !== null,
    'evaluateWhizz: unknown ids do not gate (harness camera listener)');
  ok(evaluateWhizz({ origin, dir, travelled: 100, listenerPos: null }) === null,
    'evaluateWhizz: missing listener returns null');

  // A round that stopped short never reaches a listener further down the line.
  ok(evaluateWhizz({ ...base, travelled: 5 }) === null,
    'evaluateWhizz: a round that stopped at 5 m does not whizz past a listener at 40 m');

  // Delay scales with t and inversely with the weapon's tracer speed.
  const noWeapon = evaluateWhizz(base);
  ok(Math.abs(noWeapon.delaySeconds - 40 / DEFAULT_BULLET_SPEED) < 1e-9,
    'evaluateWhizz: no weapon falls back to the default bullet speed');
  const slow = evaluateWhizz({ ...base, weapon: WEAPONS.m1911 });
  const fast = evaluateWhizz({ ...base, weapon: WEAPONS.m24 });
  ok(Math.abs(slow.delaySeconds - 40 / 350) < 1e-9, 'evaluateWhizz: m1911 delay uses tracerFx.speed 350');
  ok(Math.abs(fast.delaySeconds - 40 / 850) < 1e-9, 'evaluateWhizz: m24 delay uses tracerFx.speed 850');
  ok(slow.delaySeconds > fast.delaySeconds, 'evaluateWhizz: a slower round arrives later');
  ok(bulletSpeedFor(WEAPONS.cz_805_bren) === 820, 'bulletSpeedFor: cz_805_bren is 820');
  ok(bulletSpeedFor(null) === DEFAULT_BULLET_SPEED, 'bulletSpeedFor: null weapon falls back to the default');
  ok(bulletSpeedFor({ tracerFx: { speed: 0 } }) === DEFAULT_BULLET_SPEED, 'bulletSpeedFor: a zero speed falls back');

  const near = evaluateWhizz({ ...base, listenerPos: [1, 1.6, 10] });
  ok(near.delaySeconds < noWeapon.delaySeconds, 'evaluateWhizz: delay scales with t along the shot');

  const far = evaluateWhizz({ origin, dir, travelled: 5000, listenerPos: [1, 1.6, 4000] });
  ok(far.delaySeconds === WHIZZ_MAX_DELAY_S, 'evaluateWhizz: delay is clamped at WHIZZ_MAX_DELAY_S');
}

// ========================= ricochet rules =========================
const rockHit = kindNormal => ({ kind: 'obstacle', id: 'r:12.00,4.00', normal: kindNormal });
const woodHit = kindNormal => ({ kind: 'obstacle', id: 't:12.00,4.00', normal: kindNormal });
const worldHit = kindNormal => ({ kind: 'world', id: null, normal: kindNormal });
const terrainHit = kindNormal => ({ kind: 'terrain', id: null, normal: kindNormal });

{
  ok(surfaceClass({ kind: 'obstacle', id: 't:1,2' }) === 'wood', 'surfaceClass: t: prefix is wood');
  ok(surfaceClass({ kind: 'obstacle', id: 'r:1,2' }) === 'rock', 'surfaceClass: r: prefix is rock');
  ok(surfaceClass({ kind: 'obstacle', id: null }) === 'obstacle', 'surfaceClass: unprefixed obstacle stays generic');
  ok(surfaceClass({ kind: 'world' }) === 'world', 'surfaceClass: world geometry');
  ok(surfaceClass({ kind: 'terrain' }) === 'terrain', 'surfaceClass: terrain');
  for (const k of ['player', 'creature', 'mob']) ok(surfaceClass({ kind: k }) === 'flesh', `surfaceClass: ${k} is flesh`);
  ok(surfaceClass({ kind: 'none' }) === null, 'surfaceClass: a clean miss has no surface');
  ok(surfaceClass(null) === null, 'surfaceClass: null hit has no surface');

  // Grazing factor.
  ok(Math.abs(grazingFactor([0, 0, 1], [0, 0, -1])) < 1e-12, 'grazingFactor: head-on is 0');
  ok(Math.abs(grazingFactor([0, 0, 1], [0, 1, 0]) - 1) < 1e-12, 'grazingFactor: tangential is 1');
  ok(grazingFactor([0, 0, 1], null) === 0, 'grazingFactor: a missing normal yields 0');
  ok(grazingFactor([0, 0, 1], [0, 0, 0]) === 0, 'grazingFactor: a degenerate normal yields 0');
  const g = grazingFactor([1, 0, 0], [-Math.SQRT1_2, 0, -Math.SQRT1_2]);
  ok(Math.abs(g - (1 - Math.SQRT1_2)) < 1e-12, 'grazingFactor: 45 deg is 1 - cos45');

  // Flesh never ricochets, whatever the angle or the roll.
  const tangentDir = [1, 0, 0];
  for (const k of ['player', 'creature', 'mob']) {
    const hit = { kind: k, id: 'x', normal: [0, 0, 1] };
    ok(ricochetChance(hit, tangentDir) === 0, `${k}: ricochet chance is exactly 0`);
    ok(evaluateRicochet({ hit, dir: tangentDir, rng: constRng(0) }) === false, `${k}: never ricochets even on rng 0`);
    ok(pickImpactVoice(hit, tangentDir, constRng(0)) === 'enemy_hit', `${k}: impact voice is enemy_hit`);
  }

  // Perpendicular hits essentially never ricochet (cubed grazing curve).
  const headOn = [0, 0, 1];
  const flat = [0, 0, -1];
  for (const mk of [rockHit, worldHit, woodHit, terrainHit]) {
    ok(ricochetChance(mk(flat), headOn) === 0, 'perpendicular hit: ricochet chance is 0');
    ok(evaluateRicochet({ hit: mk(flat), dir: headOn, rng: constRng(0) }) === false, 'perpendicular hit: never ricochets');
  }
  // 10 degrees off perpendicular is still vanishingly rare.
  const nearPerp = [0, Math.sin(0.1745), Math.cos(0.1745)];
  ok(ricochetChance(worldHit(flat), nearPerp) < 0.001, 'near-perpendicular world hit: chance under 0.1%');

  // A clean miss has no impact voice at all.
  ok(pickImpactVoice({ kind: 'none' }, headOn, constRng(0)) === null, 'a miss produces no impact voice');
  ok(pickImpactVoice(null, headOn, constRng(0)) === null, 'a null hit produces no impact voice');

  // Grazing angle: hard surfaces ricochet far more often than soft ones. Same geometry, same
  // rng stream, so the only variable is the surface base chance.
  const graze = [0.9962, 0, -0.0872]; // ~5 deg off tangential
  const wall = [0, 0, 1];
  const rate = (mk) => {
    const rng = lcg(7);
    let n = 0;
    for (let i = 0; i < 20000; i++) if (evaluateRicochet({ hit: mk(wall), dir: graze, rng })) n++;
    return n / 20000;
  };
  const rRock = rate(rockHit), rWorld = rate(worldHit), rWood = rate(woodHit), rTerrain = rate(terrainHit);
  ok(rRock > rWood, `grazing rock ricochets more than wood (${rRock.toFixed(3)} vs ${rWood.toFixed(3)})`);
  ok(rWorld > rTerrain, `grazing world geometry ricochets more than terrain (${rWorld.toFixed(3)} vs ${rTerrain.toFixed(3)})`);
  ok(rRock > rTerrain && rWorld > rWood, 'grazing hard surfaces beat both soft surfaces');
  ok(rWood > 0 && rTerrain > 0, 'soft surfaces still ricochet occasionally at a grazing angle');
  ok(rWorld > 0.3 && rWorld < 0.6, `grazing world ricochet rate is in a sane band (${rWorld.toFixed(3)})`);

  // Base-chance ordering is the thing the rates depend on; assert it directly too.
  ok(RICOCHET_BASE.world > RICOCHET_BASE.obstacle && RICOCHET_BASE.rock > RICOCHET_BASE.wood,
    'RICOCHET_BASE ranks hard surfaces above soft ones');

  // A ricochet REPLACES the impact: pickImpactVoice returns exactly one id, never two.
  const rng = lcg(3);
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(pickImpactVoice(rockHit(wall), graze, rng));
  ok(seen.size === 2 && seen.has('bullet_ricochet') && seen.has('bullet_impact'),
    'pickImpactVoice: a grazing rock hit yields either a ricochet or an impact, never both');
}

// ========================= projectile proximity tracker =========================
{
  const tracker = createProjectileWhizzTracker({ radius: 5 });
  const listener = { x: 0, y: 0, z: 0 };
  const fired = [];
  // A grenade arcing past: 12 -> 6 (outside), 4 -> 2 (closing), then receding.
  for (const z of [12, 6, 4, 2, 3, 6, 9]) {
    const ev = tracker.step('g1', { x: 0, y: 0, z }, listener);
    if (ev) fired.push({ z, ev });
  }
  ok(fired.length === 1, `projectile tracker fires exactly once per projectile (got ${fired.length})`);
  ok(fired[0].z === 3, 'projectile tracker fires on the first receding tick');
  ok(Math.abs(fired[0].ev.distance - 2) < 1e-9, 'projectile tracker reports the closest approach seen');

  // Never entering the radius fires nothing.
  for (const z of [20, 14, 9, 14, 20]) ok(tracker.step('g2', { x: 0, y: 0, z }, listener) === null, 'a distant projectile never fires');

  // Still-approaching projectiles have not fired yet.
  ok(tracker.step('g3', { x: 0, y: 0, z: 3 }, listener) === null, 'first tick inside the radius does not fire');
  ok(tracker.step('g3', { x: 0, y: 0, z: 1 }, listener) === null, 'a closing projectile does not fire');

  // Retention prunes dead projectiles.
  ok(tracker.size() === 3, 'tracker holds one state per seen projectile');
  tracker.retain(new Set(['g3']));
  ok(tracker.size() === 1, 'retain() drops states for projectiles that no longer exist');
  tracker.forget('g3');
  ok(tracker.size() === 0, 'forget() drops a single state');
}

// ========================= voices =========================
ok(SYNTH_EVENT_IDS.length === 2, 'SYNTH_EVENT_IDS holds exactly the two ballistic ids');
ok(SYNTH_EVENT_IDS.includes('bullet_whizz') && SYNTH_EVENT_IDS.includes('bullet_ricochet'),
  'SYNTH_EVENT_IDS matches the sound-events.js ballistic ids');
ok(synthVoice('definitely_not_a_sound') === null, 'unknown id yields null');
ok(synthVoice('') === null, 'empty id yields null');
ok(synthVoice('toString') === null, 'inherited object keys are not treated as voices');
for (const id of SYNTH_EVENT_IDS) ok(typeof synthVoice(id) === 'function', `synthVoice('${id}') returns a builder`);

// Every builder shape this module can produce: the registry defaults plus parameterized whizzes
// across the whole distance/delay range.
const BUILDERS = [
  ['bullet_whizz (registry)', synthVoice('bullet_whizz')],
  ['bullet_ricochet (registry)', synthVoice('bullet_ricochet')],
  ['whizz d=0.2 delay=0', createWhizzVoice({ distance: 0.2, delaySeconds: 0 })],
  ['whizz d=0.2 delay=0.12', createWhizzVoice({ distance: 0.2, delaySeconds: 0.12 })],
  ['whizz d=3 delay=0.29', createWhizzVoice({ distance: 3, delaySeconds: 0.29 })],
  ['whizz d=6 delay=0.6', createWhizzVoice({ distance: WHIZZ_MAX_DIST, delaySeconds: WHIZZ_MAX_DELAY_S })],
  ['whizz defaults', createWhizzVoice()],
  ['whizz custom maxDist', createWhizzVoice({ distance: 3.5, delaySeconds: 0.05, maxDist: 7 })],
];

const T0 = 3.75;
for (const [label, build] of BUILDERS) {
  const ctx = new FakeCtx();
  const { duration, destination, nodes, paramCalls } = runBuild(build, ctx, T0);

  ok(Number.isFinite(duration) && duration > 0, `${label}: returns a positive finite duration`);
  ok(nodes.length > 0, `${label}: creates at least one node`);

  for (const node of nodes) ok(reaches(node, destination), `${label}: ${node.kind} node reaches destination (not orphaned)`);

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
      ok(call.value > 0, `${label}: exponential ramp target on ${call.param} is > 0 (Web Audio throws on 0)`);
    }
  }
}

// ---- documented durations ----
{
  const ctx = new FakeCtx();
  ok(Math.abs(runVoice('bullet_ricochet', ctx, 0).duration - 0.42) < 1e-9, 'bullet_ricochet: duration is 0.42s');
}

// ---- the whizz delay actually lands inside the returned duration ----
{
  const ctx = new FakeCtx();
  const DELAY = 0.25;
  const { duration, nodes } = runBuild(createWhizzVoice({ distance: 1, delaySeconds: DELAY }), ctx, T0);
  ok(duration > DELAY, 'whizz: the returned duration covers its own pre-delay');
  const sources = nodes.filter(n => n.kind === 'bufferSource');
  ok(sources.every(s => s.startTime >= T0 + DELAY - 1e-9), 'whizz: nothing sounds before the round arrives');
}

// ---- distance shapes the voice: closer = louder, brighter, shorter ----
{
  const peakOf = calls => Math.max(...calls.filter(c => c.param === 'gain').map(c => c.value));
  const brightestOf = calls => Math.max(...calls.filter(c => c.param === 'frequency').map(c => c.value));
  const near = runBuild(createWhizzVoice({ distance: 0.3 }), new FakeCtx(), 0);
  const far = runBuild(createWhizzVoice({ distance: 5.7 }), new FakeCtx(), 0);
  ok(peakOf(near.paramCalls) > peakOf(far.paramCalls), 'whizz: a closer pass is louder');
  ok(brightestOf(near.paramCalls) > brightestOf(far.paramCalls), 'whizz: a closer pass is brighter');
  ok(near.duration < far.duration, 'whizz: a closer pass is shorter');
  ok(near.nodes.length > far.nodes.length, 'whizz: only a close pass adds the supersonic crack layer');
}

// ---- the shared noise buffer is created once per context, not per shot ----
{
  const ctx = new FakeCtx();
  runVoice('bullet_whizz', ctx, 1);
  ok(ctx.createBufferCalls === 1, 'first noise-using voice creates one buffer');
  runVoice('bullet_ricochet', ctx, 2);
  runBuild(createWhizzVoice({ distance: 0.4 }), ctx, 3);
  ok(ctx.createBufferCalls === 1, 'later voices on the same ctx reuse the cached noise buffer');

  const other = new FakeCtx();
  runVoice('bullet_ricochet', other, 0);
  ok(other.createBufferCalls === 1, 'a different ctx gets its own noise buffer');

  const noiseSources = ctx.nodes.filter(n => n.kind === 'bufferSource');
  const buffers = new Set(noiseSources.map(n => n.buffer));
  ok(noiseSources.length > 1 && buffers.size === 1, 'all noise sources share one buffer instance');
}

// ---- per-shot variation actually varies ----
for (const [label, build] of BUILDERS) {
  const ctx = new FakeCtx();
  const a = runBuild(build, ctx, 0);
  const b = runBuild(build, ctx, 0);
  const key = calls => calls.map(c => `${c.param}:${c.method}:${c.value}:${c.time}`).join('|');
  ok(key(a.paramCalls) !== key(b.paramCalls), `${label}: two invocations differ in scheduled params`);
}

// ---- builders touch nothing outside the ctx/destination they are handed ----
for (const [label, build] of BUILDERS) {
  const ctx = new FakeCtx(44100);
  const { nodes, destination } = runBuild(build, ctx, 0);
  ok(nodes.every(n => n.ctx === ctx), `${label}: all nodes come from the passed context`);
  ok(nodes.every(n => n.outputs.every(o => o === destination || nodes.includes(o))), `${label}: connections stay within the built graph`);
  ok(destination.outputs.length === 0, `${label}: the builder does not connect the destination onward`);
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed.`);
  process.exit(1);
}
console.log('ballistic-audio: all assertions passed.');
