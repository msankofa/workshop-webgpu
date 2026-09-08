// The shared-material cache in flight-meshes.js: which materials one craft asks for, which of them
// are reused by the next craft, and what stays distinct. Run: node test-flight-meshes.mjs
import * as THREE from 'three';
import { buildCraftMesh, CRAFT_KINDS, isCachedCraftMaterial, disposeCraftMaterials, releaseCraftMaterials, craftMaterialUses, craftMaterialCacheSize, CRAFT_MATERIAL_CACHE_LIMIT } from './flight-meshes.js';

let failed = 0;
function ok(msg, cond, detail = '') { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}${detail ? '  ' + detail : ''}`); if (!cond) failed++; }

// A factory that counts, and records the arguments it was actually handed.
function counter() {
  const calls = [];
  return {
    calls,
    get made() { return calls.length; },
    standard: (color, emissive = 0x000000) => { calls.push(['s', color, emissive]); return new THREE.MeshStandardMaterial({ color, emissive, roughness: 0.55, metalness: 0.25 }); },
    basic: (color, opacity = 1) => { calls.push(['b', color, opacity]); return new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity }); },
  };
}
const materialsOf = (g) => { const s = new Set(); g.traverse(o => { if (o.material) s.add(o.material); }); return s; };
const DIMS = { ugv: { wheelbase: 1.1, track: 0.8, clearance: 0.25 }, buggy: { wheelbase: 2.4, track: 1.6, clearance: 0.4 } };

// ── one craft of each kind: how many materials the factory is asked to make ──
// These counts are the code's, not a guess: they are what the builder asks for once the cache has
// folded its repeated requests together. A change here means a builder's palette changed.
const EXPECT = { plane: 4, drone: 4, bird: 3, recon: 2, ugv: 6, buggy: 6, sentinel: 2, agm: 3 };
console.log('-- one craft per kind --');
for (const kind of CRAFT_KINDS) {
  const m = counter();
  const g = buildCraftMesh(kind, 0x8ea2b8, m, DIMS[kind]);
  ok(`${kind}: ${EXPECT[kind]} materials built`, m.made === EXPECT[kind], `made=${m.made}`);
  ok(`${kind}: every material in the mesh is cached`, [...materialsOf(g)].every(isCachedCraftMaterial));
}

// ── a second craft of the same kind and tint builds nothing new ──
console.log('\n-- repeat builds --');
for (const kind of CRAFT_KINDS) {
  const m = counter();
  buildCraftMesh(kind, 0x8ea2b8, m, DIMS[kind]);
  const after = m.made;
  const b = buildCraftMesh(kind, 0x8ea2b8, m, DIMS[kind]);
  ok(`${kind}: second craft builds no new material`, m.made === after, `made=${m.made}`);
  const c = buildCraftMesh(kind, 0x8ea2b8, m, DIMS[kind]);
  ok(`${kind}: third craft shares the same material set`, [...materialsOf(b)].every(x => materialsOf(c).has(x)));
}

// ── tint: one material per distinct tint, shared by crafts wearing it ──
console.log('\n-- tint keying --');
{
  const m = counter();
  buildCraftMesh('drone', 0x112233, m);
  const first = m.made;
  buildCraftMesh('drone', 0x112233, m);
  ok('same tint adds nothing', m.made === first, `made=${m.made}`);
  buildCraftMesh('drone', 0x445566, m);
  ok('a new tint builds exactly one more material', m.made === first + 1, `made=${m.made}`);
  const tints = m.calls.filter(c => c[1] === 0x112233 || c[1] === 0x445566).length;
  ok('the tinted slot was built once per tint', tints === 2, `${tints} tint materials`);
}

// ── two kinds sharing a tint share the tinted material ──
{
  const m = counter();
  const a = buildCraftMesh('drone', 0x778899, m);
  const b = buildCraftMesh('recon', 0x778899, m);
  const shared = [...materialsOf(a)].filter(x => materialsOf(b).has(x));
  ok('drone and recon at one tint share the body material', shared.length >= 1, `${shared.length} shared`);
}

// ── the double-sided panel stays distinct from the hull it matches in colour ──
console.log('\n-- keys that must not collapse --');
for (const kind of ['ugv', 'buggy']) {
  const m = counter();
  const g = buildCraftMesh(kind, 0xaabbcc, m, DIMS[kind]);
  const mats = [...materialsOf(g)];
  const tinted = mats.filter(x => x.color.getHex() === 0xaabbcc);
  ok(`${kind}: two tint-coloured materials, one per side mode`, tinted.length === 2, `${tinted.length}`);
  ok(`${kind}: exactly one of them is double-sided`, tinted.filter(x => x.side === THREE.DoubleSide).length === 1);
}
{
  const m = counter();
  const g = buildCraftMesh('drone', 0x0d1116, m);   // tint equals the camera's body colour
  const mats = [...materialsOf(g)];
  const dark = mats.filter(x => x.color.getHex() === 0x0d1116);
  ok('same colour but different emissive stays two materials', dark.length === 2, `${dark.length}`);
}

// ── distinct factory tables never share ──
console.log('\n-- factory identity --');
{
  const a = counter(), b = counter();
  const ga = buildCraftMesh('drone', 0x8ea2b8, a);
  const gb = buildCraftMesh('drone', 0x8ea2b8, b);
  ok('the second factory builds its own full set', b.made === EXPECT.drone, `made=${b.made}`);
  const overlap = [...materialsOf(ga)].filter(x => materialsOf(gb).has(x));
  ok('no material crosses between factories', overlap.length === 0, `${overlap.length} shared`);
}

// ── moving parts stay their own meshes even when they share a material ──
console.log('\n-- moving parts --');
{
  const m = counter();
  const g = buildCraftMesh('drone', 0x8ea2b8, m);
  const rotors = g.userData.rotors ?? [];
  ok('four rotor blades, four separate meshes', rotors.length === 4 && new Set(rotors).size === 4, `${rotors.length}`);
  ok('the blades share one material', new Set(rotors.map(r => r.material)).size === 1);
  ok('each blade has its own geometry and transform', new Set(rotors.map(r => r.position.x + ':' + r.position.z)).size === 4);
}
{
  const m = counter();
  const g = buildCraftMesh('ugv', 0x8ea2b8, m, DIMS.ugv);
  const wheels = g.userData.wheels ?? [];
  ok('ugv: four wheel pivots survive the merge', wheels.length === 4 && new Set(wheels.map(w => w.pivot)).size === 4);
  ok('ugv: each wheel spins in its own group', new Set(wheels.map(w => w.spin)).size === 4);
  ok('ugv: turret and elevation are separate groups', !!g.userData.turret && !!g.userData.elevation && g.userData.turret !== g.userData.elevation);
  const inTurret = new Set(); g.userData.turret.traverse(o => { if (o.isMesh) inTurret.add(o); });
  let outside = 0; g.traverse(o => { if (o.isMesh && !inTurret.has(o)) outside++; });
  ok('the turret was not merged into the hull', inTurret.size > 0 && outside > 0, `${inTurret.size} in turret, ${outside} outside`);
}
{
  const m = counter();
  const g = buildCraftMesh('recon', 0x8ea2b8, m);
  ok('recon: the propeller is its own group', !!g.userData.propeller && g.userData.propeller.children.length >= 3);
}


// ── ownership: a shared material lives exactly as long as the crafts using it ──
// The teardown under test is the one every page already runs: walk the craft, dispose what you see.
const tearDown = (g) => g.traverse(o => { o.geometry?.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose()); });
const watch = (mats) => { const seen = new Map(); for (const m of mats) { seen.set(m, 0); m.addEventListener('dispose', () => seen.set(m, seen.get(m) + 1)); } return seen; };

console.log('\n-- ownership --');
{
  // Two crafts, tear one down: the other's materials must be untouched and still usable.
  const m = counter();
  const a = buildCraftMesh('drone', 0x8ea2b8, m);
  const b = buildCraftMesh('drone', 0x8ea2b8, m);
  const shared = [...materialsOf(b)];
  const seen = watch(shared);
  ok('both crafts hold the same materials', [...materialsOf(a)].every(x => materialsOf(b).has(x)));
  // References are counted per mesh slot, so a material drawn on 12 parts is held 12 times per craft.
  const before = shared.map(craftMaterialUses);
  ok('two crafts hold every material an even number of times', before.every(n => n > 0 && n % 2 === 0), before.join(','));
  tearDown(a);
  ok('tearing one craft down disposed nothing shared', shared.every(x => seen.get(x) === 0));
  ok('the survivor still holds cached materials', shared.every(isCachedCraftMaterial));
  ok('and exactly one craft worth of references came back', shared.every((x, i) => craftMaterialUses(x) === before[i] / 2), shared.map(craftMaterialUses).join(','));
  const c = buildCraftMesh('drone', 0x8ea2b8, m);
  ok('a craft built afterwards reuses them', m.made === EXPECT.drone && [...materialsOf(c)].every(x => materialsOf(b).has(x)), `made=${m.made}`);
  // Last two go: now they must really be freed, exactly once each.
  tearDown(b); tearDown(c);
  ok('the last teardown disposed each material exactly once', shared.every(x => seen.get(x) === 1), [...seen.values()].join(','));
  ok('and they are no longer claimed by the cache', shared.every(x => !isCachedCraftMaterial(x)));
  ok('the cache is empty for that factory', craftMaterialCacheSize(m) === 0, `${craftMaterialCacheSize(m)}`);
  const d = buildCraftMesh('drone', 0x8ea2b8, m);
  ok('building again makes a fresh set', m.made === EXPECT.drone * 2 && [...materialsOf(d)].every(x => !shared.includes(x)), `made=${m.made}`);
  tearDown(d);
}
{
  // Repeated create/destroy of N crafts must not grow anything.
  const m = counter();
  const alive = [];
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 6; i++) alive.push(buildCraftMesh('recon', 0x8ea2b8, m));
    while (alive.length) tearDown(alive.pop());
  }
  ok('30 crafts over 5 rounds: cache never grew past one set', craftMaterialCacheSize(m) === 0, `${craftMaterialCacheSize(m)}`);
  // Each round rebuilds after the cache emptied, so the factory ran once per round, not once per craft.
  ok('the factory ran once per round, not once per craft', m.made === EXPECT.recon * 5, `made=${m.made}`);
}
{
  // Holding one craft across rounds keeps the set alive and stops any rebuild at all.
  const m = counter();
  const keep = buildCraftMesh('recon', 0x8ea2b8, m);
  for (let round = 0; round < 5; round++) {
    const g = [];
    for (let i = 0; i < 6; i++) g.push(buildCraftMesh('recon', 0x8ea2b8, m));
    while (g.length) tearDown(g.pop());
    ok(`round ${round}: still one set of ${EXPECT.recon}`, m.made === EXPECT.recon && craftMaterialCacheSize(m) === EXPECT.recon, `made=${m.made} cache=${craftMaterialCacheSize(m)}`);
  }
  const mats = [...materialsOf(keep)];
  ok('the held craft still has live materials', mats.every(x => craftMaterialUses(x) >= 1));
  tearDown(keep);
  ok('and releasing it empties the cache', craftMaterialCacheSize(m) === 0, `${craftMaterialCacheSize(m)}`);
}
{
  // releaseCraftMaterials is the explicit spelling of the same thing.
  const m = counter();
  const g = buildCraftMesh('bird', 0x8ea2b8, m);
  const mats = [...materialsOf(g)];
  const seen = watch(mats);
  releaseCraftMaterials(g);
  ok('releaseCraftMaterials frees a lone craft\'s materials', mats.every(x => seen.get(x) === 1));
  ok('a second release is harmless', (releaseCraftMaterials(g), mats.every(x => seen.get(x) === 1)));
}

// ── the cache is bounded ──
console.log('\n-- cache bound --');
{
  // A caller that tints every craft differently. Each craft is torn down, so eviction can reclaim.
  const m = counter();
  for (let i = 0; i < CRAFT_MATERIAL_CACHE_LIMIT * 4; i++) tearDown(buildCraftMesh('recon', 0x100000 + i, m));
  ok('churned tints leave the cache empty', craftMaterialCacheSize(m) === 0, `${craftMaterialCacheSize(m)}`);
}
{
  // Every craft kept alive: the cache stops at the limit and the overflow is per-craft, not cached.
  const m = counter();
  const live = [];
  for (let i = 0; i < CRAFT_MATERIAL_CACHE_LIMIT * 2; i++) live.push(buildCraftMesh('recon', 0x200000 + i, m));
  ok(`cache never exceeds ${CRAFT_MATERIAL_CACHE_LIMIT}`, craftMaterialCacheSize(m) <= CRAFT_MATERIAL_CACHE_LIMIT, `${craftMaterialCacheSize(m)}`);
  const last = [...materialsOf(live[live.length - 1])];
  ok('overflow materials are owned by their craft', last.some(x => !isCachedCraftMaterial(x)));
  const seen = watch(last.filter(x => !isCachedCraftMaterial(x)));
  tearDown(live[live.length - 1]);
  // An uncached material behaves as it did before the cache: every mesh slot disposes it.
  ok('and their dispose really disposes', seen.size > 0 && [...seen.values()].every(n => n >= 1), [...seen.values()].join(','));
  for (const g of live.slice(0, -1)) tearDown(g);
  ok('after every craft goes the cache is empty', craftMaterialCacheSize(m) === 0, `${craftMaterialCacheSize(m)}`);
}

// ── page teardown frees everything regardless of who is holding ──
console.log('\n-- page teardown --');
{
  const m = counter();
  const g = buildCraftMesh('bird', 0x8ea2b8, m);
  const mats = [...materialsOf(g)];
  const seen = watch(mats);
  disposeCraftMaterials();
  ok('disposeCraftMaterials frees every cached material', [...seen.values()].every(n => n === 1), [...seen.values()].join(','));
  ok('and they are no longer claimed by the cache', mats.every(x => !isCachedCraftMaterial(x)));
  // dispose() is back to Three's own, so a stale teardown is a plain redundant dispose, not a crash.
  let threw = false; try { tearDown(g); } catch { threw = true; }
  ok('a stale teardown afterwards is harmless', !threw);
  const after = counter();
  buildCraftMesh('bird', 0x8ea2b8, after);
  ok('the next craft builds a fresh set', after.made === EXPECT.bird, `made=${after.made}`);
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
