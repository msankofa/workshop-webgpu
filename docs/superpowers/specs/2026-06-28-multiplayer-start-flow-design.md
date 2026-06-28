# Multiplayer Start Flow Design

**Date:** 2026-06-28

## Problem

The current flow drops players into the world before they've established a multiplayer context. The mp-panel appears as a floating overlay after world load, can be hidden by the GUI toggle, and is architecturally disconnected from world selection. Guests have no way to inherit the host's map. The multiplayer panel is developer-convenience UI, not player-facing design.

## Desired Flow

```
Role screen → (solo/host) → Map screen → Loading screen → World
             → (join)     → Loading screen → World
```

1. **Role screen** — first thing shown on load. Three options: Solo, Host (with room code input), Join (with room code input).
2. **Map screen** — shown to Solo and Host only. Same map cards as today. Joiners skip this screen — they inherit the host's map automatically.
3. **Loading screen** — blocking. No early entry. Shows live status messages while the world initializes. Dismissed only when the world is fully ready.

The mp-panel is removed entirely.

---

## File Changes

### `server/server.js`

- When a host registers (`{ type: 'host', room, mapKey }`), store `mapKey` on the room object.
- When a guest joins, include `mapKey` in the `joined` response: `{ type: 'joined', clientId, guestCount, mapKey }`.
- Add a `query` message type: `{ type: 'query', room }` → responds with `{ type: 'room_info', hasHost: bool, mapKey: string|null }` without registering the sender as a guest.

### `start-screen.js`

Full rewrite as a 3-step wizard. Single export:

```js
export async function showStartScreen()
// Returns: { mapKey, mpRole, roomCode, setStatus, dismiss }
```

**Step 1 — Role screen:**
- Three cards: Solo, Host, Join.
- Host card has a text input for the room code (required, uppercase, max 6 chars).
- Join card has a text input for the room code.
- Clicking Solo → advance to Step 2 (map screen).
- Clicking Host → validate code is non-empty (show inline error on the card if blank) → advance to Step 2 (map screen).
- Clicking Join → validate code is non-empty → send `query` to relay → if `hasHost: false`, show inline error "No active room with that code", stay on Step 1 → if `hasHost: true`, receive `mapKey`, advance directly to Step 3 (loading screen).

**Step 2 — Map screen (solo/host only):**
- Same card layout as current `showStartScreen`. Header shows role context ("Choose Map · Host WOLF").
- Clicking a card → advance to Step 3.

**Step 3 — Loading screen:**
- Overlay stays up. Shows map name, role, room code in header.
- Shows a status line updated via `setStatus(msg)`.
- No dismiss button. Caller calls `dismiss()` when ready.

**Return value:**
- `mapKey`: the selected map key (string) or `null` for Infinite World.
- `mpRole`: `'solo' | 'host' | 'guest'`.
- `roomCode`: the entered/chosen room code, or `null` for solo.
- `setStatus(msg)`: updates the status line on the loading screen.
- `dismiss()`: removes the overlay, revealing the world.

### `environment-viewer.html`

**Remove:**
- The `?map=KEY` URL param read and `location.replace` redirect block (lines ~64–78).
- The `MAP_KEY` const from URL params.
- The `#mp-panel` div and all its inline styles (lines ~2827–2846).
- The `mp-host-btn`, `mp-join-btn`, `mp-room`, `mp-status` event listeners and helper functions (`_mpSetStatus`, `_mpGenerateCode`, `_mpGhostDestroy`) — lines ~108–186.
- The `window.addEventListener('mp:*', ...)` handlers.

**Add/change:**
- After imports, call `showStartScreen()` and destructure the result.
- Immediately after `showStartScreen()` resolves, establish the MP session based on `mpRole`:
  - `'host'`: `mpSession = createHostSession(roomCode, mapKey, getState)`
  - `'guest'`: `mpGhostRenderer = new GhostRenderer(scene, THREE); mpSession = createGuestSession(roomCode, state => mpGhostRenderer.update(state))`
  - `'solo'`: nothing.
- Replace all `showStatus(msg)` calls during world load with `setStatus(msg)`.
- Call `dismiss()` after the animation loop starts (world fully ready).

**`createHostSession` signature change:** add `mapKey` as a second parameter so the host can include it in the `{ type: 'host', room, mapKey }` registration message.

---

## Relay Protocol Changes

| Message | Direction | Change |
|---------|-----------|--------|
| `{ type: 'host', room, mapKey }` | client→server | `mapKey` field added |
| `{ type: 'joined', clientId, guestCount, mapKey }` | server→client | `mapKey` field added |
| `{ type: 'query', room }` | client→server | new |
| `{ type: 'room_info', hasHost, mapKey }` | server→client | new |

---

## Join Validation

On the join screen, when the player clicks Join:
1. Open a temporary WebSocket to the relay.
2. Send `{ type: 'query', room: CODE }`.
3. On response:
   - `hasHost: false` → show inline error "No active room with that code". Close the temporary socket. Stay on Step 1.
   - `hasHost: true` → store `mapKey` from response. Close the temporary socket. Advance to Step 3 (loading screen). The actual guest session is created in environment-viewer.html after `showStartScreen()` returns.
   - WebSocket connection failure (relay unreachable) → show inline error "Could not connect to relay server". Stay on Step 1.

---

## Out of Scope

- Mid-session room switching (mp-panel is removed; no replacement).
- `?map=KEY` deep-link bookmarks (always shows full flow).
- Player ghost broadcasting (the `players: []` stub in `getState` is unchanged).
