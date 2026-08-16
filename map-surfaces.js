// map-surfaces.js -- every standable surface in a column, not just the topmost one.
//
// terrain-loader's heightAt() is a single-valued grid, and on a volumetric map (terrain-generator
// -v4's marching-cubes export) it is built by deriveTopSurfaceHeights, which keeps the max-Y
// vertex per cell. That describes the ROOF of a cave system and nothing beneath it, so anything
// placing content by sampling heightAt builds on the roof and leaves the interior empty.
//
// This module asks the collision mesh instead. One downward ray per column returns every hit, and
// that is enough to name each floor, the ceiling over it, and whether it is open to the sky.
//
// Pure: the only dependency is a `raycastAll(origin, dir, maxDistance, out)` callback returning
// hits near-to-far as { distance, point: [x,y,z], normal: [x,y,z] }. map-collision.js exports one;
// test-map-surfaces.mjs passes a fake, so this stays Node-testable with no GPU and no THREE.

export const SURFACE_DEFAULTS = {
  slopeLimitY: 0.5,       // cos of the steepest standable slope; matches resolveCapsule's default
  minHeadroom: 2.1,       // a standing bot capsule plus clearance
  coplanarEpsilon: 0.05,  // hits closer than this in Y are one surface (shared edges, seam tris)
  samples: 3,             // NxN grid over a footprint; 3 gives corners, edge midpoints and centre
  maxDeviation: 1.5,      // m of ground variation across a footprint before the site is rejected
  levelTolerance: null,   // how far a sample may sit from the asked-for level; null follows maxDeviation
};

// A downward ray hits a solid's underside from inside the solid, so its normal points DOWN into
// the cavity. Up-facing means standable; everything else is ceiling or wall.
function isFloor(hit, slopeLimitY) {
  return hit.normal[1] >= slopeLimitY;
}

/**
 * @param {object} io
 * @param {(origin:number[], dir:number[], maxDistance:number, out:any[]) => any[]} io.raycastAll
 * @param {number} io.worldYMax  top of the map; rays start just above it
 * @param {number} [io.worldYMin] bottom of the map; sets the ray length
 */
export function createSurfaceQuery({ raycastAll, worldYMax, worldYMin = -1000 }, defaults = {}) {
  const cfg = { ...SURFACE_DEFAULTS, ...defaults };
  const startY = worldYMax + 1;
  const rayLength = (startY - worldYMin) + 1;
  const DOWN = [0, -1, 0];
  const _origin = [0, 0, 0];
  const _hits = [];

  /**
   * Every standable surface in the column at (x, z), highest first.
   * Each entry: { y, normalY, headroom, ceilingY, openSky }.
   * `headroom` is the gap up to whatever is directly above -- Infinity when nothing is.
   */
  function surfacesAt(x, z, opts = {}) {
    const slopeLimitY = opts.slopeLimitY ?? cfg.slopeLimitY;
    const eps = opts.coplanarEpsilon ?? cfg.coplanarEpsilon;
    _origin[0] = x; _origin[1] = startY; _origin[2] = z;
    const hits = raycastAll(_origin, DOWN, rayLength, _hits);

    const out = [];
    let prevY = null;   // the last surface of ANY facing above this one: the ceiling
    for (let i = 0; i < hits.length; i++) {
      const y = hits[i].point[1];
      // Coplanar duplicates (a shared triangle edge reports twice) are one surface, not two, and
      // would otherwise report a zero headroom that rejects every site on flat ground.
      if (prevY !== null && Math.abs(prevY - y) <= eps) continue;
      if (isFloor(hits[i], slopeLimitY)) {
        out.push({
          y,
          normalY: hits[i].normal[1],
          headroom: prevY === null ? Infinity : prevY - y,
          ceilingY: prevY,
          openSky: prevY === null,
        });
      }
      prevY = y;
    }
    return out;
  }

  // `level` is a CONSTRAINT, not a preference: a surface further from it than the tolerance is no
  // match at all. Treating it as a mere preference is the bug this module exists to prevent -- a
  // sample with no floor at the asked-for level would silently snap up to the roof above it, and
  // the footprint would report a clean site spanning two storeys.
  function pickAtLevel(list, level, tol) {
    let best = null, bestScore = Infinity;
    for (const s of list) {
      const offset = level === null ? -s.y : Math.abs(s.y - level);
      if (level !== null && offset > tol) continue;
      if (offset < bestScore) { bestScore = offset; best = s; }
    }
    return best;
  }

  function toleranceFrom(opts) {
    return opts.levelTolerance ?? cfg.levelTolerance ?? opts.maxDeviation ?? cfg.maxDeviation;
  }

  // The standable surface in this column at `level`, or the highest one when no level is asked
  // for. Filters by headroom first, so a floor under a low overhang is never offered.
  function surfaceNear(x, z, level = null, opts = {}) {
    const need = opts.needHeadroom ?? cfg.minHeadroom;
    const standable = surfacesAt(x, z, opts).filter((s) => s.headroom >= need);
    return pickAtLevel(standable, level, toleranceFrom(opts));
  }

  /**
   * Can a w x d footprint centred on (cx, cz) sit at `level`?
   *
   * Seats the floor at the HIGHEST sample so no ground pokes up through it, and reports how far
   * the foundation has to skirt down to reach the lowest -- cut-and-fill, the way a real building
   * meets a slope. Structures on an imported map must conform to it; flattening a pad into an
   * authored landscape fights whoever authored it.
   */
  function footprintAt(cx, cz, w, d, level = null, opts = {}) {
    const n = Math.max(2, opts.samples ?? cfg.samples);
    const need = opts.needHeadroom ?? cfg.minHeadroom;
    const maxDeviation = opts.maxDeviation ?? cfg.maxDeviation;
    const tol = toleranceFrom(opts);
    let loY = Infinity, hiY = -Infinity, minHeadroom = Infinity;
    let openSky = true, misses = 0;

    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) {
        const x = cx - w / 2 + (w * ix) / (n - 1);
        const z = cz - d / 2 + (d * iz) / (n - 1);
        // Every sample resolves against the SAME level, so a footprint under an overhang stays on
        // one floor instead of half the samples snapping to the roof above it. Headroom is NOT a
        // filter here -- a cramped site has to survive selection to be reported as 'low-ceiling'
        // rather than disappearing and reading as 'no-surface'.
        const s = pickAtLevel(surfacesAt(x, z, opts), level, tol);
        if (!s) { misses++; continue; }
        if (s.y < loY) loY = s.y;
        if (s.y > hiY) hiY = s.y;
        if (s.headroom < minHeadroom) minHeadroom = s.headroom;
        if (!s.openSky) openSky = false;
      }
    }

    if (misses) return { ok: false, reason: 'no-surface', misses };
    const deviation = hiY - loY;
    if (deviation > maxDeviation) return { ok: false, reason: 'too-uneven', deviation, floorY: hiY };
    if (minHeadroom < need) return { ok: false, reason: 'low-ceiling', headroom: minHeadroom, floorY: hiY };
    return {
      ok: true,
      floorY: hiY,          // seat the floor here
      skirtDepth: deviation, // and carry the foundation down this far on the low side
      deviation,
      headroom: minHeadroom,
      openSky,
    };
  }

  // Every level a footprint could sit at, best (highest, roomiest) first. Candidate levels come
  // from the centre column, so a cave floor and the hillside above it are both offered and the
  // caller picks -- exterior content wants openSky, interior content wants the opposite.
  function footprintLevels(cx, cz, w, d, opts = {}) {
    const need = opts.needHeadroom ?? cfg.minHeadroom;
    const out = [];
    for (const candidate of surfacesAt(cx, cz, opts)) {
      if (candidate.headroom < need) continue;
      const fit = footprintAt(cx, cz, w, d, candidate.y, opts);
      if (fit.ok) out.push(fit);
    }
    return out;
  }

  return { surfacesAt, surfaceNear, footprintAt, footprintLevels, config: cfg };
}

/**
 * Every walkable surface that is NOT the one the nav grid's own `heightAt` already describes,
 * as cell-sized `{ x, z, w, d, y }` decks ready for nav-grid.js#attachLevels.
 *
 * buildNavGrid samples one height per column, and on a volumetric map that height is the top
 * surface -- so the hillside is in the grid and the cave under it is invisible to pathing. This
 * walks the SAME cell lattice buildNavGrid uses (`minX + (c + 0.5) * cellSize`) and emits a deck
 * for each additional standable surface, which is exactly the shape attachLevels stamps by cell
 * centre. One cell-sized deck per surface, so a level covers precisely the columns it exists in.
 *
 * `baseHeightAt` should be the same callback passed to buildNavGrid as `heightAt`. Surfaces within
 * `baseTolerance` of it are the base column and are skipped; without it the topmost is assumed to
 * be. Cost is one downward ray per column, paid once at map load.
 */
export function surfaceDecks(query, bounds, cellSize, opts = {}) {
  const { minX, maxX, minZ, maxZ } = bounds;
  const cols = Math.max(1, Math.ceil((maxX - minX) / cellSize));
  const rows = Math.max(1, Math.ceil((maxZ - minZ) / cellSize));
  const need = opts.needHeadroom ?? query.config.minHeadroom;
  const baseTolerance = opts.baseTolerance ?? 0.25;
  const baseHeightAt = opts.baseHeightAt ?? null;
  const maxDecks = opts.maxDecks ?? Infinity;
  const decks = [];
  let truncated = false;

  for (let r = 0; r < rows && !truncated; r++) {
    for (let c = 0; c < cols; c++) {
      const x = minX + (c + 0.5) * cellSize;
      const z = minZ + (r + 0.5) * cellSize;
      const list = query.surfacesAt(x, z, opts);
      if (list.length < 2 && !baseHeightAt) continue;   // one surface: the base grid already has it
      const baseY = baseHeightAt ? baseHeightAt(x, z) : list[0]?.y;
      for (const s of list) {
        if (s.headroom < need) continue;                       // no room to stand
        if (baseY !== undefined && Math.abs(s.y - baseY) <= baseTolerance) continue;  // the base column
        if (decks.length >= maxDecks) { truncated = true; break; }
        decks.push({ x, z, w: cellSize, d: cellSize, y: s.y });
      }
      if (truncated) break;
    }
  }
  // Never silently: a truncated deck set is a map with unreachable interiors, and a caller that
  // does not know it was capped will read the gap as a pathing bug.
  return { decks, truncated, columns: cols * rows };
}
