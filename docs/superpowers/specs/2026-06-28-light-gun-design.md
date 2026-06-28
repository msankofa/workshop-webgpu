# Light Gun — Design Spec
_2026-06-28_

## Overview

A first-person light-placement tool integrated into the existing FPS walk mode. The player can drop or shoot point lights into the scene; each light has a lifespan and expires with a fade. Lights are injected directly into the clustered GPU lighting pipeline (SP4a) via reserved buffer slots — no extra render passes, same shading model as ambient lights.

---

## GPU Integration (`clustered-lights.js`)

### New constructor option
```
reserve: N  (default 0)
```
Shrinks the range `writeLights` writes to `0..(count - N - 1)`. Slots `(count-N)..(count-1)` are owned by the caller and never touched by the random-light writer.

### New methods
| Method | Behaviour |
|---|---|
| `setLightDirect(i, { x, y, z, radius, r, g, b, intensity })` | Writes 8 floats into `arr[i*8..]`, sets `lightAttr.needsUpdate = true`, marks internal `dirty` flag |
| `clearLight(i)` | Zeros slot `i` (position, radius, colour, intensity all 0), marks dirty |

### Slot layout (count = 256, reserve = 33)
| Range | Owner |
|---|---|
| 0–222 | Random ambient lights (223 active random lights) |
| 223 | Projectile slot — live while a shot is in flight |
| 224–255 | Placed-light pool (32 slots) |

---

## Player Light Data Model

### Free-list
```js
const slotFree = new Array(32).fill(true);  // indices map to GPU slots 224-255
function findFreeSlot() { return slotFree.indexOf(true); }  // -1 = full
```

### PlacedLight object
```js
{
  slot,         // GPU index (224–255)
  x, y, z,     // world position
  vy,           // vertical velocity — used while falling (float=OFF, not grounded)
  grounded,     // bool — stops falling physics once terrain contact is made
  lifespan,     // seconds remaining
  totalLife,    // original lifespan (used to compute fade ratio)
  r, g, b,      // colour, each 0–1
  brightness,   // base intensity value (written to GPU as intensity * fadeScale)
  radius,       // influence radius in world units
  float,        // bool — if true, light suspends at placement height
  drift,        // bool — only meaningful when float=true
  driftPhase,   // random float 0–2π, used for drift animation
}
```

---

## Modes

### Place mode
- LMB click fires a ray-march from `camera.position` along `camera.getWorldDirection()`.
- 256 steps over 200 world units; first step where `sampleY <= terrainHeight(x, z)` is the hit.
- Light is placed at the hit point. If no hit (sky/missed), placement is ignored.
- If `float=ON`: light `y` is the exact hit `y` (hovers there).
- If `float=OFF`: light starts at hit `y`, `vy = 0`; gravity is applied each frame until grounded.

### Shoot mode
- **LMB down**: record `chargeStart = performance.now()`. Charge ring becomes visible on crosshair.
- **Each frame while charging**: `chargeRatio = clamp((now - chargeStart) / maxChargeMs, 0, 1)`. Ring radius and colour (white → orange) scale with `chargeRatio`.
- **LMB up**: compute `speed = minSpeed + chargeRatio * (maxSpeed - minSpeed)`. Fire projectile.

#### In-flight projectile
A single `inFlight` object (or `null`):
```js
{ x, y, z, vx, vy, vz, arc, ...lightProps }
```
Each frame while `inFlight != null`:
- **Arc**: `vy -= gravity * dt`
- **Straight**: no gravity modification
- Integrate: `x += vx*dt`, `y += vy*dt`, `z += vz*dt`
- Write light to projectile slot 223 via `setLightDirect`
- If `y <= terrainHeight(x, z)`: terrain contact → promote to placed light at `y = terrainHeight(x, z)` (find free slot, `clearLight(223)`, `inFlight = null`). `float` determines whether the placed light stays at that height or begins falling — same rules as place mode.
- If out of bounds / exceeded max range: `clearLight(223)`, `inFlight = null` (missed)

---

## Per-Frame Update (placed lights)

Runs every frame for each entry in `placedLights[]`:

1. **Falling** — if `float=OFF` and `!grounded`: apply `vy -= gravity * dt`; integrate `y += vy * dt`; if `y <= terrainHeight(x, z)` then `y = terrainHeight(x, z)`, `vy = 0`, `grounded = true`.
2. **Drift** — if `float=ON` and `drift=ON`: `xOff = sin(t * 0.3 + driftPhase) * 3`, `zOff = cos(t * 0.27 + driftPhase) * 3` (same constants as ambient lights for visual consistency).
3. **Age** — `lifespan -= dt`.
4. **Fade** — `fadeScale = lifespan < 2 ? lifespan / 2 : 1`.
5. **Expire** — if `lifespan <= 0`: `clearLight(slot)`, `slotFree[slot - 224] = true`, remove from array.
6. **Write** — `setLightDirect(slot, { x: x + xOff, y, z: z + zOff, radius, r, g, b, intensity: brightness * fadeScale })`.

---

## UI — "Light gun" section in Walk controls panel

Added as a collapsible `fpHeader('Light gun')` section. Starts collapsed (consistent with other sections).

| Control | Type | Range / Options |
|---|---|---|
| Mode | select | Place / Shoot |
| Trajectory | select | Arc / Straight — hidden when Mode = Place |
| Float | checkbox | — |
| Drift | checkbox | disabled when Float is off |
| Lifespan | slider | 1–60 s |
| R | slider | 0–255 |
| G | slider | 0–255 |
| B | slider | 0–255 |
| Brightness | slider | 1–200 |
| Radius | slider | 10–80 |

Trajectory row visibility toggles dynamically when Mode changes.  
Drift checkbox `disabled` attribute tracks Float checkbox state.

---

## Charge Visual Cue

A thin SVG ring (`<circle>`) appended alongside the existing crosshair `<svg>`, initially `display:none`. On charge start it becomes visible; each frame its `r` attribute scales from `12` to `28` px and its `stroke` interpolates `rgba(255,255,255,0.6)` → `rgba(255,140,0,0.9)` as `chargeRatio` goes 0 → 1. On mouseup it hides and resets.

---

## Input Handling

```js
window.addEventListener('mousedown', e => {
  if (!fpsMode || e.button !== 0) return;
  if (lgParams.mode === 'place') placeLightAtCrosshair();
  else chargeStart = performance.now();
});
window.addEventListener('mouseup', e => {
  if (!fpsMode || e.button !== 0 || lgParams.mode !== 'shoot') return;
  const chargeRatio = Math.min((performance.now() - chargeStart) / maxChargeMs, 1);
  fireLight(chargeRatio);
  chargeStart = null;
});
```

`chargeStart = null` when not charging — guards the ring update and mouseup handler.

---

## Constants (tunable)

| Name | Value | Notes |
|---|---|---|
| `MAX_PLACED` | 32 | Reserved placed-light slots |
| `PROJECTILE_SLOT` | 223 | Dedicated in-flight slot |
| `RANDOM_COUNT` | 223 | Random ambient lights (was 256) |
| `MIN_SPEED` | 8 | m/s at zero charge |
| `MAX_SPEED` | 60 | m/s at full charge |
| `MAX_CHARGE_MS` | 1500 | ms to reach full charge |
| `FALL_GRAVITY` | 14 | Separate from player gravity — lighter feel |
| `DRIFT_AMP` | 3 | World units of drift radius |
| `FADE_WINDOW` | 2 | Seconds before expiry when fade begins |
| `RAY_STEPS` | 256 | Steps in terrain ray-march |
| `RAY_MAX_DIST` | 200 | World units |

---

## Out of Scope

- Picking / editing an already-placed light after placement
- Saving placed lights to the JSON export format
- More than 32 simultaneously active player lights
