# Reload Sequence Tuner — Implementation Plan

> Single-session inline plan (no agent dispatch). Source spec:
> `docs/superpowers/specs/2026-07-11-reload-sequence-tuner-design.md`.
> Host: `body-preview-v3.html`. Data edited: `weapon-poses.json`.

**Goal:** Add a "Reload Tuner" mode to `body-preview-v3.html` that scrubs/plays the reload
sequence against the real body, lets the user nudge each key's hand-target offset (X/Y/Z) and
`t` live, and exports the corrected `weapon-poses.json`.

**Tech:** Three.js r0.184 WebGPU, single-file `<script type="module">`, no build. The pose
controller and evaluator are unchanged; all new code is host-side in `body-preview-v3.html`.

## Phases

### Phase 1 — Scrub/playback mode
- Add a "Reload Tuner" section to the Weapon tab: Enable checkbox, Play/Pause, Scrub slider,
  and a current-`t` / nearest-key readout.
- In the animate loop, when the tuner is enabled, drive
  `controller.update(dt, { action: 'reload', actionTime: scrubT })`; advance `scrubT` when
  playing (loop at `duration`), hold it when paused/scrubbing. When disabled, keep the existing
  `controller.update(dt, {})` and call `controller.play('idle')` once on the transition off.
- Scrub range max = current weapon's `reloadSequence.duration`; rebuild on weapon switch.

### Phase 2 — Key list + offset/`t` editing
- Build a selectable key list from `WEAPON_POSES.reloadSequence[id].keys` (row shows `t`,
  left/right ref summary, `event`). Selecting snaps the playhead to the key's `t`.
- Hand-channel selector (left/right) shown when both are editable object refs.
- Offset sliders X/Y/Z bound to the selected editable ref (`{body}` → `body`;
  `{weaponAnchor,offset}` → `offset`), plus a `t` slider clamped to neighbor times. All writes
  mutate `WEAPON_POSES` in place so the controller (holding the same object) reflects them next
  frame. String refs render read-only with a note.
- Highlight the selected key's driven hand marker; ensure the torso capsule is visible so
  penetration reads.

### Phase 3 — Export
- Textarea with `JSON.stringify(WEAPON_POSES, null, 2)`, refreshed on every edit; Copy and
  Download buttons (mirror `weapon-anchor-editor.html`'s handlers).

## Verification
- `node test-weapon-sequence.mjs` — evaluator unchanged, must still pass.
- `node test-weapon-pose-controller.mjs` — controller unchanged, must still pass.
- Manual (served via `python serve.py`, open `body-preview-v3.html`): enable tuner, scrub the
  m1911 reload, confirm the left-hand target tracks the slider; select `detachMagazine`, move
  X/Y/Z, confirm the marker moves and the export JSON updates; confirm no torso penetration at
  any scrub position with the corrected offsets; disable tuner → arms return to idle.

## Housekeeping (CLAUDE.md)
- Update `docs/subsystems/creature.md` (reload tuner is a new authoring surface for the weapon
  pose sequences) and note the tool in `docs/subsystems/infra.md` if preview tools are listed
  there.
- Append one `agent_log.csv` row (`date,subsystem,files,summary`).
- Lean comments; no marketing copy.

## If blocked on a design decision
The user is asleep for the scheduled variant of this task — consult a Fable (`claude-fable-5`)
subagent rather than waiting. (For this session the user is present, so ask directly.)
