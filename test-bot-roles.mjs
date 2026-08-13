// Node tests for bot-roles.js (pure role registry + batch assignment + squad-leader pick).
// Run: node test-bot-roles.mjs
import {
  ROLE_RIFLEMAN, ROLE_MEDIC, ROLE_SNIPER, ROLE_TECHNICAL, ROLE_DRONE_OPERATOR, DEFAULT_ROLE, ROLES, ROLE_DEFAULTS,
  isRole, getRole, roleMaxPacks, assignRolesToBatch, pickSquadLeader,
  squadRanks, boundingRole, PUSH_BOUND_MS,
} from './bot-roles.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }
const count = (arr, v) => arr.filter((x) => x === v).length;

// registry basics
ok(DEFAULT_ROLE === ROLE_RIFLEMAN, 'default role is rifleman');
ok(isRole(ROLE_MEDIC) && !isRole('grenadier'), 'isRole reflects the catalogue');
ok(getRole('nonsense') === ROLES[DEFAULT_ROLE], 'unknown role falls back to the default descriptor');
ok(roleMaxPacks(ROLE_MEDIC) === 4 && roleMaxPacks(ROLE_RIFLEMAN) === 2, 'medic carries more packs than a rifleman');
ok(ROLES[ROLE_MEDIC].canRevive && !ROLES[ROLE_RIFLEMAN].canRevive, 'only the medic can revive');
ok(ROLES[ROLE_MEDIC].weapon === 'five_seven', 'medic prefers the sidearm');

// every descriptor carries the full field set, so callers never have to default a role field
for (const [id, role] of Object.entries(ROLES)) {
  ok(Object.keys(ROLE_DEFAULTS).every((k) => role[k] !== undefined), `${id} carries every loadout field`);
}
ok(getRole(ROLE_RIFLEMAN).sightScale === 1 && getRole(ROLE_RIFLEMAN).bonusGrenades === 0 &&
  getRole(ROLE_RIFLEMAN).swapOnDryMag === true && getRole(ROLE_RIFLEMAN).closeRange === 0,
  'the line role is the neutral baseline every field is measured against');

// sniper: sees further, and its bolt-action must not read an empty mag as a reason to swap
ok(ROLES[ROLE_SNIPER].weapon === 'm24' && ROLES[ROLE_SNIPER].sidearm === null, 'sniper carries the m24 over a picked pistol');
ok(ROLES[ROLE_SNIPER].sightScale === 1.5, 'sniper sees 1.5x as far as the line');
ok(ROLES[ROLE_SNIPER].swapOnDryMag === false, 'a bolt-action empties every shot, so a dry mag is not a swap trigger');
ok(ROLES[ROLE_SNIPER].closeRange > 0, 'sniper draws its pistol on anyone who closes the distance');
ok(ROLES[ROLE_SNIPER].support && ROLES[ROLE_SNIPER].leadership < ROLES[ROLE_RIFLEMAN].leadership,
  'a sniper takes a rear slot and never leads a squad over a rifleman');

// technical: rocket + rifle, an extra grenade, and a blast-radius standoff
ok(ROLES[ROLE_TECHNICAL].weapon === 'rpg' && ROLES[ROLE_TECHNICAL].sidearm === 'cz_805_bren',
  'technical backs the rocket with a rifle, not a pistol');
ok(ROLES[ROLE_TECHNICAL].bonusGrenades === 1, 'technical carries one grenade more than the line');
ok(ROLES[ROLE_TECHNICAL].closeRange >= 8.2, 'technical stops using the rocket inside its own blast radius');
ok(ROLES[ROLE_TECHNICAL].swapOnDryMag, 'a spent rocket tube is exactly when the rifle comes out');

// drone operator: fights through its aircraft, so it holds a sniper's distance without a sniper's gun
ok(ROLES[ROLE_DRONE_OPERATOR].standoffScale > 1 && ROLE_DEFAULTS.standoffScale === 1,
  'only the operator moves its preferred fighting distance off the weapon-derived default');
ok(ROLES[ROLE_DRONE_OPERATOR].sightScale > 1, 'an operator has to spot targets for its drones');
ok(ROLES[ROLE_DRONE_OPERATOR].support && ROLES[ROLE_DRONE_OPERATOR].leadership === 0,
  'the operator takes a rear slot and never leads a squad');
ok(ROLES[ROLE_DRONE_OPERATOR].insignia !== ROLES[ROLE_SNIPER].insignia, 'every role reads differently overhead');

// batch assignment: percentage of the batch, evenly spread, deterministic
ok(count(assignRolesToBatch(8, { medicPercent: 25 }), ROLE_MEDIC) === 2, '25% of 8 -> 2 medics');
ok(count(assignRolesToBatch(8, { medicPercent: 0 }), ROLE_MEDIC) === 0, '0% -> no medics');
ok(count(assignRolesToBatch(4, { medicPercent: 100 }), ROLE_MEDIC) === 4, '100% -> all medics');
ok(count(assignRolesToBatch(1, { medicPercent: 25 }), ROLE_MEDIC) === 0, 'a single-bot batch at 25% rounds to 0 medics');
ok(count(assignRolesToBatch(2, { medicPercent: 50 }), ROLE_MEDIC) === 1, '50% of 2 -> 1 medic');
ok(assignRolesToBatch(0, { medicPercent: 50 }).length === 0, 'empty batch stays empty');
{
  // even spread: with 2 medics in 10, they should not be adjacent at the very front
  const roles = assignRolesToBatch(10, { medicPercent: 20 });
  const idxs = roles.map((r, i) => (r === ROLE_MEDIC ? i : -1)).filter((i) => i >= 0);
  ok(idxs.length === 2 && idxs[1] - idxs[0] >= 3, `medics are spread across the batch (${idxs.join(',')})`);
  ok(new Set(idxs).size === idxs.length, 'no two medics land on the same slot');
}
// determinism
ok(JSON.stringify(assignRolesToBatch(7, { medicPercent: 40 })) === JSON.stringify(assignRolesToBatch(7, { medicPercent: 40 })),
  'assignment is deterministic for the same inputs');

// specialist mix: several roles share one batch without cannibalising each other's slots
{
  const mix = { [ROLE_SNIPER]: 20, [ROLE_TECHNICAL]: 20 };
  const roles = assignRolesToBatch(10, { medicPercent: 20, mix });
  ok(count(roles, ROLE_MEDIC) === 2 && count(roles, ROLE_SNIPER) === 2 && count(roles, ROLE_TECHNICAL) === 2,
    `each role gets its own share (${roles.join(',')})`);
  ok(count(roles, ROLE_RIFLEMAN) === 4, 'the remainder stays riflemen');
  ok(JSON.stringify(roles) === JSON.stringify(assignRolesToBatch(10, { medicPercent: 20, mix })), 'the mix is deterministic');
}
{
  // over-subscribed: the batch fills up and later roles simply miss out, never overwrite
  const roles = assignRolesToBatch(4, { medicPercent: 100, mix: { [ROLE_SNIPER]: 100 } });
  ok(count(roles, ROLE_MEDIC) === 4 && count(roles, ROLE_SNIPER) === 0, 'a full batch leaves nothing for the next role');
  ok(roles.length === 4, 'over-subscription never grows the batch');
}
ok(count(assignRolesToBatch(6, { mix: { [ROLE_RIFLEMAN]: 100 } }), ROLE_RIFLEMAN) === 6,
  'asking for the base role is a no-op, not a double assignment');
ok(count(assignRolesToBatch(6, { mix: { nonsense: 100 } }), ROLE_RIFLEMAN) === 6, 'an unknown role id in the mix is ignored');

// squad-leader pick prefers higher leadership, then lowest id
ok(pickSquadLeader([]) === null, 'no members -> no leader');
{
  const leader = pickSquadLeader([{ id: 'b3', role: ROLE_MEDIC }, { id: 'b1', role: ROLE_RIFLEMAN }, { id: 'b2', role: ROLE_MEDIC }]);
  ok(leader.id === 'b1', 'a rifleman (leadership 1) outranks medics (leadership 0)');
}
{
  const leader = pickSquadLeader([{ id: 'b9', role: ROLE_RIFLEMAN }, { id: 'b4', role: ROLE_RIFLEMAN }]);
  ok(leader.id === 'b4', 'equal leadership breaks to the lowest id');
}

// squad ranking: stable order, leader first
{
  const members = [{ id: 'b3' }, { id: 'b1' }, { id: 'b2' }];
  ok(JSON.stringify(squadRanks(members)) === '["b1","b2","b3"]', 'ranks sort by id when there is no leader');
  ok(JSON.stringify(squadRanks(members, 'b3')) === '["b3","b1","b2"]', 'the leader is pulled to rank 0');
  ok(JSON.stringify(squadRanks(members, 'b1')) === '["b1","b2","b3"]', 'a leader already at rank 0 stays put');
  ok(JSON.stringify(squadRanks(members, 'gone')) === '["b1","b2","b3"]', 'an unknown leader id is ignored');
  ok(squadRanks([]).length === 0 && squadRanks([null, undefined, {}]).length === 0, 'empty/degenerate members yield no ranks');
  ok(JSON.stringify(squadRanks(members, 'b2')) === JSON.stringify(squadRanks([...members].reverse(), 'b2')),
    'ranking is independent of input order');
}

// bounding overwatch: elements interleave by rank and trade jobs every bound
{
  ok(boundingRole(0, 0) === 'base' && boundingRole(1, 0) === 'move' && boundingRole(2, 0) === 'base',
    'at the start, even ranks hold and odd ranks move');
  ok(boundingRole(0, PUSH_BOUND_MS) === 'move' && boundingRole(1, PUSH_BOUND_MS) === 'base',
    'the elements swap after one bound');
  ok(boundingRole(0, PUSH_BOUND_MS * 2) === 'base', 'and swap back after the next');
  ok(boundingRole(0, PUSH_BOUND_MS - 1) === 'base', 'the swap happens on the boundary, not before');
  ok(boundingRole(-1, 0) === 'move', 'a non-member never holds for a squad it is not in');
  ok(boundingRole(0, -500) === 'base' && boundingRole(0, NaN) === 'base', 'a bogus elapsed is treated as 0');
  ok(boundingRole(0, 900, 0) === 'move' || boundingRole(0, 900, 0) === 'base', 'a zero bound length does not divide by zero');
  {
    // A 3-bot squad always has someone shooting and someone moving, in every bound.
    const roles = (bound) => [0, 1, 2].map((r) => boundingRole(r, bound * PUSH_BOUND_MS));
    ok(roles(0).includes('base') && roles(0).includes('move'), 'bound 0 splits the squad');
    ok(roles(1).includes('base') && roles(1).includes('move'), 'bound 1 splits the squad');
  }
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('bot-roles: all assertions passed');
