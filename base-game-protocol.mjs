export const BASE_GAME_PROTOCOL_VERSION = 3;
export const BASE_GAME_ROOM_GRACE_MS = 30_000;
export const BASE_GAME_ROOM_PLAYER_CAP = 16;
export const BASE_GAME_SERVER_TICK_HZ = 60;
export const BASE_GAME_SNAPSHOT_HZ = 20;
export const BASE_GAME_INPUT_HZ = 30;
export const BASE_GAME_INPUT_BURST = 10;
export const BASE_GAME_SIM_HZ = 120;
export const BASE_GAME_MAX_TICKS_PER_PACKET = 64;
export const BASE_GAME_MAX_TICKS_AHEAD = 240;
export const BASE_GAME_TICK_QUEUE_TARGET = 3;
export const BASE_GAME_TICK_QUEUE_DRAIN = 8;
export const BASE_GAME_STALL_TICKS = 60;

export const BASE_GAME_SHARED_KEYS = Object.freeze([
  'primaryBody',
  'todEnabled',
  'todHour',
  'todLatitude',
  'todDayOfYear',
  'todMoonPhase',
  'todSpeed',
  'todPlaying',
  'sunElevation',
  'sunAzimuth',
  'sunIntensity',
  'ambientIntensity',
]);

const NUMBER_LIMITS = Object.freeze({
  todHour: [0, 24],
  todLatitude: [-90, 90],
  todDayOfYear: [1, 365],
  todMoonPhase: [0, 24],
  todSpeed: [0, 600],
  sunElevation: [-90, 90],
  sunAzimuth: [0, 360],
  sunIntensity: [0, 4],
  ambientIntensity: [0, 2],
});

const STRING_VALUES = Object.freeze({ primaryBody: ['sun', 'moon'] });
const BOOLEAN_KEYS = new Set(['todEnabled', 'todPlaying']);
const MAX_ABS_YAW = 1e6;
const MAX_ABS_COORDINATE = 1e9;
const MAX_ABS_VELOCITY = 1e4;
const MAX_PITCH = Math.PI * 0.5;

export function normalizeBaseGameRoomCode(value) {
  const code = String(value ?? '').trim().toUpperCase();
  return /^[A-Z0-9_-]{2,16}$/.test(code) ? code : null;
}

export function sanitizeBaseGameWorldPatch(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const clean = {};
  for (const key of BASE_GAME_SHARED_KEYS) {
    const value = input[key];
    if (BOOLEAN_KEYS.has(key)) {
      if (typeof value === 'boolean') clean[key] = value;
      continue;
    }
    const allowed = STRING_VALUES[key];
    if (allowed) {
      if (typeof value === 'string' && allowed.includes(value)) clean[key] = value;
      continue;
    }
    const limits = NUMBER_LIMITS[key];
    if (!limits || !Number.isFinite(value)) continue;
    clean[key] = Math.max(limits[0], Math.min(limits[1], value));
  }
  if (clean.todHour === 24) clean.todHour = 0;
  return clean;
}

export function pickBaseGameSharedWorld(settings) {
  return sanitizeBaseGameWorldPatch(settings);
}

export function advanceBaseGameWorld(world, elapsedMs) {
  if (!world?.todEnabled || !world.todPlaying || !Number.isFinite(world.todSpeed)) return world;
  const elapsedSeconds = Math.max(0, Number(elapsedMs) || 0) / 1000;
  world.todHour = ((Number(world.todHour) || 0) + world.todSpeed * elapsedSeconds / 60) % 24;
  return world;
}

// ---- protocol 3: lockstep tick input and authoritative player state ----
// Every client simulation tick is its own input. The server consumes exactly one tick per
// simulation step, so client prediction and server authority compute identical arithmetic.

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function finiteVec3(value, limit) {
  return Array.isArray(value) && value.length === 3
    && value.every(component => Number.isFinite(component) && Math.abs(component) <= limit);
}

export function neutralBaseGameInput(yaw = 0, pitch = 0) {
  return { moveX: 0, moveZ: 0, yaw, pitch, sprint: false, jump: false };
}

// Returns a clean tick input or null. Identity is rejected when malformed; movement is clamped.
export function sanitizeBaseGameTickInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (!Number.isSafeInteger(input.tick) || input.tick < 1) return null;
  const moveX = Number(input.moveX);
  const moveZ = Number(input.moveZ);
  const yaw = Number(input.yaw);
  const pitch = Number(input.pitch);
  if (![moveX, moveZ, yaw, pitch].every(Number.isFinite)) return null;
  if (Math.abs(yaw) > MAX_ABS_YAW) return null;
  return {
    tick: input.tick,
    moveX: Math.max(-1, Math.min(1, moveX)),
    moveZ: Math.max(-1, Math.min(1, moveZ)),
    yaw,
    pitch: Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch)),
    sprint: input.sprint === true,
    jump: input.jump === true,
  };
}

// A packet carries strictly increasing consecutive-or-gapped ticks. Any bad tick rejects the packet.
export function sanitizeBaseGameInputPacket(packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return null;
  if (!Array.isArray(packet.ticks) || packet.ticks.length === 0 || packet.ticks.length > BASE_GAME_MAX_TICKS_PER_PACKET) return null;
  const ticks = [];
  let last = 0;
  for (const raw of packet.ticks) {
    const clean = sanitizeBaseGameTickInput(raw);
    if (!clean || clean.tick <= last) return null;
    last = clean.tick;
    ticks.push(clean);
  }
  const clientTime = Number.isFinite(packet.clientTime) && packet.clientTime >= 0 ? packet.clientTime : null;
  return { clientTime, ticks };
}

export function sanitizeBaseGamePlayerState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  if (!finiteVec3(state.position, MAX_ABS_COORDINATE)) return null;
  const velocity = state.velocity ?? [0, 0, 0];
  if (!finiteVec3(velocity, MAX_ABS_VELOCITY)) return null;
  const yaw = Number.isFinite(state.yaw) ? state.yaw : 0;
  const pitch = Number.isFinite(state.pitch) ? Math.max(-MAX_PITCH, Math.min(MAX_PITCH, state.pitch)) : 0;
  return {
    position: [...state.position],
    velocity: [...velocity],
    yaw,
    pitch,
    grounded: state.grounded === true,
    tick: nonNegativeInteger(state.tick) ? state.tick : 0,
    lastProcessedTick: nonNegativeInteger(state.lastProcessedTick) ? state.lastProcessedTick : 0,
    queueDepth: nonNegativeInteger(state.queueDepth) ? state.queueDepth : 0,
    spawnRevision: nonNegativeInteger(state.spawnRevision) ? state.spawnRevision : 0,
  };
}

// A tick is accepted only when newer than the last consumed one and not absurdly far ahead.
export function isAcceptableBaseGameTick(tick, lastConsumedTick, maxAhead = BASE_GAME_MAX_TICKS_AHEAD) {
  if (!Number.isSafeInteger(tick) || tick <= lastConsumedTick) return false;
  return tick - lastConsumedTick <= maxAhead;
}

// Token bucket. allow(at) returns true when a packet may be accepted at time `at` (ms).
export function createBaseGameRateLimiter({ hz = BASE_GAME_INPUT_HZ, burst = BASE_GAME_INPUT_BURST } = {}) {
  const intervalMs = 1000 / hz;
  let tokens = burst;
  let lastAt = null;
  return {
    allow(at) {
      if (lastAt != null) tokens = Math.min(burst, tokens + Math.max(0, at - lastAt) / intervalMs);
      lastAt = at;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
    get tokens() { return tokens; },
  };
}
