# Second flag-on walk refused every graph again (authored textures): record the fix and ask once more.
import json
p = 'docs/subsystems/vegetation.md'; s = open(p, encoding='utf-8').read()
old = """    `modelNormalMatrix` singleton (by identity — it reads `object.matrixWorld` alone, so it is
    camera-independent) and `MaterialReferenceNode`. A host's `addEmissive` that adds a per-object"""
new = """    `modelNormalMatrix` singleton (by identity — it reads `object.matrixWorld` alone, so it is
    camera-independent), `MaterialReferenceNode`, and a `TextureNode` over a real texture (an
    authored map is object-typed for its uv-matrix uniform, `three.webgpu.js:12467`; the verdict
    lists those textures and every mark records each one's `matrix` and `version`, so a uv
    transform or image change refreshes every mesh). A host's `addEmissive` that adds a per-object"""
assert s.count(old) == 1; s = s.replace(old, new)
open(p, 'w', encoding='utf-8', newline='').write(s)

p = 'scratchpads/fps-churn/static-skip/04-implementation-report.md'; s = open(p, encoding='utf-8').read()
s += """

## Addendum 2026-09-10, 22:20: the second walk refused every graph too (authored textures)

The re-walk at 22:06 read `skipped: 0`, `refused: { "TextureNode is not on the object-group
allowlist": 6 }`. The page binds authored bark, bark-normal and leaf maps; a material map's
`TextureNode` is object-typed when it carries a uv-matrix (or flipY) uniform
(`three.webgpu.js:12467`), and that uniform is in each mesh's own UBO. The headless harness bound
no textures (`bindTreeMaterials(b, l, null)`), so it never saw one. Same failure shape as the
shadow node: the test scene did not reproduce the page.

Fix: `classifyObjectUpdateNode` allows a `TextureNode` over a real texture, the verdict returns
the distinct textures it saw, and every mark records each texture's `matrix` elements and
`version`; a mismatch refreshes the mesh (`texture.repeat` + `updateMatrix()`, or
`needsUpdate = true`, both tested on the second mesh). A mark made before the verdict existed
(first initialisation) has no texture record and refreshes once more. The object-group test now
builds bark and leaf roles under a shadow-casting sun, with authored textures and `FogExp2`
(Three's fog references are `setGroup(renderGroup)`, `three.webgpu.js:54912`), and asserts the
object-typed `TextureNode` is present and allowed. Suites: object-group 75, static-observer 77,
leaf-shaders 78, forest-cull 48, base-game-forest 123, page syntax clean.

What the page's graph has that the harness now reproduces: shadow-casting sun, authored maps,
FogExp2. What it may still have that the harness does not: nothing known; the next walk's
`refused` map is the check.
"""
open(p, 'w', encoding='utf-8', newline='').write(s)

p = 'docs/render-tasks.json'; d = json.load(open(p, encoding='utf-8')); by = {t['id']: t for t in d['tasks']}
t = by['t21-static-refresh-skip']
t['title'] = 'Forest refresh policy: second walk also skipped nothing (textures this time); one more walk'
t['criteria'] = 'Reload first. Then base-game.html?trace=1&foreststatic=1, trees and grass on, structures off, your route: one walking capture and a look at the trees while you walk and turn. Any tree that fails to update, flickers, or lights wrongly matters. If the count still reads equal, stop and say so; the control stands.'
t['outcome'] = (t.get('outcome', '') + ' 22:06: two more flag-on captures, skipped 0 again, this time refused for the tree textures (an authored map’s node carries a per-mesh uv-matrix uniform; the headless test bound no textures). Fixed: the map node is allowed and every mark records each texture’s transform and version. The test scene now has a shadow-casting sun, authored maps and fog like the page.').strip()
d['updatedAt'] = '2026-09-10T22:20:00.000Z'
json.dump(d, open(p, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)
p = 'docs/render-progress-log.json'; d = json.load(open(p, encoding='utf-8'))
d['entries'].append({'at': '2026-09-10T22:20Z', 'title': 'Second flag-on walk refused every graph again: authored map nodes; allowed with a texture watch',
  'body': 'The 22:06 ?trace=1&foreststatic=1 captures: skipped 0, refused {"TextureNode is not on the object-group allowlist": 6}. The page binds authored bark, bark-normal and leaf maps; a map’s TextureNode is object-typed for its uv-matrix uniform (three.webgpu.js:12467), which lives in each mesh’s own UBO; the harness bound null textures so it never saw one. Fix in forest-gpu.js: TextureNode over a real texture is allowed; forestGraphVerdict returns the distinct textures; every mark records each texture’s matrix elements and version and a mismatch refreshes (repeat+updateMatrix and needsUpdate both tested on the second mesh); a mark made before the verdict refreshes once more. Test scene now: shadow-casting sun, authored maps, FogExp2 (Three’s fog references are render-group, three.webgpu.js:54912). Suites: object-group 75, static-observer 77, leaf-shaders 78, cull 48, base-game-forest 123; page syntax clean. Two harness-versus-page gaps in a row; the next walk’s refused map is the check for a third. Frame numbers of the 22:06 captures are not comparable (one is 85 frames, both read every object refreshed).', 'commits': []})
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False); open(p, 'a', encoding='utf-8').write('\n')
json.load(open('docs/render-tasks.json', encoding='utf-8')); json.load(open('docs/render-progress-log.json', encoding='utf-8')); print('docs ok')
