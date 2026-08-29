// Could a per-bone animation mask be expressed in the bone keys everything else already uses?
//
// Two things decide it. Does every clip track name a bone the rig knows? And do node names repeat, which
// is what would stop a THREE track name (which is a node NAME) from identifying one bone.
import fs from 'node:fs';
import { readRigFromGLB } from './pokemon-rig.js';

const files = fs.readdirSync('models/stadium').filter(f => f.endsWith('.glb')).sort();
const dexList = () => files.map(f => ({ file: f, name: f.replace(/\.glb$/, '') }));

let dupSpecies = 0, dupBones = 0, species = 0, clips = 0, tracks = 0, orphanTracks = 0;
const examples = [];

for (const e of dexList()) {
  let read;
  try { read = readRigFromGLB(fs.readFileSync(`models/stadium/${e.file}`)); }
  catch { continue; }
  const { rig } = read;
  species++;
  const known = new Set(rig.bones.map(b => b.key));
  if (rig.duplicates?.length) {
    dupSpecies++;
    dupBones += rig.duplicates.length;
    if (examples.length < 5) examples.push(`${e.name}: ${rig.duplicates.slice(0, 3).join(', ')}`);
  }
  for (const c of rig.clips) {
    clips++;
    for (const t of c.tracks) {
      tracks++;
      if (!known.has(t.bone)) orphanTracks++;
    }
  }
}

// THREE binds an animation track by NODE NAME, and GLTFLoader sanitizes those names on the way in
// (whitespace to underscore, and [ ] . : / removed). A bone key is the raw glTF name. Where the two differ,
// a mask keyed on bone names would quietly miss.
const reserved = /[\\[\]\.:\/]/g;
const sanitize = (n) => n.replace(/\s/g, '_').replace(reserved, '');
let renamed = 0, shadowed = 0;
const renamedEg = [], shadowEg = [];
for (const e of dexList()) {
  let json;
  try {
    const buf = fs.readFileSync(`models/stadium/${e.file}`);
    const len = buf.readUInt32LE(12);
    json = JSON.parse(buf.slice(20, 20 + len).toString('utf8'));
  } catch { continue; }
  let rig;
  try { rig = readRigFromGLB(fs.readFileSync(`models/stadium/${e.file}`)).rig; } catch { continue; }
  const boneNames = new Set(rig.bones.map(b => b.key));
  for (const b of rig.bones) {
    if (sanitize(b.key) !== b.key) { renamed++; if (renamedEg.length < 5) renamedEg.push(`${e.name}: "${b.key}"`); }
  }
  // A non-bone node sharing a bone's name: THREE could bind the track to the wrong object.
  (json.nodes || []).forEach((n, i) => {
    if (!n.name || !boneNames.has(n.name)) return;
    if (rig.bones.some(b => b.node === i)) return;
    shadowed++;
    if (shadowEg.length < 5) shadowEg.push(`${e.name}: "${n.name}" is also node ${i}`);
  });
}

console.log(`${species} species, ${clips} clips, ${tracks} tracks`);
console.log(`bone names THREE would rename: ${renamed}`);
for (const x of renamedEg) console.log(`  ${x}`);
console.log(`non-bone nodes sharing a bone's name: ${shadowed}`);
for (const x of shadowEg) console.log(`  ${x}`);
console.log(`tracks naming a bone the rig does not have: ${orphanTracks}`);
console.log(`species with repeated node names: ${dupSpecies} (${dupBones} names)`);
for (const x of examples) console.log(`  ${x}`);

// How much of a body does one clip actually drive? A mask is only interesting if clips leave bones alone
// already, or if the bones you want to take over are a small part of the whole.
const { rig } = readRigFromGLB(fs.readFileSync('models/stadium/007_squirtle.glb'));
console.log(`\nsquirtle: ${rig.bones.length} bones`);
for (const c of rig.clips) {
  const paths = new Set(c.tracks.map(t => t.path));
  console.log(`  ${c.name.padEnd(14)} drives ${String(c.bones.length).padStart(2)}/${rig.bones.length} bones, paths: ${[...paths].join(' ')}`);
}
