# Lens: rendering / draw calls / DOM — model: opus

Audit target: `bot-viewer.html` (5138 lines) plus `body-part-batches.js` and `weapon-part-batches.js`.
Scope: only costs whose magnitude grows with bot count N (target 50–200).

Baseline established while reading: the **bot body and the held weapon are genuinely instanced**
(`player-procedural-body.js:566-573` builds transform-only `Object3D` placeholders when a batch pool
is injected, `flush()` at `player-procedural-body.js:1285` emits ~31 world matrices into
`body-part-batches.js`; the weapon rig at `bot-viewer.html:601-617` is transform-only and renders via
`weapon-part-batches.js`). Those two subsystems are **not** the problem and are deliberately not
reported as findings. Every finding below is something *outside* those two instanced paths, or a
property of the pools themselves.

Reference counts used throughout:
- ~31 rendered body parts per bot across **18 distinct geometries** (`player-procedural-body.js:637-747`:
  pelvis/waist/torso/neck/head/eye + 6 per leg × 2 + 6 per arm × 2).
- ~28 scene-graph `Object3D`s added to `scene` per bot outside the instanced pools (derived in Finding 6).

---

## Finding: ~9 non-instanced draw calls per bot from the per-bot tactical-visual meshes

**File / lines:** `bot-viewer.html:749-771` (creation + `scene.add`), `bot-viewer.html:1022-1052`
(`createBotTacticalVisuals`), `bot-viewer.html:1055-1096` (`updateBotTacticalVisuals`).

```js
// bot-viewer.html:754-755
    const tacticalVisuals = createBotTacticalVisuals(team);
    scene.add(mesh, facing, stateOrb, tacticalVisuals.fovWedge, tacticalVisuals.sightRange, tacticalVisuals.knifeRange, tacticalVisuals.healthBar);
```

```js
// bot-viewer.html:1030-1050
  const sightRange = new THREE.Mesh(
    new THREE.RingGeometry(0.975, 1, 64),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }),
  );
  ...
  const healthBar = new THREE.Group();
  const background = new THREE.Mesh(
    new THREE.PlaneGeometry(0.78, 0.10),
    new THREE.MeshBasicMaterial({ color: 0x161a20, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
  );
  const healthFillMaterial = new THREE.MeshBasicMaterial({ color: 0x63e6a4, side: THREE.DoubleSide, depthWrite: false });
  const healthFill = new THREE.Mesh(new THREE.PlaneGeometry(0.70, 0.058), healthFillMaterial);
```

**Why it is slow at high N:** every one of these is a distinct `THREE.Mesh` with its **own**
`BufferGeometry` and its **own** `Material` instance — nothing is shared or instanced, so each one is a
separate draw call with its own pipeline bind group and uniform buffer. The gate in
`updateBotTacticalVisuals` is *not* per-bot-selective: `emitsFocusedBotDiagnostics(actor)` at
`bot-viewer.html:864-866` returns `true` for **every** actor unless an Alt-click focus is set, so
`botTacticalVisualsEnabled` turns the health bar + sight ring on for all N bots simultaneously —
which is precisely the mode the harness is used in.

Per living bot when tactical visuals are on: sightRange (1) + healthBar background (1) + healthBar
fill (1) = 3, plus facing cone (1, always on — see Finding 2), plus fovWedge (1) if the FOV toggle is
on, plus knifeRange (1) with behavior debug, plus stateOrb (1) with orbs on, plus up to 3 for the
alert mark (Finding 9). Also all of them are `transparent: true, depthWrite: false`, so they land in
the depth-sorted transparent pass and the renderer sorts ~N×5 objects per frame.

**Scaling:** O(N) draw calls, O(N) transparent-sort entries, O(N) material colour uniform writes
(`bot-viewer.html:1095` `actor.healthFillMaterial.color.setHex(...)` per bot per frame).

**Severity at 100 bots:** **high** — 300–900 extra draw calls/frame plus a several-hundred-entry
transparent sort, on top of the ~20 the instanced body+weapon path costs.

**Fix sketch:** collapse the health bar + sight ring + fov wedge into three shared `InstancedMesh`es
(one per overlay type, per-instance colour for HP tint), the same pattern already proven in
`body-part-batches.js`.

---

## Finding: the facing cone is an always-visible, per-bot-material mesh with a per-frame colour write

**File / lines:** `bot-viewer.html:749` (creation), `755` (`scene.add`), `1208-1212` (per-frame update).

```js
// bot-viewer.html:749
    const facing = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.3, 8), new THREE.MeshStandardMaterial({ color: style.facing }));
```

```js
// bot-viewer.html:1208-1212
  facingMesh.position.copy(mid).addScaledVector(new THREE.Vector3(Math.sin(bot.yaw), 0, Math.cos(bot.yaw)), bot.capsule.radius + 0.2);
  ...
  facingMesh.rotation.z = -bot.yaw;
  const stateColor = botStateColor(botState);
  facingMesh.material.color.setHex(stateColor);
```

**Why it is slow at high N:** unlike the capsule mesh (`bot-viewer.html:714`/`777`
`botMesh.visible = !botProceduralBodyEnabled`), the facing cone is **never hidden** — the only
`visible = false` write is on death (`bot-viewer.html:1432`) and it is restored on revive
(`bot-viewer.html:3738`). There is no toggle for it. Each cone owns a unique `ConeGeometry` **and** a
unique `MeshStandardMaterial`, so it is one unavoidable lit draw call per living bot with a distinct
bind group. Worse, line 1212 rewrites `material.color` **every frame for every bot**, which dirties
that material's uniform buffer and forces a per-bot GPU buffer write each frame even when the state
colour did not change.

**Scaling:** O(N) lit draw calls + O(N) uniform-buffer writes per frame, unconditionally.

**Severity at 100 bots:** **high** — 100 extra lit draws and 100 uniform uploads per frame that no
setting can turn off.

**Fix sketch:** make the cone a single `InstancedMesh` with per-instance colour, and only write the
colour when `stateColor !== actor._lastStateColor`.

---

## Finding: instanced-body buffers upload the full 8192-slot capacity every frame, not the used count

**File / lines:** `body-part-batches.js:38` (`capacity = 8192`), `47` (allocation), `80-86` (`endFrame`).
Same pattern in `weapon-part-batches.js:66` / `104-109` (capacity 2048).

```js
// body-part-batches.js:80-86
    endFrame() {
      for (const b of buckets.values()) {
        b.mesh.count = b.count;
        b.mesh.instanceMatrix.needsUpdate = true;
        if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
      }
    },
```

**Why it is slow at high N:** `needsUpdate = true` with no `addUpdateRange`/`updateRange` set makes
the WebGPU backend re-upload the **entire** typed array, not the first `count` instances.
Each bucket allocates `8192 × 16` floats of matrix (512 KB) plus `8192 × 3` floats of colour (96 KB).
With 18 body geometry buckets that is **≈11 MB written to the GPU every single frame**, at every bot
count. At the 50–200 bot target only 1,550–6,200 instance slots are actually in use spread across 18
buckets (~85–350 per bucket), so **95–99% of that upload is zero-filled waste**.

Be explicit about the scaling shape: this cost is O(capacity), *not* O(N) — it is a flat ~11 MB/frame
that does not go down for 10 bots and does not go up for 200. It is reported here anyway because it
is the dominant cost inside the very mechanism that is supposed to make bot count cheap, and because
the fix converts it into a genuine O(N) cost.

**Severity at 100 bots:** **high** — ~660 MB/s of pure PCIe write traffic at 60 fps for ~30 MB/s worth
of real data.

**Fix sketch:** in `endFrame`, call `b.mesh.instanceMatrix.addUpdateRange(0, b.count * 16)` (and the
colour equivalent) before setting `needsUpdate`, and/or grow buckets geometrically from a small
starting capacity instead of pre-allocating 8192.

---

## Finding: corpses never retire — dead bots keep flushing 31 instances and stepping the solver forever

**File / lines:** `bot-viewer.html:925-931` (dead-bot branch), `bot-viewer.html:5094-5097`
(unconditional flush loop), `bot-viewer.html:1408-1425` (`killCombatBot` keeps the body alive).

```js
// bot-viewer.html:925-931
    if (actor.entity.alive === false) {
      // Dead bots don't run the FSM, but a ragdolling corpse still needs stepping + re-posing.
      if (actor.ragdoll && actor.body) {
        stepRagdoll(actor.ragdoll, dt, RAGDOLL_DEATH_STEP);
        actor.body.setRagdollPose(actor.ragdollPose);
      }
      continue;
    }
```

```js
// bot-viewer.html:5096
  for (const actor of botActors) actor.body?.flush(botBodyBatches);
```

**Why it is slow at high N:** a killed bot with `ragdollDeathEnabled` (default `true`,
`bot-viewer.html:185`) keeps its procedural body (`killCombatBot` takes the branch at line 1409 and
never calls `destroyBotProceduralBody`). It is never removed from `botActors` — only the global
`removeAllBots()` clears the array. So every frame, forever, each corpse:
(a) runs `stepRagdoll` — 14 constraint iterations × up to `MAX_SUBSTEPS` sub-steps over 16 particles,
with **no sleep/settle check** (`ragdoll.js:270-289` has no early-out; the settle metric noted at
`ragdoll.js:338` is only used by tests), and
(b) `flush()`es all ~31 part matrices into the instance pool, plus `group.updateMatrixWorld(true)`
forcing a 31-node matrix recompose (`player-procedural-body.js:1285-1292`).

With auto-add running (`bot-viewer.html:957-972`, spawns a wave every `botAutoAddInterval` seconds)
the corpse count grows without bound, so the flushed instance count and the ragdoll solve cost are a
function of *cumulative* spawns, not live bot count. A 5-minute session at 10 bots/5 s reaches
hundreds of corpses.

**Scaling:** O(total bots ever spawned), unbounded in time. Also silently pushes the batch pools
toward the 8192 cap, at which point `stats.dropped` starts eating live bots' parts
(`body-part-batches.js:73`).

**Severity at 100 bots:** **high** in any session longer than a minute; medium in a fresh 100-bot
snapshot.

**Fix sketch:** freeze a corpse once `jointSpeedSq` falls below a threshold (stop stepping, keep the
last flush), and despawn/recycle corpses after a configurable timeout.

---

## Finding: each spawn allocates ~13 geometries, ~15 materials, and a 320×80 canvas + CanvasTexture for overlays that are invisible by default

**File / lines:** `bot-viewer.html:745-774` (spawn), `bot-viewer.html:2012-2021`
(`createBotGoalDebug`), `bot-viewer.html:2060-2084` (`createBotInvestigationDebug`).

```js
// bot-viewer.html:2074-2079
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 80;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }));
```

```js
// bot-viewer.html:745-747
    const geometry = new THREE.CapsuleGeometry(entity.capsule.radius, entity.capsule.end.y - entity.capsule.start.y, 4, 8);
    const material = new THREE.MeshStandardMaterial({ color: style.capsule, roughness: 0.6 });
    const mesh = new THREE.Mesh(geometry, material);
```

**Why it is slow at high N:** per bot, `spawnBots` constructs a unique `CapsuleGeometry`, `ConeGeometry`,
FOV-wedge `BufferGeometry`, two 64-segment `RingGeometry`s, two `PlaneGeometry`s, a 20-segment
`RingGeometry` (goal marker), another 20- and 64-segment ring pair plus two empty `BufferGeometry`s
(investigation debug) — ~13 geometries — and ~15 `Material` instances, none shared with any other bot
despite being byte-identical. The investigation debug additionally allocates a 320×80 `<canvas>`
(~102 KB backing store) and a `CanvasTexture` **per bot**, even though `updateInvestigationDebug`
(`bot-viewer.html:2102-2110`) only ever makes **one** of them visible (`actor === diagnosticActor`).
Same for `createBotGoalDebug`.

This is not one-time init cost: `updateBotAutoAdd` (`bot-viewer.html:957-972`) calls `spawnBots` in
waves *during play*, so each wave pays this allocation + GPU-upload burst as a visible frame hitch,
and the hitch is proportional to wave size.

**Scaling:** O(N) geometries, materials and canvases; ~10 MB of canvas backing store alone at 100 bots.

**Severity at 100 bots:** **medium** — a per-wave spawn hitch plus permanent memory bloat, but no
steady-state draw cost (they are invisible).

**Fix sketch:** hoist the ring/plane/capsule/cone geometries and the flat materials to module-level
shared constants, and build `goalDebug` / `investigationDebug` (canvas included) **lazily** on
Alt-click focus — only one bot ever needs them.

---

## Finding: ~28 scene-graph nodes per bot are walked by `updateMatrixWorld` every frame even while invisible

**File / lines:** `bot-viewer.html:755` (7 nodes + healthBar's 2 children), `760` (2 debug groups =
9 nodes), `763-764` (insignia 3 + alert mark 4), `603-617` (weapon rig: 4 `Group`s + 2 marker
`Object3D`s).

```js
// bot-viewer.html:758-764
    const goalDebug = createBotGoalDebug();
    const investigationDebug = createBotInvestigationDebug();
    scene.add(goalDebug.group, investigationDebug.group);
    const actor = createBotActor(entity, mesh, facing, roleId);
    actor.stateOrb = stateOrb;
    if (role.insignia) { actor.roleInsignia = buildRoleInsignia(role.insignia); scene.add(actor.roleInsignia); }
    actor.alertMark = buildAlertMark(); scene.add(actor.alertMark);
```

**Why it is slow at high N:** `Object3D.updateMatrixWorld` recurses into **all** children regardless of
`visible`; only the render-list projection short-circuits on `visible === false`. So every frame the
renderer's `scene.updateMatrixWorld()` composes a matrix for all ~28 per-bot nodes (9 for
mesh/facing/orb/wedge/rings/healthBar, 3 for goalDebug, 6 for investigationDebug, 4 for the alert
mark, 6 for the weapon rig) even though at default settings only ~2 of them are visible.
`flushWeaponMount` (`bot-viewer.html:196-204`) then re-walks the weapon rig a **second** time with
`updateMatrixWorld(true)` (force), so those 6 nodes are recomposed twice per frame per bot.

**Scaling:** O(N) matrix composes (~40 flops + a quaternion→matrix each), doubled for the weapon rig.

**Severity at 100 bots:** **medium** — ~3,000 node visits/frame; not the top cost but pure waste since
most nodes never render.

**Fix sketch:** keep the lazily-built debug groups out of the scene entirely (attach on focus,
detach on blur) and set `matrixAutoUpdate = false` on the static transform-only weapon-rig nodes that
`flushWeaponMount` already forces.

---

## Finding: shot FX are pooled but not instanced — concurrent tracer/bullet draw calls scale with bots × fire rate

**File / lines:** `bot-viewer.html:4276-4314` (`acquireTracerLine`, `spawnTracer`,
`acquireBulletMesh`, `spawnBullet`), called from `bot-viewer.html:4221-4222`.

```js
// bot-viewer.html:4276-4284
function acquireTracerLine() {
  if (tracerPool.length) return tracerPool.pop();
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(6), 3));
  const line = new THREE.Line(geom, tracerMissMaterial);
  line.frustumCulled = false;
  scene.add(line);
  return line;
}
```

```js
// bot-viewer.html:4221-4222
  spawnTracer(fireOrigin, hitPoint, hit.kind === 'player');
  spawnBullet(fireOrigin, hitPoint, hit.kind === 'player');
```

**Credit where due:** the pool is real — no per-shot geometry/material construction, no scene
add/remove churn after warm-up, and the comment at 4247 says so. This is a **downgraded** finding.

**Why it still costs at high N:** every shot lights up **two** independent scene objects (a `THREE.Line`
and a `THREE.Mesh`), and each pooled object is its own draw call. The pool grows to peak
*concurrency*, which is `N × fireRate × lifetime`. Tracers live 150 ms (`bot-viewer.html:4293`);
bullets live `distance / 55 m·s⁻¹` (`bot-viewer.html:4319`), ~0.3 s at typical engagement range.
At 100 bots sustaining ~8 shots/s each: ~120 concurrent tracer lines + ~240 concurrent bullet meshes
≈ **360 extra draw calls**, all `frustumCulled = false` so none are culled, and the tracers are
`transparent: true` so they join the sort. `spawnDummyHitImpact` (`bot-viewer.html:1342-1356`) adds
another pooled-but-individual mesh per hit, each with its **own** material (opacity animates per
impact) — ~35 concurrent at 100 bots.

**Scaling:** O(N × fire rate) concurrent draw calls, permanently retained in the scene once allocated.

**Severity at 100 bots:** **medium** — a few hundred trivial draws, meaningful only because they stack
on top of Findings 1 and 2.

**Fix sketch:** replace the tracer pool with one `LineSegments` whose position buffer holds all live
tracers, and the bullet pool with a single `InstancedMesh` sized to the pool.

---

## Finding: weapon instance buckets cast shadows with frustum culling disabled

**File / lines:** `weapon-part-batches.js:77-78`; shadow config at `bot-viewer.html:48-49`, `93-98`.

```js
// weapon-part-batches.js:77-78
      mesh.frustumCulled = false;       // templates already disable culling (skinned bind-pose bounds)
      mesh.castShadow = true;           // held guns cast shadows in the per-clone path
```

**Why it is slow at high N:** the directional light casts into a 2048×2048 `PCFSoftShadowMap`
(`bot-viewer.html:48-49`, `95`) over a **24 m × 24 m** ortho volume (`bot-viewer.html:97-98`). With
`frustumCulled = false` and a bucket-wide bounding volume that spans the whole map, every bot's
weapon sub-mesh instances are submitted to the shadow pass every frame, including the majority that
are outside the 24 m shadow box entirely and contribute nothing. The body buckets correctly set
`castShadow = false` (`body-part-batches.js:51`), so this is weapons-only. The draw-call count stays
at one per bucket (instancing works), but the **vertex/raster throughput** of the shadow pass is
O(N × submeshes) and is entirely wasted for off-box bots.

**Scaling:** O(N) shadow-pass vertex work with a ~0% useful fraction once bots spread past 24 m.

**Severity at 100 bots:** **medium** — guns are low-poly, but this doubles their geometry throughput
for no visible result on most of the roster.

**Fix sketch:** compute a real bounding sphere per bucket in `endFrame()` (or track min/max of the
added matrices' translations) and re-enable `frustumCulled`, so the shadow pass drops off-box buckets.

---

## Finding: the overhead "!" alert mark is 3 non-instanced transparent meshes per alerted bot

**File / lines:** `bot-viewer.html:1523-1537` (`buildAlertMark`), `bot-viewer.html:1220-1235`
(`updateAlertMark`), created per bot at `bot-viewer.html:764`.

```js
// bot-viewer.html:1226-1229
  const mat = ALERT_MARK_MATS[mode];
  for (const m of mark.userData.exclaim) m.material = mat;
  mark.userData.digit.visible = mode !== 'near'; // a near miss has no casualty score to show
  mark.userData.digit.material = alertDigitMat(activeBotActor.alertScore ?? 1, mode);
```

**Credit where due:** geometry and materials **are** shared module-level constants
(`bot-viewer.html:1491-1501`), and the digit's canvas textures are memoised in `ALERT_DIGIT_MATS`
(`bot-viewer.html:1502-1521`) keyed by `mode + digit` — so there is no per-bot canvas and no per-frame
canvas redraw. Downgraded accordingly.

**Why it still costs at high N:** the mark is still three separate `Mesh`es (bar, dot, digit) under a
`Group`, so a visible mark is **3 draw calls per bot**, and the digit is `transparent, depthWrite:false`
so it joins the transparent sort. `updateAlertMark` has no throttle: in a general firefight most of
the roster has a live `alertMarkMode`, so this is close to 3N in practice. Billboarding
(`quaternion.copy(camera.quaternion)`, line 1234) is per bot per frame, as is the redundant material
reassignment on lines 1227 and 1229 (same object nearly every frame).

**Scaling:** O(N) × 3 draw calls + O(N) transparent-sort entries while a squad alert is active.

**Severity at 100 bots:** **medium** — up to 300 additional transparent draws during exactly the
moment (mass engagement) when frame time is already worst.

**Fix sketch:** merge bar+dot into one shared geometry (2 draws → 1), and batch the marks into a
single `InstancedMesh` with per-instance colour; skip the material writes when `mode` is unchanged.

---

## Finding: dragging the FOV slider disposes and rebuilds N geometries in a single frame

**File / lines:** `bot-viewer.html:1064-1075`.

```js
// bot-viewer.html:1067-1071
      if (actor.fovWedge.userData.builtDeg !== botBehaviorSettings.fovDegrees) {
        actor.fovWedge.geometry.dispose();
        actor.fovWedge.geometry = buildFovWedgeGeometry(botBehaviorSettings.fovDegrees);
        actor.fovWedge.userData.builtDeg = botBehaviorSettings.fovDegrees;
      }
```

**Why it is slow at high N:** `botBehaviorSettings.fovDegrees` is a global driven by the slider at
`bot-viewer.html:4962`. Because each bot owns a *private* wedge geometry stamped with its own
`builtDeg`, a single slider step invalidates all N of them, and every bot rebuilds
(`buildFovWedgeGeometry`, `bot-viewer.html:1007-1021`) + disposes + re-uploads its own buffer within
one frame. At the default 120° that is ~32 verts each, but it is N `dispose()` calls (each freeing a
GPU buffer) plus N allocations plus N uploads per frame for the duration of the drag.

**Guarded:** yes — the whole block is behind `fovVisible`, and `botFovWedgeEnabled` defaults to
`false` (`bot-viewer.html:207`), so this only bites when the FOV overlay is turned on. Downgraded.

**Scaling:** O(N) geometry churn per slider-input frame.

**Severity at 100 bots:** **low** (medium while actively dragging with the overlay on).

**Fix sketch:** build the wedge geometry **once** per `fovDegrees` value into a module-level cache and
have all wedges share it — it is identical for every bot by construction.

---

## Finding: per-bot, per-frame temporary `Vector3`/`Quaternion`/`Euler` allocations in the render/pose path

**File / lines:** `bot-viewer.html:1164`, `bot-viewer.html:1208`, `bot-viewer.html:659-660`,
`bot-viewer.html:266-273` (`clearBotMovementDebug` array copy).

```js
// bot-viewer.html:659-660
  const rootRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, bodyYaw, 0, 'YXZ'));
  const holdRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(...hold.rotation));
```

```js
// bot-viewer.html:1164
  const mid = bot.capsule.start.clone().add(bot.capsule.end).multiplyScalar(0.5);
```

```js
// bot-viewer.html:1208
  facingMesh.position.copy(mid).addScaledVector(new THREE.Vector3(Math.sin(bot.yaw), 0, Math.cos(bot.yaw)), bot.capsule.radius + 0.2);
```

**Why it is slow at high N:** `updateBot` runs once per living bot per frame, and each pass allocates
a `Vector3` (1164), another `Vector3` (1208), and — via `updateBotWeaponMount` — two `Quaternion`s and
two `Euler`s (659-660). `updateBotMovementDebug` additionally spreads `botMovementDebug.children` into
a fresh array on every bot's call even when the debug is off (`bot-viewer.html:267`,
reached from 1209 → 306). That is ~7 short-lived objects per bot per frame.

**Scaling:** O(N) garbage per frame → 100 bots × 60 fps ≈ 42,000 allocations/s, which shows up as
periodic minor-GC stutter rather than steady frame cost.

**Severity at 100 bots:** **low** — real but second-order next to the draw-call findings.

**Fix sketch:** hoist all six into module-level scratch objects (the file already uses this pattern at
`bot-viewer.html:1102` `_healScratch` and `195` `_weaponPartMatrix`) and early-out of
`updateBotMovementDebug` before `clearBotMovementDebug` when the group is already empty.
