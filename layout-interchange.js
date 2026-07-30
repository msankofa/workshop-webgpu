// layout-interchange.js -- pure, THREE-free layout document shared by the bot-viewer harness and
// the shoot-house map loader, so a harness-authored world loads as a shoot house (and identical
// geometry in both apps makes state-code traces diffable).
//
// ── schema `pcw-layout`, version 1 ──────────────────────────────────────────────────────────
// {
//   format: 'pcw-layout', version: 1, name?: string,
//   bounds: { minX, maxX, minZ, maxZ, yMin, yMax },
//   walls:  [ { kind:'wall', x, z, w, d, h, y } ],   // x/z = centre, w/d = FULL extents,
//   covers: [ { kind, x, z, w, d, h, y } ],          // y = base (bottom) height, h = own height
//   spawns: [ { id, role, x, y, z, heading? } ],     // role: player | bot | dummy | patrol
//   terrain: null                                    // RESERVED v1 -- see below
// }
//
// Flatness is NOT part of the format. Every rect carries its own base `y`, so a layout on sloped or
// stacked ground round-trips unchanged; shoot-house's `heightAt() === 0` is an artifact of the
// current builder, not a schema rule. `terrain` is reserved for a ground descriptor (field seed,
// heightmap ref, pads); v1 writes `null` and both apps ignore it, but it round-trips.
//
// Geometry + gameplay data only. Materials, themes and lights stay app-side: the consuming builder
// picks them (see DEFAULT_MATERIALS), the document never carries them.

export const LAYOUT_FORMAT = 'pcw-layout';
export const LAYOUT_VERSION = 1;

// Material keys the shoot-house builder buckets by. App-side dressing, overridable per call.
export const DEFAULT_MATERIALS = { wall: 'wall', cover: 'trim' };

// Mirrors nav-visibility.js's SIGHT_BLOCK_HEIGHT; duplicated so this module stays dependency-free.
export const SIGHT_BLOCK_HEIGHT = 1.5;

// Decorative boxes coincident with real geometry -- counting them would invent cover on signage.
const DECOR_KINDS = new Set(['sign', 'neon', 'grid']);
const SPAWN_ROLES = new Set(['player', 'bot', 'dummy', 'patrol']);

// Nanometre quantization: centre/extent conversion (y -> y+h/2 -> y) must land back on the same
// double, or a "lossless" round trip is only lossless by luck.
const q = (v) => (Math.abs(v) < 1e-12 ? 0 : Math.round(v * 1e9) / 1e9);
const num = (v, fallback = 0) => (Number.isFinite(v) ? q(v) : fallback);

function normalizeRect(r, defaultKind, defaultHeight) {
  return {
    kind: typeof r.kind === 'string' && r.kind ? r.kind : defaultKind,
    x: num(r.x), z: num(r.z),
    w: num(r.w), d: num(r.d),
    h: num(r.h, defaultHeight),
    y: num(r.y, 0),
  };
}

function normalizeSpawn(s, index) {
  const out = {
    id: typeof s.id === 'string' && s.id ? s.id : `spawn-${index}`,
    role: SPAWN_ROLES.has(s.role) ? s.role : 'bot',
    x: num(s.x), y: num(s.y), z: num(s.z),
  };
  if (Number.isFinite(s.heading)) out.heading = s.heading;   // an angle, not a length: no quantizing
  return out;
}

// Harness spawn globals -> the document's flat spawn list. Roles, not slots, so a third app can
// read the list without knowing what "dummy" means to the harness.
function spawnsFromHarness({ spawns, botSpawn, dummySpawn, patrolPoints }) {
  if (Array.isArray(spawns)) return spawns.map(normalizeSpawn);
  const out = [];
  if (botSpawn) out.push(normalizeSpawn({ ...botSpawn, id: 'bot', role: 'bot' }, out.length));
  if (dummySpawn) out.push(normalizeSpawn({ ...dummySpawn, id: 'dummy', role: 'dummy' }, out.length));
  for (const p of patrolPoints || []) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
    out.push(normalizeSpawn({ ...p, id: `patrol-${out.length}`, role: 'patrol' }, out.length));
  }
  return out;
}

/**
 * Normalize any harness-shaped world (or an already-normalized document) into a v1 document.
 * `wallHeight` supplies `h` for walls, which the harness keeps as a global (WALL_H) rather than
 * per-rect -- the document always states it per rect so the format never depends on that global.
 */
export function createLayout(source = {}) {
  const wallHeight = Number.isFinite(source.wallHeight) ? q(source.wallHeight) : 3;
  const walls = (source.walls || []).map((r) => normalizeRect(r, 'wall', wallHeight));
  for (const w of walls) w.kind = 'wall';   // the wall list is the wall kind, by definition
  const covers = (source.covers || []).map((r) => normalizeRect(r, 'cover', 1));
  const spawns = spawnsFromHarness(source);

  const b = source.bounds || {};
  let yMin = Number.isFinite(b.yMin) ? q(b.yMin) : 0;
  let yMax = Number.isFinite(b.yMax) ? q(b.yMax) : 0;
  if (!Number.isFinite(b.yMin) || !Number.isFinite(b.yMax)) {
    for (const r of [...walls, ...covers]) {
      if (r.y < yMin) yMin = r.y;
      if (r.y + r.h > yMax) yMax = q(r.y + r.h);
    }
  }
  const layout = {
    format: LAYOUT_FORMAT,
    version: LAYOUT_VERSION,
    bounds: { minX: num(b.minX), maxX: num(b.maxX), minZ: num(b.minZ), maxZ: num(b.maxZ), yMin, yMax },
    walls,
    covers,
    spawns,
    terrain: source.terrain ?? null,
  };
  if (source.name) layout.name = String(source.name);
  return layout;
}

/** Structural check. Returns { ok, errors, warnings } -- never throws, so a bad file reports. */
export function validateLayout(layout) {
  const errors = [];
  const warnings = [];
  if (!layout || typeof layout !== 'object') return { ok: false, errors: ['not an object'], warnings };
  if (layout.format !== LAYOUT_FORMAT) errors.push(`format must be "${LAYOUT_FORMAT}"`);
  if (layout.version !== LAYOUT_VERSION) errors.push(`unsupported version ${layout.version}`);

  const b = layout.bounds;
  if (!b || typeof b !== 'object') errors.push('missing bounds');
  else {
    for (const k of ['minX', 'maxX', 'minZ', 'maxZ', 'yMin', 'yMax']) {
      if (!Number.isFinite(b[k])) errors.push(`bounds.${k} is not finite`);
    }
    if (b.maxX <= b.minX || b.maxZ <= b.minZ) errors.push('bounds footprint is degenerate');
  }

  for (const [list, label] of [[layout.walls, 'walls'], [layout.covers, 'covers']]) {
    if (!Array.isArray(list)) { errors.push(`${label} must be an array`); continue; }
    list.forEach((r, i) => {
      if (!r || ['x', 'z', 'w', 'd', 'h', 'y'].some((k) => !Number.isFinite(r[k]))) {
        errors.push(`${label}[${i}] has a non-finite field`);
        return;
      }
      if (r.w <= 0 || r.d <= 0 || r.h <= 0) errors.push(`${label}[${i}] has a non-positive extent`);
      if (b && Number.isFinite(b.minX)
        && (r.x + r.w / 2 < b.minX || r.x - r.w / 2 > b.maxX || r.z + r.d / 2 < b.minZ || r.z - r.d / 2 > b.maxZ)) {
        warnings.push(`${label}[${i}] lies entirely outside bounds`);
      }
    });
  }

  if (!Array.isArray(layout.spawns)) errors.push('spawns must be an array');
  else layout.spawns.forEach((s, i) => {
    if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.z)) errors.push(`spawns[${i}] has a non-finite position`);
    else if (!SPAWN_ROLES.has(s.role)) warnings.push(`spawns[${i}] has unknown role "${s.role}"`);
  });

  if (layout.terrain !== null && typeof layout.terrain !== 'object') errors.push('terrain must be null or an object');
  if (!layout.walls?.length && !layout.covers?.length) warnings.push('layout has no geometry');
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * v1 document -> shoot-house generator descriptor `{ bounds, primitives, lights, spawn, spawns,
 * terrain, meta }`, i.e. exactly what shoot-house.js#createShootHouse already consumes.
 * `materials` is app-side dressing and never comes from the document.
 */
export function toShootHouseLayout(source, { materials = DEFAULT_MATERIALS } = {}) {
  const layout = source && source.format === LAYOUT_FORMAT ? source : createLayout(source);
  const primitives = [];
  const push = (r, material) => primitives.push({
    kind: r.kind,
    cx: r.x, cy: q(r.y + r.h / 2), cz: r.z,
    sx: r.w, sy: r.h, sz: r.d,
    material,
  });
  for (const r of layout.walls) push(r, materials.wall ?? DEFAULT_MATERIALS.wall);
  for (const r of layout.covers) push(r, materials.cover ?? DEFAULT_MATERIALS.cover);

  return {
    bounds: { ...layout.bounds },
    primitives,
    lights: [],                     // lighting is app-side in v1
    spawn: playerSpawn(layout.spawns),
    spawns: layout.spawns.map((s) => ({ ...s })),
    terrain: layout.terrain ?? null,
    meta: { type: 'layout', name: layout.name ?? null, source: LAYOUT_FORMAT },
  };
}

// Which authored spawn a single-spawn consumer (the FPS player) should use.
function playerSpawn(spawns) {
  const pick = spawns.find((s) => s.role === 'player') || spawns.find((s) => s.role === 'bot') || spawns[0];
  if (!pick) return { x: 0, y: 0, z: 0, heading: Math.PI };
  return { x: pick.x, y: pick.y, z: pick.z, heading: Number.isFinite(pick.heading) ? pick.heading : Math.PI };
}

/**
 * Shoot-house generator descriptor -> v1 document. Prims tagged `wall` are walls; everything else
 * is classified geometrically -- a solid, floor-reaching, sight-blocking box becomes a cover, and
 * decor / floor slabs / lintels / raised decks drop out. Mirrors the `shootHouseSightRects` filter
 * the environment viewer already applies to bake bot cover.
 */
export function fromShootHouseLayout(sh, { name } = {}) {
  const walls = [];
  const covers = [];
  for (const p of sh?.primitives || []) {
    if (!p || ![p.cx, p.cy, p.cz, p.sx, p.sy, p.sz].every(Number.isFinite)) continue;
    const rect = { kind: p.kind, x: p.cx, z: p.cz, w: p.sx, d: p.sz, h: p.sy, y: q(p.cy - p.sy / 2) };
    if (p.kind === 'wall') walls.push(rect);
    else if (p.kind === 'cover' || isSightBlocker(p)) covers.push(rect);
  }
  return createLayout({
    name: name ?? sh?.meta?.name ?? undefined,
    bounds: sh?.bounds,
    walls,
    covers,
    spawns: Array.isArray(sh?.spawns) && sh.spawns.length
      ? sh.spawns
      : (sh?.spawn ? [{ ...sh.spawn, id: 'player', role: 'player' }] : []),
    terrain: sh?.terrain ?? null,
  });
}

// Solid, floor-seated, eye-level-crossing box: the geometric definition of "this is cover".
function isSightBlocker(p) {
  if (DECOR_KINDS.has(p.kind)) return false;
  const top = p.cy + p.sy / 2;
  const bottom = p.cy - p.sy / 2;
  return top > 0.05 && bottom < SIGHT_BLOCK_HEIGHT;
}

/**
 * Layout -> nav-visibility sight rects `{x,z,w,d,h}`, where `h` is the box TOP (what buildSightGrid
 * compares against SIGHT_BLOCK_HEIGHT), so a rect lifted off the floor reads at its real height.
 */
export function sightRectsFor(source) {
  const layout = source && source.format === LAYOUT_FORMAT ? source : createLayout(source);
  return [...layout.walls, ...layout.covers]
    .map((r) => ({ x: r.x, z: r.z, w: r.w, d: r.d, h: q(r.y + r.h), kind: r.kind }));
}
