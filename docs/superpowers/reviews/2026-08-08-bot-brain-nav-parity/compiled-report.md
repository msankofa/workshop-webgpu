# Bot brain & navigation parity: bot-viewer-v2 vs environment-viewer-v2 — compiled report

**Date:** 2026-08-08
**Inputs:** five independent Sonnet investigations (`agent-1.md` … `agent-5.md`), all given the identical prompt.
**Compiled by:** the coordinating session, which re-verified every disputed and every headline claim directly against the files.

---

## Read this first: the audit ran against a moving target

Another agent was actively doing bot-parity work on `environment-viewer-v2.html` while this audit ran.
That is not speculation — it is measured:

- `environment-viewer-v2.html` was 819,997 bytes at 05:07:51 and 834,921 bytes at 05:11:41. Roughly
  15 KB of parity work landed mid-audit.
- `git diff` shows `bot-body-hit.js`, `bot-damage-class.js`, and `bot-contacts.js` imports as
  **uncommitted working-tree additions**, absent from `HEAD` (`23da7d4`).
- Agent 5 independently observed the import block gaining lines between two reads at the same offsets.

**Consequence:** every "absent entirely / 0 references" claim in the five reports is unreliable. An agent
that read early, or whose ripgrep silently timed out on the Google Drive mount, recorded a
feature as missing that had just been added. Three of five agents made this error, and they made it in
the *same direction*, so simple majority agreement across the swarm did **not** filter it out.

Two structural lessons for the next audit of this kind:

1. **Freeze the target.** Audit a git ref (`git stash` / worktree / commit SHA), never a live working
   tree that another agent is editing.
2. **A negative from ripgrep on this mount is not evidence.** Glob and Grep time out here routinely
   (they did for this coordinator on the very first call). A timeout and a genuine zero look identical
   to the agent. Absence claims need a second, different method to confirm.

---

## Confidence key

| Mark | Meaning |
|---|---|
| **[V]** | Verified by the coordinator directly against the current working tree |
| **[R]** | Refuted by the coordinator — the reports are wrong |
| **[A]** | Multi-agent agreement, not independently re-verified |
| **[?]** | Agents contradicted each other and the point remains open |

---

## 1. Refuted claims — do not action these

These were headline findings in multiple reports. All are wrong, all for the moving-target reason above.

| Claim | Reported by | Reality **[R]** |
|---|---|---|
| `bot-score.js` missing entirely from env-viewer-v2 | agents 1, 2, 3, 4, 5 | Imported at `environment-viewer-v2.html:81`; session-tally HUD wired at `:3699`. Only a reset button and breakdown-text formatters are absent. |
| `bot-contacts.js` absent from env-viewer-v2 | agents 2, 3, 4 | Imported at `:79`; `recordContactSighting` called at `:4001`. Write-only scaffolding in **both** harnesses, i.e. genuine parity. |
| ~~Grenade self-veto lost its occlusion check~~ | agents 2, 4 | **This refutation was itself wrong — see the correction below. Agents 2 and 4 were right; the gap is real and is now listed in §2 as gap #10.** |

### Correction: the grenade self-veto refutation was a coordinator error

The original refutation above was based on grepping for `blastReachesBody` and finding it *defined*
(`:5942`) and *passed* into `chooseGrenadeThrow` (`:6041`). Reading the actual code shows those are a
different gate from the one agents 2 and 4 were describing. There are **two** gates:

- The cheap **self pre-gate**, which runs first and can reject a throw before the accurate gate is ever
  reached.
- The accurate gate inside `chooseGrenadeThrow`, which receives `blastReaches`.

The harness's pre-gate is occlusion-aware — `bot-viewer-v2.html:9095-9096`:

```js
if (roughDist + slack <= blastR * botGrenadeSettings.selfRadiusScale
  && blastReachesBody(_grenadeRoughAim(aimX, aimZ), { cap: bot.capsule })) return null;
```

with a comment stating that without the reach test this "would veto every short throw before the real
gate ever saw it, silently undoing the corner-cook the self veto now allows."

env-viewer's pre-gate is not — `environment-viewer-v2.html:6017`:

```js
if (roughDist + slack <= blastR * botGrenadeSettings.selfRadiusScale) return null;
```

Both files pass `blastReaches` to the *later* gate, which is what the grep found and what made the
presence of the symbol look like proof of parity. **Grepping that a symbol exists in a file does not
establish that it is used at the specific call site in question.** That is the same class of error the
agents made in the other direction, and it warrants the same two-method rule this report recommends
for absence claims: confirm at the call site by reading, not by symbol presence.

Agent 1's report still asserts the `bot-score.js` claim (it finished before the correction reached it).
Agents 2, 3, and 4 corrected their files after being notified. Agent 5 never made these errors.

---

## 2. Confirmed gaps — real, verified, actionable

Absent from `environment-viewer-v2.html`, present in `bot-viewer-v2.html`, each confirmed by direct
grep against the current working tree.

| # | Gap | Evidence | Why it matters |
|---|---|---|---|
| 1 | **No think-cadence throttle** — `botThinkStride` **[V]** | `bot-viewer-v2.html:3128-3131`, gated call `:3365-3371`; zero occurrences in env-viewer-v2 | The harness throttles the full FSM pass to stride 2 above 40 bots and 3 above 80. env-viewer runs every bot's full think every frame. This is the mechanism the project's own 90-bot perf pass was credited to, missing from the harness that runs the *larger* scenario. |
| 2 | **Eye height differs** — `EYE_LIFT` **[V]** | `EYE_LIFT=0.85` at `bot-viewer-v2.html:6652`; env-viewer uses `capsule.end` (100%) at `:3422`; zero occurrences of `EYE_LIFT` in env-viewer | Every LOS ray, FOV check, and aim origin sits ~15% of capsule height higher in env-viewer. Directly relevant to the already-logged "head exposed but not targeted" bug family. |
| 3 | **Medic contact creep** — `MEDIC_CONTACT_RADIUS` / `_CREEP` **[V]** | `bot-viewer-v2.html:9924-9934`, called `:9944`; zero occurrences in env-viewer | Medics latch at the loose 1.7–2.6 m `tendRadius` instead of closing to 0.85 m. This is a bug the harness explicitly fixed, with a comment saying so, that env-viewer never received. |
| 4 | **Grenade evade hysteresis** — `engagedId` **[V]** | Harness passes `actor.grenadeEvadeId` (4 args) at `bot-viewer-v2.html:9291`; env-viewer passes 3 args at `:6125` | Without the widened exit ring, bots chatter in and out of evade at the blast boundary. |
| 5 | **`reportGrenadeThreat`** **[V]** | `bot-viewer-v2.html:9268-9285`; zero occurrences in env-viewer | Being targeted by a grenade never raises a squad alert in the game viewer. |
| 6 | **`orderOverride` / command wheel** **[V]** | Wired at `bot-viewer-v2.html:619,621,711,10616-10617`; zero occurrences in env-viewer | The break-contact "pull back" order is a dead rung of the shared FSM in the game — the ladder supports it, nothing can set it. |
| 7 | **`resolveStanceOverride`** **[V]** | `bot-viewer-v2.html:1085,10714`; zero occurrences in env-viewer, and env-viewer's own comment at `:6463` admits the gap | QA cannot force a stance in the game viewer. Tooling, not gameplay. |
| 8 | **`squadSlotWorld`** **[V]** | `bot-viewer-v2.html:921,7072`; zero occurrences in env-viewer | Agents split on severity: agent 3 called it broken formation placement, agent 4 established the real path (`squadMemberGoal`) calls it internally inside the shared module, so this is a **debug-overlay gap only**. Agent 4's reading is the better-evidenced one. |
| 9 | **`createBotForensics`** **[V]** | `bot-viewer-v2.html:909,3426`; zero occurrences in env-viewer | Diagnostic ring only. No decision-making impact. |
| 10 | **Grenade self pre-gate is not occlusion-aware** **[V]** | Harness `bot-viewer-v2.html:9095-9096` adds `&& blastReachesBody(...)`; env-viewer `:6017` is the bare distance test | Bots refuse close-range grenade throws even when a wall protects them from their own blast, so corner-cook throws never happen. The harness fixed exactly this and left a comment saying so. Originally mis-refuted by the coordinator — see §1. |

### Numeric drift (agreed across reports, spot-checked)

| Constant | bot-viewer-v2 | environment-viewer-v2 | Note |
|---|---|---|---|
| Heal break-off / resume | `0.60` / `0.72` (`:7658-7659`) | `0.35` / `0.85` (`:3613-3614`) | **[V]** Real drift. See §4 — every agent misattributed this. |
| Knife commit / cooldown | 8000 / 5000 ms (`:6686-6687`) | 12000 / 6000 ms (`:3648-3649`) | **[A]** |
| Medic heal rate, revive, leases | 22/s, 2500 ms/50 hp, 6.0 m/500 ms, claim 700 ms | 26/s, 2600 ms/45 hp, 4.5 m/700 ms, claim 1500 ms | **[A]** Plausibly deliberate rebalance; needs an owner's sign-off. |
| Reload duration | Per-weapon `sequence.duration`, 1800 ms fallback (`:1871-1882`) | Flat `BOT_RELOAD_MS=1800` (`:2189`) | **[A]** Flattens per-weapon tuning; can desync visual reload from ammo lockout. |
| Shot spread | `spreadHalfAngleRad` only (`:10215`) | plus `inaccuracy01 * BOT_MAX_SPREAD_RAD` slider (`:5765`) | **[A]** ~3.4° extra at default. Reads as an intentional balance knob, but it means the two harnesses are not spread-comparable at matching aim defaults. |

---

## 3. Gaps in the other direction — env-viewer ahead of the harness

Worth recording, because "parity" has been framed one-directionally and these will silently reverse
if someone ports the harness over the game viewer.

- **`trackStuck` stuck-detection / forced replan** **[V]** — 1 occurrence in `environment-viewer-v2.html`,
  **0** in `bot-viewer-v2.html`. Agents 1 and 5 both flagged this. The "authoritative" harness has no
  stuck/replan logic at all.
- **`finalizeNavGrid`, `COVER_ANCHOR_REACH`, `SIGHT_BLOCK_HEIGHT`** **[A]** — wired only in env-viewer.
  `nav-grid.js:47-50` names environment-viewer-v2 as the intended consumer, so this is deliberate, but
  it does mean these code paths cannot be tested or tuned from the harness.
- **Richer LOS** **[A]** — env-viewer's `botHasLineOfSight` (`:3164-3178`) marches tree/rock columns and
  terrain height; the harness raycasts bare `mapCollider`. Env-viewer's own comment says this fixed
  "bots saw and fired through hills."
- **Three-path nav architecture** **[A]** — static grid, incremental terrain-zone bake, and bounded
  local-window grids, against the harness's single static bake. Documented Phase D work, not drift.
  Agents 1 and 5 both concluded the downstream nav constant differences (crest span/far thresholds)
  all trace to this one architectural choice.

---

## 4. Contradictions between agents, resolved

**Disengage thresholds — every agent got this wrong, in two different ways.**
Agent 5 reported `0.60/0.72` vs `0.35/0.85` and ranked it the single biggest player-visible gap.
Agents 2 and 4 read the same area and called it identical. Both are wrong:

- `pursueHealthThreshold01` is **0.60 in both** (`bot-viewer-v2.html:7640`, `environment-viewer-v2.html:3585`) — identical, as agents 2 and 4 said. **[V]**
- The **heal** thresholds genuinely differ: `0.60/0.72` vs `0.35/0.85` (`:7658-7659` vs `:3613-3614`) — a real drift, which agent 5 found but attached to the wrong setting. **[V]**

So there is a real finding here, but it is a heal-behavior drift, not a disengage drift, and its
severity ranking should drop accordingly.

**Grenade evade hysteresis — agent 3 had the direction reversed.** It reported env-viewer as having
extra hysteresis the harness lacks. The opposite is true: the harness passes `actor.grenadeEvadeId`
at `:9291`, env-viewer passes three arguments at `:6125`. Agents 2, 4, and 5 had it right. **[V]**

**`bot-score.js` severity.** Moot — the premise was false (§1).

**`squadSlotWorld` severity.** Resolved in favour of agent 4: debug overlay only, because
`squadMemberGoal` calls it inside the shared module. **[V]** on the import absence, **[A]** on the
internal call path.

---

## 5. Confirmed at parity

Consistently reported identical, with matching call sites and constants, by four or five agents:
the FSM ladder (`chooseBotStateName` in `bot-activity.js`), FOV cone (150°, widen-only), target
re-scan stagger (`TARGET_SCAN_STRIDE=4`), target-selection risk scoring and stickiness, alert
escalation tiers, split attention and attention sweep, close-threat spin, `readyToFire` gating,
sidearm swap, role registry and assignment, squad election/succession, formation kinds and slot math,
the medic decision core, goal claims, danger cost, separation and pushout, A*/flood-fill, and region
labeling.

Note: `docs/subsystems/bots.md:2353-2357` documents target selection as "known drift." Agents 2 and 5
both found that note **stale** — the fix landed in `23da7d4`. The doc should be corrected.

---

## 6. Open, not resolved by this audit

- **Projectile hit-testing fork** **[?]** — `rayCapsuleHit` in the harness vs an entity-registry
  `blastDamageAt` path in env-viewer. Agent 5 flagged this as the biggest unresolved risk and
  explicitly declined to assert equivalence. Nobody traced it to a confirmed same-outcome result.
- **Baked-field LOS prefilter** (`USE_FIELD_LOS_PREFILTER`) **[A]** — reported present only in the
  harness. Not re-verified, and it is exactly the shape of claim §1 warns about. Re-check before acting.
- **Whether the numeric drifts are deliberate** — heal thresholds, knife timers, medic tuning, and the
  accuracy slider all need a decision from whoever owns balance, not another audit.

---

## 7. Recommended order of work

1. Re-run this audit against a **frozen ref** once the in-flight parity agent lands its work. Roughly a
   third of the findings here describe a file state that no longer exists.
2. Fix the four verified behavioral gaps that are not tooling: think-cadence throttle (#1), eye height
   (#2), medic contact creep (#3), grenade evade hysteresis (#4).
3. Get a balance decision on the numeric drifts in §2.
4. Reconcile the reverse-direction gaps in §3 — decide whether `trackStuck` should port *back* to the
   harness, since the harness is nominally authoritative.
5. Trace the projectile hit-testing fork (§6) to a confirmed equivalent outcome, or accept it as a
   deliberate two-path design and document it as such.
6. Correct the stale target-selection drift note in `docs/subsystems/bots.md:2353-2357`.

---

## Appendix: per-agent reliability, for calibrating the next swarm

| Agent | Errors | Notes |
|---|---|---|
| 1 | `bot-score.js` absent (false) | Strong on the command-wheel gap and the reverse-direction `trackStuck` finding. Finished last, never received the correction. |
| 2 | `bot-contacts.js`, `bot-score.js`, grenade self-veto (all false) | Most detailed report. Declined the first write instruction as a suspected injection — a defensible call, since it arrived via the background-notification channel. Self-corrected two of three on notification. |
| 3 | `bot-contacts.js`, `bot-score.js` (false); grenade hysteresis **reversed** | Caught the two `buildCornerMap` call sites nobody else examined. |
| 4 | `bot-contacts.js`, `bot-score.js`, grenade self-veto (all false) | Best "not a gap" section — independently resolved `squadSlotWorld` and `bot-separation.js` false alarms. Found the second error itself while fixing the first. |
| 5 | none identified | Only agent to notice the file was being edited mid-audit, and correct on all three §1 claims as a result. Its one significant error was misattributing the heal-threshold drift to disengage. |

The pattern worth carrying forward: the agent that questioned its own substrate was the accurate one,
and the majority was wrong on three of three headline absence claims. Where the swarm's value showed
up was not consensus but **disagreement** — every contradiction between agents pointed at something the
coordinator then had to verify, and each of those verifications changed the answer.
