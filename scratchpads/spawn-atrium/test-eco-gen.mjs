// node scratchpads/spawn-atrium/test-eco-gen.mjs -- every kind builds, is finite, and keeps its rooms.
import { ECO_KINDS, ECO_DEFAULTS, generateEco, soilTopAt } from './eco-gen.js';

let checks = 0, failed = 0;
function ok(cond, msg) { checks++; if (!cond) { failed++; console.log('FAIL', msg); } }

const finite = (r) => ['x', 'z', 'w', 'd', 'y', 'h'].every((k) => Number.isFinite(r[k]));
const positive = (r) => r.w > 0 && r.d > 0 && r.h > 0;
const inside = (r, x, z) => Math.abs(x - r.x) <= r.w / 2 && Math.abs(z - r.z) <= r.d / 2;
const bodyHits = (list, x, y, z) => list.some((r) => inside(r, x, z) && y > r.y + 1e-6 && y < r.y + r.h - 1e-6);

for (const kind of ECO_KINDS) {
  const g = generateEco(kind, {}, 7, { x: 10, z: -20 });
  const all = [...g.walls, ...g.covers, ...g.bars];
  ok(all.length > 8, `${kind}: emits boxes`);
  ok(all.every(finite), `${kind}: every box finite`);
  ok(all.every(positive), `${kind}: every box has positive size`);
  ok(g.planters.length > 0 || g.water.length > 0, `${kind}: has growth or water`);
  ok(g.radius > 5 && g.radius < 110, `${kind}: radius ${g.radius.toFixed(1)} in range`);
  ok(Array.isArray(g.spawn) && g.spawn.length === 3, `${kind}: has a spawn point`);
  const [sx, sy, sz] = g.spawn;
  // A body standing at the spawn must not be inside solid concrete from the knees to the head.
  for (const y of [0.4, 1.0, 1.7]) ok(!bodyHits(all, sx, sy + y, sz), `${kind}: spawn clear at +${y} m`);
  ok(all.every((r) => Math.hypot(r.x - 10, r.z + 20) <= g.radius + 1e-6), `${kind}: radius covers every box centre`);
  for (const q of g.planters) ok(q.depth > 0 && q.depth <= Math.max(q.rim, 0.35), `${kind}: planter soil ${q.depth} sits under its rim`);
}

// The composed spawn keeps its three rooms in a line north to south.
{
  const g = generateEco('spawn', {}, 1);
  const tall = g.walls.filter((r) => r.h === ECO_DEFAULTS.slotWallH && Math.min(r.w, r.d) === 0.7 && Math.max(r.w, r.d) > 10);
  ok(tall.length === 2 && tall.every((r) => r.z < -ECO_DEFAULTS.lobbyD / 2), 'spawn: slot garden walls sit north of the lobby');
  ok(g.water.some((w) => w.z > ECO_DEFAULTS.lobbyD / 2), 'spawn: the pond sits south of the lobby');
  ok(g.bars.length > 20, 'spawn: the lobby carries a lattice roof');
  const [sx, , sz] = g.spawn;
  ok(Math.abs(sx) < 1 && Math.abs(sz) < ECO_DEFAULTS.lobbyD / 2, 'spawn: the spawn point is in the lobby plaza');
  // A walk north along the walkway must pass through the lobby back wall opening.
  const wx = 0.6, backZ = -ECO_DEFAULTS.lobbyD / 2 + ECO_DEFAULTS.wallT / 2;
  ok(!bodyHits(g.walls, wx, 1.2, backZ), 'spawn: the back wall opens onto the walkway');
  const soil = g.planters.length ? soilTopAt(g.planters, g.planters[0].x, g.planters[0].z) : null;
  ok(soil != null && soil > 0, 'spawn: soilTopAt answers inside a planter');
  ok(soilTopAt(g.planters, sx, sz) == null, 'spawn: soilTopAt is null on the plaza');
}

// The complex: one building, and a body can walk every hallway from room to room.
{
  const g = generateEco('complex', {}, 1);
  const D = ECO_DEFAULTS;
  const all = [...g.walls, ...g.covers, ...g.bars];
  // Clear from the knees up, and standing on the shared floor level: no ledge at any doorway.
  const floorAt = (x, z) => Math.max(-1, ...all.filter((r) => inside(r, x, z) && r.y + r.h <= 0.7).map((r) => r.y + r.h));
  const clearAt = (x, z, label) => {
    for (const y of [0.6, 1.2, 1.7]) ok(!bodyHits(all, x, y, z), `complex: ${label} clear at +${y}`);
    const f = floorAt(x, z);
    const sunken = label === 'pavilion door' || label === 'plaza';
    ok(sunken || Math.abs(f - D.lobbyFloor) < 1e-6, `complex: ${label} floor at ${f.toFixed(2)}, wanted ${D.lobbyFloor}`);
  };
  clearAt(0.6, g.spawn[2], 'plaza');
  const z0 = -D.lobbyD / 2, x1 = D.lobbyW / 2;
  const atriumCz = z0 + 0.2 - D.hallNorth - (D.atriumWell + 2 * D.atriumRing) / 2;
  // North: plaza, back wall opening, up the hallway walkway (top 0.45), atrium south wall opening, atrium centre.
  for (const z of [z0 + 2, z0 + D.wallT / 2, z0 - 3, z0 - D.hallNorth / 2, z0 - D.hallNorth + 1, atriumCz + (D.atriumWell + 2 * D.atriumRing) / 2 - 0.25, atriumCz]) {
    clearAt(0.6, z, `north walk at z ${z.toFixed(1)}`);
  }
  // East: lobby east wall opening, along the hallway walkway, into the pergola court through its door.
  const walkZ = 2, pcx = x1 - 0.2 + D.hallEast + 12.3;
  for (const x of [x1 - D.wallT / 2, x1 + 3, x1 + D.hallEast / 2, x1 + D.hallEast - 1, pcx - 12, pcx - 6]) {
    clearAt(x, walkZ, `east walk at x ${x.toFixed(1)}`);
  }
  // South: through the pavilion back wall onto the deck.
  clearAt(0, D.lobbyD / 2, 'pavilion door');
  const tall = g.walls.filter((r) => r.h === D.slotWallH && Math.min(r.w, r.d) === 0.7 && Math.max(r.w, r.d) > 10);
  ok(tall.length === 4, `complex: two hallways make four tall walls (got ${tall.length})`);
  ok(tall.some((r) => r.w > r.d) && tall.some((r) => r.d > r.w), 'complex: one hallway runs each way');
  ok(g.radius > 50 && g.radius < 110, `complex: radius ${g.radius.toFixed(1)}`);
  ok(g.water.length >= 4, 'complex: both hallways and both courts carry water');
}

// Lobby beams keep walking headroom and the stair tops out at the mezzanine.
{
  const g = generateEco('lobby', {}, 3);
  const F = ECO_DEFAULTS.lobbyFloor;
  const beams = g.walls.filter((r) => r.h === 0.55);
  ok(beams.length > 10 && beams.every((r) => r.y - F > 2.2), 'lobby: beams clear a standing body');
  const steps = g.covers.filter((r) => r.w === 3.2 && r.d === 0.3);
  ok(steps.length === 24, `lobby: 24 stair blocks (got ${steps.length})`);
  const topStep = steps.reduce((a, b) => (a.h > b.h ? a : b));
  const mezz = g.walls.find((r) => r.y === ECO_DEFAULTS.lobbyMezz && r.h === 0.35);
  ok(mezz && Math.abs(topStep.y + topStep.h - (mezz.y + mezz.h)) < 1e-6, 'lobby: the stair meets the mezzanine top');
  ok(mezz && Math.abs(topStep.z - 0.15 - (mezz.z + mezz.d / 2)) < 1e-6, 'lobby: the top step touches the mezzanine edge');
  // Every step is one riser above the one before it, south to north, landing included.
  const run = [...steps, ...g.covers.filter((r) => r.w === 3.2 && r.d === 1.6)].sort((a, b) => b.z - a.z);
  ok(run.every((r, i) => i === 0 || r.h > run[i - 1].h - 1e-9), 'lobby: the stair rises monotonically toward the mezzanine');
  ok(mezz.y >= ECO_DEFAULTS.doorH, 'lobby: the back doorway passes under the mezzanine');
  // The rail leaves the stair head open: a body on the top step walks straight onto the mezzanine.
  const all = [...g.walls, ...g.covers];
  for (const y of [0.3, 1.0, 1.6]) ok(!bodyHits(all, topStep.x, mezz.y + mezz.h + y, mezz.z + mezz.d / 2), `lobby: stair head open at +${y}`);
  ok(g.walls.some((r) => r.h === 0.12 && Math.abs(r.z - (mezz.z + mezz.d / 2)) < 1e-6), 'lobby: the rail still exists beside the stair');
}

// Determinism: same seed, same output.
{
  const a = JSON.stringify(generateEco('pergola', {}, 11));
  const b = JSON.stringify(generateEco('pergola', {}, 11));
  ok(a === b, 'pergola: deterministic for a seed');
}

console.log(`${checks - failed}/${checks} checks passed`);
process.exit(failed ? 1 : 0);
