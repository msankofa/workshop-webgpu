# Trims the allocation pass's block comments to the repo's one-line style and records the round.
import json

def patch(path, pairs):
    s = open(path, encoding='utf-8').read()
    for o, n in pairs:
        assert s.count(o) == 1, (path, o[:70]); s = s.replace(o, n)
    open(path, 'w', encoding='utf-8', newline='').write(s); print('patched', path)

patch('base-game-terrain.js', [
("""  // One reused list for the keys this frame's removal sweep collects; the old `[...batched.keys()]`
  // spread built a fresh array of every batched key every frame, on every batcher.
""", "  // Reused: the old [...batched.keys()] spread was a fresh array per batcher per frame.\n"),
("""  // One array of one entry per streamer, rebuilt in place. Every caller (applyMaterialsPass,
  // applyMaterials, integrate) finishes with it before the next call asks for it, and none keeps
  // the reference past its own scope, so the list and its entries are reused rather than rebuilt
  // two or three times a frame.
""", "  // Rebuilt in place: no caller keeps the list or its entries past its own call.\n"),
("""  // The kill plane is asked for the player's column EVERY frame, and in volumetric mode that is a
  // full surfaceYAt density scan. groundHeight is a pure function of (source, epoch, volumetric),
  // so the answer is cached and recomputed only when the player moved KILL_PLANE_CACHE_M or any of
  // those changed. The plane sits killPlaneBelowSurface (80 m) under the ground, so half a metre of
  // horizontal staleness cannot change the test except in the single frame a player crosses a cliff
  // edge — and the next recompute, half a metre later, catches it.
""", "  // Cached per (source, epoch, volumetric, 0.5 m of travel): the volumetric surface scan ran every frame, and the plane sits 80 m down.\n"),
])
patch('road-index.js', [
("""  // The segment loop is argmin by SQUARED distance and takes one Math.hypot on the winner: sqrt is
  // monotone, so the winner is the same, and the returned number is a hypot of the same two operands
  // the old per-segment call used. Indexed loops, not for-of, because this runs once per field texel.
""", "  // Argmin by squared distance, one hypot on the winner (same operands as before, so the same number); indexed loops, per texel.\n"),
("          // distancePointToSegmentXZ's arithmetic, inlined so nothing escapes the loop.\n", "          // distancePointToSegmentXZ inlined so nothing escapes the loop.\n"),
])
patch('flora-field.js', [
("""// `out` is an optional { grass, plant, tree } to write into, for the per-texel derive; without it
// the function allocates a fresh object exactly as before.
""", "// `out`: an optional { grass, plant, tree } to write into; without it a fresh object, as before.\n"),
("  // No local closures: this runs once per field texel, and a closure per call is a heap object.\n", "  // No closures here: once per texel.\n"),
("""  // Per-texel scratch: the weights array, the cover result and coverAt's options record were three
  // fresh objects per texel, and a 16k-texel tile arrives every few frames while walking.
""", "  // Per-texel scratch: three fresh objects per texel before, on 16k-texel tiles.\n"),
])
patch('terrain-splat-streamed.js', [
("""// `out` is an optional 5-element array to write into, for callers running this per texel; without
// it the function allocates a fresh array exactly as before.
""", "// `out`: an optional 5-element array to write into; without it a fresh array, as before.\n"),
])

p = 'docs/render-tasks.json'; d = json.load(open(p, encoding='utf-8')); by = {t['id']: t for t in d['tasks']}
if 't25-allocation-pass-check' not in by:
    d['tasks'].append({'id': 't25-allocation-pass-check', 'createdAt': '2026-09-10T01:00:00Z', 'status': 'open', 'doneAt': None, 'notes': '', 'files': [],
      'title': 'After the allocation pass: one walking heap profile, trees on',
      'criteria': 'Reload. Walk your route with trees and grass on for about 30 s with DevTools allocation sampling running (as before, discarded objects included), save it into research/stats/. Nothing else; the two ?trace=1 walks from task 22 still stand if you get to them.',
      'why': 'Four same-content changes landed in the code that allocated most while walking: the road distance query no longer boxes a number per segment, the kill-plane check is cached to half a metre of travel instead of scanning the density field every frame, the terrain batch walk reuses its lists, and the field derive writes into scratch objects. Each has a parity test (bit-identical distances over 4,400 queries, identical cover channels over 37,056 values, cache equals the exact plane at every recompute). Whether the 68 to 114 ms collections shrink or only move is not measurable headless; the profile says.'})
d['updatedAt'] = '2026-09-10T01:00:00.000Z'
json.dump(d, open(p, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)

p = 'docs/render-progress-log.json'; d = json.load(open(p, encoding='utf-8'))
d['entries'].append({'at': '2026-09-10T01:00Z', 'title': 'Allocation pass: four same-content changes on the walking hot paths',
  'body': 'Opus agent, reviewed: (1) road-index nearestDistanceWithin inlines the segment arithmetic, takes the argmin by squared distance and one Math.hypot on the winner, indexed loops; test-roads carries a verbatim copy of the old implementation and asserts === over 4,000 bounded and 400 unbounded queries, 0 mismatches. (2) base-game-terrain killPlaneYAt cached per source identity, epoch, volumetric mode and 0.5 m of travel (groundHeight is a pure function of those; the plane sits 80 m down; measured staleness inside the radius 0.018 m); killPlaneYAtExact kept, tests that the cache equals it at recompute points and that a source swap invalidates. (3) syncBatchVisibility reuses a removal array instead of spreading batched.keys(); batchTargets reuses its list and records (no caller retains them); residency records left fresh because captures keep them. (4) flora-field coverAt and splatWeights take an optional out; derive uses scratch objects and drops two per-texel closures; 37,056 channel values identical to the pre-change file, fixed-seed checksum pinned in the test. (5) HUD skipped: it runs on a 500 ms tick and its result is cloned. Nine tests and the page syntax green. Not measured: the browser GC effect; task 25 asks for one walking heap profile.', 'commits': []})
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False); open(p, 'a', encoding='utf-8').write('\n')
json.load(open('docs/render-tasks.json', encoding='utf-8')); json.load(open(p, encoding='utf-8'))
print('round recorded')
