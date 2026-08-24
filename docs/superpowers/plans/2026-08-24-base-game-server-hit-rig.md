# Base Game server-authoritative player hit rig — implementation plan

STATUS 2026-08-24: authoritative core implemented. HR1, HR3, HR4 and HR5 are in code; HR6 has local
in-game hurt-rig/joint/zone/last-hit diagnostics. The HR0 model-measurement corpus, HR2 render-rig
endpoint parity and HR7 compare/performance rollout remain acceptance work. The server rig is live,
but the rich stateful procedural renderer does not yet consume its semantic endpoints, so visual
parity must not be claimed until that refactor and browser corpus pass.

## Outcome

Replace the upright capsule as the final player damage hitbox with an articulated, semantic hurt
rig evaluated by the room server. A ray beside the visible head or between the legs must miss; a ray
through a posed arm, leg, torso or head must identify that body zone at the correct distance.

The existing capsule remains the authoritative locomotion shape. It is still the correct tool for
stable stepping, slopes, ceilings, prediction and world collision, and it remains useful as a cheap
combat broad phase. It stops deciding whether a bullet actually hit the body.

The server never imports Three.js, builds render geometry, or trusts bone matrices sent by a client.
Client and server consume one renderer-independent pose/profile contract; the server derives each
hurt rig from authoritative tick state and keeps compact history for lag-compensated shots.

## Implemented core (2026-08-24)

- `humanoid-rig-topology.js` owns the fixed 16-joint ABI, baseline proportions and 18 semantic
  damage primitives. `ragdoll.js` now imports its proportions and joint order instead of owning a
  second copy.
- `player-body-pose.js` derives a renderer-free root-relative pose, eye/muzzle anchors, profile
  metadata and conservative bounds from authoritative global movement/aim state.
- `player-hit-rig.js` provides arbitrary segment-capsule rays, rig narrow phase, nearest-distance
  blast queries, swept-radius inflation, and a preallocated fixed-capacity rewind ring. Epoch/profile
  boundaries are never interpolated.
- Protocol 10 carries server-validated `bodyModel`, server-selected `hitProfile`, `poseEpoch`, and
  semantic hit `zone`/`side`. `base:set_body` accepts only registry ids; reconnect keeps identity.
- The room server steps the hit pose after authoritative movement, advances it on neutral/dead/
  disconnected ticks, resets history on respawn/world/model epochs, and uses rewound rigs for
  hitscan/melee. Projectiles sweep current rigs and blasts measure the nearest rig surface.
- Player model selection is per player. A local selection no longer rebuilds every remote as the
  same model; remote snapshots choose each remote render design independently.
- Base Game has live controls for the movement capsule, semantic hurt rig, zone colors, joints and
  last server hit marker. Performance captures receive profile/version/primitive diagnostics via
  the existing network diagnostics payload.
- Flat weapon damage is intentionally unchanged. `head` is compatibility data derived from
  `zone === 'head'`; no head multiplier or limb penalty was introduced.

Automated coverage is in `test-player-hit-rig.mjs`, `test-combat.mjs`,
`test-base-game-fire.mjs`, `test-base-game-replication.mjs`,
`server/test-base-game-rooms.mjs`, the session tests and the unchanged ragdoll/body suites.

## Facts measured in the current code

- `base-game-player-controller.js` is a deterministic 120 Hz kinematic capsule controller. Its
  position is the global foot plane and client prediction replays the same `stepOnce()` calls as the
  room server. Replacing this shape with animated limbs would destabilize movement and is outside
  the hit-registration problem.
- `server/base-game-rooms.js:675` converts that movement capsule into `combatCapsule()`. At
  `:681` it stores only `{ p, h, r }` in pose history; at `:699` it derives the shooter origin from
  the capsule top; and at `:717`–`:720` it rewinds victims and resolves the shot against upright
  capsules.
- That conversion currently double-counts the rounded caps. `combat.js` defines `h` as the straight
  segment length, but `combatCapsule()` sends `(endY - startY) + 2r`, the total movement-capsule
  height. With the Base Game defaults (`height 1.8`, `radius 0.35`), the ray test receives `h = 1.8`
  instead of `1.1` and extends approximately from `footY - 0.35` to `footY + 2.15`, rather than the
  controller's `footY` to `footY + 1.8`. The shooter origin happens to use the same oversized `h`
  and lands at `footY + 1.8`; correcting `h` alone would incorrectly lower that origin to `1.45`.
  Target volume and eye/muzzle origin must be separated in one migration.
- `combat.js` is already pure Node/browser math. `resolveHitscan()` handles player, creature and mob
  capsule lists plus world occlusion, but `rayCapsuleHit()` assumes one vertical capsule and returns
  no semantic body zone.
- The server already owns every pose input that may affect gameplay: global position/velocity,
  grounded state, simulation tick, yaw/pitch, aim, weapon/action, alive state and the room's world
  query. No client bone packet is necessary.
- The visible body is richer than the server state. `player-procedural-body.js` has pelvis, chest,
  neck, head, shoulders, elbows, hands, hips, knees and feet; gait, IK, body follow, airborne motion,
  aim and local visual tuning move them away from one vertical column.
- The gait scheduler is stateful. A remote client receives 20 Hz root snapshots, not the server's
  foot-step history, so importing the same pose code on both sides does not by itself guarantee that
  a remote mesh and server hurt rig are in the same gait phase. HR2 must measure the minimum compact
  authoritative pose state needed for reconstruction instead of assuming a tick number is enough.
- Useful renderer-independent donors already exist:
  - `player-procedural-body.js` exports the pure `createGaitScheduler()`, `gaitForSpeed()` and
    `armPoseHandLocal()` math.
  - `body-locomotion.js` is pure.
  - `ragdoll.js` already defines a pure 16-joint humanoid topology and proportions using the same
    semantic names as the procedural body.
  - `ragdoll-body.js` already maps the procedural body's joint names to that topology.
- `bot-body-hit.js` is evidence for nearest-part selection and part-local visual attachment, but it
  is not server code: it requires Three.js matrices and render-geometry bounds. It must not be
  imported into the room server.
- `bodyDesign` is currently a local page setting, and `setBodyDesign()` rebuilds the local body and
  every remote body to the same choice. The server does not know a player's model. A silhouette-
  changing model therefore cannot silently select a different server hurt profile today.
- Hit events already carry a `head` boolean, but `server/base-game-rooms.js:222` always emits false.
  Damage is flat weapon damage. Geometry replacement and damage balancing are separate decisions.
- Global positions can become large and two players can occupy the same X/Z at different Y. Hurt
  rig history therefore cannot collapse to a heightfield or render-local coordinate frame.

## Decisions

### Separate motor, hurt rig and render rig

There are three related shapes with distinct jobs:

| Shape | Authority | Job |
| --- | --- | --- |
| Movement capsule | server and predicting owner | World traversal, steps, slopes, ceilings, swimming and broad phase |
| Semantic hurt rig | server | Bullet, melee, projectile and blast contact with body zones |
| Render rig | each client | Meshes, gear, secondary motion, visual IK and local quality |

The movement capsule never becomes a collection of foot and hand colliders. The hurt rig never
pushes the player through the world. The render rig never authorizes damage.

### Reuse the existing 16-joint topology

Use the semantic joint set already shared by `ragdoll.js` and `ragdoll-body.js`:

`pelvis`, `hipL/R`, `kneeL/R`, `footL/R`, `chest`, `neck`, `head`, `shoulderL/R`, `elbowL/R`,
`handL/R`.

The initial hurt shape is a union of arbitrary-orientation capsules between those joints, plus a
head sphere/capsule and wider central chest/pelvis capsules. Each primitive carries a stable gameplay
zone (`head`, `neck`, `torso`, `pelvis`, `upperArm`, `lowerArm`, `hand`, `thigh`, `calf`, `foot`) and
side (`left`, `right`, or `center`). Decorative gear, cloth, weapon meshes and effects are not
hittable unless a later armor system explicitly gives them a gameplay profile.

Capsules are retained as *bone primitives*, not as one upright body capsule. This reuses the current
robust ray/capsule mathematics while allowing limbs and the torso to follow the rig.

### One pure pose owner, not a hand-synchronized server animation

Create a renderer-independent pose module that owns the gameplay-relevant joint solve. Extract the
necessary formulas from `player-procedural-body.js`; do not copy them into a server-only twin. It
reuses the existing pure gait/locomotion helpers and accepts plain arrays/objects only.

Inputs are authoritative global state:

- foot-plane position and velocity;
- body facing yaw and aim yaw/pitch;
- grounded/airborne/swimming state and fixed tick/dt;
- aim and weapon action;
- body profile and pose epoch;
- a bounded global `worldQuery.groundProbe()` adapter where foot support is necessary.

Outputs are the fixed 16 global joint points plus `eye`, `muzzle`, root bounds and the pose/profile
epoch. The procedural renderer consumes these semantic points for its core and limb endpoints, then
may add bounded cosmetic mesh roll, sway and gear motion that do not redefine the hurt rig.

Base Game has no land crouch, kneel or prone simulation yet. This work does not invent those player
states. The pose contract reserves a stance enum, but v1 implements the states the authoritative
controller actually has: standing locomotion, airborne and swimming. A future stance becomes
hittable only when it is also server-authoritative.

### Collision profiles are server-known identity, not local tuning

Add a small pure body-model registry. Each allowed model id maps to:

- a render design key;
- a versioned hurt profile containing skeleton proportions and zone radii;
- an optional cosmetic family that does not alter gameplay extents.

First audit the current Base Game model choices against the default and human proportions. Models
within tolerance share one canonical profile. A genuinely different silhouette gets a separate
profile or is excluded until one exists; it must not borrow an obviously wrong volume.

Per-player model id becomes server-validated identity and is echoed in player snapshots. A profile-
changing selection applies only at spawn/respawn so a player cannot shrink a live hurt rig to evade a
shot. Local gait/look sliders remain cosmetic and cannot change server joint positions or radii.

### Global root plus local offsets for history

Live server poses use global coordinates. Lag history stores each sample as:

- Float64/ordinary-number global root;
- fixed-order Float32 joint offsets relative to that root;
- compact eye/muzzle offsets if not derivable from joints;
- tick/time, profile id/version, pose epoch and alive state.

This keeps precision at flight-scale coordinates without paying three full Float64 values for every
joint. Use a fixed-capacity ring per player; do not append object trees and `splice()` them at 120 Hz.
Interpolation lerps matching joint offsets and the root independently. A respawn, world change or
hurt-profile change increments the pose epoch and prevents interpolation across incompatible rigs.

### Broad phase first, rig narrow phase second

For each ray or swept projectile segment:

1. Reject the shooter, dead players and roots outside range.
2. Test the rewound hurt rig's cached conservative AABB/sphere as the broad phase. The movement
   capsule may substitute only if expanded by the profile's maximum limb reach and proven to contain
   every allowed pose; the unexpanded capsule would incorrectly reject an outstretched arm.
3. Test the surviving rig's semantic bone primitives.
4. Compare the nearest body primitive with the exact world-occluder result.
5. Return the nearest valid result with player id, zone, side, point, normal and distance.

A broad-phase hit is never damage by itself. After migration there is no silent fallback to the old
upright capsule; if the current pose is unavailable, use the last valid pose in the same epoch or the
canonical spawn pose, and record the fault.

### Geometry first, damage policy second

The first authoritative rollout keeps existing flat weapon damage. It populates `zone`, `side` and
the existing `head` compatibility boolean, which makes geometry observable without confounding the
test with balance changes. Headshot multipliers, limb scaling, armor and impairment are a separate
explicit phase after hit registration is accepted.

### No client-authored bone replication; bound any server pose metadata

The server derives hurt poses from tick state and stores them locally. Snapshots add only stable
identity/pose metadata needed by presentation (`bodyModel`, `poseEpoch`, and any compact phase value
the shared pose solver proves it needs). HR2 inventories the scheduler state and sets a measured
bandwidth cap before choosing that compact form; it must not merely assume gait phase is stateless.
Normal gameplay does not stream 16 bone transforms every 20 Hz. A bounded developer-only server rig
snapshot is permitted for parity diagnosis, and shot/hit events carry the authoritative impact point
and zone for effects. No path accepts client-authored joints.

## Target data contracts

Names are provisional; the shapes are the contract.

```js
// Fixed topology, root-relative except root itself.
{
  root: [globalX, globalY, globalZ],
  joints: Float32Array(16 * 3),
  profileId: 'humanoid-default',
  profileVersion: 1,
  poseEpoch: 4,
  tick: 8120,
  alive: true
}

// Narrow-phase result.
{
  kind: 'player', id: 'player-id',
  zone: 'upperArm', side: 'left', primitive: 7,
  distance: 18.42,
  point: [globalX, globalY, globalZ],
  normal: [nx, ny, nz]
}
```

Primitive indices are stable only within a profile version. Network/gameplay code uses semantic
zone and side, never render-part indices or material roles such as `shell` and `plate`.

## Implementation phases

### HR0 — Lock the measured mismatch and acceptance corpus

- Add a client diagnostic that can draw the current movement capsule, semantic visual joints and
  proposed hurt primitives independently through in-game toggles.
- Record standing, walking, sprinting, turning, jumping/falling, aiming up/down, firing/reloading,
  swimming and two players at the same X/Z on different floors.
- Measure visible core/limb bounds for every allowed body model. Produce the initial profile mapping
  rather than guessing radii from screenshots.
- Define tolerances before implementation: no visible core body may sit wholly outside its semantic
  hurt primitive, and empty space between major limbs must remain missable. Loose gear is excluded
  and labeled as such.
- Baseline three methods with reproducible rays: the shipped oversized capsule, a correctly converted
  movement capsule, and the proposed rig. This separates the `h` conversion bug from the inherent
  single-capsule silhouette problem. These become fixtures.

Gate: the corpus demonstrates at least head-side, between-leg, outside-arm and exposed-limb cases
where the old capsule gives the wrong answer.

### HR1 — Pure topology, profiles and arbitrary capsule math

- Add a renderer-free shared topology/profile module. Move the common joint order and baseline
  proportions out of `ragdoll.js` only after parity tests prove the ragdoll's rest pose did not
  change; both systems then import the same constants.
- Add pure ray-versus-arbitrary-segment-capsule intersection with point, normal and distance. Keep
  `rayCapsuleHit()` as a compatibility wrapper for creatures, mobs and existing tests.
- Add `rayPlayerHitRig()` over the profile's primitive table. Nearest primitive wins, with a stable
  tie rule for overlapping torso/limb joints.
- Add nearest-point/distance-to-rig for blast falloff and swept segment/radius support for live
  projectiles. Do not reuse render AABBs.

Tests: rest pose measurements, rays through every zone and side, tangent rays, origins inside a
primitive, overlapping-joint tie order, nearest player, world occluder before/after body, large
global coordinates and malformed/non-finite input rejection.

### HR2 — Extract the shared authoritative pose kernel

- Add the pure pose state/step module and feed it the existing pure gait scheduler, locomotion and
  arm-pose helpers. It owns fixed-step gait phase, facing, semantic joints, eye and muzzle anchors.
- Inventory the scheduler state a remote observer lacks. Define and measure the smallest authoritative
  pose metadata that lets the client reconstruct within tolerance; if no compact representation does,
  retain server authority and use bounded debug pose snapshots rather than pretending parity exists.
- Give it a bounded global support adapter built on the existing `worldQuery.groundProbe()` contract.
  Never select a different floor merely because it shares X/Z; no height-only fallback.
- Refactor `player-procedural-body.js` to consume the semantic joint solution for gameplay-relevant
  endpoints rather than retaining a separate set of formulas. Preserve its geometry construction,
  batching, materials, cosmetic secondary motion and existing public API.
- Add a read-only `getSemanticPose(out)` to the body for diagnostics and parity tests. It returns
  plain values, not live Object3D references.
- Keep all pose state instance-owned and allocation-free after construction.

Tests: pure solver and headless render rig agree within the HR0 tolerances for the complete corpus;
same input ticks produce byte-identical joint offsets in browser-compatible Node and the server;
support remains correct on stacked floors; rebasing presentation changes no global joint; a reset or
teleport starts a new pose epoch without a one-frame stretched body.

Gate: there is one semantic joint solve. A hand-maintained server copy of the visual pose is not an
acceptable shortcut.

### HR3 — Per-player model/profile authority and protocol

- Move the Base Game model id list into the pure registry. Keep render composition in
  `base-game-player-bodies.js`, keyed by that registry.
- Add a rate-limited `base:set_body` request (or equally narrow existing identity message). The
  server validates the id, stores it on the reconnecting client identity and chooses its hurt
  profile. No client supplies profile dimensions.
- Echo `bodyModel`, `hitProfile`, `poseEpoch` and the HR2-approved bounded pose metadata in player
  snapshots; bump the protocol version and update sanitizers/tests.
- Change `base-game-player-bodies.js` from one page-wide design to one local selection plus each
  remote player's authoritative model. Rebuild a body only when that player's model id changes.
- Save the local player's preferred model as before. Online, the saved choice is a request and the
  server echo is authoritative; offline, the same registry supplies the profile.
- Defer profile-changing selection until respawn. Cosmetic models sharing one profile may switch in
  menus without changing history.

Tests: invalid/oversized ids rejected, reconnect retains identity, remote players may use different
models, a profile cannot change mid-life, local-only visual quality does not change the profile, and
old-protocol clients fail clearly instead of rendering one model while being hit as another.

### HR4 — Server live poses and lag-compensation rings

- Construct one pure hit-pose state with each server controller. Step it immediately after that
  controller's authoritative movement tick using the consumed sanitized input and room world query.
- Neutral/stall/disconnected ticks advance the pose through the same server path. Respawn/world
  replacement resets it and increments `poseEpoch`.
- Replace `poseHistory`'s object arrays with fixed-capacity per-player rings containing root-relative
  joint poses and metadata. History duration remains bounded by the existing lag-compensation rule.
- Sample a rewound pose by root/joint interpolation only within a matching profile version and epoch.
  Build/cache its broad-phase bounds once per sample, not once per primitive test.
- Do not solve a victim's gait inside `fireShot()`: the required pose was already recorded at its
  authoritative tick.

Tests: 100 ms rewind hits the historical arm/head rather than the current one; teleport, respawn and
profile changes never interpolate through space; same X/Z/different Y histories remain separate;
history memory stays fixed; no per-tick collection growth; server pose remains deterministic through
stall, resume and water entry/exit.

### HR5 — Combat integration

- Extend `resolveHitscan()` with a rig-player path while retaining capsule handling for creatures and
  mobs. Candidate collection still includes every other room player, not only an intended target.
- Derive hitscan/projectile origin from the server pose's eye/muzzle anchor, with direction still
  generated by the authoritative sanitized aim, weapon, tick, spread and seed.
- Hitscan and melee use rewound victim rigs. Live projectiles sweep against current rigs. World
  geometry participates in the same nearest-distance comparison.
- Explosion falloff measures to the nearest point on the current hurt rig instead of the movement
  capsule midpoint. The explosion itself remains server-authoritative.
- Hit events add sanitized `zone` and `side`; `head` is derived as `zone === 'head'`. Flat damage is
  unchanged in this phase.
- Preserve the movement controller, prediction state and movement capsule byte-for-byte.

Tests: head, torso, each limb side, between-leg miss, beside-head miss, nearest overlapping player,
world-before-player occlusion, player-before-world hit, melee range, projectile sweep, blast nearest
surface, shooter muzzle, lag compensation, and unchanged creature/mob capsule behavior. Existing
movement/prediction/terrain/water suites must remain unchanged.

### HR6 — Client diagnostics and feedback

- Add in-game toggles for movement capsule, current hurt rig, semantic zone colors, visual joints
  and last authoritative hit. No URL flags or reload-only diagnostics.
- Build the wireframe from the same pure pose/profile module. Never infer it from mesh bounding boxes.
- Show current profile/version, pose epoch, primitive count, pose time and narrow-phase counters in
  diagnostics and performance records.
- Use hit-event `zone`/`side` for impact attachment and text/debug feedback. `bot-body-hit.js` may
  locate the nearest render part for decals after the server has already decided the gameplay hit;
  it cannot overturn that decision.
- A rewound hit marker uses the server event's global impact point converted through the current
  render origin, so origin rebasing cannot move the effect to another player.

Browser gate: the semantic wireframe follows each model and body pose; empty gaps are visibly
missable; two stacked players have distinct rigs; shot effects land on the reported zone; first- and
third-person modes do not create duplicate local hurt rigs.

### HR7 — Dual-run rollout and performance gate

- Add a server-side diagnostic mode with `legacy`, `compare` and `rig` resolution. It is room/server
  authority, never a per-client gameplay choice. `compare` records both the shipped oversized
  capsule and a correctly converted movement capsule beside the rig.
- In `compare`, apply exactly one method. Count shipped-capsule-only hits, corrected-capsule-only
  hits, rig-only hits, matching hits, zone distribution, pose faults and resolver time. Do not log
  unbounded per-shot payloads.
- Run the HR0 corpus first, then real two-tab sessions. Switch the applied method to `rig` only after
  the disagreements match the known phantom-hit/visible-limb cases rather than random pose drift.
- At 16 players and the supported fire/projectile rate, record server tick p50/p95/max, pose-step
  time, shot narrow-phase time, history bytes/player, candidate counts and missed/late ticks. Pose
  and history work must remain bounded, with no garbage growth while players idle.
- After acceptance, remove the upright capsule as a final damage resolver. Keep it for locomotion,
  broad phase and its independent debug toggle.

### HR8 — Optional location damage, only after geometry acceptance

- Define an explicit zone-to-damage policy if desired: head multiplier, torso baseline and optional
  limb modifiers. Keep it data-driven and server-owned.
- Armor uses semantic zones/profile attachments, never render material roles or arbitrary gear mesh
  names.
- Add balance tests independently of geometry tests so changing a multiplier cannot make a miss turn
  into a hit.

This phase is not required to replace the broken capsule hit volume.

## File impact

Expected new pure modules:

- `humanoid-rig-topology.js` — fixed joint order and shared baseline proportions;
- `player-body-pose.js` — authoritative semantic pose state/step;
- `player-hit-rig.js` — profiles, primitive construction, ray/sweep/nearest-point math;
- focused Node tests for each contract.

Expected existing changes:

- `ragdoll.js` / `ragdoll-body.js`: import shared topology without changing behavior;
- `player-procedural-body.js`: consume/expose the shared semantic pose;
- `base-game-player-bodies.js`: per-player model ids and debug pose access;
- `combat.js`: arbitrary rig narrow phase and compact pose history support;
- `server/base-game-rooms.js`: model authority, live pose stepping, history and combat integration;
- `base-game-protocol.mjs`, session/remotes and tests: body/profile metadata and semantic hit events;
- `base-game.html`: in-game diagnostics and performance fields;
- Base Game, multiplayer, combat and procedural-body documentation plus `agent_log.csv` as phases land.

## Success criteria

- Shooting visible empty space beside the head, torso or limbs does not damage the player.
- Shooting a visible posed limb or head does damage the correct player and reports the correct zone.
- World geometry still occludes the body by nearest 3D distance.
- Lag compensation rewinds the articulated victim pose, not merely its root capsule.
- The server accepts no client joint transforms, radii, hit zone or claimed impact point.
- Model/profile identity is server validated and consistent for every observer.
- Two players at identical X/Z but different Y are independently hittable.
- Large global coordinates and render-origin rebases do not change hit results.
- Movement, stepping, swimming, prediction and reconciliation remain capsule-based and bit-identical.
- Sixteen players have bounded pose/history memory and do not cause server tick starvation.

## Explicitly deferred

- Replacing the movement capsule with articulated physical collision.
- Player-player limb collision, pushing, grappling or ragdoll-driven locomotion.
- Trusting client animation or transmitting continuous bone matrices.
- Hitting decorative cloth, hair, loose gear or weapon meshes.
- Land crouch, kneel and prone until those states exist in authoritative player simulation.
- Dismemberment, limb impairment and server ragdoll simulation.
- Headshot or armor balance changes before the rig geometry is accepted.
