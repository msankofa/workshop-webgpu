# Bot port — senior review, root-cause verdicts, and implementation plan

Reviewer pass over the five investigation docs in this directory. Every major claim was
re-checked against the current tree (`sp1-webgpu-renderer-migration`); line numbers below are
mine, verified today, not copied from the agent docs. Two claims are refuted, one hypothesis is
reversed, and one new finding (missed by all five agents) is identified as the primary cause of
Bug #1.

---

## A. Verified findings

Legend: **CONFIRMED** (re-read the code, claim holds) / **REFUTED** (code contradicts the claim) /
**PARTIAL** (mechanism real, attribution wrong) / **NEEDS-BROWSER-CHECK** (static analysis cannot
settle it).

### Agent 1 (arm/weapon rendering)

| Claim | Verdict | Evidence |
|---|---|---|
| Render path: bot → `toWirePose` → `GhostRenderer._updateProceduralBody` → `createProceduralPlayerBody` + separate bot weapon-mount layer | CONFIRMED | `environment-viewer.html:587-596`, `multiplayer.js:528-580`, `environment-viewer.html:7743-7943` |
| Mount code is a structurally faithful copy of `bot-viewer.html`'s | CONFIRMED | `createEnvironmentBotWeaponMount` (`environment-viewer.html:7769-7846`) vs `createBotWeaponMount` (`bot-viewer.html:409-481`); `updateEnvironmentBotWeaponMount` (`:7894-7939`) vs `updateBotWeaponMount` (`bot-viewer.html:483-523`) — near line-for-line |
| Yaw pipeline algebraically identical to harness | CONFIRMED | `bot-entity.js:69-76` bakes `bot.yaw + π` into the wire quat; `multiplayer.js:562-563` recovers it via atan2; `player-procedural-body.js:974` adds `+π` — same value `bot-viewer.html:603` feeds directly |
| **Hypothesis 1 (top-ranked): async mount build fails silently, no retry backoff → primary cause of invisible arms** | **PARTIAL — mechanism CONFIRMED, attribution REFUTED** | The backoff asymmetry is real: local path arms `lbWeaponMountRetryAfter = now + 800` on failure (`environment-viewer.html:7676-7679`) and gates re-requests (`:9176`); the bot path re-requests every frame with no cooldown (`:7903-7906`, dedup at `:7848-7856` only covers in-flight). **But a missing mount cannot produce the reported symptom**: with no controller, `arm.target` is null and `solveArm` renders the *visible* idle hang pose (`player-procedural-body.js:903-904`, idle targets `:1184-1185` — hands ~0.5 m down-and-out from the shoulders, outside the torso). And the observed reload animation requires a live controller (`weapon-pose-controller.js:247-283`), which requires a resolved mount. The mount **is** resolving; the failure is elsewhere. Also, m1911 (the default `botWeaponId`, `environment-viewer.html:1647`) has a tuned `thirdPersonHold` (`weapons.js:48-83`) and valid anchors — there is no static reason for the build to fail. |
| Hypothesis 3: coordinate-space bug — "ruled mostly out" | **REVERSED — this is the primary cause; see §B and the new finding below.** Agent 1 traced yaw, parenting, and visibility flags but never checked the **Y reference frame** of the weapon rig. |
| No bot-mount debug surface (vs `lbDebug` HUD `environment-viewer.html:9217-9233`) | CONFIRMED | Nothing reads `botVisualWeaponMounts` state at runtime |

### NEW FINDING (missed by all five agents) — the weapon rig Y is pinned to the harness's flat floor

- The **local player's** third-person mount is terrain-relative:
  `weaponRig.position.set(_lbPos.x, terrainHeight(_lbPos.x, _lbPos.z) + 1.5, _lbPos.z)` with the
  explicit comment "Rig stays at **terrain**+1.5 in every stance" (`environment-viewer.html:9188-9190`).
- The **bot** mount instead caches `bodyMountOffsetY = 1.5 - torso.position.y` once, then places the
  rig at `torso.position.y + bodyMountOffsetY` (`environment-viewer.html:7912-7913`), copied verbatim
  from `bot-viewer.html:494-497`.
- `torso.position.y` is **world-space and includes terrain height**: `pelvisY = groundY + height*ratio`
  where `groundY = terrainHeight(pos.x, pos.z)` (`player-procedural-body.js:1035-1045`), torso at
  `pelvisY + height*0.22` (`:1136-1141`). GhostRenderer passes the **real** terrain sampler
  (`environment-viewer.html:633, 638, 678`).
- Algebra: `weaponY(t) = torsoY(t) + (1.5 − torsoY(capture)) = 1.5 + bob + (terrainY(t) − terrainY(capture))`.
  I.e. **at the capture spot the rig sits at absolute y ≈ 1.5 regardless of terrain height**. In
  `bot-viewer.html` this is invisible because its body is built with `terrainHeight: () => 0`
  (`bot-viewer.html:540`) and its floor is y=0 — absolute 1.5 *is* floor+1.5 there. On any
  environment map where bots stand at terrainY ≠ 0, the weapon rig (gun model, muzzle/grip markers,
  and therefore **both arm IK targets**, which the controller resolves from `weaponView`'s world
  transform — `weapon-pose-controller.js:334-352`) is displaced downward by the full terrain height.
- Symptom chain, matching the bug report exactly:
  - Gun renders metres under the ground → **weapon invisible**.
  - Both hands chase grips metres below the shoulders; `solveTwoBone` reach-clamps toward the
    target (`player-procedural-body.js:854-870`), so the arms drape straight down along the body
    column (grip XZ ≈ torso XZ), largely hidden inside the torso/pelvis/leg meshes → **"no arms"**.
  - During reload, the sequence's left-hand keys are **body-relative** (`beltMagazine`,
    `{ body: [...] }` — resolved against `body.rootAnchor` at chest height,
    `weapon-pose-controller.js:347`, `player-procedural-body.js:1049-1051`), so the left arm
    animates at the chest → **"arms visibly move inside the torso during reload"**.
  - `botFire` uses the capsule eye as the shot origin (`environment-viewer.html:1930-1935`) →
    **"bullets still fire"** — but `tracerOrigin = environmentBotWeaponMuzzle(id)` (`:1931`), so
    **tracers should visibly originate from under the ground** — a free confirmation signal.
- Status: **NEEDS-BROWSER-CHECK to confirm, but the code evidence is conclusive** and the fix
  (terrain-relative Y, matching `:9190`) is correct-by-construction on flat maps too. Console probe:
  `[...botVisualWeaponMounts][0]?.[1].weaponRig.position.y` vs the bot's `capsule.start.y`. If the
  repro was on shoot-house (floor y=0) this theory fails there and the retry/backoff path moves back
  up — but shoot-house's flat floor makes it the one map where the current code is coincidentally
  correct.

### Agent 2 (performance)

| Claim | Verdict | Evidence |
|---|---|---|
| Bot FSM/nav/physics is cheap; **rendering is the cost** | CONFIRMED | Whole call graph re-read; LOS raycast throttled to 120 ms/bot (`environment-viewer.html:1898-1915`), physics is one capsule resolve (`bot-entity.js:41-59`) |
| Per-bot unshared body rig: 4 fresh `MeshStandardMaterial`s + fresh geometry per body | CONFIRMED | `player-procedural-body.js:538-543` (materials), `:545-580` (geometry closures, no cache anywhere in file) |
| "~18-20 meshes per body" | CONFIRMED, but **undercounted** | Actual: 5 torso-stack + 2 eyes + 2×6 leg (upper/lower/hip/knee/ankle/foot, `:668-682`) + 2×6 arm (upper/lower/shoulder/elbow/wrist/hand, `:685-706`) = **31 meshes/body**. 30 bots ≈ 930 body draw calls + weapon subtrees. Worse than claimed. |
| "4 independent 12-iteration FABRIK chains, up to 48 FABRIK iterations per bot per frame" | **REFUTED** | `KinematicChain.solve()` is **never called** in `player-procedural-body.js` (grep: zero `.solve(` matches). `solveLeg`/`solveArm` use the **analytic** `solveTwoBone` (`:854-870, :882, :920`) — constant, cheap. The FABRIK class (`:454-512`) is dead code; only its `lengths` are read. Per-frame IK is NOT the dominant bot cost; mesh/material/draw-call multiplication and GC churn are. |
| Per-frame allocations inside `update()` at lines 1169/1170/1184/1185/1195 | CONFIRMED | 6 fresh `Vector3` per body per frame; idle vectors `:1184-1185` are loop-invariant constants |
| Per-bot uncached `GLTFLoader().loadAsync` for weapons | CONFIRMED | `environment-viewer.html:7796-7798`, uses `gltf.scene` directly, no cache, no `skeletonClone` — while `lbWeaponModelCache` + `skeletonClone` sit 90 lines up (`:7609, :7699-7712`) |
| Double `controller.update()` while aiming; fresh `Euler` per frame | CONFIRMED | `:7934-7937` (second call after barrel alignment); **two** Eulers per bot-frame, not one (`:7918` and `:7920`); plus `capsule.start.clone()` at `:7909` and Vector3/Quaternion allocs in `alignEnvironmentBotWeaponToPoint`/`environmentBotMountedBarrelRay` (`:7859-7884`) |
| "Second full IK pass" (weapon controller) | PARTIAL | `controller.update` is target-resolution + hand-glide + `setArmTarget` (`weapon-pose-controller.js:215-352`) — the actual limb solve happens once, in `body.update`. Real per-bot cost (matrix flattening, `asRoot` object allocs `:334-338`, fresh `Euler` `:322`) but not a second solver. |
| `propagateBotAlert` O(N) scan every tick a target is visible | CONFIRMED | called unconditionally at `environment-viewer.html:2254`; loop `:1951-1958` |
| `pushBotsApart` O(N²) + fresh array per tick | CONFIRMED | `:1991-2021`; fresh filtered/mapped array `:1992-1994`; comment `:1987-1989` assumes n≤10 |
| `requestBotPath` rebuilds a ~24×24 local A* window per request on non-shoot-house maps | CONFIRMED | `:2063-2074`; radius 18 / cell 1.5 (`:1683-1686`); deliberate tradeoff per comment `:2042-2048`, mesh-blocked cells session-cached (`:1697-1713`) |
| `updateHostPlayerGhosts` + `toWirePose` alloc per bot per frame | CONFIRMED | `:591-593` (array + spread objects); `bot-entity.js:72, 75-76, 82` (clone + 3 arrays); also `multiplayer.js:550, 567, 573` (pos object + 2 Vector3 per body per frame) |

### Agent 3 (bot-viewer original)

Documentation-grade and spot-check-verified where load-bearing: single hardcoded bot, no
budgeting/throttling anywhere (structural fact of the file), `terrainHeight: () => 0` for the
body rig (`bot-viewer.html:540` — **the** fact that hid the Y bug), yaw conventions and
`toWirePose`'s `+π` (`bot-entity.js:64-76`), harness-only features the port dropped
(muzzle-recovery, staged search episodes, pursue/flee wiring differences). CONFIRMED / accepted.
No claims in this doc affect the two bugs' root causes.

### Agent 4 (env-viewer wiring)

| Claim | Verdict | Evidence |
|---|---|---|
| No mode flag, no adapter, ~1,700 lines inline; bots ride `GhostRenderer` | CONFIRMED | `environment-viewer.html:1634-2598` + `:7743-7943`; comment `:1638` "drag and drop" |
| Cache+`skeletonClone` pattern exists for local player, not reused for bots | CONFIRMED | `:7609/:7699-7712` vs `:7796-7798` |
| No throttled retry on failed/slow bot mount | CONFIRMED | `:7903-7906` vs `:7676-7679/:9176` |
| "Invisible arms/weapons: both downstream of the mount never resolving" | **REFUTED as primary** | Same reasoning as Agent 1 H1: a missing mount yields visible idle-hang arms and no reload animation. The mount resolves; the rig is mis-positioned (see New Finding). The no-backoff gap remains a real robustness defect (transient unarmed windows, and a per-frame GLTF reload loop if a load ever does persistently fail). |
| Creature bridge contrast (adapter, shared geometry, instancing, LOD) | CONFIRMED | see Agent 5 row below |
| Yaw parity harness↔port | CONFIRMED | as Agent 1 |

### Agent 5 (creature reference)

| Claim | Verdict | Evidence |
|---|---|---|
| 8 `InstancedMesh` buckets, 3 shared geometries, constant draw calls | CONFIRMED | `port-creature-system.js:838-874` |
| Shared geometry cache keyed by dimensions | CONFIRMED | `:759-780` |
| Module-scope scratch, zero-alloc hot path | CONFIRMED | `:788-811` |
| LOD ladder + update strides + per-creature frame offset | CONFIRMED | `creaturePerf` `:15-24`; gating described in creature.md matches |
| `player-procedural-body.js` has no LOD/stride/cache discipline | CONFIRMED | grep: no lod/stride/cache constructs in file |
| Capsule ghost's placeholder held-item hidden when `useProceduralBody` on (no fallback visual) | CONFIRMED | `multiplayer.js:503-509` |
| Stale "deferred — capsule ghosts for now" comments above `useProceduralBody: true` | CONFIRMED | `environment-viewer.html:630-638, 675-678` — comment/code disagreement, update in Phase 1 |

---

## B. Root-cause diagnosis (definitive)

**Bug #1 — invisible arms/weapon: a coordinate-space bug (option a), not the async load (option b).**
The bot weapon rig's vertical placement (`bodyMountOffsetY = 1.5 − torso.position.y`, cached once —
`environment-viewer.html:7912-7913`) is `bot-viewer.html`'s flat-floor convention, where "1.5" meant
"floor(=0) + 1.5". On real terrain it resolves to **absolute** y≈1.5 at the capture spot, so the gun
— and both grip-driven arm IK targets — sit below the ground by the terrain height under the bot.
Arms reach-clamp downward into the torso column (invisible), the gun is underground (invisible),
reload's body-relative left-hand keys still animate at the chest (the one visible motion), and
shots fire from the capsule eye (unaffected). The local player avoided this with an explicit
terrain-relative rig (`:9188-9190`). Secondary, real defects to fix in the same pass: no retry
backoff on mount failure (`:7903-7906`), no per-weapon template cache (`:7796`), no debug surface.
One browser probe confirms before coding (see Phase 0); watching a tracer spawn from underground is
the smoking gun.

**Bug #2 — perf: N× fully-unshared character rigs + N× uncached GLTF loads + zero LOD, exactly as
agents 2/4/5 describe — with two corrections.** Each bot = **31** unique meshes (not ~19) with 4
unique materials and freshly-tessellated geometries (`player-procedural-body.js:538-706`), plus an
independently loaded/parsed weapon scene graph (`environment-viewer.html:7796`), all updated at full
detail every frame regardless of distance, plus steady per-frame GC churn (~10+ allocs/bot/frame
across `toWirePose`/ghost update/body update/mount update). The FABRIK-iteration cost claimed by
agent 2 is **not real** (analytic solver; FABRIK never invoked) — the fix is mesh/material/draw-call
sharing, LOD/striding, and allocation hygiene, not IK work. Creatures are cheap because
`port-creature-system.js` batches everything into 8 InstancedMeshes with shared geometry and a
strided LOD ladder; none of that was adopted for bots. Secondary sim costs (unthrottled
`propagateBotAlert`, `pushBotsApart` allocs, per-request nav-window rebuilds) are real but minor
at n≈30.

---

## C. Implementation plan

Ordered: cheap correctness first, then perf quick wins, then structure, then the instancing
refactor only if measurements demand it. Each phase is independently shippable and verifiable.

**Locked decisions (human, 2026-07-19):** (1) Phase 0 browser probes skipped — Phase 1 implemented
directly. (2) **Bot count is unbounded** → Phase 4 (instanced rig) is now **MANDATORY**, not
conditional. (3) **Per-bot color is required** → Phase 2 must not collapse bots onto one flat
material, and Phase 4's instanced rig must carry a per-instance color attribute.

### Phase 0 — SKIPPED (per decision 1)

Browser confirmation was waived; Phase 1 shipped directly. The confirmation probes now live inside
the Phase-1 verify step and the Bot Inspector's mount readout.

### Phase 1 — SHIPPED (2026-07-19)

Bug #1 fix + asset-cost quick wins, all in `environment-viewer.html` unless noted. As implemented
and re-reviewed:

1. **Terrain-relative rig Y (Bug #1 fix)** — `updateEnvironmentBotWeaponMount` (`:7929-7930`) now
   uses `const weaponY = terrainHeight(weaponX, weaponZ) + 1.5;`, matching the local mount (`:9190`);
   `bodyMountOffsetY` removed from the mount record (`:7848-7851`). **Verified correct:** same
   terrain-relative frame the body rig and the authored `thirdPersonHold` offsets assume; XZ still
   tracks `torso.position` (sway/lead) which is fine; vertical is now flat (no torso bob), matching
   the local mount. `bot-viewer.html` left untouched (floor=0 makes it equivalent).
2. **Shared weapon template cache + `skeletonClone`** — `createEnvironmentBotWeaponMount`
   (`:7800-7808`) reuses `lbWeaponModelCache` (normalize-once) and clones per mount via
   `skeletonClone`; `castShadow=true` applied per-clone (`:7812-7816`), not on the shared template.
   `destroyEnvironmentBotWeaponMount` (`:7762-7771`) no longer disposes geometry/materials.
   **Verified**, with one **MUST-FIX regression** it exposed — see Phase 1.5.
3. **Retry backoff** — `botVisualWeaponMountRetryAfter` Map (`:7756`); `createEnvironmentBotWeaponMount`
   returns boolean; `requestEnvironmentBotWeaponMount` (`:7861-7873`) gates re-requests behind the
   timer, sets `now+800` on `built===false`, clears on success; `destroy` clears it. **Works**, with
   one **SHOULD-FIX** race — see Phase 1.5.
4. **Bot Inspector mount readout** — `refreshBotInspectorPanel` (`:5077-5084`) shows
   `mount: <state>  rigY  muzzleY  terrainY`. **Verified no TDZ:** the panel builds inside the async
   `_forestPromise.then()` callback (opened `:3407`), which runs after synchronous top-level eval, so
   the `const botVisualWeaponMounts` at `:7753` is always initialized first; the `:2383` no-op stub
   covers the earlier animation-loop call sites.
5. **Docs/log** — `bots.md` "Bot weapon rendering" section; `weapon-hand-placement-parity.md` gap #9;
   stale "deferred — capsule ghosts" comments fixed (`:630-638/:675-678`); `agent_log.csv` appended.

Tests green (`test-weapons.mjs`, `test-bot-activity.mjs`; `node --check` on the extracted script).

### Phase 1.5 — review must-fixes (before Phase 2)

1. **MUST-FIX — `teardownLocalWeaponMount` disposes shared template geometry** (`:7623-7624`). It
   still runs `weaponRig.traverse(o => o.geometry?.dispose?.())`. Since `skeletonClone` shares
   geometry **and materials by reference** with the cached template *and every live bot clone*,
   a local third-person weapon switch now frees GPU buffers out from under all bots holding that
   weapon, and leaves the cached template's geometry disposed so future clones reference dead
   buffers. Pre-existing latent bug that Phase 1 escalated from "cosmetic re-upload on local switch"
   to "corrupts all bots mid-combat." **Fix:** drop the traverse-dispose from
   `teardownLocalWeaponMount` — just `scene.remove` (mirror `destroyEnvironmentBotWeaponMount`'s
   comment `:7769`). Shared template geometry should only ever be disposed when the cache itself is
   cleared (which never happens today; the weapon set is tiny and fixed — acceptable).
2. **SHOULD-FIX — retry-backoff arms on benign bail-outs** (`:7867-7869`).
   `createEnvironmentBotWeaponMount` returns `false` for real failures *and* benign supersede-bails
   (token bumped, `bodyRef` changed). The `.then` sets `retryAfter = now+800` on **any** false, so a
   superseded build (rapid weapon switch, body recreation) arms an 800 ms throttle even though
   nothing failed; a late-resolving stale build can even re-arm it after a newer success. The local
   path guards exactly this: `initLocalWeaponMount` only arms retry `if (!built && token ===
   lbWeaponMountToken)` (`:7676`). **Fix:** only set `retryAfter` when this request is still the
   current one (guard on `botVisualWeaponMountRequests.get(id) === request`, or a matching token).
   Low severity (all paths self-heal within 800 ms, no crash), but cheap and it restores parity with
   the local mount. Minor adjacent nit: `retryAfter` is keyed by id, not weapon, so a switch to a new
   weapon while an old failure's timer is live is throttled up to 800 ms — optional to clear on
   weapon change.

### Phase 2 — per-frame cost + geometry sharing (keeps per-bot color)

Reduce per-bot cost and stop N-scaling of geometry/GC. **Materials stay per-bot** (decision 3): do
**not** collapse bots onto one flat material set.

1. **Share body *geometry* across all bodies** (`player-procedural-body.js`): geometry is built from
   fixed constants `H=1.8, R=0.35` (`:525-535`) — every body tessellates *identical* lathe/limb/
   joint/eye geometry, sized per-body only via `mesh.scale` in `placeSegment` (`:830-848`). Hoist a
   module-scope memo (keyed by `limbShape` + dims) so all bodies share one `BufferGeometry` per part
   → N× fewer tessellations/GPU buffers, zero visual change. Tag `userData.shared` and make
   `destroy()` skip disposing shared geometry (like `port-creature-system.js:756`). **This is also
   the correct home for the Phase 1.5 dispose discipline** — geometry ownership moves to the cache,
   not the instance.
2. **Materials: keep per-bot, but lighten.** Per-bot color is required, so retain per-body materials
   (or per-body via `setTint`, `player-procedural-body.js:1219-1223`). The win here is not material
   *count* but avoiding needless churn: reuse the existing `setTint` path for bot color instead of
   allocating fresh style objects, and ensure `destroy()` disposes only the per-body materials it
   owns. (True material collapse is deferred to Phase 4's per-instance color attribute.)
3. **LOD / update-stride for bot bodies + mounts**, modeled on `creaturePerf`
   (`port-creature-system.js:15-24`): compute a camera-distance tier once per bot per tick in
   `updateHostPlayerGhosts`/`syncEnvironmentBotWeaponMounts`; far bots run `bodyProc.update` +
   `controller.update` on a 2nd/4th-frame stride (accumulated dt, per-bot frame offset to avoid
   spikes), hidden bots skip the mount update entirely. With unbounded bots this is essential, not
   optional — it caps per-frame CPU regardless of count. **Apply to bots only** (recommend exempting
   the handful of remote human ghosts; popping is more noticeable on real players).
4. **Allocation hygiene** (mechanical): hoist `player-procedural-body.js:1169-1170, 1184-1185, 1195`
   to scratch/constants; `multiplayer.js:550, 567, 573` → scratch; pool `toWirePose` outputs /
   pass scratch from `updateHostPlayerGhosts` (`:591-593`); scratch `Euler`/`Vector3` in
   `updateEnvironmentBotWeaponMount`/`alignEnvironmentBotWeaponToPoint` (`:7926, :7935, :7937,
   :7876-7900`); reuse the `pushBotsApart` array (`:1991-1994`).
5. **Secondary sim wins**: throttle `propagateBotAlert` per bot (cadence or only on re-acquire,
   `:2254`); cache the local nav window per bot for a few seconds when the goal hasn't moved
   (`:2063-2074`). More valuable now that bot count is unbounded.

**Verify**: `frameProfiler` 'bots' ms + `renderer.info.render.calls` before/after at high bot counts;
flat GC in a firefight; per-bot colors still distinct; visual parity.

### Phase 3 — `port-bot-bridge.js` adapter (structural; do before Phase 4)

Now clearly warranted (unbounded bots make the missing seam a scaling liability). Mirror
`createEnvironmentPortCreatures` (`port-creature-bridge.js:410-535`): a factory taking injected
context (`scene`, `terrainHeight`, `mapCollider` accessor, player-pose accessors, combat handles),
exposing `update(dt)` (wrapping `updateBots` + mount sync + inspector), `reset()`, `stats` (bot
count, LOD tiers, mount states — for the frame profiler), spawn verbs, and a `mode:'off'`
cheap-disable. The bridge owns the weapon template cache and the Phase-4 instanced batches. Sequence
it **before** Phase 4 so the instanced rig lands behind a clean boundary instead of deeper into the
9k-line host file. Risk: moderate (pure code motion, many closure captures) — ship as its own
behavior-neutral change.

### Phase 4 — instanced bot rig with per-instance color (MANDATORY — decision 2)

Unbounded bots make this the load-bearing perf phase, not a conditional. Each bot is otherwise **31
draw calls** (5 torso-stack + 2 eyes + 12 leg + 12 arm meshes, `player-procedural-body.js:596-706`)
plus its weapon subtree — linear and unbounded. Batch the humanoid parts the way
`createCreaturePartBatches` does (`port-creature-system.js:838-874`): shared `BufferGeometry` per
part type + `InstancedMesh` buckets (`limbSegment`, `jointSphere`, torso-stack, foot, eye), bodies
writing transforms into instance slots via bare `Object3D` placeholders (the creature system's
`:1506+` pattern) instead of owning real meshes.

- **Per-instance color is required (decision 3):** carry a per-instance color attribute
  (`InstancedMesh.setColorAt` / `instanceColor`, as the creature batches already do with
  `_instColor`, `port-creature-system.js:807`) so each bot keeps its tint under instancing. This is
  the reason Phase 2 keeps per-bot color alive rather than flattening it — the color data flows
  straight into the instance attribute here.
- **Capacity/streaming:** unbounded bots means the fixed `capacity=4096` slot model
  (`port-creature-system.js:838`) needs either a generous cap with graceful spillover or a
  grow-on-demand buffer; decide the cap policy up front.
- **Weapon stays a cloned GLB** (skinned meshes don't instance cheaply) — but the Phase-1 template
  cache already makes that one-parse-then-clone; per-bot weapon draw cost is the remaining tail and
  can ride an LOD/impostor cut for distant bots if needed.
- Scope: a significant `player-procedural-body.js` refactor that also touches the local player and
  human ghosts. **Recommend gating the instanced path to `mode:'remote'` bodies** so the local
  first-person/third-person player keeps the simple mesh path and only the many-of-them remote/bot
  bodies pay the instancing complexity. Land it behind the Phase-3 bridge boundary.

---

## D. Open questions / decisions for the human

*Resolved by the 2026-07-19 decisions: repro-map probe (Phase 0 skipped), bot-count target
(unbounded → Phase 4 mandatory), and material strategy (per-bot color required). Remaining:*

1. **Phase 1.5 must-fix sign-off.** Confirm the two fixes (drop the shared-geometry dispose in
   `teardownLocalWeaponMount`; guard the retry-arm on current-request) land before Phase 2. The
   first is a genuine mid-combat GPU-corruption risk and should not wait.
2. **Instanced-rig capacity policy (Phase 4).** With unbounded bots, pick: a hard cap with
   soft-fail beyond it, or a grow-on-demand instance buffer? Affects the batch allocation and the
   `stats`/LOD design.
3. **Weapon draw-call tail at high counts.** Cloned GLBs don't instance; at hundreds of bots the
   per-bot weapon subtree becomes the tail. Acceptable, or do we want a distant-bot weapon impostor/
   LOD cut in Phase 4?
4. **LOD fairness for human ghosts.** Confirm remote *human* players are exempt from the Phase 2/4
   stride/LOD (recommended: bots only — popping is more noticeable on real players).
5. **Backport the Y-fix to `bot-viewer.html`?** Functionally moot there (floor=0). Recommend: leave
   the harness, document the convention difference in `bots.md` (already noted).
6. **Muzzle-recovery + pursue/flee parity** (agent 3's dropped-features list) — out of scope for
   these two bugs; queue as a separate behavior-parity task?
