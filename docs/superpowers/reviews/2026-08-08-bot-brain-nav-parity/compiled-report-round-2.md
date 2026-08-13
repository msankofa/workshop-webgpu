# Bot brain & navigation parity — compiled report, round 2 (definitive)

**Date:** 2026-08-08
**Inputs:** five independent Sonnet investigations against a frozen snapshot (`round-2/agent-1.md` … `agent-5.md`).
**Supersedes:** `compiled-report.md` (round 1), which audited a file that was being edited mid-run.
Round 1 is kept for history and for the process lessons; where the two disagree, **this report wins**.

---

## What changed between rounds

Round 1 audited the live working tree while another agent was actively landing parity work
(`environment-viewer-v2.html` grew ~15 KB mid-audit). Round 2 fixed three things:

1. **Frozen target** — a snapshot of both viewers plus all 46 `bot-*.js` / `nav-*.js` modules, copied at
   one instant, MD5-verified against source.
2. **Local disk** — the snapshot lives off the Google Drive mount, where ripgrep times out and a timeout
   is indistinguishable from a genuine zero-match. That mechanism caused every false "missing" claim in
   round 1.
3. **Two-method rule** — no absence claim without confirmation by a second, different method, listed
   per claim. Agents logged 22–27 absence claims each this way; the ones they could not confirm twice
   they flagged as inferred instead of asserting.

Result: **no false-absence claims survived round 2**, and the heal-vs-pursue threshold confusion that
every round-1 agent fell into was independently avoided by four of five round-2 agents.

---

## Post-snapshot re-check (live file, 05:44)

The parity agent kept working after the 05:11 snapshot — `agent_log.csv` records a command-layer port,
and the live file grew to 846,895 bytes (05:32, stable since). I re-checked the live file against the
findings below:

- **Gap #11 (`orderOverride` / command layer) is already FIXED.** 13 occurrences now in
  `environment-viewer-v2.html`, landed as a middle-mouse hold-drag wheel with a structural test.
  Strike it from the work list.
- **Gap #4 (grenade self pre-gate) is still open.** Live `:6064` is still the bare distance test with no
  occlusion term.
- **Gap #3 (eye height) is still open.** `EYE_LIFT` still has zero occurrences in the live file.
- **§2 `trackStuck`** still present in the port, still absent from the harness.

Everything else below reflects the 05:11 snapshot and should be re-checked against the live file before
work starts, using the same method — read the call site, do not trust symbol presence.

## Confidence key

| Mark | Meaning |
|---|---|
| **[V]** | Verified by the coordinator by **reading the call site**, not by symbol presence |
| **[A]** | Agreed across multiple round-2 agents, each using the two-method rule; not independently re-read |
| **[?]** | Open — flagged by agents as unresolved, or not confirmable by search |

---

## 1. Confirmed gaps — environment-viewer-v2 behind bot-viewer-v2

| # | Gap | Evidence | Behavioral consequence |
|---|---|---|---|
| 1 | **Heal-retreat threshold drift** **[V]** | Harness `threshold01: 0.60` / `resume01: 0.72` (`bot-viewer-v2.html:7658-7659`); port `threshold01: 0.35` / `resume01: 0.85` (`environment-viewer-v2.html:3613-3614`) | Port bots fight to 35% HP instead of 60% before breaking off, then heal to 85% instead of 72%. Roughly doubles how long a bot absorbs damage before disengaging. **Distinct from `pursueHealthThreshold01`, which is 0.60 on both sides.** |
| 2 | **No think-cadence stagger** **[V]** | `botThinkStride` at `bot-viewer-v2.html:3128-3131`, gated call `:3365-3371`; nothing equivalent in the port | Harness throttles the full FSM pass to every 2nd frame past 40 bots and every 3rd past 80 (dt-banked). The port runs every bot's whole brain every frame. This is the mechanism the project's own 90-bot perf pass was credited to, missing from the harness that runs the larger scenario. |
| 3 | **Eye height diverged — and the port disagrees with itself** **[V]** | Harness: `EYE_LIFT = 0.85`, applied as `capsule.start.lerp(capsule.end, EYE_LIFT)` (`bot-viewer-v2.html:6652,7103,7107`) → ~1.32 m. Port: `botEyeInto` returns `capsule.end` (`environment-viewer-v2.html:3426`) → ~1.50 m, while `humanAimInto` returns midpoint + 0.3h (`:3428-3430`) → ~0.8h | Every LOS ray, FOV check, and shot origin sits ~18 cm higher in the port. Worse, the port uses **100% for bot eyes and 80% for human aim points** — an internal inconsistency with no counterpart in the harness. Directly relevant to the tracked "head exposed but not targeted" bug family. |
| 4 | **Grenade self pre-gate is not occlusion-aware** **[V]** | Harness `bot-viewer-v2.html:9095-9096`: `if (roughDist + slack <= blastR * ...selfRadiusScale && blastReachesBody(...)) return null;` — port `:6017`: `if (roughDist + slack <= blastR * ...selfRadiusScale) return null;` | Port bots refuse close-range grenade throws even when a wall protects them, so corner-cook throws never happen. The harness fixed exactly this and left a comment saying the reach test is what stops the pre-gate "silently undoing the corner-cook the self veto now allows." **Round 1 found this; the round-1 coordinator wrongly refuted it — see §5.** |
| 5 | **Grenade evade hysteresis unreachable** **[V]** | Harness passes 4 args incl. `actor.grenadeEvadeId` (`bot-viewer-v2.html:9291`); port passes 3 (`environment-viewer-v2.html:6125`) | The widened evade-exit ring never engages, so bots chatter in and out of evade at the blast boundary. |
| 6 | **Grenade evade is tactically blind** **[A]** | Harness scores evade goals against the visibility field with occlusion/exposure/edge terms; port scores plain distance-from-blast | Port bots dodge grenades into open ground instead of toward cover, making them easy follow-up kills. |
| 7 | **`reportGrenadeThreat` absent** **[A]** | Present `bot-viewer-v2.html:9268-9285`; absent from port, two-method confirmed | Being targeted by a grenade never raises a squad alert in the game. |
| 8 | **Medic contact creep absent** **[A]** | `MEDIC_CONTACT_RADIUS` / `_CREEP` / `creepToContact` wired at `bot-viewer-v2.html:9924-9944`; absent from port | Medics latch at the loose 1.7–2.6 m `tendRadius` instead of closing to ~0.85 m, so they visibly treat allies from a body-length away. A bug the harness explicitly fixed, with a comment, that the port never received. |
| 9 | **Per-weapon reload ignored** **[A]** | Harness derives lockout from `reloadSequence.duration` (`bot-viewer-v2.html:1871-1882`); port uses flat `BOT_RELOAD_MS = 1800` (`:2189`) | Flattens per-weapon tuning and can desync the visual reload from ammo availability. |
| 10 | **No baked-field LOS prefilter** **[A]** | `USE_FIELD_LOS_PREFILTER` in the harness's `selectBotTarget`; port raycasts every FOV/range-passing candidate | Performance, compounding with #2. Correctness should converge, since the raycast is authoritative either way. |
| 11 | **`orderOverride` / command layer absent** **[A]** | Harness wires break-contact and forced double-time from a command wheel; port never sets the ctx fields | The FSM supports a "pull back" order that nothing in the game can trigger. Corroborated by a dated 2026-08-08 entry in `docs/subsystems/bots.md`. |
| 12 | **`resolveStanceOverride` absent** **[A]** | Harness `bot-viewer-v2.html:1085,10714`; port's own comment at `:6463` admits the gap | QA cannot force a stance in the game viewer. Tooling only. |
| 13 | **Scattered-structure cover absent** **[A]** | `bot-structures.js` not consumed by the port, three-method confirmed | Flagged by round-2 agent 2 as the one part of the `bot-terrain.js`/`bot-structures.js` split with **no replacement anywhere** — the rest is covered by the port's own terrain system. |
| 14 | **Overhead "!" marker can never show push/base tier** **[V]** | `rec.bot.alertTier = rec.alertMarkMode;` at `environment-viewer-v2.html:6382` runs **before** the `if (alertTier === 'push')` block at `:6385`, and is never reassigned | The replicated wire field only ever carries `seen` / `heard` / `near` / `null`. Underlying squad push behavior computes correctly; the display is what's wrong. Whether push was ever *meant* to render is a design question the code doesn't settle. |
| 15 | **Squad-slot debug overlay, `createBotForensics`** **[A]** | Absent from the port | Debug/diagnostic only, no decision impact. |

### Numeric drift

| Constant | bot-viewer-v2 | environment-viewer-v2 | Mark |
|---|---|---|---|
| Heal break-off / resume | 0.60 / 0.72 | 0.35 / 0.85 | **[V]** — gap #1 |
| Knife commit / cooldown | 8000 / 5000 ms | 12000 / 6000 ms | **[A]** undocumented |
| Medic heal rate, revive, leases | 22/s, 2500 ms/50 hp, 6.0 m/500 ms | 26/s, 2600 ms/45 hp, 4.5 m/700 ms | **[A]** |
| Shot spread | `spreadHalfAngleRad` only | plus `inaccuracy01 * BOT_MAX_SPREAD_RAD` accuracy slider | **[A]** ~3.4° extra at default; tuning does not transfer between harnesses |

---

## 2. Gaps in the other direction — environment-viewer-v2 ahead of the harness

The direction round 1 under-covered. All five round-2 agents were told to weight it equally.

- **Stuck detection / forced replan / escape** **[V]** — `trackStuck` appears once in the port, **zero times**
  in the harness. Escalating escape retries with a teleport fallback. Round-2 agent 4 found it is
  explicitly commented as intentional, inherited from the pre-port v1 system, on the grounds that only
  open terrain needs it. The nominally authoritative harness has no stuck handling at all.
- **Cover-claim remapping across live grid rebakes** **[A]** — port only; the harness's static bake never
  needs it.
- **Coarse-grid cover-anchor compensation** (`COVER_ANCHOR_REACH`) **[A]** — port only.
- **Richer LOS** **[A]** — the port marches tree/rock columns and terrain height; the harness raycasts bare
  `mapCollider`. The port's comment says this fixed "bots saw and fired through hills."
- **Three-path nav architecture** **[A]** — static grid, incremental terrain-zone bake, bounded local-window
  grids, against the harness's single static bake. `nav-grid.js:47-50` names environment-viewer-v2 as the
  intended consumer. Documented Phase D work, not drift.

---

## 3. Confirmed at parity

FSM ladder (`chooseBotStateName`), FOV cone (150°), target re-scan stagger, target-selection risk
scoring and stickiness, `AIM_DEFAULTS` with no overrides on either side, `pursueHealthThreshold01`
(0.60 both), pursue-break-on-miss (3 misses / 1500 ms), alert escalation tiers, split attention,
close-threat spin, `readyToFire`, sidearm swap, role registry and assignment, squad election and
succession, formation kinds and slot math, medic decision core, goal claims, danger cost, separation
constants, nav grid cell size, A*/flood-fill, and region labeling — the last confirmed as the *same*
algorithm despite different call patterns.

Also confirmed present in both, contrary to round 1: **`bot-score.js`** and **`bot-contacts.js`**.

---

## 4. Open items

- **Knife/melee model change** **[?]** — round-2 agent 4 reports the port switched from a distance-only
  "always hits" melee to a facing-dependent raycast that can whiff. I could not confirm this by search
  and did not trace it. Needs a read of both melee paths before anyone acts on it.
- **Projectile hit-testing fork** **[?]** — `rayCapsuleHit` in the harness vs an entity-registry
  `blastDamageAt` path in the port. Flagged across both rounds, traced by neither.
- **`footprintRange` terrain-seating** **[?]** — round-2 agent 4 explicitly left open whether the port has
  any equivalent.
- **Whether the numeric drifts are deliberate** — heal thresholds, knife timers, medic tuning, accuracy
  slider. This needs a balance owner's decision, not another audit.

---

## 5. Corrections to round 1

| Round-1 claim | Status |
|---|---|
| `bot-score.js` missing from the port (all five agents) | **False.** Imported and wired. |
| `bot-contacts.js` missing from the port (three agents) | **False.** Imported and called. |
| Grenade self-veto occlusion regression "refuted" by the coordinator | **The refutation was wrong.** The gap is real — §1 gap #4. |
| Disengage thresholds drifted (agent 5) / identical (agents 2, 4) | **Both wrong.** Pursue is identical; *heal* drifted. |
| Grenade evade hysteresis reversed (agent 3) | **Wrong direction.** Harness has it, port doesn't. |

**On the coordinator's own error.** I refuted the grenade finding by grepping `blastReachesBody`, seeing
it defined and passed into `chooseGrenadeThrow`, and concluding parity. There are two gates; the symbol
was present at the later one and absent at the earlier one. **Symbol presence in a file does not
establish use at a given call site.** This is the same failure mode as the agents' false absences, and
it deserves the same rule: confirm at the call site by reading. Every **[V]** in this report was
re-checked that way.

---

## 6. Recommended order of work

1. Fix the behavioral gaps, in this order: heal threshold (#1), eye height and its internal
   inconsistency (#3), grenade self pre-gate (#4), medic contact creep (#8), grenade evade hysteresis (#5).
2. Port the think-cadence stagger (#2) before bot counts grow — it is the only scale relief the harness
   has and the game viewer runs the bigger scenario.
3. Fix the "!" marker ordering bug (#14) — one-line, isolated from the behavior it displays.
4. Get a balance decision on the numeric drifts.
5. Decide whether `trackStuck` ports *back* to the harness (§2), since the harness is nominally
   authoritative and currently has no stuck handling.
6. Trace the open items in §4 before acting on them.
7. Fix two stale docs, both independently flagged: the target-selection "known drift" note
   (`docs/subsystems/bots.md:2353-2357`) and the "still-old env-viewer keeps SEEK" warning. Also the
   port's own "inert until the brain lands" comment, which describes states that are in fact fully wired.

---

## Appendix: what the swarm was actually good for

Round 1's value was not consensus — the majority was wrong on three of three headline absence claims,
and agreement actively concealed the error because all five agents shared one broken tool and one moving
target. Its value was **disagreement**: every contradiction between agents pointed at something worth
verifying, and each verification changed the answer.

Round 2's value was different. With the substrate fixed, agreement started meaning something: four of
five independently avoided the threshold conflation, and no false absences survived. The agents also
found things a single pass would likely have missed — the "!" marker ordering bug, the port's internal
eye-height inconsistency, and the `bot-structures.js` cover gap each came from exactly one agent.

The transferable lesson is that a swarm amplifies whatever its substrate does. Five agents sharing a
timing-out search tool on a file being edited underneath them produce five confidently wrong reports
that agree with each other. The fix was not more agents or better prompts; it was freezing the target
and moving it off the bad mount. Verify the substrate before scaling the fan-out.
