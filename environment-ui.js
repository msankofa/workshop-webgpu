import { buildStatsPanel } from './creature-stats.js';

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

function makeTab(id, label, icon) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'wui-tab';
  btn.dataset.tab = id;
  btn.textContent = icon;
  btn.setAttribute('aria-label', label);
  btn.dataset.tooltip = label;
  btn.title = label;
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
      --wui-rail: 44px;
      --wui-panel-width: min(360px, calc(100vw - 64px));
      position: fixed;
      top: 10px;
      right: 10px;
      bottom: 10px;
      width: calc(var(--wui-panel-width) + var(--wui-rail));
      display: grid;
      grid-template-columns: minmax(0, var(--wui-panel-width)) var(--wui-rail);
      border: 1px solid var(--wui-line);
      border-radius: 8px;
      background: var(--wui-bg);
      color: var(--wui-text);
      font: 12px/1.45 system-ui, -apple-system, Segoe UI, sans-serif;
      z-index: 60;
      box-shadow: 0 12px 36px rgba(0,0,0,0.34);
      overflow: hidden;
      transition: width 160ms ease;
    }
    /* backdrop-filter is OFF by default and opt-in via .wui-blur. This panel is a full-viewport-
       height strip over a live WebGPU canvas, so a blur here makes the compositor re-blur that
       whole strip every frame, uncacheable because the canvas changes every frame -- which is why
       the frame rate dropped only while the panel was expanded. At --wui-bg alpha 0.92 the blurred
       backdrop is barely visible anyway. Toggle it back on from the Perf A/B panel to A/B. */
    #workshop-ui.wui-blur { backdrop-filter: blur(10px); }
    #workshop-ui.collapsed {
      width: var(--wui-rail);
      grid-template-columns: 0 var(--wui-rail);
      border-left-color: transparent;
      border-radius: 8px 0 0 8px;
    }
    body.gui-hidden #workshop-ui { display: none !important; }
    #workshop-ui button, #workshop-ui select, #workshop-ui input, #workshop-ui textarea {
      font: inherit;
    }
    .wui-tabs {
      display: grid;
      grid-column: 2;
      grid-row: 1;
      grid-auto-rows: minmax(64px, 1fr);
      height: 100%;
      border-left: 1px solid var(--wui-line);
      background: rgba(255,255,255,0.035);
    }
    .wui-tab {
      min-width: 0;
      width: 100%;
      min-height: 64px;
      border: 0;
      border-bottom: 1px solid rgba(255,255,255,0.07);
      background: transparent;
      color: var(--wui-muted);
      cursor: pointer;
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      letter-spacing: 0;
      text-align: center;
    }
    .wui-tab:last-child { border-bottom: 0; }
    .wui-tab.active {
      color: var(--wui-text);
      background: rgba(119, 200, 161, 0.12);
      box-shadow: inset -2px 0 0 var(--wui-accent);
    }
    .wui-panels {
      grid-column: 1;
      grid-row: 1;
      min-height: 0;
      min-width: 0;
      border-right: 1px solid rgba(255,255,255,0.07);
    }
    #workshop-ui.collapsed .wui-panels { display: none; }
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
    #workshop-ui input[type=number],
    #workshop-ui input[type=text] {
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
        --wui-panel-width: calc(100vw - 64px);
        top: 8px;
        right: 0;
        bottom: 8px;
      }
      .wui-tab { font-size: 11px; min-height: 58px; }
    }
    .wui-seg-group {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin: 7px 0;
    }
    .wui-seg {
      border: 1px solid var(--wui-line);
      border-radius: 5px;
      background: #20252d;
      color: var(--wui-muted);
      padding: 4px 9px;
      cursor: pointer;
      flex: 0 0 auto;
    }
    .wui-seg.active {
      color: var(--wui-text);
      background: rgba(119, 200, 161, 0.14);
      border-color: rgba(119, 200, 161, 0.42);
    }
    /* In-game inspector redesign */
    #workshop-ui { --wui-bg:#fff;--wui-panel:#fff;--wui-line:#d8d8d8;--wui-text:#151515;--wui-muted:#6f6f6f;--wui-accent:#e66b1a;--wui-warn:#b85b00;--wui-bad:#c9483c;--wui-rail:56px;--wui-panel-width:min(400px,calc(100vw - 56px));top:0;right:0;bottom:0;width:calc(var(--wui-panel-width) + var(--wui-rail));grid-template-columns:minmax(0,var(--wui-panel-width)) var(--wui-rail);border:1px solid var(--wui-line);border-right:0;border-radius:0;box-shadow:-10px 0 28px rgba(0,0,0,.10);background:#fff;color:var(--wui-text);backdrop-filter:none;transition:width 240ms cubic-bezier(.2,.8,.2,1),box-shadow 180ms ease; }
    #workshop-ui.collapsed { width:var(--wui-rail);grid-template-columns:0 var(--wui-rail);border-radius:0;box-shadow:-4px 0 14px rgba(0,0,0,.08); }
    .wui-tabs { border-left:1px solid var(--wui-line);background:#fbfbfb;grid-auto-rows:56px;align-content:start;overflow:visible; }.wui-tab { position:relative;display:grid;place-items:center;min-height:56px;padding:0;border-bottom:1px solid #ececec;color:#686868;font:600 19px/1 system-ui,-apple-system,Segoe UI,sans-serif;writing-mode:horizontal-tb;transform:none;transition:color .16s ease,background-color .16s ease,transform .16s ease; }.wui-tab { font-size:0; }.wui-tab::before { font:600 19px/1 system-ui,sans-serif; }.wui-tab[data-tab="world"]::before { content:'\\25eb'; }.wui-tab[data-tab="entities"]::before { content:'\\25ce'; }.wui-tab[data-tab="player"]::before { content:'\\25c9'; }.wui-tab[data-tab="assets"]::before { content:'\\25c7'; }.wui-tab[data-tab="audio"]::before { content:'\\266a'; }.wui-tab[data-tab="tools"]::before { content:'\\2699'; }.wui-tab::after { content:attr(data-tooltip);position:absolute;right:calc(100% + 9px);top:50%;z-index:2;transform:translateY(-50%) translateX(4px);opacity:0;pointer-events:none;white-space:nowrap;border:1px solid #2b2b2b;border-radius:5px;padding:4px 7px;background:#242424;color:#fff;font:600 11px/1.2 system-ui,sans-serif;transition:opacity .14s ease,transform .14s ease; }.wui-tab:hover::after,.wui-tab:focus-visible::after { opacity:1;transform:translateY(-50%) translateX(0); }.wui-tab:hover { color:var(--wui-accent);background:#fff7f1;transform:translateX(-1px); }.wui-tab.active { color:var(--wui-accent);background:#fff4ec;box-shadow:inset -3px 0 0 var(--wui-accent); }
    .wui-panels { border-right:0;background:#fff; }.wui-panel { padding:0;overflow:hidden; }.wui-panel.active { display:flex;flex-direction:column;animation:wui-panel-in .22s cubic-bezier(.2,.8,.2,1) both; }@keyframes wui-panel-in { from { opacity:0;transform:translateX(12px); } to { opacity:1;transform:translateX(0); } }.wui-panel-header { display:flex;align-items:center;justify-content:space-between;min-height:55px;padding:0 15px;border-bottom:1px solid var(--wui-line);color:var(--wui-text);font-size:14px;font-weight:750; }.wui-panel-header button { border:0;background:transparent;color:var(--wui-muted);cursor:pointer;font:20px/1 system-ui,sans-serif; }.wui-panel-header button:hover { color:var(--wui-accent);transform:scale(1.08); }.wui-panel-content { min-height:0;overflow-y:auto;padding:10px;box-sizing:border-box;scrollbar-color:#c4c4c4 transparent; }
    .wui-empty,.wui-card,#workshop-ui .sec,#workshop-ui .creature-panel { border-color:var(--wui-line)!important;border-radius:7px!important;background:#fff!important;box-shadow:0 1px 2px rgba(0,0,0,.025)!important; }.wui-card { margin-bottom:8px; }.wui-card-title { color:var(--wui-text);background:#fafafa;border-bottom-color:#ececec; }.wui-card-body { padding:9px; }.wui-metric { border-color:#e5e5e5;background:#fcfcfc; }.wui-metric .value,.wui-row strong,.wui-field output { color:var(--wui-text); }.wui-metric.good .value { color:var(--wui-accent); }.wui-spark { border-color:#e7e7e7;background:#fcfcfc; }.wui-row,.wui-field,.wui-check { color:var(--wui-muted); }.wui-bar { background:#eee; }.wui-bar span { background:var(--wui-accent); }
    .wui-btn,.wui-capture button,#workshop-ui button:not(.wui-tab):not(.panel-min) { border-color:#cfcfcf;background:#fff;color:var(--wui-text);border-radius:5px;transition:transform .15s ease,border-color .15s ease,background-color .15s ease,box-shadow .15s ease; }.wui-btn:hover,.wui-capture button:hover,#workshop-ui button:not(.wui-tab):not(.panel-min):hover { border-color:var(--wui-accent);background:#fff7f1;color:#af4b0b;transform:translateY(-1px);box-shadow:0 3px 9px rgba(230,107,26,.16); }.wui-btn.primary { color:#a94305;background:#fff2e9;border-color:#ef9b65; }
    #workshop-ui .sec { margin-bottom:7px;overflow:hidden;transition:transform .18s ease,box-shadow .18s ease; }#workshop-ui .sec:not(.collapsed):hover { transform:translateY(-1px);box-shadow:0 5px 14px rgba(230,107,26,.09)!important; }#workshop-ui .sec-head { min-height:38px;box-sizing:border-box;margin:0!important;padding:9px 10px;color:var(--wui-text)!important;background:#fbfbfb;border-bottom:1px solid #ededed;font-weight:650;transition:background-color .15s ease,color .15s ease; }#workshop-ui .sec-head:hover { color:#af4b0b!important;background:#fff7f1; }#workshop-ui .sec-head .caret { color:var(--wui-accent);transition:transform .2s cubic-bezier(.2,.8,.2,1); }#workshop-ui .sec-body { display:block!important;max-height:5000px;overflow:hidden;padding:8px 10px 10px;opacity:1;transition:max-height .3s cubic-bezier(.2,.8,.2,1),opacity .18s ease,padding .24s ease; }#workshop-ui .sec.collapsed .sec-head { border-bottom:0; }#workshop-ui .sec.collapsed .sec-body { display:block!important;max-height:0;padding-top:0;padding-bottom:0;opacity:0; }
    #workshop-ui .row { color:var(--wui-muted); }#workshop-ui .row span:first-child { color:var(--wui-text)!important; }#workshop-ui .row span:last-child { color:var(--wui-accent);font-variant-numeric:tabular-nums;transition:transform .18s ease,text-shadow .18s ease; }#workshop-ui .row .wui-value-updated { transform:scale(1.08);text-shadow:0 0 8px rgba(230,107,26,.38); }#workshop-ui input[type=range] { width:100%;accent-color:var(--wui-accent);height:18px;cursor:pointer; }#workshop-ui input[type=checkbox] { accent-color:var(--wui-accent);cursor:pointer;transition:transform .16s cubic-bezier(.2,1.4,.4,1); }#workshop-ui input[type=checkbox]:checked { transform:scale(1.12); }#workshop-ui select,#workshop-ui input[type=number],#workshop-ui input[type=text],#workshop-ui textarea { background:#fff!important;color:var(--wui-text)!important;border-color:#cfcfcf!important; }#workshop-ui select:focus,#workshop-ui input:focus,#workshop-ui textarea:focus { outline:2px solid rgba(230,107,26,.28);outline-offset:1px;border-color:var(--wui-accent)!important; }
    #workshop-ui #creature-toolbar { position:relative;padding-top:26px!important;border:1px solid var(--wui-line)!important;border-radius:7px; }#workshop-ui #creature-toolbar::before { content:'Population';position:absolute;top:8px;left:9px;color:var(--wui-text);font-weight:650; }#workshop-ui .creature-panel .panel-head { padding:9px 10px!important;background:#fbfbfb;border-bottom:1px solid #ededed;color:var(--wui-text); }#workshop-ui .creature-panel .panel-head .panel-min { color:var(--wui-accent); }
    #workshop-ui .wui-parent-group { margin-bottom:9px;border:1px solid var(--wui-line);border-radius:8px;background:#fff;overflow:hidden;box-shadow:0 2px 7px rgba(0,0,0,.04);transition:transform .18s ease,box-shadow .18s ease; }#workshop-ui .wui-parent-group:not(.collapsed):hover { transform:translateY(-1px);box-shadow:0 6px 16px rgba(230,107,26,.10); }#workshop-ui .wui-parent-head { display:flex;align-items:center;justify-content:space-between;min-height:41px;padding:0 11px;background:#fff7f1;color:#9f4206;font-weight:750;cursor:pointer; }#workshop-ui .wui-parent-head::after { content:'▾';color:var(--wui-accent);transition:transform .2s ease; }#workshop-ui .wui-parent-group.collapsed .wui-parent-head::after { transform:rotate(-90deg); }#workshop-ui .wui-parent-body { max-height:10000px;overflow:hidden;padding:9px;transition:max-height .34s cubic-bezier(.2,.8,.2,1),opacity .18s ease,padding .22s ease; }#workshop-ui .wui-parent-group.collapsed .wui-parent-body { max-height:0;padding-top:0;padding-bottom:0;opacity:0; }
    .wui-resize-nub { position:absolute;left:-6px;top:50%;z-index:9;width:12px;height:64px;transform:translateY(-50%);border:1px solid #cfcfcf;border-radius:8px;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.12);cursor:ew-resize;touch-action:none; }
    .wui-resize-nub::before { content:'';position:absolute;left:4px;top:16px;width:2px;height:30px;border-radius:2px;background:repeating-linear-gradient(to bottom,#a0a0a0 0 3px,transparent 3px 6px); }
    .wui-resize-nub:hover,.wui-resize-nub:focus-visible { border-color:var(--wui-accent);outline:none;box-shadow:0 3px 10px rgba(230,107,26,.22); }
    #workshop-ui.collapsed .wui-resize-nub { display:none; }
    @media (max-width:720px) { .wui-resize-nub { display:none!important; } }    /* Keep rail tooltips above the panel and visible when the dock is collapsed. */
    #workshop-ui { overflow:visible; }
    #workshop-ui .wui-tabs { position:relative;z-index:4;overflow:visible; }
    #workshop-ui .wui-panels { position:relative;z-index:1;overflow:hidden; }
    #workshop-ui .wui-tab::after { z-index:8; }    /* Keep re-parented creature controls inside the drawer and give Population its own row. */
    #workshop-ui .wui-panel-content,#workshop-ui .wui-parent-body,#workshop-ui #port-creature-ui { min-width:0;max-width:100%;box-sizing:border-box;overflow-x:hidden; }
    #workshop-ui #creature-toolbar { padding:0 0 8px!important;border:0!important;border-radius:0!important;margin:0!important; }
    #workshop-ui #creature-toolbar::before { content:none!important; }
    #workshop-ui .wui-subhead { margin:0 0 7px;padding:8px 10px;border:1px solid var(--wui-line);border-radius:6px;background:#fbfbfb;color:var(--wui-text);font-weight:650; }
    #workshop-ui #creature-command-hud { position:static!important;right:auto!important;bottom:auto!important;z-index:auto!important;min-width:0!important;margin:0 0 8px!important;padding:8px 10px!important;box-sizing:border-box!important;border:1px solid var(--wui-line)!important;border-radius:7px!important;background:#fbfbfb!important;backdrop-filter:none!important;color:var(--wui-text)!important;pointer-events:auto!important; }
    #workshop-ui #creature-command-hud > div:first-child { color:var(--wui-accent)!important; }
    #workshop-ui #creature-command-hud > div:last-child { color:var(--wui-muted)!important; }
    #workshop-ui.collapsed .wui-panels { display:none!important; }    .wui-toast { position:fixed;right:68px;bottom:14px;z-index:70;border:1px solid #e6a172;border-radius:6px;padding:8px 10px;background:#242424;color:#fff;font:600 12px/1.2 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.2);opacity:0;transform:translateY(8px);pointer-events:none;transition:opacity .18s ease,transform .18s ease; }.wui-toast.show { opacity:1;transform:translateY(0); }
    @media (max-width:720px) { #workshop-ui { --wui-panel-width:100vw;top:auto;left:0;right:0;bottom:0;width:100%;height:min(72vh,620px);grid-template-columns:1fr;grid-template-rows:minmax(0,1fr) var(--wui-rail);border:1px solid var(--wui-line);border-bottom:0;border-radius:12px 12px 0 0;box-shadow:0 -8px 24px rgba(0,0,0,.13);transition:height .24s cubic-bezier(.2,.8,.2,1); }#workshop-ui.collapsed { width:100%;height:var(--wui-rail);grid-template-columns:1fr;grid-template-rows:0 var(--wui-rail); }.wui-tabs { grid-column:1;grid-row:2;grid-auto-flow:column;grid-auto-columns:1fr;grid-auto-rows:var(--wui-rail);grid-template-columns:repeat(6,minmax(0,1fr));border-left:0;border-top:1px solid var(--wui-line);overflow-x:auto; }.wui-tab { min-width:56px;border-bottom:0;border-right:1px solid #ececec; }.wui-tab.active { box-shadow:inset 0 3px 0 var(--wui-accent); }.wui-tab::after { top:auto;bottom:calc(100% + 7px);right:50%;transform:translateX(50%) translateY(4px); }.wui-tab:hover::after,.wui-tab:focus-visible::after { transform:translateX(50%) translateY(0); }.wui-panels { grid-column:1;grid-row:1; }.wui-toast { right:12px;bottom:68px; } }
  `;
  document.head.appendChild(style);
}

function installThemeStyle() {
  if (document.getElementById('workshop-theme-style')) return;
  const style = document.createElement('style');
  style.id = 'workshop-theme-style';
  style.textContent = `
    :root { --theme-settings-surface:#ffffff;--theme-settings-border:#d8d8d8;--theme-settings-text:#151515;--theme-settings-accent:#e66b1a;--theme-map-surface:#12161c;--theme-map-surface-rgba:rgba(18,22,28,.86);--theme-map-border:#d8dee9;--theme-map-text:#d8dee9;--theme-map-accent:#77c8a1;--theme-hud-surface:#121820;--theme-hud-surface-rgba:rgba(18,24,32,.88);--theme-hud-border:#d7dde7;--theme-hud-text:#d7dde7;--theme-hud-accent:#61d394; }
    #workshop-ui { --wui-bg:var(--theme-settings-surface)!important;--wui-panel:var(--theme-settings-surface)!important;--wui-line:var(--theme-settings-border)!important;--wui-text:var(--theme-settings-text)!important;--wui-accent:var(--theme-settings-accent)!important; }
    #mp-finder,#mp-look-angle,#mp-map-nub,#mp-map-menu { background:var(--theme-map-surface-rgba)!important;border-color:var(--theme-map-border)!important;color:var(--theme-map-text)!important; }
    #mp-finder canvas,#world-map canvas { background:var(--theme-map-surface)!important;border-color:var(--theme-map-border)!important; }
    #mp-finder .mp-target,#mp-map-menu .mp-menu-title,#mp-map-menu .mp-layer { color:var(--theme-map-text)!important; }
    #mp-finder button,#mp-map-menu .mp-layer.active { color:var(--theme-map-text)!important;border-color:var(--theme-map-border)!important; }
    #mp-map-menu .mp-layer.active,#mp-finder .mp-zoom button:hover { background:var(--theme-map-accent)!important;color:var(--theme-map-surface)!important; }
    #world-map { background:var(--theme-map-surface-rgba)!important; }
    #combat-hud { color:var(--theme-hud-text)!important;text-shadow:0 1px 2px var(--theme-hud-surface)!important; }
    #combat-hud > div:first-child { background:var(--theme-hud-surface-rgba)!important;border-color:var(--theme-hud-border)!important; }
    #combat-hud #combat-hp-fill { background:var(--theme-hud-accent)!important; }
    #combat-hud #combat-hp,#combat-hud #combat-weapon,#combat-hud #combat-ammo { color:var(--theme-hud-text)!important; }
    .wui-tab[data-tab="theme"]::before { content:'\\1f3a8'; }
    .wui-theme-color { display:grid;grid-template-columns:42px 1fr;gap:8px;align-items:center;margin:8px 0; }.wui-theme-color input[type=color] { width:42px;height:30px;padding:2px;border:1px solid var(--wui-line);border-radius:5px;background:#fff;cursor:pointer; }.wui-theme-color input[type=text] { width:100%;box-sizing:border-box;padding:5px 7px; }.wui-theme-status { min-height:20px;color:var(--wui-muted);font-size:11px; }.theme-picked { outline:2px solid var(--theme-settings-accent)!important;outline-offset:2px; }.wui-theme-paint.active { color:#9f4206!important;background:#fff2e9!important;border-color:var(--wui-accent)!important; }.wui-theme-swatches { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px; }.wui-theme-swatch { min-height:34px;text-align:left; }.wui-theme-swatch i { display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:5px;vertical-align:-1px;background:var(--swatch); }
    body.theme-painting,body.theme-painting * { cursor:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'%3E%3Cpath fill='%23e66b1a' stroke='%232b170b' stroke-width='1.4' d='m4 17 9-9 4 4-9 9H4zM14 7l2-2 4 4-2 2z'/%3E%3C/svg%3E") 3 21,crosshair!important; }
  `;
  document.head.appendChild(style);
}
export function createEnvironmentUi({ perfLog, sliderState, audio, creatures } = {}) {
  installStyle();
  installThemeStyle();

  const shell = makeEl('aside');
  shell.id = 'workshop-ui';
  shell.setAttribute('aria-label', 'Workshop inspector');

  const tabs = makeEl('nav', 'wui-tabs');
  const tabDefs = [
    ['world', 'World', 'W'],
    ['entities', 'Entities', 'E'],
    ['player', 'Player', 'P'],
    ['assets', 'Assets', 'A'],
    ['audio', 'Audio', 'S'],
    ['theme', 'Theme', 'C'],
    ['tools', 'Tools', 'T'],
  ];
  const tabButtons = new Map(tabDefs.map(([id, label, icon]) => {
    const btn = makeTab(id, label, icon);
    tabs.appendChild(btn);
    return [id, btn];
  }));

  const panels = makeEl('div', 'wui-panels');
  const panelEls = new Map();
  const hosts = new Map();
  for (const [id, label] of tabDefs) {
    const panel = makeEl('section', 'wui-panel');
    panel.dataset.panel = id;
    const panelHeader = makeEl('header', 'wui-panel-header');
    panelHeader.appendChild(makeEl('span', '', label));
    const close = makeEl('button', '', 'X');
    close.type = 'button'; close.title = 'Close inspector';
    close.setAttribute('aria-label', 'Close inspector');
    close.addEventListener('click', () => activate(null));
    panelHeader.appendChild(close);
    const content = makeEl('div', 'wui-panel-content');
    panel.append(panelHeader, content);
    panels.appendChild(panel);
    panelEls.set(id, panel);
    hosts.set(id, content);
  }
  const resizeNub = makeEl('div', 'wui-resize-nub');
  resizeNub.setAttribute('role', 'separator');
  resizeNub.setAttribute('aria-label', 'Resize inspector');
  resizeNub.tabIndex = 0;
  shell.append(tabs, panels, resizeNub);
  document.body.appendChild(shell);

  const worldHost = hosts.get('world');
  const entitiesHost = hosts.get('entities');
  const playerHost = hosts.get('player');
  const assetsHost = hosts.get('assets');
  const audioHost = hosts.get('audio');
  const themeHost = hosts.get('theme');
  const toolsHost = hosts.get('tools');
  worldHost.id = 'scene-section-host';
  entitiesHost.id = 'entities-section-host';
  playerHost.id = 'player-section-host';
  assetsHost.id = 'models-section-host';
  toolsHost.id = 'tools-section-host';

  function makeParentGroup(host, title) {
    const group = makeEl('section', 'wui-parent-group');
    const head = makeEl('div', 'wui-parent-head', title);
    const body = makeEl('div', 'wui-parent-body');
    head.addEventListener('click', () => group.classList.toggle('collapsed'));
    group.append(head, body); host.appendChild(group);
    return body;
  }
  const creatureHost = makeParentGroup(entitiesHost, 'Procedural Creatures');
  const analyticsHost = makeParentGroup(creatureHost, 'Analytics');

  let activeTab = null;
  function activate(tab) {
    activeTab = tab && panelEls.has(tab) ? tab : null;
    shell.classList.toggle('collapsed', !activeTab);
    for (const [id, btn] of tabButtons) {
      const active = id === activeTab;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-expanded', active ? 'true' : 'false');
    }
    for (const [id, panel] of panelEls) panel.classList.toggle('active', id === activeTab);
  }
  tabs.addEventListener('click', event => {
    const btn = event.target.closest('.wui-tab');
    if (btn) activate(btn.dataset.tab === activeTab ? null : btn.dataset.tab);
  });
  const INSPECTOR_WIDTH_KEY = 'pcw:inspectorWidth';
  const applyInspectorWidth = width => {
    const next = Math.max(0, Math.min(window.innerWidth - 56, Math.round(width)));
    shell.style.setProperty('--wui-panel-width', `${next}px`);
    try { localStorage.setItem(INSPECTOR_WIDTH_KEY, String(next)); } catch {}
  };
  try {
    const saved = Number(localStorage.getItem(INSPECTOR_WIDTH_KEY));
    if (Number.isFinite(saved)) applyInspectorWidth(saved);
  } catch {}
  let resizeStart = null;
  resizeNub.addEventListener('pointerdown', event => {
    if (shell.classList.contains('collapsed')) return;
    resizeStart = { x: event.clientX, width: shell.getBoundingClientRect().width - 56 };
    resizeNub.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  resizeNub.addEventListener('pointermove', event => {
    if (!resizeStart) return;
    applyInspectorWidth(resizeStart.width + resizeStart.x - event.clientX);
  });
  const endResize = event => {
    if (!resizeStart) return;
    resizeStart = null;
    if (resizeNub.hasPointerCapture(event.pointerId)) resizeNub.releasePointerCapture(event.pointerId);
  };
  resizeNub.addEventListener('pointerup', endResize);
  resizeNub.addEventListener('pointercancel', endResize);
  resizeNub.addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const width = shell.getBoundingClientRect().width - 56;
    applyInspectorWidth(width + (event.key === 'ArrowLeft' ? 16 : -16));
    event.preventDefault();
  });
  window.addEventListener('resize', () => {
    const width = shell.getBoundingClientRect().width - 56;
    if (width > 0) applyInspectorWidth(width);
  });
  activate(null);

  const sectionMeta = {
    'Scene': ['world', 'Terrain & Map'], 'Biomes': ['world', 'Biomes & Materials'],
    'Forest': ['world', 'Vegetation · Forest'], 'Tree LOD': ['world', 'Vegetation · Tree LOD'],
    'Grass': ['world', 'Vegetation · Grass'], 'Plants': ['world', 'Vegetation · Plants'],
    'Dressing (rocks/deadfall)': ['world', 'Landscape Details'], 'Rock material': ['world', 'Landscape Details · Rock Material'],
    'Time of day': ['world', 'Atmosphere · Time'], 'Lighting': ['world', 'Atmosphere · Lighting'],
    'Post': ['world', 'Image FX · Post'], 'Particles': ['world', 'Image FX · Particles'],
    'Perf A/B': ['tools', 'Performance A/B'], 'ClaudeCraft Mobs': ['entities', 'ClaudeCraft Mobs'],
    'Combat Bots': ['entities', 'Combat Bots'], 'Squads & Outposts': ['entities', 'Combat Bots · Squads & Outposts'],
    'Bot Inspector': ['entities', 'Combat Bots · Inspector'], 'Player': ['player', 'Utilities'],
  };
  function routeFor(title) {
    if (sectionMeta[title]) return sectionMeta[title];
    if (title.startsWith('Water')) return ['world', title.replace(/^Water\s*/, 'Water · ')];
    if (title.startsWith('Clouds')) return ['world', 'Atmosphere · ' + title];
    if (title === 'Sky' || title.startsWith('Sky ')) return ['world', 'Atmosphere · ' + title];
    return ['world', title];
  }
  function routeSections() {
    const ctrlBody = document.getElementById('ctrl-body');
    if (ctrlBody) for (const sec of ctrlBody.querySelectorAll(':scope > .sec')) sec.dataset.ctrlSection = '1';
    for (const sec of document.querySelectorAll('.sec[data-ctrl-section="1"]')) {
      const titleEl = sec.querySelector('.sec-head span');
      const original = sec.dataset.originalTitle || titleEl?.textContent?.trim() || '';
      sec.dataset.originalTitle = original;
      const [tab, label] = routeFor(original);
      if (titleEl) titleEl.textContent = label;
      const target = hosts.get(tab);
      if (target && sec.parentElement !== target) target.appendChild(sec);
    }
  }
  let ctrlMounted = false;
  function mountCtrl() {
    const ctrl = document.getElementById('ctrl');
    const ctrlBody = document.getElementById('ctrl-body');
    if (!ctrl || !ctrlBody) return;
    if (!ctrlMounted) { worldHost.appendChild(ctrl); ctrlMounted = true; }
    routeSections();
  }
  function mountFixedUi() {
    mountCtrl();
    const portUi = document.getElementById('port-creature-ui');
    if (portUi && portUi.parentElement !== creatureHost) creatureHost.insertBefore(portUi, analyticsHost.parentElement);
    if (portUi && !portUi.querySelector('.wui-subhead')) {
      const populationLabel = makeEl('div', 'wui-subhead', 'Population');
      portUi.insertBefore(populationLabel, portUi.firstChild);
    }
    const commandHud = document.getElementById('creature-command-hud');
    if (commandHud && commandHud.parentElement !== creatureHost) creatureHost.insertBefore(commandHud, analyticsHost.parentElement);
    const fps = document.getElementById('fps');
    if (fps && fps.parentElement !== playerHost) playerHost.appendChild(fps);
  }
  mountFixedUi();
  const mountObserver = new MutationObserver(mountFixedUi);
  mountObserver.observe(document.body, { childList: true, subtree: false });
  const ctrlObserver = new MutationObserver(routeSections);
  const ctrlBody = document.getElementById('ctrl-body');
  if (ctrlBody) ctrlObserver.observe(ctrlBody, { childList: true });

  const toast = makeEl('div', 'wui-toast'); document.body.appendChild(toast);
  let toastTimer;
  function showToast(message) {
    toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 1500);
  }
  shell.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || button.classList.contains('wui-tab')) return;
    const label = (button.textContent || '').trim();
    if (/save|import|export|reset|clear|download/i.test(label)) showToast(label ? `${label} complete` : 'Action complete');
  });
  shell.addEventListener('input', event => {
    const input = event.target;
    if (input?.type !== 'range') return;
    const row = input.previousElementSibling;
    const value = row?.querySelector('span:last-child');
    if (!value) return;
    value.classList.remove('wui-value-updated'); requestAnimationFrame(() => value.classList.add('wui-value-updated'));
    clearTimeout(value._wuiTimer); value._wuiTimer = setTimeout(() => value.classList.remove('wui-value-updated'), 180);
  });

  buildStatsPanel(analyticsHost, creatures);
  buildThemePanel(themeHost);
  buildPerfPanel(toolsHost, perfLog);
  buildPresetsPanel(toolsHost, sliderState);
  if (audio) buildAudioPanel(audioHost, audio);
  else audioHost.appendChild(makeEl('div', 'wui-empty', 'Audio controller unavailable.'));

  return { activate, updatePerf: toolsHost._updatePerf };
}

function buildThemePanel(host) {
  const STORAGE_KEY = 'pcw:uiTheme';
  const defaults = {
    settings: { surface: '#ffffff', border: '#d8d8d8', text: '#151515', accent: '#e66b1a', opacity: 100 },
    map: { surface: '#12161c', border: '#d8dee9', text: '#d8dee9', accent: '#77c8a1', opacity: 86 },
    hud: { surface: '#121820', border: '#d7dde7', text: '#d7dde7', accent: '#61d394', opacity: 88 },
  };
  const labels = { settings: 'Settings panel', map: 'Map', hud: 'Health / ammo' };
  const elementLabels = { surface: 'Surface', border: 'Border', text: 'Text', accent: 'Accent' };
  const theme = JSON.parse(JSON.stringify(defaults));
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    for (const component of Object.keys(defaults)) Object.assign(theme[component], saved?.[component] || {});
  } catch {}
  const root = document.documentElement;
  const hexToRgba = (hex, opacity) => {
    const value = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : '000000';
    const r = parseInt(value.slice(0, 2), 16), g = parseInt(value.slice(2, 4), 16), b = parseInt(value.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${Math.max(0, Math.min(100, opacity)) / 100})`;
  };
  const apply = () => {
    for (const [component, values] of Object.entries(theme)) {
      for (const element of ['surface', 'border', 'text', 'accent']) root.style.setProperty(`--theme-${component}-${element}`, values[element]);
      root.style.setProperty(`--theme-${component}-surface-rgba`, hexToRgba(values.surface, values.opacity));
    }
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(theme)); } catch {}
  };
  apply();

  const editor = makeEl('div', 'wui-card');
  editor.appendChild(makeEl('div', 'wui-card-title', 'Color editor'));
  const editorBody = makeEl('div', 'wui-card-body');
  const componentField = makeEl('label', 'wui-field'); componentField.append(makeEl('span', '', 'Component'));
  const componentSelect = document.createElement('select');
  for (const [key, label] of Object.entries(labels)) { const option = document.createElement('option'); option.value = key; option.textContent = label; componentSelect.appendChild(option); }
  componentField.appendChild(componentSelect);
  const elementField = makeEl('label', 'wui-field'); elementField.append(makeEl('span', '', 'Element'));
  const elementSelect = document.createElement('select');
  for (const [key, label] of Object.entries(elementLabels)) { const option = document.createElement('option'); option.value = key; option.textContent = label; elementSelect.appendChild(option); }
  elementField.appendChild(elementSelect);
  const colorField = makeEl('label', 'wui-theme-color');
  const colorInput = document.createElement('input'); colorInput.type = 'color';
  const hexInput = document.createElement('input'); hexInput.type = 'text'; hexInput.maxLength = 7; hexInput.setAttribute('aria-label', 'Hex color');
  colorField.append(colorInput, hexInput);
  const opacityField = makeEl('div', 'wui-field');
  opacityField.appendChild(makeEl('span', '', 'Surface opacity'));
  const opacityOutput = document.createElement('output');
  const opacityInput = document.createElement('input'); opacityInput.type = 'range'; opacityInput.min = '20'; opacityInput.max = '100'; opacityInput.step = '1';
  opacityField.append(opacityOutput, opacityInput);
  const opacity = { field: opacityField, input: opacityInput, output: opacityOutput, format: value => `${Math.round(value)}%` };
  const paintBtn = makeEl('button', 'wui-btn wui-theme-paint', 'Paint: Off'); paintBtn.type = 'button';
  const status = makeEl('div', 'wui-theme-status', 'Choose a component or paint one in the game.');
  editorBody.append(componentField, elementField, colorField, opacity.field, paintBtn, status); editor.appendChild(editorBody);

  const paletteCard = makeEl('div', 'wui-card'); paletteCard.appendChild(makeEl('div', 'wui-card-title', 'Color maps'));
  const paletteBody = makeEl('div', 'wui-card-body'); const swatches = makeEl('div', 'wui-theme-swatches');
  const palettes = {
    Default: defaults,
    Ember: { settings: { surface: '#fff8f2', border: '#e6a172', text: '#28150a', accent: '#d85b10', opacity: 100 }, map: { surface: '#25130d', border: '#f0a05f', text: '#ffe1c5', accent: '#ff7a1a', opacity: 88 }, hud: { surface: '#22140f', border: '#e79361', text: '#ffe1c5', accent: '#ff7a1a', opacity: 90 } },
    Ocean: { settings: { surface: '#f4fbff', border: '#8bc6df', text: '#082334', accent: '#1689bb', opacity: 100 }, map: { surface: '#071c2b', border: '#71bedb', text: '#d5f3ff', accent: '#4ed3bf', opacity: 88 }, hud: { surface: '#092333', border: '#6bbbd7', text: '#d7f4ff', accent: '#4ed3bf', opacity: 90 } },
    Mono: { settings: { surface: '#f7f7f7', border: '#8b8b8b', text: '#111111', accent: '#4b4b4b', opacity: 100 }, map: { surface: '#171717', border: '#a9a9a9', text: '#f2f2f2', accent: '#d4d4d4', opacity: 88 }, hud: { surface: '#171717', border: '#bdbdbd', text: '#f4f4f4', accent: '#e4e4e4', opacity: 90 } },
  };
  for (const [name, palette] of Object.entries(palettes)) {
    const button = makeEl('button', 'wui-theme-swatch'); button.type = 'button'; button.style.setProperty('--swatch', palette.settings.accent); button.innerHTML = `<i></i>${name}`;
    button.addEventListener('click', () => { for (const key of Object.keys(theme)) Object.assign(theme[key], palette[key]); apply(); sync(); status.textContent = `${name} color map applied.`; }); swatches.appendChild(button);
  }
  const reset = makeEl('button', 'wui-btn', 'Reset component'); reset.type = 'button'; reset.addEventListener('click', () => { Object.assign(theme[componentSelect.value], defaults[componentSelect.value]); apply(); sync(); });
  paletteBody.append(swatches, reset); paletteCard.appendChild(paletteBody);
  host.append(editor, paletteCard);

  let painting = false;
  const sync = () => {
    const values = theme[componentSelect.value]; const element = elementSelect.value;
    colorInput.value = values[element]; hexInput.value = values[element]; opacity.input.value = String(values.opacity); opacity.output.textContent = opacity.format(values.opacity);
  };
  const setElement = value => {
    if (!/^#[0-9a-f]{6}$/i.test(value)) { sync(); return; }
    theme[componentSelect.value][elementSelect.value] = value.toLowerCase(); apply(); sync();
  };
  componentSelect.addEventListener('change', sync); elementSelect.addEventListener('change', sync);
  colorInput.addEventListener('input', () => setElement(colorInput.value));
  hexInput.addEventListener('change', () => setElement(hexInput.value));
  opacity.input.addEventListener('input', () => { theme[componentSelect.value].opacity = Number(opacity.input.value); apply(); sync(); });
  let paintedElement = null;
  const setPaintTarget = picked => {
    paintedElement?.classList.remove('theme-picked');
    paintedElement = picked.node || null;
    paintedElement?.classList.add('theme-picked');
    componentSelect.value = picked.component; elementSelect.value = picked.element; sync();
    status.textContent = `${labels[picked.component]} / ${elementLabels[picked.element]} selected.`;
  };
  const setPainting = active => {
    painting = active; document.body.classList.toggle('theme-painting', active); paintBtn.classList.toggle('active', active); paintBtn.textContent = active ? 'Paint: On' : 'Paint: Off';
    if (active) status.textContent = 'Right-click an interface element to send it to the color editor.';
  };  paintBtn.addEventListener('click', () => setPainting(!painting));
  document.addEventListener('pointerdown', event => {
    if (!painting || event.button !== 2) return;
    const target = event.target;
    // While painting, only the color editor itself remains interactive.
    if (target.closest('.wui-theme-paint,.wui-theme-color,#theme-surface-opacity')) return;
    let picked = null;
    const hud = target.closest('#combat-hud');
    const map = target.closest('#mp-dock,#world-map');
    const settings = target.closest('#workshop-ui');
    if (hud) {
      const node = target.closest('#combat-hp-fill,#combat-hp,#combat-weapon,#combat-ammo') || hud;
      picked = { component: 'hud', element: node.matches('#combat-hp-fill') ? 'accent' : node.matches('#combat-hp,#combat-weapon,#combat-ammo') ? 'text' : 'surface', node };
    } else if (map) {
      const node = target.closest('#mp-finder canvas,#world-map canvas,button,.mp-layer') || map;
      picked = { component: 'map', element: node.matches('canvas') ? 'surface' : node.matches('button,.mp-layer') ? 'accent' : 'border', node };
    } else if (settings) {
      const node = target.closest('button,input,select,.wui-tab,.wui-panel-header,.wui-parent-head,.sec-head') || settings;
      picked = { component: 'settings', element: node.matches('button,input,select,.wui-tab') ? 'accent' : node.matches('.wui-panel-header,.wui-parent-head,.sec-head') ? 'border' : 'surface', node };
    }
    if (!picked) return;
    event.preventDefault(); event.stopImmediatePropagation(); setPaintTarget(picked);
  }, true);  // Theme paint uses right-click, leaving every normal left-click interaction untouched.
  document.addEventListener('contextmenu', event => {
    if (!painting || !event.target.closest('#workshop-ui,#mp-dock,#world-map,#combat-hud')) return;
    event.preventDefault(); event.stopImmediatePropagation();
  }, true);  sync();
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

function buildPresetsPanel(host, sliderState) {
  if (!sliderState) {
    host.appendChild(makeEl('div', 'wui-empty', 'Preset saving unavailable.'));
    return;
  }

  const saveCard = makeEl('div', 'wui-card');
  saveCard.appendChild(makeEl('div', 'wui-card-title', 'Save current sliders'));
  const saveBody = makeEl('div', 'wui-card-body wui-capture');
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'State name';
  nameInput.style.flex = '1 1 140px';
  nameInput.style.minWidth = '0';
  const saveBtn = makeEl('button', '', 'Save');
  saveBody.append(nameInput, saveBtn);
  saveCard.appendChild(saveBody);

  const ioCard = makeEl('div', 'wui-card');
  ioCard.appendChild(makeEl('div', 'wui-card-title', 'Backup'));
  const ioBody = makeEl('div', 'wui-card-body wui-capture');
  const exportBtn = makeEl('button', '', 'Export all');
  const importBtn = makeEl('button', '', 'Import');
  const importInput = document.createElement('input');
  importInput.type = 'file';
  importInput.accept = 'application/json,.json';
  importInput.style.display = 'none';
  ioBody.append(exportBtn, importBtn, importInput);
  ioCard.appendChild(ioBody);

  const listCard = makeEl('div', 'wui-card');
  listCard.appendChild(makeEl('div', 'wui-card-title', 'Saved states'));
  const listBody = makeEl('div', 'wui-card-body');
  listCard.appendChild(listBody);

  host.append(saveCard, ioCard, listCard);

  function downloadStates(states, filename) {
    const blob = new Blob([JSON.stringify(states, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function fmtAgo(iso) {
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  }

  function renderList() {
    listBody.innerHTML = '';
    const entries = Object.entries(sliderState.list());
    if (entries.length === 0) {
      listBody.appendChild(makeEl('div', 'wui-empty', 'No saved states yet.'));
      return;
    }
    entries.sort((a, b) => b[1].savedAt.localeCompare(a[1].savedAt));
    for (const [name, entry] of entries) {
      const row = makeEl('div', 'wui-capture');
      row.style.marginBottom = '6px';
      const label = makeEl('span', '', `${name} · ${fmtAgo(entry.savedAt)}`);
      label.style.flex = '1 1 100%';
      const loadBtn = makeEl('button', '', 'Load');
      const exportOneBtn = makeEl('button', '', 'Export');
      const delBtn = makeEl('button', '', 'Delete');
      loadBtn.addEventListener('click', () => sliderState.apply(entry.values));
      exportOneBtn.addEventListener('click', () => downloadStates({ [name]: entry }, `slider-state-${name}.json`));
      delBtn.addEventListener('click', () => { sliderState.remove(name); renderList(); });
      row.append(label, loadBtn, exportOneBtn, delBtn);
      listBody.appendChild(row);
    }
  }

  saveBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) return;
    const existing = sliderState.list();
    if (existing[name] && !window.confirm(`Overwrite saved state "${name}"?`)) return;
    sliderState.save(name, sliderState.capture());
    nameInput.value = '';
    renderList();
  });

  exportBtn.addEventListener('click', () => {
    const states = sliderState.list();
    if (Object.keys(states).length === 0) return;
    const stamp = new Date().toISOString().slice(0, 10);
    downloadStates(states, `slider-states-${stamp}.json`);
  });

  importBtn.addEventListener('click', () => importInput.click());
  importInput.addEventListener('change', async () => {
    const file = importInput.files?.[0];
    importInput.value = '';
    if (!file) return;
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      window.alert('Could not read that file — expected exported slider-state JSON.');
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const overwrite = sliderState.import
      ? window.confirm('Overwrite states whose names already exist? Cancel keeps existing ones.')
      : false;
    const added = sliderState.import
      ? sliderState.import(parsed, { overwrite })
      : (Object.entries(parsed).forEach(([n, e]) => e?.values && sliderState.save(n, e.values)), Object.keys(parsed).length);
    renderList();
    window.alert(`Imported ${added} saved state${added === 1 ? '' : 's'}.`);
  });

  renderList();
}

// Expected `audio.getState()` shape (see docs/subsystems/infra.md for the authoritative copy):
//   {
//     masterVolume, musicVolume, sfxVolume,       // 0..1
//     masterMuted, musicMuted, sfxMuted,          // bool
//     musicOutput,                                // 'global' | 'speaker'
//     musicSource,                                // 'game' | 'folder'
//     speakerBehavior,                             // 'front' | 'behind' | 'orbit' | 'above'
//     effects: { bass, echo, reverb, attenuation, tempo, pitch },
//     sfxFolderStatus,                             // display string, e.g. "142 events loaded"
//     musicFolderStatus,                           // display string for scanned folder music
//     currentTrackLabel,                           // display string
//     musicPlaying,                                // bool
//   }
// Ranges are the controller's own units (setMusicEffect clamps to these): dB for bass, percent
// for echo/reverb/attenuation, percent-of-normal for tempo, semitones for pitch. These used to be
// 0-1/0.5-2, which meant every slider fed setMusicEffect a value it clamped to its floor --
// tempo 1 became 50 (half speed) and refresh() then displayed the real 100 as a pinned "2.00x".
const AUDIO_EFFECT_DEFS = [
  ['bass', 'Bass', 0, 18, 0.5, 0, v => `${Number(v).toFixed(1)} dB`],
  ['echo', 'Echo', 0, 100, 1, 0, v => `${Math.round(v)}%`],
  ['reverb', 'Reverb', 0, 100, 1, 0, v => `${Math.round(v)}%`],
  ['attenuation', 'Attenuation', 0, 200, 1, 100, v => `${Math.round(v)}%`],
  ['tempo', 'Tempo', 50, 200, 1, 100, v => `${(Number(v) / 100).toFixed(2)}x`],
  ['pitch', 'Pitch', -12, 12, 1, 0, v => `${v > 0 ? '+' : ''}${v} st`],
];

function buildAudioPanel(host, audio) {
  // Keyboard/pointer input inside this panel must not leak to the viewer's global
  // shortcut handlers (KeyM/KeyQ/KeyF/etc. attached at window/document level).
  for (const type of ['keydown', 'keyup', 'keypress', 'pointerdown', 'pointerup', 'pointermove', 'click']) {
    host.addEventListener(type, e => e.stopPropagation());
  }

  function makeSlider(id, label, min, max, step, initial, format) {
    const field = makeEl('div', 'wui-field');
    const span = makeEl('span', '', label);
    const output = document.createElement('output');
    output.id = `${id}-out`;
    output.textContent = format(initial);
    const input = document.createElement('input');
    input.type = 'range';
    input.id = id;
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(initial);
    field.append(span, output, input);
    return { field, input, output, format };
  }

  function makeCheck(id, label, initial) {
    const row = makeEl('div', 'wui-check');
    const span = makeEl('span', '', label);
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = !!initial;
    row.append(span, input);
    return { row, input };
  }

  function makeSegGroup(idPrefix, options) {
    const group = makeEl('div', 'wui-seg-group');
    group.id = `${idPrefix}-group`;
    const buttons = new Map();
    for (const [value, label] of options) {
      const btn = makeEl('button', 'wui-seg', label);
      btn.type = 'button';
      btn.id = `${idPrefix}-${value}`;
      btn.dataset.value = value;
      group.appendChild(btn);
      buttons.set(value, btn);
    }
    function setActive(value) {
      for (const [v, btn] of buttons) btn.classList.toggle('active', v === value);
    }
    return { group, buttons, setActive };
  }

  // --- SFX folder ------------------------------------------------------
  const folderCard = makeEl('div', 'wui-card');
  folderCard.appendChild(makeEl('div', 'wui-card-title', 'SFX folder'));
  const folderBody = makeEl('div', 'wui-card-body');
  const folderActions = makeEl('div', 'wui-actions');
  const pickBtn = makeEl('button', 'wui-btn primary', 'Choose SFX folder…');
  pickBtn.id = 'audio-sfx-pick';
  const restoreBtn = makeEl('button', 'wui-btn', 'Restore last folder');
  restoreBtn.id = 'audio-sfx-restore';
  folderActions.append(pickBtn, restoreBtn);
  const status = makeEl('div', 'wui-status', 'No SFX folder loaded.');
  status.id = 'audio-sfx-status';
  folderBody.append(folderActions, status);
  folderCard.appendChild(folderBody);

  pickBtn.addEventListener('click', () => audio.pickSfxFolder?.());
  restoreBtn.addEventListener('click', () => audio.restoreSfxFolder?.());

  // --- Specific music folder ----------------------------------------------
  const musicFolderCard = makeEl('div', 'wui-card');
  musicFolderCard.appendChild(makeEl('div', 'wui-card-title', 'Music folder'));
  const musicFolderBody = makeEl('div', 'wui-card-body');
  const musicFolderActions = makeEl('div', 'wui-actions');
  const musicPickBtn = makeEl('button', 'wui-btn primary', 'Choose music folder...');
  musicPickBtn.id = 'audio-music-pick';
  const musicRestoreBtn = makeEl('button', 'wui-btn', 'Restore music folder');
  musicRestoreBtn.id = 'audio-music-restore';
  musicFolderActions.append(musicPickBtn, musicRestoreBtn);
  const musicFolderStatus = makeEl('div', 'wui-status', 'No music folder loaded.');
  musicFolderStatus.id = 'audio-music-status';
  musicFolderBody.append(musicFolderActions, musicFolderStatus);
  musicFolderCard.appendChild(musicFolderBody);

  musicPickBtn.addEventListener('click', () => audio.pickMusicFolder?.());
  musicRestoreBtn.addEventListener('click', () => audio.restoreMusicFolder?.());

  // --- Volume + mute -----------------------------------------------------
  const volumeCard = makeEl('div', 'wui-card');
  volumeCard.appendChild(makeEl('div', 'wui-card-title', 'Volume'));
  const volumeBody = makeEl('div', 'wui-card-body');
  const volumeDefs = [
    ['master', 'Master'],
    ['music', 'Music'],
    ['sfx', 'SFX'],
  ];
  const volumeSliders = new Map();
  const muteChecks = new Map();
  for (const [kind, label] of volumeDefs) {
    const slider = makeSlider(`audio-vol-${kind}`, label, 0, 1, 0.01, 1, v => `${Math.round(v * 100)}%`);
    slider.input.addEventListener('input', () => {
      slider.output.textContent = slider.format(Number(slider.input.value));
      audio.setVolume?.(kind, Number(slider.input.value));
    });
    volumeBody.appendChild(slider.field);
    volumeSliders.set(kind, slider);

    const check = makeCheck(`audio-mute-${kind}`, `Mute ${label.toLowerCase()}`, false);
    check.input.addEventListener('change', () => audio.setMuted?.(kind, check.input.checked));
    volumeBody.appendChild(check.row);
    muteChecks.set(kind, check);
  }
  volumeCard.appendChild(volumeBody);

  // --- Output -------------------------------------------------------------
  const outputCard = makeEl('div', 'wui-card');
  outputCard.appendChild(makeEl('div', 'wui-card-title', 'Music output'));
  const outputBody = makeEl('div', 'wui-card-body');
  const sourceLabel = makeEl('div', 'wui-row');
  sourceLabel.innerHTML = '<span>Music source</span>';
  outputBody.appendChild(sourceLabel);
  const sourceSeg = makeSegGroup('audio-source', [['game', 'Game'], ['folder', 'Folder']]);
  outputBody.appendChild(sourceSeg.group);
  const outputLabel = makeEl('div', 'wui-row');
  outputLabel.innerHTML = '<span>Output</span>';
  outputBody.appendChild(outputLabel);
  const outputSeg = makeSegGroup('audio-output', [['global', 'Global'], ['speaker', 'Speaker']]);
  outputBody.appendChild(outputSeg.group);
  const behaviorLabel = makeEl('div', 'wui-row');
  behaviorLabel.innerHTML = '<span>Speaker behavior</span>';
  outputBody.appendChild(behaviorLabel);
  const behaviorSeg = makeSegGroup('audio-speaker', [
    ['front', 'Front'],
    ['behind', 'Behind'],
    ['orbit', 'Orbit'],
    ['above', 'Above'],
  ]);
  outputBody.appendChild(behaviorSeg.group);
  outputCard.appendChild(outputBody);

  for (const [value, btn] of sourceSeg.buttons) {
    btn.addEventListener('click', () => {
      audio.setMusicSource?.(value);
      sourceSeg.setActive(value);
    });
  }
  for (const [value, btn] of outputSeg.buttons) {
    btn.addEventListener('click', () => {
      audio.setMusicOutput?.(value);
      outputSeg.setActive(value);
    });
  }
  for (const [value, btn] of behaviorSeg.buttons) {
    btn.addEventListener('click', () => {
      audio.setMusicSpeakerBehavior?.(value);
      behaviorSeg.setActive(value);
    });
  }

  // --- Music effects --------------------------------------------------------
  const fxCard = makeEl('div', 'wui-card');
  fxCard.appendChild(makeEl('div', 'wui-card-title', 'Music processing'));
  const fxBody = makeEl('div', 'wui-card-body');
  const fxSliders = new Map();
  for (const [key, label, min, max, step, initial, format] of AUDIO_EFFECT_DEFS) {
    const slider = makeSlider(`audio-fx-${key}`, label, min, max, step, initial, format);
    slider.input.addEventListener('input', () => {
      const value = Number(slider.input.value);
      slider.output.textContent = slider.format(value);
      audio.setMusicEffect?.(key, value);
    });
    fxBody.appendChild(slider.field);
    fxSliders.set(key, slider);
  }
  fxCard.appendChild(fxBody);

  // --- Track controls (optional playlist browsing) ---------------------------
  const trackCard = makeEl('div', 'wui-card');
  trackCard.appendChild(makeEl('div', 'wui-card-title', 'Track'));
  const trackBody = makeEl('div', 'wui-card-body wui-capture');
  const trackLabel = makeEl('span', '', 'No track playing');
  trackLabel.id = 'audio-track-label';
  trackLabel.style.flex = '1 1 100%';
  const prevBtn = makeEl('button', '', '⏮');
  prevBtn.id = 'audio-track-prev';
  const playBtn = makeEl('button', '', '▶');
  playBtn.id = 'audio-track-play';
  const nextBtn = makeEl('button', '', '⏭');
  nextBtn.id = 'audio-track-next';
  const shuffleBtn = makeEl('button', '', '🔀');
  shuffleBtn.id = 'audio-track-shuffle';
  shuffleBtn.title = 'Shuffle playback order';
  trackBody.append(trackLabel, prevBtn, playBtn, nextBtn, shuffleBtn);
  trackCard.appendChild(trackBody);

  prevBtn.addEventListener('click', () => audio.prevTrack?.());
  playBtn.addEventListener('click', () => audio.togglePlayback?.());
  nextBtn.addEventListener('click', () => audio.nextTrack?.());
  shuffleBtn.addEventListener('click', () => audio.setShuffle?.(!audio.getState?.().shuffle));

  // Full playlist for whichever source is active (Game -> sound-map.json music_menu/music_game,
  // Folder -> the picked "Music folder"), so a specific track can be clicked directly instead of
  // only stepping with prev/next. Rows are rebuilt only when the track list itself changes
  // (lastPlaylistKey) so the active highlight can update every refresh without full DOM churn.
  const trackList = makeEl('div', 'wui-list');
  trackList.id = 'audio-track-list';
  Object.assign(trackList.style, { maxHeight: '160px', overflowY: 'auto', marginTop: '8px' });
  trackCard.appendChild(trackList);
  let lastPlaylistKey = '';
  const trackRows = new Map(); // path -> row element

  host.append(folderCard, musicFolderCard, volumeCard, outputCard, fxCard, trackCard);

  function refresh(state) {
    if (!state) return;
    for (const [kind, slider] of volumeSliders) {
      const value = Number(state[`${kind}Volume`] ?? 1);
      slider.input.value = String(value);
      slider.output.textContent = slider.format(value);
    }
    for (const [kind, check] of muteChecks) {
      check.input.checked = !!state[`${kind}Muted`];
    }
    sourceSeg.setActive(state.musicSource ?? 'game');
    outputSeg.setActive(state.musicOutput ?? 'global');
    behaviorSeg.setActive(state.speakerBehavior ?? 'front');
    const effects = state.effects || {};
    for (const [key, slider] of fxSliders) {
      if (!(key in effects)) continue;
      const value = Number(effects[key]);
      slider.input.value = String(value);
      slider.output.textContent = slider.format(value);
    }
    status.textContent = state.sfxFolderStatus || 'No SFX folder loaded.';
    musicFolderStatus.textContent = state.musicFolderStatus || 'No music folder loaded.';
    const folderSourceBtn = sourceSeg.buttons.get('folder');
    if (folderSourceBtn) folderSourceBtn.disabled = !Number(state.musicFolderTrackCount || 0);
    trackLabel.textContent = state.currentTrackLabel || 'No track playing';
    playBtn.textContent = state.musicPlaying ? '⏸' : '▶';
    shuffleBtn.classList.toggle('active', !!state.shuffle);
    shuffleBtn.title = `Shuffle playback order (${state.shuffle ? 'on' : 'off'})`;

    const playlist = state.playlist || [];
    const playlistKey = playlist.map(t => t.eventId + '|' + t.path).join('\n');
    if (playlistKey !== lastPlaylistKey) {
      lastPlaylistKey = playlistKey;
      trackList.replaceChildren();
      trackRows.clear();
      for (const entry of playlist) {
        const row = makeEl('div', 'wui-list-item', entry.label || entry.path);
        row.addEventListener('click', () => audio.playTrack?.(entry));
        trackList.appendChild(row);
        trackRows.set(entry.path, row);
      }
    }
    for (const [path, row] of trackRows) {
      row.classList.toggle('active', path === state.currentTrackPath);
    }
  }

  refresh(audio.getState?.());
  audio.subscribe?.(refresh);
}
