// Pure Lab annotation -> ground-movement map checks. No browser, renderer, DOM, or THREE.

import fs from 'node:fs';
import { parseGLB } from './stadium-glb.js';
import { mapStadiumRig } from './stadium-rig-map.js';
import { readRigFromGLB } from './pokemon-rig.js';
import {
  emptyAnnotation, emptyLibrary, putAnnotation, setLocomotion, setRoot, setSpine, setHead,
  addAppendage, setContacts,
} from './pokemon-annotation.js';
import { rigFor } from './pokemon-lab-runtime.js';
import { mapLabRigForGroundMovement } from './pokemon-lab-ground-map.js';

let failures = 0;
const results = [];
function check(name, fn) {
  try { fn(); results.push(`  ok   ${name}`); }
  catch (error) { failures++; results.push(`  FAIL ${name}\n       ${error.message}`); }
}
function assert(value, message) { if (!value) throw new Error(message); }
function near(a, b, tolerance, message) {
  if (Math.abs(a - b) > tolerance) throw new Error(`${message}: ${a} vs ${b}`);
}

function source(species) {
  const bytes = fs.readFileSync(`models/stadium/${species}.glb`);
  const { json, bin } = parseGLB(bytes);
  const facts = readRigFromGLB(bytes, { source: species }).rig;
  return { bytes, json, bin, facts, guessed: mapStadiumRig(json, bin, { source: species }) };
}

function annotationFromGuessed(species, facts, guessed, groups = guessed.legs.map(leg => [leg])) {
  let annotation = setLocomotion(emptyAnnotation(species, facts), 'walker',
    groups.length === 2 ? 'biped' : 'quadruped');
  annotation = setRoot(annotation, facts.keyOf(guessed.body));
  annotation = setSpine(annotation, facts, guessed.spine.map(facts.keyOf).filter(Boolean));
  if (guessed.head?.bones?.length) {
    annotation = setHead(annotation, facts, guessed.head.bones.map(facts.keyOf).filter(Boolean));
  }
  const contacts = [];
  groups.forEach((group, i) => {
    const side = group[0].side < 0 ? 'L' : 'R';
    const chain = [...new Set(group.flatMap(leg => leg.bones))].map(facts.keyOf).filter(Boolean);
    const feet = [...new Set(group.flatMap(leg => leg.footBones))].map(facts.keyOf).filter(Boolean);
    contacts.push(...feet);
    annotation = addAppendage(annotation, facts, {
      id: `leg${side}${i}`,
      type: 'leg',
      side,
      row: groups.length === 2 ? 0 : group[0].row,
      chain,
    });
  });
  return setContacts(annotation, facts, contacts);
}

function resolvedFromGuessed(species, groups) {
  const src = source(species);
  const annotation = annotationFromGuessed(species, src.facts, src.guessed, groups);
  const resolved = rigFor(putAnnotation(emptyLibrary(), annotation), species, src.facts);
  return { ...src, annotation, resolved };
}

check('an authored annotation produces every field the ground controller needs', () => {
  const src = resolvedFromGuessed('019_rattata');
  const out = mapLabRigForGroundMovement({
    annotationRig: src.resolved, measuredRig: src.facts, gltf: { json: src.json, bin: src.bin },
  });
  assert(out.map, `map failed: ${out.findings.map(f => f.code).join(', ')}`);
  assert(!out.findings.some(f => f.severity === 'error'), 'a complete annotation produced an error');
  assert(out.map.legs.length === src.resolved.appendages.length, 'a Lab leg disappeared');
  for (const leg of out.map.legs) {
    for (const field of ['attach', 'bones', 'jointBones', 'kneeIndex', 'footBones', 'footFrame',
      'l1', 'l2', 'span', 'hip', 'knee', 'foot', 'pole', 'poleSource', 'poleConfidence', 'restDir']) {
      assert(leg[field] != null, `leg ${leg.annotationId} is missing ${field}`);
    }
  }
  assert(Object.keys(out.map.restWorld).length === src.facts.bones.length, 'rest matrices are incomplete');
});

check('runtime-resolved node ids select the intended glTF bones', () => {
  const src = resolvedFromGuessed('019_rattata');
  const out = mapLabRigForGroundMovement({ annotationRig: src.resolved, gltf: src.bytes });
  assert(out.map, 'bytes input did not produce a map');
  for (let i = 0; i < src.resolved.appendages.length; i++) {
    const expected = new Set(src.resolved.appendages[i].chain);
    const actual = new Set(out.map.legs[i].bones);
    assert(expected.size === actual.size && [...expected].every(node => actual.has(node)),
      `leg ${i} did not preserve the resolved node ids`);
  }
});

check('Lab geometry matches the shared Stadium measurements', () => {
  const src = resolvedFromGuessed('019_rattata');
  const out = mapLabRigForGroundMovement({ annotationRig: src.resolved, gltf: src.bytes });
  for (let i = 0; i < out.map.legs.length; i++) {
    const actual = out.map.legs[i], expected = src.guessed.legs[i];
    near(actual.l1, expected.l1, 1e-9, `leg ${i} upper length`);
    near(actual.l2, expected.l2, 1e-9, `leg ${i} lower length`);
    for (const axis of ['x', 'y', 'z']) {
      near(actual.hip[axis], expected.hip[axis], 1e-9, `leg ${i} hip ${axis}`);
      near(actual.knee[axis], expected.knee[axis], 1e-9, `leg ${i} knee ${axis}`);
      near(actual.foot[axis], expected.foot[axis], 1e-9, `leg ${i} foot ${axis}`);
    }
  }
});

check('missing authored inputs produce named findings instead of guesses', () => {
  const src = resolvedFromGuessed('019_rattata');
  const cases = [
    ['missing-root', r => { r.root = null; }],
    ['missing-spine', r => { r.spine = []; }],
    ['missing-limb-chain', r => { r.appendages[0].chain = []; }],
    ['missing-foot', r => { r.appendages[0].contacts = []; }],
    ['missing-side', r => { r.appendages[0].side = 'C'; }],
    ['missing-row', r => { r.appendages[0].row = null; }],
  ];
  for (const [code, alter] of cases) {
    const { facts: _facts, ...plainResolved } = src.resolved;
    const resolved = structuredClone(plainResolved);
    alter(resolved);
    const out = mapLabRigForGroundMovement({ annotationRig: resolved, measuredRig: src.facts, gltf: src.bytes });
    assert(out.map === null, `${code} still produced a map`);
    assert(out.findings.some(f => f.code === code), `${code} was not named`);
  }
});

check('unassigned decorative bones are not completeness errors', () => {
  const src = resolvedFromGuessed('019_rattata');
  const claimed = new Set([
    src.resolved.root, ...src.resolved.spine,
    ...src.resolved.appendages.flatMap(ap => ap.chain), ...src.resolved.contacts,
  ]);
  assert(src.facts.bones.some(b => !claimed.has(b.node)), 'fixture has no decorative bone to leave alone');
  const out = mapLabRigForGroundMovement({ annotationRig: src.resolved, gltf: src.bytes });
  assert(out.map && !out.findings.some(f => /decorative|unassigned/.test(f.code)),
    'an unassigned decorative bone became required work');
});

check('one authored Sandslash leg may own both toe branches', () => {
  const src0 = source('028_sandslash');
  const groups = [-1, 1].map(side => src0.guessed.legs.filter(leg => leg.side === side));
  const src = resolvedFromGuessed('028_sandslash', groups);
  const out = mapLabRigForGroundMovement({ annotationRig: src.resolved, gltf: src.bytes });
  assert(out.map, `Sandslash map failed: ${out.findings.map(f => f.code).join(', ')}`);
  assert(out.map.legs.length === 2, `two authored legs became ${out.map.legs.length}`);
  assert(out.map.legs.every(leg => leg.footBones.length === 2), 'a toe branch was dropped');
  assert(out.map.legs.every(leg => leg.jointBones.length < leg.bones.length),
    'toe branches were mistaken for extra joints');
  assert(!out.findings.some(f => f.code === 'shared-limb-bone'), 'the two sides share a driven bone');
});

check('Machoke feet marked below each leg chain remain attached to their leg', () => {
  const src = source('067_machoke');
  let annotation = setLocomotion(emptyAnnotation('067_machoke', src.facts), 'walker', 'biped');
  annotation = setRoot(annotation, src.facts.keyOf(src.guessed.body));
  annotation = setSpine(annotation, src.facts, src.guessed.spine.map(src.facts.keyOf).filter(Boolean));
  annotation = addAppendage(annotation, src.facts, {
    id: 'legR', type: 'leg', side: 'R', row: 0, chain: ['bone32', 'bone31', 'bone30'],
  });
  annotation = addAppendage(annotation, src.facts, {
    id: 'legL', type: 'leg', side: 'L', row: 0, chain: ['bone04', 'bone03', 'bone02'],
  });
  annotation = setContacts(annotation, src.facts, ['bone29', 'bone28', 'bone01', 'bone00']);
  const resolved = rigFor(putAnnotation(emptyLibrary(), annotation), '067_machoke', src.facts);
  assert(resolved.appendages.every(ap => ap.contacts.length === 2),
    'runtime did not associate both foot branches with each leg');
  const out = mapLabRigForGroundMovement({ annotationRig: resolved, gltf: src.bytes });
  assert(!out.findings.some(f => f.code === 'missing-foot'), 'the movement map still says a Machoke leg has no foot');
  assert(!out.findings.some(f => f.code === 'short-limb-chain'),
    'the separately marked foot shortened the driven leg chain');
});

check('same input produces byte-equivalent plain data', () => {
  const src = resolvedFromGuessed('019_rattata');
  const args = { annotationRig: src.resolved, measuredRig: src.facts, gltf: src.bytes };
  const a = mapLabRigForGroundMovement(args);
  const b = mapLabRigForGroundMovement(args);
  assert(JSON.stringify(a) === JSON.stringify(b), 'repeated mapping changed its output');
});

console.log('pokemon Lab ground map');
for (const result of results) console.log(result);
if (failures) { console.error(`\n${failures} check(s) failed`); process.exitCode = 1; }
else console.log('\nall checks passed');
