// Quantise the view cone in grass-compute.js and plants-gpu.js. Run from the repo root.
const fs = require('fs');
const rx = (a) => new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\r?\n/g, '\\r?\\n'));
for (const file of ['grass-compute.js', 'plants-gpu.js']) {
  let s = fs.readFileSync(file, 'utf8');
  const a = `    const half = Math.min(Math.PI, Math.atan(Math.tan(halfH) / denom) + 0.22);
    return { fx: _dir.x / hl, fz: _dir.z / hl, cos: Math.cos(half) };`;
  const r = rx(a);
  if (!r.test(s)) throw new Error(file + ' cone tail missing');
  s = s.replace(r, () => `    // Quantised so a turning camera re-culls every ~6 degrees, not every frame: the 0.22 rad
    // margin above is wider than one step, so the cone stays conservative between reculls.
    const STEP = 0.1;
    const half = Math.min(Math.PI, Math.ceil((Math.atan(Math.tan(halfH) / denom) + 0.22) / STEP) * STEP);
    const yaw = Math.round(Math.atan2(_dir.z, _dir.x) / STEP) * STEP;
    return { fx: Math.cos(yaw), fz: Math.sin(yaw), cos: Math.cos(half) };`);
  fs.writeFileSync(file, s);
}
console.log('quantised');
