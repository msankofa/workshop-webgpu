// Orthographic silhouettes of the built model as PGM masks (top, front, side) at a fixed metres-per-pixel,
// so compare_views.py can score them against the drawing. No GPU: triangles are scanned on the CPU.
import * as THREE from 'file:///C:/Users/msankofa/.claude/tools/node_modules/three/build/three.module.js';
import { writeFileSync } from 'node:fs';
globalThis.document = { createElementNS: () => ({ addEventListener() {}, style: {}, set src(_v) {} }) };
const { createRQ170SentinelModel } = await import('./factory.mjs');
const model = createRQ170SentinelModel({});
model.updateMatrixWorld(true);

const skip = new Set((process.argv[2] || '').split(',').filter(Boolean));   // e.g. gear part names to hide
const tris = [];
model.traverse((o) => {
  if (!o.isMesh || [...skip].some((s) => o.name.toLowerCase().includes(s))) return;
  const g = o.geometry, p = g.attributes.position, idx = g.index;
  const n = idx ? idx.count : p.count;
  const v = (i) => new THREE.Vector3().fromBufferAttribute(p, idx ? idx.getX(i) : i).applyMatrix4(o.matrixWorld);
  for (let i = 0; i < n; i += 3) tris.push([v(i), v(i + 1), v(i + 2)]);
});

const MPP = 0.05;   // metres per pixel
// view: [horizontal axis, vertical axis, flipV]  (image row 0 at the top)
const VIEWS = {
  top: { h: 'x', v: 'z', flipH: false, flipV: false },   // nose (-z) at the top of the image
  front: { h: 'x', v: 'y', flipH: false, flipV: true },
  side: { h: 'z', v: 'y', flipH: false, flipV: true },   // nose at the left
};
function raster(name) {
  const { h, v, flipH, flipV } = VIEWS[name];
  let minH = Infinity, maxH = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const t of tris) for (const p of t) { minH = Math.min(minH, p[h]); maxH = Math.max(maxH, p[h]); minV = Math.min(minV, p[v]); maxV = Math.max(maxV, p[v]); }
  const pad = 0.2; minH -= pad; maxH += pad; minV -= pad; maxV += pad;
  const W = Math.ceil((maxH - minH) / MPP), H = Math.ceil((maxV - minV) / MPP);
  const img = new Uint8Array(W * H);
  const px = (p) => [(flipH ? maxH - p[h] : p[h] - minH) / MPP, (flipV ? maxV - p[v] : p[v] - minV) / MPP];
  for (const t of tris) {
    const [a, b, c] = t.map(px);
    const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
    const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
    if (Math.abs(area) < 1e-9) continue;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const qx = x + 0.5, qy = y + 0.5;
      const w0 = ((b[0] - qx) * (c[1] - qy) - (c[0] - qx) * (b[1] - qy)) / area;
      const w1 = ((c[0] - qx) * (a[1] - qy) - (a[0] - qx) * (c[1] - qy)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 >= -1e-6 && w1 >= -1e-6 && w2 >= -1e-6) img[y * W + x] = 255;
    }
  }
  writeFileSync(`meas/model-${name}.pgm`, Buffer.concat([Buffer.from(`P5\n${W} ${H}\n255\n`), Buffer.from(img)]));
  writeFileSync(`meas/model-${name}.json`, JSON.stringify({ minH, maxH, minV, maxV, mpp: MPP, W, H }));
  // coarse ASCII preview
  const step = Math.max(1, Math.round(W / 100));
  const rows = [];
  for (let y = 0; y < H; y += step * 2) {
    let s = '';
    for (let x = 0; x < W; x += step) s += img[y * W + x] ? '#' : '.';
    rows.push(s);
  }
  console.log(`== ${name} ${W}x${H} @${MPP} m/px  h[${minH.toFixed(2)},${maxH.toFixed(2)}] v[${minV.toFixed(2)},${maxV.toFixed(2)}]`);
  console.log(rows.join('\n'));
}
for (const name of Object.keys(VIEWS)) raster(name);
