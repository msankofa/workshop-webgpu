// shoot-house-rooms.js — phase-3 room archetypes. Pure, three-free.
// Each archetype is a *designed* composition of phase-2 pieces (shoot-house-pieces.js) arranged
// relative to the room's entry and sightlines — the intentional replacement for v2's random-scatter
// content. Seed varies parameters (count, spacing, lane), never *whether* cover exists. Every builder
// returns an array of {kind,...,material} boxes; `ctx.accent` threads the wing color through to pieces.
//
// ctx = { rect:{x0,x1,z0,z1}  // inset content region (world coords)
//         entryX               // x of the entry doorway (front, -z edge) — cover is placed onto it
//         H, coverH            // wall height, chest-cover height
//         accent               // emissive material key ('neon' cyan | 'neonMagenta')
//         rand }               // seeded 0..1 PRNG for parameter variation

import { holoBarrier, lightPillar, halfWallBaffle, holoPlatform } from './shoot-house-pieces.js';

export const ROOM_ARCHETYPES = [
  { id: 'gauntlet',  label: 'Gauntlet',  desc: 'Staggered baffles — a serpentine lane from the door' },
  { id: 'atrium',    label: 'Atrium',    desc: 'Central pillar cluster ringed by low cover' },
  { id: 'crossfire', label: 'Crossfire', desc: 'Flanking half-walls, overlapping lanes onto the entry' },
  { id: 'overwatch', label: 'Overwatch', desc: 'Raised deck over low approach cover' },
  { id: 'open',      label: 'Open',      desc: 'Deliberately empty breathing room' },
];

const lerp = (a, b, t) => a + (b - a) * t;
const wOf = r => r.x1 - r.x0, dOf = r => r.z1 - r.z0;
const midX = r => (r.x0 + r.x1) / 2, midZ = r => (r.z0 + r.z1) / 2;

// Serpentine lane: baffles alternate which wall they anchor to, forcing a zig-zag from entry to far side.
function gauntlet(ctx) {
  const { rect, accent, rand } = ctx;
  const n = 3 + (rand() < 0.5 ? 1 : 0); // 3–4 gates
  const len = wOf(rect) * 0.66;
  const out = [];
  for (let i = 0; i < n; i++) {
    const cz = rect.z0 + (i + 1) / (n + 1) * dOf(rect);
    const left = i % 2 === 0;
    const cx = left ? rect.x0 + len / 2 : rect.x1 - len / 2; // gap on the opposite side
    out.push(...halfWallBaffle({ cx, cz, orient: 'x', len, accent }));
  }
  return out;
}

// Central light-pillar cluster with radial low cover; diagonal sightlines stay open around it.
function atrium(ctx) {
  const { rect, accent, coverH, H } = ctx;
  const cx = midX(rect), cz = midZ(rect), out = [];
  const pr = 2.2; // pillar cluster radius — spaced out so you can move between the columns
  for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]])
    out.push(...lightPillar({ cx: cx + dx * pr, cz: cz + dz * pr, H, accent }));
  const R = Math.min(wOf(rect), dOf(rect)) * 0.32; // low-cover ring radius (cardinal → diagonals open)
  out.push(...holoBarrier({ cx, cz: cz - R, orient: 'x', len: 2.4, h: coverH, accent }));
  out.push(...holoBarrier({ cx, cz: cz + R, orient: 'x', len: 2.4, h: coverH, accent }));
  out.push(...holoBarrier({ cx: cx - R, cz, orient: 'z', len: 2.4, h: coverH, accent }));
  out.push(...holoBarrier({ cx: cx + R, cz, orient: 'z', len: 2.4, h: coverH, accent }));
  return out;
}

// Two staggered flanking baffles create overlapping lanes onto the entry, with a fallback barrier far.
function crossfire(ctx) {
  const { rect, accent, coverH } = ctx;
  const cx = midX(rect), d = dOf(rect), out = [];
  const off = wOf(rect) * 0.22, len = d * 0.4;
  out.push(...halfWallBaffle({ cx: cx - off, cz: rect.z0 + d * 0.42, orient: 'z', len, accent }));
  out.push(...halfWallBaffle({ cx: cx + off, cz: rect.z0 + d * 0.58, orient: 'z', len, accent }));
  out.push(...holoBarrier({ cx, cz: rect.z1 - 1.5, orient: 'x', len: 3, h: coverH, accent }));
  return out;
}

// A raised deck against the far wall (access facing the entry) over two staggered approach barriers.
function overwatch(ctx) {
  const { rect, accent, coverH } = ctx;
  const cx = midX(rect), d = dOf(rect), out = [];
  const pw = Math.min(6, wOf(rect) * 0.6), pd = Math.min(3.5, d * 0.32);
  out.push(...holoPlatform({ cx, cz: rect.z1 - pd / 2 - 0.2, w: pw, d: pd, access: 'front', accent }));
  out.push(...holoBarrier({ cx: cx - 1.8, cz: rect.z0 + d * 0.35, orient: 'x', len: 2.4, h: coverH, accent }));
  out.push(...holoBarrier({ cx: cx + 1.8, cz: rect.z0 + d * 0.52, orient: 'x', len: 2.4, h: coverH, accent }));
  return out;
}

// Deliberately empty — pacing/breathing room. Still a real archetype; returns no cover.
function open() { return []; }

const BUILDERS = { gauntlet, atrium, crossfire, overwatch, open };

// Compose one archetype's cover into `ctx`. Unknown ids fall back to an empty room.
export function buildRoomContent(archetype, ctx) {
  return (BUILDERS[archetype] || open)(ctx);
}

export { lerp }; // (exported for tests / future archetypes)
