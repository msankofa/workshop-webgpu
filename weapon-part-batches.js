// weapon-part-batches.js
//
// Instanced-render pool for held weapon GLBs — sibling of body-part-batches.js.
// One InstancedMesh bucket per distinct sub-mesh geometry. Weapon templates are
// loaded once per weapon id and their geometries/materials are shared, so every
// bot holding the same weapon coalesces into the same buckets: N bots cost
// ~subMeshCount draws per weapon TYPE instead of per bot. Buckets keep the
// template's own GLB material (no per-instance color, unlike body batches).
//
// Immediate mode, same contract as body-part-batches: beginFrame() zeros every
// bucket, each visible mount add()s its sub-mesh world matrices, endFrame()
// uploads. setMatrixAt copies, so callers may pass a reused scratch matrix.
//
// Skinned weapon meshes (m1911, cz_805_bren, mk2_grenade) never animate their
// skeletons here, but their authored node pose does NOT match the skinned output
// (bones rotate the gun into place), so bakeSkinnedGeometry() below freezes the
// current bone pose into a plain BufferGeometry once at template load.

// Freezes a SkinnedMesh's current bone pose into a static clone of its geometry
// (positions AND normals, per-vertex blend — same math as the skinning shader),
// with skin attributes stripped. Rendering the result rigidly with the mesh's own
// matrixWorld reproduces the skinned render exactly, for any bind/rest mismatch.
// Caller must have updated the skeleton's bone matrixWorlds first.
export function bakeSkinnedGeometry(THREE, mesh) {
  const src = mesh.geometry;
  const geo = src.clone();
  const srcPos = src.attributes.position, srcNor = src.attributes.normal;
  const pos = geo.attributes.position, nor = geo.attributes.normal;
  const skinIndex = src.attributes.skinIndex, skinWeight = src.attributes.skinWeight;
  const { bones, boneInverses } = mesh.skeleton;
  const blend = new THREE.Matrix4(), boneM = new THREE.Matrix4(), total = new THREE.Matrix4();
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  const idx = new THREE.Vector4(), wgt = new THREE.Vector4();
  for (let i = 0; i < pos.count; i++) {
    idx.fromBufferAttribute(skinIndex, i);
    wgt.fromBufferAttribute(skinWeight, i);
    const be = blend.elements.fill(0);
    for (let j = 0; j < 4; j++) {
      const w = wgt.getComponent(j);
      if (w === 0) continue;
      boneM.multiplyMatrices(bones[idx.getComponent(j)].matrixWorld, boneInverses[idx.getComponent(j)]);
      const me = boneM.elements;
      for (let k = 0; k < 16; k++) be[k] += me[k] * w;
    }
    total.copy(mesh.bindMatrixInverse).multiply(blend).multiply(mesh.bindMatrix);
    v.fromBufferAttribute(srcPos, i).applyMatrix4(total);
    pos.setXYZ(i, v.x, v.y, v.z);
    if (nor) {
      nm.getNormalMatrix(total);
      n.fromBufferAttribute(srcNor, i).applyMatrix3(nm).normalize();
      nor.setXYZ(i, n.x, n.y, n.z);
    }
  }
  geo.deleteAttribute('skinIndex');
  geo.deleteAttribute('skinWeight');
  return geo;
}

/**
 * @param {object} opts
 * @param {object} opts.THREE        injected THREE (never imported here)
 * @param {object} opts.scene        scene to add the InstancedMeshes to
 * @param {number} [opts.capacity]   per-bucket instance cap (soft-fail beyond it)
 * @param {boolean} [opts.castShadow] bucket meshes cast shadows; default true keeps
 *   existing callers unchanged — pass false to skip the shadow pass for weapons that
 *   fall outside the shadow box anyway (e.g. distant bots)
 */
export function createWeaponPartBatches({ THREE, scene, capacity = 2048, castShadow = true }) {
  // bucket per geometry.uuid: { mesh, count }
  const buckets = new Map();
  const stats = { draws: 0, instances: 0, dropped: 0 };

  function bucketFor(geometry, material) {
    let b = buckets.get(geometry.uuid);
    if (!b) {
      const mesh = new THREE.InstancedMesh(geometry, material, capacity);
      mesh.name = 'WeaponBatch';
      mesh.count = 0;
      mesh.frustumCulled = false;       // templates already disable culling (skinned bind-pose bounds)
      mesh.castShadow = castShadow;     // held guns cast shadows in the per-clone path (default true)
      mesh.receiveShadow = false;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.userData.weaponBatch = true;
      if (scene) scene.add(mesh);
      b = { mesh, count: 0 };
      buckets.set(geometry.uuid, b);
      stats.draws = buckets.size;
    }
    return b;
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
    add(geometry, material, matrix) {
      const b = bucketFor(geometry, material);
      if (b.count >= capacity) { stats.dropped++; return false; }
      b.mesh.setMatrixAt(b.count++, matrix);
      stats.instances++;
      return true;
    },
    endFrame() {
      for (const b of buckets.values()) {
        b.mesh.count = b.count;
        // Empty bucket: mesh.count=0 already hides everything, no upload needed.
        if (b.count === 0) continue;
        // add() writes indices [0, count) fresh every frame, so that's the whole live range.
        setUpdateRange(b.mesh.instanceMatrix, b.count * 16);
        b.mesh.instanceMatrix.needsUpdate = true;
      }
    },
    dispose() {
      for (const b of buckets.values()) {
        if (scene) scene.remove(b.mesh);
        b.mesh.dispose?.();
        // geometries/materials belong to the weapon template cache; never disposed here
      }
      buckets.clear();
      stats.draws = 0; stats.instances = 0; stats.dropped = 0;
    },
  };
}
