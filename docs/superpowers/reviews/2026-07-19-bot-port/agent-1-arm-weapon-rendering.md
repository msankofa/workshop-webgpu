# Bug #1 — Bot arms and held weapon do not render

Investigation of why combat bots in `environment-viewer.html` run their full arm/weapon
animation state machine (visible motion during reload, bullets fire correctly) but no arm
or weapon geometry is visibly resolving outside the torso silhouette.

## 1. The full arm/weapon render path as ported

Bots are **not** rendered by a bot-specific renderer. They ride the same `GhostRenderer`
used for guest players (`multiplayer.js`), plus a bot-only weapon-mount layer bolted onto
`environment-viewer.html`.

```
bot-entity.js (createBotEntity/stepBotPhysics/toWirePose)
        |  botToWirePose(bot)  -> {id, p:[mid], q:[wire yaw], h, r, weapon, tool, aimPitch, ...}
        v
environment-viewer.html: updateHostPlayerGhosts()  (env-viewer.html:587-596)
        |  mpGhostRenderer.update({ players: [...guestPoses, ...botPoses] })
        v
multiplayer.js: GhostRenderer._updatePlayers()  (:465-520)
        |  per player-id Group `g`; if useProceduralBody -> _updateProceduralBody(g, item) (:522-581)
        |      creates/updates g.userData.bodyProc = createProceduralPlayerBody({mode:'remote', ...})
        v
player-procedural-body.js: createProceduralPlayerBody()  (:445-1236)
        |  builds pelvis/torso/head/leg/arm meshes, adds them to `group`, group added to `scene` once
        |  update(dt, state) positions everything in WORLD space every frame; arms solve toward
        |  arm.target (set via setArmTarget) or an idle hang pose if no target is set
        v
environment-viewer.html: syncEnvironmentBotWeaponMounts(dt) -> updateEnvironmentBotWeaponMount() (:7894-7939)
        |  environmentBotBody(id) reads mpGhostRenderer.playerGroups().get(id).userData.bodyProc
        |  requestEnvironmentBotWeaponMount -> createEnvironmentBotWeaponMount() (:7769-7846, async)
        |      loads GLB + weapon-anchors.json/weapon-poses.json, builds
        |      weaponRig -> weaponAdjust -> weaponFrame(rot.y=PI) -> weaponView -> model
        |      creates a createWeaponPoseController bound to `body` (the bodyProc instance)
        v
weapon-pose-controller.js: controller.update(dt, ...)  (:215-353)
        |  resolves rightGrip/leftGrip (or reload-sequence refs) to world targets via
        |  weapon-sequence.js's resolveTargetRef(ctx: {weaponRoot, bodyRoot, anchors})
        |  calls body.setArmTarget(side, {position, quaternion, weight:1, hint})
        v
player-procedural-body.js: solveArm()  (:894-945)
        |  analytic 2-bone IK from the shoulder to arm.target.position, writes
        |  arm.upper/arm.lower/arm.hand mesh transforms directly (world space)
```

Order within `updateBots(dt)` (env-viewer.html:2558-2598) is: `updateHostPlayerGhosts()` (runs
`bodyProc.update()`, i.e. the leg/arm/torso solve) **before** `syncEnvironmentBotWeaponMounts(dt)`
(runs `controller.update()`, i.e. `setArmTarget`). That is the same one-frame-late ordering
`weapon-hand-placement-parity.md` documents as expected/current behavior for the local body, not a
bug.

## 2. Comparison with `bot-viewer.html` and the local player body

This is the most important finding: **the bot-viewer.html reference implementation and the
environment-viewer.html port are structurally identical**, function-for-function, for every part
of this path I could trace by hand:

| Concern | `bot-viewer.html` | `environment-viewer.html` (port) |
|---|---|---|
| Body creation | `createProceduralPlayerBody({mode:'remote', ...})` (:537-548) | Same call inside `GhostRenderer._updateProceduralBody` (multiplayer.js:532-539), `style: item.isBot ? {...} : {}` |
| Yaw fed to body | `yaw: bot.yaw + Math.PI` (bot-viewer.html:603) | Decoded from the wire quaternion (multiplayer.js:563), which `toWirePose` already encoded as `bot.yaw + Math.PI` (bot-entity.js:70,76) — algebraically the same value reaches `bodyProc.update()` |
| Weapon mount hierarchy | `weaponRig -> weaponAdjust -> weaponFrame(rot.y=PI) -> weaponView` (bot-viewer.html:446-454) | Identical (env-viewer.html:7807-7815) |
| Weapon rig position/yaw | `torso.position` + `(visualYaw + headYaw)`, no extra `+PI` (bot-viewer.html:490-501) | Identical (env-viewer.html:7908-7918) |
| Anchor baking | `bakeBotWeaponAnchors` / `normalizeBotWeaponModel` (bot-viewer.html:378-407) | `bakeWeaponAnchors` / `normalizeWeaponModel` (env-viewer.html:7638-7659) — same math |
| Controller wiring | `createWeaponPoseController({THREE, body, weaponView, getWeaponDef})` (bot-viewer.html:463-475) | Identical shape (env-viewer.html:7824-7836) |
| Reload sequence data | Same inline fallback reload sequence object | Byte-identical fallback object (env-viewer.html:7779-7794 vs bot-viewer.html:418-433) |
| Per-frame drive | `updateBotWeaponMount(dt, mid)` called every tick after `botProceduralBody.update()` (bot-viewer.html:591-610) | `updateEnvironmentBotWeaponMount` called every tick after `updateHostPlayerGhosts()` (env-viewer.html:2593-2594) |

Given this, the arm-IK math itself (`solveArm`, `solveTwoBone`, the elbow/torso-avoidance
correction) is **shared code** (`player-procedural-body.js`) used unmodified by all three
rendering contexts (local third-person body, `bot-viewer.html`, and the environment-viewer bot
port). A bug specific to "bots in environment-viewer.html" is therefore unlikely to live inside
`solveArm` itself — it would also break `bot-viewer.html`, which is described as still working.

The one place the port is **not** a straight copy is the local player's third-person mount
(`env-viewer.html:9158-9230`), which has two things the bot mount does not:

1. **Crouch/prone hold blending.** Local: `holdLerp` blends `thirdPersonHold`/`crouchHold`/`proneHold`
   by `lbCrouchW`/`lbProneW` (env-viewer.html:9194-9203). Bots: always the flat `thirdPersonHold`
   (env-viewer.html:7919-7921), no crouch/prone handling at all. Not a likely cause here (bots don't
   crouch), but a real, documented-elsewhere parity gap (`weapon-hand-placement-parity.md` gap #2).
2. **A visible retry backoff + debug readout.** See hypothesis 1 below — this is the one concrete,
   evidenced asymmetry between the local mount and the bot mount.

## 3. Ranked root-cause hypotheses

### Hypothesis 1 (highest confidence): the async weapon-mount build is failing silently and retrying every frame with no backoff, and there is no debug surface to see it

`createEnvironmentBotWeaponMount` (env-viewer.html:7769-7846) is a fire-and-forget async
function. Its only failure signal is `console.warn('[environment-bot] failed to load direct
weapon mount', ...)` inside a catch block (env-viewer.html:7841-7845) — nothing surfaces to the
UI, and nothing throttles a repeat attempt.

Compare with the **local** player's equivalent (`initLocalWeaponMount`, env-viewer.html:7668-7680):
it explicitly wraps the same kind of build call, and on failure sets
`lbWeaponMountRetryAfter = performance.now() + 800`, with a comment explaining exactly this
failure mode: *"a one-off bail or throw can't permanently deadlock the current weapon (which
previously left the gun invisible until you switched to a different weapon)."* The bot path
(`requestEnvironmentBotWeaponMount`, env-viewer.html:7848-7856) has no equivalent throttle: every
tick that `mount` is still falsy, `updateEnvironmentBotWeaponMount` (env-viewer.html:7903-7907)
unconditionally calls `requestEnvironmentBotWeaponMount` again. The in-flight dedup
(`botVisualWeaponMountRequests`) prevents literal request-storming while a request is pending, but
there is no cool-down after a failure — a persistently-failing weapon (bad anchor data, a 404 on
the GLB, a `bodyRef !== environmentBotBody(id)` identity mismatch) retries indefinitely, silently.

This does **not** by itself explain arm motion during reload (an arm target requires a live
controller, which requires a mount to exist) — but it is consistent with a *partial* failure: if
the mount is created (controller running, `setArmTarget` being called every frame — explaining the
"arms move on reload" observation) but the model fails to load/attach correctly, or throws
somewhere in the anchor-baking step, the weapon mesh could be silently absent while the
arm-IK targets it feeds off `weaponView`'s world transform still resolve to *something* (likely a
degenerate, near-origin, or stale value if `weaponView`/`model` were left in a half-initialized
state).

**Recommended next step (needs the browser, not more static reading):** open DevTools console
while bots are active and look for repeated `[environment-bot] failed to load direct weapon mount`
warnings. If present, that pinpoints this as the cause and narrows it to why the load/build is
failing (bad path, thrown exception in `bakeWeaponAnchors`, or the `bodyRef !==
environmentBotBody(id)` identity guard rejecting every attempt).

### Hypothesis 2 (medium confidence): the bot weapon-mount system is genuinely new/under-exercised code, unlike the documented "remote players don't use this IK path" contract

`docs/subsystems/weapon-hand-placement-parity.md` (2026-07-12), gap #9, states: *"Remote
multiplayer representations currently use simplified body/hand placeholders rather than the local
procedural body plus real weapon-anchor arm IK."* That is still literally true for **guest**
players (they get a `bodyProc` body via `GhostRenderer` but nothing ever calls
`setArmTarget` on it — there is no guest equivalent of `botVisualWeaponMounts`). Bots are the
**only** case where a remote-rendered `bodyProc` is driven by a real `weapon-pose-controller`
instance, and that wiring (`botVisualWeaponMounts` and friends, env-viewer.html:7743-7939) postdates
this parity doc and is not mentioned by it at all.

Corroborating evidence that `useProceduralBody` itself is a recent, possibly-incompletely-verified
flip: all three `GhostRenderer` construction sites (env-viewer.html:630-638, 675-678) still carry
the comment *"remote procedural bodies (useProceduralBody) are deferred — they need proper
per-frame sync + real weapon model + perf work (Wave 2 increment 2). Capsule ghosts for now."*
immediately above a line that actually passes `useProceduralBody: true`. The comment and the code
disagree, which is a strong signal this flag was turned on without a full doc/verification pass —
exactly the kind of change likely to ship with an unnoticed rendering bug in the one path
(bot weapons) that has no local-body equivalent to compare against.

### Hypothesis 3 (lower confidence, ruled mostly out but noted): coordinate-space or yaw-convention mismatch

I traced the full yaw pipeline (`bot.yaw` → `toWirePose`'s `+Math.PI` wire encoding → `GhostRenderer`'s
`atan2` decode → `player-procedural-body.js`'s own `+Math.PI` → `body.motion.visualYaw` → bot weapon
mount's `bodyYaw`) and confirmed algebraically that it reduces to the same value
`bot-viewer.html` feeds directly (`bot.yaw + Math.PI`). I also checked mesh parenting (`group` is
added to `scene` once at construction; `rootAnchor` is deliberately parent-less and only used for
resolving body-relative weapon-sequence refs like `beltMagazine`), arm mesh creation (`makeArm`,
player-procedural-body.js:685-706, all six per-arm meshes `group.add()`-ed unconditionally), and
visibility flags (`GhostRenderer` correctly hides the old capsule/orb-hand/held-box placeholder
meshes exactly when `useProceduralBody` is on, via `multiplayer.js:504-509`; `bodyProc.group.visible`
depends only on `internalVisible` and `state.alive`, both fine for a living bot). None of these show
a scale-to-zero, missing-`add()`, or wrong-parent bug. I could not find a code-level explanation for
"arms collapse inward" in the shared IK math itself, since that code is identical to the working
`bot-viewer.html` path. I'm listing this mainly to record what's already been ruled out so a
follow-up pass doesn't re-walk the same ground.

## 4. What a fix would need to touch

1. **Immediate diagnostic** (no code change): run `environment-viewer.html` with bots active, open
   DevTools console, watch for `[environment-bot] failed to load direct weapon mount` warnings.
   Separately, temporarily log `botVisualWeaponMounts.get(id)` state (does a mount object exist?
   `weaponRig.visible`? `weaponView.children.length`? — mirroring the existing local-body debug HUD
   at env-viewer.html:9229 which has no bot equivalent) to see whether the mount is being created at
   all, and whether `weaponRig`'s resolved world position is actually near the bot or collapsed
   toward the origin/torso.
2. **If Hypothesis 1 confirms** (mount build failing): fix whatever `createEnvironmentBotWeaponMount`
   is throwing on, and add the same retry-backoff pattern `initLocalWeaponMount`/
   `lbWeaponMountRetryAfter` already uses (env-viewer.html:7668-7680) to `requestEnvironmentBotWeaponMount`/
   `updateEnvironmentBotWeaponMount`, so a persistent failure degrades to "no gun, idle arms" instead
   of spamming the load every frame.
3. **Add a bot-mount debug readout** analogous to the local body's `lbDebug` HUD text
   (env-viewer.html:9222-9230) — currently there is no way to inspect `botVisualWeaponMounts` state
   from the running app, which is why this bug required full static tracing instead of a five-second
   console check.
4. **Regardless of root cause**, once fixed: update `docs/subsystems/bots.md` (the "What exists
   today" section around the rendering bullet, env-viewer.html-referenced) and
   `docs/subsystems/weapon-hand-placement-parity.md`'s gap #9 to describe the bot weapon-mount system
   that now exists, since neither currently documents it.

## Files read/cited

- `G:\My Drive\Scripts\procedural-creature\workshop-webgpu\bot-entity.js`
- `G:\My Drive\Scripts\procedural-creature\workshop-webgpu\bot-viewer.html`
- `G:\My Drive\Scripts\procedural-creature\workshop-webgpu\multiplayer.js`
- `G:\My Drive\Scripts\procedural-creature\workshop-webgpu\player-procedural-body.js`
- `G:\My Drive\Scripts\procedural-creature\workshop-webgpu\weapon-pose-controller.js`
- `G:\My Drive\Scripts\procedural-creature\workshop-webgpu\environment-viewer.html`
- `G:\My Drive\Scripts\procedural-creature\workshop-webgpu\weapons.js`
- `G:\My Drive\Scripts\procedural-creature\workshop-webgpu\weapon-anchors.json`
- `G:\My Drive\Scripts\procedural-creature\workshop-webgpu\docs\subsystems\weapon-hand-placement-parity.md`
- `G:\My Drive\Scripts\procedural-creature\workshop-webgpu\docs\subsystems\bots.md`
