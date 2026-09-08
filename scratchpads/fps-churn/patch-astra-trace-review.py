# One-off: Astra's revisit of the 2026-09-07 DevTools trace (research/stats/trace-task-review-20260907.md).
import json

def rep(s, o, n):
    assert s.count(o) == 1, o[:80]
    return s.replace(o, n)

# ---- tasks ----
p = 'docs/render-tasks.json'
d = json.load(open(p, encoding='utf-8'))
by = {t['id']: t for t in d['tasks']}
t10 = by['t10-devtools-trace-walking']
t10['title'] = 'DevTools performance recording while walking: not needed yet'
t10['criteria'] = 'Nothing to do now. Astra re-read the 2026-09-07 recording task by task and it already names concrete work (see task 11 and the Logs tab). A new recording is only worth your time after a change lands, to check it, or for a measurement this one lacks; I will re-open this with a specific ask if so.'
t10['why'] = 'Aligned by their raw start and end, the long tasks are the page’s own frame callback. In the existing recording the slow ones hold: render preparation that roughly doubles, a synchronous tree chunk build of 20 to 22 ms in two of them (trees on only), GC in 9 of 137, 30 to 52 ms of the thread not running at all in the longest, and three late tasks that were browser layout work with no frame. Several contributors, none explaining all of it.'
t10['status'] = 'done'; t10['doneAt'] = '2026-09-08T21:20:00Z'
t10['outcome'] = 'Closed without a recording: the existing 2026-09-07 trace, re-read task by task, already gave the concrete targets. Report in research/stats/trace-task-review-20260907.md.'
if 't11-tree-build-decision' not in by:
    d['tasks'].append({
        'id': 't11-tree-build-decision', 'createdAt': '2026-09-08T21:20:00Z', 'status': 'open', 'doneAt': None, 'notes': '', 'files': [],
        'title': 'Decide: make the tree chunk build resumable across frames',
        'criteria': 'Say yes, no, or ask. Yes means I change base-game-trees.js so one chunk’s placement and ground-height work spreads over several frames under the existing budget; same seed, same candidates, same heights, so the trees land in the same places, only the frame a chunk appears in changes. Node test of placement parity before and after; you look at a tree line while walking for pop-in.',
        'why': 'Today buildChunk places about 41 candidates (with shore samples) and then asks the volumetric ground height for each, all inside one frame; the per-frame budget is only checked between chunks, so it cannot stop a slow one. Astra measured that build at 20.8 and 22.4 ms inside two 76 to 79 ms frames in the 2026-09-07 recording (with the ground scans 11 and 8 ms and the surface height 5.5 and 5.7 ms of that). It is the one concrete extra-work path named so far; it applies only with trees on and does not explain the plants-off dips. The forest slot in our captures times the GPU pass only, so this build sat in the “rest” column of the spike table. The alternative, moving the height loop to a terrain worker, is larger and changes a contract; I would start with the resumable build.',
    })
d['updatedAt'] = '2026-09-08T21:20:00.000Z'
json.dump(d, open(p, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)

# ---- log ----
p = 'docs/render-progress-log.json'
d = json.load(open(p, encoding='utf-8'))
d['entries'].append({
  'at': '2026-09-08T21:20Z',
  'title': 'Astra re-read the 2026-09-07 recording: a synchronous tree chunk build, GC in a few, layout in three, and time not running',
  'body': 'Astra revisited the existing DevTools trace task by task (research/stats/trace-task-review-20260907.md). Findings: 137 tasks over 50 ms; in two of them a tree chunk build (animate → forest.update → trees.update → flora-chunks.drain → buildChunk → placement with shore sampling on the clipmap window, then per-tree ground height through the volumetric surface scan) took 20.8 and 22.4 ms; GC overlapped only 9 of 137; the longest task was 57 ms of CPU plus 52 ms not running; three late tasks were 19 layout slices each with no frame, trigger unknown. I confirmed against current code: buildChunk is still one indivisible synchronous unit and drain checks the millisecond budget only between builds after the first. Our forest slot times the GPU pass, so this build sat in the unaccounted remainder of the spike decomposition (trees-on runs). Task 10 (new recording) closed as not needed; task 11 asks the user to decide on a resumable chunk build. Nothing changed at runtime.',
  'commits': []
})
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
open(p, 'a', encoding='utf-8').write('\n')

# ---- map ----
p = 'docs/render-pipeline-map.html'
s = open(p, encoding='utf-8').read()
s = rep(s, "Which pause or contention does that needs a DevTools recording (task 10).||",
"Astra then re-read the 2026-09-07 recording task by task: in two slow frames a synchronous tree chunk build took 20.8 and 22.4 ms (placement with shore sampling, then per-tree ground height through the volumetric surface scan), an indivisible unit the between-chunk budget cannot stop; GC overlapped 9 of 137 long tasks; the longest held 52 ms of the thread not running; three late tasks were browser layout with no frame. Several contributors, none general. The tree build is the one named code target (task 11); it applies with trees on only.||")
s = rep(s, "2. DevTools recording, walking</text>", "2. resumable tree chunk build</text>")
s = rep(s, "why does the whole frame slow at once?</text>", "20 to 22 ms per chunk today; needs a yes</text>")
s = rep(s, "The next two measurements are a DevTools allocation profile and a DevTools performance recording; they name code, which the capture cannot.</li>",
"Astra's task-by-task reading of the existing recording names concrete work: a synchronous tree chunk build of 20 to 22 ms in some frames (trees on only), GC in a few, browser layout in three late tasks, and long stretches of the thread not running at all. The tree build is the next change on offer, pending a yes; the allocation profile is the next measurement.</li>")
open(p, 'w', encoding='utf-8', newline='').write(s)
print('patched tasks, log, map')
