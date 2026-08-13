// Round-trips the height grid the way the two pages actually do it: quantize + chunked base64 in
// bot-viewer-v2.html's botWorldHeights, atob + Uint8Array in bot-trace-viewer.html's elevationCanvas.
// The chunking exists because String.fromCharCode(...bytes) blows the argument limit on a full grid,
// so the large case below is the point of this test, not padding.
import assert from 'node:assert';

const b64encode = bin => Buffer.from(bin, 'binary').toString('base64');   // stands in for btoa
const b64decode = s => Buffer.from(s, 'base64').toString('binary');       // stands in for atob

function encodeHeights(sample, bounds, maxSamples = 192) {
  const spanX = bounds.maxX - bounds.minX, spanZ = bounds.maxZ - bounds.minZ;
  const long = Math.max(spanX, spanZ);
  const cols = Math.max(2, Math.round(maxSamples * (spanX / long)));
  const rows = Math.max(2, Math.round(maxSamples * (spanZ / long)));
  const raw = new Float32Array(cols * rows);
  let minY = Infinity, maxY = -Infinity;
  for (let r = 0; r < rows; r++) {
    const z = bounds.minZ + (spanZ * r) / (rows - 1);
    for (let c = 0; c < cols; c++) {
      const y = sample(bounds.minX + (spanX * c) / (cols - 1), z);
      raw[r * cols + c] = y;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const range = maxY - minY;
  const bytes = new Uint8Array(raw.length);
  if (range > 1e-6) for (let i = 0; i < raw.length; i++) bytes[i] = Math.round(((raw[i] - minY) / range) * 255);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { cols, rows, minY: +minY.toFixed(3), maxY: +maxY.toFixed(3), flat: range <= 1e-6, b64: b64encode(bin), raw };
}

function decodeHeights(hm) {
  const bin = b64decode(hm.b64);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
  return data;
}

const bounds = { minX: -30, maxX: 30, minZ: -20, maxZ: 20 };

// 1. A real hilly field: decoded bytes must reconstruct the original within one quantization step.
const hill = (x, z) => 3.5 * Math.sin(x / 9) * Math.cos(z / 7) + 0.4 * Math.sin(x / 2.5);
const enc = encodeHeights(hill, bounds);
const dec = decodeHeights(enc);
assert.strictEqual(dec.length, enc.cols * enc.rows, 'decoded length must match the grid');
assert.ok(!enc.flat, 'a hilly field must not be reported flat');
const range = enc.maxY - enc.minY;
let worst = 0;
for (let i = 0; i < dec.length; i++) {
  worst = Math.max(worst, Math.abs((enc.minY + (dec[i] / 255) * range) - enc.raw[i]));
}
const step = range / 255;
assert.ok(worst <= step, `reconstruction error ${worst.toFixed(4)} must be within one step ${step.toFixed(4)}`);
console.log(`ok  hilly ${enc.cols}x${enc.rows}, range ${range.toFixed(2)}m, max error ${worst.toFixed(4)}m (<= ${step.toFixed(4)})`);

// 2. Terrain off (the game's default) -> flat, and no divide-by-zero producing NaN bytes.
const flat = encodeHeights(() => 0, bounds);
assert.ok(flat.flat, 'a constant field must be reported flat');
assert.ok(decodeHeights(flat).every(v => v === 0), 'flat field must decode to all zeros, not NaN');
console.log('ok  flat field flagged, decodes to zeros');

// 3. Endpoints land exactly on 0 and 255 so the ramp uses its whole span.
assert.strictEqual(Math.min(...dec.subarray(0, 4096)), 0, 'min sample should quantize to 0');
assert.strictEqual(Math.max(...dec.subarray(0, 4096)), 255, 'max sample should quantize to 255');
console.log('ok  quantization spans the full 0..255 range');

// 4. The chunked encoder must survive a grid far past the spread-argument limit.
const big = encodeHeights(hill, { minX: -200, maxX: 200, minZ: -200, maxZ: 200 }, 400);
assert.strictEqual(big.cols * big.rows, 160000, 'expected a 400x400 grid');
assert.strictEqual(decodeHeights(big).length, 160000, 'chunked base64 must round-trip a large grid');
console.log(`ok  ${big.cols}x${big.rows} (${(big.b64.length / 1024).toFixed(0)} KB base64) round-trips`);

// 5. Aspect ratio is preserved, so the relief cannot come out stretched against the bounds box.
const aspectGrid = enc.cols / enc.rows, aspectWorld = (bounds.maxX - bounds.minX) / (bounds.maxZ - bounds.minZ);
assert.ok(Math.abs(aspectGrid - aspectWorld) < 0.05, `grid aspect ${aspectGrid} should track world ${aspectWorld}`);
console.log(`ok  aspect preserved (grid ${aspectGrid.toFixed(2)} vs world ${aspectWorld.toFixed(2)})`);

console.log('\nall height-map tests passed');
