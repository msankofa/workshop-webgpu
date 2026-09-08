# One-off: Astra's points on the tasks 6-8 report. Fixed-threshold dip rates, spike decomposition,
# retract "long tasks none of our slots hold", profiler-overhead note.
import json, re

def rep(s, o, n):
    assert s.count(o) == 1, o[:80]
    return s.replace(o, n)

# ---- stats section: fixed thresholds in both tables, plus a decomposition table --------------
p = 'scratchpads/fps-churn/stats-evening.mjs'
s = open(p, encoding='utf-8').read()
s = rep(s, "const mean = (a, k) => a.length ? a.reduce((s, r) => s + (+r[k] || 0), 0) / a.length : NaN;",
"""const mean = (a, k) => a.length ? a.reduce((s, r) => s + (+r[k] || 0), 0) / a.length : NaN;
const per1000 = (rows, ms) => Math.round(1000 * rows.filter(r => r.frameMs > ms).length / rows.length);
const SLOTS = ['simMs', 'bodiesMs', 'skyMs', 'terrainMs', 'terrainIntegrateMs', 'forestMs', 'grassMs'];
const slotSum = a => SLOTS.reduce((s, k) => s + (mean(a, k) || 0), 0);""")
s = rep(s, "<th>reported triangles p50</th><th>fallback</th></tr></thead><tbody>${pair.map(e => {\n    const p = e.performance, f = e.context?.flora?.trees || {};",
"<th>reported triangles p50</th><th>frames &gt; 33 ms per 1000</th><th>&gt; 50 ms</th><th>fallback</th></tr></thead><tbody>${pair.map(e => {\n    const p = e.performance, f = e.context?.flora?.trees || {}, rows = rowsOf(p);")
s = rep(s, "<td>${(p.triangles?.p50 / 1e6).toFixed(2)} M</td><td>${f.lastError",
"<td>${(p.triangles?.p50 / 1e6).toFixed(2)} M</td><td>${per1000(rows, 33.3)}</td><td>${per1000(rows, 50)}</td><td>${f.lastError")
s = rep(s, "<th>frame p50</th><th>p95</th><th>max</th><th>spikes</th><th>spike between-frame ms</th>",
"<th>frame p50</th><th>p95</th><th>max</th><th>frames &gt; 33 ms per 1000</th><th>&gt; 50 ms</th><th>spikes (own p99)</th><th>spike between-frame ms</th>")
s = rep(s, "<td>${r1(p.frameMs.max)}</td><td>${sp.length} (${(100 * sp.length / rows.length).toFixed(0)}%)</td>",
"<td>${r1(p.frameMs.max)}</td><td>${per1000(rows, 33.3)}</td><td>${per1000(rows, 50)}</td><td>${sp.length} (${(100 * sp.length / rows.length).toFixed(0)}%)</td>")
s = rep(s, "  // gpu\n",
"""  // spike decomposition: where a spike frame's time is, against the ordinary frames of the same run
  const decompTable = `<table><thead><tr><th>time</th><th>trees</th><th colspan="5">spike frames (above the run's p99)</th><th colspan="5">other frames</th></tr><tr><th></th><th></th><th>frame</th><th>render call</th><th>timed slots</th><th>gap before</th><th>rest</th><th>frame</th><th>render call</th><th>timed slots</th><th>gap before</th><th>rest</th></tr></thead><tbody>${ev.map(e => {
    const p = e.performance, rows = rowsOf(p), thr = p.spikes.thresholdMs;
    const sp = rows.filter(r => r.frameMs >= thr && r.frameMs < 1000), ot = rows.filter(r => r.frameMs < thr);
    const cells = a => { const f = mean(a, 'frameMs'), rc = mean(a, 'postRenderMs'), sl = slotSum(a), b = mean(a, 'betweenMs'); return `<td>${r1(f)}</td><td>${r1(rc)}</td><td>${r1(sl)}</td><td>${r1(b)}</td><td>${r1(f - rc - sl - b)}</td>`; };
    return `<tr><td>${hhmm(e.capturedAt)}</td><td>${trees(e)}</td>${cells(sp)}${cells(ot)}</tr>`;
  }).join('')}</tbody></table>`;

  // gpu
""")
s = rep(s, """<p class="fnote">One worker (19:55 rows) against two (19:48 to 19:49 rows) shows no effect distinguishable from run-to-run variation: spikes are about 5% of frames in every run and carry the same signature. The 20:06 row includes a 4 s hitch (one frame of 3998 ms) that the means exclude.</p>""",
"""<p class="fnote">Fixed thresholds are the comparable columns; the p99 spike columns describe each run's own tail. One worker (19:55 rows: 53 and 74 frames over 33 ms per 1000, 15 and 2 over 50) against two (19:48 to 19:49 rows: 426, 182 and 114 over 33; 77, 7 and 10 over 50). The one-worker runs sit at the low end of the two-worker spread, and that spread (7 to 77 over 50 ms) is wider than the difference, so with two runs against three no effect is established either way. The 20:06 row includes a 4 s hitch (one frame of 3998 ms) that the means exclude.</p>

<h3>What a spike frame is made of</h3>
<p>Each spike frame's time split into the render call (main-thread time inside <code>renderer.render</code>), the page's own timed slots (sim, bodies, sky, terrain, forest, grass), the gap between the previous frame's end and this frame's start, and the rest, against the same split for the run's ordinary frames. Long tasks the browser reported were aligned to frames by their raw start and end (<code>attachLongTasks</code>); every one of them was the page's own frame callback running past 50 ms, attribution "self / unknown".</p>
${decompTable}
<p class="fnote">The earlier wording "long tasks that none of our slots hold" was wrong and is withdrawn: the long task is the frame itself. In a spike the render call roughly doubles (13 to 26-33 ms in the minimal-scene runs), the timed slots double with it, the gap before the frame is 4 to 22 ms against 1 to 3, and 4 to 14 ms is unaccounted against about 0.5 in ordinary frames. Everything the main thread does slows together; that is consistent with a paused or slowed thread (collection, contention, descheduling) rather than one subsystem doing more work, but the capture cannot say which. The DevTools recording (task 10) can.</p>""")
s = rep(s, "Association, not cause; the allocating code is unnamed, which is what the allocation-sampling task asks for. The capture's own per-frame snapshot allocates a few kilobytes, not hundreds.</p>",
"Association, not cause. Growth slope and drop frequency do not give allocation volume or name an allocator; the allocation-sampling profile (task 9) does, at a sampling overhead that is itself unmeasured on this page. The capture's own per-frame snapshot allocates a few kilobytes, not hundreds.</p>")
open(p, 'w', encoding='utf-8', newline='').write(s)

# ---- map ----
p = 'docs/render-pipeline-map.html'
s = open(p, encoding='utf-8').read()
s = rep(s, "|One worker against two (19:48 to 19:55Z, trees and grass off): p50 20.3 and 22.4 ms against 27.9, 22.8 and 16.8; spikes 5% of frames in every run. No effect distinguishable from run-to-run variation.",
"|One worker against two (19:48 to 19:55Z, trees and grass off): frames over 50 ms per 1000 were 15 and 2 at one worker against 77, 7 and 10 at two; over 33 ms, 53 and 74 against 426, 182 and 114. The one-worker runs sit at the low end of a two-worker spread wider than the difference; no effect established either way with two runs against three.")
s = rep(s, "|Spike frames also carry 45 to 100 ms long tasks that none of our slots hold. Attribution needs a DevTools recording (task 10).||",
"|The browser's long tasks, aligned by raw start and end, are the page's own frame callback running past 50 ms. Inside a spike the render call roughly doubles, the timed slots double with it, the gap before the frame grows to 4 to 22 ms, and 4 to 14 ms is unaccounted against 0.5 in ordinary frames: everything slows together. Which pause or contention does that needs a DevTools recording (task 10).||")
s = rep(s, "unslotted long tasks + GC drops; cause open</text>", "whole frame slows together; cause open</text>")
s = rep(s, "what fills the 45 to 100 ms tasks?</text>", "why does the whole frame slow at once?</text>")
s = rep(s, "and its dips are frames the browser did not run plus 45 to 100 ms long tasks that none of our timers hold.",
"and in a dip frame everything on the main thread slows together: the render call doubles, the page's own slots double, the gap before the frame grows, and several milliseconds go unaccounted.")
open(p, 'w', encoding='utf-8', newline='').write(s)

# ---- tasks (merge into the page's file) ----
p = 'docs/render-tasks.json'
d = json.load(open(p, encoding='utf-8'))
by = {t['id']: t for t in d['tasks']}
by['t6-forest-compact-render']['outcome'] += ' Fixed-threshold view: frames over 33 ms per 1000 were 2 at variants, 82 slots, 36 compact; none over 50 in any of the three. Scoped to this role, layout and these three runs; GPU cost of the merged draw stays unmeasured.'
by['t7-worker-ab-minimal']['outcome'] = 'Read: one worker (19:55:13, 19:55:39) against two (19:48:51, 19:49:10, 19:49:57), trees and grass off, walking. Frames over 50 ms per 1000: 15 and 2 at one worker against 77, 7 and 10 at two; over 33 ms: 53 and 74 against 426, 182 and 114. The one-worker runs sit at the low end of a two-worker spread that is wider than the difference, so with two runs against three no effect is established either way. Spike frames carry the same signature in both.'
by['t9-allocation-sampling']['why'] += ' The profiler samples allocations and adds its own overhead while recording, so frame times during the profile are not comparable with the captures; only the allocating functions and their shares are read from it.'
by['t10-devtools-trace-walking']['why'] = 'Aligned by their raw start and end, the long tasks the browser reports are the page’s own frame callback running past 50 ms. In a spike frame the render call roughly doubles, the page’s timed slots double with it, the gap before the frame grows to 4 to 22 ms, and 4 to 14 ms is unaccounted against 0.5 in ordinary frames: everything on the main thread slows together. Only a DevTools recording shows what paused or contended with it in those frames.'
d['updatedAt'] = '2026-09-08T20:55:00.000Z'
json.dump(d, open(p, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)

# ---- log ----
p = 'docs/render-progress-log.json'
d = json.load(open(p, encoding='utf-8'))
d['entries'].append({
  'at': '2026-09-08T20:55Z',
  'title': 'Astra’s points on tasks 6 to 8 applied',
  'body': 'Fixed-threshold dip rates (frames over 33 and over 50 ms per 1000) added beside the per-run p99 spikes; on them the one-worker runs sit at the low end of a two-worker spread wider than the difference, so the worker A/B establishes nothing either way. The long tasks were aligned by raw start and end: every one is the page’s own frame callback past 50 ms, so "long tasks none of our slots hold" is withdrawn. A spike frame decomposes as the render call roughly doubling, the timed slots doubling with it, a 4 to 22 ms gap before the frame, and 4 to 14 ms unaccounted; everything slows together. Forest conclusion scoped to this role, layout and runs, GPU cost unmeasured. Heap slope and drop frequency noted as not giving allocation volume or an allocator; profiler overhead noted on task 9. Remaining supported sharing and lifecycle items listed separately in comms.',
  'commits': []
})
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
open(p, 'a', encoding='utf-8').write('\n')
print('patched: stats module, map, tasks, log')
