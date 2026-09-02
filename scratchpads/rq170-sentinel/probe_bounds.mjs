import * as THREE from 'file:///C:/Users/msankofa/.claude/tools/node_modules/three/build/three.module.js';
globalThis.document = { createElementNS: () => ({ addEventListener() {}, style: {}, set src(_v) {} }) };
const { createRQ170SentinelModel } = await import('./factory.mjs');
const m = createRQ170SentinelModel({}); m.updateMatrixWorld(true);
m.traverse((o) => {
  if (!o.isMesh || !/Centre body/.test(o.name)) return;
  const p = o.geometry.attributes.position; const b = new THREE.Box3().setFromBufferAttribute(p);
  let onFace = 0;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (Math.abs(x - b.min.x) < 1e-3 || Math.abs(x - b.max.x) < 1e-3 || Math.abs(z - b.min.z) < 1e-3 || Math.abs(z - b.max.z) < 1e-3 || Math.abs(y - b.max.y) < 1e-3) onFace++; }
  console.log('root verts', p.count, 'box', b.min.toArray().map(v=>v.toFixed(2)), b.max.toArray().map(v=>v.toFixed(2)), 'verts on box faces', onFace);
});
