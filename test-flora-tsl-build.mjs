// test-flora-tsl-build.mjs — the flora TSL graphs, compiled headless.
//
// grass-compute.js is a storage-buffer material, so it cannot go through tsl-build-check itself.
// What CAN be checked is every graph Base Game hands it: the field-window samplers and the
// render-local adapters. If one of those does not compile, the browser shows an empty field with a
// shader error in the console, which is exactly the failure this catches in Node instead.
//
// node test-flora-tsl-build.mjs

import * as THREE from 'three/webgpu';
import { Fn, float, vec2, vec3, uniform } from 'three/tsl';
import { buildMaterial } from './tsl-build-check.mjs';
import { createFieldScheduler } from './terrain-field-scheduler.js';
import { createFieldWindow } from './terrain-field-window.js';
import { createAnalyticSource, analyticDescriptor } from './terrain-source-analytic.js';
import { COVER_CHANNELS } from './flora-field.js';
import { terrainTintNode } from './base-game-terrain.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const section = name => console.log(`\n${name}`);

const descriptor = analyticDescriptor({ key: 'tsl-build', seaLevel: 0 });
const source = createAnalyticSource(descriptor);
const scheduler = createFieldScheduler({ useWorker: false, syncBudgetMs: 1000 });
const window = createFieldWindow({
  source, descriptor, scheduler, label: 'tsl',
  fields: ['surfaceHeights', 'biomeIds', 'moisture', ...COVER_CHANNELS],
  derived: COVER_CHANNELS,
  derive: tile => { for (const c of COVER_CHANNELS) tile[c] = new Uint8Array(tile.texels * tile.texels); return tile; },
  post: 8, tileIntervals: 4, tilesPerSide: 4,
});

async function compiles(name, colorNode) {
  const material = new THREE.MeshBasicNodeMaterial();
  material.colorNode = colorNode;
  try {
    const shaders = await buildMaterial(material);
    return { ok: true, ...shaders };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

section('field-window samplers compile');
{
  const h = window.gpuSampler('surfaceHeights');
  const bilinear = await compiles('height', vec3(h(vec2(1, 2), float(-1000)).mul(0.01)));
  check('a bilinear float sampler compiles', bilinear.ok, bilinear.error);
  check('and emits a texel fetch, not a uv sample', /texelFetch/.test(bilinear.fragment ?? ''),
    (bilinear.fragment ?? '').slice(0, 0) || 'no texelFetch in the emitted shader');

  const ids = window.gpuSampler('biomeIds');
  const nearest = await compiles('biome', vec3(ids(vec2(1, 2), float(0)).mul(1 / 255)));
  check('a nearest id sampler compiles', nearest.ok, nearest.error);

  const cover = window.gpuSampler('coverGrass');
  const coverBuild = await compiles('cover', vec3(cover(vec2(1, 2), float(0)).div(255)));
  check('a u8 cover sampler compiles', coverBuild.ok, coverBuild.error);

  // The fallback argument is what a caller outside the window gets; omitting it must still build.
  const defaulted = await compiles('default fallback', vec3(h(vec2(3, 4)).mul(0.01)));
  check('the fallback argument has a working default', defaulted.ok, defaulted.error);
}

section('the render-local adapters compile');
{
  // Exactly the shape base-game-flora.js builds: global = render-local + origin, and the sampled
  // height comes back into render-local Y.
  const uOrigin = uniform(new THREE.Vector3(4096, 12, -8192));
  const originXZ = vec2(uOrigin.x, uOrigin.z);
  const height = window.gpuSampler('surfaceHeights');
  const cover = window.gpuSampler('coverGrass');
  const uGate = uniform(1);

  const heightNode = Fn(([x, z]) => height(vec2(x, z).add(originXZ), float(-1e5)).sub(uOrigin.y));
  const densityNode = Fn(([x, z]) => {
    const c = cover(vec2(x, z).add(originXZ), float(0)).div(255).clamp(0, 1);
    return float(1).sub(uGate).add(c.mul(uGate)).clamp(0, 1);
  });

  const hBuild = await compiles('heightNode', vec3(heightNode(float(10), float(20)).mul(0.01)));
  check('the height adapter compiles', hBuild.ok, hBuild.error);
  const dBuild = await compiles('densityNode', vec3(densityNode(float(10), float(20))));
  check('the density adapter compiles', dBuild.ok, dBuild.error);

  // grass-compute calls these with two scalars; a vec2 caller would be a silent type mismatch.
  let scalarCallOk = true, err = '';
  try { heightNode(float(1), float(2)); densityNode(float(1), float(2)); } catch (e) { scalarCallOk = false; err = e.message; }
  check('both take two scalars, as grass-compute calls them', scalarCallOk, err);

  const combined = await compiles('both', vec3(heightNode(float(1), float(2)).mul(0.001).add(densityNode(float(1), float(2)))));
  check('both in one graph compile together', combined.ok, combined.error);
}

section('data textures stay data');
{
  // A single-channel id or cover map decoded as sRGB would come back as a different number. These
  // are data maps and must carry no colour space.
  for (const name of ['surfaceHeights', 'biomeIds', 'moisture', 'coverGrass']) {
    const tex = window.texture(name);
    check(`${name} has no colour-space conversion`, tex.colorSpace === THREE.NoColorSpace || tex.colorSpace === '',
      `colorSpace ${JSON.stringify(tex.colorSpace)}`);
  }
  check('id textures are nearest-filtered', window.texture('biomeIds').magFilter === THREE.NearestFilter);
  check('id textures carry no mipmaps', window.texture('biomeIds').generateMipmaps === false);
  check('u8 fields are one byte per texel', window.texture('biomeIds').image.data.BYTES_PER_ELEMENT === 1);
  check('float fields are four', window.texture('surfaceHeights').image.data.BYTES_PER_ELEMENT === 4);
  // r8unorm uploads want a row length WebGPU can align; a power-of-two window keeps that true.
  const res = window.res;
  check('the window row length is a multiple of four', res % 4 === 0, `res ${res}`);
}

section('the ground tint node compiles');
{
  // Grass packs this per blade in the cull. A graph that does not build is an empty field and a
  // shader error in the console, which is what this catches in Node instead.
  const built = await compiles('tint', terrainTintNode(float(12), float(0.9)));
  check('terrainTintNode compiles', built.ok, built.error);
  const nested = await compiles('nested', terrainTintNode(float(3).add(float(1)), float(1)).mul(0.5));
  check('and composes into a larger graph', nested.ok, nested.error);
}

window.dispose();
scheduler.dispose();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
