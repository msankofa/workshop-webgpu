// test-bot-wound-attribution.mjs — does a shot actually reach a limb?
//
// Builds a real instanced rig headlessly, fires capsule-gated rays at it, and asserts where they
// land. The stand-in rigs in test-bot-wound/test-bot-limb-map cannot show hit distribution, which is
// what any per-limb threshold has to be set against.
//
// Run: node test-bot-wound-attribution.mjs

import * as THREE from 'three';
import { createProceduralPlayerBody } from './player-procedural-body.js';
import { buildLimbMap, limbForPart } from './bot-limb-map.js';
import { resolveBodyHit } from './bot-body-hit.js';
import { WOUND_DEFAULTS, createWoundState, applyLimbDamage, killingBlowSever } from './bot-wound.js';

let failures = 0;
function check(name, actual, expected) {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
}
function checkTrue(name, cond, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` -- ${detail}`}`);
}

// `batches` truthy = instanced mode, as bot-viewer-v3 builds it. Mesh mode has no parts.all at all.
const scene = new THREE.Scene();
const body = createProceduralPlayerBody({
  THREE, scene, terrainHeight: () => 0, mode: 'remote',
  style: { shell: 0x336699, plate: 0x222222, trim: 0x0a0d0a, accent: 0xff8800 },
  adaptGaitToSpeed: true, movementDynamics: true, naturalLocomotion: true,
  batches: {},
});
// Feet on the ground: v3 feeds the capsule midpoint, which for a 1.8 m bot of radius 0.3 is 0.9.
for (let i = 0; i < 8; i++) {
  body.update(1 / 60, {
    position: { x: 0, y: 0.9, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, onFloor: true,
    crouch: 0, kneel: 0, prone: 0, height: 1.8, radius: 0.3, yaw: Math.PI, aimPitch: 0, alive: true,
  });
}
body.group.updateMatrixWorld(true);

// ---- 1. the map covers the rig ----
const map = buildLimbMap(body);
checkTrue('rig: an instanced body exposes parts.all', Array.isArray(body.parts?.all) && body.parts.all.length > 0,
  `got ${body.parts?.all}`);
const unmapped = body.parts.all.filter((p) => !map.has(p));
check('rig: every part resolveBodyHit can return has a limb', unmapped.length, 0);
const byLimb = {};
for (const [, e] of map) byLimb[e.limb] = (byLimb[e.limb] || 0) + 1;
for (const limb of ['head', 'core', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg']) {
  checkTrue(`rig: ${limb} has parts in the map`, (byLimb[limb] || 0) > 0, `${byLimb[limb] || 0}`);
}

// ---- 2. rays reach the limbs they are aimed at ----
// A ray from a muzzle-height origin at a named target height should name the obvious part.
function shootAt(originY, targetY, dx = 0, fromX = 0, dist = 8) {
  const origin = new THREE.Vector3(fromX + dx, originY, -dist);
  const dir = new THREE.Vector3(0, targetY - originY, dist).normalize();
  const hit = resolveBodyHit({ THREE, body, origin, dir, refresh: false });
  return hit ? (limbForPart(map, hit.part)?.limb ?? 'unmapped') : null;
}
// Offset sideways: dead centre at knee height passes BETWEEN the legs and finds nothing, which is
// itself worth knowing — the rig has real gaps the capsule does not.
check('aim: a shot at knee height names a leg', /Leg$/.test(shootAt(1.4, 0.55, 0.12) || ''), true);
check('aim: dead centre at knee height passes between them', shootAt(1.4, 0.55), null);
check('aim: a shot at chest height names the core', shootAt(1.4, 1.35), 'core');
check('aim: a shot above the shoulders names the head', shootAt(1.4, 1.95), 'head');

// ---- 3. the distribution, which is the whole point ----
// Gated on the capsule bullets test against (start 0.3, end 1.5, r 0.3): a ray that misses it never
// reaches the rig trace in the game either, and without the gate the head reads 4x too reachable.
const CAP_A = new THREE.Vector3(0, 0.3, 0), CAP_B = new THREE.Vector3(0, 1.5, 0), CAP_R = 0.3;
const _ab = new THREE.Vector3(), _p = new THREE.Vector3(), _w = new THREE.Vector3(), _c = new THREE.Vector3();
function passesCapsule(o, d) {
  _ab.subVectors(CAP_B, CAP_A);
  for (let t = 0; t <= 1.0001; t += 0.01) {
    _p.copy(CAP_A).addScaledVector(_ab, t);
    const proj = _w.subVectors(_p, o).dot(d);
    if (proj < 0) continue;
    if (_c.copy(o).addScaledVector(d, proj).distanceTo(_p) <= CAP_R) return true;
  }
  return false;
}
function sweep(originY, dist) {
  const tally = {};
  let gated = 0, found = 0;
  for (let dx = -0.5; dx <= 0.5001; dx += 0.04) {
    for (let ty = 0.1; ty <= 2.1001; ty += 0.04) {
      const origin = new THREE.Vector3(dx, originY, -dist);
      const dir = new THREE.Vector3(0, ty - originY, dist).normalize();
      if (!passesCapsule(origin, dir)) continue;
      gated++;
      const hit = resolveBodyHit({ THREE, body, origin, dir, refresh: false });
      if (!hit) continue;
      found++;
      const l = limbForPart(map, hit.part)?.limb ?? 'unmapped';
      tally[l] = (tally[l] || 0) + 1;
    }
  }
  const share = {};
  for (const k of Object.keys(tally)) share[k] = tally[k] / found;
  return { gated, found, share };
}
const s = sweep(1.4, 8);
console.log(`\n     ${s.found} of ${s.gated} capsule-passing rays find the rig; share by limb:`);
for (const [k, v] of Object.entries(s.share).sort((a, b) => b[1] - a[1])) {
  console.log(`       ${k.padEnd(9)} ${(v * 100).toFixed(1)}%`);
}
console.log('');

checkTrue('shape: the capsule is fatter than the body, so some hits find nothing',
  s.found < s.gated, `${s.found}/${s.gated}`);
checkTrue('shape: the torso takes most of the fire', (s.share.core ?? 0) > 0.5, `${s.share.core}`);
checkTrue('shape: an arm takes almost none of it',
  (s.share.leftArm ?? 0) < 0.05 && (s.share.rightArm ?? 0) < 0.05,
  `${s.share.leftArm} / ${s.share.rightArm}`);

// ---- 4. the accumulator alone cannot fire ----
{
  const BOT_HEALTH = 100;
  const armBudget = BOT_HEALTH * (s.share.leftArm ?? 0);
  checkTrue('reach: an arm cannot fill its threshold in a bot\'s whole lifetime',
    armBudget < WOUND_DEFAULTS.armThreshold,
    `${armBudget.toFixed(1)} of a ${WOUND_DEFAULTS.armThreshold} threshold`);
  console.log(`     (an arm expects ${armBudget.toFixed(1)} damage across all 100 health; the threshold is ${WOUND_DEFAULTS.armThreshold})`);

  // Hence killingBlowSever.
  const w = createWoundState();
  applyLimbDamage(w, 'leftArm', armBudget);
  check('reach: the accumulator is nowhere near severing at that budget', w.severed.leftArm ?? false, false);
  check('reach: the killing blow takes it anyway', killingBlowSever(w, 'leftArm'), 'leftArm');
}

console.log(failures === 0 ? '\nAll attribution checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
