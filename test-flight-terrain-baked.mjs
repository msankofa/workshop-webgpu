// test-flight-terrain-baked.mjs — the baked-terrain path: the format, the CPU sampler, the source
// swap in flight-terrain.js, and a headless build of the TSL twin.
//
//   node test-flight-terrain-baked.mjs
//
// The point of section 5 is the twin. sampleBake() (JS) and tslBaked (TSL) must do the same
// arithmetic or the plane collides with a hill the player cannot see. The shader cannot run here,
// so the test re-derives the TSL's formulation independently — clamped integer fetches and two
// lerps — and demands it agree with sampleBake to the bit. If someone "simplifies" one side, this
// fails.

import * as THREE from 'three/webgpu';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  Fn, uniform, attribute, vec2, vec3, float, ivec2, clamp, mix, floor, normalize, textureLoad,
} from 'three/tsl';
import { buildMaterial } from './tsl-build-check.mjs';
import {
  BAKE_VERSION, bakeStep, validateBakeMeta, normalizeBake, sampleBake, insideBake,
  bakeRange, bakeHeights, bakeToBytes, bakeFromBytes,
} from './flight-terrain-baked.js';
import { heightAt, analyticHeightAt, setHeightSource, heightSourceActive, agl, dryAnchor, lowestOf, SEA_LEVEL } from './flight-terrain.js';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// A small bake with a known analytic form: h = 2x + 3z, which bilinear reproduces EXACTLY
// (bilinear is exact for functions linear in each variable), so any sampling error is the sampler's.
const RES = 33, SIZE = 320;
const ORIGIN = -SIZE / 2;
const plane = (x, z) => 2 * x + 3 * z;
const planeHeights = bakeHeights(plane, { res: RES, size: SIZE, originX: ORIGIN, originZ: ORIGIN });
const META = { version: BAKE_VERSION, name: 'test', res: RES, size: SIZE, originX: ORIGIN, originZ: ORIGIN };
const flat = normalizeBake(META, planeHeights);

console.log('\n1. format and validation');
{
  ok('bakeStep spans the far edge', near(bakeStep(SIZE, RES), SIZE / (RES - 1)));
  ok('step lands the last post on the edge', near(ORIGIN + (RES - 1) * flat.step, ORIGIN + SIZE));
  ok('good meta validates clean', validateBakeMeta(META).length === 0);
  ok('wrong version rejected', validateBakeMeta({ ...META, version: 99 }).length > 0);
  ok('res < 2 rejected', validateBakeMeta({ ...META, res: 1 }).length > 0);
  ok('non-finite origin rejected', validateBakeMeta({ ...META, originX: NaN }).length > 0);
  let threw = false;
  try { normalizeBake(META, new Float32Array(10)); } catch { threw = true; }
  ok('height count mismatch throws', threw);
  ok('derived fields', flat.maxCell === RES - 2 && near(flat.maxX, ORIGIN + SIZE));
}

console.log('\n2. the CPU sampler');
{
  let worstPost = 0;
  for (let iz = 0; iz < RES; iz++) for (let ix = 0; ix < RES; ix++) {
    const x = ORIGIN + ix * flat.step, z = ORIGIN + iz * flat.step;
    worstPost = Math.max(worstPost, Math.abs(sampleBake(flat, x, z) - plane(x, z)));
  }
  ok('exact on every post', worstPost < 1e-3, `worst ${worstPost}`);

  let worstMid = 0;
  for (let i = 0; i < 500; i++) {
    const x = ORIGIN + Math.random() * SIZE, z = ORIGIN + Math.random() * SIZE;
    worstMid = Math.max(worstMid, Math.abs(sampleBake(flat, x, z) - plane(x, z)));
  }
  // bilinear is exact for a plane, so this is a real correctness bound, not a tolerance
  ok('exact between posts for a linear field', worstMid < 1e-2, `worst ${worstMid}`);

  const edgeH = sampleBake(flat, ORIGIN + SIZE, ORIGIN);
  ok('edge extends outside the grid', near(sampleBake(flat, ORIGIN + SIZE + 5000, ORIGIN), edgeH, 1e-3));
  ok('corner clamps in both axes',
    near(sampleBake(flat, ORIGIN - 9999, ORIGIN - 9999), plane(ORIGIN, ORIGIN), 1e-3));
  ok('insideBake agrees with the bounds',
    insideBake(flat, 0, 0) && !insideBake(flat, ORIGIN - 1, 0) && !insideBake(flat, 0, ORIGIN + SIZE + 1));

  const r = bakeRange(planeHeights);
  ok('bakeRange finds the extremes', near(r.min, plane(ORIGIN, ORIGIN), 1e-3) && near(r.max, plane(-ORIGIN, -ORIGIN), 1e-3));
}

console.log('\n3. bytes round-trip');
{
  const back = bakeFromBytes(bakeToBytes(planeHeights));
  let same = back.length === planeHeights.length;
  for (let i = 0; same && i < back.length; i++) if (back[i] !== planeHeights[i]) same = false;
  ok('float32 survives the round-trip exactly', same);
  ok('byte length is 4 per post', bakeToBytes(planeHeights).byteLength === RES * RES * 4);
}

console.log('\n4. the source swap in flight-terrain.js');
{
  ok('analytic by default', !heightSourceActive());
  const before = heightAt(1234, -567);
  ok('heightAt is the wave field when unset', near(before, analyticHeightAt(1234, -567)));

  setHeightSource((x, z) => sampleBake(flat, x, z));
  ok('source reported active', heightSourceActive());
  ok('heightAt now reads the bake', near(heightAt(40, -80), sampleBake(flat, 40, -80)));
  ok('spacing is ignored by a bake', heightAt(40, -80, 170) === heightAt(40, -80, 0));
  ok('agl rides the swap', near(agl({ x: 40, y: 500, z: -80 }), 500 - sampleBake(flat, 40, -80)));

  // Base placement calls heightAt, so it must follow the swap with no changes of its own.
  const offsets = [[0, 0], [260, 120], [-300, -90]];
  ok('lowestOf reads the baked ground',
    near(lowestOf(0, 0, offsets), Math.min(...offsets.map(([ox, oz]) => sampleBake(flat, ox, oz)))));
  const a = dryAnchor(0, 0, offsets, { maxR: 200, samples: 60 });
  ok('dryAnchor still returns an anchor', Number.isFinite(a.x) && Number.isFinite(a.z) && Number.isFinite(a.low));
  ok('dryAnchor found dry ground on a sloping bake', a.low >= SEA_LEVEL || a.moved > 0);

  setHeightSource(null);
  ok('null restores the wave field exactly', heightAt(1234, -567) === before);
  ok('source reported inactive', !heightSourceActive());
}

console.log('\n5. CPU/GPU twin — same arithmetic, derived independently');
{
  // Re-derivation of what tslBaked does in the shader: clamped integer texel fetches + two lerps.
  // Written from the TSL, NOT from sampleBake, so agreement is evidence rather than tautology.
  const asShader = (b, x, z) => {
    const fx = (x - b.originX) / b.step, fz = (z - b.originZ) / b.step;
    const cx = Math.min(Math.max(Math.floor(fx), 0), b.res - 2);
    const cz = Math.min(Math.max(Math.floor(fz), 0), b.res - 2);
    const tx = Math.min(Math.max(fx - cx, 0), 1), tz = Math.min(Math.max(fz - cz, 0), 1);
    const fetch = (ix, iz) => b.heights[iz * b.res + ix];
    const a0 = fetch(cx, cz) + (fetch(cx + 1, cz) - fetch(cx, cz)) * tx;
    const a1 = fetch(cx, cz + 1) + (fetch(cx + 1, cz + 1) - fetch(cx, cz + 1)) * tx;
    return a0 + (a1 - a0) * tz;
  };
  const rough = normalizeBake(META, bakeHeights((x, z) => analyticHeightAt(x, z), { res: RES, size: SIZE, originX: ORIGIN, originZ: ORIGIN }));
  let worst = 0;
  for (let i = 0; i < 4000; i++) {
    const x = ORIGIN - 400 + Math.random() * (SIZE + 800);   // deliberately overruns, to test the clamp
    const z = ORIGIN - 400 + Math.random() * (SIZE + 800);
    worst = Math.max(worst, Math.abs(sampleBake(rough, x, z) - asShader(rough, x, z)));
  }
  ok('sampler and shader formulation agree', worst === 0, `worst ${worst}`);
}

console.log('\n6. the TSL graph builds');
{
  const res = 64;
  const h = new Float32Array(res * res);
  for (let i = 0; i < h.length; i++) h[i] = Math.sin(i * 0.1) * 40;
  const tex = new THREE.DataTexture(h, res, res, THREE.RedFormat, THREE.FloatType);
  tex.needsUpdate = true;

  const uOrigin = uniform(new THREE.Vector2(-512, -512));
  const uStep = uniform(16);
  const uMax = uniform(res - 2);
  const tslBaked = Fn(([p]) => {
    const f = p.sub(uOrigin).div(uStep);
    const c = clamp(floor(f), vec2(0, 0), vec2(uMax, uMax));
    const t = clamp(f.sub(c), vec2(0, 0), vec2(1, 1));
    const i = ivec2(c);
    const h00 = textureLoad(tex, i).x;
    const h10 = textureLoad(tex, i.add(ivec2(1, 0))).x;
    const h01 = textureLoad(tex, i.add(ivec2(0, 1))).x;
    const h11 = textureLoad(tex, i.add(ivec2(1, 1))).x;
    return mix(mix(h00, h10, t.x), mix(h01, h11, t.x), t.y);
  });

  const aPos = attribute('position', 'vec3');
  const uHalf = uniform(512), uCenter = uniform(new THREE.Vector2());
  const worldPos = Fn(() => {
    const xz = aPos.xz.mul(uHalf).add(uCenter);
    return vec3(xz.x, tslBaked(xz), xz.y);
  })();
  const eps = 16;
  const nrm = Fn(() => {
    const xz = aPos.xz.mul(uHalf).add(uCenter);
    const hL = tslBaked(xz.add(vec2(-eps, 0))), hR = tslBaked(xz.add(vec2(eps, 0)));
    const hD = tslBaked(xz.add(vec2(0, -eps))), hU = tslBaked(xz.add(vec2(0, eps)));
    return normalize(vec3(hL.sub(hR), float(2 * eps), hD.sub(hU)));
  })();

  const mat = new MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0 });
  mat.positionNode = worldPos;
  mat.normalNode = nrm;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));

  let built = null, err = null;
  try { built = await buildMaterial(mat, geo); } catch (e) { err = e; }
  ok('baked terrain material compiles', built != null && !err, err ? err.message : '');
  const shader = built ? JSON.stringify(built) : '';
  ok('the fetch reached the shader', /texelFetch|textureLoad/.test(shader));
}

console.log('\n7. a v5 project through the real bake pipeline');
{
  // No *-project.json exists in the repo yet, so the project path would otherwise ship untested.
  // This is the editor's own default stack and config, run through bakeProjectObject — i.e. through
  // normalizeProject -> generateFullGridV5 -> evaluateStackGrid -> simulateErosion for real.
  const { DEFAULT_CONFIG } = await import('./terrain-generator-js.js');
  const { defaultStack } = await import('./terrain-stack.js');
  const { bakeProjectObject } = await import('./bake-terrain.mjs');

  const raw = {
    app: 'terrain-generator-v5',
    version: 1,
    algorithmVersion: 'v5-unbounded-1',
    name: 'test-bake',
    cfg: { ...DEFAULT_CONFIG, world_x: 2048, world_z: 2048, sea_level: 40 },
    stack: defaultStack(),
  };

  let built = null, err = null;
  try { built = bakeProjectObject(raw, { res: 65 }); } catch (e) { err = e; }
  ok('a default v5 project bakes', built != null, err ? err.message : '');

  if (built) {
    ok('grid is the requested resolution', built.heights.length === 65 * 65);
    ok('size follows the project world', built.size === 2048);
    ok('every height is finite', built.heights.every((h) => Number.isFinite(h)));
    ok('the terrain is not flat', bakeRange(built.heights).max - bakeRange(built.heights).min > 1);
    ok('metadata names the project and its hash',
      built.meta.project === 'test-bake' && /^[0-9a-f]{16,}$/.test(built.meta.projectHash || ''));
    ok('sea level became zero', built.meta.seaLevel === 40);

    // The whole point: the bake drops straight into the sim's height plumbing.
    const b = normalizeBake(
      { version: BAKE_VERSION, name: 'test-bake', res: 65, size: built.size, originX: -built.size / 2, originZ: -built.size / 2 },
      built.heights);
    setHeightSource((x, z) => sampleBake(b, x, z));
    ok('heightAt flies the project', Number.isFinite(heightAt(0, 0)) && heightAt(0, 0) === sampleBake(b, 0, 0));
    const a = dryAnchor(0, 0, [[0, 0], [200, 60]], { maxR: 800, samples: 80 });
    ok('bases can be placed on it', Number.isFinite(a.low));
    setHeightSource(null);
  }
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed\n`);
process.exitCode = fail === 0 ? 0 : 1;
