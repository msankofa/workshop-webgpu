# My own reading of the four 2026-09-09 DevTools recordings (Astra's analyzer, run by me).
import json
p = 'docs/render-progress-log.json'; d = json.load(open(p, encoding='utf-8'))
d['entries'].append({'at': '2026-09-10T04:10Z', 'title': 'The four DevTools recordings read (my own run of Astra’s analyzer)',
  'body': ('Files: Trace-20260909T221243 (trees off, walking, 20 s), T221638 and "running w trees" T222012 (trees on, walking, 48 s each), "default" T224650 (trees on with ?trace=1, 42 s); all with ?gputime=1. Steady windows trimmed 2 s at each end. '
           'Trees off: rAF interval p50 16.6 ms, p95 32.7, 1 of 797 over 50 ms, no task over 50 ms, 20 minor GCs (42 ms) and 1 major (23 ms) in 20 s. '
           'Trees on: p50 29.8 and 36.2 ms, p95 58 and 68, 144 of 1314 and 208 of 1087 intervals over 50 ms, 111 and 161 tasks over 50 ms (mean 60 to 63 ms wall, 53 to 56 CPU), GC 39 to 47 minors (121 to 123 ms) and 2 majors (67 to 75 ms) per 48 s, so 3 to 4 per cent of wall time; render samples 25.4 to 26.2 s of 48 (53 per cent), bindings 4.9 to 5.2 s (10 per cent), node updates 4.0 s (8 per cent), the player capsule against the terrain (map-collision intersectsTriangle, raycastAll, resolveOnce) 1.8 to 2.1 s (4 per cent), grass-compute update 0.4 to 0.5 s, tree chunk build 0.15 to 0.28 s total and never more than 2.2 ms inside a worst task, so the resumable build holds. '
           'The worst trees-on tasks (85 to 128 ms) are render 39 to 56 ms inclusive with bindings 3 to 11 and nodes 3 to 9 ms, plus in two of them a major GC of 31 to 54 ms, plus 12 to 18 ms with the thread not running; three 116 to 153 ms input-handling tasks with Layout at 4 to 6 s into T222012 are menu interaction, not gameplay. '
           'With ?trace=1 on (T224650) the trace’s own wrappers are the largest app-level sample owner, 13 s of 42, and its timer another 2.3 s: the trace perturbs what it measures far more than assumed; the earlier "trace costs little" from two matching p50s is withdrawn. '
           'Reading: with trees on, the frame is the per-object render submission (bindings and node updates across about 110 more objects), which the trace stages already showed; GC is a small share of time but lands in the worst frames; the capsule collision is the next own-code cost after that; the tree build is no longer a spike source. Nothing here measures the leaf fragment fix. Output JSON: research/stats/trees-on-trace-review-20260909.json; runner scratchpads/fps-churn/run-trace-analyzer.py.'),
  'commits': []})
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False); open(p, 'a', encoding='utf-8').write('\n')
p = 'docs/render-tasks.json'; d = json.load(open(p, encoding='utf-8')); by = {t['id']: t for t in d['tasks']}
t = by['t22-leaves']
t['outcome'] = (t.get('outcome', '') + ' 04:10Z, the DevTools recordings read: trees off 16.6 ms p50 with 1 interval over 50 ms in 800; trees on 30 to 36 ms p50 with 11 to 19 per cent of intervals over 50 ms; render samples are 53 per cent of the trees-on wall time, bindings 10 and node updates 8; GC 3 to 4 per cent but in the worst frames; the capsule collision 4; the tree build never more than 2.2 ms in a worst task. With ?trace=1 on, the trace itself is the largest app-level sample owner, so traced frame times are inflated.')
d['updatedAt'] = '2026-09-10T04:10:00.000Z'
json.dump(d, open(p, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)
json.load(open('docs/render-tasks.json', encoding='utf-8')); json.load(open('docs/render-progress-log.json', encoding='utf-8'))
print('ok')
