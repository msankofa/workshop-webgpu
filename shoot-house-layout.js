// shoot-house-layout.js — pure, three-free CQB kill-house layout generator; mirrors right half (x>0) across x=0.
// v3: open kill-house — body-scaled dims, 3–4 large rooms/side with varied types (open / cover / pillars), brighter.

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

const DEFAULTS = {
  W: 64, L: 100, T: 0.3,
  stepRise: 0.18, stepRun: 0.28,
  floorThickness: 0.1,
  minRoomZ: 18,
};

// Wall segment along z (fixed x), split by door openings ({z0,z1}, sorted, non-overlapping).
function wallAlongZ(prims, kind, material, x, zMin, zMax, h, t, openings, yBase = 0) {
  const cuts = [zMin, ...openings.flatMap(o => [o.z0, o.z1]), zMax];
  for (let i = 0; i < cuts.length; i += 2) {
    const a = cuts[i], b = cuts[i + 1];
    if (b - a <= 1e-6) continue;
    prims.push({
      kind, cx: x, cy: yBase + h / 2, cz: (a + b) / 2,
      sx: t, sy: h, sz: b - a, material,
    });
  }
  for (const o of openings) {
    const lintelH = 0.6;
    prims.push({
      kind: 'lintel', cx: x, cy: yBase + h - lintelH / 2, cz: (o.z0 + o.z1) / 2,
      sx: t, sy: lintelH, sz: o.z1 - o.z0, material: 'trim',
    });
  }
}

// Wall segment along x (fixed z), split by door openings ({x0,x1}).
function wallAlongX(prims, kind, material, z, xMin, xMax, h, t, openings, yBase = 0) {
  const cuts = [xMin, ...openings.flatMap(o => [o.x0, o.x1]), xMax];
  for (let i = 0; i < cuts.length; i += 2) {
    const a = cuts[i], b = cuts[i + 1];
    if (b - a <= 1e-6) continue;
    prims.push({
      kind, cx: (a + b) / 2, cy: yBase + h / 2, cz: z,
      sx: b - a, sy: h, sz: t, material,
    });
  }
  for (const o of openings) {
    const lintelH = 0.6;
    prims.push({
      kind: 'lintel', cx: (o.x0 + o.x1) / 2, cy: yBase + h - lintelH / 2, cz: z,
      sx: o.x1 - o.x0, sy: lintelH, sz: t, material: 'trim',
    });
  }
}

function boxesOverlap(ax0, ax1, az0, az1, bx0, bx1, bz0, bz1) {
  return ax0 < bx1 && ax1 > bx0 && az0 < bz1 && az1 > bz0;
}

export function generateShootHouse(seed = 1, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const { W, L, T, stepRise, stepRun, floorThickness, minRoomZ } = cfg;
  const body = { ...BODY, ...(opts.body || {}) };
  const { heightStand } = body;

  // body-scaled dimensions (explicit opts override)
  const H = opts.H ?? round2(heightStand * 2.4);
  const doorW = opts.doorW ?? DOOR_W;
  const coverH = clamp(opts.coverH ?? round2(heightStand * 0.62), 0.9, 1.3);
  const railH = opts.railH ?? round2(heightStand * 0.56);
  const corridorHalf = opts.corridorHalf ?? round2(Math.max(4, heightStand * 2.5));
  const yDeck = opts.yDeck ?? round2(H * 0.83);

  const rand = mulberry32(seed);

  const minX = -W / 2, maxX = W / 2, minZ = -L / 2, maxZ = L / 2;
  const bounds = { minX, maxX, minZ, maxZ, yMin: -floorThickness, yMax: Math.max(H, yDeck + railH) };

  const prims = [];   // right-half + straddling primitives; mirrored at the end
  const lights = [];

  // floor slab straddles x=0, emitted once
  prims.push({
    kind: 'interior', cx: 0, cy: -floorThickness / 2, cz: 0, sx: W, sy: floorThickness, sz: L, material: 'floor',
  });

  // perimeter bounding walls, inset by T/2 so the outer face is flush with bounds; no door openings
  wallAlongZ(prims, 'perimeter', 'wall', maxX - T / 2, minZ, maxZ, H, T, []);
  wallAlongX(prims, 'perimeter', 'wall', maxZ - T / 2, 0, maxX - T, H, T, []);
  wallAlongX(prims, 'perimeter', 'wall', minZ + T / 2, 0, maxX - T, H, T, []);

  // ---- room subdivision: 3–4 large rooms along z, split by full-height cross walls ----
  const zLo = minZ + 1, zHi = maxZ - 1, span = zHi - zLo;
  const maxRooms = Math.max(2, Math.floor(span / minRoomZ));
  const roomCount = Math.min(3 + Math.floor(rand() * 2), maxRooms, 4); // 3 or 4

  const stripsOk = (cs) => {
    const e = [zLo, ...cs, zHi];
    for (let i = 0; i < e.length - 1; i++) if (e[i + 1] - e[i] < minRoomZ) return false;
    return true;
  };
  let cuts, tries = 0;
  do {
    cuts = Array.from({ length: roomCount - 1 }, () => zLo + span * rand()).sort((a, b) => a - b);
    tries++;
  } while (tries < 200 && !stripsOk(cuts));
  if (!stripsOk(cuts)) cuts = Array.from({ length: roomCount - 1 }, (_, i) => zLo + span * (i + 1) / roomCount);

  const edges = [zLo, ...cuts, zHi];
  const roomStrips = Array.from({ length: roomCount }, (_, i) => ({ z0: edges[i], z1: edges[i + 1] }));

  // per-room type; guarantee at least one large empty (open) room
  const TYPES = ['open', 'cover', 'pillars'];
  const roomTypes = roomStrips.map(() => TYPES[Math.floor(rand() * TYPES.length)]);
  if (!roomTypes.includes('open')) roomTypes[Math.floor(rand() * roomTypes.length)] = 'open';

  // spine wall at x=corridorHalf: full length, one wide doorway per room into the corridor
  const spineOpenings = roomStrips
    .map(s => { const cz = (s.z0 + s.z1) / 2; return { z0: cz - doorW / 2, z1: cz + doorW / 2 }; })
    .sort((a, b) => a.z0 - b.z0);
  wallAlongZ(prims, 'interior', 'wall', corridorHalf, minZ, maxZ, H, T, spineOpenings);

  // cross walls dividing the side-room block along z; each gets one doorway connecting adjacent rooms
  const crossOpenings = cuts.map(() => {
    const x0 = corridorHalf + 2 + rand() * Math.max(0.01, maxX - T - corridorHalf - 2 - doorW - 1);
    return { x0, x1: x0 + doorW };
  });
  cuts.forEach((z, i) => {
    wallAlongX(prims, 'interior', 'wall', z, corridorHalf, maxX - T, H, T, [crossOpenings[i]]);
  });

  // ---- staircase near the maxZ end, climbing along z within the corridor lane ----
  const stepCount = Math.ceil(yDeck / stepRise);
  const actualRise = yDeck / stepCount;
  const stairX = corridorHalf - 1.5;
  const stairWidth = 1.4;
  const stairZEnd = maxZ - 2.5; // bottom step
  const stairFootprint = {
    x0: stairX - stairWidth / 2, x1: stairX + stairWidth / 2,
    z0: stairZEnd - stepCount * stepRun, z1: stairZEnd,
  };
  for (let i = 0; i < stepCount; i++) {
    const stepZ1 = stairZEnd - i * stepRun;
    const topY = actualRise * (i + 1);
    prims.push({
      kind: 'step', cx: stairX, cy: topY / 2, cz: stepZ1 - stepRun / 2,
      sx: stairWidth, sy: topY, sz: stepRun, material: 'stair',
    });
  }

  // balcony deck adjoins the stair top, catwalk over the corridor, railed on the open edge
  const deckThickness = 0.2;
  const deckZ1 = stairFootprint.z0 - 0.2;
  const deckZ0 = deckZ1 - 5;
  const deckX0 = stairX - 1.8;
  const deckX1 = Math.min(corridorHalf - 0.3, stairX + 1.8);
  prims.push({
    kind: 'balcony', cx: (deckX0 + deckX1) / 2, cy: yDeck - deckThickness / 2, cz: (deckZ0 + deckZ1) / 2,
    sx: deckX1 - deckX0, sy: deckThickness, sz: deckZ1 - deckZ0, material: 'stair',
  });
  prims.push({
    kind: 'railing', cx: (deckX0 + deckX1) / 2, cy: yDeck + railH / 2, cz: deckZ0,
    sx: deckX1 - deckX0, sy: railH, sz: 0.08, material: 'trim',
  });

  // spawn: clear cell in the corridor near minZ, looking down the corridor toward +z
  const spawn = { x: 0, y: 0, z: minZ + 6, heading: Math.PI };
  const spawnClear = { x0: -1.5, x1: 1.5, z0: spawn.z - 1.5, z1: spawn.z + 1.5 };

  // clear zones: door openings, stair footprint, spawn cell — room content must not overlap these
  const clearZones = [];
  for (const o of spineOpenings) clearZones.push({ x0: corridorHalf - doorW, x1: corridorHalf + doorW, z0: o.z0 - 0.4, z1: o.z1 + 0.4 });
  cuts.forEach((z, i) => {
    const o = crossOpenings[i];
    clearZones.push({ x0: o.x0 - 0.4, x1: o.x1 + 0.4, z0: z - doorW, z1: z + doorW });
  });
  clearZones.push({ x0: stairFootprint.x0 - 0.3, x1: stairFootprint.x1 + 0.3, z0: stairFootprint.z0 - 0.3, z1: stairFootprint.z1 + 0.3 });
  clearZones.push(spawnClear);

  const blocked = (cx, cz, sx, sz) => {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
    return clearZones.some(zn => boxesOverlap(x0, x1, z0, z1, zn.x0, zn.x1, zn.z0, zn.z1));
  };

  // chest-high barricades (shoot-over cover): low walls, long axis clearly longer than thickness
  function placeBarricades(region, count, forceAlong) {
    const thick = 0.4;
    for (let n = 0; n < count; n++) {
      for (let t = 0; t < 60; t++) {
        const along = forceAlong || (rand() < 0.5 ? 'x' : 'z');
        const axisSpan = along === 'x' ? region.x1 - region.x0 : region.z1 - region.z0;
        const len = Math.min(3 + rand() * 1.5, axisSpan);
        if (len < thick * 2.2) break; // region too narrow for a valid low wall
        const sx = along === 'x' ? len : thick;
        const sz = along === 'z' ? len : thick;
        const cx = region.x0 + sx / 2 + rand() * Math.max(0.01, region.x1 - region.x0 - sx);
        const cz = region.z0 + sz / 2 + rand() * Math.max(0.01, region.z1 - region.z0 - sz);
        if (blocked(cx, cz, sx, sz)) continue;
        prims.push({ kind: 'cover', cx, cy: coverH / 2, cz, sx, sy: coverH, sz, material: 'trim' });
        break;
      }
    }
  }

  // full-height columns — hard cover you move around, not shoot over; a colonnade down the room
  function placePillars(region) {
    const cols = 2 + Math.floor(rand() * 2); // 2–3
    const w = 0.6;
    const cx = (region.x0 + region.x1) / 2 + (rand() - 0.5) * Math.max(0, region.x1 - region.x0 - w) * 0.4;
    for (let k = 0; k < cols; k++) {
      const cz = region.z0 + w / 2 + (k + 1) / (cols + 1) * Math.max(0.01, region.z1 - region.z0 - w);
      if (blocked(cx, cz, w, w)) continue;
      prims.push({ kind: 'pillar', cx, cy: H / 2, cz, sx: w, sy: H, sz: w, material: 'wall' });
    }
  }

  roomStrips.forEach((s, i) => {
    const region = { x0: corridorHalf + 1.2, x1: maxX - T - 1.2, z0: s.z0 + 1.5, z1: s.z1 - 1.5 };
    if (roomTypes[i] === 'cover') placeBarricades(region, 1 + (rand() < 0.5 ? 1 : 0));
    else if (roomTypes[i] === 'pillars') placePillars(region);
    // 'open' — left empty
  });
  // corridor cover: 1–2 low walls running along the lane (never spanning its narrow width)
  placeBarricades({ x0: 0.6, x1: corridorHalf - 0.6, z0: minZ + 12, z1: maxZ - 12 }, 1 + (rand() < 0.5 ? 1 : 0), 'z');

  // ---- interior point lights: brighter, open rooms get two; corridor scaled to length ----
  roomStrips.forEach((s, i) => {
    const n = roomTypes[i] === 'open' ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const lx = corridorHalf + 5 + rand() * Math.max(1, maxX - T - corridorHalf - 8);
      const lz = n === 1 ? (s.z0 + s.z1) / 2 : s.z0 + (s.z1 - s.z0) * (k + 1) / (n + 1);
      lights.push({ x: lx, y: H - 0.5, z: lz, radius: 16 });
    }
  });
  const corridorLightCount = Math.max(4, Math.round(L / 18));
  for (let i = 0; i < corridorLightCount; i++) {
    lights.push({ x: 0, y: H - 0.5, z: minZ + (i + 0.5) / corridorLightCount * L, radius: 14 });
  }

  // mirror: every cx>0 primitive/light duplicated with cx -> -cx; cx===0 kept once
  const mirroredPrims = [];
  for (const p of prims) {
    mirroredPrims.push(p);
    if (Math.abs(p.cx) > 1e-9) mirroredPrims.push({ ...p, cx: -p.cx });
  }
  const mirroredLights = [];
  for (const lt of lights) {
    mirroredLights.push(lt);
    if (Math.abs(lt.x) > 1e-9) mirroredLights.push({ ...lt, x: -lt.x });
  }

  return { bounds, primitives: mirroredPrims, lights: mirroredLights, spawn };
}
