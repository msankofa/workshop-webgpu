import { grade } from './post-grade.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };
const close = (a, b, e = 1e-9) => Math.abs(a - b) < e;

// identity: all params default → input unchanged (center)
{
  const g = grade([0.3, 0.6, 0.8], {}, [0.5, 0.5]);
  ok(close(g[0], 0.3) && close(g[1], 0.6) && close(g[2], 0.8), 'all-default grade is identity');
}
// gain multiplies
ok(close(grade([0.3, 0.3, 0.3], { gain: 2 })[0], 0.6), 'gain scales');
// brightness adds
ok(close(grade([0.3, 0.3, 0.3], { brightness: 0.1 })[0], 0.4), 'brightness offsets');
// contrast pushes away from 0.5
{
  const hi = grade([0.8, 0.8, 0.8], { contrast: 1.5 })[0];
  ok(hi > 0.8 && close(grade([0.18, 0.18, 0.18], { contrast: 1.5 })[0], 0.18), 'contrast pivots at middle grey 0.18');
}
// gamma > 1 brightens mids: pow(0.25, 1/2) = 0.5
ok(close(grade([0.25, 0.25, 0.25], { gamma: 2 })[0], 0.5), 'gamma>1 brightens mids');
// saturation 0 → grey at luma
{
  const rgb = [0.2, 0.8, 0.4];
  const luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const g = grade(rgb, { saturation: 0 });
  ok(close(g[0], luma) && close(g[1], luma) && close(g[2], luma), 'saturation 0 → grey');
}
// temperature warms (R up, B down); tint shifts green
{
  const g = grade([0.5, 0.5, 0.5], { temperature: 1, saturation: 1 });
  ok(g[0] > 0.5 && g[2] < 0.5, 'temperature warms (R↑, B↓)');
  ok(grade([0.5, 0.5, 0.5], { tint: 1 })[1] > 0.5, 'tint shifts green');
}
// vignette darkens corner not center; softness changes the falloff
{
  const center = grade([0.7, 0.7, 0.7], { vignette: 0.8 }, [0.5, 0.5])[0];
  const corner = grade([0.7, 0.7, 0.7], { vignette: 0.8 }, [0.0, 0.0])[0];
  ok(close(center, 0.7) && corner < center, 'vignette darkens corner not center');
  const soft = grade([0.7, 0.7, 0.7], { vignette: 0.8, vignetteSoft: 2 }, [0.35, 0.5])[0];
  const hard = grade([0.7, 0.7, 0.7], { vignette: 0.8, vignetteSoft: 0.5 }, [0.35, 0.5])[0];
  ok(soft > hard, 'higher softness → less darkening away from the very edge');
}

process.exit(fail ? 1 : 0);
