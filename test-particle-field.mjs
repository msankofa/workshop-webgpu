import { spawnInVolume, curlNoise2, stepLife, kindParams } from './particle-field.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };

// ---- spawnInVolume: deterministic, inside the camera volume ----
const a = spawnInVolume(42, 100, 5, -30, 20);
const b = spawnInVolume(42, 100, 5, -30, 20);
ok(a.x === b.x && a.y === b.y && a.z === b.z, 'spawn is deterministic per seed');
ok(Math.abs(a.x - 100) <= 20 && Math.abs(a.y - 5) <= 20 && Math.abs(a.z + 30) <= 20, 'spawn lands inside [cam ± R]');
ok(spawnInVolume(43, 100, 5, -30, 20).x !== a.x, 'different seed → different position');
{
  // spread: many seeds roughly fill the volume (not all clustered)
  let minx = Infinity, maxx = -Infinity;
  for (let s = 0; s < 200; s++) { const p = spawnInVolume(s, 0, 0, 0, 10); minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x); }
  ok(minx < -5 && maxx > 5, 'spawns spread across the volume');
}

// ---- curlNoise2: divergence-free (no sources/sinks → particles don't clump) ----
const pot = (x, z) => Math.sin(x * 0.5) * Math.cos(z * 0.5);
{
  const c1 = curlNoise2(3, 7, pot), c2 = curlNoise2(3, 7, pot);
  ok(c1.fx === c2.fx && c1.fz === c2.fz, 'curlNoise2 deterministic');
  const e = 1e-2; let maxDiv = 0;
  for (let x = -5; x <= 5; x += 2.5) for (let z = -5; z <= 5; z += 2.5) {
    const div = (curlNoise2(x + e, z, pot).fx - curlNoise2(x - e, z, pot).fx) / (2 * e)
              + (curlNoise2(x, z + e, pot).fz - curlNoise2(x, z - e, pot).fz) / (2 * e);
    maxDiv = Math.max(maxDiv, Math.abs(div));
  }
  ok(maxDiv < 1e-2, `curl field ~divergence-free (maxDiv ${maxDiv.toExponential(2)})`);
}

// ---- stepLife: advances, fades in/out, wraps at maxLife ----
ok(stepLife(0, 0.1, 10).age > 0, 'life advances with dt');
ok(stepLife(0, 0, 10).fade < 0.1, 'fade ~0 at birth');
ok(stepLife(5, 0, 10).fade > 0.9, 'fade ~1 mid-life');
ok(stepLife(10, 0, 10).fade < 0.1, 'fade ~0 at end of life');
{
  const w = stepLife(9.95, 0.1, 10);
  ok(w.age < 1 && w.reborn === true, `wraps + flags reborn at maxLife (age ${w.age.toFixed(3)})`);
}

// ---- kindParams: ember vs dust differ meaningfully ----
const em = kindParams('ember'), du = kindParams('dust');
ok(em.buoyancy > 0 && Math.abs(du.buoyancy) < 1e-6, 'ember is buoyant, dust is not');
ok(em.blend === 'additive' && du.blend === 'alpha', 'ember additive, dust alpha');
ok(em.flicker > 0 && du.flicker === 0, 'ember flickers, dust does not');
ok(JSON.stringify(em.color) !== JSON.stringify(du.color), 'ember and dust colors differ');

process.exit(fail ? 1 : 0);
