// Node checks for the park's pure layer: the species table, the biome map and the census.

import { SPECIES, SPECIES_LIST, BIOMES, MOVEMENT, spawnable, rosterFor, pickWeighted, byMovement, dexKey } from './park-species.js';
import { MOVES_BY_NAME } from './moves/move-registry.js';
import { buildParkMap, buildPark, parkHeightGrid, PARK_TERRAIN, PARK_BIOMES, featureScore, makeRng } from './park-biomes.js';
import { planPopulation, createResidency, censusOf, speciesLoadOrder, validatePlan } from './park-spawn.js';

let pass = 0, fail = 0;
const problems = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; }
  else { fail++; problems.push(`${name}${detail ? ' — ' + detail : ''}`); }
}

// ===================== the species table =====================

check('all 151 species are present', SPECIES_LIST.length === 151, `got ${SPECIES_LIST.length}`);
check('dex numbers are 1..151 with no gaps',
  SPECIES_LIST.every((s, i) => s.dex === i + 1), 'dex order broken');
check('every key is the zero-padded dex',
  SPECIES_LIST.every((s) => s.key === dexKey(s.dex)));

{
  const incomplete = SPECIES_LIST.filter((s) => spawnable(s).length);
  check('every species passes the three-part spawn gate', incomplete.length === 0,
    incomplete.map((s) => `${s.name}: ${spawnable(s).join('/')}`).join('; '));
}

{
  const unknown = [];
  for (const s of SPECIES_LIST) for (const m of s.moves) if (!MOVES_BY_NAME[m]) unknown.push(`${s.name} -> ${m}`);
  check('every assigned move exists in the registry', unknown.length === 0, unknown.slice(0, 6).join('; '));
}

{
  // A substituted move must name a real want, or the `?` syntax is just a typo that silently passed.
  const bad = SPECIES_LIST.flatMap((s) => s.moveIntent.filter((m) => m.wanted !== null && !m.wanted.trim()).map(() => s.name));
  check('substituted moves record what was wanted', bad.length === 0, bad.join(', '));
}

{
  const badBiome = SPECIES_LIST.filter((s) => !BIOMES[s.biome]);
  const badAlso = SPECIES_LIST.filter((s) => s.also.some((b) => !BIOMES[b]));
  const selfAlso = SPECIES_LIST.filter((s) => s.also.includes(s.biome));
  check('every primary biome is a real biome', badBiome.length === 0, badBiome.map((s) => s.name).join(', '));
  check('every secondary biome is a real biome', badAlso.length === 0, badAlso.map((s) => s.name).join(', '));
  check('no species lists its own biome as secondary', selfAlso.length === 0, selfAlso.map((s) => s.name).join(', '));
}

{
  const badMove = SPECIES_LIST.filter((s) => !MOVEMENT[s.move]);
  check('every movement style is a real style', badMove.length === 0, badMove.map((s) => s.name).join(', '));
  const styles = byMovement();
  check('every movement style has at least one user',
    Object.values(styles).every((l) => l.length > 0),
    Object.entries(styles).filter(([, l]) => !l.length).map(([k]) => k).join(', '));
}

{
  // Heights are what set world scale, so a zero or a decimal-point slip is a creature the size of a house.
  const odd = SPECIES_LIST.filter((s) => !(s.heightM > 0.15 && s.heightM < 10));
  check('every height is a plausible metre value', odd.length === 0,
    odd.map((s) => `${s.name} ${s.heightM}`).join(', '));
  const rarity = SPECIES_LIST.filter((s) => !(s.rarity > 0 && s.rarity <= 1));
  check('every rarity is a weight in (0, 1]', rarity.length === 0, rarity.map((s) => s.name).join(', '));
}

{
  // The mapper's own leg count is evidence, not authority
  const legged = new Set(['quad', 'biped', 'multi']);
  const conflict = SPECIES_LIST.filter((s) => legged.has(s.move) && s.rigLegs === 0);
  check('legged species whose rig maps no legs are the known one', conflict.length <= 1,
    conflict.map((s) => s.name).join(', '));
}

{
  const everyBiomeUsed = Object.keys(BIOMES).filter((b) => !SPECIES_LIST.some((s) => s.biome === b));
  check('every biome is somebody\'s home', everyBiomeUsed.length === 0, everyBiomeUsed.join(', '));
}

// ===================== rosters =====================

for (const b of Object.keys(BIOMES)) {
  const roster = rosterFor(b);
  check(`${b} has a roster`, roster.length > 0);
}

{
  // A native pays full rarity and a visitor half
  const forest = rosterFor('forest');
  const pika = forest.find((r) => r.species.key === '025');
  const rattata = forest.find((r) => r.species.key === '019');
  check('a native pays its full rarity', pika && Math.abs(pika.weight - SPECIES['025'].rarity) < 1e-9);
  check('a visitor pays half', rattata && Math.abs(rattata.weight - SPECIES['019'].rarity * 0.5) < 1e-9);
}

{
  // A weighted pick must actually respect the weights, or rarity is decoration.
  const roster = [{ species: { key: 'a' }, weight: 9 }, { species: { key: 'b' }, weight: 1 }];
  const rand = makeRng(7);
  let a = 0;
  for (let i = 0; i < 4000; i++) if (pickWeighted(roster, rand).key === 'a') a++;
  check('pickWeighted respects the weights', a > 3400 && a < 3800, `a picked ${a}/4000, expected ~3600`);
  check('pickWeighted on an empty roster returns null', pickWeighted([], Math.random) === null);
}

// ===================== the park map =====================

const RES = PARK_TERRAIN.resolution, WORLD = PARK_TERRAIN.worldX;
const { grid, map: parkMap } = buildPark({ seed: 4 });
const SEA = PARK_TERRAIN.waterLevel;

check('the park map covers every cell', parkMap.biome.length === RES * RES);
check('the park has water', parkMap.zones.find((z) => z.key === 'lake').cells > 0);
check('every cell holds a real biome index',
  parkMap.biome.every((b) => b < PARK_BIOMES.length));

{
  const present = new Set([...parkMap.biome].map((b) => PARK_BIOMES[b]));
  const absent = PARK_BIOMES.filter((b) => !present.has(b));
  // Cave is a placed disc that a given terrain may not have rock for
  check('every biome but at most one appears on the map', absent.length <= 1, `absent: ${absent.join(', ')}`);
}

{
  const zones = parkMap.zones;
  const shares = Object.fromEntries(zones.map((z) => [z.key, z.share]));
  check('shares sum to 1', Math.abs(zones.reduce((a, z) => a + z.share, 0) - 1) < 1e-6);
  // No single biome may eat the park, or "different biomes" is one biome with decorations.
  const biggest = Math.max(...zones.map((z) => z.share));
  check('no biome takes more than 55% of the park', biggest <= 0.55, `biggest share ${biggest.toFixed(3)}`);
}

{
  // Water is the one rule that must never be overruled
  let wrong = 0;
  for (let i = 0; i < parkMap.biome.length; i++) {
    const below = grid.height[i] < SEA;
    if (below && PARK_BIOMES[parkMap.biome[i]] !== 'lake') wrong++;
  }
  check('every cell under the waterline is lake', wrong === 0, `${wrong} cells below water are not lake`);
}

{
  // Nearest-neighbour, never bilinear — the average of two biome ids is a third biome.
  const b = parkMap.biomeAt(0, 0);
  check('biomeAt returns a biome name', PARK_BIOMES.includes(b), String(b));
  check('biomeAt clamps outside the park', PARK_BIOMES.includes(parkMap.biomeAt(1e6, -1e6)));
  check('heightAt agrees with the grid at a cell centre',
    Math.abs(parkMap.heightAt(-WORLD / 2, -WORLD / 2) - grid.height[0]) < 1e-4);
}

{
  const a = buildPark({ seed: 4 }).map;
  let same = true;
  for (let i = 0; i < a.biome.length; i++) if (a.biome[i] !== parkMap.biome[i]) { same = false; break; }
  check('the same seed builds the same park', same);
}

{
  // Slope is derived when absent
  const noSlope = buildParkMap({ height: grid.height, resolution: RES, worldX: WORLD, worldZ: PARK_TERRAIN.worldZ, waterLevel: SEA, seed: 4 });
  let diff = 0;
  for (let i = 0; i < noSlope.biome.length; i++) if (noSlope.biome[i] !== parkMap.biome[i]) diff++;
  check('derived slope produces nearly the same map', diff / noSlope.biome.length < 0.06,
    `${((diff / noSlope.biome.length) * 100).toFixed(1)}% of cells differ`);
}

// ===================== features =====================

check('no feature list scores 1 everywhere', featureScore([], {}) === 1);
check('water affinity is high at the waterline', featureScore(['water'], { waterDistance: 0 }) > 0.9);
check('water affinity is nil far inland', featureScore(['water'], { waterDistance: 400 }) < 0.05);
check('open ground dislikes canopy', featureScore(['open'], { treeDensity: 1, slope: 0 }) < 0.05);
check('rocks like slope', featureScore(['rocks'], { slope: 0.5 }) > 0.9);
check('two features average', Math.abs(featureScore(['water', 'rocks'], { waterDistance: 0, slope: 0 }) - 0.5) < 0.05);

// ===================== the census =====================

const plan = planPopulation(parkMap, { seed: 11 });
const census = censusOf(plan);

check('the park is populated', plan.residents.length > 260, `only ${plan.residents.length} placed`);
check('the census is varied', census.distinct >= 18, `${census.distinct} distinct species`);
check('every planned resident is spawnable', validatePlan(plan).length === 0, validatePlan(plan).slice(0, 4).join('; '));

{
  // The whole point of the plan is that residents sit in a biome that wants them.
  const misplaced = plan.residents.filter((r) => {
    const here = parkMap.biomeAt(r.x, r.z);
    return here !== r.species.biome && !r.species.also.includes(here);
  });
  check('every resident stands somewhere its species accepts', misplaced.length === 0,
    misplaced.slice(0, 4).map((r) => `${r.species.name} in ${parkMap.biomeAt(r.x, r.z)}`).join('; '));
}

{
  // A land creature standing in the lake is the single most visible failure mode.
  const drowning = plan.residents.filter((r) => {
    const wet = parkMap.biomeAt(r.x, r.z) === 'lake';
    const canSwim = r.species.move === 'swim' || r.species.move === 'fly' || r.species.move === 'hover';
    return wet && !canSwim;
  });
  check('nobody who cannot swim is standing in the lake', drowning.length === 0,
    drowning.slice(0, 4).map((r) => `${r.species.name} (${r.species.move})`).join('; '));
}

{
  let tooClose = 0;
  for (let i = 0; i < plan.residents.length; i++) {
    for (let j = i + 1; j < plan.residents.length; j++) {
      const a = plan.residents[i], b = plan.residents[j];
      if (Math.hypot(a.x - b.x, a.z - b.z) < Math.max(a.need, b.need) - 1e-6) tooClose++;
    }
  }
  check('nobody is inside anybody else\'s spacing', tooClose === 0, `${tooClose} overlapping pairs`);
}

{
  const a = planPopulation(parkMap, { seed: 11 });
  check('the same seed plans the same park',
    a.residents.length === plan.residents.length &&
    a.residents.every((r, i) => r.key === plan.residents[i].key && Math.abs(r.x - plan.residents[i].x) < 1e-9));
  const b = planPopulation(parkMap, { seed: 12 });
  check('a different seed plans a different park',
    b.residents.some((r, i) => !plan.residents[i] || r.key !== plan.residents[i].key));
}

{
  const near = plan.residents.filter((r) => Math.hypot(r.x, r.z) < 18);
  check('the entrance is kept clear', near.length === 0, `${near.length} residents inside the clearance`);
}

// ===================== residency =====================

{
  const res = createResidency(plan.residents, { activeRadius: 60, farRadius: 100, dropRadius: 120, maxActivations: 8, hardMax: 40 });
  let guard = 0;
  // Walk the activation to a steady state, exactly as the page would over successive frames.
  while (guard++ < 200) {
    const work = res.update(0, 0);
    if (!work.activate.length && !work.deactivate.length) break;
    for (const r of work.activate) res.active.set(r.id, r);
    for (const r of work.deactivate) res.active.delete(r.id);
  }
  check('residency reaches a steady state', guard < 200, `still churning after ${guard} rounds`);
  check('residency respects the hard cap', res.size <= 40, `${res.size} active`);
  const should = plan.residents.filter((r) => Math.hypot(r.x, r.z) <= 60).length;
  check('everybody in range is active (or the cap is the reason)',
    res.size === Math.min(should, 40), `${res.size} active vs ${should} in range`);

  // The hysteresis band is the whole reason drop and activate use different radii.
  const boundary = { id: 'edge', x: 61, z: 0 };
  const res2 = createResidency([boundary], { activeRadius: 60, farRadius: 100, dropRadius: 120 });
  check('a resident just outside the active radius does not load', res2.update(0, 0).activate.length === 0);
  res2.active.set('edge', boundary);
  check('and one just inside the drop radius is not immediately dropped', res2.update(0, 0).deactivate.length === 0);

  let threw = false;
  try { createResidency([], { activeRadius: 60, farRadius: 40, dropRadius: 30 }); } catch { threw = true; }
  check('bad radii are refused rather than silently thrashing', threw);
}

{
  const order = speciesLoadOrder(plan.residents, 0, 0);
  check('the load order covers every species present', order.length === census.distinct);
  const first = plan.residents.filter((r) => r.key === order[0]);
  const nearest = Math.min(...plan.residents.map((r) => Math.hypot(r.x, r.z)));
  check('the load order starts with the nearest species',
    Math.min(...first.map((r) => Math.hypot(r.x, r.z))) - nearest < 1e-6);
}

// ===================== report =====================

console.log(`\npark world: ${pass}/${pass + fail} checks passed`);
console.log(`  park ${WORLD}x${WORLD}m at ${RES}^2 · ${plan.residents.length} residents · ${census.distinct} species · ${plan.misses} slots unplaced`);
console.log('  zones: ' + parkMap.zones.map((z) => `${z.key} ${(z.share * 100).toFixed(0)}%`).join('  '));
console.log('  by biome: ' + Object.entries(plan.byBiome).map(([k, l]) => `${k} ${l.length}`).join('  '));
if (census.emptyBiomes.length) console.log('  EMPTY BIOMES: ' + census.emptyBiomes.join(', '));
if (fail) {
  console.log('\nPROBLEMS:');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
