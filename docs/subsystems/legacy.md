# Legacy app: creature-viewer.html

> 🗺️ [View this subsystem in the interactive code map](../../code-map.html#legacy)

## Purpose

`creature-viewer.html` is a standalone, classic-WebGL Three.js demo living in
`workshop-webgpu/` alongside the active WebGPU app. It renders a small herd of
procedurally-balanced quadruped creatures (simple FABRIK-leg IK, terrain-contact
physics, wander/separation steering) wandering an undulating, lake-carved terrain
with trees/grass/water/clouds loaded from the same shared optional modules used
elsewhere in the workspace, plus a pointer-locked FPS walk mode (see
`controller.md`). It appears to be an earlier/parallel experiment for prototyping
the creature-balancing rig and FPS controller in isolation, separate from the
much larger creature system (`BODY_PLANS`/`GAITS`/arms/combat) described in the
root-level `CLAUDE.md` for the original `creature-viewer.html` (a different,
~4400-line file one directory up, not this one). **It is not wired into the
active WebGPU app (`environment-viewer.html`) in any way** — confirmed by
grep: no file in `environment-viewer.html`'s import graph references
`creature.js` or `creature-viewer.html`.

## Files

| File | Responsibility | Lines |
|---|---|---|
| `creature-viewer.html` | Self-contained classic-WebGL Three.js app: renderer/scene/camera setup, procedural lake terrain, orbit camera, FPS walk-mode controller, dynamic loading of `trees.js`, `grass.js`, `water.js`, `clouds.js`, and `lights.js`; spawns 7 `Creature` instances from `creature.js` and drives their fixed-timestep update loop. | 782 |
| `creature.js` | Single-file creature module: FABRIK-free analytic 2-bone IK (`solveKnee`), terrain-contact body physics (PD height control, support-polygon balance, per-leg step state machine), steering (wander + separation), and rendering of one hardcoded quadruped body plan. Imported only by `creature-viewer.html`. | 347 |
| `controller.md` | Reference doc for the FPS walk controller embedded in `creature-viewer.html` (Octree/Capsule collision, sub-stepping, tunable `fp` params). | 173 |

## Public API

`creature.js` exports, verified from its `export` statements:
- `export const BODY_HEIGHT = 1.0` (line 4) — preferred body-centre height above feet.
- `export const FOOT_GROUND = 0.06` (line 8) — foot sphere vertical offset above terrain.
- `export const FIXED = 1 / 60` (line 9) — fixed physics timestep.
- `export class Creature` (line 120) — constructor takes `{ scene, terrainHeight, spawn, yaw, hue, arenaRadius }`; instance methods `setArenaRadius()`, `computeSteering(all)`, `physicsStep(h)`, `render()`.

`creature-viewer.html` structure:
- Importmap pulls `three` and `three/addons/` from `cdn.jsdelivr.net` (three@0.160.0) — a different CDN/pin than the root `creature-viewer.html`'s importmap described in the top-level `CLAUDE.md` (cdnjs).
- Imports `Octree`/`Capsule` from `three/addons/math/` for FPS collision, `createLightingRig` from `./lights.js`, and `{ BODY_HEIGHT, Creature, FIXED }` from `./creature.js`.
- Two camera modes sharing one `THREE.PerspectiveCamera`: **Orbit** (default, drag/scroll) and **FPS walk** (pointer-locked, toggled with `F`/`Esc`) — see `controller.md`.
- Dynamically `import()`s `trees.js`, `tree-textures.js`, `grass.js`, `water.js`, `clouds.js` (all optional, each wrapped in `.catch()` so a missing module degrades gracefully) and builds its own on-page debug/control panels for forest, lighting, terrain, grass, water, and clouds parameters.
- Fixed-timestep accumulator loop (`animate()`) drives creature physics at `FIXED` (1/60s, capped at 5 steps/frame) and FPS-controller sub-stepping at 5 steps/frame.

## Architecture notes

The FPS controller (full detail in `controller.md`) builds a `THREE.Octree` from
the ground mesh only (trees/creatures excluded) and resolves a `Capsule` player
collider against it each sub-step (5 sub-steps/frame, capped `dt`). Movement is
direct-velocity-set on the ground (instant turn, exponential friction decay) and
additive in the air (so jumps retain momentum); stance (`stand`/`crouch`/`prone`)
lerps the capsule height and pins the capsule end above its start each frame. All
movement/physics constants live in one tunable `fp` object exposed via a live
debug panel.

The `Creature` class here is architecturally simpler than, and does not share
code with, `port-creature-system.js` (the creature system used by the active
`environment-viewer.html`, 4830 lines). `port-creature-system.js` uses the
`pair()` / `finalizePlan()` / `BODY_PLANS` vocabulary that matches the
*original* root-level `creature-viewer.html` described in the top-level
`CLAUDE.md` — i.e. it reads as a port of that larger, multi-body-plan/gait/arm
creature system into the WebGPU pipeline. By contrast, `creature.js` in this
directory hardcodes a single fixed quadruped body plan (no `BODY_PLANS`,
`GAITS`, arms, or combat) with its own simpler analytic-IK and support-polygon
balance code. It is plausibly an independent, earlier or parallel prototype of
the "balancing creature" rig concept rather than a direct ancestor of
`port-creature-system.js`.

## Relationship to the active app

Dead/inactive relative to `environment-viewer.html`: nothing in the active
WebGPU app's module graph imports `creature.js` or loads `creature-viewer.html`.
It is useful only as reference/history for the creature-balancing physics and
the FPS controller design.

## Tests

No dedicated tests exist for this app (`creature-viewer.html`, `creature.js`,
or the FPS controller).
