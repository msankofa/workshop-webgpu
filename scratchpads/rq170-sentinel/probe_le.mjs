import * as THREE from 'file:///C:/Users/msankofa/.claude/tools/node_modules/three/build/three.module.js';
globalThis.document = { createElementNS: () => ({ addEventListener() {}, style: {}, set src(_v) {} }) };
const { createRQ170SentinelModel } = await import('./factory.mjs');
const m = createRQ170SentinelModel({}); m.updateMatrixWorld(true);
const NOSE = -3.7;
m.traverse((o) => {
  if (!o.isMesh || !/Wing \(starboard\)|Centre body/.test(o.name)) return;
  const p = o.geometry.attributes.position; const bins = {};
  for (let i = 0; i < p.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
    const k = Math.round(v.x * 2) / 2; if (k < 0) continue;
    const b = bins[k] || (bins[k] = { zmin: 1e9, zmax: -1e9, ymin: 1e9, ymax: -1e9 });
    b.zmin = Math.min(b.zmin, v.z); b.zmax = Math.max(b.zmax, v.z); b.ymin = Math.min(b.ymin, v.y); b.ymax = Math.max(b.ymax, v.y);
  }
  console.log('--', o.name);
  for (const k of Object.keys(bins).map(Number).sort((a, b) => a - b))
    if (k % 1 === 0 || k > 9) console.log(`x=${k.toFixed(1)} LE a=${(bins[k].zmin - NOSE).toFixed(2)} TE a=${(bins[k].zmax - NOSE).toFixed(2)} y[${bins[k].ymin.toFixed(2)},${bins[k].ymax.toFixed(2)}]`);
});
