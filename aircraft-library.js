// aircraft-library.js — the shipped craft as layouts, plus their tuning.
//
// The three entries here are transcribed from `flight-meshes.js`'s hard-coded builders, dimension
// for dimension, so that `test-aircraft-layout.mjs` can ask the one question that decides whether
// the whole layout idea is sound: does measuring the drawn aircraft reproduce the numbers somebody
// typed into `flight-airframes.js` by hand?
//
// It does not, everywhere, and the disagreements are recorded next to the entries that carry them.
// That is the point — nothing compared these two descriptions of the same aircraft before.

import { airframeFromLayout } from './aircraft-layout.js';

// ---------------------------------------------------------------------------
// Plane
//
// Fuselage: CapsuleGeometry(0.62, 6.2) + a 2.2 m nose cone.
// Wing:     BoxGeometry(11.5, 0.22, 2.6) at y -0.15, z 0.4.
// Stab:     BoxGeometry(4.4, 0.18, 1.2) at y 0.1, z 3.5.
// Fin:      BoxGeometry(0.18, 1.9, 1.5) at y 1.05, z 3.5.
// Intake:   CylinderGeometry(0.5, 0.62, 1.1) at z 3.3.
//
// THE DRAWN WING IS NOT THE FLOWN WING. 11.5 x 2.6 is 29.9 m^2 and the flown `wingArea` is 16, so
// the picture claims an aircraft with 1.87x the wing the physics gives it. Both cannot be right, and
// the physics is the one that was measured — every trim, stall and dive number in `flight.md` was
// flown against 16. So the chord here is the one that reproduces it, and the mesh is what should
// change. Left as evidence rather than quietly fudged.
// ---------------------------------------------------------------------------

export const PLANE_LAYOUT = {
  id: 'plane', label: 'Plane', class: 'plane',
  density: { body: 68, panel: 50, pod: 68 },
  hitScale: 1, chaseScale: 3.4,
  fuselage: { length: 6.2, radius: 0.62, noseLength: 2.2, tailRadius: 0.62 },
  wings: [
    { id: 'wing', span: 11.5, rootChord: 1.55, tipChord: 1.23, thickness: 0.22,
      x: 0, y: -0.15, z: 0.4, sweep: 0.12, dihedral: 0.05, lifting: true },
    { id: 'stab', span: 4.4, rootChord: 1.2, tipChord: 0.9, thickness: 0.18,
      x: 0, y: 0.1, z: 3.5, lifting: false },
  ],
  fins: [
    { id: 'fin', height: 1.9, rootChord: 1.5, tipChord: 0.9, thickness: 0.18, x: 0, y: 0.1, z: 3.5 },
  ],
  pods: [
    { id: 'intake', length: 1.1, radius: 0.56, x: 0, y: 0, z: 3.3, role: 'dark' },
  ],
  rotors: [],
  // an effect rather than structure: it is not shot at and it does not count toward the extents
  exhaust: { radius: 0.44, length: 2.6, x: 0, y: 0, z: 4.6 },
  hardpoints: [
    { id: 'inboard', wing: 'wing', station: 0.38, drop: 0.16 },
    { id: 'outboard', wing: 'wing', station: 0.68, drop: 0.16 },
  ],
};

export const PLANE_TUNING = {
  note: 'Fixed wing. Thrust along the nose, lift from the wing. Cannot hover, cannot stop. ' +
        'Control authority dies with airspeed, so a stall takes the controls with it.',
  lift: 'wing', thrust: 'axial', control: 'rate',
  mesh: 'plane', idleThrottle: 0.7, enginePitch: 62, armable: true,
  circuit: { speed: 120, alt: 1100, radius: 2600, capture: 750 },
  thrustMax: 11000, clAlpha: 5.0, alphaStall: 0.26, alphaHard: 0.50,
  cd0: 0.026, kInduced: 0.055, cdStall: 0.34, cdBeta: 0.85,
  sweepArea: 1, sweepDrag: 1,
  maxPitchRate: 1.35, maxRollRate: 3.4, maxYawRate: 0.55, rateResponse: 7.0,
  qRef: 1400, pitchStab: 2.6, yawStab: 1.8, trimSpeed: 105,
  spawn: { alt: 900, speed: 105 }, hp: 110, abThrust: 1.85,
  tunables: ['thrustMax', 'wingArea', 'clAlpha', 'alphaStall', 'cd0', 'kInduced',
    'maxPitchRate', 'maxRollRate', 'qRef', 'pitchStab', 'trimSpeed'],
};

// ---------------------------------------------------------------------------
// Drone
//
// Hull: BoxGeometry(0.20, 0.07, 0.26). Four arms at +-0.11, +-0.13, four hubs and 0.115 m rotor
// discs at +-0.20, +-0.20. A 0.028 m camera ball under the nose.
//
// The hull is a box and `pods` are cylinders, so the hull is entered as a pod of matching volume
// rather than pretending a box is round. Its density is where a multirotor's mass actually lives:
// battery and motors, which do not shrink with the airframe.
//
// `hitScale` is 3.1 and that is a GAMEPLAY number, not a measurement. The aircraft is 0.63 m across
// and is flown with a 1.4 m hit radius, because a 0.63 m target crossing at 120 m/s cannot be hit.
// It sits here so the inflation is visible instead of hidden inside a hand-typed radius.
// ---------------------------------------------------------------------------

export const DRONE_LAYOUT = {
  id: 'drone', label: 'Drone', class: 'rotor',
  density: { body: 385, panel: 385, pod: 385 },
  hitScale: 3.1, chaseScale: 7.5,
  fuselage: null,
  wings: [],
  fins: [],
  pods: [
    { id: 'hull', length: 0.26, radius: 0.0745, x: 0, y: 0, z: 0, role: 'skin' },
    { id: 'armFR', length: 0.26, radius: 0.011, x: 0.11, y: 0, z: 0.13, role: 'dark' },
    { id: 'armFL', length: 0.26, radius: 0.011, x: -0.11, y: 0, z: 0.13, role: 'dark' },
    { id: 'armBR', length: 0.26, radius: 0.011, x: 0.11, y: 0, z: -0.13, role: 'dark' },
    { id: 'armBL', length: 0.26, radius: 0.011, x: -0.11, y: 0, z: -0.13, role: 'dark' },
  ],
  rotors: [
    { id: 'rotorFR', radius: 0.115, x: 0.20, y: 0.038, z: 0.20 },
    { id: 'rotorFL', radius: 0.115, x: -0.20, y: 0.038, z: 0.20 },
    { id: 'rotorBR', radius: 0.115, x: 0.20, y: 0.038, z: -0.20 },
    { id: 'rotorBL', radius: 0.115, x: -0.20, y: 0.038, z: -0.20 },
  ],
  hardpoints: [],
};

export const DRONE_TUNING = {
  note: 'Multirotor. Thrust along body up, vectored by tilting, so you tilt to move and ' +
        'level to stop. No wing, no stall, and authority does not care about airspeed.',
  lift: 'none', thrust: 'body-up', control: 'attitude',
  mesh: 'drone', idleThrottle: 0.5, enginePitch: 190, armable: true,
  circuit: { speed: 11, alt: 90, radius: 220, capture: 28 },
  thrustMax: 52, bluffCd: 0.62,
  maxTilt: 0.62, tiltGain: 4.2, maxTiltRate: 3.6,
  maxYawRate: 2.4, rateResponse: 12.0,
  cd0: 0, kInduced: 0, cdStall: 0, cdBeta: 0, sweepArea: 1, sweepDrag: 1,
  clAlpha: 0, alphaStall: 1, alphaHard: 2, qRef: 1, trimSpeed: 10,
  maxPitchRate: 3.6, maxRollRate: 3.6, pitchStab: 0, yawStab: 0,
  spawn: { alt: 60, speed: 0 }, hp: 45, abThrust: 1,
  tunables: ['thrustMax', 'mass', 'maxTilt', 'tiltGain', 'maxYawRate', 'bluffCd', 'rateResponse'],
};

// ---------------------------------------------------------------------------
// Bird
//
// Torso: SphereGeometry(0.14) scaled (1, 0.9, 2.4) — so 0.14 x 0.126 x 0.336 semi-axes.
// Wings: BoxGeometry(0.72, 0.018, 0.30) per side, pivoting at +-0.10.
// Tail:  BoxGeometry(0.26, 0.02, 0.34) at z 0.44. Head and beak are decoration.
//
// The wing entry is the PAIR, so its span is two panels plus the shoulder gap: 2 x 0.72 + 0.20.
// Entering one panel's 0.72 as the span would halve the derived area, which is exactly the mistake
// `aircraft-layout.js` warns about at the top.
//
// TWO PLACES THE DRAWN BIRD DISAGREES WITH THE FLOWN ONE, both larger than the plane's.
//
// The drawn torso is a 25 litre ellipsoid. At a bird's real density that is a 22 kg animal, and the
// physics flies it as 4.2 kg — so the body here is authored at the 3.8 litre volume 4.2 kg actually
// implies, which is 1.87x smaller in every dimension than what is on screen. And the drawn wings are
// 0.43 m2 against a flown 0.62, so the chord here is the one that reproduces the wing it flies on,
// not the one it is pictured with. Same rule as the plane: the physics was measured, the mesh was
// eyeballed, so the mesh is what is wrong.
// ---------------------------------------------------------------------------

export const BIRD_LAYOUT = {
  id: 'bird', label: 'Birdlike', class: 'bird',
  density: { body: 900, panel: 63, pod: 300 },
  hitScale: 1.93, chaseScale: 5.6,
  fuselage: { shape: 'ellipsoid', length: 0.358, radius: 0.075, height: 0.067 },
  wings: [
    { id: 'wing', span: 1.64, rootChord: 0.40, tipChord: 0.356, thickness: 0.018,
      x: 0, y: 0.05, z: -0.02, sweep: 0.10, dihedral: 0.06, lifting: true },
    { id: 'tail', span: 0.26, rootChord: 0.34, tipChord: 0.30, thickness: 0.02,
      x: 0, y: 0.02, z: 0.44, lifting: false },
  ],
  fins: [],
  pods: [],
  rotors: [],
  hardpoints: [],
};

export const BIRD_TUNING = {
  note: 'Flapping wing. Thrust comes in pulses on the wingbeat and costs stamina; hold Shift ' +
        'to fold the wings, which trades lift for a clean dive. Very low wing loading.',
  lift: 'wing', thrust: 'flap', control: 'rate',
  mesh: 'bird', idleThrottle: 0, enginePitch: 0, armable: false,
  circuit: { speed: 21, alt: 340, radius: 820, capture: 110 },
  flapPower: 70, flapHz: 3.4, flapDrain: 0.14, flapRecover: 0.34,
  sweepArea: 0.38, sweepDrag: 0.55, sweepRate: 3.2,
  clAlpha: 5.6, alphaStall: 0.34, alphaHard: 0.62,
  cd0: 0.048, kInduced: 0.075, cdStall: 0.30, cdBeta: 0.90,
  maxPitchRate: 2.2, maxRollRate: 3.0, maxYawRate: 1.1, rateResponse: 9.0,
  qRef: 90, pitchStab: 2.2, yawStab: 1.6, trimSpeed: 20, thrustMax: 0,
  spawn: { alt: 220, speed: 18 }, hp: 32, abThrust: 1,
  tunables: ['flapPower', 'flapHz', 'flapDrain', 'wingArea', 'clAlpha', 'alphaStall',
    'sweepArea', 'maxPitchRate', 'maxRollRate', 'qRef', 'trimSpeed'],
};

// ---------------------------------------------------------------------------
// A-10 Thunderbolt II
//
// The first aircraft authored FROM the layout rather than transcribed INTO it, and the first
// measured against something outside this repository. Published figures it is built to hit:
// span 17.53 m, length 16.26 m, wing area 47.0 m², empty weight 11,321 kg.
//
// Configuration, all of it load-bearing on the shape:
//   - Low-mounted cantilever straight wing, high aspect ratio (6.5), thick section, and the
//     upturned outer panels that give it the dihedral here.
//   - TWO TF34-GE-100 turbofans mounted high on the REAR FUSELAGE rather than under the wing —
//     the nacelles sit above and outboard of the body, which is why the exhausts are a list.
//   - Twin vertical fins at the tips of the tailplane, which is what shields the exhaust.
//   - GAU-8/A in the nose. It is internal, so it is a slim pod under the forward fuselage rather
//     than a barrel sticking out.
//   - Eight underwing hardpoints, four a side. The three fuselage stations are not modelled: this
//     schema hangs stores from wings.
//
// The density is the interesting number. It comes out around 175 kg/m³ of enclosed volume against
// 68 for the light plane — two and a half times denser — which is what a titanium bathtub and a
// 1,800 kg gun system actually mean when you weigh the aeroplane they are bolted into.
// ---------------------------------------------------------------------------

export const A10_LAYOUT = {
  id: 'a10', label: 'A-10', class: 'plane',
  density: { body: 175, panel: 155, pod: 215 },
  hitScale: 0.8, chaseScale: 3.4,
  fuselage: { length: 10.0, radius: 0.95, noseLength: 2.2, tailRadius: 0.72 },
  wings: [
    // straight, thick and enormous: 47 m² is three times the light plane's on a 1.5x span
    { id: 'wing', span: 17.53, rootChord: 3.55, tipChord: 1.81, thickness: 0.40,
      x: 0, y: -0.55, z: 0.6, sweep: 0, dihedral: 0.10, lifting: true },
    { id: 'stab', span: 5.90, rootChord: 2.20, tipChord: 1.60, thickness: 0.22,
      x: 0, y: 0.15, z: 7.0, lifting: false },
  ],
  fins: [
    // at the tailplane TIPS, not on the centreline — the twin tails are the aircraft's silhouette
    { id: 'finR', height: 1.85, rootChord: 2.00, tipChord: 1.25, thickness: 0.20, x: 2.95, y: 0.15, z: 7.0 },
    { id: 'finL', height: 1.85, rootChord: 2.00, tipChord: 1.25, thickness: 0.20, x: -2.95, y: 0.15, z: 7.0 },
  ],
  pods: [
    { id: 'engineR', length: 2.90, radius: 0.72, x: 1.85, y: 1.05, z: 3.4, role: 'dark' },
    { id: 'engineL', length: 2.90, radius: 0.72, x: -1.85, y: 1.05, z: 3.4, role: 'dark' },
    { id: 'gun', length: 1.20, radius: 0.18, x: 0, y: -0.45, z: -6.5, role: 'dark' },
  ],
  rotors: [],
  exhaust: [
    { id: 'exhaustR', radius: 0.5, length: 2.0, x: 1.85, y: 1.05, z: 5.6 },
    { id: 'exhaustL', radius: 0.5, length: 2.0, x: -1.85, y: 1.05, z: 5.6 },
  ],
  hardpoints: [
    { id: 'stn1', wing: 'wing', station: 0.25, drop: 0.30 },
    { id: 'stn2', wing: 'wing', station: 0.41, drop: 0.30 },
    { id: 'stn3', wing: 'wing', station: 0.57, drop: 0.28 },
    { id: 'stn4', wing: 'wing', station: 0.73, drop: 0.26 },
  ],
};

export const A10_TUNING = {
  note: 'Close air support. Two turbofans high on the tail, a wing you could land on and no ' +
        'hurry whatsoever. It turns inside anything and outruns nothing.',
  lift: 'wing', thrust: 'axial', control: 'rate',
  idleThrottle: 0.6, enginePitch: 44, armable: true, gun: 'gau8',
  circuit: { speed: 145, alt: 700, radius: 2400, capture: 700 },
  // 2 x TF34-GE-100. Their published 40.3 kN each is STATIC sea-level thrust, and feeding 80.6 kN
  // to this model produces a 990 km/h A-10 against a real 706.
  //
  // The gap is not drag, it is the missing thrust lapse: `flight-model.js` holds thrust constant
  // with airspeed, and a 6:1-bypass turbofan gives roughly half its static thrust by Mach 0.6.
  // Chasing the top speed with `cd0` instead would need 0.072 — near double the drag this airframe
  // has — and would have paid for it in climb, acceleration and turn at every other speed.
  // So this is thrust AT OPERATING SPEED, which is the honest number to give a model with no lapse
  // term, and it lands the level top speed on 706 km/h with the drag the shape actually implies.
  thrustMax: 41600, abThrust: 1,
  clAlpha: 5.2, alphaStall: 0.30, alphaHard: 0.55,
  // draggy on purpose: it is a flying brick with eleven pylons and a gun for a nose
  cd0: 0.037, kInduced: 0.061, cdStall: 0.36, cdBeta: 0.90,
  sweepArea: 1, sweepDrag: 1,
  // big ailerons over half the span, so it rolls better than its size suggests, and pitches slowly
  maxPitchRate: 0.95, maxRollRate: 1.9, maxYawRate: 0.5, rateResponse: 5.5,
  // authority holds down to ~65 m/s, which is the whole point of the aircraft
  qRef: 2600, pitchStab: 3.0, yawStab: 2.2, trimSpeed: 140,
  spawn: { alt: 700, speed: 140 }, hp: 260,
  tunables: ['thrustMax', 'wingArea', 'clAlpha', 'alphaStall', 'cd0', 'kInduced',
    'maxPitchRate', 'maxRollRate', 'qRef', 'pitchStab', 'trimSpeed'],
};

// ---------------------------------------------------------------------------
// AC-130 gunship
//
// A C-130 Hercules airframe with a battery firing out of the PORT side: a 25 mm rotary cannon
// forward of the wing, a 40 mm Bofors and a 105 mm howitzer aft of it — the AC-130U's suite. It is
// the first aircraft here whose weapons are not in the nose, and the reason `mounts` exists.
//
// Published figures the shape is built to hit (C-130H, the airframe): span 40.41 m, length
// 29.79 m, wing area 162.1 m², empty weight 34,400 kg. The gunship carries guns, ammunition and
// armour on top of that; 38,000 kg is the operating figure targeted here, an estimate, and it is
// labelled as one below rather than dressed up as a published number.
//
// Configuration, all of it on the shape:
//   - High-mounted straight wing, aspect ratio 10, thick section, on top of a fat round fuselage.
//   - FOUR turboprops in nacelles under the wing. Propellers are not modelled: `rotors` are lift
//     discs for the multirotor and would be measured as horizontal discs, so the nacelles carry a
//     small exhaust each and no disc.
//   - Tall single fin, wide low tailplane, all at the very tail.
//   - Three gun mounts low on the left fuselage, barrels depressed 20°, each with its own arc.
// ---------------------------------------------------------------------------

export const AC130_LAYOUT = {
  id: 'ac130', label: 'AC-130', class: 'plane',
  // a body density near the light plane's 68 and well under the A-10's 175: it is a cargo hold
  density: { body: 70, panel: 60, pod: 215 },
  hitScale: 0.7, chaseScale: 3.0,
  fuselage: { length: 21.0, radius: 2.05, noseLength: 3.6, tailRadius: 1.2 },
  wings: [
    { id: 'wing', span: 40.41, rootChord: 5.42, tipChord: 2.60, thickness: 0.85,
      x: 0, y: 1.9, z: -0.8, sweep: 0, dihedral: 0.04, lifting: true },
    { id: 'stab', span: 16.05, rootChord: 3.6, tipChord: 1.9, thickness: 0.32,
      x: 0, y: 1.6, z: 11.6, lifting: false },
  ],
  fins: [
    { id: 'fin', height: 6.9, rootChord: 5.6, tipChord: 2.4, thickness: 0.36, x: 0, y: 1.9, z: 11.0 },
  ],
  pods: [
    { id: 'engine1', length: 4.6, radius: 0.66, x: -9.9, y: 1.35, z: -2.6, role: 'dark' },
    { id: 'engine2', length: 4.6, radius: 0.66, x: -4.95, y: 1.35, z: -2.6, role: 'dark' },
    { id: 'engine3', length: 4.6, radius: 0.66, x: 4.95, y: 1.35, z: -2.6, role: 'dark' },
    { id: 'engine4', length: 4.6, radius: 0.66, x: 9.9, y: 1.35, z: -2.6, role: 'dark' },
  ],
  rotors: [],
  exhaust: [
    { id: 'exhaust1', radius: 0.28, length: 1.2, x: -9.9, y: 1.35, z: -0.2 },
    { id: 'exhaust2', radius: 0.28, length: 1.2, x: -4.95, y: 1.35, z: -0.2 },
    { id: 'exhaust3', radius: 0.28, length: 1.2, x: 4.95, y: 1.35, z: -0.2 },
    { id: 'exhaust4', radius: 0.28, length: 1.2, x: 9.9, y: 1.35, z: -0.2 },
  ],
  hardpoints: [],
  mounts: [
    { id: 'g25',  gun: 'm25',  pos: [-2.0, -0.7, -5.5], dir: [-1, -0.36, 0], arc: 0.55 },
    { id: 'g40',  gun: 'l60',  pos: [-2.0, -0.8, 4.2],  dir: [-1, -0.36, 0], arc: 0.5 },
    { id: 'g105', gun: 'm102', pos: [-2.0, -0.9, 7.0],  dir: [-1, -0.36, 0], arc: 0.4 },
  ],
};

export const AC130_TUNING = {
  note: 'Gunship. Four turboprops, a wing the size of a tennis court, and three guns out of the ' +
        'left side. It orbits, and everything inside the circle has a bad night.',
  lift: 'wing', thrust: 'axial', control: 'rate',
  idleThrottle: 0.55, enginePitch: 30, armable: true, gun: 'none',
  // what the player's racks carry by default: the side guns and flares, nothing off the nose or belly
  loadout: ['flare'],
  circuit: { speed: 130, alt: 2000, radius: 3200, capture: 800 },
  // 4 x Allison T56, 4,591 shp each. Propeller thrust at 150 m/s is power x efficiency / speed:
  // 4 x 3.42 MW x 0.85 / 150 is 77 kN, and that is the thrust AT OPERATING SPEED this model wants
  // (see the A-10 for why the static figure is the wrong one to give a model with no lapse term).
  thrustMax: 84000, abThrust: 1,
  clAlpha: 5.5, alphaStall: 0.28, alphaHard: 0.50,
  // fat fuselage, fixed nacelles: draggy; the induced term follows from an aspect ratio of 10
  cd0: 0.030, kInduced: 0.040, cdStall: 0.34, cdBeta: 0.95,
  sweepArea: 1, sweepDrag: 1,
  // it is forty tonnes: it does nothing quickly
  maxPitchRate: 0.5, maxRollRate: 0.85, maxYawRate: 0.32, rateResponse: 3.5,
  qRef: 3200, pitchStab: 3.2, yawStab: 2.6, trimSpeed: 135,
  spawn: { alt: 2000, speed: 140 }, hp: 640,
  tunables: ['thrustMax', 'wingArea', 'clAlpha', 'alphaStall', 'cd0', 'kInduced',
    'maxPitchRate', 'maxRollRate', 'qRef', 'pitchStab', 'trimSpeed'],
};

export const AC130_PUBLISHED = {
  span: 40.41, length: 29.79, wingArea: 162.1,
  airframeEmptyMass: 34400,        // C-130H
  operatingMass: 38000,            // ESTIMATE for the gunship fit; not a published figure
  maxSpeedKmh: 592,                // C-130H
};

export const LIBRARY = {
  plane: { layout: PLANE_LAYOUT, tuning: PLANE_TUNING },
  drone: { layout: DRONE_LAYOUT, tuning: DRONE_TUNING },
  bird: { layout: BIRD_LAYOUT, tuning: BIRD_TUNING },
  a10: { layout: A10_LAYOUT, tuning: A10_TUNING },
  ac130: { layout: AC130_LAYOUT, tuning: AC130_TUNING },
};

// The published figures the A-10 layout is built to reproduce, kept next to it so the test can
// check the derivation against the real aircraft rather than against our own table.
export const A10_PUBLISHED = {
  span: 17.53, length: 16.26, wingArea: 47.0, emptyMass: 11321, thrustTotal: 80600,
};

export function airframeFor(key) {
  const entry = LIBRARY[key];
  if (!entry) throw new Error(`no library aircraft '${key}'. Have: ${Object.keys(LIBRARY).join(', ')}`);
  return airframeFromLayout(entry.layout, entry.tuning);
}
