// test-blood-tuning.mjs — the shared blood FX numbers bot-viewer-v3 and damage-simulator both use.
// Run: node test-blood-tuning.mjs

import { BLOOD_BASE, BLOOD_TUNING, sprayParams, stainParams, splatterParams, stumpParams } from './blood-tuning.js';

let failures = 0;
const check = (name, actual, expected) => {
  const ok = Math.abs(actual - expected) < 1e-9 || Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
};
const checkTrue = (name, cond, detail = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` -- ${detail}`}`);
};

// A full-health-ramp intensity, matching bloodIntensityForHealth(0).
const I = { sprayCount: 28, spraySpeed: 4.2, spraySpread: 1.0, splatterCount: 10, splatterOpacity: 0.8 };

// ---- 1. defaults reproduce the numbers that shipped inline ----
{
  const s = sprayParams(I, BLOOD_TUNING, BLOOD_BASE);
  check('spray: count is the intensity unchanged', s.count, 28);
  check('spray: droplet size', s.size, 0.03);
  check('spray: speed', s.speed, 4.2);
  check('spray: life', s.life, 0.6);
  const sp = splatterParams(I, BLOOD_TUNING, BLOOD_BASE);
  check('splatter: count', sp.count, 10);
  check('splatter: size', sp.size, 0.12);
  check('splatter: opacity comes from the ramp, not the base', sp.opacity, 0.8);
  check('splatter: outlives the body stain by a third', sp.life, 6 * 1.33);
  const st = stumpParams(BLOOD_TUNING, BLOOD_BASE);
  check('stump: spray count', st.spray.count, 34);
  check('stump: splatter size', st.splatter.size, 0.14);
}

// ---- 2. stain sizing ----
{
  check('stain: no part width falls back to the fixed size', stainParams(0).size, 0.15);
  check('stain: a part width fits to it', stainParams(0.2).size, 0.11);
  check('stain: a thin part clamps at the minimum', stainParams(0.01).size, 0.03);
  check('stain: a wide part clamps at the maximum', stainParams(9).size, 0.16);
  check('stain: opacity is the base', stainParams(0).opacity, 0.92);
}

// ---- 3. the multipliers ----
{
  const t = { ...BLOOD_TUNING, amount: 2, force: 0.5, sprayLife: 1.5, decalLife: 12, stainSize: 3 };
  const s = sprayParams(I, t);
  check('amount doubles the droplet count', s.count, 56);
  check('force halves the speed', s.speed, 2.1);
  check('force halves the spread', s.spread, 0.5);
  check('spray life is taken directly', s.life, 1.5);
  check('stain size scales the decal', stainParams(0, t).size, 0.45);
  check('decal life is taken directly', stainParams(0, t).life, 12);
  const sp = splatterParams(I, t);
  check('stain size scales ground splatter too', sp.size, 0.36);
  check('splatter life follows decal life', sp.life, 12 * 1.33);
}

// ---- 4. zero amount removes the burst rather than emitting an empty one ----
{
  const t = { ...BLOOD_TUNING, amount: 0 };
  checkTrue('amount 0 drops the spray', sprayParams(I, t) === null);
  checkTrue('amount 0 drops the splatter', splatterParams(I, t) === null);
  checkTrue('amount 0 keeps the stain', stainParams(0, t) !== null);
}

// ---- 5. a partial base overrides only what it names ----
{
  const base = { spraySize: 0.09 };
  const s = sprayParams(I, BLOOD_TUNING, base);
  check('a named base field is used', s.size, 0.09);
  check('an unnamed one falls back to the default', s.gravity, 9.8);
  checkTrue('an empty tuning is the defaults', sprayParams(I).count === 28);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
