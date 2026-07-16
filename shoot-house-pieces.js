// shoot-house-pieces.js — the CQB cover vocabulary (phase 2). Pure, three-free.
// Each piece is a small function returning an array of {kind,cx,cy,cz,sx,sy,sz,material} boxes,
// keyed to shoot-house-style.js material names. Pieces are the composable atoms that room archetypes
// (phase 3) arrange deliberately around doors and sightlines — replacing v2's random-cube clutter.
// Dark bodies + emissive accents so each piece reads its role and glows under bloom.
// Every piece takes `accent` (a material key, default 'neon') so phase-3 zoning can two-tone them.
// Decoupled from shoot-house-layout.js on purpose (that module is the consumer): default dimensions
// are pre-derived from the FPS capsule (BODY.heightStand ≈ 1.8) rather than imported, so there is no
// import cycle. Callers pass explicit dims when they have them.

const round2 = (x) => Math.round(x * 100) / 100;
const box = (kind, material, cx, cy, cz, sx, sy, sz) => ({ kind, cx, cy, cz, sx, sy, sz, material });

// human-scale default heights (heightStand 1.8)
const CHEST = 1.12;         // 1.8*0.62 — peek/vault height
const SHOULDER = 1.48;      // 1.8*0.82 — sightline-breaking baffle height
// deck top clears head height (you climb up to look DOWN); underside 2.23 lets a player walk beneath it.
const DECK_H = 2.43;        // 1.8*1.35 — overwatch deck height
const RAIL_H = 1.01;        // 1.8*0.56 — railing height
const DOOR_W = 2.7;         // matches shoot-house-layout DOOR_W

// axis span helper: returns [sx, sz] for a length `len` and thickness `thick` on axis 'x'|'z'
const span = (orient, len, thick) => (orient === 'x' ? [len, thick] : [thick, len]);

// ── Holo-barrier ──────────────────────────────────────────────────────────────
// Chest-high dark block with a glowing top lip. Peek/vault cover that defines a firing lane.
export function holoBarrier({ cx, cz, orient = 'x', len = 2.6, thick = 0.5, h = CHEST, accent = 'neon' }) {
  const [sx, sz] = span(orient, len, thick);
  return [
    box('cover', 'cover', cx, h / 2, cz, sx, h, sz),          // body
    box('neon', accent, cx, h + 0.05, cz, sx, 0.1, sz),       // glowing top lip
  ];
}

// ── Light-pillar ────────────────────────────────────────────────────────────
// Full-height dark column with vertical neon strips on all four faces. Hard cover you flank around;
// also a rhythm/landmark element.
export function lightPillar({ cx, cz, w = 1.2, H, accent = 'neon' }) {
  const stripH = round2(H * 0.9), sw = 0.08, proud = 0.03, y = H / 2;
  const off = w / 2 + proud / 2;
  return [
    box('pillar', 'panel', cx, H / 2, cz, w, H, w),                    // body
    box('neon', accent, cx + off, y, cz, proud, stripH, sw),          // +x strip
    box('neon', accent, cx - off, y, cz, proud, stripH, sw),          // -x strip
    box('neon', accent, cx, y, cz + off, sw, stripH, proud),          // +z strip
    box('neon', accent, cx, y, cz - off, sw, stripH, proud),          // -z strip
  ];
}

// ── Half-wall baffle ──────────────────────────────────────────────────────────
// Shoulder-high straight segment that breaks sightlines and forces movement. Taller than a barrier
// (can't vault it) and marked by a glowing vertical seam on each exposed end, not a top lip.
export function halfWallBaffle({ cx, cz, orient = 'z', len = 3.2, thick = 0.3, h = SHOULDER, accent = 'neon' }) {
  const [sx, sz] = span(orient, len, thick);
  const prims = [box('baffle', 'panel', cx, h / 2, cz, sx, h, sz)];
  const sw = 0.1, proud = 0.03, y = h / 2;
  // vertical seam on each short end (the ends you round to break LOS)
  if (orient === 'x') {
    prims.push(box('neon', accent, cx - len / 2 + sw / 2, y, cz, sw, h, thick + proud));
    prims.push(box('neon', accent, cx + len / 2 - sw / 2, y, cz, sw, h, thick + proud));
  } else {
    prims.push(box('neon', accent, cx, y, cz - len / 2 + sw / 2, thick + proud, h, sw));
    prims.push(box('neon', accent, cx, y, cz + len / 2 - sw / 2, thick + proud, h, sw));
  }
  return prims;
}

// ── Holo-platform ─────────────────────────────────────────────────────────────
// Raised deck with a glowing edge frame + a light railing on the non-access sides, and a stepped ramp
// up one edge. Verticality / overwatch — the intentional replacement for v2's ad-hoc mezzanine.
// `access` names the edge the steps climb from: 'front'(-z)|'back'(+z)|'left'(-x)|'right'(+x).
export function holoPlatform({ cx, cz, w = 6, d = 4, height, railH, access = 'front', accent = 'neon' }) {
  const H2 = height ?? DECK_H;
  const rH = railH ?? RAIL_H;
  const dt = 0.2, prims = [];
  const x0 = cx - w / 2, x1 = cx + w / 2, z0 = cz - d / 2, z1 = cz + d / 2;
  prims.push(box('platform', 'deck', cx, H2 - dt / 2, cz, w, dt, d)); // deck slab
  // glowing edge frame flush with the deck top
  const ew = 0.12, ey = H2 + 0.01;
  prims.push(box('neon', accent, cx, ey, z0, w, 0.1, ew));
  prims.push(box('neon', accent, cx, ey, z1, w, 0.1, ew));
  prims.push(box('neon', accent, x0, ey, cz, ew, 0.1, d));
  prims.push(box('neon', accent, x1, ey, cz, ew, 0.1, d));
  // light railing (top rail) on the three sides that are not the access side
  const rail = (ax, fixed, a0, a1) => {
    if (ax === 'x') prims.push(box('railing', accent, fixed, H2 + rH, cz, 0.06, 0.08, a1 - a0));
    else prims.push(box('railing', accent, cx, H2 + rH, fixed, a1 - a0, 0.08, 0.06));
  };
  if (access !== 'front') rail('z', z0, x0, x1);
  if (access !== 'back') rail('z', z1, x0, x1);
  if (access !== 'left') rail('x', x0, z0, z1);
  if (access !== 'right') rail('x', x1, z0, z1);
  // stepped ramp up the access edge (climbs toward the deck)
  const steps = Math.max(3, Math.ceil(H2 / 0.22)), rise = H2 / steps, run = 0.32, rampW = 1.8;
  for (let i = 0; i < steps; i++) {
    const topY = rise * (i + 1);
    if (access === 'front' || access === 'back') {
      const dir = access === 'front' ? -1 : 1;
      const edge = access === 'front' ? z0 : z1;
      const sz0 = edge + dir * (steps - i) * run;
      prims.push(box('step', 'stair', cx, topY / 2, sz0 + dir * run / 2, rampW, topY, run));
    } else {
      const dir = access === 'left' ? -1 : 1;
      const edge = access === 'left' ? x0 : x1;
      const sx0 = edge + dir * (steps - i) * run;
      prims.push(box('step', 'stair', sx0 + dir * run / 2, topY / 2, cz, run, topY, rampW));
    }
  }
  return prims;
}

// ── Portal door ─────────────────────────────────────────────────────────────
// Emissive frame (jambs + header lip) that reads a doorway and flags it as a threat opening. Decorates
// a gap the wall builder already left; does not build the wall itself. `along` is the wall's run axis;
// `facePos` is the fixed coordinate of the plane the frame sits proud of (offset toward the room).
export function portalDoor({ cx = 0, cz = 0, along = 'x', facePos, doorW = DOOR_W, doorH, accent = 'neon' }) {
  const dH = doorH ?? round2(1.8 * 2.4 - 0.6); // wall H (heightStand*2.4) minus header
  const jw = 0.12, y = dH / 2, dHalf = doorW / 2;
  if (along === 'x') { // wall runs along x, opening faces ±z; frame sits at z=facePos
    return [
      box('neon', accent, cx - dHalf, y, facePos, jw, dH, jw),
      box('neon', accent, cx + dHalf, y, facePos, jw, dH, jw),
      box('neon', accent, cx, dH - 0.06, facePos, doorW + 0.24, 0.12, jw),
    ];
  }
  return [ // wall runs along z, opening faces ±x; frame sits at x=facePos
    box('neon', accent, facePos, y, cz - dHalf, jw, dH, jw),
    box('neon', accent, facePos, y, cz + dHalf, jw, dH, jw),
    box('neon', accent, facePos, dH - 0.06, cz, jw, 0.12, doorW + 0.24),
  ];
}

// registry so tests / callers can enumerate the vocabulary
export const PIECES = { holoBarrier, lightPillar, halfWallBaffle, holoPlatform, portalDoor };
