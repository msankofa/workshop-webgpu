// Builds the Stats tab of docs/render-pipeline-map.html from research/stats/base-game-performance-log.json.
// Run: node scratchpads/fps-churn/build-stats-tab.mjs   (rewrites the block between the STATS markers)
import fs from 'node:fs';

const LOG = 'research/stats/base-game-performance-log.json';
const PAGE = 'docs/render-pipeline-map.html';
const SINCE = '2026-09-08T02:00';
const IDLE_CONTAMINATED = ['2026-09-08T11:03:56'];   // tab idle mid-capture: meanBetween 691 ms, max 4797 ms

const entries = (JSON.parse(fs.readFileSync(LOG, 'utf8')).entries || [])
  .filter(e => String(e.capturedAt) > SINCE)
  .sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r1 = v => v == null || !Number.isFinite(+v) ? '–' : (+v).toFixed(1);
const r0 = v => v == null || !Number.isFinite(+v) ? '–' : String(Math.round(+v));
const hhmm = at => at.slice(11, 19);
const mainOf = lf => (lf?.scenes || []).slice().sort((a, b) => (b.draws || 0) - (a.draws || 0))[0] || null;

// ---- 1. sessions ---------------------------------------------------------------------------
const sessionRows = entries.map(e => {
  const p = e.performance || {}, tr = e.context?.render?.trace || {}, lf = tr.lastFrame || {}, main = mainOf(lf);
  const pa = p.passes || {};
  const idle = IDLE_CONTAMINATED.some(x => e.capturedAt.startsWith(x));
  return {
    at: hhmm(e.capturedAt), trace: tr.enabled ? (tr.timed === false ? 'on, timers off' : 'on') : 'off', idle,
    frames: p.sampleCount ?? p.series?.length, p50: p.frameMs?.p50, p95: p.frameMs?.p95, max: p.frameMs?.max,
    encP50: pa.passTraceEncodeMs?.p50, encP95: pa.passTraceEncodeMs?.p95,
    objects: main?.objects, draws: main?.draws, mats: main?.uniqueMaterials,
    refresh: main ? `${main.refreshes}/${main.refreshChecks}` : '–',
  };
});
const sessionsTable = `
<table>
<thead><tr><th>time (UTC)</th><th>trace</th><th>frames</th><th>frame p50</th><th>p95</th><th>max</th><th>encode p50</th><th>encode p95</th><th>main objects</th><th>draws</th><th>materials</th><th>refreshed / checked</th></tr></thead>
<tbody>${sessionRows.map(s => `<tr${s.idle ? ' class="dim"' : ''}><td>${s.at}${s.idle ? ' *' : ''}</td><td>${esc(s.trace)}</td><td>${r0(s.frames)}</td><td>${r1(s.p50)}</td><td>${r1(s.p95)}</td><td>${r1(s.max)}</td><td>${r1(s.encP50)}</td><td>${r1(s.encP95)}</td><td>${r0(s.objects)}</td><td>${r0(s.draws)}</td><td>${r0(s.mats)}</td><td>${esc(s.refresh)}</td></tr>`).join('')}</tbody>
</table>`;

// ---- 2. stage split (lastFrame + worstFrame), stacked bars -----------------------------------
const STAGES = [
  ['bindingsMs', 'bindings', '#2563eb'], ['nodesRenderMs', 'nodes (render)', '#7c3aed'], ['nodesBeforeMs', 'nodes (before)', '#a78bfa'],
  ['geometriesMs', 'geometries', '#059669'], ['pipelinesMs', 'pipelines', '#d97706'], ['drawMs', 'draw', '#dc2626'],
];
function stageBars(rows, title, note) {
  const W = 1000, LEFT = 120, BARH = 16, GAP = 8, scaleMax = Math.max(...rows.map(r => r.encode || 0), 1);
  const H = rows.length * (BARH + GAP) + 50;
  const x = v => LEFT + (v / scaleMax) * (W - LEFT - 20);
  let svg = `<svg viewBox="0 0 ${W} ${H}" class="fig"><text x="0" y="14" class="ftitle">${esc(title)}</text>`;
  rows.forEach((row, i) => {
    const y = 30 + i * (BARH + GAP); let cx = LEFT;
    svg += `<text x="0" y="${y + 12}" class="flabel">${esc(row.label)}</text>`;
    svg += `<rect x="${LEFT}" y="${y}" width="${(x(row.encode) - LEFT).toFixed(1)}" height="${BARH}" fill="#e5e7eb"/>`;
    for (const [k, , color] of STAGES) { const w = x(row[k] || 0) - LEFT; svg += `<rect x="${cx.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${BARH}" fill="${color}"/>`; cx += w; }
    svg += `<text x="${(x(row.encode) + 6).toFixed(1)}" y="${y + 12}" class="fval">${r1(row.encode)} ms</text>`;
  });
  let lx = LEFT; const ly = H - 8;
  for (const [, name, color] of STAGES) { svg += `<rect x="${lx}" y="${ly - 10}" width="10" height="10" fill="${color}"/><text x="${lx + 14}" y="${ly}" class="flabel">${esc(name)}</text>`; lx += 14 + name.length * 6.2 + 18; }
  svg += `<rect x="${lx}" y="${ly - 10}" width="10" height="10" fill="#e5e7eb"/><text x="${lx + 14}" y="${ly}" class="flabel">rest of encode</text></svg>`;
  return svg + (note ? `<p class="fnote">${note}</p>` : '');
}
const traced = entries.filter(e => e.context?.render?.trace?.enabled && !IDLE_CONTAMINATED.some(x => e.capturedAt.startsWith(x)));
const lastRows = traced.map(e => { const m = mainOf(e.context.render.trace.lastFrame) || {}; return { label: hhmm(e.capturedAt), encode: m.encodeMs, ...m }; });
const worstRows = traced.map(e => { const m = mainOf(e.context.render.trace.worstFrame) || {}; return { label: hhmm(e.capturedAt), encode: m.encodeMs, ...m }; }).filter(r => r.encode < 200);
function shareTable(rows) {
  const tot = {}; let enc = 0;
  for (const r of rows) { enc += r.encode || 0; for (const [k] of STAGES) tot[k] = (tot[k] || 0) + (r[k] || 0); }
  const rest = enc - Object.values(tot).reduce((a, b) => a + b, 0);
  return `<table class="narrow"><thead><tr><th>stage</th><th>summed ms</th><th>share of encode</th></tr></thead><tbody>${STAGES.map(([k, name]) => `<tr><td>${name}</td><td>${r1(tot[k])}</td><td>${(100 * tot[k] / enc).toFixed(0)}%</td></tr>`).join('')}<tr><td>rest (RenderObject lookup, needsRefresh, wrappers)</td><td>${r1(rest)}</td><td>${(100 * rest / enc).toFixed(0)}%</td></tr></tbody></table>`;
}

// ---- 3. spikes vs others --------------------------------------------------------------------
const COLS = ['frameMs', 'betweenMs', 'longTaskMs', 'terrainInFlight', 'terrainBusyWorkers', 'forestReculls', 'terrainInstalls'];
const spikeRows = traced.map(e => {
  const p = e.performance, K = p.seriesKeys, rows = p.series.map(r => Object.fromEntries(K.map((k, i) => [k, r[i]])));
  const thr = p.spikes.thresholdMs, sp = rows.filter(r => r.frameMs >= thr), ot = rows.filter(r => r.frameMs < thr);
  const mean = (a, k) => a.length ? a.reduce((s, r) => s + (+r[k] || 0), 0) / a.length : NaN;
  return { at: hhmm(e.capturedAt), thr, n: sp.length, cols: COLS.map(k => [mean(sp, k), mean(ot, k)]) };
});
const spikesTable = `
<table>
<thead><tr><th rowspan="2">time</th><th rowspan="2">threshold</th><th rowspan="2">spike frames</th>${COLS.map(c => `<th colspan="2">${c}</th>`).join('')}</tr>
<tr>${COLS.map(() => '<th>spikes</th><th>others</th>').join('')}</tr></thead>
<tbody>${spikeRows.map(s => `<tr><td>${s.at}</td><td>${r1(s.thr)}</td><td>${s.n}</td>${s.cols.map(([a, b]) => `<td class="${a > 1.5 * b && a > 0.5 ? 'hi' : ''}">${r1(a)}</td><td>${r1(b)}</td>`).join('')}</tr>`).join('')}</tbody>
</table>`;

// ---- 4. fixed measurements from this week's Node runs and earlier captures --------------------
const fixedTables = `
<h3>Terrain worker threads (within-capture, 2026-09-07)</h3>
<p>Frames grouped by how many pool workers held unacknowledged work at the frame's stamp. The busy count is an activity proxy: it approximates threads executing, it does not prove contention.</p>
<table class="narrow"><thead><tr><th>pool size</th><th>workers busy</th><th>frame p50</th><th>p95</th><th>dips &gt; 50 ms per 1000</th></tr></thead>
<tbody><tr><td>4</td><td>0</td><td>28.4</td><td>48.0</td><td>31</td></tr><tr><td>4</td><td>4</td><td>60.9</td><td>94.5</td><td>791</td></tr><tr><td>2</td><td>0</td><td>17.7</td><td>26.5</td><td>1</td></tr><tr><td>2</td><td>2</td><td>17.6</td><td>27.9</td><td>0</td></tr></tbody></table>
<p class="fnote">Sessions an hour apart; route and machine state uncontrolled, so the 4-vs-2 comparison rests on the within-capture rows, not on the idle baselines (which also differ: 28.4 vs 17.7). Default cap set to 2 (d3a01af). At 2 workers on 2026-09-08 the spike frames still carried more in-flight jobs than ordinary frames (table above).</p>

<h3>Forest census (shipped state)</h3>
<table class="narrow"><thead><tr><th>quantity</th><th>value</th><th>source</th></tr></thead>
<tbody><tr><td>species selected</td><td>8</td><td>base-game-default-state.json</td></tr><tr><td>variants per species</td><td>2</td><td>base-game-forest.js:32, same file</td></tr><tr><td>meshes per variant</td><td>9 (7 main + 2 shadow-only)</td><td>forest-gpu.js:487-520</td></tr><tr><td>forest meshes allocated</td><td>144</td><td>16 × 9</td></tr><tr><td>shadow draws in captures</td><td>32</td><td>16 × 2, trace</td></tr><tr><td>main-scene objects with / without plants</td><td>202 / 93</td><td>captures 2026-09-07</td></tr></tbody></table>

<h3>Pulled forest: vertex invocations relative to a compact mapping</h3>
<p>From pulledInvocationCost in forest-cull.js on the default palette's real LOD2 index counts (1092, 1092, 1356, 1356, 6660, 6660) with an even live mix. Arithmetic, not GPU timing: padded triangles raster nothing, so this costs frame time only if the rung is vertex-bound.</p>
<table class="narrow"><thead><tr><th>mapping</th><th>invocations vs compact</th></tr></thead>
<tbody><tr><td>slots, no slack</td><td>2.19×</td></tr><tr><td>slots, slack 1.25 (current default for 'pulled')</td><td>2.74×</td></tr><tr><td>slots, slack 2 (first commit)</td><td>4.39×</td></tr><tr><td>compact ('pulled-compact')</td><td>1.00× plus under one 3072-vertex chunk per frame</td></tr></tbody></table>

<h3>Material sharing: factory calls to build 3 crafts of one kind</h3>
<table class="narrow"><thead><tr><th>kind</th><th>before</th><th>after</th></tr></thead>
<tbody><tr><td>drone</td><td>21</td><td>4</td></tr><tr><td>ugv / buggy</td><td>18</td><td>6</td></tr><tr><td>plane</td><td>12</td><td>4</td></tr><tr><td>bird / recon / sentinel / agm</td><td>9 / 6 / 6 / 9</td><td>3 / 2 / 2 / 3</td></tr></tbody></table>
<p class="fnote">Measured in Node (test-flight-meshes.mjs). Identical materials shared the compiled pipeline before too; what they each owned was a bind group and a uniform buffer. GPU memory effect and live craft counts per match are unmeasured.</p>

<h3>BatchedMesh compaction, measured in Node on the shipped build</h3>
<table class="narrow"><thead><tr><th>case (4 geometries)</th><th>update ranges written</th></tr></thead>
<tbody><tr><td>delete the last, optimize()</td><td>0</td></tr><tr><td>delete the first, optimize()</td><td>3 (one per shifted geometry)</td></tr><tr><td>8 chunks, evict first</td><td>7 shifted</td></tr><tr><td>150 evict/refill cycles</td><td>slot arrays stay at 8</td></tr></tbody></table>
<p class="fnote">The comments had said compaction rewrites the whole buffer. It writes one range per shifted geometry; the worst case (earliest gap) is the whole tail. Logical bytes, not queue traffic.</p>

<h3>Refresh audit: its own allocation (fake renderer, 200 objects × 500 frames)</h3>
<table class="narrow"><thead><tr><th>version</th><th>young-generation GCs</th><th>wall ms per 100k audits</th><th>auditMs per object</th></tr></thead>
<tbody><tr><td>first (2098779)</td><td>516–538</td><td>388–397</td><td>0.003–0.004</td></tr><tr><td>current (4ce1ac4)</td><td>78</td><td>386–391</td><td>0.003–0.004</td></tr></tbody></table>
<p class="fnote">Node measurement with --max-semi-space-size=1; GC count is the allocation-rate proxy. The per-object cost in a real browser refresh is unknown until ?refreshaudit=1 has run.</p>

<h3>Sampling attribution (DevTools trace, 2026-09-07, 129,889 samples over ~66 s)</h3>
<table class="narrow"><thead><tr><th>stack</th><th>sample-weighted time</th></tr></thead>
<tbody><tr><td>render path, inclusive</td><td>46.2 s</td></tr><tr><td>_updateBindings, inclusive</td><td>17.37 s</td></tr><tr><td>node updateNode, inclusive</td><td>7.13 s</td></tr><tr><td>uniform-group update, inclusive</td><td>6.21 s</td></tr><tr><td>writeBuffer, leaf</td><td>3.97 s (3.29 s via bindings)</td></tr></tbody></table>
<p class="fnote">Inclusive figures overlap and must not be added. This is what pointed at bindings before the sub-phase timers existed; the timers above agree in shape.</p>
`;

// ---- assemble ---------------------------------------------------------------------------------
const stats = `
<section id="stats" hidden>
<h2>STATS BEHIND THE EDITS</h2>
<p class="lead">Every number here is either read from <code>research/stats/base-game-performance-log.json</code> by <code>scratchpads/fps-churn/build-stats-tab.mjs</code> (the session, stage and spike tables) or copied from a Node measurement named in its note. None of it is a browser visual check. Captures since ${esc(SINCE)}; rows marked * had the tab idle mid-capture and are excluded from the figures.</p>

<h3>Sessions</h3>
<p>Frame times are the interval before each row's stamp; encode percentiles are capture-wide from the frame profiler's pass slots (only present with the trace on). "refreshed / checked" is the count of objects that took Three's refresh branch over the count asked: it is 100% in every capture, which is the structural fact the refresh work rests on.</p>
${sessionsTable}

<h3>Where the encode goes, per object stage</h3>
<p>The six stages the trace times inside <code>_renderObjectDirect</code>, for the last traced frame of each capture (top) and the retained worst frame (bottom). The grey remainder is RenderObject lookup, the needsRefresh call and the wrappers themselves. The worst frames have the same shape as the last frames, every stage slower at the same object count.</p>
${stageBars(lastRows, 'Last traced frame, main scene')}
${stageBars(worstRows, 'Worst frame by encode, main scene (the 1,482 ms compile frame omitted for scale)')}
<div class="twocol">${shareTable(lastRows)}${shareTable(worstRows)}</div>
<p class="fnote">Left: last frames. Right: worst frames. One frame each per capture, so these are eight-frame samples, not capture-wide attribution; the capture-wide stage percentiles begin with captures made after c16551c.</p>

<h3>Spike frames against the rest, per capture</h3>
<p>A spike is a frame above the capture's own threshold (its p99). Columns are means over spike frames and over the others. Cells more than 1.5× their neighbour are highlighted. Worker counts are unacknowledged work, an activity proxy; between-frame time with no long task is time the browser did not give us.</p>
${spikesTable}
${fixedTables}
</section>`;

let page = fs.readFileSync(PAGE, 'utf8');
const start = page.indexOf('<!-- STATS:BEGIN -->'), end = page.indexOf('<!-- STATS:END -->');
if (start < 0 || end < 0) throw new Error('STATS markers missing in the page');
page = page.slice(0, start) + '<!-- STATS:BEGIN -->' + stats + '\n' + page.slice(end);
fs.writeFileSync(PAGE, page);
console.log(`stats tab rebuilt from ${entries.length} captures (${traced.length} traced, ${IDLE_CONTAMINATED.length} excluded)`);
