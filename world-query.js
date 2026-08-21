// world-query.js — synchronous provider-based 3D world query contract.
//
// Terrain heightfields, static mesh BVHs, cave/volume chunks, and later dynamic
// colliders register behind this service. Generic consumers never need to know
// which representation answered a query.

import { assertWorldVec3, copyWorldVec3 } from './world-coordinates.js';

export const WORLD_QUERY_CONTRACT_VERSION = 2;
export const WORLD_QUERY_ALL_LAYERS = 0xffffffff;
export const WORLD_QUERY_CAPABILITIES = Object.freeze([
  'raycast',
  'raycastAll',
  'groundProbe',
  'sweep',
  'overlap',
  'pointContents',
  'resolveCapsule',
]);

const CAPABILITY_SET = new Set(WORLD_QUERY_CAPABILITIES);
const EPSILON = 1e-9;

function finiteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be finite and non-negative`);
  return value;
}

function nonNegativeDistance(value, label) {
  if ((value !== Infinity && !Number.isFinite(value)) || value < 0) {
    throw new TypeError(`${label} must be non-negative`);
  }
  return value;
}

function normalizedDirection(value, label = 'direction') {
  assertWorldVec3(value, label);
  const length = Math.hypot(value[0], value[1], value[2]);
  if (!(length > EPSILON)) throw new RangeError(`${label} must have non-zero length`);
  return [value[0] / length, value[1] / length, value[2] / length];
}

function queryMask(value) {
  if (value === undefined) return WORLD_QUERY_ALL_LAYERS;
  if (!Number.isInteger(value)) throw new TypeError('query mask must be an integer');
  return value >>> 0;
}

function excludeSet(value) {
  if (value === undefined || value === null) return null;
  if (value instanceof Set) return value;
  if (Array.isArray(value)) return new Set(value.map(String));
  throw new TypeError('excludeProviderIds must be an array or Set');
}

function isPromiseLike(value) {
  return value && typeof value.then === 'function';
}

function requireSynchronous(value, providerId, method) {
  if (isPromiseLike(value)) {
    throw new TypeError(`world-query provider "${providerId}" returned a Promise from synchronous ${method}()`);
  }
  return value;
}

function capabilityList(provider) {
  const listed = provider.capabilities;
  const found = new Set();
  if (listed !== undefined) {
    if (!listed || typeof listed[Symbol.iterator] !== 'function') {
      throw new TypeError('provider capabilities must be iterable');
    }
    for (const capability of listed) {
      if (!CAPABILITY_SET.has(capability)) throw new TypeError(`unknown world-query capability: ${capability}`);
      found.add(capability);
    }
  }
  for (const capability of WORLD_QUERY_CAPABILITIES) {
    if (typeof provider[capability] === 'function') found.add(capability);
  }
  if (found.size === 0) throw new TypeError('world-query provider implements no query capability');
  for (const capability of found) {
    if (typeof provider[capability] !== 'function') {
      throw new TypeError(`provider declares ${capability} but does not implement it`);
    }
  }
  return found;
}

function normalizeRayQuery(query) {
  if (!query || typeof query !== 'object') throw new TypeError('ray query must be an object');
  return {
    ...query,
    origin: copyWorldVec3(assertWorldVec3(query.origin, 'query.origin')),
    direction: normalizedDirection(query.direction, 'query.direction'),
    maxDistance: nonNegativeDistance(query.maxDistance ?? Infinity, 'query.maxDistance'),
    mask: queryMask(query.mask),
    excludeProviderIds: excludeSet(query.excludeProviderIds),
  };
}

function normalizeGroundQuery(query) {
  if (!query || typeof query !== 'object') throw new TypeError('ground query must be an object');
  const up = normalizedDirection(query.up ?? [0, 1, 0], 'query.up');
  const slopeLimitCos = query.slopeLimitCos ?? 0.5;
  if (!Number.isFinite(slopeLimitCos) || slopeLimitCos < -1 || slopeLimitCos > 1) {
    throw new RangeError('query.slopeLimitCos must be in [-1, 1]');
  }
  return {
    ...query,
    origin: copyWorldVec3(assertWorldVec3(query.origin, 'query.origin')),
    up,
    direction: [-up[0], -up[1], -up[2]],
    maxDistance: nonNegativeDistance(query.maxDistance ?? Infinity, 'query.maxDistance'),
    slopeLimitCos,
    mask: queryMask(query.mask),
    excludeProviderIds: excludeSet(query.excludeProviderIds),
  };
}

function normalizeCapsule(value, label = 'query.capsule') {
  if (!value || typeof value !== 'object') throw new TypeError(`${label} must be an object`);
  const radius = finiteNonNegative(value.radius, `${label}.radius`);
  if (!(radius > EPSILON)) throw new RangeError(`${label}.radius must be greater than zero`);
  return {
    start: copyWorldVec3(assertWorldVec3(value.start, `${label}.start`)),
    end: copyWorldVec3(assertWorldVec3(value.end, `${label}.end`)),
    radius,
  };
}

function normalOrNull(value, label) {
  if (value === undefined || value === null) return null;
  return normalizedDirection(value, label);
}

function normalizeHit(raw, record, query, method, sequence) {
  if (!raw || typeof raw !== 'object') return null;
  let distance = raw.distance;
  if (distance === undefined && Number.isFinite(raw.fraction) && Number.isFinite(query.maxDistance)) {
    distance = raw.fraction * query.maxDistance;
  }
  finiteNonNegative(distance, `${record.id}.${method} hit distance`);
  if (distance > query.maxDistance + EPSILON) return null;
  const point = raw.point === undefined
    ? [
        query.origin[0] + query.direction[0] * distance,
        query.origin[1] + query.direction[1] * distance,
        query.origin[2] + query.direction[2] * distance,
      ]
    : copyWorldVec3(assertWorldVec3(raw.point, `${record.id}.${method} hit point`));
  return {
    ...raw,
    distance,
    point,
    normal: normalOrNull(raw.normal, `${record.id}.${method} hit normal`),
    providerId: record.id,
    providerPriority: record.priority,
    providerSequence: record.sequence,
    sequence,
    colliderId: raw.colliderId ?? null,
    entityId: raw.entityId ?? null,
    material: raw.material ?? null,
    surfaceType: raw.surfaceType ?? null,
    walkable: raw.walkable ?? null,
    velocity: raw.velocity == null ? null : copyWorldVec3(assertWorldVec3(raw.velocity, 'hit.velocity')),
  };
}

function compareHits(a, b) {
  const distance = a.distance - b.distance;
  if (Math.abs(distance) > EPSILON) return distance;
  if (a.providerPriority !== b.providerPriority) return b.providerPriority - a.providerPriority;
  if (a.providerSequence !== b.providerSequence) return a.providerSequence - b.providerSequence;
  return a.sequence - b.sequence;
}

function providerEligible(record, query, capability) {
  if (!record.capabilities.has(capability)) return false;
  if (record.provider.enabled === false) return false;
  if ((record.layers & query.mask) === 0) return false;
  if (query.excludeProviderIds?.has(record.id)) return false;
  if (typeof record.provider.acceptsQuery === 'function' && !record.provider.acceptsQuery(query, capability)) return false;
  return true;
}

export function createWorldQueryService() {
  const records = [];
  const byId = new Map();
  let providerSequence = 0;
  let revision = 0;

  function registerProvider(provider) {
    if (!provider || typeof provider !== 'object') throw new TypeError('world-query provider must be an object');
    const id = String(provider.id ?? '').trim();
    if (!id) throw new TypeError('world-query provider requires a non-empty id');
    if (byId.has(id)) throw new Error(`world-query provider id already registered: ${id}`);
    const priority = Number(provider.priority ?? 0);
    if (!Number.isFinite(priority)) throw new TypeError('provider priority must be finite');
    const layers = queryMask(provider.layers);
    const record = {
      id,
      provider,
      priority,
      layers,
      capabilities: capabilityList(provider),
      sequence: providerSequence++,
    };
    records.push(record);
    byId.set(id, record);
    revision++;
    let active = true;
    return () => {
      if (!active) return false;
      active = false;
      byId.delete(id);
      const index = records.indexOf(record);
      if (index >= 0) records.splice(index, 1);
      revision++;
      return true;
    };
  }

  function collectRayHits(query, all) {
    const q = normalizeRayQuery(query);
    const hits = [];
    let sequence = 0;
    for (const record of records) {
      const method = all
        ? (record.capabilities.has('raycastAll') ? 'raycastAll' : 'raycast')
        : (record.capabilities.has('raycast') ? 'raycast' : 'raycastAll');
      if (!providerEligible(record, q, method)) continue;
      const raw = requireSynchronous(record.provider[method](q), record.id, method);
      const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
      for (const value of values) {
        const hit = normalizeHit(value, record, q, method, sequence++);
        if (hit) hits.push(hit);
      }
    }
    hits.sort(compareHits);
    return hits;
  }

  function raycast(query) {
    return collectRayHits(query, false)[0] ?? null;
  }

  function raycastAll(query, out = []) {
    if (!Array.isArray(out)) throw new TypeError('raycastAll out must be an array');
    out.length = 0;
    out.push(...collectRayHits(query, true));
    return out;
  }

  function groundProbe(query) {
    const q = normalizeGroundQuery(query);
    const hits = [];
    let sequence = 0;
    for (const record of records) {
      let method = null;
      if (providerEligible(record, q, 'groundProbe')) method = 'groundProbe';
      else if (providerEligible(record, q, 'raycastAll')) method = 'raycastAll';
      else if (providerEligible(record, q, 'raycast')) method = 'raycast';
      if (!method) continue;
      const providerQuery = method === 'groundProbe' ? q : { ...q, direction: q.direction };
      const raw = requireSynchronous(record.provider[method](providerQuery), record.id, method);
      const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
      for (const value of values) {
        const hit = normalizeHit(value, record, q, method, sequence++);
        if (!hit || hit.walkable === false || !hit.normal) continue;
        const upDot = hit.normal[0] * q.up[0] + hit.normal[1] * q.up[1] + hit.normal[2] * q.up[2];
        if (upDot + EPSILON < q.slopeLimitCos) continue;
        hits.push({ ...hit, walkable: true, upDot });
      }
    }
    hits.sort(compareHits);
    return hits[0] ?? null;
  }

  function dispatchNearest(capability, query) {
    if (!query || typeof query !== 'object') throw new TypeError(`${capability} query must be an object`);
    const q = {
      ...query,
      origin: copyWorldVec3(assertWorldVec3(query.origin, 'query.origin')),
      direction: query.direction ? normalizedDirection(query.direction, 'query.direction') : undefined,
      maxDistance: nonNegativeDistance(query.maxDistance ?? Infinity, 'query.maxDistance'),
      mask: queryMask(query.mask),
      excludeProviderIds: excludeSet(query.excludeProviderIds),
    };
    const hits = [];
    let sequence = 0;
    for (const record of records) {
      if (!providerEligible(record, q, capability)) continue;
      const raw = requireSynchronous(record.provider[capability](q), record.id, capability);
      const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
      for (const value of values) {
        const hit = normalizeHit(value, record, q, capability, sequence++);
        if (hit) hits.push(hit);
      }
    }
    hits.sort(compareHits);
    return hits[0] ?? null;
  }

  function overlap(query, out = []) {
    if (!query || typeof query !== 'object') throw new TypeError('overlap query must be an object');
    if (!Array.isArray(out)) throw new TypeError('overlap out must be an array');
    const q = {
      ...query,
      origin: copyWorldVec3(assertWorldVec3(query.origin, 'query.origin')),
      mask: queryMask(query.mask),
      excludeProviderIds: excludeSet(query.excludeProviderIds),
    };
    out.length = 0;
    for (const record of records) {
      if (!providerEligible(record, q, 'overlap')) continue;
      const raw = requireSynchronous(record.provider.overlap(q), record.id, 'overlap');
      const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
      for (const value of values) {
        if (!value || typeof value !== 'object') continue;
        out.push({
          ...value,
          providerId: record.id,
          providerPriority: record.priority,
          colliderId: value.colliderId ?? null,
          entityId: value.entityId ?? null,
        });
      }
    }
    return out;
  }

  function pointContents(query) {
    if (!query || typeof query !== 'object') throw new TypeError('pointContents query must be an object');
    const q = {
      ...query,
      origin: copyWorldVec3(assertWorldVec3(query.origin, 'query.origin')),
      mask: queryMask(query.mask),
      excludeProviderIds: excludeSet(query.excludeProviderIds),
    };
    const entries = [];
    for (const record of records) {
      if (!providerEligible(record, q, 'pointContents')) continue;
      const value = requireSynchronous(record.provider.pointContents(q), record.id, 'pointContents');
      if (value === false || value === null || value === undefined) continue;
      entries.push({
        providerId: record.id,
        providerPriority: record.priority,
        contents: value === true ? 'solid' : value,
      });
    }
    return { solid: entries.some(entry => entry.contents === 'solid' || entry.contents?.solid === true), entries };
  }

  // Penetration resolution is deliberately separate from sweep(). A player may cross several
  // registered representations in one fixed step (terrain plus a structure, for example), so each
  // eligible provider receives the correction produced by the one before it. Canonical capsule and
  // velocity values remain plain arrays at this boundary; Three.js exists only in provider adapters.
  function resolveCapsule(query) {
    if (!query || typeof query !== 'object') throw new TypeError('resolveCapsule query must be an object');
    const slopeLimitCos = query.slopeLimitCos ?? 0.5;
    if (!Number.isFinite(slopeLimitCos) || slopeLimitCos < -1 || slopeLimitCos > 1) {
      throw new RangeError('query.slopeLimitCos must be in [-1, 1]');
    }
    const iterations = Math.max(1, Math.min(16, Math.floor(query.iterations ?? 4)));
    const q = {
      ...query,
      capsule: normalizeCapsule(query.capsule),
      velocity: copyWorldVec3(assertWorldVec3(query.velocity ?? [0, 0, 0], 'query.velocity')),
      slopeLimitCos,
      iterations,
      mask: queryMask(query.mask),
      excludeProviderIds: excludeSet(query.excludeProviderIds),
    };
    let grounded = false;
    let ceiling = false;
    const contacts = [];
    const providers = records
      .filter(record => providerEligible(record, q, 'resolveCapsule'))
      .sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
    for (const record of providers) {
      const raw = requireSynchronous(record.provider.resolveCapsule(q), record.id, 'resolveCapsule');
      if (!raw || typeof raw !== 'object') continue;
      if (raw.capsule) q.capsule = normalizeCapsule(raw.capsule, `${record.id}.resolveCapsule capsule`);
      if (raw.velocity) q.velocity = copyWorldVec3(assertWorldVec3(raw.velocity, `${record.id}.resolveCapsule velocity`));
      grounded = grounded || raw.grounded === true;
      ceiling = ceiling || raw.ceiling === true;
      if (Array.isArray(raw.contacts)) {
        for (const contact of raw.contacts) {
          if (!contact || typeof contact !== 'object') continue;
          contacts.push({ ...contact, providerId: record.id, providerPriority: record.priority });
        }
      }
      q.capsule = normalizeCapsule(q.capsule);
      q.velocity = copyWorldVec3(assertWorldVec3(q.velocity, 'resolved velocity'));
    }
    return { capsule: q.capsule, velocity: q.velocity, grounded, ceiling, contacts };
  }

  return {
    get revision() { return revision; },
    registerProvider,
    unregisterProvider(id) {
      const record = byId.get(String(id));
      if (!record) return false;
      byId.delete(record.id);
      records.splice(records.indexOf(record), 1);
      revision++;
      return true;
    },
    providerIds() { return records.map(record => record.id); },
    hasCapability(capability) {
      if (!CAPABILITY_SET.has(capability)) return false;
      return records.some(record => record.capabilities.has(capability) && record.provider.enabled !== false);
    },
    raycast,
    raycastAll,
    groundProbe,
    sweep(query) { return dispatchNearest('sweep', query); },
    overlap,
    pointContents,
    resolveCapsule,
  };
}
