# Bot voice line diversity + situational intensity plan (2026-08-03)

Follows `docs/sonnet-code-protocol.md`. Chapters correspond to the protocol's phases:
1 = Design, 2 = Scout (2 parts), 3 = initial plan (post-scout), 4 = Critique (2 parts),
5 = revised plan, 6 = implementation/debugging notes.

Related: `docs/subsystems/audio.md` §"Bot voices and squad chatter", §"Baked TTS voices".

## STATUS

- [x] Chapter 1 — design brief
- [x] Chapter 2 Part 1 — Scout: baked-TTS intensity feasibility (gates everything else)
- [x] Chapter 2 Part 2 — Scout: general/open-ended pass
- [x] Chapter 3 — initial plan
- [x] Chapter 4 — critique (2 parts)
- [x] Chapter 5 — revised plan
- [ ] Chapter 6 — implementation notes
- [x] Appendix A — dedicated line-authoring tool (scope addition, 2026-08-03)
- [x] Appendix B — per-voice lexicon revision (2026-08-03) — open item: synth scope
- [x] Appendix A/B implementation — `voice-line-studio.html` + `voice-bake-server.mjs` (2026-08-03)
- [ ] Browser QA (user gate)

---

## Chapter 1 — Design brief

### Starting point

Each of the bot voice system's 13 lineIds (`contact`, `firing`, `cover`, …) maps to exactly one
phrase, one rhythm, and — once baked — one recorded sentence per speaker. Two problems, raised in
sequence by the user:

1. **Wording never varies.** A bot always says the identical sentence for a given event.
2. **Delivery never matches the situation.** Lines need inflection variety (emphatic, whispered,
   calm, panicked), but the *right* inflection has to fit the moment — "someone whispering
   'grenade' in the middle of a heavy gunfight doesn't match." Existing systems already gauge
   combat intensity; the question is which ones are worth wiring into voice delivery.

This chapter is the second framing (intensity-matched delivery), which supersedes-by-extension the
first: wording variants still exist and still add texture, but variant *selection* is now driven by
a computed intensity target instead of pure rotation, with rotation demoted to a tiebreak among
variants that match the target equally well.

### 1. Existing systems that already gauge situational intensity

| Signal | Where | What it actually is |
|---|---|---|
| `alertEscalation(hits, me, now, radius)` → `{score, tier}` | `bot-alert.js` | Per-bot, radius-scoped read of a team's shared hit/death/contact ring. `score = hits + 2×deaths`, decaying. Maps to `calm/wary/defensive/push`. **Already computed every sentry tick and cached** on the bot's actor as `alertScore` / `alertTierLast` (`bot-viewer-v2.html:9127-9128`, `environment-viewer-v2.html:6074-6076`) — free to read, no new computation needed. |
| `latestSelfThreat` | `bot-alert.js` | "Am I personally being shot at right now." Queries the *same* hit ring `alertEscalation` already reads. Not independently cached today — held as a per-tick local, partly folded into `spinLatched`/`lastSelfThreatXZ`. |
| HP fraction / `healthBand` | bot health state, quantized in `bot-state-code.js` | Already tracked per bot for the HUD and heal-retreat logic. |
| `botHitTier` / `severity01` | `bot-damage-audio.js` | Per-*hit* transient intensity, drives the mechanical damage-loop synth. Wrong shape for this — a one-shot event score for a different audio track, not sustained bot state. |
| `AUDIO_PRIORITY` / `LINE_PRIORITY` / `AMBIENT_LINES` | `combat-audio-budget.js`, `bot-voice-director.js` | Not an intensity gauge — a static per-line-*type* rank (grenade_warn=100 … overwatch=30) deciding who gets to speak. Relevant as a *floor*, not a source. |
| Multi-threat contact model (risk-scored targets, threat-to-support ratio) | Documented in `docs/subsystems/bots.md`, **not built** | Not usable without building new scope well beyond this feature. |

### 2. Which to connect

**`alertScore`/`alertTierLast`, read as-is from the actor.** Per-bot, personally weighted (a bot
getting shot registers at ~zero distance from itself, so it should dominate its own local score —
flagged in Chapter 2 Part 1 to verify against `recordAllyHit`, not asserted from memory), and
**free**: both viewers already compute and cache it every sentry tick, before `sayBotLine` ever
runs. No new per-frame cost.

Not proposing a separate `latestSelfThreat` read on top of it — that would re-query the same ring a
second time for information the escalation score substantially already contains.

HP fraction is proposed as a secondary modifier (a badly wounded bot sounds more strained even
mid-lull) — an addition beyond what was asked, flagged rather than decided.

### 3. How verbal intensity fits lines to scenarios

Each variant of a line gets a tag, `intensity: 0..1`, alongside its `text`/`contour`/`drive`/
`syllables`. At speak-time: `alertScore` (+ optionally HP) resolves to a target `voiceIntensity01`,
and the variant whose tag is *closest* to that target is selected — nearest-match, not exact
buckets, so a line with only "calm" and "urgent" tags still degrades sensibly across the full range.

Composes with wording diversity rather than replacing it: intensity narrows to the eligible
variant(s) first, then round-robin (peek/commit, from the prior design pass) breaks ties among
same-band variants so wording still varies.

The whisper-during-a-firefight case becomes a **floor**, not a ban: lines at alert rank
(`budgetPriorityFor(lineId) === AUDIO_PRIORITY.voiceAlert`, already exported, reused as-is) get a
minimum intensity regardless of situational read, because the information itself is time-critical.
Ambient lines (`AMBIENT_LINES`) get the full range including near-whisper, since those are flavor
and should go quiet in lulls.

Asymmetry to note: for the **synth** voice, intensity can modulate `drive`/`contour` continuously
even between authored variants — no new signal-chain code, `buildVoiceLine` already reads
`line.drive`/`line.contour` per line; this just moves those to per-*variant* scope. For **baked
TTS**, delivery is fixed at record time — intensity selection can only be as fine-grained as what
was actually baked, and whether the TTS engines can produce a recognizably different whisper vs.
shout from the same wording via API parameters (rather than needing different wording per band) is
unverified. This is the Chapter 2 Part 1 scout question.

### 4. New code, and why it can't just live in an existing file

**One new file: `bot-voice-intensity.js`.** Its only job: `voiceIntensity01({ alertScore, alertTier,
hpFraction, lineId })` — pure arithmetic, no THREE, no DOM, Node-testable, same purity constraint
every voice-layer file already holds itself to.

Why not fold it into one of the three files that already touch this data:

- **Not `bot-alert.js`.** Owns AI *perception*, consumed by non-audio FSM code, knows nothing about
  `LINE_PRIORITY`/`AMBIENT_LINES`. Teaching it about voice-line classification leaks an audio-domain
  concept into a file whose only job is "what does this bot perceive."
- **Not `bot-voice-director.js`.** Its own docblock states its scope: arbitration — *who* speaks,
  rate limits, cooldowns, budget preemption — over inputs the *caller* already resolved (`lineId`,
  `distance`, `durationS`). It doesn't reach into bot combat state itself today, on purpose. The new
  module actually *depends on* two of its exports (`AUDIO_PRIORITY`, `budgetPriorityFor`) for the
  alert-floor logic — it can't be the same file as the thing it needs to import from.
- **Not `bot-voice.js`.** Docblock is explicit: "Pure WebAudio... no THREE, no DOM," deliberately
  dependency-free of gameplay/AI modules. Reading `alertScore` off a bot actor breaks that boundary.
  (Variant *selection* logic — nearest-intensity-match, then round-robin tiebreak — does belong
  there, extending the `lineVariants`/`peekVariantIndex` design already planned. Not a new file.)

The new file sits at the seam between three already-separated concerns (perception, arbitration,
synthesis) — the same reason `bot-voice-director.js` is its own file instead of folded into
`bot-voice.js`, and the same reason `bot-damage-audio.js` is its own file instead of living in
`bot-activity.js` or `environment-audio.js`. It takes a small plain-object input (mirroring how
`botVoiceDirector.request()` already takes a descriptor rather than reaching into viewer internals)
that each viewer's `sayBotLine` assembles from its own actor shape — so the module stays
viewer-agnostic and Node-testable, and isn't duplicated between the two ~13k-line viewer files.

Everything else is extension, not new files: `bot-voice.js` gains intensity-aware variant selection,
`bake-voices.mjs`/`bot-voice-bank.js` need the intensity tag carried through variant filenames,
`bot-voice-director.js` needs zero changes (exports reused, not modified).

### Open items carried into Chapter 2

- Whether self-hits land at ~zero distance in the escalation ring (confirms `alertScore` is truly
  self-weighted, not just area-weighted).
- Whether ElevenLabs / Kokoro can actually produce distinguishable whisper-vs-emphatic deliveries
  via API parameters alone, or whether each intensity band needs distinct wording baked separately.
  **Gates the rest of the design** — if baked TTS can't express delivery variation at all, intensity
  selection may need to be synth-only, with baked TTS falling back to wording-only diversity.
- Whether `alertScore`/`alertTierLast` can ever be stale relative to a `sayBotLine` call firing off
  the sentry cadence.
- HP fraction as a secondary modifier: worth the added complexity, or defer.

---

## Chapter 2 — Scout

### Part 1 — Baked-TTS intensity feasibility (haiku, Explore, web-verified)

Ran first, standalone, because the answer reshapes the rest of the design rather than just
confirming or denying one claim from Chapter 1.

**Verdict: same wording, different delivery via API parameters alone does not work on either engine
wired into this repo.** Different WORDING per intensity band is required — content authoring, not
an API capability.

- **ElevenLabs v2** (`eleven_multilingual_v2`, currently wired — see `bake-voices.mjs`'s
  `ELEVEN_MODEL`). `stability: 0.4` and `style: 0.35` (current `ELEVEN_SETTINGS`) give subtle
  variation, not a reliable calm-vs-panicked contrast. The bake script's own comment — "Low
  stability buys urgency" — already reads as an acknowledgment this is a weak lever, not a real
  delivery control.
- **ElevenLabs v3** (released 2026-02) supports inline bracket direction — `[whispering]`,
  `[shouting]`, `[panicked]` — but *still* needs different text per band; the tags sit inside text
  that already differs. Would require changing `ELEVEN_MODEL` to a v3 id, at roughly 1.5–2x cost per
  call. Scout sourced this from third-party writeups (elevenlabsmagazine.com, z.tools), not
  ElevenLabs' own primary docs — treat the exact tag syntax and cost multiplier as directionally
  right, not verified to the letter, until checked against ElevenLabs' own reference before Begin.
- **Kokoro** exposes voice selection only (`tts.generate(text, {voice})`, confirmed against the
  actual bake-script call) — no emotion/stability/style parameter exists at all. Wording is the
  *only* lever available for this engine, full stop.

**What this changes, not invalidates.** Chapter 1's variant shape already had each variant carrying
its own `text` (the wording-diversity axis from the prior design pass) alongside an `intensity` tag
— it never assumed the TTS *engine* would render one wording at multiple deliveries. So this finding
doesn't break the architecture; it resolves *how* a baked variant's intensity is achieved: authored
wording carries it (e.g. "contact" vs. "hostile contact, multiple targets, watch your flanks"), not
an engine parameter. The synth voice keeps its separate, continuous `drive`/`contour` modulation
per variant, which is unaffected by any of this.

**Practical path — corrected.** The scout's original lean toward staying on v2 was wrong, and the
user caught it directly: v2 was recommended mainly because it costs less and needs no model change,
but the actual ask was inflection — "some are more emphatic, some are whispers" — which is a
delivery question, not a wording question. **v3 is the one of the two that does what was asked**;
v2's "wording implies tone" is a weaker, less controllable proxy for the same goal, not an equally
valid alternative. Cost (~1.5–2x per call) is the user's tradeoff to accept, not the scout's or
mine to avoid on their behalf. The scout's framing of v3 as "still needs different text per band"
also deserves a second look before Begin: an inline tag (`[whispering] Grenade, incoming.` vs.
`[shouting] GRENADE!`) is inserted into the text, but the underlying wording can stay close to
identical between bands with only the tag (and minor punctuation) differing — closer to genuine
same-wording-different-delivery than the scout's conclusion suggested. **Decision: bake variants on
v3 with inline delivery tags**, treating the "does v3 actually ship a distinct model id and support
this via the current REST call shape" question as a concrete Chapter 2 Part 2 / pre-Begin check
(the scout's v3 details were sourced from third-party writeups, not ElevenLabs' own reference —
still true, still needs a primary-source check before `bake-voices.mjs`'s `ELEVEN_MODEL` actually
changes).

### Part 2 — General pass (haiku, Explore, direct code read)

Confidence marked per claim, as instructed.

- **A bot's own hit registers at ~zero distance from itself — VERIFIED.** `recordAllyHit`
  (`bot-viewer-v2.html:4913-4923`) writes the report at the *victim's* own position. Chapter 1's
  assumption that `alertScore` is already self-weighted, without a separate `latestSelfThreat`
  query, holds.
- **`alertScore`/`alertTierLast` staleness — CONFIRMED, and worse than "at most one tick."** Frame
  order in `bot-viewer-v2.html`: `updateAllBots()` (computes + caches `alertScore`/`alertTierLast`
  per bot, ~line 9080-9128) runs, **then** `updateBullets()`/`updateProjectiles()` run, which call
  `applyBotDamage()` → `recordAllyHit()` (~line 5427), and death-triggered lines
  (`sayBestBotLine(..., 'man_down', ...)`, `'enemy_down'`) fire from that *same later* pass. **The
  event that triggers the line has not yet been folded into the `alertScore` that line reads.**
  Affected: `man_down`, `grenade_warn`, `enemy_down`, `grenade_out`, `sidearm`, `reloading`,
  `contact` — all event-triggered from outside `updateBotSentry`. Unaffected (read within the same
  sentry tick that just computed them): `firing`, `cover`, `moving`, `overwatch`, `reviving`,
  `no_ammo`, driven from `updateBotVoiceState` inside `updateBotSentry` itself (~line 9323). This is
  a real hole in Chapter 1's "free, no new cost, at most one tick stale" claim — it's not staleness
  in general, it's specifically blind to the triggering event for exactly the lines (`contact`,
  `man_down`, `grenade_warn`) where getting the intensity right matters most.
- **`LINE_PRIORITY`/`AMBIENT_LINES` coverage — VERIFIED.** All 13 lineIds are in `LINE_PRIORITY`;
  the four ambient ones are in `AMBIENT_LINES`; `linePriority()` defaults to 10 for anything
  missing, so there's no undefined-floor case today (and won't be one for the 13 shipped lines).
- **Silent-variant-skip risk (the `knownLine` failure mode repeating) — PROBABLE, implementation-
  dependent.** If a variant's `intensity` tag lives in a new nested shape a picker function doesn't
  positively check for, a studio-added variant could look fine in the editor and be silently
  ignored at runtime — precisely the bug `knownLine()` was patched for last session. Not yet a
  concrete finding since the picker doesn't exist yet; it's a warning about *how* to write it: reuse
  a positive-membership check (does this variant have the fields the picker needs), not a
  frozen-table lookup a runtime addition could fall outside of.
- **Design gaps flagged, not yet resolved:** no concrete floor value/formula for alert-priority
  lines was specified in Chapter 1 (just "gets a minimum"); no minimum/target variant count per line
  was specified, so authoring could ship uneven coverage (some lines with 3 intensity bands, others
  with 1) and the "nearest match" picker's behavior at sparse coverage was described qualitatively,
  not with an actual selection rule.

---

## Chapter 3 — Initial plan

Turns Chapter 1's narrative into concrete data shapes, function signatures, and numbers, resolving
Chapter 2's open items with explicit decisions. This is what Chapter 4 critiques.

### Data shape

`VOICE_LINES[id].variants` (and its `SOUND_PARAMS.voiceLines[id].variants` override mirror):
`{ text, contour?, drive?, syllables?, intensity }`. `intensity` is **required** on authored
variants (0..1). The existing top-level `text`/`contour`/`drive`/`syllables` fields remain variant
0 and get an implicit `intensity: 0.5` (neutral) — this is what keeps every line that never gets a
second variant behaving exactly as today: one variant, always nearest-match regardless of target,
zero visible change until a second variant is authored. Purely additive (checklist #6).

### Resolving the staleness finding

Two paths, split by how each line already fires, not a blanket rule:

- **Sentry-cadence lines** (`firing`, `cover`, `moving`, `overwatch`, `reviving`, `no_ammo` — driven
  from `updateBotVoiceState` inside `updateBotSentry`): read the already-cached `alertTierLast` off
  the actor. Free, and — per Chapter 2 Part 2 — genuinely fresh for these, since they fire from the
  same tick that just computed it.
- **Event-triggered lines** (`man_down`, `grenade_warn`, `enemy_down`, `grenade_out`, `sidearm`,
  `reloading`, `contact` — fired from bullet/projectile/death handling that runs after
  `updateAllBots()`): call `alertEscalation()` **fresh** at the moment of the request instead of
  reading the stale cached field. This directly fixes the "blind to the triggering event" hole for
  exactly the lines — `contact`, `man_down`, `grenade_warn` — where that matters most. Cost is
  bounded by how often these lines are even eligible to speak, which the director's existing
  per-line cooldowns already throttle to roughly 1 per 0.9-5 s per team; not a per-frame, per-bot
  cost. Applying this uniformly to all seven (rather than special-casing which ones "deserve"
  freshness) avoids an arbitrary-feeling split — `alertEscalation` is already imported in both
  viewer files, so this is a one-line call-site change, not new plumbing.

### Tier→intensity mapping, not raw score

`alertEscalation`'s raw `score` (`hits + 2×deaths`, unbounded, decaying) is not what feeds the
picker — the already-computed, already-tested discrete tier (`null/calm`, `wary`, `defensive`,
`push`) is, via a small fixed table. Reusing the tier ladder the cover/hold system already commits
to (rather than inventing a second continuous normalization curve over the same underlying score)
means no new curve-fitting decision, and the 4 anchors comfortably cover a 2-3-variant-per-line
authoring reality without needing finer resolution than that. Proposed anchors, living in a new
small `SOUND_PARAMS.voiceIntensity` schema section (tunable in the studio like every other authored
number in this codebase, not hardcoded):

`calm/null: 0.1`, `wary: 0.4`, `defensive: 0.7`, `push: 1.0`.

**Alert-line floor**: for any line where `budgetPriorityFor(lineId) === AUDIO_PRIORITY.voiceAlert`
(imported from `combat-audio-budget.js` / `bot-voice-director.js`, reused as-is), clamp the target
up to `SOUND_PARAMS.voiceIntensity.alertFloor` (proposed default **0.7**) before picking a variant —
high enough that a calm-tagged variant is never eligible for these, low enough that alert lines
still distinguish moderate from maximal carnage when authored with variants above the floor.

### Variant selection

New function in `bot-voice.js` (extends its existing `lineVariants`/rotation design, not a new
file): compute `|variant.intensity - target|` for every variant of the line, take the minimum
distance, collect every variant within `SOUND_PARAMS.voiceIntensity.tieEpsilon` (proposed **0.05**)
of that minimum, then round-robin (the existing peek/commit machinery) **within that subset only**,
not the full variant list. A line with one variant always resolves to it, trivially. A line with
variants at `[0.1, 0.6, 0.9]` targeting `0.7` picks `0.6` deterministically (only one variant in the
tie set); a line with `[0.6, 0.65]` targeting `0.7` round-robins between both (both within epsilon).

### New module: `bot-voice-intensity.js`

One exported function, matching the "reuse a positive-membership check, not a frozen-table lookup"
lesson from the `knownLine()` incident (Chapter 2 Part 2's silent-failure warning):

`resolveVoiceIntensity({ lineId, alertTier, freshEscalationFn }) → number (0..1)`

- Looks up the tier→intensity anchor for `alertTier` (sentry-cadence callers pass the cached tier
  directly; event-triggered callers pass `freshEscalationFn` — a zero-arg thunk the call site
  closes over its own `alertEscalation(...)` call with — so the module itself never reaches into
  viewer internals, mirroring how `botVoiceDirector.request()` takes a plain descriptor rather than
  live objects).
- Applies the alert-line floor via `budgetPriorityFor(lineId)`.
- Pure, no THREE, no DOM, Node-testable — same constraint every voice-layer file holds itself to.

Deliberately NOT importing HP/`healthBand` in this initial plan. It was flagged as an addition
beyond what was asked; keeping the first pass scoped to the signal actually requested (alert tier)
keeps this plan reviewable and reversible. Noted as a clearly-labeled future extension point, not
built now.

### Bake / manifest / bank

Unchanged from the wording-diversity pass's plan, with one rule made explicit given intensity now
rides on variant *order*: **variants are append-only.** `${lineId}` = index 0, `${lineId}__v1` =
index 1, etc.; deleting or reordering a middle variant desyncs already-baked filenames from their
new index across every speaker in every set. The studio's variant-delete action must warn about
this (extending the existing REVERT/DELETE LINE guard pattern) rather than silently allowing it.

### Tests

- `test-bot-voice.mjs`: pooled `MIN_RHYTHM_DISTANCE` check across all variants of all lines (from
  the wording-diversity pass); base-variant default-intensity (0.5) regression; variant-picker
  nearest-match + tie round-robin, mutation-tested; alert-line floor never bypassed even when the
  computed target is below it.
- New `test-bot-voice-intensity.mjs`: tier→intensity anchor table; floor clamping; the
  `freshEscalationFn` vs. cached-tier split resolves correctly for a sample of sentry-cadence vs.
  event-triggered lineIds (this is the one place a Node test can actually cover the staleness fix,
  since it doesn't depend on either viewer's frame loop — just that the right argument shape reaches
  `resolveVoiceIntensity`).

### Docs / log

`docs/subsystems/audio.md` "Bot voices" section gains the variant/intensity data shape, the
tier-anchor table, and the sentry-cadence-vs-event-triggered split with the reasoning from Chapter 2
Part 2 (so a future reader doesn't have to rediscover the staleness issue from scratch). One
`agent_log.csv` row per logical change at Begin time, per `CLAUDE.md`.

### Snapshot list for Begin

`bot-voice.js`, `bot-voice-director.js` (read-only export reuse, but touched if `budgetPriorityFor`
needs re-exporting), `bake-voices.mjs`, `bot-voice-bank.js`, `sound-params.js`, `sound-studio.html`,
`bot-viewer-v2.html`, `environment-viewer-v2.html`, `test-bot-voice.mjs`, `test-bot-voice-bank.mjs`,
plus the new `bot-voice-intensity.js` and `test-bot-voice-intensity.mjs` (new files, nothing to
snapshot).

---

## Chapter 4 — Critique

Two independent haiku/Explore agents, identical brief (the full Chapter 1-3 design), dispatched in
parallel, asked to find weaknesses rather than validate. Findings recorded as delivered; resolved
in Chapter 5.

### Part A

1. **Misclassification of event-triggered vs. sentry-cadence lines (critical).** Disputes the
   Chapter 3 claim that `contact` and `grenade_warn` need the fresh-`alertEscalation` fix: both are
   called from inside `updateBotSentry` itself (`sayBotContact` at line 8926, `updateGrenadeEvade`
   at line 9336), not from an external event handler — undermining the 7-line list.
2. **`freshEscalationFn` scope threading underspecified (high).** Event handlers like `onBotDied`
   may not have `recentAllyHits` in scope; "one-line change" may understate real plumbing cost.
3. **Test coverage can't verify the frame-order fix (medium).** A Node test on
   `resolveVoiceIntensity`'s call signature proves the function is correct given its inputs, not
   that the viewer actually wires the right inputs at the right time.
4. **Variant silence risk still open (medium).** "Positive-membership check" was named but never
   made concrete — what field, checked how, what happens on failure.
5. **Tier table not forward-compatible (low).** A future fifth alert tier needs a new anchor; not a
   blocker since it's studio-tunable, but unstated.
6. **man_down/enemy_down staleness may be semantically fine as-is (low).** "I was at tier X when the
   squad went down" is arguably coherent even one tick stale — question whether the fix is worth it.
7. **Multiplayer replication unaddressed (low).** Doesn't state whether variant choice needs to be
   replicated, or is assumed independently computed per client.

### Part B

1. **Module signature dangerously underspecified (critical).** Unclear whether
   `resolveVoiceIntensity` receives a tier or a raw score from `freshEscalationFn`, and whether
   score→tier conversion lives in the module (breaking its stated purity) or is duplicated at each
   caller (duplicating `updateBotSentry`'s existing ladder).
2. **Append-only variant rule is "structural theatre," not enforcement (high).** A studio warning
   doesn't prevent a deleted/reordered variant from desyncing baked filenames; suggests validating
   variant indices against the manifest at pick time instead of relying on author discipline.
3. **Tier anchor spacing (0.1/0.4/0.7/1.0) and 0.7 floor asserted without justification (medium).**
   Why non-linear, why those specific numbers.
4. **Bake-script variant loop underspecified (medium).** Plan states the naming convention but not
   the actual loop change, or how the manifest tracks variant indices.
5. **Score→tier duplication risk (medium).** Same underlying issue as Part A's #2, framed as
   duplication risk rather than a scope-access risk.
6. **Fresh-call cost/benefit not argued (low).** ~64-entry ring scan per call — plan should state
   why paying it is worth it rather than accepting one tick of staleness.
7. **Test plan doesn't cover out-of-bounds/phantom variant index (low).** What happens when a
   variant index has no corresponding baked file or array entry.

### Resolving the Part A / Part B disagreement (direct verification, not another agent's word)

Part A's finding #1 is a direct, load-bearing contradiction of Chapter 2 Part 2's own claim, so it
was checked directly against the file rather than accepted from either source:

- `updateBotSentry(dt, now)` (`bot-viewer-v2.html:8873`) is one function spanning past line 9336,
  confirmed by there being no intervening `function` declaration between 8873 and the next one after
  9336. Both `sayBotContact` (8926) and `updateGrenadeEvade` (9336) execute inside it, as Part A
  says — but **inside the same function is not the same as after the alert computation**, and that's
  what actually determines freshness:
  - `sayBotContact` at **8926** runs *before* `alertEscalation` is called (9080) and before
    `alertScore`/`alertTierLast` are written (9127-9128) — **contact still reads last tick's cached
    value**, contradicting Part A's specific claim (though its broader point — that not everything
    on Chapter 3's list was actually stale — was right about the *other* line).
  - `updateGrenadeEvade` at **9336** runs *after* the same write — **grenade_warn is genuinely
    fresh**, exactly as Part A found. Chapter 3 had this one wrong.
  - Net correction: the fresh-call fix is needed for **6 lines, not 7** — `contact`, `man_down`,
    `enemy_down`, `grenade_out`, `sidearm`, `reloading`. `grenade_warn` moves into the
    already-fresh group alongside `firing`/`cover`/`moving`/`overwatch`/`reviving`/`no_ammo`.
- Part A's finding #2 (scope threading) doesn't hold: `recentAllyHits` is declared
  `const recentAllyHits = []` at **module scope** (`bot-viewer-v2.html:4908`), not local to
  `updateAllBots`/`updateBotSentry`. Any function in the file, including event handlers, can read it
  directly. The "one-line call-site change" claim in Chapter 3 stands.

### Mid-critique correction: TTS engine choice

The user directly rejected the Chapter 2 Part 1 recommendation to stay on ElevenLabs v2 — the
inflection ask was the actual point of this whole feature, and v2 doesn't deliver it; v3 does, cost
notwithstanding. See the correction inline in Chapter 2 Part 1. Carried into this chapter's decision
list below.

---

## Chapter 5 — Revised plan

Resolves every Chapter 4 finding. Per the protocol's dispatch rule, resolved directly rather than
bounced back as open questions, except where a finding is a genuine product call rather than an
engineering one (flagged explicitly below).

### 1. Line classification — corrected

Fresh-`alertEscalation`-call group (6, not 7): `contact`, `man_down`, `enemy_down`, `grenade_out`,
`sidearm`, `reloading`. Cached-read group (7): `firing`, `cover`, `moving`, `overwatch`, `reviving`,
`no_ammo`, and **`grenade_warn`** (moved here from Chapter 3's list — verified genuinely fresh).

On Part A's #6 (is man_down/enemy_down staleness "fine as-is," skip the fix?) — declining. The fix
is confirmed cheap (below), so there's no real cost/benefit tension to resolve in staleness's favor;
paying a bounded cost to be more correct on exactly the lines where correctness matters most is the
better default.

### 2. Module signature — resolved, simplified from Chapter 3

`resolveVoiceIntensity({ lineId, alertTier })` — **only** ever receives a resolved tier string, never
a raw score or a thunk. This directly answers Critique B's #1 and #5 and Part A's #2: the module
stays genuinely pure and doesn't need to know `alertEscalation` exists at all.

Score→tier conversion is extracted from `updateBotSentry`'s existing inline ladder
(`bot-viewer-v2.html:~9082-9096`) into one shared, exported `tierForScore(score)` in `bot-alert.js`
— the file that already owns tier semantics. Both the existing sentry-tick code and the new
fresh-call sites call the same function, so there's exactly one implementation of the score-to-tier
ladder in the codebase, not two that can drift. Each of the 6 event-triggered call sites becomes:
`resolveVoiceIntensity({ lineId, alertTier: tierForScore(alertEscalation(recentAllyHits, meXZ, now, ESCALATION_RADIUS).score) })`.

### 3. Tier anchors and alert floor — de-asserted, marked provisional

Critique B is right that the original 0.1/0.4/0.7/1.0 spacing had no real justification behind it —
it read as deliberate but wasn't. Revised: **evenly spaced by default** —
`calm/null: 0.0, wary: 0.33, defensive: 0.67, push: 1.0` — with the floor at `defensive`'s anchor
(0.67, not the earlier 0.7) so the floor is *derived from* the tier table rather than a second
independently-chosen number. All of it lives in `SOUND_PARAMS.voiceIntensity`, explicitly labeled in
the schema note as a starting point to retune once variants are baked and actually heard — this
was already the honest framing for the TTS wording question in Chapter 2 Part 1; the same honesty
applies here instead of false precision.

### 4. Variant validation — made concrete (Part A #4, Critique B #7)

A candidate variant must satisfy `Number.isFinite(variant.intensity) && variant.intensity >= 0 &&
variant.intensity <= 1`; anything that fails is excluded from the picker's candidate pool for that
call, not treated as an error. Variant 0 (the base) always has a valid default (`0.5`) precisely so
the candidate pool is never empty — worst case, every authored variant fails validation and
selection degrades to "always speak the base," which is exactly today's behavior. Same rule closes
Critique B's #7 (out-of-bounds/phantom index): `bot-voice.js`'s array-index lookup clamps to 0 on an
out-of-range index, and `bot-voice-bank.js`'s existing fetch-fallback (missing baked file → 404 →
fall back to variant 0, shipped last session) already covers the baked-audio side of the same
failure mode. Two different mechanisms, same outcome, both already partially existing.

### 5. Append-only variant rule — reframed (Critique B #2)

Not withdrawn, but demoted from "the safety mechanism" to "an authoring courtesy that avoids wasting
bake credits and confusing gaps." The actual safety net is #4 above, which already existed for the
baked path from last session's design (fall back to variant 0 on a missing file) — that's what
actually prevents breakage, not studio discipline. The studio warning stays (cheap, still worth
having), but Chapter 3's framing overstated what it was protecting against.

### 6. Bake-script loop — made concrete (Critique B #4)

`bake-voices.mjs`'s existing `for (const lineId of lineIds())` loop gains an inner loop over
`lineVariants(lineId)`: index 0 writes to today's existing filename (`${lineId}.ext`, unchanged, so
already-baked sets stay valid with zero variants authored); index *i* > 0 writes to
`${lineId}__v${i}.ext`, texted from that variant's `.text`. `writeManifest()`'s existing membership
filter needs the `__v\d+` suffix stripped before checking `lineIds()` membership — a one-line change
to an existing filter, not new logic.

### 7. TTS engine — v3, per the user's correction

Bake on ElevenLabs v3 with inline delivery tags, not v2. Before this reaches Begin: verify against
ElevenLabs' own reference docs (not the third-party sources the scout used) the actual v3 model id,
whether it's reachable through the same REST endpoint shape `bake-voices.mjs` already calls, and
real per-call cost — all three are still only scout-sourced, not confirmed. This is the one
remaining pre-Begin verification step, flagged rather than resolved here since it needs a live check
against ElevenLabs' current docs, not a decision I can make from the repo alone.

### 8. Multiplayer replication — explicitly out of scope, not a new gap

`docs/subsystems/audio.md`'s existing "Known gaps" already states bot chatter has no multiplayer
replication at all (bot sim is host/solo-only, no FSM state crosses the wire). Variant/intensity
selection inherits that exact limitation — it's not a new gap this feature introduces, so it doesn't
need its own resolution here. Worth one line in the audio.md update at Begin time noting variant
choice would need the same replication work as every other piece of bot voice state, not a
feature-specific problem.

### 9. Test plan — scoped honestly (Part A #3)

Conceding Part A's point directly: a Node test on `resolveVoiceIntensity` and `tierForScore` proves
those pure functions are correct given their inputs — it cannot prove the viewer's frame loop
actually delivers the right inputs at the right time. `test-bot-voice-intensity.mjs` covers the
former (tier table, floor clamping, variant validation/fallback, out-of-bounds clamp) and says so
explicitly in its header comment rather than implying more coverage than it has. The frame-order fix
itself (are `contact`/`man_down`/etc. actually calling `tierForScore(alertEscalation(...))` fresh,
at the right call sites) is a code-review-time check at Begin, confirmed by the line numbers in this
chapter, not something either the existing or new test suite can exercise.

### Net changes from Chapter 3

Corrected: line classification (6 not 7, grenade_warn moved), module signature (no thunk, tier-only
input, shared `tierForScore`), tier anchors (evenly spaced, explicitly provisional), TTS engine
(v3 not v2). Made concrete: variant validation rule, bake-script loop shape, out-of-bounds handling.
Reframed: append-only rule now explicitly secondary to the existing fallback mechanism. Deferred, not
resolved: the v3 primary-source verification (flagged for Begin), HP as a secondary intensity input
(still out of scope, unchanged from Chapter 3).

---

## Appendix A — Dedicated line-authoring tool

Not a protocol-phase chapter — a scoped-down design pass, proportionate to what was asked, not
another full scout/critique cycle. Chapter 5's plan assumed variant/intensity authoring would extend
`sound-studio.html`'s LEXICON tab. The user rejected that: that file is 1848 lines across 6 tabs
(`bench`, `lexicon`, `mix`, `triggers`, `sources`, `export` — confirmed by reading it directly,
1683-1684) doing five genuinely different jobs in one place — low-level DSP tuning (formant/vocoder/
radio-channel sliders), line-content authoring, director-arbitration rate-limit simulation, baked-
take auditioning, and JSON export. The ask is specifically the second job, cleanly separable from
the other four.

### Scope: a new standalone tool, not an extension

New file (name TBD at Begin, e.g. `voice-line-studio.html`), following this repo's existing
convention of one focused HTML tool per concern (`bot-design-studio.html`, `weapon-viewer-v2.html`,
`sfx-browser.html`, `sound-studio.html` itself). Four jobs, matching the user's list exactly:

1. **Write lines** — pick an event (lineId, including creating a new one — ports the existing ADD
   LINE flow), author variant text.
2. **Assign to voices** — for baked TTS, choose which engine voices this variant bakes for. *Working
   assumption, not yet confirmed*: today's `bake-voices.mjs` bakes every line for every voice in a
   set unconditionally; this adds the ability to narrow a specific variant to a curated subset (e.g.
   a "panicked" variant only makes sense baked for voices whose delivery actually reads that way).
   If "assign to voices" instead meant something else — e.g. just auditioning a line against
   different voices before picking one — say so and this narrows.
3. **Configurations: tone/emotion** — the `intensity` tag from Chapter 5, presented as a labeled
   preset (calm/wary/defensive/urgent, matching the same tier-anchor table, not a raw 0..1 float)
   plus, if targeting v3, the inline delivery tag (`[whispering]`, `[shouting]`, …) as a dropdown
   that inserts into the baked text automatically rather than requiring hand-typed bracket syntax.
4. **Assign to events** — bind the variant to its lineId. Same operation as #1's event picker.

### Explicitly not in the new tool

DSP tuning (formant Q, vocoder bands, radio channel), arbitration/rate-limit simulation, and raw
JSON export UI all stay in `sound-studio.html` — those are sound-engineering concerns, not
line-writing ones, and moving them would just relocate the bloat rather than remove it.

### Data model: no new persistence

Writes to the exact same `SOUND_PARAMS.voiceLines[id].variants[]` shape Chapter 5 already defined
(`{text, contour?, drive?, syllables?, intensity}`), via the same `setMapOverride`/`exportParams`
functions in `sound-params.js`, into the same `sound-params.json` document `bake-voices.mjs` and
both viewers already read. This is a new frontend on the existing backend, not a fork of it — none
of the runtime files from Chapters 1-5 (`bot-voice.js`, `bot-voice-intensity.js`, `bake-voices.mjs`,
`bot-voice-bank.js`) need to change beyond what Chapter 5 already planned.

`contour`/`drive`/`syllables` are auto-seeded (the shared `seedSyllables`, per Chapter 3) rather than
exposed for hand-editing in the default flow — that's precisely the kind of control that made
LEXICON feel bloated. Hand-tuning a variant's rhythm stays possible in `sound-studio.html` for
whoever wants it, it's just not what this tool shows by default. The new tool's primary surface is
close to: event dropdown → text box → voice checkboxes → tone preset → save.

Baking stays a Node script, unchanged — the new tool authors data, it doesn't call ElevenLabs/Kokoro
directly (same reason as always: the API key must never reach the browser). It can still show bake
status per variant (reusing `manifest.json` the same way the SOURCES tab already does) and surface
the exact bake command to run.

---

## Appendix B — Per-voice lexicon (correction, 2026-08-03)

Corrects Appendix A and the variant data model from Chapters 1-5: **lines belong to a voice, not to
a shared lexicon every voice performs identically.** A bot is assigned a named voice (e.g. "John");
that voice owns its own text for each event, and those lines carry the tone/emotion (intensity)
variants from Chapter 5. Not a UI-only change — the authoring data model was wrong, not just the
tool that edits it. **Scope: ElevenLabs voices specifically** (confirmed below) — Kokoro and the
synth stay on the shared/default lexicon, unaffected by this appendix.

### What doesn't change

The file/manifest layer, built two sessions ago, already supports this without touching a line of
code: `bot-voice-bank.js` stores takes keyed by `(set, lineId)`, where `set` is already a specific
named voice — `eleven/harry`, `kokoro/af_heart`, etc. — and each set's `lines` array was already
independent per set (a set missing a line was already tolerated, falling back to the synth). The
"voice, like John" the user described isn't a new concept to invent — it's the existing `set`
identifier the bank and manifest already use. No new namespace needed.

### What changes

`SOUND_PARAMS.voiceLines` goes from `{ lineId: { variants } }` (one lexicon, every voice performs
it identically) to `{ voiceId: { lineId: { variants } } }` — keyed by the same `set` string
`bot-voice-bank.setFor(botId)` already resolves to. `bake-voices.mjs`'s per-(voice, lineId) loop
reads that voice's own variants instead of one shared `lineText(lineId)` for every voice; today's
behavior (every voice reading identical wording) was actually a limitation of the bake script, not
an intentional design point.

**Fallback chain, so a voice with partial content still works**: a voice with no authored lines for
a given event falls back to the shared/default lexicon (today's `VOICE_LINES[lineId]`, unchanged) —
same pattern the existing `voiceLine()` override-then-default resolution already uses, just with one
more level. This matters in practice: adding a new voice shouldn't require writing all 13 events
before it can speak at all.

### Resolved: scope is ElevenLabs voice assignment specifically

Confirmed with the user directly. "Voice, like John" **is** the existing engine/voice identifier —
no separate display-name mapping layer needed, because this work targets ElevenLabs specifically,
where the voice ids already read as human names (`harry`, `sarah`, `alice`, ...). The concern raised
above about Kokoro's non-human-friendly slugs (`af_heart`, `am_fenrir`) doesn't apply because Kokoro
isn't in scope for the per-voice lexicon work right now — it stays on the shared/default lexicon,
same as the synth, until/unless revisited separately.

**Synth is confirmed out of scope, but not for the reason guessed above.** The user's own framing:
a synth bot could eventually get an analogous "synth voice id" — a named, unique bundle of synth
parameters (pitch/formant/rate/buzz) assigned per bot, the same shape of idea as assigning "John" to
a TTS bot. That's a real, plausible future extension of this same pattern, not a dead end — just a
separate piece of work, explicitly not part of what's being built now.

**Net scope for this plan**: per-voice lexicons apply to ElevenLabs voices only. Kokoro and the
synth both continue reading the single shared/default lexicon (`VOICE_LINES`, unchanged) exactly as
they do today.

### Appendix A revision

The authoring flow inverts, and simplifies: **pick a voice first, then write that voice's lines per
event** — not "write a line, then check which voices it applies to." This is a more natural
authoring mental model than Appendix A originally proposed (a line with a voice checklist attached),
and it directly resolves the ambiguity flagged there ("assign to voices" now has one clear meaning:
which named voice's lexicon you're editing).

### UI / UX

Three panes, mirroring the `voiceId → lineId → variants[]` data shape directly rather than sitting
an abstraction on top of it:

```
┌─────────────┬────────────────────────┬───────────────────────────────────┐
│ VOICES      │ EVENTS  (Harry)         │ "contact" — Harry                  │
│             │                         │                                     │
│ Harry  9/13 │ contact      customized │ Shared default: "target spotted"   │
│ Sarah  3/13 │ firing       shared     │                                     │
│ Adam   0/13 │ cover        customized │ ┌─────────────────────────────────┐│
│ Alice  5/13 │ moving       shared     │ │ "hostile, dead ahead"            ││
│ ...         │ grenade_warn customized │ │ tone: [urgent ▾]   [+tag ▾]  ▶ ✓ ││
│             │ ...                     │ └─────────────────────────────────┘│
│             │                         │ ┌─────────────────────────────────┐│
│             │                         │ │ "contact, quiet, watch it"       ││
│             │                         │ │ tone: [wary ▾]     [+tag ▾]  ▶ ○ ││
│             │                         │ └─────────────────────────────────┘│
│             │                         │ + add variant                      │
│             │                         │ revert to shared default           │
└─────────────┴────────────────────────┴───────────────────────────────────┘
  14 variants unbaked across 3 voices                     [copy bake command]
```

- **Voices (left)**: pulled live from the ElevenLabs account (`elevenCatalog()`, already in
  `bake-voices.mjs`), not invented in the UI. Each row shows a completion count (`9/13`) so
  under/over-authored voices are visible at a glance.
- **Events (middle)**: all 13 lineIds for the selected voice, each tagged `customized` (has its own
  variants) or `shared` (dimmed — still borrowing the default lexicon). Clicking loads the editor.
- **Variant editor (right)**: the shared default shown read-only up top as a reference point, then
  each of this voice's own variants as a small card — text, a tone dropdown (the same
  calm/wary/defensive/urgent words from the tier table, not a raw float), an "insert delivery tag"
  dropdown for v3 tags, a play button, and a bake-status dot (baked / not yet / stale-since-edited).
  No syllable/vowel/formant fields anywhere in this pane — auto-seeded invisibly, same as a new line
  gets today.
- **Bottom bar**: the tool can't bake (API key stays server-side, same reason as always) — it tracks
  what's unbaked across every voice and surfaces the exact command to run.

Flow: pick voice → event list shows customized vs. shared at a glance → pick event → shared default
is right there as a reference, so a new variant is written as a departure from it, not from scratch
→ write text, pick a tone, save → row picks up an unbaked dot → repeat → bake-status bar says what
to run → takes come back baked, dots go green, play button plays the real audio. Persistence reuses
the existing `sound-params.json` download-and-replace workflow, not a new save mechanism.

Deliberately absent: formant/vocoder/radio sliders and arbitration/rate-limit simulation — neither
is "what a voice says," and pulling them in is exactly how `sound-studio.html` grew to six tabs and
1848 lines.
