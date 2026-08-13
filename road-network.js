// road-network.js
// The road graph: nodes (junctions and dead ends) joined by edges (spline segments). Drawing a
// road is one call to addRoadPath, which does the whole topology job -- snapping its ends onto
// existing roads, detecting crossings, splitting the roads it crosses, and emitting the edges.
// Ported from the TypeScript original (MIT). See docs/subsystems/roads.md.

import { createRoadIndex } from './road-index.js';
import {
  clonePoint, cumulativeDistances, distanceXZ, nearestPathIndex,
  pathLengthXZ, projectPointToSegmentXZ, segmentIntersectionXZ, simplifyPath,
} from './road-path.js';

// Tuning, scaled down from the original's medieval-map numbers for arena-sized maps (40-80 m
// across, ~3 m roads) rather than open countryside. Override per network if a map wants otherwise.
export const ROAD_NETWORK_DEFAULTS = {
  width: 3.2,             // m, default road width
  // Metres from the CENTRELINE where vegetation is suppressed. Deliberately narrower than the
  // default road's half width (1.6 m), so blades survive along the outermost strip of paving and
  // the verge fringes the road rather than stopping dead at its edge. That overgrown look is the
  // intent: widening this to clear the full paved width makes the road read as freshly laid.
  // Lives here beside `width` rather than in roads.js so the pair stays comparable in Node.
  clearMargin: 1.35,
  snapDistance: 3.0,      // m an endpoint reaches to join an existing node or road
  minRouteLength: 2.0,    // m below which a drawn route is discarded as a stray click
  minEdgeLength: 1.2,     // m below which a split-off edge is dropped instead of created
  crossingGuard: 2.5,     // m from either end of a route where crossings are ignored
  crossingSpacing: 3.0,   // m between two accepted crossings on the same route
  mergeRadius: 1.25,      // m within which a new junction reuses the nearest existing node
  simplifyDistance: 0.85, // m of control-point spacing kept from raw input
};

function classify(count) {
  if (count <= 1) return 'endpoint';
  if (count === 2) return 'bend';
  if (count === 3) return 't-junction';
  if (count === 4) return 'cross-junction';
  return 'complex';
}

function edgePath(edge) {
  return edge.sampledPath.length >= 2 ? edge.sampledPath : edge.controlPoints;
}

// Splice crossing points into a control polyline at their measured distance along it.
function insertEvents(points, events) {
  if (events.length === 0) return points.map(clonePoint);
  const result = [];
  const cumulative = cumulativeDistances(points);
  let eventIndex = 0;
  for (let i = 0; i < points.length - 1; i++) {
    result.push(clonePoint(points[i]));
    while (eventIndex < events.length
      && events[eventIndex].distance > cumulative[i]
      && events[eventIndex].distance <= cumulative[i + 1]) {
      result.push(clonePoint(events[eventIndex].point));
      eventIndex++;
    }
  }
  result.push(clonePoint(points[points.length - 1]));
  return simplifyPath(result, 0.1);
}

export function createRoadNetwork(options = {}) {
  const cfg = { ...ROAD_NETWORK_DEFAULTS, ...options };
  const nodes = new Map();
  const edges = new Map();
  let nextNodeId = 1;
  let nextEdgeId = 1;
  let index = null;
  let indexDirty = true;
  let topologyRevision = 0;

  function invalidate() {
    indexDirty = true;
    topologyRevision++;
  }

  function getIndex() {
    if (indexDirty || !index) {
      index = createRoadIndex(nodes.values(), edges.values());
      indexDirty = false;
    }
    return index;
  }

  function createNode(position) {
    const node = {
      id: `n${nextNodeId++}`,
      position: clonePoint(position),
      edgeIds: new Set(),
      junctionType: 'endpoint',
    };
    nodes.set(node.id, node);
    invalidate();
    return node;
  }

  function createEdge(startNodeId, endNodeId, controlPoints, width) {
    const edge = {
      id: `e${nextEdgeId++}`,
      startNodeId,
      endNodeId,
      width,
      controlPoints: controlPoints.map(clonePoint),
      // Until the mesh builder runs, the control polyline stands in for the sampled centreline so
      // the index and further snapping have something to bite on.
      sampledPath: controlPoints.map(clonePoint),
      length: pathLengthXZ(controlPoints),
      revision: 1,
    };
    edges.set(edge.id, edge);
    nodes.get(startNodeId)?.edgeIds.add(edge.id);
    nodes.get(endNodeId)?.edgeIds.add(edge.id);
    invalidate();
    return edge;
  }

  function removeEdge(edgeId) {
    const edge = edges.get(edgeId);
    if (!edge) return;
    nodes.get(edge.startNodeId)?.edgeIds.delete(edgeId);
    nodes.get(edge.endNodeId)?.edgeIds.delete(edgeId);
    edges.delete(edgeId);
    invalidate();
  }

  function pruneOrphans() {
    for (const [id, node] of nodes) if (node.edgeIds.size === 0) nodes.delete(id);
  }

  function classifyJunctions() {
    for (const node of nodes.values()) node.junctionType = classify(node.edgeIds.size);
  }

  function findNearestNode(point, maxDistance) {
    let best = null, bestDistance = Infinity;
    for (const node of nodes.values()) {
      const distance = distanceXZ(point, node.position);
      if (distance <= maxDistance && distance < bestDistance) { best = node; bestDistance = distance; }
    }
    return best;
  }

  function findSnap(point, maxDistance = cfg.snapDistance) {
    if (nodes.size === 0 && edges.size === 0) return null;
    let best = null;
    const maxDistanceSq = maxDistance * maxDistance;
    const candidates = getIndex().collectSnapCandidates(point.x, point.z, maxDistance);

    // Nodes win ties against segments at equal distance because they are already junctions --
    // snapping to one keeps the graph simpler than splitting an edge beside it.
    for (const node of candidates.nodes) {
      const dx = point.x - node.position.x, dz = point.z - node.position.z;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq > maxDistanceSq) continue;
      const distance = Math.sqrt(distanceSq);
      if (!best || distance < best.distance) {
        best = { kind: 'node', nodeId: node.id, point: clonePoint(node.position), distance };
      }
    }
    for (const indexed of candidates.edges) {
      const samples = indexed.path;
      if (samples.length < 2) continue;
      for (let i = 0; i < samples.length - 1; i++) {
        const projection = projectPointToSegmentXZ(point, samples[i], samples[i + 1]);
        if (projection.distance <= maxDistance && (!best || projection.distance < best.distance)) {
          best = {
            kind: 'segment',
            edgeId: indexed.edgeId,
            point: clonePoint(projection.point),
            distance: projection.distance,
            t: (i + projection.t) / Math.max(1, samples.length - 1),
          };
        }
      }
    }
    return best;
  }

  // Cut an existing edge in two at `point` and return the node between them, reusing a nearby node
  // instead when there already is one (otherwise every crossing breeds a cluster of near-identical
  // junctions that all need their own patch mesh).
  function splitEdgeAtPoint(edgeId, point) {
    const edge = edges.get(edgeId);
    if (!edge) return createNode(point);
    const existing = findNearestNode(point, cfg.mergeRadius);
    if (existing) return existing;

    const path = edgePath(edge);
    const split = nearestPathIndex(path, point);
    const node = createNode(split.point);
    const first = path.slice(0, split.index + 1).map(clonePoint);
    const second = path.slice(split.index + 1).map(clonePoint);
    first.push(clonePoint(node.position));
    second.unshift(clonePoint(node.position));
    removeEdge(edge.id);
    if (pathLengthXZ(first) > 1) createEdge(edge.startNodeId, node.id, first, edge.width);
    if (pathLengthXZ(second) > 1) createEdge(node.id, edge.endNodeId, second, edge.width);
    return node;
  }

  // An endpoint that lands on an existing road joins it: onto a node directly, or by splitting the
  // segment it touched. Mutates points[index] onto the exact join position.
  function resolveEndpoint(points, index_) {
    const snap = findSnap(points[index_], cfg.snapDistance);
    if (!snap) return null;
    if (snap.kind === 'node') {
      points[index_] = clonePoint(snap.point);
      return snap.nodeId;
    }
    const node = splitEdgeAtPoint(snap.edgeId, snap.point);
    points[index_] = clonePoint(node.position);
    return node.id;
  }

  // Where the new route properly crosses existing roads. Each accepted crossing splits the road it
  // crossed and becomes a node the new road will also be split at, so the two really join up.
  function resolveCrossings(points, protectedNodeIds) {
    const events = [];
    const cumulative = cumulativeDistances(points);
    const total = cumulative[cumulative.length - 1];
    for (let routeIndex = 0; routeIndex < points.length - 1; routeIndex++) {
      const a = points[routeIndex], b = points[routeIndex + 1];
      for (const edge of [...edges.values()]) {
        if (!edges.has(edge.id)) continue;   // an earlier crossing may have split this one away
        if (protectedNodeIds.has(edge.startNodeId) || protectedNodeIds.has(edge.endNodeId)) continue;
        const samples = edgePath(edge);
        for (let i = 0; i < samples.length - 1; i++) {
          const hit = segmentIntersectionXZ(a, b, samples[i], samples[i + 1]);
          if (!hit) continue;
          const routeDistance = cumulative[routeIndex] + distanceXZ(a, b) * hit.tA;
          // Crossings too close to either end would produce a stub edge shorter than its own
          // junction patch; the endpoint snap already handles joins there.
          if (routeDistance < cfg.crossingGuard || total - routeDistance < cfg.crossingGuard) continue;
          if (events.some((e) => distanceXZ(e.point, hit.point) < cfg.crossingSpacing)) continue;
          const node = findNearestNode(hit.point, cfg.mergeRadius) ?? splitEdgeAtPoint(edge.id, hit.point);
          events.push({ distance: routeDistance, point: clonePoint(node.position), nodeId: node.id });
          break;
        }
      }
    }
    return events.sort((a, b) => a.distance - b.distance);
  }

  return {
    nodes,
    edges,
    config: cfg,
    getTopologyRevision: () => topologyRevision,
    getIndex,
    findSnap,

    nearestPointDistance(x, z, maxDistance = Infinity) {
      return getIndex().nearestDistance(x, z, maxDistance);
    },

    // The one call the editor makes. Returns the ids of the edges created (empty if the route was
    // too short to keep).
    addRoadPath(rawPoints, width = cfg.width) {
      const points = simplifyPath(rawPoints.map(clonePoint), cfg.simplifyDistance);
      if (points.length < 2 || pathLengthXZ(points) < cfg.minRouteLength) return [];

      const startNodeId = resolveEndpoint(points, 0);
      const endNodeId = resolveEndpoint(points, points.length - 1);
      const protectedIds = new Set([startNodeId, endNodeId].filter(Boolean));
      const events = resolveCrossings(points, protectedIds);
      const route = insertEvents(points, events);
      const endIndex = route.length - 1;

      const connections = new Map();
      connections.set(0, startNodeId ?? createNode(route[0]).id);
      connections.set(endIndex, endNodeId ?? createNode(route[endIndex]).id);
      for (const event of events) {
        const at = route.findIndex((p) => distanceXZ(p, event.point) < 0.05);
        if (at > 0 && at < endIndex) connections.set(at, event.nodeId);
      }

      const added = [];
      const ordered = [...connections.keys()].sort((a, b) => a - b);
      for (let i = 0; i < ordered.length - 1; i++) {
        const controls = route.slice(ordered[i], ordered[i + 1] + 1);
        if (pathLengthXZ(controls) < cfg.minEdgeLength) continue;
        added.push(createEdge(connections.get(ordered[i]), connections.get(ordered[i + 1]), controls, width).id);
      }

      pruneOrphans();
      classifyJunctions();
      invalidate();
      return added;
    },

    deleteEdge(edgeId) {
      if (!edges.has(edgeId)) return false;
      removeEdge(edgeId);
      pruneOrphans();
      classifyJunctions();
      invalidate();
      return true;
    },

    // Nearest edge whose surface covers (x, z), for click-to-delete.
    edgeAt(x, z, margin = 0) {
      const probe = { x, y: 0, z };
      let bestId = null, bestDistance = Infinity;
      for (const edge of edges.values()) {
        const path = edgePath(edge);
        for (let i = 0; i < path.length - 1; i++) {
          const d = projectPointToSegmentXZ(probe, path[i], path[i + 1]).distance;
          if (d < bestDistance && d <= edge.width * 0.5 + margin) { bestDistance = d; bestId = edge.id; }
        }
      }
      return bestId;
    },

    clear() {
      nodes.clear();
      edges.clear();
      nextNodeId = 1;
      nextEdgeId = 1;
      invalidate();
    },

    // The mesh builder owns the real centreline (it is the one that samples the ground), and hands
    // it back so snapping and clearance test against what is actually drawn.
    setSampledPath(edgeId, path) {
      const edge = edges.get(edgeId);
      if (!edge) return;
      edge.sampledPath = path.map(clonePoint);
      edge.length = pathLengthXZ(edge.sampledPath);
      edge.revision++;
      invalidate();
    },

    connectedEdges(node) {
      return [...node.edgeIds].map((id) => edges.get(id)).filter(Boolean);
    },

    snapshot() {
      return {
        nextNodeId,
        nextEdgeId,
        nodes: [...nodes.values()].map((n) => ({ id: n.id, position: [n.position.x, n.position.y, n.position.z] })),
        edges: [...edges.values()].map((e) => ({
          id: e.id,
          startNodeId: e.startNodeId,
          endNodeId: e.endNodeId,
          width: e.width,
          controlPoints: e.controlPoints.map((p) => [p.x, p.y, p.z]),
        })),
      };
    },

    // Control points only: the sampled centreline is re-derived against the current terrain, so a
    // road saved on one map reshapes itself correctly when the ground under it changes.
    restore(snapshot) {
      nodes.clear();
      edges.clear();
      nextNodeId = snapshot?.nextNodeId || 1;
      nextEdgeId = snapshot?.nextEdgeId || 1;
      for (const n of snapshot?.nodes || []) {
        nodes.set(n.id, {
          id: n.id,
          position: { x: n.position[0], y: n.position[1], z: n.position[2] },
          edgeIds: new Set(),
          junctionType: 'endpoint',
        });
      }
      for (const e of snapshot?.edges || []) {
        const controlPoints = e.controlPoints.map((p) => ({ x: p[0], y: p[1], z: p[2] }));
        edges.set(e.id, {
          id: e.id,
          startNodeId: e.startNodeId,
          endNodeId: e.endNodeId,
          width: e.width,
          controlPoints,
          sampledPath: controlPoints.map(clonePoint),
          length: pathLengthXZ(controlPoints),
          revision: 1,
        });
        nodes.get(e.startNodeId)?.edgeIds.add(e.id);
        nodes.get(e.endNodeId)?.edgeIds.add(e.id);
      }
      pruneOrphans();
      classifyJunctions();
      invalidate();
    },
  };
}
