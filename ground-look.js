// ground-look.js — macro variation for terrain shaded by height and slope.
//
// The flight sim used to mix four flat colours on smoothstep(height) and smoothstep(slope). From a
// cockpit that reads as wrong immediately, and the reason is specific: a threshold on height alone
// draws a perfect elevation CONTOUR. Real snowlines and treelines wander, because what grows where
// depends on aspect, shelter and soil, not on altitude alone. So the biggest single win here is not
// adding detail — it is making the existing lines ragged.
//
// Three things, in the order they matter from 2 km up:
//   1. the material lines wander (edgeJitter / slopeJitter) instead of following contours
//   2. large colour patches drift the palette (tint / patch) so no two square kilometres match
//   3. rock faces get horizontal strata, which is what gives a cliff its scale
//
// Detail texture is deliberately NOT here. At cruise altitude it is below a pixel; it belongs on
// the near clipmap rings only, which is a separate job. See docs/subsystems/flight.md.
//
// THE LAW IS TWINNED, THE NOISE IS NOT. `groundColorRef` below is the exact arithmetic the TSL
// runs, taking the three noise values as arguments rather than generating them — MaterialX fractal
// noise has no practical JS reimplementation, but the part that actually goes wrong is the ordering
// and clamping of the palette, and that is fully testable. Same arrangement as moss-tint.js.

export const GROUND_LOOK_VERSION = 1;
export const GROUND_LOOK_PATH = 'ground-look.json';

export const GROUND_LOOK_DEFAULTS = Object.freeze({
  enabled: 1,

  // the base rule, unchanged from the flat version so noise 0 reproduces it exactly
  grassLo: 4, grassHi: 55,
  rockLo: 0.30, rockHi: 0.62,
  snowLo: 380, snowHi: 520,
  snowFlatLo: 0.34, snowFlatHi: 0.62,

  // 1. wandering lines
  edgeJitter: 46,      // metres the grass and snow lines rise and fall
  edgeScale: 300,      // metres per wander feature
  slopeJitter: 0.09,   // how far the rock line moves in slope units
  edgeOctaves: 3,

  // 2. colour drift
  tintAmount: 0.30,    // how far the palette pulls toward `dry`
  tintScale: 820,
  tintOctaves: 4,
  patchAmount: 0.18,   // broad light and dark, as a multiplier
  patchScale: 3200,
  patchOctaves: 2,

  // 3. rock strata
  strataAmount: 0.16,
  strataPeriod: 34,    // metres between bands

  sand: [0.60, 0.55, 0.40],
  grass: [0.24, 0.34, 0.19],
  rock: [0.34, 0.33, 0.31],
  snow: [0.86, 0.88, 0.92],
  dry: [0.44, 0.41, 0.25],
});

export function groundLookFrom(partial = {}) {
  const out = { ...GROUND_LOOK_DEFAULTS, ...partial };
  for (const k of ['sand', 'grass', 'rock', 'snow', 'dry']) {
    out[k] = Array.isArray(partial[k]) && partial[k].length === 3 ? partial[k].slice() : GROUND_LOOK_DEFAULTS[k].slice();
  }
  return out;
}

// Numeric keys a slider may drive, with [min, max, step]. Colours are edited in the file.
export const GROUND_LOOK_RANGE = Object.freeze({
  edgeJitter: [0, 140, 1],
  edgeScale: [60, 1600, 10],
  slopeJitter: [0, 0.3, 0.005],
  tintAmount: [0, 0.9, 0.01],
  tintScale: [120, 3000, 20],
  patchAmount: [0, 0.6, 0.01],
  patchScale: [400, 9000, 50],
  strataAmount: [0, 0.5, 0.01],
  strataPeriod: [6, 160, 1],
  grassHi: [10, 300, 1],
  snowLo: [80, 900, 5],
  rockLo: [0, 0.9, 0.01],
});

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0 || 1e-9));
  return t * t * (3 - 2 * t);
}
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// The shading law. n1/n2/n3 are signed noise, nominally [-1, 1]: n1 wanders the lines, n2 drifts
// hue, n3 drifts value. Pass all three as 0 and this is the original four-colour ramp exactly,
// which is the property the test pins — a "look" that cannot be turned off is a rewrite, not a layer.
export function groundColorRef(cfg, h, slope, n1, n2, n3) {
  if (!cfg.enabled) n1 = n2 = n3 = 0;
  const hJ = h + n1 * cfg.edgeJitter;
  const slopeJ = slope + n1 * cfg.slopeJitter;

  let c = mix3(cfg.sand, cfg.grass, smoothstep(cfg.grassLo, cfg.grassHi, hJ));

  // Hue drift: dry patches where the noise runs high. The ramp starts AT zero, not below it, so
  // noise 0 means no tint — a symmetric ramp reads as "centred" but smoothstep(-0.6, 0.9, 0) is
  // 0.216, which tinted everything by default and broke the layer-not-rewrite property.
  c = mix3(c, cfg.dry, smoothstep(0, 0.7, n2) * cfg.tintAmount);
  // value drift: broad light and dark
  const v = 1 + n3 * cfg.patchAmount;
  c = [c[0] * v, c[1] * v, c[2] * v];

  const rockW = smoothstep(cfg.rockLo, cfg.rockHi, slopeJ);
  c = mix3(c, cfg.rock, rockW);

  // Strata darken bands on rock faces only, so flat ground is not striped. Driven by height rather
  // than noise, so `enabled` has to silence it explicitly — zeroing the noise inputs does not.
  const strataAmount = cfg.enabled ? cfg.strataAmount : 0;
  const band = 0.5 - 0.5 * Math.cos((h * 2 * Math.PI) / (cfg.strataPeriod || 1));
  c = c.map((x) => x * (1 - band * strataAmount * rockW));

  const snowW = smoothstep(cfg.snowLo, cfg.snowHi, hJ) * (1 - smoothstep(cfg.snowFlatLo, cfg.snowFlatHi, slopeJ));
  c = mix3(c, cfg.snow, snowW);

  return c.map(clamp01);
}

// The GPU half. Imports TSL lazily so Node can use everything above without three.js — the tests,
// and anything that only wants the law. Returns live uniforms so a slider retunes without rebuilding
// the node graph; only `enabled` and the octave counts are baked in, being graph shape rather than
// values.
export async function createGroundLookNodes(cfg) {
  const { Fn, uniform, vec3, float, mix, clamp, smoothstep, cos, oneMinus, mx_fractal_noise_float } =
    await import('three/tsl');

  const num = (k) => uniform(cfg[k]);
  const col = (k) => uniform(vec3(...cfg[k]));
  const u = {};
  for (const k of Object.keys(GROUND_LOOK_RANGE)) u[k] = num(k);
  for (const k of ['grassLo', 'rockHi', 'snowHi', 'snowFlatLo', 'snowFlatHi']) u[k] = num(k);
  for (const k of ['sand', 'grass', 'rock', 'snow', 'dry']) u[k] = col(k);

  // Three decorrelated fields. The offsets keep the wander, the hue drift and the value drift from
  // sharing features — without them every dry patch would sit exactly on a snowline kink.
  const color = Fn(([worldPos, normalY]) => {
    const h = worldPos.y;
    const slope = oneMinus(clamp(normalY, 0, 1));
    const xz = worldPos.xz;

    const n1 = cfg.enabled
      ? mx_fractal_noise_float(xz.div(u.edgeScale).add(11.3), cfg.edgeOctaves, 2.0, 0.5, 1.0)
      : float(0);
    const n2 = cfg.enabled
      ? mx_fractal_noise_float(xz.div(u.tintScale).sub(41.7), cfg.tintOctaves, 2.0, 0.5, 1.0)
      : float(0);
    const n3 = cfg.enabled
      ? mx_fractal_noise_float(xz.div(u.patchScale).add(97.1), cfg.patchOctaves, 2.0, 0.5, 1.0)
      : float(0);

    const hJ = h.add(n1.mul(u.edgeJitter));
    const slopeJ = slope.add(n1.mul(u.slopeJitter));

    let c = mix(u.sand, u.grass, smoothstep(u.grassLo, u.grassHi, hJ));
    c = mix(c, u.dry, smoothstep(0, 0.7, n2).mul(u.tintAmount));
    c = c.mul(float(1).add(n3.mul(u.patchAmount)));

    const rockW = smoothstep(u.rockLo, u.rockHi, slopeJ);
    c = mix(c, u.rock, rockW);

    if (cfg.enabled) {
      const band = float(0.5).sub(cos(h.mul(2 * Math.PI).div(u.strataPeriod)).mul(0.5));
      c = c.mul(float(1).sub(band.mul(u.strataAmount).mul(rockW)));
    }

    const snowW = smoothstep(u.snowLo, u.snowHi, hJ).mul(oneMinus(smoothstep(u.snowFlatLo, u.snowFlatHi, slopeJ)));
    c = mix(c, u.snow, snowW);
    return clamp(c, 0, 1);
  });

  return {
    color,
    uniforms: u,
    // Push a changed config into the live uniforms. Numbers only: a colour or an octave count
    // changes the graph, so those need a reload, and saying so beats a slider that does nothing.
    set(next) {
      for (const k of Object.keys(u)) if (typeof next[k] === 'number' && typeof u[k].value === 'number') u[k].value = next[k];
    },
  };
}

export async function loadGroundLook(base = '') {
  const res = await fetch(`${base}${GROUND_LOOK_PATH}?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const cfg = await res.json();
  if (cfg.version !== GROUND_LOOK_VERSION) {
    console.warn(`ground-look.json is version ${cfg.version}, this build expects ${GROUND_LOOK_VERSION}`);
  }
  return groundLookFrom(cfg);
}

export async function saveGroundLook(cfg, base = '') {
  const res = await fetch(`${base}api/save-ground-look`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: GROUND_LOOK_VERSION, ...cfg }, null, 2),
  });
  const out = await res.json().catch(() => ({ ok: false, error: `${res.status} ${res.statusText}` }));
  if (!out.ok) throw new Error(out.error || 'save failed');
  return out.path;
}
