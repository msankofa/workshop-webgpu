// Runs in Node.js. Exercises GhostRenderer's player-capsule eyes + blink with a
// minimal THREE stub (GhostRenderer takes THREE as a param for exactly this).
import { GhostRenderer, playerTintHSL } from './multiplayer.js';

let failed = false;
function assert(cond, msg) { if (!cond) { failed = true; console.error('FAIL:', msg); } }

// What the overhead overlay reads off a wire item. 'alertTier' is conditional (only sent while a cue
// is live), so it is allowed to be absent; the rest must always survive the trip to a guest.
const INSIGNIA_INPUT_FIELDS = ['role', 'id', 'p', 'h', 'alertTier'];

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
  constructor() {
    this.position = new Vec(); this.quaternion = new Quat(); this.rotation = new Vec();
    this.scale = new Vec().set(1, 1, 1); this.children = []; this.userData = {}; this.visible = true;
  }
  add(...cs) { for (const c of cs) this.children.push(c); return this; }
  remove(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return this; }
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
class Color {
  constructor(c) { this.value = c; }
  setHSL(h, s, l) { this.h = h; this.s = s; this.l = l; return this; }
  set(c) { this.value = c; return this; }
  getHex() { return 0x808080; }
}
const THREE = {
  Group, Mesh, Vector3: Vec, Quaternion: Quat, Color,
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

// --- bot overhead overlay: health bar, alert "!", role insignia --------------
{
  const s2 = new Scene();
  const gr2 = new GhostRenderer(s2, THREE);
  const medic = { id: 'm1', p: [0, 1, 0], q: [0, 0, 0, 1], h: 1.2, r: 0.3, isBot: true,
    role: 'medic', hp: 40, maxHp: 100, alertTier: 'seen' };
  gr2.update({ creatures: [], players: [medic] });
  const mg = s2.children.find(c => c.userData?.overlay);
  assert(mg, 'a bot ghost builds an overhead overlay');
  const ov = mg.userData.overlay;
  assert(ov.bar.visible === true, 'health bar shows while damaged');
  assert(ov.mark.visible === true, 'alert mark shows while a cue is live');
  assert(ov.insignia && ov.insignia.visible === true, 'a medic gets a role insignia');
  assert(ov.insignia.children.length === 2, 'the medic cross is two bars');
  assert(ov.insignia.position.y > 0, 'insignia sits above the bar and the "!"');

  // Role change swaps the marker rather than stacking a second one.
  const before = ov.insignia;
  gr2.update({ creatures: [], players: [{ ...medic, role: 'sniper' }] });
  assert(ov.insignia !== before, 'changing role rebuilds the insignia');
  assert(!mg.children.includes(before) && !ov.group.children.includes(before), 'the old insignia is removed, not stacked');
  assert(ov.insignia.children.length === 1, 'the sniper ring is a single mark');

  // A role with no marker, and a dead bot, both hide it.
  gr2.update({ creatures: [], players: [{ ...medic, role: 'nosuchrole' }] });
  assert(!ov.insignia, 'an unknown role gets no insignia at all');
  gr2.update({ creatures: [], players: [{ ...medic, alive: false }] });
  assert(!ov.insignia || ov.insignia.visible === false, 'a dead bot hides its insignia');

  // A human ghost never gets one.
  gr2.update({ creatures: [], players: [{ id: 'h1', p: [3, 1, 0], q: [0, 0, 0, 1], h: 1.2, r: 0.3, role: 'medic' }] });
  const hg = s2.children.find(c => c !== mg && c instanceof Group);
  assert(!hg?.userData?.overlay?.group?.visible, 'a human ghost shows no bot overlay');
  gr2.destroy();
}

// --- the overlay's inputs must actually survive the wire ---------------------
// The insignia and the role kit both key off item.role, and for a GUEST the only source of that field
// is toWirePose. The host patches pose.role from its own rec, so a missing entity-side role looks
// perfect on the host and renders bare rigs with no insignia on every guest. Nothing tested the wire
// producer, which is exactly why that went unnoticed.
{
  // The repo's local `three` ships empty examples/jsm stubs (the browser loads addons from a CDN
  // importmap), so bot-entity.js's Capsule import is redirected -- same hook test-bot-entity-rescue
  // uses.
  const { registerHooks } = await import('node:module');
  const CAPSULE_STUB = 'data:text/javascript,' + encodeURIComponent(`export class Capsule {
    constructor(start, end, radius) { this.start = start; this.end = end; this.radius = radius; }
  }`);
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'three/addons/math/Capsule.js') return { url: CAPSULE_STUB, shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
  const { toWirePose } = await import('./bot-entity.js');
  const pt = (x, y, z) => ({
    x, y, z,
    clone() { return pt(this.x, this.y, this.z); },
    add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; },
    multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; },
  });
  const bot = {
    id: 'b1', yaw: 0, pitch: 0, crouch01: 0, prone01: 0, standHeight: 0, team: 'alpha', role: 'medic',
    onFloor: true, velocity: pt(0, 0, 0), weapon: 'm1911', tool: 'm1911',
    capsule: { start: pt(0, 0, 0), end: pt(0, 1.5, 0), radius: 0.3 },
  };
  const wire = toWirePose(bot);
  assert(wire.role === 'medic', 'toWirePose puts role on the wire (got ' + wire.role + ')');
  assert(INSIGNIA_INPUT_FIELDS.every(f => f in wire || f === 'alertTier'),
    'every field the overhead overlay reads is emitted by toWirePose');
  const bare = toWirePose({ ...bot, role: null });
  assert(!('role' in bare), 'a role-less bot omits the field rather than sending null');
}

// --- rebuildBotBodies must retire a live ragdoll (the body-kind-switch freeze) ----
// Switching body kind throws every rig away mid-flight. A corpse still ragdolling is posed FROM that
// rig each frame, so dropping it without retiring the ragdoll left ud.ragdoll set with bodyProc null
// and threw on the next frame -- which stopped the whole animate loop.
{
  const s3 = new Scene();
  const gr3 = new GhostRenderer(s3, THREE, { botLod: { nearD2: 1, midD2: 4, hideD2: 1e9 } });
  const item = { id: 'z1', p: [0, 1, 0], q: [0, 0, 0, 1], h: 1.2, r: 0.3, isBot: true };
  gr3.update({ creatures: [], players: [item] });
  const zg = gr3._players.get('z1');
  const ud = zg.userData;
  let destroyed = false;
  ud.bodyProc = { destroy() { destroyed = true; }, flush() {}, setVisible() {}, setRagdollPose() {} };
  ud.ragdoll = { particles: [] };
  ud.ragdollPose = {};
  ud.ragdollAsleep = false;
  gr3._ragdollAwake = 1;

  gr3.rebuildBotBodies();
  assert(destroyed, 'rebuildBotBodies destroys the old rig');
  assert(ud.bodyProc === null, 'rebuildBotBodies clears bodyProc');
  assert(ud.ragdoll === null, 'rebuildBotBodies retires a live ragdoll instead of orphaning it');
  assert(gr3._ragdollAwake === 0, 'the live-corpse budget is given its slot back (got ' + gr3._ragdollAwake + ')');

  // Even with a ragdoll still set, the LOD path must not dereference a null rig. It falls through to
  // rebuilding the body, which this minimal THREE stub cannot complete -- so the assertion is on the
  // failure MODE, not on reaching the end: anything but a null dereference means the guard held.
  ud.ragdoll = { particles: [] };
  let threw = null;
  try { gr3._updateProceduralBodyLod(zg, item); } catch (err) { threw = err; }
  assert(!/of null|of undefined/.test(threw?.message ?? ''),
    'the ragdoll LOD branch survives a null bodyProc (got: ' + (threw && threw.message) + ')');
  gr3.destroy();
}

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
