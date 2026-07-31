# Multiplayer

> 🗺️ [View this subsystem in the interactive code map](../../code-map.html#multiplayer)

## Purpose

Optional two-role multiplayer mode layered on top of the single-player sim. One browser tab
becomes the **host**: it runs the real creature simulation and broadcasts a snapshot of world
state 20 times/second over a WebSocket relay. Any number of other tabs can **join** as
**guests**: they don't simulate anything locally — they receive host snapshots, smooth them
with a small interpolation buffer, and render lightweight "ghost" meshes (boxes for creatures,
capsules for players) at the interpolated positions. A small Node relay server pairs hosts and
guests by a short room code; it never touches simulation logic, it only forwards JSON messages
between sockets in a room.
Player avatars are synced as capsule poses: the host includes its own walk-mode capsule plus
the latest guest capsules in each snapshot, and guests send their local `player_state` to the
host at the same 20 Hz cadence after the spawn capsule is initialized.

## Files

| File | Responsibility | Lines |
|---|---|---|
| `multiplayer.js` | Client-side networking: `RELAY_URL`, `InterpolationBuffer` (now interpolates `entities` via `_lerpEntities`, incl. `spawnedFrom`), `createHostSession` (has `broadcast`, plus the `hostBroadcastTick`/`shouldSendSnapshot`/`HOST_MAX_BUFFERED_BYTES` backpressure guard), `createGuestSession`, `GhostRenderer` | ~737 |
| `entity-registry.js`, `entity-types/light.js`, `entity-types/projectile.js`, `entity-types/effect.js`, `entity-types/combat-projectile.js`, `entity-types/explosion.js`, `light-entity-renderer.js`, `effect-renderer.js` | Replicated entity registry + light/projectile/effect/combat-projectile/explosion adapters + clustered-light slot binder + combat-effect (tracer/spark/fireball) renderer (see §9, §5b) | — |
| `player-hands.js` | First-person orb-hand viewmodel: `createViewHands(camera, THREE)` — your own two floating hands, camera-attached, shown only in FPS mode | 55 |
| `start-screen.js` | Pre-game modal UI: Solo/Host/Join role picker (with a "Load preset" slider-state dropdown), map picker, loading screen; resolves `{ mapKey, mpRole, roomCode, mpWorldMode, presetName }` before the sim boots. `showStartScreen(resumeConfig, { mazeLayouts })` opt-in adds a Maze Layouts card (harness-exported pcw-layout worlds from `maze layouts/`, listed via serve.py) that resolves `layout:<path>` mapKeys — only `environment-viewer-v2.html` decodes those, so v1 keeps the flag off | 305 |
| `server/server.js` | Relay backend (Node, `ws` library + built-in `http`): room registry, host↔guest message forwarding (with per-guest send backpressure via `server/backpressure.js`), room presence queries, plus an `/api/publish-map` HTTP endpoint (`server/publish-map.js`) that commits hosted map exports to GitHub | 106 |
| `server/backpressure.js` | Pure `guestSendVerdict(bufferedAmount, isSimState)` → `'send'\|'skip'\|'kill'`: the relay's two-tier per-guest flow control (skip superseded `sim_state` at `RELAY_GUEST_SKIP_BYTES` = 1 MiB, terminate at `RELAY_GUEST_KILL_BYTES` = 8 MiB). Node-testable, socket-free. | 36 |
| `server/publish-map.js` | Pure validation/merge helpers (`validateSegment`, `validateSecret`, `mergeMapConfig`) plus `publishMap`'s GitHub Git Data API orchestration and `handlePublishRequest`'s HTTP glue | 190 |

Deployment context: `server/package.json` declares `ws` as the only dependency and `npm start`
runs `node server.js`. `server/render.yaml` deploys it as a Render web service named
`creature-relay` (root dir `server`, `npm install` / `npm start`, `PORT` from a Render env group).

### Hosted map publishing (`server/publish-map.js`)

`terrain-generator-v4.html`'s density panel can export a map two ways: a local
`serve.py` `/api/save-map` POST (unchanged, for local iteration), or a "Publish to game"
button that POSTs the same payload to this relay's `/api/publish-map` endpoint. The
relay commits the GLB, `-data.json`, and an updated `map-config.json` directly to the
GitHub repo via the Git Data API (one atomic commit: read the branch ref/tree, create
three blobs, create a tree, create a commit, fast-forward the ref — retried once on a
non-fast-forward conflict), which lands on `sp1-webgpu-renderer-migration` and triggers
the same automatic GitHub Pages rebuild that any other push does.

Security is a single shared secret (`X-Export-Key` header, checked against the
`EXPORT_SECRET` env var with a constant-time compare) — there's no per-user auth, no
origin restriction (CORS is `Access-Control-Allow-Origin: *`, since the secret is the
actual gate). Required env vars on the Render service: `EXPORT_SECRET`, `GITHUB_TOKEN`
(a repo-scoped PAT), `GITHUB_REPO`, `GITHUB_BRANCH`. See
`docs/superpowers/specs/2026-07-03-relay-map-publish-design.md` for the full design.

## Public API

### `multiplayer.js`

- `export const RELAY_URL` — `wss://workshop-webgpu.onrender.com` by default, overridable via the
  `?relay=wss://...` query param.
- `export class InterpolationBuffer` — ring buffer of up to 3 timestamped snapshots.
  - `push(state: object, t = performance.now())`
  - `sample(renderTime: number): object | null` — returns the snapshot at `renderTime`, lerped
    between the two bracketing entries (clamped to the first/last snapshot outside the range,
    `null` if empty).
- `export function createHostSession(roomCode: string, mapKey: string|null, getState: () => object): { destroy(): void }`
  — opens a WebSocket, sends `{type:'host', room, mapKey}`, then broadcasts
  `{type:'sim_state', seq, ...getState()}` every 50 ms (`BROADCAST_MS`, 20 Hz). Incoming messages
  are re-dispatched as `window` `CustomEvent('mp:guest_input', {detail: msg})`. Auto-reconnects
  with exponential backoff (1 s → 30 s cap).
  - **Host backpressure guard.** Each tick runs through `hostBroadcastTick(ws, getState, sendFrame,
    onSkip)`: if `ws.bufferedAmount` exceeds `HOST_MAX_BUFFERED_BYTES` (128 KiB ≈ 1–2 worst-case
    frames) the tick is **skipped before `getState()` is called** and `seq` does not advance. This
    is the fix for the host→guest head-of-line jam under high creature counts: `ws.send()` never
    blocks, so without this a saturated uplink grows an unbounded send buffer and — because every
    host→guest world event (avatar, lights, roster) rides the one ordered socket inside `sim_state`
    — freezes all of them together while guest→host input stays fine. Skipping coalesces to the next
    fresh snapshot (never a stale queued one); it never terminates (this socket is the host's only
    link, and reconnect already exists). The skip **must** precede `getState()` because `getState()`
    has send-marking side effects — `entityRegistry.snapshot()` drains removal tombstones and the
    shared settings/config packet makers stamp themselves sent — so a built-but-unsent frame would
    silently lose data. A throttled (≤ once / 2 s) `window` `CustomEvent('mp:backpressure',
    {detail:{skippedTicks, bufferedAmount}})` surfaces saturation instead of failing silently.
    `shouldSendSnapshot(bufferedAmount, limit)` is the exported pure predicate. Full analysis:
    `multiplayer-jam-analysis/plan.md`. Add `?netstats` to the URL to log the actual `sim_state`
    byte size, creature count, and `bufferedAmount` once every 2 s from the host — use it to size
    real frames before deciding whether the deferred payload-reduction work (rate split, interest
    scoping, deltas) is warranted.
- `export function createGuestSession(roomCode: string, onState: (state: object) => void): { sendInput(msg: object): void, destroy(): void }`
  — opens a WebSocket, sends `{type:'join', room}`. `sim_state` messages are pushed into an
  internal `InterpolationBuffer`; every other message type is re-dispatched as
  `CustomEvent('mp:' + msg.type, {detail: msg})`. Runs its own `requestAnimationFrame` loop that
  samples the buffer at `now - 100ms` (fixed interpolation delay) and calls `onState(state)`.
  Same reconnect backoff as the host.
- `export class GhostRenderer` — `constructor(scene, THREE, options = {})` (THREE passed in, not
  statically imported, so the module stays importable from plain Node for tests). `options`:
  - `terrainHeight(x, z) -> y` — default `() => 0`. Forwarded to `createProceduralPlayerBody` for
    foot planting; `environment-viewer.html` does not wire the real terrain sampler in yet (Wave
    2/B1 is flag-gated off by default, so this is currently inert in production).
  - `useProceduralBody` — default `false`. **Feature flag, constructor-only today.** When `false`
    (unchanged default), `GhostRenderer` behaves exactly as before — capsule + eyes + orb hands, no
    procedural body work runs at all. When `true`, each remote player also gets a
    `createProceduralPlayerBody({ THREE, scene, terrainHeight, mode: 'remote' })` instance (see
    `docs/subsystems/procedural-body-weapon-contracts.md` Contract 2 and `player-procedural-body.js`)
    and the old capsule/eyes/orb-hands meshes are hidden (`visible = false`) rather than skipped, so
    flipping the flag back would still render correctly — they are just never unhidden today since
    the flag is read once at construction.
  - `getCameraPos` / `botLod` (2026-07-19) — bots-only render LOD. `getCameraPos()` returns the
    camera position; `botLod` is `{ nearD2, midD2, hideD2 }` (squared distances). `_updateProceduralBodyLod`
    strides the procedural solve by distance (every frame / 2nd / 4th, staggered by a per-ghost
    `lodPhase`) and hides bodies past `hideD2`. Humans/local and dead actors always take the full path.
  - `instanceBots` (2026-07-19) — default `false`. When `true`, bot bodies render through a shared
    `InstancedMesh` pool (`body-part-batches.js`) instead of ~31 meshes each: draw calls become ~one
    per part type total, independent of bot count. Lazily builds one `_bodyBatches` on the first bot;
    `_updatePlayers` wraps its loop in `beginFrame()`/`endFrame()`; each visible bot flushes every
    frame (even on IK-strided frames — the held pose persists) and hidden bots are simply not flushed.
    Per-bot color comes from `botBodyStyle(THREE, id, team)` (see "Bot team colors"). **Bots only** —
    humans/local keep the per-mesh path. See `docs/subsystems/bots.md` "Phase 4 perf".
  - `ragdollDeaths` / `maxLiveRagdolls` (2026-07-30) — default `true` / `12`. See "Bot death
    ragdolls" below.
  - `overlayHideD2` (2026-07-30) — squared XZ distance past which overhead health bars / alert marks
    are hidden. Defaults to `min(60², botLod.hideD2)`. See "Overhead indicators" below.
  - `playerGroups()` (2026-07-15) — read-only accessor returning the live `id -> Group` map
    `_updatePlayers` maintains, for external raycasting/inspection. Used by `environment-viewer.html`'s
    bot inspector (`docs/subsystems/bots.md`) to Alt+Click-select a bot in the scene; the id also
    identifies guest players (both share this same map), so callers filtering to bots only should
    check the id against their own `botPlayers` map.
  - `update(state: { creatures?: [], players?: [] })` — creatures reuse one semi-transparent box
    `Mesh` per id via the generic `_updateSet`. Players go through `_updatePlayers`: each is a
    `Group` container (positioned/oriented by `p`/`q`) holding a **solid** capsule body (a
    per-player `MeshStandardMaterial` cloned from the off-white template and tinted a light pastel
    keyed by an id hash, so players are easy to tell apart; disposed on removal) plus two
    flat-black eye `Mesh`es (each with a small white glint `Mesh` parented to it) on the
    container's local **-Z** (forward) face — the player's `q` is pure yaw, so the eyes point where
    they look. Eyes sit high on the body (`h * 0.42`). Body keeps the `h`/`r` scale; eyes are
    placed/sized from `h`/`r` in `_placeEyes` so they stay round despite the body's non-uniform
    scale; glints are in eye-local space so they close with the eye on blink. Each player also gets
    two floating **orb hands** (shared sphere geo, tinted with the same per-player body material)
    placed to the sides in front by `_placeHands`. Ids no longer present are removed (also destroys
    that player's `bodyProc`, if any).
  - **Death pose** (2026-07-14, capsule path only — the procedural-body path already had its own
    `alive`-gated collapse, see below): when `item.alive === false`, the fall is animated smoothly
    over `FALL_MS` (450ms), not snapped. `_updatePlayers` edge-detects the alive→dead transition,
    captures the container's current (upright) quaternion/position into `userData.fallFromQ/P`
    once, and keeps `userData.fallTargetQ/P` refreshed with the resting pose every call (tipping
    the upright yaw quaternion -90° around its own local X axis via `_fallTipQ`, built once in the
    constructor, so the capsule falls face-forward along whatever direction it was last facing,
    and dropping from mid-capsule height to resting-on-side height, `py - h/2 + r`) — but it never
    writes `g.quaternion`/`g.position` directly while dead. `tick(nowMs)` owns the actual visible
    transform while `userData.dead` is set: it lazily starts `userData.fallStartAt` on the first
    tick after death, then `slerp`/`lerpVectors`s from `fallFrom*` to `fallTarget*` over `FALL_MS`.
    Eyes, orb hands, and the held-item placeholder are hidden while dead (`_placeHeldItem` also
    gates on `item.alive` directly). Added for combat bots (see `docs/subsystems/bots.md`) but
    applies to any pose carrying `alive: false`, capsule-mode humans included, once a caller
    supplies it — `updateHostPlayerGhosts()` currently only merges `alive` in for bots, not the
    local host or guest poses, so human capsule ghosts don't get this yet. Covered by
    `test-ghost-renderer.mjs` (its minimal THREE stub gained `Quaternion.slerp`/`Vector3.lerpVectors`
    for this).
  - **Remote procedural body (`useProceduralBody: true`)** — `_updateProceduralBody(g, item)` lazily
    creates `g.userData.bodyProc` on first sight of a player, tints it via `setTint` with the same
    `playerTintHSL` hue used for the capsule, then every `update()` call:
    - **position**: `item.p` (capsule center) passed straight through as a `THREE.Vector3` — the
      body module only uses x/z from it (for terrain sampling + gait) and takes height/radius
      separately, so no center-vs-root conversion is needed.
    - **yaw**: derived from the wire quaternion `item.q` via the general
      `atan2(2(qw·qy+qx·qz), 1-2(qy²+qz²))` formula, which reduces exactly to the stored yaw for a
      pure-Y quaternion (the documented convention for `player_state`/snapshot `q`, see the "Angle
      convention" section below) but stays correct even with roll/pitch noise.
    - **velocity**: horizontal-only, derived from the position delta since the previous call divided
      by the elapsed wall-clock time (`performance.now()`), never from a replicated velocity or feet
      — per the contracts doc's guardrail ("MP v1 derives remote gait locally from interpolated
      positions — do NOT replicate feet/hands"). This is a local gait guess, not a replay of the
      sender's real stride.
    - **aimPitch/height/radius/alive/weapon/tool**: passed through from `item.aimPitch`/`h`/`r`/
      `alive`/`weapon`/`tool` (with `h`/`r` defaulting to 1.2/0.3 like the capsule path). The body
      module hides/collapses itself when `alive === false` (Contract 2); `GhostRenderer` does not
      duplicate that check.
    - Arm posing (weapon-aim IK via `setArmTarget`) is **not** wired here — arms idle per the body's
      own gait pose. That is a later follow-up; the held-gun placeholder box from the capsule path
      is left visible and unchanged in the meantime.
    - `destroy()` and the per-id removal path both call `bodyProc.destroy()` before dropping the
      player, so nothing leaks when a player disconnects or the whole renderer is torn down.
  - `tick(nowMs)` — per-frame driver (must be called each frame; `update()` only runs on network
    events). Squashes each player's eye `scale.y` 1→~0.1→1 over `BLINK_MS` (120 ms) on an
    independent 3–6 s timer, staggered by an id hash; also animates the orb hands with an idle bob
    plus a fore/aft walk-sway whose amplitude scales with horizontal speed (estimated from the
    container's position delta between ticks). Called from `animate()` in `environment-viewer.html`
    as `mpGhostRenderer?.tick(now)`.
  - `destroy()` — removes and disposes all ghost meshes/geometries/materials (incl. eye geo/mat, orb
    hands share the body geo/material).
- `export function playerTintHSL(id): [h, s, l]` — deterministic light-pastel tint (in 0..1) for a
  player id. Used by `GhostRenderer` for the body + orbs and by the local FPS viewmodel
  (`player-hands.js`) so your own hands match your own ghost.
- `export const BOT_TEAM_STYLES` — see "Bot team colors" below.

#### Bot team colors (2026-07-30, Phase E)

`botBodyStyle(THREE, id, team)` now returns a **team** palette instead of a per-id hue, and both the
instanced and the mesh bot path use it (previously only the instanced path was colored; mesh bots all
shared one fixed dark green).

| team | shell | plate | trim |
|---|---|---|---|
| `alpha` | `0x1f5b3a` | `0x101410` | `0x57d68d` |
| `bravo` | `0x64252a` | `0x171012` | `0xff8a80` |

Values mirror `bot-viewer-v2.html`'s authored `BOT_TEAM_DEFS` (its `facing` color becomes the ghost
body's `trim` slot) so a bot reads as the same side in both viewers. Each bot's three colors are
scaled by an id-keyed brightness factor in `0.86 .. 1.14` (`_shadeHex`), so a squad reads as one
family while individuals stay distinguishable. A pose with **no** `team` (an old peer, or a spawner
that never stamped one) falls back to the original distinct-hue-per-id scheme, so nothing regresses.
Humans and the local player are untouched — they still use `playerTintHSL`.

#### Bot death ragdolls (2026-07-30, Phase E)

Bots no longer use the canned `FALL_MS` tip-over; they flop with the real solver (`ragdoll.js` +
`ragdoll-body.js`, both pure/Node-tested and imported statically — neither touches THREE at import
time). Humans and any capsule-mode actor keep the tip-over unchanged.

- **Start** (`_startBotRagdoll`, on the alive→dead edge): `ragdollFromBody(THREE, ud.bodyProc, …)`
  seeds 16 Verlet particles from the rig's **live joint world positions**, so the corpse flops from
  the pose it died in. Then `applyDeathImpulse` kicks it along `item.deathImpulse` (the replicated
  shot-travel vector, magnitude = m/s, capped at 18); with none stamped it falls back to the pose's
  `velocity`, and failing that to a 4 m/s shove down its facing axis so it never falls perfectly straight.
  Bails to the tip-over if there is no `bodyProc` to seed from (procedural bodies off, or the bot
  never rendered) or the live budget is full.
- **Step** (`_stepBotRagdoll`): one `stepRagdoll` per frame with `{ gravity: 25, groundHeight:
  terrainHeight }` — corpses settle onto real terrain via the sampler the renderer already holds. `dt`
  is the renderer's own wall clock, clamped to `RAGDOLL_MAX_DT` (50 ms) so a stalled frame can't
  spiral the solver.
- **Sleep** (harness parity): once `kineticEnergy` has stayed under `RAGDOLL_SLEEP_ENERGY` (1e-4) for
  `RAGDOLL_SLEEP_MS` (500 ms) the corpse stops simulating and holds its final pose. Sleeping corpses
  also skip the per-frame `setRagdollPose` and flush with `refreshMatrices = false` (reusing last
  frame's world matrices), so a settled body costs only its instanced-batch re-add.
- **Budget**: `_ragdollAwake` is an exact count of corpses still being stepped, maintained on start /
  sleep / retire. A death while `_ragdollAwake >= maxLiveRagdolls` (12) silently falls back to the
  tip-over, so a simultaneous wipe degrades instead of stalling the frame.
- **Instanced path**: fully supported, no per-corpse mesh fallback. `player-procedural-body.js`'s
  `setRagdollPose` writes the same part transforms `update()` does (world-space, `group` at identity),
  and `flush(pool)` walks the same placeholders — so a corpse rides the shared `InstancedMesh` pool
  exactly like a living bot. `_updateProceduralBodyLod` gains a corpse branch (ahead of the gait/LOD
  logic) that poses from the solver instead of the IK solve and still obeys `botLod.hideD2`.
- **Lifecycle**: `_retireRagdoll` drops the solver on respawn into the same ghost id and on despawn,
  releasing the budget slot; it also nulls `bodyLastT`/`bodyLastPos` so the first live frame back
  doesn't feed `bodyProc.update()` a multi-second `dt` (the gait solve is skipped for a corpse's whole
  life, so that clock would otherwise be stale by the full respawn delay).
- `tick(nowMs)`'s tip-over animation is gated on `!ud.ragdoll`, so it never fights the solver for the
  container transform.

#### Overhead indicators (2026-07-30, Phase E)

`_updateOverlays(g, item, r, h)` draws a health bar + alert "!" above **bot** ghosts (host, solo, and
guest all get them, since both render paths go through `_updatePlayers`). Humans/local carry neither.

- **Data sources, all already on the wire**: `hp`/`maxHp` (added to `updateHostPlayerGhosts`'s bot
  poses from `playerCombat.getSnapshot`; the guest path already had them via
  `mergePlayerCombatFields` inside `getState()`), `alive`, and the new `alertTier` wire field.
- **Health bar**: shown only while alive **and** damaged (`hp01 < 0.999`). Fill scales on X and
  left-anchors (`position.x = -0.35·(1-hp01)`); its material is swapped between three shared
  materials at the harness's thresholds (green > 0.55, amber > 0.30, red below).
- **Alert "!"**: bar + dot, shown while `alertTier` is set and the bot is alive. Colors are the
  harness's `ALERT_MARK_COLORS` — `seen` red `0xff5252`, `heard` amber `0xffd93d`, `push` green
  `0x66ff66`, `near` cyan `0x4fc3f7`, `base` white. The escalation-score digit (a canvas texture in
  the harness) is **not** ported.
- **Billboarding without a camera quaternion**: the group is a child of the ghost container, so its
  orientation is built from the two positions the renderer already has — yaw `atan2(dx, dz)` minus the
  container's own yaw, then pitch about local X. No new constructor option, no per-frame allocation
  (two scratch quaternions + two axis vectors live on the renderer).
- **Cost**: geometry/materials are shared and built lazily on the first bot that needs one, so a
  renderer with no bots (and the Node tests' minimal THREE stub) never allocates them; box — not
  plane — geometry keeps the stub usable. One `Group` per bot, created the first time that bot is
  damaged or alerted, freed with its container. Hidden past `overlayHideD2`.

### `player-hands.js`

- `export function createViewHands(camera, THREE): { setTint(hsl), setVisible(v), recoil(), update(dt, {speed, charge}), destroy() }`
  — the local player's first-person orb-hand viewmodel. In FPS mode your own capsule isn't drawn,
  so this builds a `Group` of two orb `Mesh`es and `camera.add(group)`s it, so the orbs live in
  camera-local space and follow head look. `update` applies an idle bob + a `speed`-scaled fore/aft
  sway (matching the remote orbs); it also reacts to the light gun — `charge` (0..1) draws the hands
  up and inward while charging, and `recoil()` fires a short kick (back + up, decays over ~0.18 s)
  called when the gun shoots or places. `setVisible` toggles it (shown only in FPS), `setTint`
  colors it from `playerTintHSL(localId)`. **Requires the camera to be in the scene graph** — the
  entry point calls `scene.add(camera)` for this. THREE is passed in (Node-testable, same as
  `GhostRenderer`).

### `start-screen.js`

- `export async function showStartScreen(): Promise<{ mapKey, mpRole, roomCode, mpWorldMode, presetName, setStatus(msg), dismiss() }>`
  — builds a full-screen DOM overlay (no Three.js dependency), walks the user through: role
  choice (Solo / Host / Join), each with a "Load preset" dropdown (populated from
  `slider-state.js`'s `listStates()`) that sets `presetName` (or `null` for "None") → map choice
  (host/solo only — guests inherit the host's map) → a loading panel, then resolves with the
  chosen role/room/map/world-mode/preset and helpers to update the loading status text or dismiss
  the overlay. Internally fetches `maps/map-config.json` for the map list and, for Join, opens a
  short-lived WebSocket to query room presence (`{type:'query', room}`) before resolving. Also
  starts a standalone menu-music `<audio>` loop for the role/map picker (stopped before the loading
  step) — see `docs/subsystems/audio.md` "Start-screen menu music" for how it reads
  `sfx/sound-map.json` independently of `environment-audio.js`.

## Wiring

`environment-viewer.html` statically imports both modules:

```js
import { showStartScreen } from './start-screen.js';
import { createHostSession, createGuestSession, GhostRenderer } from './multiplayer.js';
```

Boot sequence (top of the module, before the renderer/scene are built):

1. `const { mapKey, mpRole, roomCode, mpWorldMode, presetName, setStatus, dismiss } = await showStartScreen();`
   — blocks scene setup until the user picks a role (and map, for host/solo). The resolved
   `mapKey` is later used by `loadTerrainMap`; `presetName`, if set, is applied via
   `applySliderState(...)` at the very end of startup, right before `dismiss()` (see
   `entry-point.md`'s "Slider state presets" section — this is deferred that late because the
   slider registry isn't complete until every panel, including the async grass/water/clouds/sky
   ones, has been built).
2. `getState()` is defined to read the live `portCreatures` system and shape it into
   `{ creatures: [...], players: [...] }`. Creature entries carry `id`, `p`, `q`, `hp`, `feet`,
   and `hands`. Player entries carry `id`, `p`, `q`, plus capsule `h`/`r`. The host adds its own
   initialized walk-mode capsule as `id: 'host'` and appends the latest guest capsules received
   through `player_state` messages.
3. Role dispatch:
   - `mpRole === 'host'` -> creates a `GhostRenderer` for guest player capsules and starts
     `createHostSession(roomCode, mapKey, getState)`. The host renders only guest players as
     ghosts; local creatures remain the real simulated meshes.
   - `mpRole === 'guest'` -> `mpGhostRenderer = new GhostRenderer(scene, THREE)` and
     `mpSession = createGuestSession(...)`. The guest filters its own `clientId` out of incoming
     `players` before rendering ghosts, then sends its local capsule pose back to the host as
     `{type:'player_state', player}` every 50 ms after the spawn capsule has been initialized.
     Ghost updates happen inside `multiplayer.js`'s own `requestAnimationFrame` loop, **not** from
     the main `animate()` render loop in `environment-viewer.html` - the two rAF loops run
     independently.
   - `mpRole === 'solo'` -> no `mpSession` (no relay connection), but `mpGhostRenderer` **is**
     still constructed (2026-07-14) — combat bots are host/solo-only sim and need somewhere to
     render even with no multiplayer session; see `docs/subsystems/bots.md`.
4. `window.addEventListener('mp:guest_input', ...)` on the host side stores `player_state`, removes
   `guest_left` capsules, and still handles `set_target` / `set_behavior` messages forwarded from
   guests by applying them to `portCreatures.system`.

**Host/solo ghost refresh cadence** (2026-07-27): `updateHostPlayerGhosts()` — the O(N) pass that
rebuilds the bot/guest wire poses and drives `GhostRenderer.update()` (including the near-LOD
procedural-body IK) — runs **exactly once per frame**, at the end of `updateBots()`
(`environment-viewer.html`), just before `syncEnvironmentBotWeaponMounts()` reads the bodies it
drove. Everything that used to call it mid-frame now sets `hostGhostsDirty = true` instead:
`syncMultiplayerPlayer`'s host branch, the `player_state` / `guest_left` branches of
`mp:guest_input`, `spawnBotAt`, `despawnBot`, and both returns of `applyCombatIntent`. The last one
was the reason: `botFire` routes every bot bullet through `applyCombatIntent`, so a firefight ran
the whole pass N+1 times per frame (perf review 2026-07-27, finding 21). The flush is skipped only
when nothing is dirty **and** there are no bots — live bots move every tick, so their presence alone
dirties it. Guests are unaffected: `updateHostPlayerGhosts` and `updateBots` share the same
`mpRole !== 'guest'` gate, and guest ghosts are still driven from the `sim_state` receive handler.

`start-screen.js` → `multiplayer.js` connection: the Join flow's `_queryRoom()` opens a one-off
`WebSocket(RELAY_URL)` (imported from `multiplayer.js`) to ask the relay `{type:'query', room}`
and get back `{hasHost, mapKey}` before handing control to `environment-viewer.html`'s session
creation.

**Client ↔ relay protocol** (plain WebSocket, JSON-text frames, no binary/compression):
- Host → relay: `{type:'host', room, mapKey}`, then repeated `{type:'sim_state', seq, creatures, players, entities, worldMode}` at 20 Hz, plus **change-driven** `{type:'creature_config', version, config}` and `{type:'world_settings', version, values}`. The last two are the large, O(creatures) static identity / settings payloads: they are sent as their **own messages, only when they actually change** (and force-resent when a guest joins), NOT bundled into `sim_state` and NOT on a timer — this keeps the 20 Hz frame small and keeps config off the frame-skippable path (see the backpressure notes). Change detection runs at ~1 Hz on the host, not per broadcast tick.
- Guest → relay: `{type:'join', room}`, `{type:'query', room}`, `{type:'player_state', player}`, or arbitrary input messages (e.g. `{type:'set_target', pos}`, `{type:'set_behavior', behavior}`).
- Relay → guest: `{type:'joined', clientId, guestCount, mapKey}`, `{type:'host_joined'}`, `{type:'host_left'}`, forwarded `sim_state` frames, and the forwarded `creature_config` / `world_settings` messages (re-dispatched guest-side as `mp:creature_config` / `mp:world_settings` events).
- Relay → host: forwarded guest messages tagged with `{..., clientId}`, plus `{type:'guest_joined', clientId}` / `{type:'guest_left', clientId}`.
- Relay → query sender: `{type:'room_info', hasHost, mapKey}`.

## Friend finder HUD (compass strip + minimap)

`createMultiplayerFinder()` in `environment-viewer.html` (near the session setup) builds a small
fixed 240px canvas panel (bottom-left, `#mp-dock` anchored `bottom:46px` so it clears the
`#perf-log` bar below it) with three parts: a horizontal compass strip across the top, a heading-up
minimap below it (240×232 canvas; concentric range rings; radar radius `R` and rings scale off the
canvas height), and a Track button that cycles which remote player is highlighted/labelled. It is
redrawn every frame from `animate()` via `updateMultiplayerFinder()`, reading
`multiplayerLocalPlayer()` and `multiplayerRemotePlayers()` (host: latest `player_state` from guests;
guest: the snapshot's `players` minus itself).

**Zoom.** The radar view radius (`view`, world units mapped to `R` px) is a closure variable clamped
to `[MIN_VIEW=40, MAX_VIEW=600]`, default 140. A `+`/`−` control overlaid in the map's bottom-right
corner and the scroll wheel over the canvas both drive it via `zoomBy(factor)`; the wheel handler
calls `preventDefault`/`stopPropagation` so it does not also dolly the main camera.

**Availability.** In multiplayer the panel always shows. In **solo** it shows only when an authored
map is loaded (so the terrain minimap is useful); the Track button/label row is hidden since there
are no friends. When an authored map is present the minimap draws a heading-up terrain background
under the rings and arrows, and pressing **M** opens a north-up full-screen map. Both are provided by
`world-map.js` — see its "World map HUD" section in `infra.md`. The terrain blit reuses the finder's
own marker projection (`minimapImageAffine`, with `s = R/view`) so terrain and friend dots stay
aligned as the view turns.

**Layer picker.** The minimap lives in an `#mp-dock` flex row (top-aligned) with a **Layers** tab nub
on its right edge, pinned to the canvas height so it lines up flush with the map even when the Track
row makes the finder taller; clicking it slides out `#mp-map-menu` listing the data overlays from
`MAP_OVERLAYS`
(biome/elevation/slope/material/water/grass/tree). Picking one sets `mapOverlayId`, re-bakes via
`rebakeWorldMap()`, and both the minimap and the M map switch to it. Reach the menu with the mouse by
pressing **Q** (cursor-free pause — see `entry-point.md`), which frees the cursor without leaving the
first-person view.

**Angle convention — the one thing to get right when touching this code.** Every angle in the
finder is a clockwise compass bearing with **N = +Z and E = −X** (in three.js Y-up world coords a
clockwise compass with N = +Z necessarily puts E at −X):

- `playerViewHeading()` — the camera's view heading in this convention
  (`-atan2(dir.x, dir.z)`). Spawn faces +Z and reads N.
- `worldBearing(dx, dz)` — converts a world-space XZ offset to a bearing in this convention
  (`-atan2(dx, dz)`). All position-derived bearings (tracked-friend arrow, minimap markers, the
  distance/degrees label) must go through it. A bare `atan2(dx, dz)` is the opposite handedness:
  it mirrors markers east/west, and because the error is `-2×heading` a marker for a friend you
  are looking at slides the wrong way at twice your turn rate.
- `playerForwardBearing(player)` — a remote player's facing (`π − yaw` from their wire
  quaternion), already in this convention.
- `screenRelativeBearing(bearing, heading)` — bearing − heading, normalized; 0 = strip center /
  minimap up, positive = right of view.

The wire `q` in `player_state` is built from `camera.rotation.y`, which is only a valid yaw with
Euler order `YXZ` — set once at camera creation (a `lookAt`-driven camera on the default `XYZ`
order decodes a yaw folded into ±90°, so orbit-mode players would broadcast a wrong facing for
half the circle). The ghost eyes in `GhostRenderer` point along the same quaternion, so this
order requirement protects both the finder arrows and the in-world ghost facing.

## Architecture notes

- **Host-authoritative, server-dumb relay.** `server/server.js` holds no simulation state beyond
  a `rooms: Map<code, {host, mapKey, guests}>` registry (server.js:6) and forwards
  whatever JSON the host/guests send — it never inspects `sim_state` contents. The one flow-control
  exception: the host→guests loop applies `guestSendVerdict` (`server/backpressure.js`) per guest,
  so a guest whose socket isn't draining gets its superseded `sim_state` frames skipped (past 1 MiB
  buffered) or its socket terminated (past 8 MiB) rather than growing unbounded buffer in the relay
  process; each guest send is wrapped in its own try/catch so one bad socket can't stall the loop.
  This is the relay-side half of the backpressure fix (the host-side guard can't see the relay→guest
  hop). All physics/AI runs only on the host's machine; guests are pure read-only spectators of
  interpolated ghosts.
- **Snapshot interpolation, not extrapolation/prediction.** `InterpolationBuffer` keeps just the
  last 3 snapshots and linearly interpolates position/quaternion (slerp) and HP between the two
  bracketing entries; it clamps to the nearest end outside the buffered range rather than
  extrapolating. `createGuestSession` deliberately samples `now - 100ms` to stay inside the
  buffered window most of the time, trading 100 ms of extra latency for smoothness against the
  host's 50 ms broadcast cadence.
  Convention enforced by both server and `GhostRenderer`: vectors are plain `[x,y,z]` /
  `[x,y,z,w]` quaternion arrays, not `THREE.Vector3`/`Quaternion` instances — `GhostRenderer` and
  `_lerpV3`/`_slerpQ` destructure them positionally. Player interpolation matches snapshots by
  `id`, not array index, so host/guest ordering changes do not cross-wire avatars.
- **No reconciliation/ownership conflicts.** There's exactly one host per room (`r.host` is a
  single `WebSocket`, not a set); a second `{type:'host'}` for the same room silently replaces
  the previous host reference with no kick/handoff message.
  Room lifecycle: `pruneRoom` deletes a room once both `host` is null and `guests` is empty
  (server.js:13-16), so empty rooms don't leak in the `rooms` map.
- **`GhostRenderer` is test-friendly by construction** — `THREE` is passed into the constructor
  instead of imported at module scope specifically so `multiplayer.js` can be loaded under plain
  Node without a DOM/WebGPU context (see `multiplayer-test.mjs`).

## Tests

`multiplayer-test.mjs` (repo root, run via plain `node`, no test framework/assertion library —
uses `console.assert` + manual exit) imports only `InterpolationBuffer` from `multiplayer.js`
and checks:
- Two pushed snapshots (creature moving x=0→10, hp 1.0→0.5 over t=1000→1100ms) sampled at the
  midpoint (t=1050) linearly interpolate position (`x=5`) and `hp` (`0.75`).
- Player snapshots interpolate by matching `id` even when the host and guest entries arrive in
  different array orders, including capsule height interpolation.
- Sampling before the first snapshot (t=900) clamps to the first snapshot's state.
- Sampling after the last snapshot (t=1200) clamps to the last snapshot's state.
- An empty buffer's `sample()` returns `null`.

It does **not** test `createGuestSession`, the WebSocket protocol, or slerp
correctness — those are unverified by automated tests.

`test-ghost-renderer.mjs` (repo root, plain `node`, minimal `THREE` stub) covers `GhostRenderer`'s
player path: the container holds a solid body + two forward-facing eyes, `tick()` squashes then
reopens the eyes across a blink window, absent ids are removed, and `destroy()` disposes the shared
eye geo/material.

`test-host-backpressure.mjs` (repo root, plain `node`) covers the host guard: `shouldSendSnapshot`
boundaries, and a fake-socket drive of `hostBroadcastTick` asserting sends stop while
`bufferedAmount` is held above the limit, resume after it drops, and — load-bearing — that
`getState` is **not** called on a skipped tick (pins the skip-before-`getState` ordering).

`server/test-backpressure.mjs` (plain `node`) unit-tests `guestSendVerdict` boundaries at both caps
and for `sim_state` vs. other frame types. `server/test-relay.mjs` (needs a running relay on
`ws://localhost:8080`) is the end-to-end forwarding integration test.

## Multiplayer Reframe: From Relay Session to Shared World

The current multiplayer implementation should be treated as a useful prototype layer, not as a complete multiplayer world model. It proves room joining, host snapshots, guest rendering, and basic player presence. It does not yet provide the core subsystems required for a durable shared world.

The main design problem is that the browser host is the real authority. The Node server is only a relay: it stores room membership and forwards JSON messages, but it does not own world state, entities, lifecycle, mutations, simulation, permissions, or conflict resolution.

### Present Subsystems

#### 1. Room Directory and Relay

Status: implemented.

Files: `server/server.js`, `multiplayer.js`, `start-screen.js`

Responsibilities today:

- Maintains in-memory rooms keyed by room code.
- Stores one host socket, zero or more guest sockets, `mapKey`, and `worldMode`.
- Lets guests query whether a room exists before joining.
- Forwards host messages to all guests.
- Forwards guest messages to the host and tags them with `clientId`.
- Notifies peers when the host or a guest disconnects.

Limitations:

- No persistence. Rooms disappear when sockets disconnect.
- No authoritative world state on the server.
- No validation of simulation messages.
- No host election, host migration, or reconnect recovery.
- A second host can replace the current host reference.

#### 2. Start Flow and Session Metadata

Status: implemented.

Files: `start-screen.js`, `environment-viewer.html`

Responsibilities today:

- Lets a player choose Solo, Host, or Join.
- Lets hosts choose a map.
- Forces guests to load the host's selected `mapKey`.
- Lets hosts choose `shared` or `independent` world settings mode.
- Displays loading state while the world boots.

Limitations:

- This only synchronizes initial session metadata.
- It does not guarantee later world consistency beyond the limited shared settings packet.
- There is no saved room/world identity beyond the current relay process.

#### 3. Host Snapshot Broadcast

Status: implemented.

Files: `environment-viewer.html`, `multiplayer.js`

Responsibilities today:

- Host calls `getState()` every 50 ms (subject to the backpressure skip).
- Host broadcasts `sim_state` snapshots at 20 Hz.
- The snapshot includes creature pose state, player capsule state, replicated entities, and world mode. Shared **creature config** and **world settings** are NO LONGER in the snapshot — they are separate change-driven `creature_config` / `world_settings` messages (`syncSharedNpcConfig` / `syncSharedWorldSettings` in `environment-viewer.html`), sent only on change or on guest-join. Previously they were bundled into every snapshot and re-sent on a 2 s / 1 s heartbeat, which made the shared creature config (large, O(creatures) static plan/style/gait data) the dominant multiplayer payload cost and — once the relay began skipping backed-up `sim_state` frames — a frame a lagging guest could miss. Add `?netstats` to log per-section `sim_state` sizes and each `creature_config` / `world_settings` send.

Limitations:

- Snapshot schema is ad hoc and manually assembled.
- It is not a general replicated entity model.
- No delta compression, interest management, binary serialization, or versioned schema.
- No server-side verification or rollback.
- No persistent history.

#### 4. Guest Snapshot Interpolation

Status: implemented.

Files: `multiplayer.js`

Responsibilities today:

- Guests buffer the last few snapshots.
- Guests render at a fixed delay behind the host.
- Creature and player poses are interpolated for smoother display.

Limitations:

- Interpolation only covers the fields explicitly handled in `_lerpState()`.
- No client prediction except local player movement being shown locally.
- No correction/reconciliation model.
- No extrapolation or recovery strategy when snapshots stall.

#### 5. Remote Player Presence

Status: partially implemented.

Files: `environment-viewer.html`, `multiplayer.js`

Responsibilities today:

- Guests send local `player_state` to the host at 20 Hz.
- Host stores the latest guest player states.
- Host includes all known player states in snapshots.
- Guests render remote players as simple capsules.
- Host renders guest capsules.

Player HP and gun combat **are** replicated (host-authoritative); see subsection 5b below. Limitations that remain:

- Player movement is not server-authoritative.
- The host accepts pose updates rather than simulating guest input.
- There is no collision authority for guests relative to shared dynamic objects.
- No inventory or general interaction/action lifecycle is replicated (beyond combat).

#### 5b. Player Combat (guns)

Status: implemented (hitscan, melee, projectile). Files: `environment-viewer.html`, `multiplayer.js`, `combat.js`, `player-combat.js`, `weapons.js`, `entity-types/combat-projectile.js`, `entity-types/explosion.js`.

**Weapon modes.** Every GLB in `models/guns/` is wired. `weapons.js` entries carry `mode: 'hitscan' | 'melee' | 'projectile'`; `applyCombatIntent` dispatches on it:
- **hitscan** (`m1911`, `five_seven`, `m24`, `cz_805_bren`): the original resolve-a-ray path below.
- **melee** (`knife`): unlimited ammo (the mag path is skipped), resolves a short `resolveWorldShot` at `weapon.range`, applies `applyHitDamage`, and draws only a `hit_spark` (no tracer) via `spawnMeleeImpact`.
- **projectile** (`grenade`, `rpg`): spawns a replicated `combat-projectile` entity (`spawnCombatProjectile`) from `weapon.projectile` (`speed/blastRadius/life/radius/gravity/arc/fuse/bounces/fizzleOnExpire`); damage is dealt on **detonation**, not at the fire call.
- **full-auto** (`cz_805_bren`, `automatic: true`): LMB-hold repeats fire. `tickAutoFire(now)` in the frame loop re-calls `fireGunFromCamera()` once `weapon.fireIntervalMs` elapses while `primaryHeld` (set/cleared in the mouse handlers + `enterCursorFree`); `validateShot`'s cooldown gate remains the host-authoritative cadence.

Protocol — guests send fire as an **intent**, never a damage claim:

```js
{ type: 'combat_intent', action: 'gun.fire', weapon: 'm1911',
  shotSeq, clientFireTime, origin:[x,y,z], dir:[x,y,z] }
```

- Host-local firing calls `applyCombatIntent(intent, 'host')`; guests call `mpSession.sendInput(intent)`, routed through the `combat_intent` branch of the `mp:guest_input` handler.
- `applyCombatIntent` validates (`combat.js:validateShot`: shooter alive, weapon equipped, `shotSeq` newer than `playerShotState`, cooldown elapsed, origin drift, finite dir), then resolves the shot against the **whole world** via `combat.js:resolveHitscan` and applies damage by hit `kind`.
- **World hit resolution** (`combat.js:resolveHitscan`, `environment-viewer.html:resolveWorldShot`) picks the nearest of: player capsules (`currentCombatPlayers()`), workshop-creature capsules (`creatureCombatCapsules()` — `portCreatures` bodies, host/solo only), ClaudeCraft mob capsules (`claudecraftCreatures.mobCombatCapsules()`, host/solo only), obstacle columns (tree `trunkIndex` + rock/log `dressingIndexRef` `{x,z,r}` circles, built into vertical cylinders by `obstacleColumnsAlongRay`), and terrain (`raymarchTerrainHit` over `terrainHeight`). Nearest-wins gives **terrain/obstacle occlusion for free** — shots no longer pass through ground, trees, or rocks. Returns `{ kind:'player'|'creature'|'mob'|'obstacle'|'terrain'|'none', id, point, normal, distance }`.
- Damage routing: `kind:'player'` → `player-combat.js` facade `applyDamage`; `kind:'creature'` → the hit `portCreatures` body's `takeDamage(weapon.damage)`; `kind:'mob'` → `claudecraftCreatures.damageMob(id, { amount, attackerId })`, which runs the sim's real `sim.dealDamage(shooterEntity, mob, …, 'physical', 'Gunfire', 'hit')` path so threat/death/loot are handled and the mob aggros the shooter. Player HP authority is the host-owned `createPlayerCombatFacade` (delegates to the ClaudeCraft bridge when creatures are active so gun and mob damage share one player HP pool; host-owned fallback map otherwise). Gun code never mutates player/mob HP directly.
- Mob hit capsules (`claudecraft-bridge/claudecraft-creatures.js:mobCombatCapsules`) are world-space, height `SIM_HUMANOID_HEIGHT·SCALE·mobScale` (matches the render sizing), radius `0.3·height`, centred at `feet + h/2`.
- **Leash/heal guard:** the sim full-heals a mob when it leashes home (`resetEvadingMob`), so a ranged shot would just aggro a mob that runs back to spawn and resets to full HP. `damageMob` therefore tags the hit mob (`gunTag`, 6 s, refreshed per hit): while tagged, `pinGunTaggedLeashes()` re-pins its leash anchor to its own position each sim tick (so the chase-state leash check never trips → no evade→heal), pulls it out of any `evade` state (which is otherwise damage-immune), and forces `aggroTargetId`/`chase` onto the shooter. Result: sustained OR sparse gunfire reliably whittles the mob down and kills it instead of it healing between shots.
- **Replicated combat effects** (`entity-types/effect.js` `EffectEntity`, `effect-renderer.js`): `gun_tracer` (muzzle→impact line), `hit_spark` (surface-tinted rays + a dust puff on world surfaces), and `explosion` (layered blast) are **replicated** — host-spawned, riding `entityRegistry.snapshot()` like lights, so every client renders an identical result from one tiny wire object per effect. `muzzle_flash` is **not replicated**: it's a local first-person view effect (like recoil) spawned in `fireGunFromCamera` via `spawnLocalMuzzleFlash` at the **actual viewmodel muzzle** (`localWeaponView.getMuzzleWorldPosition()` — an empty pinned at the weapon's baked `muzzle` anchor), NOT at the eye/shot origin, and kept small so it never fills the shooter's view. Remote players' muzzle flashes are not currently shown (their tracer already marks the shot). `effect-renderer.js` is a **port of html-game-v2's layered explosion** (fireball flash, warm shell rays, expanding shockwave ground-ring, ballistic ember dots, gravity+bounce shrapnel streaks, and dark lingering smoke): every sub-particle is regenerated each frame **deterministically** from the wire object + hashed id + wall-clock age (`firstSeen`), so no per-particle state is replicated. `firstSeen` entries are reclaimed by an **age sweep** (`SEEN_TTL_MS` 30 s, run at most every `SEEN_SWEEP_MS` 5 s), not by diffing the live list: the old per-frame `Set` of every id — plus a full-map rescan whenever any effect expired — became a real per-frame cost once `smoke_puff` trails started pushing hundreds of effects per frame. This is safe because an effect still being drawn has age < its `life`, so it can never be swept out from under itself; it does assume no effect kind is given a `life` anywhere near 30 s. It draws additive `LineSegments`+`Points` for streaks/rings/embers and a **`SpriteNodeMaterial` sprite pool** (soft radial `CanvasTexture`, additive glow + normal-blend smoke) for the fireball and smoke — classic `SpriteMaterial` is avoided because the WebGPU backend needs the node material. Effect `life` is the outer envelope (explosion 1.8 s so smoke lingers; the blast **point-light** is a separate short-lived `ExplosionEntity` `renders:true`). Fed per-frame via `updateShotEffects()` from `entityRegistry.renderList({type:'effect'})` (host/solo) or the interpolated `mpPendingEffects` upserts (guest). Guest shooters also get an immediate local-predicted tracer (`spawnLocalPredictedTracer`, hitscan only) + muzzle flash; damage stays host-confirmed. A fifth kind, **`smoke_puff`** (`{p, color, life, size, growth, rise, drift, opacity}`, defaults life 1.2 s / size 0.35 / growth 0.9 / rise 0.35 / drift `[0,0,0]` / opacity 0.3 / colour `[0.42,0.4,0.38]`), is replication-shaped like the rest but currently only spawned locally by `bot-viewer-v2.html`'s rocket trails — it costs exactly **one** sprite, so a trail is 30–60 independent puff entities rather than one emitter, which keeps it stateless like every other kind. Two constraints follow from `firstSeen` being keyed on `id` and from motion being derived from age: puff ids must be **unique across all effect kinds and never reused**, and `p` must **never be mutated after spawn** (movement comes from `drift` + `rise`). Full parameter table in `docs/subsystems/fx.md` § Combat effects.
- **Projectiles + explosions** (`entity-types/combat-projectile.js`, `entity-types/explosion.js`): a fired rocket/grenade is a host-owned `combat-projectile` registry entity that flies under `sim` velocity/gravity, sweeps its path each `tick` via injected `ctx.raycast` (`projectileRaycast` → `resolveWorldShot`, terrain excluded so it owns its own ground-contact check), grenades bounce off terrain (≤2), and detonates on solid contact / fuse / life-end into an `explosion` entity (rockets `fizzleOnExpire` with no blast). It serializes as `type:'projectile'` (`renders:true`) so it borrows the light renderer's moving-light path; `isRegisteredLightEntityType` now also matches `'combat-projectile'`. `explosion` deals radial damage **once, in `create()`** via injected `ctx.applyBlast` (`applyExplosionBlast`: players/creatures/mobs by `blastDamageAt` falloff `0.45 + 0.55·(1−d/r)`, floor 12, **friendly-fire + self-damage ON**), then spawns its `explosion`-kind effect via `ctx.spawnEffect`. Both `ctx` closures are injected in the `entityRegistry.tick(dt, ctx)` call. Explosion is **not** a capped type (`CAPPED_TYPES` = `light`+`projectile` only) — the registry cap rejects *before* `create()` runs, so a capped explosion would silently drop its create()-time damage.
- Extended host-owned player snapshot fields (guest-supplied values ignored): `hp`, `maxHp`, `alive`, `weapon`, `tool`, `firing`, `fireSeq`, `lastShotAt`, `ammoMag`, `ammoReserve`, `reloading`, `aimPitch`. `_lerpPlayers()` lerps `hp` and carries the rest.
**ADS optics (aim-down-sights view + scope).** Right-mouse hold eases `localAimAmount` 0→1 (`environment-viewer.html`); each weapon carries optics fields in `weapons.js`:
- `aimOffset [x,y,z]` / `aimRotation [x,y,z]` (euler rad) — the fully-aimed first-person view position and orientation. `applyToolTransform` lerps `viewOffset → aimOffset` and `viewRotation → aimRotation` by the aim amount (replacing the old hard-coded derived offset and yaw-only tweak), so ADS placement is fully tunable per weapon.
- `aimEyeForward` (m) — "focus": a render-time camera dolly forward along the look vector by `aimEyeForward · aim`, applied in `updateAimOptics()` after the frame's camera is finalized (safe because `camera.position` is reset from `playerCollider.end` each substep). Skipped in third-person (`localBodyThird`).
- `sightType` (`'iron' | 'optical'`) — gates the scope overlay/blur (optical only). FOV zoom applies to both types.
- `magnification` — `updateAimOptics()` sets `camera.fov = lerp(70, 2·atan(tan(70/2)/mag), aim)` (`ADS_BASE_FOV = 70`); returns to 70 at `aim=0`, and orbit/exit still own fov 50.
- `scopeBlur`, `scopeRadius` (fraction of viewport height), `scopeCenter [x,y]` (fraction of viewport) — drive a DOM scope overlay (`updateScopeOverlay`): `scopeVignette` darkens outside the scope circle to black; `scopeBlurEl` applies `backdrop-filter: blur(scopeBlur·10px)` masked to the periphery (outside the circle). Both fade in with aim; the overlay is first-person + optical only and is hidden on `exitFPS`.

Panel: the "Weapon control" → **Aim / optics** group adds Aim X/Y/Z, Aim rot X/Y/Z, Focus (eye-in), a **Lock aim (preview)** checkbox, a Sight type dropdown, Magnification, Blur intensity, Magnifier radius, and Magnifier X/Y sliders. **Lock aim** sets the `aimLock` flag: the aim easing pins `localAimTarget = 1` even while cursor-free (as long as a real weapon is equipped), and the frozen-view branch drives `localWeaponView.update` so the gun eases into and holds the aim pose for tuning without holding RMB. Numeric fields persist through the `controlRegistry` (`weapon.<id>.aimOffset.*`, `aimRotation.*`, `scopeCenter.*`, `aimEyeForward`, `magnification`, `scopeBlur`, `scopeRadius`) and the `pcw:weaponTuning` localStorage mirror; `sightType` (a string, outside the numeric registry) is mirrored separately as `weaponSight.<id>`. `aimLock` is a session-only authoring toggle (not persisted). Every weapon-control slider row also has an **editable number box** (right of the label): type an exact value (e.g. `10.5`) that the range bar's step can't drag to. A **Fine (x0.1 step)** checkbox near the weapon selector (`setWeaponFineMode`) drops every slider + number box to 1/10 its base step (and shows one extra decimal) for finer dragging/spinner nudges; the number box already accepts any typed value regardless. Both are session-only.

- **Approximations / not yet done:** obstacle column height is derived from the collision radius (`~1.4·r` for rocks/logs, hugging the visible prop; a fixed tall value for trees) since the circles store only `{x,z,r}`; authored-map geometry (`map-collision.js` BVH) is not yet an occluder; workshop-creature gun damage imparts no knockback (attacker passed as `null`); mob capsule height assumes a humanoid reference (odd-shaped/boss mobs get an approximate capsule). Grenade/RPG flight is closed-form ballistic (velocity + gravity + terrain bounce), not Rapier — Rapier is still deferred until physics-prop work. Third-person weapon holds / IK anchors / poses for `five_seven`, `cz_805_bren`, `knife`, `grenade`, `rpg` are numerically seeded (from the same-class weapon) but not yet visually authored in `body-preview.html` / `weapon-anchor-editor.html`.

#### 6. Shared Creature/NPC Configuration

Status: partially implemented.

Files: `environment-viewer.html`, `port-creature-system.js`, `port-creature-bridge.js`

Responsibilities today:

- Host exports creature configuration and broadcasts it as a `creature_config` message **only when it changes** (`syncSharedNpcConfig`), plus a forced resend when a guest joins — not on a heartbeat, and not inside `sim_state`.
- Guests apply host creature configuration from the `mp:creature_config` event (`receiveSharedNpcConfig`, deduped by signature).
- Guests run creature mode as `network`, meaning they render host-driven creature poses instead of running full local creature AI/physics.

Limitations:

- Creature runtime state is still a custom pose stream, not a general entity component stream.
- Grabbable objects are deliberately not applied in shared NPC config, and are now also **excluded from the export** (`exportSharedNpcConfig` deletes `data.objects`): their live positions move every frame, which otherwise defeated the host's change-detection and made `creature_config` resend on every 1 Hz check.
- Creature interactions with world objects are not authoritative across clients.
- Guest commands for target/behavior exist in host handlers, but are not a complete interaction protocol.

#### 7. Shared World Settings Packet

Status: partially implemented.

Files: `environment-viewer.html`

Responsibilities today:

- In `shared` mode, the host captures registered controls whose names start with `terrain.` or `params.` and broadcasts them as a `world_settings` message **only when they change** (`syncSharedWorldSettings`, checked at ~1 Hz), plus a forced resend on guest-join — no longer bundled into `sim_state` on a 1 s heartbeat.
- Guests apply those values through the slider/control registry from the `mp:world_settings` event.
- This can keep many procedural terrain, vegetation, water, cloud, and similar settings aligned.

Limitations:

- This is control synchronization, not world-state replication.
- It is not granular by subsystem.
- Some systems are excluded by naming, such as `rigP.*` lighting controls.
- Late async controls can create ordering issues.
- Local UI changes can still matter in `independent` mode.

#### 8. Procedural Local World Rebuild

Status: implemented as a single-player system, reused by multiplayer.

Files: `environment-viewer.html`, terrain/vegetation/water/sky modules

Responsibilities today:

- Each client builds terrain, trees, grass, plants, water, sky, and clouds locally.
- When map/settings/seeds match, those systems can appear shared.

Limitations:

- These systems are not network entities.
- Runtime changes are not represented as durable mutations.
- If deterministic inputs drift, clients diverge.
- There is no server truth for terrain edits, vegetation edits, water changes, or environment mutations.

#### 9. Replicated Entity Registry (lights) — implemented 2026-07-03

Status: implemented for lights + projectiles (milestone A of the entity-registry migration).

Files: `entity-registry.js`, `entity-types/light.js`, `entity-types/projectile.js`,
`entity-types/effect.js`, `entity-types/combat-projectile.js`, `entity-types/explosion.js`,
`light-entity-renderer.js`, `effect-renderer.js`, `environment-viewer.html`, `multiplayer.js`.
The `effect` type (`gun_tracer`/`hit_spark`/`explosion` replicated; `muzzle_flash` local-only, short-lived, self-destroying, uncapped)
is registered alongside the light adapters and rendered by `effect-renderer.js`; see §5b. Two
weapon adapters join them (also uncapped): `combat-projectile` (rocket/grenade flight, serializes
as `type:'projectile'` so it shares the moving-light renderer; its registry type is matched by
`isRegisteredLightEntityType`) and `explosion` (radial-damage burst that damages once in
`create()` via injected `ctx.applyBlast` — kept uncapped precisely because the cap rejects before
`create()` runs). See §5b for the fire-path + blast math.

This replaces the earlier ad-hoc "shared light bridge" (the old `mpSharedLights`/`lights`/
`light_state` path) with a general **host-authoritative replicated entity registry**. Design +
rationale: `docs/superpowers/plans/2026-07-03-entity-registry-light-migration.md`.

- **`entity-registry.js`** (pure, THREE-free, Node-tested) — `createEntityRegistry()` →
  `{ registerType, create, update, destroy, get, list, tick, snapshot, renderList, applySnapshot }`.
  Entities are `{ id:`${type}-${seq}`, type, ownerId, createdAt, updatedAt, version,
  transform:{p,q,s}, state, sim }`. `create` enforces a registry-level cap
  (`MAX_LIGHT_ENTITIES = 33`, shared by `light`+`projectile`, **reject-newest**). `tick(dt, ctx)`
  runs each entity's adapter `update`, wiring `ctx.spawn` → its own `create` (so a projectile can
  spawn a light on impact). `snapshot()` returns `{ full:true, since:0, version, upserts, removes }`
  and **drains** tombstones — it is the 20 Hz network authority path. `renderList(filter)`
  serializes without draining — the per-frame render path. `applySnapshot` (guest mirror; unused
  today, see below) throws if the instance was ever `tick`ed.
- **Type adapters** `entity-types/light.js` (`LightEntity`) and `entity-types/projectile.js`
  (`ProjectileEntity`, generic payload-carrying — `payload:{type:'light',params}`, converts to a
  light via destroy+create on terrain hit or `age > MP_LIGHT_MAX_FLIGHT`, tagging the new light
  `state.spawnedFrom = <projectileId>`). `serialize` is **allowlist-based** so host-private `sim`
  (velocity/driftPhase/grounded) never leaks. Wire shape:
  `{ id, type, p:[x,y,z], color:[r,g,b], radius, intensity, lifespan?, totalLife?, ownerId,
  renders?, spawnedFrom? }`.
- **`light-entity-renderer.js`** — `createLightEntityRenderer({ clusteredLights, firstSlot:223,
  maxSlots:33 })` → `{ sync(entities), dispose() }`. Owns the clustered-light **slot pool**
  (223–255) and is the ONLY code that calls `clusteredLights.setLightDirect`/`clearLight`. `sync`
  diffs by entity id: assign a free slot to new ids (skip when the pool is full — reject-newest,
  no eviction), update existing in place, clear+free vanished ids.
- **Wiring** (`environment-viewer.html`): one `entityRegistry` created for host/solo (registers
  both adapters). The light gun (`lgPlaceAtCrosshair`/`lgFireLight`) always emits an
  `entity_intent` (`action:'light.place'|'light.fire'`); a guest sends it via `mpSession.sendInput`,
  host/solo apply it locally through `applyLightIntent(intent, ownerId)` (validates action + finite
  numbers + clamps params, then `registry.create`). Host validates guest intents identically in the
  `mp:guest_input` `entity_intent` branch. `getState()` embeds `entities: entityRegistry.snapshot()`.
  Per frame, host/solo `entityRegistry.tick(...)` then `lightBinder.sync(renderList…)`; the guest
  never ticks — it feeds the binder the **interpolated wire upserts directly** from `onState`
  (`state.entities.upserts`), because the mirrored wire shape isn't the adapter's internal shape.
  The binder is created lazily alongside `clustered-lights.js` and null-guarded everywhere (lights
  can be off / non-GPU terrain).
- **Interpolation** (`multiplayer.js`): `_lerpEntities` replaces `_lerpLights`, matching `upserts`
  by id (a light carrying `spawnedFrom` borrows the projectile's last record as its lerp
  predecessor so landings don't pop); `removes` pass through. `_lerpState` emits `entities` instead
  of `lights`. **Solo now runs the same registry path** (host-without-network) — the old separate
  `placedLights`/`lgInFlight` solo path and the `lgSharedMode()` fork are gone.

**⚠️ Init-order hazard (guest `onState` during top-level `await`).** The guest session is
created early in module eval, but `environment-viewer.html` then hits several top-level `await`s
(e.g. the lazy `clustered-lights.js` import) that **suspend module evaluation**. A snapshot can
arrive during that suspension and fire the guest's `onState` callback *before later top-level
`const`/`let` declarations have initialized* — accessing one then throws
`ReferenceError: Cannot access 'X' before initialization` (a temporal dead zone crash), and it's
timing-dependent so it looks intermittent. This bit `controlRegistry` (read directly by
`receiveSharedWorldSettings`), fixed by hoisting its declaration above the session-creation code.
**Rule:** anything the guest `onState` path reads (directly or transitively via
`receiveSharedWorldSettings` / `receiveSharedNpcConfig` / the light binder) must be declared/
initialized *before* `createGuestSession` is called, or guarded behind a `let` default +
null-check (the pattern `captureSharedWorldSettings` uses to stay safe). The host path is less
exposed because it reads world settings only through that indirection.

Remaining limitations (deferred to later milestones per the plan):

- Host-browser authoritative, not server authoritative; relay (`server/server.js`) still blind-
  forwards `entity_intent` (guest→host) and `sim_state.entities` (host→guests) untouched.
- **Full snapshots every tick** (no deltas): the relay is broadcast-only, so per-guest
  `sinceVersion` baselines and late-joiner deltas aren't possible yet — milestone B.
- No persistence / mutation stream; no client prediction; no reject/correction message (rejects,
  e.g. pool-full, are silent); no interest management (the `snapshot` interest params are accepted
  but ignored). Creatures/props not yet on the registry.

#### 10. Local Dynamic Effects

Status: local only except for the multiplayer light bridge above.

Files: `environment-viewer.html`, lighting/FX modules

Examples today:

- Solo light-gun fallback path.
- Particle field creation/editing.
- Local lighting rig controls that are not captured by shared settings.
- Local debug/UI state.

Limitations:

- Other players never see these actions unless they are converted into shared entities, shared events, or shared mutations.

### Missing Subsystems

#### 1. Authoritative World Database

Status: not implemented.

Purpose:

The shared world needs an owner of truth that is independent of a browser tab. This can start as an in-memory server-side room state and later become persisted storage.

Needed responsibilities:

- Store world identity, map key, world mode, seed/settings, and schema version.
- Store authoritative dynamic entities.
- Store durable mutations.
- Support reconnect by replaying or snapshotting current world state.
- Separate ephemeral session data from persistent world data.
- Provide migration/version handling when world schema changes.

First practical version:

- Server room state owns a `world` object.
- Host may still simulate some systems, but server stores canonical entity IDs, lifecycle, and latest accepted state.
- On guest join, server sends a world bootstrap snapshot before live updates.

#### 2. Replicated Entity Registry

Status: not implemented.

Purpose:

Every shared dynamic thing should have an entity ID and type. Lights, creatures, players, grabbables, projectiles, placed props, and later gameplay objects should flow through one registry instead of one-off arrays and custom packets.

Needed responsibilities:

- Allocate stable entity IDs.
- Track entity type, owner, authority, components, version, and lifecycle state.
- Replicate create/update/delete operations.
- Support entity-specific serializers.
- Support late joiners.
- Support local prediction flags where needed.

Candidate initial entity types:

- `player`
- `creature`
- `grabbable`
- `light_projectile`
- `placed_light`
- `particle_field`
- `world_marker`

#### 3. Shared Dynamic Object Lifecycle

Status: not implemented.

Purpose:

Dynamic objects need explicit lifecycle events. Creating a light, picking up a grabbable, dropping food, killing a creature, or despawning a projectile should be part of the shared model.

Needed responsibilities:

- Spawn.
- Activate/deactivate.
- Attach/detach.
- Transfer ownership.
- Update state.
- Expire/despawn.
- Destroy permanently.
- Define what happens on host/client disconnect.

First target:

- Convert light gun shots and placed lights from local arrays into replicated entities.
- Convert grabbables from local creature-system objects into replicated entities.

#### 4. Persistent World Mutation Stream

Status: not implemented.

Purpose:

The game needs a durable record of world changes, separate from transient pose snapshots. This is the equivalent of block changes in a Minecraft-like architecture, but generalized for this world.

Needed responsibilities:

- Append ordered world mutations with sequence numbers.
- Distinguish durable mutations from visual-only events.
- Allow late joiners to reconstruct the world from baseline plus mutations.
- Support compaction into snapshots.
- Support persistence to disk/database later.

Candidate mutation types:

- `world_settings_changed`
- `terrain_patch_changed`
- `biome_layer_changed`
- `entity_spawned`
- `entity_destroyed`
- `entity_attached`
- `entity_detached`
- `light_placed`
- `light_expired`
- `object_picked_up`
- `object_dropped`

#### 5. Server Simulation of Client Actions

Status: not implemented.

Purpose:

Clients should send intents/actions, not final truth. The server or authority layer should decide what happened.

Needed responsibilities:

- Accept input commands such as move, fire, place, pickup, drop, interact, set target.
- Validate commands against permissions, cooldowns, distance, line of sight, and world state.
- Advance authoritative simulation ticks for shared systems.
- Emit accepted state changes and rejected/corrected commands.
- Keep client prediction optional and correctable.

First practical version:

- Keep browser host for heavy creature simulation temporarily.
- Move lightweight shared actions to the server first: light gun fire/place, grabbable pickup/drop, and player interaction events.
- Server validates and broadcasts entity lifecycle/mutation events.

#### 6. Conflict Model

Status: not implemented.

Purpose:

The system needs deterministic rules for what happens when multiple clients touch the same thing or submit incompatible changes.

Needed responsibilities:

- Define authority per entity/component.
- Define ownership and transfer rules.
- Define conflict resolution policy.
- Define ordering by server sequence, not client timestamp.
- Define rejection/correction messages.

Example policies:

- Server sequence order wins for object pickup.
- Host-authoritative creature AI wins for creature pose until creature simulation moves server-side.
- Entity owner can request actions, but server validates and commits them.
- World settings can be host-only, admin-only, or vote/lock based.
- Independent settings stay local and are never committed to the shared world.

#### 7. Interest Management and Visibility Scoping

Status: not implemented.

Purpose:

As the world grows, clients should not receive every entity and every mutation.

Needed responsibilities:

- Track each player's area of interest.
- Send only nearby or relevant entities.
- Send lower-rate updates for distant entities.
- Keep global events separate from local-area events.
- Support minimap/friend markers without requiring full entity replication.

Not urgent for the current scale, but the entity registry should be designed so this can be added without rewriting the protocol.

#### 8. Protocol Schema and Versioning

Status: not implemented.

Purpose:

The current protocol is loose JSON. A shared world needs explicit message contracts.

Needed responsibilities:

- Define versioned message names and payloads.
- Separate bootstrap, snapshot, delta, mutation, event, command, ack, reject, and correction messages.
- Keep old clients from corrupting newer rooms.
- Add test fixtures for message compatibility.

First practical version:

- Keep JSON, but formalize message shapes in code and docs.
- Add runtime guards for incoming messages.
- Add tests for bootstrap, entity lifecycle, mutation replay, and rejection paths.

#### 9. Persistence Backend

Status: not implemented.

Purpose:

The current relay process loses everything on restart. A real shared world needs save/load.

Needed responsibilities:

- Store world records.
- Store compacted snapshots.
- Store mutation logs.
- Store room/session metadata.
- Support cleanup and migration.

First practical version:

- JSON file or SQLite for local/dev.
- Later hosted database for deployed multiplayer.

#### 10. Testing and Observability

Status: minimal.

Purpose:

The multiplayer rewrite needs tests that prove synchronization and conflict behavior.

Needed responsibilities:

- Unit tests for protocol validation.
- Unit tests for entity registry lifecycle.
- Unit tests for mutation replay.
- Integration tests for host, guest, reconnect, late join, and disconnect.
- Debug UI showing server sequence, entity count, mutation count, and authority source.
- Logging that can explain why a command was accepted or rejected.

### Recommended Build Order

1. Define protocol messages and shared entity IDs while keeping the current relay/session flow.
2. Add a server-owned in-memory world record per room.
3. Add a replicated entity registry with `player`, `placed_light`, and `light_projectile`.
4. Convert light gun actions from local-only to client command -> server validation -> shared entity lifecycle.
5. Add world bootstrap for late joiners.
6. Add mutation log for durable entity create/delete and world setting changes.
7. Convert grabbables to replicated entities.
8. Move more client actions from pose/state upload to intent command.
9. Add conflict handling for pickup/place/edit races.
10. Add persistence after the in-memory model is stable.

### Target Architecture

The long-term multiplayer system should be organized around these layers:

```text
Client input
  -> command protocol
  -> authoritative room/world service
  -> entity registry
  -> simulation or validation
  -> mutation log + snapshots
  -> replication stream
  -> client interpolation/prediction/rendering
```

In that model, the browser host can still be used as a temporary simulation worker for expensive creature AI, but it should no longer be the only place where shared world truth exists.
