# Commit hook ownership: per-nodes reference count instead of a boolean, so two forests on one renderer both keep the hook.
import re
p = 'forest-gpu.js'; s = open(p, encoding='utf-8').read()
old_head = "const forestPolicyContext = new WeakMap();   // material -> the forest's shared policy context\n"
new_head = old_head + """
// One patch of renderer._nodes.updateAfter per node manager, shared by every forest on that renderer and released by the last owner; a wrapper someone installed after ours is left in place.
const commitHooks = new WeakMap();   // nodes -> { original, patched, owners }
function acquireCommitHook(nodes) {
  let entry = commitHooks.get(nodes);
  if (!entry) {
    const original = nodes.updateAfter;
    const patched = function (renderObject) {
      original.call(this, renderObject);
      renderObject?.getMonitor?.()?.[FOREST_COMMIT]?.(renderObject);
    };
    nodes.updateAfter = patched;
    entry = { original, patched, owners: 0 };
    commitHooks.set(nodes, entry);
  }
  entry.owners++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--entry.owners > 0) return;
    if (nodes.updateAfter === entry.patched) nodes.updateAfter = entry.original;
    commitHooks.delete(nodes);
  };
}
// How many live forests hold the commit hook on this node manager (tests and stats).
export function commitHookOwners(nodes) { return commitHooks.get(nodes)?.owners ?? 0; }
"""
assert s.count(old_head) == 1; s = s.replace(old_head, new_head)
old = re.search(r"  let removeCommitHook = \(\) => \{\};\n  function installCommitHook\(\) \{.*?\n  \}\n  installCommitHook\(\);\n", s, re.S)
assert old
new = """  let removeCommitHook = () => {};
  if (STATIC_REFRESH && renderer?._nodes && typeof renderer._nodes.updateAfter === 'function') removeCommitHook = acquireCommitHook(renderer._nodes);
"""
s = s[:old.start()] + new + s[old.end():]
open(p, 'w', encoding='utf-8', newline='').write(s)

p = 'test-forest-static-observer.mjs'; t = open(p, encoding='utf-8').read()
t = t.replace("check('the commit hook was not installed', r2._nodes.__forestStaticCommit !== true);",
              "check('the commit hook was not installed', commitHookOwners(r2._nodes) === 0);")
old_tail = """section('dispose puts renderer._nodes.updateAfter back');
{
  const patched = renderer._nodes.updateAfter;
  forest.dispose();
  check('the hook was removed', renderer._nodes.updateAfter !== patched);
  check('and the marker is cleared', renderer._nodes.__forestStaticCommit === false);
}
"""
assert t.count(old_tail) == 1
new_tail = """section('dispose puts renderer._nodes.updateAfter back');
{
  const patched = renderer._nodes.updateAfter;
  forest.dispose();
  check('the hook was removed', renderer._nodes.updateAfter !== patched);
  check('and no owner remains', commitHookOwners(renderer._nodes) === 0);
  forest.dispose();
  check('a second dispose changes nothing', commitHookOwners(renderer._nodes) === 0 && renderer._nodes.updateAfter !== patched);
}

// Two forests on one renderer: the hook is shared and the last owner releases it (Astra's review of 2026-09-10).
function commitsFor(r, forestX, tag) {
  const mesh = forestX.variantMeshes(0).find(m => m.name === 'forest:v0:branchesL0');
  const b = buildObserver(r, mesh);
  const ro = makeRenderObject(mesh, b, tag);
  renderObjectDirect(r, ro, frame(r));            // first sight: refresh + commit
  const other = forestX.variantMeshes(1).find(m => m.name === 'forest:v1:branchesL0');
  const b2 = buildObserver(r, other);
  const ro2 = makeRenderObject(other, b2, tag + '2');
  renderObjectDirect(r, ro2, frame(r));
  // A skipped second mesh proves the clean mark committed through the shared hook.
  const g = frame(r);
  renderObjectDirect(r, ro, g);
  return { skippedSecond: renderObjectDirect(r, ro2, g) === false, ro, ro2 };
}
function invalidatedThenSkips(r, forestX, ro, ro2) {
  forestX.invalidate();
  const f = frame(r);
  renderObjectDirect(r, ro, f);
  const refreshed = renderObjectDirect(r, ro2, f) === true;   // the mark reached it
  const g = frame(r);
  renderObjectDirect(r, ro, g);
  return refreshed && renderObjectDirect(r, ro2, g) === false; // and committed again
}

section('two forests share one renderer: disposing the first keeps the second one committing');
{
  const r5 = makeRenderer();
  const original = r5._nodes.updateAfter;
  const A = makeForest(r5);
  const patched = r5._nodes.updateAfter;
  const B = makeForest(r5);
  check('one patch for both', r5._nodes.updateAfter === patched && patched !== original);
  check('two owners', commitHookOwners(r5._nodes) === 2);
  const a = commitsFor(r5, A, 'A'), b = commitsFor(r5, B, 'B');
  check('both forests commit through the shared hook', a.skippedSecond && b.skippedSecond);
  A.dispose();
  check('the hook stays while B lives', r5._nodes.updateAfter === patched && commitHookOwners(r5._nodes) === 1);
  check('B still marks and commits after A is gone', invalidatedThenSkips(r5, B, b.ro, b.ro2));
  B.dispose();
  check('the last owner restores the original', r5._nodes.updateAfter === original && commitHookOwners(r5._nodes) === 0);
}

section('the other order: disposing the second first');
{
  const r6 = makeRenderer();
  const original = r6._nodes.updateAfter;
  const A = makeForest(r6), B = makeForest(r6);
  const patched = r6._nodes.updateAfter;
  const a = commitsFor(r6, A, 'A'); commitsFor(r6, B, 'B');
  B.dispose();
  check('A keeps the hook', r6._nodes.updateAfter === patched && commitHookOwners(r6._nodes) === 1);
  check('A still marks and commits', invalidatedThenSkips(r6, A, a.ro, a.ro2));
  A.dispose();
  check('restored', r6._nodes.updateAfter === original);
}

section('overlapping rebuild: the new forest is built before the old one is disposed');
{
  const r7 = makeRenderer();
  const original = r7._nodes.updateAfter;
  const old = makeForest(r7);
  commitsFor(r7, old, 'old');
  const fresh = makeForest(r7);           // a host rebuilds first, then disposes
  old.dispose();
  const n = commitsFor(r7, fresh, 'new');
  check('the fresh forest commits after the old one left', n.skippedSecond);
  check('and marks', invalidatedThenSkips(r7, fresh, n.ro, n.ro2));
  fresh.dispose();
  check('restored', r7._nodes.updateAfter === original && commitHookOwners(r7._nodes) === 0);
}

section('a wrapper installed after ours survives the last release');
{
  const r8 = makeRenderer();
  const A = makeForest(r8);
  const ours = r8._nodes.updateAfter;
  let outer = 0;
  const later = function (ro) { outer++; return ours.call(this, ro); };
  r8._nodes.updateAfter = later;
  const a = commitsFor(r8, A, 'A');
  check('commits pass through the later wrapper', a.skippedSecond && outer > 0);
  A.dispose();
  check('the later wrapper is left in place', r8._nodes.updateAfter === later);
  check('no owner remains', commitHookOwners(r8._nodes) === 0);
  const B = makeForest(r8);
  check('a new forest wraps the later wrapper rather than replacing it', r8._nodes.updateAfter !== later && commitHookOwners(r8._nodes) === 1);
  const before = outer;
  const b = commitsFor(r8, B, 'B');
  check('and its commits still reach the later wrapper', b.skippedSecond && outer > before);
  B.dispose();
  check('release returns to the later wrapper', r8._nodes.updateAfter === later);
}
"""
t = t.replace(old_tail, new_tail)
open(p, 'w', encoding='utf-8', newline='').write(t)
print('patched')
