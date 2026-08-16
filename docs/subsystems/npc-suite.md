# NPC Design Suite

One UI that hosts the WebGPU "body cluster" tools (damage, weapon-anim, ragdoll, design,
body-preview) as swappable **modes** against a single shared scene, with **one persistent NPC** that
stays loaded across modes. Replaces five standalone pages that each owned a renderer, a scene and a
copy of the same NPC. Full rationale, decisions and sequencing:
`docs/superpowers/plans/2026-08-09-npc-design-suite-plan.md`.

**Status:** shell shipped 2026-08-15; modes **damage** (step 2) and **weapon** (step 3) shipped
2026-08-15/16, awaiting browser QA. Two registered modes now exercise mode-to-mode teardown.
Prerequisites P1/P1b (geometry-cache lifetime, targeted bucket-drop) shipped before the shell.

## Files

| File | Responsibility |
|---|---|
| `npc-suite.html` | Page shell: importmap (three r0.184 webgpu min), panel skeleton (`#hud`, `#panel`), styles, loads `npc-suite-shell.js`. |
| `npc-suite-shell.js` | The GPU shell. Owns one renderer/scene/camera/controls/rig/post-FX/visuals/floor + one render loop, the injected geometry cache and the shell-owned batch pool, the persistent NPC, `applyDesignChange` (the edit chokepoint), the split change bus, the undo stack, the mode manager + per-mode tracked context, per-mode camera framing, and NPC-track persistence. Harvested ~80% from the now-frozen `bot-design-studio.html`. |
| `npc-suite-core.js` | GPU-free scaffolding, so the load-bearing logic is Node-testable: `createChangeBus`, `createUndoStack`, `createTrackedScope`, `createModeManager`. No THREE import. |
| `test-npc-suite-core.mjs` | Node test for the core (change-bus split, undo/redo, tracked teardown, mode-switch motion ownership). |
| `npc-mode-damage.js` | First mode: damage / hit-FX. Faithful port of `damage-simulator.html` onto the shared NPC (variant switch → `ctx.applyWholeDesign`; per-body reset off the `geometry` bus). `drivesMotion`; owns the NPC's frame + FX. Restores the NPC whole + alive on `dispose` (death/amputation don't leak into the next mode). `damage-simulator.html` stays live until this mode is browser-verified, then retires. |
| `npc-mode-weapon-anim.js` | Weapon pose / carry authoring, ported from `weapon-animation-viewer.html`. Keeps that tool's self-contained floating `#ctrl` panel as MODE-OWNED DOM (injected on init, removed on dispose); mounts weapons on the shared NPC and flushes it (`drivesMotion`); `carryEdits` mode-local; re-mounts off the `geometry` bus if the NPC is rebuilt. Sequence/carry export buttons unchanged. `weapon-animation-viewer.html` stays live until browser-verified. |

## Architecture

**One persistent NPC.** `npc = { design, body, state, batches, geoCache }`. `design` is the single
source of truth; `body` is rebuilt from it. The body is built with an **injected** `cache`
(`createGeometryCache()`, P1) and the **shell-owned** `batches` pool (P1b) that survives mode
switches — never disposed/recreated per rebuild the way `bot-design-studio` does.

**Rebuild is the design-change path.** The rig binds `design` at construction (there is no live
`setDesign`), so a geometry change is a safe destroy+rebuild: `npc.body.destroy()` releases that
body's cache holds (P1 retain/release), then `geoCache.sweep(KEEP, geo => batches.dropBucket(geo))`
disposes only now-unreferenced geometry and drops the matching instanced buckets in the same tick
(the P1b bridge), then a fresh body is built. `gait` changes live-tune `body.gait.cfg` with no
rebuild; a material-only retint fast-path is a follow-up (today material changes rebuild).

**`applyDesignChange(patch, kind, opts)` is the sole writer of `npc.design` (A9).** Every mode routes
edits through it; it merges the patch, snapshots for undo, rebuilds/retunes per `kind`
(`geometry`/`material`/`gait`), and fans out on the split bus. Modes never touch `npc.design`
directly. `opts.replace` swaps the whole design (slot load / undo), `opts.noHistory` suppresses the
undo push.

**Split change bus (A5).** `bus.on('geometry'|'material'|'gait'|'any', fn)`; `applyDesignChange`
emits the matching kind so a colour tweak doesn't wake a geometry subscriber.

**Undo (A9).** One shell-level stack over design snapshots (`npc-suite-core` `createUndoStack`),
driven only by `applyDesignChange`. Ctrl+Z / Ctrl+Shift+Z wired; undo/redo apply their snapshot via
`applyWholeDesign(..., { history: false })`.

**Mode contract.** A mode is
`factory(ctx) -> { init?(), tick?(dt), afterFrame?(dt), dispose?(), drivesMotion }`.
`ctx = { THREE, scene, camera, controls, renderer, rig, postFX, visuals, npc, geoCache, batches, bus,
panelRoot, applyDesignChange, applyWholeDesign, undo, on, addListener, add, addTimer }`. The shell
brackets each frame with `batches.beginFrame()` / `endFrame()`: `tick(dt)` runs inside that bracket,
so a `drivesMotion` mode updates + **flushes** the NPC itself in `tick` (it may pose a ragdoll or skip
the gait); a non-driving mode leaves the NPC to the shell's idle update+flush. `afterFrame(dt)` runs
**after** `endFrame()`, before render — for effect syncing and projected decals that must read the
frame's final matrices.

**Structural teardown (A2).** `ctx.addListener/add/addTimer` are tracked wrappers; on mode switch the
shell disposes the old mode then releases everything registered through them (listeners removed,
tracked `Object3D`s removed from the scene + non-shared geometry disposed, timers cleared).
`dispose()` handles only genuinely mode-specific state. `createModeManager` tears down the old mode
+ scope BEFORE building the new one, so two modes' resources never coexist; a failing `init()`
releases the scope and leaves no active mode.

**Motion ownership (P3).** The NPC always updates + flushes each frame. If the active mode declared
`drivesMotion` it drove the NPC in its own `tick()`; otherwise the shell stands the NPC idle. Only
one flush / endFrame / render per frame.

**Per-mode camera framing (A4).** Framing (camera position + controls target) is captured on the way
out of a mode and restored on the way into it, so each mode keeps its own shot.

**Persistence (P4).** NPC design and per-mode UI state persist on **separate tracks** (the decision).
The shell's "suite" section carries an NPC-design slot via `bot-viewer-slots.js` `createSlotSection`
(group `npcSuiteNpc`); per-mode UI tracks are added as modes land.

**Registering modes.** `window.__npcSuite.registerMode(name, factory)` adds a mode + its tab button;
`switchMode(name)` activates it. `?mode=<name>` deep-links (A8).

## Testing

- Node: `test-npc-suite-core.mjs` (core logic), plus the prerequisite tests `test-geometry-cache.mjs`
  (P1) and `test-body-part-batches-drop.mjs` (P1b).
- Browser (the real QA): the shell renders one standing NPC, an empty tab bar, and a working undo +
  NPC save/load slot. Everything visual is browser-only.

## Not yet done

Remaining modes (ragdoll → design → gallery → body-preview, in that order), the material-only retint
fast-path, per-mode UI persistence tracks, and retiring the standalone pages once each mode is
browser-verified (`damage-simulator.html` and `weapon-animation-viewer.html` first).
