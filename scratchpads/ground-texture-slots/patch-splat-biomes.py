import os
os.chdir(os.path.join(os.path.dirname(__file__), '..', '..'))

def patch(path, pairs):
    s = open(path, encoding='utf-8').read()
    for old, new in pairs:
        assert old in s, (path, old[:70])
        s = s.replace(old, new, 1)
    open(path, 'w', encoding='utf-8').write(s)

patch('terrain-splat-streamed.js', [
# imports
("""  textureLoad, ivec2, floor, select, refract, saturate, oneMinus, max as tslMax, textureLevel,
} from 'three/tsl';""",
 """  textureLoad, ivec2, floor, select, refract, saturate, oneMinus, max as tslMax, textureLevel, uniformArray, int,
} from 'three/tsl';
import { BIOMES } from './biome-classifier-js.js';"""),
# constants + pure tables after STREAMED_SPLAT_LAYERS
("""export const STREAMED_SPLAT_LAYERS = Object.freeze(['sand', 'grass', 'dirt', 'rock', 'snow']);""",
 """export const STREAMED_SPLAT_LAYERS = Object.freeze(['sand', 'grass', 'dirt', 'rock', 'snow']);
// Per-biome overrides (a project's material.biomes): the shader reads the biome id under the
// fragment and looks each slot up in a biome x slot table of array-texture layers (-1 = the
// project-wide slot texture) and a biome x rule table of thresholds. Fixed sizes so the uniform
// arrays never change shape.
export const SPLAT_MAX_BIOMES = 32;
export const SPLAT_RULE_NAMES = Object.freeze(['shoreTop', 'grassTop', 'dirtTop', 'snowBottom', 'snowTop', 'rockSlope', 'rockFull']);
export const SPLAT_MAX_BIOME_LAYERS = 16;

// Which folders the biome overrides need, and the biome x slot table into them. Pure.
// `entries` is the distinct folder list (array layer order); `table[b * 5 + s]` is a layer index or -1.
export function biomeLayerTable(material, biomeNames = BIOMES) {
  const entries = [];
  const table = new Int32Array(SPLAT_MAX_BIOMES * STREAMED_SPLAT_LAYERS.length).fill(-1);
  const biomes = material?.biomes ?? {};
  for (const [name, entry] of Object.entries(biomes)) {
    const b = biomeNames.indexOf(name);
    if (b < 0 || b >= SPLAT_MAX_BIOMES) continue;
    for (const [slot, folder] of Object.entries(entry?.slots ?? {})) {
      const s = STREAMED_SPLAT_LAYERS.indexOf(slot);
      if (s < 0 || typeof folder !== 'string' || !folder) continue;
      let k = entries.indexOf(folder);
      if (k < 0) { if (entries.length >= SPLAT_MAX_BIOME_LAYERS) continue; k = entries.push(folder) - 1; }
      table[b * STREAMED_SPLAT_LAYERS.length + s] = k;
    }
  }
  return { entries, table };
}

// Effective thresholds per biome: the project-wide values (cfg-derived plus material.rules, see
// splatConfigFromProject) with each biome's own rules on top. Pure. `rules[b * 7 + r]`.
export function biomeRuleTable(project, defaults = STREAMED_SPLAT_DEFAULTS, biomeNames = BIOMES) {
  const global = { ...defaults, ...splatConfigFromProject(project, defaults) };
  const rules = new Float32Array(SPLAT_MAX_BIOMES * SPLAT_RULE_NAMES.length);
  const biomes = project?.material?.biomes ?? {};
  for (let b = 0; b < SPLAT_MAX_BIOMES; b++) {
    const own = biomes[biomeNames[b]]?.rules ?? {};
    SPLAT_RULE_NAMES.forEach((r, i) => { const v = own[r]; rules[b * SPLAT_RULE_NAMES.length + i] = Number.isFinite(v) ? v : global[r]; });
  }
  return rules;
}

// A per-biome cfg for the CPU twin: the row of the rule table for biome `b`.
export function biomeRuleCfg(rules, b, base = STREAMED_SPLAT_DEFAULTS) {
  const cfg = { ...base };
  SPLAT_RULE_NAMES.forEach((r, i) => { cfg[r] = rules[b * SPLAT_RULE_NAMES.length + i]; });
  return cfg;
}"""),
# browser loader for the array textures, after loadStreamedSplatTextures
("""// Swap the pictures behind an already-bound texture set in place""",
 """// Browser: the biome override folders packed into two array textures (colour, normal), every
// layer resampled to `size` square so the array has one shape. Mipmapped: r184's WebGPU backend
// generates mips per array layer (the old authored splat predates that and shimmered without).
export async function loadStreamedSplatBiomeArray(entries, { basePath = STREAMED_SPLAT_DEFAULTS.basePath, size = 1024, anisotropy = STREAMED_SPLAT_DEFAULTS.anisotropy } = {}) {
  if (!entries?.length) return null;
  const n = Math.min(entries.length, SPLAT_MAX_BIOME_LAYERS);
  const loadImage = url => new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = () => reject(new Error(`could not load ${url}`)); img.src = url; });
  const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const pack = (map) => new Uint8Array(size * size * 4 * n);
  const color = pack('color'), normal = pack('normal');
  const averages = [];
  for (let k = 0; k < n; k++) {
    const [ci, ni] = await Promise.all([loadImage(`${basePath}${entries[k]}/color.jpg`), loadImage(`${basePath}${entries[k]}/normal.jpg`)]);
    ctx.drawImage(ci, 0, 0, size, size); color.set(ctx.getImageData(0, 0, size, size).data, k * size * size * 4);
    averages.push(averageColorOfImage(ci) ?? [0.5, 0.5, 0.5]);
    ctx.drawImage(ni, 0, 0, size, size); normal.set(ctx.getImageData(0, 0, size, size).data, k * size * size * 4);
  }
  const make = (data, srgb) => {
    const t = new THREE.DataArrayTexture(data, size, size, n);
    t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    t.anisotropy = anisotropy; t.flipY = false;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
  };
  return { color: make(color, true), normal: make(normal, false), entries: entries.slice(0, n), averages, size };
}

// Node/test stand-in for loadStreamedSplatBiomeArray: 1x1 layers, one flat colour each.
export function placeholderStreamedSplatBiomeArray(entries, colors = null) {
  const n = entries.length;
  const color = new Uint8Array(n * 4), normal = new Uint8Array(n * 4), averages = [];
  for (let k = 0; k < n; k++) {
    const c = colors?.[k] ?? [0.5, 0.5, 0.5];
    color.set([c[0] * 255, c[1] * 255, c[2] * 255, 255], k * 4); normal.set([128, 128, 255, 255], k * 4); averages.push(c);
  }
  const make = data => { const t = new THREE.DataArrayTexture(data, 1, 1, n); t.needsUpdate = true; return t; };
  return { color: make(color), normal: make(normal), entries: entries.slice(), averages, size: 1 };
}

// Swap the pictures behind an already-bound texture set in place"""),
# material signature + biome uniforms
("""export function createStreamedSplatMaterial(textures, overrides = {}, { lod = null, water = null, rain = null } = {}) {
  const cfg = { ...STREAMED_SPLAT_DEFAULTS, ...overrides };
  const L = textures.layers;""",
 """// `biome`: { idNode: Fn(xz render-local) -> float biome id (negative = unknown) } binds the per-biome
// tables; `textures.biomes` (loadStreamedSplatBiomeArray) adds the override layers. Without
// `biome` the tables are ignored and the material is the plain five-slot one.
export function createStreamedSplatMaterial(textures, overrides = {}, { lod = null, water = null, rain = null, biome = null } = {}) {
  const cfg = { ...STREAMED_SPLAT_DEFAULTS, ...overrides };
  const L = textures.layers;
  const B = biome ? (textures.biomes ?? null) : null;
  const RULES = SPLAT_RULE_NAMES.length, SLOTS = STREAMED_SPLAT_LAYERS.length;"""),
("""    finerOrigin: uniform(new THREE.Vector2()), finerChunk: uniform(1), finerTexels: uniform(0),
  };""",
 """    finerOrigin: uniform(new THREE.Vector2()), finerChunk: uniform(1), finerTexels: uniform(0),
    // per-biome tables (see biomeLayerTable / biomeRuleTable); the rule table starts as the global cfg
    biomeTable: uniformArray(Array.from({ length: SPLAT_MAX_BIOMES * SLOTS }, () => -1), 'int'),
    biomeRules: uniformArray(Array.from({ length: SPLAT_MAX_BIOMES * RULES }, (_, i) => cfg[SPLAT_RULE_NAMES[i % RULES]]), 'float'),
    biomeAverages: uniformArray(Array.from({ length: SPLAT_MAX_BIOME_LAYERS }, (_, k) => new THREE.Vector3(...(B?.averages?.[k] ?? [0.5, 0.5, 0.5])))),
  };
  // Biome id under the fragment, or -1 where no field has streamed; biomes past the table read -1.
  const biomeId = biome
    ? (() => { const raw = biome.idNode(P.xz); return select(raw.lessThan(-0.5).or(raw.greaterThanEqual(SPLAT_MAX_BIOMES)), int(-1), int(raw.add(0.5))); })
    : null;
  // A threshold: the biome's own row when a biome is known, else the global uniform.
  const ruleOf = (name, bid) => {
    if (!bid) return u[name];
    const i = SPLAT_RULE_NAMES.indexOf(name);
    return select(bid.lessThan(0), u[name], u.biomeRules.element(bid.mul(RULES).add(i)));
  };"""),
# P must be defined before biomeId use: move the P/N decls up. They are defined after hash2; we reference P inside a closure, so it's fine at call time. weightsOf takes bid.
("""  const weightsOf = () => {
    const h = P.y, ny = clamp(N.y, 0, 1);
    const sand = float(1).sub(smoothstep(u.shoreTop.sub(1.5), u.shoreTop.add(1.5), h));
    const dirtT = smoothstep(u.grassTop, u.dirtTop, h);
    const snow = smoothstep(u.snowBottom, u.snowTop, h);
    const notSand = float(1).sub(sand);
    const rock = float(1).sub(smoothstep(u.rockFull, u.rockSlope, ny));""",
 """  const weightsOf = (bid = null) => {
    const h = P.y, ny = clamp(N.y, 0, 1);
    const r = name => ruleOf(name, bid);
    const shoreTop = r('shoreTop');
    const sand = float(1).sub(smoothstep(shoreTop.sub(1.5), shoreTop.add(1.5), h));
    const dirtT = smoothstep(r('grassTop'), r('dirtTop'), h);
    const snow = smoothstep(r('snowBottom'), r('snowTop'), h);
    const notSand = float(1).sub(sand);
    const rock = float(1).sub(smoothstep(r('rockFull'), r('rockSlope'), ny));"""),
# sampling loop
("""    const { sampleFor, anchor } = makeSamplers();
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
    }""",
 """    const { sampleFor, anchor } = makeSamplers();
    const bid = biomeId ? biomeId().toVar('splatBiome') : null;
    const w = weightsOf(bid);
    const col = vec3(anchor).toVar('splatCol');
    const nm = vec3(0).toVar('splatNm');
    const avg = vec3(0).toVar('splatAvg');
    STREAMED_SPLAT_LAYERS.forEach((name, s) => {
      const wt = w[name];
      // the array layer this biome uses for the slot, -1 = the project-wide texture
      const layer = B ? select(bid.lessThan(0), int(-1), u.biomeTable.element(bid.mul(SLOTS).add(s))).toVar(`splatLayer_${name}`) : null;
      avg.addAssign((layer ? select(layer.lessThan(0), u.averages[name], u.biomeAverages.element(clamp(layer, 0, SPLAT_MAX_BIOME_LAYERS - 1))) : u.averages[name]).mul(wt));
      If(wt.greaterThan(WEIGHT_EPS), () => {
        const sample = sampleFor(name);
        if (!layer) {
          col.addAssign(sample(L[name].color).rgb.mul(wt));
          nm.addAssign(sample(L[name].normal).rgb.mul(wt));
          return;
        }
        If(layer.lessThan(0), () => {
          col.addAssign(sample(L[name].color).rgb.mul(wt));
          nm.addAssign(sample(L[name].normal).rgb.mul(wt));
        }).Else(() => {
          col.addAssign(sample(B.color, layer).rgb.mul(wt));
          nm.addAssign(sample(B.normal, layer).rgb.mul(wt));
        });
      });
    });"""),
# samplers accept an optional array layer
("""    const sampleProj = (tex, uv, gr) => mix(
      texture(tex, uv).grad(gr[0], gr[1]),
      texture(tex, uv.mul(farInv)).grad(gr[0].mul(farInv), gr[1].mul(farInv)),
      farTile,
    );
    const planar = tex => sampleProj(tex, uvXZ, gXZ);
    // rock: world-normal-weighted xz / zy / xy projections so cliffs and cave walls do not smear
    const triplanar = tex => sampleProj(tex, uvZY, gZY).mul(triW.x).add(sampleProj(tex, uvXZ, gXZ).mul(triW.y)).add(sampleProj(tex, uvXY, gXY).mul(triW.z));""",
 """    const tap = (tex, uv, layer) => layer ? texture(tex, uv).depth(layer) : texture(tex, uv);
    const sampleProj = (tex, uv, gr, layer) => mix(
      tap(tex, uv, layer).grad(gr[0], gr[1]),
      tap(tex, uv.mul(farInv), layer).grad(gr[0].mul(farInv), gr[1].mul(farInv)),
      farTile,
    );
    const planar = (tex, layer = null) => sampleProj(tex, uvXZ, gXZ, layer);
    // rock: world-normal-weighted xz / zy / xy projections so cliffs and cave walls do not smear
    const triplanar = (tex, layer = null) => sampleProj(tex, uvZY, gZY, layer).mul(triW.x).add(sampleProj(tex, uvXZ, gXZ, layer).mul(triW.y)).add(sampleProj(tex, uvXY, gXY, layer).mul(triW.z));"""),
# userData + update
("""  mat.userData.streamedSplat = { uniforms: u, cfg, layers: STREAMED_SPLAT_LAYERS, lod: !!lod, coverageMaps, water: !!water, rain: !!rain };""",
 """  mat.userData.streamedSplat = { uniforms: u, cfg, layers: STREAMED_SPLAT_LAYERS, lod: !!lod, coverageMaps, water: !!water, rain: !!rain, biome: !!biome, biomeLayers: B?.entries?.length ?? 0 };"""),
("""    if (k === 'averages' && v && typeof v === 'object') { for (const [n, a] of Object.entries(v)) if (u.averages[n] && Array.isArray(a)) u.averages[n].value.set(a[0], a[1], a[2]); continue; }""",
 """    if (k === 'averages' && v && typeof v === 'object') { for (const [n, a] of Object.entries(v)) if (u.averages[n] && Array.isArray(a)) u.averages[n].value.set(a[0], a[1], a[2]); continue; }
    if (k === 'biomeTable' && v?.length === u.biomeTable.array.length) { for (let i = 0; i < v.length; i++) u.biomeTable.array[i] = v[i]; continue; }
    if (k === 'biomeRules' && v?.length === u.biomeRules.array.length) { for (let i = 0; i < v.length; i++) u.biomeRules.array[i] = v[i]; continue; }
    if (k === 'biomeAverages' && Array.isArray(v)) { v.slice(0, SPLAT_MAX_BIOME_LAYERS).forEach((a, i) => u.biomeAverages.array[i].set(a[0], a[1], a[2])); continue; }"""),
])
print('patched')
