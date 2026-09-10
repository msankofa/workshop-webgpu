# Spawn building: seat it on the active terrain surface

Date: 2026-09-10. STATUS: steps 1 to 5 implemented 2026-09-10 in one commit (`base-game-spawn-seat.js`, `test-base-game-spawn-seat.mjs`, page, doc); browser validation below not yet observed. Reviewed against the current page, terrain adapter,
shared spawn collider and room world factory. This document is the implementation handoff.

## The bug and the limits of the diagnosis

A world load or a surface-mode change can leave the spawn building below the volumetric ground.
`spawnSite` in `base-game-spawn-collider.js` samples the footprint and seats its datum above the
highest sample or sea level. The page supplies `terrain.groundHeight`: `surfaceYAt` when the
adapter is actually volumetric, otherwise the heightfield.

The page currently rebuilds in `applyTerrainProjectAtRuntime` immediately after `setSource`, before
`updateWorld(0)` applies the effective volumetric setting. `adoptRoomTerrain` can rebuild before
assigning both the room's world mode and volumetric setting. `updateWorld` only detects a world-mode
change, so a later volumetric flip does not repair either seat. A panel volumetric toggle also
misses that condition. The building-floor branch in `reseatPlayerOnTerrain` then trusts the buried
building and can preserve the bad spawn.

This is a supported ordering defect, not proof that every volumetric load follows it:
`base-game-terrain.js:setSource` preserves the previous volumetric intent when the replacement
source supports density. Reproduce both an initial heightfield-to-volume load and a replacement
while already volumetric.

Two additional dependencies must survive this fix:

- Replacing the source while world mode and volumetric mode stay the same still requires a reseat.
  Simply removing the explicit rebuilds and comparing those two flags would regress this case.
- Sea level is an input to `spawnSite` (`baseY = max(maxY, seaLevel) + clearance`), including the
  same-descriptor room path that calls `terrain.setSeaLevel`.

## What must stay true

- The client and server use the same source, effective surface mode, sea level and building options.
  In volume mode this means the source's open-sky `surfaceYAt`, available before streamed chunks
  arrive. This is an analytic seating policy; it does not promise exact agreement with every
  marching-cubes triangle or with extrema between the fixed footprint samples.
- Finalize the source, world mode, effective volumetric mode and sea level before rebuilding.
  Publish the last-applied seat state only after the rebuild succeeds.
- One rebuild per changed seat state at the synchronization point; unchanged frames, visibility
  toggles, ordinary streaming and render-origin rebases cause no rebuild.
- Solo, room adoption, project apply and traversal-lab transitions all use this same synchronization.
- Geometry, collider and planter flora describe the same completed seat. Preserve the existing
  scattered-structure reset behavior when consolidating `syncSpawnBuilding`.
- Online room state and snapshots remain authoritative. A new local rescue must not fight them.

## Steps

- [ ] 1. Define the complete applied seat state and its synchronization point.

  Replace the mode-only bookkeeping with a small record of the inputs actually used by
  `spawnBuildingGround`: world mode; for terrain, source identity/revision, effective
  `terrain.volumetric` and `terrain.seaLevel`; for the spawn-area slab, its fixed ground/options.
  Use stable source identity plus an explicit revision if a supported path mutates a source in
  place. Do not use a general streaming epoch without checking its semantics: chunk churn must
  not invalidate the building. Do not compare newly allocated sampler closures each frame.

  Initialize this record from the inputs used by the constructor's initial build. Centralize the
  subsequent comparison/rebuild after `updateWorld` applies effective volume mode and water/sea
  settings. A source without density must record effective false even if the UI requests volume.
  Terrain-only changes while the slab world is active should not rebuild the slab building;
  switching back to terrain must consume the latest terrain state.

  Keep the rule and orchestration small and testable. If extracting a helper, the production page
  must call it; prefer a renderer-independent helper over adding a test-only predicate to the
  GPU-facing building module. Update the applied record only after successful rebuilding and
  publish the matching flora structure. Leave a failed attempt due for retry.

- [ ] 2. Route source and room transitions through that synchronization.

  In `applyTerrainProjectAtRuntime`, install the source, descriptor and final settings, then let
  its existing `updateWorld(0)` perform the single required reseat. Remove the premature explicit
  rebuild only once step 1 covers same-mode source replacements.

  In `adoptRoomTerrain`, finish room validation and all source/settings assignments before its
  existing synchronous `updateWorld(0)` call. It already calls this function at the end; do not
  defer seating until some later animation frame. Cover the same-descriptor sea-level path,
  volume-only room changes, and a room transition from the slab world to terrain.

  Audit constructor setup and all remaining `syncSpawnBuilding` callers so the first finalized
  state is recorded consistently. A provisional startup construction is distinct from the final
  project apply; avoid a second rebuild for the same finalized inputs. Preserve visibility,
  collision registration, flora updates and scattered-structure resets.

- [ ] 3. Reconcile the local player with a moved building deliberately.

  Capture the old support relationship before destroying the old collider. For a solo player
  standing on an actual building floor, preserve global X/Z and move the capsule foot plane to
  the corresponding new floor, including downward reseats. `getPosition()[1]` is already the foot
  plane (`base-game-player-controller.js`); do not accidentally treat it as capsule center or eye
  height. Use the existing controller relocation/reset contract and update render interpolation.

  Do not equate `footprintContains` with floor support: it is a bounding rectangle and the L-shaped
  complex has open courts. Use actual floor geometry/support, and distinguish ground-floor
  occupants from players on roofs, in planters, jumping above the building, or outside it. Preserve
  those positions unless the new geometry actually embeds them; use a collision-safe rescue for
  that case. If same-X/Z placement cannot fit the capsule, use the existing safe spawn fallback.
  Keep flying/seated control modes out of an unconditional body teleport.

  Reuse or refine `reseatPlayerOnTerrain` so the immediate solo correction and the later terrain
  handoff do not reset the same player twice or undo the corrected floor position. Guard against
  startup calls before the player controller exists. Keep the current online guards: room
  adoption must finish its collider update before prediction resumes, but the server's snapshot
  owns the room-change respawn.

- [ ] 4. Add regression tests that exercise the production synchronization, not only a boolean rule.

  Use a fake terrain with distinct heightfield and density heights and a rebuild spy that samples
  `groundHeight` when called. Drive the production orchestration through source/settings updates
  and effective `setVolumetric`, then assert the sampled height, applied state and rebuild count.
  A predicate-only test cannot catch the original ordering bug.

  Required cases:
  - Initial source without density to a density source with volume requested; sample only the
    finalized density surface for the apply, then no further rebuild on unchanged updates.
  - Volumetric off/on and on/off; world-mode transitions in both directions.
  - Replacement source with unchanged world/volume flags, including already-volumetric replacement.
  - Sea-level-only changes, including the room same-descriptor path; check the resulting datum.
  - Combined source/mode/volume/sea-level changes coalesce to one rebuild at synchronization.
  - Requested volume on a density-less source records effective false; repeated updates do no work.
  - Constructor bookkeeping, repeated room adoption, ordinary chunk completion, rebase and
    visibility-only changes do not produce redundant rebuilds.
  - A rebuild failure does not publish a successful seat state or suppress a later retry.
  - Slab-world seating remains flat and consumes pending terrain changes only on return to terrain.

  Exercise player corrections separately: actual floor occupant with upward and downward moves,
  open court, roof/airborne player, an obstructed destination, and online adoption without a new
  local reset. Confirm global coordinates after rebase and no second reset on terrain handoff.

  Add a deterministic client/server seating parity check using the shared spawn model/site and
  the samplers used by both hosts, for heightfield and density fixtures with nonzero sea level.
  Check datum and spawn coordinates, not only that both hosts call the same helper. Test the
  ordering seam used by both page entry points; do not duplicate its logic inside the tests.

  Run the relevant spawn-building/collider and terrain/room tests affected by the final extraction,
  plus `node test-page-syntax.mjs`. Record actual commands and results when implemented.

- [ ] 5. Update `docs/subsystems/base-game.md` with the full seat dependencies, synchronization point
  and solo/online rescue behavior; add a row to `agent_log.csv`. Mark implementation and browser
  validation separately in this plan. Steps 1-3 can share a coherent implementation commit.

## Browser validation still required

Load the default saved state with volumetric enabled. Confirm the final spawn is on the building
floor and the datum clears the sampled terrain. Toggle volume off and on, observing one rebuild
per effective change and correct upward/downward player handling. Apply two different projects
without changing volume mode. Change sea level above the previous terrain maximum. Visit an open
court to verify it does not become an invisible floor.

Join a volumetric room from the slab world and from a different terrain project. Confirm the
client's building datum/spawn match the server and standing on the floor causes no repeated
snapshot correction. Also check a render-origin rebase causes neither a reseat nor a coordinate
jump. Report anything requiring browser evidence as unverified until actually observed.

## Out of scope, noted

A cave mouth inside the footprint can leave the plinth hanging in cave air. The current plinth
bottom is 1.5 m below the lowest sampled open-sky surface, not a density-column support search.
Extending foundations to rock is a separate change. Likewise, refining the fixed footprint grid
to catch terrain peaks between samples is separate from correcting the state/order defect.
