// test-surface-field.mjs — SurfaceField CPU twins (moisture proxy + upness), driven without
// a GPU or a loaded map. The full surfaceField() sampler lives in terrain-loader.js (imports
// three); its moisture/upness math is factored into moisture-proxy.js so it is Node-testable
// here. Asserts: moisture monotone in wetness, bounded 0..1, upness == clamped normalY, and
// zero moss weight on a dry+steep sample (SurfaceField feeding the shared mossWeight law).
import {
  moistureProxy, moistureProxyForBiome, biomeMoisture, upnessFromNormalY, BIOME_MOISTURE,
} from './moisture-proxy.js';
import { mossWeight } from './moss-tint-ref.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };

// moisture bounded to [0,1] across a wide input sweep
{
  let bounded = true;
  for (const wetness of [-0.5, 0, 0.3, 0.7, 1, 1.5]) {
    for (let y = -20; y <= 200; y += 10) {
      const m = moistureProxy({ wetness, worldY: y, seaLevel: 0 });
      if (!(m >= 0 && m <= 1)) bounded = false;
    }
  }
  ok(bounded, 'moisture proxy bounded to [0,1]');
}

// monotone non-decreasing in wetness (the biome base term), geometry held fixed on dry ground
{
  let mono = true;
  let prev = -1;
  for (let wetness = 0; wetness <= 1.0001; wetness += 0.05) {
    const m = moistureProxy({ wetness, worldY: 120, seaLevel: 0 });
    if (m < prev - 1e-12) mono = false;
    prev = m;
  }
  ok(mono, 'moisture monotone non-decreasing in wetness');
}

// monotone non-increasing with elevation (higher ground reads drier), wetness fixed
{
  let mono = true;
  let prev = 2;
  for (let y = 5; y <= 200; y += 5) {
    const m = moistureProxy({ wetness: 0.6, worldY: y, seaLevel: 0 });
    if (m > prev + 1e-12) mono = false;
    prev = m;
  }
  ok(mono, 'moisture monotone non-increasing with elevation');
}

// water proximity: at/below sea level reads fully wet regardless of biome dryness
ok(moistureProxy({ wetness: 0.03, worldY: -1, seaLevel: 0 }) > 0.95, 'submerged/shore reads wet even for a dry biome');
ok(moistureProxy({ wetness: 0.03, worldY: 150, seaLevel: 0 }) < 0.1, 'dry biome high above sea reads dry');

// biome table sanity: wet biomes > dry biomes
ok(biomeMoisture('swamp') > biomeMoisture('forest'), 'swamp wetter than forest');
ok(biomeMoisture('forest') > biomeMoisture('desert'), 'forest wetter than desert');
ok(biomeMoisture('unknown_biome') === BIOME_MOISTURE.plains ? true : biomeMoisture('unknown_biome') > 0, 'unknown biome falls back to a finite default');
// per-biome proxy still ordered on identical geometry
{
  const y = 30;
  ok(moistureProxyForBiome('swamp', y) > moistureProxyForBiome('desert', y), 'proxy: swamp wetter than desert at same height');
}

// upness == clamped normalY (identity on [0,1], clamps outside, flat default when non-finite)
{
  let identity = true;
  for (let ny = 0; ny <= 1.0001; ny += 0.1) {
    if (Math.abs(upnessFromNormalY(ny) - ny) > 1e-12) identity = false;
  }
  ok(identity, 'upness == normalY on [0,1]');
  ok(upnessFromNormalY(-0.5) === 0 && upnessFromNormalY(1.7) === 1, 'upness clamps normalY to [0,1]');
  ok(upnessFromNormalY(NaN) === 1, 'upness defaults to flat (1) for non-finite normalY');
}

// zero moss weight on a dry + steep SurfaceField sample: desert biome high up (dry) on a
// cliff (low upness) → mossWeight must be 0.
{
  const moisture = moistureProxyForBiome('desert', 140, 0); // dry
  const upness = upnessFromNormalY(0.15);                    // steep cliff
  ok(mossWeight(moisture, upness, 1, 1) === 0, 'dry+steep surface → zero moss weight');
  // and a wet flat valley floor DOES get moss (sanity that the law is not trivially zero)
  const wetM = moistureProxyForBiome('swamp', 1, 0);
  ok(mossWeight(wetM, upnessFromNormalY(0.98), 1, 1) > 0.3, 'wet flat swamp floor → moss present');
}

process.exit(fail ? 1 : 0);
