// Phase 3 checks: terrain-source → world-query heightfield provider.
// Run: node test-world-query-heightfield.mjs
import { createWorldQueryService } from './world-query.js';
import { createHeightfieldWorldQueryProvider } from './world-query-heightfield-provider.js';
import { createAnalyticSource } from './terrain-source-analytic.js';
import { normalizeDescriptor } from './terrain-source.js';
import { createBaseGamePlayerController } from './base-game-player-controller.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const params = { baseAmp: 1.0, lake: 0.45, lakeDepth: 3.2 };
const source = createAnalyticSource({ key: 'lab', sourceVersion: '1', params });
const R = 0.35, H = 1.8;
const capsuleAt = (x, footY, z) => ({ start: [x, footY + R, z], end: [x, footY + H - R, z], radius: R });

console.log('\n[1] provider shape and registration');
{
  const p = createHeightfieldWorldQueryProvider(source, { id: 'terrain' });
  ok(p.capabilities.join() === 'groundProbe,resolveCapsule' && typeof p.raycast !== 'function', 'exposes only groundProbe + resolveCapsule');
  const wq = createWorldQueryService();
  const off = wq.registerProvider(p);
  ok(wq.providerIds().includes('terrain') && wq.hasCapability('groundProbe'), 'registers without changing world-query.js');
  off();
  let threw = false; try { createHeightfieldWorldQueryProvider({}); } catch { threw = true; }
  ok(threw, 'rejects a non-source');
}

console.log('\n[2] resolveCapsule: rest, penetration, slope slide, jump, no hit');
{
  const wq = createWorldQueryService();
  wq.registerProvider(createHeightfieldWorldQueryProvider(source));
  const x = 3, z = 7, g = source.heightAt(x, z);
  // penetrating by 0.3 -> lifted to the surface, downward velocity removed
  const r = wq.resolveCapsule({ capsule: capsuleAt(x, g - 0.3, z), velocity: [1, -4, 0], slopeLimitCos: 0.5 });
  ok(near(r.capsule.start[1] - R, g), `capsule foot seated on ground (foot ${r.capsule.start[1] - R} vs ${g})`);
  ok(near(r.capsule.end[1] - r.capsule.start[1], H - 2 * R), 'capsule length preserved');
  ok(r.grounded === true && r.ceiling === false, 'grounded, never a ceiling');
  ok(r.velocity[1] > -4 && r.velocity[1] <= 0.5, `into-surface velocity removed (vy ${r.velocity[1].toFixed(3)})`);
  ok(r.contacts.length === 1 && r.contacts[0].surfaceType === 'terrain' && r.contacts[0].colliderId === 'lab@1' && r.contacts[0].providerId === 'terrain', 'contact carries source identity');
  // jump preserved: upward velocity while penetrating is not cancelled
  const j = wq.resolveCapsule({ capsule: capsuleAt(x, g - 0.05, z), velocity: [0, 6, 0], slopeLimitCos: 0.5 });
  ok(j.velocity[1] === 6, 'upward (jump) velocity preserved');
  // above ground: no contact, capsule untouched
  const a = wq.resolveCapsule({ capsule: capsuleAt(x, g + 1, z), velocity: [0, -1, 0], slopeLimitCos: 0.5 });
  ok(a.grounded === false && a.contacts.length === 0 && near(a.capsule.start[1], g + 1 + R) && a.velocity[1] === -1, 'no hit leaves capsule and velocity alone');
  // steep-slope behaviour: force a steep source
  const steep = { descriptor: source.descriptor, contains: () => true, heightAt: (px) => px * 3, normalAt: (px, pz, out) => { const inv = 1 / Math.hypot(3, 1); out[0] = -3 * inv; out[1] = inv; out[2] = 0; return out; } };
  const wq2 = createWorldQueryService();
  wq2.registerProvider(createHeightfieldWorldQueryProvider(steep));
  const s = wq2.resolveCapsule({ capsule: capsuleAt(1, 3 - 0.2, 0), velocity: [0, -2, 0], slopeLimitCos: 0.5 });
  ok(s.grounded === false && s.contacts.length === 1, 'too-steep slope contacts but does not ground');
  ok(s.velocity[0] < 0 && s.velocity[1] > -2, `velocity slides down-slope (vx ${s.velocity[0].toFixed(3)}, vy ${s.velocity[1].toFixed(3)})`);
}

console.log('\n[3] groundProbe: only below the origin, within max distance, slope-limited');
{
  const wq = createWorldQueryService();
  wq.registerProvider(createHeightfieldWorldQueryProvider(source));
  const x = -12, z = 4, g = source.heightAt(x, z);
  const hit = wq.groundProbe({ origin: [x, g + 2, z], maxDistance: 5 });
  ok(hit && near(hit.point[1], g) && near(hit.distance, 2) && hit.providerId === 'terrain' && hit.colliderId === 'lab@1', 'probe from above hits terrain with identity');
  ok(wq.groundProbe({ origin: [x, g - 0.5, z], maxDistance: 5 }) === null, 'origin below the surface: no terrain hit');
  ok(wq.groundProbe({ origin: [x, g + 6, z], maxDistance: 5 }) === null, 'beyond maxDistance: no hit');
  ok(wq.groundProbe({ origin: [x, g, z], maxDistance: 1 }) !== null, 'origin exactly on the surface still hits (distance 0)');
  const steepWq = createWorldQueryService();
  steepWq.registerProvider(createHeightfieldWorldQueryProvider({ descriptor: source.descriptor, heightAt: () => 0, normalAt: (a, b, o) => { o[0] = 0.9; o[1] = 0.1; o[2] = 0; return o; } }));
  ok(steepWq.groundProbe({ origin: [0, 1, 0], maxDistance: 5, slopeLimitCos: 0.5 }) === null, 'too-steep surface is filtered by the service slope limit');
}

console.log('\n[4] finite bounds and holes');
{
  const finiteDesc = normalizeDescriptor({ ...source.descriptor, capabilities: ['heights'], bounds: { minX: -50, maxX: 50, minZ: -50, maxZ: 50 } });
  const finite = createAnalyticSource(finiteDesc);
  const wq = createWorldQueryService();
  const p = createHeightfieldWorldQueryProvider(finite);
  wq.registerProvider(p);
  ok(wq.groundProbe({ origin: [10, 50, 10], maxDistance: 100 }) !== null, 'inside bounds answers');
  ok(wq.groundProbe({ origin: [200, 50, 10], maxDistance: 100 }) === null, 'outside bounds: no implicit floor');
  const out = wq.resolveCapsule({ capsule: capsuleAt(200, -100, 10), velocity: [0, -1, 0] });
  ok(out.contacts.length === 0 && out.grounded === false, 'capsule outside bounds gets no collision');
  // hole: a source that reports a hole in a disc around the origin
  const holed = { ...source, holeAt: (x, z) => x * x + z * z < 4 };
  const wq2 = createWorldQueryService();
  wq2.registerProvider(createHeightfieldWorldQueryProvider(holed));
  ok(wq2.groundProbe({ origin: [0, 50, 0], maxDistance: 100 }) === null, 'probe over a hole: no terrain hit');
  ok(wq2.groundProbe({ origin: [5, 50, 0], maxDistance: 100 }) !== null, 'beside the hole: terrain answers');
  ok(wq2.resolveCapsule({ capsule: capsuleAt(0, -50, 0), velocity: [0, 0, 0] }).contacts.length === 0, 'capsule in a hole falls through terrain');
}

console.log('\n[5] composes with a mesh provider (bridge over terrain, cave floor under a hole)');
{
  const holed = { ...source, holeAt: (x, z) => x > 20 && x < 30 && z > 20 && z < 30 };
  const wq = createWorldQueryService();
  wq.registerProvider(createHeightfieldWorldQueryProvider(holed, { id: 'terrain' }));
  // a flat "bridge" deck at y=10 over x in [0,10], and a cave floor at y=-20 under the hole
  const deck = {
    id: 'mesh', priority: 0,
    groundProbe(q) {
      const [x, y, z] = q.origin;
      const planes = [];
      if (x >= 0 && x <= 10 && z >= 0 && z <= 10 && y >= 10) planes.push(10);
      if (x > 20 && x < 30 && z > 20 && z < 30 && y >= -20) planes.push(-20);
      return planes.filter(py => y - py <= q.maxDistance).map(py => ({ distance: y - py, point: [x, py, z], normal: [0, 1, 0], colliderId: 'deck' }));
    },
  };
  wq.registerProvider(deck);
  const onBridge = wq.groundProbe({ origin: [5, 12, 5], maxDistance: 100 });
  ok(onBridge && onBridge.providerId === 'mesh' && onBridge.point[1] === 10, 'bridge deck answers above the terrain at the same X/Z');
  const underBridge = wq.groundProbe({ origin: [5, 9, 5], maxDistance: 100 });
  ok(underBridge && underBridge.providerId === 'terrain', 'below the deck the terrain answers');
  const inCave = wq.groundProbe({ origin: [25, 5, 25], maxDistance: 100 });
  ok(inCave && inCave.providerId === 'mesh' && inCave.point[1] === -20, 'under a hole the cave floor answers, terrain stays silent');
}

console.log('\n[6] synchronous, allocation-light, and swappable');
{
  const p = createHeightfieldWorldQueryProvider(source);
  const wq = createWorldQueryService();
  wq.registerProvider(p);
  const r = p.resolveCapsule({ capsule: capsuleAt(0, -50, 0), velocity: [0, 0, 0], slopeLimitCos: 0.5 });
  ok(r && typeof r.then !== 'function', 'resolveCapsule is synchronous');
  const other = createAnalyticSource({ key: 'other', sourceVersion: '2', params: { baseAmp: 3, lake: 0.1, lakeDepth: 1 } });
  p.setSource(other);
  const hit = wq.groundProbe({ origin: [3, 50, 3], maxDistance: 100 });
  ok(hit.colliderId === 'other@2' && near(hit.point[1], other.heightAt(3, 3)), 'setSource swaps sampling and identity');
}

console.log('\n[7] the real player controller walks, jumps and lands on terrain');
{
  const wq = createWorldQueryService();
  wq.registerProvider(createHeightfieldWorldQueryProvider(source, { id: 'terrain' }));
  const g0 = source.heightAt(0, 0);
  const controller = createBaseGamePlayerController({ worldQuery: wq, spawn: [0, g0 + 3, 0] });
  const sim = (seconds, input = null) => { for (let i = 0; i < Math.ceil(seconds * 60); i++) { if (input) controller.setInput(input); controller.advance(1 / 60); } };
  sim(2);
  ok(controller.grounded && near(controller.getPosition()[1], g0, 0.05), `settles on terrain (y ${controller.getPosition()[1].toFixed(3)} vs ${g0.toFixed(3)})`);
  ok(controller.surface?.providerId === 'terrain', 'surface identity is the terrain provider');
  sim(2, { moveX: 0, moveZ: 1, yaw: 0, sprint: false });
  const p = controller.getPosition();
  ok(Math.hypot(p[0], p[2]) > 3 && near(p[1], source.heightAt(p[0], p[2]), 0.35), `walks across terrain following the height (${p.map(v => v.toFixed(2)).join(', ')})`);
  controller.setInput({ moveX: 0, moveZ: 0, yaw: 0, sprint: false });
  controller.queueJump();
  let maxY = p[1];
  sim(1.5, null);
  for (let i = 0; i < 90; i++) { controller.advance(1 / 60); maxY = Math.max(maxY, controller.getPosition()[1]); }
  ok(controller.grounded, 'lands again after the jump');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
