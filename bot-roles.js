// Pure, THREE-free role registry for the combat bots. A "role" is a data descriptor that tweaks a
// bot's loadout and unlocks behaviour hooks (the medic's heal/revive/cohesion logic lives in
// bot-medic.js). Roles are the substrate the squad system will build on: a squad is an emergent
// group of same-team bots, and which bot leads it is decided from role metadata (`leadership`),
// not hard-coded. Adding a role = adding one descriptor here (+ its behaviour module); nothing in
// the viewer should branch on a literal role id beyond dispatching to that module.
//
// Unit-tested in test-bot-roles.mjs. World-wiring (meshes, spawn UI, per-frame behaviour) stays in
// bot-viewer.html; only the role catalogue and batch assignment math live here.

import { MAX_HELD_PACKS } from './bot-health-packs.js';

export const ROLE_RIFLEMAN = 'rifleman';
export const ROLE_MEDIC = 'medic';
export const ROLE_SQUAD_LEADER = 'squadleader';
export const ROLE_SNIPER = 'sniper';
export const ROLE_TECHNICAL = 'technical';
export const ROLE_DRONE_OPERATOR = 'droneop';
export const DEFAULT_ROLE = ROLE_RIFLEMAN;

// Descriptor fields:
//   label        - UI/debug name.
//   maxPacks     - health-pack carry capacity (bot-health-packs canHold/addPack `max`).
//   startingPacks- packs granted at spawn.
//   weapon       - preferred weapon id, or null to inherit the toolbar weapon.
//   insignia     - overhead marker style ('cross' | 'chevron' | 'ring' | 'triangle' | 'diamond') so
//                  the role reads at a glance. Every role has one; the leader chevron is a SEPARATE
//                  overhead marker layered on top by the viewer (setSquadLeaderMark), independent of
//                  role, so whoever is actually leading a squad shows both their class insignia and
//                  the leader chevron at once.
//   canRevive    - may fuse packs into revive kits and revive fallen allies.
//   leadership   - relative fitness to lead a squad (higher = more likely leader). A support role
//                  sits below a line role so squads rally on a fighter, not a medic; the dedicated
//                  squad leader sits above both, so succession promotes a rifleman only once the
//                  real leader is gone. Ties break on lowest id (pickSquadLeader).
//   support      - not part of the fighting line. Takes rear formation slots (formationRanks), never
//                  draws the maneuver element of a bounding push, and prefers its own squad's
//                  casualties over a stranger's. A support role walking point is the tell that a
//                  squad is treating it as just another rifle.
// Loadout/perception fields (all optional; the values below are the defaults every role inherits):
//   sidearm      - explicit backup weapon id, overriding bot-sidearm's pistol pick (technical: AR).
//   sightScale   - multiplier on the viewer's sight distance, so a role can out-see the line.
//   bonusGrenades- extra grenades granted at spawn/restock on top of the global carry count.
//   swapOnDryMag - draw the backup when the primary's mag empties mid-fight. False for bolt-action
//                  primaries, where an empty mag is simply the state between shots.
//   closeRange   - metres at which the primary is the wrong tool and the backup comes out anyway.
//   standoffScale- multiplier on the weapon-derived preferred fighting distance, for a role whose
//                  job is done from behind the line rather than in it (drone operator 1.9x).
export const ROLE_DEFAULTS = {
  sidearm: null, sightScale: 1, bonusGrenades: 0, swapOnDryMag: true, closeRange: 0, standoffScale: 1,
};
export const ROLES = {
  [ROLE_RIFLEMAN]: {
    id: ROLE_RIFLEMAN, label: 'Rifleman',
    maxPacks: MAX_HELD_PACKS, startingPacks: 1,
    weapon: null, insignia: 'diamond', canRevive: false, leadership: 1, support: false,
  },
  [ROLE_MEDIC]: {
    id: ROLE_MEDIC, label: 'Medic',
    maxPacks: 4, startingPacks: 2,
    weapon: 'five_seven', insignia: 'cross', canRevive: true, leadership: 0, support: true,
  },
  [ROLE_SQUAD_LEADER]: {
    id: ROLE_SQUAD_LEADER, label: 'Squad leader',
    maxPacks: MAX_HELD_PACKS, startingPacks: 1,
    weapon: null, insignia: 'chevron', canRevive: false, leadership: 2, support: false,
  },
  // Long-range specialist: sees half again as far as the line, so it opens the engagement. Its
  // bolt-action holds one round, so a dry mag is not a crisis -- only a rusher inside closeRange is.
  [ROLE_SNIPER]: {
    id: ROLE_SNIPER, label: 'Sniper',
    maxPacks: MAX_HELD_PACKS, startingPacks: 1,
    weapon: 'm24', insignia: 'ring', canRevive: false, leadership: 0, support: true,
    sightScale: 1.5, swapOnDryMag: false, closeRange: 14,
  },
  // Heavy weapons: one rocket at a time backed by a full rifle, so the reload after every rocket is
  // spent shooting rather than standing still. The spare grenade is the rest of its demolition kit.
  // closeRange is above the RPG's 8.2 m blast radius -- inside it the rocket kills the shooter too.
  [ROLE_TECHNICAL]: {
    id: ROLE_TECHNICAL, label: 'Technical',
    maxPacks: MAX_HELD_PACKS, startingPacks: 1,
    weapon: 'rpg', sidearm: 'cz_805_bren', insignia: 'triangle', canRevive: false, leadership: 1, support: false,
    bonusGrenades: 1, closeRange: 10,
  },
  // Drone operator: the fighting is done by the aircraft (bot-drones.js), so the man himself hangs
  // back with a rifle and a wider view. Its standoff is a sniper's without a sniper's weapon.
  [ROLE_DRONE_OPERATOR]: {
    id: ROLE_DRONE_OPERATOR, label: 'Drone operator',
    maxPacks: MAX_HELD_PACKS, startingPacks: 1,
    weapon: 'cz_805_bren', insignia: 'rotor', canRevive: false, leadership: 0, support: true,
    sightScale: 1.35, standoffScale: 1.9,
  },
};
// Every descriptor carries the full field set, so callers never have to `?? default` a role field.
for (const [id, role] of Object.entries(ROLES)) ROLES[id] = { ...ROLE_DEFAULTS, ...role };

export function isRole(id) { return Object.prototype.hasOwnProperty.call(ROLES, id); }
export function getRole(id) { return ROLES[id] || ROLES[DEFAULT_ROLE]; }
export function roleMaxPacks(id) { return getRole(id).maxPacks; }

// Assign roles across a freshly-spawned batch. `medicPercent` (0..100) of the batch become medics;
// `mix` ({ roleId: percent }) adds any other specialist on the same terms. Each role is evenly
// spaced through the batch (deterministic -- no RNG -- so a mixed spawn interleaves specialists
// among riflemen rather than clumping them), and a slot already taken by an earlier specialist is
// never overwritten: the percentages share the batch instead of cannibalising each other. Returns
// an array of role ids, length `count`.
export function assignRolesToBatch(count, { medicPercent = 0, medicRole = ROLE_MEDIC, baseRole = DEFAULT_ROLE, mix = null } = {}) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const roles = new Array(n).fill(baseRole);
  const wanted = [[medicRole, medicPercent], ...(mix ? Object.entries(mix) : [])];
  let placed = 0;
  for (const [roleId, percent] of wanted) {
    if (!roleId || roleId === baseRole || !isRole(roleId)) continue;
    const pct = Math.max(0, Math.min(100, Number(percent) || 0));
    const take = Math.min(n - placed, Math.round((n * pct) / 100));
    for (let i = 0; i < take; i++) {
      const idx = Math.min(n - 1, Math.floor(((i + 0.5) * n) / take));
      for (let k = 0; k < n; k++) {          // nearest free slot at/after the ideal one, wrapping
        const at = (idx + k) % n;
        if (roles[at] === baseRole) { roles[at] = roleId; placed++; break; }
      }
    }
  }
  return roles;
}

// Pick the squad leader from a set of members by highest `leadership`, ties broken by lowest id so
// the choice is stable frame-to-frame. Members are { id, role }. Returns the winning member or null.
export function pickSquadLeader(members = []) {
  let best = null;
  for (const m of members) {
    if (!m) continue;
    const score = getRole(m.role).leadership;
    if (!best || score > best.score || (score === best.score && String(m.id) < String(best.member.id))) {
      best = { member: m, score };
    }
  }
  return best?.member ?? null;
}

// ─── bounding overwatch (S11) ───────────────────────────────────────────────
// A push used to be N bots independently charging the same anchor. Split them instead: half hold
// and shoot (base of fire) while half move, then swap. Both halves are derived from a stable rank,
// so every member of the squad computes the same split without any messaging.

export const PUSH_BOUND_MS = 2500;   // how long one element moves before the elements trade jobs

// Member ids in rank order: sorted for stability, leader pulled to rank 0 so the squad's split is
// anchored on the leader rather than on whoever happens to sort first.
export function squadRanks(members = [], leaderId = null) {
  const ids = [];
  for (const m of members) if (m && m.id != null) ids.push(String(m.id));
  ids.sort();
  const leader = leaderId == null ? null : String(leaderId);
  const at = leader == null ? -1 : ids.indexOf(leader);
  if (at > 0) { ids.splice(at, 1); ids.unshift(leader); }
  return ids;
}

// 'base' = hold and put rounds down; 'move' = advance. Alternates by rank so the elements
// interleave, and flips every `boundMs` so neither element is pinned in place for the whole push.
export function boundingRole(rank, elapsedMs, boundMs = PUSH_BOUND_MS) {
  if (!(rank >= 0)) return 'move';   // not a squad member (rank -1): nobody is holding for it
  const bound = Math.floor(Math.max(0, Number(elapsedMs) || 0) / Math.max(1, boundMs));
  return (Math.floor(rank) + bound) % 2 === 0 ? 'base' : 'move';
}
