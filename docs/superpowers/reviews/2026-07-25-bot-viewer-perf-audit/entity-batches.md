# Lens: entity / instanced batches — model: sonnet

Scope: `bot-entity.js`, `bot-activity.js`, `body-part-batches.js`, `weapon-part-batches.js`, plus the
`bot-viewer.html` call sites that drive them (`renderer.setAnimationLoop` at ~line 5081,
`updateAllBots` at line 920, `updateBotSentry` at line 3752, `flushWeaponMount` at line 196).
Only issues whose per-frame cost scales with bot count (N) or is paid at animation-loop frequency
are included; one-time init cost and style issues are excluded.

## Finding: `endFrame()` unconditionally re-uploads the full `capacity`-sized instance buffer for every body-part bucket, every frame

**File**: `body-part-batches.js`, lines 38, 65-69, 80-86

```js
export function createBodyPartBatches({ THREE, scene, capacity = 8192 }) {
...
    beginFrame() {
      for (const b of buckets.values()) b.count = 0;
      stats.instances = 0;
      stats.dropped = 0;
    },
...
    endFrame() {
      for (const b of buckets.values()) {
        b.mesh.count = b.count;
        b.mesh.instanceMatrix.needsUpdate = true;
        if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
      }
    },
```

Each `InstancedMesh` bucket's `instanceMatrix`/`instanceColor` typed arrays are sized to the fixed
`capacity` (8192 instances, i.e. 8192×16 floats = 512KB for the matrix attribute alone) at
construction (`bucketFor`, line 47: `new THREE.InstancedMesh(geometry, ..., capacity)`), not to the
actual live instance count for that frame. `endFrame()` sets `needsUpdate = true` with no
`updateRange`/`addUpdateRange` ever set on either attribute, so three.js's `WebGLAttributes.update()`
takes the default path and re-uploads the **entire backing array** via `bufferSubData` — not just the
`b.count` slots that were actually written this frame — for **every bucket that has ever received an
instance**, including buckets whose `count` is 0 this frame (e.g. a body-part geometry no bot is
currently using).

**Why it's slow / how it scales**: the per-bucket upload cost is dominated by `capacity`, not by
`b.count`, so it doesn't shrink even at low bot counts. What scales with bot count/roster diversity is
the *number of simultaneously non-empty buckets* paying this tax: at low N (e.g. 10 bots, one body
type) only a handful of buckets are touched; as N grows toward the 50-200 target with mixed
teams/roles, more distinct part geometries become active in the same frame, so more buckets each pay
the full 512KB (matrix) + 96KB (color, `capacity*3*4` bytes) reupload every frame regardless of how
many instances are actually in them. There is also no skip for buckets whose `count` is unchanged
from the prior frame (or is 0) — those still get marked dirty and reuploaded.

**Estimated severity at 100 bots**: High. With ~15 distinct body-part buckets in play (torso/head/
limbs × shell/plate/trim/eye roles) simultaneously active, that's ~15 × ~600KB ≈ 9MB of pointless
GPU upload traffic every frame (≈540MB/s at 60fps) on top of the legitimately-needed data.

**Fix sketch**: only touch `needsUpdate` when `b.count > 0` (or `b.count` differs from last frame's
count), and set `instanceMatrix.addUpdateRange(0, b.count * 16)` / equivalent so the driver only
uploads the live prefix instead of the whole `capacity`-sized array.

**Call-site evidence (frequency)**: `bot-viewer.html:5094-5097` calls `botBodyBatches.beginFrame()` /
`endFrame()` once per `renderer.setAnimationLoop` callback (i.e. every rendered frame):
```
5094	  if (botBodyBatches) botBodyBatches.beginFrame();
5095	  updateAllBots(dt, now);
5096	  for (const actor of botActors) actor.body?.flush(botBodyBatches);
5097	  if (botBodyBatches) botBodyBatches.endFrame();
```

---

## Finding: same unconditional full-capacity reupload in the weapon-part batch pool

**File**: `weapon-part-batches.js`, lines 66, 92-96, 104-109

```js
export function createWeaponPartBatches({ THREE, scene, capacity = 2048 }) {
...
    beginFrame() {
      for (const b of buckets.values()) b.count = 0;
      stats.instances = 0;
      stats.dropped = 0;
    },
...
    endFrame() {
      for (const b of buckets.values()) {
        b.mesh.count = b.count;
        b.mesh.instanceMatrix.needsUpdate = true;
      }
    },
```

Identical pattern to the body-part pool above: `instanceMatrix` is sized to `capacity` (2048
instances × 16 floats = 128KB per bucket) and `needsUpdate` is set unconditionally for every bucket
every frame with no `updateRange`, so the full 128KB is re-uploaded per bucket regardless of how many
weapon sub-mesh instances (`b.count`) are actually live, and even for buckets at `count === 0`.

**Why it's slow / how it scales**: each distinct weapon sub-mesh geometry gets its own bucket
(`bucketFor`, line 74). A single weapon GLB can have several sub-meshes (body/mag/slide/etc.), and
`bot-viewer.html` supports 5 weapon ids (`BOT_VIEWER_WEAPON_IDS`, line 222) that can all be equipped
simultaneously across a large roster. As bot count grows and more weapon types are concurrently held
across the roster, more buckets go non-empty at once, each paying the full 128KB reupload every frame
independent of actual instance count.

**Estimated severity at 100 bots**: Medium-High. With ~10-15 active weapon-part buckets (multiple
weapon types × several sub-meshes each) in a mixed-team scene, that's roughly 1.3-2MB of wasted
upload per frame (~80-120MB/s at 60fps).

**Fix sketch**: same as above — gate `needsUpdate` on `b.count > 0`/changed, and use
`addUpdateRange(0, b.count * 16)` to bound the upload to the live prefix.

**Call-site evidence (frequency)**: `bot-viewer.html:5100-5104`, once per animation-loop frame:
```
5100	  if (botWeaponBatches) {
5101	    botWeaponBatches.beginFrame();
5102	    for (const actor of botActors) flushWeaponMount(actor.weaponMount);
5103	    botWeaponBatches.endFrame();
5104	  }
```
(`flushWeaponMount`, `bot-viewer.html:196-204`, itself loops `for (const part of mount.instanceParts)`
per living/holstered actor, i.e. this whole block runs at O(bots × weaponParts) per frame before the
two batch pools even get to `endFrame()`.)

---

## Finding: `bucketFor()` re-resolves the geometry→bucket `Map` on every single `add()` call instead of caching it

**File**: `body-part-batches.js`, lines 44-61, 71-79; `weapon-part-batches.js`, lines 71-88, 97-103

```js
  function bucketFor(geometry, role) {
    let b = buckets.get(geometry.uuid);
    ...
  }
  return {
    ...
    add(geometry, role, matrix, color) {
      const b = bucketFor(geometry, role);
      if (b.count >= capacity) { stats.dropped++; return false; }
      const i = b.count++;
      b.mesh.setMatrixAt(i, matrix);
      if (color && b.mesh.setColorAt) b.mesh.setColorAt(i, color);
      stats.instances++;
      return true;
    },
```

`add()` calls `bucketFor(geometry, role)` on every invocation, which does a `Map.get(geometry.uuid)`
(string-keyed hash lookup) even though the geometry→bucket mapping is invariant for the lifetime of a
given part (each body/weapon part always targets the same shared geometry — see
`player-procedural-body.js`'s `_sharedBodyGeo` cache and the module docstring in
`weapon-part-batches.js:4-8`). The lookup result is never cached on the caller side (e.g. on the
`part` object itself), so it is redone from scratch every frame for every part of every bot.

**Why it's slow / how it scales**: this is a straightforward O(bots × partsPerBot) cost per frame —
for a 100-bot roster with ~15 body parts + ~8 weapon parts each, that's ~2300 redundant `Map.get`
calls per frame (≈138,000/s at 60fps) purely to re-derive information that was already known the
previous frame and cannot change without the part's geometry changing (which only happens at
mount/build time, not per frame).

**Estimated severity at 100 bots**: Low-Medium. Each `Map.get` is cheap in isolation, but it is pure
overhead stacked on top of the unavoidable `setMatrixAt` work, and it grows linearly with both bot
count and part count together — the two axes this audit is asked to weight most heavily.

**Fix sketch**: have callers (`player-procedural-body.js`'s `flush()`, `flushWeaponMount` in
`bot-viewer.html`) resolve and cache the bucket reference on the part once (e.g.
`part._bucket ??= pool.bucketFor(...)`), and give the pool an `addToBucket(bucket, matrix, color)`
entry point that skips the `Map.get` entirely.

**Call-site evidence (frequency)**: same per-frame `flush()`/`flushWeaponMount` loops cited in the two
findings above, which call `pool.add(...)` once per visible part per living bot per frame
(`body-part-batches.js`'s `add` is reached from `player-procedural-body.js:1288-1291`'s
`for (const part of _instanceParts) ... pool.add(...)`, itself called from `bot-viewer.html:5096`
once per actor per frame).

---

## Finding: `chooseBotState` wraps its result in a throwaway object, and its caller rebuilds a ~24-key context object literal every call — both scale with live bot count every frame

**File**: `bot-activity.js`, lines 32-99 (representative excerpts below); called from
`bot-viewer.html:3953-3966`

```js
// bot-activity.js:32-50 (excerpt)
export function chooseBotState({ current = BOT_PATROL, ctx = {} } = {}) {
  const { targetVisible = false, aimError = Infinity, readyToFire = false, hasLastKnown = false,
    targetDistance = Infinity, pursueDistance = Infinity, pursueExitBuffer = 0,
    fleeDistance = 0, fleeExitBuffer = 0,
    fleeCommitted = false, healRequested = false, healFleeCommitted = false,
    knifeRequested = false,
    keepsMissing = false, pursueHealthOk = true,
    healReady = false, healUnsafe = false, hasHealResource = true,
    coverAvailable = false, atCoverAnchor = false, coverValid = false,
    allyHitNearby = false, coverCommitted = false,
    fireCapable = true, knifeCapable = false } = ctx;
  if (current === BOT_HEAL && healRequested && hasHealResource) {
    if (healUnsafe) return { state: BOT_FLEE };
    return { state: BOT_HEAL };
  }
```

Every branch of `chooseBotState` (lines 48, 49, 52, 53, 56, 57, 63, 69, 73, 77-79, 86-87, 91, 92, 93,
96, 98 — ~16 return sites) allocates a brand-new single-field `{ state: X }` object, purely so the
caller can immediately destructure `.state` back out of it
(`bot-viewer.html:3953`: `let { state } = chooseBotState({...})`). The wrapper carries no information
`state` alone doesn't.

On top of that, the call site builds two fresh object literals per call — the outer
`{ current, ctx: {...} }` and the ~24-property `ctx` object itself:

```js
// bot-viewer.html:3953-3966
let { state } = chooseBotState({
  current: botState,
  ctx: { targetVisible: visible, aimError: err, readyToFire, hasLastKnown: !!lastKnownTarget,
    targetDistance, pursueDistance: botCombatStandoff,
    pursueExitBuffer: botBehaviorSettings.pursueExitBuffer,
    keepsMissing, pursueHealthOk,
    fleeDistance: weaponFleeDistance,
    fleeExitBuffer: botBehaviorSettings.fleeExitBuffer, fleeCommitted, knifeRequested,
    healRequested: botHealRequested,
    healFleeCommitted: botHealRequested && botState === BOT_FLEE && pathMode === 'flee' && currentPath.length > 0,
    healReady: healStatus.ready, healUnsafe: healStatus.unsafe, hasHealResource: hasPack,
    coverAvailable, atCoverAnchor, coverValid, allyHitNearby: !!coverAlert, coverCommitted,
    fireCapable: !attackerOutOfAmmo, knifeCapable: botKnifeSecondaryEnabled },
});
```

**Why it's slow / how it scales**: this call is unconditional (not gated by target visibility) inside
`updateBotSentry`, which `updateAllBots` invokes once per **living** bot per frame
(`bot-viewer.html:933-934`, inside the `for (const actor of botActors)` loop at line 924). So every
frame pays 3 short-lived object allocations (outer args, `ctx`, and the `{state}` return) per living
bot: at 100 bots × 60fps that's ~18,000 small-object allocations/second purely for state-machine
plumbing, none of which need to exist — `state` is a string and could be threaded through directly.

**Estimated severity at 100 bots**: Medium. V8's young-generation GC handles small short-lived objects
cheaply in isolation, but this is one of several similar per-bot-per-frame allocation sources in the
same hot loop (see the `aimAnglesTo` finding below), and they compound into avoidable GC pressure and
frame-time jitter as N approaches the 200-bot target, competing with render-thread submission time in
the same frame budget.

**Fix sketch**: have `chooseBotState` return the state string directly instead of `{ state }`; have the
caller reuse a single module-level scratch `ctx` object (mutate its fields each frame) instead of a
fresh object literal, mirroring the reused-scratch-`Vector3`/`Matrix4` pattern already used elsewhere
in this codebase (e.g. `bot-entity.js`'s `_delta`, `bot-viewer.html`'s `_weaponPartMatrix`).

**Call-site evidence (frequency)**: `bot-viewer.html:924-936` (`updateAllBots`) and
`bot-viewer.html:3752-3966` (`updateBotSentry` body containing the call) — confirmed via the comment at
`bot-viewer.html:3750`: "Every active bot runs this same established sentry/behavior state machine."

---

## Finding: `aimAnglesTo` allocates a new `{yaw, pitch}` object per call, on the per-bot-per-frame aiming hot path

**File**: `bot-activity.js`, lines 105-109; called from `bot-viewer.html:3788`

```js
export function aimAnglesTo(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const horiz = Math.hypot(dx, dz);
  return { yaw: Math.atan2(dx, dz), pitch: Math.atan2(dy, horiz) };
}
```

Returns a fresh object every call instead of writing into a caller-supplied scratch object or
returning a tuple/two primitives.

**Why it's slow / how it scales**: called once per bot per frame whenever that bot currently has a
visible target (`bot-viewer.html:3779-3789`, inside `if (visible) { ... const angles =
aimAnglesTo(botEye, targetEye); ... }`), which is exactly the busy/worst-case scenario (many bots
engaged in a firefight simultaneously) that a 100-200 bot stress test is meant to exercise — the
allocation rate rises precisely when the scene is already most expensive.

**Estimated severity at 100 bots**: Low. The object is tiny (2 numeric fields) and only allocated for
bots with a currently-visible target, but it stacks with the `chooseBotState` allocations above in the
same per-bot-per-frame code path.

**Fix sketch**: return `[yaw, pitch]` or accept an `out` object to write into (mirroring how
`bot-entity.js` reuses `_delta` for vector scratch work), and have the call site reuse
`botAimTarget` (already declared and mutated at `bot-viewer.html:3790-3791`) directly instead of the
intermediate `angles` object.

**Call-site evidence (frequency)**: `bot-viewer.html:3788-3791`, reached from `updateBotSentry`
(line 3752) which `updateAllBots` calls once per living bot per frame (line 934, loop at line 924).
