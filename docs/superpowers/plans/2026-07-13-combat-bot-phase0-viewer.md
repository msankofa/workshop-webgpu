# Combat Bot Phase 0: `bot-viewer.html` harness — Implementation Plan

> **For agentic workers:** Execute inline (`superpowers:executing-plans` style — direct Edit/
> Write/Bash in the main session). Do not use `superpowers:subagent-driven-development` for this
> plan; per-task implementer/reviewer subagents aren't warranted for a plan this fully specified.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `bot-viewer.html`, a standalone harness for building combat bots outside the
game, plus the one production module Phase 0 needs: `bot-entity.js` (capsule state + physics
step + wire-pose conversion). Ship a stub bot — spawns, falls under gravity, collides with a
hand-built test room, no FSM/movement-input/combat yet. This proves the module boundary (the
harness imports the *same* files the game will later import) before any bot decision logic
exists.

**Architecture:** Same shape as `plant-viewer.html`/`tree-viewer.html`: its own minimal
`WebGPURenderer`/`OrbitControls`/`lights.js` scene shell, not wired into
`environment-viewer.html`, floating-panel UI duplicated inline (not extracted into a shared
library, matching those tools' precedent). Unlike those tools, it also imports `map-collision.js`
(for `createMapCollider`) and the new `bot-entity.js`, because bots need real capsule collision
against room geometry, not just a rendered mesh.

**Tech stack:** Three.js r0.184 (WebGPU backend, ES modules via CDN import map, same pins as the
other `*-viewer.html` tools), vanilla DOM, Python's `http.server` (`serve.py`).

**Spec:** `docs/superpowers/specs/2026-07-13-combat-bot-fsm-design.md` ("Dev/test harness:
`bot-viewer.html`" and "Phase 0" under Phasing).

**Out of scope for this plan** (later phases per the spec): `bot-activity.js` (FSM), `nav-grid.js`,
the dummy keyboard-controlled player capsule (needed once bots detect/aim at a target, not
before), any wiring into `environment-viewer.html`'s `getState()`/`botPlayers`/combat pipeline.

---

## Task 1: `bot-entity.js` — capsule state, physics step, wire-pose conversion

**Files:**
- Create: `bot-entity.js`

- [ ] **Step 1: Write the file**

```js
// bot-entity.js — capsule state + physics for FSM-driven combat bots. Browser/THREE only:
// stepBotPhysics needs a mapCollider built from real mesh geometry (three-mesh-bvh), so unlike
// bot-activity.js (Phase 1) this isn't Node-testable the same way creature-activity.js is.
import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';

const DEFAULT_RADIUS = 0.3;
const DEFAULT_STAND_HEIGHT = 1.7;
const GRAVITY = 30;

// spawnPos is the ground-contact point {x, y, z} (y = floor height under the spawn, not the
// capsule center) -- same convention environment-viewer.html uses for playerCollider (:4780).
export function createBotEntity(id, spawnPos, opts = {}) {
  const radius = opts.radius ?? DEFAULT_RADIUS;
  const standHeight = opts.standHeight ?? DEFAULT_STAND_HEIGHT;
  const start = new THREE.Vector3(spawnPos.x, spawnPos.y + radius, spawnPos.z);
  const end = new THREE.Vector3(spawnPos.x, spawnPos.y + standHeight - radius, spawnPos.z);
  return {
    id,
    capsule: new Capsule(start, end, radius),
    velocity: new THREE.Vector3(),
    onFloor: false,
    yaw: 0,
    pitch: 0,
    weapon: null,
    tool: null,
  };
}

const _delta = new THREE.Vector3();

// Gravity + map collision only -- no movement input here, Phase 1/2 set bot.velocity.x/z from
// FSM output before calling this each frame. Mirrors updateFPSPlayer's body
// (environment-viewer.html:6850) minus every camera/fpsKeys/stance reference, none of which
// exist for a bot.
export function stepBotPhysics(bot, dt, { mapCollider, slopeLimitY = 0.5 } = {}) {
  if (!bot.onFloor) bot.velocity.y -= GRAVITY * dt;
  bot.capsule.translate(_delta.copy(bot.velocity).multiplyScalar(dt));
  if (mapCollider) {
    const contact = mapCollider.resolveCapsule(bot.capsule, bot.velocity, { slopeLimitY });
    bot.onFloor = contact.grounded;
  }
}

// Same field shape getLocalPlayerState returns (environment-viewer.html:432) so a bot can be
// pushed into the game's players list unchanged once wired in (spec's "Bot state shape").
export function toWirePose(bot) {
  const halfYaw = bot.yaw * 0.5;
  const height = Math.max(0.1, bot.capsule.end.y - bot.capsule.start.y);
  const mid = bot.capsule.start.clone().add(bot.capsule.end).multiplyScalar(0.5);
  return {
    id: bot.id,
    p: [mid.x, mid.y, mid.z],
    q: [0, Math.sin(halfYaw), 0, Math.cos(halfYaw)],
    h: height,
    r: bot.capsule.radius,
    weapon: bot.weapon,
    tool: bot.tool,
    aimPitch: bot.pitch,
  };
}
```

- [ ] **Step 2: Syntax-check**

```bash
node --check bot-entity.js
```

Expected: exits 0, no output. (This only checks syntax — `import` targets from the `three`
bare specifier aren't resolved by `--check`, same caveat as the other viewer plans.)

- [ ] **Step 3: Leave in working tree (no commit unless asked)**

Move to Task 2.

---

## Task 2: `bot-viewer.html` — scene shell + test room + map collider

**Files:**
- Create: `bot-viewer.html`

- [ ] **Step 1: Write the file**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bot Viewer</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #14171c; }
  #info { position: fixed; top: 10px; left: 12px; color: #8a93a3;
    font: 12px/1.5 system-ui, sans-serif; user-select: none; pointer-events: none;
    max-width: calc(100vw - 280px); z-index: 5; }
</style>
</head>
<body>
<div id="info">drag&nbsp;orbit &middot; scroll&nbsp;zoom &mdash; standalone combat-bot tuning tool</div>

<!-- three@0.184.0: same CDN pins as environment-viewer.html/plant-viewer.html -->
<script type="importmap">
{ "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.webgpu.js",
    "three/webgpu": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.webgpu.js",
    "three/tsl": "https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.tsl.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/"
} }
</script>

<script type="module">
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createLightingRig } from './lights.js';
import { createMapCollider } from './map-collision.js';

const infoEl = document.getElementById('info');
function showError(msg) { if (infoEl) { infoEl.innerHTML = '⚠ ' + msg; infoEl.style.color = '#ffb3b3'; } }
addEventListener('error', e => showError(e.message || 'script error'));
addEventListener('unhandledrejection', e => showError((e.reason && e.reason.message) || String(e.reason)));

// ===================== renderer / scene / camera =====================
const renderer = new WebGPURenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);
await renderer.init();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14171c);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(8, 9, 8);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(3, 1, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.update();

// ===================== lighting =====================
const rig = createLightingRig({ scene, ui: false, elevation: 60, azimuth: 20 });
rig.dirLight.castShadow = true;
scene.add(rig.dirLight.target);
rig.dirLight.shadow.mapSize.set(2048, 2048);
rig.dirLight.shadow.camera.near = 0.1; rig.dirLight.shadow.camera.far = 40;
rig.dirLight.shadow.camera.left = -12; rig.dirLight.shadow.camera.right = 12;
rig.dirLight.shadow.camera.top = 12; rig.dirLight.shadow.camera.bottom = -12;

// ===================== test room =====================
// One hand-built L-shaped room: two boxes wide enough to walk through, joined at a corner, so
// collision/pathing work (Phase 0 collision now, Phase 2 nav-grid pathing later) has an actual
// corner to be tested against instead of an open box.
const mapRoot = new THREE.Group();
scene.add(mapRoot);

const wallMat = new THREE.MeshStandardMaterial({ color: 0x3d4450, roughness: 0.9 });
const floorMat = new THREE.MeshStandardMaterial({ color: 0x2a2f37, roughness: 1 });

function box(mat, x, y, z, w, h, d) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true;
  mapRoot.add(m);
  return m;
}

const WALL_H = 3, WALL_T = 0.3;
// Room A: 6x6 around origin. Room B: 6x6 offset +x, +z, sharing a corner with A so the
// connecting doorway forces an actual turn, not a straight corridor.
box(floorMat, 3, -0.05, 0, 12, 0.1, 12);
// Room A walls, with a 2m doorway gap on the +x wall
box(wallMat, 0, WALL_H / 2, -3, 6 + WALL_T, WALL_H, WALL_T);        // north
box(wallMat, 0, WALL_H / 2, 3, 6 + WALL_T, WALL_H, WALL_T);         // south
box(wallMat, -3, WALL_H / 2, 0, WALL_T, WALL_H, 6 + WALL_T);        // west
box(wallMat, 3, WALL_H / 2, -1.75, WALL_T, WALL_H, 2.5);            // east, north segment (gap 0.5..3.25 approx)
box(wallMat, 3, WALL_H / 2, 2.375, WALL_T, WALL_H, 1.25);           // east, south segment
// Room B walls (offset corner room), doorway aligned with Room A's gap
box(wallMat, 6, WALL_H / 2, -3, 6 + WALL_T, WALL_H, WALL_T);        // north
box(wallMat, 6, WALL_H / 2, 3, 6 + WALL_T, WALL_H, WALL_T);         // south
box(wallMat, 9, WALL_H / 2, 0, WALL_T, WALL_H, 6 + WALL_T);         // east

const mapCollider = createMapCollider(mapRoot);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
});
</script>
</body>
</html>
```

- [ ] **Step 2: Syntax-check the inline script**

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('bot-viewer.html','utf8').match(/<script type=\"module\">([\s\S]*?)<\/script>/)[1];fs.writeFileSync('bot-viewer.check.mjs', s)"
node --check bot-viewer.check.mjs
rm bot-viewer.check.mjs
```

Expected: exits 0, no output.

- [ ] **Step 3: Manual visual smoke test**

Run `python serve.py 8080` (or a fresh port if the main viewer is already using 8080), open
`http://127.0.0.1:8080/bot-viewer.html`. Expected: a dark scene with an L-shaped two-room floor
and walls, correctly shadowed, orbit/zoom working, no error banner. If this environment has no
real WebGPU adapter available (headless/CI), state that explicitly instead of claiming the
render was verified.

- [ ] **Step 4: Leave in working tree (no commit unless asked)**

Move to Task 3.

---

## Task 3: Stub bot — spawn/remove, gravity + collision, capsule visualization

**Files:**
- Modify: `bot-viewer.html`

- [ ] **Step 1: Insert before the render loop**

Find the `renderer.setAnimationLoop(...)` block from Task 2 (always the last thing in the
script). Insert the following immediately before it:

```js
// ===================== stub bot =====================
import { createBotEntity, stepBotPhysics, toWirePose } from './bot-entity.js';

const BOT_SPAWN = { x: 6, y: 0, z: 0 };  // Room B, away from Room A's doorway
const botMat = new THREE.MeshStandardMaterial({ color: 0xff7043, roughness: 0.6 });
const facingMat = new THREE.MeshStandardMaterial({ color: 0xffe0b2 });

let bot = null;
let botMesh = null;
let facingMesh = null;

function spawnBot() {
  if (bot) return;
  bot = createBotEntity('bot-1', BOT_SPAWN);
  const geom = new THREE.CapsuleGeometry(bot.capsule.radius, bot.capsule.end.y - bot.capsule.start.y, 4, 8);
  botMesh = new THREE.Mesh(geom, botMat);
  botMesh.castShadow = true;
  scene.add(botMesh);
  // Small facing indicator so a nonzero bot.yaw (set manually via the panel for now -- Phase 1
  // wires it to aim logic) is visible even though nothing drives it yet in Phase 0.
  facingMesh = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.3, 8), facingMat);
  facingMesh.rotation.x = Math.PI / 2;
  scene.add(facingMesh);
}
function removeBot() {
  if (!bot) return;
  scene.remove(botMesh); botMesh.geometry.dispose();
  scene.remove(facingMesh); facingMesh.geometry.dispose();
  bot = null; botMesh = null; facingMesh = null;
}

function updateBot(dt) {
  if (!bot) return;
  stepBotPhysics(bot, dt, { mapCollider });
  const mid = bot.capsule.start.clone().add(bot.capsule.end).multiplyScalar(0.5);
  botMesh.position.copy(mid);
  facingMesh.position.copy(mid).addScaledVector(new THREE.Vector3(Math.sin(bot.yaw), 0, Math.cos(bot.yaw)), bot.capsule.radius + 0.2);
  facingMesh.rotation.z = -bot.yaw;
}

```

- [ ] **Step 2: Wire `updateBot` into the render loop and add the control panel**

Replace the `renderer.setAnimationLoop(...)` block (unchanged since Task 2) with:

```js
// ===================== control panel =====================
const panelStyle = document.createElement('style');
panelStyle.textContent = '#ctrl{position:fixed;top:10px;right:10px;width:230px;background:rgba(20,24,30,.86);border:1px solid #333a45;border-radius:8px;color:#c4ccd6;font:12px/1.45 system-ui,sans-serif;user-select:none;z-index:20;padding:10px 12px}#ctrl .ttl{font-size:12px;color:#8a93a3;font-weight:600;margin-bottom:6px}#ctrl button{width:100%;background:#2a313c;color:#c4ccd6;border:1px solid #3a434f;border-radius:4px;padding:6px;cursor:pointer;margin:4px 0}#ctrl button:hover{background:#333c49}#ctrl .row{display:flex;justify-content:space-between;margin:4px 0;color:#7f8a99}#ctrl .row span.v{color:#c4ccd6}';
document.head.appendChild(panelStyle);

const ctrl = document.createElement('div'); ctrl.id = 'ctrl'; document.body.appendChild(ctrl);
ctrl.innerHTML = '<div class="ttl">Bot controls</div>';
const spawnBtn = document.createElement('button'); spawnBtn.textContent = 'Spawn bot';
const removeBtn = document.createElement('button'); removeBtn.textContent = 'Remove bot';
spawnBtn.addEventListener('click', spawnBot);
removeBtn.addEventListener('click', removeBot);
ctrl.appendChild(spawnBtn); ctrl.appendChild(removeBtn);

const posRow = document.createElement('div'); posRow.className = 'row';
posRow.innerHTML = '<span>pos</span><span class="v" id="bot-pos">-</span>';
const floorRow = document.createElement('div'); floorRow.className = 'row';
floorRow.innerHTML = '<span>onFloor</span><span class="v" id="bot-floor">-</span>';
ctrl.appendChild(posRow); ctrl.appendChild(floorRow);
const posEl = document.getElementById('bot-pos');
const floorEl = document.getElementById('bot-floor');

let lastT = performance.now();
renderer.setAnimationLoop(() => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  updateBot(dt);
  if (bot) {
    const p = toWirePose(bot).p;
    posEl.textContent = p.map(v => v.toFixed(2)).join(', ');
    floorEl.textContent = String(bot.onFloor);
  } else {
    posEl.textContent = '-'; floorEl.textContent = '-';
  }
  controls.update();
  renderer.render(scene, camera);
});
```

- [ ] **Step 3: Syntax-check**

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('bot-viewer.html','utf8').match(/<script type=\"module\">([\s\S]*?)<\/script>/)[1];fs.writeFileSync('bot-viewer.check.mjs', s)"
node --check bot-viewer.check.mjs
rm bot-viewer.check.mjs
```

Expected: exits 0, no output.

- [ ] **Step 4: Manual visual smoke test**

Reload `bot-viewer.html`. Click "Spawn bot". Expected: an orange capsule appears at the Room B
spawn point, falls under gravity, and settles on the floor without clipping through it or the
walls (`onFloor` in the panel flips to `true` once it lands, and `pos` stabilizes). Nudge the
camera to confirm the capsule doesn't sink into or float above the floor plane. Click
"Remove bot" — capsule disappears, panel readouts reset to `-`. Click "Spawn bot" again —
works a second time (no leaked geometry error, no duplicate capsule).

- [ ] **Step 5: Leave in working tree (no commit unless asked)**

Move to Task 4.

---

## Task 4: Docs — new `bots` subsystem doc, CLAUDE.md table row, code-map.html registration, agent_log

**Files:**
- Create: `docs/subsystems/bots.md`
- Modify: `CLAUDE.md` (workshop-webgpu)
- Modify: `code-map.html`
- Modify: `agent_log.csv`

- [ ] **Step 1: Write `docs/subsystems/bots.md`**

```markdown
# Combat bots

Status: Phase 0 only (2026-07-13) — standalone dev harness, **not wired into
`environment-viewer.html`**. See `docs/superpowers/specs/2026-07-13-combat-bot-fsm-design.md`
for the full design and phasing, and `docs/superpowers/plans/2026-07-13-combat-bot-phase0-viewer.md`
for how this phase was built.

## What exists today
- `bot-entity.js` — capsule state (`createBotEntity`), gravity + map-collision physics step
  (`stepBotPhysics`), and conversion to the game's player wire-pose shape (`toWirePose`).
  Browser/THREE only (needs a real `mapCollider` BVH), not Node-tested.
- `bot-viewer.html` — standalone `WebGPURenderer`/`OrbitControls` scene shell (same pattern as
  `plant-viewer.html`/`tree-viewer.html`) with a hand-built two-room test map and a spawn/remove
  panel for a single stub bot: falls under gravity, collides with the test room, no FSM,
  movement input, or combat yet.

## Not yet built (see spec for phasing)
`bot-activity.js` (FSM: patrol/seek/aim/fire/retreat), `nav-grid.js` (pathing), the
keyboard-controlled dummy player capsule, and every hook point into `environment-viewer.html`
(`botPlayers` map, `getKnownPlayerState`, `getState()`, `currentCombatPlayers`,
`player-combat.js#ensurePlayer`).

## Key files
| File | Role |
|---|---|
| `bot-entity.js` | Capsule/physics/pose — the module later phases and the game import unchanged. |
| `bot-viewer.html` | Dev harness; not part of the game's module graph. |
```

- [ ] **Step 2: Add a table row to `CLAUDE.md` (workshop-webgpu)**

In the Subsystems table, insert a new row after the `Shoot house map` row:

```
| Combat bots (Phase 0) | `bots.md` | `bot-entity.js`, `bot-viewer.html` (standalone, not yet wired) |
```

- [ ] **Step 3: Register the new group in `code-map.html`**

In `GROUPS` (code-map.html:131), add after the `shoothouse` entry:
```js
  bots:        { label: 'Combat bots',       color: '#c0ca33' },
```

In `NODES` (after the shoot-house block, code-map.html:~159-165), add:
```js
  { id: 'bot-entity.js', group: 'bots', lines: 70,
    desc: 'Capsule state + gravity/map-collision physics step + wire-pose conversion for FSM-driven combat bots. Phase 0: no FSM yet, imported directly by bot-viewer.html; intended to be imported unchanged by environment-viewer.html once bots are wired into the game.',
    tests: [] },
  { id: 'bot-viewer.html', group: 'bots', kind: 'tool', lines: 220,
    desc: 'Standalone WebGPU harness for building/tuning combat bots outside the game (same shell pattern as plant-viewer.html). Phase 0: hand-built two-room test map, spawn/remove panel for a single stub bot. Not wired into environment-viewer.html.',
    tests: [] },
```

In `GROUP_DOCS` (code-map.html:341), add:
```js
  bots: 'bots.md',
```

In `GROUP_REPRESENTATIVE` (code-map.html:350), add:
```js
  bots: 'bot-entity.js',
```

In `DOC_LIST` (code-map.html:358), add after the shoot-house.md entry:
```js
  ['bots.md', 'Combat bots', 'bots'],
```

- [ ] **Step 4: Syntax-check `code-map.html`'s script**

```bash
node -e "const fs=require('fs');const s=fs.readFileSync('code-map.html','utf8').match(/<script>([\s\S]*?)<\/script>/)[1];fs.writeFileSync('code-map.check.mjs', s)"
node --check code-map.check.mjs
rm code-map.check.mjs
```

Expected: exits 0, no output. (If `code-map.html` has more than one `<script>` block, adjust the
regex to target the one containing `const NODES` before checking — confirm which one first.)

- [ ] **Step 5: Manual smoke test — code-map.html**

Open `code-map.html` in a browser (via the same `python serve.py` used for Task 2/3). Expected:
a new "Combat bots" entry appears in the group filter/legend, `bot-entity.js` and
`bot-viewer.html` appear as nodes in that color, and the doc-links panel has a "Combat bots"
link that opens `docs/subsystems/bots.md`.

- [ ] **Step 6: Append to `agent_log.csv`**

Add one row (ISO date `2026-07-13T00:00`, adjust to actual local time if known) with columns
`date,subsystem,files,summary`:

```
2026-07-13T00:00,creature,"bot-entity.js;bot-viewer.html;docs/subsystems/bots.md;CLAUDE.md;code-map.html",Phase 0 of the combat-bot FSM design: standalone bot-viewer.html harness plus bot-entity.js capsule/physics module, no FSM yet.
```

(Use `multi` instead of `creature` if bots end up warranting their own subsystem key elsewhere in
this file already — check existing rows first; `creature` is used here because bots are the
closest sibling concept to the existing creature sim until a dedicated `bots` key is established
in the CSV convention.)

- [ ] **Step 7: Leave in working tree (no commit unless asked)**

Plan complete.
