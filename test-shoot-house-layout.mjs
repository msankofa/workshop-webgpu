import { generateShootHouse, DOOR_W, SIZE_PRESETS } from './shoot-house-layout.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };

const CAP_DIAM = 0.6;

// ---- solidAt(x,z) sampled at world height y; excludes elevated/opening/sign primitives by default ----
function solidAt(prims, x, z, y = 1.5, opts = {}) {
  const skipKinds = opts.includeAll
    ? new Set()
    : new Set(['lintel', 'railing', 'step', 'balcony', 'mezzanine', 'mezzStep', 'sign']);
  for (const p of prims) {
    if (skipKinds.has(p.kind)) continue;
    const x0 = p.cx - p.sx / 2, x1 = p.cx + p.sx / 2;
    const y0 = p.cy - p.sy / 2, y1 = p.cy + p.sy / 2;
    const z0 = p.cz - p.sz / 2, z1 = p.cz + p.sz / 2;
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1) return true;
  }
  return false;
}

// structural walk-plane blockers only (walls, pillars, shelving) — clutter/steps are routed around.
function isBlocker(p) {
  return p.kind === 'perimeter'
    || (p.kind === 'interior' && p.material === 'wall')
    || p.kind === 'pillar'
    || p.kind === 'shelf';
}
// 4-connected flood fill on a 0.4 m grid; returns a set of reachable cell keys.
function floodReachable(prims, bounds, from) {
  const cell = 0.4;
  const nx = Math.ceil((bounds.maxX - bounds.minX) / cell);
  const nz = Math.ceil((bounds.maxZ - bounds.minZ) / cell);
  const blockers = prims.filter(isBlocker);
  const key = (i, j) => i + ',' + j;
  const cellSolid = (i, j) => {
    const x = bounds.minX + (i + 0.5) * cell, z = bounds.minZ + (j + 0.5) * cell;
    for (const p of blockers) {
      if (x >= p.cx - p.sx / 2 && x <= p.cx + p.sx / 2 && z >= p.cz - p.sz / 2 && z <= p.cz + p.sz / 2) return true;
    }
    return false;
  };
  const toCell = (x, z) => [Math.floor((x - bounds.minX) / cell), Math.floor((z - bounds.minZ) / cell)];
  const [si, sj] = toCell(from.x, from.z);
  const seen = new Set([key(si, sj)]);
  const stack = [[si, sj]];
  while (stack.length) {
    const [i, j] = stack.pop();
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= nz) continue;
      const k = key(ni, nj);
      if (seen.has(k) || cellSolid(ni, nj)) continue;
      seen.add(k);
      stack.push([ni, nj]);
    }
  }
  return { seen, toCell, key };
}

// ---- determinism + presets ----
{
  const a = generateShootHouse(1);
  const b = generateShootHouse(1);
  ok(JSON.stringify(a) === JSON.stringify(b), 'same seed -> deep-equal descriptor');
  ok(JSON.stringify(a) !== JSON.stringify(generateShootHouse(2)), 'different seed -> different descriptor');
  const d = generateShootHouse(1, { size: 'compact' });
  ok(JSON.stringify(a) !== JSON.stringify(d), 'different size opt -> different descriptor');
  ok(JSON.stringify(d) === JSON.stringify(generateShootHouse(1, { size: 'compact' })), 'same seed+opts -> deep-equal');
  ok(generateShootHouse(1, { size: 'sprawl' }).meta.L === SIZE_PRESETS.sprawl.L, 'size preset drives footprint L');
  ok(JSON.stringify(generateShootHouse(1, { difficulty: 'hard' })) !== JSON.stringify(generateShootHouse(1, { difficulty: 'easy' })),
    'difficulty opt changes the layout');
  // symmetric option restores mirror symmetry
  const sym = generateShootHouse(3, { symmetric: true });
  const ch = sym.meta.corridorHalf;
  // only side-room content (|cx| > corridorHalf) is mirrored; corridor/stairs are single-sided by design
  const symMirror = sym.primitives.filter(p => p.cx > ch + 0.1).every(p =>
    sym.primitives.some(q => Math.abs(q.cx + p.cx) < 1e-6 && q.kind === p.kind && q.material === p.material &&
      Math.abs(q.cz - p.cz) < 1e-6 && Math.abs(q.sy - p.sy) < 1e-6));
  ok(symMirror, 'symmetric:true -> every side-room cx>0 primitive has a cx-> -cx twin');
}

// ---- invariant suite across a spread of seeds ----
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
const typesSeen = new Set();
let asymmetrySeen = false;
let mezzSeen = false;

for (const seed of SEEDS) {
  const house = generateShootHouse(seed);
  const { bounds, primitives, lights, spawn, meta } = house;
  const corridorHalf = meta.corridorHalf;
  const wallH = primitives.find(p => p.kind === 'perimeter').sy;

  // ---- bounds ----
  {
    ok(bounds.minX === -bounds.maxX, `[seed ${seed}] bounds symmetric about x=0`);
    ok(bounds.maxX > 0 && bounds.maxZ > bounds.minZ && bounds.yMax > bounds.yMin, `[seed ${seed}] bounds well-formed`);
    const eps = 1e-6;
    const within = primitives.every(p =>
      p.cx - p.sx / 2 >= bounds.minX - eps && p.cx + p.sx / 2 <= bounds.maxX + eps &&
      p.cz - p.sz / 2 >= bounds.minZ - eps && p.cz + p.sz / 2 <= bounds.maxZ + eps &&
      p.cy + p.sy / 2 <= bounds.yMax + eps && p.cy - p.sy / 2 >= bounds.yMin - eps);
    ok(within, `[seed ${seed}] all primitives lie within bounds on all six faces`);
  }

  // ---- asymmetry: left and right differ somewhere (functional check over sampled grid) ----
  {
    let differs = false;
    for (let x = 0.5; x <= bounds.maxX && !differs; x += 0.6)
      for (let z = bounds.minZ + 0.5; z <= bounds.maxZ; z += 0.6)
        if (solidAt(primitives, x, z) !== solidAt(primitives, -x, z)) { differs = true; break; }
    if (differs) asymmetrySeen = true;
  }

  // ---- enclosure ----
  {
    const perim = primitives.filter(p => p.kind === 'perimeter');
    ok(perim.every(p => p.material === 'wall'), `[seed ${seed}] perimeter primitives are wall material`);
    const east = perim.filter(p => Math.abs((p.cx + p.sx / 2) - bounds.maxX) < 0.2);
    const west = perim.filter(p => Math.abs((p.cx - p.sx / 2) - bounds.minX) < 0.2);
    const north = perim.filter(p => Math.abs((p.cz + p.sz / 2) - bounds.maxZ) < 0.2);
    const south = perim.filter(p => Math.abs((p.cz - p.sz / 2) - bounds.minZ) < 0.2);
    ok(east.length && west.length && north.length && south.length, `[seed ${seed}] perimeter on all four boundary lines`);
    const coverage = (segs, min, max, along) => {
      const spans = segs.map(p => {
        const c = along === 'z' ? p.cz : p.cx, s = along === 'z' ? p.sz : p.sx;
        return [c - s / 2, c + s / 2];
      }).sort((a, b) => a[0] - b[0]);
      let cursor = min, maxGap = 0;
      for (const [a, b] of spans) { maxGap = Math.max(maxGap, a - cursor); cursor = Math.max(cursor, b); }
      return Math.max(maxGap, max - cursor);
    };
    ok(coverage(east, bounds.minZ, bounds.maxZ, 'z') < CAP_DIAM, `[seed ${seed}] east perimeter has no player-sized gap`);
    ok(coverage(west, bounds.minZ, bounds.maxZ, 'z') < CAP_DIAM, `[seed ${seed}] west perimeter has no player-sized gap`);
    ok(coverage(north, bounds.minX, bounds.maxX, 'x') < CAP_DIAM, `[seed ${seed}] north perimeter has no player-sized gap`);
    ok(coverage(south, bounds.minX, bounds.maxX, 'x') < CAP_DIAM, `[seed ${seed}] south perimeter has no player-sized gap`);
    const lintels = primitives.filter(p => p.kind === 'lintel');
    const onPerim = lintels.some(l =>
      Math.abs(l.cx - bounds.maxX) < 1e-6 || Math.abs(l.cx - bounds.minX) < 1e-6 ||
      Math.abs(l.cz - bounds.maxZ) < 1e-6 || Math.abs(l.cz - bounds.minZ) < 1e-6);
    ok(!onPerim, `[seed ${seed}] perimeter has no door openings`);
  }

  // ---- doorways ----
  {
    const lintels = primitives.filter(p => p.kind === 'lintel');
    ok(lintels.length > 0, `[seed ${seed}] at least one door opening exists`);
    const widths = lintels.map(l => Math.max(l.sx, l.sz));
    ok(widths.every(w => w >= DOOR_W - 1e-6), `[seed ${seed}] every door opening width >= DOOR_W (${DOOR_W})`);
  }

  // ---- spawn (in the entry vestibule near minZ) ----
  {
    const clearAt = y => [[0, 0], [0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]].every(([dx, dz]) =>
      !solidAt(primitives, spawn.x + dx, spawn.z + dz, y, { includeAll: true }));
    ok(clearAt(1.0), `[seed ${seed}] spawn cell clear at y=1.0`);
    ok(clearAt(0.4), `[seed ${seed}] spawn cell clear at y=0.4 (catches short solids)`);
    ok(spawn.y === 0, `[seed ${seed}] spawn.y on the floor`);
    ok(spawn.x === 0, `[seed ${seed}] spawn on the central corridor (x=0)`);
    ok(spawn.z > bounds.minZ && spawn.z < meta.vestZ, `[seed ${seed}] spawn sits inside the entry vestibule`);
  }

  // ---- reachability: corridor + every side room enterable from spawn (flood fill over walls) ----
  {
    const { seen, toCell, key } = floodReachable(primitives, bounds, spawn);
    const reach = (x, z) => { const [i, j] = toCell(x, z); return seen.has(key(i, j)); };
    ok(reach(0, meta.vestZ + 2), `[seed ${seed}] corridor reachable through the vestibule door`);
    let allRooms = true;
    for (const s of [meta.right, meta.left]) {
      for (const dz of s.spineDoorZ) if (!reach(s.spineX + Math.sign(s.spineX) * 1.0, dz)) allRooms = false;
    }
    ok(allRooms, `[seed ${seed}] every side room is enterable from spawn`);
  }

  // ---- openness: 3–6 rooms per side, each large ----
  {
    for (const [name, s] of [['right', meta.right], ['left', meta.left]]) {
      ok(s.roomCount >= 3 && s.roomCount <= 6, `[seed ${seed}] ${name} side has 3–6 rooms (got ${s.roomCount})`);
      const roomDepthX = bounds.maxX - corridorHalf;
      for (const [i, strip] of s.strips.entries()) {
        const zExtent = strip.z1 - strip.z0;
        ok(zExtent >= 15, `[seed ${seed}] ${name} room ${i} z-extent large (got ${zExtent.toFixed(1)})`);
        ok(zExtent * roomDepthX >= 15 * 15, `[seed ${seed}] ${name} room ${i} floor area large, not a cubicle`);
      }
    }
  }

  // ---- cover: chest-high, longer than thick ----
  {
    const cover = primitives.filter(p => p.kind === 'cover');
    ok(cover.length > 0, `[seed ${seed}] at least one cover piece exists`);
    ok(cover.every(c => c.material === 'trim'), `[seed ${seed}] cover is trim material`);
    ok(cover.every(c => c.sy >= 0.9 && c.sy <= 1.3), `[seed ${seed}] cover height in [0.9, 1.3]`);
    ok(cover.every(c => Math.max(c.sx, c.sz) >= Math.min(c.sx, c.sz) * 2 - 1e-6), `[seed ${seed}] cover pieces are low walls (long axis >= 2x thickness)`);
  }

  // ---- staircases (1 or 2): each cluster rises/runs in human range, monotonic, aligned to a deck ----
  {
    const steps = primitives.filter(p => p.kind === 'step');
    ok(steps.length > 0, `[seed ${seed}] at least one staircase exists`);
    // cluster steps by z-gap (each staircase is a contiguous z run)
    const sorted = [...steps].sort((a, b) => a.cz - b.cz);
    const clusters = [];
    let cur = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].cz - sorted[i - 1].cz > 1.0) { clusters.push(cur); cur = []; }
      cur.push(sorted[i]);
    }
    clusters.push(cur);
    const decks = primitives.filter(p => p.kind === 'balcony');
    for (const [ci, cl] of clusters.entries()) {
      const byHeight = [...cl].sort((a, b) => (a.cy + a.sy / 2) - (b.cy + b.sy / 2));
      const tops = byHeight.map(s => s.cy + s.sy / 2);
      const rises = tops.map((t, i) => i === 0 ? t : t - tops[i - 1]);
      ok(rises.every(r => r >= 0.12 && r <= 0.22), `[seed ${seed}] stair ${ci} rises in human range`);
      ok(byHeight.every(s => s.sz >= 0.2 && s.sz <= 0.4), `[seed ${seed}] stair ${ci} runs in human range`);
      ok(rises.slice(1).every(r => r > 0), `[seed ${seed}] stair ${ci} ascends monotonically`);
      const topY = tops[tops.length - 1];
      const near = decks.some(d => Math.abs((d.cy + d.sy / 2) - topY) <= 0.12);
      ok(near, `[seed ${seed}] stair ${ci} top aligns to a balcony deck height`);
    }
  }

  // ---- balcony catwalk(s) ----
  {
    const decks = primitives.filter(p => p.kind === 'balcony');
    const rails = primitives.filter(p => p.kind === 'railing');
    ok(decks.length > 0 && rails.length > 0, `[seed ${seed}] balcony deck + railing exist`);
    for (const deck of decks) {
      const deckTopY = deck.cy + deck.sy / 2;
      ok(deckTopY > 2.5 && deckTopY < wallH, `[seed ${seed}] balcony deck is an elevated catwalk below wall height`);
      ok(Math.abs(deck.cx) <= corridorHalf + 1e-6, `[seed ${seed}] balcony deck stays within the corridor lane`);
    }
  }

  // ---- lights ----
  {
    ok(lights.length > 0, `[seed ${seed}] at least one light exists`);
    ok(lights.every(l => l.x >= bounds.minX && l.x <= bounds.maxX && l.z >= bounds.minZ && l.z <= bounds.maxZ &&
      l.y > bounds.yMin && l.y < bounds.yMax && l.radius > 0), `[seed ${seed}] all lights within bounds, above floor`);
    ok(lights.every(l => typeof l.color === 'string' && l.color[0] === '#'), `[seed ${seed}] every light carries a color tint`);
    ok(lights.some(l => Math.abs(l.x) <= 1e-9), `[seed ${seed}] corridor lights straddle x=0`);
    // every side room has a light in its z-range on its side
    let perRoom = true;
    for (const s of [meta.right, meta.left]) {
      for (const strip of s.strips) {
        if (!lights.some(l => Math.sign(l.x) === Math.sign(s.spineX) && l.z > strip.z0 && l.z < strip.z1)) perRoom = false;
      }
    }
    ok(perRoom, `[seed ${seed}] every side room has at least one light`);
  }

  // ---- room-type variation + open-room emptiness ----
  {
    // side-room content only (|cx| > corridorHalf) — corridor cover/pillars are excluded
    const side = arr => arr.filter(p => Math.abs(p.cx) > corridorHalf);
    const cover = side(primitives.filter(p => p.kind === 'cover'));
    const pillars = primitives.filter(p => p.kind === 'pillar');
    const sidePillars = side(pillars);
    const shelves = side(primitives.filter(p => p.kind === 'shelf'));
    const crates = side(primitives.filter(p => p.kind === 'crate'));
    for (const s of [meta.right, meta.left]) {
      const sideSign = Math.sign(s.spineX);
      s.strips.forEach((strip, i) => {
        const inStrip = arr => arr.some(p => Math.sign(p.cx) === sideSign && p.cz > strip.z0 && p.cz < strip.z1);
        let t = 'open';
        if (inStrip(sidePillars)) t = 'pillars';
        else if (inStrip(shelves)) t = 'shelving';
        else if (inStrip(crates)) t = 'crates';
        else if (inStrip(cover)) t = 'cover';
        typesSeen.add(t);
        const declared = s.types[i];
        if (declared.includes('mezz')) mezzSeen = true;
        // a plain 'open' room (no mezz) must be genuinely empty
        if (declared === 'open') {
          const empty = !inStrip(cover) && !inStrip(sidePillars) && !inStrip(shelves) && !inStrip(crates);
          ok(empty, `[seed ${seed}] declared-open room contains no cover/pillars/shelves/crates`);
        }
      });
    }
    ok(pillars.every(p => Math.abs(p.sy - wallH) < 1e-6), `[seed ${seed}] pillars are full ceiling height`);
    ok(pillars.every(p => Math.abs(p.sx - p.sz) < 1e-6), `[seed ${seed}] pillars have a square footprint`);
  }

  // ---- signage ----
  {
    const exit = primitives.filter(p => p.material === 'exit');
    const hazard = primitives.filter(p => p.material === 'hazard');
    const roomTotal = meta.right.roomCount + meta.left.roomCount;
    ok(exit.length >= roomTotal, `[seed ${seed}] an exit sign above every spine doorway (got ${exit.length} for ${roomTotal} rooms)`);
    ok(exit.every(s => s.kind === 'sign'), `[seed ${seed}] exit signs are 'sign' kind`);
    ok(hazard.length > 0, `[seed ${seed}] at least one hazard sign at a stair foot`);
  }

  // ---- mezzanine (when present): elevated, walkable, railed, with access steps ----
  {
    const mezz = primitives.filter(p => p.kind === 'mezzanine');
    for (const m of mezz) {
      const topY = m.cy + m.sy / 2;
      ok(topY > 1.2 && topY < wallH, `[seed ${seed}] mezzanine deck elevated below wall height (got ${topY.toFixed(2)})`);
      const nearSteps = primitives.some(p => p.kind === 'mezzStep' && Math.abs(p.cz - m.cz) < m.sz / 2 + 1);
      ok(nearSteps, `[seed ${seed}] mezzanine has adjacent access steps`);
    }
  }
}

ok(asymmetrySeen, `asymmetry present: left != right for at least one seed in ${SEEDS.join(',')}`);
ok(typesSeen.has('open') && typesSeen.size >= 4,
  `room-type variety across seeds (saw: ${[...typesSeen].sort().join(', ')})`);
ok(mezzSeen, `at least one mezzanine appears across seeds ${SEEDS.join(',')}`);

process.exit(fail ? 1 : 0);
