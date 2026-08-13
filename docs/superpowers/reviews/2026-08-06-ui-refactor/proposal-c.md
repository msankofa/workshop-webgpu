# bot-viewer-v2 control panel — IA proposal C

Input: `docs/bot-viewer-v2-ui-inventory.md` (28 sections, ~330 controls, flat collapsible-card list,
ordered by write date). This proposal restructures it into tabs + clustered accordion cards, plus a
small amount of pinned chrome, with no new build step or framework — every element below is plain
DOM the panel already knows how to build (`createSection`, buttons, a `display:none` toggle for tabs).

---

## 1. Grouping — top-level structure

**Tabs, six of them, plus two pinned strips that sit above the tabs and don't change with them.**

Why tabs and not one long grouped accordion: the panel is a fixed-width sidebar over a 3D view —
vertical space is the scarce resource, and today "expand every section" produces a scroll several
screens deep because all 28 cards share one list. Tabs bound the worst case to "every card in the
active tab," not "every card that exists." The cost of tabs is that you can't see two tabs' controls
side by side — but this tool's own controls are already siloed by concern (nobody adjusts a terrain
erosion slider and a chatter-voice toggle in the same motion), so that cost is small. The two things
that genuinely get referenced *no matter what else you're doing* — repositioning the camera, and
reading the live bot readout — are pulled out of the tab system entirely and pinned, so switching
tabs never hides them.

**Pinned chrome (always visible, independent of active tab):**

- **Search bar** — new, filters controls by label across all tabs (see §5).
- **Camera quick-strip** — the 4 mode buttons only (Orbit / Follow / POV / Fly), one row.
- **Bot readout** — the current per-frame pos/state/health/aim card, pinned, default expanded.
  It's the one thing that was already default-open before this proposal; pinning it just makes that
  permanent instead of "open until you switch to a tab that scrolls it out of view" (today it can't
  be scrolled out of view because nothing else is open by default — that stops being true once tabs
  have real content in them, so pinning is load-bearing, not decorative).

**Tabs, in this order:** `Bots` · `World` · `Debug/Perf` · `Visuals` · `Audio` · `Session`.

Tab order is **frequency of use across a typical session**, not pipeline order (pipeline order is
used *within* a tab — see §3). Bots dominates: it's the tool's namesake and where nearly every
tuning session starts and ends. World (map/terrain generation) is touched to build or vary a test
scenario, often once per session via a saved slot. Debug/Perf is used constantly *while* a debugging
session is active but not equally in every session, so it sits after World rather than after Bots.
Visuals and Audio are tuned in occasional bursts and otherwise left alone — the agent memory log
itself notes combat audio shipped "UNHEARD, tuning pass pending," i.e. long stretches with zero
audio-tab visits. Session (Camera detail + Save/Load) is last because its single highest-frequency
piece (camera mode) is already pinned above the tabs; what's left in it is setup-once material.

Within a tab, related cards are clustered under a plain-text **cluster label** (a non-interactive
divider row, e.g. `TERRAIN GENERATION`) — a second hierarchy level that costs one `<div>` per
cluster and no new interaction model. This directly answers the inventory's observation #1 (terrain
occupies five consecutive sections with no banner saying so) and #2 (bot concerns scattered with "no
grouping level above the section").

---

## 2. Full mapping — every section's destination

| # | Current section | Destination | Notes |
|---|---|---|---|
| 1 | Save / load | **Session** tab, card 1 (top) | Demoted from panel-top to a tab; `Export layout JSON` shrinks from a full-width button to a small text link in this card's footer (it's an infrequent export, not a slot action). |
| 2 | Camera | **Split.** Orbit/Follow/POV/Fly → pinned quick-strip (header chrome). `Frame followed bot` / `Follow nearest bot` → stay in **Session** tab, card 2 (Camera). Fly mode/speed, view distance, framing, Auto rotate, Auto follow, Occlusion guard, POV comfort, POV eye offsets, target diamond size, POV recenter (+delay, +now) → **Session** tab, card 2. `POV debug widgets` / `POV debug markers` → **Debug/Perf** tab, "Visual debug overlays" cluster (moved out — these are diagnostic overlays, not camera framing). | Biggest single split in this proposal; justified because "which camera mode am I in" is a per-second question and "how far is the POV eye offset" is a per-session-setup question. |
| 3 | Map layout | **World** tab, cluster `LAYOUT & STRUCTURE`, card 1 | |
| 4 | Maze structure | **World** tab, cluster `LAYOUT & STRUCTURE`, card 2, minus `Big open field` / `Test condition` | Those two buttons promote to the new **World-tab presets strip** (§5). |
| 5 | Terrain | **World** tab, cluster `TERRAIN GENERATION`, card 1 | |
| 6 | Landform | **World** tab, cluster `TERRAIN GENERATION`, card 2 | |
| 7 | Erosion | **World** tab, cluster `TERRAIN GENERATION`, card 3 | |
| 8 | Landmarks | **World** tab, cluster `TERRAIN GENERATION`, card 4 | |
| 9 | Terrain shading | **World** tab, cluster `TERRAIN GENERATION`, card 5, minus `Preset: eroded highlands` | Button promotes to the World-tab presets strip. |
| 10 | Visuals (mega-section w/ subheads) | **Visuals** tab, split into 3 cards | `Look & post-processing` (theme, brightness…vignette, tone map, the 13 visual toggles) · `Bot lighting` (existing subhead, own card) · `Sky detail` (existing subhead, own card). Same content, no longer one endless card. |
| 11 | Bot controls | **Bots** tab, cluster `ROSTER & COMPOSITION`, card 1, minus 6 perf toggles | `Think stagger`, `Rig LOD`, `Flush LOD`, `Behind-camera cull`, `Body hide`, `Armour LOD` move to **Debug/Perf** tab's new `Performance` card (inventory observation #3: these are A/B instruments, not gameplay, and shouldn't sit next to spawn buttons). `Armour LOD` gets a one-line note that it also changes bot appearance, cross-referencing Visuals. |
| 12 | Scoreboard | **Bots** tab, cluster `RESULTS & TEST AIDS`, card 1 | |
| 13 | Squads | **Bots** tab, cluster `ROSTER & COMPOSITION`, card 2, minus `Squad overlay` | Toggle moves to **Debug/Perf** tab, "Visual debug overlays" cluster — it's a debug overlay like the others in that cluster, not a squad-tuning control. |
| 14 | Sides & home bases | **Bots** tab, cluster `ROSTER & COMPOSITION`, card 3 | |
| 15 | Auto-add & corpses | **Bots** tab, cluster `ROSTER & COMPOSITION`, card 4 | |
| 16 | Weapons & ammo | **Bots** tab, cluster `LOADOUT`, card 1 | |
| 17 | Body & ragdoll | **Bots** tab, cluster `LOADOUT`, card 2 | |
| 18 | Debug overlays | **Debug/Perf** tab, cluster `VISUAL DEBUG OVERLAYS`, card 1 | Absorbs #27 (Nav grid) as one added toggle row, plus the POV debug widgets/markers from #2 and Squad overlay from #13. This is the fix for observation #4 ("debug/diagnostic controls appear in at least four places") — now there's one. |
| 19 | State recorder | **Debug/Perf** tab, cluster `DIAGNOSTICS & CAPTURE`, card 1 | |
| 20 | Movement tuning | **Bots** tab, cluster `AI TUNING`, card 1 | |
| 21 | Stance | **Bots** tab, cluster `AI TUNING`, card 2 | Basics (3 toggles, speed×/height×/blend/turn× sliders) visible; timing & hysteresis sliders (Stand-up ms, Crouch-down ms, Prone min hold ms, seek/aim crouch radius+hysteresis) behind an in-card "Show advanced" disclosure. |
| 22 | Lost-sight pursuit | **Bots** tab, cluster `AI TUNING`, card 3 | |
| 23 | Aim & reaction | **Bots** tab, cluster `AI TUNING`, card 4 | Reaction delay/ms, base/moving/first-shot spread, aim settle, recoil-per-shot stay visible; per-metre reaction, alerted×/primed× multipliers, jitter, re-acquire grace, recoil cap/recovery behind "Show advanced." |
| 24 | Explosives | **Bots** tab, cluster `LOADOUT`, card 3 | The doc already notes the internal split (10 "throw decision" sliders vs. 5 "ordnance spec" sliders) — make that split real: throw-decision sliders visible, ordnance-spec sliders behind "Show advanced." |
| 25 | Bot readout | **Pinned chrome**, not in any tab | See §1. |
| 26 | Dummies | **Bots** tab, cluster `RESULTS & TEST AIDS`, card 2 | |
| 27 | Nav grid | **Removed as a standalone section** — folds into Debug overlays (#18) as a single added toggle row | It was one button; a whole collapsible card for one button is the clearest case of over-sectioning in the current panel. |
| 28 | Audio | **Audio** tab, card 1 | |
| 29 | Music FX | **Audio** tab, card 2 | Already correctly ordered after Audio (it processes Audio's player output) — kept as-is. |

Every control in the inventory lands somewhere in the table above; the only controls that change
*section* (not just tab) are the six perf toggles out of Bot controls, POV debug widgets/markers and
Squad overlay into Debug overlays, and the two terrain-cluster preset buttons plus the two
maze-structure preset buttons into the new presets strips.

---

## 3. Ordering within groups

- **World tab** (`LAYOUT & STRUCTURE` → `TERRAIN GENERATION`): strict **pipeline order**. You pick a
  layout and wall/structure mode before there's a heightfield to generate; within terrain generation,
  Terrain (base height) → Landform (character) → Erosion (carve) → Landmarks (place features on top)
  → Terrain shading (color the result) is the literal order the generator composes in.
- **Bots tab** (`ROSTER & COMPOSITION` → `LOADOUT` → `AI TUNING` → `RESULTS & TEST AIDS`):
  **setup-then-tune, by how early in a session each cluster is touched.** You spawn a roster before
  you care what it's carrying, and you equip it before you fine-tune how it moves and fights. Results
  and test aids (scoreboard, dummies) come last because they're read *after* the other three are
  already in play, not configured up front. Inside `ROSTER & COMPOSITION`, Bot controls leads because
  it's the literal spawn action; Squads/Sides/Auto-add follow because they modify or automate that
  roster. Inside `AI TUNING`, Movement → Stance → Lost-sight pursuit → Aim & reaction is causal: base
  locomotion, then the posture layer on top of it, then the engagement decision, then shot execution.
- **Debug/Perf tab** (`Performance` → `VISUAL DEBUG OVERLAYS` → `DIAGNOSTICS & CAPTURE`): **workflow
  order for a debugging pass** — first make sure the sim can run at a usable frame rate under load
  (perf toggles), then turn on the overlay that shows the thing you're chasing, then capture/export
  it. This is also frequency-within-tab: perf toggles get flipped once and left; overlays get flipped
  on/off constantly during a single investigation; capture is the terminal action.
- **Visuals tab**: `Look & post-processing` → `Bot lighting` → `Sky detail`, matching the existing
  subhead order (unchanged — it was already scene-then-subject-then-backdrop, which reads fine).
- **Audio tab**: Audio → Music FX, unchanged (Music FX processes what Audio plays).
- **Session tab**: Save/Load → Camera. Save/Load leads because loading a saved maze/bots/ui slot is
  frequently the literal first action of a session (per the inventory's own note that slots exist to
  avoid re-deriving a scenario from scratch); Camera follows as secondary session setup, since its
  highest-frequency piece is already pinned above the tabs.

---

## 4. Defaults

- **Active tab on load: Bots.** It's the tool's primary subject and where sessions overwhelmingly
  start (spawn a roster, then tune it).
- **Within the Bots tab**, only the first card (`Bot controls`, roster/composition) is expanded by
  default; every other card in every tab starts collapsed, matching today's convention of "mostly
  collapsed on load" but now anchored to something actionable instead of a passive readout.
- **Pinned chrome is always visible**: search bar, camera quick-strip, and Bot readout (readout
  starts expanded, as it does today).
- **"Show advanced" disclosures**, collapsed by default, on exactly three cards where the inventory
  already shows a clear primary/fine-tuning split: `Stance` (timing & hysteresis sliders), `Aim &
  reaction` (per-metre/alerted/primed/jitter/re-acquire/recoil-cap-recovery constants), and
  `Explosives` (the 5 ordnance-spec sliders vs. the 10 throw-decision sliders). This is a small,
  targeted use of the pattern — not applied panel-wide, because most cards' controls are all "primary"
  for this tool's actual job (e.g. every terrain slider is something the developer plausibly wants
  today; hiding some by default would just add clicks).
- **Debug/Perf is a normal, ungated tab** — not hidden behind "advanced." For this tool, profiling and
  trace capture are core developer workflow, not rare escape hatches; gating them behind an extra
  affordance would fight the tool's actual purpose.
- `Expand every section` / `Collapse every section` scope to **the active tab's cards only** (a small
  behavior change from today, where they'd otherwise expand cards in five other tabs the user isn't
  looking at). This needs `setAllSectionsCollapsed` to walk the visible tab panel's subtree instead of
  the whole `panelBody`.
- The `ui` save-slot gains one more captured field: **active tab** (alongside the existing collapsed
  states and advanced-disclosure states), so reloading a UI slot restores where you were, not just
  what was open.

---

## 5. Additions and removals

**Add:**

- **Search bar** (pinned, top of panel). Filters by control/section label across all tabs; a match
  auto-switches to its tab, expands its card (and its "Show advanced" disclosure, if the match is
  inside one), and highlights the row. This is the direct fix for the fact that tabs otherwise hide
  a control the developer knows exists but can't remember which of six tabs it's in.
- **Pin/favorite** — a small star on each card's header. Starred cards surface in a slim `★` pseudo-tab
  inserted at the front of the tab bar, so a developer mid-way through (say) an aim-tuning pass can
  pin `Aim & reaction` and `Lost-sight pursuit` and flip between them without re-navigating the Bots
  tab's four AI-tuning cards each time. Persisted in the `ui` slot.
- **Compact-density toggle**, in the panel header next to hide/show. Applies a CSS class that shrinks
  `sec-head` min-height and row padding. Directly answers "vertical space is the scarce resource" —
  this is the cheapest way to fit more rows per screen without touching layout logic.
- **Presets strip**, plain button row (no card chrome) at the top of the World tab: `Big open field` ·
  `Test condition` · `Preset: eroded highlands`. Fixes observation #5 (two one-click presets buried at
  the bottom of unrelated sections, one more buried in a third).

**Remove / demote:**

- **Nav grid** (#27) stops being a standalone card — folds into Debug overlays as one toggle row. A
  one-button card is pure overhead.
- **Export layout JSON** demotes from a full-width button to a small text link inside the Save/Load
  card's footer — it's an occasional export, not a slot action, and doesn't need equal visual weight
  with Save/Load/Delete.
- **Six perf toggles** demote out of Bot controls (where they visually competed with spawn buttons)
  into a dedicated `Performance` card — not removed, just no longer squatting in the roster card.

**Toggle idiom — explicitly kept, not changed.** The "label carries state" button (`Rig LOD: On`) is
used on roughly 330 controls. Reworking it to checkboxes would touch the DOM, CSS, and — more
riskily — any save/load code that reads button label text to restore state (`captureBotState` /
`applyBotState` and friends), for a purely cosmetic gain. The problems documented in the inventory are
information-architecture problems (flat ordering, scattered concerns, buried presets, everything
collapsed with nothing to anchor to) — none of them are caused by the toggle widget itself. If a
future pass wants a cheap visual improvement here, a filled/hollow dot prefix on the label (●/○) can
be added without touching the click handling or the state-restore code path; that's a follow-up, not
part of this proposal.

---

## 6. Ranked rationale — top 5 problems this fixes

1. **No grouping level above the section (inventory obs. #1, #2).** Today, related concerns —
   terrain's five stages, bots' eleven scattered sections — have no visual or structural indication
   that they belong together. Tabs + cluster labels make "Bots" and "World" and "Terrain generation"
   real, navigable groups instead of an accident of scroll position.
2. **Diagnostic/perf controls duplicated across four-plus places (obs. #3, #4).** Rig LOD sits inside
   spawn controls; POV debug widgets sit inside Camera; Squad overlay sits inside Squads; Nav grid is
   its own card. A developer debugging a frame-rate or visibility issue had to remember four
   unrelated locations. Consolidating into one Debug/Perf tab means "where do I look when something's
   wrong" has one answer.
3. **Unbounded expand-all (obs. #6).** With everything in one 28-card list, "expand every section"
   produces a scroll several screens deep. Tabs cap the worst case at one tab's worth of cards, and
   the density toggle shrinks that further.
4. **Buried one-click presets (obs. #5).** `Big open field`, `Test condition`, and `Preset: eroded
   highlands` were each the fastest path to a working test scenario but sat at the bottom of sections
   about something else. Surfacing them as a strip at the top of the World tab makes the fast path
   actually fast.
5. **Save/Load monopolized first contact (obs. #7, #8).** 13 controls, none of them the tool's actual
   subject, sat above everything else, and the only thing open by default was a passive readout. The
   new default (Bots tab active, roster card expanded, camera + readout pinned) means the first thing
   a developer sees and can act on is spawning and watching bots — the tool's reason to exist — not a
   slot picker.
