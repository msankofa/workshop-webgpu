import { normalizeDescriptor } from './terrain-source.js';
import { normalizeProject, hashProject, classifyProject } from './terrain-project-v5.js';
import {
  BASE_GAME_BODY_MODEL_IDS,
  DEFAULT_BASE_GAME_BODY_MODEL,
  bodyModelById,
  hitProfileForBodyModel,
  sanitizeBaseGameBodyModel,
} from './base-game-body-models.js';

export const BASE_GAME_PROTOCOL_VERSION = 12;
// Firing (phase 3): the tick's `fire` is consumed by the server, ammo and health are authoritative,
// and snapshots carry one-shot `hits` / `deaths` events for feedback.
export const BASE_GAME_LAG_COMP_MS = 100;             // rewind victims by the client interpolation delay
export const BASE_GAME_RESPAWN_TICKS = 360;           // 3 s dead before the server respawns
export const BASE_GAME_FIRE_ACTION_TICKS = 12;        // a fire action stays visible for two snapshot intervals
export const BASE_GAME_MAX_HEALTH = 100;
// Weapons (phase 1): a loadout is four slots; the tick carries the active slot and the server echoes
// the resolved weapon id. Only ids in BASE_GAME_WEAPON_IDS are accepted; 'none' empties a slot.
export const BASE_GAME_WEAPON_IDS = Object.freeze(['none', 'm1911', 'five_seven', 'm24', 'cz_805_bren', 'knife', 'grenade', 'rpg']);
export const BASE_GAME_RELOADABLE_WEAPONS = Object.freeze(['m1911', 'five_seven', 'm24', 'cz_805_bren', 'rpg']);
export const BASE_GAME_WEAPON_SLOTS = Object.freeze(['primary', 'sidearm', 'melee', 'throwable']);
export const BASE_GAME_DEFAULT_LOADOUT = Object.freeze({ primary: 'cz_805_bren', sidearm: 'five_seven', melee: 'knife', throwable: 'grenade' });
// Posture. Travels as an index, not a string: it rides every tick. bot-stance.js owns the names and
// all the maths; this is only the wire form. 'crouch' has no key bound yet but stays in the ladder
// because the stance fallback chain (prone -> kneel -> crouch -> stand) reads it.
export const BASE_GAME_STANCES = Object.freeze(['stand', 'crouch', 'kneel', 'prone']);
export const stanceName = (index) => BASE_GAME_STANCES[index] ?? 'stand';
export const stanceIndex = (name) => Math.max(0, BASE_GAME_STANCES.indexOf(name));

export const BASE_GAME_WEAPON_ACTION = Object.freeze({ idle: 0, reload: 1, fire: 2, holster: 3, draw: 4, throw: 5 });
export const BASE_GAME_MAX_WEAPON_ACTION = Math.max(...Object.values(BASE_GAME_WEAPON_ACTION));
export const BASE_GAME_RELOAD_TICKS = 180;           // 1.5 s at SIM_HZ; the server clears the action after this
export const BASE_GAME_POSITION_HISTORY = 32;        // per-client server positions kept for lag compensation (phase 3)
export const BASE_GAME_HIT_ZONES = Object.freeze(['head', 'neck', 'torso', 'pelvis', 'upperArm', 'lowerArm', 'hand', 'thigh', 'calf', 'foot']);
export const BASE_GAME_HIT_SIDES = Object.freeze(['center', 'left', 'right']);
export const BASE_GAME_TERRAIN_CONFIG_MAX_BYTES = 512 * 1024;
export const BASE_GAME_TERRAIN_KINDS = Object.freeze(['traversalLab', 'terrain']);
export const BASE_GAME_ROOM_GRACE_MS = 30_000;
export const BASE_GAME_ROOM_PLAYER_CAP = 16;
export const BASE_GAME_SERVER_TICK_HZ = 60;
export const BASE_GAME_SNAPSHOT_HZ = 20;
export const BASE_GAME_INPUT_HZ = 30;
export const BASE_GAME_INPUT_BURST = 10;
export const BASE_GAME_SIM_HZ = 120;
export const BASE_GAME_MAX_TICKS_PER_PACKET = 64;
export const BASE_GAME_MAX_TICKS_AHEAD = 240;
export const BASE_GAME_MAX_PENDING_TICKS = 256;
export const BASE_GAME_TICK_QUEUE_TARGET = 3;
export const BASE_GAME_TICK_QUEUE_DRAIN = 8;
export const BASE_GAME_STALL_TICKS = 60;

export const BASE_GAME_SEA_LEVEL_LIMITS = Object.freeze([-120, 120]);   // matches the v5 sea_level field

export const BASE_GAME_SHARED_KEYS = Object.freeze([
  // A match rule, not decoration: ammo is server-authoritative, so an unlimited magazine has to be
  // the owner's to set and everyone's to obey, exactly like whether there is a sea.
  'unlimitedAmmo',
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
  // water: whether there is a sea at all, and the wave spectrum every peer simulates
  // (water-waves.js buildWaveTable inputs). Both are physics, not decoration: swimming reads them.
  'waterEnabled',
  'waveCount',
  'waveBaseLength',
  'waveLengthMul',
  'waveBaseAmp',
  'waveAmpMul',
  'waveChop',
  'waveWindDeg',
  'waveSpreadDeg',
  'waveDispersion',
  'waveSpeed',
  'waveSeed',
  // weather: what the weather IS, as opposed to how a client chooses to draw it. The lid and the
  // master change how far and how well everyone can see, and the decks are the sky's identity, so
  // they are the owner's to set. The response curves (fog per unit, sun dimming), the drop budget
  // and the rest of the cloud look stay local, the same split the wave spectrum/appearance uses.
  'weatherRain',
  'weatherOvercast',
  'cloudACover',
  'cloudAHeight',
  'cloudBCover',
  'cloudBHeight',
  // Wind is what the weather IS, not how it is drawn: it leans every peer's drops the same way and
  // it is what the wave heading already agrees with. The drop budget and look stay local.
  'weatherWindDeg',
  'weatherWindSpeed',
  'weatherGust',
  'weatherGustPeriod',
  // Lightning is derived, not sent: a strike is a pure function of the seed and its index, so every
  // client computes the same bolt in the same place at the same moment and a late joiner is in
  // phase. That only holds while everyone shares the inputs, so the seed and every term of the
  // schedule are owner-owned. The flash strength, bolt scale and sun lift are look, and stay local.
  'weatherSeed',
  'lightningEnabled',
  'lightningThreshold',
  'lightningInterval',
  'lightningIntervalSpread',
  'lightningDistMin',
  'lightningDistMax',
]);

const NUMBER_LIMITS = Object.freeze({
  waveCount: [1, 40],
  waveBaseLength: [1, 5000],
  waveLengthMul: [0.05, 1],
  waveBaseAmp: [0, 50],
  waveAmpMul: [0.05, 1],
  waveChop: [0, 1],
  waveWindDeg: [0, 360],
  waveSpreadDeg: [0, 180],
  waveSpeed: [0, 100],
  waveSeed: [0, 1e9],
  todHour: [0, 24],
  todLatitude: [-90, 90],
  todDayOfYear: [1, 365],
  todMoonPhase: [0, 24],
  todSpeed: [0, 600],
  sunElevation: [-90, 90],
  sunAzimuth: [0, 360],
  sunIntensity: [0, 4],
  ambientIntensity: [0, 2],
  weatherRain: [0, 1],
  weatherOvercast: [0, 1],
  cloudACover: [0, 1],
  cloudAHeight: [0, 10000],
  cloudBCover: [0, 1],
  cloudBHeight: [0, 10000],
  weatherWindDeg: [0, 360],
  weatherWindSpeed: [0, 60],
  weatherGust: [0, 40],
  weatherGustPeriod: [0.5, 60],
  weatherSeed: [0, 1e9],
  lightningThreshold: [0, 1],
  lightningInterval: [0.5, 300],
  lightningIntervalSpread: [0, 1],
  lightningDistMin: [20, 20000],
  lightningDistMax: [50, 40000],
});

const STRING_VALUES = Object.freeze({ primaryBody: ['sun', 'moon'] });
const BOOLEAN_KEYS = new Set(['todEnabled', 'todPlaying', 'waveDispersion', 'waterEnabled', 'lightningEnabled', 'unlimitedAmmo']);
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
  if (clean.waveCount != null) clean.waveCount = Math.round(clean.waveCount);
  if (clean.waveSeed != null) clean.waveSeed = Math.round(clean.waveSeed);
  return clean;
}

// The wave table inputs (water-waves.js) carried by a shared world; missing keys keep the defaults.
export const BASE_GAME_WAVE_KEY_MAP = Object.freeze({
  waveCount: 'count', waveBaseLength: 'baseLength', waveLengthMul: 'lengthMul', waveBaseAmp: 'baseAmp',
  waveAmpMul: 'ampMul', waveChop: 'chop', waveWindDeg: 'windDeg', waveSpreadDeg: 'spreadDeg',
  waveDispersion: 'dispersion', waveSpeed: 'speed', waveSeed: 'seed',
});
export function waveOptionsFromWorld(world) {
  const out = {};
  if (!world) return out;
  for (const [key, name] of Object.entries(BASE_GAME_WAVE_KEY_MAP)) if (world[key] != null) out[name] = world[key];
  return out;
}

export function pickBaseGameSharedWorld(settings) {
  return sanitizeBaseGameWorldPatch(settings);
}

// ---- protocol 4: room-owned terrain ----
// The room owner chooses the authoritative ground at create time. Accepted shapes:
//   { kind: 'traversalLab' }
//   { kind: 'terrain', descriptor, volumetric? }   descriptor = terrain-source.js descriptor
//                                     (analytic, or a v5-recipe whose config.project is
//                                     runtime-supported); volumetric needs a v5 density field
// The descriptor is re-normalized and (for v5) the project is re-hashed here, so a client can
// never smuggle an arbitrary blob. The owner may replace a room's config at any time
// (`base:set_terrain`); everyone respawns on the new ground.
// A v5 descriptor may carry the project body (`config.project`) or only `config.projectHash`;
// the latter is resolved through `resolveProject(hash)` (the relay's terrain store, or a client
// cache) and fails with `unknown_terrain` when nothing has it.
// Returns { config, error, code? }. `config.worldVersion` is the string every peer must agree on.
export function sanitizeBaseGameTerrainConfig(input, { resolveProject = null } = {}) {
  if (input == null) return { config: { kind: 'traversalLab', worldVersion: 'traversal-lab' }, error: null };
  if (typeof input !== 'object' || Array.isArray(input)) return { config: null, error: 'terrain config must be an object' };
  if (input.kind === 'traversalLab') return { config: { kind: 'traversalLab', worldVersion: 'traversal-lab' }, error: null };
  if (input.kind !== 'terrain') return { config: null, error: `unknown terrain kind ${String(input.kind)}` };
  const volumetric = input.volumetric === true;
  let text;
  try { text = JSON.stringify(input.descriptor); } catch { return { config: null, error: 'terrain descriptor is not serializable' }; }
  if (!text || text.length > BASE_GAME_TERRAIN_CONFIG_MAX_BYTES) return { config: null, error: `terrain descriptor exceeds ${BASE_GAME_TERRAIN_CONFIG_MAX_BYTES} bytes` };
  let descriptor;
  try { descriptor = normalizeDescriptor(input.descriptor); } catch (err) { return { config: null, error: `bad terrain descriptor: ${err.message}` }; }
  let projectHash = null;
  if (descriptor.kind === 'v5-recipe') {
    let body = descriptor.config.project;
    if (body == null && typeof descriptor.config.projectHash === 'string') {
      body = resolveProject ? resolveProject(descriptor.config.projectHash) : null;
      if (!body) return { config: null, error: `terrain project ${descriptor.config.projectHash.slice(0, 12)}… is not published here`, code: 'unknown_terrain' };
    }
    let project;
    try { project = normalizeProject(body).project; } catch (err) { return { config: null, error: `bad v5 project: ${err.message}` }; }
    const cls = classifyProject(project);
    if (!cls.runtimeSupported) return { config: null, error: `v5 project is not streamable: ${cls.reasons.join('; ')}` };
    projectHash = hashProject(project);
    if (descriptor.config.projectHash && descriptor.config.projectHash !== projectHash) return { config: null, error: 'v5 project hash does not match its project' };
    descriptor = normalizeDescriptor({ ...descriptor, config: { project, projectHash } });
  } else if (descriptor.kind !== 'analytic') {
    return { config: null, error: `terrain kind ${descriptor.kind} is not available in multiplayer` };
  }
  if (volumetric && descriptor.kind !== 'v5-recipe') return { config: null, error: 'volumetric terrain needs a v5 project with a density field' };
  const seaLevel = Math.max(BASE_GAME_SEA_LEVEL_LIMITS[0], Math.min(BASE_GAME_SEA_LEVEL_LIMITS[1], descriptor.seaLevel ?? 0));
  if (seaLevel !== descriptor.seaLevel) descriptor = normalizeDescriptor({ ...descriptor, seaLevel });
  // a v5 project's sea level is inside its hash already; the analytic source's is only here
  const seaTag = seaLevel !== 0 ? `:sea${seaLevel}` : '';
  const worldVersion = `terrain:${descriptor.kind}:${descriptor.key}@${descriptor.sourceVersion}:${descriptor.algorithmVersion}${volumetric ? ':volume' : ''}${seaTag}`;
  return { config: { kind: 'terrain', descriptor, projectHash, volumetric, worldVersion }, error: null };
}

// The wire form of a room config: the v5 project body is replaced by its hash (the relay stores
// projects by hash; clients fetch what they lack with base:terrain_get). Everything else is kept.
export function publicBaseGameTerrainConfig(config) {
  if (!config || config.kind !== 'terrain' || config.descriptor?.kind !== 'v5-recipe') return config;
  return { ...config, descriptor: { ...config.descriptor, config: { projectHash: config.projectHash } } };
}
// True when a received config needs its project body fetched before it can be rebuilt locally.
export function terrainConfigNeedsProject(config) {
  return !!config && config.kind === 'terrain' && config.descriptor?.kind === 'v5-recipe' && config.descriptor.config?.project == null;
}
// The project hash a config refers to (null for non-v5 ground).
export function terrainConfigProjectHash(config) {
  if (!config || config.kind !== 'terrain' || config.descriptor?.kind !== 'v5-recipe') return null;
  return config.projectHash ?? config.descriptor.config?.projectHash ?? null;
}
// A wire config plus its fetched project body: the full descriptor clients build sources from.
export function withTerrainProject(config, project) {
  if (!terrainConfigNeedsProject(config)) return config;
  return { ...config, descriptor: { ...config.descriptor, config: { project, projectHash: terrainConfigProjectHash(config) } } };
}

// What snapshots carry about the ground: identity only, never the project body.
export function describeBaseGameTerrainConfig(config) {
  if (!config) return null;
  return { kind: config.kind, worldVersion: config.worldVersion, projectHash: config.projectHash ?? null, sourceKey: config.descriptor?.key ?? null, sourceVersion: config.descriptor?.sourceVersion ?? null, volumetric: config.volumetric === true };
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
  return { moveX: 0, moveZ: 0, yaw, pitch, sprint: false, crouch: false, stance: 0, jump: false, slot: 0, aim: false, reload: false, fire: false, throw: false };
}

export function sanitizeBaseGameLoadout(loadout) {
  const clean = { ...BASE_GAME_DEFAULT_LOADOUT };
  if (!loadout || typeof loadout !== 'object') return clean;
  for (const slot of BASE_GAME_WEAPON_SLOTS) {
    const id = loadout[slot];
    if (typeof id === 'string' && BASE_GAME_WEAPON_IDS.includes(id)) clean[slot] = id;
  }
  return clean;
}

export function weaponForSlot(loadout, slot) {
  const id = loadout?.[BASE_GAME_WEAPON_SLOTS[slot] ?? 'primary'];
  return id && id !== 'none' ? id : null;
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
    crouch: input.crouch === true,   // swim down; older clients omit it and never sink
    stance: Number.isInteger(input.stance) && input.stance >= 0 && input.stance < BASE_GAME_STANCES.length ? input.stance : 0,
    jump: input.jump === true,
    slot: Number.isInteger(input.slot) && input.slot >= 0 && input.slot < BASE_GAME_WEAPON_SLOTS.length ? input.slot : 0,
    aim: input.aim === true,
    reload: input.reload === true,
    fire: input.fire === true,
    throw: input.throw === true,   // quick-throw: the throwable slot, without holstering the held weapon
  };
}

function cleanAmmo(ammo) {
  if (!ammo || typeof ammo !== 'object') return null;
  const mag = ammo.mag === null ? Infinity : Number(ammo.mag);
  const reserve = Number(ammo.reserve);
  if (!(mag >= 0) || !Number.isFinite(reserve) || reserve < 0) return null;
  return { mag, reserve };
}
// Infinity does not survive JSON: a bottomless magazine travels as null.
export function wireAmmo(state) {
  if (!state) return null;
  return { mag: Number.isFinite(state.mag) ? state.mag : null, reserve: Number.isFinite(state.reserve) ? state.reserve : 0 };
}

export function sanitizeBaseGameHitEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (typeof event.shooter !== 'string' || typeof event.victim !== 'string') return null;
  if (!finiteVec3(event.point, MAX_ABS_COORDINATE)) return null;
  const damage = Number(event.damage);
  if (!Number.isFinite(damage) || damage < 0) return null;
  const normal = finiteVec3(event.normal, 2) ? [...event.normal] : null;
  const zone = BASE_GAME_HIT_ZONES.includes(event.zone) ? event.zone : null;
  const side = BASE_GAME_HIT_SIDES.includes(event.side) ? event.side : 'center';
  return {
    shooter: event.shooter,
    victim: event.victim,
    point: [...event.point],
    normal,
    damage,
    zone,
    side,
    head: zone === 'head' || event.head === true,
    tick: nonNegativeInteger(event.tick) ? event.tick : 0,
  };
}

// A resolved shot, for tracers on every client: where it left and where it ended.
export function sanitizeBaseGameShotEvent(event) {
  if (!event || typeof event !== 'object' || typeof event.shooter !== 'string') return null;
  if (!finiteVec3(event.origin, MAX_ABS_COORDINATE) || !finiteVec3(event.end, MAX_ABS_COORDINATE)) return null;
  const dir = finiteVec3(event.dir, 2) ? [...event.dir] : null;
  const normal = finiteVec3(event.normal, 2) ? [...event.normal] : null;
  const weapon = typeof event.weapon === 'string' && BASE_GAME_WEAPON_IDS.includes(event.weapon) ? event.weapon : null;
  return { shooter: event.shooter, weapon, origin: [...event.origin], dir, normal, end: [...event.end], kind: typeof event.kind === 'string' ? event.kind : 'none', tick: nonNegativeInteger(event.tick) ? event.tick : 0 };
}

export function sanitizeBaseGameExplosionEvent(event) {
  if (!event || typeof event !== 'object' || !finiteVec3(event.p, MAX_ABS_COORDINATE)) return null;
  const radius = Number(event.radius);
  if (!Number.isFinite(radius) || radius <= 0) return null;
  // `contact` = the blast touched a surface (combat-projectile's impact/ground/rest causes), which
  // is what decides whether anything is torn out of that surface.
  return { p: [...event.p], radius, owner: typeof event.owner === 'string' ? event.owner : null, weapon: typeof event.weapon === 'string' ? event.weapon : null, contact: event.contact === true, tick: nonNegativeInteger(event.tick) ? event.tick : 0 };
}

// A live server projectile: position and velocity so a client can place it between snapshots.
export function sanitizeBaseGameProjectileState(state) {
  if (!state || typeof state !== 'object' || typeof state.id !== 'string') return null;
  if (!finiteVec3(state.p, MAX_ABS_COORDINATE)) return null;
  const v = finiteVec3(state.v, MAX_ABS_VELOCITY) ? [...state.v] : [0, 0, 0];
  const color = finiteVec3(state.color, 4) ? [...state.color] : [1, 0.5, 0.2];
  return { id: state.id, p: [...state.p], v, color, weapon: typeof state.weapon === 'string' ? state.weapon : null, owner: typeof state.owner === 'string' ? state.owner : null, radius: Number.isFinite(state.radius) && state.radius > 0 ? state.radius : 0.4 };
}

export function sanitizeBaseGameDeathEvent(event) {
  if (!event || typeof event !== 'object' || typeof event.victim !== 'string') return null;
  return { victim: event.victim, killer: typeof event.killer === 'string' ? event.killer : null, tick: nonNegativeInteger(event.tick) ? event.tick : 0 };
}

// A packet carries consecutive ticks (each exactly previous + 1). Any bad tick rejects the packet.
export function sanitizeBaseGameInputPacket(packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) return null;
  if (!Array.isArray(packet.ticks) || packet.ticks.length === 0 || packet.ticks.length > BASE_GAME_MAX_TICKS_PER_PACKET) return null;
  const ticks = [];
  let last = 0;
  for (const raw of packet.ticks) {
    const clean = sanitizeBaseGameTickInput(raw);
    if (!clean || (last > 0 && clean.tick !== last + 1)) return null;
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
  const bodyModel = sanitizeBaseGameBodyModel(state.bodyModel);
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
    slot: Number.isInteger(state.slot) && state.slot >= 0 && state.slot < BASE_GAME_WEAPON_SLOTS.length ? state.slot : 0,
    weapon: typeof state.weapon === 'string' && BASE_GAME_WEAPON_IDS.includes(state.weapon) && state.weapon !== 'none' ? state.weapon : null,
    aiming: state.aiming === true,
    // Posture as an index; remotes ease their own weights toward it, which is smoother than
    // resampling three floats at the 20 Hz snapshot rate and cheaper on the wire.
    stance: Number.isInteger(state.stance) && state.stance >= 0 && state.stance < BASE_GAME_STANCES.length ? state.stance : 0,
    action: Number.isInteger(state.action) && state.action >= 0 && state.action <= BASE_GAME_MAX_WEAPON_ACTION ? state.action : 0,
    actionTick: nonNegativeInteger(state.actionTick) ? state.actionTick : 0,
    health: Number.isFinite(state.health) ? Math.max(0, Math.min(BASE_GAME_MAX_HEALTH, state.health)) : BASE_GAME_MAX_HEALTH,
    dead: state.dead === true,
    ammo: cleanAmmo(state.ammo),
    // The whole loadout, not just what is in hand: a remote's stowed guns are the slots it is NOT
    // holding, and nothing else on the wire says what those are.
    loadout: sanitizeBaseGameLoadout(state.loadout),
    bodyModel,
    hitProfile: hitProfileForBodyModel(bodyModel),
    poseEpoch: nonNegativeInteger(state.poseEpoch) ? state.poseEpoch : 0,
  };
}

export {
  BASE_GAME_BODY_MODEL_IDS,
  DEFAULT_BASE_GAME_BODY_MODEL,
  bodyModelById,
  hitProfileForBodyModel,
  sanitizeBaseGameBodyModel,
};

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
