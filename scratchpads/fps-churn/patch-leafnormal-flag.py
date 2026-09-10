# Same-content switch for the leaf fragment fix, task 22 reworded, task 24 (normal space) proposed.
import json

def patch(path, pairs):
    s = open(path, encoding='utf-8').read()
    for o, n in pairs:
        assert s.count(o) == 1, (path, o[:70]); s = s.replace(o, n)
    open(path, 'w', encoding='utf-8', newline='').write(s); print('patched', path)

patch('base-game.html', [
("  forestDrawMode: BASE_GAME_FOREST_DEFAULTS.forestDrawMode,\n  treeVerticalOffset:",
 "  forestDrawMode: BASE_GAME_FOREST_DEFAULTS.forestDrawMode,\n  forestNormalVarying: BASE_GAME_FOREST_DEFAULTS.forestNormalVarying,\n  treeVerticalOffset:"),
("  'treeBark', 'treeLeaves', 'treeBarkShadows', 'treeLeafShadows', 'forestDrawMode'];",
 "  'treeBark', 'treeLeaves', 'treeBarkShadows', 'treeLeafShadows', 'forestDrawMode', 'forestNormalVarying'];"),
("if (shippedState?.data?.settings) assignLoadedSettings(shippedState.data.settings);",
 "if (shippedState?.data?.settings) assignLoadedSettings(shippedState.data.settings);\n// ?leafnormal=fragment rebuilds the forest with the per-fragment instance normal (the form before b46d0fd) for a same-content A/B.\nif (new URLSearchParams(location.search).get('leafnormal') === 'fragment') settings.forestNormalVarying = false;"),
])
patch('base-game-forest.js', [
("    stats.draws = f.draws; stats.shadowDraws = f.shadowDraws;",
 "    stats.draws = f.draws; stats.shadowDraws = f.shadowDraws; stats.normalVarying = cfg.forestNormalVarying !== false;"),
])

p = 'docs/render-tasks.json'; d = json.load(open(p, encoding='utf-8')); by = {t['id']: t for t in d['tasks']}
t = by['t22-leaves']
t['criteria'] = ('Reload. Look at leaves near and far and at leaf shadows: as before, no dark or flat-lit canopies, no flicker. Then on your route, trees and grass on, structures off, walking captures: '
  '(a) base-game.html?gputime=1 as default; (b) base-game.html?gputime=1&leafnormal=fragment, which rebuilds the forest with the per-pixel normal from before the fix, same picture, so a and b isolate what the fix saved on the GPU; '
  '(c) ?gputime=1 with the Tree leaves toggle off; (d) ?gputime=1 with leaves on and Tree leaf shadows off; (e) base-game.html?trace=1 as default. Toggles are diagnostics, one at a time; the defaults stay. One question mark, ampersands between flags; the Session card shows what the page saw.')
t['why'] = ('Astra: a leaves-off capture is a different workload, not a before/after of the fragment fix, so the fix now has its own same-content switch (?leafnormal=fragment). '
  'Captures a and b measure the fix; c and d separate the leaf and leaf-shadow GPU cost as diagnostics; e gives the CPU side after the fix.')
if 't24-leaf-normal-space' not in by:
    d['tasks'].append({'id': 't24-leaf-normal-space', 'createdAt': '2026-09-09T21:00:00Z', 'status': 'open', 'doneAt': None, 'notes': '', 'files': [],
      'title': 'Decide: fix the forest’s normal space (a lighting bug; it will change how the canopy lights)',
      'criteria': 'Say yes, no, or ask. Yes means: the forest transforms its rotated normal into view space in the vertex stage (transformNormalToView on the varying), behind a flag (?leafnormal=world restores today’s look), a Node test on the generated WGSL, then you look at trees while turning the camera under a low sun.',
      'why': ('Astra read the served Three: a custom normalNode is consumed as a VIEW-space normal, with no transform and no back-face flip. The forest hands it a world-space normal (its instance yaw applied to the local normal, no camera transform). '
              'So the lighting on bark and leaves is computed in the wrong space: turn the camera and the light direction on the canopy turns with you. Pre-existing, not from the fragment fix (b46d0fd keeps the same value). '
              'Fixing it changes the picture, toward correct, which is why it is your call with a look; it costs one matrix multiply per vertex, nothing per pixel.')})
d['updatedAt'] = '2026-09-09T21:00:00.000Z'
json.dump(d, open(p, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)

p = 'docs/render-progress-log.json'; d = json.load(open(p, encoding='utf-8'))
d['entries'].append({'at': '2026-09-09T21:00Z', 'title': 'Same-content switch for the leaf fragment fix; the normal-space bug confirmed pre-existing',
  'body': ('Astra read b46d0fd and ran the 45-check test (passed), and read the served Three: NodeMaterial.setupNormal returns the custom normalNode directly and normalView consumes it as a view-space normal with no transform and no face flip, while the forest supplies a world-space one, so the mismatch is pre-existing on the direct custom-normal path, not a regression. '
           'Done: forestNormalVarying setting (default true, a palette key so a change rebuilds), ?leafnormal=fragment restores the per-fragment form for a same-content A/B, stats.normalVarying in the capture. Task 22 reworded so the fix is measured by that pair and the leaves and leaf-shadow toggles stay diagnostics; task 24 proposes the view-space transform behind a flag as a look decision.'),
  'commits': []})
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False); open(p, 'a', encoding='utf-8').write('\n')
print('docs ok')
