// flight-terrain-stream.js — an infinite height field carried in a window that follows the plane.
//
// The static bake (flight-terrain-baked.js) is a fixed square: fly far enough and the edge cell
// extends forever. This is the same idea made unbounded — a res x res window of posts that scrolls,
// generating only the ground newly exposed rather than the whole window.
//
// TOROIDAL. The window does not slide its contents; it wraps. Global post (gx, gz) always lives at
// texel (gx mod res, gz mod res), so moving the window east overwrites the column that just fell off
// the west edge, in place. Nothing is copied and nothing is reallocated — advancing by one post
// costs one column of generation and no memory traffic at all. The GPU does the same `mod` on its
// integer fetch, which is why the twin stays a twin.
//
// The consequence to remember: a cell whose four corners straddle the wrap has neighbours from the
// opposite edge of the world. `sample` therefore refuses anything not wholly inside the window and
// the caller falls back to the generator, which is exact everywhere and merely slower.
//
// Pure: no three.js, no worker, no DOM. The viewer drives it, the worker fills it, Node tests it.

export const STREAM_DEFAULTS = Object.freeze({
  res: 1025,          // posts per side; 1025 * 20 m = 20.5 km window against an 8.2 km clipmap reach
  post: 20,           // metres between posts
  blockPosts: 64,     // the window only moves in whole blocks, so it re-uploads every 1280 m, not every metre
});

const wrap = (i, n) => ((i % n) + n) % n;

export function createTerrainStream(opts = {}) {
  const { res, post, blockPosts } = { ...STREAM_DEFAULTS, ...opts };
  if (!Number.isInteger(res) || res < 4) throw new Error('stream res must be an integer >= 4');
  if (!(post > 0)) throw new Error('stream post must be positive');
  if (!Number.isInteger(blockPosts) || blockPosts < 1) throw new Error('stream blockPosts must be a positive integer');

  const heights = new Float32Array(res * res);
  // Origin in GLOBAL post coordinates — the window covers [originPX, originPX + res - 1] on each
  // axis. Starts deliberately unset so the first plan() always produces a full fill.
  let originPX = 0, originPZ = 0, filled = false;

  const state = {
    res, post, blockPosts, heights,
    get originPX() { return originPX; },
    get originPZ() { return originPZ; },
    get filled() { return filled; },
    get size() { return res * post; },

    // World bounds of the region `sample` can answer for. One post short on the far side because a
    // bilinear cell needs its +1 neighbour, and that neighbour must not be the wrapped-around edge.
    get minX() { return originPX * post; },
    get minZ() { return originPZ * post; },
    get maxX() { return (originPX + res - 1) * post; },
    get maxZ() { return (originPZ + res - 1) * post; },

    covers(x, z) {
      return filled && x >= state.minX && x <= state.maxX && z >= state.minZ && z <= state.maxZ;
    },

    // Bilinear, wrapped. Same arithmetic as sampleBake and as the TSL twin: GLSL's mix expansion,
    // a + (b - a) * t, so the three agree to the bit rather than merely algebraically.
    sample(x, z) {
      // Cell and fraction are computed in GLOBAL post space, then wrapped for the fetch. Doing the
      // subtraction first (x / post - originPX) is algebraically the same and drifts by ~1e-13 m as
      // the window scrolls, which would make a world point's height depend on where the plane
      // happens to be. Picometres, but there is no reason to accept a position-dependent answer.
      const fx = x / post, fz = z / post;
      let gx = Math.floor(fx), gz = Math.floor(fz);
      const hiX = originPX + res - 2, hiZ = originPZ + res - 2;
      gx = gx < originPX ? originPX : gx > hiX ? hiX : gx;
      gz = gz < originPZ ? originPZ : gz > hiZ ? hiZ : gz;
      let tx = fx - gx, tz = fz - gz;
      tx = tx < 0 ? 0 : tx > 1 ? 1 : tx;
      tz = tz < 0 ? 0 : tz > 1 ? 1 : tz;
      const wx0 = wrap(gx, res), wz0 = wrap(gz, res);
      const wx1 = wrap(gx + 1, res), wz1 = wrap(gz + 1, res);
      const h00 = heights[wz0 * res + wx0], h10 = heights[wz0 * res + wx1];
      const h01 = heights[wz1 * res + wx0], h11 = heights[wz1 * res + wx1];
      const a0 = h00 + (h10 - h00) * tx;
      const a1 = h01 + (h11 - h01) * tx;
      return a0 + (a1 - a0) * tz;
    },

    // Where the window wants to be for a plane at (centerX, centerZ), snapped to a block.
    wantOrigin(centerX, centerZ) {
      const snap = (c) => Math.round((c / post - res / 2) / blockPosts) * blockPosts;
      return { px: snap(centerX), pz: snap(centerZ) };
    },

    // What must be generated to move the window there: the new area minus the old, as up to four
    // non-overlapping rectangles in global post coordinates. Returns null when nothing moved.
    plan(centerX, centerZ) {
      const want = state.wantOrigin(centerX, centerZ);
      if (filled && want.px === originPX && want.pz === originPZ) return null;
      const spans = filled
        ? subtractWindow(want.px, want.pz, originPX, originPZ, res)
        : [{ px: want.px, pz: want.pz, w: res, h: res }];
      return { originPX: want.px, originPZ: want.pz, spans, full: !filled };
    },

    // Move the window and write the generated spans in. Applied together so the origin and the
    // contents can never disagree — a half-moved window would sample the wrong world.
    commit(plan, values) {
      if (!plan) return;
      originPX = plan.originPX; originPZ = plan.originPZ;
      for (let s = 0; s < plan.spans.length; s++) state.writeSpan(plan.spans[s], values[s]);
      filled = true;
    },

    writeSpan(span, data) {
      if (!data || data.length !== span.w * span.h) {
        throw new Error(`span data must hold ${span.w * span.h} heights, got ${data ? data.length : 0}`);
      }
      for (let j = 0; j < span.h; j++) {
        const row = wrap(span.pz + j, res) * res;
        for (let i = 0; i < span.w; i++) heights[row + wrap(span.px + i, res)] = data[j * span.w + i];
      }
    },
  };
  return state;
}

// Rectangle subtraction: the parts of the new window not covered by the old one. Split as one
// vertical strip per uncovered side plus horizontal strips over the shared columns, so the pieces
// never overlap and no post is generated twice.
export function subtractWindow(nx, nz, ox, oz, res) {
  const nx1 = nx + res - 1, nz1 = nz + res - 1;
  const ox1 = ox + res - 1, oz1 = oz + res - 1;
  if (nx > ox1 || nx1 < ox || nz > oz1 || nz1 < oz) return [{ px: nx, pz: nz, w: res, h: res }];

  const spans = [];
  const push = (px, pz, w, h) => { if (w > 0 && h > 0) spans.push({ px, pz, w, h }); };

  const leftW = Math.max(0, ox - nx);
  const rightW = Math.max(0, nx1 - ox1);
  push(nx, nz, leftW, res);
  push(ox1 + 1, nz, rightW, res);

  // the columns both windows share; horizontal strips only need to cover these
  const midX = nx + leftW;
  const midW = res - leftW - rightW;
  push(midX, nz, midW, Math.max(0, oz - nz));
  push(midX, oz1 + 1, midW, Math.max(0, nz1 - oz1));
  return spans;
}

// Fill one span from a point height function. The worker calls this; so does the synchronous
// fallback for a page opened without one, and the tests.
export function fillSpan(span, post, heightFn) {
  const out = new Float32Array(span.w * span.h);
  for (let j = 0; j < span.h; j++) {
    const z = (span.pz + j) * post;
    const row = j * span.w;
    for (let i = 0; i < span.w; i++) out[row + i] = heightFn((span.px + i) * post, z);
  }
  return out;
}

export function spanPostCount(plan) {
  return plan ? plan.spans.reduce((n, s) => n + s.w * s.h, 0) : 0;
}
