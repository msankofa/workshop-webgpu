// node test-weapon-mount.mjs — weapon-mount.js against a headless procedural body.
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { createProceduralPlayerBody } from './player-procedural-body.js';
import { createWeaponMountSystem, defaultReloadSequence } from './weapon-mount.js';
import { getWeapon } from './weapons.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const anchors = JSON.parse(readFileSync('./weapon-anchors.json', 'utf8'));
const poses = JSON.parse(readFileSync('./weapon-poses.json', 'utf8'));

// Fake GLB sized like the real CZ (its raw anchors span z -15..6), so the baked anchors land on it.
function fakeGLB() {
  const scene = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.5, 5, 22), new THREE.MeshBasicMaterial());
  mesh.position.set(0, 0, -4.5);
  scene.add(mesh);
  return Promise.resolve({ scene });
}

const scene = new THREE.Scene();
const terrainHeight = () => 0;
const body = createProceduralPlayerBody({ THREE, scene, terrainHeight, mode: 'remote' });
const armTargets = {};
const origSet = body.setArmTarget;
body.setArmTarget = (side, t) => { armTargets[side] = t ? { position: t.position.clone?.() ?? t.position, weight: t.weight } : null; return origSet.call(body, side, t); };

const state = { position: { x: 0, y: 0.9, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, onFloor: true, crouch: 0, prone: 0, alive: true };
for (let i = 0; i < 30; i++) body.update(1 / 60, state);

const system = createWeaponMountSystem({ THREE, scene, loadGLB: fakeGLB, getWeapon, loadData: () => Promise.resolve([anchors, poses]) });

const none = await system.createMount(body, 'knife');
ok(none === null || none?.def?.thirdPersonHold, 'a weapon without a third-person hold yields no mount or a valid one');

const mount = await system.createMount(body, 'cz_805_bren');
ok(mount && mount.weaponId === 'cz_805_bren', 'cz mount builds from the fake GLB');
ok(mount.muzzleMarker && mount.barrelReferenceMarker, 'muzzle and rear markers exist');
ok(mount.reloadSequence?.keys?.length > 0, 'reload sequence resolved');

const frame = (over = {}) => ({
  feetY: 0, bodyX: 0, bodyZ: 0, yaw: 0, stance: 'stand', stanceWeights: { crouch01: 0, kneel01: 0, prone01: 0 },
  speed: 0, aiming: false, aimPoint: null, bob: 0, sway: 0, headYaw: 0, aimChannels: null, ...over,
});

// Idle: both hands driven onto the weapon's grip anchors.
for (let i = 0; i < 60; i++) { system.updateMount(mount, 1 / 60, frame()); body.update(1 / 60, state); }
const idlePos = mount.weaponRig.position.clone();
ok(Math.abs(idlePos.y - 1.5) < 1e-6, `mount root sits at feet + 1.5 (${idlePos.y.toFixed(3)})`);
ok(armTargets.right && armTargets.left, 'both arms have weapon targets');
mount.weaponView.updateWorldMatrix(true, false);
const rightGripWorld = new THREE.Vector3().fromArray(mount.bakedAnchors.rightGrip.p).applyMatrix4(mount.weaponView.matrixWorld);
const leftGripWorld = new THREE.Vector3().fromArray(mount.bakedAnchors.leftGrip.p).applyMatrix4(mount.weaponView.matrixWorld);
ok(dist(armTargets.right.position, rightGripWorld) < 0.05, `right hand target on the right grip (${dist(armTargets.right.position, rightGripWorld).toFixed(3)} m)`);
ok(dist(armTargets.left.position, leftGripWorld) < 0.05, `left hand target on the left grip (${dist(armTargets.left.position, leftGripWorld).toFixed(3)} m)`);

// The barrel ray runs along the model's bore (normalized long axis), not grip -> muzzle.
{
  const d = new THREE.Vector3(); system.barrelDirection(mount, d);
  const z = new THREE.Vector3(0, 0, 1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(mount.weaponView.matrixWorld));
  ok(Math.abs(d.dot(z)) > 0.999, `barrel ray is parallel to the bore axis (|cos| ${Math.abs(d.dot(z)).toFixed(4)})`);
}

// Walk carry changes the hold relative to idle.
for (let i = 0; i < 60; i++) system.updateMount(mount, 1 / 60, frame({ speed: 2 }));
const walkAdjust = mount.weaponAdjust.position.clone();
for (let i = 0; i < 60; i++) system.updateMount(mount, 1 / 60, frame({ speed: 0 }));
const idleAdjust = mount.weaponAdjust.position.clone();
ok(dist(walkAdjust, idleAdjust) > 0.01, `walk carry moves the hold (${dist(walkAdjust, idleAdjust).toFixed(3)} m)`);

// Dash releases the support hand to a chest tuck, and re-attaches after.
for (let i = 0; i < 30; i++) system.updateMount(mount, 1 / 60, frame({ stance: 'dash', speed: 7 }));
ok(mount.oneHanded === true, 'dash is one-handed');
ok(armTargets.left && dist(armTargets.left.position, leftGripWorld) > 0.05, 'left hand left the grip on a dash');
for (let i = 0; i < 30; i++) system.updateMount(mount, 1 / 60, frame());
ok(mount.oneHanded === false, 'support hand returns after the dash');

// Aiming with an aim point trims the barrel toward it.
const target = new THREE.Vector3(0, 1.5, 20);
for (let i = 0; i < 120; i++) system.updateMount(mount, 1 / 60, frame({ aiming: true, aimPoint: target }));
const dir = new THREE.Vector3();
const muz = new THREE.Vector3();
ok(system.barrelDirection(mount, dir) && system.muzzleWorld(mount, muz), 'barrel direction and muzzle world available');
const want = target.clone().sub(muz).normalize();
ok(dir.dot(want) > 0.99, `barrel trimmed onto the aim point (cos ${dir.dot(want).toFixed(3)})`);

// Crouch: the hold drops with the stance weights.
for (let i = 0; i < 60; i++) system.updateMount(mount, 1 / 60, frame({ stance: 'crouch', stanceWeights: { crouch01: 1, kneel01: 0, prone01: 0 } }));
ok(mount.weaponAdjust.position.y < idleAdjust.y - 0.1, `crouch hold drops the gun (${(idleAdjust.y - mount.weaponAdjust.position.y).toFixed(2)} m)`);

// Reload plays the sequence and emits events.
mount.controller.play('reload');
for (let i = 0; i < 100; i++) system.updateMount(mount, 1 / 60, frame());
const events = system.drainEvents(mount).map((e) => e.name);
ok(events.includes('removeMagazine') || events.includes('detachMagazine'), `reload emitted sequence events (${events.join(',') || 'none'})`);

// Flush writes the parts into the pool.
system.beginFrame();
system.flushMount(mount);
system.endFrame();
ok(system.stats.flushed === 1 && system.batches && system.batches.stats.instances >= 1, `flush wrote ${system.batches?.stats.instances} instance(s)`);

// Phase 2 seam: a view frame at blend 1 puts weaponView exactly on it.
const vf = { position: new THREE.Vector3(3, 2, 1), quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0.4, 0)) };
for (let i = 0; i < 30; i++) system.updateMount(mount, 1 / 60, frame({ viewFrame: vf, viewBlend: 1 }));
mount.weaponView.updateWorldMatrix(true, false);
const vp = new THREE.Vector3(), vq = new THREE.Quaternion(), vs = new THREE.Vector3();
mount.weaponView.matrixWorld.decompose(vp, vq, vs);
ok(dist(vp, vf.position) < 1e-3 && Math.abs(vq.dot(vf.quaternion)) > 0.9999, `viewBlend 1 places weaponView on the view frame (${dist(vp, vf.position).toFixed(3)} m, dot ${Math.abs(vq.dot(vf.quaternion)).toFixed(4)})`);

// Two-grip reach solve: a hold pushed out of reach comes back to where both hands can hold it.
{
  const shR = new THREE.Vector3(), shL = new THREE.Vector3(), gR = new THREE.Vector3(), gL = new THREE.Vector3();
  const reach = body.limbLengths.armLen * 0.96;
  const gripDist = () => {
    mount.weaponView.updateWorldMatrix(true, false);
    body.joints.rightShoulder.getWorldPosition(shR); body.joints.leftShoulder.getWorldPosition(shL);
    gR.fromArray(mount.bakedAnchors.rightGrip.p).applyMatrix4(mount.weaponView.matrixWorld);
    gL.fromArray(mount.bakedAnchors.leftGrip.p).applyMatrix4(mount.weaponView.matrixWorld);
    return [gR.distanceTo(shR), gL.distanceTo(shL)];
  };
  const far = { position: new THREE.Vector3(0.6, 1.9, 1.6), quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0.9, 0)) };
  for (let i = 0; i < 30; i++) system.updateMount(mount, 1 / 60, frame({ viewFrame: far, viewBlend: 0.9 }));
  const [offR, offL] = gripDist();
  ok(offR > reach || offL > reach, `far view frame puts a grip out of reach (${offR.toFixed(2)} / ${offL.toFixed(2)} vs ${reach.toFixed(2)})`);
  for (let i = 0; i < 30; i++) system.updateMount(mount, 1 / 60, frame({ viewFrame: far, viewBlend: 0.9, reachSolve: true }));
  const [onR, onL] = gripDist();
  ok(mount.reachMoved && onR <= reach + 0.01 && onL <= reach + 0.03, `reach solve brings both grips within reach (${onR.toFixed(2)} / ${onL.toFixed(2)})`);
  for (let i = 0; i < 30; i++) system.updateMount(mount, 1 / 60, frame({ reachSolve: true }));
  ok(mount.reachMoved === false, 'reach solve is a no-op on a reachable hold');
  for (let i = 0; i < 5; i++) system.updateMount(mount, 1 / 60, frame({ viewFrame: far, viewBlend: 1, reachSolve: true }));
  ok(mount.reachMoved === false, 'a fully camera-bound gun (blend 1) is not reach-solved');
}

// Body-relative hold: the trigger grip sits a comfortable fraction of the arm from the shoulder.
{
  const sh = new THREE.Vector3(), g = new THREE.Vector3();
  const armLen = body.limbLengths.armLen;
  const gripFromShoulder = () => {
    mount.weaponView.updateWorldMatrix(true, false);
    body.joints.rightShoulder.getWorldPosition(sh);
    g.fromArray(mount.bakedAnchors.rightGrip.p).applyMatrix4(mount.weaponView.matrixWorld);
    return g.distanceTo(sh) / armLen;
  };
  for (let i = 0; i < 30; i++) system.updateMount(mount, 1 / 60, frame({ holdMode: 'body' }));
  const idleFrac = gripFromShoulder();
  ok(idleFrac > 0.45 && idleFrac < 0.75, `body hold keeps the trigger grip at a bent-elbow distance (${idleFrac.toFixed(2)} of the arm)`);
  {
    // Front of the body = the side the muzzle-less barrel reference points when the gun is held; use the
    // pelvis->head-independent check: the grip must be farther from the hip-behind point than from the hip-front.
    const shL = new THREE.Vector3(); body.joints.leftShoulder.getWorldPosition(shL);
    const right = sh.clone().sub(shL).setY(0).normalize();
    const fwd = new THREE.Vector3(0, 1, 0).cross(right).normalize();
    const rel = g.clone().sub(sh);
    ok(rel.dot(fwd) > 0.15, `trigger grip is in front of the shoulders (${rel.dot(fwd).toFixed(2)} m forward)`);
    // And that forward is the FACE side: the body's facing at yaw is (-sin, 0, -cos).
    const facing = new THREE.Vector3(-Math.sin(state.yaw), 0, -Math.cos(state.yaw));
    ok(facing.dot(fwd) > 0.95, `shoulder-derived forward is the body's facing (cos ${facing.dot(fwd).toFixed(2)})`);
  }
  for (let i = 0; i < 60; i++) system.updateMount(mount, 1 / 60, frame({ holdMode: 'body', aiming: true, aimPoint: target }));
  const aimFrac = gripFromShoulder();
  ok(aimFrac < idleFrac, `aiming pulls the gun in (${aimFrac.toFixed(2)} of the arm)`);
  system.barrelDirection(mount, dir); system.muzzleWorld(mount, muz);
  ok(dir.dot(target.clone().sub(muz).normalize()) > 0.99, 'barrel still trims onto the aim point in body hold');
  // Aiming steeply down lowers the grip below the shoulder: the body moves, not just the gun.
  const low = new THREE.Vector3(0, -3, 4);
  for (let i = 0; i < 60; i++) system.updateMount(mount, 1 / 60, frame({ holdMode: 'body', aiming: true, aimPoint: low }));
  body.joints.rightShoulder.getWorldPosition(sh);
  g.fromArray(mount.bakedAnchors.rightGrip.p).applyMatrix4(mount.weaponView.updateWorldMatrix(true, false) || mount.weaponView.matrixWorld);
  ok(g.y < sh.y - 0.15, `aiming down drops the trigger grip below the shoulder (${(g.y - sh.y).toFixed(2)} m)`);
}

// Phase 4 seam: drawBlend 0 with a holsterHold uses the holster hold.
const def = getWeapon('cz_805_bren');
def.holsterHold = { position: [0, -0.6, -0.2], rotation: [1.2, 0, 0], scale: 1 };
system.updateMount(mount, 1 / 60, frame({ drawBlend: 0 }));
ok(Math.abs(mount.weaponAdjust.position.y - (-0.6)) < 1e-6, 'drawBlend 0 resolves to holsterHold');
delete def.holsterHold;

ok(defaultReloadSequence(poses, {}) === null, 'no default reload without magwell + charging handle');

system.destroyMount(mount);
system.dispose();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
