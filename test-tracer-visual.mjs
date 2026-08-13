import assert from 'node:assert/strict';
import {
  normalizeTracerFx,
  tracerLifetime,
  tracerSegmentAt,
} from './tracer-visual.js';
import { EffectEntity } from './entity-types/effect.js';

const fx = normalizeTracerFx({
  speed: 100,
  length: 2,
  width: 0.05,
  opacity: 0.8,
  glow: 0.4,
  minVisibleDistance: 1,
});
const p0 = [0, 0, 0];
const p1 = [10, 0, 0];

assert.equal(tracerLifetime(p0, p1, fx), 0.12);
assert.equal(tracerLifetime(p0, [0.5, 0, 0], fx), 0);
assert.equal(tracerSegmentAt(p0, p1, 0, fx), null);

const growing = tracerSegmentAt(p0, p1, 0.02, fx);
assert.deepEqual(growing.start, [1, 0, 0]);
assert.deepEqual(growing.end, [2, 0, 0]);
assert.equal(growing.alpha, 0.4);

const full = tracerSegmentAt(p0, p1, 0.05, fx);
assert.deepEqual(full.start, [3, 0, 0]);
assert.deepEqual(full.end, [5, 0, 0]);
assert.equal(full.alpha, 0.8);

const contracting = tracerSegmentAt(p0, p1, 0.11, fx);
assert.deepEqual(contracting.start, [9, 0, 0]);
assert.deepEqual(contracting.end, [10, 0, 0]);
assert.equal(contracting.alpha, 0.4);
assert.equal(tracerSegmentAt(p0, p1, 0.12, fx), null);

const entity = EffectEntity.create({
  kind: 'gun_tracer',
  p0,
  p1,
  tracerFx: fx,
  life: tracerLifetime(p0, p1, fx),
});
entity.id = 'tracer-test';
const wire = EffectEntity.serialize(entity);
assert.deepEqual(wire.tracerFx, fx);
assert.deepEqual(wire.p1, p1);

console.log('tracer visual tests passed');
