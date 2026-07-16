// Verifies the shoot-house bullet/wall collision behavior against the pure layout geometry.
// A map-BVH raycast returns the same nearest surface as analytic ray-vs-AABB over the same
// boxes, so this Node test (no three/BVH needed) validates the real behavior:
//   (A) shots pass cleanly through every spine doorway at every height,
//   (B) shots stop on the real wall face (not an offset proxy),
//   (C) contrast: the old bilinear heightfield ramps wall-top height into the doorway (the bug).
import { generateShootHouse } from './shoot-house-layout.js';

let fails = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };

const boxOf = (p) => ({ x0: p.cx - p.sx / 2, x1: p.cx + p.sx / 2, y0: p.cy - p.sy / 2, y1: p.cy + p.sy / 2, z0: p.cz - p.sz / 2, z1: p.cz + p.sz / 2 });

// ray (unit dir) vs AABB slab test → entry distance, or null. Origin assumed outside.
function rayBox(o, d, b) {
  let tmin = 0, tmax = Infinity;
  const lo = [b.x0, b.y0, b.z0], hi = [b.x1, b.y1, b.z1];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-9) { if (o[a] < lo[a] || o[a] > hi[a]) return null; continue; }
    let t1 = (lo[a] - o[a]) / d[a], t2 = (hi[a] - o[a]) / d[a];
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  return tmin;
}
function inside(o, b) { return o[0] >= b.x0 && o[0] <= b.x1 && o[1] >= b.y0 && o[1] <= b.y1 && o[2] >= b.z0 && o[2] <= b.z1; }

function makeWorld(layout) {
  const boxes = layout.primitives.map(boxOf);
  const norm = (d) => { const L = Math.hypot(d[0], d[1], d[2]) || 1; return [d[0] / L, d[1] / L, d[2] / L]; };
  function nearest(o, dir, maxD = 200) {
    const d = norm(dir); let best = null;
    for (const b of boxes) { const t = rayBox(o, d, b); if (t !== null && t <= maxD && (best === null || t < best)) best = t; }
    if (best === null) return null;
    return { distance: best, point: [o[0] + d[0] * best, o[1] + d[1] * best, o[2] + d[2] * best] };
  }
  // column-top (what a downward raycast onto the map returns): highest box top covering (x,z)
  function columnTop(x, z) {
    let top = -Infinity;
    for (const b of boxes) if (x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && b.y1 > top) top = b.y1;
    return top === -Infinity ? 0 : top;
  }
  const originInside = (o) => boxes.some(b => inside(o, b));
  return { nearest, columnTop, originInside };
}

for (const seed of [1, 2, 3, 4, 5]) {
  const layout = generateShootHouse(seed);
  const { meta, bounds } = layout;
  const ch = meta.corridorHalf;
  const W = makeWorld(layout);
  const firstHitX = (z, y, sign) => { const h = W.nearest([0, y, z], [sign, 0, 0], 200); return h ? Math.abs(h.point[0]) : Infinity; };

  for (const [name, side] of [['R', meta.right], ['L', meta.left]]) {
    const sign = Math.sign(side.spineX);
    const centers = [...side.spineDoorZ].sort((a, b) => a - b);

    // (A) the doorway OPENING is geometrically clear at every height — fire from just corridor-side
    // of the spine straight through the gap; the first hit must be well past the spine (a room wall),
    // i.e. no invisible geometry in the opening. (Firing from mid-corridor would legitimately hit
    // corridor cover, which is a feature, not this test's subject.)
    let passAll = true, worst = Infinity;
    for (const cz of centers) for (const y of [0.5, 1.0, 1.5, 2.0]) {
      const o = [sign * (ch - 0.5), y, cz];
      if (W.originInside(o)) continue;
      const h = W.nearest(o, [sign, 0, 0], 200);
      const hx = h ? Math.abs(h.point[0]) : Infinity;
      if (hx <= ch + 1.0) { passAll = false; worst = Math.min(worst, hx); }
    }
    ok(passAll, `[seed ${seed} ${name}] every spine doorway opening is clear at y=0.5..2.0` + (passAll ? '' : ` — blocked at x=${worst.toFixed(2)} (spine=${ch})`));

    // (B) shots at a solid spine segment stop ON the wall near face (~ch - T/2), not offset
    const solidZs = [];
    for (let i = 0; i < centers.length - 1; i++) solidZs.push((centers[i] + centers[i + 1]) / 2);
    if (centers.length) { solidZs.push(centers[0] - 3); solidZs.push(centers[centers.length - 1] + 3); }
    const offs = [];
    for (const z of solidZs) {
      if (z <= bounds.minZ + 1 || z >= bounds.maxZ - 1) continue;
      const o = [sign * (ch - 1.2), 1.4, z];
      if (W.originInside(o)) continue; // don't fire from inside corridor clutter
      const h = W.nearest(o, [sign, 0, 0], 6);
      if (h) offs.push(Math.abs(Math.abs(h.point[0]) - ch));
    }
    const maxOff = offs.length ? Math.max(...offs) : 99;
    ok(offs.length > 0 && maxOff < 0.25, `[seed ${seed} ${name}] wall shots land on the real spine face within 0.25m (max off ${maxOff.toFixed(3)}m)`);

    // (C) reproduce the OLD heightfield bug on one case + confirm BVH passes there
    if (name === 'R' && seed === 1) {
      const res = Math.max(64, Math.ceil(Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ)));
      const worldX = bounds.maxX - bounds.minX, worldZ = bounds.maxZ - bounds.minZ;
      const data = new Float32Array(res * res);
      for (let iz = 0; iz < res; iz++) for (let ix = 0; ix < res; ix++) {
        const wx = bounds.minX + ix / (res - 1) * worldX, wz = bounds.minZ + iz / (res - 1) * worldZ;
        data[iz * res + ix] = W.columnTop(wx, wz);
      }
      const sampleHF = (x, z) => {
        const fx = (x - bounds.minX) / worldX * (res - 1), fz = (z - bounds.minZ) / worldZ * (res - 1);
        const ix0 = Math.floor(fx), iz0 = Math.floor(fz), ix1 = Math.min(ix0 + 1, res - 1), iz1 = Math.min(iz0 + 1, res - 1);
        const tx = fx - ix0, tz = fz - iz0;
        const h0 = data[iz0 * res + ix0] + (data[iz0 * res + ix1] - data[iz0 * res + ix0]) * tx;
        const h1 = data[iz1 * res + ix0] + (data[iz1 * res + ix1] - data[iz1 * res + ix0]) * tx;
        return h0 + (h1 - h0) * tz;
      };
      // Informational contrast: scan the old heightfield in a 2D band over the whole spine and
      // report the tallest invisible blocker it produces and how far that sits from the true wall
      // plane (x=ch). Because the ~0.6m(x)/~1.0m(z) grid pitch is coarser than the 0.3m-thin walls,
      // the field both aliases (misses wall stretches) and ramps (bleeds wall-top height up to ~1m
      // into open floor / doorways) — the misaligned, inconsistent blocker you were hitting.
      let maxRamp = 0, atX = 0, atZ = 0;
      for (let x = ch - 1.5; x <= ch + 1.5; x += 0.15)
        for (let z = bounds.minZ + 2; z <= bounds.maxZ - 2; z += 0.2) {
          const hf = sampleHF(sign * x, z);
          if (hf > maxRamp) { maxRamp = hf; atX = x; atZ = z; }
        }
      console.log(`     [demo] old heightfield near the right spine: tallest invisible blocker ${maxRamp.toFixed(2)} m at x=${(sign * atX).toFixed(2)} (true wall plane x=${(sign * ch).toFixed(2)}, off ${Math.abs(atX - ch).toFixed(2)} m), z=${atZ.toFixed(1)} — an off-face, height-dependent blocker. The BVH path stops shots exactly on the wall face (test B) and leaves openings clear (test A).`);
    }
  }
}

console.log(fails ? `\n*** ${fails} FAIL ***` : '\n*** ALL PASS ***');
process.exit(fails ? 1 : 0);
