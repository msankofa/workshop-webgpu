// test-moss-tint.mjs — the shared mossWeight() dressing law (CPU twin moss-tint-ref.js).
// Asserts: monotone in moisture, gated by upness, bounded 0..1, zero on desert-dry input.
import { mossWeight, M0, M1, U0, U1 } from './moss-tint-ref.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };

// bounded 0..1 across a grid of inputs
{
  let allBounded = true;
  for (const mo of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
    for (const up of [0, 0.3, 0.5, 0.7, 1]) {
      for (const cav of [0, 0.5, 1]) {
        for (const bn of [0, 0.5, 1]) {
          const w = mossWeight(mo, up, cav, bn);
          if (!(w >= 0 && w <= 1)) allBounded = false;
        }
      }
    }
  }
  ok(allBounded, 'mossWeight bounded to [0,1] over the input grid');
}

// monotone non-decreasing in moisture (wet-facing surface, full cavity/noise)
{
  let mono = true;
  let prev = -1;
  for (let mo = 0; mo <= 1.0001; mo += 0.05) {
    const w = mossWeight(mo, 1, 1, 1);
    if (w < prev - 1e-12) mono = false;
    prev = w;
  }
  ok(mono, 'mossWeight monotone non-decreasing in moisture');
}

// monotone non-decreasing in upness (fully wet)
{
  let mono = true;
  let prev = -1;
  for (let up = 0; up <= 1.0001; up += 0.05) {
    const w = mossWeight(1, up, 1, 1);
    if (w < prev - 1e-12) mono = false;
    prev = w;
  }
  ok(mono, 'mossWeight monotone non-decreasing in upness');
}

// gated by upness: a steep surface (below U0) gets zero moss even when soaking wet
ok(mossWeight(1, U0 - 0.01, 1, 1) === 0, 'upness below ramp start → zero (steep gate)');
ok(mossWeight(1, 1, 1, 1) > 0.5, 'wet + flat + sheltered → strong moss');

// desert-dry (moisture below M0) → zero regardless of orientation
ok(mossWeight(M0 - 0.01, 1, 1, 1) === 0, 'moisture below ramp start → zero (dry gate)');
ok(mossWeight(0, 1, 1, 1) === 0, 'bone-dry desert input → zero moss');

// dry AND steep → zero (the SurfaceField "dry+steep" acceptance case)
ok(mossWeight(0.05, 0.1, 0.5, 1) === 0, 'dry + steep → zero moss weight');

// cavity boosts (sheltered nook collects more than an exposed face)
ok(mossWeight(1, 1, 1, 1) > mossWeight(1, 1, 0, 1), 'cavity/AO increases moss');
// brushNoise attenuates
ok(mossWeight(1, 1, 1, 0.5) < mossWeight(1, 1, 1, 1), 'brushNoise attenuates moss');
ok(mossWeight(1, 1, 1, 0) === 0, 'zero brushNoise → zero moss');

// ramp ordering sanity
ok(M0 < M1 && U0 < U1, 'moisture/upness ramp edges ordered');

process.exit(fail ? 1 : 0);
