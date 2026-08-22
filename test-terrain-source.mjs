// Phase 1 checks for the terrain-source contract and the analytic adapter.
// Run: node test-terrain-source.mjs
import { terrainHeightAt, terrainNormalAt, buildHeightTile, sampleHeightTileBilinear } from './terrain-field.js';
import {
  normalizeDescriptor, normalizeTileRequest, validateTileResult, tileKey, parseTileKey,
  createSource, hasSourceKind, tileTransferables, TerrainSourceError,
} from './terrain-source.js';
import { createAnalyticSource, analyticDescriptor } from './terrain-source-analytic.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const throws = (fn, msg) => {
  let caught = null;
  try { fn(); } catch (e) { caught = e; }
  ok(caught instanceof TerrainSourceError, `${msg} -> ${caught ? caught.message : 'no throw'}`);
};

const params = { baseAmp: 1.3, lake: 0.5, lakeDepth: 2.5 };
const size = 30, intervals = 60, apron = 1;

console.log('\n[1] descriptor normalization');
{
  const d = analyticDescriptor({ key: 'lab', sourceVersion: '3', params });
  ok(d.kind === 'analytic' && d.key === 'lab' && d.sourceVersion === '3', 'fields preserved');
  ok(Object.isFrozen(d) && Object.isFrozen(d.config), 'descriptor is frozen');
  ok(d.config.params.baseAmp === 1.3, 'config carries params');
  throws(() => normalizeDescriptor({ ...d, kind: 'lava' }), 'unknown kind rejected');
  throws(() => normalizeDescriptor({ ...d, contractVersion: 2 }), 'wrong contractVersion rejected');
  throws(() => normalizeDescriptor({ ...d, key: '' }), 'empty key rejected');
  throws(() => normalizeDescriptor({ ...d, key: 'a|b' }), 'key with separator rejected');
  throws(() => normalizeDescriptor({ ...d, bounds: { minX: 0, maxX: NaN, minZ: 0, maxZ: 1 } }), 'non-finite bounds rejected');
  throws(() => normalizeDescriptor({ ...d, bounds: { minX: 0, maxX: 10, minZ: 0, maxZ: 10 } }), 'bounded + infinite capability rejected');
  const fin = normalizeDescriptor({ ...d, capabilities: ['heights'], bounds: { minX: -5, maxX: 5, minZ: -5, maxZ: 5 } });
  ok(fin.bounds.maxX === 5, 'finite bounds accepted without infinite capability');
}

console.log('\n[2] tile request and key helpers');
{
  const req = normalizeTileRequest({ ix: -2, iz: 3, xMin: -60, zMin: 90, size, intervals });
  ok(req.lod === 0 && req.apron === 1 && req.fields[0] === 'heights', 'defaults applied');
  throws(() => normalizeTileRequest({ ix: 1.5, iz: 0, xMin: 0, zMin: 0, size, intervals }), 'fractional ix rejected');
  throws(() => normalizeTileRequest({ ix: 0, iz: 0, xMin: Infinity, zMin: 0, size, intervals }), 'non-finite xMin rejected');
  throws(() => normalizeTileRequest({ ix: 0, iz: 0, xMin: 0, zMin: 0, size: 0, intervals }), 'zero size rejected');
  throws(() => normalizeTileRequest({ ix: 0, iz: 0, xMin: 0, zMin: 0, size, intervals: 0 }), 'zero intervals rejected');
  throws(() => normalizeTileRequest({ ix: 0, iz: 0, xMin: 0, zMin: 0, size, intervals, fields: ['lava'] }), 'unknown field rejected');
  const d = analyticDescriptor({ key: 'lab', sourceVersion: '3' });
  const k = tileKey(d, 4, 0, -2, 3);
  const p = parseTileKey(k);
  ok(k === 'lab@3|e4|l0|-2,3', `key ${k}`);
  ok(p.sourceKey === 'lab' && p.sourceVersion === '3' && p.epoch === 4 && p.lod === 0 && p.ix === -2 && p.iz === 3, 'key round-trips');
  throws(() => parseTileKey('nonsense'), 'malformed key rejected');
}

console.log('\n[3] analytic source points match terrain-field exactly');
{
  const src = createAnalyticSource({ key: 'a', sourceVersion: '1', params });
  let maxH = 0, maxN = 0;
  const n1 = [0, 0, 0], n2 = [0, 0, 0];
  for (let i = 0; i < 500; i++) {
    const x = Math.sin(i * 12.9898) * 400, z = Math.cos(i * 78.233) * 400;
    maxH = Math.max(maxH, Math.abs(src.heightAt(x, z) - terrainHeightAt(params, x, z)));
    src.normalAt(x, z, n1); terrainNormalAt(params, x, z, n2);
    for (let k = 0; k < 3; k++) maxN = Math.max(maxN, Math.abs(n1[k] - n2[k]));
  }
  ok(maxH === 0, `height delta ${maxH}`);
  ok(maxN === 0, `normal delta ${maxN}`);
  ok(src.contains(1e6, -1e6) === true, 'infinite source contains everything');
  ok(src.descriptor.capabilities.includes('infinite'), 'claims infinite');
}

console.log('\n[4] analytic LOD-0 tiles match buildHeightTile');
{
  const src = createAnalyticSource({ key: 'a', sourceVersion: '1', params });
  for (const [ix, iz] of [[0, 0], [-1, 0], [-3, -2], [2, -1]]) {
    const req = { ix, iz, xMin: ix * size, zMin: iz * size, size, intervals, apron };
    const tile = src.buildTile(req);
    const ref = buildHeightTile(ix * size, iz * size, size, size / intervals, params, apron);
    let maxD = 0;
    for (let i = 0; i < ref.heights.length; i++) maxD = Math.max(maxD, Math.abs(tile.heights[i] - ref.heights[i]));
    ok(tile.texels === ref.texels && tile.step === ref.step && tile.originX === ref.originX && tile.originZ === ref.originZ, `tile (${ix},${iz}) layout matches`);
    ok(maxD === 0, `tile (${ix},${iz}) heights identical (delta ${maxD})`);
    ok(tile.ix === ix && tile.iz === iz && tile.lod === 0, `tile (${ix},${iz}) carries coords/lod`);
  }
  const withN = src.buildTile({ ix: 0, iz: 0, xMin: 0, zMin: 0, size, intervals, apron, fields: ['heights', 'normals'] });
  ok(withN.normals instanceof Float32Array && withN.normals.length === withN.texels * withN.texels * 3, 'normals field sized texels^2*3');
  const n = [0, 0, 0];
  terrainNormalAt(params, withN.originX + 5 * withN.step, withN.originZ + 7 * withN.step, n);
  const o = (7 * withN.texels + 5) * 3;
  ok(withN.normals[o] === Math.fround(n[0]) && withN.normals[o + 2] === Math.fround(n[2]), 'normal sample matches terrainNormalAt');
  const noN = src.buildTile({ ix: 0, iz: 0, xMin: 0, zMin: 0, size, intervals, apron });
  ok(noN.normals === undefined, 'unrequested normals are absent, not zero-filled');
  throws(() => src.buildTile({ ix: 0, iz: 0, xMin: 0, zMin: 0, size, intervals, apron, lod: 1 }), 'lod 1 rejected in Phase 1');
}

console.log('\n[5] negative tiles, diagonal corners and aprons stay seam-identical');
{
  const src = createAnalyticSource({ key: 'a', sourceVersion: '1', params });
  const mk = (ix, iz) => src.buildTile({ ix, iz, xMin: ix * size, zMin: iz * size, size, intervals, apron });
  const t = { a: mk(-1, -1), b: mk(0, -1), c: mk(-1, 0), d: mk(0, 0) };
  let edge = 0;
  for (let i = 0; i <= intervals; i++) {
    const z = -size + i * (size / intervals);
    edge = Math.max(edge, Math.abs(sampleHeightTileBilinear(t.a, 0, z) - sampleHeightTileBilinear(t.b, 0, z)));
  }
  ok(edge === 0, `shared edge x=0 delta ${edge}`);
  const hs = Object.values(t).map(tile => sampleHeightTileBilinear(tile, 0, 0));
  ok(Math.max(...hs) - Math.min(...hs) === 0, 'four-tile corner at origin agrees');
  // apron sample of tile d at its left apron column equals tile c's interior sample at the same x
  const x = t.d.originX, z = t.d.originZ + 7 * t.d.step;
  ok(t.d.heights[7 * t.d.texels] === Math.fround(terrainHeightAt(params, x, z)), 'apron texel equals analytic height at its global position');
}

console.log('\n[6] tile result validation');
{
  const req = normalizeTileRequest({ ix: 0, iz: 0, xMin: 0, zMin: 0, size, intervals, apron });
  const src = createAnalyticSource({ key: 'a', sourceVersion: '1', params });
  const good = src.buildTile(req);
  ok(validateTileResult(good, req) === good, 'valid tile accepted');
  throws(() => validateTileResult({ ...good, heights: new Float32Array(3) }, req), 'wrong heights length rejected');
  throws(() => validateTileResult({ ...good, heights: Array.from(good.heights) }, req), 'plain array heights rejected');
  throws(() => validateTileResult({ ...good, normals: new Float32Array(5) }, req), 'malformed normals rejected');
  throws(() => validateTileResult({ ...good, holeMask: new Float32Array(good.heights.length) }, req), 'holeMask wrong type rejected');
  throws(() => validateTileResult({ ...good, xMin: 1 }, req), 'bounds mismatch rejected');
  throws(() => validateTileResult({ ...good, ix: 9 }, req), 'coord mismatch rejected');
  throws(() => validateTileResult(good, normalizeTileRequest({ ...req, fields: ['normals'] })), 'missing requested field rejected');
  ok(tileTransferables(good).length === 1 && tileTransferables(good)[0] === good.heights.buffer, 'transferables list heights buffer');
}

console.log('\n[7] registry builds a source from a descriptor alone');
{
  ok(hasSourceKind('analytic'), 'analytic kind registered');
  const d = JSON.parse(JSON.stringify(analyticDescriptor({ key: 'room', sourceVersion: '2', params })));
  const s = createSource(d);
  ok(s.heightAt(12.5, -3) === terrainHeightAt(params, 12.5, -3), 'JSON round-tripped descriptor reproduces heights');
  throws(() => createSource({ ...d, kind: 'finite-map' }), 'unregistered kind rejected');
  throws(() => createSource({ ...d, algorithmVersion: 'other' }), 'unknown algorithm version rejected');
  throws(() => createSource({ ...d, config: { params: { baseAmp: NaN } } }), 'non-finite params rejected');
}

console.log('\n[8] worker sourceTile path produces transferable arrays');
{
  let posted = null, transfer = null;
  globalThis.self = { onmessage: null, postMessage(m, t) { posted = m; transfer = t; } };
  await import(`./terrain-worker.js?source-test=${Date.now()}`);
  const descriptor = JSON.parse(JSON.stringify(analyticDescriptor({ key: 'w', sourceVersion: '1', params })));
  const request = { ix: -1, iz: 2, xMin: -size, zMin: 2 * size, size, intervals, apron, fields: ['heights', 'normals'] };
  self.onmessage({ data: { jobType: 'sourceTile', epoch: 5, descriptor, request } });
  ok(posted && !posted.error, `no error (${posted && posted.error})`);
  ok(posted.key === 'w@1|e5|l0|-1,2', `key ${posted.key}`);
  ok(posted.epoch === 5 && posted.sourceKey === 'w' && posted.sourceVersion === '1', 'epoch and source identity round-trip');
  ok(posted.heights instanceof Float32Array && posted.normals instanceof Float32Array, 'typed arrays returned');
  ok(transfer.length === 2 && transfer.includes(posted.heights.buffer) && transfer.includes(posted.normals.buffer), 'both buffers transferred');
  const ref = buildHeightTile(-size, 2 * size, size, size / intervals, params, apron);
  ok(posted.heights[100] === ref.heights[100], 'worker tile matches buildHeightTile');

  self.onmessage({ data: { jobType: 'sourceTile', epoch: 5, key: 'bad', descriptor, request: { ...request, intervals: 0 } } });
  ok(posted.error && posted.contractError && posted.key === 'bad', `bad request reported as contract error: ${posted.error}`);
  self.onmessage({ data: { jobType: 'sourceTile', epoch: 5, key: 'bad2', descriptor: { ...descriptor, kind: 'lava' }, request } });
  ok(posted.error && posted.contractError, `unknown kind reported: ${posted.error}`);

  self.onmessage({ data: { jobType: 'heightTile', key: '0,0', epoch: 1, xMin: 0, zMin: 0, size, texelWorld: 0.5, apron, params } });
  ok(posted.jobType === 'heightTile' && posted.texels === 63, 'legacy heightTile path still works');
  delete globalThis.self;
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
