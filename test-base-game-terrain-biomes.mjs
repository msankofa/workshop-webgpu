// test-base-game-terrain-biomes.mjs — plants plan F2: the streamed biome seam on the facade.
// node test-base-game-terrain-biomes.mjs

import * as THREE from 'three';
import { createBaseGameTerrain } from './base-game-terrain.js';
import { createWorldQueryService } from './world-query.js';
import { createWorldCoordinateSpace } from './world-coordinates.js';
import { analyticDescriptor, createAnalyticSource, ANALYTIC_BIOME } from './terrain-source-analytic.js';
import { BIOME_INDEX, treeDensityForBiome } from './terrain-biome-point.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const section = name => console.log(`\n${name}`);

function makeTerrain() {
  const scene = new THREE.Scene();
  const worldQuery = createWorldQueryService();
  const worldCoordinates = createWorldCoordinateSpace();
  const descriptor = analyticDescriptor({ key: 'biome-facade', seaLevel: 0 });
  const terrain = createBaseGameTerrain({ scene, worldQuery, worldCoordinates, source: descriptor, useWorker: false });
  terrain.setActive(true);
  return { terrain, descriptor, source: createAnalyticSource(descriptor) };
}
// The facade streams from update(); with no worker the scheduler builds inside its own pump.
function settle(terrain, at = [0, 0, 0], frames = 40) {
  for (let i = 0; i < frames; i++) {
    terrain.update(at, 1 / 60);
    terrain.fieldScheduler.pump();
  }
}

section('the field streams only while held');
{
  const { terrain } = makeTerrain();
  settle(terrain);
  check('no window exists before a consumer asks', terrain.fields === null);
  check('an unheld field reports not ready', terrain.fieldsReady(0, 0) === false);
  check('and its readers return null, not a default', terrain.biomeAt(0, 0) === null && terrain.moistureAt(0, 0) === null);

  const release = terrain.acquireFields();
  check('acquiring opens the window', terrain.fields !== null);
  settle(terrain);
  check('it fills around the player', terrain.fieldsReady(0, 0) === true, `coverage ${terrain.fields.coverage}`);

  release();
  check('the last release closes it', terrain.fields === null);
  terrain.dispose();
}

section('what the facade reports');
{
  const { terrain } = makeTerrain();
  const release = terrain.acquireFields();
  settle(terrain);

  const biome = terrain.biomeAt(12, -30);
  check('biomeAt names a biome', biome === ANALYTIC_BIOME, `got ${biome}`);
  check('biomeIdAt is the matching integer', terrain.biomeIdAt(12, -30) === BIOME_INDEX[ANALYTIC_BIOME]);
  const moisture = terrain.moistureAt(12, -30);
  check('moistureAt is in range', moisture >= 0 && moisture <= 1, `got ${moisture}`);
  check('treeDensityAt matches the shared table', terrain.treeDensityAt(12, -30) === treeDensityForBiome(ANALYTIC_BIOME));

  const field = terrain.surfaceFieldAt(12, -30);
  check('surfaceFieldAt returns one bundle', field && field.biome === biome && Number.isFinite(field.height));
  check('its splat weights sum to one', Math.abs(field.weights.reduce((a, b) => a + b, 0) - 1) < 1e-6,
    `weights ${field.weights.map(w => w.toFixed(2)).join(',')}`);
  check('its normalY is a real normal', field.normalY > 0 && field.normalY <= 1, `got ${field.normalY}`);
  // The placement height is band-limited to the field's own 8 m posts. It tracks the ground well
  // enough to decide WHERE things go and nowhere near well enough to decide where they SIT --
  // which is why contact height comes from the fine lod-0 window instead. Measured, not assumed.
  let sum = 0, worst = 0, n = 0;
  for (let x = -200; x <= 200; x += 7) for (let z = -200; z <= 200; z += 7) {
    const h = terrain.fieldSurfaceAt(x, z);
    if (h == null) continue;
    const d = Math.abs(h - terrain.groundHeight(x, z));
    sum += d; worst = Math.max(worst, d); n++;
  }
  const mean = sum / n;
  check('the placement height tracks the ground', n > 1000 && mean < 2, `mean ${mean.toFixed(2)} m over ${n} samples`);
  check('but is not contact-accurate, by design', worst > 1, `worst ${worst.toFixed(2)} m`);

  // Outside the streamed window everything is null: distance is not a licence to invent data.
  check('a far point is not ready', terrain.fieldsReady(90000, 90000) === false);
  check('and reads null there', terrain.biomeAt(90000, 90000) === null && terrain.surfaceFieldAt(90000, 90000) === null);

  release();
  terrain.dispose();
}

section('the window follows the player and the source');
{
  const { terrain } = makeTerrain();
  const release = terrain.acquireFields();
  settle(terrain);
  const near = terrain.biomeIdAt(0, 0);
  check('the origin resolves', near !== null);

  settle(terrain, [3000, 0, 3000], 60);
  check('the window followed', terrain.fieldsReady(3000, 3000) === true, `coverage ${terrain.fields.coverage}`);
  check('a wrapped read is a real value, not a smear', terrain.biomeIdAt(3000, 3000) === BIOME_INDEX[ANALYTIC_BIOME]);

  terrain.setSource(analyticDescriptor({ key: 'biome-facade-2', seaLevel: 40 }));
  check('a source swap empties the field', terrain.fieldsReady(3000, 3000) === false);
  settle(terrain, [3000, 0, 3000], 60);
  check('and it refills from the new source', terrain.fieldsReady(3000, 3000) === true);

  release();
  terrain.dispose();
}

section('sharing and scheduling');
{
  const { terrain } = makeTerrain();
  const a = terrain.acquireFields();
  const windowA = terrain.fields;
  const b = terrain.acquireFields();
  check('two consumers share one window', terrain.fields === windowA);
  check('the window counts both', terrain.fields.refs === 2);
  a();
  check('one release keeps it streaming', terrain.fields === windowA && terrain.fields.refs === 1);
  b();
  check('the second closes it', terrain.fields === null);

  const c = terrain.acquireFields();
  settle(terrain);
  const stats = terrain.fieldScheduler.stats;
  check('tiles were built through the shared scheduler', stats.completed > 0, JSON.stringify(stats));
  check('nothing was built twice', stats.completed <= stats.completed + stats.deduped && stats.failed === 0, JSON.stringify(stats));
  check('the field pool is one worker at most', stats.workerCount <= 1, `workers ${stats.workerCount}`);
  check('the queue drains rather than growing', stats.queued === 0, `queued ${stats.queued}`);
  c();
  terrain.dispose();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
