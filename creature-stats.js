// Creature stats/analysis panel: live per-creature locomotion metrics, an in-memory +
// localStorage "database" of captured creatures with user-assignable categories, JSON/CSV
// export, and a set of robust figures — per-creature bar, distribution histogram, X-vs-Y
// relationship (with least-squares fit + Pearson r), PCA ordination, per-category comparison,
// and a live time-series trace. Charts live in stats-charts.js; PCA/stats in stats-math.js.
//
// Reads only public surface: creatureSource.system.creatures / .selected / .select(), and each
// creature's public fields (plan, gait, armSettings, legs, health, metrics).

import { pca, pearson, linreg } from './stats-math.js';
import { scatterPlot, barPlot, histPlot, linePlot, rampColor, catColorFor } from './stats-charts.js';

const LS_KEY = 'pcw:creatureStatsDb';
const NUM = v => (typeof v === 'number' && isFinite(v)) ? v : 0;

function el(tag, cls, txt) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
}

// Feature descriptors — drive the readout, table columns, and chart metric picker.
// `static: true` = a design parameter; otherwise a runtime locomotion metric.
const FEATURES = [
  { key: 'legs',          label: 'Legs',        static: true,  fmt: v => String(v) },
  { key: 'segsPerLeg',    label: 'Segs/leg',    static: true,  fmt: v => String(v) },
  { key: 'legPairs',      label: 'Leg rows',    static: true,  fmt: v => String(v) },
  { key: 'bodyW',         label: 'Body W',      static: true,  fmt: v => v.toFixed(2) },
  { key: 'bodyH',         label: 'Body H',      static: true,  fmt: v => v.toFixed(2) },
  { key: 'bodyD',         label: 'Body D',      static: true,  fmt: v => v.toFixed(2) },
  { key: 'bodyHeight',    label: 'Ride height', static: true,  fmt: v => v.toFixed(2) },
  { key: 'maxSpeedCfg',   label: 'Gait maxSpd', static: true,  fmt: v => v.toFixed(2) },
  { key: 'stepDuration',  label: 'Step dur',    static: true,  fmt: v => v.toFixed(3) },
  { key: 'stepLift',      label: 'Step lift',   static: true,  fmt: v => v.toFixed(2) },
  { key: 'comfortH',      label: 'Comfort H',   static: true,  fmt: v => v.toFixed(2) },
  { key: 'maxConcurrent', label: 'Concurrency', static: true,  fmt: v => v.toFixed(2) },
  { key: 'armCount',      label: 'Arms',        static: true,  fmt: v => String(v) },
  { key: 'speedAvg',      label: 'Speed',       unit: 'm/s',   fmt: v => v.toFixed(2) },
  { key: 'maxSpeed',      label: 'Desired spd', unit: 'm/s',   fmt: v => v.toFixed(2) },
  { key: 'effPct',        label: 'Speed eff',   unit: '%',     fmt: v => Math.round(v) + '%' },
  { key: 'headingErrDeg', label: 'Heading err', unit: '°',     fmt: v => Math.round(v) + '°' },
  { key: 'groundedPct',   label: 'Grounded',    unit: '%',     fmt: v => Math.round(v) + '%' },
  { key: 'stallPct',      label: 'Stall',       unit: '%',     fmt: v => Math.round(v) + '%' },
  { key: 'distance',      label: 'Distance',    unit: 'm',     fmt: v => v.toFixed(1) },
  { key: 'dragAvg',       label: 'Limb drag',   unit: 'm',     fmt: v => v.toFixed(2) },
  { key: 'scanFailPct',   label: 'Scan fail',   unit: '%',     fmt: v => Math.round(v) + '%' },
  { key: 'stuckPct',      label: 'Stuck legs',  unit: '%',     fmt: v => Math.round(v) + '%' },
  { key: 'comOutsidePct', label: 'Off-balance', unit: '%',     fmt: v => Math.round(v) + '%' },
  { key: 'wobbleDeg',     label: 'Wobble',      unit: '°',     fmt: v => v.toFixed(1) + '°' },
];
const READOUT_KEYS = ['speedAvg', 'maxSpeed', 'effPct', 'headingErrDeg', 'groundedPct', 'stallPct',
  'dragAvg', 'stuckPct', 'scanFailPct', 'comOutsidePct', 'wobbleDeg', 'distance'];
const TABLE_KEYS = ['legs', 'maxSpeedCfg', 'effPct', 'stallPct', 'dragAvg', 'stuckPct', 'wobbleDeg'];
// Numeric feature space fed to the PCA ordination (static design params + runtime metrics).
const ORDINATION_KEYS = ['legs', 'segsPerLeg', 'maxSpeedCfg', 'stepDuration', 'stepLift', 'comfortH',
  'maxConcurrent', 'armCount', 'effPct', 'headingErrDeg', 'groundedPct', 'stallPct', 'dragAvg',
  'scanFailPct', 'stuckPct', 'comOutsidePct', 'wobbleDeg'];
const featByKey = k => FEATURES.find(f => f.key === k);

// Flat feature record from a live creature (all public fields). Exported for tests.
export function extractFeatures(c) {
  const g = c.gait || {}, p = c.plan || {}, bs = p.bodyScale || {};
  const m = c.metrics || {};
  const rows = c.legs ? new Set(c.legs.map(l => l.row)).size : 0;
  return {
    legs: c.legs?.length || 0,
    segsPerLeg: c.legs?.[0]?.segments?.length || 0,
    legPairs: rows,
    bodyW: NUM(bs.x), bodyH: NUM(bs.y), bodyD: NUM(bs.z),
    bodyHeight: NUM(p.bodyHeight),
    maxSpeedCfg: NUM(g.maxSpeed),
    stepDuration: NUM(g.stepDuration),
    stepLift: NUM(g.stepLift),
    comfortH: NUM(g.comfort?.h),
    maxConcurrent: NUM(g.maxConcurrentFraction),
    armCount: c.armSettings?.count ?? (c.arms?.length || 0),
    health: NUM(c.health), teamId: NUM(c.teamId),
    speedAvg: NUM(m.speedAvg),
    maxSpeed: NUM(m.maxSpeed),
    effPct: NUM(m.effAvg) * 100,
    headingErrDeg: NUM(m.headingErrAvg) * 180 / Math.PI,
    groundedPct: NUM(m.groundedAvg) * 100,
    stallPct: NUM(m.stallFrac) * 100,
    distance: NUM(m.distance),
    dragAvg: NUM(m.dragAvg),
    scanFailPct: NUM(m.scanFailPct),
    stuckPct: NUM(m.stuckPct),
    comOutsidePct: NUM(m.comOutsidePct),
    wobbleDeg: NUM(m.wobbleDeg),
    simTime: NUM(m.simTime),
  };
}

function loadDb() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function saveDb(db) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(db)); } catch { /* quota/full — keep in-memory */ }
}

export function toCsv(db) {
  const cols = ['id', 'label', 't', 'category', ...FEATURES.map(f => f.key)];
  const head = cols.join(',');
  const lines = db.map(r => cols.map(c => {
    const v = r[c];
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(','));
  return [head, ...lines].join('\n');
}
function download(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Pure binning — exported for tests (the histogram figure itself lives in stats-charts.js).
export function histogram(values, bins = 10) {
  if (!values.length) return { counts: new Array(bins).fill(0), min: 0, max: 0 };
  const min = Math.min(...values), max = Math.max(...values);
  const span = (max - min) || 1;
  const counts = new Array(bins).fill(0);
  for (const v of values) {
    let b = Math.floor((v - min) / span * bins);
    if (b >= bins) b = bins - 1; if (b < 0) b = 0;
    counts[b]++;
  }
  return { counts, min, max };
}

const CSS = `
.cstat-note{opacity:.6;font-size:12px;padding:6px 2px}
.cstat-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:6px}
.cstat-metric{background:rgba(255,255,255,.04);border-radius:6px;padding:5px 7px}
.cstat-metric .k{font-size:10px;opacity:.55;text-transform:uppercase;letter-spacing:.04em}
.cstat-metric .v{font-size:14px;font-variant-numeric:tabular-nums;margin-top:1px}
.cstat-row{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}
.cstat-row .wui-btn{flex:1;min-width:74px}
.cstat-tablewrap{max-height:180px;overflow:auto;border:1px solid rgba(255,255,255,.06);border-radius:6px}
.cstat-table{width:100%;border-collapse:collapse;font-size:11px;font-variant-numeric:tabular-nums}
.cstat-table th,.cstat-table td{padding:3px 6px;text-align:right;white-space:nowrap}
.cstat-table th{position:sticky;top:0;background:#1c2026;opacity:.85;font-weight:600}
.cstat-table th:first-child,.cstat-table td:first-child{text-align:left}
.cstat-table tr:nth-child(even) td{background:rgba(255,255,255,.02)}
.cstat-table tbody tr{cursor:pointer}
.cstat-table tbody tr:hover:not(.gone) td{background:rgba(255,255,255,.06)}
.cstat-table tbody tr.sel td{background:rgba(255,209,102,.18)}
.cstat-table tbody tr.gone{opacity:.4;cursor:default}
.cstat-canvas{width:100%;height:132px;display:block;border-radius:6px;background:rgba(0,0,0,.18)}
.cstat-pick{width:100%;margin-bottom:6px}
.cstat-catinput{flex:2;min-width:120px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:5px;color:inherit;padding:4px 7px;font-size:12px}
.cstat-seg{display:flex;gap:0}
.cstat-seg .wui-btn{flex:1;border-radius:0;opacity:.7}
.cstat-seg .wui-btn:first-child{border-radius:6px 0 0 6px}
.cstat-seg .wui-btn:last-child{border-radius:0 6px 6px 0}
.cstat-seg .wui-btn.active{opacity:1;background:rgba(123,216,143,.28);box-shadow:inset 0 0 0 1px rgba(123,216,143,.5)}
`;

export function buildStatsPanel(host, source) {
  if (!document.getElementById('cstat-style')) {
    const s = el('style'); s.id = 'cstat-style'; s.textContent = CSS; document.head.appendChild(s);
  }
  const sys = source && source.system;
  if (!sys) { host.appendChild(el('div', 'cstat-note', 'Creature system unavailable.')); return { update() {} }; }

  let db = loadDb();
  let nextId = db.reduce((mx, r) => Math.max(mx, r.id || 0), 0) + 1;
  const idMap = new WeakMap();
  const idFor = c => { let id = idMap.get(c); if (!id) { id = nextId++; idMap.set(c, id); } return id; };
  let metricKey = 'effPct', colorKey = 'category', traceKey = 'speedAvg';
  let xKey = 'comfortH', yKey = 'dragAvg', compKey = 'dragAvg';
  let mode = 'live'; // 'live' = re-sampled from living creatures each tick; 'snapshot' = saved captures
  let traceId = null, traceBuf = [];
  const catById = new Map(db.filter(r => r.category).map(r => [r.id, r.category])); // live tags keyed by creature id
  const distinctCats = () => [...new Set([...db.map(r => r.category), ...catById.values()].filter(Boolean))];
  // A live dataset row is a living creature re-sampled fresh; snapshot rows are frozen in `db`.
  const liveRow = c => { const id = idFor(c); const r = { ...extractFeatures(c), id, t: Date.now(), category: catById.get(id) || '' }; r.label = `#${id} ${r.legs}L·${r.segsPerLeg}s`; return r; };
  const dataset = () => mode === 'live' ? sys.creatures.map(liveRow) : db;

  // ---- Mode toggle (live vs snapshot) ----
  const modeCard = el('div', 'wui-card');
  const modeBody = el('div', 'wui-card-body');
  const modeSeg = el('div', 'cstat-seg');
  const liveBtn = el('button', 'wui-btn', 'Live');
  const snapBtn = el('button', 'wui-btn', 'Snapshot');
  modeSeg.append(liveBtn, snapBtn);
  const modeNote = el('div', 'cstat-note', '');
  modeBody.append(modeSeg, modeNote);
  modeCard.appendChild(modeBody);

  // ---- Live readout card ----
  const live = el('div', 'wui-card');
  live.appendChild(el('div', 'wui-card-title', 'Selected creature'));
  const liveBody = el('div', 'wui-card-body');
  const liveGrid = el('div', 'cstat-grid');
  const metricEls = {};
  for (const key of READOUT_KEYS) {
    const f = featByKey(key);
    const cell = el('div', 'cstat-metric');
    cell.appendChild(el('div', 'k', f.label));
    const v = el('div', 'v', '--'); cell.appendChild(v);
    liveGrid.appendChild(cell); metricEls[key] = v;
  }
  liveBody.appendChild(liveGrid);
  const capRow = el('div', 'cstat-row');
  const addBtn = el('button', 'wui-btn primary', 'Add selected');
  const addAllBtn = el('button', 'wui-btn', 'Capture all');
  capRow.append(addBtn, addAllBtn);
  const catRow = el('div', 'cstat-row');
  const catInput = el('input', 'cstat-catinput');
  catInput.setAttribute('list', 'cstat-cats'); catInput.placeholder = 'category (e.g. dragging)';
  const catList = el('datalist'); catList.id = 'cstat-cats';
  const tagBtn = el('button', 'wui-btn', 'Tag selected');
  catRow.append(catInput, tagBtn, catList);
  liveBody.append(capRow, catRow);
  live.appendChild(liveBody);

  // ---- Database card ----
  const dbCard = el('div', 'wui-card');
  dbCard.appendChild(el('div', 'wui-card-title', 'Database'));
  const dbBody = el('div', 'wui-card-body');
  const dbCount = el('div', 'cstat-note', '0 captured');
  const dbHint = el('div', 'cstat-note', 'Click a row to toggle its selection box.');
  const tableWrap = el('div', 'cstat-tablewrap');
  const table = el('table', 'cstat-table');
  tableWrap.appendChild(table);
  const dbRow = el('div', 'cstat-row');
  const exportJson = el('button', 'wui-btn', 'Export JSON');
  const exportCsv = el('button', 'wui-btn', 'Export CSV');
  const clearBtn = el('button', 'wui-btn', 'Clear');
  dbRow.append(exportJson, exportCsv, clearBtn);
  dbBody.append(dbCount, dbHint, tableWrap, dbRow);
  dbCard.appendChild(dbBody);

  // ---- Charts card ----
  const chartCard = el('div', 'wui-card');
  chartCard.appendChild(el('div', 'wui-card-title', 'Charts'));
  const chartBody = el('div', 'wui-card-body');
  const pick = el('select', 'cstat-pick wui-select');
  for (const f of FEATURES) {
    const o = el('option', null, f.label + (f.unit ? ` (${f.unit})` : ''));
    o.value = f.key; if (f.key === metricKey) o.selected = true;
    pick.appendChild(o);
  }
  const barLabel = el('div', 'cstat-note', 'Per-creature (bar)');
  const barCanvas = el('canvas', 'cstat-canvas');
  const histLabel = el('div', 'cstat-note', 'Distribution (histogram)');
  const histCanvas = el('canvas', 'cstat-canvas');
  chartBody.append(pick, barLabel, barCanvas, histLabel, histCanvas);
  chartCard.appendChild(chartBody);

  // ---- Relationship (X vs Y) card — the "does parameter A drive metric B?" figure ----
  const relCard = el('div', 'wui-card');
  relCard.appendChild(el('div', 'wui-card-title', 'Relationship (X vs Y)'));
  const relBody = el('div', 'wui-card-body');
  const relRow = el('div', 'cstat-row');
  const xPick = el('select', 'cstat-pick wui-select');
  const yPick = el('select', 'cstat-pick wui-select');
  for (const f of FEATURES) {
    const ox = el('option', null, f.label); ox.value = f.key; if (f.key === xKey) ox.selected = true; xPick.appendChild(ox);
    const oy = el('option', null, f.label); oy.value = f.key; if (f.key === yKey) oy.selected = true; yPick.appendChild(oy);
  }
  relRow.append(el('span', 'cstat-note', 'X'), xPick, el('span', 'cstat-note', 'Y'), yPick);
  const relCanvas = el('canvas', 'cstat-canvas'); relCanvas.style.height = '180px';
  const relNote = el('div', 'cstat-note', 'Capture ≥3 creatures to plot.');
  relBody.append(relRow, relCanvas, relNote);
  relCard.appendChild(relBody);

  // ---- Ordination (PCA) card ----
  const ordCard = el('div', 'wui-card');
  ordCard.appendChild(el('div', 'wui-card-title', 'Ordination (PCA)'));
  const ordBody = el('div', 'wui-card-body');
  const colorRow = el('div', 'cstat-row');
  colorRow.appendChild(el('span', 'cstat-note', 'Color by'));
  const colorPick = el('select', 'cstat-pick wui-select');
  { const o = el('option', null, 'Category'); o.value = 'category'; o.selected = colorKey === 'category'; colorPick.appendChild(o); }
  for (const f of FEATURES) {
    const o = el('option', null, f.label); o.value = f.key;
    if (f.key === colorKey) o.selected = true;
    colorPick.appendChild(o);
  }
  colorRow.appendChild(colorPick);
  const ordCanvas = el('canvas', 'cstat-canvas');
  ordCanvas.style.height = '150px';
  const ordNote = el('div', 'cstat-note', 'Capture ≥3 creatures to plot.');
  ordBody.append(colorRow, ordCanvas, ordNote);
  ordCard.appendChild(ordBody);

  // ---- Category comparison card ----
  const compCard = el('div', 'wui-card');
  compCard.appendChild(el('div', 'wui-card-title', 'By category'));
  const compBody = el('div', 'wui-card-body');
  const compPick = el('select', 'cstat-pick wui-select');
  for (const f of FEATURES) { const o = el('option', null, f.label + (f.unit ? ` (${f.unit})` : '')); o.value = f.key; if (f.key === compKey) o.selected = true; compPick.appendChild(o); }
  const compCanvas = el('canvas', 'cstat-canvas'); compCanvas.style.height = '170px';
  const compNote = el('div', 'cstat-note', 'Tag creatures with categories to compare.');
  compBody.append(compPick, compCanvas, compNote);
  compCard.appendChild(compBody);

  // ---- Live trace card ----
  const traceCard = el('div', 'wui-card');
  traceCard.appendChild(el('div', 'wui-card-title', 'Live trace (selected)'));
  const traceBody = el('div', 'wui-card-body');
  const tracePick = el('select', 'cstat-pick wui-select');
  for (const f of FEATURES.filter(x => !x.static)) {
    const o = el('option', null, f.label + (f.unit ? ` (${f.unit})` : '')); o.value = f.key;
    if (f.key === 'speedAvg') o.selected = true;
    tracePick.appendChild(o);
  }
  const traceCanvas = el('canvas', 'cstat-canvas');
  traceBody.append(tracePick, traceCanvas);
  traceCard.appendChild(traceBody);

  host.append(modeCard, live, dbCard, chartCard, relCard, ordCard, compCard, traceCard);

  // ---- behaviour ----
  // Redraw the table + every db-derived figure. In live mode each pulls from dataset() = the
  // living roster; in snapshot mode from the frozen `db`.
  function refreshAll() { renderDb(); renderCharts(); renderRelationship(); renderOrdination(); renderComparison(); }
  // Capture/update a snapshot row. `category` (if given) overrides; else keep the existing tag so a
  // re-capture (metrics refresh) doesn't wipe a manual label.
  function capture(c, category) {
    if (!c) return;
    const id = idFor(c);
    const prev = db.find(r => r.id === id);
    const cat = (category != null && category !== '') ? category : (catById.get(id) ?? (prev ? prev.category : ''));
    if (cat) catById.set(id, cat);
    const rec = { ...extractFeatures(c), id, label: null, t: Date.now(), category: cat || '' };
    rec.label = `#${id} ${rec.legs}L·${rec.segsPerLeg}s`;
    const i = db.findIndex(r => r.id === id);
    if (i >= 0) db[i] = rec; else db.push(rec);
    saveDb(db); refreshAll();
  }
  // Tag a living creature (both modes). Persists via catById and updates its snapshot row if any.
  function setCategory(c, cat) {
    if (!c) return;
    const id = idFor(c);
    catById.set(id, cat || '');
    const row = db.find(r => r.id === id);
    if (row) { row.category = cat || ''; saveDb(db); }
    refreshAll();
  }
  function applyMode() {
    const liveM = mode === 'live';
    liveBtn.classList.toggle('active', liveM);
    snapBtn.classList.toggle('active', !liveM);
    capRow.style.display = liveM ? 'none' : '';   // no capturing needed in live mode
    clearBtn.style.display = liveM ? 'none' : '';
    dbHint.style.display = liveM ? 'none' : '';
    modeNote.textContent = liveM
      ? 'Figures track every living creature, updating in real time. Tag to group; Export freezes a copy.'
      : 'Figures plot a saved database of captured creatures (persists across reloads).';
    refreshAll();
  }
  const curCat = () => catInput.value.trim();
  liveBtn.addEventListener('click', () => { mode = 'live'; applyMode(); });
  snapBtn.addEventListener('click', () => { mode = 'snapshot'; applyMode(); });
  addBtn.addEventListener('click', () => capture(sys.selected, curCat()));
  addAllBtn.addEventListener('click', () => { for (const c of sys.creatures) capture(c, curCat()); });
  tagBtn.addEventListener('click', () => setCategory(sys.selected, curCat()));
  exportJson.addEventListener('click', () => download('creature-stats.json', JSON.stringify(dataset(), null, 2), 'application/json'));
  exportCsv.addEventListener('click', () => download('creature-stats.csv', toCsv(dataset()), 'text/csv'));
  clearBtn.addEventListener('click', () => { db = []; saveDb(db); refreshAll(); });
  pick.addEventListener('change', () => { metricKey = pick.value; renderCharts(); });
  colorPick.addEventListener('change', () => { colorKey = colorPick.value; renderOrdination(); });
  xPick.addEventListener('change', () => { xKey = xPick.value; renderRelationship(); });
  yPick.addEventListener('change', () => { yKey = yPick.value; renderRelationship(); });
  compPick.addEventListener('change', () => { compKey = compPick.value; renderComparison(); });
  tracePick.addEventListener('change', () => { traceKey = tracePick.value; traceBuf = []; });

  function renderReadout() {
    const c = sys.selected;
    addBtn.disabled = !c;
    if (!c) { for (const k of READOUT_KEYS) metricEls[k].textContent = '--'; live.querySelector('.wui-card-title').textContent = 'Selected creature — none'; return null; }
    live.querySelector('.wui-card-title').textContent = `Selected creature #${idFor(c)}`;
    const f = extractFeatures(c);
    for (const k of READOUT_KEYS) metricEls[k].textContent = featByKey(k).fmt(NUM(f[k]));
    return f;
  }
  // reverse map: a db row's id -> its still-live creature (undefined if despawned). read-only (no id assignment).
  const liveById = id => sys.creatures.find(c => idMap.get(c) === id);
  function updateCatList() {
    catList.innerHTML = distinctCats().map(c => `<option value="${c.replace(/"/g, '&quot;')}">`).join('');
  }
  const cellText = (r, k) => k === 'label' ? r.label : k === 'category' ? (r.category || '—') : featByKey(k).fmt(NUM(r[k]));
  const colHead = k => k === 'label' ? 'creature' : k === 'category' ? 'cat' : featByKey(k).label;
  function renderDb() {
    const data = dataset();
    dbCount.textContent = `${data.length} ${mode === 'live' ? 'live' : 'captured'}`;
    updateCatList();
    const cols = ['label', 'category', ...TABLE_KEYS];
    let html = '<thead><tr>' + cols.map(k => `<th>${colHead(k)}</th>`).join('') + '</tr></thead><tbody>';
    for (const r of data) {
      const gone = mode !== 'live' && !liveById(r.id);
      html += `<tr data-id="${r.id}"${gone ? ' class="gone"' : ''}>` + cols.map(k => `<td>${cellText(r, k)}</td>`).join('') + '</tr>';
    }
    table.innerHTML = html + '</tbody>';
    renderDbSelection();
  }
  // highlight the row whose creature is currently selected (its box is shown). read-only lookup.
  function renderDbSelection() {
    const selId = sys.selected ? idMap.get(sys.selected) : null;
    for (const tr of table.querySelectorAll('tr[data-id]'))
      tr.classList.toggle('sel', Number(tr.dataset.id) === selId);
  }
  const featLabel = k => { const f = featByKey(k); return f.label + (f.unit ? ` (${f.unit})` : ''); };
  // Assign point colors from the current color-by key: categorical -> palette + legend,
  // numeric -> sequential ramp + colorbar. Mutates each point's .color, returns extras.
  function colorPoints(pts, rows) {
    if (colorKey === 'category') {
      const cats = distinctCats();
      pts.forEach((p, i) => { p.color = catColorFor(rows[i].category, cats); });
      const legend = cats.map(c => ({ label: c, color: catColorFor(c, cats) }));
      if (rows.some(r => !r.category)) legend.push({ label: '(none)', color: catColorFor('', cats) });
      return { legend: legend.length ? legend : null, colorbar: null };
    }
    const vals = rows.map(r => NUM(r[colorKey]));
    const mn = Math.min(...vals), mx = Math.max(...vals), sp = (mx - mn) || 1;
    pts.forEach((p, i) => { p.color = rampColor((vals[i] - mn) / sp); });
    return { legend: null, colorbar: { min: mn, max: mx, label: featByKey(colorKey).label } };
  }

  const needMsg = n => mode === 'live' ? `Need ≥${n} living creatures` : `Capture ≥${n} creatures`;
  function renderCharts() {
    const data = dataset(), cats = distinctCats();
    barPlot(barCanvas, {
      items: data.map(r => ({ label: '#' + r.id, value: NUM(r[metricKey]), color: catColorFor(r.category, cats) })),
      yLabel: featLabel(metricKey), empty: mode === 'live' ? 'No living creatures' : 'Capture creatures to chart',
    });
    histPlot(histCanvas, { values: data.map(r => NUM(r[metricKey])), bins: 12, xLabel: featLabel(metricKey) });
  }
  // Relationship: does independent parameter X drive dependent metric Y? Scatter + OLS fit + Pearson r.
  function renderRelationship() {
    const data = dataset();
    if (data.length < 3) { relNote.textContent = needMsg(3) + ' to plot.'; scatterPlot(relCanvas, { points: [], empty: needMsg(3) }); return; }
    const xs = data.map(r => NUM(r[xKey])), ys = data.map(r => NUM(r[yKey]));
    const fit = linreg(xs, ys);
    const cats = distinctCats();
    const points = data.map((r, i) => ({ x: xs[i], y: ys[i], label: '#' + r.id, color: catColorFor(r.category, cats) }));
    const fx = featByKey(xKey), fy = featByKey(yKey);
    scatterPlot(relCanvas, {
      points, xLabel: featLabel(xKey), yLabel: featLabel(yKey), regression: fit,
      annotations: [`r = ${fit.r.toFixed(2)}    r² = ${fit.r2.toFixed(2)}    n = ${data.length}`,
        `y = ${fit.slope.toPrecision(3)}·x + ${fit.intercept.toPrecision(3)}`],
      legend: cats.length ? cats.map(c => ({ label: c, color: catColorFor(c, cats) })) : null,
    });
    const dir = fit.r > 0.15 ? `higher ${fy.label}` : fit.r < -0.15 ? `lower ${fy.label}` : `no clear trend`;
    const strength = Math.abs(fit.r) > 0.7 ? 'strong' : Math.abs(fit.r) > 0.4 ? 'moderate' : Math.abs(fit.r) > 0.15 ? 'weak' : 'no';
    relNote.textContent = `${strength} correlation (r=${fit.r.toFixed(2)}): higher ${fx.label} → ${dir}.`;
  }
  function renderOrdination() {
    const data = dataset();
    if (data.length < 3) { ordNote.textContent = needMsg(3) + ' to plot.'; scatterPlot(ordCanvas, { points: [], empty: needMsg(3) }); return; }
    const matrix = data.map(r => ORDINATION_KEYS.map(k => NUM(r[k])));
    const { scores, explained } = pca(matrix, 2);
    const points = scores.map((s, i) => ({ x: s[0], y: s[1], label: '#' + data[i].id }));
    const { legend, colorbar } = colorPoints(points, data);
    scatterPlot(ordCanvas, {
      points, xLabel: `PC1 (${Math.round(explained[0] * 100)}%)`, yLabel: `PC2 (${Math.round((explained[1] || 0) * 100)}%)`,
      legend, colorbar,
    });
    ordNote.textContent = `n=${data.length} · ${ORDINATION_KEYS.length} features · colored by ${colorKey === 'category' ? 'category' : featByKey(colorKey).label}`;
  }
  // Mean of a metric per category (whisker = ±1 SD) — the "everything I labelled X shares this" view.
  function renderComparison() {
    const data = dataset(), cats = distinctCats();
    const uncat = data.filter(r => !r.category);
    if (!cats.length) { compNote.textContent = 'Tag creatures with categories to compare.'; barPlot(compCanvas, { items: [], empty: 'No categories yet' }); return; }
    const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
    const groups = cats.map(cat => {
      const vals = data.filter(r => r.category === cat).map(r => NUM(r[compKey]));
      const mu = mean(vals);
      return { label: cat, value: mu, n: vals.length, spread: Math.sqrt(mean(vals.map(v => (v - mu) ** 2))), color: catColorFor(cat, cats) };
    }).filter(g => g.n > 0);
    if (uncat.length) { const vals = uncat.map(r => NUM(r[compKey])); groups.push({ label: '(none)', value: mean(vals), n: vals.length, spread: 0, color: catColorFor('', cats) }); }
    barPlot(compCanvas, { items: groups, yLabel: 'mean ' + featLabel(compKey) });
    compNote.textContent = `Mean ${featByKey(compKey).label} per category (whisker = ±1 SD).`;
  }

  // Click a db row to toggle that creature's selection box (only if it's still in the world).
  table.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]');
    if (!tr) return;
    const c = liveById(Number(tr.dataset.id));
    if (!c) return; // captured creature has despawned — nothing to box
    sys.select?.(sys.selected === c ? null : c);
    renderReadout(); renderDbSelection();
  });

  renderReadout(); applyMode(); // applyMode() does the initial refreshAll + sets toggle state

  // Live loop (only while the Stats tab is visible): readout+trace at ~8 Hz; in live mode the
  // db-derived figures re-sample the living roster and redraw at ~2.5 Hz (heavier: PCA etc.).
  let acc = 0, figAcc = 0, last = performance.now();
  function tick(now) {
    const dt = now - last; last = now;
    if (host.classList.contains('active')) {
      acc += dt; figAcc += dt;
      if (acc >= 120) {
        acc = 0;
        const f = renderReadout();
        renderDbSelection(); // keep row highlight in sync with selection made elsewhere (3D click, etc.)
        const id = sys.selected ? idFor(sys.selected) : null;
        if (id !== traceId) { traceId = id; traceBuf = []; } // reset on selection change
        if (f) { traceBuf.push(NUM(f[traceKey])); if (traceBuf.length > 180) traceBuf.shift(); }
        linePlot(traceCanvas, { samples: traceBuf, yLabel: featByKey(traceKey).label });
      }
      if (mode === 'live' && figAcc >= 400) { figAcc = 0; refreshAll(); }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  return { update() { renderReadout(); } };
}
