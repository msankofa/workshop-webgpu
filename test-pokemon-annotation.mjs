// Annotation schema tests. Run with `node test-pokemon-annotation.mjs`.
//
// Built against real rigs, not a hand-made fake, so an assumption about the shape of a Stadium skeleton
// cannot quietly agree with itself.

import fs from 'node:fs';
import { readRigFromGLB, sampleClip } from './pokemon-rig.js';
import {
  ANNOTATION_VERSION, LOCOMOTION, APPENDAGE_TYPES, AIRBORNE,
  emptyAnnotation, copyAnnotation, isBlank, orderBones, depthOf,
  setLocomotion, setRoot, setSpine, setHead,
  addAppendage, updateAppendage, removeAppendage, toggleBones, nextAppendageId,
  setContacts, toggleContact, declareMirror,
  setNeutralBone, clearNeutral, neutralFromClip, defaultGrounding, setGrounding, groundingOf,
  setSegment, removeSegment, renameSegment, segmentsOf, resolveSegment, wholeClip, normaliseSegment,
  SEGMENT_ENDS, setDone,
  segmentKind, statesOf, transitionsOf, poseAt, COMMON_STATES,
  claimedBones, unaddressed, contactsOf, bodyContacts, appendagesOfType,
  validateAnnotation, isChain, suggestMirror,
  emptyLibrary, getAnnotation, putAnnotation, annotatedSpecies, annotationStamp, resolveAnnotation,
} from './pokemon-annotation.js';

const DIR = 'models/stadium';
const manifest = JSON.parse(fs.readFileSync(`${DIR}/manifest.json`, 'utf8'));
const ALL = Object.values(manifest).sort((a, b) => a.dex - b.dex);

let failures = 0;
const results = [];
function check(name, fn) {
  try { fn(); results.push(`  ok   ${name}`); }
  catch (e) { failures++; results.push(`  FAIL ${name}\n       ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const eq = (a, b, msg) => assert(a === b, `${msg}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);

const cache = new Map();
function rigOf(slug) {
  if (!cache.has(slug)) {
    const s = ALL.find(x => x.slug === slug);
    if (!s) throw new Error(`no species ${slug}`);
    cache.set(slug, { s, ...readRigFromGLB(fs.readFileSync(`${DIR}/${s.file}`), { source: s.file }) });
  }
  return cache.get(slug);
}

/** A real leg-ish chain to build parts from: the longest chain that reaches near the floor. */
function legChain(rig) {
  const floor = rig.units.floorY, h = rig.units.height;
  const reaching = rig.chains.filter(c => {
    const g = rig.geometry.get(c.tip) || rig.geometry.get(c.bones[c.bones.length - 1]);
    return g && (g.lowest.y - floor) < h * 0.2 && c.bones.length >= 2;
  });
  return (reaching.sort((a, b) => b.bones.length - a.bones.length)[0] || rig.chains[0]).bones;
}

console.log('\n--- construction ---');

check('an empty annotation is blank and survives a round trip', () => {
  const a = emptyAnnotation('019_rattata', rigOf('rattata').rig);
  assert(a.version === ANNOTATION_VERSION, 'wrong version');
  assert(isBlank(a), 'a fresh annotation is not blank');
  assert(a.rigHash === rigOf('rattata').rig.hash, 'rig hash not recorded');
  assert(JSON.stringify(copyAnnotation(a)) === JSON.stringify(a), 'copy differs from the original');
});

check('copy is deep — editing a copy cannot reach the original', () => {
  const { rig } = rigOf('rattata');
  let a = emptyAnnotation('019_rattata', rig);
  a = addAppendage(a, rig, { type: 'leg', side: 'L', chain: legChain(rig) });
  a = setContacts(a, rig, [legChain(rig).slice(-1)[0]]);
  a = setNeutralBone(a, rig.root, { p: [1, 2, 3], q: [0, 0, 0, 1], s: [1, 1, 1] });
  const b = copyAnnotation(a);
  b.parts.appendages[0].chain.push('intruder');
  b.parts.contacts.push('intruder');
  b.neutral.bones[rig.root].p[0] = 99;
  assert(!a.parts.appendages[0].chain.includes('intruder'), 'appendage chain is shared');
  assert(!a.parts.contacts.includes('intruder'), 'contacts array is shared');
  assert(a.neutral.bones[rig.root].p[0] === 1, 'neutral TRS is shared');
});

check('every edit returns a new object and leaves the input alone', () => {
  const { rig } = rigOf('rattata');
  const a = emptyAnnotation('019_rattata', rig);
  const frozen = JSON.stringify(a);
  const edits = [
    () => setLocomotion(a, 'walker', 'quadruped'),
    () => setRoot(a, rig.root),
    () => setSpine(a, rig, [rig.root]),
    () => setHead(a, rig, [rig.root]),
    () => addAppendage(a, rig, { type: 'leg', chain: legChain(rig) }),
    () => setContacts(a, rig, [rig.root]),
    () => setNeutralBone(a, rig.root, { p: [0, 1, 0] }),
    () => setDone(a, true),
    () => setGrounding(a, false),
    () => setSegment(a, 'idle', wholeClip(0)),
  ];
  for (const fn of edits) {
    const next = fn();
    assert(next !== a, 'an edit returned the same object');
    assert(JSON.stringify(a) === frozen, 'an edit mutated its input');
  }
});

console.log('\n--- bone ordering ---');

check('bones come back root-to-tip whatever order they go in', () => {
  const { rig } = rigOf('rattata');
  const chain = legChain(rig);
  assert(chain.length >= 3, 'need a chain of three for this test');
  const shuffled = [chain[2], chain[0], chain[1], ...chain.slice(3)];
  assert(JSON.stringify(orderBones(rig, shuffled)) === JSON.stringify(chain), 'shuffled bones did not sort back');
  const depths = chain.map(b => depthOf(rig, b));
  for (let i = 1; i < depths.length; i++) assert(depths[i] > depths[i - 1], 'a real chain is not strictly deepening');
});

check('ordering drops duplicates and strangers', () => {
  const { rig } = rigOf('rattata');
  const chain = legChain(rig);
  const out = orderBones(rig, [...chain, ...chain, 'nosuchbone']);
  assert(JSON.stringify(out) === JSON.stringify(chain), `got ${out.join(',')}`);
});

console.log('\n--- the two selection gestures ---');

check('a chain click and repeated bone clicks build the identical part', () => {
  const { rig } = rigOf('rattata');
  const chain = legChain(rig);
  const base = addAppendage(emptyAnnotation('x', rig), rig, { id: 'legL', type: 'leg', side: 'L' });

  const byChain = toggleBones(base, rig, 'legL', chain);
  let byBone = base;
  for (const b of [...chain].reverse()) byBone = toggleBones(byBone, rig, 'legL', b);

  assert(JSON.stringify(byChain.parts.appendages[0].chain) === JSON.stringify(byBone.parts.appendages[0].chain),
    'the two gestures produced different chains');
  assert(JSON.stringify(byChain.parts.appendages[0].chain) === JSON.stringify(chain), 'the chain is not in order');
});

check('one bone can be corrected off a part built by a chain click', () => {
  const { rig } = rigOf('rattata');
  const chain = legChain(rig);
  let a = addAppendage(emptyAnnotation('x', rig), rig, { id: 'legL', type: 'leg', chain });
  const last = chain[chain.length - 1];
  a = toggleBones(a, rig, 'legL', last);
  assert(!a.parts.appendages[0].chain.includes(last), 'the bone was not removed');
  assert(a.parts.appendages[0].chain.length === chain.length - 1, 'more than one bone changed');
  // And back on again, in the right slot.
  a = toggleBones(a, rig, 'legL', last);
  assert(JSON.stringify(a.parts.appendages[0].chain) === JSON.stringify(chain), 'the bone did not return in order');
});

check('a partly-present chain click adds the rest rather than toggling each', () => {
  const { rig } = rigOf('rattata');
  const chain = legChain(rig);
  let a = addAppendage(emptyAnnotation('x', rig), rig, { id: 'legL', type: 'leg', chain: [chain[0]] });
  a = toggleBones(a, rig, 'legL', chain);
  assert(JSON.stringify(a.parts.appendages[0].chain) === JSON.stringify(chain),
    'clicking a chain with one bone already in it should complete it, not remove that one');
  // Clicking again, now that all are present, removes them all.
  a = toggleBones(a, rig, 'legL', chain);
  assert(a.parts.appendages[0].chain.length === 0, 'a second chain click did not clear it');
});

check('force overrides the toggle in both directions', () => {
  const { rig } = rigOf('rattata');
  const chain = legChain(rig);
  let a = addAppendage(emptyAnnotation('x', rig), rig, { id: 'legL', type: 'leg', chain });
  a = toggleBones(a, rig, 'legL', chain, true);
  assert(a.parts.appendages[0].chain.length === chain.length, 'force-add on a full part changed it');
  a = toggleBones(a, rig, 'legL', chain, false);
  assert(a.parts.appendages[0].chain.length === 0, 'force-remove did not clear');
  a = toggleBones(a, rig, 'legL', chain, false);
  assert(a.parts.appendages[0].chain.length === 0, 'force-remove on an empty part changed it');
});

check('toggling on an appendage that does not exist is a no-op, not a throw', () => {
  const { rig } = rigOf('rattata');
  const a = emptyAnnotation('x', rig);
  const b = toggleBones(a, rig, 'nosuchpart', legChain(rig));
  assert(JSON.stringify(a) === JSON.stringify(b), 'a missing appendage changed the annotation');
});

console.log('\n--- appendages ---');

check('ids are unique and do not collide with an existing one', () => {
  const { rig } = rigOf('rattata');
  let a = emptyAnnotation('x', rig);
  a = addAppendage(a, rig, { type: 'leg', side: 'L' });
  a = addAppendage(a, rig, { type: 'leg', side: 'L' });
  a = addAppendage(a, rig, { type: 'leg', side: 'L' });
  const ids = a.parts.appendages.map(ap => ap.id);
  assert(new Set(ids).size === 3, `ids collided: ${ids.join(', ')}`);
  assert(ids[0] === 'legL', `first id should be legL, got ${ids[0]}`);
  assert(nextAppendageId(a, 'leg', 'L') !== ids[0], 'nextAppendageId returned a used id');
});

check('an unknown type or side falls back rather than being stored', () => {
  const { rig } = rigOf('rattata');
  let a = addAppendage(emptyAnnotation('x', rig), rig, { type: 'flipper', side: 'Q' });
  assert(a.parts.appendages[0].type === 'other', `type became ${a.parts.appendages[0].type}`);
  assert(a.parts.appendages[0].side === 'C', `side became ${a.parts.appendages[0].side}`);
  a = updateAppendage(a, rig, a.parts.appendages[0].id, { type: 'nonsense' });
  assert(a.parts.appendages[0].type === 'other', 'an unknown type overwrote a good one');
  a = updateAppendage(a, rig, a.parts.appendages[0].id, { type: 'wing' });
  assert(a.parts.appendages[0].type === 'wing', 'a valid type did not apply');
});

check('removing an appendage clears mirrors that pointed at it', () => {
  const { rig } = rigOf('rattata');
  let a = emptyAnnotation('x', rig);
  a = addAppendage(a, rig, { id: 'legL', type: 'leg', side: 'L' });
  a = addAppendage(a, rig, { id: 'legR', type: 'leg', side: 'R' });
  a = declareMirror(a, 'legL', 'legR');
  a = removeAppendage(a, 'legR');
  assert(a.parts.appendages.length === 1, 'the appendage was not removed');
  assert(a.parts.appendages[0].mirror === null, 'a dangling mirror survived');
  assert(validateAnnotation(a, rig).errors === 0, 'removal left the annotation invalid');
});

console.log('\n--- mirrors ---');

check('a declared mirror is reciprocal by construction', () => {
  const { rig } = rigOf('rattata');
  let a = emptyAnnotation('x', rig);
  a = addAppendage(a, rig, { id: 'legL', type: 'leg', side: 'L' });
  a = addAppendage(a, rig, { id: 'legR', type: 'leg', side: 'R' });
  a = declareMirror(a, 'legL', 'legR');
  assert(a.parts.appendages[0].mirror === 'legR' && a.parts.appendages[1].mirror === 'legL', 'not reciprocal');
  assert(validateAnnotation(a, rig).errors === 0, 'a valid mirror failed validation');
});

check('re-pairing releases the old partner instead of leaving it one-way', () => {
  const { rig } = rigOf('rattata');
  let a = emptyAnnotation('x', rig);
  for (const id of ['legL', 'legR', 'armL']) a = addAppendage(a, rig, { id, type: 'leg' });
  a = declareMirror(a, 'legL', 'legR');
  a = declareMirror(a, 'legL', 'armL');
  const by = Object.fromEntries(a.parts.appendages.map(ap => [ap.id, ap.mirror]));
  assert(by.legL === 'armL' && by.armL === 'legL', 'the new pair is wrong');
  assert(by.legR === null, `legR still points at ${by.legR}`);
  assert(validateAnnotation(a, rig).errors === 0, 're-pairing left a one-way mirror');
});

check('declaring a null mirror unpairs both sides', () => {
  const { rig } = rigOf('rattata');
  let a = emptyAnnotation('x', rig);
  a = addAppendage(a, rig, { id: 'legL', type: 'leg' });
  a = addAppendage(a, rig, { id: 'legR', type: 'leg' });
  a = declareMirror(a, 'legL', 'legR');
  a = declareMirror(a, 'legL', null);
  assert(a.parts.appendages.every(ap => ap.mirror === null), 'unpairing left a reference');
});

check('the mirror suggestion finds the other side on a symmetric quadruped', () => {
  const { rig } = rigOf('rattata');
  const chain = legChain(rig);
  const s = suggestMirror(rig, chain);
  assert(s.chain.length > 0, 'no mirror bones proposed at all');
  assert(!s.chain.some(b => chain.includes(b)), 'the suggestion returned bones from the source limb');
  assert(s.worst < 0.25, `worst match ${s.worst.toFixed(3)} of body height`);
  console.log(`       rattata: ${s.chain.length}/${chain.length} bones matched, worst ${(s.worst * 100).toFixed(1)}% of body height`);
});

check('the mirror suggestion reports misses rather than inventing matches', () => {
  const { rig } = rigOf('rattata');
  const chain = legChain(rig);
  const s = suggestMirror(rig, chain, { maxDistance: 0.0001 });
  assert(s.chain.length === 0, 'an impossible tolerance still produced matches');
  assert(s.misses.length === chain.length, `${s.misses.length} misses reported for ${chain.length} bones`);
});

check('a midline bone has no honest mirror', () => {
  const { rig } = rigOf('rattata');
  // The root sits on the centreline, so its best "mirror" is itself — and it is excluded.
  const s = suggestMirror(rig, [rig.root]);
  assert(!s.chain.includes(rig.root), 'a bone was proposed as its own mirror');
});

console.log('\n--- contacts ---');

check('contacts are stored once and split into limb and body by derivation', () => {
  const { rig } = rigOf('rattata');
  const chain = legChain(rig);
  const foot = chain[chain.length - 1];
  let a = emptyAnnotation('x', rig);
  a = addAppendage(a, rig, { id: 'legL', type: 'leg', chain });
  a = setContacts(a, rig, [foot, rig.root]);
  assert(JSON.stringify(contactsOf(a, 'legL')) === JSON.stringify([foot]), 'the foot did not resolve to its limb');
  assert(JSON.stringify(bodyContacts(a)) === JSON.stringify([rig.root]), 'the body contact did not fall out');
  assert(a.parts.contacts.length === 2, 'contacts were duplicated');
});

check('toggling a contact adds then removes it', () => {
  const { rig } = rigOf('rattata');
  let a = toggleContact(emptyAnnotation('x', rig), rig, rig.root);
  assert(a.parts.contacts.includes(rig.root), 'contact not added');
  a = toggleContact(a, rig, rig.root);
  assert(!a.parts.contacts.includes(rig.root), 'contact not removed');
});

console.log('\n--- the neutral pose ---');

check('a clip frame becomes a complete neutral pose', () => {
  const { rig } = rigOf('growlithe');
  const a = neutralFromClip(emptyAnnotation('058_growlithe', rig), rig, 0, 0.4, sampleClip);
  const bones = Object.keys(a.neutral.bones);
  assert(bones.length > 0, 'no bones posed');
  assert(a.neutral.source?.includes('@'), `source not recorded: ${a.neutral.source}`);
  // Every posed bone must carry all three paths even though the clip only supplies some.
  for (const b of bones) {
    const t = a.neutral.bones[b];
    assert(t.p?.length === 3 && t.q?.length === 4 && t.s?.length === 3, `${b} is a partial TRS`);
  }
  console.log(`       growlithe idle@0.4 poses ${bones.length} of ${rig.bones.length} bones`);
});

check('the rest pose fills whatever the clip does not touch', () => {
  const { rig } = rigOf('growlithe');
  const a = neutralFromClip(emptyAnnotation('x', rig), rig, 0, 0, sampleClip);
  // Find a bone the clip only rotates, and check its translation came from rest not from zero.
  const clip = rig.clips[0];
  const rotOnly = [...new Set(clip.tracks.filter(t => t.path === 'rotation').map(t => t.bone))]
    .find(b => !clip.tracks.some(t => t.bone === b && t.path === 'translation'));
  assert(rotOnly, 'no rotation-only bone to test with');
  const rest = rig.byKey.get(rotOnly).rest;
  assert(JSON.stringify(a.neutral.bones[rotOnly].p) === JSON.stringify(rest.p),
    'a bone the clip never translates did not keep its rest translation');
});

check('clearing the neutral pose keeps the grounding decision', () => {
  const { rig } = rigOf('rattata');
  let a = setGrounding(emptyAnnotation('x', rig), false);
  a = neutralFromClip(a, rig, 0, 0.1, sampleClip);
  a = clearNeutral(a);
  assert(Object.keys(a.neutral.bones).length === 0, 'bones survived the clear');
  assert(a.neutral.ground === false, 'grounding was reset along with the pose');
  assert(a.neutral.source === null, 'a stale source survived');
});

check('grounding defaults by class, and airborne classes default off', () => {
  assert(defaultGrounding('walker') === true, 'a walker should be grounded');
  assert(defaultGrounding('hopper') === true, 'a hopper should be grounded');
  assert(defaultGrounding('serpent') === true, 'a serpent should be grounded');
  for (const cls of AIRBORNE) assert(defaultGrounding(cls) === false, `${cls} should not be grounded`);
  const { rig } = rigOf('gastly');
  const a = setLocomotion(emptyAnnotation('092_gastly', rig), 'floater');
  assert(groundingOf(a) === false, 'a floater came out grounded');
  assert(groundingOf(setGrounding(a, true)) === true, 'an explicit choice did not beat the default');
});

console.log('\n--- validation ---');

check('a well-formed annotation passes clean', () => {
  const { rig } = rigOf('rattata');
  const chain = legChain(rig);
  let a = setLocomotion(emptyAnnotation('019_rattata', rig), 'walker', 'quadruped');
  a = setRoot(a, rig.root);
  a = addAppendage(a, rig, { id: 'legL', type: 'leg', side: 'L', chain });
  a = setContacts(a, rig, [chain[chain.length - 1]]);
  a = setSegment(a, 'idle', wholeClip(0));
  const v = validateAnnotation(a, rig);
  assert(v.errors === 0, `errors: ${v.findings.filter(f => f.level === 'error').map(f => f.text).join('; ')}`);
});

check('a bone claimed by two appendages is an error', () => {
  const { rig } = rigOf('rattata');
  const chain = legChain(rig);
  let a = emptyAnnotation('x', rig);
  a = addAppendage(a, rig, { id: 'legL', type: 'leg', chain });
  a = addAppendage(a, rig, { id: 'legR', type: 'leg', chain });
  const v = validateAnnotation(a, rig);
  assert(v.findings.some(f => f.code === 'double-claim'), 'the double claim was not reported');
});

check('a chain with a hole in it is an error', () => {
  const { rig } = rigOf('rattata');
  const chain = legChain(rig);
  assert(chain.length >= 3, 'need three bones');
  const holed = [chain[0], chain[2]];
  const a = addAppendage(emptyAnnotation('x', rig), rig, { id: 'legL', type: 'leg', chain: holed });
  const v = validateAnnotation(a, rig);
  assert(v.findings.some(f => f.code === 'broken-chain'), 'a limb skipping a joint was accepted');
  assert(!isChain(rig, holed), 'isChain accepted a hole');
});

check('a bone that is not in the model is an error wherever it appears', () => {
  const { rig } = rigOf('rattata');
  let a = emptyAnnotation('x', rig);
  a = setRoot(a, 'ghostbone');
  a = { ...a, parts: { ...a.parts, spine: ['ghostbone'], contacts: ['ghostbone'] } };
  a = { ...a, neutral: { ...a.neutral, bones: { ghostbone: { p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] } } } };
  const v = validateAnnotation(a, rig);
  const n = v.findings.filter(f => f.code === 'unknown-bone').length;
  assert(n === 4, `expected 4 unknown-bone findings (root, spine, contacts, neutral), got ${n}`);
});

check('an annotation made against a different build of the model is refused', () => {
  const { rig } = rigOf('rattata');
  const a = { ...emptyAnnotation('x', rig), rigHash: 'deadbeef' };
  const v = validateAnnotation(a, rig);
  assert(v.findings.some(f => f.code === 'stale-rig'), 'a stale rig hash was not caught');
});

check('a segment pointing at a clip the model lacks is an error', () => {
  const { rig } = rigOf('rattata');
  const a = setSegment(emptyAnnotation('x', rig), 'idle', wholeClip(999));
  assert(validateAnnotation(a, rig).findings.some(f => f.code === 'bad-clip'), 'a bad clip index was accepted');
});

check('validation never throws on rubbish', () => {
  const { rig } = rigOf('rattata');
  for (const junk of [null, undefined, {}, { parts: null }, { parts: { appendages: [{}] } }, { neutral: null }]) {
    const v = validateAnnotation(junk, rig);
    assert(Array.isArray(v.findings), 'findings is not a list');
  }
  assert(validateAnnotation(emptyAnnotation('x', rig), null).findings.length >= 0, 'a null rig threw');
});

console.log('\n--- what is left to say ---');

check('unaddressed bones shrink as parts are named, and are weighted by geometry', () => {
  const { rig } = rigOf('rattata');
  const before = unaddressed(emptyAnnotation('x', rig), rig);
  assert(before.length === rig.bones.length, 'a blank annotation should leave every bone unaddressed');
  const chain = legChain(rig);
  const a = addAppendage(emptyAnnotation('x', rig), rig, { id: 'legL', type: 'leg', chain });
  const after = unaddressed(a, rig);
  assert(after.length === before.length - chain.length, 'the count did not drop by the bones claimed');
  for (let i = 1; i < after.length; i++) assert(after[i].mass <= after[i - 1].mass, 'not sorted heaviest first');
  const big = unaddressed(a, rig, { minMassFraction: 0.02 });
  assert(big.length < after.length, 'the mass filter did nothing');
});

check('claimedBones covers every part, including contacts outside a limb', () => {
  const { rig } = rigOf('rattata');
  const chain = legChain(rig);
  let a = setRoot(emptyAnnotation('x', rig), rig.root);
  a = setSpine(a, rig, [rig.root]);
  a = addAppendage(a, rig, { id: 'legL', type: 'leg', chain });
  a = setContacts(a, rig, [chain[chain.length - 1], rig.bones[3].key]);
  const claimed = claimedBones(a);
  for (const b of [rig.root, ...chain, rig.bones[3].key]) assert(claimed.has(b), `${b} was not counted as claimed`);
});

console.log('\n--- the library file ---');

check('a blank annotation is not written to the file', () => {
  const { rig } = rigOf('rattata');
  let lib = emptyLibrary();
  lib = putAnnotation(lib, emptyAnnotation('019_rattata', rig));
  assert(annotatedSpecies(lib).length === 0, 'a blank annotation was stored');
  lib = putAnnotation(lib, setLocomotion(emptyAnnotation('019_rattata', rig), 'walker'));
  assert(annotatedSpecies(lib).length === 1, 'a real annotation was not stored');
  // And writing a blank one back REMOVES it, rather than leaving a husk behind.
  lib = putAnnotation(lib, emptyAnnotation('019_rattata', rig));
  assert(annotatedSpecies(lib).length === 0, 'blanking did not remove the entry');
});

check('get returns a copy, so editing it cannot reach the library', () => {
  const { rig } = rigOf('rattata');
  const lib = putAnnotation(emptyLibrary(), setLocomotion(emptyAnnotation('019_rattata', rig), 'walker'));
  const got = getAnnotation(lib, '019_rattata');
  got.locomotion = 'flyer';
  assert(lib.species['019_rattata'].locomotion === 'walker', 'the library was edited through a getter');
  assert(getAnnotation(lib, 'nosuch') === null, 'a missing species did not return null');
});

check('putting does not mutate the library it was given', () => {
  const { rig } = rigOf('rattata');
  const lib = emptyLibrary();
  const frozen = JSON.stringify(lib);
  putAnnotation(lib, setLocomotion(emptyAnnotation('019_rattata', rig), 'walker'));
  assert(JSON.stringify(lib) === frozen, 'putAnnotation mutated its input');
});

console.log('\n--- the stamp ---');

check('the stamp follows content, not key order or identity', () => {
  const { rig } = rigOf('rattata');
  const chain = legChain(rig);
  let a = setLocomotion(emptyAnnotation('x', rig), 'walker', 'quadruped');
  a = addAppendage(a, rig, { id: 'legL', type: 'leg', chain });
  a = addAppendage(a, rig, { id: 'legR', type: 'leg', chain: [] });
  const s1 = annotationStamp(a);
  assert(s1 === annotationStamp(copyAnnotation(a)), 'a copy stamped differently');
  assert(annotationStamp(emptyAnnotation('x', rig)) === 'blank', 'a blank annotation is not stamped blank');

  // Reordering the appendage list must not change the stamp; changing a chain must.
  const reordered = copyAnnotation(a);
  reordered.parts.appendages.reverse();
  assert(annotationStamp(reordered) === s1, 'reordering the appendage list changed the stamp');
  const changed = toggleBones(a, rig, 'legL', chain[0]);
  assert(annotationStamp(changed) !== s1, 'removing a bone did not change the stamp');
});

check('the stamp moves for every field that matters', () => {
  const { rig } = rigOf('rattata');
  const base = setLocomotion(emptyAnnotation('x', rig), 'walker', 'quadruped');
  const s = annotationStamp(base);
  const variants = {
    'locomotion': setLocomotion(base, 'flyer'),
    'posture': setLocomotion(base, 'walker', 'biped'),
    'root': setRoot(base, rig.root),
    'spine': setSpine(base, rig, [rig.root]),
    'contacts': setContacts(base, rig, [rig.root]),
    'neutral': setNeutralBone(base, rig.root, { p: [0, 1, 0], q: [0, 0, 0, 1], s: [1, 1, 1] }),
    'grounding': setGrounding(base, false),
    'segment': setSegment(base, 'idle', wholeClip(0)),
  };
  for (const [what, v] of Object.entries(variants)) {
    assert(annotationStamp(v) !== s, `changing the ${what} did not change the stamp`);
  }
  // `done` and `notes` are bookkeeping, not content — they must NOT move the stamp.
  assert(annotationStamp(setDone(base, true, 'a note')) === s, 'marking done changed the content stamp');
});

console.log('\n--- resolving for a runtime ---');

check('resolve turns every key into a node id the loader can use', () => {
  const { rig } = rigOf('rattata');
  const chain = legChain(rig);
  let a = setLocomotion(emptyAnnotation('019_rattata', rig), 'walker', 'quadruped');
  a = setRoot(a, rig.root);
  a = setSpine(a, rig, [rig.root]);
  a = addAppendage(a, rig, { id: 'legL', type: 'leg', side: 'L', chain });
  a = setContacts(a, rig, [chain[chain.length - 1]]);
  a = neutralFromClip(a, rig, 0, 0.2, sampleClip);

  const r = resolveAnnotation(a, rig);
  assert(typeof r.root === 'number', 'root did not resolve to a node id');
  assert(r.appendages[0].chain.length === chain.length, 'the limb lost bones in resolution');
  assert(r.appendages[0].chain.every(n => Number.isInteger(n)), 'a chain entry is not a node id');
  assert(r.appendages[0].contacts.length === 1, 'the limb contact did not resolve');
  assert(Object.keys(r.neutral.bones).every(k => Number.isInteger(Number(k))), 'a neutral key is not a node id');
  assert(r.neutral.ground === true, 'a walker resolved as ungrounded');
  assert(r.stamp === annotationStamp(a), 'the resolved stamp does not match');
  // The node ids must actually be this model's.
  for (const n of r.appendages[0].chain) assert(rig.keyOf(n), `node ${n} is not a bone of this rig`);
});

check('resolve drops what the rig no longer has rather than emitting nulls', () => {
  const { rig } = rigOf('rattata');
  let a = emptyAnnotation('x', rig);
  a = addAppendage(a, rig, { id: 'legL', type: 'leg', chain: [] });
  a = { ...a, parts: { ...a.parts, appendages: [{ ...a.parts.appendages[0], chain: ['ghost'] }], contacts: ['ghost'] } };
  const r = resolveAnnotation(a, rig);
  assert(r.appendages[0].chain.length === 0, 'a missing bone resolved to something');
  assert(r.contacts.length === 0, 'a missing contact resolved to something');
});

console.log('\n--- it works on the awkward five ---');

check('the shapes hold on species the old mapper could not do', () => {
  const cases = [
    ['sandslash', 'walker'], ['pikachu', 'walker'], ['onix', 'serpent'],
    ['voltorb', 'roller'], ['caterpie', 'worm'],
  ];
  for (const [slug, cls] of cases) {
    const { rig } = rigOf(slug);
    assert(LOCOMOTION.includes(cls), `"${cls}" is not a locomotion class the schema knows`);
    const locomotion = cls;
    let a = setLocomotion(emptyAnnotation(slug, rig), locomotion);
    a = setRoot(a, rig.root);
    // Whatever the body plan, the lowest-reaching bones can always be declared contacts.
    const floor = rig.units.floorY;
    const low = rig.bones
      .filter(b => rig.geometry.get(b.key) && (rig.geometry.get(b.key).lowest.y - floor) < rig.units.height * 0.1)
      .map(b => b.key);
    a = setContacts(a, rig, low);
    const v = validateAnnotation(a, rig);
    assert(v.errors === 0, `${slug}: ${v.findings.filter(f => f.level === 'error').map(f => f.text).join('; ')}`);
    assert(a.parts.contacts.length > 0, `${slug} has no bone near its own floor`);
    console.log(`       ${slug.padEnd(10)} ${String(rig.bones.length).padStart(3)} bones, ${a.parts.contacts.length} contacts, class ${locomotion}`);
  }
});

console.log('\n--- segments: named slices of a ROM clip ---');

check('a whole clip and an explicit full range describe the same thing', () => {
  const { rig } = rigOf('squirtle');
  const last = rig.clips[7].frames - 1;
  const whole = resolveSegment(wholeClip(7), rig.clips[7].frames);
  const spelt = resolveSegment({ clip: 7, from: 0, to: last, ends: 'loop' }, rig.clips[7].frames);
  eq(JSON.stringify(whole), JSON.stringify(spelt), 'whole clip vs explicit range');
  // But only one of them survives a re-export at a different length, which is why `to` may be null.
  eq(resolveSegment(wholeClip(7), 10).to, 9, 'a whole-clip segment follows the clip length');
  eq(resolveSegment({ clip: 7, from: 0, to: last }, 10).to, 9, 'an explicit range is clamped, not honoured');
});

check('an in point after the out point plays backwards', () => {
  const r = resolveSegment({ clip: 7, from: 8, to: 0, ends: 'hold' }, 52);
  assert(r.reversed, 'not marked reversed');
  eq(r.length, 9, 'length counts both ends');
  eq(r.from, 8, 'from');
  eq(r.to, 0, 'to');
  // The exit really is the entrance with its ends swapped, which is the whole point of storing a range.
  const forward = resolveSegment({ clip: 7, from: 0, to: 8, ends: 'hold' }, 52);
  eq(forward.length, r.length, 'the reverse of a segment is the same length');
  assert(!forward.reversed, 'the forward one is not reversed');
});

check('Squirtle withdrawing survives being written down and read back', () => {
  // The species this whole feature came from: eight frames of pulling in, then sitting in the shell.
  const { rig } = rigOf('squirtle');
  eq(rig.clips[7].name, 'attack_5', 'clip 7 is the withdraw');
  let a = emptyAnnotation('007_squirtle', rig);
  a = setSegment(a, 'enter_shell', { clip: 7, from: 0, to: 8, ends: 'hold' });
  a = setSegment(a, 'in_shell', { clip: 7, from: 8, to: 51, ends: 'loop' });
  a = setSegment(a, 'exit_shell', { clip: 7, from: 8, to: 0, ends: 'hold' });
  eq(validateAnnotation(a, rig).errors, 0, 'the three segments should validate');
  const back = JSON.parse(JSON.stringify(a));
  eq(JSON.stringify(back.segments), JSON.stringify(a.segments), 'segments survive JSON');
  const resolved = resolveAnnotation(a, rig);
  assert(resolved.segments.exit_shell.reversed, 'the exit is reversed after resolving');
  eq(resolved.segments.in_shell.length, 44, 'the in-shell hold is 44 frames');
});

check('a segment naming frames the clip does not have is an error, and still plays', () => {
  const { rig } = rigOf('squirtle');
  const frames = rig.clips[0].frames;
  const a = setSegment(emptyAnnotation('x', rig), 'idle', { clip: 0, from: 0, to: frames + 50 });
  assert(validateAnnotation(a, rig).findings.some(f => f.code === 'bad-segment'), 'the overrun was accepted');
  // Reported, but clamped rather than refused: a segment authored against a longer cut still plays.
  const r = resolveSegment(a.segments.idle, frames);
  eq(r.to, frames - 1, 'clamped to the last frame');
  assert(r.truncated, 'not flagged as truncated');
});

check('a single frame set to loop is worth a warning, not an error', () => {
  const { rig } = rigOf('squirtle');
  const a = setSegment(emptyAnnotation('x', rig), 'held', { clip: 0, from: 4, to: 4, ends: 'loop' });
  const v = validateAnnotation(a, rig);
  eq(v.errors, 0, 'it is legal');
  assert(v.findings.some(f => f.code === 'bad-segment' && f.level === 'warn'), 'no warning');
});

check('rubbish in a segment is refused rather than half-stored', () => {
  eq(normaliseSegment(null), null, 'null');
  eq(normaliseSegment({ from: 0, to: 5 }), null, 'no clip index');
  eq(normaliseSegment({ clip: -1 }), null, 'a negative clip');
  eq(normaliseSegment({ clip: 'two' }), null, 'a clip that is not a number');
  const seg = normaliseSegment({ clip: 2, from: '3.6', to: 9, ends: 'sideways' });
  eq(seg.from, 4, 'a fractional frame is rounded');
  eq(seg.ends, 'loop', 'an unknown ending falls back to loop');
  eq(normaliseSegment({ clip: 2 }).to, null, 'an absent end stays absent');
  for (const e of SEGMENT_ENDS) eq(normaliseSegment({ clip: 0, ends: e }).ends, e, `${e} survives`);
});

check('setting a segment does not mutate, and an empty name does nothing', () => {
  const { rig } = rigOf('squirtle');
  const a = setSegment(emptyAnnotation('x', rig), 'idle', wholeClip(0));
  const frozen = JSON.stringify(a);
  const b = setSegment(a, 'walk', wholeClip(1));
  assert(JSON.stringify(a) === frozen, 'setting a segment mutated its input');
  eq(Object.keys(b.segments).length, 2, 'the second segment was added');
  eq(Object.keys(setSegment(a, '   ', wholeClip(1)).segments).length, 1, 'a blank name added something');
  eq(Object.keys(removeSegment(a, 'idle').segments).length, 0, 'remove');
  assert(JSON.stringify(a) === frozen, 'removing a segment mutated its input');
});

check('renaming keeps the range and frees the old name', () => {
  const { rig } = rigOf('squirtle');
  let a = setSegment(emptyAnnotation('x', rig), 'shell', { clip: 7, from: 0, to: 8, ends: 'hold' });
  a = renameSegment(a, 'shell', 'enter_shell');
  eq(Object.keys(a.segments).join(','), 'enter_shell', 'the name moved');
  eq(a.segments.enter_shell.to, 8, 'the range came with it');
  eq(Object.keys(renameSegment(a, 'nothing', 'x').segments).join(','), 'enter_shell', 'renaming a missing segment');
});

check('the stamp moves for a range change, not just a clip change', () => {
  const { rig } = rigOf('squirtle');
  const base = setSegment(emptyAnnotation('x', rig), 'idle', { clip: 0, from: 0, to: 10, ends: 'loop' });
  const s = annotationStamp(base);
  const changed = [
    ['the out point', setSegment(base, 'idle', { clip: 0, from: 0, to: 11, ends: 'loop' })],
    ['the in point', setSegment(base, 'idle', { clip: 0, from: 1, to: 10, ends: 'loop' })],
    ['the direction', setSegment(base, 'idle', { clip: 0, from: 10, to: 0, ends: 'loop' })],
    ['the ending', setSegment(base, 'idle', { clip: 0, from: 0, to: 10, ends: 'hold' })],
    ['the clip', setSegment(base, 'idle', { clip: 1, from: 0, to: 10, ends: 'loop' })],
    ['the name', renameSegment(base, 'idle', 'stand')],
  ];
  for (const [what, v] of changed) assert(annotationStamp(v) !== s, `changing ${what} did not move the stamp`);
  eq(annotationStamp(setSegment(base, 'idle', { clip: 0, from: 0, to: 10, ends: 'loop' })), s,
    'rewriting the same segment moved the stamp');
});

check('segments come back in a stable order whatever they were written in', () => {
  const { rig } = rigOf('squirtle');
  let a = emptyAnnotation('x', rig), b = emptyAnnotation('x', rig);
  for (const n of ['exit_shell', 'idle', 'enter_shell']) a = setSegment(a, n, wholeClip(0));
  for (const n of ['idle', 'enter_shell', 'exit_shell']) b = setSegment(b, n, wholeClip(0));
  eq(segmentsOf(a).map(([n]) => n).join(','), segmentsOf(b).map(([n]) => n).join(','), 'order');
  eq(annotationStamp(a), annotationStamp(b), 'write order changed the stamp');
});

check('a species with only segments is not blank, and an empty one still is', () => {
  const { rig } = rigOf('squirtle');
  assert(isBlank(emptyAnnotation('x', rig)), 'a fresh annotation should be blank');
  assert(!isBlank(setSegment(emptyAnnotation('x', rig), 'idle', wholeClip(0))), 'a segment makes it real');
});

// --- states and transitions ---------------------------------------------------------------------

check('a range that loops is a state, and one that runs out and holds is a transition', () => {
  eq(segmentKind({ clip: 0, from: 0, to: 39, ends: 'loop' }), 'state', 'a loop sustains');
  eq(segmentKind({ clip: 7, from: 7, to: 51, ends: 'hold' }), 'transition', 'a held range leaves you elsewhere');
  eq(segmentKind(wholeClip(0)), 'state', 'a looping whole clip sustains');
});

check('a single frame held is a state, because you can stay on it', () => {
  eq(segmentKind({ clip: 7, from: 51, to: 51, ends: 'hold' }), 'state', 'one frame is a pose');
  eq(segmentKind(poseAt(7, 51)), 'state', 'poseAt builds one');
  eq(poseAt(7, 51).ends, 'hold', 'a pose does not loop');
  eq(poseAt(7, 51.6).from, 52, 'a fractional playhead rounds to a frame');
});

check('the kind is derived, so a segment cannot disagree with its own label', () => {
  // Nothing writes a kind down. Moving the end frame is enough to change what the segment is.
  const pose = poseAt(3, 10);
  eq(segmentKind(pose), 'state', 'held on one frame');
  eq(segmentKind({ ...pose, to: 20 }), 'transition', 'the same segment stretched now goes somewhere');
  assert(!('kind' in pose), 'the kind must not be stored');
  assert(!('kind' in normaliseSegment(pose)), 'normalising must not add one either');
});

check('an open end resolves before it is classified', () => {
  const { rig } = rigOf('squirtle');
  const held = { clip: 0, from: 0, to: null, ends: 'hold' };
  eq(segmentKind(held), 'transition', 'unresolved, an open end cannot equal the start');
  // Resolved against a one-frame clip the same segment is a single frame, so it is a state.
  eq(segmentKind(resolveSegment(held, 1)), 'state', 'resolved to one frame it is a pose');
  eq(segmentKind(resolveSegment(held, rig.clips[0].frames)), 'transition', 'resolved to 40 frames it is not');
});

check('states and transitions split the segment list without dropping any', () => {
  const { rig } = rigOf('squirtle');
  let a = emptyAnnotation('squirtle', rig);
  a = setSegment(a, 'idle', wholeClip(0));
  a = setSegment(a, 'in_shell', poseAt(7, 51));
  a = setSegment(a, 'enter_shell', { clip: 7, from: 20, to: 51, ends: 'hold' });
  a = setSegment(a, 'exit_shell', { clip: 7, from: 51, to: 20, ends: 'hold' });
  eq(statesOf(a).map(([n]) => n).join(','), 'idle,in_shell', 'the two that sustain');
  eq(transitionsOf(a).map(([n]) => n).join(','), 'enter_shell,exit_shell', 'the two that lead somewhere');
  eq(statesOf(a).length + transitionsOf(a).length, segmentsOf(a).length, 'every segment is one or the other');
});

check('a reversed range is still a transition, since it lands somewhere new', () => {
  const seg = { clip: 7, from: 51, to: 20, ends: 'hold' };
  eq(segmentKind(seg), 'transition', 'backwards is still going somewhere');
  eq(resolveSegment(seg, 53).reversed, true, 'and it does play backwards');
});

check('resolveAnnotation hands the runtime the kind, so it never re-derives it', () => {
  const { rig } = rigOf('squirtle');
  let a = emptyAnnotation('squirtle', rig);
  a = setSegment(a, 'in_shell', poseAt(7, 51));
  a = setSegment(a, 'enter_shell', { clip: 7, from: 20, to: 51, ends: 'hold' });
  const out = resolveAnnotation(a, rig);
  eq(out.segments.in_shell.kind, 'state', 'the pose');
  eq(out.segments.enter_shell.kind, 'transition', 'the way into it');
  eq(typeof out.segments.in_shell.to, 'number', 'bounds are concrete by then');
});

check('the shared state vocabulary is names only, and constrains nothing', () => {
  const { rig } = rigOf('squirtle');
  assert(COMMON_STATES.includes('idle'), 'a runtime asks every species for idle');
  assert(COMMON_STATES.every(n => typeof n === 'string' && n === n.trim() && n.length), 'all plain names');
  eq(new Set(COMMON_STATES).size, COMMON_STATES.length, 'no duplicates');
  // A name outside the list saves exactly the same way.
  const a = setSegment(emptyAnnotation('squirtle', rig), 'in_shell', poseAt(7, 51));
  assert(!COMMON_STATES.includes('in_shell'), 'in_shell is Squirtle-only, so it is not in the list');
  eq(segmentsOf(a).length, 1, 'and it still saved');
});

check('a bad segment has no kind rather than a wrong one', () => {
  eq(segmentKind(null), null, 'nothing is not a state');
  eq(segmentKind({ clip: -1, from: 0, to: 0 }), null, 'nor is a segment with no clip');
});

console.log(results.join('\n'));
console.log(failures ? `\n${failures} check(s) failed\n` : `\n${results.length} checks passed\n`);
process.exit(failures ? 1 : 0);
