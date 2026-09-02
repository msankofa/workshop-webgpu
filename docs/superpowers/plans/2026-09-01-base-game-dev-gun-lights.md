# Base-Game Dev Gun (Bots + Lights) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand base-game's key-9 spawner into a "dev gun" with two tools — the existing bot spawner, and a light tool that carries a held lantern, drops lights at the crosshair, and shoots them out as glowing projectiles, with the light's kind chosen by presets and sliders.

**Architecture:** The light simulation reuses the pure, already-written entity layer from the environment-viewer migration — `entity-registry.js`, `entity-types/light.js`, `entity-types/projectile.js` — ticked locally inside base-game's frame loop (nothing is replicated; like the flashlight, the lights are yours alone). Base-game has no clustered lights, so a new `point-light-pool.js` module mirrors `light-entity-renderer.js`'s slot logic but binds serialized entities to a small fixed pool of resident `THREE.PointLight`s, intensity-driven per the WebGPU rule in `flash-lights.js` (never touch `.visible`). The held lantern is one more resident point light ramped like `weapon-light.js`'s lamp. All page glue (key handling, HUD, settings, panel section) follows the existing flashlight/spawner precedent inline in `base-game.html`.

**Tech Stack:** Three.js r0.184 WebGPU, plain ES modules, Node scripts for tests (no framework).

---

## Decisions locked in by this plan

- **Key 9 cycles** the dev gun: off → bots → lights → off. Bots mode is byte-for-byte today's spawner.
- **Lights tool controls:** hold left-click to charge, release to shoot (charge maps to launch speed, same 1.5 s window as environment-viewer); **E** drops a light at the crosshair aim point; **R** cycles the light kind preset.
- **Light kinds** are presets (`lantern`, `ember`, `floater`, `flare`) that write the `devLight*` settings; touching any slider flips the kind to `custom` (the `fpPreset` pattern).
- **Held lantern** is on whenever the lights tool is up (toggle `devLightHeld` in the panel to disable). It reads the live `devLight*` colour/brightness/radius each frame.
- **Purely local, purely presentational** in v1: no room replication, no audio, no charge-ring UI. The flashlight's panel note ("the beam is yours alone") applies verbatim.
- **Budget:** `DEV_LIGHT_SLOTS = 8` resident PointLights. With the moon, the 2 flash slots, the flashlight spot + spill, the laser and the lantern, the scene holds ~14 resident lights; every one costs shading math per fragment even at intensity 0, so the pool stays small and constant. Creation past the pool is rejected (reject-newest, `light-entity-renderer.js`'s rule) with a HUD note.
- **Coordinates:** entities simulate in **global** space (the same convention as `soloProjectiles`, `base-game.html:1866`); the pool converts to render-local per frame via `worldCoordinates.toRenderLocal`. Ground for falling lights is `terrain.groundHeight` in terrain mode and `-1e9` in map worlds (matching `base-game.html:1868`) — in map worlds, drop with `float` on or the light falls; acceptable for a dev tool.

## File structure

- **Create** `point-light-pool.js` — binder from serialized light entities to a fixed resident `THREE.PointLight` pool. The only new module.
- **Create** `test-point-light-pool.mjs` — Node test with a stub THREE.
- **Modify** `base-game.html` — settings block (~line 400), `SETTINGS_RANGES` (~line 567), imports (~line 162), spawner → devGun state (~line 1428), sim wiring near `soloProjectiles` (~line 1885), HUD (~line 2008), `changed()` (~line 2899), panel section (~line 3294), key/mouse handlers (~line 4326), frame loop fx block (~line 4777 and ~line 4999).
- **Modify** `docs/subsystems/base-game.md`, `docs/subsystems/lighting.md`, `agent_log.csv`.

---

### Task 1: `point-light-pool.js` with Node test

**Files:**
- Create: `point-light-pool.js`
- Test: `test-point-light-pool.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test-point-light-pool.mjs — slot logic of the resident point-light pool.
import assert from 'node:assert/strict';
import { createPointLightPool } from './point-light-pool.js';

class StubColor { setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; } }
class StubVec { set(x, y, z) { this.x = x; this.y = y; this.z = z; } }
class StubPointLight {
  constructor(color, intensity, distance, decay) {
    this.intensity = intensity; this.distance = distance; this.decay = decay;
    this.color = new StubColor(); this.position = new StubVec(); this.name = '';
  }
  dispose() { this.disposed = true; }
}
const THREE = { PointLight: StubPointLight };
const scene = { children: [], add(...o) { this.children.push(...o); }, remove(...o) { for (const x of o) this.children.splice(this.children.indexOf(x), 1); } };

const identity = (p, out) => { out[0] = p[0]; out[1] = p[1]; out[2] = p[2]; return out; };
const ent = (id, x, intensity = 10) => ({ id, p: [x, 2, 3], color: [1, 0.5, 0.25], radius: 30, intensity });

// Construction: `count` resident lights in the scene, all dark.
const pool = createPointLightPool({ THREE, scene, count: 2 });
assert.equal(scene.children.length, 2);
assert.ok(scene.children.every(l => l.intensity === 0));

// Sync writes position, colour, distance, intensity into a slot.
pool.sync([ent('a', 1)], identity);
const lit = scene.children.find(l => l.intensity === 10);
assert.ok(lit, 'one light lit');
assert.equal(lit.position.x, 1);
assert.equal(lit.color.r, 1);
assert.equal(lit.distance, 30);

// The same id keeps its slot across syncs.
pool.sync([ent('a', 5)], identity);
assert.equal(lit.position.x, 5);

// A vanished id releases its slot to intensity 0 (never removal).
pool.sync([], identity);
assert.equal(lit.intensity, 0);
assert.equal(scene.children.length, 2);

// Overflow rejects the newest: with 2 slots, a third entity gets nothing.
pool.sync([ent('a', 1), ent('b', 2), ent('c', 3)], identity);
assert.equal(scene.children.filter(l => l.intensity > 0).length, 2);
assert.ok(!scene.children.some(l => l.position.x === 3), 'c was rejected');

// Released slots are reused by later entities.
pool.sync([ent('b', 2)], identity);
pool.sync([ent('b', 2), ent('d', 4)], identity);
assert.ok(scene.children.some(l => l.position.x === 4), 'd took the freed slot');

// The transform is applied to every write.
pool.sync([ent('e', 10)], (p, out) => { out[0] = p[0] - 100; out[1] = p[1]; out[2] = p[2]; return out; });
assert.ok(scene.children.some(l => l.position.x === -90), 'toLocal ran');

// dispose removes and disposes the residents.
pool.dispose();
assert.equal(scene.children.length, 0);

console.log('test-point-light-pool: all assertions passed');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-point-light-pool.mjs`
Expected: FAIL — `Cannot find module ... point-light-pool.js`

- [ ] **Step 3: Write the implementation**

```js
// point-light-pool.js — a fixed pool of resident THREE.PointLights that serialized light
// entities (entity-types/light.js and projectile.js wire shape: { id, p, color, radius,
// intensity }) borrow by id. The THREE-light twin of light-entity-renderer.js's clustered
// slot pool, for pages without clustered lights — base-game.html first.
//
// The WebGPU rule from flash-lights.js holds: `.visible` feeds the lights hash that keys
// the render pipeline, so a light appearing or disappearing recompiles every material.
// Slots are resident from construction and idle at intensity 0.

export function createPointLightPool({ THREE, scene, count = 8, decay = 2 }) {
  const lights = [];
  for (let i = 0; i < count; i++) {
    const l = new THREE.PointLight(0xffffff, 0, 10, decay);
    l.name = `devLight${i}`;
    scene.add(l);
    lights.push(l);
  }
  const slotOf = new Map();   // entityId -> pool index
  const freeSlots = [];
  for (let i = count - 1; i >= 0; i--) freeSlots.push(i);
  const _local = [0, 0, 0];

  // entities: array of the wire shape above, positions in the caller's space.
  // toLocal(p, out): converts a [x,y,z] into the scene's space (worldCoordinates.toRenderLocal).
  function sync(entities, toLocal) {
    const seen = new Set();
    for (const entity of entities) {
      if (!entity || !entity.p) continue;
      seen.add(entity.id);
      let slot = slotOf.get(entity.id);
      if (slot === undefined) {
        if (freeSlots.length === 0) continue;   // pool exhausted: reject newest, never evict
        slot = freeSlots.pop();
        slotOf.set(entity.id, slot);
      }
      const l = lights[slot];
      const p = toLocal(entity.p, _local);
      l.position.set(p[0], p[1], p[2]);
      l.color.setRGB(entity.color[0], entity.color[1], entity.color[2]);
      l.distance = entity.radius;
      l.intensity = entity.intensity;
    }
    for (const [id, slot] of Array.from(slotOf.entries())) {
      if (seen.has(id)) continue;
      lights[slot].intensity = 0;
      slotOf.delete(id);
      freeSlots.push(slot);
    }
  }

  function dispose() {
    for (const l of lights) { scene.remove(l); l.dispose?.(); }
    lights.length = 0;
    slotOf.clear();
    freeSlots.length = 0;
  }

  return { sync, dispose, lights };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-point-light-pool.mjs`
Expected: `test-point-light-pool: all assertions passed`

- [ ] **Step 5: Commit**

```bash
git add point-light-pool.js test-point-light-pool.mjs
git commit -m "feat(lighting): point-light pool - the THREE-light twin of the clustered slot binder"
```

---

### Task 2: Dev-gun state, key 9 cycling, mouse charge, E drop, HUD

**Files:**
- Modify: `base-game.html:1428-1446` (spawner block), `base-game.html:2008` (HUD markup), `base-game.html:3326` (npcHelp text), `base-game.html:4326-4330` (R and 9 keys), `base-game.html:4339` area (E key), `base-game.html:4367-4375` (mouse), `base-game.html:4775-4778` (input gate + edge consumption)

No pure logic worth a Node test here — this is page wiring; verification is Step 6 in the browser.

- [ ] **Step 1: Replace the spawner state block (base-game.html:1428-1446)**

Replace the `spawner` const, `cycleSpawner`, `spawnerPlace`, `spawnerHudLine` with:

```js
// The dev gun (key 9): a tool mode over the held sidearm, not a weapon of its own. 9 cycles
// off -> bots -> lights -> off. Bots: click asks the room to put a bot where you aim, R cycles
// side and role (the old spawner, unchanged). Lights: hold click to charge and release to shoot
// a light out, E drops one at the crosshair, R cycles the kind preset. Lights are purely local,
// like the flashlight.
const DEV_LIGHT_CHARGE_MS = 1500;   // environment-viewer's LG_MAX_CHARGE_MS
const devGun = {
  active: false, tool: 'bots',
  side: 'enemy', roleIndex: 0, clickEdge: false,          // bots tool
  chargeStartMs: null, fireRatio: null, dropEdge: false,  // lights tool
  note: '', noteUntil: 0,
};
const SPAWNER_SIDES = ['enemy', 'friendly'];
function devGunNote(text) { devGun.note = text; devGun.noteUntil = performance.now() + 1500; }
function cycleSpawner() {
  const next = devGun.roleIndex + 1;
  if (next >= BASE_GAME_NPC_ROLE_IDS.length) { devGun.roleIndex = 0; devGun.side = SPAWNER_SIDES[(SPAWNER_SIDES.indexOf(devGun.side) + 1) % SPAWNER_SIDES.length]; }
  else devGun.roleIndex = next;
}
function spawnerPlace() {
  const ok = sendNpc({ action: 'spawn', team: BASE_GAME_TEAMS[devGun.side], count: 1, role: BASE_GAME_NPC_ROLE_IDS[devGun.roleIndex], aimed: true });
  devGunNote(ok ? `placed ${devGun.side} ${BASE_GAME_NPC_ROLE_IDS[devGun.roleIndex]}` : (npcNote.textContent || 'not placed'));
}
function devGunHudLine() {
  if (!devGun.active) return '';
  const note = devGun.noteUntil > performance.now() ? ` — ${devGun.note}` : '';
  if (devGun.tool === 'bots') {
    return `<br>[9] dev gun: bots — ${devGun.side} ${BASE_GAME_NPC_ROLE_IDS[devGun.roleIndex]}${note}<br><span class="dim">click places, R cycles, 9 again for lights</span>`;
  }
  return `<br>[9] dev gun: lights — ${settings.devLightKind}${note}<br><span class="dim">hold click charges a shot, E drops, R cycles the kind</span>`;
}
```

`devLightCycleKind()`, referenced by the R key below, arrives in Task 3 — wire the key in this
task and it simply won't fire until the lights tool exists (or do Tasks 2 and 3 in one working
tree state before testing; the browser check in Step 6 only exercises the bots path).

- [ ] **Step 2: Update every other `spawner.` reference**

There are exactly four places left; change them in place:

`base-game.html:2008` — HUD markup, rename the call:
```js
const markup = `${hit}${hp}<br>${gun}${throwable}${posture}${torch}${visor}${droneHudLine()}${devGunHudLine()}${killed}${slots}`;
```

`base-game.html:4326` — R key:
```js
if (event.code === 'KeyR' && !event.repeat) {
  if (devGun.active && devGun.tool === 'bots') cycleSpawner();
  else if (devGun.active && devGun.tool === 'lights') devLightCycleKind();
  else weaponState.reloadEdge = true;
}
```

`base-game.html:4327-4330` — 9 key cycles the tool:
```js
if (event.code === 'Digit9' && !event.repeat) {
  if (!devGun.active) { devGun.active = true; devGun.tool = 'bots'; }
  else if (devGun.tool === 'bots') { devGun.tool = 'lights'; }
  else { devGun.active = false; devGun.chargeStartMs = null; devGun.fireRatio = null; }
  if (devGun.active && weaponState.slot !== 1) selectSlot(1);   // the sidearm carries the laser
}
```

`base-game.html:4775-4778` — the input gate and edge consumption:
```js
fire: weaponState.firing && !devGun.active,
```
```js
if (!canControl) { weaponState.reloadEdge = false; weaponState.throwEdge = false; devGun.clickEdge = false; devGun.chargeStartMs = null; devGun.fireRatio = null; devGun.dropEdge = false; }
if (devGun.clickEdge) { devGun.clickEdge = false; spawnerPlace(); }
if (devGun.fireRatio !== null) { const r = devGun.fireRatio; devGun.fireRatio = null; devLightFire(r); }
if (devGun.dropEdge) { devGun.dropEdge = false; devLightDrop(); }
```
(`devLightFire`/`devLightDrop` are written in Task 4; as with Step 1, the lights branch is dead
until then.)

- [ ] **Step 3: Add the E key (next to the G/F/B/N block, base-game.html:4339)**

```js
if (event.code === 'KeyE' && !event.repeat && devGun.active && devGun.tool === 'lights') devGun.dropEdge = true;
```

- [ ] **Step 4: Mouse press-and-release charge (base-game.html:4367-4375)**

```js
renderer.domElement.addEventListener('mousedown', (event) => {
  if (event.button === 2) weaponState.aiming = true;
  if (event.button === 0 && document.pointerLockElement === renderer.domElement) {
    if (devGun.active && devGun.tool === 'lights') devGun.chargeStartMs = performance.now();
    else if (devGun.active) devGun.clickEdge = true;
    else weaponState.firing = true;
  }
});
addEventListener('mouseup', (event) => {
  if (event.button === 2) weaponState.aiming = false;
  if (event.button === 0) {
    weaponState.firing = false;
    if (devGun.chargeStartMs !== null) {
      devGun.fireRatio = Math.min(1, (performance.now() - devGun.chargeStartMs) / DEV_LIGHT_CHARGE_MS);
      devGun.chargeStartMs = null;
    }
  }
});
document.addEventListener('pointerlockchange', () => {
  pointerLook.clear();
  if (document.pointerLockElement !== renderer.domElement) { weaponState.firing = false; devGun.chargeStartMs = null; }
});
```

- [ ] **Step 5: Update the npcHelp note (base-game.html:3326)**

```js
npcHelp.textContent = 'Friendlies spawn beside you and never aim at players; enemies spawn ahead of you at the spawn distance. Key 9 holds the dev gun: first press is the bot spawner (click places a bot where you aim, R cycles the side and role), second press is the light tool, third puts it away.';
```

- [ ] **Step 6: Verify the bots path in the browser**

Run: `python serve.py` and open `http://127.0.0.1:8080/base-game.html`, create a solo-relay room from the start menu, press 9.
Expected: HUD reads `[9] dev gun: bots — enemy …`, click places a bot, R cycles, 9 again reads `dev gun: lights — lantern` (kind label appears once Task 3 lands; before that it reads `undefined`, which is fine mid-plan), third 9 clears the line. Reload and fire still work with the gun away.

- [ ] **Step 7: Commit**

```bash
git add base-game.html
git commit -m "feat(base-game): the spawner grows into the dev gun - 9 cycles bots, lights, away"
```

---

### Task 3: Light settings, kind presets, panel section

**Files:**
- Modify: `base-game.html:400` (settings defaults, after `flashlightShadows`), `base-game.html:567-568` (SETTINGS_RANGES), `base-game.html:2899-2903` (changed()), `base-game.html:3294` (panel, after the laser note)

- [ ] **Step 1: Add settings defaults (after `flashlightShadows: false`, base-game.html:400)**

```js
  // Dev gun lights (key 9, second press). Purely local, like the flashlight. The kind is a
  // preset that writes the sliders; touching a slider flips it to custom (the fpPreset rule).
  devLightKind: 'lantern',
  devLightLifespan: 30, devLightR: 255, devLightG: 180, devLightB: 80,
  devLightBrightness: 60, devLightRadius: 25,
  devLightFloat: false, devLightDrift: false, devLightArc: true,
  devLightHeld: true,
```

- [ ] **Step 2: Add ranges (next to the flashlight ranges, base-game.html:567)**

```js
  devLightLifespan: [1, 120], devLightR: [0, 255], devLightG: [0, 255], devLightB: [0, 255],
  devLightBrightness: [0, 500], devLightRadius: [1, 100],
```

- [ ] **Step 3: Add the presets and cycle function (next to `applyFlashlight`, base-game.html:1559)**

```js
// Dev-gun light kinds: each preset writes the devLight sliders wholesale, so the sliders always
// show what the next light will be. Order matters — R walks it.
const DEV_LIGHT_KINDS = Object.freeze({
  lantern: { devLightLifespan: 30, devLightR: 255, devLightG: 180, devLightB: 80,  devLightBrightness: 60,  devLightRadius: 25, devLightFloat: false, devLightDrift: false, devLightArc: true },
  ember:   { devLightLifespan: 20, devLightR: 255, devLightG: 90,  devLightB: 30,  devLightBrightness: 30,  devLightRadius: 12, devLightFloat: false, devLightDrift: false, devLightArc: true },
  floater: { devLightLifespan: 25, devLightR: 150, devLightG: 200, devLightB: 255, devLightBrightness: 60,  devLightRadius: 30, devLightFloat: true,  devLightDrift: true,  devLightArc: true },
  flare:   { devLightLifespan: 8,  devLightR: 255, devLightG: 40,  devLightB: 40,  devLightBrightness: 140, devLightRadius: 45, devLightFloat: false, devLightDrift: false, devLightArc: false },
});
const DEV_LIGHT_KIND_ORDER = Object.keys(DEV_LIGHT_KINDS);
function applyDevLightKind() {
  const preset = DEV_LIGHT_KINDS[settings.devLightKind];
  if (preset) Object.assign(settings, preset);
}
function devLightCycleKind() {
  const at = DEV_LIGHT_KIND_ORDER.indexOf(settings.devLightKind);
  settings.devLightKind = DEV_LIGHT_KIND_ORDER[(at + 1) % DEV_LIGHT_KIND_ORDER.length];   // custom -> lantern
  applyDevLightKind();
  syncAllControls();
  scheduleAutosaveSafe();
}
```

- [ ] **Step 4: Add the `changed()` branch (next to the flashlight branch, base-game.html:2901)**

```js
  } else if (key === 'devLightKind') {
    applyDevLightKind();
    syncAllControls();
  } else if (key?.startsWith('devLight')) {
    // A touched slider is no longer any preset. The values themselves are read live each frame.
    if (settings.devLightKind !== 'custom') { settings.devLightKind = 'custom'; syncAllControls(); }
```

- [ ] **Step 5: Add the panel section (after the laser note append, base-game.html:3294)**

Check how `addSelect` (or the select-building pattern at `base-game.html:3307-3311`) works before
writing the kind dropdown; if there is no `addSelect` helper, build the row the way `npcRoleRow`
does but through `controlRegistry` — the simplest faithful route is a range-free select wired to
`settings.devLightKind` + `changed('devLightKind')`:

```js
// Dev gun lights: what the 9-key light tool makes. Kinds are presets over the sliders.
const devLightSec = createSection(playerSec, 'Dev gun lights (9)', { collapsed: true });
const devKindRow = document.createElement('div'); devKindRow.className = 'row';
const devKindLabel = document.createElement('label'); devKindLabel.textContent = 'Kind (R cycles)';
const devKindSelect = document.createElement('select');
for (const kind of [...DEV_LIGHT_KIND_ORDER, 'custom']) { const o = document.createElement('option'); o.value = kind; o.textContent = kind; devKindSelect.append(o); }
devKindSelect.addEventListener('change', () => { settings.devLightKind = devKindSelect.value; changed('devLightKind'); scheduleAutosaveSafe(); });
controlRegistry.set('devLightKind', { sync: () => { devKindSelect.value = settings.devLightKind; } });
devKindRow.append(devKindLabel, devKindSelect); devLightSec.append(devKindRow);
addToggle(devLightSec, 'devLightHeld', 'Held lantern while the tool is up');
addRange(devLightSec, 'devLightLifespan', 'Lifespan', 1, 120, 1, value => `${value.toFixed(0)} s`);
addRange(devLightSec, 'devLightR', 'Red', 0, 255, 1, value => value.toFixed(0));
addRange(devLightSec, 'devLightG', 'Green', 0, 255, 1, value => value.toFixed(0));
addRange(devLightSec, 'devLightB', 'Blue', 0, 255, 1, value => value.toFixed(0));
addRange(devLightSec, 'devLightBrightness', 'Brightness', 0, 500, 1, value => value.toFixed(0));
addRange(devLightSec, 'devLightRadius', 'Reach', 1, 100, 1, value => `${value.toFixed(0)} m`);
addToggle(devLightSec, 'devLightFloat', 'Float in the air');
addToggle(devLightSec, 'devLightDrift', 'Drift while floating');
addToggle(devLightSec, 'devLightArc', 'Shots arc under gravity');
const devLightNote = document.createElement('div'); devLightNote.className = 'note';
devLightNote.textContent = 'Press 9 twice for the light tool: hold click to charge a shot, E drops a light at the crosshair, R cycles the kind. Eight lights can burn at once; the ninth is refused until one expires. Like the flashlight, they are yours alone: other players do not see them.';
devLightSec.append(devLightNote);
```

**Before running:** confirm `controlRegistry.set` is how selects register (the
`treeVariantsPerSpecies` sync at `base-game.html:2894` proves `controlRegistry.get(key)?.sync()`
exists; grep `controlRegistry.set` for the write side and copy its actual shape).

- [ ] **Step 6: Verify in the browser**

Run: `python serve.py`, open base-game, expand Player → Dev gun lights.
Expected: the section shows kind `lantern` and the preset numbers; picking `flare` rewrites the sliders; nudging Red flips kind to `custom`; values survive a reload (they ride the settings autosave).

- [ ] **Step 7: Commit**

```bash
git add base-game.html
git commit -m "feat(base-game): dev-gun light settings - kinds as presets over the sliders"
```

---

### Task 4: Entity sim wiring — registry, shoot, drop, per-frame tick

**Files:**
- Modify: `base-game.html:162` (imports), `base-game.html:1885` (after `soloProjectiles`), `base-game.html:4777` (edge consumption — already written in Task 2), `base-game.html:4999` (fx frame block)

- [ ] **Step 1: Add imports (next to the flash-lights import, base-game.html:161)**

```js
import { createEntityRegistry } from './entity-registry.js';
import { LightEntity } from './entity-types/light.js';
import { ProjectileEntity } from './entity-types/projectile.js';
import { createPointLightPool } from './point-light-pool.js';
```

- [ ] **Step 2: Registry, pool, and the fire/drop intents (after `soloProjectiles`, base-game.html:1885)**

```js
// Dev-gun lights: the environment-viewer entity layer, run purely locally. Entities simulate in
// GLOBAL space (soloProjectiles' convention); the pool converts to render-local at draw time.
// Nothing here is replicated — a dropped light is yours alone, like the flashlight beam.
const DEV_LIGHT_SLOTS = 8;
const devLightRegistry = createEntityRegistry();
devLightRegistry.registerType(LightEntity);
devLightRegistry.registerType(ProjectileEntity);
const devLightPool = createPointLightPool({ THREE, scene, count: DEV_LIGHT_SLOTS });
const devLightGround = (x, z) => (settings.worldMode === 'terrain' ? terrain.groundHeight(x, z) : -1e9);
const _devLightLocal = [0, 0, 0];
const devLightToLocal = (p, out) => worldCoordinates.toRenderLocal(p, out);
function devLightParams() {
  return {
    trajectory: settings.devLightArc ? 'arc' : 'straight',
    float: settings.devLightFloat, drift: settings.devLightDrift,
    lifespan: settings.devLightLifespan,
    r: settings.devLightR, g: settings.devLightG, b: settings.devLightB,
    brightness: settings.devLightBrightness, radius: settings.devLightRadius,
  };
}
function devLightRoom() {
  if (devLightRegistry.list().length < DEV_LIGHT_SLOTS) return true;
  devGunNote('light pool is full');
  return false;
}
function devLightFire(chargeRatio) {
  if (!devLightRoom()) return;
  const src = weaponLightSource(true);
  const origin = worldCoordinates.toGlobal([src.muzzle[0], src.muzzle[1], src.muzzle[2]]);
  devLightRegistry.create('projectile', {
    origin, dir: [src.direction[0], src.direction[1], src.direction[2]], chargeRatio,
    payload: { type: 'light', params: devLightParams() }, ownerId: 'local',
  }, { now: performance.now() / 1000 });
  devGunNote(`shot ${settings.devLightKind}`);
}
function devLightDrop() {
  if (!devLightRoom()) return;
  // aimPointLocal is refreshed every frame by updateLocalAimPoint; it is the crosshair's landing point.
  const p = worldCoordinates.toGlobal([aimPointLocal.x, aimPointLocal.y, aimPointLocal.z]);
  const params = devLightParams();
  devLightRegistry.create('light', {
    x: p[0], y: p[1] + (params.float ? 1.5 : 0.2), z: p[2], params, ownerId: 'local',
  }, { now: performance.now() / 1000 });
  devGunNote(`dropped ${settings.devLightKind}`);
}
```

**Before running:** confirm `aimPointLocal` is in scope at this line (it is declared near the aim
scratch vectors; if it lives later in the file, move this block after it or hoist nothing —
function bodies only run at frame time, when everything exists, so only the top-level
`const` lines above need their dependencies (`THREE`, `scene`, `terrain`, `settings`,
`worldCoordinates`) already defined, and all of them are by line 1885).

- [ ] **Step 3: Tick and sync in the fx frame block (base-game.html:4999)**

Inside the existing `frameProfiler.time('fx', () => { ... })` callback, after `flashLights.update(dt);`, add:

```js
devLightRegistry.tick(dt, { now: performance.now() / 1000, terrainHeight: devLightGround });
devLightPool.sync(devLightRegistry.renderList(), devLightToLocal);
```

(`renderList()` with no filter serializes both lights and in-flight projectiles; both carry `p`,
which is all the pool asks for. `tick` may destroy or spawn mid-iteration — the registry handles
that, see `entity-registry.js:110-133`.)

- [ ] **Step 4: Verify in the browser**

Run: `python serve.py`, open base-game solo (terrain world), press 9 twice for the lights tool.
Expected:
- Tap click: a warm dot of light lobs out a short distance, lands, glows on the ground, fades out after ~30 s.
- Hold click a second, release: it flies much farther.
- E: a light appears where the crosshair rests.
- R: HUD kind label walks lantern → ember → floater → flare; a fired `floater` hangs and wanders; `flare` flies flat (no arc) and burns bright red.
- Nine quick drops: the ninth shows `light pool is full` in the HUD line.
- Walk far away and back: lights sit where they were dropped (global-space check).

- [ ] **Step 5: Commit**

```bash
git add base-game.html
git commit -m "feat(base-game): the light tool shoots and drops real lights through the entity layer"
```

---

### Task 5: The held lantern

**Files:**
- Modify: `base-game.html:1560` area (next to the weaponLight wiring), `base-game.html:4999` (fx block)

- [ ] **Step 1: Add the resident lantern light (after the `weaponLight` const, base-game.html:1560)**

```js
// The held lantern: while the dev gun's light tool is up, the muzzle carries the light you are
// about to make, so you can judge its colour and reach before committing one to the pool. One
// resident PointLight, intensity-ramped like the flashlight (the WebGPU visibility rule).
const devHeldLight = new THREE.PointLight(0xffffff, 0, 30, 2);
devHeldLight.name = 'devGunHeldLight';
scene.add(devHeldLight);
let devHeldLevel = 0;
function updateDevHeldLight(dt, gunLight) {
  const want = devGun.active && devGun.tool === 'lights' && settings.devLightHeld === true ? 1 : 0;
  devHeldLevel = rampToward(devHeldLevel, want, dt, WEAPON_LIGHT_DEFAULTS.rampRate);
  if (gunLight?.muzzle) devHeldLight.position.set(gunLight.muzzle[0], gunLight.muzzle[1], gunLight.muzzle[2]);
  devHeldLight.color.setRGB(settings.devLightR / 255, settings.devLightG / 255, settings.devLightB / 255);
  devHeldLight.distance = settings.devLightRadius;
  devHeldLight.intensity = settings.devLightBrightness * devHeldLevel;
}
```

- [ ] **Step 2: Import `rampToward` (base-game.html:162)**

Change the weapon-light import to:

```js
import { createWeaponLight, WEAPON_LIGHT_DEFAULTS, rampToward } from './weapon-light.js';
```

- [ ] **Step 3: Call it in the fx block (base-game.html:4999)**

The block already computes `const gunLight = weaponLightSource(canControl);` — after
`weaponLaser.update(dt, gunLight);` add:

```js
updateDevHeldLight(dt, gunLight);
```

- [ ] **Step 4: Verify in the browser**

Expected: switching to the lights tool fades a glow up around the gun that follows the muzzle and matches the slider colour live; cycling kinds with R visibly recolours it; switching tools or pressing 9 a third time fades it out (no pop, no material recompile hitch); the `devLightHeld` toggle kills it.

- [ ] **Step 5: Commit**

```bash
git add base-game.html
git commit -m "feat(base-game): the held lantern - the light you are about to make, riding the muzzle"
```

---

### Task 6: Docs and the activity log

**Files:**
- Modify: `docs/subsystems/base-game.md`, `docs/subsystems/lighting.md`, `agent_log.csv`, `CLAUDE.md` (lighting row)

- [ ] **Step 1: Update `docs/subsystems/base-game.md`**

Find the section describing the spawner / key bindings (grep `spawner` and `Digit9` in the doc) and rewrite it to describe the dev gun: 9 cycles off → bots → lights → off; bots unchanged; lights tool controls (hold-click charge, E drop, R kind), the `devLight*` settings block, the 8-slot pool, the purely-local rule, and the reuse of `entity-registry.js` + `entity-types/` with `point-light-pool.js` as the binder. Keep the doc's existing voice and structure; fix the key-list table if it has one (E is new).

- [ ] **Step 2: Update `docs/subsystems/lighting.md`**

Add `point-light-pool.js` to the key files and a short paragraph: what it is (fixed resident THREE.PointLight pool bound to serialized light entities by id, reject-newest), why it exists (base-game has no clustered lights), and its relationship to `light-entity-renderer.js` (same slot logic, different sink — keep the two in mind together when the wire shape changes). Add the same file to the Lighting row in `CLAUDE.md`'s subsystem table.

- [ ] **Step 3: Append to `agent_log.csv`** (one row, append-only)

```csv
2026-09-01T00:00,multi,"base-game.html;point-light-pool.js;test-point-light-pool.mjs;docs/subsystems/base-game.md;docs/subsystems/lighting.md",Spawner grew into the 9-key dev gun: bots tool unchanged plus a light tool (held lantern, crosshair drop, charged shot) run through the entity registry into a new resident point-light pool.
```

(Fill the real timestamp at commit time.)

- [ ] **Step 4: Run the repo's doc/test suite spot checks**

Run: `node test-point-light-pool.mjs` — expected: passes.
Run: `node test-weapon-mount.mjs` — expected: still passes (import surface of weapon-light.js grew but nothing changed).

- [ ] **Step 5: Commit**

```bash
git add docs/subsystems/base-game.md docs/subsystems/lighting.md agent_log.csv CLAUDE.md
git commit -m "docs(base-game,lighting): the dev gun and the point-light pool"
```

---

## Self-review notes

- **Names used across tasks:** `devGun` (state), `devGunNote`, `devGunHudLine`, `cycleSpawner`, `spawnerPlace` (kept — bots tool), `devLightCycleKind`, `applyDevLightKind`, `DEV_LIGHT_KINDS`, `DEV_LIGHT_KIND_ORDER`, `devLightParams`, `devLightFire`, `devLightDrop`, `devLightRoom`, `devLightRegistry`, `devLightPool`, `devLightGround`, `devLightToLocal`, `DEV_LIGHT_SLOTS`, `DEV_LIGHT_CHARGE_MS`, `devHeldLight`, `updateDevHeldLight`, `createPointLightPool`. Task 2 references `devLightCycleKind` (Task 3) and `devLightFire`/`devLightDrop` (Task 4); both are noted as dead branches until those tasks land — execute Tasks 2–4 before a full browser pass of the lights tool.
- **Two verify-before-writing checks are embedded** (the `controlRegistry.set` shape in Task 3 Step 5, and `aimPointLocal` scope in Task 4 Step 2) because those exact shapes weren't confirmed during planning — the executor must read the neighbouring code first, per the repo's "look at how the other pages already do it" rule.
- **Known v1 limits (deliberate):** no replication, no audio, no charge ring, `_devLightLocal` is declared but the pool allocates its own scratch (drop the unused const if the linter minds), map-world ground is `-1e9` so non-floating lights fall out of map worlds.
