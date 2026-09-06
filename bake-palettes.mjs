// bake-palettes.mjs — tidy families/palettes/: drop every cached tree palette whose TREES_VERSION is
// not the current one (and manifest entries without a file, and files without an entry), then report
// what remains. Pre-baking is not possible here: a palette's key includes the world seed the host
// bakes for (docs/forest/palette-worker-and-bake-cache-plan.md, step 4), so a host writes the file
// on its first miss and this script only keeps the directory honest.
//   node bake-palettes.mjs [--dry-run]
import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TREES_VERSION } from './trees.js';

export function prunePalettes(dir, { treesVersion = TREES_VERSION, dryRun = false, log = console.log } = {}) {
  if (!existsSync(dir)) { log(`${dir} does not exist yet; nothing baked`); return { kept: 0, removed: 0, bytes: 0 }; }
  const manifestPath = join(dir, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf-8')) : {};
  const files = new Set(readdirSync(dir).filter(f => f.endsWith('.bin')).map(f => f.slice(0, -4)));
  const remove = key => { if (!dryRun) unlinkSync(join(dir, `${key}.bin`)); };
  let removed = 0, kept = 0, bytes = 0;
  for (const key of Object.keys(manifest)) {
    const stale = manifest[key].treesVersion !== treesVersion;
    if (stale || !files.has(key)) {
      log(`${dryRun ? 'would remove' : 'removed'} ${key} (${stale ? `trees v${manifest[key].treesVersion}, current v${treesVersion}` : 'no file'})`);
      if (files.has(key)) remove(key);
      delete manifest[key];
      removed++;
    } else {
      kept++;
      bytes += statSync(join(dir, `${key}.bin`)).size;
    }
    files.delete(key);
  }
  for (const key of files) {
    log(`${dryRun ? 'would remove' : 'removed'} ${key} (not in manifest)`);
    remove(key);
    removed++;
  }
  if (!dryRun) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  log(`${kept} palette${kept === 1 ? '' : 's'} kept (${(bytes / 1048576).toFixed(1)} MB), ${removed} removed, trees v${treesVersion}`);
  return { kept, removed, bytes };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  prunePalettes(join(process.cwd(), 'families', 'palettes'), { dryRun: process.argv.includes('--dry-run') });
}
