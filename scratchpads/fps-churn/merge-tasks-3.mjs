// One-off: outcomes for tasks 6-8 and two new tasks, merged into the page's own file (never overwrite it).
import fs from 'node:fs';
const P = 'docs/render-tasks.json';
const doc = JSON.parse(fs.readFileSync(P, 'utf8'));
const by = Object.fromEntries(doc.tasks.map(t => [t.id, t]));
const set = (id, outcome) => { if (by[id]) by[id].outcome = outcome; };

set('t6-forest-compact-render',
  'Read: three captures at the same spot (19:42 variants, 19:44 slots, 19:45 compact), no flags. Both merged modes rendered with no fallback and all 16 variants visible; you saw no visual difference. Forest draws went 97 to 82 (the 16 far-branch meshes to 1) and the frame did not improve: p50 18.1 ms at variants against 19.4 and 20.3 merged, p95 23.8 against 42.2 and 31.2, within these runs’ noise. The 50M triangles is the declared ceiling (index count × the geometry’s instance ceiling, three.webgpu.js:81505), not what the GPU drew; GPU time for the pair was not captured. Verdict: merging one role does not pay here. The option stays default-off and is not recommended.');
set('t7-worker-ab-minimal',
  'Read: one worker (19:55:13, 19:55:39) against two (19:48:51, 19:49:10, 19:49:57), trees and grass off, walking. p50 20.3 and 22.4 ms against 27.9, 22.8 and 16.8; spikes 5% of frames in every run; spike frames carry more in-flight jobs and larger between-frame gaps in both. No effect of the worker cap distinguishable from run-to-run variation.');
set('t8-gpu-timestamps-walking',
  'Read from your 20:03 to 20:08 runs (both with and without trees). GPU render passes: p50 0.33 to 0.46 ms, p95 under 1 ms, worst frame 1.9 ms; compute under 2 ms with trees on. GPU pass execution is not where the 40 to 130 ms frames go. The frame is CPU-bound: the render call takes 11 to 16 ms of main-thread time at 180 to 260 draws with trees and grass off. Caveats: the figure is the last resolved frame’s pass total, a frame or two late, quantized in steps of about 65 µs, and it excludes presentation and queue wait.');
if (by['t8-gpu-timestamps-walking'] && by['t8-gpu-timestamps-walking'].status !== 'done') { by['t8-gpu-timestamps-walking'].status = 'done'; by['t8-gpu-timestamps-walking'].doneAt = '2026-09-08T20:08:01Z'; by['t8-gpu-timestamps-walking'].notes = (by['t8-gpu-timestamps-walking'].notes || '') + (by['t8-gpu-timestamps-walking'].notes ? ' ' : '') + '[Fable: closed from the 20:03 to 20:08 ?gputime=1 captures]'; }

const now = '2026-09-08T20:40:00Z';
const add = t => { if (!by[t.id]) doc.tasks.push({ status: 'open', doneAt: null, notes: '', files: [], createdAt: now, ...t }); };
add({
  id: 't9-allocation-sampling',
  title: 'Record where the page allocates while standing still',
  criteria: 'Minimal scene (trees and grass off), stand still, no URL flags. DevTools, Memory tab, "Allocation sampling", Start, wait 10 s, Stop. Save the profile (right-click the profile in the left list, Save) into research/stats/ and attach the path here.',
  why: 'Every capture, including the three standing still with nothing moving, shows the JS heap growing 22 to 46 MB per second, with a garbage-collection-sized drop of about 24 MB every second or so. Spike frames carry such a drop three to ten times more often than ordinary frames, though most spikes have none. The profile names the allocating functions; nothing in our capture can.',
});
add({
  id: 't10-devtools-trace-walking',
  title: 'DevTools performance recording while walking on the minimal scene',
  criteria: 'Same minimal scene, no URL flags. DevTools, Performance tab, Record, walk your route for about 15 s, Stop. Save the recording (the down-arrow icon) into research/stats/ and attach the path here. Note the clock time you started walking.',
  why: 'The spike frames with trees, grass and GPU ruled out carry 45 to 100 ms long tasks on the main thread that none of our timed slots hold, plus gaps where the browser did not run a frame. Only a DevTools recording shows what the main thread was doing in those frames; this is the attribution step the capture cannot do.',
});
doc.updatedAt = new Date().toISOString();
fs.writeFileSync(P, JSON.stringify(doc));
console.log('tasks merged:', doc.tasks.map(t => t.id + ':' + t.status).join(' '));
