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

export function nodeSize(cfg, level) { return cfg.leafSize * (2 ** level); }

export function levelRanges(cfg) {
  const r = new Float32Array(cfg.levels);
  for (let L = 0; L < cfg.levels; L++) r[L] = cfg.leafSize * (2 ** L) * cfg.lodScale;
  return r;
}

// Min distance (XZ) from point (px,pz) to the axis-aligned cell [ox,ox+s)x[oz,oz+s).
export function minDistToCell(ox, oz, s, px, pz) {
  const dx = px < ox ? ox - px : (px > ox + s ? px - (ox + s) : 0);
  const dz = pz < oz ? oz - pz : (pz > oz + s ? pz - (oz + s) : 0);
  return Math.hypot(dx, dz);
}

// CDLOD morph factor for an emitted node: 0 until morphStart*range, ramps to 1 at range.
export function morphFactor(cfg, ranges, level, d) {
  const R = ranges[level];
  const start = cfg.morphStart * R;
  if (R <= start) return 0;
  return Math.max(0, Math.min(1, (d - start) / (R - start)));
}

// Flattened distance-band selection. A node at level L is emitted iff its parent was
// refined into it (camera close enough for level L) AND it is not itself refined (camera
// too far for the finer level L-1). This reproduces recursive CDLOD selection exactly, so
// the emitted nodes form a partition of the covered region.
export function selectNodes(cfg, camX, camZ) {
  const ranges = levelRanges(cfg);
  const half = Math.floor(cfg.windowCells / 2);
  const out = [];
  for (let L = 0; L < cfg.levels; L++) {
    const s = nodeSize(cfg, L);
    const cCellX = Math.floor(camX / s);
    const cCellZ = Math.floor(camZ / s);
    for (let lz = -half; lz <= half; lz++) {
      for (let lx = -half; lx <= half; lx++) {
        const ix = cCellX + lx, iz = cCellZ + lz;
        const ox = ix * s, oz = iz * s;
        const d = minDistToCell(ox, oz, s, camX, camZ);

        // self-refine gate: not refined into finer level (L==0 can't refine)
        const notRefined = (L === 0) || (d > ranges[L - 1]);
        // parent-refine gate: parent (level L+1) was refined into this node
        let refinedByParent;
        if (L === cfg.levels - 1) {
          refinedByParent = true;                       // coarsest: no parent gate
        } else {
          const ps = nodeSize(cfg, L + 1);
          const pIx = Math.floor(ix / 2), pIz = Math.floor(iz / 2);
          const pd = minDistToCell(pIx * ps, pIz * ps, ps, camX, camZ);
          refinedByParent = pd <= ranges[L];            // parent close enough -> refined to level L
        }
        if (notRefined && refinedByParent) {
          out.push({
            level: L, ix, iz, originX: ox, originZ: oz, size: s,
            d, morphK: morphFactor(cfg, ranges, L, d),
          });
        }
      }
    }
  }
  return out;
}

export function nodeCountForViewDistance(cfg, camX, camZ) {
  return selectNodes(cfg, camX, camZ).length;
}
