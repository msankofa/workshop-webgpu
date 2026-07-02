# Multiplayer

> 🗺️ [View this subsystem in the interactive code map](../../code-map.html#multiplayer)

## Purpose

Optional two-role multiplayer mode layered on top of the single-player sim. One browser tab
becomes the **host**: it runs the real creature simulation and broadcasts a snapshot of world
state 20 times/second over a WebSocket relay. Any number of other tabs can **join** as
**guests**: they don't simulate anything locally — they receive host snapshots, smooth them
with a small interpolation buffer, and render lightweight "ghost" meshes (boxes for creatures,
capsules for players) at the interpolated positions. A small Node relay server pairs hosts and
guests by a short room code; it never touches simulation logic, it only forwards JSON messages
between sockets in a room.
Player avatars are synced as capsule poses: the host includes its own walk-mode capsule plus
the latest guest capsules in each snapshot, and guests send their local `player_state` to the
host at the same 20 Hz cadence after the spawn capsule is initialized.

## Files

| File | Responsibility | Lines |
|---|---|---|
| `multiplayer.js` | Client-side networking: `RELAY_URL`, `InterpolationBuffer`, `createHostSession`, `createGuestSession`, `GhostRenderer` | 252 |
| `start-screen.js` | Pre-game modal UI: Solo/Host/Join role picker, map picker, loading screen; resolves `{ mapKey, mpRole, roomCode }` before the sim boots | 253 |
| `server/server.js` | Relay backend (Node, `ws` library): room registry, host↔guest message forwarding, room presence queries | 82 |

Deployment context: `server/package.json` declares `ws` as the only dependency and `npm start`
runs `node server.js`. `server/render.yaml` deploys it as a Render web service named
`creature-relay` (root dir `server`, `npm install` / `npm start`, `PORT` from a Render env group).

## Public API

### `multiplayer.js`

- `export const RELAY_URL` — `wss://workshop-webgpu.onrender.com` by default, overridable via the
  `?relay=wss://...` query param.
- `export class InterpolationBuffer` — ring buffer of up to 3 timestamped snapshots.
  - `push(state: object, t = performance.now())`
  - `sample(renderTime: number): object | null` — returns the snapshot at `renderTime`, lerped
    between the two bracketing entries (clamped to the first/last snapshot outside the range,
    `null` if empty).
- `export function createHostSession(roomCode: string, mapKey: string|null, getState: () => object): { destroy(): void }`
  — opens a WebSocket, sends `{type:'host', room, mapKey}`, then broadcasts
  `{type:'sim_state', seq, ...getState()}` every 50 ms (`BROADCAST_MS`, 20 Hz). Incoming messages
  are re-dispatched as `window` `CustomEvent('mp:guest_input', {detail: msg})`. Auto-reconnects
  with exponential backoff (1 s → 30 s cap).
- `export function createGuestSession(roomCode: string, onState: (state: object) => void): { sendInput(msg: object): void, destroy(): void }`
  — opens a WebSocket, sends `{type:'join', room}`. `sim_state` messages are pushed into an
  internal `InterpolationBuffer`; every other message type is re-dispatched as
  `CustomEvent('mp:' + msg.type, {detail: msg})`. Runs its own `requestAnimationFrame` loop that
  samples the buffer at `now - 100ms` (fixed interpolation delay) and calls `onState(state)`.
  Same reconnect backoff as the host.
- `export class GhostRenderer` — `constructor(scene, THREE)` (THREE passed in, not statically
  imported, so the module stays importable from plain Node for tests).
  - `update(state: { creatures?: [], players?: [] })` — creates/reuses one box `Mesh` per
    creature id and one capsule `Mesh` per player id, sets position/quaternion from `p`/`q`,
    scales player capsules from optional `h`/`r`, and removes meshes for ids no longer present.
  - `destroy()` — removes and disposes all ghost meshes/geometries/materials.

### `start-screen.js`

- `export async function showStartScreen(): Promise<{ mapKey, mpRole, roomCode, setStatus(msg), dismiss() }>`
  — builds a full-screen DOM overlay (no Three.js dependency), walks the user through: role
  choice (Solo / Host / Join) → map choice (host/solo only — guests inherit the host's map) →
  a loading panel, then resolves with the chosen role/room/map and helpers to update the loading
  status text or dismiss the overlay. Internally fetches `maps/map-config.json` for the map list
  and, for Join, opens a short-lived WebSocket to query room presence (`{type:'query', room}`)
  before resolving.

## Wiring

`environment-viewer.html` statically imports both modules:

```js
import { showStartScreen } from './start-screen.js';
import { createHostSession, createGuestSession, GhostRenderer } from './multiplayer.js';
```

Boot sequence (top of the module, before the renderer/scene are built):

1. `const { mapKey, mpRole, roomCode, setStatus, dismiss } = await showStartScreen();` — blocks
   scene setup until the user picks a role (and map, for host/solo). The resolved `mapKey` is
   later used by `loadTerrainMap`.
2. `getState()` is defined to read the live `portCreatures` system and shape it into
   `{ creatures: [...], players: [...] }`. Creature entries carry `id`, `p`, `q`, `hp`, `feet`,
   and `hands`. Player entries carry `id`, `p`, `q`, plus capsule `h`/`r`. The host adds its own
   initialized walk-mode capsule as `id: 'host'` and appends the latest guest capsules received
   through `player_state` messages.
3. Role dispatch:
   - `mpRole === 'host'` -> creates a `GhostRenderer` for guest player capsules and starts
     `createHostSession(roomCode, mapKey, getState)`. The host renders only guest players as
     ghosts; local creatures remain the real simulated meshes.
   - `mpRole === 'guest'` -> `mpGhostRenderer = new GhostRenderer(scene, THREE)` and
     `mpSession = createGuestSession(...)`. The guest filters its own `clientId` out of incoming
     `players` before rendering ghosts, then sends its local capsule pose back to the host as
     `{type:'player_state', player}` every 50 ms after the spawn capsule has been initialized.
     Ghost updates happen inside `multiplayer.js`'s own `requestAnimationFrame` loop, **not** from
     the main `animate()` render loop in `environment-viewer.html` - the two rAF loops run
     independently.
   - `mpRole === 'solo'` -> neither is created; `mpSession`/`mpGhostRenderer` stay `null`.
4. `window.addEventListener('mp:guest_input', ...)` on the host side stores `player_state`, removes
   `guest_left` capsules, and still handles `set_target` / `set_behavior` messages forwarded from
   guests by applying them to `portCreatures.system`.

`start-screen.js` → `multiplayer.js` connection: the Join flow's `_queryRoom()` opens a one-off
`WebSocket(RELAY_URL)` (imported from `multiplayer.js`) to ask the relay `{type:'query', room}`
and get back `{hasHost, mapKey}` before handing control to `environment-viewer.html`'s session
creation.

**Client ↔ relay protocol** (plain WebSocket, JSON-text frames, no binary/compression):
- Host → relay: `{type:'host', room, mapKey}`, then repeated `{type:'sim_state', seq, creatures, players}`.
- Guest → relay: `{type:'join', room}`, `{type:'query', room}`, `{type:'player_state', player}`, or arbitrary input messages (e.g. `{type:'set_target', pos}`, `{type:'set_behavior', behavior}`).
- Relay → guest: `{type:'joined', clientId, guestCount, mapKey}`, `{type:'host_joined'}`, `{type:'host_left'}`, forwarded `sim_state` frames.
- Relay → host: forwarded guest messages tagged with `{..., clientId}`, plus `{type:'guest_joined', clientId}` / `{type:'guest_left', clientId}`.
- Relay → query sender: `{type:'room_info', hasHost, mapKey}`.

## Architecture notes

- **Host-authoritative, server-dumb relay.** `server/server.js` holds no simulation state beyond
  a `rooms: Map<code, {host, mapKey, guests}>` registry (server.js:6) and blindly forwards
  whatever JSON the host/guests send — it never inspects `sim_state` contents. All physics/AI
  runs only on the host's machine; guests are pure read-only spectators of interpolated ghosts.
- **Snapshot interpolation, not extrapolation/prediction.** `InterpolationBuffer` keeps just the
  last 3 snapshots and linearly interpolates position/quaternion (slerp) and HP between the two
  bracketing entries; it clamps to the nearest end outside the buffered range rather than
  extrapolating. `createGuestSession` deliberately samples `now - 100ms` to stay inside the
  buffered window most of the time, trading 100 ms of extra latency for smoothness against the
  host's 50 ms broadcast cadence.
  Convention enforced by both server and `GhostRenderer`: vectors are plain `[x,y,z]` /
  `[x,y,z,w]` quaternion arrays, not `THREE.Vector3`/`Quaternion` instances — `GhostRenderer` and
  `_lerpV3`/`_slerpQ` destructure them positionally. Player interpolation matches snapshots by
  `id`, not array index, so host/guest ordering changes do not cross-wire avatars.
- **No reconciliation/ownership conflicts.** There's exactly one host per room (`r.host` is a
  single `WebSocket`, not a set); a second `{type:'host'}` for the same room silently replaces
  the previous host reference with no kick/handoff message.
  Room lifecycle: `pruneRoom` deletes a room once both `host` is null and `guests` is empty
  (server.js:13-16), so empty rooms don't leak in the `rooms` map.
- **`GhostRenderer` is test-friendly by construction** — `THREE` is passed into the constructor
  instead of imported at module scope specifically so `multiplayer.js` can be loaded under plain
  Node without a DOM/WebGPU context (see `multiplayer-test.mjs`).

## Tests

`multiplayer-test.mjs` (repo root, run via plain `node`, no test framework/assertion library —
uses `console.assert` + manual exit) imports only `InterpolationBuffer` from `multiplayer.js`
and checks:
- Two pushed snapshots (creature moving x=0→10, hp 1.0→0.5 over t=1000→1100ms) sampled at the
  midpoint (t=1050) linearly interpolate position (`x=5`) and `hp` (`0.75`).
- Player snapshots interpolate by matching `id` even when the host and guest entries arrive in
  different array orders, including capsule height interpolation.
- Sampling before the first snapshot (t=900) clamps to the first snapshot's state.
- Sampling after the last snapshot (t=1200) clamps to the last snapshot's state.
- An empty buffer's `sample()` returns `null`.

It does **not** test `createHostSession`/`createGuestSession`/`GhostRenderer`, the WebSocket
protocol, slerp correctness, or `server/server.js` — those are unverified by automated tests.
