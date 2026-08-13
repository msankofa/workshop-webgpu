// Node checks for structure-viewer.html. Two halves:
//   1. a source scan for the wiring traps that fail SILENTLY in a browser -- a second lighting
//      panel, a stale wallHeight, bounds that never move, saved slots that overwrite v3's;
//   2. real assertions against bot-structures.js for the sizing rule the gallery depends on.
// Run: node test-structure-viewer.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateOne, generateStructures, STRUCTURE_DEFAULTS } from './bot-structures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'structure-viewer.html'), 'utf8');

let failed = 0;
const ok = (cond, msg, detail) => {
  if (cond) { console.log(`  ok   ${msg}`); return; }
  failed++;
  console.log(`  FAIL ${msg}${detail ? `\n       ${detail}` : ''}`);
};

console.log('\nwiring traps');

// createLightingRig defaults ui:true, which builds a second lighting panel that fights the theme
// system for the same rig.
ok(/createLightingRig\(\{[^}]*ui:\s*false/.test(src), 'the lighting rig is created with ui:false');

// lights.js recomputes the light from its own internal state, so a post-hoc setter silently
// discards whatever the theme just applied.
ok(!/rig\.set(Azimuth|Elevation)\s*\(/.test(src),
  'light direction is driven only through the theme, never rig.setAzimuth/setElevation');

// A lintel fills from its head to the wall top, so a stale wallHeight leaves a floating bar or a
// gap over every door -- and it looks like a generator bug, not a wiring one.
const genCalls = [...src.matchAll(/generate(Structures|One)\(([\s\S]{0,160}?)\)/g)];
ok(genCalls.length >= 2, `both generator entry points are called (${genCalls.length} call sites)`);
ok(genCalls.every(m => /wallHeight:\s*WALL_H/.test(m[2])),
  'every generator call threads the live WALL_H',
  genCalls.filter(m => !/wallHeight:\s*WALL_H/.test(m[2])).map(m => m[0].slice(0, 60)).join('\n       '));
ok(genCalls.every(m => /wallT:\s*WALL_T/.test(m[2])), 'every generator call threads the live WALL_T');

// Without this the floor grid, scan ring, accent lights and shadow box stay aimed at the old map.
const rebuildBody = src.slice(src.indexOf('function rebuildScene'), src.indexOf('function frameCamera'));
ok(rebuildBody.length > 200, 'rebuildScene located');
ok(/visuals\.setBounds\(activeBounds\)/.test(rebuildBody), 'every rebuild re-aims the visuals at the new bounds');
ok(/clearBoxes\(mapRoot\)/.test(rebuildBody), 'teardown goes through clearBoxes, which skips the shared UNIT_BOX');
ok(!/UNIT_BOX/.test(src), 'the viewer never touches UNIT_BOX itself');

// Generation must precede the terrain bake, or buildings sit off the pads levelled for them.
ok(rebuildBody.indexOf('generateStructures') < rebuildBody.indexOf('rebuildTerrainField()'),
  'structures are generated before the terrain field is baked from their pads');
ok(rebuildBody.indexOf('rebuildTerrainField()') < rebuildBody.indexOf('buildFloorMesh()'),
  'the floor mesh is built from the post-pad field');

// bot-viewer-slots.js hardcodes its storage prefix and namespaces only by group, so a shared name
// would overwrite bot-viewer-v3's own saved slots.
const group = /createSlotSection\(\{\s*group:\s*'([^']+)'/.exec(src);
ok(group, 'presets use createSlotSection');
ok(group && !['maze', 'bots', 'ui'].includes(group[1]),
  `the preset slot group is distinct from bot-viewer-v3's (got '${group && group[1]}')`);

// A bot-less viewer showing bot glow, muzzle-flash and flashlight sliders is dead weight.
ok(/'Bot lighting'/.test(src) && /nodes\.slice\(0, from\)/.test(src),
  "buildPanel's Bot lighting block is dropped host-side");

// The theme styles #ctrl as a non-scrolling flex column; .panel-body is the scroll region.
ok(/className: 'panel-body'/.test(src) && /createSection\(panelBody/.test(src),
  'sections are appended to .panel-body, so a long panel scrolls');

// Flora owns geometry the look system does not, so a theme switch has to reach it.
ok(/onLookChange:\s*\(\)\s*=>\s*rebuildFlora\(\)/.test(src), 'a theme switch rebuilds flora');
ok(/parent:\s*scene/.test(src), 'flora parents to the scene, not to mapRoot (whose teardown disposes geometry)');

console.log('\ngallery sizing');

// The gallery does not reject-sample: a specimen wider than its cell reaches into its neighbour.
// So the floor on slot size has to clear the largest structure the defaults can produce.
const SLOT_MIN = Number(/const SLOT_MIN = (\d+)/.exec(src)?.[1]);
ok(Number.isFinite(SLOT_MIN), `SLOT_MIN is declared (${SLOT_MIN})`);

// Every kind the module exposes, so a kind added to bot-structures.js without a viewer entry fails
// here rather than silently missing from the gallery.
const KINDS = ['building', 'pocket', 'obstacles', 'portal', 'colonnade', 'slot', 'rampart', 'corner', 'terrace'];
const viewerKinds = /const KINDS = \[([^\]]+)\]/.exec(src)?.[1] || '';
ok(KINDS.every(k => viewerKinds.includes(`'${k}'`)),
  'the viewer offers every kind the generator can build',
  KINDS.filter(k => !viewerKinds.includes(`'${k}'`)).join(', '));
// The mix keys are not a predictable pluralisation ('obstacles' is already plural), so resolve them
// through the generator rather than guessing: run each option the dropdown offers and see what it
// actually places. Every kind must be reachable on its own.
const mixOptions = [...(/dropdown\(b, 'mix', \[([^\]]+)\]/.exec(src)?.[1] || '').matchAll(/'([^']+)'/g)].map(m => m[1]);
ok(mixOptions.length > 1, `the mix dropdown was found (${mixOptions.length} options)`);
const bounds = { minX: -80, maxX: 80, minZ: -80, maxZ: 80 };
const soloable = new Set();
for (const mix of mixOptions) {
  if (mix === 'mixed') continue;
  const out = generateStructures(bounds, { seed: 4, count: 6, mix, wallHeight: 3 }, []);
  const kinds = new Set(out.placed.map(s => s.kind));
  ok(kinds.size === 1, `mix '${mix}' resolves to exactly one kind (got ${[...kinds].join(', ') || 'nothing'})`);
  for (const k of kinds) soloable.add(k);
}
ok(KINDS.every(k => soloable.has(k)), 'every kind is reachable through some mix option',
  KINDS.filter(k => !soloable.has(k)).join(', '));

let worst = { kind: null, radius: 0, seed: 0 };
for (const kind of KINDS) {
  for (let seed = 1; seed <= 200; seed++) {
    const r = generateOne(kind, { ...STRUCTURE_DEFAULTS, wallHeight: 3 }, seed).radius;
    if (r > worst.radius) worst = { kind, radius: r, seed };
  }
}
console.log(`  widest specimen over 200 seeds x 4 kinds: ${worst.kind} at ${worst.radius.toFixed(2)} m radius (seed ${worst.seed})`);
ok(worst.radius * 2 <= SLOT_MIN,
  `the smallest allowed slot holds the widest default specimen (${(worst.radius * 2).toFixed(1)} m across vs ${SLOT_MIN} m cell)`);

// And the readout that covers the case the floor cannot: raising buildingMax past the cell.
const big = generateOne('building', { ...STRUCTURE_DEFAULTS, buildingMin: 26, buildingMax: 30, wallHeight: 3 }, 1);
ok(big.radius * 2 > SLOT_MIN, 'a raised buildingMax can still outgrow the smallest cell');
ok(/outgrew the cell/.test(src), 'the HUD warns when a slot outgrows its cell rather than leaving it to look like a bug');

// Slot seeds must be independent, or rerolling one specimen reshuffles its neighbours.
const seedExpr = /const seed = \(view\.gallerySeed \+ i \* (\d+) \+ \(slotSeedOffsets\[i\] \|\| 0\) \* (\d+)\)/.exec(src);
ok(seedExpr, 'each slot derives its own seed from (base, index, its own reroll counter)');
if (seedExpr) {
  const [, stride, bump] = seedExpr.map(Number);
  // A reroll must not land on another slot's seed for any plausible slot count.
  let collision = null;
  for (let i = 0; i < 16 && !collision; i++) {
    for (let n = 1; n <= 32 && !collision; n++) {
      const rerolled = (i * stride + n * bump) >>> 0;
      for (let j = 0; j < 16; j++) if (j !== i && ((j * stride) >>> 0) === rerolled) collision = { i, n, j };
    }
  }
  ok(!collision, 'rerolling a slot never lands on a neighbour\'s seed',
    collision && `slot ${collision.i} reroll ${collision.n} collides with slot ${collision.j}`);
}

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
