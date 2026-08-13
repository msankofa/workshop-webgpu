// node test-bot-pursuit.mjs
import { investigationRadius, interceptPoint, pincerOffsets, standoffPoint, PURSUIT_DEFAULTS } from './bot-pursuit.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

console.log('investigationRadius');
{
  const s = { initialRadius: 1.25, expansionMetresPerSecond: 2.5, maxRadius: 12 };
  check('starts at the initial radius', investigationRadius(0, s) === 1.25);
  check('expands at the tuned rate', near(investigationRadius(2, s), 6.25));
  check('clamps to maxRadius', investigationRadius(60, s) === 12);
  check('reaches the cap in ~4.3 s', investigationRadius(4.3, s) === 12 && investigationRadius(4.2, s) < 12);
  check('negative elapsed is treated as 0', investigationRadius(-5, s) === 1.25);
  check('non-numeric elapsed is treated as 0', investigationRadius(undefined, s) === 1.25);
  check('no settings still returns a usable radius', investigationRadius(3) === 1.25);
  check('uncapped settings are allowed', investigationRadius(10, { initialRadius: 0, expansionMetresPerSecond: 1 }) === 10);
}

console.log('interceptPoint');
{
  const self = { x: 0, z: 0 };
  const target = { x: 10, z: 0 };
  const opts = { speed: 5, closeDistance: 0, maxLeadSeconds: 1.2, minLeadSpeed: 0.6 };

  const still = interceptPoint(target, { x: 0, z: 0 }, self, opts);
  check('a stationary target is not led', still.x === 10 && still.z === 0 && still.leadSeconds === 0);

  const slow = interceptPoint(target, { x: 0, z: 0.3 }, self, opts);
  check('sub-threshold drift is not led', slow.leadSeconds === 0);

  // gap 10 / speed 5 = 2 s, capped to 1.2 s; target crossing at 4 m/s -> 4.8 m of lead.
  const led = interceptPoint(target, { x: 0, z: 4 }, self, opts);
  check('leads along the target velocity', near(led.z, 4.8) && led.x === 10);
  check('lead time is capped', led.leadSeconds === 1.2);

  const close = interceptPoint({ x: 3, z: 0 }, { x: 0, z: 4 }, self, opts);
  check('a short gap leads proportionally', near(close.leadSeconds, 0.6) && near(close.z, 2.4));

  const inRange = interceptPoint({ x: 3, z: 0 }, { x: 0, z: 4 }, self, { ...opts, closeDistance: 5 });
  check('already inside the standoff means no lead', inRange.leadSeconds === 0 && inRange.x === 3);

  check('zero speed cannot predict', interceptPoint(target, { x: 0, z: 4 }, self, { ...opts, speed: 0 }).leadSeconds === 0);
  check('missing velocity is safe', interceptPoint(target, null, self, opts).x === 10);
  check('defaults apply when options are omitted', interceptPoint(target, { x: 0, z: 4 }, self, { speed: 5 }).leadSeconds === PURSUIT_DEFAULTS.maxLeadSeconds);
}

console.log('pincerOffsets');
{
  const offsets = pincerOffsets(3, 0.5);
  check('starts straight on', offsets[0] === 0);
  check('alternates sides', offsets[1] === 0.5 && offsets[2] === -0.5 && offsets[3] === 1 && offsets[4] === -1);
  check('two per ring plus the centre', offsets.length === 7);
  check('zero rings is just the direct line', pincerOffsets(0, 0.5).length === 1);
  check('negative rings degrade to the direct line', pincerOffsets(-2, 0.5).length === 1);
  check('defaults are usable', pincerOffsets().length === 7);
}

console.log('standoffPoint');
{
  const target = { x: 0, z: 0 };
  const from = { x: 10, z: 0 };   // bot due +x of the target

  const direct = standoffPoint(target, from, 4);
  check('sits `range` from the target on the bot side', near(direct.x, 4) && near(direct.z, 0));

  const quarter = standoffPoint(target, from, 4, Math.PI / 2);
  check('a 90 deg offset swings a quarter turn', near(quarter.x, 0, 1e-9) && near(Math.abs(quarter.z), 4));

  const plus = standoffPoint(target, from, 4, 0.6);
  const minus = standoffPoint(target, from, 4, -0.6);
  check('mirrored offsets land on opposite sides', near(plus.x, minus.x, 1e-9) && near(plus.z, -minus.z, 1e-9));
  check('offsets preserve the range', near(Math.hypot(plus.x, plus.z), 4) && near(Math.hypot(minus.x, minus.z), 4));

  const onTop = standoffPoint(target, { x: 0, z: 0 }, 4, 0, 0);
  check('standing on the target falls back to the yaw', near(onTop.z, -4) && near(onTop.x, 0, 1e-9));
  check('fallback yaw is honoured', near(standoffPoint(target, target, 4, 0, Math.PI / 2).x, -4));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
