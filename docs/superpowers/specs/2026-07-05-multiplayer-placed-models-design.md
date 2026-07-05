# Multiplayer placed models — design + implementation plan

Date: 2026-07-05
Subsystems: multiplayer, entity (asset transport + model entity), world-models UI

## Problem

Placed GLB models are local-only. Host and guest cannot see each other's placed
models. Two separate gaps cause this:

1. **Placement is never replicated.** `world-models.js` `placeAtAim()` loads the
   GLB, builds a group, and does `scene.add(group)` + `state.instances.push(...)`.
   Nothing reaches the network. The panel is constructed with no networking
   dependencies (`createWorldModelPanel({ scene, camera, terrainHeight, isWalkMode })`
   in `environment-viewer.html`).
2. **The asset bytes are not shared.** The GLB is loaded from the placer's local
   disk folder (`showDirectoryPicker` / a `webkitdirectory` file input in
   `connectModels`). Peers have never seen that file and have no URL to fetch it.

Lights do not have gap 2 — a light is ~8 numbers and reconstructs from parameters
alone, so it already replicates through the entity registry (multiplayer.md §9). A
model is a multi-megabyte binary blob, so replicating placement is not enough; the
bytes have to move too.

## Approach

Two layers plus one refactor.

- **Layer 1 — asset transport.** Move the GLB bytes to peers, content-addressed by
  SHA-256, over a new HTTP endpoint on the relay. The entity references the asset by
  hash only.
- **Layer 2 — model entity.** A new `model` entity type in the existing
  `entity-registry.js`, replicated exactly like `light`: guest emits an intent, host
  validates and calls `registry.create`, the serialized entity flows in
  `sim_state.entities`, every client renders it through a model-entity renderer.
- **Refactor.** All model rendering — including the placer's own view — moves to the
  registry-fed renderer. `world-models.js` stops adding placed models to the scene
  directly. This matches how the light gun already works in solo and MP (the gun
  never adds its own light; it creates a registry entity the binder renders).

Solo runs the same registry path with no network hop and no upload (host-without-
network), exactly as lights already do.

### Why HTTP-on-relay, not WebSocket, for the bytes

The relay already runs an HTTP server beside the WSS (`server/server.js`
`httpServer`, with `handlePublishRequest` and `/telemetry/…`). HTTP is built for bulk
binary: streaming request/response bodies, `Content-Type`, and browser GET caching.
Chunking multi-MB blobs through the JSON `sim_state` socket would reimplement bulk
transfer on a realtime message bus and compete with `sim_state` for the one ordered
host↔relay / guest↔relay socket (the same socket the backpressure guard exists to
protect). Keeping asset bytes off that socket entirely is the point.

### Why content-addressed (SHA-256)

The asset id is `sha256(bytes)` (hex). This:

- **Dedups** automatically — place the same tree 50 times, upload once; the hash is
  identical.
- Is **stable across clients** — every client that loads the same GLB computes the
  same id, so a locally-placed model and the same model placed by a peer share one
  cache entry and one relay object.
- Doubles as the **cache key** and the anti-poisoning check: the relay verifies
  `sha256(body) === declaredHash` on upload, so no client can store bytes under a
  hash that does not match them. `Cache-Control: immutable` on GET is safe because
  the content can never change under a given hash.

## Wire protocol

### Asset transport (HTTP, relay)

- `POST /api/asset`
  - Body: raw GLB bytes (`Content-Type: application/octet-stream`).
  - Header: `X-Asset-Hash: <hex sha256>`.
  - Relay recomputes the hash, rejects on mismatch (`400`) or over the per-asset cap
    (`413`). On success stores the bytes in a content-addressed in-memory store and
    returns `{ ok: true, hash }`.
  - If the hash already exists, it is a no-op `200 { ok: true, hash, existed: true }`
    (dedup; lets the client skip re-uploading).
- `GET /api/asset/:hash`
  - `200` with the bytes, `Content-Type: model/gltf-binary`,
    `Cache-Control: public, max-age=31536000, immutable`. Touches LRU recency.
  - `404` if unknown/evicted.
- CORS: `Access-Control-Allow-Origin: *` (same posture as the rest of the relay; the
  content hash is the integrity gate, there is no auth).

### Placement (WebSocket, existing `entity_intent` channel)

Reuses the existing intent path (`mpSession.sendInput` guest-side,
`applyLightIntent`'s sibling host-side). New actions:

- `{ type:'entity_intent', action:'model.place', assetHash, name, pos:[x,y,z],
    transform:{ scale, yaw, pitch, roll, heightOffset, snapToGround } }`
- `{ type:'entity_intent', action:'model.transform', id, transform:{…} }`
- `{ type:'entity_intent', action:'model.remove', id }`

The serialized model entity in `sim_state.entities.upserts`:

- `{ id, type:'model', p:[x,y,z], q:[x,y,z,w], s:[k,k,k], assetHash, name, ownerId }`

No bytes and no local file paths ever appear on the wire — only the hash and the
transform. The relay blind-forwards these exactly like `light` intents/entities
today (`server/server.js` host→guests broadcast and guest→host forward are unchanged).

## Component design

### `server/asset-store.js` (new, pure, Node-testable)

Mirrors the `backpressure.js` / `publish-map.js` split: pure logic, no sockets, no
`http`. A single module-level content-addressed store shared across rooms (a hash is
a global content id; cross-room dedup is free).

- `createAssetStore({ maxAssetBytes = 12*1024*1024, maxTotalBytes = 256*1024*1024 })`
  → `{ put(hash, bytes, meta), get(hash), has(hash), stats() }`.
- `put`: verify `sha256(bytes) === hash` (reject on mismatch), reject if
  `bytes.length > maxAssetBytes`, insert, then evict least-recently-used entries
  until `totalBytes <= maxTotalBytes`. Returns `{ ok, existed }` or a rejection
  reason (`'hash-mismatch'` | `'too-large'`).
- `get`: return `{ bytes, mime }` and bump recency, or `null`.
- Hashing uses `node:crypto` `createHash('sha256')`.

### `server/server.js` (glue only)

In the existing `httpServer` request handler, before `handlePublishRequest`, route
`/api/asset` (POST) and `/api/asset/:hash` (GET) into `asset-store.js`. Reuse the
existing raw-body reading pattern (a bytes variant of `readJson`). No change to the
WSS message loop — asset messages never touch it.

### `entity-registry.js` (small cap generalization)

Today `create` caps only `CAPPED_TYPES = {light, projectile}` against
`MAX_LIGHT_ENTITIES = 33` as one shared group (they convert into each other, so the
shared count is correct). Generalize to per-group caps:

- Keep light+projectile as one group at 33.
- Add `model` as its own group at `MAX_MODEL_ENTITIES = 64`.

Implementation: replace the single `CAPPED_TYPES`/`countCapped` check with a small
`CAP_GROUPS` table mapping a type → `{ group, limit }`, and count members of the same
group. Behavior for existing types is unchanged (reject-newest at 33).

### `entity-types/model.js` (new adapter, pure)

Same shape as `entity-types/light.js`.

- `create(input, ctx)`: bake the placement transform into the entity transform.
  - `q` = quaternion from Euler `(pitch, yaw, roll)` in degrees (pure math; no THREE
    — implement the ZYX/`applyTransform` order used by `world-models.js`
    `group.rotation.set(pitch*DEG, yaw*DEG, roll*DEG)`).
  - `s = [scale, scale, scale]` (uniform, matches `setScalar`).
  - `p.y`: if `snapToGround`, `ctx.terrainHeight(x,z) + heightOffset`; else the raw
    placement `y + heightOffset`. Baked once at placement (re-snap on terrain edits
    is out of scope for v1).
  - `state = { assetHash, name }`. No `sim`.
- No `update` — models are static props; the registry `tick` skips types without an
  `update` function, so a model costs nothing per tick.
- `serialize(entity)`: allowlist `{ id, type:'model', p, q, s, assetHash, name,
  ownerId }`. Nothing else.

### `model-entity-renderer.js` (new, THREE passed in)

Analogous to `light-entity-renderer.js` — the only module that turns model entities
into scene objects. `createModelEntityRenderer({ scene, THREE, loadAsset })` →
`{ sync(entities), dispose() }`.

- `loadAsset(assetHash)` → `Promise<gltf>`, injected so the renderer does not own
  networking. It resolves from a shared client-side `Map<hash, Promise<gltf>>` cache:
  local cache first (the placer already has the bytes from disk), else
  `GET /api/asset/:hash` (arrayBuffer → `GLTFLoader.parse`), retried with backoff on
  `404` (covers the upload race and eviction). In solo it is local-cache-only.
- `sync(entities)` diffs by id (same structure as the light binder):
  - new id → kick off `loadAsset(assetHash)`; on resolve, build the scene object via
    the shared `prepareModelRoot`-style builder (extracted from `world-models.js`),
    apply `p/q/s`, `scene.add`. If the entity was removed before the load resolved,
    drop the result.
  - existing id → apply transform if changed.
  - vanished id → `scene.remove` + dispose geometries/materials.

### `world-models.js` (refactor)

Keep: the model library (folder connect, asset list), the placement transform
sliders, selection, the aim preview (`updatePreview` / `localAim` / the translucent
preview mesh — preview stays a local-only ghost, unreplicated).

Change: placement and the "Placed models" list.

- Export the pure `prepareModelRoot` builder (or move it to a shared helper) so
  `model-entity-renderer.js` can reuse it.
- `createWorldModelPanel` gains `{ emitIntent, isMultiplayer, localPlayerId,
  ensureAssetUploaded, registryModels }` (or a single `net` object) so it can:
  - `placeAtAim`: compute `assetHash` from the asset bytes, `await
    ensureAssetUploaded(hash, bytes, name)` when not solo, then `emitIntent({
    action:'model.place', assetHash, name, pos, transform })` **instead of**
    `scene.add`. No local `state.instances` push, no local group.
  - Transform sliders: keep local live-preview on `input`; on `change` (slider
    release) emit `model.transform` for the selected registry model.
  - `deleteSelected`: emit `model.remove`.
  - The "Placed models" list is rebuilt from the registry's model entities (owned +
    others), not a private array. Selection maps to an entity id.

### `environment-viewer.html` (wiring)

Mirror the light wiring throughout.

- `entityRegistry.registerType(ModelEntity)` alongside the light/projectile
  registrations (host/solo).
- Predicates + host render list: `isModelEntity = w => w?.type === 'model'`;
  `hostModelEntitiesForRender()` = `entityRegistry.renderList(e => e.type==='model')`.
- `let modelBinder = null; let mpPendingModelEntities = [];` (guest interpolated
  upserts, filtered to `type==='model'`), created lazily next to `lightBinder`
  (`createModelEntityRenderer({ scene, THREE, loadAsset })`).
- Guest `onState`: `mpPendingModelEntities = (state.entities?.upserts ?? [])
  .filter(isModelEntity); modelBinder?.sync(mpPendingModelEntities);` (same block
  that already does the light filter at line ~317).
- Per frame (host/solo): after `entityRegistry.tick(...)`,
  `modelBinder?.sync(hostModelEntitiesForRender())` beside the existing
  `lightBinder?.sync(...)`.
- `applyModelIntent(intent, ownerId)` beside `applyLightIntent`: validate action +
  finite numbers, clamp scale/angles, convert Euler→quaternion + bake y, then
  `model.place` → `registry.create('model', …)`, `model.transform` → `registry.update`
  (owner-or-host only), `model.remove` → `registry.destroy` (owner-or-host only).
- Host `mp:guest_input` `entity_intent` branch dispatches by action prefix:
  `light.*` → `applyLightIntent`, `model.*` → `applyModelIntent`.
- Construct `createWorldModelPanel` with the new net hooks: `emitIntent` (guest →
  `mpSession.sendInput`, host/solo → the matching `applyModelIntent` locally),
  `ensureAssetUploaded`, `localPlayerId`, and a registry accessor for the list.
- `ensureAssetUploaded(hash, bytes, name)`: session-scoped "already uploaded" set;
  else optional `GET /api/asset/:hash` existence check; else `POST /api/asset`.
  Await completion before the place intent is emitted so a peer GET cannot 404 on the
  first placement of an asset.
- `mousedown` place branch already calls `worldModels?.handlePrimaryDown?.()` — that
  now routes through the intent path; add `viewHands.recoil()` there for parity with
  the light gun (optional).

## Constants

- Per-asset upload cap: `12 MiB`.
- Relay total asset store cap: `256 MiB` (LRU eviction past this).
- Models per room: `MAX_MODEL_ENTITIES = 64`.
- GET 404 retry: 3 attempts, backoff ~0.5 s / 1 s / 2 s.

## Implementation plan (ordered)

1. **Relay asset store.** `server/asset-store.js` + `server/test-asset-store.mjs`
   (put/get roundtrip, hash-mismatch reject, over-size reject, LRU eviction past the
   byte cap, GET-unknown → null). Wire routes into `server/server.js`.
2. **Registry cap generalization.** Add per-group caps to `entity-registry.js`;
   extend the registry test with the model cap group; confirm the light+projectile
   group still rejects at 33.
3. **Model entity type.** `entity-types/model.js` + `test-model-entity.mjs`
   (Euler→quaternion, uniform scale, snapToGround y-bake, serialize allowlist proves
   no bytes/paths leak).
4. **Model entity renderer.** `model-entity-renderer.js` + a stubbed diff/sync test
   with a fake `loadAsset` (new id adds, removed id disposes, transform update
   applies, entity removed mid-load is dropped). Extract the shared `prepareModelRoot`
   builder from `world-models.js`.
5. **`world-models.js` refactor.** Placement emits intents; transform/delete emit
   intents; "Placed models" list reads the registry; preview stays local. Keep the
   panel usable in solo (intents applied locally, no upload).
6. **`environment-viewer.html` wiring.** Register the type, add the binder + guest
   pending array + host render list + per-frame sync, `applyModelIntent`, the
   `entity_intent` action dispatch, `ensureAssetUploaded`, and the panel net hooks.
7. **Docs + log.** Update `docs/subsystems/multiplayer.md` (new "Model entities +
   asset transport" subsection under the entity-registry section; add rows for
   `entity-types/model.js`, `model-entity-renderer.js`, `server/asset-store.js`,
   `world-models.js`). `world-models.js` has no subsystem doc home today — file it
   under the multiplayer/entity section that now owns its replication, and note the
   local-editor half. Append an `agent_log.csv` row.

Each numbered step is independently testable in Node except 5–6 (browser-only); those
are verified by running the app host+guest.

## Tests

- `server/test-asset-store.mjs` — store logic (see step 1).
- `test-model-entity.mjs` — adapter create/serialize (see step 3).
- `test-model-entity-renderer.mjs` — diff/sync with a fake loader + THREE stub.
- Registry test extension — model cap group.
- Not automated (documented as such, same as the existing WS gaps): the HTTP
  endpoints end-to-end, the upload race, and real GLTF parsing.

## Limitations / out of scope for v1

- **Host-browser authoritative, relay still dumb** — the relay stores/serves asset
  bytes and blind-forwards intents/entities; it does not own model state. Same
  posture as lights (multiplayer.md §9).
- **Eviction is not re-served.** If the LRU evicts an asset and no client re-uploads,
  peers that lack it get a `404` after retries and the model shows a placeholder /
  fails to load. No "who has hash X, re-upload" protocol in v1. The 256 MiB cap is
  sized to make this rare for a workshop-scale world.
- **No persistence.** The relay's asset store is in-memory and dies with the process,
  like the room registry. A relay restart drops all placed-model assets.
- **Snap-to-ground is baked at placement.** Terrain edits after placement do not
  re-snap existing models.
- **No delta/interest management** — full entity snapshots every tick, inherited from
  the current entity-registry milestone.
- No per-asset auth; the content hash is the only integrity gate. DoS by filling the
  store is bounded by the caps, not prevented.
