# Base Game player-body and terrain parallel implementation plan

STATUS: Track A1-A5 implemented 2026-08-21 (`base-game-body-support.js`,
`base-game-player-bodies.js`, `test-base-game-player-body.mjs`, wired in `base-game.html`); A6 is
a browser review. The deployed two-tab multiplayer gate passed the same day; the 16-player budget is
unmeasured. Track B has not started; terrain must not enter the authoritative runtime world until
its own gate passes.

## Objective

Add a visible local and remote player body and begin the common terrain source without creating a
second movement, collision, coordinate, networking, or terrain-support system.

The capsule remains the only authoritative player collision body. The procedural body is a
presentation consumer. Terrain and 3D structures continue to enter the game through the existing
`worldQuery` service, so outdoor ground, bridges, stacked floors, buildings, and caves have one
definition of traversability.

## Reuse decisions

| Concern | Existing source of truth | What Base Game reuses |
|---|---|---|
| Movement and collision | `base-game-player-controller.js` | Fixed-step capsule, steps, slopes, ceilings, support identity |
| Global/render coordinates | `world-coordinates.js` | Global authority and render-local presentation |
| 3D support and collision | `world-query.js` | `groundProbe`, `resolveCapsule`, raycasts and provider identity |
| Visual humanoid | `player-procedural-body.js` | Rig, gait, IK, visibility modes and update-state shape |
| Body quality and scale | `bot-viewer-v3.html` | Natural locomotion, speed gait, shared batches, rig LOD patterns |
| Local-player presentation | `environment-viewer-v2.html` | Off, lower-body and third-person mode wiring |
| Multiplayer transforms | Base Game protocol/prediction/remotes | Existing authoritative global player state; no body packets |
| Terrain sources and LOD | Existing Base Game terrain plan and named viewers | Capability source, finite-map adapter, infinite recipe and clipmap references |

Pokémon Park remains comparison evidence only. Its height-only player grounding, XZ flora push-out,
finite edge clamp, and legacy camera are not imported.

## Non-negotiable boundaries

1. The visual body never moves the capsule and never participates in authoritative collision.
2. Local predicted and server-authoritative remote transforms remain global 3D coordinates.
3. Rendering converts those transforms through each client's existing render origin.
4. Player bodies add no multiplayer protocol messages. They consume state already replicated.
5. Terrain providers register behind `worldQuery`; the controller and body do not import a terrain
   generator or call a universal `heightAt(x,z)` for general movement.
6. The diagnostic capsule remains available as an independent toggle until body parity is accepted.
7. Body, terrain, local/remote visibility, and diagnostics are registered settings and therefore
   participate in the existing state save/load and performance-capture systems.

## The one necessary body compatibility change

`player-procedural-body.js` currently obtains every foot and body support height from
`terrainHeight(x,z)`. That works for a single outdoor heightfield but cannot distinguish a bridge
from the ground below it or two floors with the same X/Z.

Do not invent another world-support API. Extend the procedural body with an optional adapter to the
existing `worldQuery.groundProbe()` contract:

- Existing Bot Viewer, Environment Viewer, body preview, and Pokémon Park callers retain their
  current `terrainHeight` callback and behavior.
- Base Game supplies a probe adapter that converts a render-local foot/body probe origin to global
  coordinates, calls `worldQuery.groundProbe()`, and converts the returned point and normal back to
  presentation space.
- Each probe starts from the body's or foot's current Y and uses a bounded distance. It must never
  search an entire vertical column and select a different floor merely because it shares X/Z.
- The existing world-query hit remains the result shape and carries surface/provider identity. No
  duplicate terrain hit type is introduced.
- A render-origin change resets or translates render-only foot history; it never changes global
  body identity or authoritative player state.
- If no suitable support is found, the body uses its existing airborne behavior. It does not create
  an invisible fallback floor.

This extension must remain renderer-independent at the query boundary and keep the pure gait tests
usable under Node.

## Parallel work tracks

### Track A — player-body presentation

This track can begin immediately against the permanent Traversal Lab.

#### A1. Lock the adapter contract with tests

- Add a focused body-presentation test rather than embedding new logic directly in
  `base-game.html`.
- Prove that two support probes at identical X/Z but different starting Y select the correct stacked
  floors.
- Prove bridge, tunnel floor, raised platform, slope, step and airborne no-hit behavior.
- Prove a render-origin change preserves the player's global position and does not leave feet at
  the old local origin.
- Prove body updates cannot mutate controller state.

#### A2. Make procedural-body support Y-aware

- Add the optional existing-world-query adapter path to `player-procedural-body.js`.
- Route foot planting and terrain-normal orientation through that path when supplied.
- Retain the existing `terrainHeight` path unchanged for all established viewers.
- Extend `test-player-body-gait.mjs` and `test-player-body-ik.mjs`; do not replace their current
  heightfield coverage.

#### A3. Add a small Base Game presentation owner

Create one module whose responsibilities are limited to:

- constructing/destroying procedural bodies;
- converting authoritative or predicted global state to render-local body state;
- supplying the `worldQuery.groundProbe()` adapter;
- applying local visibility mode and diagnostic-capsule visibility;
- handling render-origin changes;
- exposing draw/body counts for diagnostics.

It does not own input, simulation, networking, terrain, camera collision, or state-file storage.
Those remain with their current owners.

#### A4. Local body

- Start with the existing `local-third-person` mode because it exposes the complete body during
  Traversal Lab testing.
- Feed it the controller's interpolated/predicted position, horizontal velocity, yaw, grounded state,
  standing capsule dimensions, and current support.
- Reuse Bot Viewer v3's `adaptGaitToSpeed`, `movementDynamics`, and `naturalLocomotion` options.
- Keep Base Game's current independently damped camera and obstruction solver. Do not import any of
  the three Pokémon Park camera profiles.
- Add lower-body/first-person visibility only after the complete body follows the capsule correctly.

#### A5. Remote bodies

- Replace remote diagnostic capsules visually through the same presentation owner, while retaining
  the capsules as a debug toggle.
- Feed bodies from the existing interpolated remote tracks after global-to-render-local conversion.
- Reuse `body-part-batches.js` and Bot Viewer v3's distance/budgeted rig-update pattern rather than
  creating one high-draw standalone rig per player.
- Keep player-player collision disabled unless separately designed; a visible body does not imply a
  new collider.

#### A6. Body acceptance gate

- Local and remote bodies occupy the same capsule-defined pose without changing any movement test.
- Two players at the same X/Z on different Y levels keep distinct feet, bodies, and interpolation
  tracks.
- Steps, ramps, tunnel ceilings, bridge and cave probes never move feet onto another surface layer.
- Jump, fall, land, pause, respawn and kill-plane recovery produce bounded visual transitions.
- First-person hiding and third-person visibility do not produce duplicate hands/body parts.
- Render-origin rebasing causes no network teleport or persistent gait displacement.
- Body disabled returns to the existing diagnostic presentation and movement remains bit-for-bit
  unchanged.
- Sixteen bodies fit the established Base Game draw-call and frame-time budget, recorded through the
  existing performance-record control.

### Track B — terrain source and streaming

Source/evaluator work can proceed in pure modules and tests while Track A runs. Runtime registration
into the authoritative player world waits for the multiplayer acceptance gate.

The file-by-file implementation details, exact source contract, multiplayer ownership changes and
phase gates are specified in [the Base Game terrain execution plan](2026-08-21-base-game-terrain-execution.md).

#### B1. Implement the already documented common terrain-source contract

- Start with the current analytic source as the test implementation.
- Adapt the existing finite GLB plus terrain-data path from Environment Viewer v2 as
  `FiniteMapSource`; do not repeat a finite GLB to fake infinity.
- Adapt Terrain Generator v5's compatible point/tile evaluation as `InfiniteRecipeSource`.
- Keep source version, algorithm version, finite bounds, and optional field capabilities explicit.
- Use existing v5 recipe/project JSON as the procedural artifact; do not define another terrain
  authoring format.
- Host the canonical v5 interface inside Base Game as Terrain Studio through the shared project
  model and a narrow same-origin bridge; do not duplicate its controls. State files embed the full
  project, while multiplayer references a published immutable project key and content hash.

#### B2. Keep generation separate from world collision

- Terrain sources return deterministic tile data in global coordinates.
- A terrain world-query provider exposes nearby authoritative collision through the existing service.
- Cave interiors, buildings, bridges, and Traversal Lab geometry remain separate 3D providers and
  can coexist with the outdoor heightfield.
- Rendering consumes the same tile data but does not become the collision authority.
- Client and server use the same source recipe/version and collision sampling rules.

#### B3. Stream ordinary chunks first

- Generate off the frame loop with persistent workers, nearest-first requests, cancellation, and
  source epochs as already specified in the Base Game terrain plan.
- Keep complete old tiles until replacements are ready.
- Preserve ordinary frustum culling.
- Register and remove collision tiles atomically with their authoritative global bounds.
- Verify adjacent borders, generation-order independence, save/reload determinism, and rendered/
  collision agreement before introducing a specialized clipmap renderer.

#### B4. Add flight-scale visual LOD without changing near collision

- Reuse the flight demo's camera-following geometric-clipmap principle.
- Build the documented prefiltered field pyramid so distant height, material, biome, hydrology and
  hole data use matching LODs.
- Keep full-detail authoritative collision near each relevant player or aircraft.
- Treat a horizon shell as visual only.
- Do not add terrain-specific logic to the player body or controller.

#### B5. Terrain acceptance gate

- Analytic, finite and infinite sources can be enabled, disabled or replaced without rebuilding the
  player controller or body.
- Adjacent tiles have identical border samples and collision.
- Streaming and LOD changes do not create capsule pops, cracks, false steps or unsupported gaps.
- The Traversal Lab can coexist with outdoor terrain as another world-query provider.
- A terrain-cut cave entrance and interior preserve distinct surfaces at shared X/Z.
- Render-origin rebasing preserves global tile, player and support identities.
- Terrain draw/triangle cost remains approximately bounded during ground travel and flight-scale
  travel.

## Integration sequence

1. Finish the current multiplayer correction and acceptance work.
2. In parallel, complete A1-A3 against Traversal Lab and B1-B3 in isolated source/provider tests.
3. Pass the multiplayer gate before registering streamed terrain in the authoritative runtime world.
4. Complete A4 with the local player on Traversal Lab.
5. Register the first analytic/finite terrain provider and rerun the complete capsule/player suite.
6. Complete A5 remote bodies using the already accepted multiplayer state.
7. Add the terrain-cut cave/stacked-surface integration scene and pass both body and collision tests.
8. Establish the sixteen-player body budget before adding weapons, equipment, plants, water, or
   creatures.
9. Add flight-scale LOD only after ordinary streamed chunks are correct and measurable.

Tracks A and B share only `worldQuery`, world coordinates, and the player-state presentation adapter.
Neither track waits for the other's rendering details.

## Explicitly deferred

- Skinned-model import or replacement of the procedural body.
- Full-body rigid-body collision or a mesh-shaped player controller.
- Mantling, climbing, crawling and ledge grabbing.
- Footstep audio/material effects beyond retaining surface identity.
- Weapon, combat, damage, ragdoll, limb-loss and role-kit integration.
- Player-player collision.
- Water, plants and creatures.
- Pokémon Park's legacy player physics, camera, flora collision and finite world clamp.

These are later consumers of the established capsule, body-presentation and world-query contracts;
none is required to prove that the body and terrain can be developed safely in parallel.
