// What does the bend limit actually hold, and what does each relaxation cost? Swing hard, then let settle.
//
// This is the measurement BEND_RELAXATION in pokemon-hang.js was chosen from, kept so the number can be
// re-derived rather than trusted. The ranking is the opposite of the obvious one: weaker passes settle
// better, because strong ones fight the length constraints that run after them.
//
//   node probe_bend.mjs
import fs from 'node:fs';
import { readRigFromGLB } from './pokemon-rig.js';
import { readPose, rootPreMatrix } from './pokemon-pose.js';
import { buildHang, pinBone, stepHang, bendStrain } from './pokemon-hang.js';

const D = 180 / Math.PI;
const NAMES = { squirtle: '007_squirtle.glb', onix: '095_onix.glb', pikachu: '025_pikachu.glb' };

/** Worst bone stretched away from its rest length, as a fraction. Braces are meant to give, so skip them. */
function lengthError(hang) {
  const P = hang.particles;
  let worst = 0;
  for (const c of hang.constraints) {
    if (c.kind === 'brace') continue;
    const d = Math.hypot(P[c.a].pos.x - P[c.b].pos.x, P[c.a].pos.y - P[c.b].pos.y, P[c.a].pos.z - P[c.b].pos.z);
    worst = Math.max(worst, Math.abs(d - c.max) / (c.max || 1));
  }
  return worst;
}

for (const [name, file] of Object.entries(NAMES)) {
  const rig = readRigFromGLB(fs.readFileSync(`models/stadium/${file}`)).rig;
  const rest = readPose(rig, null, 0, rootPreMatrix(rig));
  const R = rig.units.height * 0.5;
  console.log(`\n${name}  ${rig.bones.length} bones, height ${rig.units.height.toFixed(1)}`);
  for (const deg of [180, 30, 15]) {
    const parts = [];
    for (const relax of [0.25, 0.1, 0.05, 0.02]) {
      const hang = buildHang(rig, rest, { stiffness: 0.4, maxBend: deg / D });
      for (const c of hang.limits.cones) c.stiffness = relax;
      // Pinned where it already is, then dragged in a circle a body-height wide. Teleporting the pin
      // instead lifts only the pinned particle, and the links snapping its neighbours across that gap
      // reads to Verlet as enormous velocity -- an explosion the limit did not cause.
      for (let k = 0; k < 180; k++) {
        pinBone(hang, 1, rest[3] + Math.cos(k * 0.06) * R - R, rest[4] + Math.sin(k * 0.06) * R, rest[5]);
        stepHang(hang, 1 / 60, { gravity: 1, ground: false });
      }
      for (let k = 0; k < 360; k++) stepHang(hang, 1 / 60, { gravity: 1, ground: false });
      const s = bendStrain(hang);
      parts.push(`${relax}: ${(s[0] * D).toFixed(0).padStart(3)}deg over ${s.filter(v => v > deg / D + 1e-3).length}/${s.length} stretch ${(lengthError(hang) * 100).toFixed(1).padStart(5)}%`);
    }
    console.log(`  limit ${String(deg).padStart(3)}  ${parts.join('   ')}`);
  }
}
