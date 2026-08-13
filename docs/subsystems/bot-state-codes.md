# Bot state codes

> 🗺️ [View this subsystem in the interactive code map](../../code-map.html#bots)

Status: **module built and Node-tested** (`bot-state-code.js` / `test-bot-state-code.mjs`), reference
table generated (`gen-bot-state-table.mjs`), **wired into `bot-viewer-v2.html`** (2026-07-26) — see
"Viewer wiring" below; **browser QA pending**. Part of the combat-bot subsystem; the FSM itself is
documented in [`bots.md`](bots.md).

## What this is

A combat bot's discrete condition is a product of nine independent axes — `bot-activity.js`'s ladder
state, `bot-alert.js`'s escalation tiering, `bot-roles.js`/`bot-medic.js`'s role duty, plus the
ammo/health/pack/commit-latch resources the ladder reads. Debugging the FSM means answering
questions like "does a bot ever leave cover while the cover latch is still held?" or "how often does
a flee re-enter within 200 ms?", and until now the only way to ask was to watch bots and squint.

`bot-state-code.js` encodes that condition as a **9-character alphanumeric code**, one char per axis:

```
F44rb340G   full code
F4rbG       its 5-char behavioural core
            "Rifleman shooting, in a squad push as the base-of-fire element
             [sight-grace latched]."   <- describeBotState(code)
```

Codes are emitted per bot on change; a trace is a timestamped sequence of them. Because the code is
fixed-width and positional, every axis sits at a known offset: a trace is greppable, diffable
slot-by-slot (`diffCodes` reports only the slots that moved), and countable without a schema. The
pathologies
worth mining for — cover-thrash (`C…`↔`G…` at frame cadence), flee-boundary oscillation
(`E…`↔`U…` around the hysteresis band), latch leaks, medic duty flapping — are all patterns over
that character sequence, not over anything you can see on screen.

The module is pure and THREE-free, so all of it runs in Node.

## Slots

One character each, fixed order. `SLOTS` in the module is the single source for slot metadata and
is what `diffCodes` and `decodeBotState` read.

| # | Key | Meaning | Alphabet | Source field (viewer adapter) |
|---|---|---|---|---|
| 1 | `state` | FSM ladder rung, or the medic-duty override | `P`atrol `S`eek p`U`rsue fl`E`e `H`eal `K`nife `A`im `F`ire `C`over-move cover-hold(`G`) `M`edic-move medic-`T`end `D`ead | `chooseBotStateName(...)`, then `duty.state` from `decideMedicDuty` where a duty is live |
| 2 | `tier` | Alert tier | `0` calm `1` near-miss `2` wary `3` defensive `4` push | `tierSlot(actor.alertTierLast, nearMiss)` |
| 3 | `score` | Escalation score, clamped | `0`–`9` | `alertEscalation(...).score` (`bot-alert.js`) |
| 4 | `role` | Role | `r` rifleman, `m` medic | `actor.role` (`bot-roles.js` `ROLES`) |
| 5 | `element` | Push element | `-` none, `b` base-of-fire, `m` moving | `actor.pushElement` (`applyPushElement`) |
| 6 | `ammo` | Magazine state | `-` unarmed, `R` reloading, `0` empty, `1`–`4` quarter bands | `ammoSlot({ mag, magazineSize, reloading, hasWeapon })` |
| 7 | `health` | Health quintile | `0`–`4` | `healthBand(hp, maxHp)` |
| 8 | `packs` | Held heal packs; `A`–`E` mirror `0`–`4` with a revive kit also carried | `01234ABCDE` | `packSlot(actor.healthPacks.length, actor.reviveKits > 0)` |
| 9 | `latches` | 5 commit bits as one base32 char | `0`–`9`,`A`–`V` | `latchBits({ flee, cover, hold, healFlee, sightGrace })` |

The latch bits are `1` flee, `2` cover, `4` held-in-place, `8` heal-flee, `16` sight-grace —
`LATCH_FLEE` and friends in the module, sourced from `fleeCommitted` / `coverCommitted` / the
viewer's `holding` conjunction / `healFleeCommitted` / `stepVisibleDebounce`'s grace window.

**Bit 4 is "locomotion pinned", not "a hold lease exists"** (renamed `hold` → `held-in-place`,
2026-07-26). The viewer's `holding` local is `holdUntil > now && state is PATROL/SEEK/PURSUE`; the
lease itself survives across transitions, so "lease live" would have been nearly unconstrained and
would not have told a trace reader whether the bot is actually standing still on purpose. `'hold'`
survives as a **parse-only alias** in `LATCH_NAMES` so traces recorded under the old name still
decode; nothing displays it any more. `latchBits`'s flags-object key is also still `hold` — only the
display name changed.

**Medic duty is not a parallel axis.** `bot-viewer-v2.html` does `if (duty) state = duty.state;`,
overwriting the FSM's choice, so `medic-move`/`medic-tend` are two extra values of slot 1 gated by
`role = medic`, not a tenth slot. An earlier revision of this model gave duty its own slot and was
wrong about the whole shape of the state space as a result.

**The module owns the quantization.** `healthBand` / `ammoSlot` / `packSlot` / `latchBits` /
`tierSlot` are exported so bucketing lives in one testable place; `encodeBotState` takes
already-discretized fields only and never re-derives a band. An adapter that computes its own health
quintile has forked the encoding.

## API

| Export | Does |
|---|---|
| `encodeBotState(desc)` | `desc` of already-discretized fields → 9-char code. Every field is optional (defaults to the calm/idle/unarmed value) and accepts a long name, a slot char, or a number where that makes sense; junk falls back rather than emitting an off-alphabet char |
| `decodeBotState(code)` | Structured fields + resolved latch names + `legal`/`illegalReason`, or `null` for a malformed code. Works on illegal codes too |
| `coreCode(code)` | The 5-char core projection (slots 1,2,4,5,9); `''` if malformed |
| `describeBotState(code)` | One-line English reading, composed from the core slots only. A core code and its full code read identically |
| `isLegalCode(code)` / `illegalReason(code)` | Verdict, and the id of the first rule violated (or `bad-length` / `bad-slot-<key>`) |
| `enumerateLegalCodes()` / `enumerateCoreStates()` | The whole legal space (395,533) and the core rows (458). Both cached and shared — treat the arrays as read-only |
| `diffCodes(a, b)` | Changed slots only, each with `{ slot, key, name, from, to, fromLabel, toLabel }` — the per-transition row a trace viewer renders |
| `changedSlots(a, b)` | The same changed slots as a `'+'`-joined key string (`'state+ammo'`), allocating one string instead of a labelled object per slot. Use this on per-frame paths and `diffCodes` when the labels are actually displayed; a test pins the two to agree |
| `healthBand` `ammoSlot` `packSlot` `latchBits` `latchChar` `latchNamesFromBits` `tierSlot` | The quantizers, for the adapter to call before `encodeBotState` |

## Legality rules

18 rules. Each is a predicate over the slot chars that returns true when the combination is
**impossible** — `illegalReason(code)` reports the id of the first one that matches, so order
matters. They are the only record of *why* a combination cannot occur, and each one is a falsifiable
claim about the FSM: if a real trace ever contains an illegal code, either the rule is wrong or the
FSM has a bug, and both are worth knowing.

**Rules describe commit-time reality, not decision-time.** The trace samples at the tail of
`commitBotActor`, after the state-execution section has fired the shot, eaten the pack, and started
the reload that the *decision* predicates forbade. Three first-authoring rules encoded decision-time
invariants and were falsified by live bots on 2026-08-01 — `fire-needs-loaded-mag` (the emptying
shot's commit reads `R`/`0`; relaxed to `fire-needs-weapon`), `heal-needs-pack` +
`duty-requires-resource` (the completing heal/tend spends the last pack while slot 1 still says
`H`/`T`; both retired), and `sight-latch-scope` (the `reposition` and `alert` stamps encode as `P`
and can commit with the grace window open; retired — sight-grace on `D` is still banned by
`dead-collapses`).

Line numbers in `bot-viewer-v2.html` drift constantly, so the weapon rules cite predicate names
instead; the module's own comments carry the citations.

### Alert block

| Rule | Claim | Derives from |
|---|---|---|
| `score-zero-without-tier` | Calm or near-miss ⇒ score `0` | The viewer only feeds the escalation score into the alert ladder inside `if (report)`; with no live report there is no tier and no score to report |
| `wary-score-band` | Wary ⇒ score < 2 | `ALERT_DEFENSIVE_SCORE = 2` (`bot-alert.js:122`) — the wary branch is only reached after the `>= 2` branch fails |
| `defensive-score-band` | Defensive ⇒ score ≥ 2 | Same constant, the branch that consumes it |
| `push-score-band` | Push ⇒ score ≥ 4 | `ALERT_PUSH_SCORE = 4` (`bot-alert.js:123`) |
| `element-requires-push` | An element exists **iff** the tier is push | `applyPushElement` sets `base`/`move` only in the push branch, and `if (alertTier !== 'push') pushElement = null` clears it otherwise |

### Role and resources

| Rule | Claim | Derives from |
|---|---|---|
| `duty-requires-medic` | `medic-move`/`medic-tend` ⇒ role is medic | `decideMedicDuty` is only called for medics, and `state = duty.state` is the only way those values reach slot 1 |
| `kit-medic-only` | A rifleman never carries a revive kit (`A`–`E`) | `canRevive: false` on the rifleman descriptor (`bot-roles.js:30`) — only `canRevive` roles fuse packs into kits |
| `rifleman-pack-cap` | A rifleman holds at most 2 packs | `maxPacks: MAX_HELD_PACKS` (2) vs. the medic's 4 (`bot-roles.js:29`) |

`duty-requires-resource` and `heal-needs-pack` existed here until 2026-08-01: entry into H/M/T does
require the resource (`bot-activity.js:58`, `bot-medic.js:88,92`), but the completing frame consumes
it while slot 1 still carries the state — bot-241 committed a legal `H…0…` doing exactly that.

### Weapon

These four are where the model was most wrong before anyone read the source. Three of them —
`aim-needs-weapon`, `cover-needs-weapon`, `knife-needs-dry` — were corrected only by checking the
viewer's own predicates; see the caveats below.

| Rule | Claim | Derives from |
|---|---|---|
| `fire-needs-weapon` | `fire` ⇒ any weapon at all (ammo ≠ `-`) | `readyToFire` requires a loaded mag *at decision time*, but the commit samples after the post-shot tail (A9): the emptying shot starts a reload or sidearm swap in the same frame, so `F` legally reads `R` or `0`. Was `fire-needs-loaded-mag` until bot-152 committed a legal `F…R…` on 2026-08-01 |
| `aim-needs-weapon` | `aim` ⇒ any weapon at all (ammo ≠ `-`) | AIM needs a gun and nothing more: reloading *holds* AIM when no cover corner is free, and an empty mag with reserve left keeps `fireCapable` true, because `attackerOutOfAmmo` needs the mag empty **and** no reserve. Slot 6 `0` encodes the magazine only, never the reserve |
| `cover-needs-weapon` | `cover-move`/`cover-hold` ⇒ ammo ≠ `-` | Both cover rungs are gated on `fireCapable`, so cover on an empty mag with reserve left is real behaviour |
| `knife-needs-dry` | `knife` ⇒ ammo `-` or `0` | `knifeRequested` requires `attackerOutOfAmmo` (hence `primaryEmpty`) **and** `botReloadUntil == null` — a bot mid-reload does not knife, and rounds in the mag rule it out |

### Commit latches

Each latch is only read by the rung that sets it, so a latch outside its scope is a leak, not a
state.

| Rule | Claim | Derives from |
|---|---|---|
| `flee-latch-scope` | The flee latch exists only in `flee` | `fleeCommitted` is read in exactly one rung (`bot-activity.js:74`) |
| `cover-latch-scope` | The cover latch exists only in `cover-move`/`cover-hold` | `coverCommitted` (`bot-activity.js:79`) |
| `healflee-latch-scope` | The heal-flee latch exists only in `flee`/`heal` | `healFleeCommitted` (`bot-activity.js:63`) |
| `coverhold-needs-latch` | `cover-hold` ⇒ the cover latch is set | The HOLD rung is reachable only through the committed branch (`coverCommitted && coverValid` → `atCoverAnchor ? HOLD : MOVE`) |
| `hold-latch-scope` | The held-in-place bit only appears in `patrol`/`seek`/`pursue` | The viewer's `holding` local is `holdUntil > now && (state is PATROL \|\| SEEK \|\| PURSUE)` — a lease is inert in every other rung, which already stands still or is already committed elsewhere. **This is nearly the complement of what the rule said before**; see the caveats |

`sight-latch-scope` (no grace window while patrolling or dead) existed here until 2026-08-01. Its
justification — the ladder reads the *debounced* bit, so a graced bot never takes the PATROL rung —
is true of the ladder but not of slot 1: the muzzle-recovery `reposition` stamp (which bypasses the
ladder entirely) and the `alert` hold both encode as `P`, and either can commit with the grace open
(bot-221 did). Sight-grace on `D` is still banned by `dead-collapses`.

### Death

| Rule | Claim | Derives from |
|---|---|---|
| `dead-collapses` | `dead` ⇒ tier `0`, score `0`, element `-`, ammo `-`, health `0`, no latches | Everything but role and packs is a frozen leftover on a corpse, not state. Role and packs survive because a corpse is still a revive target with a droppable inventory — which is why 13 legal `D……` codes exist (3 rifleman pack values + 10 medic ones) collapsing to 2 core rows |

## Projections

The full code is too fine to count directly — 395,533 legal codes is not a histogram anyone reads.
Pick the coarsest projection that still shows the pathology you are hunting. All cardinalities are
over the **legal** space and are regenerated with the table.

| Projection | Slots | Distinct values | Use it for |
|---|---|---|---|
| state class | — | 7 | "what is the team doing" at a glance |
| state | 1 | 13 | Rung occupancy and rung-to-rung transition matrices |
| state + role | 1,4 | 24 | Whether medics and riflemen use the ladder differently |
| state + tier | 1,2 | 61 | Whether the alert tiering actually changes behaviour |
| state + latches | 1,9 | 39 | Latch leaks and commit-hold duration |
| alert triple | 2,3,5 | 24 | The alert subsystem alone, ignoring what the bot does about it |
| core minus latches | 1,2,4,5 | 134 | The core when commit churn is noise |
| **core** | **1,2,4,5,9** | **458** | **The default: what the bot is doing and why** |
| core + ammo | 1,2,4,5,6,9 | 2,738 | Weapon-gated rungs (reload-cover, knife, dry-fire) |
| core + all resources | 1,2,4,5,6,7,8,9 | 88,513 | Resource-driven transitions; drops only the escalation score |
| full code | all 9 | 395,533 | Exact-equality diffing between two runs |

**The core (slots 1, 2, 4, 5, 9) is the intended default.** It keeps what the bot is doing, how
alarmed it is, which role it plays, its part in a squad push, and which commits are held; it drops
the four resource levels that merely modulate those. `coreCode(code)` projects, `describeBotState`
reads a core code as one line of English, and `enumerateCoreStates()` returns all 458 rows.

Full-code fan-out per core row runs from 3 (`D0r-0`, a dead rifleman) to 2,800 (`P3m-0`, a medic
patrolling under a defensive alert); the generated table carries the count per row, so you can tell
a rare core state from a rare *code*.

## The generated table

| File | Contents |
|---|---|
| `gen-bot-state-table.mjs` | The generator. Imports `bot-state-code.js`, calls `enumerateCoreStates()`, writes both outputs, prints a summary |
| [`bot-state-table.md`](bot-state-table.md) | Counts, the projection table, per-state fan-out, and all 458 core rows |
| [`bot-state-table.csv`](bot-state-table.csv) | The same 458 rows, machine-readable (`n,core,state,class,tier,role,element,latches,full_codes,reading`) |

Regenerate after any change to the alphabets or the rules — one corrected rule moved every figure on
this page:

```
node gen-bot-state-table.mjs
```

```
bot-state-table: 458 core states from 395,533 legal codes (0.906% of 43,680,000), 18 rules
```

**Never hand-edit the table files.** They are a printout of the module; an edit is a lie that
survives until the next run. If a row looks wrong, the rule set is wrong.

## Caveats

**The code is a lossy projection, deliberately.** It carries no position, yaw, path, target
identity, timers, cooldowns, squad membership, or weapon id. Two bots on opposite sides of the map
shooting different people emit the same code, and a bot that turns 180° to a new threat emits no
change at all. That is the point — the code answers "what kind of state is this" and nothing about
where or at whom. Any question that needs a position needs a separate channel in the trace record;
do not widen the code to answer it.

**Legal is not the same as reachable.** The 18 rules remove combinations the FSM *cannot* produce;
they do not assert that everything remaining *does* occur. Several legal codes are almost certainly
unreachable in practice — the push tier additionally requires `livingTeammatesNear >= SUPPORT_GROUP_MIN`,
which no slot records, so plenty of legal push codes need a squad that may never form. A
legal-but-never-observed code is therefore a finding, not noise: it is either dead logic (a rung
that cannot be entered any more) or an untested path (a rung nothing in the test map ever provokes).
Reading the table is how you notice which; only a real trace can tell you which of the 458 the game
actually visits.

**The rule set is a hypothesis about the FSM, not a specification of it.** Four of the original
rules have turned out to be wrong. Three were caught by reading `bot-viewer-v2.html` — all three
about the weapon, all three because the plausible guess ("you need bullets to do that") is not what
the code checks:

- `aim-needs-weapon` — AIM turned out to need only that a gun exists. Reloading *holds* AIM when no
  cover corner is free, and an empty mag with reserve left keeps `fireCapable` true, because
  `attackerOutOfAmmo` requires an empty mag **and** no reserve.
- `cover-needs-weapon` — both cover rungs gate on `fireCapable`, not on the magazine, so an
  empty-mag-with-reserve bot takes cover normally.
- `knife-needs-dry` — `knifeRequested` requires `attackerOutOfAmmo` **and** `botReloadUntil == null`,
  so a knifing bot is dry *and* not mid-reload; neither half was obvious from the outside.

**The fourth is the interesting one, because no one caught it by reading.** `hold-latch-scope`
originally permitted the hold bit in `heal`/`aim`/`fire`/`cover-hold` or under a base-of-fire
element — very nearly the *complement* of the truth, which is the viewer's `holding` conjunction
(`holdUntil > now && state is PATROL/SEEK/PURSUE`). It survived review and was only exposed during
the viewer wiring, when the freshly-written adapter emitted a real code that failed `illegalReason`.
That is the entire argument for the illegal-code warning documented below: a rule set nobody can
falsify by inspection gets falsified by the running game, and the warning is the channel it comes
back through. Correcting it moved every figure on this page — 436,903 legal codes became 354,013,
and 536 core states became 434.

The same reviews caught the model's one structural error: medic duty had been given its own slot,
when the viewer plainly overwrites `state` with `duty.state`. Treat every rule as something to
disprove with a trace, and re-derive from the source before trusting one.

**Two known coverage gaps in the alphabets.** `bot-roles.js` defines a third role, `squadleader`,
which has no slot-4 character (it would encode as a rifleman, and its 2-pack cap happens to make
`rifleman-pack-cap` still correct). And the viewer stores `pushElement` as the raw strings
`'base'`/`'move'`, which are *not* what `encodeBotState` accepts — it wants `'base-of-fire'`/
`'moving'` or the chars `b`/`m`, and silently falls back to `-` on anything else, which then trips
`element-requires-push` under a push tier. The shipped adapter maps them explicitly
(`BOT_ELEMENT_SLOT`); any future adapter has to do the same, and nothing will warn if it forgets
until a push tier makes the code illegal.

## Viewer wiring

Landed in `bot-viewer-v2.html` on 2026-07-26; pre-edit snapshot at
`versions/bot-viewer-v2-before-state-codes-20260726-230100.html`. The whole hookup lives in the
recorder block just after `setBotStateRecording`, plus two touch points elsewhere: the commit-bit
stamp inside `updateBotSentry` and the emit call at the tail of `commitBotActor`.

### The adapter

`botStateDescriptor(actor, now)` discretizes a live actor into a **reused** module-level `_stateDesc`,
with `_stateAmmoQ` / `_stateLatchQ` as scratch arguments for the quantizers. Nothing allocates: the
recorder runs inside the per-bot commit path, so a fresh object per bot per frame would be the
single most expensive thing about it.

| Slot | Source |
|---|---|
| 1 state | `BOT_STATE_SLOT[…]`, a table built by inverting the module's own `STATE_NAMES`, so every viewer state string maps by name and a state renamed in the module cannot silently stop mapping. `'alert'` is pinned to `P`. `actor.entity.alive === false` short-circuits the whole slot to `D` |
| 2 tier | `tierSlot(actor.alertTierLast, actor.alertMarkMode === 'near')` |
| 3 score | `actor.alertScore`, clamped to 0–9 — the score the alert system already published, never a locally recomputed `esc.score` |
| 4 role | `actor.role === ROLE_MEDIC ? 'm' : 'r'` |
| 5 element | `BOT_ELEMENT_SLOT` — an explicit `{ base: 'b', move: 'm' }` map, because the viewer's raw strings are not what `encodeBotState` accepts (see the caveat above) |
| 6 ammo | `ammoSlot(...)` off `entity.ammoByWeapon.get(entity.weapon)` |
| 7 health | `healthBand(entity.health, DUMMY_MAX_HEALTH)` |
| 8 packs | `packSlot(actor.healthPacks.length, actor.reviveKits > 0)` |
| 9 latches | `latchBits(_stateLatchQ)` — see below |

### The latch stash

`fleeCommitted` / `coverCommitted` / `healFleeCommitted` are **per-frame ctx locals inside
`updateBotSentry`, not actor fields** — by the time the recorder runs they are gone. So
`updateBotSentry` now packs all three into one `actor.commitBits` integer immediately after
`c.coverCommitted = coverCommitted`, declared in `createBotActor` and cleared in
`resetActorMapState` (commits die with the old map). The recorder reads bits, never re-derives.

The held-in-place bit is computed as `actor.holdUntil > now && 'PSU'.includes(d.state)` — deliberately
off the **already-computed slot-1 char**, not off the raw state string, so the adapter and
`hold-latch-scope` cannot disagree about what counts as a locomotion rung. Sight-grace is
`visDebounce.lastTrueAt != null && !targetVisible`: the debounce is holding a contact open that raw
visibility has already lost.

### The bound-actor rule

This is the subtle one. For `actor === activeBotActor`, the descriptor reads the **globals**
`botState` / `botReloadUntil` / `botTargetVisible` instead of the corresponding actor fields.
`recordBotStateChange` fires mid-frame, *before* `commitBotActor` writes those globals back onto the
actor — reading the actor there would encode last frame's state for the one bot currently being
simulated, and only for that bot. Any new slot added to the adapter has to make the same choice.

### Change detection

The authoritative emit point is the **last line of `commitBotActor`**, once every per-frame global
has landed on the actor, gated on `botStateRecording` so the cost with the recorder off is one
boolean test per bot per frame. On-path, `botStateDescriptor` also packs the nine slot indices into
a single radix-positional integer `_stateDescKey`; `advanceBotStateCode` compares that against
`actor.stateCodeKey` and returns before building any string when nothing moved. `encodeBotState`
runs only on a genuine change, so an idle bot costs one integer compare.

### Illegal-code warning

Every emitted code goes through `illegalReason`. A failure logs a **deduped** `console.warn` (one
per rule id per session):

```
bot-state-code: bot-7 emitted illegal F44rb3404 (hold-latch-scope) -- adapter or rule is wrong
```

It means exactly what it says, and both halves have happened: the adapter can be reading the wrong
field, or the rule can be wrong about the FSM. This is how `hold-latch-scope` was caught (see the
caveats). Do not silence it by loosening a rule — establish which of the two is wrong first.

### `check-bot-target-attribution.mjs` — automated attribution checker (added 2026-08-02)

Node CLI (repo root, plain script like `gen-bot-state-table.mjs`, not a `test-*.mjs`): flags bots
that fight (or flee/knife) without ever being recorded as another bot's `target_id`, the pattern
first found by hand in `docs/bot-bugs-log.md` BB-001. Run it against one or more traces:

```
node check-bot-target-attribution.mjs bot-states/bot-state-trace-<stamp>.tsv [more.tsv ...]
```

It loads the sibling `bot-events-<stamp>.tsv` when present and runs three checks — ghost
combatants (an attacker never targeted by anyone), unattributed hits (a victim never targeted
its own killer within 2s), and sustained silent/one-sided proximity (opposing bots within 15m for
3+ consecutive seconds without both directions ever recording the other, dead-bot heartbeat rows
excluded so a corpse can't manufacture a fake encounter). Exits 1 if anything is flagged. Full
description of each check, a baseline-rate caveat on the unattributed-hits count, and every
finding it's produced so far live in `docs/bot-bugs-log.md`'s Tooling section and BB-001–BB-003.

### `bot-trace-viewer.html` — trace playback (added 2026-07-28)

Standalone page (`http://127.0.0.1:8080/bot-trace-viewer.html`) that animates a saved take as a
top-down map. 2D canvas rather than Three.js on purpose: the trace carries `x`/`z`/`yaw` and no
height, so a plan view is the honest projection and keeps labels legible. It **imports
`bot-state-code.js` directly**, so state names, classes and legality come from the same decoder the
sim uses and cannot drift.

- **Loading** — dropdown fed by `serve.py`'s `GET /api/list-bot-states`, a file picker, drag-and-drop,
  or `?file=<name>`. Parses by *header name*, so the 5-, 13- and 16-column generations all load; a
  file without `x`/`z` is detected and reported instead of animating nothing.
- **Encoding** — fill = team (`BOT_TEAM_DEFS` colours), ring = `STATE_CLASSES`, radius = health band,
  spike = `yaw` (drawn as `(sin, cos)` to match the sim's forward vector), trail = recent positions,
  chevron = `squad_rank 0`, line to leader = `leader_id`, centre dot = non-empty waypoint queue.
- **The two diagnostic highlights**: a pulsing red halo marks a bot stationary while in a locomotion
  state (`P/S/U/E/C/M` under 0.05 m/s), and its squad link turns red — i.e. a follower pinned on its
  formation slot lights up together with the leader it is bound to.
- **Shots and deaths** — a `F` sample draws a glowing line from shooter to the live position of its
  `target_id`, with an impact pip; takes older than `target_id` fall back to a **dashed** ray along
  yaw, deliberately distinguishable because it shows a direction and not a victim. Death fires an
  expanding shockwave plus debris spokes at the moment `D` first appears, the corpse ✕ burns bright
  and then fades, and a permanent faint dot marks where each bot fell. A bot already dead at the
  first sample gets no burst — that is a recording start, not a death.
- Target and leader lookups deliberately ignore the team/stall filters, so filtering to one team does
  not silently delete every shot line to the other.
- **The legend is live, not static** — it is rebuilt from the bots actually on screen at the playhead,
  one row per (team x state) combination present, plus only those markers currently visible. Each row
  draws its swatch through `paintGlyph`, the same function the map uses, so a swatch and a real bot
  cannot disagree; the wording comes from `describeBotState` on a neutral core code (`'<ch>0r-0'`),
  so it cannot describe a state differently from the sim either. Rebuild is gated on a signature of
  the visible combinations, so it only touches the DOM when the mix changes.
- **Transport** — play/pause (space), scrub, 0.25-16x, arrow keys step to the next sample boundary of
  the selected bot. The ribbon under the scrubber buckets the whole take into firing (orange, up) and
  stalled (red, down) counts, so the wedged stretches are visible before you scrub to them.
- Position is interpolated between samples; gaps over 3 s hold instead, so a trimmed or absent stretch
  never renders as a smooth glide across the map.
- **Statistics panel** (added 2026-08-02) — `Statistics` button opens a full-screen table, one row per
  bot, sortable by clicking any column header (click again to reverse — this is the whole "best of /
  worst of" mechanism, no separate top-N control). Columns: `team`, `squad` (most recent `squad_id`),
  `birth`/`life`/`death` (seconds, "alive" if it never dies), `kills`, `targets` (unique enemies it put
  in its own `target_id`), `hits`, `sights` (how many times ANY other bot's row had *this* bot as
  `target_id` with `vis_gate=y` — the same signal `check-bot-target-attribution.mjs` and the BB-001/
  002/003 entries in `docs/bot-bugs-log.md` read by hand; a bot with real combat but near-zero `sights`
  is the perception-gap pattern), `engagements` (transitions into the `F` firing state), `distance`
  (summed `moved`), `states` (row count — includes heartbeat `tick` samples, not just transitions),
  `state changes` (added 2026-08-02: rows where `changed` is truthy and not `'tick'`, i.e. real
  transitions plus each bot's `'initial'` row — the same predicate `ingestRow` already used to decide
  what goes in the prose log, reused here so "states" and "state changes" answer two different
  questions: total samples vs. actual transitions), `unique states` (distinct `state_char` values ever
  shown), `exclusive states` (added 2026-08-02: how many of those unique states no *other* bot in
  the whole take ever showed — computed in a second pass over `computeBotStats()`'s output, since it
  needs every bot's unique-state set built first) and `illegal states` (added 2026-08-02: how many of
  a bot's rows have `r.d.legal === false`, or `r.d === null` for a code that failed to decode at all —
  `r.d` is `decodeBotState(code)`, already computed at ingest for the detail panel's `legal`/
  `illegalReason` line, just never rolled up before now). A nonzero count here is a `bot-state-code.js`
  encoding bug, not a behavioral one — a legal code can still represent bad behavior, but an illegal
  code means the state machine wrote something `illegalReason`'s 18 rules say should be structurally
  impossible. Row click selects that bot in the main view and closes the panel. `Copy TSV` copies the
  sorted table as tab-separated text.
  `kills`/`hits` need combat-event data from one of two sources: a file load's sibling
  `bot-events-<stamp>.tsv`, loaded the same way `worldMeta` is (`loadEventsMeta`, same stamp-derived
  filename the checker script uses), or a live game's own event stream (added 2026-08-02 — see
  "Live combat-event streaming" below). When neither is available (older takes, a dropped file with
  no matching sibling, or a live session whose sender isn't broadcasting events) those two columns
  read `—` rather than a misleading `0`; the rest of the columns still populate and refresh on the
  same throttle as the ribbon regardless.
  `computeBotStats()` is the data layer — plain numbers/strings, no DOM — meant to be shared by future
  histogram/box-plot/line-graph/ordination views over the same per-bot metrics, not just this table.
- **Combat/behavior columns** (added 2026-08-02) — extends the table above with columns derived purely
  from the trace, no events sibling needed:
  - `role` — the same value the group-by dropdown resolves via `botRoleInfo` (prefers `role_id`, falls
    back to the state code's role slot), now also shown as a plain sortable column on the ungrouped
    table, not just used internally for grouping.
  - `deaths caused` — a heuristic kill-attribution column that works even with no combat-event data at
    all (so it's the one combat column that always populates, even when `eventsLoaded` is false): for
    every bot's death, every OTHER bot whose last row within `DEATH_CREDIT_WINDOW_MS` (3000ms) of the
    death had `target_id` pointing at the victim with `vis_gate='y'` gets credited. Approximate and can
    multi-attribute (two bots both had it targeted right before it died) — a proxy for `kills`, not a
    replacement once real combat-event data is available.
  - `heals given` — transitions into the `T` (medic-tend) state, same transition-counting technique
    `engagements` uses for firing bursts. Counts the bot's own tending, not who it healed.
  - `revives` — transitions out of the bot's own `D` (dead) state back to any other state, i.e. how many
    times *this* bot came back from dead.
  - `avg target dist m` — mean `target_dist` across the bot's own rows where `target_id` was set.
    Cheap way to separate hold-at-range roles (sniper) from close-range ones (technical/knife-heavy)
    behaviorally, independent of the `role` tag.
  - `flee episodes` / `flee time s` — transitions into the `flee` commit latch (`r.d.latches`), and
    summed dwell seconds while it's latched. Dwell is gap-to-next-row weighted and capped at
    `GAP_HOLD_MS` (3000ms) — same convention `takeMetrics()`'s comparison-panel dwell stats already
    use, so a long silence between samples (a trimmed stretch, a live-mode hiccup) can't get
    misattributed as continuous flee dwell.
  - `stall time s` — summed dwell seconds where `isStalled(r)` is true: reuses the file's existing
    `LOCO`/`STILL_SPEED` predicate (already driving the ribbon's red "stalled" buckets and the
    comparison panel's `stalled %`) rather than a new one — states that are legitimately stationary by
    design (cover-hold, medic-tend, aim, fire, knife, self-heal) read as normal there, not stuck. Same
    `GAP_HOLD_MS`-capped dwell weighting as `flee time s` above. Reads as "stuck while trying to go
    somewhere," the same pattern the BB-001/002/003 manual trace reads were chasing by hand.
  All group-summed in `STATS_GROUP_COLUMNS` except `avg target dist m`, which is a mean of the
  per-bot means over members that ever held a target (summing an average distance across bots isn't
  meaningful), and `role`, which is dropped from the grouped table since it's the grouping key itself
  when `groupBy` is `role`.
- **Per-state view** (added 2026-08-02) — a `Per bot` / `Per state` tab inside the same Statistics
  panel. Per-state is a matrix, one row per state (fixed order from `STATE_NAMES`, `D` excluded — see
  below), one column per bot (header text tinted by team), toggled between `entries` (transitions
  *into* that state — a run of unchanged heartbeat rows in the same state is not a re-entry, same
  technique the per-bot table already used for firing bursts) and `duration (s)` (summed dwell time,
  gap-to-next-row weighted, same convention the heatmap uses because rows are not evenly spaced in
  time). `D` (dead) is left out of the matrix entirely rather than capped: a corpse keeps emitting
  heartbeat rows for the rest of the take, so its "duration" would be however long was left in the
  trace after death — dominating every other state for an early death and not a meaningful occupancy
  number anyway; the per-bot table's `death s` column already answers "when". `computeStateMatrix(metric,
  subModes)` is the data function; `Copy TSV` and the row-count note both branch on which tab is active.
- **Sub-modes toggle** (added 2026-08-02) — a checkbox next to the entries/duration select, visible
  only in the per-state view. Splits each state row by its `path_mode` value (`cover`/`seek`/`flee`/
  `knife`/`patrolLocal`/`patrolStranded`/...), e.g. turning the single `patrol (P)` row into
  `patrol (P) · patrolLocal`, `patrol (P) · patrolStranded`, etc. `path_mode` is not a fixed enum the
  way `STATE_NAMES` is, so the sub-rows are discovered from whatever the loaded take actually contains
  (`modesByState` in `computeStateMatrix`) rather than hardcoded; a state that never carries a
  `path_mode` (state chars like `F`/`A` are often blank while stationary) keeps its plain single row
  instead of gaining a spurious empty split. Rows with a real path_mode value and rows where it was
  blank at that instant are tracked separately (a `· —` row) rather than merged, so blank isn't
  silently folded into either bucket.
- **Abundance/diversity columns + ranking** (added 2026-08-02) — two columns to the left of the bot
  columns in the per-state view: `abundance` (that row's total — summed entries or summed dwell
  seconds, matching whichever `stateMetric` is active) and `diversity` (how many distinct bots ever
  posted a nonzero value for that row). Clicking the `state`/`abundance`/`diversity` header re-orders
  the table: `state` restores the fixed `STATE_NAMES` narrative order (the default); `abundance`/
  `diversity` rank rows by that metric, clicking again flips ascending/descending. A `keep sections`
  checkbox (default on, next to sub-modes) controls what "ranked" means when a state's rows are split
  by path_mode: on, the ranking aggregates each state's sub-rows into one section score (summed
  abundance, or the union of bots touching any of its sub-rows for diversity) and reorders whole
  sections, so a state's sub-mode rows always stay adjacent; off, every row — including individual
  sub-mode rows — is ranked and interleaved flat, regardless of which state it belongs to. Implemented
  as `orderStateRows` inside `computeStateMatrix`, which now takes `(metric, subModes, sortMode,
  sortDir, sections)`; both the table render and the `Copy TSV` export share it, so the CSV always
  matches what's on screen and also gains the two new columns.
- **Group-by dropdown (role/team)** (added 2026-08-02) — a `groupBy` select (`bots` default / `role` /
  `team`) in the shared header, applying to **both** stats tables, not just per-state: in the per-bot
  table it collapses individual bot rows into one row per group; in the per-state table it collapses
  individual bot columns into one column per group. Role prefers the `role_id` trace column (added
  the same day, see "Trace column 26" below — the real `bot-roles.js` id, so `rifleman`/`medic`/
  `squadleader`/`sniper`/`technical` all split out); a take recorded before that column existed falls
  back to the state code's `role` slot, which only ever reads `rifleman`/`medic` (see the slot-model
  comment atop `bot-state-code.js`), so an old take's role grouping can't surface the specialists.
  Leader status is `squadRank === 0`, the same test the map layer's target-link builder uses. Both can
  drift mid-take (a rifleman promoted to lead its squad on succession), so `botRoleInfo` scans a bot's
  rows backward for the last known value, same technique `computeBotStats` already used for squad (and
  now calls `botRoleInfo` for role/leader too, instead of its own duplicate scan) — cached per id
  (`_roleInfoCache`), cleared on every new trace load since bot ids are reused across takes. A second
  `leaderMode` select (visible only when `groupBy` is `role`) picks how a bot *currently* leading its
  squad (but whose base role isn't the dedicated `squadleader`) folds into role groups: `own` (grouped
  with the dedicated squadleaders regardless of base role), `perRole` (`"<role> (leader)"`, separate
  per base role), or `none` (folded into its base role, no distinction) — a dedicated `squadleader`-role
  bot is always its own group either way, `leaderMode` never wraps it further. `roleGroupKey(role,
  isLeader, mode)` is the one function both tables' grouping shares.
  - Per-bot grouped rows use a separate `STATS_GROUP_COLUMNS` layout (`computeGroupedBotStats`):
    kills/targets/hits/sights/engagements/distance/rows/stateChanges/illegalStates sum (they're
    already per-bot totals, so a group total is the natural extension); birth/life become group means (a single bot's
    timestamp doesn't sum meaningfully); death becomes a `deaths` count paired with `n` (group size)
    instead of the ungrouped table's single alive/dead-timestamp column; `uniqueStates` becomes a true
    union across the group's bots, not a sum (avoids double-counting a state two bots both visited);
    `squad` is dropped (finer partition than role/team, rarely uniform within either). `exclusiveStates`
    (added 2026-08-02) is neither summed nor unioned — it's recomputed against the *whole roster*: a
    state in the group's union counts only if every bot that ever showed it (checked via an `owners`
    map built from all of `computeBotStats()`'s output, not just this group's members) belongs to this
    group. That answers "did any bot outside this group ever show this state", the group-level version
    of what the per-bot `exclusiveStates` column asks about individual bots.
  - Per-state grouped columns (`columnGroupsFor`, shared by the table render and `Copy TSV`) sum each
    cell's value across a group's bots — same operation as the abundance column already does row-wise,
    just column-wise now. Row-level `abundance`/`diversity` are unaffected by column grouping — they
    stay computed at the individual-bot level regardless of how the columns are displayed.
- **Symptoms tab** (added 2026-08-02) — a third Statistics tab, one row per bot, one column per named
  bug symptom from `docs/bot-bugs-log.md`'s new "Symptoms" reference section (`SYMPTOMS_COLUMNS`,
  `computeSymptomStats()`). Every column is a raw count/ratio/boolean, deliberately never combined
  into one weighted score — there's no empirical basis yet for relative weights, only conjecture, so
  the tab exists to produce the data for that analysis (via `Copy TSV`) rather than assume an answer.
  Five symptoms are single-bot aggregates and implemented (`high-tier no-target ratio`/`push no-target
  ratio` for the two "escalates but never targets" shapes, `max target switches / 3s` for flicker,
  `killer ever targeted`/`max self-threat before death` for blind deaths); two (Silent Contact, Feared
  and Dropped) are inherently pairwise/temporal and aren't — see the bug log for why. No threshold
  gates a column's visibility; a bot with weak evidence still gets a small nonzero value and sorts
  near the bottom, rather than reading identically to a bot with none. Every ratio's sample-size
  column sits next to it (`high-tier rows` beside `high-tier no-target ratio`, etc.) so a thin sample
  stays visible instead of looking as confident as a solid one. Never grouped by role/team — a ratio
  or a max-in-window metric isn't a sum/mean/union like the other stats columns — so `groupBy`/
  `leaderMode` hide while this tab is active. Row click and stamping both work exactly as they do on
  the other two tabs (both are DOM-generic, keyed on `data-row`/`data-key`, no special-casing needed).
  The blind-death window (`BLIND_DEATH_LOOKBACK_MS` before `deathT`) is bounded on both ends —
  `r.t >= since && r.t <= deathT` — so a dead bot's post-death heartbeat rows (frozen `target_id`,
  stale `self_threat`) can't leak into "before death" evidence.
- **Symptoms tab grouping + tooltips** (added 2026-08-02) — the flat 13-column layout above didn't tie
  any column back to which symptom or BB-### bug it was evidence for, so `SYMPTOMS_COLUMNS` entries now
  carry `group`/`bug`/`desc` fields (identity columns `id`/`team`/`role`/`squad` carry none — they're
  row labels, not evidence). `renderStats()` branches on `statsView === 'symptoms'` to build a second
  `<thead>` row (`buildSymptomsHead()`) above the normal one: a blank spacer `<th>` over each identity
  column, and one `colspan`-ed `<th class="grp-head">` per contiguous run of same-`group` columns,
  labelled `"<group name> <BB-###>"`. Every other view still renders a single header row, unchanged.
  Every column's real header `<th>` (the one carrying `data-key` and the sort arrow) also gained a
  `title` attribute from `desc` — hovering any column now shows its detection text inline, the same
  data the docs table below draws from, instead of requiring this doc open in another tab.
  Four stamping helpers (`rowStampText`, `toggleOrStampCell`, `reapplyStampSelection`,
  `commitCollected`) previously hardcoded `tHead.rows[0]` as "the header row" — true for every
  single-row-header view, but the symptoms tab's real (data-key-bearing) header row is now `rows[1]`,
  not `rows[0]`. All four now go through one `statsHeaderRow(table)` helper
  (`table.tHead.rows[table.tHead.rows.length - 1]`) instead, which resolves to the same row as before
  everywhere except the symptoms tab. The group row's spacer cells keep the same column count/order as
  the label row beneath them specifically so `cellIndex`-based lookups (`toggleOrStampCell`) stay
  aligned regardless of which row a click landed on.
- **Live combat-event streaming** (added 2026-08-02) — `kills`/`hits`/`killer ever targeted`/`max
  self-threat before death` used to read `—` for every live session, because `ingestLive()` only
  handled `vis`/`world`/`selected`/`snapshot`/`rows` message types and silently dropped anything else.
  bot-viewer-v2.html was already broadcasting a `type: 'events'` message every frame
  (`botLiveFlush()`'s `_botLiveEventQueue`, gated on the same `botLiveEnabled` flag as `rows`) and
  including an `events` backlog on its `snapshot` reply (`botLiveSendSnapshot()`, `botEvents.slice(-
  BOT_LIVE_BACKLOG)`) — the sender side needed no changes at all, only the receiver did. `ingestLive()`
  now has an `events` branch that appends `msg.events` to `eventsRows`, sets `eventsLoaded = true`, and
  re-renders Stats on the same throttle as `rows`; the `snapshot` branch does the same for its `events`
  backlog, after `liveReset()` (which still clears `eventsRows`/`eventsLoaded` as the connect-time
  default, in case the sender genuinely isn't broadcasting events — an older bot-viewer-v2 build, or a
  recording-only session with live-streaming off). `eventsRows` has no ring cap in live mode, same
  reasoning as the row trace's own uncapped history: kill/damage events are rare (a few per second at
  most per bot-viewer-v2's own comment), so the cost is negligible next to the value of keeping the
  full combat history a long session might need.
- **Selected-bot row highlight** (added 2026-08-02) — the bot selected via map click, the sidebar
  list, or bot-viewer-v2's ctrl-click sync now gets a highlighted row (`.sel`) in the Stats panel's
  per-bot/Symptoms tables, so scrolling a wide table or comparing rows doesn't lose track of which one
  is selected elsewhere. `reapplySelectedBotHighlight()` toggles the class on the matching
  `tr[data-id]` without a full table rebuild — same DOM-patch pattern `reapplyStampSelection()` already
  uses — called both at the end of `renderStats()` and from every one of the four places `selected`
  changes (map click, sidebar list click, the stats table's own row click, and `ingestLive`'s
  `selected` message). Grouped rows have no `data-id` (a group isn't one bot), so the highlight is
  naturally a no-op there — nothing to select.
- **Frozen first column** (added 2026-08-02) — `#statsTable th:first-child`/`td:first-child` are
  `position: sticky; left: 0` across every Stats tab (per-bot, Per state, Symptoms, grouped), so the
  row's identity (bot id, or state name in Per state) stays visible while scrolling a wide table
  right. Each needs its own explicit opaque background (header `#1a212c`, body `var(--panel)`) since a
  sticky cell doesn't inherit one from its row — without it, columns scrolling underneath would show
  through. `z-index` differentiates header (2) from body (1) so the frozen header cell still paints
  above frozen body cells during the transient overlap while scrolling, and an explicit
  `tr:hover td:first-child` / `tr.sel:hover td` pair restates the hover/selected background on the
  frozen cell specifically, since its own background otherwise masks the row-level one.
- **Death status is current, not historical** (fixed 2026-08-02) — the `death`/`alive` column, the map's
  corpse marker, the blind-death window, and deaths-caused attribution all read `b.deathT`, which used
  to mean "the first time this bot's rows ever showed state `'D'`," set once and never revisited. Two
  bugs fell out of that: (1) in live mode, a viewer that connects mid-session only gets the last
  `BOT_LIVE_BACKLOG` rows, so a bot that died before that window starts has its first-ever *visible*
  row already `'D'` — the old rule (`rows.length > 1`, mirroring `load()`'s "already-dead-at-t0 isn't a
  death event") treated that as a pre-existing corpse and never set `deathT`, so a genuinely dead bot
  read "alive" forever; (2) bots can be revived (see `revives` above) — `'D'` is not actually terminal —
  but nothing ever cleared `deathT` on revival, so a revived-and-still-fighting bot kept reading "dead
  since \[its first death\]" for the rest of the take. Both are now one question, "is this bot's *most
  recent known row* `'D'`, and if so when did that run start" — the same thing selecting the bot and
  reading its live state would show. `scanDeathState(rows)` (new, shared) answers it by walking
  backward from the end of a sorted row array to the start of the trailing `'D'` run; `load()`'s
  per-bot finalization calls it once over the full trace. `ingestRow()` keeps the same invariant
  incrementally instead of rescanning per row: entering `'D'` (from any other state, or from no history
  at all, since live visibility can start mid-death) sets `deathT`; leaving `'D'` clears it. This also
  fixes two related, previously-unnoticed side effects: `deathsCaused` no longer credits a kill for a
  death the victim recovered from, and the blind-death window now evaluates the bot's *most recent*
  death rather than always its first. `takeMetrics()`'s separate `deaths` counter (compare-baseline
  panel) is unchanged on purpose — it's a historical count of death events, a different question from
  current status, so it still only latches the first one.
- **Log tab** (added 2026-08-04) — a fourth Statistics tab (`statsView === 'log'`), the full
  chronological state-change log for the loaded take or everything seen so far live, filterable by
  team/squad/role and "only selected bot." Reuses the existing event definition (`changed` slot present
  and not `'tick'`) that the floating `#logPanel`/`#logBox` textarea (header `Log` button, live-only)
  already used, factored into `isLogEvent(r)`/`logRowBits(r)` so both panels agree on what counts as an
  event and how the target/squad/self-threat detail bits are worded. Unlike that panel, the tab also
  works for a loaded file: `buildLogEntries()` runs once in `load()` over `[...allRows].sort by t`
  (`allRows` itself is only ever sorted per-bot, not globally, so the log needs its own interleaved
  sort) and stores structured entries (`{t, team, id, role, squadId, gloss, extra}`, not pre-joined
  text) so filtering doesn't need to re-derive fields from raw rows. `ingestRow()` appends incrementally
  for live and caps `logEntries` at `LOG_MAX_LINES` the same way the floating panel caps `logLines` —
  but a loaded file gets no cap, since "full contents of a saved log" means everything, not last-4000.
  Filter dropdowns (`logTeamSel`/`logSquadSel`/`logRoleSel`) are populated from whatever values are
  actually in `logEntries` (same "rebuilt on load, keep selection if still valid" idiom as the sidebar's
  `teamSel`/`fillTeamFilter`, factored into a shared `fillFilterSelect`), refreshed at the same points
  `fillTeamFilter()` already is (`load()`, and live's roster-size-changed check in `ingestLive`). "Only
  selected bot" reuses the app's existing single `selected` variable rather than adding its own bot
  picker — selecting a bot via the map, the sidebar list, a stats-table row, or bot-viewer-v2's
  ctrl-click (live) all already funnel into the same variable, so the three click/message handlers that
  set it now also call `renderStats()` (a no-op when the panel is closed) so the Log tab updates live
  if it's the open tab. Log rows carry no `data-row`/`data-key`/`data-id` — chronological order is the
  point, not a sortable metric grid, and a log line isn't a "stat" to stamp into Notes — so `groupBy`,
  `leaderMode`, `stampBtn`, and `stampCount` all hide on this tab the same way they already hide/adapt
  per-tab for Symptoms, and stamp mode is forced off if it was left on when switching in. `Copy TSV`
  still works (time/team/bot/role/squad/state/details columns, respecting the active filters).
- **Stats result caching** (added 2026-08-02) — `computeBotStats()`/`computeSymptomStats()` each do a
  full pass over every row of every bot, expensive enough that redoing it on a plain sort-direction
  click (which only needs to reorder already-computed data) was wasted work. Both are now cache-check
  wrappers (`_botStatsCache`/`_symptomStatsCache`) around a renamed `...Uncached()` body; the cache is
  invalidated only where the underlying trace data actually changes — `load()` (new file), `liveReset()`
  (new live session), `ingestLive()` (new live rows, both `snapshot` and `rows` message types), and
  `loadEventsMeta()` (events sibling resolves after the fact, since `kills`/`hits`/`deathsCaused`/the
  blind-death columns all read `eventsRows`). Sorting, grouping, and tab switches never invalidate it —
  same split `buildHeatLayer`/`heatLayerCanvas` already use for the heatmap (expensive scan cached,
  cheap redisplay not). `computeGroupedBotStats()` doesn't need its own cache: once `computeBotStats()`
  is cached, its own remaining work (grouping an already-small per-bot array) is cheap regardless.
- `stall time s` (Combat/behavior columns above) originally duplicated the file's existing
  `LOCO`/`STILL_SPEED`/`isStalled()` predicate under new names (`MOVING_STATE_CHARS`/`STALL_SPEED_MS`)
  instead of reusing it, and neither `flee time s` nor `stall time s` applied the `GAP_HOLD_MS` dwell
  cap `takeMetrics()`'s comparison-panel stats already use — caught in a scout/critique pass per
  `docs/sonnet-code-protocol.md`, fixed same-day (see the Combat/behavior columns bullet, now current).

### UI

- Recorded lines now carry the code and a `changedSlots` changed-slot list (`… A44rb340G [state+ammo]`);
  the existing prose transitions are unchanged, the code is appended to them.
- `recordsBotDiagnostics(actor)` is the recorder's own scope gate, separate from the debug focus that
  drives the 3D overlays.
- **Record scope: Focused bot / All bots** toggle, default Focused (the previous behaviour). Flipping
  it restarts the take, since a half-scoped trace is not comparable with itself.
- **`H` hotkey** (added 2026-07-28) — `toggleBotStateCapture()`: press once to start a take, again to
  stop it and write the TSV to `bot-states/`. Starting forces **All bots** scope, because the point of
  a hotkey capture is catching something you could not select in the first place. Stop happens before
  the (async) save, which is safe in either order since only *starting* a take clears the trace and
  `saveBotStateTrace` snapshots the text synchronously before its first `await`. Shares the camera
  keydown handler's guards, so it ignores key-repeat and does nothing while a text field has focus.
- **Copy state-code TSV** button — one row per change. Columns are
  `t_ms, bot_id, team, code, changed_slots, x, z, yaw_deg, speed, moved, goal_dist, path_len, path_mode,
  squad_id, squad_rank, leader_id, target_id, target_dist, vis_gate`.
- **`target_id`** (added 2026-07-28) — `actor.target?.id`, the entity this bot is currently engaging.
  Added so a trace can draw the shooter→target pairing; yaw alone gives a direction, not a victim.
- **Sight columns `target_dist` / `vis_gate`** (added 2026-07-28) — mirrored off the sentry through
  `botTargetDistance` / `botTargetVisGate` (bind at `:5363`, commit at `:5401`, set at `:7247`).
  `target_dist` is the **3D eye-to-eye** distance the ladder branches on; the trace's `x`/`z` are 2D
  capsule centres, so differencing two bots' positions does *not* reproduce it, and comparisons
  against `knife.range` (2.0 m) or `fleeDistance` are wrong without this column. `vis_gate` records
  which test resolved sight: `y` visible, `w` rejected by the `mapCollider` raycast, `f` rejected by
  `withinBotFov`, `r` beyond `botSightDistance()`, `-` no live target. State codes only say a bot
  *behaves* as if blind (`S`/`P`); this says which gate made it so, which is otherwise unrecoverable
  from a trace. `w` vs `f` at close range is the specific discriminator: a wall between two bots one
  metre apart is correct behaviour, a blind arc is not.
- **Squad columns** (added 2026-07-28) — `squad_id` / `squad_rank` (`-1` = unranked, `0` = leader) off the
  actor, `leader_id` looked up through `squads.get(actor.squadId).leaderId`; all three blank for an
  unsquadded bot. They exist because `updateSquadFormationMovement` (`bot-viewer-v2.html:7043`) pins a
  follower that has arrived on its slot — zero velocity, cleared path, `return true` — which
  short-circuits `updatePatrolMovement()` at `:7716`. Follower movement is therefore entirely
  parasitic on the leader, with no timeout, so a stalled follower is only diagnosable by reading its
  leader's rows at the same timestamp. Join on `leader_id` to do that.
- **Motion columns + heartbeat** (added 2026-07-28). The code slots are all discrete decisions, so a
  bot wedged in a locomotion state is byte-identical to one executing it — `S` reads the same whether
  the bot is walking to a last-known position or standing still in the seek state. `fillBotStateTraceMotion`
  appends the physical truth to every row, read straight off the actor/entity (`entity.capsule.start`,
  `entity.velocity`, `entity.yaw`, `actor.combatMoveGoal`, `actor.path`, `actor.pathMode`), which is
  valid for bound and unbound actors alike because the one caller runs at the tail of `commitBotActor`,
  after every per-frame global has landed on the actor.
  - `x` / `z` world position, `yaw_deg` facing 0-359, `speed` current |velocity| in m/s.
  - `moved` — metres since **that bot's previous row**, blank on its first. Rows are irregularly
    spaced (change rows + ticks), so `moved` is a segment length, not a rate; divide by the `t_ms`
    delta for an average, or read `speed` for the instantaneous value.
  - `goal_dist` distance to `actor.combatMoveGoal` (blank when there is no goal), `path_len` remaining
    waypoints, `path_mode` the router's mode string. Together these separate "no goal" from "goal but
    no path" from "path but not moving".
  - **Heartbeat**: `botStateTraceTickMs` (default 1000 ms, cycled by the **Motion heartbeat** button
    through 0/250/500/1000/2000) emits a row per bot at that interval even when the code is unchanged,
    tagged `changed_slots = tick`. Without it a bot that decides nothing for a minute contributes one
    row and no position history at all — which is exactly the case worth diagnosing. Ticks go to the
    TSV only, never the prose log, which at roster scale they would drown. Any row resets that bot's
    tick timer, so a busy bot doesn't double-log. Budget: 40 bots at 1 Hz fills the 20k ring in ~8 min.
    `0` restores the pre-2026-07-28 change-triggered-only behaviour.
  - Consumers that filter on `changed_slots` must expect the new `tick` value. The first five columns
    are unchanged and still positional, so older parsers keep working.
- **Save state-code TSV** button (added 2026-07-28) — the same `botStateTraceTsv()` text written to
  `bot-state-trace-<YYYYMMDD-HHMMSS>.tsv` (local time, matching the `versions/` stamp convention).
  Exists because clipboard copy loses the take the moment you copy anything else, and a long
  "All bots" run is worth keeping on disk. `saveBotStateTrace()` POSTs to `serve.py`'s
  `/api/save-bot-state`, which writes into **`bot-states/`** with no download dialog and suffixes
  `-N` on collision; if that endpoint is missing (`file://`, or another static server) it falls back
  to a browser download of the same filename. The button reports where the take landed for 2.5 s,
  since either write is otherwise silent. Both TSV buttons disable at zero rows.
  `serve.py` validates the name against `_SAFE_BOT_STATE_FILENAME`, which must stay in sync with
  `botStateFileStamp()`'s pattern — a rename on either side silently falls back to downloads.
- Caps: the trace ring holds `BOT_STATE_TRACE_CAP` = 20,000 rows, the textarea log
  `BOT_STATE_RECORD_CAP` = 4,000 lines; "All bots" scope fills both quickly. Both trim a **block** at
  a time (`…_SLACK` = 2,048 / 512), never one row: see the cost notes below for why.
- The bot readout appends the live code to the state line, with `describeBotState` as its tooltip.
  The code only exists while the recorder is running.

### Cost

Measured on 2026-07-27, 30 bots × 3,600 frames, Node (browser numbers will differ in scale but not
in ratio). A 60 fps frame is 16.7 ms, so all three steady-state figures are noise:

| Path | Cost |
|---|---|
| Recorder **off** — the `botStateRecording` gate plus the unconditional `commitBits` stamp | **0.0018 ms/frame** for all 30 bots |
| Recorder **on** — full `botStateDescriptor` + packed-key compare, no change emitted | **0.0066 ms/frame** for all 30 bots |
| Per genuine code change | ~750 ns: `encodeBotState` 222 ns + `illegalReason` 455 ns + `changedSlots` 73 ns |

`commitBits` is stamped unconditionally rather than behind the recording gate: it is three ternaries
and one store into a shape already declared in `createBotActor`, and gating it would leave the first
recorded row latch-less on a mid-session start.

Two things here **were** real regressions, found by auditing rather than by profiling, both fixed:

- **Ring trim was quadratic at the cap.** `splice(0, 1)` on a full array memmoves the whole thing on
  *every* push — 748 ms per 20,000 pushes against the 20,000-row trace ring (~37 µs each), which in a
  busy "All bots" fight is milliseconds per frame appearing only after a long recording. Block
  trimming makes the same 20,000 pushes cost 0.2 ms (**3,590×**; the 4,000-line log, **834×**).
- **The textarea froze at the cap.** Holding `botStateRecordLines.length` at exactly
  `BOT_STATE_RECORD_CAP` made it equal `botStateRecordRenderedCount` forever, so the append-only
  flush took neither its full-repaint nor its append branch and painted **nothing** — the visible log
  stopped updating while the trace kept recording. A block trim now resets `renderedCount` to force
  one full repaint per trim, amortized over `BOT_STATE_RECORD_SLACK` lines.

`changedSlots` exists for the same reason: `diffCodes` allocates a labelled descriptor per changed
slot and the trace row uses only `.key`, so the per-change path got a 4.4× cheaper twin.

`enumerateLegalCodes()` is **lazy and cached** — it costs ~2.1 s and must never be called at import,
since `bot-state-code.js` is a *static* import of the viewer and therefore on every page load.

### Status

Node-verified: `node --check` on the extracted page script, a 1,224-combination legality sweep of
the adapter's reachable slot combinations at zero illegal codes, and the module's own test suite
green. **Browser QA pending** — nothing here has been watched in a running fight yet, which is also
the only thing that can turn the 458 legal core states into an observed subset.

### Known gaps

- `'alert'` is a real `botState` value with no slot of its own; it is folded into `P` (an alert hold
  is a pinned patrol). A trace cannot distinguish the two.
- `'grenade'` reaches the prose recorder but is never assigned to `botState`, so for that one
  transition the prose line and the code beside it can disagree. Pre-existing; not introduced here.
- `ROLE_SQUAD_LEADER` would silently encode as a rifleman if it were ever spawned.

## World overlay in the trace viewer (2026-07-29)

`bot-trace-viewer.html` drew bot dots on an unlabelled background, so a position could only be read
by hovering and the map's shape was invisible — which is what made the "why is this squad stuck in an
eastern pocket" question so slow to answer. Four toggles under **World** in the sidebar:

| Toggle | Draws |
|---|---|
| `tGrid` | minor + major grid, the `x=0` / `z=0` axes, numbered ticks pinned to the viewport edges |
| `tBounds` | dashed arena rectangle with its `W x D` in metres |
| `tWalls` | walls and cover as filled rects (they are axis-aligned `{x,z,w,d}` boxes) |
| `tPatrol` | patrol ring points as diamonds |

- **Tick spacing** comes from `niceStep(minPx)`, the same 1/2/5×10ⁿ ladder the scale bar uses, so the
  two can never disagree about what a metre looks like. Minor lines are `major/5` and are suppressed
  below 4 px. Verified to give a nice step with a ≥70 px gap at every zoom from 0.6 to 200.
- **Ticks are pinned to the edges, not to the axes**, so a coordinate stays readable when the origin
  is panned off screen; the axes themselves only draw when the origin is actually visible.
- The vertical screen axis is labelled **+Z**, not +Y — the map is a top-down XZ plane.

### Where the arena comes from

Not the trace: a TSV has only bot positions, and their extent is where bots *walked*, not the world.
`bot-viewer-v2.html`'s `botWorldMeta()` writes the real geometry into the sibling
`bot-diag-<stamp>.json` (`world` block: `bounds`, `walls`, `covers`, `patrolPoints`, nav cell size /
cols / rows, and `navRegionSizes` — regions being what strands a bot in the first place). The viewer
derives the diag filename from the trace stamp and fetches it.

Malformed boxes are dropped at write time (`_diagBoxOk`) so one `NaN` can't poison the JSON. All
three load paths (dropdown, file picker, drag-drop) refresh `worldMeta`, so a dropped file cannot
inherit the previous take's arena. When there is no sibling — older takes, or a file from elsewhere —
`worldMeta` stays `null`, nothing world-related draws, and the sidebar says so explicitly rather than
letting a data-extent box be mistaken for the world size. `Fit` frames the **union** of arena and data,
since fitting to either alone can crop the other.

Note that perimeter walls straddle the bounds rectangle by half their thickness — they are centred on
the boundary line. That is correct, not a rendering offset.

**Still to come:** elevation shading. It needs a sampled height field rather than the box list, which
is a bigger payload and a separate change; the `world` block is where it would go.

## Live mode (2026-07-29)

`bot-trace-viewer.html` can stream from a running `bot-viewer-v2.html` instead of loading a file:
**● live** in the viewer header, **Live map** in the game's recorder panel. Both must be on.

**Transport is `BroadcastChannel('bot-trace-live')`.** Both pages are same-origin under `serve.py`, so
this needs no server and cannot block one. `serve.py` does run on `ThreadingHTTPServer` (via
`http.server.test`), so SSE would not have blocked either — it was rejected for needing a pub/sub
queue and connection lifecycle in Python for no gain. The cost of this choice is that it is
**same-browser only**; a live map on another machine would need the `ws` relay in `server/`.

- **Rows are the recorder's**, not a separate live path: change-triggered plus the motion heartbeat,
  measured at ~19 rows/s across 112 bots. Batched into one message per frame (`botLiveFlush` at the
  tail of `updateAllBots`) rather than one per row. Per-frame-per-bot would be ~6,700/s and is not
  what this sends.
- **Turning Live map on also starts recording**, because rows only exist while the recorder runs
  (`:5561` gates on `botStateRecording`); a live toggle with recording off would stream an empty map.
  Turning it off leaves recording running.
- **Handshake**: the viewer usually opens second, so it posts `hello` and the game replies with a
  `snapshot` (world metadata + the last `BOT_LIVE_BACKLOG` rows). Layout rebuilds re-announce `world`.
  Nothing is pushed to a viewer that never said hello.
- **Follow mode** pins `playT` to the newest sample. Any manual seek drops out of it (`setT` clears
  the flag) and the **follow** button resumes. The play loop early-returns while live+following,
  since `setT` would otherwise cancel follow on its first frame.
- Live and file are mutually exclusive — `load()` turns live off rather than interleaving a static
  take with a stream.

### No ring cap, deliberately

An earlier draft of this called for one by analogy with the game's `BOT_STATE_TRACE_CAP`. That
reasoning did not transfer. The game caps because it is a render loop that must not grow the heap; in
the viewer old rows **are the product** — every diagnosis this month came from joining a stalled bot
to what its leader or target was doing minutes earlier, and a silent cap deletes exactly that
evidence at the moment a long session finally reproduces something. At ~19 rows/s the real cost is
~25–35 MB/hour, which a tab holds fine. If it ever does need bounding it must announce what it
dropped.

The actual scaling problem was elsewhere: `drawTrail` scanned each bot's rows from index 0 every
frame. Harmless when scrubbing a finite take (the `r.t > playT` break fires early), unbounded in
follow mode where `playT` sits at the newest sample so the break never fires. It now walks **back**
from the sampled index and stops at `TRAIL_MS`, the same shape `recentFire` already used — cost is
bounded by the trail window instead of history length. Row count no longer affects frame time.

### Row parity

`ingestRow` must produce **exactly** the shape `parseTrace` produces, since every draw path is
shared. They are not trivially the same: the game sends its own recorder field names, so `d` and
`stateChar` are derived viewer-side. `parseTrace` also gained the `target_dist` / `vis_gate` columns
it had been silently dropping since they were added. A scratch harness extracts both real functions
and asserts all 21 keys and values match for the same logical row; re-run it after touching either.

## Stall indicator + elevation shading (2026-07-29)

### Why a live map can look frozen

The game runs on `renderer.setAnimationLoop`, i.e. `requestAnimationFrame`, which **does not fire for
a hidden document**. Backgrounding the game tab therefore pauses the whole sim — the stream is fine,
there is simply nothing to send. Popping the game into its own window fixes it as long as that window
stays genuinely visible; `visibilityState` tracks visibility, not focus, so an unfocused window keeps
running. Chrome on Windows also has native window occlusion detection, so a fully covered window can
still be treated as hidden.

Two signals, because the silences differ:

- **Definitive** — the game posts `{type:'vis', hidden}` on `visibilitychange` (and in the snapshot),
  so the viewer can say *game tab hidden, sim paused* outright instead of inferring it.
- **Fallback timeout** — `LIVE_STALL_MS` 2500 with no rows covers everything else: tab closed, Live
  map switched off there, crash. A stall is the *absence* of messages, so it is polled from the
  viewer's own frame loop (500 ms) rather than triggered by a message that will never arrive.

Both surface in the header stats and amber the ● live button.

### Elevation shading

`botWorldHeights()` samples `groundHeight` over `activeBounds` into a grid capped at 192 samples on
the longer axis (the shorter keeps the aspect), quantizes to a byte against the sampled min/max, and
base64s it into the `world` block. A plain number array for the same grid is roughly 3x the JSON.
The base64 step is **chunked at 8192**: `String.fromCharCode(...bytes)` on a full grid exceeds the
argument limit — the 400x400 case in `test-world-heightmap.mjs` exists to hold that.

Because it samples `groundHeight`, it already includes terrain pads and whatever landform is live.

**Terrain is off by default** (`BOT_TERRAIN_DEFAULTS.enabled: false`), so every sample is 0 and the
payload is marked `flat`. The viewer then draws nothing and the sidebar says *terrain flat (enable it
in the game for relief)* — a uniform grey map would otherwise read as broken shading.

Viewer side: `elevationCanvas()` renders once into an offscreen canvas at grid resolution and caches
it; `drawElevation()` scales that into the bounds rect **beneath the grid**, since relief is the base
layer. Slope is computed in metres per metre from the world bounds, so shading does not change with
grid resolution or arena size, and the light sits upper-left so relief reads as raised. The ramp is a
desaturated slate-to-tan — the teams own green and red, so terrain must not compete with them. The
cache is cleared whenever `worldMeta` changes, not just when a dims-and-length key differs, because
two arenas can collide on that key.

Node-tested (`test-world-heightmap.mjs`): quantization round-trips within one step, the flat case
decodes to zeros rather than NaN, the ramp spans the full 0..255, the chunked encoder survives a
160,000-cell grid, and the grid aspect tracks the world aspect so relief cannot come out stretched.

## Trace columns 20-22 and the event stream (2026-07-29)

Three columns and one new file, each closing a question the state trace structurally could not answer.

| Column | Why |
|---|---|
| `nav_region` | `regionAt(navGrid, x, z)`. Stranding was previously inferable only by joining positions to `patrolNoRoute`; now it is a groupby. `-1` = off-grid. |
| `mag` / `reserve` | Raw counts. The code's ammo slot is a 4-band quantization that cannot tell a genuinely dry gun from a descriptor reading 0 off a weapon with no magazine — which is what made bot-240's "is it really out of ammo" take several passes to settle. |

## Trace columns 23-25: self_threat, sidearm_mag, sidearm_reserve (2026-08-02)

Added while chasing a bot frozen in `aim` for 300+ seconds with a visible target and an empty
primary mag: neither of the two leading suspects was answerable from the existing columns.

| Column | Why |
|---|---|
| `self_threat` | `rec.spinLatched` (env-viewer) / `actor.spinLatched` (bot-viewer-v2), 0/1. H6a's spin rung (`bot-activity.js:83`) forces `AIM` while this is set and is meant to self-clear once the bot turns to face the threat; if a take shows it staying 1 for the whole freeze, the turn itself isn't converging. |
| `sidearm_mag` / `sidearm_reserve` | The OTHER weapon slot's raw ammo (primary's own mag/reserve are already columns 20-21). `updateBotWeaponSlot`/`chooseWeaponSlot` (`bot-sidearm.js`) may have ammo to swap to that never gets applied; these columns make that visible without instrumenting the swap decision itself. |

Both are read in `bot-trace-viewer.html` (`parseTrace`, `ingestRow`) and `self_threat` is tagged
inline in the live state-change log panel.

## Trace column 26: role_id (2026-08-02)

Added so the trace viewer's role-based grouping (see "Group-by dropdown" earlier in this doc) could
separate sniper/technical, and it turned out that was structurally impossible without a new column: the state
code's role slot (`d.role`, decoded from `ROLE_CHARS = 'rm'`) only has room for rifleman/medic —
`botStateDescriptor`'s `d.role = actor.role === ROLE_MEDIC ? 'm' : 'r'` collapses squadleader/sniper/
technical to `'r'` at the point the code is encoded, so no amount of post-hoc parsing of `code` could
recover them. `role_id` logs `actor.role` itself — the real `bot-roles.js` id (`rifleman` / `medic` /
`squadleader` / `sniper` / `technical`) — straight off `pushBotStateTraceRow`, unquantized.

| Column | Why |
|---|---|
| `role_id` | `actor.role` verbatim. The one column that can tell a sniper or technical apart from a plain rifleman; every other role-shaped signal in the trace (the code's role slot, weapon choice) is either lossy or not logged at all. |

Read in `bot-trace-viewer.html` (`parseTrace`, `ingestRow`) via `botRoleInfo`, which prefers `roleId`
and falls back to the state code's `d.role` for older takes recorded before this column existed (so a
role grouping on an old take can still split rifleman/medic, it just can't surface the specialists).

### bot-events-<stamp>.tsv

Kills and damage, written from `applyBotDamage` — the one place that knows attacker, victim, weapon
and whether the hit was fatal. Columns: `t_ms, type, attacker, attacker_team, victim, victim_team,
weapon, cause, amount, victim_health, ax, az, vx, vz, dist` (`dist` is 2D, matching the x/z columns).

It is a **separate file**, not extra trace columns: events are per-incident, not per-sample, so
folding them in would mean a row shape that is half empty on every line. `serve.py` accepts the third
sibling filename, and `_handle_list_bot_states` now filters on the `bot-state-trace-` prefix so the
events file cannot appear in the take dropdown, where it would only fail to parse.

Live mode streams events as their own `{type:'events'}` message and includes a backlog in the snapshot.

## Analysis layers in the trace viewer (2026-07-29)

Six additions, all optional layers over the same timeline. Toggles live in the sidebar; every one of
them is off-by-default except the target links.

### Nav regions (`tRegions`)

`botWorldRegions()` in `bot-viewer-v2.html` emits the nav grid's connected-component labelling as one
byte per cell, base64'd into `world.regions` beside `world.heights`:

| Byte | Meaning |
|---|---|
| `0` | blocked (wall or too-steep) |
| `1` | the main region |
| `2..253` | other regions, **ranked biggest-first** |
| `254` | a carved cell — a slope the nav repair opened |
| `255` | rank past the 252 a byte can name |

Two decisions worth keeping:

- **Rank, not region id.** `labelRegions` reassigns ids on every relabel, so an id means nothing
  across takes and nothing across carves within one take. Rank is stable, and rank 0 is always main.
- **Full nav resolution, never downsampled.** The cap (`WORLD_REGION_MAX_CELLS`, 262144) refuses to
  send rather than shrink, because a downsampled region map erases exactly the one-cell corridors that
  decide whether a pocket is connected. Over the cap the payload is `null` and `tooBig` carries the
  cell count so the sidebar can say why.

Carved cells paint opaque white and are asserted distinct from every region tint — they are the
visible evidence the map needed repair, so they must never blend into ordinary ground. The sidebar
headline reports region count, the share of walkable ground off the main region, carve count, and any
sealed pockets. `sealedRegions` entries now also carry a representative `cell` index (added in
`nav-grid.js`) so a sealed pocket can be located, not merely counted.

### vis_gate colouring and persistent target links

`vis_gate` now drives colour in two places: the glow under a shot line, and a new always-on link from
each bot to its `target_id` (`tTargets`). Green/red/amber/blue = visible / LOS blocked / outside the
FOV cone / out of range; the link is dashed unless the target is genuinely visible, so a solid line
means a live engagement.

The persistent link is the view that makes the shared-fallback-target bug self-evident: eight bots all
pointing at one enemy is a fan of lines on the map and a column of ids in the TSV. Legend swatches are
generated from the same `VIS_GATE` table the map draws with, so a swatch cannot drift from a line.

### Heatmaps (`heatLayers`, layer stack — 2026-08-02)

Whole-take accumulation over a ~200-cell grid: time spent, time stalled, or deaths. Originally a single
`<select id="heatMode">` showing one mode at a time; replaced with a **stack of independently
toggleable, orderable, recolorable, and opacity-controlled layers** (`heatLayers` array in
`bot-trace-viewer.html`) so e.g. "time spent" and "deaths" can be compared on the same map at once. Each
layer is `{ id, mode, ramp, opacity, visible, data, norm, total, cells, canvas, cacheKey, builtAt }`;
`id` comes from a monotonic counter (`nextHeatLayerId`), never an array index, so delete/reorder can't
collide with a stale reference. **Capped at `HEAT_LAYER_CAP` = 3** — normal alpha-over compositing
saturates to unreadable mud past that, and reordering layers doesn't fix saturation (there is no
blend-mode control, deliberately out of scope for v1).

**Weighting is the load-bearing detail.** The recorder emits a row on every state change *plus* a ~1 s
heartbeat, so rows are **not** evenly spaced in time — a bot thrashing between two states emits extra
rows without having stood there any longer. Counting rows per cell would therefore draw "busy state
machine" under the label "time spent". Each row is instead weighted by its dwell time (the gap to that
bot's next row), clamped at `GAP_HOLD_MS` — the same threshold the position interpolator refuses to
bridge, because past it we do not know the bot stayed there. `test-trace-viewer-metrics.mjs` pins this
with fixtures where the two weightings give different answers.

**Layers deliberately have no per-layer team filter.** They inherit the sidebar's single `teamSel`, the
same control that filters which bot dots/trails/labels render elsewhere on the map. An earlier draft of
this design gave each layer its own team filter; it was cut before implementation because a layer
filtered to one team while `teamSel` shows both (or vice versa) would make the map contradict itself —
heat visible for a team whose dots are hidden, or dots visible for a team with no heat. One shared
control per take means the heatmap and the dots can never silently disagree about which team is on
screen.

**Normalization is per layer, deliberately, and that has a readability cost.** Each layer normalizes
independently to its own **98th percentile**, not the max, so one spawn cell cannot flatten that layer's
map to black. But it also means the same opacity slider value renders at different visual weight on a
sparse layer versus a dense one — brightness is not comparable across layers. The mitigation is that the
sidebar always prints each layer's numeric range (`layerRangeLabel`, e.g. `412 cells · 12.4s+ / cell`)
next to its row, so the authoritative number is available even when the color isn't a fair comparison.

**Cost split, preserved from the original single-heatmap design and now enforced per layer:**
`buildHeatLayer` is the expensive step, O(total trace rows across all bots) — it fills only a layer's
raw accumulation (`data`/`norm`/`total`/`cells`) and runs only on a mode or team-filter change, or on the
`HEAT_REBUILD_MS` live-mode throttle. `heatLayerCanvas` is the cheap step, O(grid cells, capped
~200×200) — it turns that accumulation into a colored, alpha-blended canvas and is cached by a key that
now also includes `ramp` and `opacity`, so dragging an opacity slider or switching a layer's color ramp
repaints a small canvas and never re-triggers the expensive accumulation pass. Reordering
(`swapHeatLayer`, which only ever swaps adjacent array elements) and toggling visibility touch neither
step — they only change draw order and which cached canvases get composited that frame.

Both trace-load reset points (`load()` on a new file, `liveReset()` on a live snapshot) call
`clearHeatLayerCaches()`, which sweeps every layer's `data`/`canvas`/`cacheKey`/`builtAt` — a stale
layer from the previous take can't bleed into the next one, and each layer rebuilds itself lazily the
next time `drawHeatLayers()` runs.

The sidebar list shows layers **front-to-back, top row first** (Photoshop-style) even though the
underlying `heatLayers` array is back-to-front draw order (index 0 draws first); the list is rendered
from `[...heatLayers].reverse()`. `renderHeatLayers()` rebuilds the row DOM only on structural changes
(add / remove / reorder) — never on every frame — because replacing a row's DOM out from under an
in-progress slider drag or open `<select>` would drop the interaction. Per-frame numeric updates go
through `updateHeatLayerNotes()` instead, which only sets `textContent` on the note elements
`renderHeatLayers()` handed out, gated per layer so an unchanged layer costs one string compare.

The on-canvas colour bar (`drawHeatBar`) stacks one small bar per **visible** layer, bottom-right, each
labelled with its mode and printing its own norm — multiple bars rather than one shared bar, since
layers can use different ramps. The PNG export caption lists every visible layer's mode
(`heatmap: time+deaths`) instead of a single mode string.

### Notes panel (`#notesPanel`, disk-persisted — 2026-08-02)

A freeform contenteditable notepad (bold/underline/bulleted-list via `document.execCommand`), one note
per take. Opened by the header's Notes button, a full-screen `position:fixed;inset:0` modal shaped like
`#statsPanel` — the two are mutually exclusive by construction (`setActivePanel(name)` is the single
place that toggles either's `.show` class; `null`/`'stats'`/`'notes'`, never both).

**Persisted to disk, not `localStorage`.** `notesFilename(takeLabel)` derives `notes-<slug>.html`
(`slugifyTakeLabel` mirrors serve.py's own `slugify()`, lowercase + non-alnum runs collapsed to `-`);
the note for the loaded take is fetched as a plain static file under `notes/` — there is no list/lookup
endpoint, since the client always knows the exact filename it wants. Saving goes through
`POST /api/save-notes?filename=...` (serve.py), which — unlike every other `save_*` route in that file
— always overwrites the same file in place rather than collision-suffixing a new one, because the same
note is resaved repeatedly as the user types, not a new artifact per save.

Edits are debounced (`NOTES_SAVE_DEBOUNCE_MS`) into a normal `fetch` POST. `beforeunload`/`pagehide`/a
`visibilitychange`-to-`hidden` all trigger `flushNoteBeacon()`, which uses `navigator.sendBeacon`
instead — a `fetch` racing a real navigation can be aborted mid-flight, `sendBeacon` is the platform's
answer to "flush on the way out" (same idiom `environment-viewer.html`'s `botStatsLog`/`perfLog`
already use). `load()` and `liveReset()` both flush the outgoing take's note (`saveNoteNow()`) before
switching `noteLabel` and loading the incoming one, so the last few keystrokes for a take being
replaced aren't dropped. Live mode's note lives at `notes-live.html`, one continuous scratch note
reused across every live session rather than stamped per-session.

**Sanitized on read, not just on write.** `execCommand`'s bold/underline/insertUnorderedList only ever
emit `B`/`U`/`LI`/`UL`/`OL`/`BR`/`DIV` with no attributes; `sanitizeNotesHtml` walks a loaded note (hand-
edited on disk, or stale from elsewhere) and unwraps anything outside that allowlist before it reaches
`innerHTML`, since it's otherwise a stored-content risk with no library dependency to catch it.

`appendNoteEntry(html)` — used by stamping, below — always appends to the trailing `<ul>` (creating one
if the note doesn't end with one) rather than touching wherever the user's cursor happens to be, so a
stamp can land mid-typing without clobbering it.

### Stamping (`stampMode`, Statistics → Notes — 2026-08-02)

A toggle button (`#stampBtn`) in the Statistics panel's toolbar that sends a cell, row, or column
straight into the current note instead of retyping it. Three states — `'off'` / `'stamp'` (single
click, one element stamped per click, mode stays active) / `'collect'` (double-click, clicks toggle
membership in a pending multi-select; a further single click on the button commits every collected
item as **one** note entry and returns to `'off'`). A real double-click always fires a `click` before
`dblclick`, so entering `'stamp'` from a single click is deferred behind a `STAMP_CLICK_DELAY_MS`
pending timer that a following `dblclick` cancels — otherwise every double-click would flicker through
`'stamp'` on its way to `'collect'`. While stamp mode is active, `<th data-key>` clicks mean "stamp this
column" instead of sort, and `tr[data-id]` clicks mean "stamp/select this row" instead of selecting a
bot — the existing click delegate's sort/select branches are skipped entirely (`handleStampClick`
short-circuits first) rather than made to coexist.

**Identity rides on attributes the render functions already stamp onto the table**, no separate
tracking structure: `data-row` on every `<tr>` in both `renderStats()` and `renderStateMatrix()` (a real
bot id, or the raw group/state key when grouped — never the display label, which can carry a `(n)`
count suffix) and `data-key` on every `<th>` (pre-existing for `renderStats()`'s columns;
`renderStateMatrix()`'s dynamic per-bot/group columns previously had none — `columnGroupsFor` now
returns a raw `key` alongside the display `label` for exactly this). A clicked cell's column is found
via `td.cellIndex` against the header row rather than a per-`<td>` attribute; column 0 is always the
row-label column in both tables, which is what makes clicking it mean "stamp the whole row."

**Content is read straight from the rendered DOM at stamp/commit time**, not recomputed from the data
model — `rowStampText`/`colStampText`/`cellStampText` just read `textContent` off the clicked/collected
cells and their header labels. This means grouped views (role/team `groupBy`, grouped state-matrix
columns) automatically produce aggregate-labeled stamps for free, since the row/column label already
displayed (e.g. `rifleman (4)`) carries the group size — no separate "is this an aggregate" branch.
Collect-mode values are re-read at **commit** time, not at selection time, so a long collection during
live mode reflects the latest numbers rather than a stale snapshot from when each item was picked.

`reapplyStampSelection()` re-derives every `.stamp-selected` highlight from `stampCollected`'s identity
keys after each table rebuild (sort — though sorting is unreachable while stamp mode is active, since
header clicks mean column-stamp instead — refresh, or live-mode growth all fully replace `thead`/
`tbody`). An item whose key no longer resolves (e.g. a bot died and got filtered) just doesn't
highlight; it isn't dropped from `stampCollected` and can reappear if the key comes back. Anything that
changes what the row/column keys *mean* — `groupBy`, `leaderMode`, `subModes` (splits state-matrix rows
by `path_mode`, changing `row.key`'s format), the bot/state view tab, loading a new take, going live, or
navigating away from the Stats panel — clears the pending collection (`clearStampSelection()`); anything
that only reorders or refreshes the same rows/columns does not.

### Follow-a-bot camera, PNG export, two-take diff

- `tFollowBot` pins the view to the selected bot; dragging releases the pin rather than fighting it.
- **PNG** captures the map plus a caption strip naming the take, the timestamp, and which layers were
  on — a screenshot without that is unreadable a week later.
- **Two-take diff** loads a baseline take and tabulates it against the loaded one. All rates are
  dwell-weighted for the reason above. `top target share %` is the shared-fallback signature (one
  enemy hoovering up most of the target rows); `patrolLocal %` / `patrolStranded %` separate "has not
  tried to leave its pocket" from "tried and proved there is no way out".

  Deltas are shown **without good/bad colouring**. Which direction counts as an improvement depends on
  what was changed, and encoding that guess in the tool would put a judgement in it that the tool
  cannot actually make. Mismatched run lengths raise a warning that only the ratio and percentage rows
  are comparable, and the panel states that the team filter does not apply to it.
