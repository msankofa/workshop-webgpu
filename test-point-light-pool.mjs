// test-point-light-pool.mjs — slot logic of the resident point-light pool.
import assert from 'node:assert/strict';
import { createPointLightPool } from './point-light-pool.js';

class StubColor { setRGB(r, g, b) { this.r = r; this.g = g; this.b = b; } }
class StubVec { set(x, y, z) { this.x = x; this.y = y; this.z = z; } }
class StubPointLight {
  constructor(color, intensity, distance, decay) {
    this.intensity = intensity; this.distance = distance; this.decay = decay;
    this.color = new StubColor(); this.position = new StubVec(); this.name = '';
  }
  dispose() { this.disposed = true; }
}
const THREE = { PointLight: StubPointLight };
const scene = { children: [], add(...o) { this.children.push(...o); }, remove(...o) { for (const x of o) this.children.splice(this.children.indexOf(x), 1); } };

const identity = (p, out) => { out[0] = p[0]; out[1] = p[1]; out[2] = p[2]; return out; };
const ent = (id, x, intensity = 10) => ({ id, p: [x, 2, 3], color: [1, 0.5, 0.25], radius: 30, intensity });

// Construction: `count` resident lights in the scene, all dark.
const pool = createPointLightPool({ THREE, scene, count: 2 });
assert.equal(scene.children.length, 2);
assert.ok(scene.children.every(l => l.intensity === 0));

// Sync writes position, colour, distance, intensity into a slot.
pool.sync([ent('a', 1)], identity);
const lit = scene.children.find(l => l.intensity === 10);
assert.ok(lit, 'one light lit');
assert.equal(lit.position.x, 1);
assert.equal(lit.color.r, 1);
assert.equal(lit.distance, 30);

// The same id keeps its slot across syncs.
pool.sync([ent('a', 5)], identity);
assert.equal(lit.position.x, 5);

// A vanished id releases its slot to intensity 0 (never removal).
pool.sync([], identity);
assert.equal(lit.intensity, 0);
assert.equal(scene.children.length, 2);

// Overflow rejects the newest: with 2 slots, a third entity gets nothing.
pool.sync([ent('a', 1), ent('b', 2), ent('c', 3)], identity);
assert.equal(scene.children.filter(l => l.intensity > 0).length, 2);
assert.ok(!scene.children.some(l => l.position.x === 3), 'c was rejected');

// Released slots are reused by later entities.
pool.sync([ent('b', 2)], identity);
pool.sync([ent('b', 2), ent('d', 4)], identity);
assert.ok(scene.children.some(l => l.position.x === 4), 'd took the freed slot');

// Slots freed by vanished ids become available on the NEXT sync, not mid-sync —
// the same ordering as light-entity-renderer.js (upserts first, then release).
pool.sync([], identity);

// The transform is applied to every write.
pool.sync([ent('e', 10)], (p, out) => { out[0] = p[0] - 100; out[1] = p[1]; out[2] = p[2]; return out; });
assert.ok(scene.children.some(l => l.position.x === -90), 'toLocal ran');

// dispose removes and disposes the residents.
pool.dispose();
assert.equal(scene.children.length, 0);

console.log('test-point-light-pool: all assertions passed');
