// The sniper "shooting the sky" bug: the FSM confirmed a shot on the ENTITY's yaw/pitch, but the
// round left down the RENDERED weapon barrel, and nothing forced those two to agree at the instant
// of the shot. bot-viewer-v2.html can't run in Node (three.js + a GPU), so this parses the two
// halves of that contract out of the source and asserts they still line up.
//
// Three invariants, one per way the barrel could be pointing somewhere the FSM never approved:
//   1. fireBotShot solves the barrel onto the aim point BEFORE it reads the barrel ray.
//   2. Every FSM branch that calls fireBotShot is in updateBotWeaponMount's `aiming` set, so the
//      weapon is never in a cross-body carry (~67 deg off) at the moment it fires.
//   3. botHasAimPoint is cleared when the target is gone, so the barrel never tracks a corpse.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// argv[2] lets the same checks run against a versions/ snapshot, which is how the invariants were
// confirmed to actually catch the bug they describe.
const src = fs.readFileSync(process.argv[2] || path.join(here, 'bot-viewer-v3.html'), 'utf8');

let failures = 0;
function check(label, condition, detail) {
  if (condition) { console.log(`  ok   ${label}`); return; }
  failures++;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
}

// ── 1. the fire path solves the barrel before it reads it ─────────────────────
const fireStart = src.indexOf('function fireBotShot(');
check('fireBotShot exists', fireStart >= 0);
const fireBody = src.slice(fireStart, src.indexOf('\nfunction ', fireStart + 1));
const alignAt = fireBody.indexOf('alignMountedWeaponToPoint(botAimPoint)');
const readAt = fireBody.indexOf('botMountedBarrelRay()');
check('fireBotShot solves the barrel onto the aim point', alignAt >= 0,
  'without it the round follows whatever pose the render pass last left the gun in');
check('...and does so BEFORE reading the barrel ray', alignAt >= 0 && readAt >= 0 && alignAt < readAt,
  `align at ${alignAt}, read at ${readAt}`);
// 2026-08-12: that snap is now the LEGACY arm. With the barrel trim on, the gun is deliberately not
// re-solved at the trigger -- the round has to leave down the barrel the player can see -- so the
// same guarantee has to come from the fire gate instead. Both arms are asserted, or turning the
// trim on would silently retire invariant 1 above.
check('the snap is gated on the trim being off', /!trimOn && botHasAimPoint/.test(fireBody),
  'with the trim on, re-solving at the trigger would put the round somewhere the rendered gun is not pointing');
check('the fire gate measures the RENDERED barrel', /function botBarrelAimError\(\)/.test(src)
  && /function botAimGateOk\(/.test(src) && src.includes('readyToFire && botAimGateOk(err)'),
  'nothing else stops a rate-limited barrel from firing before it has caught up');

// ── 2. every firing state trains the weapon ───────────────────────────────────
// The mount's own list, e.g. `botState === BOT_AIM || botState === BOT_FIRE || ...`.
const aimingStart = src.indexOf('_mountLoco.aiming =');
check('_mountLoco.aiming assignment found', aimingStart >= 0);
const aimingExpr = src.slice(aimingStart, src.indexOf(';', aimingStart));
const trained = new Set([...aimingExpr.matchAll(/botState === (\w+)/g)].map((m) => m[1]));
check('aiming set is non-empty', trained.size > 0, [...trained].join(', '));

// The FSM's branch chain: `} else if (state === X) {` ... up to the next such branch. A branch that
// calls fireBotShot is a firing state, whatever else it does.
const chain = [...src.matchAll(/else if \((?:state === (\w+)(?: \|\| state === (\w+))?)\) \{/g)];
check('FSM branch chain found', chain.length > 5, `${chain.length} branches`);
const firing = new Set();
for (let i = 0; i < chain.length; i++) {
  const from = chain[i].index;
  // The last branch ends where the chain does: the air-defence block that follows it fires too, but
  // it is not a state branch and is checked separately below.
  const chainEnd = src.indexOf('const airEngage = botAirTarget(', from);
  const to = i + 1 < chain.length ? chain[i + 1].index
    : (chainEnd >= 0 ? chainEnd : src.indexOf('const _sp4 = performance.now();', from));
  if (!src.slice(from, to).includes('fireBotShot(')) continue;
  for (const name of [chain[i][1], chain[i][2]]) if (name) firing.add(name);
}
check('found the firing branches', firing.size > 0, [...firing].join(', '));
const untrained = [...firing].filter((s) => !trained.has(s));
check('every state that fires also trains the weapon', untrained.length === 0,
  untrained.length ? `these fire from a carry pose: ${untrained.join(', ')}` : '');

// ── 2b. the air-defence fire path trains the weapon too ───────────────────────
// It fires from whatever state the ladder left the bot in -- usually patrol, which is a carry pose --
// so the mount has to know about it by name rather than by state.
const airFires = src.includes('const airEngage = botAirTarget(') && /if \(airEngage\) \{[\s\S]{0,900}?fireBotShot\(/.test(src);
if (airFires) {
  check('air defence trains the weapon before firing at a drone', /aiming = [\s\S]{0,400}?airEngaging/.test(src),
    'a bot shooting at a drone out of a cross-body carry is the same bug as the sniper shooting the sky');
}

// ── 3. the aim point does not outlive its target ──────────────────────────────
// `let botHasAimPoint = false` is the declaration, not a clear -- the bug was that nothing ever
// assigned false again, so this deliberately does not count it.
check('botHasAimPoint is cleared when the target is gone', /(?<!let )botHasAimPoint = false/.test(src),
  'a stale aim point keeps the barrel solved onto a dead target');

console.log(failures === 0 ? '\nbot fire/aim sync: all checks passed'
  : `\nbot fire/aim sync: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
