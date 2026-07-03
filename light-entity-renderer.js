// Renderer-binding layer between the (pure, THREE-free) entity registry and
// clustered-lights.js's fixed-size GPU slot pool. Owns the slot pool and is
// the ONLY code that calls clusteredLights.setLightDirect/clearLight.
//
// Input contract (produced by a sibling module — entity-types/light.js and
// entity-types/projectile.js serializers — match exactly):
//   { id, type, p:[x,y,z], color:[r,g,b] /* 0..1 */, radius, intensity,
//     lifespan, totalLife, ownerId, spawnedFrom? }
//
// The caller is responsible for pre-filtering the array to renderable
// entities (type:'light' plus in-flight type:'projectile' — projectiles
// render as a moving light). This module accepts any entity with a `p`
// field; it does not filter by `type` beyond that.
//
// See docs/superpowers/plans/2026-07-03-entity-registry-light-migration.md
// ("light-entity-renderer.js" + "Slot-range reconciliation" sections).

export function createLightEntityRenderer({ clusteredLights, firstSlot = 223, maxSlots = 33 }) {
  const slotOf = new Map(); // entityId -> slot index
  const freeSlots = [];
  for (let i = maxSlots - 1; i >= 0; i--) freeSlots.push(firstSlot + i);

  function writeSlot(slot, entity) {
    const [x, y, z] = entity.p;
    const [r, g, b] = entity.color;
    clusteredLights.setLightDirect(slot, {
      x, y, z,
      radius: entity.radius,
      r, g, b,
      intensity: entity.intensity,
    });
  }

  function releaseSlot(id) {
    const slot = slotOf.get(id);
    if (slot === undefined) return;
    clusteredLights.clearLight(slot);
    slotOf.delete(id);
    freeSlots.push(slot);
  }

  const binder = {
    sync(entities) {
      const seen = new Set();

      for (const entity of entities) {
        if (!entity || !entity.p) continue;
        seen.add(entity.id);

        let slot = slotOf.get(entity.id);
        if (slot === undefined) {
          if (freeSlots.length === 0) {
            // Pool exhausted: reject newest, don't evict an existing light.
            continue;
          }
          slot = freeSlots.pop();
          slotOf.set(entity.id, slot);
        }
        writeSlot(slot, entity);
      }

      // Free slots for ids no longer present.
      for (const id of Array.from(slotOf.keys())) {
        if (!seen.has(id)) releaseSlot(id);
      }
    },

    dispose() {
      for (const id of Array.from(slotOf.keys())) releaseSlot(id);
    },
  };

  return binder;
}
