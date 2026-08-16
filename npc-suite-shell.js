// npc-suite-shell.js
//
// The NPC design suite shell (docs/subsystems/npc-suite.md). Owns ONE renderer / scene / camera /
// lighting rig / post-FX / render loop and ONE persistent NPC that survives across modes. Each tool
// (damage, weapon-anim, ragdoll, design, body-preview) lands later as a swappable mode against this
// shared context; step 1 stands up the shell + NPC + an empty tab bar. Infra is harvested from
// bot-design-studio.html (now frozen — see its header). GPU-free scaffolding lives in
// npc-suite-core.js so it can be Node-tested.

import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createLightingRig } from './lights.js';
import { createPostFX } from './post-fx.js';
import { createVisualSystem } from './bot-viewer-visuals.js';
import { createBodyPartBatches } from './body-part-batches.js';
import { createGeometryCache } from './model-primitives.js';
import { createProceduralPlayerBody } from './player-procedural-body.js';
import { composeBot } from './bot-body-versions.js';
import { withHeadKit } from './bot-face.js';
import { withPads, withCarrier, withPack } from './bot-human-body.js';
import { createSlotSection } from './bot-viewer-slots.js';
import { createChangeBus, createUndoStack, createTrackedScope, createModeManager } from './npc-suite-core.js';
import { createDamageMode } from './npc-mode-damage.js';
import { createWeaponAnimMode } from './npc-mode-weapon-anim.js';

// ===================== error surface =====================
window.__ready = false;
window.__errors = [];
const hud = document.getElementById('hud');
function noteError(msg) { window.__errors.push(String(msg)); if (hud) { hud.textContent = '⚠ ' + msg; hud.style.color = '#ffb3b3'; } }
addEventListener('error', (e) => noteError(e.message || 'script error'));
addEventListener('unhandledrejection', (e) => noteError((e.reason && e.reason.message) || String(e.reason)));

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

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(0, 1.7, 5.5);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.09;
controls.minDistance = 0.4;
controls.maxDistance = 60;
controls.maxPolarAngle = Math.PI * 0.49;
controls.update();

addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ===================== lighting / visuals =====================
const rig = createLightingRig({ scene, ui: false, elevation: 60, azimuth: 20 });
rig.dirLight.castShadow = true;
scene.add(rig.dirLight.target);
rig.dirLight.shadow.mapSize.set(2048, 2048);

const overheadLight = new THREE.PointLight(0xffffff, 28, 22, 2);
overheadLight.position.set(0, 7, 2);
scene.add(overheadLight);

const postFX = createPostFX({ renderer, scene, camera, params: { mode: 'full', tone: 'none', bloomStrength: 0.10, bloomRadius: 0.7, bloomThreshold: 0.0 } });
const visuals = createVisualSystem({ THREE, renderer, scene, camera, postFX, rig, overheadLight });

const floor = new THREE.Mesh(new THREE.BoxGeometry(36, 0.1, 24), visuals.materials.floor);
floor.position.set(0, -0.05, 0);
floor.castShadow = true; floor.receiveShadow = true;
scene.add(floor);
visuals.setBounds({ minX: -18, maxX: 18, minZ: -12, maxZ: 12 });

// ===================== the persistent NPC =====================
// P1/P1b in action: ONE geometry cache injected into the body (so its lifetime is suite-owned, not
// the module global) and ONE batch pool that survives every mode switch — never disposed/recreated
// the way bot-design-studio does per rebuild, because dropBucket() lets the cache sweep evict
// individual buckets instead.
const geoCache = createGeometryCache();
const batches = createBodyPartBatches({ THREE, scene, materials: visuals.botMaterials, capacity: 256 });
const groundHeight = () => 0;
const DEFAULT_STYLE = { shell: 0x46554c, plate: 0x1b201d, trim: 0x0a0d0a, accent: 0x53d68d };

// A clothed, kitted human reads as a proper character rather than a bare mannequin.
function defaultDesign() {
  const human = composeBot('human', 'human', { expression: 'determined' });
  return withHeadKit(withPack(withCarrier(withPads(human))), { helmet: true });
}

function freshState() {
  return {
    position: new THREE.Vector3(0, 0.9, 0),
    velocity: new THREE.Vector3(),
    yaw: Math.PI, aimPitch: 0, height: 1.8, radius: 0.3,
    onFloor: true, crouch: 0, prone: 0, alive: true,
  };
}

// The NPC handle every mode reads/writes through ctx.npc. `design` is the single source of truth;
// `body` is rebuilt from it (design is bound at construction — there is no live setDesign, so a
// geometry change is a safe destroy+rebuild under P1's retain/release).
const npc = { design: defaultDesign(), body: null, state: freshState(), batches, geoCache };

function buildBody(design) {
  return createProceduralPlayerBody({
    THREE, scene, terrainHeight: groundHeight, mode: 'remote',
    style: DEFAULT_STYLE, design,
    adaptGaitToSpeed: true, movementDynamics: true,
    batches, cache: geoCache,
  });
}

const SCRATCH_KEEP = 8;   // keep a few zero-ref geometries as a rebuild scratch pool
function rebuildBody() {
  if (npc.body) {
    npc.body.destroy();                                   // releases this body's cache holds (P1)
    geoCache.sweep(SCRATCH_KEEP, (geo) => batches.dropBucket(geo));  // drop now-unreferenced buckets (P1b bridge)
  }
  npc.body = buildBody(npc.design);
}
rebuildBody();

// ===================== change bus + undo + the one edit chokepoint =====================
const bus = createChangeBus();
const undo = createUndoStack();
undo.init(npc.design);

// applyDesignChange — the SOLE writer of npc.design (A9). Every mode routes edits here; it merges the
// patch, snapshots for undo, rebuilds/retunes per kind, and fans out on the split bus (A5). Modes
// never touch npc.design directly.
//   kind 'geometry' -> body rebuild (dimensions/parts changed)
//   kind 'gait'     -> live-tune body.gait.cfg, no rebuild (the rig exposes gait as read-mostly live)
//   kind 'material' -> rebuild for now; a retint fast-path that skips geometry is a follow-up
// opts.replace swaps the whole design (slot load); opts.noHistory suppresses the undo push (undo/redo
// apply their own snapshots).
function applyDesignChange(patch, kind = 'geometry', opts = {}) {
  npc.design = opts.replace ? patch : { ...npc.design, ...patch };
  if (!opts.noHistory) undo.push(npc.design);
  if (kind === 'gait' && npc.body?.gait?.cfg && !opts.replace) {
    Object.assign(npc.body.gait.cfg, patch);
  } else {
    rebuildBody();
  }
  bus.emit(kind, { design: npc.design, patch });
  refreshUndoButtons();
}

function applyWholeDesign(design, { history = true } = {}) {
  applyDesignChange(design, 'geometry', { replace: true, noHistory: !history });
}

// ===================== panel: tab bar + shell section + per-mode container =====================
const panel = document.getElementById('panel');
function el(tag, props = {}, kids = []) {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) e.append(k);
  return e;
}
function section(title) {
  const h = el('h3', { textContent: title });
  const body = el('div', { className: 'body' });
  h.addEventListener('click', () => h.classList.toggle('collapsed'));
  panel.append(h, body);
  return body;
}

const tabBar = el('div', { className: 'tabbar' });
const modePanel = el('div', { id: 'modePanel' });
panel.append(tabBar);

// --- shell section: undo/redo + NPC-track persistence (P4) ---
const shellBody = section('suite');
const undoRow = el('div', { className: 'btns' });
const undoBtn = el('button', { textContent: 'undo', title: 'undo (Ctrl+Z)' });
const redoBtn = el('button', { textContent: 'redo', title: 'redo (Ctrl+Shift+Z)' });
undoBtn.addEventListener('click', doUndo);
redoBtn.addEventListener('click', doRedo);
undoRow.append(undoBtn, redoBtn);
shellBody.append(undoRow);

// Persistence is split per the decision: this slot captures the NPC DESIGN only. Per-mode UI state
// lives on its own track (added when modes land), so loading a slot never disturbs tool state.
// createSlotSection returns { nodes: [...] } — spread them into the section body.
shellBody.append(...createSlotSection({
  group: 'npcSuiteNpc', label: 'npc',
  capture: () => JSON.parse(JSON.stringify(npc.design)),
  apply: (data) => { if (data) applyWholeDesign(data); },
}).nodes);
panel.append(modePanel);

function refreshUndoButtons() { undoBtn.disabled = !undo.canUndo(); redoBtn.disabled = !undo.canRedo(); }
function doUndo() { const s = undo.undo(); if (s) { applyWholeDesign(s, { history: false }); refreshUndoButtons(); } }
function doRedo() { const s = undo.redo(); if (s) { applyWholeDesign(s, { history: false }); refreshUndoButtons(); } }
refreshUndoButtons();

addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'z') return;
  e.preventDefault();
  e.shiftKey ? doRedo() : doUndo();
});

// ===================== mode manager + per-mode tracked context =====================
// Camera framing is captured per mode on the way out and restored on the way in (A4), so ragdoll's
// wide shot and weapon authoring's close read don't clobber each other.
const framingByMode = new Map();
function captureFraming() { return { pos: camera.position.toArray(), target: controls.target.toArray() }; }
function restoreFraming(f) { camera.position.fromArray(f.pos); controls.target.fromArray(f.target); controls.update(); }

// Objects a mode adds through ctx.add are removed from the scene on unmount; non-shared geometry is
// disposed (shared body geometry is owned by geoCache and tagged, so it is left alone).
function releaseObject(obj) {
  if (obj.parent) obj.parent.remove(obj);
  obj.traverse?.((o) => { if (o.geometry && !o.geometry.userData?.shared) o.geometry.dispose(); });
}

const modes = createModeManager({
  makeContext: (name) => {
    const scope = createTrackedScope({ onReleaseObject: releaseObject });
    const ctx = {
      THREE, scene, camera, controls, renderer, rig, postFX, visuals,
      npc, geoCache, batches, bus, panelRoot: modePanel,
      applyDesignChange, applyWholeDesign, undo,
      on: bus.on,
      addListener: scope.addListener, add: scope.add, addTimer: scope.addTimer,
    };
    return { ctx, scope };
  },
  onError: (e) => { noteError('mode: ' + (e?.message || e)); return null; },
});

async function switchMode(name) {
  const prev = modes.activeName();
  if (prev) framingByMode.set(prev, captureFraming());
  modePanel.replaceChildren();
  await modes.switchTo(name);
  if (framingByMode.has(name)) restoreFraming(framingByMode.get(name));
  for (const b of tabBar.children) b.classList.toggle('on', b.dataset.mode === name);
}

// Public seam for registering modes (steps 2-6 call this, then rebuild the tab bar).
const registeredOrder = [];
function registerMode(name, factory) {
  modes.register(name, factory);
  registeredOrder.push(name);
  const btn = el('button', { textContent: name });
  btn.dataset.mode = name;
  btn.addEventListener('click', () => switchMode(name).catch((e) => noteError(e.message || e)));
  tabBar.append(btn);
}

// ===================== render loop =====================
// The NPC always updates + flushes. If a mode owns motion (drivesMotion) it drove the NPC in its own
// tick(); otherwise the shell stands the NPC idle. One flush, one endFrame, one render per frame.
let lastT = performance.now();
let framesSinceBuild = 0;
function idleUpdateNpc(dt) {
  const st = npc.state;
  st.velocity.set(0, 0, 0);
  st.position.set(0, 0.9, 0);
  st.yaw = Math.PI;
  npc.body.update(dt, st);
}
async function drawFrame(dt) {
  batches.beginFrame();
  modes.tick(dt);                                   // every mode ticks (inside the batch frame)
  // A motion-owning mode updated + flushed the NPC itself in tick() (it may pose a ragdoll or skip
  // the gait); otherwise the shell stands the NPC idle and flushes it. Exactly one path runs.
  if (!modes.drivesMotion()) { idleUpdateNpc(dt); npc.body.flush(batches); }
  batches.endFrame();
  modes.current()?.afterFrame?.(dt);                // post-batch hook: FX sync, projected decals
  controls.update();
  visuals.update(dt);
  await postFX.renderAsync();
  if (!window.__ready && ++framesSinceBuild > 2) window.__ready = true;
  if (!window.__errors.length && hud) {
    hud.textContent = `npc suite · mode=${modes.activeName() || 'none'} · ${registeredOrder.length} mode(s)`;
  }
}
renderer.setAnimationLoop(async () => {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  await drawFrame(dt);
});

// ===================== expose the shell API (modes register against this) =====================
const suite = {
  THREE, scene, camera, controls, renderer, rig, postFX, visuals,
  npc, geoCache, batches, bus, applyDesignChange, applyWholeDesign, undo,
  registerMode, switchMode, section,
  modeNames: () => registeredOrder.slice(),
};
window.__npcSuite = suite;

// ===================== register modes =====================
registerMode('damage', createDamageMode);
registerMode('weapon', createWeaponAnimMode);

// Optional deep link: ?mode=<name> selects a mode once registered (A8). Applied on next tick so
// callers that register modes synchronously after import are covered.
const wantMode = new URLSearchParams(location.search).get('mode');
if (wantMode) queueMicrotask(() => { if (modes.has(wantMode)) switchMode(wantMode).catch(() => {}); });

export default suite;
