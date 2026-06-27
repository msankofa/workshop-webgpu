import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: process.env.PORT || 8080 });

// rooms: Map<code, { host: WebSocket|null, guests: Map<clientId, WebSocket> }>
const rooms = new Map();

function getOrCreate(code) {
  if (!rooms.has(code)) rooms.set(code, { host: null, guests: new Map() });
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
        for (const g of r.guests.values()) send(g, { type: 'host_joined' });
      } else if (msg.type === 'join') {
        role = 'guest';
        roomCode = msg.room;
        const r = getOrCreate(roomCode);
        r.guests.set(clientId, ws);
        send(ws, { type: 'joined', clientId, guestCount: r.guests.size });
        if (r.host) send(r.host, { type: 'guest_joined', clientId });
      }
      return;
    }

    if (role === 'host') {
      const r = rooms.get(roomCode);
      if (!r) return;
      const payload = JSON.stringify(msg);
      for (const g of r.guests.values()) {
        if (g.readyState === 1) g.send(payload);
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

console.log(`relay listening on :${process.env.PORT || 8080}`);
