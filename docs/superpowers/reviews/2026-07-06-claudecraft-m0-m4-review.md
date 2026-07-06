# ClaudeCraft Creatures Integration — M0–M4 Code Review

**Date:** 2026-07-06 · **Scope:** Milestones M0–M4 (headless sim vendoring + seams + bridge modules) of `docs/superpowers/plans/2026-07-05-claudecraft-creatures-integration.md`, as merged on `sp1-webgpu-renderer-migration`. Rendering/multiplayer wiring (M5/M6) not yet built and not reviewed here.

**Overall verdict:** Sound foundation for M5/M6 **with caveats** — the scale/world-content/mob-snapshot bridge modules are correct and well-tested, and the collider-wrapper and player-mirror seams preserve the original sim's control flow correctly. But one seam edit (`nearSteepWalls`) silently disables mob climb-slope gating everywhere rather than just removing the built-in ridge/rim walls as intended, and the bridge factory's fixed-step loop has no spiral-of-death guard. Both should be fixed before M5 in-page verification, since both are exactly the kind of bug that only shows up visually on real terrain (mobs climbing cliffs) or under load (a backgrounded tab freezing on resume).

---

## Finding 1 — Mob climb-slope gate is fully disabled on real terrain, not just the removed built-in walls

**File:** `claudecraft-sim/world.ts:434-439` (the `nearSteepWalls` seam), consumed at `claudecraft-sim/sim.ts:4449`
**Severity:** Blocker

`nearSteepWalls` was changed to unconditionally `return false`, with a comment claiming "the climb-slope gate still runs against the injected terrain via `terrainSteepnessAt`, which is what stops mobs scaling the workshop's real cliffs."

That's not what the consuming code does. The mob movement fan-out gate at `sim.ts:4449` is:

```ts
if (nearSteepWalls(nx, nz) && terrainSteepnessAt(nx, nz, this.cfg.seed) > MAX_CLIMB_SLOPE) {
```

This is an **AND**, not an OR. In the original ClaudeCraft design, `nearSteepWalls` is a cheap pre-filter: the built-in heightfield is deliberately shallow everywhere except inside known ridge/rim bands (see the comment at `sim.ts:4443-4448`: "Screened to the wall bands so the hot open-world fan pays nothing"), so skipping the exact steepness check outside those bands was safe. Once `nearSteepWalls` always returns `false`, the right-hand `terrainSteepnessAt` check **never runs at all** for mobs — not just outside the old walled bands, but everywhere, including on arbitrarily steep real workshop terrain (procedural cliffs, authored-map cliffs). Mobs get zero climb-slope gating.

Contrast with the player path (`sim.ts:3111`, `3180`, `3286`, `3680`), which correctly ORs the two checks and is unaffected — "players get the full gate everywhere in sim.ts" (per the code's own comment) is true, but the parallel claim for mobs is not.

**Concrete failure scenario:** on a procedural or authored map with a real cliff, a chasing/wandering mob will walk straight up (or down) a vertical face instead of routing around it, which will be immediately visible in the M5 in-page smoke test ("mobs stand on and walk across terrain... without floating or sinking" — this is the walking-across-cliffs cousin of that bug).

**Suggested fix direction:** either (a) drop the `nearSteepWalls(nx, nz) &&` from the mob gate at `sim.ts:4449` so mobs get the same unconditional `terrainSteepnessAt(...) > MAX_CLIMB_SLOPE` check players get, or (b) make `nearSteepWalls` return `true` unconditionally when a height provider is active (restores the "always check" semantics without touching `sim.ts`). Since (b) keeps the diff confined to `world.ts`, it's probably the smaller, safer change, but note it removes the perf pre-filter for mobs entirely, which is likely fine at the workshop's expected mob counts but worth a quick perf sanity check.

---

## Finding 2 — No spiral-of-death guard on the bridge's fixed-step accumulator

**File:** `claudecraft-bridge/claudecraft-creatures.js:68-91` (`update()`)
**Severity:** Should-fix

```js
acc += dt;
let stepped = false;
while (acc >= SIM_DT) {
  ...
  sim.tick();
  acc -= SIM_DT;
  stepped = true;
}
```

There is no cap on iterations and no clamp on the incoming `dt`. If the workshop tab is backgrounded and resumed, hits a long GC pause, or a debugger breakpoint is released, `rawDt` for the next `requestAnimationFrame` can be seconds long. At `SIM_DT = 1/20`, a 5-second stall alone demands 100 synchronous `sim.tick()` calls in a single `update()` invocation before the loop even returns control to the render frame — classic fixed-timestep spiral-of-death, and it gets worse the longer the stall, since each `sim.tick()` itself takes real wall-clock time.

**Concrete failure scenario:** user alt-tabs away from the browser for any length of time and switches back; the next frame's `update()` call hangs the main thread for as long as it takes to catch up, which for a long-enough absence never really catches up (each tick takes non-zero time, so the deficit can grow rather than shrink).

**Suggested fix direction:** clamp the incoming `dt` before accumulating (e.g. `dt = Math.min(dt, MAX_FRAME_DT)`), and/or cap the number of `sim.tick()` calls per `update()` invocation, dropping any leftover `acc` rather than trying to fully catch up. `port-creature-bridge.js` (the sibling IK-creature bridge) may already have a convention for this worth mirroring.

---

## Finding 3 — `makeScale` has no guard against degenerate input

**File:** `claudecraft-bridge/sim-scale.js:5-12`
**Severity:** Should-fix

```js
export function makeScale(workshopPlayerHeight) {
  const SCALE = workshopPlayerHeight / SIM_HUMANOID_HEIGHT;
  return { SCALE, toWorld: (v) => v * SCALE, toSim: (v) => v / SCALE };
}
```

No validation that `workshopPlayerHeight` is a positive finite number. `createClaudecraftCreatures` documents this as coming from "the live player-size setting" (a UI-controlled value), and M5's wiring plan explicitly says it's read from a live symbol in `environment-viewer.html`. If that value is ever `0` (e.g. read before the setting initializes) `SCALE` becomes `0`, making every `toSim()` call divide by zero (`Infinity`/`NaN`), which will silently poison every seam (height provider, collider provider, world-content build) the moment the sim boots.

**Concrete failure scenario:** the bridge factory is constructed on the same frame the player-height setting is still at its pre-init default of `0` (or briefly negative during a slider drag) → `Sim` boots with `Infinity`/`NaN` coordinates baked into `buildClaudecraftWorldContent`'s zone bounds and camp centers.

**Suggested fix direction:** assert/clamp `workshopPlayerHeight` to a sane positive range in `makeScale`, or have the caller guarantee a valid value before construction (whichever the M5 wiring finds more natural given how the live setting is read).

---

## Finding 4 — `test-claudecraft-seams.mjs` never migrated off its stub `makeScale`

**File:** `test-claudecraft-seams.mjs:9-15`
**Severity:** Should-fix (test quality)

```js
// TODO wave2: replace stub with `import { makeScale } from './claudecraft-bridge/sim-scale.js'`.
// The claudecraft-bridge/ modules are owned by a different agent and do not exist in this
// worktree yet. SCALE derives from the workshop player height / 2.6 (sim humanoid yards).
function makeScale(workshopPlayerHeight) { ... }
```

This was written during parallel wave-1a/1b development when `claudecraft-bridge/sim-scale.js` didn't exist yet in that worktree. It now exists (`a722b7c`, wave 1b), but the TODO was never resolved — `test-claudecraft-seams.mjs` still uses its own hand-duplicated copy of the scale formula instead of importing the real bridge module. This means a future change to `makeScale`'s formula (e.g. a different reference height, a unit-system change) can silently desync from this test without the test ever failing, defeating part of the point of having a seam test at all.

**Suggested fix direction:** delete the inline stub and `import { makeScale } from './claudecraft-bridge/sim-scale.js'` as the plan originally specified.

---

## Finding 5 — Collider-seam test only checks the resolver was called, not that its result was applied

**File:** `test-claudecraft-seams.mjs:41-53`
**Severity:** Nit (test quality)

```js
setExternalColliderResolver((x, z, r) => { resolverCalls++; return { x: 1, z: 1 }; });
...
console.assert(resolverCalls > 0, 'external collider resolver was consulted during movement');
```

This proves the resolver is invoked, but never asserts that a mob's resolved position actually reflects the resolver's `{x:1,z:1}` pin. The current implementation (`colliders.ts`: `resolvePosition` returns `externalResolver(res.x, res.z, r)` directly) does apply it correctly, so there's no live bug — but a regression where the return value is computed and then discarded (e.g. a future refactor that calls the resolver for its side effect only) would slip through this test undetected.

**Suggested fix direction:** after ticking, assert that at least one mob's resolved position is at/near the pinned `(1,1)`, not just that the callback fired.

---

## Finding 6 — `reviveExternalPlayer` resets fewer fields than the sim's own resurrection path

**File:** `claudecraft-sim/sim.ts:1639-1649`, compare `claudecraft-sim/spirit.ts:181-211` (`reviveAt`)
**Severity:** Nit

`reviveExternalPlayer` resets `hp`, `dead`, `auras`, and `pos`/`prevPos`. The sim's own internal resurrection helper (`reviveAt`) additionally clears `ghost`, `corpsePos`, `ccDr`, `targetId`, `autoAttack`, `queuedOnSwing`, `combatTimer`, `inCombat`, resets `facing`, and calls `ctx.rebucket(p)` to re-register the entity's spatial-grid cell immediately (rather than waiting for end-of-tick re-bucketing).

Currently this is low-risk: `handleDeath` (the only automatic death path) doesn't set `ghost = true` on its own — only an explicit spirit-release does — so in the expected "workshop notices death, runs its own respawn UX, calls `reviveLocalPlayer` shortly after" flow, `ghost` is still `false` and this gap is inert. But it's a latent inconsistency: if the external player's spirit is ever released (or any future code path starts reading `e.ghost`/`e.corpsePos`/`e.ccDr` for an external player), a revive through this path will leave stale state that the sim's own revive path would have cleared.

**Suggested fix direction:** either call through to (a shared-context-exposed) `reviveAt`-equivalent logic instead of hand-rolling a subset, or explicitly reset the same field list `reviveAt` does.

---

## What was reviewed and looks solid (no issues found)

- **`claudecraft-bridge/sim-world-content.js`**: the `WorldContent`/`ZoneDef`/`ZonePropsDef` shape was independently checked field-by-field against `claudecraft-sim/types.ts` (not just the code's own comments) — all required fields present, optional fields correctly omitted, `emptyZoneProps()` shape matches exactly.
- **`claudecraft-sim/colliders.ts` collider wrapper**: rather than inserting the external-resolver call before every one of `resolvePosition`'s four early-return branches (as the plan's literal instructions suggested), the implementation renamed the original body to `resolvePositionBuiltin` and wraps it once (`resolvePosition` calls it, then applies `externalResolver` to whatever it returned). This is a cleaner approach than the plan's and correctly covers every branch (delve/arena/dungeon-interior/open-world) by construction.
- **External-player movement bypass** (`sim.ts:3196`, `updatePlayerMovement`): correctly early-returns before any position/gravity integration for `meta.external`, and this is the only place per-tick player position is mutated outside `setPlayerPose`, so the sim and the host mirror cannot fight.
- **`serializeMobs`** (yaw-quaternion math, hp normalization): verified the quaternion formula against the sim's own documented facing convention (`facing` such that direction = `(sin f, 0, cos f)`, 0 = +Z) — `[0, sin(f/2), 0, cos(f/2)]` is the correct axis-angle quaternion for that convention. HP normalization guards `maxHp > 0` correctly.
- **`SimConfig.world` invariant**: `claudecraft-creatures.js` never passes `cfg.world` to the `Sim` constructor, relying entirely on `setActiveWorldContent()` + the constructor's `this.cfg.world ?? getActiveWorldContent()` fallback — this satisfies the documented invariant (terrain/colliders/spawns must read the same content) without needing to duplicate content into both places.
- **Plan-deviation check**: `PlayerMeta` living in `sim.ts` rather than `types.ts` (as the plan assumed) is confirmed correct — that's where the interface is actually defined in the vendored source, so the `external?: boolean` field was added in the right file.
- **Fixed-step `SIM_DT` vs. sim's own `DT`**: both are `1/20`, consistent.

## What was NOT reviewed

- The vendored sim internals beyond the three injected seams (combat, abilities, quests, delves, market, etc. — all untouched, out of scope per the plan).
- The bundle's byte-for-byte reproducibility (already independently confirmed per the task brief; not re-checked here).
- Any in-page M5 wiring (rendering, `environment-viewer.html` integration, `GhostRenderer`) or M6 multiplayer replication — neither is built yet.
- Runtime/perf behavior under real mob counts (e.g. whether removing the `nearSteepWalls` pre-filter, per Finding 1's fix, has a measurable per-tick cost at the workshop's expected roster size).
- Browser-side behavior of the scale/height/collider seams against the *real* `terrainHeight`/`trunkIndex.resolve` implementations (only exercised here via synthetic stand-ins in the headless tests).
