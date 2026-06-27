# Multiplayer — WebSocket Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add host-authoritative multiplayer to `environment-viewer.html` — one client runs the simulation and broadcasts 20 Hz state snapshots to guests via a WebSocket relay on Render.com; guests render ghost meshes interpolated from received snapshots and can trigger set_target / set_behavior inputs.

**Architecture:** A dumb Node.js relay fans host snapshots out to all guests in a room and routes guest input events upstream to the host. The host serialises creature state from `portCreatures.system.creatures` after each physics tick. Guests run a `createGuestSession` that maintains an `InterpolationBuffer` (ring of 3 snapshots, render offset −100 ms) and drives a `GhostRenderer` which places simple box/capsule meshes in the shared Three.js scene.

**Tech Stack:** Node.js + `ws@^8` (server), native browser `WebSocket` (client), Three.js `BoxGeometry` + `CapsuleGeometry` for ghost meshes.

---

## File Map

| File | Status | Responsibility |
|------|--------|---------------|
| `server/package.json` | Create | Node.js project manifest |
| `server/server.js` | Create | WebSocket relay — room management, fan-out, disconnect events |
| `server/test-relay.mjs` | Create | Integration test for relay protocol |
| `multiplayer.js` | Create | `InterpolationBuffer`, `createHostSession`, `createGuestSession`, `GhostRenderer` |
| `multiplayer-test.mjs` | Create | Unit test for `InterpolationBuffer` |
| `port-creature-system.js` | Modify | Add `setBehavior(b)` to the returned system API |
| `environment-viewer.html` | Modify | Import `multiplayer.js`, add MP UI panel, wire host tick + guest input handler |

---

## Task 1: Relay Server

**Files:**
- Create: `server/package.json`
- Create: `server/server.js`
- Create: `server/test-relay.mjs`

- [ ] **Step 1: Create `server/package.json`**

```json
{
  "name": "creature-relay",
  "type": "module",
  "scripts": { "start": "node server.js" },
  "dependencies": { "ws": "^8" }
}
```

- [ ] **Step 2: Install dependencies**

Run in `server/`:
```
npm install
```
Expected: `node_modules/ws/` created.

- [ ] **Step 3: Write failing relay test**

Create `server/test-relay.mjs`:
```js
import WebSocket from 'ws';

const URL = 'ws://localhost:8080';
const ROOM = 'TEST';
const delay = ms => new Promise(r => setTimeout(r, ms));

const host = new WebSocket(URL);
await new Promise(r => host.once('open', r));
host.send(JSON.stringify({ type: 'host', room: ROOM }));

const guest = new WebSocket(URL);
await new Promise(r => guest.once('open', r));
guest.send(JSON.stringify({ type: 'join', room: ROOM }));

const guestMsgs = [];
const hostMsgs = [];
guest.on('message', d => guestMsgs.push(JSON.parse(d)));
host.on('message', d => hostMsgs.push(JSON.parse(d)));
await delay(120);

// host broadcasts — guest should receive
host.send(JSON.stringify({ type: 'sim_state', seq: 1, creatures: [] }));
await delay(120);

console.assert(guestMsgs.some(m => m.type === 'joined'),       'FAIL: guest should receive joined');
console.assert(hostMsgs.some(m => m.type === 'guest_joined'),  'FAIL: host should receive guest_joined');
console.assert(guestMsgs.some(m => m.type === 'sim_state'),    'FAIL: guest should receive sim_state');

// guest sends input — host should receive with clientId attached
const myId = guestMsgs.find(m => m.type === 'joined')?.clientId;
guest.send(JSON.stringify({ type: 'set_target', pos: [1, 0, 2] }));
await delay(120);
const relayed = hostMsgs.find(m => m.type === 'set_target');
console.assert(relayed,                        'FAIL: host should receive set_target');
console.assert(relayed?.clientId === myId,     'FAIL: host should receive clientId on forwarded msg');

// guest disconnect — host should receive guest_left
guest.close();
await delay(120);
console.assert(hostMsgs.some(m => m.type === 'guest_left' && m.clientId === myId),
               'FAIL: host should receive guest_left');

host.close();
console.log('All relay tests passed.');
process.exit(0);
```

- [ ] **Step 4: Run test — expect connection refused (server not written yet)**

Run in `server/`:
```
node test-relay.mjs
```
Expected: `ECONNREFUSED` or similar — server not running.

- [ ] **Step 5: Write `server/server.js`**

```js
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
```

- [ ] **Step 6: Run server and test**

Terminal A — start server in `server/`:
```
node server.js
```
Expected: `relay listening on :8080`

Terminal B — run test in `server/`:
```
node test-relay.mjs
```
Expected: `All relay tests passed.`

- [ ] **Step 7: Commit**

```bash
git add server/package.json server/package-lock.json server/server.js server/test-relay.mjs
git commit -m "feat(server): WebSocket relay with room management and fan-out"
```

---

## Task 2: InterpolationBuffer

**Files:**
- Create: `multiplayer.js` (initial version — InterpolationBuffer only)
- Create: `multiplayer-test.mjs`

- [ ] **Step 1: Write failing InterpolationBuffer test**

Create `multiplayer-test.mjs`:
```js
// Runs in Node.js. Imports only the pure-logic parts of multiplayer.js.
// Must run AFTER multiplayer.js exists.
import { InterpolationBuffer } from './multiplayer.js';

function approx(a, b, tol = 0.001) { return Math.abs(a - b) < tol; }

// Two snapshots: creature moves from x=0 to x=10, hp 1→0.5, over 100 ms
const buf = new InterpolationBuffer();
const stateA = { creatures: [{ id: 0, p: [0,0,0], q: [0,0,0,1], hp: 1.0, feet: [], hands: [] }], players: [] };
const stateB = { creatures: [{ id: 0, p: [10,0,0], q: [0,0,0,1], hp: 0.5, feet: [], hands: [] }], players: [] };
buf.push(stateA, 1000);
buf.push(stateB, 1100);

// sample at midpoint
const mid = buf.sample(1050);
console.assert(mid !== null, 'FAIL: sample should return state');
console.assert(approx(mid.creatures[0].p[0], 5), `FAIL: lerp x — got ${mid.creatures[0].p[0]}`);
console.assert(approx(mid.creatures[0].hp, 0.75), `FAIL: lerp hp — got ${mid.creatures[0].hp}`);

// sample before first snapshot — should return stateA
const before = buf.sample(900);
console.assert(approx(before.creatures[0].p[0], 0), 'FAIL: before range should return first snapshot');

// sample after last snapshot — should return stateB
const after = buf.sample(1200);
console.assert(approx(after.creatures[0].p[0], 10), 'FAIL: after range should return last snapshot');

// empty buffer
const empty = new InterpolationBuffer();
console.assert(empty.sample(1000) === null, 'FAIL: empty buffer should return null');

console.log('InterpolationBuffer tests passed.');
process.exit(0);
```

- [ ] **Step 2: Run test — expect import failure (file doesn't exist yet)**

```
node multiplayer-test.mjs
```
Expected: `Cannot find module './multiplayer.js'` or similar.

- [ ] **Step 3: Create `multiplayer.js` with `InterpolationBuffer`**

```js
// RELAY_URL: override with ?relay=wss://... for production
const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
export const RELAY_URL = params.get('relay') || 'ws://localhost:8080';

// ---------------------------------------------------------------------------
// InterpolationBuffer — ring of 3 snapshots, sample at arbitrary time
// ---------------------------------------------------------------------------

export class InterpolationBuffer {
  constructor() { this._snaps = []; }

  /** @param {object} state @param {number} [t] timestamp ms (default: performance.now()) */
  push(state, t = performance.now()) {
    this._snaps.push({ t, state });
    if (this._snaps.length > 3) this._snaps.shift();
  }

  /** @param {number} renderTime ms — returns interpolated state or null */
  sample(renderTime) {
    const s = this._snaps;
    if (s.length === 0) return null;
    if (s.length === 1) return s[0].state;
    // clamp below first
    if (renderTime <= s[0].t) return s[0].state;
    // clamp above last
    if (renderTime >= s[s.length - 1].t) return s[s.length - 1].state;
    for (let i = 1; i < s.length; i++) {
      if (renderTime <= s[i].t) {
        const alpha = (renderTime - s[i-1].t) / (s[i].t - s[i-1].t);
        return _lerpState(s[i-1].state, s[i].state, alpha);
      }
    }
    return s[s.length - 1].state;
  }
}

function _lerpV3(a, b, t) {
  return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];
}

function _slerpQ(a, b, t) {
  let dot = a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3];
  dot = Math.max(-1, Math.min(1, dot));
  if (dot < 0) { b = [-b[0],-b[1],-b[2],-b[3]]; dot = -dot; }
  if (dot > 0.9995) return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t, a[3]+(b[3]-a[3])*t];
  const th = Math.acos(dot);
  const sth = Math.sin(th);
  const wa = Math.sin((1-t)*th)/sth, wb = Math.sin(t*th)/sth;
  return [a[0]*wa+b[0]*wb, a[1]*wa+b[1]*wb, a[2]*wa+b[2]*wb, a[3]*wa+b[3]*wb];
}

function _lerpState(a, b, alpha) {
  return {
    creatures: a.creatures.map((ca, i) => {
      const cb = b.creatures[i];
      if (!cb) return ca;
      return {
        id: ca.id,
        p: _lerpV3(ca.p, cb.p, alpha),
        q: _slerpQ(ca.q, cb.q, alpha),
        hp: ca.hp + (cb.hp - ca.hp) * alpha,
        feet:  ca.feet.map((f, j) => cb.feet[j]  ? _lerpV3(f, cb.feet[j],  alpha) : f),
        hands: ca.hands.map((h, j) => cb.hands[j] ? _lerpV3(h, cb.hands[j], alpha) : h),
      };
    }),
    players: a.players.map((pa, i) => {
      const pb = b.players[i];
      if (!pb) return pa;
      return { id: pa.id, p: _lerpV3(pa.p, pb.p, alpha), q: _slerpQ(pa.q, pb.q, alpha) };
    }),
  };
}
```

- [ ] **Step 4: Run test — expect pass**

```
node multiplayer-test.mjs
```
Expected: `InterpolationBuffer tests passed.`

- [ ] **Step 5: Commit**

```bash
git add multiplayer.js multiplayer-test.mjs
git commit -m "feat(mp): InterpolationBuffer with lerp/slerp interpolation"
```

---

## Task 3: Host and Guest Session Managers

**Files:**
- Modify: `multiplayer.js` (append `createHostSession` and `createGuestSession`)

No new test file — these are tested manually in Task 6. The relay test in Task 1 already validates the protocol layer.

- [ ] **Step 1: Append `createHostSession` to `multiplayer.js`**

Add to the end of `multiplayer.js`:
```js
// ---------------------------------------------------------------------------
// createHostSession — connects as host, broadcasts state at 20 Hz,
//                     dispatches 'mp:guest_input' events for guest inputs
// ---------------------------------------------------------------------------

const BROADCAST_MS = 50; // 20 Hz

/**
 * @param {string} roomCode
 * @param {() => object} getState  — callback returning { creatures, players }
 * @returns {{ destroy(): void }}
 */
export function createHostSession(roomCode, getState) {
  let ws = null;
  let intervalId = null;
  let reconnectDelay = 1000;
  let seq = 0;

  function connect() {
    ws = new WebSocket(RELAY_URL);
    ws.onopen = () => {
      reconnectDelay = 1000;
      ws.send(JSON.stringify({ type: 'host', room: roomCode }));
      intervalId = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const state = getState();
        ws.send(JSON.stringify({ type: 'sim_state', seq: seq++, ...state }));
      }, BROADCAST_MS);
      window.dispatchEvent(new CustomEvent('mp:connected', { detail: { role: 'host', room: roomCode } }));
    };
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      window.dispatchEvent(new CustomEvent('mp:guest_input', { detail: msg }));
    };
    ws.onclose = () => {
      clearInterval(intervalId);
      intervalId = null;
      setTimeout(connect, Math.min(reconnectDelay, 30000));
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    };
  }

  connect();
  return { destroy() { clearInterval(intervalId); ws?.close(); } };
}

// ---------------------------------------------------------------------------
// createGuestSession — connects as guest, feeds InterpolationBuffer,
//                      drives onState(interpolatedState) via rAF
// ---------------------------------------------------------------------------

/**
 * @param {string} roomCode
 * @param {(state: object) => void} onState — called each rAF with interpolated state
 * @returns {{ sendInput(msg: object): void, destroy(): void }}
 */
export function createGuestSession(roomCode, onState) {
  let ws = null;
  let reconnectDelay = 1000;
  let rafId = null;
  const buffer = new InterpolationBuffer();

  function connect() {
    ws = new WebSocket(RELAY_URL);
    ws.onopen = () => {
      reconnectDelay = 1000;
      ws.send(JSON.stringify({ type: 'join', room: roomCode }));
    };
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'sim_state') {
        buffer.push(msg, performance.now());
      } else {
        window.dispatchEvent(new CustomEvent('mp:' + msg.type, { detail: msg }));
      }
    };
    ws.onclose = () => {
      setTimeout(connect, Math.min(reconnectDelay, 30000));
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    };
  }

  function tick() {
    const state = buffer.sample(performance.now() - 100);
    if (state) onState(state);
    rafId = requestAnimationFrame(tick);
  }

  connect();
  rafId = requestAnimationFrame(tick);

  return {
    sendInput(msg) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    destroy() {
      cancelAnimationFrame(rafId);
      ws?.close();
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add multiplayer.js
git commit -m "feat(mp): createHostSession and createGuestSession"
```

---

## Task 4: GhostRenderer

**Files:**
- Modify: `multiplayer.js` (append `GhostRenderer`)

- [ ] **Step 1: Append `GhostRenderer` to `multiplayer.js`**

Add to the end of `multiplayer.js`:
```js
// ---------------------------------------------------------------------------
// GhostRenderer — lightweight ghost meshes for creatures and remote players
//   Creature ghosts: a semi-transparent box at body position
//   Player ghosts:   a capsule at player position
// ---------------------------------------------------------------------------

import * as THREE from 'three';

const _creatureGeo = new THREE.BoxGeometry(0.7, 0.5, 1.0);
const _playerGeo   = new THREE.CapsuleGeometry(0.3, 1.2, 4, 8);

export class GhostRenderer {
  constructor(scene) {
    this._scene    = scene;
    this._creatures = new Map(); // id(number) → Mesh
    this._players   = new Map(); // clientId(string) → Mesh
    this._cMat = new THREE.MeshStandardMaterial({ color: 0x88ccff, transparent: true, opacity: 0.5 });
    this._pMat = new THREE.MeshStandardMaterial({ color: 0xffcc44, transparent: true, opacity: 0.7 });
  }

  update(state) {
    this._updateSet(state.creatures ?? [], this._creatures, _creatureGeo, this._cMat,
      c => c.id, c => c.p, c => c.q);
    this._updateSet(state.players ?? [], this._players, _playerGeo, this._pMat,
      p => p.id, p => p.p, p => p.q);
  }

  _updateSet(items, map, geo, mat, getId, getP, getQ) {
    const seen = new Set();
    for (const item of items) {
      const id = getId(item);
      seen.add(id);
      let mesh = map.get(id);
      if (!mesh) {
        mesh = new THREE.Mesh(geo, mat);
        this._scene.add(mesh);
        map.set(id, mesh);
      }
      const [px, py, pz] = getP(item);
      mesh.position.set(px, py, pz);
      const [qx, qy, qz, qw] = getQ(item);
      mesh.quaternion.set(qx, qy, qz, qw);
    }
    for (const [id, mesh] of map) {
      if (!seen.has(id)) { this._scene.remove(mesh); map.delete(id); }
    }
  }

  destroy() {
    for (const m of this._creatures.values()) this._scene.remove(m);
    for (const m of this._players.values())   this._scene.remove(m);
    this._creatures.clear();
    this._players.clear();
    this._cMat.dispose();
    this._pMat.dispose();
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add multiplayer.js
git commit -m "feat(mp): GhostRenderer for creature and player ghost meshes"
```

---

## Task 5: Add `setBehavior` to System API

**Files:**
- Modify: `port-creature-system.js`

The system currently exposes `setTargetPoint` but not `setBehavior`. Guest inputs need to change `currentBehavior`.

- [ ] **Step 1: Find the `return {` block near the end of `port-creature-system.js`**

The block is at line 4812. It currently reads:
```js
  return {
    update,
    resetCreatures,
    clearRenderBatches,
    spawnRandomObjects,
    selectFromRaycaster,
    setTargetPoint,
    get stats() { return creatureStats; },
    get creatures() { return creatures; },
    get currentBehavior() { return currentBehavior; },
  };
```

- [ ] **Step 2: Add `setBehavior` just before `setTargetPoint`**

In `port-creature-system.js`, add the following function just before the `return {` block at line 4812:

```js
  function setBehavior(b) {
    currentBehavior = b;
    const el = document.getElementById('behavior');
    if (el) el.value = b;
  }
```

Then add it to the return object:
```js
  return {
    update,
    resetCreatures,
    clearRenderBatches,
    spawnRandomObjects,
    selectFromRaycaster,
    setTargetPoint,
    setBehavior,
    get stats() { return creatureStats; },
    get creatures() { return creatures; },
    get currentBehavior() { return currentBehavior; },
  };
```

- [ ] **Step 3: Commit**

```bash
git add port-creature-system.js
git commit -m "feat(creatures): expose setBehavior on system API for multiplayer guest inputs"
```

---

## Task 6: `environment-viewer.html` Integration

**Files:**
- Modify: `environment-viewer.html`

This task wires everything together: import, UI panel, host state serialisation, guest input handling, and ghost rendering.

### Step 1 — Add import

- [ ] **Step 1: Add import at the top of the `<script type="module">` block**

Find the existing imports near line 36 in `environment-viewer.html`. After the last `import` line (e.g. `import { createMapCollider } from './map-collision.js';`), add:

```js
import { createHostSession, createGuestSession, GhostRenderer } from './multiplayer.js';
```

### Step 2 — Add UI panel

- [ ] **Step 2: Add the MP panel HTML just before `</body>`**

Find `</body>` near the end of the file and insert before it:
```html
<div id="mp-panel" style="
  position:fixed; bottom:12px; right:12px; z-index:10;
  display:flex; align-items:center; gap:6px;
  padding:6px 10px;
  background:rgba(25,29,36,0.86); border:1px solid rgba(255,255,255,0.12);
  border-radius:8px; font:12px system-ui,sans-serif; color:#d8dee9; user-select:none;">
  <input id="mp-room" maxlength="6" placeholder="ROOM"
    style="width:56px;height:24px;padding:0 6px;border:1px solid rgba(255,255,255,0.12);
    border-radius:5px;background:#20252d;color:#d8dee9;font:12px system-ui,sans-serif;
    text-transform:uppercase;">
  <button id="mp-host-btn" style="height:26px;padding:0 8px;border:1px solid rgba(255,255,255,0.12);
    border-radius:5px;background:#20252d;color:#d8dee9;font:12px system-ui,sans-serif;cursor:pointer;">
    Host
  </button>
  <button id="mp-join-btn" style="height:26px;padding:0 8px;border:1px solid rgba(255,255,255,0.12);
    border-radius:5px;background:#20252d;color:#d8dee9;font:12px system-ui,sans-serif;cursor:pointer;">
    Join
  </button>
  <span id="mp-status" style="color:#8d97a8;font-size:11px;min-width:80px;"></span>
</div>
```

### Step 3 — Session state variables

- [ ] **Step 3: Add session variables after the existing `let` declarations near the top of the script (after `let MAP_KEY = ...`)**

Add after `let MAP_KEY = ...`:
```js
let mpSession = null;       // { destroy() } — current host or guest session
let mpGhostRenderer = null; // GhostRenderer instance (guest mode only)
let mpRole = null;          // 'host' | 'guest' | null
```

### Step 4 — UI wiring

- [ ] **Step 4: Add MP panel event listeners after the `await renderer.init()` call**

Find `await renderer.init();` and add the following block after it:

```js
// ===================== multiplayer UI =====================
function _mpSetStatus(msg) {
  const el = document.getElementById('mp-status');
  if (el) el.textContent = msg;
}

function _mpGenerateCode() {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

document.getElementById('mp-host-btn').addEventListener('click', () => {
  if (mpSession) { mpSession.destroy(); mpSession = null; mpRole = null; _mpSetStatus(''); return; }
  const code = document.getElementById('mp-room').value.trim().toUpperCase() || _mpGenerateCode();
  document.getElementById('mp-room').value = code;
  mpRole = 'host';

  function getState() {
    const creatures = (portCreatures?.system?.creatures ?? []).map((c, id) => ({
      id,
      p: [c.pos.x, c.pos.y, c.pos.z],
      q: [c.group.quaternion.x, c.group.quaternion.y, c.group.quaternion.z, c.group.quaternion.w],
      hp: c.health / 100,
      feet:  c.legs.map(l => [l.end.x, l.end.y, l.end.z]),
      hands: c.arms.map(a => [a.hand.position.x, a.hand.position.y, a.hand.position.z]),
    }));
    return { creatures, players: [] };
  }

  mpSession = createHostSession(code, getState);
  _mpSetStatus(`hosting ${code}`);
});

document.getElementById('mp-join-btn').addEventListener('click', () => {
  if (mpSession) { mpSession.destroy(); mpSession = null; mpRole = null; _mpGhostDestroy(); _mpSetStatus(''); return; }
  const code = document.getElementById('mp-room').value.trim().toUpperCase();
  if (!code) { _mpSetStatus('enter room code'); return; }
  mpRole = 'guest';
  mpGhostRenderer = new GhostRenderer(scene);

  mpSession = createGuestSession(code, state => {
    mpGhostRenderer.update(state);
  });
  _mpSetStatus(`joined ${code}`);
});

function _mpGhostDestroy() {
  if (mpGhostRenderer) { mpGhostRenderer.destroy(); mpGhostRenderer = null; }
}

window.addEventListener('mp:connected', e => {
  _mpSetStatus(`hosting ${e.detail.room} ●`);
});

window.addEventListener('mp:joined', e => {
  _mpSetStatus(`joined ${document.getElementById('mp-room').value} (${e.detail.guestCount} guest${e.detail.guestCount !== 1 ? 's' : ''})`);
});

window.addEventListener('mp:host_left', () => {
  _mpSetStatus('host disconnected');
});

window.addEventListener('mp:guest_joined', e => {
  const room = document.getElementById('mp-room').value;
  _mpSetStatus(`hosting ${room} (${e.detail.guestCount ?? '?'} guest)`);
});

window.addEventListener('mp:guest_left', () => {
  _mpSetStatus(`hosting ${document.getElementById('mp-room').value}`);
});

// Handle guest input events forwarded from the relay
window.addEventListener('mp:guest_input', e => {
  const msg = e.detail;
  if (msg.type === 'set_target') {
    portCreatures?.system?.setTargetPoint(new THREE.Vector3(msg.pos[0], msg.pos[1], msg.pos[2]));
  } else if (msg.type === 'set_behavior') {
    portCreatures?.system?.setBehavior(msg.behavior);
  }
});
```

- [ ] **Step 5: Verify the viewer loads without errors**

Open `environment-viewer.html` in a browser. Open DevTools console. Expected: no import errors, MP panel visible in bottom-right corner.

- [ ] **Step 6: Manual host/guest smoke test (requires relay server running)**

1. Start relay: run `node server.js` in the `server/` directory.
2. Open two browser tabs with `environment-viewer.html`.
3. In Tab A: type any code (e.g. `ABCD`), click **Host**. Status shows `hosting ABCD`.
4. In Tab B: type `ABCD`, click **Join**. Status shows `joined ABCD`.
5. In Tab A: creatures move normally. In Tab B: ghost boxes appear at creature positions and update in real time.
6. In Tab B: double-click the terrain. Confirm in Tab A that the target marker moves and creatures converge.

- [ ] **Step 7: Commit**

```bash
git add environment-viewer.html
git commit -m "feat(mp): wire multiplayer session UI, host state serialisation, guest ghost rendering"
```

---

## Task 7: Render.com Deployment

**Files:**
- Create: `server/render.yaml`
- Modify: `multiplayer.js` (update production RELAY_URL comment)

- [ ] **Step 1: Create `server/render.yaml`**

```yaml
services:
  - type: web
    name: creature-relay
    runtime: node
    rootDir: server
    buildCommand: npm install
    startCommand: npm start
    envVars:
      - key: PORT
        fromGroup: render
```

- [ ] **Step 2: Deploy to Render.com**

1. Push your branch to GitHub.
2. Go to [render.com](https://render.com) → **New → Web Service**.
3. Connect your repository, set **Root Directory** to `server`.
4. Build command: `npm install`. Start command: `npm start`.
5. Deploy. Once live, copy the service URL (e.g. `https://creature-relay.onrender.com`).

- [ ] **Step 3: Update `multiplayer.js` RELAY_URL default**

In `multiplayer.js`, find:
```js
export const RELAY_URL = params.get('relay') || 'ws://localhost:8080';
```

Change to (substituting your actual Render.com URL):
```js
export const RELAY_URL = params.get('relay') || 'wss://creature-relay.onrender.com';
```

- [ ] **Step 4: Verify live connection**

Open `environment-viewer.html` in two browser tabs (or on two different machines). Host on one, join on the other. Confirm ghost meshes appear and update in the guest tab.

- [ ] **Step 5: Commit**

```bash
git add server/render.yaml multiplayer.js
git commit -m "deploy: Render.com config + update production RELAY_URL"
```

---

## Self-Review Checklist

- **Relay server** ✅ Task 1: fan-out, guest_joined, guest_left, host_left, clientId injection
- **InterpolationBuffer** ✅ Task 2: ring of 3, clamp before/after, lerp/slerp
- **createHostSession** ✅ Task 3: connects, 20 Hz broadcast, guest input dispatch
- **createGuestSession** ✅ Task 3: connects, pushes to buffer, rAF drives onState at −100 ms
- **GhostRenderer** ✅ Task 4: creature boxes + player capsules, stale mesh cleanup
- **setBehavior** ✅ Task 5: added to system API + return object
- **env-viewer integration** ✅ Task 6: import, UI panel, host/join handlers, mp:guest_input handler
- **Render.com deployment** ✅ Task 7: render.yaml + production URL
- **Error handling** ✅ reconnect with backoff in both session managers; host_left event dispatched by server and handled in viewer
- **FPS path** ✅ player_move already in protocol; GhostRenderer already handles players array; no server changes needed
