// post-grade.js
// Pure-JS color-grade reference for SP4c — math transcribed into the TSL grade node in
// post-fx.js, Node-tested here. Full grade chain (all params default to a no-op identity):
//   gain → brightness → contrast(pivot 0.5) → gamma → white balance(temp/tint) → saturation → vignette

const LUMA = [0.2126, 0.7152, 0.0722];

export function grade(rgb, p = {}, uv = [0.5, 0.5]) {
  const {
    brightness = 0, contrast = 1, gamma = 1, gain = 1, saturation = 1,
    temperature = 0, tint = 0, vignette = 0, vignetteSoft = 1,
  } = p;
  let r = rgb[0] * gain + brightness;
  let g = rgb[1] * gain + brightness;
  let b = rgb[2] * gain + brightness;
  // contrast about a 0.5 pivot
  r = (r - 0.5) * contrast + 0.5; g = (g - 0.5) * contrast + 0.5; b = (b - 0.5) * contrast + 0.5;
  // gamma (>1 brightens mids); clamp to non-negative before pow
  const ig = 1 / Math.max(1e-4, gamma);
  r = Math.pow(Math.max(0, r), ig); g = Math.pow(Math.max(0, g), ig); b = Math.pow(Math.max(0, b), ig);
  // white balance: temperature warms (+R, -B), tint shifts green/magenta (+G)
  r += temperature * 0.1; b -= temperature * 0.1; g += tint * 0.1;
  // saturation: blend toward luma
  const luma = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
  r = luma + (r - luma) * saturation; g = luma + (g - luma) * saturation; b = luma + (b - luma) * saturation;
  // vignette: radial darkening; softness raises the falloff power (higher = edge-concentrated)
  const dx = (uv[0] - 0.5) * 2, dy = (uv[1] - 0.5) * 2;
  const d = Math.min(1, Math.sqrt(dx * dx + dy * dy));
  const t = Math.pow(d, Math.max(0.1, vignetteSoft) * 2);
  const vig = 1 - vignette * t;
  return [r * vig, g * vig, b * vig];
}
