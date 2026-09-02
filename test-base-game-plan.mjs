import { createFieldScheduler } from './terrain-field-scheduler.js';
import { createFieldWindow } from './terrain-field-window.js';
import { createAnalyticSource, analyticDescriptor } from './terrain-source-analytic.js';
import { planWalkDerive } from './base-game-plan.js';

let failed = 0;
const ok = (condition, message) => { if (!condition) { failed++; console.error('FAIL:', message); } };

const texels = 7, step = 10;
const heights = new Float32Array(texels * texels).fill(20);
for (let z = 0; z < texels; z++) heights[z * texels] = -2;
heights[3 * texels + 3] = 100;
const a = planWalkDerive({ heights, texels, step }, { seaLevel: 0, waterMargin: 1, maxGrade: 0.5 });
const b = planWalkDerive({ heights: heights.slice(), texels, step }, { seaLevel: 0, waterMargin: 1, maxGrade: 0.5 });
ok(a.planWalk.every((v, i) => v === b.planWalk[i]), 'derivation is byte deterministic');
ok(Array.from({ length: texels }, (_, z) => a.planWalk[z * texels]).every(v => v === 0), 'water posts are zero');
ok(a.planWalk[3 * texels + 2] === 0 && a.planWalk[3 * texels + 3] === 0, 'posts on and beside a cliff are zero');
ok(a.planWalk[5 * texels + 5] > 0, 'flat dry ground is walkable');

const descriptor = analyticDescriptor({ key: 'base-game-plan-test', seaLevel: -100 });
const source = createAnalyticSource(descriptor);
const scheduler = createFieldScheduler({ useWorker: false, maxInFlight: 64, syncBudgetMs: 1000 });
const window = createFieldWindow({ source, descriptor, scheduler, gpu: false,
  fields: ['heights', 'biomeIds', 'planWalk'], derived: ['planWalk'],
  derive: tile => planWalkDerive(tile, { seaLevel: -100 }), post: 30, tileIntervals: 4,
  tilesPerSide: 4, maxRequestsPerUpdate: 64 });
const release = window.acquire();
for (let i = 0; i < 8; i++) { window.update(0, 0); scheduler.pump(); }
ok(window.coverage === 1, 'analytic plan window fills through the scheduler');
ok(window.texture('heights') === null, 'CPU-only plan creates no GPU textures');
ok(window.sampleAt('planWalk', 0, 0) > 0, 'derived planWalk is readable from the window');
const stamped = window.stampAlong('planWalk', [{ x: -30, z: 0 }, { x: 30, z: 0 }], 20, () => 0);
ok(stamped > 0 && window.sampleAt('planWalk', 0, 0) === 0, 'stampAlong mutates only resident posts and publishes them');
release(); window.dispose(); scheduler.dispose();

console.log(`base game plan: ${failed ? `${failed} failed` : 'all pass'}`);
process.exit(failed ? 1 : 0);
