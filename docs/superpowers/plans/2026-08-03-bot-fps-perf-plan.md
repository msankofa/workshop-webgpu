# Bot FPS Recovery Plan — soldier/armoured model regression (2026-08-03)

**Goal:** Recover the frame rate lost when the bots switched from the default rig (31 parts, 5,068
triangles) to the soldier/armoured procedural bodies (149–168 parts, 95,500–105,852 triangles).
The regression scales with bot count, so every phase below is ranked by how much it wins back per
bot, divided by risk times effort.

**Scope:** the two live bot render paths — `bot-viewer-v2.html` (harness, own flush loop) and
`environment-viewer-v2.html` via `multiplayer.js` `GhostRenderer` — plus the shared modules
`body-part-batches.js` and `player-procedural-body.js`. `environment-viewer.html` (v1) still runs
the old bot system and is out of scope.

**Tech stack:** Three.js r0.184 WebGPU/TSL. Verification uses the existing self-profilers:
`?prof=1` / `?autoprofile=1` in `bot-viewer-v2.html` (`frameProf` timers `sim`, `bodyFlush`,
`weaponFlush`) and the `frame-profiler.js` snapshot wired into `environment-viewer-v2.html`'s perf
log. Node measurements below used the real `three` in `node_modules` (headless, no GPU).

---

## What is actually wrong (verified 2026-08-03)

These are the established facts. Each was either measured by the orchestrator's anchor audit or
re-measured in Node while writing this plan.

1. **Triangle volume is the regression, not draw calls.** Instancing was never lost:
   ~89–125 InstancedMesh buckets cover any bot count. But each bot now submits ~19x the triangles
   of the default rig. At 90 bots that is ~8.6 M triangles and ~20 M vertices per frame, with no
   geometric LOD, no per-instance culling (`frustumCulled = false` on every bucket,
   `body-part-batches.js:70`), and in `bot-viewer-v2.html` no distance hide at all (grep confirms
   zero `hideD2`/`bodyHidden` hits). *Measured.*
2. **The `rbox` armour primitive carries most of it.** Its default tessellation (`seg = 3`,
   `player-procedural-body.js:1031-1058`) makes every plate, pouch and strap 828 triangles.
   Parts at exactly 828 triangles are 66% of the soldier's total and 76% of the armoured's.
   `seg = 1` is 156 triangles for the same silhouette; a far bot could drop from ~96 K to
   ~44 K (soldier) or ~36 K (armoured) triangles by swapping only the rbox pieces. *Measured
   in Node; the on-screen difference is a softer chamfer highlight, which is a user call.*
3. **The flush matrix walk is redone even when nothing moved.** `flush(pool, refreshMatrices)`
   (`player-procedural-body.js:1797`) supports skipping `group.updateMatrixWorld(true)`, and the
   asleep-ragdoll path already uses it. But `bot-viewer-v2.html:12861` and `multiplayer.js:681`
   pass the default `true` for every living bot, including bots whose rig LOD strided the solve
   this frame. Node measurement at 90 bots: the walk costs **4.5 ms/frame (soldier)** and
   **9.3 ms/frame (armoured)** versus 0.76 ms / 2.0 ms without it. The armoured rig's walk is 2x
   the soldier's — its gear-anchor hierarchy is deeper. *Mechanism and Node cost measured; the
   realized browser win depends on what share of bots are on stride 2/4, so the in-game number is
   inferred, roughly 1.5–4 ms at 90 bots.*
4. **Uploads are already bounded.** `body-part-batches.js` sets update ranges to the live count
   before `needsUpdate`, so the 8192-per-bucket capacity is a ~64 MB memory cost, not a per-frame
   upload cost. Scout 1's "2–4 ms strided upload" claim has the wrong mechanism; the real cost is
   item 3 above.

---

## Phases

Ordered by expected win over risk times effort. Phases 0–2 do not change how the bots look.
Phase 3 changes their look at a distance and Phase 5 changes it up close; both default OFF and
wait for the user's eyes.

### Phase 0 — Baseline captures (no code)

Record, at a fixed seed and 90 bots, `?prof=1` numbers in `bot-viewer-v2.html` (FPS, `sim`,
`bodyFlush`, `weaponFlush`, render ms) and the equivalent frame-profiler snapshot in
`environment-viewer-v2.html`. Capture once per body kind: the body-kind switch
(`setBotBodyKind`, already in both viewers' UI) gives a free A/B against the old look and
confirms the regression locally before any change lands. Every later phase compares against
these files.

### Phase 1 — Skip the matrix walk on strided flush frames

**What:** when a bot's rig LOD strided the IK solve this frame, flush with
`refreshMatrices = false` so `group.updateMatrixWorld(true)` is skipped and last frame's
matrices are re-emitted unchanged. Implement the dirtiness inside the body rather than trusting
callers: `update()` and `setRagdollPose()` set an internal `_poseDirty`; `flush()` refreshes when
the caller's hint OR the dirty flag says so, then clears it. That way a pose write from any path
(death edge, stance change) can never render one stride late. Tint is unaffected — colors are
read fresh at every `add()`.

**Files:** `player-procedural-body.js` (dirty flag in `flush`/`update`/`setRagdollPose`),
`bot-viewer-v2.html:12861` (pass the per-actor solved-this-frame hint), `multiplayer.js:676-681`
(pass `false` on the strided branch of `_updateProceduralBodyLod`).

**Flag:** `?flushlod=0` disables (always refresh, current behavior). Default ON — by
construction the emitted matrices are identical, so there is nothing visual to lose.

**Expected win:** the walk is 4.5–9.3 ms/frame at 90 bots in Node (measured). Realized win is
that cost times the strided share — inferred 1.5–4 ms at 90 bots, more when the camera is far
from the fight and most bots sit on stride 4.

**Verify:** `bodyFlush` timer in `?prof=1` with the flag on vs off, same seed. It should drop
visibly and the bots should be pixel-identical.

**Risk:** a pose writer that bypasses `update()`/`setRagdollPose` would freeze one stride. The
internal dirty flag is the mitigation; reviewer should grep for any other code that moves the
rig's `Object3D`s directly.

### Phase 2 — Behind-camera instance cull at flush time

**What:** skip a bot's body (and harness weapon-batch) flush entirely when it is behind the
camera plane by a generous margin. The pools are immediate-mode — an unflushed body simply is
not drawn this frame. Safe because the buckets have `castShadow = false` (verified,
`body-part-batches.js:71`), so no shadow pops. Never cull the focused/POV bot or anything within
a small radius of the camera, and use a margin wide enough that fast turns cannot beat it.

**Files:** `bot-viewer-v2.html` (flush loop ~12857-12871, covers `botBodyBatches` and
`botWeaponBatches`), `multiplayer.js` (`_updateProceduralBodyLod`, plus a `getCameraForward`
option next to the existing `getCameraPos`), `environment-viewer-v2.html` (pass the forward
getter at the three `GhostRenderer` construction sites, lines ~734/742/786).

**Flag:** `?botcull=0` disables. Default ON — off-screen geometry has no look to change. One
caveat: in `environment-viewer-v2.html`, a bot behind the camera also disappears from water
reflections for that frame. If the user notices it on the lake shore, the flag turns it off.

**Expected win:** view-dependent. In a firefight roughly a third to a half of bots are outside
the view direction, so the same fraction of the ~8.6 M triangles and of the residual flush cost
goes away. Estimated 1–3 ms at 90 bots; no measurement exists yet, which is what the A/B flag is
for.

**Verify:** `bodyFlush` + render ms + FPS with the flag on vs off while orbiting a large fight.
`stats.instances` in the pool drops when facing away.

**Risk:** visual only at screen edges if the margin is too tight; start generous (cull only
strictly behind, ~120% of the half-FOV) and tighten with the profiler open.

### Phase 3 — Far LOD for the rbox armour primitive (changes the look — user decides)

**What:** register a `seg = 1` twin for every rbox geometry in the shared geometry cache
(`gearGeometry`, `player-procedural-body.js:1014`), and have `flush()` emit the twin for bots
beyond a distance threshold. Only rbox pieces swap; lathes, domes and faces keep their authored
tessellation. Bucket count grows by the number of distinct rbox geometries (bounded by ~40 per
kind); draw calls stay flat in bot count.

**Files:** `player-procedural-body.js` (twin cache + LOD pick in `flush`), `bot-viewer-v2.html`
and `multiplayer.js` (pass camera distance into `flush`, both already compute `d2`).

**Flag:** `?rboxlod=1` enables, default OFF. Threshold tunable via `?rboxlodDist=25` (meters).
This is the one big fix that alters bot appearance: beyond the threshold, chamfer highlights on
armour plates flatten. At 25 m a 10 cm plate spans a few pixels, so the difference should be
sub-pixel, but the user has art-directed these bodies and flips the default only after looking.

**Expected win:** far bots drop from ~96 K to ~44 K (soldier) / ~36 K (armoured) triangles —
those ratios are measured in Node. The frame-time win depends on how GPU-bound the scene is;
estimated 2–5 ms at 90 bots at range, near zero in a close-quarters maze where every bot is
inside the threshold.

**Verify:** render/GPU ms and FPS with the flag on vs off from a far vantage in the open-terrain
map; screenshot comparison at the threshold distance for the user's approval.

**Risk:** visible LOD pop at the threshold if it is too near. Mitigate with the distance flag and
per-bot hysteresis (swap distance differs by ±2 m for enter/exit).

### Phase 4 — Distance hide for `bot-viewer-v2.html`

**What:** port the `hideD2` gate the env viewer already has (`environment-viewer-v2.html:724`,
240 m) into the harness flush loop. In the maze this changes nothing (the map is smaller than the
threshold); in the open-terrain workspace it stops fully invisible-in-fog bots from submitting
~96 K triangles each.

**Files:** `bot-viewer-v2.html` (flush loop; reuse the existing per-actor distance the rig LOD
computes).

**Flag:** `?bothide=240` sets the hide distance in meters; `?bothide=0` disables. Default 240,
matching the env viewer, which is no visible change on current maps.

**Expected win:** zero in the maze, real but unmeasured in open terrain. Estimated.

**Verify:** pool `stats.instances` and FPS at a far overlook in open terrain.

**Risk:** none at the default distance; the env viewer has shipped the same gate for weeks.

### Phase 5 — Free wins, one commit

Small, verified, zero-visual-risk items that do not deserve phases. No flags — each is a
hoist/pooling change where a toggle would cost more than the fix.

1. Pool the per-frame `botPoses`/`players` arrays in `environment-viewer-v2.html:681-687`
   (three array allocations plus one object literal per bot per frame — scales with bot count).
2. Gate `updateCombatHud` (`environment-viewer-v2.html:11793-11803`) behind a change signature,
   the same pattern `updateReticle` already uses at line 11785, and reuse one `localHudState()`
   result for both.
3. Hoist `Object.keys(DEFAULT_GPU_PREFIXES)` out of `frame-profiler.js:66-68`'s `beginFrame`.
4. Drop the batch pool default capacity from 8192 to 2048 at both construction sites
   (`bot-viewer-v2.html:1918`, `multiplayer.js:748`) — recovers ~48 MB of instance-matrix
   allocation. Guard: `stats.dropped` must stay 0 at max bot count; the heaviest bucket holds
   roughly a dozen instances per bot, so 2048 covers 90+ bots with margin.

Combined expected win: under 0.5 ms plus GC pressure and memory; estimated. These land first or
last, whenever convenient — they exist to be done, not to be measured.

---

## What we are NOT doing and why

- **Per-frame LOS confirm ray and target-scan raycasts** (`bot-viewer-v2.html:5698-5772`,
  `environment-viewer-v2.html:5933`). Real bot-count-scaling CPU, but already staggered
  (acquisition scans every 4th frame, nearest-first with early break) and the per-frame confirm
  ray is deliberate harness parity. It predates the model switch, so it is not the regression,
  and touching it changes perception timing — an AI-behavior decision, not a render fix.
- **Scout 3's territory (lights, shadows, post-FX, particles).** Verified and agreed: the sky
  dome is already depth-rejected via `renderOrder 1000`, the froxel buffer is static VRAM, the
  zero-intensity flash lights are a deliberate recompile-avoidance pattern. No work invented
  here.
- **Forest draw-call consolidation** (scout 4). Constant cost, unverified 2–5 ms estimate, and a
  structural refactor of `forest-gpu.js`. Not part of the bot regression; belongs in a world-perf
  plan if profiling ever shows it.
- **Water reflection fallbacks** (scout 4). Already throttled and gated by the July 8 perf plan.
- **Creature batch culling/upload** (scout 4). Live counts are 2–8 creatures; noise at that scale.
- **Reducing `hideD2` below 240 m in the env viewer.** It would help, but bots visibly vanishing
  is a look change with a cheaper alternative (Phase 3).

## Scout findings cut, with reasons

- Scout 1: water `camera.updateMatrixWorld()` (one matrix compose, microseconds — and removing it
  carries a small ordering risk for zero win), third-person `weaponRig.updateMatrixWorld` (v1
  local player only; the v2 bot mounts already stride and hide, verified at
  `environment-viewer-v2.html:12882-12897`), `remoteClaudecraftPlayers` pooling and
  `ccDebugMesh` gating (microseconds, partly debug-only), sky/cloud follow thresholds (the cited
  lines are a handful of vector assignments; the 0.3–0.5 ms estimate has no basis). The strided
  upload finding was a duplicate of anchor item 3 and is merged into Phase 1.
- Scout 2: FOV wedge rebuild — misread twice; it rebuilds once per tier *change*, not per frame,
  and only for the focused bot's debug overlay (`fovVisible` requires
  `emitsFocusedBotDiagnostics`). Enemy-list rebuild — already pooled (`_frameEnemyArrays`
  reused, verified at 2757-2771). Alert ring scans — ring is capped at 64 entries, tens of
  microseconds. Insertion sort and `Math.hypot` — noise, as the scout itself half-admitted.
- Scout 5: audio listener and shadow-light `Vector3` allocations (10–50 µs, noise), debug
  strings and perf-log snapshots (debug-only or already throttled). The HUD write and profiler
  `Object.keys` survive as free wins.

## Where the reports disagree

- Scout 1 attributed 2–4 ms to "instance matrix upload" on strided frames. Wrong mechanism:
  uploads are range-bounded (`body-part-batches.js:84-92`). The cost is the `updateMatrixWorld`
  tree walk, and it is bigger than the scout guessed (4.5–9.3 ms at 90 bots in Node).
- Scout 1's citation `multiplayer.js:602-606` for the ghost-update allocations is stale; the
  code is at `environment-viewer-v2.html:681-687`.
- Scout 2's raycast finding claimed 5–10 rays per scan; the code already breaks on the first
  clear ray and staggers scans, so typical cost is far lower than claimed.
- Scout 4's bot-LOS finding cites `environment-viewer.html` v1 code (`BOT_LOS_CHECK_INTERVAL_MS`)
  that does not exist in v2 — dead path for this regression.
- Scout 3 said its territory needed nothing; verification agrees.

## Results

(filled in per phase; every row from the same seed, bot count, and vantage as Phase 0)

| Capture | FPS | sim ms | bodyFlush ms | render ms | Flags |
|---|---:|---:|---:|---:|---|
| Phase 0 baseline (soldier, 90 bots) | | | | | none |
| Phase 0 baseline (armoured, 90 bots) | | | | | none |
| Phase 0 reference (default rig) | | | | | body kind switch |
| After Phase 1 | | | | | `?flushlod=0` for the off leg |
| After Phase 2 | | | | | `?botcull=0` for the off leg |
| Phase 3 trial | | | | | `?rboxlod=1&rboxlodDist=25` |
| After Phase 4 (open terrain) | | | | | `?bothide=0` for the off leg |
