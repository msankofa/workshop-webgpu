// cdlod-select.js
// Pure-JS CDLOD node selection math — no three.js. The CPU source of truth that the
// cdlod-terrain.js TSL compute transcribes, and the target for the Node parity tests
// (coverage partition, bounded cost = the gate, crack-free morphing). Camera-snapped,
// Morton-keyed quadtree with flattened distance-band LOD selection (SP3 Decision 4):
// every visible point lands in exactly one selected node.

// ---- Morton (Z-order) keys: interleave 16 low bits of each axis; tag level separately.
// Mirrors the research's linear-quadtree encoding (the node identity the GPU writes per
// instance). Selection itself is flattened, not tree-traversal, so keys are identity, not
// a traversal structure.
export function part1by1(n) {            // spread 16 low bits into even bit positions
  n = n & 0x0000ffff;
  n = (n | (n << 8)) & 0x00ff00ff;
  n = (n | (n << 4)) & 0x0f0f0f0f;
  n = (n | (n << 2)) & 0x33333333;
  n = (n | (n << 1)) & 0x55555555;
  return n >>> 0;
}
export function compact1by1(n) {
  n = n & 0x55555555;
  n = (n | (n >>> 1)) & 0x33333333;
  n = (n | (n >>> 2)) & 0x0f0f0f0f;
  n = (n | (n >>> 4)) & 0x00ff00ff;
  n = (n | (n >>> 8)) & 0x0000ffff;
  return n & 0xffff;
}
// Signed cell indices biased by 0x8000 so negatives interleave monotonically in 16 bits.
export function mortonKey(level, ix, iz) {
  const ux = (ix + 0x8000) & 0xffff, uz = (iz + 0x8000) & 0xffff;
  const code = (part1by1(ux) | (part1by1(uz) << 1)) >>> 0;
  return { level, code };
}
export function decodeMorton(key) {
  const ux = compact1by1(key.code);
  const uz = compact1by1(key.code >>> 1);
  return { level: key.level, ix: ux - 0x8000, iz: uz - 0x8000 };
}
