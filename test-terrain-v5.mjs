// Node tests for terrain-generator-v5's pure modules: noise primitives, layer stack, paint
// layers, history, heightmap io, and the split pipeline. Run: node test-terrain-v5.mjs

import {
  hash12, vnoise2, vnoised2, fbm2, ridged2, billow2, voronoi2, terrace, domainWarp2,
  seedDomainOffset, applyBlend, BLEND_MODES,
} from './terrain-noise.js';
import {
  LAYER_TYPES, makeLayer, defaultStack, normalizeStack, structuralSignature, evaluateStackGrid,
  STACK_PRESETS, MAX_LAYERS,
} from './terrain-stack.js';
import { PaintLayers, PAINT_TOOLS, NO_OVERRIDE, DEFAULT_BRUSH, bytesToBase64, base64ToBytes } from './terrain-paint.js';
import { History } from './terrain-history.js';
import {
  decodeGrayscalePixels, resampleToSquare, quantizeHeights, packRaw16, terrariumToMetres,
  lonToTileX, latToTileY, bboxAround, pickZoom,
} from './terrain-heightmap-io.js';
import {
  DEFAULT_CONFIG, generateFullGrid, generateFullGridV5, generateNoiseFields, composeClassicHeight, finishGrid, BIOMES,
} from './terrain-generator-js.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---- noise primitives ----
{
  for (let i = 0; i < 200; i++) {
    const h = hash12(i * 1.7, i * -3.3);
    ok(h >= 0 && h < 1, 'hash12 in [0,1)');
  }
  ok(hash12(3, 4) === hash12(3, 4), 'hash12 deterministic');
  ok(hash12(3, 4) !== hash12(4, 3), 'hash12 not symmetric');
  let lo = 1, hi = 0;
  for (let i = 0; i < 2000; i++) {
    const v = vnoise2(i * 0.173, i * 0.311);
    lo = Math.min(lo, v); hi = Math.max(hi, v);
  }
  ok(lo >= 0 && hi <= 1 && hi - lo > 0.5, `vnoise2 spans [0,1] (saw ${lo.toFixed(2)}..${hi.toFixed(2)})`);
  ok(near(vnoise2(5, 7), hash12(5, 7)), 'vnoise2 hits lattice value at integer coords');
  // analytic derivative matches finite difference
  const d = vnoised2(2.37, 5.11);
  const e = 1e-4;
  const fdx = (vnoise2(2.37 + e, 5.11) - vnoise2(2.37 - e, 5.11)) / (2 * e);
  const fdy = (vnoise2(2.37, 5.11 + e) - vnoise2(2.37, 5.11 - e)) / (2 * e);
  ok(near(d[0], vnoise2(2.37, 5.11), 1e-9), 'vnoised2 value matches vnoise2');
  ok(near(d[1], fdx, 1e-3) && near(d[2], fdy, 1e-3), `vnoised2 derivative matches finite difference (${d[1].toFixed(4)} vs ${fdx.toFixed(4)})`);
  for (const fn of [fbm2, ridged2, billow2]) {
    let mn = 1, mx = 0;
    for (let i = 0; i < 500; i++) { const v = fn(i * 0.37, i * 0.19, { octaves: 5 }); mn = Math.min(mn, v); mx = Math.max(mx, v); }
    ok(mn >= 0 && mx <= 1, `${fn.name} stays in [0,1]`);
  }
  ok(fbm2(1.5, 2.5, { octaves: 1 }) === vnoise2(1.5, 2.5), 'fbm2 with one octave is vnoise2');
  ok(fbm2(1.5, 2.5, { octaves: 5, erosion: 0.5 }) !== fbm2(1.5, 2.5, { octaves: 5 }), 'erosion feedback changes fbm');
  ok(fbm2(1.5, 2.5, { octaves: 5, warp: 0.5 }) !== fbm2(1.5, 2.5, { octaves: 5 }), 'self warp changes fbm');
  ok(ridged2(3.2, 1.1, { sharpness: 4 }) <= ridged2(3.2, 1.1, { sharpness: 1 }) + 1e-9, 'sharper ridges are never taller');
  for (const outputMode of [0, 1, 2, 3]) {
    let mn = 9, mx = -9;
    for (let i = 0; i < 400; i++) { const v = voronoi2(i * 0.41, i * 0.23, { outputMode }); mn = Math.min(mn, v); mx = Math.max(mx, v); }
    ok(mn >= 0 && mx <= 1, `voronoi outputMode ${outputMode} in [0,1]`);
  }
  ok(voronoi2(3, 4, { jitter: 0, outputMode: 1 }) < 0.01, 'voronoi jitter 0 puts a cell centre on the lattice');
  ok(terrace(37, { stepHeight: 10, smoothness: 0, strength: 1 }) === 40 && terrace(33, { stepHeight: 10, smoothness: 0, strength: 1 }) === 30, 'terrace with no smoothness is a hard step at the mid riser');
  ok(near(terrace(37, { stepHeight: 10, strength: 0 }), 37), 'terrace strength 0 is identity');
  ok(near(terrace(35, { stepHeight: 10, smoothness: 1, strength: 1 }), 35, 1e-6), 'terrace mid-riser at full smoothness passes through');
  const w = domainWarp2(100, 200, { scale: 400, amount: 50 });
  ok(Math.abs(w[0]) <= 50 && Math.abs(w[1]) <= 50, 'domain warp bounded by amount');
  ok(seedDomainOffset(1) !== seedDomainOffset(2) && Math.abs(seedDomainOffset(12345)) <= 1024, 'seedDomainOffset distinct and bounded');
  ok(seedDomainOffset(7) === seedDomainOffset(7), 'seedDomainOffset deterministic');
  ok(applyBlend('add', 10, 5) === 15 && applyBlend('subtract', 10, 5) === 5 && applyBlend('max', 10, 5) === 10 && applyBlend('min', 10, 5) === 5, 'basic blends');
  ok(applyBlend('replace', 10, 5) === 5 && applyBlend('carve', 10, 5) === 5 && applyBlend('carve', 10, -5) === 5, 'replace/carve blends');
  ok(applyBlend('add', 10, 5, 0.5) === 12.5 && applyBlend('add', 10, 5, 0) === 10, 'opacity mixes toward the blend');
  ok(applyBlend('overlay', -10, 5) === -15 && applyBlend('overlay', 10, 5) === 15, 'overlay pushes away from zero');
  ok(BLEND_MODES.length === 9, '9 blend modes');
}

// ---- layer stack ----
{
  const s = defaultStack();
  ok(s.layers.length === 1 && s.layers[0].type === 'classic', 'default stack is classic only');
  for (const [type, def] of Object.entries(LAYER_TYPES)) {
    ok(typeof def.desc === 'string' && def.desc.length > 10, `${type} has a description`);
    for (const [k, p] of Object.entries(def.params)) {
      ok(typeof p.desc === 'string' && p.desc.length > 8, `${type}.${k} has a description`);
      ok(p.default >= p.min && p.default <= p.max, `${type}.${k} default within range`);
    }
  }
  const ctx = { resolution: 16, worldX: 400, worldZ: 400, seed: 3 };
  const classic = new Float32Array(256).fill(20);
  const h0 = evaluateStackGrid(s, { ...ctx, classicHeight: classic });
  ok(h0.every((v) => v === 20), 'classic-only stack reproduces the classic height');
  const s2 = { version: 1, layers: [makeLayer('classic'), makeLayer('constant', { params: { amplitude: 5 } })] };
  const h1 = evaluateStackGrid(s2, { ...ctx, classicHeight: classic });
  ok(h1.every((v) => near(v, 25)), 'constant layer adds its amplitude');
  s2.layers[1].blendMode = 'max'; s2.layers[1].params.amplitude = 30;
  ok(evaluateStackGrid(s2, { ...ctx, classicHeight: classic }).every((v) => v === 30), 'max blend replaces lower ground');
  s2.layers[1].enabled = false;
  ok(evaluateStackGrid(s2, { ...ctx, classicHeight: classic }).every((v) => v === 20), 'disabled layer is skipped');
  // mask: constant only where classic is inside the band
  const ramp = new Float32Array(256); for (let i = 0; i < 256; i++) ramp[i] = (i % 16) * 10;
  const s3 = { version: 1, layers: [makeLayer('classic'), makeLayer('constant', { params: { amplitude: 100 }, mask: { enabled: true, lo: 50, hi: 100, feather: 0.001 } })] };
  const h3 = evaluateStackGrid(s3, { ...ctx, classicHeight: ramp });
  ok(near(h3[0], 0) && near(h3[8], 180) && near(h3[15], 150), `height mask gates the layer (${h3[0]}, ${h3[8]}, ${h3[15]})`);
  // fbm layer is deterministic and non-flat, and seed changes it
  const s4 = { version: 1, layers: [makeLayer('fbm', { params: { amplitude: 50, scale: 100 } })] };
  const a = evaluateStackGrid(s4, ctx), b = evaluateStackGrid(s4, ctx), c = evaluateStackGrid(s4, { ...ctx, seed: 4 });
  ok(a.every((v, i) => v === b[i]), 'stack evaluation deterministic');
  ok(a.some((v, i) => v !== c[i]), 'seed changes the stack');
  let mn = Infinity, mx = -Infinity; for (const v of a) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
  ok(mx - mn > 5 && mn >= -25 && mx <= 25, `fbm layer within +/- amplitude/2 (${mn.toFixed(1)}..${mx.toFixed(1)})`);
  // domain warp changes downstream sampling
  const s5 = { version: 1, layers: [makeLayer('domainWarp', { params: { amount: 80 } }), makeLayer('fbm', { params: { amplitude: 50, scale: 100 } })] };
  ok(evaluateStackGrid(s5, ctx).some((v, i) => Math.abs(v - a[i]) > 1e-6), 'domain warp changes later layers');
  // terrace quantizes
  const s6 = { version: 1, layers: [makeLayer('classic'), makeLayer('terrace', { params: { stepHeight: 10, smoothness: 0 } })] };
  ok(evaluateStackGrid(s6, { ...ctx, classicHeight: ramp }).every((v) => near(v % 10, 0) || near(v % 10, 10)), 'terrace snaps to steps');
  // import layer
  const s7 = { version: 1, layers: [makeLayer('import', { id: 'imp', params: { amplitude: 100, offset: 0 } })] };
  const imp = { imp: { data: new Float32Array(4).fill(0.5), resolution: 2 } };
  ok(evaluateStackGrid(s7, { ...ctx, imports: imp }).every((v) => near(v, 50)), 'import layer samples the grid');
  ok(evaluateStackGrid(s7, ctx).every((v) => v === 0), 'import layer without a grid contributes 0');
  // signature
  const sigA = structuralSignature(s4);
  s4.layers[0].params.amplitude = 10;
  ok(structuralSignature(s4) === sigA, 'continuous param does not change signature');
  s4.layers[0].params.octaves = 3;
  ok(structuralSignature(s4) !== sigA, 'structural param changes signature');
  // normalize
  const norm = normalizeStack({ layers: [{ type: 'fbm', params: { amplitude: 9999, octaves: 'x' }, blendMode: 'bogus' }, { type: 'nope' }] });
  ok(norm.layers.length === 1 && norm.layers[0].params.amplitude === 300 && norm.layers[0].params.octaves === 5 && norm.layers[0].blendMode === 'add', 'normalizeStack clamps, defaults and drops unknown types');
  ok(normalizeStack(null).layers[0].type === 'classic', 'normalizeStack(null) is the default stack');
  const many = normalizeStack({ layers: Array.from({ length: 20 }, () => ({ type: 'constant', params: {} })) });
  ok(many.layers.length === MAX_LAYERS, 'normalizeStack caps at MAX_LAYERS');
  for (const [name, mk] of Object.entries(STACK_PRESETS)) {
    const st = normalizeStack(mk());
    const h = evaluateStackGrid(st, { ...ctx, classicHeight: ramp });
    ok(h.every(Number.isFinite), `preset ${name} evaluates to finite heights`);
  }
}

// ---- pipeline split ----
{
  const cfg = { ...DEFAULT_CONFIG };
  const res = 24;
  const g4 = generateFullGrid(cfg, res);
  const g5 = generateFullGridV5(cfg, res, null);
  ok(g4.height.every((v, i) => v === g5.height[i]), 'V5 without a stack equals V4');
  ok(g5.classicHeight && g5.classicHeight.length === res * res, 'V5 exposes classicHeight');
  const fields = generateNoiseFields(cfg, res);
  const classic = composeClassicHeight(fields, cfg);
  ok(classic.every((v, i) => v === g4.targetHeight[i]), 'composeClassicHeight matches targetHeight');
  const paint = new Float32Array(res * res).fill(7);
  const gp = finishGrid(classic, fields, cfg, res, { paintHeight: paint });
  ok(gp.height.every((v, i) => near(v, g4.height[i] + 7, 1e-4)), 'paintHeight is added after erosion');
  const override = new Uint8Array(res * res).fill(255); override[5] = 3;
  const go = finishGrid(classic, fields, cfg, res, { biomeOverride: override });
  ok(go.biomeId[5] === 3 && go.ruleIndex[5] === -2 && go.biomeId[6] === g4.biomeId[6], 'biomeOverride replaces the classifier per cell');
  const stackEval = (classicHeight) => evaluateStackGrid({ version: 1, layers: [makeLayer('classic'), makeLayer('constant', { params: { amplitude: 30 } })] }, { resolution: res, worldX: cfg.world_x, worldZ: cfg.world_z, seed: cfg.seed, classicHeight });
  const gs = generateFullGridV5(cfg, res, stackEval);
  ok(gs.targetHeight.every((v, i) => near(v, g4.targetHeight[i] + 30, 1e-4)), 'stack output feeds erosion as targetHeight');
}

// ---- paint layers ----
{
  const p = new PaintLayers(32, 320, 320);
  ok(p.isEmpty(), 'fresh paint is empty');
  const brush = { ...DEFAULT_BRUSH, radius: 40, strength: 1, falloff: 0 };
  const n = p.stamp('raise', 0, 0, brush);
  ok(n > 0 && !p.isEmpty(), 'raise touches cells');
  const centre = p.heightDelta[16 * 32 + 16];
  ok(centre > 0 && p.heightDelta[0] === 0, 'raise lifts the centre, leaves corners');
  p.stamp('lower', 0, 0, brush);
  ok(near(p.heightDelta[16 * 32 + 16], 0, 1e-5), 'lower undoes raise');
  p.clear();
  p.stamp('raise', 0, 0, { ...brush, falloff: 1 });
  const c2 = p.heightDelta[16 * 32 + 16], edge = p.heightDelta[16 * 32 + 19];
  ok(c2 > edge && edge > 0, 'falloff feathers toward the edge');
  const base = new Float32Array(32 * 32); for (let i = 0; i < base.length; i++) base[i] = (i % 32) * 2;
  p.clear();
  for (let i = 0; i < 20; i++) p.stamp('flatten', 0, 0, { ...brush, radius: 60 }, { baseHeight: base });
  const tgt = base[16 * 32 + 16];
  ok(near(base[16 * 32 + 12] + p.heightDelta[16 * 32 + 12], tgt, 0.5), 'flatten pulls the neighbourhood toward the centre height');
  p.clear();
  p.stamp('biome', 0, 0, brush, { biomeId: 4 });
  ok(p.biomeOverride[16 * 32 + 16] === 4 && p.biomeOverride[0] === NO_OVERRIDE, 'biome paint sets the override');
  p.stamp('erase', 0, 0, brush);
  ok(p.biomeOverride[16 * 32 + 16] === NO_OVERRIDE, 'erase clears the override');
  p.clear(); p.stamp('raise', 0, 0, brush);
  const snap = p.snapshot(); p.stamp('raise', 0, 0, brush);
  ok(p.heightDelta[16 * 32 + 16] > snap.heightDelta[16 * 32 + 16], 'second stamp stacks');
  ok(p.restore(snap) && p.heightDelta[16 * 32 + 16] === snap.heightDelta[16 * 32 + 16], 'restore returns to the snapshot');
  const ser = p.serialize();
  const back = PaintLayers.deserialize(ser, 320, 320);
  ok(back.heightDelta.every((v, i) => v === p.heightDelta[i]) && back.biomeOverride.every((v, i) => v === p.biomeOverride[i]), 'serialize round-trips');
  ok(new PaintLayers(8, 1, 1).serialize() === null, 'empty paint serializes to null');
  p.resize(64, 320, 320);
  ok(p.resolution === 64 && p.heightDelta[32 * 64 + 32] > 0, 'resize resamples the paint');
  for (const shape of ['round', 'ellipse', 'ribbon', 'organic', 'scatter']) {
    const q = new PaintLayers(32, 320, 320);
    q.stamp('raise', 0, 0, { ...brush, shape });
    ok(!q.isEmpty(), `${shape} brush paints something`);
  }
  ok(PAINT_TOOLS.length === 6, '6 paint tools');
  const bytes = new Uint8Array([0, 1, 2, 250, 255]);
  ok(base64ToBytes(bytesToBase64(bytes)).join() === bytes.join(), 'base64 round-trip');
}

// ---- history ----
{
  let state = { a: 1 };
  const h = new History({ getState: () => state, restoreState: (s) => { state = s; }, limit: 3 });
  h.record('init');
  ok(!h.canUndo() && !h.canRedo(), 'single entry cannot undo');
  state = { a: 2 }; h.record('two');
  state = { a: 3 }; h.record('three');
  ok(h.canUndo() && h.undo() && state.a === 2, 'undo restores previous state');
  ok(h.redo() && state.a === 3, 'redo reapplies');
  h.undo(); state = { a: 9 }; h.record('nine');
  ok(!h.canRedo() && h.entries.length === 3, 'new record after undo cuts the redo tail');
  state = { a: 10 }; h.record('ten');
  ok(h.entries.length === 3 && h.entries[0].label === 'two', 'limit drops the oldest');
  const before = h.entries.length; h.record('dup');
  ok(h.entries.length === before, 'identical state is not recorded twice');
  let calls = 0; h.onChange(() => calls++); h.undo();
  ok(calls === 1, 'listeners fire on undo');
}

// ---- heightmap io ----
{
  const px = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255, 128, 128, 128, 255, 64, 64, 64, 255]);
  const dec = decodeGrayscalePixels(px, 2, 2);
  ok(dec.data[0] === 0 && dec.data[1] === 1 && dec.data[2] > 0.49 && dec.data[2] < 0.51, 'grayscale decode normalizes 0..1');
  const rs = resampleToSquare(new Float32Array([0, 1, 0, 1]), 2, 2, 3);
  ok(near(rs[1], 0.5) && rs[0] === 0 && rs[2] === 1, 'resample bilinear midpoint');
  const q = quantizeHeights(new Float32Array([-10, 0, 10]));
  ok(q.u8[0] === 0 && q.u8[1] === 128 && q.u8[2] === 255 && q.u16[2] === 65535 && q.min === -10, 'quantize spans the range');
  const raw = new DataView(packRaw16(new Uint16Array([1, 65535])));
  ok(raw.getUint16(0, true) === 1 && raw.getUint16(2, true) === 65535 && raw.byteLength === 4, 'raw16 little-endian');
  ok(terrariumToMetres(128, 0, 0) === 0 && terrariumToMetres(128, 100, 0) === 100, 'terrarium decode');
  ok(near(lonToTileX(0, 1), 1) && near(latToTileY(0, 1), 1), 'tile maths centre');
  const bb = bboxAround(45, 7, 20);
  ok(bb.north > 45 && bb.south < 45 && bb.east > 7 && bb.west < 7, 'bbox around');
  const z = pickZoom(bb, 6);
  ok(z >= 8 && z <= 14, `pickZoom reasonable (${z})`);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
