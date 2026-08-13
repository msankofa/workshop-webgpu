# Bot-viewer-v2 camera redesign plan (2026-07-27)

Replaces the four-mode, two-authority camera in `bot-viewer-v2.html` with one intent model and one
writer per frame. Scoped from a full read of the existing camera code on 2026-07-27; revised the
same day after a review pass caught three defects in the first draft (see §Revision notes).

Related docs: `docs/subsystems/bots.md` §"Follow camera ownership", §"Unified camera rig",
§"POV comfort smoothing" (all three describe the system this plan replaces).

## STATUS

- [x] D1 — drop OrbitControls entirely (decided: yes)
- [x] D2 — zoom-through into first person (decided: yes for anchored, but WASD ownership is an
      explicit axis, NOT distance-derived — see §Revision notes 2)
- [x] D3 — POV auto-recenter defaults off, with an opt-in decay slider
- [ ] Phase 1 — `bot-camera.js` pure intent model + Node test
- [ ] Phase 2 — input layer, OrbitControls removed, pointer lock
- [ ] Phase 3 — anchoring, WASD ownership axis, eye-blend mesh fade
- [ ] Phase 4 — occlusion + comfort ported onto the new model
- [ ] Phase 5 — panel, keybinds, save-slot migration
- [ ] Phase 6 — dead-state deletion, docs, agent_log
- [ ] Browser QA (user gate)

## Why the current system fights the user

Two root causes; everything else is downstream.

1. **Two authorities write the same transform every frame.** `controls.update()` computes a pose
   from user input, then `updateCameraRig(dt)` overwrites `camera.position` / `controls.target`
   wholesale (`bot-viewer-v2.html:10202-10203`). In follow/POV/fly, user input is discarded.
2. **There is no stored intent — it is scraped back out of the rendered pose.**
   `captureFollowUserFraming` (`:752`) recovers distance as `|camera.position − controls.target|`
   against a start-of-drag snapshot with a 0.002 epsilon, direction by normalizing that offset, and
   pan by subtracting the anchor. Four flags (`inputActive`, `inputChanged`, `userInteracting`, a
   450 ms `inputMomentumUntil`) exist only to guess "was that a real drag." Anything that writes the
   pose — presets, occlusion pullback, slot restore — risks being misread as input.

The rendered pose is acting as the interchange format between four modes that each keep their own
orientation representation (OrbitControls' spherical, `cameraFollowUserDirection`,
`pov.baseYaw/basePitch`, `flyCam.yaw/pitch`). That is a coherent design, not an accident —
`resetFollowFraming` (`:2366`) marshals the live pose into follow's representation on every
non-orbit mode entry (`:2442`), and `enterFlyCam` (`:2385`) does the same for fly. **Mode switches
therefore preserve your angle and zoom.** The cost is that intent only exists as a derived quantity,
which is cause #2.

Secondary, all downstream: `maxPolarAngle = π × 0.485` (`:110`) forbids low ground-level angles; no
pointer lock in this file so a 200 m traverse means re-grabbing the mouse; the focus point silently
re-aims toward the bot's AI target (`:2297-2313`); ~20 flat globals for follow alone (`:662-704`);
four pointerdown listeners on one canvas; `dummyKeys` populated by an unguarded global keydown
(`:2671`) so typing `w` in a textarea walks the dummy; pan (`cameraFollowUserFocusOffset`) survives
mode switches but is silently zeroed by `frameCamera` (`:2450`) and by every framing preset.

## The new model

**Whole camera state is one struct, mostly scalars.** No vectors for orientation, no derived pose
that has to be read back.

```js
const cam = {
  anchorId: null,          // null = world-anchored; a bot id = actor-anchored
  drive: false,            // WASD moves the camera focus (only meaningful when unanchored)
  focus:  { x, y, z },     // world point the camera orbits / stands at
  pan:    { x, y, z },     // user offset applied on top of focus
  yaw, pitch,              // world-space orbit/look angles
  distance,                // 0 = eye at focus; > 0 = orbiting the focus
  fov,
};
```

Pose is always derived, never measured:
`position = focus + pan + spherical(yaw, pitch, distance)`, `lookAt = focus + pan`.

### Three independent axes, not four modes

| axis | values | replaces |
|---|---|---|
| `anchorId` | world \| bot | orbit/fly vs. follow/POV |
| `distance` | 0 (eye) … max (orbiting) | third vs. first person |
| `drive` | off \| on | who owns WASD |

Every current mode is a reachable combination, and one useful new one appears:

| | `distance > 0` | `distance ≈ 0` |
|---|---|---|
| **world, `drive` off** | orbit | free-look from a fixed point |
| **world, `drive` on** | drivable orbit *(new)* | fly |
| **bot** | follow | POV |

`drive` is an explicit toggle on `G` (today's fly key), **not** a function of zoom. That matters:
WASD ownership is currently an explicit mode gate (`driving = cameraMode !== CAMERA_FLY`, `:3714`),
and making it distance-derived would silently steal WASD from the dummy when you scroll in — a
hidden mode keyed on a continuous parameter, which is the exact fault this plan exists to remove.
With `drive` explicit, scrolling in while unanchored just puts your eye at the focus; the dummy
keeps WASD until you say otherwise.

Zoom-through **is** retained on the anchored row, where it costs nothing: WASD goes to the dummy in
both follow and POV, so sliding continuously from follow into a bot's eyes changes no ownership.
`CAMERA_ORBIT/FOLLOW/POV/FLY` survive only as UI shortcuts that set `(anchorId, distance, drive)`.

The one genuine discontinuity — in third person `yaw` is world-space, in first person it should
track the bot's aim — is a blend, not a branch:

```
eye      = smoothstep(EYE_EXIT, EYE_ENTER, distance)   // 1 at distance 0
worldYaw = lerp(cam.yaw, botYaw + userYawOffset, eye * povFollowWeight)
```

`povFollowWeight` (default ~0.9) replaces the timed auto-recenter: the bot's turn carries the view,
your drag offset **persists** instead of being pulled to zero on a 900 ms timer. Explicit recenter
stays on a key and a button; timed decay becomes an opt-in slider defaulting to off (D3).

**Eye-blend mesh fade (required, not optional).** `botPovEnabled` (`:2425`) is a UI label only —
nothing hides the followed bot's body today. POV works because the eye point is authored at the face
surface (`botPovAnimatedEyePoint`, `:2520`), so the hard cut never shows the interior. A *continuous*
0.35 m → 0 slide passes straight through the head with a 0.05 near plane. Phase 3 must fade the
anchored bot's own body out as `eyeBlend → 1` (skip its instance in the batch upload, the per-actor
loop at `:10190-10200` is already the right seam).

### One writer

`applyCameraIntent(cam, camera)` runs once per frame, after sim, before `visuals.update`. Nothing
else touches `camera.position`. `controls` ceases to exist, so `controls.target` — read by
`enterFlyCam` (`:2386`), `frameCamera` (`:2448`), and the shuffle restore path — is replaced by
`cam.focus`. (The audio listener at `:124` reads `camera.position`, which we still write, so it
needs no change.)

### Constraints made honest

- **Pitch** clamps to ±85° (`±1.48`) symmetric, replacing `minPolarAngle 0.08` / `maxPolarAngle
  π×0.485`. Low, ground-level angles become reachable.
- **Ground** is a soft push (`position.y ≥ groundHeight(x,z) + 0.25`) applied at pose time, not a
  hard angular limit — you can sit in a valley and look up. Note this makes the applied pose differ
  from the requested one near terrain; it is the one place the camera still overrides you, and it is
  bounded and visible.
- **Distance** is stored unclamped as *requested* and clamped only at apply time against the
  map-derived max. Shrinking a map then growing it restores your zoom instead of silently rewriting
  it (`cameraFollowMaxDistance()` destroys the stored value today, `:2372`).
- **Pointer lock** on drag-look. `environment-viewer.html` and `creature-viewer.html` both already
  implement this — copy the working pattern rather than writing a third.

### Wheel and modifiers

Wheel writes `distance`, log-scaled so it is smooth at both 0.5 m and 80 m. Move speed is **not** on
the wheel: `Ctrl+wheel` is how browsers deliver trackpad pinch-zoom, so binding it to speed would
hijack pinch on every laptop. Speed lives on the existing fly-speed slider plus `[` / `]`.

**Known loss:** OrbitControls provides all touch handling in this file (one-finger rotate, two-finger
dolly-pan); there is none elsewhere. Dropping it drops touch. Accepted — this is a desktop harness —
but it is a real regression, not an oversight, and pinch-to-zoom should be re-added to the new wheel
handler if a tablet ever matters.

## Phases

### Phase 1 — `bot-camera.js` (pure) + `test-bot-camera.mjs`

New module, THREE-free, plain `{x,y,z}` in and out — same purity convention as
`bot-camera-control.js` (documented in `bots.md`, upheld by the 2026-07-27 perf-sweep review).

```js
createCameraIntent(overrides)              → cam
rotateIntent(cam, dyaw, dpitch)            → mutates yaw/pitch, clamps pitch
zoomIntent(cam, notches)                   → log-scaled distance
panIntent(cam, dx, dy, basis)              → mutates pan
translateFocus(cam, move, dt, speed)       → drive-mode WASD
resolveCameraPose(cam, ctx, dt)            → { position, lookAt, fov, eyeBlend }
```

`ctx` supplies `{ anchorPoint, botYaw, botPitch, groundHeight, maxDistance }`. Everything the
renderer needs comes out of `resolveCameraPose`; nothing goes back in.

Node test covers: pose round-trip (set intent → derive pose → intent unchanged — the property the
current design cannot hold); pitch clamp symmetry; log zoom monotonicity; eye-blend continuity
across the threshold (no jump in position or yaw); ground push; unclamped distance surviving a
max-distance shrink/restore cycle.

### Phase 2 — input layer, OrbitControls out

One pointer handler on the canvas replacing four (`:180`, `:201`, `:805`, `:840`), plus the wheel
handler. LMB-drag = rotate (+ pointer lock), MMB/Shift-drag = pan, wheel = zoom, WASD/QE =
`translateFocus` when `drive` is on. Click-to-follow / Shift-click-POV / Alt-click-debug keep their
bindings but set axis values instead of calling `setCameraMode`.

Delete `controls`, the three `controls.addEventListener` intent-scrapers (`:772-795`),
`captureFollowUserFraming`, `cameraRig.inputActive/inputChanged/userInteracting/inputMomentumUntil`,
`cameraFollowInputStartDistance`, and the 0.002 epsilon.

Fold in the `dummyKeys` bug: guard the keydown at `:2671` on `document.activeElement` the way the
camera keybinds already are (`:7882`).

**Verify gate:** orbit, pan and zoom must feel at least as good as OrbitControls before Phase 3 —
damping is ours now (`dampAlpha`), and this is where feel can regress. Pointer-lock clicks also
change `event.clientX/Y` semantics, so click-to-follow must run on unlocked pointers or accumulate
`movementX/Y`.

### Phase 3 — anchoring, WASD ownership, mesh fade

`anchorId` resolution replaces `getCameraFollowActor` (`:2281`). The anchor point keeps its
capsule-relative position but **drops the silent lerp toward the bot's AI target** (`:2305-2311`) —
that becomes an explicit lead slider defaulting to 0, because a camera that re-aims itself when the
AI acquires is the "overriding" complaint in its purest form. Death hold and auto-follow survive
(they are wanted), but auto-follow now only changes `anchorId` — it can no longer reset framing,
because framing no longer lives in the pose.

Add the `drive` toggle and the eye-blend mesh fade described above.

Retire `setCameraMode`, `resetFollowFraming`, `enterFlyCam`, `resetPovLook`, `botPovEnabled`,
`cameraMode`, and the `CAMERA_*` constants (kept only as UI shortcut labels).

### Phase 4 — occlusion + comfort ported

`bot-camera-control.js` is the best code in the current system — keep `chooseOcclusionCandidate`,
`stepOcclusionMemory`, `dampAlpha`, `dampAngle` and their tests unchanged. Rework only the caller:
candidates become `(yaw, pitch)` offsets instead of direction vectors (`:2318`,
`CAMERA_OCCLUSION_CANDIDATES` at `:675`), a closer fit now that intent is angular. The occlusion
result writes a *transient* resolved pose, never `cam` — so it can no longer be mistaken for user
input, which is what the 450 ms momentum window was defending against. Occlusion stays default-off
pending the tuning pass `bots.md` already flags.

POV comfort presets (`:646-650`) keep `headBlend` / `positionRateXZ` / `positionRateY` / `deadZone`
/ `maxLag` — those smooth the *bot's* head animation and fight nobody. `stepPovRecenter` is retained
but rewired to the opt-in decay slider (D3); `rotationRate` folds into the eye-blend lerp.

Framing presets (`:640-645`) become four literal intent writes (`distance`, `pitch`, `pan.y`,
`fov`), replacing `applyCameraFramingPreset`'s branching (`:2462-2484`).

### Phase 5 — panel, keybinds, slots

The mode row becomes four shortcut buttons over the three axes, plus a `drive` toggle. Add:
`povFollowWeight`, target-lead, and recenter-decay sliders. Keybinds F/O/V/G/Esc/`]` keep their
meanings (`G` now toggles `drive`).

Slot state (`:9992-10010`) collapses from 17 keys to the intent struct plus the toggles.
`applyUiState`'s ordering hazard comment (`:10072-10074`) is deleted along with the hazard. Legacy
slots migrate: read the old keys, convert `followDirection` to yaw/pitch, drop the rest.

### Phase 6 — cleanup, docs, log

Delete the ~20 follow globals (`:662-704`), `cameraRig`, both `_fly*` scratch sets, and the unused
comfort fields. Replace the three stale `bots.md` sections (§3112-3156) with one §"Camera intent
model". Append to `agent_log.csv`.

## Size

Camera code today spans `:621-871`, `:2269-2650`, panel `:7788-7914`, slots `:9992-10089`. The
replacement should be meaningfully smaller — the intent-recovery apparatus and the per-mode input
duplication are most of what goes — but the exact figure is not worth predicting before Phase 2
lands. Measure it at Phase 6 rather than committing to a number now.

## Risks / things that must not break

1. **`visuals.update(dt)`** runs after the camera and follows it (sky dome). Ordering must stay
   `sim → applyCameraIntent → visuals.update` (`:10202-10205`).
2. **Billboards** (`healthBar`, state orbs, role insignia) copy `camera.quaternion` and must keep
   running after the camera write, as they do today.
3. **`pickBotAtEvent`** (`:183`) raycasts with last-frame matrices — fine, but see the Phase 2
   pointer-lock note about `clientX/Y`.
4. **`applyLayout`** (`:4626-4634`) resets the camera and re-clamps `maxDistance` per map. Becomes a
   single intent write; the clamp moves to apply time.
5. **`shuffleScene`** (`:4648-4662`) captures/restores framing around a rebuild. Becomes a struct
   copy — the path most likely to hide behavior worth diffing before deleting.
6. **Touch support** is lost with OrbitControls (see §Wheel and modifiers).
7. **`postFX`** holds the camera reference; confirm nothing re-creates the camera object.

## Revision notes (what the first draft got wrong)

1. **"Four representations, nothing converts between them"** was wrong. `resetFollowFraming` marshals
   the live pose into follow's representation on every non-orbit mode entry, so mode switches do
   preserve angle and zoom. The real defect is narrower: intent exists only as a derived quantity.
2. **Distance-derived WASD ownership** would have reintroduced a hidden mode keyed on a continuous
   parameter. `drive` is now an explicit third axis. This costs the "two axes" tidiness of the first
   draft and is worth it.
3. **The eye-blend transition band** through the bot's own mesh was unaddressed; the fade is now a
   Phase 3 requirement.
4. `Ctrl+wheel` for speed would have hijacked trackpad pinch-zoom; speed moved off the wheel.
5. Touch-support loss was unmentioned; now recorded as an accepted regression.
6. The audio listener was listed as the top risk; it reads `camera.position`, which still gets
   written, so it is a non-issue.
7. A "~850 → ~520 lines" estimate was invented precision; replaced with "measure at Phase 6".
