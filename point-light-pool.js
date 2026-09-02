// point-light-pool.js — a fixed pool of resident THREE.PointLights that serialized light
// entities (entity-types/light.js and projectile.js wire shape: { id, p, color, radius,
// intensity }) borrow by id. The THREE-light twin of light-entity-renderer.js's clustered
// slot pool, for pages without clustered lights — base-game.html first.
//
// The WebGPU rule from flash-lights.js holds: `.visible` feeds the lights hash that keys
// the render pipeline, so a light appearing or disappearing recompiles every material.
// Slots are resident from construction and idle at intensity 0.

export function createPointLightPool({ THREE, scene, count = 8, decay = 2 }) {
  const lights = [];
  for (let i = 0; i < count; i++) {
    const l = new THREE.PointLight(0xffffff, 0, 10, decay);
    l.name = `devLight${i}`;
    scene.add(l);
    lights.push(l);
  }
  const slotOf = new Map();   // entityId -> pool index
  const freeSlots = [];
  for (let i = count - 1; i >= 0; i--) freeSlots.push(i);
  const _local = [0, 0, 0];

  // entities: array of the wire shape above, positions in the caller's space.
  // toLocal(p, out): converts a [x,y,z] into the scene's space (worldCoordinates.toRenderLocal).
  function sync(entities, toLocal) {
    const seen = new Set();
    for (const entity of entities) {
      if (!entity || !entity.p) continue;
      seen.add(entity.id);
      let slot = slotOf.get(entity.id);
      if (slot === undefined) {
        if (freeSlots.length === 0) continue;   // pool exhausted: reject newest, never evict
        slot = freeSlots.pop();
        slotOf.set(entity.id, slot);
      }
      const l = lights[slot];
      const p = toLocal(entity.p, _local);
      l.position.set(p[0], p[1], p[2]);
      l.color.setRGB(entity.color[0], entity.color[1], entity.color[2]);
      l.distance = entity.radius;
      l.decay = Number.isFinite(entity.decay) ? entity.decay : decay;
      l.intensity = entity.intensity;
    }
    for (const [id, slot] of Array.from(slotOf.entries())) {
      if (seen.has(id)) continue;
      lights[slot].intensity = 0;
      slotOf.delete(id);
      freeSlots.push(slot);
    }
  }

  function dispose() {
    for (const l of lights) { scene.remove(l); l.dispose?.(); }
    lights.length = 0;
    slotOf.clear();
    freeSlots.length = 0;
  }

  return { sync, dispose, lights };
}
