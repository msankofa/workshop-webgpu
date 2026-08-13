// The nav-region byte protocol, end to end: botWorldRegions (extracted from bot-viewer-v2.html)
// encodes a real navGrid, and the viewer's decode side reads it back. Both halves are pulled from
// source, so a change to either that breaks the agreement fails here rather than drawing a wrong map.
//
// The encoding is one byte per cell: 0 = blocked, 1 = main region, 2..253 = other regions ranked
// biggest-first, 254 = a carved cell, 255 = rank overflow. Carved must stay distinguishable from
// everything else -- it is the visible evidence that the map needed repairing.
import assert from 'node:assert';
import fs from 'node:fs';
import { buildNavGrid } from './nav-grid.js';

const base = 'G:/My Drive/Scripts/procedural-creature/workshop-webgpu/';
const gameSrc = fs.readFileSync(base + 'bot-viewer-v3.html', 'utf8');
const viewSrc = fs.readFileSync(base + 'bot-trace-viewer.html', 'utf8');

function grab(src, startsWith, label) {
  const i = src.indexOf(startsWith);
  if (i < 0) throw new Error('not found: ' + (label || startsWith));
  let d = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (!d) return src.slice(i, k + 1); }
  }
  throw new Error('unbalanced: ' + (label || startsWith));
}

// Node has no btoa/atob on older majors; provide them via Buffer so the extracted code runs as-is.
const btoa = s => Buffer.from(s, 'binary').toString('base64');
const atob = s => Buffer.from(s, 'base64').toString('binary');

const CAP = Number(/const WORLD_REGION_MAX_CELLS = (\d+)/.exec(gameSrc)[1]);
assert.ok(CAP > 0, 'the cell cap must come from the game source');

// The encoder closes over `navGrid`, so hand it in as a shimmed global.
function encode(grid) {
  const fn = new Function('navGrid', 'btoa', 'WORLD_REGION_MAX_CELLS', `
    ${grab(gameSrc, 'function botWorldRegions()')}
    return botWorldRegions();
  `);
  return fn(grid, btoa, CAP);
}

// The viewer's own tint functions, so "carved is distinct" is asserted against the real palette.
const tints = new Function(`
  ${/const REGION_TINTS = \[[^\]]*\];/.exec(viewSrc)[0]}
  ${/const regionTint = [^\n]*/.exec(viewSrc)[0]}
  ${/const CARVED_TINT = '[^']*';/.exec(viewSrc)[0]}
  ${/const OVERFLOW_TINT = '[^']*';/.exec(viewSrc)[0]}
  return { regionTint, CARVED_TINT, OVERFLOW_TINT, REGION_TINTS };
`)();

const CELL = 1;
const BOUNDS = { minX: 0, maxX: 20, minZ: 0, maxZ: 9 };
const decodeBytes = rg => {
  const bin = atob(rg.b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

// 1. A one-region map: every walkable cell is byte 1, every wall is byte 0, nothing else appears.
{
  const g = buildNavGrid(() => true, BOUNDS, CELL, {});
  const rg = encode(g);
  assert.strictEqual(rg.cols, g.cols);
  assert.strictEqual(rg.rows, g.rows);
  assert.strictEqual(rg.cellSize, g.cellSize);
  assert.strictEqual(rg.minX, g.minX);
  assert.strictEqual(rg.minZ, g.minZ);
  const bytes = decodeBytes(rg);
  assert.strictEqual(bytes.length, g.cols * g.rows, 'one byte per cell');
  assert.ok(bytes.every(b => b === 1), 'a fully open map is all main region');
  assert.deepStrictEqual(rg.sizes, [g.cols * g.rows]);
  assert.strictEqual(rg.carved, 0);
  console.log(`ok  open map encodes as ${bytes.length} main-region cells, no carve`);
}

// 2. A walled split: two regions, and the byte value tracks region RANK (biggest first), so the
//    bigger half is 1 and the smaller is 2 regardless of which id the labeller happened to assign.
{
  // Divider at x=10; the right side is deliberately wider so main/stray is unambiguous.
  const g = buildNavGrid((x) => Math.floor(x) !== 10, { minX: 0, maxX: 30, minZ: 0, maxZ: 9 }, CELL, {});
  const rg = encode(g);
  assert.strictEqual(rg.sizes.length, 2, 'two regions expected');
  assert.ok(rg.sizes[0] > rg.sizes[1], 'sizes must be sorted biggest-first');
  const bytes = decodeBytes(rg);
  const seen = new Set(bytes);
  assert.deepStrictEqual([...seen].sort((a, b) => a - b), [0, 1, 2],
    `expected only blocked/main/stray bytes, saw ${[...seen]}`);
  // Cross-check the counts against the sizes the encoder reported.
  const n1 = bytes.filter(b => b === 1).length, n2 = bytes.filter(b => b === 2).length;
  assert.strictEqual(n1, rg.sizes[0], 'byte-1 count must equal the main region size');
  assert.strictEqual(n2, rg.sizes[1], 'byte-2 count must equal the stray region size');
  assert.strictEqual(rg.sealed.length, 0, 'connectRegions is inert without softBlockedTest, so nothing is sealed');
  console.log(`ok  walled split encodes rank-ordered (main ${n1} cells = byte 1, stray ${n2} = byte 2)`);
}

// 3. A slope-split map that the repair reconnects: the carved cells must come back as byte 254, be
//    counted, and be a DIFFERENT colour from both main and any stray region.
{
  const solid = (x) => Math.floor(x) === 10;
  const g = buildNavGrid((x) => !solid(x), BOUNDS, CELL,
    { heightAt: () => 0, softBlockedTest: (x) => solid(x) });
  assert.ok(g.carved.length > 0, 'fixture must actually carve, else this asserts nothing');
  const rg = encode(g);
  const bytes = decodeBytes(rg);
  const carvedCount = bytes.filter(b => b === 254).length;
  assert.strictEqual(carvedCount, g.carved.length,
    `every carved cell must be marked: grid says ${g.carved.length}, bytes say ${carvedCount}`);
  assert.strictEqual(rg.carved, g.carved.length, 'the reported carve count must match too');
  for (const k of g.carved) assert.strictEqual(bytes[k], 254, `cell ${k} was carved but is byte ${bytes[k]}`);
  assert.strictEqual(rg.sizes.length, 1, 'after repair the map is one region');
  // The whole point of marking them: carved must not look like ordinary ground.
  assert.notStrictEqual(tints.CARVED_TINT, tints.regionTint(0), 'carved must not match the main tint');
  assert.notStrictEqual(tints.CARVED_TINT, tints.OVERFLOW_TINT, 'carved must not match the overflow tint');
  assert.ok(!tints.REGION_TINTS.includes(tints.CARVED_TINT), 'carved must not collide with a stray tint');
  console.log(`ok  ${carvedCount} carved cell(s) encode as byte 254 and paint a distinct colour`);
}

// 4. A sealed pocket is reported with a locatable cell, and that cell really is off the main region.
{
  const solid = (x) => Math.floor(x) === 10;
  // Divider is a wall (never soft), so the repair must give up and report instead of carving.
  const g = buildNavGrid((x) => !solid(x), BOUNDS, CELL,
    { heightAt: () => 0, softBlockedTest: () => false });
  assert.strictEqual(g.carved.length, 0, 'a wall must not be carved');
  const rg = encode(g);
  assert.ok(rg.sealed.length >= 1, 'the sealed pocket must be reported');
  const bytes = decodeBytes(rg);
  for (const s of rg.sealed) {
    assert.ok(Number.isInteger(s.cell) && s.cell >= 0, `sealed region needs a locatable cell, got ${s.cell}`);
    assert.ok(s.cell < bytes.length, 'the cell index must be inside the grid');
    // Not byte 1: a sealed pocket is by definition not the main region.
    assert.ok(bytes[s.cell] >= 2 && bytes[s.cell] <= 253,
      `sealed cell ${s.cell} should be a stray region byte, got ${bytes[s.cell]}`);
    assert.ok(s.cells > 0, 'a sealed region must report its size');
  }
  console.log(`ok  sealed pocket reported with a cell index that lands on a stray region`);
}

// 5. Over the cap, the encoder must say so rather than ship a truncated grid the viewer would draw.
{
  const g = buildNavGrid(() => true, { minX: 0, maxX: 200, minZ: 0, maxZ: 200 }, 0.1, {});
  assert.ok(g.cols * g.rows > CAP, 'fixture must exceed the cap to test the branch');
  const rg = encode(g);
  assert.strictEqual(rg.b64, null, 'no payload when over the cap');
  assert.strictEqual(rg.tooBig, g.cols * g.rows, 'the cell count must be reported so the UI can explain');
  console.log(`ok  ${rg.tooBig} cells exceeds the ${CAP} cap: reports tooBig instead of truncating`);
}

// 6. Encoder and decoder must be inverses. The encoder writes rank -> byte; the viewer reads
//    byte -> regionTint(byte - 1). If those two drift, the map colours regions by the wrong rank and
//    still looks entirely plausible, which is the worst kind of wrong for a diagnostic tool.
{
  // The exact expression the viewer uses to turn a byte back into a tint.
  const decodeExpr = /const hex = b === 254 \? CARVED_TINT : b === 255 \? OVERFLOW_TINT : (regionTint\(b - 1\));/
    .exec(viewSrc);
  assert.ok(decodeExpr, 'the viewer decode expression changed shape; this test must be updated with it');
  const byteToTint = new Function('regionTint', 'b', `return ${decodeExpr[1]};`);
  // BOTH sides come from source. Retyping the encoder formula here would make this test unable to
  // notice the encoder changing -- it would only be checking my copy against the viewer.
  const encExpr = /bytes\[k\] = (rk === 0 \? 1 : rk < \d+ \? rk \+ 1 : 255);/.exec(gameSrc);
  assert.ok(encExpr, 'the encoder byte formula changed shape; this test must be updated with it');
  const rankToByte = new Function('rk', `return ${encExpr[1]};`);
  // Ranks that must survive the round trip, including both palette-wrap and the overflow edge.
  for (const rank of [0, 1, 2, 9, 10, 11, 250, 251]) {
    const byte = rankToByte(rank);
    assert.ok(byte >= 1 && byte <= 255 && byte !== 254,
      `rank ${rank} encoded to ${byte}, which collides with the carved marker or is out of byte range`);
    assert.strictEqual(byteToTint(tints.regionTint, byte), tints.regionTint(rank),
      `rank ${rank} -> byte ${byte} -> tint must equal regionTint(${rank})`);
  }
  // Rank 0 specifically must decode to the near-neutral main tint, not a loud stray colour.
  assert.strictEqual(byteToTint(tints.regionTint, 1), tints.regionTint(0));
  assert.ok(!tints.REGION_TINTS.includes(tints.regionTint(0)),
    'the main region tint must not be one of the loud stray tints');
  console.log('ok  rank -> byte -> tint round-trips, including palette wrap and the main region');
}

// 7. No grid at all -> null, so a take recorded before the nav grid existed does not throw.
{
  assert.strictEqual(encode(null), null, 'a missing navGrid must encode as null');
  assert.strictEqual(encode({}), null, 'a grid without regions must encode as null');
  console.log('ok  absent nav grid encodes as null');
}

console.log('\nall world-region tests passed');
