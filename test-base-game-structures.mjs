// Node checks for base-game-structures.js: which building stands at a site, and how it is seated.
// Run: node test-base-game-structures.mjs
import { STRUCTURE_DEFAULTS, STRUCTURE_CLEAR, structureKindFor, structuresForTile, createStructureModel, structureNavRects, structureBounds, structureFloorRects, clearanceAgainstRects, structureStampPaths } from './base-game-structures.js';
import { ECO_KINDS } from './base-game-spawn-layout.js';
import { SIGHT_BLOCK_HEIGHT } from './nav-visibility.js';

let failed = 0;
const ok = (condition, message) => { if (!condition) { failed++; console.error('FAIL:', message); } };

function mockPlan({ ready = true, water = false } = {}) {
  return {
    post: 30, tileSize: 480,
    sampleAt(name, x, z) {
      if (!ready) return null;
      if (name === 'planWalk') return water ? 0 : 255 - (Math.abs(Math.round(x / 30)) + Math.abs(Math.round(z / 30))) % 30;
      return 10;
    },
  };
}
const plan = mockPlan();

// Placement
const a = structuresForTile(7, 3, -2, plan), b = structuresForTile(7, 3, -2, plan);
ok(JSON.stringify(a) === JSON.stringify(b), 'a tile\'s structure is deterministic');
ok(a.length === 1 && a[0].key === '3:-2' && ECO_KINDS.includes(a[0].kind), 'a resident dry tile yields one eco kind');
ok(a[0].kind !== 'spawn', 'the spawn-area kind is never scattered');
ok(structuresForTile(7, 0, 0, plan).length === 0, 'the origin tile is left to the spawn building');
ok(structuresForTile(7, 4, 4, mockPlan({ water: true })).length === 0, 'open water yields nothing');
ok(structuresForTile(7, 4, 4, mockPlan({ ready: false })) === null, 'a missing plan tile defers');
ok(structuresForTile(8, 3, -2, plan)[0].seed !== a[0].seed, 'the world seed changes the building seed');

// Kind mix over many tiles: every weighted kind appears, and the complex is the rare one.
const counts = {};
for (let tx = -20; tx <= 20; tx++) for (let tz = -20; tz <= 20; tz++) { const k = structureKindFor(1, tx, tz); counts[k] = (counts[k] || 0) + 1; }
ok(STRUCTURE_DEFAULTS.kinds.every(([k]) => counts[k] > 0), 'every weighted kind is placed somewhere');
ok(counts.complex < counts.atrium && counts.complex < counts.pavilion, 'the complex is rarer than the rooms');
console.log('  kind mix over 1681 tiles:', Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', '));

// Seating on sloped ground
const heightAt = (x, z) => 40 + 0.02 * x + 0.01 * z;
for (const kind of ECO_KINDS.filter((k) => k !== 'spawn')) {
  const s = { key: 'k', kind, seed: 5, x: 1000, z: -600 };
  const m = createStructureModel(s, heightAt, { seaLevel: 0 });
  const fp = m.site.footprint;
  ok(m.site.baseY > m.site.maxY && m.site.baseY <= m.site.maxY + 0.06, `${kind}: floor datum sits just above the highest ground`);
  ok(m.boxes.plinth.length > 0 && m.boxes.plinth.every((p) => p.y < m.site.minY), `${kind}: a plinth reaches below the lowest ground`);
  ok(fp.minX < 1000 && fp.maxX > 1000 && fp.minZ < -600 && fp.maxZ > -600, `${kind}: the footprint surrounds the site`);
  ok(m.spawn[1] >= m.site.baseY, `${kind}: the spawn point is on or above the datum`);
  const nav = structureNavRects(m);
  ok(nav.length > 0, `${kind}: nav rects exist`);
  ok(nav.every((r) => r.h > 0), `${kind}: nav rect heights are above the floor`);
  const tallest = Math.max(...nav.map((r) => r.h));
  ok(tallest >= SIGHT_BLOCK_HEIGHT, `${kind}: at least one rect blocks sight`);
  const overhead = m.boxes.walls.filter((r) => r.y - m.site.baseY > 0.9);
  ok(overhead.every((o) => !nav.some((r) => r.x === o.x && r.z === o.z && r.w === o.w && r.d === o.d && r.h === o.y + o.h - m.site.baseY)),
    `${kind}: slabs a bot walks under are not nav blockers`);
  const bb = structureBounds(m, 4);
  ok(bb.minX === fp.minX - 4 && bb.maxZ === fp.maxZ + 4, `${kind}: bounds carry the margin`);
}

// Cover keep-out
{
  const m = createStructureModel({ key: 'k', kind: 'lobby', seed: 3, x: 0, z: 0 }, () => 10, { seaLevel: 0 });
  const rects = structureFloorRects(m);
  ok(rects.length > 0 && rects.every((r) => r.w > 0 && r.d > 0), 'floor rects come from the slabs under the rooms');
  ok(clearanceAgainstRects(rects, 0, 0) === 0, 'clearance is zero on the floor');
  const r0 = rects[0];
  const edgeX = r0.x + r0.w / 2;
  ok(clearanceAgainstRects(rects, edgeX + STRUCTURE_CLEAR.margin * 0.5, r0.z) === 0, 'and zero within the margin of a slab edge');
  const half = clearanceAgainstRects(rects, edgeX + STRUCTURE_CLEAR.margin + STRUCTURE_CLEAR.fade / 2, r0.z);
  ok(half > 0 && half < 1 || clearanceAgainstRects(rects, edgeX + STRUCTURE_CLEAR.margin + STRUCTURE_CLEAR.fade / 2, r0.z) === 0, 'and fades past the margin (or another slab still covers)');
  ok(clearanceAgainstRects(rects, 1000, 1000) === 1, 'far away the ground is clear');
  const paths = structureStampPaths(m);
  ok(paths.length === rects.length, 'one stamp path per slab');
  // Every post within reach of a path is a post the clearance would touch, and every post the
  // clearance touches lies within reach of some path (the stamp misses nothing).
  let missed = 0, checked = 0;
  const bb = m.site.footprint;
  for (let z = bb.minZ - 12; z <= bb.maxZ + 12; z += 2) for (let x = bb.minX - 12; x <= bb.maxX + 12; x += 2) {
    if (clearanceAgainstRects(rects, x, z) >= 1) continue;
    checked++;
    const covered = paths.some(({ path: [a, b], reach }) => {
      const abx = b.x - a.x, abz = b.z - a.z, len2 = abx * abx + abz * abz || 1;
      const t = Math.max(0, Math.min(1, ((x - a.x) * abx + (z - a.z) * abz) / len2));
      return Math.hypot(x - (a.x + abx * t), z - (a.z + abz * t)) <= reach;
    });
    if (!covered) missed++;
  }
  ok(checked > 0 && missed === 0, `the stamp paths reach every post the clearance touches (${checked} posts, ${missed} missed)`);
}

console.log(`base game structures: ${failed ? `${failed} failed` : 'all pass'}`);
process.exit(failed ? 1 : 0);
