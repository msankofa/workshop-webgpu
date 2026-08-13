// bot-viewer-v2's control panel is built by ~2900 lines of hand-rolled DOM that can't run in Node
// (it imports three.js and needs a GPU). What CAN be checked without a browser is the section plan:
// the panel's information architecture is a single declarative table near the top of the panel
// bootstrap, and every card's contents are routed to it by name.
//
// So this parses that table out of the HTML and asserts it still matches the approved structure in
// docs/superpowers/reviews/2026-08-06-ui-refactor/proposed-structure.md, plus the two invariants
// that make the routing safe: every planned card is filled by something, and every header() call
// names a card that exists.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'bot-viewer-v3.html'), 'utf8');

let failures = 0;
function check(label, condition, detail) {
  if (condition) { console.log(`  ok   ${label}`); return; }
  failures++;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
}
function equal(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  check(label, a === e, a === e ? '' : `expected ${e}\n       actual   ${a}`);
}

// ── parse the plan ────────────────────────────────────────────────────────────
const planStart = src.indexOf('const SECTION_PLAN');
const planEnd = src.indexOf('const worldPresetRow');
check('SECTION_PLAN is present', planStart !== -1 && planEnd > planStart);
const planBlock = src.slice(planStart, planEnd);

const plan = [...planBlock.matchAll(/\['([a-z]+)', '([^']+)', (?:'([^']+)'|null), (true|false)\]/g)]
  .map(m => ({ tab: m[1], title: m[2], cluster: m[3] || null, collapsed: m[4] === 'true' }));

check('plan parsed', plan.length > 0, `parsed ${plan.length} rows`);

// ── the approved structure ────────────────────────────────────────────────────
const APPROVED = {
  session: ['Save / load', 'Framing & follow', 'POV & fly'],
  bots: [
    'Spawn', 'Composition', 'Squads', 'Deployment', 'Auto-add & corpses',
    'Weapons & ammo', 'Body & ragdoll', 'Explosives', 'Drones',
    'Movement tuning', 'Stance', 'Perception & pursuit', 'Aim & reaction', 'Aim coherence',
    'Scoreboard', 'Dummies (WASD moves first)',
  ],
  world: [
    'Map layout', 'Scene shuffle',
    'Terrain', 'Landform', 'Erosion', 'Landmarks', 'Terrain shading',
    'Roads',
  ],
  debug: ['Perf / LOD', 'Debug overlays', 'State recorder'],
  visuals: ['Look & post', 'Visual toggles', 'Bot lighting', 'Sky detail', 'Flora'],
  audio: ['Mixer & voices', 'Music player', 'Reactive lighting', 'Music FX'],
};

console.log('\ntab order and contents');
const tabOrder = [...new Set(plan.map(r => r.tab))];
equal('tabs appear in the approved order', tabOrder, Object.keys(APPROVED));
for (const [tab, titles] of Object.entries(APPROVED)) {
  equal(`${tab}: cards in order`, plan.filter(r => r.tab === tab).map(r => r.title), titles);
}

console.log('\nclusters');
equal('cluster captions in plan order', plan.filter(r => r.cluster).map(r => r.cluster), [
  'Save state', 'Camera',
  'Roster & spawn', 'Loadout', 'AI tuning', 'Results & test aids',
  'Layout & structure', 'Terrain generation',
  'Performance', 'Overlays', 'Capture',
]);

console.log('\ndefaults');
const open = plan.filter(r => !r.collapsed).map(r => r.title);
equal('only Spawn is expanded on load', open, ['Spawn']);
check('the bot readout is pinned, not tabbed',
  /sectionBodies\.set\('Bot readout', createSection\(chromeReadoutHost/.test(src));
check('the pinned bot readout starts collapsed',
  /createSection\(chromeReadoutHost, 'Bot readout', \{ collapsed: true \}\)/.test(src));
check('bots is the tab active on load', /let activeTabId = 'bots'/.test(src));

console.log('\nrouting invariants');
// Everything after the plan is control-building code; a planned card must be named there at least
// once, or it renders as an empty card.
const body = src.slice(planEnd);
const unfilled = plan.map(r => r.title).filter(t => !body.includes(`'${t}'`));
equal('every planned card is filled by something', unfilled, []);

// header() throws at runtime on an unplanned name; catch it here instead.
const planned = new Set([...plan.map(r => r.title), 'Bot readout']);
// (?<!sub) or subheader('Recoil') reads as a header() call naming an unplanned card.
const headerCalls = [...body.matchAll(/(?<!sub)header\('([^']+)'\)/g)].map(m => m[1]);
equal('every header() names a planned card', headerCalls.filter(t => !planned.has(t)), []);
check('header() guards against an unplanned name',
  /throw new Error\(`header\(\): no section planned/.test(src));

console.log('\nsub-groups inside cards');
// Three cards were too long to read as one list, so they nest groups. Section collapse state is keyed
// by heading text panel-wide, so a sub-group sharing a card's title would stomp it on save/restore.
// Two forms: a literal subheader('X'), and a group table whose rows are ['X', [ ...specs ]].
const subTitles = [
  ...body.matchAll(/^\s*\['([^']+)', \[\s*$/gm),
  ...body.matchAll(/subheader\('([^']+)'\)/g),
].map(m => m[1]);
equal('the sub-groups we expect exist', subTitles, [
  'Crouch', 'Kneel', 'Prone', 'Choosing and leaving a stance',
  'Reaction timing', 'Weapon spread', 'Recoil',
  'Torso', 'Head', 'Barrel trim', 'Lead & recoil',
  'Per species', 'Vines',
  'Throw decisions', 'Blast physics',
  'Bomb drone', 'Loitering munition', 'Both drones',
]);
equal('no sub-group title collides with a card title',
  subTitles.filter(t => planned.has(t)), []);
equal('no sub-group title is used twice', subTitles.filter((t, i) => subTitles.indexOf(t) !== i), []);
check('subheader nests into the card, not into the previous sub-group',
  /function subheader\(title\) \{ ctrl = createSection\(ctrlCard,/.test(src)
  && /ctrl = ctrlCard = body;/.test(src));

console.log('\nmoved controls');
// The three consolidations the refactor exists for. If any of these regress, the panel is back to
// scattering diagnostics across four places.
const parked = /perfLodControls\.push\(([^)]*)\)/.exec(src)?.[1] || '';
for (const id of ['thinkStaggerBtn', 'rigLodBtn', 'flushLodBtn', 'botCullBtn', 'botHideBtn', 'rboxLodBtn']) {
  check(`${id} is routed to Perf / LOD`, parked.includes(id));
}
const overlayParked = [...src.matchAll(/debugOverlayExtras\.push\(([^)]*)\)/g)].map(m => m[1]).join(',');
for (const id of ['povDebugScreenBtn', 'povDebugWorldBtn', 'squadDebugBtn']) {
  check(`${id} is routed to Debug overlays`, overlayParked.includes(id));
}
check('the nav overlay button folds into Debug overlays',
  /sectionBodies\.get\('Debug overlays'\)\.appendChild\(navToggleBtn\)/.test(src));
check('the three scenario presets sit in the World strip',
  /worldPresetRow\.append\(openFieldBtn, testConditionBtn\)/.test(src)
  && /worldPresetRow\.append\(highlandsBtn\)/.test(src));

console.log('\nchrome');
check('expand/collapse-all scope to the active tab',
  /function activeSectionHosts\(\)/.test(src) && /setAllSectionsCollapsed\(host, false\)/.test(src));
check('the ui slot captures tab, pins and density',
  /activeTab: activeTabId, pinned: \[\.\.\.pinnedTitles\], compact:/.test(src));
check('section state is read from ctrlRoot so the pinned readout is included',
  /readSectionStates\(ctrlRoot\)/.test(src) && /applySectionStates\(ctrlRoot,/.test(src));
check('a slot saved before pins existed does not wipe them',
  /if \(Array\.isArray\(panel\.pinned\)\) setPinnedTitles/.test(src));

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
