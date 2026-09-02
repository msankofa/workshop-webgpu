import { createFrameProfiler } from './frame-profiler.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (cond) pass++; else fail++;
}

let t = 0;
const profiler = createFrameProfiler({ now: () => t, smoothing: 1 });

profiler.beginFrame();
const syncResult = profiler.time('creatures', () => {
  t += 4.25;
  return 17;
});
ok(syncResult === 17, 'sync timing returns function result');
ok(profiler.snapshot().passCreaturesMs === 4.25, 'sync timing recorded by name');
ok(profiler.snapshot().passGrassMs === 0, 'missing pass fields snapshot as 0');

const asyncResult = await profiler.timeAsync('grassGpu', async () => {
  t += 6.5;
  return 'done';
});
ok(asyncResult === 'done', 'async timing returns awaited result');
ok(profiler.snapshot().passGrassMs === 6.5, 'async timing recorded by name');

profiler.recordGpu('grassGpu', 2.75);
profiler.recordGpu('computeTotal', 11.125);
let snap = profiler.snapshot();
ok(snap.gpuGrassMs === 2.75, 'recordGpu surfaces named GPU field');
ok(snap.gpuComputeMs === 11.125, 'recordGpu surfaces aggregate compute field');
ok(snap.passGpuAwaitMs === 6.5, 'GPU await sum includes awaited GPU blocks');

profiler.markDropped();
profiler.markDropped(2);
ok(profiler.snapshot().droppedFrames === 3, 'dropped frames accumulate');

profiler.reset();
snap = profiler.snapshot();
ok(snap.passCreaturesMs === 0 && snap.gpuGrassMs === 0, 'reset clears timing fields');
ok(snap.droppedFrames === 0, 'reset clears dropped frames');

// --- beginFrame zeroes custom (non-default) timer names too -----------------
// bot-viewer-v2 records sim/render/etc., none of which are in DEFAULT_NAMES. Before this,
// beginFrame() was a no-op for them and a skipped phase reported the previous frame's value.
let t2 = 0;
const p2 = createFrameProfiler({ now: () => t2, smoothing: 0.5 });
const CUSTOM = { sim: 'simMs', render: 'renderMs' };

p2.time('sim', () => { t2 += 8; });
p2.time('render', () => { t2 += 4; });
p2.recordGpu('grassGpu', 2.5);
ok(p2.snapshot(CUSTOM).simMs === 8, 'custom-named timer recorded');
ok(p2.snapshot(CUSTOM, { smooth: true }).simMs === 8, 'first sample seeds the smoothed value');

p2.beginFrame();
snap = p2.snapshot(CUSTOM);
ok(snap.simMs === 0, 'beginFrame zeroes a custom-named CPU timer');
ok(snap.renderMs === 0, 'beginFrame zeroes every custom-named CPU timer');
ok(snap.gpuGrassMs === 0, 'beginFrame still zeroes the default GPU names');
ok(p2.snapshot(CUSTOM, { smooth: true }).simMs === 8, 'beginFrame leaves the smoothed value alone');

// A phase that genuinely runs short decays the EMA rather than carrying the old value forward.
p2.time('sim', () => {});
ok(p2.snapshot(CUSTOM).simMs === 0, 'a zero-length phase reads 0');
ok(p2.snapshot(CUSTOM, { smooth: true }).simMs === 4, 'smoothed value decays instead of snapping');

// Defaults keep working for the environment viewers, which record them every frame.
p2.time('creatures', () => { t2 += 3; });
p2.beginFrame();
ok(p2.snapshot().passCreaturesMs === 0, 'default names still zeroed by beginFrame');

// --- disabled mode keeps frame execution and dropped-frame accounting, but does no timing ------
let t3 = 0, nowCalls = 0;
const p3 = createFrameProfiler({ enabled: false, now: () => { nowCalls++; return t3; } });
ok(p3.enabled === false, 'a profiler can start disabled');
ok(p3.time('creatures', () => { t3 += 5; return 9; }) === 9, 'disabled sync timing still executes and returns the work');
ok(await p3.timeAsync('grassGpu', async () => { t3 += 7; return 'idle'; }) === 'idle', 'disabled async timing still awaits and returns the work');
p3.mark('sim', 4); p3.recordGpu('grassGpu', 3); p3.beginFrame();
ok(nowCalls === 0, 'disabled timing never reads the clock');
ok(p3.snapshot({ sim: 'simMs' }).simMs === 0 && p3.snapshot().gpuGrassMs === 0, 'disabled timing records no CPU or GPU passes');
p3.markDropped(2);
ok(p3.droppedFrames === 2 && p3.snapshot().droppedFrames === 2, 'dropped-frame counting remains available while disabled');
p3.setEnabled(true);
ok(p3.enabled === true, 'detailed timing can be enabled for a capture');
p3.time('creatures', () => { t3 += 2; });
ok(nowCalls === 2 && p3.snapshot().passCreaturesMs === 2, 're-enabled timing resumes clock reads and recording');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
