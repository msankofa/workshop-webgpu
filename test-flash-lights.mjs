// flash-lights.js: the dynamic-light budget extracted from bot-viewer-visuals.js. Headless: a real
// THREE scene, no renderer. The scoring math itself is bot-viewer-visuals-style.js's, tested here
// only through the pool behaviour.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createFlashLights, FLASH_DEFAULTS, BLAST_FLASH } from './flash-lights.js';

let pass = 0, fail = 0;
const ok = (condition, message) => { if (condition) pass++; else { fail++; console.error('FAIL:', message); } };

const scene = new THREE.Scene();
const view = new THREE.Vector3(0, 2, 0);
const fl = createFlashLights({ THREE, scene, getViewPosition: () => view, count: 2, cap: 8 });

ok(fl.lights.length === 2 && fl.lights.every(l => l.isPointLight && l.intensity === 0 && l.parent === scene), 'two resident point lights idle in the scene at intensity 0');
fl.update(0.016);
ok(fl.lights.every(l => l.intensity === 0), 'no flashes: every slot stays dark');

fl.flash({ x: 1, y: 1, z: 0 });
fl.update(0.0);
ok(fl.lights[0].intensity > 0 && fl.lights[0].position.x === 1, 'a flash lights a slot at its position');
ok(fl.lights.every(l => l.visible !== false), 'visibility is never toggled (WebGPU pipeline-hash rule)');

// Three flashes, two slots: the near/bright pair wins.
fl.flash({ x: 0, y: 1, z: -1 }, { intensity: 100 });
fl.flash({ x: 0, y: 1, z: -2 }, { intensity: 90 });
fl.flash({ x: 200, y: 1, z: 0 }, { intensity: 10 });
fl.update(0.0);
const lit = fl.lights.filter(l => l.intensity > 0);
ok(lit.length === 2 && lit.every(l => l.position.x < 100), 'with more flashes than slots the brightest nearby pair holds the lights');

// Expiry: after the life passes every slot returns to 0.
fl.update(1.0);
ok(fl.lights.every(l => l.intensity === 0), 'expired flashes release their slots');

// The ring overwrites the oldest record instead of allocating.
for (let i = 0; i < 20; i++) fl.flash({ x: i, y: 1, z: 0 }, { life: 1 });
fl.update(0.0);
ok(fl.lights.filter(l => l.intensity > 0).length === 2, 'a burst past the ring cap still fills exactly the slot count');

// Blast profile carries v3's numbers.
ok(BLAST_FLASH.intensity === 140 && BLAST_FLASH.life === 0.28 && FLASH_DEFAULTS.intensity > 0, 'blast and gunshot profiles are the authored ones');

fl.dispose();
ok(fl.lights.length === 0 && scene.children.every(c => !c.isPointLight), 'dispose removes the lights');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
