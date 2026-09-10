# Collapse the implementation's multi-line comment runs in forest-gpu.js's ADDED lines into one line each
# (repo rule: one-line comments), then record the round in tasks and log.
import json, re, subprocess
diff = subprocess.run(['git', 'diff', '-U0', 'forest-gpu.js'], capture_output=True, text=True, encoding='utf-8').stdout
added = set()
for m in re.finditer(r'^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@', diff, re.M):
    start = int(m.group(1)); n = int(m.group(2) or 1)
    added.update(range(start, start + n))
lines = open('forest-gpu.js', encoding='utf-8').read().split('\n')
out = []; i = 0; collapsed = 0
while i < len(lines):
    ln = i + 1
    if ln in added and re.match(r'^\s*//', lines[i]) and not lines[i].strip().startswith('// ----'):
        j = i; texts = []
        while j < len(lines) and (j + 1) in added and re.match(r'^\s*//', lines[j]) and not lines[j].strip().startswith('// ----'):
            texts.append(re.sub(r'^\s*//\s?', '', lines[j]).strip()); j += 1
        indent = re.match(r'^\s*', lines[i]).group(0)
        if j - i > 1: collapsed += 1
        out.append(indent + '// ' + ' '.join(texts)); i = j
    else:
        out.append(lines[i]); i += 1
open('forest-gpu.js', 'w', encoding='utf-8', newline='').write('\n'.join(out))
print('collapsed comment runs:', collapsed)

p = 'docs/render-tasks.json'; d = json.load(open(p, encoding='utf-8')); by = {t['id']: t for t in d['tasks']}
t = by['t21-static-refresh-skip']
t['title'] = 'Forest refresh policy is in, off by default: one walk with it on'
t['criteria'] = 'Reload. Look at the trees first with nothing changed (the policy is off, so nothing should differ). Then base-game.html?trace=1&foreststatic=1, trees and grass on, structures off, your route: one walking capture, and a look at the trees while you walk and while you turn: any tree that fails to update, flickers, or lights wrongly matters. Then the same walk with base-game.html?trace=1 (policy off) as the control. Two captures.'
t['why'] = 'Built to Astra’s contract and reviewed: forest-gpu.js gives its nine materials their own refresh policy (a mesh never seen refreshes fully; the first mesh of each material each render refreshes; every other marked mesh refreshes only when the forest marked it changed or its material version, geometry or world matrix differ from the last refresh), the clean mark commits only from Three’s after-update hook so a failed refresh is retried, unknown graphs are refused, and the merged and billboard modes stay outside. Tests: the decision table, the adversarial set (one mesh’s geometry mutated, alternating order, rebuild, rebase, three passes in one frame, flag off, throwing update, real setters), and the per-role object-group set on the Base Game configuration; all nine roles accepted. The normal-matrix uniform is Three’s own, computed from the world matrix only, so it does not depend on the camera. Measurement: the trace’s refreshed-over-checked count for the main scene (204 of 204 today) and the encode stages; no milliseconds promised.'
d['updatedAt'] = '2026-09-10T05:40:00.000Z'
json.dump(d, open(p, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)
p = 'docs/render-progress-log.json'; d = json.load(open(p, encoding='utf-8'))
d['entries'].append({'at': '2026-09-10T05:40Z', 'title': 'Forest refresh policy implemented, off by default, to the review contract',
  'body': 'forest-gpu.js: ForestNodeMaterial (a subclass of MeshStandardNodeMaterial) overrides setupObserver with a policy: firstInitialization always refreshes; the first render object of a material per render refreshes; a marked mesh otherwise refreshes when its forestEpoch, material.version, geometry id or world matrix differ from what was recorded at its last committed refresh; the clean mark commits from a runtime wrap of renderer._nodes.updateAfter, which Three calls only after the four gated updates and the draw, so a throwing update or a not-ready pipeline is retried (tested through the update path). forestGraphVerdict allows only UniformGroupNode(object), UserDataNode slotOffset, ModelNode worldMatrix, Three’s modelNormalMatrix singleton (asserted by identity; computed from object.matrixWorld alone at three.webgpu.js:14622, so camera-independent) and MaterialReferenceNode; anything else refuses the skip with the reason in stats; all nine roles accepted on the real Base Game configuration (which passes no addEmissive); an injected onObjectUpdate uniform is refused. invalidate() at setTreeScale, setLeafScale, setLeafSway (now guarded on value change; it ran every syncRenderState), installVariant geometry swap and indirect needsUpdate, arena uploads; the merged mesh and billboards carry no epoch and delegate. Rebase verified to move no forest mesh. Off by default: staticRefresh option, forestStaticRefresh setting with a panel toggle, ?foreststatic=1. Tests test-forest-static-observer.mjs and test-forest-object-group.mjs plus every forest test and the page syntax: green. Report scratchpads/fps-churn/static-skip/04-implementation-report.md. Unverified: the browser count and the picture; task 21 asks for the two walks.', 'commits': []})
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False); open(p, 'a', encoding='utf-8').write('\n')
json.load(open('docs/render-tasks.json', encoding='utf-8')); json.load(open('docs/render-progress-log.json', encoding='utf-8')); print('docs ok')
