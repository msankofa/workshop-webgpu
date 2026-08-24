// terrain-splat-streamed.js — ground textures for the STREAMED terrain (Base Game chunks and the
// volume LOD cascade). The authored-map splat (terrain-textures.js) needs per-vertex biome weights
// that streamed tiles do not carry yet, so this one decides its layers per fragment from world
// height and slope: sand at the shore, grass on flats, dirt on the transition, rock on steep
// faces (triplanar, so cliffs and cave walls do not smear), snow up high.
//
// Built so it cannot turn into static at distance — the same lesson as the flight-sim height
// band limit (docs/subsystems/flight.md), applied to texture detail:
//   - every map is an ordinary mipmapped texture (the packed DataArrayTexture path of the authored
//     splat has no mips on WebGPU and is exactly what shimmered in environment-viewer);
//   - a second, 7x-larger tiling of the same albedo takes over as the fine tile drops under a few
//     pixels, and beyond `fadeFar` the albedo settles on the layer's AVERAGE colour (its 1x1 mip);
//   - normal-map strength and the anti-tiling macro hash fade to nothing over the same distances.
// CPU twins of the layer weights (`splatWeights`) and fades (`detailFade`) keep the rules testable.

import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { wetPuddleField, wetRippleOffset, wetAlbedoScale, wetRoughness } from './rain.js';
import {
  Fn, If, Discard, uniform, texture, vec2, vec3, vec4, float, mix, clamp, smoothstep, normalize, abs, pow, max,
  positionWorld, normalLocal, cameraPosition, length, fract, sin, dot, transformNormalToView, dFdx, dFdy, property,
  textureLoad, ivec2, floor, select, refract, saturate, oneMinus, max as tslMax,
} from 'three/tsl';

export const STREAMED_SPLAT_LAYERS = Object.freeze(['sand', 'grass', 'dirt', 'rock', 'snow']);

export const STREAMED_SPLAT_DEFAULTS = Object.freeze({
  basePath: './textures/ground/',
  tileMeters: 4,        // fine tiling
  farTileScale: 7,      // the second octave tiles 7x larger
  farTileStart: 40,     // metres: fine -> far tiling blend
  farTileEnd: 220,
  fadeNear: 250,        // metres: detail -> average colour, normal strength -> 0, macro -> 0
  fadeFar: 1400,
  normalStrength: 0.8,
  macroStrength: 0.18,  // world-space value break-up, sampler-free
  anisotropy: 8,
  // slope/height rules (world metres, normal.y)
  shoreTop: 2.5,        // sand below this
  grassTop: 55,         // grass fades to dirt from here...
  dirtTop: 85,          // ...fully dirt by here
  snowBottom: 95,       // snow fades in from here...
  snowTop: 130,         // ...fully snow by here
  rockSlope: 0.80,      // normal.y below this starts rock
  rockFull: 0.58,       // normal.y below this is all rock
});

// Fallback average colours (linear-ish sRGB) used until a texture's real average is known.
const AVERAGE_FALLBACK = {
  sand: [0.72, 0.66, 0.46], grass: [0.30, 0.44, 0.20], dirt: [0.42, 0.34, 0.24], rock: [0.40, 0.39, 0.37], snow: [0.90, 0.91, 0.94],
};

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };

// CPU twin of the shader's layer weights: [sand, grass, dirt, rock, snow], summing to 1.
export function splatWeights(height, normalY, cfg = STREAMED_SPLAT_DEFAULTS) {
  const sand = 1 - sstep(cfg.shoreTop - 1.5, cfg.shoreTop + 1.5, height);
  const dirtT = sstep(cfg.grassTop, cfg.dirtTop, height);
  const snow = sstep(cfg.snowBottom, cfg.snowTop, height);
  let grass = (1 - sand) * (1 - dirtT) * (1 - snow);
  let dirt = (1 - sand) * dirtT * (1 - snow);
  let snowW = (1 - sand) * snow;
  const rock = 1 - sstep(cfg.rockFull, cfg.rockSlope, normalY);
  const flat = 1 - rock;
  return [sand * flat, grass * flat, dirt * flat, rock, snowW * flat];
}

// CPU twin of the distance fades: { farTile, detail } in [0, 1].
export function detailFade(distance, cfg = STREAMED_SPLAT_DEFAULTS) {
  return { farTile: sstep(cfg.farTileStart, cfg.farTileEnd, distance), detail: 1 - sstep(cfg.fadeNear, cfg.fadeFar, distance) };
}

// Average colour of an image (its 1x1 mip), for the far fade. Browser only; null elsewhere.
export function averageColorOfImage(image) {
  try {
    if (typeof document === 'undefined' || !image?.width) return null;
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, 8, 8);
    const d = ctx.getImageData(0, 0, 8, 8).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4;
    // sRGB bytes -> linear, matching the colour-space conversion the sampler applies
    const lin = v => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return [lin(r / n), lin(g / n), lin(b / n)];
  } catch { return null; }
}

// Browser: load colour + normal maps for every layer. Returns { layers: { name: { color, normal, average } } }.
export async function loadStreamedSplatTextures({ basePath = STREAMED_SPLAT_DEFAULTS.basePath, anisotropy = STREAMED_SPLAT_DEFAULTS.anisotropy, layers = STREAMED_SPLAT_LAYERS } = {}) {
  const loader = new THREE.TextureLoader();
  const load = (url, color) => new Promise((resolve, reject) => loader.load(url, t => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.anisotropy = anisotropy;
    if (color) t.colorSpace = THREE.SRGBColorSpace;
    resolve(t);
  }, undefined, reject));
  const out = {};
  await Promise.all(layers.map(async name => {
    const [color, normal] = await Promise.all([load(`${basePath}${name}/color.jpg`, true), load(`${basePath}${name}/normal.jpg`, false)]);
    out[name] = { color, normal, average: averageColorOfImage(color.image) ?? AVERAGE_FALLBACK[name] };
  }));
  return { layers: out };
}

// Node/test stand-in: 1x1 textures per layer so the material graph builds headless.
export function placeholderStreamedSplatTextures(layers = STREAMED_SPLAT_LAYERS) {
  const out = {};
  for (const name of layers) {
    const avg = AVERAGE_FALLBACK[name];
    const color = new THREE.DataTexture(new Uint8Array([avg[0] * 255, avg[1] * 255, avg[2] * 255, 255]), 1, 1);
    const normal = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1);
    color.needsUpdate = normal.needsUpdate = true;
    out[name] = { color, normal, average: avg };
  }
  return { layers: out };
}

// The material. `textures` is the result of loadStreamedSplatTextures / placeholder.
// LOD dissolve (`lod: true`): two coverage maps (terrain-lod-coverage.js) drive per-fragment
// discards with one stable world-space dither — `self` is this level's own chunk coverage
// (fragments dissolve IN over the first half of its ramp) and `finer` is the next finer level's
// (fragments dissolve OUT over the second half), so the finer surface is fully there before the
// coarser one starts leaving and the void never shows. A chunk landing
// late from a worker fades in instead of snapping. `lod = { self, finer }` binds the maps at build
// time (a texture node is fixed once built); syncStreamedSplatCoverage() follows their origins.
// `rain` (optional): { uniforms, offset, puddleScale, rippleScale } where `uniforms` is a rain.js
// uniform set — wets the whole ground: albedo darkens, roughness drops, puddles pool on the flats
// and ripples bend the normal. The fields come from rain.js itself (wetPuddleField /
// wetRippleOffset / wetAlbedoScale / wetRoughness) rather than being re-derived here, so rain beads
// the same way on the terrain as on everything standing on it. `offset` is the render origin, so
// scene xz + offset is the global xz the puddles are anchored to and a rebase does not move them.
// The graph is built once and gated on `uWetness`: a uniform branch is coherent across the draw,
// and rebuilding the splat instances the first time it rains is a visible hitch.
//
// `water` (optional): { sceneLevel, offset, sunDir, sunColor, time, causticStrength, causticSpread
// uniforms; waveNormalFold(xzNode) -> vec4 } — adds a wet tide band above the waterline and the
// water-demo's analytic Snell caustic below it (sun ray refracted at the wave surface, screen-
// derivative area ratio). All driven by uniforms the water module owns; sceneLevel very negative
// (or causticStrength 0) turns each part off without a rebuild.
export function createStreamedSplatMaterial(textures, overrides = {}, { lod = null, water = null, rain = null } = {}) {
  const cfg = { ...STREAMED_SPLAT_DEFAULTS, ...overrides };
  const L = textures.layers;
  for (const name of STREAMED_SPLAT_LAYERS) if (!L[name]?.color || !L[name]?.normal) throw new TypeError(`streamed splat needs colour + normal textures for '${name}'`);

  const u = {
    tile: uniform(1 / cfg.tileMeters),
    farTileScale: uniform(cfg.farTileScale),
    farTileStart: uniform(cfg.farTileStart), farTileEnd: uniform(cfg.farTileEnd),
    fadeNear: uniform(cfg.fadeNear), fadeFar: uniform(cfg.fadeFar),
    normalStrength: uniform(cfg.normalStrength),
    macroStrength: uniform(cfg.macroStrength),
    shoreTop: uniform(cfg.shoreTop), grassTop: uniform(cfg.grassTop), dirtTop: uniform(cfg.dirtTop),
    snowBottom: uniform(cfg.snowBottom), snowTop: uniform(cfg.snowTop),
    rockSlope: uniform(cfg.rockSlope), rockFull: uniform(cfg.rockFull),
    averages: Object.fromEntries(STREAMED_SPLAT_LAYERS.map(n => [n, uniform(new THREE.Vector3(...(L[n].average ?? AVERAGE_FALLBACK[n])))])),
    // coverage maps: origin = chunk index at texel (0,0); size 0 = unbound (self → fully present, finer → nothing)
    selfOrigin: uniform(new THREE.Vector2()), selfChunk: uniform(1), selfTexels: uniform(0),
    finerOrigin: uniform(new THREE.Vector2()), finerChunk: uniform(1), finerTexels: uniform(0),
  };
  const blankCoverage = (() => { const t = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType); t.needsUpdate = true; return t; })();
  const coverageMaps = { self: lod?.self ?? null, finer: lod?.finer ?? null };
  // `finer` uses the eroded map: the coarse level keeps one chunk of overlap into the finer region
  const coverageTex = { self: coverageMaps.self?.texture ?? blankCoverage, finer: coverageMaps.finer?.erodedTexture ?? coverageMaps.finer?.texture ?? blankCoverage };
  // coverage of the chunk under the fragment in one map: 0 outside the map
  const coverageOf = (which) => {
    const origin = u[`${which}Origin`], chunk = u[`${which}Chunk`], texels = u[`${which}Texels`];
    const c = floor(P.xz.div(chunk)).sub(origin);
    const outside = c.x.lessThan(0).or(c.y.lessThan(0)).or(c.x.greaterThanEqual(texels)).or(c.y.greaterThanEqual(texels));
    const t = textureLoad(which === 'self' ? coverageTex.self : coverageTex.finer, ivec2(clamp(c, vec2(0), texels.sub(1)))).x;
    return select(outside, float(0), t);
  };

  const hash2 = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));

  const P = positionWorld;
  const N = normalLocal;   // chunk meshes are unrotated: object normal == world normal
  const dist = length(P.sub(cameraPosition));
  const farTile = smoothstep(u.farTileStart, u.farTileEnd, dist);
  const detail = float(1).sub(smoothstep(u.fadeNear, u.fadeFar, dist));

  // Texture reads are the cost, so a layer is sampled only where its weight is non-trivial. That
  // puts sampling inside non-uniform branches, which WGSL allows only with explicit gradients:
  // the uv derivatives are taken once per projection in uniform control flow (dFdx/dFdy) and
  // every sample uses `.grad()`. Flat grass then costs one layer, a cliff edge two or three.
  const WEIGHT_EPS = 0.004;
  const s = u.tile;
  const farInv = float(1).div(u.farTileScale);
  // Called at the top of each Fn: the uv derivatives become vars in uniform control flow (WGSL
  // forbids derivatives inside non-uniform branches), then every branch samples with .grad().
  const makeSamplers = () => {
    const uvXZ = P.xz.mul(s).toVar(), uvZY = P.zy.mul(s).toVar(), uvXY = P.xy.mul(s).toVar();
    const g = uv => [dFdx(uv).toVar(), dFdy(uv).toVar()];
    const gXZ = g(uvXZ), gZY = g(uvZY), gXY = g(uvXY);
    const triW = (() => { const w = pow(abs(N), vec3(4)); return w.div(max(w.x.add(w.y).add(w.z), 1e-4)).toVar(); })();
    // fine + far tiling of one map on one projection, explicit gradients for both
    const sampleProj = (tex, uv, gr) => mix(
      texture(tex, uv).grad(gr[0], gr[1]),
      texture(tex, uv.mul(farInv)).grad(gr[0].mul(farInv), gr[1].mul(farInv)),
      farTile,
    );
    const planar = tex => sampleProj(tex, uvXZ, gXZ);
    // rock: world-normal-weighted xz / zy / xy projections so cliffs and cave walls do not smear
    const triplanar = tex => sampleProj(tex, uvZY, gZY).mul(triW.x).add(sampleProj(tex, uvXZ, gXZ).mul(triW.y)).add(sampleProj(tex, uvXY, gXY).mul(triW.z));
    // TSL declares a var where it is first used; anchor the gradients here so they are declared in
    // uniform flow (WGSL refuses derivatives inside the non-uniform layer branches below).
    const anchor = gXZ[0].x.add(gXZ[1].x).add(gZY[0].x).add(gZY[1].x).add(gXY[0].x).add(gXY[1].x).add(triW.x).mul(0).toVar('splatAnchor');
    return { sampleFor: name => (name === 'rock' ? triplanar : planar), anchor };
  };

  const weightsOf = () => {
    const h = P.y, ny = clamp(N.y, 0, 1);
    const sand = float(1).sub(smoothstep(u.shoreTop.sub(1.5), u.shoreTop.add(1.5), h));
    const dirtT = smoothstep(u.grassTop, u.dirtTop, h);
    const snow = smoothstep(u.snowBottom, u.snowTop, h);
    const notSand = float(1).sub(sand);
    const rock = float(1).sub(smoothstep(u.rockFull, u.rockSlope, ny));
    const flat = float(1).sub(rock);
    return {
      sand: sand.mul(flat),
      grass: notSand.mul(float(1).sub(dirtT)).mul(float(1).sub(snow)).mul(flat),
      dirt: notSand.mul(dirtT).mul(float(1).sub(snow)).mul(flat),
      snow: notSand.mul(snow).mul(flat),
      rock,
    };
  };

  // One Fn samples everything (so the hoisted gradients cover every branch). three evaluates
  // colorNode first, then roughness, then normal, so the colour Fn owns the work and hands the
  // roughness and the tilted object-space normal on through shader properties.
  const roughProp = property('float', 'splatRough');
  const normalProp = property('vec3', 'splatNormal');
  const shadeAll = Fn(() => {
    if (lod) {
      // stable world-space dither at ~12 cm so the dissolve does not crawl with the camera
      const dither = fract(sin(dot(floor(P.xz.mul(8)), vec2(127.1, 311.7))).mul(43758.5453));
      const selfT = select(u.selfTexels.greaterThan(0), coverageOf('self'), float(1));
      const finerT = select(u.finerTexels.greaterThan(0), coverageOf('finer'), float(0));
      // staggered: this level fades in over the first half of its ramp, the coarser level fades
      // out over the second half (the two surfaces do not share pixels, so never at the same time)
      const fadeIn = clamp(selfT.mul(2), 0, 1), fadeOut = clamp(finerT.mul(2).sub(1), 0, 1);
      If(dither.greaterThanEqual(fadeIn).or(dither.lessThan(fadeOut)), () => { Discard(); });
    }
    const { sampleFor, anchor } = makeSamplers();
    const w = weightsOf();
    const col = vec3(anchor).toVar('splatCol');
    const nm = vec3(0).toVar('splatNm');
    const avg = vec3(0).toVar('splatAvg');
    for (const name of STREAMED_SPLAT_LAYERS) {
      const wt = w[name];
      avg.addAssign(u.averages[name].mul(wt));
      If(wt.greaterThan(WEIGHT_EPS), () => {
        const sample = sampleFor(name);
        col.addAssign(sample(L[name].color).rgb.mul(wt));
        nm.addAssign(sample(L[name].normal).rgb.mul(wt));
      });
    }
    // far: the sampled colour settles on the layers' average (their 1x1 mip)
    let outCol = mix(avg, col, detail);
    // macro break-up, faded with the same detail so it never becomes static at the horizon
    const macro = hash2(P.xz.mul(0.018)).sub(0.5).mul(0.22).mul(u.macroStrength).mul(detail).add(1.0);
    outCol = outCol.mul(macro);
    let rough = mix(float(0.95), float(0.75), w.rock).add(w.snow.mul(-0.1)).add(w.sand.mul(-0.05));
    // How much of this fragment is under the sea. Rain only wets what is out of the water, so this
    // is computed before either branch and gates the rain one: the tide band and the rain are two
    // different things happening to the same ground and they multiply rather than overwrite.
    const submerged = water
      ? oneMinus(smoothstep(water.sceneLevel, water.sceneLevel.add(0.6), P.y))
      : float(0);
    if (water) {
      // Wet ground: darker below the waterline, and a narrow glossy strip AT it (a sheen band, not
      // a polished seabed — submerged sand stays rough or the whole floor mirrors the sun).
      const strip = submerged.mul(smoothstep(water.sceneLevel.sub(1.2), water.sceneLevel.sub(0.2), P.y));
      outCol = outCol.mul(mix(float(1), float(0.72), submerged));
      rough = mix(rough, float(0.55), strip);
    }
    let rainRipple = null;
    if (rain) {
      const pw = rain.offset ? P.xz.add(rain.offset) : P.xz;
      const dry = oneMinus(submerged);                       // no puddles on the seabed
      const puddle = wetPuddleField(rain.uniforms, pw, smoothstep(0.6, 0.9, N.y).mul(dry), rain.puddleScale ?? 0.09);
      rainRipple = wetRippleOffset(rain.uniforms, pw, puddle, rain.rippleScale ?? 3.0).mul(dry);
      outCol = outCol.mul(mix(float(1), wetAlbedoScale(rain.uniforms, puddle), dry));
      rough = mix(rough, wetRoughness(rain.uniforms, rough, puddle), dry);
    }
    roughProp.assign(clamp(rough, 0.3, 1));
    const nmT = nm.mul(2).sub(1);
    // xz projection: map x -> world x, map y -> world -z
    const strength = u.normalStrength.mul(detail);
    let tilted = N.add(vec3(nmT.x.mul(strength), 0, nmT.y.negate().mul(strength)));
    if (rainRipple) tilted = tilted.add(vec3(rainRipple.x, 0, rainRipple.y));
    normalProp.assign(normalize(tilted));
    return vec4(clamp(outCol, 0, 1), 1);
  });

  const mat = new MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  mat.vertexColors = false;
  mat.colorNode = shadeAll();
  mat.roughnessNode = roughProp;
  if (water) {
    const ETA = 1 / 1.33;
    mat.emissiveNode = Fn(() => {
      const out = float(0).toVar('causticOut');
      const depth = water.sceneLevel.sub(P.y);
      // The sun-elevation gate is part of the branch: a low sun makes the refracted ray almost
      // horizontal, and dividing by its vanishing y gave inf -> NaN -> black fragments (NaN * 0
      // is still NaN, so gating the result afterwards could not clean it up).
      If(depth.greaterThan(0.0).and(water.causticStrength.greaterThan(0.0)).and(water.sunDir.y.greaterThan(0.12)), () => {
        const fade = saturate(depth.mul(0.6));
        const r0 = refract(water.sunDir.negate(), vec3(0, 1, 0), ETA);
        const t0 = depth.div(tslMax(r0.y.negate(), 0.15));
        const S = P.sub(r0.mul(t0));
        const N = water.waveNormalFold(S.xz.add(water.offset)).xyz;
        const r1 = refract(water.sunDir.negate(), N, ETA);   // eta < 1 never totally reflects, so r1 is finite
        const Pn = S.add(r1.mul(depth.mul(water.causticSpread).div(tslMax(r1.y.negate(), 0.05))));
        const Po = S.add(r0.mul(depth.mul(water.causticSpread).div(tslMax(r0.y.negate(), 0.05))));
        const oldArea = length(dFdx(Po)).mul(length(dFdy(Po)));
        const newArea = length(dFdx(Pn)).mul(length(dFdy(Pn)));
        // The area ratio is a screen derivative: it aliases into moire once a texel spans more
        // than a pixel, so it fades out with the same distance ramp the albedo detail uses.
        const near = oneMinus(smoothstep(60.0, 220.0, length(P.sub(cameraPosition))));
        const ratio = clamp(oldArea.div(tslMax(newArea, 1e-5)).mul(0.2), 0.0, 1.5);
        out.assign(select(ratio.lessThan(1e6), ratio, float(0)).mul(fade).mul(near).mul(water.causticStrength));
      });
      return water.sunColor.mul(out).mul(vec3(0.6, 0.85, 1.0)).mul(smoothstep(0.12, 0.35, water.sunDir.y));
    })();
  }
  mat.normalNode = transformNormalToView(normalProp);   // object-space in, as transformNormalToView expects
  mat.userData.streamedSplat = { uniforms: u, cfg, layers: STREAMED_SPLAT_LAYERS, lod: !!lod, coverageMaps, water: !!water, rain: !!rain };
  syncStreamedSplatCoverage(mat);
  return mat;
}

// Copy the bound coverage maps' origin/size into the uniforms (call after their recentre()).
export function syncStreamedSplatCoverage(material) {
  const s = material?.userData?.streamedSplat;
  if (!s || !s.lod) return false;
  for (const which of ['self', 'finer']) {
    const c = s.coverageMaps[which], u = s.uniforms;
    if (!c) { u[`${which}Texels`].value = 0; continue; }
    u[`${which}Origin`].value.set(c.originX, c.originZ);
    u[`${which}Chunk`].value = c.chunkSize;
    u[`${which}Texels`].value = c.texels;
  }
  return true;
}

// Live tuning: patch any subset of STREAMED_SPLAT_DEFAULTS on a built material.
export function updateStreamedSplat(material, patch = {}) {
  const s = material?.userData?.streamedSplat;
  if (!s) return false;
  const u = s.uniforms;
  for (const [k, v] of Object.entries(patch)) {
    if (!Number.isFinite(v)) continue;
    if (k === 'tileMeters') { u.tile.value = 1 / Math.max(0.1, v); s.cfg.tileMeters = v; continue; }
    if (u[k] && typeof u[k].value === 'number') { u[k].value = v; s.cfg[k] = v; }
  }
  return true;
}
