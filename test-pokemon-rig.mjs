// Facts module tests. Run with `node test-pokemon-rig.mjs`.
//
// Most of these run over all 151 models rather than a fixture, because the point of this module is that
// it is right about the actual files. A fixture built from my assumptions would agree with my mistakes.

import fs from 'node:fs';
import { parseGLB } from './stadium-glb.js';
import {
  readRig, readRigFromGLB, boneKeys, pivotTree, extractChains, subtree,
  sampleClip, rigHash, descendants, ancestors, isUnbrokenChain, restTRS,
} from './pokemon-rig.js';

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

const cache = new Map();
function rigOf(slugOrFile) {
  const s = ALL.find(x => x.slug === slugOrFile || x.file === slugOrFile);
  if (!s) throw new Error(`no such species ${slugOrFile}`);
  if (!cache.has(s.file)) cache.set(s.file, readRigFromGLB(fs.readFileSync(`${DIR}/${s.file}`), { source: s.file }));
  return cache.get(s.file);
}

// Read every model once. Everything below reuses this.
const every = [];
for (const s of ALL) {
  const bytes = fs.readFileSync(`${DIR}/${s.file}`);
  every.push({ s, ...readRigFromGLB(bytes, { source: s.file }) });
}

console.log('\n--- it reads all 151 ---');

check('every model produces a rig', () => {
  assert(every.length === 151, `read ${every.length} models`);
  for (const e of every) assert(e.rig.bones.length > 0, `${e.s.slug} has no bones`);
});

check('bone counts match the manifest', () => {
  const off = every.filter(e => e.rig.bones.length !== e.s.bones);
  assert(!off.length, `${off.length} disagree, e.g. ${off.slice(0, 3).map(e => `${e.s.slug} ${e.rig.bones.length}!=${e.s.bones}`).join(', ')}`);
});

check('every skeleton has exactly one root', () => {
  const many = every.filter(e => e.rig.roots.length !== 1);
  assert(!many.length, `${many.length} with a different root count: ${many.slice(0, 5).map(e => `${e.s.slug}:${e.rig.roots.length}`).join(', ')}`);
});

check('every bone but the root has a parent that exists', () => {
  for (const e of every) {
    for (const b of e.rig.bones) {
      if (b.key === e.rig.root) { assert(b.parent === null, `${e.s.slug} root has a parent`); continue; }
      assert(b.parent !== null, `${e.s.slug} ${b.key} has no parent`);
      assert(e.rig.byKey.has(b.parent), `${e.s.slug} ${b.key} points at missing parent ${b.parent}`);
    }
  }
});

check('parent and children agree in both directions', () => {
  for (const e of every) {
    for (const b of e.rig.bones) {
      for (const c of b.children) {
        assert(e.rig.byKey.get(c)?.parent === b.key, `${e.s.slug}: ${c} is a child of ${b.key} but does not name it as parent`);
      }
    }
  }
});

check('the tree is acyclic and reaches every bone from the root', () => {
  for (const e of every) {
    const seen = descendants(e.rig, e.rig.root);
    assert(new Set(seen).size === seen.length, `${e.s.slug} revisits a bone — the tree has a cycle`);
    assert(seen.length === e.rig.bones.length, `${e.s.slug}: ${seen.length} of ${e.rig.bones.length} bones reachable from the root`);
  }
});

console.log('\n--- bone keys ---');

check('exactly three species carry a duplicated bone name', () => {
  const dup = every.filter(e => e.rig.duplicateNames.length);
  const slugs = dup.map(e => e.s.slug).sort();
  assert(JSON.stringify(slugs) === JSON.stringify(['charizard', 'charmander', 'magmar']),
    `expected charizard, charmander, magmar; got ${slugs.join(', ') || 'none'}`);
  for (const e of dup) assert(e.rig.duplicateNames.length === 1, `${e.s.slug} has ${e.rig.duplicateNames.length} collisions`);
});

check('a duplicated name is disambiguated rather than dropped', () => {
  const e = every.find(x => x.s.slug === 'charmander');
  const hashed = e.rig.bones.filter(b => b.key.includes('#'));
  assert(hashed.length === 1, `expected one #-keyed bone, found ${hashed.length}`);
  assert(hashed[0].key.endsWith('#2'), `unexpected key ${hashed[0].key}`);
  // Both bones survive under distinct keys, and both still report the same underlying NAME.
  const sameName = e.rig.bones.filter(b => b.name === hashed[0].name);
  assert(sameName.length === 2, `${sameName.length} bones share the name ${hashed[0].name}`);
  assert(new Set(sameName.map(b => b.key)).size === 2, 'the two bones collapsed to one key');
  assert(new Set(sameName.map(b => b.node)).size === 2, 'the two keys point at one node');
});

check('keys are unique on every species', () => {
  for (const e of every) {
    const keys = e.rig.bones.map(b => b.key);
    assert(new Set(keys).size === keys.length, `${e.s.slug} has duplicate keys`);
  }
});

check('keys round-trip to node ids and back', () => {
  for (const e of every) {
    for (const b of e.rig.bones) {
      assert(e.rig.nodeOf.get(b.key) === b.node, `${e.s.slug} ${b.key} -> ${e.rig.nodeOf.get(b.key)} != ${b.node}`);
      assert(e.rig.keyOf(b.node) === b.key, `${e.s.slug} node ${b.node} -> ${e.rig.keyOf(b.node)} != ${b.key}`);
    }
  }
});

check('key assignment does not depend on the order pivots arrive in', () => {
  const { json } = rigOf('charmander');
  const tree = pivotTree(json);
  const forward = boneKeys(json, tree.pivots);
  const reversed = boneKeys(json, [...tree.pivots].reverse());
  for (const [node, key] of forward.byNode) {
    assert(reversed.byNode.get(node) === key, `node ${node} keyed ${key} one way and ${reversed.byNode.get(node)} the other`);
  }
});

console.log('\n--- geometry ---');

check('every model has vertical extent and a sane floor', () => {
  for (const e of every) {
    assert(e.rig.units.height > 0, `${e.s.slug} has no height`);
    assert(e.rig.units.totalVertices > 0, `${e.s.slug} has no skinned vertices`);
  }
});

check('a bone with geometry has a centroid inside its own bounding box', () => {
  for (const e of every) {
    for (const [key, g] of e.rig.geometry) {
      for (const ax of ['x', 'y', 'z']) {
        assert(g.centroid[ax] >= g.min[ax] - 1e-4 && g.centroid[ax] <= g.max[ax] + 1e-4,
          `${e.s.slug} ${key} centroid.${ax} outside its box`);
      }
    }
  }
});

check('the lowest point of a bone is at its own box floor', () => {
  for (const e of every) {
    for (const [key, g] of e.rig.geometry) {
      assert(Math.abs(g.lowest.y - g.min.y) < 1e-4, `${e.s.slug} ${key} lowest.y ${g.lowest.y} != min.y ${g.min.y}`);
    }
  }
});

check('per-bone vertex counts sum to the model total', () => {
  for (const e of every) {
    let n = 0;
    for (const g of e.rig.geometry.values()) n += g.count;
    assert(n === e.rig.units.totalVertices, `${e.s.slug}: ${n} != ${e.rig.units.totalVertices}`);
  }
});

check('hasGeometry agrees with the geometry map', () => {
  for (const e of every) {
    for (const b of e.rig.bones) {
      assert(b.hasGeometry === e.rig.geometry.has(b.key), `${e.s.slug} ${b.key} disagrees`);
    }
  }
  // And bones WITHOUT geometry are real and common: they are the tip markers ending most limbs.
  const withNone = every.reduce((n, e) => n + e.rig.bones.filter(b => !b.hasGeometry).length, 0);
  assert(withNone > 0, 'no tip markers found at all, which contradicts what these rigs look like');
  console.log(`       ${withNone} bones across the dex carry no geometry of their own`);
});

console.log('\n--- chains ---');

check('every chain is an unbroken parent-to-child run', () => {
  for (const e of every) {
    for (const c of e.rig.chains) {
      assert(isUnbrokenChain(e.rig, c.bones), `${e.s.slug} ${c.id} is not one run`);
    }
  }
});

check('chains partition the skeleton: every non-root bone is in exactly one', () => {
  for (const e of every) {
    const count = new Map();
    for (const c of e.rig.chains) for (const b of c.bones) count.set(b, (count.get(b) || 0) + 1);
    const twice = [...count].filter(([, n]) => n > 1);
    assert(!twice.length, `${e.s.slug}: ${twice.length} bone(s) in two chains, e.g. ${twice[0]?.[0]}`);
    const missing = e.rig.bones.filter(b => b.key !== e.rig.root && !count.has(b.key));
    assert(!missing.length, `${e.s.slug}: ${missing.length} bone(s) in no chain, e.g. ${missing[0]?.key}`);
  }
});

check("a chain's attach is the parent of its first bone", () => {
  for (const e of every) {
    for (const c of e.rig.chains) {
      assert(e.rig.byKey.get(c.bones[0])?.parent === c.attach, `${e.s.slug} ${c.id} attach mismatch`);
    }
  }
});

check('mass fractions are fractions, and the significant ones are the minority', () => {
  const sig = [];
  for (const e of every) {
    for (const c of e.rig.chains) {
      assert(c.massFraction >= 0 && c.massFraction <= 1.0001, `${e.s.slug} ${c.id} massFraction ${c.massFraction}`);
    }
    sig.push(e.rig.chains.filter(c => c.massFraction > 0.02).length);
  }
  const total = sig.reduce((a, b) => a + b, 0);
  const chains = every.reduce((n, e) => n + e.rig.chains.length, 0);
  assert(total < chains, 'every chain is significant, so the threshold is doing nothing');
  const sorted = [...sig].sort((a, b) => a - b);
  console.log(`       ${total} chains over 2% of the mesh, of ${chains} total`
    + ` (per species min ${sorted[0]}, median ${sorted[Math.floor(sorted.length / 2)]}, max ${sorted[sorted.length - 1]})`);
});

console.log('\n--- clips ---');

check('every species has the four clips the ROM always shipped', () => {
  for (const e of every) {
    assert(e.rig.clips.length > 0, `${e.s.slug} has no clips`);
    // The manifest labels them; here we only assert the file agrees on how many there are.
    assert(e.rig.clips.length === e.s.clips.length,
      `${e.s.slug}: ${e.rig.clips.length} clips read vs ${e.s.clips.length} in the manifest`);
  }
});

check('clip durations match the manifest seconds', () => {
  for (const e of every) {
    for (let i = 0; i < e.rig.clips.length; i++) {
      const want = e.s.clips[i].seconds;
      const got = e.rig.clips[i].duration;
      assert(Math.abs(got - want) < 0.05, `${e.s.slug} clip ${i}: ${got.toFixed(3)}s vs manifest ${want}s`);
    }
  }
});

check('every clip track names a bone the rig knows', () => {
  for (const e of every) {
    for (const c of e.rig.clips) {
      for (const t of c.tracks) assert(e.rig.byKey.has(t.bone), `${e.s.slug} clip ${c.index} targets unknown ${t.bone}`);
      for (const b of c.bones) assert(e.rig.byKey.has(b), `${e.s.slug} clip ${c.index} lists unknown ${b}`);
    }
  }
});

check('rotation tracks decode to unit quaternions', () => {
  // Guards the normalized-int16 trap: a reader ignoring the flag returns values ~32767x too large.
  let checked = 0;
  for (const e of every) {
    for (const c of e.rig.clips) {
      for (const t of c.tracks) {
        if (t.path !== 'rotation') continue;
        assert(t.stride === 4, `${e.s.slug} rotation stride ${t.stride}`);
        for (let k = 0; k < t.times.length; k++) {
          const m = Math.hypot(t.values[k * 4], t.values[k * 4 + 1], t.values[k * 4 + 2], t.values[k * 4 + 3]);
          assert(Math.abs(m - 1) < 0.02, `${e.s.slug} clip ${c.index} key ${k} quaternion length ${m.toFixed(4)}`);
          checked++;
        }
      }
    }
  }
  assert(checked > 1000, `only ${checked} rotation keys checked`);
  console.log(`       ${checked} rotation keys, all unit length`);
});

check('sampleClip holds the last key past the end and the first before the start', () => {
  const { rig } = rigOf('rattata');
  const clip = rig.clips[0];
  const early = sampleClip(clip, -5);
  const late = sampleClip(clip, clip.duration * 10);
  const first = sampleClip(clip, 0);
  const last = sampleClip(clip, clip.duration);
  assert(Object.keys(early).length > 0, 'sampling before the start returned nothing');
  assert(JSON.stringify(early) === JSON.stringify(first), 'before the start differs from the first key');
  assert(JSON.stringify(late) === JSON.stringify(last), 'past the end differs from the last key');
});

check('sampleClip returns a partial pose, not a whole one', () => {
  const { rig } = rigOf('rattata');
  const frame = sampleClip(rig.clips[0], 0.1);
  const keys = Object.keys(frame);
  assert(keys.length > 0, 'no bones sampled');
  assert(keys.every(k => rig.byKey.has(k)), 'sampled a bone the rig does not have');
  // At least one bone must be missing a path, or the caller never needs the rest-pose fallback.
  const anyPartial = keys.some(k => !('q' in frame[k]) || !('p' in frame[k]) || !('s' in frame[k]));
  assert(anyPartial, 'every sampled bone had all three paths, so the partial contract is untested here');
});

check('sampleClip survives malformed and empty input', () => {
  assert(JSON.stringify(sampleClip(null, 0)) === '{}', 'null clip');
  assert(JSON.stringify(sampleClip({}, 0)) === '{}', 'empty clip');
  assert(JSON.stringify(sampleClip({ tracks: [{ bone: 'a', path: 'weights', times: [0], values: [1], stride: 1 }] }, 0)) === '{}',
    'an unsupported path should be ignored, not thrown on');
  assert(JSON.stringify(sampleClip({ tracks: [{ bone: 'a', path: 'rotation', times: [0], values: [1, 2], stride: 4 }] }, 0)) === '{}',
    'a truncated key should be skipped');
});

console.log('\n--- the rig hash ---');

check('the hash is stable across re-reads and unique across species', () => {
  const again = readRigFromGLB(fs.readFileSync(`${DIR}/019_rattata.glb`)).rig.hash;
  assert(again === rigOf('rattata').rig.hash, 'reading the same file twice gave two hashes');
  const hashes = every.map(e => e.rig.hash);
  const dupes = hashes.length - new Set(hashes).size;
  assert(dupes === 0, `${dupes} species share a hash with another`);
});

check('the hash moves when the topology moves', () => {
  const { rig } = rigOf('rattata');
  const bones = rig.bones.map(b => ({ ...b }));
  const before = rigHash(bones, rig.geometry);
  assert(before === rig.hash, 'recomputing over the same input changed the hash');
  const moved = bones.map((b, i) => (i === 5 ? { ...b, parent: rig.root } : b));
  assert(rigHash(moved, rig.geometry) !== before, 'reparenting a bone did not change the hash');
  const renamed = bones.map((b, i) => (i === 5 ? { ...b, key: `${b.key}_x` } : b));
  assert(rigHash(renamed, rig.geometry) !== before, 'renaming a bone did not change the hash');
});

console.log('\n--- tree helpers ---');

check('ancestors and descendants are consistent', () => {
  const { rig } = rigOf('pikachu');
  for (const b of rig.bones) {
    for (const a of ancestors(rig, b.key)) {
      assert(descendants(rig, a).includes(b.key), `${b.key} lists ${a} as an ancestor but is not below it`);
    }
  }
  assert(ancestors(rig, rig.root).length === 0, 'the root has ancestors');
});

check('isUnbrokenChain rejects gaps, reordering and strangers', () => {
  const { rig } = rigOf('rattata');
  const chain = rig.chains.find(c => c.bones.length >= 3);
  assert(chain, 'no chain of three to test with');
  assert(isUnbrokenChain(rig, chain.bones), 'a real chain was rejected');
  assert(!isUnbrokenChain(rig, [...chain.bones].reverse()), 'a reversed chain was accepted');
  assert(!isUnbrokenChain(rig, [chain.bones[0], chain.bones[2]]), 'a chain with a hole was accepted');
  assert(!isUnbrokenChain(rig, [chain.bones[0], 'nosuchbone']), 'a stranger was accepted');
  assert(!isUnbrokenChain(rig, []), 'an empty list was accepted');
  assert(isUnbrokenChain(rig, [chain.bones[0]]), 'a single bone was rejected');
});

check('restTRS fills defaults and flags a matrix node', () => {
  const plain = restTRS({});
  assert(JSON.stringify(plain.q) === '[0,0,0,1]', 'default rotation is not identity');
  assert(JSON.stringify(plain.s) === '[1,1,1]', 'default scale is not one');
  assert(restTRS({ matrix: new Array(16).fill(0) }).fromMatrix === true, 'a matrix node is not flagged');
  assert(restTRS(null).fromMatrix === undefined || restTRS(null).fromMatrix === false, 'null node flagged');
});

check('no Stadium model uses a matrix node, so rest TRS is never a lie', () => {
  let matrixNodes = 0;
  for (const e of every) for (const b of e.rig.bones) if (b.rest.fromMatrix) matrixNodes++;
  assert(matrixNodes === 0, `${matrixNodes} bones carry a matrix instead of TRS`);
});

console.log('\n--- frame counts and frame rates, measured rather than assumed ---');

check('every clip in the dex reports a frame count matching the manifest', () => {
  let compared = 0;
  for (const e of every) {
    for (let i = 0; i < e.rig.clips.length; i++) {
      assert(e.rig.clips[i].frames === e.s.clips[i].frames,
        `${e.s.slug} clip ${i}: measured ${e.rig.clips[i].frames} frames, manifest says ${e.s.clips[i].frames}`);
      compared++;
    }
  }
  console.log(`       ${compared} clips agree with the manifest on their length`);
});

check('the frame rate falls out of the keys, and comes to 30 everywhere', () => {
  // Nothing anywhere writes 30 down: the keys are uniformly spaced, so the rate is the key count over the
  // duration. A clip that was not 30fps would report its own rate rather than being played at the wrong
  // speed, which is the difference between a fact and an assumption that happens to hold.
  const rates = new Set();
  for (const e of every) {
    for (const clip of e.rig.clips) {
      if (clip.frames < 2) continue;
      assert(clip.fps > 0, `${e.s.slug} ${clip.name} reports no frame rate`);
      rates.add(Math.round(clip.fps * 100) / 100);
    }
  }
  assert(rates.size === 1 && rates.has(30), `frame rates found across the dex: ${[...rates].join(', ')}`);
});

console.log('\n--- failure behaviour ---');

check('a file with no skinned bones is refused clearly', () => {
  let msg = '';
  try { readRig({ nodes: [{ name: 'a' }], skins: [] }, new Uint8Array()); }
  catch (e) { msg = e.message; }
  assert(/no skinned bones/.test(msg), `unexpected message: ${msg}`);
});

check('a flat model is refused rather than divided by zero', () => {
  const { json, bin } = parseGLB(fs.readFileSync(`${DIR}/019_rattata.glb`));
  // Same file, but every skin removed: no pivots, so it must fail at the first gate not the second.
  let msg = '';
  try { readRig({ ...json, skins: [] }, bin); } catch (e) { msg = e.message; }
  assert(msg.length > 0, 'a model with no skins was accepted');
});

check('notes report oddities instead of throwing', () => {
  const noted = every.filter(e => e.rig.notes.length);
  for (const e of noted) assert(Array.isArray(e.rig.notes), `${e.s.slug} notes is not a list`);
  const dupNotes = noted.filter(e => e.rig.notes.some(n => /duplicated bone name/.test(n)));
  assert(dupNotes.length === 3, `${dupNotes.length} species note a duplicate name, expected 3`);
  console.log(`       ${noted.length} of 151 models have something worth noting`);
  const kinds = new Map();
  for (const e of noted) for (const n of e.rig.notes) {
    const k = n.replace(/[\d.()-]+/g, '#').slice(0, 46);
    kinds.set(k, (kinds.get(k) || 0) + 1);
  }
  for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`         ${String(n).padStart(3)}  ${k}`);
});

console.log(results.join('\n'));
console.log(failures ? `\n${failures} check(s) failed\n` : `\n${results.length} checks passed\n`);
process.exit(failures ? 1 : 0);
