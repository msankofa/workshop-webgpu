// node test-weapon-mount.mjs — weapon-mount.js against a headless procedural body.
import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { createProceduralPlayerBody } from './player-procedural-body.js';
import { createWeaponMountSystem, defaultReloadSequence, buildStowParts, stowPlacementFor, stowedWeaponIds, holsterHoldFor, mergePartsByMaterial, STOW_PLACEMENTS, STOW_LOD_MAX_PARTS } from './weapon-mount.js';
import { getWeapon } from './weapons.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

const anchors = JSON.parse(readFileSync('./weapon-anchors.json', 'utf8'));
const poses = JSON.parse(readFileSync('./weapon-poses.json', 'utf8'));

// Fake GLB sized like the real CZ (its raw anchors span z -15..6), so the baked anchors land on it.
// Four sub-meshes over two materials, the way a real GLB arrives: the receiver and stock share the
// body material, the two rail pieces share the metal one.
const fakeBodyMat = new THREE.MeshBasicMaterial();
const fakeMetalMat = new THREE.MeshBasicMaterial();
function fakeGLB() {
  const scene = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1.5, 5, 22), fakeBodyMat);
  mesh.position.set(0, 0, -4.5);
  const stock = new THREE.Mesh(new THREE.BoxGeometry(1.2, 3, 4), fakeBodyMat);
  stock.position.set(0, 0, 8);
  const railA = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 6), fakeMetalMat);
  railA.position.set(0, 2.8, -6);
  const railB = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 2), fakeMetalMat);
  railB.position.set(0, -2.8, -6);
  scene.add(mesh, stock, railA, railB);
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

const mergedBefore = system.stats.partsMerged;   // the knife above may have loaded the same fake GLB
const mount = await system.createMount(body, 'cz_805_bren');
ok(mount && mount.weaponId === 'cz_805_bren', 'cz mount builds from the fake GLB');

// ---- one instancing bucket per material, not per sub-mesh ----
{
  ok(mount.instanceParts.length === 2, `four sub-meshes over two materials become two parts (${mount.instanceParts.length})`);
  ok(system.stats.partsMerged - mergedBefore === 2, `the system counts the two parts it folded away (${system.stats.partsMerged - mergedBefore})`);
  const body = mount.instanceParts.find(p => p.material === fakeBodyMat);
  ok(body && body.geometry.attributes.position.count === 48, `a merged part holds every vertex of its sub-meshes (${body?.geometry.attributes.position.count})`);
  ok(body && body.localMatrix.equals(new THREE.Matrix4()), 'the sub-mesh transforms are baked in, so the merged part sits at identity');
  // The template is normalised to unit scale, so compare spans by ratio: receiver + stock cover
  // z -15.5..10 (25.5) in the fake GLB, the two rails -9..-3 (6).
  const metal = mount.instanceParts.find(p => p.material === fakeMetalMat);
  body.geometry.computeBoundingBox(); metal.geometry.computeBoundingBox();
  const span = (g) => g.boundingBox.max.z - g.boundingBox.min.z;
  ok(Math.abs(span(body.geometry) / span(metal.geometry) - 25.5 / 6) < 1e-3,
    `the merged body spans receiver and stock in template space (ratio ${(span(body.geometry) / span(metal.geometry)).toFixed(3)} vs ${(25.5 / 6).toFixed(3)})`);
  // The pure function, with the cases the loader path cannot guess at.
  const m = new THREE.MeshBasicMaterial();
  const part = (geo, material = m, z = 0) => ({ geometry: geo, material, localMatrix: new THREE.Matrix4().makeTranslation(0, 0, z) });
  const plain = () => new THREE.BoxGeometry(1, 1, 1);
  const withUv2 = () => { const g = plain(); g.setAttribute('uv2', g.attributes.uv.clone()); return g; };
  ok(mergePartsByMaterial(THREE, [part(plain()), part(plain(), m, 3)]).length === 1, 'two parts, one material, same attributes: merged');
  ok(mergePartsByMaterial(THREE, [part(plain()), part(withUv2())]).length === 2, 'a differing attribute set keeps its parts separate rather than dropping data');
  ok(mergePartsByMaterial(THREE, [part(plain()), part(plain().toNonIndexed())]).length === 2, 'mixed indexed and non-indexed parts are kept separate');
  ok(mergePartsByMaterial(THREE, [part(plain(), [m, m]), part(plain(), [m, m])]).length === 2, 'multi-material parts are left alone');
  ok(mergePartsByMaterial(THREE, [part(plain())]).length === 1, 'a lone part is passed through untouched');
  const merged = mergePartsByMaterial(THREE, [part(plain()), part(plain(), m, 3)])[0];
  merged.geometry.computeBoundingBox();
  ok(Math.abs(merged.geometry.boundingBox.max.z - 3.5) < 1e-6, 'the localMatrix of a part is applied before the merge');
}
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
// With nothing authored, the holster hold IS the stow point: the weapon blends toward the place it
// is actually going, so the two can never be authored apart and drift.
{
  const derived = holsterHoldFor('cz_805_bren', def);
  ok(derived.position.every((v, i) => v === STOW_PLACEMENTS.back.position[i]), 'a rifle with no authored holsterHold falls back to its back stow point');
  ok(holsterHoldFor('m1911', getWeapon('m1911')).position[0] === STOW_PLACEMENTS.hip.position[0], 'a pistol falls back to the hip');
  ok(holsterHoldFor('cz_805_bren', def) === derived, 'the derived hold is built once and reused');
  system.updateMount(mount, 1 / 60, frame({ drawBlend: 0 }));
  ok(Math.abs(mount.weaponAdjust.position.y - STOW_PLACEMENTS.back.position[1]) < 1e-6, 'drawBlend 0 with nothing authored puts the rifle at its back stow point');
  system.updateMount(mount, 1 / 60, frame({ drawBlend: 1 }));
}

// ---- stowed weapons (phase 4.1) ----
{
  ok(stowPlacementFor('m1911') === STOW_PLACEMENTS.hip && stowPlacementFor('five_seven') === STOW_PLACEMENTS.hip, 'pistols ride the hip');
  ok(stowPlacementFor('cz_805_bren') === STOW_PLACEMENTS.back && stowPlacementFor('m24') === STOW_PLACEMENTS.back, 'long guns ride the back');

  const part = (verts) => ({ geometry: { attributes: { position: { count: verts } } } });
  const parts = [part(10), part(400), part(50), part(300)];
  const kept = buildStowParts(parts);
  ok(kept.length <= STOW_LOD_MAX_PARTS && kept[0] === parts[1] && kept[1] === parts[3], 'the reduced list keeps the biggest sub-meshes, largest first');
  ok(buildStowParts([]).length === 0, 'nothing in gives nothing out');
  ok(buildStowParts(parts, { maxParts: 99, coverage: 1 }).length === parts.length, 'asking for full coverage keeps every part');
  const tiny = [part(0), part(0)];
  ok(buildStowParts(tiny).length > 0, 'a weapon whose parts report no vertices still draws something');

  const loadout = { primary: 'cz_805_bren', sidearm: 'five_seven', melee: 'knife', throwable: 'grenade' };
  ok(stowedWeaponIds(loadout, 'cz_805_bren').join() === 'five_seven', 'holding the rifle stows the pistol');
  ok(stowedWeaponIds(loadout, 'knife').join() === 'cz_805_bren,five_seven', 'a knife in hand stows both guns');
  ok(stowedWeaponIds({ primary: 'm1911', sidearm: 'm1911' }, null).join() === 'm1911', 'the same gun in two slots is stowed once');
  ok(stowedWeaponIds({ primary: 'none', sidearm: null }, null).length === 0, 'empty slots stow nothing');

  const stow = system.createStow();
  ok(stow.key === '' && stow.mounts.length === 0, 'a new stow set is empty');
  stow.setWeapons(['cz_805_bren']);
  ok(stow.key === 'cz_805_bren', 'the set remembers what it was asked for');
  ok(stow.flush(null, 0) === 0 && stow.flush({ joints: {} }, 0) === 0, 'a body with no torso hangs nothing on itself');
  stow.dispose();
  ok(stow.key === '' && stow.mounts.length === 0, 'disposing clears it');
}

ok(defaultReloadSequence(poses, {}) === null, 'no default reload without magwell + charging handle');

system.destroyMount(mount);
system.dispose();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
