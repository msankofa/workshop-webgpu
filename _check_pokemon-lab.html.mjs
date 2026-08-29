// Static checks on pokemon-lab.html. Run with `node _check_pokemon-lab.html.mjs`.
//
// The page cannot run in Node — it wants WebGPU, a GLTFLoader and a server — so the things that break
// silently in a browser are asserted against the source instead: an element id that no longer exists, a
// module export that was renamed, a fetch of a path the server does not serve, and web storage creeping
// back in as the place the work is kept.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const PAGE = 'pokemon-lab.html';
const html = fs.readFileSync(PAGE, 'utf8');
const body = html.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1] ?? '';
const code = body.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
const markup = html.replace(body, '');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

let failures = 0;
const results = [];
function check(name, fn) {
  try { fn(); results.push(`  ok   ${name}`); }
  catch (e) { failures++; results.push(`  FAIL ${name}\n       ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

console.log('\n--- the page itself ---');

check('there is exactly one module script, and it is not a stub', () => {
  assert(html.split('<script type="module">').length === 2, 'expected exactly one module script');
  assert(body.length > 5000, `module body is only ${body.length} chars`);
});

check('the module parses as JavaScript', () => {
  fs.writeFileSync('.check-pokemon-lab.tmp.mjs', body);
  try { execFileSync(process.execPath, ['--check', '.check-pokemon-lab.tmp.mjs'], { stdio: 'pipe' }); }
  finally { fs.unlinkSync('.check-pokemon-lab.tmp.mjs'); }
});

check('every element the code reaches for exists in the markup', () => {
  const wanted = [...code.matchAll(/\$\('([^']+)'\)|getElementById\('([^']+)'\)/g)]
    .map(m => m[1] || m[2]);
  assert(wanted.length > 15, `only found ${wanted.length} element lookups, which suggests the regex missed`);
  const missing = [...new Set(wanted)].filter(id => !ids.has(id));
  assert(!missing.length, `the code reads ids the markup does not have: ${missing.join(', ')}`);
});

check('every id in the markup is used, so nothing is left over from an earlier layout', () => {
  // Reached by the module, by a CSS selector, or by the inline error handler — anything else is dead.
  const used = new Set([...html.matchAll(/\$\('([^']+)'\)|getElementById\('([^']+)'\)/g)].map(m => m[1] || m[2]));
  // Selector text only: scanning the whole stylesheet would read every hex colour as an id.
  const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  for (const rule of css.split('}')) {
    for (const m of rule.split('{')[0].matchAll(/#([\w-]+)/g)) used.add(m[1]);
  }
  const unused = [...ids].filter(id => !used.has(id));
  assert(!unused.length, `ids nothing reads: ${unused.join(', ')}`);
});

check('the error trap is installed before the module runs', () => {
  const trap = html.indexOf("addEventListener('error'");
  const module = html.indexOf('<script type="module">');
  assert(trap > -1 && trap < module, 'the error handler must come before the module or a load failure is silent');
});

console.log('\n--- what it imports ---');

const imports = [...code.matchAll(/import\s+(?:\*\s+as\s+\w+|\{([^}]*)\}|\w+)\s+from\s+'([^']+)'/g)]
  .map(m => ({ names: (m[1] || '').split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean), from: m[2] }));

check('every local module it imports exists', () => {
  for (const im of imports) {
    if (!im.from.startsWith('.')) continue;
    assert(fs.existsSync(im.from.replace(/^\.\//, '')), `imports ${im.from}, which does not exist`);
  }
});

check('every name it imports is actually exported', () => {
  for (const im of imports) {
    if (!im.from.startsWith('.')) continue;
    const src = fs.readFileSync(im.from.replace(/^\.\//, ''), 'utf8');
    for (const name of im.names) {
      const exported = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|let|class)\\s+${name}\\b`).test(src)
        || new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(src);
      assert(exported, `imports ${name} from ${im.from}, which does not export it`);
    }
  }
});

check('it reads the rig through pokemon-rig.js and not the old mapper', () => {
  assert(/from '\.\/pokemon-rig\.js'/.test(code), 'expected pokemon-rig.js');
  assert(!/stadium-rig-map/.test(code), 'this page must not use the old mapper — guesses live elsewhere now');
});

console.log('\n--- where the work goes ---');

check('the annotation library is kept in a file, not in web storage', () => {
  // localStorage is allowed exactly once, as the fallback cache handed to the disk store.
  const uses = [...code.matchAll(/localStorage/g)].length;
  assert(uses === 1, `localStorage appears ${uses} times; it may only be the store's fallback cache`);
  assert(/createLabStore\(\{\s*storage:\s*localStorage/.test(code),
    'the only localStorage use must be the disk store fallback');
  assert(!/localStorage\.(setItem|getItem)/.test(code), 'nothing may read or write web storage directly');
});

check('every change to the library goes through the undo history, which is what saves it', () => {
  // Stronger than counting edits against saves: if `library` can only be assigned inside commit, undo and
  // redo, then no edit can skip either the history or the file.
  const assigns = [...code.matchAll(/\blibrary\s*=\s*/g)].length;
  assert(assigns === 3, `library is assigned in ${assigns} places; only commit, undo and redo may do it`);
  const commit = code.match(/function commit\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(commit.includes('history.past.push'), 'commit does not record history');
  assert(commit.includes('saveLibrary()'), 'commit does not write to the file');
  for (const fn of ['undo', 'redo']) {
    const src = code.match(new RegExp(`function ${fn}\\(\\)[\\s\\S]*?\\n\\}`))?.[0] ?? '';
    assert(src.includes('saveLibrary()'), `${fn} does not write to the file`);
  }
  assert(/commit\(putAnnotation\(/.test(code), 'no edit actually calls commit');
});

check('redo is dropped as soon as a new edit lands', () => {
  const commit = code.match(/function commit\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(/future\.length = 0/.test(commit), 'editing after an undo must not leave a stale redo stack');
});

check('unsaved work is flushed on the way out', () => {
  assert(/beforeunload[\s\S]{0,120}store\.flush\(\)/.test(code), 'no flush on beforeunload');
});

check('the fetched paths are ones serve.py serves', () => {
  const fetched = [...code.matchAll(/fetch\(([^)]*)\)/g)].map(m => m[1]);
  assert(fetched.length, 'nothing is fetched, which cannot be right');
  for (const f of fetched) {
    assert(/modelURL|snapshotWriteURL/.test(f), `an unrecognised fetch: ${f}`);
  }
  // The model directory and the manifest both come from pokemon-lab-io.js rather than being retyped here.
  assert(!/models\/stadium/.test(code), 'the model path belongs in pokemon-lab-io.js, not in the page');
});

console.log('\n--- the browse mode itself ---');

check('a segment is saved by a click, and a suggestion never saves itself', () => {
  assert(/suggestedIdle/.test(code), 'the manifest suggestion is not shown at all');
  const save = code.match(/saveSegBtn'\)\.addEventListener[\s\S]*?\n\}\);/)?.[0] ?? '';
  assert(save.includes('setSegment'), 'the save button does not write a segment');
  assert(save.includes('commit('), 'the save button does not reach the file');
  assert(!/putAnnotation\([^)]*suggestedIdle/.test(code),
    'a suggested idle must not be written without somebody naming it');
});

check('the transport derives its frame rate and frame count rather than writing 30 down', () => {
  assert(/fpsOf/.test(code) && /lastFrame/.test(code), 'no per-clip frame rate or frame count');
  assert(/\.fps\b/.test(code) && /\.frames\b/.test(code), 'the rig measures both; the page should read them');
  // A fallback of `|| 30` is fine. Arithmetic on a literal 30 means somebody assumed the rate.
  assert(!/[*/]\s*30\b/.test(code), 'a hardcoded 30 is used as a frame rate somewhere');
});

check('the page owns the clock, so a range can loop, hold or run backwards', () => {
  // Every mixer update must be a zero-delta one: if the mixer advanced time too, the two would fight.
  const updates = [...code.matchAll(/mixer\.update\(([^)]*)\)/g)].map(m => m[1].trim());
  assert(updates.length, 'the mixer is never updated, so nothing would move');
  for (const arg of updates) assert(arg === '0', `mixer.update(${arg}) advances time the page is also setting`);
  assert(/play\.to\s*>=\s*play\.from|play\.to\s*<\s*play\.from/.test(code), 'nothing decides the direction');
  assert(/ends\s*===\s*'hold'/.test(code), 'a held range is not handled');
});

check('a segment is a slice of a clip, never a copy of its keyframes', () => {
  // Baking would show up as either duplicating a clip or rewriting its tracks. Vector clones for the rest
  // pose are a different thing entirely, so the check names the two real signs rather than the word.
  assert(!/\.tracks\b/.test(code), 'the page rewrites animation tracks, which would bake a segment');
  assert(!/AnimationClip|\bclip\.clone\(/.test(code), 'the page duplicates a clip rather than referencing a range');
});

check('a slower load cannot overwrite a faster click', () => {
  assert(/loadToken/.test(code), 'no load token');
  assert(/token !== loadToken/.test(code), 'the load token is never compared, so it does nothing');
});

check('the grid has a fixed number of divisions, not a fixed spacing', () => {
  // Spacing pinned at 0.5 made the LINE COUNT scale with the model: Moltres is 320 units across, which
  // came to 2,560 divisions and 5,122 lines. Edge-on from below they pile into one band, each still
  // spanning the screen.
  const g = code.match(/new THREE\.GridHelper\([^)]*\)/)?.[0] ?? '';
  assert(g, 'no GridHelper');
  const divisions = g.split(',')[1]?.trim() ?? '';
  assert(/^\d+$/.test(divisions), `grid divisions should be a constant, got "${divisions}"`);
  assert(Number(divisions) <= 100, `${divisions} grid divisions is more than anyone can resolve`);
});

check('the skeleton overlay does not recompute a bounding volume nothing reads', () => {
  const update = code.match(/function updateSkeleton\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(!/computeBoundingSphere/.test(update), 'the overlay is frustumCulled = false, so nothing uses it');
});

check('the camera is framed from the measured rig, not from a bounding box', () => {
  assert(/frameCamera\(/.test(code), 'no camera framing');
  assert(!/setFromObject|Box3/.test(code),
    'a skinned mesh bounding box is garbage on these models — frame from rig.units instead');
});

check('materials are fixed up for the two quirks these models have', () => {
  assert(/frustumCulled\s*=\s*false/.test(code), 'parts will vanish with camera angle without this');
  assert(/DoubleSide/.test(code), 'some face decals are wound backwards');
});

check('models that leave the cache are disposed', () => {
  assert(/disposeAssets/.test(code), 'no disposal');
  assert(/geometry\.dispose\(\)/.test(code) && /m\.dispose\(\)/.test(code), 'geometry or materials are leaked');
  assert(/dropped !== current/.test(code), 'the model on screen could be disposed out from under the renderer');
});

console.log('\n--- the viewport additions ---');

check('a ghost never disposes geometry it shares with the live model', () => {
  const clear = code.match(/function clearGhosts\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert(clear, 'no clearGhosts');
  assert(!/geometry\.dispose/.test(clear),
    'clearGhosts disposes geometry that skeletonClone shares with the live model, which would empty the viewport');
  assert(/material\.dispose\(\)/.test(clear), 'the ghost material is leaked');
});

check('which ghosts to show and where to put them stay independent', () => {
  // These are two separate questions and welding them together was the first version's mistake: offset
  // must not imply both, and overlap must not imply one.
  const build = code.match(/function buildGhosts\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  const wants = build.match(/const wants =[\s\S]*?;\n/)?.[0] ?? '';
  const specs = build.match(/const specs =[\s\S]*?;\n/)?.[0] ?? '';
  assert(wants.includes("which === 'both'"), 'the ghost selection has no both option');
  assert(!/mode/.test(wants), 'which ghosts to show is decided by the position mode');
  assert(specs.includes("mode === 'offset'"), 'the position mode does not decide the position');
  assert(!/which/.test(specs.replace(/wants/g, '')), 'the position is decided by which ghosts are shown');
});

check('all three ghost selections are reachable', () => {
  assert(/GHOST_WHICH = \['start', 'end', 'both'\]/.test(code), 'the selection list is not the three states');
  assert(/GHOST_WHICH\.indexOf\(ghosts\.which\) \+ 1\) % GHOST_WHICH\.length/.test(code),
    'the pose button does not cycle through every choice');
});

check('no ghost toggle moves the camera', () => {
  for (const btn of ['ghostBtn', 'ghostModeBtn', 'ghostPoseBtn']) {
    const src = code.match(new RegExp(`\\$\\('${btn}'\\)\\.addEventListener[\\s\\S]*?\\n\\}\\);`))?.[0] ?? '';
    assert(src, `no handler for ${btn}`);
    assert(!/camera|controls\.update|frameCamera|refit/.test(src),
      `${btn} moves the camera, which throws away the angle the user orbited to`);
  }
});

check('a ghost failing cannot stop a species from loading', () => {
  const build = code.match(/function buildGhosts\(\)[\s\S]*?\n\}/)?.[0] ?? '';
  assert(/try \{/.test(build) && /catch/.test(build), 'buildGhosts is not guarded');
  assert(/showError\(/.test(build), 'a ghost failure would be silent');
});

check('clicking the gizmo does not leave the camera orbiting', () => {
  assert(!/handleClick\(ev\)\) ev\.stopPropagation/.test(code),
    'swallowing the pointerup leaves OrbitControls stuck mid-drag');
  assert(/controls\.enabled = false/.test(code) && /controls\.enabled = true/.test(code),
    'controls must be switched off for the duration of a gizmo click and back on afterwards');
});

check('ghosts are cloned skeleton-aware, or posing one would pose the model', () => {
  assert(/skeletonClone\(/.test(code), 'no skeleton-aware clone');
  assert(!/\.clone\(true\)/.test(code), 'a plain deep clone shares the skeleton');
});

check('the ghosts follow the range rather than being posed once', () => {
  for (const caller of ['playClip', 'afterRangeEdit']) {
    const src = code.match(new RegExp(`function ${caller}\\([\\s\\S]*?\\n\\}`))?.[0] ?? '';
    assert(src.includes('poseGhosts()'), `${caller} changes the range but does not move the ghosts`);
  }
});

check('the axis gizmo cannot take the page down with it', () => {
  assert(/new ViewHelper\(/.test(code), 'no axis gizmo');
  const loop = code.match(/setAnimationLoop\([\s\S]*?\n\}\);/)?.[0] ?? '';
  assert(/try \{/.test(loop) && /viewHelper = null/.test(loop), 'the gizmo is not guarded in the render loop');
  assert(/renderer\.autoClear = true/.test(loop),
    'dropping the gizmo must restore autoClear, or the scene stops clearing and smears');
});

check('the scrubber can run continuously, since the pose already can', () => {
  // The mixer interpolates between keys, so a fractional frame is a real pose. Snapping is a scrubbing
  // convenience and must not be baked into the playhead itself.
  assert(/\$\('scrub'\)\.step = on \? '1' : 'any'/.test(code), 'the scrubber step does not follow the toggle');
  assert(!/scrub'\)\.value = String\(Math\.round/.test(code),
    'the scrubber is written back rounded, which would quantise a continuous scrub');
  assert(/play\.snap/.test(code), 'no snap state');
});

check('a step from a fractional frame lands on the next whole one', () => {
  const step = code.match(/function stepFrame\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(/Math\.floor\(play\.frame\)/.test(step) && /Math\.ceil\(play\.frame\)/.test(step),
    'stepping rounds first, so a step from frame 12.6 would skip frame 13');
});

check('nothing starts playback except the play button', () => {
  // Marking a range or flipping a toggle must not take the transport off pause. playClip decides from its
  // own autoplay argument and the play button flips whatever it finds, so neither writes the literal.
  assert(!/play\.paused = false/.test(code),
    'something sets playback running on its own');
});

check('stepping moves exactly one frame and never leaves the clip', () => {
  const step = code.match(/function stepFrame\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(step, 'no stepFrame');
  assert(/lastFrame\(/.test(step) && /Math\.max\(0/.test(step), 'stepping is not clamped to the clip');
  assert(/paused = true/.test(step), 'stepping should stop playback, or the frame runs away from you');
});

check('a state can be captured from the frame on screen', () => {
  assert(ids.has('markPoseBtn'), 'no Mark pose button');
  const h = code.match(/\$\('markPoseBtn'\)\.addEventListener[\s\S]*?\n\}\);/)?.[0] ?? '';
  assert(h, 'Mark pose has no handler');
  assert(/play\.from = play\.to =/.test(h), 'a marked pose must set both ends to the same frame');
  assert(/ends = 'hold'/.test(h), "a marked pose must hold, or it is not a single frame");
  assert(/Math\.round/.test(h), 'a marked pose must land on a whole frame, since that is the file format');
  assert(/markPoseBtn/.test(code.match(/setInBtn', 'setOutBtn'[^\]]*\]/)?.[0] ?? ''),
    'Mark pose is not enabled and disabled with the other range buttons');
});

check('nothing writes a segment kind down, because the range already says it', () => {
  // A stored kind can disagree with its own range once the range is edited. Derive it every time.
  assert(!/kind:\s*'(state|transition)'/.test(code), 'the page is storing a kind on a segment');
  assert(/segmentKind\(/.test(code), 'the page should ask pokemon-annotation.js what a segment is');
  const save = code.match(/\$\('saveSegBtn'\)\.addEventListener[\s\S]*?\n\}\);/)?.[0] ?? '';
  assert(!/kind/.test(save), 'saving must not write a kind into the file');
});

check('the shared state names are offered, not enforced', () => {
  assert(/COMMON_STATES/.test(code), 'the name suggestions should come from the shared vocabulary');
  const names = code.match(/function refreshSegmentNames\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(/new Set\(COMMON_STATES\)/.test(names), 'the datalist should start from the shared names');
  // The field is a text input with a datalist, never a select, or Squirtle could not have in_shell.
  assert(/<input[^>]*id="segName"[^>]*list="segNames"/.test(markup), 'the name field must stay free text');
});

check('the skeleton is drawn over the mesh, or you cannot see the bone inside the leg', () => {
  const build = code.match(/function buildSkeleton\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(build, 'no buildSkeleton');
  assert((build.match(/depthTest: false/g) || []).length >= 2, 'both the joints and the segments must ignore depth');
  assert(/renderOrder/.test(build), 'the overlay must draw after the model');
  assert(/frustumCulled = false/.test(build), 'these models have garbage bounding volumes, so culling must be off');
});

check('bones are picked in screen space, matching what is drawn', () => {
  // A raycast would disagree with the picture every time a bone sits behind a leg, because the overlay
  // ignores depth. Screen-space nearest is also forgiving where joints are a few pixels apart.
  assert(/nearestPoint\(/.test(code), 'picking should go through pokemon-select.js');
  const at = code.match(/function boneAt\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(at, 'no boneAt');
  assert(!/Raycaster|intersect/.test(at), 'picking a bone must not raycast');
  assert(/getBoundingClientRect/.test(at), 'a hit must be measured against the canvas, not the page');
  // A raycaster is fine for the drag PLANE, which is a different job. Anywhere else and picking has
  // quietly grown a second implementation.
  const rays = [...code.matchAll(/_?ray\w*\.(setFromCamera|intersect\w+)/g)].length;
  const inDrag = [...(code.match(/function dragPoint\([\s\S]*?\n\}/)?.[0] ?? '').matchAll(/_?ray\w*\.(setFromCamera|intersect\w+)/g)].length;
  assert(rays === inDrag, `${rays - inDrag} raycast call(s) outside dragPoint`);
});

check('a click that moved the camera is not a pick', () => {
  const click = code.match(/renderer\.domElement\.addEventListener\('click',[\s\S]*?\n\}\);/)?.[0] ?? '';
  assert(/Math\.hypot/.test(click) && /downAt/.test(click), 'an orbit drag would otherwise select a bone on release');
});

check('the two gestures share one selection, so there is no mode to be in', () => {
  const click = code.match(/renderer\.domElement\.addEventListener\('click',[\s\S]*?\n\}\);/)?.[0] ?? '';
  assert(/toggleKeys\(/.test(click), 'both gestures must go through the one primitive');
  assert(/shiftKey \? chainKeysOf/.test(click), 'shift should pick the chain and a plain click the bone');
  assert(!/selectedChains|chainMode|selectionMode/.test(code), 'there must not be a second selection or a mode flag');
});

check('a selection does not survive a change of species', () => {
  const select = code.match(/async function selectSpecies\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(/skel\.selected = new Set\(\)/.test(select), 'bone keys mean nothing on the next skeleton');
});

check('posing and playback cannot both own the bones', () => {
  // A running clip rewrites every animated bone each frame, so a pose would be erased on the next one.
  const set = code.match(/function setPoseMode\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(set, 'no setPoseMode');
  assert(/play\.paused = true/.test(set), 'turning Pose on must stop the clip');
  // Anchored on the whole function, not on a line inside it -- renaming that line silently emptied the
  // slice and the assertion below then passed on nothing.
  const transport = code.match(/function refreshTransport\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(/const live/.test(transport), 'the refreshTransport slice is empty, so this check reads nothing');
  assert(/!pose\.on/.test(transport), 'the transport must be disabled while Pose is on');
});

check('the reach comes from the selection first and the slider second', () => {
  const begin = code.match(/function beginPose\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(begin, 'no beginPose');
  assert(/selectedReach\([^)]*\) \|\| pose\.reach/.test(begin),
    'a selected run should set the reach, falling back to the slider when it says nothing');
  assert(/chain\.length < 2/.test(begin), 'a bone with nothing above it is not a grab');
});

check('the drag target is plain data, not a scratch vector something else will overwrite', () => {
  // This shipped broken once. dragPoint returned a shared Vector3, and the next line read every bone's
  // world position into that same vector, so the solver was handed the grabbed bone's CURRENT position as
  // its target and dragging did nothing at all.
  const point = code.match(/function dragPoint\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(point, 'no dragPoint');
  assert(/\[_\w+\.x, _\w+\.y, _\w+\.z\]/.test(point), 'dragPoint must return numbers, not a reused vector');
  const drag = code.match(/function dragPose\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(!/target\.[xyz]/.test(drag), 'reading .x off the target means it is still a vector');
});

check('the chain is resolved on grab, not rebuilt on every pointer move', () => {
  const drag = code.match(/function dragPose\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(!/new Map\(/.test(drag), 'a name-to-index map per pointermove is rebuilt thousands of times a drag');
  assert(/pose\.objects/.test(drag), 'the bone objects should be resolved once in beginPose');
});

check('a solved chain is applied top-down, since a local rotation depends on a moved parent', () => {
  const drag = code.match(/function dragPose\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(drag, 'no dragPose');
  assert(/for \(let i = 0; i < turns\.length; i\+\+\)/.test(drag), 'the loop must run from the anchor down');
  assert(/updateWorldMatrix\(false, false\)/.test(drag),
    'each bone must be settled before its child reads it, and only that bone');
  assert(!/updateMatrixWorld\(true\)/.test(drag),
    'forcing the subtree redoes the same work once per chain bone per pointer move');
  assert(/getWorldQuaternion/.test(drag), 'the solver returns world deltas, which need the world rotation');
});

check('a pose reaches the file, and records the whole stance rather than the edits', () => {
  const take = code.match(/\$\('takeNeutralBtn'\)\.addEventListener[\s\S]*?\n\}\);/)?.[0] ?? '';
  assert(/setNeutralBone\(/.test(take), 'it must write through the annotation schema');
  assert(/commit\(putAnnotation/.test(take), 'and through the undo history, which is what saves it');
  assert(/current\.rig\.bones\.entries\(\)/.test(take), 'every bone, not only the ones that moved');
});

check('both angular limits reach the drag and the ragdoll, from one control each', () => {
  // A positional solver cannot see twist -- turning a single-child bone about its own length moves nothing
  // -- so it has to be clamped where rotations are handed back, in both places that do that.
  assert(/function twistLimit\(/.test(code), 'no shared twist limit');
  assert(/function bendLimit\(/.test(code), 'no shared bend limit');
  const drag = code.match(/function dragPose\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(/limitChain\(\)/.test(drag), 'the drag must clamp the chain');
  const step = code.match(/function stepRagdollFrame\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(/maxTwist: twistLimit\(\)/.test(step), 'the ragdoll must pass the twist limit through');
  assert(/maxBend: bendLimit\(\)/.test(step), 'the ragdoll must pass the bend limit through');
  for (const id of ['twistLimit', 'bendLimit']) {
    const html = markup.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`))?.[0] ?? '';
    assert(/max="180"/.test(html), `${id} must reach 180, which is where nothing is limited`);
  }
});

check('the angular limits measure from the grab, not from one pointer move', () => {
  // `before` is re-read every move, so the turn it carries is a single frame's worth. Clamping THAT bounds
  // how fast a bone may turn and not how far -- dragging slowly went wherever it liked.
  const begin = code.match(/function beginPose\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(/pose\.seedQ = /.test(begin) && /pose\.seedPos = /.test(begin), 'the grab must record the pose it started from');
  const limit = code.match(/function limitChain\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(/qconj\(seedQ\[i\]\)/.test(limit), 'the turn must be measured against the seeded rotation');
  assert(/seedPos\[i \+ 1\]/.test(limit), 'the axis must be the direction the bone pointed when it was grabbed');
  assert(/parent = fixed/.test(limit), 'each bone measures against its parent AFTER the parent was corrected');
  assert(/pose\.seedQ = pose\.seedPos = null/.test(code), 'letting go must forget the seed');
});

check('the bend limit is enforced in the simulation, not only on the way to the mesh', () => {
  // Bend, unlike twist, moves joints, so the physics can hold it. Leaving it to the rotation pass alone
  // would let the particles fold through the body while the drawn pose pretended otherwise.
  const start = code.match(/function startRagdoll\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(/maxBend: bendLimit\(\)/.test(start), 'the ragdoll must be built with the limit');
  assert(/setBend\(ragdoll\.sim, bendLimit\(\)\)/.test(code), 'the slider must be live, like stiffness');
});

check('the ragdoll reuses the tested solver rather than a second physics loop', () => {
  assert(/from '\.\/pokemon-hang\.js'/.test(code), 'the page should not carry its own Verlet loop');
  assert(!/prev\.[xyz]|integrate\(/.test(code), 'no integration in the page');
  assert(/stepHang\(/.test(code) && /boneRotations\(/.test(code), 'physics and the rotation fit both come from the module');
});

check('the ragdoll fit is measured from the seeded pose, not from the last frame', () => {
  // Frame-to-frame deltas applied on top of an already-rotated bone accumulate drift. The seed pose and the
  // seed world rotations are captured once and everything is measured against them.
  const step = code.match(/function stepRagdollFrame\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(step, 'no stepRagdollFrame');
  assert(/boneRotations\(current\.rig, ragdoll\.seed, now[,)]/.test(step), 'the fit must run seed to now');
  assert(/ragdoll\.seedQuat\[i\]/.test(step), 'and be applied to the seeded world rotation');
  assert(/for \(const i of ragdoll\.order\)/.test(step),
    'bones must be settled root-first, since rig.bones is ordered by glTF node index');
});

check('the root translates as well as turning, or a carried body cannot swing', () => {
  const step = code.match(/function stepRagdollFrame\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(/worldToLocal/.test(step) && /position\.copy/.test(step),
    'rotations alone cannot move the root, so a body held by its head would not swing its hips');
});

check('each of the three drives has a control and reaches the frame', () => {
  for (const id of ['driveClipBtn', 'drivePosedBtn', 'driveLimpBtn']) {
    assert(ids.has(id), `no ${id}`);
    assert(new RegExp(`\\$\\('${id}'\\)\\.addEventListener`).test(code), `${id} does nothing`);
  }
  assert(/setDriveFor\(CLIP\)/.test(code) && /setDriveFor\(POSED\)/.test(code) && /setDriveFor\(LIMP\)/.test(code),
    'the three buttons must set the three modes');
});

check('the frame applies the clip, then posed bones, then the limp ones', () => {
  // Order is the whole design: each step may only override what the one before had no business owning.
  const loop = code.match(/setAnimationLoop\([\s\S]*?\n\}\);/)?.[0] ?? '';
  assert(loop, 'no animation loop');
  const held = loop.indexOf('applyHeld()');
  const limp = loop.indexOf('stepLimpFrame(');
  const skel = loop.indexOf('updateSkeleton()');
  assert(held > -1 && limp > held, 'posed bones must be put back before the limp ones are simulated');
  assert(skel > limp, 'the overlay must be built after both, or it draws a frame behind');
  // Scrubbing writes a frame outside the loop, so the mask has to be honoured there too.
  const apply = code.match(/function applyFrame\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(/applyHeld\(\)/.test(apply), 'scrubbing would drop a posed bone back to the clip');
});

check('a posed bone is held by object, not looked up by name every frame', () => {
  const fn = code.match(/function applyHeld\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(fn, 'no applyHeld');
  assert(!/findIndex|find\(/.test(fn), 'this runs every frame; it must not search the skeleton');
});

check('the partial ragdoll pins what the animation drives, which is the inverse of hanging', () => {
  const step = code.match(/function stepLimpFrame\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(step, 'no stepLimpFrame');
  assert(/releaseAll\(limp\.sim\)/.test(step) && /pinBone\(limp\.sim/.test(step),
    'anchors must be re-pinned each frame, since the animation moves them');
  assert(/for \(const i of limp\.anchors\)/.test(step), 'the anchors come from the mask');
  assert(/for \(const i of limp\.order\)/.test(step),
    'only the limp bones take simulated rotations, and root-first among themselves');
  assert(/limp\.seedPos\[i\]/.test(step),
    'a limp bone must keep its own local position, or the clip keeps sliding it along its parent');
});

check('the mask is re-seeded when it changes, not left pointing at an old pose', () => {
  const fn = code.match(/function reseedRagdoll\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(fn, 'no reseedRagdoll');
  assert(/updateSkeleton\(\)/.test(fn) && /limp\.seed = /.test(fn), 'the seed must be taken from the live pose');
  assert(/reseedRagdoll\(\)/.test(code.match(/function setDriveFor\([\s\S]*?\n\}/)?.[0] ?? ''),
    'changing the mask must re-seed, or a newly limp bone snaps to where the species loaded');
});

check('the mask does not survive a change of species', () => {
  // No fallback to the whole file: a slice that missed would make this pass on the declarations instead.
  const sel = code.match(/async function selectSpecies\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(/skel\.selected = new Set\(\)/.test(sel), 'the selectSpecies slice is wrong, so this reads nothing');
  assert(/drive = \{\}/.test(sel), 'the drive mask must be cleared with the skeleton it names');
  assert(/held = new Map\(\)/.test(sel), 'and so must the held transforms');
  assert(/limp\.sim = null/.test(sel), 'and the simulation built on those bones');
});

check('a masked bone is visible as one without playing anything', () => {
  const paint = code.match(/function paintSkeleton\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(/JOINT_LIMP/.test(paint) && /JOINT_POSED/.test(paint),
    'a mask you cannot see is one you find out about by wondering why the body stopped moving');
});

check('the ragdoll, posing and playback are mutually exclusive', () => {
  const set = code.match(/function setRagdollMode\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(/play\.paused = true/.test(set) && /setPoseMode\(false\)/.test(set), 'the ragdoll must stop the other two');
  // Anchored on the whole function, not on a line inside it -- renaming that line silently emptied the
  // slice and the assertion below then passed on nothing.
  const transport = code.match(/function refreshTransport\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(/const live/.test(transport), 'the refreshTransport slice is empty, so this check reads nothing');
  assert(/!ragdoll\.sim/.test(transport), 'the transport must be off while the ragdoll runs');
  // The simulation being present IS the on state; a separate flag would be the same fact stored twice.
  assert(!/hang\.on\b/.test(code), 'ragdoll.sim is the state, so there must be no second flag');
});

check('letting go actually drops it', () => {
  // The window-level one, not the canvas listener the gizmo uses.
  const up = code.match(/\naddEventListener\('pointerup'[\s\S]*?\n\}\);/)?.[0] ?? '';
  assert(/releaseAll\(ragdoll\.sim\)/.test(up), 'the pin must be released on pointer up');
});

check('the skeleton follows playback rather than being placed once', () => {
  const loop = code.match(/renderer\.setAnimationLoop\([\s\S]*?\n\}\);/)?.[0] ?? '';
  assert(/updateSkeleton\(\)/.test(loop), 'the overlay must be re-placed every frame');
  const update = code.match(/function updateSkeleton\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(/getWorldPosition/.test(update), 'positions must come from the live bone matrices');
});

check('the frame loop allocates nothing and looks nothing up by name', () => {
  // Called every frame for up to 98 bones. A findIndex in here was O(n^2), and a clone per bone was
  // garbage per frame.
  const update = code.match(/function updateSkeleton\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(update, 'no updateSkeleton');
  assert(!/findIndex|\.find\(/.test(update), 'parent lookup must be precomputed, not searched');
  assert(!/new THREE\.|\.clone\(\)/.test(update), 'the frame loop must not allocate');
  assert(/parentOf/.test(update), 'parent indices should be built once a species');
});

check('bones are matched to objects by glTF node, not by name', () => {
  // Charmander, Charizard and Magmar each contain two bones sharing one name.
  const fn = code.match(/function boneObjects\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(fn, 'no boneObjects');
  assert(/associations/.test(fn), 'the node index is the only safe key');
  assert(!/\.name/.test(fn), 'a name lookup would attach the overlay to the wrong bone on three species');
});

console.log('\n--- how it reads ---');

const tips = [...markup.matchAll(/data-(tip|more)="([^"]*)"/g)].map(m => ({ kind: m[1], text: m[2].replace(/\s+/g, ' ').trim() }));

check('the UI text is in full sentences, not fragments', () => {
  // A full stop and a capital, not a word count: "Hide the skeleton." is a whole sentence and the right
  // length for a button. The fragments worth catching are "skeleton toggle" and "hides skeleton".
  assert(tips.length > 20, `only ${tips.length} tooltips, so this is passing on nothing`);
  for (const { text } of tips) {
    assert(/[.!?]$/.test(text), `hover text does not end in a full stop: "${text}"`);
    assert(/^[A-Z0-9]/.test(text), `hover text does not start as a sentence: "${text}"`);
    assert(/\s/.test(text), `hover text is a single word: "${text}"`);
  }
});

check('the panel is controls, not an essay', () => {
  // Explanation belongs on hover. Paragraphs in the panel are read once, in the way forever after, and
  // push the controls that matter off the bottom of the scroll.
  const paras = [...markup.matchAll(/<p class="hint">([\s\S]*?)<\/p>/g)];
  assert(paras.length === 0, `${paras.length} hint paragraphs are still in the panel`);
  for (const { kind, text } of tips) {
    const words = text.split(' ').length;
    const cap = kind === 'tip' ? 22 : 45;
    assert(words <= cap, `a data-${kind} runs to ${words} words, which belongs in the docs: "${text}"`);
  }
});

check('hover text is one mechanism, not two', () => {
  // A `title` alongside would give the same control two tooltips, on two different delays. Both halves
  // matter: nine of these were set from script and survived a check that only read the markup.
  const inMarkup = [...markup.matchAll(/<[^>]*\stitle="/g)];
  assert(inMarkup.length === 0, `${inMarkup.length} elements still use the browser's own title`);
  const inScript = [...code.matchAll(/\.title\s*=/g)];
  assert(inScript.length === 0, `${inScript.length} titles are still set from script`);
  assert(/data-more/.test(markup), 'nothing offers the longer text');
  assert(/Ctrl for more/.test(html), 'the longer text must be discoverable, or it does not exist');
});

check('the hover text a control gets from script is there before it is clicked', () => {
  // A label written only by its click handler explains nothing until you have already used it.
  assert(/setSnap\(play\.snap\)/.test(code), 'the scrub mode never initialises');
});

check('a toggle with two named states says which one it is in', () => {
  // "Snap" named neither state and lit up to mean one of them. The label is the state now, the way the
  // ghost buttons beside it already worked.
  const snap = code.match(/function setSnap\([\s\S]*?\n\}/)?.[0] ?? '';
  assert(/textContent = on \? 'Discrete' : 'Continuous'/.test(snap), 'the label must be the mode');
  assert(!/snapBtn'\)\.classList\.toggle\('on'/.test(snap), 'a lit state as well would be the same fact twice');
  assert(!/>Snap</.test(markup), 'the markup still hardcodes the old label');
});

check('the page says how to run it', () => {
  assert(/python serve\.py/.test(html), 'the header comment must say it needs a server');
});

console.log('\n' + results.join('\n'));
console.log(`\n${results.length - failures} of ${results.length} checks passed.\n`);
process.exit(failures ? 1 : 0);
