# bot-viewer-v2 performance findings — verified list

**Date:** 2026-08-04
**Purpose:** input for a remediation plan. This is a findings list, not a plan.
**Method:** two waves of eight review agents, then every load-bearing claim re-checked against the
source by hand. Agent claims that did not survive that check are in the "Disproven" section rather
than deleted, so nobody re-derives them.

## What "verified" means here

- **Confirmed** — I read the code and the claim holds. File and line cited.
- **Confirmed mechanism, unverified magnitude** — the code does what is claimed, but the millisecond
  figure attached to it is an agent estimate that no measurement supports yet.
- Nothing in the Confirmed list rests solely on an agent's word.

## Measurement baseline

From the most recent per-frame take (697 frames, 15.6 s, ~25 bots, near-constant combat, all
toggles at defaults):

| metric | value |
|---|---|
| `dt` median | 18.7 ms (mean 22.4) |
| `cpu` median | 15.6 ms |
| `gpu` median | 15.1 ms |
| `rnd` (command encoding) | 7.3 ms — 47% of cpu |
| `sim` (all AI) | 4.6 ms — 29% |
| `body` (rig flush) | 2.5 ms — 16% |
| `gap` | 2.6 ms |

Two facts constrain everything below:

1. **The app is on a 60 Hz vsync ladder.** `dt` clusters at 16.6–16.9 and 33.2–33.7 with almost
   nothing between. Frames do not get gradually slower; they fall a rung. `cpu` at 15.6 ms against a
   16.7 ms budget means savings pay off *nonlinearly* — and so does any source of jitter.
2. **`rnd` + `sim` + `body` = 14.4 of the 15.6 ms.** Everything else — `ui`, `aud`, `fx`, `fx3d`,
   `vis`, `wpn`, `pnl` — shares about **1.2 ms combined**. Any finding in those phases is capped by
   that number no matter how bad it looks in isolation.

A separate clean A/B established that **combat costs +9.1 ms, of which +8.3 is GPU and +1.8 is CPU,
with `sim`'s median identical in both arms.** Combat is a render problem, not an AI problem.

---

## Confirmed findings

### 1. The effect renderer draws 480 individually-materialled sprites

`effect-renderer.js:92-112`. `makePool` loops and constructs one `THREE.Sprite` with its own
`SpriteNodeMaterial` per slot — 220 additive (glow) plus 260 normal-blend (smoke). All are added to
the scene once and toggled via `.visible`.

Consequences, all structural:

- Every visible sprite is its own draw call with its own bind group.
- They are transparent, so Three.js sorts them every frame and renders them in a separate pass.
- The two pools use *different blend modes*, so walking the sorted transparent list makes the encoder
  alternate between two pipelines. Batching is defeated by construction.

During a firefight, trail puffs (emitted every 0.035 s per projectile) plus blast puffs put a large
fraction of those 480 in play. This is the leading candidate for both `rnd` and the combat-only GPU
delta, because it is the only mechanism found that is large, render-side, and combat-scaled.

*Note:* `effect-renderer.js` is shared with the environment viewer. Any change here affects both.

### 2. The bot rig is ~57,000 triangles, ~1.4M at 25 bots

The codebase documents this itself. `player-procedural-body.js:1181`: *"rbox is the armour primitive
and, at the default seg=3, 828 triangles a piece — two thirds of a bot's whole triangle budget."*
`player-procedural-body.js:30` confirms the cheap twin is **156 triangles at seg=1**.

Roughly 53 rbox pieces per bot × 828 ≈ 44,000 triangles of armour alone. Add core body, limbs, joints,
hands and feet for ~57,000 per bot, ~1.4M for 25.

**The LOD machinery already exists and is wired.** `player-procedural-body.js:1184-1186` stores
`part.userData.lodGeo = [seg3, seg1]` and pushes into `_lodParts`. It was tested and *backfired* —
`gpu` 11.3→15.7, `body` 1.2→2.1, `rnd` 8.1→9.2.

**Why it backfired is the important part.** `body-part-batches.js:65` keys buckets on
`geometry.uuid`, and `:130` shows buckets are only removed in `dispose()`. Swapping a piece to its
seg=1 twin *adds* a bucket rather than replacing one, so with both variants live the rbox bucket count
roughly doubles. The LOD traded triangles for draw calls and lost.

That means the LOD is not a dead end — it is blocked on bucket lifecycle. A global switch (all bots
to one seg at once) or bucket eviction changes the arithmetic entirely.

**Open tension to resolve before acting:** the LOD A/B concluded draw calls beat triangles at this
bot count, but 1.4M triangles is high enough that triangles *should* matter. The new `tris` column
settles which, and should be read before anyone rebuilds this.

### 3. Renderer construction compounds fill cost — three one-line levers

`bot-viewer-v2.html:137-141`:

```js
const renderer = new WebGPURenderer({ antialias: true, trackTimestamp: PROF_HUD });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
```

- `antialias: true` enables MSAA on the WebGPU backend.
- `setPixelRatio(window.devicePixelRatio)` scales the buffer by display DPI. At 2× that is 4× the
  pixels, and MSAA multiplies on top.
- `PCFSoftShadowMap` is the most expensive shadow filter Three.js ships.

These are compounding, they are the cheapest things in this document to test, and their effect is
pure GPU. **The actual `devicePixelRatio` on the test machine is unknown** — that single unknown
changes the size of this item by 4×. Establish it first.

### 4. One nav call bypasses the planner budget

`bot-viewer-v2.html:7677` — `choosePatrolResumeGoal` calls `floodFill(navGrid, start, {})` directly:
no distance cap, no node cap, no cooldown, no share of the frame budget.

By contrast `bot-viewer-v2.html:7246` sets `REPLAN_BUDGET_PER_FRAME = 8` as a **global** cap with a
300 ms per-bot cooldown and spawn-order jitter, and everything routed through `requestPathBudgeted`
respects it. This one call is not routed through it.

The comment above the line explains the origin: *"One unbounded Dijkstra replaces the old
A*-per-patrol-point scan."* That wins on small maps and loses quadratically as they grow — grid cells
are a fixed 0.5 m, so doubling map size quadruples node count. It matches the measurements exactly:
`seek` totalled 3635 ms (7.9%) on the large maps and 252 ms (1.6%) on the small ones, same code.

Four triggers reach it, all in `finishInvestigation`: target swap, init failure, the 12 s search-window
expiry, and patrol-region exhaustion.

**Priority note:** at the current map size this costs little. It is insurance against map growth, not
a present-tense fix.

### 5. Physics and collision are ungated by the think stagger

*Confirmed mechanism, unverified magnitude.*

`updateBotSentry` — all of `senA`/`senB`/`senC`/`senD` — is gated by `thinkStride`, so only ~6–7 of
25 bots run the FSM per frame. That is why `senD` is down at 0.3 ms median.

But `stepBotPhysics` (`bot-viewer-v2.html:3304`) runs for **every bot every frame**, and `simPost`
(~`:2969-2971`) runs `resolveBotPairsHashed` plus `mapCollider.resolveCapsule` for every living bot
every frame. Neither the think stagger nor the rig LOD covers them.

An agent put this at 1.2–1.5 ms and called it the largest item in `sim`. **That figure is an estimate.**
It does not need to stay one: `pre`, `bot` and `post` are already columns in the perf log. The next
take resolves it without any code change.

### 6. `frameProf.beginFrame()` is never called

`frame-profiler.js:67` zeroes the `latest` map each frame; `:127` exports it. `bot-viewer-v2.html`
never calls it — the only `beginFrame` calls in that file are `botBodyBatches.beginFrame()` (`:13297`)
and `botWeaponBatches.beginFrame()` (`:13315`), which are unrelated objects.

**Consequence: any timer that does not run in a given frame reports the previous frame's value rather
than zero.** Conditionally-executed phases carry stale data forward. This is a defect in the
instrument we are using to judge every other item in this document, and the fix is one line.

### 7. About 1.2 ms of the frame loop is outside every timer

Reconciliation: `cpu` 15.6 minus the 14.4 accounted for by named phases leaves ~1.2 ms with no owner.
The unwrapped work is `updateDummy` (which itself calls `stepBotPhysics`), `updateBotAutoAdd`,
`controls.update()`, `updateCameraRig(dt)`, `updateAutoSceneShuffle`, and the FPS/HUD text block
around `:13266-13284`.

This bounds every "small phase" finding: audio, DOM and UI work are competing for that 1.2 ms.

### 8. Smaller confirmed items

| Item | Location | Notes |
|---|---|---|
| `updateNavPathLine` disposes and rebuilds a `BufferGeometry` plus N `Vector3`s **every frame** | `bot-viewer-v2.html:10164-10171` | Only when the nav overlay is visible — **off at defaults**, so it cost nothing in the takes measured. GC pressure, and GC pauses tip frames on a ladder. |
| ~3,150 string `Map.get(geometry.uuid)` per frame in the rig flush | `body-part-batches.js:65` | 126 parts × 25 bots. Cacheable on the geometry object. Small, safe, free. |
| `buildFovWedgeGeometry` mints a unique `BufferGeometry` per bot, rebuilt for every bot on FOV slider change | `bot-viewer-v2.html:3103-3116`, `3193-3196` | 25 unique geometries. Live-tuning churn. Does **not** feed the body-part bucket map. |
| `botVoiceIdentities` Map keyed on `entity.id`, never released on death | `bot-viewer-v2.html:292-296` | Memory only, not iterated per frame. Grows with total bots ever spawned. |
| `panningModel` defaults to `'HRTF'` for every positional source | `environment-audio.js:390` | Real cost, but on the **audio thread** — it will never appear in `cpu` or explain a dropped frame. Fix on its own merits. |
| Static map geometry keeps `matrixAutoUpdate = true` | `bot-viewer-v2.html:523, 601, 618` | Walls, floor slab, terrain. Never move. Tiny but trivially correct. |

---

## Clean bills — do not re-investigate

These were searched for specifically and came back negative. The negative result has value.

- **No per-frame pipeline-breaking material mutations.** Nothing assigns `transparent`, `blending`,
  `depthWrite`, `side`, or swaps `material.map` per frame. Every per-frame material write is a uniform.
- **Light visibility is only touched on toggle**, guarded deliberately at
  `bot-viewer-visuals.js:558-562` with a comment naming the recompile-storm failure mode.
- **Only the sun casts shadows** (`bot-viewer-v2.html:472`); the fill light explicitly declines
  (`:483`, six cube-face passes).
- **The rest of the nav layer is capped.** Recovery flood at 2 cells (`:7373`), flee at 5–10 (`:8030`),
  medic at ~14–18 (`:8619`). Visibility field uses the lazy variant with a row cache. Corner map bakes
  once per map. Unreachable goals are rejected by an O(1) region check.
- **No sample-by-sample audio synthesis.** Voices build WebAudio node graphs and schedule
  `AudioParam` automation, which runs off-thread. The 96k-sample noise buffer is built once and cached.
- **No per-frame `scene.traverse()` outside the renderer**, and no per-frame scene add/remove churn.
- **Logging collections are all capped** with FIFO eviction: state records 4,000, trace 20,000, events
  40,000, world health packs 64.
- **`sfxWindows` is not unbounded** — it is keyed on a small aliased set of event names
  (`bot-viewer-v2.html:214-218`), not per shot.
- **No `frameProf` timer-name collisions.** Each name is recorded exactly once per frame.

---

## Disproven — do not re-derive

| Claim | Why it fails |
|---|---|
| CPU and GPU serialise because the loop awaits `renderAsync`, so frame time is `cpu + gpu` ≈ 31 ms | `renderAsync()` is a deprecation warning, `await init()`, then a synchronous `render()` — it never waits on the device queue. `cpu` is sampled *after* the await so it already includes render. And measured `dt` is 18.7 ms, not 31. |
| The rig flush uploads full instance buffers every frame | `body-part-batches.js:117-121` bounds every upload to `[0, count)` via `setUpdateRange` and skips empty buckets entirely. |
| Batch buckets are multiplied by role (~50–100 buckets) | `bucketFor` keys on `geometry.uuid` alone; role only selects the material at creation. Bucket count = distinct geometry count. |
| Bloom explains the combat-only +8.3 ms GPU | A bloom pyramid runs a fixed number of passes over fixed-size targets every frame. The threshold decides which pixels *contribute*, not how much work is done. Bloom is a candidate for baseline GPU, not for a combat delta. *(Pyramid depth unverified — local `BloomNode.js` is a zero-byte stub and Three.js loads from CDN.)* |
| Audio costs 5–15 ms per frame in firefights | All non-`rnd`/`sim`/`body` phases share ~1.2 ms total. |
| Per-bot capsule and tactical-visual materials are a top draw cost | `bot-viewer-v2.html:2101` sets `botMesh.visible = !botProceduralBodyEnabled` — the capsule is hidden when the rig is on. Tactical visuals default off. ~150 of those material instances are allocated but never encoded. |
| `botEffects` (cap 900) is a scene-object pool costing traversal time | `bot-viewer-v2.html:9860` is a plain array of wire descriptors; the effect renderer is stateless. They never enter the scene graph. *(The real cost there is `effectRenderer.sync()` regenerating sub-particles each frame — different mechanism, lands in `fx3d`.)* |
| The analyser FFT read is unthrottled | `environment-audio.js:1399` early-returns under 4 ms. One read per frame at 60 fps is by design, to dedupe multiple callers. |
| `sel ⊂ senA` nesting is undocumented | The perf-log header states it explicitly: *"sel is inside senA; dTail and dStates are inside senD."* |

Also disproven, both mine: muzzle-flash lights do **not** toggle `.visible` per frame, and wall
`castShadow` flags do **not** add passes (only the sun casts).

---

## Open questions

**Answered by the next take**, now that `draws` and `tris` are logged (`bot-viewer-v2.html:13093`,
`:13148`):

1. **Actual draw-call count, quiet vs combat.** Settles whether the sprite pool dominates `rnd`.
   Every agent estimated this; none measured it.
2. **Actual triangle count.** Settles the tension in finding 2.
3. **`pre` / `bot` / `post` split of `sim`.** Settles finding 5's magnitude.

**Needs a one-line check:** `window.devicePixelRatio` on the test machine. Changes the size of
finding 3 by up to 4×.

**Still unexplained:** switching bot lighting off repeatably saves ~3.5 ms of CPU, almost entirely in
`rnd`. Two hypotheses have been killed (shadow passes, light-visibility recompiles). The remaining
lead is that the same toggle also disables the additive-blended ground-pool and flashlight-cone
instanced meshes. Unproven.

## Found during implementation

**The blood decal pool had finding 1's defect and Phase 2-A fixed it too.** An earlier revision of
this section claimed the pool was left untouched and only mattered outside `bot-viewer-v2.html`.
Both halves of that were wrong. The decal pool is now one instanced draw (`makeDecalPool`,
`effect-renderer.js:232`), with `side: DoubleSide` kept but `forceSinglePass: true` added — so the
old up-to-2x transparent draw count is gone, not merely capped.

It was never a defect confined to other apps either. `bot-viewer-v2.html` calls `spawnHitBloodFx`
on every bullet, knife and blast hit, and `botBloodFxEnabled` defaults to **on** — the damage
simulator's blood work was integrated into the game. The cap is 512, and the splatter count was
returned to the wire default of 10 once the pool became instanced.

**The consumer count in this document was wrong twice.** `effect-renderer.js` has **five** live
consumers, not two (my original count) or four (the plan's): `bot-viewer-v2.html`,
`bot-viewer-v2-camera.html`, `environment-viewer.html`, `environment-viewer-v2.html`, and
`damage-simulator.html`. All of them can exercise the blood kinds.

## Suggested A/B sequence

Each isolates one variable and needs no code change beyond what already exists:

1. Quiet vs firefight, defaults — establishes `draws`/`tris` baseline and the combat delta.
2. Firefight with explosion FX off — isolates the sprite pool.
3. Firefight with `setPixelRatio(1)` — isolates DPI.
4. Firefight with `antialias: false` — isolates MSAA (construction-only, needs a reload).
5. Firefight with bloom strength 0 — isolates post-processing.

Fix `frameProf.beginFrame()` (finding 6) **before** running these, or conditionally-executed timers
will carry stale values into the comparison.
