/**
 * Twelve eye appearances on eight mounts, every one of the 96 EVALUATED in Node.
 *
 * Reaching real coverage took three corrections, each of which had passed a canary while running nothing:
 * `Fn(body)()` does not run the body; a throw inside an `If` callback does not escape, because the callback
 * is stored and replayed during the shader build; and TSL coerces types freely, so a wrong argument is
 * often not an error at all. What works is an explicit stack plus every appearance being a named function
 * the branch merely calls — then calling it here means something. Verified by making one style call an
 * unimported function: 88 of 96 ran and the suite failed.
 *
 * None of this says whether any of it LOOKS right. That is the user's to judge in a browser.
 */
import { vec2, vec3, float, uniform, stack, setCurrentStack } from 'three/tsl';
import {
  createBugEyes, EYE_STYLES, EYE_MODIFIERS, STYLE_INDEX, MODIFIER_KEYS,
  OCELLI, GEM_PLANES, STALK_REACH, ocellusRadius,
} from './demos/bug-eyes.js';

let pass = 0, fail = 0;
const ok = (cond, label, why) => {
  if (cond) { pass++; } else { fail++; console.log(`  FAIL ${label}${why ? '\n        ' + why : ''}`); }
};
const section = (t) => console.log('\n' + t);

const EYE = { at: [0.135, 0.288, 0.452], r: 0.086 };

// ---------------------------------------------------------------------------------------------------
section('1. appearance and mount are separate axes, which is the whole point of the split');
ok(EYE_STYLES.length === 12, `twelve appearances (${EYE_STYLES.length})`);
ok(EYE_MODIFIERS.length === 3, `three mounts (${EYE_MODIFIERS.length})`);
ok(new Set(EYE_STYLES.map((s) => s.key)).size === 12, 'every style key is unique');
ok(new Set(EYE_STYLES.map((s) => s.label)).size === 12, 'every style label is unique');
ok(new Set(MODIFIER_KEYS).size === 3, 'every mount key is unique');
for (const [key, i] of Object.entries(STYLE_INDEX)) {
  ok(EYE_STYLES[i].key === key, `STYLE_INDEX.${key} points at its own entry`);
}
ok(STYLE_INDEX.bead === 0, 'the original bead is index 0, so it is what the page defaults to');
// No mount may be a style, or the two axes collapse back into one dropdown.
for (const k of MODIFIER_KEYS) {
  ok(!(k in STYLE_INDEX), `the mount '${k}' is NOT also an appearance`,
    'a mount in the dropdown would force a choice between structure and looks, which is the bug being fixed');
}
ok(MODIFIER_KEYS.join() === 'stalk,ocelli,gem', `the mounts are the expected three (${MODIFIER_KEYS})`);
for (const m of EYE_MODIFIERS) {
  ok(typeof m.cost === 'string' && m.cost.length > 10, `the mount '${m.key}' states what it costs`);
}
// 12 x 8 is the number the panel now offers.
ok(EYE_STYLES.length * 2 ** EYE_MODIFIERS.length === 96, 'twelve appearances on eight mounts is 96 eyes');

// ---------------------------------------------------------------------------------------------------
section('2. the geometry constants are self-consistent');
{
  // A folded wedge only produces a true distance if each ocellus fits inside its own wedge — and that has
  // to hold across the WHOLE slider, not at the authored count. At the fixed radius it held to 8 eyes and
  // failed at 9 and 10, both of which the slider reaches, so the radius is derived from the count.
  for (let n = 3; n <= 10; n++) {
    for (const eyeSize of [0.6, 1.0, 1.5]) {
      const halfWedge = OCELLI.ring * Math.sin(Math.PI / n);
      const r = ocellusRadius(n, eyeSize);
      ok(r < halfWedge && r > 0.002,
        `${n} ocelli at eye size ${eyeSize} fit their wedges`,
        `radius ${(r * 1000).toFixed(1)}mm vs half-wedge ${(halfWedge * 1000).toFixed(1)}mm`);
    }
  }
  ok(ocellusRadius(6, 1) === OCELLI.radius,
    'at the authored count the derived radius is still the authored one');
  ok(ocellusRadius(10, 1) < OCELLI.radius, 'and a crowded ring shrinks its eyes rather than overlapping');
  ok(OCELLI.ring + OCELLI.radius < EYE.r * 1.5 + STALK_REACH,
    'the cluster stays within reach of the bound the page already computes');
  for (const n of GEM_PLANES) {
    const len = Math.hypot(...n);
    ok(len > 0.3, `gem plane [${n}] is long enough to normalise safely`, `length ${len.toFixed(3)}`);
  }
  ok(GEM_PLANES.length >= 4, `enough planes to read as a cut stone (${GEM_PLANES.length})`);
  ok(STALK_REACH > EYE.r, 'a stalk carries the eyeball clear of the head',
    `reach ${STALK_REACH} vs eye radius ${EYE.r}`);
}

// ---------------------------------------------------------------------------------------------------
section('3. the module refuses to be built wrong');
{
  let threw = false;
  try { createBugEyes({}); } catch { threw = true; }
  ok(threw, 'createBugEyes rejects a missing EYE');
  threw = false;
  try { createBugEyes({ EYE: { at: [0, 0, 0] } }); } catch { threw = true; }
  ok(threw, 'and rejects an EYE with no radius');
}

// ---------------------------------------------------------------------------------------------------
section('4. every appearance is EXECUTED, on every mount');
//
// Not "the graph builds" — see the file header for the three ways that claim was false. Each appearance is
// fetched by name from `eyeStyleBodies` and called, which is the only arrangement that actually runs it.
const eyes = createBugEyes({ EYE });

// TSL reports a wrong argument count as a console WARNING, not an exception — `mx_hsvtorgb(a,b,c,d,e)`
// runs to completion and merely complains. So execution is not enough on its own: the warnings have to be
// treated as failures, or an arity mistake reaches the GPU with every test still green.
const tslNoise = [];
for (const level of ['warn', 'error']) {
  const original = console[level];
  console[level] = (...args) => {
    const text = args.map(String).join(' ');
    if (/THREE|TSL/i.test(text)) tslNoise.push(text.replace(/\s+/g, ' ').slice(0, 160));
    else original(...args);
  };
}
const fresh = () => { setCurrentStack(stack()); };

const MOUNTS = [];
for (const s of [0, 1]) for (const o of [0, 1]) for (const g of [0, 1]) MOUNTS.push({ stalk: s, ocelli: o, gem: g });

const ctx = (over = {}) => ({
  pA: vec3(0.14, 0.30, 0.52),
  rdA: vec3(0.1, -0.2, 0.97).normalize(),
  LA: vec3(-0.4, 0.7, 0.6).normalize(),
  nA: vec3(0.2, 0.3, 0.93).normalize(),
  bob: float(0.003),
  side: float(1),
  style: uniform(0),
  eyeSize: uniform(1.0),
  stalkOn: uniform(0), stalkLen: uniform(1.0),
  ocelliOn: uniform(0), ocelliCount: uniform(OCELLI.count),
  gemOn: uniform(0),
  sh: float(1),
  time: uniform(0),
  bounceCol: vec3(0.20, 0.42, 0.14),
  tint: vec3(0.42, 0.24, 0.10),
  gloss: uniform(1.0),
  pupil: uniform(0.34),
  facets: uniform(7.0),
  ...over,
});
const fieldCtx = (over = {}) => ({
  pm: vec3(0.14, 0.30, 0.52), side: float(1), bob: float(0.003), eyeSize: uniform(1.0),
  stalkOn: uniform(0), stalkLen: uniform(1.0),
  ocelliOn: uniform(0), ocelliCount: uniform(OCELLI.count),
  gemOn: uniform(0),
  ...over,
});

ok(MOUNTS.length === 8, `all eight mount combinations enumerated (${MOUNTS.length})`);

// The guard first, because everything below is only meaningful if a missing argument is loud. TSL builds
// happily out of `undefined`, which is how a forgotten argument used to reach the GPU.
{
  let threw = '';
  fresh();
  try { const bad = ctx(); delete bad.nA; eyes.eyeColour(bad); } catch (e) { threw = e.message; }
  ok(threw.includes('nA'), 'a missing argument throws and names itself', threw || 'it did not throw');
  threw = '';
  fresh();
  try { const bad = fieldCtx(); delete bad.gemOn; eyes.eyeDistance(bad); } catch (e) { threw = e.message; }
  ok(threw.includes('gemOn'), 'and so does one missing from the field', threw || 'it did not throw');
}

{
  let err = null, built = null;
  fresh();
  try { built = eyes.eyeColour(ctx()); } catch (e) { err = e; }
  ok(built !== null, 'eyeColour executes', err ? String(err.message).slice(0, 300) : '');
  fresh();
  err = null; built = null;
  try { built = eyes.eyeDistance(fieldCtx()); } catch (e) { err = e; }
  ok(built !== null, 'eyeDistance executes', err ? String(err.message).slice(0, 300) : '');
}
{
  // Every appearance is present as a body, so the dropdown cannot offer one that does not exist.
  fresh();
  const bodies = eyes.eyeStyleBodies(ctx());
  for (const st of EYE_STYLES) {
    ok(typeof bodies[st.key] === 'function', `'${st.key}' has a body to call`);
  }
  ok(Object.keys(bodies).length === EYE_STYLES.length,
    `exactly ${EYE_STYLES.length} bodies, no strays (${Object.keys(bodies).length})`);
}
{
  // THE POINT OF THE SPLIT: every appearance on every mount, all 96, each body ACTUALLY CALLED.
  const failures = [];
  let calls = 0;
  for (const st of EYE_STYLES) {
    for (const mnt of MOUNTS) {
      fresh();
      try {
        const b = eyes.eyeStyleBodies(ctx({
          style: float(STYLE_INDEX[st.key]),
          stalkOn: float(mnt.stalk), ocelliOn: float(mnt.ocelli), gemOn: float(mnt.gem),
        }));
        const col = b[st.key]();
        if (col === undefined || col === null) throw new Error('returned nothing');
        calls++;
      } catch (e) { failures.push(`${st.key} on ${JSON.stringify(mnt)}: ${e.message}`); }
    }
  }
  ok(failures.length === 0 && calls === EYE_STYLES.length * MOUNTS.length,
    `all ${EYE_STYLES.length * MOUNTS.length} appearance-and-mount pairings evaluated (${calls} ran)`,
    failures.slice(0, 4).join('\n        '));
}
{
  // And the dispatcher, which wires the bodies to the branches.
  fresh();
  let err = null;
  try { eyes.eyeColour(ctx()); } catch (e) { err = e; }
  ok(err === null, 'eyeColour dispatches without error', err ? err.message.slice(0, 200) : '');
}
{
  const failures = [];
  for (const mnt of MOUNTS) {
    fresh();
    try {
      eyes.eyeDistance(fieldCtx({
        stalkOn: float(mnt.stalk), ocelliOn: float(mnt.ocelli), gemOn: float(mnt.gem),
      }));
    } catch (e) { failures.push(`${JSON.stringify(mnt)}: ${e.message}`); }
  }
  ok(failures.length === 0, 'and the field runs for all eight mounts', failures.join('\n        '));
}
{
  const failures = [];
  for (const side of [-1, 1]) {
    fresh();
    try { eyes.eyeColour(ctx({ side: float(side) })); }
    catch (e) { failures.push(`side ${side}: ${e.message}`); }
  }
  ok(failures.length === 0, 'and on both sides of the head', failures.join('\n        '));
}
{
  // The ocelli count is a slider, so the fold has to run across its whole range, not at its default.
  const failures = [];
  for (let n = 3; n <= 10; n++) {
    fresh();
    try { eyes.eyeDistance(fieldCtx({ ocelliOn: float(1), ocelliCount: uniform(n) })); }
    catch (e) { failures.push(`count ${n}: ${e.message}`); }
  }
  ok(failures.length === 0, 'the cluster runs at every count the slider offers', failures.join('\n        '));
}

// ---------------------------------------------------------------------------------------------------
section('5. the field and the shading share one seam');
{
  // If these computed the eyeball's position separately, a mount could move the geometry without moving
  // the highlights sitting on it. Both must go through eyeLocal.
  const distSrc = eyes.eyeDistance.toString();
  const colSrc = eyes.eyeStyleBodies.toString();
  ok(distSrc.includes('eyeLocal('), 'eyeDistance asks eyeLocal where the eyeball is');
  ok(colSrc.includes('eyeLocal('), 'and so does the shading');
  ok(!colSrc.includes('EM.ocelliFold('), 'the shading does not fold the domain a second time of its own');
  // A cut gem is flat where the sphere is curved, so the shading must take the field's own normal.
  ok(colSrc.includes('nA'), 'the shading uses the field normal, which is what makes a gem facet catch light');
  // The dispatcher must branch, not evaluate all twelve and blend: that would cost twelve styles a pixel.
  const dispatchSrc = eyes.eyeColour.toString();
  ok(dispatchSrc.includes('If('), 'eyeColour branches on the style rather than blending all of them');
  fresh();
  let built = null;
  try {
    built = eyes.eyeLocal({
      p: vec3(0.14, 0.30, 0.52), side: float(1), bob: float(0), eyeSize: uniform(1),
      stalkOn: uniform(0), stalkLen: uniform(1), ocelliOn: uniform(0), ocelliCount: uniform(6),
    }).rel;
  } catch { built = null; }
  ok(built !== null, 'eyeLocal runs on its own');
}

// ---------------------------------------------------------------------------------------------------
section('6. nothing above provoked a complaint from TSL');
ok(tslNoise.length === 0,
  'no TSL warning was raised while running all 96 pairings',
  [...new Set(tslNoise)].slice(0, 6).join('\n        '));

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
