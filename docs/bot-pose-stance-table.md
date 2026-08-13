# Bot pose and stance triggers — bot-viewer-v3

Collated from five independent surveys of `bot-viewer-v3.html` and its modules, 2026-08-08.
Where the five disagreed, the disagreement is noted in the row rather than resolved silently.

Posture is not one system. Four channels resolve independently every frame:

1. **Body stance** — `bot-stance.js`, five values, drives the rig weights, capsule height, speed, spread, turn rate.
2. **Weapon carry** — `weapon-hold-resolver.js`, five locomotion values, drives where the gun rides.
3. **Weapon action** — `weapon-pose-controller.js`, drives the weapon root pose, recoil, hand IK.
4. **Body pose overlay** — `desiredPose` in the viewer, drives the medic and self-heal arm poses.

Only channel 1 is what `chooseBotStance` decides. The others read its output but are not part of it.

## Table 1 — the stance ladder

`chooseBotStance` (`bot-stance.js:73-118`) is a strict if-chain. Row order **is** the precedence.
Called once per bot per frame at `bot-viewer-v3.html:10894`.

| # | Stance | Trigger, as coded | Decided at | Drives | Discrete or continuous |
|---|---|---|---|---|---|
| 0 | `STANCE_STAND` | `!settings.enabled` — master gate off | `bot-stance.js:74` | short-circuits the whole ladder for every bot | discrete |
| 1 | `STANCE_DASH` | `evading` — `activeBotActor.evadingUntil > now`, stamped by `updateGrenadeEvade`, 600 ms linger | `bot-stance.js:82`; stamp `bot-viewer-v3.html:9431` | speed ×1.15 on top of run, spread ×1.9, one-handed carry, support hand tucked at the chest | discrete; exit cost 0 |
| 2 | `STANCE_CROUCH` | `forcedCrouch` — `state === BOT_HEAL` or `packPickupCrouchUntil > now` (450 ms dip) | `bot-stance.js:83`; computed `:10866-10868`; dip stamped `:5780` | crouch weight | discrete trigger, continuous blend |
| 3 | `STANCE_CROUCH` (heal) / `STANCE_KNEEL` (tend) | `state === 'heal'` crouches; `state === 'medic-tend'` kneels | `bot-stance.js` heal/tend rungs | crouch or kneel weight; also selects the medic pose overlay | discrete |
| 4 | `STANCE_PRONE`, else `STANCE_KNEEL` | `holding` and `proneEnabled` and `holdElapsedMs >= 1200`; otherwise kneel | `bot-stance.js` hold rung; `holding` at `:10862-10863` | prone or kneel weight | discrete, gated on an elapsed timer |
| 5 | `STANCE_CROUCH` / `STANCE_STAND` | `state === 'cover-hold'`: peek phase `'in'` → crouch, else `peekExposed` → stand, else crouch | `bot-stance.js:96-99`; peek machine `bot-cover.js:33-62` | crouch weight, and whether the bot may fire | discrete, driven by a continuous slide |
| 6 | `STANCE_CROUCH` | `state === 'alert' \|\| alertHeld` | `bot-stance.js:100`; `'alert'` stamped `:10859` | crouch weight | discrete |
| 7 | `STANCE_RUN` | `state` in `pursue, flee, cover-move, medic-move, knife` | `bot-stance.js:101` | speed × run multiplier (1.7), spread ×1.25 | discrete |
| 8 | `STANCE_RUN` | `state === 'patrol' && doubleTime` | `bot-stance.js:104`; flag `:10892-10893` | as row 7 | discrete |
| 9 | `STANCE_KNEEL` / `STANCE_CROUCH` / `STANCE_STAND` | `state` in `aim, fire`: kneel past `16 − (alreadyKneeling ? 2.5 : 0)`, else crouch past `8 − (alreadyCrouched ? 1.5 : 0)`, else stand | `bot-stance.js` aim rung | kneel or crouch weight | discrete pick on two nested continuous thresholds, each with its own hysteresis |
| 10 | `STANCE_CROUCH` / `STANCE_STAND` | `state === 'seek'`: crouch if `distanceToLastKnown <= 4 + (alreadyCrouched ? 1 : 0)` | `bot-stance.js:112-116` | crouch weight | discrete pick on a continuous threshold with hysteresis |
| 11 | `STANCE_STAND` | fallthrough — `patrol` without double-time, or any unrecognised state | `bot-stance.js:117` | upright | discrete |
| 12 | UI force-override | `botStanceOverride` is not `'auto'` | `bot-stance.js:252-256`; applied `:10898` | replaces the resolved stance outright, after the latch | discrete; wins over everything above |

**Exit-cost latch** (`stepStanceTransition`, `bot-stance.js:134-148`): leaving prone costs 700 ms,
leaving crouch to anything but prone costs 220 ms, entering a lower stance is free, and dash always
pays zero. This is what stops the roster flopping between stances every frame.

**Blend** (`stepStanceWeights`, `bot-stance.js:219-230`): the discrete pick eases into `crouch01`
and `prone01` at 9/s and 5/s. Those two weights drive the rig, the capsule height, and the weapon
hold, so the body and the gun can never disagree mid-transition.

## Table 2 — FSM states and whether they own a posture

Ladder in `bot-activity.js:10-19`, plus `bot-medic.js:11-12`, plus two viewer-local strings.

| State | Owns a rung? | Which |
|---|---|---|
| `patrol` | Only under double-time | row 8, else falls through to stand |
| `seek` | Yes | row 10, distance-gated |
| `pursue` | Yes | row 7, run |
| `flee` | Yes | row 7, run |
| `heal` | Yes | rows 2 and 3, crouch, plus the `rifleHeal` overlay |
| `knife` | Yes | row 7, run |
| `aim` | Yes | row 9, distance-gated |
| `fire` | Yes | row 9, same rung as aim |
| `cover-move` | Yes | row 7, run |
| `cover-hold` | Yes | row 5, peek-gated |
| `medic-move` | Yes | row 7, run |
| `medic-tend` | Yes | row 3, crouch, plus the `medicAid` or `medicHold` overlay |
| `alert` | Yes | row 6, crouch. Viewer-local string, not a `bot-activity.js` export |
| `reposition` | No | viewer-local, `:10576`, falls through to stand |
| `grenade` | No | telemetry label only, `:9273`; the real state is unchanged during a wind-up |
| `dead` | No | bypasses the stance system entirely, see Table 4 |

## Table 3 — the other three channels

### Weapon carry (`weapon-hold-resolver.js:144-149`)

| Locomotion | Trigger | Note |
|---|---|---|
| `LOCOMOTION_AIM` | `aiming` — state in `aim, fire, flee, cover-move, cover-hold, medic-move, medic-tend` | wins over everything; `knife` is deliberately absent |
| `LOCOMOTION_DASH` | `stance === 'dash'` | one-handed, support hand tucked |
| `LOCOMOTION_RUN` | `stance === 'run'` | cross-body carry |
| `LOCOMOTION_WALK` | speed > 0.35 m/s | rolled across the chest |
| `LOCOMOTION_IDLE` | otherwise | bare stance hold |

### Weapon action (`weapon-pose-controller.js`)

Reload sequence, fire recoil decaying over 0.22 s, and a continuous aim blend between `lowReady`
and `aimed`. The `'swap'` action is in the enum but no call site plays it.

### Body pose overlay (`bot-viewer-v3.html:3990-4007`)

| Overlay | Trigger | Effect |
|---|---|---|
| `rifleHeal` | `botState === BOT_HEAL` | weapon hidden, both hands work a pack |
| `medicAid` | medic, `MEDIC_TEND`, not under fire | weapon hidden, both hands on the patient |
| `medicHold` | medic, `MEDIC_TEND`, under fire | weapon stays out, only the left arm overrides |

## Table 4 — death

Ragdoll on: a Verlet ragdoll is seeded from the live rig and stepped every frame until it sleeps.
Ragdoll off or no procedural body: the capsule is rotated to a single fixed angle. Either way the
stance system is bypassed entirely.

## Table 5 — every threshold that picks a posture

| Threshold | Value | Gates |
|---|---|---|
| `aimCrouchDistance` | 8 m, hysteresis 1.5 m | crouch vs stand while aiming or firing |
| `seekCrouchRadius` | 4 m, hysteresis 1 m | crouch vs stand while searching |
| `proneMinHoldMs` | 1200 ms | prone vs crouch under a hold |
| `standUpMs` / `crouchUpMs` | 700 / 220 ms | how long the old stance is kept |
| `pickupCrouchMs` | 450 ms | the pack-pickup dip |
| grenade evade linger | 600 ms | how long dash outlives the threat |
| `MEDIC_TEND_COMBAT_MS` | 5000 ms | `medicHold` vs `medicAid` |
| `CARRY_MOVING_SPEED` | 0.35 m/s | walk vs idle carry, not stance |

Health and ammo never reach `chooseBotStance` directly. Both are laundered through the FSM state
first: health picks `heal` or `flee`, ammo picks `flee` or `knife`, and stance only sees the result.

## Gaps the five surveys agreed on

- ~~`state.kneel` is fully implemented in `player-procedural-body.js` and driven by nothing.~~
  **Fixed 2026-08-08.** `STANCE_KNEEL` now exists in `bot-stance.js` and bot-viewer-v3 drives
  `st.kneel` off a third `kneel01` weight. It takes the `medic-tend` rung, the commanded-hold rung
  (below the prone timer), and a new long-range `aim`/`fire` band that coexists with the crouch band.
  See `docs/subsystems/bots.md`. Note the measured surprise: a kneeling bot is a **taller** target
  than this rig's deep-squat crouch, so kneel earns the long shot on stability, not on silhouette.
  **Follow-up 2026-08-11.** That same surprise had a second consequence the first pass missed: the
  weapon hold. The mount is pinned at `feetY + 1.5` and never moves with stance, so the authored
  hold's Y is the only thing expressing a stance's shoulder drop — and kneel had no hold, borrowing
  crouch's. Measured, that put a kneeling rifle 0.51 m below its own shoulders. Auditing it turned up
  a pre-existing bug underneath: every weapon's `crouchHold` was its stand hold with Y overwritten by
  a flat −0.09, which cannot express a per-weapon offset (rifle 0.25 m low, pistol 0.23 m high). Both
  are fixed; `kneelHold` is now a real slot and all the values are derived from the rig and pinned by
  `test-weapon-hold-resolver.mjs`.
- Prone is reachable only through the commanded-hold rung, and is off by default. Kneel is the rung
  a held bot now actually reaches while the prone timer runs.
- The knife charge has no swing pose and is excluded from the aim carry, so a bot closing for a
  kill runs with the rifle slung.
- The sidearm draw has no draw pose; `swapUntil` is a fire-blocking timer only.
- No hit-reaction, flinch, vault, or climb pose exists anywhere in scope.
- `'alert'` is missing from `bot-state-code.js`'s `STATE_CHARS`, so the state-code trace records
  those frames as patrol. Reported by one survey of five, not yet independently confirmed.
