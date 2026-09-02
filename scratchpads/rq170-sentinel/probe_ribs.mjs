// Print each wing ring's front and back end (min/max z vertex) so the rib ends can be checked against LE/TE.
import * as THREE from 'file:///C:/Users/msankofa/.claude/tools/node_modules/three/build/three.module.js';
globalThis.document = { createElementNS: () => ({ addEventListener() {}, style: {}, set src(_v) {} }) };
const { createRQ170SentinelModel } = await import('./factory.mjs');
const m = createRQ170SentinelModel({}); m.updateMatrixWorld(true);
m.traverse((o) => {
  if (!o.isMesh || !/Wing \(starboard\)/.test(o.name)) return;
  const p = o.geometry.attributes.position; console.log('vertices', p.count, 'indexed', !!o.geometry.index);
  const ring = 24;
  for (let r = 0; r * ring < p.count; r++) {
    let front = null, back = null;
    for (let j = 0; j < ring && r * ring + j < p.count; j++) {
      const v = new THREE.Vector3().fromBufferAttribute(p, r * ring + j).applyMatrix4(o.matrixWorld);
      if (!front || v.z < front.z) front = v; if (!back || v.z > back.z) back = v;
    }
    console.log(`ring ${r}: front x=${front.x.toFixed(2)} a=${(front.z + 3.7).toFixed(2)}  back x=${back.x.toFixed(2)} a=${(back.z + 3.7).toFixed(2)}`);
  }
});
