import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHRYSALIS_GLSL,
  CHRYSALIS_MAX_SEEDS,
} from './sabosugi-visuals/hybrids/chrysalis-field.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(root, 'sabosugi-visuals', 'hybrids', 'chrysalis-engine.html');
const html = fs.readFileSync(htmlPath, 'utf8');

function mustMatch(source, pattern, message) {
  assert.match(source, pattern, message);
}

// Catch broken JavaScript in the inline module without executing browser-only code.
const inlineModule = html.match(/<script type='module'>([\s\S]*?)<\/script>/);
assert.ok(inlineModule, 'Chrysalis must have an inline module');
const parseableModule = inlineModule[1].replace(/^import\s+.*?;\s*$/gm, '');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
assert.doesNotThrow(
  () => new AsyncFunction(parseableModule),
  'Chrysalis inline module must parse as JavaScript',
);

assert.equal(CHRYSALIS_MAX_SEEDS, 8, 'JavaScript seed capacity changed unexpectedly');
mustMatch(
  CHRYSALIS_GLSL,
  new RegExp('#define\\s+CHRYSALIS_MAX_SEEDS\\s+' + CHRYSALIS_MAX_SEEDS + '\\b'),
  'JavaScript and GLSL seed capacities must agree',
);

// These assertions describe the architectural contract: growth transforms geometry and density in
// one shared field. A future overlay or independent-pass rewrite should fail loudly.
mustMatch(
  CHRYSALIS_GLSL,
  /float growth = chGrowthField\(direction, alien\.yzw\)/,
  'growth must inherit Alien Cell orbit traps',
);
mustMatch(
  CHRYSALIS_GLSL,
  /vec3 pPhase = mix\(pBio, p, stiffness\)/,
  'crystallization must progressively suppress organic coordinate warp',
);
mustMatch(
  CHRYSALIS_GLSL,
  /vec2 anatomyOrganic = chAnatomySDF\(pBio\)/,
  'the organic phase must evaluate the selected shared anatomy in living coordinates',
);
mustMatch(
  CHRYSALIS_GLSL,
  /vec2 anatomyCrystal = chAnatomySDF\(pPhase\)/,
  'the crystal phase must evaluate the same selected anatomy in stiffened coordinates',
);
mustMatch(
  CHRYSALIS_GLSL,
  /float dOrganic = anatomyOrganic\.x[\s\S]*?float dCrystal = anatomyCrystal\.x/,
  'both phase distances must derive from the shared anatomy SDF',
);
assert.doesNotMatch(
  CHRYSALIS_GLSL,
  /chDiamond/,
  'the mature phase must no longer replace the creature with a diamond macro-shape',
);
for (const anatomyPrimitive of ['chSdRoundCone', 'chSdEllipsoid', 'chSdSphere']) {
  mustMatch(CHRYSALIS_GLSL, new RegExp(anatomyPrimitive), 'missing creature primitive ' + anatomyPrimitive);
}
mustMatch(CHRYSALIS_GLSL, /vec2 chBugSDF\(vec3 pInput\)/, 'the SDF bug anatomy must be present');
mustMatch(
  CHRYSALIS_GLSL,
  /return uAnatomyMode == 1 \? chCreatureSDF\(p\) : chBugSDF\(p\)/,
  'the bug must be the default anatomy while retaining the creature option',
);
mustMatch(CHRYSALIS_GLSL, /chSdSegmentTaper/, 'the bug must retain tapered legs and antennae');
for (const bugId of ['ID_SHELL', 'ID_HEAD', 'ID_EYE', 'ID_LEG', 'ID_ANTENNA']) {
  mustMatch(CHRYSALIS_GLSL, new RegExp(bugId), 'missing SDF bug material id ' + bugId);
}
for (const exposedFieldControl of [
  'uOrganicNoiseScale',
  'uOrganicPulseFrequency',
  'uAlienFoldScale',
  'uAlienVeinWidth',
  'uFoldDisplacement',
  'uVeinEmboss',
  'uBugAbdomenScale',
  'uBugAntennaElevation',
  'uBugAntennaPitch',
  'uBugLegSpread',
  'uLatticeSkew',
  'uLatticeAnisotropy',
]) {
  mustMatch(CHRYSALIS_GLSL, new RegExp(exposedFieldControl), 'missing exposed field control ' + exposedFieldControl);
}
mustMatch(
  CHRYSALIS_GLSL,
  /float d = mix\(dOrganic, dCrystal, growth\)/,
  'the final distance must synthesize organic and crystal fields',
);
mustMatch(
  CHRYSALIS_GLSL,
  /d -= front \* uFrontRelief \* \(disturbance - 0\.35\)/,
  'the moving growth front must alter the final silhouette',
);
mustMatch(
  CHRYSALIS_GLSL,
  /return mix\(organic, crystal, state\.growth\) \+ fracture/,
  'interior anatomy must transition through the same growth phase',
);

mustMatch(html, /ChrysalisSample state = chEvaluate\(p\)/, 'the marcher must use the shared field');
mustMatch(html, /chDistance\(p \+ k\.[xyzw]{3} \* e\)/, 'normals must come from the shared field');
mustMatch(html, /chInteriorDensity\(p, state\)/, 'the volume must use the shared phase sample');
assert.equal(
  (html.match(/renderer\.render\(/g) || []).length,
  1,
  'Chrysalis should render one synthesis pass, not composited overlays',
);

const fragmentStart = html.indexOf('const fragmentShader =');
const uniformsStart = html.indexOf('const uniforms = {');
const materialStart = html.indexOf('const material =', uniformsStart);
assert.ok(fragmentStart >= 0 && uniformsStart > fragmentStart && materialStart > uniformsStart);
const shaderSource = CHRYSALIS_GLSL + html.slice(fragmentStart, uniformsStart);
const uniformBlock = html.slice(uniformsStart, materialStart);
assert.doesNotMatch(
  shaderSource,
  /\bsample\b/,
  'sample is a reserved GLSL identifier in Chrome WebGL and must not be used as a variable name',
);
const declaredUniforms = new Set(
  [...shaderSource.matchAll(/uniform\s+\w+\s+(u[A-Za-z0-9_]+)/g)].map((match) => match[1]),
);
const suppliedUniforms = new Set(
  [...uniformBlock.matchAll(/^\s*(u[A-Za-z0-9_]+):/gm)].map((match) => match[1]),
);
assert.deepEqual(
  [...declaredUniforms].filter((name) => !suppliedUniforms.has(name)),
  [],
  'every shader uniform must be supplied by Three.js',
);
assert.deepEqual(
  [...suppliedUniforms].filter((name) => !declaredUniforms.has(name)),
  [],
  'every supplied uniform must be declared in the shader',
);

mustMatch(html, /pointer\.shiftKey \? -1 : 1/, 'shift-click must create a healing seed');
mustMatch(html, /renderer\.domElement\.addEventListener\('pointerdown'/, 'the organism must be directly seedable');
mustMatch(html, /renderer\.domElement\.addEventListener\('wheel'/, 'the camera must support direct zoom');
mustMatch(html, /Debug: prove the coupling/, 'coupling debug views must remain available');
mustMatch(
  html,
  /if \(Array\.isArray\(saved\.seeds\)\)[\s\S]*?seeds = cloneSeeds\(restored\)/,
  'persistence must restore both populated and deliberately empty seed sets',
);
mustMatch(html, /const SAVE_DOCUMENT_VERSION = 6/, 'named states must use a versioned save document');
mustMatch(
  html,
  /const saveDocument = \(\) => \(\{[\s\S]*?current: snapshot\(\)[\s\S]*?states: Object\.fromEntries\(namedStates\)/,
  'autosave and named states must coexist in one disk document',
);
mustMatch(
  html,
  /const snapshot = \(\) => \(\{[\s\S]*?seeds: cloneSeeds\(seeds\)[\s\S]*?camera: \{ yaw, pitch \}[\s\S]*?elapsed/,
  'state snapshots must include configuration, seeds, camera, and animation phase',
);
mustMatch(
  html,
  /if \(loadedDocument\?\.current[\s\S]*?restoreNamedStates\(loadedDocument\.states\)[\s\S]*?applySaved\(loadedDocument\.current\)[\s\S]*?else[\s\S]*?applySaved\(loadedDocument\)/,
  'versioned documents and legacy root snapshots must both load',
);
for (const action of ['saveNamedState', 'loadNamedState', 'deleteNamedState']) {
  mustMatch(html, new RegExp('function\\s+' + action + '\\('), 'missing named-state action ' + action);
}
mustMatch(
  html,
  /stateSelectController = stateSelectController\.options\(options\)/,
  'dynamic lil-gui option replacement must retain the newly created controller',
);
mustMatch(
  html,
  /stateSaveController\.domElement\.parentElement\.insertBefore\([\s\S]*?stateSelectController\.domElement[\s\S]*?stateSaveController\.domElement/,
  'the refreshed state selector must keep its place before the state action buttons',
);
mustMatch(html, /States: named snapshots/, 'the named-state controls must be visible in the GUI');
mustMatch(
  html,
  /toggle\.className = 'randomize-toggle'[\s\S]*?toggle\.setAttribute\('role', 'checkbox'\)[\s\S]*?enabled: deferredRandomizeEnabled\.get\(key\) \?\? true/,
  'each randomizable slider must get an enabled-by-default compact checkbox',
);
mustMatch(
  html,
  /if \(entry\.folder !== folder \|\| !entry\.enabled\) continue/,
  'section randomization must skip other folders and disabled sliders',
);
mustMatch(
  html,
  /CONFIG\[key\] = snappedRandom\(entry\.min, entry\.max, entry\.step\)/,
  'randomized slider values must respect their declared ranges and steps',
);
mustMatch(
  html,
  /const callbacks = new Set\(\)[\s\S]*?callbacks\.add\(entry\.onRandom\)[\s\S]*?for \(const callback of callbacks\) callback\(\)/,
  'section randomization must run each section-specific update callback once',
);
mustMatch(
  html,
  /randomization: Object\.fromEntries\([\s\S]*?entry\.enabled/,
  'slider randomization choices must be included in snapshots',
);
mustMatch(
  html,
  /applyRandomizationPreferences\(saved\.randomization\)/,
  'slider randomization choices must load from snapshots',
);
mustMatch(
  html,
  /function resetToDefaults\(\)[\s\S]*?randomizableControls\.values\(\)[\s\S]*?entry\.enabled = true[\s\S]*?paintRandomizeToggle\(entry\.toggle, true\)/,
  'reset must re-enable every randomizable slider',
);
mustMatch(
  html,
  /\.randomize-toggle \{[\s\S]*?all: unset[\s\S]*?flex: 0 0 12px; width: 12px; height: 12px/,
  'randomization toggles must be isolated from lil-gui full-width input styles',
);
mustMatch(
  html,
  /#gui-container \{[\s\S]*?height: 100dvh[\s\S]*?overflow-x: hidden; overflow-y: auto[\s\S]*?overscroll-behavior: contain/,
  'the expanded GUI must scroll independently inside the viewport',
);
mustMatch(
  html,
  /#gui-container > \.lil-gui\.root \{ max-height: none; \}/,
  'lil-gui must not clip its contents before the container can scroll them',
);
const randomizedFolders = [
  'growthFolder',
  'seedFolder',
  'organismFolder',
  'organicFolder',
  'crystalFolder',
  'interiorFolder',
  'colorFolder',
  'lightingFolder',
  'performanceFolder',
];
const randomizableSliderKeys = [
  ...html.matchAll(/^bind\([^,]+, '([^']+)'/gm),
].map((match) => match[1]);
assert.equal(randomizableSliderKeys.length, 74, 'every numeric slider should be registered for randomization');
assert.equal(
  new Set(randomizableSliderKeys).size,
  randomizableSliderKeys.length,
  'randomizable slider keys must be unique',
);
mustMatch(
  html,
  /function applySelectedSeedControls\(\)[\s\S]*?seed\.radius = CONFIG\.selectedSeedRadius[\s\S]*?seed\.strength = CONFIG\.selectedSeedStrength[\s\S]*?seed\.speed = CONFIG\.selectedSeedSpeed/,
  'selected-seed controls must edit the actual analytic seed state',
);
mustMatch(
  html,
  /function addSeed\([^)]*radius = CONFIG\.selectedSeedRadius[\s\S]*?strength: CONFIG\.selectedSeedStrength[\s\S]*?speed: CONFIG\.selectedSeedSpeed/,
  'newly placed seeds must inherit the seed editor values',
);
for (const folder of randomizedFolders) {
  mustMatch(
    html,
    new RegExp('addSectionRandomizer\\(' + folder + '\\)'),
    'missing section randomizer for ' + folder,
  );
}
assert.equal(
  (html.match(/addSectionRandomizer\([a-zA-Z]+Folder\)/g) || []).length,
  randomizedFolders.length,
  'only the nine numeric parameter sections should receive randomizers',
);
assert.ok(
  html.indexOf('const DEFAULT_CONFIG') < html.indexOf('await store.load()'),
  'authored reset defaults must be captured before persisted tuning loads',
);
mustMatch(
  html,
  /function resetToDefaults\(\)[\s\S]*?Object\.assign\(CONFIG[\s\S]*?seeds = cloneSeeds\(\)[\s\S]*?elapsed = 0/,
  'reset must restore configuration, authored seeds, and animation phase',
);

for (const slug of ['xbgWxvN', 'JobXbPW', 'vEyOYEX']) {
  mustMatch(html, new RegExp('codepen\\.io/sabosugi/pen/' + slug), 'missing source credit ' + slug);
}
mustMatch(html, /MIT-licensed works/, 'the visible credit must retain the source license');
mustMatch(html, /demos\/sdf-bug\.html/, 'the default shared SDF bug source must be visibly credited');
mustMatch(html, /demos\/sdf-creature\.html/, 'the shared creature source must be visibly credited');
mustMatch(html, /x\.com\/DrinLajci/, 'the creature concept credit must remain visible');
mustMatch(html, /'Anatomy material IDs': 6/, 'the shared material IDs must have a debug view');
mustMatch(html, /chIdMask\(state\.anatomy/, 'surface material must consume shared anatomy IDs');
mustMatch(html, /anatomyMode: 0/, 'the SDF bug must be the authored default anatomy');
mustMatch(html, /'SDF bug': 0[\s\S]*?'SDF creature': 1/, 'the GUI must retain both anatomy choices');

console.log('Chrysalis Engine structural checks passed.');
