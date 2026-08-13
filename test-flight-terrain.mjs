// test-flight-terrain.mjs — the analytic height field and its band limit.
//
// The two artifacts this guards against both looked like "aliasing" and neither was: the first was
// a separable field collapsing into parallel furrows, the second was the clipmap sampling below
// Nyquist. Both are described in docs/subsystems/flight.md.
//
// A note on measurement, because three of the metrics I first reached for were measuring the wrong
// quantity and said the problems did not exist. They are recorded here as rejected so nobody
// re-derives them: autocorrelation measured smoothness, not repetition (both fields scored 0.93);
// plain slope-by-direction was drowned by the 7 km landform terms (both 2.4x); and variance below
// Nyquist read 0.02% where the slope measure read 22.5%.
//
//   node test-flight-terrain.mjs

import {
  heightAt, spacingAt, waveWeight, agl,
  WAVES, TS, RING_N, RING_BASE, RING_LEVELS, CELL0, CELL_MAX,
} from './flight-terrain.js';

// Every sample position below comes from this, not Math.random. The anisotropy ratio varies by
// about +/-0.7 between runs on 3000 random samples, which was enough to flip the comparison from
// 4.6x-vs-2.5x (comfortably passing) to 3.9x-vs-2.6x (failing) on maybe one run in five. A test
// that answers differently each time is not a test.
let seed = 0x9e3779b9;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

let fails = 0;
const ok = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

// ---------------------------------------------------------------------------
console.log('--- 1. the field is finite, flyable, and has both water and peaks ---');
// ---------------------------------------------------------------------------
{
  let lo = Infinity, hi = -Infinity, bad = 0, maxSlope = 0;
  for (let i = 0; i < 20000; i++) {
    const x = (rnd() - 0.5) * 60000, z = (rnd() - 0.5) * 60000;
    const h = heightAt(x, z);
    if (!Number.isFinite(h)) { bad++; continue; }
    lo = Math.min(lo, h); hi = Math.max(hi, h);
    const d = 4;
    const gx = (heightAt(x + d, z) - heightAt(x - d, z)) / (2 * d);
    const gz = (heightAt(x, z + d) - heightAt(x, z - d)) / (2 * d);
    maxSlope = Math.max(maxSlope, Math.hypot(gx, gz));
  }
  console.log(`  20000 samples over 60 km: ${lo.toFixed(0)} m to ${hi.toFixed(0)} m, ` +
    `steepest slope ${(Math.atan(maxSlope) * 180 / Math.PI).toFixed(0)} deg`);
  ok('finite everywhere sampled', bad === 0);
  ok('has water below sea level and peaks above 300 m', lo < 0 && hi > 300,
    `${lo.toFixed(0)} .. ${hi.toFixed(0)}`);
  ok('still flyable, not a wall', Math.atan(maxSlope) * 180 / Math.PI < 75);
}

// ---------------------------------------------------------------------------
console.log('\n--- 2. the fine detail is not directional ---');
// ---------------------------------------------------------------------------
{
  // The rejected first field was sum of sin(x*a)*cos(z*b). It is SEPARABLE, and worse, every
  // octave had b/a near 1 — and sin(A)cos(B) = (sin(A+B) + sin(A-B))/2, so with A and B nearly
  // equal each octave is ONE diagonal plane wave plus a long beat. All four ran as near-parallel
  // corrugations.
  //
  // Measured by binning HIGH-PASSED slope direction into 36 bins. High-passing matters: the raw
  // slope is dominated by the 7 km landform waves and scores both fields alike.
  // Directional-energy anisotropy: mean squared SECOND directional difference along each of 36
  // compass directions. The second difference is the high pass — measuring plain slope lets the
  // 7 km landform terms dominate and hides the fine corrugation entirely, and that version scored
  // both fields at 2.4x and proved nothing.
  function anisotropy(fn, step) {
    const N = 36, energy = new Array(N).fill(0);
    for (let s = 0; s < 3000; s++) {
      const x = (rnd() - 0.5) * 30000, z = (rnd() - 0.5) * 30000;
      const h0 = fn(x, z);
      for (let a = 0; a < N; a++) {
        const th = (a / N) * Math.PI;    // 0..180; a direction and its opposite are the same wave
        const dx = Math.cos(th) * step, dz = Math.sin(th) * step;
        const d2 = (fn(x + dx, z + dz) - 2 * h0 + fn(x - dx, z - dz)) / (step * step);
        energy[a] += d2 * d2;
      }
    }
    const lo = Math.min(...energy), hi = Math.max(...energy);
    return { ratio: hi / lo, peakDeg: (energy.indexOf(hi) / N) * 180 };
  }

  // the field that was rejected, kept verbatim so the comparison stays honest
  const oldHeight = (x, z) => {
    const a = Math.sin(x * TS * 1.00 + 0.4) * Math.cos(z * TS * 0.87 - 1.1) * 210;
    const b = Math.sin(x * TS * 2.13 - 2.2) * Math.cos(z * TS * 1.91 + 0.7) * 96;
    const c = Math.sin(x * TS * 4.70 + 1.7) * Math.cos(z * TS * 5.30 - 0.3) * 34;
    const d = Math.sin(x * TS * 9.10 - 0.9) * Math.cos(z * TS * 8.40 + 2.4) * 12;
    const r = 1 - Math.abs(Math.sin(x * TS * 0.60 + z * TS * 0.40 + 0.6));
    return a + b + c + d + r * r * 300 - 40;
  };

  const before = anisotropy(oldHeight, 60);
  const after = anisotropy((x, z) => heightAt(x, z), 60);
  console.log(`  fine-detail direction energy: rejected field ${before.ratio.toFixed(1)}x ` +
    `(peak at ${before.peakDeg.toFixed(0)} deg), this field ${after.ratio.toFixed(1)}x ` +
    `(peak at ${after.peakDeg.toFixed(0)} deg)`);
  ok('the fine detail is much less directional', after.ratio < before.ratio * 0.6,
    `${before.ratio.toFixed(1)}x -> ${after.ratio.toFixed(1)}x`);
}

// ---------------------------------------------------------------------------
console.log('\n--- 3. the band limit really does cover every ring ---');
// ---------------------------------------------------------------------------
{
  console.log('  ring   cell     worst samples/wavelength   before   after');
  let worstAfter = Infinity;
  for (let ring = 0; ring < RING_LEVELS; ring++) {
    const span = RING_BASE * Math.pow(2, ring);
    const cell = (2 * span) / RING_N;
    const spacing = spacingAt(span, 0, 0, 0);
    // the shortest wave still carrying weight at this ring's spacing
    let shortest = Infinity, shortestRaw = Infinity;
    for (const w of WAVES) {
      shortestRaw = Math.min(shortestRaw, w.lambda);
      if (waveWeight(w.lambda, spacing) > 0.02) shortest = Math.min(shortest, w.lambda);
    }
    const after = shortest / cell, before = shortestRaw / cell;
    worstAfter = Math.min(worstAfter, after);
    console.log(`   ${ring}    ${cell.toFixed(1).padStart(6)} m ` +
      `${''.padStart(22)}${before.toFixed(1).padStart(6)}   ${after.toFixed(1).padStart(5)}`);
  }
  // Nyquist is 2, but 2 is where a signal becomes representable, not where it looks right: the
  // lattice is roughly 10 px across on screen at any distance, so anything varying over fewer than
  // about 4 cells reads as stipple.
  ok('every ring carries at least 4 samples per wavelength', worstAfter >= 4,
    `worst ${worstAfter.toFixed(1)}`);
  ok('the weight is a function of DISTANCE, so overlapping rings agree by construction',
    spacingAt(1000, 0, 0, 0) === spacingAt(0, 1000, 0, 0));
  ok('full detail is the default, so physics is never band-limited',
    heightAt(1234, -567) === heightAt(1234, -567, 0) && waveWeight(100, 0) === 1);
  ok('spacing is clamped to what the rings actually provide',
    spacingAt(0, 0, 0, 0) === CELL0 && spacingAt(1e9, 0, 0, 0) === CELL_MAX);
}

// ---------------------------------------------------------------------------
console.log('\n--- 4. band-limited and full-detail agree near the camera ---');
// ---------------------------------------------------------------------------
{
  // if they disagreed close in, you would fly over one surface and see another
  let worst = 0;
  for (let i = 0; i < 4000; i++) {
    const a = rnd() * Math.PI * 2, r = rnd() * 400;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    worst = Math.max(worst, Math.abs(heightAt(x, z) - heightAt(x, z, spacingAt(x, z, 0, 0))));
  }
  console.log(`  inside 400 m of the camera the two differ by at most ${worst.toFixed(3)} m`);
  ok('what you fly over and what you see are the same thing near the camera', worst < 0.5,
    `${worst.toFixed(3)} m`);
}

// ---------------------------------------------------------------------------
console.log('\n--- 5. agl is the height above the surface, not above sea level ---');
// ---------------------------------------------------------------------------
{
  const x = 812, z = -1340;
  const h = heightAt(x, z);
  ok('agl subtracts the ground', Math.abs(agl({ x, y: h + 250, z }) - 250) < 1e-9);
  ok('and goes negative underground', agl({ x, y: h - 10, z }) < 0);
}

console.log(`\n${fails === 0 ? 'all checks passed' : fails + ' CHECK(S) FAILED'}`);
process.exit(fails ? 1 : 0);
