// node test-rain-math.mjs — CPU twin of rain.js's shader maths.
import assert from 'node:assert/strict';
import {
  fmod, dropPosition, volumeOrigin, streakBasis, occluderUv, dropVisible, rippleState, countForDensity,
  relativeVelocity, streakLength, nearFade,
} from './rain-math.js';

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok', name); }

t('fmod is GLSL mod, not JS %', () => {
  assert.equal(fmod(-1, 10), 9);
  assert.equal(fmod(11, 10), 1);
  assert.equal(fmod(0, 10), 0);
});

t('drops stay inside the box forever', () => {
  const box = { origin: [-25, -34, -25], vol: [50, 40, 50], wind: [3, 0, -1], speed: 22 };
  for (const t0 of [0, 1.5, 100, 12345.678]) {
    const p = dropPosition([0.1, 0.9, 0.5], t0, box);
    for (let i = 0; i < 3; i++) {
      assert.ok(p[i] >= box.origin[i] && p[i] < box.origin[i] + box.vol[i], `axis ${i} at t=${t0}: ${p[i]}`);
    }
  }
});

t('drops fall: y decreases between two nearby times, wraps to the top when it runs out', () => {
  const box = { origin: [0, 0, 0], vol: [10, 10, 10], wind: [0, 0, 0], speed: 10 };
  const a = dropPosition([0.5, 0.5, 0.5], 0, box);
  const b = dropPosition([0.5, 0.5, 0.5], 0.1, box);
  assert.ok(b[1] < a[1]);
  const c = dropPosition([0.5, 0.5, 0.5], 0.6, box); // 5 - 6 = -1 → wraps to 9
  assert.ok(Math.abs(c[1] - 9) < 1e-9);
});

t('volume origin is centred in xz and biased upward', () => {
  const o = volumeOrigin([10, 2, -4], [50, 40, 50]);
  assert.deepEqual(o, [-15, 2 - 34, -29]);
  const top = o[1] + 40;
  assert.ok(top - 2 === 6, 'only 6 m of the 40 m box is above the camera');
});

t('streak basis is orthonormal and faces the camera', () => {
  const { along, side } = streakBasis([4, 0, 0], 20, [0, 5, 0], [0, 6, 10]);
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  assert.ok(Math.abs(dot(along, side)) < 1e-9);
  assert.ok(Math.abs(Math.hypot(...side) - 1) < 1e-9);
  assert.ok(along[1] < 0, 'streak points down');
  assert.ok(along[0] > 0, 'and leans with the wind');
});

t('streak basis survives looking straight down the fall line', () => {
  const { side } = streakBasis([0, 0, 0], 20, [0, 0, 0], [0, 10, 0]);
  assert.ok(Number.isFinite(side[0]) && Math.hypot(...side) > 0.99);
});

t('a camera moving forward sees rain lean toward it; standing still it does not', () => {
  const still = streakBasis([0, 0, 0], 20, [0, 5, -5], [0, 5, 0]);
  const moving = streakBasis([0, 0, 0], 20, [0, 5, -5], [0, 5, 0], [0, 0, -10]);
  assert.ok(Math.abs(still.along[2]) < 1e-9, 'no z lean when still');
  assert.ok(moving.along[2] > 0.3, 'drops appear to come at a camera driving into them');
  assert.deepEqual(relativeVelocity([2, 0, 0], 18, [1, 0, 3]), [1, -18, -3]);
});

t('streak length grows with apparent speed and is clamped both ways', () => {
  assert.ok(Math.abs(streakLength(1, 0.5, 18) - 1.0) < 1e-9, 'authored length at the reference speed');
  assert.ok(streakLength(1, 0.5, 36) > streakLength(1, 0.5, 18));
  assert.equal(streakLength(1, 0.5, 1000), streakLength(1, 0.5, 54), 'clamped at 3x');
  assert.equal(streakLength(1, 0.5, 0), streakLength(1, 0.5, 4.5), 'clamped at 0.25x');
});

t('near fade: invisible at the lens, full past 1.4 m, monotonic between', () => {
  assert.equal(nearFade(0), 0);
  assert.equal(nearFade(0.25), 0);
  assert.equal(nearFade(2), 1);
  assert.ok(nearFade(0.5) < nearFade(1.0) && nearFade(1.0) < 1);
});

t('occluder uv maps the bake square to 0..1 and rejects outside', () => {
  assert.deepEqual(occluderUv(0, 0, [0, 0], 100), [0.5, 0.5]);
  assert.deepEqual(occluderUv(-50, 50, [0, 0], 100), [0, 1]);
  assert.equal(occluderUv(51, 0, [0, 0], 100), null);
  assert.deepEqual(occluderUv(20, 10, [20, 10], 40), [0.5, 0.5]);
});

t('a drop under a roof is hidden, one over open ground is not', () => {
  assert.equal(dropVisible(1.5, 3.0), false);
  assert.equal(dropVisible(4.0, 3.0), true);
  assert.equal(dropVisible(0.5, 0), true, 'ground writes 0 so anything above ground shows');
});

t('ripple clock: birth staggers cells, radius grows while amplitude decays', () => {
  const a = rippleState(0, 1, 0.25), b = rippleState(0, 1, 0.75);
  assert.notEqual(a.life, b.life);
  const early = rippleState(0.1, 1, 0), late = rippleState(0.9, 1, 0);
  assert.ok(late.radius > early.radius && late.amp < early.amp);
  assert.ok(rippleState(1.0, 1, 0).life === 0, 'wraps cleanly');
});

t('density → count clamps and never returns zero', () => {
  assert.equal(countForDensity(0, 30000), 1);
  assert.equal(countForDensity(0.4, 30000), 12000);
  assert.equal(countForDensity(7, 30000), 30000);
  assert.equal(countForDensity(-1, 30000), 1);
});

console.log(`\n${n} tests passed`);
