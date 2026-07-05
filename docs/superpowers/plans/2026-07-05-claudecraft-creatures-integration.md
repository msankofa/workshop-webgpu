# ClaudeCraft Creatures Integration: Combined Spec and Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the World of ClaudeCraft deterministic mob simulation as a second, independent creature system inside the WebGPU environment viewer, walking its GLB mob roster on the workshop's real (procedural and authored) terrain, fighting the workshop's players with full combat, and replicating over the existing host-authoritative multiplayer snapshot.

**Architecture:** Vendor `src/sim/` from ClaudeCraft unchanged except for three injected seams (terrain height, collision, external players), ship it as a committed prebuilt ESM bundle, drive it host-side at a fixed 20 Hz, and adapt every sim/workshop boundary through a thin `claudecraft-bridge/` layer that converts between sim "yard" space and workshop world space by a single scale factor. The workshop's own IK creatures are untouched; the only shared surface is the render scene and the multiplayer snapshot.

**Tech Stack:** JavaScript ESM (workshop, no runtime build step), TypeScript (vendored sim, bundled with esbuild), Three.js r0.184 WebGPU backend + `AnimationMixer`/`SkeletonUtils` for mob visuals, plain-`node` `console.assert` test scripts (repo convention, e.g. `multiplayer-test.mjs`).

---

## Part I: Specification

### 1. Summary

The workshop already has a procedural IK-limb creature system (`port-creature-system.js`) and a host-authoritative multiplayer relay (`multiplayer.js`, guests are read-only ghost renderers). This project adds a **separate** creature system: the ClaudeCraft mob simulation (`src/sim/`), which is a pure, deterministic, engine-free TypeScript core that spawns a families-based mob roster (beasts, spiders, mudfins, burrowers, humanoids, trolls, ogres, undead, elementals, dragonkin, demons), drives their AI/movement/combat, and returns per-tick state.

The two creature systems never share code. They coexist by both rendering into the same scene and both contributing entries to the same multiplayer snapshot.

### 2. Why this is feasible (established during investigation)

- **The sim has zero Three.js imports.** It never touches a renderer, so the r165-vs-r184 question does not apply to it. (`src/sim/CLAUDE.md`, enforced by `tests/architecture.test.ts`.)
- **The sim is host-authoritative and deterministic** (fixed 20 Hz tick, all randomness through a seeded `Rng`). This matches the workshop's existing "host simulates, guests interpolate ghosts" model exactly.
- **The ClaudeCraft renderer (`renderer.ts`, `gfx.ts`, `post.ts`) is r165-welded** (`onBeforeCompile` chunk patching, `three/examples/jsm/postprocessing/*`, `WebGLRenderer`) and is **discarded**. Only the character-visual layer (`src/render/characters/visual.ts`, `manifest.ts`, `anim_state.ts`) is reused — it uses only backend-agnostic scene-graph APIs (`GLTFLoader`, `SkeletonUtils.clone`, `AnimationMixer`, standard materials) that run under r184 `WebGPURenderer`.

### 3. The three injected seams

The sim reads three things from module-global functions that must be repointed at the workshop:

1. **Terrain height.** `terrainHeight(x,z,seed)` / `groundHeight(x,z,seed)` in `src/sim/world.ts` are module-level pure functions, statically imported across the sim. Downstream helpers (`terrainSteepness`, `terrainDownhill`, `nearSteepWalls`) derive from `groundHeight`, so overriding it propagates automatically.
2. **Collision.** `resolvePosition(seed,x,z,r,...)` in `src/sim/colliders.ts` (reached via `Sim.resolveMovePoint`, `sim.ts:6107`) reads ClaudeCraft's own prop layout. It must also consult the workshop's tree-trunk colliders (`trunkIndex.resolve` from `collision.js`).
3. **Players.** The sim's aggro/leash/threat all key off `ctx.players`/`playerGrid`, and `Sim.updatePlayerMovement(p, meta)` (`sim.ts:3164`) integrates player physics. For mobs to fight the workshop's players, each workshop player must exist as a sim player entity whose position is **mirrored in** each tick, while the sim owns its combat state (HP, threat, death), and the sim's own movement integration is **disabled** for these externally-controlled players so the two controllers do not fight.

### 4. Scale model (decision: derive from the workshop player size)

ClaudeCraft works in "yards": a humanoid is `HUMANOID_H = 2.6` world units tall (`manifest.ts`). The workshop has a live player-size setting. Define one scale factor:

```
SCALE = workshopPlayerHeightWorldUnits / 2.6
```

The sim runs entirely in yard-space. Conversion happens only at the bridge boundary:

- `toWorld(v) = v * SCALE` (sim yards -> workshop units)
- `toSim(v) = v / SCALE` (workshop units -> sim yards)

Applied at exactly four boundaries: the terrain height provider (round-trips through `toWorld`/`toSim`), the collider provider, mob render transforms, and player-pose mirroring + spawn placement. The sim never sees `SCALE`.

If the workshop player size changes at runtime, `SCALE` is recomputed and the sim is rebuilt (spawns re-seed); live rescale of a running sim is out of scope.

### 5. Full-combat decisions

- Mobs aggro, chase, leash, flee, and swing at mirrored player entities. The sim resolves damage against `playerEntity.hp`.
- The workshop reads `playerEntity.hp` / `playerEntity.dead` back each tick and reflects them on its own player HUD/state.
- On sim-side player death, the workshop runs its own death/respawn UX, then calls a bridge revive that resets the sim player entity (`hp = maxHp`, `dead = false`, threat cleared) and moves it to the respawn point.
- Movement-implying combat effects (knockback, root, stun) are surfaced as read-only state on the entity/events; whether the workshop's player controller honors them is a later, optional refinement (default: ignored, since the workshop owns movement).

### 6. Out of scope

- ClaudeCraft dungeons, delves, quests, market, mail, arena, party/raid systems (they ship in the vendored sim as data/types but are never driven; no doors are spawned).
- Server-authoritative simulation (the workshop's relay stays a dumb forwarder; the browser host remains authoritative, matching the current model).
- Guests running the sim (guests stay pure ghost renderers).
- Live rescale of a running sim.

### 7. Acceptance criteria

1. `node test-claudecraft-scale.mjs`, `node test-claudecraft-worldcontent.mjs`, `node test-claudecraft-seams.mjs`, `node test-claudecraft-mob-snapshot.mjs` all pass.
2. In-page (host/solo): the ClaudeCraft roster spawns at configured workshop coordinates, mobs stand on and walk across both procedural terrain and an authored map without floating or sinking, and mobs slide around tree trunks rather than passing through them.
3. A workshop player walking into a mob's aggro radius is chased and hit; the player's HP drops; killing the player triggers the workshop respawn flow; the mob leashes home when the player runs away.
4. Mob visuals render under the r184 WebGPU renderer with walk/idle/attack animation.
5. A guest sees the same mobs at interpolated positions and never runs the sim.
6. The workshop's existing IK creatures and multiplayer player capsules are unaffected.

---

## Part II: File Structure

**Vendored (copied in from ClaudeCraft, TypeScript, bundled):**
- `claudecraft-sim/` — verbatim copy of ClaudeCraft `src/sim/` (all of it). Edited only in `world.ts`, `colliders.ts`, `sim.ts` for the three seams.
- `claudecraft-sim/sim-entry.ts` — new: the bundle entry, re-exporting the public surface the workshop calls.
- `claudecraft-sim.bundle.js` — new, **committed**: esbuild output of `sim-entry.ts`.
- `claudecraft-assets/models/` — copied GLBs from ClaudeCraft `public/models/{creatures,chars,enemies,weapons}`.
- `claudecraft-render/manifest.js`, `anim_state.js`, `visual.js` — the reused character-visual layer (bundled or hand-ported to JS).

**Bridge (new, plain JS, in the workshop, unit-tested):**
- `claudecraft-bridge/sim-scale.js` — `SCALE` derivation + `toWorld`/`toSim`.
- `claudecraft-bridge/sim-world-content.js` — builds a `WorldContent` from a workshop spawn list.
- `claudecraft-bridge/sim-mob-snapshot.js` — serializes sim mob entities to the wire shape and back.
- `claudecraft-bridge/claudecraft-creatures.js` — the top-level factory `createClaudecraftCreatures(...)`: owns the `Sim`, the fixed-step loop, the player mirror, and the render adapter. Mirrors the shape of `port-creature-bridge.js`.

**Workshop files modified:**
- `environment-viewer.html` — construct + wire the bridge, extend `getState()`/guest render.
- `multiplayer.js` — extend `InterpolationBuffer` and `GhostRenderer` for mobs.
- `docs/subsystems/creature.md` — document the new second creature system.
- `agent_log.csv` — one row per milestone.

**Tests (new, plain `node`, repo root):**
- `test-claudecraft-scale.mjs`, `test-claudecraft-worldcontent.mjs`, `test-claudecraft-seams.mjs`, `test-claudecraft-mob-snapshot.mjs`.

---

## Part III: Implementation Plan

Milestones are independently testable. M0-M4 run headless in `node` (no GPU); M5-M6 need the page.

### Milestone M0: Vendor the sim and ship a bundle

#### Task 0.1: Copy the sim and create the bundle entry

**Files:**
- Create: `claudecraft-sim/` (copy of ClaudeCraft `src/sim/`)
- Create: `claudecraft-sim/sim-entry.ts`

- [ ] **Step 1: Copy the source tree**

Copy the entire ClaudeCraft `src/sim/` directory (from `research/_extracted/world-of-claudecraft-main/world-of-claudecraft-main/src/sim/`) into `claudecraft-sim/` at the workshop root. Keep the subfolders (`combat/`, `mob/`, `content/`, `delves/`, `encounters/`, `pet/`, `progression/`, `quests/`, `instances/`, `social/`, `loot/`, `targeting.ts`, etc.) intact.

- [ ] **Step 2: Write the bundle entry**

```typescript
// claudecraft-sim/sim-entry.ts
export { Sim } from './sim';
export { createMob } from './entity';
export { MOBS } from './data';
export { setActiveWorldContent, getActiveWorldContent } from './data';
// Seams added in later tasks (declared here now so the entry is stable):
export { setHeightProvider, setWaterLevelProvider } from './world';
export { setExternalColliderResolver } from './colliders';
export type { Entity, WorldContent, SimEvent } from './types';
```

- [ ] **Step 3: Add the build script**

Add to `package.json` scripts (create the block if absent):

```json
"build:claudecraft-sim": "esbuild claudecraft-sim/sim-entry.ts --bundle --format=esm --platform=browser --target=es2022 --outfile=claudecraft-sim.bundle.js"
```

- [ ] **Step 4: Attempt the build (expected to fail on the not-yet-added seam exports)**

Run: `npx esbuild claudecraft-sim/sim-entry.ts --bundle --format=esm --platform=browser --target=es2022 --outfile=claudecraft-sim.bundle.js`
Expected: FAIL — `setHeightProvider`/`setWaterLevelProvider`/`setExternalColliderResolver` are not yet exported (added in Tasks 1.1 and 3.1). This confirms esbuild resolves the tree.

- [ ] **Step 5: Commit**

```bash
git add claudecraft-sim package.json
git commit -m "feat(claudecraft): vendor ClaudeCraft sim source + bundle entry"
```

#### Task 0.2: Prove the sim constructs and ticks headless (after seams land)

This task's verification runs at the end of M1 (the seams must exist to build the bundle). It is listed here to pin the M0 goal.

- [ ] **Step 1: Write the smoke test**

```javascript
// test-claudecraft-boot.mjs
import { Sim } from './claudecraft-sim.bundle.js';
const sim = new Sim({ seed: 1, playerClass: 'warrior' });
let events = [];
for (let i = 0; i < 20; i++) events = sim.tick();
console.assert(Array.isArray(events), 'tick returns an event array');
let mobCount = 0;
for (const e of sim.entities.values()) if (e.kind === 'mob') mobCount++;
console.assert(mobCount > 0, `expected mobs from the built-in world, got ${mobCount}`);
console.log('boot OK, mobs:', mobCount);
```

- [ ] **Step 2: Run after M1 builds the bundle**

Run: `node test-claudecraft-boot.mjs`
Expected: `boot OK, mobs: <n>` with `n > 0`.

---

### Milestone M1: Scale + terrain seam

#### Task 1.1: Add the height provider to the vendored `world.ts`

**Files:**
- Modify: `claudecraft-sim/world.ts`

- [ ] **Step 1: Add the provider state and setters at the top of the file (after imports)**

```typescript
// Injected height provider (workshop integration). When set, terrainHeight
// delegates to it instead of computing the built-in heightfield. Args and
// return are in SIM units (yards). groundHeight, steepness, and downhill all
// derive from terrainHeight, so they follow automatically.
let heightProvider: ((x: number, z: number, seed: number) => number) | null = null;
export function setHeightProvider(fn: ((x: number, z: number, seed: number) => number) | null): void {
  heightProvider = fn;
}
let waterLevelProvider: (() => number) | null = null;
export function setWaterLevelProvider(fn: (() => number) | null): void {
  waterLevelProvider = fn;
}
```

- [ ] **Step 2: Delegate `terrainHeight` to the provider**

At the very start of `export function terrainHeight(x, z, seed)` (currently line ~326), add:

```typescript
export function terrainHeight(x: number, z: number, seed: number): number {
  if (heightProvider) return heightProvider(x, z, seed);
  const w = world();
  // ...existing body unchanged...
```

- [ ] **Step 3: Delegate `waterLevel`**

In `export function waterLevel()` (line ~27), add the provider check first:

```typescript
export function waterLevel(): number {
  if (waterLevelProvider) return waterLevelProvider();
  return world().content.waterLevel ?? WATER_LEVEL;
}
```

- [ ] **Step 4: Disable the built-in invisible walls**

Replace the body of `export function nearSteepWalls(x, z)` (line ~419) with:

```typescript
export function nearSteepWalls(x: number, z: number): boolean {
  // Workshop integration: no built-in ridge/rim walls. The climb-slope gate
  // still runs against the injected terrain via terrainSteepnessAt, which is
  // what stops mobs scaling the workshop's real cliffs.
  return false;
}
```

- [ ] **Step 5: Commit**

```bash
git add claudecraft-sim/world.ts
git commit -m "feat(claudecraft): inject terrain height/water seam into world.ts"
```

#### Task 1.2: The scale module (TDD)

**Files:**
- Create: `claudecraft-bridge/sim-scale.js`
- Test: `test-claudecraft-scale.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// test-claudecraft-scale.mjs
import { makeScale } from './claudecraft-bridge/sim-scale.js';
// A workshop player 3.9 units tall maps the 2.6-yard sim humanoid to that height.
const s = makeScale(3.9);
console.assert(Math.abs(s.SCALE - 1.5) < 1e-9, `SCALE should be 1.5, got ${s.SCALE}`);
console.assert(Math.abs(s.toWorld(2) - 3) < 1e-9, 'toWorld(2) should be 3');
console.assert(Math.abs(s.toSim(3) - 2) < 1e-9, 'toSim(3) should be 2');
console.assert(Math.abs(s.toSim(s.toWorld(7.25)) - 7.25) < 1e-9, 'round-trips');
console.log('scale OK');
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test-claudecraft-scale.mjs`
Expected: FAIL — cannot find module / `makeScale is not a function`.

- [ ] **Step 3: Implement**

```javascript
// claudecraft-bridge/sim-scale.js
// ClaudeCraft humanoid reference height in sim yards (manifest.ts HUMANOID_H).
export const SIM_HUMANOID_HEIGHT = 2.6;

export function makeScale(workshopPlayerHeight) {
  const SCALE = workshopPlayerHeight / SIM_HUMANOID_HEIGHT;
  return {
    SCALE,
    toWorld: (v) => v * SCALE,
    toSim: (v) => v / SCALE,
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node test-claudecraft-scale.mjs`
Expected: `scale OK`.

- [ ] **Step 5: Commit**

```bash
git add claudecraft-bridge/sim-scale.js test-claudecraft-scale.mjs
git commit -m "feat(claudecraft): scale conversion module"
```

#### Task 1.3: Build the bundle and verify the height seam end to end (TDD against the bundle)

**Files:**
- Test: `test-claudecraft-seams.mjs`

- [ ] **Step 1: Build the bundle**

Run: `npm run build:claudecraft-sim`
Expected: PASS — writes `claudecraft-sim.bundle.js` (the seam exports now exist).

- [ ] **Step 2: Write the failing test**

```javascript
// test-claudecraft-seams.mjs
import { Sim, setHeightProvider, setWaterLevelProvider } from './claudecraft-sim.bundle.js';
import { makeScale } from './claudecraft-bridge/sim-scale.js';

const s = makeScale(2.6); // SCALE = 1 for a clean assertion
// A flat workshop terrain at world-height 5 everywhere.
setHeightProvider((sx, sz) => s.toSim(5));
setWaterLevelProvider(() => s.toSim(-2));

const sim = new Sim({ seed: 1, playerClass: 'warrior' });
for (let i = 0; i < 10; i++) sim.tick();
let checked = 0;
for (const e of sim.entities.values()) {
  if (e.kind !== 'mob') continue;
  console.assert(Math.abs(e.pos.y - 5) < 0.5, `mob y should track injected terrain (~5), got ${e.pos.y}`);
  checked++;
}
console.assert(checked > 0, 'had mobs to check');
console.log('height seam OK, mobs on injected terrain:', checked);
```

- [ ] **Step 3: Run to verify it fails, then passes**

Run: `node test-claudecraft-seams.mjs`
Expected first: if the seam were not wired, mob `y` tracks the built-in heightfield (not ~5). With Task 1.1 in place it should PASS: `height seam OK, mobs on injected terrain: <n>`.

- [ ] **Step 4: Run the M0 boot smoke test now that the bundle builds**

Run: `node test-claudecraft-boot.mjs`
Expected: `boot OK, mobs: <n>`.

- [ ] **Step 5: Commit**

```bash
git add claudecraft-sim.bundle.js test-claudecraft-seams.mjs test-claudecraft-boot.mjs
git commit -m "feat(claudecraft): build bundle, verify terrain height seam"
```

---

### Milestone M2: Spawns via WorldContent

#### Task 2.1: The WorldContent builder (TDD)

**Files:**
- Create: `claudecraft-bridge/sim-world-content.js`
- Test: `test-claudecraft-worldcontent.mjs`

Note: `mobId` values are the keys of the exported `MOBS` table. The builder takes spawn defs already expressed in **workshop** coordinates and converts them to sim yards.

- [ ] **Step 1: Write the failing test**

```javascript
// test-claudecraft-worldcontent.mjs
import { MOBS } from './claudecraft-sim.bundle.js';
import { makeScale } from './claudecraft-bridge/sim-scale.js';
import { buildClaudecraftWorldContent } from './claudecraft-bridge/sim-world-content.js';

// pick any real mob template id from the roster
const anyMobId = Object.keys(MOBS)[0];
const s = makeScale(5.2); // SCALE = 2
const content = buildClaudecraftWorldContent({
  scale: s,
  waterLevelWorld: -8,
  playerStartWorld: { x: 20, z: 40 },
  camps: [{ mobId: anyMobId, count: 3, centerWorld: { x: 100, z: 200 }, radiusWorld: 30 }],
});

console.assert(content.camps.length === 1, 'one camp');
console.assert(content.camps[0].mobId === anyMobId, 'mob id preserved');
console.assert(content.camps[0].count === 3, 'count preserved');
console.assert(Math.abs(content.camps[0].center.x - 50) < 1e-9, 'center x converted to sim yards (100/2)');
console.assert(Math.abs(content.camps[0].radius - 15) < 1e-9, 'radius converted (30/2)');
console.assert(Math.abs(content.waterLevel - -4) < 1e-9, 'water level converted (-8/2)');
console.assert(Math.abs(content.playerStart.x - 10) < 1e-9, 'player start converted (20/2)');
console.assert(Array.isArray(content.zones) && content.zones.length >= 1, 'has at least one zone');
console.assert(Object.keys(content.npcs).length === 0, 'no npcs');
console.assert(content.groundObjects.length === 0, 'no ground objects');
console.log('worldcontent OK');
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test-claudecraft-worldcontent.mjs`
Expected: FAIL — `buildClaudecraftWorldContent is not a function`.

- [ ] **Step 3: Implement**

```javascript
// claudecraft-bridge/sim-world-content.js
// Builds a minimal ClaudeCraft WorldContent for the workshop: one flat zone
// spanning the play area, no NPCs / ground objects / dungeon doors, camps
// placed from workshop coordinates converted to sim yards. Terrain height is
// injected separately (setHeightProvider), so the zone's biome shape is
// irrelevant — it exists only to satisfy the WorldContent contract and to give
// mob spawn placement a band to live in.
export function buildClaudecraftWorldContent({
  scale,
  waterLevelWorld,
  playerStartWorld,
  camps,
  zoneHalfExtentWorld = 4000,
}) {
  const half = scale.toSim(zoneHalfExtentWorld);
  return {
    zones: [
      {
        biome: 'vale',
        zMin: -half,
        zMax: half,
        hub: { x: 0, z: 0, radius: 1 },
        lakes: [],
      },
    ],
    camps: camps.map((c) => ({
      mobId: c.mobId,
      count: c.count,
      center: { x: scale.toSim(c.centerWorld.x), z: scale.toSim(c.centerWorld.z) },
      radius: scale.toSim(c.radiusWorld),
    })),
    npcs: {},
    groundObjects: [],
    roads: [],
    camps_meta: undefined,
    terrainEdits: [],
    biomePaint: null,
    waterLevel: scale.toSim(waterLevelWorld),
    playerStart: { x: scale.toSim(playerStartWorld.x), z: scale.toSim(playerStartWorld.z) },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node test-claudecraft-worldcontent.mjs`
Expected: `worldcontent OK`.

- [ ] **Step 5: Verify the sim actually spawns the requested roster**

Append to `test-claudecraft-worldcontent.mjs`:

```javascript
import { Sim, setActiveWorldContent, setHeightProvider } from './claudecraft-sim.bundle.js';
setHeightProvider((sx, sz) => 0);
setActiveWorldContent(content);
const sim = new Sim({ seed: 1, playerClass: 'warrior' });
let count = 0;
for (const e of sim.entities.values()) if (e.kind === 'mob' && e.templateId === anyMobId) count++;
console.assert(count === 3, `expected 3 spawned mobs of ${anyMobId}, got ${count}`);
console.log('spawn OK');
```

Run: `node test-claudecraft-worldcontent.mjs`
Expected: `worldcontent OK` then `spawn OK`.

> If `WorldContent` requires fields not set above (a `tsc`/runtime error names them), open `claudecraft-sim/types.ts`, read the `WorldContent` interface, and add the missing fields with empty/neutral values in the builder. Do not guess — copy the exact field names from the interface.

- [ ] **Step 6: Commit**

```bash
git add claudecraft-bridge/sim-world-content.js test-claudecraft-worldcontent.mjs
git commit -m "feat(claudecraft): world-content builder + spawn verification"
```

---

### Milestone M3: Collision seam

#### Task 3.1: Add the external collider resolver to the vendored `colliders.ts`

**Files:**
- Modify: `claudecraft-sim/colliders.ts`

- [ ] **Step 1: Read the resolver signature**

Open `claudecraft-sim/colliders.ts` and locate `export function resolvePosition(seed, x, z, r, ...)`. Note its exact parameter list and its return shape `{ x, z }` (confirmed used at `sim.ts:6109`).

- [ ] **Step 2: Add the injected resolver state (top of file, after imports)**

```typescript
// Injected workshop collider (tree trunks etc.). Applied AFTER the built-in
// prop resolution, in SIM units. Returns the adjusted {x,z} (also sim units).
let externalResolver: ((x: number, z: number, r: number) => { x: number; z: number }) | null = null;
export function setExternalColliderResolver(
  fn: ((x: number, z: number, r: number) => { x: number; z: number }) | null,
): void {
  externalResolver = fn;
}
```

- [ ] **Step 3: Apply it at the end of `resolvePosition`**

Immediately before `resolvePosition` returns its `{ x, z }` result, insert:

```typescript
  if (externalResolver) {
    const adjusted = externalResolver(x, z, r);
    x = adjusted.x;
    z = adjusted.z;
  }
```

(Assign into the same locals the function already returns; if it returns a fresh object literal, build that object from the adjusted `x`/`z`.)

- [ ] **Step 4: Rebuild the bundle**

Run: `npm run build:claudecraft-sim`
Expected: PASS.

- [ ] **Step 5: Write the seam test**

Append to `test-claudecraft-seams.mjs`:

```javascript
import { setExternalColliderResolver } from './claudecraft-sim.bundle.js';
let resolverCalls = 0;
// A resolver that pins everything to a fixed point proves it is consulted.
setExternalColliderResolver((x, z, r) => { resolverCalls++; return { x: 1, z: 1 }; });
const sim2 = new Sim({ seed: 2, playerClass: 'warrior' });
for (let i = 0; i < 40; i++) sim2.tick(); // let wandering mobs move -> resolveMovePoint
console.assert(resolverCalls > 0, 'external collider resolver was consulted during movement');
setExternalColliderResolver(null); // reset for other tests
console.log('collider seam OK, calls:', resolverCalls);
```

- [ ] **Step 6: Run**

Run: `node test-claudecraft-seams.mjs`
Expected: `collider seam OK, calls: <n>` with `n > 0`.

- [ ] **Step 7: Commit**

```bash
git add claudecraft-sim/colliders.ts claudecraft-sim.bundle.js test-claudecraft-seams.mjs
git commit -m "feat(claudecraft): inject workshop collider resolver into colliders.ts"
```

---

### Milestone M4: Player bridge + full combat

#### Task 4.1: Add external-player support to the vendored `sim.ts`

**Files:**
- Modify: `claudecraft-sim/sim.ts`

- [ ] **Step 1: Add an `external` flag through `addPlayer`**

In `addPlayer(cls, name, opts?)` (line ~1352), extend `opts` handling so the created `PlayerMeta` carries `external`. Find where the `meta: PlayerMeta = { ... }` object is built (line ~1390) and add:

```typescript
      external: opts?.external ?? false,
```

Update the `opts?` type in the signature to include `external?: boolean` (add it to the inline `opts` type list).

- [ ] **Step 2: Add `external` to the `PlayerMeta` type**

Open `claudecraft-sim/types.ts`, find `interface PlayerMeta`, and add:

```typescript
  /** Workshop integration: position is mirrored in from the host; the sim
   *  does not integrate this player's movement (updatePlayerMovement early-returns). */
  external?: boolean;
```

- [ ] **Step 3: Skip sim movement integration for external players**

At the top of `private updatePlayerMovement(p: Entity, meta: PlayerMeta)` (line ~3164), add:

```typescript
    if (meta.external) return; // host owns this player's position (mirrored in)
```

- [ ] **Step 4: Add the pose-mirror and revive helpers (public methods on `Sim`)**

Add near `addPlayer`:

```typescript
  /** Mirror an external player's world pose into the sim (positions in SIM units). */
  setPlayerPose(pid: number, x: number, y: number, z: number, facing: number): void {
    const meta = this.players.get(pid);
    if (!meta) return;
    const e = this.entities.get(meta.entityId);
    if (!e) return;
    e.prevPos = { ...e.pos };
    e.pos.x = x; e.pos.y = y; e.pos.z = z;
    e.prevFacing = e.facing;
    e.facing = facing;
  }

  /** Reset an external player entity after the workshop respawns it. */
  reviveExternalPlayer(pid: number, x: number, y: number, z: number): void {
    const meta = this.players.get(pid);
    if (!meta) return;
    const e = this.entities.get(meta.entityId);
    if (!e) return;
    e.hp = e.maxHp;
    e.dead = false;
    e.auras = [];
    e.pos = { x, y, z };
    e.prevPos = { ...e.pos };
  }
```

> If `players` or `entities` are private with different accessor names, use the names the file actually uses (grep `this.players` / `this.entities` in `sim.ts` — both are used publicly elsewhere, e.g. `fiesta_bots.ts` reads `sim.entities`).

- [ ] **Step 5: Rebuild and export the new methods (they are instance methods, already reachable via the exported `Sim`)**

Run: `npm run build:claudecraft-sim`
Expected: PASS.

- [ ] **Step 6: Write the combat/mirror test**

Append to `test-claudecraft-seams.mjs`:

```javascript
import { setActiveWorldContent, MOBS } from './claudecraft-sim.bundle.js';
import { buildClaudecraftWorldContent } from './claudecraft-bridge/sim-world-content.js';
import { makeScale } from './claudecraft-bridge/sim-scale.js';
const sc = makeScale(2.6);
setHeightProvider((x, z) => 0);
const aggressiveMob = Object.keys(MOBS)[0];
setActiveWorldContent(buildClaudecraftWorldContent({
  scale: sc, waterLevelWorld: -20, playerStartWorld: { x: 0, z: 0 },
  camps: [{ mobId: aggressiveMob, count: 1, centerWorld: { x: 3, z: 0 }, radiusWorld: 0.1 }],
}));
const sim3 = new Sim({ seed: 3, playerClass: 'warrior' });
// primary auto-player is pid returned by first player; find it
const pid = [...sim3.players.keys()][0];
sim3.players.get(pid).external = true; // mark the primary player external
// stand the player right next to the mob every tick
let playerEntityId = sim3.players.get(pid).entityId;
let sawAggro = false;
for (let i = 0; i < 200; i++) {
  sim3.setPlayerPose(pid, 3, 0, 0, 0);
  sim3.tick();
  for (const e of sim3.entities.values()) {
    if (e.kind === 'mob' && (e.aiState === 'chase' || e.aiState === 'attack')) sawAggro = true;
  }
}
console.assert(sawAggro, 'mob should aggro the mirrored player');
console.log('combat mirror OK');
```

- [ ] **Step 7: Run**

Run: `node test-claudecraft-seams.mjs`
Expected: all prior lines plus `combat mirror OK`.

- [ ] **Step 8: Commit**

```bash
git add claudecraft-sim/sim.ts claudecraft-sim/types.ts claudecraft-sim.bundle.js test-claudecraft-seams.mjs
git commit -m "feat(claudecraft): external-player mirror + revive, disable sim movement for external players"
```

#### Task 4.2: The mob-snapshot serializer (TDD)

**Files:**
- Create: `claudecraft-bridge/sim-mob-snapshot.js`
- Test: `test-claudecraft-mob-snapshot.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// test-claudecraft-mob-snapshot.mjs
import { serializeMobs } from './claudecraft-bridge/sim-mob-snapshot.js';
import { makeScale } from './claudecraft-bridge/sim-scale.js';
const s = makeScale(5.2); // SCALE = 2
const fakeEntities = new Map([
  [1, { kind: 'mob', templateId: 'forest_wolf', pos: { x: 10, y: 2, z: 4 }, facing: 0, hp: 30, maxHp: 40, dead: false, aiState: 'chase' }],
  [2, { kind: 'player', pos: { x: 0, y: 0, z: 0 } }],
  [3, { kind: 'mob', templateId: 'wild_boar', pos: { x: -1, y: 0, z: 0 }, facing: Math.PI, hp: 0, maxHp: 20, dead: true, aiState: 'idle' }],
]);
const wire = serializeMobs(fakeEntities, s);
console.assert(wire.length === 2, `only mobs serialized, got ${wire.length}`);
const wolf = wire.find((m) => m.id === 1);
console.assert(wolf.tid === 'forest_wolf', 'template id');
console.assert(Math.abs(wolf.p[0] - 20) < 1e-9, 'x scaled to world (10*2)');
console.assert(Math.abs(wolf.p[1] - 4) < 1e-9, 'y scaled to world (2*2)');
console.assert(Math.abs(wolf.hp - 0.75) < 1e-9, 'hp normalized 30/40');
console.assert(wolf.q.length === 4, 'quaternion has 4 components');
console.assert(wire.find((m) => m.id === 3).dead === true, 'dead flag carried');
console.log('mob snapshot OK');
```

- [ ] **Step 2: Run to verify it fails**

Run: `node test-claudecraft-mob-snapshot.mjs`
Expected: FAIL — `serializeMobs is not a function`.

- [ ] **Step 3: Implement**

```javascript
// claudecraft-bridge/sim-mob-snapshot.js
// Serializes sim mob entities (yard space) to the multiplayer wire shape
// (world space): { id, tid, p:[x,y,z], q:[x,y,z,w], hp:0..1, dead }.
// Quaternion is a pure yaw from facing (0 = +Z), so guests need no sim.
function yawQuat(facing) {
  const h = facing / 2;
  return [0, Math.sin(h), 0, Math.cos(h)];
}
export function serializeMobs(entities, scale) {
  const out = [];
  for (const e of entities.values()) {
    if (e.kind !== 'mob') continue;
    out.push({
      id: e.id ?? undefined,
      tid: e.templateId,
      p: [scale.toWorld(e.pos.x), scale.toWorld(e.pos.y), scale.toWorld(e.pos.z)],
      q: yawQuat(e.facing),
      hp: e.maxHp > 0 ? e.hp / e.maxHp : 0,
      dead: !!e.dead,
    });
  }
  return out;
}
```

> The fake entities in the test omit `id`; add `id` keys matching the Map keys if the real sim entity does not carry `e.id`. Confirm by grepping `entity.ts` `baseEntity` — if entities have an `id` field, `e.id` is correct; otherwise iterate `entities.entries()` and use the key.

- [ ] **Step 4: Run to verify it passes**

Run: `node test-claudecraft-mob-snapshot.mjs`
Expected: `mob snapshot OK`.

- [ ] **Step 5: Commit**

```bash
git add claudecraft-bridge/sim-mob-snapshot.js test-claudecraft-mob-snapshot.mjs
git commit -m "feat(claudecraft): mob snapshot serializer (yard->world, hp norm, yaw quat)"
```

#### Task 4.3: The top-level bridge factory (host loop, player mirror, combat readback)

**Files:**
- Create: `claudecraft-bridge/claudecraft-creatures.js`

This factory has no unit test (it drives the live sim + workshop); it is verified in-page in M5. It must be written with complete, real code.

- [ ] **Step 1: Implement the factory**

```javascript
// claudecraft-bridge/claudecraft-creatures.js
import {
  Sim, setActiveWorldContent, setHeightProvider, setWaterLevelProvider,
  setExternalColliderResolver,
} from '../claudecraft-sim.bundle.js';
import { makeScale } from './sim-scale.js';
import { buildClaudecraftWorldContent } from './sim-world-content.js';
import { serializeMobs } from './sim-mob-snapshot.js';

const SIM_DT = 1 / 20; // the sim is a fixed 20 Hz step; never call tick faster.

export function createClaudecraftCreatures({
  workshopPlayerHeight,   // world units, from the live player-size setting
  terrainHeight,          // (x,z) -> world height, covers procedural AND authored
  waterLevelWorld,        // world height of water
  trunkResolve,           // (x,z,r) -> {x,z} in world units (collision.js trunkIndex.resolve)
  camps,                  // [{ mobId, count, centerWorld, radiusWorld }]
  playerStartWorld,       // {x,z}
  seed = 1,
}) {
  const scale = makeScale(workshopPlayerHeight);

  // Wire the three seams (all in SIM units at the sim boundary).
  setHeightProvider((sx, sz) => scale.toSim(terrainHeight(scale.toWorld(sx), scale.toWorld(sz))));
  setWaterLevelProvider(() => scale.toSim(waterLevelWorld));
  setExternalColliderResolver((sx, sz, sr) => {
    const w = trunkResolve(scale.toWorld(sx), scale.toWorld(sz), scale.toWorld(sr));
    return { x: scale.toSim(w.x), z: scale.toSim(w.z) };
  });

  setActiveWorldContent(buildClaudecraftWorldContent({
    scale, waterLevelWorld, playerStartWorld, camps,
  }));

  const sim = new Sim({ seed, playerClass: 'warrior' });

  // The primary auto-added player becomes the local workshop player, mirrored in.
  const localPid = [...sim.players.keys()][0];
  sim.players.get(localPid).external = true;
  const remotePids = new Map(); // workshop playerId -> sim pid

  let acc = 0;
  const mobs = []; // latest wire snapshot, refreshed each sim tick

  function addRemotePlayer(workshopId) {
    const pid = sim.addPlayer('warrior', String(workshopId), { external: true });
    remotePids.set(workshopId, pid);
    return pid;
  }
  function removeRemotePlayer(workshopId) {
    const pid = remotePids.get(workshopId);
    if (pid != null) { sim.removePlayer(pid); remotePids.delete(workshopId); }
  }

  // Called once per workshop frame with the real dt and the live player poses.
  function update(dt, { localPlayerWorld, remotePlayersWorld = [] }) {
    // Mirror poses in SIM units before stepping.
    const mirror = (pid, w) => sim.setPlayerPose(
      pid, scale.toSim(w.x), scale.toSim(w.y), scale.toSim(w.z), w.facing ?? 0,
    );
    acc += dt;
    let stepped = false;
    while (acc >= SIM_DT) {
      if (localPlayerWorld) mirror(localPid, localPlayerWorld);
      for (const rp of remotePlayersWorld) {
        let pid = remotePids.get(rp.id);
        if (pid == null) pid = addRemotePlayer(rp.id);
        mirror(pid, rp);
      }
      sim.tick();
      acc -= SIM_DT;
      stepped = true;
    }
    if (stepped) {
      mobs.length = 0;
      for (const m of serializeMobs(sim.entities, scale)) mobs.push(m);
    }
    return mobs;
  }

  // Combat readback for the local player.
  function localPlayerCombat() {
    const meta = sim.players.get(localPid);
    const e = sim.entities.get(meta.entityId);
    return { hp: e.maxHp > 0 ? e.hp / e.maxHp : 0, dead: !!e.dead };
  }
  function reviveLocalPlayer(worldPos) {
    sim.reviveExternalPlayer(
      localPid, scale.toSim(worldPos.x), scale.toSim(worldPos.y), scale.toSim(worldPos.z),
    );
  }

  return {
    update, mobs: () => mobs, scale,
    localPlayerCombat, reviveLocalPlayer,
    addRemotePlayer, removeRemotePlayer,
    _sim: sim, // escape hatch for debugging only
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add claudecraft-bridge/claudecraft-creatures.js
git commit -m "feat(claudecraft): bridge factory (fixed-step loop, seams, player mirror, combat readback)"
```

---

### Milestone M5: Rendering on r184

#### Task 5.1: Milestone A — prove the loop with placeholder meshes (in-page)

**Files:**
- Modify: `environment-viewer.html`

- [ ] **Step 1: Import and construct the bridge**

Near the other static imports (the block with `createEnvironmentPortCreatures`), add:

```javascript
import { createClaudecraftCreatures } from './claudecraft-bridge/claudecraft-creatures.js';
```

After `portCreatures` is constructed (line ~351), add (using the already-available `terrainHeight`, `trunkIndex`, and the live player-size setting — reference the workshop's existing player-height variable; grep the file for the player size / capsule height setting and use its real name):

```javascript
const claudecraftCreatures = createClaudecraftCreatures({
  workshopPlayerHeight: PLAYER_HEIGHT, // real symbol from the player-size setting
  terrainHeight,
  waterLevelWorld: terrain.waterLevel ?? 0,
  trunkResolve: (x, z, r) => trunkIndex.resolve(x, z, r),
  camps: [
    // seed a few real roster ids near spawn for the smoke test
    { mobId: 'forest_wolf', count: 6, centerWorld: { x: 30, z: 30 }, radiusWorld: 20 },
  ],
  playerStartWorld: { x: 0, z: 0 },
  seed: 1,
});
```

- [ ] **Step 2: Add a placeholder render group**

Create one `THREE.InstancedMesh` (a simple box, capacity 512) added to `scene`, and a per-frame function that writes each mob's world position from `claudecraftCreatures.mobs()` into an instance matrix.

```javascript
const ccDebugGeo = new THREE.BoxGeometry(1, 1, 1);
const ccDebugMat = new THREE.MeshStandardMaterial({ color: 0xcc4444 });
const ccDebugMesh = new THREE.InstancedMesh(ccDebugGeo, ccDebugMat, 512);
ccDebugMesh.count = 0;
scene.add(ccDebugMesh);
const _ccM = new THREE.Matrix4();
const _ccQ = new THREE.Quaternion();
const _ccP = new THREE.Vector3();
const _ccS = new THREE.Vector3(1, 1, 1);
function renderClaudecraftDebug(mobs) {
  ccDebugMesh.count = Math.min(mobs.length, 512);
  for (let i = 0; i < ccDebugMesh.count; i++) {
    const m = mobs[i];
    _ccP.set(m.p[0], m.p[1], m.p[2]);
    _ccQ.set(m.q[0], m.q[1], m.q[2], m.q[3]);
    _ccM.compose(_ccP, _ccQ, _ccS);
    ccDebugMesh.setMatrixAt(i, _ccM);
  }
  ccDebugMesh.instanceMatrix.needsUpdate = true;
}
```

- [ ] **Step 3: Drive it from `animate()`**

Where `portCreatures.update(rawDt)` is called (line ~2804), add alongside it:

```javascript
frameProfiler.time('claudecraft', () => {
  const localPlayerWorld = getLocalPlayerWorldPose(); // {x,y,z,facing} from the workshop player
  const mobs = claudecraftCreatures.update(rawDt, { localPlayerWorld });
  renderClaudecraftDebug(mobs);
});
```

Use the workshop's real local-player pose source for `getLocalPlayerWorldPose()` (grep for the player capsule / camera rig position).

- [ ] **Step 4: Manual verification**

Run: `python serve.py` then open `http://127.0.0.1:8080/environment-viewer.html?creatures=on`.
Expected: red boxes appear near (30,30) in world space, sitting on the terrain surface (not floating/sunk), and wandering. Walk the player into them: boxes turn to chase and follow, then return home when you leave. Load an authored map and confirm the boxes still sit on its surface.

- [ ] **Step 5: Commit**

```bash
git add environment-viewer.html
git commit -m "feat(claudecraft): M5A in-page loop with placeholder mob meshes"
```

#### Task 5.2: Milestone B — skinned GLB visuals on r184

**Files:**
- Create: `claudecraft-render/` (ported `manifest.js`, `anim_state.js`, `visual.js`)
- Create: `claudecraft-assets/models/` (copied GLBs)
- Modify: `environment-viewer.html`

- [ ] **Step 1: Copy assets**

Copy the GLBs referenced by `manifest.ts` from ClaudeCraft `public/models/{creatures,chars,enemies,weapons}/` into `claudecraft-assets/models/` preserving subfolders. (They are plain data; version-independent.)

- [ ] **Step 2: Port the character-visual layer to JS**

Copy `manifest.ts`, `anim_state.ts`, and `visual.ts` into `claudecraft-render/` as `.js`, stripping types (or add them to the esbuild bundle as a second entry `claudecraft-render/index.ts` and build a `claudecraft-render.bundle.js` exporting `createCharacterVisual`, `visualKeyFor`, `prepareVisual`). Repoint the asset base path from `models/...` to `claudecraft-assets/models/...`. Replace the r165 asset loader with the workshop's GLTFLoader usage.

- [ ] **Step 3: Confirm r184 WebGPU renders one skinned mob**

Add a single mob's `CharacterVisual` to the scene, load its GLB via the workshop's `GLTFLoader`, and drive its `AnimationMixer` from `update(dt, animState)`. Build `animState` from render-space displacement (reuse `anim_state.js` `desiredBaseState`/`locomotionTimeScale`, and optionally `locomotion.ts` hysteresis).

Manual verification: Run the page; one mob renders as its GLB, plays idle when still and walk when moving, under the WebGPU renderer. If a `MeshStandardMaterial` warns or renders black, confirm the WebGPU backend's automatic node-material conversion is active (it is default in r184); do not hand-port to TSL unless a specific material fails.

- [ ] **Step 4: Replace the placeholder group with per-mob visuals**

Maintain a `Map<mobId, CharacterVisual>`: create on first sight (via `visualKeyFor` from the mob's `tid`), update transform + animation each frame from `mobs()`, and dispose + remove when a mob id disappears (call `visual.dispose()` — required per `characters/CLAUDE.md` to avoid stranding GPU bone textures). Remove the `ccDebugMesh` path.

- [ ] **Step 5: Manual verification**

Run the page; the roster renders as animated GLB creatures on the terrain, chasing/attacking the player.

- [ ] **Step 6: Commit**

```bash
git add claudecraft-render claudecraft-assets environment-viewer.html
git commit -m "feat(claudecraft): M5B skinned GLB mob visuals under r184 WebGPU"
```

#### Task 5.3: Wire full-combat readback for the local player

**Files:**
- Modify: `environment-viewer.html`

- [ ] **Step 1: Reflect sim HP/death on the workshop player each frame**

In the `claudecraft` profiled block, after `update`:

```javascript
const combat = claudecraftCreatures.localPlayerCombat();
applyClaudecraftCombatToPlayer(combat); // set workshop player HP bar; if combat.dead, trigger workshop death UX
```

Implement `applyClaudecraftCombatToPlayer` against the workshop's real player-HP/death handling. On respawn completion, call:

```javascript
claudecraftCreatures.reviveLocalPlayer(getLocalPlayerWorldPose());
```

- [ ] **Step 2: Manual verification**

Run the page; stand in a mob camp and take hits — the workshop HP bar drops; dying triggers the workshop respawn; after respawn the sim player is full HP and mobs disengage.

- [ ] **Step 3: Commit**

```bash
git add environment-viewer.html
git commit -m "feat(claudecraft): reflect sim combat (hp/death/revive) on the workshop player"
```

---

### Milestone M6: Multiplayer replication

#### Task 6.1: Extend the interpolation buffer and ghost renderer for mobs

**Files:**
- Modify: `multiplayer.js`
- Test: extend `multiplayer-test.mjs`

- [ ] **Step 1: Write the failing interpolation test**

Append to `multiplayer-test.mjs` (matching its `console.assert` style):

```javascript
{
  const buf = new InterpolationBuffer();
  buf.push({ mobs: [{ id: 1, p: [0, 0, 0], q: [0, 0, 0, 1], hp: 1 }] }, 1000);
  buf.push({ mobs: [{ id: 1, p: [10, 0, 0], q: [0, 0, 0, 1], hp: 0.5 }] }, 1100);
  const s = buf.sample(1050);
  console.assert(Math.abs(s.mobs[0].p[0] - 5) < 1e-6, 'mob x interpolates to 5');
  console.assert(Math.abs(s.mobs[0].hp - 0.75) < 1e-6, 'mob hp interpolates to 0.75');
  console.log('mob interpolation OK');
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `node multiplayer-test.mjs`
Expected: FAIL — `s.mobs` is undefined (the buffer does not yet lerp mobs).

- [ ] **Step 3: Implement mob lerp**

In `multiplayer.js`, find `_lerpState` (and its `_lerpEntities`/`_lerpV3`/`_slerpQ` helpers) and add a `_lerpMobs(a, b, t)` that matches mobs by `id` (like the player lerp matches by id): lerp `p`, slerp `q`, lerp `hp`, carry `tid`/`dead` from the newer snapshot; unmatched ids pass through from the nearer snapshot. Emit `mobs` from `_lerpState`.

- [ ] **Step 4: Run to verify it passes**

Run: `node multiplayer-test.mjs`
Expected: existing lines plus `mob interpolation OK`.

- [ ] **Step 5: Add mob rendering to `GhostRenderer`**

In `GhostRenderer.update(state)`, handle `state.mobs`: create/reuse one mesh per mob id (reuse the M5B `CharacterVisual` if available, else a box like the player capsule path), set position/quaternion from `p`/`q`, and remove meshes for ids no longer present. Follow the existing player-capsule pattern exactly (plain `[x,y,z]`/`[x,y,z,w]` arrays, positional destructure).

- [ ] **Step 6: Commit**

```bash
git add multiplayer.js multiplayer-test.mjs
git commit -m "feat(claudecraft): mp interpolation + ghost rendering for mobs"
```

#### Task 6.2: Publish mobs in the host snapshot; guests render, never simulate

**Files:**
- Modify: `environment-viewer.html`

- [ ] **Step 1: Add mobs to `getState()` (host/solo only)**

In the `getState()` builder (the one that already returns `{ creatures, players, entities }`), add:

```javascript
mobs: claudecraftCreatures.mobs(), // already world-space wire shape
```

Also feed remote guest players into the sim so mobs react to them: in the host's `mp:guest_input` `player_state` handler, call `claudecraftCreatures.addRemotePlayer(clientId)` on first sight and pass the guest pose into the next `update(...)` via `remotePlayersWorld`; on `guest_left`, `claudecraftCreatures.removeRemotePlayer(clientId)`.

- [ ] **Step 2: Guest path — do not construct the sim**

Guard the `createClaudecraftCreatures(...)` construction so it runs only for `mpRole === 'host' || mpRole === 'solo'`. For `mpRole === 'guest'`, the mobs arrive inside `sim_state.mobs` and are rendered by the `GhostRenderer` mob path from Task 6.1; the guest never imports/steps the sim.

- [ ] **Step 3: Manual verification (two tabs)**

Run: `python server-tool.py` (or `cd server && npm start`), open one tab as Host, one as Join with the room code.
Expected: the host sees live simulated mobs; the guest sees the same mobs at interpolated positions, smooth, and never runs sim code (confirm with `?netstats` that mob count rides in `sim_state`). The guest's player walking near a mob is chased on the host and that chase is visible on both tabs.

- [ ] **Step 4: Commit**

```bash
git add environment-viewer.html
git commit -m "feat(claudecraft): replicate mobs in host snapshot; guests render-only; remote players feed sim aggro"
```

---

### Milestone M7: Docs + log

#### Task 7.1: Update the subsystem doc and activity log

**Files:**
- Modify: `docs/subsystems/creature.md`
- Modify: `agent_log.csv`

- [ ] **Step 1: Document the second creature system**

Add a section to `docs/subsystems/creature.md` describing the ClaudeCraft sim system: the vendored `claudecraft-sim/` bundle, the `claudecraft-bridge/` seams (terrain height, collider, external players), the scale model, the render adapter, and how it coexists with the IK `port-creature-system.js` (independent; shared only via scene + multiplayer snapshot).

- [ ] **Step 2: Append to `agent_log.csv`**

One row per milestone landed, columns `date,subsystem,files,summary`, e.g.:

```
2026-07-05T00:00,creature,"claudecraft-sim;claudecraft-bridge;claudecraft-sim.bundle.js",Vendor ClaudeCraft mob sim as a bundled second creature system with injected terrain/collider/player seams
2026-07-05T00:00,multiplayer,"multiplayer.js;environment-viewer.html",Replicate ClaudeCraft mobs over the host snapshot; guests render-only
```

- [ ] **Step 3: Commit**

```bash
git add docs/subsystems/creature.md agent_log.csv
git commit -m "docs(claudecraft): document the second creature system + log"
```

---

## Self-Review Notes

- **Spec coverage:** terrain (both procedural + authored) -> Task 1.1/1.3 + M5A verify; collision -> M3; full combat -> Task 4.1 + 5.3; scale from player size -> Task 1.2 + used throughout; multiplayer share -> M6; coexistence -> unchanged IK system, M6 snapshot only.
- **Known confirmation points flagged inline** (not placeholders — real lookups the engineer must do against the vendored source): exact `WorldContent` optional fields (`types.ts`), whether entities carry `e.id` (`entity.ts`), the workshop's real symbols for player height / local player pose / player HP handling (`environment-viewer.html`). Each is a named grep target, not an invented API.
- **Type/name consistency:** `setHeightProvider`/`setWaterLevelProvider`/`setExternalColliderResolver`/`setPlayerPose`/`reviveExternalPlayer`/`serializeMobs`/`buildClaudecraftWorldContent`/`makeScale`/`createClaudecraftCreatures` are used identically across tasks. Wire shape `{ id, tid, p, q, hp, dead }` is consistent between Task 4.2 (serialize) and Task 6.1 (lerp/ghost).
