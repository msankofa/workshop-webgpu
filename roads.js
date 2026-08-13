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
import { attribute } from 'three/tsl';
import { createRoadNetwork, ROAD_NETWORK_DEFAULTS } from './road-network.js';
import {
  buildRoadCoreArrays, buildRoadShoulderArrays, buildRoadPatchArrays, computeNormals,
  groundFromHeightFn, ROAD_MESH_DEFAULTS,
} from './road-mesh.js';
import {
  ROAD_SAMPLE_SPACING, samplePathOnGround, clonePoint, tangentAtInto, pathLengthXZ,
} from './road-path.js';

export const ROAD_DEFAULTS = {
  ...ROAD_NETWORK_DEFAULTS,
  ...ROAD_MESH_DEFAULTS,
  color: 0x6b5b46,          // packed dirt
  roughness: 0.96,
  endTrim: 0.5,             // terminal sample pulled in by this multiple of width, so a cap covers it
  endCapScale: 1.15,        // dead-end patch radius, as a multiple of half width
  junctionScale: 1.42,      // junction patch radius, as a multiple of the widest arm's half width
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
export function createRoadSystem({ parent, ground: groundIn, heightAt, options = {} } = {}) {
  const cfg = { ...ROAD_DEFAULTS, ...options };
  const ground = groundFromHeightFn(groundIn || heightAt);
  const heightOf = (x, z) => ground.heightAt(x, z);
  const network = createRoadNetwork(cfg);
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
  const coreMaterial = new MeshStandardNodeMaterial({
    color: cfg.color, roughness: cfg.roughness, metalness: 0,
  });
  // Shoulder and patch rims fade out through a per-vertex alpha rather than a texture, so the road
  // needs no assets. depthWrite off keeps the transparent rim from occluding grass behind it.
  const featherMaterial = new MeshStandardNodeMaterial({
    color: cfg.color, roughness: cfg.roughness, metalness: 0,
    transparent: true, depthWrite: false,
  });
  featherMaterial.opacityNode = attribute('roadAlpha', 'float');

  const previewValid = new MeshStandardNodeMaterial({
    color: 0x66d9a0, roughness: 1, transparent: true, opacity: 0.55, depthWrite: false,
  });
  const previewInvalid = new MeshStandardNodeMaterial({
    color: 0xd96666, roughness: 1, transparent: true, opacity: 0.55, depthWrite: false,
  });

  let triangleCount = 0;
  let onChange = () => {};

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

  function rebuild() {
    disposeGroup(group);
    triangleCount = 0;

    for (const edge of network.edges.values()) {
      // Sample against the live ground every rebuild: the terrain seed can change under a road
      // that was drawn on the old one, and a stale centreline would float or sink.
      const sampled = samplePathOnGround(edge.controlPoints, sampleSpacing(), heightOf);
      if (sampled.length < 2) continue;
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
      triangleCount += core.triangleCount + shoulder.triangleCount;
    }

    // Node patches last, at a higher renderOrder: they are what hides the corner gaps where two
    // ribbons meet at an angle, so they have to draw over the arms rather than under them.
    for (const node of network.nodes.values()) {
      const arms = network.connectedEdges(node);
      if (arms.length === 0) continue;
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
      triangleCount += patch.triangleCount;
    }

    onChange();
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
    get triangleCount() { return triangleCount; },
    get edgeCount() { return network.edges.size; },
    get nodeCount() { return network.nodes.size; },
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
