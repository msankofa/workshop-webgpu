
import * as THREE from 'three';
import { WebGPURenderer } from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createLightingRig } from './lights.js';
import { createPostFX } from './post-fx.js';
import { createVisualSystem } from './bot-viewer-visuals.js';
import { createBodyPartBatches } from './body-part-batches.js';
import { createProceduralPlayerBody, clearSharedBodyGeometry } from './player-procedural-body.js';
import { composeBot } from './bot-body-versions.js';
import { withPads, withCarrier, withPack } from './bot-human-body.js';
import { createEffectRenderer, makeStainTexture, bloodIntensityForHealth } from './effect-renderer.js';
import { getDamageClass, shouldShowBlood, shouldShowSmoke } from './bot-damage-class.js';
import { WOUND_DEFAULTS } from './wound-mask.js';
import { EffectEntity } from './entity-types/effect.js';
import { createProjectedDecals } from './projected-decals.js';
import { resolveBodyHit, attachFromPoint, resolveAttachmentMatrix } from './bot-body-hit.js';
import { rayCapsuleHit } from './combat.js';

window.__ready = false;
window.__errors = [];
const hud = document.getElementById('hud');
function noteError(msg) {
  window.__errors.push(String(msg));
  hud.textContent = '⚠ ' + msg;
  hud.style.color = '#ffb3b3';
}
addEventListener('error', e => noteError(e.message || 'script error'));
addEventListener('unhandledrejection', e => noteError((e.reason && e.reason.message) || String(e.reason)));

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
camera.position.set(0, 1.5, 3.4);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.09;
controls.minDistance = 0.6;
controls.maxDistance = 20;
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

const overheadLight = new THREE.PointLight(0xffffff, 24, 18, 2);
overheadLight.position.set(0, 6, 2);
scene.add(overheadLight);

const postFX = createPostFX({ renderer, scene, camera, params: { mode: 'full', tone: 'none', bloomStrength: 0.10, bloomRadius: 0.7, bloomThreshold: 0.0 } });
const visuals = createVisualSystem({ THREE, renderer, scene, camera, postFX, rig, overheadLight });

const floor = new THREE.Mesh(new THREE.BoxGeometry(10, 0.1, 10), visuals.materials.floor);
floor.position.set(0, -0.05, 0);
floor.castShadow = true; floor.receiveShadow = true;
scene.add(floor);
visuals.setBounds({ minX: -5, maxX: 5, minZ: -5, maxZ: 5 });

// ===================== bot =====================
// Matches the in-game alpha team style (bot-design-studio.html's DEFAULT_STYLE).
const DEFAULT_STYLE = { shell: 0x46554c, plate: 0x1b201d, trim: 0x0a0d0a, accent: 0x53d68d };
const VARIANTS = {
  og:      { label: 'og bot (v1 blockout)', design: () => composeBot('v1', 'as authored') },
  armored: { label: 'armored bot (v5 current)', design: () => composeBot('current', 'as authored') },
  // Same construction bot-design-studio.html's own default scene uses for its clothed human —
  // composeBot's bare 'human' body plus the pack/carrier/pads kit from bot-human-body.js.
  soldier: { label: 'human soldier', design: () => withPack(withCarrier(withPads(composeBot('human', 'human', { expression: 'determined' })))) },
};

// Rebuilt on every variant switch, same order buildSlots() in bot-design-studio.html uses: destroy
// the old body, drop the InstancedMesh buckets, THEN clear the shared geometry cache (a bucket
// still references a geometry the cache is about to drop), then make a fresh batch pool.
let batches = createBodyPartBatches({ THREE, scene, materials: visuals.botMaterials, capacity: 512 });
let body = null;
let currentVariant = 'og';
const botState = {
  position: new THREE.Vector3(0, 0.9, 0),
  velocity: new THREE.Vector3(0, 0, 0),
  yaw: 0, crouch: 0, prone: 0, alive: true, onFloor: true,
};

function buildBot(variantKey) {
  currentVariant = variantKey;
  if (body) body.destroy();
  batches.dispose();
  clearSharedBodyGeometry();
  batches = createBodyPartBatches({ THREE, scene, materials: visuals.botMaterials, capacity: 512 });
  const design = VARIANTS[variantKey].design();
  body = createProceduralPlayerBody({
    THREE, scene, terrainHeight: () => 0, mode: 'remote', style: DEFAULT_STYLE,
    design, adaptGaitToSpeed: true, movementDynamics: true, batches,
  });
  clearEffects();
}

// ===================== effects =====================
// Real entity lifecycle, not a mockup: spawnEffect() creates an EffectEntity exactly like a host
// would on a hit, drawFrame() ages it via EffectEntity.update() every tick and drops it once
// expired, and effect-renderer.js's fx.sync() draws the serialized wire list — the same three
// functions live combat would call once something spawns hit_spark/blood_spray/blood_splatter.
// resolveAttachment is what lets a blood_stain ride the bot instead of hanging where it was hit.
// One bot here, so ownerId is ignored — in a multi-bot host it looks the bot up by id first.
const fx = createEffectRenderer({
  THREE, scene, terrainHeight: () => 0,
  resolveAttachment: (_ownerId, attach) => resolveAttachmentMatrix(body, attach),
});
let effects = [];
let fxIdCounter = 0;
function clearEffects() { effects = []; }

// ---- Mode C: GPU depth-projected stains -------------------------------------------------
// Built lazily and rebuilt on the debug toggle, because `debug` is baked into the TSL graph.
const stainTex = makeStainTexture(THREE);
let projected = null;
function ensureProjected() {
  if (projected && projected.debugOn === settings.stain.projDebug) return projected;
  if (projected) projected.dispose();
  projected = createProjectedDecals({ THREE, scene, decalTexture: stainTex, cap: 256, debug: settings.stain.projDebug });
  projected.debugOn = settings.stain.projDebug;
  projected.setWoundStyle(settings.wound);   // a rebuilt pool starts at the module defaults
  return projected;
}
// Both decal materials carry their own copy of the wound uniforms, so both have to be written.
function applyWoundStyle() {
  fx.setWoundStyle(settings.wound);
  if (projected) projected.setWoundStyle(settings.wound);
}
const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const _pp = new THREE.Vector3(), _pn = new THREE.Vector3(), _pm = new THREE.Matrix3();

// Draws every live blood_stain as a projection box. Mirrors drawBloodStain's fade envelope and its
// attach resolution exactly, so the only thing being compared against Mode A is the decal technique.
function drawProjectedStains() {
  const pool = ensureProjected();
  pool.begin();
  for (const e of effects) {
    const s = e.state;
    if (s.kind !== 'blood_stain') continue;
    const lt = e.sim.age / (s.life || 6);
    if (lt >= 1) continue;
    const a = smooth01(Math.min(1, lt * 12)) * (1 - smooth01(Math.max(0, (lt - 0.7) / 0.3))) * s.opacity;
    if (a <= 0.003) continue;
    _pp.set(e.transform.p[0], e.transform.p[1], e.transform.p[2]);
    _pn.set(s.normal[0], s.normal[1], s.normal[2]);
    const m = s.attach ? resolveAttachmentMatrix(body, s.attach) : null;
    if (m) {
      _pp.set(s.attach.lp[0], s.attach.lp[1], s.attach.lp[2]).applyMatrix4(m);
      _pm.getNormalMatrix(m);
      _pn.set(s.attach.ln[0], s.attach.ln[1], s.attach.ln[2]).applyMatrix3(_pm).normalize();
    }
    const spin = ((parseInt(e.id.replace(/\D/g, ''), 10) || 0) * 2.399963) % (Math.PI * 2);
    pool.push(_pp.x, _pp.y, _pp.z, _pn, s.size, settings.stain.projDepth,
      s.color[0], s.color[1], s.color[2], a, spin);
  }
  pool.end();
}
function spawnEffect(kind, params) {
  const entity = EffectEntity.create({ kind, ...params });
  entity.id = 'fx' + (fxIdCounter++);
  effects.push(entity);
}

// ===================== hit detection + firing =====================
const raycaster = new THREE.Raycaster();
const settings = {
  fireMode: 'click',
  // Where the impact point comes from. This harness has always used the triangle-accurate mesh
  // raycast, which is STRICTLY better than what live combat gives it — combat hitscan tests one
  // 0.3 m capsule for the whole bot, so a limb hit lands centimetres off the mesh in open air. That
  // made the harness unable to show the defect it is supposed to be judging.
  //   capsule — mimic production: ray vs one 0.3 m / 1.8 m vertical capsule (bot-entity.js defaults)
  //   parts   — bot-body-hit.js's per-part AABB walk, the proposed production fix
  //   mesh    — batches.raycast against the real triangles; the best-case reference
  hitSource: 'parts',
  attach: true,   // pin stains to the part they hit
  motion: false,  // pace the bot, so a stain left behind is visible as a stain left behind
  // Damage class + synthetic health. There is no combat here, so `health` is a slider standing in
  // for what bot-viewer-v2 computes from the real hit; both feed the same shared functions.
  damageClass: 'off',      // 'off' | any bot-damage-class.js id
  health: 0.5,             // victim's health fraction AFTER the hit
  breached: false,         // the one-way armour latch, so a healed-but-breached bot is testable
  bloodIntensity: true,    // scale spray/splatter by health
  // high count / small droplet / mid speed / mid-high spread reads best for the flight burst.
  spray: { on: true, count: 28, size: 0.03, speed: 4.2, spread: 1.0, gravity: 9.8 },
  // stain: the mark AT the wound — small and high-opacity so it reads as a stain, not a blob.
  //   fixed  — one authored size for every hit, scaled by a coarse head/torso/arm/leg factor
  //   fitted — Mode A: sized from the hit part's own cross-section, so it can't overhang the limb
  //   projected — Mode C: a GPU box that paints whatever solid surface the depth buffer says is
  //                behind it, so it wraps instead of floating. projDepth is how far the box reaches
  //                along the normal (each way) — keep it under half a limb's width or the box
  //                catches the far side of the limb too.
  stain: {
    on: true, mode: 'fitted', size: 0.15, opacity: 0.92, fit: 0.55, fitMin: 0.03, fitMax: 0.16,
    projDepth: 0.025, projDebug: false,
  },
  // Wound centre. Distances are in decal half-widths (the quad spans +/-0.5), so they hold their
  // meaning across every stain size. darken: 1 turns the effect off without touching the shader.
  wound: { ...WOUND_DEFAULTS },
  // splatter: where the spray's own droplets land on the GROUND nearby (not on the body).
  splatter: { on: true, count: 10, size: 0.12, opacity: 0.8, spread: 1.0, speed: 4.2, gravity: 9.8 },
  smoke: { on: true, size: 0.28 },
  sparks: { on: true },
};

// World AABB over a set of instanced-mode placeholders — they are plain Object3D, not Mesh, so
// Box3.setFromObject() sees nothing for them (same helper/comment as bot-design-studio.html).
const _wb = new THREE.Box3(), _wbg = new THREE.Box3();
function worldBounds(nodes) {
  _wb.makeEmpty();
  for (const n of nodes || []) {
    if (!n.geometry) continue;
    n.updateWorldMatrix(true, false);
    if (!n.geometry.boundingBox) n.geometry.computeBoundingBox();
    _wbg.copy(n.geometry.boundingBox).applyMatrix4(n.matrixWorld);
    _wb.union(_wbg);
  }
  return _wb;
}

// Coarse head/torso/arm/leg attribution from the bot's own live bounding box. body-part-batches.js's
// raycast() only carries a MATERIAL role per hit (shell/plate/skin/...), not an anatomical one — see
// its module comment — so this buckets by height fraction / lateral offset within the current pose's
// bounding box instead of threading per-instance anatomical labels through the instancing pool.
function bodyPartAt(point) {
  if (!body) return 'torso';
  const _partBox = worldBounds(body.parts.all);
  if (_partBox.isEmpty()) return 'torso';
  const h = Math.max(0.01, _partBox.max.y - _partBox.min.y);
  const cx = (_partBox.min.x + _partBox.max.x) / 2, cz = (_partBox.min.z + _partBox.max.z) / 2;
  const halfW = Math.max(0.05, (_partBox.max.x - _partBox.min.x) / 2);
  const yFrac = (point.y - _partBox.min.y) / h;
  if (yFrac >= 0.85) return 'head';
  if (yFrac < 0.42) return 'leg';
  const lateral = Math.hypot(point.x - cx, point.z - cz);
  if (lateral > halfW * 0.55) return 'arm';
  return 'torso';
}
const PART_SCALE = { head: 1.5, torso: 1.15, arm: 0.85, leg: 0.85 };

// Resolve one shot ray to an impact point, a normal, and (where the source can supply one) a part
// attachment handle. The three sources differ only in accuracy, which is the whole comparison.
function resolveShot(origin, dir) {
  if (!body) return null;
  if (settings.hitSource === 'capsule') {
    // bot-entity.js's own defaults: r 0.3, stand height 1.8, so the segment runs 0.3..1.5.
    const p = botState.position;
    const r = rayCapsuleHit([origin.x, origin.y, origin.z], [dir.x, dir.y, dir.z], 200,
      { p: [p.x, 0.9, p.z], r: 0.3, h: 1.2 });
    if (!r.hit) return null;
    const point = new THREE.Vector3(r.point[0], r.point[1], r.point[2]);
    // Capsules are strictly vertical, so the outward normal is horizontal by construction — the
    // same convention combat.js uses, and the reason a capsule hit can never carry a body normal.
    const nx = point.x - p.x, nz = point.z - p.z;
    const l = Math.hypot(nx, nz);
    const normal = l > 1e-4 ? new THREE.Vector3(nx / l, 0, nz / l) : new THREE.Vector3(0, 1, 0);
    return { point, normal, attach: null };   // no part information exists at this level
  }
  if (settings.hitSource === 'parts') {
    return resolveBodyHit({ THREE, body, origin, dir });
  }
  raycaster.set(origin, dir);
  const hit = batches.raycast(raycaster);
  if (!hit) return null;
  const normal = hit.normal || new THREE.Vector3(0, 1, 0);
  // The point is already exact; all that's missing is the stable part handle to pin it to.
  const att = attachFromPoint({ THREE, body, point: hit.point, normal });
  return { point: hit.point, normal, attach: att?.attach || null, crossSection: att?.crossSection || 0 };
}

function fireHit(hit) {
  if (!hit) return;
  const part = bodyPartAt(hit.point);
  const scale = PART_SCALE[part] || 1;
  const p = [hit.point.x, hit.point.y, hit.point.z];
  const n = hit.normal ? [hit.normal.x, hit.normal.y, hit.normal.z] : [0, 1, 0];

  // Same two decisions bot-viewer-v2 makes per hit, driven by the sliders instead of by combat.
  const classOn = settings.damageClass !== 'off';
  const cls = getDamageClass(classOn ? settings.damageClass : 'human');
  const blood = classOn ? shouldShowBlood(cls, settings.health, settings.breached).show : true;
  const sparks = classOn ? cls.sparks : true;
  const smoke = classOn ? shouldShowSmoke(cls, settings.health, settings.breached) : false;
  const I = settings.bloodIntensity ? bloodIntensityForHealth(settings.health) : bloodIntensityForHealth(0);

  if (settings.sparks.on && sparks) {
    spawnEffect('hit_spark', { p, normal: n, surface: null });
  }
  if (smoke) {
    spawnEffect('smoke_puff', {
      p, color: [0.32, 0.31, 0.3], size: 0.1, growth: 0.35, rise: 0.5, opacity: 0.22, life: 0.7,
    });
  }
  if (!blood) return;
  if (settings.spray.on && I.sprayCount > 0) {
    spawnEffect('blood_spray', {
      p, normal: n, bodyPart: part,
      // The count/speed/spread sliders stay the authored ceiling; health scales toward it, so the
      // harness can still tune the shape of a full-intensity burst independently.
      count: Math.max(1, Math.round(settings.spray.count * scale * (I.sprayCount / 28))),
      size: settings.spray.size * scale,
      speed: settings.spray.speed * (I.spraySpeed / 4.2),
      spread: settings.spray.spread * (I.spraySpread / 1.0),
      gravity: settings.spray.gravity,
    });
  }
  if (settings.stain.on) {
    // Mode A. `crossSection` is 0 for a capsule hit — no part was identified — so that source
    // always falls back to the authored size, which is the honest comparison: fitted sizing is only
    // available once the hit knows what it struck.
    const st = settings.stain;
    const fitted = st.mode === 'fitted' && hit.crossSection > 0;
    const size = fitted
      ? Math.min(st.fitMax, Math.max(st.fitMin, st.fit * hit.crossSection))
      : st.size * scale;
    spawnEffect('blood_stain', {
      p, normal: n, bodyPart: part, size, opacity: st.opacity,
      attach: settings.attach ? (hit.attach || null) : null,
    });
  }
  if (settings.splatter.on && I.splatterCount > 0) {
    spawnEffect('blood_splatter', {
      p, normal: n, bodyPart: part,
      count: Math.max(1, Math.round(settings.splatter.count * scale * (I.splatterCount / 10))),
      size: settings.splatter.size * scale,
      opacity: settings.splatter.opacity * (I.splatterOpacity / 0.8),
      spread: settings.splatter.spread,
      speed: settings.splatter.speed,
      gravity: settings.splatter.gravity,
    });
  }
  if (settings.smoke.on) {
    spawnEffect('smoke_puff', {
      p, size: settings.smoke.size * scale, growth: 0.3, rise: 0.15, opacity: 0.22, life: 0.5,
      color: [0.45, 0.42, 0.4],
    });
  }
}

function raycastFromCamera(clientX, clientY) {
  const ndc = new THREE.Vector2(
    (clientX / window.innerWidth) * 2 - 1,
    -(clientY / window.innerHeight) * 2 + 1,
  );
  raycaster.setFromCamera(ndc, camera);
  return resolveShot(raycaster.ray.origin.clone(), raycaster.ray.direction.clone());
}

// Click-to-fire has to tell a click apart from an OrbitControls drag — both start as a pointerdown
// on the same canvas — so this only fires if pointerup lands within a few pixels of pointerdown.
let _downPos = null;
renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0) return;
  _downPos = { x: ev.clientX, y: ev.clientY };
});
renderer.domElement.addEventListener('pointerup', (ev) => {
  const down = _downPos; _downPos = null;
  if (settings.fireMode !== 'click' || ev.button !== 0 || !down) return;
  if (Math.hypot(ev.clientX - down.x, ev.clientY - down.y) > 4) return; // was a camera drag
  fireHit(raycastFromCamera(ev.clientX, ev.clientY));
});

// Random shot: a random point jittered around the bot's bounding-box center, hit from a uniformly
// random direction (standard sphere-point sampling: z = cosPhi uniform in [-1,1], theta uniform in
// [0,2pi)) — the actual impact point/normal still comes from the real raycast against the bot, this
// just randomizes where the shot is aimed from and roughly at.
function fireRandomShot() {
  if (!body) return;
  const partBox = worldBounds(body.parts.all);
  if (partBox.isEmpty()) return;
  const center = new THREE.Vector3();
  partBox.getCenter(center);
  const size = new THREE.Vector3();
  partBox.getSize(size);
  const aim = center.clone().add(new THREE.Vector3(
    (Math.random() * 2 - 1) * size.x * 0.35,
    (Math.random() * 2 - 1) * size.y * 0.4,
    (Math.random() * 2 - 1) * size.z * 0.35,
  ));
  const theta = Math.random() * Math.PI * 2;
  const cosPhi = Math.random() * 2 - 1;
  const sinPhi = Math.sqrt(1 - cosPhi * cosPhi);
  const dirIn = new THREE.Vector3(sinPhi * Math.cos(theta), cosPhi, sinPhi * Math.sin(theta));
  const back = Math.max(4, size.length() * 2);
  const origin = aim.clone().addScaledVector(dirIn, back);
  const dir = aim.clone().sub(origin).normalize();
  fireHit(resolveShot(origin, dir));
}

// ===================== control panel =====================
function el(tag, cls, parent) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (parent) parent.appendChild(n);
  return n;
}
function section(panel, title) {
  const h3 = el('h3', null, panel); h3.textContent = title;
  const b = el('div', 'body', panel);
  h3.addEventListener('click', () => h3.classList.toggle('collapsed'));
  return b;
}
function row(parent, labelText) {
  const r = el('div', 'row', parent);
  const l = el('label', null, r); l.textContent = labelText;
  return r;
}
function slider(parent, labelText, min, max, step, value, onInput) {
  const r = row(parent, labelText);
  const input = el('input', null, r);
  input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = value;
  const out = el('input', null, r);
  out.type = 'number'; out.min = min; out.max = max; out.step = step; out.value = value;
  input.addEventListener('input', () => { out.value = input.value; onInput(parseFloat(input.value)); });
  out.addEventListener('change', () => { input.value = out.value; onInput(parseFloat(out.value)); });
}
function toggle(parent, labelText, checked, onChange) {
  const r = row(parent, labelText);
  const btn = el('button', checked ? 'on' : '', r);
  btn.textContent = checked ? 'on' : 'off';
  btn.addEventListener('click', () => {
    checked = !checked;
    btn.classList.toggle('on', checked);
    btn.textContent = checked ? 'on' : 'off';
    onChange(checked);
  });
}

const panel = document.getElementById('panel');

const varBody = section(panel, 'bot');
const varRow = row(varBody, 'variant');
const varSelect = el('select', null, varRow);
for (const key in VARIANTS) {
  const opt = el('option', null, varSelect);
  opt.value = key; opt.textContent = VARIANTS[key].label;
}
varSelect.value = currentVariant;
varSelect.addEventListener('change', () => buildBot(varSelect.value));
toggle(varBody, 'pace', settings.motion, v => {
  settings.motion = v;
  if (!v) { botState.position.x = 0; botState.yaw = 0; }
});

const hitBody = section(panel, 'hit resolution');
const srcRow = row(hitBody, 'source');
const srcBtns = { capsule: null, parts: null, mesh: null };
function setHitSource(mode) {
  settings.hitSource = mode;
  for (const k in srcBtns) srcBtns[k].classList.toggle('on', k === mode);
}
for (const k in srcBtns) {
  const b = el('button', null, srcRow); b.textContent = k;
  b.addEventListener('click', () => setHitSource(k));
  srcBtns[k] = b;
}
setHitSource(settings.hitSource);
toggle(hitBody, 'attach stains', settings.attach, v => settings.attach = v);
const hitNote = el('div', 'note', hitBody);
hitNote.textContent = 'capsule = what live combat actually gives the FX (one 0.3 m capsule for the '
  + 'whole bot). parts = the per-part fix. mesh = triangle-accurate reference. Attach pins a stain '
  + 'to the part it hit; off leaves it in the air where the bot was. Turn on pace to see it.';

const classBody = section(panel, 'damage class');
const clsRow = row(classBody, 'class');
const clsBtns = { off: null, human: null, armouredHuman: null, robot: null };
function setDamageClass(id) {
  settings.damageClass = id;
  for (const k in clsBtns) clsBtns[k].classList.toggle('on', k === id);
}
for (const k in clsBtns) {
  const b = el('button', null, clsRow); b.textContent = k === 'armouredHuman' ? 'armoured' : k;
  b.addEventListener('click', () => setDamageClass(k));
  clsBtns[k] = b;
}
setDamageClass(settings.damageClass);
// The harness has no combat and therefore no health, so the health this drives is synthetic — but
// it is the same number bot-viewer-v2 computes from the real hit, fed to the same two functions.
slider(classBody, 'health after hit', 0, 1, 0.01, settings.health, v => settings.health = v);
toggle(classBody, 'bleed by health', settings.bloodIntensity, v => settings.bloodIntensity = v);
toggle(classBody, 'armour breached', settings.breached, v => settings.breached = v);
const clsNote = el('div', 'note', classBody);
clsNote.textContent = 'off = every hit bleeds and sparks, the old behaviour. armoured only bleeds at '
  + 'or below 35% health, or once breached — flip "armour breached" to see that a healed bot keeps '
  + 'bleeding. robot never bleeds. "bleed by health" scales the droplet burst and ground splatter '
  + 'from a trickle at full health to today\'s full burst at zero.';

const fireBody = section(panel, 'fire');
const modeRow = row(fireBody, 'mode');
const clickBtn = el('button', 'on', modeRow); clickBtn.textContent = 'click';
const randBtn = el('button', null, modeRow); randBtn.textContent = 'random target';
function setFireMode(mode) {
  settings.fireMode = mode;
  clickBtn.classList.toggle('on', mode === 'click');
  randBtn.classList.toggle('on', mode === 'random');
}
clickBtn.addEventListener('click', () => setFireMode('click'));
randBtn.addEventListener('click', () => setFireMode('random'));
const fireBtnsRow = el('div', 'btns', fireBody);
const randShotBtn = el('button', null, fireBtnsRow); randShotBtn.textContent = 'fire random shot';
randShotBtn.addEventListener('click', fireRandomShot);
const clearBtn = el('button', null, fireBtnsRow); clearBtn.textContent = 'clear effects';
clearBtn.addEventListener('click', clearEffects);
const note = el('div', 'note', fireBody);
note.textContent = 'Click mode: click anywhere on the bot to fire there. Random target: use the button above.';

const sprayBody = section(panel, 'blood spray');
toggle(sprayBody, 'enabled', settings.spray.on, v => settings.spray.on = v);
slider(sprayBody, 'count', 1, 40, 1, settings.spray.count, v => settings.spray.count = v);
slider(sprayBody, 'droplet size', 0.01, 0.2, 0.005, settings.spray.size, v => settings.spray.size = v);
slider(sprayBody, 'speed', 0.5, 8, 0.1, settings.spray.speed, v => settings.spray.speed = v);
slider(sprayBody, 'spread', 0, 1.5, 0.05, settings.spray.spread, v => settings.spray.spread = v);
slider(sprayBody, 'gravity', 0, 20, 0.5, settings.spray.gravity, v => settings.spray.gravity = v);

const stainBody = section(panel, 'blood stain');
toggle(stainBody, 'enabled', settings.stain.on, v => settings.stain.on = v);
const stainModeRow = row(stainBody, 'size mode');
const stainModeBtns = { fixed: null, fitted: null, projected: null };
function setStainMode(mode) {
  settings.stain.mode = mode;
  for (const k in stainModeBtns) stainModeBtns[k].classList.toggle('on', k === mode);
}
for (const k in stainModeBtns) {
  const b = el('button', null, stainModeRow); b.textContent = k;
  b.addEventListener('click', () => setStainMode(k));
  stainModeBtns[k] = b;
}
setStainMode(settings.stain.mode);
slider(stainBody, 'size (fixed)', 0.02, 0.6, 0.01, settings.stain.size, v => settings.stain.size = v);
slider(stainBody, 'fit × width', 0.1, 1.5, 0.05, settings.stain.fit, v => settings.stain.fit = v);
slider(stainBody, 'fit min', 0.01, 0.2, 0.005, settings.stain.fitMin, v => settings.stain.fitMin = v);
slider(stainBody, 'fit max', 0.04, 0.5, 0.01, settings.stain.fitMax, v => settings.stain.fitMax = v);
slider(stainBody, 'opacity', 0.05, 1, 0.01, settings.stain.opacity, v => settings.stain.opacity = v);
slider(stainBody, 'project depth', 0.005, 0.12, 0.005, settings.stain.projDepth, v => settings.stain.projDepth = v);
toggle(stainBody, 'project debug', settings.stain.projDebug, v => settings.stain.projDebug = v);
slider(stainBody, 'wound inner', 0, 0.4, 0.005, settings.wound.inner,
  v => { settings.wound.inner = v; applyWoundStyle(); });
slider(stainBody, 'wound outer', 0.02, 0.7, 0.005, settings.wound.outer,
  v => { settings.wound.outer = v; applyWoundStyle(); });
slider(stainBody, 'wound darken', 0.05, 1, 0.05, settings.wound.darken,
  v => { settings.wound.darken = v; applyWoundStyle(); });
const woundNote = el('div', 'note', stainBody);
woundNote.textContent = 'The wound centre darkens the middle of every decal so a stain reads as a '
  + 'puncture rather than a flat smear. Distances are fractions of the decal\'s own half-width, so '
  + 'they hold at any stain size; darken 1 turns it off. Ground splatter shares the same material '
  + 'and gets the same denser core.';
const stainNote = el('div', 'note', stainBody);
stainNote.textContent = 'fitted sizes each stain from the part it hit. projected paints whatever the '
  + 'depth buffer says is behind the decal box, so it wraps instead of floating — if it renders '
  + 'blank, this pipeline cannot sample its depth buffer. Turn on project debug to check: the world '
  + 'should read as a 1 m colour grid locked to the scene, not flat or swimming.';

const splatterBody = section(panel, 'blood splatter (ground)');
toggle(splatterBody, 'enabled', settings.splatter.on, v => settings.splatter.on = v);
slider(splatterBody, 'count', 1, 40, 1, settings.splatter.count, v => settings.splatter.count = v);
slider(splatterBody, 'size', 0.02, 0.5, 0.01, settings.splatter.size, v => settings.splatter.size = v);
slider(splatterBody, 'opacity', 0.05, 1, 0.01, settings.splatter.opacity, v => settings.splatter.opacity = v);
slider(splatterBody, 'spread', 0, 1.5, 0.05, settings.splatter.spread, v => settings.splatter.spread = v);
slider(splatterBody, 'speed', 0.5, 8, 0.1, settings.splatter.speed, v => settings.splatter.speed = v);
slider(splatterBody, 'gravity', 0, 20, 0.5, settings.splatter.gravity, v => settings.splatter.gravity = v);

const smokeBody = section(panel, 'smoke puff');
toggle(smokeBody, 'enabled', settings.smoke.on, v => settings.smoke.on = v);
slider(smokeBody, 'size', 0.05, 0.8, 0.01, settings.smoke.size, v => settings.smoke.size = v);

const sparkBody = section(panel, 'sparks');
toggle(sparkBody, 'enabled', settings.sparks.on, v => settings.sparks.on = v);

document.getElementById('panelToggle').addEventListener('click', () => panel.classList.toggle('hidden'));

// ===================== bot motion =====================
// A stain that stays where the bot WAS only reads as a bug once the bot leaves. Without this the
// harness is a statue and the single biggest visual defect is invisible in it. Paces along X and
// faces the way it is walking; the camera deliberately stays put so a decal left behind is obvious.
const PACE_HALF = 1.2, PACE_SPEED = 1.1;
let paceDir = 1;
function stepBotMotion(dt) {
  if (!settings.motion) {
    botState.velocity.set(0, 0, 0);
    return;
  }
  botState.position.x += paceDir * PACE_SPEED * dt;
  if (botState.position.x > PACE_HALF) { botState.position.x = PACE_HALF; paceDir = -1; }
  if (botState.position.x < -PACE_HALF) { botState.position.x = -PACE_HALF; paceDir = 1; }
  botState.velocity.set(paceDir * PACE_SPEED, 0, 0);
  // The rig takes camera-style yaw; bot movement code is +Z-forward, hence the +PI (bot-viewer-v2:3422).
  botState.yaw = Math.atan2(botState.velocity.x, botState.velocity.z) + Math.PI;
}

// ===================== frame loop =====================
function updateHud() {
  if (window.__errors.length) return;
  hud.textContent = `damage simulator · ${VARIANTS[currentVariant].label} · ${effects.length} fx`;
}

let lastT = performance.now();
let framesSinceBuild = 0;
async function drawFrame(dt) {
  stepBotMotion(dt);
  batches.beginFrame();
  if (body) { body.update(dt, botState); body.flush(batches); }
  batches.endFrame();

  effects = effects.filter(e => !EffectEntity.update(e, dt));
  // Mode exclusivity: fx.sync draws every blood_stain it is handed, so when Mode C owns them they
  // are withheld here rather than filtered inside the renderer — that keeps sync(list, nowMs)
  // unchanged for its other four callers.
  const projecting = settings.stain.mode === 'projected';
  const wire = effects.map(e => EffectEntity.serialize(e));
  fx.sync(projecting ? wire.filter(w => w.kind !== 'blood_stain') : wire, performance.now());
  if (projecting) drawProjectedStains();
  else if (projected) { projected.begin(); projected.end(); }   // hide the box pool

  controls.update();
  visuals.update(dt);
  await postFX.renderAsync();
  updateHud();

  if (!window.__ready && ++framesSinceBuild > 2) window.__ready = true;
}
async function loopTick() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  await drawFrame(dt);
}
renderer.setAnimationLoop(loopTick);

buildBot(currentVariant);
