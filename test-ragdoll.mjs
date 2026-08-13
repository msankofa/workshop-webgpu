// test-ragdoll.mjs — pure-solver checks for ragdoll.js. Run: node test-ragdoll.mjs
import {
  createRagdoll, stepRagdoll, applyImpulse, applyImpulseAll, seedRagdollFromJoints,
  jointPos, kineticEnergy, isSettled, RAGDOLL_PROPORTIONS,
} from './ragdoll.js';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra ? '  — ' + extra : ''}`); }
}
function finite(rd) { return rd.particles.every(p => Number.isFinite(p.pos.x) && Number.isFinite(p.pos.y) && Number.isFinite(p.pos.z)); }
function boneLengths(rd) {
  // rest length of every rigid constraint (min===max) vs current, max relative error
  let worst = 0;
  for (const c of rd.constraints) {
    if (c.min !== c.max) continue;
    const a = rd.particles[c.a].pos, b = rd.particles[c.b].pos;
    const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    worst = Math.max(worst, Math.abs(d - c.min) / c.min);
  }
  return worst;
}
function sim(rd, seconds, opts) { const n = Math.round(seconds * 60); for (let i = 0; i < n; i++) stepRagdoll(rd, 1 / 60, opts); }

// ---- construction ----
{
  const rd = createRagdoll();
  ok('16 particles', rd.particles.length === 16, `got ${rd.particles.length}`);
  ok('15 render bones', rd.bones.length === 15, `got ${rd.bones.length}`);
  ok('feet start on ground', Math.abs(jointPos(rd, 'footL').y) < 0.05 && Math.abs(jointPos(rd, 'footR').y) < 0.05);
  ok('head above feet', jointPos(rd, 'head').y > jointPos(rd, 'footL').y + 1.0);
  ok('proportions exported', RAGDOLL_PROPORTIONS.H === 1.8 && RAGDOLL_PROPORTIONS.R === 0.35);
}

// ---- spawn above ground: falls, lands, settles, stays finite, bones preserved ----
{
  const rd = createRagdoll({ origin: { x: 0, y: 3, z: 0 } });
  sim(rd, 6, { groundHeight: 0 });
  ok('no NaN after fall', finite(rd));
  ok('rigid bones preserved (<3%)', boneLengths(rd) < 0.03, `worst ${(boneLengths(rd) * 100).toFixed(2)}%`);
  const lowest = Math.min(...rd.particles.map(p => p.pos.y));
  ok('nothing tunnels through floor', lowest > -0.05, `lowest y ${lowest.toFixed(3)}`);
  ok('came to rest', isSettled(rd, 1e-4), `KE ${kineticEnergy(rd).toExponential(2)}`);
  const highest = Math.max(...rd.particles.map(p => p.pos.y));
  ok('collapsed to a corpse (top < 1.2m)', highest < 1.2, `highest y ${highest.toFixed(2)}`);
}

// ---- energy decays monotonically-ish once fallen (no explosion) ----
{
  const rd = createRagdoll({ origin: { x: 0, y: 2, z: 0 } });
  sim(rd, 3, { groundHeight: 0 });
  sim(rd, 3, { groundHeight: 0 });
  // No runaway: after settling, energy stays near the floor (hard cone clamps add tiny jitter, not growth).
  const e2 = kineticEnergy(rd);
  ok('energy stays bounded (no runaway)', e2 < 1e-3, `e2 ${e2.toExponential(2)}`);
}

// ---- impulse response: a hit injects energy into a settled body, stays finite ----
{
  const rd = createRagdoll({ origin: { x: 0, y: 0, z: 0 } });
  sim(rd, 4, { groundHeight: 0 });
  const eSettled = kineticEnergy(rd);
  applyImpulse(rd, 'chest', { x: 8, y: 4, z: 0 });
  const eHit = kineticEnergy(rd);
  ok('single-joint impulse injects energy', eHit > eSettled + 1e-4, `settled ${eSettled.toExponential(2)} hit ${eHit.toExponential(2)}`);
  sim(rd, 1, { groundHeight: 0 });
  ok('finite after impulse', finite(rd));
}

// ---- whole-body shove slides the corpse ----
{
  const rd = createRagdoll({ origin: { x: 0, y: 0, z: 0 } });
  sim(rd, 4, { groundHeight: 0 });
  const before = jointPos(rd, 'pelvis').x;
  applyImpulseAll(rd, { x: 6, y: 0, z: 0 });
  sim(rd, 0.5, { groundHeight: 0 });
  ok('body shove slides pelvis', jointPos(rd, 'pelvis').x - before > 0.15, `dx ${(jointPos(rd, 'pelvis').x - before).toFixed(3)}`);
}

// ---- blast knockback lifts the whole body ----
{
  const rd = createRagdoll({ origin: { x: 0, y: 0, z: 0 } });
  sim(rd, 4, { groundHeight: 0 });
  const beforeY = jointPos(rd, 'pelvis').y;
  applyImpulseAll(rd, { x: 0, y: 12, z: 0 });
  stepRagdoll(rd, 1 / 60, { groundHeight: 0 });
  ok('blast lifts pelvis off floor', jointPos(rd, 'pelvis').y > beforeY + 0.05);
}

// ---- sloped ground (heightAt fn): still lands, no tunneling ----
{
  const ground = (x) => x * 0.2;                 // gentle ramp
  const rd = createRagdoll({ origin: { x: 5, y: 3, z: 0 } });
  sim(rd, 6, { groundHeight: ground });
  ok('finite on slope', finite(rd));
  const clear = rd.particles.every(p => p.pos.y >= ground(p.pos.x) + p.radius - 0.05);
  ok('rests above sloped floor', clear);
}

// ---- seedRagdollFromJoints: adopts an external pose, recomputes rest, settles cleanly ----
{
  // Build a plausible external joint pose by reading a fresh standing ragdoll's own joints,
  // then nudging every joint (simulates a body posed elsewhere with slightly different lengths).
  const src = createRagdoll({ origin: { x: 2, y: 0, z: -1 }, yaw: 0.8 });
  const J = {};
  for (const p of src.particles) J[p.name] = { x: p.pos.x * 1.03, y: p.pos.y * 1.03, z: p.pos.z * 1.03 };

  const rd = createRagdoll();                    // built at a different origin/pose
  seedRagdollFromJoints(rd, J);
  ok('seed places joints at the given pose', Math.abs(jointPos(rd, 'head').x - J.head.x) < 1e-9 && Math.abs(jointPos(rd, 'pelvis').y - J.pelvis.y) < 1e-9);

  // recomputeRest should make rigid bones match the seeded distances (no first-solve pop).
  let worstRigid = 0;
  for (const c of rd.constraints) {
    if (c.min !== c.max) continue;
    const a = J[rd.particles[c.a].name], b = J[rd.particles[c.b].name];
    const seeded = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    worstRigid = Math.max(worstRigid, Math.abs(c.min - seeded) / seeded);
  }
  ok('recomputeRest matches seeded bone lengths (<0.1%)', worstRigid < 1e-3, `worst ${(worstRigid * 100).toFixed(3)}%`);

  const eStart = kineticEnergy(rd);
  ok('seeded pose starts at rest (no injected velocity)', eStart < 1e-9, `KE ${eStart.toExponential(2)}`);
  sim(rd, 6, { groundHeight: 0 });
  ok('seeded ragdoll settles without exploding', finite(rd) && isSettled(rd, 1e-4));
}

// ---- joint limits: head cone stops the backward snap ----
{
  // Seed a pose with the head yanked hard behind the spine, then relax with no gravity.
  const rd = createRagdoll();
  const J = {}; for (const p of rd.particles) J[p.name] = { ...p.pos };
  const neck = J.neck, chest = J.chest;
  J.head = { x: neck.x, y: neck.y - 0.1, z: neck.z - 0.5 };   // snapped backward/down
  seedRagdollFromJoints(rd, J);
  sim(rd, 1, { gravity: 0, groundHeight: -100 });
  // angle between (neck->head) and (chest->neck spine) must be within the cone (~55°) + tolerance.
  const nk = jointPos(rd, 'neck'), hd = jointPos(rd, 'head'), ch2 = jointPos(rd, 'chest');
  const v1 = { x: hd.x - nk.x, y: hd.y - nk.y, z: hd.z - nk.z };
  const v2 = { x: nk.x - ch2.x, y: nk.y - ch2.y, z: nk.z - ch2.z };
  const dot = v1.x * v2.x + v1.y * v2.y + v1.z * v2.z;
  const ang = Math.acos(Math.max(-1, Math.min(1, dot / (Math.hypot(v1.x, v1.y, v1.z) * Math.hypot(v2.x, v2.y, v2.z) || 1)))) * 180 / Math.PI;
  ok('head cone limits backward snap (<70°)', ang < 70, `angle ${ang.toFixed(1)}°`);
  ok('cone finite/settled', finite(rd));
}

// ---- joint limits: knee cone caps how far the shin folds from the thigh ----
function boneAngle(root, pivot, child) {
  const ax = { x: pivot.x - root.x, y: pivot.y - root.y, z: pivot.z - root.z };
  const bx = { x: child.x - pivot.x, y: child.y - pivot.y, z: child.z - pivot.z };
  const dot = ax.x * bx.x + ax.y * bx.y + ax.z * bx.z;
  const m = Math.hypot(ax.x, ax.y, ax.z) * Math.hypot(bx.x, bx.y, bx.z) || 1;
  return Math.acos(Math.max(-1, Math.min(1, dot / m))) * 180 / Math.PI;
}
{
  const rd = createRagdoll();
  const J = {}; for (const p of rd.particles) J[p.name] = { ...p.pos };
  const hip = J.hipL, knee = J.kneeL;
  J.footL = { x: knee.x, y: knee.y + 0.3, z: knee.z };   // shin folded hard up (~180° from thigh)
  seedRagdollFromJoints(rd, J);
  sim(rd, 1, { gravity: 0, groundHeight: -100 });
  const ang = boneAngle(jointPos(rd, 'hipL'), jointPos(rd, 'kneeL'), jointPos(rd, 'footL'));
  ok('knee cone caps shin fold (<120°)', ang < 120, `angle ${ang.toFixed(1)}°`);
  ok('knee cone finite', finite(rd));
}

// ---- joint limits can be disabled ----
{
  const rd = createRagdoll({ jointLimits: false });
  ok('jointLimits:false disables limits', rd.limits.enabled === false);
  sim(rd, 3, { groundHeight: 0 });
  ok('still finite with limits off', finite(rd));
}

// ---- limits on: full fall still settles cleanly, bones preserved ----
{
  const rd = createRagdoll({ origin: { x: 0, y: 3, z: 0 } });
  ok('jointLimits default on', rd.limits.enabled === true);
  sim(rd, 6, { groundHeight: 0 });
  ok('settles with limits on', finite(rd) && isSettled(rd, 1e-4));
  ok('bones still preserved with limits on (<3%)', boneLengths(rd) < 0.03, `worst ${(boneLengths(rd) * 100).toFixed(2)}%`);
}

// ---- variable dt / big frame gap doesn't blow up (substep clamp) ----
{
  const rd = createRagdoll({ origin: { x: 0, y: 3, z: 0 } });
  stepRagdoll(rd, 0.5, { groundHeight: 0 });     // 0.5s in one call
  ok('survives a huge dt step', finite(rd));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
