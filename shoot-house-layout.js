// shoot-house-layout.js — pure, three-free CQB kill-house layout generator.
// v2 redesign: bigger + more varied. Independent (non-mirrored) left/right sides, entry vestibule,
// 3–6 varied rooms/side (open/cover/pillars/shelving/crates/tables), staggered doorways + murder-holes,
// optional mezzanines, up to two staircases, per-room colored/dim lighting, emissive exit/hazard signage.
// Still emits axis-aligned boxes {kind,cx,cy,cz,sx,sy,sz,material} + point lights; Node-testable.

import { holoBarrier, lightPillar, halfWallBaffle, holoPlatform, portalDoor } from './shoot-house-pieces.js';
import { ROOM_ARCHETYPES, buildRoomContent } from './shoot-house-rooms.js';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round2 = (x) => Math.round(x * 100) / 100;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// player body reference (from the FPS controller fp: capsule radius, standing height). Dimensions derive from these.
export const BODY = { radius: 0.3, heightStand: 1.8 };

export const DOOR_W = Math.max(2.4, round2(BODY.radius * 9)); // 2.7 — wide enough to move + shoot through

// Shoot-house variants selectable from the start-screen dropdown. `id` maps to a map key
// `shoot-house-<id>` (except 'house' which stays the legacy bare `shoot-house`). Grows per phase:
// demo room (now) -> individual rooms (phase 3) -> connected houses (phase 4).
export const SHOOTHOUSE_TYPES = [
  { id: 'demo',  label: 'Demo Room',       desc: 'Internetcore aesthetic reference — one room' },
  { id: 'rooms', label: 'Room Gallery',    desc: 'One of each phase-3 room archetype, side by side' },
  { id: 'house', label: 'Procedural House', desc: 'Full multi-room CQB kill-house (v2)' },
];

// size presets scale the footprint; difficulty tunes clutter density + how many rooms go dark.
export const SIZE_PRESETS = {
  compact:  { W: 60,  L: 110 },
  standard: { W: 88,  L: 150 },
  sprawl:   { W: 120, L: 210 },
};
export const DIFFICULTY_PRESETS = {
  easy:   { coverDensity: 0.6, darkChance: 0.0,  roomsBias: -1 },
  normal: { coverDensity: 1.0, darkChance: 0.18, roomsBias: 0 },
  hard:   { coverDensity: 1.5, darkChance: 0.4,  roomsBias: 1 },
};

// per-room-type light tint (hex strings; builder applies them per-light).
const ROOM_LIGHT_COLOR = {
  open:     '#eaf2ff', // cool white
  cover:    '#ffd9a8', // warm
  pillars:  '#fff2d8', // neutral
  shelving: '#dfead0', // industrial green-white
  crates:   '#ffcf9a', // amber
  tables:   '#ffe6c0', // warm
};
const ROOM_TYPES = ['open', 'cover', 'pillars', 'shelving', 'crates', 'tables'];

const DEFAULTS = {
  T: 0.3,
  stepRise: 0.18, stepRun: 0.28,
  floorThickness: 0.1,
  minRoomZ: 16,
};

// Wall segment along z (fixed x), split by door/window openings ({z0,z1}). `windows` punch a mid-height gap.
function wallAlongZ(prims, kind, material, x, zMin, zMax, h, t, openings, opts = {}) {
  const yBase = opts.yBase || 0;
  const cuts = [zMin, ...openings.flatMap(o => [o.z0, o.z1]), zMax];
  for (let i = 0; i < cuts.length; i += 2) {
    const a = cuts[i], b = cuts[i + 1];
    if (b - a <= 1e-6) continue;
    prims.push({ kind, cx: x, cy: yBase + h / 2, cz: (a + b) / 2, sx: t, sy: h, sz: b - a, material });
  }
  for (const o of openings) {
    const lintelH = 0.6;
    prims.push({ kind: 'lintel', cx: x, cy: yBase + h - lintelH / 2, cz: (o.z0 + o.z1) / 2, sx: t, sy: lintelH, sz: o.z1 - o.z0, material: 'trim' });
  }
  for (const w of (opts.windows || [])) {
    // wall below + above a chest-high slit
    prims.push({ kind, cx: x, cy: yBase + w.y0 / 2, cz: (w.z0 + w.z1) / 2, sx: t, sy: w.y0, sz: w.z1 - w.z0, material });
    prims.push({ kind, cx: x, cy: yBase + (w.y1 + h) / 2, cz: (w.z0 + w.z1) / 2, sx: t, sy: h - w.y1, sz: w.z1 - w.z0, material });
  }
}

// Wall segment along x (fixed z), split by door openings ({x0,x1}); optional chest-high window slits.
function wallAlongX(prims, kind, material, z, xMin, xMax, h, t, openings, opts = {}) {
  const yBase = opts.yBase || 0;
  const cuts = [xMin, ...openings.flatMap(o => [o.x0, o.x1]), xMax];
  for (let i = 0; i < cuts.length; i += 2) {
    const a = cuts[i], b = cuts[i + 1];
    if (b - a <= 1e-6) continue;
    prims.push({ kind, cx: (a + b) / 2, cy: yBase + h / 2, cz: z, sx: b - a, sy: h, sz: t, material });
  }
  for (const o of openings) {
    const lintelH = 0.6;
    prims.push({ kind: 'lintel', cx: (o.x0 + o.x1) / 2, cy: yBase + h - lintelH / 2, cz: z, sx: o.x1 - o.x0, sy: lintelH, sz: t, material: 'trim' });
  }
  for (const w of (opts.windows || [])) {
    prims.push({ kind, cx: (w.x0 + w.x1) / 2, cy: yBase + w.y0 / 2, cz: z, sx: w.x1 - w.x0, sy: w.y0, sz: t, material });
    prims.push({ kind, cx: (w.x0 + w.x1) / 2, cy: yBase + (w.y1 + h) / 2, cz: z, sx: w.x1 - w.x0, sy: h - w.y1, sz: t, material });
  }
}

function boxesOverlap(ax0, ax1, az0, az1, bx0, bx1, bz0, bz1) {
  return ax0 < bx1 && ax1 > bx0 && az0 < bz1 && az1 > bz0;
}

export function generateShootHouse(seed = 1, opts = {}) {
  // ---- resolve presets ----
  const size = SIZE_PRESETS[opts.size] || SIZE_PRESETS.standard;
  const diff = DIFFICULTY_PRESETS[opts.difficulty] || DIFFICULTY_PRESETS.normal;
  const cfg = { ...DEFAULTS, ...opts };
  const W = opts.W ?? size.W;
  const L = opts.L ?? size.L;
  const { T, stepRise, stepRun, floorThickness, minRoomZ } = cfg;
  const body = { ...BODY, ...(opts.body || {}) };
  const { heightStand } = body;

  // body-scaled dimensions (explicit opts override)
  const H = opts.H ?? round2(heightStand * 2.4);
  const doorW = opts.doorW ?? DOOR_W;
  const coverH = clamp(opts.coverH ?? round2(heightStand * 0.62), 0.9, 1.3);
  const railH = opts.railH ?? round2(heightStand * 0.56);
  const corridorHalf = opts.corridorHalf ?? round2(Math.max(4.5, heightStand * 2.6));
  const yDeck = opts.yDeck ?? round2(H * 0.83);
  const yMezz = opts.yMezz ?? round2(H * 0.44);

  const rand = mulberry32(seed);

  const minX = -W / 2, maxX = W / 2, minZ = -L / 2, maxZ = L / 2;
  const bounds = { minX, maxX, minZ, maxZ, yMin: -floorThickness, yMax: Math.max(H, yDeck + railH) };

  const prims = [];
  const lights = [];

  // floor slab
  prims.push({ kind: 'interior', cx: 0, cy: -floorThickness / 2, cz: 0, sx: W, sy: floorThickness, sz: L, material: 'floor' });

  // perimeter bounding walls (inset by T/2, no doors — the player can't leave)
  wallAlongZ(prims, 'perimeter', 'wall', maxX - T / 2, minZ, maxZ, H, T, []);
  wallAlongZ(prims, 'perimeter', 'wall', minX + T / 2, minZ, maxZ, H, T, []);
  wallAlongX(prims, 'perimeter', 'wall', maxZ - T / 2, minX + T, maxX - T, H, T, []);
  wallAlongX(prims, 'perimeter', 'wall', minZ + T / 2, minX + T, maxX - T, H, T, []);

  // ---- entry vestibule: a small enclosed room at the minZ end of the corridor; player spawns inside ----
  const vestDepth = round2(Math.min(11, Math.max(8, L * 0.08)));
  const vestZ = minZ + vestDepth; // cross wall separating vestibule from corridor
  const vestDoorZ = { z0: vestZ - 1e-3, z1: vestZ + 1e-3 };
  wallAlongX(prims, 'interior', 'wall', vestZ, -corridorHalf, corridorHalf, H, T,
    [{ x0: -doorW / 2, x1: doorW / 2 }]);
  const spawn = { x: 0, y: 0, z: minZ + vestDepth * 0.45, heading: Math.PI };
  const spawnClear = { x0: -1.6, x1: 1.6, z0: spawn.z - 1.6, z1: spawn.z + 1.6 };

  // ---- clear zones (rejection sampling for room content) ----
  const clearZones = [spawnClear, { x0: -corridorHalf - 0.6, x1: corridorHalf + 0.6, z0: minZ, z1: vestZ + doorW }];
  const blocked = (cx, cz, sx, sz) => {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
    return clearZones.some(zn => boxesOverlap(x0, x1, z0, z1, zn.x0, zn.x1, zn.z0, zn.z1));
  };
  const addClear = (x0, x1, z0, z1) => clearZones.push({ x0, x1, z0, z1 });

  // ---- content placement helpers (operate on a room region) ----
  function placeBarricades(region, count, forceAlong) {
    const thick = 0.4;
    for (let n = 0; n < count; n++) {
      for (let t = 0; t < 60; t++) {
        const along = forceAlong || (rand() < 0.5 ? 'x' : 'z');
        const axisSpan = along === 'x' ? region.x1 - region.x0 : region.z1 - region.z0;
        const len = Math.min(3 + rand() * 1.8, axisSpan);
        if (len < thick * 2.2) break;
        const sx = along === 'x' ? len : thick;
        const sz = along === 'z' ? len : thick;
        const cx = region.x0 + sx / 2 + rand() * Math.max(0.01, region.x1 - region.x0 - sx);
        const cz = region.z0 + sz / 2 + rand() * Math.max(0.01, region.z1 - region.z0 - sz);
        if (blocked(cx, cz, sx, sz)) continue;
        prims.push({ kind: 'cover', cx, cy: coverH / 2, cz, sx, sy: coverH, sz, material: 'trim' });
        // ~40% of barricades get an L-return for corner cover
        if (rand() < 0.4) {
          const rl = Math.min(1.6 + rand() * 1.2, axisSpan * 0.6);
          const rsx = along === 'x' ? thick : rl;
          const rsz = along === 'x' ? rl : thick;
          const rcx = along === 'x' ? cx - sx / 2 + thick / 2 : cx;
          const rcz = along === 'x' ? cz : cz - sz / 2 + thick / 2;
          if (!blocked(rcx, rcz + (along === 'x' ? rsz / 2 : 0), rsx, rsz))
            prims.push({ kind: 'cover', cx: rcx, cy: coverH / 2, cz: rcz + (along === 'x' ? rsz / 2 - thick / 2 : 0), sx: rsx, sy: coverH, sz: rsz, material: 'trim' });
        }
        break;
      }
    }
  }

  function placePillars(region) {
    const cols = 2 + Math.floor(rand() * 3); // 2–4
    const w = 0.6;
    const cx = (region.x0 + region.x1) / 2 + (rand() - 0.5) * Math.max(0, region.x1 - region.x0 - w) * 0.4;
    for (let k = 0; k < cols; k++) {
      const cz = region.z0 + w / 2 + (k + 1) / (cols + 1) * Math.max(0.01, region.z1 - region.z0 - w);
      if (blocked(cx, cz, w, w)) continue;
      prims.push({ kind: 'pillar', cx, cy: H / 2, cz, sx: w, sy: H, sz: w, material: 'wall' });
    }
  }

  // warehouse shelving: tall thin walls with aisle gaps, running across the room's short axis
  function placeShelving(region) {
    const rows = 2 + Math.floor(rand() * 2); // 2–3 rows
    const shelfH = round2(Math.min(H * 0.62, 2.4));
    const thick = 0.5;
    const zSpan = region.z1 - region.z0;
    for (let r = 0; r < rows; r++) {
      const cz = region.z0 + (r + 1) / (rows + 1) * zSpan;
      // split each row into 1–2 segments so there is always a way through
      const gapAt = region.x0 + (0.35 + rand() * 0.3) * (region.x1 - region.x0);
      for (const seg of [[region.x0 + 0.4, gapAt - doorW / 2], [gapAt + doorW / 2, region.x1 - 0.4]]) {
        const [a, b] = seg;
        if (b - a < 1.2) continue;
        const cx = (a + b) / 2, sx = b - a;
        if (blocked(cx, cz, sx, thick)) continue;
        prims.push({ kind: 'shelf', cx, cy: shelfH / 2, cz, sx, sy: shelfH, sz: thick, material: 'stair' });
      }
    }
  }

  // stacked-crate scatter: mid-height boxes forming a loose maze
  function placeCrates(region) {
    const n = 4 + Math.floor(rand() * 4);
    for (let i = 0; i < n; i++) {
      for (let t = 0; t < 30; t++) {
        const s = round2(0.9 + rand() * 1.0);
        const h = round2(clamp(coverH + rand() * 1.4, coverH, H * 0.75));
        const cx = region.x0 + s / 2 + rand() * Math.max(0.01, region.x1 - region.x0 - s);
        const cz = region.z0 + s / 2 + rand() * Math.max(0.01, region.z1 - region.z0 - s);
        if (blocked(cx, cz, s, s)) continue;
        prims.push({ kind: 'crate', cx, cy: h / 2, cz, sx: s, sy: h, sz: s, material: 'stair' });
        break;
      }
    }
  }

  // mess-hall: rows of long low tables (chest-high cover) with small chair blocks
  function placeTables(region) {
    const rows = 2 + Math.floor(rand() * 2);
    const tableH = coverH, tThick = 0.9;
    for (let r = 0; r < rows; r++) {
      const cx = region.x0 + (r + 1) / (rows + 1) * (region.x1 - region.x0);
      const len = Math.min(region.z1 - region.z0 - 2, 4 + rand() * 3);
      const cz = (region.z0 + region.z1) / 2 + (rand() - 0.5) * 2;
      if (blocked(cx, cz, tThick, len)) continue;
      prims.push({ kind: 'cover', cx, cy: tableH / 2, cz, sx: tThick, sy: tableH, sz: len, material: 'trim' });
      for (let c = 0; c < 2; c++) {
        const chx = cx + (c === 0 ? -1 : 1) * 0.9;
        const chz = cz + (rand() - 0.5) * len * 0.5;
        if (!blocked(chx, chz, 0.4, 0.4))
          prims.push({ kind: 'crate', cx: chx, cy: 0.4, cz: chz, sx: 0.4, sy: 0.8, sz: 0.4, material: 'stair' });
      }
    }
  }

  // mezzanine: raised half-room deck on the outer x-half, short access stair from the corridor edge, railed.
  function placeMezzanine(region, side) {
    const deckThickness = 0.2;
    const innerX = region.x0;                 // corridor-facing edge of the room content
    const outerX = region.x1;
    const deckX0 = (innerX + outerX) / 2;      // outer half
    const deckX1 = outerX;
    const deckZ0 = region.z0 + 1, deckZ1 = region.z1 - 1;
    if (deckX1 - deckX0 < 3 || deckZ1 - deckZ0 < 4) return false;
    // access stair rising from the inner edge toward the deck (climbs along x)
    const steps = Math.ceil(yMezz / 0.2);
    const rise = yMezz / steps, run = 0.28, stairW = 1.6;
    const stairZ = (deckZ0 + deckZ1) / 2;
    for (let i = 0; i < steps; i++) {
      const topY = rise * (i + 1);
      const sx0 = deckX0 - 0.2 - (steps - i) * run;
      prims.push({ kind: 'mezzStep', cx: sx0 + run / 2, cy: topY / 2, cz: stairZ, sx: run, sy: topY, sz: stairW, material: 'stair' });
    }
    prims.push({ kind: 'mezzanine', cx: (deckX0 + deckX1) / 2, cy: yMezz - deckThickness / 2, cz: (deckZ0 + deckZ1) / 2, sx: deckX1 - deckX0, sy: deckThickness, sz: deckZ1 - deckZ0, material: 'stair' });
    // railing on the inner (open) edge
    prims.push({ kind: 'railing', cx: deckX0, cy: yMezz + railH / 2, cz: (deckZ0 + deckZ1) / 2, sx: 0.08, sy: railH, sz: deckZ1 - deckZ0, material: 'trim' });
    addClear(deckX0 - 0.4, deckX1 + 0.4, deckZ0 - 0.4, deckZ1 + 0.4);
    return true;
  }

  // ---- per-side room block ----
  // side: +1 (right, x>0) or -1 (left, x<0). Independent seeded RNG stream per side => asymmetry.
  function buildSide(side, sideSeed) {
    const srand = mulberry32(sideSeed);
    const spineX = side * corridorHalf;
    const outerX = side * (maxX - T);
    const xLo = Math.min(spineX, outerX), xHi = Math.max(spineX, outerX);

    // room count 3–6 (difficulty-biased), each room >= minRoomZ deep
    const zLo = minZ + 1, zHi = maxZ - 1, span = zHi - zLo;
    const maxRooms = Math.max(2, Math.floor(span / minRoomZ));
    let roomCount = clamp(3 + Math.floor(srand() * 3) + diff.roomsBias, 3, 6);
    roomCount = Math.min(roomCount, maxRooms);

    // non-uniform cut positions (bias deeper rooms toward maxZ), enforce min depth
    const stripsOk = (cs) => {
      const e = [zLo, ...cs, zHi];
      for (let i = 0; i < e.length - 1; i++) if (e[i + 1] - e[i] < minRoomZ) return false;
      return true;
    };
    let cuts, tries = 0;
    do {
      cuts = Array.from({ length: roomCount - 1 }, () => {
        const t = srand();
        return zLo + span * (t * t * 0.5 + t * 0.5); // gentle skew
      }).sort((a, b) => a - b);
      tries++;
    } while (tries < 400 && !stripsOk(cuts));
    if (!stripsOk(cuts)) cuts = Array.from({ length: roomCount - 1 }, (_, i) => zLo + span * (i + 1) / roomCount);

    const edges = [zLo, ...cuts, zHi];
    const strips = Array.from({ length: roomCount }, (_, i) => ({ z0: edges[i], z1: edges[i + 1] }));

    // room types; guarantee at least one open room per side
    const types = strips.map(() => ROOM_TYPES[Math.floor(srand() * ROOM_TYPES.length)]);
    if (!types.includes('open')) types[Math.floor(srand() * types.length)] = 'open';

    // spine doorways: one per room, staggered position (near / center / far fed)
    const spineOpenings = strips.map(s => {
      const lo = s.z0 + doorW / 2 + 0.5, hi = s.z1 - doorW / 2 - 0.5;
      const pick = srand();
      const cz = clamp(lo + (hi - lo) * (pick < 0.34 ? 0.15 : pick < 0.67 ? 0.5 : 0.85), lo, hi);
      return { z0: cz - doorW / 2, z1: cz + doorW / 2, roomZ: [s.z0, s.z1] };
    }).sort((a, b) => a.z0 - b.z0);
    for (const o of spineOpenings) addClear(spineX - doorW / 2 - 0.4, spineX + doorW / 2 + 0.4, o.z0 - 0.4, o.z1 + 0.4);
    wallAlongZ(prims, 'interior', 'wall', spineX, minZ, maxZ, H, T, spineOpenings.map(o => ({ z0: o.z0, z1: o.z1 })));

    // exit sign above each spine doorway, on the corridor side
    for (const o of spineOpenings) {
      prims.push({ kind: 'sign', cx: spineX - side * (T / 2 + 0.06), cy: H - 0.9, cz: (o.z0 + o.z1) / 2, sx: 0.08, sy: 0.4, sz: 1.0, material: 'exit' });
    }

    // cross walls dividing the block; each gets a doorway (+ sometimes a chest-high murder-hole)
    cuts.forEach((z) => {
      const dx0 = xLo + 2 + srand() * Math.max(0.01, xHi - xLo - 4 - doorW);
      const openings = [{ x0: dx0, x1: dx0 + doorW }];
      addClear(dx0 - 0.4, dx0 + doorW + 0.4, z - doorW / 2, z + doorW / 2);
      let windows;
      if (srand() < 0.5) {
        const wx0 = xLo + 1 + srand() * Math.max(0.01, xHi - xLo - 3);
        windows = [{ x0: wx0, x1: wx0 + 1.2, y0: 1.0, y1: 1.7 }];
      }
      wallAlongX(prims, 'interior', 'wall', z, xLo, xHi, H, T, openings, { windows });
    });

    // room content
    strips.forEach((s, i) => {
      const region = { x0: xLo + 1.3, x1: xHi - 1.3, z0: s.z0 + 1.5, z1: s.z1 - 1.5 };
      const type = types[i];
      const dens = diff.coverDensity;
      if (type === 'cover') placeBarricades(region, Math.max(1, Math.round((1 + (srand() < 0.5 ? 1 : 0)) * dens)));
      else if (type === 'pillars') placePillars(region);
      else if (type === 'shelving') placeShelving(region);
      else if (type === 'crates') placeCrates(region);
      else if (type === 'tables') placeTables(region);
      // 'open' stays empty — but a deep open room may host a mezzanine
      if (type === 'open' && (s.z1 - s.z0) > minRoomZ + 4 && srand() < 0.6) {
        types[i] = placeMezzanine(region, side) ? 'open+mezz' : 'open';
      }
    });

    // ---- lighting: per-room colored, some rooms dim/dark ----
    strips.forEach((s, i) => {
      const baseType = types[i].replace('+mezz', '');
      const color = ROOM_LIGHT_COLOR[baseType] || ROOM_LIGHT_COLOR.open;
      const dark = srand() < diff.darkChance;
      const n = baseType === 'open' ? 2 : 1;
      for (let k = 0; k < n; k++) {
        const lx = xLo + 4 + srand() * Math.max(1, xHi - xLo - 8);
        const lz = n === 1 ? (s.z0 + s.z1) / 2 : s.z0 + (s.z1 - s.z0) * (k + 1) / (n + 1);
        lights.push({ x: lx, y: H - 0.5, z: lz, radius: dark ? 8 : 16, color, intensity: dark ? 0.22 : 1 });
      }
    });

    return { strips, types, roomCount, spineDoorZ: spineOpenings.map(o => (o.z0 + o.z1) / 2), spineX };
  }

  const right = buildSide(+1, (seed ^ 0x9e3779b9) >>> 0);
  let left;
  if (opts.symmetric) {
    // mirror the right side's non-straddling prims/lights to the left (x<0)
    const rp = prims.filter(p => p.cx > 1e-6);
    for (const p of rp) prims.push({ ...p, cx: -p.cx });
    const rl = lights.filter(l => l.x > 1e-6);
    for (const l of rl) lights.push({ ...l, x: -l.x });
    left = { ...right, spineX: -right.spineX, spineDoorZ: right.spineDoorZ };
  } else {
    left = buildSide(-1, (seed ^ 0x85ebca6b) >>> 0);
  }

  // ---- corridor content: alternating cover along the lane + a couple of full-height posts ----
  placeBarricades({ x0: -corridorHalf + 0.6, x1: corridorHalf - 0.6, z0: vestZ + doorW + 2, z1: maxZ - 14 },
    1 + (rand() < 0.5 ? 1 : 0), 'z');
  for (let i = 0; i < 2; i++) {
    for (let t = 0; t < 30; t++) {
      const cx = -corridorHalf + 1 + rand() * (2 * corridorHalf - 2);
      const cz = vestZ + doorW + 4 + rand() * Math.max(1, (maxZ - 16) - (vestZ + doorW + 4));
      if (blocked(cx, cz, 0.4, 0.4)) continue;
      prims.push({ kind: 'pillar', cx, cy: H / 2, cz, sx: 0.4, sy: H, sz: 0.4, material: 'wall' });
      break;
    }
  }

  // ---- staircases: one near maxZ (main), optionally one near minZ (long houses) ----
  function buildStaircase(nearMaxZ) {
    const stepCount = Math.ceil(yDeck / stepRise);
    const actualRise = yDeck / stepCount;
    const stairX = corridorHalf - 1.5;
    const stairWidth = 1.4;
    const dir = nearMaxZ ? 1 : -1;
    const stairZBottom = nearMaxZ ? maxZ - 2.5 : vestZ + doorW + 3;
    const footprint = {
      x0: stairX - stairWidth / 2, x1: stairX + stairWidth / 2,
      z0: Math.min(stairZBottom, stairZBottom - dir * stepCount * stepRun),
      z1: Math.max(stairZBottom, stairZBottom - dir * stepCount * stepRun),
    };
    for (let i = 0; i < stepCount; i++) {
      const stepZ1 = stairZBottom - dir * i * stepRun;
      const topY = actualRise * (i + 1);
      prims.push({ kind: 'step', cx: stairX, cy: topY / 2, cz: stepZ1 - dir * stepRun / 2, sx: stairWidth, sy: topY, sz: stepRun, material: 'stair' });
    }
    // balcony deck adjoining the stair top, catwalk over the corridor, railed on the open edge
    const deckThickness = 0.2;
    const topEdgeZ = stairZBottom - dir * stepCount * stepRun;
    const deckZ1 = nearMaxZ ? topEdgeZ - 0.2 : topEdgeZ + 5;
    const deckZ0 = nearMaxZ ? deckZ1 - 5 : topEdgeZ + 0.2;
    const zA = Math.min(deckZ0, deckZ1), zB = Math.max(deckZ0, deckZ1);
    const deckX0 = stairX - 1.8;
    const deckX1 = Math.min(corridorHalf - 0.3, stairX + 1.8);
    prims.push({ kind: 'balcony', cx: (deckX0 + deckX1) / 2, cy: yDeck - deckThickness / 2, cz: (zA + zB) / 2, sx: deckX1 - deckX0, sy: deckThickness, sz: zB - zA, material: 'stair' });
    const railZ = nearMaxZ ? zA : zB;
    prims.push({ kind: 'railing', cx: (deckX0 + deckX1) / 2, cy: yDeck + railH / 2, cz: railZ, sx: deckX1 - deckX0, sy: railH, sz: 0.08, material: 'trim' });
    // red hazard sign at the stair foot
    prims.push({ kind: 'sign', cx: stairX, cy: 1.4, cz: stairZBottom + dir * 0.3, sx: 0.9, sy: 0.5, sz: 0.06, material: 'hazard' });
    addClear(footprint.x0 - 0.3, footprint.x1 + 0.3, footprint.z0 - 0.3, footprint.z1 + 0.3);
  }
  buildStaircase(true);
  if (L >= 140) buildStaircase(false);

  // ---- corridor lights (straddle x=0) ----
  const corridorLightCount = Math.max(4, Math.round(L / 16));
  for (let i = 0; i < corridorLightCount; i++) {
    lights.push({ x: 0, y: H - 0.5, z: minZ + (i + 0.5) / corridorLightCount * L, radius: 14, color: '#fff2d8', intensity: 1 });
  }
  // vestibule light
  lights.push({ x: 0, y: H - 0.5, z: minZ + vestDepth * 0.5, radius: 12, color: '#cfe3ff', intensity: 0.9 });

  return { bounds, primitives: prims, lights, spawn, meta: { W, L, corridorHalf, vestZ, right, left } };
}

// ─── Demo Room (Phase 0) ──────────────────────────────────────────────────────
// One enclosed, roofless room that showcases the internetcore LOOK only — floor grid, wall + portal
// trim, one cover sample, one signage placard, and a neon light rig. No tactical layout vocabulary
// yet (that's phase 2). Fixed hand-authored geometry, so the user has a stable reference to iterate
// on and push downstream. Materials reference shoot-house-style.js keys; roof stays off (starfield).
export function generateDemoRoom(opts = {}) {
  const body = { ...BODY, ...(opts.body || {}) };
  const { heightStand } = body;
  const H = opts.H ?? round2(heightStand * 4.8); // tall internetcore walls (~8.6 m)
  const T = opts.T ?? 0.3;
  const doorW = opts.doorW ?? DOOR_W;
  const coverH = clamp(opts.coverH ?? round2(heightStand * 0.62), 0.9, 1.3);
  const floorThickness = 0.1;
  const W = opts.W ?? 18, L = opts.L ?? 14;
  const minX = -W / 2, maxX = W / 2, minZ = -L / 2, maxZ = L / 2;
  const bounds = { minX, maxX, minZ, maxZ, yMin: -floorThickness, yMax: H };

  const prims = [];
  const lights = [];
  const box = (kind, material, cx, cy, cz, sx, sy, sz) => prims.push({ kind, cx, cy, cz, sx, sy, sz, material });

  // floor deck
  box('interior', 'deck', 0, -floorThickness / 2, 0, W, floorThickness, L);

  // emissive floor grid — thin strips just above the deck, on a 2 m lattice
  const gy = 0.012, gw = 0.06, gh = 0.02, spacing = 2, inset = 0.4;
  for (let x = -W / 2 + spacing; x <= W / 2 - spacing + 1e-6; x += spacing) box('grid', 'grid', x, gy, 0, gw, gh, L - inset);
  for (let z = -L / 2 + spacing; z <= L / 2 - spacing + 1e-6; z += spacing) box('grid', 'grid', 0, gy, z, W - inset, gh, gw);

  // neon top + base trim strip along a wall face (inward-offset so it reads on the inner surface)
  const trimTop = (axis, fixed, a0, a1, faceSign) => {
    const tw = 0.1, topY = H - 0.12, baseY = 0.12;
    if (axis === 'z') { // wall runs along z at x=fixed; inner face toward -faceSign
      const cx = fixed - faceSign * (T / 2 + 0.02);
      box('neon', 'neon', cx, topY, (a0 + a1) / 2, tw, 0.12, a1 - a0);
      box('neon', 'neon', cx, baseY, (a0 + a1) / 2, tw, 0.12, a1 - a0);
    } else {            // wall runs along x at z=fixed
      const cz = fixed - faceSign * (T / 2 + 0.02);
      box('neon', 'neon', (a0 + a1) / 2, topY, cz, a1 - a0, 0.12, tw);
      box('neon', 'neon', (a0 + a1) / 2, baseY, cz, a1 - a0, 0.12, tw);
    }
  };

  // perimeter walls (roof off). back (+z) + sides solid; front (-z) has a portal doorway.
  box('perimeter', 'panel', maxX - T / 2, H / 2, 0, T, H, L);          // east (+x)
  box('perimeter', 'panel', minX + T / 2, H / 2, 0, T, H, L);          // west (-x)
  box('perimeter', 'panel', 0, H / 2, maxZ - T / 2, W - 2 * T, H, T);  // back (+z)
  trimTop('z', maxX - T / 2, minZ, maxZ, +1);
  trimTop('z', minX + T / 2, minZ, maxZ, -1);
  trimTop('x', maxZ - T / 2, minX + T, maxX - T, +1);

  // front (-z) wall with a centered doorway + emissive portal frame (phase-2 portalDoor piece).
  // Door opening stays human-height; the wall above it is filled by a tall header (not a full-height gap).
  const fz = minZ + T / 2, dHalf = doorW / 2, doorH = round2(heightStand * 1.7), seg = (maxX - T) - dHalf;
  box('perimeter', 'panel', -(dHalf + seg / 2), H / 2, fz, seg, H, T); // left segment
  box('perimeter', 'panel',  (dHalf + seg / 2), H / 2, fz, seg, H, T); // right segment
  box('lintel', 'panel', 0, (doorH + H) / 2, fz, doorW, H - doorH, T); // header fills wall above the door
  prims.push(...portalDoor({ along: 'x', facePos: fz + (T / 2 + 0.03), cx: 0, doorW, doorH }));

  // ── phase-2 cover-vocabulary showcase: one clearly-spaced instance of each piece ──
  prims.push(...holoBarrier({ cx: -4, cz: -1.5, orient: 'x', len: 3, h: coverH }));      // left-front peek cover
  prims.push(...halfWallBaffle({ cx: 4, cz: -1, orient: 'z', len: 3.2 }));               // right-front LOS break
  prims.push(...lightPillar({ cx: -4, cz: 2, H }));                                       // left flank landmark
  prims.push(...lightPillar({ cx: 4, cz: 2.5, H }));                                      // right flank landmark
  prims.push(...holoPlatform({ cx: 0, cz: 4.5, w: 6, d: 4, access: 'front' }));           // back overwatch deck

  // one signage placard on the back wall inner face, above the overwatch deck
  box('sign', 'placard', 0, 3.2, maxZ - T - 0.06, 1.8, 0.5, 0.08);

  // neon light rig
  lights.push({ x: -4, y: H - 0.6, z: -1, radius: 14, color: '#39f0ff', intensity: 1.1 });
  lights.push({ x:  4, y: H - 0.6, z: -1, radius: 14, color: '#39f0ff', intensity: 1.1 });
  lights.push({ x:  0, y: H - 0.8, z:  4.5, radius: 16, color: '#8b5cff', intensity: 0.9 });
  lights.push({ x:  0, y: 1.6, z: -4.5, radius: 12, color: '#bfe9ff', intensity: 0.5 });

  const spawn = { x: 0, y: 0, z: minZ + 3, heading: Math.PI }; // just inside the doorway, facing the room (+z)
  return { bounds, primitives: prims, lights, spawn, meta: { type: 'demo', W, L } };
}

// ─── Room Gallery (Phase 3) ────────────────────────────────────────────────────
// A walkable row of open-front bays, one per ROOM_ARCHETYPES entry, so every archetype's designed cover
// composition reads in a single load. Bays alternate cyan/magenta accent to demo the two-tone wing
// zoning. Roofless like everything internetcore. Left→right order = ROOM_ARCHETYPES order (returned in
// meta.order; there's no in-world text). Fixed geometry except each archetype's own seeded variation.
export function generateRoomGallery(opts = {}) {
  const body = { ...BODY, ...(opts.body || {}) };
  const { heightStand } = body;
  const H = opts.H ?? round2(heightStand * 4.8); // tall internetcore walls (~8.6 m)
  const T = opts.T ?? 0.3;
  const coverH = clamp(opts.coverH ?? round2(heightStand * 0.62), 0.9, 1.3);
  const ft = 0.1;
  const bayW = opts.bayW ?? 15, bayD = opts.bayD ?? 20, gap = opts.gap ?? 4;
  const seed = opts.seed ?? 1;
  const N = ROOM_ARCHETYPES.length;
  const pitch = bayW + gap;
  const startX = -(N - 1) * pitch / 2;               // center the row on x=0
  const zFront = -bayD / 2, zBack = bayD / 2;
  const rowX0 = startX - bayW / 2 - gap / 2, rowX1 = startX + (N - 1) * pitch + bayW / 2 + gap / 2;
  const zApron = zFront - 8;                          // clear approach strip the player spawns on

  const prims = [];
  const lights = [];
  const box = (kind, material, cx, cy, cz, sx, sy, sz) => prims.push({ kind, cx, cy, cz, sx, sy, sz, material });

  // one continuous floor slab under the whole row (+ approach), so gaps between bays aren't pits
  const floorCx = (rowX0 + rowX1) / 2, floorCz = (zApron + zBack) / 2;
  box('interior', 'deck', floorCx, -ft / 2, floorCz, rowX1 - rowX0, ft, zBack - zApron);
  // emissive floor grid over the whole footprint (2 m lattice)
  const gy = 0.012, gw = 0.06, gh = 0.02, sp = 2, inset = 0.4;
  for (let x = rowX0 + sp; x <= rowX1 - sp + 1e-6; x += sp) box('grid', 'grid', x, gy, floorCz, gw, gh, (zBack - zApron) - inset);
  for (let z = zApron + sp; z <= zBack - sp + 1e-6; z += sp) box('grid', 'grid', floorCx, gy, z, (rowX1 - rowX0) - inset, gh, gw);

  ROOM_ARCHETYPES.forEach((a, i) => {
    const bx = startX + i * pitch;                   // bay center x
    const x0 = bx - bayW / 2, x1 = bx + bayW / 2;
    const accent = i % 2 === 0 ? 'neon' : 'neonMagenta';

    // three walls (back + two sides); front (-z) open so the player walks in from the approach strip
    box('perimeter', 'panel', bx, H / 2, zBack - T / 2, bayW, H, T);
    box('perimeter', 'panel', x0 + T / 2, H / 2, 0, T, H, bayD);
    box('perimeter', 'panel', x1 - T / 2, H / 2, 0, T, H, bayD);

    // neon top + base trim on the three walls' inner faces
    for (const ty of [H - 0.12, 0.12]) {
      box('neon', accent, bx, ty, zBack - T - 0.02, bayW - 2 * T, 0.12, 0.1);
      box('neon', accent, x0 + T + 0.02, ty, 0, 0.1, 0.12, bayD - 2 * T);
      box('neon', accent, x1 - T - 0.02, ty, 0, 0.1, 0.12, bayD - 2 * T);
    }

    // signage placard on the back wall (identity by position; see meta.order)
    box('sign', 'placard', bx, 3.0, zBack - T - 0.06, 2.0, 0.5, 0.08);

    // archetype cover composition, inset from the walls, entry = open front at x=bx
    const rect = { x0: x0 + 1.6, x1: x1 - 1.6, z0: zFront + 1.6, z1: zBack - 1.6 };
    const rand = mulberry32((seed * 2654435761 + i * 40503) >>> 0);
    prims.push(...buildRoomContent(a.id, { rect, entryX: bx, H, coverH, accent, rand }));

    // per-bay neon fill + a soft front uplight
    lights.push({ x: bx, y: H - 0.7, z: 1, radius: 16, color: accent === 'neon' ? '#39f0ff' : '#ff3df0', intensity: 1.0 });
    lights.push({ x: bx, y: 1.6, z: zFront + 2, radius: 12, color: '#bfe9ff', intensity: 0.5 });
  });

  const bounds = { minX: rowX0, maxX: rowX1, minZ: zApron, maxZ: zBack, yMin: -ft, yMax: H };
  const spawn = { x: 0, y: 0, z: zApron + 3, heading: Math.PI }; // on the approach strip, facing the bays (+z)
  return { bounds, primitives: prims, lights, spawn, meta: { type: 'rooms', bays: N, order: ROOM_ARCHETYPES.map(a => a.id) } };
}
