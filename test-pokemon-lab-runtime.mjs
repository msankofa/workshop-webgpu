// The base-game import path, proved without a browser. Run with `node test-pokemon-lab-runtime.mjs`.
//
// This is the test the plan asks for by name: "Node-testable end to end, which means a test can assert
// base-game's import path works without a browser." So it does the whole thing — fetch a lab file, read a
// real model, resolve names to node ids, put a pose on a scene graph — against the actual `.glb` files,
// with only `fetch` and the scene graph faked.

import fs from 'node:fs';
import { readRigFromGLB } from './pokemon-rig.js';
import {
  emptyAnnotation, setLocomotion, setRoot, setSpine, addAppendage, setContacts, setNeutralBone,
  putAnnotation, emptyLibrary, ANNOTATION_VERSION,
} from './pokemon-annotation.js';
import { loadLab, speciesInLab, rigFor, applyNeutral, missingParts, LAB_URL } from './pokemon-lab-runtime.js';

const DIR = 'models/stadium';
const FILES = { rattata: '019_rattata.glb', pikachu: '025_pikachu.glb', onix: '095_onix.glb' };

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
const eq = (a, b, msg) => assert(a === b, `${msg}: ${a} !== ${b}`);

const cache = new Map();
function rigOf(slug) {
  if (!cache.has(slug)) {
    const bytes = fs.readFileSync(`${DIR}/${FILES[slug]}`);
    cache.set(slug, { bytes, ...readRigFromGLB(bytes, { source: FILES[slug] }) });
  }
  return cache.get(slug);
}

/** A `fetch` that serves one object, so the load path is exercised rather than stepped around. */
const fakeFetch = (body, { ok = true, status = 200 } = {}) =>
  async () => ({ ok, status, json: async () => body });

/** A legged, contacted, posed annotation built the way the page builds one. */
function annotate(slug, species) {
  const { rig } = rigOf(slug);
  const chain = rig.chains.filter(c => c.bones.length >= 2).sort((a, b) => b.bones.length - a.bones.length)[0];
  let a = emptyAnnotation(species, rig);
  a = setLocomotion(a, 'walker', 'quadruped');
  a = setRoot(a, rig.root);
  a = setSpine(a, rig, [rig.root]);
  a = addAppendage(a, rig, { id: 'legL', type: 'leg', side: 'L', chain: chain.bones });
  a = setContacts(a, rig, [chain.bones[chain.bones.length - 1]]);
  a = setNeutralBone(a, rig.root, { p: [0, 1, 0], q: [0, 0, 0, 1], s: [1, 1, 1] });
  return { a, rig, chain };
}

console.log('\n--- loading the file ---');

await checkAsync('the lab loads as a plain static JSON, with no server behind it', async () => {
  const lab = putAnnotation(emptyLibrary(), annotate('rattata', '019_rattata').a);
  let asked = null;
  const lab2 = await loadLab(async (url) => { asked = url; return { ok: true, json: async () => lab }; });
  eq(asked, LAB_URL, 'fetched the wrong url');
  assert(!/api\/|serve/.test(LAB_URL), `${LAB_URL} looks like a server route, not a static file`);
  eq(speciesInLab(lab2).join(), '019_rattata', 'the species did not survive the round trip');
});

await checkAsync('a missing or wrong-version file is reported, not quietly empty', async () => {
  // The failure mode this guards is a game that renders unannotated creatures for a week because the
  // file 404s and nothing says so.
  let threw = false;
  try { await loadLab(fakeFetch(null, { ok: false, status: 404 })); } catch { threw = true; }
  assert(threw, 'a 404 did not throw');
  threw = false;
  try { await loadLab(fakeFetch({ version: ANNOTATION_VERSION + 9, species: {} })); } catch { threw = true; }
  assert(threw, 'a file from a future version did not throw');
});

console.log('\n--- what the game gets ---');

check('every id handed back is a node this model really has', () => {
  const { a, rig, chain } = annotate('rattata', '019_rattata');
  const out = rigFor(putAnnotation(emptyLibrary(), a), '019_rattata', rig);
  const nodes = new Set(rig.bones.map(b => b.node));
  const all = [out.root, ...out.spine, ...out.contacts, ...out.appendages.flatMap(ap => ap.chain)];
  assert(all.length >= 4, `only ${all.length} ids came back`);
  for (const n of all) {
    assert(Number.isInteger(n), `a non-integer node id came back: ${n}`);
    assert(nodes.has(n), `node ${n} is not a bone of this model`);
  }
  eq(out.appendages[0].chain.length, chain.bones.length, 'the limb lost bones on the way through');
  eq(out.locomotion, 'walker', 'the class did not survive');
  eq(out.annotated, true, 'an annotated species reported itself as unannotated');
});

check('the ids map back to the names the file speaks in', () => {
  // The one place names and node ids meet, so a silent off-by-one here would misplace every limb.
  const { a, rig, chain } = annotate('pikachu', '025_pikachu');
  const out = rigFor(putAnnotation(emptyLibrary(), a), '025_pikachu', rig);
  const back = out.appendages[0].chain.map(n => rig.keyOf(n));
  eq(back.join(), chain.bones.join(), 'resolving and un-resolving did not round trip');
});

check('an unannotated species comes back in the same shape, saying so', () => {
  const { rig } = rigOf('onix');
  const out = rigFor(emptyLibrary(), '095_onix', rig);
  eq(out.annotated, false, 'an empty file claimed to have an annotation');
  eq(out.root, null, 'a root appeared from nowhere');
  assert(Array.isArray(out.spine) && Array.isArray(out.appendages) && Array.isArray(out.contacts),
    'the caller would have to branch on null, which is what this shape exists to avoid');
  eq(missingParts(out).length, 5, 'an empty annotation is missing all five');
});

check('the model can be handed over as bytes or as an already-read rig', () => {
  // A game that has loaded the model anyway should not pay to parse it twice.
  const { a, rig, bytes } = { ...annotate('rattata', '019_rattata'), bytes: rigOf('rattata').bytes };
  const lab = putAnnotation(emptyLibrary(), a);
  const fromRig = rigFor(lab, '019_rattata', rig);
  const fromBytes = rigFor(lab, '019_rattata', bytes);
  eq(fromBytes.stamp, fromRig.stamp, 'the two routes disagree');
  eq(fromBytes.appendages[0].chain.join(), fromRig.appendages[0].chain.join(), 'the limbs differ');
});

check('a model re-exported since the annotation is reported, not thrown', () => {
  const { a, rig } = annotate('rattata', '019_rattata');
  const lab = putAnnotation(emptyLibrary(), a);
  eq(rigFor(lab, '019_rattata', rig).staleRig, false, 'a matching rig read as stale');
  const moved = putAnnotation(emptyLibrary(), { ...a, rigHash: 'not-the-same-model' });
  const out = rigFor(moved, '019_rattata', rig);
  eq(out.staleRig, true, 'a re-exported model was not noticed');
  assert(out.appendages.length, 'a stale rig must still hand back what it has, and let the caller decide');
});

console.log('\n--- driving a scene graph ---');

check('the neutral pose reaches a scene graph the runtime knows nothing about', () => {
  const { a, rig } = annotate('rattata', '019_rattata');
  const out = rigFor(putAnnotation(emptyLibrary(), a), '019_rattata', rig);
  const placed = new Map();
  const n = applyNeutral(out, (node, trs) => placed.set(node, trs));
  eq(n, 1, 'wrong number of bones placed');
  const [node, trs] = [...placed.entries()][0];
  assert(Number.isInteger(node), `the callback got a ${typeof node} key, not a node id`);
  eq(rig.keyOf(node), rig.root, 'the pose was applied to the wrong bone');
  eq(trs.p[1], 1, 'the transform did not survive');
});

check('nothing in the runtime touches THREE, a server, or the lab UI', () => {
  const src = fs.readFileSync('pokemon-lab-runtime.js', 'utf8');
  const code = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  for (const banned of ['three', 'disk-store', 'pokemon-lab-io', 'serve.py', 'localStorage', 'document']) {
    assert(!new RegExp(banned, 'i').test(code), `the runtime references ${banned}, which a game cannot rely on`);
  }
  const imports = [...code.matchAll(/from '([^']+)'/g)].map(m => m[1]);
  eq(imports.sort().join(), './pokemon-annotation.js,./pokemon-rig.js',
    `the contract must rest on the two pure modules only, not ${imports.join(', ')}`);
});

console.log('\n--- against the file as it actually stands ---');

await checkAsync('the real lab file loads through this path and resolves', async () => {
  // Not a fixture: whatever has been annotated so far, read the way a game would read it.
  const path = 'stadium-saves/pokemon-lab.json';
  if (!fs.existsSync(path)) { console.log('       no lab file yet, so nothing to resolve'); return; }
  const lab = await loadLab(fakeFetch(JSON.parse(fs.readFileSync(path, 'utf8'))));
  const names = speciesInLab(lab);
  assert(names.length, 'the lab file has no species in it');
  const lines = [];
  for (const species of names) {
    const file = `${DIR}/${species}.glb`;
    if (!fs.existsSync(file)) continue;
    const { rig } = readRigFromGLB(fs.readFileSync(file), { source: species });
    const out = rigFor(lab, species, rig);
    assert(!out.staleRig, `${species} was annotated against a different export of the model`);
    const nodes = new Set(rig.bones.map(b => b.node));
    for (const n of [out.root, ...out.spine, ...out.contacts, ...out.appendages.flatMap(ap => ap.chain)]) {
      assert(n === null || nodes.has(n), `${species} resolved to node ${n}, which is not one of its bones`);
    }
    const missing = missingParts(out);
    lines.push(`       ${species}: ${out.locomotion || 'unclassified'}`
      + `, ${out.appendages.length} limb(s), ${out.contacts.length} contact(s)`
      + (missing.length ? ` — still missing ${missing.join(', ')}` : ' — complete'));
  }
  console.log(lines.join('\n'));
});

console.log('\n' + results.join('\n'));
console.log(failures ? `\n${failures} check(s) failed\n` : `\n${results.length} checks passed\n`);
process.exit(failures ? 1 : 0);
