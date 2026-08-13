// test-body-hit.mjs — ray/part resolution and the attachment handle contract for bot-body-hit.js.
// Pure math against a stand-in rig (plain Object3D parts carrying a geometry, exactly the shape
// player-procedural-body.js's instanced mode produces), so it runs in Node with no GPU.
// Run: node test-body-hit.mjs

import * as THREE from 'three/webgpu';
import { resolveBodyHit, attachFromPoint, resolveAttachmentMatrix, partCrossSection } from './bot-body-hit.js';

let failures = 0;
function checkTrue(name, cond, detail = '') {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` ${detail}`}`);
}
function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
}
const near = (a, b, eps = 1e-5) => Math.abs(a - b) < eps;

// A stand-in for player-procedural-body.js's instanced rig: a group of transform-only Object3Ds,
// each carrying `.geometry` and `._role`, with `parts.all` as the stable index-addressable list.
function makeBody(specs) {
  const group = new THREE.Object3D();
  const all = [];
  for (const s of specs) {
    const p = new THREE.Object3D();
    p.geometry = s.geo;
    p._role = s.role;
    if (s.pos) p.position.set(...s.pos);
    if (s.scale) p.scale.set(...s.scale);
    if (s.rotZ) p.rotation.z = s.rotZ;
    if (s.visible === false) p.visible = false;
    group.add(p);
    all.push(p);
  }
  group.updateMatrixWorld(true);
  return { group, parts: { all } };
}
const unit = () => new THREE.BoxGeometry(1, 1, 1);
const V = (x, y, z) => new THREE.Vector3(x, y, z);

// ---------------------------------------------------------------------------------------
// 1. Basic ray hit: a shot straight down onto a unit box centred at the origin.
// ---------------------------------------------------------------------------------------
{
  const body = makeBody([{ geo: unit(), role: 'shell' }]);
  const hit = resolveBodyHit({ THREE, body, origin: V(0, 10, 0), dir: V(0, -1, 0) });
  checkTrue('hit: resolves', !!hit);
  check('hit: part index', hit.partIndex, 0);
  check('hit: role', hit.role, 'shell');
  checkTrue('hit: lands on the top face', near(hit.point.y, 0.5), `got ${hit.point.y}`);
  checkTrue('hit: normal faces back up the ray',
    near(hit.normal.x, 0) && near(hit.normal.y, 1) && near(hit.normal.z, 0), `got ${hit.normal.toArray()}`);
  checkTrue('hit: local point matches the world point',
    near(hit.localPoint[1], 0.5), `got ${hit.localPoint}`);
}

// ---------------------------------------------------------------------------------------
// 2. Misses and degenerate rigs resolve to null rather than to a wrong part.
// ---------------------------------------------------------------------------------------
{
  const body = makeBody([{ geo: unit(), role: 'shell' }]);
  checkTrue('miss: ray beside the part', resolveBodyHit({ THREE, body, origin: V(5, 10, 0), dir: V(0, -1, 0) }) === null);
  checkTrue('miss: ray pointing away', resolveBodyHit({ THREE, body, origin: V(0, 10, 0), dir: V(0, 1, 0) }) === null);
  // A mesh-mode body has no parts.all; it must decline rather than guess.
  checkTrue('miss: body with no parts.all',
    resolveBodyHit({ THREE, body: { parts: { all: null } }, origin: V(0, 10, 0), dir: V(0, -1, 0) }) === null);
  // Hidden parts (setGearLod drops gear this way) are not shootable.
  const hidden = makeBody([{ geo: unit(), role: 'shell', visible: false }]);
  checkTrue('miss: invisible part skipped',
    resolveBodyHit({ THREE, body: hidden, origin: V(0, 10, 0), dir: V(0, -1, 0) }) === null);
}

// ---------------------------------------------------------------------------------------
// 3. Nearest part wins, and it wins on WORLD distance — the reason the local ray keeps its scale
//    instead of being renormalized, so `t` from a stretched part is still comparable.
// ---------------------------------------------------------------------------------------
{
  const body = makeBody([
    { geo: unit(), role: 'plate', pos: [0, 0, 0] },     // far, and stretched
    { geo: unit(), role: 'shell', pos: [0, 4, 0] },     // near
  ]);
  body.parts.all[0].scale.set(1, 4, 1);
  body.group.updateMatrixWorld(true);
  const hit = resolveBodyHit({ THREE, body, origin: V(0, 10, 0), dir: V(0, -1, 0) });
  check('nearest: picks the closer part', hit.partIndex, 1);
  checkTrue('nearest: on the closer part\'s face', near(hit.point.y, 4.5), `got ${hit.point.y}`);

  // Shooting from below reaches the stretched part first (its world box spans y -2..2).
  const up = resolveBodyHit({ THREE, body, origin: V(0, -10, 0), dir: V(0, 1, 0) });
  check('nearest: from below picks the stretched part', up.partIndex, 0);
  checkTrue('nearest: stretched world face at y=-2', near(up.point.y, -2), `got ${up.point.y}`);
}

// ---------------------------------------------------------------------------------------
// 4. Non-uniform scale + rotation: the returned normal must be perpendicular to the hit face in
//    WORLD space. Checked against two in-face directions rather than against a recomputed normal
//    matrix, so the test can't pass by mirroring the implementation's own arithmetic.
// ---------------------------------------------------------------------------------------
{
  const body = makeBody([{ geo: unit(), role: 'shell', scale: [1, 4, 1], rotZ: Math.PI / 4 }]);
  const part = body.parts.all[0];
  // Aim at the local +X face from far out along the world direction that face now points.
  const faceDirWorld = V(1, 0, 0).transformDirection(part.matrixWorld).normalize();
  const origin = faceDirWorld.clone().multiplyScalar(20);
  const hit = resolveBodyHit({ THREE, body, origin, dir: faceDirWorld.clone().negate() });
  checkTrue('skew: resolves', !!hit);
  // Two directions lying IN the local +X face, pushed to world space as directions.
  const inFace = [V(0, 1, 0), V(0, 0, 1)].map((v) => {
    const w = v.clone().applyMatrix4(part.matrixWorld).sub(V(0, 0, 0).applyMatrix4(part.matrixWorld));
    return w.normalize();
  });
  for (let i = 0; i < inFace.length; i++) {
    const d = hit.normal.dot(inFace[i]);
    checkTrue(`skew: normal perpendicular to in-face direction ${i}`, Math.abs(d) < 1e-6, `dot ${d}`);
  }
  checkTrue('skew: normal is unit length', near(hit.normal.length(), 1));
  // The local point must sit exactly on the local +X face regardless of what world scale did to it.
  checkTrue('skew: local point on the +X face', near(hit.localPoint[0], 0.5), `got ${hit.localPoint}`);
}

// ---------------------------------------------------------------------------------------
// 5. attachFromPoint: attribute an already-accurate world point to the part nearest it.
// ---------------------------------------------------------------------------------------
{
  const body = makeBody([
    { geo: unit(), role: 'plate', pos: [0, 0, 0] },
    { geo: unit(), role: 'shell', pos: [6, 0, 0] },
  ]);
  const a = attachFromPoint({ THREE, body, point: V(6.4, 0, 0), normal: V(1, 0, 0) });
  check('attachFromPoint: picks the nearest part', a.partIndex, 1);
  checkTrue('attachFromPoint: local point is unclamped',
    near(a.localPoint[0], 0.4), `got ${a.localPoint}`);
  const b = attachFromPoint({ THREE, body, point: V(-0.4, 0, 0), normal: V(-1, 0, 0) });
  check('attachFromPoint: other side picks part 0', b.partIndex, 0);
  checkTrue('attachFromPoint: no body resolves to null',
    attachFromPoint({ THREE, body: { parts: { all: null } }, point: V(0, 0, 0) }) === null);
}

// ---------------------------------------------------------------------------------------
// 6. The attachment handle: it must resolve on the body it came from and DECLINE on a body it
//    doesn't match. A stale index is the dangerous case — it would otherwise return a valid matrix
//    for the wrong part and silently drop the decal somewhere else on the bot.
// ---------------------------------------------------------------------------------------
{
  const body = makeBody([
    { geo: unit(), role: 'shell', pos: [0, 0, 0] },
    { geo: unit(), role: 'plate', pos: [3, 0, 0] },
  ]);
  const hit = resolveBodyHit({ THREE, body, origin: V(3, 10, 0), dir: V(0, -1, 0) });
  const at = hit.attach;
  check('handle: carries the part index', at.part, 1);
  check('handle: carries the material role', at.role, 'plate');
  check('handle: carries the part count', at.parts, 2);

  const m = resolveAttachmentMatrix(body, at);
  checkTrue('handle: resolves on its own body', !!m);
  checkTrue('handle: resolves to that part\'s live matrix',
    m === body.parts.all[1].matrixWorld);

  // A body with the same part count but a different role at that index: the guest-mismatch case.
  const other = makeBody([
    { geo: unit(), role: 'shell', pos: [0, 0, 0] },
    { geo: unit(), role: 'trim', pos: [3, 0, 0] },
  ]);
  checkTrue('handle: declines on a role mismatch', resolveAttachmentMatrix(other, at) === null);

  // A rebuilt body with a different part count: the revive case.
  const rebuilt = makeBody([
    { geo: unit(), role: 'shell' }, { geo: unit(), role: 'plate' }, { geo: unit(), role: 'trim' },
  ]);
  checkTrue('handle: declines on a part-count mismatch', resolveAttachmentMatrix(rebuilt, at) === null);

  checkTrue('handle: declines an out-of-range index',
    resolveAttachmentMatrix(body, { part: 9, role: 'plate', parts: 2, lp: [0, 0, 0], ln: [0, 1, 0] }) === null);
  checkTrue('handle: declines a null handle', resolveAttachmentMatrix(body, null) === null);
  checkTrue('handle: declines a null body', resolveAttachmentMatrix(null, at) === null);

  // The live matrix is the whole point: move the part, resolve again, get the new transform.
  body.parts.all[1].position.set(3, 7, 0);
  body.group.updateMatrixWorld(true);
  const moved = resolveAttachmentMatrix(body, at);
  checkTrue('handle: tracks the part after it moves',
    near(moved.elements[13], 7), `got ${moved.elements[13]}`);
}

// ---------------------------------------------------------------------------------------
// 7. partCrossSection — how wide the part is ACROSS its long axis, in world metres. This is what
//    Mode A sizes a decal against, so it must ignore the long axis entirely (a limb stretched 4x
//    along Y is not a wider limb) and must take the NARROWER cross-axis, so a decal fitted to it
//    cannot overhang.
// ---------------------------------------------------------------------------------------
{
  const body = makeBody([
    { geo: unit(), role: 'shell' },                             // 1 x 1 x 1
    { geo: unit(), role: 'plate', pos: [4, 0, 0], scale: [0.10, 4, 0.10] },   // a stretched limb
    { geo: unit(), role: 'trim', pos: [8, 0, 0], scale: [0.30, 1, 0.08] },    // flattened: min wins
  ]);
  const [a, b, c] = body.parts.all;
  checkTrue('cross: unit part is 1 m across', near(partCrossSection(a), 1), `got ${partCrossSection(a)}`);
  checkTrue('cross: stretch along the long axis does not widen it',
    near(partCrossSection(b), 0.10), `got ${partCrossSection(b)}`);
  checkTrue('cross: takes the narrower cross-axis',
    near(partCrossSection(c), 0.08), `got ${partCrossSection(c)}`);

  // It rides along on the hit, because that is where the caller needs it.
  const hit = resolveBodyHit({ THREE, body, origin: V(4, 10, 0), dir: V(0, -1, 0) });
  check('cross: reported on the hit', hit.partIndex, 1);
  checkTrue('cross: hit carries the cross-section', near(hit.crossSection, 0.10), `got ${hit.crossSection}`);
  const att = attachFromPoint({ THREE, body, point: V(4, 0, 0.06), normal: V(0, 0, 1) });
  checkTrue('cross: attachFromPoint carries it too', near(att.crossSection, 0.10), `got ${att.crossSection}`);

  // Rotation must not change it — it is a property of the part, not of how the part is oriented.
  body.parts.all[1].rotation.z = Math.PI / 3;
  body.group.updateMatrixWorld(true);
  checkTrue('cross: unchanged by rotation', near(partCrossSection(b), 0.10), `got ${partCrossSection(b)}`);
}

console.log(failures === 0 ? '\nAll bot-body-hit checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
