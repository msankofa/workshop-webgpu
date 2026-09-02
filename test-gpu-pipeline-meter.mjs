// test-gpu-pipeline-meter.mjs — the pipeline meter, against a fake GPUDevice.
//
// There is no backend in Node, which is the whole reason this module exists: the tree audit missed
// lazy pipeline creation because every number in it came from Node, where nothing compiles. So the
// device is faked and what is checked is the bookkeeping — that the meter times the blocking part,
// counts every factory, drains to zero, and leaves the device exactly as it found it.
//
// node test-gpu-pipeline-meter.mjs

import { createPipelineMeter } from './gpu-pipeline-meter.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const section = name => console.log(`\n${name}`);

// A clock the test drives, so "how long did that take" is an assertion and not a race.
function fakeDevice(cost = { render: 7, compute: 3, asyncRender: 1 }) {
  const state = { t: 0, calls: [] };
  const device = {
    createRenderPipeline(desc) { state.t += cost.render; state.calls.push('render'); return { desc }; },
    createComputePipeline(desc) { state.t += cost.compute; state.calls.push('compute'); return { desc }; },
    async createRenderPipelineAsync(desc) { state.t += cost.asyncRender; state.calls.push('renderAsync'); return { desc }; },
    async createComputePipelineAsync(desc) { state.calls.push('computeAsync'); return { desc }; },
  };
  return { device, state, now: () => state.t };
}

section('timing and counting');
{
  const { device, state, now } = fakeDevice();
  const meter = createPipelineMeter(device, { now });
  check('installed on a device that has the factories', meter.installed === true);
  device.createRenderPipeline({ a: 1 });
  device.createRenderPipeline({ a: 2 });
  device.createComputePipeline({ b: 1 });
  const drained = meter.take();
  check('render pipelines counted', drained.render === 2, `got ${drained.render}`);
  check('compute pipelines counted', drained.compute === 1, `got ${drained.compute}`);
  check('render ms is the sum of the blocking calls', drained.renderMs === 14, `got ${drained.renderMs}`);
  check('compute ms is separate', drained.computeMs === 3, `got ${drained.computeMs}`);
  check('total ms is both', drained.ms === 17, `got ${drained.ms}`);
  check('the wrapped factory still returns the pipeline', state.calls.length === 3);
}

section('draining');
{
  const { device, now } = fakeDevice();
  const meter = createPipelineMeter(device, { now });
  device.createRenderPipeline({});
  meter.take();
  const second = meter.take();
  check('a second take reads zero, not the same frame twice', second.ms === 0 && second.render === 0);
  device.createRenderPipeline({});
  check('and counting resumes after a drain', meter.take().render === 1);
}

section('the async factories');
{
  const { device, now } = fakeDevice();
  const meter = createPipelineMeter(device, { now });
  await device.createRenderPipelineAsync({});
  await device.createComputePipelineAsync({});
  const drained = meter.take();
  check('async pipelines are counted', drained.async === 2, `got ${drained.async}`);
  check('an async render pipeline counts as a render pipeline', drained.render === 1, `got ${drained.render}`);
  // Only the dispatch blocks; the compile itself is off-thread and is not the frame's cost.
  check('only the blocking part of an async call is timed', drained.ms === 1, `got ${drained.ms}`);
}

section('a device that cannot be metered');
{
  const meter = createPipelineMeter(undefined);
  check('no device: installed is false', meter.installed === false);
  check('no device: take() reads zeros rather than throwing', meter.take().ms === 0);
  meter.dispose();
  check('no device: dispose is a no-op', true);
}

section('dispose puts the device back');
{
  const { device, now } = fakeDevice();
  const original = device.createRenderPipeline;
  const meter = createPipelineMeter(device, { now });
  check('the factory was replaced', device.createRenderPipeline !== original);
  meter.dispose();
  check('and restored exactly', device.createRenderPipeline === original);
  device.createRenderPipeline({});
  check('a disposed meter counts nothing', meter.take().render === 0);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
