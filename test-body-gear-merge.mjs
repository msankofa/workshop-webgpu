// test-body-gear-merge.mjs
//
// Fix 2 of the 2026-08-17 perf pass: with mergeGear on, every gear piece on one (anchor, role)
// bakes into a single geometry at body build. These pin the contract that made that safe:
// identical triangles at both LOD levels, far fewer parts, and hit/decal attribution that still
// resolves to the same limb and the same world point as the per-piece body.
//
// Run: node test-body-gear-merge.mjs

import * as THREE from 'three';
import { createProceduralPlayerBody } from './player-procedural-body.js';
import { setBotBodyKind, botDesignForRole } from './bot-body-design.js';
import { resolveBodyHit, attachFromPoint, resolveAttachmentMatrix } from './bot-body-hit.js';
import { buildLimbMap, limbForPart } from './bot-limb-map.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS: ${name}`); }
  else { fail++; console.log(`FAIL: ${name}${detail ? ` (${detail})` : ''}`); }
}

const tris = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
function survey(body) {
  let t = 0, n = 0;
  body.flush({ add(geo) { t += tris(geo); n++; } });
  return { t, n };
}

function makeBody(mergeGear) {
  const body = createProceduralPlayerBody({
    THREE, scene: new THREE.Group(), terrainHeight: () => 0, mode: 'remote',
    design: botDesignForRole('rifleman'), batches: {}, mergeGear,
  });
  const state = {
    position: new THREE.Vector3(0, 1, 0), velocity: new THREE.Vector3(), onFloor: true,
    height: 1.8, radius: 0.3, yaw: 0, aimPitch: 0, crouch: 0, prone: 0, alive: true,
  };
  body.update(1 / 60, state);
  body.group.updateMatrixWorld(true);
  return body;
}

for (const kind of ['armoured', 'soldier']) {
  setBotBodyKind(kind);
  const plain = makeBody(false);
  const merged = makeBody(true);

  const pFull = survey(plain), mFull = survey(merged);
  check(`${kind}: merged draws the same triangles`, mFull.t === pFull.t, `${pFull.t} vs ${mFull.t}`);
  check(`${kind}: merged flushes far fewer parts`, mFull.n < pFull.n - 10, `${pFull.n} -> ${mFull.n}`);

  merged.setGearLod(1); plain.setGearLod(1);
  const pCheap = survey(plain), mCheap = survey(merged);
  merged.setGearLod(0); plain.setGearLod(0);
  check(`${kind}: merged far LOD matches the per-piece far LOD`, mCheap.t === pCheap.t, `${pCheap.t} vs ${mCheap.t}`);
  check(`${kind}: merged swap back restores full detail`, survey(merged).t === mFull.t);

  // Hit parity: rays through the torso from a ring of directions must land on the same limb, the
  // same role, and the same world point whether the gear is per-piece or merged.
  const plainMap = buildLimbMap(plain);
  const mergedMap = buildLimbMap(merged);
  let compared = 0, agree = 0, pointsClose = 0, crossClose = 0;
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const y = 0.6 + (i % 6) * 0.25;
    const origin = new THREE.Vector3(Math.cos(a) * 3, y, Math.sin(a) * 3);
    const dir = new THREE.Vector3(0, y, 0).sub(origin).normalize();
    const hp = resolveBodyHit({ THREE, body: plain, origin, dir, refresh: true });
    const hm = resolveBodyHit({ THREE, body: merged, origin, dir, refresh: true });
    if (!hp && !hm) continue;
    compared++;
    if (!hp || !hm) continue;
    const lp = limbForPart(plainMap, hp.part)?.limb ?? null;
    const lm = limbForPart(mergedMap, hm.part)?.limb ?? null;
    if (lp === lm && hp.role === hm.role) agree++;
    if (hp.point.distanceTo(hm.point) < 1e-3) pointsClose++;
    if (Math.abs(hp.crossSection - hm.crossSection) < 1e-6) crossClose++;
  }
  check(`${kind}: rays hit both bodies`, compared >= 12, `${compared}`);
  check(`${kind}: every hit agrees on limb and role`, agree === compared, `${agree}/${compared}`);
  check(`${kind}: every hit lands on the same world point`, pointsClose === compared, `${pointsClose}/${compared}`);
  check(`${kind}: every hit keeps the piece cross-section`, crossClose === compared, `${crossClose}/${compared}`);

  // Attachment roundtrip on a merged gear part: the handle must resolve to a live matrix and the
  // local point must come back to the same world position.
  const gearPart = merged.parts.gear.find((p) => p.userData.mergedPieces);
  check(`${kind}: merged body exposes mergedPieces`, !!gearPart);
  if (gearPart) {
    const centre = new THREE.Vector3().applyMatrix4(gearPart.userData.mergedPieces[0].matrix)
      .applyMatrix4(gearPart.matrixWorld);
    const att = attachFromPoint({ THREE, body: merged, point: centre, refresh: true });
    check(`${kind}: attachFromPoint resolves near a merged piece`, !!att?.attach);
    if (att?.attach) {
      const m = resolveAttachmentMatrix(merged, att.attach);
      check(`${kind}: the attachment handle resolves`, !!m);
      const back = new THREE.Vector3(...att.attach.lp).applyMatrix4(m);
      check(`${kind}: the local point rides the part`, back.distanceTo(att.point) < 1e-5,
        `${back.distanceTo(att.point)}`);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
