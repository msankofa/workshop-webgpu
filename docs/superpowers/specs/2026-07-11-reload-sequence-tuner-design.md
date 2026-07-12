# Reload Sequence Tuner (Scrub + Per-Key Offset Editing)

Date: 2026-07-11
Subsystem: creature (procedural body / weapon pose sequences) + infra (preview tooling)
Status: WIP design. Host is `body-preview-v3.html`. Implement in the same pass.

## Goal

Give a manual, visual way to author and correct reload animations. Today reload keys in
`weapon-poses.json` (the `reloadSequence.<weaponId>.keys` array) are authored blind: the
`{body:[x,y,z]}` and belt-anchor hand targets have no on-screen reference, which is how the
m1911 reload ended up reaching *through* the torso (X/Z authored in the wrong sign of the
body-local frame). The tuner lets a person:

- Scrub the reload timeline (0 → `duration`) and pause on any frame, or play it through.
- See exactly where each hand target lands relative to the live body and the torso capsule.
- Nudge the selected key's hand-target offset on X/Y/Z (and its `t`) with sliders, live.
- Export the corrected `weapon-poses.json` to paste back over the sidecar file.

## Why `body-preview-v3.html`, not `weapon-anchor-editor.html`

The earlier note pointed at `weapon-anchor-editor.html`, but that tool loads only the weapon
GLB at identity — there is no body in it. The reload keys that break are **body-relative**
(`{body:[...]}`) and belt-anchor (`beltMagazine`) targets; you cannot judge whether a hand
phases through the torso without a body on screen. `body-preview-v3.html` already:

- builds the real `player-procedural-body.js` rig and drives real arm IK (so phasing and
  elbow-break show up exactly as they do in game, via the body-aware capsule clamp),
- mounts the real weapon GLB and runs the real `weapon-pose-controller.js`,
- has a `Reload` button that already plays the sequence through `controller.play('reload')`.

So the tuner is a small addition there (a scrub slider + a key/offset editor + export), not a
from-scratch rebuild. Weapon-**anchor** editing (rightGrip/magwell/etc., which live in
`weapon-anchors.json`) stays in `weapon-anchor-editor.html`; this tuner only edits the
**pose sequence** file `weapon-poses.json`.

## Coordinate frames (do not re-derive at author time — this is the bug source)

- Body-local (`{body:[x,y,z]}`, `beltMagazine`) resolves against `body.rootAnchor`, which
  faces `cameraYaw + PI`. Frame is **+x = body's LEFT, +y = up, +z = forward**. Authoring
  with a camera convention (+x right, −z forward) mirrors the reach across/behind the torso.
- Weapon-anchor refs (`rightGrip`, `{weaponAnchor, offset}`) resolve against the weapon root
  (baked GLB anchors); offsets are in the weapon's local meter space.
- The tuner's sliders always edit the raw stored numbers in whatever frame that ref already
  uses. The slider labels state the frame (X = left+, Y = up+, Z = forward+ for body refs).

## Data touched

Only `weapon-poses.json`'s `reloadSequence.<weaponId>.keys[i]`. The editable fields per key:

- `left` / `right` when the value is `{ body:[x,y,z] }` → edit `body`.
- `left` / `right` when the value is `{ weaponAnchor, offset:[x,y,z] }` → edit `offset`.
- `t` (the key time) → a slider clamped within its neighbors' times.

String refs (`"rightGrip"`, `"magwell"`, `"beltMagazine"`) have no numeric offset to tune;
the panel shows them read-only. `beltMagazine`'s pouch position lives in
`weapon-pose-controller.js`'s `DEFAULT_BODY_ANCHORS`, not in `weapon-poses.json`, so it is out
of scope for this exporter (documented in the panel as a note).

The tuner mutates the in-memory `WEAPON_POSES` object **in place**. `getWeaponDef(id)` returns
`WEAPON_POSES.reloadSequence[id]` by reference and `weapon-pose-controller.js` holds that same
object as `s.activeSeq` once reload is playing, so live edits take effect on the next frame
without a re-play.

## Playback / scrub model

`weapon-pose-controller.js`'s `update(dt, state)` already supports host-authoritative time:
when `state.action` and `state.actionTime` are both supplied, the controller evaluates the
sequence at exactly that time and does not self-advance or auto-complete. The tuner uses this:

- **Scrub (paused):** each frame call `controller.update(dt, { action: 'reload', actionTime: scrubT })`
  with `scrubT` from the slider. Dragging the slider re-evaluates instantly.
- **Play:** advance `scrubT += dt` (loop at `duration`), feeding the same host-authoritative
  path so the playhead and slider stay in sync; events fire on forward crossings as normal.
- **Off (tuner disabled):** revert to the existing `controller.update(dt, {})` local path and
  `controller.play('idle')` once so the arms return to the aim/low-ready blend.

The existing `Reload` button keeps working (fire-and-forget local play); the tuner is a
separate mode toggle so the two don't fight over `actionTime`.

## UI (new "Reload Tuner" panel section in the Weapon tab)

- **Enable tuner** checkbox (mode toggle).
- **Play / Pause** button.
- **Scrub** range slider `[0, duration]`, step ~0.005; shows current `t` and the nearest key.
- **Key list**: one selectable row per key, showing `t`, the active hand refs, and `event`.
  Selecting a key snaps the scrub playhead to that key's `t` and loads its offset sliders.
- **Hand channel** selector (left / right) when the selected key defines both; defaults to the
  channel whose value is an editable object ref.
- **Offset sliders**: X / Y / Z for the selected editable ref, range roughly `[-0.8, 0.8]`
  meters, step 0.005, with live numeric readout. Labels state the frame.
- **Key time (`t`)** slider, clamped to `(prevKey.t, nextKey.t)`.
- **Marker emphasis**: the driven hand target markers already exist via the rig; the selected
  key's target marker is highlighted (color/scale) and the torso capsule is drawn so
  penetration is visible.
- **Export**: a textarea holding `JSON.stringify(WEAPON_POSES, null, 2)` plus **Copy** and
  **Download** buttons (same pattern as `weapon-anchor-editor.html`'s export).

## Non-goals

- No change to `weapon-sequence.js` evaluation semantics or `weapon-pose-controller.js` logic.
- No writing to disk from the browser (copy/download only, same as the anchor editor).
- No editing of weapon anchors, `weaponPose` p/r, `duration`, or `commitAmmoAt` in this pass
  (scrub reveals whether those need work; they can be added later).
- No new sidecar files; only `weapon-poses.json`'s existing shape round-trips.

## Acceptance

- Enabling the tuner and scrubbing shows the reload arm poses at every `t` with the real body.
- Selecting the m1911 `detachMagazine` / `tossMagazine` keys and moving the X/Y/Z sliders moves
  the left-hand target live, and the exported JSON reflects the new numbers.
- With corrected offsets the left hand stays on the body's left/front and does not enter the
  torso capsule at any scrub position.
- Turning the tuner off returns the arms to the normal aim/low-ready idle.
- `node test-weapon-sequence.mjs` and `node test-weapon-pose-controller.mjs` still pass
  (no evaluator/controller changes; the tuner is host-side only).
