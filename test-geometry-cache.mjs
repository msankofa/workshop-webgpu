// P1 gate test for the NPC-suite geometry cache (model-primitives.js createGeometryCache).
// Proves retain/release/sweep never disposes geometry a live body holds, and disposes it once the
// last holder is gone. Fake geometries stand in for THREE buffers (the cache never touches THREE).
// Run: node test-geometry-cache.mjs
import { createGeometryCache } from './model-primitives.js';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } };

const mkGeo = () => ({ disposed: false, userData: {}, dispose() { this.disposed = true; } });

// Build a "body": record the keys it touches, so endRecord retains exactly that set.
// `keys` may include a key another body already minted (shared geometry) and a "twin" key that
// stands for an LOD/amputated/hidden part the draw path would never touch.
function buildBody(cache, keys) {
  cache.beginRecord();
  for (const k of keys) cache.get(k, mkGeo);
  return cache.endRecord();
}

// (a) a geometry whose last holder was destroyed is disposed on the next sweep
{
  const c = createGeometryCache();
  const a = buildBody(c, ['k1', 'k2']);
  const g1 = c.map.get('k1');
  ok(c.sweep() === 0, 'sweep disposes nothing while the body is alive');
  ok(!g1.disposed, 'k1 alive before teardown');
  c.releaseAll(a);
  ok(c.sweep() === 2, 'sweep disposes both keys once the only holder is gone');
  ok(g1.disposed && !c.map.has('k1'), 'k1 disposed and evicted after last holder released');
}

// (b) geometry held by a live body is never disposed — including a twin the draw path never sees
{
  const c = createGeometryCache();
  // 'twin' models the LOD twin at player-procedural-body.js:1112: minted at build, never drawn.
  const a = buildBody(c, ['core', 'twin']);
  const twin = c.map.get('twin');
  for (let i = 0; i < 3; i++) ok(c.sweep() === 0, `sweep ${i} spares a live body`);
  ok(!twin.disposed && c.refcount('twin') === 1, 'build-time retain keeps the never-drawn twin alive');
  c.releaseAll(a);
}

// (c) a body built by mode A survives mode B's teardown (shared key held by both)
{
  const c = createGeometryCache();
  const a = buildBody(c, ['shared', 'a-only']);
  const b = buildBody(c, ['shared', 'b-only']);   // 'shared' now has refcount 2
  ok(c.refcount('shared') === 2, 'shared key retained by both bodies');
  const shared = c.map.get('shared');
  c.releaseAll(b);                                 // mode B torn down
  ok(c.sweep() === 1, 'B teardown sweeps only b-only');
  ok(!shared.disposed && c.map.has('shared'), 'shared geometry survives B teardown (A still holds it)');
  ok(!c.map.get('a-only').disposed, 'A-only geometry untouched by B teardown');
  c.releaseAll(a);
  ok(c.sweep() === 2, 'final teardown sweeps shared + a-only');
}

// keep-pool: sweep(keep) retains the most-recently-used zero-ref entries as rebuild scratch
{
  const c = createGeometryCache();
  c.releaseAll(buildBody(c, ['old']));
  c.releaseAll(buildBody(c, ['new']));            // 'new' touched later -> higher LRU seq
  ok(c.sweep(1) === 1, 'sweep(1) drops all but the newest zero-ref entry');
  ok(c.map.has('new') && !c.map.has('old'), 'newest zero-ref entry kept as scratch, oldest dropped');
}

console.log(`geometry-cache: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
