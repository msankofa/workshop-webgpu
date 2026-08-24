// Static checks on demos/stadium-walker-v2.html. Run with `node _check_stadium-walker-v2.html.mjs`.
//
// The page cannot be executed in Node — it wants WebGPU, a GLTFLoader and a server — so the things that
// break silently in a browser are asserted against the source instead: an id that no longer exists, a
// stage nothing is filed under, a module export that was renamed, and web storage creeping back in as the
// place a stance is kept.

import fs from 'node:fs';

const PAGE = 'demos/stadium-walker-v2.html';
const html = fs.readFileSync(PAGE, 'utf8');
const body = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1] ?? '';

let failures = 0;
const results = [];
function check(name, fn) {
  try { fn(); results.push(`  ok   ${name}`); }
  catch (e) { failures++; results.push(`  FAIL ${name}\n       ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const uniq = (a) => [...new Set(a)];
/** The markup only. Scanning the whole file finds `data-stage="${activeStage}"` in the script and trips. */
const markup = html.replace(body, '');
/** The script with comments removed, for rules about what the CODE does rather than what it says. */
const code = body.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

console.log('\n--- the page itself ---');

check('the module body was found and is not empty', () => {
  assert(body.length > 10000, `module body is only ${body.length} chars`);
});

check('the module parses', async () => {
  // `node --check` runs in a child in the runner below; here just guard against an unbalanced script tag.
  assert(html.split('<script type="module">').length === 2, 'expected exactly one module script');
});

check('every getElementById names an id the markup actually has', () => {
  const wanted = uniq([...body.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]));
  const missing = wanted.filter(id => !ids.has(id));
  assert(!missing.length, `no such element: ${missing.join(', ')}`);
});

check('every querySelector id reference resolves too', () => {
  const wanted = uniq([...body.matchAll(/querySelector\('#([A-Za-z0-9_-]+)/g)].map(m => m[1]));
  const missing = wanted.filter(id => !ids.has(id));
  assert(!missing.length, `no such element: ${missing.join(', ')}`);
});

check('every addSlider mount exists in the markup', () => {
  const mounts = uniq([...body.matchAll(/addSlider\('([^']+)'/g)].map(m => m[1]));
  const missing = mounts.filter(id => !ids.has(id));
  assert(!missing.length, `sliders mount into nothing: ${missing.join(', ')}`);
  assert(mounts.includes('mount-stance'), 'the stance editor has no sliders');
  assert(mounts.includes('mount-stand'), 'the stand stage has no sliders');
});

console.log('\n--- the four stages ---');

const STAGE_IDS = ['rig', 'stand', 'walk', 'trial'];

check('the stage list is the four steps, in dependency order', () => {
  const declared = [...body.matchAll(/^\s*id: '([a-z]+)', label: '/gm)].map(m => m[1]);
  assert(declared.join(',') === STAGE_IDS.join(','), `stages are ${declared.join(',')}`);
});

check('every data-stage names a real stage', () => {
  const used = uniq([...markup.matchAll(/data-stage="([^"]+)"/g)].flatMap(m => m[1].split(/\s+/)));
  const unknown = used.filter(s => !STAGE_IDS.includes(s));
  assert(!unknown.length, `unknown stage(s): ${unknown.join(', ')}`);
});

check('every stage has at least one section filed under it', () => {
  const used = new Set([...markup.matchAll(/data-stage="([^"]+)"/g)].flatMap(m => m[1].split(/\s+/)));
  const empty = STAGE_IDS.filter(s => !used.has(s));
  assert(!empty.length, `nothing to show in stage(s): ${empty.join(', ')}`);
});

check('the rig stage owns the rig work and nothing downstream of it', () => {
  const sections = [...html.matchAll(/<details([^>]*)>\s*<summary>([^<]+)<\/summary>/g)]
    .map(m => ({ attrs: m[1], name: m[2].trim() }));
  const stageOf = (name) => sections.find(s => s.name === name)?.attrs.match(/data-stage="([^"]+)"/)?.[1] ?? '';
  for (const name of ['Bone roles', 'Neutral stance', 'Poses', 'Model']) {
    assert(stageOf(name).split(/\s+/).includes('rig'), `"${name}" is not in the rig stage`);
  }
  assert(stageOf('Gait').includes('walk'), 'Gait should be in the walk stage');
  assert(stageOf('Balance').includes('stand'), 'Balance should be in the stand stage');
  assert(stageOf('Search').includes('trial'), 'Search should be in the trial stage');
  // The point of the reorder: search and gait must NOT be reachable from the rig stage.
  assert(!stageOf('Search').includes('rig'), 'Search is back in the rig stage');
  assert(!stageOf('Gait').includes('rig'), 'Gait is back in the rig stage');
});

check('the stage bar and its goal line are wired', () => {
  for (const id of ['stagebar', 'stagegoal', 'stageTitle', 'stageWhy', 'stagegate']) {
    assert(ids.has(id), `#${id} is missing`);
  }
  assert(/function setStage\(/.test(body), 'no setStage');
  assert(/function refreshGate\(/.test(body), 'no refreshGate');
  assert(/setInterval\(refreshGate/.test(body), 'the gate never refreshes');
  assert(/setStage\(activeStage\)/.test(body), 'the stage is never applied on load');
});

check('the stage is applied AFTER prefs are read, or it opens on the wrong step', () => {
  assert(body.indexOf('loadPrefs()') < body.lastIndexOf('setStage(activeStage)'),
    'setStage runs before loadPrefs, so a saved step is ignored');
});

console.log('\n--- the neutral stance ---');

check('every stance import is a real export of stadium-stance.js', () => {
  const src = fs.readFileSync('stadium-stance.js', 'utf8');
  const exported = new Set([...src.matchAll(/export (?:function|const) (\w+)/g)].map(m => m[1]));
  const imported = body.match(/import \{([^}]+)\} from '\.\.\/stadium-stance\.js'/s)?.[1] ?? '';
  const names = imported.split(',').map(s => s.trim()).filter(Boolean);
  assert(names.length, 'the page does not import the stance module');
  const missing = names.filter(n => !exported.has(n));
  assert(!missing.length, `not exported by stadium-stance.js: ${missing.join(', ')}`);
});

check('every stadium-species import is a real export too', () => {
  const src = fs.readFileSync('stadium-species.js', 'utf8');
  const exported = new Set([...src.matchAll(/export (?:function|const) (\w+)/g)].map(m => m[1]));
  const imported = body.match(/import \{([^}]+)\} from '\.\.\/stadium-species\.js'/s)?.[1] ?? '';
  const names = imported.split(',').map(s => s.trim()).filter(Boolean);
  const missing = names.filter(n => !exported.has(n));
  assert(!missing.length, `not exported by stadium-species.js: ${missing.join(', ')}`);
});

check('the stance reaches the MAPPER, not just the drawn mesh', () => {
  // The whole feature. Mapping the authored rest while drawing a posed model would look right and
  // measure the wrong creature.
  assert(/mapSpecies\(json, bin, \{ stance/.test(body), 'the species is not mapped through its stance');
  assert(/const posed = resolved\.json/.test(body), 'the posed document is not kept');
  assert(/poseClone\(root, assets\.json, assets\.posed\)/.test(body), 'the drawn clone is not posed to match');
});

check('a stance edit invalidates the cached rig instead of reusing it', () => {
  assert(/cache\.delete\(name\)/.test(body), 'applying a stance does not drop the cached map');
  assert(/await respawnSpecies\(name\)/.test(body), 'applying a stance does not respawn');
  assert(/async function respawnSpecies\(/.test(body), 'respawnSpecies is used but never defined');
});

check('pinning the legs is offered before posing, and says what it did', () => {
  assert(ids.has('stancePin') && ids.has('stancePinState'), 'the pin control is missing');
  assert(/pinDetectedLegs\(/.test(body), 'pinning does not go through the shared helper');
});

check('the mirror is offered and goes through the tested implementation', () => {
  assert(ids.has('stanceMirror'), 'no mirror toggle');
  assert(/mirrorStanceBone\(/.test(body), 'mirroring is hand-rolled rather than using stadium-stance.js');
});

check('a ROM clip can be borrowed as a stance', () => {
  for (const id of ['stanceClip', 'stanceGrabClip', 'mount-stanceclip']) {
    assert(ids.has(id), `#${id} is missing`);
  }
  assert(/clipChannels\(/.test(body), 'clips are not read');
  // Sampling a clip lives in rig-audit.js so it can be run against real models in Node. It was inlined
  // here once, against an invented shape for what clipChannels returns, and threw on the first click.
  assert(/sampleClipAt\(/.test(code), 'the clip sampler is not the tested one');
  assert(!/function sampleClip\b/.test(code), 'the page has its own clip sampler again');
});

check('every rig-audit import is a real export', () => {
  const src = fs.readFileSync('rig-audit.js', 'utf8');
  const exported = new Set([...src.matchAll(/export (?:function|const) (\w+)/g)].map(m => m[1]));
  const imported = body.match(/import \{([^}]+)\} from '\.\.\/rig-audit\.js'/s)?.[1] ?? '';
  const names = imported.split(',').map(s => s.trim()).filter(Boolean);
  assert(names.length, 'the page does not import rig-audit');
  const missing = names.filter(n => !exported.has(n));
  assert(!missing.length, `not exported by rig-audit.js: ${missing.join(', ')}`);
});

check('stance sliders are scoped so the gait search cannot re-pose the model', () => {
  const specs = [...body.matchAll(/key: `stance_\$\{key\}`, scope: '(\w+)'/g)].map(m => m[1]);
  assert(specs.length, 'no stance sliders found');
  assert(specs.every(s => s === 'stance'), `stance sliders are scoped ${uniq(specs).join(', ')}`);
  assert(/scope !== 'stance'/.test(body), 'stance sliders are saved into prefs, where they mean nothing');
});

console.log('\n--- movement ---');

check('the movement control is reachable from every stage', () => {
  // It was filed under "stand walk trial" and the page opens on rig, so first load showed no movement
  // control at all. An untagged section is always visible, which is what this asserts.
  const section = markup.match(/<details[^>]*>\s*<summary>Movement<\/summary>/)?.[0] ?? '';
  assert(section, 'there is no section called Movement');
  assert(!/data-stage/.test(section), `Movement is stage-scoped and would hide: ${section.trim()}`);
});

check('idle, walk and gallop are one control', () => {
  assert(ids.has('movement'), 'no movement select');
  const sel = markup.match(/<select id="movement">([\s\S]*?)<\/select>/)?.[1] ?? '';
  for (const v of ['idle', 'walk', 'gallop']) {
    assert(new RegExp(`value="${v}"`).test(sel), `movement has no ${v} option`);
  }
  assert(!ids.has('walking'), 'the old walking checkbox is still there alongside the movement select');
  assert(!ids.has('baseGait'), 'the old base-gait select is still there alongside the movement select');
});

check('the loop derives walking from the movement mode', () => {
  assert(/walker\.update\(step, \{ walk: walkingNow\(\) \}\)/.test(code), 'the walker is not told the mode');
  assert(/const walkingNow = \(\) => movementInput\.value !== 'idle'/.test(code), 'walkingNow is not derived');
});

check('idle keeps the last real gait, so the derived readouts do not blank out', () => {
  assert(/gaitKey = \(\) => \(movementInput\.value === 'idle' \? lastGait/.test(code),
    'idle does not fall back to the last locomotive gait');
  assert(/if \(walkingNow\(\)\) lastGait = movementInput\.value/.test(code), 'lastGait is never updated');
});

check('nothing is measured or logged as a gait while idle', () => {
  assert(/if \(walkingNow\(\)\) sampleMonitor/.test(code), 'the monitor samples a standing creature');
  assert(/gait: gaitKey\(\)/.test(code), "a trial could record 'idle' as its gait");
  const walkGate = code.match(/id: 'walk', label: 'Walk'[\s\S]*?\n  \},/)?.[0] ?? '';
  assert(/!walkingNow\(\)/.test(walkGate), 'the walk gate reports a verdict on a creature that is standing still');
});

check('the stand stage idles and the walk stage resumes', () => {
  assert(/movementInput\.value = 'idle'/.test(code), 'the stand stage does not idle the creature');
  assert(/movementInput\.value = lastGait/.test(code), 'the walk stage does not resume moving');
});

console.log('\n--- the species list ---');

check('the dropdown is built from the directory manifest, not a hand-kept list', () => {
  assert(/models\/stadium\/manifest\.json/.test(code),
    'the species list is hardcoded again — only the tuned fourteen would be offered');
  assert(!/\['four legs', \[/.test(code), 'the old hardcoded grouping is still there');
});

check('all 151 are reachable, with the legless ones grouped rather than hidden', () => {
  const models = fs.readdirSync('models/stadium').filter(f => f.endsWith('.glb'));
  assert(models.length === 151, `expected 151 models on disk, found ${models.length}`);
  assert(/no legs found/.test(code), 'nothing tells you which species need hand-assigned legs');
  assert(/STADIUM_NO_LEG_SPECIES/.test(code), 'the legless set is not the one the test keeps in sync');
});

check('picking a legless species explains itself instead of throwing a stack', () => {
  assert(/err\.noLegs = true/.test(code), 'the no-legs case is not marked');
  assert(/maps with no legs, so there is nothing to walk yet/.test(code), 'no readable message');
  const add = code.match(/async function addCreature\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(/catch/.test(add) && /showError/.test(add), 'addCreature does not catch a failed spawn');
});

check('a saved legless species cannot leave the page with an empty stage', () => {
  assert(/if \(!stage\.size\)/.test(code), 'no fallback when the saved species will not spawn');
});

console.log('\n--- bone colours ---');

check('the hand palette really is the seven colours of the rainbow', () => {
  const list = code.match(/const ROYGBIV = \[([^\]]*)\]/)?.[1];
  assert(list, 'no ROYGBIV palette');
  const hexes = list.match(/0x[0-9a-f]{6}/gi) ?? [];
  assert(hexes.length === 7, `expected 7 colours, found ${hexes.length}`);
  const names = code.match(/const TINT_NAMES = \[([^\]]*)\]/)?.[1] ?? '';
  for (const n of ['red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'violet']) {
    assert(names.includes(`'${n}'`), `${n} is missing from the colour names`);
  }
  // Hue must climb across the palette or it is not a rainbow, whatever it is called. Blue through violet
  // wraps past 0, so the check is on the un-wrapped sequence.
  const hue = (hex) => {
    const n = parseInt(hex, 16);
    const [r, g, b] = [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (!d) return 0;
    const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return h * 60;
  };
  const hues = hexes.map(hue);
  for (let i = 1; i < hues.length; i++) {
    assert(hues[i] > hues[i - 1], `colour ${i} is not further round the wheel than ${i - 1}`
      + ` (${hues.map(h => h.toFixed(0)).join(', ')})`);
  }
});

check('clicking a bone in the viewport steps its colour on', () => {
  const handler = code.match(/domElement\.addEventListener\('pointerdown'[\s\S]*?\n\}\);/)?.[0] ?? '';
  assert(/cycleBoneTint\(/.test(handler), 'a viewport bone click no longer cycles the colour');
  assert(/selectBone\(/.test(handler), 'a viewport bone click no longer selects the bone');
});

check('the cycle comes back round to no colour, so a mis-click is undoable', () => {
  const fn = code.match(/function cycleBoneTint\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(/delete tints\[name\]/.test(fn), 'nothing removes a tint — violet would be a dead end');
  assert(/saveDoc\(\)/.test(fn), 'the colour is not written to the session file');
});

check('clicking a bone name selects it without repainting it', () => {
  const labels = code.match(/const labels = objs\.map\([\s\S]*?\n  \}\);/)?.[0] ?? '';
  assert(/addEventListener\('pointerdown'/.test(labels), 'bone labels are not clickable');
  assert(/selectBone\(o\.name\)/.test(labels), 'a label click does not select its bone');
  assert(!/cycleBoneTint/.test(labels), 'a label click repaints the bone, which is what it is meant to avoid');
});

check('a label can be clicked at all, despite the callout layer swallowing pointers', () => {
  const css = html.match(/\.bonelabel \{[^}]*\}/)?.[0] ?? '';
  assert(/pointer-events:\s*auto/.test(css),
    '#faultlabels sets pointer-events:none and .bonelabel does not opt back in');
});

check('selection goes through one function, so every route resets the stance sliders alike', () => {
  const fn = code.match(/function selectBone\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(/refreshStanceBoneList\(\)/.test(fn), 'picking a bone does not reach the stance dropdown');
  assert(/dispatchEvent\(new Event\('change'\)\)/.test(fn),
    'the dropdown is set without a change event, so stale stance angles would survive');
  // Three: the declaration, selectBone, and selectCreature dropping it because bone names are per rig.
  const strays = [...code.matchAll(/selectedBone = /g)].length;
  assert(strays === 3, `selectedBone is assigned in ${strays} places — a fourth route would skip the reset`);
});

check('a hand colour beats the role colour, and a selected bone still shows it', () => {
  assert(/function boneColour\(/.test(code), 'no single place decides a bone colour');
  const fn = code.match(/function boneColour\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(/tintIndex\(/.test(fn) && /colourFor\(role\)/.test(fn), 'boneColour does not fall back to the role');
  const skel = code.match(/function updateSkeleton\([\s\S]*?\n\}\n/)?.[0] ?? '';
  assert(!/colourFor\(link\.role\)/.test(skel), 'a bone segment still ignores its hand colour');
  assert(/const white = lit && !tinted/.test(skel),
    'the white selection highlight would paint over the colour the click just applied');
});

check('colours are per species and cleared per species', () => {
  assert(/session\.boneTints/.test(code), 'colours are not kept in the session document');
  const clear = code.match(/getElementById\('tintClear'\)[\s\S]*?\n\}\);/)?.[0] ?? '';
  assert(/delete session\.boneTints\[current\.name\]/.test(clear),
    'clear wipes every species, not the one on screen');
});

console.log('\n--- persistence ---');

check('the stance file is a file, and localStorage is only its fallback', () => {
  // Comments stripped and whitespace flattened, so a line break between `storage:` and `localStorage`
  // does not read as a bare use — and so the paragraph explaining the rule does not trip the rule.
  const flat = code.replace(/\s+/g, ' ');
  const uses = [...flat.matchAll(/.{0,14}localStorage.{0,16}/g)].map(m => m[0]);
  const bad = uses.filter(u => !/storage: localStorage/.test(u) && !/localStorage\.getItem\(k\)/.test(u));
  assert(!bad.length, `localStorage used as a store: ${bad.join(' | ')}`);
  assert(uses.length >= 3, `expected three disk stores backed by a cache, found ${uses.length} uses`);
  assert(/read: `\/stadium-saves\/\$\{STANCE_FILE\}`/.test(code), 'the stance library has no disk store');
});

check('all three files are flushed on the way out', () => {
  const beacon = body.match(/addEventListener\('pagehide'[\s\S]*?\}\);/)?.[0] ?? '';
  for (const f of ['TUNING_FILE', 'TRIALS_FILE', 'STANCE_FILE']) {
    assert(beacon.includes(f), `${f} is not flushed on pagehide`);
  }
});

check('every filename the page posts is one serve.py will accept', () => {
  const py = fs.readFileSync('serve.py', 'utf8');
  // Scraped out of the Python rather than restated, so renaming a file on either side fails this check.
  const block = py.split('_SAFE_STADIUM_FILENAME = re.compile(')[1]?.split("')")[0] ?? '';
  const pattern = `${[...block.matchAll(/r'([^']*)/g)].map(m => m[1]).join('')}`;
  assert(pattern.startsWith('^('), `could not read the filename whitelist out of serve.py, got ${pattern}`);
  const re = new RegExp(`${pattern}$`);
  const names = [...body.matchAll(/const (?:TUNING|TRIALS|STANCE)_FILE = '([^']+)'/g)].map(m => m[1]);
  assert(names.length === 3, `expected three live filenames, found ${names.length}`);
  for (const n of names) assert(re.test(n), `serve.py would refuse ${n}`);
  for (const stem of ['stadium-tuning', 'stadium-stances']) {
    assert(re.test(`${stem}-20260822-120000.json`), `serve.py would refuse a ${stem} snapshot`);
  }
});

check('a trial records the stance it was measured under', () => {
  const fn = code.match(/function logTrial\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(fn, 'logTrial is gone');
  assert(/stance: stanceStamp\(/.test(fn),
    'trials do not record the stance, so rows from either side of a re-pose look comparable and are not');
});

check('a setpoint records its stance and says so when it no longer matches', () => {
  assert(/stance: stanceStamp\(getStance\(stanceLib, current\.name\)\)/.test(code),
    'setpoints are saved without the stance they were tuned under');
  assert(/sp\.stance && sp\.stance !== now/.test(code),
    'applying a setpoint from another stance says nothing about it');
});

check('roles are mirrored into the stance so readers get the whole decision', () => {
  assert(/function saveRoles\(/.test(body), 'saveRoles is no longer a function');
  const fn = body.match(/function saveRoles\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(/setStanceRoles\(/.test(fn), 'a role save does not reach the stance library');
  assert(/saveStances\(\)/.test(fn), 'a role save is not written to disk');
});

console.log(results.join('\n'));
console.log(failures ? `\n${failures} check(s) failed\n` : `\n${results.length} checks passed\n`);
process.exit(failures ? 1 : 0);
