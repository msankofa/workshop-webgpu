// Identify the parts of an edited UGV GLB by size and position, since Blender drops node names.
import fs from 'node:fs';
const file = process.argv[2] || 'export/ugv-2.glb';
const buf = fs.readFileSync(file);
const jsonLen = buf.readUInt32LE(12);
const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
const binOff = 20 + jsonLen + 8;

const nodes = gltf.nodes;
const world = new Array(nodes.length).fill(null);
const walk = (i, px, py, pz) => {
  const n = nodes[i], t = n.translation || [0, 0, 0];
  const p = [px + t[0], py + t[1], pz + t[2]];
  world[i] = p;
  for (const c of n.children || []) walk(c, ...p);
};
for (const r of gltf.scenes[0].nodes) walk(r, 0, 0, 0);

const parts = [];
nodes.forEach((n, i) => {
  if (n.mesh === undefined) return;
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  let tris = 0;
  for (const p of gltf.meshes[n.mesh].primitives) {
    const a = gltf.accessors[p.attributes.POSITION];
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], a.min[k]); hi[k] = Math.max(hi[k], a.max[k]); }
    tris += (p.indices !== undefined ? gltf.accessors[p.indices].count : a.count) / 3;
  }
  const size = hi.map((h, k) => h - lo[k]);
  const c = world[i].map((w, k) => w + (lo[k] + hi[k]) / 2);
  parts.push({ node: n.name, i, size, c, tris, vol: size[0] * size[1] * size[2], lowY: world[i][1] + lo[1] });
});

const f = (v) => v.map(x => x.toFixed(2).padStart(6)).join(' ');
parts.sort((a, b) => b.vol - a.vol);
console.log('name'.padEnd(14), 'centre x,y,z'.padEnd(21), 'size w,h,l'.padEnd(21), 'tris');
for (const p of parts) console.log(p.node.padEnd(14), f(p.c), ' ', f(p.size), ' ', Math.round(p.tris));

// Wheels: the four lowest lumps whose width and height are within a tenth of each other.
const round = parts.filter(p => Math.abs(p.size[1] - p.size[2]) < p.size[1] * 0.25 && p.c[1] < 0.6);
console.log('\nwheel candidates:', round.map(p => `${p.node}(${p.c.map(v=>v.toFixed(2))})`).join(' '));
const xs = round.map(p => Math.abs(p.c[0])), zs = round.map(p => Math.abs(p.c[2]));
if (round.length) console.log('track', (2 * Math.max(...xs)).toFixed(3), 'wheelbase', (2 * Math.max(...zs)).toFixed(3));
const top = [...parts].sort((a, b) => b.c[1] - a.c[1]).slice(0, 6);
console.log('\nhighest six:', top.map(p => `${p.node} y=${p.c[1].toFixed(2)} z=${p.c[2].toFixed(2)}`).join('\n              '));

console.log('\nlowest edges:');
for (const p of [...parts].sort((a, b) => a.lowY - b.lowY).slice(0, 4))
  console.log(' ', p.node, 'bottom y', p.lowY.toFixed(3));
console.log('\nmaterials per mesh (a join shows as many primitives):');
for (const p of parts.slice(0, 6))
  console.log(' ', p.node, gltf.meshes[nodes[p.i].mesh].primitives.length, 'primitive(s)');
