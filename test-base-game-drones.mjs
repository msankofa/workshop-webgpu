// Node tests for base-game-drones.js: throw, follow, send, hold, recall, take over, release,
// shoot-down, and the wire round-trip. Run: node test-base-game-drones.mjs
import {
  DRONE_QUAD, DRONE_UAV, BASE_GAME_DRONE_DEFS,
  createBaseGameDrone, stepBaseGameDrone, sendDroneTo, recallDrone,
  takeOverDrone, releaseDrone, damageBaseGameDrone,
  droneWireState, sanitizeBaseGameDroneState, sanitizeDroneInput,
  quatFromHeading, headingFromQuat,
} from './base-game-drones.js';
import { analyticHeightAt } from './flight-terrain.js';
import * as THREE from 'three';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }
const DT = 1 / 120;

// A gentle hill so altitude claims are against real ground, not a plane.
const groundY = (x, z) => 4 * Math.sin(x * 0.05) + 3 * Math.cos(z * 0.04);
const owner = { pos: [0, groundY(0, 0), 0], yaw: 0.3 };
const world = (over = {}) => ({ ownerPos: owner.pos, ownerYaw: owner.yaw, ownerAlive: true, groundY, ...over });
const hand = () => [owner.pos[0], groundY(0, 0) + 2.1, owner.pos[2]];
const look = [-Math.sin(owner.yaw) * 0.94, 0.34, -Math.cos(owner.yaw) * 0.94];
const run = (rec, seconds, w = world()) => { let out; for (let i = 0; i < seconds * 120; i++) out = stepBaseGameDrone(rec, DT, w); return out; };
const agl = (rec) => rec.d.p[1] - groundY(rec.d.p[0], rec.d.p[2]);

// ─── throw and follow ────────────────────────────────────────────────────────
for (const kind of [DRONE_QUAD, DRONE_UAV]) {
  const rec = createBaseGameDrone(kind, { ownerId: 'p1', from: hand(), look, throwSpeed: 8, groundY: groundY(0, 0) });
  ok(rec.state === 'launch', `${kind} starts in launch`);
  let minAgl = Infinity;
  const settle = kind === DRONE_QUAD ? 8 : 25;   // the plane climbs to 300 m first
  for (let i = 0; i < 120 * settle; i++) { stepBaseGameDrone(rec, DT, world()); minAgl = Math.min(minAgl, agl(rec)); }
  ok(rec.state === 'follow', `${kind} settles into follow within ${settle} s (state ${rec.state})`);
  ok(minAgl >= BASE_GAME_DRONE_DEFS[kind].minAgl - 1e-6, `${kind} never dips under minAgl (min ${minAgl.toFixed(2)} m)`);
  const d = Math.hypot(rec.d.p[0] - owner.pos[0], rec.d.p[2] - owner.pos[2]);
  const near = kind === DRONE_QUAD ? 4 : BASE_GAME_DRONE_DEFS[kind].orbitRadius * 1.6;
  ok(d <= near, `${kind} follow keeps it within ${near} m of the owner (at ${d.toFixed(1)} m)`);
  ok(Number.isFinite(rec.d.p[0] + rec.d.p[1] + rec.d.p[2]), `${kind} position is finite`);
}

// The quad's follow point tracks a moving owner.
{
  const rec = createBaseGameDrone(DRONE_QUAD, { ownerId: 'p1', from: hand(), look, groundY: groundY(0, 0) });
  run(rec, 6);
  const moved = { pos: [60, groundY(60, 20), 20], yaw: 1.2 };
  run(rec, 12, world({ ownerPos: moved.pos, ownerYaw: moved.yaw }));
  const d = Math.hypot(rec.d.p[0] - moved.pos[0], rec.d.p[2] - moved.pos[2]);
  ok(d <= 4, `quad follows a moved owner (at ${d.toFixed(1)} m)`);
}

// ─── send, hold, recall ──────────────────────────────────────────────────────
for (const kind of [DRONE_QUAD, DRONE_UAV]) {
  const rec = createBaseGameDrone(kind, { ownerId: 'p1', from: hand(), look, groundY: groundY(0, 0) });
  run(rec, 6);
  const target = [120, groundY(120, -80), -80];
  ok(sendDroneTo(rec, target), `${kind} accepts a send`);
  ok(rec.state === 'goto', `${kind} goes to goto`);
  run(rec, 25);
  ok(rec.state === 'hold', `${kind} reaches hold within 25 s (state ${rec.state})`);
  const d = Math.hypot(rec.d.p[0] - target[0], rec.d.p[2] - target[2]);
  const holdR = kind === DRONE_QUAD ? 3 : BASE_GAME_DRONE_DEFS[kind].orbitRadius * 1.5;
  ok(d <= holdR, `${kind} holds within ${holdR} m of the target (at ${d.toFixed(1)} m)`);
  const wantAlt = BASE_GAME_DRONE_DEFS[kind].holdAlt;
  ok(Math.abs(agl(rec) - wantAlt) < wantAlt * 0.15 + 6, `${kind} holds near ${wantAlt} m agl (${agl(rec).toFixed(1)})`);
  // The owner walking off is not a leash.
  const far = { pos: [-200, groundY(-200, 200), 200], yaw: 0 };
  run(rec, 3, world({ ownerPos: far.pos }));
  ok(rec.state === 'hold', `${kind} stays on station when the owner walks away`);
  ok(recallDrone(rec), `${kind} accepts a recall`);
  run(rec, 40, world({ ownerPos: far.pos }));
  ok(rec.state === 'follow', `${kind} is back in follow after recall (state ${rec.state})`);
}

// ─── attitude round trip ─────────────────────────────────────────────────────
{
  const q = new THREE.Quaternion();
  for (const [yaw, pitch, bank] of [[0, 0, 0], [1.1, 0.2, 0.4], [-2.5, -0.3, -0.6], [3.0, 0.5, 0.1]]) {
    quatFromHeading(q, yaw, pitch, bank);
    const h = headingFromQuat(q, { yaw: 0, pitch: 0, bank: 0 });
    const dy = Math.atan2(Math.sin(h.yaw - yaw), Math.cos(h.yaw - yaw));
    ok(Math.abs(dy) < 1e-6 && Math.abs(h.pitch - pitch) < 1e-6 && Math.abs(h.bank - bank) < 1e-6,
      `heading round-trips (${yaw}, ${pitch}, ${bank}) -> (${h.yaw.toFixed(3)}, ${h.pitch.toFixed(3)}, ${h.bank.toFixed(3)})`);
  }
}

// ─── take over and release ───────────────────────────────────────────────────
{
  const rec = createBaseGameDrone(DRONE_QUAD, { ownerId: 'p1', from: hand(), look, groundY: groundY(0, 0) });
  run(rec, 6);
  const before = [...rec.d.p];
  ok(takeOverDrone(rec, world()), 'quad take-over accepted');
  ok(rec.mode === 'manual' && rec.flyer, 'quad is manual with a flyer');
  // Hands off: the sim's idle throttle sits above hover, so a fresh stick climbs gently (as in the
  // sim after a spawn) and never drops or shoots off sideways.
  run(rec, 2, world({ input: { pitch: 0, roll: 0, yaw: 0, throttle: 0 } }));
  const rise = rec.d.p[1] - before[1];
  const slide = Math.hypot(rec.d.p[0] - before[0], rec.d.p[2] - before[2]);
  ok(rise > 0 && rise < 12 && slide < 3, `hands-off quad climbs gently (${rise.toFixed(1)} m up, ${slide.toFixed(1)} m sideways in 2 s)`);
  ok(agl(rec) > 1, `manual quad is still airborne (${agl(rec).toFixed(1)} m agl)`);
  // Pitch forward: it should move along its nose.
  const p0 = [...rec.d.p];
  run(rec, 3, world({ input: { pitch: 1, roll: 0, yaw: 0, throttle: 0.15 } }));
  const gone = Math.hypot(rec.d.p[0] - p0[0], rec.d.p[2] - p0[2]);
  ok(gone > 5, `pitched quad travels (${gone.toFixed(1)} m in 3 s)`);
  ok(releaseDrone(rec), 'release accepted');
  ok(rec.mode === 'auto' && !rec.flyer, 'released quad is auto again');
  run(rec, 15);
  ok(rec.state === 'follow', `released quad returns to follow (state ${rec.state})`);
}
{
  const rec = createBaseGameDrone(DRONE_UAV, { ownerId: 'p1', from: hand(), look, groundY: groundY(0, 0) });
  run(rec, 8);
  const speed0 = Math.hypot(...rec.d.v);
  ok(takeOverDrone(rec, world()), 'uav take-over accepted');
  run(rec, 4, world({ input: { pitch: 0, roll: 0, yaw: 0, throttle: 0 } }));
  const speed = Math.hypot(...rec.d.v);
  ok(speed > 60 && speed < 220, `hands-off uav keeps flying speed (${speed0.toFixed(1)} -> ${speed.toFixed(1)} m/s)`);
  ok(agl(rec) > 3, `manual uav still airborne (${agl(rec).toFixed(1)} m agl)`);
  ok(releaseDrone(rec) && rec.state === 'follow', 'released uav goes back to follow');
}
{
  // A hand-launched wing gains speed at the plane's thrust, not by snapping to circuit speed.
  const rec = createBaseGameDrone(DRONE_UAV, { ownerId: 'p1', from: hand(), look, groundY: groundY(0, 0), throwSpeed: 8 });
  run(rec, 0.5);
  const s1 = Math.hypot(...rec.d.v);
  ok(s1 < 20, `uav half a second after the throw is still slow (${s1.toFixed(1)} m/s)`);
  run(rec, 4);
  const s2 = Math.hypot(...rec.d.v);
  ok(s2 > s1 + 20 && s2 < 80, `uav is accelerating through the launch (${s2.toFixed(1)} m/s at 4.5 s)`);
  run(rec, 12);
  ok(Math.abs(Math.hypot(...rec.d.v) - rec.def.speed) < 1, 'uav reaches circuit speed');
}

// A send while manual releases first.
{
  const rec = createBaseGameDrone(DRONE_QUAD, { ownerId: 'p1', from: hand(), look, groundY: groundY(0, 0) });
  run(rec, 6); takeOverDrone(rec, world());
  sendDroneTo(rec, [50, 0, 50]);
  ok(rec.mode === 'auto' && rec.state === 'goto', 'send from manual releases and goes');
}

// ─── shoot-down ──────────────────────────────────────────────────────────────
{
  const rec = createBaseGameDrone(DRONE_QUAD, { ownerId: 'p1', from: hand(), look, groundY: groundY(0, 0) });
  run(rec, 6);
  const r = damageBaseGameDrone(rec, 10);
  ok(!r.dead && rec.d.hp === BASE_GAME_DRONE_DEFS[DRONE_QUAD].hp - 10, 'partial damage takes hp');
  const dead = damageBaseGameDrone(rec, 100, { roll: 0.9 });
  ok(dead.dead && !dead.deadstick && rec.done && rec.crash, 'a high roll breaks it up on the spot');
}
{
  const rec = createBaseGameDrone(DRONE_QUAD, { ownerId: 'p1', from: hand(), look, groundY: groundY(0, 0) });
  run(rec, 6); takeOverDrone(rec, world());
  const dead = damageBaseGameDrone(rec, 100, { roll: 0.05 });
  ok(dead.deadstick && rec.state === 'deadstick' && rec.mode === 'auto', 'a low roll goes deadstick and drops the stick');
  const out = run(rec, 20);
  ok(rec.done && rec.crash, `deadstick reaches the ground (${rec.done})`);
  ok(rec.crash && rec.crash[1] <= groundY(rec.crash[0], rec.crash[2]) + 0.5, 'crash point is on the ground');
  ok(sendDroneTo(rec, [0, 0, 0]) === false && takeOverDrone(rec, world()) === false, 'a dead drone takes no orders');
  void out;
}
// Owner death: the quad drops, the uav stays up.
{
  const q = createBaseGameDrone(DRONE_QUAD, { ownerId: 'p1', from: hand(), look, groundY: groundY(0, 0) });
  const u = createBaseGameDrone(DRONE_UAV, { ownerId: 'p1', from: hand(), look, groundY: groundY(0, 0) });
  run(q, 6); run(u, 8);
  run(q, 0.5, world({ ownerAlive: false })); run(u, 0.5, world({ ownerAlive: false }));
  ok(q.state === 'deadstick', 'orphaned quad goes deadstick');
  ok(u.state === 'hold' && u.target, 'orphaned uav holds where it is');
}

// ─── wire ────────────────────────────────────────────────────────────────────
{
  const rec = createBaseGameDrone(DRONE_UAV, { ownerId: 'p1', team: 2, from: hand(), look, groundY: groundY(0, 0) });
  run(rec, 3); sendDroneTo(rec, [10, 2, 30]);
  const w = JSON.parse(JSON.stringify(droneWireState(rec)));
  const s = sanitizeBaseGameDroneState(w);
  ok(s && s.id === rec.id && s.kind === 'uav' && s.owner === 'p1' && s.team === 2 && s.state === 'goto', 'wire state survives JSON and the sanitizer');
  ok(s.target && s.target[2] === 30, 'target rides the wire');
  ok(sanitizeBaseGameDroneState({ ...w, p: [NaN, 0, 0] }) === null, 'a NaN position is rejected');
  ok(sanitizeBaseGameDroneState({ ...w, kind: 'jet' }) === null, 'an unknown kind is rejected');
  ok(sanitizeBaseGameDroneState({ ...w, state: 'zzz' }).state === 'follow', 'an unknown state falls back to follow');
  const inp = sanitizeDroneInput({ mode: 1, pitch: 3, roll: -2, yaw: 'x', throttle: 0.5, send: [1, 2, 3], recall: 'yes' });
  ok(inp.mode === 1 && inp.pitch === 1 && inp.roll === -1 && inp.yaw === 0 && inp.throttle === 0.5 && inp.send[1] === 2 && inp.recall === false, 'drone input is clamped and typed');
  ok(sanitizeDroneInput(null) === null && sanitizeDroneInput({}).mode === 0, 'absent input means hands off');
}

// ─── the sim's physics, bit for bit ──────────────────────────────────────────
// The flight sim's own flyer and the base-game drone under the stick, fed one identical script for
// 60 s (pull, roll, rudder, throttle, afterburner, a dive to the ground): the paths must not differ.
{
  const { makeFlyer, stepFlyer, syncAxes } = await import('./flight-model.js');
  const { setHeightSource } = await import('./flight-terrain.js');
  const flat = () => 0;
  setHeightSource(flat);
  const A = makeFlyer('plane', { x: 0, z: 0, heading: 0.4 });
  const B = createBaseGameDrone(DRONE_UAV, { ownerId: 'p', from: [0, 300, 0], look: [0, 0, -1], groundY: 0 });
  takeOverDrone(B, { groundY: flat });
  const f = B.flyer;
  f.p.copy(A.p); f.v.copy(A.v); f.q.copy(A.q); syncAxes(f); f.throttle = A.throttle; Object.assign(f.rates, A.rates);
  const script = (t) => ({ pitch: t < 3 ? 0 : t < 5 ? 1 : t < 12 ? 0 : t < 14 ? -0.6 : 0, roll: t < 6 ? 0 : t < 8 ? 1 : t < 9 ? -1 : 0, yaw: t > 15 && t < 17 ? 1 : 0, throttle: t < 10 ? 1 : t > 18 ? -1 : 0, flap: false, sweep: t > 10 && t < 13 });
  let maxP = 0;
  for (let i = 0; i < 120 * 60; i++) {
    const s = script(i / 120);
    Object.assign(A.input, s); stepFlyer(A, 1 / 120, true);
    stepBaseGameDrone(B, 1 / 120, { ownerPos: [0, 0, 0], ownerYaw: 0, ownerAlive: true, groundY: flat, input: s });
    maxP = Math.max(maxP, A.p.distanceTo(f.p));
  }
  ok(maxP === 0, `the sim's flyer and the base-game drone fly the identical path for 60 s (max gap ${maxP} m)`);
  ok(A.af === f.af, 'they share the one plane airframe object');
}

// ─── what is drawn is what is flown ──────────────────────────────────────────
// The view poses a craft from the wire's yaw/pitch/bank; that pose must be the physics quaternion.
{
  const { createBaseGameDroneView } = await import('./base-game-drone-view.js');
  const scene = new THREE.Scene();
  const view = createBaseGameDroneView({ scene, worldCoordinates: { toRenderLocal: (g, o = [0, 0, 0]) => { o[0] = g[0]; o[1] = g[1]; o[2] = g[2]; return o; } } });
  const q = new THREE.Quaternion();
  let at = 1000;   // the track keeps only samples newer than its last, so each case is a later server time
  for (const [yaw, pitch, bank] of [[0, 0, 0.4], [1.2, 0.3, 0.4], [-2, -0.4, -0.7]]) {
    at += 1000;
    view.ingest([{ id: 'v', kind: 'uav', owner: 'p', team: 0, p: [0, 100, 0], v: [0, 0, 0], yaw, pitch, bank, hp: 1, mode: 'manual', state: 'manual', target: null }], at);
    for (let i = 0; i < 200; i++) view.update(at, 1 / 60, { interpolationDelayMs: 0 });   // let the bank smoothing settle
    quatFromHeading(q, yaw, pitch, bank);
    const gap = view.drones.get('v').mesh.quaternion.angleTo(q);
    ok(gap < 1e-3, `drawn attitude equals the physics attitude at (${yaw}, ${pitch}, ${bank}) (gap ${gap.toExponential(1)} rad)`);
  }
  view.dispose();
}

// ─── the chase camera frames the craft the way the sim frames its plane ──────
{
  const { createBaseGameDroneView } = await import('./base-game-drone-view.js');
  const { AIRFRAMES: AF } = await import('./flight-airframes.js');
  const { buildCraftMesh } = await import('./flight-meshes.js');
  const mats = { standard: (c, e) => new THREE.MeshStandardMaterial({ color: c, emissive: e ?? 0 }), basic: (c, o = 1) => new THREE.MeshBasicMaterial({ color: c, transparent: o < 1, opacity: o }) };
  const spanOf = (kind, scale) => {
    const g = buildCraftMesh(kind, 0x888888, mats); g.scale.setScalar(scale); g.updateMatrixWorld(true);
    const d = new THREE.Box3().setFromObject(g).getSize(new THREE.Vector3());
    return Math.max(d.x, d.z);
  };
  const simSpans = AF.plane.chaseDist / spanOf('plane', 1);   // what the sim's chase view shows of a plane
  const view = createBaseGameDroneView({ scene: new THREE.Scene(), worldCoordinates: { toRenderLocal: (g, o = [0, 0, 0]) => { o[0] = g[0]; o[1] = g[1]; o[2] = g[2]; return o; } } });
  view.ingest([{ id: 'c', kind: 'uav', owner: 'p', team: 0, p: [0, 300, 0], v: [0, 0, 0], yaw: 0, pitch: 0, bank: 0, hp: 1, mode: 'manual', state: 'manual', target: null }], 1000);
  view.update(1000, 1 / 60, { interpolationDelayMs: 0 });
  const cam = new THREE.PerspectiveCamera(58, 1.6, 0.1, 1e5);
  for (let i = 0; i < 200; i++) view.placeCamera(cam, 'c', 1 / 60);   // let the camera lag settle
  const span = view.drones.get('c').mesh.userData.span;
  ok(Math.abs(span - 2.01) < 0.05, `uav is drawn at its authored 2 m span (${span.toFixed(2)} m)`);
  const spans = cam.position.distanceTo(view.drones.get('c').mesh.position) / span;
  ok(Math.abs(spans - simSpans) < 0.25, `chase sits the sim's distance in wingspans (${spans.toFixed(2)} vs the sim's ${simSpans.toFixed(2)})`);
}

// A loop: through inverted, the drawn attitude must track the flown one every frame (no roll-back).
{
  const { createBaseGameDroneView } = await import('./base-game-drone-view.js');
  const { setHeightSource } = await import('./flight-terrain.js');
  const flat = () => 0; setHeightSource(flat);
  const view = createBaseGameDroneView({ scene: new THREE.Scene(), worldCoordinates: { toRenderLocal: (g, o = [0, 0, 0]) => { o[0] = g[0]; o[1] = g[1]; o[2] = g[2]; return o; } } });
  const rec = createBaseGameDrone(DRONE_UAV, { ownerId: 'p', from: [0, 800, 0], look: [0, 0, -1], groundY: 0 });
  takeOverDrone(rec, { groundY: flat });
  rec.flyer.v.copy(rec.flyer.fwd).multiplyScalar(140);
  let worst = 0, inverted = false;
  for (let i = 0; i < 120 * 12; i++) {
    stepBaseGameDrone(rec, 1 / 120, { ownerPos: [0, 0, 0], ownerYaw: 0, ownerAlive: true, groundY: flat, input: { pitch: 1, roll: 0, yaw: 0, throttle: 1, sweep: true } });
    view.ingest([droneWireState(rec)], 1000 + i * 1000 / 120);
    view.update(1000 + i * 1000 / 120, 1 / 120, { interpolationDelayMs: 0 });
    const drawn = view.drones.get(rec.id).mesh.quaternion;
    worst = Math.max(worst, drawn.angleTo(rec.flyer.q));
    if (rec.flyer.up.y < -0.5) inverted = true;
  }
  ok(inverted, 'the pull actually took it through inverted');
  ok(worst < 0.15, `drawn attitude never leaves the flown one through a loop (worst ${worst.toFixed(3)} rad)`);
  view.dispose();
}

// ─── the tick carries the stick ──────────────────────────────────────────────
// base-game-prediction.js rebuilds every tick by hand; until 2026-08-27 it dropped slot/aim/fire/
// reload/throw/drone, so online the server never saw a trigger or the drone stick.
{
  const { createBaseGamePrediction } = await import('./base-game-prediction.js');
  const ctl = { pos: [0, 0, 0], stepOnce() {}, applyState() {}, captureState() { return {}; }, getPosition() { return this.pos; }, config: { fixedHz: 120 } };
  const sent = [];
  const prediction = createBaseGamePrediction({ controller: ctl, onTick: (e) => sent.push(e) });
  prediction.advance(1 / 120 + 1e-6, () => ({ moveX: 0, moveZ: 0, yaw: 0, pitch: 0, slot: 4, aim: true, fire: true, reload: false, throw: true, drone: { id: 'd1', mode: 1, pitch: 0.5, roll: 0, yaw: 0, throttle: 1 } }));
  const e = sent[0];
  ok(!!e && e.slot === 4 && e.aim === true && e.fire === true && e.throw === true, 'the predicted tick carries slot, aim, fire and throw');
  ok(!!e?.drone && e.drone.id === 'd1' && e.drone.mode === 1 && e.drone.pitch === 0.5, 'the predicted tick carries the drone stick');
}

void analyticHeightAt;
if (failed) { console.error(`base-game-drones: ${failed} failure(s)`); process.exit(1); }
console.log('base-game-drones: all tests passed');
