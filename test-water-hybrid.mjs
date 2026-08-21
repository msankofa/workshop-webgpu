// Node checks for water-hybrid.js — the water shading shared by demos/water-demo.html and
// demos/flight-sim.html. Only the CPU-side parts run here: profiles, presets, the uploaded wave
// table and the radial grid topology. The TSL node graphs need a GPU and are not exercised.
import { uniform } from 'three/tsl';
import {
  makeWaterProfile, rebuildWaveTable, applyWaterPreset, WATER_PRESETS, makeRadialGrid, MAX_WAVES,
} from './water-hybrid.js';
import { buildWaveTable } from './water-waves.js';

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m); } else console.log('ok  ', m); };

const uTime = uniform(0), uWind = uniform([1, 0]);
const mk = (o) => makeWaterProfile({ uTime, uWind, ...o });

// Profile construction and the uTime/uWind contract.
let threw = false;
try { makeWaterProfile({}); } catch { threw = true; }
ok(threw, 'makeWaterProfile refuses to build without uTime and uWind');
const p = mk({ name: 'ocean' });
ok(p.name === 'ocean' && p.waveA.array.length === MAX_WAVES, 'profile has a full-length wave array');

// The uploaded table matches what water-waves.js builds from the same settings.
const ref = buildWaveTable(p.wave);
ok(p.count.value === ref.count, 'uploaded wave count matches the table');
let sameRows = true;
for (let i = 0; i < ref.count; i++) {
  const A = p.waveA.array[i], B = p.waveB.array[i];
  sameRows &&= A.x === ref.a[i * 4] && A.y === ref.a[i * 4 + 1] && A.z === ref.a[i * 4 + 2] && A.w === ref.a[i * 4 + 3];
  sameRows &&= B.x === ref.b[i * 4] && B.y === ref.b[i * 4 + 1] && B.z === ref.b[i * 4 + 2];
}
ok(sameRows, 'every uploaded row equals the CPU twin row (GPU and buoyancy read one table)');
// Rows past the count are zeroed, so a shrink cannot leave a stale wave running.
p.wave.count = 4; rebuildWaveTable(p);
ok(p.count.value === 4, 'count follows a shrink');
let tailZero = true;
for (let i = 4; i < MAX_WAVES; i++) tailZero &&= p.waveA.array[i].lengthSq() === 0 && p.waveB.array[i].lengthSq() === 0;
ok(tailZero, 'rows beyond the count are zeroed on rebuild');

// Presets.
ok(Object.keys(WATER_PRESETS).join(',') === 'waterjs,ocean,hybrid', 'three presets are exported');
applyWaterPreset(p, 'waterjs');
ok(p.waveModel.value === 0 && p.disp.value === 0 && p.colorLaw.value === 0 && p.specPow.value === 80,
  'water.js preset is flat 3-sine, linear depth mix, Phong 80');
applyWaterPreset(p, 'ocean');
ok(p.waveModel.value === 1 && p.disp.value === 1 && p.colorLaw.value === 1 && p.specModel.value === 1
  && p.count.value === 26 && p.foamShoreStr.value > 0,
  'ocean preset is Gerstner 26, Beer-Lambert, GGX, foam on');
applyWaterPreset(p, 'hybrid');
ok(p.waveModel.value === 1 && p.count.value === 20 && p.reflMode.value === 1 && p.colorLaw.value === 1,
  'hybrid preset is Gerstner 20 with planar reflection and Beer-Lambert');
// Switching presets must not leave the previous preset's wave settings behind.
applyWaterPreset(p, 'waterjs'); applyWaterPreset(p, 'hybrid');
ok(p.wave.baseLength === WATER_PRESETS.hybrid.wave.baseLength && p.wave.chop === WATER_PRESETS.hybrid.wave.chop,
  'preset switch resets wave settings rather than merging them');
threw = false;
try { applyWaterPreset(p, 'nope'); } catch { threw = true; }
ok(threw, 'an unknown preset name throws');

// Radial grid topology.
const rings = 12, spokes = 16;
const g = makeRadialGrid({ rings, spokes, r0: 2, r1: 1000 });
const vcount = g.attributes.position.count, icount = g.index.count;
ok(vcount === 1 + rings * spokes, `vertex count is hub + rings*spokes (${vcount})`);
ok(icount === (spokes + (rings - 1) * spokes * 2) * 3, `triangle count closes the hub and every ring band (${icount / 3} tris)`);
const idx = g.index.array;
let inRange = true, degenerate = 0;
for (let i = 0; i < idx.length; i += 3) {
  for (let k = 0; k < 3; k++) inRange &&= idx[i + k] >= 0 && idx[i + k] < vcount;
  if (idx[i] === idx[i + 1] || idx[i + 1] === idx[i + 2] || idx[i] === idx[i + 2]) degenerate++;
}
ok(inRange, 'every index is in range');
ok(degenerate === 0, 'no degenerate triangles');
// Every vertex is referenced, so the seam at angle 0 wraps instead of leaving a gap.
const used = new Set(idx);
ok(used.size === vcount, 'every vertex is used, so the angular seam wraps');
// Radii grow geometrically from r0 to r1 and cells are fine near the middle.
const pos = g.attributes.position.array;
const rAt = (i, j) => Math.hypot(pos[(1 + i * spokes + j) * 3], pos[(1 + i * spokes + j) * 3 + 2]);
ok(Math.abs(rAt(0, 0) - 2) < 1e-4 && Math.abs(rAt(rings - 1, 0) - 1000) < 1e-2, 'inner and outer radii are exact');
ok(rAt(1, 0) / rAt(0, 0) - rAt(5, 0) / rAt(4, 0) < 1e-6, 'radius growth is geometric');
ok(g.boundingSphere.radius > 1000, 'bounding sphere covers the grid');

// --- water-config.json round trip: the demo writes it, the flight sim reads it ---
import {
  serializeWaterProfile, applyWaterProfileConfig, serializeWaterConfig, applyWaterConfig,
  WATER_CONFIG_VERSION,
} from './water-hybrid.js';
import { readFileSync } from 'node:fs';

const src = mk({ name: 'ocean' });
applyWaterPreset(src, 'ocean');
src.wave.count = 11; src.wave.baseAmp = 2.3; rebuildWaveTable(src);
src.depthScale.value = 31.5; src.clarity.value = 2.25; src.foamShoreDepth.value = 7;
src.shallow.value.setHex(0x123456); src.absorb.value.set(0.7, 0.2, 0.05);

const dst = mk({ name: 'ocean' });
applyWaterPreset(dst, 'waterjs');
applyWaterProfileConfig(dst, JSON.parse(JSON.stringify(serializeWaterProfile(src))));
ok(dst.depthScale.value === 31.5 && dst.clarity.value === 2.25 && dst.foamShoreDepth.value === 7,
  'scalar uniforms survive the round trip');
ok(dst.shallow.value.getHex() === 0x123456, 'colours survive the round trip');
ok(dst.absorb.value.x === 0.7 && dst.absorb.value.z === 0.05, 'vector uniforms survive the round trip');
ok(dst.wave.count === 11 && dst.wave.baseAmp === 2.3 && dst.waveModel.value === 1,
  'wave settings and the wave model survive the round trip');
ok(dst.count.value === 11 && dst.waveA.array[10].lengthSq() > 0 && dst.waveA.array[11].lengthSq() === 0,
  'the table is rebuilt to the loaded count, so the shader never reads rows that were not uploaded');
// A config claiming more waves than it rebuilt must not be believed.
const lying = serializeWaterProfile(src); lying.u.count = 39;
applyWaterProfileConfig(dst, lying);
ok(dst.count.value === 11, 'a count in the file cannot outrun the table that was actually built');

const two = serializeWaterConfig({ ocean: src, lake: mk({ name: 'lake' }) }, { savedAt: 'x' });
ok(two.version === WATER_CONFIG_VERSION && two.savedAt === 'x'
  && Object.keys(two.bodies).join(',') === 'ocean,lake', 'the config holds one entry per body');
const target = mk({ name: 'ocean' });
ok(applyWaterConfig(two, { ocean: target }).join(',') === 'ocean',
  'applyWaterConfig reports which bodies it matched and ignores the rest');
ok(applyWaterConfig(two, { nosuch: target }).length === 0, 'a body with no entry is left alone');
ok(applyWaterConfig(null, { ocean: target }).length === 0, 'a missing config is not an error');

// The file checked into the repo has to be loadable by the flight sim as it stands.
const shipped = JSON.parse(readFileSync('./water-config.json', 'utf8'));
ok(shipped.version === WATER_CONFIG_VERSION, 'shipped water-config.json is the current version');
const flight = mk({ name: 'ocean' });
ok(applyWaterConfig(shipped, { ocean: flight }).join(',') === 'ocean',
  'shipped water-config.json has the ocean entry the flight sim reads');
ok(flight.count.value === flight.table.count && flight.count.value > 0,
  'shipped config yields a live wave table');

console.log(fails ? `${fails} failing` : 'all passing');
process.exit(fails ? 1 : 0);
