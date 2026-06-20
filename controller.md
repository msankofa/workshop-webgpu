# FPS Controller — creature-viewer.html

## Overview

The FPS walk mode is implemented inline in `creature-viewer.html`, in the section marked
`// ===================== FPS walk mode`. It uses Three.js's `Octree` and `Capsule` from
`three/addons/math/`, matching the approach of [ThreeJS_FPS_2.0](https://github.com/Footprintarts/ThreeJS_FPS_2.0).

The scene has two camera modes that share a single `THREE.PerspectiveCamera`:
- **Orbit** (default) — drag to rotate, scroll to zoom
- **FPS walk** — pointer-locked, WASD movement, terrain collision via Octree

---

## Entering / Exiting FPS Mode

| Input | Action |
|-------|--------|
| `F` | Toggle FPS mode |
| `Esc` | Exit FPS mode |

`enterFPS()` / `exitFPS()` are called from the `pointerlockchange` event.

---

## Controls (FPS mode only)

| Input | Action |
|-------|--------|
| `W A S D` | Move |
| `Mouse` | Look (yaw + pitch via `camera.rotation`, order `YXZ`) |
| `Space` | Jump (standing only) |
| `C` | Toggle crouch |
| `Z` | Toggle prone |

---

## Key Variables

```js
let fpsMode         // bool — which camera mode is active
const fpsKeys       // { [code]: bool } — live key state
let playerOnFloor   // bool — set each frame by Octree capsule intersect
let stance          // 'stand' | 'crouch' | 'prone'
let capsuleH        // current (lerped) capsule height, drives camera Y
```

---

## Physics Architecture

### Collider

```js
const playerCollider = new Capsule(start, end, radius)
// start  = feet sphere centre  (≈0.35 above terrain)
// end    = head sphere centre  (= start.y + capsuleH)
// radius = 0.35
// camera.position is always set to playerCollider.end each frame
```

### Octree

```js
let worldOctree = new Octree()
function buildOctree()   // called after rebuildGround() and after rebuildWorld()
```

`buildOctree()` creates a fresh `Octree` and calls `worldOctree.fromGraphNode(ground)`.
It is called once at startup and again whenever the terrain sliders change the world.
The Octree only covers the ground mesh — trees and creatures are not included.

### Sub-stepping

The FPS physics runs **5 sub-steps per frame** (`STEPS_PER_FRAME = 5`).
Each sub-step calls `applyFPSControls(fpsDt)` then `updateFPSPlayer(fpsDt)`, where
`fpsDt = min(rawDt, 0.05) / 5`.

### Ground movement (`applyFPSControls`)

When `playerOnFloor`:
- Forward and side vectors are derived from `camera.matrixWorld` column 0.
- If any WASD key is held, `playerVelocity.x/z` are **directly set** to
  `(normalised direction) * fp.speedStand/Crouch/Prone`. No acceleration build-up.
- If no keys are held, friction is applied:
  `velocity *= exp(-fp.friction * dt)` — higher friction = stops faster.
- Jump sets `playerVelocity.y = fp.jumpForce` (standing only).

When airborne:
- Movement is **additive** (`velocity += direction * fp.airStrafe * dt`) so jumps carry momentum.

### Physics step (`updateFPSPlayer`)

When airborne:
- `playerVelocity.y -= fp.gravity * dt`
- Weak air damping: `velocity *= (exp(-fp.airDamp * dt) - 1) * 0.1`

Every frame:
- Translate capsule by `velocity * dt`.
- `worldOctree.capsuleIntersect(playerCollider)` resolves penetration.
- `playerOnFloor = result.normal.y > 0`.
- Capsule end is pinned to `start.y + capsuleH` (lerped stance height).
- Camera position copied from `playerCollider.end`.

---

## Tunable Parameters (`fp` object)

All parameters live in the `fp` const object and are exposed live via the debug panel
(top-left corner). Changes take effect immediately — no reload needed.

| Key | Default | Debug label | What it controls |
|-----|---------|-------------|-----------------|
| `speedStand` | 25 | Walk speed | Horizontal speed while standing |
| `speedCrouch` | 10 | Crouch speed | Horizontal speed while crouched |
| `speedProne` | 4 | Prone speed | Horizontal speed while prone |
| `jumpForce` | 15 | Jump force | Initial upward velocity on jump |
| `airStrafe` | 8 | Air strafe | Additive acceleration while airborne |
| `gravity` | 30 | Gravity | Downward acceleration when off floor |
| `friction` | 15 | Friction | Ground deceleration exponent (exp decay rate) |
| `airDamp` | 4 | Air damping | Air resistance exponent (applied at 10% strength) |
| `heightStand` | 1.25 | Stand height | Capsule end–start distance while standing |
| `heightCrouch` | 0.55 | Crouch height | Capsule end–start distance while crouched |
| `heightProne` | 0.08 | Prone height | Capsule end–start distance while prone |
| `sensitivity` | 500 | Sensitivity | Mouse look divisor — higher = slower turn |

### Friction formula

```
velocity *= exp(-fp.friction * deltaTime)
```

Applied per sub-step when on the floor and no movement keys held. Higher = stops faster.

### Sensitivity formula

```
camera.rotation.y -= event.movementX / fp.sensitivity
camera.rotation.x -= event.movementY / fp.sensitivity
```

Divisor — higher = slower.

---

## Spawn Position

Player spawns at world coordinates `(8, 0, 0)` in XZ, with Y set to
`terrainHeight(8, 0) + 0.35`. Stance resets to `stand` on every entry.
Camera facing resets to `rotation.y = Math.PI` (facing –Z).

---

## Importmap Requirements

The Octree and Capsule are loaded via the importmap at the top of the HTML:

```json
{
  "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
  }
}
```

```js
import { Octree  } from 'three/addons/math/Octree.js';
import { Capsule } from 'three/addons/math/Capsule.js';
```

`worldOctree` is declared at module top-level (before `rebuildGround()`) to avoid the
temporal dead zone error that would occur if it were declared inside the FPS block.
