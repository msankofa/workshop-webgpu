import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createFloraOcclusion, OCCLUDER_LAYER } from './flora-occlusion.js';

const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(70, 1.6, 0.1, 1000);
const root = new THREE.Group();
const wall = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
root.add(wall); scene.add(root);
scene.background = new THREE.Color(0x223344);
scene.fog = new THREE.Fog(0x334455, 1, 100);
const original = { target: {}, color: new THREE.Color(0x556677), alpha: 0.4,
  background: scene.background, fog: scene.fog, override: scene.overrideMaterial };
let target = original.target, color = original.color.clone(), alpha = original.alpha, fail = false;
const renderer = {
  getRenderTarget: () => target, setRenderTarget: v => { target = v; },
  getClearColor: v => v.copy(color), getClearAlpha: () => alpha,
  setClearColor: (v, a) => { color.copy(v); alpha = a; },
  render: () => { if (fail) throw new Error('render failed'); },
};
const occ = createFloraOcclusion({ scene, camera, renderer, cacheStatic: true });
assert.equal(occ.markOccluders(root), 1);
// A filter keeps a root's shader-placed meshes (clipmap rings) out of the depth image.
const ring = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()); ring.name = 'terrain-clipmap-ring-0'; root.add(ring);
assert.equal(occ.markOccluders(root, (o) => !o.name.startsWith('terrain-clipmap')), 1);
assert.ok(!ring.layers.isEnabled(OCCLUDER_LAYER)); root.remove(ring);
assert.ok(wall.layers.isEnabled(OCCLUDER_LAYER));
assert.equal(occ.update(), true);
assert.equal(occ.state.revision, 1);
for (let i = 0; i < 120; i++) assert.equal(occ.update(), false);
assert.equal(occ.stats.renders, 1);
camera.position.x = 0.001;
assert.equal(occ.update(), true, 'even sub-cell translation updates occlusion');
camera.rotation.y = 0.001;
assert.equal(occ.update(), true, 'small rotations are not throttled');
camera.fov = 60; camera.updateProjectionMatrix();
assert.equal(occ.update(), true);
root.position.x = 10;
assert.equal(occ.update(), true, 'rebasing the static root invalidates the image');
root.visible = false;
assert.equal(occ.update(), true);
occ.markOccluders(root);
assert.equal(occ.update(), true, 'explicit geometry edits invalidate even at the same camera');
occ.setEnabled(false);
assert.equal(occ.update(), false);
occ.setEnabled(true);
assert.equal(occ.update(), true);
const revision = occ.state.revision;
occ.invalidate(); fail = true;
assert.throws(() => occ.update(), /render failed/);
assert.equal(occ.state.revision, revision);
assert.equal(target, original.target);
assert.ok(color.equals(original.color)); assert.equal(alpha, original.alpha);
assert.equal(scene.background, original.background); assert.equal(scene.fog, original.fog);
assert.equal(scene.overrideMaterial, original.override);
fail = false;
assert.equal(occ.update(), true, 'a failed render is retried');
assert.equal(occ.update(), false);
occ.dispose();
const dynamic = createFloraOcclusion({ scene, camera, renderer });
assert.equal(dynamic.update(), true); assert.equal(dynamic.update(), true,
  'other hosts retain their per-frame behavior unless they opt into static caching');
dynamic.dispose(); wall.geometry.dispose(); wall.material.dispose();
console.log('flora occlusion cache and failure-restoration checks passed');
