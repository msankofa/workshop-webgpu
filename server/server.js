import http from 'node:http';
import { WebSocketServer } from 'ws';
import { handlePublishRequest } from './publish-map.js';
import { guestSendVerdict } from './backpressure.js';

const PORT = process.env.PORT || 8080;

const httpServer = http.createServer((req, res) => {
  handlePublishRequest(req, res).catch(err => {
    console.error('publish-map request failed:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'internal error' }));
    }
  });
});

const wss = new WebSocketServer({ server: httpServer });

// rooms: Map<code, { host: WebSocket|null, mapKey: string|null, worldMode: string, guests: Map<clientId, WebSocket> }>
const rooms = new Map();

function getOrCreate(code) {
  if (!rooms.has(code)) rooms.set(code, { host: null, mapKey: null, worldMode: 'shared', guests: new Map() });
  return rooms.get(code);
}

function pruneRoom(code) {
  const r = rooms.get(code);
  if (r && !r.host && r.guests.size === 0) rooms.delete(code);
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

wss.on('connection', ws => {
  let role = null;
  let roomCode = null;
  const clientId = Math.random().toString(36).slice(2, 8);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (!role) {
      if (msg.type === 'host') {
        role = 'host';
        roomCode = msg.room;
        const r = getOrCreate(roomCode);
        r.host = ws;
        r.mapKey = msg.mapKey ?? null;
        r.worldMode = msg.worldMode === 'independent' ? 'independent' : 'shared';
        for (const g of r.guests.values()) send(g, { type: 'host_joined' });
      } else if (msg.type === 'join') {
        role = 'guest';
        roomCode = msg.room;
        const r = getOrCreate(roomCode);
        r.guests.set(clientId, ws);
        send(ws, { type: 'joined', clientId, guestCount: r.guests.size, mapKey: r.mapKey, worldMode: r.worldMode });
        if (r.host) send(r.host, { type: 'guest_joined', clientId });
      } else if (msg.type === 'query') {
        const r = rooms.get(msg.room);
        send(ws, { type: 'room_info', hasHost: !!(r && r.host), mapKey: r?.mapKey ?? null, worldMode: r?.worldMode ?? 'shared' });
      }
      return;
    }

    if (role === 'host') {
      const r = rooms.get(roomCode);
      if (!r) return;
      const payload = JSON.stringify(msg);
      const isSimState = msg.type === 'sim_state';
      // Per-guest backpressure: a guest not draining its socket must not grow an
      // unbounded buffer here or jam on the relay->guest hop. Skip superseded
      // sim_state frames, terminate a provably-dead socket, and isolate each guest
      // in its own try/catch so one bad socket can't stop the broadcast loop.
      for (const g of r.guests.values()) {
        try {
          if (g.readyState !== 1) continue;
          const verdict = guestSendVerdict(g.bufferedAmount, isSimState);
          if (verdict === 'kill') { g.terminate(); continue; }
          if (verdict === 'skip') continue;
          g.send(payload);
        } catch { /* one bad socket must not stop the loop */ }
      }
    } else {
      const r = rooms.get(roomCode);
      if (!r?.host) return;
      send(r.host, { ...msg, clientId });
    }
  });

  ws.on('close', () => {
    if (!roomCode) return;
    const r = rooms.get(roomCode);
    if (!r) return;
    if (role === 'host') {
      r.host = null;
      for (const g of r.guests.values()) send(g, { type: 'host_left' });
    } else if (role === 'guest') {
      r.guests.delete(clientId);
      if (r.host) send(r.host, { type: 'guest_left', clientId });
    }
    pruneRoom(roomCode);
  });
});

httpServer.listen(PORT, () => console.log(`relay listening on :${PORT}`));
