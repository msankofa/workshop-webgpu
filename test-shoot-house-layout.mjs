import { generateShootHouse, DOOR_W } from './shoot-house-layout.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };

const CAP_DIAM = 0.6;
const MIN_ROOM_Z = 18;

// ---- determinism ----
{
  const a = generateShootHouse(1);
  const b = generateShootHouse(1);
  ok(JSON.stringify(a) === JSON.stringify(b), 'same seed -> deep-equal descriptor');
  const c = generateShootHouse(2);
  ok(JSON.stringify(a) !== JSON.stringify(c), 'different seed -> different descriptor');
  const d = generateShootHouse(1, { W: 30 });
  ok(JSON.stringify(a) !== JSON.stringify(d), 'different opts -> different descriptor');
  const e = generateShootHouse(1, { W: 30 });
  ok(JSON.stringify(d) === JSON.stringify(e), 'same seed+opts -> deep-equal descriptor');
}

// ---- solidAt(x,z) sampled at world height y; excludes elevated/opening primitives by default ----
function solidAt(prims, x, z, y = 1.5, opts = {}) {
  const skipKinds = opts.includeAll
    ? new Set()
    : new Set(['lintel', 'railing', 'step', 'balcony']);
  for (const p of prims) {
    if (skipKinds.has(p.kind)) continue;
    const x0 = p.cx - p.sx / 2, x1 = p.cx + p.sx / 2;
    const y0 = p.cy - p.sy / 2, y1 = p.cy + p.sy / 2;
    const z0 = p.cz - p.sz / 2, z1 = p.cz + p.sz / 2;
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1) return true;
  }
  return false;
}

// reconstruct the room z-strips from the interior cross walls (run along x, thin in z, cx>corridorHalf)
function roomStripsOf(primitives, bounds, corridorHalf) {
  const crossWalls = primitives.filter(p => p.kind === 'interior' && p.material === 'wall' && p.cx > corridorHalf + 0.01 && p.sz <= 0.5 + 1e-6);
  const crossZs = [...new Set(crossWalls.map(p => Number(p.cz.toFixed(6))))].sort((a, b) => a - b);
  const edges = [bounds.minZ, ...crossZs, bounds.maxZ];
  const strips = edges.slice(0, -1).map((z0, i) => ({ z0, z1: edges[i + 1] }));
  return { crossZs, strips };
}

// ---- invariant suite: run for a spread of seeds so seeded topology + optional branches are exercised ----
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const roomTypesSeen = new Set();
for (const seed of SEEDS) {
  const house = generateShootHouse(seed);
  const { bounds, primitives, lights, spawn } = house;
  const corridorHalf = 4.5; // matches generator body-scaled default (heightStand 1.8 * 2.5)
  const wallH = primitives.find(p => p.kind === 'perimeter').sy;

  // ---- bounds validity ----
  {
    ok(bounds.minX === -bounds.maxX, `[seed ${seed}] bounds symmetric about x=0 (minX = -maxX)`);
    ok(bounds.maxX > 0 && bounds.maxZ > bounds.minZ && bounds.yMax > bounds.yMin, `[seed ${seed}] bounds well-formed`);
    let allWithin = true;
    const eps = 1e-6;
    for (const p of primitives) {
      const x0 = p.cx - p.sx / 2, x1 = p.cx + p.sx / 2;
      const y0 = p.cy - p.sy / 2, y1 = p.cy + p.sy / 2;
      const z0 = p.cz - p.sz / 2, z1 = p.cz + p.sz / 2;
      if (x0 < bounds.minX - eps || x1 > bounds.maxX + eps ||
          z0 < bounds.minZ - eps || z1 > bounds.maxZ + eps ||
          y1 > bounds.yMax + eps || y0 < bounds.yMin - eps) {
        allWithin = false;
      }
    }
    ok(allWithin, `[seed ${seed}] all primitives lie strictly within bounds on all six faces`);
  }

  // ---- mirror symmetry ----
  {
    const key = p => `${p.kind}|${p.material}|${p.cy.toFixed(6)}|${p.cz.toFixed(6)}|${p.sx.toFixed(6)}|${p.sy.toFixed(6)}|${p.sz.toFixed(6)}`;
    const positive = primitives.filter(p => p.cx > 1e-9);
    const negative = primitives.filter(p => p.cx < -1e-9);
    const straddling = primitives.filter(p => Math.abs(p.cx) <= 1e-9);

    ok(positive.length === negative.length, `[seed ${seed}] equal count of cx>0 and cx<0 primitives`);

    const negByKey = new Map();
    for (const p of negative) {
      const k = key(p);
      (negByKey.get(k) || negByKey.set(k, []).get(k)).push(p);
    }
    let allMirrored = true;
    for (const p of positive) {
      const k = key(p);
      const bucket = negByKey.get(k) || [];
      const idx = bucket.findIndex(q => Math.abs(q.cx + p.cx) < 1e-6);
      if (idx === -1) { allMirrored = false; break; }
      bucket.splice(idx, 1);
    }
    ok(allMirrored, `[seed ${seed}] every cx>0 primitive has a matching cx-> -cx primitive (same kind/material/extents)`);

    // straddling primitives (floor slab, corridor lights' host primitives if any) appear once, not duplicated
    let straddleOnce = true;
    const seen = new Set();
    for (const p of straddling) {
      const k = key(p) + '|' + p.cx.toFixed(6);
      if (seen.has(k)) straddleOnce = false;
      seen.add(k);
    }
    ok(straddleOnce, `[seed ${seed}] axis-straddling primitives are not duplicated`);
    ok(straddling.some(p => p.material === 'floor'), `[seed ${seed}] floor slab is a straddling primitive`);

    // lights mirrored the same way
    const lkey = l => `${l.y.toFixed(6)}|${l.z.toFixed(6)}|${l.radius.toFixed(6)}`;
    const lpos = lights.filter(l => l.x > 1e-9);
    const lneg = lights.filter(l => l.x < -1e-9);
    ok(lpos.length === lneg.length && lpos.length > 0, `[seed ${seed}] equal nonzero count of cx>0 / cx<0 lights`);
    const lnegByKey = new Map();
    for (const l of lneg) { const k = lkey(l); (lnegByKey.get(k) || lnegByKey.set(k, []).get(k)).push(l); }
    let lightsMirrored = true;
    for (const l of lpos) {
      const bucket = lnegByKey.get(lkey(l)) || [];
      const idx = bucket.findIndex(q => Math.abs(q.x + l.x) < 1e-6);
      if (idx === -1) { lightsMirrored = false; break; }
      bucket.splice(idx, 1);
    }
    ok(lightsMirrored, `[seed ${seed}] every light with x>0 has a mirrored x<0 counterpart`);

    // straddling lights (corridor, x=0) exist and are not duplicated
    const straddlingLights = lights.filter(l => Math.abs(l.x) <= 1e-9);
    ok(straddlingLights.length > 0, `[seed ${seed}] corridor lights straddle x=0`);
  }

  // ---- solidAt(x,z) === solidAt(-x,z) sampled over a grid (functional mirror check) ----
  {
    let matched = true, sampledAny = false;
    for (let x = 0.25; x <= bounds.maxX; x += 0.5) {
      for (let z = bounds.minZ + 0.25; z <= bounds.maxZ; z += 0.5) {
        sampledAny = true;
        if (solidAt(primitives, x, z) !== solidAt(primitives, -x, z)) { matched = false; }
      }
    }
    ok(sampledAny && matched, `[seed ${seed}] solidAt(x,z) === solidAt(-x,z) over sampled grid (wall solids only)`);
  }

  // ---- enclosure ----
  {
    const perim = primitives.filter(p => p.kind === 'perimeter');
    ok(perim.every(p => p.material === 'wall'), `[seed ${seed}] perimeter primitives are wall material`);
    // perimeter walls are inset by up to half their own thickness from the boundary line;
    // classify by which face (their outer edge) touches which bound, not exact center match
    const nearMaxX = p => Math.abs((p.cx + p.sx / 2) - bounds.maxX) < 0.2;
    const nearMinX = p => Math.abs((p.cx - p.sx / 2) - bounds.minX) < 0.2;
    const nearMaxZ = p => Math.abs((p.cz + p.sz / 2) - bounds.maxZ) < 0.2;
    const nearMinZ = p => Math.abs((p.cz - p.sz / 2) - bounds.minZ) < 0.2;
    const east = perim.filter(nearMaxX);
    const west = perim.filter(nearMinX);
    const north = perim.filter(nearMaxZ);
    const south = perim.filter(nearMinZ);
    ok(east.length > 0 && west.length > 0 && north.length > 0 && south.length > 0, `[seed ${seed}] perimeter has segments on all four boundary lines`);

    function checkFullCoverage(segs, axisMin, axisMax, along) {
      const spans = segs.map(p => {
        const c = along === 'z' ? p.cz : p.cx;
        const s = along === 'z' ? p.sz : p.sx;
        return [c - s / 2, c + s / 2];
      }).sort((a, b) => a[0] - b[0]);
      let cursor = axisMin;
      let maxGap = 0;
      for (const [a, b] of spans) {
        const gap = a - cursor;
        if (gap > maxGap) maxGap = gap;
        cursor = Math.max(cursor, b);
      }
      maxGap = Math.max(maxGap, axisMax - cursor);
      return maxGap;
    }
    const gapEast = checkFullCoverage(east, bounds.minZ, bounds.maxZ, 'z');
    const gapWest = checkFullCoverage(west, bounds.minZ, bounds.maxZ, 'z');
    const gapNorth = checkFullCoverage(north, bounds.minX, bounds.maxX, 'x');
    const gapSouth = checkFullCoverage(south, bounds.minX, bounds.maxX, 'x');
    ok(gapEast < CAP_DIAM, `[seed ${seed}] east perimeter wall has no gap >= player capsule diameter (max gap ${gapEast.toFixed(3)})`);
    ok(gapWest < CAP_DIAM, `[seed ${seed}] west perimeter wall has no gap >= player capsule diameter (max gap ${gapWest.toFixed(3)})`);
    ok(gapNorth < CAP_DIAM, `[seed ${seed}] north perimeter wall has no gap >= player capsule diameter (max gap ${gapNorth.toFixed(3)})`);
    ok(gapSouth < CAP_DIAM, `[seed ${seed}] south perimeter wall has no gap >= player capsule diameter (max gap ${gapSouth.toFixed(3)})`);

    // no lintel sits on a perimeter line (i.e. perimeter itself has no door openings)
    const lintels = primitives.filter(p => p.kind === 'lintel');
    const onPerimeterLine = lintels.some(l =>
      Math.abs(l.cx - bounds.maxX) < 1e-6 || Math.abs(l.cx - bounds.minX) < 1e-6 ||
      Math.abs(l.cz - bounds.maxZ) < 1e-6 || Math.abs(l.cz - bounds.minZ) < 1e-6);
    ok(!onPerimeterLine, `[seed ${seed}] perimeter has no door openings (no lintel on a boundary line)`);
  }

  // ---- navigability ----
  {
    const lintels = primitives.filter(p => p.kind === 'lintel');
    ok(lintels.length > 0, `[seed ${seed}] at least one door opening exists`);
    const widths = lintels.map(l => Math.max(l.sx, l.sz)); // opening width is the larger horizontal extent
    ok(widths.every(w => w >= CAP_DIAM), `[seed ${seed}] every door opening width >= player capsule diameter (${CAP_DIAM})`);
    ok(widths.every(w => w >= DOOR_W - 1e-6), `[seed ${seed}] every door opening width >= DOOR_W (${DOOR_W})`);

    // spawn cell clear of solids at head height and at a low height (catches short solids like step/cover)
    const spawnClearAt = y => !solidAt(primitives, spawn.x, spawn.z, y, { includeAll: true }) &&
      !solidAt(primitives, spawn.x + 0.3, spawn.z, y, { includeAll: true }) &&
      !solidAt(primitives, spawn.x - 0.3, spawn.z, y, { includeAll: true }) &&
      !solidAt(primitives, spawn.x, spawn.z + 0.3, y, { includeAll: true }) &&
      !solidAt(primitives, spawn.x, spawn.z - 0.3, y, { includeAll: true });
    ok(spawnClearAt(1.0), `[seed ${seed}] spawn cell (and immediate neighborhood) is clear of solids at y=1.0`);
    ok(spawnClearAt(0.4), `[seed ${seed}] spawn cell (and immediate neighborhood) is clear of solids at y=0.4 (catches short solids)`);
    ok(spawn.y === 0, `[seed ${seed}] spawn.y is on the floor`);
    ok(spawn.z > bounds.minZ && spawn.z < 0, `[seed ${seed}] spawn sits in the corridor near the minZ end`);
    ok(spawn.x === 0, `[seed ${seed}] spawn sits on the central corridor (x=0)`);

    // corridor -> every room reachability: each side room (bounded by the spine wall) must have
    // a spine doorway opening into it, i.e. a lintel at cx=corridorHalf whose z-span falls inside the room's z-range.
    const spineLintels = lintels.filter(l => Math.abs(l.cx - corridorHalf) < 1e-6);
    const { crossZs, strips: roomStrips } = roomStripsOf(primitives, bounds, corridorHalf);
    const roomCount = roomStrips.length;
    ok(roomCount >= 3 && roomCount <= 4, `[seed ${seed}] 3–4 large rooms per side (got ${roomCount})`);
    ok(spineLintels.length >= roomCount, `[seed ${seed}] spine wall has at least one door opening per room`);
    ok(crossZs.length === roomCount - 1, `[seed ${seed}] ${roomCount - 1} cross walls divide the side-room block into ${roomCount} rooms`);

    const roomsReachable = roomStrips.every(strip =>
      spineLintels.some(l => l.cz > strip.z0 && l.cz < strip.z1));
    ok(roomsReachable, `[seed ${seed}] every side room has a spine doorway opening directly onto the corridor`);
  }

  // ---- openness: rooms are large, interior wall count is small ----
  {
    const { crossZs, strips: roomStrips } = roomStripsOf(primitives, bounds, corridorHalf);
    const roomDepth = bounds.maxX - corridorHalf; // x-extent of the side-room block
    for (const [i, strip] of roomStrips.entries()) {
      const zExtent = strip.z1 - strip.z0;
      const area = zExtent * roomDepth;
      ok(zExtent >= MIN_ROOM_Z - 1, `[seed ${seed}] room ${i} z-extent >= ${MIN_ROOM_Z}m (got ${zExtent.toFixed(2)})`);
      ok(area >= MIN_ROOM_Z * 15, `[seed ${seed}] room ${i} floor area is large, not a cubicle (got ${area.toFixed(1)} sq m)`);
    }

    // interior wall count bounded: 1 spine (right half) + (roomCount-1) cross walls = a handful of
    // full-wall segments, not a scatter. Pillars (kind='pillar') and cover are excluded by the kind filter.
    const interiorWalls = primitives.filter(p => p.kind === 'interior' && p.material === 'wall' && p.cx >= -1e-9);
    const zLines = new Set(interiorWalls.filter(p => p.sz > p.sx).map(p => p.cx.toFixed(3)));
    const xLines = new Set(interiorWalls.filter(p => p.sx >= p.sz).map(p => p.cz.toFixed(3)));
    const totalLines = zLines.size + xLines.size;
    ok(totalLines === 1 + crossZs.length, `[seed ${seed}] interior wall lines = 1 spine + ${crossZs.length} cross (got ${totalLines})`);
  }

  // ---- cover: barricades, not cubes ----
  {
    const cover = primitives.filter(p => p.kind === 'cover');
    ok(cover.length > 0, `[seed ${seed}] at least one cover barricade exists`);
    ok(cover.every(c => c.material === 'trim'), `[seed ${seed}] cover barricades are trim material`);
    ok(cover.every(c => c.sy >= 0.9 && c.sy <= 1.3), `[seed ${seed}] cover barricade height in [0.9, 1.3]`);
    ok(cover.every(c => Math.max(c.sx, c.sz) > Math.min(c.sx, c.sz) * 2), `[seed ${seed}] cover barricades are low walls (long axis clearly longer than thickness)`);

    const lintels = primitives.filter(p => p.kind === 'lintel');
    const stairsAll = primitives.filter(p => p.kind === 'step');
    const stairX0 = Math.min(...stairsAll.map(s => s.cx - s.sx / 2));
    const stairX1 = Math.max(...stairsAll.map(s => s.cx + s.sx / 2));
    const stairZ0 = Math.min(...stairsAll.map(s => s.cz - s.sz / 2));
    const stairZ1 = Math.max(...stairsAll.map(s => s.cz + s.sz / 2));
    const spawnClear = { x0: -1.5, x1: 1.5, z0: spawn.z - 1.5, z1: spawn.z + 1.5 };
    function overlapsAny(c) {
      const cx0 = c.cx - c.sx / 2, cx1 = c.cx + c.sx / 2, cz0 = c.cz - c.sz / 2, cz1 = c.cz + c.sz / 2;
      for (const l of lintels) {
        const lx0 = l.cx - Math.max(l.sx, DOOR_W) / 2 - 0.01, lx1 = l.cx + Math.max(l.sx, DOOR_W) / 2 + 0.01;
        const lz0 = l.cz - Math.max(l.sz, DOOR_W) / 2 - 0.01, lz1 = l.cz + Math.max(l.sz, DOOR_W) / 2 + 0.01;
        if (cx0 < lx1 && cx1 > lx0 && cz0 < lz1 && cz1 > lz0) return true;
      }
      if (cx0 < stairX1 && cx1 > stairX0 && cz0 < stairZ1 && cz1 > stairZ0) return true;
      if (cx0 < spawnClear.x1 && cx1 > spawnClear.x0 && cz0 < spawnClear.z1 && cz1 > spawnClear.z0) return true;
      return false;
    }
    ok(cover.every(c => !overlapsAny(c)), `[seed ${seed}] no cover barricade overlaps a door opening, the stair footprint, or the spawn cell`);
  }

  // ---- stairs ----
  // stair climbs along z (descending cz = ascending height); isolate right-half run, sort by height
  const stairsRight = primitives.filter(p => p.kind === 'step' && p.cx > 0).sort((a, b) => (a.cy + a.sy / 2) - (b.cy + b.sy / 2));
  {
    const steps = stairsRight;
    ok(steps.length > 0, `[seed ${seed}] stair has at least one step`);
    // treads are solid floor->top blocks; per-step rise = delta of tread-top height (cy + sy/2)
    const tops = steps.map(s => s.cy + s.sy / 2);
    const rises = tops.map((t, i) => i === 0 ? t : t - tops[i - 1]);
    ok(rises.every(r => r >= 0.12 && r <= 0.22), `[seed ${seed}] each step rise is within human range (0.12-0.22 m)`);
    const runs = steps.map(s => s.sz); // run direction is z
    ok(runs.every(r => r >= 0.2 && r <= 0.4), `[seed ${seed}] each step run is within human range (0.2-0.4 m)`);

    let monotonic = true;
    for (let i = 1; i < steps.length; i++) {
      if (tops[i] <= tops[i - 1] || steps[i].cz >= steps[i - 1].cz) monotonic = false;
    }
    ok(monotonic, `[seed ${seed}] steps ascend monotonically in both height and stair-run direction`);

    const topStep = steps[steps.length - 1];
    const topStepHeight = topStep.cy + topStep.sy / 2; // top surface of the last step
    const lastRise = rises[rises.length - 1];
    const deck = primitives.find(p => p.kind === 'balcony' && p.cx > 0);
    ok(!!deck, `[seed ${seed}] a balcony deck primitive exists`);
    const deckTopY = deck.cy + deck.sy / 2;
    ok(Math.abs(topStepHeight - deckTopY) <= lastRise / 2 + 1e-6, `[seed ${seed}] top step aligns to balcony deck height within +/- stepRise/2 (top=${topStepHeight.toFixed(3)}, deck=${deckTopY.toFixed(3)})`);
  }

  // ---- balcony ----
  {
    const deck = primitives.find(p => p.kind === 'balcony' && p.cx > 0);
    const railing = primitives.find(p => p.kind === 'railing' && p.cx > 0);
    ok(!!railing, `[seed ${seed}] a railing primitive exists`);
    ok(railing.sy >= 0.8 && railing.sy <= 1.3, `[seed ${seed}] railing height is roughly 1.0m`);

    const deckTopY = deck.cy + deck.sy / 2;
    // deck is an elevated catwalk: reachable-height, below the wall top (open roof above it)
    ok(deckTopY > 2.5 && deckTopY < wallH, `[seed ${seed}] balcony deck top is an elevated catwalk below wall height (got ${deckTopY.toFixed(3)}, wallH ${wallH.toFixed(3)})`);

    // stair climbs toward -z (last/top step has the lowest cz); deck sits just below it in z
    const topStep = stairsRight[stairsRight.length - 1];
    const stepTopZ = topStep.cz - topStep.sz / 2; // low-z edge of the top tread
    const deckX0 = deck.cx - deck.sx / 2, deckX1 = deck.cx + deck.sx / 2;
    const deckZ0 = deck.cz - deck.sz / 2, deckZ1 = deck.cz + deck.sz / 2;
    const stepX0 = topStep.cx - topStep.sx / 2, stepX1 = topStep.cx + topStep.sx / 2;
    const adjoinsZ = Math.abs(deckZ1 - stepTopZ) < 0.6;
    const overlapsX = stepX0 < deckX1 && stepX1 > deckX0;
    ok(adjoinsZ && overlapsX, `[seed ${seed}] balcony deck footprint adjoins the stair top (reachable)`);

    // railing runs along the deck's open edge (matches deck x-span, sits at one z edge)
    ok(Math.abs(railing.sx - deck.sx) < 1e-6, `[seed ${seed}] railing spans the same x-extent as the deck (open edge)`);
    const railZ = railing.cz;
    ok(Math.abs(railZ - deckZ1) < 1e-6 || Math.abs(railZ - deckZ0) < 1e-6, `[seed ${seed}] railing sits on a deck edge`);
    // deck footprint stays within the corridor half (catwalk over the corridor, not inside a room)
    ok(deckX1 <= corridorHalf + 1e-6, `[seed ${seed}] balcony deck footprint stays within the corridor lane`);
  }

  // ---- lights ----
  {
    ok(lights.length > 0, `[seed ${seed}] at least one light exists`);
    const allIn = lights.every(l =>
      l.x >= bounds.minX && l.x <= bounds.maxX &&
      l.z >= bounds.minZ && l.z <= bounds.maxZ &&
      l.y > bounds.yMin && l.y < bounds.yMax &&
      l.radius > 0);
    ok(allIn, `[seed ${seed}] all lights are within bounds, above the floor, below yMax`);

    // at least one light per room region
    const { strips: roomStrips } = roomStripsOf(primitives, bounds, corridorHalf);
    const roomLights = lights.filter(l => l.x > corridorHalf);
    const perRoom = roomStrips.every(strip => roomLights.some(l => l.z > strip.z0 && l.z < strip.z1));
    ok(perRoom, `[seed ${seed}] at least one light per room region`);
  }

  // ---- room-type variation: open / cover / pillars ----
  {
    const { strips: roomStrips } = roomStripsOf(primitives, bounds, corridorHalf);
    const cover = primitives.filter(p => p.kind === 'cover' && p.cx > corridorHalf);
    const pillars = primitives.filter(p => p.kind === 'pillar' && p.cx > corridorHalf);
    const classify = (s) => {
      if (pillars.some(p => p.cz > s.z0 && p.cz < s.z1)) return 'pillars';
      if (cover.some(c => c.cz > s.z0 && c.cz < s.z1)) return 'cover';
      return 'open';
    };
    const types = roomStrips.map(classify);
    types.forEach(t => roomTypesSeen.add(t));
    ok(types.includes('open'), `[seed ${seed}] at least one large empty (open) room`);

    // pillars are full-height square columns, clear of doors/stairs/spawn
    ok(pillars.every(p => Math.abs(p.sy - wallH) < 1e-6), `[seed ${seed}] pillars are full ceiling height`);
    ok(pillars.every(p => Math.abs(p.sx - p.sz) < 1e-6), `[seed ${seed}] pillars have a square footprint`);

    // an 'open' room is genuinely empty: no cover or pillar solids inside its strip
    const openStrips = roomStrips.filter(s => classify(s) === 'open');
    const openEmpty = openStrips.every(s =>
      !cover.some(c => c.cz > s.z0 && c.cz < s.z1) && !pillars.some(p => p.cz > s.z0 && p.cz < s.z1));
    ok(openEmpty, `[seed ${seed}] open rooms contain no cover or pillars (large empty area)`);
  }
}

// ---- variation is exercised across the seed set ----
ok(roomTypesSeen.has('open') && roomTypesSeen.has('cover') && roomTypesSeen.has('pillars'),
  `all three room types (open, cover, pillars) appear across seeds ${SEEDS.join(',')} (saw: ${[...roomTypesSeen].join(', ')})`);

process.exit(fail ? 1 : 0);
