import * as THREE from 'file:///C:/Users/msankofa/.claude/tools/node_modules/three/build/three.module.js';
globalThis.document = { createElementNS: () => ({ addEventListener() {}, style: {}, set src(_v) {} }) };
const { createRQ170SentinelModel } = await import('./factory.mjs');
const m = createRQ170SentinelModel({}); m.updateMatrixWorld(true);
m.traverse((o) => {
  if (!o.isMesh || !/Wing \(starboard\)/.test(o.name)) return;
  const p = o.geometry.attributes.position; const rows = [];
  for (let i = 0; i < p.count; i++) { const v = new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); rows.push({ i, x: v.x, y: v.y, a: v.z + 3.7 }); }
  // front-most vertex per 0.1 m x bin near the root
  const bins = new Map();
  for (const r of rows) { if (r.x < -0.5 || r.x > 2.6) continue; const k = Math.round(r.x * 10) / 10; if (!bins.has(k) || r.a < bins.get(k).a) bins.set(k, r); }
  for (const k of [...bins.keys()].sort((a, b) => a - b)) { const r = bins.get(k); console.log(`x=${k.toFixed(1)} frontmost a=${r.a.toFixed(2)} (vertex ${r.i}, y=${r.y.toFixed(2)})  LE target ${(0.638 * Math.abs(k)).toFixed(2)}`); }
});
