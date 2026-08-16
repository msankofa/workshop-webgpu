// npc-mode-weapon-anim.js
//
// Weapon pose / carry authoring mode for the NPC suite (docs/subsystems/npc-suite.md). Ported from
// weapon-animation-viewer.html. It is the closest of the tools to the mode shape already, so the port
// keeps the tool's self-contained floating control panel verbatim as MODE-OWNED DOM (injected on
// init, removed on dispose) and rewires only the engine: it mounts weapons on the suite's persistent
// NPC (instanced — so tick() must flush it), uses the shared scene/camera/batch pool, and drives the
// NPC around a circle to judge a carry pose against real bob/sway (drivesMotion). carryEdits stay
// mode-local. If the NPC is rebuilt under it (a design edit), it re-points and re-mounts off the
// 'geometry' bus. Nothing here writes weapon-poses.json/CARRY_PRESETS except the same explicit
// export/overwrite buttons the page had.

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { attachDracoLoader } from './draco-loader.js';
import { createWeaponPoseController } from './weapon-pose-controller.js';
import { WEAPONS } from './weapons.js';
import { CARRY_PRESETS, LOCOMOTION_KINDS, LOCOMOTION_IDLE, CARRY_BLEND_RATE,
  resolveWeaponHold, carryDeltaFor, isOneHanded, stepCarryBlend } from './weapon-hold-resolver.js';

// The tool's stylesheet, scoped under #ctrl so its bare .row/select/button rules cannot leak onto the
// shell panel. #ctrl is nudged left of the 392px shell panel; it stays draggable.
const CSS = `
#wam-info { position: fixed; top: 10px; left: 12px; z-index: 5; max-width: calc(100vw - 680px); color: #8a93a3; font: 12px/1.5 system-ui, sans-serif; pointer-events: none; user-select: none; }
#wam-status { position: fixed; left: 12px; bottom: 12px; z-index: 5; max-width: min(520px, calc(100vw - 36px)); color: #c4ccd6; font: 11px/1.45 ui-monospace, Consolas, monospace; pointer-events: none; white-space: pre-wrap; }
#ctrl { position: fixed; top: 10px; right: 400px; width: 250px; background: rgba(20,24,30,.92); border: 1px solid #333a45; border-radius: 8px; color: #c4ccd6; font: 12px/1.45 system-ui,sans-serif; user-select: none; z-index: 20; }
#ctrl-bar { display:flex; justify-content:space-between; align-items:center; padding:7px 10px; cursor:move; border-bottom:1px solid #333a45; }
#ctrl-bar .ttl { font-size:12px; color:#8a93a3; font-weight:600; }
#ctrl-min { background:none; border:none; color:#8a93a3; font:16px/1 system-ui,sans-serif; cursor:pointer; padding:0 2px; }
#ctrl-min:hover { color:#c4ccd6; }
#ctrl-body { padding:2px 12px 10px; max-height:clamp(220px, calc(100vh - 40px), 680px); overflow-y:auto; }
#ctrl.min #ctrl-body { display:none; } #ctrl.min #ctrl-bar { border-bottom:none; }
#ctrl .sec-head { display:flex; justify-content:space-between; align-items:center; cursor:pointer; margin:10px 0 4px; color:#8a93a3; }
#ctrl .sec-head .caret { font-size:10px; transition:transform .15s; } #ctrl .sec.collapsed .caret { transform:rotate(-90deg); } #ctrl .sec.collapsed .sec-body { display:none; }
#ctrl .row { margin:7px 0 1px; display:flex; justify-content:space-between; gap:8px; } #ctrl .row span:first-child { color:#c4ccd6; } #ctrl .row .value { color:#7f8a99; white-space:nowrap; }
#ctrl input[type=range] { width:100%; margin:0; accent-color:#86b9ff; }
#ctrl select, #ctrl button { background:#222831; color:#c4ccd6; border:1px solid #3a434f; border-radius:4px; padding:4px; font:12px system-ui,sans-serif; }
#ctrl select { width:100%; } #ctrl button { cursor:pointer; } #ctrl button:hover { border-color:#6386ad; color:#e4ebf4; } #ctrl button.active { background:#29405b; border-color:#6386ad; }
#ctrl .buttons { display:grid; grid-template-columns:repeat(3, 1fr); gap:5px; margin-top:5px; }
#ctrl .hint { margin-top:7px; color:#7f8a99; font-size:11px; }
#ctrl #event-list { color:#a8b4c2; min-height:16px; font:11px/1.45 ui-monospace, Consolas, monospace; }
#ctrl .numgrid { display:grid; grid-template-columns:repeat(3, 1fr); gap:4px; margin-top:3px; } #ctrl .numgrid input, #ctrl .full-input { min-width:0; box-sizing:border-box; width:100%; background:#222831; color:#c4ccd6; border:1px solid #3a434f; border-radius:4px; padding:4px; font:11px ui-monospace, Consolas, monospace; }
#ctrl #key-strip { position:relative; height:20px; margin:7px 2px 3px; border-radius:3px; background:linear-gradient(#2c3540,#20262e); border:1px solid #3a434f; } #ctrl .key-dot { position:absolute; top:2px; width:14px; height:14px; transform:translateX(-50%) rotate(45deg); padding:0; border-radius:2px; background:#6c7b8d; border-color:#98a6b7; } #ctrl .key-dot.selected { background:#6386ad; border-color:#b9d4f3; } #ctrl .key-dot.playing { background:#db7b5f; border-color:#ffd0a8; box-shadow:0 0 7px #e58b70; }
#ctrl #export-json { height:100px; resize:vertical; line-height:1.35; } #ctrl .disabled-note { color:#7f8a99; font-size:11px; margin:6px 0; }
`;

const HTML = `
<div id="wam-info">drag orbit &middot; scroll zoom &middot; weapon pose and sequence preview on the suite NPC</div>
<div id="wam-status">Loading weapon data&hellip;</div>
<aside id="ctrl">
  <div id="ctrl-bar"><span class="ttl">Weapon animation</span><button id="ctrl-min" aria-label="Minimize">&minus;</button></div>
  <div id="ctrl-body">
    <section class="sec"><div class="sec-head"><span>Animation</span><span class="caret">&#9662;</span></div><div class="sec-body">
      <div class="row"><span>Weapon</span></div><select id="weapon"></select>
      <div class="row"><span>Action</span></div><select id="action"></select>
      <div class="buttons"><button id="play">Play</button><button id="reset">Reset</button><button id="loop">Loop: on</button></div>
      <div class="row"><span>Timeline</span><span id="time-value" class="value">0.00 / 0.00 s</span></div><input id="timeline" type="range" min="0" max="1" step="0.01" value="0">
      <div class="row"><span>Speed</span><span id="speed-value" class="value">1.00x</span></div><input id="speed" type="range" min="0.25" max="2" step="0.05" value="1">
      <div class="hint" id="sequence-note">Idle and aim are continuous poses. Reload and knife-strike play authored/keyed sequences.</div>
    </div></section>
    <section class="sec"><div class="sec-head"><span>Author sequence</span><span class="caret">&#9662;</span></div><div class="sec-body">
      <div id="author-note" class="disabled-note">Select Reload sequence or Knife strike to edit a sequence.</div>
      <div id="author-fields">
        <div class="row"><span>Duration</span><input id="author-duration" class="full-input" type="number" min="0.05" step="0.01"></div>
        <div class="row"><span>Keyframe</span><span id="author-active" class="value">Active: —</span></div><select id="author-key"></select>
        <div id="key-strip" aria-label="Timeline keyframes"></div>
        <div class="buttons"><button id="key-add">Add key</button><button id="key-delete">Delete key</button><button id="pose-unique">Unique pose</button></div>
        <div class="row"><span>Key time</span><input id="author-time" class="full-input" type="number" min="0" step="0.01"></div>
        <div class="row"><span>Weapon position</span></div><div class="numgrid"><input id="pose-px" type="number" step="0.01" title="X"><input id="pose-py" type="number" step="0.01" title="Y"><input id="pose-pz" type="number" step="0.01" title="Z"></div>
        <div class="row"><span>Weapon rotation (rad)</span></div><div class="numgrid"><input id="pose-rx" type="number" step="0.01" title="Pitch"><input id="pose-ry" type="number" step="0.01" title="Yaw"><input id="pose-rz" type="number" step="0.01" title="Roll"></div>
        <div class="row"><span>Weapon scale</span><input id="pose-scale" class="full-input" type="number" min="0.01" step="0.01"></div>
        <div class="row"><span>Right hand</span></div><select id="right-ref"></select>
        <div class="row"><span>Left hand target</span></div><select id="left-mode"><option value="anchor">Weapon anchor</option><option value="body">Body offset</option></select>
        <select id="left-ref"></select><div id="left-body" class="numgrid"><input id="left-x" type="number" step="0.01" title="X"><input id="left-y" type="number" step="0.01" title="Y"><input id="left-z" type="number" step="0.01" title="Z"></div>
        <div class="row"><span>Event</span><input id="author-event" class="full-input" type="text" placeholder="e.g. meleeHit"></div>
        <div class="buttons"><button id="export-copy">Copy JSON</button><button id="export-download">Download JSON</button><button id="export-overwrite">Overwrite poses file</button><button id="export-refresh">Refresh export</button></div>
        <textarea id="export-json" class="full-input" readonly spellcheck="false"></textarea>
      </div>
      <div class="hint">Edits are held in this viewer. Copy or download the JSON to promote a reviewed sequence into <code>weapon-poses.json</code>.</div>
    </div></section>
    <section class="sec"><div class="sec-head"><span>Carry (stance &times; locomotion)</span><span class="caret">&#9662;</span></div><div class="sec-body">
      <div class="row"><span>Stance</span></div><select id="carry-stance"><option value="stand">Stand</option><option value="crouch">Crouch</option><option value="prone">Prone</option></select>
      <div class="row"><span>Locomotion</span></div><select id="carry-loco"></select>
      <div class="row"><span>Drive the body</span><input id="carry-drive" type="checkbox" checked></div>
      <div class="row"><span>Resolved hold</span><span id="carry-resolved" class="value">&mdash;</span></div>
      <div id="carry-edit">
        <div class="row"><span>Delta position</span></div><div class="numgrid"><input id="carry-px" type="number" step="0.01" title="X"><input id="carry-py" type="number" step="0.01" title="Y"><input id="carry-pz" type="number" step="0.01" title="Z"></div>
        <div class="row"><span>Delta rotation (rad)</span></div><div class="numgrid"><input id="carry-rx" type="number" step="0.01" title="Pitch: + is muzzle DOWN"><input id="carry-ry" type="number" step="0.01" title="Yaw: + swings across the body"><input id="carry-rz" type="number" step="0.01" title="Roll"></div>
        <div class="buttons"><button id="carry-reset">Reset entry</button><button id="carry-copy">Copy presets</button><button id="carry-refresh">Refresh</button></div>
        <textarea id="carry-json" class="full-input" readonly spellcheck="false"></textarea>
      </div>
      <div id="carry-note" class="disabled-note"></div>
      <div class="hint">Deltas are per weapon CLASS and stack on the authored stance hold. Stand/crouch/prone are edited SEPARATELY (Stance picks the bucket), blended by the rig's own weights. Paste the export into <code>CARRY_PRESETS</code> in <code>weapon-hold-resolver.js</code>.</div>
    </div></section>
    <section class="sec"><div class="sec-head"><span>Debug</span><span class="caret">&#9662;</span></div><div class="sec-body">
      <div class="row"><span>Show anchors</span><input id="anchors" type="checkbox" checked></div>
      <div class="row"><span>Knife tip trail</span><input id="trail" type="checkbox" checked></div>
      <div class="row"><span>Show grid</span><input id="grid" type="checkbox" checked></div>
      <div class="hint">Yellow = right grip; cyan = left grip; red = knife tip / muzzle reference.</div>
    </div></section>
    <section class="sec"><div class="sec-head"><span>Sequence events</span><span class="caret">&#9662;</span></div><div class="sec-body"><div id="event-list">No events yet.</div></div></section>
  </div>
</aside>
`;

export function createWeaponAnimMode(ctx) {
  const { THREE, scene, camera, controls, batches, npc } = ctx;
  let body = npc.body;   // live handle; re-pointed on a rebuild via the 'geometry' bus

  let dom = null, styleEl = null, ui = null, status = null, offGeo = null;
  let grid = null, tipLine = null, tipGeometry = null;
  const setStatus = (text) => { if (status) status.textContent = text; };

  // ---- mode-local state (ported) ----
  const bodyState = { id: 'animation-viewer', position: new THREE.Vector3(0, 0.9, 0), velocity: new THREE.Vector3(), onFloor: true, crouch: 0, prone: 0, height: 1.8, radius: 0.3, yaw: 0, aimPitch: 0, weapon: 'm1911', tool: 'm1911', alive: true };

  const CARRY_STANCES = ['stand', 'crouch', 'prone'];
  function cloneDelta(d) { return { position: [...d.position], rotation: [...d.rotation] }; }
  function deltasEqual(a, b) { return a.position.every((v, i) => v === b.position[i]) && a.rotation.every((v, i) => v === b.rotation[i]); }
  const carryEdits = Object.fromEntries(Object.entries(CARRY_PRESETS).map(([cls, kinds]) => [cls,
    Object.fromEntries(CARRY_STANCES.map((stance) => [stance,
      Object.fromEntries(Object.entries(kinds).map(([kind, d]) => [kind, cloneDelta(d)]))]))]));
  let carryStance = 'stand';
  let carryLoco = LOCOMOTION_IDLE;
  let carryDrive = true;
  const carryWeights = { crouch01: 0, prone01: 0 };
  const carryBlend = { position: [0, 0, 0], rotation: [0, 0, 0] };
  const carryHold = { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
  const CARRY_SPEEDS = { idle: 0, aim: 0, walk: 1.6, run: 3.6, dash: 4.6 };
  const CARRY_CIRCLE_RADIUS = 3.2;
  const STANCE_BLEND_RATE = 9;
  let carryAngle = 0, carrySpeed = 0, wasOneHanded = false;
  const _carryRight = new THREE.Vector3(), _carryFwd = new THREE.Vector3(), _carryHand = new THREE.Vector3();
  function carryClassOf(id) { return WEAPONS[id]?.carryClass || null; }
  function carryEntry() {
    const cls = carryClassOf(selectedWeapon);
    return cls && carryEdits[cls]?.[carryStance]?.[carryLoco] ? carryEdits[cls][carryStance][carryLoco] : null;
  }
  function carryHoldsFor(cls) {
    const stances = carryEdits[cls];
    return Object.fromEntries(Object.keys(stances.stand).map((kind) => [kind,
      { stand: stances.stand[kind], crouch: stances.crouch[kind], prone: stances.prone[kind] }]));
  }
  function carryDefFor(id) {
    const def = WEAPONS[id];
    const cls = carryClassOf(id);
    return cls ? { ...def, carryHolds: carryHoldsFor(cls) } : def;
  }

  let anchorData, alternateAnchorData, poseData;
  let mounted = null;
  let selectedWeapon = 'm1911';
  let action = 'idle';
  let playhead = 0, playing = false, looping = true, speed = 1;
  let events = [];
  let authoredSequence = null;
  let selectedKeyIndex = 0;
  let draggedKey = null;
  const templates = new Map();
  const tipHistory = [];

  const knifePreviewSequence = {
    duration: 0.78,
    poses: {
      knifeReady: { p: [0.20, -0.36, -0.54], r: [-0.08, -0.04, -0.02], scale: 1 },
      knifeWindup: { p: [0.08, -0.12, -0.40], r: [-0.86, -0.32, 0.48], scale: 1 },
      knifeStrike: { p: [0.34, -0.40, -0.92], r: [0.12, -0.02, -0.12], scale: 1 },
    },
    keys: [
      { t: 0, weaponPose: 'knifeReady', right: 'rightGrip', left: { body: [-0.15, -0.24, 0.18] } },
      { t: 0.25, weaponPose: 'knifeWindup', right: 'rightGrip', left: { body: [-0.17, -0.30, 0.14] }, event: 'windup' },
      { t: 0.43, weaponPose: 'knifeStrike', right: 'rightGrip', left: { body: [-0.18, -0.28, 0.22] }, event: 'meleeHit' },
      { t: 0.78, weaponPose: 'knifeReady', right: 'rightGrip', left: { body: [-0.15, -0.24, 0.18] }, event: 'recover' },
    ],
  };

  function normalizeWeaponModel(model, targetSize = 0.62) {
    const box = new THREE.Box3(), size = new THREE.Vector3();
    model.updateMatrixWorld(true); box.setFromObject(model); box.getSize(size);
    if (size.x >= size.y && size.x >= size.z) model.rotation.y = Math.PI * 0.5;
    else if (size.y >= size.x && size.y >= size.z) model.rotation.x = Math.PI * 0.5;
    model.updateMatrixWorld(true); box.setFromObject(model); box.getSize(size);
    model.scale.multiplyScalar(targetSize / Math.max(size.x, size.y, size.z, 1e-6)); model.updateMatrixWorld(true);
    box.setFromObject(model); model.position.sub(box.getCenter(new THREE.Vector3())); model.updateMatrixWorld(true);
    return model.matrixWorld.clone();
  }
  function bakeAnchors(rawAnchors, matrix) {
    const rotation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(matrix));
    const out = {};
    for (const [k, raw] of Object.entries(rawAnchors || {})) {
      const position = new THREE.Vector3(...raw.p).applyMatrix4(matrix);
      const quaternion = rotation.clone().multiply(new THREE.Quaternion(...(raw.q || [0, 0, 0, 1])));
      out[k] = { p: position.toArray(), q: quaternion.toArray() };
    }
    return out;
  }
  async function templateFor(id, def, rawAnchors) {
    if (!templates.has(id)) {
      templates.set(id, attachDracoLoader(new GLTFLoader()).loadAsync(def.model).then((gltf) => {
        const template = gltf.scene; const matrix = normalizeWeaponModel(template);
        template.traverse((part) => { if (part.isMesh) { part.castShadow = true; part.frustumCulled = false; } });
        return { template, anchors: bakeAnchors(rawAnchors, matrix) };
      }));
    }
    return templates.get(id);
  }
  function reloadDraft() {
    const poses = poseData?.weaponPoses || {};
    return {
      duration: 1.35, commitAmmoAt: 1.02,
      poses: { aimed: deepClone(poses.aimed), reloadRaise: deepClone(poses.reloadRaise) },
      keys: [
        { t: 0, weaponPose: 'aimed', right: 'rightGrip', left: 'leftGrip' },
        { t: 0.18, weaponPose: 'reloadRaise', right: 'rightGrip', left: 'magwell' },
        { t: 0.52, left: { body: [0.16, -0.30, 0.22] }, event: 'removeMagazine' },
        { t: 0.84, left: 'magwell', event: 'insertMagazine' },
        { t: 1.16, weaponPose: 'aimed', right: 'rightGrip', left: 'leftGrip', event: 'reloadComplete' },
      ],
    };
  }
  function sourceSequence() {
    if (action === 'reload') return poseData?.reloadSequence?.[selectedWeapon] || reloadDraft();
    if (action === 'knifeStrike') return knifePreviewSequence;
    return null;
  }
  function deepClone(value) { return value ? JSON.parse(JSON.stringify(value)) : null; }
  function beginAuthoring() { authoredSequence = deepClone(sourceSequence()); selectedKeyIndex = 0; playhead = 0; events = []; refreshAuthoringUi(); }
  function currentSequence() { return authoredSequence || sourceSequence(); }
  function duration() { return currentSequence()?.duration || 0; }
  function selectedKey() { return authoredSequence?.keys?.[selectedKeyIndex] || null; }
  function authoredPose(key, makeUnique = false) {
    if (!authoredSequence || !key) return null;
    authoredSequence.poses ||= {};
    const fallback = { p: [0.24, -0.42, -0.62], r: [-0.08, -0.04, -0.02], scale: 1 };
    if (!key.weaponPose) { key.weaponPose = `pose${authoredSequence.keys.indexOf(key) + 1}`; authoredSequence.poses[key.weaponPose] = deepClone(fallback); }
    const shared = authoredSequence.keys.some((other) => other !== key && other.weaponPose === key.weaponPose);
    if (makeUnique && shared) {
      const oldName = key.weaponPose;
      let n = 1, name = `${oldName}_key`;
      while (authoredSequence.poses[name + n]) n++;
      name += n; authoredSequence.poses[name] = deepClone(authoredSequence.poses[oldName] || fallback); key.weaponPose = name;
    }
    return authoredSequence.poses[key.weaponPose] ||= deepClone(fallback);
  }
  function sortKeys(keepKey = selectedKey()) {
    if (!authoredSequence) return;
    authoredSequence.keys.sort((a, b) => a.t - b.t);
    selectedKeyIndex = Math.max(0, authoredSequence.keys.indexOf(keepKey));
  }
  function anchorNames() { return Object.keys(mounted?.anchors || {}); }
  function setOptions(select, values, value) {
    select.replaceChildren(...values.map((entry) => Object.assign(document.createElement('option'), { value: entry, textContent: entry })));
    if (values.includes(value)) select.value = value;
  }
  function exportSequence() { const seq = currentSequence(); ui['export-json'].value = seq ? JSON.stringify({ [selectedWeapon]: seq }, null, 2) : ''; }
  function activeKeyIndex() {
    const keys = authoredSequence?.keys || []; if (!keys.length) return -1;
    let index = 0; for (let i = 1; i < keys.length; i++) { if (keys[i].t <= playhead + 1e-5) index = i; else break; }
    return index;
  }
  function updateActiveKeyIndicator() {
    if (!authoredSequence) { ui['author-active'].textContent = 'Active: —'; return; }
    const index = activeKeyIndex(), key = authoredSequence.keys[index];
    ui['author-active'].textContent = key ? `Active: ${index + 1} @ ${key.t.toFixed(2)} s` : 'Active: —';
    ui['key-strip'].querySelectorAll('.key-dot').forEach((dot, dotIndex) => dot.classList.toggle('playing', dotIndex === index));
  }
  function selectKey(index, pause = true) {
    if (!authoredSequence?.keys?.[index]) return;
    selectedKeyIndex = index; playhead = authoredSequence.keys[index].t; if (pause) playing = false;
    refreshAuthoringUi(); updateUi();
  }
  function renderKeyStrip() {
    ui['key-strip'].replaceChildren();
    const seq = authoredSequence; if (!seq?.keys?.length) return;
    const dur = Math.max(0.01, seq.duration || 0.01), active = activeKeyIndex();
    seq.keys.forEach((key, index) => {
      const dot = document.createElement('button'); dot.className = `key-dot${index === selectedKeyIndex ? ' selected' : ''}${index === active ? ' playing' : ''}`; dot.title = `Key ${index + 1}: ${key.t.toFixed(2)} s`;
      dot.style.left = `${THREE.MathUtils.clamp(key.t / dur, 0, 1) * 100}%`;
      dot.addEventListener('pointerdown', (event) => { event.preventDefault(); selectKey(index); draggedKey = key; ui['key-strip'].setPointerCapture(event.pointerId); });
      ui['key-strip'].appendChild(dot);
    });
  }
  function refreshAuthoringUi() {
    const editable = !!authoredSequence;
    ui['author-fields'].style.display = editable ? '' : 'none';
    ui['author-note'].style.display = editable ? 'none' : '';
    if (!editable) { ui['author-note'].textContent = 'Select Reload sequence or Knife strike to edit a sequence.'; ui['export-json'].value = ''; return; }
    const seq = authoredSequence, key = selectedKey();
    ui['author-duration'].value = seq.duration ?? 0;
    ui['author-key'].replaceChildren(...seq.keys.map((entry, index) => Object.assign(document.createElement('option'), { value: String(index), textContent: `Key ${index + 1} — ${entry.t.toFixed(2)} s${entry.event ? ` — ${entry.event}` : ''}` })));
    ui['author-key'].value = String(selectedKeyIndex);
    const names = anchorNames(); setOptions(ui['right-ref'], names, typeof key?.right === 'string' ? key.right : 'rightGrip');
    const leftIsBody = !!key?.left?.body; ui['left-mode'].value = leftIsBody ? 'body' : 'anchor'; setOptions(ui['left-ref'], names, typeof key?.left === 'string' ? key.left : 'leftGrip'); ui['left-ref'].style.display = leftIsBody ? 'none' : ''; ui['left-body'].style.display = leftIsBody ? 'grid' : 'none';
    if (key) {
      const pose = authoredPose(key); ui['author-time'].value = key.t; ui['pose-px'].value = pose.p[0]; ui['pose-py'].value = pose.p[1]; ui['pose-pz'].value = pose.p[2]; ui['pose-rx'].value = pose.r[0]; ui['pose-ry'].value = pose.r[1]; ui['pose-rz'].value = pose.r[2]; ui['pose-scale'].value = pose.scale ?? 1;
      const bodyOffset = key.left?.body || [0, 0, 0]; ui['left-x'].value = bodyOffset[0]; ui['left-y'].value = bodyOffset[1]; ui['left-z'].value = bodyOffset[2]; ui['author-event'].value = key.event || '';
    }
    renderKeyStrip(); exportSequence();
  }
  function rebuildActionOptions() {
    const previous = action;
    const opts = [{ value: 'idle', label: 'Idle / low ready' }, { value: 'aim', label: 'Aim pose' }];
    if (WEAPONS[selectedWeapon]?.mode !== 'melee') opts.push({ value: 'reload', label: poseData?.reloadSequence?.[selectedWeapon] ? 'Reload sequence' : 'New reload draft' });
    if (selectedWeapon === 'knife') opts.push({ value: 'knifeStrike', label: 'Knife strike (preview)' });
    ui.action.replaceChildren(...opts.map((opt) => Object.assign(document.createElement('option'), { value: opt.value, textContent: opt.label })));
    action = opts.some((opt) => opt.value === previous) ? previous : 'idle'; ui.action.value = action;
    const isReloadDraft = action === 'reload' && !poseData?.reloadSequence?.[selectedWeapon];
    ui['sequence-note'].textContent = action === 'knifeStrike'
      ? 'Viewer-only blocking pass: it uses the knife tip anchor and will not change gameplay until promoted into weapon-poses.json.'
      : isReloadDraft ? 'Starter reload draft: tune its keys, hands, and events, then export it into weapon-poses.json.'
      : duration() ? 'This sequence is evaluated by the same pose controller used in game.' : 'Idle and aim are continuous poses. Select a weapon with authored sequence data to scrub it.';
  }
  function marker(name, color, size = 0.035) {
    const obj = new THREE.Mesh(new THREE.SphereGeometry(size, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
    obj.name = `anchor:${name}`; obj.renderOrder = 10; return obj;
  }
  async function mountWeapon(id) {
    const def = WEAPONS[id]; if (!def?.model) return;
    const request = Symbol(id); mountWeapon.request = request;
    selectedWeapon = id; bodyState.weapon = id; bodyState.tool = id; playhead = 0; playing = false; events = []; authoredSequence = null; selectedKeyIndex = 0; tipHistory.length = 0;
    const rawAnchors = { ...(anchorData?.[id]?.ikAnchors || {}) };
    if (id === 'knife') Object.assign(rawAnchors, alternateAnchorData?.knife?.ikAnchors || {});
    setStatus(`Loading ${def.displayName}…`);
    const { template, anchors } = await templateFor(id, def, rawAnchors);
    if (mountWeapon.request !== request) return;
    if (mounted) { scene.remove(mounted.rig); scene.remove(mounted.markerGroup); }
    const rig = new THREE.Group(), adjust = new THREE.Group(), frame = new THREE.Group(), view = new THREE.Group();
    frame.rotation.y = Math.PI; rig.add(adjust); adjust.add(frame); frame.add(view);
    const model = skeletonClone(template); view.add(model); scene.add(rig);
    const markerGroup = new THREE.Group(); markerGroup.name = 'anchor-markers'; scene.add(markerGroup);
    const markerEntries = [];
    for (const [name, data] of Object.entries(rawAnchors)) {
      const color = name === 'rightGrip' ? 0xffd65a : name === 'leftGrip' ? 0x61e8ff : name === 'knife-tip' || name === 'muzzle' ? 0xff756d : 0xb3bac5;
      const dot = marker(name, color, name === 'knife-tip' || name === 'muzzle' ? 0.045 : 0.03);
      dot.quaternion.fromArray(data.q || [0, 0, 0, 1]); markerGroup.add(dot);
      markerEntries.push({ dot, rawPosition: new THREE.Vector3().fromArray(data.p) });
    }
    const sequenceDef = () => ({ id, recoil: def.recoil || 0, ikAnchors: anchors, weaponPoses: poseData?.weaponPoses || {}, reloadSequence: currentSequence() });
    const controller = createWeaponPoseController({ THREE, body, weaponView: view, getWeaponDef: sequenceDef, onEvent: (name, payload) => { events.unshift(`${payload.t.toFixed(2)} s  ${name}`); events = events.slice(0, 6); } });
    controller.setWeapon(id);
    mounted = { id, def, rig, adjust, view, model, controller, anchors, markerGroup, markerEntries, tipMarker: markerGroup.getObjectByName('anchor:knife-tip') || markerGroup.getObjectByName('anchor:muzzle') };
    rebuildActionOptions(); refreshAuthoringUi(); refreshCarryUi(); updateUi(); setStatus(`${def.displayName}\n${Object.keys(anchors).length} anchors loaded${id === 'knife' ? ' (including weapon-anchors-b knife anchors)' : ''}`);
  }
  function updateUi() {
    const dur = duration(); ui.timeline.max = String(Math.max(dur, 0.01)); ui.timeline.value = String(Math.min(playhead, dur || 0));
    ui['time-value'].textContent = `${playhead.toFixed(2)} / ${dur.toFixed(2)} s`; ui['speed-value'].textContent = `${speed.toFixed(2)}x`;
    ui.play.textContent = playing ? 'Pause' : 'Play'; ui.play.classList.toggle('active', playing); ui.loop.textContent = `Loop: ${looping ? 'on' : 'off'}`; ui.loop.classList.toggle('active', looping);
    ui['event-list'].textContent = events.length ? events.join('\n') : 'No events yet.';
    const h = carryHold;
    ui['carry-resolved'].textContent = `${carryClassOf(selectedWeapon) || 'no class'} · ${carryStance} · p ${h.position.map((v) => v.toFixed(2)).join(',')}`;
    updateActiveKeyIndicator();
  }
  function updateMarkerWorlds() {
    if (!mounted) return;
    mounted.markerGroup.visible = ui.anchors.checked;
    if (!mounted.markerGroup.visible) return;
    mounted.model.updateWorldMatrix(true, false);
    for (const entry of mounted.markerEntries) entry.dot.position.copy(mounted.model.localToWorld(entry.rawPosition.clone()));
  }
  function updateTrail() {
    if (!mounted?.tipMarker || !ui.trail.checked || selectedWeapon !== 'knife') { tipLine.visible = false; return; }
    const point = mounted.tipMarker.getWorldPosition(new THREE.Vector3());
    if (!tipHistory.length || tipHistory.at(-1).distanceToSquared(point) > 0.0001) tipHistory.push(point.clone());
    if (tipHistory.length > 40) tipHistory.shift();
    tipLine.visible = tipHistory.length > 1;
    if (tipLine.visible) tipGeometry.setFromPoints(tipHistory);
  }
  function driveCarryLocomotion(dt) {
    const ease = (cur, target) => cur + (target - cur) * (1 - Math.exp(-STANCE_BLEND_RATE * dt));
    carryWeights.crouch01 = ease(carryWeights.crouch01, carryStance === 'crouch' ? 1 : 0);
    carryWeights.prone01 = ease(carryWeights.prone01, carryStance === 'prone' ? 1 : 0);
    bodyState.crouch = carryWeights.crouch01;
    bodyState.prone = carryWeights.prone01;
    stepCarryBlend(carryBlend, carryDeltaFor(carryDefFor(selectedWeapon), carryLoco, carryWeights), dt, CARRY_BLEND_RATE);
    const want = carryDrive ? (CARRY_SPEEDS[carryLoco] ?? 0) : 0;
    carrySpeed = ease(carrySpeed, want);
    if (carrySpeed < 0.02) { bodyState.velocity.set(0, 0, 0); return; }
    carryAngle += (carrySpeed / CARRY_CIRCLE_RADIUS) * dt;
    const px = Math.cos(carryAngle) * CARRY_CIRCLE_RADIUS, pz = Math.sin(carryAngle) * CARRY_CIRCLE_RADIUS;
    const vx = -Math.sin(carryAngle) * carrySpeed, vz = Math.cos(carryAngle) * carrySpeed;
    bodyState.position.set(px, 0.9, pz);
    bodyState.velocity.set(vx, 0, vz);
    bodyState.yaw = Math.atan2(vx, vz);
  }

  // ---- authoring event wiring (ported; called once after DOM inject) ----
  function changedAuthoring(mutator) { if (!authoredSequence) return; const key = selectedKey(); mutator(key); refreshAuthoringUi(); updateUi(); }
  function numberValue(input, fallback = 0) { const value = Number(input.value); return Number.isFinite(value) ? value : fallback; }
  function exportCarryPresets() {
    const fmt = (v) => Number(v.toFixed(3));
    const fmtDelta = (d) => `{ position: Object.freeze([${d.position.map(fmt).join(', ')}]), rotation: Object.freeze([${d.rotation.map(fmt).join(', ')}]) }`;
    const rowsOut = Object.entries(carryEdits).map(([cls, stances]) => {
      const rows = Object.keys(stances.stand).map((kind) => {
        const stand = stances.stand[kind], crouch = stances.crouch[kind], prone = stances.prone[kind];
        if (deltasEqual(stand, crouch) && deltasEqual(stand, prone)) return `    ${kind}: Object.freeze(${fmtDelta(stand)}),`;
        return `    ${kind}: Object.freeze({ stand: Object.freeze(${fmtDelta(stand)}), crouch: Object.freeze(${fmtDelta(crouch)}), prone: Object.freeze(${fmtDelta(prone)}) }),`;
      });
      return `  ${cls}: Object.freeze({\n${rows.join('\n')}\n  }),`;
    });
    ui['carry-json'].value = `export const CARRY_PRESETS = Object.freeze({\n${rowsOut.join('\n')}\n});`;
  }
  function refreshCarryUi() {
    const cls = carryClassOf(selectedWeapon);
    const entry = carryEntry();
    ui['carry-edit'].style.display = entry ? '' : 'none';
    ui['carry-note'].textContent = cls
      ? (entry ? '' : `${CARRY_LABELS[carryLoco] || carryLoco} carries no delta — it is the authored stance hold itself.`)
      : `${WEAPONS[selectedWeapon]?.displayName || selectedWeapon} declares no carryClass, so it keeps its stance hold in every locomotion state.`;
    if (entry) {
      for (const [id, ch, i] of [['carry-px', 'position', 0], ['carry-py', 'position', 1], ['carry-pz', 'position', 2],
        ['carry-rx', 'rotation', 0], ['carry-ry', 'rotation', 1], ['carry-rz', 'rotation', 2]]) {
        if (document.activeElement !== ui[id]) ui[id].value = entry[ch][i].toFixed(3);
      }
      exportCarryPresets();
    }
  }
  const CARRY_LABELS = { idle: 'Idle (stance hold)', walk: 'Walk carry', run: 'Run carry', dash: 'Dash carry (one-handed)', aim: 'Aim (stance hold)' };
  function mergeSequenceIntoPoseFile(file) {
    if (!authoredSequence) throw new Error('Select an editable sequence first.');
    if (action === 'reload') { file.reloadSequence ||= {}; file.reloadSequence[selectedWeapon] = deepClone(authoredSequence); return `reloadSequence.${selectedWeapon}`; }
    if (action === 'knifeStrike') { file.meleeSequence ||= {}; file.meleeSequence[selectedWeapon] = deepClone(authoredSequence); return `meleeSequence.${selectedWeapon}`; }
    throw new Error('Only authored sequences can be saved.');
  }

  function wireEvents() {
    ui['author-key'].addEventListener('change', () => selectKey(Number(ui['author-key'].value)));
    ui['author-duration'].addEventListener('change', () => changedAuthoring(() => {
      authoredSequence.duration = Math.max(0.05, numberValue(ui['author-duration'], authoredSequence.duration));
      for (const entry of authoredSequence.keys) entry.t = Math.min(entry.t, authoredSequence.duration);
      sortKeys();
    }));
    ui['author-time'].addEventListener('change', () => changedAuthoring((key) => {
      key.t = THREE.MathUtils.clamp(numberValue(ui['author-time'], key.t), 0, authoredSequence.duration);
      sortKeys(key); playhead = key.t;
    }));
    const poseInputs = [['pose-px', 'p', 0], ['pose-py', 'p', 1], ['pose-pz', 'p', 2], ['pose-rx', 'r', 0], ['pose-ry', 'r', 1], ['pose-rz', 'r', 2], ['pose-scale', 'scale', null]];
    for (const [id, channel, index] of poseInputs) ui[id].addEventListener('change', () => changedAuthoring((key) => {
      const pose = authoredPose(key, true); const fallback = index == null ? pose.scale : pose[channel][index]; const value = numberValue(ui[id], fallback);
      if (index == null) pose.scale = Math.max(0.01, value); else pose[channel][index] = value;
    }));
    ui['right-ref'].addEventListener('change', () => changedAuthoring((key) => { key.right = ui['right-ref'].value; }));
    ui['left-mode'].addEventListener('change', () => changedAuthoring((key) => { key.left = ui['left-mode'].value === 'body' ? { body: [0, 0, 0] } : (ui['left-ref'].value || 'leftGrip'); }));
    ui['left-ref'].addEventListener('change', () => changedAuthoring((key) => { key.left = ui['left-ref'].value; }));
    for (const [id, index] of [['left-x', 0], ['left-y', 1], ['left-z', 2]]) ui[id].addEventListener('change', () => changedAuthoring((key) => { key.left ||= { body: [0, 0, 0] }; if (!key.left.body) key.left = { body: [0, 0, 0] }; key.left.body[index] = numberValue(ui[id], key.left.body[index]); }));
    ui['author-event'].addEventListener('change', () => changedAuthoring((key) => { const event = ui['author-event'].value.trim(); if (event) key.event = event; else delete key.event; }));
    ui['key-add'].addEventListener('click', () => changedAuthoring((key) => {
      const next = deepClone(key || { t: 0, weaponPose: 'lowReady', right: 'rightGrip', left: 'leftGrip' }); next.t = Math.min(authoredSequence.duration, (key?.t || 0) + 0.10); delete next.event; authoredSequence.keys.push(next); authoredPose(next, true); sortKeys(next); playhead = next.t;
    }));
    ui['key-delete'].addEventListener('click', () => changedAuthoring((key) => { if (authoredSequence.keys.length < 2) return; authoredSequence.keys.splice(authoredSequence.keys.indexOf(key), 1); selectedKeyIndex = Math.max(0, selectedKeyIndex - 1); }));
    ui['pose-unique'].addEventListener('click', () => changedAuthoring((key) => { authoredPose(key, true); }));
    ui['key-strip'].addEventListener('pointermove', (event) => { if (!draggedKey || !authoredSequence) return; const rect = ui['key-strip'].getBoundingClientRect(); draggedKey.t = THREE.MathUtils.clamp((event.clientX - rect.left) / rect.width, 0, 1) * authoredSequence.duration; sortKeys(draggedKey); playhead = draggedKey.t; refreshAuthoringUi(); updateUi(); });
    ui['key-strip'].addEventListener('pointerup', (event) => { draggedKey = null; if (ui['key-strip'].hasPointerCapture(event.pointerId)) ui['key-strip'].releasePointerCapture(event.pointerId); });

    ui['carry-loco'].replaceChildren(...LOCOMOTION_KINDS.map((kind) => Object.assign(document.createElement('option'), { value: kind, textContent: CARRY_LABELS[kind] || kind })));
    ui['carry-loco'].value = carryLoco;
    for (const [id, channel, index] of [['carry-px', 'position', 0], ['carry-py', 'position', 1], ['carry-pz', 'position', 2],
      ['carry-rx', 'rotation', 0], ['carry-ry', 'rotation', 1], ['carry-rz', 'rotation', 2]]) {
      ui[id].addEventListener('input', () => { const e = carryEntry(); if (e) { e[channel][index] = numberValue(ui[id], e[channel][index]); exportCarryPresets(); } });
    }
    ui['carry-stance'].addEventListener('change', () => { carryStance = ui['carry-stance'].value; });
    ui['carry-loco'].addEventListener('change', () => { carryLoco = ui['carry-loco'].value; refreshCarryUi(); });
    ui['carry-drive'].addEventListener('change', () => { carryDrive = ui['carry-drive'].checked; });
    ui['carry-reset'].addEventListener('click', () => {
      const cls = carryClassOf(selectedWeapon), preset = cls && CARRY_PRESETS[cls]?.[carryLoco];
      if (!preset) return;
      carryEdits[cls][carryStance][carryLoco] = cloneDelta(preset);
      refreshCarryUi(); setStatus(`Reset ${cls} ${carryStance} ${carryLoco} carry to the shipped preset.`);
    });
    ui['carry-refresh'].addEventListener('click', () => { refreshCarryUi(); });
    ui['carry-copy'].addEventListener('click', async () => {
      exportCarryPresets();
      try { await navigator.clipboard.writeText(ui['carry-json'].value); setStatus('CARRY_PRESETS copied — paste over the block in weapon-hold-resolver.js.'); }
      catch { ui['carry-json'].focus(); ui['carry-json'].select(); setStatus('Clipboard unavailable — presets selected for manual copy.'); }
    });
    ui['export-refresh'].addEventListener('click', exportSequence);
    ui['export-copy'].addEventListener('click', async () => { exportSequence(); try { await navigator.clipboard.writeText(ui['export-json'].value); setStatus('Sequence JSON copied to clipboard.'); } catch { ui['export-json'].focus(); ui['export-json'].select(); setStatus('Clipboard unavailable — JSON selected for manual copy.'); } });
    ui['export-download'].addEventListener('click', () => { exportSequence(); const blob = new Blob([ui['export-json'].value + '\n'], { type: 'application/json' }); const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${selectedWeapon}-${action}-sequence.json` }); link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0); });
    ui['export-overwrite'].addEventListener('click', async () => {
      if (!window.showOpenFilePicker) { setStatus('This browser cannot grant file-write access. Use Download JSON instead.'); return; }
      if (!confirm('Choose weapon-poses.json, then overwrite that selected file with this edited sequence merged into it?')) return;
      try {
        const [handle] = await window.showOpenFilePicker({ multiple: false, types: [{ description: 'Weapon poses JSON', accept: { 'application/json': ['.json'] } }] });
        if (handle.name !== 'weapon-poses.json') throw new Error('Choose weapon-poses.json; no file was changed.');
        const file = JSON.parse(await (await handle.getFile()).text());
        const path = mergeSequenceIntoPoseFile(file);
        const writable = await handle.createWritable();
        await writable.write(JSON.stringify(file, null, 2) + '\n');
        await writable.close();
        poseData = file;
        rebuildActionOptions(); refreshAuthoringUi(); exportSequence();
        setStatus(`Saved ${path} into weapon-poses.json.`);
      } catch (error) { if (error.name !== 'AbortError') setStatus(`Save failed: ${error.message}`); }
    });
    ui.weapon.addEventListener('change', () => void mountWeapon(ui.weapon.value));
    ui.action.addEventListener('change', () => { action = ui.action.value; playhead = 0; playing = false; events = []; tipHistory.length = 0; authoredSequence = null; rebuildActionOptions(); if (sourceSequence()) beginAuthoring(); else refreshAuthoringUi(); updateUi(); });
    ui.play.addEventListener('click', () => { if (duration() > 0) playing = !playing; updateUi(); });
    ui.reset.addEventListener('click', () => { playhead = 0; playing = false; events = []; tipHistory.length = 0; updateUi(); });
    ui.loop.addEventListener('click', () => { looping = !looping; updateUi(); });
    ui.timeline.addEventListener('input', () => { playhead = Number(ui.timeline.value); playing = false; tipHistory.length = 0; updateUi(); });
    ui.speed.addEventListener('input', () => { speed = Number(ui.speed.value); updateUi(); });
    dom.querySelectorAll('.sec-head').forEach((head) => head.addEventListener('click', () => head.parentElement.classList.toggle('collapsed')));
    ui['ctrl-min'].addEventListener('click', () => { ui.ctrl.classList.toggle('min'); ui['ctrl-min'].textContent = ui.ctrl.classList.contains('min') ? '+' : '−'; });
    let drag = null; ui['ctrl-bar'].addEventListener('pointerdown', (event) => { if (event.target === ui['ctrl-min']) return; const rect = ui.ctrl.getBoundingClientRect(); drag = { x: event.clientX - rect.left, y: event.clientY - rect.top }; ui['ctrl-bar'].setPointerCapture(event.pointerId); });
    ui['ctrl-bar'].addEventListener('pointermove', (event) => { if (!drag) return; ui.ctrl.style.right = 'auto'; ui.ctrl.style.left = `${Math.max(8, Math.min(innerWidth - ui.ctrl.offsetWidth - 8, event.clientX - drag.x))}px`; ui.ctrl.style.top = `${Math.max(8, Math.min(innerHeight - ui.ctrl.offsetHeight - 8, event.clientY - drag.y))}px`; });
    ui['ctrl-bar'].addEventListener('pointerup', (event) => { drag = null; ui['ctrl-bar'].releasePointerCapture(event.pointerId); });
  }

  // ===================== the mode contract =====================
  return {
    drivesMotion: true,
    async init() {
      // Inject the tool's own floating panel + CSS as mode-owned DOM.
      styleEl = document.createElement('style'); styleEl.textContent = CSS; document.head.appendChild(styleEl);
      dom = document.createElement('div'); dom.id = 'wam-root'; dom.innerHTML = HTML; document.body.appendChild(dom);
      const ids = ['weapon', 'action', 'play', 'reset', 'loop', 'timeline', 'time-value', 'speed', 'speed-value', 'anchors', 'trail', 'grid', 'sequence-note', 'event-list', 'ctrl', 'ctrl-bar', 'ctrl-min', 'author-note', 'author-fields', 'author-active', 'author-duration', 'author-key', 'key-strip', 'key-add', 'key-delete', 'pose-unique', 'author-time', 'pose-px', 'pose-py', 'pose-pz', 'pose-rx', 'pose-ry', 'pose-rz', 'pose-scale', 'right-ref', 'left-mode', 'left-ref', 'left-body', 'left-x', 'left-y', 'left-z', 'author-event', 'export-copy', 'export-download', 'export-overwrite', 'export-refresh', 'export-json', 'carry-stance', 'carry-loco', 'carry-drive', 'carry-resolved', 'carry-edit', 'carry-note', 'carry-json', 'carry-px', 'carry-py', 'carry-pz', 'carry-rx', 'carry-ry', 'carry-rz', 'carry-reset', 'carry-copy', 'carry-refresh'];
      ui = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
      status = document.getElementById('wam-status');

      // Mode-owned debug grid + knife-tip trail line (the shell owns the floor + lights).
      grid = new THREE.GridHelper(12, 24, 0x566272, 0x343b45); grid.position.y = 0.002; scene.add(grid);
      tipGeometry = new THREE.BufferGeometry();
      tipLine = new THREE.Line(tipGeometry, new THREE.LineBasicMaterial({ color: 0xff756d, transparent: true, opacity: 0.9 })); tipLine.visible = false; scene.add(tipLine);

      // Default framing for this mode (the shell restores per-mode framing on re-entry).
      camera.position.set(4.4, 3.1, 5.2); controls.target.set(0, 1.05, 0); controls.update();

      wireEvents();
      offGeo = ctx.on('geometry', () => { body = npc.body; if (mounted) void mountWeapon(selectedWeapon); });

      try {
        [anchorData, alternateAnchorData, poseData] = await Promise.all([
          fetch('./weapon-anchors.json', { cache: 'no-store' }).then((r) => r.json()),
          fetch('./weapon-anchors-b.json', { cache: 'no-store' }).then((r) => r.json()),
          fetch('./weapon-poses.json', { cache: 'no-store' }).then((r) => r.json()),
        ]);
        for (const weapon of Object.values(WEAPONS).filter((def) => def.model && def.thirdPersonHold)) ui.weapon.appendChild(Object.assign(document.createElement('option'), { value: weapon.id, textContent: weapon.displayName }));
        ui.weapon.value = selectedWeapon; await mountWeapon(selectedWeapon);
      } catch (error) { console.error(error); setStatus(`Could not load viewer assets: ${error.message}`); }
    },
    tick(dt) {
      driveCarryLocomotion(dt);
      body.update(dt, bodyState);
      if (mounted) {
        const torso = body.joints.torso;
        const motion = body.motion;
        const hold = resolveWeaponHold(carryDefFor(selectedWeapon), carryWeights, carryBlend, carryHold);
        const yawOnly = motion.visualYaw ?? bodyState.yaw;
        const gaitW = 1 - carryWeights.prone01;
        const sway = (motion.sway ?? 0) * gaitW;
        mounted.rig.position.set(
          (motion.bodyPosition?.x ?? bodyState.position.x) + Math.cos(yawOnly) * sway,
          1.5 + (motion.bob ?? 0) * gaitW,
          (motion.bodyPosition?.z ?? bodyState.position.z) - Math.sin(yawOnly) * sway,
        );
        mounted.rig.rotation.set(0, yawOnly + (motion.headYaw ?? 0), 0);
        mounted.adjust.position.fromArray(hold.position); mounted.adjust.rotation.set(...hold.rotation); mounted.adjust.scale.setScalar(hold.scale ?? 1);
        mounted.rig.updateMatrixWorld(true);
        const dur = duration();
        if (playing && dur > 0) { playhead += dt * speed; if (playhead >= dur) { if (looping) { playhead %= dur; tipHistory.length = 0; } else { playhead = dur; playing = false; } } }
        if (action === 'aim') { mounted.controller.setAiming(1); mounted.controller.update(dt, { action: 'idle', actionTime: 0 }); }
        else if (dur > 0) { mounted.controller.setAiming(0); mounted.controller.update(dt, { action: 'reload', actionTime: playhead }); }
        else { mounted.controller.setAiming(0); mounted.controller.update(dt, { action: 'idle', actionTime: 0 }); }
        const oneHanded = isOneHanded(carryLoco) && !!carryClassOf(selectedWeapon);
        if (oneHanded) {
          _carryRight.set(1, 0, 0).applyQuaternion(torso.quaternion);
          _carryFwd.set(0, 0, 1).applyQuaternion(torso.quaternion);
          _carryHand.copy(torso.position).addScaledVector(_carryFwd, 0.16).addScaledVector(_carryRight, -0.14);
          _carryHand.y -= 0.04;
          body.setArmTarget('left', { position: _carryHand, weight: 1 });
        } else if (wasOneHanded) body.setArmTarget('left', null);
        wasOneHanded = oneHanded;
        updateMarkerWorlds();
        updateTrail();
      }
      if (grid) grid.visible = ui.grid.checked;
      updateUi();
      body.flush(batches);   // instanced NPC: flush inside the shell's begin/endFrame bracket
    },
    dispose() {
      offGeo?.();
      if (mounted) { scene.remove(mounted.rig); scene.remove(mounted.markerGroup); mounted = null; }
      if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); grid = null; }
      if (tipLine) { scene.remove(tipLine); tipGeometry.dispose(); tipLine.material.dispose(); tipLine = null; }
      // Any left-arm IK target this mode set must be released, or the NPC keeps reaching in the next mode.
      body?.setArmTarget?.('left', null);
      dom?.remove(); dom = null;
      styleEl?.remove(); styleEl = null;
      ui = null; status = null;
    },
  };
}
