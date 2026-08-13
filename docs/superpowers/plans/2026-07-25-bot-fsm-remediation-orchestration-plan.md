# Bot FSM remediation — orchestration plan (2026-07-25)

Executes the findings in `docs/superpowers/reviews/2026-07-25-bot-fsm-behavior-audit.md`
(finding IDs H1-H6, C1-C15, L5-L10, S2-S14, A4-A13 refer to that doc).

## STATUS

- [x] Wave 0 — prep/baseline (2026-07-25: snapshots taken, 13/13 tests green, anchors verified at 5647-line harness, stale banner on bot-state-machine.html)
- [x] Wave 1 — one-line tells (H1, H2, H4, C5) (2026-07-25: shipped + reviewed; review found S1 churn regression → fixed via fromReport anchors; near-miss/self-splash seed guards added; alertTierChannels extracted+tested; 13/13 green; docs+log updated; browser QA pending — note H1 reverses the deliberate 2026-07-24 unconditional-hold decision, see bots.md)
- [x] Wave 2 — state-conflict fixes (C1-C4, C8, C10-C15) (2026-07-25: shipped, 14/14 green. M2/M3 module agents died at session limit mid-test-writing; implementations survived and were completed inline. C12 + sentinel cleanup deferred; C15 pre-fixed by concurrent refactor. Review done: 6/7 scenarios passed with proofs; HIGH fix applied — detonateBlast never triggered heal retreats, now calls beginBotHealthRetreat per victim; clock hardening + dead-code cleanup; 15/15 green. MED-2 note → wave 4 medic scope: medic closes on a fleeing patient at ~0.24 m/s, bump chase speed / widen tendRadius for FLEE patients)
- [x] Wave 3 — anti-lemmings (H3, H5, L5, L6, L7) (2026-07-25: shipped + reviewed, 97/97 green. Review MEDs fixed: L7 implemented, death paints cover anchor/peek cells + cover veto at 0.35, spread now 8-slot with slot 0 = true anchor + solo gate; medic danger term + reposition seek release added. Browser QA pending)
- [x] Wave 4 — synergy & awareness (S2, A4/S7, A9, H6, S10, S12, A6 + MED-2 medic chase) (2026-07-25: shipped + reviewed, 97/97 green. Review HIGHs fixed: allyDown edge-triggered + re-pick vs new bearing, contact-seed 5 s cooldown; MEDs fixed: spin latch, peek-break on backstab, peek-reload coupling, medic single-centre, secondary penalty-not-veto at pick, probe gating. Deferred: wall-clock peek tiling, ring FIFO inversion, debug wedge tier cone. Browser QA pending — ALL FOUR WAVES)
- [x] Waves 0-4 — browser QA PASSED (2026-07-26, user gate cleared)
- [x] Wave 5 — S11 leadership/bounding overwatch, S13 hold generalization, S14 pincer, A7 retune+intercept
      (2026-07-26: shipped inline — no module/integrator agent split this time, subagents weren't sanctioned.
      New `bot-pursuit.js` + `test-bot-pursuit.mjs`; `squadRanks`/`boundingRole` added to bot-roles.js;
      full suite green. Browser QA pending: watch a 3-bot push for the white/green bound swap.)
- [x] Wave 6 — A10 reaction time + weapon spread (2026-07-26: the combat-feel call went the other way —
      user asked for it, "them lazering each other immediately is unrealistic". New `bot-aim.js` +
      `test-bot-aim.mjs` (41 checks); recognition delay gates `readyToFire` only (the FSM still sees
      raw visibility); dispersion applied in `fireBotShot` before combat/tracer/bullet consume the ray;
      pre-spread ray kept for the mount-alignment diagnostic. Two toggles + 13 sliders in an
      *Aim & reaction* panel section, saved in the bots slot group. Full suite green. Browser QA pending.)
- [x] Waves 5-6 — browser QA PASSED (2026-07-26, user gate cleared). Every audit finding taken is now
      QA'd; the remediation plan is complete apart from the docs/cleanup track below.
- [ ] Docs/cleanup track (runs alongside each wave)
- Browser QA: complete for waves 0-6 (user gate)

## Ground rules (apply to every wave)

1. **The harness file is a mutex.** ~70% of fixes touch `bot-viewer-v2.html` (5500 lines,
   still under concurrent refactor). Never let two agents edit it in the same wave.
   Pattern per wave: **parallel module agents → one serial integrator agent**.
   - Module agents: edit only their assigned `bot-*.js` file(s) + matching `test-*.mjs`.
     Disjoint file sets → safe to run concurrently. Each returns the exact wiring contract
     (new exports, call signature, where the harness should call it).
   - Integrator agent: sole owner of `bot-viewer-v2.html` for the wave; applies all wiring,
     resolves ladder-priority interactions between the wave's fixes.
2. **Locate by symbol, never by line.** The file drifted 21 lines during the audit and the
   refactor continues. Every agent prompt gives anchor strings (function names, unique
   comments), not line numbers.
3. **Logic goes into pure modules; the harness stays wiring.** This is the existing repo
   pattern (pure `bot-*.js` + flat Node tests) and it is what makes both parallelism and
   testability possible. If a fix needs a new predicate, it lands as a pure export with a
   test, not as inline harness logic. New decision logic without a Node test does not merge.
4. **Snapshot before each wave**: copy `bot-viewer-v2.html` (and any module about to change)
   to `versions/<name>-before-fsm-wave<N>-<YYYYMMDD-HHMMSS>.<ext>`.
5. **Gate to close a wave**: full `node test-*.mjs` suite green → parallel adversarial
   review (see §Review) → review findings fixed → subsystem doc + `agent_log.csv` row →
   browser-QA checklist handed to user (play notification sound). Waves are sequential;
   do not start wave N+1 until wave N's Node gate is green (browser QA can lag behind —
   it batches).
6. **Protect the verified-fine list** (audit §7). Reviewers explicitly check that no fix
   removed existing hysteresis, claim release, death cleanup, or the peek jitter. The
   audit's "don't re-flag" section doubles as the regression checklist.
7. **v2 only.** `bot-viewer.html` (v1) carries the same logic at different offsets; it is
   NOT patched in these waves. Decide after wave 4 whether to backport or let the
   env-viewer port supersede v1 entirely (leaning: supersede — see open questions).

## Wave 0 — prep/baseline (1 agent, serial)

- Snapshot harness + all bot-* modules to `versions/`.
- Run every `test-bot-*.mjs` / `test-squad-activity.mjs`; record pass baseline.
- Grep-confirm the audit's anchor symbols still exist post-refactor (`wantAlertHold`,
  `beginBotHealthRetreat`, `commitCoverCorner`, `coverStartedAt`, `beingHealed`,
  `nearestSeekablePack`, `recordBotShotResult`, `selectBotTarget`). Emit a symbol→current
  state note for the wave-1 integrator.
- Mark `bot-state-machine.html` stale with a banner comment pointing at the audit doc
  (regeneration is a wave-4 docs task, not now).

## Wave 1 — one-line tells (2 agents: 1 module, 1 integrator)

Highest player-visible payoff per line; all four are wiring-only or near it.

| Fix | Finding | Change | Owner |
|---|---|---|---|
| Exposure-gated alert hold | H1 | Import `exposedToThreat`; add `&& !exposedToThreat(...)` to `wantAlertHold`. Exposed bots skip the hold (fall through to cover rung / keep moving). | integrator |
| Push tier keeps cover | H2 | In the tier block: `coverAlert = (tier === 'defensive' || tier === 'push') ? report : null`. Push seeds lastKnown AND stays cover-eligible. | integrator |
| Self-threat seeds search | H4 | Where `selfThreat` is consumed for facing: if no `lastKnownTarget`, seed it (+`lastKnownTargetAt`) from `selfThreat.threat`. | integrator |
| Miss-streak reset | C5 | Reset `botMissStreak` when `botTarget` changes identity and when visibility of the current target is lost for > ~1.5 s. | integrator |

- Module agent: extend `bot-alert.js` ONLY if a pure helper is needed for the H4 seed
  (e.g. `threatSearchAnchor(selfThreat)`); extend `test-bot-alert.mjs` with cases for the
  H1 gate composition and H2 tier table (tier → coverAlert expectation).
- Interaction check for the integrator: H2 + H1 together change alert-tier flow — a pushed
  bot that is exposed must now prefer COVER_MOVE over walking (that is the intended
  emergent result; assert it in the review pass).
- Browser QA script (user): (a) shoot a patroller from a doorway twice from concealment —
  it should investigate the doorway, not resume patrol; (b) kill two of a squad — the
  survivors should use corners, not walk in a line; (c) graze a bot mid-courtyard — it
  should not freeze in the open.

## Wave 2 — state-conflict fixes (4 module agents ∥, then 1 integrator)

| Agent | Files | Fixes |
|---|---|---|
| M1 pack-intent | `bot-health-packs.js`, `test-bot-health-packs.mjs` | C1: pure `packClaimIntent(state, wantsHeal, hasPack)` — claim only from states that will actually walk to the pack (patrol, flee-heal detour). C10: pure `packRunSafe(botXZ, packXZ, threatXZ)` — reject pack runs whose bearing closes on the threat (dot-product test; visibility-field term comes in wave 3). |
| M2 cover-timing | `bot-cover.js`, `test-bot-cover.mjs` | C2: separate `coverMoveSince` stamp (set on entering COVER_MOVE, not at commit); timeout reads it. C3: anchor-reach hysteresis — enter HOLD at 0.45 m, exit only beyond 0.9 m (`coverSeatBand(dist, holding)` pure fn); peek/`coverHoldSince` survive a within-band flap. C14: blacklist entries carry `expiresAt` (~20 s TTL), pruned on read. |
| M3 debounce | `bot-activity.js`, `test-bot-activity.mjs` | C8: `stepVisibleDebounce(st, rawVisible, now)` — lose `visible` only after ~250 ms occluded; investigation teardown keys off the debounced value. C13: exit buffer on `healUnsafe` (unsafe < 8.5 m, safe again > 10 m). Ladder unchanged otherwise. |
| M4 claims-guard | `bot-separation.js`, `test-bot-separation.mjs` | L9: `claim()` refuses cross-kind eviction of the same owner's other-kind claim (or releases the old kind explicitly). Assert namespace invariants in test. |
| Integrator | `bot-viewer-v2.html` | Wire M1-M4. C4: remove `BOT_FLEE` from the `beingHealed` yield list (medic chases; patient keeps retreating — medic-side follow logic already exists via path re-plan). C6: `'reposition'` entry releases flee claim + cover corner and allows reload start; exit maps sentinel back to a real `BOT_*` before commitment tests. C11: route `beginBotHealthRetreat` writes through `withBotActor` when target is the bound actor (or write the mirrored globals). C12: defer the shooter's own state stomp in `applyCombatDamage` to next tick (set a flag, not `botState`). C15: `updateCoverMoveMovement` uses `requestPathBudgeted`. |

- Review emphasis: C3 is the riskiest (touches the cover flap that currently "protects"
  crowded bots by accident) — reviewer must run the two-bots-one-pillar scenario mentally
  against the new band and confirm the drought exit now accumulates.
- Browser QA: crowded cover at a pillar (bots should peek and fire, not jitter); medic +
  retreating patient under fire (patient keeps moving); wounded bot near an enemy-side
  pack (should not charge it); RPG bot self-damage (should retreat).

## Wave 3 — anti-lemmings (3 module agents ∥, then 1 integrator)

| Agent | Files | Fixes |
|---|---|---|
| M1 danger-field | NEW `bot-danger.js`, `test-bot-danger.mjs` | H3: team-scoped decaying danger map — `recordDanger(team, cellIdx, weight, now)` on ally death/hit, `dangerAt(team, cellIdx, now)` with exponential decay (~20-30 s half-life), capped entries. Pure, grid-index based. |
| M2 seek-claims | `bot-activity.js` or harness-adjacent pure helper, tests | H5: `'seek'` goal-claim kind on the chosen investigation cell; frontier skips other-claimed cells; per-bot angular offset (`spreadAnchor(anchorCell, botIndex)`) so ring-0 isn't shared. L6: pure `pursueBreakAllowed(missStreak, jitterSeed)` — per-bot ±1 jitter on the streak threshold. |
| M3 flee-quality | `bot-cover.js` or `bot-danger.js` helper + tests | L5: path-integral exposure — sample `visField.canSee(threatCell, ·)` along the flood parent chain (every k-th cell), penalize exposed hops; separate threat-distance and path-cost scales so they stop fighting; S9: add squad-centroid attraction term (`teamCentroid` already exists in bot-medic.js — lift it to a shared location or duplicate the 10-line helper). |
| Integrator | `bot-viewer-v2.html` | Wire danger term into the four scoring loops (flee, patrol-resume, pack, medic approach) + cover-corner pick + optionally A* neighbor cost (behind a flag, default on in bot-viewer, off for env-viewer port until profiled). L7: `patrolIndex: nextBotId % patrolPoints.length`, and split patrol rings per team if trivial. Release `'seek'` claims on investigation end/death. |

- Perf note for reviewer: danger lookups run inside hot scoring loops — must be O(1) map
  reads with prune-on-write, no per-candidate allocation (respect the ongoing
  allocation-free refactor).
- Browser QA: kill a bot at a corner — the next bot should pick a different corner; wipe
  half a squad in one lane — survivors route around it; squad losing a target should fan
  out, not conga to one cell.

## Wave 4 — synergy & awareness (4 module agents ∥, then 1 integrator)

| Agent | Files | Fixes |
|---|---|---|
| M1 contact-reports | `bot-alert.js`, `test-bot-alert.mjs` | S2: `kind:'contact'` report pushed (rate-limited ~1/s per reporter) on visual acquisition; `latestContactNear` (same-team filter); **excluded from `alertEscalation` scoring** so tiers still mean casualties. Consumers seed `lastKnownTarget`/`coverThreat`. |
| M2 attention | `bot-alert.js`, `test-bot-alert.mjs` | A4: patrol sweep — allow `attentionSweep` while moving at reduced amplitude (±0.5 rad) on a slower period, so patrollers glance around. S7/A5: phase-offset `sweepSince` by a per-bot seed so co-located bots don't share a blind arc. A6: tier-scaled perception — `defensive`/`push` widen FOV to ~160° and halve `TARGET_SCAN_STRIDE` (pure `perceptionForTier(tier)`). |
| M3 ladder | `bot-activity.js`, `test-bot-activity.mjs` | A9: reload-aware rungs — `reloading && coverAvailable → COVER_MOVE`; top-off reload when concealed (peek `'in'` phase or no visible target) and mag < ~30%. H6 (part): new top-priority rung `closeSelfThreatBehind → spin/aim at it` (preempts committed AIM/FIRE for a self-threat inside ~4 m outside the FOV cone). |
| M4 cover/medic | `bot-cover.js`, `bot-medic.js`, tests | S10: peek phase assignment — `commitCoverCorner` takes a `groupIndex` (count of same-threat cover claimants within 8 m); initial `inHoldS += groupIndex * PEEK_OUT_S`. S8: `'allyDown'` exit reason in `coverHoldExitReason` when a fresh lethal report arrives from a new bearing. S12: `decideMedicAction` takes optional `{exposed}`; exposed tend spot downgrades to MEDIC_MOVE toward nearest concealed cell within `tendRadius`. H6 (part): `pickCoverCorner`/`coverCornerValid` accept an optional `secondaryThreat` used only as a veto. |
| Integrator | `bot-viewer-v2.html` | Wire all; maintain a `secondaryThreat` slot (second-nearest visible enemy or freshest contact report ≠ primary); pass exposure (`exposedToThreat`) into medic decisions; wire tier perception into `selectBotTarget`/`withinBotFov`. |

- This wave has the most cross-fix interaction (contact reports feed the H4 seed, the
  cover veto, and tier perception). Integrator prompt must include wave 1-3 diffs summary.
- Browser QA: duel a bot and have a friend knife it from behind (it should spin); watch a
  2-bot cover pair (peeks should alternate); reload behavior (bots duck to cover); medic
  tending behind cover, not in the lane.

## Wave 5 — deferred (scope on demand)

S11 real push tier (leader + base-of-fire/flank via `pickSquadLeader`), S13 generalize
`healHoldUntil` → `holdUntil`/`holdReason` for bounding overwatch, S14 pursue pincer
offsets, A7 investigation expansion retune (0.55 → ~2.5 m/s) + pursuit intercept lead,
A10 reaction-time/spread (combat-feel change — decided in favour, shipped as wave 6 with both
halves toggleable). Each is its own mini-wave with the same module/integrator split.
Also: decide v1 backport vs. supersede,
and start the env-viewer port of the whole remediated stack (per the standing
bot-viewer-authoritative direction).

## Review protocol (every wave)

After the integrator finishes and Node tests pass, run 3 parallel reviewers:
1. **Regression hunter** — diff-focused; checks the audit §7 verified-fine list item by
   item (hysteresis intact, claims released on all exits incl. death, peek jitter kept,
   bind/commit lists updated for any new per-bot field — new fields MUST be added to
   `createBotActor`/`bindBotActor`/`commitBotActor` or documented as lazily-`??=`).
2. **Scenario prosecutor** — replays each finding's original failure scenario against the
   new code path and states pass/fail with the code trace.
3. **Perf/alloc reviewer** — no new per-tick allocations in hot loops, replan budget
   respected, danger/claim maps bounded.
Findings go back to the integrator; re-review only what changed.

## Docs/cleanup track (parallel to any wave, doc-only agent)

- `docs/subsystems/bots.md`: update per wave (it drifts otherwise — audit found it already
  wrong on `ALERT_HOLD_MAX_MS` 20000 vs "10 s" and on the removed `exposedToThreat` gate).
- `agent_log.csv`: one row per wave (subsystem `bots`... use existing key `multi` if a wave
  touches nav/separation too).
- Wave 4 close-out: regenerate `bot-state-machine.html` from the remediated FSM or delete
  it in favor of the audit doc's mermaid map; remove dead config
  (`pursueDistance`, `preferredCombatDistance`) or wire it, don't leave it lying.

## Open questions (defaults chosen; flag to change)

1. **v1 backport**: default = don't patch `bot-viewer.html`; supersede via env-viewer port
   after wave 4.
2. **Danger cost in A***: default = scoring-loops only in waves 3; A* term behind a flag.
3. **A10 reaction time/spread**: ~~excluded — needs a design call~~ → **resolved 2026-07-26, in
   favour** (user: instant lasering reads as unrealistic). Shipped as wave 6, both halves behind
   toggles so the old behaviour is one click away.
