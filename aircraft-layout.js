// aircraft-layout.js — the parametric skeleton an aircraft is authored as, and the physics numbers
// that fall out of its shape.
//
// THE POINT OF THIS FILE IS THE LINK BETWEEN THE TWO.
//
// Today an airframe's `wingArea` and `mass` are typed into `flight-airframes.js` by hand, and its
// wing is a hard-coded box in `flight-meshes.js`, and nothing checks that the two describe the same
// aircraft. They do not: the shipped plane's drawn wing and its flown wing disagree by a factor of
// nearly two, which nobody could have seen because there was no code that compared them. A studio
// where you drag a wing longer and the stall speed does not move is two panels on one page, not an
// aircraft studio. So the shape is authored and the area, the mass and the extents are MEASURED
// from it.
//
// The split is the same one the bot rig already makes: this is the skeleton, the load-bearing shape
// that carries lift and mass and hardpoints. Canopies, beaks, cameras and intakes are decoration
// hung on the anchors this produces, and they belong in a ModelSpec, not here.
//
// No THREE and no DOM, so it runs under Node — `test-aircraft-layout.mjs` is what holds the
// derivation honest. Its one import is `flight-airframes.js`, which is pure data with no imports of
// its own, so nothing here needs a GPU.

import { RHO, G } from './flight-airframes.js';

// ---------------------------------------------------------------------------
// The schema
// ---------------------------------------------------------------------------
//
// layout = {
//   id, label, class,        // 'plane' | 'rotor' | 'bird' — what KIND of thing this is
//   density,                 // kg/m^3 of enclosed volume: the one number that turns shape into mass
//   fuselage: { length, radius, noseLength, tailRadius },
//   wings:  [ { id, span, rootChord, tipChord, thickness, x, y, z, sweep, dihedral, lifting } ],
//   fins:   [ { id, height, rootChord, tipChord, thickness, x, y, z } ],
//   pods:   [ { id, length, radius, x, y, z, role } ],      // nacelles, intakes, booms, hubs
//   rotors: [ { id, radius, x, y, z } ],
//   hardpoints: [ { id, wing, station, mirror } ],          // station is 0..1 along the half-span
//   mounts: [ { id, gun, pos: [x,y,z], dir: [x,y,z], arc } ],  // side/turret guns, arc = half-angle
// }
//
// `span` is TIP TO TIP, not per side. Getting that wrong halves or doubles every derived area, and
// it is the single easiest thing to be quietly wrong about in the whole file.

export const AIRCRAFT_CLASSES = ['plane', 'rotor', 'bird'];

// Aircraft are mostly air. These are densities of the volume the skin encloses, not of aluminium.
//
// One number per aircraft was not enough, and the bird is what proved it: a wing is a thin panel of
// membrane and spar, a body is flesh or batteries, and forcing both through one figure made a 4.2 kg
// bird come out at 28 kg. Split three ways, every craft lands in a range you can defend out loud —
// 68 kg/m^3 for a light aircraft's enclosed volume, 385 for a multirotor whose battery and motors do
// not shrink with the airframe, 900 for a bird's body against 63 for its feathers.
export const CLASS_DENSITY = {
  plane: { body: 68, panel: 50, pod: 68 },
  rotor: { body: 385, panel: 385, pod: 385 },
  bird: { body: 900, panel: 63, pod: 300 },
};

function densities(layout) {
  const d = layout.density ?? CLASS_DENSITY[layout.class] ?? CLASS_DENSITY.plane;
  if (typeof d === 'number') return { body: d, panel: d, pod: d };
  const fallback = CLASS_DENSITY[layout.class] ?? CLASS_DENSITY.plane;
  return { body: d.body ?? fallback.body, panel: d.panel ?? fallback.panel, pod: d.pod ?? fallback.pod };
}

const PI = Math.PI;
const sum = (a) => a.reduce((t, v) => t + v, 0);

// ---------------------------------------------------------------------------
// Volumes
//
// Each one matches the primitive the mesh builder draws for that part, so the mass and the picture
// are talking about the same solid.
// ---------------------------------------------------------------------------

export const capsuleVolume = (r, len) => PI * r * r * len + (4 / 3) * PI * r * r * r;
export const coneVolume = (r, h) => (PI * r * r * h) / 3;
export const cylinderVolume = (r, h) => PI * r * r * h;
export const ellipsoidVolume = (a, b, c) => (4 / 3) * PI * a * b * c;
// a tapered plate: mean chord times span times thickness
export const panelVolume = (span, root, tip, thick) => span * ((root + tip) / 2) * thick;

// ---------------------------------------------------------------------------
// Derived geometry
// ---------------------------------------------------------------------------

export function wingPanelArea(w) { return w.span * ((w.rootChord + w.tipChord) / 2); }

// The eight corners of one lifting-surface pair, in the aircraft's frame. This is the single
// definition of where a wing physically is: the bounds read it, and `aircraft-meshes.js` builds its
// geometry from the same function, so the measured aircraft and the drawn one cannot disagree.
export function panelCorners(w) {
  const half = w.span / 2, gap = (w.rootGap || 0) / 2;
  const back = Math.tan(w.sweep || 0) * (half - gap);
  const up = Math.tan(w.dihedral || 0) * (half - gap);
  const hr = w.rootChord / 2, ht = w.tipChord / 2, t = w.thickness / 2;
  const x = w.x || 0, y = w.y || 0, z = w.z || 0;
  const out = [];
  for (const side of [1, -1]) {
    for (const dy of [-t, t]) {
      out.push([x + side * gap, y + dy, z - hr], [x + side * gap, y + dy, z + hr],
        [x + side * half, y + up + dy, z + back - ht], [x + side * half, y + up + dy, z + back + ht]);
    }
  }
  return out;
}

// Same, for a vertical surface: it grows in +y instead of +-x.
export function finCorners(s) {
  const hr = s.rootChord / 2, ht = s.tipChord / 2, t = s.thickness / 2;
  const x = s.x || 0, y = s.y || 0, z = s.z || 0;
  const back = Math.tan(s.sweep || 0) * s.height;
  const out = [];
  for (const dx of [-t, t]) {
    out.push([x + dx, y, z - hr], [x + dx, y, z + hr],
      [x + dx, y + s.height, z + back - ht], [x + dx, y + s.height, z + back + ht]);
  }
  return out;
}

// Reference area, and it counts ONLY surfaces marked `lifting`. A tailplane has area and makes no
// useful lift; counting it would quietly inflate the wing the physics thinks it has.
export function wingAreaOf(layout) {
  return sum((layout.wings || []).filter((w) => w.lifting !== false).map(wingPanelArea));
}

// Volume split by what the part is made of, because they are not made of the same thing.
export function volumesOf(layout) {
  const f = layout.fuselage;
  let body = 0, panel = 0, pod = 0;
  if (f) {
    // a bird's torso is an ellipsoid and a fuselage is a capsule; approximating one with the other
    // is a 40% error on the volume that dominates the whole mass
    body += f.shape === 'ellipsoid'
      ? ellipsoidVolume(f.radius, f.height ?? f.radius, f.length / 2)
      : capsuleVolume(f.radius, f.length);
    if (f.noseLength) body += coneVolume(f.tailRadius ?? f.radius, f.noseLength);
  }
  for (const w of layout.wings || []) panel += panelVolume(w.span, w.rootChord, w.tipChord, w.thickness);
  for (const s of layout.fins || []) panel += panelVolume(s.height, s.rootChord, s.tipChord, s.thickness);
  for (const p of layout.pods || []) pod += cylinderVolume(p.radius, p.length);
  return { body, panel, pod, total: body + panel + pod };
}

export function volumeOf(layout) { return volumesOf(layout).total; }

export function massOf(layout) {
  const d = densities(layout);
  const v = volumesOf(layout);
  return v.body * d.body + v.panel * d.panel + v.pod * d.pod;
}

// Axis-aligned extents in the aircraft's own frame: x right, y up, z back (nose at -z), matching
// `flight-meshes.js` and the body axes in `flight-model.js`.
export function boundsOf(layout) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  const add = (cx, cy, cz, hx, hy, hz) => {
    lo[0] = Math.min(lo[0], cx - hx); hi[0] = Math.max(hi[0], cx + hx);
    lo[1] = Math.min(lo[1], cy - hy); hi[1] = Math.max(hi[1], cy + hy);
    lo[2] = Math.min(lo[2], cz - hz); hi[2] = Math.max(hi[2], cz + hz);
  };
  const f = layout.fuselage;
  if (f) {
    const half = f.shape === 'ellipsoid' ? f.length / 2 : f.length / 2 + f.radius;
    add(0, 0, 0, f.radius, f.height ?? f.radius, half);
    if (f.noseLength) add(0, 0, -(half + f.noseLength / 2), f.radius, f.radius, f.noseLength / 2);
  }
  // Wings and fins take their true corners rather than a box around them. A box that assumed the
  // ROOT chord all the way out overstates a tapered swept wing by most of the taper, and since
  // `hitRadius`, `chaseDist` and `size` all come off these extents, that error would propagate into
  // three numbers the sim reads every frame. It also has to match what the mesh builder draws, or
  // the measured aircraft and the drawn one part company again.
  const addPoint = (x, y, z) => {
    lo[0] = Math.min(lo[0], x); hi[0] = Math.max(hi[0], x);
    lo[1] = Math.min(lo[1], y); hi[1] = Math.max(hi[1], y);
    lo[2] = Math.min(lo[2], z); hi[2] = Math.max(hi[2], z);
  };
  for (const w of layout.wings || []) {
    for (const c of panelCorners(w)) addPoint(c[0], c[1], c[2]);
  }
  for (const s of layout.fins || []) {
    for (const c of finCorners(s)) addPoint(c[0], c[1], c[2]);
  }
  for (const p of layout.pods || []) add(p.x || 0, p.y || 0, p.z || 0, p.radius, p.radius, p.length / 2);
  for (const r of layout.rotors || []) add(r.x || 0, r.y || 0, r.z || 0, r.radius, 0.02, r.radius);
  if (!Number.isFinite(lo[0])) return { lo: [0, 0, 0], hi: [0, 0, 0], size: [0, 0, 0], centre: [0, 0, 0] };
  return {
    lo, hi,
    size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]],
    centre: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2],
  };
}

// Half the bounding diagonal: how big the aircraft actually is.
export function geometricRadiusOf(layout) {
  const s = boundsOf(layout).size;
  return 0.5 * Math.hypot(s[0], s[1], s[2]);
}

// What the sim reads as `hitRadius`, which is NOT the same question.
//
// `hitRadius` is overloaded five ways — the bullet and blast test, the HUD box, the explosion scale,
// the wreck FX scale and the weapon spawn offset — and for a small craft the gameplay hitbox is
// deliberately larger than the aircraft. The shipped drone is 0.63 m across and is flown with a
// 1.4 m hit radius, because a 0.63 m target crossing at 120 m/s is not a target, it is a joke.
//
// So the inflation stays, and `hitScale` is where it lives: authored, visible, next to the shape it
// inflates, instead of buried inside a hand-typed radius where nobody could tell it was a gameplay
// decision rather than a measurement.
export function hitRadiusOf(layout) {
  return geometricRadiusOf(layout) * (layout.hitScale ?? 1);
}

// Frontal area for a craft with no wing, which is the only thing the drag branch has to work with
// once `lift: 'none'` takes it away from the wing formula.
export function frontalAreaOf(layout) {
  const s = boundsOf(layout).size;
  return s[0] * s[1];
}

// ---------------------------------------------------------------------------
// Anchors and hardpoints
//
// The anchor list is DERIVED, the way the creature target's is, rather than a fixed constant — a
// twin-boom layout has anchors a single-fuselage one does not, and a list that could not express
// that would be a list that quietly assumed one airframe.
// ---------------------------------------------------------------------------

// A twin-engined aircraft has two of them, so `exhaust` is a list. A bare object is accepted and
// wrapped, because the first version of this schema had exactly one and said so.
export function exhaustsOf(layout) {
  const e = layout.exhaust;
  if (!e) return [];
  return (Array.isArray(e) ? e : [e]).map((x, i) => ({ id: x.id || `exhaust${i}`, ...x }));
}

export function anchorsOf(layout) {
  const out = ['body'];
  if (layout.fuselage) out.push('nose', 'tail');
  for (const w of layout.wings || []) out.push(`${w.id}.root`, `${w.id}.tip`);
  for (const s of layout.fins || []) out.push(`${s.id}.root`, `${s.id}.tip`);
  for (const p of layout.pods || []) out.push(p.id);
  for (const r of layout.rotors || []) out.push(r.id);
  for (const e of exhaustsOf(layout)) out.push(e.id);
  for (const hp of hardpointsOf(layout)) out.push(hp.id);
  for (const m of mountsOf(layout)) out.push(m.id);
  return out;
}

// A gun that fires out of the side rather than the nose. Positions are the aircraft's own frame like
// everything else here; `dir` is normalised so a layout can say `[-1, -0.3, 0]` and mean it. The
// same list goes onto the airframe descriptor unchanged, which is how the sim's `makeMounts` and the
// mesh builder's barrels agree on where the muzzle is.
export function mountsOf(layout) {
  return (layout.mounts || []).map((m, i) => {
    const d = m.dir || [-1, 0, 0];
    const len = Math.hypot(d[0], d[1], d[2]) || 1;
    return { id: m.id || `mount${i}`, ...m, pos: m.pos || [0, 0, 0], dir: [d[0] / len, d[1] / len, d[2] / len] };
  });
}

// Where a store hangs, in the aircraft's own frame. `station` is a fraction of the HALF span, so
// 0 is the root and 1 is the tip, and `mirror` gives you the matching one on the other side.
//
// Nothing in the sim has ever had these: ordnance spawns at a literal offset written next to the
// fire call, and nothing is visible on an aircraft before it fires. This is what closes that.
export function hardpointsOf(layout) {
  const byId = Object.fromEntries((layout.wings || []).map((w) => [w.id, w]));
  const out = [];
  for (const hp of layout.hardpoints || []) {
    const w = byId[hp.wing];
    if (!w) continue;
    const half = w.span / 2;
    const along = half * (hp.station ?? 0.5);
    const back = Math.tan(w.sweep || 0) * along;
    const up = Math.tan(w.dihedral || 0) * along;
    const chordHere = w.rootChord + (w.tipChord - w.rootChord) * (hp.station ?? 0.5);
    for (const side of hp.mirror === false ? [1] : [1, -1]) {
      out.push({
        id: hp.mirror === false ? hp.id : `${hp.id}.${side > 0 ? 'r' : 'l'}`,
        wing: hp.wing, side,
        // under the wing, half a thickness clear, so a store hangs rather than intersects
        p: [(w.x || 0) + side * along, (w.y || 0) + up - w.thickness * 0.5 - (hp.drop ?? 0.12),
          (w.z || 0) + back],
        chord: chordHere,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shape to airframe
// ---------------------------------------------------------------------------

// The five fields a shape can answer for itself. Everything else about an airframe — thrust, control
// rates, stall angle, trim speed — is tuning, and no amount of measuring a wing will produce it.
export const DERIVED_FIELDS = ['mass', 'wingArea', 'hitRadius', 'size', 'chaseDist'];

export function deriveGeometry(layout) {
  const b = boundsOf(layout);
  const r = geometricRadiusOf(layout);
  return {
    mass: massOf(layout),
    wingArea: wingAreaOf(layout),
    hitRadius: hitRadiusOf(layout),
    // `size` is read as ground clearance (`af.size * 3 + 1.2`) and as the cockpit eye offset, so it
    // is how far the aircraft hangs below its own origin, not a general scale factor
    size: Math.max(1e-3, b.size[1] / 2),
    // Off the GEOMETRIC radius, deliberately, so an inflated hitbox does not drag the camera back
    // with it. `chaseScale` is authored because camera distance does not scale purely with the
    // aircraft: a small craft needs a standoff a large one does not, and the shipped three want
    // 3.4x, 7.5x and 5.6x for exactly that reason.
    chaseDist: Math.max(1, (layout.chaseScale ?? 3.4) * r),
    geometricRadius: r,
    frontalArea: frontalAreaOf(layout),
    volume: volumeOf(layout),
    volumes: volumesOf(layout),
    bounds: b,
  };
}

// ---------------------------------------------------------------------------
// Derived performance
//
// Analytic, not flown — `aircraft-bench` in the studio flies things. These are the numbers a design
// panel needs to update while a slider is moving, which rules out anything that takes a simulation.
// ---------------------------------------------------------------------------

// Re-exported rather than restated. The first cut of this section declared its own `RHO = 1.225`
// and `G = 9.81` beside the identical constants in `flight-airframes.js`, which is two
// definitions of gravity that nothing would ever have reconciled — the same drift this repo already
// warns about for its CPU/GPU math twins.
export { RHO, G };

// Where lift at the stalling angle of attack equals weight. Below it the wing cannot hold the
// aircraft up at any attitude.
export function stallSpeedOf(af) {
  if (af.lift !== 'wing' || !(af.wingArea > 0) || !(af.clAlpha > 0)) return null;
  const clMax = af.clAlpha * af.alphaStall;
  if (!(clMax > 0)) return null;
  return Math.sqrt((2 * af.mass * G) / (RHO * af.wingArea * clMax));
}

// The speed at which control authority reaches 1.0, since authority scales with dynamic pressure
// against `qRef`.
//
// For the shipped plane this is 47.8 m/s against an aerodynamic stall of 27.0 — so what actually
// limits it slow is the controls going soft, not the wing letting go, and a panel that showed only
// the stall speed would be reporting the wrong limit by a factor of nearly two.
export function authoritySpeedOf(af) {
  if (af.control === 'attitude' || !(af.qRef > 0)) return null;
  return Math.sqrt((2 * af.qRef) / RHO);
}

// Where thrust equals drag in level flight — the speed the aircraft actually tops out at.
//
// It has to be solved rather than flown, and the reason is a trap worth recording: flying one at
// full throttle and taking the fastest speed seen does NOT measure this. The aircraft climbs, hits
// the model's 6 km altitude clamp, and then spends its whole excess thrust on speed at the ceiling,
// so the number keeps rising with the length of the run — a 90 second test read 766 km/h and a 180
// second test read 877 km/h for the same aeroplane.
//
// Drag against speed is a U: induced drag dominates slow, parasitic drag dominates fast, so thrust
// meets it twice. The high root is the one that means anything, hence bisecting above the
// minimum-drag speed rather than from zero.
export function levelTopSpeedOf(af, { withAfterburner = true } = {}) {
  if (af.lift !== 'wing' || !(af.wingArea > 0) || !(af.thrustMax > 0)) return null;
  const T = af.thrustMax * (withAfterburner ? (af.abThrust || 1) : 1);
  const W = af.mass * G;
  const S = af.wingArea;
  const drag = (v) => {
    const q = 0.5 * RHO * v * v;
    if (q < 1e-6) return Infinity;
    const cl = W / (q * S);
    return q * S * (af.cd0 + af.kInduced * cl * cl);
  };
  // speed of minimum drag, where the two terms are equal
  const vMd = Math.sqrt((2 * W) / (RHO * S) * Math.sqrt(af.kInduced / Math.max(1e-9, af.cd0)));
  if (drag(vMd) >= T) return null;              // cannot hold level flight at any speed
  let lo = vMd, hi = Math.max(vMd * 2, 400);
  if (drag(hi) < T) return hi;                  // faster than the search window; caller can widen it
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (drag(mid) < T) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export function aspectRatioOf(layout) {
  const lift = (layout.wings || []).filter((w) => w.lifting !== false);
  const area = wingAreaOf(layout);
  if (!lift.length || area <= 0) return 0;
  const span = Math.max(...lift.map((w) => w.span));
  return (span * span) / area;
}

// A layout plus its tuning becomes a descriptor `registerAirframe` will accept. The derived fields
// are written LAST so a tuning block cannot quietly override the shape — if you want a heavier
// aircraft you make it bigger or denser, which is the entire discipline this file exists to impose.
export function airframeFromLayout(layout, tuning = {}) {
  const g = deriveGeometry(layout);
  const af = {
    label: layout.label || layout.id,
    note: layout.note || '',
    // A craft drawn from its own layout names its mesh after itself, so a new aircraft does not
    // have to borrow one of the three hard-coded builders to be legal.
    mesh: layout.id,
    ...tuning,
    ...(layout.mounts ? { mounts: mountsOf(layout) } : {}),
    mass: g.mass,
    wingArea: g.wingArea,
    hitRadius: g.hitRadius,
    size: g.size,
    chaseDist: g.chaseDist,
  };
  if (af.lift === 'none' && af.bluffArea === undefined) af.bluffArea = g.frontalArea;
  return af;
}
