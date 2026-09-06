import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTree, TREES_VERSION } from './trees.js';
import { createForestPalette, createForestPaletteAsync, createForestPaletteWorker, createPaletteState, bakeVariant } from './forest-palette.js';
import { serializePalette, deserializePalette, PALETTE_TIERS } from './forest-palette-io.js';
import { runBakeJob } from './forest-palette-worker.js';
import { speciesTableForSelection, DEFAULT_BASE_GAME_TREE_SPECIES } from './base-game-tree-species.js';

function fingerprint(palette) {
  const hash = createHash('sha256');
  for (const variant of palette.variants) {
    hash.update(JSON.stringify([variant.speciesIdx, variant.variant]));
    for (const key of PALETTE_TIERS) {
      const geo = variant[key];
      hash.update(key);
      if (!geo) { hash.update('null'); continue; }
      for (const [name, attr] of [['index', geo.index], ...Object.entries(geo.attributes)]) {
        hash.update(JSON.stringify([name, attr.itemSize, attr.normalized, attr.array.constructor.name]));
        hash.update(Buffer.from(attr.array.buffer, attr.array.byteOffset, attr.array.byteLength));
      }
    }
  }
  return hash.digest('hex');
}

const params = {
  speciesTable: speciesTableForSelection(DEFAULT_BASE_GAME_TREE_SPECIES),
  branchLods: [{ sectionStride: 2, segmentScale: 0.67 }, { sectionStride: 3, segmentScale: 0.5 }],
  leafCount: 10, leafSize: 1, leafShadowPct: 0.3, midLeafRatio: 0.5, midLeafSizeMult: 1.5,
  heightAt: () => 0,
};
const texSet = { mode: 'authored', leafAtlas: { cols: 2, rows: 2 }, barkVScale: 0.35, ready: true, extra: {} };
const opts = { createTree, params, masterSeed: 20260906, variantsPerSpecies: 2, texSet };
const mods = { createTree, createPaletteState, bakeVariant, serializePalette };
const sync = createForestPalette(opts);
const syncHash = fingerprint(sync);

// The worker job posts every variant, in wave order, byte-identical to the sync bake.
{
  const posts = [];
  const done = await runBakeJob({ key: 'k', params, masterSeed: opts.masterSeed, variantsPerSpecies: 2, texSet }, mods, m => posts.push(m));
  const variants = posts.filter(m => m.jobType === 'variant');
  assert.equal(variants.length, sync.variants.length);
  assert.deepEqual(variants.map(m => [m.variant, m.speciesIdx]), [[0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2]], 'variant-major wave order');
  assert.equal(posts.at(-1).jobType, 'done');
  assert.equal(done.total, 6);
  assert.ok(done.bakeMs > 0);
  const rebuilt = { variants: [] };
  for (const m of variants) rebuilt.variants[m.speciesIdx * 2 + m.variant] = deserializePalette(m.buffer).variants[0];
  assert.equal(fingerprint(rebuilt), syncHash, 'worker job palette is byte-identical to the sync bake');
  console.log('worker job: 6 variants in wave order, byte-identical');
}

// Cancel between variants: the job stops and says so.
{
  const posts = [];
  let n = 0;
  const r = await runBakeJob({ key: 'c', params, masterSeed: 1, variantsPerSpecies: 2, texSet }, mods, m => posts.push(m), { isCancelled: () => n++ >= 2 });
  assert.equal(r, null);
  assert.equal(posts.filter(m => m.jobType === 'variant').length, 2);
  assert.equal(posts.at(-1).jobType, 'cancelled');
  console.log('worker job: cancel honoured between variants');
}

// The client against a fake Worker that runs the job in-process: waves, palette, cancel.
class FakeWorker {
  constructor() { FakeWorker.instances.push(this); this.cancelled = new Set(); }
  postMessage(msg) {
    const deliver = m => setTimeout(() => this.onmessage?.({ data: m }), 0);
    if (msg.jobType === 'init') { assert.equal(msg.threeUrl, 'three://x'); deliver({ jobType: 'ready', treesVersion: TREES_VERSION }); }
    else if (msg.jobType === 'cancel') this.cancelled.add(msg.key);
    else if (msg.jobType === 'bake') {
      assert.equal(msg.params.heightAt, undefined, 'functions stripped before posting');
      assert.deepEqual(Object.keys(msg.texSet).sort(), ['barkVScale', 'leafAtlas', 'mode']);
      runBakeJob(msg, mods, deliver, { isCancelled: () => this.cancelled.has(msg.key), yieldFn: () => new Promise(r => setTimeout(r, 0)) });
    }
  }
  terminate() { this.terminated = true; }
}
FakeWorker.instances = [];
globalThis.Worker = FakeWorker;
{
  const client = createForestPaletteWorker({ threeUrl: 'three://x', deserialize: deserializePalette });
  const waves = [];
  const palette = await client.bake(opts, {
    onFamilyWave: w => { waves.push([w.variant, w.variants.length, w.built, w.palette.variants.filter(Boolean).length]); },
  });
  assert.deepEqual(waves, [[0, 3, 3, 3], [1, 3, 6, 6]]);
  assert.equal(fingerprint(palette), syncHash, 'client palette is byte-identical to the sync bake');
  assert.equal(palette.speciesCount, 3);
  assert.ok(palette.bakeMs > 0);
  let stop = false;
  const cancelled = await client.bake(opts, { shouldContinue: () => !stop, onFamilyWave: () => { stop = true; } });
  assert.equal(cancelled, null);
  assert.ok(FakeWorker.instances[0].cancelled.size >= 1, 'cancel reached the worker');
  const refused = await client.bake(opts, { onFamilyWave: () => false });
  assert.equal(refused, null);
  client.dispose();
  assert.equal(FakeWorker.instances.length, 1, 'one worker reused across bakes');
  assert.ok(FakeWorker.instances[0].terminated);
  console.log('client: waves published, byte-identical, cancel and refuse return null');
}

// No Worker at all: the client falls back to the in-thread async bake, same bytes.
{
  delete globalThis.Worker;
  const client = createForestPaletteWorker({ threeUrl: 'three://x' });
  const waves = [];
  const palette = await client.bake(opts, { onFamilyWave: w => waves.push(w.variant) });
  assert.equal(client.available, false);
  assert.deepEqual(waves, [0, 1]);
  assert.equal(fingerprint(palette), syncHash, 'fallback palette is byte-identical');
  const viaAsync = await createForestPaletteAsync(opts);
  assert.equal(fingerprint(viaAsync), syncHash);
  console.log('client: falls back to the async bake without a Worker');
}
