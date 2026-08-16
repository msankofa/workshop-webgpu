# NPC Design Suite — implementation plan

**Status:** authored 2026-08-09; product decisions settled 2026-08-11 (gallery = mode B; NPC/UI persist separately; undo chokepoint accepted); not started.
**Goal:** merge the five WebGPU "body cluster" tool pages into **one UI** — a single shell that owns one renderer / scene / camera / lighting rig and hosts each tool as a swappable **mode**, with **one persistent NPC that stays loaded across modes** (design its body → preview skin → pose its weapon → shoot it → ragdoll it, without reloading).

Multiple files are fine; the requirement is one UI, not one file. Each tool becomes an ES module exporting an `init(ctx)` / `dispose()` contract and runs against the shared context.

## Scope

In scope — the body cluster (all import `player-procedural-body.js`, all WebGPU r0.184, one importmap):

| Tool | Lines | Role in suite | Consensus friction |
|---|---|---|---|
| `bot-design-studio.html` | ~2046 | **infrastructure donor** + new single-NPC design mode | MED–HIGH (gallery ≠ single NPC) |
| `damage-simulator.html` | ~468 | Damage / hit-FX mode | LOW–MED |
| `weapon-animation-viewer.html` | ~636 | Weapon pose / carry authoring mode | LOW–MED |
| `ragdoll-viewer.html` | ~400 | Ragdoll / death mode | MEDIUM (raw RAF loop) |
| `body-preview-v3.html` | ~4018 | Skin / gait / weapon-hold preview mode | HIGH (size + meta-tools) |

Out of scope: the weapon-asset tools (`weapon-anchor-editor.html`, `weapon-viewer-v2.html` — no body, different data model) and `creature-model.html` (no shared imports). They stay standalone.

Friction ratings come from an 8-scout independent reconnaissance pass (2026-08-09); the two scariest scout claims were **disproven by direct verification** — see "Corrected assumptions" below.

## Corrected assumptions (verified, not inferred)

1. **The `?v=23` / `?v=5` import pins are NOT a version divergence.** There is exactly one `player-procedural-body.js` and one `weapon-pose-controller.js` on disk; `serve.py` strips the query string and serves the same file. The pins are cache-busters. Fix = delete the query strings from `body-preview-v3.html`'s two import lines. **Not cosmetic, though — see P2.** ES module records are keyed by the full specifier including query string, so `player-procedural-body.js?v=23` is *today* a separate module instance with its own module-scope `_sharedBodyGeo` (`player-procedural-body.js:36`). The pins are currently isolating body-preview-v3's geometry cache from every other tool's, and removing them merges two previously independent caches.
2. **body-preview-v3 is not an FPS-camera app.** Its body is built with a `mode` variable (line ~2591) driven by a dropdown; `local-lower-body`/`local-third-person` are **render-scope toggles on the same shared rig** (`lowerOnly`, line ~1505 just filters which parts draw), not a separate camera-owning application. In-suite it runs a third-person mode; the local toggles become an in-mode view option or are dropped.

## The real obstacles (unanimous across scouts, confirmed in code)

0. **Mesh mode vs instanced mode is an unreconciled fork in the "one persistent NPC" premise.** This is the real P0 and it outranks the cache work. `bot-design-studio.html` and `damage-simulator.html` build **instanced** bodies; `weapon-animation-viewer.html:105`, `ragdoll-viewer.html:101` and `body-preview-v3.html:616` build **mesh** bodies. They are not interchangeable: `player-procedural-body.js:762` returns a real `THREE.Mesh` in mesh mode but a bare `Object3D` placeholder explicitly *"never rendered"* in instanced mode; `:867` is `if (scene && !instanced) scene.add(group)`, so an instanced body's group is never in the scene at all; mesh mode mints ~15 per-body materials while instanced mode uses the pool's shared role materials, so per-body material work (skin preview, exposure, tinting) has no instanced equivalent; and `destroy()` at `:1941` early-returns in instanced mode, disposing nothing. **One shared NPC forces one mode, which means porting three tools' rendering assumptions.** Decide which mode the suite's NPC is before P1, because the answer changes what the cache work has to protect.
1. **Shared geometry cache growth.** `_sharedBodyGeo` / `clearSharedBodyGeometry()` in `player-procedural-body.js` exists as a **growth** control, not a liveness one: the cache is keyed by content, so re-designing a body mints a new entry per distinct dimension (comment at `player-procedural-body.js:38-42`), and the explicit clear is the only thing bounding it. Three callers today — `bot-design-studio.html:362`, `damage-simulator.html:167`, and `ds_check.mjs:107` (an untracked root-level Node script that reproduces damage-sim's `buildBot()`); the other tools never clear. Caller *count* is not the point, though: in `bot-design-studio` the clear runs on **every slider release** via `rebuild()` → `buildSlots()` → `:362`, so the plan's original "cleared aggressively on every rebuild" was correct. With one permanently-alive, permanently-re-designed NPC there is no safe moment to call the nuclear clear, and refcounting alone never sweeps a live NPC — so the cache needs **refcount plus a sweep of unreferenced entries**. See P1.
2. **Motion ownership.** weapon-anim drives a circular walk, body-preview-v3 drives its own locomotion, damage-sim paces the body. Only the **active** mode may drive the NPC's motion. Needs an explicit rule.
3. **No real teardown.** Only ragdoll-viewer has partial cleanup (`clearActors`/`clearBodies`); every other tool assumes it owns the page for its lifetime. Each needs a `dispose()`.
4. **Loop inconsistency.** ragdoll-viewer uses raw `requestAnimationFrame`; the others use `renderer.setAnimationLoop`. The shell owns one loop and calls each mode's `tick(dt)`.

## Architecture

### The shell (new file: `npc-suite.html` + `npc-suite-shell.js`)

Owns and shares one of each:
- `renderer`, `scene`, `camera`, `controls` (OrbitControls), `rig` (lights), `postFX`, `visuals`, `floor`
- one `setAnimationLoop` that calls `activeMode.tick(dt)`
- the **eviction-disciplined, injected geometry cache** (moved out of per-tool ownership — see P1)
- **one persistent NPC**: `{ body, design, batches, weaponBatches }` plus a **split** change bus — `geometry-changed` / `material-changed` / `gait-changed` — so a colour tweak doesn't mint geometry and preview modes subscribe narrowly (A5)
- **one design-edit chokepoint** `applyDesignChange(patch)` — the sole writer of NPC design state, emits the split change events, and is the hook the undo stack records (A9, accepted 2026-08-11). Modes never mutate `npc.design` directly. The visible undo UI can ship later; the chokepoint is present from step 1 so it never has to be retrofitted across five modes.
- **optional mode-owned body set** for the gallery mode (decision B): the shared NPC is always alive, but a mode may build additional bodies through `ctx.add()`. Only the gallery mode does. All obey P1 retain/release.
- **per-mode camera framing + optional rig/post-FX overrides**: the shell captures framing on `dispose()` and restores on `init()` (ragdoll wants a wide shot, weapon authoring a close read on the hands, skin preview its own exposure) (A4)
- a tab bar + one sub-panel container that the active mode populates

~80% of this already exists inside `bot-design-studio.html` (renderer/scene/camera/lights/post-fx/visuals/floor/batches/weapon-mount pipeline/panel helpers `section/row/slider/toggle`). Harvest it; do not fold the studio in verbatim.

### Mode contract

```
export function createMode(ctx) → {
  init(),            // build sub-panel, register via ctx.add*/adopt ctx.npc
  tick(dt),          // per-frame; may drive npc motion only if drivesMotion
  dispose(),         // release ONLY genuinely mode-specific state; ctx auto-releases the rest
  drivesMotion,      // bool: does this mode own the NPC's position/gait?
}
```
`ctx` = `{ THREE, scene, camera, controls, renderer, rig, postFX, visuals, npc, geoCache, panelRoot, addListener, add, addTimer }`.

**Teardown is structural, not a convention (A2).** `ctx.addListener(el, ev, fn)`, `ctx.add(obj3d)`, `ctx.addTimer(...)` return tracked wrappers; the shell releases everything registered through them on unmount. Five hand-written `dispose()`s would drift, and the failure mode is silent (a surviving listener or orphaned `Object3D` surfaces as an unrelated bug several modes later — the worst position for a shared-mutable-state architecture). `dispose()` then only handles genuinely mode-specific state.

Rule: on tab switch, `oldMode.dispose()` + shell auto-release, then `newMode.init()`. The NPC, renderer, lights, camera, and geo cache persist. Only one mode's `tick` runs.

## Prerequisites (before any mode lands)

- **P1 — Retain/release the geometry cache, sweep only unreferenced entries, and inject it (revised twice — see the addendum review).** Two mechanisms were rejected before this one; read A1 before changing it.
  - **Not refcount alone** (the plan's first draft): a permanently-alive NPC never drops to zero refs, so nothing is ever swept and a currently-bounded leak becomes unbounded.
  - **Not frame-based eviction** (the addendum's first draft): **the cache is a build-time structure, not a draw-time one.** Every `cache.get()` call site is in the construction path (`player-procedural-body.js:810, 829, 853, 857, 859, 887, 899, 930, 943, 958`); the draw path goes `flush()` → `pool.add(part.geometry, …)` (`:1895`) and never consults the cache. A last-touched counter in `get()` therefore ticks once, at build, and would sweep the geometry of every live body. Touching on *draw* instead fails too, on three cases that are alive and correct: a hidden body (`flush()` early-returns on `!group.visible`, `:1889`), a hidden part (`:1894` skips `!part.visible`, which is how `setAmputated` works), and — fatally, with no idling or hiding required — **LOD twins**: `:1047` mints `part.userData.lodGeo = [part.geometry, gearGeometry(…)]` and `setGearLod` (`:1860-1864`) swaps between them, so the unselected twin is *by construction* never drawn. Sweeping it means the first LOD swap renders a disposed geometry. Three of the five tools also build in mesh mode where `flush()` no-ops entirely, so any draw-derived signal is blind to them.
  - **Do this instead.** Liveness must be *declared at build*, not *inferred from drawing*, and growth must be clocked on *design edits*, not frames. (a) Thread a `cache` option through `createProceduralPlayerBody` — `createPrimitiveFactory` already accepts `{cache}` (`model-primitives.js:60`) and `player-procedural-body.js:773` hardcodes `_sharedBodyGeo`, so it is two edits (`:605` signature, `:773`) and every existing caller keeps the module-global default. (b) Give the cache `retain(key)` / `release(key)`, called from body construction and `destroy()`. Build-time retain covers the LOD twin, the amputated limb and the hidden body for free — that is the whole argument for retain over touch. (c) Bound growth by sweeping **only refcount-zero entries**, evicted by an edit counter or a size cap, keeping the last N unretained geometries as a rebuild scratch pool. Superseded designs hit zero the instant the old body is destroyed, which is exactly the leak the design tools generate. `clearSharedBodyGeometry()` then becomes "sweep all unretained" — safe by construction, and the footgun is gone.
  - **P1 test:** (a) a geometry whose last holder was destroyed is disposed on the next sweep; (b) a geometry held by a live body is never disposed regardless of visibility, LOD level, or amputation state; (c) a body built by mode A survives mode B's teardown. *This is the gate; nothing else is safe until it's done.*
  - **STATUS: DONE 2026-08-12.** Shipped as `createGeometryCache` refcount + `beginRecord`/`endRecord`/`releaseAll`/`sweep`/`retain`/`release`/`refcount`, plus a `cache` param on `createProceduralPlayerBody` (default `_sharedBodyGeo`) recording each body's keys at build and releasing them in `destroy()` (both modes, before the instanced early-return). `clearSharedBodyGeometry()` left unchanged for back-compat — the suite simply never calls it and uses `sweep()` instead. `test-geometry-cache.mjs` (15 assertions, incl. the LOD-twin case) green; `test-player-body-gait/ik`, `test-weapons`, `test-ghost-renderer` still green.
- **P1b — Give the batch pool a way to drop buckets for specific geometries.** Both current clear sites do `batches.dispose(); clearSharedBodyGeometry(); batches = createBodyPartBatches(…)` (`bot-design-studio.html:361-363`, `damage-simulator.html:166-168`) — dispose and recreate the whole pool. The suite has **one shell-owned pool that must survive mode switches**, so it cannot do that, and `body-part-batches.js` currently exposes only `evictAfter = 120` frames in `endFrame()` or a full `dispose()`. A targeted bucket-drop is a missing API and a prerequisite, not a nice-to-have.
  - **STATUS: DONE 2026-08-12.** Added `dropBucket(geometry)` / `dropBuckets(geometries)` (evict on demand; share one internal `evictBucket` helper with frame-count eviction), and a `sweep(keep, onDispose)` hook on the cache so the shell wires them with one line (`geo => batches.dropBucket(geo)`). Never disposes geometry (the cache owns that); order-independent. `test-body-part-batches-drop.mjs` (11 assertions incl. the cache→pool bridge) green; existing `test-body-part-batches.mjs` (33) still green, so the eviction refactor is behavior-preserving.
- **P2 — Drop the `?v=` pins** in `body-preview-v3.html:616-617` (2 lines). **Not cosmetic:** module records are keyed by full specifier, so today those pins give body-preview-v3 its own separate `_sharedBodyGeo`. Deleting them merges two independent caches into one — which is what the suite wants, but it lands directly on P1 and increases the growth rate of the mode that iterates hardest on limb dimensions. Sequence it *after* P1, not before.
- **P3 — Define the motion-ownership rule** in the shell (`drivesMotion` flag + "active mode only" enforcement).
- **P4 — Persistence via `bot-viewer-slots.js` (A6, corrected).** Reuse the shipped 6-slot module (`SLOT_COUNT`, `readSlots`/`writeSlots`/`saveSlot`/`loadSlot`/`deleteSlot`, `pickKeys`/`assignKnown`, `createSlotSection`) rather than inventing a scheme. **Migrate four keys, not one** — `body-preview-v3.html` holds real authoring work, not just an active-tab key: `body-preview-v3-mapping-overrides` (`:1225`, written `:1304`) and `body-preview-v3-grip-tuning` (`:1232`, written `:1255`) are weapon-mapping overrides and grip-tuning profiles, exactly the data class already flagged as needing re-authoring. Plus `pcw:botDesignStudio` and `pcw:helmetCritique` (`bot-design-studio.html:1890`, `:2008`). Without this the cutover silently drops them. **Slot scope — DECIDED (2026-08-11): NPC and UI persist on separate tracks.** An NPC slot captures design state only (dimensions, material/skin, gait — the change-bus data), so loading a slot into any mode restores design and nothing else. Per-mode UI state (active tab, panel/section state, view toggles, per-mode camera framing from A4) is a separate persistence track keyed independently, restored on shell load regardless of which NPC is active. The four migrated authoring keys map onto the NPC track where they describe the body/weapon (mapping-overrides, grip-tuning) and onto the UI track where they describe tool state.

## Sequencing (easiest first, to prove the shell)

1. **Shell + NPC + geo-cache eviction (P1–P4)** — build `npc-suite-shell.js`, harvest bot-design-studio's infra, stand up one persistent NPC and an empty tab bar. **Freeze `bot-design-studio.html` at this step (A7):** the shell now owns this code; leave a header note. Otherwise donor and copy drift and step 5 turns from a move into a merge. (Optional A8: `?mode=<name>` deep links preserve muscle memory during the transition and make bug reports reproducible.)
   - **STATUS: shell DONE 2026-08-15, awaiting browser QA.** `npc-suite.html` + `npc-suite-shell.js` (GPU shell, infra harvested) + `npc-suite-core.js` (GPU-free scaffolding, Node-tested by `test-npc-suite-core.mjs`, 21 assertions). Delivered: injected geo cache + shell-owned pool wired to the P1/P1b rebuild bridge; `applyDesignChange` chokepoint (A9); split change bus (A5); shell undo stack + Ctrl+Z (A9); `createModeManager` with tracked-scope teardown (A2) + motion-ownership guard (P3); per-mode camera framing (A4); NPC-track persistence via `bot-viewer-slots.js` (P4, UI track deferred to when modes land); `?mode=` deep link (A8); `bot-design-studio.html` frozen with a header note (A7). **Deferred inside step 1:** the material-only retint fast-path (material changes rebuild for now); P2 (`?v=` pins) stays sequenced for when body-preview-v3 becomes a mode. No modes registered yet — tab bar is empty by design.
2. **Mode 1: damage-simulator** — **this step is mis-sized: it is not a refactor.** "Reconfigure the shared NPC on variant change instead of destroy/rebuild" assumes a reconfigure path that does not exist. `design` is bound once at construction (`player-procedural-body.js:607`, and `:770`'s own comment says "`design` is bound once above"), the returned API (`:1963`) has no `setDesign`, and every geometry, part, anchor and material is derived at build time. Adding live re-design is comparable in size to the cache work. Either budget it as its own prerequisite, or keep destroy/rebuild for variant changes and let P1's retain/release make that safe — **the latter is recommended**, since P1 already has to make rebuild-under-a-live-suite correct. Also add effect-queue flush on `dispose()`.
   - **STATUS: DONE 2026-08-15, awaiting browser QA.** `npc-mode-damage.js` — a faithful port of `damage-simulator.html` (1115 lines). Took the recommended path: **variant switch goes through `ctx.applyWholeDesign`** (the shell's safe destroy+rebuild under P1), and the mode resets its per-body state (limb map, wound, bleed, effects, live `body` handle) off the **`geometry` bus event** rather than reaching into the rebuild. `drivesMotion: true` — `tick()` paces the NPC or poses its ragdoll and flushes it inside the shell's begin/endFrame bracket; the new **`afterFrame(dt)`** hook syncs the effect wire list and draws projected stains after the batch frame. `dispose()` flushes the effect queue (`fx.sync([])`), disposes fx / projected decals / stain texture / crosshair, and cancels the tuning-save timer; tracked pointer/beforeunload listeners auto-release. Tuning still autosaves to `pcw:damageTuning` (its own per-mode track). `damage-simulator.html` left live until this is browser-verified, then retires. `node --check` clean; suite Node tests still green.
3. **Mode 2: weapon-animation-viewer** — the closest to target shape already; isolate `carryEdits` state to the mode; gate its circular-walk drive behind `drivesMotion`.
   - **STATUS: DONE 2026-08-16, awaiting browser QA.** `npc-mode-weapon-anim.js` — faithful port of `weapon-animation-viewer.html` (637 lines). Kept the tool's self-contained floating `#ctrl` panel as **mode-owned DOM** (injected on `init`, removed on `dispose`; CSS scoped under `#ctrl`, nudged left of the shell panel) rather than rebuilding ~250 lines of authoring UI — lowest-risk path. Rewired the engine only: mounts weapons on `ctx.npc.body` (instanced, so `tick()` **flushes** it inside the shell bracket), uses the shared scene/camera/pool, `drivesMotion: true` with the circular-walk drive gated by the panel's own `carryDrive` checkbox; `carryEdits` mode-local; re-mounts off the `geometry` bus if the NPC is rebuilt; sets its own default camera framing (A4 restores per-mode). `dispose()` removes the DOM/style/grid/tip-line/weapon-rig/markers, releases the left-arm IK target, and unsubscribes the bus. Also hardened the damage mode: `dispose()` now restores the NPC whole+alive so death/amputation can't break weapon IK on handoff. **This is the first real mode-to-mode teardown** (damage ⇄ weapon). `node --check` clean; core test green. `weapon-animation-viewer.html` left live until browser-verified.
4. **Mode 3: ragdoll-viewer** — re-home its raw RAF into the shell's `tick(dt)`; drive the shared NPC via the existing `body.setRagdollPose()` path.
5. **Mode 4: single-NPC design** — harvest bot-design-studio's design/gait/material editing for the one shared NPC, routing every edit through `applyDesignChange`.
5b. **Mode: gallery** (decision B) — bot-design-studio's 6-body side-by-side view as its own mode; builds N mode-owned bodies via `ctx.add()`, leaves the shared NPC alone. Can land alongside or after step 5 since it reuses the same design-editing code.
6. **Mode 5: body-preview-v3** — last. Absorb the preview/skin/gait tuning; consider splitting its **optimizer** and **reload-tuner** out as separate sub-tools rather than importing all 4018 lines. Its local view toggles become an in-mode option.

Each mode step: refactor to the contract, verify in-browser that the shared NPC persists across a tab switch, then move on.

## Product decisions (settled 2026-08-11)

1. **Gallery — DECIDED (B): keep it as one special multi-body mode.** The suite's design mode edits the single shared NPC, but bot-design-studio's 6-body gallery survives as a distinct "gallery" mode. **Consequence for the shell contract:** the "one persistent NPC" premise is now "one persistent NPC *plus* an optional mode-owned body set." The gallery mode builds and owns its N extra bodies through `ctx.add()` (so structural teardown reclaims them on unmount), while the shared NPC stays untouched underneath. This keeps the shared-NPC invariant intact for the other four modes and confines all multi-body complexity to the one mode that needs it. The gallery's own bodies obey the same P1 retain/release discipline as the shared NPC.
2. **Slot scope — DECIDED: NPC and per-mode UI persist separately.** A saved slot captures the **NPC design state only** (body dimensions, material/skin, gait — the data the shared change bus already tracks). Per-mode UI state (active tab, panel expand/collapse, per-mode view toggles, camera framing) is persisted on a **separate track**, not folded into the NPC slot. This means loading an NPC slot into any mode is well-defined (it only ever restores design), and UI ergonomics restore independently of which NPC is loaded. See P4.
3. **Undo — DECIDED by user (A9): route all design edits through one shell chokepoint now.** Every design mutation flows through a single shell entry point (`applyDesignChange(patch)`), which emits the split change events (A5) and is the sole writer of NPC design state. The visible undo/redo UI may ship later, but the chokepoint and patch-history hook are built in from step 1 — retrofitting them across five modes afterward is the expensive path the addendum warned about.

## Testing / verification

- Node: geo-cache retain/release test (P1, three assertions above), plus existing `test-player-body-*.mjs` / `test-weapons.mjs` stay green.
- Browser (the real QA): after each mode lands, confirm the NPC stays loaded across a tab switch and each mode reads/writes it correctly. Render correctness (skin, weapon mount, ragdoll flop, hit FX) is browser-only.
- **Leak assertion (A3, corrected probes):** cycle A→B→A a few times behind a debug flag and assert that **batch bucket count, registered-listener count (from P-A2's `ctx` wrappers), and unretained-cache size** return to baseline. Do *not* assert on `scene.children.length` — an instanced body adds nothing to the scene (`player-procedural-body.js:867`) — and do *not* assert that `renderer.info.memory.geometries` returns to baseline, because a retained shared cache is *supposed* to hold geometry across a switch. Both of those fire on correct behaviour.

## Effort (scout estimate, unverified)

~600–1000 lines for the shell + ~200–400 per mode. Body-preview-v3 dominates the tail. Prereq P1 is small but load-bearing.

## Docs / log on completion

- New subsystem doc if the shell becomes its own group; otherwise fold into the relevant `docs/subsystems/*.md`.
- Append `agent_log.csv` rows per mode landed.
- Retire the five standalone pages only after their mode is browser-verified in the suite.

---

# Addendum — review pass, 2026-08-09

Added after a read of the plan against the code. Everything below was verified by reading the named files; line references are the evidence. The plan's structure and sequencing are sound and are not disputed here. Item A1 argues one prerequisite is specified wrongly; the rest are gaps rather than corrections.

## A1 — P1 as written would make the leak permanent (blocking)

**The plan says:** refcount the shared geometry cache so one mode's teardown cannot drop geometry another mode is rendering.

**The problem:** refcounting addresses liveness, but liveness is not why `clearSharedBodyGeometry()` exists. Its own comment at `player-procedural-body.js:38-44` states the actual reason:

> Design tools rebuild bodies hundreds of times per session with slightly different dimensions. Every distinct dimension mints a new cache entry (keyed by content), and each new geometry also mints a new InstancedMesh bucket downstream, so an unbounded cache leaks both here and in the batch pool.

The clear is a **growth** control. In the suite the NPC is permanently alive and permanently being re-designed, so a refcounted cache never reaches zero references and can never be swept. P1 as specified converts a leak that is currently bounded by an explicit clear into one that is unbounded for the whole session, and it does so in the mode that iterates hardest.

**RETRACTED — the first proposed fix was wrong.** This section originally argued that P1 should copy `body-part-batches.js`'s frame-based eviction (`evictAfter = 120`) into the geometry cache, on the reasoning that "it subsumes liveness, since anything being rendered is being touched." **That sentence is false against the code, and building on it would ship a crash.** The retraction is kept rather than deleted because the reasoning error is a trap anyone re-reading this plan could fall into again.

Why it fails: the cache is a **build-time** structure. Every `cache.get()` call site is in the construction path (`player-procedural-body.js:810, 829, 853, 857, 859, 887, 899, 930, 943, 958`); the draw path runs `flush()` → `pool.add(part.geometry, …)` (`:1895`) → `bucketFor(geometry, role)` (`body-part-batches.js:74`), which keys off the geometry *object* and never consults the cache. So a touch counter in `get()` increments once per geometry, ever, at build — and would sweep every live body's geometry N frames later.

Touching on *draw* instead fails on three cases that are alive and correct:
- **Hidden body** — `flush()` early-returns on `!group.visible` (`:1889`); `setVisible(false)` (`:1867`) sets exactly that. All its geometry would be swept, and `_instanceParts` would still hold references to disposed buffers.
- **Hidden part** — `:1894` skips `!part.visible`, which is how `setAmputated` works. An amputated limb's geometry goes untouched while the body lives.
- **LOD twins, which kill the idea outright** — `:1047` mints `part.userData.lodGeo = [part.geometry, gearGeometry(g, GEAR_LOD_SEG)]` and `setGearLod` (`:1860-1864`) swaps `p.geometry = p.userData.lodGeo[l]`. The unselected twin is *by construction* never drawn. No hiding, no idling, no amputation needed: a fully visible, continuously rendering NPC has geometry that a draw-derived signal never sees, and the first LOD swap would render a disposed buffer.

Three of the five in-scope tools also build in **mesh** mode (`weapon-animation-viewer.html:105`, `ragdoll-viewer.html:101`, `body-preview-v3.html:616`), where `flush()` no-ops entirely, so any draw-derived signal is blind to 3/5 of the suite.

The section also **misread the comment it leaned on.** `body-part-batches.js:130` — "drop the bucket, never the shared geometry" — is the batch pool *disclaiming* authority over geometry lifetime because it cannot know who else holds a reference (`:157` says so outright). Bucket eviction is safe precisely because it is **recoverable**: `bucketFor` rebuilds on the next `add()`, and the `b.evicted` flag exists to force a WeakMap miss. Geometry disposal is **not** recoverable — holders keep dead references. Extending an idempotent-recovery policy to a non-recoverable resource is the error, and "reuses a pattern already shipped here" is exactly what made it read as safe.

**The correct fix is retain/release plus a sweep of unreferenced entries, clocked on design edits rather than frames — now written up in P1.** Liveness declared at build covers the LOD twin, the amputated limb and the hidden body for free, which is the whole argument for retain over touch.

**What survives from this section:** the diagnosis — refcounting alone does not bound growth, and P1's first draft would have made the leak permanent. That half was right and drove the correction.

**The injection paragraph also stands:** `createPrimitiveFactory` already accepts `{ cache = createGeometryCache() }` (`model-primitives.js:60`) while `player-procedural-body.js:773` hardcodes `cache: _sharedBodyGeo`. Threading a cache option through `createProceduralPlayerBody` is two edits (`:605`, `:773`), every existing caller keeps the default, and it makes "suite-owned" real.

**Correction to this section's own scope claim:** it said "exactly two callers." There are three — `bot-design-studio.html:362`, `damage-simulator.html:167`, and `ds_check.mjs:107`. And caller *count* never rebutted the plan's "cleared aggressively on every rebuild," which is correct: in bot-design-studio the clear runs on every slider release.

## A2 — Make teardown structural, not a convention (should fix)

Obstacle 3 correctly notes that four of five tools have no teardown. The plan's answer is that each mode gets a `dispose()`. Five hand-written disposes will drift, and the failure mode is silent: a surviving listener or an orphaned `Object3D` surfaces as an unrelated bug several modes later, which is the worst possible debugging position for an architecture whose whole premise is shared mutable state.

Have `ctx` hand out tracked wrappers — `ctx.addListener(el, ev, fn)`, `ctx.add(obj3d)`, `ctx.addTimer(...)` — and let the shell release everything registered through them on unmount. `dispose()` then only handles genuinely mode-specific state. Correctness stops depending on five authors remembering the same discipline.

## A3 — Add a leak assertion to the tab-switch check (should fix)

The verification step is "confirm the NPC stays loaded across a tab switch," which catches the visible failure but not the accumulating one. Cycle A→B→A a few times and assert that `scene.children.length`, `renderer.info.memory.geometries` and `renderer.info.memory.textures` return to their baseline. That is the exact bug class this architecture is exposed to, it is a few lines in the shell behind a debug flag, and it also serves as the in-browser counterpart to A1's Node test.

## A4 — Per-mode camera framing, rig and post-FX (should fix)

The shell owns one camera, one lighting rig and one post-FX chain, but the modes want different ones. Ragdoll wants a wide shot to watch a body fall, weapon authoring wants a close read on the hands, skin preview wants its own exposure. As specified, every tab switch leaves the user re-framing by hand.

Capture framing on `dispose()` and restore it on `init()`, and allow optional rig/post-FX overrides that the shell restores on unmount. This is small, and it is most of the difference between a suite and five pages sharing a canvas.

## A5 — Split the `design-changed` event (should fix)

One coarse event means a colour tweak takes the same path as a limb-length change. **Correction to the original reasoning:** this is not a cache-growth problem — cache keys are content-derived, so a colour tweak that re-runs the build path hits every existing key and mints nothing new. The real cost is the **rebuild itself**: a full part destroy/reconstruct, and in `bot-design-studio` also `batches.dispose()` + `clearSharedBodyGeometry()` (`:361-362`). The recommendation is unchanged — split into `geometry-changed`, `material-changed` and `gait-changed`, and let preview modes subscribe narrowly.

## A6 — Preset persistence is unaddressed (gap)

The plan does not say how the suite saves anything.

**Corrected inventory** — the original claim that "body-preview-v3 persists an active-tab key only" was wrong, and the error mattered, because the migration it implied would have silently dropped real authoring work. Actual state: `bot-design-studio.html` persists `pcw:botDesignStudio` and `pcw:helmetCritique` (`:1890`, `:2008`); `body-preview-v3.html` persists an active-tab key **plus** `body-preview-v3-mapping-overrides` (`:1225`, written `:1304`) and `body-preview-v3-grip-tuning` (`:1232`, written `:1255`), which are weapon-mapping overrides and grip-tuning profiles; damage-sim, weapon-anim and ragdoll persist nothing.

Adopt `bot-viewer-slots.js` rather than inventing a scheme — it already ships `SLOT_COUNT = 6` with `readSlots`, `writeSlots`, `saveSlot`, `loadSlot`, `deleteSlot`, `pickKeys`, `assignKnown` and `createSlotSection`. Migrate all four keys. One product question falls out: does a slot capture the NPC alone, or the NPC plus per-mode UI state?

## A7 — bot-design-studio is both infra donor and mode (sequencing)

Step 1 harvests ~80% of the shell from `bot-design-studio.html`; its own mode does not land until step 5. In between it stays live and editable, so donor and copy drift and step 5 turns from a move into a merge. Either freeze the studio page at step 1 with a header note that the shell now owns this code, or pull its mode earlier in the sequence.

## A8 — Deep links (optional)

`npc-suite.html?mode=ragdoll` preserves existing muscle memory during the transition and makes bug reports reproducible. Cheap, and it reduces the cost of retiring the standalone pages.

## A9 — Undo belongs to the shell, if it is in scope at all

Separate research the same day (`docs/research/robot-viewer-transferable-features.md`) found that no authoring harness in this repo has undo, and ranked a shared undo stack as the highest-value item available. This suite is exactly that authoring loop.

One stack over the shared NPC's design state at the shell level is far cheaper than retrofitting five modes afterwards, and the same research put drag-to-pose and a Bézier keyframe timeline in what becomes the weapon-animation mode. This is not a request to widen scope. It is a note that the decision has to be made **before** the shell's state model is fixed, because "the shell can snapshot and restore the NPC's design" is an architectural property, not a feature to be added later.

## Not disputed

body-preview-v3's `mode` variable being a render-scope toggle was re-checked and holds. The obstacles are real. The sequencing — prove the shell on damage-simulator, take body-preview-v3 last — is right, as is splitting body-preview-v3's optimizer and reload-tuner out rather than importing all 4018 lines. (The gallery-retirement recommendation (A) was **overridden by the user 2026-08-11 in favour of (B)** — keep it as a mode-owned multi-body view; see "Product decisions.") (The cache-buster assumption holds on the facts but not on the conclusion — see the revised item 1 and P2.)

---

# Review of the addendum, 2026-08-09

The addendum above was put through an adversarial review pass tasked with breaking it rather than agreeing with it. It changed six things, and every claim below was re-verified directly against the code afterwards.

**What the review overturned:**

1. **A1's proposed mechanism — the most load-bearing item in the document — was wrong and is now retracted in place.** Frame-based eviction would have disposed geometry belonging to live bodies. The decisive case is the LOD twin at `player-procedural-body.js:1047`, which no draw-derived signal can ever see. P1 is rewritten around build-time retain/release.
2. **A1's revised test encoded the bug.** Its first assertion — "a geometry untouched for N frames is disposed" — would have locked the defect in as expected behaviour. Replaced.
3. **A1's "exactly two callers" was wrong** (three, including `ds_check.mjs:107`) and, more importantly, answered a question the plan had not asked: caller count does not rebut the plan's frequency claim, which was correct all along.
4. **A6's inventory was wrong**, and would have caused the migration to silently drop `body-preview-v3`'s weapon-mapping overrides and grip-tuning profiles.
5. **A3's probes fire on correct behaviour.** `scene.children.length` is blind to instanced bodies, and a retained shared cache is *supposed* to hold geometry across a mode switch.
6. **A5's mechanism was wrong** though its recommendation was right — content-derived keys mean a colour tweak mints nothing; the cost is the rebuild.

**What the review added that neither document had caught:** the mesh-vs-instanced fork (now obstacle 0 and the real P0), the missing targeted bucket-drop API in the batch pool (now P1b), the fact that plan step 2's "reconfigure instead of rebuild" describes a code path that does not exist, and that P2's `?v=` pins are currently *isolating* two geometry caches rather than being cosmetic.

**What survived unchanged:** A1's diagnosis that refcounting alone does not bound growth — which is what drove the correction — and its injection paragraph. A2, A4, A6's recommendation and A7 were judged to earn their place. A8 was judged padding and is kept only because it costs nothing.

**Standing instruction for anyone editing P1:** two mechanisms have already been proposed and rejected here, for reasons recorded in A1. Read that section before proposing a third.
