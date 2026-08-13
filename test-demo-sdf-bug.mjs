// node test-demo-sdf-bug.mjs
//
// Covers `demos/bug-sdf.js`, the CPU twin of the bug-on-a-sprout distance field drawn by
// `demos/sdf-bug.html`.
//
// What this CANNOT check: that the marched FIELD agrees with the TSL it mirrors, or that the picture looks
// like the reference photo. Nothing in Node runs a fragment shader. Same limitation
// `test-demo-creature-sdf.mjs`, `test-post-grade.mjs` and `test-forest-cull.mjs` carry.
//
// One exception, in section 6c: the antenna placement is plain scalar arithmetic that happens to be written
// in TSL, so the shader's own constants are read out of the page and the same steps run over them here.
// That closes the drift gap for the one part of the model that has been rewritten three times.
//
// What it CAN check is everything about that demo that is arithmetic rather than taste, and each one
// is a failure a screenshot hides:
//
//   - the feet reach the leaf at every leg spread and every phase of the idle cycle;
//   - the whole bug stays inside the bounding sphere its march is confined to, at the extremes of
//     every slider — outside it, a part of the model silently stops being drawn;
//   - the accelerated primary trace agrees with a slow march of the same field, so the analytic leaf
//     and the bounded bug march have not lost a surface between them;
//   - the field is flat enough for the step factor the shader ships, so rays do not tunnel.

import fs from 'node:fs';
import {
  sdSphere, sdEllipsoid, sdSegTaper, sminD, sminHard, opU, smoothstep, taperSlope,
  bugSdf, sceneSdf, sproutSdf, sproutTopY, sproutCenter, shellGroove, gradientMag,
  footPos, cameraRay, sphereHit, traceBug, traceScene, marchNaive, antennaBase, antennaDir,
  DEFAULT_ANATOMY, DEFAULT_VIEW, LEGS, EYE, ANTENNA, BUG_BOUND,
  ID_SHELL, ID_HEAD, ID_EYE, ID_LEG, ID_ANT, ID_SPROUT,
  STEP_FACTOR, MAX_GRADIENT, MAX_TAPER_SLOPE, TAPER_SAFETY, FOOT_SINK, MARCH_STEPS,
  ANTENNA_HEIGHT_RANGE, ANTENNA_ANGLE_RANGE, ANTENNA_HORIZ, ANTENNA_BEARING, ANTENNA_CLEAR, ANTENNA_LEN,
} from './demos/bug-sdf.js';

let checks = 0, failures = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) { failures++; console.error('  FAIL:', msg); }
}
function near(a, b, tol, msg) { ok(Math.abs(a - b) <= tol, `${msg} (got ${a}, want ${b} +/- ${tol})`); }
function section(name) { console.log(name); }

const A = DEFAULT_ANATOMY;
const BUG_IDS = new Set([ID_SHELL, ID_HEAD, ID_EYE, ID_LEG, ID_ANT]);

/**
 * Height of a surface directly above (x, z), by bisection on a field. `lo` has to start INSIDE the
 * shape — below the bug is outside it again, and a bracket with the same sign at both ends silently
 * converges on nothing.
 */
function surfaceHeight(field, x, z, hi = 1.2, lo = 0.33) {
  let a = hi, b = lo;
  if (field(x, a, z) < 0 || field(x, b, z) > 0) return null;
  for (let i = 0; i < 60; i++) {
    const m = (a + b) / 2;
    if (field(x, m, z) > 0) a = m; else b = m;
  }
  return (a + b) / 2;
}

// ---------------------------------------------------------------------------
section('1. primitives');
// ---------------------------------------------------------------------------

near(sdSphere(0.3, 0, 0, 0.3), 0, 1e-12, 'sphere is zero on its own surface');
near(sdEllipsoid(0.5, 0, 0, 0.5, 0.5, 0.5), 0, 1e-9, 'sphere-as-ellipsoid is zero on its surface');
ok(sdEllipsoid(0.1, 0, 0, 0.285, 0.255, 0.36) < 0, 'inside the abdomen bound is negative');
ok(sdEllipsoid(1, 0, 0, 0.285, 0.255, 0.36) > 0, 'outside the abdomen bound is positive');

// The tapered capsule, which is this demo's addition over sdf-creature.html's +Y round cone.
{
  const a = [0, 0, 0], b = [0, 1, 0];
  near(sdSegTaper([0.05, 0.5, 0], a, b, 0.05, 0.05) / TAPER_SAFETY, 0, 1e-9,
    'equal-radius taper is a capsule: zero at r from the axis');
  ok(sdSegTaper([0, 0.5, 0], a, b, 0.05, 0.05) < 0, 'on the axis is inside');
  ok(sdSegTaper([0, 1.4, 0], a, b, 0.05, 0.05) > 0, 'past the far cap is outside');
  near(sdSegTaper([0.035, 0.75, 0], a, b, 0.08, 0.02) / TAPER_SAFETY, 0, 1e-9,
    'the radius is interpolated along the segment');
  ok(Number.isFinite(sdSegTaper([0.1, 0, 0], a, a, 0.05, 0.05)), 'a zero-length segment stays finite');
  // The safety factor exists to make this an under-estimate. Over-estimating is what lets a march
  // step past a surface no matter how small the step factor is.
  ok(sdSegTaper([0.2, 0.5, 0], a, b, 0.05, 0.05) < 0.2 - 0.05,
    'the safety factor makes the taper under-estimate the true distance');
  near(TAPER_SAFETY, 1 / Math.sqrt(1 + MAX_TAPER_SLOPE ** 2), 5e-3,
    'TAPER_SAFETY is the cone bound at MAX_TAPER_SLOPE, not a guess');
}

near(sminD(0.4, 0.4, 0.2), 0.4 - 0.2 * 0.25, 1e-12, 'a smooth union of two equal distances dips by k/4');
ok(sminD(0.1, 0.5, 0.2) <= 0.1, 'a smooth union never reports more than the nearer surface');
ok(opU([0.5, ID_SHELL], [0.2, ID_EYE])[1] === ID_EYE, 'a hard union carries the nearer id');
ok(sminHard([0.1, ID_SHELL], [0.9, ID_LEG], 0.2)[1] === ID_SHELL, 'sminHard switches, never ramps');
near(smoothstep(0.26, 0.52, 0.26), 0, 1e-12, 'smoothstep is 0 at its lower edge');
near(smoothstep(0.26, 0.52, 0.52), 1, 1e-12, 'smoothstep is 1 at its upper edge');

// Ray/sphere, which is now the whole of the leaf's intersection.
{
  const s = sphereHit([0, 0, -5], [0, 0, 1], [0, 0, 0], 1);
  near(s[0], 4, 1e-12, 'a head-on ray enters a unit sphere at 4');
  near(s[1], 6, 1e-12, 'and leaves it at 6');
  ok(sphereHit([0, 3, -5], [0, 0, 1], [0, 0, 0], 1) === null, 'a ray that misses reports a miss');
  // Tangency is the case that made this analytic in the first place: exact here, a stall in a march.
  const tan = sphereHit([0, 1, -5], [0, 0, 1], [0, 0, 0], 1);
  ok(tan !== null && Math.abs(tan[0] - 5) < 1e-6, 'a tangent ray is solved exactly rather than stalling');
}

// ---------------------------------------------------------------------------
section('2. material ids are palette-safe');
// ---------------------------------------------------------------------------

// sdf-creature.html's lesson, re-asserted: only the pair joined by a BLENDING union may be
// non-integer at a seam, and that pair must be adjacent or the blend walks through other entries.
ok(Math.abs(ID_SHELL - ID_HEAD) === 1, 'SHELL and HEAD are adjacent — they are the only blended pair');
{
  const ids = [ID_SHELL, ID_HEAD, ID_EYE, ID_LEG, ID_ANT, ID_SPROUT];
  ok(new Set(ids).size === ids.length, 'every material id is distinct');
  // The palette weight band is one slot wide, so any non-neighbour must contribute exactly nothing.
  const wOf = (matId, k) => smoothstep(1, 0, Math.abs(matId - k));
  let clean = true;
  for (const id of ids) for (const k of ids) {
    const w = wOf(id, k);
    if (k === id ? w !== 1 : w !== 0) clean = false;
  }
  ok(clean, 'every integer id resolves to exactly one palette entry, with no contamination');
  let walkClean = true;
  for (let s = 0; s <= 40; s++) {
    const blended = ID_SHELL + (ID_HEAD - ID_SHELL) * (s / 40);
    for (const k of [ID_EYE, ID_LEG, ID_ANT, ID_SPROUT]) if (wOf(blended, k) > 0) walkClean = false;
  }
  ok(walkClean, 'the SHELL/HEAD blend never picks up a third material');
}

// ---------------------------------------------------------------------------
section('3. the leaf');
// ---------------------------------------------------------------------------

near(sproutTopY(0, 0, A), 0, 1e-12, 'the crown of the leaf is the origin of bug space');
ok(sproutSdf(0, 0.2, 0, A) > 0, 'above the crown is outside the leaf');
ok(sproutSdf(0, -0.2, 0, A) < 0, 'below the crown is inside the leaf');
ok(sproutTopY(1.2, 0, A) < sproutTopY(0.4, 0, A), 'the crown falls away with distance');
// Exactness is the point of making the leaf a bare sphere: it holds everywhere, not just under the bug.
{
  let worst = 0;
  for (let i = 0; i <= 60; i++) for (let k = 0; k <= 60; k++) {
    const x = -2.2 + (4.4 * i) / 60, z = -2.2 + (4.4 * k) / 60;
    if (Math.hypot(x, z) > A.sproutR * 0.97) continue;
    worst = Math.max(worst, Math.abs(sproutSdf(x, sproutTopY(x, z, A), z, A)));
  }
  console.log(`   sproutTopY lands on the surface to within ${worst.toExponential(1)}`);
  ok(worst < 1e-9, 'sproutTopY is exact everywhere on the leaf, not just under the bug');
}
near(sproutCenter(A)[1], -A.sproutR, 1e-12, 'the leaf is tangent to y = 0');

// ---------------------------------------------------------------------------
section('4. the feet reach the leaf');
// ---------------------------------------------------------------------------

// The failure this catches: a bug hovering a centimetre off the leaf. At this framing that reads as a
// slightly soft contact shadow, not as a mistake.
{
  let allPlanted = true;
  for (const spread of [0.75, 0.9, 1.0, 1.1, 1.25]) {
    for (const time of [0, 0.4, 1.1, 2.7]) {
      const params = { ...A, legSpread: spread, time };
      for (const [i, leg] of LEGS.entries()) {
        const foot = footPos(leg, params);
        const footR = leg.r[2];
        const d = sproutSdf(foot[0], foot[1], foot[2], params);
        // The tip is a ball of radius footR. Contact means the leaf's surface is inside that ball
        // (d < footR) but has not swallowed its centre (d > 0).
        if (!(d > 0 && d < footR)) {
          allPlanted = false;
          console.error(`  leg ${i} at spread ${spread}, t=${time}: leaf distance ${d.toFixed(5)}, foot radius ${footR}`);
        }
        // The leaf curves away under the foot, so the vertical offset is not quite the perpendicular
        // distance. A third of a millimetre of slack covers that; a wrong FOOT_SINK would not fit in it.
        near(d, footR * (1 - FOOT_SINK), 3e-4,
          `leg ${i} sinks FOOT_SINK of its tip into the leaf (spread ${spread})`);
        ok(bugSdf(foot[0], foot[1], foot[2], params)[0] < 0,
          `leg ${i} foot centre is inside the leg (spread ${spread}, t=${time})`);
      }
    }
  }
  ok(allPlanted, 'every foot at every leg spread and every phase of the idle cycle touches the leaf');
}

// The idle bob must not lift the stance. This is why the bob is applied to the hips and not the feet.
{
  const f0 = footPos(LEGS[0], { ...A, time: 0 });
  const f1 = footPos(LEGS[0], { ...A, time: 1.43 });
  near(f0[1], f1[1], 1e-12, 'the idle bob never moves a foot');
}

// The belly has to clear the leaf, or the bug is sunk into it and the legs are decorative.
{
  let minClear = Infinity;
  for (let i = 0; i <= 24; i++) {
    const z = -0.46 + (0.66 * i) / 24;
    const y = sproutTopY(0, z, A);
    let clear = 0.4;
    for (let k = 0; k < 400; k++) {
      if (bugSdf(0, y + k * 0.001, z, A)[0] < 0) { clear = k * 0.001; break; }
    }
    minClear = Math.min(minClear, clear);
  }
  console.log(`   belly clearance over the leaf: ${(minClear * 100).toFixed(1)} cm`);
  ok(minClear > 0.02, 'the body clears the leaf by more than 2 cm — the legs carry it');
  ok(minClear < 0.16, 'and by less than 16 cm — it is a bug crouched on a leaf, not a spider');
}

// ---------------------------------------------------------------------------
section('5. the shell groove actually grooves');
// ---------------------------------------------------------------------------

{
  // A displacement added to the field pushes the surface INWARD. Getting the sign backwards raises a
  // ridge instead, which still looks like a line down the shell in a screenshot and is wrong. The
  // comparison has to be against the same body with the groove switched off — comparing the midline
  // to a point out on the flank measures the shell's curvature, not the groove.
  const zMid = -0.12;
  const flat = (x) => surfaceHeight((px, py, pz) => bugSdf(px, py, pz, { ...A, grooveDepth: 0 })[0], x, zMid);
  const cut = (x) => surfaceHeight((px, py, pz) => bugSdf(px, py, pz, A)[0], x, zMid);
  ok(flat(0) !== null && cut(0) !== null && flat(0.18) !== null && cut(0.18) !== null,
    'the bisection brackets a shell surface on the midline and on the flank');
  const onAxis = flat(0) - cut(0);
  const offAxis = flat(0.18) - cut(0.18);
  console.log(`   groove depth: ${(onAxis * 1000).toFixed(1)} mm on the midline, ${(offAxis * 1000).toFixed(2)} mm at x = 0.18`);
  ok(onAxis > 0, 'the groove lowers the midline rather than raising a ridge');
  ok(onAxis > A.grooveDepth * 0.8, 'and lowers it by most of the authored depth');
  ok(offAxis < onAxis * 0.1, 'the groove is a narrow line, not a general shrink of the shell');
  // Outside its gates the groove must vanish, or the head gets a slot in it.
  near(shellGroove(0, 0.45, 0.45, A), 0, 1e-12, 'no groove forward of the pronotum');
  near(shellGroove(0, 0.45, -0.6, A), 0, 1e-12, 'no groove behind the abdomen');
  near(shellGroove(0, 0.1, -0.12, A), 0, 1e-12, 'no groove on the underside');
}

// ---------------------------------------------------------------------------
section('6. the eyes are domes, not decals');
// ---------------------------------------------------------------------------

{
  // The eye is hard-unioned so its rim stays crisp — but that only reads as an eye if the sphere
  // actually breaks the head's surface. Buried, the shading paints an iris onto flat skin.
  const c = [EYE.at[0], EYE.at[1], EYE.at[2]];
  const out = [0.771, 0.194, 0.393];               // roughly the head's outward direction there
  const ol = Math.hypot(...out);
  const dir = out.map((v) => v / ol);
  const at = (s) => bugSdf(c[0] + dir[0] * s, c[1] + dir[1] * s, c[2] + dir[2] * s, A);
  ok(at(EYE.r * 0.85)[0] < 0, 'inside the eyeball is inside the bug');
  ok(at(EYE.r * 1.3)[0] > 0, 'past the eyeball is outside the bug');
  ok(at(EYE.r * 0.9)[1] === ID_EYE, 'the eyeball owns its own surface');
  const noEye = bugSdf(c[0] + dir[0] * EYE.r, c[1] + dir[1] * EYE.r, c[2] + dir[2] * EYE.r,
    { ...A, eyeSize: 0.01 });
  ok(noEye[0] > 0, 'the eyeball protrudes past the head — it is a dome, not a patch');
  const left = bugSdf(-c[0], c[1], c[2], A);
  const right = bugSdf(c[0], c[1], c[2], A);
  near(left[0], right[0], 1e-12, 'the mirror gives two eyes, not one');
}

// ---------------------------------------------------------------------------
section('6b. the antennae never grow out of the eyes');
// ---------------------------------------------------------------------------

{
  // THE BUG THIS EXISTS FOR shipped, and was reported from the browser: the antenna root was authored
  // at a fixed point 0.041 from the eye centre, inside an eyeball of radius 0.086, so both antennae
  // emerged from the eyes. Nothing in the field is wrong when that happens — the union is valid, the
  // march is correct, the gradient is fine — it is purely an authoring collision between two parts, and
  // no test here was looking at pairs of parts.
  //
  // THREE controls interact here and every pair of them has produced this defect at some point, so the
  // sweep is a 3-D grid rather than one slider at a time: `eyeSize` grows the obstacle, `antennaHeight`
  // moves the root, and `antennaAngle` aims the shaft. "Safe at every setting of each one alone" is not
  // the property that matters — a root well clear of the eye still buried the shaft 57 mm into it once
  // the pitch could be cranked the opposite way.
  const [hLo, hHi] = ANTENNA_HEIGHT_RANGE;
  const [aLo, aHi] = ANTENNA_ANGLE_RANGE;

  // CLEARANCE IS MEASURED IN MIRRORED SPACE, with abs(x), because that is how the field evaluates it.
  // Everything paired in this model is one expression mirrored, so a shaft at negative x is really its own
  // reflection walking into the OPPOSITE eye. Measuring the raw x against the +x eye hid exactly that: it
  // reported 33 mm of room at a point the field had 7 mm inside the eyeball, and the mistake looked like a
  // false alarm in the material check rather than like a real collision.
  const eyeGap = (p, eyeSize) =>
    Math.hypot(Math.abs(p[0]) - EYE.at[0], p[1] - EYE.at[1], p[2] - EYE.at[2]) - EYE.r * eyeSize;

  const scan = (overshoot, steps) => {
    const span = (lo, hi, t) => lo - overshoot * (hi - lo) + (hi - lo) * (1 + 2 * overshoot) * t;
    const r = {
      points: 0, worstRoot: Infinity, worstRootAt: null, worstShaft: Infinity, worstShaftAt: null,
      worstBody: -Infinity, worstBodyAt: null, crossings: 0, sawEye: null, worstBend: 0, worstBendAt: null,
    };
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps; j++) {
        for (const eyeSize of [0.5, 1.0, 1.5, 1.7]) {
          const h = span(hLo, hHi, i / steps);
          const angle = span(aLo, aHi, j / steps);
          const params = { ...A, eyeSize, antennaHeight: h, antennaAngle: angle };
          const root = antennaBase(params);
          const dir = antennaDir(params);
          const label = `height ${h.toFixed(2)}, angle ${angle.toFixed(2)}, eyeSize ${eyeSize.toFixed(2)}`;
          r.points++;

          const dRoot = eyeGap(root, eyeSize);
          if (dRoot < r.worstRoot) { r.worstRoot = dRoot; r.worstRootAt = label; }

          // The root also has to stay buried in the body, or the antenna floats with only a 0.018 fillet
          // reaching for it. This is what bounds the height slider.
          const buried = bugSdf(root[0], root[1], root[2], { ...params, antennaLen: 0 })[0];
          if (buried > r.worstBody) { r.worstBody = buried; r.worstBodyAt = label; }

          // The WHOLE SHAFT, not just its root — the distinction the pitch slider made load-bearing.
          for (let s = 0; s <= 30; s++) {
            const p = root.map((v, k) => v + dir[k] * (s / 30));
            if (p[0] < 0) r.crossings++;
            const cl = eyeGap(p, eyeSize);
            if (cl < r.worstShaft) { r.worstShaft = cl; r.worstShaftAt = label; }
            // Also as a material test, because that is what the screenshot showed. BOTH conditions are
            // needed: `bugSdf` returns the id of the NEAREST surface, so a point well outside a large
            // eyeball still reports ID_EYE whenever the eye happens to be the closest thing to it.
            const at = bugSdf(p[0], p[1], p[2], params);
            if (at[0] < 0 && Math.round(at[1]) === ID_EYE) r.sawEye ??= label;
          }

          // How far the avoidance had to bend the pitch from what was asked. Zero almost everywhere.
          const c = Math.cos(angle);
          const asked = [ANTENNA_HORIZ[0] * c, Math.sin(angle), ANTENNA_HORIZ[1] * c];
          const dl = Math.hypot(...dir) || 1;
          const bend = Math.acos(Math.min(1, Math.max(-1,
            asked.reduce((t, v, k) => t + v * (dir[k] / dl), 0))));
          if (bend > r.worstBend) { r.worstBend = bend; r.worstBendAt = label; }
        }
      }
    }
    return r;
  };

  const inRange = scan(0, 16);
  console.log(`   ${inRange.points} combinations of height, pitch and eye size`);
  console.log(`   tightest root-to-eyeball clearance : ${(inRange.worstRoot * 1000).toFixed(1)} mm at ${inRange.worstRootAt}`);
  console.log(`   tightest SHAFT-to-eyeball clearance: ${(inRange.worstShaft * 1000).toFixed(1)} mm at ${inRange.worstShaftAt}`);
  console.log(`   shallowest the root is ever buried : ${(inRange.worstBody * 1000).toFixed(1)} mm at ${inRange.worstBodyAt}`);
  console.log(`   largest pitch correction the avoidance made: ${(inRange.worstBend * 180 / Math.PI).toFixed(1)}° at ${inRange.worstBendAt}`);
  ok(inRange.worstRoot > 0.008, 'the root clears the eyeball at every height, pitch and eye size');
  ok(inRange.worstShaft > 0.008, 'and so does every point along the shaft, by more than 8 mm');
  ok(inRange.worstBody < -0.004, 'the root stays inside the body across all three controls');
  ok(inRange.crossings === 0,
    `the shaft never crosses the mirror plane, where its own reflection is (${inRange.crossings} samples did)`);
  ok(inRange.sawEye === null, `no point on the antenna is ever inside the eye (failed at ${inRange.sawEye})`);

  // BEYOND the sliders, recorded rather than asserted. The two constraints genuinely conflict out there:
  // once the eye subtends a wide enough angle from the root, no forward-pointing pitch clears it, and the
  // cap that stops the shaft reversing across the midline wins over the avoidance. The UI cannot reach
  // these values — this is here so that a future change to either range knows what it is spending.
  const beyond = scan(0.15, 8);
  console.log(`   15% past both ends: clearance falls to ${(beyond.worstShaft * 1000).toFixed(1)} mm ` +
    `(${beyond.worstShaft > 0.008 ? 'still clear' : 'grazing'}), root still buried at ${(beyond.worstBody * 1000).toFixed(1)} mm`);
  ok(beyond.crossings === 0, 'and even out there the shaft never reverses across the midline');
  ok(beyond.worstBody < -0.004, 'nor does the root leave the body, because its placement cannot escape the head');

  // The avoidance must be inert where it is not needed, or the pitch slider would feel disconnected.
  const straight = antennaDir({ ...A, antennaAngle: 0, antennaHeight: 0 });
  const sl = Math.hypot(...straight);
  const askedFlat = [ANTENNA_HORIZ[0], 0, ANTENNA_HORIZ[1]];
  near(askedFlat.reduce((t, v, k) => t + v * (straight[k] / sl), 0), 1, 1e-9,
    'at the default height a level pitch is passed through untouched');

  // Both sliders have to actually do something, in the direction their names claim.
  const low = antennaBase({ ...A, antennaHeight: hLo });
  const high = antennaBase({ ...A, antennaHeight: hHi });
  ok(low[1] < high[1], 'the height slider raises the root');
  console.log(`   root height runs ${low[1].toFixed(3)} to ${high[1].toFixed(3)}, eye centre at ${EYE.at[1]}`);
  ok(high[1] > EYE.at[1] + EYE.r * 0.5, 'the top of its range clears the eye centre by half a radius');
  ok(low[1] < EYE.at[1] - EYE.r, 'and the bottom reaches below the eye entirely');
  const dirDown = antennaDir({ ...A, antennaAngle: aLo });
  const dirUp = antennaDir({ ...A, antennaAngle: aHi });
  ok(dirDown[1] < dirUp[1], 'the pitch slider tilts the shaft');
  console.log(`   shaft rise runs ${dirDown[1].toFixed(3)} to ${dirUp[1].toFixed(3)} over the pitch range`);
}

// ---------------------------------------------------------------------------
section('6c. the shader agrees with the twin, for the part that is not a shader');
// ---------------------------------------------------------------------------

{
  // The standing caveat on every twin in this repo is that nothing enforces agreement with the GPU code
  // it mirrors — `forest-cull.js`, `light-cluster.js` and `post-grade.js` all say so, and so does the
  // header of `bug-sdf.js`. For MOST of this field that is unavoidable: you cannot march a distance field
  // in Node and compare pixels.
  //
  // The antenna placement is different, and worth exploiting. It is plain scalar arithmetic that happens
  // to be written in TSL, so the shader's own constants can be read out of the page, the same steps run
  // over them here, and the two compared exactly. It closes the drift gap for the one part of this demo
  // that has now been rewritten three times.
  const html = fs.readFileSync(new URL('./demos/sdf-bug.html', import.meta.url), 'utf8');

  const scalar = (name) => {
    const m = html.match(new RegExp(`const ${name} = ([-\\d.]+);`));
    ok(m !== null, `the shader still declares ${name}`);
    return m ? parseFloat(m[1]) : NaN;
  };
  const unit2Of = (name) => {
    const m = html.match(new RegExp(`const ${name} = unit2\\(([-\\d.]+), ([-\\d.]+)\\)`));
    ok(m !== null, `the shader still declares ${name} as a normalised pair`);
    if (!m) return [NaN, NaN];
    const [a, b] = [parseFloat(m[1]), parseFloat(m[2])];
    const n = Math.hypot(a, b);
    return [a / n, b / n];
  };
  const authored = html.match(/const AUTHORED_DIR = \[([-\d.]+), ([-\d.]+), ([-\d.]+)\]/);
  const eyeM = html.match(/const EYE = \{ at: \[([-\d.]+), ([-\d.]+), ([-\d.]+)\], r: ([-\d.]+) \}/);
  const headM = html.match(
    /const HEAD = \{ at: \[([-\d.]+), ([-\d.]+), ([-\d.]+)\], r: \[([-\d.]+), ([-\d.]+), ([-\d.]+)\] \}/);
  ok(authored && eyeM && headM, 'the shader still declares AUTHORED_DIR, EYE and HEAD in the expected shape');

  if (authored && eyeM && headM) {
    const D = [+authored[1], +authored[2], +authored[3]];
    const S = {
      EYE_AT: [+eyeM[1], +eyeM[2], +eyeM[3]],
      EYE_R: +eyeM[4],
      HEAD_AT: [+headM[1], +headM[2], +headM[3]],
      HEAD_R: [+headM[4], +headM[5], +headM[6]],
      BEARING: unit2Of('ANTENNA_BEARING'),
      HORIZ: (() => { const n = Math.hypot(D[0], D[2]); return [D[0] / n, D[2] / n]; })(),
      LEN: Math.hypot(...D),
      DEPTH: scalar('ANTENNA_DEPTH'),
      RING_MIN: scalar('ANTENNA_RING_MIN'),
      CLEAR: scalar('ANTENNA_CLEAR'),
      MAX_PITCH: Math.PI / 2 - 0.05,
    };

    // The constants themselves must match, or the rest of this section compares two different models.
    near(S.EYE_R, EYE.r, 1e-12, 'shader and twin agree on the eye radius');
    for (let i = 0; i < 3; i++) near(S.EYE_AT[i], EYE.at[i], 1e-12, `shader and twin agree on eye centre [${i}]`);
    near(S.CLEAR, ANTENNA_CLEAR, 1e-12, 'shader and twin agree on the eye standoff');
    near(S.BEARING[0], ANTENNA_BEARING[0], 1e-12, 'shader and twin agree on the root bearing');
    near(S.HORIZ[0], ANTENNA_HORIZ[0], 1e-12, 'shader and twin agree on the shaft bearing');
    near(S.LEN, ANTENNA_LEN, 1e-12, 'shader and twin agree on the shaft length');

    // The shader's two steps, transcribed from the TSL rather than from the twin.
    const shaderRoot = (elev, eyeSize) => {
      const ring = Math.max(Math.sqrt(Math.max(1 - elev * elev, 0)), S.RING_MIN);
      const raw = [ring * S.BEARING[0], elev, ring * S.BEARING[1]];
      const rl = Math.max(Math.hypot(...raw), 1e-9);
      const n = raw.map((v) => v / rl);
      const rootRaw = S.HEAD_AT.map((c, i) => c + n[i] * S.DEPTH * S.HEAD_R[i]);
      const keep = S.EYE_R * eyeSize + S.CLEAR;
      const rv = rootRaw.map((p, i) => p - S.EYE_AT[i]);
      const rvLen = Math.max(Math.hypot(...rv), 1e-5);
      return S.EYE_AT.map((c, i) => c + (rv[i] / rvLen) * Math.max(rvLen, keep));
    };
    const shaderDir = (elev, angle, eyeSize, antennaLen) => {
      const root = shaderRoot(elev, eyeSize);
      const keep = S.EYE_R * eyeSize + S.CLEAR;
      const toEye = S.EYE_AT.map((e, i) => e - root[i]);
      const wLen = Math.max(Math.hypot(...toEye), 1e-6);
      const P = toEye[0] * S.HORIZ[0] + toEye[2] * S.HORIZ[1];
      const Q = toEye[1];
      const M = Math.max(Math.hypot(P, Q), 1e-9);
      const psi = Math.atan2(Q, P);
      const half = Math.acos(Math.min(Math.max(
        Math.sqrt(Math.max(wLen * wLen - keep * keep, 0)) / M, -1), 1));
      const delta = angle - psi;
      const inBand = Math.abs(delta) <= half ? 1 : 0;              // TSL step(abs(delta), half)
      const sgn = delta > 0 ? 1 : (delta < 0 ? -1 : 0);
      const pitch = Math.min(Math.max(
        angle + (psi + sgn * half - angle) * inBand, -S.MAX_PITCH), S.MAX_PITCH);
      const l = S.LEN * antennaLen;
      return [S.HORIZ[0] * Math.cos(pitch) * l, Math.sin(pitch) * l, S.HORIZ[1] * Math.cos(pitch) * l];
    };

    let compared = 0, worstR = 0, worstD = 0, worstAt = null;
    for (let i = 0; i <= 16; i++) {
      for (let j = 0; j <= 16; j++) {
        for (const eyeSize of [0.6, 1.0, 1.5]) {
          for (const antennaLen of [0.6, 1.0, 1.5]) {
            const h = ANTENNA_HEIGHT_RANGE[0]
              + (ANTENNA_HEIGHT_RANGE[1] - ANTENNA_HEIGHT_RANGE[0]) * (i / 16);
            const angle = ANTENNA_ANGLE_RANGE[0]
              + (ANTENNA_ANGLE_RANGE[1] - ANTENNA_ANGLE_RANGE[0]) * (j / 16);
            const params = { ...A, antennaHeight: h, antennaAngle: angle, eyeSize, antennaLen };
            const tr = antennaBase(params), sr = shaderRoot(h, eyeSize);
            const td = antennaDir(params), sd = shaderDir(h, angle, eyeSize, antennaLen);
            const dr = Math.max(...tr.map((v, k) => Math.abs(v - sr[k])));
            const dd = Math.max(...td.map((v, k) => Math.abs(v - sd[k])));
            compared++;
            if (dr > worstR) worstR = dr;
            if (dd > worstD) { worstD = dd; worstAt = `height ${h.toFixed(2)}, angle ${angle.toFixed(2)}`; }
          }
        }
      }
    }
    console.log(`   compared ${compared} settings against the shader's own constants`);
    console.log(`   worst root disagreement: ${worstR.toExponential(2)}`);
    console.log(`   worst shaft disagreement: ${worstD.toExponential(2)}${worstAt ? ' at ' + worstAt : ''}`);
    ok(worstR < 1e-12, 'the shader places the antenna root exactly where the twin does');
    ok(worstD < 1e-12, 'and aims the shaft exactly where the twin does');
  }
}

// ---------------------------------------------------------------------------
section('7. every taper is gentle enough for one safety constant');
// ---------------------------------------------------------------------------

{
  let worst = 0, worstName = '';
  const note = (name, a, b, ra, rb) => {
    const s = taperSlope(a, b, ra, rb);
    if (s > worst) { worst = s; worstName = name; }
  };
  for (const spread of [0.75, 1.0, 1.25]) {
    const params = { ...A, legSpread: spread };
    for (const [i, leg] of LEGS.entries()) {
      const knee = [leg.knee[0] * spread, leg.knee[1], leg.knee[2]];
      note(`leg ${i} femur`, leg.hip, knee, leg.r[0], leg.r[1]);
      note(`leg ${i} tibia`, knee, footPos(leg, params), leg.r[1], leg.r[2]);
    }
  }
  for (const antennaLen of [0.6, 1.0, 1.5]) {
    for (const eyeSize of [0.75, 1.0, 1.5]) {
      for (const antennaAngle of ANTENNA_ANGLE_RANGE) {
        const params = { ...A, eyeSize, antennaLen, antennaAngle };
        const root = antennaBase(params);
        const dir = antennaDir(params);
        note('antenna', root, root.map((v, k) => v + dir[k]), ANTENNA.r[0], ANTENNA.r[1]);
      }
    }
  }
  console.log(`   steepest taper in the model: ${worst.toFixed(3)} (${worstName}), cap ${MAX_TAPER_SLOPE}`);
  ok(worst <= MAX_TAPER_SLOPE, 'no segment is steeper than the slope TAPER_SAFETY was derived for');
}

// ---------------------------------------------------------------------------
section('8. the bug fits inside the sphere its march is confined to');
// ---------------------------------------------------------------------------

{
  // BUG_BOUND is where the primary ray starts and stops evaluating the bug's field. Anything outside
  // it is silently not drawn — an antenna slider at maximum would just lose its tips, with no error
  // anywhere. So push every slider to its extreme and check the whole surface is still inside.
  let worst = 0, worstAt = null, found = 0;
  const [hLo2, hHi2] = ANTENNA_HEIGHT_RANGE;
  const extremes = [
    A,
    { ...A, bodyWidth: 1.35, eyeSize: 1.5, antennaLen: 1.5, legSpread: 1.25, antennaHeight: hHi2, antennaAngle: ANTENNA_ANGLE_RANGE[1] },
    { ...A, bodyWidth: 1.35, eyeSize: 1.5, antennaLen: 1.5, legSpread: 1.25, antennaHeight: hHi2, antennaAngle: ANTENNA_ANGLE_RANGE[0], time: 1.43 },
    { ...A, bodyWidth: 1.35, eyeSize: 1.5, antennaLen: 1.5, legSpread: 1.25, antennaHeight: hLo2, antennaAngle: ANTENNA_ANGLE_RANGE[1] },
    { ...A, bodyWidth: 0.7, eyeSize: 0.6, antennaLen: 0.6, legSpread: 0.75, antennaHeight: hLo2, antennaAngle: ANTENNA_ANGLE_RANGE[1] },
  ];
  for (const params of extremes) {
    for (let i = 0; i < 90000; i++) {
      const fx = (i * 0.7548776662) % 1, fy = (i * 0.5698402909) % 1, fz = (i * 0.3299560812) % 1;
      const x = -0.8 + 1.6 * fx, y = -0.1 + 0.95 * fy, z = -0.8 + 1.7 * fz;
      if (Math.abs(bugSdf(x, y, z, params)[0]) > 0.01) continue;
      found++;
      const r = Math.hypot(x - BUG_BOUND.at[0], y - BUG_BOUND.at[1], z - BUG_BOUND.at[2]);
      if (r > worst) { worst = r; worstAt = [x, y, z]; }
    }
  }
  console.log(`   furthest surface point from the bound centre: ${worst.toFixed(3)} of ${BUG_BOUND.r} (${found} samples)`);
  console.log(`   worst at ${worstAt ? worstAt.map((v) => v.toFixed(3)).join(', ') : 'n/a'}`);
  ok(found > 5000, 'the scan actually found surface to sample');
  ok(worst < BUG_BOUND.r, 'the whole bug is inside its bounding sphere at every slider extreme');
  ok(worst > BUG_BOUND.r * 0.7, 'and the bound is not so loose that it stops bounding anything');
}

// ---------------------------------------------------------------------------
section('9. the field is flat enough for the shipped step factor');
// ---------------------------------------------------------------------------

{
  // The shell groove is ADDED to the field, so its gradient stacks on the body's own. Sample a shell
  // around the surface — the only place a march's accuracy matters — and find the real worst case.
  // STEP_FACTOR * this must not exceed 1.
  let worst = 0, worstAt = null, samples = 0;
  for (const params of [A, { ...A, time: 0.9 }, { ...A, grooveDepth: 0.02 }, { ...A, bodyWidth: 1.35 }]) {
    for (let i = 0; i < 120000; i++) {
      const fx = (i * 0.7548776662) % 1, fy = (i * 0.5698402909) % 1, fz = (i * 0.3299560812) % 1;
      const x = -0.75 + 1.5 * fx, y = -0.1 + 0.9 * fy, z = -0.8 + 1.7 * fz;
      if (Math.abs(bugSdf(x, y, z, params)[0]) > 0.04) continue;
      samples++;
      const g = gradientMag(x, y, z, params);
      if (g > worst) { worst = g; worstAt = [x, y, z]; }
    }
  }
  console.log(`   worst gradient over ${samples} near-surface samples: ${worst.toFixed(4)} (cap ${MAX_GRADIENT})`);
  console.log(`   worst at ${worstAt ? worstAt.map((v) => v.toFixed(3)).join(', ') : 'n/a'}`);
  ok(samples > 8000, 'the scan actually found surfaces to sample');
  ok(worst <= MAX_GRADIENT, 'the field never gets steeper than MAX_GRADIENT');
  ok(STEP_FACTOR * MAX_GRADIENT <= 1.0, 'STEP_FACTOR covers MAX_GRADIENT');
  ok(STEP_FACTOR * MAX_GRADIENT > 0.9, 'and does not leave so much margin that steps are wasted');
}

// ---------------------------------------------------------------------------
section('10. the accelerated trace agrees with the field it accelerates');
// ---------------------------------------------------------------------------

// The end-to-end check, and the reason the twin exists. The trace has two halves solved two different
// ways, so each gets the oracle it deserves — and deciding that is not pedantry, it is the finding
// that produced the current design. Judging the analytic leaf against a slow march of the same sphere
// FAILED, four rays out of 2880, and the slow march was wrong every time: a ray skimming a 2.4-unit
// sphere keeps a small distance over a long stretch, so `d < HIT_EPS * t` fires well before the true
// tangent point and sometimes when the ray never touches the surface at all. That is the same
// property that made the leaf expensive to march, seen from the other side.
{
  // The leaf, against the sphere itself. Stronger than any march could be, and true at every angle.
  let worstErr = 0, worstInc = 1, hits = 0, grazing = 0;
  for (let iy = 0; iy < 40; iy++) {
    for (let ix = 0; ix < 72; ix++) {
      const { ro, rd } = cameraRay((ix / 71) * 2 - 1, (iy / 39) * 2 - 1, DEFAULT_VIEW);
      const r = traceScene(ro, rd, A);
      if (r.what !== 'leaf') continue;
      hits++;
      const p = [ro[0] + rd[0] * r.t, ro[1] + rd[1] * r.t, ro[2] + rd[2] * r.t];
      worstErr = Math.max(worstErr, Math.abs(sproutSdf(p[0], p[1], p[2], A)));
      const c = sproutCenter(A);
      const inc = Math.abs(((p[0] - c[0]) * rd[0] + (p[1] - c[1]) * rd[1] + (p[2] - c[2]) * rd[2]) / A.sproutR);
      worstInc = Math.min(worstInc, inc);
      if (inc < 0.15) grazing++;
      // It has to be the NEAR root, or the leaf is drawn inside out.
      const roots = sphereHit(ro, rd, c, A.sproutR);
      near(r.t, roots[0], 1e-12, 'the leaf hit is the nearer of the two roots');
    }
  }
  console.log(`   ${hits} leaf pixels; every hit sits on the sphere to within ${worstErr.toExponential(1)}`);
  console.log(`   shallowest incidence anywhere in frame: ${worstInc.toFixed(4)} (${grazing} pixels under 0.15)`);
  ok(worstErr < 1e-9, 'the analytic leaf hit is exact at every incidence angle, grazing included');
  ok(grazing > 0, 'the frame really does contain the grazing band that a march could not handle');
}

{
  // The bug, against a fine march of the bug's field alone — started at the camera rather than at
  // BUG_BOUND, so this checks the bounding sphere as well as the march inside it. This field has no
  // giant tangent sphere in it, so a slow march of it IS trustworthy.
  let tested = 0, missed = 0, spurious = 0, worstGap = 0, worstRay = null, wrongId = 0;
  for (let iy = 0; iy < 46; iy++) {
    for (let ix = 0; ix < 82; ix++) {
      const ndcX = (ix / 81) * 2 - 1, ndcY = (iy / 45) * 2 - 1;
      const { ro, rd } = cameraRay(ndcX, ndcY, DEFAULT_VIEW);
      const fast = traceBug(ro, rd, A);
      const slow = marchNaive(ro, rd, A, { field: 'bug', stepFactor: 0.12, steps: 6000 });
      tested++;
      if (slow.hit && !fast.hit) { missed++; continue; }
      if (!slow.hit && fast.hit) { spurious++; continue; }
      if (!slow.hit) continue;
      const gap = Math.abs(fast.t - slow.t);
      if (gap > worstGap) { worstGap = gap; worstRay = [ndcX.toFixed(2), ndcY.toFixed(2)]; }
      if (Math.round(fast.id) !== Math.round(slow.id) && gap < 0.002) wrongId++;
    }
  }
  console.log(`   ${tested} rays against the bug; worst disagreement ${(worstGap * 1000).toFixed(2)} mm at ndc ${worstRay}`);
  ok(missed === 0, `the bounded march never misses bug the slow march finds (${missed} did)`);
  ok(spurious === 0, `and never invents bug the slow march does not (${spurious} did)`);
  ok(worstGap < 0.004, 'no ray lands more than 4 mm from where the slow march puts it — nothing tunnels');
  ok(wrongId === 0, `and picks the same material where they agree on the surface (${wrongId} did not)`);
}

{
  // The composition: `traceScene` must return whichever of the two hits is nearer. Getting this
  // backwards would draw the bug through the leaf, or the leaf over the bug's near legs.
  //
  // At the default view this is barely exercised, and understanding why was worth the detour. The leaf
  // is tangent to y = 0 and the bug's body sits entirely above it, so a ray aimed at the shell
  // descends too shallowly to reach y = 0 before it has passed beyond the leaf's edge — it never
  // enters the sphere at all. Only the contact zone around the feet has both surfaces to sort. That is
  // not a defect: it is the reference photo's framing, where the subject is against bokeh rather than
  // against leaf. So the sort is exercised at a second, lower camera where the leaf genuinely occludes.
  const views = [
    ['default', DEFAULT_VIEW],
    ['low angle', { ...DEFAULT_VIEW, pitch: -0.3, dist: 2.2, framing: [-0.1, 0.1] }],
  ];
  // A fine grid on purpose: the overlap is the contact zone around the feet, which is a thin band at
  // any view because the bug stands on the leaf's tangent point. On a coarse grid it is a handful of
  // samples and any threshold on it would be measuring the grid rather than the picture.
  for (const [name, view] of views) {
    let wrong = 0, both = 0, occluded = 0;
    for (let iy = 0; iy < 220; iy++) {
      for (let ix = 0; ix < 400; ix++) {
        const { ro, rd } = cameraRay((ix / 399) * 2 - 1, (iy / 219) * 2 - 1, view);
        const scene = traceScene(ro, rd, A);
        const bug = traceBug(ro, rd, A);
        const roots = sphereHit(ro, rd, sproutCenter(A), A.sproutR);
        const tLeaf = roots && roots[0] > 0.001 ? roots[0] : -1;
        if (bug.hit && tLeaf > 0) {
          both++;
          if (tLeaf < bug.t) occluded++;      // leaf in front of bug: the case that must win
        }
        const wantT = bug.hit && (tLeaf < 0 || bug.t <= tLeaf) ? bug.t : tLeaf;
        if (wantT < 0) { if (scene.hit) wrong++; continue; }
        if (!scene.hit || Math.abs(scene.t - wantT) > 1e-12) wrong++;
      }
    }
    console.log(`   ${name}: ${both} pixels have both surfaces, ${occluded} with the leaf in front`);
    ok(wrong === 0, `${name}: every pixel takes the nearer of the two surfaces (${wrong} did not)`);
    if (name === 'low angle') {
      ok(both > 60, 'the low view really does put the leaf and the bug on the same rays');
      ok(occluded > 0, 'and really does hide part of the bug behind the leaf, so the sort is tested');
    }
  }
}

// ---------------------------------------------------------------------------
section('10b. what the old all-in-one march cost, for the record');
// ---------------------------------------------------------------------------

{
  // This demo began by sphere-tracing `min(bug, leaf)` from the camera, the way sdf-creature.html
  // does, and that is the version the numbers here describe. Kept as a measurement rather than a
  // claim, because "the leaf is a sphere so intersect it analytically" is the kind of decision that
  // gets undone by someone adding a displacement back to it.
  let stalls = 0, total = 0, evals = 0, worst = 0;
  for (let iy = 0; iy < 30; iy++) {
    for (let ix = 0; ix < 54; ix++) {
      const { ro, rd } = cameraRay((ix / 53) * 2 - 1, (iy / 29) * 2 - 1, DEFAULT_VIEW);
      // 0.85 and 104 steps: the same step factor, and a loop bound generous for a whole-scene march.
      const r = marchNaive(ro, rd, A, { stepFactor: 0.85, steps: 104 });
      total++; evals += r.steps; worst = Math.max(worst, r.steps);
      if (r.exhausted) stalls++;
    }
  }
  console.log(`   whole-scene march: ${(evals / total).toFixed(1)} evaluations per pixel, worst ${worst}`);
  console.log(`   ${stalls} of ${total} pixels (${((100 * stalls) / total).toFixed(1)}%) gave up mid-scene — the leaf's silhouette`);
  ok(evals / total > 8, 'the whole-scene march really was several times dearer');
  // This is the finding that actually forced the change. Average cost was survivable; the stalls were
  // not, because a ray that gives up mid-scene draws backdrop through a surface, and they cluster
  // along the leaf's silhouette where the eye reads a torn edge.
  ok(stalls > 0, 'and really did strand rays on the leaf, which is why the leaf is a quadratic now');
}

// ---------------------------------------------------------------------------
section('11. the trace is cheap, and cheap in the right places');
// ---------------------------------------------------------------------------

{
  // Cost is the standing objection to this technique, so measure it. The number that matters is
  // distance evaluations per pixel, because that is what the fragment shader pays per frame.
  const bucket = { bug: [0, 0], leaf: [0, 0], sky: [0, 0] };
  let worst = 0, saturated = 0;
  for (let iy = 0; iy < 60; iy++) {
    for (let ix = 0; ix < 110; ix++) {
      const { ro, rd } = cameraRay((ix / 109) * 2 - 1, (iy / 59) * 2 - 1, DEFAULT_VIEW);
      const r = traceScene(ro, rd, A);
      bucket[r.what][0]++;
      bucket[r.what][1] += r.evals;
      worst = Math.max(worst, r.evals);
      if (r.evals >= MARCH_STEPS) saturated++;
    }
  }
  const total = bucket.bug[0] + bucket.leaf[0] + bucket.sky[0];
  const evals = bucket.bug[1] + bucket.leaf[1] + bucket.sky[1];
  const pct = (n) => ((100 * n) / total).toFixed(1);
  const avg = (b) => (b[0] ? (b[1] / b[0]).toFixed(1) : '0.0');
  console.log(`   coverage: bug ${pct(bucket.bug[0])}%, leaf ${pct(bucket.leaf[0])}%, backdrop ${pct(bucket.sky[0])}%`);
  console.log(`   distance evaluations per pixel: ${(evals / total).toFixed(1)} average, ${worst} worst of ${MARCH_STEPS}`);
  console.log(`     on the bug ${avg(bucket.bug)}, on the leaf ${avg(bucket.leaf)}, on the backdrop ${avg(bucket.sky)}`);
  ok(worst < MARCH_STEPS, 'no ray runs out of steps');
  ok(saturated === 0, `no ray gives up mid-scene (${saturated} did)`);
  // The whole point of the analytic leaf: a leaf pixel should cost a quadratic, not a march.
  ok(bucket.leaf[1] / Math.max(bucket.leaf[0], 1) < 12, 'a leaf pixel costs almost nothing');
  ok(bucket.sky[1] / Math.max(bucket.sky[0], 1) < 4, 'a backdrop pixel costs almost nothing');
  ok(evals / total < 22, 'the average pixel is well under the loop bound');
}

// ---------------------------------------------------------------------------
section('12. the default framing shows the bug');
// ---------------------------------------------------------------------------

{
  // The one thing a screenshot would answer instantly and Node normally cannot: is the subject in
  // frame, is it the right size, and is the leaf under it.
  let bug = 0, leaf = 0, sky = 0, total = 0;
  let minX = 2, maxX = -2, minY = 2, maxY = -2;
  for (let iy = 0; iy < 90; iy++) {
    for (let ix = 0; ix < 166; ix++) {
      const ndcX = (ix / 165) * 2 - 1, ndcY = (iy / 89) * 2 - 1;
      const { ro, rd } = cameraRay(ndcX, ndcY, DEFAULT_VIEW);
      const r = traceScene(ro, rd, A);
      total++;
      if (r.what === 'sky') sky++;
      else if (r.what === 'leaf') leaf++;
      else {
        bug++;
        minX = Math.min(minX, ndcX); maxX = Math.max(maxX, ndcX);
        minY = Math.min(minY, ndcY); maxY = Math.max(maxY, ndcY);
      }
    }
  }
  const pct = (n) => ((100 * n) / total).toFixed(1);
  console.log(`   coverage: bug ${pct(bug)}%, leaf ${pct(leaf)}%, backdrop ${pct(sky)}%`);
  console.log(`   bug occupies ndc x [${minX.toFixed(2)}, ${maxX.toFixed(2)}], y [${minY.toFixed(2)}, ${maxY.toFixed(2)}]`);
  console.log(`   bug fills ${(((maxY - minY) / 2) * 100).toFixed(0)}% of frame height, ` +
    `centred at x ${((minX + maxX) / 2).toFixed(2)}, y ${((minY + maxY) / 2).toFixed(2)}`);
  ok(bug / total > 0.02, 'the bug is not a speck');
  ok(leaf / total > 0.15, 'the leaf fills a real part of the frame');
  ok(sky / total > 0.3, 'and there is backdrop left for the bokeh to live in');
  ok(minX > -0.97 && maxX < 0.97 && minY > -0.97 && maxY < 0.97, 'the bug is not cropped by the frame edge');
  // The reference photo puts the bug at a bit over a third of the frame height, right of centre.
  ok(maxY - minY > 0.5 && maxY - minY < 1.1, 'the bug is between 25% and 55% of frame height');
  ok((minX + maxX) / 2 > 0, 'the bug sits right of centre, as in the reference');

  // The centre ray has to land on the bug, or the depth-of-field autofocus focuses on the leaf.
  const centre = cameraRay(0, 0, DEFAULT_VIEW);
  const hit = traceScene(centre.ro, centre.rd, A);
  console.log(`   centre ray hits ${hit.what} (material ${hit.id}) at t=${hit.t.toFixed(3)}`);
  ok(hit.hit && hit.what === 'bug', 'the centre ray lands on the bug, so autofocus finds the subject');
  // And the camera must be well outside the leaf, or the first thing the ray does is exit solid ground.
  ok(sproutSdf(centre.ro[0], centre.ro[1], centre.ro[2], A) > 0.5, 'the camera is well clear of the leaf');
  ok(bugSdf(centre.ro[0], centre.ro[1], centre.ro[2], A)[0] > 0.5, 'and well clear of the bug');
}

// ---------------------------------------------------------------------------
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) process.exit(1);
