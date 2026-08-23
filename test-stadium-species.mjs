// Node checks for the shared species load path. Run with `node test-stadium-species.mjs`.
//
// What matters here is that every reader gets the SAME creature: the stance applied, the posed file
// mapped, roles pinned over the detection, and a leg lost to a pose reported rather than swallowed.

import fs from 'node:fs';
import { parseGLB } from './stadium-glb.js';
import { mapStadiumRig } from './stadium-rig-map.js';
import {
  STANCE_PATH, loadStanceLibrary, nodeReader, fetchReader, pinDetectedLegs, mapSpecies, mapSpeciesFromLibrary,
} from './stadium-species.js';
import { emptyStance, setStanceBone, setStanceRoles, restTRS, putStance, emptyLibrary, stanceStamp } from './stadium-stance.js';
import { rolesFromMap } from './stadium-rig-roles.js';
import { STADIUM_REFERENCE_SPECIES } from './stadium-reference-species.js';

let failures = 0;
const results = [];
function check(name, fn) {
  try { fn(); results.push(`  ok   ${name}`); }
  catch (e) { failures++; results.push(`  FAIL ${name}\n       ${e.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); results.push(`  ok   ${name}`); }
  catch (e) { failures++; results.push(`  FAIL ${name}\n       ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const load = (s) => parseGLB(fs.readFileSync(`models/stadium/${s}.glb`));
function axisAngle([x, y, z], angle) {
  const n = Math.hypot(x, y, z) || 1, h = angle / 2, s = Math.sin(h) / n;
  return [x * s, y * s, z * s, Math.cos(h)];
}
function composeQ(a, b) {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
/** A stance that turns every leg's top bone, which is the edit that stands a sitting model up. */
function hipTurn(json, map, species, angle = 0.2) {
  let stance = emptyStance(species);
  for (const leg of map.legs) {
    const name = map.names[leg.bones[0]];
    const rest = restTRS(json, name);
    stance = setStanceBone(stance, name, { ...rest, q: composeQ(axisAngle([1, 0, 0], angle), rest.q) });
  }
  return stance;
}

console.log('\n--- reading the library ---');

await checkAsync('a missing file is an empty library, not a failure', async () => {
  const lib = await loadStanceLibrary(() => null);
  assert(lib && lib.stances && !Object.keys(lib.stances).length, 'expected an empty library');
});

await checkAsync('a reader that throws still yields an empty library', async () => {
  const lib = await loadStanceLibrary(() => { throw new Error('offline'); });
  assert(lib && !Object.keys(lib.stances).length, 'expected an empty library');
});

await checkAsync('malformed JSON does not take the page down with it', async () => {
  const lib = await loadStanceLibrary(() => '{ this is not json');
  assert(lib && !Object.keys(lib.stances).length, 'expected an empty library');
});

await checkAsync('a document without a stances map is rejected as the wrong file', async () => {
  const lib = await loadStanceLibrary(() => '{"setpoints":{}}');
  assert(!Object.keys(lib.stances).length, 'a tuning file should not read as a stance library');
});

await checkAsync('a real library round-trips', async () => {
  const { json } = load('019_rattata');
  const name = json.nodes[1].name;
  const stance = setStanceBone(emptyStance('019_rattata'), name, restTRS(json, name));
  const text = JSON.stringify(putStance(emptyLibrary(), stance));
  const lib = await loadStanceLibrary(() => text);
  assert(lib.stances['019_rattata'], 'the species did not survive the round trip');
});

await checkAsync('the Node reader returns null for a file that is not there', async () => {
  const read = nodeReader(fs);
  assert(read('stadium-saves/definitely-not-here.json') === null, 'expected null');
  assert(typeof read('stadium-species.js') === 'string', 'expected the file text');
});

await checkAsync('the fetch reader treats a 404 as no stances yet', async () => {
  const read = fetchReader(async () => ({ ok: false, text: async () => 'nope' }));
  assert(await read(STANCE_PATH) === null, 'a 404 should read as null');
  const ok = fetchReader(async () => ({ ok: true, text: async () => '{"stances":{}}' }));
  assert(typeof await ok(STANCE_PATH) === 'string', 'a 200 should read as text');
});

console.log('\n--- mapping through the stance ---');

check('with no stance, mapSpecies matches a plain mapStadiumRig', () => {
  const { json, bin } = load('019_rattata');
  const plain = mapStadiumRig(json, bin);
  const out = mapSpecies(json, bin, { species: '019_rattata' });
  assert(out.json === json, 'an unstanced species should not be re-documented');
  assert(out.map.legs.length === plain.legs.length, 'leg count differs');
  assert(Math.abs(out.map.rideHeight - plain.rideHeight) < 1e-9, 'ride height differs');
  assert(out.stamp === 'rest', `expected the rest stamp, got ${out.stamp}`);
});

check('the returned document is the POSED one, so meshes and the map agree', () => {
  const { json, bin } = load('058_growlithe');
  const base = mapStadiumRig(json, bin);
  const stance = hipTurn(json, base, '058_growlithe', 0.3);
  const out = mapSpecies(json, bin, { stance, species: '058_growlithe' });
  assert(out.json !== json, 'expected a posed document');
  const name = base.names[base.legs[0].bones[0]];
  const posedNode = out.json.nodes.find(n => n.name === name);
  assert(posedNode.rotation.join() === stance.bones[name].q.join(), 'the posed document does not carry the stance');
  assert(out.stamp === stanceStamp(stance), 'the stamp does not match the stance');
});

check('a leg lost to the pose is reported rather than swallowed', () => {
  const { json, bin } = load('077_ponyta');
  const base = mapStadiumRig(json, bin);
  const out = mapSpecies(json, bin, { stance: hipTurn(json, base, '077_ponyta'), species: '077_ponyta' });
  assert(out.map.legs.length < base.legs.length, 'expected Ponyta to lose legs to this pose');
  assert(out.warnings.some(w => /leg count/.test(w)), `no warning about the leg count: ${JSON.stringify(out.warnings)}`);
  assert(out.warnings.some(w => /pin the detected legs/.test(w)), 'the warning should say what to do about it');
});

check('pinning the detected legs first keeps them through the pose', () => {
  const { json, bin } = load('077_ponyta');
  const base = mapStadiumRig(json, bin);
  const roles = pinDetectedLegs(json, base, '077_ponyta');
  const out = mapSpecies(json, bin, { stance: hipTurn(json, base, '077_ponyta'), roles, species: '077_ponyta' });
  assert(out.map.legs.length === base.legs.length,
    `pinned roles lost legs: ${base.legs.length} → ${out.map.legs.length}`);
  assert(!out.warnings.some(w => /leg count/.test(w)), 'nothing should have been lost');
});

check('a species whose detection will not pin says so', () => {
  const { json, bin } = load('028_sandslash');
  const base = mapStadiumRig(json, bin);
  const roles = pinDetectedLegs(json, base, '028_sandslash');
  assert(roles.warnings?.length, 'Sandslash should not pin cleanly — its four legs are two limbs');
  const out = mapSpecies(json, bin, { roles, species: '028_sandslash' });
  assert(out.warnings.some(w => /two-bone leg/.test(w)), `the compile warning should reach the caller: ${JSON.stringify(out.warnings)}`);
});

check('mapSpeciesFromLibrary looks the stance up by name', () => {
  const { json, bin } = load('058_growlithe');
  const base = mapStadiumRig(json, bin);
  const lib = putStance(emptyLibrary(), hipTurn(json, base, '058_growlithe', 0.3));
  const posed = mapSpeciesFromLibrary(json, bin, '058_growlithe', lib);
  const other = mapSpeciesFromLibrary(json, bin, '019_rattata', lib);
  assert(posed.stamp !== 'rest', 'the stance was not found');
  assert(other.stamp === 'rest', 'a species with no stance should map at rest');
});

check('legs pinned into the stance file are obeyed with no extra argument', () => {
  // The whole point of the one-file arrangement: a reader loads the library and gets both halves of what
  // the Rig stage decided, without having to know that pinning exists.
  const { json, bin } = load('077_ponyta');
  const base = mapStadiumRig(json, bin);
  const pinned = pinDetectedLegs(json, base, '077_ponyta');
  let stance = hipTurn(json, base, '077_ponyta');
  stance = setStanceRoles(stance, rolesFromMap(base, '077_ponyta'));
  const lib = putStance(emptyLibrary(), stance);

  const out = mapSpeciesFromLibrary(json, bin, '077_ponyta', lib);
  assert(pinned.legs.length === base.legs.length, 'Ponyta should pin cleanly');
  assert(out.map.legs.length === base.legs.length,
    `the library's pinned legs were not obeyed: ${base.legs.length} → ${out.map.legs.length}`);
  assert(!out.warnings.some(w => /leg count/.test(w)), 'nothing should have been lost');
});

check('the stance stamp moves when the pinning changes, not just the pose', () => {
  const { json, bin } = load('019_rattata');
  const base = mapStadiumRig(json, bin);
  const posed = hipTurn(json, base, '019_rattata');
  const withRoles = setStanceRoles(posed, rolesFromMap(base, '019_rattata'));
  assert(mapSpecies(json, bin, { stance: posed }).stamp !== mapSpecies(json, bin, { stance: withRoles }).stamp,
    'two different rigs stamped the same');
});

console.log('\n--- every shipped species still loads ---');

check('all fourteen load through the shared path with no stances authored', () => {
  const lib = emptyLibrary();
  for (const species of STADIUM_REFERENCE_SPECIES) {
    const { json, bin } = load(species);
    const out = mapSpeciesFromLibrary(json, bin, species, lib);
    const plain = mapStadiumRig(json, bin);
    assert(out.map.legs.length === plain.legs.length, `${species}: leg count changed`);
  }
});

check('all fourteen survive a pose once their legs are pinned', () => {
  const kept = [];
  for (const species of STADIUM_REFERENCE_SPECIES) {
    const { json, bin } = load(species);
    const base = mapStadiumRig(json, bin);
    if (!base.legs.length) continue;
    const roles = pinDetectedLegs(json, base, species);
    const out = mapSpecies(json, bin, { stance: hipTurn(json, base, species), roles, species });
    if (roles.warnings?.length) continue;                     // Sandslash, reported above
    assert(out.map.legs.length === base.legs.length,
      `${species}: ${base.legs.length} legs became ${out.map.legs.length}`);
    kept.push(species.slice(4));
  }
  console.log(`       kept every leg through a pose: ${kept.join(', ')}`);
});

console.log(results.join('\n'));
console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
