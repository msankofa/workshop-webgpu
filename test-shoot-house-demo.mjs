import { generateDemoRoom, SHOOTHOUSE_TYPES, DOOR_W } from './shoot-house-layout.js';
import { MATERIALS, DEFAULT_MATERIAL } from './shoot-house-style.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };

// solid test at a world point; skip elevated/decorative kinds that aren't walk-plane blockers.
function solidAt(prims, x, z, y = 1.4, skip = new Set(['lintel', 'sign', 'grid', 'neon'])) {
  for (const p of prims) {
    if (skip.has(p.kind)) continue;
    if (x >= p.cx - p.sx / 2 && x <= p.cx + p.sx / 2 &&
        y >= p.cy - p.sy / 2 && y <= p.cy + p.sy / 2 &&
        z >= p.cz - p.sz / 2 && z <= p.cz + p.sz / 2) return true;
  }
  return false;
}

// ---- types registry ----
ok(SHOOTHOUSE_TYPES.some(t => t.id === 'demo'), 'SHOOTHOUSE_TYPES includes demo');
ok(SHOOTHOUSE_TYPES.some(t => t.id === 'house'), 'SHOOTHOUSE_TYPES includes house');
ok(SHOOTHOUSE_TYPES.every(t => t.id && t.label && t.desc), 'every type has id/label/desc');

const room = generateDemoRoom();
const { bounds, primitives, lights, spawn, meta } = room;

// ---- shape ----
ok(meta.type === 'demo', 'meta.type is demo');
ok(bounds.maxX > bounds.minX && bounds.maxZ > bounds.minZ, 'bounds non-degenerate');
ok(bounds.yMax > 2, 'walls have real height');
ok(primitives.length > 0 && lights.length > 0, 'emits primitives + lights');

// ---- every material key is known to the style module (else it silently greys) ----
const unknown = [...new Set(primitives.map(p => p.material))].filter(m => !(m in MATERIALS));
ok(unknown.length === 0, `all materials known to style: ${unknown.join(',') || 'none'}`);
ok(MATERIALS !== undefined && DEFAULT_MATERIAL !== undefined, 'style exports present');

// ---- has each look feature the demo is supposed to showcase ----
ok(primitives.some(p => p.material === 'deck'), 'has floor deck');
ok(primitives.some(p => p.material === 'grid'), 'has emissive floor grid');
ok(primitives.some(p => p.material === 'panel'), 'has wall panels');
ok(primitives.some(p => p.material === 'neon'), 'has neon trim');
ok(primitives.some(p => p.material === 'cover'), 'has cover body');
ok(primitives.some(p => p.material === 'placard'), 'has signage placard');

// ---- phase-2 vocabulary showcase: one instance of each cover piece ----
ok(primitives.some(p => p.kind === 'baffle'), 'showcases a half-wall baffle');
ok(primitives.some(p => p.kind === 'pillar'), 'showcases a light-pillar');
ok(primitives.some(p => p.kind === 'platform'), 'showcases a holo-platform deck');
ok(primitives.some(p => p.kind === 'step'), 'holo-platform has an access ramp');

// ---- roof stays off (starfield visible): no primitive spans the interior at the top ----
const cx = (bounds.minX + bounds.maxX) / 2, cz = (bounds.minZ + bounds.maxZ) / 2;
ok(!solidAt(primitives, cx, cz, bounds.yMax + 0.5, new Set()), 'no roof over room center');

// ---- enclosure: the four mid-wall points are solid ----
const T = 0.3;
ok(solidAt(primitives, bounds.maxX - T / 2, cz), 'east wall solid');
ok(solidAt(primitives, bounds.minX + T / 2, cz), 'west wall solid');
ok(solidAt(primitives, cx, bounds.maxZ - T / 2), 'back wall solid');

// ---- doorway on the front (-z) wall is open at the center, walls flank it ----
const fz = bounds.minZ + T / 2;
ok(!solidAt(primitives, 0, fz, 1.0), 'front doorway open at center');
ok(solidAt(primitives, DOOR_W / 2 + 0.8, fz, 1.0), 'front wall solid right of doorway');
ok(solidAt(primitives, -(DOOR_W / 2 + 0.8), fz, 1.0), 'front wall solid left of doorway');

// ---- spawn is inside bounds and on clear floor ----
ok(spawn.x > bounds.minX && spawn.x < bounds.maxX && spawn.z > bounds.minZ && spawn.z < bounds.maxZ, 'spawn inside bounds');
ok(!solidAt(primitives, spawn.x, spawn.z, 1.0), 'spawn point clear');

// ---- lights carry neon colors, not white lamps ----
ok(lights.every(l => typeof l.color === 'string'), 'every light has a color');
ok(lights.some(l => /39f0ff/i.test(l.color)), 'at least one cyan neon light');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
