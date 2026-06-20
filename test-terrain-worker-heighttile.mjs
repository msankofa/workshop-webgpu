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

delete globalThis.self;

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
