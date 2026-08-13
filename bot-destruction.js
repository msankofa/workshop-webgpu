// bot-destruction.js — pure, THREE-free wall destruction: hit points, the state ladder, and the
// fracture patterns that turn one wall rectangle into the pieces left after it breaks.
// Node-tested in test-bot-destruction.mjs. See docs/wall-destruction-plan.md.
//
// Rects are bot-viewer format: {x, z, w, d, h} center + full extents, h = height above local ground.
//
// The state ladder, decided with the user:
//   CRACKED  — visual damage only. The rect does not change, so nothing downstream rebakes.
//   CRUMBLED — half of it falls away on a horizontal, vertical or diagonal cut. What is left is a
//              real rect: it still blocks movement, and it blocks sight only if it stayed tall.
//   CRUSHED  — no solid left, just a rubble pile. Traversable, because the rect is gone from the
//              blocker lists entirely.
// A breach (a hole punched through a wall that otherwise stands) is the same machinery with a
// different child list, and is deliberately not implemented yet.
//
// `rubble` output is DESCRIPTIVE geometry for the renderer. It must not be fed to the nav blockers
// or the map collider: rubble you cannot walk over is a crushed wall that still blocks, which is the
// one thing the crushed state exists to avoid.

import { SIGHT_BLOCK_HEIGHT } from './nav-visibility.js';

export const WALL_STATE = { INTACT: 0, CRACKED: 1, CRUMBLED: 2, CRUSHED: 3 };
export const FRACTURE_PATTERNS = ['horizontal', 'vertical', 'diagonal'];

export const DESTRUCTION_DEFAULTS = {
  hpPerCubicMetre: 40,    // a 0.3 x 9 x 3 m wall is ~8.1 m3, so ~324 hp
  crackedAt: 0.7,         // hp fraction at or below which each state is entered
  crumbledAt: 0.4,
  crushedAt: 0,
  // A horizontal cut must land clearly BELOW SIGHT_BLOCK_HEIGHT (1.5), not on it: the sight test is
  // `h >= 1.5`, so an exact half of a 3 m wall would still block sight and the cut would read as
  // having done nothing.
  stubHeight: 1.4,
  rubbleHeight: 0.45,     // debris pile height
  rubbleSpread: 0.9,      // m the debris may lie outside the parent footprint
  stairSteps: 3,          // sub-rects a diagonal cut is approximated by
};

// Every builder draws exactly this many values, always in this order, whether or not the branch
// that would use one fires. Same discipline as plants.js's rollPlantVariation: a fixed, order-stable
// draw count means changing one tunable cannot reshuffle every later draw.
const DRAWS = 4;
function drawVector(rng) {
  const v = new Array(DRAWS);
  for (let i = 0; i < DRAWS; i++) v[i] = rng();
  return v;
}

// Deterministic per-id stream, so wall 37 breaking the same way twice does not depend on how many
// other walls broke first.
export function makeWallRng(seed, id) {
  let s = (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(id + 1, 0xc2b2ae35)) >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2545f491) + 0x9e3779b9) >>> 0;
    return (s >>> 8) / 0x01000000;
  };
}

// The long axis of a wall rect. A vertical or diagonal cut runs along it, so a 9 m wall loses half
// its length rather than half its 0.3 m thickness.
function longAxis(rect) { return rect.w >= rect.d ? 'x' : 'z'; }
function extentOn(rect, axis) { return axis === 'x' ? rect.w : rect.d; }
function withExtent(rect, axis, value) {
  return axis === 'x' ? { ...rect, w: value } : { ...rect, d: value };
}
function shifted(rect, axis, delta) {
  return axis === 'x' ? { ...rect, x: rect.x + delta } : { ...rect, z: rect.z + delta };
}

// One wall rectangle -> what is left standing and what is lying on the ground.
// Returns { solids, rubble, pattern }. `solids` are real blockers; `rubble` is decoration.
export function fracture(rect, pattern, opts = {}) {
  const p = { ...DESTRUCTION_DEFAULTS, ...opts };
  const rng = opts.rng || Math.random;
  const draws = drawVector(rng);
  const height = rect.h ?? p.height ?? 3;
  const axis = longAxis(rect);
  const span = extentOn(rect, axis);
  const rubbleOf = (r) => ({ ...r, h: p.rubbleHeight, kind: 'rubble' });

  if (pattern === 'crushed') {
    return { pattern, solids: [], rubble: [rubbleOf({ ...rect, h: height })] };
  }

  if (pattern === 'horizontal') {
    // Top half falls: same footprint, shorter. The debris lands beside it, one strip per face.
    const stub = { ...rect, h: Math.min(p.stubHeight, height * 0.9) };
    const thin = axis === 'x' ? rect.d : rect.w;
    const off = thin / 2 + p.rubbleSpread / 2;
    const strip = axis === 'x'
      ? { ...rect, d: p.rubbleSpread }
      : { ...rect, w: p.rubbleSpread };
    const side = axis === 'x' ? 'z' : 'x';
    return {
      pattern,
      solids: [stub],
      rubble: [rubbleOf(shifted(strip, side, -off)), rubbleOf(shifted(strip, side, off))],
    };
  }

  if (pattern === 'vertical') {
    // One end falls, the other stands full height. The surviving end is a NEW free corner, which is
    // what makes this the most interesting cut: buildCornerMap manufactures cover that wasn't there.
    const keepLow = draws[0] < 0.5;
    const keep = span / 2;
    const centreOffset = (keepLow ? -1 : 1) * (span - keep) / 2;
    const standing = shifted(withExtent({ ...rect, h: height }, axis, keep), axis, centreOffset);
    const fallen = shifted(withExtent(rect, axis, span - keep), axis, -centreOffset);
    return { pattern, solids: [standing], rubble: [rubbleOf(fallen)] };
  }

  if (pattern === 'diagonal') {
    // A slanted cut the sim cannot express, approximated by a descending staircase. The rendered
    // mesh may be a real slant; every consumer downstream reads these rects.
    const steps = Math.max(2, p.stairSteps | 0);
    const stepSpan = span / steps;
    const highFirst = draws[1] < 0.5;
    const solids = [];
    for (let i = 0; i < steps; i++) {
      const t = steps === 1 ? 0 : i / (steps - 1);
      const frac = highFirst ? 1 - t : t;
      const h = p.stubHeight + (height - p.stubHeight) * frac;
      const centre = -span / 2 + stepSpan * (i + 0.5);
      solids.push(shifted(withExtent({ ...rect, h }, axis, stepSpan), axis, centre));
    }
    // Debris at the low end, where the material came off.
    const lowCentre = (highFirst ? 1 : -1) * (span / 2 - stepSpan / 2);
    const pile = shifted(withExtent(rect, axis, stepSpan * 1.5), axis, lowCentre);
    return { pattern, solids, rubble: [rubbleOf(pile)] };
  }

  throw new Error(`unknown fracture pattern: ${pattern}`);
}

// True if what a cut left behind still blocks sight. The cover system reads this and nothing else:
// a stub under SIGHT_BLOCK_HEIGHT yields no corner anchors, so a horizontal cut removes cover while
// a vertical one keeps it.
export function blocksSight(rect) {
  return (rect.h === undefined ? Infinity : rect.h) >= SIGHT_BLOCK_HEIGHT;
}

// Hit points from volume, so a long wall is not as fragile as a pillar.
export function wallHitPoints(rect, hpPerCubicMetre = DESTRUCTION_DEFAULTS.hpPerCubicMetre, height = 3) {
  return rect.w * rect.d * (rect.h ?? height) * hpPerCubicMetre;
}

// Wrap a layout's rects in destructible state. `indestructible(rect, index) -> boolean` keeps a rect
// out of the system entirely: the layout's boundary ring is the obvious caller, since a rect the
// player can delete there is not something the map was designed around.
export function createDestructibleSet(rects, opts = {}) {
  const p = { ...DESTRUCTION_DEFAULTS, ...opts };
  const indestructible = opts.indestructible || (() => false);
  const entries = rects.map((rect, index) => {
    const fixed = !!indestructible(rect, index);
    const maxHp = wallHitPoints(rect, p.hpPerCubicMetre, p.height ?? 3);
    return {
      id: index, rect, fixed,
      maxHp, hp: maxHp,
      state: WALL_STATE.INTACT,
      pattern: null,     // which cut it took, once crumbled
      pieces: null,      // the rects that replaced it, once crumbled or crushed
    };
  });
  return { entries, seed: opts.seed ?? 1, params: p };
}

// Every rect a set currently contributes as a real blocker: intact walls as themselves, crumbled
// walls as their standing pieces, crushed walls as nothing. This is what nav, sight and the collider
// should be handed -- never the rubble.
export function activeRectsOf(set) {
  const out = [];
  for (const e of set.entries) {
    if (e.state === WALL_STATE.CRUSHED) continue;
    if (e.pieces) out.push(...e.pieces);
    else out.push(e.rect);
  }
  return out;
}

// Every rubble rect currently on the ground, for the renderer only.
export function rubbleRectsOf(set) {
  const out = [];
  for (const e of set.entries) if (e.rubble) out.push(...e.rubble);
  return out;
}

// `maxState` is the ladder's ceiling. It exists so a caller that has wired damage but not yet the
// geometry rebuild can run the whole system honestly at CRACKED, instead of letting walls reach
// states nothing applies. Damage still accrues; the wall simply stops transitioning.
function stateForFraction(f, p) {
  const ceiling = p.maxState ?? WALL_STATE.CRUSHED;
  let state = WALL_STATE.INTACT;
  if (f <= p.crushedAt) state = WALL_STATE.CRUSHED;
  else if (f <= p.crumbledAt) state = WALL_STATE.CRUMBLED;
  else if (f <= p.crackedAt) state = WALL_STATE.CRACKED;
  return Math.min(state, ceiling);
}

// Feed damage into one wall. Returns null when nothing observable changed (still intact, already
// crushed, or fixed), otherwise the transition, with the geometry the caller must apply.
//
// `geometryChanged` is the flag that decides whether a rebuild is needed at all: a wall that only
// cracked wants a material swap and nothing else, which is the cheapest and most common case.
export function applyWallDamage(set, id, amount, opts = {}) {
  const e = set.entries[id];
  if (!e || e.fixed || e.state === WALL_STATE.CRUSHED || !(amount > 0)) return null;
  const p = set.params;
  const from = e.state;
  e.hp = Math.max(0, e.hp - amount);
  const to = stateForFraction(e.hp / e.maxHp, p);
  if (to === from) return null;
  e.state = to;

  if (to === WALL_STATE.CRACKED) {
    return { id, from, to, geometryChanged: false, solids: null, rubble: null, dirty: null };
  }

  const rng = opts.rng || makeWallRng(set.seed, id);
  if (to === WALL_STATE.CRUMBLED) {
    const allowed = opts.patterns || p.patterns || FRACTURE_PATTERNS;
    // Pattern choice is its own draw, taken before the builder's vector so a builder's draw count
    // cannot shift which pattern was picked.
    const pattern = allowed[Math.min(allowed.length - 1, Math.floor(rng() * allowed.length))];
    const cut = fracture(e.rect, pattern, { ...p, rng });
    e.pattern = pattern;
    e.pieces = cut.solids;
    e.rubble = cut.rubble;
    return { id, from, to, geometryChanged: true, solids: cut.solids, rubble: cut.rubble, pattern, dirty: footprintOf(e.rect) };
  }

  // CRUSHED: everything goes, including any standing pieces a crumble left.
  const cut = fracture(e.rect, 'crushed', { ...p, rng });
  e.pattern = 'crushed';
  e.pieces = [];
  e.rubble = cut.rubble;
  return { id, from, to, geometryChanged: true, solids: [], rubble: cut.rubble, pattern: 'crushed', dirty: footprintOf(e.rect) };
}

// World-space bounds of a rect, which is the `dirty` region every downstream local update takes.
export function footprintOf(rect) {
  return { minX: rect.x - rect.w / 2, maxX: rect.x + rect.w / 2,
    minZ: rect.z - rect.d / 2, maxZ: rect.z + rect.d / 2 };
}

// Union of several dirty regions, so a batch of destructions in one frame rebuilds once.
export function unionBounds(list) {
  if (!list.length) return null;
  const out = { ...list[0] };
  for (const b of list) {
    if (b.minX < out.minX) out.minX = b.minX;
    if (b.maxX > out.maxX) out.maxX = b.maxX;
    if (b.minZ < out.minZ) out.minZ = b.minZ;
    if (b.maxZ > out.maxZ) out.maxZ = b.maxZ;
  }
  return out;
}

// Which rect a world point belongs to, for attributing a bullet hit. The map collider bakes every
// mesh into one triangle soup and its raycast returns only {distance, point, normal}, so a hit
// carries no wall identity and has to be looked up. Step INTO the surface along the normal first,
// or a hit on a face shared by two abutting rects is inside both.
export function wallAtPoint(set, point, normal = null, step = 0.05) {
  const x = point[0] - (normal ? normal[0] * step : 0);
  const z = point[2] - (normal ? normal[2] * step : 0);
  for (const e of set.entries) {
    if (e.state === WALL_STATE.CRUSHED) continue;
    const rects = e.pieces || [e.rect];
    for (const r of rects) {
      if (Math.abs(x - r.x) <= r.w / 2 && Math.abs(z - r.z) <= r.d / 2) return e.id;
    }
  }
  return -1;
}
