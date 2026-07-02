# Family/Species game integration — spec + plan

**Goal:** Let families authored in `tree-viewer.html` actually populate the GPU forest in
`environment-viewer.html`, replacing the procedural `buildSpecies()` generator with
authored species chosen per-biome, weighted by density, sized within each species' range.

**Scope:** GPU forest path only (`forest-placement.js` + `forest-palette.js`, `FOREST_MODE=gpu`,
the default). The legacy `?forest=baked` path in `environment-viewer.html` keeps its own
independent `buildSpecies()` untouched — out of scope, not named by the user's request.
Age-per-instance rolling is explicitly deferred (per the earlier family-design conversation) —
this round only wires biome tags, density, and size range.

**Backward compatibility requirement:** with no exported families present, every code path
must behave byte-identical to today (existing `test-forest-placement.mjs` must pass unmodified).

---

## 1. Export button (`tree-viewer.html`)

Add "Export family JSON" next to "+ New family" in the Family section. Downloads the
currently-selected family via `Blob` + temporary `<a download>`, filename
`<family-name-slugified>.json`. Species `opts` are already stripped of live textures at
save time (`snapshotOpts`), so no replacer is needed at export time — plain
`JSON.stringify(fam, null, 2)`.

## 2. Pure logic (`forest-placement.js`)

**New export** — flattens saved families into a placement-ready species table:

```js
export function buildSpeciesFromFamilies(families) {
  const out = [];
  for (const fam of families) {
    for (const sp of fam.species) {
      out.push({
        ...sp.opts,
        _tag: {
          biomes: sp.biomes || [],
          density: sp.density ?? 1,
          sizeRange: sp.sizeRange || [1, 1],
        },
      });
    }
  }
  return out;
}
```

Each entry is a full `trees.js` opts object (bark/leaves/force/levels/...) plus a `_tag`
side-channel — this is exactly the shape `forest-palette.js`'s baking loop already expects
(`sp.bark`, `sp.leaves`), so no changes needed there beyond sourcing `species` differently.

**`sizeFor`** gains an optional `range` parameter (`[lo, hi]`, defaults to `[0, p.maxSize]` —
identical math to today when omitted, so the no-families path is unaffected):

```js
function sizeFor(p, x, z, rng, range) {
  let v;
  if (p.varPattern === 'noise') v = valueNoise(x * 0.14, z * 0.14, 777);
  else if (p.varPattern === 'gradient') v = clamp((x + 18) / 36, 0, 1);
  else v = rng.next();
  const sv = Math.pow(v, Math.exp(p.skew * 1.5));
  const frac = 1 - p.sizeVar * (1 - sv);
  const [lo, hi] = range || [0, p.maxSize];
  return lo + (hi - lo) * Math.max(0.12, frac);
}
```

**`placementRecords`** gains an optional 4th param `biomeAt(x, z)`. When `params.speciesTable`
is set, species selection switches from uniform-random to biome-filtered density-weighted:

```js
export function placementRecords(chunks, params, heightAt, biomeAt) {
  const out = [];
  const targetChunkCount = params.targetChunkCount || chunks.length;
  const speciesTable = params.speciesTable || null;
  const speciesCount = speciesTable ? speciesTable.length : Math.max(1, Math.floor(params.species));
  for (const chunk of chunks) {
    const count = treeCountForChunk(chunk, params, targetChunkCount);
    const pts = placementsForChunk(chunk, count, params, heightAt);
    for (const pt of pts) {
      const { x, z, chunkKey, slot } = pt;
      const [tx, tz] = chunkKey.split(',').map(Number);
      const treeRng = rngFrom((Math.floor(hash2(tx, tz, params.masterSeed + slot * 1013) * 0xffffffff) ^ Math.imul(slot + 1, 2654435761)) >>> 0);
      let speciesIdx, sizeRange;
      if (speciesTable) {
        const biome = biomeAt ? biomeAt(x, z) : null;
        let candidates = [];
        for (let i = 0; i < speciesTable.length; i++) {
          const tags = speciesTable[i]._tag;
          if (biome === null || !tags.biomes.length || tags.biomes.includes(biome)) candidates.push(i);
        }
        if (candidates.length === 0) candidates = speciesTable.map((_, i) => i);
        let total = 0;
        for (const i of candidates) total += Math.max(0, speciesTable[i]._tag.density);
        if (total <= 0) {
          speciesIdx = candidates[Math.floor(treeRng.next() * candidates.length)];
        } else {
          const r = treeRng.next() * total;
          let acc = 0, chosen = candidates[candidates.length - 1];
          for (const i of candidates) { acc += Math.max(0, speciesTable[i]._tag.density); if (r <= acc) { chosen = i; break; } }
          speciesIdx = chosen;
        }
        sizeRange = speciesTable[speciesIdx]._tag.sizeRange;
      } else {
        speciesIdx = Math.floor(treeRng.next() * speciesCount);   // 1st draw (unchanged path)
      }
      treeRng.next();                                             // 2nd draw: tree seed
      const scale = sizeFor(params, x, z, treeRng, sizeRange);     // 3rd draw
      const yaw = treeRng.next() * Math.PI * 2;                    // 4th draw
      out.push({ x, z, scale, yaw, speciesIdx, chunkKey, slot });
    }
  }
  return out;
}
```

Both branches consume exactly one RNG draw for species selection before the shared
seed/scale/yaw draws, so the random stream stays aligned with the palette baker either way.
No `biomeAt` + a `speciesTable` means every species is a density-weighted candidate everywhere
(sensible for the procedural infinite terrain, which has no biome concept at all).

## 3. `forest-palette.js`

One-line change: source species from the table when present, else the existing generator.

```js
const species = params.speciesTable || buildSpecies(params, rngFrom(masterSeed));
```

## 4. Wiring (`environment-viewer.html`)

New convention: family JSON exports live in `families/`, listed by `families/manifest.json`
(a plain `string[]` of filenames — mirrors nothing fetching a directory listing, matches the
existing explicit-path convention `maps/<key>-data.json` uses). At forest-module startup:

```js
let speciesTable = null;
try {
  const manifest = await fetch('families/manifest.json').then(r => r.ok ? r.json() : []);
  if (Array.isArray(manifest) && manifest.length) {
    const families = await Promise.all(manifest.map(name => fetch(`families/${name}`).then(r => r.json())));
    const table = buildSpeciesFromFamilies(families);
    if (table.length) speciesTable = table;
  }
} catch { /* no manifest / bad fetch -> procedural species, unchanged behavior */ }
if (speciesTable) params.speciesTable = speciesTable;
```

`paramsForRecords()` passes `params.speciesTable` through automatically (it already spreads
`...params`). Every call site that invokes `placementRecords(...)` gets a 4th arg
`loadedMap ? loadedMap.biomeAt : null`. `createForestPalette({..., params, ...})` already
receives the same `params` object, so it picks up `speciesTable` for free.

A ship with no `families/manifest.json` (or an empty one) leaves `speciesTable` null —
zero behavior change for every map that hasn't authored families yet.

## 5. Tests

Extend `test-forest-placement.mjs` with a `speciesTable` case: build 2 species, one tagged
`biomes: ['forest']` with `density: 5`, one tagged `biomes: ['desert']` with `density: 1`, a
`biomeAt` that always returns `'forest'`, and assert every returned `speciesIdx === 0` (the
`'desert'`-only species never gets picked outside its biome) and that `scale` values fall
within the winning species' `sizeRange`. Add a no-`biomeAt` case asserting both species are
reachable (density-weighted, biome-unfiltered). Confirm the existing no-`speciesTable`
assertions still pass unmodified.

## 6. Docs + log

Update `docs/subsystems/vegetation.md`: document `buildSpeciesFromFamilies`, the extended
`sizeFor`/`placementRecords` signatures, the `families/manifest.json` convention, and the
tree-viewer export button. Append one `agent_log.csv` row.

---

**Files touched:** `tree-viewer.html`, `forest-placement.js`, `forest-palette.js`,
`environment-viewer.html`, `test-forest-placement.mjs`, `docs/subsystems/vegetation.md`,
`agent_log.csv`.

**Out of scope (explicitly deferred):** per-instance age rolling in the real game, the
`?forest=baked` legacy path, any UI for picking which families load (manifest is hand-edited
for now).
