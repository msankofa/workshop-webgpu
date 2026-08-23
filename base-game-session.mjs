import {
  BASE_GAME_INPUT_HZ,
  BASE_GAME_MAX_PENDING_TICKS,
  BASE_GAME_MAX_TICKS_PER_PACKET,
  BASE_GAME_PROTOCOL_VERSION,
  sanitizeBaseGameLoadout,
  normalizeBaseGameRoomCode,
  pickBaseGameSharedWorld,
  sanitizeBaseGamePlayerState,
  sanitizeBaseGameTickInput,
  sanitizeBaseGameWorldPatch,
  terrainConfigNeedsProject,
  terrainConfigProjectHash,
  withTerrainProject,
} from './base-game-protocol.mjs';

const query = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
export const BASE_GAME_RELAY_URL = query.get('relay') || 'wss://workshop-webgpu.onrender.com';

export function connectBaseGameSession({
  mode,
  roomCode,
  world,
  terrain = null,
  onSnapshot = () => {},
  onStatus = () => {},
  // Fired with the room's full terrain config whenever the owner replaces the world.
  onTerrain = () => {},
  relayUrl = BASE_GAME_RELAY_URL,
  WebSocketImpl = globalThis.WebSocket,
  handshakeTimeoutMs = 8_000,
  inputHz = BASE_GAME_INPUT_HZ,
  now = () => (typeof performance === 'undefined' ? Date.now() : performance.now()),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const room = normalizeBaseGameRoomCode(roomCode);
  if (!['create', 'join'].includes(mode)) return Promise.reject(new Error('Session mode must be create or join'));
  if (!room) return Promise.reject(new Error('Room codes use 2-16 letters, numbers, _ or -'));
  if (!WebSocketImpl) return Promise.reject(new Error('WebSocket is unavailable'));

  let ws = null;
  let stopped = false;
  let reconnectTimer = 0;
  let reconnectDelay = 1_000;
  let resumeToken = null;
  let clientId = null;
  let owner = false;
  let roomTerrain = null;
  const terrainWaiters = [];
  // Published projects by hash: what this client has sent or fetched. Wire configs carry only
  // the hash; a config is handed to the page only once its body is here.
  const projectCache = new Map();
  const projectWaiters = new Map();   // hash -> [{ resolve, reject }]
  let terrainResolved = true;         // false while the joined config's body is being fetched

  // Strip a config for the wire, publishing its project body first (idempotent on the relay).
  function publishConfig(config) {
    const body = config?.descriptor?.config?.project;
    if (!body || config.descriptor.kind !== 'v5-recipe') return config;   // nothing to publish: synchronous
    return new Promise((resolve, reject) => {
      const key = '__put';
      const list = projectWaiters.get(key) ?? [];
      list.push({ resolve: ref => {
        projectCache.set(ref, body);
        resolve({ ...config, descriptor: { ...config.descriptor, config: { projectHash: ref } } });
      }, reject });
      projectWaiters.set(key, list);
      ws.send(JSON.stringify({ type: 'base:terrain_put', protocol: BASE_GAME_PROTOCOL_VERSION, project: body }));
    });
  }
  // Fill a wire config's project body from the cache or the relay.
  function resolveConfig(config) {
    if (!terrainConfigNeedsProject(config)) return Promise.resolve(config);
    const hash = terrainConfigProjectHash(config);
    const cached = hash && projectCache.get(hash);
    if (cached) return Promise.resolve(withTerrainProject(config, cached));
    return new Promise((resolve, reject) => {
      const list = projectWaiters.get(hash) ?? [];
      list.push({ resolve: project => resolve(withTerrainProject(config, project)), reject });
      projectWaiters.set(hash, list);
      if (list.length === 1) ws.send(JSON.stringify({ type: 'base:terrain_get', protocol: BASE_GAME_PROTOCOL_VERSION, projectHash: hash }));
    });
  }
  function settleWaiters(key, project, error) {
    const list = projectWaiters.get(key);
    if (!list) return;
    projectWaiters.delete(key);
    for (const w of list) error ? w.reject(error) : w.resolve(project);
  }
  let latestSnapshot = null;
  let initialSettled = false;
  let joinedSeen = false;
  let snapshotSeen = false;
  let resolveInitial;
  let rejectInitial;
  let handshakeTimer = 0;

  // Input sending: every local simulation tick is queued, and at most `inputHz` packets per second
  // carry the oldest unacknowledged ticks, so a lost packet costs nothing and no tick is skipped.
  // A backlog the server can never catch up on is resolved by an explicit resync, never by
  // silently dropping ticks.
  const inputIntervalMs = 1000 / inputHz;
  const pendingTicks = [];
  let lastInputSentAt = -Infinity;
  let inputTimer = 0;
  const stats = {
    inputsSent: 0,
    ticksQueued: 0,
    snapshotsReceived: 0,
    resyncs: 0,
    lastAckedTick: 0,
    serverTick: 0,
    serverTimeOffsetMs: null,
    pingMs: null,
    lastSnapshotAt: null,
  };

  const initial = new Promise((resolve, reject) => { resolveInitial = resolve; rejectInitial = reject; });

  function scheduleFlush(delay) {
    if (!inputTimer) inputTimer = setTimer(flushInput, delay);
  }

  function flushInput() {
    inputTimer = 0;
    if (pendingTicks.length === 0 || ws?.readyState !== WebSocketImpl.OPEN) return;
    const at = now();
    const wait = inputIntervalMs - (at - lastInputSentAt);
    if (wait > 0) { scheduleFlush(wait); return; }
    const ticks = pendingTicks.slice(0, BASE_GAME_MAX_TICKS_PER_PACKET);
    ws.send(JSON.stringify({ type: 'base:input', protocol: BASE_GAME_PROTOCOL_VERSION, clientTime: Math.round(at), ticks }));
    lastInputSentAt = at;
    stats.inputsSent++;
    // Unacknowledged ticks stay queued and go out again next interval until a snapshot acks them.
    scheduleFlush(inputIntervalMs);
  }

  const api = {
    get roomCode() { return room; },
    get clientId() { return clientId; },
    get owner() { return owner; },
    // The room's authoritative terrain config (from base:joined); null until joined.
    get terrain() { return roomTerrain; },
    get connected() { return ws?.readyState === WebSocketImpl.OPEN; },
    get latestSnapshot() { return latestSnapshot; },
    get stats() { return { ...stats }; },
    get pendingTickCount() { return pendingTicks.length; },
    get localPlayer() {
      return latestSnapshot?.players?.find(player => player.id === clientId) ?? null;
    },
    // Owner only: replace the room's ground. Resolves with the room's new config once the
    // server echoes it (every client, this one included, adopts it from that echo).
    setTerrain(config) {
      if (!owner || ws?.readyState !== WebSocketImpl.OPEN) return Promise.reject(new Error('only the connected room owner can change the world'));
      return Promise.resolve(publishConfig(config)).then(wire => new Promise((resolve, reject) => {
        terrainWaiters.push({ resolve, reject });
        ws.send(JSON.stringify({ type: 'base:set_terrain', protocol: BASE_GAME_PROTOCOL_VERSION, terrain: wire }));
      }));
    },
    // Projects this client has published or fetched, by hash (for the page's own caches).
    projectByHash(hash) { return projectCache.get(hash) ?? null; },
    setWorld(patch) {
      if (!owner || ws?.readyState !== WebSocketImpl.OPEN) return false;
      const clean = sanitizeBaseGameWorldPatch(patch);
      if (!Object.keys(clean).length) return false;
      ws.send(JSON.stringify({ type: 'base:set_world', protocol: BASE_GAME_PROTOCOL_VERSION, patch: clean }));
      return true;
    },
    // Queues one simulation tick for delivery. Returns false for a malformed or non-consecutive tick.
    queueTick(tickInput) {
      const clean = sanitizeBaseGameTickInput(tickInput);
      if (!clean) return false;
      const last = pendingTicks[pendingTicks.length - 1];
      if (last && clean.tick !== last.tick + 1) return false;
      if (clean.tick <= stats.lastAckedTick) return false;
      if (pendingTicks.length >= BASE_GAME_MAX_PENDING_TICKS) {
        api.requestResync();
      }
      pendingTicks.push(clean);
      stats.ticksQueued++;
      scheduleFlush(0);
      return true;
    },
    // Abandons the unacknowledged backlog and asks the server to adopt the next tick numbering.
    // The server answers with a bumped spawn revision, which hard-snaps local prediction.
    // Replaces this player's loadout on the server; the snapshot echoes the resolved weapon.
    setLoadout(loadout) {
      if (ws?.readyState !== WebSocketImpl.OPEN) return false;
      ws.send(JSON.stringify({ type: 'base:loadout', protocol: BASE_GAME_PROTOCOL_VERSION, loadout: sanitizeBaseGameLoadout(loadout) }));
      return true;
    },
    requestResync() {
      pendingTicks.length = 0;
      stats.resyncs++;
      if (ws?.readyState !== WebSocketImpl.OPEN) return false;
      ws.send(JSON.stringify({ type: 'base:resync', protocol: BASE_GAME_PROTOCOL_VERSION }));
      return true;
    },
    // Sends whatever is queued right now, ignoring the pacing window (Main Menu, page hide).
    flushInput() {
      lastInputSentAt = -Infinity;
      clearTimer(inputTimer);
      inputTimer = 0;
      flushInput();
    },
    clearPendingTicks() { pendingTicks.length = 0; },
    requestRespawn() {
      if (ws?.readyState !== WebSocketImpl.OPEN) return false;
      pendingTicks.length = 0;
      ws.send(JSON.stringify({ type: 'base:respawn', protocol: BASE_GAME_PROTOCOL_VERSION }));
      return true;
    },
    destroy() {
      stopped = true;
      clearTimer(reconnectTimer);
      clearTimer(inputTimer);
      reconnectTimer = 0;
      inputTimer = 0;
      if (ws) {
        ws.onclose = null;
        ws.close(1000, 'left room');
        ws = null;
      }
      onStatus({ state: 'closed', room, owner: false });
    },
  };

  function maybeResolveInitial() {
    if (initialSettled || !joinedSeen || !snapshotSeen || !terrainResolved || latestSnapshot?.worldReady !== true) return;
    initialSettled = true;
    clearTimer(handshakeTimer);
    resolveInitial(api);
  }

  function failInitial(error) {
    if (initialSettled) return;
    initialSettled = true;
    stopped = true;
    clearTimer(handshakeTimer);
    clearTimer(reconnectTimer);
    if (ws) {
      ws.onclose = null;
      ws.close(1000, 'session rejected');
      ws = null;
    }
    rejectInitial(error);
  }

  function trackSnapshot(packet) {
    const at = now();
    stats.snapshotsReceived++;
    stats.lastSnapshotAt = at;
    stats.serverTick = packet.tick ?? 0;
    if (Number.isFinite(packet.serverTime)) {
      const offset = packet.serverTime - at;
      stats.serverTimeOffsetMs = stats.serverTimeOffsetMs == null ? offset : stats.serverTimeOffsetMs + (offset - stats.serverTimeOffsetMs) * 0.1;
    }
    const local = packet.players?.find(player => player.id === clientId);
    if (local) {
      const ack = Number.isSafeInteger(local.lastProcessedTick) ? local.lastProcessedTick : 0;
      stats.lastAckedTick = Math.max(stats.lastAckedTick, ack);
      let drop = 0;
      while (drop < pendingTicks.length && pendingTicks[drop].tick <= ack) drop++;
      if (drop > 0) pendingTicks.splice(0, drop);
      if (Number.isFinite(local.lastInputClientTime)) {
        const rtt = at - local.lastInputClientTime;
        if (rtt >= 0 && rtt < 10_000) stats.pingMs = stats.pingMs == null ? rtt : stats.pingMs + (rtt - stats.pingMs) * 0.2;
      }
    }
  }

  function connect(reconnecting = false) {
    if (stopped) return;
    onStatus({ state: reconnecting ? 'reconnecting' : 'connecting', room, owner });
    ws = new WebSocketImpl(relayUrl);

    ws.onopen = () => {
      reconnectDelay = 1_000;
      if (resumeToken) { ws.send(JSON.stringify({ type: 'base:resume', protocol: BASE_GAME_PROTOCOL_VERSION, resumeToken })); return; }
      if (mode !== 'create') { ws.send(JSON.stringify({ type: 'base:join', protocol: BASE_GAME_PROTOCOL_VERSION, room })); return; }
      // Create: the project body is published first, the create carries its hash.
      const sendCreate = wire => {
        if (ws?.readyState !== WebSocketImpl.OPEN) return;
        ws.send(JSON.stringify({ type: 'base:create', protocol: BASE_GAME_PROTOCOL_VERSION, room, world: pickBaseGameSharedWorld(world), terrain: wire }));
      };
      const wire = publishConfig(terrain ?? { kind: 'traversalLab' });
      if (wire && typeof wire.then === 'function') wire.then(sendCreate, failInitial); else sendCreate(wire);
    };

    ws.onmessage = event => {
      let packet;
      try { packet = JSON.parse(event.data); } catch { return; }
      if (packet.type === 'base:error') {
        const error = new Error(packet.message || packet.code || 'Multiplayer error');
        error.code = packet.code;
        if (packet.code === 'invalid_terrain' || packet.code === 'world_failed' || packet.code === 'not_owner') {
          for (const w of terrainWaiters.splice(0)) w.reject(error);
          settleWaiters('__put', null, error);
        }
        if (packet.code === 'unknown_terrain') { for (const key of [...projectWaiters.keys()]) if (key !== '__put') settleWaiters(key, null, error); }
        onStatus({ state: 'error', room, owner, error });
        if (!joinedSeen) failInitial(error);
        else if (packet.code === 'resume_expired' || packet.code === 'protocol_mismatch') {
          stopped = true;
          clearTimer(reconnectTimer);
          if (ws) { ws.onclose = null; ws.close(1000, 'session expired'); ws = null; }
        }
        return;
      }
      if (packet.type === 'base:joined') {
        clientId = packet.clientId;
        resumeToken = packet.resumeToken;
        owner = !!packet.owner;
        joinedSeen = true;
        onStatus({ state: 'connected', room, clientId, owner });
        // The joined config may carry only a project hash: fetch the body before settling.
        terrainResolved = false;
        resolveConfig(packet.terrain ?? { kind: 'traversalLab', worldVersion: 'traversal-lab' }).then(full => {
          roomTerrain = full;
          terrainResolved = true;
          maybeResolveInitial();
        }, failInitial);
        return;
      }
      if (packet.type === 'base:terrain_ref') {
        if (typeof packet.projectHash === 'string') settleWaiters('__put', packet.projectHash, null);
        return;
      }
      if (packet.type === 'base:terrain_project') {
        if (typeof packet.projectHash === 'string' && packet.project) { projectCache.set(packet.projectHash, packet.project); settleWaiters(packet.projectHash, packet.project, null); }
        return;
      }
      if (packet.type === 'base:terrain') {
        if (packet.protocol !== BASE_GAME_PROTOCOL_VERSION || packet.room !== room || !packet.terrain) return;
        resolveConfig(packet.terrain).then(full => {
          roomTerrain = full;
          for (const w of terrainWaiters.splice(0)) w.resolve(full);
          onTerrain(full, api);
        }, error => { for (const w of terrainWaiters.splice(0)) w.reject(error); onStatus({ state: 'error', room, owner, error }); });
        return;
      }
      if (packet.type === 'base:snapshot') {
        if (packet.protocol !== BASE_GAME_PROTOCOL_VERSION || packet.room !== room) return;
        latestSnapshot = packet;
        if (clientId) owner = packet.ownerId === clientId;
        snapshotSeen = true;
        trackSnapshot(packet);
        onSnapshot(packet, api);
        onStatus({ state: 'connected', room, clientId, owner });
        maybeResolveInitial();
      }
    };

    ws.onerror = () => {
      onStatus({ state: 'error', room, owner, error: new Error('Could not connect to multiplayer server') });
    };

    ws.onclose = () => {
      ws = null;
      if (stopped) return;
      if (!resumeToken && !joinedSeen) {
        failInitial(new Error('Connection closed before the room was joined'));
        return;
      }
      onStatus({ state: 'reconnecting', room, owner });
      reconnectTimer = setTimer(() => connect(true), reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    };
  }

  connect();
  handshakeTimer = setTimer(() => failInitial(new Error('Multiplayer server did not answer the room request')), handshakeTimeoutMs);
  return initial;
}

export { sanitizeBaseGamePlayerState as readBaseGamePlayerState };
