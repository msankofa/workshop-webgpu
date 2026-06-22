// test-collision.mjs — pure capsule-vs-heightfield contact math (SP5 Phase A).
// Reference height/normal come from the canonical analytic field in terrain-field.js,
// so groundContact is provably consistent with the terrain the player sees.
import { terrainHeightAt, terrainNormalAt } from './terrain-field.js';
import { groundContact, slideVelocity } from './collision.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('FAIL:', m); } };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

const params = { baseAmp: 1.0, lake: 0.45, lakeDepth: 3.2 };
const heightAt = (x, z) => terrainHeightAt(params, x, z);
const normalAt = (x, z) => terrainNormalAt(params, x, z, [0, 0, 0]);
const RADIUS = 0.35, SLOPE = 0.5;

// 1. Above ground: no penetration, not grounded, capsule unchanged.
{
  const x = 12, z = -5;
  const gy = heightAt(x, z);
  const bottomY = gy + 1.0;            // a metre clear of the ground
  const c = groundContact({ x, z, bottomY, slopeLimitY: SLOPE, heightAt, normalAt });
  ok(c.penetration < 0, '1: penetration negative when above ground');
  ok(c.grounded === false, '1: not grounded when above ground');
  ok(near(c.restBottomY, bottomY), '1: restBottomY unchanged when above ground');
}

// 2. Penetrating flat ground: grounded, bottom rests exactly on groundY.
{
  const x = 3, z = 7;
  const gy = heightAt(x, z);
  const bottomY = gy - 0.5;            // sunk half a metre
  const c = groundContact({ x, z, bottomY, slopeLimitY: SLOPE, heightAt, normalAt });
  ok(near(c.penetration, 0.5), '2: penetration equals sink depth');
  ok(near(c.restBottomY, gy, 1e-9), '2: restBottomY rests on groundY');
  ok(c.grounded === true, '2: grounded on shallow real terrain');
  ok(near(c.normal[1], normalAt(x, z)[1]), '2: normal matches analytic field');
}

// 3. Penetrating but too steep (injected steep normal): NOT grounded, still reports
//    penetration + normal so the caller can lift and slide.
{
  const steepNormal = () => { const n = [0.8, 0.3, 0]; const inv = 1 / Math.hypot(...n); return [n[0] * inv, n[1] * inv, n[2] * inv]; };
  const c = groundContact({ x: 0, z: 0, bottomY: heightAt(0, 0) - 0.4, slopeLimitY: SLOPE, heightAt, normalAt: steepNormal });
  ok(c.penetration > 0, '3: penetration positive on steep contact');
  ok(c.grounded === false, '3: too-steep contact is not grounded (slides)');
  ok(c.normal !== null, '3: steep contact still returns a normal for sliding');
}

// 4. slideVelocity removes only the into-surface component.
{
  const flat = [0, 1, 0];
  const r1 = slideVelocity({ x: 2, y: -5, z: 1 }, flat);
  ok(near(r1.x, 2) && near(r1.y, 0) && near(r1.z, 1), '4: downward velocity flattened on flat ground');

  const r2 = slideVelocity({ x: 0, y: 8, z: 0 }, flat);
  ok(near(r2.y, 8), '4: upward velocity (jump) preserved');

  const n = (() => { const v = [0.6, 0.8, 0]; return v; })();   // unit normal
  const r3 = slideVelocity({ x: 0, y: -10, z: 0 }, n);
  const dot = r3.x * n[0] + r3.y * n[1] + r3.z * n[2];
  ok(Math.abs(dot) < 1e-9, '4: into-slope velocity removed (tangential remains)');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
