# Creature Module Integration: Environment Viewer

Date: 2026-06-21

## Goal

Integrate the extracted `creature.js` module into `environment-viewer.html` without reintroducing viewer globals into the Creature class and without coupling creatures to terrain chunk internals, Octree/FPS collision, UI rebuild paths, renderer setup, or WebGPU material/node work.

The host contract stays:

```js
for (const c of creatures) c.computeSteering(creatures);
while (acc >= FIXED && steps < 5) {
  for (const c of creatures) c.physicsStep(FIXED);
  acc -= FIXED;
  steps++;
}
for (const c of creatures) c.render();
```

## Existing Host Hooks

`environment-viewer.html` already exposes the only terrain dependency Creature needs:

```js
function terrainHeight(x, z) { return terrainSystem.getHeight(x, z); }
```

Use that exact function or the equivalent inline adapter:

```js
terrainHeight: (x, z) => terrainSystem.getHeight(x, z)
```

Do not pass `terrainSystem`, `ground`, `terrainGroup`, `terrainCollisionGroup`, `worldOctree`, `cdlodRef`, or renderer state into Creature.

## Imports

Add the Creature import near the existing local module imports:

```js
import { BODY_HEIGHT, Creature, FIXED } from './creature.js';
```

`BODY_HEIGHT` is only needed for initial spawn height. `FIXED` should replace any viewer-local creature timestep constant.

## State

Add creature state beside the other scene-system refs:

```js
const creatureParams = {
  enabled: true,
  count: 7,
  arenaRadius: 24,
};
const creatures = [];
let creatureAcc = 0;
```

`terrain.size` is view/far distance in this viewer, not a finite terrain extent. Do not use `terrain.size * 0.2` here. Default `arenaRadius` should instead be derived from chunk reach or kept as a dedicated creature setting:

```js
function defaultCreatureArenaRadius() {
  return Math.max(
    18,
    terrainSystem.params.chunkSize * Math.max(1, terrainSystem.params.renderRadius) * 0.8
  );
}
```

For current defaults (`chunkSize=30`, `renderRadius=2`), this gives `48`, which keeps creatures inside the initially streamed area while still letting them roam visibly.

## Spawn / Reset

Add a reset function after `terrainHeight()` and before UI async module setup:

```js
function resetCreatures() {
  for (const c of creatures) {
    scene.remove(c.group);
    for (const leg of c.legs) {
      scene.remove(leg.upper, leg.lower, leg.knee, leg.foot);
    }
  }
  creatures.length = 0;

  if (!creatureParams.enabled) return;

  const arenaRadius = creatureParams.arenaRadius || defaultCreatureArenaRadius();
  const count = Math.max(0, Math.floor(creatureParams.count));
  for (let i = 0; i < count; i++) {
    const a = (i / Math.max(1, count)) * Math.PI * 2;
    const r = Math.min(9, arenaRadius * 0.35);
    const sx = Math.cos(a) * r;
    const sz = Math.sin(a) * r;
    const spawn = new THREE.Vector3(sx, terrainHeight(sx, sz) + BODY_HEIGHT, sz);
    creatures.push(new Creature({
      scene,
      terrainHeight: (x, z) => terrainSystem.getHeight(x, z),
      spawn,
      yaw: Math.random() * Math.PI * 2,
      hue: count > 1 ? 0.33 + (i / (count - 1)) * 0.17 : 0.42,
      arenaRadius,
    }));
  }
}
```

Call `resetCreatures()` once after `scene`, `terrainSystem`, and `terrainHeight()` exist.

If the implementation later adds `Creature.dispose()`, replace the manual `scene.remove(...)` loop with that method. Do not add disposal as part of this integration unless material/geometry lifetime becomes a real issue during repeated count changes.

## Terrain Rebuild / Draw Distance

In `rebuildWorld()`, keep creature objects alive. Their injected `terrainHeight` callback already reads the latest terrain params through `terrainSystem.getHeight()`.

After terrain params change, update arena radius and let feet/body settle over subsequent fixed steps:

```js
function syncCreatureArena() {
  const radius = creatureParams.arenaRadius || defaultCreatureArenaRadius();
  for (const c of creatures) c.setArenaRadius(radius);
}
```

Call `syncCreatureArena()` from:

1. `rebuildWorld()` after `terrainSystem.rebuild(terrain)`
2. `drawDistanceChange()` after `terrainSystem.params.renderRadius` changes
3. Creature UI changes that affect `arenaRadius`

Do not rebuild creatures for lake/water/base amplitude changes unless the user explicitly changes creature count or disables/enables creatures.

## Render Loop Placement

Insert creature simulation after camera/FPS movement has selected the terrain focus and `updateTerrainWindow(...)` has run, but before water, grass, CDLOD, and final render:

```js
if (creatureParams.enabled && creatures.length > 0) {
  creatureAcc += rawDt;
  for (const c of creatures) c.computeSteering(creatures);
  let steps = 0;
  while (creatureAcc >= FIXED && steps < 5) {
    for (const c of creatures) c.physicsStep(FIXED);
    creatureAcc -= FIXED;
    steps++;
  }
  if (steps === 5) creatureAcc = 0;
  for (const c of creatures) c.render();
}
```

Recommended location in current `animate()`:

```js
if (fpsMode) {
  ...
  updateTerrainWindow(playerCollider.end);
} else {
  applyCamera();
  updateTerrainWindow(target);
}

// creatures here

if (waterRef) {
  waterRef.update(now / 1000);
  syncWaterDebug();
}
```

Rationale:

- terrain streaming has had a chance to enqueue/refresh the current window
- creature render transforms are present for water reflection/refraction passes
- grass and CDLOD awaited compute passes stay near the end of the frame
- FPS mode and orbit mode both continue to simulate creatures

## UI

Use the existing debug panel helpers inside the existing `Promise.all([...trees...])` setup where `header`, `slider`, and `toggle` are available.

Add a compact section:

```js
header('Creatures');
toggle('creaturesEnabled', 'Enabled', () => {
  creatureParams.enabled = params.creaturesEnabled;
  resetCreatures();
});
slider('creatureCount', 'Count', 0, 24, 1, fi, () => {
  creatureParams.count = params.creatureCount;
  resetCreatures();
});
slider('creatureArenaRadius', 'Roam radius', 8, 180, 1, fi, () => {
  creatureParams.arenaRadius = params.creatureArenaRadius;
  syncCreatureArena();
});
```

Initialize backing values before adding controls:

```js
Object.assign(params, {
  creaturesEnabled: creatureParams.enabled,
  creatureCount: creatureParams.count,
  creatureArenaRadius: defaultCreatureArenaRadius(),
});
creatureParams.arenaRadius = params.creatureArenaRadius;
```

Keep this UI optional if the first integration should be lower risk. Minimum viable integration can hard-code count/radius and add UI later.

## Shadows, Water, And CDLOD

No special WebGPU work is required:

- Creature materials are `MeshStandardMaterial`, which renders under r0.184 WebGPU.
- Creatures are normal scene meshes; water reflection/refraction should include them automatically because they are present before `waterRef.update(...)`.
- CDLOD terrain is visual only; Creature collision/feet use the analytic height callback.
- Do not add creature geometry to `terrainCollisionGroup` or `worldOctree`.

## Debug / Metrics

Optional HUD additions:

```js
`creatures ${creatures.length}\n`
```

Do not include creature meshes in terrain draw/chunk counters. Renderer `calls` already captures aggregate scene cost.

## Acceptance Criteria

1. `environment-viewer.html` imports `Creature` from `./creature.js`.
2. Creature construction uses only `{ scene, terrainHeight, spawn, yaw, hue, arenaRadius }`.
3. No Creature code references `terrainSystem`, `ground`, `worldOctree`, `Capsule`, `Octree`, `cdlodRef`, `waterRef`, `grassRef`, or renderer objects.
4. The animate loop drives `computeSteering -> fixed physicsStep(FIXED) -> render`.
5. Terrain changes do not recreate creatures; draw-distance/radius changes call `setArenaRadius`.
6. Water reflection/refraction sees creature transforms from the current frame.
7. `node --check creature.js` and an ESM import smoke test against local `three@0.184.0` pass.
8. Browser smoke test: `environment-viewer.html?terrain=gpu` loads with visible creatures, no console errors, and FPS/orbit modes still work.

## Non-Goals

- No creature/FPS collision.
- No pathfinding around water or trees.
- No terrain chunk ownership of creatures.
- No node-material/TSL conversion.
- No extraction of renderer, terrain, water, grass, trees, UI, Octree, or player code.
