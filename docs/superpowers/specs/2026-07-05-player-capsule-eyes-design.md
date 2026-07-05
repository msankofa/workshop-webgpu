# Player capsule eyes + solid body

Date: 2026-07-05
Subsystem: multiplayer (`multiplayer.js`, `environment-viewer.html`)

## Goal

Give remote player capsules a face so you can tell where another player is looking
(and therefore when they are looking at you), and make the capsule a solid body
instead of the current semi-transparent "hologram" look.

Reference: two vertical flat-black oval eyes on a light body (Shy-Guy style).

## Scope

- In scope: remote **player** ghosts rendered by `GhostRenderer` in `multiplayer.js`.
- Out of scope: creature ghosts (stay semi-transparent boxes), the local
  first-person player (never rendered as a ghost), per-player body tinting.

## Current state

Player ghosts are single scaled meshes:

- `multiplayer.js:319` — `_pGeo = CapsuleGeometry(0.3, 1.2, 4, 8)`
- `multiplayer.js:321` — `_pMat = MeshStandardMaterial({ color: 0xffcc44, transparent: true, opacity: 0.7 })`
- `_updateSet` (`multiplayer.js:331`) positions the mesh by `p`, orients by `q`,
  and scales it non-uniformly: `mesh.scale.set(r/0.3, (h + 2r)/1.8, r/0.3)`
  (`multiplayer.js:350`).

Player orientation `q` is pure yaw about Y (`environment-viewer.html:174`:
`q = [0, sin(halfYaw), 0, cos(halfYaw)]`), so a player's forward direction is the
capsule's local **−Z** axis. Eyes on the −Z face therefore point where the player
looks.

`GhostRenderer.update()` is only called on network events (host: on `player_state`
messages / ~1 Hz sync at `environment-viewer.html:270`; guest: per received state at
`environment-viewer.html:315`) — **not** every frame. Blink needs its own per-frame
driver.

## Design

### Structure

Because the capsule mesh is scaled non-uniformly, eyes parented directly to it would
be squashed. Player ghosts become a small container so the eyes stay round:

```
container (Group)     ← position = p, quaternion = q
├─ capsule Mesh       ← solid body, keeps the h/r scale
├─ leftEye  Mesh      ← unscaled in container space, on the −Z face
└─ rightEye Mesh
```

Creature ghosts keep the existing single-mesh path. `_updateSet` gains a small
per-type creation hook: creatures build a plain mesh as today; players build the
container + eyes and store the eye refs and blink state for the tick loop.

### Solid body + eyes

- Body material: `transparent: false, opacity: 1`, recolor from yellow to soft
  off-white (`0xf0ece2`) so the black eyes read clearly. One shared color for all
  players.
- Eyes: shared unit `SphereGeometry` scaled to a vertical oval (~`(0.09, 0.14, 0.06)`
  world units at default radius, flattened in Z to hug the surface). Shared
  `MeshBasicMaterial({ color: 0x111111 })` — unlit so they stay flat black under any
  lighting.
- Placement in container space, scaled with the player's height/radius so they track
  taller/shorter capsules: front `z ≈ -(r + 0.02)`, height `y ≈ +0.25 * heightScale`
  (upper-middle), spread `x = ±0.13`.
- Shared geometry + material → 2 cheap extra meshes per remote player, no per-frame
  allocations.

### Blink

New `GhostRenderer.tick(nowMs)` method, called once per frame from `animate()` in
`environment-viewer.html`.

- Each player container stores `nextBlinkAt` and a de-sync offset seeded from its id
  so players don't blink in unison.
- Idle 3–6 s between blinks; a blink lasts ~120 ms, squashing eye `scale.y`
  1 → ~0.1 → 1 (quick down then up). Eyes otherwise fully open.
- `tick()` walks `_players`, updates eye `scale.y` from blink state. No allocations.

## Implementation plan

1. **`multiplayer.js` — materials/geometry.**
   - Change `_pMat` to `transparent: false, opacity: 1, color: 0xf0ece2`.
   - Add shared eye geometry (`SphereGeometry(1, 8, 8)`) and eye material
     (`MeshBasicMaterial({ color: 0x111111 })`) as fields; dispose them in `destroy()`.

2. **`multiplayer.js` — player container factory.**
   - Add a helper that builds a player ghost: `Group` container holding the capsule
     `Mesh` plus `leftEye`/`rightEye` meshes. Store eye refs + `{ nextBlinkAt,
     blinkStart }` on the container (e.g. `container.userData`).

3. **`multiplayer.js` — `_updateSet` hook.**
   - Parameterize the create/position step so players use the container factory and
     apply `p`/`q` to the container while the capsule child keeps the `h/r` scale, and
     eye positions/height are set from `r`/`h`. Creatures keep current behavior.
   - Removal path (`_scene.remove` on unseen ids) works on the container.

4. **`multiplayer.js` — `tick(nowMs)`.**
   - Add the blink driver described above. Guard against empty `_players`.

5. **`environment-viewer.html` — wire the tick.**
   - Call `mpGhostRenderer.tick(performance.now())` once per frame in `animate()`
     (near the existing multiplayer per-frame updates), guarded by `mpGhostRenderer`.

6. **Docs + log.**
   - Update `docs/subsystems/multiplayer.md` (GhostRenderer now renders solid player
     capsules with eyes + blink and exposes `tick`).
   - Append a row to `agent_log.csv` (subsystem `multiplayer`).

## Testing

- Add/extend a Node test for `GhostRenderer` (stub `THREE` like existing tests) that:
  - creates a player, asserts the container has two eye meshes and a solid
    (non-transparent) body material;
  - calls `tick()` across a blink window and asserts eye `scale.y` drops then recovers;
  - removes the player and asserts the container is removed from the scene.
- Manual: run two clients via the relay, confirm the remote capsule is solid, eyes
  face the remote player's look direction, and blink on independent timers.

## Non-goals / follow-ups

- Per-player body color to distinguish identities.
- Active gaze (pupils tracking a target) — current design is fixed-forward only.
- Eyes on creature ghosts.
