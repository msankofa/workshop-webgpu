// Node checks for base-game-structures.js: which building stands at a site, and how it is seated.
// Run: node test-base-game-structures.mjs
import { STRUCTURE_DEFAULTS, structureKindFor, structuresForTile, createStructureModel, structureNavRects, structureBounds } from './base-game-structures.js';
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

console.log(`base game structures: ${failed ? `${failed} failed` : 'all pass'}`);
process.exit(failed ? 1 : 0);
