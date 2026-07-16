// Validates the phase-3 room archetypes (shoot-house-rooms.js) + the Room Gallery generator.
// Each archetype composes phase-2 pieces into a designed layout; the gallery lays one of each in a row.
import { ROOM_ARCHETYPES, buildRoomContent } from './shoot-house-rooms.js';
import { generateRoomGallery, SHOOTHOUSE_TYPES } from './shoot-house-layout.js';
import { MATERIALS } from './shoot-house-style.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };

const wellFormed = (p) => p.every(b => b.sx > 0 && b.sy > 0 && b.sz > 0 && Number.isFinite(b.cx + b.cy + b.cz));
const knownMats = (p) => p.every(b => b.material in MATERIALS);
const fixedRand = () => 0.4; // deterministic: gauntlet picks n=4
const ctx = (accent = 'neon') => ({
  rect: { x0: -6, x1: 6, z0: -8, z1: 8 }, entryX: 0, H: 4.32, coverH: 1.1, accent, rand: fixedRand,
});

// ---- registry ----
ok(ROOM_ARCHETYPES.length === 5, 'ROOM_ARCHETYPES has 5 archetypes');
ok(ROOM_ARCHETYPES.every(a => a.id && a.label && a.desc), 'every archetype has id/label/desc');
ok(SHOOTHOUSE_TYPES.some(t => t.id === 'rooms'), 'SHOOTHOUSE_TYPES includes the room gallery');

// ---- every archetype composes well-formed, known-material boxes ----
for (const a of ROOM_ARCHETYPES) {
  const p = buildRoomContent(a.id, ctx());
  ok(wellFormed(p) && knownMats(p), `${a.id}: well-formed boxes, materials known to style`);
}

// ---- per-archetype composition signatures ----
{
  const g = buildRoomContent('gauntlet', ctx());
  ok(g.filter(b => b.kind === 'baffle').length === 4, 'gauntlet: 4 baffles (n from rand)');
  // baffles alternate anchor wall → their centers span both sides of the room
  const xs = g.filter(b => b.kind === 'baffle').map(b => b.cx);
  ok(Math.min(...xs) < 0 && Math.max(...xs) > 0, 'gauntlet: baffles alternate left/right (serpentine)');
}
{
  const a = buildRoomContent('atrium', ctx());
  ok(a.filter(b => b.kind === 'pillar').length === 4, 'atrium: 4-pillar cluster');
  ok(a.filter(b => b.kind === 'cover').length === 4, 'atrium: 4 radial low-cover barriers');
}
{
  const c = buildRoomContent('crossfire', ctx());
  ok(c.filter(b => b.kind === 'baffle').length === 2, 'crossfire: 2 flanking baffles');
  const zs = c.filter(b => b.kind === 'baffle').map(b => b.cz);
  ok(Math.abs(zs[0] - zs[1]) > 0.5, 'crossfire: flanking baffles are staggered in depth');
}
{
  const o = buildRoomContent('overwatch', ctx());
  ok(o.some(b => b.kind === 'platform') && o.some(b => b.kind === 'step'), 'overwatch: raised deck + ramp');
  ok(o.filter(b => b.kind === 'cover').length === 2, 'overwatch: 2 approach barriers');
}
ok(buildRoomContent('open', ctx()).length === 0, 'open: deliberately empty');
ok(buildRoomContent('nonsense', ctx()).length === 0, 'unknown archetype falls back to empty');

// ---- accent threads through to the emissive pieces ----
ok(buildRoomContent('gauntlet', ctx('neonMagenta')).some(b => b.material === 'neonMagenta'), 'accent recolors the emissive parts');

// ---- gallery generator ----
const gal = generateRoomGallery();
const { bounds, primitives, lights, spawn, meta } = gal;
ok(meta.type === 'rooms' && meta.bays === 5, 'gallery: meta type/bays');
ok(meta.order.length === 5 && meta.order[0] === ROOM_ARCHETYPES[0].id, 'gallery: meta.order matches archetype order');
ok(primitives.length > 0 && lights.length > 0, 'gallery: emits primitives + lights');
ok(bounds.maxX > bounds.minX && bounds.maxZ > bounds.minZ && bounds.yMax > 2, 'gallery: bounds non-degenerate');
const unknown = [...new Set(primitives.map(p => p.material))].filter(m => !(m in MATERIALS));
ok(unknown.length === 0, `gallery: all materials known to style (${unknown.join(',') || 'none'})`);
ok(primitives.some(p => p.material === 'grid'), 'gallery: emissive floor grid present');
ok(primitives.some(p => p.material === 'neonMagenta'), 'gallery: at least one magenta-wing bay (two-tone)');
ok(lights.some(l => /39f0ff/i.test(l.color)) && lights.some(l => /ff3df0/i.test(l.color)), 'gallery: both cyan + magenta lights');

// roof off: nothing solid above the first bay's center at wall-top height
const bx0 = bounds.minX + (bounds.maxX - bounds.minX) * 0.1;
const solidAt = (x, z, y) => primitives.some(p =>
  !['grid', 'neon', 'neonMagenta', 'sign', 'lintel'].includes(p.kind) &&
  x >= p.cx - p.sx / 2 && x <= p.cx + p.sx / 2 && y >= p.cy - p.sy / 2 && y <= p.cy + p.sy / 2 && z >= p.cz - p.sz / 2 && z <= p.cz + p.sz / 2);
ok(!solidAt(0, 0, bounds.yMax + 0.5), 'gallery: roof stays off (starfield ceiling)');

// spawn on the approach strip, inside bounds, on clear floor
ok(spawn.x > bounds.minX && spawn.x < bounds.maxX && spawn.z > bounds.minZ && spawn.z < bounds.maxZ, 'gallery: spawn inside bounds');
ok(!solidAt(spawn.x, spawn.z, 1.0), 'gallery: spawn point clear');
ok(primitives.some(p => p.material === 'deck' && p.cz - p.sz / 2 <= spawn.z && p.cz + p.sz / 2 >= spawn.z), 'gallery: floor exists under spawn');

// determinism
ok(generateRoomGallery({ seed: 7 }).primitives.length === generateRoomGallery({ seed: 7 }).primitives.length, 'gallery: deterministic for a fixed seed');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
