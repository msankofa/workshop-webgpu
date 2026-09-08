# Docs, tasks, log, map and comms for tasks 11 and 12.
import json

def patch(path, pairs):
    s = open(path, encoding='utf-8').read()
    for o, n in pairs:
        assert s.count(o) == 1, (path, o[:80]); s = s.replace(o, n)
    open(path, 'w', encoding='utf-8', newline='').write(s); print('patched', path)

patch('docs/subsystems/vegetation.md', [
("multiplies all three layers by optional world-trail clearance, and publishes three u8 channels, so a blade reads one number instead of re-running the classifier per candidate — and there is no TSL twin of this math to drift. Pure, no three.js. |",
 "multiplies all three layers by optional world-trail clearance, and publishes three u8 channels, so a blade reads one number instead of re-running the classifier per candidate — and there is no TSL twin of this math to drift. `derive(tile, deadline?)` is resumable (2026-09-08): past the deadline it stops between texel rows and returns `false`, keeps its rows in a WeakMap keyed by the tile, and attaches the channels only when the last row is done, so a paused tile can never commit half-derived. Pure, no three.js. |"),
("Adds `setReadyTest(fn)`: a chunk whose field has not streamed is deferred and retried, never built against a default. Pure, no three.js. |",
 "Adds `setReadyTest(fn)`: a chunk whose field has not streamed is deferred and retried, never built against a default. A build may pause (2026-09-08): `onBuild(chunk, deadline)` returning `false` leaves the chunk pending; the next `drain()` resumes it before starting any other, its key stays in `queuedKeys` so a window move cannot queue it twice, it becomes resident only when a call returns anything else, and a move away, `clear()` or `rebuildAll` abandons it through `onAbandon(fn)`. The deadline is `t0 + budgetMs` in the drain's clock, `Infinity` for a drain-all. `stats.pausedBuilds`, `stats.abandonedBuilds`, `pendingKey`. Pure, no three.js. |"),
("a `flora-chunks` host, `placementRecords` per chunk, and records kept in GLOBAL coordinates",
 "a `flora-chunks` host, a resumable `createPlacementJob` per chunk (placement, then ground heights, each call doing what fits before the drain's deadline; one chunk used to cost 20 to 22 ms in one frame), and records kept in GLOBAL coordinates"),
("export function placementRecords(chunks, params, heightAt, biomeAt?): { x, z, scale, yaw, speciesIdx, chunkKey, slot }[]",
 "export function placementRecords(chunks, params, heightAt, biomeAt?): { x, z, scale, yaw, speciesIdx, chunkKey, slot }[]\nexport function createPlacementJob(chunks, params, heightAt, biomeAt?): { records, done, step(deadline = Infinity): boolean }  // the same records however often step() pauses; placementRecords is step(Infinity)"),
])

patch('docs/subsystems/terrain.md', [
("""  `maxInFlight` caps what is outstanding. With no `Worker` (Node) it builds synchronously inside
  `pump()` under a millisecond budget, so a test drives the same scheduling path the page uses.""",
 """  `maxInFlight` caps what is outstanding. With no `Worker` (Node) it builds synchronously inside
  `pump()` under a millisecond budget, so a test drives the same scheduling path the page uses.
  Results are not delivered from the worker message (2026-09-08): `onResult` lands them in a queue and
  refills the pool; `pump()` then hands landed tiles to their windows under `deliverBudgetMs`
  (default 2). A window's `onTile(tile, deadline)` may return `false` to say its derive step paused at
  the deadline; the entry stays at the head and is handed back next pump, and the head entry always
  gets one call so a late frame still makes progress. One 80 ms reply handler measured on 2026-09-08
  was flora's per-texel derivation running inside `onmessage`. `stats.landed`, `delivered`,
  `deliveriesPaused`, `lastDeliverMs`; `landedCount`, `deliverLanded(deadline)`."""),
])

patch('docs/subsystems/roads.md', [
("| `road-path.js` | Curve evaluation, ground-following sampling, point-to-polyline and segment-crossing queries | no |",
 "| `road-path.js` | Curve evaluation, ground-following sampling, point-to-polyline and segment-crossing queries; `distancePointToSegmentXZ(px, pz, a, b)` is the allocation-free scalar twin of `projectPointToSegmentXZ` and what `distancePointToPolylineXZ` now uses | no |"),
("| `road-index.js` | Uniform 24 m grid index; every \"is there a road here?\" question | no |",
 "| `road-index.js` | Uniform 24 m grid index; every \"is there a road here?\" question. The bounded `nearestDistance` walks its buckets with two reused Sets and no result arrays (2026-09-08), because flora's field derivation asks it once per texel | no |"),
])

# tasks
p = 'docs/render-tasks.json'
d = json.load(open(p, encoding='utf-8'))
by = {t['id']: t for t in d['tasks']}
for tid, outcome in [
  ('t11-tree-build-decision', 'Yes, shipped. base-game-trees.js builds a chunk as a job: placement (forest-placement createPlacementJob, pausing every 16 attempts) then ground heights one record at a time, each drain doing what fits before its deadline; flora-chunks resumes a paused chunk first and abandons it if the window moves. Same seed, candidates and heights: the parity test runs the whole forest at a zero budget and gets byte-identical records and ground heights. Look for pop-in along a tree line while walking.'),
  ('t12-field-derive-decision', 'Yes, shipped. Worker replies now land in a queue and pump() hands them to their windows under a 2 ms budget; flora-field derive pauses between texel rows and attaches the channels only when done; the road index’s bounded nearestDistance walks its buckets with reused Sets and the polyline distance no longer builds a record per segment. Parity tests: derive paused per row equals one-shot; the scalar segment distance is bit-identical; nearestDistance agrees with a full walk inside the radius. Walk the no-plants route again and look for late or missing ground cover.'),
]:
    by[tid]['outcome'] = outcome
    if by[tid]['status'] != 'done': by[tid]['status'] = 'done'; by[tid]['doneAt'] = '2026-09-08T22:30:00Z'; by[tid]['notes'] = (by[tid]['notes'] + ' ' if by[tid]['notes'] else '') + '[user: yes to 11 and 12, go ahead]'
if 't13-verify-resumable' not in by:
    d['tasks'].append({
        'id': 't13-verify-resumable', 'createdAt': '2026-09-08T22:30:00Z', 'status': 'open', 'doneAt': None, 'notes': '', 'files': [],
        'title': 'Walk the no-plants route and the tree line after the two changes',
        'criteria': 'Same no-plants walking route as your 21:40 recording, no URL flags, one capture; then trees on, walk toward a tree line, one capture. Note any late ground cover, missing cover, or trees popping in late. A DevTools recording of the no-plants walk, saved into research/stats/, is the direct check that the 80 ms reply handler is gone.',
        'why': 'Both changes keep the outputs identical by construction and by test; what they change is which frame the work lands in. The capture shows whether the dips over 50 ms fell; the recording shows whether reply handling is now spread out. The five garbage-collection dips are a separate question the allocation profile (task 9) answers.',
    })
d['updatedAt'] = '2026-09-08T22:30:00.000Z'
json.dump(d, open(p, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)

# log
p = 'docs/render-progress-log.json'
d = json.load(open(p, encoding='utf-8'))
d['entries'].append({
  'at': '2026-09-08T22:30Z',
  'title': 'Tasks 11 and 12 shipped: resumable tree build, budgeted field delivery, allocation-free road distance',
  'body': 'User: yes to both. Task 11: forest-placement gains createPlacementJob (the placement generator pauses every 16 attempts; placementRecords is the job run to the end), flora-chunks lets onBuild return false and resumes the pending chunk first next drain (abandoned on a window move, clear or rebuild; key kept in queuedKeys so it never queues twice; resident only on completion), base-game-trees builds a chunk as placement then one ground height per step against the drain’s deadline. Task 12: terrain-field-scheduler lands worker results in a queue and pump() delivers them under deliverBudgetMs (2 ms), a window’s onTile may return false to be handed the same tile next pump, flora-field derive pauses between rows with the channels attached only at the end, road-index nearestDistance walks buckets with two reused Sets, road-path gains distancePointToSegmentXZ. Parity: zero-budget forest byte-identical to the unbudgeted one (records and ground heights); derive paused per row equals one-shot; scalar segment distance bit-identical to the record; nearestDistance agrees with a full walk inside its radius. Eleven test files green. Unseen in a browser; task 13 asks for the walk.',
  'commits': []
})
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
open(p, 'a', encoding='utf-8').write('\n')

# map
patch('docs/render-pipeline-map.html', [
("Task 12 asks for a budgeted reply queue, resumable derivation and an allocation-free distance query.||",
 "Both shipped 2026-09-08 22:30Z: the tree chunk build pauses at the drain's deadline and resumes next frame (task 11); worker replies land in a queue that pump() delivers under a 2 ms budget, derivation pauses between texel rows, and the road distance query allocates nothing per segment (task 12). Outputs identical by parity test; unseen in a browser, task 13 is the walk.||"),
("1. field derive off the reply (yes?)</text>", "1. walk both routes again</text>"),
("80 ms reply handler, plants off</text>", "tasks 11 and 12 shipped, unseen</text>"),
("2. resumable tree chunk build</text>", "2. allocation sampling</text>"),
("3. allocation sampling</text>", "3. push decision</text>"),
("4. push decision</text>", "4. per-draw CPU cost</text>"),
("forest modes stay off; risk is low</text>", "11 to 16 ms for 180 to 260 draws</text>"),
("what feeds the 68 to 114 ms collections?</text>", "forest modes stay off; risk is low</text>"),
("20 to 22 ms per chunk today; needs a yes</text>", "what feeds the 68 to 114 ms collections?</text>"),
("Two changes are on offer pending a yes: a resumable tree chunk build, and a budgeted reply queue with resumable derivation and an allocation-free distance query. The allocation profile is the measurement that ties the collections to their allocator.</li>",
 "Both changes shipped on 2026-09-08 with parity tests and are unseen in a browser: the tree chunk build pauses at the frame budget and resumes, and worker replies are delivered under a budget with the derivation pausing between rows and the road query allocating nothing. The allocation profile is the measurement that ties the collections to their allocator.</li>"),
])
print('docs, tasks, log, map done')
