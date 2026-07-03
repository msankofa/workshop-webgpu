# Plan: Replicated Entity Registry — Light Milestone (multiplayer-first, generic projectile)

Status: IMPLEMENTED 2026-07-03 (milestone A — lights + projectiles). Node tests + integration harness green; browser two-tab visual/GPU verification still outstanding (see below). Milestone B (deltas/keyframes, creatures/props, persistence) deferred.
Date: 2026-07-03
Spec source: `docs/notes/light_migration.txt` (bottom half), cross-referenced with `docs/subsystems/multiplayer.md` §"Multiplayer Reframe" and `docs/subsystems/lighting.md`.

## Goal

Replace the special-cased shared-light multiplayer patch with **one host-authoritative replicated entity registry** that lights (and later creatures/props) flow through. Clients submit intents; host owns state; clients render mirrored snapshots. Go straight for multiplayer (no solo-only intermediate). Use a **generic `projectile` entity that spawns a `light` entity on impact** (not a light-with-kind).

Keep the clustered WebGPU renderer (`clustered-lights.js`) exactly as-is; drive it from a new renderer-binding layer instead of scattered `setLightDirect` calls.

## What already exists (must be removed/replaced, not built from scratch)

Grounded in the current code:

- `environment-viewer.html:75-88` — `mpSharedLights` (Map id→record), `mpSharedLightSlots` (33-wide slot table), `mpPendingLightState`, `mpRenderedLightSlots`, `mpSharedLightSeq`, broadcast throttle state. Slots `MP_LIGHT_FIRST_SLOT=223`, `MP_LIGHT_MAX=33`.
- `environment-viewer.html:3257-3416` — the shared-light lifecycle: `lgAllocSharedLightSlot`/`lgReleaseSharedLightSlot`, `lgCreateSharedPlacedLight`, `lgCreateSharedProjectile`, `lgSubmitSharedLightCommand`, `lgHandleSharedLightPlace/Fire`, `lgSharedLightSnapshot`, `lgBroadcastSharedLightState`, `lgApplySharedLightSnapshot`, `lgUpdateSharedLightsHost`. This is essentially the registry + light adapter + projectile physics, hard-coded and MP-only.
- `environment-viewer.html:221-235` — `getState()` embeds `lights: lgSharedLightSnapshot()` into `sim_state`.
- `environment-viewer.html:272-283` — guest applies `state.lights` and a redundant `mp:light_state` custom event path.
- `environment-viewer.html:297-301` — host `mp:guest_input` dispatch for `light_place`/`light_fire`.
- `environment-viewer.html:2883-2903, 3533-3594` — the **separate solo path**: `placedLights[]`, `lgInFlight`, `lgSlotFree[]`, slots `LG_PROJECTILE_SLOT=223`/`LG_FIRST_SLOT=224`. Duplicate physics/lifecycle.
- `multiplayer.js:163-215` — `_lerpLights` + `lights` field in `_lerpState`, plus `light_state` handled implicitly (guest re-dispatches non-`sim_state` messages as `mp:<type>`).

**Two independent light-slot regimes exist today** (solo 223+224..255 vs shared 223..255) selected by `lgSharedMode()`. The registry unifies them onto one renderer-owned slot pool.

## New modules

### 1. `entity-registry.js` (pure, Node-testable, no THREE, no DOM)

Mirrors the spec's registry API. Owns all dynamic entities by id, tracks a monotonic global `version` and per-entity `version`, emits nothing (pull-based snapshots), and is used **identically in solo, host, and guest** — guest just never calls mutators, only `applySnapshot`.

```js
export function createEntityRegistry() → registry
registry.create(type, init, ctx) → entity          // allocates id `${type}-${seq}`, stamps createdAt/updatedAt/version
registry.update(id, patch, ctx) → entity|null       // shallow-merges into state/transform, bumps version
registry.destroy(id, reason, ctx) → boolean         // marks tombstone (kept one snapshot cycle for removes), then drops
registry.get(id) → entity|null
registry.list(filter) → entity[]                    // filter: {type} or predicate
registry.tick(dt, ctx)                              // calls the per-type adapter.update for each entity; handles lifecycle/ttl + destroy
registry.snapshot({ sinceVersion=0, interestCenter=null, radius=Infinity }) → { full, since, version, upserts, removes }
registry.applySnapshot(snap)                        // guest/mirror only: upsert + remove into local store, no adapters' sim
```

Entity record shape (from spec, trimmed to what the light milestone needs; extensible):

```js
{ id, type, ownerId, createdAt, updatedAt, version,
  transform: { p:[x,y,z], q:[0,0,0,1], s:[1,1,1] },
  state: { /* gameplay: color, radius, intensity, lifespan… */ },
  sim:   { /* host-only private: velocity, driftPhase, grounded… NOT serialized */ } }
```

- **Adapters registered by type**: `registry.registerType(typeDef)`. `snapshot()` calls `typeDef.serialize(entity)` to produce the wire `state` (drops `sim`, rounds floats). `applySnapshot` stores raw upserts.
- **Full snapshots only this milestone (MANDATORY, per review).** The relay (`server/server.js:54-60`) is broadcast-only — no unicast — so per-guest `sinceVersion` baselines are unimplementable and late joiners would miss prior deltas. Also, delta upserts break `_lerpLights`-style interpolation (unchanged entities absent from a delta would vanish since interpolation maps over the b-snapshot). So `snapshot()` always returns `full:true` with **all** current entities in `upserts`. Keep the `{ full, since, version, upserts, removes }` envelope so the wire shape is future-proof, but ignore `sinceVersion` for now. Each mutation still bumps `entity.version` (useful for debug/ordering); deltas + keyframes + `guest_joined`-triggered full sync are a **separate later milestone (B)**.
- **`interestCenter`/`radius`** accepted but default to "send all" for the milestone (spec defers interest management). Keep the param so the protocol needn't change later.
- **`applySnapshot` guard (per review):** assert/refuse if called on a registry instance that has ever been `tick`ed — prevents accidentally mixing host + mirror roles in one instance.
- **`renderList(filter)` helper (added during Step-1 review):** serializes current entities via their adapters **without draining `pendingRemoves`** — safe to call every render frame to feed the binder. `snapshot()` (which DOES drain removes) is reserved for the 20 Hz network broadcast only. **Host trap:** never feed the binder from `snapshot()` or removes get stolen from the network path.
- **Guest serialize trap (added during Step-1 review):** on the guest, `applySnapshot` stores the *wire* object (`color:[r,g,b]` array) as `entity.state`; the adapters' `serialize` expects the *internal* shape (`color:{r,g,b}`, `sim.renderP`…). So the guest must feed the binder the **interpolated wire upserts directly** (filtered to renderable), NOT `mirror.renderList()`. The mirror registry is optional on the guest — the interpolated `entities.upserts` array already IS the mirror in wire shape.

### 2. `entity-types/light.js` and `entity-types/projectile.js` (pure, no THREE)

Type adapters plugged into the registry. Pure math + state; **no renderer calls** (renderer binding is separate).

`LightEntity`:
```js
{ type:'light',
  create(input, ctx),            // normalizes params (reuse lgNormalizeParamsPacket logic → move into here)
  update(entity, dt, ctx),       // float/drift bob, gravity settle for non-float, lifespan countdown, fade; destroy at lifespan<=0
  serialize(entity) }            // → { p:[renderX,renderY,renderZ], color:[r,g,b], radius, intensity, lifespan, totalLife, ownerId }
```

`ProjectileEntity` (generic, payload-carrying):
```js
{ type:'projectile',
  create(input, ctx),            // origin/dir/speed(from chargeRatio)/arc + payload:{ type:'light', params }
  update(entity, dt, ctx),       // ballistic step; on terrain hit or age>MAX_FLIGHT → ctx.spawn(payload.type, {...}) then destroy self
  serialize(entity) }            // → { p, color(from payload for a faint tracer), radius, intensity }
```

- `ctx` passed into `tick` carries host-only helpers the adapters need without importing them: `{ terrainHeight, spawn(type,init), now }`. `spawn` calls back into `registry.create`. This keeps adapters pure and Node-testable (tests pass a fake `terrainHeight`/`spawn`).
- Impact converts projectile→light by **destroy + create**, so the light gets a fresh id/slot. Matches the "generic projectile spawns a light on impact" decision.
- **Interpolation continuity (per review — must-fix).** Today's code mutates `kind` on the *same id* (`environment-viewer.html:3381`), so `_lerpLights` (keyed by id) smoothly lerps the landing. A fresh light id at impact has **no lerp predecessor** → at ≤60 u/s with 20 Hz broadcast + 100 ms delay the guest teleports/flashes the light in. Fix: the light created on impact carries `state.spawnedFrom = <projectileId>` for its first snapshot; guest interpolation uses the projectile's last record as the new id's lerp predecessor. Keeps generic-projectile semantics while preserving the smooth landing.
- **serialize is allowlist-based (per review):** serializers explicitly pick wire fields (`p`, `color`, `radius`, …) rather than deleting `sim`, so host-private `sim` (velocity/driftPhase/grounded) can never leak. This lets `sim` live on the record (simpler than a side Map).

### 3. `light-entity-renderer.js` (THREE/WebGPU-facing; the renderer binding layer)

Owns the clustered-light **slot pool** and all `clusteredLightsRef.setLightDirect/clearLight` calls. Nothing else touches slots.

```js
export function createLightEntityRenderer({ clusteredLights, firstSlot=223, maxSlots=33 }) → binder
binder.sync(lightEntities)   // lightEntities: array of serialized light entities (from registry.list('light')+projectiles that render)
binder.dispose()
```

- Internal `Map<entityId, slot>` + free list. `sync` diff: assign slots to new ids, update existing, clear+free slots whose ids vanished. This replaces `lgAllocSharedLightSlot`/`mpRenderedLightSlots`/`mpSharedLightSlots` and the solo `lgSlotFree`.
- **Binder input = any entity whose serialized state carries light-render fields** (per review — resolve the inconsistency): the binder consumes both `light` entities **and in-flight `projectile` entities** (projectiles render as a moving light, as today at `:3562`). Define this once as a predicate/`render.light` shape on the serialized entity; do **not** feed it bare `list('light')` anywhere or guests lose in-flight projectiles. NB: today's shared projectile renders at full `brightness` (`:3305-3307`) — keep that (drop the "faint tracer" idea unless we deliberately want a behavior change).
- Both host and guest call `binder.sync(...)` **from `animate()` only** (per review — pick one call site; not multiplayer.js's rAF too, which would double the diff churn). Guest reads its mirror registry (updated by `onState`); host reads its live registry; solo reads its live registry. **One code path.**
- **Null-binder tolerance (per review):** `binder` is created alongside the lazy `clustered-lights.js` import (~line 699); before then, and forever when lights are off / terrain isn't GPU (`clusteredLightsRef` stays null), `binder` is null. All `binder?.sync(...)` calls must null-guard, and on binder creation do one catch-up `sync` (the analog of today's `:705`). The mirror registry already buffers via `applySnapshot` with no renderer, so nothing is lost. This **replaces `mpLightSnapshotsReady`** (`:76`, `:704-705`), which is deleted.
- Renderer is what decides slots, so `serialize` never carries a `slot` (drop `slot` from the wire — it's a host-render detail today at `environment-viewer.html:3334`).

## Protocol changes

### Wire: replace `lights`/`light_state` with generic `entities`

- `sim_state` gains `entities: { full, since, version, upserts:[serializedEntity], removes:[{id,version,reason}] }` (spec §"Snapshot Stream"). **Remove** the `lights:` field (`environment-viewer.html:235`) and the separate `light_state` broadcast + `mp:light_state` listener (`environment-viewer.html:279-283`, `3339-3347`).
- Intents generalize the existing ad-hoc messages into one envelope (spec §"Command/Intent Layer"):
  - `{ type:'entity_intent', action:'light.place', pos, params }`
  - `{ type:'entity_intent', action:'light.fire', origin, dir, chargeRatio, params }`
  - **Clean cut, no compat window** (per review): host+guest ship from the same origin, no independently deployed clients. Add a `protocolVersion` to the host hello and the relay's `room_info` reply so the start screen can warn/refuse on mismatch (guards the one real hazard: a deployed-Pages guest joining a locally-modified host via the public relay). Cheap insurance; still a clean cut.

### Host validation (spec §3 "Host validates")

On receiving `entity_intent`, host validates before mutating: known action, finite numbers, `params` within the existing `lgNormalizeParamsPacket` clamps, and a **registry-level max-entity cap** (`lights + projectiles ≤ 33`, a registry constant — the pure registry can't see the binder's pool, so enforce it in `registry.create`/validation, not in the binder). **Reject newest** when full (matches today's `lgAllocSharedLightSlot` returning -1; predictable "gun is full" vs. evicting lights someone deliberately placed). Reject silently for milestone (no reject message yet; future work per spec conflict model).

### Relay server (`server/server.js`)

**No change required** — it blind-forwards JSON, so `entity_intent` (guest→host, tagged with `clientId`) and `entities`-bearing `sim_state` (host→guests) pass through untouched. Confirm `pruneRoom`/host-replace semantics are unaffected. (Server-authoritative validation stays out of scope — spec keeps host authority for this milestone.)

### Guest interpolation (`multiplayer.js`)

- Replace `_lerpLights` + the `lights:` branch in `_lerpState` (`multiplayer.js:163-215`) with entity interpolation: interpolate `entities.upserts` by `id` (position lerp, radius/intensity/lifespan lerp) — same math, keyed off the generic entity `state`. `removes` pass through as-is (no interpolation).
- Guest feeds interpolated upserts/removes into its **mirror `entityRegistry.applySnapshot`** inside `onState`; the actual `binder.sync(...)` runs once per display frame in `animate()` (single call site — see renderer-binding section). This removes the guest's direct `lgApplySharedLightSnapshot` slot writes (`environment-viewer.html:3349-3371`).
- **`spawnedFrom` handling:** when an upsert carries `state.spawnedFrom`, use the prior snapshot's entry for that id as its lerp predecessor so a just-landed light doesn't pop in (see projectile→light note above).

## Wiring in `environment-viewer.html`

1. Static-import `createEntityRegistry`, the type adapters, and (lazily, alongside `clustered-lights.js` at line ~699) `createLightEntityRenderer`.
2. Create one registry for all roles. Host registers adapters + runs `registry.tick(dt, ctx)` in `lgUpdateLights` (replacing `lgUpdateSharedLightsHost` and the solo branch). Guest creates a mirror registry (adapters registered but never ticked). Solo = host-without-network.
3. `lgPlaceAtCrosshair`/`lgFireLight` (`3417-3452`): always emit an `entity_intent`. In solo/host, route locally to `registry`-mutating validation; in guest, `mpSession.sendInput(intent)`. Delete the `lgSharedMode()` fork and the entire solo `placedLights`/`lgInFlight` path.
4. `getState()` (`221-235`): replace `lights:` with `entities: registry.snapshot()` (always `full:true`).
5. Every frame in `animate()` (host & guest, single call site): `binder?.sync(<serialized light + in-flight-projectile entities from the live/mirror registry>)`. Null-guard until the binder exists; one catch-up sync when it's created.
6. Delete: `mpSharedLights`, `mpSharedLightSlots`, `mpRenderedLightSlots`, `mpSharedLightSeq`, `mpPendingLightState`, `mpLastLightBroadcast*`, `mp:light_state` listener, `light_state` broadcast, solo `placedLights`/`lgSlotFree`/`lgInFlight`, and the now-unused `lg*SharedLight*` functions.

## Slot-range reconciliation

Renderer binder owns slots `223..255` (33 slots), matching `createClusteredLights({ reserve: 33 })` at `environment-viewer.html:699`. The solo projectile no longer needs a dedicated slot 223 — projectiles are entities and get pooled slots like anything else. Confirm 33 is still enough headroom for projectile(s)-in-flight + placed lights; if a projectile-in-flight can exceed the pool, either bump `reserve` or let the binder prioritize (drop oldest). Flag for reviewer.

## Testing / verification

- `entity-registry-test.mjs` (repo root, plain `node`, `console.assert` style like `multiplayer-test.mjs`): create/update/destroy/version bumps; `snapshot({sinceVersion})` delta correctness (only newer upserts, tombstones in removes); `applySnapshot` mirror convergence; light adapter lifespan→destroy; projectile impact spawns a light and destroys itself (fake `terrainHeight`/`spawn`).
- Extend `multiplayer-test.mjs`: entity upsert interpolation by id; removes pass through; clamp-before-first/after-last still hold.
- **Manual E2E via the running server** (`python serve.py 8080`): open two tabs (host + guest via `?relay=`), place & fire lights on each, confirm both see both, lifespans expire in sync, projectile→light conversion replicates, and slot exhaustion degrades gracefully. Use `/verify` or `/run` skill to drive.

## Migration order (each step keeps the app runnable; snapshot backups first)

0. **Backup**: copy `environment-viewer.html`, `multiplayer.js` → `versions/<name>-before-entity-registry-<ts>.ext` (per project convention). Repeat before each editing session.
1. Add `entity-registry.js` + `entity-types/light.js` + `entity-types/projectile.js` + registry test. No wiring yet. (Green Node test.)
2. Add `light-entity-renderer.js`. Unit-test the slot diff in isolation if practical (can stub clusteredLights).
3. **Coordinated host + wire + guest cut (merged — per review; the old step 3 "compat shim" was unworkable because the live guest `lgApplySharedLightSnapshot` requires `slot` + flat `r,g,b`, which the new serializer drops).** In one change: wire registry+binder into the **host** path (replace `lgUpdateSharedLightsHost`/`lgSharedLightSnapshot`/slot code); switch the wire to `entities` (`getState` at `:235`); update `multiplayer.js` interpolation to entity-by-id; add the **guest mirror registry + binder** (updated in `onState`, synced in `animate()`); remove `light_state` broadcast, the `lights` field, and the `mp:light_state` listener (`:279-283`). Because snapshots are always full (see Protocol), there is no ack/`sinceVersion` machinery to build here. Verify host+guest render identically end-to-end before proceeding.
4. Route `entity_intent` (`light.place`/`light.fire`) from `lgPlaceAtCrosshair`/`lgFireLight` (`:3417-3452`); delete solo `placedLights`/`lgInFlight`/`lgSlotFree` and the `lgSharedMode` fork so **solo runs the same registry** (host-without-network).
5. Delete all dead state/functions: `mpSharedLights`, `mpSharedLightSlots`, `mpRenderedLightSlots`, `mpSharedLightSeq`, `mpPendingLightState`, `mpLightSnapshotsReady` (incl. boot lines `:704-705`), `mpLastLightBroadcast*`, and every `lg*SharedLight*`. Grep to confirm zero references.
6. Update docs: `docs/subsystems/multiplayer.md` (§9 Shared Light Bridge → "Replicated entity registry (lights)"; also fix the stale `multiplayer.js` line count — it's 284, doc says 252), `docs/subsystems/lighting.md` (note the binder owns slot allocation), add rows to `code-map.html` `DOC_LIST`/`GROUP_DOCS` for the new modules, and append `agent_log.csv` rows.

## Out of scope (explicitly deferred, per spec "Later")

Creatures/props into the registry; persistence/mutation log; interest management beyond the accepted-but-ignored param; server-side validation/authority; reject/correction messages; delta compression beyond the simple `sinceVersion` scheme.

## Resolved decisions (were open questions; settled by Fable review)

1. **Protocol cut** — clean cut, no compat window; add a `protocolVersion` handshake (host hello + `room_info`) so a stale deployed guest can't silently corrupt a room.
2. **Deltas** — **out of scope**; full snapshots every tick this milestone (relay is broadcast-only; deltas break interpolation and late joiners). Deltas + keyframes = milestone B.
3. **Slot pool** — keep 33 (matches `reserve:33`), shared by placed lights + in-flight projectiles, enforced as a registry constant; **reject newest** when full.
4. **`sim` placement** — on the entity record, with **allowlist-based `serialize`** so private fields structurally cannot leak (no side Map).
5. **Registry class** — one class; guest never ticks and `applySnapshot` asserts it was never ticked.
