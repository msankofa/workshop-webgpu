// rocks.js -- displaced-icosphere boulder + scree geometry/material, the Phase 3 (merged-plan
// row #7) rock/boulder + scree host. Adapts SeedThree src/core/rocks.js (weld -> plane-wave
// displace -> squash -> smooth normals; triplanar PBR; shadowSide=BackSide) and fable5
// RockBuilder.ts's idea of baking per-vertex upness/cavity into a vertex attribute at build
// time so the moss/lichen dressing in the material is a cheap attribute read instead of a
// runtime concavity estimate.
//
// TYPES ARE DATA-DRIVEN: createRockPalette({ variants }) takes an array of arbitrary length --
// there is no hardcoded variant-count cap or switch-arm anywhere in this file. Ship a few
// boulder types + 1 scree type as starters (DEFAULT_ROCK_TYPES); grow the table with zero
// code changes.
//
// Standalone module: NOT wired into environment-viewer.html yet (see docs/subsystems/rocks.md
// "Integration" section for the deferred wiring step, coordinated after the concurrent
// Phase-1 plants work lands).
import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  Fn, texture, triplanarTexture, float, vec3, vec4, mix, clamp, smoothstep,
  attribute, cameraViewMatrix, normalView, normalize, positionWorld, dot, sin, fract,
} from 'three/tsl';
import { mossWeight } from './moss-tint.js';
import { rngFrom } from './forest-placement.js';
import { DEFAULT_MOISTURE } from './moisture-proxy.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---- weld (mergeVertices substitute) ----
// three/addons/utils/BufferGeometryUtils.js resolves fine in the browser (importmap ->
// jsdelivr CDN) but ships as an EMPTY file in this repo's local `three` npm install (Node
// devDependency, examples/jsm not published), so a Node-testable rocks.js can't depend on
// it. IcosahedronGeometry (a PolyhedronGeometry) is non-indexed -- every triangle has its own
// duplicated vertices -- so displacing per-triangle-vertex would tear the surface and force
// facet normals. This quantize-and-dedupe pass welds coincident positions and rebuilds a
// proper index, with no three.js addon dependency, before any displacement happens.
function weldGeometry(geometry, precision = 5) {
  const pos = geometry.getAttribute('position');
  const count = pos.count;
  const factor = 10 ** precision;
  const map = new Map();
  const newPos = [];
  const remap = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const x = Math.round(pos.getX(i) * factor) / factor;
    const y = Math.round(pos.getY(i) * factor) / factor;
    const z = Math.round(pos.getZ(i) * factor) / factor;
    const key = `${x},${y},${z}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = newPos.length / 3;
      newPos.push(x, y, z);
      map.set(key, idx);
    }
    remap[i] = idx;
  }
  const srcIndex = geometry.getIndex();
  const triCount = srcIndex ? srcIndex.count : count;
  const indexArr = new Uint32Array(triCount);
  if (srcIndex) {
    for (let i = 0; i < triCount; i++) indexArr[i] = remap[srcIndex.getX(i)];
  } else {
    for (let i = 0; i < triCount; i++) indexArr[i] = remap[i];
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(newPos, 3));
  out.setIndex(new THREE.BufferAttribute(indexArr, 1));
  return out;
}

// ---- geometry ----
// rng: a forest-placement.js rngFrom(seed) instance ({ next(), range(a,b) }) -- same
// deterministic-RNG family as the rest of the placement stack.
// opts: { detail = 1 (icosphere subdivision; 0 "reads as d20 dice" per SeedThree/fable5 --
//         1 is the practical floor), squash (0.55-0.8 boulder Y squash; random in that range
//         if omitted) }.
export function buildRockGeometry(rng, opts = {}) {
  const detail = opts.detail ?? 1;
  const squash = opts.squash ?? rng.range(0.55, 0.8);

  const raw = new THREE.IcosahedronGeometry(1, detail);
  const geo = weldGeometry(raw);
  raw.dispose();

  const pos = geo.getAttribute('position');
  const count = pos.count;

  // SMOOTH boulder silhouettes only -- ~4 random plane waves. All surface DETAIL (ridges,
  // cracks, grain) comes from the triplanar texture maps in buildRockMaterial, not the
  // geometry (SeedThree rocks.js displaceRock comment).
  const waves = [];
  let maxAmp = 0;
  for (let i = 0; i < 4; i++) {
    let dx = rng.range(-1, 1), dy = rng.range(-1, 1), dz = rng.range(-1, 1);
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len; dy /= len; dz /= len;
    const amp = rng.range(0.05, 0.13);
    waves.push({ dx, dy, dz, freq: rng.range(1.0, 2.4), amp, phase: rng.range(0, Math.PI * 2) });
    maxAmp += amp;
  }

  const upness = new Float32Array(count);
  const cavity = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const len = Math.hypot(x, y, z) || 1;
    const nx = x / len, ny = y / len, nz = z / len;
    let d = 1;
    for (const w of waves) d += w.amp * Math.sin((nx * w.dx + ny * w.dy + nz * w.dz) * w.freq * Math.PI + w.phase);
    // Baked BEFORE squash (fable5 RockBuilder.ts idea): upness is the pre-squash sphere-
    // normal Y -- moss/lichen openness approximates "how up-facing was this point before we
    // flattened the boulder". Cavity/AO is a cheap proxy from how far below the mean
    // displacement this vertex sits: dips (d < 1) read as concave/sheltered, bulges (d > 1)
    // read as exposed. Both feed moss-tint.js's mossWeight() at material time.
    upness[i] = Math.max(0, ny);
    cavity[i] = clamp01(0.5 - (d - 1) / (2 * Math.max(maxAmp, 1e-6)));
    pos.setXYZ(i, nx * d, ny * d * squash, nz * d);
  }
  geo.computeVertexNormals();
  geo.setAttribute('rockUpness', new THREE.Float32BufferAttribute(upness, 1));
  geo.setAttribute('rockCavity', new THREE.Float32BufferAttribute(cavity, 1));
  geo.computeBoundingSphere();
  return geo;
}

// ---- material ----
// Cheap world-space hash noise (no texture tap) for the moss "brush" break-up noise, so the
// dressing law doesn't need a 4th sampler bind alongside the 3 triplanar taps/map (albedo/
// roughness/normal) -- keeps the rock draw's sampler count well under budget.
const hashNoise3 = Fn(([p]) => {
  const h = dot(p, vec3(12.9898, 78.233, 37.719));
  return fract(sin(h).mul(43758.5453));
});

// opts: { textures: { albedo, normal, roughness } (THREE.Texture, optional -- falls back to a
//        flat rock grey if omitted), moistureNode (TSL float node, per-instance moisture; the
//        dressing-gpu.js wiring layer supplies this from the instance record's `extra` float --
//        defaults to DEFAULT_MOISTURE for standalone/preview use), normalBase (TSL vec3 node,
//        OPTIONAL -- the instance-rotated world normal the dressing host builds, passed as
//        nodes.nWorld; detail normals are composed ON TOP of it so tilted/rotated instances
//        light correctly. Falls back to view-space normalView for standalone rock previews.),
//        brushScale = 0.6, normalStrength = 0.25, roughnessFloor = 0.92 }.
export function buildRockMaterial(opts = {}) {
  const { textures = {} } = opts;
  const moistureNode = opts.moistureNode ?? float(DEFAULT_MOISTURE);
  const normalBase = opts.normalBase ?? null;
  const brushScale = opts.brushScale ?? 0.6;
  // Detail-normal influence. The rock normal map's fine per-texel detail turns into black/white
  // salt-and-pepper sparkle on big up-facing boulder tops (each micro-normal catches light as a
  // tiny lit/unlit facet), and it aliases/flickers under any small camera motion (the player's
  // ground-spring micro-bob). It CAN'T be mip/anisotropy filtered away because it's the shading
  // response to the normal, not the texture itself -- the only real lever is amplitude. Keep this
  // low (a subtle relief cue, not a rugged surface).
  const normalStrength = opts.normalStrength ?? 0.25;
  const roughnessFloor = opts.roughnessFloor ?? 0.92;

  const mat = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  // Closed smooth geometry: render back faces into the shadow map -- kills terminator acne
  // at the source, so the global normalBias can stay tiny (a big normalBias eats grass-blade
  // shadows -- SeedThree rocks.js comment, cited in the merged plan).
  mat.shadowSide = THREE.BackSide;

  const scale = float(0.35);
  let base = textures.albedo
    ? triplanarTexture(texture(textures.albedo), null, null, scale)
    : vec3(0.54, 0.52, 0.47);
  if (textures.roughness) {
    mat.roughnessNode = clamp(
      triplanarTexture(texture(textures.roughness), null, null, scale).g,
      float(roughnessFloor),
      float(1.0)
    );
  }
  if (textures.normal) {
    // tangent-sample -> deviation from flat (z~1 => ~0), world-locked so it doesn't swim
    // with the camera, added over the smooth vertex normal.
    const d = triplanarTexture(texture(textures.normal), null, null, scale).xyz.mul(2).sub(vec3(1, 1, 2));
    if (normalBase) {
      // Wired path: compose the (world-locked) detail deviation ON TOP of the host's
      // instance-rotated world normal, so tilted boulders keep their detail AND their
      // per-instance rotation. The dressing host detects this normalNode and won't clobber it.
      mat.normalNode = normalize(normalBase.add(d.mul(normalStrength)));
    } else {
      // Standalone/preview path: no instance rotation, compose over the view-space vertex
      // normal (rock-viewer.html and unit previews).
      const dView = cameraViewMatrix.mul(vec4(d, 0)).xyz;
      mat.normalNode = normalize(normalView.add(dView.mul(normalStrength)));
    }
  }

  const upness = attribute('rockUpness', 'float');
  const cavity = attribute('rockCavity', 'float');
  const brush = clamp(hashNoise3(positionWorld.mul(brushScale)), 0, 1);

  // moss/lichen/dirt = the ONE shared dressing law (moss-tint.js), reused verbatim from the
  // terrain (#3) and future deadwood (#8) materials.
  const moss = mossWeight(moistureNode, upness, cavity, brush);
  // lichen: sparser speckle gated to EXPOSED rock (mid-high upness, LOW moisture) -- the opposite
  // gating sense from moss. This is analytic per-fragment noise (positionWorld hash), so it can't
  // be mip/anisotropy filtered: a razor threshold at high frequency crawls/twinkles on up-facing
  // faces under the tiniest camera motion (the reported "top of the rock jitters"). Keep the
  // frequency lower and the edge SOFT (smoothstep, not a hard `sub().mul()`) so it antialiases
  // gracefully instead of aliasing.
  const lichenNoise = hashNoise3(positionWorld.mul(brushScale * 2.0).add(vec3(17.0, 0.0, 0.0)));
  const exposedGate = smoothstep(float(0.3), float(0.55), upness)
    .mul(float(1).sub(smoothstep(float(0.2), float(0.45), moistureNode)));
  const lichen = smoothstep(float(0.62), float(0.9), lichenNoise).mul(0.7).mul(exposedGate);
  // dirt streaks on steep faces (1 - upness), independent of moisture.
  const dirtStreak = float(1).sub(upness).mul(0.4);

  const mossAlbedo = vec3(0.30, 0.42, 0.22);
  const lichenAlbedo = vec3(0.72, 0.74, 0.60);
  const dirtAlbedo = vec3(0.28, 0.22, 0.16);

  base = mix(base, dirtAlbedo, dirtStreak);
  base = mix(base, mossAlbedo, moss);
  base = mix(base, lichenAlbedo, lichen);
  mat.colorNode = base;
  mat.roughnessNode = mix(mat.roughnessNode ?? float(1.0), float(0.95), moss);

  return mat;
}

// ---- palette ----
// Starter content: a couple of boulder types + 1 scree type. `scree: true` is the only field
// dressing-gpu-facing code needs to distinguish a scree type from a boulder type (short cull
// radius, castShadow=false -- see rocks-placement.js/docs/subsystems/rocks.md); everything
// else here is just geometry-recipe tuning. Add more entries with zero code changes.
export const DEFAULT_ROCK_TYPES = [
  { key: 'boulderA', detail: 1, squashRange: [0.6, 0.78], seedsPerType: 3 },
  { key: 'boulderB', detail: 1, squashRange: [0.55, 0.7], seedsPerType: 3 },
  { key: 'scree', detail: 1, squashRange: [0.5, 0.62], seedsPerType: 1, scree: true },
];

// createRockPalette({ variants = DEFAULT_ROCK_TYPES, screeVariant, masterSeed = 1 }):
// `variants` is an array of type descriptors: { key, detail, squash (fixed) or squashRange
// [lo,hi] (random per baked geometry), seedsPerType (how many baked geometries this type
// gets, for visual variety with zero runtime cost), scree (bool) }. `screeVariant` is a
// convenience shorthand: if a type descriptor omits `scree`, it is treated as scree when its
// key matches `screeVariant`.
// Returns { variants: BufferGeometry[] (flat, baked once), types: [{ key, scree, startIdx,
// count }], masterSeed } -- `types[i].startIdx/.count` index into `variants` for that type's
// baked geometries (palette.variants.slice(startIdx, startIdx + count)).
export function createRockPalette(opts = {}) {
  const specs = opts.variants || DEFAULT_ROCK_TYPES;
  const screeVariant = opts.screeVariant;
  const masterSeed = opts.masterSeed ?? 1;

  const variants = [];
  const types = [];
  for (let t = 0; t < specs.length; t++) {
    const spec = specs[t];
    const key = spec.key || `rockType${t}`;
    const seedsPerType = Math.max(1, spec.seedsPerType ?? 1);
    const scree = spec.scree ?? (screeVariant != null && key === screeVariant);
    const startIdx = variants.length;
    const [lo, hi] = spec.squashRange || [0.55, 0.8];
    for (let v = 0; v < seedsPerType; v++) {
      const seed = masterSeed + t * 9791 + v * 641 + 1;
      const rng = rngFrom(seed);
      const squash = spec.squash ?? rng.range(lo, hi);
      variants.push(buildRockGeometry(rng, { detail: spec.detail ?? 1, squash }));
    }
    types.push({ key, scree: !!scree, startIdx, count: seedsPerType });
  }
  return { variants, types, masterSeed };
}
