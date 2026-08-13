// test-plants-geometry.mjs
import { buildPlantGeometry, PLANT_PRESETS } from './plants.js';
let fail = 0; const ok = (c, m) => { console.log((c ? 'ok  ' : 'FAIL ') + m); if (!c) fail++; };

function checkGeom(geom, label) {
  ok(!!geom.getAttribute('position'), `${label}: has position attribute`);
  ok(!!geom.getAttribute('normal'), `${label}: has normal attribute`);
  ok(!!geom.getAttribute('color'), `${label}: has color attribute`);
  const posCount = geom.getAttribute('position').count;
  ok(posCount > 0, `${label}: non-empty geometry (${posCount} verts)`);
  ok(posCount % 3 === 0, `${label}: vertex count is a multiple of 3 (all triangles)`);
  ok(!!geom.index && geom.index.count === posCount, `${label}: has a sequential index matching vertex count (required by plants-gpu.js's indirect draw)`);
}

// simple, opposite-arrangement leaves (chickweed shape family)
checkGeom(buildPlantGeometry({ ...PLANT_PRESETS.chickweed, flower: { enabled: false } }), 'chickweed (no flower)');
// complex/whorled compound leaves (cleavers shape family)
checkGeom(buildPlantGeometry({ ...PLANT_PRESETS.cleavers, flower: { enabled: false } }), 'cleavers (no flower)');
// serrated + veined leaves (mint shape family)
checkGeom(buildPlantGeometry({ ...PLANT_PRESETS.mint, flower: { enabled: false } }), 'mint (no flower)');
// alternate arrangement, branching stem (jewelweed shape family)
checkGeom(buildPlantGeometry({ ...PLANT_PRESETS.jewelweed, flower: { enabled: false } }), 'jewelweed (no flower)');

// determinism: same seed -> identical geometry
const a = buildPlantGeometry({ ...PLANT_PRESETS.mint, seed: 42 });
const b = buildPlantGeometry({ ...PLANT_PRESETS.mint, seed: 42 });
ok(JSON.stringify(Array.from(a.getAttribute('position').array)) === JSON.stringify(Array.from(b.getAttribute('position').array)),
  'same seed produces identical geometry');

// schema edge cases the 4 launch presets don't exercise, per the design spec
checkGeom(buildPlantGeometry({ leaf: { leafletParity: 'even', style: 'complex', leafletCount: 6, arrangement: 'whorl' } }), 'even-pinnate compound leaf (schema-only case)');
checkGeom(buildPlantGeometry({ leaf: { variegation: { enabled: true, pattern: 'blotch', color: 0xffffff, amount: 0.6 } } }), 'variegated leaf (schema-only case)');
checkGeom(buildPlantGeometry({ leaf: { shape: 'star' } }), 'star-shaped leaf (schema-only case)');

// flowers enabled (all 4 shapes: star, burPair, whorlBall, pouch)
checkGeom(buildPlantGeometry(PLANT_PRESETS.chickweed), 'chickweed (with star flowers)');
checkGeom(buildPlantGeometry(PLANT_PRESETS.cleavers), 'cleavers (with burPair)');
checkGeom(buildPlantGeometry(PLANT_PRESETS.mint), 'mint (with whorlBall flowers)');
checkGeom(buildPlantGeometry(PLANT_PRESETS.jewelweed), 'jewelweed (with pouch flowers)');

// a plant with flowers has strictly more geometry than the same plant without
const noFlower = buildPlantGeometry({ ...PLANT_PRESETS.mint, seed: 7, flower: { enabled: false } });
const withFlower = buildPlantGeometry({ ...PLANT_PRESETS.mint, seed: 7 });
ok(withFlower.getAttribute('position').count > noFlower.getAttribute('position').count, 'enabling flowers adds geometry');

// Size. Nothing asserted this before, which is why stem height accumulated to 3-4 m unnoticed.
const MAX_DIM = 1.5;   // plants.js' own documented target, grass-comparable
for (const [key, preset] of Object.entries(PLANT_PRESETS)) {
  const g = buildPlantGeometry({ ...preset, seed: 11 });
  const p = g.getAttribute('position');
  let maxY = -Infinity, minY = Infinity, maxR = 0;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i);
    if (y > maxY) maxY = y;
    if (y < minY) minY = y;
    maxR = Math.max(maxR, Math.hypot(p.getX(i), p.getZ(i)));
  }
  ok(maxY - minY <= MAX_DIM, `${key} height ${(maxY - minY).toFixed(2)} <= ${MAX_DIM}`);
  ok(maxR * 2 <= MAX_DIM * 2, `${key} spread ${(maxR * 2).toFixed(2)} is not runaway`);
}

// Colour. Vertex colours are linear; authored sRGB decodes DARKER, so an undecoded file fails this.
const mintGeom = buildPlantGeometry({ ...PLANT_PRESETS.mint, seed: 11 });
const mc = mintGeom.getAttribute('color');
let maxChan = 0;
for (let i = 0; i < mc.count; i++) maxChan = Math.max(maxChan, mc.getX(i), mc.getY(i), mc.getZ(i));
ok(maxChan <= 0.55, `mint's brightest linear channel ${maxChan.toFixed(3)} is decoded, not raw sRGB`);

console.log(fail ? fail + ' FAIL' : 'ALL PASS'); process.exit(fail ? 1 : 0);
