// The shared-material cache in flight-meshes.js: which materials one craft asks for, which of them
// are reused by the next craft, and what stays distinct. Run: node test-flight-meshes.mjs
import * as THREE from 'three';
import { buildCraftMesh, CRAFT_KINDS, isCachedCraftMaterial, disposeCraftMaterials } from './flight-meshes.js';

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

// ── disposing one craft leaves the shared materials alive ──
console.log('\n-- disposal --');
{
  const m = counter();
  const a = buildCraftMesh('drone', 0x8ea2b8, m);
  const b = buildCraftMesh('drone', 0x8ea2b8, m);
  let disposed = 0;
  for (const mat of materialsOf(a)) mat.addEventListener('dispose', () => disposed++);
  // What a craft teardown does: dispose everything it can see.
  a.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
  ok('no shared material was disposed with the craft', disposed === 0, `${disposed} disposed`);
  const still = [...materialsOf(b)].every(isCachedCraftMaterial);
  ok('the surviving craft still holds cached materials', still);
  const c = buildCraftMesh('drone', 0x8ea2b8, m);
  ok('a craft built afterwards reuses them', m.made === EXPECT.drone && [...materialsOf(c)].every(x => materialsOf(b).has(x)), `made=${m.made}`);
}
{
  // Page teardown: this is the one call that really frees them.
  const m = counter();
  const g = buildCraftMesh('bird', 0x8ea2b8, m);
  let disposed = 0;
  for (const mat of materialsOf(g)) mat.addEventListener('dispose', () => disposed++);
  const n = materialsOf(g).size;
  disposeCraftMaterials();
  ok('disposeCraftMaterials frees every cached material', disposed === n, `${disposed}/${n}`);
  ok('and they are no longer claimed by the cache', [...materialsOf(g)].every(x => !isCachedCraftMaterial(x)));
  const after = counter();
  buildCraftMesh('bird', 0x8ea2b8, after);
  ok('the next craft builds a fresh set', after.made === EXPECT.bird, `made=${after.made}`);
}

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
