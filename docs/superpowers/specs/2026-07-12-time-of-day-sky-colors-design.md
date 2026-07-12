# Time-of-day sky colors — design

Date: 2026-07-12
Subsystem: sky (`sky.js`, `sky-field.js`, `environment-viewer.html`)

## Goal

Let the dome sky color be authored and driven as a function of time of day. The user
wants live sliders to define the colors used in the sky and how they relate: day,
dawn/dusk, and night color sets that cross-fade as the sun moves, plus control over
where on the dome the color bands sit (the transition position). On Earth the sky is a
gradient from blue at the zenith to black, with reddish tones concentrated near the
horizon in the sun's direction at dawn/dusk — this system should be able to express
that.

## Non-goals

- No physically-based atmospheric scattering. This stays a palette-driven gradient.
- No changes to star / Milky Way / celestial-body *internals* — a separate agent owns
  night-sky features. This work only owns the dome gradient, `scene.background`, and a
  single shared `nightness` scalar plus one opt-in opacity hook (see §4).
- No new day/night *simulation clock*. Time of day is derived from the existing sun
  elevation (the lighting rig), not a separate wall-clock.

## Overview

Three named sky states — `day`, `dusk`, `night` — each a full set of dome parameters.
The sun's elevation selects and blends between adjacent states every frame. The dome
material reads its parameters from GPU uniforms so the blend (and every slider) updates
in place with no material rebuild. A `nightness` scalar derived from the same elevation
optionally drives celestial-body opacity.

## 1. Data model (`sky-field.js`, pure / Node-tested)

Each state carries:

- Colors: `top`, `horizon`, `bottom`, `glow` (hex strings).
- Transition params (floats):
  - `horizonHeight` — vertical offset of the horizon band on the dome (shifts where
    the color crossover sits; `y' = y - horizonHeight`).
  - `zenithSoftness` — upper bound of the horizon→zenith smoothstep (current constant
    `0.55`); larger = the sky color reaches higher before going dark.
  - `glowWidth` — half-width (in dome-Y units) of the horizon glow band. Current
    hardcoded falloff `1 - |y|*9` corresponds to `glowWidth ≈ 0.11`.
  - `glowStrength` — glow mix amount (current constant `0.4`).

Defaults reproduce today's look for `night` (the current `DEFAULT_PALETTE` colors) and
add sensible `day` (blue zenith → pale horizon) and `dusk` (reddish horizon) states.

New pure functions:

- `domeParamsAtElevation(sunElevationDeg, thresholds)` → interpolated parameter set.
  Two-segment lerp keyed on elevation anchors: at/above `dayAbove` → `day`; at
  `duskPeak` (≈ 0°, sun on horizon) → `dusk`; at/below `nightBelow` → `night`. Between
  `duskPeak` and `dayAbove`, lerp `dusk`→`day`; between `nightBelow` and `duskPeak`,
  lerp `night`→`dusk`. Colors lerp in RGB — because we only ever blend adjacent,
  explicitly-defined states (day↔dusk, dusk↔night), there is no muddy direct blue→red
  midpoint.
- `nightnessAtElevation(sunElevationDeg, thresholds)` → `1 - smoothstep(nightBelow,
  dayAbove, e)`. Monotonic in elevation: 0 in full day, 1 in full night, ramps through
  dusk. Used for celestial opacity.

`thresholds = { dayAbove, duskPeak, nightBelow }`, all authored via sliders (§5).

`makePalette`/`DEFAULT_PALETTE` remain for backward compatibility; the state keyframes
are a new export (`DEFAULT_SKY_STATES`, `makeSkyStates(overrides)`).

## 2. Rendering — uniform-driven dome (`sky.js`)

Today `makeSkyDomeMaterial` bakes `top/horizon/bottom/glow` and the transition
constants directly into the TSL `colorNode` `Fn`, so changing any of them requires
`setPalette` → `rebuild(radius)`, which disposes and rebuilds the dome mesh. That is
unsafe to do per-frame (it races the async WebGPU submit — the documented "night
freeze" class of bug) and impossible to drive smoothly from a slider.

Change: build the dome material once with **uniforms**:

- 4 color uniforms (`uTop`, `uHorizon`, `uBottom`, `uGlow`).
- 4 float uniforms (`uHorizonHeight`, `uZenithSoftness`, `uGlowWidth`, `uGlowStrength`).
- 1 vec3 uniform `uSunDir` + 1 float `uGlowDirectionality` for directional glow (§3).

The `colorNode` reads these uniforms instead of constants. New method:

- `updateDome(sunElevationDeg)` — computes `domeParamsAtElevation(...)`, writes the 8
  parameter uniforms, updates `scene.background` (JS `Color` lerp of `bottom`), and
  caches `nightness`. Pure uniform writes; no rebuild, no dispose.

`setSunDir(v)` additionally writes `uSunDir`. Per-state authoring (slider edits to a
state's colors/params) mutates the state keyframes and takes effect on the next
`updateDome` — still no rebuild. `setPalette` is retained but no longer the live path.

Every-frame wiring in `environment-viewer.html` (near the existing `setSunDir` call,
~line 6987): `skyRef.updateDome(rig.elevation)`.

## 3. Directional horizon glow

The glow band is biased toward the sun's azimuth so dawn/dusk reads as real rather than
a uniform pink ring. In the `colorNode`, compute horizontal alignment between the
fragment's dome direction and `uSunDir` (`dot(normalize(pos.xz), normalize(uSunDir.xz))`
mapped to `[0,1]`), and multiply the glow band by
`mix(1.0, align, uGlowDirectionality)`. `uGlowDirectionality = 0` → even full ring;
`1` → fully concentrated toward the sun. Default low.

## 4. Nightness → celestial opacity (opt-in toggle)

`sky.js` owns and exposes the `nightness` scalar (getter, updated in `updateDome`) as
the single source of truth for "how dark is it." A UI toggle **"Celestial opacity
follows time of day"**: when on, the celestial-body / star group opacity is multiplied
by `nightness` (stars fade in through dusk, gone in daylight); when off, they render at
constant opacity (today's behavior).

**Coordination:** the parallel night-sky work should consume this same `nightness`
scalar rather than computing its own darkness measure. This design deliberately keeps
its footprint to the dome, `scene.background`, `nightness`, and this one opacity hook;
star/body generation and appearance stay with the other agent. Sync on the interface
(`skyRef.nightness`) before implementing the toggle.

## 5. UI (`environment-viewer.html`, inline `slider()`/`select()` helpers)

All controls live-update via `updateDome` — none trigger a rebuild.

- **Per state** (`day` / `dusk` / `night`), each in a collapsible header block:
  - 4 color inputs: top, horizon, bottom, glow.
  - 4 sliders: horizonHeight, zenithSoftness, glowWidth, glowStrength.
- **Sun → time-of-day mapping:** sliders for `dayAbove`, `duskPeak`, `nightBelow`
  (degrees of sun elevation).
- **Glow directionality:** slider `0..1`.
- **Toggle:** celestial opacity follows time of day.

Color inputs are `<input type="color">` (commit-on-change), consistent with how the
existing seed field is handled; the numeric ones are `slider()`s since they now write
uniforms rather than rebuild.

## 6. File-by-file changes

- `sky-field.js` — add `DEFAULT_SKY_STATES`, `makeSkyStates`, `domeParamsAtElevation`,
  `nightnessAtElevation`, RGB color-lerp helper. No three.js import (stays pure).
- `sky.js` — uniform-driven `makeSkyDomeMaterial`; `updateDome`, `nightness` getter,
  `uSunDir` write in `setSunDir`; directional glow in `colorNode`.
- `environment-viewer.html` — per-frame `updateDome(rig.elevation)`; new sliders /
  color inputs / toggle; wire the celestial-opacity toggle to the sky/celestial group.
- `docs/subsystems/sky.md` — document the state/blend model, uniform dome, `nightness`,
  and the new tunables (and correct the current "day/night palette system" note, which
  today describes a single static palette).
- `test-sky-field.mjs` — new cases (below).
- `agent_log.csv` — append entry.

## 7. Testing

`test-sky-field.mjs` (plain Node, no framework) adds:

- `domeParamsAtElevation`: returns exactly the `day` params at `dayAbove`, exactly
  `dusk` at `duskPeak`, exactly `night` at/below `nightBelow`; interpolates between; is
  deterministic; clamps outside the range.
- `nightnessAtElevation`: `0` at/above `dayAbove`, `1` at/below `nightBelow`, monotonic
  non-increasing in elevation across the band.
- color-lerp helper: endpoints exact, midpoint componentwise between.

The dome shader, directional glow, and the opacity toggle are verified live in
`environment-viewer.html` (no GPU-side automated coverage, consistent with the rest of
the sky rendering layer).

## Open questions

None outstanding. (Directional glow: included, defaulted low.)
