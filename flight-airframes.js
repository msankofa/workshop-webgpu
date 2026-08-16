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
//
// EVERY per-class difference belongs in this table. It did not use to: the mesh builder, the AI
// patrol circuit, the engine tone and the starting throttle each carried their own
// `key === 'plane' ? … : key === 'drone' ? … : …` chain, and every one of those chains ended in the
// BIRD's value with no error. A fourth airframe therefore flew a bird's circuit, looked like a bird
// and made a plane's engine noise, silently. `mesh`, `circuit`, `enginePitch`, `idleThrottle` and
// `armable` exist to end that, and `validateAirframe` is what makes a missing one loud.

export const RHO = 1.225;   // sea-level air density, kg/m^3
export const G = 9.81;

// The force generators `flight-model.js` actually implements. A value outside these sets is a
// silent no-force in the integrator, so registration rejects it rather than letting it fly.
export const LIFT_KINDS = ['wing', 'none'];
export const THRUST_KINDS = ['axial', 'body-up', 'flap', 'none'];
export const CONTROL_KINDS = ['rate', 'attitude'];

export const AIRFRAMES = {
  plane: {
    label: 'Plane',
    note: 'Fixed wing. Thrust along the nose, lift from the wing. Cannot hover, cannot stop. ' +
          'Control authority dies with airspeed, so a stall takes the controls with it.',
    lift: 'wing', thrust: 'axial', control: 'rate',
    mesh: 'plane', idleThrottle: 0.7, enginePitch: 62, armable: true,
    circuit: { speed: 120, alt: 1100, radius: 2600, capture: 750 },
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
    mesh: 'drone', idleThrottle: 0.5, enginePitch: 190, armable: true,
    circuit: { speed: 11, alt: 90, radius: 220, capture: 28 },
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
    // silent engine, and no weapons: a raptor menaces, it does not shoot
    mesh: 'bird', idleThrottle: 0, enginePitch: 0, armable: false,
    circuit: { speed: 21, alt: 340, radius: 820, capture: 110 },
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

// ---------------------------------------------------------------------------
// The registry
//
// `validateAirframe` is the whole point of this section. Every field it checks is one that used to
// fail silently: a missing `circuit` meant a bird's patrol, a missing `mesh` meant a bird's model, a
// `tunables` entry with no `TUNE_RANGE` row meant a slider that simply never appeared. The cost of
// getting one wrong was an aircraft that flew and looked plausible and was not what you authored.
// ---------------------------------------------------------------------------

// read on every craft whatever its force generators are
const REQUIRED = ['label', 'mesh', 'mass', 'wingArea', 'sweepArea', 'hp', 'hitRadius', 'size',
  'chaseDist', 'rateResponse', 'maxYawRate', 'idleThrottle', 'enginePitch'];

// read only on the branch the generator selects
const BY_LIFT = {
  wing: ['clAlpha', 'alphaStall', 'alphaHard', 'cd0', 'kInduced', 'cdStall', 'cdBeta', 'sweepDrag',
    'qRef', 'trimSpeed', 'pitchStab', 'yawStab', 'maxPitchRate', 'maxRollRate'],
  none: ['bluffCd', 'bluffArea'],
};
const BY_THRUST = {
  axial: ['thrustMax', 'abThrust'],
  'body-up': ['thrustMax'],
  flap: ['flapPower', 'flapHz', 'flapDrain', 'flapRecover'],
  none: [],
};
const BY_CONTROL = { attitude: ['maxTilt', 'tiltGain', 'maxTiltRate'], rate: [] };

const num = (v) => typeof v === 'number' && Number.isFinite(v);

// Returns a list of complaints, empty if the descriptor is flyable. Never throws — callers decide
// whether a bad airframe is fatal (registration) or a warning (a studio mid-edit).
export function validateAirframe(key, def) {
  const e = [];
  if (!def || typeof def !== 'object') return [`${key}: not an object`];
  if (!LIFT_KINDS.includes(def.lift)) e.push(`${key}: lift '${def.lift}' is not one of ${LIFT_KINDS}`);
  if (!THRUST_KINDS.includes(def.thrust)) e.push(`${key}: thrust '${def.thrust}' is not one of ${THRUST_KINDS}`);
  if (!CONTROL_KINDS.includes(def.control)) e.push(`${key}: control '${def.control}' is not one of ${CONTROL_KINDS}`);
  for (const f of REQUIRED) {
    if (f === 'label' || f === 'mesh') { if (!def[f]) e.push(`${key}: missing ${f}`); continue; }
    if (!num(def[f])) e.push(`${key}: ${f} must be a finite number`);
  }
  for (const f of [...(BY_LIFT[def.lift] || []), ...(BY_THRUST[def.thrust] || []),
    ...(BY_CONTROL[def.control] || [])]) {
    if (!num(def[f])) e.push(`${key}: ${f} is required by lift/thrust/control and must be a number`);
  }
  if (!def.spawn || !num(def.spawn.alt) || !num(def.spawn.speed)) e.push(`${key}: spawn needs alt and speed`);
  const c = def.circuit;
  if (!c || !num(c.speed) || !num(c.alt) || !num(c.radius) || !num(c.capture)) {
    e.push(`${key}: circuit needs speed, alt, radius and capture (the AI patrol)`);
  }
  for (const t of def.tunables || []) {
    if (!TUNE_RANGE[t]) e.push(`${key}: tunable '${t}' has no TUNE_RANGE row, so its slider never appears`);
    else if (!num(def[t])) e.push(`${key}: tunable '${t}' is not a number on the descriptor`);
  }
  // Shape only; the gun key itself is resolved (and rejected) by `makeMounts` at construction, since
  // the gun table lives in flight-combat and this file must not import it.
  const vec3 = (a) => Array.isArray(a) && a.length === 3 && a.every(num);
  if (def.mounts !== undefined && !Array.isArray(def.mounts)) e.push(`${key}: mounts must be a list`);
  for (const m of Array.isArray(def.mounts) ? def.mounts : []) {
    if (!m || !m.id || !m.gun) e.push(`${key}: every mount needs an id and a gun`);
    else if (!vec3(m.pos) || !vec3(m.dir)) e.push(`${key}: mount '${m.id}' needs pos and dir as [x, y, z]`);
    else if (m.arc !== undefined && !(num(m.arc) && m.arc > 0)) e.push(`${key}: mount '${m.id}' arc must be a positive angle`);
  }
  // the default rack: a list of store keys, read by the player's weapons panel; absent means all
  if (def.loadout !== undefined && !(Array.isArray(def.loadout) && def.loadout.every((k) => typeof k === 'string'))) {
    e.push(`${key}: loadout must be a list of store keys`);
  }
  return e;
}

// The lookup every consumer should use. A typo or an unregistered key throws HERE, naming what is
// registered, rather than falling through to whichever craft the ternary happened to end on.
export function getAirframe(key) {
  const af = AIRFRAMES[key];
  if (!af) throw new Error(`unknown airframe '${key}'. Registered: ${Object.keys(AIRFRAMES).join(', ')}`);
  return af;
}

export function airframeKeys() { return Object.keys(AIRFRAMES); }

// Adds an airframe at runtime — how a studio-authored craft gets into the sim. It validates first,
// and takes its own `DEFAULTS` snapshot so the tuning panel's reset works on it like any other.
export function registerAirframe(key, def) {
  const errors = validateAirframe(key, def);
  if (errors.length) throw new Error(`cannot register airframe '${key}':\n  ${errors.join('\n  ')}`);
  AIRFRAMES[key] = def;
  DEFAULTS[key] = JSON.parse(JSON.stringify(def));
  return def;
}
