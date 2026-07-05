import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { handlePublishRequest } from './publish-map.js';
import { guestSendVerdict } from './backpressure.js';

const PORT = process.env.PORT || 8080;
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATS_DIR = path.join(ROOT_DIR, 'research', 'stats');
const TELEMETRY_FIELDS = [
  'timestamp',
  'index',
  'name',
  'temperature.gpu',
  'utilization.gpu',
  'utilization.memory',
  'clocks.gr',
  'clocks.mem',
  'power.draw',
  'power.limit',
  'pstate',
  'memory.used',
  'memory.total',
  'fan.speed',
];

let telemetrySession = null;

function json(res, code, payload) {
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(payload));
}

function utcStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sampleTelemetry(session) {
  const wallTimeUtc = new Date().toISOString();
  execFile('nvidia-smi', [
    `--query-gpu=${TELEMETRY_FIELDS.join(',')}`,
    '--format=csv,noheader,nounits',
  ], { windowsHide: true }, (err, stdout) => {
    if (err) {
      session.lastError = err.message;
      return;
    }
    const rows = stdout.trim().split(/\r?\n/).filter(Boolean);
    if (rows.length === 0) return;
    fs.appendFile(session.path, rows.map(row => `${wallTimeUtc},${row}`).join('\n') + '\n', appendErr => {
      if (appendErr) session.lastError = appendErr.message;
    });
  });
}

function startTelemetry(options = {}) {
  if (telemetrySession) return telemetrySession;
  fs.mkdirSync(STATS_DIR, { recursive: true });
  const intervalMs = Math.max(250, Math.round(Number(options.intervalMs) || 1000));
  const maxSeconds = Math.max(1, Math.round(Number(options.maxSeconds) || 900));
  const file = `gpu-telemetry-${utcStamp()}.csv`;
  const outPath = path.join(STATS_DIR, file);
  fs.writeFileSync(outPath, `wallTimeUtc,${TELEMETRY_FIELDS.join(',')}\n`);
  telemetrySession = {
    active: true,
    file,
    path: outPath,
    startedAt: new Date().toISOString(),
    intervalMs,
    maxSeconds,
    lastError: null,
    timer: null,
    deadlineTimer: null,
  };
  sampleTelemetry(telemetrySession);
  telemetrySession.timer = setInterval(() => sampleTelemetry(telemetrySession), intervalMs);
  telemetrySession.deadlineTimer = setTimeout(() => stopTelemetry(), maxSeconds * 1000);
  return telemetrySession;
}

function stopTelemetry() {
  if (!telemetrySession) return null;
  clearInterval(telemetrySession.timer);
  clearTimeout(telemetrySession.deadlineTimer);
  const stopped = { ...telemetrySession, active: false, stoppedAt: new Date().toISOString() };
  delete stopped.timer;
  delete stopped.deadlineTimer;
  telemetrySession = null;
  return stopped;
}

function telemetryPayload(session = telemetrySession) {
  if (!session) return { ok: true, active: false };
  return {
    ok: true,
    active: !!session.active,
    file: session.file,
    startedAt: session.startedAt,
    intervalMs: session.intervalMs,
    maxSeconds: session.maxSeconds,
    lastError: session.lastError,
  };
}

function readJson(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { resolve({}); }
    });
  });
}

async function handleTelemetryRequest(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, {});
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/telemetry/status' && req.method === 'GET') return json(res, 200, telemetryPayload());
  if (url.pathname === '/telemetry/start' && req.method === 'POST') {
    const options = await readJson(req);
    try {
      const session = startTelemetry(options);
      return json(res, 200, telemetryPayload(session));
    } catch (err) {
      return json(res, 500, { ok: false, active: false, error: err.message });
    }
  }
  if (url.pathname === '/telemetry/stop' && req.method === 'POST') {
    return json(res, 200, telemetryPayload(stopTelemetry()));
  }
  return false;
}

const httpServer = http.createServer((req, res) => {
  if (req.url?.startsWith('/telemetry/')) {
    handleTelemetryRequest(req, res).catch(err => json(res, 500, { ok: false, error: err.message }));
    return;
  }
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