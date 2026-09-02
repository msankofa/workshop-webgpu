// Deterministic, bounded world trail planner. It owns no rendering; roads.js consumes its network.

import { createRoadNetwork } from './road-network.js';
import { gridFromWindow, routeTrail, smoothPath, thinPath, TRAIL_DEFAULTS } from './trail-router.js';
import { sitesForTile } from './base-game-sites.js';

export const BASE_GAME_TRAIL_DEFAULTS = Object.freeze({
  enabled: true,
  seed: 1,
  spacing: 480,
  width: 3.6,
  maxGrade: 0.55,
  crossSlope: 0.4,
  routeMargin: 180,
  maxLegLength: 2000,
  clearMargin: 2.2,
  clearFade: 5.8,
  existingTrailCost: 0.35,
  routeSample: 6,
  planningRadius: 1400,
  routeIntervalMs: 200,
});

const packTile = (x, z) => ((x + 32768) & 0xffff) | (((z + 32768) & 0xffff) << 16);
const siteKey = site => `${site.tileKey}:${Math.round(site.x * 10)},${Math.round(site.z * 10)}`;
const boxesIntersect = (a, b) => a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
const pointInBox = (x, z, b) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
const distanceToSegmentSq = (x, z, a, b) => {
  const dx = b.x - a.x, dz = b.z - a.z;
  const d2 = dx * dx + dz * dz;
  const t = d2 <= 1e-6 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / d2));
  const qx = a.x + dx * t, qz = a.z + dz * t;
  return (x - qx) ** 2 + (z - qz) ** 2;
};

function legKey(a, b) {
  const ak = siteKey(a), bk = siteKey(b);
  return ak < bk ? `${ak}|${bk}` : `${bk}|${ak}`;
}

function relativeNeighbourLegs(sites) {
  const out = [];
  for (let i = 0; i < sites.length; i++) for (let j = i + 1; j < sites.length; j++) {
    const a = sites[i], b = sites[j];
    const d2 = (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
    let blocked = false;
    for (let k = 0; k < sites.length && !blocked; k++) {
      if (k === i || k === j) continue;
      const c = sites[k];
      blocked = (a.x - c.x) ** 2 + (a.z - c.z) ** 2 < d2
        && (b.x - c.x) ** 2 + (b.z - c.z) ** 2 < d2;
    }
    if (!blocked) out.push([a, b]);
  }
  return out;
}

function linearResample(points, spacing, heightAt) {
  if (points.length < 2) return [];
  const out = [{ ...points[0], y: heightAt(points[0].x, points[0].z) }];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / spacing));
    for (let j = 1; j <= n; j++) {
      const t = j / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      out.push({ x, y: heightAt(x, z), z });
    }
  }
  return out;
}

export function createBaseGameTrails({ terrain, network = null, options = {} } = {}) {
  if (!terrain?.acquirePlan) throw new TypeError('Base Game trails need the terrain plan window');
  let cfg = { ...BASE_GAME_TRAIL_DEFAULTS, ...options };
  let roadNetwork = network ?? createRoadNetwork({ width: cfg.width, clearMargin: cfg.clearMargin });
  const releasePlan = terrain.acquirePlan();
  const releaseFields = terrain.acquireFields?.() ?? (() => {});
  const tiles = new Map();
  const legs = new Map();
  const routed = new Map();
  // Placement asks settledAt for thousands of candidates. Index pending route boxes by site tile;
  // scanning the whole, ever-growing leg map here was an accidental O(candidates * world legs)
  // frame cost and is the main reason the initial implementation degraded to 2-3 fps.
  const pendingBuckets = new Map();
  let scanVersion = -1, scanOriginPX = null, scanOriginPZ = null, disposed = false;
  let routedCount = 0, droppedCount = 0;
  let nextRouteAt = 0, lastRouteMs = 0, maxRouteMs = 0;

  const plan = () => terrain.plan;
  const currentTileBounds = () => {
    const w = plan()?.win;
    if (!w?.placed) return null;
    const minX = w.originPX * plan().post, minZ = w.originPZ * plan().post;
    const maxX = (w.originPX + w.res - 1) * plan().post;
    const maxZ = (w.originPZ + w.res - 1) * plan().post;
    return { tx0: Math.ceil(minX / cfg.spacing), tz0: Math.ceil(minZ / cfg.spacing),
      tx1: Math.floor(maxX / cfg.spacing) - 1, tz1: Math.floor(maxZ / cfg.spacing) - 1 };
  };

  function rebuildNetwork() {
    roadNetwork.clear();
    for (const leg of [...routed.values()].sort((a, b) => a.key.localeCompare(b.key))) {
      leg.edgeIds = roadNetwork.addRoadPath(leg.path, leg.width);
    }
  }

  function indexPending(leg, add) {
    const tx0 = Math.floor(leg.box.minX / cfg.spacing), tx1 = Math.floor(leg.box.maxX / cfg.spacing);
    const tz0 = Math.floor(leg.box.minZ / cfg.spacing), tz1 = Math.floor(leg.box.maxZ / cfg.spacing);
    for (let tz = tz0; tz <= tz1; tz++) for (let tx = tx0; tx <= tx1; tx++) {
      const tileKey = packTile(tx, tz);
      if (add) {
        const bucket = pendingBuckets.get(tileKey) ?? new Set();
        bucket.add(leg.key); pendingBuckets.set(tileKey, bucket);
      } else {
        const bucket = pendingBuckets.get(tileKey);
        bucket?.delete(leg.key);
        if (bucket?.size === 0) pendingBuckets.delete(tileKey);
      }
    }
  }

  function finishPending(leg, status) {
    if (leg.status === 'pending') indexPending(leg, false);
    leg.status = status;
  }

  function deleteLeg(legKey, leg) {
    if (leg.status === 'pending') indexPending(leg, false);
    legs.delete(legKey);
    return routed.delete(legKey);
  }

  function prune() {
    const bounds = currentTileBounds();
    if (!bounds) return;
    let networkChanged = false;
    for (const [key, tile] of tiles) {
      if (tile.tx >= bounds.tx0 && tile.tx <= bounds.tx1 && tile.tz >= bounds.tz0 && tile.tz <= bounds.tz1) continue;
      tiles.delete(key);
      for (const [legKey, leg] of legs) if (leg.ownerKey === key || leg.from.tileKey === key || leg.to.tileKey === key) {
        if (deleteLeg(legKey, leg)) networkChanged = true;
      }
    }
    // A tile owns legs only while its full 3x3 context is resident. When it becomes a boundary
    // tile, drop those legs; otherwise a route discovered while approaching from one side would
    // linger after returning to an earlier window that could not have discovered it.
    for (const tile of tiles.values()) {
      let complete = true;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!tiles.has(packTile(tile.tx + dx, tile.tz + dz))) complete = false;
      }
      if (complete || !tile.legged) continue;
      tile.legged = false;
      for (const [legKey, leg] of legs) if (leg.ownerKey === tile.key) {
        if (deleteLeg(legKey, leg)) networkChanged = true;
      }
    }
    if (networkChanged) rebuildNetwork();
  }

  function scanSites() {
    const p = plan();
    if (!p) return;
    const originChanged = p.win?.originPX !== scanOriginPX || p.win?.originPZ !== scanOriginPZ;
    if (p.version === scanVersion && !originChanged) return;
    scanVersion = p.version;
    scanOriginPX = p.win?.originPX ?? null;
    scanOriginPZ = p.win?.originPZ ?? null;
    prune();
    const bounds = currentTileBounds();
    if (!bounds) return;
    for (let tz = bounds.tz0; tz <= bounds.tz1; tz++) for (let tx = bounds.tx0; tx <= bounds.tx1; tx++) {
      const key = packTile(tx, tz);
      if (tiles.has(key)) continue;
      const sites = sitesForTile(cfg.seed, tx, tz, p, { spacing: cfg.spacing });
      if (sites == null) continue;
      tiles.set(key, { key, tx, tz, sites: sites.map(site => ({ ...site, tileKey: key })), legged: false });
    }
    buildLegs();
  }

  function buildLegs() {
    for (const tile of [...tiles.values()].sort((a, b) => a.key - b.key)) {
      if (tile.legged) continue;
      let complete = true;
      const neighbourhood = [];
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const neighbour = tiles.get(packTile(tile.tx + dx, tile.tz + dz));
        if (!neighbour) complete = false; else neighbourhood.push(...neighbour.sites);
      }
      if (!complete) continue;
      for (const [a, b] of relativeNeighbourLegs(neighbourhood)) {
        const key = legKey(a, b);
        if (legs.has(key)) continue;
        const ownerKey = Math.min(a.tileKey, b.tileKey);
        if (ownerKey !== tile.key) continue;
        const distance = Math.hypot(a.x - b.x, a.z - b.z);
        if (distance > cfg.maxLegLength) { droppedCount++; continue; }
        const margin = cfg.routeMargin;
        const leg = { key, ownerKey, from: a, to: b, width: cfg.width, status: 'pending',
          box: { minX: Math.min(a.x, b.x) - margin, maxX: Math.max(a.x, b.x) + margin,
            minZ: Math.min(a.z, b.z) - margin, maxZ: Math.max(a.z, b.z) + margin } };
        legs.set(key, leg);
        indexPending(leg, true);
      }
      tile.legged = true;
    }
  }

  function stamp(path) {
    const fields = terrain.fields;
    if (!fields?.stampAlong) return 0;
    return fields.stampAlong(['coverGrass', 'coverPlant', 'coverTree'], path,
      cfg.clearMargin + cfg.clearFade, (x, z, value) => Math.round(value * clearanceAt(x, z)));
  }

  function applyPreferredCorridors(grid, preferred) {
    if (!preferred.length) return;
    const clearSq = cfg.clearMargin * cfg.clearMargin;
    for (const other of preferred) for (let i = 1; i < other.path.length; i++) {
      const a = other.path[i - 1], b = other.path[i];
      const ca = grid.toCell(Math.min(a.x, b.x) - cfg.clearMargin, Math.min(a.z, b.z) - cfg.clearMargin);
      const cb = grid.toCell(Math.max(a.x, b.x) + cfg.clearMargin, Math.max(a.z, b.z) + cfg.clearMargin);
      for (let iz = ca.iz; iz <= cb.iz; iz++) for (let ix = ca.ix; ix <= cb.ix; ix++) {
        const at = grid.toWorld(ix, iz);
        if (distanceToSegmentSq(at.x, at.z, a, b) <= clearSq) {
          grid.costMul[iz * grid.nx + ix] = cfg.existingTrailCost;
        }
      }
    }
  }

  function routeOne(globalPosition) {
    if (!cfg.enabled) return false;
    const p = plan();
    const focusX = globalPosition?.[0] ?? 0, focusZ = globalPosition?.[2] ?? 0;
    for (const leg of [...legs.values()].filter(l => l.status === 'pending').sort((a, b) => a.key.localeCompare(b.key))) {
      const nearX = Math.max(leg.box.minX, Math.min(focusX, leg.box.maxX));
      const nearZ = Math.max(leg.box.minZ, Math.min(focusZ, leg.box.maxZ));
      if (Math.hypot(nearX - focusX, nearZ - focusZ) > cfg.planningRadius) continue;
      const grid = gridFromWindow(p, leg.box, { cell: p.post, margin: 0, maxGrade: cfg.maxGrade, crossSlope: cfg.crossSlope });
      if (!grid) continue;
      grid.costMul = new Float32Array(grid.nx * grid.nz).fill(1);
      const preferred = [...routed.values()].filter(other => other.key < leg.key && boxesIntersect(other.box, leg.box));
      applyPreferredCorridors(grid, preferred);
      const cells = routeTrail(grid, leg.from, leg.to);
      if (!cells?.length) { finishPending(leg, 'dropped'); droppedCount++; return true; }
      const isWalkable = (x, z) => { const c = grid.toCell(x, z); return grid.walkable[c.iz * grid.nx + c.ix] > 0; };
      const controls = thinPath(smoothPath(cells, TRAIL_DEFAULTS.smoothPasses, isWalkable), TRAIL_DEFAULTS.simplifyM);
      const path = linearResample(controls, cfg.routeSample, (x, z) => p.sampleAt('heights', x, z));
      if (path.length < 2) { finishPending(leg, 'dropped'); droppedCount++; return true; }
      finishPending(leg, 'routed'); leg.path = path;
      routed.set(leg.key, leg);
      leg.edgeIds = roadNetwork.addRoadPath(path, leg.width);
      // Plan tiles arrive in worker-completion order. Rebuilding every previously accepted path
      // when a lexically earlier leg appeared made topology work grow superlinearly while loading.
      // Route geometry is already canonical; append it once and reserve full rebuilds for pruning.
      routedCount++;
      stamp(path);
      return true;
    }
    return false;
  }

  function clearanceAt(x, z) {
    if (!cfg.enabled || roadNetwork.edges.size === 0) return 1;
    const distance = roadNetwork.getIndex().nearestDistance(x, z, cfg.clearMargin + cfg.clearFade);
    if (distance <= cfg.clearMargin) return 0;
    if (distance >= cfg.clearMargin + cfg.clearFade) return 1;
    const t = (distance - cfg.clearMargin) / cfg.clearFade;
    return t * t * (3 - 2 * t);
  }

  function settledAt(x, z) {
    if (!cfg.enabled) return true;
    const p = plan();
    if (!p || p.sampleAt('planWalk', x, z) == null) return false;
    const tx = Math.floor(x / cfg.spacing), tz = Math.floor(z / cfg.spacing);
    const rings = Math.ceil(cfg.routeMargin / cfg.spacing) + 1;
    for (let dz = -rings; dz <= rings; dz++) for (let dx = -rings; dx <= rings; dx++) {
      const tile = tiles.get(packTile(tx + dx, tz + dz));
      if (!tile || !tile.legged) return false;
    }
    const pending = pendingBuckets.get(packTile(tx, tz));
    if (pending) for (const key of pending) {
      const leg = legs.get(key);
      if (leg?.status === 'pending' && pointInBox(x, z, leg.box)) return false;
    }
    return true;
  }

  terrain.setTrailPlannerHooks?.({ clearanceAt, settledAt });

  return {
    get network() { return roadNetwork; },
    get config() { return { ...cfg }; },
    clearanceAt, settledAt,
    update(globalPosition) {
      if (disposed) return false;
      scanSites();
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (now < nextRouteAt) return false;
      nextRouteAt = now + Math.max(0, cfg.routeIntervalMs);
      const started = now;
      const changed = routeOne(globalPosition);
      lastRouteMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - started;
      maxRouteMs = Math.max(maxRouteMs, lastRouteMs);
      return changed;
    },
    setOptions(patch = {}) {
      const reset = ['seed', 'spacing', 'width', 'maxGrade', 'crossSlope'].some(k => patch[k] != null && patch[k] !== cfg[k]);
      const enabledChanged = patch.enabled != null && patch.enabled !== cfg.enabled;
      cfg = { ...cfg, ...patch };
      if (reset) this.clear();
      else if (enabledChanged) {
        terrain.fields?.clear();
        if (cfg.enabled) for (const leg of routed.values()) stamp(leg.path);
      }
    },
    clear() {
      tiles.clear(); legs.clear(); routed.clear(); pendingBuckets.clear(); roadNetwork.clear();
      scanVersion = -1; scanOriginPX = null; scanOriginPZ = null; routedCount = 0; droppedCount = 0;
      nextRouteAt = 0; lastRouteMs = 0; maxRouteMs = 0;
      terrain.fields?.clear();
    },
    get stats() {
      let pending = 0;
      for (const leg of legs.values()) if (leg.status === 'pending') pending++;
      return { sites: [...tiles.values()].reduce((n, t) => n + t.sites.length, 0), tiles: tiles.size,
        legs: legs.size, pending, routed: routed.size, routedTotal: routedCount, dropped: droppedCount,
        edges: roadNetwork.edges.size, nodes: roadNetwork.nodes.size, planCoverage: plan()?.coverage ?? 0,
        planOriginPX: plan()?.win?.originPX ?? null, planOriginPZ: plan()?.win?.originPZ ?? null,
        lastRouteMs, maxRouteMs };
    },
    edgePolylines() {
      return [...roadNetwork.edges.values()].map(edge => edge.sampledPath.map(p => [p.x, p.y, p.z]));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      terrain.setTrailPlannerHooks?.({});
      releaseFields(); releasePlan();
      tiles.clear(); legs.clear(); routed.clear(); pendingBuckets.clear(); roadNetwork.clear();
    },
  };
}
