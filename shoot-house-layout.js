// shoot-house-layout.js — pure, three-free CQB kill-house layout generator; mirrors right half (x>0) across x=0.
// v2: open kill-house — wide central corridor, ~3 large rooms per side, barricade cover (not cubes).

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DOOR_W = 2.4;

const DEFAULTS = {
  W: 50, L: 80, H: 4.0, T: 0.3, yDeck: 3.4,
  stepRise: 0.18, stepRun: 0.28,
  floorThickness: 0.1, railH: 1.0,
  corridorHalf: 4,
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
  const { W, L, H, T, yDeck, stepRise, stepRun, floorThickness, railH, corridorHalf } = cfg;
  const rand = mulberry32(seed);

  const minX = -W / 2, maxX = W / 2, minZ = -L / 2, maxZ = L / 2;
  const bounds = { minX, maxX, minZ, maxZ, yMin: -floorThickness, yMax: Math.max(H, yDeck + railH) };

  const prims = [];   // right-half + straddling primitives; mirrored at the end
  const lights = [];

  // floor slab straddles x=0, emitted once
  prims.push({
    kind: 'interior', cx: 0, cy: -floorThickness / 2, cz: 0, sx: W, sy: floorThickness, sz: L, material: 'floor',
  });

  // perimeter walls inset by T/2 so the outer face is flush with bounds; no door openings
  wallAlongZ(prims, 'perimeter', 'wall', maxX - T / 2, minZ, maxZ, H, T, []);
  wallAlongX(prims, 'perimeter', 'wall', maxZ - T / 2, 0, maxX - T, H, T, []);
  wallAlongX(prims, 'perimeter', 'wall', minZ + T / 2, 0, maxX - T, H, T, []);

  // spine wall at x=corridorHalf: full length, a DOOR_W opening into each of the ~3 room strips
  const minRoomZ = 18; // enforced minimum room z-extent so rooms stay large
  const usableZ = L - 2; // small margin so cross walls don't hug the perimeter
  // seed 2 interior cross-wall z positions splitting the room block into 3 strips, each >= minRoomZ
  let crossZ;
  {
    const z0 = minZ + 1;
    const z3 = maxZ - 1;
    const span = z3 - z0;
    // pick two ordered interior cut points; reject-resample until all 3 strips >= minRoomZ
    let a, b, tries = 0;
    do {
      const t1 = 0.2 + rand() * 0.25;
      const t2 = 0.55 + rand() * 0.25;
      a = z0 + span * Math.min(t1, t2);
      b = z0 + span * Math.max(t1, t2);
      tries++;
    } while (tries < 50 && (a - z0 < minRoomZ || b - a < minRoomZ || z3 - b < minRoomZ));
    crossZ = [a, b];
  }
  const roomStrips = [
    { z0: minZ + 1, z1: crossZ[0] },
    { z0: crossZ[0], z1: crossZ[1] },
    { z0: crossZ[1], z1: maxZ - 1 },
  ];

  // spine door: one opening per room strip, centered in that strip's z-range
  const spineOpenings = roomStrips.map(s => {
    const cz = (s.z0 + s.z1) / 2;
    return { z0: cz - DOOR_W / 2, z1: cz + DOOR_W / 2 };
  }).sort((a, b) => a.z0 - b.z0);
  wallAlongZ(prims, 'interior', 'wall', corridorHalf, minZ, maxZ, H, T, spineOpenings);

  // 2 full-height cross walls dividing the side-room block along z; each gets one doorway
  const crossOpenings = crossZ.map(() => {
    const cx0 = corridorHalf + 2 + rand() * (maxX - T - corridorHalf - 2 - DOOR_W - 1);
    return { x0: cx0, x1: cx0 + DOOR_W };
  });
  crossZ.forEach((z, i) => {
    wallAlongX(prims, 'interior', 'wall', z, corridorHalf, maxX - T, H, T, [crossOpenings[i]]);
  });

  // staircase near the maxZ end of the corridor, runs along z (climbing toward -z) so its
  // footprint fits within the corridor width instead of spilling into the room block
  const stepCount = Math.ceil(yDeck / stepRise);
  const actualRise = yDeck / stepCount;
  const stairX = corridorHalf - 1.5;
  const stairWidth = 1.4;
  const stairZEnd = maxZ - 2.5; // bottom step (z closest to perimeter)
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

  // balcony deck adjoins the stair top (lower-z end), forms a catwalk over the corridor
  const deckThickness = 0.2;
  const deckZ1 = stairFootprint.z0 - 0.2;
  const deckZ0 = deckZ1 - 5;
  const deckX0 = stairX - 1.8;
  const deckX1 = Math.min(corridorHalf - 0.3, stairX + 1.8);
  prims.push({
    kind: 'balcony', cx: (deckX0 + deckX1) / 2, cy: yDeck - deckThickness / 2, cz: (deckZ0 + deckZ1) / 2,
    sx: deckX1 - deckX0, sy: deckThickness, sz: deckZ1 - deckZ0, material: 'stair',
  });
  // railing on the open edge facing the corridor (z = deckZ0, away from the stair)
  prims.push({
    kind: 'railing', cx: (deckX0 + deckX1) / 2, cy: yDeck + railH / 2, cz: deckZ0,
    sx: deckX1 - deckX0, sy: railH, sz: 0.08, material: 'trim',
  });

  // spawn: clear cell in the corridor near minZ, looking down the corridor toward +z
  const spawn = { x: 0, y: 0, z: minZ + 6, heading: Math.PI };
  const spawnClear = { x0: -1.5, x1: 1.5, z0: spawn.z - 1.5, z1: spawn.z + 1.5 };

  // clear zones: door openings, stair footprint, spawn cell — cover must not overlap these
  const doorClearZones = [];
  for (const o of spineOpenings) doorClearZones.push({ x0: corridorHalf - DOOR_W, x1: corridorHalf + DOOR_W, z0: o.z0 - 0.4, z1: o.z1 + 0.4 });
  crossZ.forEach((z, i) => {
    const o = crossOpenings[i];
    doorClearZones.push({ x0: o.x0 - 0.4, x1: o.x1 + 0.4, z0: z - DOOR_W, z1: z + DOOR_W });
  });
  doorClearZones.push({ x0: stairFootprint.x0 - 0.3, x1: stairFootprint.x1 + 0.3, z0: stairFootprint.z0 - 0.3, z1: stairFootprint.z1 + 0.3 });
  doorClearZones.push(spawnClear);

  // cover: seeded barricades — low walls (long axis x or z), ~1 per room + 1-2 in the corridor
  const coverH = 1.1, coverLen = 3 + rand() * 1, coverThick = 0.4;
  const coverRegions = [
    { x0: corridorHalf + 1, x1: maxX - T - 1, z0: roomStrips[0].z0 + 1, z1: roomStrips[0].z1 - 1 },
    { x0: corridorHalf + 1, x1: maxX - T - 1, z0: roomStrips[1].z0 + 1, z1: roomStrips[1].z1 - 1 },
    { x0: corridorHalf + 1, x1: maxX - T - 1, z0: roomStrips[2].z0 + 1, z1: roomStrips[2].z1 - 1 },
    { x0: 0.5, x1: corridorHalf - 0.5, z0: minZ + 10, z1: maxZ - 10 },
    { x0: 0.5, x1: corridorHalf - 0.5, z0: minZ + 12, z1: maxZ - 12 },
  ];
  for (const region of coverRegions) {
    let placed = false, tries = 0;
    while (!placed && tries < 60) {
      tries++;
      const along = rand() < 0.5 ? 'x' : 'z';
      const len = coverLen;
      const cx = region.x0 + len / 2 + rand() * Math.max(0.01, (region.x1 - region.x0 - len));
      const cz = region.z0 + len / 2 + rand() * Math.max(0.01, (region.z1 - region.z0 - len));
      const sx = along === 'x' ? len : coverThick;
      const sz = along === 'z' ? len : coverThick;
      const box = { x0: cx - sx / 2, x1: cx + sx / 2, z0: cz - sz / 2, z1: cz + sz / 2 };
      let blocked = false;
      for (const zone of doorClearZones) {
        if (boxesOverlap(box.x0, box.x1, box.z0, box.z1, zone.x0, zone.x1, zone.z0, zone.z1)) { blocked = true; break; }
      }
      if (blocked) continue;
      prims.push({
        kind: 'cover', cx, cy: coverH / 2, cz, sx, sy: coverH, sz, material: 'trim',
      });
      placed = true;
    }
  }

  // interior point lights: one per room strip + corridor lights, right half + straddling only (mirrored below)
  roomStrips.forEach(s => {
    const lx = corridorHalf + 4 + rand() * (maxX - T - corridorHalf - 6);
    const lz = (s.z0 + s.z1) / 2;
    lights.push({ x: lx, y: H - 0.5, z: lz, radius: 14 });
  });
  // corridor lights straddle x=0 so they're emitted once by the mirror step
  const corridorLightCount = 4;
  for (let i = 0; i < corridorLightCount; i++) {
    const t = (i + 0.5) / corridorLightCount;
    const lz = minZ + t * L;
    lights.push({ x: 0, y: H - 0.5, z: lz, radius: 12 });
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
