import { createWaterHeavyPassScheduler } from './water-pass-scheduler.js';

let failures = 0;
const check = (condition, message) => {
  if (condition) console.log('ok  ', message);
  else { failures++; console.log('FAIL', message); }
};

function run(scheduler, frames, enabled = {}) {
  const passes = [];
  for (let frame = 0; frame < frames; frame++) {
    const scheduled = scheduler.beginFrame(enabled);
    let count = 0;
    for (const kind of ['reflection', 'caustic']) {
      if (!scheduler.shouldRun(kind)) continue;
      count++;
      passes.push({ frame, kind });
      check(scheduler.complete(kind), `frame ${frame} completes its scheduled ${kind} pass`);
    }
    check(count <= 1, `frame ${frame} schedules at most one heavy pass`);
    check(!scheduled || count === 1, `frame ${frame} executes the selected pass`);
  }
  return passes;
}

const park = createWaterHeavyPassScheduler({ reflectionEvery: 3, causticEvery: 4 });
const parkPasses = run(park, 36);
check(parkPasses.some((p) => p.kind === 'reflection'), 'park cadence renders reflections');
check(parkPasses.some((p) => p.kind === 'caustic'), 'park cadence renders caustics');
check(parkPasses[0]?.kind === 'reflection' && parkPasses[1]?.kind === 'caustic',
  'a frame-zero collision is spread across the first two frames');

const saturated = createWaterHeavyPassScheduler({ reflectionEvery: 1, causticEvery: 1 });
const saturatedPasses = run(saturated, 10);
check(saturatedPasses.filter((p) => p.kind === 'reflection').length === 5,
  'rate-one collisions do not starve reflection');
check(saturatedPasses.filter((p) => p.kind === 'caustic').length === 5,
  'rate-one collisions do not starve caustics');

const gated = createWaterHeavyPassScheduler({ reflectionEvery: 1, causticEvery: 1 });
const gatedPasses = run(gated, 6, { reflectionEnabled: false, causticEnabled: true });
check(gatedPasses.every((p) => p.kind === 'caustic'), 'disabled reflection never consumes a slot');

const retuned = createWaterHeavyPassScheduler({ reflectionEvery: 9, causticEvery: 9 });
retuned.beginFrame();
retuned.complete('reflection');
retuned.setRate('caustic', 2);
check(retuned.beginFrame() === 'caustic', 'retuning marks the pass pending for the next frame');
check(retuned.complete('caustic') && !retuned.complete('caustic'),
  'one scheduled pass cannot execute twice in the same application frame');

console.log(failures ? `${failures} failing` : 'all passing');
process.exit(failures ? 1 : 0);
