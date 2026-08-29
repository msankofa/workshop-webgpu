// body-part-batches.js
//
// Instanced-render pool for procedural humanoid bodies (Phase 4 of the bot port).
// One InstancedMesh bucket per distinct shared body BufferGeometry, so N bots cost
// ~one draw call PER PART TYPE instead of ~31 draw calls PER BOT. Mirrors the
// creature system's createCreaturePartBatches (port-creature-system.js) but keyed
// by geometry identity (bodies already share geometry via player-procedural-body's
// _sharedBodyGeo cache) rather than a fixed part enum.
//
// Immediate mode: beginFrame() zeros every bucket, each visible body flushes its
// parts via add(), endFrame() uploads. A body that skips its IK solve on a strided
// frame still re-adds its (stale) transforms, so the pose simply holds. The buffer
// persists between beginFrame() calls, so callers that only run on network events
// (guests) keep their last frame rendered.
//
// Bucket lifecycle: an empty bucket is hidden by endFrame() and evicted after `evictAfter`
// consecutive flushed frames (counted in endFrame, so a caller that stops flushing keeps its
// buckets); the next add() with that geometry recreates it. The shared geometry is never disposed.
// dropBucket(geometry)/dropBuckets(geometries) evict on demand for a caller that disposes geometry
// off the frame clock (the NPC suite sweeps its cache on design edits, not per frame), so a
// shell-owned pool that must survive mode switches never has to dispose-and-recreate the whole pool.
//
// Per-instance color: shell/plate/trim buckets carry a white material + per-instance
// color (each bot's role color), so bots keep distinct colors under instancing. The
// eye role is never colored (null) so its instanceColor stays unallocated and every
// eye uses the flat-black material.

// Node materials, not classic ones, so each can carry a heat tag for the thermal visor
// (vision-modes.js). heatTag() has to assign colorNode/emissiveNode, and a classic material cannot
// take a node: the renderer converts it internally at shader-build time and the app never gets a
// handle on the result. Untagged, a body renders as a lit colour object in a heat frame -- which is
// backwards, since people are what a thermal sight is for.
//
// THREE is injected here rather than imported, so a build without node materials (the plain WebGL
// three) falls back to the classic constructor and behaves exactly as before.
function nodeMaterialTypes(THREE) {
  return {
    Standard: THREE.MeshStandardNodeMaterial || THREE.MeshStandardMaterial,
    Basic: THREE.MeshBasicNodeMaterial || THREE.MeshBasicMaterial,
  };
}

// roughness/metalness copied from the per-mesh materials in player-procedural-body.js
// so the instanced look matches the legacy mesh path exactly.
function roleMaterials(THREE) {
  const { Standard, Basic } = nodeMaterialTypes(THREE);
  return {
    shell: new Standard({ color: 0xffffff, roughness: 0.65, metalness: 0.05 }),
    plate: new Standard({ color: 0xffffff, roughness: 0.55, metalness: 0.10 }),
    trim:  new Standard({ color: 0xffffff, roughness: 0.40, metalness: 0.15 }),
    accent: new Standard({ color: 0xffffff, roughness: 0.50, metalness: 0.20 }),
    // untinted roles carry their own colour (no per-instance tint allocated)
    metal: new Standard({ color: 0x6f7681, roughness: 0.42, metalness: 0.25 }),
    rubber: new Standard({ color: 0x14171b, roughness: 0.95, metalness: 0 }),
    fabric: new Standard({ color: 0x8d7c58, roughness: 0.98, metalness: 0 }),
    // dark tinted glass; the lit/fresnel version lives in bot-viewer-visuals' botMaterials
    visor: new Standard({ color: 0x2a1e08, roughness: 0.10, metalness: 0.30 }),
    eye:   new Basic({ color: 0x080808, side: THREE.DoubleSide }),
    // human face (bot-face.js). skin/hair are white-based and per-instance tinted like shell, so
    // one bucket carries a whole squad's worth of skin tones; the eye/mouth colours are shared.
    skin:  new Standard({ color: 0xffffff, roughness: 0.72, metalness: 0 }),
    hair:  new Standard({ color: 0xffffff, roughness: 0.85, metalness: 0 }),
    sclera: new Standard({ color: 0xe6ded0, roughness: 0.35, metalness: 0 }),
    pupil: new Standard({ color: 0x141110, roughness: 0.30, metalness: 0 }),
    mouth: new Standard({ color: 0x6b3630, roughness: 0.55, metalness: 0 }),
    // uniform fabric — white-based and per-instance tinted like skin
    cloth: new Standard({ color: 0xffffff, roughness: 0.94, metalness: 0 }),
  };
}

/**
 * @param {object}   opts
 * @param {object}   opts.THREE     injected THREE (never imported here)
 * @param {object}   opts.scene     scene to add the InstancedMeshes to
 * @param {number}   [opts.capacity] per-bucket instance cap (soft-fail beyond it)
 * @param {object}   [opts.materials] role->material override (shell/plate/trim/eye). Callers that
 *   supply their own (bot-viewer-v2 hands in the visual system's emissive bot materials) keep
 *   ownership: dispose() will not touch them, since the same objects usually outlive the pool.
 * @param {number}   [opts.evictAfter] consecutive empty endFrame()s before a bucket is evicted
 */
export function createBodyPartBatches({ THREE, scene, capacity = 8192, materials: injected = null, evictAfter = 120 }) {
  const materials = injected || roleMaterials(THREE);
  const ownsMaterials = !injected;
  // bucket per geometry.uuid: { mesh, role, count, empty, geometry } — bookkeeping for dispose/stats/eviction
  const buckets = new Map();
  // The same buckets keyed by geometry object: the per-frame lookup path, no uuid string hashing.
  let bucketByGeo = new WeakMap();
  const stats = { draws: 0, instances: 0, dropped: 0 };
  // Scratch for raycast()'s world-normal transform — reused across calls, never exposed.
  const _rcMatrix = new THREE.Matrix4();
  const _rcNormalMat = new THREE.Matrix3();

  function bucketFor(geometry, role) {
    let b = bucketByGeo.get(geometry);
    if (b && !b.evicted) return b;
    b = buckets.get(geometry.uuid);
    if (!b) {
      const mesh = new THREE.InstancedMesh(geometry, materials[role] || materials.trim, capacity);
      mesh.name = `BodyBatch:${role}`;
      mesh.count = 0;
      mesh.frustumCulled = false;       // instances span the whole map
      mesh.castShadow = false;          // bodies didn't cast shadows in the mesh path
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.userData.bodyBatch = true;
      if (scene) scene.add(mesh);
      b = { mesh, role, count: 0, empty: 0, geometry, evicted: false };
      buckets.set(geometry.uuid, b);
      stats.draws = buckets.size;
    }
    bucketByGeo.set(geometry, b);
    return b;
  }

  // Tear down one bucket's InstancedMesh and forget it from both maps. Never disposes the shared
  // geometry — the body's cache owns that. Used by endFrame's frame-count eviction and by the
  // on-demand dropBucket() below.
  function evictBucket(uuid, b) {
    if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
    if (b.mesh.dispose) b.mesh.dispose();
    b.evicted = true;   // any WeakMap entry still pointing here must miss
    buckets.delete(uuid);
    bucketByGeo.delete(b.geometry);
  }

  // Drop the bucket for one shared geometry NOW, without waiting for evictAfter empty frames. The
  // caller is disposing that geometry this tick (the NPC suite's cache sweep), so a lingering bucket
  // would hold a disposed BufferGeometry. Safe in either order — the geometry's uuid survives its
  // own dispose(). No-op if no bucket exists; never disposes the geometry.
  function dropBucket(geometry) {
    if (!geometry) return false;
    const b = bucketByGeo.get(geometry) || buckets.get(geometry.uuid);
    if (!b || b.evicted) return false;
    evictBucket(b.geometry.uuid, b);
    stats.draws = buckets.size;
    return true;
  }

  // Bounds an attribute's GPU upload to [0, count); no-op if ranges aren't supported.
  function setUpdateRange(attr, count) {
    if (attr.clearUpdateRanges) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, count);
    } else if (attr.updateRange) {
      attr.updateRange.offset = 0;
      attr.updateRange.count = count;
    }
  }

  return {
    stats,
    beginFrame() {
      for (const b of buckets.values()) b.count = 0;
      stats.instances = 0;
      stats.dropped = 0;
    },
    // color: THREE.Color for tinted roles, or null/undefined to leave the bucket flat.
    add(geometry, role, matrix, color) {
      const b = bucketFor(geometry, role);
      if (b.count >= capacity) { stats.dropped++; return false; }
      const i = b.count++;
      b.mesh.setMatrixAt(i, matrix);
      if (color && b.mesh.setColorAt) b.mesh.setColorAt(i, color);
      stats.instances++;
      return true;
    },
    endFrame() {
      let evicted = false;
      for (const [uuid, b] of buckets) {
        b.mesh.count = b.count;
        b.mesh.visible = b.count > 0;
        if (b.count === 0) {
          // Empty long enough to be gone for good: drop the bucket, never the shared geometry.
          if (++b.empty >= evictAfter) { evictBucket(uuid, b); evicted = true; }
          continue;
        }
        b.empty = 0;
        // add() writes indices [0, count) fresh every frame, so that's the whole live range.
        setUpdateRange(b.mesh.instanceMatrix, b.count * 16);
        b.mesh.instanceMatrix.needsUpdate = true;
        if (b.mesh.instanceColor) {
          setUpdateRange(b.mesh.instanceColor, b.count * 3);
          b.mesh.instanceColor.needsUpdate = true;
        }
      }
      if (evicted) stats.draws = buckets.size;
    },
    dropBucket,
    // Drop buckets for many geometries at once (e.g. the set a cache sweep just disposed). Returns
    // how many buckets were actually dropped.
    dropBuckets(geometries) {
      let n = 0;
      if (geometries) for (const g of geometries) if (dropBucket(g)) n++;
      return n;
    },
    dispose() {
      for (const b of buckets.values()) {
        if (b.mesh.parent) b.mesh.parent.remove(b.mesh);
        if (b.mesh.dispose) b.mesh.dispose();
        b.evicted = true;
        // geometry is shared (owned by the body's _sharedBodyGeo cache) — never disposed here.
      }
      buckets.clear();
      bucketByGeo = new WeakMap();   // a WeakMap can't be cleared, and stale entries would outlive the meshes
      stats.draws = 0;
      if (ownsMaterials) for (const m of Object.values(materials)) m.dispose();
    },
    // Closest hit across every bucket, with the role that instance belongs to. A bucket is one
    // InstancedMesh per shared geometry (role is tracked per BUCKET, not per instance — see the
    // module comment), so this tests each bucket in turn and keeps the nearest result rather than
    // relying on Raycaster.intersectObjects, which has no way to attribute a hit back to a role.
    // instanceId's face normal comes back in that INSTANCE's local geometry space; InstancedMesh
    // doesn't pre-transform it, so it has to be rotated into world space by hand via that instance's
    // own matrix (getMatrixAt) composed with the bucket mesh's matrixWorld.
    raycast(raycaster) {
      let best = null;
      for (const b of buckets.values()) {
        if (b.count === 0) continue;
        const hits = raycaster.intersectObject(b.mesh, false);
        for (const hit of hits) {
          if (best && hit.distance >= best.distance) continue;
          let normal = null;
          if (hit.face && Number.isInteger(hit.instanceId)) {
            b.mesh.getMatrixAt(hit.instanceId, _rcMatrix);
            _rcMatrix.premultiply(b.mesh.matrixWorld);
            _rcNormalMat.getNormalMatrix(_rcMatrix);
            normal = hit.face.normal.clone().applyMatrix3(_rcNormalMat).normalize();
          }
          best = { point: hit.point.clone(), normal, role: b.role, distance: hit.distance, instanceId: hit.instanceId };
        }
      }
      return best;
    },
  };
}
