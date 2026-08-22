// Smoke test the terrain worker's heightTile job path under a mocked browser
// worker scope. The production worker uses `self.onmessage`, which Node's
// worker_threads API does not expose directly.

let posted = null;
globalThis.self = {
  onmessage: null,
  postMessage(message) { posted = message; },
};

await import(`./terrain-worker.js?heighttile-test=${Date.now()}`);

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

console.log('\n[1] terrain-worker returns height tiles');
{
  self.onmessage({
    data: {
      jobType: 'heightTile',
      key: '0,0',
      epoch: 7,
      xMin: 0,
      zMin: 0,
      size: 30,
      texelWorld: 0.5,
      apron: 1,
      params: { baseAmp: 1, lake: 0.45, lakeDepth: 3.2 },
    },
  });

  ok(posted && posted.jobType === 'heightTile', `jobType ${posted && posted.jobType}`);
  ok(posted.key === '0,0' && posted.epoch === 7, 'key and epoch round-trip');
  ok(posted.texels === 63, `texels ${posted.texels}`);
  ok(posted.heights instanceof Float32Array, 'heights is Float32Array');
  ok(posted.heights.length === posted.texels * posted.texels, `height count ${posted.heights.length}`);
  ok(posted.step === 0.5, `step ${posted.step}`);
  ok(posted.originX === -0.5 && posted.originZ === -0.5, `origin (${posted.originX}, ${posted.originZ})`);
}

console.log('\n[2] sourceTile descriptor round-trip');
{
  const { analyticDescriptor } = await import('./terrain-source-analytic.js');
  const { buildHeightTile } = await import('./terrain-field.js');
  const params = { baseAmp: 1, lake: 0.45, lakeDepth: 3.2 };
  const descriptor = JSON.parse(JSON.stringify(analyticDescriptor({ key: 'rt', sourceVersion: '2', params })));
  self.onmessage({ data: { jobType: 'sourceTile', epoch: 3, descriptor, request: { ix: 2, iz: -1, xMin: 60, zMin: -30, size: 30, intervals: 60, apron: 1 } } });
  ok(posted.jobType === 'sourceTile' && !posted.error, 'sourceTile reply has no error');
  ok(posted.key === 'rt@2|e3|l0|2,-1', `derived key ${posted.key}`);
  ok(posted.sourceKey === 'rt' && posted.sourceVersion === '2' && posted.epoch === 3, 'descriptor identity round-trips');
  const ref = buildHeightTile(60, -30, 30, 0.5, params, 1);
  ok(posted.texels === ref.texels && posted.heights[777] === ref.heights[777], 'tile matches buildHeightTile');
  ok(posted.normals === undefined, 'unrequested normals absent');
}

console.log('\n[3] sourceTile bad requests are rejected, not thrown');
{
  const { analyticDescriptor } = await import('./terrain-source-analytic.js');
  const descriptor = JSON.parse(JSON.stringify(analyticDescriptor({ key: 'rt', sourceVersion: '2' })));
  let threw = false;
  try {
    self.onmessage({ data: { jobType: 'sourceTile', key: 'k', epoch: 3, descriptor, request: { ix: 0, iz: 0, xMin: NaN, zMin: 0, size: 30, intervals: 60 } } });
  } catch { threw = true; }
  ok(!threw && posted.error && posted.contractError && posted.key === 'k', `non-finite request -> error reply (${posted.error})`);
  self.onmessage({ data: { jobType: 'sourceTile', key: 'k2', epoch: 3, descriptor: { ...descriptor, sourceVersion: 'a|b' }, request: { ix: 0, iz: 0, xMin: 0, zMin: 0, size: 30, intervals: 60 } } });
  ok(posted.error && posted.contractError && posted.key === 'k2', `bad descriptor -> error reply (${posted.error})`);
  self.onmessage({ data: { jobType: 'sourceTile', key: 'k3', epoch: 3, descriptor, request: { ix: 0, iz: 0, xMin: 0, zMin: 0, size: 30, intervals: 60, lod: 2 } } });
  ok(posted.error && posted.key === 'k3', `unsupported lod -> error reply (${posted.error})`);
}

delete globalThis.self;

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
