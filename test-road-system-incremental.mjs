import * as THREE from 'three';
import { createRoadSystem } from './roads.js';

let failed = 0;
const ok = (condition, message) => { if (!condition) { failed++; console.error('FAIL:', message); } };
const p = (x, z) => ({ x, y: 0, z });

const roads = createRoadSystem({ parent: new THREE.Group(), heightAt: () => 0,
  options: { surfaceCell: 2, residencyRadius: Infinity } });
const [first] = roads.network.addRoadPath([p(0, 0), p(20, 0)], 3);
roads.rebuild();
const initialPending = roads.pendingBuilds;
roads.update();
ok(initialPending >= 3 && roads.residentEdgeCount === 1, 'one update builds one queued edge, not the whole network');
for (let i = 0; i < 10; i++) roads.update();
ok(roads.pendingBuilds === 0 && roads.residentNodeCount === 2, 'later updates drain node patches');
roads.rebuild();
ok(roads.pendingBuilds === 0, 'an unchanged rebuild enqueues nothing');

roads.network.addRoadPath([p(100, 0), p(120, 0)], 3);
roads.setResidency(10, 0, 35);
for (let i = 0; i < 10; i++) roads.update();
ok(roads.residentEdgeCount === 1, 'residency keeps only nearby edge meshes');

roads.network.deleteEdge(first);
roads.update();
ok(roads.residentEdgeCount === 0, 'deleting an edge disposes only its resident meshes');
roads.dispose();

console.log(`incremental road system: ${failed ? `${failed} failed` : 'all pass'}`);
process.exit(failed ? 1 : 0);
