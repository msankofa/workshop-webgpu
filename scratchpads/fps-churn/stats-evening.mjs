// Stats-tab section 5: the 2026-09-08 evening captures (forest pair, worker A/B, GPU timestamps, heap).
// Imported by build-stats-tab.mjs; pure functions of the log entries.
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r1 = v => v == null || !Number.isFinite(+v) ? '–' : (+v).toFixed(1);
const r2 = v => v == null || !Number.isFinite(+v) ? '–' : (+v).toFixed(2);
const r0 = v => v == null || !Number.isFinite(+v) ? '–' : String(Math.round(+v));
const hhmm = at => at.slice(11, 19);
const rowsOf = p => p.series.map(r => Object.fromEntries(p.seriesKeys.map((k, i) => [k, r[i]])));
const mean = (a, k) => a.length ? a.reduce((s, r) => s + (+r[k] || 0), 0) / a.length : NaN;
const per1000 = (rows, ms) => Math.round(1000 * rows.filter(r => r.frameMs > ms).length / rows.length);
const SLOTS = ['simMs', 'bodiesMs', 'skyMs', 'terrainMs', 'terrainIntegrateMs', 'forestMs', 'grassMs'];
const slotSum = a => SLOTS.reduce((s, k) => s + (mean(a, k) || 0), 0);

export function tracePairSection(entries) {
  const caps = entries.filter(e => e.capturedAt >= '2026-09-09T00:20' && e.capturedAt < '2026-09-09T04:00' && e.context?.render?.trace?.enabled);
  if (!caps.length) return '';
  const rows = caps.map(e => {
    const lf = e.context.render.trace.lastFrame || {}, main = (lf.scenes || []).find(s => s.name === 'Scene') || {}, pa = e.performance.passes || {};
    const moving = rowsOf(e.performance).some(r => r.speed > 0.5);
    const top = (main.uniformWriteRows || []).slice(0, 3).map(r => `${r.count}× ${r.name.split(' @')[0]}${r.name.includes(' @') ? ' @' + r.name.split(' @')[1].split('/')[0] : ''}`).join('; ');
    const three = e.context?.render?.three; const plants = e.settingsAtStart?.treesEnabled ? ', plants on' : ''; const build = (three ? (three.sharedLightUniforms ? 'shared lights' : 'vendored, sharing off') : 'CDN 0.184') + plants;
    return `<tr><td>${hhmm(e.capturedAt)}</td><td>${moving ? 'moving' : 'standing'}, ${build}</td><td>${r1(e.performance.frameMs.p50)}</td><td>${r0(main.objects)}</td><td>${r1(main.encodeMs)}</td><td>${r1(main.bindingsMs)}</td><td>${r1(pa.passTraceBindingsMs?.p50)}</td><td>${r1(pa.passTraceBindingsMs?.p95)}</td><td>${r0(main.bindingWrites)}</td><td>${esc(top)}</td></tr>`;
  }).join('');
  return `
<h3>Standing against moving with the trace on (2026-09-09; plants and structures off; before and after the shared light uniforms)</h3>
<p>The same scene, first still, then walking, then still. "bindings" is the stage of the object encode that diffs and writes uniform buffers; "writes" is how many uniform buffers the backend was asked to write in the last frame of the capture, and the last column names the most-written uniforms with the object encoding them.</p>
<table><thead><tr><th>time</th><th></th><th>frame p50</th><th>main-scene objects</th><th>encode (last frame)</th><th>bindings (last frame)</th><th>bindings p50</th><th>p95</th><th>uniform writes</th><th>most written</th></tr></thead><tbody>${rows}</tbody></table>
<p class="fnote">Moving quadruples the bindings stage on the same objects, and the added writes are the camera view matrix and the light positions, each written once per instanced batch rather than once per frame: Three keys an instanced mesh's node build by its uuid (getMaterialCacheKey, a TODO citing PR 29066), so the light uniform nodes are rebuilt per mesh and the shared render bind group's identity check fails. The standing per-object writes (water and cloud numbers, one terrain batch number) are ours and small. The 01:49 to 01:50 rows are the vendored build with light and shadow uniform nodes cached per light (72977c0): the same walk writes 66 to 68 a frame and the bindings stage is 2 to 3 ms; the remaining moving writes are per-object matrices of objects that move. Sessions differ, so the frame times compare loosely; the per-frame write and stage figures compare directly. The 02:54 row is the control: same build and route, sharing off, 121 writes and a 17.4 ms bindings stage; its walk was slower (2.75 m/s against about 6.2 for the sharing-on rows) and an hour later, so its frame time is a cross-run observation while the write and bindings counts compare directly. The 03:08 rows are trees and grass on with sharing: about 100 more objects, encode 17 to 18 ms, the plant systems' own slots under 1 ms.</p>`;
}

export function eveningSection(entries) {
  const ev = entries.filter(e => e.capturedAt >= '2026-09-08T19:40' && e.capturedAt < '2026-09-08T20:10');
  if (!ev.length) return '';
  const url = e => e.context?.gpuTimestamps?.url || '(none)';
  const trees = e => e.settingsAtStart?.treesEnabled ? 'on' : 'off';

  // forest pair: standing, trees on, no flags
  const pair = ev.filter(e => url(e) === '(none)' && e.settingsAtStart?.treesEnabled && !rowsOf(e.performance).some(r => r.speed > 0.5));
  const pairTable = `<table class="narrow"><thead><tr><th>time</th><th>mode</th><th>frame p50</th><th>p95</th><th>max</th><th>std dev</th><th>forest draws</th><th>all draws p50</th><th>reported triangles p50</th><th>frames &gt; 33 ms per 1000</th><th>&gt; 50 ms</th><th>fallback</th></tr></thead><tbody>${pair.map(e => {
    const p = e.performance, f = e.context?.flora?.trees || {}, rows = rowsOf(p);
    return `<tr><td>${hhmm(e.capturedAt)}</td><td>${esc(e.settingsAtStart.forestDrawMode)}</td><td>${r1(p.frameMs.p50)}</td><td>${r1(p.frameMs.p95)}</td><td>${r1(p.frameMs.max)}</td><td>${r1(p.frameMs.stdDev)}</td><td>${r0(f.draws)}</td><td>${r0(p.drawCalls?.p50)}</td><td>${(p.triangles?.p50 / 1e6).toFixed(2)} M</td><td>${per1000(rows, 33.3)}</td><td>${per1000(rows, 50)}</td><td>${f.lastError ? esc(f.lastError) : 'none'}</td></tr>`;
  }).join('')}</tbody></table>`;

  // walking runs, trees and grass off: worker A/B and gputime
  const walking = ev.filter(e => rowsOf(e.performance).some(r => r.speed > 0.5));
  const abTable = `<table><thead><tr><th>time</th><th>URL</th><th>trees</th><th>frames</th><th>frame p50</th><th>p95</th><th>max</th><th>frames &gt; 33 ms per 1000</th><th>&gt; 50 ms</th><th>spikes (own p99)</th><th>spike between-frame ms</th><th>other</th><th>spike long task ms</th><th>other</th><th>spike in-flight</th><th>other</th><th>spike busy workers</th><th>other</th></tr></thead><tbody>${walking.map(e => {
    const p = e.performance, rows = rowsOf(p), thr = p.spikes.thresholdMs;
    const sp = rows.filter(r => r.frameMs >= thr && r.frameMs < 1000), ot = rows.filter(r => r.frameMs < thr);
    const c = (a, b) => `<td${a > 1.5 * b ? ' class="hot"' : ''}>${r1(a)}</td><td>${r1(b)}</td>`;
    return `<tr><td>${hhmm(e.capturedAt)}</td><td>${esc(url(e))}</td><td>${trees(e)}</td><td>${rows.length}</td><td>${r1(p.frameMs.p50)}</td><td>${r1(p.frameMs.p95)}</td><td>${r1(p.frameMs.max)}</td><td>${per1000(rows, 33.3)}</td><td>${per1000(rows, 50)}</td><td>${sp.length} (${(100 * sp.length / rows.length).toFixed(0)}%)</td>${c(mean(sp, 'betweenMs'), mean(ot, 'betweenMs'))}${c(mean(sp, 'longTaskMs'), mean(ot, 'longTaskMs'))}${c(mean(sp, 'terrainInFlight'), mean(ot, 'terrainInFlight'))}${c(mean(sp, 'terrainBusyWorkers'), mean(ot, 'terrainBusyWorkers'))}</tr>`;
  }).join('')}</tbody></table>`;

  // spike decomposition: where a spike frame's time is, against the ordinary frames of the same run
  const decompTable = `<table><thead><tr><th>time</th><th>trees</th><th colspan="5">spike frames (above the run's p99)</th><th colspan="5">other frames</th></tr><tr><th></th><th></th><th>frame</th><th>render call</th><th>timed slots</th><th>gap before</th><th>rest</th><th>frame</th><th>render call</th><th>timed slots</th><th>gap before</th><th>rest</th></tr></thead><tbody>${ev.map(e => {
    const p = e.performance, rows = rowsOf(p), thr = p.spikes.thresholdMs;
    const sp = rows.filter(r => r.frameMs >= thr && r.frameMs < 1000), ot = rows.filter(r => r.frameMs < thr);
    const cells = a => { const f = mean(a, 'frameMs'), rc = mean(a, 'postRenderMs'), sl = slotSum(a), b = mean(a, 'betweenMs'); return `<td>${r1(f)}</td><td>${r1(rc)}</td><td>${r1(sl)}</td><td>${r1(b)}</td><td>${r1(f - rc - sl - b)}</td>`; };
    return `<tr><td>${hhmm(e.capturedAt)}</td><td>${trees(e)}</td>${cells(sp)}${cells(ot)}</tr>`;
  }).join('')}</tbody></table>`;

  // gpu
  const gpu = ev.filter(e => e.context?.gpuTimestamps?.requested);
  const gpuTable = `<table class="narrow"><thead><tr><th>time</th><th>trees</th><th>frame p50</th><th>render call CPU p50</th><th>GPU render p50</th><th>p95</th><th>max</th><th>GPU compute p95</th><th>max</th><th>resolved</th></tr></thead><tbody>${gpu.map(e => {
    const p = e.performance, pa = p.passes || {}, g = e.context.gpuTimestamps;
    return `<tr><td>${hhmm(e.capturedAt)}</td><td>${trees(e)}</td><td>${r1(p.frameMs.p50)}</td><td>${r1(pa.passPostChainMs?.p50)}</td><td>${r2(pa.gpuRenderMs?.p50)}</td><td>${r2(pa.gpuRenderMs?.p95)}</td><td>${r2(pa.gpuRenderMs?.max)}</td><td>${r2(pa.gpuComputeMs?.p95)}</td><td>${r2(pa.gpuComputeMs?.max)}</td><td>${g.resolved}${g.lastError ? ' (' + esc(g.lastError) + ')' : ''}</td></tr>`;
  }).join('')}</tbody></table>`;

  // heap
  const heapTable = `<table><thead><tr><th>time</th><th>URL</th><th>trees</th><th>moving</th><th>heap growth MB/s</th><th>growth per frame MB</th><th>spikes with a drop &gt; 1 MB</th><th>other frames with a drop</th><th>drop sizes in spikes (MB)</th></tr></thead><tbody>${ev.map(e => {
    const p = e.performance, rows = rowsOf(p), thr = p.spikes.thresholdMs;
    let sd = 0, sn = 0, od = 0, on = 0, grow = 0, gn = 0; const drops = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i], dh = (r.heapMB || 0) - (rows[i - 1].heapMB || 0), spike = r.frameMs >= thr && r.frameMs < 1000;
      if (dh < -1) { if (spike) { sd++; drops.push(r0(dh)); } else od++; } else { grow += dh; gn++; }
      if (spike) sn++; else on++;
    }
    return `<tr><td>${hhmm(e.capturedAt)}</td><td>${esc(url(e))}</td><td>${trees(e)}</td><td>${rows.some(r => r.speed > 0.5) ? 'yes' : 'no'}</td><td>${r1(grow / p.measuredWindowSeconds)}</td><td>${r2(grow / gn)}</td><td>${sd}/${sn} (${(100 * sd / sn).toFixed(0)}%)</td><td>${od}/${on} (${(100 * od / on).toFixed(0)}%)</td><td>${drops.join(', ')}</td></tr>`;
  }).join('')}</tbody></table>`;

  return `
<h3>Forest: one draw per variant against the merged far-branch draw (2026-09-08, 19:42 to 19:45Z)</h3>
<p>Same spot, standing, trees on, no trace or audit flag. "forest draws" is the forest's own count of meshes drawn in the main scene. The reported triangle count multiplies the geometry's declared index count by its declared instance ceiling (<code>info.update</code> at three.webgpu.js:81505); under an indirect draw that is the ceiling the CPU declared, not the count the GPU drew, so the 50 M is not a measurement of GPU work. GPU time for this pair was not captured.</p>
${pairTable}
<p class="fnote">Fifteen fewer draws (the sixteen far-branch meshes became one) and no gain: the merged modes ran 1 to 2 ms slower at the median, within these runs' spread. Verdict: consolidating one role does not pay at this object count; the option stays default-off.</p>

<h3>Walking on the minimal scene: worker cap, GPU timestamps, and what spike frames carry</h3>
<p>Trees and grass off unless the trees column says on. Spike threshold is each capture's p99. Between-frame time is the gap before the frame that none of our code accounts for; long tasks are the browser's own report; in-flight and busy-worker counts are unacknowledged terrain work, an activity proxy.</p>
${abTable}
<p class="fnote">Fixed thresholds are the comparable columns; the p99 spike columns describe each run's own tail. One worker (19:55 rows: 53 and 74 frames over 33 ms per 1000, 15 and 2 over 50) against two (19:48 to 19:49 rows: 426, 182 and 114 over 33; 77, 7 and 10 over 50). The one-worker runs sit at the low end of the two-worker spread, and that spread (7 to 77 over 50 ms) is wider than the difference, so with two runs against three no effect is established either way. The 20:06 row includes a 4 s hitch (one frame of 3998 ms) that the means exclude.</p>

<h3>What a spike frame is made of</h3>
<p>Each spike frame's time split into the render call (main-thread time inside <code>renderer.render</code>), the page's own timed slots (sim, bodies, sky, terrain, forest, grass), the gap between the previous frame's end and this frame's start, and the rest, against the same split for the run's ordinary frames. Long tasks the browser reported were aligned to frames by their raw start and end (<code>attachLongTasks</code>); every one of them was the page's own frame callback running past 50 ms, attribution "self / unknown".</p>
${decompTable}
<p class="fnote">The earlier wording "long tasks that none of our slots hold" was wrong and is withdrawn: the long task is the frame itself. In a spike the render call roughly doubles (13 to 26-33 ms in the minimal-scene runs), the timed slots double with it, the gap before the frame is 4 to 22 ms against 1 to 3, and 4 to 14 ms is unaccounted against about 0.5 in ordinary frames. Everything the main thread does slows together; that is consistent with a paused or slowed thread (collection, contention, descheduling) rather than one subsystem doing more work, but the capture cannot say which. The DevTools recording (task 10) can.</p>

<h3>GPU time against main-thread time (?gputime=1, 20:03 to 20:08Z)</h3>
<p>GPU columns are Three's timestamp queries resolved a frame or two late (the resolve is not awaited, which would cost a display interval) and summed over the render passes of the last resolved frame; the device reports in steps of about 65 µs. "render call CPU" is the main-thread time inside <code>renderer.render</code>. Neither column includes presentation or queue wait.</p>
${gpuTable}
<p class="fnote">GPU pass execution stays under 2 ms in the worst frame of every run while the render call costs 11 to 33 ms of main-thread time. The frame is CPU-bound, and the 40 to 130 ms frames are not GPU pass time.</p>

<h3>JS heap growth and collections in spike frames</h3>
<p>Heap is <code>performance.memory.usedJSHeapSize</code> sampled once per frame, which Chrome quantizes; a drop of more than 1 MB between consecutive frames is read as a collection. Growth is summed over the frames without a drop.</p>
${heapTable}
<p class="fnote">The heap grows 22 to 46 MB per second in every capture, including the three standing still with nothing moving, and a collection-sized drop of about 24 MB lands every second or so. Spike frames carry a drop 3 to 10 times more often than ordinary frames, but most spikes have none and most drops do not spike. Association, not cause. Growth slope and drop frequency do not give allocation volume or name an allocator; the allocation-sampling profile (task 9) does, at a sampling overhead that is itself unmeasured on this page. The capture's own per-frame snapshot allocates a few kilobytes, not hundreds.</p>`;
}
