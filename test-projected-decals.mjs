// test-projected-decals.mjs — instance-buffer contract for projected-decals.js (Mode C).
//
// What this CAN check in Node: that the TSL graph builds at all in both normal and debug mode, and
// that the per-instance box basis is right — orthogonal axes, correct half-extents, the projection
// axis along the given normal, cap clamping, clean disposal.
//
// What it CANNOT check, and what the harness's "project debug" toggle exists for: whether
// viewportDepthTexture can actually sample a MULTISAMPLED depth target inside this pipeline. That is
// the one risk Mode C lives or dies on, and it needs a GPU.
//
// Run: node test-projected-decals.mjs

import * as THREE from 'three/webgpu';

if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({
        createRadialGradient: () => ({ addColorStop() {} }),
        fillStyle: null, fillRect() {}, beginPath() {}, arc() {}, fill() {},
      }),
    }),
  };
}

const { makeStainTexture } = await import('./effect-renderer.js');
const { createProjectedDecals } = await import('./projected-decals.js');

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
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

function harness(debug = false) {
  const children = [];
  const scene = { children, add(o) { children.push(o); }, remove(o) { const i = children.indexOf(o); if (i >= 0) children.splice(i, 1); } };
  const pool = createProjectedDecals({ THREE, scene, decalTexture: makeStainTexture(THREE), cap: 8, debug });
  return { pool, scene, children };
}
const axesOf = (pool) => ['instAxisX', 'instAxisY', 'instAxisZ']
  .map((n) => Array.from(pool.mesh.geometry.getAttribute(n).array.slice(0, 3)));
const len = (v) => Math.hypot(v[0], v[1], v[2]);
const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];

// The graph has to build in BOTH modes — the debug branch swaps colorNode/opacityNode, so it is a
// separate shader graph and a separate chance to be malformed.
for (const debug of [false, true]) {
  const { pool, children } = harness(debug);
  checkTrue(`build(debug=${debug}): mesh added to the scene`, children.length === 1);
  checkTrue(`build(debug=${debug}): starts hidden`, pool.mesh.visible === false);
  check(`build(debug=${debug}): draws after opaque geometry`, pool.mesh.renderOrder, 2);
  pool.dispose();
  checkTrue(`build(debug=${debug}): dispose removes it`, children.length === 0);
}

// The box basis. `size` is the full in-plane width and `depthM` is the reach along the normal in
// EACH direction, so the half-axes are size/2 and depthM.
{
  const { pool } = harness();
  pool.begin();
  const ok = pool.push(1, 2, 3, new THREE.Vector3(0, 0, 1), 0.06, 0.025, 0.4, 0.02, 0.03, 0.9, 1.1);
  pool.end();
  checkTrue('push: accepted', ok === true);
  check('push: one instance', pool.mesh.geometry.instanceCount, 1);
  checkTrue('push: pool becomes visible', pool.mesh.visible === true);

  const [X, Y, Z] = axesOf(pool);
  checkTrue('basis: in-plane half-width is size/2', near(len(X), 0.03) && near(len(Z), 0.03),
    `|X|=${len(X)} |Z|=${len(Z)}`);
  checkTrue('basis: projection half-depth is depthM', near(len(Y), 0.025), `|Y|=${len(Y)}`);
  checkTrue('basis: axes mutually orthogonal',
    near(dot(X, Z), 0) && near(dot(X, Y), 0) && near(dot(Z, Y), 0));
  checkTrue('basis: projection axis lies along the given normal',
    near(Y[0], 0) && near(Y[1], 0) && near(Y[2], 0.025), `got ${Y}`);

  const p = Array.from(pool.mesh.geometry.getAttribute('instPos').array.slice(0, 3));
  checkTrue('basis: centre is the hit point, unlifted', near(p[0], 1) && near(p[1], 2) && near(p[2], 3),
    `got ${p}`);
  pool.dispose();
}

// A near-vertical normal is the case the helper-axis swap exists for — every ground decal is one,
// and without the swap the cross product collapses to zero.
{
  const { pool } = harness();
  pool.begin();
  pool.push(0, 0, 0, new THREE.Vector3(0, 1, 0), 0.06, 0.02, 1, 0, 0, 1);
  pool.end();
  const [X, Y, Z] = axesOf(pool);
  checkTrue('vertical normal: in-plane axes survive', len(X) > 1e-4 && len(Z) > 1e-4,
    `|X|=${len(X)} |Z|=${len(Z)}`);
  checkTrue('vertical normal: still orthogonal', near(dot(X, Z), 0) && near(dot(X, Y), 0));
  pool.dispose();
}

// Rejections and the cap: never write past the buffer, never draw a decal that has faded out.
{
  const { pool } = harness();
  pool.begin();
  checkTrue('reject: zero alpha', pool.push(0, 0, 0, new THREE.Vector3(0, 1, 0), 0.06, 0.02, 1, 0, 0, 0) === false);
  checkTrue('reject: zero size', pool.push(0, 0, 0, new THREE.Vector3(0, 1, 0), 0, 0.02, 1, 0, 0, 1) === false);
  pool.end();
  check('reject: nothing drawn', pool.mesh.geometry.instanceCount, 0);
  checkTrue('reject: pool hidden again', pool.mesh.visible === false);

  pool.begin();
  let accepted = 0;
  for (let i = 0; i < 50; i++) {
    if (pool.push(i, 0, 0, new THREE.Vector3(0, 1, 0), 0.05, 0.02, 1, 0, 0, 1)) accepted++;
  }
  pool.end();
  check('cap: accepted up to the cap only', accepted, 8);
  check('cap: instanceCount clamps', pool.mesh.geometry.instanceCount, 8);

  // Overflow is counted rather than silently swallowed, so the decal-budget slider can show what a
  // cap actually costs instead of the cap being an untested guess.
  check('cap: counts what it refused', pool.dropped, 42);
  check('cap: peak tracks the high-water mark', pool.peak, 8);
  check('cap: dropped peak too', pool.droppedPeak, 42);
  // A faded or zero-size decal was never wanted, so it is not a drop.
  pool.begin();
  pool.push(0, 0, 0, new THREE.Vector3(0, 1, 0), 0.05, 0.02, 1, 0, 0, 0);
  pool.end();
  check('cap: a faded decal is not counted as dropped', pool.dropped, 0);
  check('cap: per-frame drops reset on begin()', pool.dropped, 0);
  check('cap: but the peak survives the frame', pool.droppedPeak, 42);
  pool.resetStats();
  check('cap: resetStats clears the peaks', pool.peak + pool.droppedPeak, 0);
  pool.dispose();
}

// A degenerate normal must not produce a NaN basis — it would poison the whole instance buffer.
{
  const { pool } = harness();
  pool.begin();
  pool.push(0, 0, 0, new THREE.Vector3(0, 0, 0), 0.06, 0.02, 1, 0, 0, 1);
  pool.end();
  const finite = axesOf(pool).every((v) => v.every(Number.isFinite));
  checkTrue('degenerate normal: basis stays finite', finite);
  pool.dispose();
}

console.log(failures === 0 ? '\nAll projected-decal checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
