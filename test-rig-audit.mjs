// Node checks for the rig and clip audit. Run with `node test-rig-audit.mjs`.
//
// These pin down the two assumptions the whole tuning apparatus rests on, so that a regression in either
// is a test failure rather than a number nobody can explain months later.

import fs from 'node:fs';
import { STADIUM_REFERENCE_SPECIES } from './stadium-reference-species.js';
import { parseGLB, readAccessor } from './stadium-glb.js';
import { mapStadiumRig } from './stadium-rig-map.js';
import {
  auditMapping, clipChannels, clipDisturbance, rankClips, sampleClipAt,
  parentMap, ancestorsOf, composeTRS, multiply, worldOf,
} from './rig-audit.js';

let failures = 0;
const results = [];
function check(name, fn) {
  try { fn(); results.push(`  ok   ${name}`); }
  catch (e) { failures++; results.push(`  FAIL ${name}\n       ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const load = (s) => {
  const { json, bin } = parseGLB(fs.readFileSync(`models/stadium/${s}.glb`));
  return { json, bin, map: mapStadiumRig(json, bin, { source: s }) };
};

// ===================== the reader =====================

check('a normalized accessor decodes to its real range, not to raw integers', () => {
  // The defect this pins: every animation rotation in these models is a normalized int16, and a reader
  // that ignored the flag returned components around 23000 where 0.707 was meant. Composed into a matrix
  // and chained down four bones, the audit reported hip travel of 1e19 leg spans.
  const { json, bin } = load('019_rattata');
  const anim = json.animations[0];
  const rot = anim.channels.find(c => c.target.path === 'rotation');
  const acc = json.accessors[anim.samplers[rot.sampler].output];
  assert(acc.normalized && acc.componentType === 5122, 'expected a normalized int16 rotation accessor');
  const v = readAccessor(json, bin, anim.samplers[rot.sampler].output);
  for (let i = 0; i + 3 < v.length; i += 4) {
    const len = Math.hypot(v[i], v[i + 1], v[i + 2], v[i + 3]);
    assert(Math.abs(len - 1) < 0.01, `quaternion ${i / 4} has length ${len.toFixed(3)}`);
  }
});

check('an un-normalized accessor is left exactly alone', () => {
  const { json, bin } = load('019_rattata');
  const anim = json.animations[0];
  const tr = anim.channels.find(c => c.target.path === 'translation');
  const acc = json.accessors[anim.samplers[tr.sampler].output];
  assert(!acc.normalized && acc.componentType === 5126, 'expected a plain float translation accessor');
  const v = readAccessor(json, bin, anim.samplers[tr.sampler].output);
  assert(v.some(x => Math.abs(x) > 1.5), 'float translations should not have been scaled into -1..1');
});

// ===================== the matrix maths =====================

check('a quarter turn about Y moves a child where it should', () => {
  // Known answer, because the FK here is hand-written and a sign error in it would quietly rescale every
  // disturbance number the audit reports.
  const s = Math.SQRT1_2;
  const parent = [-1, 0];
  const locals = [composeTRS([0, 0, 0], [0, s, 0, s], [1, 1, 1]), composeTRS([1, 0, 0], [0, 0, 0, 1], [1, 1, 1])];
  const w = worldOf(1, parent, locals);
  assert(Math.abs(w[12] - 0) < 1e-6 && Math.abs(w[14] + 1) < 1e-6,
    `expected the child at (0,0,-1), got (${w[12].toFixed(3)}, ${w[13].toFixed(3)}, ${w[14].toFixed(3)})`);
});

check('multiplying by the identity changes nothing', () => {
  const id = composeTRS([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
  const m = composeTRS([3, -1, 2], [0, 0.3826834, 0, 0.9238795], [1, 1, 1]);
  for (const [a, b] of [[id, m], [m, id]]) {
    multiply(a, b).forEach((v, i) => assert(Math.abs(v - m[i]) < 1e-6, `entry ${i} drifted`));
  }
});

// ===================== the mapping =====================

check('two chains that share most of their bones are flagged as one limb', () => {
  // Sandslash. Its four "legs" are two forelimbs walked out to two claws each: rows 0 and 1 share their
  // first three bones. Every other check passes it — both reach the floor, both are the right length, and
  // the left/right spans match beautifully, because they are the same limb.
  const { json, map } = load('028_sandslash');
  const a = auditMapping(map, json);
  const shared = a.findings.filter(f => f.code === 'shared-bones');
  assert(shared.length >= 2, `expected the shared chains to be caught, got ${a.findings.map(f => f.code).join(',')}`);
  assert(shared.every(f => f.level === 'error'), 'sharing most of a chain is an error, not a warning');
});

check('a pair with different chain lengths is flagged', () => {
  // Pikachu: six bones on the left leg and four on the right, so one of them ran on into something that
  // is not a leg. The spans still match to within 0.2%, which is why the symmetry check passes it.
  const { json, map } = load('025_pikachu');
  const a = auditMapping(map, json);
  assert(a.findings.some(f => f.code === 'asymmetric-chain'), 'the uneven chain was not caught');
  const [l, r] = map.legs;
  assert(Math.abs(l.span - r.span) / l.span < 0.01, 'this case is only interesting because the spans DO match');
});

check('the models that are actually clean come back clean', () => {
  // Ponyta and Paras. Without these the suite could pass by flagging everything.
  for (const s of ['077_ponyta', '046_paras']) {
    const { json, map } = load(s);
    const a = auditMapping(map, json);
    assert(a.errors === 0, `${s}: ${a.findings.filter(f => f.level === 'error').map(f => f.text).join('; ')}`);
  }
});

check('every model puts its feet on the floor', () => {
  // The one thing the mapper is demonstrably good at, worth keeping true.
  for (const f of STADIUM_REFERENCE_SPECIES.map(n => `${n}.glb`)) {
    const { json, map } = load(f.replace('.glb', ''));
    const a = auditMapping(map, json);
    assert(!a.findings.some(x => x.code === 'foot-high'), `${f}: ${a.findings.find(x => x.code === 'foot-high')?.text}`);
  }
});

// ===================== the clips =====================

check('every clip on every model animates a leg attach or an ancestor of one', () => {
  // The finding that matters: the viewer strips tracks targeting leg BONES, but the bone a leg hangs off
  // keeps its track, and on several models that bone is the last spine bone. So the clip is an input to
  // the gait rather than a layer on top of it, on every model, for every clip.
  for (const f of STADIUM_REFERENCE_SPECIES.map(n => `${n}.glb`)) {
    const s = f.replace('.glb', '');
    const { json, bin, map } = load(s);
    const parent = parentMap(json);
    const chains = new Set([...new Set(map.legs.map(l => l.attach))].flatMap(a => [a, ...ancestorsOf(a, parent)]));
    const clips = clipChannels(json, bin, readAccessor);
    assert(clips.length, `${s} has no clips`);
    assert(clips.every(c => [...c.nodes].some(n => chains.has(n))), `${s}: some clip leaves the legs alone`);
  }
});

check('hip disturbance is measured in leg spans and stays finite', () => {
  const { json, bin, map } = load('019_rattata');
  const strip = new Set(map.legs.flatMap(l => l.bones));
  const clips = clipChannels(json, bin, readAccessor);
  const rows = rankClips(clips.map(c => clipDisturbance(json, map, c, { strip })));
  for (const r of rows) assert(Number.isFinite(r.worst) && r.worst < 100, `${r.clip} reported ${r.worst}`);
  assert(rows[0].worst <= rows[rows.length - 1].worst, 'ranking is not sorted');
  const idle = rows.find(r => /^idle$/i.test(r.clip));
  // Rattata's idle moves the hips about 6% of a leg against a stride envelope of about 15%, so roughly
  // 0.4 of an envelope. Bounded loosely on both sides: the point is that it is neither negligible nor
  // absurd, and a change in either direction is worth someone looking at.
  assert(idle.worst > 0.02 && idle.worst < 0.15, `rattata idle moved the hips ${(idle.worst * 100).toFixed(1)}%`);
});

check('stripping the leg-bone tracks is not what makes the difference', () => {
  // If removing the leg tracks removed the disturbance, there would be nothing to report. It does not,
  // because the disturbance comes from the spine.
  const { json, bin, map } = load('128_tauros');
  const clips = clipChannels(json, bin, readAccessor);
  const idle = clips.find(c => /^idle$/i.test(c.name));
  const stripped = clipDisturbance(json, map, idle, { strip: new Set(map.legs.flatMap(l => l.bones)) });
  const whole = clipDisturbance(json, map, idle, { strip: new Set() });
  assert(Math.abs(stripped.worst - whole.worst) < 1e-9,
    `stripping leg tracks changed hip travel from ${whole.worst} to ${stripped.worst}`);
  assert(stripped.worst > 0.3, `tauros idle should be a big disturbance, got ${(stripped.worst * 100).toFixed(1)}%`);
});

// ===================== sampling a clip into a pose =====================
//
// The walker's rig stage borrows a frame of a ROM clip as a starting stance. This is checked against real
// models rather than a hand-built clip, because the bug it replaces was a wrong ASSUMPTION about the shape
// `clipChannels` returns — and a fixture built from the same wrong assumption would have agreed with it.

check('sampleClipAt returns real transforms for every shipped species', () => {
  for (const species of STADIUM_REFERENCE_SPECIES) {
    const { json, bin } = load(species);
    const clips = clipChannels(json, bin, readAccessor);
    assert(clips.length, `${species}: no clips at all`);
    const clip = clips[0];
    const frame = sampleClipAt(clip, clip.duration * 0.5);
    const nodes = Object.keys(frame);
    assert(nodes.length, `${species}: ${clip.name} sampled to nothing`);
    for (const [node, trs] of Object.entries(frame)) {
      assert(json.nodes[node], `${species}: sampled node ${node} is not in the file`);
      if (trs.q) assert(trs.q.length === 4, `${species}: rotation has ${trs.q.length} components`);
      if (trs.p) assert(trs.p.length === 3, `${species}: translation has ${trs.p.length} components`);
      if (trs.s) assert(trs.s.length === 3, `${species}: scale has ${trs.s.length} components`);
      for (const v of [...(trs.q || []), ...(trs.p || []), ...(trs.s || [])]) {
        assert(Number.isFinite(v), `${species}: non-finite value on node ${node}`);
      }
    }
  }
});

check('a sampled rotation is a unit quaternion, not a raw int16', () => {
  // readAccessor ignoring `normalized` is a bug this repo has already had once: components came back
  // around 23000 where 0.707 was meant. A magnitude check catches it wherever it comes back.
  const { json, bin } = load('019_rattata');
  const clip = clipChannels(json, bin, readAccessor)[0];
  const frame = sampleClipAt(clip, clip.duration * 0.25);
  let checked = 0;
  for (const trs of Object.values(frame)) {
    if (!trs.q) continue;
    const mag = Math.hypot(...trs.q);
    assert(Math.abs(mag - 1) < 0.02, `quaternion magnitude ${mag.toFixed(3)}, expected 1`);
    checked++;
  }
  assert(checked > 0, 'no rotations in the sampled frame');
});

check('it steps to the key at or before the time, and holds past the end', () => {
  const clip = {
    duration: 2,
    tracks: [{ node: 7, path: 'translation', stride: 3, times: [0, 1, 2], values: [0, 0, 0, 5, 5, 5, 9, 9, 9] }],
  };
  assert(sampleClipAt(clip, 0)[7].p.join() === '0,0,0', 'at t=0 should take the first key');
  assert(sampleClipAt(clip, 0.9)[7].p.join() === '0,0,0', 'before the second key it should hold the first');
  assert(sampleClipAt(clip, 1)[7].p.join() === '5,5,5', 'at a key it should take that key');
  assert(sampleClipAt(clip, 99)[7].p.join() === '9,9,9', 'past the end it should hold the last key');
});

check('a malformed or empty clip yields nothing rather than throwing', () => {
  assert(Object.keys(sampleClipAt(null, 0)).length === 0, 'null clip should be empty');
  assert(Object.keys(sampleClipAt({}, 0)).length === 0, 'clip with no tracks should be empty');
  assert(Object.keys(sampleClipAt({ tracks: [{ node: 1, path: 'weights', stride: 1, times: [0], values: [0] }] }, 0)).length === 0,
    'a weights track is not a TRS and should be skipped');
  assert(Object.keys(sampleClipAt({ tracks: [{ node: 1, path: 'rotation', stride: 4, times: [0], values: [0, 0] }] }, 0)).length === 0,
    'a truncated key should be skipped rather than emitted short');
});

console.log(results.join('\n'));
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
