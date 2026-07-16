// Runs in Node.js. Exercises GhostRenderer's player-capsule eyes + blink with a
// minimal THREE stub (GhostRenderer takes THREE as a param for exactly this).
import { GhostRenderer, playerTintHSL } from './multiplayer.js';

let failed = false;
function assert(cond, msg) { if (!cond) { failed = true; console.error('FAIL:', msg); } }

// --- minimal THREE stub -----------------------------------------------------
class Vec {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vec(this.x, this.y, this.z); }
  lerpVectors(v1, v2, alpha) {
    this.x = v1.x + (v2.x - v1.x) * alpha;
    this.y = v1.y + (v2.y - v1.y) * alpha;
    this.z = v1.z + (v2.z - v1.z) * alpha;
    return this;
  }
}
class Quat {
  constructor() { this.x = 0; this.y = 0; this.z = 0; this.w = 1; }
  set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; }
  copy(q) { this.x = q.x; this.y = q.y; this.z = q.z; this.w = q.w; return this; }
  clone() { return new Quat().set(this.x, this.y, this.z, this.w); }
  setFromAxisAngle(axis, angle) {
    const half = angle / 2, s = Math.sin(half);
    this.x = axis.x * s; this.y = axis.y * s; this.z = axis.z * s; this.w = Math.cos(half);
    return this;
  }
  multiply(q) {
    const { x: ax, y: ay, z: az, w: aw } = this;
    const { x: bx, y: by, z: bz, w: bw } = q;
    this.x = ax * bw + aw * bx + ay * bz - az * by;
    this.y = ay * bw + aw * by + az * bx - ax * bz;
    this.z = az * bw + aw * bz + ax * by - ay * bx;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }
  // Minimal slerp (no shortest-path flip, no renormalization) -- fine for the test's purposes,
  // which only check that the animation progresses monotonically from `from` toward `target`.
  slerp(qb, t) {
    this.x += (qb.x - this.x) * t;
    this.y += (qb.y - this.y) * t;
    this.z += (qb.z - this.z) * t;
    this.w += (qb.w - this.w) * t;
    return this;
  }
}
class Obj3D {
  constructor() { this.position = new Vec(); this.quaternion = new Quat(); this.scale = new Vec().set(1, 1, 1); this.children = []; this.userData = {}; }
  add(c) { this.children.push(c); return this; }
}
class Group extends Obj3D {}
class Mesh extends Obj3D { constructor(geo, mat) { super(); this.geometry = geo; this.material = mat; } }
function geo() { return { disposed: false, dispose() { this.disposed = true; } }; }
function mat(opts = {}) {
  return {
    ...opts, disposed: false,
    color: { h: 0, s: 0, l: 0, setHSL(h, s, l) { this.h = h; this.s = s; this.l = l; } },
    dispose() { this.disposed = true; },
    clone() { return mat(opts); },
  };
}
const THREE = {
  Group, Mesh, Vector3: Vec, Quaternion: Quat,
  BoxGeometry: geo, CapsuleGeometry: geo, SphereGeometry: geo,
  MeshStandardMaterial: function (o) { return mat(o); },
  MeshBasicMaterial: function (o) { return mat(o); },
};
class Scene { constructor() { this.children = []; } add(o) { this.children.push(o); } remove(o) { const i = this.children.indexOf(o); if (i >= 0) this.children.splice(i, 1); } }

// --- player ghost: solid body + two eyes ------------------------------------
const scene = new Scene();
const gr = new GhostRenderer(scene, THREE);
gr.update({ creatures: [], players: [
  { id: 'alice', p: [1, 2, 3], q: [0, 0, 0, 1], h: 1.2, r: 0.3 },
  { id: 'bob',   p: [4, 5, 6], q: [0, 0, 0, 1], h: 1.2, r: 0.3 },
] });

const g = gr._players.get('alice');
assert(g instanceof Group, 'player ghost is a Group container');
assert(scene.children.includes(g), 'container added to scene');
assert(g.position.x === 1 && g.position.y === 2 && g.position.z === 3, 'container positioned by p');
const meshes = g.children.filter(c => c instanceof Mesh);
assert(meshes.length === 5, 'container has body + 2 eyes + 2 hands (got ' + meshes.length + ')');
assert(g.userData.body.material.transparent !== true, 'body material is solid (not transparent)');
const { left, right } = g.userData;
assert(left && right, 'eye refs stored on userData');
assert(left.position.z < 0 && right.position.z < 0, 'eyes on the -Z (forward) face');
assert(left.position.x < 0 && right.position.x > 0, 'eyes spread left/right');
assert(left.position.y > 0.3 && right.position.y > 0.3, 'eyes sit high on the body');
const lg = left.children.find(c => c instanceof Mesh), rg = right.children.find(c => c instanceof Mesh);
assert(lg && rg, 'each eye has a glint highlight mesh');
assert(lg.material === gr._glintMat && lg.material !== gr._eyeMat, 'glint uses the white glint material');
assert(lg.position.y > 0 && lg.position.z < 0, 'glint sits toward the top-front of the eye');

// --- orb hands --------------------------------------------------------------
const { leftHand, rightHand } = g.userData;
assert(leftHand && rightHand, 'hand refs stored on userData');
assert(leftHand.material === g.userData.bodyMat, 'hands tinted with the per-player body material');
assert(leftHand.position.x < 0 && rightHand.position.x > 0, 'hands spread left/right');
assert(leftHand.position.z < 0 && rightHand.position.z < 0, 'hands float in front (-Z)');

// --- per-player body tint ---------------------------------------------------
const bob = gr._players.get('bob');
assert(g.userData.bodyMat !== bob.userData.bodyMat, 'each player has its own body material');
assert(g.userData.bodyMat.color.h !== bob.userData.bodyMat.color.h, 'players get distinct body hues');
assert(g.userData.body.material === g.userData.bodyMat, 'body mesh uses the per-player material');

// playerTintHSL is deterministic and id-dependent
const ta = playerTintHSL('alice'), ta2 = playerTintHSL('alice'), tb = playerTintHSL('bob');
assert(ta[0] === ta2[0] && ta[1] === ta2[1] && ta[2] === ta2[2], 'playerTintHSL is deterministic');
assert(ta[0] !== tb[0], 'playerTintHSL differs across ids');

// --- blink: eyes squash then recover ----------------------------------------
gr.tick(0);                        // lazy-init nextBlinkAt
const openY = g.userData.eyeH;
assert(Math.abs(left.scale.y - openY) < 1e-9, 'eyes open before blink');
g.userData.nextBlinkAt = 100;      // force a blink to start at t=100
gr.tick(100);                      // blink starts (still open at t=0 of blink)
gr.tick(100 + 60);                 // mid-blink (~half of BLINK_MS=120)
assert(left.scale.y < openY * 0.5, 'eyes squashed mid-blink (got ' + left.scale.y + ')');
assert(right.scale.y === left.scale.y, 'both eyes blink together');
gr.tick(100 + 200);                // past BLINK_MS -> recovered
assert(Math.abs(left.scale.y - openY) < 1e-9, 'eyes reopen after blink');
assert(g.userData.nextBlinkAt > 100 + 200, 'next blink rescheduled into the future');

// --- hands bob over time ----------------------------------------------------
gr.tick(1000);
const handY1 = leftHand.position.y;
gr.tick(1200);
assert(leftHand.position.y !== handY1, 'hands bob over time');

// --- death pose: fallen players smoothly tip over (not snapped) -------------
gr.update({ creatures: [], players: [
  { id: 'alice', p: [1, 2, 3], q: [0, 0, 0, 1], h: 1.2, r: 0.3 },
  { id: 'bob',   p: [4, 5, 6], q: [0, 0, 0, 1], h: 1.2, r: 0.3, alive: false },
] });
const bobG = gr._players.get('bob');
const restY = 5 - 1.2 * 0.5 + 0.3;
assert(bobG.position.y === 5, 'position untouched by update() alone -- tick() owns the fall (got y=' + bobG.position.y + ')');
gr.tick(2000); // first tick after death: animation starts, t=0
assert(bobG.position.y === 5, 'fall animation starts from the upright pose, not snapped (got y=' + bobG.position.y + ')');
assert(bobG.quaternion.w === 1, 'fall animation starts from the upright quaternion');
gr.tick(2200); // partway through the fall
assert(bobG.position.y < 5 && bobG.position.y > restY, 'fall animation is partway through mid-flight (got y=' + bobG.position.y + ')');
gr.tick(3200); // well past the fall duration
assert(Math.abs(bobG.position.y - restY) < 1e-9, 'fall animation settles at the resting height (got y=' + bobG.position.y + ')');
assert(!(bobG.quaternion.x === 0 && bobG.quaternion.y === 0 && bobG.quaternion.z === 0 && bobG.quaternion.w === 1), 'dead player tips out of the upright quaternion once settled');
assert(bobG.userData.left.visible === false && bobG.userData.leftHand.visible === false, 'dead player hides eyes/hands');
assert(bobG.userData.held.visible === false, 'dead player hides held item');
assert(g.position.y === 2 && g.quaternion.w === 1, 'a live neighbor (alice) is unaffected');

// --- removal cleans up the container ----------------------------------------
const aliceMat = g.userData.bodyMat;
gr.update({ creatures: [], players: [] });
assert(!gr._players.has('alice'), 'player removed from map when absent');
assert(!scene.children.includes(g), 'container removed from scene');
assert(aliceMat.disposed, 'per-player body material disposed on removal');

// --- destroy disposes shared geo/mat ----------------------------------------
const eyeMat = gr._eyeMat, eyeGeo = gr._eyeGeo;
gr.destroy();
assert(eyeMat.disposed && eyeGeo.disposed, 'destroy disposes eye geo + material');

if (failed) { console.error('test-ghost-renderer: FAILED'); process.exit(1); }
console.log('test-ghost-renderer: OK');
