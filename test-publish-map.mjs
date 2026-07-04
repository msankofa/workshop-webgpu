import { validateSegment, validateSecret, mergeMapConfig } from './server/publish-map.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

// --- validateSegment ---
ok(validateSegment('workshop') === true, '1: accepts plain word');
ok(validateSegment('cave world 2') === true, '1: accepts spaces');
ok(validateSegment('a_b-c') === true, '1: accepts underscore/hyphen');
ok(validateSegment('') === false, '1: rejects empty string');
ok(validateSegment('   ') === false, '1: rejects whitespace-only');
ok(validateSegment('../etc') === false, '1: rejects path traversal');
ok(validateSegment('a/b') === false, '1: rejects slash');
ok(validateSegment(undefined) === false, '1: rejects non-string');

// --- validateSecret ---
ok(validateSecret('right', 'right') === true, '2: exact match passes');
ok(validateSecret('wrong', 'right') === false, '2: mismatch fails');
ok(validateSecret('rig', 'right') === false, '2: length mismatch fails, does not throw');
ok(validateSecret('', 'right') === false, '2: empty provided fails');
ok(validateSecret('right', '') === false, '2: empty expected fails (never auto-passes when unset)');
ok(validateSecret(undefined, 'right') === false, '2: undefined provided fails, does not throw');

// --- mergeMapConfig ---
const fresh = mergeMapConfig('{}', 'workshop/new-map.glb', 'new_map');
ok(fresh.maps['workshop/new-map.glb'].displayName === 'New Map', '3: title-cases name into displayName');
ok(fresh.maps['workshop/new-map.glb'].gameName === 'New Map', '3: gameName matches displayName');
ok(fresh.maps['workshop/new-map.glb'].playable === true, '3: playable defaults true');
ok(fresh.maps['workshop/new-map.glb'].mapScale === 1 && fresh.maps['workshop/new-map.glb'].snapStep === 0.5, '3: default scale/snapStep');

const existingText = JSON.stringify({ maps: { 'workshop/old.glb': { displayName: 'Custom Name', gameName: 'Custom Name', image: 'x.png', playable: false, mapScale: 2, snapStep: 1 } } });
const untouched = mergeMapConfig(existingText, 'workshop/old.glb', 'old');
ok(untouched.maps['workshop/old.glb'].displayName === 'Custom Name', '4: existing key left untouched');
ok(untouched.maps['workshop/old.glb'].image === 'x.png', '4: existing custom fields preserved');

const added = mergeMapConfig(existingText, 'workshop/new2.glb', 'new2');
ok(Object.keys(added.maps).length === 2, '4: adds new key alongside existing one');

const brokenJson = mergeMapConfig('not json', 'workshop/a.glb', 'a');
ok(brokenJson.maps['workshop/a.glb'].playable === true, '5: unparsable input treated as {}');

const nullMaps = mergeMapConfig(JSON.stringify({ maps: null }), 'workshop/b.glb', 'b');
ok(nullMaps.maps['workshop/b.glb'].playable === true, '5: null maps field treated as {}');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
