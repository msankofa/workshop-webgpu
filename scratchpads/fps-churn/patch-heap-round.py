# Heap profiles read, the task-12 starvation bug fixed, tasks 13/14 for the user.
import json

def patch(path, pairs):
    s = open(path, encoding='utf-8').read()
    for o, n in pairs:
        assert s.count(o) == 1, (path, o[:80]); s = s.replace(o, n)
    open(path, 'w', encoding='utf-8', newline='').write(s); print('patched', path)

p = 'docs/render-tasks.json'
d = json.load(open(p, encoding='utf-8'))
by = {t['id']: t for t in d['tasks']}
t9 = by['t9-allocation-sampling']
if t9['status'] != 'done': t9['status'] = 'done'; t9['doneAt'] = '2026-09-08T23:10:00Z'
t9['outcome'] = ('Read: seven profiles from 19:00Z (before tasks 11 and 12) and two from 19:12Z on the first build of 11 and 12. Recorded with discarded objects included, so they are allocations over the run. Standing still, no trees (1.0 GB sampled): Three’s uniform update bookkeeping is the largest single allocator at 15 to 17% (a range object and a Map entry per changed uniform per object per frame); then the terrain batch-visibility walk each frame (8%), the kill-plane check evaluating the volumetric density field every frame (7%), the legs’ ground probes collecting every ray hit as objects (14% with map-collision), and the field-derivation road queries (10%). '
  'The two profiles on the first 11+12 build found a bug of mine: road queries at 32% and 45% of 2.9 and 4.5 GB, because a landed-but-undelivered tile was neither queued nor in flight, so the window re-requested it every frame and duplicate builds fed the backlog. That is what starved the trees and greyed the grass. Fixed in 48e46c2 (landed tiles stay in the dedupe), e052abd (segment-run index, 5x cheaper queries) and 5803a70 (budget grows with backlog). No profile of the fixed build yet.')
t13 = by['t13-verify-resumable']
t13['criteria'] = 'Reload first: the build must include 48e46c2 (the Tasks tab is served from the same tree, so a hard reload of the game page is enough). Then the same no-plants walking route as your 21:40 recording, no URL flags, one capture; then trees on, walk toward a tree line, one capture. Note grass height, tile colour, and whether trees appear as you walk. A DevTools recording of the no-plants walk, saved into research/stats/, is the direct check that the 80 ms reply handler is gone. One more allocation-sampling profile while walking would show the fixed build’s allocators.'
t13['why'] = 'Your first look at the 11+12 build showed grass on stale field heights, then grey grass and no trees: the field windows were starving on duplicate rebuilds (task 9 outcome). Three commits since fix that; the walk is the check. The stutter you saw go away is the reply handler off the message, and should stay gone.'
if 't14-structures-ab' not in by:
    d['tasks'].append({
        'id': 't14-structures-ab', 'createdAt': '2026-09-08T23:40:00Z', 'status': 'open', 'doneAt': None, 'notes': '', 'files': [],
        'title': 'Structures on against off, walking the same route',
        'criteria': 'On the fixed build, plants off. Walk your route twice for about 30 s: once with Structures on (default), once with the Structures toggle off. One capture each. Note whether the occasional stutters go with the toggle.',
        'why': 'You suspect the remaining stutters are the structures. The code supports it as a candidate: base-game-structure-collision.js builds one structure tile per frame as one unit (the model, its scatter and a BVH bake) with no time budget inside it, the same shape as the tree chunk build was. Its build time is recorded per tile but not in the capture series, so the toggle is the quickest test; if it is the cause, the fix is the same resumable shape as task 11.',
    })
d['updatedAt'] = '2026-09-08T23:40:00.000Z'
json.dump(d, open(p, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)

p = 'docs/render-progress-log.json'
d = json.load(open(p, encoding='utf-8'))
d['entries'].append({
  'at': '2026-09-08T23:40Z',
  'title': 'Heap profiles read; the first task-12 build starved the field windows; three fixes',
  'body': 'Nine allocation-sampling profiles from the user. Before 11 and 12, standing still (1.0 GB sampled): Three uniform update ranges 15 to 17%, terrain batch-visibility walk 8%, kill-plane density scan 7%, ground probes and capsule collision 14%, field-derivation road queries 10%, boxed doubles from hash and matrix math throughout. On the first 11+12 build the user saw grass on stale heights, then grey grass and no trees; its profiles put road queries at 32 and 45% of 2.9 and 4.5 GB. Cause: a landed-but-undelivered tile was neither queued nor in flight, so the window re-requested it every frame and duplicate builds and derivations fed the backlog. Fixes: e052abd indexes segment runs (bounded query 1.9 to 0.4 us on a synthetic network, exact within the radius); 5803a70 grows the delivery budget with the backlog; 48e46c2 keeps landed tiles in the dedupe and serves re-requests a copy. Tests green including a regression test for the re-request. The user reports the hard stutter gone on the 11+12 build. Tasks: 13 (walk both routes on the fixed build, a recording, a profile), 14 (structures on/off A/B; one structure tile builds per frame as one unit, code-supported candidate). Stats tab gains the heap-profile table.',
  'commits': ['d7a4d98', 'e052abd', '5803a70', '48e46c2']
})
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
open(p, 'a', encoding='utf-8').write('\n')

patch('docs/render-pipeline-map.html', [
("Outputs identical by parity test; unseen in a browser, task 13 is the walk.||",
 "Outputs identical by parity test. First browser look: the hard stutter was gone, but grass stood on stale heights, then greyed, and trees stopped spawning: a landed-but-undelivered tile was neither queued nor in flight, so the window re-requested it every frame and duplicate builds fed the backlog (the user's allocation profiles put road queries at 45% of a 4.5 GB run). Fixed in three commits: segment-run index (5x cheaper queries), delivery budget that grows with the backlog, landed tiles kept in the dedupe. Allocators before the change, standing still: Three's uniform update ranges 15 to 17%, terrain batch-visibility walk 8%, kill-plane density scan 7%, ground probes 14%. Task 13 is the walk on the fixed build; task 14 the structures A/B.||"),
("5 dips measured as GC; allocator unnamed</text>", "GC allocators named; field starvation fixed</text>"),
("1. walk both routes again</text>", "1. reload, walk both routes</text>"),
("tasks 11 and 12 shipped, unseen</text>", "three fixes since the first build</text>"),
("2. allocation sampling</text>", "2. structures on / off</text>"),
("what feeds the 68 to 114 ms collections?</text>", "one tile per frame, one unit</text>"),
("The allocation profile is the measurement that ties the collections to their allocator.</li>",
 "The allocation profiles then named the allocators (Three's uniform update ranges first, then our batch-visibility walk, kill-plane scan and ground probes) and caught a starvation bug in the first build of the field change, fixed the same evening.</li>"),
])
print('tasks, log, map done')
