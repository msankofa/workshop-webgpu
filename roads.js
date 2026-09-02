// roads.js
// The THREE-side road system: owns the meshes, materials and the draw-tool state machine on top of
// the pure road-network/road-mesh modules. Ported from the TypeScript original
// (SeloSlav/spline-based-procedural-dirt-road-system, MIT), minus its river/bridge coupling.
//
// The whole dependency on the host viewer is one `heightAt(x, z)` callback, so this drops onto the
// bot viewer's baked terrain field and the environment viewer's closed-form one alike.
// See docs/subsystems/roads.md.

import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { attribute, uniform, positionWorld, distance, smoothstep, float } from 'three/tsl';
import { createRoadNetwork, ROAD_NETWORK_DEFAULTS } from './road-network.js';
import {
  buildRoadCoreArrays, buildRoadShoulderArrays, buildRoadPatchArrays, computeNormals,
  groundFromHeightFn, ROAD_MESH_DEFAULTS,
} from './road-mesh.js';
import {
  ROAD_SAMPLE_SPACING, samplePathOnGround, clonePoint, tangentAtInto, pathLengthXZ,
  distancePointToPolylineXZ,
} from './road-path.js';

export const ROAD_DEFAULTS = {
  ...ROAD_NETWORK_DEFAULTS,
  ...ROAD_MESH_DEFAULTS,
  color: 0x6b5b46,          // packed dirt
  roughness: 0.96,
  endTrim: 0.5,             // terminal sample pulled in by this multiple of width, so a cap covers it
  endCapScale: 1.15,        // dead-end patch radius, as a multiple of half width
  junctionScale: 1.42,      // junction patch radius, as a multiple of the widest arm's half width
  residencyRadius: Infinity,
  residencyStride: 16,
  residencyFade: 20,
  // `clearMargin` (vegetation) comes in with ROAD_NETWORK_DEFAULTS, beside the width it is measured
  // against.
};

function disposeGroup(group) {
  for (const child of group.children) {
    child.geometry?.dispose();
    child.traverse?.((n) => { if (n !== child) n.geometry?.dispose(); });
  }
  group.clear();
}

function geometryFrom(arrays, { withAlpha = false } = {}) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(arrays.positions, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(arrays.uvs, 2));
  geometry.setAttribute('normal', new THREE.BufferAttribute(computeNormals(arrays.positions, arrays.indices), 3));
  if (withAlpha) geometry.setAttribute('roadAlpha', new THREE.BufferAttribute(arrays.alphas, 1));
  geometry.setIndex(new THREE.BufferAttribute(arrays.indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

// The terrain contract is `ground`: `heightAt(x, z)` plus `maxNear(x, z, r)`, the highest the
// ground gets within r -- which is what lets a flat road quad clear the ground INSIDE it and not
// just at its corners. A bare `heightAt` function is still accepted and degrades to point sampling,
// which is right for flat ground and wrong for anything with terrace lips in it.
// `parent` is the group roads join -- pass the same one the map lives in so a layout rebuild
// disposes roads with everything else.
export function createRoadSystem({ parent, ground: groundIn, heightAt, network: networkIn = null, options = {} } = {}) {
  const cfg = { ...ROAD_DEFAULTS, ...options };
  const ground = groundFromHeightFn(groundIn || heightAt);
  const heightOf = (x, z) => ground.heightAt(x, z);
  const network = networkIn ?? createRoadNetwork(cfg);
  const group = new THREE.Group();
  group.name = 'Roads';
  const previewGroup = new THREE.Group();
  previewGroup.name = 'Road preview';
  parent.add(group, previewGroup);

  // No polygon offset anywhere here, deliberately. Separation from the ground is geometric: the
  // road samples the same surface the terrain actually renders (see createMeshSurface) and rides a
  // constant few centimetres above it, so the two are parallel everywhere and never contest a
  // pixel. A depth bias would only paper over a surface that was fighting for real, and its sign
  // depends on the renderer's depth convention -- one more thing to get wrong.
  const residencyFocus = uniform(new THREE.Vector2());
  const residencyRadius = uniform(Number.isFinite(cfg.residencyRadius) ? cfg.residencyRadius : 1e9);
  const residencyFade = uniform(Math.max(0.01, cfg.residencyFade));
  const distanceFade = float(1).sub(smoothstep(residencyRadius.sub(residencyFade), residencyRadius,
    distance(positionWorld.xz, residencyFocus)));
  const coreMaterial = new MeshStandardNodeMaterial({
    color: cfg.color, roughness: cfg.roughness, metalness: 0,
    transparent: Number.isFinite(cfg.residencyRadius),
  });
  coreMaterial.opacityNode = distanceFade;
  // Shoulder and patch rims fade out through a per-vertex alpha rather than a texture, so the road
  // needs no assets. depthWrite off keeps the transparent rim from occluding grass behind it.
  const featherMaterial = new MeshStandardNodeMaterial({
    color: cfg.color, roughness: cfg.roughness, metalness: 0,
    transparent: true, depthWrite: false,
  });
  featherMaterial.opacityNode = attribute('roadAlpha', 'float').mul(distanceFade);

  const previewValid = new MeshStandardNodeMaterial({
    color: 0x66d9a0, roughness: 1, transparent: true, opacity: 0.55, depthWrite: false,
  });
  const previewInvalid = new MeshStandardNodeMaterial({
    color: 0xd96666, roughness: 1, transparent: true, opacity: 0.55, depthWrite: false,
  });

  let triangleCount = 0;
  let onChange = () => {};
  const edgeRecords = new Map();
  const nodeRecords = new Map();
  const buildQueue = [];
  const queued = new Set();
  let observedTopologyRevision = -1;
  let residencyX = 0, residencyZ = 0;
  let residencyR = cfg.residencyRadius;
  let lastResidencyX = Infinity, lastResidencyZ = Infinity, residencyDirty = true;
  let wantedEdgeIds = new Set(), wantedNodeIds = new Set();

  // Samples along the road are capped by the ground's own resolution for the same reason the
  // cross-section is: a chord longer than a ground cell stops following the ground.
  const sampleSpacing = () => Math.min(ROAD_SAMPLE_SPACING, cfg.surfaceCell);

  // Pull a terminal sample back along the road so the round end cap covers the mouth instead of
  // fighting a squared-off ribbon end.
  function trimEnd(path, atStart, width) {
    if (path.length < 2) return;
    const tangent = { x: 1, z: 0 };
    const i = atStart ? 0 : path.length - 1;
    tangentAtInto(path, i, tangent);
    const sign = atStart ? 1 : -1;
    const trim = width * cfg.endTrim;
    path[i] = {
      x: path[i].x + tangent.x * trim * sign,
      y: path[i].y,
      z: path[i].z + tangent.z * trim * sign,
    };
    path[i].y = heightOf(path[i].x, path[i].z);
  }

  function disposeRecord(record) {
    if (!record) return;
    for (const mesh of record.meshes) { mesh.geometry?.dispose(); mesh.removeFromParent(); }
  }

  function nodeSignature(node) {
    return [...node.edgeIds].sort().map(id => `${id}:${network.edges.get(id)?.revision ?? 0}`).join('|');
  }

  function desiredIds() {
    if (!Number.isFinite(residencyR)) return {
      edges: new Set(network.edges.keys()), nodes: new Set(network.nodes.keys()),
    };
    const candidates = network.getIndex().collectSnapCandidates(residencyX, residencyZ, residencyR);
    const edges = new Set();
    for (const indexed of candidates.edges) {
      if (distancePointToPolylineXZ(residencyX, residencyZ, indexed.path) <= residencyR) edges.add(indexed.edgeId);
    }
    const nodes = new Set(candidates.nodes.map(node => node.id));
    for (const id of edges) {
      const edge = network.edges.get(id);
      if (edge) { nodes.add(edge.startNodeId); nodes.add(edge.endNodeId); }
    }
    return { edges, nodes };
  }

  function enqueue(kind, id) {
    const key = `${kind}:${id}`;
    if (queued.has(key)) return;
    queued.add(key); buildQueue.push({ kind, id, key });
  }

  function reconcile() {
    const wanted = desiredIds();
    wantedEdgeIds = wanted.edges; wantedNodeIds = wanted.nodes;
    for (const [id, record] of edgeRecords) if (!network.edges.has(id) || !wanted.edges.has(id)) {
      disposeRecord(record); edgeRecords.delete(id);
    }
    for (const [id, record] of nodeRecords) if (!network.nodes.has(id) || !wanted.nodes.has(id)) {
      disposeRecord(record); nodeRecords.delete(id);
    }
    for (const id of wanted.edges) {
      const edge = network.edges.get(id), record = edgeRecords.get(id);
      if (edge && (!record || record.builtRevision !== edge.revision)) enqueue('edge', id);
    }
    for (const id of wanted.nodes) {
      const node = network.nodes.get(id), signature = node && nodeSignature(node), record = nodeRecords.get(id);
      if (node && (!record || record.signature !== signature)) enqueue('node', id);
    }
    triangleCount = 0;
    for (const r of edgeRecords.values()) triangleCount += r.triangles;
    for (const r of nodeRecords.values()) triangleCount += r.triangles;
    observedTopologyRevision = network.getTopologyRevision();
    residencyDirty = false;
    lastResidencyX = residencyX; lastResidencyZ = residencyZ;
  }

  function buildEdge(id) {
    if (!wantedEdgeIds.has(id)) return true;
    const edge = network.edges.get(id);
    if (!edge) return true;
    if (typeof cfg.readyAt === 'function') {
      const a = edge.controlPoints[0], b = edge.controlPoints[edge.controlPoints.length - 1];
      if (!cfg.readyAt(a.x, a.z) || !cfg.readyAt(b.x, b.z)) return false;
    }
      // Sample against the live ground every rebuild: the terrain seed can change under a road
      // that was drawn on the old one, and a stale centreline would float or sink.
      const sampled = samplePathOnGround(edge.controlPoints, sampleSpacing(), heightOf);
      if (sampled.length < 2) return true;
      network.setSampledPath(edge.id, sampled);

      const startNode = network.nodes.get(edge.startNodeId);
      const endNode = network.nodes.get(edge.endNodeId);
      const startIsEnd = startNode?.edgeIds.size === 1;
      const endIsEnd = endNode?.edgeIds.size === 1;
      const ribbon = sampled.map(clonePoint);
      if (startIsEnd) trimEnd(ribbon, true, edge.width);
      if (endIsEnd) trimEnd(ribbon, false, edge.width);

      const core = buildRoadCoreArrays(ribbon, edge.width, ground, { ...cfg, seed: edge.id });
      const shoulder = buildRoadShoulderArrays(ribbon, edge.width, ground, {
        ...cfg, seed: edge.id, sections: core.sections, fadeStart: startIsEnd, fadeEnd: endIsEnd,
      });

      const coreMesh = new THREE.Mesh(geometryFrom(core), coreMaterial);
      coreMesh.name = `road-core-${edge.id}`;
      coreMesh.receiveShadow = true;
      coreMesh.renderOrder = 3;
      coreMesh.userData.fpNoCollision = true;   // decorative: capsules and bullets ignore it
      const shoulderMesh = new THREE.Mesh(geometryFrom(shoulder, { withAlpha: true }), featherMaterial);
      shoulderMesh.name = `road-shoulder-${edge.id}`;
      shoulderMesh.receiveShadow = true;
      shoulderMesh.renderOrder = 2;
      shoulderMesh.userData.fpNoCollision = true;
      group.add(coreMesh, shoulderMesh);
      disposeRecord(edgeRecords.get(id));
      edgeRecords.set(id, { builtRevision: edge.revision, meshes: [coreMesh, shoulderMesh],
        triangles: core.triangleCount + shoulder.triangleCount });
      return true;
  }

  function buildNode(id) {
      if (!wantedNodeIds.has(id)) return true;
      const node = network.nodes.get(id);
      if (!node) return true;
      const arms = network.connectedEdges(node);
      if (arms.length === 0) return true;
      if (typeof cfg.readyAt === 'function' && !cfg.readyAt(node.position.x, node.position.z)) return false;
      let width = 0;
      for (const arm of arms) width = Math.max(width, arm.width);
      const scale = arms.length === 1 ? cfg.endCapScale : cfg.junctionScale;
      const patch = buildRoadPatchArrays(node.position, width * 0.5 * scale, ground, {
        ...cfg, segments: arms.length === 1 ? 20 : 32,
      });
      const mesh = new THREE.Mesh(geometryFrom(patch, { withAlpha: true }), featherMaterial);
      mesh.name = `road-patch-${node.id}`;
      mesh.receiveShadow = true;
      mesh.renderOrder = 4;
      mesh.userData.fpNoCollision = true;
      group.add(mesh);
      disposeRecord(nodeRecords.get(id));
      nodeRecords.set(id, { signature: nodeSignature(node), meshes: [mesh], triangles: patch.triangleCount });
      return true;
  }

  function rebuild() {
    residencyDirty = true;
    reconcile();
    onChange();
  }

  function update() {
    const moved = Math.hypot(residencyX - lastResidencyX, residencyZ - lastResidencyZ) >= cfg.residencyStride;
    if (residencyDirty || moved || observedTopologyRevision !== network.getTopologyRevision()) reconcile();
    const job = buildQueue.shift();
    if (!job) return false;
    queued.delete(job.key);
    const built = job.kind === 'edge' ? buildEdge(job.id) : buildNode(job.id);
    if (!built) enqueue(job.kind, job.id);
    triangleCount = 0;
    for (const r of edgeRecords.values()) triangleCount += r.triangles;
    for (const r of nodeRecords.values()) triangleCount += r.triangles;
    if (built) onChange();
    return built;
  }

  function setResidency(x, z, radius = residencyR) {
    residencyX = x; residencyZ = z;
    // Geometry is global under a render-origin-shifted group; positionWorld is render-local.
    residencyFocus.value.set(x + group.position.x, z + group.position.z);
    if (radius !== residencyR) {
      residencyR = radius;
      residencyRadius.value = Number.isFinite(radius) ? radius : 1e9;
      coreMaterial.transparent = Number.isFinite(radius);
      residencyDirty = true;
    }
  }

  // ---- draw tool ----------------------------------------------------------------------------
  // Click to drop control points, and the preview ribbon follows the cursor between them. Commit
  // hands the whole polyline to the network in one call, which is where snapping and crossings
  // are resolved -- the tool itself has no topology knowledge at all.
  const draft = [];
  let hoverPoint = null;
  // The preview ribbon is rebuilt from scratch, so a raw pointermove would allocate and upload a
  // couple of hundred vertices per mouse event. Sub-decimetre movement changes nothing you can see.
  const HOVER_STEP = 0.15;

  function draftPoints() {
    return hoverPoint ? [...draft, hoverPoint] : [...draft];
  }

  function refreshPreview() {
    disposeGroup(previewGroup);
    const points = draftPoints();
    if (points.length < 2) return;
    const sampled = samplePathOnGround(points, sampleSpacing(), heightOf, { maxDivisions: 400 });
    if (sampled.length < 2) return;
    const core = buildRoadCoreArrays(sampled, cfg.width, ground, { ...cfg, edgeJitter: 0, seed: 'preview' });
    // Red until the route is long enough that commitDraft would actually keep it, so a stray
    // two-click stub reads as rejected before you commit it rather than after.
    const valid = pathLengthXZ(sampled) >= cfg.minRouteLength;
    const mesh = new THREE.Mesh(geometryFrom(core), valid ? previewValid : previewInvalid);
    mesh.renderOrder = 12;
    mesh.frustumCulled = false;
    previewGroup.add(mesh);
  }

  return {
    group,
    network,
    config: cfg,
    rebuild,
    update,
    setResidency,
    get triangleCount() { return triangleCount; },
    get edgeCount() { return network.edges.size; },
    get nodeCount() { return network.nodes.size; },
    get residentEdgeCount() { return edgeRecords.size; },
    get residentNodeCount() { return nodeRecords.size; },
    get pendingBuilds() { return buildQueue.length; },
    get drafting() { return draft.length > 0; },
    get draftLength() { return draft.length; },

    setOnChange(fn) { onChange = fn || (() => {}); },
    setVisible(visible) { group.visible = visible; previewGroup.visible = visible; },

    // Where nothing may grow: a band measured from the centreline, independent of road width. See
    // clearMargin above for why it is not the paved width -- the verge is meant to encroach.
    isNearRoad(x, z, margin = cfg.clearMargin) {
      return network.getIndex().isNearAnyRoad(x, z, margin);
    },
    isOnRoad(x, z, margin = 0) {
      return network.getIndex().isOnRoadSurface(x, z, margin);
    },
    distanceToRoad(x, z, maxDistance = Infinity) {
      return network.getIndex().nearestDistance(x, z, maxDistance);
    },

    addPoint(point) {
      draft.push(clonePoint(point));
      refreshPreview();
    },
    setHover(point) {
      if (point && hoverPoint && Math.hypot(point.x - hoverPoint.x, point.z - hoverPoint.z) < HOVER_STEP) return;
      hoverPoint = point ? clonePoint(point) : null;
      if (draft.length > 0) refreshPreview();
    },
    undoPoint() {
      draft.pop();
      refreshPreview();
      return draft.length;
    },
    cancelDraft() {
      draft.length = 0;
      hoverPoint = null;
      disposeGroup(previewGroup);
    },
    // Commits the draft. Returns the number of edges created -- zero means the route was too short
    // and nothing was added, which the caller may want to report rather than silently swallow.
    commitDraft(width = cfg.width) {
      const points = [...draft];
      this.cancelDraft();
      if (points.length < 2) return 0;
      const added = network.addRoadPath(points, width);
      if (added.length > 0) rebuild();
      return added.length;
    },

    deleteAt(x, z, margin = 0.6) {
      const edgeId = network.edgeAt(x, z, margin);
      if (!edgeId) return false;
      network.deleteEdge(edgeId);
      rebuild();
      return true;
    },
    clear() {
      network.clear();
      rebuild();
    },

    snapshot: () => network.snapshot(),
    restore(snapshot) {
      network.restore(snapshot);
      rebuild();
    },

    dispose() {
      for (const record of edgeRecords.values()) disposeRecord(record);
      for (const record of nodeRecords.values()) disposeRecord(record);
      edgeRecords.clear(); nodeRecords.clear(); buildQueue.length = 0; queued.clear();
      disposeGroup(group);
      disposeGroup(previewGroup);
      group.removeFromParent();
      previewGroup.removeFromParent();
      coreMaterial.dispose();
      featherMaterial.dispose();
      previewValid.dispose();
      previewInvalid.dispose();
    },
  };
}
