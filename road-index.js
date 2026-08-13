// road-index.js
// Uniform-grid spatial index over a road network. Everything that asks "is there a road near
// here?" goes through this: vegetation clearance, nav travel-cost bias, and the editor's snapping.
// Ported from the TypeScript original (MIT). See docs/subsystems/roads.md.

import { distancePointToPolylineXZ } from './road-path.js';

const CELL_SIZE = 24;   // m per bucket; roads are long and thin, so buckets stay cheap to fill

function packCell(cellX, cellZ) {
  return ((cellX + 32768) & 0xffff) | (((cellZ + 32768) & 0xffff) << 16);
}

function cellKeysInRadius(x, z, radius, out) {
  out.length = 0;
  const minC = Math.floor((x - radius) / CELL_SIZE), maxC = Math.floor((x + radius) / CELL_SIZE);
  const minR = Math.floor((z - radius) / CELL_SIZE), maxR = Math.floor((z + radius) / CELL_SIZE);
  for (let c = minC; c <= maxC; c++) for (let r = minR; r <= maxR; r++) out.push(packCell(c, r));
  return out;
}

function pathBounds(path) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of path) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, maxX, minZ, maxZ };
}

// `nodes` and `edges` are the live maps off a road network; the index copies what it needs, so a
// later network edit cannot corrupt an index that is still being queried.
export function createRoadIndex(nodes, edges) {
  const edgeCells = new Map();
  const nodeCells = new Map();
  const edgeHalfWidths = new Map();
  let maxSurfaceRadius = 0;
  const keyScratch = [];

  for (const edge of edges) {
    const path = edge.sampledPath.length >= 2 ? edge.sampledPath : edge.controlPoints;
    if (path.length < 2) continue;
    const indexed = { edgeId: edge.id, path, halfWidth: edge.width * 0.5, bounds: pathBounds(path) };
    edgeHalfWidths.set(edge.id, indexed.halfWidth);
    if (indexed.halfWidth > maxSurfaceRadius) maxSurfaceRadius = indexed.halfWidth;
    const b = indexed.bounds;
    for (let c = Math.floor(b.minX / CELL_SIZE); c <= Math.floor(b.maxX / CELL_SIZE); c++) {
      for (let r = Math.floor(b.minZ / CELL_SIZE); r <= Math.floor(b.maxZ / CELL_SIZE); r++) {
        const k = packCell(c, r);
        const bucket = edgeCells.get(k);
        if (bucket) bucket.push(indexed); else edgeCells.set(k, [indexed]);
      }
    }
  }

  for (const node of nodes) {
    // A junction's patch is as wide as its widest arm, so that is the radius that counts as road.
    let surfaceRadius = 0;
    for (const edgeId of node.edgeIds) surfaceRadius = Math.max(surfaceRadius, edgeHalfWidths.get(edgeId) || 0);
    if (surfaceRadius > maxSurfaceRadius) maxSurfaceRadius = surfaceRadius;
    const k = packCell(Math.floor(node.position.x / CELL_SIZE), Math.floor(node.position.z / CELL_SIZE));
    const indexed = { node, surfaceRadius };
    const bucket = nodeCells.get(k);
    if (bucket) bucket.push(indexed); else nodeCells.set(k, [indexed]);
  }

  function queryEdges(x, z, radius, seen) {
    const results = [];
    for (const key of cellKeysInRadius(x, z, radius, keyScratch)) {
      const bucket = edgeCells.get(key);
      if (!bucket) continue;
      for (const edge of bucket) {
        if (seen.has(edge)) continue;
        seen.add(edge);
        const b = edge.bounds;
        if (x >= b.minX - radius && x <= b.maxX + radius && z >= b.minZ - radius && z <= b.maxZ + radius) {
          results.push(edge);
        }
      }
    }
    return results;
  }

  function queryNodes(x, z, radius, seen) {
    const results = [];
    for (const key of cellKeysInRadius(x, z, radius, keyScratch)) {
      const bucket = nodeCells.get(key);
      if (!bucket) continue;
      for (const indexed of bucket) {
        if (seen.has(indexed)) continue;
        seen.add(indexed);
        if (Math.hypot(x - indexed.node.position.x, z - indexed.node.position.z) <= radius + 1e-6) {
          results.push(indexed);
        }
      }
    }
    return results;
  }

  function nearestDistanceWithin(x, z, radius, best) {
    for (const indexed of queryNodes(x, z, radius, new Set())) {
      best = Math.min(best, Math.hypot(x - indexed.node.position.x, z - indexed.node.position.z));
    }
    for (const edge of queryEdges(x, z, radius, new Set())) {
      best = Math.min(best, distancePointToPolylineXZ(x, z, edge.path));
    }
    return best;
  }

  return {
    isEmpty: edgeCells.size === 0 && nodeCells.size === 0,

    // Distance to the nearest centreline (not to the road edge). Pass a finite `maxDistance`
    // whenever you can: the unbounded form has to grow its search rings until it finds something.
    nearestDistance(x, z, maxDistance = Infinity) {
      if (edgeCells.size === 0 && nodeCells.size === 0) return Infinity;
      if (Number.isFinite(maxDistance)) return nearestDistanceWithin(x, z, maxDistance, Infinity);
      let radius = CELL_SIZE * 2, best = Infinity;
      for (let ring = 0; ring < 8; ring++) {
        best = nearestDistanceWithin(x, z, radius, best);
        if (best <= radius * 0.85) return best;
        radius *= 2;
      }
      return best;
    },

    // Centreline within `margin`. This is the vegetation-clearance test: margin is how far back
    // from the middle of the road the plants stop.
    isNearAnyRoad(x, z, margin) {
      return this.nearestDistance(x, z, margin) <= margin;
    },

    // Standing on the paved surface, accounting for each edge's own width and each junction's
    // patch radius. Use this (not isNearAnyRoad) for anything that should follow the road exactly.
    isOnRoadSurface(x, z, margin = 0) {
      const searchRadius = maxSurfaceRadius + margin;
      for (const edge of queryEdges(x, z, searchRadius, new Set())) {
        if (distancePointToPolylineXZ(x, z, edge.path) <= edge.halfWidth + margin) return true;
      }
      for (const indexed of queryNodes(x, z, searchRadius, new Set())) {
        if (indexed.surfaceRadius > 0
          && Math.hypot(x - indexed.node.position.x, z - indexed.node.position.z) <= indexed.surfaceRadius + margin) {
          return true;
        }
      }
      return false;
    },

    collectSnapCandidates(x, z, maxDistance) {
      return {
        nodes: queryNodes(x, z, maxDistance, new Set()).map((indexed) => indexed.node),
        edges: queryEdges(x, z, maxDistance, new Set()),
      };
    },
  };
}
