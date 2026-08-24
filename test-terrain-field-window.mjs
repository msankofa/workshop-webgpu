// test-terrain-field-window.mjs — plants plan F2: the shared field scheduler and field windows.
// node test-terrain-field-window.mjs

import { createFieldScheduler, FIELD_PRIORITY } from './terrain-field-scheduler.js';
import { createFieldWindow, createFieldWindowRegistry } from './terrain-field-window.js';
import { createClipmapWindow } from './terrain-clipmap-window.js';
import { createAnalyticSource, analyticDescriptor } from './terrain-source-analytic.js';
import { BIOME_INDEX } from './terrain-biome-point.js';
import { ANALYTIC_BIOME } from './terrain-source-analytic.js';

let passed = 0, failed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const section = name => console.log(`\n${name}`);

const descriptor = analyticDescriptor({ key: 'field-test', seaLevel: 0 });
const source = createAnalyticSource(descriptor);

section('window payloads');
{
  const win = createClipmapWindow({ level: 0, post: 8, tileIntervals: 4, tilesPerSide: 4, fields: ['surfaceHeights', 'biomeIds', 'moisture'] });
  check('heights is always carried', win.fields[0] === 'heights');
  check('requested fields are carried', ['surfaceHeights', 'biomeIds', 'moisture'].every(f => win.fields.includes(f)));
  check('each field has its own array', win.array('biomeIds') instanceof Uint8Array && win.array('moisture') instanceof Float32Array);
  check('the tile request asks for every field', win.tileRequest(0, 0).fields.length === win.fields.length);
  check('lod defaults to level + 1', win.lod === 1);
  const exact = createClipmapWindow({ level: 0, post: 2, tileIntervals: 4, tilesPerSide: 4, lod: 0 });
  check('lod 0 can be requested explicitly', exact.lod === 0 && exact.tileRequest(0, 0).lod === 0);

  win.recentre(0, 0);
  const req = win.tileRequest(0, 0);
  const tile = source.buildTile(req);
  check('a partial tile is refused', win.commitTile({ ...tile, biomeIds: null }) === false);
  check('a complete tile commits', win.commitTile(tile) === true);
}

section('scheduler: dedupe, priority, cancel');
{
  const scheduler = createFieldScheduler({ useWorker: false, maxInFlight: 8, syncBudgetMs: 1000 });
  const req = { ix: 2, iz: 3, xMin: 64, zMin: 96, size: 32, intervals: 4, apron: 1, lod: 1, fields: ['heights'] };
  let a = 0, b = 0;
  scheduler.request({ descriptor, request: req, priority: FIELD_PRIORITY.water, onTile: () => a++ });
  scheduler.request({ descriptor, request: req, priority: FIELD_PRIORITY.placement, onTile: () => b++ });
  check('the second ask for one tile is deduped', scheduler.stats.deduped === 1);
  scheduler.pump();
  check('both askers were served', a === 1 && b === 1, `a=${a} b=${b}`);
  check('only one tile was built', scheduler.stats.completed === 1);

  // Each asker owns its arrays: a window keeps what it is handed.
  const s2 = createFieldScheduler({ useWorker: false, syncBudgetMs: 1000 });
  const tiles = [];
  s2.request({ descriptor, request: req, onTile: t => tiles.push(t) });
  s2.request({ descriptor, request: req, onTile: t => tiles.push(t) });
  s2.pump();
  check('two askers get separate buffers', tiles.length === 2 && tiles[0].heights !== tiles[1].heights);
  check('and the same values', tiles[0].heights[10] === tiles[1].heights[10]);

  const s3 = createFieldScheduler({ useWorker: false, maxInFlight: 1, syncBudgetMs: 0 });
  const order = [];
  const owner = Symbol('doomed');
  s3.request({ descriptor, request: { ...req, ix: 10 }, priority: FIELD_PRIORITY.prefetch, onTile: () => order.push('prefetch') });
  s3.request({ descriptor, request: { ...req, ix: 11 }, priority: FIELD_PRIORITY.contact, onTile: () => order.push('contact') });
  s3.request({ descriptor, request: { ...req, ix: 12 }, priority: FIELD_PRIORITY.water, owner, onTile: () => order.push('water') });
  check('cancelling an owner drops its queued work', s3.cancelOwner(owner) === 1);
  for (let i = 0; i < 5; i++) s3.pump();
  check('contact ran before prefetch', order[0] === 'contact', order.join(','));
  check('the cancelled job never ran', !order.includes('water'), order.join(','));

  // A job the source itself refuses (the analytic source builds normals at lod 0 only).
  const s4 = createFieldScheduler({ useWorker: false, syncBudgetMs: 1000 });
  let errored = null, delivered = 0;
  s4.request({ descriptor, request: { ...req, lod: 1, fields: ["heights", "normals"] }, onTile: () => { delivered++; }, onError: e => { errored = e; } });
  s4.pump();
  check('a failing build reports instead of throwing', typeof errored === 'string' && s4.stats.failed === 1 && delivered === 0, String(errored));
  scheduler.dispose(); s2.dispose(); s3.dispose(); s4.dispose();
}

section('field window: fill, sample, readiness');
{
  const scheduler = createFieldScheduler({ useWorker: false, maxInFlight: 64, syncBudgetMs: 1000 });
  const fw = createFieldWindow({
    source, descriptor, scheduler, label: 'test',
    fields: ['surfaceHeights', 'biomeIds', 'moisture'],
    post: 8, tileIntervals: 4, tilesPerSide: 4, maxRequestsPerUpdate: 64,
  });
  check('nothing streams before a reference is taken', fw.update(0, 0) === false && fw.stats.tilesRequested === 0);
  const release = fw.acquire();
  check('a point is not ready before its tiles arrive', fw.ready(0, 0) === false);
  check('a not-ready sample is null, not a default', fw.sampleAt('surfaceHeights', 0, 0) === null);

  for (let i = 0; i < 6; i++) { fw.update(0, 0); scheduler.pump(); }
  check('the window filled', fw.coverage === 1, `coverage ${fw.coverage}`);
  check('the point is ready now', fw.ready(0, 0) === true);

  const h = fw.sampleAt('surfaceHeights', 3, -5);
  check('surfaceHeights matches the source', Math.abs(h - source.heightAt(3, -5)) < 1.0, `window ${h} vs source ${source.heightAt(3, -5)}`);
  const biome = fw.sampleAt('biomeIds', 3, -5);
  check('biome ids come back as ids, not blends', biome === BIOME_INDEX[ANALYTIC_BIOME] && Number.isInteger(biome), `got ${biome}`);
  const moisture = fw.sampleAt('moisture', 3, -5);
  check('moisture is in range', moisture >= 0 && moisture <= 1, `got ${moisture}`);

  // Recentring must not smear: the same world point reads the same value after the window moves.
  const before = fw.sampleAt('surfaceHeights', 40, 40);
  for (let i = 0; i < 8; i++) { fw.update(400, 400); scheduler.pump(); }
  const far = fw.sampleAt('surfaceHeights', 404, 404);
  check('the moved window resolves its new centre', far !== null);
  check('a recentre keeps values it still holds or drops them cleanly',
    fw.sampleAt('surfaceHeights', 40, 40) === null || Math.abs(fw.sampleAt('surfaceHeights', 40, 40) - before) < 1e-6);

  // A full window must not walk its tile grid every frame: that scan builds a string per tile and
  // returns nothing, which was 9 of the 15 us terrain.update() cost while standing still.
  for (let i = 0; i < 20; i++) { fw.update(0, 0); scheduler.pump(); }      // settle back at the origin
  const requestedAfterFill = fw.stats.tilesRequested;
  for (let i = 0; i < 50; i++) { fw.update(0, 0); scheduler.pump(); }
  check('a full window issues no further requests', fw.stats.tilesRequested === requestedAfterFill,
    `${fw.stats.tilesRequested - requestedAfterFill} extra`);
  fw.update(2000, 2000);
  check('moving resumes requesting', fw.stats.tilesRequested > requestedAfterFill);
  for (let i = 0; i < 12; i++) { fw.update(0, 0); scheduler.pump(); }

  check('one texture per field', ['surfaceHeights', 'biomeIds', 'moisture', 'heights'].every(f => fw.texture(f)));
  check('id fields upload as one byte per texel', fw.texture('biomeIds').image.data instanceof Uint8Array);
  check('value fields upload as floats', fw.texture('moisture').image.data instanceof Float32Array);

  // A source swap invalidates in-flight answers rather than mixing two worlds in one window.
  const other = createAnalyticSource(analyticDescriptor({ key: 'field-test-2', seaLevel: 20 }));
  fw.setSource(other);
  check('a source swap empties the window', fw.coverage === 0 && fw.ready(404, 404) === false);

  release();
  check('releasing the last reference stops the streaming', fw.update(0, 0) === false);
  fw.dispose();
  scheduler.dispose();
}

section('registry: one window, many holders');
{
  const scheduler = createFieldScheduler({ useWorker: false, syncBudgetMs: 1000 });
  const registry = createFieldWindowRegistry({ scheduler });
  const make = () => createFieldWindow({ source, descriptor, scheduler, fields: ['surfaceHeights'], post: 8, tileIntervals: 4, tilesPerSide: 4 });
  const water = registry.acquire('coarse:8', make);
  const flora = registry.acquire('coarse:8', make);
  check('two consumers share one window', water.window === flora.window);
  check('the registry holds one entry', registry.size === 1);
  check('the window counts both holders', water.window.refs === 2);
  water.release();
  check('one release keeps the window alive', registry.size === 1 && flora.window.refs === 1);
  flora.release();
  check('the last release disposes it', registry.size === 0);
  const again = registry.acquire('coarse:8', make);
  check('a later consumer gets a fresh window', registry.size === 1 && again.window.refs === 1);
  again.release();
  registry.dispose();
  scheduler.dispose();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
