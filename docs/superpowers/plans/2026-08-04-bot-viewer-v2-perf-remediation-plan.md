# bot-viewer-v2 performance remediation plan

**Date:** 2026-08-04
**Input:** `docs/superpowers/reviews/2026-08-04-bot-viewer-v2-perf-findings.md` (the verified findings
list). The Disproven section of that document is binding: no work below rests on a disproven premise.
The Clean Bills are settled: no phase below re-investigates them.
**Execution model:** two implementation agents run concurrently with **disjoint file ownership**
(§ Workstreams). Browser QA and all Y-key perf takes are run by the project owner, not the agents.

## Baseline the plan is ranked against

697-frame take, ~25 bots, near-constant combat, defaults: `cpu` median 15.6 ms against a 16.7 ms
60 Hz vsync budget; `rnd` 7.3 / `sim` 4.6 / `body` 2.5; everything else shares ~1.2 ms. Combat adds
+9.1 ms of which **+8.3 is GPU** with `sim` unchanged. The app sits on a vsync ladder, so savings
(and jitter) pay off nonlinearly.

Measured-vs-assumed discipline: each phase below is tagged **[measured]** (the baseline already
shows the cost in a named column) or **[assumed]** (mechanism confirmed in code, magnitude not yet
measured). Assumed items get a STOP/MEASURE gate before any large rebuild.

## Ground truths found while planning (all verified against source)

- `frameProf.beginFrame()` (`frame-profiler.js:67-70`) zeroes only `DEFAULT_NAMES` /
  `DEFAULT_GPU_NAMES` — the **environment viewer's** pass names (`grassGpu`, `forestGpu`,
  `cdlodGpu`, `postRender`…). bot-viewer-v2's own timer names are not among them, so merely calling
  it would be a no-op here. The gate fix needs a `frame-profiler.js` semantic change, not one line.
- `effect-renderer.js` is consumed by **four** apps: `bot-viewer-v2.html`,
  `bot-viewer-v2-camera.html`, `environment-viewer.html`, `environment-viewer-v2.html`. Its public
  API can be held frozen, so the sprite rewrite needs zero wiring changes in any HTML.
- `floodFill` (`nav-grid.js:479`) already accepts `maxRadius`, so the unbudgeted nav call is fixable
  entirely inside `bot-viewer-v2.html`. The call is at **`:7708`** (the findings doc says 7677 —
  that reference is stale; 7708 is correct).
- `node_modules/three` is 0.184.0, exactly matching the CDN importmap pin, so Node tests of
  `effect-renderer` exercise the same code version the browser runs.
- A per-distance rbox LOD **inherently** doubles live rbox buckets while the population is mixed
  (near bots fill seg3 buckets, far bots fill seg1). Bucket lifecycle alone does not fix that; only
  a global switch keeps draw count flat. The plan reflects this.

---

## Workstreams — disjoint file ownership

**Workstream A — shared modules.** Owns and is the ONLY editor of:
- `frame-profiler.js`, `test-frame-profiler.mjs`
- `body-part-batches.js`, `test-body-part-batches.mjs`
- `effect-renderer.js`, new `test-effect-renderer.mjs`
- `environment-audio.js` (optional Phase 5 only)
- Docs: `docs/subsystems/infra.md`, `docs/subsystems/fx.md`, `docs/subsystems/multiplayer.md`,
  `docs/subsystems/audio.md`
- `versions/` snapshots of the above.

**Workstream B — the app.** Owns and is the ONLY editor of:
- `bot-viewer-v2.html`
- Docs: `docs/subsystems/bots.md`
- `versions/` snapshots of the above.

Neither agent touches `player-procedural-body.js` or `nav-grid.js` in this pass — everything needed
from them (`setGearLod`, `part.userData.lodGeo`/`_lodParts`, `floodFill`'s `maxRadius` option)
already exists and is called only from files each workstream owns.

**If Workstream A's change would normally deserve a note in `bots.md`, Workstream B writes that
note** (it owns the file); the reverse holds for `fx.md`/`infra.md`/`multiplayer.md`. Each agent
states in its handoff summary what one-line note the other should carry.

**`agent_log.csv` is the single sanctioned shared file.** Append-only by convention: each agent
appends one row per logical change (columns `date,subsystem,files,summary`) as a single append at
the moment the change completes, and never rewrites existing content. Rows are independent, so
interleaved appends are acceptable. `versions/` snapshot names embed source filename + timestamp,
so they cannot collide.

## Seam contracts (agreed up front; both agents code against these without talking)

1. **`frameProf.beginFrame()`** — A changes its semantics from "zero `DEFAULT_NAMES`" to "zero
   **every name recorded so far** on both the CPU (`latest`) and GPU (`gpuLatest`) maps, plus the
   existing defaults". No signature change. B adds exactly one call: the **first statement** of the
   `renderer.setAnimationLoop(async () => { ... })` callback; before any `frameProf.time(...)` is
   mandatory. **Either landing order is safe**: with the current implementation B's call is a
   harmless no-op for bot-viewer's names; with A's change and no call, behaviour is exactly today's.
   Smoothed (`{smooth:true}`) values are intentionally NOT zeroed — the HUD keeps its EMA.
2. **`body-part-batches` bucket lifecycle** — A guarantees, with no API change: (a) a bucket whose
   per-frame `count` is 0 after `endFrame()` is not drawn (`mesh.visible = count > 0`); (b) a bucket
   empty for N consecutive `endFrame()`s (N default 120) is evicted — removed from the scene and
   both lookup maps, its shared geometry **never** disposed — and transparently recreated by the
   next `add()` with that geometry. B's Phase 3 work depends only on (a)+(b), not on any new call.
   `beginFrame()/add()/endFrame()/dispose()/stats` signatures are frozen.
3. **`effect-renderer` API freeze** — `createEffectRenderer({ THREE, scene, terrainHeight,
   maxSegments, maxPoints }) → { sync(list, nowMs), dispose() }` is frozen, including wire-shape
   handling and the GLOW_POOL/SMOKE_POOL caps. Phase 2 is therefore **A-only; B makes zero wiring
   changes**. Blast radius: four consumer apps. Owner QA must include at least one environment
   viewer after Phase 2.
4. **Optional HRTF (Phase 5)** — A adds a `panningModel` option to the environment-audio factory
   with default `'HRTF'` (today's behaviour, so the other consumers are unaffected); B may pass
   `panningModel: 'equalpower'` from bot-viewer-v2 **only after owner sign-off** on the audible
   change. Either landing order is safe because the default preserves current behaviour.

## Conventions both agents follow (repo rules, not suggestions)

- Snapshot each file into `versions/` before significant edits:
  `<name>-before-<desc>-<YYYYMMDD-HHMMSS>.<ext>`.
- Update the owning `docs/subsystems/<name>.md` in the SAME change as the code.
- One row per logical change appended to `agent_log.csv`; rationale goes there, not in comments.
- One-line code comments max.
- No build step; ES modules only. Verify syntax by parsing under Node and by running the flat
  `node test-<name>.mjs` scripts. Never "verify" by opening a browser — that is the owner's job.

---

## Phase 0 — GATE: fix the instrument, install the A/B levers, then measure
*Nothing else in this plan may be judged until this lands. [measured — finding 6 is a code fact]*

**0-A (Workstream A): make `beginFrame()` actually zero this app's timers.**
`frame-profiler.js:67-70` zeroes only `DEFAULT_NAMES`. bot-viewer-v2 records `sim`, `bodyFlush`,
`weaponFlush`, `botFx`, `visuals`, `fx`, `audio`, `panelFx`, `uiA/B/C`, `ui`, `render` — none in
that list. Change `beginFrame()` to zero every key present in `latest` and `gpuLatest` (plus the
defaults, preserving the environment viewers' exact behaviour — they call it at e.g.
`environment-viewer.html:9180`).
- Files: `frame-profiler.js`, `test-frame-profiler.mjs`, `docs/subsystems/infra.md`.
- Risk: low. The environment viewers already call `beginFrame()`; their default names are recorded
  every frame, so iterating keys is a superset of today's loop. Smoothed maps untouched.
- Verify: extend `test-frame-profiler.mjs` — record a custom-named timer, call `beginFrame()`,
  assert the unsmoothed snapshot reads 0 while the smoothed one decays. `node test-frame-profiler.mjs`.

**0-B (Workstream B): call it, and add the construction A/B levers the measurement sequence needs.**
1. `frameProf.beginFrame();` as the first statement of the animation loop callback.
2. Renderer-construction URL params, **all defaulting to today's behaviour** (`:137-141`):
   `?dpr=<n>` → `renderer.setPixelRatio(Math.min(window.devicePixelRatio, n))`; `?msaa=0` →
   `antialias:false`; `?shadowfilter=pcfsoft|pcf|basic` → shadow map type. These are the levers the
   findings' A/B sequence requires and cannot run without (antialias is construction-only).
3. Log `window.devicePixelRatio` to the console at boot AND append it to the Y-log header line
   (`perfLogHeader()`) — the findings flag this unknown as changing finding 3's size by up to 4×.
- Files: `bot-viewer-v2.html`, `docs/subsystems/bots.md`.
- Risk: near zero — defaults preserve behaviour; params are opt-in.
- Verify: parse; owner smoke-checks each param once.

**STOP/MEASURE M0 (owner runs; no agent code):** the findings' A/B sequence —
(1) quiet vs firefight at defaults → `draws`/`tris` baseline + combat delta; (2) firefight,
explosion FX off → isolates the sprite pool; (3) firefight `?dpr=1`; (4) firefight `?msaa=0`;
(5) firefight bloom strength 0. Additionally read the **`pre`/`bot`/`post` columns** (settles
finding 5's magnitude with zero code) and note `devicePixelRatio`.

**Decision table for M0:**
- Combat `draws` delta large (roughly ≥150–200 and tracking the `rnd`/GPU delta) → Phase 2 is GO.
- `tris` ≈ 1.4M+ and the `?dpr`/`?msaa` arms show GPU still over budget after Phase 2's projection →
  Phase 3 is GO.
- `devicePixelRatio` ≥ 1.5, or arm (3)/(4) shows a multi-ms GPU win → Phase 4 default flips go to
  the owner as one-line decisions.
- `bot` + `post` median ≥ ~1.5 ms → record as a NEW finding for a future pass. Physics/collision
  gating (finding 5) is a behaviour change and is **explicitly out of scope for this pass**; the
  finding only obligated us to measure, and M0 does.

---

## Phase 1 — safe structural fixes, no measurement dependency
*All [assumed] but individually small, mechanism-confirmed, and riskless enough not to need a gate.
They also remove GC/jitter sources that would otherwise pollute later measurements.*

**1-A (Workstream A): `body-part-batches.js`.**
1. Kill the ~3,150 string `Map.get(geometry.uuid)` per frame (`:65`): add a
   `WeakMap<BufferGeometry, bucket>` fast path in `bucketFor`; keep the uuid `Map` for
   `dispose()`/stats/eviction bookkeeping. Eviction must delete from both.
2. Bucket lifecycle per seam contract 2: `mesh.visible = (count > 0)` in `endFrame()`; evict after
   N=120 consecutive empty frames (remove from scene + both maps; never dispose the shared
   geometry — `player-procedural-body.js`'s `_sharedBodyGeo` owns it, and `dispose()`'s existing
   comment already says so).
- Files: `body-part-batches.js`, `test-body-part-batches.mjs`, `docs/subsystems/multiplayer.md`.
- Risk: eviction racing a reappearing geometry — covered by "recreated transparently on next
  `add()`"; the WeakMap keys on the object so a recreated bucket re-links. Multiplayer guests keep
  last-frame rendering between network events — eviction counts *frames with `endFrame()` called*,
  so a caller that stops calling `endFrame` keeps its buckets.
- Verify: extend `test-body-part-batches.mjs` — empty bucket hidden after `endFrame`; evicted after
  N empty frames; `add()` after eviction recreates and draws; WeakMap path returns the same bucket
  as the uuid path. `node test-body-part-batches.mjs`. The weapon twin (`weapon-part-batches.js`) is
  intentionally untouched this pass — mirror later if the body-side change measures clean.

**1-B (Workstream B): small confirmed items in `bot-viewer-v2.html` (finding 8).**
1. `updateNavPathLine` (`:10164-10171`): stop disposing/rebuilding a `BufferGeometry` + N
   `Vector3`s per frame. Preallocate a `Float32Array` position attribute (cap ~256 points), write in
   place, `setDrawRange`, `needsUpdate`. Off at defaults, but GC pauses tip ladder frames when on.
2. FOV wedge churn (`:3126-3140`, `:3193-3196`): cache wedge geometry per rounded degree in a
   `Map<deg, BufferGeometry>` shared across actors (scale/rotation are per-mesh already). Remove the
   per-actor `geometry.dispose()` + rebuild.
3. `botVoiceIdentities` (`:292-297`): delete the entry where a bot's actor is torn down. Safe
   because `voiceIdentity(entity.id, team)` is deterministic — a revive gets the identical voice.
4. Static map geometry: `matrixAutoUpdate = false` + one `updateMatrix()` at creation inside `box()`
   (`:511-517`), `instancedBoxes()` (`:523-536`), and the terrain mesh (`:616-618`). `applyLayout`
   tears down and rebuilds, so nothing static ever moves after creation.
5. Nav insurance (finding 4, lowest priority here): `choosePatrolResumeGoal`'s
   `floodFill(navGrid, start, {})` (**`:7708`**) is the one nav call outside the frame budget. Gate
   it on `replanBudgetLeft` (charge several units — it is worth several A*s) and reuse the
   per-entity `nextReplanAt` cooldown; on refusal return null and let `finishInvestigation` retry
   next think tick (its four triggers are all retry-tolerant). Optionally also pass a `maxRadius`
   (`nav-grid.js:479` already supports it — no module change) sized to the active bounds, so the
   cost ceiling scales with the map on purpose rather than by accident. Insurance against map
   growth, not a present-tense win — do not expect it in the numbers.
- Files: `bot-viewer-v2.html`, `docs/subsystems/bots.md`.
- Risk: items 1–4 near zero. Item 5's risk is a patrol-resume goal arriving a few hundred ms later;
  acceptable by design (the same throttle every other nav call lives under).
- Verify: parse; owner QA (nav overlay on, FOV slider drag, medic revive, patrol resume after
  combat). No Node test targets exist for these in-file paths; the perf log's `gap` column is the
  regression watch for the GC items.

---

## Phase 2 — sprite pool instancing (the headline) — GATED ON M0
*[assumed, but the leading candidate]: finding 1 is the only mechanism found that is large,
render-side, and combat-scaled, matching both `rnd` 7.3 ms and the +8.3 ms combat GPU delta.
Proceed only if M0 shows the combat `draws` delta is real (decision table).*

**2-A (Workstream A only): rewrite the two sprite pools in `effect-renderer.js` (`makePool`,
`:92-112`) as two `InstancedMesh` pools** — one additive (glow, cap `GLOW_POOL`=220), one
normal-blend (smoke, cap `SMOKE_POOL`=260, `fog` on). Per-instance data replaces the 480 per-sprite
materials: position/scale via `instanceMatrix` (billboarding in the material — `SpriteNodeMaterial`
under the node system, or a small TSL billboard on a plane if `SpriteNodeMaterial` + instancing
misbehaves at r0.184; decide by test, not by hope), RGB via `instanceColor`, alpha via one
`InstancedBufferAttribute` float wired into `opacityNode`. `sync()` uploads once with `count` = live
sprites, exactly like the existing lines/points buffers in the same file. Lines/points pools are
untouched.
- Expected effect: hundreds of transparent-pass draw calls + bind groups + the two-pipeline
  alternation collapse to 2 draws. This attacks `rnd` (CPU encoding) directly; the GPU *fill* cost
  of the same pixels remains — if M1 shows GPU still high with draws collapsed, that residue is
  overdraw/bloom, measured separately by M0 arm (5).
- Files: `effect-renderer.js`, new `test-effect-renderer.mjs`, `docs/subsystems/fx.md`.
- Risks: (a) smoke is order-dependent under normal blending and loses Three's per-sprite depth
  sort — mitigate with an optional camera-distance sort of the smoke instance write order inside
  `sync()` if owner QA sees popping; glow is additive and order-independent. (b) `SpriteNodeMaterial`
  instancing support at r0.184 — the fallback (plane + TSL billboard) is part of the phase, not a
  surprise. (c) four consumer apps (seam contract 3) — API frozen, owner smoke-tests an environment
  viewer too.
- Verify: `test-effect-renderer.mjs` under plain Node (imports `three/webgpu` from node_modules,
  stub `scene = { add(){}, remove(){} }`): synthetic wire lists (explosion, muzzle, tracer,
  smoke_puff, hit_spark) → assert instance counts, pool caps respected, counts zero after an empty
  sync, `firstSeen` sweep unchanged. Then owner: firefight Y-take.

**STOP/MEASURE M1 (owner):** repeat M0 arms (1)–(2). Success = combat `draws` collapse by the sprite
population, `rnd` down materially, and part of the +8.3 GPU delta gone. If `draws` barely move, the
attribution was wrong — stop and re-read M0 arm (2) before touching anything else.

---

## Phase 3 — armour triangles: bucket-lifecycle-aware rbox LOD — GATED ON M0/M1 `tris`
*[assumed]: 828→156 tris per rbox piece is documented in code
(`player-procedural-body.js:30-32, 1181-1187`), but the earlier A/B **lost** (gpu 11.3→15.7) because
buckets were keyed on `geometry.uuid` and never evicted — the seg=1 twins ADDED buckets.
**Do not plan a new LOD; the machinery exists** (`part.userData.lodGeo`, `_lodParts`, `setGearLod`,
and the viewer's existing `?rboxlod=1` distance bands at `bot-viewer-v2.html:2685-2710`). This phase
is a policy change on top of Phase 1-A's lifecycle.*

Open tension to respect: per-distance LOD **inherently** runs both variants at once while the
population is mixed, so even with empty buckets hidden the mixed case still roughly doubles rbox
draws. Only a **global** switch keeps the draw count flat while cutting `tris` ~44K→~8K per bot of
armour. The `tris` column decides whether triangles matter enough to spend on this at all.

**3-B (Workstream B only):** add a global mode to the existing toggle: `?rboxlod=2` (and a third
state on the existing panel button) = `setGearLod(1)` on every bot unconditionally. Seg3 buckets
empty out → hidden immediately (contract 2a) → evicted after N frames (2b): `draws` flat, `tris`
down. Keep the existing per-distance mode as `?rboxlod=1` for the comparison arm. **Default stays
OFF** — the seg=1 twin visibly flattens chamfer highlights, pending owner sign-off.
- Files: `bot-viewer-v2.html`, `docs/subsystems/bots.md`.
- Risk: purely visual; mechanically one existing call per bot. Depends only on seam contract 2 (may
  land before A's lifecycle ships — the mode then simply reproduces the old backfired arithmetic
  until A lands, which is why the default is off).
- Verify: parse; owner A/B firefight takes at `rboxlod=0/1/2` reading `tris`, `draws`, `gpu`, `body`,
  `rnd`. **STOP/MEASURE M2:** flip any default only on measured win + owner visual sign-off.

---

## Phase 4 — fill-rate defaults (finding 3) — owner decision after M0
The three one-line levers (`:137-141`: MSAA on, full `devicePixelRatio`, PCFSoft shadows) compound
multiplicatively and are pure GPU. Phase 0-B made each independently testable. This phase is just
flipping whichever default the M0 arms proved out (e.g. cap DPR at 1.5, PCF instead of PCFSoft) —
Workstream B one-liners, owner-decided. No agent flips a visual default without the M0 number and
owner sign-off. Files: `bot-viewer-v2.html`, `docs/subsystems/bots.md`.

## Phase 5 — optional, own-merits items (either workstream, idle time)
1. **HRTF → equalpower option** (finding 8; audio thread — will never show in `cpu`; fix on its own
   merits only): seam contract 4. A: `environment-audio.js` + `audio.md`; B: the one-line opt-in +
   `bots.md`. Owner listens before it stays.
2. **`misc` timer** (finding 7): B wraps the ~1.2 ms of unwrapped loop work (`updateDummy`,
   `updateBotAutoAdd`, `controls.update()`, `updateCameraRig`, `updateAutoSceneShuffle`, HUD text
   block) in `frameProf.time('misc', ...)` and appends a `misc` column **at the end** of
   `PERF_LOG_COLS` — the summary indexes rows positionally, so appending is the documented safe way;
   mid-row insertion silently re-points every `line()` call. Makes `cpu` reconcile in future takes.
3. **The unexplained 3.5 ms bot-lighting toggle** stays a measurement question, not planned work:
   the M0/M1 takes with lighting toggled now carry `draws`, which tests the remaining hypothesis
   (additive ground-pool / flashlight instanced meshes) for free.

---

## What is deliberately NOT in this plan
- Anything from the Disproven list (renderAsync serialisation, full-buffer uploads, role-multiplied
  buckets, bloom-as-combat-delta, audio milliseconds, capsule material cost, botEffects scene churn,
  FFT throttling).
- Re-investigation of any Clean Bill area.
- Physics/collision think-stagger gating (finding 5): measured in M0, acted on only in a future pass
  if `bot` + `post` justify it.
- A new LOD system, geometry rebuilds, or `player-procedural-body.js` edits.
- Node tests pretending to verify rendering: they verify pool arithmetic, lifecycle and API
  contracts; frame-truth comes from the owner's Y-key takes and eyes.

## Execution order at a glance
```
A: 0-A ──► 1-A ─────────► 2-A ──► (5.1 optional)
B: 0-B ──► 1-B ──► (wait M0) ──► 3-B ──► 4 ──► (5.2 optional)
owner:      M0 ◄─ gate ─┘   M1 after 2-A,  M2 after 3-B
```
Phases 0 and 1 have no cross-workstream ordering constraints (seam contracts are order-safe).
Phase 2 needs M0; Phase 3 needs M0/M1 plus contract 2 landed; Phase 4 needs M0.
