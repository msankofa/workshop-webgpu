// Node tests for the spline road system: curve math, network topology (snapping, crossings,
// splitting), the spatial index, and the geometry array builders. The browser-only half
// (roads.js) is deliberately not imported -- everything it depends on is exercised here.
// Run: node test-roads.mjs
import {
  curvePointAt, distanceXZ, pathLengthXZ, cumulativeDistances, estimateCurvature, tangentAtInto,
  projectPointToSegmentXZ, distancePointToPolylineXZ, nearestPathIndex, segmentIntersectionXZ,
  simplifyPath, divisionsFor, samplePathOnGround, ROAD_SAMPLE_SPACING,
} from './road-path.js';
import { createRoadNetwork, ROAD_NETWORK_DEFAULTS } from './road-network.js';
import { createRoadIndex } from './road-index.js';
import { buildNavGrid, setNavTravelCost, findPath, NAV_TRAVEL_COST_MAX } from './nav-grid.js';
import { createTerrainField, buildTerrainMeshArrays, createMeshSurface } from './bot-terrain.js';
import {
  buildRoadCoreArrays, buildRoadShoulderArrays, buildRoadPatchArrays, computeNormals,
  groundFromHeightFn, ROAD_MESH_DEFAULTS,
} from './road-mesh.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }
function near(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

const p = (x, z, y = 0) => ({ x, y, z });
const flat = () => 0;
const slope = (x) => x * 0.1;                       // a 10% ramp along +X
const bumpy = (x, z) => Math.sin(x * 0.5) * 0.6 + Math.cos(z * 0.4) * 0.4;

// ---- curve evaluation ----
{
  const points = [p(0, 0), p(10, 0), p(20, 0)];
  const start = curvePointAt(points, 0), end = curvePointAt(points, 1);
  ok(near(start.x, 0) && near(start.z, 0), 'the curve starts exactly on the first control point');
  ok(near(end.x, 20) && near(end.z, 0), 'the curve ends exactly on the last control point');
  const mid = curvePointAt(points, 0.5);
  ok(near(mid.x, 10, 1e-6) && near(mid.z, 0, 1e-6), 'a collinear control set stays on its own line');

  // Coincident control points are what a double-click produces; the guarded spans must not divide
  // by zero and hand back NaN.
  const doubled = curvePointAt([p(0, 0), p(0, 0), p(5, 5)], 0.5);
  ok(Number.isFinite(doubled.x) && Number.isFinite(doubled.z), 'coincident control points stay finite');

  // A right-angle turn bows to the outside of the corner on both approaches rather than tracking
  // the polyline: that overshoot is what makes a hand-drawn road read as a road.
  const elbow = [p(0, 0), p(10, 0), p(10, 10)];
  ok(curvePointAt(elbow, 0.5).x === 10, 'the middle control point is hit exactly');
  ok(curvePointAt(elbow, 0.25).z < -0.3, 'the approach bows outside the corner');
  ok(curvePointAt(elbow, 0.75).x > 10.3, 'and so does the exit');
}

// ---- polyline measures ----
{
  const path = [p(0, 0), p(3, 0), p(3, 4)];
  ok(near(pathLengthXZ(path), 7), 'path length sums the XZ spans');
  const cum = cumulativeDistances(path);
  ok(cum.length === 3 && near(cum[1], 3) && near(cum[2], 7), 'cumulative distances track each sample');
  ok(near(estimateCurvature([p(0, 0), p(1, 0), p(2, 0)]), 0), 'a straight run has zero curvature');
  ok(near(estimateCurvature([p(0, 0), p(1, 0), p(1, 1)]), Math.PI / 2, 1e-9),
    'a right-angle turn measures a quarter turn of curvature');

  const t = { x: 0, z: 0 };
  tangentAtInto([p(0, 0), p(1, 0), p(2, 0)], 1, t);
  ok(near(t.x, 1) && near(t.z, 0), 'the tangent points along the road');
  // Degenerate neighbours must fall back rather than emit a zero-length normal, which would
  // collapse the whole cross-section to a line.
  tangentAtInto([p(5, 5), p(5, 5)], 0, t);
  ok(near(Math.hypot(t.x, t.z), 1), 'a degenerate span still yields a unit tangent');
}

// ---- projection and distance ----
{
  const proj = projectPointToSegmentXZ(p(5, 3), p(0, 0), p(10, 0));
  ok(near(proj.distance, 3) && near(proj.t, 0.5), 'a perpendicular drop lands mid-segment');
  const before = projectPointToSegmentXZ(p(-5, 0), p(0, 0), p(10, 0));
  ok(near(before.t, 0) && near(before.distance, 5), 'projection clamps behind the segment start');
  ok(near(distancePointToPolylineXZ(3, 2, [p(0, 0), p(10, 0), p(10, 10)]), 2),
    'polyline distance takes the nearest segment');
  const nearest = nearestPathIndex([p(0, 0), p(10, 0), p(20, 0)], p(15, 1));
  ok(nearest.index === 1 && near(nearest.point.x, 15), 'the split lands on the segment it was nearest');
}

// ---- crossings ----
{
  const hit = segmentIntersectionXZ(p(-5, 0), p(5, 0), p(0, -5), p(0, 5));
  ok(hit && near(hit.point.x, 0) && near(hit.point.z, 0), 'a proper crossing reports the meeting point');
  ok(!segmentIntersectionXZ(p(0, 0), p(10, 0), p(0, 5), p(10, 5)), 'parallel segments never cross');
  // Touching at an endpoint is a join, not a crossing: splitting there would spawn a duplicate node
  // right beside one that already exists.
  ok(!segmentIntersectionXZ(p(0, 0), p(10, 0), p(0, 0), p(0, 10)), 'an endpoint graze is not a crossing');
}

// ---- simplify ----
{
  const dense = [p(0, 0), p(0.1, 0), p(0.2, 0), p(5, 0)];
  const simple = simplifyPath(dense, 0.85);
  ok(simple.length === 2, 'points inside the merge distance are dropped');
  ok(near(simple[0].x, 0) && near(simple[1].x, 5), 'both endpoints always survive simplification');
  ok(dense.length === 4, 'simplify does not mutate its input');
}

// ---- ground-following sampling ----
{
  const controls = [p(0, 0), p(10, 0), p(20, 0)];
  const sampled = samplePathOnGround(controls, ROAD_SAMPLE_SPACING, (x) => slope(x));
  ok(sampled.length >= 8, 'sampling produces at least the minimum division count');
  let draped = true;
  for (const s of sampled) if (!near(s.y, slope(s.x), 1e-9)) draped = false;
  ok(draped, 'every sample sits exactly on the ground beneath it');
  ok(near(sampled[0].x, 0) && near(sampled[sampled.length - 1].x, 20), 'sampling spans the whole route');

  // Curvature has to buy samples: the two routes below are the same length, and the bent one must
  // not be described with the same number of segments as the straight one.
  const straight = divisionsFor([p(0, 0), p(20, 0)], ROAD_SAMPLE_SPACING);
  const bent = divisionsFor([p(0, 0), p(10, 0), p(10, 10)], ROAD_SAMPLE_SPACING);
  ok(bent > straight, 'a turning route earns more samples than a straight one of similar length');
  ok(divisionsFor([p(0, 0), p(400000, 0)], ROAD_SAMPLE_SPACING) <= 2000, 'sample count stays capped');
}

// ---- network: a single road ----
{
  const net = createRoadNetwork();
  const added = net.addRoadPath([p(-15, 0), p(0, 0), p(15, 0)]);
  ok(added.length === 1, 'a simple route becomes one edge');
  ok(net.nodes.size === 2, 'and gets a node at each end');
  for (const node of net.nodes.values()) ok(node.junctionType === 'endpoint', 'both ends classify as endpoints');

  // A stray click pair shorter than minRouteLength is not a road.
  ok(net.addRoadPath([p(40, 40), p(40, 40.5)]).length === 0, 'a route below the minimum length is discarded');
  ok(net.edges.size === 1, 'and leaves the network untouched');
}

// ---- network: crossing splits both roads ----
{
  const net = createRoadNetwork();
  net.addRoadPath([p(-20, 0), p(20, 0)]);
  net.addRoadPath([p(0, -20), p(0, 20)]);
  ok(net.edges.size === 4, 'two crossing roads become four edges');
  ok(net.nodes.size === 5, 'with one shared junction plus the four original ends');
  const junction = [...net.nodes.values()].find((n) => n.edgeIds.size === 4);
  ok(!!junction, 'the crossing node carries all four arms');
  ok(junction && junction.junctionType === 'cross-junction', 'and classifies as a cross-junction');
  ok(junction && near(junction.position.x, 0, 0.6) && near(junction.position.z, 0, 0.6),
    'the junction sits where the roads actually met');
}

// ---- network: endpoint snapping makes a T ----
{
  const net = createRoadNetwork();
  net.addRoadPath([p(-20, 0), p(20, 0)]);
  // Start the branch just off the trunk, inside snapDistance: it must join rather than float free.
  net.addRoadPath([p(0, 1.5), p(0, 20)]);
  const junction = [...net.nodes.values()].find((n) => n.edgeIds.size === 3);
  ok(!!junction, 'a branch ending on a road splits it into a T');
  ok(junction && junction.junctionType === 't-junction', 'and the node classifies as a T-junction');
  ok(net.edges.size === 3, 'the trunk becomes two edges plus the branch');
}

// ---- network: deletion prunes orphaned nodes ----
{
  const net = createRoadNetwork();
  const [edgeId] = net.addRoadPath([p(-10, 0), p(10, 0)]);
  ok(net.deleteEdge(edgeId), 'an existing edge deletes');
  ok(net.edges.size === 0 && net.nodes.size === 0, 'and its now-orphaned nodes go with it');
  ok(!net.deleteEdge('e999'), 'deleting an unknown edge reports failure instead of throwing');
}

// ---- network: edgeAt and snapshot round trip ----
{
  const net = createRoadNetwork();
  net.addRoadPath([p(-20, 0), p(20, 0)], 4);
  ok(net.edgeAt(0, 1) !== null, 'a point on the paved surface finds its edge');
  ok(net.edgeAt(0, 12) === null, 'a point well off the road finds nothing');

  const snap = net.snapshot();
  const restored = createRoadNetwork();
  restored.restore(snap);
  ok(restored.edges.size === net.edges.size && restored.nodes.size === net.nodes.size,
    'a snapshot restores the same graph size');
  const before = [...net.edges.values()][0];
  const after = [...restored.edges.values()][0];
  ok(near(after.width, before.width), 'edge width survives the round trip');
  ok(after.controlPoints.length === before.controlPoints.length, 'and so do its control points');
  // Restoring must not resurrect the old sampled centreline: the ground may have changed under it.
  ok(after.sampledPath.length === after.controlPoints.length,
    'a restored edge waits to be re-sampled against the current terrain');

  // A restored network must keep issuing fresh ids rather than colliding with the ones it loaded.
  const ids = new Set([...restored.edges.keys()]);
  const fresh = restored.addRoadPath([p(-20, 30), p(20, 30)]);
  ok(fresh.length === 1 && !ids.has(fresh[0]), 'ids issued after a restore do not collide');
}

// ---- spatial index ----
{
  const net = createRoadNetwork();
  net.addRoadPath([p(-20, 0), p(20, 0)], 4);
  const index = net.getIndex();
  ok(near(index.nearestDistance(0, 3, 10), 3, 0.35), 'nearest distance measures to the centreline');
  ok(index.isNearAnyRoad(0, 1, 1.35), 'a point beside the centreline reads as near the road');
  ok(!index.isNearAnyRoad(0, 9, 1.35), 'a point well clear of it does not');
  ok(index.isOnRoadSurface(0, 1.5), 'a point inside the paved width is on the road');
  ok(!index.isOnRoadSurface(0, 3.5), 'a point outside the paved width is not');
  ok(index.nearestDistance(500, 500, 10) === Infinity, 'a bounded query past the limit reports Infinity');
  ok(createRoadIndex([], []).nearestDistance(0, 0) === Infinity, 'an empty index answers Infinity');

  const candidates = index.collectSnapCandidates(20, 0, 3);
  ok(candidates.nodes.length >= 1, 'snap candidates include the node at the road end');
}

// ---- the verge grows in over the edge of the paving, on purpose ----
// Clearance is a band around the CENTRELINE, and the default (1.35 m) is narrower than a default
// road's half width (1.6 m). The outermost strip of paving therefore keeps its blades and the
// grass fringes the road instead of stopping dead at a drafted line. Locking this because it is
// the intended look and reads like a bug to anyone measuring clearance against road width.
{
  const net = createRoadNetwork();
  net.addRoadPath([p(-20, 0), p(20, 0)], ROAD_NETWORK_DEFAULTS.width);
  const index = net.getIndex();
  const halfWidth = ROAD_NETWORK_DEFAULTS.width / 2;
  ok(ROAD_NETWORK_DEFAULTS.clearMargin < halfWidth, 'the bare strip is narrower than the road is wide');
  const fringe = { x: 0, z: (ROAD_NETWORK_DEFAULTS.clearMargin + halfWidth) / 2 };
  ok(index.isOnRoadSurface(fringe.x, fringe.z, 0), 'the fringe band is genuinely on the paving');
  ok(!index.isNearAnyRoad(fringe.x, fringe.z, ROAD_NETWORK_DEFAULTS.clearMargin),
    'and is left growing, so the verge encroaches on the road edge');
  ok(index.isNearAnyRoad(0, 1, ROAD_NETWORK_DEFAULTS.clearMargin), 'the middle of the road still clears');
}

// ---- mesh: core ribbon ----
{
  const path = samplePathOnGround([p(-10, 0), p(10, 0)], ROAD_SAMPLE_SPACING, bumpy);
  const core = buildRoadCoreArrays(path, 3.2, bumpy, { seed: 'e1' });
  const cols = Math.ceil(3.2 / ROAD_MESH_DEFAULTS.surfaceCell);
  ok(core.cols === cols, 'the ribbon is subdivided across its width to the ground cell');
  ok(core.positions.length === path.length * (cols + 1) * 3, 'one vertex per column per sample');
  ok(core.indices.length === (path.length - 1) * cols * 6, 'and two triangles per quad');
  ok(core.triangleCount === (path.length - 1) * cols * 2, 'the reported triangle count matches the indices');

  let drapedEdges = true, insideBounds = true;
  const half = 3.2 / 2, jitter = ROAD_MESH_DEFAULTS.edgeJitter;
  // Positions are float32, so the comparison budget is rounding, not tolerance for a wrong height.
  // A bare height function has no envelope, so every vertex is exactly its own point height.
  for (let i = 0; i < core.positions.length; i += 3) {
    const x = core.positions[i], y = core.positions[i + 1], z = core.positions[i + 2];
    if (!near(y, bumpy(x, z) + ROAD_MESH_DEFAULTS.coreLift, 1e-5)) drapedEdges = false;
  }
  for (const s of core.sections) {
    const width = Math.hypot(s.left.x - s.right.x, s.left.z - s.right.z);
    if (width < half * 2 - jitter * 2.1 || width > half * 2 + jitter * 2.1) insideBounds = false;
  }
  ok(drapedEdges, 'both paved edges sample the ground at their own position, not the centreline');
  ok(insideBounds, 'edge jitter stays within its configured amplitude');

  // Every index has to address a real vertex, or the draw call is undefined behaviour on the GPU.
  let indicesValid = true;
  const vertexCount = core.positions.length / 3;
  for (const i of core.indices) if (i >= vertexCount) indicesValid = false;
  ok(indicesValid, 'core indices stay inside the vertex buffer');

  // The same seed must rebuild the same road: a reshuffling edge on every rebuild would crawl.
  const again = buildRoadCoreArrays(path, 3.2, bumpy, { seed: 'e1' });
  ok(again.positions.every((v, i) => v === core.positions[i]), 'the same seed reproduces the same edge');
  const other = buildRoadCoreArrays(path, 3.2, bumpy, { seed: 'e2' });
  ok(!other.positions.every((v, i) => v === core.positions[i]), 'a different edge gets a different wobble');
}

// ---- mesh: shoulder ----
{
  const path = samplePathOnGround([p(-10, 0), p(10, 0)], ROAD_SAMPLE_SPACING, flat);
  const core = buildRoadCoreArrays(path, 3.2, flat, { seed: 'e1' });
  const shoulder = buildRoadShoulderArrays(path, 3.2, flat, { seed: 'e1', sections: core.sections });
  const perSide = shoulder.steps + 1;
  ok(shoulder.positions.length === path.length * perSide * 2 * 3, 'the shoulder carries both sides per sample');
  ok(near(shoulder.alphas[0], 0), 'the outermost left column is fully transparent');
  ok(near(shoulder.alphas[perSide * 2 - 1], 0), 'so is the outermost right one');
  ok(near(shoulder.alphas[perSide - 1], 1), 'the column tucked under the core is fully opaque');
  ok(near(shoulder.alphas[perSide], 1), 'and so is its mirror on the other side');
  // Spacing is what the whole draping guarantee rests on: no column may straddle a ground cell.
  let widestSpan = 0;
  for (let c = 0; c < perSide - 1; c++) {
    const a = c * 3, b = (c + 1) * 3;
    widestSpan = Math.max(widestSpan, Math.hypot(
      shoulder.positions[b] - shoulder.positions[a], shoulder.positions[b + 2] - shoulder.positions[a + 2]));
  }
  ok(widestSpan <= ROAD_MESH_DEFAULTS.surfaceCell + 1e-3,
    `no shoulder column spans more than one ground cell (widest ${widestSpan.toFixed(3)} m)`);

  // The shoulder must sit above the paved core, or the two coplanar surfaces z-fight.
  let above = true;
  for (let i = 1; i < shoulder.positions.length; i += 3) {
    if (shoulder.positions[i] <= ROAD_MESH_DEFAULTS.coreLift) above = false;
  }
  ok(above, 'the shoulder rides above the core it tucks under');

  const faded = buildRoadShoulderArrays(path, 3.2, flat, {
    seed: 'e1', sections: core.sections, fadeStart: true, fadeEnd: true,
  });
  ok(near(faded.alphas[perSide - 1], 0), 'a dead-end mouth fades its shoulder to nothing');
  ok(faded.alphas[Math.floor(path.length / 2) * perSide * 2 + perSide - 1] > 0.9,
    'while the middle of the same road stays opaque');
}

// ---- mesh: junction patch ----
{
  const patch = buildRoadPatchArrays(p(0, 0), 2.5, bumpy, { segments: 16 });
  ok(patch.rings === Math.ceil(2.5 / ROAD_MESH_DEFAULTS.surfaceCell), 'the patch subdivides radially too');
  ok(patch.positions.length === (1 + 16 * patch.rings) * 3, 'a centre vertex plus one ring per step');
  ok(near(patch.alphas[0], 1), 'the patch centre is opaque');
  ok(near(patch.alphas[1], 1), 'so is its innermost ring');
  ok(near(patch.alphas[1 + 16 * (patch.rings - 1)], 0), 'and the outermost ring fades out');

  let draped = true;
  for (let i = 0; i < patch.positions.length; i += 3) {
    const x = patch.positions[i], y = patch.positions[i + 1], z = patch.positions[i + 2];
    const lift = near(y - bumpy(x, z), ROAD_MESH_DEFAULTS.coreLift, 1e-5)
      || near(y - bumpy(x, z), ROAD_MESH_DEFAULTS.shoulderLift, 1e-5);
    if (!lift) draped = false;
  }
  ok(draped, 'every patch vertex follows the ground under it');

  let indicesValid = true;
  const vertexCount = patch.positions.length / 3;
  for (const i of patch.indices) if (i >= vertexCount) indicesValid = false;
  ok(indicesValid, 'patch indices stay inside the vertex buffer');
}

// ---- mesh: normals ----
{
  const path = samplePathOnGround([p(-10, 0), p(10, 0)], ROAD_SAMPLE_SPACING, flat);
  const core = buildRoadCoreArrays(path, 3.2, flat, { seed: 'e1', edgeJitter: 0 });
  const normals = computeNormals(core.positions, core.indices);
  ok(normals.length === core.positions.length, 'one normal per vertex');
  let upward = true;
  for (let i = 0; i < normals.length; i += 3) if (normals[i + 1] < 0.99) upward = false;
  ok(upward, 'a road on flat ground has upward normals');

  const ramp = samplePathOnGround([p(-10, 0), p(10, 0)], ROAD_SAMPLE_SPACING, (x) => slope(x));
  const rampCore = buildRoadCoreArrays(ramp, 3.2, (x) => slope(x), { seed: 'e1', edgeJitter: 0 });
  const rampNormals = computeNormals(rampCore.positions, rampCore.indices);
  ok(rampNormals[0] < -0.05, 'a road up a slope tilts its normals back down the hill');
}

// ---- defaults sanity ----
{
  ok(ROAD_NETWORK_DEFAULTS.minEdgeLength < ROAD_NETWORK_DEFAULTS.minRouteLength,
    'a route long enough to keep can always yield at least one edge');
  ok(ROAD_MESH_DEFAULTS.shoulderLift > ROAD_MESH_DEFAULTS.coreLift,
    'the shoulder is configured above the core by default');
  ok(ROAD_NETWORK_DEFAULTS.crossingGuard > ROAD_NETWORK_DEFAULTS.minEdgeLength,
    'a crossing can never be accepted where it would leave a sub-minimum stub');
}

// ---- draping on the RENDERED ground, not the field ----
// The bug this guards: a road lifted a fixed amount above the analytic field is not lifted above
// the terrain MESH, because the mesh is flat triangles between grid vertices. In a hollow the
// triangle rises above the field, and wherever it rises further than the lift, terrain shows
// through the road.
{
  const bounds = { minX: -25, maxX: 25, minZ: -25, maxZ: 25 };
  // The viewer's own "eroded highlands" preset. Terrace steps and drainage channels are where the
  // flat triangles depart hardest from the field: measured here the mesh rides up to 0.21 m above
  // it, five times the road's lift. On gentle default terrain the gap is 0.024 m and stays under
  // the lift, which is exactly why the artifact only showed on some ground.
  const params = {
    enabled: true, seed: 7, hillAmp: 3.5, hillScale: 20, hillOctaves: 3, landform: 'ridged',
    warpAmp: 6, warpScale: 35, terraceSteps: 4, terraceSharpness: 0.45,
    rippleAmp: 0.12, rippleMode: 'isotropic', meshCell: 0.5,
    erosionAmp: 1.1, erosionArea: 300, erosionSmooth: 0.55, erosionFillPits: true,
    featureCount: 6, featureMix: 'mixed', featureHeight: 2.5,
  };
  const field = createTerrainField(params, [], { bounds });
  const mesh = buildTerrainMeshArrays(bounds, field, {});
  const ground = createMeshSurface(bounds, mesh);
  const surface = ground.heightAt;
  const vertsX = mesh.segX + 1;

  // Exact agreement at the mesh's own vertices is the anchor: if that fails, the sampler is not
  // reading the surface that gets drawn.
  let onVertices = true;
  for (let j = 0; j <= mesh.segZ; j += 7) {
    for (let i = 0; i <= mesh.segX; i += 7) {
      const k = (j * vertsX + i) * 3;
      const got = surface(mesh.positions[k], mesh.positions[k + 2]);
      if (!near(got, mesh.positions[k + 1], 1e-4)) onVertices = false;
    }
  }
  ok(onVertices, 'the surface sampler reproduces the mesh exactly at its own vertices');

  // The mesh really does depart from the field: if it did not, this whole fix would be pointless
  // and the test below would prove nothing.
  let worstGap = 0;
  for (let x = -24; x <= 24; x += 0.17) {
    for (let z = -24; z <= 24; z += 0.17) {
      worstGap = Math.max(worstGap, surface(x, z) - field.heightAt(x, z));
    }
  }
  ok(worstGap > ROAD_MESH_DEFAULTS.coreLift,
    `the rendered ground rises above the field by more than the road lift (${worstGap.toFixed(3)} m)`);

  // The actual invariant: draped on the surface, every road vertex clears the ground under it.
  const controls = [p(-20, -16), p(-5, 7), p(12, -3), p(20, 14)];
  const cell = (bounds.maxX - bounds.minX) / mesh.segX;
  const surfaceCell = cell * 0.5;
  const draped = samplePathOnGround(controls, surfaceCell, surface);
  const core = buildRoadCoreArrays(draped, 3.2, ground, { seed: 'e1', surfaceCell });
  const shoulder = buildRoadShoulderArrays(draped, 3.2, ground, { seed: 'e1', sections: core.sections, surfaceCell });

  // The assertion that matters, and the one whose absence let the bug ship twice: clearance is
  // measured over the triangle INTERIORS, not at the vertices. A ribbon whose corners all clear the
  // ground can still have 26% of its area buried, which is exactly what the first version did.
  const worstInterior = (g) => {
    let worst = Infinity;
    for (let t = 0; t < g.indices.length; t += 3) {
      const A = g.indices[t] * 3, B = g.indices[t + 1] * 3, C = g.indices[t + 2] * 3;
      for (let a = 0; a <= 1.0001; a += 0.25) {
        for (let b = 0; a + b <= 1.0001; b += 0.25) {
          const w = 1 - a - b;
          const x = g.positions[A] * w + g.positions[B] * a + g.positions[C] * b;
          const y = g.positions[A + 1] * w + g.positions[B + 1] * a + g.positions[C + 1] * b;
          const z = g.positions[A + 2] * w + g.positions[B + 2] * a + g.positions[C + 2] * b;
          worst = Math.min(worst, y - surface(x, z));
        }
      }
    }
    return worst;
  };
  ok(worstInterior(core) > 0, `the whole paved surface clears the ground (worst ${worstInterior(core).toFixed(4)} m)`);
  ok(worstInterior(shoulder) > 0, 'and so does the whole shoulder');

  // The old build, reproduced: coarse quads and a point-sampled height. This is the artifact.
  const naive = samplePathOnGround(controls, 1.15, surface);
  const naiveCore = buildRoadCoreArrays(naive, 3.2, surface, { seed: 'e1', surfaceCell: 99 });
  ok(naiveCore.cols === 1, 'the old build had no lateral subdivision at all');
  ok(worstInterior(naiveCore) < -0.1, 'and its interior sank well below the ground');
}

// ---- nav bias: bots route down a road when open ground is dearer ----
{
  const bounds = { minX: -20, maxX: 20, minZ: -20, maxZ: 20 };
  const net = createRoadNetwork();
  net.addRoadPath([p(-16, 0), p(16, 0)], 4);
  const index = net.getIndex();
  const onRoad = (x, z) => index.isNearAnyRoad(x, z, 2.4);

  const plain = buildNavGrid(() => true, bounds, 0.5, {});
  const biased = buildNavGrid(() => true, bounds, 0.5, {});
  setNavTravelCost(biased, (x, z) => (onRoad(x, z) ? 1 : 1.6));

  ok(plain.travelCost == null, 'a grid built without a cost field carries none');
  ok(biased.travelCost instanceof Float32Array, 'setNavTravelCost bakes one cell cost per cell');

  // Costs under 1 would make the A* heuristic optimistic; they are clamped rather than trusted.
  const clamped = buildNavGrid(() => true, bounds, 0.5, {});
  setNavTravelCost(clamped, () => 0.2);
  ok(clamped.travelCost.every((v) => v === 1), 'a sub-1 cost is clamped back up to 1');
  setNavTravelCost(clamped, () => 999);
  ok(clamped.travelCost.every((v) => v === NAV_TRAVEL_COST_MAX), 'and an extreme one is capped');
  setNavTravelCost(clamped, null);
  ok(clamped.travelCost === null, 'passing null clears the field again');

  const from = { x: -16, z: -6 }, to = { x: 16, z: -6 };
  const meanOffset = (path) => path.reduce((sum, w) => sum + Math.abs(w.z), 0) / path.length;
  const straight = findPath(plain, from, to);
  const pulled = findPath(biased, from, to);
  ok(straight && pulled, 'both grids find a route across open ground');
  ok(meanOffset(straight) > 5.5, 'without a bias the route runs straight, well off the road');
  ok(meanOffset(pulled) < meanOffset(straight) - 1,
    'with open ground dearer, the route detours onto the road');

  // The bias must be a preference, never a wall: ground off the road stays reachable.
  const corner = findPath(biased, { x: -18, z: -18 }, { x: 18, z: -18 });
  ok(corner && corner.length > 0, 'a route that never touches a road still exists');
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('roads: all assertions passed');
