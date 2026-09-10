# Astra's task 21 review: withdraw the premature framing, retire GPU-bound/CPU-bound conclusions that rested on the
# timestamp columns, reframe task 24 as a correctness defect with a demonstration, and log it.
import json

def patch(path, pairs):
    s = open(path, encoding='utf-8').read()
    for o, n in pairs:
        assert s.count(o) == 1, (path, o[:70]); s = s.replace(o, n)
    open(path, 'w', encoding='utf-8', newline='').write(s); print('patched', path)

patch('docs/render-pipeline-map.html', [
("GPU pass time is under 2 ms in every frame measured; the frame is main-thread time, 11 to 16 ms in the render call for 180 to 260 draws with plants off, and in a dip frame everything on the main thread slows together:",
 "The render call is 11 to 16 ms of main-thread time for 180 to 260 draws with plants off (the GPU timestamp columns that once read under 2 ms are set aside: Three returns a stale value while a resolve is pending and the page recorded it, so no GPU-bound or CPU-bound conclusion is drawn from them), and in a dip frame everything on the main thread slows together:"),
("GPU pass execution is not where the 40 to 130 ms frames go; the render call is 11 to 16 ms of main-thread time at 180 to 260 draws. Timestamps are a frame late, quantized at about 65 us, and exclude presentation.",
 "The GPU timestamp columns are set aside: they read lower moving than standing, Three hands back a stale value while a resolve is pending and the page recorded it, and the query pool refuses queries past 2048. The render call is 11 to 16 ms of main-thread time at 180 to 260 draws; whether the GPU is also loaded in the dips is unmeasured."),
("CPU-bound: major GC + sync field derive", "main thread: major GC + sync field derive; GPU unmeasured"),
("GPU pass execution stays under 2 ms in the worst frame of every run while the render call costs 11 to 33 ms of main-thread time. The frame is CPU-bound, and the 40 to 130 ms frames are not GPU pass time.",
 "These GPU columns are set aside: they read lower moving than standing, which is not physical for a whole frame, and Three returns a stale value while a resolve is pending, which the page recorded. The render call costs 11 to 33 ms of main-thread time; the GPU share of a dip frame is unmeasured until the accounting is fixed."),
])
patch('scratchpads/fps-churn/stats-evening.mjs', [
("GPU pass execution stays under 2 ms in the worst frame of every run while the render call costs 11 to 33 ms of main-thread time. The frame is CPU-bound, and the 40 to 130 ms frames are not GPU pass time.",
 "These GPU columns are set aside: they read lower moving than standing, which is not physical for a whole frame, and Three returns a stale value while a resolve is pending, which the page recorded. The render call costs 11 to 33 ms of main-thread time; the GPU share of a dip frame is unmeasured until the accounting is fixed."),
])

p = 'docs/render-tasks.json'; d = json.load(open(p, encoding='utf-8')); by = {t['id']: t for t in d['tasks']}
t21 = by['t21-static-refresh-skip']
t21['title'] = 'Static refresh skip for the forest: design and evidence in progress; not yet a decision'
t21['criteria'] = 'Nothing to decide yet. Astra’s review: the “identical picture” and “safe to skip” framing was premature. Each forest mesh has private object state (its slot offset uniform, its own geometry and indirect buffers), so meshes sharing a material are not interchangeable, and the events that must force a refresh (texture rebinding, a render-origin rebase, a palette rebake, geometry replacement, LOD and sway changes) have to be enumerated and shown to be caught, from the generated shader and binding layout, before a change is proposed. An agent is producing that contract and the design now. You get a decision only if the contract closes.'
t21['why'] = 'The measured basis stands: with plants on, 204 to 207 objects and 14 to 19 ms of encode against 94 and 6.6 ms without, on the full build, and the forest’s 144 meshes refresh every frame because Three’s observer refreshes any node material. Whether they can be skipped without breaking anything is exactly what has not been shown. The earlier “about 9 ms” figure was an unvalidated upper-bound projection; the measurement, if built, is the trace’s refreshed-over-checked count and the encode stages on the same route.'
t24 = by['t24-leaf-normal-space']
t24['title'] = 'Forest lighting defect: the normal is in the wrong space (a correctness fix, demonstrated before it is applied)'
t24['criteria'] = 'No decision needed to demonstrate it. Next step is mine: a headless check that the generated forest shaders pass the custom normal straight into the view-space slot with no camera transform, then a fixed-light, fixed-tree demonstration for you: stand still under a low sun, turn the camera a quarter turn, and watch whether the lit side of the canopy turns with you (it should not). The fix (view-space transform of the rotated normal in the vertex stage) then goes in behind a flag that keeps today’s rendering for comparison; you compare the two.'
t24['why'] = 'Astra read the served Three: NodeMaterial.setupNormal returns the custom normalNode directly and normalView consumes it as view space, with no transform and no face flip; the forest supplies a world-space normal. That is a lighting bug, not a quality preference, and Astra asked that it not be framed as an optional downgrade. It predates the fragment fix. Cost of the fix: one matrix multiply per vertex.'
d['updatedAt'] = '2026-09-10T03:30:00.000Z'
json.dump(d, open(p, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)

p = 'docs/render-progress-log.json'; d = json.load(open(p, encoding='utf-8'))
d['entries'].append({'at': '2026-09-10T03:30Z', 'title': 'Astra’s task 21 review applied: framing withdrawn, GPU-bound conclusions retired, design work launched',
  'body': 'Astra: task 21 must not be presented as identical picture or safe to skip before the contract is proven; forest meshes sharing a material carry private object state (userData slotOffset per mesh, own geometry and indirect buffers), so a once-per-material refresh maintains shared state but does not validate every skipped object’s resources; the events forcing a refresh must be enumerated and shown caught from generated shader and binding layouts; uniformWriteRows are top-16 rows of one retained frame, not full-frame counts; the 9 ms was an unvalidated upper bound. Also: withdraw categorical GPU-bound and CPU-bound conclusions that rested on the timestamp columns; lower sampled MB across profiles of different durations and instrumentation does not quantify the allocation pass (its parity and code-level evidence stands); the normal-space defect is a correctness issue to demonstrate with a fixed light and camera rotation, not an optional downgrade. Done: map, Problem tab and stats reworded (GPU columns set aside, “main thread” instead of “CPU-bound”); task 21 reworded as design in progress with an Opus agent producing what the gate skips, the forest object contract from generated bindings, and the smallest provable design or none; task 24 reworded as a defect with a demonstration plan. The user was told.', 'commits': []})
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False); open(p, 'a', encoding='utf-8').write('\n')
json.load(open('docs/render-tasks.json', encoding='utf-8')); json.load(open(p, encoding='utf-8'))
print('review applied')
