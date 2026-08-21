import fs from 'node:fs';

const source = fs.readFileSync(new URL('./water.js', import.meta.url), 'utf8');
let failures = 0;
function check(condition, message) {
  if (condition) console.log('ok  ', message);
  else { console.error('FAIL', message); failures++; }
}

check(source.includes('function toGeometry(existing = null)'), 'ring jobs accept an existing geometry');
check(source.includes('job.toGeometry(ring?.geometry || null)'), 'ring commits reuse their slot geometry');
check(source.includes('THREE.DynamicDrawUsage'), 'pooled attributes are marked dynamic');
check(source.includes('2 ** Math.ceil(Math.log2'), 'buffer capacity grows geometrically');
check(source.includes('g.setDrawRange(0, indexCount)'), 'pooled index buffers draw only live indices');
check(source.includes('ringResourceStats.geometryReuses++'), 'reuse is exposed in runtime stats');
check(!source.includes('removeRingMeshes(oldRing, true)'), 'snap commits do not dispose replaced geometry');
check(source.includes('ring.mesh.visible = hasWater'), 'dry-to-wet changes reuse mesh visibility');

if (failures) process.exit(1);
console.log('all passing');
