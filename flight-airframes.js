// flight-airframes.js — the three airframe descriptors and their tuning tables.
//
// Pure data, no imports. The three classes are genuinely different physics rather than one model
// with different numbers, so each entry names its force generators (`lift`, `thrust`, `control`)
// and `flight-model.js` branches on those rather than on the airframe key.
//
//   |         | Plane                | Drone                     | Birdlike                  |
//   |---------|----------------------|---------------------------|---------------------------|
//   | Thrust  | along the nose       | along body up, vectored   | impulsive, on the wingbeat|
//   | Lift    | wing at AoA          | none, thrust carries it   | wing at AoA, low loading  |
//   | Control | rate, authority ~ q  | attitude, self-levelling  | rate plus flap impulse    |
//   | Stall   | central              | not applicable            | recoverable               |
//
// The airspeed-dependent control authority on the plane and bird (`qRef`) is what makes a stall
// feel like a stall rather than a speed cap. The drone deliberately has none of it.

export const RHO = 1.225;   // sea-level air density, kg/m^3
export const G = 9.81;

export const AIRFRAMES = {
  plane: {
    label: 'Plane',
    note: 'Fixed wing. Thrust along the nose, lift from the wing. Cannot hover, cannot stop. ' +
          'Control authority dies with airspeed, so a stall takes the controls with it.',
    lift: 'wing', thrust: 'axial', control: 'rate',
    mass: 950, wingArea: 16, chaseDist: 26, size: 1,
    thrustMax: 11000,        // N at full throttle
    clAlpha: 5.0,            // per radian
    alphaStall: 0.26, alphaHard: 0.50,
    cd0: 0.026, kInduced: 0.055, cdStall: 0.34, cdBeta: 0.85,
    sweepArea: 1, sweepDrag: 1,   // no variable geometry; the shared area formula still reads these
    maxPitchRate: 1.35, maxRollRate: 3.4, maxYawRate: 0.55,
    rateResponse: 7.0,
    qRef: 1400,              // dynamic pressure at which control authority is 1.0
    pitchStab: 2.6, yawStab: 1.8,
    trimSpeed: 105,          // speed the stability assist trims for
    spawn: { alt: 900, speed: 105 },
    hp: 110, hitRadius: 6.5, abThrust: 1.85,
    tunables: ['thrustMax', 'wingArea', 'clAlpha', 'alphaStall', 'cd0', 'kInduced',
               'maxPitchRate', 'maxRollRate', 'qRef', 'pitchStab', 'trimSpeed'],
  },
  drone: {
    label: 'Drone',
    note: 'Multirotor. Thrust along body up, vectored by tilting, so you tilt to move and ' +
          'level to stop. No wing, no stall, and authority does not care about airspeed.',
    lift: 'none', thrust: 'body-up', control: 'attitude',
    mass: 1.9, wingArea: 0, chaseDist: 3.4, size: 0.09,
    thrustMax: 52,           // ~2.8x weight
    bluffCd: 0.62, bluffArea: 0.10,
    maxTilt: 0.62, tiltGain: 4.2, maxTiltRate: 3.6,
    maxYawRate: 2.4, rateResponse: 12.0,
    cd0: 0, kInduced: 0, cdStall: 0, cdBeta: 0, sweepArea: 1, sweepDrag: 1,
    clAlpha: 0, alphaStall: 1, alphaHard: 2, qRef: 1, trimSpeed: 10,
    maxPitchRate: 3.6, maxRollRate: 3.6, pitchStab: 0, yawStab: 0,
    spawn: { alt: 60, speed: 0 },
    hp: 45, hitRadius: 1.4, abThrust: 1,
    tunables: ['thrustMax', 'mass', 'maxTilt', 'tiltGain', 'maxYawRate', 'bluffCd', 'rateResponse'],
  },
  bird: {
    label: 'Birdlike',
    note: 'Flapping wing. Thrust comes in pulses on the wingbeat and costs stamina; hold Shift ' +
          'to fold the wings, which trades lift for a clean dive. Very low wing loading.',
    lift: 'wing', thrust: 'flap', control: 'rate',
    mass: 4.2, wingArea: 0.62, chaseDist: 5.2, size: 0.16,
    flapPower: 70, flapHz: 3.4, flapDrain: 0.14, flapRecover: 0.34,
    sweepArea: 0.38, sweepDrag: 0.55, sweepRate: 3.2,
    clAlpha: 5.6,
    alphaStall: 0.34, alphaHard: 0.62,
    cd0: 0.048, kInduced: 0.075, cdStall: 0.30, cdBeta: 0.90,
    maxPitchRate: 2.2, maxRollRate: 3.0, maxYawRate: 1.1,
    rateResponse: 9.0,
    qRef: 90,
    pitchStab: 2.2, yawStab: 1.6,
    trimSpeed: 20,
    thrustMax: 0,
    spawn: { alt: 220, speed: 18 },
    hp: 32, hitRadius: 1.8, abThrust: 1,
    tunables: ['flapPower', 'flapHz', 'flapDrain', 'wingArea', 'clAlpha', 'alphaStall',
               'sweepArea', 'maxPitchRate', 'maxRollRate', 'qRef', 'trimSpeed'],
  },
};

// slider bounds for the tuning panel: [min, max, step]
export const TUNE_RANGE = {
  thrustMax:    [0, 24000, 50], mass: [0.5, 2000, 0.1], wingArea: [0.1, 40, 0.1],
  clAlpha:      [1, 9, 0.1],    alphaStall: [0.08, 0.7, 0.01], cd0: [0.005, 0.2, 0.001],
  kInduced:     [0.01, 0.25, 0.005], maxPitchRate: [0.3, 5, 0.05], maxRollRate: [0.3, 6, 0.05],
  maxYawRate:   [0.1, 4, 0.05], qRef: [10, 4000, 10], pitchStab: [0, 8, 0.1],
  maxTilt:      [0.1, 1.3, 0.02], tiltGain: [0.5, 12, 0.1], bluffCd: [0.1, 2, 0.02],
  rateResponse: [1, 20, 0.5],   flapPower: [5, 200, 1], flapHz: [0.5, 8, 0.1],
  flapDrain:    [0, 1.2, 0.01], sweepArea: [0.1, 1, 0.02], trimSpeed: [8, 240, 1],
};

// a deep copy taken before any slider touches AIRFRAMES, so "reset" has something to reset to
export const DEFAULTS = JSON.parse(JSON.stringify(AIRFRAMES));
