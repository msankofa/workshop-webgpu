// Runs in Node.js. Exercises GhostRenderer's player-capsule eyes + blink with a
// minimal THREE stub (GhostRenderer takes THREE as a param for exactly this).
import { GhostRenderer } from './multiplayer.js';

let failed = false;
function assert(cond, msg) { if (!cond) { failed = true; console.error('FAIL:', msg); } }

// --- minimal THREE stub -----------------------------------------------------
class Vec { constructor() { this.x = 0; this.y = 0; this.z = 0; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } }
class Quat { constructor() { this.x = 0; this.y = 0; this.z = 0; this.w = 1; } set(x, y, z, w) { this.x = x; this.y = y; this.z = z; this.w = w; return this; } }
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
  Group, Mesh,
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
assert(meshes.length === 3, 'container has body + 2 eyes (got ' + meshes.length + ')');
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

// --- per-player body tint ---------------------------------------------------
const bob = gr._players.get('bob');
assert(g.userData.bodyMat !== bob.userData.bodyMat, 'each player has its own body material');
assert(g.userData.bodyMat.color.h !== bob.userData.bodyMat.color.h, 'players get distinct body hues');
assert(g.userData.body.material === g.userData.bodyMat, 'body mesh uses the per-player material');

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
