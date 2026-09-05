import os
root = os.path.join(os.path.dirname(__file__), '..', '..')
p = os.path.join(root, 'docs', 'subsystems', 'vegetation.md')
s = open(p, encoding='utf-8').read()

old = """perturb that section's/trait's numeric sliders (independently per slider, clamped to each
slider's own range) by up to the "Mutation degree" fraction of that slider's range — a targeted
reroll, not a full regenerate; it works whether or not the corresponding floating panel is open."""
new = """perturb that section's/trait's numeric sliders (independently per slider, clamped to each
slider's own range) by up to the "Mutation degree" fraction of that slider's range — a targeted
reroll, not a full regenerate; it works whether or not the corresponding floating panel is open.
Integer sliders (step 1: children, sections, segments, leaf count) are rounded after the
perturbation, and the force azimuth wraps around 360 instead of clamping. Until 2026-09-05 neither
happened: a children count of 6.37 made `trees.js`'s `_shuffledSlots` index `arr[5.37]`, leaving
most azimuth slots undefined and 86% of the vertex positions NaN — and every Auto-add species
inherited that. `trees.js` now also rounds `children`/`sections`/`segments` itself (`whole()`), so a
fractional value from any caller builds the nearest whole tree (`test-trees-integer-params.mjs`).

Every slider range covers every stock preset. The 2026-08-13 ranges did not: 37 values across 12
of the 16 ez-tree species fell outside them (Pine Large has 100 children, a 129° droop and a 65 m
trunk; ten species have negative gnarliness), so the panel displayed the clamp while `opts` held
the real value, and a Mutate on a pine collapsed it to ten children. `LEVEL_PARAMS` now runs to
length 80, radius 4, children 120, angle 180, gnarliness −1..1, sections from 1; the non-level
paths (force strength, bark, leaves) are declared once in `PATH_RANGES`, which both the slider
(`rangedSlider`) and the Mutate entry (`rangedMutateEntry`) read, so the two can no longer drift.

`applyAtlas()` always writes the grid from `texSet.leafAtlas` — both texture sets carry one. It used
to write `null` in procedural mode (the default), so "Keep current tree" and Auto-add saved species
with no pinned cell: reloaded in authored mode they drew a random cell per leaf, and in the game
`forest-palette.js` fell back to `spIdx % cells`, handing pines broadleaves. The "Age preview"
slider also now goes through the shared 130 ms `scheduleRegenerate()` debounce like every other
slider instead of rebuilding the tree on every input event."""
assert s.count(old) == 1
s = s.replace(old, new)
open(p, 'w', encoding='utf-8', newline='\n').write(s)

log = os.path.join(root, 'agent_log.csv')
row = ('2026-09-05T09:20,vegetation,"tree-viewer.html;trees.js;test-trees-integer-params.mjs;docs/subsystems/vegetation.md",'
       '"Tree viewer review fixes: Mutate rounds integer sliders and wraps the force azimuth, trees.js rounds children/sections/segments itself '
       '(a fractional children count was NaN geometry, inherited by every Auto-add species); slider ranges widened to cover all 16 stock presets '
       'and declared once for slider and mutate; the leaf atlas cell survives a save in procedural mode; force azimuth resyncs into 0..360; '
       'the age-preview slider uses the shared debounce."\n')
with open(log, 'a', encoding='utf-8', newline='\n') as f:
    f.write(row)
print('docs + log updated')
