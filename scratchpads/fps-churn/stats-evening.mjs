// Stats-tab section 5: the 2026-09-08 evening captures (forest pair, worker A/B, GPU timestamps, heap).
// Imported by build-stats-tab.mjs; pure functions of the log entries.
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r1 = v => v == null || !Number.isFinite(+v) ? '–' : (+v).toFixed(1);
const r2 = v => v == null || !Number.isFinite(+v) ? '–' : (+v).toFixed(2);
const r0 = v => v == null || !Number.isFinite(+v) ? '–' : String(Math.round(+v));
const hhmm = at => at.slice(11, 19);
const rowsOf = p => p.series.map(r => Object.fromEntries(p.seriesKeys.map((k, i) => [k, r[i]])));
const mean = (a, k) => a.length ? a.reduce((s, r) => s + (+r[k] || 0), 0) / a.length : NaN;

export function eveningSection(entries) {
  const ev = entries.filter(e => e.capturedAt >= '2026-09-08T19:40' && e.capturedAt < '2026-09-08T20:10');
  if (!ev.length) return '';
  const url = e => e.context?.gpuTimestamps?.url || '(none)';
  const trees = e => e.settingsAtStart?.treesEnabled ? 'on' : 'off';

  // forest pair: standing, trees on, no flags
  const pair = ev.filter(e => url(e) === '(none)' && e.settingsAtStart?.treesEnabled && !rowsOf(e.performance).some(r => r.speed > 0.5));
  const pairTable = `<table class="narrow"><thead><tr><th>time</th><th>mode</th><th>frame p50</th><th>p95</th><th>max</th><th>std dev</th><th>forest draws</th><th>all draws p50</th><th>reported triangles p50</th><th>fallback</th></tr></thead><tbody>${pair.map(e => {
    const p = e.performance, f = e.context?.flora?.trees || {};
    return `<tr><td>${hhmm(e.capturedAt)}</td><td>${esc(e.settingsAtStart.forestDrawMode)}</td><td>${r1(p.frameMs.p50)}</td><td>${r1(p.frameMs.p95)}</td><td>${r1(p.frameMs.max)}</td><td>${r1(p.frameMs.stdDev)}</td><td>${r0(f.draws)}</td><td>${r0(p.drawCalls?.p50)}</td><td>${(p.triangles?.p50 / 1e6).toFixed(2)} M</td><td>${f.lastError ? esc(f.lastError) : 'none'}</td></tr>`;
  }).join('')}</tbody></table>`;

  // walking runs, trees and grass off: worker A/B and gputime
  const walking = ev.filter(e => rowsOf(e.performance).some(r => r.speed > 0.5));
  const abTable = `<table><thead><tr><th>time</th><th>URL</th><th>trees</th><th>frames</th><th>frame p50</th><th>p95</th><th>max</th><th>spikes</th><th>spike between-frame ms</th><th>other</th><th>spike long task ms</th><th>other</th><th>spike in-flight</th><th>other</th><th>spike busy workers</th><th>other</th></tr></thead><tbody>${walking.map(e => {
    const p = e.performance, rows = rowsOf(p), thr = p.spikes.thresholdMs;
    const sp = rows.filter(r => r.frameMs >= thr && r.frameMs < 1000), ot = rows.filter(r => r.frameMs < thr);
    const c = (a, b) => `<td${a > 1.5 * b ? ' class="hot"' : ''}>${r1(a)}</td><td>${r1(b)}</td>`;
    return `<tr><td>${hhmm(e.capturedAt)}</td><td>${esc(url(e))}</td><td>${trees(e)}</td><td>${rows.length}</td><td>${r1(p.frameMs.p50)}</td><td>${r1(p.frameMs.p95)}</td><td>${r1(p.frameMs.max)}</td><td>${sp.length} (${(100 * sp.length / rows.length).toFixed(0)}%)</td>${c(mean(sp, 'betweenMs'), mean(ot, 'betweenMs'))}${c(mean(sp, 'longTaskMs'), mean(ot, 'longTaskMs'))}${c(mean(sp, 'terrainInFlight'), mean(ot, 'terrainInFlight'))}${c(mean(sp, 'terrainBusyWorkers'), mean(ot, 'terrainBusyWorkers'))}</tr>`;
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
<p class="fnote">One worker (19:55 rows) against two (19:48 to 19:49 rows) shows no effect distinguishable from run-to-run variation: spikes are about 5% of frames in every run and carry the same signature. The 20:06 row includes a 4 s hitch (one frame of 3998 ms) that the means exclude.</p>

<h3>GPU time against main-thread time (?gputime=1, 20:03 to 20:08Z)</h3>
<p>GPU columns are Three's timestamp queries resolved a frame or two late (the resolve is not awaited, which would cost a display interval) and summed over the render passes of the last resolved frame; the device reports in steps of about 65 µs. "render call CPU" is the main-thread time inside <code>renderer.render</code>. Neither column includes presentation or queue wait.</p>
${gpuTable}
<p class="fnote">GPU pass execution stays under 2 ms in the worst frame of every run while the render call costs 11 to 33 ms of main-thread time. The frame is CPU-bound, and the 40 to 130 ms frames are not GPU pass time.</p>

<h3>JS heap growth and collections in spike frames</h3>
<p>Heap is <code>performance.memory.usedJSHeapSize</code> sampled once per frame, which Chrome quantizes; a drop of more than 1 MB between consecutive frames is read as a collection. Growth is summed over the frames without a drop.</p>
${heapTable}
<p class="fnote">The heap grows 22 to 46 MB per second in every capture, including the three standing still with nothing moving, and a collection-sized drop of about 24 MB lands every second or so. Spike frames carry a drop 3 to 10 times more often than ordinary frames, but most spikes have none and most drops do not spike. Association, not cause; the allocating code is unnamed, which is what the allocation-sampling task asks for. The capture's own per-frame snapshot allocates a few kilobytes, not hundreds.</p>`;
}
