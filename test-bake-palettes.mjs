import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prunePalettes } from './bake-palettes.mjs';

const dir = mkdtempSync(join(tmpdir(), 'palettes-'));
const key = n => n.toString(16).padStart(40, '0');
writeFileSync(join(dir, `${key(1)}.bin`), Buffer.alloc(16));   // current, kept
writeFileSync(join(dir, `${key(2)}.bin`), Buffer.alloc(16));   // stale version
writeFileSync(join(dir, `${key(4)}.bin`), Buffer.alloc(16));   // not in manifest
writeFileSync(join(dir, 'manifest.json'), JSON.stringify({
  [key(1)]: { treesVersion: 7 }, [key(2)]: { treesVersion: 6 }, [key(3)]: { treesVersion: 7 },   // 3 has no file
}));
const quiet = () => {};
const dry = prunePalettes(dir, { treesVersion: 7, dryRun: true, log: quiet });
assert.deepEqual([dry.kept, dry.removed], [1, 3]);
assert.ok(existsSync(join(dir, `${key(2)}.bin`)), 'dry run deletes nothing');
const real = prunePalettes(dir, { treesVersion: 7, log: quiet });
assert.deepEqual([real.kept, real.removed, real.bytes], [1, 3, 16]);
assert.ok(existsSync(join(dir, `${key(1)}.bin`)));
assert.ok(!existsSync(join(dir, `${key(2)}.bin`)) && !existsSync(join(dir, `${key(4)}.bin`)));
assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'))), [key(1)]);
assert.deepEqual(prunePalettes(join(dir, 'missing'), { log: quiet }), { kept: 0, removed: 0, bytes: 0 });
rmSync(dir, { recursive: true });
console.log('prune: keeps current, removes stale/orphan/unlisted, dry run is dry');
