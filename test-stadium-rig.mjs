// Node checks for the Stadium model toolchain: the glb reader, the rig auto-mapper, and the walker's
// retarget. Run with `node test-stadium-rig.mjs`.
//
// The models are read straight out of `models/stadium/`, so this needs no ROM and no network. The walker
// half builds a real THREE scene graph — no renderer, no DOM — the same way `test-pose-retarget.mjs` does.

import fs from 'node:fs';
import * as THREE from 'three';
import { parseGLB, nodeWorldMatrices, readSkinnedVertices, readAccessor } from './stadium-glb.js';
import { mapStadiumRig, mapStadiumRigFromGLB, boneGeometry, pivotTree } from './stadium-rig-map.js';
import { createStadiumWalker, scaleGaitFroude, WALKER_DEFAULTS } from './stadium-walker.js';
import { createGaitMonitor, analyseGait, GAIT_LIMITS } from './gait-diagnostics.js';
import { GAITS } from './creature-locomotion.js';
import { STADIUM_REFERENCE_SPECIES, STADIUM_NO_LEG_SPECIES } from './stadium-reference-species.js';
import { loadStanceLibrary, nodeReader, mapSpeciesFromLibrary } from './stadium-species.js';
import { stancedSpecies } from './stadium-stance.js';

const STANCES = await loadStanceLibrary(nodeReader(fs));

let failures = 0;
const results = [];
function check(name, fn) {
  try {
    fn();
    results.push(`  ok   ${name}`);
  } catch (e) {
    failures++;
    results.push(`  FAIL ${name}\n       ${e.message}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function near(a, b, tol, msg) {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg}: ${a} vs ${b} (tol ${tol})`);
}

const MODELS = ['019_rattata', '058_growlithe', '077_ponyta', '128_tauros'];

// The set these assertions are about. See `stadium-reference-species.js` for why it is a list rather
// than a directory scan.
const WALKER_SPECIES = STADIUM_REFERENCE_SPECIES;
const load = (name) => fs.readFileSync(`models/stadium/${name}.glb`);

// Every walked check gets a seeded generator. The walker wanders to random targets, so an unseeded run
// makes a different creature take a different path each time — and a tolerance that passes on one path
// and fails on the next is not a test.
const seeded = (s) => () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// ===================== the glb reader =====================

check('parseGLB reads the JSON and BIN chunks', () => {
  const { json, bin } = parseGLB(load('019_rattata'));
  assert(json.asset.version === '2.0', 'not a glTF 2.0 asset');
  assert(bin && bin.byteLength > 1000, 'no binary chunk');
  assert(json.skins.length === 1, `expected one skin, got ${json.skins.length}`);
});

check('skinning is rigid — one bone per vertex at weight 1', () => {
  for (const name of MODELS) {
    const { json, bin } = parseGLB(load(name));
    for (const node of json.nodes) {
      if (node.mesh == null || node.skin == null) continue;
      for (const prim of json.meshes[node.mesh].primitives) {
        if (prim.attributes.WEIGHTS_0 == null) continue;
        const w = readAccessor(json, bin, prim.attributes.WEIGHTS_0);
        for (let i = 0; i < w.length; i += 4) {
          const max = Math.max(w[i], w[i + 1], w[i + 2], w[i + 3]);
          assert(max > 0.999, `${name}: vertex ${i / 4} has no dominant bone (max weight ${max})`);
        }
      }
    }
  }
});

check('every model stands on y=0 with a sane extent', () => {
  for (const name of MODELS) {
    const { json, bin } = parseGLB(load(name));
    const v = readSkinnedVertices(json, bin);
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < v.count; i++) { lo = Math.min(lo, v.position[i * 3 + 1]); hi = Math.max(hi, v.position[i * 3 + 1]); }
    near(lo, 0, 0.5, `${name} floor`);
    assert(hi > 15, `${name} is only ${hi.toFixed(1)} units tall`);
  }
});

check('the rig is two nodes per bone, skin bound to the childless leaf', () => {
  const { json } = parseGLB(load('019_rattata'));
  const ctx = nodeWorldMatrices(json);
  for (const j of json.skins[0].joints) {
    assert(!(json.nodes[j].children || []).length, `${json.nodes[j].name} is a bind target with children`);
    assert(/_scale$/.test(json.nodes[j].name), `${json.nodes[j].name} is not a _scale leaf`);
    assert(ctx.parent[j] >= 0, `${json.nodes[j].name} has no pivot parent`);
  }
});

// ===================== the auto-mapper =====================

check('all four reference quadrupeds map to four legs in two rows', () => {
  for (const name of MODELS) {
    const { map } = mapStadiumRigFromGLB(load(name), { source: name });
    assert(map.legs.length === 4, `${name}: ${map.legs.length} legs`);
    assert(new Set(map.legs.map(l => l.row)).size === 2, `${name}: ${new Set(map.legs.map(l => l.row)).size} rows`);
    assert(map.warnings.length === 0, `${name} warned: ${map.warnings.join(' | ')}`);
    assert(map.head, `${name}: no head`);
    assert(map.tail, `${name}: no tail`);
    assert(map.forward.axis === 'z' && map.forward.sign === 1, `${name} does not face +z`);
  }
});

check('legs are mirrored pairs, and each row has one of each side', () => {
  for (const name of MODELS) {
    const { map } = mapStadiumRigFromGLB(load(name));
    for (const row of new Set(map.legs.map(l => l.row))) {
      const inRow = map.legs.filter(l => l.row === row);
      assert(inRow.length === 2, `${name} row ${row} has ${inRow.length} legs`);
      const [a, b] = inRow;
      assert(a.side === -1 && b.side === 1, `${name} row ${row} sides are ${a.side}/${b.side}`);
      // Mirrored feet: x reflects, z and y match. Tolerance is a fraction of the model, since these are
      // posed models rather than symmetric bind poses.
      const tol = map.units.height * 0.12;
      near(a.foot.x, -b.foot.x, tol, `${name} row ${row} foot x`);
      near(a.foot.z, b.foot.z, tol, `${name} row ${row} foot z`);
    }
  }
});

check('placeAt moves the feet with the body, and the body bone is the rearmost attach', () => {
  const { json, bin } = parseGLB(load('019_rattata'));
  const map = mapStadiumRig(json, bin);
  const bodyLegs = map.legs.filter(l => l.attach === map.body);
  const otherLegs = map.legs.filter(l => l.attach !== map.body);
  assert(bodyLegs.length > 0, 'map.body is not a leg attach');
  assert(otherLegs.every(o => bodyLegs.every(b => b.hip.z < o.hip.z)), 'map.body is not the rearmost attach');
  const walker = createStadiumWalker({ THREE, scene: buildScene(map, json), map, worldHeight: 0.5 });
  walker.placeAt(3, -2, 0.7);
  for (const leg of walker.legs) {
    const dx = leg.end.x - walker.body.pos.x, dz = leg.end.z - walker.body.pos.z;
    assert(Math.hypot(dx, dz) < leg.span * 1.5, `${leg.name} foot left behind at spawn`);
    near(leg.target.x, leg.end.x, 1e-9, `${leg.name} target not on foot`);
  }
});

check('feet land on the floor and hips sit above them', () => {
  for (const name of MODELS) {
    const { map } = mapStadiumRigFromGLB(load(name));
    for (const leg of map.legs) {
      near(leg.foot.y, map.units.floorY, 0.01, `${name} ${leg.name} foot above floor`);
      assert(leg.hip.y > leg.foot.y + map.units.height * 0.05, `${name} ${leg.name} hip is not above its foot`);
      assert(leg.span > map.units.height * 0.1, `${name} ${leg.name} spans only ${leg.span.toFixed(1)}`);
      assert(leg.l1 > 0 && leg.l2 > 0, `${name} ${leg.name} has a zero-length bone (l1=${leg.l1}, l2=${leg.l2})`);
    }
  }
});

check('front row is forward of the back row', () => {
  for (const name of MODELS) {
    const { map } = mapStadiumRigFromGLB(load(name));
    const rowZ = (row) => map.legs.filter(l => l.row === row).reduce((s, l) => s + l.hip.z, 0) / 2;
    assert(rowZ(0) > rowZ(1), `${name}: row 0 at z=${rowZ(0).toFixed(1)} is not forward of row 1 at z=${rowZ(1).toFixed(1)}`);
  }
});

check('leg bones are disjoint, and none of them is a spine bone', () => {
  for (const name of MODELS) {
    const { map } = mapStadiumRigFromGLB(load(name));
    const seen = new Set();
    for (const leg of map.legs) {
      for (const b of leg.bones) {
        assert(!seen.has(b), `${name}: bone ${map.names[b]} is in two legs`);
        seen.add(b);
        assert(!map.spine.includes(b), `${name}: leg bone ${map.names[b]} is also a spine bone`);
      }
    }
  }
});

check('the pole vector points the way the leg was actually drawn', () => {
  // A measured pole must be perpendicular to the hip-to-foot chord and non-degenerate; that is what makes
  // the analytic solve reproduce the authored bend instead of inventing one.
  for (const name of MODELS) {
    const { map } = mapStadiumRigFromGLB(load(name));
    for (const leg of map.legs) {
      const chord = { x: leg.foot.x - leg.hip.x, y: leg.foot.y - leg.hip.y, z: leg.foot.z - leg.hip.z };
      const cl = Math.hypot(chord.x, chord.y, chord.z);
      const dot = (leg.pole.x * chord.x + leg.pole.y * chord.y + leg.pole.z * chord.z) / cl;
      near(dot, 0, 1e-6, `${name} ${leg.name} pole is not perpendicular to the chord`);
      near(Math.hypot(leg.pole.x, leg.pole.y, leg.pole.z), 1, 1e-6, `${name} ${leg.name} pole is not a unit vector`);
    }
  }
});

check('a legless body plan is reported, not guessed at', () => {
  // Rattata with the floor band shut down has nothing that can qualify as a foot. The mapper must say so
  // rather than promote the nearest low thing, because a silently wrong leg is worse than none.
  const { json, bin } = parseGLB(load('019_rattata'));
  const map = mapStadiumRig(json, bin, { legFloorFraction: 0.0001 });
  assert(map.legs.length === 0, `expected no legs, got ${map.legs.length}`);
  assert(map.warnings.some(w => /cannot walk on legs/.test(w)), `expected a no-legs warning, got ${map.warnings}`);
});

check('an override replaces what the heuristics decided', () => {
  const { json, bin } = parseGLB(load('019_rattata'));
  const map = mapStadiumRig(json, bin, { override: { legs: [], warnings: ['hand-mapped'] } });
  assert(map.legs.length === 0, 'override did not replace the legs');
  assert(map.warnings.includes('hand-mapped'), 'override warnings were dropped');
});

// ===================== the retarget =====================

function buildScene(map, json) {
  // A stand-in for GLTFLoader's output: one Object3D per glTF node, named and parented the same way, with
  // the same local transforms. That is all the walker touches, so a real loader adds nothing here.
  const objs = json.nodes.map((n) => {
    const o = new THREE.Object3D();
    o.name = n.name || '';
    if (n.translation) o.position.fromArray(n.translation);
    if (n.rotation) o.quaternion.fromArray(n.rotation);
    if (n.scale) o.scale.fromArray(n.scale);
    if (n.matrix) {
      o.matrix.fromArray(n.matrix);
      o.matrix.decompose(o.position, o.quaternion, o.scale);
    }
    return o;
  });
  json.nodes.forEach((n, i) => { for (const c of n.children || []) objs[i].add(objs[c]); });
  const root = new THREE.Group();
  for (const r of json.scenes[0].nodes) root.add(objs[r]);
  return root;
}

check('the walker builds, and the rig it drives is the one the map named', () => {
  const { json, bin } = parseGLB(load('019_rattata'));
  const map = mapStadiumRig(json, bin);
  const walker = createStadiumWalker({ THREE, scene: buildScene(map, json), map, worldHeight: 0.5 });
  assert(walker.legs.length === 4, `walker has ${walker.legs.length} legs`);
  near(walker.unitScale * map.units.height, 0.5, 1e-9, 'world height');
  // The diagonal pairs a quadruped trots on: front-left shares a phase with hind-right.
  const phase = (row, side) => walker.legs.find(l => l.row === row && l.side === side).phase;
  assert(phase(0, -1) === phase(1, 1), 'front-left and hind-right are not on the same phase');
  assert(phase(0, -1) !== phase(0, 1), 'both front legs are on the same phase');
});

check('the gait is Froude-scaled, not just multiplied', () => {
  const g = { maxSpeed: 1, turnSpeed: 1, stepDuration: 1, stepLift: 1, samePairCooldown: 1, crossPairCooldown: 1,
    stationaryTrigger: { h: 1, v: 1 }, movingTrigger: { h: 1, v: 1 }, comfort: { h: 1, v: 1 } };
  const s = 0.25;
  const out = scaleGaitFroude(g, s);
  near(out.stepLift, s, 1e-9, 'a length scales as s');
  near(out.comfort.h, s, 1e-9, 'a length scales as s');
  near(out.maxSpeed, Math.sqrt(s), 1e-9, 'speed scales as sqrt(s)');
  near(out.stepDuration, Math.sqrt(s), 1e-9, 'time scales as sqrt(s)');
  near(out.turnSpeed, 1 / Math.sqrt(s), 1e-9, 'angular rate scales as 1/sqrt(s)');
});

check('a walked gait cycle keeps every foot on the ground when it is planted', () => {
  // The assertion the whole demo rests on, and the same one `demos/sdf-bug-v2` makes: across a full run,
  // a foot that is not mid-step is standing on the ground, not hovering above it or buried in it.
  const { json, bin } = parseGLB(load('019_rattata'));
  const map = mapStadiumRig(json, bin);
  const walker = createStadiumWalker({
    THREE, scene: buildScene(map, json), map, worldHeight: 0.5,
    rng: seeded(12345),
  });
  let worst = 0, samples = 0, stepped = 0;
  for (let i = 0; i < 900; i++) {
    walker.fixedStep(1 / 60, true);
    for (const f of walker.footContactError()) {
      if (f.stepping) { stepped++; continue; }
      worst = Math.max(worst, Math.abs(f.error));
      samples++;
    }
  }
  assert(samples > 2000, `only ${samples} planted-foot samples`);
  assert(stepped > 200, `feet only stepped ${stepped} times in 15 s — this creature is not walking`);
  assert(worst < 0.01, `a planted foot was ${(worst * 1000).toFixed(1)} mm off the ground`);
});

check('the creature actually travels, and stays the right height off the floor', () => {
  const { json, bin } = parseGLB(load('019_rattata'));
  const map = mapStadiumRig(json, bin);
  const walker = createStadiumWalker({
    THREE, scene: buildScene(map, json), map, worldHeight: 0.5, roamRadius: 4,
    rng: seeded(777),
  });
  const start = walker.body.pos.clone();
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < 900; i++) {
    walker.fixedStep(1 / 60, true);
    minY = Math.min(minY, walker.body.pos.y);
    maxY = Math.max(maxY, walker.body.pos.y);
  }
  const travelled = Math.hypot(walker.body.pos.x - start.x, walker.body.pos.z - start.z);
  assert(travelled > 0.5, `travelled only ${travelled.toFixed(2)} m in 15 s`);
  // The body must carry itself the whole way. It sinks when too many feet leave the ground at once — two
  // grounded feet are a line, the support polygon collapses, and the creature drops onto the hard floor
  // under it and takes seconds to climb back out. Measured across four models and eight seeds with the
  // current settings, it never goes below 88% of its ride height.
  const ride = map.rideHeight * walker.unitScale;
  assert(minY > ride * 0.8, `body sank to ${minY.toFixed(3)} against a ride height of ${ride.toFixed(3)}`);
  assert(maxY < ride * 1.2, `body rose to ${maxY.toFixed(3)} against a ride height of ${ride.toFixed(3)}`);
});

check('the DRAWN foot goes where the gait put it, on every model and every seed', () => {
  // The retarget's own correctness check, and the reason it writes world matrices instead of rotations:
  // after `applyPose`, the FOOT BONE'S GEOMETRY — not its origin — has to sit at the solved foot position.
  //
  // Planted and airborne feet are held to different standards on purpose. A planted foot that is not
  // where the gait believes it is IS the skating artefact, so it gets a tight bound. A foot mid-step is
  // arcing through the air and can briefly ask for a pose slightly outside the leg's annulus; the solver
  // answers by staying bent and falling short, which nobody can see.
  //
  // The planted bound is on the DISTRIBUTION rather than on the worst sample, because the worst sample is
  // a rare event rather than a tolerance. Measured over four models, eight seeds and ~10,000 samples: the
  // median and the 95th percentile are both 0.00% — the drawn foot is exactly where the gait put it — and
  // fewer than 0.3% of samples exceed 5%, with the outliers concentrated on the two straightest-legged
  // models. When a turn does push a leg past what it can span, the solver holds the foot short for a frame
  // or two rather than snapping the leg straight, which is the better of the two wrong answers.
  const restInv = new THREE.Matrix4();
  for (const name of MODELS) {
    const { json, bin } = parseGLB(load(name));
    const map = mapStadiumRig(json, bin);
    const planted = [];
    let worstStepping = 0, samples = 0;
    for (let seed = 1; seed <= 4; seed++) {
      const scene = buildScene(map, json);
      const walker = createStadiumWalker({ THREE, scene, map, worldHeight: 0.5, rng: seeded(seed * 977) });
      for (let i = 0; i < 600; i++) {
        walker.fixedStep(1 / 60, true);
        if (i % 15 || i < 120) continue;   // sample past the settle-in from the spawn pose
        walker.applyPose();
        for (const leg of walker.legs) {
          const mapped = map.legs[leg.index];
          const footBone = mapped.bones[mapped.bones.length - 1];
          const obj = scene.getObjectByName(map.names[footBone]);
          assert(obj, `${name}: foot bone ${map.names[footBone]} missing from the scene`);
          restInv.fromArray(map.restWorld[footBone]).invert();
          const sole = new THREE.Vector3(mapped.foot.x, mapped.foot.y, mapped.foot.z)
            .applyMatrix4(restInv).applyMatrix4(obj.matrixWorld);
          const ratio = sole.distanceTo(leg.end) / leg.span;
          samples++;
          if (leg.stepping) worstStepping = Math.max(worstStepping, ratio);
          else planted.push(ratio);
        }
      }
    }
    assert(samples > 500, `${name}: only ${samples} samples`);
    planted.sort((a, b) => a - b);
    const p = (q) => planted[Math.min(planted.length - 1, Math.floor(planted.length * q))];
    const strays = planted.filter(r => r > 0.05).length / planted.length;
    assert(p(0.95) < 0.01,
      `${name}: 5% of planted feet were drawn more than ${(p(0.95) * 100).toFixed(1)}% of a leg from where the gait planted them`);
    assert(strays < 0.005,
      `${name}: ${(strays * 100).toFixed(2)}% of planted samples were off by more than 5% of a leg`);
    assert(worstStepping < 0.25,
      `${name}: a foot mid-step was drawn ${(worstStepping * 100).toFixed(1)}% of a leg from its arc`);
  }
});

check('driven bones keep their rest segment lengths', () => {
  // Writing world matrices could stretch a limb if the solve and the placement disagreed. Measure the
  // hip-to-knee and knee-to-sole distances after a pose and compare them with the rest lengths.
  const { json, bin } = parseGLB(load('019_rattata'));
  const map = mapStadiumRig(json, bin);
  const scene = buildScene(map, json);
  const walker = createStadiumWalker({ THREE, scene, map, worldHeight: 0.5, rng: seeded(99) });
  for (let i = 0; i < 300; i++) walker.fixedStep(1 / 60, true);
  walker.applyPose();

  for (const leg of walker.legs) {
    const mapped = map.legs[leg.index];
    const point = (nodeId, world) => {
      const inv = new THREE.Matrix4().fromArray(map.restWorld[nodeId]).invert();
      const local = new THREE.Vector3(world.x, world.y, world.z).applyMatrix4(inv);
      return local.applyMatrix4(scene.getObjectByName(map.names[nodeId]).matrixWorld);
    };
    const upperBone = mapped.bones[0];
    const lowerBone = mapped.bones[mapped.bones.length - 1];
    const hipNow = point(upperBone, mapped.hip);
    const kneeNow = point(upperBone, mapped.knee);
    const kneeLower = point(lowerBone, mapped.knee);
    const footNow = point(lowerBone, mapped.foot);
    near(hipNow.distanceTo(kneeNow), leg.l1, leg.l1 * 0.02, `${mapped.name} upper segment length`);
    near(kneeLower.distanceTo(footNow), leg.l2, leg.l2 * 0.02, `${mapped.name} lower segment length`);
  }
});

check('retune re-derives the gait without rebuilding the rig', () => {
  // The panel's whole premise: these numbers interact, and you find that out by dragging one. Standing
  // straighter must cost stride, and a smaller stride must cost top speed.
  const { json, bin } = parseGLB(load('019_rattata'));
  const map = mapStadiumRig(json, bin);
  const walker = createStadiumWalker({ THREE, scene: buildScene(map, json), map, worldHeight: 0.5, rng: seeded(5) });
  const before = { h: walker.state.heightScale, env: walker.state.strideEnvelope, v: walker.state.gait.maxSpeed };

  walker.retune({ standExtension: 0.99 });
  assert(walker.state.heightScale > before.h, 'standing straighter did not raise the body');
  assert(walker.state.strideEnvelope < before.env, 'standing straighter did not cost stride');
  assert(walker.state.gait.maxSpeed < before.v, 'a shorter stride did not cost top speed');

  walker.retune({ standExtension: 0.90 });
  near(walker.state.heightScale, before.h, 1e-9, 'retune is not reversible');
  near(walker.state.strideEnvelope, before.env, 1e-9, 'retune is not reversible');

  // And the rig itself is untouched: same leg objects, same bone lengths, still walking.
  const legs = walker.legs;
  for (let i = 0; i < 120; i++) walker.fixedStep(1 / 60, true);
  assert(walker.legs === legs, 'retune replaced the leg objects');
  for (const f of walker.footContactError()) {
    if (!f.stepping) near(f.error, 0, 0.01, 'a planted foot left the ground after a retune');
  }
});

check('retune swaps the ground under a walking creature', () => {
  const { json, bin } = parseGLB(load('019_rattata'));
  const map = mapStadiumRig(json, bin);
  const walker = createStadiumWalker({ THREE, scene: buildScene(map, json), map, worldHeight: 0.5, rng: seeded(6) });
  for (let i = 0; i < 180; i++) walker.fixedStep(1 / 60, true);

  const slope = (x, z) => 0.05 * Math.sin(x * 2) + 0.03 * z;
  walker.retune({ terrainHeight: slope });
  for (let i = 0; i < 300; i++) walker.fixedStep(1 / 60, true);
  let checked = 0;
  for (const f of walker.footContactError()) {
    if (f.stepping) continue;
    near(f.error, 0, 0.01, 'a planted foot is not on the new ground');
    checked++;
  }
  assert(checked > 0, 'no planted feet to check');
  // The body has to have followed the ground up or down rather than staying at its old altitude.
  const under = slope(walker.body.pos.x, walker.body.pos.z);
  const ride = map.rideHeight * walker.unitScale;
  assert(Math.abs((walker.body.pos.y - under) - ride) < ride * 0.35,
    `body is ${(walker.body.pos.y - under).toFixed(3)} above ground against a ride height of ${ride.toFixed(3)}`);
});

check('every shipped species walks, whatever the mapper made of it', () => {
  // The dropdown in `demos/stadium-walker.html` is exactly this list, so a species that cannot stand up
  // is a broken demo entry rather than a curiosity.
  const shipped = WALKER_SPECIES.map(n => `${n}.glb`);
  assert(shipped.length >= 12, `only ${shipped.length} models are on the walker list`);
  for (const file of shipped) {
    assert(fs.existsSync(`models/stadium/${file}`), `${file} is on the walker list but not on disk`);
  }
  for (const file of shipped) {
    const { json, bin } = parseGLB(fs.readFileSync(`models/stadium/${file}`));
    const map = mapStadiumRig(json, bin);
    assert(map.legs.length > 0, `${file}: mapped with no legs`);
    const walker = createStadiumWalker({ THREE, scene: buildScene(map, json), map, worldHeight: 0.5, rng: seeded(31) });
    const target = map.rideHeight * walker.unitScale * walker.state.heightScale;
    let sum = 0, n = 0, steps = 0;
    const was = walker.legs.map(() => false);
    // PATH LENGTH IN LEG SPANS, not net displacement in metres, and both halves of that matter. Net
    // displacement scores a roaming creature on how straight its random targets happened to point, so a
    // slower creature is penalised twice — once for being slow and again for having more time to turn.
    // And metres are not comparable across rigs whose legs differ by a factor of four: 0.3 m was 1.9 leg
    // spans for Rattata and 0.76 for Paras, so the old threshold quietly asked much more of the small
    // models. This asks every model the same thing: did it carry itself its own length, several times.
    let path = 0;
    let prev = { x: walker.body.pos.x, z: walker.body.pos.z };
    for (let i = 0; i < 600; i++) {
      walker.fixedStep(1 / 60, true);
      walker.legs.forEach((l, k) => { if (l.stepping && !was[k]) steps++; was[k] = l.stepping; });
      path += Math.hypot(walker.body.pos.x - prev.x, walker.body.pos.z - prev.z);
      prev = { x: walker.body.pos.x, z: walker.body.pos.z };
      if (i <= 60) continue;
      sum += walker.body.pos.y; n++;
    }
    const held = sum / n / target;
    assert(held > 0.85 && held < 1.15, `${file}: carried itself at ${(held * 100).toFixed(0)}% of its ride height`);
    assert(steps > 20, `${file}: only ${steps} steps in 10 s`);
    const spans = path / (map.legs.reduce((m, l) => Math.max(m, l.l1 + l.l2), 0) * walker.unitScale);
    assert(spans > 1.5, `${file}: covered ${spans.toFixed(2)} leg spans in 10 s`);
  }
});

check('the legless list still matches what the mapper actually finds, across all 151', () => {
  // The walker's dropdown offers all 151 and labels these as needing hand-assigned roles. If the mapper
  // improves, this fails and the list wants regenerating rather than the page quietly lying about them.
  const files = fs.readdirSync('models/stadium').filter(f => f.endsWith('.glb')).sort();
  assert(files.length === 151, `expected 151 models, found ${files.length}`);
  const found = [];
  for (const f of files) {
    const species = f.replace('.glb', '');
    const { json, bin } = parseGLB(fs.readFileSync(`models/stadium/${f}`));
    if (!mapStadiumRig(json, bin, { source: species }).legs.length) found.push(species);
  }
  const listed = [...STADIUM_NO_LEG_SPECIES].sort();
  const missing = found.filter(s => !listed.includes(s));
  const stale = listed.filter(s => !found.includes(s));
  assert(!missing.length, `maps with no legs but not listed: ${missing.join(', ')}`);
  assert(!stale.length, `listed as legless but now maps with legs: ${stale.join(', ')}`);
  console.log(`       ${found.length} of 151 need hand-assigned legs`);
});

check('every species with an authored stance still stands up in it', () => {
  // Stances are authoritative — the walker page edits them and everything else obeys — so a stance that
  // stops a creature standing has to fail here rather than surface later as a limp nobody can explain.
  // Silent when nothing is authored yet, which is the ordinary state of a fresh clone.
  const stanced = stancedSpecies(STANCES);
  if (!stanced.length) { console.log('       no stances authored yet'); return; }
  const held = [];
  for (const species of stanced) {
    const file = `models/stadium/${species}.glb`;
    assert(fs.existsSync(file), `${species} has a stance but no model on disk`);
    const { json, bin } = parseGLB(fs.readFileSync(file));
    const out = mapSpeciesFromLibrary(json, bin, species, STANCES);
    assert(out.map.legs.length > 0, `${species}: its stance leaves it with no legs`);
    for (const w of out.warnings) {
      assert(!/leg count/.test(w), `${species}: ${w}`);
    }
    const walker = createStadiumWalker({
      THREE, scene: buildScene(out.map, out.json), map: out.map, worldHeight: 0.5, rng: seeded(31),
    });
    const target = out.map.rideHeight * walker.unitScale * walker.state.heightScale;
    let sum = 0, n = 0, steps = 0;
    const was = walker.legs.map(() => false);
    for (let i = 0; i < 600; i++) {
      walker.fixedStep(1 / 60, true);
      walker.legs.forEach((l, k) => { if (l.stepping && !was[k]) steps++; was[k] = l.stepping; });
      if (i <= 60) continue;
      sum += walker.body.pos.y; n++;
    }
    const ratio = sum / n / target;
    assert(ratio > 0.85 && ratio < 1.15, `${species}: its stance carries it at ${(ratio * 100).toFixed(0)}% of ride height`);
    assert(steps > 20, `${species}: only ${steps} steps in 10 s under its stance`);
    held.push(`${species.slice(4)} ${(ratio * 100).toFixed(0)}%`);
  }
  console.log(`       stances walked: ${held.join(', ')}`);
});

check('the walker leaves the spine, head and tail bones alone', () => {
  // Legs are procedural; everything else stays free so a ROM clip can play on it at the same time.
  const { json, bin } = parseGLB(load('019_rattata'));
  const map = mapStadiumRig(json, bin);
  const scene = buildScene(map, json);
  const walker = createStadiumWalker({ THREE, scene, map, worldHeight: 0.5, rng: seeded(31) });
  const watch = [...map.spine, ...(map.head?.bones ?? []), ...(map.tail?.bones ?? [])];
  const before = watch.map(b => scene.getObjectByName(map.names[b]).position.clone());
  for (let i = 0; i < 120; i++) walker.fixedStep(1 / 60, true);
  walker.applyPose();
  watch.forEach((b, i) => {
    const now = scene.getObjectByName(map.names[b]).position;
    near(now.distanceTo(before[i]), 0, 1e-9, `${map.names[b]} was moved by the walker`);
  });
});

// ===================== gait failure modes =====================
//
// These pin the conclusions of the `sweep-gait.mjs` parameter sweep so they cannot quietly drift back.
// Each one is a number that was measured, not a number that was chosen; the comments say which sweep.

const ALL_SPECIES = WALKER_SPECIES;

/** Walk one species headless and score its feet. */
function walkAndScore(species, tune = {}, { seconds = 12, seed = 7, ground = () => 0 } = {}) {
  const { json, bin } = parseGLB(load(species));
  const map = mapStadiumRig(json, bin);
  if (!map.legs.length) return null;
  const walker = createStadiumWalker({
    THREE, scene: buildScene(map, json), map, worldHeight: 0.5, terrainHeight: ground, rng: seeded(seed),
  });
  if (Object.keys(tune).length) walker.retune(tune);
  for (let t = 0; t < 2; t += 1 / 60) walker.update(1 / 60, { walk: false });
  const mon = createGaitMonitor();
  for (let t = 0; t < seconds; t += 1 / 60) {
    walker.update(1 / 60);
    mon.sample(walker.diagnosticFrame());
  }
  const r = mon.report();
  if (r) r.species = species;
  return r;
}

check('the re-step guard scales with the creature instead of being a flat 0.1 m', () => {
  // `canWalkLegMove` falls back to a literal 0.1 m when the gait does not carry `restepEpsilon`, and that
  // is a fifth of a Rattata's whole leg. The walker has to set it, or no leg may step until the body has
  // dragged it 100 mm — which is exactly what eight of the fourteen shipped models were doing, all with a
  // median step of 100-104 mm whatever their size.
  for (const species of ['019_rattata', '128_tauros', '025_pikachu']) {
    const { json, bin } = parseGLB(load(species));
    const map = mapStadiumRig(json, bin);
    const walker = createStadiumWalker({ THREE, scene: buildScene(map, json), map, worldHeight: 0.5 });
    const eps = walker.state.gait.restepEpsilon;
    assert(eps != null, `${species}: no restepEpsilon, so the flat 0.1 m fallback applies`);
    assert(Math.abs(eps - 0.1) > 1e-9, `${species}: restepEpsilon is the unscaled 0.1 m default`);
    near(eps, walker.state.strideEnvelope * walker.tuning.restepFraction, 1e-9,
      `${species}: restepEpsilon is not derived from this creature's own stride envelope`);
  }
});

check('footholds are placed inside the reach that flags a leg as stressed', () => {
  // `reachMargin` bounds where a foot MAY be put; `reachStress` is where a planted foot starts asking to
  // step. With the margin above the stress threshold, every fresh foothold is born already overextended.
  // It shipped that way — 0.92 against 0.90.
  assert(WALKER_DEFAULTS.reachMargin < WALKER_DEFAULTS.reachStress,
    `reachMargin ${WALKER_DEFAULTS.reachMargin} is not below reachStress ${WALKER_DEFAULTS.reachStress}, `
    + 'so a foot can be placed already flagged as overextended');
});

check('no shipped species drags its planted feet at the defaults', () => {
  // Dragging here means the RENDERED foot slides while the gait believes it is planted. Measured after the
  // sweep: clamped planted frames run 0.0% to 2.0% across the fourteen models, against 0% to 35% before.
  // The two bipeds Pikachu and Charizard still trip the per-frame skate test at about 13% of planted
  // frames, and that is a support-polygon limitation rather than a scheduling one — a biped standing on
  // one or two feet has no polygon to balance over — so they are named rather than silently tolerated.
  const KNOWN_BIPED_SKATERS = ['025_pikachu', '006_charizard'];
  const bad = [];
  for (const species of ALL_SPECIES) {
    const r = walkAndScore(species);
    if (!r) continue;
    assert(r.dragging.clampedFraction < 0.05,
      `${species}: solver clamped ${(r.dragging.clampedFraction * 100).toFixed(1)}% of planted frames`);
    if (r.verdict.dragging && !KNOWN_BIPED_SKATERS.includes(species)) bad.push(species);
  }
  assert(!bad.length, `these dragged and are not on the known list: ${bad.join(', ')}`);
});

check('no step is shorter than the frames an arc needs to be drawn in', () => {
  // The artefact this pins down is a rendering one, not a scheduling one. `advanceLeg` lerps the foot
  // along its arc and adds a half-sine lift, so a step lasting 2.8 frames is drawn with two interior
  // samples and comes out as a triangular spike — a leg that appears to teleport rather than swing.
  // Measured before the floors went in: 3.7 to 7.1 frames at a walk and 2.8 to 5.3 at a gallop.
  for (const gaitName of ['walk', 'gallop']) {
    for (const species of ALL_SPECIES) {
      const { json, bin } = parseGLB(load(species));
      const map = mapStadiumRig(json, bin);
      if (!map.legs.length) continue;
      const walker = createStadiumWalker({
        THREE, scene: buildScene(map, json), map, worldHeight: 0.5, rng: seeded(7), gait: GAITS[gaitName],
      });
      const frames = walker.state.gait.stepDuration * 60;
      assert(frames >= 6, `${species} at a ${gaitName}: a step lasts ${frames.toFixed(1)} frames`);
    }
  }
});

check('a leg may not cycle faster than a leg that size plausibly can', () => {
  // The dimensionless stride frequency, `stepRate x sqrt(span/g)`, which is what makes rates comparable
  // across models differing threefold in size. Real animals run about 0.2-0.4 walking and up to roughly
  // 0.6 at a gallop. Measured before the floors: walk 0.25-0.54 and gallop 0.68-1.00, so the gallop was
  // off the top of the biological range entirely. This is the SCHEDULER's allowance, so it also catches
  // someone raising `concurrentScale` far enough to reintroduce the problem from the other side.
  for (const species of ALL_SPECIES) {
    const { json, bin } = parseGLB(load(species));
    const map = mapStadiumRig(json, bin);
    if (!map.legs.length) continue;
    const walker = createStadiumWalker({
      THREE, scene: buildScene(map, json), map, worldHeight: 0.5, rng: seeded(7), gait: GAITS.gallop,
    });
    const g = walker.state.gait;
    const concurrent = Math.max(1, Math.floor(map.legs.length * g.maxConcurrentFraction));
    const span = map.legs.reduce((m, l) => Math.max(m, l.l1 + l.l2), 0) * walker.unitScale;
    const strideNumber = (concurrent / (g.stepDuration * map.legs.length)) * Math.sqrt(span / 9.81);
    assert(strideNumber <= 0.55, `${species}: stride number ${strideNumber.toFixed(2)} at a gallop`);
  }
});

check('a re-step guard under one stride envelope makes the feet drag', () => {
  // The failure boundary itself, so that the default cannot be lowered back under it without a test
  // saying why. Swept 0.02 to 5: dragging holds at 11-13 of 14 species below 0.7 and drops to 4 at 1.2.
  const tight = ALL_SPECIES.map(s => walkAndScore(s, { restepFraction: 0.1 }, { seconds: 8 })).filter(Boolean);
  const loose = ALL_SPECIES.map(s => walkAndScore(s, { restepFraction: 1.2 }, { seconds: 8 })).filter(Boolean);
  const dragged = (rows) => rows.filter(r => r.verdict.dragging).length;
  assert(dragged(tight) > dragged(loose) + 3,
    `a tight re-step guard should drag far more, got ${dragged(tight)} vs ${dragged(loose)} of ${tight.length}`);
});

check('the support normal cannot drive the body past the speed its legs can cycle at', () => {
  // The balance model's sideways component was unbounded, and against H_DRAG it settles near 24 m/s on
  // creatures whose gait tops out around 0.1 m/s. Ivysaur and Seel ran at 189% and 208% of their own top
  // speed and clamped 58-65% of planted frames because no arrangement of the feet keeps up with that.
  for (const species of ['002_ivysaur', '086_seel']) {
    const r = walkAndScore(species);
    assert(r.speedVsMax < 1.25,
      `${species}: body averaged ${(r.speedVsMax * 100).toFixed(0)}% of its own top speed`);
  }
  // ...and unbounding it again brings the overspeed back, so the bound is what is doing the work.
  const loose = walkAndScore('086_seel', { supportPushLimit: 99 });
  assert(loose.speedVsMax > 1.4,
    `removing the bound should restore the overspeed, got ${(loose.speedVsMax * 100).toFixed(0)}%`);
});

check('tapping stays out of reach even with every source of hysteresis removed', () => {
  // Three things stop a leg re-lifting the moment it lands: the concurrency cap, the turn-taking
  // cooldowns and the re-step guard. With all three off, tapping still does not appear — because
  // `advanceLeg` copies `stepEnd` into `leg.end` on landing and the trigger measures distance to the
  // TARGET, so a foot that has just landed is at zero error by construction.
  //
  // The check that makes this worth having is the second half: both halves of the tap condition must
  // still be REACHABLE on their own, or a clean result would just mean the detector is dead.
  // Two grounds, because the halves fire in different places: short stances come from loosening the
  // scheduler on flat ground, and short steps only appear on ground rough enough that the foothold scan
  // re-places a foot in nearly the spot it came from.
  const loose = { restepFraction: 0.001, cooldownScale: 0, concurrentScale: 4 };
  const savage = (x, z) => 0.15 * (Math.sin(x / 0.06) * Math.sin(z / 0.06) + 0.5 * Math.sin((x + z) / 0.022));
  let sawShortStance = 0, sawShortTravel = 0;
  for (const ground of [() => 0, savage]) {
    for (const species of ALL_SPECIES) {
      const r = walkAndScore(species, loose, { seconds: 8, ground });
      if (!r) continue;
      assert(!r.verdict.tapping, `${species}: tapping appeared at ${r.tapping.worstLegRate.toFixed(2)}/s`);
      if (r.tapping.shortStanceFraction > 0) sawShortStance++;
      if (r.tapping.shortTravelFraction > 0) sawShortTravel++;
    }
  }
  assert(sawShortStance > 0, 'no species ever took a short stance, so the stance half of the detector is dead');
  assert(sawShortTravel > 0, 'no species ever took a short step, so the travel half of the detector is dead');
});

// ===================== the stray gate =====================

/** Walk one species and hand back both the report and the walker's own gate counters. */
function walkWithGate(species, tune = {}, { seconds = 10, seed = 7 } = {}) {
  const { json, bin } = parseGLB(load(species));
  const map = mapStadiumRig(json, bin);
  const walker = createStadiumWalker({ THREE, scene: buildScene(map, json), map, worldHeight: 0.5, rng: seeded(seed) });
  walker.retune(tune);
  for (let t = 0; t < 2; t += 1 / 60) walker.update(1 / 60, { walk: false });
  const mon = createGaitMonitor();
  for (let t = 0; t < seconds; t += 1 / 60) { walker.update(1 / 60); mon.sample(walker.diagnosticFrame()); }
  const s = walker.state;
  return { report: mon.report(), strayFrames: s.strayFrames, forced: s.strayForced,
           accepted: s.strayAccepted, throttled: s.strayThrottled, landings: s.landings };
}

check('the gate judges planted frames, because a landing cannot be off-target', () => {
  // The measurement that decided where the gate runs. A foothold is clamped inside the leg's reach by
  // `clampTargetToLimits` before the step starts, so it lands reachable BY CONSTRUCTION: a gate that
  // checked only the frame a foot touched down caught zero strays across five deliberately broken
  // regimes, including ones where drawn feet were off-target on 97% of planted frames. The error is
  // accumulated during the stance, as the body walks over a foot that is standing still.
  const r = walkWithGate('077_ponyta', { speedScale: 2 });
  assert(r.landings > 40, `expected plenty of landings, got ${r.landings}`);
  assert(r.strayFrames > 100, `expected the overspeed regime to stray, got ${r.strayFrames} frames`);
  // The landing frames are a small fraction of the planted frames the gate catches, which is the same
  // fact from the other side: strays are a stance phenomenon.
  assert(r.strayFrames > r.landings, 'strays should outnumber landings, or they are a landing artefact');
});

check('the gate is silent at the shipped defaults', () => {
  // If turning it on changed the walk of a healthy creature, it would be a tuning knob rather than a
  // guard, and every number measured before it existed would need re-measuring.
  for (const species of MODELS) {
    const off = walkWithGate(species, { strayMode: 'off' });
    for (const mode of ['restep', 'accept', 'slow']) {
      const on = walkWithGate(species, { strayMode: mode });
      near(on.report.dragging.worstLegFraction, off.report.dragging.worstLegFraction, 0.02,
        `${species}: mode ${mode} changed skating at the defaults`);
    }
  }
});

check('only slowing the body helps a creature whose feet cannot keep up', () => {
  // The result that decides which mode is worth using, and the reason `off` is the default.
  //
  // At double the top speed the body outruns its own stride budget — an arithmetic overrun that no
  // foot-placement rule can answer. `restep` and `accept` both drive the stray count to nearly nothing,
  // because accepting the drawn foot is what "no stray" MEANS, and both leave the leg parked at its reach
  // limit where it is dragged from. `slow` hands the stray to the machinery that already exists for a leg
  // that cannot keep up, and is the only one that reduces the sliding.
  const fast = { speedScale: 2 };
  const off = walkWithGate('025_pikachu', { ...fast, strayMode: 'off' });
  const slow = walkWithGate('025_pikachu', { ...fast, strayMode: 'slow' });
  const accept = walkWithGate('025_pikachu', { ...fast, strayMode: 'accept' });
  assert(slow.report.dragging.worstLegFraction < off.report.dragging.worstLegFraction - 0.1,
    `slow should cut skating, went ${(off.report.dragging.worstLegFraction * 100).toFixed(0)}%`
    + ` to ${(slow.report.dragging.worstLegFraction * 100).toFixed(0)}%`);
  assert(accept.report.dragging.worstLegFraction > off.report.dragging.worstLegFraction,
    'accept should make the sliding worse, not better — if it stops doing that, re-read the mode advice');
  // ...and it silences its own metric while doing so, which is the trap the pairing above exists to catch.
  assert(accept.report.dragging.strayFraction < 0.01,
    `accept should zero the stray count, got ${(accept.report.dragging.strayFraction * 100).toFixed(1)}%`);
});

check('a re-step loop terminates', () => {
  // `restep` falls through to `accept` after `strayRetries` misses. Without that a leg whose target is
  // simply unreachable is lifted, lands strayed, and is lifted again forever.
  const r = walkWithGate('077_ponyta', { speedScale: 2, strayMode: 'restep' });
  assert(r.forced > 0, 'no re-step was ever forced, so the mode is dead');
  assert(r.accepted > 0, 'nothing ever fell through to accept, so the retry cap is not doing its job');
  assert(r.report.tapping.stepRate > 0.1,
    `the creature stopped stepping at ${r.report.tapping.stepRate.toFixed(2)}/s — the loop is starving it`);
});

check('the gate threshold and the reported threshold are one number', () => {
  // A panel whose "5% of frames strayed" was counted against a different limit from the one the sim was
  // enforcing would stay plausible and mean nothing, so the default has to match on both sides.
  assert(WALKER_DEFAULTS.strayLimit === GAIT_LIMITS.strayFraction,
    `walker gates at ${WALKER_DEFAULTS.strayLimit} and the report counts at ${GAIT_LIMITS.strayFraction}`);
  // ...and the report side honours an override, which is what the demo's slider relies on.
  const { json, bin } = parseGLB(load('077_ponyta'));
  const map = mapStadiumRig(json, bin);
  const walker = createStadiumWalker({ THREE, scene: buildScene(map, json), map, worldHeight: 0.5, rng: seeded(7) });
  walker.retune({ speedScale: 2 });
  const frames = [];
  for (let t = 0; t < 2; t += 1 / 60) walker.update(1 / 60, { walk: false });
  for (let t = 0; t < 8; t += 1 / 60) { walker.update(1 / 60); frames.push(walker.diagnosticFrame()); }
  const tight = analyseGait(frames, { strayFraction: 0.01 });
  const loose = analyseGait(frames, { strayFraction: 0.5 });
  assert(tight.dragging.strayFraction > loose.dragging.strayFraction,
    `a tighter threshold must count more strays, got ${tight.dragging.strayFraction} vs ${loose.dragging.strayFraction}`);
});

console.log('stadium rig toolchain');
console.log(results.join('\n'));
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
