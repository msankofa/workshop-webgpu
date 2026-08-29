// node test-depth-of-field.mjs — the DoF gather builds to a shader headless, and focus eases on the CPU.
import * as THREE from 'three/webgpu';
import { pass } from 'three/tsl';
import { buildMaterial } from './tsl-build-check.mjs';
import { createDepthOfField, DOF_DEFAULTS } from './depth-of-field.js';

let pass_ = 0, fail = 0;
const ok = (c, m) => { if (c) pass_++; else { fail++; console.error('FAIL:', m); } };

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
const scenePass = pass(scene, camera);
let threw = false;
try { createDepthOfField({ scenePass }); } catch { threw = true; }
ok(threw, 'missing camera is a loud error, not a silently wrong depth');
const dof = createDepthOfField({ scenePass, camera, params: { taps: 16 } });
const material = new THREE.NodeMaterial();
material.colorNode = dof.node;
let built = null, error = null;
try { built = await buildMaterial(material); } catch (e) { error = e; }
ok(built && built.fragment.length > 200, `DoF node builds to a fragment shader (${error ? error.message : built.fragment.length + ' chars'})`);
ok(built && /2\.39996|2\.4/.test(built.fragment), 'golden-angle spiral is in the shader');
ok(built && (built.fragment.includes('textureLod') || built.fragment.includes('textureSampleLevel')), 'gather taps use explicit LOD (legal inside the early-out branch)');
ok(dof.uniforms.sceneNear.value === camera.near && dof.uniforms.sceneFar.value === camera.far,
  'depth linearizes with the scene camera planes, not the post quad camera');

ok(dof.uniforms.enabled.value === 0 && dof.uniforms.focusSmoothed.value === DOF_DEFAULTS.focusDistance, 'defaults: off, focus at the default distance');
dof.setParams({ enabled: true, aperture: 1.4, maxRadius: 20, autoFocus: false, focusDistance: 3 });
ok(dof.uniforms.enabled.value === 1 && dof.uniforms.aperture.value === 1.4 && dof.uniforms.maxRadius.value === 20 && dof.uniforms.autoFocus.value === 0 && dof.uniforms.focusDistance.value === 3, 'setParams writes the uniforms');
let f = 0;
for (let i = 0; i < 120; i++) f = dof.updateFocus(1 / 60, 12);
ok(Math.abs(f - 12) < 0.05, `auto focus eases toward the measured distance (${f.toFixed(2)})`);
const before = dof.uniforms.focusSmoothed.value;
dof.updateFocus(1 / 60, NaN);
ok(dof.uniforms.focusSmoothed.value === before, 'a missing measurement leaves the focus alone');

console.log(`\n${pass_} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
