# Rapier Physics Fork — Implementation Plan

Date: 2026-07-12
Spec: `docs/superpowers/specs/2026-07-12-rapier-physics-fork-design.md`
Decisions locked: full roadmap (Phases 0–3), flag-gated seam in `main`, vendored
`@dimforge/rapier3d-compat`, ragdolls fold into Phase 1.

## References (verified 2026-07-12)

- **Rapier exemplar:** external `threejs-playground`/dreamfall, studied in
  `docs/research/threejs-playground-feature-research.md`. Same stack as us, uses
  `@dimforge/rapier3d-compat`, injects spatial queries as callbacks (the seam
  pattern), and demonstrates the debris/vehicle/telekinesis payoffs. **This is the
  only Rapier reference** — see next.
- **Analytic (feel-parity) oracle:** `../html game/html-game-v2`. NOT a Rapier
  reference (confirmed: zero Rapier refs). Its
  `SWEPT_CAPSULE_CONTROLLER_IMPLEMENTATION_PLAN.md` is a custom Quake III / Godot
  move-and-slide kinematic controller — the ancestor of this repo's analytic path,
  and the movement-feel target for Phases 1a/2.

## STATUS

- [ ] Phase 0 — WASM load + smoke test
- [ ] Phase 1a — `physics-world.js` interface + `physics-analytic.js` (pure refactor)
- [ ] Phase 1b — `physics-rapier.js` static world (terrain/map/trunks) + query parity
- [ ] Phase 1c — dynamic bodies: projectiles, explosion knockback, props, ragdolls
- [ ] Phase 2 — Rapier `KinematicCharacterController` for the player
- [ ] Phase 3 — hitscan + lag-comp via `castRay`/`castShape`
- [ ] Phase 4 — (backlog) Rapier-native payoffs: destructible props, dismemberment
      debris, telekinesis, vehicles

Each phase is independently shippable and revertable by flipping `?physics=`.
Default stays `analytic` until a phase is proven at parity.

## Ground rules for every phase

- Snapshot `environment-viewer.html` (and any large file) to `versions/` before editing.
- One `agent_log.csv` row per logical change; update the owning `docs/subsystems/*.md`.
- New Node tests are `test-<name>.mjs` at repo root, no framework.
- Rapier is host-only. Nothing in `physics-rapier.js` may be constructed on a guest
  (guests `applySnapshot` and render ghosts; they never step physics).
- The `analytic` backend must remain byte-for-byte current behavior — Phases 1a
  onward are additive, never destructive to the default path.

---

## Phase 0 — De-risk WASM loading

Goal: prove `@dimforge/rapier3d-compat` initializes in both runtimes before writing
any real physics code. If this fails, the fork stops here.

1. Vendor the compat build into `vendor/rapier/` (rapier.es.js — the base64-inlined
   single-file build; no separate `.wasm`). Pin the version in a `vendor/rapier/README.md`.
2. Add `"rapier": "./vendor/rapier/rapier.es.js"` to the importmap in
   `environment-viewer.html` so browser + Node resolve the same specifier.
3. Confirm `serve.py` serves `.js` under `vendor/` as ESM (it already does for app
   modules; verify the path isn't excluded).
4. Write `test-physics-smoke.mjs`: `await init()`, create a `World` with gravity,
   a static ground plane collider, a dynamic cuboid dropped from height; step ~120
   fixed steps; assert it rests at ground + half-extent within tolerance.
5. Manual browser check: a throwaway `?physics=smoke` branch (or console snippet in
   env-viewer) that runs the same drop and logs the rest height, to confirm WASM
   loads under `serve.py` and not just Node.

Done when: `node test-physics-smoke.mjs` passes AND the browser logs the same rest
height. No app behavior changes yet.

---

## Phase 1a — Interface + analytic backend (pure refactor, no Rapier)

Goal: make the seam real by routing today's physics through it, default unchanged.

1. Write `physics-world.js` — the interface from the spec, plus a
   `createPhysicsWorld({ backend, ...deps })` factory that lazy-imports the chosen
   backend module (mirrors the `GRASS_MODE` lazy-import pattern).
2. Write `physics-analytic.js` implementing the interface by delegating to the
   existing modules (this is the swept-capsule lineage from html-game-v2 — treat that
   controller as the behavior reference if any resolve-order question comes up):
   - `stepCharacter` → the body of `updateFPSPlayer` (map BVH `resolveCapsule` /
     `groundContact` / `trunkIndex.resolve` / dressing index), lifted verbatim.
   - `castRay` / `castShape` → `combat.js` `resolveHitscan` and the projectile
     `ctx.raycast` used by `combat-projectile.js`.
   - `spawnBody` / `step` / `drainContacts` → drive the existing
     `combat-projectile.js` update loop (grenade/rocket integration stays as-is here).
   - `setAnalyticTerrain` / `addStaticTrimesh` / `setTrunks` → store the field +
     `map-collision` collider + `trunkIndex`; no-ops beyond wiring.
3. In `environment-viewer.html`: read `PHYSICS_BACKEND` from the query string,
   construct the world once, and replace the direct calls in `updateFPSPlayer`,
   the hitscan path, and the projectile tick ctx with calls through the world.
   Behavior identical for `analytic`.
4. Tests: existing `test-combat.mjs`, `test-combat-projectile.mjs`,
   `test-weapons.mjs` must stay green unchanged (proves the refactor is behavior-neutral).
   Add `test-physics-world.mjs` asserting the analytic backend's `castRay` matches
   `resolveHitscan` directly on a few fixtures.

Done when: `?physics=analytic` (default) is indistinguishable from today and all
existing tests pass.

---

## Phase 1b — Rapier static world + query parity

Goal: stand up `physics-rapier.js` with the *static* world only, and prove its
queries agree with the analytic backend. No dynamics wired into gameplay yet.

1. `physics-rapier.js`: `await init()`-gated `World` construction (host-only guard).
2. Static colliders:
   - `setAnalyticTerrain(field)` → build a Rapier `Heightfield` collider sampled
     from `terrainHeightAt` over the play extent; rebuild on terrain edits.
   - `addStaticTrimesh(positions)` → Rapier trimesh collider from the same triangle
     soup `collectWorldTriangles` already produces for authored maps.
   - `setTrunks` / `setDressingSolids` → proximity-streamed cylinder colliders keyed
     by chunk; add on stream-in, remove on stream-out (Rapier broadphase replaces
     the hand-rolled `trunkIndex`). Apply dreamfall's prefetch trick: extend the
     maintained collider ring ~1s of travel ahead of any fast body so it never reaches
     an unbuilt chunk edge mid-step.
3. Queries: `castRay` → `world.castRayAndGetNormal` with a `QueryFilter` excluding
   the owner via collision groups; map the hit collider back to `{ kind, id }`.
4. Add a `passPhysicsMs` bucket to `frame-profiler.js`.
5. Tests: `test-physics-rapier.mjs` — for a grid of ray fixtures, assert
   Rapier `castRay` hit point/kind matches the analytic `castRay` within tolerance;
   heightfield rest height matches `terrainHeight`.

Done when: `?physics=rapier` runs the game using Rapier for *ray queries + static
world* while movement and projectiles still use the analytic code paths internally,
with no gameplay regression and parity tests green.

---

## Phase 1c — Dynamic bodies (projectiles, knockback, props, ragdolls)

Goal: the headline win. Move dynamic simulation to Rapier under `?physics=rapier`.

1. Grenade → dynamic `RigidBody` + `Ball` collider, **CCD enabled**; subscribe to
   contact events; detonate on fuse timeout or first contact impulse over a
   threshold. Remove the bounce/`GROUND_CLEARANCE` math from the Rapier path (keep
   it in the analytic path).
2. Rocket → kinematic body advanced by velocity with a per-step `castShape` sweep
   for the hit (preserves the flat, no-drop feel); detonate on first hit.
3. Explosion → keep `blastDamageAt` falloff for damage; add
   `applyImpulse(region, impulse)` to dynamic bodies within `blastRadius` for
   knockback. Falloff-scaled impulse.
4. Kickable props → a small dynamic-body spawner (crates/barrels) exercising
   character-vs-prop and explosion-vs-prop.
5. Ragdolls → on creature/player death (host), swap the rendered rig for a jointed
   set of Rapier capsules (multibody via joints); read transforms back into the
   existing serialize path so guests render the ragdoll as ghost transforms. Start
   minimal (a few segments), expand if it feels worth it.
6. Host integration: run `world.step(dt)` inside the entity-registry tick; read body
   transforms into entity `serialize()` so the replicated snapshot path is unchanged
   and guests stay render-only.
7. Tests: extend `test-physics-rapier.mjs` — grenade comes to rest / detonates on
   fuse parity vs analytic; explosion applies non-zero impulse to an in-radius body
   and zero beyond radius; damage lands on the same target set as the analytic path.

Done when: under `?physics=rapier`, grenades/rockets behave at least as well as
today, explosions knock props around, ragdolls fire on death, `passPhysicsMs` is
within host budget, and the analytic default is untouched.

---

## Phase 2 — Rapier character controller

Goal: replace the player movement/collision tangle with Rapier's controller.

1. In `physics-rapier.js`, implement `stepCharacter` with a
   `KinematicCharacterController`: a capsule collider moved by desired velocity
   against the Phase-1b static colliders (terrain heightfield + map trimesh +
   trunk/dressing cylinders). Map `autostep`, `slopeLimit`, and snap-to-ground to the
   current `fp` tunables (`heightStand/Crouch/Prone`, `PLAYER_SLOPE_LIMIT_Y`).
2. Preserve feel: air-strafe, jump arc, friction, and crouch/prone height swaps must
   match the analytic path. Keep the input/velocity computation in
   `applyFPSControls`; only the *resolve* step moves into Rapier.
3. A/B tune: run `?physics=analytic` and `?physics=rapier` side-by-side; iterate on
   controller params until movement is indistinguishable. Analytic stays default
   until then.
4. Tests: a Node harness stepping the controller over a slope/step/trunk fixture,
   asserting grounded state + final position within tolerance of the analytic
   `stepCharacter`.

Done when: movement under `?physics=rapier` is indistinguishable from analytic
across flat ground, slopes at the limit, steps, jumps, and trunk/prop contact.

---

## Phase 3 — Hitscan + lag compensation

Goal: unify all ray-vs-X combat math on Rapier and retire the bespoke casters.

1. Route the hitscan fire path through the world's `castRay` (already Rapier in
   Phase 1b) with collision groups for player/creature/mob/obstacle/terrain and an
   owner filter; map results to the existing `hit.kind` contract consumed by
   `applyHitDamage`/`spawnShotEffects`.
2. Lag compensation: before the authoritative cast, re-pose each player's kinematic
   collider to its historical transform sampled from `combat.js` pose history
   (`samplePlayerPose`), cast, then restore. Validate against `validateShot`'s drift
   rules unchanged.
3. Tests: parity — for recorded shot fixtures, the Rapier cast selects the same
   target as `resolveHitscan`; a lag-comp fixture where a moving target is hit at its
   rewound position but missed at its current position.

Done when: hitscan + lag-comp under `?physics=rapier` match the analytic outcomes on
the fixture set; `combat.js`'s bespoke casters remain only as the analytic backend.

---

## Phase 4 — Rapier-native payoffs (backlog, not committed)

The features that justify carrying the engine, unlocked once Phases 0–1 land. Each is
demonstrated by dreamfall (research doc, Tier 2–3); sequence by appetite, not required
to ship the fork.

1. **Destructible props / debris** — dynamic bodies that are kicked, shot, and
   blast-thrown; extends Phase 1c's impulse work. Nearest-term.
2. **Dismemberment debris** — the cut math (runtime plane-clip of a posed skinned-mesh
   snapshot + flood-fill split) is Rapier-free and portable; only the falling chunks
   are Rapier bodies. Pairs with a melee overhaul.
3. **Telekinesis** — direct velocity control over debris bodies (orbit pull, aim launch).
4. **Vehicles / mounts** — Rapier rigid-body vehicles using the terrain-prefetch ring.

Note: the Rapier-free wishlist (traversal, grapple, weather, POM, hex-tiling, WFC) is
tracked in the research doc and is **not** part of this fork.

---

## Cross-cutting deliverables

- New subsystem doc `docs/subsystems/physics.md` (interface, backends, flag, Rapier
  wiring, host-only constraint, collider streaming) — created in Phase 1a, extended
  each phase. Add a row to the subsystem table in `CLAUDE.md` and `code-map.html`.
- `docs/subsystems/multiplayer.md` — note the host-only Rapier step and that
  serialize/snapshot is unchanged (Phase 1c).
- `docs/subsystems/infra.md` — `passPhysicsMs` profiler bucket (Phase 1b).
- Keep `combat.js`, `collision.js`, `map-collision.js`, `combat-projectile.js` as the
  analytic backend's implementation — do not delete; they are the default path and
  the parity oracle.
