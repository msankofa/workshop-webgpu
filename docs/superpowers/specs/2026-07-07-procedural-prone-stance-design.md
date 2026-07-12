# Procedural Prone Stance

Date: 2026-07-07
Subsystem: player visuals (`player-procedural-body.js`, `environment-viewer.html`)

## Goal

Give the procedural player body a real **prone** representation. Today the FPS controller has
three stances (`stand` / `crouch` / `prone`, toggled with C and Z) but only `crouch` has a body
representation, and even that is a vertical squash. Prone currently maps to full crouch as an
interim look (see `environment-viewer.html`, the `lbCrouch` stance map) — the body stays upright
and just steps very slowly. We want prone to actually lie the body horizontal and crawl.

## Background

- **Stance lives in the controller.** `stance` (module global) is set by C/Z; it drives movement
  speed only (`speedStand 2.05`, `speedCrouch 1.0`, `speedProne 0.5`) and gates run/jump to
  `stand`. It does not resize the collider.
- **The body is a pure follower.** `createProceduralPlayerBody().update(dt, state)` reads
  `state.crouch` (0..1) and squashes the vertical stack (pelvis −30%, torso/shoulders −40%,
  head −50% at crouch=1), composed on top of the speed-adaptive gait (`gaitForSpeed`). There is
  **no horizontal / lying-down channel** — the crouch squash cannot lay a body flat.
- **Gait is speed-adaptive.** `adaptGaitToSpeed:true` derives pelvis/stride/lift/cadence from the
  body's own speed. A prone crawl is a *different* locomotion mode, not just a slower walk, so it
  needs its own pose/gait path rather than a point on the speed curve.

## Non-Goals

- No new collider shape or server authority. Prone is visual-only, like the rest of the body.
- No first-person prone camera work (camera height / pitch clamp) — controller concern, separate.
- Not modeling belly-slide, roll-to-prone transitions with momentum, or prone weapon bipod deploy.

## Design

Add a **stance channel** to the body state alongside `crouch`, and a prone pose + crawl gait
that the rig blends toward by a 0..1 `prone` weight (so stand↔crouch↔prone are smooth, not snaps).

### 1. State seam

Extend the `update(dt, state)` contract with an optional `prone` scalar (0..1), independent of
`crouch`:

```js
{ ...existing, crouch: 0..1, prone: 0..1 }
```

The game maps stance → `{ crouch, prone }`:

| stance | crouch | prone |
|--------|--------|-------|
| stand  | 0      | 0     |
| crouch | 0.7    | 0     |
| prone  | 0      | 1     |

Blend the interim `lbCrouch` map out once `prone` is honored. Transitions can be eased in the
game (lerp the weight over ~0.2 s) or in the body; recommend the body owns a smoothed internal
`_proneW` so all callers get transitions for free.

### 2. Prone pose (the rig at `prone = 1`)

- **Body pitched horizontal.** Pelvis and torso rotate ~85–90° about the body-right axis so the
  long axis lies along the ground heading. Pelvis height drops to ~`radius` above terrain (belly
  near ground); torso and head extend *forward* along the heading rather than *up*.
- **Head** lifts slightly (look-forward) — small negative pitch relative to the torso so the head
  isn't buried in the ground.
- **Legs** extend back and roughly straight (small knee bend), feet trailing behind the pelvis
  along −heading, soles up. The current under-hip foot rest anchors must be replaced by
  behind-pelvis anchors when prone.
- **Arms** forward along the heading, elbows tucked near the ground supporting a forward weapon
  (reuse the weapon anchors; the existing `setArmTarget` seam already drives hands to grips).
- The whole rig sits at heading `yaw` (already `yaw+PI` internally); prone only adds the pitch and
  the fore/aft limb rearrangement.

Implement as a target set of joint offsets that the existing 2-bone IK solves toward, blended by
`_proneW` against the upright solve — i.e. lerp the *IK targets* (hip attach, foot target,
shoulder attach, pelvis/torso/head transforms), not the final mesh matrices, so IK stays valid.

### 3. Crawl gait (`prone = 1`, moving)

A prone crawl is short alternating pulls, not strides:

- Much smaller `maxStepDistance` (≈0.4) and lower `stepLift` (≈0.05 — feet/knees skim the ground).
- Feet target *behind and to the side* of the pelvis (push points), alternating.
- Cadence still from speed, but off a prone-specific floor (crawling is slow; `speedProne 0.5`).

Cleanest approach: a second gait profile `GAIT_PRONE` (analogous to `GAIT_SPEED_MODEL` but a fixed
low-crawl config), selected when `_proneW > 0.5`, with the foot rest anchors moved behind the hips.
The pure `stepGait` scheduler already supports arbitrary rest anchors and step params, so this is
mostly feeding it prone anchors + a prone cfg rather than new scheduler logic.

### 4. Composition with crouch and speed model

`crouch` and `prone` are separate weights; a body is never both at once in-game (stance is
exclusive), but the math should degrade gracefully if both are >0 (e.g. clamp `crouch *= 1 - prone`
so prone wins). The speed-adaptive gait stays active for stand/crouch; when `_proneW > 0.5` the
crawl gait/anchors take over.

## Testing

- **Headless (`node`)**: extend `test-player-body-gait.mjs` — feed prone anchors + `GAIT_PRONE`
  and assert feet alternate behind the pelvis, step distance/lift stay within the crawl bounds, and
  cadence scales with the (low) prone speed. Pure scheduler math, no THREE.
- **Preview (`body-preview.html`)**: add a stance selector (stand/crouch/prone) so the horizontal
  pose, crawl, and stand↔prone transition can be eyeballed before touching the game. Reuse the
  existing weapon mount so prone weapon-hold reads correctly.
- **In-game**: third-person body (B), press Z, walk — body lies down and crawls; C still crouches;
  transitions are smooth; weapon stays in hand.

## Open questions

- Does prone need to rotate the whole `group` (simpler) or only pitch pelvis/torso while feet stay
  world-planted (more correct on slopes)? Lean toward pelvis/torso pitch + terrain-following limbs.
- First-person prone: should the FPS camera drop and pitch-clamp? Out of scope here; note for the
  controller pass so the two land together.
- Remote players: prone should replicate via the existing stance in the player snapshot once remote
  procedural bodies are enabled (currently capsule ghosts) — verify the wire state carries stance.
