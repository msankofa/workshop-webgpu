// The parts inventory in docs/vehicle-parts.md is what a model exported for Blender is named by,
// so a part quietly vanishing or being renamed has to fail here rather than in a modelling session.
import fs from 'node:fs';
import { CRAFT_KINDS } from './flight-meshes.js';
import { vehicleParts } from './bake-vehicle-parts.mjs';

let failed = 0;
const check = (ok, what) => { if (!ok) { console.log('FAIL:', what); failed++; } };

const doc = fs.readFileSync('docs/vehicle-parts.md', 'utf8');
const documented = new Map();
let kind = null;
for (const line of doc.split('\n')) {
  const h = line.match(/^## (\S+)/);
  if (h) { kind = h[1]; documented.set(kind, new Set()); continue; }
  const row = line.match(/^\| `([^`]+)` \|/);
  if (row && kind) documented.get(kind).add(row[1]);
}

for (const k of CRAFT_KINDS) {
  const parts = vehicleParts(k);
  const built = new Set(parts.map(p => p.name));
  check(documented.has(k), `${k} appears in docs/vehicle-parts.md`);
  check(!built.has('(unnamed)'), `every ${k} part is named — an unnamed one exports as Mesh_N`);
  check(built.size === parts.length, `${k} part names are unique`);
  const doced = documented.get(k) || new Set();
  for (const n of doced) check(built.has(n), `${k} still builds the documented part '${n}'`);
  for (const n of built) check(doced.has(n), `${k} part '${n}' is in the doc (run bake-vehicle-parts.mjs)`);
}

console.log(failed ? `\n${failed} assertion(s) failed` : 'vehicle parts: all assertions passed');
process.exit(failed ? 1 : 0);
