# Scout: Locomotion & Physics — TRACE (per-frame call chain & frequency)

## Call chain

- `environment-viewer.html:3587` → `frameProfiler.time('creatures', () => portCreatures.update(rawDt))` — per-frame (1x)
- `port-creature-system.js:4710` → `update(dt)`; accumulates `acc += dt` (line 4717) — per-frame
- `port-creature-system.js:4780-4786` → `while (acc >= FIXED && steps < 5)` fixed-step loop; `FIXED = 1/60` (line 4607). 0–5 iterations/frame (~1 @60fps, ~2 @120fps, up to 5 on dropped frames)
  - `4781` → `c.physicsStep(FIXED, gait, debug)` per creature (gated by `lodShouldSim`)
  - `4782` → `resolveCreatureCollisions(_activeCreatures)` per fixed step
  - `4783` → `c.applyBodyTerrainClearance()` per creature per fixed step

### Inside physicsStep (2534–2584)
- Leg loop `2551-2581`: `for (const leg of this.legs)`
  - `updateLegTarget` (2555): `fullFootScan = lodFullIk || lodDebugActive || forceFootTargetRefresh` (2550)
    - cheap scan: rest + lookahead = **2 terrainHeight() calls**
    - full scan: rest + 3×3 grid (2502-2519) = **10 terrainHeight() calls**
  - leg stepping interpolation (2566-2578); updates `leg.wants`
- `scheduleSteps` (2584): once per creature per fixed step; respects `maxConcurrentFraction`

## Frequency table

| Operation | Scope | Count per frame |
|---|---|---|
| `portCreatures.update()` | per-frame | 1 |
| Fixed timestep iterations | per-frame | 0–5 (typ. 1) |
| `creature.physicsStep()` | per-creature, per-fixed-step | N × steps |
| `updateLegTarget()` | per-leg, per-fixed-step | N_legs × N × steps |
| `terrainHeight()` cheap scan | per-leg, per-fixed-step | 2 × N_legs × N × steps |
| `terrainHeight()` full IK scan | per-leg, per-fixed-step | 10 × N_legs × N × steps |
| Leg stepping interpolation | per-leg, per-fixed-step | N_legs × N × steps |
| `scheduleSteps()` | per-creature, per-fixed-step | N × steps |
| `resolveCreatureCollisions()` | per-fixed-step | steps |

**Typical (60fps, 8 creatures, 4 legs):** 1 fixed step/frame; 64 cheap terrainHeight calls/frame (320 if full IK/debug active); 32 leg target updates/frame; ≤16 concurrent stepping legs.

**Notes:** accumulator decouples frames from fixed steps (dropped frames compress, ≤5 steps). Full scans cost 5× the terrain sampling of cheap scans. Leg stepping is phase-locked (1–2 legs step concurrently per gait).
