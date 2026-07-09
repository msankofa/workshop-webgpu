// test-terrain-splat.mjs — pure-math coverage for the Phase 2 merged terrain bake
// (terrain-textures.js). Verifies the feathered weight vector, active-layer selection, and
// top-k slot normalization that replace the old per-triangle argmax + addGroup path. The TSL
// node material itself is browser/WebGPU-only and not exercised here (no GPU in Node).
//
//   node test-terrain-splat.mjs

import {
  layerWeightsAt, pickActiveLayers, weightsIntoSlots, MAX_ACTIVE_LAYERS, TERRAIN_TEXTURE_LAYERS,
  classifyLayerTriplanar, selectTopShaderLayers, DEFAULT_MAX_SHADER_LAYERS,
} from './terrain-textures.js';

const L = TERRAIN_TEXTURE_LAYERS;
const IDX = Object.fromEntries(L.map((n, i) => [n, i]));
let failures = 0;
function ok(cond, msg) { if (!cond) { console.error('FAIL:', msg); failures++; } else { console.log('ok  :', msg); } }
const approx = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

const res = 8;
function makeMap(masks) {
  return { materialMasks: masks, biomeIds: new Uint8Array(res * res) };
}
const meta = { resolution: res, worldX: 100, worldZ: 100, seaLevel: 0, biomeNames: ['plains'] };
const out = new Float64Array(L.length);

// 1. Flat, above-sea grass cell → grass dominates, no slope/shore layers.
const grassMap = makeMap({ grass: new Float32Array(res * res).fill(1) });
layerWeightsAt(grassMap, meta, 0, 10, 1.0, out);
ok(out[IDX.grass] > 0.9 && out[IDX.rock] === 0 && out[IDX.sand] === 0, 'flat grass: grass only, no rock/sand');

// 2. Feathering, not argmax: a mid-slope cell carries BOTH grass and a nonzero rock/dirt
//    weight simultaneously (the whole point of Phase 2 — continuous blend, no hard border).
layerWeightsAt(grassMap, meta, 0, 10, 0.45, out); // normalY 0.45 → slope 0.55, inside rock ramp
ok(out[IDX.grass] > 0 && out[IDX.rock] > 0, 'mid-slope cell blends grass AND rock (feathered, not argmax)');

// 3. Cliff cell → rock DOMINATES (override suppresses the biome base, not a 50/50 mush).
layerWeightsAt(grassMap, meta, 0, 10, 0.2, out); // slope 0.8 > 0.58 ramp top → full rock
ok(out[IDX.rock] > 0.9 && out[IDX.grass] < 0.05, 'cliff cell: rock dominates, grass suppressed');

// 4. Submerged cell → sand overrides the biome base.
layerWeightsAt(grassMap, meta, 0, -3, 1.0, out);
ok(out[IDX.sand] > 0.9 && out[IDX.grass] < 0.05, 'submerged cell: sand overrides, grass suppressed');

// 5. Empty masks + biome fallback → biome material spike.
const emptyMap = { materialMasks: null, biomeIds: new Uint8Array(res * res) };
const forestMeta = { ...meta, biomeNames: ['forest'] };
layerWeightsAt(emptyMap, forestMeta, 0, 10, 1.0, out);
ok(out[IDX.forest] > 0.9, 'no masks: falls back to biome layer (forest)');

// 6. pickActiveLayers is capped and always includes the ramp + grass layers.
const active = pickActiveLayers(grassMap, meta, [...Array(res * res).keys()]);
ok(active.length <= MAX_ACTIVE_LAYERS, `active layer count ${active.length} <= ${MAX_ACTIVE_LAYERS}`);
ok(active.includes(IDX.grass) && active.includes(IDX.rock) && active.includes(IDX.sand), 'active set seeds grass + ramp layers');
ok(active.every((v, i) => i === 0 || v > active[i - 1]), 'active set is sorted ascending (stable slot order)');

// 7. weightsIntoSlots: top-k, normalized to 1, scattered by active slot.
layerWeightsAt(grassMap, meta, 0, 10, 0.45, out);
const slotW = new Float64Array(MAX_ACTIVE_LAYERS);
weightsIntoSlots(out, active, slotW);
const slotSum = [...slotW].reduce((a, b) => a + b, 0);
ok(approx(slotSum, 1, 1e-6), `slot weights normalize to 1 (got ${slotSum.toFixed(6)})`);
ok([...slotW].filter((w) => w > 0).length <= 4, 'no more than top-4 slots are nonzero per vertex');

// 8. Degenerate (all-zero) weight vector → slot 0 gets full weight (never NaN/empty).
out.fill(0);
weightsIntoSlots(out, active, slotW);
ok(slotW[0] === 1 && approx([...slotW].reduce((a, b) => a + b, 0), 1), 'all-zero weights → slot 0 = 1 (safe default)');

// --- 3B: classifyLayerTriplanar — static per-layer triplanar-albedo classification ----------
// The current map's six active layers: grass, forest, dirt, sand, beach, rock. Per the design
// (3B), only rock (always) and dirt/gravel (steep-slope layers by construction — the RAMP
// scheme never puts dirt on flat ground) use triplanar albedo; grass/forest/meadow/sand/beach
// stay single-sample planar.
const currentMapLayers = ['grass', 'forest', 'dirt', 'sand', 'beach', 'rock'];
const triplanarClassified = currentMapLayers.filter((name) => classifyLayerTriplanar(name));
ok(
  triplanarClassified.length === 2 && triplanarClassified.includes('rock') && triplanarClassified.includes('dirt'),
  `exactly rock + dirt classify triplanar on the current map's layer set (got [${triplanarClassified.join(', ')}])`,
);
ok(!classifyLayerTriplanar('grass'), 'grass classifies planar');
ok(!classifyLayerTriplanar('forest'), 'forest classifies planar');
ok(!classifyLayerTriplanar('sand'), 'sand classifies planar');
ok(!classifyLayerTriplanar('beach'), 'beach classifies planar');
ok(classifyLayerTriplanar('rock'), 'rock classifies triplanar');
ok(classifyLayerTriplanar('dirt'), 'dirt classifies triplanar (steep-slope layer)');
ok(classifyLayerTriplanar('gravel'), 'gravel classifies triplanar (steep-slope layer, like dirt)');
ok(!classifyLayerTriplanar('meadow'), 'meadow classifies planar');

// --- 3C: selectTopShaderLayers — top-K runtime cap by baked weight, stable ascending order ---
// Six weighted layers in (matches the current map's active set), four dominant kept, order
// stays ascending/stable (same convention as pickActiveLayers' slot order).
const IDX2 = Object.fromEntries(TERRAIN_TEXTURE_LAYERS.map((n, i) => [n, i]));
const sixActive = [IDX2.grass, IDX2.forest, IDX2.dirt, IDX2.sand, IDX2.beach, IDX2.rock].sort((a, b) => a - b);
const weightByLayer = {
  [IDX2.grass]: 0.5,
  [IDX2.forest]: 0.05,
  [IDX2.dirt]: 0.2,
  [IDX2.sand]: 0.01,
  [IDX2.beach]: 0.04,
  [IDX2.rock]: 0.3,
};
const top4 = selectTopShaderLayers(sixActive, weightByLayer, 4);
ok(top4.length === 4, `top-4 selection returns 4 layers (got ${top4.length})`);
const expectedTop4 = [IDX2.grass, IDX2.dirt, IDX2.rock].sort((a, b) => a - b); // + one more (forest > beach)
ok(
  top4.includes(IDX2.grass) && top4.includes(IDX2.rock) && top4.includes(IDX2.dirt) && top4.includes(IDX2.forest),
  `top-4 keeps the four dominant-weight layers by total baked weight (got [${top4.map((i) => TERRAIN_TEXTURE_LAYERS[i]).join(', ')}])`,
);
ok(!top4.includes(IDX2.sand) && !top4.includes(IDX2.beach), 'top-4 drops the two lowest-weight layers (sand, beach)');
ok(top4.every((v, i) => i === 0 || v > top4[i - 1]), 'top-4 result is sorted ascending (stable slot order)');

// maxShaderLayers >= active layer count is a no-op (keeps everything, same order).
const keepAll = selectTopShaderLayers(sixActive, weightByLayer, 6);
ok(keepAll.length === 6 && keepAll.every((v, i) => v === sixActive[i]), 'maxShaderLayers >= active count keeps all layers, unchanged order');

// Default cap is 4.
ok(DEFAULT_MAX_SHADER_LAYERS === 4, `DEFAULT_MAX_SHADER_LAYERS is 4 (got ${DEFAULT_MAX_SHADER_LAYERS})`);

// Ties break toward the lower (ascending-first) global index, keeping selection deterministic.
const tiedWeights = { [IDX2.grass]: 0.25, [IDX2.forest]: 0.25, [IDX2.dirt]: 0.25, [IDX2.sand]: 0.25 };
const tiedActive = [IDX2.grass, IDX2.forest, IDX2.dirt, IDX2.sand].sort((a, b) => a - b);
const tiedTop2 = selectTopShaderLayers(tiedActive, tiedWeights, 2);
ok(tiedTop2.length === 2 && tiedTop2[0] === IDX2.grass && tiedTop2[1] === IDX2.forest, 'ties break toward lower global index (deterministic)');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll terrain-splat tests passed.');
process.exit(failures ? 1 : 0);
