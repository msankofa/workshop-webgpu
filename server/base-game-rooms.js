import {
  BASE_GAME_PROTOCOL_VERSION,
  BASE_GAME_ROOM_GRACE_MS,
  BASE_GAME_ROOM_PLAYER_CAP,
  BASE_GAME_SIM_HZ,
  BASE_GAME_STALL_TICKS,
  BASE_GAME_TICK_QUEUE_DRAIN,
  advanceBaseGameWorld,
  createBaseGameRateLimiter,
  isAcceptableBaseGameTick,
  neutralBaseGameInput,
  normalizeBaseGameRoomCode,
  sanitizeBaseGameInputPacket,
  sanitizeBaseGameWorldPatch,
  sanitizeBaseGameTerrainConfig,
  describeBaseGameTerrainConfig,
} from '../base-game-protocol.mjs';
import { createBaseGamePlayerController } from '../base-game-player-controller.js';
import { randomUUID } from 'node:crypto';

function defaultToken() {
  return `${randomUUID()}-${randomUUID()}`;
}

// Builds the authoritative world for a sanitized terrain config. Traversal Lab is the exact
// collision the browser renders; terrain rooms use the same pure source + heightfield provider
// Solo uses (the heightfield is infinite, so nothing has to stream on the server). Built lazily
// so tests that never create a room do not pay for the BVH bake.
async function defaultWorldFactory(config = { kind: 'traversalLab' }) {
  const { createWorldQueryService } = await import('../world-query.js');
  const worldQuery = createWorldQueryService();
  if (config.kind === 'terrain') {
    const [{ createSource }, , , { createHeightfieldWorldQueryProvider }] = await Promise.all([
      import('../terrain-source.js'),
      import('../terrain-source-analytic.js'),
      import('../terrain-source-v5.js'),
      import('../world-query-heightfield-provider.js'),
    ]);
    const source = createSource(config.descriptor);
    const provider = createHeightfieldWorldQueryProvider(source, { id: 'terrain' });
    worldQuery.registerProvider(provider);
    const killBelow = 80;
    return {
      worldQuery,
      spawn: [0, source.heightAt(0, 0) + 1.5, 0],
      killPlaneYAt: (x, z) => source.heightAt(x, z) - killBelow,
      worldVersion: config.worldVersion,
      terrain: config,
    };
  }
  const { createTraversalLabWorldQuery } = await import('../traversal-lab-collider.js');
  const lab = createTraversalLabWorldQuery(worldQuery);
  return {
    worldQuery,
    spawn: lab.layout.spawn,
    killPlaneY: lab.layout.killPlaneY,
    worldVersion: `traversal-lab-v${lab.layout.version}`,
    terrain: config,
  };
}

export function createBaseGameRoomService({
  now = () => Date.now(),
  makeToken = defaultToken,
  graceMs = BASE_GAME_ROOM_GRACE_MS,
  playerCap = BASE_GAME_ROOM_PLAYER_CAP,
  simHz = BASE_GAME_SIM_HZ,
  stallTicks = BASE_GAME_STALL_TICKS,
  drainDepth = BASE_GAME_TICK_QUEUE_DRAIN,
  world = null,
  worldFactory = defaultWorldFactory,
} = {}) {
  const rooms = new Map();
  const socketClients = new Map();
  const tokenClients = new Map();
  const stepMs = 1000 / simHz;
  // Worlds are immutable per config, so rooms that pick the same terrain share one instance.
  const worlds = new Map();   // worldVersion -> { world: ready world | null, pending: Promise }

  const send = (ws, payload) => {
    if (ws?.readyState === 1) ws.send(JSON.stringify(payload));
  };

  // Movement never runs against a substitute floor: until the room's authoritative world is
  // resident, players keep their spawn state and snapshots say so. An injected `world` (tests)
  // serves every room regardless of config.
  function ensureWorld(room) {
    const config = room.terrain;
    if (world) { room.sim = world; attachRoomControllers(room); return Promise.resolve(world); }
    let entry = worlds.get(config.worldVersion);
    if (!entry) {
      entry = { world: null, pending: null };
      entry.pending = Promise.resolve(worldFactory(config)).then(result => {
        entry.world = result;
        for (const r of rooms.values()) if (r.terrain.worldVersion === config.worldVersion && !r.sim) { r.sim = result; attachRoomControllers(r); }
        return result;
      }, err => { entry.error = err; throw err; });
      worlds.set(config.worldVersion, entry);
    }
    if (entry.world && !room.sim) { room.sim = entry.world; attachRoomControllers(room); }
    return entry.pending;
  }

  function attachRoomControllers(room) {
    for (const client of room.clients.values()) attachController(client);
  }

  function attachController(client) {
    const sim = client.room.sim;
    if (client.controller || !sim) return;
    client.controller = createBaseGamePlayerController({
      worldQuery: sim.worldQuery,
      spawn: sim.spawn,
      config: { fixedHz: simHz },
    });
  }

  function advance(room, at = now()) {
    advanceBaseGameWorld(room.world, at - room.worldUpdatedAt);
    room.worldUpdatedAt = at;
  }

  function connectedClients(room) {
    return [...room.clients.values()].filter(client => client.ws?.readyState === 1);
  }

  function playerEntry(client, room) {
    const controller = client.controller;
    return {
      id: client.id,
      connected: client.ws?.readyState === 1,
      owner: client.id === room.ownerId,
      spawnRevision: client.spawnRevision,
      tick: room.tick,
      lastProcessedTick: client.lastConsumedTick,
      queueDepth: client.queue.length,
      lastInputClientTime: client.lastInputClientTime,
      position: controller ? controller.getPosition() : [...(room.sim?.spawn ?? [0, 0, 0])],
      velocity: controller ? controller.getVelocity() : [0, 0, 0],
      yaw: client.lastInput.yaw,
      pitch: client.lastInput.pitch,
      grounded: controller ? controller.grounded : false,
    };
  }

  function snapshot(room) {
    advance(room);
    return {
      type: 'base:snapshot',
      protocol: BASE_GAME_PROTOCOL_VERSION,
      room: room.code,
      revision: room.revision,
      serverTime: now(),
      tick: room.tick,
      simHz,
      worldVersion: room.sim?.worldVersion ?? null,
      worldReady: !!room.sim,
      terrain: describeBaseGameTerrainConfig(room.terrain),
      ownerId: room.ownerId,
      world: { ...room.world },
      players: [...room.clients.values()].map(client => playerEntry(client, room)),
    };
  }

  function broadcast(room, payload = snapshot(room)) {
    for (const client of connectedClients(room)) send(client.ws, payload);
  }

  function fail(ws, code, message) {
    send(ws, { type: 'base:error', protocol: BASE_GAME_PROTOCOL_VERSION, code, message });
  }

  function validateHandshake(ws, msg) {
    if (msg.protocol !== BASE_GAME_PROTOCOL_VERSION) {
      fail(ws, 'protocol_mismatch', `Base-game protocol ${BASE_GAME_PROTOCOL_VERSION} required`);
      return false;
    }
    return true;
  }

  // A resync adopts the client's next tick numbering and bumps the spawn revision so the client
  // hard-snaps and clears its prediction history. Used at join, resume, and after the server has
  // had to run steps the client never sent.
  function requestResync(client) {
    client.awaitingResync = true;
    client.queue.length = 0;
    client.stalledTicks = 0;
  }

  function makeClient(ws, room) {
    const id = `p_${makeToken().replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}`;
    const token = makeToken();
    const client = {
      id, token, room, ws,
      disconnectedAt: null,
      controller: null,
      queue: [],
      lastConsumedTick: 0,
      lastInput: neutralBaseGameInput(),
      lastInputClientTime: null,
      awaitingResync: true,
      stalledTicks: 0,
      spawnRevision: 1,
      rate: createBaseGameRateLimiter(),
      rejectedInputs: 0,
      serverSteps: 0,
    };
    room.clients.set(id, client);
    socketClients.set(ws, client);
    tokenClients.set(token, client);
    attachController(client);
    return client;
  }

  function sendJoined(client) {
    send(client.ws, {
      type: 'base:joined',
      protocol: BASE_GAME_PROTOCOL_VERSION,
      room: client.room.code,
      clientId: client.id,
      resumeToken: client.token,
      owner: client.room.ownerId === client.id,
      simHz,
      playerCap,
      // The full room terrain config travels once, here; snapshots carry identity only.
      terrain: client.room.terrain,
    });
    send(client.ws, snapshot(client.room));
  }

  function createRoom(ws, msg) {
    if (!validateHandshake(ws, msg)) return true;
    const code = normalizeBaseGameRoomCode(msg.room);
    if (!code) { fail(ws, 'invalid_room', 'Room codes use 2-16 letters, numbers, _ or -'); return true; }
    if (rooms.has(code)) { fail(ws, 'room_exists', 'That room already exists'); return true; }
    const terrain = sanitizeBaseGameTerrainConfig(msg.terrain);
    if (terrain.error) { fail(ws, 'invalid_terrain', terrain.error); return true; }
    const at = now();
    const room = {
      code,
      clients: new Map(),
      ownerId: null,
      revision: 1,
      terrain: terrain.config,
      sim: null,
      world: sanitizeBaseGameWorldPatch(msg.world),
      worldUpdatedAt: at,
      emptySince: null,
      tick: 0,
      accumulatorMs: 0,
      lastStepAt: at,
    };
    rooms.set(code, room);
    ensureWorld(room).catch(err => {
      // The world could not be built: tell everyone and drop the room so nobody stays on spawn forever.
      for (const c of connectedClients(room)) fail(c.ws, 'world_failed', `Room world failed to load: ${err.message}`);
      rooms.delete(code);
    });
    const client = makeClient(ws, room);
    room.ownerId = client.id;
    sendJoined(client);
    broadcast(room);
    return true;
  }

  function joinRoom(ws, msg) {
    if (!validateHandshake(ws, msg)) return true;
    const code = normalizeBaseGameRoomCode(msg.room);
    const room = code ? rooms.get(code) : null;
    if (!room) { fail(ws, 'room_missing', 'No active room has that code'); return true; }
    if (room.clients.size >= playerCap) { fail(ws, 'room_full', `Rooms hold at most ${playerCap} players`); return true; }
    const client = makeClient(ws, room);
    room.emptySince = null;
    sendJoined(client);
    broadcast(room);
    return true;
  }

  function resumeRoom(ws, msg) {
    if (!validateHandshake(ws, msg)) return true;
    const client = tokenClients.get(String(msg.resumeToken ?? ''));
    if (!client) { fail(ws, 'resume_expired', 'The previous room session has expired'); return true; }
    if (client.ws && client.ws !== ws && client.ws.readyState === 1) client.ws.close(4001, 'resumed elsewhere');
    client.ws = ws;
    client.disconnectedAt = null;
    client.room.emptySince = null;
    socketClients.set(ws, client);
    requestResync(client);
    sendJoined(client);
    broadcast(client.room);
    return true;
  }

  function updateWorld(ws, msg) {
    if (!validateHandshake(ws, msg)) return true;
    const client = socketClients.get(ws);
    if (!client) { fail(ws, 'not_joined', 'Join a base-game room first'); return true; }
    const room = client.room;
    if (room.ownerId !== client.id) { fail(ws, 'not_owner', 'Only the room owner can change shared world state'); return true; }
    advance(room);
    const patch = sanitizeBaseGameWorldPatch(msg.patch);
    if (Object.keys(patch).length === 0) return true;
    Object.assign(room.world, patch);
    room.revision++;
    room.worldUpdatedAt = now();
    broadcast(room);
    return true;
  }

  // Input is the only client-to-server movement message. Malformed, over-rate, wrong-socket, and
  // wrong-protocol packets are dropped whole; already-consumed or already-queued ticks are ignored
  // individually because clients resend unacknowledged ticks on purpose.
  function receiveInput(ws, msg) {
    const client = socketClients.get(ws);
    if (!client || client.ws !== ws) return true;
    if (msg.protocol !== BASE_GAME_PROTOCOL_VERSION) { client.rejectedInputs++; return true; }
    const packet = sanitizeBaseGameInputPacket(msg);
    if (!packet) { client.rejectedInputs++; return true; }
    if (!client.rate.allow(now())) { client.rejectedInputs++; return true; }
    if (client.awaitingResync) {
      client.awaitingResync = false;
      client.lastConsumedTick = packet.ticks[0].tick - 1;
      client.spawnRevision++;
    }
    client.lastInputClientTime = packet.clientTime;
    // Lockstep means no gaps: a tick is queued only when it is exactly the next one expected.
    let expected = (client.queue.length ? client.queue[client.queue.length - 1].tick : client.lastConsumedTick) + 1;
    for (const tick of packet.ticks) {
      if (tick.tick < expected) continue;
      if (tick.tick !== expected || !isAcceptableBaseGameTick(tick.tick, client.lastConsumedTick)) { client.rejectedInputs++; break; }
      client.queue.push(tick);
      expected++;
    }
    return true;
  }

  function resync(ws, msg) {
    const client = socketClients.get(ws);
    if (!client || client.ws !== ws) return true;
    if (msg.protocol !== BASE_GAME_PROTOCOL_VERSION) { client.rejectedInputs++; return true; }
    if (!client.rate.allow(now())) { client.rejectedInputs++; return true; }
    requestResync(client);
    return true;
  }

  // Respawn is a request, not a transform: the server resets the controller to its own spawn,
  // bumps the spawn revision, and resyncs the client's tick numbering.
  function respawnClient(client) {
    client.controller?.reset(client.room.sim?.spawn);
    client.lastInput = neutralBaseGameInput(client.lastInput.yaw, client.lastInput.pitch);
    client.spawnRevision++;
    client.respawns = (client.respawns ?? 0) + 1;
    requestResync(client);
  }

  function respawn(ws, msg) {
    const client = socketClients.get(ws);
    if (!client || client.ws !== ws) return true;
    if (msg.protocol !== BASE_GAME_PROTOCOL_VERSION) { client.rejectedInputs++; return true; }
    if (!client.rate.allow(now())) { client.rejectedInputs++; return true; }
    respawnClient(client);
    broadcast(client.room);
    return true;
  }

  // Authoritative kill plane: anyone below the world's floor limit respawns, connected or not.
  // Terrain worlds give a surface-relative limit (killPlaneYAt); the lab gives a constant.
  function enforceKillPlane(client) {
    const sim = client.room.sim;
    if (!sim || !client.controller) return false;
    const p = client.controller.getPosition();
    const limit = typeof sim.killPlaneYAt === 'function' ? sim.killPlaneYAt(p[0], p[2]) : sim.killPlaneY;
    if (!Number.isFinite(limit) || p[1] >= limit) return false;
    respawnClient(client);
    return true;
  }

  function handle(ws, msg) {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.type === 'base:respawn') return respawn(ws, msg);
    if (msg.type === 'base:resync') return resync(ws, msg);
    if (msg.type === 'base:create') return createRoom(ws, msg);
    if (msg.type === 'base:join') return joinRoom(ws, msg);
    if (msg.type === 'base:resume') return resumeRoom(ws, msg);
    if (msg.type === 'base:set_world') return updateWorld(ws, msg);
    if (msg.type === 'base:input') return receiveInput(ws, msg);
    return false;
  }

  function consumeTick(client) {
    const next = client.queue.shift();
    client.lastConsumedTick = next.tick;
    client.lastInput = next;
    client.controller.stepOnce({ moveX: next.moveX, moveZ: next.moveZ, yaw: next.yaw, sprint: next.sprint }, next.jump);
  }

  // Each simulation step consumes exactly one queued tick per player. A deep queue drains two per
  // step; an empty queue freezes the player briefly, then the server runs neutral steps and asks
  // the client to resync. Disconnected players always run neutral steps.
  function stepClient(client) {
    const controller = client.controller;
    if (!controller) return;
    const connected = client.ws?.readyState === 1;
    if (!connected) {
      controller.stepOnce(neutralBaseGameInput(client.lastInput.yaw, client.lastInput.pitch), false);
      client.serverSteps++;
      if (!client.awaitingResync) requestResync(client);
      return;
    }
    if (client.queue.length === 0) {
      client.stalledTicks++;
      if (client.stalledTicks > stallTicks) {
        controller.stepOnce(neutralBaseGameInput(client.lastInput.yaw, client.lastInput.pitch), false);
        client.serverSteps++;
        if (!client.awaitingResync) requestResync(client);
      }
      return;
    }
    client.stalledTicks = 0;
    consumeTick(client);
    if (client.queue.length > drainDepth) consumeTick(client);
  }

  function stepRoom(room, at) {
    const elapsed = Math.max(0, at - room.lastStepAt);
    room.lastStepAt = at;
    // Late service ticks are bounded: at most a quarter second of catch-up per wake-up.
    room.accumulatorMs = Math.min(room.accumulatorMs + elapsed, stepMs * simHz / 4);
    while (room.accumulatorMs + 1e-6 >= stepMs) {
      room.accumulatorMs -= stepMs;
      room.tick++;
      for (const client of room.clients.values()) { stepClient(client); enforceKillPlane(client); }
    }
  }

  function step(at = now()) {
    for (const room of rooms.values()) if (room.sim) stepRoom(room, at);
  }

  function transferOwner(room) {
    const next = connectedClients(room)[0] ?? [...room.clients.values()][0] ?? null;
    room.ownerId = next?.id ?? null;
    if (next) room.revision++;
  }

  function disconnect(ws) {
    const client = socketClients.get(ws);
    if (!client) return false;
    socketClients.delete(ws);
    if (client.ws !== ws) return true;
    client.ws = null;
    client.disconnectedAt = now();
    requestResync(client);
    if (connectedClients(client.room).length === 0) client.room.emptySince = now();
    broadcast(client.room);
    return true;
  }

  function cleanup() {
    const at = now();
    for (const [code, room] of rooms) {
      let changed = false;
      for (const [id, client] of room.clients) {
        if (client.ws || client.disconnectedAt == null || at - client.disconnectedAt < graceMs) continue;
        room.clients.delete(id);
        tokenClients.delete(client.token);
        if (room.ownerId === id) transferOwner(room);
        changed = true;
      }
      if (room.clients.size === 0 && room.emptySince != null && at - room.emptySince >= graceMs) rooms.delete(code);
      else if (changed) broadcast(room);
    }
  }

  function broadcastSnapshots() {
    for (const room of rooms.values()) if (connectedClients(room).length) broadcast(room);
  }

  return {
    handle, disconnect, cleanup, step, broadcastSnapshots, rooms,
    // Resolves when every room's world is resident (tests); no rooms -> resolved.
    ensureWorld() { return Promise.all([...rooms.values()].map(room => ensureWorld(room))); },
    get worldReady() { return [...rooms.values()].every(room => !!room.sim); },
    get worldCount() { return worlds.size; },
    // Pre-build the default lab world (server startup).
    warmTraversalLab() {
      if (world) return Promise.resolve(world);
      const config = sanitizeBaseGameTerrainConfig(undefined).config;
      let entry = worlds.get(config.worldVersion);
      if (!entry) {
        entry = { world: null, pending: null };
        entry.pending = Promise.resolve(worldFactory(config)).then(result => { entry.world = result; return result; });
        worlds.set(config.worldVersion, entry);
      }
      return entry.pending;
    },
  };
}
