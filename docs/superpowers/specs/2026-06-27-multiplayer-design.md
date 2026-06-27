# Multiplayer — Shared Simulation via WebSocket Relay

**Date:** 2026-06-27  
**Status:** Approved

## Summary

Add multiplayer to the environment viewer using a host-authoritative model. One client (the host) runs the full simulation as it does today. Other clients (guests) receive periodic state snapshots and render them. A lightweight WebSocket relay server deployed on Render.com routes all traffic. Guests have limited control (target placement, behavior mode, eventually FPS player movement).

---

## Architecture

Three components with single responsibilities:

### Relay Server (`server/`, Render.com)

Node.js WebSocket server (~80 lines). Knows nothing about the simulation. Maintains a room map: one host + N guests per room code.

- Message from host → fan out to all guests in room
- Message from guest → forward to host, prepending sender's `clientId`
- On disconnect: notify remaining peers

### Host Client

Runs the simulation exactly as today. Imports `multiplayer.js` which:
- Connects to the relay as host role
- Serializes creature + grabbable + player state every 50 ms (20 Hz) and sends it
- Listens for guest input events and applies them via existing simulation functions

### Guest Client

Same `environment-viewer.html` in guest mode. `multiplayer.js`:
- Connects to relay as guest, receives snapshots
- Writes positions into lightweight ghost scene (no physics, no AI)
- Interpolates between snapshots for smooth rendering
- Sends input events on user action
- Guest's own player movement runs locally (client-side prediction) and is sent upstream at 20 Hz

---

## Message Protocol

All messages are JSON over WebSocket with a `type` field.

### Session Setup

The host generates a random 4-character alphanumeric room code client-side and shares it out-of-band (copy/paste). The server accepts any code — no pre-registration.

```
guest → server:  { type: "join",         room: "ABCD" }
host  → server:  { type: "host",         room: "ABCD" }
server → guest:  { type: "joined",       clientId: "x7k2", guestCount: 1 }
server → host:   { type: "guest_joined", clientId: "x7k2" }
server → guest:  { type: "guest_left",   clientId: "x7k2" }
server → guest:  { type: "host_left" }
```

### Simulation State (host → server → all guests, 20 Hz)

```json
{
  "type": "sim_state",
  "seq": 1042,
  "creatures": [
    { "id": 0, "p": [x,y,z], "q": [x,y,z,w], "hp": 0.8,
      "feet": [[x,y,z], ...], "hands": [[x,y,z], ...] }
  ],
  "grabbables": [{ "id": 0, "p": [x,y,z] }],
  "players":   [{ "id": "x7k2", "p": [x,y,z], "q": [x,y,z,w] }]
}
```

Bandwidth estimate: 10 creatures × ~44 floats × 4 bytes = ~1.8 KB/snapshot → ~35 KB/s upstream. Well within Render.com free-tier limits.

### Guest Input Events (guest → server → host)

```json
{ "type": "set_target",    "pos": [x,y,z] }
{ "type": "set_behavior",  "behavior": "combat" }
{ "type": "player_move",   "pos": [x,y,z], "q": [x,y,z,w] }
```

Server prepends `clientId` before forwarding to host — host never trusts clientId from the payload.

### Guest Rendering

Guests maintain a 3-snapshot ring buffer and render at `now − 100 ms`, linearly interpolating between the two nearest snapshots. This absorbs network jitter without visible stutter.

---

## File Structure

### New Files

```
server/
  server.js       — WebSocket relay (~80 lines, only dep: 'ws')
  package.json    — { "dependencies": { "ws": "^8" } }
multiplayer.js    — client-side host + guest logic (~300 lines)
```

### Changes to `environment-viewer.html`

- Import `multiplayer.js`
- Add connection UI: room code input, Host/Join buttons, guest count badge (matches existing UI style)
- In `animate()` loop: if host mode active, call `multiplayerTick(dt)` to broadcast state
- On guest input received: call existing `setTarget()`, `setBehavior()` etc. — no changes to simulation internals

### `multiplayer.js` Internal Structure

| Export | Description |
|---|---|
| `createHostSession(roomCode, getState)` | Returns `{ tick(), destroy() }`. `getState` callback reads current creature/grabbable positions. |
| `createGuestSession(roomCode, onState)` | Returns `{ sendInput(), destroy() }`. `onState` callback receives snapshots. |
| `GhostRenderer` | Places simple capsule meshes for remote players. Consumes `players` array from snapshots. |
| `InterpolationBuffer` | Ring buffer of 3 snapshots. `sample(t)` returns interpolated state at time `t`. |

---

## Render.com Deployment

- Service type: **Web Service**, Node.js, root directory: `server/`
- Env var: `PORT` — set automatically by Render
- Free tier acceptable for prototyping (sleeps after 15 min idle)
- Client connects to: `wss://<app-name>.onrender.com`

---

## Error Handling

| Scenario | Handling |
|---|---|
| WebSocket drop (client) | Auto-reconnect with exponential backoff: 1 s, 2 s, 4 s, cap 30 s |
| Host disconnects | Server broadcasts `host_left` to all guests; guests freeze last frame + show overlay |
| Guest disconnects | Server sends `guest_left` to host; host removes ghost entity |

---

## FPS Path (Future, Designed-For)

- `player_move` messages already in protocol — no relay server changes needed
- Host maintains `players` map (`clientId → { pos, q, mesh }`); ghost capsules already rendered from `sim_state.players`
- FPS combat: add `{ type: "player_action", action: "fire", dir: [x,y,z] }`; host resolves hit detection and broadcasts result
- Lag compensation / rollback netcode is explicitly out of scope for this phase

---

## Out of Scope (This Phase)

- Server-side simulation
- Lag compensation / rollback netcode
- More than ~8 simultaneous guests
- Authentication / room passwords
- Binary serialization (MessagePack, FlatBuffers) — JSON is sufficient at this scale
