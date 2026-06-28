# Multiplayer Start Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the floating mp-panel with a proper 3-screen wizard (role → map → loading) that establishes multiplayer context before the world loads.

**Architecture:** `showStartScreen()` becomes a 3-step async wizard returning `{ mapKey, mpRole, roomCode, setStatus, dismiss }`. The relay server gains a `query` message for join validation and stores `mapKey` per room. `environment-viewer.html` removes all mp-panel code and wires the wizard return value into world initialization.

**Tech Stack:** Vanilla JS ES modules, WebSocket relay (Node.js `ws`), Three.js WebGPU renderer. No build step — open `environment-viewer.html` directly in browser to test.

---

## File Map

| File | Change |
|------|--------|
| `server/server.js` | Store `mapKey` per room; add `query` message type; include `mapKey` in `joined` response |
| `multiplayer.js` | Add `mapKey` param to `createHostSession`; send it in host registration message |
| `start-screen.js` | Full rewrite — 3-step wizard returning `{ mapKey, mpRole, roomCode, setStatus, dismiss }` |
| `environment-viewer.html` | Remove mp-panel div + all its JS; remove MAP_KEY URL redirect; wire new start screen |

---

## Task 1: Update relay server to store mapKey and handle query

**Files:**
- Modify: `server/server.js`

- [ ] **Step 1: Update room data structure comment and getOrCreate**

In `server/server.js`, replace:
```js
// rooms: Map<code, { host: WebSocket|null, guests: Map<clientId, WebSocket> }>
const rooms = new Map();

function getOrCreate(code) {
  if (!rooms.has(code)) rooms.set(code, { host: null, guests: new Map() });
  return rooms.get(code);
}
```
With:
```js
// rooms: Map<code, { host: WebSocket|null, mapKey: string|null, guests: Map<clientId, WebSocket> }>
const rooms = new Map();

function getOrCreate(code) {
  if (!rooms.has(code)) rooms.set(code, { host: null, mapKey: null, guests: new Map() });
  return rooms.get(code);
}
```

- [ ] **Step 2: Store mapKey on host registration and add query handler**

In `server/server.js`, inside `ws.on('message', raw => { ... })`, replace the `if (!role)` block:
```js
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
```
With:
```js
    if (!role) {
      if (msg.type === 'host') {
        role = 'host';
        roomCode = msg.room;
        const r = getOrCreate(roomCode);
        r.host = ws;
        r.mapKey = msg.mapKey ?? null;
        for (const g of r.guests.values()) send(g, { type: 'host_joined' });
      } else if (msg.type === 'join') {
        role = 'guest';
        roomCode = msg.room;
        const r = getOrCreate(roomCode);
        r.guests.set(clientId, ws);
        send(ws, { type: 'joined', clientId, guestCount: r.guests.size, mapKey: r.mapKey });
        if (r.host) send(r.host, { type: 'guest_joined', clientId });
      } else if (msg.type === 'query') {
        const r = rooms.get(msg.room);
        send(ws, { type: 'room_info', hasHost: !!(r && r.host), mapKey: r?.mapKey ?? null });
      }
      return;
    }
```

- [ ] **Step 3: Manual verification**

Start the server locally: `cd server && node server.js`

Open a browser console and run:
```js
const ws = new WebSocket('ws://localhost:8080');
ws.onopen = () => ws.send(JSON.stringify({ type: 'query', room: 'TEST' }));
ws.onmessage = e => console.log(JSON.parse(e.data));
// Expected: { type: 'room_info', hasHost: false, mapKey: null }
```

Then open a second tab and run:
```js
const ws2 = new WebSocket('ws://localhost:8080');
ws2.onopen = () => ws2.send(JSON.stringify({ type: 'host', room: 'TEST', mapKey: 'forest-valley' }));
// Now in the first tab's console:
const ws = new WebSocket('ws://localhost:8080');
ws.onopen = () => ws.send(JSON.stringify({ type: 'query', room: 'TEST' }));
ws.onmessage = e => console.log(JSON.parse(e.data));
// Expected: { type: 'room_info', hasHost: true, mapKey: 'forest-valley' }
```

- [ ] **Step 4: Commit**

```bash
git add server/server.js
git commit -m "feat(relay): store mapKey per room, add query handler, include mapKey in joined"
```

---

## Task 2: Update createHostSession to send mapKey

**Files:**
- Modify: `multiplayer.js`

- [ ] **Step 1: Update function signature and registration message**

In `multiplayer.js`, replace:
```js
export function createHostSession(roomCode, getState) {
```
With:
```js
export function createHostSession(roomCode, mapKey, getState) {
```

And replace:
```js
      ws.send(JSON.stringify({ type: 'host', room: roomCode }));
```
With:
```js
      ws.send(JSON.stringify({ type: 'host', room: roomCode, mapKey: mapKey ?? null }));
```

- [ ] **Step 2: Commit**

```bash
git add multiplayer.js
git commit -m "feat(multiplayer): pass mapKey in host registration message"
```

---

## Task 3: Rewrite start-screen.js as 3-step wizard

**Files:**
- Modify: `start-screen.js`

- [ ] **Step 1: Write the new start-screen.js**

Replace the entire contents of `start-screen.js` with:

```js
import { RELAY_URL } from './multiplayer.js';

export async function showStartScreen() {
  const config = await fetch('maps/map-config.json')
    .then(r => r.ok ? r.json() : { maps: {} })
    .catch(() => ({ maps: {} }));

  const overlay = document.createElement('div');
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '1000',
    display: 'grid', placeItems: 'center',
    background: '#12161d', color: '#eef3f8',
    fontFamily: 'system-ui, sans-serif',
    padding: '32px', boxSizing: 'border-box',
  });
  document.body.appendChild(overlay);

  const { mpRole, roomCode, guestMapKey } = await _roleStep(overlay);

  let mapKey;
  if (mpRole === 'guest') {
    mapKey = guestMapKey;
  } else {
    mapKey = await _mapStep(overlay, config, mpRole, roomCode);
  }

  const { setStatus } = _loadingStep(overlay, { mapKey, mpRole, roomCode });

  return {
    mapKey,
    mpRole,
    roomCode,
    setStatus,
    dismiss: () => overlay.remove(),
  };
}

// ---------------------------------------------------------------------------

function _clear(overlay) {
  while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
}

function _shell() {
  const el = document.createElement('div');
  Object.assign(el.style, { width: 'min(860px, 100%)', display: 'grid', gap: '18px' });
  return el;
}

function _title(text) {
  const h1 = document.createElement('h1');
  h1.textContent = text;
  Object.assign(h1.style, { margin: '0', fontSize: '28px', fontWeight: '650' });
  return h1;
}

function _mapCard(label, detail, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  Object.assign(btn.style, {
    minHeight: '92px', border: '1px solid #354050', borderRadius: '8px',
    background: '#1a2029', color: '#eef3f8', padding: '16px',
    textAlign: 'left', cursor: 'pointer', width: '100%',
  });
  btn.innerHTML = '<div style="font-weight:650;font-size:15px;margin-bottom:6px"></div><div style="font-size:12px;color:#98a5b5"></div>';
  btn.children[0].textContent = label;
  btn.children[1].textContent = detail;
  btn.addEventListener('mouseenter', () => { btn.style.borderColor = '#6aa7ff'; });
  btn.addEventListener('mouseleave', () => { btn.style.borderColor = '#354050'; });
  btn.addEventListener('click', onClick);
  return btn;
}

function _input(placeholder) {
  const el = document.createElement('input');
  Object.assign(el.style, {
    padding: '6px 8px', border: '1px solid #354050', borderRadius: '5px',
    background: '#20252d', color: '#d8dee9', fontSize: '13px',
    textTransform: 'uppercase', width: '100%', boxSizing: 'border-box',
  });
  el.placeholder = placeholder;
  el.maxLength = 6;
  el.addEventListener('input', () => { el.value = el.value.toUpperCase(); });
  return el;
}

function _actionBtn(label) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  Object.assign(btn.style, {
    padding: '6px 12px', border: '1px solid #354050', borderRadius: '5px',
    background: '#20252d', color: '#d8dee9', cursor: 'pointer', fontSize: '12px',
    alignSelf: 'flex-start',
  });
  return btn;
}

function _errorEl() {
  const el = document.createElement('div');
  Object.assign(el.style, { fontSize: '11px', color: '#e05c5c', display: 'none' });
  return el;
}

function _rolePanel(titleText, detail, inputPlaceholder, btnLabel) {
  const wrap = document.createElement('div');
  Object.assign(wrap.style, {
    border: '1px solid #354050', borderRadius: '8px',
    background: '#1a2029', padding: '16px',
    display: 'flex', flexDirection: 'column', gap: '8px',
  });
  const h = document.createElement('div');
  h.textContent = titleText;
  Object.assign(h.style, { fontWeight: '650', fontSize: '15px' });
  const d = document.createElement('div');
  d.textContent = detail;
  Object.assign(d.style, { fontSize: '12px', color: '#98a5b5' });
  const inp = _input(inputPlaceholder);
  const err = _errorEl();
  const btn = _actionBtn(btnLabel);
  wrap.append(h, d, inp, err, btn);
  return { wrap, inp, err, btn };
}

// ---------------------------------------------------------------------------

async function _roleStep(overlay) {
  return new Promise(resolve => {
    _clear(overlay);
    const s = _shell();
    s.appendChild(_title('Creature Workshop'));

    const grid = document.createElement('div');
    Object.assign(grid.style, {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
      gap: '10px',
    });

    // Solo
    grid.appendChild(_mapCard('Solo', 'Play alone, choose your own map', () => {
      resolve({ mpRole: 'solo', roomCode: null, guestMapKey: null });
    }));

    // Host
    const { wrap: hw, inp: hi, err: he, btn: hb } = _rolePanel(
      'Host', 'Create a room, then choose your map', 'Room code (e.g. WOLF)', 'Host →'
    );
    hb.addEventListener('click', () => {
      const code = hi.value.trim().toUpperCase();
      if (!code) { he.textContent = 'Enter a room code'; he.style.display = ''; return; }
      he.style.display = 'none';
      resolve({ mpRole: 'host', roomCode: code, guestMapKey: null });
    });
    grid.appendChild(hw);

    // Join
    const { wrap: jw, inp: ji, err: je, btn: jb } = _rolePanel(
      'Join', "Enter a host's code — their map loads automatically", 'Enter room code', 'Join →'
    );
    jb.addEventListener('click', async () => {
      const code = ji.value.trim().toUpperCase();
      if (!code) { je.textContent = 'Enter a room code'; je.style.display = ''; return; }
      je.style.display = 'none';
      jb.disabled = true;
      jb.textContent = 'Checking…';
      try {
        const { hasHost, mapKey } = await _queryRoom(code);
        if (!hasHost) {
          je.textContent = 'No active room with that code';
          je.style.display = '';
          jb.disabled = false;
          jb.textContent = 'Join →';
          return;
        }
        resolve({ mpRole: 'guest', roomCode: code, guestMapKey: mapKey });
      } catch {
        je.textContent = 'Could not connect to relay server';
        je.style.display = '';
        jb.disabled = false;
        jb.textContent = 'Join →';
      }
    });
    grid.appendChild(jw);

    s.appendChild(grid);
    overlay.appendChild(s);
  });
}

async function _queryRoom(code) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL);
    const t = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'query', room: code }));
    ws.onmessage = ev => {
      clearTimeout(t);
      ws.close();
      const msg = JSON.parse(ev.data);
      resolve({ hasHost: msg.hasHost, mapKey: msg.mapKey });
    };
    ws.onerror = () => { clearTimeout(t); ws.close(); reject(new Error('connection failed')); };
  });
}

async function _mapStep(overlay, config, mpRole, roomCode) {
  return new Promise(resolve => {
    _clear(overlay);
    const s = _shell();
    const header = mpRole === 'host' ? `Host · ${roomCode}` : 'Choose Map';
    s.appendChild(_title(header));

    const grid = document.createElement('div');
    Object.assign(grid.style, {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
      gap: '10px',
    });

    grid.appendChild(_mapCard('Infinite World', 'Procedural terrain, grass, and GPU forest', () => resolve(null)));

    const maps = config.maps || {};
    for (const [key, meta] of Object.entries(maps)) {
      if (meta && meta.playable === false) continue;
      grid.appendChild(_mapCard(
        meta?.displayName || key,
        'Authored terrain with runtime GPU trees',
        () => resolve(key)
      ));
    }

    s.appendChild(grid);
    overlay.appendChild(s);
  });
}

function _loadingStep(overlay, { mapKey, mpRole, roomCode }) {
  _clear(overlay);
  const s = _shell();

  const parts = [mapKey || 'Infinite World'];
  if (mpRole === 'host') parts.push(`Host · ${roomCode}`);
  if (mpRole === 'guest') parts.push(`Guest · ${roomCode}`);
  s.appendChild(_title(parts.join(' · ')));

  const statusEl = document.createElement('div');
  Object.assign(statusEl.style, { fontSize: '13px', color: '#98a5b5', marginTop: '8px' });
  statusEl.textContent = 'Initializing…';
  s.appendChild(statusEl);

  overlay.appendChild(s);
  return { setStatus: msg => { statusEl.textContent = msg; } };
}
```

- [ ] **Step 2: Commit**

```bash
git add start-screen.js
git commit -m "feat(start-screen): rewrite as 3-step role→map→loading wizard"
```

---

## Task 4: Update environment-viewer.html

**Files:**
- Modify: `environment-viewer.html`

This task makes four targeted edits to the file. Apply them in order.

- [ ] **Step 1: Remove MAP_KEY URL param and start-screen redirect block**

Find and remove the `MAP_KEY` line and the block that follows it. Replace this section (lines ~64–78):
```js
let MAP_KEY = new URLSearchParams(location.search).get('map') || null;

let mpSession = null;       // { destroy() } — current host or guest session
let mpGhostRenderer = null; // GhostRenderer instance (guest mode only)
let mpRole = null;          // 'host' | 'guest' | null

if (!MAP_KEY) {
  const choice = await showStartScreen();
  if (choice.mode === 'map') {
    const url = new URL(location.href);
    url.searchParams.set('map', choice.mapKey);
    location.replace(url.toString());
    await new Promise(() => {});
  }
}
```
With:
```js
let mpSession = null;
let mpGhostRenderer = null;

const { mapKey, mpRole, roomCode, setStatus, dismiss } = await showStartScreen();
```

- [ ] **Step 2: Remove mp-panel JS block**

Find and delete the entire section from `// ===================== multiplayer UI =====================` through `// ===================== end multiplayer UI =====================` (lines ~108–186). Do not replace it with anything yet — the session setup goes in Step 2b below, after scene creation.

- [ ] **Step 2b: Insert multiplayer session setup after scene creation**

`GhostRenderer` requires a scene reference, so this block must live after `scene` is declared. Find:
```js
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1d23);
```
And insert immediately after those two lines:
```js
// ===================== multiplayer session =====================
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

if (mpRole === 'host') {
  mpSession = createHostSession(roomCode, mapKey, getState);
} else if (mpRole === 'guest') {
  mpGhostRenderer = new GhostRenderer(scene, THREE);
  mpSession = createGuestSession(roomCode, state => mpGhostRenderer.update(state));
}

window.addEventListener('mp:guest_input', e => {
  const msg = e.detail;
  if (msg.type === 'set_target') {
    portCreatures?.system?.setTargetPoint(new THREE.Vector3(msg.pos[0], msg.pos[1], msg.pos[2]));
  } else if (msg.type === 'set_behavior') {
    portCreatures?.system?.setBehavior(msg.behavior);
  }
});
// ===================== end multiplayer session =====================
```

- [ ] **Step 3: Replace MAP_KEY map-loading block with mapKey**

Find:
```js
let loadedMap = null;
let mapCollider = null;
if (MAP_KEY) {
  showStatus(`loading authored map ${MAP_KEY}...`);
  await nextPaint();
  loadedMap = await loadTerrainMap(MAP_KEY, { scene });
  showStatus(`building authored map collision...`);
  await nextPaint();
  try {
    mapCollider = createMapCollider(loadedMap.root);
    showStatus(`authored map loaded (${mapCollider.triangleCount.toLocaleString()} collision triangles)`);
  } catch (err) {
    mapCollider = null;
    showError(`map loaded, collision disabled: ${err.message || err}`);
  }
}
```
Replace with:
```js
let loadedMap = null;
let mapCollider = null;
if (mapKey) {
  setStatus(`loading authored map ${mapKey}...`);
  await nextPaint();
  loadedMap = await loadTerrainMap(mapKey, { scene });
  setStatus('building authored map collision...');
  await nextPaint();
  try {
    mapCollider = createMapCollider(loadedMap.root);
    setStatus(`authored map loaded (${mapCollider.triangleCount.toLocaleString()} collision triangles)`);
  } catch (err) {
    mapCollider = null;
    showError(`map loaded, collision disabled: ${err.message || err}`);
  }
}
```

- [ ] **Step 4: Call dismiss() just before the animation loop**

Find:
```js
renderer.setAnimationLoop(animate);
```
Replace with:
```js
dismiss();
renderer.setAnimationLoop(animate);
```

- [ ] **Step 5: Remove the #mp-panel div from the HTML body**

At the bottom of the file (just before `</body>`), remove:
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

- [ ] **Step 6: Manual verification — Solo flow**

Open `environment-viewer.html` in browser (Chrome with WebGPU support).
Expected sequence:
1. Role screen appears: Solo / Host / Join cards visible. No mp-panel in bottom-right corner.
2. Click **Solo**.
3. Map screen appears: Infinite World + any authored maps.
4. Click **Infinite World**.
5. Loading screen appears: "Infinite World · Initializing…"
6. Status updates as world loads.
7. Loading screen dismisses, world is visible and interactive.

- [ ] **Step 7: Manual verification — Host flow**

1. Role screen → type `WOLF` in Host input → click Host →.
2. Map screen header shows `Host · WOLF`.
3. Choose a map → loading screen shows `<mapName> · Host · WOLF`.
4. World loads, loading screen dismisses.
5. No mp-panel visible anywhere.

- [ ] **Step 8: Manual verification — Join flow (requires a running relay)**

Start relay locally: `cd server && node server.js`

Tab A (host): Role screen → Host with code `TEST` → choose map → world loads.
Tab B (guest): Role screen → Join → type `TEST` → click Join →.
Expected in Tab B:
- Brief "Checking…" on the button.
- Map screen is skipped.
- Loading screen appears with `<hostMapName> · Guest · TEST`.
- World loads with same map as host.
- Ghost boxes appear in Tab B's world at creature positions.

- [ ] **Step 9: Manual verification — Join with bad code**

Role screen → Join → type `XXXX` → click Join →.
Expected: "No active room with that code" error appears below the Join button. Stay on role screen.

- [ ] **Step 10: Commit**

```bash
git add environment-viewer.html
git commit -m "feat(viewer): wire 3-step start wizard, remove mp-panel"
```
