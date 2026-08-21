// Node checks for the park's creature factory: loading, driver dispatch, streaming and LOD.

import fs from 'node:fs';
import * as THREE from 'three';
import { parseGLB } from './stadium-glb.js';
import { mapStadiumRig } from './stadium-rig-map.js';
import { createParkCreatures, describeDriver, CREATURE_DEFAULTS } from './park-creature.js';
import { SPECIES } from './park-species.js';

let pass = 0, fail = 0;
const problems = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; }
  else { fail++; problems.push(`${name}${detail ? ' — ' + detail : ''}`); }
}
const seeded = (s) => () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// ---- the two stubs -------------------------------------------------------

const DIR = 'models/stadium';
const fetchCounts = new Map();
globalThis.fetch = async (url) => {
  const file = String(url).split('/').pop();
  fetchCounts.set(file, (fetchCounts.get(file) || 0) + 1);
  const path = `${DIR}/${file}`;
  if (!fs.existsSync(path)) return { ok: false, status: 404 };
  const buf = fs.readFileSync(path);
  return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
};

/** A scene graph with the model's real bone names and one mesh */
class FakeGLTFLoader {
  async parseAsync(buffer) {
    const bytes = new Uint8Array(buffer);
    const { json, bin } = parseGLB(bytes);
    const map = mapStadiumRig(json, bin, {});
    const root = new THREE.Group();
    root.name = 'Scene';
    const byIndex = new Map();
    for (let i = 0; i < json.nodes.length; i++) {
      const o = new THREE.Object3D();
      o.name = json.nodes[i].name || `node${i}`;
      byIndex.set(i, o);
    }
    const rooted = new Set();
    for (let i = 0; i < json.nodes.length; i++) {
      for (const c of json.nodes[i].children || []) { byIndex.get(i).add(byIndex.get(c)); rooted.add(c); }
    }
    for (let i = 0; i < json.nodes.length; i++) if (!rooted.has(i)) root.add(byIndex.get(i));
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
    mesh.name = 'body';
    root.add(mesh);
    // Two clips with the real shape: an idle that loops, and one track per pivot bone.
    const tracks = Object.values(map.names).slice(0, 14).map((n) =>
      new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]));
    const animations = tracks.length
      ? [new THREE.AnimationClip('idle', 1, tracks), new THREE.AnimationClip('attack', 1, tracks)]
      : [];
    return { scene: root, animations };
  }
}

const deps = () => ({
  THREE,
  scene: new THREE.Scene(),
  GLTFLoader: FakeGLTFLoader,
  skeletonClone: (o) => o.clone(true),
  terrainHeight: (x, z) => 4 + 2 * Math.sin(x * 0.03) * Math.cos(z * 0.03),
  waterLevel: 0,
  worldRadius: 1700,
  rng: seeded(5),
});

const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 800);
camera.position.set(0, 6, 0);
camera.lookAt(0, 6, 100);
camera.updateMatrixWorld(true);

const resident = (key, x, z, i = 0) => ({
  id: `${key}-${i}`, key, species: SPECIES[key], x, z, y: 0, yaw: 0, biome: SPECIES[key].biome, need: 8,
});

// ===================== loading =====================

const park = createParkCreatures(deps());

{
  const entry = await park.ensureSpecies(SPECIES['019']);   // Rattata, four legs
  check('a species loads', !!entry && entry.key === '019');
  check('and its rig is mapped', entry.legs === 4, `${entry.legs} legs`);
  check('and its clips come with it', entry.clips.length > 0);
  const again = await park.ensureSpecies(SPECIES['019']);
  check('a second request reuses the parse', again === entry);
  check('the loaded count did not double', park.stats.loaded === 1, `${park.stats.loaded}`);
}

{
  // Two concurrent requests for the same species must produce one parse, not two.
  const p2 = createParkCreatures(deps());
  const [a, b] = await Promise.all([p2.ensureSpecies(SPECIES['025']), p2.ensureSpecies(SPECIES['025'])]);
  check('concurrent loads of one species parse once', a === b && p2.stats.loaded === 1, `${p2.stats.loaded} parses`);
}

{
  const missing = { key: 'zzz', file: 'nope.glb', name: 'Nope' };
  let threw = false;
  try { await park.ensureSpecies(missing); } catch { threw = true; }
  check('a missing model reports rather than hangs', threw);
  check('and enters a bounded failed state', park.hasFailed('zzz') && park.stats.failed === 1);
  const afterFirstFailure = fetchCounts.get('nope.glb');
  try { await park.ensureSpecies(missing); } catch {}
  check('a cached failure is not fetched again', fetchCounts.get('nope.glb') === afterFirstFailure);
  try { await park.retrySpecies(missing); } catch {}
  check('an explicit retry performs exactly one new request',
    fetchCounts.get('nope.glb') === afterFirstFailure + 1 && park.hasFailed('zzz'));
}

// ===================== driver dispatch =====================

{
  const c = park.spawn(resident('019', 10, 0));
  check('a quadruped spawns', !!c);
  check('spawn construction timing is exposed',
    park.stats.spawns >= 1 && Number.isFinite(park.stats.spawnLastMs)
      && park.stats.spawnPeakMs >= park.stats.spawnLastMs);
  check('and gets the leg solver', c.style === 'walker' && !!c.walker && !c.mover);
  check('and is added to the scene', !!c.group.parent);
  check('and starts where it was planned',
    Math.abs(c.walker.body.pos.x - 10) < 0.5 && Math.abs(c.walker.body.pos.z) < 0.5,
    `${c.walker.body.pos.x.toFixed(2)}, ${c.walker.body.pos.z.toFixed(2)}`);
  // The Pokedex height is what makes species comparable; the walker bakes it into every leg length.
  check('and is scaled to its real height',
    Math.abs(c.walker.unitScale * c.entry.map.units.height - SPECIES['019'].heightM) < 1e-6,
    `${(c.walker.unitScale * c.entry.map.units.height).toFixed(3)} m vs ${SPECIES['019'].heightM}`);
  check('and its roam leash is past the map diagonal', c.walker.tuning.roamRadius >= 1700);
}

{
  await park.ensureSpecies(SPECIES['129']);                 // Magikarp, a swimmer
  const c = park.spawn(resident('129', -20, 5));
  check('a swimmer spawns', !!c);
  check('and gets a bodiless solver', c.style === 'swim' && !!c.mover && !c.walker);
  check('and rides the water surface, not the ground', Math.abs(c.mover.body.y) < 0.5, `y ${c.mover.body.y.toFixed(2)}`);
}

{
  await park.ensureSpecies(SPECIES['100']);                 // Voltorb, no legs by design
  const c = park.spawn(resident('100', 6, 6));
  check('a roller spawns and rolls', c.style === 'roll' && !!c.mover);
}

{
  await park.ensureSpecies(SPECIES['107']);                 // Hitmonchan: authored biped, rig maps no legs
  const entry = park.speciesCache.get('107');
  const c = park.spawn(resident('107', 30, 30));
  check('a legged species with an unmappable rig still exists', !!c);
  check('and falls back to the ground solver rather than throwing', c.style === 'ground' && !!c.mover);
  check('and the fallback is recorded, not swallowed',
    park.warnings.some((w) => w.includes('Hitmonchan')), park.warnings.join(' | '));
  check('describeDriver says so', /no legs/.test(describeDriver(SPECIES['107'], entry)), describeDriver(SPECIES['107'], entry));
}

{
  const before = park.stats.live;
  const dup = park.spawn(resident('019', 10, 0));
  check('spawning the same id twice is refused', dup === null && park.stats.live === before);
  const unloaded = park.spawn(resident('144', 0, 0));
  check('spawning an unloaded species returns null rather than throwing', unloaded === null);
}

// ===================== idle clips =====================

{
  const c = park.get('019-0');
  check('a walking creature layers the ROM idle', !!c.mixer);
  const legBones = new Set(c.entry.map.legs.flatMap((l) => l.bones).map((b) => c.entry.map.names[b]));
  const clip = c.action.getClip();
  const leaked = clip.tracks.filter((t) => legBones.has(t.name.split('.')[0]));
  check('with every leg track stripped', leaked.length === 0, leaked.map((t) => t.name).join(', '));
  check('and the tracks that remain are not empty', clip.tracks.length > 0);
}

{
  // Four species have an idle that moves the hips further than the whole stride
  await park.ensureSpecies(SPECIES['086']);                 // Seel
  const c = park.spawn(resident('086', 50, 50));
  check('a species whose idle fights its gait runs on legs alone', !!c && !c.mixer);
}

{
  const a = park.get('019-0'), b = park.get('086-0');
  check('idle phases are offset between individuals', !a.mixer || !b.mixer || a.action.time !== 0);
}

// ===================== update, LOD and culling =====================

{
  const p = createParkCreatures(deps());
  await p.ensureSpecies(SPECIES['019']);
  const near = p.spawn(resident('019', 0, 20, 1));
  const far = p.spawn(resident('019', 0, 400, 2));
  const behind = p.spawn(resident('019', 0, -60, 3));

  p.update(1 / 60, camera);
  check('a creature in front and in range is posed', near.group.visible && p.stats.posed >= 1);
  check('a creature past the draw distance is hidden', !far.group.visible);
  check('a creature behind the camera is hidden', !behind.group.visible);
  check('the hidden count matches', p.stats.hidden === 2, `${p.stats.hidden}`);

  // Striding: past the stride distance a creature must still move, just less often.
  const strider = p.spawn(resident('019', 0, 90, 4));
  let stridedFrames = 0;
  const x0 = strider.walker.body.pos.x, z0 = strider.walker.body.pos.z;
  for (let i = 0; i < 120; i++) { p.update(1 / 60, camera); stridedFrames += p.stats.strided ? 1 : 0; }
  check('a distant creature is strided, not frozen', stridedFrames > 40, `${stridedFrames}/120 frames skipped`);
  check('and it still moved', Math.hypot(strider.walker.body.pos.x - x0, strider.walker.body.pos.z - z0) > 0.02);

  // Paused means paused: visibility still resolves, nothing steps.
  const px = near.walker.body.pos.x;
  for (let i = 0; i < 60; i++) p.update(1 / 60, camera, { paused: true });
  check('paused freezes the sim', Math.abs(near.walker.body.pos.x - px) < 1e-9);

  check('update without a camera is a no-op rather than a crash', !!p.update(1 / 60, null));
  p.dispose();
}

// ===================== frustum culling =====================

{
  // The camera looks down +z with a 60 degree vertical fov and 1.6 aspect: 60 m out the half width
  // is about 55 m, so 150 m to the side is well outside it and still inside the draw distance.
  const p = createParkCreatures(deps());
  await p.ensureSpecies(SPECIES['019']);
  const ahead = p.spawn(resident('019', 0, 120, 10));
  const side = p.spawn(resident('019', 150, 60, 11));
  const close = p.spawn(resident('019', 30, 20, 12));
  p.update(1 / 60, camera);
  check('a creature in the frustum is drawn', ahead.group.visible);
  check('a creature beside the frustum is not', !side.group.visible, 'the meshes carry frustumCulled = false, so nothing else culls them');
  check('and it is counted as off screen rather than out of range', p.stats.offscreen === 1, `${p.stats.offscreen}`);
  check('but it keeps walking, so panning back does not find it frozen',
    p.stats.posed + p.stats.strided >= 3, `${p.stats.posed} posed, ${p.stats.strided} strided`);

  // Inside the keep radius the frustum is ignored: its shadow is close enough to notice.
  check('a close creature off to the side is still drawn', close.group.visible);

  const before = side.walker.body.pos.z;
  for (let i = 0; i < 120; i++) p.update(1 / 60, camera);
  check('an off-screen creature still moves', Math.abs(side.walker.body.pos.z - before) > 1e-4);

  // Turning to face it brings it back without a respawn.
  camera.lookAt(150, 6, 60);
  camera.updateMatrixWorld(true);
  p.update(1 / 60, camera);
  check('turning toward it draws it again', side.group.visible);
  camera.lookAt(0, 6, 100);
  camera.updateMatrixWorld(true);
  p.dispose();
}

// ===================== casting =====================

{
  const p = createParkCreatures(deps());
  await p.ensureSpecies(SPECIES['025']);
  const a = p.spawn(resident('025', 0, 14, 1));
  const b = p.spawn(resident('025', 3, 15, 2));
  let casts = 0;
  for (let i = 0; i < 60 * 240; i++) p.update(1 / 60, camera, { cast: () => casts++ });
  check('creatures use moves over time', casts > 4, `${casts} casts in four minutes with two creatures`);

  let none = 0;
  for (let i = 0; i < 60 * 120; i++) p.update(1 / 60, camera, { cast: () => none++, castingEnabled: false });
  check('and stop when casting is turned off', none === 0);

  const o = p.castOrigin(a);
  const groundY = deps().terrainHeight(o.x, o.z);
  check('a move leaves from head height, not from the soles', o.y > groundY, `${o.y.toFixed(2)} vs ground ${groundY.toFixed(2)}`);
  check('and from where the caster actually is', Math.abs(o.x - a.walker.body.pos.x) < 1e-9);

  const target = p.nearest(a, 40);
  check('a caster can find a neighbour', target === b);
  check('and finds none when nothing is close', p.nearest(a, 0.5) === null);
  check('and never targets itself', p.nearest(a, 1e6) !== a);
  p.dispose();
}

// ===================== despawn =====================

{
  const p = createParkCreatures(deps());
  await p.ensureSpecies(SPECIES['019']);
  const a = p.spawn(resident('019', 0, 12, 1));
  const b = p.spawn(resident('019', 4, 12, 2));
  check('two individuals share one species parse', p.stats.loaded === 1);
  check('and do not share a skeleton', a.group !== b.group);

  const mat = [];
  a.group.traverse((o) => { if (o.isMesh) mat.push(o.material); });
  check('despawn removes it from the scene', p.despawn(a.id) && !a.group.parent);
  check('despawn of an unknown id is false, not a throw', p.despawn('nobody') === false);
  // Materials and geometry belong to the template; disposing on despawn would blank every sibling.
  check('and leaves the shared materials alone', mat.every((m) => !m.disposed) && !!b.group.parent);
  check('the live count follows', p.stats.live === 1, `${p.stats.live}`);
  p.dispose();
  check('dispose clears everything', p.stats.live === 0 && p.speciesCache.size === 0 && p.stats.failed === 0);
}

check('the defaults are ordered so a creature is drawn before it is dropped',
  CREATURE_DEFAULTS.idleDistance < CREATURE_DEFAULTS.strideDistance &&
  CREATURE_DEFAULTS.strideDistance < CREATURE_DEFAULTS.drawDistance);

park.dispose();

console.log(`\npark creature: ${pass}/${pass + fail} checks passed`);
if (park.warnings.length) console.log('  warnings: ' + park.warnings.join(' | '));
if (fail) {
  console.log('\nPROBLEMS:');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
