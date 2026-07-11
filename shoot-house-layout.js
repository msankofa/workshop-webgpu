// shoot-house-layout.js — pure, three-free CQB kill-house layout generator; mirrors right half (x>0) across x=0.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DOOR_W = 1.2;

const DEFAULTS = {
  W: 40, L: 60, H: 3.5, T: 0.3, yDeck: 3.2,
  stepRise: 0.18, stepRun: 0.28,
  floorThickness: 0.1, railH: 1.0,
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
  const { W, L, H, T, yDeck, stepRise, stepRun, floorThickness, railH } = cfg;
  const rand = mulberry32(seed);

  const minX = -W / 2, maxX = W / 2, minZ = -L / 2, maxZ = L / 2;
  const bounds = { minX, maxX, minZ, maxZ, yMin: -floorThickness, yMax: Math.max(H, yDeck + railH) };

  const prims = [];   // right-half + straddling primitives; mirrored at the end
  const lights = [];

  // floor slab straddles x=0, emitted once
  prims.push({
    kind: 'interior', cx: 0, cy: -floorThickness / 2, cz: 0, sx: W, sy: floorThickness, sz: L, material: 'floor',
  });

  // perimeter walls inset by T/2 so the outer face is flush with bounds
  wallAlongZ(prims, 'perimeter', 'wall', maxX - T / 2, minZ, maxZ, H, T, []);
  wallAlongX(prims, 'perimeter', 'wall', maxZ - T / 2, 0, maxX - T, H, T, []);
  wallAlongX(prims, 'perimeter', 'wall', minZ + T / 2, 0, maxX - T, H, T, []);

  // central spine (x=0), 1-2 door openings; one always straddles z=0 to keep spawn clear
  const spineOpenings = [{ z0: -DOOR_W / 2, z1: DOOR_W / 2 }];
  if (rand() < 0.5) {
    const side = rand() < 0.5 ? -1 : 1;
    const centerZ = side * (10 + rand() * (maxZ - 12));
    const z0 = Math.max(minZ + 0.5, centerZ - DOOR_W / 2);
    const z1 = Math.min(maxZ - 0.5, z0 + DOOR_W);
    if (z1 < spineOpenings[0].z0 - 0.6 || z0 > spineOpenings[0].z1 + 0.6) spineOpenings.push({ z0, z1 });
  }
  spineOpenings.sort((a, b) => a.z0 - b.z0);
  wallAlongZ(prims, 'interior', 'wall', 0, minZ, maxZ, H, T, spineOpenings);

  // seeded room grid: cross walls at random z, mid wall splits the middle strip
  const crossZ = [-(8 + rand() * 6), 8 + rand() * 6];
  const crossOpenings = crossZ.map(() => {
    const cx0 = 4 + rand() * (maxX - T - 4 - DOOR_W - 1);
    return { x0: cx0, x1: cx0 + DOOR_W };
  });
  crossZ.forEach((z, i) => {
    wallAlongX(prims, 'interior', 'wall', z, 0, maxX - T, H, T, [crossOpenings[i]]);
  });

  // staircase computed before the mid wall so the mid wall can clear its top
  const stepCount = Math.ceil(yDeck / stepRise);
  const actualRise = yDeck / stepCount;
  const stairXStart = 2.5;
  const stairZ = crossZ[0] + 3; // guaranteed inside the middle strip
  const stairWidth = 1.3;
  const stairFootprint = { x0: stairXStart, x1: stairXStart + stepCount * stepRun, z0: stairZ - stairWidth / 2, z1: stairZ + stairWidth / 2 };
  // each tread is a floor->top solid block, so the stair reads as a walkable ramp
  for (let i = 0; i < stepCount; i++) {
    const stepX0 = stairXStart + i * stepRun;
    const topY = actualRise * (i + 1);
    prims.push({
      kind: 'step', cx: stepX0 + stepRun / 2, cy: topY / 2, cz: stairZ,
      sx: stepRun, sy: topY, sz: stairWidth, material: 'stair',
    });
  }

  const midWallX = stairFootprint.x1 + 1.5 + rand() * 2.5; // past the stair top, leaves deck width
  const midOpenZ0 = crossZ[0] + 2 + rand() * (crossZ[1] - crossZ[0] - 4 - DOOR_W);
  const midOpening = { z0: midOpenZ0, z1: midOpenZ0 + DOOR_W };
  wallAlongZ(prims, 'interior', 'wall', midWallX, crossZ[0], crossZ[1], H, T, [midOpening]);

  // balcony deck adjoins the stair top; upper walkway over the stair room
  const deckX0 = stairFootprint.x1;
  const deckX1 = midWallX - 0.3;
  const deckZ0 = crossZ[0] + T;
  const deckZ1 = -2;
  const deckThickness = 0.2;
  prims.push({
    kind: 'balcony', cx: (deckX0 + deckX1) / 2, cy: yDeck - deckThickness / 2, cz: (deckZ0 + deckZ1) / 2,
    sx: deckX1 - deckX0, sy: deckThickness, sz: deckZ1 - deckZ0, material: 'stair',
  });
  // railing runs along the open edge (z = deckZ1, facing the corridor)
  prims.push({
    kind: 'railing', cx: (deckX0 + deckX1) / 2, cy: yDeck + railH / 2, cz: deckZ1,
    sx: deckX1 - deckX0, sy: railH, sz: 0.08, material: 'trim',
  });

  // spawn: clear cell on the central corridor near z=0
  const spawn = { x: 0, y: 0, z: 0, heading: Math.PI / 2 };
  const spawnClear = { x0: -1.2, x1: 1.2, z0: -1.2, z1: 1.2 };

  // cover: seeded low blocks, avoiding openings/stairs/spawn
  const doorClearZones = [];
  for (const o of spineOpenings) doorClearZones.push({ x0: -DOOR_W, x1: DOOR_W, z0: o.z0 - 0.4, z1: o.z1 + 0.4 });
  crossZ.forEach((z, i) => {
    const o = crossOpenings[i];
    doorClearZones.push({ x0: o.x0 - 0.4, x1: o.x1 + 0.4, z0: z - DOOR_W, z1: z + DOOR_W });
  });
  doorClearZones.push({ x0: midWallX - DOOR_W, x1: midWallX + DOOR_W, z0: midOpening.z0 - 0.4, z1: midOpening.z1 + 0.4 });
  doorClearZones.push({ x0: stairFootprint.x0 - 0.3, x1: stairFootprint.x1 + 0.3, z0: stairFootprint.z0 - 0.3, z1: stairFootprint.z1 + 0.3 });
  doorClearZones.push(spawnClear);

  const coverH = 0.9, coverSize = 0.8;
  const coverCount = 6;
  let placed = 0, tries = 0;
  while (placed < coverCount && tries < 200) {
    tries++;
    const cx = 1 + rand() * (maxX - 1.5);
    const cz = minZ + 1 + rand() * (L - 2);
    const half = coverSize / 2;
    const box = { x0: cx - half, x1: cx + half, z0: cz - half, z1: cz + half };
    let blocked = false;
    for (const zone of doorClearZones) {
      if (boxesOverlap(box.x0, box.x1, box.z0, box.z1, zone.x0, zone.x1, zone.z0, zone.z1)) { blocked = true; break; }
    }
    if (blocked) continue;
    // stay clear of perimeter/spine walls themselves
    if (cx < T + half || cx > maxX - T - half) continue;
    prims.push({
      kind: 'cover', cx, cy: coverH / 2, cz, sx: coverSize, sy: coverH, sz: coverSize, material: 'trim',
    });
    placed++;
  }

  // interior point lights: seeded, right half only (mirrored below)
  const lightCount = 5;
  for (let i = 0; i < lightCount; i++) {
    const lx = 2 + rand() * (maxX - 4);
    const lz = minZ + 4 + rand() * (L - 8);
    lights.push({ x: lx, y: H - 0.5, z: lz, radius: 8 });
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
