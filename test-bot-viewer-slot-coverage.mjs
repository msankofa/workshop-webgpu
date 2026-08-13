// The save/load slots enumerate their fields by hand, so a control added to the panel without a
// matching capture line works fine and silently isn't saved. That is how the whole Perf / LOD card
// came to be unsaved (2026-08-06) -- its toggles started life as ?riglod=0 URL flags, so nobody
// thought of them as slot fields.
//
// This finds persistent state the panel reassigns, and fails if none of the three capture functions
// mentions it. Anything genuinely transient goes in TRANSIENT below, with the reason.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const VIEWER = 'bot-viewer-v3.html';   // v2 is a frozen snapshot; v3 is the live harness
const src = fs.readFileSync(path.join(here, VIEWER), 'utf8');
const lines = src.split('\n');

// Panel region: the bootstrap through to the save/load block that closes it.
const PANEL_START = lines.findIndex(l => l.includes('const SECTION_PLAN'));
const PANEL_END = lines.findIndex(l => l.includes('function captureMazeState'));
const captureText = src.slice(src.indexOf('function captureMazeState'), src.indexOf('const mazeSlots ='));

// State that must NOT be restored, and why. Restoring any of these would be a bug, not a fix.
const TRANSIENT = {
  botDebugFocusActor: 'a live actor reference, not serializable',
  botLiveEnabled: 'opens a websocket; restoring would auto-connect and force recording on',
  botReloadUntil: 'runtime reload timer',
  botReloadWeaponId: 'runtime reload timer',
  botStateRecordAllBots: 'belongs to a recording take, not to settings',
  botStateRecordLog: 'the textarea the recorder writes into',
  botStateRecordRenderedCount: 'repaint bookkeeping',
  pinDrawer: 'the jump-drawer element; the panel clears it to repaint. The pins themselves are saved as panel.pinned',
  searchInput: 'the search box; the panel only ever clears it. A restored query would hide most of the panel on load',
  spawnToolButtonsReady: 'one-shot guard: the map builds before the panel, so refreshes before this flips are no-ops',
  syncFloraPanel: 'a syncer function, not a setting -- it is installed once when the Flora card is built. '
    + 'The flora values it pushes live on visuals.theme.flora, which the ui slot already captures via visuals.getLookState()',
  syncFloraCounts: 'same: a readout refresher installed with the Flora card. It reports measured blade/plant '
    + 'counts, which are derived from the map and the flora settings, so there is nothing of its own to save',
};

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures++;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
};

check('panel region located', PANEL_START > 0 && PANEL_END > PANEL_START);

// Persistent state = any top-level `let`/`var`/`const` declared outside the panel. `const` used to
// mean only `const x = {`, which is why `const camera = new THREE.PerspectiveCamera(...)` was
// invisible and camera.far went unsaved until 2026-08-08: a const binding still holds mutable state.
const declLine = new Map();
for (let i = 0; i < lines.length; i++) {
  const m = /^(?:const|let|var) ([A-Za-z_$][\w$]*)/.exec(lines[i]);
  if (m && !declLine.has(m[1])) declLine.set(m[1], i + 1);
}

const written = new Map();
for (let i = PANEL_START; i < PANEL_END; i++) {
  if (/^\s*(?:const|let|var) /.test(lines[i])) continue;   // a declaration, not a reassignment
  // `x[key] =` counts too: povEyeOffset is only ever written through a computed key, so the
  // dot-only form saw no writes at all and the POV eye offsets went unsaved with it.
  for (const m of lines[i].matchAll(/\b([A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])?\s*(?:=(?![=>])|\+=|-=)/g)) {
    const name = m[1];
    const decl = declLine.get(name);
    if (!decl || (decl > PANEL_START && decl <= PANEL_END)) continue;   // undeclared, or a panel local
    if (!written.has(name)) written.set(name, i + 1);
  }
}

console.log('\nslot coverage');
check('the panel writes state we can see', written.size > 50, `found ${written.size}`);

const uncovered = [...written]
  .filter(([name]) => !captureText.includes(name) && !TRANSIENT[name])
  .map(([name, at]) => `${name} (${VIEWER}:${at})`);
check('every setting the panel writes is captured by a slot', uncovered.length === 0,
  uncovered.length ? `not captured:\n       ${uncovered.join('\n       ')}`
    + '\n       Add it to captureUiState/captureBotState/captureMazeState, or to TRANSIENT with a reason.' : '');

// The check above matches on the object name, so as soon as ONE field of an object is captured every
// other field of it passes silently. `camera.far` hid behind `camera.fov` for exactly that reason.
const propWrites = new Map();
for (let i = PANEL_START; i < PANEL_END; i++) {
  if (/^\s*(?:const|let|var) /.test(lines[i])) continue;
  for (const m of lines[i].matchAll(/\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*(?:=(?![=>])|\+=|-=)/g)) {
    const decl = declLine.get(m[1]);
    if (!decl || (decl > PANEL_START && decl <= PANEL_END) || TRANSIENT[m[1]]) continue;
    const path = `${m[1]}.${m[2]}`;
    if (!propWrites.has(path)) propWrites.set(path, i + 1);
  }
}
const uncoveredProps = [...propWrites].filter(([path]) => {
  const [obj, prop] = path.split('.');
  return !captureText.includes(`...${obj}`)              // whole object spread into the slot
    && !captureText.includes(path)                       // captured by its full path
    && !new RegExp(`\\b${prop}\\b`).test(captureText);   // captured under its own name
}).map(([path, at]) => `${path} (${VIEWER}:${at})`);
check('every property of a shared object the panel writes is captured', uncoveredProps.length === 0,
  uncoveredProps.length ? `not captured:\n       ${uncoveredProps.join('\n       ')}` : '');

// Stale allowlist entries hide nothing, but they do rot. Flag any the panel no longer writes.
const stale = Object.keys(TRANSIENT).filter(name => !written.has(name));
check('no stale TRANSIENT entries', stale.length === 0, stale.join(', '));

// The blind spot this test had until 2026-08-07: a control can change a setting WITHOUT assigning
// to anything here, by calling a setter imported from another module — the state lives over there.
// Body kind was exactly that (`setBotBodyKind` in bot-body-design.js) and the scan above could
// never have seen it, because there is no assignment in this file to find.
console.log('\nimported setters');
const imported = new Map();
for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'([^']+)'/g)) {
  for (let n of m[1].split(',')) {
    n = n.trim().split(/\s+as\s+/).pop().trim();
    if (n) imported.set(n, m[2]);
  }
}
// Imported calls that perform an action rather than set a persistent value.
const ACTIONS = {
  resetScoreboard: 'clears the running tally; restoring a score on load would be wrong',
};
const panelSrc = lines.slice(PANEL_START, PANEL_END).join('\n');
const unsavedSetters = [];
for (const [name, mod] of imported) {
  if (!/^set[A-Z]/.test(name) || ACTIONS[name]) continue;
  if (!new RegExp(`\\b${name}\\s*\\(`).test(panelSrc)) continue;   // not driven by the panel
  const getter = name.replace(/^set/, 'get');
  if (!captureText.includes(getter) && !captureText.includes(name)) unsavedSetters.push(`${name} (${mod})`);
}
check('every imported setter the panel drives has its state captured', unsavedSetters.length === 0,
  unsavedSetters.length ? `no getter reaches a capture function for:\n       ${unsavedSetters.join('\n       ')}`
    + '\n       Capture it via its getter, or add it to ACTIONS with a reason.' : '');
check('body kind specifically round-trips',
  /bodyKind: getBotBodyKind\(\)/.test(src) && /setBotBodyKind\(data\.bodyKind\)/.test(src));
check('restoring body kind rebuilds the rigs',
  /setBotBodyKind\(data\.bodyKind\) && botProceduralBodyEnabled\) rebuildBotProceduralBodies\(\)/.test(src));

console.log('\ncapture / apply symmetry');
function fnBody(name) {
  const at = src.indexOf(`function ${name}(`);
  return at === -1 ? '' : src.slice(at, src.indexOf('\n}', at));
}
for (const [cap, app] of [
  ['captureMazeState', 'applyMazeState'],
  ['captureBotState', 'applyBotState'],
  ['captureUiState', 'applyUiState'],
]) {
  const capBody = fnBody(cap), appBody = fnBody(app);
  const keys = new Set();
  for (const m of capBody.matchAll(/[{,]\s*([a-zA-Z_$][\w$]*):/g)) keys.add(m[1]);
  for (const m of capBody.matchAll(/(?:^\s*|,\s*)([a-zA-Z_$][\w$]*)\s*(?=,|\n\s*\})/gm)) keys.add(m[1]);
  const unread = [...keys].filter(k => !new RegExp(`\\b${k}\\b`).test(appBody));
  check(`${cap}: every captured key is read back by ${app}`, unread.length === 0, unread.join(', '));
}

console.log('\nthe 2026-08-06 fix specifically');
for (const [label, re] of [
  ['perf/LOD toggles are captured', /perf: \{[\s\S]*?thinkStagger:[\s\S]*?rboxLodDistance:/],
  ['perf/LOD toggles are applied', /const perf = data\.perf \|\| \{\};/],
  ['armour LOD restores its cycle step', /rboxLodStep = BOT_RBOX_LOD === 2/],
  ['the hit-volume overlay is captured', /hitVolume: botHitVolumeDebugEnabled/],
  ['the trace tick is captured', /traceTickMs: botStateTraceTickMs/],
]) check(label, re.test(src));

console.log('\nthe 2026-08-08 camera fix specifically');
for (const [label, re] of [
  ['view distance is captured', /viewDistance: camera\.far/],
  ['POV eye offsets are captured', /povEye: \{ \.\.\.povEyeOffset \}/],
  // A bare camera.far assignment would clip correctly but leave the sky dome and grass behind.
  ['view distance restores through the slider syncer', /viewDistInput\.value = String\(clampOr\(cam\.viewDistance[\s\S]{0,60}syncViewDist\(\)/],
  ['POV eye offsets are clamped on restore', /povEyeOffset\.y = clampOr\(povEye\.y[\s\S]*?povEyeOffset\.z = clampOr\(povEye\.z/],
  ['restoring the camera moves its sliders', /for \(const sync of cameraSyncers\) sync\(\)/],
]) check(label, re.test(src));

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
