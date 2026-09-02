// Headless measurement of the generated factory: bounds, per-part boxes, NaN scan, triangle count.
import * as THREE from 'file:///C:/Users/msankofa/.claude/tools/node_modules/three/build/three.module.js';
globalThis.document = { createElementNS: () => ({ addEventListener() {}, style: {}, set src(_v) {} }) };
const mod = await import('./factory.mjs');
const create = Object.values(mod).find((v) => typeof v === 'function' && /^create.*Model$/.test(v.name));
if (!create) throw new Error('no create* export in factory.mjs: ' + Object.keys(mod).join(', '));
const model = create({});
model.updateMatrixWorld(true);
const size = new THREE.Vector3();
const box = new THREE.Box3().setFromObject(model); box.getSize(size);
let tris = 0, bad = 0;
model.traverse((o) => {
  if (!o.isMesh) return;
  const g = o.geometry, p = g.attributes.position;
  tris += (g.index ? g.index.count : p.count) / 3;
  for (let i = 0; i < p.array.length; i++) if (!Number.isFinite(p.array[i])) bad++;
  const b = new THREE.Box3().setFromObject(o);
  const f = (v) => v.toFixed(2);
  console.log(`${o.name.padEnd(22)} x[${f(b.min.x)},${f(b.max.x)}] y[${f(b.min.y)},${f(b.max.y)}] z[${f(b.min.z)},${f(b.max.z)}] tris=${(g.index ? g.index.count : p.count) / 3}`);
});
console.log(`TOTAL span=${size.x.toFixed(3)} height=${size.y.toFixed(3)} length=${size.z.toFixed(3)} ratio=${(size.x / size.z).toFixed(2)} tris=${tris} nan=${bad}`);
console.log(`nose z=${box.min.z.toFixed(2)} tail z=${box.max.z.toFixed(2)}`);
