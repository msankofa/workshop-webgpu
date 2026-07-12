# Rapier Physics Fork — Design

Date: 2026-07-12
Status: Draft / for review (no code written)

## Context

The workshop-webgpu game has grown a set of hand-rolled physics subsystems that
were each fine in isolation but now overlap and are getting expensive to extend.
The trigger for this spec is the weapons work just landed: `combat-projectile.js`
now does its own ballistic integration, swept raycasts, terrain contact, and
bouncing, and the next things on the wishlist (ragdolls, explosion knockback,
kickable physics props, dynamic debris) are exactly what a real rigid-body engine
gives for free and what hand-rolled math makes painful.

[Rapier](https://rapier.rs) (`@dimforge/rapier3d`, Rust compiled to WASM) is the
obvious candidate: mature, fast, MIT-licensed, has a purpose-built
`KinematicCharacterController`, CCD for fast projectiles, ray/shape casting, and
heightfield/trimesh colliders. This document specs a **fork** — a parallel,
flag-gated physics backend — rather than a rip-and-replace, so the current system
stays shippable while Rapier is proven out.

### Reference implementations

Two nearby codebases inform this, in *opposite* roles — don't conflate them:

- **`../html game/html-game-v2`** — the direct analytic predecessor of this stack.
  It is **not** a Rapier reference (zero Rapier references in it). Its
  `SWEPT_CAPSULE_CONTROLLER_IMPLEMENTATION_PLAN.md` is a custom kinematic
  swept-capsule controller in the Quake III / Godot move-and-slide lineage, and it
  deliberately avoids adopting a physics package. It is the design ancestor of this
  repo's `updateFPSPlayer` + `collision.js` + `map-collision.js`, and therefore the
  **feel-parity oracle** for the analytic backend (Phase 1a) and the character
  controller (Phase 2). Its stated non-goals are guardrails worth inheriting: keep
  the playable version working throughout, design the collision query API with entity
  filters, and don't take a package dependency casually.
- **`threejs-playground` / dreamfall** (external; studied in
  `docs/research/threejs-playground-feature-research.md`) — the actual Rapier
  exemplar. Same stack as us (WebGPU, Three.js r0.184, TSL, no bundler), built on
  **`@dimforge/rapier3d-compat`**. It validates three bets in this spec: (1) the
  compat WASM build works in this exact no-bundler stack; (2) its whole architecture
  injects spatial queries as callbacks (`physics.moveCharacter()`,
  `level.findXCandidate()`) — i.e. the same backend-seam pattern proposed below,
  arrived at independently; (3) it demonstrates the concrete Rapier-only payoffs that
  motivate the fork: runtime dismemberment debris, destructible props, vehicles, and
  telekinesis (all rigid-body dynamics). The research doc also notes a reusable
  mitigation for the streaming risk below — the vehicle system samples a terrain ring
  ~1s ahead of travel to avoid physics hitches at unloaded chunk boundaries.

The research doc's other strategic finding shapes scope: **most** wishlist features
(traversal/parkour, grapple-swing, weather, POM, hex-tiling, WFC interiors, the
great-sword cutting math) are portable **without** Rapier. Only dynamic debris,
vehicles, telekinesis, and destructible props genuinely require it. This fork is
scoped to exactly those — adopting Rapier is not a prerequisite for the rest, and
this spec does not gate them on it.

### The physics we hand-roll today

| Surface | File(s) | What it does |
|---|---|---|
| Player character controller | `environment-viewer.html` `applyFPSControls`/`updateFPSPlayer` (~6608–6690) | manual velocity + gravity + air-strafe + friction; capsule resolve vs map BVH, analytic terrain, trunk push-out, dressing solids |
| Map collision | `map-collision.js` | three-mesh-bvh capsule resolve + downward raycast for authored maps |
| Terrain contact | `collision.js` `groundContact`, `terrain-field.js` | O(1) analytic heightfield contact + slide |
| Trunk / dressing push-out | `collision.js` `resolveTrunks` + chunk-bucketed `createTrunkIndex` | lateral XZ circle push-out |
| Hitscan combat | `combat.js` `resolveHitscan` (+ `rayCapsuleHit`, `rayVerticalCylinderHit`, `raymarchTerrainHit`) | nearest-of-all ray test vs players/creatures/mobs/obstacles/terrain |
| Lag compensation | `combat.js` pose history | rewind capsule poses for host-side shot validation |
| Combat projectiles | `entity-types/combat-projectile.js` | grenade/rocket ballistic integration, swept `ctx.raycast`, terrain bounce, fuse/life |
| Explosions | `entity-types/explosion.js` | radial falloff damage (no impulse) |
| Creature locomotion | `port-creature-system.js` `physicsStep` | terrain spring (KP/KD), drag, FABRIK IK gait |

### Two facts that make this low-risk

1. **Multiplayer is host-authoritative.** Only the host runs the sim; guests
   render interpolated ghosts and never step physics (`docs/subsystems/multiplayer.md`).
   Rapier does not need cross-machine determinism for the current model — only the
   host simulates. This removes the single scariest thing about adopting a physics
   engine in a networked game. (Caveat: any *future* client-side prediction/rollback
   would reintroduce a determinism requirement; Rapier is deterministic given an
   identical build+platform, but not guaranteed bit-identical Mac↔Windows. Out of
   scope here.)
2. **The codebase already has a backend-selection pattern.** Mode flags pick
   lazy-import variants (`GRASS_MODE` → `grass.js` vs `grass-compute.js`). A
   `?physics=rapier` flag selecting a Rapier backend vs the current analytic one is
   directly in the grain of this repo.

## Non-negotiable constraints this fork must respect

- **No build step / no bundler.** Everything is ES modules served by `serve.py`,
  Three.js via CDN importmap. Rapier ships WASM; loading it without a bundler is the
  main integration risk (see §"WASM loading").
- **Node-testable math.** `combat.js`, `collision.js`, `combat-projectile.js` run
  under plain `node test-*.mjs` with no THREE. Moving a system into Rapier converts
  its unit tests into WASM-backed integration tests. Rapier's `-compat` build *does*
  run under Node, so tests survive, but they become async and heavier. This is a real
  cost, called out per-phase.
- **Host frame budget.** The host already runs the whole sim; Rapier's `world.step()`
  is added cost the host alone pays. Must be profiled against the existing
  `frame-profiler.js` passes.

## Design: a backend seam, not a rewrite

Introduce one interface and two implementations behind it. This is what makes it a
"fork" rather than a gamble: default stays analytic, Rapier is opt-in, and the two
are A/B-comparable in the same build. This is also the pattern dreamfall already uses
(spatial queries injected as callbacks — `physics.moveCharacter()`,
`level.findXCandidate()`), so the seam is proven ergonomics, not a guess.

### `physics-world.js` — backend-agnostic interface

```
createPhysicsWorld({ terrainHeightAt, terrainNormalAt }) -> {
  // static world
  setAnalyticTerrain(field)                 // heightfield source
  addStaticTrimesh(positions)               // authored map soup (from map-collision)
  setTrunks(chunkKey, trunks)               // streamed trunk colliders
  setDressingSolids(chunkKey, solids)

  // character
  stepCharacter(capsule, desiredVelocity, dt, opts) -> { position, grounded, velocity }

  // queries
  castRay(origin, dir, range, filter) -> { point, normal, kind, id } | null
  castShape(shape, from, to, filter)  -> hit | null

  // dynamic bodies (projectiles, ragdolls, props)
  spawnBody(desc) -> handle
  applyImpulse(handle|region, impulse)
  step(dt)                                   // advances dynamic sim + emits contact events
  drainContacts() -> events[]

  dispose()
}
```

### Two backends

- **`physics-analytic.js`** — wraps *today's* code (`collision.js`,
  `map-collision.js`, `combat.js`, `combat-projectile.js`) behind the interface. A
  pure refactor: same behavior, no Rapier. Shipping this first is what makes the seam
  real and keeps `?physics=analytic` (the default) a first-class, tested path.
- **`physics-rapier.js`** — Rapier-backed implementation of the same interface.

Selection mirrors the existing mode flags:

```
const PHYSICS_BACKEND = new URLSearchParams(location.search).get('physics') || 'analytic';
```

### Mapping to Rapier primitives

| Current | Rapier |
|---|---|
| `map-collision.js` capsule resolve | static trimesh `Collider` + `KinematicCharacterController` |
| `collision.js groundContact` | `Heightfield` collider sampled from `terrainHeightAt` |
| `resolveTrunks` / trunkIndex | proximity-streamed cylinder colliders (broadphase replaces the chunk index) |
| `resolveHitscan` nearest-of-all | one `world.castRayAndGetNormal` with collision-group + owner `QueryFilter` |
| `combat-projectile.js` grenade | dynamic `RigidBody` + `Ball`/`Cuboid` collider, **CCD on**, contact events → detonate |
| `combat-projectile.js` rocket | kinematic body + per-step `castShape` sweep (flat/fast, no bounce), or dynamic with gravity 0 |
| `explosion.js` falloff | keep falloff for *damage*; optionally `applyImpulse` to dynamic bodies in radius for knockback |
| creature `physicsStep` + FABRIK | **unchanged** — IK gait is not rigid-body; out of scope |
| light-gun cosmetic projectile | **unchanged** — trivial, not worth moving |

## Phasing

Ordered by value-to-risk. Each phase is independently shippable and gated so a
regression never blocks the default path.

### Phase 0 — De-risk WASM loading (small, blocking prerequisite)

Prove Rapier loads in *both* environments this repo runs in:
- Browser via `serve.py` (env-viewer): `import init, { World } from vendored compat build; await init();`
- Node via `node test-physics-smoke.mjs`.

Deliverable: a smoke test that spawns a falling cuboid over a static plane and
asserts it comes to rest at the expected height, run in Node **and** manually
verified in-browser. If WASM-without-bundler proves unworkable, the whole fork
stops here having cost almost nothing.

### Phase 1 — Dynamic bodies (highest value, lowest feel-risk)

Move **combat projectiles + explosion knockback + ragdolls/debris/props** to Rapier
dynamic bodies, behind `?physics=rapier`. Player movement and hitscan stay analytic
in this phase.

- Grenade → dynamic body with CCD; real bounce/roll/rest; detonate on fuse or first
  significant contact event. Deletes most of `combat-projectile.js`'s bounce math.
- Rocket → kinematic + swept `castShape` (keeps the flat, no-drop feel), detonate on
  first hit.
- Explosion → keep `blastDamageAt` falloff for damage; add optional impulse to
  dynamic bodies in radius (knockback, kicked props).
- Requires a **static-collider representation of the world** for projectiles to hit:
  a single Rapier `Heightfield` from `terrainHeightAt` (rebuilt on terrain edits),
  authored maps as a trimesh (reuse `collectWorldTriangles`), and trunks/dressing as
  proximity-streamed cylinder colliders.
- The host runs `world.step()` inside the entity-registry tick and reads back body
  transforms into the existing serialize path so guests still just render ghosts.

Tests: `test-physics-rapier.mjs` — rest height, ray hit, grenade bounce/rest parity
vs the analytic path within tolerance; damage lands on the same targets.

### Phase 2 — Character controller (biggest feel-risk)

Replace `updateFPSPlayer`'s resolveCapsule + groundContact + trunk + dressing tangle
with Rapier's `KinematicCharacterController` against the Phase-1 static colliders.
Highest risk because movement *feel* must stay identical (slope limit, air-strafe,
jump arc, friction). Gate hard behind the flag, tune against the analytic path
side-by-side, keep analytic as the default until it's indistinguishable.

### Phase 3 — Hitscan + lag compensation (optional unification)

Replace `resolveHitscan` with `world.castRayAndGetNormal` + collision groups, and
implement lag-comp by re-posing player kinematic colliders to historical positions
(from the existing pose history) before casting. Unifies all the ray-vs-X math in
`combat.js`. Deferred because the current hitscan already works and lag-comp rewind
against Rapier colliders is the fiddliest part of the whole effort.

### Phase 4 — Rapier-native payoffs (post-fork, why the engine earns its weight)

Not part of the core migration, but the features that justify carrying a physics
engine at all — each becomes tractable only once Phases 0–1 land, and each is
demonstrated by dreamfall (research doc, Tier 2–3). Listed as a backlog, not a
commitment:

- **Destructible props / debris** — kicked, shot, and blast-thrown dynamic bodies.
  The nearest-term payoff; already half-set-up by Phase 1's impulse/knockback.
- **Dismemberment debris** — the *cutting* math (runtime plane-clip of a posed
  skinned-mesh snapshot, flood-fill split) is portable without Rapier; only the
  falling pieces need it. Pairs with a future melee overhaul.
- **Telekinesis** — direct velocity control over debris bodies (pull into orbit,
  launch along aim).
- **Vehicles / mounts** — Rapier rigid-body vehicles, using the terrain-prefetch ring
  trick to avoid chunk-edge hitches.

These are the concrete answers to "why adopt an engine instead of extending the
analytic code." None are needed to ship Phases 0–3.

### Explicitly out of scope

- Creature IK locomotion (`port-creature-system.js`) — bespoke gait, not rigid-body.
- Cross-client determinism / client-side prediction.
- The legacy `creature-viewer.html` app.
- Rapier-free wishlist features (traversal, grapple, weather, POM, hex-tiling, WFC,
  melee cutting math) — portable without a physics engine; tracked in the research
  doc, not gated on this fork.

## WASM loading (the crux)

Use **`@dimforge/rapier3d-compat`**: a single-file build that base64-inlines the
WASM, so there is no separate `.wasm` fetch and no MIME/bundler configuration —
`import init, {...}` then `await init()`. This is the same build dreamfall runs in an
identical no-bundler WebGPU/TSL stack (per the research doc), which is direct evidence
the approach works here before we write a line of it. Two sourcing options:

1. **Vendored locally** under `vendor/rapier/` and served by `serve.py`. Preferred:
   offline, no CDN dependency for a core system, version-pinned. Cost: ~1–2 MB file
   in the repo.
2. CDN via importmap (jsdelivr/esm.sh). Zero repo weight but adds a network
   dependency to a system that must work to move at all.

Recommendation: **vendor it.** Add `rapier` to the importmap so both browser and
Node resolve the same path. Confirm `serve.py` serves `.js` as ESM (it already does
for the app). `init()` is async and must complete before the first `world.step()` —
gate world creation on it.

## Risks

1. **WASM-without-bundler loading** — mitigated by `-compat` + vendoring; Phase 0
   exists solely to retire this risk early.
2. **Movement feel drift** (Phase 2) — mitigated by flag-gating + side-by-side A/B
   against the analytic default.
3. **Collider streaming lifecycle** — terrain/trunks stream by chunk; Rapier colliders
   must be added/removed as chunks load. Bounded by only maintaining colliders near
   active bodies/player. Mitigation borrowed from dreamfall's vehicle system: sample
   the terrain collider a ring ~1s of travel ahead of fast bodies so a body never
   reaches an unbuilt chunk edge mid-step.
4. **Host frame budget** — `world.step()` is host-only added cost; profile via
   `frame-profiler.js`, add a `passPhysicsMs` bucket.
5. **Heavier, async tests** — moved systems lose pure-math unit tests; parity tests
   against the analytic backend replace them.
6. **Repo size** — ~1–2 MB vendored WASM.
7. **MP** — safe now (host-only sim); documented caveat for any future prediction.

## Success criteria

- `?physics=rapier` runs the game with no crashes; default `?physics=analytic` is
  byte-for-byte the current behavior (pure refactor, tests unchanged).
- Phase 1: grenades/rockets behave at least as well as today; explosion knockback
  works on props; parity tests green; `passPhysicsMs` within host budget.
- Each phase independently revertable by flipping the flag.

## Decisions (locked 2026-07-12)

1. **Scope: full roadmap.** All four phases (0→3) are in scope, executed in order.
   Implementation plan: `docs/superpowers/plans/2026-07-12-rapier-physics-fork-implementation.md`.
2. **Fork shape: flag-gated seam in `main`.** Develop on a branch, but the end state
   is the `?physics=` flag, not a divergent fork.
3. **Rapier sourcing: vendored `@dimforge/rapier3d-compat`** under `vendor/rapier/`,
   wired into the importmap so browser and Node resolve the same path.
4. **Ragdolls: fold into Phase 1** — physics ragdolls + kickable props ride the same
   dynamic-body work as projectiles/knockback.
