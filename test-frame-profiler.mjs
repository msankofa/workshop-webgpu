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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

