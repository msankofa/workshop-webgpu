// terrain-clipmap-window.js — one clipmap level's height window, pure (no three.js, no worker).
//
// A level samples the terrain source every `post` metres. Its heights live in a res × res toroidal
// window: global post (gx, gz) always sits at texel (gx mod res, gz mod res), so re-centring the
// window never moves data — only the tiles newly exposed get generated, in place. The window is
// filled from source tiles of `tileIntervals` posts a side (tile (ix, iz) covers posts
// [ix·n, ix·n + n]); the origin snaps to tile boundaries so a tile always lands whole.
//
// Nothing here knows about rings, textures or cameras: terrain-clipmap.js wraps one of these per
// level, renders it, and the Node test drives it directly.
//
// A window carries one or more tile FIELDS (plants plan F2). `heights` is always present and is
// what the clipmap ring renders; a placement window adds `surfaceHeights`, `biomeIds`, `moisture`
// and reads them through the same toroidal addressing. Ids are nearest-sampled — averaging two
// biome numbers produces a third, unrelated biome.

export const CLIPMAP_WINDOW_DEFAULTS = Object.freeze({
  tileIntervals: 32,   // posts per tile side (tile = 32 posts = 64 m at a 2 m post)
  tilesPerSide: 8,     // window = 256 posts; the ring uses 192 of them, the rest is slack for snapping
});

export const wrapIndex = (i, n) => ((i % n) + n) % n;

// Tile fields a window can carry, and how each is stored and read back.
export const WINDOW_FIELD_KINDS = Object.freeze({
  heights: { Array: Float32Array, sampling: 'bilinear' },
  surfaceHeights: { Array: Float32Array, sampling: 'bilinear' },
  moisture: { Array: Float32Array, sampling: 'bilinear' },
  biomeIds: { Array: Uint8Array, sampling: 'nearest' },
  planWalk: { Array: Uint8Array, sampling: 'nearest' },
  // Derived per texel when a tile commits (flora-field.js), not built by the source. u8 channels
  // read back 0..255 on both sides; decodeCover turns that into 0..1.
  coverGrass: { Array: Uint8Array, sampling: 'bilinear' },
  coverPlant: { Array: Uint8Array, sampling: 'bilinear' },
  coverTree: { Array: Uint8Array, sampling: 'bilinear' },
});

export function createClipmapWindow({ level, post, tileIntervals = CLIPMAP_WINDOW_DEFAULTS.tileIntervals, tilesPerSide = CLIPMAP_WINDOW_DEFAULTS.tilesPerSide, fields = ['heights'], lod = null } = {}) {
  if (!Number.isInteger(level) || level < 0) throw new TypeError('clipmap window needs an integer level >= 0');
  if (!(post > 0)) throw new TypeError('clipmap window needs a positive post spacing');
  // lod defaults to level + 1 so the source band-limits at the window's own spacing; a consumer
  // that plants things on the drawn ground passes 0, because the visible chunks are built exact.
  const tileLod = lod == null ? level + 1 : lod;
  if (!Number.isInteger(tileLod) || tileLod < 0) throw new TypeError('clipmap window lod must be a non-negative integer');
  const fieldNames = fields.includes('heights') ? [...fields] : ['heights', ...fields];
  for (const f of fieldNames) if (!WINDOW_FIELD_KINDS[f]) throw new TypeError(`clipmap window cannot carry field ${f}`);
  const n = tileIntervals;
  const res = n * tilesPerSide;
  const data = new Map(fieldNames.map(name => [name, new WINDOW_FIELD_KINDS[name].Array(res * res)]));
  const heights = data.get('heights');
  const present = new Set();        // tile keys "ix,iz" currently written into the window
  let originPX = 0, originPZ = 0;   // window covers global posts [origin, origin + res - 1]
  let placed = false;
  let version = 0;                  // bumps whenever heights change (texture upload trigger)

  const tileKey = (ix, iz) => `${ix},${iz}`;
  const tileSize = n * post;

  // Where the window should sit for a focus point: centred, snapped to whole tiles.
  function desiredOrigin(x, z) {
    const cx = x / post, cz = z / post;
    return [Math.round((cx - res / 2) / n) * n, Math.round((cz - res / 2) / n) * n];
  }

  // Move the window for a focus point. Returns true when the origin changed (tiles now missing).
  function recentre(x, z) {
    const [ox, oz] = desiredOrigin(x, z);
    if (placed && ox === originPX && oz === originPZ) return false;
    originPX = ox; originPZ = oz; placed = true;
    // evict tiles that no longer lie inside the window
    for (const key of [...present]) {
      const [ix, iz] = key.split(',').map(Number);
      if (!tileInside(ix, iz)) present.delete(key);
    }
    return true;
  }
  function tileInside(ix, iz) {
    const px = ix * n, pz = iz * n;
    return px >= originPX && px + n <= originPX + res && pz >= originPZ && pz + n <= originPZ + res;
  }

  // Tiles the window needs but does not hold, nearest to the focus first.
  function missingTiles(x, z) {
    const out = [];
    const tx0 = originPX / n, tz0 = originPZ / n;
    const fx = x / tileSize - 0.5, fz = z / tileSize - 0.5;
    for (let tz = tz0; tz < tz0 + tilesPerSide; tz++) for (let tx = tx0; tx < tx0 + tilesPerSide; tx++) {
      if (present.has(tileKey(tx, tz))) continue;
      out.push({ ix: tx, iz: tz, d: (tx - fx) ** 2 + (tz - fz) ** 2 });
    }
    out.sort((a, b) => a.d - b.d);
    return out;
  }

  // The source tile request for tile (ix, iz) at this level. lod = level + 1 so the source always
  // band-limits (lod 0 is reserved for exact collision tiles).
  function tileRequest(ix, iz) {
    return { ix, iz, lod: tileLod, xMin: ix * tileSize, zMin: iz * tileSize, size: tileSize, intervals: n, apron: 1, fields: fieldNames.slice() };
  }

  // Write a completed tile into the window. Ignored (false) when the tile no longer fits.
  function commitTile(tile) {
    const { ix, iz } = tile;
    if (!tileInside(ix, iz)) return false;
    for (const name of fieldNames) if (!tile[name]) return false;   // a partial tile would leave holes
    const pad = tile.apron ?? 0, texels = tile.texels;
    for (const name of fieldNames) {
      const dst = data.get(name), src = tile[name];
      for (let p = 0; p <= n; p++) {
        const gz = iz * n + p, tz = wrapIndex(gz, res);
        const row = (p + pad) * texels + pad;
        for (let q = 0; q <= n; q++) {
          const gx = ix * n + q;
          dst[tz * res + wrapIndex(gx, res)] = src[row + q];
        }
      }
    }
    present.add(tileKey(ix, iz));
    version++;
    return true;
  }

  // True when all four posts around (x, z) are inside the window and their tiles have arrived.
  function resolved(x, z) {
    const fx = x / post, fz = z / post;
    const gx = Math.floor(fx), gz = Math.floor(fz);
    if (gx < originPX || gx + 1 > originPX + res - 1 || gz < originPZ || gz + 1 > originPZ + res - 1) return null;
    const tx = Math.floor(gx / n), tz = Math.floor(gz / n);
    const tx1 = Math.floor((gx + 1) / n), tz1 = Math.floor((gz + 1) / n);
    for (const [a, b] of [[tx, tz], [tx1, tz], [tx, tz1], [tx1, tz1]]) if (!present.has(tileKey(a, b))) return null;
    return { gx, gz, t: fx - gx, u: fz - gz };
  }

  // Bilinear value from a field, or null when (x, z) is not covered by present tiles.
  function sampleField(name, x, z) {
    const arr = data.get(name);
    if (!arr) return null;
    const at = resolved(x, z);
    if (!at) return null;
    const { gx, gz, t, u } = at;
    const v = (X, Z) => arr[wrapIndex(Z, res) * res + wrapIndex(X, res)];
    if (WINDOW_FIELD_KINDS[name].sampling === 'nearest') return v(gx + (t < 0.5 ? 0 : 1), gz + (u < 0.5 ? 0 : 1));
    return (v(gx, gz) * (1 - t) + v(gx + 1, gz) * t) * (1 - u) + (v(gx, gz + 1) * (1 - t) + v(gx + 1, gz + 1) * t) * u;
  }
  const sample = (x, z) => sampleField('heights', x, z);

  return {
    level, post, res, tileIntervals: n, tilesPerSide, tileSize, heights,
    lod: tileLod, fields: Object.freeze(fieldNames.slice()),
    array: (name) => data.get(name) ?? null,
    sampleField, resolved,
    get originPX() { return originPX; },
    get originPZ() { return originPZ; },
    get placed() { return placed; },
    get version() { return version; },
    get presentCount() { return present.size; },
    get coverage() { return present.size / (tilesPerSide * tilesPerSide); },
    hasTile: (ix, iz) => present.has(tileKey(ix, iz)),
    desiredOrigin, recentre, missingTiles, tileRequest, commitTile, sample, tileInside,
    // Call after an in-place derived-field write so CPU/GPU consumers see a new revision.
    touch() { version++; },
    // Global post extent the window holds, for callers that need to know what is addressable.
    covers(x, z) { const gx = x / post, gz = z / post; return gx >= originPX && gx <= originPX + res - 1 && gz >= originPZ && gz <= originPZ + res - 1; },
    clear() { present.clear(); for (const arr of data.values()) arr.fill(0); version++; },
  };
}

// A full clipmap's worth of levels: post doubles per level. `ringCells` is how many posts the ring
// mesh spans (must leave slack inside the window for snapping: ringCells + 2·tileIntervals <= res).
export function createClipmapLevels({ levels = 6, post0 = 2, ringCells = 192, tileIntervals, tilesPerSide } = {}) {
  const out = [];
  for (let L = 0; L < levels; L++) out.push(createClipmapWindow({ level: L, post: post0 * 2 ** L, tileIntervals, tilesPerSide }));
  const res = out[0].res;
  if (ringCells + 2 * out[0].tileIntervals > res) throw new RangeError(`ringCells ${ringCells} leaves no snapping slack in a ${res}-post window`);
  return out;
}
