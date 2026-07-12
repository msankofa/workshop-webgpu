// Runs in Node.js. Exercises the first-person orb-hand viewmodel with a minimal
// THREE stub (createViewHands takes THREE as a param for exactly this).
import { createViewHands } from './player-hands.js';

let failed = false;
function assert(cond, msg) { if (!cond) { failed = true; console.error('FAIL:', msg); } }

// --- minimal THREE stub -----------------------------------------------------
class Vec { constructor() { this.x = 0; this.y = 0; this.z = 0; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } }
class Obj3D {
  constructor() { this.position = new Vec(); this.scale = new Vec().set(1, 1, 1); this.children = []; this.visible = true; }
  add(c) { this.children.push(c); return this; }
  remove(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
}
class Group extends Obj3D {}
class Mesh extends Obj3D { constructor(geo, mat) { super(); this.geometry = geo; this.material = mat; } }
function geo() { return { disposed: false, dispose() { this.disposed = true; } }; }
function mat(opts = {}) {
  return {
    ...opts, disposed: false,
    color: { h: 0, s: 0, l: 0, setHSL(h, s, l) { this.h = h; this.s = s; this.l = l; } },
    dispose() { this.disposed = true; },
  };
}
const THREE = {
  Group, Mesh,
  Vector3: Vec,
  SphereGeometry: geo,
  MeshStandardMaterial: function (o) { return mat(o); },
};
// stand-in camera: only needs add/remove + children
const camera = new Obj3D();

// --- creation ---------------------------------------------------------------
const hands = createViewHands(camera, THREE);
const group = camera.children.find(c => c instanceof Group);
assert(group, 'view-hands group added as a child of the camera');
const orbs = group.children.filter(c => c instanceof Mesh);
assert(orbs.length === 2, 'two orb meshes (got ' + orbs.length + ')');
assert(orbs[0].position.x < 0 && orbs[1].position.x > 0, 'orbs spread left/right');
assert(orbs.every(o => o.position.z < 0), 'orbs sit in front (-Z)');
assert(group.visible === false, 'hidden until FPS mode');

// --- visibility toggle ------------------------------------------------------
hands.setVisible(true);
assert(group.visible === true, 'setVisible(true) shows the group');
hands.setVisible(false);
assert(group.visible === false, 'setVisible(false) hides the group');

// --- tint -------------------------------------------------------------------
hands.setTint([0.5, 0.4, 0.7]);
assert(orbs[0].material.color.h === 0.5 && orbs[0].material.color.l === 0.7, 'setTint recolors the orb material');

// --- update: idle bob + speed-scaled sway -----------------------------------
hands.update(0.5, { speed: 0 });                 // t=0.5, no walk
const restY = orbs[0].position.y, restZ = orbs[0].position.z;
hands.update(0.2, { speed: 0 });                 // t=0.7 -> bob moved y
assert(orbs[0].position.y !== restY, 'idle bob moves the orbs vertically');

// Sway magnitude grows with speed: two fresh instances stepped to the same phase
// (equal total t) so only speed differs.
const firstOrb = (cam) => cam.children[0].children[0];
const camA = new Obj3D(), camB = new Obj3D();
createViewHands(camA, THREE).update(0.13, { speed: 1 });
createViewHands(camB, THREE).update(0.13, { speed: 6 });
const swayA = Math.abs(firstOrb(camA).position.z - restZ);
const swayB = Math.abs(firstOrb(camB).position.z - restZ);
assert(swayB > swayA, 'faster movement produces larger fore/aft sway');

// --- charge pose: hands raise + draw inward ---------------------------------
const camC = new Obj3D();
const vhC = createViewHands(camC, THREE);
const orbC = firstOrb(camC);
vhC.update(0, { charge: 0 });
const restX0 = Math.abs(orbC.position.x), restY0 = orbC.position.y, restZ0 = orbC.position.z;
vhC.update(0, { charge: 1 });
assert(Math.abs(orbC.position.x) < restX0, 'charging draws hands inward (smaller |x|)');
assert(orbC.position.y > restY0, 'charging raises hands');
assert(orbC.position.z > restZ0, 'charging pulls hands toward the camera (+z)');

// --- recoil kicks then decays -----------------------------------------------
vhC.update(0, { charge: 0 });            // back to rest baseline
const baseZ0 = orbC.position.z;
vhC.recoil();
vhC.update(0, { charge: 0 });            // kick applied, no time elapsed
assert(orbC.position.z > baseZ0, 'recoil kicks hands back (+z)');
vhC.update(1, { charge: 0 });            // long dt -> fully decayed
assert(Math.abs(orbC.position.z - baseZ0) < 1e-9, 'recoil decays back to rest');

// --- reload: hands glide toward sequence targets, then ease back ------------
const camR = new Obj3D();
const vhR = createViewHands(camR, THREE);
vhR.setTool('m1911');
const leftOrbR = camR.children[0].children[0];
vhR.update(0.016, { speed: 0 });                 // idle baseline
const idleLx = leftOrbR.position.x, idleLy = leftOrbR.position.y;
const reloadTgt = { active: true, left: [-0.5, -0.2, -0.4], right: [0.5, -0.2, -0.4] };
for (let i = 0; i < 45; i++) vhR.update(0.016, { speed: 0, reload: reloadTgt });
assert(Math.abs(leftOrbR.position.x - reloadTgt.left[0]) < 0.05, 'reload glides left orb to the resolved target x');
assert(Math.abs(leftOrbR.position.y - reloadTgt.left[1]) < 0.05, 'reload glides left orb to the resolved target y');
// mid-glide (fresh instance) sits between idle and target, not snapped to either
const camR2 = new Obj3D();
const vhR2 = createViewHands(camR2, THREE);
vhR2.setTool('m1911');
const leftOrbR2 = camR2.children[0].children[0];
vhR2.update(0.016, { speed: 0 });
vhR2.update(0.016, { speed: 0, reload: reloadTgt });
vhR2.update(0.016, { speed: 0, reload: reloadTgt });
assert(leftOrbR2.position.x < idleLx && leftOrbR2.position.x > reloadTgt.left[0], 'reload eases in (mid-glide, not snapped)');
// ending the reload eases the hands back to the idle pose
for (let i = 0; i < 80; i++) vhR.update(0.016, { speed: 0, reload: null });
assert(Math.abs(leftOrbR.position.x - idleLx) < 0.02 && Math.abs(leftOrbR.position.y - idleLy) < 0.02, 'hands return to idle after reload ends');

// --- destroy ----------------------------------------------------------------
hands.destroy();
assert(!camera.children.includes(group), 'destroy removes the group from the camera');

if (failed) { console.error('test-player-hands: FAILED'); process.exit(1); }
console.log('test-player-hands: OK');
