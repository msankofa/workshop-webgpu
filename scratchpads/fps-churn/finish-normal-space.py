# Collapse the added multi-line comment runs in forest-gpu.js to one line, then record task 24.
import json, re, subprocess
diff = subprocess.run(['git', 'diff', '-U0', 'forest-gpu.js'], capture_output=True, text=True, encoding='utf-8').stdout
added = set()
for m in re.finditer(r'^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@', diff, re.M):
    start = int(m.group(1)); n = int(m.group(2) or 1); added.update(range(start, start + n))
lines = open('forest-gpu.js', encoding='utf-8').read().split('\n')
out = []; i = 0; collapsed = 0
while i < len(lines):
    if (i + 1) in added and re.match(r'^\s*//', lines[i]) and not lines[i].strip().startswith('// ----'):
        j = i; texts = []
        while j < len(lines) and (j + 1) in added and re.match(r'^\s*//', lines[j]) and not lines[j].strip().startswith('// ----'):
            texts.append(re.sub(r'^\s*//\s?', '', lines[j]).strip()); j += 1
        if j - i > 1: collapsed += 1
        out.append(re.match(r'^\s*', lines[i]).group(0) + '// ' + ' '.join(texts)); i = j
    else:
        out.append(lines[i]); i += 1
open('forest-gpu.js', 'w', encoding='utf-8', newline='').write('\n'.join(out)); print('collapsed', collapsed)

p = 'docs/render-tasks.json'; d = json.load(open(p, encoding='utf-8')); by = {t['id']: t for t in d['tasks']}
t = by['t24-leaf-normal-space']
t['title'] = 'Forest lighting fix is in (normal in view space): compare the two forms under a low sun'
t['criteria'] = 'Reload. Default is the corrected form. Stand still near a tree under a low sun and turn a quarter turn: the lit side of the canopy and trunk should stay on the sun’s side. Then base-game.html?leafnormal=world (today’s old form) and do the same: the lit side should follow your turn. Say which you saw in each, and whether anything else about leaves or bark looks different (edges, shadows, the far rungs).'
t['why'] = 'From the generated shader: the yaw-rotated normal was fed straight into the view-space slot. Now it is transformed in the vertex stage with Three’s own node (model normal matrix, then camera view matrix) before it crosses as the varying, and the fragment renormalizes the interpolated result, as Three does for its own geometry normal; the fragment still loads nothing from the instance buffers. All leaf, bark and shadow-role materials share the one change; the merged bark prototype transforms at the end instead because its tangent frame is built from world positions. Unchanged and stated: a custom normal still gets no back-face flip, so the backs of the double-sided near leaf cards light as their fronts. Tests: 78 checks on the generated WGSL for both forms; the refresh policy allowlist still accepts all nine roles. Unverified: your look.'
d['updatedAt'] = '2026-09-10T06:20:00.000Z'
json.dump(d, open(p, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)
p = 'docs/render-progress-log.json'; d = json.load(open(p, encoding='utf-8'))
d['entries'].append({'at': '2026-09-10T06:20Z', 'title': 'Forest normal-space correction, default on, old form behind leafnormal=world',
  'body': 'forest-gpu.js instanceNodes wraps the yaw-rotated normal in Three’s transformNormalToView (modelNormalMatrix then cameraViewMatrix) in the vertex stage before the v_forestNormal varying, and the fragment normalizes the interpolated result; option normalSpace view|world, default view; world reproduces the previous shader exactly. All eight instanceNodes materials (leaves, bark, both shadow roles) take the one change; the merged pulled bark path keeps a world-space varying (its derivative tangent frame is world-space) and transforms the finished normal in normalFor. Plumbing: forestNormalSpace default, palette key, panel select, ?leafnormal=world, stats.normalSpace. Tests: test-forest-leaf-shaders asserts in view the vertex line writing v_forestNormal carries the object normal matrix and render.cameraViewMatrix and the fragment only normalizes it with zero storage bindings and zero draw loads, and in world neither matrix touches it (78 checks); test-forest-object-group still accepts all nine roles (modelNormalMatrix already allowed; cameraViewMatrix is render-group). Stated, unchanged: no back-face flip on a custom normal, so double-sided near leaf card backs light as fronts. Report scratchpads/fps-churn/leaves/04-normal-space-report.md. Unverified: the look; task 24 asks for the quarter-turn comparison of both forms.', 'commits': []})
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False); open(p, 'a', encoding='utf-8').write('\n')
json.load(open('docs/render-tasks.json', encoding='utf-8')); json.load(open('docs/render-progress-log.json', encoding='utf-8')); print('docs ok')
