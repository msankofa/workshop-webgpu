import * as THREE from 'three';

let failed = 0;
const ok = (condition, message) => { if (!condition) { failed++; console.error('FAIL:', message); } };

class FakeProjectionWorker {
  static batches = [];
  constructor() { this.onmessage = null; this.onerror = null; }
  postMessage(message) {
    FakeProjectionWorker.batches.push(message);
    queueMicrotask(() => {
      const edges = message.edges.map(edge => ({
        edgeId: edge.edgeId, edgeRevision: edge.edgeRevision,
        surfaces: edge.surfaces.map(surface => {
          const normals = new Float32Array(surface.positions.length);
          for (let i = 0; i < surface.positions.length; i += 3) {
            surface.positions[i + 1] = 5.01;
            normals[i + 1] = 1;
          }
          return { ...surface, normals };
        }),
      }));
      this.onmessage?.({ data: { jobType: message.jobType, batchId: message.batchId,
        terrainEpoch: message.terrainEpoch, edges } });
    });
  }
  terminate() {}
}

globalThis.Worker = FakeProjectionWorker;
const { createRoadSystem } = await import('./roads.js');
const p = (x, z) => ({ x, y: 0, z });
const descriptor = { contractVersion: 1, kind: 'analytic', key: 'projection-test',
  sourceVersion: '1', algorithmVersion: '1', bounds: null, capabilities: ['infinite'], config: {}, seaLevel: 0 };
const roads = createRoadSystem({ parent: new THREE.Group(), heightAt: () => 0, options: {
  surfaceCell: 2, residencyRadius: 30, terrainDescriptor: () => descriptor, terrainEpoch: () => 7,
} });
const [near] = roads.network.addRoadPath([p(0, 0), p(20, 0)], 3);
roads.network.addRoadPath([p(100, 0), p(120, 0)], 3);
roads.rebuild();
roads.update();
await new Promise(resolve => setTimeout(resolve, 0));

ok(FakeProjectionWorker.batches.length === 1 && FakeProjectionWorker.batches[0].edges.length === 1,
  'a worker batch contains only the edge inside the residency ring');
ok(FakeProjectionWorker.batches[0].edges[0].edgeId === near, 'the resident edge is the projected edge');
ok(roads.residentEdgeCount === 1, 'the returned resident edge installs on the main thread');
const core = roads.group.children.find(child => child.name === `road-core-${near}`);
ok(core && Math.abs(core.geometry.getAttribute('position').getY(0) - 5.01) < 1e-5,
  'installation uses the worker-returned projected positions');
ok(core && core.geometry.getAttribute('normal').getY(0) === 1,
  'installation uses the worker-returned density normals');

roads.dispose();

const staleRoads = createRoadSystem({ parent: new THREE.Group(), heightAt: () => 0, options: {
  surfaceCell: 2, residencyRadius: 30, terrainDescriptor: () => descriptor, terrainEpoch: () => 7,
} });
staleRoads.network.addRoadPath([p(0, 0), p(20, 0)], 3);
staleRoads.rebuild();
staleRoads.update();                         // dispatch while the edge is resident
staleRoads.setResidency(500, 0, 30);
staleRoads.update();                         // remove it before the worker microtask answers
await new Promise(resolve => setTimeout(resolve, 0));
ok(staleRoads.residentEdgeCount === 0,
  'a worker answer is discarded when its edge leaves residency before installation');
staleRoads.dispose();

delete globalThis.Worker;
console.log(`road projection queue: ${failed ? `${failed} failed` : 'all pass'}`);
process.exit(failed ? 1 : 0);
