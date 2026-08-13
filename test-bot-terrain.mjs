// node test-bot-terrain.mjs
import assert from 'node:assert';
import {
  BOT_TERRAIN_DEFAULTS, normalizeTerrainParams, createTerrainField,
  footprintRange, buildTerrainMeshArrays, LANDFORMS,
} from './bot-terrain.js';

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (err) { console.error(`FAIL  ${name}\n      ${err.message}`); process.exitCode = 1; }
}

const enabled = (over = {}) => createTerrainField({ ...BOT_TERRAIN_DEFAULTS, enabled: true, ...over });

test('disabled field is exactly flat', () => {
  const f = createTerrainField({ enabled: false, hillAmp: 5 });
  for (const [x, z] of [[0, 0], [13.5, -7.25], [-40, 40]]) assert.strictEqual(f.heightAt(x, z), 0);
  assert.strictEqual(f.slopeAt(3, 4), 0);
});

test('params are normalized and clamped', () => {
  const p = normalizeTerrainParams({ hillScale: 0, rippleScale: -3, hillOctaves: 99, meshCell: 0 });
  assert.ok(p.hillScale >= 0.5 && p.rippleScale >= 0.2);
  assert.strictEqual(p.hillOctaves, 6);
  assert.ok(p.meshCell > 0);
});

test('heightAt is deterministic and seed-dependent', () => {
  const a = enabled({ seed: 7 }), b = enabled({ seed: 7 }), c = enabled({ seed: 8 });
  let differs = 0;
  for (let i = 0; i < 200; i++) {
    const x = i * 0.61 - 60, z = i * -0.37 + 20;
    assert.strictEqual(a.heightAt(x, z), b.heightAt(x, z));
    if (Math.abs(a.heightAt(x, z) - c.heightAt(x, z)) > 1e-6) differs++;
  }
  assert.ok(differs > 150, `seed change should move most samples, moved ${differs}/200`);
});

test('field produces both hills and depressions within amplitude', () => {
  const f = enabled({ hillAmp: 1.2, rippleAmp: 0.15, noiseAmp: 0.06 });
  let min = Infinity, max = -Infinity;
  for (let x = -50; x <= 50; x += 0.7) for (let z = -50; z <= 50; z += 0.7) {
    const h = f.heightAt(x, z);
    if (h < min) min = h;
    if (h > max) max = h;
  }
  assert.ok(min < -0.2, `expected depressions, min=${min.toFixed(3)}`);
  assert.ok(max > 0.2, `expected hills, max=${max.toFixed(3)}`);
  const bound = 1.2 + 0.15 + 0.06 + 1e-6;
  assert.ok(min >= -bound && max <= bound, `height ${min}..${max} outside +-${bound}`);
});

test('each band contributes independently', () => {
  const hills = enabled({ rippleAmp: 0, noiseAmp: 0 });
  const ripples = enabled({ hillAmp: 0, noiseAmp: 0 });
  const grain = enabled({ hillAmp: 0, rippleAmp: 0 });
  const full = enabled();
  for (let i = 0; i < 50; i++) {
    const x = i * 1.3 - 30, z = i * -0.9 + 11;
    const sum = hills.heightAt(x, z) + ripples.heightAt(x, z) + grain.heightAt(x, z);
    assert.ok(Math.abs(sum - full.heightAt(x, z)) < 1e-9);
  }
  const flat = createTerrainField({ enabled: true, hillAmp: 0, rippleAmp: 0, noiseAmp: 0 });
  assert.strictEqual(flat.heightAt(4, 9), 0);
});

test('gradient matches finite differences of heightAt', () => {
  const f = enabled({ noiseAmp: 0 });
  for (const [x, z] of [[2, 3], [-11.5, 6.25], [30, -22]]) {
    const g = f.gradientAt(x, z, 0.01);
    const e = 0.01;
    const dx = (f.heightAt(x + e, z) - f.heightAt(x - e, z)) / (2 * e);
    assert.ok(Math.abs(g.dx - dx) < 1e-9);
    assert.ok(f.slopeAt(x, z, 0.01) >= 0);
  }
});

test('normalAt is unit length and points up', () => {
  const f = enabled({ hillAmp: 3 });
  for (let i = 0; i < 40; i++) {
    const n = f.normalAt(i * 1.7 - 20, i * -1.1 + 5);
    assert.ok(Math.abs(Math.hypot(n[0], n[1], n[2]) - 1) < 1e-9);
    assert.ok(n[1] > 0);
  }
});

test('gentler slopes come from wider hill scale', () => {
  const steep = enabled({ hillScale: 4, rippleAmp: 0, noiseAmp: 0 });
  const gentle = enabled({ hillScale: 40, rippleAmp: 0, noiseAmp: 0 });
  let s = 0, g = 0, n = 0;
  for (let x = -40; x <= 40; x += 1.3) for (let z = -40; z <= 40; z += 1.3) {
    s += steep.slopeAt(x, z); g += gentle.slopeAt(x, z); n++;
  }
  assert.ok(s / n > g / n * 3, `steep ${(s / n).toFixed(3)} vs gentle ${(g / n).toFixed(3)}`);
});

test('footprintRange brackets the ground under a box', () => {
  const f = enabled({ hillAmp: 2 });
  const { min, max } = footprintRange(f, 5, -3, 4, 4, 5);
  assert.ok(min <= max);
  assert.ok(min <= f.heightAt(5, -3) && f.heightAt(5, -3) <= max);
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
    const h = f.heightAt(3 + i * 0.5, -5 + j * 0.5);
    assert.ok(h >= min - 0.35 && h <= max + 0.35, 'sampled corner far outside bracket');
  }
  const flat = createTerrainField({ enabled: false });
  const r = footprintRange(flat, 0, 0, 3, 3);
  assert.strictEqual(r.min, 0); assert.strictEqual(r.max, 0);
});

test('mesh arrays are a well-formed indexed grid on the field', () => {
  const f = enabled({ hillAmp: 1.5 });
  const bounds = { minX: -10, maxX: 14, minZ: -6, maxZ: 6 };
  const m = buildTerrainMeshArrays(bounds, f, { meshCell: 0.5, maxSegments: 500 });
  assert.strictEqual(m.segX, 48);
  assert.strictEqual(m.segZ, 24);
  const verts = (m.segX + 1) * (m.segZ + 1);
  assert.strictEqual(m.positions.length, verts * 3);
  assert.strictEqual(m.normals.length, verts * 3);
  assert.strictEqual(m.indices.length, m.segX * m.segZ * 6);
  assert.strictEqual(m.triangleCount, m.segX * m.segZ * 2);
  for (const idx of m.indices) assert.ok(idx >= 0 && idx < verts);
  // corners land exactly on the bounds, y on the field
  assert.ok(Math.abs(m.positions[0] - bounds.minX) < 1e-6);
  assert.ok(Math.abs(m.positions[2] - bounds.minZ) < 1e-6);
  const last = (verts - 1) * 3;
  assert.ok(Math.abs(m.positions[last] - bounds.maxX) < 1e-5);
  assert.ok(Math.abs(m.positions[last + 2] - bounds.maxZ) < 1e-5);
  for (let v = 0; v < verts; v++) {
    const k = v * 3;
    assert.ok(Math.abs(m.positions[k + 1] - f.heightAt(m.positions[k], m.positions[k + 2])) < 1e-6);
  }
});

test('vertex shading reads slope, altitude and channels', () => {
  const bounds = { minX: -40, maxX: 40, minZ: -40, maxZ: 40 };
  const f = createTerrainField({
    ...BOT_TERRAIN_DEFAULTS, enabled: true, hillAmp: 3.5, hillScale: 14, erosionAmp: 1.2,
  }, [], { bounds });
  const m = buildTerrainMeshArrays(bounds, f, { meshCell: 0.5, maxSegments: 400 });
  const verts = (m.segX + 1) * (m.segZ + 1);
  assert.strictEqual(m.colors.length, verts * 3);

  // A multiplier on the material colour: it must stay positive and near unity, or the theme's
  // palette gets crushed rather than modulated.
  let min = Infinity, max = -Infinity;
  for (const c of m.colors) { if (c < min) min = c; if (c > max) max = c; }
  assert.ok(min >= 0 && max < 2, `shading multiplier out of range: ${min.toFixed(2)}..${max.toFixed(2)}`);
  assert.ok(max - min > 0.1, 'shading should actually vary across the terrain');

  // Steep ground reads brighter than flat ground, and channels read darker than their surroundings.
  let steepSum = 0, steepN = 0, flatSum = 0, flatN = 0, wetSum = 0, wetN = 0, drySum = 0, dryN = 0;
  const grid = f.grid;
  for (let v = 0; v < verts; v++) {
    const k = v * 3;
    const lum = (m.colors[k] + m.colors[k + 1] + m.colors[k + 2]) / 3;
    const slope = Math.hypot(m.normals[k], m.normals[k + 2]) / m.normals[k + 1];
    if (slope > 0.8) { steepSum += lum; steepN++; } else if (slope < 0.15) { flatSum += lum; flatN++; }
    const c = Math.round((m.positions[k] - grid.minX) * grid.inv);
    const r = Math.round((m.positions[k + 2] - grid.minZ) * grid.inv);
    if (c >= 0 && r >= 0 && c < grid.cols && r < grid.rows) {
      const ch = grid.channel[r * grid.cols + c];
      if (ch > 0.6) { wetSum += lum; wetN++; } else if (ch === 0) { drySum += lum; dryN++; }
    }
  }
  assert.ok(steepN > 10 && flatN > 10 && wetN > 10 && dryN > 10, 'not enough samples of each kind');
  assert.ok(steepSum / steepN > flatSum / flatN, 'steep faces should read as exposed rock');
  assert.ok(wetSum / wetN < drySum / dryN, 'channel floors should read darker than the ridges');

  // Turning it off returns flat white, i.e. the material colour untouched.
  const plain = buildTerrainMeshArrays(bounds,
    createTerrainField({ ...BOT_TERRAIN_DEFAULTS, enabled: true, hillAmp: 3.5, shadeRock: 0, shadeChannel: 0, shadeAltitude: 0 }, [], { bounds }),
    { meshCell: 0.5, maxSegments: 400 });
  for (let i = 0; i < plain.colors.length; i += 331) assert.ok(Math.abs(plain.colors[i] - 1) < 1e-6);
});

test('mesh winding gives upward-facing triangles', () => {
  const f = enabled({ hillAmp: 0.8 });
  const m = buildTerrainMeshArrays({ minX: -4, maxX: 4, minZ: -4, maxZ: 4 }, f, { meshCell: 0.5 });
  for (let t = 0; t < m.indices.length; t += 3) {
    const a = m.indices[t] * 3, b = m.indices[t + 1] * 3, c = m.indices[t + 2] * 3;
    const e1 = [m.positions[b] - m.positions[a], m.positions[b + 1] - m.positions[a + 1], m.positions[b + 2] - m.positions[a + 2]];
    const e2 = [m.positions[c] - m.positions[a], m.positions[c + 1] - m.positions[a + 1], m.positions[c + 2] - m.positions[a + 2]];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    assert.ok(ny > 0, `triangle ${t / 3} faces down`);
  }
});

test('segment cap bounds the collider triangle budget', () => {
  const f = enabled();
  const m = buildTerrainMeshArrays({ minX: -500, maxX: 500, minZ: -500, maxZ: 500 }, f, { meshCell: 0.1, maxSegments: 64 });
  assert.strictEqual(m.segX, 64);
  assert.strictEqual(m.segZ, 64);
  assert.strictEqual(m.triangleCount, 64 * 64 * 2);
});

test('index buffer widens past the 16-bit vertex limit', () => {
  const f = enabled();
  const small = buildTerrainMeshArrays({ minX: 0, maxX: 10, minZ: 0, maxZ: 10 }, f, { meshCell: 1 });
  assert.ok(small.indices instanceof Uint16Array);
  const big = buildTerrainMeshArrays({ minX: 0, maxX: 300, minZ: 0, maxZ: 300 }, f, { meshCell: 1, maxSegments: 300 });
  assert.ok(big.indices instanceof Uint32Array);
  assert.ok(big.indices.every((i) => i < (big.segX + 1) * (big.segZ + 1)));
});

test('flatten pads level the ground and rejoin the terrain smoothly', () => {
  const params = { ...BOT_TERRAIN_DEFAULTS, enabled: true, hillAmp: 3, hillScale: 12, flattenFalloff: 2 };
  const raw = createTerrainField(params);
  const padded = createTerrainField(params, [{ x: 6, z: -4, radius: 3 }]);
  const level = raw.heightAt(6, -4);

  assert.strictEqual(padded.pads.length, 1);
  assert.ok(Math.abs(padded.pads[0].y - level) < 1e-9, 'pad level samples the raw field at its center');
  for (const [x, z] of [[6, -4], [8, -4], [6, -2], [7.5, -5.5]]) {
    assert.ok(Math.abs(padded.heightAt(x, z) - level) < 1e-9, `inside the pad is level at ${x},${z}`);
  }
  assert.ok(padded.slopeAt(6, -4, 0.25) < 1e-6, 'the pad interior is flat under the slope gate');
  // Outside radius + falloff the field is untouched.
  assert.strictEqual(padded.heightAt(6 + 3 + 2 + 0.01, -4), raw.heightAt(6 + 3 + 2 + 0.01, -4));
  assert.strictEqual(padded.heightAt(-20, 20), raw.heightAt(-20, 20));
  // The blend band sits between the two, never outside them.
  const mid = padded.heightAt(6 + 4, -4), rawMid = raw.heightAt(6 + 4, -4);
  assert.ok(mid >= Math.min(level, rawMid) - 1e-6 && mid <= Math.max(level, rawMid) + 1e-6, 'blend stays between pad and terrain');
});

test('overlapping pads keep each footprint flat and join without a step', () => {
  const params = { ...BOT_TERRAIN_DEFAULTS, enabled: true, hillAmp: 3, hillScale: 9 };
  const f = createTerrainField(params, [{ x: 0, z: 0, radius: 2 }, { x: 3, z: 0, radius: 2 }]);
  const [a, b] = f.pads;
  assert.ok(Math.abs(a.y - b.y) > 1e-6, 'the two pads really do sit at different levels');
  // A pad with no close rival still levels its own footprint exactly -- that is the whole point.
  assert.ok(Math.abs(f.heightAt(0, 0) - a.y) < 1e-9, 'inside pad A the ground is pad A level');
  assert.ok(Math.abs(f.heightAt(3, 0) - b.y) < 1e-9, 'inside pad B the ground is pad B level');
  // The crossover is a ramp between the two levels, never a cliff: an argmax over pad weights
  // used to jump the ground the instant the winner changed.
  const h = f.heightAt(1.5, 0);
  assert.ok(h >= Math.min(a.y, b.y) - 1e-6 && h <= Math.max(a.y, b.y) + 1e-6, 'overlap sits between the levels');
  // Continuity, measured rather than eyeballed: for a continuous surface the largest jump between
  // adjacent samples shrinks with the sample spacing. A step would not shrink at all.
  const jump = (dx) => {
    let m = 0;
    for (let x = -6; x <= 9; x += dx) m = Math.max(m, Math.abs(f.heightAt(x + dx, 0) - f.heightAt(x, 0)));
    return m;
  };
  const ratio = jump(0.0125) / jump(0.05);
  assert.ok(ratio < 0.45, `4x finer sampling should shrink the worst jump ~4x, got ${ratio.toFixed(2)} (1.0 = a cliff)`);
});

// Spread of gradient directions over the band, as max-bin / mean-bin. Corduroy stamped along
// fixed axes piles every sample into a couple of bins; isotropic ground spreads evenly.
function directionSpread(field, half = 40, bins = 12) {
  const hist = new Array(bins).fill(0);
  let n = 0;
  for (let z = -half; z <= half; z += 0.3) {
    for (let x = -half; x <= half; x += 0.3) {
      const g = field.gradientAt(x, z, 0.1);
      if (Math.hypot(g.dx, g.dz) < 1e-6) continue;
      let a = Math.atan2(g.dz, g.dx);
      if (a < 0) a += Math.PI;   // fold: a corrugation and its mirror are the same direction
      hist[Math.min(bins - 1, Math.floor(a / Math.PI * bins))]++;
      n++;
    }
  }
  return Math.max(...hist) / (n / bins);
}

test('the ripple band is no longer stamped along fixed axes', () => {
  const band = (over) => createTerrainField({
    ...BOT_TERRAIN_DEFAULTS, enabled: true, hillAmp: 0, noiseAmp: 0, rippleAmp: 0.4, rippleScale: 4, ...over,
  });
  const iso = directionSpread(band({ rippleMode: 'isotropic' }));
  assert.ok(iso < 1.6, `isotropic ripples should have no preferred direction, got ${iso.toFixed(2)}x`);

  // Dunes keep a direction on purpose -- but it now comes from the seed, so two maps differ.
  const dunes = directionSpread(band({ rippleMode: 'dunes' }));
  assert.ok(dunes > iso, `dunes should be directional, got ${dunes.toFixed(2)}x vs iso ${iso.toFixed(2)}x`);
  const a = band({ rippleMode: 'dunes', seed: 3 }), b = band({ rippleMode: 'dunes', seed: 4 });
  let differs = 0;
  for (let i = 0; i < 100; i++) {
    const x = i * 0.83 - 40, z = i * -0.51 + 12;
    if (Math.abs(a.heightAt(x, z) - b.heightAt(x, z)) > 1e-6) differs++;
  }
  assert.ok(differs > 80, `dune direction must follow the seed, only ${differs}/100 samples moved`);
});

test('every landform keeps the amplitude contract and has both hills and hollows', () => {
  for (const name of Object.keys(LANDFORMS)) {
    const f = createTerrainField({
      ...BOT_TERRAIN_DEFAULTS, enabled: true, landform: name, hillAmp: 2, rippleAmp: 0, noiseAmp: 0,
    });
    let min = Infinity, max = -Infinity;
    for (let z = -60; z <= 60; z += 0.9) for (let x = -60; x <= 60; x += 0.9) {
      const h = f.heightAt(x, z);
      if (h < min) min = h;
      if (h > max) max = h;
    }
    assert.ok(min >= -2 - 1e-6 && max <= 2 + 1e-6, `${name} broke the amplitude bound: ${min}..${max}`);
    assert.ok(min < -0.3, `${name} produced no depressions (min ${min.toFixed(2)})`);
    assert.ok(max > 0.3, `${name} produced no hills (max ${max.toFixed(2)})`);
  }
  // An unknown landform falls back rather than throwing on a stale saved slot.
  assert.strictEqual(normalizeTerrainParams({ landform: 'himalayas' }).landform, 'rolling');
  assert.strictEqual(normalizeTerrainParams({ rippleMode: 'zigzag' }).rippleMode, 'isotropic');
});

test('ridged and billowy are creased mirrors of each other', () => {
  const base = { ...BOT_TERRAIN_DEFAULTS, enabled: true, hillAmp: 2, rippleAmp: 0, noiseAmp: 0, hillScale: 20 };
  const rolling = createTerrainField({ ...base, landform: 'rolling' });
  const ridged = createTerrainField({ ...base, landform: 'ridged' });
  const billowy = createTerrainField({ ...base, landform: 'billowy' });

  // Both fold the band about zero, in opposite directions -- an exact identity, so a future edit
  // to one shaper that forgets the other gets caught here.
  for (let i = 0; i < 200; i++) {
    const x = i * 0.77 - 60, z = i * -0.43 + 15;
    assert.ok(Math.abs(ridged.heightAt(x, z) + billowy.heightAt(x, z)) < 1e-9, 'ridged and billowy must mirror');
  }

  // The point of folding is the crease along the zero-crossings: sharper ground than the parent.
  const medianSlope = (f) => {
    const s = [];
    for (let z = -60; z <= 60; z += 0.9) for (let x = -60; x <= 60; x += 0.9) s.push(f.slopeAt(x, z, 0.3));
    s.sort((a, b) => a - b);
    return s[s.length >> 1];
  };
  const flat = medianSlope(rolling);
  assert.ok(medianSlope(ridged) > flat * 1.5, 'ridged should carry sharper slopes than its rolling parent');
  assert.ok(medianSlope(billowy) > flat * 1.5, 'billowy should carry sharper slopes than its rolling parent');
});

test('terracing carves flat benches without inverting the hill', () => {
  const base = {
    ...BOT_TERRAIN_DEFAULTS, enabled: true, hillAmp: 3, hillScale: 20, rippleAmp: 0, noiseAmp: 0,
  };
  const plain = createTerrainField(base);
  const stepped = createTerrainField({ ...base, terraceSteps: 6, terraceSharpness: 1 });

  let flatPlain = 0, flatStepped = 0, n = 0, maxDrift = 0;
  for (let z = -50; z <= 50; z += 0.5) {
    for (let x = -50; x <= 50; x += 0.5) {
      if (plain.slopeAt(x, z, 0.25) < 0.02) flatPlain++;
      if (stepped.slopeAt(x, z, 0.25) < 0.02) flatStepped++;
      maxDrift = Math.max(maxDrift, Math.abs(stepped.heightAt(x, z) - plain.heightAt(x, z)));
      n++;
    }
  }
  assert.ok(flatStepped > flatPlain * 3, `terracing should add flat ground: ${flatStepped} vs ${flatPlain} of ${n}`);
  // Benches redistribute height, they do not relocate the hill.
  assert.ok(maxDrift < base.hillAmp * 0.5, `terraced ground drifted ${maxDrift.toFixed(2)} m from its parent`);
  assert.strictEqual(createTerrainField({ ...base, terraceSteps: 0 }).heightAt(7, -3), plain.heightAt(7, -3));
});

test('domain warp reshapes the hills without changing their amplitude', () => {
  const base = { ...BOT_TERRAIN_DEFAULTS, enabled: true, hillAmp: 2, hillScale: 20, rippleAmp: 0, noiseAmp: 0 };
  const straight = createTerrainField(base);
  const warped = createTerrainField({ ...base, warpAmp: 8, warpScale: 30 });
  let differs = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < 400; i++) {
    const x = (i % 20) * 3 - 30, z = Math.floor(i / 20) * 3 - 30;
    if (Math.abs(straight.heightAt(x, z) - warped.heightAt(x, z)) > 0.05) differs++;
    const h = warped.heightAt(x, z);
    if (h < min) min = h;
    if (h > max) max = h;
  }
  assert.ok(differs > 300, `warp should move most of the map, moved ${differs}/400`);
  assert.ok(min >= -2 - 1e-6 && max <= 2 + 1e-6, `warp broke the amplitude bound: ${min}..${max}`);
  assert.strictEqual(createTerrainField({ ...base, warpAmp: 0 }).heightAt(4, 4), straight.heightAt(4, 4));
});

const EROSION_BOUNDS = { minX: -60, maxX: 60, minZ: -60, maxZ: 60 };
const erodedBase = {
  ...BOT_TERRAIN_DEFAULTS, enabled: true, hillAmp: 3.5, hillScale: 18, hillOctaves: 3, rippleAmp: 0.1,
};

test('erosion is off by default and exactly inert at zero', () => {
  const plain = createTerrainField(erodedBase, [], { bounds: EROSION_BOUNDS });
  assert.strictEqual(BOT_TERRAIN_DEFAULTS.erosionAmp, 0);
  assert.strictEqual(plain.grid.flow, undefined, 'no flow pass should run when erosion is off');
  const zero = createTerrainField({ ...erodedBase, erosionAmp: 0 }, [], { bounds: EROSION_BOUNDS });
  for (let i = 0; i < plain.grid.heights.length; i += 97) {
    assert.strictEqual(zero.grid.heights[i], plain.grid.heights[i]);
  }
});

test('erosion carves a connected downhill drainage network', () => {
  const f = createTerrainField({ ...erodedBase, erosionAmp: 1.2 }, [], { bounds: EROSION_BOUNDS });
  const { channel, flow, heights: H, cols, rows } = f.grid;
  assert.ok(channel && flow, 'erosion should expose its flow and channel fields');

  // Accumulation really accumulates: some cell drains far more than the area a full channel needs.
  // (No pit filling, so drainage is basin-local -- gully networks rather than one trunk river.)
  let maxFlow = 0;
  for (let i = 0; i < flow.length; i++) if (flow[i] > maxFlow) maxFlow = flow[i];
  assert.ok(maxFlow > erodedBase.erosionArea * 2, `largest basin only drains ${maxFlow} cells`);

  // Dendritic, not speckled: a strong channel cell should almost always touch another one. Noise
  // with dents in it would fail this; a branching network passes it.
  let strong = 0, isolated = 0;
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const i = r * cols + c;
      if (channel[i] < 0.5) continue;
      strong++;
      let touching = 0;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        if (channel[(r + dr) * cols + (c + dc)] >= 0.5) touching++;
      }
      if (touching === 0) isolated++;
    }
  }
  assert.ok(strong > 200, `expected a real network, found ${strong} strong channel cells`);
  assert.ok(isolated / strong < 0.05, `${(isolated / strong * 100).toFixed(1)}% of channel cells are isolated specks`);

  // The payoff is reach: one channel system should run right across the map, because a sunken
  // route is only useful if you can actually travel it. Without depression filling the same
  // terrain fragments into ~200 stubby gullies, the largest spanning a quarter of the map.
  const largest = largestChannelRun(f.grid, 0.3);
  const mapCells = (EROSION_BOUNDS.maxX - EROSION_BOUNDS.minX) / f.grid.step;
  assert.ok(largest.size > 500, `channel network is fragmented: largest run only ${largest.size} cells`);
  assert.ok(largest.span > mapCells * 0.4,
    `longest route spans ${(largest.span * f.grid.step).toFixed(0)} m of a ${EROSION_BOUNDS.maxX - EROSION_BOUNDS.minX} m map`);
});

// Largest 8-connected group of channel cells, with the diagonal of its bounding box in cells.
function largestChannelRun(grid, threshold) {
  const { channel, cols, rows } = grid;
  const seen = new Uint8Array(cols * rows);
  const stack = [];
  let best = { size: 0, span: 0 };
  for (let s = 0; s < channel.length; s++) {
    if (seen[s] || channel[s] < threshold) continue;
    let size = 0, minC = Infinity, maxC = -Infinity, minR = Infinity, maxR = -Infinity;
    stack.push(s); seen[s] = 1;
    while (stack.length) {
      const i = stack.pop();
      size++;
      const r = (i / cols) | 0, c = i - r * cols;
      if (c < minC) minC = c;
      if (c > maxC) maxC = c;
      if (r < minR) minR = r;
      if (r > maxR) maxR = r;
      for (let k = -1; k <= 1; k++) {
        for (let m = -1; m <= 1; m++) {
          const nc = c + k, nr = r + m;
          if ((k === 0 && m === 0) || nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
          const j = nr * cols + nc;
          if (seen[j] || channel[j] < threshold) continue;
          seen[j] = 1; stack.push(j);
        }
      }
    }
    const span = Math.hypot(maxC - minC, maxR - minR);
    if (size > best.size) best = { size, span };
  }
  return best;
}

test('depression filling is what makes channels connect into routes', () => {
  const mk = (fill) => createTerrainField({ ...erodedBase, erosionAmp: 1.2, erosionFillPits: fill }, [], { bounds: EROSION_BOUNDS });
  const fragmented = largestChannelRun(mk(false).grid, 0.3);
  const connected = largestChannelRun(mk(true).grid, 0.3);
  assert.ok(connected.size > fragmented.size * 3,
    `filling should join gullies into a network: ${connected.size} vs ${fragmented.size} cells`);
  assert.ok(connected.span > fragmented.span * 2,
    `filling should extend reach: ${connected.span.toFixed(0)} vs ${fragmented.span.toFixed(0)} cells`);
});

test('erosion deepens channels without flattening the landscape', () => {
  const shallow = createTerrainField({ ...erodedBase, erosionAmp: 0 }, [], { bounds: EROSION_BOUNDS });
  const deep = createTerrainField({ ...erodedBase, erosionAmp: 1.5 }, [], { bounds: EROSION_BOUNDS });
  const relief = (f) => {
    let min = Infinity, max = -Infinity;
    for (const h of f.grid.heights) { if (h < min) min = h; if (h > max) max = h; }
    return max - min;
  };
  assert.ok(relief(deep) > relief(shallow), 'incision should add relief, not remove it');
  // Ridges are left alone: a cell that drains only itself is cut by exactly nothing, so the high
  // ground keeps the shape the landform gave it.
  let untouched = 0, total = 0;
  for (let i = 0; i < deep.grid.heights.length; i++) {
    if (deep.grid.channel[i] > 0) continue;
    total++;
    if (Math.abs(deep.grid.heights[i] - shallow.grid.heights[i]) < 0.05) untouched++;
  }
  assert.ok(total > deep.grid.heights.length * 0.05, `expected real ridge ground, got ${total} cells`);
  assert.ok(untouched / total > 0.9, `high ground should survive erosion, only ${(untouched / total * 100).toFixed(0)}% did`);
});

test('erosion is deterministic for a seed', () => {
  const mk = () => createTerrainField({ ...erodedBase, erosionAmp: 1.2, seed: 42 }, [], { bounds: EROSION_BOUNDS });
  const a = mk().grid.heights, b = mk().grid.heights;
  for (let i = 0; i < a.length; i += 41) assert.strictEqual(a[i], b[i]);
});

test('a channel cannot cut through a spawn pad', () => {
  // Pads resolve after erosion precisely so this holds: level build sites outrank drainage.
  const pad = { x: 4, z: -7, radius: 3 };
  const f = createTerrainField({ ...erodedBase, erosionAmp: 2.5 }, [pad], { bounds: EROSION_BOUNDS });
  const level = f.heightAt(pad.x, pad.z);
  for (let a = 0; a < 8; a++) {
    const x = pad.x + Math.cos(a) * 2.4, z = pad.z + Math.sin(a) * 2.4;
    assert.ok(Math.abs(f.heightAt(x, z) - level) < 0.06, `pad interior dipped ${(f.heightAt(x, z) - level).toFixed(3)} m`);
  }
  assert.ok(f.slopeAt(pad.x, pad.z, 0.25) < 0.08, 'the pad should still be flat enough to build on');
});

const FEATURE_BOUNDS = { minX: -60, maxX: 60, minZ: -60, maxZ: 60 };
const featureBase = { ...BOT_TERRAIN_DEFAULTS, enabled: true, hillAmp: 2, hillScale: 18, rippleAmp: 0.1 };
const withFeatures = (over) => createTerrainField({ ...featureBase, ...over }, [], { bounds: FEATURE_BOUNDS });

test('placed features are off by default and deterministic when on', () => {
  assert.strictEqual(BOT_TERRAIN_DEFAULTS.featureCount, 0);
  assert.deepStrictEqual(withFeatures({}).features, []);
  const a = withFeatures({ featureCount: 6, seed: 11 });
  const b = withFeatures({ featureCount: 6, seed: 11 });
  assert.deepStrictEqual(a.features, b.features);
  for (let i = 0; i < a.grid.heights.length; i += 53) assert.strictEqual(a.grid.heights[i], b.grid.heights[i]);
  const other = withFeatures({ featureCount: 6, seed: 12 });
  assert.notDeepStrictEqual(a.features, other.features);
});

test('each feature kind leaves its own signature on the ground', () => {
  const plain = withFeatures({});
  const delta = (f, x, z) => f.heightAt(x, z) - plain.heightAt(x, z);

  const mesa = withFeatures({ featureCount: 4, featureMix: 'plateau', featureHeight: 3 });
  assert.ok(mesa.features.every((f) => f.kind === 'plateau'), 'mix filter should hold');
  const top = mesa.features[0];
  assert.ok(delta(mesa, top.x, top.z) > 1, 'a plateau should stand above the ground it replaced');
  // Its top is level: that is what makes it ground worth holding rather than a bump.
  assert.ok(mesa.slopeAt(top.x, top.z, 0.5) < 0.12, 'plateau tops should be flat');
  // and it has a rim -- the edge is markedly steeper than the top.
  assert.ok(mesa.slopeAt(top.x + top.radius, top.z, 0.5) > mesa.slopeAt(top.x, top.z, 0.5) * 3, 'plateau needs a rim');

  const cut = withFeatures({ featureCount: 4, featureMix: 'ravine', featureHeight: 3 });
  const rav = cut.features[0];
  assert.ok(delta(cut, rav.x, rav.z) < -1, 'a ravine should cut below the ground it replaced');
  // The floor runs along the line, not just at the midpoint.
  const mid = { x: (rav.x + rav.bx) / 2, z: (rav.z + rav.bz) / 2 };
  assert.ok(delta(cut, mid.x, mid.z) < -0.5, 'the ravine should run the length of its line');

  const wall = withFeatures({ featureCount: 4, featureMix: 'escarpment', featureHeight: 3 });
  const esc = wall.features[0];
  const vx = esc.bx - esc.ax, vz = esc.bz - esc.az;
  const inv = 1 / Math.hypot(vx, vz);
  const nx = -vz * inv, nz = vx * inv;
  const high = wall.heightAt(esc.x + nx * esc.run * 2, esc.z + nz * esc.run * 2);
  const low = wall.heightAt(esc.x - nx * esc.run * 2, esc.z - nz * esc.run * 2);
  assert.ok(Math.abs(high - low) > 1, `escarpment should step across its line, got ${(high - low).toFixed(2)} m`);
});

test('overlapping features cannot compound past their height setting', () => {
  const plain = withFeatures({});
  const many = withFeatures({ featureCount: 14, featureHeight: 2.5 });
  let worst = 0;
  for (let i = 0; i < many.grid.heights.length; i++) {
    worst = Math.max(worst, Math.abs(many.grid.heights[i] - plain.grid.heights[i]));
  }
  assert.ok(worst <= 2.5 * 1.5 + 1e-4, `features compounded to ${worst.toFixed(2)} m from a 2.5 m setting`);
});

test('features are separated and stay inside the map', () => {
  const f = withFeatures({ featureCount: 8, featureHeight: 2.5 });
  assert.ok(f.features.length > 1, 'expected several features');
  const span = FEATURE_BOUNDS.maxX - FEATURE_BOUNDS.minX;
  for (let i = 0; i < f.features.length; i++) {
    const a = f.features[i];
    assert.ok(a.x >= FEATURE_BOUNDS.minX && a.x <= FEATURE_BOUNDS.maxX, 'feature centre inside bounds');
    assert.ok(a.z >= FEATURE_BOUNDS.minZ && a.z <= FEATURE_BOUNDS.maxZ, 'feature centre inside bounds');
    for (let j = i + 1; j < f.features.length; j++) {
      const b = f.features[j];
      assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= span * 0.13 - 1e-6, 'features must not pile up');
    }
  }
});

test('erosion runs after features, so drainage answers to them', () => {
  // A plateau must gather its own drainage: channels should appear around a rim that did not
  // exist before it was stamped. If features were applied after erosion they could not.
  const f = withFeatures({ featureCount: 5, featureMix: 'plateau', featureHeight: 3, erosionAmp: 1.2 });
  const flat = withFeatures({ featureCount: 0, erosionAmp: 1.2 });
  const near = (field, cx, cz, radius) => {
    const g = field.grid;
    let sum = 0, n = 0;
    for (let a = 0; a < 32; a++) {
      const x = cx + Math.cos(a / 32 * Math.PI * 2) * radius, z = cz + Math.sin(a / 32 * Math.PI * 2) * radius;
      const c = Math.round((x - g.minX) * g.inv), r = Math.round((z - g.minZ) * g.inv);
      if (c >= 0 && r >= 0 && c < g.cols && r < g.rows) { sum += g.channel[r * g.cols + c]; n++; }
    }
    return n ? sum / n : 0;
  };
  const top = f.features[0];
  assert.ok(near(f, top.x, top.z, top.radius + 2) > near(flat, top.x, top.z, top.radius + 2),
    'a plateau rim should shed water the bare hillside did not');
});

test('a baked field matches the analytic one and is bounded by it', () => {
  const params = { ...BOT_TERRAIN_DEFAULTS, enabled: true, hillAmp: 3.5, hillScale: 18, rippleAmp: 0.15 };
  const bounds = { minX: -40, maxX: 40, minZ: -40, maxZ: 40 };
  const pads = [{ x: 5, z: -5, radius: 2 }, { x: -12, z: 8, radius: 3 }];
  const analytic = createTerrainField(params, pads);
  const baked = createTerrainField(params, pads, { bounds });

  assert.strictEqual(analytic.baked, false);
  assert.strictEqual(baked.baked, true);
  assert.ok(baked.grid.cols > 2 && baked.grid.rows > 2);

  let maxDiff = 0;
  for (let z = -40; z <= 40; z += 0.37) {
    for (let x = -40; x <= 40; x += 0.37) {
      maxDiff = Math.max(maxDiff, Math.abs(baked.heightAt(x, z) - analytic.heightAt(x, z)));
    }
  }
  // Bilinear over a 0.5 m grid resolves everything but the finest grain band.
  assert.ok(maxDiff < params.noiseAmp * 2 + 0.02, `baked field drifted ${maxDiff.toFixed(3)} m from analytic`);

  // Outside the baked window queries fall back to the analytic field rather than clamping.
  const far = 400;
  assert.strictEqual(baked.heightAt(far, far), analytic.heightAt(far, far));
  assert.ok(Number.isNaN(baked.heightAt(NaN, 0)) || baked.heightAt(NaN, 0) === analytic.heightAt(NaN, 0));
});

test('baking is opt-in and inert when disabled or unbounded', () => {
  const params = { ...BOT_TERRAIN_DEFAULTS, enabled: false };
  assert.strictEqual(createTerrainField(params, [], { bounds: { minX: -5, maxX: 5, minZ: -5, maxZ: 5 } }).grid, null);
  assert.strictEqual(createTerrainField({ ...params, enabled: true }).grid, null);
  // A degenerate window must not produce a zero-area grid.
  assert.strictEqual(createTerrainField({ ...params, enabled: true }, [], { bounds: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 }, margin: 0 }).grid, null);
});

test('the baked grid respects its segment cap', () => {
  const f = createTerrainField({ ...BOT_TERRAIN_DEFAULTS, enabled: true, fieldCell: 0.1, maxFieldSegments: 64 },
    [], { bounds: { minX: -200, maxX: 200, minZ: -200, maxZ: 200 } });
  assert.ok(f.grid.cols <= 66 && f.grid.rows <= 66, `grid ${f.grid.cols}x${f.grid.rows} blew the cap`);
  assert.ok(f.grid.step > 0.1, 'cell pitch widened to honour the cap');
});

test('pads are inert while terrain is disabled', () => {
  const f = createTerrainField({ ...BOT_TERRAIN_DEFAULTS, enabled: false }, [{ x: 0, z: 0, radius: 5 }]);
  assert.strictEqual(f.pads.length, 0);
  assert.strictEqual(f.heightAt(0, 0), 0);
});

test('an explicit pad level overrides the sampled one', () => {
  const f = createTerrainField({ ...BOT_TERRAIN_DEFAULTS, enabled: true, hillAmp: 2 }, [{ x: 0, z: 0, radius: 2, y: 1.25 }]);
  assert.strictEqual(f.heightAt(0, 0), 1.25);
});

// ── connectivity: carved passes ────────────────────────────────────────────
// The bug these exist for: a bot standing in a valley doing nothing, because the ground it was on
// passed the slope gate but was fenced off from every goal it could pick.
const CONNECT_BOUNDS = { minX: -86, maxX: 86, minZ: -86, maxZ: 86 };
const HIGHLANDS = {
  enabled: true, hillAmp: 3.5, hillScale: 20, hillOctaves: 3, landform: 'ridged',
  warpAmp: 6, warpScale: 35, terraceSteps: 4, terraceSharpness: 0.45,
  rippleAmp: 0.12, meshCell: 0.5,
  erosionAmp: 1.1, erosionArea: 300, erosionSmooth: 0.55,
  featureCount: 6, featureMix: 'mixed', featureHeight: 2.5,
};

// Independent re-implementation of the walkable test the viewer's nav gate applies, deliberately
// sampling where nav samples (cell centres, via the field's own slopeAt) rather than where the
// carve writes (grid nodes). A pass that only works at the nodes is not a pass.
function walkableComponents(field, bounds, cell = 0.5) {
  const p = field.params;
  const cols = Math.ceil((bounds.maxX - bounds.minX) / cell);
  const rows = Math.ceil((bounds.maxZ - bounds.minZ) / cell);
  const ok = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = bounds.minX + (c + 0.5) * cell, z = bounds.minZ + (r + 0.5) * cell;
      ok[r * cols + c] = field.slopeAt(x, z, cell * 0.5) > p.maxSlope ? 0 : 1;
    }
  }
  const label = new Int32Array(cols * rows).fill(-1);
  const sizes = [];
  const stack = [];
  const D = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let s = 0; s < ok.length; s++) {
    if (!ok[s] || label[s] >= 0) continue;
    const id = sizes.length;
    let n = 0;
    label[s] = id; stack.push(s);
    while (stack.length) {
      const k = stack.pop(); n++;
      const r = (k / cols) | 0, c = k - r * cols;
      for (const [dc, dr] of D) {
        const nc = c + dc, nr = r + dr;
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const nk = nr * cols + nc;
        if (!ok[nk] || label[nk] >= 0) continue;
        if (dc !== 0 && dr !== 0 && (!ok[r * cols + nc] || !ok[nr * cols + c])) continue;
        label[nk] = id; stack.push(nk);
      }
    }
    sizes.push(n);
  }
  let walkable = 0; for (const v of ok) walkable += v;
  const main = sizes.length ? Math.max(...sizes) : 0;
  const strandedBig = sizes.filter((n) => n !== main && n >= 12);
  return { walkable, total: ok.length, components: sizes.length, main, strandedBig };
}

test('landform-heavy terrain strands walkable ground when passes are off', () => {
  // Guards the premise: if this ever stops stranding, the carve below is testing nothing.
  let seedsWithStrandings = 0;
  for (const seed of [7, 21, 99]) {
    const f = createTerrainField({ ...BOT_TERRAIN_DEFAULTS, ...HIGHLANDS, seed, connectPasses: false },
      [], { bounds: CONNECT_BOUNDS });
    if (walkableComponents(f, CONNECT_BOUNDS).strandedBig.length > 0) seedsWithStrandings++;
  }
  assert.strictEqual(seedsWithStrandings, 3, 'expected every highlands seed to fence off ground');
});

test('carved passes leave the walkable ground in one piece', () => {
  for (const seed of [7, 21, 99, 3, 42]) {
    const f = createTerrainField({ ...BOT_TERRAIN_DEFAULTS, ...HIGHLANDS, seed },
      [], { bounds: CONNECT_BOUNDS });
    const m = walkableComponents(f, CONNECT_BOUNDS);
    assert.strictEqual(m.strandedBig.length, 0,
      `seed ${seed} still strands ${m.strandedBig.length} area(s): ${m.strandedBig.join(',')} cells`);
    assert.strictEqual(f.connectivity.stranded, 0, `seed ${seed} reported ${f.connectivity.stranded} stranded`);
    assert.ok(f.connectivity.carved > 0, `seed ${seed} reported no passes carved`);
  }
});

test('carving a pass does not flatten the map it is cutting through', () => {
  const base = { ...BOT_TERRAIN_DEFAULTS, ...HIGHLANDS, seed: 7 };
  const off = createTerrainField({ ...base, connectPasses: false }, [], { bounds: CONNECT_BOUNDS });
  const on = createTerrainField(base, [], { bounds: CONNECT_BOUNDS });
  const relief = (f) => {
    let min = Infinity, max = -Infinity;
    for (const h of f.grid.heights) { if (h < min) min = h; if (h > max) max = h; }
    return max - min;
  };
  const a = walkableComponents(off, CONNECT_BOUNDS), b = walkableComponents(on, CONNECT_BOUNDS);
  assert.ok(Math.abs(relief(on) - relief(off)) < 0.05, 'passes changed the map relief');
  // Walkable share may only go up: a pass adds walkable ground, it never removes any.
  assert.ok(b.walkable >= a.walkable, `walkable cells fell ${a.walkable} -> ${b.walkable}`);
  assert.ok((b.walkable - a.walkable) / a.walkable < 0.02, 'passes widened the walkable share too far to be a pass');
});

test('a pass fills a gully but never builds a causeway', () => {
  // Passes cut *and* fill: the strandings that survived every carve turned out to be ringed by a
  // one-cell erosion gully rather than a ridge, and lowering a hole achieves nothing. Filling is
  // what has to stay bounded -- enough to bridge a gully, not enough to pave over a ravine.
  const base = { ...BOT_TERRAIN_DEFAULTS, ...HIGHLANDS, seed: 21 };
  const off = createTerrainField({ ...base, connectPasses: false }, [], { bounds: CONNECT_BOUNDS });
  const on = createTerrainField(base, [], { bounds: CONNECT_BOUNDS });
  let raised = 0, lowered = 0, maxRaise = 0, fill = 0, cut = 0;
  for (let i = 0; i < on.grid.heights.length; i++) {
    const d = on.grid.heights[i] - off.grid.heights[i];
    if (d > 1e-4) { raised++; maxRaise = Math.max(maxRaise, d); fill += d; }
    else if (d < -1e-4) { lowered++; cut -= d; }
  }
  assert.ok(lowered > 0 && raised > 0, 'a pass should both cut and fill');
  assert.ok(maxRaise <= 1.6, `fill reached ${maxRaise.toFixed(2)} m, past the gully-bridge cap`);
  // By volume, not by depth: one gully bridge can be deeper than the deepest cut on a map whose
  // passes are mostly shallow, and that is fine. Excavation dominating overall is the claim.
  assert.ok(cut > fill * 1.5, `passes moved ${fill.toFixed(0)} m of fill against ${cut.toFixed(0)} m of cut`);
  // Confined to the passes themselves: this is surgery on a map, not a resurfacing of it.
  const moved = (raised + lowered) / on.grid.heights.length;
  assert.ok(moved < 0.05, `${(moved * 100).toFixed(1)}% of the map was moved by pass carving`);
});

test('connectivity work is skipped entirely on ground that was never fragmented', () => {
  // The shipped open-field preset is fully walkable, so the check must cost one mask pass and stop
  // before labelling -- this is the perf contract, asserted rather than assumed.
  const f = createTerrainField({
    ...BOT_TERRAIN_DEFAULTS, enabled: true, hillAmp: 3.5, hillScale: 18, hillOctaves: 3,
    rippleAmp: 0.15, meshCell: 0.5, seed: 7,
  }, [], { bounds: CONNECT_BOUNDS });
  assert.strictEqual(f.connectivity.carved, 0);
  assert.strictEqual(f.connectivity.rounds, 0, 'a fully walkable map must bail out of round zero');
});

test('pass carving is deterministic and opt-out', () => {
  const params = { ...BOT_TERRAIN_DEFAULTS, ...HIGHLANDS, seed: 42 };
  const a = createTerrainField(params, [], { bounds: CONNECT_BOUNDS });
  const b = createTerrainField(params, [], { bounds: CONNECT_BOUNDS });
  for (let i = 0; i < a.grid.heights.length; i += 97) assert.strictEqual(a.grid.heights[i], b.grid.heights[i]);
  assert.strictEqual(createTerrainField({ ...params, connectPasses: false }, [], { bounds: CONNECT_BOUNDS }).connectivity, null);
  assert.strictEqual(createTerrainField({ ...params, connectPasses: true }).connectivity, null, 'analytic mode has no grid to connect');
});

test('a carved pass cannot cut through a spawn pad', () => {
  const pad = { x: 0, z: 0, radius: 3 };
  const f = createTerrainField({ ...BOT_TERRAIN_DEFAULTS, ...HIGHLANDS, seed: 7 }, [pad], { bounds: CONNECT_BOUNDS });
  const level = f.heightAt(pad.x, pad.z);
  for (let a = 0; a < 6; a++) {
    const t = (a / 6) * Math.PI * 2;
    const h = f.heightAt(pad.x + Math.cos(t) * 2.5, pad.z + Math.sin(t) * 2.5);
    assert.ok(Math.abs(h - level) < 1e-3, `pad is not level ${Math.abs(h - level).toFixed(4)} m from centre`);
  }
});

console.log(`\n${passed} passed`);
