import * as THREE from 'three';
import { createPortCreatureSystem } from './port-creature-system.js';

const CREATURE_UI_STYLE = `
  :root {
    --pc-panel: rgba(25, 29, 36, 0.86);
    --pc-line: rgba(255,255,255,0.12);
    --pc-text: #d8dee9;
    --pc-muted: #8d97a8;
    --pc-accent: #77c8a1;
  }
  #creature-toolbar {
    position: fixed;
    top: 12px;
    left: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px;
    border: 1px solid var(--pc-line);
    background: var(--pc-panel);
    backdrop-filter: blur(10px);
    border-radius: 8px;
    color: var(--pc-text);
    font-size: 12px;
    user-select: none;
    z-index: 4;
    font-family: system-ui, -apple-system, Segoe UI, sans-serif;
  }
  #creature-toolbar label, #options label {
    display: grid;
    grid-template-columns: auto;
    gap: 3px;
    color: var(--pc-muted);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  #creature-toolbar select,
  #creature-toolbar button,
  #creature-toolbar input[type="range"],
  #creature-toolbar input[type="number"],
  #optionsPanel select,
  #optionsPanel button,
  #optionsPanel input,
  #modelPanel select,
  #modelPanel button,
  #modelPanel input,
  #inspector button,
  #configPanel button {
    border: 1px solid var(--pc-line);
    border-radius: 6px;
    background: #20252d;
    color: var(--pc-text);
    font: 12px system-ui, sans-serif;
  }
  #creature-toolbar select { min-width: 112px; height: 28px; padding: 0 24px 0 8px; }
  #creature-toolbar button { min-width: 32px; height: 28px; padding: 0 7px; cursor: pointer; }
  #creature-toolbar input[type="number"] {
    width: 70px;
    height: 24px;
    padding: 0 6px;
  }
  #creature-toolbar .toggle {
    display: flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 8px;
    border: 1px solid var(--pc-line);
    border-radius: 6px;
    background: #20252d;
    color: var(--pc-text);
    font-size: 12px;
    text-transform: none;
    letter-spacing: 0;
  }
  #creature-toolbar .toggle input { accent-color: var(--pc-accent); margin: 0; }
  .creature-panel {
    position: fixed;
    border: 1px solid var(--pc-line);
    border-radius: 8px;
    background: var(--pc-panel);
    backdrop-filter: blur(10px);
    color: var(--pc-text);
    font: 12px system-ui, sans-serif;
    user-select: none;
    z-index: 3;
  }
  .creature-panel .panel-head {
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0 8px 0 10px;
    border-bottom: 1px solid var(--pc-line);
    cursor: move;
    font-size: 12px;
    font-weight: 650;
  }
  .creature-panel .panel-head button {
    width: 24px;
    height: 22px;
    line-height: 1;
  }
  .creature-panel .panel-body { padding: 10px; }
  .creature-panel.minimized .panel-body { display: none !important; }
  .creature-panel.minimized { height: 30px !important; overflow: hidden !important; }
  #optionsPanel {
    top: 70px;
    left: 12px;
    width: 334px;
  }
  #options {
    display: grid;
    grid-template-columns: repeat(2, minmax(128px, 1fr));
    gap: 8px 10px;
  }
  #modelPanel {
    top: 70px;
    left: 352px;
    width: 292px;
    max-height: calc(100vh - 96px);
    overflow: auto;
  }
  #modelOptions {
    display: grid;
    grid-template-columns: repeat(2, minmax(116px, 1fr));
    gap: 8px 10px;
  }
  #modelOptions label {
    display: grid;
    gap: 3px;
    color: var(--pc-muted);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  #configPanel {
    left: 12px;
    bottom: 12px;
    width: min(620px, calc(100vw - 24px));
    display: none;
    background: rgba(20, 23, 29, 0.94);
    z-index: 5;
  }
  #configText {
    width: 100%;
    height: 136px;
    box-sizing: border-box;
    padding: 10px;
    border: 1px solid var(--pc-line);
    border-radius: 6px;
    background: #151920;
    color: var(--pc-text);
    font: 12px/1.35 ui-monospace, SFMono-Regular, Consolas, monospace;
  }
  #inspector {
    top: 70px;
    right: 12px;
    display: none;
    width: 340px;
    max-height: calc(100vh - 96px);
    overflow: auto;
    z-index: 4;
  }
  #inspector h2 {
    margin: 0 0 8px;
    font-size: 13px;
    font-weight: 650;
  }
  #inspectorSummary {
    color: var(--pc-muted);
    font-size: 11px;
    line-height: 1.45;
    margin-bottom: 8px;
  }
  #inspectorActions {
    display: flex;
    gap: 6px;
    margin-bottom: 8px;
  }
  #inspectorActions button {
    width: auto;
    padding: 0 9px;
  }
  #selectedConfig {
    width: 100%;
    height: 220px;
    box-sizing: border-box;
    resize: vertical;
    padding: 8px;
    border: 1px solid var(--pc-line);
    border-radius: 6px;
    background: #151920;
    color: var(--pc-text);
    font: 11px/1.35 ui-monospace, SFMono-Regular, Consolas, monospace;
  }
  #options .readout {
    justify-self: end;
    color: var(--pc-text);
    font-size: 11px;
    text-transform: none;
    letter-spacing: 0;
  }
  .control-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .numeric-control {
    display: grid;
    grid-template-columns: 1fr 74px;
    gap: 6px;
    align-items: center;
  }
  .rand-row { display: flex; align-items: flex-start; gap: 6px; }
  .rand-stack {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    position: relative;
  }
  .rand-stack input.rand-range {
    width: 32px;
    height: 18px;
    padding: 0 2px;
    text-align: center;
    font-size: 10px;
    border: 1px solid var(--pc-line);
    border-radius: 4px;
    background: #20252d;
    color: var(--pc-muted);
  }
  .rand-stack input.rand-range:focus { color: var(--pc-text); outline: none; border-color: rgba(119, 200, 161, 0.5); }
  .rand-menu {
    position: absolute;
    top: 100%;
    left: 0;
    margin-top: 6px;
    display: none;
    flex-direction: column;
    gap: 4px;
    padding: 8px;
    max-height: 70vh;
    overflow-y: auto;
    border: 1px solid var(--pc-line);
    border-radius: 8px;
    background: var(--pc-panel);
    backdrop-filter: blur(10px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    z-index: 50;
  }
  .rand-menu.open { display: flex; }
  .rand-menu-head {
    font-size: 9px;
    color: var(--pc-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--pc-line);
    margin-bottom: 2px;
  }
  .rand-param {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .rand-param .rand-pbtn { width: 30px; height: 30px; flex: none; font-weight: 650; }
  .rand-pmeta { display: flex; flex-direction: column; gap: 2px; }
  .rand-label {
    font-size: 9px;
    color: var(--pc-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .rand-fields { display: flex; gap: 4px; }
  #creatureScope {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 0;
    padding: 8px;
    border: 1px solid var(--pc-line);
    border-radius: 8px;
    background: var(--pc-panel);
    color: var(--pc-muted);
    font: 12px system-ui, sans-serif;
  }
  #creatureScope .scope-buttons {
    display: flex;
    border: 1px solid var(--pc-line);
    border-radius: 6px;
    overflow: hidden;
    flex: none;
  }
  #creatureScope button {
    height: 28px;
    padding: 0 10px;
    border: 0;
    border-right: 1px solid var(--pc-line);
    border-radius: 0;
    background: #20252d;
    color: var(--pc-text);
    cursor: pointer;
  }
  #creatureScope button:last-child { border-right: 0; }
  #creatureScope button.active { background: rgba(119, 200, 161, 0.18); color: var(--pc-text); }
  #creatureScope button:disabled { opacity: 0.45; cursor: default; }
  #creatureScope .scope-status { min-width: 0; }
`;

const CREATURE_UI_HTML = `
  <div id="creature-toolbar">
    <label>Preset
      <select id="preset"></select>
    </label>
    <label>Gait
      <select id="gait"></select>
    </label>
    <label>Count
      <input id="count" type="number" value="6" min="1" step="1">
    </label>
    <label>Objects
      <input id="objectCount" type="number" value="10" min="0" step="1">
    </label>
    <label>Team Size
      <input id="teamSize" type="number" value="3" min="1" step="1">
    </label>
    <label>Mode
      <select id="behavior">
        <option value="wander" selected>Wander</option>
        <option value="stay">Stay Still</option>
        <option value="target">Target Follow</option>
        <option value="follow">Follow Me</option>
        <option value="direction">Direction Walk</option>
        <option value="forage">Forage</option>
        <option value="combat">Combat</option>
        <option value="race">Race</option>
      </select>
    </label>
    <label>Scene
      <select id="sceneMode">
        <option value="uniform" selected>Uniform</option>
        <option value="varied">Varied</option>
      </select>
    </label>
    <label>Seed
      <input id="seed" type="number" value="12345" step="1">
    </label>
    <label class="toggle"><input id="debug" type="checkbox">Debug</label>
    <label class="toggle"><input id="optionsToggle" type="checkbox">Options</label>
    <button id="reset" title="Reset scene" aria-label="Reset scene">R</button>
    <button id="randomObjects" title="Randomize grabbable objects" aria-label="Randomize grabbable objects">Obj</button>
    <button id="dropObjects" title="Drop held objects" aria-label="Drop held objects">Drop</button>
    <div id="randomButtons" class="rand-row"></div>
    <button id="mutateConfig" title="Mutate current config" aria-label="Mutate current config">M</button>
    <button id="exportConfig" title="Export JSON" aria-label="Export JSON">E</button>
    <button id="importConfig" title="Import JSON" aria-label="Import JSON">I</button>
  </div>
  <div id="creatureScope"></div>
  <div id="optionsPanel" class="creature-panel" style="display:none">
    <div class="panel-head"><span>Gait Controls</span><button class="panel-min" title="Minimize">-</button></div>
    <div id="options" class="panel-body"></div>
  </div>
  <div id="modelPanel" class="creature-panel" style="display:none">
    <div class="panel-head"><span>Model + Terrain</span><button class="panel-min" title="Minimize">-</button></div>
    <div id="modelOptions" class="panel-body"></div>
  </div>
  <div id="inspector" class="creature-panel">
    <div class="panel-head"><span id="inspectorTitle">Creature</span><button class="panel-min" title="Minimize">-</button></div>
    <div class="panel-body">
      <div id="inspectorSummary"></div>
      <div id="inspectorActions">
        <button id="cloneCreature" title="Clone selected creature">Clone</button>
        <button id="deleteCreature" title="Delete selected creature">Delete</button>
        <button id="saveCreature" title="Save selected creature JSON">Save</button>
        <button id="closeInspector" title="Close inspector">Close</button>
      </div>
      <textarea id="selectedConfig" spellcheck="false"></textarea>
    </div>
  </div>
  <div id="configPanel" class="creature-panel">
    <div class="panel-head"><span>JSON Config</span><button class="panel-min" title="Minimize">-</button></div>
    <div class="panel-body"><textarea id="configText" spellcheck="false"></textarea></div>
  </div>
`;

function ensurePortCreatureUi() {
  if (!document.getElementById('creature-toolbar')) {
    const style = document.createElement('style');
    style.textContent = CREATURE_UI_STYLE;
    document.head.appendChild(style);

    const shell = document.createElement('div');
    shell.id = 'port-creature-ui';
    shell.innerHTML = CREATURE_UI_HTML;
    document.body.appendChild(shell);
  }
}

function creatureArenaSize(terrainSystem, terrain) {
  const chunkSize = terrainSystem?.params?.chunkSize || 30;
  const renderRadius = terrainSystem?.params?.renderRadius || terrain?.renderRadius || 2;
  return Math.max(48, chunkSize * (renderRadius * 2 + 1));
}

export function createEnvironmentPortCreatures({
  scene,
  renderer,
  camera,
  ground,
  terrain,
  terrainSystem,
  terrainHeight,
  resolveTrunks = null,
  nearbyTrunks = null,
  rebuildWorld,
  isInteractionEnabled = () => true,
  mode = 'on',
  getPlayerPose = null,
  damagePlayer = null,
  getWorldBounds = null,
}) {
  ensurePortCreatureUi();

  const creatureTerrain = {
    amplitude: terrain.baseAmp ?? 1,
    frequency: 1,
    roughness: 1,
    ridge: 0,
    size: creatureArenaSize(terrainSystem, terrain),
    resolution: 120,
    lake: terrain.lake ?? 0.45,
    lakeDepth: terrain.lakeDepth ?? 3.2,
    waterLevel: terrain.waterLevel ?? -0.9,
  };

  const system = createPortCreatureSystem({
    scene,
    camera,
    terrainHeight,
    resolveTrunks,
    nearbyTrunks,
    getPlayerPose,
    damagePlayer,
    getWorldBounds,
    terrainSettings: creatureTerrain,
    rebuildTerrain: (respawn = true) => {
      terrain.baseAmp = creatureTerrain.amplitude;
      terrain.lake = creatureTerrain.lake;
      terrain.lakeDepth = creatureTerrain.lakeDepth;
      terrain.waterLevel = creatureTerrain.waterLevel;
      creatureTerrain.size = creatureArenaSize(terrainSystem, terrain);
      rebuildWorld();
      if (respawn) system.resetCreatures();
    },
  });

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let downX = 0;
  let downY = 0;

  renderer.domElement.addEventListener('pointerdown', event => {
    downX = event.clientX;
    downY = event.clientY;
  });

  renderer.domElement.addEventListener('click', event => {
    if (!isInteractionEnabled()) return;
    if (Math.hypot(event.clientX - downX, event.clientY - downY) > 5) return;
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    system.selectFromRaycaster(raycaster);
  });

  renderer.domElement.addEventListener('dblclick', event => {
    if (!isInteractionEnabled()) return;
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(ground(), false)[0];
    if (hit) system.setTargetPoint(hit.point);
  });

  return {
    update(dt) {
      creatureTerrain.size = creatureArenaSize(terrainSystem, terrain);
      if (mode === 'network') {
        system.updateNetworkCreatures(dt);
        return;
      }
      if (mode === 'off') {
        for (const creature of system.creatures) creature.group.visible = false;
        system.clearRenderBatches?.();
        system.stats.updateMs = 0;
        system.stats.lodMs = 0;
        system.stats.objectsMs = 0;
        system.stats.behaviorMs = 0;
        system.stats.steeringMs = 0;
        system.stats.physicsMs = 0;
        system.stats.renderMs = 0;
        system.stats.selectionMs = 0;
        system.stats.count = system.creatures.length;
        system.stats.visible = 0;
        system.stats.sim = 0;
        system.stats.rendered = 0;
        system.stats.bodyOnly = 0;
        system.stats.armsActive = 0;
        system.stats.shadowCasters = 0;
        system.stats.ikFull = 0;
        system.stats.ikCheap = 0;
        system.stats.instancedBoxes = 0;
        system.stats.instancedLimbs = 0;
        system.stats.instancedJoints = 0;
        system.stats.instancedHandsFeet = 0;
        system.stats.instancedShadows = 0;
        system.stats.tiers.fill(0);
        return;
      }
      system.update(dt);
    },
    reset() {
      system.resetCreatures();
    },
    get stats() {
      return system.stats;
    },
    system,
  };
}
