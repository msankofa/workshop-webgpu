// Static checks on demos/sdf-bug-v2.html: JS syntax, uniform/DOM consistency, and the invariants the
// v2 rewrite has to hold. Nothing here executes the shader, so this catches wiring mistakes.
// Its two companions cover the rest: `test-demo-bug-eyes.mjs` builds the eye styles' node graphs for
// real in Node, and `test-demo-bug-eye-math.mjs` runs their geometry on plain numbers.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const path = new URL('./demos/sdf-bug-v2.html', import.meta.url);
const html = readFileSync(path, 'utf8');

let pass = 0, fail = 0;
const problems = [];
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; return true; }
  fail++; problems.push(`${label}${detail ? ' — ' + detail : ''}`);
  return false;
};

// ---- the module script ---------------------------------------------------------------------------
const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
ok(!!m, 'the page has a module script');
const js = m[1];

// `node --check` on a real .mjs, because vm.Script rejects import statements and stripping them out
// first would stop this from checking the thing most likely to be wrong.
const tmp = join(tmpdir(), 'sdf-bug-v2-check.mjs');
try {
  writeFileSync(tmp, js);
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
  ok(true, 'the module script parses');
} catch (e) {
  ok(false, 'the module script parses', String(e.stderr || e.message).replace(/\s+/g, ' ').slice(0, 240));
} finally {
  try { unlinkSync(tmp); } catch {}
}

// ---- imports ------------------------------------------------------------------------------------
ok(js.includes("from './bug-rig.js'"), 'imports the rig');
ok(/import\s*\{[^}]*createBugRig/.test(js), 'imports createBugRig');
ok(!js.includes("from '../creature-locomotion.js'"),
  'does NOT import the locomotion module directly',
  'the rig owns that dependency; two importers would be two opinions about the gait');

// ---- the mirror is gone from the legs -----------------------------------------------------------
// v1's leg loop read `pm`, the mirrored point. v2's must read the world point and the joint uniforms.
const legBlock = js.slice(js.indexOf('// Legs.'), js.indexOf('// Antennae'));
ok(legBlock.length > 100, 'the leg block is findable');
ok(legBlock.includes('B.joint('), 'legs read their joints from the per-bug uniform array');
// ONE FRAME FOR THE WHOLE BUG. The legs were evaluated in world space while the body was in authored
// space, which worked only because both were the same size. With a per-bug scale that mixture would mean
// multiplying some terms and not others, so the rig now hands over unit-authored joints and the field
// scales once on the way out. `pw` here would be the old two-frame arrangement returning.
ok(/sdSegTaper\(p,/.test(legBlock), 'legs are evaluated in the same UNIT AUTHORED space as the body');
ok(!/sdSegTaper\(pw,/.test(legBlock), 'and not in world space alongside an authored body');
ok(!/sdSegTaper\(pm,/.test(legBlock), 'no leg is evaluated at the mirrored point',
  'a mirrored leg cannot be in opposite phase to its pair, which is what a gait requires');
ok(/for \(let i = 0; i < LEG_COUNT; i\+\+\)/.test(legBlock), 'the loop covers every leg');

// The antennae and eyes SHOULD still be mirrored — they are still symmetric.
const antBlock = js.slice(js.indexOf('// Antennae'), js.indexOf('bugMap.setLayout'));
ok(/sdSegTaper\(pm,/.test(antBlock), 'the antennae are still mirrored');
// The eyes are mirrored by being asked about `pm`, so `side` is +1: in mirrored space both eyes are the
// right one. Passing the unmirrored point here would draw one eye and leave the other side of the head bare.
ok(/eyes\.eyeDistance\(\{/.test(antBlock), 'the eyes get their distance from the styles module');
ok(/pm,\s*side: float\(1\)/.test(antBlock), 'the eyes are still mirrored, via pm and side +1');
ok(/stalkOn: B\.eyeStalkOn/.test(antBlock) && /ocelliOn: B\.eyeOcelliOn/.test(antBlock)
  && /gemOn: B\.eyeGemOn/.test(antBlock),
  'and the field hears about all three mounts, which are flags rather than styles');
ok(!/style: u\.eyeStyle/.test(antBlock), 'the FIELD does not depend on the appearance at all',
  'appearance is shading; if the geometry read it the two axes would be coupled again');

// ---- the body is carried into authored space ----------------------------------------------------
ok(/const rel = pw\.sub\(B\.bodyPos\)/.test(js), 'bugMap transforms the incoming point');
ok(/dot\(rel, B\.invRow0\)/.test(js), "using that bug's own inverse rotation rows");
// The divide is what makes it UNIT authored space rather than merely authored space. Without it a scaled
// bug's primitives would stay their authored size inside a body that had grown, and the legs — which the
// rig hands over already in unit space — would no longer line up with them.
ok(/\)\.div\(S\)\.add\(vec3\(BODY_PIVOT/.test(js), 'and divides by the scale to reach UNIT authored space');
ok(/return vec2\(res\.x\.mul\(S\), res\.y\)/.test(js), 'then scales the distance back on the way out',
  'a similarity preserves the field; forgetting the multiply would under-report and the march would step through');
ok(js.includes("{ name: 'pw', type: 'vec3' }, { name: 'bugIdx', type: 'int' }"),
  'bugMap declares the world point and which bug to evaluate');
// The shell gradient has to ride with the body or it repaints as the bug walks downhill.
ok(/shellT = smoothstep\(float\(-0\.34\), float\(0\.24\), pA\.z/.test(js),
  'the shell gradient is sampled in authored space');
ok(/smoothstep\(float\(0\.44\), float\(0\.58\), pA\.y\)/.test(js), 'and so is the crest');
// And so is the eye's painted face. Every band is an angle from an authored centre, so against world `p`
// the vector is dominated by the bug's offset from the origin: measured, dot(en, glintA) collapsed to a
// 0.08-wide range at -0.8, no band fired on any of 121 surface samples, and the eye rendered as a flat
// disc of the bounce term. The view direction has to come along, and `sign` has to pick the side in the
// space where the sides are ±x.
const eyeShading = js.slice(js.indexOf('// ---- the eye'), js.indexOf('// ---- dew on the leaf'));
ok(eyeShading.length > 100, 'the eye shading block is findable');
ok(/eyes\.eyeColour\(\{/.test(eyeShading), 'the eye colour comes from the styles module');
ok(/pA, rdA, LA,/.test(eyeShading), 'and is handed the authored point and both authored directions');
ok(/const rdA = vec3\(dot\(rd, H\.invRow0\)/.test(eyeShading), 'the view direction is rotated to match');
ok(/const LA = vec3\(dot\(L, H\.invRow0\)/.test(eyeShading), 'and so is the key light');
ok(/side: sign\(pA\.x\)/.test(eyeShading), 'the side is picked in authored space, where the sides are +/-x');
// Excluding the two lines that define rdA and LA, which necessarily read the world directions.
const eyeBands = eyeShading.split('\n')
  .filter((l) => !/const (rdA|LA) =/.test(l)).join('\n');
ok(!/dot\(rd,/.test(eyeBands) && !/dot\(L,/.test(eyeBands),
  'nothing else in the block mixes a world direction with an authored normal');
ok(!/\bp\.sub\(eyeC\)/.test(eyeShading), 'the world point is not used against the authored eye centre');

// ---- the styles module ---------------------------------------------------------------------------
// The rules above moved with the code, so they are checked where the code now lives. A page-only scan
// would have gone quiet the moment the eye left the page, which is the failure mode that let the
// world-space bug survive in the first place.
const eyesSrc = readFileSync(new URL('./demos/bug-eyes.js', import.meta.url), 'utf8');
const mathSrc = readFileSync(new URL('./demos/bug-eye-math.js', import.meta.url), 'utf8');
ok(/const enSphere = normalize\(L\.rel\)/.test(eyesSrc),
  "the styles measure their bands from the eye's own centre");
ok(/rdA\.negate\(\)/.test(eyesSrc), 'and the camera-facing term uses the authored view direction');
// Comments stripped first: this rule fired on prose mentioning `u.quality`, which is not a uniform read.
const eyesCode = eyesSrc.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
  .map((l) => l.replace(/\/\/.*$/, '')).join('\n');
ok(!/\bu\./.test(eyesCode), 'the styles module reads no page uniforms directly, only its arguments',
  'otherwise it could not be run in a test');
// Appearance and mount are separate axes. A mount in the appearance list would put structure back in the
// dropdown and force a choice between having a stalk and having any of the twelve looks on it.
const styleBlock = eyesSrc.slice(eyesSrc.indexOf('export const EYE_STYLES'), eyesSrc.indexOf('export const EYE_MODIFIERS'));
const modBlock = eyesSrc.slice(eyesSrc.indexOf('export const EYE_MODIFIERS'), eyesSrc.indexOf('export const STYLE_INDEX'));
const styleKeys = [...styleBlock.matchAll(/\{ key: '([a-z]+)'/g)].map((m) => m[1]);
const modKeys = [...modBlock.matchAll(/\{ key: '([a-z]+)'/g)].map((m) => m[1]);
ok(styleKeys.length === 12, `twelve appearances are declared (${styleKeys.length})`);
ok(modKeys.length === 3, `three mounts are declared (${modKeys.length})`);
ok(modKeys.every((k) => !styleKeys.includes(k)), 'no mount is also an appearance',
  'that is the design mistake this split fixed');
// Every appearance needs a body, and the bodies must be NAMED FUNCTIONS rather than inline If callbacks:
// a callback is stored and replayed during the shader build, so an inline body can never be run by a test.
const bodyKeys = new Set([...eyesSrc.matchAll(/bodies\.([a-z]+) = \(\)/g)].map((m) => m[1]));
const bodyless = styleKeys.filter((k) => !bodyKeys.has(k));
ok(bodyless.length === 0, 'every appearance has a named body', `missing: ${bodyless}`);
ok(bodyKeys.size === 12, `exactly twelve bodies, no strays (${bodyKeys.size})`);
ok(/const eyeColour = \(args\) => \{[\s\S]{0,600}If\(args\.style/.test(eyesSrc),
  'eyeColour branches on the style rather than evaluating all twelve',
  'blending them would cost twelve appearances per pixel, which is the opposite of the point');
// The mounts reach the field as flags, so all eight combinations are legal.
for (const k of ['stalkOn', 'ocelliOn', 'gemOn']) {
  ok(eyesSrc.includes(k), `the mount flag '${k}' is threaded through`);
}
ok(/If\(gemOn\.greaterThan\(0\.5\)/.test(eyesSrc), 'the gem cut is keyed off its own flag');
ok(/If\(ocelliOn\.greaterThan\(0\.5\)/.test(eyesSrc), 'and so is the cluster');
ok(/If\(stalkOn\.greaterThan\(0\.5\)/.test(eyesSrc), 'and so is the stalk');
// One seam: if the field and the shading located the eyeball separately, a mount could move the geometry
// without moving the highlights on it.
ok((eyesSrc.match(/eyeLocal\(\{/g) || []).length >= 2, 'the field and the shading both go through eyeLocal');
ok(/const need = /.test(eyesSrc), 'missing arguments are rejected rather than built out of undefined',
  'TSL makes a graph out of undefined without complaining, which is how a forgotten argument reached the GPU');
ok(/createEyeMath\(\{ vec2, vec3, float, atan2: mx_atan2 \}\)/.test(eyesSrc),
  'the maths is injected with mx_atan2, atan2 not being an export of this build');
ok(!/from 'three'/.test(mathSrc) && !/three\/tsl/.test(mathSrc),
  'the maths module imports nothing, which is what lets Node run it on plain numbers');
ok(/x\.step\(edge\)` is `step\(edge, x\)/.test(mathSrc) || /step\(edge, x\)/.test(mathSrc),
  'the reordered chained comparison is written down where it is used');
// The leaf must NOT be, since it does not move with the bug.
const leafAlbedo = js.slice(js.indexOf('const leafV ='), js.indexOf('const albedo ='));
ok(/sin\(p\.x\.mul\(1\.7\)/.test(leafAlbedo), "the leaf's albedo stays in world space");
ok(!leafAlbedo.includes('pA.'), 'the leaf is not dragged into the body\'s frame');

// ---- the bounding sphere follows the bug --------------------------------------------------------
ok(/Loop\(u\.bugCount, \(\{ i \}\) => \{[\s\S]{0,1400}const bound = sphereSpan\(ro, rd, b\.at, b\.r\)/.test(js),
  'each bug is marched inside its own bound, over the LIVE count');
// An unrolled loop over the slots is what kept the cap at six: it emitted a march per slot whether or not
// that slot held a bug, and one gate compare per slot inside every shading tap.
// Matched on the GATE rather than on the `for` itself, because a plain loop over the slots is exactly what
// CPU-side slot initialisation wants — `clearSlot` runs one — and only the gated, shader-emitting form is
// the thing being forbidden.
ok(!/for \(let i = 0; i < MAX_BUGS; i\+\+\) \{[\s\S]{0,80}If\(float\(i\)\.lessThan\(u\.bugCount\)/.test(js),
  'and not once per slot',
  'unrolling makes the shader grow with the cap and charges for empty slots');
ok(!/sphereSpan\(ro, rd, vec3\(\.\.\.BUG_BOUND_AT\)/.test(js), 'and not the old constant');
ok(/bound\.w = far \* settings\.scale;/.test(js),
  'pushBug recomputes the radius and scales it out of unit space');
ok(/far = Math\.max\(far, Math\.hypot\(x - BODY_PIVOT\[0\]/.test(js), 'from the actual joint positions');
// The reject in sceneMap is exact, not a heuristic: `|p - centre| - radius` is a lower bound on the distance
// to that bug, so a bug that cannot beat the best distance so far can be skipped without changing the answer.
// Without it, every shadow, occlusion and thickness tap would evaluate all six fields.
ok(/const near = length\(p\.sub\(bb\.at\)\)\.sub\(bb\.r\)/.test(js),
  'and the shading taps reject distant bugs by that bound');
ok(/If\(near\.lessThan\(d\)/.test(js), 'skipping a bug only when it provably cannot win');

// ---- the rig is stepped and pushed --------------------------------------------------------------
ok(/for \(let i = 0; i < bugs\.length; i\+\+\) \{[\s\S]{0,120}bugs\[i\]\.rig\.update\(dt, \{ walk: walking \}\)/.test(js),
  'the loop steps every bug, not just the one the panel edits');
ok(/if \(!stepped\.steps\) continue;[\s\S]{0,80}pushBug\(i\)/.test(js), 'and pushes each pose when it advanced');
// EVERY rig, not just the draft's. The feet are solved against the surface on the CPU, so a leaf that only
// reached the shader would leave the spawned bugs standing on the shape it used to have.
ok(/function reground\(\)/.test(js) && /for \(const bug of bugs\)[\s\S]{0,200}setGround\(/.test(js),
  'a leaf change re-grounds every bug, not only the draft');
ok(/reground\(\);/.test(js), 'and the leaf sliders call it');

// ---- uniforms: declared vs used -----------------------------------------------------------------
const uBlock = js.slice(js.indexOf('const u = {'), js.indexOf('const keyDir'));
const declared = [...uBlock.matchAll(/^\s{2}(\w+):\s*uniform\(/gm)].map(x => x[1]);
ok(declared.length > 30, `found ${declared.length} uniforms`);
// A `name: uniform(...)` declaration does not itself contain `u.name`, so ONE match is one real use.
// An earlier version of this check required two and wrongly flagged `framing` and `zoom`, which are
// read exactly once each in the camera setup.
const unread = declared.filter(name => {
  const uses = [...js.matchAll(new RegExp(`u\\.${name}\\b`, 'g'))].length;
  return uses === 0;
});
ok(unread.length === 0, 'every uniform is read somewhere', unread.join(', '));

// A STRONGER version of the same check, because the one above has a blind spot that already cost
// something: a slider reads and writes `u.x.value`, so a uniform the SHADER stopped using still counts
// as "read" and its control silently does nothing. That is exactly what happened to `legSpread` when the
// legs moved to uniforms — v1 scaled the knee inside bugMap, v2 does not, and the slider went dead while
// this file reported the page clean. So: every uniform must be referenced somewhere in the SHADER
// region, not merely somewhere on the page.
const shaderStart = js.indexOf('const keyDir');
const shaderEnd = js.indexOf('function makePass');
ok(shaderStart > 0 && shaderEnd > shaderStart, 'the shader region is findable');
const shaderJs = js.slice(shaderStart, shaderEnd);
// No exemptions. Every uniform on this page really is read by the shader, so a whitelist here would only
// be the place a dead one crept back in; it stays empty until something genuinely needs it. Verified by
// injecting a uniform nothing reads and watching this fail.
const uiOnly = declared.filter(name => !new RegExp(`u\\.${name}\\b`).test(shaderJs));
ok(uiOnly.length === 0, 'every uniform is read by the shader, not just by a slider',
  `${uiOnly.join(', ')} — the control(s) for these do nothing`);

const used = new Set([...js.matchAll(/u\.(\w+)/g)].map(x => x[1]));
const undeclared = [...used].filter(nm => !declared.includes(nm));
ok(undeclared.length === 0, 'every u.* reference is declared', undeclared.join(', '));

// ---- DOM ids: referenced vs present ------------------------------------------------------------
const domIds = new Set([...html.matchAll(/\sid="([\w-]+)"/g)].map(x => x[1]));
const referenced = new Set([...js.matchAll(/el\('([\w-]+)'\)/g)].map(x => x[1]));
const missing = [...referenced].filter(id => !domIds.has(id));
ok(missing.length === 0, 'every el() target exists in the markup', missing.join(', '));

// Controls in the markup that nothing wires up are dead UI.
const controls = [...html.matchAll(/<(?:input|button)[^>]*\sid="([\w-]+)"/g)].map(x => x[1]);
const deadControls = controls.filter(id => !js.includes(`'${id}'`));
ok(deadControls.length === 0, 'no control in the panel is unwired', deadControls.join(', '));

// Gait preset buttons are addressed by data attribute rather than id, so check those separately.
const gaitButtons = [...html.matchAll(/data-gait="(\w+)"/g)].map(x => x[1]);
ok(gaitButtons.length > 0, `${gaitButtons.length} gait preset buttons`);
const presetBlock = js.slice(js.indexOf('const GAIT_PRESETS'), js.indexOf('const _jointBuf'));
const missingPresets = gaitButtons.filter(g => !presetBlock.includes(`${g}:`));
ok(missingPresets.length === 0, 'every gait button has a preset', missingPresets.join(', '));

// ---- leg radii come from the rig, not a second copy of the table --------------------------------
ok(!/const LEGS = \[/.test(js), 'the leg table is not duplicated on the page');
ok(/for \(const L of BUG_LEGS\)/.test(js), 'leg radii are derived from the rig\'s table');
ok(js.includes('LEG_COUNT'), 'the leg count is derived rather than typed');

// ---- joint limits are the rig's, and the page only presents them --------------------------------
// The failure this guards against is the page growing its own copy of a limit. There would then be two
// answers to "how far may the knee straighten" — the one the slider shows and the one the solver uses —
// and the drawn leg would follow the second while the panel described the first.
{
  const rig = readFileSync(new URL('./demos/bug-rig.js', import.meta.url), 'utf8');
  ok(/export const BUG_LEG_LIMITS = \{/.test(rig), 'the rig owns the limit defaults');
  // Scoped to the object itself. Scanning the whole file matched the comment explaining that `rise` was
  // removed, and `legPose`'s diagnostic, which still reports a rise as a measurement.
  const limitObj = rig.slice(rig.indexOf('export const BUG_LEG_LIMITS'),
    rig.indexOf('};', rig.indexOf('export const BUG_LEG_LIMITS')));
  ok(/swing:/.test(limitObj) && /reach:/.test(limitObj), 'both limits are named in the rig');
  ok(!/rise:/.test(limitObj), 'the rise limit is gone, not left defaulted off');

  ok(/rig\.state\.limits/.test(js), 'the page reads the limits off the rig');
  ok(!/const (SWING|REACH)_LIMIT/.test(js), 'the page does not keep its own limit constants');
  ok(/solveTwoBone/.test(rig) && !/solveTwoBone/.test(js),
    'the solve happens in the rig, not on the page');
  // The old solver must still be imported by the rig, because rebuilding a chain still seeds the points
  // array the shader reads — dropping it entirely would leave `chain.points` undefined on the first frame.
  ok(/KinematicChain/.test(rig), 'the rig still builds a chain for the joint buffer');

  // The escape hatch has to actually restore the unbounded solve, or the comparison the panel invites is a
  // comparison of two limited poses.
  const off = js.slice(js.indexOf("el('limitsOn').addEventListener"), js.indexOf("el('limitsOn').addEventListener") + 500);
  ok(/swing: null/.test(off), 'turning the limits off removes the swing bound entirely');
  ok(/reach: 0\.999/.test(off), 'and opens the reach bound to the geometric maximum');
  // AND the solver, or the comparison is false: relaxing the bounds alone leaves inversion at zero, because
  // the pole rather than the bound is what fixes the knee. Measured 0.0% against 59.5%.
  ok(/legSolver = .*fabrik/.test(off), 'and puts the old FABRIK solve back, which is what actually inverts');
  ok(/legSolver/.test(rig), 'the rig can be built on either solver');

  // A readout that samples once every half second would miss a transient inversion, which is the whole
  // phenomenon. It has to be sampled on the sim's own step.
  const loop = js.slice(js.indexOf('renderer.setAnimationLoop'));
  ok(/if \(!stepped\.steps\) continue;[\s\S]{0,400}legPose\(\)/.test(loop),
    'the joint readout samples on every simulation step');
  ok(/jointInverted/.test(loop) && /jointSamples/.test(loop),
    'and counts inversions rather than only reporting the current frame');
}

// ---- the per-bug plumbing -----------------------------------------------------------------------
// THIS SECTION CARRIES A BURDEN THE NODE TESTS CANNOT. Measured in this build: TSL does not throw, warn or
// error when a function is called with a missing argument, and `If`/`Loop` callbacks run zero times outside
// a shader build. So a `bugMap(p)` that forgot which bug to evaluate would build a different program in
// silence, and a mistake inside the march loop is invisible to Node entirely. Text is what is left.
{
  // A balanced-paren scan rather than a regex: the arguments contain nested calls two deep
  // (`bugMap(ro.add(rd.mul(t)), int(i))`), and the regex written first matched none of them and reported
  // "0 call sites found" as a pass-shaped result. Counting commas at depth zero is what the check needs.
  // Commented lines are skipped, because the notes in the page quote the broken call on purpose and a scan
  // that reads prose as code is a scan that reports whichever of the two the author wrote most recently.
  const lineIsComment = (at) => {
    const from = js.lastIndexOf('\n', at) + 1;
    return js.slice(from, at).trimStart().startsWith('//');
  };
  const callArgs = [];
  for (let at = js.indexOf('bugMap('); at !== -1; at = js.indexOf('bugMap(', at + 1)) {
    if (/[.\w]/.test(js[at - 1] ?? '')) continue;              // bugMap.setLayout, or a longer name
    if (lineIsComment(at)) continue;
    let depth = 0, commas = 0, end = at + 7;
    for (; end < js.length; end++) {
      const c = js[end];
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      else if (c === ',' && depth === 0) commas++;
    }
    callArgs.push({ text: js.slice(at, end + 1), args: commas + 1 });
  }
  ok(callArgs.length >= 2, `${callArgs.length} bugMap call sites found`);
  const wrongArity = callArgs.filter((c) => c.args !== 2);
  ok(wrongArity.length === 0, 'every bugMap call says which bug to evaluate',
    wrongArity.map((c) => c.text.slice(0, 60)).join(' | '));

  // THE BUG INDEX MAY NOT BE THE RAW LOOP VARIABLE, and this is the rule that would have caught the black
  // ball. A dynamic `Loop`'s index is a WGSL variable named literally `i` — `test-demo-sdf-bug-multi.mjs`
  // asserts that against the shipped three — so the march's own `Loop`, which names its counter `i` as well,
  // shadows it for the whole of its body. `bugMap(p, i)` in there evaluated the STEP NUMBER as the bug index,
  // which is legal WGSL and rendered as a black ball the size of the bounding sphere. Nothing in Node can see
  // the scoping, so the rule is: pass a var that carries its own name.
  const rawIndex = callArgs.filter((c) => /,\s*(int\()?i\)?\s*\)$/.test(c.text.replace(/\s+/g, ' ')));
  ok(rawIndex.length === 0, 'no bugMap call passes a loop variable that a nested loop could shadow',
    rawIndex.map((c) => c.text.replace(/\s+/g, ' ').slice(0, 70)).join(' | '));
  const captures = (js.match(/const bi = i\.toVar\('bugIndex'\)/g) ?? []).length;
  ok(captures === 2, 'both per-bug loops capture their index in a var of its own', `${captures} of 2`);
  ok(!/bugHit\.assign\(i\.toFloat\(\)\)/.test(js), 'and the hit slot is recorded from the capture too',
    'recording the raw index inside the march loop records the step number, and the bug is shaded from it');

  // The stride has to be the SAME expression on both sides, or one bug reads another's legs. The Node test
  // checks the mapping is a bijection; this checks the page uses one stride and not two.
  ok(/bugJoints\.element\(idx\.mul\(JOINTS_PER_BUG\)\.add\(j\)\)/.test(js),
    'the shader indexes joints by the shared stride');
  ok(/const jbase = i \* JOINTS_PER_BUG;/.test(js) && /bugJoints\.array\[jbase \+ j\]/.test(js),
    'and the CPU writes them at the same stride');
  ok(/const JOINTS_PER_BUG = LEG_COUNT \* 3;/.test(js), 'which is derived, not typed twice');

  // Appearance must come from the HIT bug, not from slot 0. Reading the draft's colours for every bug is
  // the failure that would make six different bugs look identical while the geometry differed.
  ok(/const H = bugFields\(int\(bugHit\)\);/.test(js), 'the shading resolves the bug that was hit');
  ok(/bugHit\.assign\(bi\.toFloat\(\)\)/.test(js), 'which the march records when it hits',
    'the loop index is an int now, so it is converted rather than wrapped');

  // Settings are the save format, so they must be plain data. A THREE.Color or a node in there would
  // survive `JSON.stringify` as `{}` and a reloaded preset would come back grey.
  // Scoped to the block, and looking for what must NOT be there. The first version of this rule tested for
  // `'#` inside the block, which `new THREE.Color('#6b3c14')` satisfies perfectly — it passed against the
  // exact mistake it was written to catch.
  const colourBlock = js.slice(js.indexOf('const BUG_COLOURS = {'), js.indexOf('};', js.indexOf('const BUG_COLOURS = {')));
  ok(!/THREE\.Color/.test(colourBlock), 'colours are stored as hex strings, not THREE.Color',
    'a Color would stringify to {} and a reloaded preset would come back grey');
  ok(/^\s*\w+: '#[0-9a-fA-F]{6}',$/m.test(colourBlock), 'and each one is a bare hex string');
  ok(/JSON\.stringify\(all\)/.test(js), 'and presets are saved with JSON.stringify');
  ok(/catch \{[\s\S]{0,200}return \{\};/.test(js), 'a corrupt preset store falls back to empty rather than throwing');

  // The count is what stops the shader reading slots that hold stale data.
  ok(/u\.bugCount\.value = bugs\.length/.test(js), 'the live count is pushed to the shader');
  // COUNTED, not merely found. There are two per-bug loops — the primary march and the shading taps'
  // `sceneMap` — and both must be bounded by the live count. When these were unrolled and gated instead, a
  // single `.test()` for the gate passed while the march's had been replaced by a constant, because the other
  // loop's still matched. The dynamic form removes the gate entirely: the bound IS the count.
  const loops = (js.match(/Loop\(u\.bugCount, \(\{ i \}\) =>/g) ?? []).length;
  ok(loops === 2, 'both per-bug loops are bounded by the live count', `${loops} of 2`);
  ok(/bugCount: uniform\(1, 'int'\)/.test(js), 'which is an int uniform, since it is a loop bound',
    'a float bound leaves a conversion in the hot path of every shading tap');
  ok(/const MAX_BUGS = \d+;/.test(js), 'the slot count is a named constant');

  // AN UNUSED SLOT MUST BE INERT, not merely unvisited. At `new Vector4()` its rotation rows are zero, so
  // every point in space maps to the body pivot and the field is a CONSTANT taken from inside the shell,
  // and `w` defaults to 1, so its bound is a unit sphere at the origin — exactly where the camera looks.
  // That is what turned one shadowed loop variable into a black ball across the frame rather than nothing.
  ok(/function clearSlot\(i\) \{/.test(js), 'unused slots are initialised rather than left at their defaults');
  ok(/for \(let i = 0; i < MAX_BUGS; i\+\+\) clearSlot\(i\);/.test(js), 'every slot, at startup');
  ok(/bugData\.array\[base \+ F\.ROW0\]\.set\(1, 0, 0, 1\)/.test(js), 'with an identity rotation',
    'zero rows collapse all of space onto the body pivot, which is inside the shell');
  ok(/bugData\.array\[base \+ F\.BOUND\]\.set\(0, INERT_Y, 0, 0\)/.test(js),
    'and a zero-radius bound far under the leaf, so it cannot draw wherever it is read from');
  ok(/clearSlot\(bugs\.length\)/.test(js), 'and removing a bug clears the slot it vacated',
    'leaving stale data makes the count the only thing between a dead bug and the picture');
  // The cap is a buffer-size choice now, so it has to stay inside the binding WebGPU guarantees. 544 bytes
  // per bug: 16 vec4s of packed fields plus 18 joints, which pad to vec4 as well.
  const cap = Number(js.match(/const MAX_BUGS = (\d+);/)[1]);
  const stride = Number(js.match(/const BUG_STRIDE = (\d+);/)[1]);
  const bytes = cap * (stride * 16) + cap * 18 * 16;
  ok(bytes < 65536, `${cap} slots is ${(bytes / 1024).toFixed(1)} KB, inside the 64 KB floor`,
    `${bytes} bytes`);
}

// ---- the binding budget -------------------------------------------------------------------------
// THIS IS THE CHECK THE FIRST VERSION NEEDED AND DID NOT HAVE. Every `uniformArray` is a `BufferNode`, so it
// takes its OWN binding, and WebGPU guarantees only `maxUniformBuffersPerShaderStage = 12`. Giving each
// per-bug field its own array made thirty-two of them; the graph built cleanly in Node, every array was
// valid, and the only symptom was the device refusing to create the pipeline:
//
//     THREE.[Invalid PipelineLayout (unlabeled)] is invalid due to a previous error.
//
// Nothing but a real device consults that limit, so a static count is the only place this can be caught
// before a browser does it. Counted structurally rather than by call site, because the failing version
// created its arrays inside `for` loops over the field tables — two literal `uniformArray(` calls that
// produced twenty-five bindings.
{
  const WEBGPU_UNIFORM_BUFFER_FLOOR = 12;
  const literal = (js.match(/uniformArray\(/g) ?? []).length;
  ok(literal <= 4, `${literal} uniformArray call sites`, 'each one is at least one binding');
  // No array may be built inside a loop over a field table, which is how thirty-two appeared from two calls.
  ok(!/for \(const \[[\w, ]+\] of Object\.entries\(BUG_\w+\)\) \{[\s\S]{0,80}= uniformArray/.test(js),
    'and none is created per field inside a loop',
    'thirty-two bindings against a limit of twelve is what that produced');
  ok(/const bugData = uniformArray\(/.test(js) && /const bugJoints = uniformArray\(/.test(js),
    'the per-bug fields are packed into one vec4 array plus one for the joints');
  ok(/const BUG_STRIDE = \d+;/.test(js), 'with a named stride');
  ok(literal + 1 <= WEBGPU_UNIFORM_BUFFER_FLOOR,
    `the page stays inside the ${WEBGPU_UNIFORM_BUFFER_FLOOR}-buffer floor WebGPU guarantees`,
    `${literal} arrays`);
  // Both sides of the packing must go through the tables, or a field is written to one slot and read from
  // another — which shows up as a bug wearing the wrong value rather than as an error.
  ok(/const SCALAR_AT = \{/.test(js) && /const COLOUR_AT = \{/.test(js), 'the layout is a table, not spelled out twice');
  ok(/for \(const \[name, \[slot, comp\]\] of Object\.entries\(SCALAR_AT\)\) B\[name\] = at\(slot\)\[comp\]/.test(js),
    'the shader reads scalars through it');
  ok(/bugData\.array\[base \+ slot\]\[comp\] = st\[name\]/.test(js), 'and the CPU writes them through it');
  ok(/_hex\.set\(st\[name\]\)/.test(js), 'colours still go through a THREE.Color for the hex-to-linear step',
    'copying the hex bytes into a vector would shift every colour on the page');
}

// ---- the leaf can be flat -----------------------------------------------------------------------
{
  ok(/leafFlat: uniform\(0\)/.test(js), 'the leaf shape is a uniform, so it costs no recompile');
  // A DISC, not a plane. An infinite plane would fill everything below the horizon and take the
  // out-of-focus background with it, and the background is half of what this demo is about.
  ok(/length\(vec2\(hitPlane\.x, hitPlane\.z\)\)\.lessThan\(u\.sproutR\)/.test(js),
    'the flat leaf is bounded by a radius, so it keeps a silhouette');
  ok(/const tLeaf = select\(u\.leafFlat/.test(js), 'and the choice is a select rather than two code paths');
  // Three things follow the leaf's shape and would be quietly wrong if any were missed.
  ok(/const sn = select\(u\.leafFlat/.test(js), 'the leaf normal follows the shape');
  ok(/const crown = select\(\s*u\.leafFlat/.test(js), 'and so does the crown ramp',
    'on a plane every point has the same height, so a height ramp would flatten to one constant');
  ok(/select\(u\.leafFlat\.greaterThan\(0\.5\), leafFlatD, leafDome\)/.test(js),
    "and the shading taps' own copy of the leaf distance");
  ok(/groundShape: leafShape/.test(js), 'the rig hears about the shape too, or the feet solve against the wrong surface');
}

// ---- summary -----------------------------------------------------------------------------------
console.log(`${pass}/${pass + fail} static checks passed on demos/sdf-bug-v2.html`);
if (fail) {
  console.log('\nPROBLEMS:');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
