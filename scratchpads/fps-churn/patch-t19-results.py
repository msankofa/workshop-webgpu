# Task 19 results: the clean sharing control and the traced plants-on walk.
import json

def patch(path, pairs):
    s = open(path, encoding='utf-8').read()
    for o, n in pairs:
        assert s.count(o) == 1, (path, o[:80]); s = s.replace(o, n)
    open(path, 'w', encoding='utf-8', newline='').write(s); print('patched', path)

p = 'docs/render-tasks.json'; d = json.load(open(p, encoding='utf-8')); by = {t['id']: t for t in d['tasks']}
t = by['t19-plants-walk-traced']; t['status'] = 'done'; t['doneAt'] = '2026-09-09T03:09:00Z'
t['outcome'] = ('Read. The control landed (02:54Z, walking, plants off, sharing off, same session and route as the 01:50Z shared runs): frame p50 42.5 ms against 17.2 to 17.5, p95 69.5 against 26 to 36, 365 frames per 1000 over 50 ms against 0; uniform writes 121 a frame against 66 to 68; bindings stage 17.4 ms p50 against 2.3; encode 26.4 against 7.4 to 7.7. That is the clean A/B for the shared light uniforms: the same build, session and route, only the flag differs. '
  'The plants-on traced walk (03:08 and 03:09Z, trees and grass on, sharing on): frame p50 33 ms, p95 51 to 64, 63 to 173 per 1000 over 50 ms; 186 to 207 main-scene objects against 94; encode 17 to 18 ms p50 against 7.5; bindings 4.7 against 2.3; nodes 5.1 to 5.4 against 1.5; draw 1.6 to 1.9 against 1.2; the forest and grass slots themselves under 1 ms. So the plant cost while walking is about 100 more objects through the encode, roughly 0.1 ms each, not the plant systems’ own CPU. Frames over 50 ms carry 5 to 12 ms more render call, twice the gap before the frame, long tasks of 49 to 56 ms and more terrain in flight.')
if 't20-forest-object-count' not in by:
    d['tasks'].append({'id': 't20-forest-object-count', 'createdAt': '2026-09-09T03:20:00Z', 'status': 'open', 'doneAt': None, 'notes': '', 'files': [],
      'title': 'Decide how to cut the forest’s object count',
      'criteria': 'Say which, or none, or ask. Each is a Tree look setting you can also try yourself now: (1) variants per species 2 to 1: halves the forest’s meshes (about 45 fewer main-scene objects and 16 fewer shadow objects), every tree of a species then shares one shape. (2) Turn off one LOD rung’s leaves or the far billboard rung: about 16 fewer objects per mesh kind dropped. (3) Leaf shadows off: 16 fewer shadow objects. (4) Something structural from me: one merged draw for every role, not just the far branches, so the forest is a handful of objects regardless of variants; larger, GPU-side cost unknown, the earlier single-role test gained nothing.',
      'why': 'With the light sharing in, the walking frame with plants on is 33 ms against 17 without, and the traced walk puts that cost in the encode of about 100 extra objects at roughly 0.1 ms each, not in the forest or grass systems’ own work. The forest is 82 to 88 main-scene draws plus 32 shadow draws from 16 variants times 9 meshes. Fewer objects is the lever; which objects to give up is a look decision, so it is yours. Arithmetic, not measured: each object removed is worth about 0.1 ms of walking frame.'})
d['updatedAt'] = '2026-09-09T03:20:00.000Z'
json.dump(d, open(p, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)

p = 'docs/render-progress-log.json'; d = json.load(open(p, encoding='utf-8'))
d['entries'].append({'at': '2026-09-09T03:20Z', 'title': 'Clean control for the shared light uniforms; the plant cost is object count',
  'body': 'Control (02:54Z, walking, plants off, sharing off, same session and route as the shared runs): p50 42.5 ms against 17.2 to 17.5, p95 69.5 against 26 to 36, 365 per 1000 over 50 ms against 0, writes 121 against 66 to 68, bindings 17.4 against 2.3, encode 26.4 against 7.5. Plants-on traced walk (03:08 to 03:09Z, sharing on): p50 33 ms, 186 to 207 objects against 94, encode 17 to 18 against 7.5, bindings 4.7, nodes 5.1 to 5.4, draw 1.6 to 1.9, forest and grass slots under 1 ms: the plant cost is about 100 more objects through the encode at roughly 0.1 ms each. Frames over 50 ms carry more render call, twice the gap, 49 to 56 ms long tasks and more terrain in flight. Task 20 asks the user which forest objects to give up (variants, a LOD rung, leaf shadows) or whether to build the all-roles merge.', 'commits': []})
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False); open(p, 'a', encoding='utf-8').write('\n')

patch('docs/render-pipeline-map.html', [
("The before figures are another session, so they carry session variation; the per-frame counts do not.||",
 "Clean control 02:54Z, same session and route, sharing off: p50 42.5 ms, p95 69.5, 365 per 1000 over 50, 121 writes, bindings 17.4 ms; sharing on: 17 ms, 26 to 36, 0, 66 to 68, 2.3. Plants on with sharing (03:08Z): 33 ms p50 from 186 to 207 objects against 94, encode 17 to 18 against 7.5, the forest and grass slots under 1 ms: the plant cost is object count through the encode, about 0.1 ms each. Task 20 asks which forest objects to give up.||"),
("shared light uniforms: walking p50 41 to 17 ms</text>", "A/B same session: 42.5 to 17 ms walking</text>"),
("2. walk with plants on (task 13)</text>", "2. forest object count (task 20)</text>"),
("the fixed build, trees and grass back</text>", "plants = +100 objects = +16 ms walking</text>"),
])
patch('scratchpads/fps-churn/stats-evening.mjs', [
("  const caps = entries.filter(e => e.capturedAt >= '2026-09-09T00:20' && e.capturedAt < '2026-09-09T02:00' && e.context?.render?.trace?.enabled);",
 "  const caps = entries.filter(e => e.capturedAt >= '2026-09-09T00:20' && e.capturedAt < '2026-09-09T04:00' && e.context?.render?.trace?.enabled);"),
("    const three = e.context?.render?.three; const build = three ? (three.sharedLightUniforms ? 'shared lights' : 'vendored, sharing off') : 'CDN 0.184';",
 "    const three = e.context?.render?.three; const plants = e.settingsAtStart?.treesEnabled ? ', plants on' : ''; const build = (three ? (three.sharedLightUniforms ? 'shared lights' : 'vendored, sharing off') : 'CDN 0.184') + plants;"),
("Sessions differ, so the frame times compare loosely; the per-frame write and stage figures compare directly.</p>",
 "Sessions differ, so the frame times compare loosely; the per-frame write and stage figures compare directly. The 02:54 row is the clean control: same session and route, sharing off, 121 writes and a 17.4 ms bindings stage. The 03:08 rows are trees and grass on with sharing: about 100 more objects, encode 17 to 18 ms, the plant systems' own slots under 1 ms.</p>"),
])
print('t19 results written')
