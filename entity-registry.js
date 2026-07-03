// Pure, Node-testable replicated entity registry.
// No THREE, no DOM. Used identically in solo, host, and guest roles —
// guest creates a registry, registers adapters, but only ever calls
// applySnapshot() (never tick()/create()/update()/destroy()).
//
// See docs/superpowers/plans/2026-07-03-entity-registry-light-migration.md
// for the full design (protocol, wire shape, migration plan).

// Registry-level cap on lights + projectiles combined (matches the
// clustered-light renderer's 33-slot reserve). Enforced in create().
export const MAX_LIGHT_ENTITIES = 33;
const CAPPED_TYPES = new Set(['light', 'projectile']);

function countCapped(store) {
  let n = 0;
  for (const e of store.values()) {
    if (CAPPED_TYPES.has(e.type)) n++;
  }
  return n;
}

export function createEntityRegistry() {
  const store = new Map(); // id -> entity
  const adapters = new Map(); // type -> typeDef
  const pendingRemoves = []; // tombstones queued for the *next* snapshot() call
  let seq = 0;
  let version = 0;
  let everTicked = false;

  function registerType(typeDef) {
    if (!typeDef || typeof typeDef.type !== 'string') {
      throw new Error('registerType: typeDef must have a string `type`');
    }
    adapters.set(typeDef.type, typeDef);
  }

  function create(type, init, ctx) {
    const adapter = adapters.get(type);
    if (!adapter) throw new Error(`create: no adapter registered for type "${type}"`);

    if (CAPPED_TYPES.has(type) && countCapped(store) >= MAX_LIGHT_ENTITIES) {
      return null; // reject-newest: registry is full
    }

    const now = (ctx && typeof ctx.now === 'number') ? ctx.now : Date.now();
    const id = `${type}-${++seq}`;
    version += 1;

    const entity = {
      id,
      type,
      ownerId: (init && init.ownerId) || null,
      createdAt: now,
      updatedAt: now,
      version,
      transform: { p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] },
      state: {},
      sim: {},
    };

    if (typeof adapter.create === 'function') {
      const built = adapter.create(init || {}, ctx || {}) || {};
      if (built.transform) entity.transform = { ...entity.transform, ...built.transform };
      if (built.state) entity.state = built.state;
      if (built.sim) entity.sim = built.sim;
      if (built.ownerId !== undefined) entity.ownerId = built.ownerId;
    }

    store.set(id, entity);
    return entity;
  }

  function update(id, patch, ctx) {
    const entity = store.get(id);
    if (!entity) return null;
    const now = (ctx && typeof ctx.now === 'number') ? ctx.now : Date.now();
    if (patch) {
      if (patch.transform) entity.transform = { ...entity.transform, ...patch.transform };
      if (patch.state) entity.state = { ...entity.state, ...patch.state };
      if (patch.sim) entity.sim = { ...entity.sim, ...patch.sim };
      if (patch.ownerId !== undefined) entity.ownerId = patch.ownerId;
    }
    entity.updatedAt = now;
    version += 1;
    entity.version = version;
    return entity;
  }

  function destroy(id, reason, ctx) {
    const entity = store.get(id);
    if (!entity) return false;
    store.delete(id);
    version += 1;
    pendingRemoves.push({ id, version, reason: reason || 'destroyed' });
    return true;
  }

  function get(id) {
    return store.get(id) || null;
  }

  function list(filter) {
    const all = [...store.values()];
    if (!filter) return all;
    if (typeof filter === 'function') return all.filter(filter);
    if (typeof filter === 'object' && filter.type) return all.filter(e => e.type === filter.type);
    return all;
  }

  function tick(dt, ctx) {
    everTicked = true;
    const fullCtx = ctx || {};
    // Snapshot the id list first — adapters may create/destroy entities
    // mid-tick (e.g. projectile impact spawning a light).
    const ids = [...store.keys()];
    for (const id of ids) {
      const entity = store.get(id);
      if (!entity) continue; // may have been destroyed already this tick
      const adapter = adapters.get(entity.type);
      if (!adapter || typeof adapter.update !== 'function') continue;
      // Callers (host wiring) normally omit ctx.spawn and get the registry's
      // own create() wired in; tests may pass a fake ctx.spawn to observe/
      // record spawn calls without depending on registry internals.
      const result = adapter.update(entity, dt, {
        spawn: (type, init) => create(type, init, fullCtx),
        ...fullCtx,
      });
      entity.updatedAt = (fullCtx && typeof fullCtx.now === 'number') ? fullCtx.now : Date.now();
      if (result && result.destroy) {
        destroy(id, result.reason || 'expired', fullCtx);
      }
    }
  }

  function snapshot(opts) {
    // Full snapshots only this milestone (see plan: relay is broadcast-only,
    // deltas break interpolation, late joiners would miss history).
    const upserts = [];
    for (const entity of store.values()) {
      const adapter = adapters.get(entity.type);
      const wire = adapter && typeof adapter.serialize === 'function'
        ? adapter.serialize(entity)
        : { id: entity.id, type: entity.type };
      upserts.push(wire);
    }
    const removes = pendingRemoves.splice(0, pendingRemoves.length);
    return { full: true, since: 0, version, upserts, removes };
  }

  // Serialize current entities WITHOUT draining pendingRemoves — safe to call
  // every render frame (unlike snapshot(), which consumes tombstones). Used by
  // the host to feed the light-entity renderer binder. `filter` is the same
  // shape list() accepts (predicate | {type} | falsy=all).
  function renderList(filter) {
    const out = [];
    for (const entity of list(filter)) {
      const adapter = adapters.get(entity.type);
      if (adapter && typeof adapter.serialize === 'function') {
        out.push(adapter.serialize(entity));
      }
    }
    return out;
  }

  function applySnapshot(snap) {
    if (everTicked) {
      throw new Error('applySnapshot: this registry instance has been ticked — cannot also be used as a mirror');
    }
    if (!snap) return;
    for (const item of snap.upserts || []) {
      if (!item || !item.id) continue;
      const existing = store.get(item.id);
      if (existing) {
        existing.state = item;
        existing.updatedAt = Date.now();
      } else {
        store.set(item.id, {
          id: item.id,
          type: item.type,
          ownerId: item.ownerId || null,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          version: 0,
          transform: { p: item.p || [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] },
          state: item,
          sim: {},
        });
      }
    }
    for (const rem of snap.removes || []) {
      if (rem && rem.id) store.delete(rem.id);
    }
  }

  return {
    registerType,
    create,
    update,
    destroy,
    get,
    list,
    tick,
    snapshot,
    renderList,
    applySnapshot,
  };
}
