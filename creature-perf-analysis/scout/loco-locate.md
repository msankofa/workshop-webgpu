# Scout: Locomotion & Physics — LOCATE (inventory)

All in `port-creature-system.js` unless noted.

## Constants
- `29-35` — ARENA_R, SOFT_EDGE, FOOT_GROUND(0.06), GRAV(10.0), KP(60), KD(16), H_DRAG(1.15), BOUNCE(0.25), BODY_MIN_CLEAR(0.30), BODY_VOLUME_CLEAR(0.10), BODY_COLLISION_PAD(0.28)

## Fixed-timestep accumulator
- `4607` FIXED=1/60; `4608` acc=0; `4717` acc+=dt
- `4780-4786` `while (acc>=FIXED && steps<5)` → physicsStep, resolveCreatureCollisions, applyBodyTerrainClearance

## Gravity & drag
- `2638` vel.y -= GRAV*h
- `2657-2658` vel.x/z *= (1 - H_DRAG*h)

## PD vertical body support
- `2599-2608` collect grounded legs into `_groundedBuf`; `2609` fG = grounded/total
- `2610-2626` support normal: single leg or convex hull of grounded feet
- `2621` pointInPoly(CoM.x, CoM.z, poly) → if inside, normal=(0,1,0)
- `2628-2684` nearest-edge fallback when CoM outside polygon
- `2639-2647` PD law: mag = GRAV + KP*(preferredY-pos.y) - KD*vel.y, clamped to [0, GRAV*4*fG]

## Leg stepping — scheduling
- `2431-2463` scheduleSteps: canMove decisions, maxConcurrent = floor(legs*maxConcurrentFraction), candidate sort by displacement, walk vs gallop (rowPairSteps) branches
- `2465-2471` startStep()
- `2399-2413` canWalkLegMove; `2415-2429` canGallopLegMove; `2395-2397` legDisplacement; `1840-1842` isGrounded

## Step animation
- `2566-2577` t += h/stepDuration; easeInOut; lerpVectors; sin(π·t)*stepLift arc; completion → addContactPulse

## Foot target + scan
- `2473-2498` rest position (rotate restLocal by yaw, sample terrain), move dir, lookahead, scan bounds; cheap mode samples lookahead only (2 terrain calls)
- `2500-2529` 3×3 grid scan (sg=gait.scanGrid): terrain sample per cell, vertical/comfort bounds check, Euclidean scoring + back-penalty, best-target assignment (10 terrain calls)

## Terrain sampling helpers
- `18-25` terrainNormal (finite diff, e=0.12); `2477/2493/2506` terrainHeight+FOOT_GROUND; `2668` +BODY_MIN_CLEAR; `2229` +BODY_VOLUME_CLEAR
- `568-570` horizontalDistance (hypot XZ)

## Support polygon geometry
- `594-612` convexHull (Graham scan); `614-626` pointInPoly (winding); `628-639` nearestOnPoly

## Body clearance
- `2215-2238` 9-point body box, rotate each, sample terrain+BODY_VOLUME_CLEAR, lift body by max intrusion, bounce vel

## Body orientation from feet
- `2710-2742` front/back/left/right leg averaging → pitch/roll targets via atan2 → lerp with preferredRotationLerp, clamp to leeway

## Yaw / velocity drive
- `2543-2548` desiredYaw = atan2(steering dir); clamp to ±turnSpeed*h
- `2536-2540` speedFraction, bodyHeight interp, trigger thresholds
- `2650-2660` targetSpeed drive scaled by cos(yawDiff) and fG; pos += vel*h

## Contact pulses
- `1055-1063` addContactPulse; `1065-1078` updateContactPulses (age/fade 0.55s)

## Creature-creature collision
- `4219-4261` creatureGrid.nearby → minDist by melee/collision radius → overlap push (×0.5) + velocity impulse

## Bridge/integration
- `port-creature-bridge.js:409-528` createEnvironmentPortCreatures; `484-519` update delegate
- `environment-viewer.html:805` instantiate; `3587` frame-loop call via frameProfiler
