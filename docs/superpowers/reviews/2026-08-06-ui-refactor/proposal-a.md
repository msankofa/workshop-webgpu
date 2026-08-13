# bot-viewer-v2 control panel — IA proposal A

Input: `docs/bot-viewer-v2-ui-inventory.md` (29 sections listed under a "28 sections" headline —
treated as authoritative regardless of the count label; every item below is mapped once).

This proposal restructures the panel from one flat list of 29 collapsible cards into **4 tabs +
2 persistent quick-access strips**, with a handful of sections split, merged, or folded into each
other. Nothing here requires a framework or build step: it is `createSection(host, ...)` calls
against different host `<div>`s, plus one small new tab-bar component in the same hand-rolled-DOM
style already used by `environment-ui.js`'s `.wui-tabs` (a vertical icon rail toggling panel
visibility) — proof this idiom already lives in this codebase and needs no new machinery.

---

## 1. Grouping — top-level structure

**Two persistent strips (always visible, no tab) + 4 tabs.**

Why tabs at all, given the panel is a narrow fixed-width sidebar (constraint: horizontal space is
also limited)? Because the alternative — everything in one scroll — is the exact problem stated in
the brief: 29 cards, expand-all spans "several screens tall." Tabs trade scroll depth for a
horizontal selector that costs one row. Four short labels (`Bots · World · Look & Sound ·
Diagnostics`) fit a 260–320px sidebar without wrapping; that's the budget, so the tab count is
capped at 4, not 6–7 like `environment-ui.js`'s own tab bar.

Why *persistent strips* instead of folding Camera and Save/Load into tabs? Because they're used
orthogonally to whatever task tab is open. You reframe the camera constantly while tuning aim
sliders in the Bots tab; you don't want camera mode buried behind a tab switch that also hides the
sliders you were mid-edit on. Save/Load is a session bookend (load at start, save before you break
something) that touches all three domains (maze/bots/ui) at once — it doesn't belong to any single
tab either. Both get a slim always-visible row instead.

**Persistent strip 1 — Camera quick row** (new, pulled out of section 2 "Camera"):
Orbit / Follow / POV / Fly mode buttons, Auto follow bots toggle, Frame followed bot, Follow
nearest bot. One row, no accordion — these are click-and-forget actions, not sliders to tune.

**Persistent strip 2 — Session strip** (replaces section 1 "Save/load" sitting at the top):
three compact `select + Load` pairs (maze / bots / ui), collapsed by default into single-line
rows. A "Manage saves…" disclosure (closed by default) expands to the full editor: name field,
Save/Load/✕ per slot set, status lines, and "Export layout JSON." This is the fix for inventory
observation #7 — 13 controls no longer gate everything below them; 3 selects + 1 link do.

**Tab 1 — Bots** (default active tab). The core, continuously-iterated workflow: spawn a roster,
watch it fight, tune the numbers that shape how it fights. Everything with "bot" in its name that
isn't a debug overlay or a performance knob lives here.

**Tab 2 — World.** Map and terrain generation. A setup step you do in bursts (new scenario, new
terrain look) and then leave alone while you spend the rest of the session in the Bots tab.

**Tab 3 — Look & Sound.** Visual theme, lighting, post-fx, audio mixer, music. Flavor, not
behavior — tuned in occasional bursts ("roll a new look," balance the mix), never moment-to-moment
alongside AI tuning.

**Tab 4 — Diagnostics & Perf.** Debug overlays, state capture/tracing, and the perf/LOD A/B
instruments. Opt-in: you open this tab when something's wrong or when you're profiling, not during
normal iteration. Everything currently scattered under "debug-ish" pretenses across four other
sections (inventory observation #4) consolidates here.

This is a **two-level hierarchy** (tab → grouped accordion sections within the tab), not three
levels — I deliberately did not nest groups inside groups. A third level would save no controls,
just add clicks; a labeled visual grouping (a small caption above a cluster of `.sec` cards, no
extra collapse state) does the same organizing job without another interaction cost.

---

## 2 & 3. Full mapping and ordering

One row per original inventory section. "Order" is the position within its destination tab/strip,
top to bottom. Bold notes call out every move, split, merge, or promotion explicitly.

### Persistent strip: Camera quick row
| From | Item | Note |
|---|---|---|
| §2 Camera | Orbit/Follow/POV/Fly, Auto follow bots, Frame followed bot, Follow nearest bot | **promoted out of §2** into the always-visible strip |

### Persistent strip: Session
| From | Item | Note |
|---|---|---|
| §1 Save/load | 3 slot-set pickers (compact), "Manage saves…" disclosure holding Save/Load/✕/name/status ×3 + Export layout JSON | **demoted from top-of-panel accordion to a 3-row strip**, full editor collapsed by default |

### Tab 1: Bots — order = frequency of iteration (what gets touched every session first)

**Group: Live status** (always the top of the tab; these are read while everything else is edited)
1. §25 Bot readout — **unchanged, default expanded** (only section open on load, same as today)
2. §12 Scoreboard — **moved next to Bot readout** (was section 12, standalone, far from the other live readout)

**Group: Combat tuning** (the sliders actually iterated on most)
3. §23 Aim & reaction — split into primary/advanced, see §4 Defaults below
4. §22 Lost-sight pursuit
5. §16 Weapons & ammo
6. §24 Explosives — split into primary/advanced
7. §17 Body & ragdoll — death impulse/ragdoll/blood FX are combat consequences, grouped with the rest of combat rather than left adjacent to spawn controls

**Group: Movement & stance** (tuned less often than combat, but as a pair — locomotion feel)
8. §20 Movement tuning
9. §21 Stance — split into primary/advanced

**Group: Spawn & population** (set up once per scenario, then ignored)
10. §11 Bot controls — **split**: perf/LOD toggles (Think stagger, Rig LOD, Flush LOD,
    Behind-camera cull, Body hide, Armour LOD) **move to Diagnostics & Perf**. What stays: spawn
    buttons, team toggle, count, medic/sniper/technical %, role spawn buttons, add-team buttons,
    the Stance cycle override button (a live per-bot override, not a tuning value — it belongs
    with spawn/roster controls, not the Stance tuning section above).
11. §26 Dummies — **moved up from position 26** to sit with the rest of "things you spawn," since it's used constantly as an aim/reaction test target, not as an afterthought
12. §13 Squads — **"Squad overlay" toggle removed**, see Diagnostics tab
13. §14 Sides & home bases
14. §15 Auto-add & corpses

### Tab 2: World — order = pipeline/causal (each section's output feeds the next)

**Quick presets row** (new, not an accordion — 3 buttons, always visible at top of tab)
- §4 "Big open field" — **promoted out of Maze structure**
- §4 "Test condition" — **promoted out of Maze structure**
- §9 "Preset: eroded highlands" — **promoted out of Terrain shading**

1. §3 + §4 **merged into "Layout & structure"** — cols×rows/seed/hall width/thickness/height/
   loop/straightness/braid from §3 Map layout, combined with walls/structures/structure
   count+spacing+mix/start-goal/perimeter entrances/open rooms/room count+size/cover pieces from
   §4 Maze structure, plus §3's Auto scene shuffle + keep-bots-on-rebuild. These two sections
   described one thing (the map skeleton) split for no functional reason (inventory observation
   #1) — merging removes a card with no loss of any control.
2. §5 Terrain (base heightfield: uneven ground, level pads, seed, hill/ripple/grain, mesh cell, max walk slope, pad blend)
3. §6 Landform (warp/terrace/ripple-mode — shapes the base terrain)
4. §7 Erosion (channel depth/area/width, fill depressions — carves the landform)
5. §8 Landmarks (placed features on top of the carved terrain)
6. §9 Terrain shading minus its preset button (purely cosmetic — correctly last in the pipeline)

### Tab 3: Look & Sound — order = setup-then-tune, most-used bulk action first

**Look quick actions row** (new, not an accordion)
- §10 theme select, 🎲 Roll a new look, Reset theme defaults — **promoted out of the Visuals section**

1. §10 **split #1 — "Scene look"**: the 12 top sliders (brightness…vignette, tone map, exposure, contrast) + the 13 visual toggles (Sky dome…Reflections)
2. §10 **split #2 — "Bot lighting"**: promoted from a `.ttl` sub-heading inside Visuals to its own real `.sec` card (glow toggles, body/plate/trim/visor glow, visor color, rim/pool/flash/beam controls)
3. §10 **split #3 — "Sky detail"**: promoted from sub-heading to its own card (star gain/density/below-horizon, nebula gain, planet size/azimuth/elevation)
4. §28 Audio (mixer, voice, chatter, reactive lights, music source, player card/transport/playlist, folder pickers)
5. §29 Music FX — kept adjacent to Audio, not folded in; it's a distinct refinement layer (bus effects vs. mix levels) worth its own collapse state

The current single "Visuals" card is ~53 controls behind one collapse toggle — larger than 8 of
the other sections combined. Splitting it into three real, independently-collapsible cards is the
single biggest legibility win available in this tab, and it costs nothing: the sub-heads already
exist in the DOM, they just aren't `.sec` cards yet.

### Tab 4: Diagnostics & Perf — order = workflow (turn on what you need, record it, then perf-test)

1. §18 Debug overlays — **receives**: POV debug widgets + POV debug markers (**moved from §2
   Camera** — these are diagnostic overlays, not camera composition), Squad overlay toggle
   (**moved from §13 Squads**), and §27 Nav grid's single "Toggle nav overlay" button
   (**§27 dissolved as a standalone section** — one button doesn't earn its own card; it's one
   more toggle row here). This directly answers inventory observation #4: debug controls were
   spread across four sections plus Squads; now there's one.
2. §2 Camera **remainder** — "Camera (advanced)": fly mode/speed, view distance, framing select,
   Auto rotate, Occlusion guard, POV comfort, POV eye up/down/forward, target diamond size, POV
   recenter + delay + recenter-now. Everything reached constantly (mode, follow) is already in the
   persistent strip; everything here is reached rarely (comfort tuning for a specific POV capture,
   framing presets).
3. §19 State recorder (record/scope/live map/heartbeat/copy+save exports) — unchanged
4. **"Performance / LOD"** (new section) — Think stagger, Rig LOD, Flush LOD, Behind-camera cull,
   Body hide, Armour LOD, **pulled out of §11 Bot controls**. These are A/B instruments for frame
   budget, not gameplay controls; inventory observation #3 flags them mixed in with spawn buttons
   today. They belong next to the state recorder and debug overlays — the other "is this actually
   working" tools — not next to "spawn 10 more bots."

---

## 4. Defaults

- **Active tab on load:** Bots.
- **Open on load:** Bot readout only — unchanged from today. Everything else, in every tab,
  starts collapsed.
- **Persistent strips:** always visible, never collapsed (Camera quick row, Session strip). The
  Session strip's "Manage saves…" full editor starts closed.
- **Quick-preset / quick-action rows** (World tab presets, Look & Sound theme row): always visible
  at the top of their tab, not inside a collapsible card — they're single-click shortcuts, not
  settings to review.
- **"Show advanced" disclosure**, hidden by default, inside three specific sections that are dense
  enough to hide their own signal:
  - **Aim & reaction** — primary: Reaction delay / Weapon spread toggles, Reaction (ms), Base /
    Moving / First-shot spread. Advanced: per-metre/cap/floor/alerted×/primed×/jitter/re-acquire
    grace, and all three recoil sliders.
  - **Stance** — primary: Stance system toggle, Allow prone, Crouch/Prone speed×, Crouch/Prone
    height×. Advanced: blend rates, turn×, stand-up/crouch-down/prone-min-hold timings, seek/aim
    crouch radius + both hysteresis sliders.
  - **Explosives** — primary: Grenades/Blast FX toggles, Carried per bot, Min/Max range (the
    "throw decision" inputs). Advanced: cooldowns, veto multipliers, cluster weight, blind-throw
    max age, and the 5 controls the inventory already calls out as writing into "the ordnance
    spec" (delay, randomness, area, damage, effect size).
  Each is a plain nested toggle, no new component — same `.sec`-style collapse, one level deeper.
- **Expand-all / Collapse-all** — keep the two existing header buttons, but **scope them to the
  active tab's host**, not the whole panel. Today a global expand-all would silently blow open
  three hidden tabs' worth of cards; that's wasted work and defeats the point of tabbing.

---

## 5. Additions and removals

**Add:**
- **Tab bar**, 4 items, built the same way `environment-ui.js` already builds `.wui-tabs` (a row
  of small buttons toggling which host `<div>` is visible) — direct precedent in this repo, no new
  pattern to invent.
- **Two persistent strips** (Camera quick row, Session strip) — see above.
- **Search box** at the very top of the panel, above the tab bar. Plain substring match against
  each `.sec-head` label and, optionally, each control's own label text; matching sections
  auto-expand and jump into view, non-matching ones dim, across *all* tabs (not just the active
  one — a search should not be scoped by which tab happens to be open). No new UI framework:
  `querySelectorAll('.sec-head span')` and a text filter is enough.
- **Pin/favorite affordance**: a small pin icon in each `.sec-head`. Pinning adds that section to a
  lightweight "Pinned" strip pseudo-tab (or a slim always-visible drawer) so a developer mid-tuning
  session (e.g. constantly reopening Aim & reaction and Bot readout) doesn't pay tab-switch cost
  every time. Persist pinned ids the same way section-collapse state already persists
  (`readSectionStates`/`applySectionStates` in `workshop-panel-theme.js` is the existing
  localStorage precedent — reuse the mechanism, add a `pinned` key).
- **Compact-mode toggle**: one panel-wide class (e.g. `.panel-compact`) that tightens the existing
  `.sec-body` padding/gaps already defined in `workshop-panel-theme.js`, rather than inventing new
  visual styling — satisfies "don't redesign the visual style" while still shrinking scroll length
  for a developer who wants density over legibility.

**Remove / demote:**
- §27 Nav grid as a standalone section — folded into Debug overlays (one button doesn't need its
  own accordion card and header row).
- Save/Load's prominence — demoted from a 13-control top-of-panel accordion to a 3-row strip with
  the full editor behind a disclosure.
- The three buried preset buttons (Big open field, Test condition, eroded highlands preset) —
  promoted, not removed, but explicitly called out because leaving them at the bottom of unrelated
  sections (inventory observation #5) is the opposite of what a "preset" should get: presets exist
  to be found fast.
- "Squad overlay" out of the Squads section — it's a visibility toggle, not a squad-tuning
  control, and it was the reason Squads showed up in the "debug controls in four places" complaint.

**Toggle idiom — explicitly kept as-is.** The brief invites reconsidering the
`Rig LOD: On`-style state-carrying button. I'm not changing it. 330 controls across every section
use this idiom consistently today; converting to checkboxes touches every call site for a
cosmetic-only win, and the actual legibility problem in this panel is grouping and order, not
whether state renders as a checked box or a button suffix. Re-skinning the toggle is available
later as a pure `workshop-panel-theme.js` CSS change if wanted — it doesn't need to ride along with
an IA change, and bundling it here would multiply the diff for no IA benefit.

---

## 6. Ranked rationale — top 5 problems this fixes

1. **The primary workflow (combat AI tuning) had no home.** Inventory observation #2: bot concerns
   spread across 11 sections with no grouping above the section. Fixed by the Bots tab, itself
   internally ordered by iteration frequency (live status → combat tuning → movement → one-time
   spawn setup), so the controls touched every few minutes are never more than one collapse away
   and the ones touched once per session sink to the bottom.
2. **Perf A/B instruments were mixed into spawn controls.** Observation #3: Think stagger, Rig LOD,
   Flush LOD, Behind-camera cull, Body hide, Armour LOD sat inside "Bot controls" next to "Spawn
   Alpha bot." Fixed by extracting a dedicated Performance/LOD section under Diagnostics & Perf —
   these are frame-budget instruments, not gameplay, and profiling is a distinct task from
   tuning behavior.
3. **Debug/diagnostic controls were fragmented across (at least) five places** — Camera's POV
   debug widgets/markers, Debug overlays, State recorder, Nav grid, and Squads' Squad overlay
   (observation #4). Fixed by consolidating all of it into one Diagnostics & Perf tab; a developer
   chasing a bug now opens one tab instead of remembering five locations.
4. **Terrain generation had no causal order and an unjustified split.** Map layout and Maze
   structure describe one thing (the map skeleton) but were separate cards (observation #1); the
   five terrain-shape sections sat as flat, unordered peers. Fixed by merging the skeleton
   sections and ordering the terrain pipeline (base → landform → erosion → landmarks → shading)
   causally under the World tab, with the three buried one-click presets promoted to the top where
   they're actually useful (observation #5).
5. **The panel opened to either 29 flat cards or, worse, a single 53-control Visuals mega-card**,
   with Save/Load's 13 controls gating everything beneath (observations #6, #7, #8). Fixed by
   tabs (bounding what's on screen to one task's worth of cards), the Visuals split into three
   real sections, the Save/Load demotion to a 3-row strip, and search/pinning for the rare case
   where a developer needs a control from a tab they aren't currently in.
