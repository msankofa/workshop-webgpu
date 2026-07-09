import { cullInstance, classifyInstance, shouldRecull } from './forest-cull.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

// Camera at origin; camera-centered distance cull (v1, distance-only per SP2).
const cam0 = { x: 0, z: 0 };
const maxDist = 100;

ok(cullInstance({ x: 0, z: -20 }, cam0, maxDist) === true,  '2: in range kept');
ok(cullInstance({ x: 0, z: -200 }, cam0, maxDist) === false, '2: beyond maxDist culled');
ok(cullInstance({ x: 80, z: -80 }, cam0, maxDist) === false, '2: diagonal beyond radius culled');
ok(cullInstance({ x: 60, z: -60 }, cam0, maxDist) === true,  '2: diagonal within radius kept');

// ---- classifyInstance: frustum/cone + far-cutoff rejection (Milestones 2-3) ----
// Camera at origin, looking down -Z (forward = (0,-1) in XZ), ~60deg vertical-ish FOV, same
// fixture shape as dressing-cull.js's test-dressing-cull.mjs.
const cam = { x: 0, z: 0, fx: 0, fz: -1 };
const halfFov = (60 * Math.PI / 180) / 2;
const fovCos = Math.cos(halfFov);

const baseParams = {
  coneEnabled: true,
  coneMargin: 0.5,       // more conservative (wider) than dressing's 0.35 -- trees are large.
  fovCos,
  rearMargin: 0.1,       // small cosine tolerance past exactly-perpendicular before "behind".
  treeRadius: 4,         // per-variant canopy half-width (world units) at scale=1.
  scale: 1,
  maxDrawRadius: 900,
};

// (a) behind-camera instance rejected beyond a rear margin.
{
  const rec = { x: 0, z: 50 }; // straight behind (camera looks toward -Z)
  const r = classifyInstance(rec, cam, baseParams);
  ok(r.coneLive === false, 'a: straight-behind instance rejected by cone');
  ok(r.live === false, 'a: straight-behind instance not live overall');
}
{
  const rec = { x: 0, z: 5 }; // near but behind
  const r = classifyInstance(rec, cam, baseParams);
  ok(r.coneLive === false, 'a: near-but-behind instance also rejected by cone');
}

// (b) in-cone instance (well within the forward view, not near the edge) is kept.
{
  const rec = { x: 0, z: -40 }; // straight ahead
  const r = classifyInstance(rec, cam, baseParams);
  ok(r.coneLive === true, 'b: straight-ahead in-cone instance kept');
  ok(r.live === true, 'b: straight-ahead in-cone instance live overall');
}

// (c) edge instance within radius+margin kept (anti-pop): pick an angle just outside the RAW
// FOV but inside the padded cone (padding widened by both coneMargin AND the tree's own
// angular radius at this distance), confirming large canopies don't clip at screen edges.
{
  const dist = 50;
  const angularPad = Math.atan2(baseParams.treeRadius * baseParams.scale, dist);
  // Just outside the raw half-FOV angle, inside (half-FOV + angular tree pad) -- must survive
  // thanks to the per-instance radius padding alone (before even accounting for coneMargin).
  const theta = halfFov + angularPad * 0.5;
  const dirX = Math.sin(theta), dirZ = -Math.cos(theta);
  const rec = { x: dirX * dist, z: dirZ * dist };
  const r = classifyInstance(rec, cam, baseParams);
  ok(theta > halfFov, 'c: sanity -- test angle is actually outside raw FOV');
  ok(r.coneLive === true, 'c: edge instance within radius+margin kept (anti-pop)');
}

// (d) beyond max draw radius rejected outright (Milestone 3 hard far cutoff), even though it
// would otherwise be dead-ahead and well inside the cone.
{
  const rec = { x: 0, z: -1000 }; // straight ahead, but past maxDrawRadius=900
  const r = classifyInstance(rec, cam, baseParams);
  ok(r.farLive === false, 'd: beyond-max-radius instance rejected by far cutoff');
  ok(r.live === false, 'd: beyond-max-radius instance not live overall');
}
{
  const rec = { x: 0, z: -800 }; // within maxDrawRadius
  const r = classifyInstance(rec, cam, baseParams);
  ok(r.farLive === true, 'd: within-max-radius instance passes far cutoff');
}

// (e) cone disabled keeps everything radially/far-cutoff-eligible (backward compat) -- a
// straight-behind instance that the cone WOULD reject stays live when coneEnabled=false.
{
  const params = { ...baseParams, coneEnabled: false };
  const rec = { x: 0, z: 50 }; // behind camera
  const r = classifyInstance(rec, cam, params);
  ok(r.coneLive === true, 'e: cone check bypassed entirely when disabled');
  ok(r.live === true, 'e: behind-camera instance survives when cone culling is off');
}

// ---- shouldRecull: threshold-gated predicate (Milestone 4) ----
{
  const fwd = (deg) => { const r = deg * Math.PI / 180; return { fx: Math.sin(r), fz: -Math.cos(r) }; };
  const prev = { x: 0, z: 0, ...fwd(0) };

  // (f) 0.01-unit drift must NOT recull.
  ok(shouldRecull(prev, { x: 0.01, z: 0, ...fwd(0) }) === false, 'f: 0.01-unit drift does not recull');

  // (f) 2-unit move DOES recull (exceeds the 1.5-unit default move threshold).
  ok(shouldRecull(prev, { x: 2, z: 0, ...fwd(0) }) === true, 'f: 2-unit move triggers recull');

  // (f) 3-degree turn DOES recull (exceeds the 2-degree default heading threshold).
  ok(shouldRecull(prev, { x: 0, z: 0, ...fwd(3) }) === true, 'f: 3-degree turn triggers recull');

  // (f) forced-dirty always recculls, regardless of camera motion -- this is the caller's job
  // (host checks `dirty` before calling shouldRecull), but shouldRecull itself must also always
  // fire on first-ever call (no valid previous state).
  const nanPrev = { x: NaN, z: NaN, fx: NaN, fz: NaN };
  ok(shouldRecull(nanPrev, { x: 0, z: 0, ...fwd(0) }) === true, 'f: forced/first-frame (NaN prev) always recculls');

  // Just inside both thresholds stays skipped.
  ok(shouldRecull(prev, { x: 1.0, z: 0, ...fwd(1) }) === false, 'f: 1 unit + 1 degree stays under both thresholds');

  // Custom thresholds are honored.
  ok(shouldRecull(prev, { x: 0.2, z: 0, ...fwd(0) }, { moveDist: 0.1 }) === true, 'f: custom tighter moveDist triggers');
  ok(shouldRecull(prev, { x: 0, z: 0, ...fwd(1) }, { headingCos: Math.cos(0.5 * Math.PI / 180) }) === true, 'f: custom tighter heading threshold triggers');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
