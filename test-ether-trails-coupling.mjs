// The Ether Trails hybrid only means anything if its two halves read one field in one space. That claim
// lives across two separately-compiled shaders, so nothing at runtime enforces it and no GPU is needed to
// check it: the coupling is visible in the source. These are the properties that, if they broke, would
// leave the page still rendering something plausible while the grid quietly stopped describing the volume.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('./sabosugi-visuals/hybrids/ether-trails.html', import.meta.url), 'utf8');
const js = src.match(/<script type="module">([\s\S]*?)<\/script>/)[1];

const between = (start, end) => js.split(start)[1].split(end)[0];
const FIELD_GLSL = between('const FIELD_GLSL = `', '\n`;');
const etherFrag = between('fragmentShader: `', '`,\n});');
const trailVert = between('const trailVertex = `', '\n`;');
const trailFrag = between('const trailFragment = `', '\n`;');

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) { console.log(`ok   ${name}`); return; }
  failures++;
  console.error(`FAIL ${name}${detail ? ' — ' + detail : ''}`);
};

// A backtick inside a GLSL comment closes the template literal holding the shader, and every other check
// here reads the file as text, so none of them can see it. This one is a real parse. AsyncFunction rather
// than Function because the module uses top-level await; imports are stripped since neither accepts them.
let parseError = null;
try {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  new AsyncFunction(js.replace(/^import[^;]*;/gm, ''));
} catch (err) {
  parseError = err.message;
}
check('the module parses as JavaScript', parseError === null, parseError)

// Shader source must not contain a backtick at all: every one of them is inside a template literal.
for (const [label, shader] of [['FIELD_GLSL', FIELD_GLSL], ['volume', etherFrag],
                               ['grid vertex', trailVert], ['grid fragment', trailFrag]]) {
  check(`${label} has no stray backtick`, !shader.includes('`'));
}

// --- the registry reaches both programs ---------------------------------------------------------

check('FIELD_GLSL is injected into exactly two programs',
  (js.match(/\$\{FIELD_GLSL\}/g) || []).length === 2);

// It goes into two shaders with different uniform sets, so it cannot read a uniform of its own.
const uniformsInRegistry = [...new Set(FIELD_GLSL.match(/\bu[A-Z]\w+/g) || [])];
check('FIELD_GLSL reads no uniform', uniformsInRegistry.length === 0, uniformsInRegistry.join(', '));

// --- both halves share one field space ----------------------------------------------------------

for (const [label, shader] of [['volume', etherFrag], ['grid', trailVert]]) {
  check(`${label} maps through toFieldSpace`, /toFieldSpace\s*\(/.test(shader));
  check(`${label} passes the shared field scale`, /toFieldSpace\([^)]*uFieldScale/.test(shader));
  check(`${label} passes the shared repeat flag`, /toFieldSpace\([^)]*uRepeat\)/.test(shader));
}

// The flight offset must be applied in one place only. If either shader still subtracted its own, the
// two would drift apart the moment flight speed left zero.
check('flight offset lives only in toFieldSpace',
  (FIELD_GLSL.match(/z -= tFlight/g) || []).length === 1
  && !/z -= tFlight/.test(etherFrag.replace(FIELD_GLSL, ''))
  && !/z -= tFlight/.test(trailVert.replace(FIELD_GLSL, '')));

check('tunnel repetition lives only in toFieldSpace',
  (FIELD_GLSL.match(/mod\(p\.z \+ 2\.1, 3\.5\)/g) || []).length === 1
  && !/mod\(pos\.z \+ 2\.1/.test(etherFrag));

// --- both halves share one camera ---------------------------------------------------------------

check('volume rebuilds its ray from the perspective camera',
  /uInvProjView\s*\*\s*vec4/.test(etherFrag) && /rayOrigin = uCameraPos/.test(etherFrag));

check('grid samples at its own world position',
  /modelMatrix \* vec4\(position, 1\.0\)/.test(trailVert));

check('the volume is given the eye position', /uniform vec3 uCameraPos;/.test(etherFrag));

check('the eye position is pushed every frame',
  /etherUniforms\.uCameraPos\.value\.copy\(camera\.position\)/.test(js));

// The volume draws under an orthographic camera, so a stale matrix would silently desync the two.
check('the inverse projection-view is rebuilt each frame',
  /multiplyMatrices\(camera\.matrixWorld, camera\.projectionMatrixInverse\)/.test(js));

// --- both halves share one twist phase ----------------------------------------------------------

check('volume twists by distance along the ray',
  /sampleField\(uVolumeField, pos, tAnim, totalDist\)/.test(etherFrag));
// Eye distance varies across a surface and spun the fold's rotation axis through 35 radians, which is
// what made the field-mix form render as noise. The phase has to be a property of the point.
check('grid twists in field space, not by eye distance',
  /float twist = length\(pos\);/.test(trailVert) && !/length\(world - uCameraPos\)/.test(trailVert));

// A field covers the grid; the 26 solid forms guard to a disc holding ~6% of the vertices.
check('the field form is not confined to a solid form’s disc',
  !/if \(length\(p\) > s \* 1\.6\) return 0\.0;/.test(trailVert)
  && /uFieldExtent/.test(trailVert));

// --- nothing dangles -----------------------------------------------------------------------------

const supplied = (block) => new Set([...block.matchAll(/(\w+):\s*\{\s*value:/g)].map((m) => m[1]));
const etherSupplied = supplied(between('const etherUniforms = {', '\n};'));
const trailSupplied = supplied(between('  uniforms: {', '\n  },'));
const builtin = new Set(['projectionMatrix', 'modelViewMatrix', 'modelMatrix', 'cameraPosition']);

for (const [label, shader, keys] of [
  ['volume', etherFrag + FIELD_GLSL, etherSupplied],
  ['grid vertex', trailVert + FIELD_GLSL, trailSupplied],
  ['grid fragment', trailFrag, trailSupplied],
]) {
  const declared = [...shader.matchAll(/uniform\s+\w+\s+(\w+)\s*;/g)].map((m) => m[1]);
  const missing = declared.filter((u) => !keys.has(u) && !builtin.has(u));
  check(`${label}: every declared uniform is supplied`, missing.length === 0, missing.join(', '));
}

// A uniform written from JS but never declared throws on the first frame, which is how the last break
// got in: two pushAll writes outlived the uniforms they targeted.
const written = [...js.matchAll(/(?:u|trailMaterial\.uniforms|etherUniforms)\.(u[A-Z]\w+)\.value/g)]
  .map((m) => m[1]);
const everSupplied = new Set([...etherSupplied, ...trailSupplied]);
const phantom = [...new Set(written)].filter((u) => !everSupplied.has(u));
check('no JS writes to a uniform that does not exist', phantom.length === 0, phantom.join(', '));

// --- the field-mix folder cannot be silently inert -------------------------------------------------

// Six controls are read by exactly one of the 27 height functions, and the shader only calls it when
// uShapeType is 26. Any other form ignores all six without a word, and the form is persisted, so one
// visit to the Form Type dropdown used to leave the folder dead on every later load. That is what
// "field mix does literally nothing" was.
const fMixBlock = js.split('const fMix = gui.addFolder(')[1].split('fMix.open();')[0];
const fMixStatements = fMixBlock.split('fMix.add(').slice(1);
const unarmed = fMixStatements
  .filter((st) => !st.includes('armFieldMix();'))
  .map((st) => (st.match(/CONFIG, '(\w+)'/) || [])[1]);
check('every field-mix control arms the form that reads it',
  fMixStatements.length >= 6 && unarmed.length === 0, unarmed.join(', '));

check('arming actually selects form 26',
  /function armFieldMix\(\)[\s\S]*?CONFIG\.shape = 26;[\s\S]*?uShapeType\.value = 26;/.test(js));

// The panel has to say which form is live, or this failure mode is invisible from the UI.
check('the live form is shown on screen', /form: \$\{name\}/.test(js));

// A page that autosaves every change has no way back to its authored look without this.
check('there is a reset to defaults',
  /const DEFAULTS = JSON\.parse\(JSON\.stringify\(CONFIG\)\);/.test(js)
  && /function resetToDefaults\(\)/.test(js)
  && /gui\.add\(actions, 'reset'\)/.test(js));

// DEFAULTS must be captured before applySaved overwrites CONFIG, or it snapshots the saved state.
check('defaults are captured before saved state is applied',
  js.indexOf('const DEFAULTS =') < js.indexOf('applySaved(store.json(null))'));

// --- menus match the shader ----------------------------------------------------------------------

const ids = (block, re) => new Set([...block.matchAll(re)].map((m) => Number(m[1])));
const fieldBranches = ids(FIELD_GLSL, /if \(id == (\d+)\)/g);
const fieldMenu = ids(between('const FIELDS = {', '\n};'), /:\s*(\d+),/g);
check('every field branch has a menu entry and vice versa',
  fieldBranches.size === fieldMenu.size && [...fieldBranches].every((i) => fieldMenu.has(i)),
  `${[...fieldBranches]} vs ${[...fieldMenu]}`);

const opBranches = ids(FIELD_GLSL, /if \(op == (\d+)\)/g);
const opMenu = ids(between('const BLEND_OPS = {', '};'), /:\s*(\d+)/g);
check('every blend branch has a menu entry and vice versa',
  opBranches.size === opMenu.size && [...opBranches].every((i) => opMenu.has(i)),
  `${[...opBranches]} vs ${[...opMenu]}`);

const formBranches = ids(trailVert, /if\(t==(\d+)\)/g);
const formMenu = ids(between('const shapes = {', '\n};'), /:\s*(\d+),/g);
check('every form branch has a menu entry and vice versa',
  formBranches.size === formMenu.size && [...formBranches].every((i) => formMenu.has(i)),
  `${formBranches.size} vs ${formMenu.size}`);

// --- every GLSL call resolves --------------------------------------------------------------------

const GLSL_BUILTINS = new Set(['mix', 'fract', 'floor', 'abs', 'sin', 'cos', 'pow', 'clamp', 'normalize',
  'dot', 'cross', 'length', 'max', 'min', 'smoothstep', 'step', 'sqrt', 'exp', 'atan', 'mod', 'tan',
  'sign', 'mat2', 'mat3', 'mat4', 'vec2', 'vec3', 'vec4', 'float', 'int', 'if', 'for', 'return',
  'texture2D', 'main']);

for (const [label, shader] of [['volume', etherFrag + FIELD_GLSL], ['grid vertex', trailVert + FIELD_GLSL]]) {
  const defined = new Set([...shader.matchAll(/\b(?:float|vec2|vec3|vec4|mat2|mat3)\s+(\w+)\s*\(/g)].map((m) => m[1]));
  const called = new Set([...shader.matchAll(/\b(\w+)\s*\(/g)].map((m) => m[1]));
  const undef = [...called].filter((f) => !defined.has(f) && !GLSL_BUILTINS.has(f));
  check(`${label}: every call resolves`, undef.length === 0, undef.join(', '));
}

console.log(failures === 0
  ? '\nall coupling checks passed'
  : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
