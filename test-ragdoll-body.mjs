// test-ragdoll-body.mjs — pure checks for the ragdoll-body bridge (weaponKnockback + applyDeathImpulse
// targeting). ragdollFromBody needs THREE (browser-only) and isn't covered here. Run: node test-ragdoll-body.mjs
import { weaponKnockback, applyDeathImpulse, applyBlastImpulse } from './ragdoll-body.js';
import { createRagdoll } from './ragdoll.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ok  ${name}`); } else { fail++; console.log(`FAIL  ${name}${extra ? '  — ' + extra : ''}`); } };
const jvel = (rd, name) => { const p = rd.particles[rd.index[name]]; return Math.hypot(p.pos.x - p.prev.x, p.pos.y - p.prev.y, p.pos.z - p.prev.z); };

// ---- weaponKnockback ----
{
  const pistol = weaponKnockback({ mode: 'hitscan', damage: 20 });
  const rifle = weaponKnockback({ mode: 'hitscan', damage: 33 });
  const sniper = weaponKnockback({ mode: 'hitscan', damage: 95 });
  ok('hitscan scales with damage (pistol<rifle<sniper)', pistol < rifle && rifle < sniper, `${pistol} ${rifle} ${sniper}`);
  ok('sniper clamped to 12', sniper === 12);
  ok('light pistol clamped to floor 4', pistol === 4, `${pistol}`);
  ok('melee is light', weaponKnockback({ mode: 'melee', damage: 50 }) === 4);
  ok('projectile hits hardest', weaponKnockback({ mode: 'projectile', damage: 110 }) > sniper);
  ok('explicit knockback field wins', weaponKnockback({ mode: 'hitscan', damage: 20, knockback: 9 }) === 9);
  ok('null weapon → default', weaponKnockback(null) === 6);
}

// ---- per-body-part targeting: the reaction concentrates at the joint nearest the hit ----
{
  const rd = createRagdoll();
  const head = rd.particles[rd.index.head].pos;
  applyDeathImpulse(rd, { dir: { x: 0, y: 0, z: -1 }, strength: 10, hitPoint: { x: head.x, y: head.y, z: head.z } });
  ok('headshot moves head more than foot', jvel(rd, 'head') > jvel(rd, 'footL'), `head ${jvel(rd, 'head').toFixed(3)} foot ${jvel(rd, 'footL').toFixed(3)}`);
}
{
  const rd = createRagdoll();
  const foot = rd.particles[rd.index.footL].pos;
  applyDeathImpulse(rd, { dir: { x: 0, y: 0, z: -1 }, strength: 10, hitPoint: { x: foot.x, y: foot.y, z: foot.z } });
  ok('leg shot moves that foot more than head', jvel(rd, 'footL') > jvel(rd, 'head'), `foot ${jvel(rd, 'footL').toFixed(3)} head ${jvel(rd, 'head').toFixed(3)}`);
  ok('leg shot barely moves the far arm', jvel(rd, 'footL') > jvel(rd, 'handR'));
}
// ---- no hit point → whole upper body reacts (location-agnostic fallback) ----
{
  const rd = createRagdoll();
  applyDeathImpulse(rd, { dir: { x: 0, y: 0, z: -1 }, strength: 10 });
  ok('fallback moves chest and head', jvel(rd, 'chest') > 0.01 && jvel(rd, 'head') > 0.01);
}

// ---- explosion: whole body is launched radially away from the blast, with upward pop ----
{
  const rd = createRagdoll({ origin: { x: 0, y: 0, z: 0 } });
  const from = { x: -2, y: 0, z: 0 };   // blast to the −X side ⇒ body should fly +X
  applyBlastImpulse(rd, from, 12);
  const vel = (name) => { const p = rd.particles[rd.index[name]]; return { x: p.pos.x - p.prev.x, y: p.pos.y - p.prev.y, z: p.pos.z - p.prev.z }; };
  const pelvis = vel('pelvis');
  ok('blast pushes body away from center (+X)', pelvis.x > 0, `vx ${pelvis.x.toFixed(3)}`);
  ok('blast adds upward pop', pelvis.y > 0, `vy ${pelvis.y.toFixed(3)}`);
  ok('blast launches the whole body (feet move too)', vel('footL').x > 0 && vel('head').x > 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
