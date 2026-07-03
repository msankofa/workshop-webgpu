// test-grass-blade-uv.mjs
import { buildBladeGeometry } from './grass.js';
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok  ' : 'FAIL ') + m); if (!c) fail++; };

const geom = buildBladeGeometry();
const uv = geom.getAttribute('aBladeUV');
ok(!!uv, 'geometry has an aBladeUV attribute');
ok(uv.itemSize === 2, 'aBladeUV is a vec2');
ok(uv.count === 5, 'one aBladeUV per blade vertex (BL,BR,TR,TL,TC)');
// [BL, BR, TR, TL, TC] per grass.js's fixed vertex order
const expected = [0,0, 1,0, 0.75,0.85, 0.25,0.85, 0.5,1];
let matches = true;
for (let i = 0; i < 10; i++) if (Math.abs(uv.array[i] - expected[i]) > 1e-6) matches = false;
ok(matches, 'aBladeUV matches the taper: BL(0,0) BR(1,0) TR(.75,.85) TL(.25,.85) TC(.5,1)');

console.log(fail ? fail + ' FAIL' : 'ALL PASS'); process.exit(fail ? 1 : 0);
