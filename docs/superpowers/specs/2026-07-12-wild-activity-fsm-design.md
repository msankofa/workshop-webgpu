# Wild-creature activity FSM (Phase 2)

Status: IN PROGRESS (2026-07-12). Builds on Phase 1 (self-relative wander, `pickRoamTarget`).

## Goal
Make `ROLE_WILD` port-creatures autonomously choose among life activities — wander, sleep,
hunt, socialize, graze — instead of every creature obeying the single global Mode. Phase 3
will bias the choice by per-creature temperament; Phase 2 lands the FSM + activities with
neutral (uniform, context-gated) weights.

## Where the FSM applies (roster loop, port-creature-system.js ~:4965)
Selection precedence per creature, unchanged for non-wild roles:
- `ROLE_PET` / `ROLE_HOSTILE` → as today.
- `ROLE_WILD` **and** `_wildlife` → **always** run the activity FSM (ignores global Mode, as
  ambient wildlife does today).
- `ROLE_WILD`, not `_wildlife` → run the FSM **only when `currentBehavior === 'wander'`**
  (the default). Any explicit Mode (combat/forage/race/target/stay/direction/follow) still
  overrides globally, preserving the authoring tools.

## Activities
Constants live in a new pure module `creature-activity.js` (THREE-free, Node-tested, mirrors
`creature-interaction.js` style): `ACT_WANDER, ACT_SLEEP, ACT_HUNT, ACT_SOCIALIZE, ACT_GRAZE`.

| Activity | Steering | Pose / anim | Notes |
|---|---|---|---|
| wander | existing `pickRoamTarget` roam | normal gait | default idle activity |
| sleep | zero speed (stay put) | settle low via rest-pose channel, blinkers off | slow HP regen; wakes on threat or damage |
| hunt | approach a chosen `huntTarget` to melee range, then the existing combat FSM strikes | combat arms | reuses `updateCombat`; ends on kill / lost target / timeout |
| socialize | approach a chosen `socialTarget` (kin) and loiter at a standoff | normal gait | re-pick buddy occasionally |
| graze | zero speed (stay put) | head-down crouch (reuse `forageCrouch` lowering) | brief; light HP regen |

## Pure module API (`creature-activity.js`)
- `defaultTemperament()` → neutral weight table (Phase 3 replaces per creature).
- `chooseActivity({ current, ctx, weights, rand })` → `{ activity, duration }`.
  - `ctx` (scalars/booleans the caller computes from the world): `preyDist` (∞ if none),
    `kinDist` (∞ if none), `threatDist` (∞ if none), `hp01` (0..1), `restedness` (0..1).
  - Rules (Phase 2, context gates then weighted pick):
    - Never `hunt` if `preyDist` beyond `HUNT_SENSE`; never `socialize` if `kinDist` beyond
      `SOCIAL_SENSE`.
    - `threatDist < THREAT_NEAR` forces exit from `sleep`/`graze` (return a non-resting
      activity immediately).
    - Otherwise weighted-random among eligible activities; `sleep` weight rises as `hp01`
      falls; keep durations in per-activity ranges (`ACT_DURATION[activity] = [min,max]`).
  - Deterministic given `rand`.
- `activitySteer(activity)` → `{ steer, restPose }` mapping to the roster loop's
  `steerBehavior` ('wander' | 'stay' | 'hunt' | 'socialize' | 'graze' as needed) and a target
  rest-pose scalar (0 normal … 1 fully settled) so the caller drives the pose channel.

Add `test-creature-activity.mjs`: eligibility gating, threat-interrupt, hp-weighted sleep,
duration bounds, determinism.

## Integration (port-creature-system.js)
Per-creature fields (constructor): `activity = ACT_WANDER`, `activityTimer` (rand within the
wander range so they desync), `huntTarget = null`, `socialTarget = null`, `restPose = 0`.

New method `updateActivity(all, dt)` (called once per creature per frame, before steering,
only for FSM-eligible wild creatures):
1. Tick `activityTimer -= dt`. Build `ctx`: nearest valid prey / kin / threat via the
   existing spatial grid (`creatureGrid.nearby`), `hp01 = health/MAX_HEALTH`.
   - prey = nearest other creature within `HUNT_SENSE` (prefer weaker; skip same-`teamId` so
     packs don't self-hunt); kin = nearest same-`teamId` creature within `SOCIAL_SENSE`;
     threat = nearest `ROLE_HOSTILE` creature or a live hostile player within `THREAT_NEAR`.
2. On timer expiry (or a forced threat-interrupt), call `chooseActivity`, set `activity` +
   reset `activityTimer` to the returned duration, and latch `huntTarget`/`socialTarget`.
3. Ease `restPose` toward `activitySteer(activity).restPose`.

Steering hookup (roster loop): map `activity` → `steerBehavior`/`steerTarget`:
- `ACT_SLEEP`/`ACT_GRAZE` → `'stay'`.
- `ACT_HUNT` → new `'hunt'` branch in `computeSteering`: steer toward `this.huntTarget.pos`,
  stop at the same melee stop-distance the `'combat'` branch uses.
- `ACT_SOCIALIZE` → `'target'` toward `this.socialTarget.pos` with a loiter standoff.
- `ACT_WANDER` → `'wander'` (unchanged).

Combat hookup:
- `updateCombat` target (line ~2177): for wild hunters use `this.huntTarget` — i.e.
  `const target = this.role === ROLE_HOSTILE ? (hasLivePlayer() ? _playerProxy : null)
   : (this.activity === ACT_HUNT ? this.huntTarget : this.enemyTarget(all));`
- `updateCombat` active flag (line ~4954): add `|| (c.role === ROLE_WILD && c.activity === ACT_HUNT)`.

Sleep/rest:
- Wake on damage: `takeDamage` sets `activityTimer = 0` (forces re-decide next frame) so a
  slept creature doesn't get punched while inert.
- HP regen: while `ACT_SLEEP` (and lightly while `ACT_GRAZE`), heal a small amount/sec up to
  `MAX_HEALTH`.
- Render (~:2630): fold `restPose` into the body-lowering the crouch already applies so
  sleeping/grazing creatures visibly settle. Full prone/curl is deferred polish.

## Constraints
- Pets, hostiles, wildlife-spawner, and every non-`wander` global Mode must behave exactly as
  before. The FSM is additive, gated as specified.
- Terse one-line comments only; rationale in this spec + agent_log.
- Pure math (decisions, gating, durations) lives in `creature-activity.js` and is Node-tested;
  `port-creature-system.js` only does world queries + wiring.

## Phase 3 hook (not now)
`chooseActivity` already takes `weights`; Phase 3 seeds a per-creature temperament in
`variedCreatureConfig` and passes it in. Nothing else should need to change.
