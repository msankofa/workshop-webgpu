// The terrace is the first structure made of ground rather than geometry, so the only test that
// means anything is the end-to-end one: raise the terrain, bake a real nav grid over it, and ask
// findPath to walk a bot from off-map onto the top. If the ramp is too steep the slope gate rejects
// it and there is no path; if the rim is too gentle the mesa is climbable from every side and the
// approach was pointless. Both failures are asserted.
// Run: node test-terrace.mjs
import { generateOne, generateStructures, STRUCTURE_DEFAULTS } from './bot-structures.js';
import { BOT_TERRAIN_DEFAULTS, createTerrainField } from './bot-terrain.js';
import { buildNavGrid, findPath, worldToCell, regionAt } from './nav-grid.js';

let failed = 0;
const ok = (cond, msg, detail) => {
  if (cond) { console.log(`  ok   ${msg}`); return; }
  failed++;
  console.log(`  FAIL ${msg}${detail ? `\n       ${detail}` : ''}`);
};

const BOUNDS = { minX: -30, maxX: 30, minZ: -30, maxZ: 30 };
const NAV_CELL = 0.5;

// A flat world with terrain enabled: every height in the field then comes from the pads alone, so
// anything measured below is the terrace and not the landform noise it would otherwise sit in.
const FLAT = {
  ...BOT_TERRAIN_DEFAULTS, enabled: true,
  hillAmp: 0, rippleAmp: 0, noiseAmp: 0, erosionAmp: 0, featureCount: 0,
};

function worldFor(pads, over = {}) {
  const settings = { ...FLAT, ...over };
  const field = createTerrainField(settings, pads, { bounds: BOUNDS });
  const grid = buildNavGrid(
    (x, z) => field.slopeAt(x, z, NAV_CELL * 0.5) <= settings.maxSlope,
    BOUNDS, NAV_CELL,
    { heightAt: (x, z) => field.heightAt(x, z), softBlockedTest: () => true },
  );
  return { field, grid, settings };
}

console.log('\npads raise the ground at all');
{
  const { field } = worldFor([{ x: 0, z: 0, radius: 4, y: 3, falloff: 1 }]);
  ok(Math.abs(field.heightAt(0, 0) - 3) < 0.05, `a pad with y raises the ground to it (${field.heightAt(0, 0).toFixed(2)} m)`);
  ok(Math.abs(field.heightAt(20, 20)) < 0.05, 'ground well away from the pad is untouched');
  // The property the whole route rests on: no caller had ever passed y, so this path was unexercised.
  const levelled = createTerrainField(FLAT, [{ x: 0, z: 0, radius: 4 }], { bounds: BOUNDS });
  ok(Math.abs(levelled.heightAt(0, 0)) < 0.05, 'a pad WITHOUT y still levels rather than raises');
}

console.log('\nper-pad falloff decides whether a rise is climbable');
{
  // A smoothstep rim peaks at 1.5 * rise / falloff, so the same rise is a hill or a mesa depending
  // only on the falloff it carries. Before this was per-pad, a map could hold one or the other.
  const rise = 3;
  const gentle = worldFor([{ x: 0, z: 0, radius: 4, y: rise, falloff: 9 }]);
  const steep = worldFor([{ x: 0, z: 0, radius: 4, y: rise, falloff: 1 }]);
  const rimSlope = (w) => {
    let peak = 0;
    for (let d = 4; d <= 14; d += 0.1) peak = Math.max(peak, w.field.slopeAt(d, 0, NAV_CELL * 0.5));
    return peak;
  };
  const g = rimSlope(gentle), s = rimSlope(steep);
  console.log(`       rim slope: falloff 9 -> ${g.toFixed(2)}, falloff 1 -> ${s.toFixed(2)} (nav rejects above ${FLAT.maxSlope})`);
  ok(g <= FLAT.maxSlope, 'a wide falloff gives a rim nav will walk');
  ok(s > FLAT.maxSlope, 'a tight falloff gives a rim nav refuses');
  ok(gentle.grid.cells[toKey(gentle.grid, 6, 0)] === 1, 'the gentle rim rasterizes as walkable');
  ok(steep.grid.cells[toKey(steep.grid, 4.6, 0)] === 0, 'the tight rim rasterizes as blocked');
}

function toKey(grid, x, z) {
  const c = worldToCell(grid, x, z);
  return c.r * grid.cols + c.c;
}

console.log('\nthe terrace itself: a mesa you can only reach up its ramp');
{
  let reachable = 0, guarded = 0, seeds = 0;
  for (let seed = 1; seed <= 24; seed++) {
    const t = generateOne('terrace', {}, seed);
    ok(t.walls.length === 0 && t.covers.length === 0 && t.slabs.length === 0,
      'a terrace emits no geometry at all — it is ground');
    ok(t.pads.length >= 3, 'a terrace emits a top and an approach');
    const { field, grid } = worldFor(t.pads);
    const topY = field.heightAt(0, 0);
    ok(topY > 1.2, `the top is real high ground (${topY.toFixed(2)} m)`);

    // Can a bot standing off the whole footprint walk to the summit?
    const start = { x: -t.radius - 3, z: -t.radius - 3 };
    const path = findPath(grid, start, { x: 0, z: 0 });
    const summitOnPath = path && path.some(p => field.heightAt(p.x, p.z) > topY - 0.35);
    if (path && summitOnPath) reachable++;

    // And is the rim actually doing its job? Sample the top's edge away from the ramp: most of it
    // must be blocked, or the approach is decoration.
    const top = t.pads[0];
    let edge = 0, blockedEdge = 0;
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 24) {
      const px = top.x + Math.cos(a) * (top.radius + top.falloff * 0.5);
      const pz = top.z + Math.sin(a) * (top.radius + top.falloff * 0.5);
      if (px < BOUNDS.minX + 1 || px > BOUNDS.maxX - 1 || pz < BOUNDS.minZ + 1 || pz > BOUNDS.maxZ - 1) continue;
      edge++;
      if (grid.cells[toKey(grid, px, pz)] === 0) blockedEdge++;
    }
    if (edge && blockedEdge / edge >= 0.6) guarded++;
    // The connectivity repair carves passes through ground the landforms fenced off, and a mesa
    // looks exactly like a stranding to it. Measured: it leaves a well-formed terrace alone,
    // because the ramp already connects the summit and there is nothing to repair.
    ok(grid.carved.length === 0, `the connectivity carve leaves a reachable terrace alone (${grid.carved.length} cells opened)`);
    seeds++;
  }
  console.log(`       ${reachable}/${seeds} seeds reach the summit, ${guarded}/${seeds} have a guarded rim`);
  ok(reachable === seeds, `every terrace is reachable up its ramp (${reachable}/${seeds})`);
  ok(guarded === seeds, `every terrace keeps its rim unclimbable (${guarded}/${seeds})`);
}

console.log('\nthe ramp is what makes it reachable');
{
  // Delete the approach and the summit must become unreachable. Without this the reachability test
  // above could be passing because the rim was climbable all along.
  const t = generateOne('terrace', {}, 3);
  const { grid } = worldFor([t.pads[0]]);
  const start = { x: -t.radius - 3, z: -t.radius - 3 };
  ok(regionAt(grid, start.x, start.z) !== regionAt(grid, 0, 0),
    'with the approach removed the summit is a separate region');
  ok(findPath(grid, start, { x: 0, z: 0 }) === null, 'and nothing can path onto it');
  // Not because the repair never looked: it did, failed to find a soft chain that reconnects the
  // summit, and recorded it as sealed. That is the outcome we want — a mesa is a map fact, not a bug
  // for the connector to paper over by cutting a staircase into the side.
  ok((grid.sealedRegions || []).length > 0,
    'the connectivity repair records the summit as sealed rather than carving its own way up');
}

console.log('\nscatter, and the pads reach the caller');
{
  const out = generateStructures(BOUNDS, { seed: 5, count: 3, mix: 'terraces' }, []);
  ok(out.placed.length > 0 && out.placed.every(s => s.kind === 'terrace'), "mix 'terraces' places only terraces");
  ok(out.pads.length >= out.placed.length * 3, `every terrace's pads reach the layout (${out.pads.length} pads)`);
  ok(out.pads.some(p => p.y !== undefined && p.falloff !== undefined),
    'the pads carry their own height and falloff through generateStructures');
  ok(out.walls.length === 0 && out.covers.length === 0, 'a terrace-only map emits no geometry');
  // The reported radius has to cover the ramp, or the scatter will overlap two terraces' approaches.
  for (const s of out.placed) {
    const mine = out.pads.filter(p => Math.hypot(p.x - s.x, p.z - s.z) <= s.radius + 1e-6);
    ok(mine.length >= 3, 'the reported radius encloses the whole terrace, ramp included');
  }
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('\nterrace: all assertions passed');
