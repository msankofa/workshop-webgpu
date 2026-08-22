import {
  BASE_GAME_INPUT_HZ,
  BASE_GAME_MAX_PENDING_TICKS,
  BASE_GAME_MAX_TICKS_PER_PACKET,
  BASE_GAME_PROTOCOL_VERSION,
  normalizeBaseGameRoomCode,
  pickBaseGameSharedWorld,
  sanitizeBaseGamePlayerState,
  sanitizeBaseGameTickInput,
  sanitizeBaseGameWorldPatch,
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
    if (initialSettled || !joinedSeen || !snapshotSeen || latestSnapshot?.worldReady !== true) return;
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
      const packet = resumeToken
        ? { type: 'base:resume', protocol: BASE_GAME_PROTOCOL_VERSION, resumeToken }
        : mode === 'create'
          ? { type: 'base:create', protocol: BASE_GAME_PROTOCOL_VERSION, room, world: pickBaseGameSharedWorld(world), terrain: terrain ?? { kind: 'traversalLab' } }
          : { type: 'base:join', protocol: BASE_GAME_PROTOCOL_VERSION, room };
      ws.send(JSON.stringify(packet));
    };

    ws.onmessage = event => {
      let packet;
      try { packet = JSON.parse(event.data); } catch { return; }
      if (packet.type === 'base:error') {
        const error = new Error(packet.message || packet.code || 'Multiplayer error');
        error.code = packet.code;
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
        roomTerrain = packet.terrain ?? { kind: 'traversalLab', worldVersion: 'traversal-lab' };
        joinedSeen = true;
        onStatus({ state: 'connected', room, clientId, owner });
        maybeResolveInitial();
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
