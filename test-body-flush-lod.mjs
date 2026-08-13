// test-body-flush-lod.mjs
//
// The flush matrix walk is the single most expensive per-bot render cost (~170 nodes/bot), so
// flush() skips it when the caller says the IK solve was strided. That is only safe because the
// body tracks its OWN dirtiness: any pose write must force the walk even if the caller claims
// nothing moved. These tests pin that contract — a caller that gets the hint wrong may cost
// frame time, but must never render a stale pose.
//
// Run: node test-body-flush-lod.mjs

import * as THREE from 'three';
import { createProceduralPlayerBody } from './player-procedural-body.js';

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name}`); }
}

// Counts world-matrix walks and how many parts reached the pool.
function makeRig() {
  let adds = 0;
  const pool = { add() { adds++; } };
  const body = createProceduralPlayerBody({
    THREE, scene: new THREE.Group(), terrainHeight: () => 0, mode: 'remote', batches: {},
  });
  let walks = 0;
  const real = body.group.updateMatrixWorld.bind(body.group);
  body.group.updateMatrixWorld = (force) => { if (force) walks++; return real(force); };
  const state = {
    position: new THREE.Vector3(), velocity: new THREE.Vector3(), onFloor: true,
    height: 1.8, radius: 0.3, yaw: 0, aimPitch: 0, crouch: 0, prone: 0, alive: true,
  };
  return {
    body, state,
    walks: () => walks,
    flush: (hint) => { const before = adds; body.flush(pool, hint); return adds - before; },
  };
}

{
  const r = makeRig();
  r.body.update(1 / 60, r.state);

  const emitted = r.flush(true);
  check('a refreshing flush walks the tree', r.walks() === 1);
  check('a flush emits every part', emitted > 30);

  // The strided case: nothing moved since the last flush, so the walk must be skipped and the
  // held pose re-emitted. Both halves matter — skipping the emit would make the bot vanish.
  const held = r.flush(false);
  check('a strided flush skips the walk', r.walks() === 1);
  check('a strided flush still emits the held pose', held === emitted);
}

{
  // The dirty flag has to OVERRIDE a wrong hint. Every one of these paths moves the rig, so a
  // caller passing false straight after must still get a walk, or the bot renders a stride late.
  const cases = [
    ['update', (r) => r.body.update(1 / 60, r.state)],
    ['setVisible', (r) => { r.body.setVisible(false); r.body.setVisible(true); }],
    ['setRagdollPose', (r) => {
      const P = {};
      for (const n of ['pelvis', 'chest', 'neck', 'head', 'shoulderL', 'shoulderR', 'elbowL',
        'elbowR', 'handL', 'handR', 'hipL', 'hipR', 'kneeL', 'kneeR', 'footL', 'footR']) {
        P[n] = new THREE.Vector3(0, 1, 0);
      }
      r.body.setRagdollPose(P);
    }],
  ];
  for (const [name, move] of cases) {
    const r = makeRig();
    r.body.update(1 / 60, r.state);
    r.flush(true);
    const settled = r.walks();
    r.flush(false);
    check(`${name}: a quiet frame stays skipped`, r.walks() === settled);
    move(r);
    r.flush(false);                      // caller wrongly claims nothing moved
    check(`${name}: a pose write forces the walk anyway`, r.walks() === settled + 1);
  }
}

{
  // Phase 3: the rbox far-LOD twin. The point of the swap is triangles, so assert the actual
  // count drops and the part count does NOT -- a swap that dropped pieces would be a visual bug,
  // not an optimisation.
  const { setBotBodyKind, botDesignForRole } = await import('./bot-body-design.js');
  const tris = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
  for (const kind of ['soldier', 'armoured']) {
    setBotBodyKind(kind);
    const body = createProceduralPlayerBody({
      THREE, scene: new THREE.Group(), terrainHeight: () => 0, mode: 'remote',
      design: botDesignForRole('rifleman'), batches: {},
    });
    const survey = () => {
      let t = 0, n = 0;
      body.flush({ add(geo) { t += tris(geo); n++; } });
      return { t, n };
    };
    const full = survey();
    body.setGearLod(1);
    const cheap = survey();
    body.setGearLod(0);
    const back = survey();

    check(`${kind}: the far LOD cuts triangles by a third or more`, cheap.t < full.t * 0.67,
      `${full.t} -> ${cheap.t}`);
    check(`${kind}: the far LOD drops no parts`, cheap.n === full.n, `${full.n} vs ${cheap.n}`);
    check(`${kind}: swapping back restores full detail`, back.t === full.t);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
