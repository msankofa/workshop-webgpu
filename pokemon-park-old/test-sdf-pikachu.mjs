// Node checks for the SDF spike: the bake, and whether the TSL graph actually compiles.
// Run with `node test-sdf-pikachu.mjs`. No GPU, no browser — the shader goes through `tsl-build-check.mjs`.

import fs from 'node:fs';
import { STADIUM_REFERENCE_SPECIES } from './stadium-reference-species.js';
import { MeshBasicNodeMaterial, PlaneGeometry } from 'three/webgpu';
import { buildMaterial } from './tsl-build-check.mjs';
import { parseGLB } from './stadium-glb.js';
import { sdRoundBox } from './foot-sdf.js';
import { bake, createField, upload, MAX_BONES, STRIDE } from './demos/sdf-pikachu-field.js';

let failures = 0;
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(`  ok   ${name}`); }
  catch (e) { failures++; results.push(`  FAIL ${name}\n       ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

const load = (n) => parseGLB(fs.readFileSync(`models/stadium/${n}.glb`));
// The set this spike was built against; the directory now holds all 151.
const MODELS = STADIUM_REFERENCE_SPECIES;

// ===================== the bake =====================

await check('Pikachu bakes into boxes', () => {
  const { json, bin } = load('025_pikachu');
  const baked = bake(json, bin);
  assert(baked.bones.length > 10, `only ${baked.bones.length} bones`);
  assert(baked.dropped === 0, `${baked.dropped} bones past the slot cap`);
  for (const b of baked.bones) {
    assert(b.box.center.every(Number.isFinite), 'a box centre is not finite');
    assert(b.box.half.every(v => Number.isFinite(v) && v >= 0), 'a half extent is bad');
    assert(b.sphere > 0 && Number.isFinite(b.sphere), 'a bounding sphere is bad');
  }
});

await check('every species bakes into the same unit frame, boxes and all', () => {
  // The panel's knobs and the camera are in these units, and these models differ in ROM scale by more
  // than 3x. The mesh itself lands in 0..1 by construction, so what is worth asserting is the BOXES:
  // a box bounds the vertices it was fitted to, so its corners stand slightly proud of the model, and
  // this is the check that "slightly" stays slight rather than a fit having gone wrong.
  let worstLo = 0, worstHi = 1;
  for (const m of MODELS) {
    const { json, bin } = load(m);
    let lo = Infinity, hi = -Infinity;
    for (const b of bake(json, bin).bones) {
      let reach = 0;
      for (let a = 0; a < 3; a++) reach += Math.abs(b.box.axes[a][1]) * b.box.half[a];
      lo = Math.min(lo, b.box.center[1] - reach);
      hi = Math.max(hi, b.box.center[1] + reach);
    }
    // Measured across all fourteen: worst is Nidorino at 0.164 below the floor and 0.139 above the head,
    // so a box-only creature stands a sixth of its height into the ground. That is the cost of the cheap
    // tier stated as a number, and the reason a baked volume is the next thing to try.
    assert(lo > -0.25, `${m}: boxes reach ${lo.toFixed(3)} below the floor`);
    assert(hi < 1.25, `${m}: boxes reach ${hi.toFixed(3)}, well over one unit tall`);
    worstLo = Math.min(worstLo, lo);
    worstHi = Math.max(worstHi, hi);
  }
  assert(worstLo > -0.25 && worstHi < 1.25, `overshoot ${worstLo.toFixed(3)}..${worstHi.toFixed(3)}`);
});

await check('the skip sphere really is a lower bound on the box', () => {
  // The march skips a bone when `|p - centre| - sphere` cannot beat the running minimum. That is only
  // valid if the sphere contains the box, and a box CORNER reaches past the furthest vertex it was
  // fitted to — so sizing the sphere from the vertices, which is the obvious move, carves holes.
  for (const m of MODELS) {
    const { json, bin } = load(m);
    for (const b of bake(json, bin).bones) {
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        const s = [sx, sy, sz];
        const p = [0, 1, 2].map(a => b.box.center[a]
          + b.box.axes[0][a] * b.box.half[0] * s[0]
          + b.box.axes[1][a] * b.box.half[1] * s[1]
          + b.box.axes[2][a] * b.box.half[2] * s[2]);
        const toCentre = Math.hypot(
          p[0] - b.box.center[0], p[1] - b.box.center[1], p[2] - b.box.center[2]);
        const sd = sdRoundBox(b.box, p[0], p[1], p[2]);
        assert(toCentre - b.sphere <= sd + 1e-9,
          `${m}: the sphere reports ${(toCentre - b.sphere).toFixed(5)} where the box is ${sd.toFixed(5)}`);
      }
    }
  }
});

await check('every bone gets a colour, and none of them is out of range', () => {
  const { json, bin } = load('025_pikachu');
  for (const b of bake(json, bin).bones) {
    assert(b.colour.length === 3 && b.colour.every(c => c >= 0 && c <= 1), `bad colour ${b.colour}`);
  }
});

await check('an empty uniform slot is parked out of the way rather than left at zero', () => {
  // Left at zero a spare slot is a zero-radius sphere at the origin with a point-sized box, which the
  // march can hit — the failure that rendered the bug demo as a black ball.
  const field = createField();
  const { json, bin } = load('025_pikachu');
  const baked = bake(json, bin);
  upload(field, baked);
  for (let i = baked.bones.length; i < MAX_BONES; i++) {
    const c = field.boneData.array[i * STRIDE];
    assert(c.y < -100, `slot ${i} sits at y=${c.y}, inside the scene`);
  }
});

await check('the hull sphere contains every bone', () => {
  for (const m of MODELS) {
    const field = createField();
    const { json, bin } = load(m);
    const baked = bake(json, bin);
    const R = upload(field, baked);
    for (const b of baked.bones) {
      const d = Math.hypot(b.box.center[0], b.box.center[1] - field.u.hullY.value, b.box.center[2]) + b.sphere;
      assert(d <= R, `${m}: a bone reaches ${d.toFixed(3)} past a hull of ${R.toFixed(3)}`);
    }
  }
});

// ===================== the shader =====================

await check('the TSL graph compiles', async () => {
  const field = createField();
  const { json, bin } = load('025_pikachu');
  upload(field, bake(json, bin));
  const mat = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
  mat.fragmentNode = field.scenePass();
  const { fragment } = await buildMaterial(mat, new PlaneGeometry(2, 2));
  assert(fragment && fragment.length > 500, 'no fragment shader came out');
  assert(/for\s*\(/.test(fragment), 'expected the bone loop to emit a for loop');
});

await check('the bone loop does not read the march counter as its index', async () => {
  // The exact bug that rendered `sdf-bug-v2` as a black ball: a dynamic Loop names its index `i`, and the
  // march loop nested inside declares its own `i` that shadows it. `toVar('boneIndex')` is the guard.
  const field = createField();
  const mat = new MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
  mat.fragmentNode = field.scenePass();
  const { fragment } = await buildMaterial(mat, new PlaneGeometry(2, 2));
  assert(/boneIndex/.test(fragment), 'the bone index was not given a name of its own');
});

console.log(results.join('\n'));
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
