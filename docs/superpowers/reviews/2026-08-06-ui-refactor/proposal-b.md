# bot-viewer-v2 control panel — IA proposal B

Input: `docs/bot-viewer-v2-ui-inventory.md` (29 sections currently on screen, ~330 controls).
This is a proposal only — no code changed as part of writing this document.

## 0. How this tool is actually used (the argument for the whole structure)

This is a single-developer harness with four distinct *modes of work*, not one continuous
workflow:

- **Building a map/terrain** — done at the start of a session, or when switching test scenarios.
  Touches Map layout + the 5 terrain sections. Bursty: several changes in a row, then untouched
  for the rest of the session.
- **Tuning bot AI/combat** — the bulk of day-to-day work per the project history (movement,
  stance, aim, pursuit, explosives, roster composition). Long, sustained sessions of small slider
  nudges while watching bots fight.
- **Tuning look/sound** — occasional aesthetic passes (theme, lighting, music), largely
  independent of whether you're also mid-combat-tuning.
- **Diagnosing** — perf profiling, state capture, forensics, debug overlays. A dedicated
  investigation mode entered deliberately ("something's wrong, let me look"), not blended into
  the other three.

These four modes are close to disjoint in practice — you don't reach for erosion sliders and
recoil-recovery sliders in the same minute. That's the case for **tabs**: a flat list or a
single-page grouped accordion still lets "expand all" produce a many-screen scroll (inventory
observation #6); tabs put a hard ceiling on how much can be on screen at once, per mode.

Three things cut across all four modes and don't belong inside any one tab: **Save/load** (you
load a config before you know which mode you're even in), **Camera** (you're always looking at
the scene, regardless of what you're tuning), and **Bot readout** (ambient status you want
visible while doing anything else, which is also *today's* only-open-by-default section — this
proposal keeps that promise, just relocates it). Those three become a **persistent zone above the
tab strip**, not tab content.

## 1. Top-level structure

```
Panel header (title, search box, Expand/Collapse-all, Show advanced, panel hide) ─ always
─────────────────────────────────────────────────────────────
PERSISTENT ZONE (always visible, any tab)
  Save / load        [collapsed by default]
  Camera             [collapsed by default]
  Bot readout        [OPEN by default]
─────────────────────────────────────────────────────────────
TAB STRIP:   [ Map ]   [ Bots ]   [ A/V ]   [ Debug ]
─────────────────────────────────────────────────────────────
ACTIVE TAB'S SECTIONS (grouped by a plain-text divider, each still its own collapsible card)
```

Default active tab on load: **Bots**, since bot AI tuning is the tool's primary purpose and the
persistent Bot readout is already showing status regardless of tab.

Expand-all/Collapse-all are rescoped to **persistent zone ∪ active tab** (not every tab), so
switching tabs doesn't silently pre-expand a tab you haven't opened yet — see §7 for why that's a
one-line implementation change, not a rewrite.

## 2. Full mapping — every section's new home

| # | Current section | New home | Action |
|---|---|---|---|
| 1 | Save / load | Persistent zone | unchanged, collapsed by default (was implicitly first anyway) |
| 2 | Camera | Persistent zone | **split**: POV debug widgets / POV debug markers move out → Debug tab (see below) |
| 3 | Map layout | Map tab → *Layout* group | **merged** with #4 (see below) |
| 4 | Maze structure | Map tab → *Layout* group | **merged** into #3; "Big open field" + "Test condition" **promoted** to the tab's Quick-scenarios strip |
| 5 | Terrain | Map tab → *Terrain* group | unchanged, 1st of the terrain chain |
| 6 | Landform | Map tab → *Terrain* group | unchanged |
| 7 | Erosion | Map tab → *Terrain* group | **tagged advanced** |
| 8 | Landmarks | Map tab → *Terrain* group | **tagged advanced** |
| 9 | Terrain shading | Map tab → *Terrain* group | "Preset: eroded highlands" **promoted** to Quick-scenarios strip |
| 10 | Visuals | A/V tab | **split** into 3: *Visuals: look & post*, *Bot lighting*, *Sky detail* (the last **tagged advanced**) |
| 11 | Bot controls | Bots tab → *Roster* group, renamed *Roster & spawn* | **6 perf toggles moved out**: Think stagger, Rig LOD, Flush LOD, Behind-camera cull, Body hide, Armour LOD → Debug tab, new *Perf / LOD* section |
| 12 | Scoreboard | Bots tab → *Live* group | unchanged |
| 13 | Squads | Bots tab → *Roster* group | "Squad overlay" toggle **moved out** → Debug tab *Debug overlays* |
| 14 | Sides & home bases | Bots tab → *Roster* group | unchanged |
| 15 | Auto-add & corpses | Bots tab → *Roster* group | unchanged |
| 16 | Weapons & ammo | Bots tab → *Combat tuning* group | unchanged |
| 17 | Body & ragdoll | Bots tab → *Combat tuning* group | unchanged |
| 18 | Debug overlays | Debug tab | **consolidated**: absorbs Nav grid (#27), Squad overlay (from #13), POV debug widgets/markers (from #2) |
| 19 | State recorder | Debug tab | unchanged |
| 20 | Movement tuning | Bots tab → *Combat tuning* group | unchanged |
| 21 | Stance | Bots tab → *Combat tuning* group | unchanged |
| 22 | Lost-sight pursuit | Bots tab → *Combat tuning* group | unchanged |
| 23 | Aim & reaction | Bots tab → *Combat tuning* group | unchanged |
| 24 | Explosives | Bots tab → *Combat tuning* group | **split**: throw-decision params + toggles stay as *Explosives*; the 5 ordnance-spec params (explode delay, delay randomness, area of impact, damage centre, explosion effect size — the inventory itself calls this seam out) become their own *Ordnance spec* card, **tagged advanced** |
| 25 | Bot readout | Persistent zone | **promoted** out of the flat list, open by default (preserves current only-thing-open behavior, but ambient across all tabs, not just while on Bots) |
| 26 | Dummies | Bots tab → *Roster* group | **tagged advanced** (WASD test-dummy harness, niche) |
| 27 | Nav grid | Debug tab | **merged** into *Debug overlays* as one more toggle row; section removed |
| 28 | Audio | A/V tab | unchanged |
| 29 | Music FX | A/V tab | **tagged advanced** |

Net effect: 29 cards → 25 cards (2 merges − 3 splits, roughly a wash on count) but no tab ever
shows more than 13 at once, and "advanced" tagging hides 7 of those by default (§4).

## 3. Ordering within each tab

**Persistent zone**: Save/load → Camera → Bot readout. Session-causal order: load a config before
you touch anything, orient the camera the instant the scene exists, then watch status once bots
are alive.

**Map tab**: Quick-scenarios strip (3 buttons, not a card) → *Layout* group (merged Map
layout+Maze structure) → *Terrain* group (Terrain → Landform → Erosion → Landmarks → Terrain
shading). The terrain group's internal order is unchanged because it's already a genuine pipeline:
base heightfield → landform character → erosion carving → landmark placement → shading derived
from the final surface. Layout comes before Terrain because you decide the map's *shape*
(corridors vs. open field, room count) before you decide the *ground*'s texture.

**Bots tab**: *Live* group (Bot readout lives in the persistent zone now, so this group is just
Scoreboard) → *Roster* group (Roster & spawn → Squads → Sides & home bases → Auto-add & corpses →
Dummies) → *Combat tuning* group (Weapons & ammo → Body & ragdoll → Movement tuning → Stance →
Lost-sight pursuit → Aim & reaction → Explosives → Ordnance spec). Roster before Combat tuning
because you need bots on the field before their AI dials mean anything. Combat tuning's internal
order is bottom-up through a bot's capability stack: what it's carrying (Weapons, Body) → how it
moves (Movement, Stance) → how it perceives/chases (Lost-sight) → how it fights (Aim, Explosives)
— the same order you'd debug in if a bot "isn't working."

**A/V tab**: *Look* group (Visuals: look & post → Bot lighting → Sky detail) → *Sound* group
(Audio → Music FX). Look before Sound only because it's listed first in the current panel and
there's no strong reason to reverse it; volume/mixer (Audio) is used far more often than spatial
FX (Music FX), which is why Music FX sits last and is advanced-tagged.

**Debug tab**: Perf / LOD → Debug overlays → State recorder. Perf first because "is it slow"
is usually the first question in a diagnostic session and gates whether the rest of the
investigation is even meaningful; Debug overlays next (turn on what you need to see); State
recorder last (capture once you know what you're looking for).

## 4. Defaults

- **Open on load**: Bot readout only (persistent zone), same as today. Active tab: Bots.
- **Collapsed on load**: everything else — Save/load, Camera, and every section in every tab.
- **Hidden behind "Show advanced"** (a toggle button in the panel header, next to
  Expand/Collapse-all; persists in the `ui` slot set): Erosion, Landmarks, Sky detail, Music FX,
  Dummies, Ordnance spec. These are sections that get heavy attention once (initial terrain/visual
  build-out, per the project history) and then go untouched for long stretches — hiding them
  entirely, not just collapsing them, removes 6 of 25 cards from the everyday surface without
  deleting the capability. A hidden section still restores its saved collapse-state and slider
  values from a loaded slot; it just isn't rendered as a card until the toggle is on.

## 5. Additions and removals

**Add:**
- **Search box** in the panel header, under the title. Plain-text filter: on keystroke, walk each
  section's rendered label text (row labels, button labels, `.ttl` subheads) and hide non-matching
  `.sec` cards, auto-expanding the ones that do match (restoring prior collapse state when the
  query is cleared). This is the single highest-value addition for a 330-control panel and needs
  no framework — it's a substring match over existing DOM text plus toggling `.sec` visibility.
- **"Show advanced" toggle** — see §4.
- **Quick-scenarios strip** at the top of the Map tab — a bare 3-button row (Big open field / Test
  condition / eroded-highlands preset), not a collapsible card, since these are the tool's only
  one-click "get me to a known state" actions and were previously buried at the bottom of
  unrelated sections (inventory observation #5).
- **Compact-density toggle** in the panel header — adds a `.compact` class to the panel root that
  tightens `.sec-head` min-height and `.row` margin via a few extra CSS rules gated on that class.
  Cheap, and directly answers "vertical space is the scarce resource": a developer who knows the
  panel well can fit more cards on screen at once.

**Consider for a later pass, not this one** (flagging so it isn't lost, not proposing it now):
a **pin/favorites** affordance — a small pin icon in each `.sec-head` that adds the section's
title to a persistent "Pinned" pseudo-tab, stored in `localStorage` the same way section
collapse-state already is (keyed by title, via the existing `readSectionStates` pattern). Left out
of the core proposal because it adds a second navigation system (tabs *and* a personal shortlist)
before the first one has been used — worth revisiting after the tab structure has been lived in
for a few sessions and it's clear which 5–8 sections a given developer actually reaches for daily.

**Remove/demote:**
- Nav grid's own card (1 toggle) — folded into Debug overlays, not worth a dedicated section.
- Perf/LOD controls demoted out of the primary spawn workflow (Bot controls) entirely — they are
  A/B instruments, not something you touch while deciding team composition.
- POV debug widgets/markers demoted out of Camera — they're diagnostic overlays that happen to
  render in POV mode, not camera behavior; consolidating all overlay toggles in one place beats
  the locality of "it's near the mode that uses it."

## 6. Toggle idiom — not changing it

The label-carries-state button (`Rig LOD: On`) stays. Converting ~150+ toggle buttons to
checkboxes would touch nearly every section-building call site for a purely cosmetic gain, and the
current idiom already reads unambiguously (the state is in the text, not inferred from a checkbox
fill color that's easy to miss at 12px in a 340px sidebar). Not worth the churn in a change that's
otherwise pure reorganization.

## 7. Implementation notes (why this fits "plain DOM, no framework")

- Tabs are sibling `<div>` containers under the existing `panelBody`, toggled with plain
  `style.display` / a `.hidden` class and an `.active` class on the clicked tab button (reusing
  the existing `button.primary` style for the active tab). `createSection(host, title, opts)`
  already takes an arbitrary host, so each tab body is just a different host passed to the same
  helper — zero changes needed to `workshop-panel-theme.js`'s `createSection`.
- `readSectionStates` / `applySectionStates` / `setAllSectionsCollapsed` call
  `host.querySelectorAll('.sec')`, which finds `.sec` nodes regardless of an ancestor's
  `display:none`. So save/load slots keep serializing every section's collapse state across all
  tabs with **no change** to those three functions — only the Expand/Collapse-all *header
  buttons* need to pass a narrower host (persistent zone + active tab container, not all of
  `panelBody`) to get the "don't pre-expand tabs I haven't opened" behavior described in §1.
- Group-label dividers ("Layout", "Terrain", "Live", "Roster", "Combat tuning", "Look", "Sound")
  reuse the **existing** `.ttl` style (already used as a Visuals subhead) — a plain non-interactive
  `<div class="ttl">` inserted into the tab body's child stream between sections. No new CSS.
- The "Show advanced" toggle is a `data-advanced="1"` attribute on the relevant `.sec` elements
  plus one CSS rule (`#ctrl:not(.show-advanced) [data-advanced="1"]{display:none}`) and a class
  toggle on the panel root, mirroring the existing `.collapsed` pattern already in
  `workshop-panel-theme.js`.
- Search is a keyup handler over `panelBody.querySelectorAll('.sec')` comparing `.textContent`
  against the query, no new markup required.

## 8. Ranked rationale — top problems this fixes

1. **No bounded working set.** Today, expand-all produces a scroll several screens tall
   (observation #6) because there is no ceiling above "section." Tabs cap what's rendered per mode
   to 3–13 cards; the persistent zone stays tiny (3 cards, 2 collapsed) regardless of tab.
2. **Bot concerns were scattered across 11 ungrouped sections** (observation #2) with nothing
   above "section" to organize them. They're now one tab with three named groups (Live / Roster /
   Combat tuning), so "where's the sniper spawn %" and "where's recoil recovery" both resolve to
   "open the Bots tab" instead of "scroll and guess."
3. **Perf A/B instruments were mixed into gameplay spawn controls** (observation #3) — Rig LOD and
   Armour LOD sat next to "Spawn medic." They're now isolated in the Debug tab where they belong
   with the rest of the diagnostic workflow, so a developer tuning team composition never has to
   read past LOD cycle buttons to get there.
4. **Debug/diagnostic controls existed in four separate places** (observation #4: Camera, Debug
   overlays, State recorder, Nav grid, plus Squad overlay in Squads). All overlay toggles now live
   in one *Debug overlays* card in one tab — "what can I turn on to see X" is one card, not a
   panel-wide hunt.
5. **Two one-click scenario presets and a terrain preset were buried at the bottom of unrelated
   sections** (observation #5). They're now a visible 3-button strip at the top of the Map tab —
   the highest-leverage actions in map/terrain generation are now the first thing you see when you
   open that tab, not the last thing you find after scrolling past 25 sliders.

Secondary wins not in the top 5 but worth naming: Save/load's 13 controls no longer gate access to
the rest of the panel on open (they're collapsed-by-default in the persistent zone, not the first
thing rendered); the Visuals section's ~50 controls are no longer one monolithic card; and the
advanced-tag mechanism gives a concrete, reversible answer to "which of these 25 cards actually
need to be visible every day" instead of leaving that judgment to whoever's scrolling.
