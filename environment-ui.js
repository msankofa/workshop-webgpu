const PERF_ROWS = [
  ['terrainWindow', 'Terrain window', 'passTerrainWindowMs'],
  ['creatures', 'Creatures', 'passCreaturesMs'],
  ['water', 'Water', 'passWaterMs'],
  ['grassGpu', 'Grass GPU', 'passGrassMs'],
  ['forestGpu', 'Forest GPU', 'passForestMs'],
  ['plantsGpu', 'Plants GPU', 'passPlantsMs'],
  ['cdlodGpu', 'CDLOD GPU', 'passCdlodMs'],
  ['lightsGpu', 'Lights GPU', 'passLightsMs'],
  ['particlesGpu', 'Particles GPU', 'passParticlesMs'],
  ['postRender', 'Render submit', 'passPostMs'],
];

const RENDER_DRIVER_ROWS = [
  {
    id: 'draws', label: 'Draw calls', max: 500,
    value: s => fmtCompact(s.renderFrameCalls ?? s.renderDrawCalls ?? 0, 1),
    load: s => Number(s.renderFrameCalls ?? s.renderDrawCalls ?? 0) || 0,
    title: 'Renderer draw calls for the latest frame. This includes shadow and render passes reported by three.'
  },
  {
    id: 'triangles', label: 'Triangles', max: 10_000_000,
    value: s => fmtCompact(s.triangles ?? 0, 1),
    load: s => Number(s.triangles ?? 0) || 0,
    title: 'Triangles submitted in the latest renderer frame.'
  },
  {
    id: 'compute', label: 'Compute dispatches', max: 80,
    value: s => fmtCompact(s.computeFrameCalls ?? 0, 1),
    load: s => Number(s.computeFrameCalls ?? 0) || 0,
    title: 'GPU compute dispatches reported for the frame. These can still affect the render-submit wait path.'
  },
  {
    id: 'terrain', label: 'Terrain', max: 80,
    value: s => `${fmtCompact(s.terrainDraws ?? 0, 1)} draws · ${s.terrainTris == null ? '--' : fmtCompact(s.terrainTris, 1)} tris`,
    load: s => Number(s.terrainDraws ?? 0) || 0,
    title: 'Terrain draw contribution. CDLOD is expected to stay near one draw.'
  },
  {
    id: 'water', label: 'Water surface', max: 12,
    value: s => `${fmtCompact(s.waterDraws ?? 0, 1)} draws · ${fmtCompact(s.waterTriangles ?? 0, 1)} tris`,
    load: s => Number(s.waterDraws ?? 0) || 0,
    title: 'Main water surface contribution. Reflection and caustics are timed in the Water stage, not Render submit.'
  },
  {
    id: 'forest', label: 'Forest', max: 160,
    value: s => `${fmtCompact(s.forestDraws ?? 0, 1)} draws · ${fmtCompact(s.forestInstances ?? 0, 1)} inst`,
    load: s => Number(s.forestDraws ?? 0) || 0,
    title: 'Forest instanced draw meshes submitted by the main render.'
  },
  {
    id: 'plants', label: 'Plants', max: 40,
    value: s => `${fmtCompact(s.plantDraws ?? 0, 1)} draws · ${fmtCompact(s.plantInstances ?? 0, 1)} inst`,
    load: s => Number(s.plantDraws ?? 0) || 0,
    title: 'Understory plant instanced draw meshes submitted by the main render.'
  },
  {
    id: 'particles', label: 'Particles', max: 12,
    value: s => `${fmtCompact(s.particleFields ?? 0, 1)} fields · ${fmtCompact(s.particleCount ?? 0, 1)} cap`,
    load: s => Number(s.particleFields ?? 0) || 0,
    title: 'Particle field draw meshes in the scene; each field has its own GPU simulation and draw.'
  },
  {
    id: 'creatureInstances', label: 'Creature instances', max: 20000,
    value: s => fmtCompact((s.creatureInstancedBoxes ?? 0) + (s.creatureInstancedLimbs ?? 0) + (s.creatureInstancedJoints ?? 0) + (s.creatureInstancedHandsFeet ?? 0) + (s.creatureInstancedShadows ?? 0), 1),
    load: s => (Number(s.creatureInstancedBoxes ?? 0) || 0) + (Number(s.creatureInstancedLimbs ?? 0) || 0) + (Number(s.creatureInstancedJoints ?? 0) || 0) + (Number(s.creatureInstancedHandsFeet ?? 0) || 0) + (Number(s.creatureInstancedShadows ?? 0) || 0),
    title: 'Instanced creature parts submitted through the shared creature batches.'
  },
  {
    id: 'shadows', label: 'Creature shadow casters', max: 200,
    value: s => fmtCompact(s.creatureShadows ?? 0, 1),
    load: s => Number(s.creatureShadows ?? 0) || 0,
    title: 'Creatures still close enough to cast shadows. Shadow casters can increase renderer work before the main pass.'
  },
];

function fmtNumber(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  return n.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

function fmtMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  return n < 10 ? n.toFixed(2) : n.toFixed(1);
}

function fmtCompact(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(digits) + 'M';
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(digits) + 'K';
  return String(Math.round(n));
}

function frameClass(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms > 33) return 'bad';
  if (ms > 16.7) return 'warn';
  return 'good';
}

function makeEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function makeTab(id, label) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'wui-tab';
  btn.dataset.tab = id;
  btn.textContent = label;
  return btn;
}

function drawSpark(canvas, samples) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (const ms of [16.7, 33.3]) {
    const y = height - Math.min(1, ms / 50) * height;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  if (samples.length < 2) return;
  ctx.strokeStyle = '#77c8a1';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  samples.forEach((ms, i) => {
    const x = (i / (samples.length - 1)) * width;
    const y = height - Math.min(1, ms / 50) * height;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function installStyle() {
  if (document.getElementById('workshop-ui-style')) return;
  const style = document.createElement('style');
  style.id = 'workshop-ui-style';
  style.textContent = `
    #workshop-ui {
      --wui-bg: rgba(18, 22, 28, 0.92);
      --wui-panel: rgba(255,255,255,0.045);
      --wui-line: rgba(255,255,255,0.12);
      --wui-text: #d8dee9;
      --wui-muted: #8d97a8;
      --wui-accent: #77c8a1;
      --wui-warn: #ffc857;
      --wui-bad: #ff7b7b;
      position: fixed;
      top: 10px;
      right: 10px;
      bottom: 10px;
      width: min(360px, calc(100vw - 20px));
      display: grid;
      grid-template-rows: auto 1fr;
      border: 1px solid var(--wui-line);
      border-radius: 8px;
      background: var(--wui-bg);
      color: var(--wui-text);
      font: 12px/1.45 system-ui, -apple-system, Segoe UI, sans-serif;
      z-index: 60;
      box-shadow: 0 12px 36px rgba(0,0,0,0.34);
      backdrop-filter: blur(10px);
      overflow: hidden;
    }
    body.gui-hidden #workshop-ui { display: none !important; }
    #workshop-ui button, #workshop-ui select, #workshop-ui input, #workshop-ui textarea {
      font: inherit;
    }
    .wui-tabs {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      border-bottom: 1px solid var(--wui-line);
      background: rgba(255,255,255,0.035);
    }
    .wui-tab {
      min-width: 0;
      height: 34px;
      border: 0;
      border-right: 1px solid rgba(255,255,255,0.07);
      background: transparent;
      color: var(--wui-muted);
      cursor: pointer;
    }
    .wui-tab:last-child { border-right: 0; }
    .wui-tab.active {
      color: var(--wui-text);
      background: rgba(119, 200, 161, 0.12);
      box-shadow: inset 0 -2px 0 var(--wui-accent);
    }
    .wui-panels { min-height: 0; }
    .wui-panel {
      display: none;
      height: 100%;
      min-height: 0;
      overflow-y: auto;
      padding: 10px;
      box-sizing: border-box;
    }
    .wui-panel.active { display: block; }
    .wui-empty {
      color: var(--wui-muted);
      padding: 10px;
      border: 1px dashed var(--wui-line);
      border-radius: 6px;
    }
    .wui-card {
      border: 1px solid var(--wui-line);
      border-radius: 6px;
      background: var(--wui-panel);
      margin-bottom: 8px;
      overflow: hidden;
    }
    .wui-card-title {
      padding: 7px 9px;
      color: var(--wui-muted);
      font-size: 11px;
      font-weight: 650;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    .wui-card-body { padding: 8px 9px; }
    .wui-metrics {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 7px;
      margin-bottom: 8px;
    }
    .wui-metric {
      min-width: 0;
      border: 1px solid rgba(255,255,255,0.09);
      border-radius: 6px;
      background: rgba(0,0,0,0.16);
      padding: 7px;
    }
    .wui-metric .label {
      color: var(--wui-muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .wui-metric .value {
      margin-top: 2px;
      color: var(--wui-text);
      font: 18px/1.1 ui-monospace, SFMono-Regular, Consolas, monospace;
      white-space: nowrap;
    }
    .wui-metric.good .value { color: var(--wui-accent); }
    .wui-metric.warn .value { color: var(--wui-warn); }
    .wui-metric.bad .value { color: var(--wui-bad); }
    .wui-spark {
      width: 100%;
      height: 54px;
      display: block;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 6px;
      margin-bottom: 9px;
    }
    .wui-row {
      display: grid;
      grid-template-columns: 1fr auto;
      align-items: center;
      gap: 10px;
      margin: 5px 0;
      color: var(--wui-muted);
    }
    .wui-row strong {
      color: var(--wui-text);
      font-weight: 600;
    }
    .wui-bar {
      grid-column: 1 / -1;
      height: 4px;
      overflow: hidden;
      border-radius: 999px;
      background: rgba(255,255,255,0.08);
    }
    .wui-bar span {
      display: block;
      height: 100%;
      width: 0%;
      background: var(--wui-accent);
      transition: width 120ms linear, background-color 120ms linear;
    }
    .wui-bar.warn span { background: var(--wui-warn); }
    .wui-bar.bad span { background: var(--wui-bad); }
    .wui-capture {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
    }
    .wui-capture button {
      border: 1px solid var(--wui-line);
      border-radius: 5px;
      background: #20252d;
      color: var(--wui-text);
      padding: 4px 7px;
      cursor: pointer;
    }
    .wui-capture .rec.active { color: var(--wui-bad); }
    .wui-capture .count { color: var(--wui-muted); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    .wui-btn {
      border: 1px solid var(--wui-line);
      border-radius: 5px;
      background: #20252d;
      color: var(--wui-text);
      min-height: 28px;
      padding: 4px 7px;
      cursor: pointer;
    }
    .wui-btn:disabled {
      cursor: default;
      opacity: 0.45;
    }
    .wui-btn.primary {
      background: rgba(119, 200, 161, 0.14);
      border-color: rgba(119, 200, 161, 0.42);
    }
    .wui-btn.warn { color: var(--wui-warn); }
    .wui-actions {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
      margin-bottom: 8px;
    }
    .wui-list { display: grid; gap: 4px; }
    .wui-list-item {
      min-width: 0;
      border: 1px solid rgba(255,255,255,0.09);
      border-radius: 5px;
      background: rgba(0,0,0,0.16);
      color: var(--wui-text);
      padding: 6px 7px;
      text-align: left;
      cursor: pointer;
    }
    .wui-list-item.active {
      border-color: rgba(119, 200, 161, 0.46);
      background: rgba(119, 200, 161, 0.12);
    }
    .wui-list-item small {
      display: block;
      color: var(--wui-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .wui-field {
      display: grid;
      grid-template-columns: 1fr 64px;
      align-items: center;
      gap: 8px;
      margin: 7px 0;
      color: var(--wui-muted);
    }
    .wui-field output {
      color: var(--wui-text);
      text-align: right;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    .wui-field input[type=range] { grid-column: 1 / -1; }
    .wui-check {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin: 7px 0;
      color: var(--wui-muted);
    }
    .wui-status {
      color: var(--wui-muted);
      min-height: 18px;
      margin-top: 6px;
    }

    #workshop-ui #ctrl, #workshop-ui #fps {
      position: static !important;
      width: auto !important;
      background: transparent !important;
      border: 0 !important;
      border-radius: 0 !important;
      color: var(--wui-text) !important;
      font: inherit !important;
      z-index: auto !important;
    }
    #workshop-ui #ctrl-bar, #workshop-ui #fps-bar {
      display: none !important;
    }
    #workshop-ui #ctrl-body, #workshop-ui #fps-body {
      max-height: none !important;
      overflow: visible !important;
      padding: 0 !important;
    }
    #workshop-ui .sec {
      border: 1px solid var(--wui-line);
      border-radius: 6px;
      background: var(--wui-panel);
      margin-bottom: 8px;
      overflow: hidden;
    }
    #workshop-ui .sec-head {
      margin: 0 !important;
      padding: 8px 9px;
      color: var(--wui-text) !important;
      background: rgba(255,255,255,0.035);
      border-bottom: 1px solid rgba(255,255,255,0.08);
    }
    #workshop-ui .sec.collapsed .sec-head {
      border-bottom: 0;
    }
    #workshop-ui .sec-body {
      padding: 7px 9px 9px;
    }
    #workshop-ui .row {
      gap: 10px;
    }
    #workshop-ui input[type=range] {
      width: 100%;
      accent-color: var(--wui-accent);
    }
    #workshop-ui select,
    #workshop-ui input[type=number] {
      background: #20252d !important;
      color: var(--wui-text) !important;
      border: 1px solid var(--wui-line) !important;
      border-radius: 5px !important;
      min-height: 26px;
    }

    #workshop-ui #port-creature-ui,
    #workshop-ui #creature-toolbar,
    #workshop-ui .creature-panel {
      position: static !important;
      width: auto !important;
      max-height: none !important;
      background: transparent !important;
      border: 0 !important;
      box-shadow: none !important;
      backdrop-filter: none !important;
      color: var(--wui-text) !important;
      font: inherit !important;
      z-index: auto !important;
    }
    #workshop-ui #creature-toolbar {
      display: grid !important;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      align-items: end;
      gap: 8px;
      padding: 0 0 8px !important;
      border-bottom: 1px solid var(--wui-line) !important;
      margin-bottom: 8px;
    }
    #workshop-ui #creature-toolbar label {
      min-width: 0;
    }
    #workshop-ui #creature-toolbar select,
    #workshop-ui #creature-toolbar input[type=number] {
      width: 100% !important;
      min-width: 0 !important;
      box-sizing: border-box;
    }
    #workshop-ui #creature-toolbar button,
    #workshop-ui #creature-toolbar .toggle {
      min-width: 0 !important;
      height: 28px !important;
    }
    #workshop-ui #randomButtons {
      grid-column: 1 / -1;
      flex-wrap: wrap;
    }
    #workshop-ui .creature-panel {
      display: block;
      border: 1px solid var(--wui-line) !important;
      border-radius: 6px !important;
      background: var(--wui-panel) !important;
      margin-bottom: 8px;
      overflow: hidden !important;
    }
    #workshop-ui .creature-panel[style*="display:none"],
    #workshop-ui .creature-panel[style*="display: none"] {
      display: none !important;
    }
    #workshop-ui .creature-panel .panel-head {
      cursor: default !important;
    }
    #workshop-ui #options, #workshop-ui #modelOptions {
      grid-template-columns: 1fr !important;
    }
    #workshop-ui .numeric-control {
      grid-template-columns: 1fr 68px;
    }
    #workshop-ui #inspectorActions {
      flex-wrap: wrap;
    }
    #workshop-ui #perf-log {
      display: none !important;
    }
    #workshop-ui #terrain-debug {
      position: static !important;
      pointer-events: auto !important;
      white-space: pre-wrap !important;
      max-height: 190px;
      overflow: auto;
      background: rgba(0,0,0,0.14) !important;
      border: 1px solid var(--wui-line) !important;
      border-radius: 6px !important;
      padding: 7px !important;
      font-size: 10px !important;
      color: var(--wui-muted) !important;
    }
    @media (max-width: 720px) {
      #workshop-ui {
        left: 10px;
        width: auto;
      }
      .wui-tabs { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      .wui-tab { font-size: 11px; }
    }
  `;
  document.head.appendChild(style);
}

export function createEnvironmentUi({ perfLog } = {}) {
  installStyle();

  const shell = makeEl('aside');
  shell.id = 'workshop-ui';
  shell.setAttribute('aria-label', 'Workshop controls');

  const tabs = makeEl('nav', 'wui-tabs');
  const tabDefs = [
    ['scene', 'Scene'],
    ['creatures', 'Creatures'],
    ['models', 'Models'],
    ['effects', 'Effects'],
    ['walk', 'Walk'],
    ['perf', 'Perf'],
  ];
  const tabButtons = new Map(tabDefs.map(([id, label]) => {
    const btn = makeTab(id, label);
    tabs.appendChild(btn);
    return [id, btn];
  }));

  const panels = makeEl('div', 'wui-panels');
  const panelEls = new Map(tabDefs.map(([id]) => {
    const panel = makeEl('section', 'wui-panel');
    panel.dataset.panel = id;
    panels.appendChild(panel);
    return [id, panel];
  }));

  shell.append(tabs, panels);
  document.body.appendChild(shell);

  const sceneHost = panelEls.get('scene');
  const effectsHost = panelEls.get('effects');
  const walkHost = panelEls.get('walk');
  const creaturesHost = panelEls.get('creatures');
  const modelsHost = panelEls.get('models');
  const perfHost = panelEls.get('perf');
  sceneHost.id = 'scene-section-host';
  effectsHost.id = 'effects-section-host';
  modelsHost.id = 'models-section-host';

  function activate(tab) {
    for (const [id, btn] of tabButtons) btn.classList.toggle('active', id === tab);
    for (const [id, panel] of panelEls) panel.classList.toggle('active', id === tab);
  }
  tabs.addEventListener('click', event => {
    const btn = event.target.closest('.wui-tab');
    if (btn) activate(btn.dataset.tab);
  });
  activate('scene');

  const effectsNames = new Set(['Post', 'Particles', 'Water', 'Clouds', 'Sky']);
  function sectionTitle(sec) {
    return sec.querySelector('.sec-head span')?.textContent?.trim() || '';
  }
  function routeSections() {
    const ctrlBody = document.getElementById('ctrl-body');
    if (!ctrlBody) return;
    for (const sec of [...document.querySelectorAll('#ctrl-body > .sec, #scene-section-host > .sec, #effects-section-host > .sec')]) {
      const target = effectsNames.has(sectionTitle(sec)) ? effectsHost : sceneHost;
      if (sec.parentElement !== target) target.appendChild(sec);
    }
  }
  let ctrlMounted = false;
  let ctrlObserver = null;
  function mountCtrl() {
    const ctrl = document.getElementById('ctrl');
    const ctrlBody = document.getElementById('ctrl-body');
    if (!ctrl || !ctrlBody || ctrlMounted) return;
    sceneHost.appendChild(ctrl);
    ctrlMounted = true;
    routeSections();
    ctrlObserver = new MutationObserver(routeSections);
    ctrlObserver.observe(ctrlBody, { childList: true });
  }
  mountCtrl();

  function mountFixedUi() {
    mountCtrl();
    const portUi = document.getElementById('port-creature-ui');
    if (portUi && portUi.parentElement !== creaturesHost) creaturesHost.appendChild(portUi);
    const fps = document.getElementById('fps');
    if (fps && fps.parentElement !== walkHost) walkHost.appendChild(fps);
  }
  mountFixedUi();
  const mountObserver = new MutationObserver(mountFixedUi);
  mountObserver.observe(document.body, { childList: true, subtree: false });

  buildPerfPanel(perfHost, perfLog);

  return {
    activate,
    updatePerf: perfHost._updatePerf,
  };
}

function buildPerfPanel(host, perfLog) {
  const overview = makeEl('div', 'wui-card');
  overview.appendChild(makeEl('div', 'wui-card-title', 'Live overview'));
  const overviewBody = makeEl('div', 'wui-card-body');
  const metrics = makeEl('div', 'wui-metrics');
  const metricEls = {};
  for (const key of ['fps', 'frameMs', 'cpuMs', 'gpuMs', 'draws', 'tris']) {
    const metric = makeEl('div', 'wui-metric');
    metric.innerHTML = `<div class="label"></div><div class="value">--</div>`;
    metric.querySelector('.label').textContent = {
      fps: 'FPS',
      frameMs: 'Frame',
      cpuMs: 'CPU',
      gpuMs: 'GPU',
      draws: 'Draws',
      tris: 'Tris',
    }[key];
    metrics.appendChild(metric);
    metricEls[key] = metric;
  }
  const spark = makeEl('canvas', 'wui-spark');
  overviewBody.append(metrics, spark);
  overview.appendChild(overviewBody);

  const resources = makeEl('div', 'wui-card');
  resources.appendChild(makeEl('div', 'wui-card-title', 'Scene figures'));
  const resourcesBody = makeEl('div', 'wui-card-body');
  resources.appendChild(resourcesBody);

  const stages = makeEl('div', 'wui-card');
  stages.appendChild(makeEl('div', 'wui-card-title', 'Frame stages'));
  const stagesBody = makeEl('div', 'wui-card-body');
  const stageRows = new Map();
  for (const [id, label] of PERF_ROWS) {
    const row = makeEl('div', 'wui-row');
    row.innerHTML = `<span>${label}</span><strong>-- ms</strong><div class="wui-bar"><span></span></div>`;
    if (id === 'postRender') row.title = 'Final render/submit timing. With Post FX off, this is still the scene render.';
    stagesBody.appendChild(row);
    stageRows.set(id, row);
  }
  stages.appendChild(stagesBody);

  const drivers = makeEl('div', 'wui-card');
  drivers.appendChild(makeEl('div', 'wui-card-title', 'Render drivers (not ms)'));
  const driversBody = makeEl('div', 'wui-card-body');
  const driverRows = new Map();
  for (const def of RENDER_DRIVER_ROWS) {
    const row = makeEl('div', 'wui-row');
    row.innerHTML = '<span></span><strong>--</strong><div class="wui-bar"><span></span></div>';
    row.querySelector('span').textContent = def.label;
    if (def.title) row.title = def.title;
    driversBody.appendChild(row);
    driverRows.set(def.id, row);
  }
  drivers.appendChild(driversBody);

  const capture = makeEl('div', 'wui-card');
  capture.appendChild(makeEl('div', 'wui-card-title', 'Capture'));
  const captureBody = makeEl('div', 'wui-card-body wui-capture');
  const recBtn = makeEl('button', 'rec');
  const csvBtn = makeEl('button', '', 'CSV');
  const clrBtn = makeEl('button', '', 'Clear');
  const count = makeEl('span', 'count');
  captureBody.append(recBtn, count, csvBtn, clrBtn);
  capture.appendChild(captureBody);

  const raw = makeEl('div', 'wui-card');
  raw.appendChild(makeEl('div', 'wui-card-title', 'Raw debug'));
  const rawBody = makeEl('div', 'wui-card-body');
  const terrainDebug = document.getElementById('terrain-debug');
  if (terrainDebug) rawBody.appendChild(terrainDebug);
  else rawBody.appendChild(makeEl('div', 'wui-empty', 'Debug stream unavailable.'));
  raw.appendChild(rawBody);

  host.append(overview, resources, stages, drivers, capture, raw);

  const frameSamples = [];
  function refreshCapture() {
    if (!perfLog) return;
    recBtn.textContent = perfLog.recording ? 'Recording' : 'Paused';
    recBtn.classList.toggle('active', !!perfLog.recording);
    count.textContent = `${perfLog.samples.length} @ ${perfLog.intervalMs}ms`;
  }
  recBtn.addEventListener('click', () => {
    if (!perfLog) return;
    perfLog.recording = !perfLog.recording;
    refreshCapture();
  });
  csvBtn.addEventListener('click', () => perfLog?.download());
  clrBtn.addEventListener('click', () => {
    perfLog?.clear();
    refreshCapture();
  });
  refreshCapture();

  host._updatePerf = snapshot => {
    if (!snapshot) return;
    const fps = Number(snapshot.fps);
    const frameMs = fps > 0 ? 1000 / fps : 0;
    const timestampGpuMs = Number(snapshot.gpuRenderMs || 0) + Number(snapshot.gpuComputeMs || 0);
    const gpuMs = timestampGpuMs > 0 ? timestampGpuMs : Number(snapshot.passGpuAwaitMs || 0);
    metricEls.gpuMs.title = timestampGpuMs > 0
      ? 'GPU timestamp total. Render/compute timestamps require ?timestamps=on.'
      : 'Awaited GPU stage time. Add ?timestamps=on for hardware GPU timestamps.';
    frameSamples.push(frameMs);
    if (frameSamples.length > 120) frameSamples.shift();

    const values = {
      fps: fmtNumber(snapshot.fps, 0),
      frameMs: fmtMs(frameMs) + ' ms',
      cpuMs: fmtMs(snapshot.cpuMs) + ' ms',
      gpuMs: gpuMs > 0 ? fmtMs(gpuMs) + ' ms' : '--',
      draws: fmtCompact(snapshot.renderFrameCalls ?? snapshot.renderDrawCalls ?? 0, 1),
      tris: fmtCompact(snapshot.triangles ?? 0, 1),
    };
    for (const [key, value] of Object.entries(values)) {
      metricEls[key].querySelector('.value').textContent = value;
      metricEls[key].classList.remove('good', 'warn', 'bad');
    }
    metricEls.frameMs.classList.add(frameClass(frameMs));
    metricEls.cpuMs.classList.add(frameClass(Number(snapshot.cpuMs)));
    if (gpuMs > 0) metricEls.gpuMs.classList.add(frameClass(gpuMs));

    drawSpark(spark, frameSamples);

    resourcesBody.innerHTML = '';
    const resourceRows = [
      ['Creatures', `${snapshot.creatureVisible ?? 0}/${snapshot.creatures ?? 0} visible, ${snapshot.creatureRendered ?? 0} rendered`],
      ['Terrain', `${snapshot.terrainMode || '--'}; draws ${snapshot.terrainDraws ?? '--'}; chunks ${snapshot.drawChunks ?? '--'}/${snapshot.targetChunks ?? '--'}`],
      ['Grass', `${snapshot.grassChunks ?? 0} chunks; reculls ${snapshot.grassReculls ?? '--'}; skips ${snapshot.grassRecullSkips ?? '--'}`],
      ['Water', `${snapshot.waterChunks ?? 0}/${snapshot.waterCandidates ?? 0} chunks; ${fmtCompact(snapshot.waterTriangles ?? 0)} tris`],
      ['Water FX', `refl ${snapshot.waterReflectionEnabled ? 'on' : 'off'} ${fmtMs(snapshot.waterReflectionLastMs ?? 0)} ms; caustic ${snapshot.waterCausticEnabled ? 'on' : 'off'} ${fmtMs(snapshot.waterCausticLastMs ?? 0)} ms`],
      ['Forest', `${snapshot.forestInstances ?? snapshot.treePlacements ?? 0} instances; draws ${snapshot.forestDraws ?? '--'}`],
      ['Memory', `${snapshot.geometries ?? 0} geom; ${snapshot.textures ?? 0} tex; dropped ${snapshot.droppedFrames ?? 0}`],
    ];
    for (const [label, value] of resourceRows) {
      const row = makeEl('div', 'wui-row');
      row.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
      resourcesBody.appendChild(row);
    }

    for (const def of RENDER_DRIVER_ROWS) {
      const row = driverRows.get(def.id);
      const value = def.value(snapshot);
      const load = Math.max(0, Number(def.load(snapshot)) || 0);
      const pct = Math.min(100, (load / Math.max(1, def.max)) * 100);
      row.querySelector('strong').textContent = value;
      const bar = row.querySelector('.wui-bar');
      bar.classList.remove('warn', 'bad');
      if (load > def.max * 1.5) bar.classList.add('bad');
      else if (load > def.max) bar.classList.add('warn');
      row.querySelector('.wui-bar span').style.width = pct + '%';
    }

    for (const [id, , key] of PERF_ROWS) {
      const row = stageRows.get(id);
      if (id === 'postRender') {
        row.querySelector('span').textContent = snapshot.postMode === 'off' ? 'Render submit' : 'Render + post';
      }
      const ms = Number(snapshot[key] || 0);
      const pct = Math.min(100, (ms / 33.3) * 100);
      row.querySelector('strong').textContent = fmtMs(ms) + ' ms';
      const bar = row.querySelector('.wui-bar');
      bar.classList.remove('warn', 'bad');
      if (ms > 33) bar.classList.add('bad');
      else if (ms > 16.7) bar.classList.add('warn');
      row.querySelector('.wui-bar span').style.width = pct + '%';
    }
    refreshCapture();
  };
}
