// The stage: several creatures at once, who is selected, and what a control change applies to.
//
// WHY THIS IS A SEPARATE PURE MODULE. Three things here are easy to get subtly wrong and impossible to
// notice by looking at the screen: which creatures a slider change reaches, whether a click picked the
// creature under the cursor or the one behind it, and what a group of per-creature reports adds up to.
// None of them need THREE or a DOM, so all three are plain functions with known-answer tests.
//
// THE AVERAGE TRAP, stated once because it drives the design of `aggregateReports`. Every metric in
// `gait-diagnostics.js` is normalised against the creature it came from — a stride against that leg's own
// span, a skate against that body's own travel. That is what makes them comparable at all, and it is
// exactly what makes averaging them across a mixed stage meaningless: the mean of "23% of planted frames
// sliding" over a Rattata and a Paras is not a fact about anything. So the group view counts and ranks
// instead. A count of how many creatures are dragging is true; the average of how much they drag is not.

/** A control change applies to one creature, everything of its species, or the whole stage. */
export const SCOPES = ['one', 'species', 'all'];

/**
 * Which creatures a change reaches.
 *
 * `roster` is any array of `{id, species}`. Returns ids, and always in roster order so a change applies
 * in a stable sequence — a scope that returned ids in Map-iteration order would make a bug that depends
 * on apply order reproduce only sometimes.
 */
export function resolveScope(roster, scope, selectedId) {
  if (!roster || !roster.length) return [];
  if (scope === 'all') return roster.map(e => e.id);
  const sel = roster.find(e => e.id === selectedId);
  // No selection is not the same as "everything". A slider that silently applied to the whole stage
  // because nothing happened to be selected is the kind of thing you only notice three trials later.
  if (!sel) return [];
  if (scope === 'species') return roster.filter(e => e.species === sel.species).map(e => e.id);
  return [sel.id];
}

/**
 * Where the nth of `count` creatures stands.
 *
 * A ring rather than a grid: every creature is the same distance from the camera's default orbit centre,
 * so none of them is systematically further away and harder to judge, and the walk directions fan out
 * instead of all pointing down a row. `spacing` is the arc a creature needs, so the radius grows with the
 * count rather than the creatures growing closer together.
 */
export function spawnLayout(index, count, spacing) {
  if (count <= 1) return { x: 0, z: 0, yaw: 0 };
  const radius = Math.max(spacing, (spacing * count) / (2 * Math.PI));
  const a = (index / count) * Math.PI * 2;
  return { x: Math.cos(a) * radius, z: Math.sin(a) * radius, yaw: a + Math.PI };
}

/**
 * Closest capsule along a ray, or null.
 *
 * PICKING IS NOT DONE AGAINST THE MESHES, and that is not an optimisation. These models are authored with
 * vertices at 10x in bone-local space, so their bounding volumes are wrong — the viewer switches
 * `frustumCulled` off everywhere for exactly that reason. A mesh raycast would fall back to a full
 * triangle test against every skinned mesh on the stage and would still be wrong at the broad phase. A
 * capsule the walker's own dimensions imply is both correct and cheap.
 *
 * `capsules` are `{id, ax, ay, az, bx, by, bz, radius}`. `dir` need not be normalised.
 */
export function pickCapsule(origin, dir, capsules) {
  const dl = Math.hypot(dir.x, dir.y, dir.z);
  if (!(dl > 0) || !capsules || !capsules.length) return null;
  const dx = dir.x / dl, dy = dir.y / dl, dz = dir.z / dl;
  let best = null, bestT = Infinity;

  for (const c of capsules) {
    const sx = c.bx - c.ax, sy = c.by - c.ay, sz = c.bz - c.az;
    const wx = origin.x - c.ax, wy = origin.y - c.ay, wz = origin.z - c.az;
    const a = dx * dx + dy * dy + dz * dz;          // 1, but written out so the algebra reads
    const b = dx * sx + dy * sy + dz * sz;
    const cc = sx * sx + sy * sy + sz * sz;
    const d = dx * wx + dy * wy + dz * wz;
    const e = sx * wx + sy * wy + sz * wz;
    const den = a * cc - b * b;

    // t runs along the ray, s along the capsule's own segment. A near-zero denominator means the two are
    // parallel, and then any point on the segment is as good as another — take its start.
    let t, s;
    if (Math.abs(den) < 1e-12) { s = 0; t = -d; }
    else {
      t = (b * e - cc * d) / den;
      s = (a * e - b * d) / den;
    }
    s = s < 0 ? 0 : s > 1 ? 1 : s;
    // Re-solve t for the clamped s, so a segment endpoint is measured against the true closest point on
    // the ray rather than against wherever the unclamped solution happened to land.
    t = (s * b) - d;
    if (t < 0) continue;                             // behind the camera

    const px = origin.x + dx * t, py = origin.y + dy * t, pz = origin.z + dz * t;
    const qx = c.ax + sx * s, qy = c.ay + sy * s, qz = c.az + sz * s;
    const gap = Math.hypot(px - qx, py - qy, pz - qz);
    if (gap > c.radius) continue;
    if (t < bestT) { bestT = t; best = c.id; }
  }
  return best;
}

/**
 * What a stage of creatures adds up to.
 *
 * Counts and rankings only — see the note at the top of this file. `rows` are
 * `{id, species, label, report, headroom}`; `report` may be null for a creature whose measuring window
 * has not closed yet, and those are counted as `measuring` rather than as clean, because "no verdict yet"
 * and "no problem" are different answers and only one of them is good news.
 */
export function aggregateReports(rows) {
  const out = {
    count: rows.length, measuring: 0, dragging: 0, tapping: 0, clean: 0,
    bySpecies: [], worst: [], riskiest: [],
  };
  const species = new Map();

  for (const r of rows) {
    const sp = species.get(r.species) || { species: r.species, count: 0, dragging: 0, tapping: 0, measuring: 0 };
    sp.count++;
    if (!r.report) { out.measuring++; sp.measuring++; }
    else {
      const d = !!r.report.verdict.dragging, t = !!r.report.verdict.tapping;
      if (d) { out.dragging++; sp.dragging++; }
      if (t) { out.tapping++; sp.tapping++; }
      if (!d && !t) out.clean++;
      out.worst.push({
        id: r.id, label: r.label, species: r.species,
        skate: r.report.dragging.worstLegFraction,
        clamped: r.report.dragging.clampedFraction,
        dragging: d, tapping: t,
      });
    }
    // Predicted risk needs no window, so it is available for creatures the measurement cannot rank yet.
    // Kept as its own list rather than merged, so a prediction is never mistaken for a measurement.
    if (r.headroom) {
      out.riskiest.push({
        id: r.id, label: r.label, species: r.species,
        dragRisk: r.headroom.dragRisk, tapRisk: r.headroom.tapRisk,
        cause: r.headroom.dragRisk >= r.headroom.tapRisk ? r.headroom.worst?.id : r.headroom.worstTap?.id,
      });
    }
    species.set(r.species, sp);
  }

  out.worst.sort((a, b) => (b.skate + b.clamped) - (a.skate + a.clamped));
  out.riskiest.sort((a, b) => Math.max(b.dragRisk, b.tapRisk) - Math.max(a.dragRisk, a.tapRisk));
  out.bySpecies = [...species.values()].sort((a, b) => b.count - a.count);
  return out;
}

/** Ids in the roster that are not in `keep`, for tearing down what a respawn replaced. */
export function idsToRemove(roster, keep) {
  const set = new Set(keep);
  return roster.filter(e => !set.has(e.id)).map(e => e.id);
}
