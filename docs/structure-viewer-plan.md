# `structure-viewer.html` — implementation plan

Status: **all three phases shipped 2026-08-09.** Reference doc for the tool itself is
`docs/subsystems/bots.md` under "structure-viewer.html"; this file is kept as the record of how it
was decided and what the scouting found. Deviations from the plan are noted per phase below.

Not built, and not planned as omissions — just not reached: an explicit "families" workflow beyond
per-slot reroll (naming and freezing a parameter set is what Presets does today), and any
side-by-side A/B of two parameter sets.

Written 2026-08-09 after a five-agent scouting pass (identical
prompts, so the convergence below is evidence rather than an artefact of how they were asked).

## Why

Structures can only be judged today inside `bot-viewer-v3.html`, where they are scattered across a
combat map at whatever scale the maze happens to be. That makes it hard to see what any individual
parameter does, and impossible to tell whether the procedural space contains **families** worth
freezing into named presets. This tool exists to make parameter → form legible, and to find those
families.

## What the scouts agreed on (5/5)

- `createVisualSystem` (`bot-viewer-visuals.js`) *is* the theming/sky/lighting/material/post stack.
  Importing it satisfies "same as v3, not an approximation" literally — it is the same code object.
- Base the file on a lean standalone harness, **not** on v3 (16,401 lines, entangled with combat).
- Skip the nav grid, lazy visibility field, cover-corner bake and BVH collider. All are bot-AI
  infrastructure and all are the expensive part of a v3 rebuild.
- The real new work is the parameter surface: only 3–4 of ~24 `STRUCTURE_DEFAULTS` fields have UI
  anywhere in the repo today.

## Phase 0 — determinism in `bot-structures.js` — **DONE 2026-08-09**

Shipped as planned, with three corrections to what is written below. Full detail is in
`docs/subsystems/bots.md` under "Seed stability"; the corrections:

1. **Only `buildBuilding` needed the fixed draw vector** (27 slots). `buildPortal` was already
   unconditional, `buildObstacles` puts every roll in a ternary *condition* so `tallShare` cannot
   shift the sequence, and `buildPocket` has nothing after its maze call. The plan implied all four.
2. **Per-structure streams alone were not enough** — the builder runs inside the rejection loop, so
   attempt 2's draws still depended on attempt 1's. Shape gets a fresh stream *per attempt*
   (`SALT_SHAPE + attempt`), with kind and position on their own salts.
3. **The obvious test fixture proves nothing.** `seed: 5, count: 8` over 140 m passes against the
   *pre-fix* generator as well — few buildings, so the probability changes never bite. Measured over
   a grid of fixtures: 93 break the old code under `roofChance`, 101 under `windowChance`, and the
   new code fixes all of them. The test now uses `seed: 3, count: 14` (four buildings, four kinds),
   which does reshuffle before the fix.

Original text follows.

### Phase 0 as planned (blocking; do first)

**The problem, measured.** Same seed, 8 structures, one parameter changed:

| change | result |
|---|---|
| `roofChance` 0.5 → 0.9 | **whole field reshuffled** — buildings became pockets and portals |
| `windowChance` 0.5 → 0 | **whole field reshuffled** |
| `doorWidth` 2.2 → 2.4 | identical |

Two independent causes, and **both** must be fixed or the tool's core workflow ("fix a seed, drag one
slider, see what it does") shows a different map instead of a variant.

**Cause 1 — one shared stream across all structures.** `generateStructures` runs a single
`makeRng(p.seed)` through the whole scatter loop. Worse, the builder is invoked *inside* the
rejection-sampling loop, once per attempt, so a structure that needed five attempts consumed five
builders' worth of draws. Anything upstream shifts everything downstream.

*Fix:* give each structure index its own stream, `makeRng(hash(seed, i))`. Structure `i` then no
longer depends on how many attempts structures `0..i-1` took, and raising `count` leaves existing
structures untouched.

**Cause 2 — variable draw count inside a builder.** `buildBuilding` only draws for a side's opening
when that side is not a door; only draws `doorAt` when there *is* an opening; only draws the roof
body when the roof roll passes; and draws 3 values per interior cover for a count that is itself
rolled. So changing an early probability shifts every later draw within that same structure.

*Fix:* front-load a **fixed-length** draw vector per builder and index into it, using values whether
or not the branch fires. This is already this repo's convention — `plants.js:414` documents exactly
it for `rollPlantVariation`: *"Draws exactly 4 values, always in this order … regardless of the
dry-roll outcome, so callers … get a fixed, order-stable draw count."* Apply the same discipline
here. The exact vector length per builder must be **derived from the code during implementation**,
not guessed.

**Honest limit.** Placement still depends on earlier structures through the overlap test, so a change
that alters a footprint can still nudge a later structure's accepted position. With both fixes the
candidate *sequence* is stable and only accept/reject differs, so this degrades to an occasional
shift rather than a reshuffle. Say so in the UI rather than claiming perfect stability.

**New export: `generateOne(kind, params, seed)`.** The four builders are private; only the scatter
loop can reach them. The gallery needs one clean specimen of a chosen kind, so export a single-
structure entry point built on the same per-structure stream, and have `generateStructures` call it
so there is exactly one code path.

**Tests** (`test-bot-structures.mjs`): the new invariant is the point of the phase — for each of a
list of parameters, assert that changing it at a fixed seed leaves everything it should not affect
byte-identical. `doorWidth` already passes today and is the control case.

**Expected fallout:** existing structure seeds change again, as they did when `portal` was added.
Note it in the log.

## Phase 1 — extract the mesh glue — **DONE 2026-08-09**

Shipped as `map-boxes.js` + `test-map-boxes.mjs`, wired into v3, v2 left frozen. Two deviations from
the text below: `box` was extracted as well (v3 uses it for the floor and terrain-catch slabs) under
the name `boxMesh`, and v3 keeps its `boxTransformOnTerrain`/`slabTransformOnTerrain` names as
two-line wrappers that do the terrain sampling and delegate, so no call site outside these two
functions changed. Reference: `docs/subsystems/bots.md`.

### Phase 1 as planned

`instancedBoxes`, `box`, `UNIT_BOX`, `boxTransformOnTerrain` and `slabTransformOnTerrain` exist once
in `bot-viewer-v2.html` and once in `bot-viewer-v3.html` — verified by grep, one occurrence each.
The viewer would be a third copy, and the third copy is where they drift apart.

New `map-boxes.js`:

```js
export const UNIT_BOX;                                  // shared; teardown must never dispose it
export function instancedBoxes(parent, mat, boxes)      // one InstancedMesh per material
export function clearBoxes(parent)                      // teardown honouring the UNIT_BOX guard
export function boxOnGround(x, z, w, h, d, range)       // range null = flat; else {min,max}
export function slabOnGround(x, z, w, d, baseY, h, groundMax)
```

Ground sampling stays with the caller (`footprintRange` needs the terrain field), so the two
transform functions take a resolved range rather than the field — which also makes them pure and
directly testable in `test-map-boxes.mjs`.

Wire **v3** and the new viewer to it. **v2 stays frozen** with its copy; two copies, one of them
frozen, beats three live ones.

*Risk:* this touches v3 while it is working. Mitigate by extracting verbatim first with no behaviour
change, running the full suite, and only then building on it.

## Phase 2 — the viewer — **DONE 2026-08-09**

Shipped as `structure-viewer.html` + `test-structure-viewer.mjs`. Deviations from the text below:

- **Card order changed** — Mode first (it decides what every other card means), and Wall moved up
  next to Structure since `wallHeight` drives lintels and portal decks.
- **A `.panel-head` / `.panel-body` wrapper was needed.** `workshop-panel-theme.js` styles the panel
  root as a non-scrolling flex column; sections appended straight to `#ctrl` clip their own tail.
- **The Bot lighting block is dropped host-side**, by slicing `buildPanel()`'s returned node list
  between its heading and the next one. No `sections` option was added to `bot-viewer-visuals.js`,
  so v2 and v3 are untouched.
- **Generation runs before the terrain bake**, not after: pads come out of the generator and every
  height read afterwards must see the same post-flatten field.
- **The gallery-slot trap was the wrong shape.** `generateOne` does not reject-sample, so an
  oversized specimen does not vanish — it reaches into its neighbour. `SLOT_MIN` is 28 m, which the
  test verifies clears the widest default specimen (8.92 m radius over 200 seeds × 4 kinds), and the
  HUD warns when a raised `buildingMax` outgrows the cell anyway.

### Phase 2 as planned

**Engine block** from `damage-simulator.html:63-138` — `WebGPURenderer` + `await renderer.init()`,
`OrbitControls`, `createLightingRig({ ui: false })`, `createPostFX`, `createVisualSystem`.
`getAudioLevels` is optional; no audio subsystem is needed.

**Panel chrome** from `workshop-panel-theme.js` (`installPanelTheme('#ctrl')` + `createSection`) —
**not** damage-simulator's bespoke CSS. `visuals.buildPanel()` emits nodes that expect the
`.ttl`/`.row`/`.sec` idiom, and the "same UX as v3" requirement is this module. Single scrolling
column of cards; v3's tab bar, search and pin drawer are overkill for one tool.

Cards: Structure (seed + reroll, count, mix, bounds, separation, edge margin, attempts) · Building ·
Pocket · Obstacles · Portal · Wall (thickness, height) · Terrain · Flora · Visuals
(`visuals.buildPanel({heading:false})`) · Presets.

**Two modes.** *Field* — one scattered set over the bounds, i.e. what v3 renders. *Gallery* — N slots
on a grid, each `generateOne` with its own seed, labelled and individually rerollable. The gallery is
where families get found, and it is the only genuinely new UX here.

**Readouts:** placed vs requested (the sampler drops silently), wall/cover/slab counts, footprint,
and minimum slab headroom.

**Terrain and flora are in v1**, per decision. Terrain via `bot-terrain.js` feeding the ground range
into `boxOnGround`; flora via `createBotFlora`, which already takes `{bounds, wallBoxes, coverBoxes,
vineBoxes, pads, groundHeight, flora}` and no-ops when a theme has no flora block. Eco-brutalism is
half growth, so without them the tool cannot judge the theme it was built for.

**Presets** via `bot-viewer-slots.js`, with a **distinct group name**. `STORE_PREFIX` is hardcoded to
`'pcw:bv2:slots:'` and namespaced only by group, so reusing `'maze'` or `'ui'` would share and
corrupt v3's slots.

## Traps (all verified against the code)

| Trap | Consequence |
|---|---|
| `createLightingRig` defaults `ui: true` | a second lighting panel fights the theme |
| `rig.setAzimuth` etc. after `createVisualSystem` owns the rig | `lights.js` recomputes from stale internal state; drive light direction only through the theme |
| `wallHeight` not threaded into `generateStructures` on every rebuild | floating lintels or gaps over every door, silently |
| `visuals.setBounds` not called per rebuild | floor grid, scan ring and shadow box stay aimed at the old bounds |
| flipping a light's `.visible` per frame | recompiles every material in the scene |
| disposing `UNIT_BOX` in teardown | breaks every subsequent rebuild |
| gallery slot bounds under ~26–28 m | `buildingMax` 13 + `edgeMargin` 4 silently place nothing; blank slot reads as a bug |
| `buildPanel()` includes a Bot lighting card | dead controls in a bot-less viewer; consider an additive `sections` option, default-on so v2/v3 are unchanged |

## Interaction with `wall-destruction-plan.md`

That plan carries its own sequencing note; this is the same relationship read from this side, with the
code checked rather than the two documents compared.

**Ordering agrees, and it verifies both ways.** Destruction's Phase 3 step 1 rewrites exactly the six
lines this plan's Phase 1 extracts (`bot-viewer-v3.html:7721-7726`). Extraction first, or it inherits
a moving target.

**`map-boxes.js` stays full-rebuild only.** `clearBoxes` then `instancedBoxes` is all destruction's
dirty pass needs, *provided* the mesh rebuild is cheap next to the corner bake — which destruction's
Phase 0 is what measures. So: no partial-update path designed in now, and none designed out. Keep the
extraction verbatim.

**Per-wall height has a cheaper route than destruction assumes.** That plan says walls carry no `h`
and a horizontal cut needs one added. True for walls, but covers already carry `h` through both paths
that matter — `activeCoverBoxes` (`:7722`) and `sightBlockers` (`:7739`) — and walls differ from
covers in only three places: the material, where height comes from, and the split in the
live-announce payload (`:15882`). A horizontal crumble could be a record moved from `activeWalls` to
`activeCovers` with `h: 1.4`, no schema change. The cost is that it renders in `coverMat`, which may
read wrong for broken concrete. Weigh it when that phase starts.

**The slab work in this plan made one of destruction's traps bigger.** Lintels, window sills,
canopies and portal decks all landed on 2026-08-09; destruction's floating-slab trap now has more
cases than it did before. `bot-structures.js:186` pushes a lintel whose only support is the wall
beside the door, and slabs are already outside `pointInWall` and `sightBlockers` (`:939`).

**Phase 0 here is the cheap moment to clear two of destruction's traps.** Its trap #1 is that
"destructible" is not expressible in the wall data. This phase rewrites all four builders anyway, and
a tag costs no RNG draws — so emitting a destructibility flag and a slab→support reference is nearly
free here and expensive later. Not folded in; noted as available.

**Shared convention.** Both plans front-load fixed-length draw vectors per `plants.js:414`. This
phase lands the worked example in `bot-structures.js` that `fracture()` then copies.

**What the viewer does *not* buy destruction.** `fracture()` is pure and takes a rect, so the viewer
can show fractured variants at no AI cost — but it deliberately skips nav, visibility, corners and
the collider, which is where every destruction risk lives. It validates fracture geometry and nothing
else.

**The two Phase 0s do not collide** — this one is `bot-structures.js`, that one is v3's `applyLayout`
tail. Either can go first.

## Order of work

1. Phase 0, with its tests. Nothing else is worth building first — the tool is close to pointless
   without stable seeds.
2. Phase 1 extraction, verbatim, full suite green.
3. Engine + panel chrome + one themed building on flat ground. Proves the pipeline end to end.
4. Full parameter panel, then terrain, then flora.
5. Gallery mode and presets.
6. Docs: `docs/subsystems/bots.md` cross-reference, a `code-map.html` `TOOL_LINKS` row (this is a
   tool, not a subsystem), and one `agent_log.csv` row per logical change throughout.
