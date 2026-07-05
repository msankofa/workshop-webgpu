// test-plant-variation.mjs -- Phase 1 understory overhaul: per-instance hue/dryness/age
// variation law. plants.js's plantTint()/rollPlantVariation() are the CANONICAL JS
// implementation (imported directly, not a hand-duplicated twin) -- plant-viewer.html's
// variation strip and plants-placement.js's real placement both call the exact same code
// tested here. plants-gpu.js's TSL colorNode is a hand-synced mirror of plantTint() (GPU
// compute can't import JS); this file only proves the JS law, per the file header comment in
// plants-gpu.js pointing back here.
import { plantTint, rollPlantVariation, PLANT_DRY_PROBABILITY } from './plants.js';
import { plantPlacementRecords } from './plants-placement.js';

let fail = 0, pass = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

// ---- plantTint(): bounded, deterministic, finite across the full input domain ----
{
  let allBounded = true, allFinite = true;
  for (let hue = -0.3; hue <= 0.3; hue += 0.05) {
    for (let dryness = 0; dryness <= 1; dryness += 0.1) {
      for (let age = 0.6; age <= 1; age += 0.05) {
        const t = plantTint(hue, dryness, age);
        if (t.length !== 3) allBounded = false;
        for (const c of t) {
          if (!Number.isFinite(c)) allFinite = false;
          if (c < 0 || c > 2.2) allBounded = false;   // generous bound -- never negative, never a blowup
        }
      }
    }
  }
  ok(allFinite, '1: plantTint is finite across the full hue/dryness/age domain');
  ok(allBounded, '1: plantTint stays within a sane [0, 2.2] per-channel range across the domain');
}

ok(JSON.stringify(plantTint(0.1, 0.4, 0.8)) === JSON.stringify(plantTint(0.1, 0.4, 0.8)), '2: plantTint is deterministic (pure function of its inputs)');

// no variation (hue=0, dryness=0, age=1) is the identity-ish baseline: all channels reasonably near 1
{
  const t = plantTint(0, 0, 1);
  ok(t.every(c => Math.abs(c - 1) < 0.15), '3: zero hue/dryness at full age stays close to a neutral (1,1,1) tint');
}

// dryness lifts R and suppresses G/B relative to no dryness (SeedThree scrub.js's 22%-dry law)
{
  const dry = plantTint(0, 1, 1), wet = plantTint(0, 0, 1);
  ok(dry[0] > wet[0], '4: full dryness lifts the R channel');
  ok(dry[1] < wet[1] && dry[2] < wet[2], '4: full dryness suppresses G and B channels');
}

// age darkens: age=0.6 (young) should differ from age=1 (mature); mature is NOT darker than young's ageTint
{
  const young = plantTint(0, 0, 0.6), mature = plantTint(0, 0, 1);
  ok(JSON.stringify(young) !== JSON.stringify(mature), '5: age materially changes the tint');
  ok(mature[0] < young[0], '5: mature (age=1) is darker on R than young (age=0.6)');
}

// ---- rollPlantVariation(): bounded outputs, dry-roll rate approx PLANT_DRY_PROBABILITY ----
{
  const N = 200000;
  const hueVar = 0.18;
  let seed = 12345;
  // simple deterministic RNG local to this test (mulberry32), independent of plants-placement's
  // rngFrom, just to drive a large deterministic sample.
  function rng() {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  let dryCount = 0, minHue = Infinity, maxHue = -Infinity, minDry = Infinity, maxDry = -Infinity, minAge = Infinity, maxAge = -Infinity;
  let drawsPerCall = null;
  for (let i = 0; i < N; i++) {
    let draws = 0;
    const counted = () => { draws++; return rng(); };
    const { hue, dryness, age } = rollPlantVariation(counted, hueVar);
    if (drawsPerCall === null) drawsPerCall = draws; else ok(draws === drawsPerCall, 'rollPlantVariation draws a fixed RNG count every call');
    if (dryness >= 0.5) dryCount++;
    minHue = Math.min(minHue, hue); maxHue = Math.max(maxHue, hue);
    minDry = Math.min(minDry, dryness); maxDry = Math.max(maxDry, dryness);
    minAge = Math.min(minAge, age); maxAge = Math.max(maxAge, age);
  }
  ok(drawsPerCall === 4, `6: rollPlantVariation draws exactly 4 RNG values per call (got ${drawsPerCall})`);
  ok(minHue >= -hueVar - 1e-9 && maxHue <= hueVar + 1e-9, '6: hue stays within +/- hueVar');
  ok(minDry >= 0 && maxDry <= 1 + 1e-9, '6: dryness stays within [0,1]');
  ok(minAge >= 0.6 - 1e-9 && maxAge <= 1 + 1e-9, '6: age stays within [0.6,1]');
  const rate = dryCount / N;
  ok(Math.abs(rate - PLANT_DRY_PROBABILITY) < 0.01, `6: dry-roll rate (${rate.toFixed(4)}) is within 1% of PLANT_DRY_PROBABILITY (${PLANT_DRY_PROBABILITY})`);
}

// ---- integration: real placement records carry bounded hue/dryness/age, dry-rate holds up ----
{
  const heightAt = () => 0;
  const bigChunks = [];
  for (let ix = 0; ix < 10; ix++) for (let iz = 0; iz < 10; iz++) {
    bigChunks.push({ key: `${ix},${iz}`, xMin: ix * 30, zMin: iz * 30, size: 30, centerX: ix * 30 + 15, centerZ: iz * 30 + 15 });
  }
  const speciesTable = [
    { key: 'chickweed', tag: { biomes: [], density: 1, hueVar: 0.2 } },
  ];
  const params = { masterSeed: 20260705, waterLevel: -0.9, shoreMargin: 0.1, plantDensity: 0.3, plantSpeciesTable: speciesTable };
  const recs = plantPlacementRecords(bigChunks, params, heightAt);
  ok(recs.length > 1000, '7: large sample of real placement records generated');
  ok(recs.every(r => typeof r.hue === 'number' && Math.abs(r.hue) <= 0.2 + 1e-9), '7: every placed record has a bounded hue');
  ok(recs.every(r => typeof r.dryness === 'number' && r.dryness >= 0 && r.dryness <= 1), '7: every placed record has a bounded dryness');
  ok(recs.every(r => typeof r.age === 'number' && r.age >= 0.6 && r.age <= 1), '7: every placed record has a bounded age');
  const strongDryRate = recs.filter(r => r.dryness >= 0.5).length / recs.length;
  ok(Math.abs(strongDryRate - PLANT_DRY_PROBABILITY) < 0.03, `7: placement dry-roll rate (${strongDryRate.toFixed(4)}) tracks PLANT_DRY_PROBABILITY`);

  // determinism: two identical calls produce byte-identical hue/dryness/age too
  const recs2 = plantPlacementRecords(bigChunks, params, heightAt);
  ok(JSON.stringify(recs) === JSON.stringify(recs2), '7: placement (incl. hue/dryness/age) is deterministic for the same seed/params');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
