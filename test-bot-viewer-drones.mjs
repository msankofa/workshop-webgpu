// Drone wiring invariants that only exist in bot-viewer-v3.html, which cannot run in Node (three.js
// + a GPU). Parsed out of the source, in the same spirit as test-bot-fire-aim-sync.mjs.
//
// The bug that earned this file: a shot-down loitering munition detonates where it was, and its own
// blast comes straight back through blastDamageDrones with that same drone at distance zero. It was
// marked spent AFTER the blast, so the nested call found it live at 0 hp and set it off again —
// detonateBlast → blastDamageDrones → damageDrone → detonateBlast until the stack gave out, taking
// the WebGPU device with it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(process.argv[2] || path.join(here, 'bot-viewer-v3.html'), 'utf8');

let failures = 0;
function check(label, condition, detail) {
  if (condition) { console.log(`  ok   ${label}`); return; }
  failures++;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
}

function bodyOf(name) {
  const at = src.indexOf(`function ${name}(`);
  return at < 0 ? '' : src.slice(at, src.indexOf('\nfunction ', at + 1));
}

// ── a dying drone is spent before it goes off ─────────────────────────────────
const damage = bodyOf('damageDrone');
check('damageDrone exists', damage.length > 0);
const spentAt = damage.indexOf('d.done = true');
const blastAt = damage.indexOf('detonateBlast(');
check('damageDrone marks the drone spent', spentAt >= 0);
check('...before it detonates its warhead', spentAt >= 0 && blastAt >= 0 && spentAt < blastAt,
  `spent at ${spentAt}, blast at ${blastAt} — a live drone at 0 hp re-enters its own blast forever`);
check('damageDrone returns early on an already-spent drone', /if \(!rec \|\| rec\.drone\.done\) return;/.test(damage),
  'the outer guard is what stops a chain of drones re-killing each other');

// ── the blast pass cannot be re-entered mid-iteration ─────────────────────────
const blast = bodyOf('blastDamageDrones');
check('blastDamageDrones exists', blast.length > 0);
check('it reads the blast centre into locals', /const cx = center\.x/.test(blast),
  'a nested blast is handed the scratch vector this one is still reading');
check('it snapshots victims before damaging any of them',
  blast.indexOf('.push({ rec') >= 0 && blast.indexOf('.push({ rec') < blast.indexOf('damageDrone('),
  'damaging inside the scan lets a nested detonation mutate the list being walked');
check('it skips spent drones', /if \(d\.done\) continue;/.test(blast));

// ── one man, one aircraft ─────────────────────────────────────────────────────
const update = bodyOf('updateBotDrones');
check('munitions filling the cap stand the bomb drone down',
  /standDown: d\.kind === DRONE_BOMBER[\s\S]{0,200}?_droneBusyOwners\.get\(rec\.ownerId\)[\s\S]{0,120}?botDroneSettings\.aloftMax/.test(update),
  'without it the operator has more aircraft in the sky than the cap allows');
check('...and the cap is what decides, not merely "any munition"', !/_droneBusyOwners\.has\(/.test(update),
  'standing the bomber down for any munition at all makes "aircraft aloft at once" above 1 do nothing for it');
const tick = bodyOf('tickDroneOperator');
check('a parked bomb drone is re-sent, not re-spawned', /bomberExists\)[\s\S]{0,400}?return;/.test(tick),
  'launching one that already exists gives the operator a second bomb drone');

// ── dead stick ────────────────────────────────────────────────────────────────
check('a crashing drone sets off what it still carries', /out\.crash[\s\S]{0,600}?bombsAboard > 0[\s\S]{0,200}?detonateBlast\(/.test(update),
  'the whole point of dead stick is that the wreck is dangerous to whoever is under it');
check('the crash blast has no attacker, so no team owns it', /detonateBlast\(_droneVec, \{ \.\.\.w[\s\S]{0,60}\}, now, null\)/.test(update),
  'friendly fire is the intent here, not a bug to be filtered out');

// ── the squad waits for a busy member ─────────────────────────────────────────
check('a servicing operator marks itself busy', /markBotBusy\(activeBotActor, BUSY_DRONE_SERVICE/.test(src));
check('...and holds itself in place', /commandBotHold\(activeBotActor, now \+ DRONE_SERVICE_LEASE_MS, 'service'/.test(src),
  'a kneel with no hold behind it is a bot sliding along the ground on its knees');
check('the rest of the squad holds for it', /squadHaltFor\(activeBotActor, now\)[\s\S]{0,400}?commandBotHold\(activeBotActor[\s\S]{0,60}'wait'/.test(src));
check('the halt is memoised per squad per frame', /squad\.haltComputedAt === now/.test(src),
  'every member asking separately is one roster scan per bot per frame');

// ── stale targeting ───────────────────────────────────────────────────────────
const pick = bodyOf('droneTargetPoint');
check('memory is flagged stale rather than passed off as a sighting', /rec\.stale = !!point/.test(pick));
check('...and a stale point holds fire', /rec\.holdFire = rec\.stale/.test(pick),
  'a drone that bombs what it remembers bombs bare ground');
check('the stale flag reaches the module', /stale: rec\.stale/.test(src));
check('an assignment carries the age of the sighting, not of the assignment',
  /rec\.assignedAt = seenAt/.test(src) && /const seenAt = visibleTarget \? now :/.test(src),
  're-stamping with now keeps a half-minute-old ghost permanently fresh');
check('a sighting too old to be worth an aircraft launches nothing', /now - seenAt > DRONE_SEED_MAX_AGE_MS\) return;/.test(src));
check('the drone keeps its lock unless a rival is clearly closer', /DRONE_LOCK_MARGIN/.test(pick),
  'equidistant bots trade the lock every frame and a bomber loses its run to the flip');

// ── a drone cannot bomb what it cannot see ────────────────────────────────────
check('acquisition raycasts against the map', /function droneSees\([\s\S]{0,500}?mapCollider\.raycast/.test(src),
  'distance and team alone acquire targets through roofs, and the bomb follows');
check('...and the picked target is the one checked', /if \(picked && !droneSees\(/.test(pick));
check('an unseen target falls through to memory rather than being bombed', /picked = \(picked !== best/.test(pick),
  'memory sets stale, and stale holds fire — that is the whole chain that stops a strike through a roof');
check('a run that can never be released is given up', /holdGiveUpS/.test(fs.readFileSync(path.join(here, 'bot-drones.js'), 'utf8')),
  'without it a drone held off by a roof hovers over the spot for as long as the operator feeds it');

// ── shot down is not always shot to pieces ───────────────────────────────────
check('a lethal hit can leave the drone flying', /crippleDrone\(d, \{[\s\S]{0,200}?botDroneSettings\.deadstickWild/.test(damage));
check('...on a roll, not always', /Math\.random\(\) < botDroneSettings\.deadstickChance/.test(damage));
check('...and not to a drone already falling', /d\.state !== 'deadstick'/.test(damage),
  'a second hit has to finish it, or the roll re-rolls forever and it never dies');
check('a dead-stick munition sets off its warhead where it lands', /if \(out\.warhead\)/.test(update),
  'the whole point of leaving it flying is that the wreck is still dangerous');
check('every bomb aboard goes off, not two of them', /damage: w\.damage \* out\.bombsAboard/.test(update),
  'the rack holds as many as the slider says; capping the crash at 2 was a first-draft number');

// ── a committed drone is a threat the bots react to ──────────────────────────
check('terminal drones enter the grenade threat channel', /air: true,/.test(src) && /droneTerminal\(d\)/.test(src),
  'reusing the channel is what gives them the warning call, the run for cover and the bearing back');
check('the threat point is the impact, not the aircraft', /function droneImpactPoint/.test(src),
  'a ring drawn around a drone at 14 m is not where anyone is about to be hurt');
check('the nearer the drone, the more of them run', /threatFleeShare \* Math\.sqrt\(nearness\)/.test(src),
  'a flat share ignores the one thing that decides it: how close the blast is');
check('...measured from the impact point, against the blast radius', /1 - dist \/ Math\.max\(0\.01, evade\.radius\)/.test(src));
check('the bot rolls its nerve once per drone', /actor\.droneReactionRoll = Math\.random\(\)/.test(src) &&
  /actor\.droneReactionId !== threatId/.test(src),
  'a per-frame coin flip is a bot twitching between running and shooting');
check('the decision escalates but never reverses inside the ring', /if \(!actor\.droneReactionFlee\s*\n?\s*&& actor\.droneReactionRoll </.test(src),
  'a bot that talks itself back into standing still mid-run reads as broken; leaving the ring is what ends the run');
check('declining to run drops through to air defence', /if \(!actor\.droneReactionFlee\) \{ clearGrenadeEvade\(actor\); return false; \}/.test(src));
check('a committed drone can interrupt a gunfight', /committedOnly && !droneTerminal\(rec\.drone\)/.test(src),
  'a bot that keeps trading rifle fire under a bomber never looks up');
check('a drone cruising overhead still cannot', /if \(visible && !committedOnly\)/.test(src),
  'every ground engagement outranks a drone that has not committed — that part was deliberate');

// ── the self-splash gate has to see what is actually being shot at ───────────
check('the close-range swap is fed the air target range',
  /updateBotWeaponSlot\(now, inGunfight, Math\.min\(targetDistance, airEngage \? airEngage\.dist : Infinity\)\)/.test(src),
  'fed only the ground target it sits at Infinity in exactly the case air defence runs in, and a technical rockets a drone 11 m over its own head');

// ── the numbers were authored blind, so show them ────────────────────────────
check('the panel reads back what each drone is doing', /function describeDrones/.test(src));
check('...including its state, height, bombs and lock',
  /d\.state/.test(src) && /d\.p\[1\] - d\.groundY/.test(src) && /HOLD:stale/.test(src));

// ── the bomb drone is reusable, not infinite ─────────────────────────────────
check('losing the bomb drone is counted against the operator', /owner\.droneKit\.bomberLost = \(owner\.droneKit\.bomberLost \|\| 0\) \+ 1/.test(update),
  'without a loss count the airframe is free: shooting one down buys four seconds and nothing else');
check('...and past his spares he has none for the rest of the match',
  /const spent = \(kit\.bomberLost \|\| 0\) > Math\.round\(botDroneSettings\.bomberReplacements\)/.test(tick) &&
  /bomberReady: bomberExists \? bomberReady : !spent/.test(tick));
check('grounding every drone from the panel is not a loss', !/bomberLost/.test(bodyOf('clearBotDrones')),
  'a debug button must not spend the operator\'s spares');
check('the readout says how many spares are left', /spares \$\{Math\.max\(0/.test(src),
  'an operator with nothing coming still looks exactly like one who has an aircraft on the way');

// ── one aircraft, many encounters ─────────────────────────────────────────────
// The bomb drone is ONE reusable airframe with one id for the whole match, so anything keyed on the
// id alone decides once at the first attack run and never reconsiders. The bots' run-or-shoot nerve
// was exactly that. A munition never showed it: fresh id per launch.
check('each attack run is its own encounter', /rec\.runSeq = \(rec\.runSeq \|\| 0\) \+ 1/.test(update),
  'without a per-run counter a bot that fled the bomber once flees it for the rest of the match');
check('...and the threat carries the run, not just the aircraft', /id: `\$\{d\.id\}#\$\{rec\.runSeq \|\| 0\}`/.test(src));

// ── a bomb in the air is the most immediate threat on the field ──────────────
check('a falling drone bomb is a threat', /const bomb = proj\.weaponId === 'drone_bomb'/.test(src),
  'the filter admitted only grenades, so bots stood still underneath live ordnance for its whole fall');
check('...with a solved time to impact, not the flight-life cap', /sim\.vy \* sim\.vy \+ 2 \* g \* Math\.max\(0, p\[1\] - gy\)/.test(src),
  'sim.life is the 8 s cap and would report six seconds left on a bomb one second from landing');
check('...aimed where it will land, not where it is', /p\[0\] \+ sim\.vx \* fall/.test(src));
check('...and offers no shoot-it-down option', !/air: true,[\s\S]{0,200}?fuseRemainingS: Math\.max\(0, fall\)/.test(src),
  'you cannot shoot a falling bomb, so there is no run-or-shoot choice to make about one');

// ── blasts do not reach drones through walls ─────────────────────────────────
check('the drone blast pass respects cover', /blastOcclusionEnabled && mapCollider && dist > 1e-4/.test(blast),
  'ground victims have gone through blastExposure since it was written; this path was pure distance');
check('...and a blocked drone takes nothing', /if \(exposure > 0\) hit\.push/.test(blast));

// ── the shooter keeps its target through a blocked frame ─────────────────────
check('a single occluded frame does not drop the air target', /AIR_LOS_GRACE_MS/.test(src),
  'dropping the lock restarts the recognition delay, so a bobbing drone is never actually fired at');
check('...and the lock survives a marginally closer rival', /lockId: actor\.airTargetId, lockMargin: DRONE_LOCK_MARGIN/.test(src));

// ── an aircraft flies with the numbers it launched with, damage included ─────
check('the blast weapon can be asked for the drone\'s own def', /function droneBlastWeapon\(kind, def = null\)/.test(src));
check('...and a dropped bomb carries them rather than re-reading the sliders',
  /blastRadius: def\.blastRadius,\s*\n\s*damage: def\.damage,/.test(src),
  'nudging the damage slider mid-sortie changed the bomb already falling');
check('...and the detonation reads them back off the projectile', /droneWeaponById\(proj\.weaponId, proj\)/.test(src),
  'the drone that dropped it may be long gone by the time it lands');

// ── the cluster pick respects the operator\'s own blast ───────────────────────
check('the cluster pick honours the self-splash range', /minRange: OPERATOR_DEFAULTS\.minTargetRange/.test(src),
  'the launch gate checked the seed, then the pick could choose a neighbour metres nearer the operator');

// ── the drone bomb is not a weapons.js weapon, so the projectile path must know it ──
check('the projectile detonation resolves drone ordnance first',
  /droneWeaponById\(proj\.weaponId, proj\) \|\| getWeapon\(proj\.weaponId\)/.test(src),
  'without it a drone bomb detonates with whatever the thrower happens to be holding');

console.log(failures === 0 ? '\nbot-viewer drones: all checks passed'
  : `\nbot-viewer drones: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
