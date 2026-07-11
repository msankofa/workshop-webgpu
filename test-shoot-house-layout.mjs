import { generateShootHouse, DOOR_W } from './shoot-house-layout.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };

const CAP_DIAM = 0.6;

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

// ---- invariant suite: run for a spread of seeds so seeded topology + optional branches are exercised ----
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
for (const seed of SEEDS) {
  const house = generateShootHouse(seed);
  const { bounds, primitives, lights, spawn } = house;

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

    // straddling primitives (spine wall pieces, floor slab) appear once, not duplicated
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
      // segs: primitives running along `along` axis ('z' or 'x'); check union of [c-s/2,c+s/2] covers [axisMin,axisMax] with no gap >= DOOR_W
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

    // central spine has >= 1 opening (lintel at cx=0)
    const spineLintels = lintels.filter(l => Math.abs(l.cx) < 1e-6);
    ok(spineLintels.length >= 1, `[seed ${seed}] central spine has at least one opening connecting the halves`);
  }

  // ---- stairs ----
  // isolate one staircase: mirroring puts a second run at the same z, opposite cx
  const stairsRight = primitives.filter(p => p.kind === 'step' && p.cx > 0).sort((a, b) => a.cx - b.cx);
  {
    const steps = stairsRight;
    ok(steps.length > 0, `[seed ${seed}] stair has at least one step`);
    // treads are solid floor->top blocks; per-step rise = delta of tread-top height (cy + sy/2)
    const tops = steps.map(s => s.cy + s.sy / 2);
    const rises = tops.map((t, i) => i === 0 ? t : t - tops[i - 1]);
    ok(rises.every(r => r >= 0.12 && r <= 0.22), `[seed ${seed}] each step rise is within human range (0.12-0.22 m)`);
    const runs = steps.map(s => s.sx);
    ok(runs.every(r => r >= 0.2 && r <= 0.4), `[seed ${seed}] each step run is within human range (0.2-0.4 m)`);

    let monotonic = true;
    for (let i = 1; i < steps.length; i++) {
      if (tops[i] <= tops[i - 1] || steps[i].cx <= steps[i - 1].cx) monotonic = false;
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
    ok(Math.abs(deckTopY - 3.2) < 1e-6, `[seed ${seed}] balcony deck top sits at yDeck (3.2), got ${deckTopY.toFixed(3)}`);

    const topStep = stairsRight[stairsRight.length - 1];
    const stepEndX = topStep.cx + topStep.sx / 2;
    const deckX0 = deck.cx - deck.sx / 2, deckX1 = deck.cx + deck.sx / 2;
    const deckZ0 = deck.cz - deck.sz / 2, deckZ1 = deck.cz + deck.sz / 2;
    const stepZ0 = topStep.cz - topStep.sz / 2, stepZ1 = topStep.cz + topStep.sz / 2;
    const adjoinsX = Math.abs(deckX0 - stepEndX) < 0.5 || (stepEndX >= deckX0 - 0.5 && stepEndX <= deckX1 + 0.5);
    const overlapsZ = stepZ0 < deckZ1 && stepZ1 > deckZ0;
    ok(adjoinsX && overlapsZ, `[seed ${seed}] balcony deck footprint adjoins the stair top (reachable)`);

    // railing runs along the deck's open edge (matches deck x-span, sits at one z edge)
    ok(Math.abs(railing.sx - deck.sx) < 1e-6, `[seed ${seed}] railing spans the same x-extent as the deck (open edge)`);
    const railZ = railing.cz;
    ok(Math.abs(railZ - deckZ1) < 1e-6 || Math.abs(railZ - deckZ0) < 1e-6, `[seed ${seed}] railing sits on a deck edge`);
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
  }
}

process.exit(fail ? 1 : 0);
