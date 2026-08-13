// flight-terrain.js — the analytic height field the flight harness flies over.
//
// Pure JavaScript, no imports at all, so it runs under Node and is the single source of truth for
// where the ground is. The GPU twin — the same field written as a TSL node graph — lives with the
// clipmap in the viewer. Only the SHAPE is written twice (the WAVES table is shared), but that is
// still enough to drift, so edit the two together. This is the same hand-synced-twin arrangement as
// `forest-cull.js` / `light-cluster.js` / `post-grade.js`, except the CPU side here is production
// rather than a test mirror.
//
// See docs/subsystems/flight.md for why the field is a sum of plane waves and why it is band
// limited by distance.

export const TS = 0.00085;          // world frequency scale, 1/metres
export const RIDGE_AMP = 300;
export const BASE_OFFSET = -40;     // pushes the low ground under y=0 so the water plane makes lakes

// clipmap shape, declared here because the height field's band limit is derived from it
export const RING_N = 96;           // quads per side, per ring
export const RING_BASE = 512;       // half-extent of the innermost ring, metres
export const RING_LEVELS = 5;       // outermost half-extent = RING_BASE * 2^4 = 8192 m

// The first version of this was sin(x*a)*cos(z*b) summed four times, and it came out as parallel
// furrows across the whole map. Two compounding reasons. It is SEPARABLE, so bumps sit on a
// rectangle square with the world axes. Worse, every octave used b/a near 1, and
// sin(A)cos(B) = (sin(A+B) + sin(A-B))/2 — with A and B nearly equal that is ONE diagonal plane
// wave plus a long beat, so all four octaves ran as near-parallel corrugations. Replaced with a sum
// of plane waves whose directions are spread by the golden angle and whose frequencies are
// geometric, which is the usual cheap stand-in for an isotropic random field, then domain-warped so
// the wavefronts meander instead of running straight.
// 16 waves at a 1.28 frequency ratio, chosen by sweep: it is the point where the fine detail stops
// being directional (a 36-bin high-passed direction test drops from 4.9x to 2.4x). Fewer waves
// leave too few in any one size band, so each band reads as a couple of parallel ripples again;
// more than 16 buys nothing measurable.
export const WAVES = [];
{
  const GOLDEN = 2.399963;   // never repeats an angle, so no two waves share a direction
  let f = 0.75, amp = 165;
  for (let i = 0; i < 16; i++) {
    const a = i * GOLDEN;
    WAVES.push({
      kx: Math.cos(a) * f, kz: Math.sin(a) * f, amp, ph: (i * 1.7) % 6.283185,
      lambda: (Math.PI * 2) / (TS * f),   // world wavelength, for the band limit below
    });
    f *= 1.28; amp *= 0.74;   // roughly 1/f: big landforms, fine detail small
  }
}

// BAND LIMIT. The clipmap samples the field on a lattice that gets coarser with distance, and a
// wave shorter than two of those samples cannot be represented — it folds into a low frequency and
// shows up as fingerprint-whorl moire over the whole distance. Ring 4 has 170 m cells against a
// 243 m finest wave, which is 1.4 samples per wavelength, well under Nyquist.
//
// So each wave is faded out once the local sample spacing gets close to it: full weight at 8
// samples per wavelength, gone by 4. This is what a mipmap does for a texture, done analytically.
// Nyquist is 2 samples, but 2 is where a signal is merely representable, not where it looks right —
// on a shaded surface the lattice is about 10 px across, so anything varying over fewer than about
// 4 cells reads as stipple.
//
// The weight depends on DISTANCE, not on ring index, which matters: two rings overlap along a band,
// and if they disagreed about the height there the seam would crack open. Distance is the same
// number for both, so they agree. Clipmap ring k spans out to S_k with cells of S_k/48, so the
// spacing at distance d is just d/48, clamped to the range the rings actually provide.
export const CELL0 = (2 * RING_BASE) / RING_N;
export const CELL_MAX = CELL0 * Math.pow(2, RING_LEVELS - 1);

export function waveWeight(lambda, spacing) {
  if (!(spacing > 0)) return 1;                       // spacing 0 means "full detail" (physics)
  const t = Math.min(1, Math.max(0, (spacing - lambda / 8) / (lambda / 8)));
  return 1 - t * t * (3 - 2 * t);
}

// warp amplitudes stay well under lambda/2pi per term, so the field distorts but never folds back
export function warpX(x, z) {
  return Math.sin(z * TS * 0.31 + 1.7) * 620 + Math.cos(x * TS * 0.23 - 0.4) * 380
    + Math.sin(z * TS * 2.90 - 0.6) * 105 + Math.cos(x * TS * 3.30 + 2.2) * 85;
}
export function warpZ(x, z) {
  return Math.cos(x * TS * 0.27 - 2.1) * 640 + Math.sin(z * TS * 0.19 + 1.1) * 350
    + Math.cos(x * TS * 3.10 + 0.9) * 100 + Math.sin(z * TS * 2.70 - 1.4) * 90;
}

// spacing 0 (the default) is full detail, which is what the physics and the AI always want — only
// the picture is band-limited, and only where the lattice cannot carry the detail anyway
export function heightAt(x, z, spacing = 0) {
  const px = (x + warpX(x, z)) * TS;
  const pz = (z + warpZ(x, z)) * TS;
  let h = 0;
  for (let i = 0; i < WAVES.length; i++) {
    const w = WAVES[i];
    h += Math.sin(px * w.kx + pz * w.kz + w.ph) * w.amp * waveWeight(w.lambda, spacing);
  }
  const r = 1 - Math.abs(Math.sin(px * 0.55 - pz * 0.36 + 0.6));
  return h + r * r * RIDGE_AMP + BASE_OFFSET;
}

// the clipmap's own resolution rule, as a continuous function of distance
export function spacingAt(x, z, camX, camZ) {
  return Math.min(CELL_MAX, Math.max(CELL0, Math.hypot(x - camX, z - camZ) / (RING_N / 2)));
}

// height above ground, the number the radar altimeter and the AI's terrain dodge both want
export function agl(p) { return p.y - heightAt(p.x, p.z); }
