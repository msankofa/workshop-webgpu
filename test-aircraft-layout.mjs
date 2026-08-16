// test-aircraft-layout.mjs — does measuring the aircraft reproduce the aircraft?
//
// This is the cheapest test that can invalidate the whole studio design, and it is deliberately the
// first one written. If a layout that draws the shipped plane does not derive something close to
// the shipped plane's flown numbers, then "drag the wing and watch the stall speed move" is a
// fiction and the studio should be two unrelated panels after all.
//
// The bot design studio had an equivalent: `botTarget.adopt(BOT_BODY_DESIGN)` round-tripping the
// shipped design. That option does not exist here, because `flight-meshes.js` is imperative code
// with hard-coded literals rather than data — there is nothing to adopt FROM. So the falsifying
// test is a comparison against the hand-typed physics instead, which is a stronger test anyway: it
// checks the LINK between shape and flight, not just that a schema survives a round trip.
//
//   node test-aircraft-layout.mjs

import { AIRFRAMES, validateAirframe, registerAirframe } from './flight-airframes.js';
import {
  wingAreaOf, massOf, volumeOf, boundsOf, hitRadiusOf, frontalAreaOf,
  anchorsOf, hardpointsOf, deriveGeometry, airframeFromLayout, wingPanelArea, panelVolume,
  stallSpeedOf, authoritySpeedOf, aspectRatioOf, levelTopSpeedOf, exhaustsOf,
} from './aircraft-layout.js';
import {
  LIBRARY, airframeFor, PLANE_LAYOUT, A10_LAYOUT, A10_PUBLISHED, AC130_LAYOUT, AC130_PUBLISHED,
} from './aircraft-library.js';
import { makeFlyer, stepFlyer } from './flight-model.js';
import { makeAi, offsetCircuit, driveAi } from './flight-ai.js';
import { agl } from './flight-terrain.js';

let fails = 0;
const ok = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};
const pct = (a, b) => Math.abs(a - b) / Math.max(1e-9, Math.abs(b));

// ---------------------------------------------------------------------------
console.log('--- 1. the derivation itself ---');
// ---------------------------------------------------------------------------
{
  // span is TIP TO TIP. The single easiest thing in this file to be quietly wrong about, so it is
  // asserted directly rather than only through a craft.
  ok('a 10 m span with a 2 m chord is 20 m2, not 10',
    wingPanelArea({ span: 10, rootChord: 2, tipChord: 2 }) === 20);
  ok('and a taper takes the mean chord',
    wingPanelArea({ span: 10, rootChord: 3, tipChord: 1 }) === 20);
  ok('a lifting-surface volume is area times thickness',
    Math.abs(panelVolume(10, 3, 1, 0.2) - 4) < 1e-9);

  // a tailplane has area and makes no useful lift, so counting it would inflate the flown wing
  const twoSurfaces = { class: 'plane', wings: [
    { id: 'w', span: 10, rootChord: 2, tipChord: 2, thickness: 0.2, lifting: true },
    { id: 't', span: 4, rootChord: 1, tipChord: 1, thickness: 0.2, lifting: false },
  ] };
  ok('a non-lifting surface is excluded from the reference area', wingAreaOf(twoSurfaces) === 20);
  ok('but still carries its mass', volumeOf(twoSurfaces) > panelVolume(10, 2, 2, 0.2));

  // scale the whole aircraft and the derived numbers have to move the way areas and volumes do
  const big = JSON.parse(JSON.stringify(PLANE_LAYOUT));
  const scale = (o) => {
    for (const k of ['span', 'rootChord', 'tipChord', 'thickness', 'length', 'radius',
      'noseLength', 'tailRadius', 'height', 'x', 'y', 'z']) {
      if (typeof o[k] === 'number') o[k] *= 2;
    }
  };
  if (big.fuselage) scale(big.fuselage);
  for (const list of [big.wings, big.fins, big.pods, big.rotors]) for (const o of list || []) scale(o);
  ok('doubling every dimension quadruples the wing area',
    pct(wingAreaOf(big), wingAreaOf(PLANE_LAYOUT) * 4) < 1e-6,
    `${wingAreaOf(PLANE_LAYOUT).toFixed(1)} -> ${wingAreaOf(big).toFixed(1)} m2`);
  ok('and multiplies the mass by eight',
    pct(massOf(big), massOf(PLANE_LAYOUT) * 8) < 1e-6,
    `${massOf(PLANE_LAYOUT).toFixed(0)} -> ${massOf(big).toFixed(0)} kg`);
}

// ---------------------------------------------------------------------------
console.log('\n--- 2. the falsifying comparison: measured shape vs flown numbers ---');
//
// Tolerances are deliberately loose. The claim under test is "measuring the shape gets you the
// right aircraft", not "to three significant figures" — a 20% miss on mass is a different plane,
// a 2% miss is a density that wants nudging.
// ---------------------------------------------------------------------------
{
  const TOL = { mass: 0.15, wingArea: 0.10, hitRadius: 0.35, size: 0.60, chaseDist: 0.60 };
  // Only craft that HAVE a hand-typed descriptor to disagree with. A layout authored from scratch
  // has nothing to compare against here; the A-10 is checked against published figures instead.
  for (const key of Object.keys(LIBRARY).filter((k) => AIRFRAMES[k])) {
    const g = deriveGeometry(LIBRARY[key].layout);
    const af = AIRFRAMES[key];
    for (const field of ['mass', 'wingArea', 'hitRadius', 'size', 'chaseDist']) {
      if (field === 'wingArea' && af.wingArea === 0) {
        ok(`${key}: no lifting surface, so no reference area`, g.wingArea === 0);
        continue;
      }
      const d = pct(g[field], af[field]);
      ok(`${key}: derived ${field} matches the flown value`, d <= TOL[field],
        `${g[field].toFixed(field === 'mass' ? 1 : 3)} vs ${af[field]} (${(d * 100).toFixed(0)}%)`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\n--- 3. a layout produces an airframe the sim will actually accept ---');
// ---------------------------------------------------------------------------
{
  for (const key of Object.keys(LIBRARY)) {
    const af = airframeFor(key);
    const errs = validateAirframe(key, af);
    ok(`${key}: the derived descriptor passes the registry's own validation`, errs.length === 0,
      errs.join('; '));
  }

  // the whole loop, end to end: shape -> descriptor -> registered -> flown
  const af = airframeFor('plane');
  af.label = 'Derived plane';
  registerAirframe('derivedplane', af);
  const f = makeFlyer('derivedplane', {});
  const y0 = f.p.y;
  let worstStall = 0;
  for (let i = 0; i < 60 * 40; i++) {
    stepFlyer(f, 1 / 60, true);
    worstStall = Math.max(worstStall, f.stallFrac);
  }
  ok('a craft built from a measured shape flies hands-off for 40 s',
    !f.crashed && Number.isFinite(f.p.y) && f.up.y > 0.5,
    `${(f.p.y - y0).toFixed(0)} m, ${f.airspeed.toFixed(0)} m/s, worst stall ${worstStall.toFixed(2)}`);
  delete AIRFRAMES.derivedplane;
}

// ---------------------------------------------------------------------------
console.log('\n--- 4. the shape has to actually drive the flight ---');
//
// If a bigger wing does not change how the aircraft flies, none of the above matters.
// ---------------------------------------------------------------------------
{
  // Flown, not calculated. Held at one speed too slow for the shipped wing, with the same throttle,
  // for the same time: the aircraft with more wing has to sink less. An earlier version of this
  // check decelerated and recorded "the slowest speed it held height at", which sounds like a stall
  // speed and is not one — the assist simply trimmed the nose down and it descended at every speed,
  // so the number it returned was a property of the test, not of the wing.
  const sinkAt = (layout, speed) => {
    const af = airframeFromLayout(layout, { ...LIBRARY.plane.tuning });
    registerAirframe('probe', af);
    const f = makeFlyer('probe', {});
    f.p.y = 4000;
    f.v.copy(f.fwd).multiplyScalar(speed);
    const y0 = f.p.y;
    for (let i = 0; i < 60 * 10; i++) { f.throttle = 0.3; stepFlyer(f, 1 / 60, true); }
    delete AIRFRAMES.probe;
    return y0 - f.p.y;
  };

  const wide = JSON.parse(JSON.stringify(PLANE_LAYOUT));
  wide.wings[0].rootChord *= 2; wide.wings[0].tipChord *= 2;
  const dNormal = sinkAt(PLANE_LAYOUT, 62);
  const dWide = sinkAt(wide, 62);
  // A proportional margin, because doubling the chord also doubles that panel's VOLUME and so adds
  // 176 kg to a 950 kg aircraft. Twice the wing carrying 1.2x the mass is a real improvement and a
  // modest one — measured at 17% less height lost — and an absolute threshold picked by eye would
  // have been asserting a number nothing predicted.
  ok('at a speed the shipped wing cannot hold, a doubled wing sinks less', dWide < dNormal * 0.9,
    `lost ${dNormal.toFixed(0)} m vs ${dWide.toFixed(0)} m in 10 s`);

  // ...and the mass that came with that wing is real too: the same shape at three times the density
  // is a worse aircraft, which is the other half of the shape-drives-flight claim.
  const heavy = JSON.parse(JSON.stringify(PLANE_LAYOUT));
  heavy.density = { body: 204, panel: 150, pod: 204 };
  ok('and the same shape built three times heavier sinks more', sinkAt(heavy, 62) > dNormal + 20,
    `lost ${sinkAt(heavy, 62).toFixed(0)} m against ${dNormal.toFixed(0)} m`);
}

// ---------------------------------------------------------------------------
console.log('\n--- 5. the numbers the studio panel reports ---');
//
// These update while a slider is moving, so they have to be analytic rather than flown. Which makes
// them exactly the kind of formula that can be transcribed wrong and look plausible forever.
// ---------------------------------------------------------------------------
{
  const af = airframeFor('plane');
  const vs = stallSpeedOf(af);
  // self-consistency: at the reported stall speed, lift at the stalling angle IS the weight
  const lift = 0.5 * 1.225 * vs * vs * af.wingArea * (af.clAlpha * af.alphaStall);
  ok('at the stall speed, lift equals weight', pct(lift, af.mass * 9.81) < 1e-9,
    `${lift.toFixed(0)} N vs ${(af.mass * 9.81).toFixed(0)} N, at ${vs.toFixed(1)} m/s`);

  const va = authoritySpeedOf(af);
  ok('the authority speed is where dynamic pressure reaches qRef',
    pct(0.5 * 1.225 * va * va, af.qRef) < 1e-9, `${va.toFixed(1)} m/s`);

  // The finding this row exists for: the shipped plane's controls give up well ABOVE the speed its
  // wing does, so a panel reporting only a stall speed reports the wrong limit.
  ok('the plane runs out of control authority before it runs out of wing', va > vs * 1.5,
    `authority ${va.toFixed(1)} m/s vs stall ${vs.toFixed(1)} m/s`);

  ok('a wingless craft has no stall speed to report', stallSpeedOf(airframeFor('drone')) === null);
  ok('and a self-levelling one has no authority speed either',
    authoritySpeedOf(airframeFor('drone')) === null);

  // aspect ratio off the widest lifting surface, and a tailplane must not enter into it
  ok('aspect ratio is span squared over the lifting area',
    pct(aspectRatioOf(PLANE_LAYOUT), (11.5 * 11.5) / wingAreaOf(PLANE_LAYOUT)) < 1e-9,
    aspectRatioOf(PLANE_LAYOUT).toFixed(2));
}

// ---------------------------------------------------------------------------
console.log('\n--- 6. the A-10: an aircraft authored FROM the layout, against the real one ---');
//
// The first craft in the library that was not transcribed out of `flight-meshes.js`, and the first
// measured against something outside this repository. If a schema built by fitting three existing
// shapes cannot also express an aircraft nobody had it in mind for, it is a description of those
// three shapes rather than a schema.
// ---------------------------------------------------------------------------
{
  const g = deriveGeometry(A10_LAYOUT);
  const b = boundsOf(A10_LAYOUT);
  const P = A10_PUBLISHED;
  const near = (got, want, tol, label, unit) =>
    ok(`A-10 ${label}`, pct(got, want) <= tol,
      `${got.toFixed(2)} ${unit} against a published ${want} (${(pct(got, want) * 100).toFixed(1)}%)`);

  near(b.size[0], P.span, 0.01, 'spans 17.53 m', 'm');
  near(b.size[2], P.length, 0.01, 'is 16.26 m long', 'm');
  near(g.wingArea, P.wingArea, 0.01, 'carries 47 m² of wing', 'm²');
  near(g.mass, P.emptyMass, 0.02, 'weighs its empty weight', 'kg');
  ok('A-10 has the aspect ratio that follows from those two',
    Math.abs(aspectRatioOf(A10_LAYOUT) - 6.54) < 0.05, aspectRatioOf(A10_LAYOUT).toFixed(2));

  // The density is not a fudge factor. It is what the shape and the weight jointly imply, and the
  // number it lands on is the aircraft's actual story: armour and a gun.
  const density = g.mass / g.volume;
  ok('A-10 works out two and a half times denser than the light plane',
    density > 160 && density < 190, `${density.toFixed(0)} kg/m³ against the plane's 68`);

  const af = airframeFor('a10');
  ok('and its descriptor is flyable', validateAirframe('a10', af).length === 0,
    validateAirframe('a10', af).join('; '));
  ok('with the twin tails and eight underwing stations it should have',
    A10_LAYOUT.fins.length === 2 && hardpointsOf(A10_LAYOUT).length === 8);
  ok('and two exhausts, which the schema could not express before it',
    exhaustsOf(A10_LAYOUT).length === 2);

  // level top speed, which is the number that caught the missing thrust lapse
  const top = levelTopSpeedOf(af);
  ok('A-10 tops out at its published 706 km/h', Math.abs(top * 3.6 - 706) < 15,
    `${(top * 3.6).toFixed(0)} km/h`);

  // and it has to survive the same unattended flight every other craft does
  registerAirframe('a10test', { ...af, label: 'A10 test' });
  const f = makeAi(makeFlyer('a10test', { x: 0, z: 0 }), 1);
  offsetCircuit(f, 0, 0);
  const world = { flyers: [f], player: null, aiEngage: true };
  let minAgl = Infinity, inverted = 0, steps = 0;
  const seen = new Set();
  for (let t = 0; t < 180; t += 1 / 60, steps++) {
    driveAi(f, 1 / 60, world);
    stepFlyer(f, 1 / 60, true);
    if (!Number.isFinite(f.p.y) || f.crashed) break;
    minAgl = Math.min(minAgl, agl(f.p));
    if (f.up.y < 0) inverted++;
    seen.add(f.ai.i);
  }
  ok('A-10 flies its own patrol for three minutes unattended',
    !f.crashed && minAgl > 40 && inverted / steps < 0.02 && seen.size >= 4,
    `min agl ${minAgl.toFixed(0)} m, ${seen.size} waypoints, ${(100 * inverted / steps).toFixed(1)}% inverted`);
  delete AIRFRAMES.a10test;
}

// ---------------------------------------------------------------------------
console.log('\n--- 6b. the AC-130: four engines, no nose gun, three guns out of the side ---');
//
// The second aircraft built from the layout, and the one that forced `mounts` into the schema. Its
// mass target is an ESTIMATE (the C-130H's published empty weight plus a gunship's guns, ammunition
// and armour) and is asserted loosely for that reason; span, length and wing area are published.
// ---------------------------------------------------------------------------
{
  const g = deriveGeometry(AC130_LAYOUT);
  const b = boundsOf(AC130_LAYOUT);
  const P = AC130_PUBLISHED;
  const near = (got, want, tol, label, unit) =>
    ok(`AC-130 ${label}`, pct(got, want) <= tol,
      `${got.toFixed(2)} ${unit} against ${want} (${(pct(got, want) * 100).toFixed(1)}%)`);
  near(b.size[0], P.span, 0.01, 'spans 40.41 m', 'm');
  near(b.size[2], P.length, 0.015, 'is 29.79 m long', 'm');
  near(g.wingArea, P.wingArea, 0.01, 'carries 162 m² of wing', 'm²');
  near(g.mass, P.operatingMass, 0.05, 'weighs about its estimated operating mass', 'kg');
  ok('AC-130 is heavier than the bare airframe it is built on', g.mass > P.airframeEmptyMass,
    `${g.mass.toFixed(0)} kg against an empty C-130H of ${P.airframeEmptyMass}`);
  // a hollow cargo hold lands near the light plane, not near the armoured A-10's 175
  ok('and, being a cargo hold, is nowhere near as dense as the A-10',
    g.mass / g.volume > 55 && g.mass / g.volume < 95, `${(g.mass / g.volume).toFixed(0)} kg/m³ overall`);
  ok('aspect ratio 10, from span and area', Math.abs(aspectRatioOf(AC130_LAYOUT) - 10.08) < 0.1,
    aspectRatioOf(AC130_LAYOUT).toFixed(2));

  const af = airframeFor('ac130');
  ok('its descriptor is flyable', validateAirframe('ac130', af).length === 0, validateAirframe('ac130', af).join('; '));
  ok('four exhausts, one per engine', exhaustsOf(AC130_LAYOUT).length === 4);
  ok('no nose gun, three mounts, all on the PORT side, all depressed', af.gun === 'none' && af.mounts.length === 3
    && af.mounts.every((m) => m.pos[0] < 0 && m.dir[0] < 0 && m.dir[1] < 0));
  ok('the mounts came through airframeFromLayout with unit directions',
    af.mounts.every((m) => Math.abs(Math.hypot(...m.dir) - 1) < 1e-9));
  ok('and every mount is an anchor', af.mounts.every((m) => anchorsOf(AC130_LAYOUT).includes(m.id)));
  const top = levelTopSpeedOf(af);
  ok('AC-130 tops out near the C-130H\'s 592 km/h', Math.abs(top * 3.6 - P.maxSpeedKmh) < 20,
    `${(top * 3.6).toFixed(0)} km/h`);
  ok('and stalls slow, as a big straight wing should', stallSpeedOf(af) < 60, `${stallSpeedOf(af).toFixed(1)} m/s`);

  registerAirframe('ac130test', { ...af, label: 'AC-130 test' });
  const f = makeAi(makeFlyer('ac130test', { x: 0, z: 0 }), 1);
  offsetCircuit(f, 0, 0);
  const world = { flyers: [f], player: null, aiEngage: true };
  let minAgl = Infinity, inverted = 0, steps = 0;
  const seen = new Set();
  for (let t = 0; t < 180; t += 1 / 60, steps++) {
    driveAi(f, 1 / 60, world);
    stepFlyer(f, 1 / 60, true);
    if (!Number.isFinite(f.p.y) || f.crashed) break;
    minAgl = Math.min(minAgl, agl(f.p));
    if (f.up.y < 0) inverted++;
    seen.add(f.ai.i);
  }
  ok('AC-130 flies its own patrol for three minutes unattended',
    !f.crashed && minAgl > 40 && inverted / steps < 0.02 && seen.size >= 3,
    `min agl ${minAgl.toFixed(0)} m, ${seen.size} waypoints, ${(100 * inverted / steps).toFixed(1)}% inverted`);
  ok('a flown AC-130 carries three live mounts with full magazines',
    f.mounts.length === 3 && f.mounts.every((m) => m.ammo === m.gun.ammo) && f.gun === null);
  delete AIRFRAMES.ac130test;
}

// ---------------------------------------------------------------------------
console.log('\n--- 7. level top speed is solved, not flown ---');
// ---------------------------------------------------------------------------
{
  const af = airframeFor('a10');
  const v = levelTopSpeedOf(af);
  // at the reported speed, thrust and drag balance — the definition, checked against itself
  const q = 0.5 * 1.225 * v * v;
  const cl = (af.mass * 9.81) / (q * af.wingArea);
  const drag = q * af.wingArea * (af.cd0 + af.kInduced * cl * cl);
  ok('thrust equals drag there', pct(drag, af.thrustMax * (af.abThrust || 1)) < 1e-3,
    `${drag.toFixed(0)} N against ${af.thrustMax} N`);
  // The HIGH root: drag against speed is a U, so thrust meets it twice and only the upper crossing
  // is a top speed. Identified by the sign change either side of it — an earlier version of this
  // check sampled 30% of top speed and expected drag to exceed thrust there, which is between the
  // two roots, where it does not. The low crossing for this aircraft is at 25 m/s, half its stall.
  const dragAt = (u) => {
    const qq = 0.5 * 1.225 * u * u;
    const c = (af.mass * 9.81) / (qq * af.wingArea);
    return qq * af.wingArea * (af.cd0 + af.kInduced * c * c);
  };
  ok('and it is the upper crossing: slower is under thrust, faster is over',
    dragAt(v * 0.95) < af.thrustMax && dragAt(v * 1.05) > af.thrustMax,
    `${dragAt(v * 0.95).toFixed(0)} N below, ${dragAt(v * 1.05).toFixed(0)} N above`);
  ok('a craft with no engine has no level top speed',
    levelTopSpeedOf({ ...af, thrustMax: 0 }) === null);
  ok('nor does one whose drag beats its thrust everywhere',
    levelTopSpeedOf({ ...af, thrustMax: 500 }) === null);
}

// ---------------------------------------------------------------------------
console.log('\n--- 8. anchors and hardpoints ---');
// ---------------------------------------------------------------------------
{
  const a = anchorsOf(PLANE_LAYOUT);
  ok('anchors are derived from the layout, not a constant',
    a.includes('wing.root') && a.includes('wing.tip') && a.includes('fin.root') && a.includes('nose'));
  ok('a craft with no fuselage has no nose anchor', !anchorsOf(LIBRARY.drone.layout).includes('nose'));
  ok('and a four-rotor layout names all four', anchorsOf(LIBRARY.drone.layout).filter((n) => n.startsWith('rotor')).length === 4);

  const hp = hardpointsOf(PLANE_LAYOUT);
  ok('two mirrored hardpoints become four stations', hp.length === 4,
    hp.map((h) => h.id).join(' '));
  const [r, l] = [hp.find((h) => h.id === 'inboard.r'), hp.find((h) => h.id === 'inboard.l')];
  ok('mirrored across the centreline', Math.abs(r.p[0] + l.p[0]) < 1e-9 && r.p[0] > 0);
  ok('inboard sits closer to the root than outboard',
    Math.abs(r.p[0]) < Math.abs(hp.find((h) => h.id === 'outboard.r').p[0]));
  ok('and every station hangs below the wing it is on',
    hp.every((h) => h.p[1] < PLANE_LAYOUT.wings[0].y));
  // sweep carries an outboard station backwards, which is what makes a pylon sit where it looks
  ok('a swept wing carries the outboard station aft',
    hp.find((h) => h.id === 'outboard.r').p[2] > hp.find((h) => h.id === 'inboard.r').p[2]);
}

console.log(`\n${fails === 0 ? 'all checks passed' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
