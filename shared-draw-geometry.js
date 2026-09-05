// Immutable geometry shared by draw wrappers with independent indirect arguments.
// Three's Geometries.dispose deletes attributes without reference counting. During synchronous
// wrapper disposal, protect attributes still used by another wrapper in this pool. Dispose the
// wrapper immediately: Three's disposal listener retains a mutable RenderObject, so delaying
// that listener until after geometry replacement could delete the replacement's attributes.
import * as THREE from 'three';

export function createSharedDrawGeometryPool(renderer) {
  const sources = new Map(), wrappers = new WeakMap(), liveAttributes = new Map();
  const released = new WeakSet();
  const attributesOf = geometry => [...new Set([
    geometry.index, ...Object.values(geometry.attributes), ...Object.values(geometry.morphAttributes).flat(),
  ].filter(Boolean).map(a => a.isInterleavedBufferAttribute ? a.data : a))];

  function acquire(source, instanceCount, indirect) {
    let owner = sources.get(source);
    if (!owner) {
      // One private copy per source keeps external palette users outside this pool's lifetime.
      const geometry = source.clone();
      owner = { source, geometry, attributes: attributesOf(geometry), references: 0 };
      sources.set(source, owner);
    }
    const base = owner.geometry;
    const geometry = base.isInstancedBufferGeometry ? new THREE.InstancedBufferGeometry() : new THREE.BufferGeometry();
    geometry.name = base.name;
    geometry.setIndex(base.index);
    for (const [name, attribute] of Object.entries(base.attributes)) geometry.setAttribute(name, attribute);
    geometry.morphAttributes = { ...base.morphAttributes };
    geometry.morphTargetsRelative = base.morphTargetsRelative;
    geometry.groups = base.groups.map(group => ({ ...group }));
    geometry.boundingBox = base.boundingBox?.clone() ?? null;
    geometry.boundingSphere = base.boundingSphere?.clone() ?? null;
    geometry.setDrawRange(base.drawRange.start, base.drawRange.count);
    geometry.instanceCount = instanceCount;
    geometry.indirect = indirect;
    owner.references++;
    for (const attribute of owner.attributes) liveAttributes.set(attribute, (liveAttributes.get(attribute) ?? 0) + 1);
    wrappers.set(geometry, owner);
    return geometry;
  }

  function release(geometry) {
    if (released.has(geometry)) return;
    released.add(geometry);
    const owner = wrappers.get(geometry);
    if (!owner) { geometry.dispose(); return; } // standalone billboard geometry
    wrappers.delete(geometry);
    owner.references--;
    for (const attribute of owner.attributes) {
      const remaining = liveAttributes.get(attribute) - 1;
      if (remaining) liveAttributes.set(attribute, remaining);
      else liveAttributes.delete(attribute);
    }
    const attributes = renderer?._attributes;
    const originalDelete = attributes?.delete;
    try {
      if (originalDelete) {
        attributes.delete = function (attribute) {
          const buffer = attribute.isInterleavedBufferAttribute ? attribute.data : attribute;
          if (!liveAttributes.has(buffer)) return originalDelete.call(this, attribute);
        };
      }
      geometry.dispose();
    } finally {
      if (originalDelete) attributes.delete = originalDelete;
      if (owner.references === 0) {
        sources.delete(owner.source);
        owner.geometry.dispose();
      }
    }
  }
  return { acquire, release, get sourceCount() { return sources.size; } };
}
