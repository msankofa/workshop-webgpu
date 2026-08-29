// NPC bots for Base Game rooms: bot-viewer-v3's brain (bot-brain.js) driving socketless roster
// clients. One brain per room; every sim tick it is synced from the room's bodies, thinks at
// 60 Hz, and each NPC's intent (velocity, yaw, pitch, stance, fire, reload) becomes one ordinary
// tick input that the room's consumeTick runs exactly as it would a player's. Players appear to
// the brain as `worldEntities` on their team; hits reach it through `damaged`. Plan:
// docs/superpowers/plans/2026-08-27-base-game-npc-bots.md (slice 2).
import { createBotBrain, createBrainBot, Vec3 } from '../bot-brain.js';
import { finalizeNavGrid } from '../nav-grid.js';
import { buildSightGrid, buildLazyVisibilityField } from '../nav-visibility.js';
import { buildCornerMap } from '../nav-corners.js';
import { getRole } from '../bot-roles.js';
import { STANCE_CROUCH, STANCE_KNEEL, STANCE_PRONE, STANCE_RUN, STANCE_DASH } from '../bot-stance.js';
import { BOT_AIM, BOT_FIRE } from '../bot-activity.js';
import { botSeedFromId } from '../bot-activity.js';
import { mulberry32, hashSeed } from '../biome-classifier-js.js';
import { BASE_GAME_TEAMS, BASE_GAME_APPEARANCE, stanceIndex } from '../base-game-protocol.mjs';

export const NPC_WALK_SPEED = 2.4;           // bot-viewer-v3 BOT_MOVE_SPEED
export const NPC_RUN_MULTIPLIER = 1.7;       // v3 botMovementSettings.runMultiplier default
export const NPC_THINK_HZ = 60;              // the harness thinks per frame; the room sims at 120
export const NPC_ZONE_SPAN = 384;            // m, the env-viewer zone bake (65k cells at 1.5 m)
export const NPC_ZONE_CELL = 1.5;
export const NPC_ZONE_REBAKE_DRIFT = 96;     // m the players' centroid moves before a rebake
export const NPC_MAX_SLOPE = 1.3;            // rise per NPC_ZONE_CELL that is still walkable (~41 deg; the controller climbs 50)
export const NPC_CREST = { minRise: 0.6, maxSpan: 4.5 / NPC_ZONE_CELL, farCells: 24 / NPC_ZONE_CELL, spacingCells: 4 / NPC_ZONE_CELL, stride: 1 };
export const NPC_SPAWN_TRIES = 24;
export const NPC_PATROL_RING_POINTS = 8;
export const NPC_PATROL_RING_RADIUS = 40;    // m around the zone centre
export const NPC_BAKE_BUDGET_MS = 2;         // of each think spent sampling a zone bake

const TEAM_NAME = { [BASE_GAME_TEAMS.friendly]: 'alpha', [BASE_GAME_TEAMS.enemy]: 'bravo' };
export const teamNameFor = (team) => TEAM_NAME[team] ?? `team${team}`;

// Bot-viewer yaw has +Z forward (atan2(dx, dz)); the player controller's forward is -Z rotated by
// yaw. The rig already adds PI when it draws a bot; so does the wire.
export const controllerYawFromBot = (yaw) => yaw + Math.PI;
export const botYawFromController = (yaw) => yaw - Math.PI;

// World velocity -> the controller's body-frame move axes at a given controller yaw. The input
// rotation is its own inverse (symmetric matrix), so this is the same product as fixedStep's.
export function moveAxesFor(vx, vz, controllerYaw, walkSpeed, out = { moveX: 0, moveZ: 0, sprint: false }) {
  const speed = Math.hypot(vx, vz);
  if (speed < 1e-4) { out.moveX = 0; out.moveZ = 0; out.sprint = false; return out; }
  const s = Math.sin(controllerYaw), c = Math.cos(controllerYaw);
  const scale = Math.min(1, speed / walkSpeed) / speed;
  out.moveX = (c * vx - s * vz) * scale;
  out.moveZ = (-s * vx - c * vz) * scale;
  out.sprint = speed > walkSpeed * 1.05;
  return out;
}

export function stanceIndexFor(actor) {
  const st = actor?.stance;
  if (st === STANCE_CROUCH) return stanceIndex('crouch');
  if (st === STANCE_KNEEL) return stanceIndex('kneel');
  if (st === STANCE_PRONE) return stanceIndex('prone');
  return stanceIndex('stand');
}

// A deterministic face per NPC from its id: skin, hair, expression.
export function appearanceFor(id) {
  const rng = mulberry32(hashSeed(botSeedFromId(id), 7));
  const pick = (list) => list[Math.floor(rng() * list.length) % list.length];
  return { skin: pick(BASE_GAME_APPEARANCE.skin), hair: pick(BASE_GAME_APPEARANCE.hair), expression: pick(['neutral', 'determined', 'determined', 'angry']) };
}

// Ground and slope from the room's source. Slope is rise per metre over the nav cell.
function terrainFieldFor(heightAt) {
  const slopeAt = (x, z, r = NPC_ZONE_CELL * 0.5) => {
    const dx = heightAt(x + r, z) - heightAt(x - r, z), dz = heightAt(x, z + r) - heightAt(x, z - r);
    return Math.hypot(dx, dz) / (2 * r) * NPC_ZONE_CELL;   // rise over one cell, v3's unit
  };
  return { heightAt, slopeAt, gradientAt: (x, z, r = 0.75) => ({ dx: (heightAt(x + r, z) - heightAt(x - r, z)) / (2 * r), dz: (heightAt(x, z + r) - heightAt(x, z - r)) / (2 * r) }) };
}

// Rejection sampler around a point: dry, walkable slope, not on top of a body.
export function findNpcSpawn({ near, spread = 6, heightAt, seaLevel = -Infinity, bodies = [], rng = Math.random, tries = NPC_SPAWN_TRIES }) {
  const field = terrainFieldFor(heightAt);
  let best = null;
  for (let i = 0; i < tries; i++) {
    const a = rng() * Math.PI * 2, d = i === 0 ? 0 : Math.sqrt(rng()) * spread;
    const x = near[0] + Math.cos(a) * d, z = near[2] + Math.sin(a) * d;
    const y = heightAt(x, z);
    if (y <= seaLevel + 0.2) continue;
    if (field.slopeAt(x, z) > NPC_MAX_SLOPE) continue;
    if (bodies.some(p => Math.hypot(p[0] - x, p[2] - z) < 1.2)) continue;
    return [x, y, z];
  }
  return best ?? [near[0], heightAt(near[0], near[2]), near[2]];
}

export function createRoomNpcs({ room, heightAt: rawHeightAt, raycast: rawRaycast, seaLevel = () => -Infinity, roomMs, log = null }) {
  // Cost accounting for the N1 gate: ms and counts per second, read by bench-base-game-npcs.mjs.
  const stats = { thinkMs: 0, syncMs: 0, thinks: 0, raycasts: 0, raycastMs: 0, bakes: 0, bakeMs: 0, inputMs: 0, heights: 0, heightMs: 0, vis: 0, visMs: 0, paths: 0, pathMs: 0 };
  const heightAt = (x, z) => { const t = performance.now(); stats.heights++; const h = rawHeightAt(x, z); stats.heightMs += performance.now() - t; return h; };
  const raycast = (o, d, r) => { const t = performance.now(); stats.raycasts++; const h = rawRaycast(o, d, r); stats.raycastMs += performance.now() - t; return h; };
  const brain = createBotBrain({
    world: { heightAt, raycast },
    hooks: {
      fireBotShot(origin, now) {
        const { bot, target } = brain.bound();
        const rec = byEntityId.get(bot.id);
        if (!rec) return false;
        rec.fire = true;                    // consumed by the next tick input
        rec.fireTarget = target?.id ?? null;
        const ammo = brain.ammoFor(bot);
        if (ammo.mag <= 0) return false;
        ammo.mag -= 1;                      // the room store is mirrored back after the tick
        return true;
      },
      died(target, actor, now) { log?.('npc died', target.id, 'at', now); },
    },
    settings: {
      mapCollider: { raycast },
      terrainField: terrainFieldFor(heightAt),
      terrainSettings: { enabled: true, maxSlope: NPC_MAX_SLOPE },
      patrolPoints: [],
      dummyTargets: [],
    },
  });
  const byEntityId = new Map();   // entity id -> { client, entity, actor, fire, fireTarget, lastReloadUntil }
  const worldEntities = new Map(); // player client id -> plain entity the brain can target
  let zone = null;                 // { cx, cz, bounds }
  let thinkAcc = 0;
  let nextId = 1;

  // ---- the zone grid: 384 m around the players' centroid, heightfield walkability only --------
  function playersCentroid() {
    let n = 0, x = 0, z = 0;
    for (const c of room.clients.values()) {
      if (c.npc || !c.controller || !room.combat.getSnapshot(c.id).alive) continue;
      const p = c.controller.getPosition(); x += p[0]; z += p[2]; n++;
    }
    if (!n) for (const rec of byEntityId.values()) { const p = rec.client.controller?.getPosition(); if (p) { x += p[0]; z += p[2]; n++; } }
    return n ? [x / n, z / n] : null;
  }
  // The bake is sliced across ticks (NPC_BAKE_BUDGET_MS per think) because on a v5 world one
  // heightAt is a noise stack and a whole zone is ~800 ms: done in one tick it stalls the room and
  // the quarter-second catch-up cap drops time for everyone. Each cell is sampled once; walkability
  // is the rise to its neighbours in the sampled heights, so no extra samples per cell. The old
  // zone stays live until the new one is finished.
  let job = null;
  function startBake(cx, cz) {
    const half = NPC_ZONE_SPAN / 2;
    const bounds = { minX: cx - half, maxX: cx + half, minZ: cz - half, maxZ: cz + half };
    const cols = Math.ceil(NPC_ZONE_SPAN / NPC_ZONE_CELL), rows = cols;
    job = { cx, cz, bounds, cols, rows, cell: NPC_ZONE_CELL, heights: new Float32Array(cols * rows), cells: new Uint8Array(cols * rows), soft: new Uint8Array(cols * rows), row: 0, phase: 'sample', t0: performance.now(), sea: seaLevel() };
  }
  function stepBake(budgetMs) {
    if (!job) return;
    const until = performance.now() + budgetMs;
    const { cols, rows, cell, bounds, heights, cells, soft } = job;
    if (job.phase === 'sample') {
      while (job.row < rows && performance.now() < until) {
        const z = bounds.minZ + (job.row + 0.5) * cell, base = job.row * cols;
        for (let c = 0; c < cols; c++) heights[base + c] = heightAt(bounds.minX + (c + 0.5) * cell, z);
        job.row++;
      }
      if (job.row < rows) return;
      job.phase = 'classify'; job.row = 0;
    }
    if (job.phase === 'classify') {
      while (job.row < rows && performance.now() < until) {
        const r = job.row, base = r * cols;
        for (let c = 0; c < cols; c++) {
          const k = base + c, h = heights[k];
          if (h <= job.sea + 0.2) { cells[k] = 0; soft[k] = 0; continue; }
          let rise = 0;
          if (c > 0) rise = Math.max(rise, Math.abs(h - heights[k - 1]));
          if (c < cols - 1) rise = Math.max(rise, Math.abs(h - heights[k + 1]));
          if (r > 0) rise = Math.max(rise, Math.abs(h - heights[k - cols]));
          if (r < rows - 1) rise = Math.max(rise, Math.abs(h - heights[k + cols]));
          const ok = rise <= NPC_MAX_SLOPE;
          cells[k] = ok ? 1 : 0; soft[k] = ok ? 0 : 1;
        }
        job.row++;
      }
      if (job.row < rows) return;
      job.phase = 'finalize';
      return;   // the remaining phases are each one call: at most one of them per think
    }
    if (job.phase === 'finalize') {
      const tf = performance.now();
      job.grid = finalizeNavGrid({ cols, rows, cellSize: cell, minX: bounds.minX, minZ: bounds.minZ, cells, heights, soft, levels: null }, { connectRegions: true });
      job.finalizeMs = performance.now() - tf;
      job.phase = 'vis'; return;
    }
    if (job.phase === 'vis') {
      const tv = performance.now();
      job.visField = buildLazyVisibilityField(job.grid, buildSightGrid(job.grid, []), { terrain: { heights: job.grid.heights } });
      const canSee = job.visField.canSee.bind(job.visField);
      job.visField.canSee = (a, b) => { const t = performance.now(); stats.vis++; const rr = canSee(a, b); stats.visMs += performance.now() - t; return rr; };
      job.visMs = performance.now() - tv;
      job.phase = 'corners'; return;
    }
    if (job.phase === 'corners') {
      const tc = performance.now();
      const cornerMap = buildCornerMap(job.grid, [], job.visField, { heights: job.grid.heights, crest: NPC_CREST });
      let walkableCells = 0; for (let i = 0; i < cells.length; i++) if (cells[i]) walkableCells++;
      const walkable = (x, z) => { const c = Math.floor((x - bounds.minX) / cell), r = Math.floor((z - bounds.minZ) / cell); return c >= 0 && r >= 0 && c < cols && r < rows && cells[r * cols + c] === 1; };
      zone = { cx: job.cx, cz: job.cz, bounds, bakeMs: performance.now() - job.t0, cells: cols * rows, walkableCells, corners: cornerMap?.corners?.length ?? 0, walkable };
      stats.bakes++; stats.bakeMs += zone.bakeMs;
      brain.configure({ navGrid: job.grid, visField: job.visField, cornerMap, patrolPoints: patrolRing(job.cx, job.cz, walkable) });
      zone.phaseMs = { finalize: job.finalizeMs, vis: job.visMs, corners: performance.now() - tc };
      log?.(`npc zone baked at ${job.cx.toFixed(0)},${job.cz.toFixed(0)}: ${zone.cells} cells, ${walkableCells} walkable, ${zone.corners} corners, ${zone.bakeMs.toFixed(0)} ms sliced (finalize ${job.finalizeMs.toFixed(0)}, vis ${job.visMs.toFixed(0)}, corners ${(performance.now() - tc).toFixed(0)} ms in their own ticks)`);
      job = null;
    }
  }
  // The beat bots walk when nothing is happening: a ring around the zone centre plus every point a
  // bot was spawned at, so both sides' patrols cross. v3 gets this from its layout; open terrain
  // has no layout. Points off walkable ground are dropped.
  const spawnAnchors = [];
  function patrolRing(cx, cz, walkable) {
    const pts = [];
    for (let i = 0; i < NPC_PATROL_RING_POINTS; i++) {
      const a = (i / NPC_PATROL_RING_POINTS) * Math.PI * 2;
      const x = cx + Math.cos(a) * NPC_PATROL_RING_RADIUS, z = cz + Math.sin(a) * NPC_PATROL_RING_RADIUS;
      if (walkable(x, z)) pts.push({ x, z });
    }
    for (const p of spawnAnchors) if (walkable(p[0], p[2])) pts.push({ x: p[0], z: p[2] });
    return pts;
  }
  function noteSpawnAnchor(point) {
    if (spawnAnchors.some(p => Math.hypot(p[0] - point[0], p[2] - point[2]) < 8)) return;
    spawnAnchors.push([...point]);
    if (spawnAnchors.length > 16) spawnAnchors.shift();
    // No rebake: the point joins the live ring if the live grid can walk there.
    if (zone && zone.walkable(point[0], point[2])) brain.configure({ patrolPoints: patrolRing(zone.cx, zone.cz, zone.walkable) });
  }
  function ensureZone() {
    const c = playersCentroid();
    if (!c) return;
    if (!job && (!zone || Math.hypot(c[0] - zone.cx, c[1] - zone.cz) > NPC_ZONE_REBAKE_DRIFT)) startBake(c[0], c[1]);
    stepBake(NPC_BAKE_BUDGET_MS);
  }
  function rebake() { zone = null; job = null; ensureZone(); }

  // ---- roster --------------------------------------------------------------------------------
  function attach(client, { team, roleId, spawn }) {
    const role = getRole(roleId);
    const entity = createBrainBot(client.id, { x: spawn[0], y: spawn[1], z: spawn[2] }, { team: teamNameFor(team) });
    const actor = brain.spawn({ id: client.id, team: teamNameFor(team), roleId: role.id, weaponId: client.loadout.primary, at: { x: spawn[0], y: spawn[1], z: spawn[2] } });
    const rec = { client, entity: actor.entity, actor, fire: false, fireTarget: null, lastReloadUntil: null, spawn: [...spawn], team, roleId: role.id };
    byEntityId.set(client.id, rec);
    return rec;
  }
  function detach(client) {
    const rec = byEntityId.get(client.id);
    if (!rec) return;
    brain.remove(rec.actor);
    byEntityId.delete(client.id);
  }
  function recordFor(client) { return byEntityId.get(client.id) ?? null; }

  // ---- per-tick sync: bodies -> brain records ------------------------------------------------
  function syncEntity(entity, client) {
    const cap = client.controller.getCapsule();
    entity.capsule.start.set(cap.start[0], cap.start[1], cap.start[2]);
    entity.capsule.end.set(cap.end[0], cap.end[1], cap.end[2]);
    entity.capsule.radius = cap.radius;
    const v = client.controller.getVelocity();
    entity.velocity.set(v[0], v[1], v[2]);
    entity.onFloor = client.controller.grounded;
    const snap = room.combat.getSnapshot(client.id);
    entity.health = snap.hp;
    entity.alive = snap.alive;
  }
  function syncAll() {
    for (const rec of byEntityId.values()) {
      if (!rec.client.controller) continue;
      syncEntity(rec.entity, rec.client);
      rec.entity.weapon = rec.client.loadout.primary;
      // the room store is the ammo authority; the brain's copy mirrors it
      const ammo = room.ammo.ensureAmmo(rec.client.id, rec.entity.weapon);
      const mine = brain.ammoFor(rec.entity, rec.entity.weapon);
      mine.mag = ammo.mag === Infinity ? mine.magazineSize : ammo.mag;
      mine.reserve = ammo.reserve === Infinity ? 999 : ammo.reserve;
    }
    _seen.clear();
    for (const c of room.clients.values()) {
      if (c.npc || !c.controller) continue;
      _seen.add(c.id);
      let e = worldEntities.get(c.id);
      if (!e) {
        e = { id: c.id, team: teamNameFor(c.team ?? BASE_GAME_TEAMS.friendly), capsule: { start: new Vec3(), end: new Vec3(), radius: 0.35 }, velocity: new Vec3(), onFloor: true, yaw: 0, pitch: 0, weapon: null, tool: null, alive: true, health: 100, isPlayer: true };
        worldEntities.set(c.id, e);
      }
      e.team = teamNameFor(c.team ?? BASE_GAME_TEAMS.friendly);
      syncEntity(e, c);
      e.weapon = c.loadout.primary;
    }
    let changed = false;
    for (const id of worldEntities.keys()) if (!_seen.has(id)) { worldEntities.delete(id); changed = true; }
    // The brain keeps the array by reference; rebuild it only when the player set changed.
    if (changed || _worldList.length !== worldEntities.size) { _worldList.length = 0; for (const e of worldEntities.values()) _worldList.push(e); brain.setWorldEntities(_worldList); }
  }
  const _seen = new Set(), _worldList = [];

  // ---- the think step, once per room tick ------------------------------------------------------
  function think(dtSec) {
    if (!byEntityId.size) return;
    thinkAcc += dtSec;
    const thinkDt = 1 / NPC_THINK_HZ;
    if (thinkAcc + 1e-9 < thinkDt) return;
    thinkAcc -= thinkDt;
    ensureZone();
    const t0 = performance.now();
    syncAll();
    const t1 = performance.now();
    brain.stepAll(thinkDt, roomMs());
    const t2 = performance.now();
    stats.syncMs += t1 - t0; stats.thinkMs += t2 - t1; stats.thinks++;
  }

  // ---- intent -> one tick input for consumeTick ------------------------------------------------
  const _axes = { moveX: 0, moveZ: 0, sprint: false };
  function tickInputFor(client, tick) {
    const t0 = performance.now();
    const out = tickInputInner(client, tick);
    stats.inputMs += performance.now() - t0;
    return out;
  }
  function tickInputInner(client, tick) {
    const rec = byEntityId.get(client.id);
    const e = rec.entity, actor = rec.actor;
    const yaw = controllerYawFromBot(e.yaw);
    moveAxesFor(e.velocity.x, e.velocity.z, yaw, NPC_WALK_SPEED, _axes);
    const bound = brain.withBotActor(actor, () => brain.bound());
    const reloadUntil = actor.reloadUntil ?? null;
    const reload = reloadUntil != null && reloadUntil !== rec.lastReloadUntil;
    rec.lastReloadUntil = reloadUntil;
    const fire = rec.fire; rec.fire = false;
    const combat = actor.state === BOT_AIM || actor.state === BOT_FIRE;
    return {
      tick, moveX: _axes.moveX, moveZ: _axes.moveZ, yaw, pitch: e.pitch,
      sprint: _axes.sprint || actor.stance === STANCE_RUN || actor.stance === STANCE_DASH,
      crouch: false, stance: stanceIndexFor(actor), jump: false,
      slot: 0, aim: combat, reload, fire, throw: false, drone: null,
    };
  }

  // ---- damage and death, forwarded to the brain ----------------------------------------------
  function entityFor(client) { return client ? (byEntityId.get(client.id)?.entity ?? worldEntities.get(client.id) ?? null) : null; }
  function damaged(victim, shooter, amount) {
    const target = entityFor(victim);
    if (!target) return;
    const snap = room.combat.getSnapshot(victim.id);
    target.health = snap.hp; target.alive = snap.alive;
    brain.damaged(target, entityFor(shooter), amount, roomMs());
  }
  function revived(client) {
    const rec = byEntityId.get(client.id);
    if (!rec) return;
    syncEntity(rec.entity, client);
    rec.entity.health = room.combat.getSnapshot(client.id).hp;
    brain.revived(rec.entity, roomMs());
  }

  return {
    brain, attach, detach, recordFor, think, tickInputFor, damaged, revived, rebake, noteSpawnAnchor,
    configure: (patch) => brain.configure(patch),
    spawnPointFor: (rec) => rec.spawn,
    zone: () => zone,
    stats, resetStats: () => { for (const k of Object.keys(stats)) stats[k] = 0; },
    count: () => byEntityId.size,
    nextId: () => nextId++,
    records: () => [...byEntityId.values()],
  };
}
