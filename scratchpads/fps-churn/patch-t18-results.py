# Task 18 results: shared light uniforms measured in the browser.
import json

def patch(path, pairs):
    s = open(path, encoding='utf-8').read()
    for o, n in pairs:
        assert s.count(o) == 1, (path, o[:80]); s = s.replace(o, n)
    open(path, 'w', encoding='utf-8', newline='').write(s); print('patched', path)

p = 'docs/render-tasks.json'; d = json.load(open(p, encoding='utf-8')); by = {t['id']: t for t in d['tasks']}
t = by['t18-shared-lights-check']; t['status'] = 'done'; t['doneAt'] = '2026-09-09T01:54:00Z'
t['notes'] = (t['notes'] + ' ' if t['notes'] else '') + '[user: nothing looks weird in default]'
t['outcome'] = ('Read (01:49 to 01:53Z, plants and structures off, same route as last night). Walking with the patch: 66 to 68 uniform writes a frame (117 to 197 last night), main-scene bindings stage 2.0 to 3.3 ms (9 to 18), encode 6 to 8 ms (18 to 21), frame p50 17.2 to 17.5 ms (21.8 to 40.6), p95 26 to 36 (42 to 72), no frame over 50 ms in either walk (5 to 243 per 1000 last night). Standing unchanged at 33 writes and 13.3 ms. The remaining moving writes are legitimate per-object matrices (18 unnamed basic-material meshes, the points, the laser beam, water, clouds). Your look found nothing wrong. '
  'The two control captures did not run as a control: the URL was ?trace=1?sharedlights=0, so neither flag parsed; they are plain captures with the patch on (p50 17.4 walking, matching the traced ones, so the trace itself costs little here). The before numbers are last night’s captures on the same route, a different session, so the comparison carries session variation. If you want the clean control, one walking capture with base-game.html?trace=1&sharedlights=0 (ampersand) gives it; not required.')
d['updatedAt'] = '2026-09-09T02:10:00.000Z'
json.dump(d, open(p, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)

p = 'docs/render-progress-log.json'; d = json.load(open(p, encoding='utf-8'))
d['entries'].append({'at': '2026-09-09T02:10Z', 'title': 'Shared light uniforms measured: walking bindings 9 to 18 ms down to 2 to 3, frame p50 40 to 17',
  'body': 'Five captures on the vendored build, plants and structures off, same route as the 00:25Z pair. Walking: 66 to 68 uniform writes a frame against 117 to 197; main-scene bindings stage 2.0 to 3.3 ms against 9 to 18; encode 6 to 8 against 18 to 21; frame p50 17.2 to 17.5 ms against 21.8 to 40.6; p95 26 to 36 against 42 to 72; zero frames over 50 ms against 5 to 243 per 1000. Standing unchanged (33 writes, 13.3 ms). The user saw nothing wrong in the default scene. Remaining moving writes are per-object matrices of moving objects. The intended sharedlights=0 control did not run (a second ? in the URL, so neither flag parsed; those two are plain patched captures at p50 17.4 walking, which also says the trace costs little). The before figures are from a different session on the same route, so the comparison carries session variation; the write and bindings counts are the same-frame measurements and do not.', 'commits': ['72977c0']})
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False); open(p, 'a', encoding='utf-8').write('\n')

patch('docs/render-pipeline-map.html', [
("Task 17: patch the vendored Three, move the batches off InstancedMesh, or accept.||",
 "Shipped as a vendored Three (72977c0): light and shadow uniform nodes cached per light so instanced meshes share one render bind group. Measured 01:50Z, same route: walking writes 66 to 68 a frame against 117 to 197, bindings 2 to 3 ms against 9 to 18, frame p50 17 ms against 22 to 41, no frame over 50 ms; standing unchanged; nothing looked wrong. The before figures are another session, so they carry session variation; the per-frame counts do not.||"),
("moving: bindings 2 to 9-18 ms, per-batch camera writes</text>", "shared light uniforms: walking p50 41 to 17 ms</text>"),
("2. share the render group (A/B/C)</text>", "2. walk with plants on (task 13)</text>"),
("7 to 16 ms of a moving frame</text>", "the fixed build, trees and grass back</text>"),
])
patch('scratchpads/fps-churn/stats-evening.mjs', [
("  const caps = entries.filter(e => e.capturedAt >= '2026-09-09T00:20' && e.capturedAt < '2026-09-09T00:30' && e.context?.render?.trace?.enabled);",
 "  const caps = entries.filter(e => e.capturedAt >= '2026-09-09T00:20' && e.capturedAt < '2026-09-09T02:00' && e.context?.render?.trace?.enabled);"),
("    return `<tr><td>${hhmm(e.capturedAt)}</td><td>${moving ? 'moving' : 'standing'}</td><td>${r1(e.performance.frameMs.p50)}</td>",
 "    const three = e.context?.render?.three; const build = three ? (three.sharedLightUniforms ? 'shared lights' : 'vendored, sharing off') : 'CDN 0.184';\n    return `<tr><td>${hhmm(e.capturedAt)}</td><td>${moving ? 'moving' : 'standing'}, ${build}</td><td>${r1(e.performance.frameMs.p50)}</td>"),
("<h3>Standing against moving with the trace on (2026-09-09, 00:24 to 00:26Z; plants and structures off)</h3>",
 "<h3>Standing against moving with the trace on (2026-09-09; plants and structures off; before and after the shared light uniforms)</h3>"),
("The standing per-object writes (water and cloud numbers, one terrain batch number) are ours and small.</p>",
 "The standing per-object writes (water and cloud numbers, one terrain batch number) are ours and small. The 01:49 to 01:50 rows are the vendored build with light and shadow uniform nodes cached per light (72977c0): the same walk writes 66 to 68 a frame and the bindings stage is 2 to 3 ms; the remaining moving writes are per-object matrices of objects that move. Sessions differ, so the frame times compare loosely; the per-frame write and stage figures compare directly.</p>"),
])
print('t18 results written')
