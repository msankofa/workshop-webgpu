# The first foreststatic=1 walks refused every graph (the page's sun casts shadows); record the verdict fix and ask for the walk again.
import json
p = 'docs/subsystems/vegetation.md'; s = open(p, encoding='utf-8').read()
old = """  - **the allowlist** (`forestGraphVerdict`) refuses a render object whose built graph has any
    `updateBefore`/`updateAfter` node, or any OBJECT-typed update node outside"""
new = """  - **the allowlist** (`forestGraphVerdict`) refuses a render object whose built graph has a
    per-object `updateBefore`/`updateAfter` node (a per-render or per-frame one, such as the sun's
    `ShadowNode`, runs once per render id whichever object triggers it, `three.webgpu.js:53079`,
    so it is allowed), any update node in a shared group is allowed (the shadow's bias, radius and
    map-size references are object-typed but live in the render group, which the one refresh per
    material per render writes), and otherwise any OBJECT-typed update node outside"""
assert s.count(old) == 1; s = s.replace(old, new)
open(p, 'w', encoding='utf-8', newline='').write(s)

p = 'scratchpads/fps-churn/static-skip/04-implementation-report.md'; s = open(p, encoding='utf-8').read()
s += """

## Addendum 2026-09-10, 21:30: the first browser walks refused every graph

The user's two `?trace=1&foreststatic=1` walks reported `skipped: 0`, `refreshed: 88` and `109`,
and `refused: { "updateBefore nodes in the graph": 6 }`. The report's statement that
`updateBeforeNodes` is empty for all nine roles was true of the test scene and false of the page:
the page's sun casts shadows, and a shadow-casting light puts Three's `ShadowNode` into the graph as
an `updateBefore` node of type `render`, plus five object-typed `ReferenceNode`s (`bias`,
`normalBias`, `radius`, `mapSize`, `intensity` on the `DirectionalLightShadow`). Probed headless
with `castShadow = true` against both the stock and the vendored build
(`scratchpads/fps-churn/probe-updatebefore.mjs`, run through `vendor-three-register.mjs` for the
vendored one): identical lists, and all five references sit in the shared `render` group.

The verdict now refuses only a per-object `updateBefore`/`updateAfter` node — a per-render one runs
once per render id whichever object triggers it (`NodeFrame.updateBeforeNode`,
`three.webgpu.js:53079`), so the one refresh per material per render serves it — and allows any
update node whose uniform group is shared, since that first refresh writes the shared buffer every
mesh binds. `test-forest-object-group.mjs` now builds a role under a shadow-casting sun, asserts the
`ShadowNode:render` updateBefore and the render-group references are present, and that the verdict
allows it (69 checks). The two walks are void as a measurement of the policy: with and without the
flag every object refreshed (217/217), and the frame, bindings and nodes figures of the five
captures are the same within their spread. The walk is asked for again.
"""
open(p, 'w', encoding='utf-8', newline='').write(s)

p = 'docs/render-tasks.json'; d = json.load(open(p, encoding='utf-8')); by = {t['id']: t for t in d['tasks']}
t = by['t21-static-refresh-skip']
t['title'] = 'Forest refresh policy: your first walks skipped nothing (my fault); one more walk with it on'
t['criteria'] = 'Reload first. Then base-game.html?trace=1&foreststatic=1, trees and grass on, structures off, your route: one walking capture, and a look at the trees while you walk and turn. The trace’s main-scene count should now read well under 217 of 217; if it still reads equal, stop there and say so. Any tree that fails to update, flickers, or lights wrongly matters. The ?trace=1 control you already took stands.'
t['outcome'] = (t.get('outcome', '') + ' 21:17 and 21:24 (2026-09-10): five walking captures, two with the flag on. The flag-on ones skipped nothing: every forest graph was refused with “updateBefore nodes in the graph” because the page’s sun casts shadows and the test scene did not, so all five captures read the same (frame p50 28 to 31 ms, bindings stage 4.1 to 4.3, nodes 4.6 to 5.1, every object refreshed). The verdict is fixed and tested under a shadow-casting sun; the walk is asked for again.').strip()
d['updatedAt'] = '2026-09-10T21:40:00.000Z'
json.dump(d, open(p, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)
p = 'docs/render-progress-log.json'; d = json.load(open(p, encoding='utf-8'))
d['entries'].append({'at': '2026-09-10T21:40Z', 'title': 'First foreststatic=1 walks skipped nothing: the shadow-casting sun was refused; verdict fixed',
  'body': 'The user’s two ?trace=1&foreststatic=1 captures: skipped 0, refreshed 88 and 109, refused {"updateBefore nodes in the graph": 6}. Cause: the page’s sun casts shadows, which puts Three’s ShadowNode (updateBeforeType render) and five object-typed ReferenceNodes (bias, normalBias, radius, mapSize, intensity on the DirectionalLightShadow) into every forest graph; the test scene’s light cast none, so “updateBeforeNodes empty for all nine” was a fact about the test, not the page. Probed headless against both the stock and the vendored build (identical); the five references sit in the shared render group. Verdict change: refuse only a per-object updateBefore/updateAfter (a per-render one runs once per render id whichever object triggers it, three.webgpu.js:53079); allow any update node whose group is shared. test-forest-object-group builds a role under a shadow-casting sun and asserts the ShadowNode and render-group references are present and allowed (69 checks); every forest suite and the page syntax pass. Measurement: the five captures (three control, two flag-on) read the same within spread: frame p50 28.0 to 31.4 ms, p95 44 to 52, bindings stage p50 4.1 to 4.3, nodes 4.6 to 5.1, main-scene refreshes 184 to 217 of the same. So nothing is known yet about the policy’s effect. Task 21 asks for one flag-on walk again.', 'commits': []})
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False); open(p, 'a', encoding='utf-8').write('\n')
json.load(open('docs/render-tasks.json', encoding='utf-8')); json.load(open('docs/render-progress-log.json', encoding='utf-8')); print('docs ok')
