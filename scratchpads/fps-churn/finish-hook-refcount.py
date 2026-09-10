# Record the commit-hook ownership fix and the object-group refusal in the doc, the report, the tasks and the log.
import json
p = 'docs/subsystems/vegetation.md'; s = open(p, encoding='utf-8').read()
old = """    retried rather than skipped. The hook is a runtime wrap installed on the renderer, removed in
    `dispose()`; there is no vendor change."""
new = """    retried rather than skipped. The hook is a runtime wrap installed on the renderer, one per
    node manager and shared by every forest built on that renderer (a module `WeakMap` keyed by
    `renderer._nodes` holds the original, the patch and an owner count; `commitHookOwners(nodes)`
    reads it). Each forest's `dispose()` releases once; the last owner restores the original, and a
    wrapper someone installed after ours is left in place. There is no vendor change."""
assert s.count(old) == 1; s = s.replace(old, new)
old = """    uniform is refused, and the reason is counted in `stats.staticRefresh.refused`;"""
new = """    uniform is refused, and the reason is counted in `stats.staticRefresh.refused`. Frame- and
    render-updated nodes are not object-typed and are not inspected by that list: one in a shared
    group is written by the one refresh per material per render below, so it is allowed; one left
    in the unshared object group would reach only that first mesh, so it is refused too;"""
assert s.count(old) == 1; s = s.replace(old, new)
open(p, 'w', encoding='utf-8', newline='').write(s)

p = 'scratchpads/fps-churn/static-skip/04-implementation-report.md'; s = open(p, encoding='utf-8').read()
old = """and covered by the `material.version` compare; an unsupported custom callback (any
`onObjectUpdate`/`onRenderUpdate`/`onFrameUpdate` uniform a host's graph extension added, which
appears as an object-typed `UniformNode` that is not `modelNormalMatrix`) is **refused** and the
graph falls back to Three."""
new = """and covered by the `material.version` compare; an `onObjectUpdate` uniform a host's graph
extension added (an object-typed `UniformNode` that is not `modelNormalMatrix`) is **refused** and
the graph falls back to Three. `onRenderUpdate`/`onFrameUpdate` uniforms are a separate case, added
2026-09-10 after Astra's review: they are not object-typed, so the allowlist never sees them. One in
a shared group (`renderGroup`/`frameGroup`) is written by the one refresh per material per render
and is allowed; one left in the unshared object group would be written into only that first mesh's
buffer, so the verdict refuses it by its `groupNode.shared === false`. Tested both ways in
`test-forest-object-group.mjs`."""
assert s.count(old) == 1; s = s.replace(old, new)
s += """

## Addendum 2026-09-10: shared-renderer ownership of the commit hook

Astra's review found that the boolean `__forestStaticCommit` mark let a second forest on the same
renderer install nothing, so disposing the first forest restored the original `updateAfter` while
the second was live and its marks stayed pending (its skip silently disappeared). Replaced by a
module-level `WeakMap` keyed by `renderer._nodes` holding `{ original, patched, owners }`:
`acquireCommitHook(nodes)` wraps once and counts owners, returns an idempotent release; the last
release restores the original only if `nodes.updateAfter` is still our patch, so a later wrapper is
left in place. `commitHookOwners(nodes)` is exported for tests. `test-forest-static-observer.mjs`
now covers two forests sharing one renderer with disposal in both orders, an overlapping rebuild
(new forest built before the old one is disposed), a later wrapper surviving the last release and a
fresh forest wrapping it, and a second `dispose()` being a no-op: 72 checks.
"""
open(p, 'w', encoding='utf-8', newline='').write(s)

p = 'docs/render-tasks.json'; d = json.load(open(p, encoding='utf-8')); by = {t['id']: t for t in d['tasks']}
t = by['t21-static-refresh-skip']
t['why'] += ' Astra reviewed the code on 2026-09-10 and found one lifecycle defect, now fixed and tested: a second forest on the same renderer would have lost the policy when the first was disposed; the hook is now owned by a count and shared. They also had the verdict refuse a frame- or render-updated uniform left in the per-mesh group. Your walks are unchanged.'
d['updatedAt'] = '2026-09-10T07:10:00.000Z'
json.dump(d, open(p, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)
p = 'docs/render-progress-log.json'; d = json.load(open(p, encoding='utf-8'))
d['entries'].append({'at': '2026-09-10T07:10Z', 'title': 'Astra’s code review of the refresh policy: hook ownership fixed, object-group refusal widened',
  'body': 'Astra ran the three forest suites and accepted the updateAfter seam for this pinned, opt-in case, then found a shared-renderer lifecycle defect at forest-gpu.js:1029-1042: the boolean __forestStaticCommit let forest B install nothing, so disposing A restored the original while B lived and B’s marks stayed pending (a silent loss of the skip, not a stale picture). Fix: a module WeakMap keyed by renderer._nodes holding original, patch and owner count; acquireCommitHook wraps once and returns an idempotent release; the last owner restores the original only if updateAfter is still ours, so a later wrapper survives; commitHookOwners(nodes) exported. Tests: two forests on one renderer, dispose in both orders, overlapping rebuild, later wrapper kept and re-wrapped by a fresh forest, double dispose (test-forest-static-observer 72 checks). Second point: forestGraphVerdict only inspected OBJECT-typed update nodes, so an onRenderUpdate/onFrameUpdate uniform passed regardless of group; one in the unshared object group would be written into only the first mesh per render. The verdict now refuses any non-object update node whose groupNode.shared is false and allows the shared-group form, tested both ways (test-forest-object-group 65 checks). Doc and report wording corrected: the tested refusal is the OBJECT case; frame/render callbacks in shared groups ride the one-refresh-per-render rule. Still off by default; browser checks (task 21) unchanged.', 'commits': []})
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False); open(p, 'a', encoding='utf-8').write('\n')
json.load(open('docs/render-tasks.json', encoding='utf-8')); json.load(open('docs/render-progress-log.json', encoding='utf-8')); print('docs ok')
