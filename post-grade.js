// post-grade.js
// Pure-JS color-grade reference for SP4c — the math transcribed into the TSL grade node in
// post-fx.js, Node-tested here. Order: contrast (pivot 0.5) → saturation (luma-based) → vignette.

const LUMA = [0.2126, 0.7152, 0.0722];

export function grade(rgb, contrast, saturation, vignette, uv = [0.5, 0.5]) {
  // contrast about a 0.5 pivot
  let r = (rgb[0] - 0.5) * contrast + 0.5;
  let g = (rgb[1] - 0.5) * contrast + 0.5;
  let b = (rgb[2] - 0.5) * contrast + 0.5;
  // saturation: blend toward luma
  const luma = LUMA[0] * r + LUMA[1] * g + LUMA[2] * b;
  r = luma + (r - luma) * saturation;
  g = luma + (g - luma) * saturation;
  b = luma + (b - luma) * saturation;
  // vignette: radial darkening from center (uv in [0,1]); 0 at center, grows to edges
  const dx = (uv[0] - 0.5) * 2, dy = (uv[1] - 0.5) * 2;
  const d = Math.min(1, Math.sqrt(dx * dx + dy * dy));
  const t = d * d;                      // smooth-ish falloff
  const vig = 1 - vignette * t;
  return [r * vig, g * vig, b * vig];
}
