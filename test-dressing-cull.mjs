import { classifyInstance } from './dressing-cull.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };
const near = (a, b, eps, m) => { if (Math.abs(a - b) <= eps) pass++; else { fail++; console.error('FAIL:', m, `(got ${a}, want ~${b})`); } };

// Camera at origin, looking down -Z (forward = (0, -1) in XZ), standard-ish FOV.
const cam = { x: 0, z: 0, fx: 0, fz: -1 };
const fovCos = Math.cos(THREE_HALF_FOV()); // helper below, avoids importing three in a Node test
function THREE_HALF_FOV() { return (60 * Math.PI / 180) / 2; } // ~60deg vertical-ish half-angle for the test fixture

const baseParams = {
  cullRadius: 100,
  cullStart: 70,
  keepRand: 0.999, // always "wins" the dither roll unless edge is also ~1
  coneEnabled: true,
  coneMargin: 0.35, // wide, generous padding cosine (task default)
  fovCos,
  rearMargin: 0.5,
};

// (a) behind-camera instance rejected beyond a rear margin.
// Directly behind the camera (world +Z, camera looks toward -Z) at a comfortably far distance
// so it's unambiguously outside even a heavily padded forward cone.
{
  const rec = { x: 0, z: 50 }; // straight behind
  const r = classifyInstance(rec, cam, baseParams);
  ok(r.coneLive === false, 'a: straight-behind instance rejected by cone');
  ok(r.live === false, 'a: straight-behind instance not live overall');
}
{
  // Slightly behind but near the camera should still be handled consistently (not a special
  // case) -- the cone test is angle-only, not distance-gated for the rear check.
  const rec = { x: 0, z: 5 };
  const r = classifyInstance(rec, cam, baseParams);
  ok(r.coneLive === false, 'a: near-but-behind instance also rejected by cone');
}

// (b) instance at screen edge inside the padded cone is kept.
// fovCos with 0.35 margin allows a cosine down to fovCos-0.35, i.e. wider than the raw FOV --
// pick an angle that is just outside the RAW fov but inside the PADDED cone.
{
  const halfFov = THREE_HALF_FOV();
  const rawCos = Math.cos(halfFov);
  const paddedCos = rawCos - 0.35;
  // Pick an angle whose cosine sits strictly between paddedCos and rawCos (inside padded cone,
  // outside raw FOV) -- confirms padding actually widens acceptance vs. a naive raw-FOV check.
  const targetCos = (rawCos + paddedCos) / 2;
  const theta = Math.acos(targetCos); // angle from forward axis
  // forward is (0,-1); rotate by theta around Y to place instance at the screen edge.
  const dirX = Math.sin(theta), dirZ = -Math.cos(theta);
  const dist = 50;
  const rec = { x: dirX * dist, z: dirZ * dist };
  const r = classifyInstance(rec, cam, baseParams);
  ok(r.coneLive === true, 'b: screen-edge instance inside padded cone kept');
  ok(targetCos < rawCos, 'b: sanity -- test angle is actually outside raw FOV');
}

// (c) radial limit and fade behavior unchanged by the new path -- cone disabled OR camera facing
// directly at the instance so cone never rejects it, isolating the pre-existing radial/fade math.
{
  const params = { ...baseParams, coneEnabled: false };
  const inRange = classifyInstance({ x: 0, z: -20 }, cam, { ...params, keepRand: 0.999 });
  ok(inRange.dist === 20, 'c: distance computed correctly');
  ok(inRange.radialLive === true, 'c: within cullStart is radially live');
  ok(inRange.live === true, 'c: cone disabled -- overall live matches radial');

  const beyond = classifyInstance({ x: 0, z: -150 }, cam, { ...params, keepRand: 0.999 });
  ok(beyond.radialLive === false, 'c: beyond cullRadius is radially dead');
  ok(beyond.live === false, 'c: cone disabled -- overall dead matches radial');

  // Fade band: dist=85 is between cullStart=70 and cullRadius=100 -> edge=0.5.
  const faded = classifyInstance({ x: 0, z: -85 }, cam, { ...params, keepRand: 0.5 });
  near(faded.edge, 0.5, 1e-9, 'c: edge fraction computed at midpoint of fade band');
  ok(faded.radialLive === false, 'c: keepRand equal to edge does not beat the dither (strict greaterThan)');
  const fadedWin = classifyInstance({ x: 0, z: -85 }, cam, { ...params, keepRand: 0.51 });
  ok(fadedWin.radialLive === true, 'c: keepRand just above edge survives the dither');
}

// (d) cone disable flag keeps everything (backward compat) -- a straight-behind instance that
// the cone WOULD reject stays live when coneEnabled=false, as long as it's radially in range.
{
  const params = { ...baseParams, coneEnabled: false, keepRand: 0.999 };
  const rec = { x: 0, z: 50 }; // behind camera, but within cullRadius
  const r = classifyInstance(rec, cam, params);
  ok(r.coneLive === true, 'd: cone check is bypassed entirely when disabled');
  ok(r.live === true, 'd: behind-camera instance survives when cone culling is off');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
