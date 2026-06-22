import { grade } from './post-grade.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
const close = (a, b, e = 1e-9) => Math.abs(a - b) < e;

// identity: contrast 1, saturation 1, vignette 0, center
{
  const g = grade([0.3, 0.6, 0.8], 1, 1, 0, [0.5, 0.5]);
  ok(close(g[0], 0.3) && close(g[1], 0.6) && close(g[2], 0.8), 'identity at contrast1/sat1/vig0/center');
}
// saturation 0 → all channels equal the luma (grey)
{
  const rgb = [0.2, 0.8, 0.4];
  const luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const g = grade(rgb, 1, 0, 0, [0.5, 0.5]);
  ok(close(g[0], luma) && close(g[1], luma) && close(g[2], luma), 'saturation 0 → grey at luma');
}
// contrast > 1 pushes away from 0.5
{
  const hi = grade([0.8, 0.8, 0.8], 1.5, 1, 0, [0.5, 0.5])[0];
  const lo = grade([0.2, 0.2, 0.2], 1.5, 1, 0, [0.5, 0.5])[0];
  ok(hi > 0.8 && lo < 0.2, `contrast pushes away from 0.5 (hi ${hi.toFixed(3)}, lo ${lo.toFixed(3)})`);
  ok(close(grade([0.5, 0.5, 0.5], 1.5, 1, 0, [0.5, 0.5])[0], 0.5), 'contrast pivots at 0.5');
}
// vignette darkens edges more than the center
{
  const center = grade([0.7, 0.7, 0.7], 1, 1, 0.8, [0.5, 0.5])[0];
  const corner = grade([0.7, 0.7, 0.7], 1, 1, 0.8, [0.0, 0.0])[0];
  ok(close(center, 0.7) && corner < center, `vignette darkens corner (${corner.toFixed(3)}) not center (${center.toFixed(3)})`);
}

process.exit(fail ? 1 : 0);
