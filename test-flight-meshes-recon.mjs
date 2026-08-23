// test-flight-meshes-recon.mjs — the recon UAV the bot viewer's loitering munitions fly.
//
// The proportions here are measurements off a photograph, not taste, so they are worth pinning: a
// later edit that quietly returns the craft to a shrunken fighter should fail here rather than in a
// screenshot nobody takes.
//
//   node test-flight-meshes-recon.mjs

import * as THREE from 'three';
import { buildCraftMesh, CRAFT_KINDS } from './flight-meshes.js';

let fails = 0;
const ok = (name, cond, detail) => {
  if (!cond) fails++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`);
};
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const materials = {
  standard: (color, emissive = 0x000000) => new THREE.MeshStandardMaterial({ color, emissive }),
  basic: (color, opacity = 1) => new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity }),
};

ok('recon is a registered kind', CRAFT_KINDS.includes('recon'), CRAFT_KINDS.join(', '));

const g = buildCraftMesh('recon', 0x8ea2b8, materials);
g.updateMatrixWorld(true);

const box = new THREE.Box3().setFromObject(g);
const size = new THREE.Vector3(); box.getSize(size);

// Photo measurement: 2.02 m span over 1.13 m length, a span-to-length ratio of 1.79.
ok('span is the measured 2.02 m', near(size.x, 2.016, 0.02), `x=${size.x.toFixed(3)}`);
ok('length is the measured 1.13 m', near(size.z, 1.133, 0.02), `z=${size.z.toFixed(3)}`);
ok('span-to-length ratio holds', near(size.x / size.z, 1.79, 0.05), (size.x / size.z).toFixed(3));
ok('sits low: no fin taller than 0.2 m', size.y < 0.2, `y=${size.y.toFixed(3)}`);

// Nose forward of -Z, propeller aft of +Z: the pose code flips the craft to fly nose-first and gets
// this backwards for free if the model is ever authored the other way round.
ok('nose points -Z', near(box.min.z, -0.53, 0.02), `minZ=${box.min.z.toFixed(3)}`);
ok('propeller is the aft-most part', near(box.max.z, 0.598, 0.02), `maxZ=${box.max.z.toFixed(3)}`);

const prop = g.userData.propeller;
ok('propeller is exposed for the spin', !!prop);
if (prop) {
  const p = new THREE.Vector3().setFromMatrixPosition(prop.matrixWorld);
  // The first build put the prop on a dorsal pylon 50 mm above the axis; it belongs on the axis.
  ok('propeller is on the body centreline', near(p.x, 0, 1e-6) && near(p.y, 0, 1e-6),
    `x=${p.x.toFixed(4)} y=${p.y.toFixed(4)}`);
  ok('propeller is behind the tail boom', p.z > 0.565, `z=${p.z.toFixed(3)}`);
}

// The V-tail halves met on the body centreline in an earlier round, burying their inboard thirds in
// the boom. Each root belongs on the boom skin, so neither half may straddle x = 0.
const fins = [];
g.traverse((o) => {
  if (!o.isMesh) return;
  const b = new THREE.Box3().setFromObject(o);
  const s = new THREE.Vector3(); b.getSize(s);
  if (b.min.z > 0.40 && b.max.z < 0.55 && s.y > 0.05) fins.push(b);
});
ok('two V-tail surfaces', fins.length === 2, `found ${fins.length}`);
if (fins.length === 2) {
  const straddles = fins.some((b) => b.min.x < -0.005 && b.max.x > 0.005);
  ok('neither V-tail half straddles the centreline', !straddles);
  ok('V-tail halves are mirrored', near(fins[0].max.y, fins[1].max.y, 1e-3),
    `${fins[0].max.y.toFixed(4)} vs ${fins[1].max.y.toFixed(4)}`);
}

let tris = 0, bad = 0;
g.traverse((o) => {
  if (!o.isMesh) return;
  const pos = o.geometry.attributes.position;
  tris += (o.geometry.index ? o.geometry.index.count : pos.count) / 3;
  for (let i = 0; i < pos.count * 3; i++) if (!Number.isFinite(pos.array[i])) bad++;
});
ok('no NaN in any vertex', bad === 0, `${bad} bad floats`);
// It flies at 14-20 m over a firefight; it does not need the 27,840 triangles the reconstruction had.
ok('cheap enough to field in numbers', tris < 2000, `${tris} triangles`);

console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
