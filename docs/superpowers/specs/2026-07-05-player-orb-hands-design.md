# Player floating orb hands

Date: 2026-07-05
Subsystem: multiplayer (`multiplayer.js`, new `player-hands.js`, `environment-viewer.html`)

## Goal

Give player capsules two floating orb hands. The main ask: **you can see your own
two orbs in first-person (FPS) mode.** For consistency, remote players' capsules get
the same orbs so you see other people's hands too.

## Background (what makes this two pieces)

- In FPS mode the camera sits at the capsule top (`playerCollider.end`) and **your own
  capsule is not rendered** — only remote players are drawn (by `GhostRenderer`). So
  first-person hands must be a **camera-attached viewmodel**, separate from the ghost
  system.
- Remote players already render as a `Group` container (body + eyes) in
  `GhostRenderer._updatePlayers`. Adding orbs there covers everyone else's hands. Their
  yaw is known (`q` is pure yaw), so orb positions need no extra network data.
- `playerVelocity` and `playerOnFloor` are available each frame in
  `environment-viewer.html`, so the local viewmodel can bob/sway with movement.

## Design

### Shared look

- Two orbs per avatar, floating (not connected to the body), tinted to match that
  player's body color.
- Orb = the existing shared unit `SphereGeometry` scaled to radius ~`0.12` (scaled with
  the capsule radius `r`).
- Motion: a small idle bob (vertical sine, opposite phase per hand) plus a walk-sway
  (orbs swing fore/aft, opposite phase, amplitude scaled by horizontal speed).

### Tint helper (dedup)

Body/orb tint is currently computed inline in `GhostRenderer._makePlayer`
(`bodyMat.color.setHSL((_hashId(id) % 360)/360, 0.45, 0.72)`). Extract this to an
exported pure helper so the local viewmodel uses the exact same color as the player's
remote ghost:

```
export function playerTintHSL(id): [h, s, l]   // in 0..1
```

`GhostRenderer` uses it for the body + orbs; the viewmodel uses it for the local
player's orbs.

### Part A — Remote orbs (in `GhostRenderer`)

- `_makePlayer` adds `leftHand` / `rightHand` orb meshes (shared `_eyeGeo` sphere,
  per-player `bodyMat`) to the container, and stores them + a per-player bob phase and a
  `lastPos`/`lastNow` for speed estimation in `userData`.
- `_placeEyes` gains orb base placement (or a sibling `_placeHands(g, r, h)`):
  local-frame `x = ±(r * 1.1)`, `y ≈ h * 0.15` (shoulder-ish), `z = -(r + orbR + 0.05)`
  (front, −Z), orb scale `0.12 * (r/0.3)`.
- `tick(nowMs)` (already the per-frame driver) animates the orbs: idle bob on
  `userData.handPhase`; walk-sway amplitude from horizontal speed estimated as
  `dist(container.pos, lastPos) / dt` (update `lastPos`/`lastNow` each tick). Reuses the
  same loop that already does blink — no new per-frame call.
- `destroy()` / removal: orbs share geometry and the per-player `bodyMat` (already
  disposed on removal), so no new disposal is needed.

### Part B — Local FPS viewmodel (`player-hands.js`, new)

Small module, `THREE` passed in (same pattern as `GhostRenderer`, keeps it Node-testable):

```
export function createViewHands(camera, THREE): {
  setTint(hsl: [h,s,l]): void,
  setVisible(v: boolean): void,
  update(dt, { speed, onFloor }): void,
  destroy(): void,
}
```

- Builds one `Group` with two orb meshes and `camera.add(group)` so the orbs live in
  **camera-local space** (they follow head look automatically). Base local offsets:
  `x = ±0.28`, `y = -0.32`, `z = -0.7` (in front; camera looks down −Z), radius `0.12`.
- `update` applies idle bob + walk-sway to the orbs' local positions; `speed` is the
  horizontal length of `playerVelocity`, `onFloor` lets a small landing dip be added
  later (cosmetic-only v1 keeps it simple).
- `setVisible(false)` hides them (orbit mode); `setVisible(true)` on FPS enter.
- `setTint` applies `playerTintHSL(localId)` so your hands match your own ghost's color.

### Wiring in `environment-viewer.html`

- After `worldModels` setup: `viewHands = createViewHands(camera, THREE)` and
  `viewHands.setTint(playerTintHSL(localPlayerId()))` (host → `'host'`, guest →
  `mpClientId`, solo → a fixed default).
- `enterFPS()` → `viewHands.setVisible(true)`; `exitFPS()` → `setVisible(false)`.
- In `animate()`'s `fpsMode` block (after `updateFPSPlayer`): `viewHands.update(rawDt,
  { speed: horizontalLen(playerVelocity), onFloor: playerOnFloor })`.

## Non-goals / follow-ups

- Hands reacting to actions (lunge on left-click, charge in shoot mode) — cosmetic-only
  in v1.
- Landing/jump dip, inertia lag on the viewmodel.
- Sending real per-hand positions over the network (orbs are derived locally from yaw).

## Implementation plan

1. **`multiplayer.js` — tint helper.** Add `export function playerTintHSL(id)` returning
   `[h, s, l]`; rewrite `_makePlayer` to call it for `bodyMat`.
2. **`multiplayer.js` — remote orbs.** Add `leftHand`/`rightHand` orbs in `_makePlayer`
   (shared sphere geo, `bodyMat`), place them in `_placeHands(g, r, h)` called from
   `_updatePlayers`, and animate bob + speed-based sway inside the existing `tick()` loop
   (store `handPhase`, `lastPos`, `lastNow` in `userData`).
3. **`player-hands.js` — new viewmodel module.** Implement `createViewHands` as specced
   (camera-child group, two orbs, `setTint`/`setVisible`/`update`/`destroy`).
4. **`environment-viewer.html` — wire it.** Instantiate, tint from the local player id,
   toggle visibility on FPS enter/exit, and call `update` in the `fpsMode` step. Add a
   small `localPlayerId()` / `horizontalLen()` helper as needed.
5. **Tests.**
   - Extend `test-ghost-renderer.mjs`: player container now has two orb meshes tinted
     with `bodyMat`; `tick()` moves the orbs (bob); `playerTintHSL` is deterministic and
     differs across ids.
   - New `test-player-hands.mjs` (THREE stub): `createViewHands` adds a group with two
     orbs as a child of the stub camera; `update` moves them and scales sway with
     `speed`; `setVisible` toggles `group.visible`; `setTint` sets both orb colors;
     `destroy` removes the group from the camera.
6. **Docs + log.** Update `docs/subsystems/multiplayer.md` (GhostRenderer orbs +
   `playerTintHSL` + new `player-hands.js` file/row) and append an `agent_log.csv` row
   (subsystem `multiplayer`).

## Testing (manual)

- FPS mode: two tinted orbs float in front-lower view, bob at rest, sway while walking,
  hidden in orbit mode.
- Two clients via relay: each remote capsule shows two orbs matching its body tint,
  bobbing/swaying.
