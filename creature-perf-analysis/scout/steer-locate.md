# Scout: Steering / Behavior / Collision — LOCATE (inventory)

All in `port-creature-system.js` unless noted.

## Behavior selection
- `2240` computeSteering() — dispatches 7 modes: wander (default), stay, target, forage, combat, race, direction; each sets a desired-direction vector differently (wander→roamTarget, combat→chase/flee, race→lane projection)

## Wander / random target
- `1050` randomTarget() — point within ARENA_R=13.0 via sqrt distribution
- `2257-2260`, `2303-2306` roam target regen when distance < 0.8

## Separation (creature-creature)
- `2311-2328` creatureGrid.nearby() query; dynamic radii: melee combatants use meleeRadius(), others SEP_RADIUS(2.3)+BODY_COLLISION_PAD(0.28); soft falloff (sepRadius-d)/sepRadius + hard boost at MIN_GAP(1.55)

## Tree/trunk avoidance (two-layer)
- `2333-2346` soft steering with TRUNK_AVOID_MARGIN(1.2)
- `2662-2666` hard push-out resolveTrunks() in physicsStep

## Creature collision resolution
- `4219-4261` resolveCreatureCollisions() — grid cells, push overlapping pairs by overlap*0.5 XZ + velocity damping

## Arena confinement
- `2350-2352` SOFT_EDGE=14.0 boundary repulsion (skipped in race); force = (dc-SOFT_EDGE)*BOUNDARY_GAIN(4.0) away from origin

## Weights / constants
- WANDER_W=1.0, SEP_W=2.2; separation scaled by behavior (race 0.35×, combat 0.7×)

## Bridge
- `port-creature-bridge.js:324` default mode wander / 6 creatures
