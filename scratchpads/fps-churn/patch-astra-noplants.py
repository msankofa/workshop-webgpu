# One-off: Astra's comparison of the user's new no-plants traces (research/stats/no-plants-trace-comparison-20260908.md).
import json

def rep(s, o, n):
    assert s.count(o) == 1, o[:80]
    return s.replace(o, n)

p = 'docs/render-tasks.json'
d = json.load(open(p, encoding='utf-8'))
by = {t['id']: t for t in d['tasks']}
if 't12-field-derive-decision' not in by:
    d['tasks'].append({
        'id': 't12-field-derive-decision', 'createdAt': '2026-09-08T21:50:00Z', 'status': 'open', 'doneAt': None, 'notes': '', 'files': [],
        'title': 'Decide: take the field derivation off the worker reply and out of one frame',
        'criteria': 'Say yes, no, or ask. Yes means: worker replies are queued and processed under a per-frame budget instead of inside the message handler; a tile’s cover derivation can pause between texel rows and resume next frame, publishing the tile only when complete; the road distance query gets a distance-only path that allocates nothing per segment. Same inputs, same outputs (Node parity tests on the derivation and the distance query). You walk the same no-plants route and look for late or missing ground cover.',
        'why': 'Your 21:40 moving trace, plants off: one 80 ms main-thread task was the handler for a terrain worker reply. It derived ground cover for every texel of the arriving tile, and for each texel asked the road network how far the nearest trail is, which allocates a Set and a result record per segment; that polyline projection alone held 50 ms of it. Three more reply handlers nearby took 22, 46 and 22 ms. This runs with vegetation off because the field feeds other systems too, so it is not to be simply skipped. Confirmed in current code: the scheduler delivers synchronously from onmessage, and derive has no budget inside a tile.',
    })
t9 = by['t9-allocation-sampling']
t9['why'] += ' Your 21:40 moving trace makes this more pointed: five of its biggest dips (90 to 155 ms frames) were major garbage collections of 68 to 114 ms each, with the heap at 162 to 243 MB before and 135 MB after; the stationary trace had none. The collection is measured; what allocates is not, and the per-texel road queries above are a code-supported candidate, not a proven one.'
d['updatedAt'] = '2026-09-08T21:50:00.000Z'
json.dump(d, open(p, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)

p = 'docs/render-progress-log.json'
d = json.load(open(p, encoding='utf-8'))
d['entries'].append({
  'at': '2026-09-08T21:50Z',
  'title': 'The user’s new no-plants traces: five dips are major GC, one is a synchronous field derivation',
  'body': 'Astra compared the 21:37 stationary and 21:40 moving recordings (both ?gputime=1, plants off; research/stats/no-plants-trace-comparison-20260908.md, analyzer scratchpads/fps-churn/compare-no-plants-traces.py). Stationary: 1987 frames, p50 13.3 ms, none over 50. Moving: 1866 frames, p50 19.5, 11 over 50. Five of the largest moving dips (90 to 155 ms) contain main-thread major collections of 68 to 114 ms (finalize incremental marking; pointer-update phases 50 to 89 ms), heap 162 to 243 MB before and 135 MB after; the stationary trace had no major GC. Separately, an 80 ms task was the handler for a terrain worker reply: field-scheduler onResult → fanOut/deliver → field-window onTile → flora-field derive (every texel) → trails clearanceAt → road-index nearestDistance → polyline projection, 50 ms of it in projectPointToSegmentXZ; three more replies nearby cost 22, 46 and 22 ms. Confirmed against current code: delivery is synchronous inside onmessage, derive has no budget within a tile, nearestDistance allocates a Set per query and a record per segment. Baseline render CPU about 7 ms per stationary and 14 ms per moving frame (sampled, approximate). Task 12 asks the user to decide on a budgeted reply queue, resumable derivation and an allocation-free distance query; the allocation profile (task 9) is what can tie the GC to its allocator. Nothing changed at runtime.',
  'commits': []
})
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
open(p, 'a', encoding='utf-8').write('\n')

p = 'docs/render-pipeline-map.html'
s = open(p, encoding='utf-8').read()
s = rep(s, "The tree build is the one named code target (task 11); it applies with trees on only.||",
"The tree build is a named code target (task 11); it applies with trees on only.|The user's 21:37 and 21:40 recordings, plants off: standing, no frame over 50 ms; walking, 11. Five of the largest walking dips (90 to 155 ms) are main-thread major garbage collections of 68 to 114 ms, heap 162 to 243 MB before and 135 after; standing had none. Measured cause for those five; the allocator is unnamed. One more 80 ms task was a terrain worker reply handled synchronously: cover derived for every texel of the tile, each texel asking the road index for the nearest trail distance, 50 ms of it in the segment projection; three more replies nearby cost 22 to 46 ms. Task 12 asks for a budgeted reply queue, resumable derivation and an allocation-free distance query.||")
s = rep(s, "CPU-bound: GPU ≤ 2 ms, workers no effect</text>", "CPU-bound: major GC + sync field derive</text>")
s = rep(s, "whole frame slows together; cause open</text>", "5 dips measured as GC; allocator unnamed</text>")
s = rep(s, "1. allocation sampling, standing</text>", "1. field derive off the reply (yes?)</text>")
s = rep(s, "who allocates 30 MB/s at rest?</text>", "80 ms reply handler, plants off</text>")
s = rep(s, "3. push decision</text>", "3. allocation sampling</text>")
s = rep(s, "forest modes stay off; risk is low</text>", "what feeds the 68 to 114 ms collections?</text>")
s = rep(s, "4. per-draw CPU cost</text>", "4. push decision</text>")
s = rep(s, "11 to 16 ms for 180 to 260 draws</text>", "forest modes stay off; risk is low</text>")
s = rep(s, "The tree build is the next change on offer, pending a yes; the allocation profile is the next measurement.</li>",
"The user's own recordings then settled the plants-off case further: five of the largest walking dips are major garbage collections of 68 to 114 ms (the heap climbs from 135 to over 200 MB between them), and one more is a terrain worker reply handled synchronously, deriving ground cover for every texel of the tile with a road-distance query per texel. Two changes are on offer pending a yes: a resumable tree chunk build, and a budgeted reply queue with resumable derivation and an allocation-free distance query. The allocation profile is the measurement that ties the collections to their allocator.</li>")
open(p, 'w', encoding='utf-8', newline='').write(s)
print('patched tasks, log, map')
