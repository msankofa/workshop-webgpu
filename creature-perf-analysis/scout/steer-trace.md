# Scout: Steering / Behavior / Collision — TRACE (flow, loop nesting, O())

All in `port-creature-system.js` unless noted.

## Call chain (per frame, from update(dt) @4710)
- updateCreatureLod (4642) — O(N) + per-creature leg/arm loops
- updateContactPulses; updateGrabbables; rebuildObjectGrid
- Forage phase (4738) — O(N) × forageObjectForCreature (grid lookup + O(nearby objects), candidates @1266)
- Combat phase: updateCombat (4751) — O(N) × enemyTarget (grid lookup, candidates @2058)
- updateEating (O(N))
- Steering phase (4756) — O(N) × computeSteering:
  - creatureGrid.nearby()
  - separation loop over nearby creatures (2314)
  - trunk avoidance loop nearbyTrunks (2335)
- creatureGrid rebuild (4773) — O(N); _activeCreatures filter (4778) — O(N)
- Physics loop (4780) — up to 5 fixed steps:
  - physicsStep per creature (leg loops O(L))
  - resolveCreatureCollisions (4221): outer O(N_active) × grid.nearby inner O(nearby)
  - applyBodyTerrainClearance — O(N) × 9 terrain samples

## Loop-nesting / complexity table

| Loop | Iterates over | Nested in | Iterations |
|---|---|---|---|
| updateCreatureLod (4642) | creatures | frame | O(N) |
| forage assign (4738) | creatures | frame | O(N)×grid |
| enemyTarget candidates (2058) | nearby/all creatures | per creature | O(nearby), **O(N²) if grid sparse** |
| computeSteering (4756) | creatures | frame | O(N) |
| separation (2314) | nearby creatures | per creature | O(nearby), **O(N²) dense** |
| trunk avoidance (2335) | nearby trunks | per creature | O(T), **O(N·T)** |
| grid rebuild (4773) | creatures | frame | O(N) |
| physics loop (4780) | fixed steps | frame | ≤5 |
| resolveCreatureCollisions (4221) | active creatures | per fixed step | O(N_active)×nearby, **O(N²) dense** |
| resolve inner (near 4225) | nearby creatures | per active creature | O(nearby) |
| applyBodyTerrainClearance (4783) | creatures | per fixed step | O(N)×9 |

## Flagged hotspots
1. **O(N²) collision resolution** (4219-4260) — spatial grid (cell size 5.0) mitigates, but dense swarms → nearby≈N. Runs up to 5×/frame.
2. **O(N²) enemy targeting** (2051-2069) — grid-backed but falls back to full list when grid empty.
3. **O(N·T) trunk avoidance** (2333-2346) — depends on nearbyTrunks() grid quality.
4. **O(N²) separation** (2313-2328) — dense packing inflates nearby set.

## Shared state
- creatureGrid rebuilt per frame, queried in steering + collision
- _nearbyScratch reused buffer; _activeCreatures per-frame set
- mutated: pos/vel (physics + collision + clearance), yaw (physics), pitch/roll (orientation), health (combat)

**Summary:** amortized O(N)/frame when sparse; degrades to O(N²) in collision + combat targeting under density, plus O(N·T) trunk avoidance. Grid cell size (5.0) is the main lever.
