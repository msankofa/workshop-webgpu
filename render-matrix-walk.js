// render-matrix-walk.js — skips the world-matrix walk for the subtrees that do not move.
//
// Three calls `scene.updateMatrixWorld()` once per frame, which recurses through every object in
// the scene whether or not anything in it moved. With `scene.matrixWorldAutoUpdate = false` that
// walk becomes ours, and this does it the other way round: everything is still walked EXCEPT the
// roots declared static. Declaring what does not move is the safe direction — an unlisted subtree
// keeps working exactly as before, where a missed entry in a list of movers would freeze it.
//
// Three ways a static root gets walked anyway, because "static" here means "its transforms do not
// change", not "nothing is ever added to it":
//   - `add` / `remove` are wrapped on the root AND on every object under it, so a chunk streamed
//     into a group three levels down is placed at once; new children are wrapped as they arrive.
//   - `touchAll()` walks everything next frame: origin rebases, terrain source swaps.
//   - every static root is re-walked on its own every `refreshEvery` frames, staggered, as
//     insurance against a change deeper in the subtree that neither of the above saw.

export function createMatrixWalk({ enabled = false, refreshEvery = 60 } = {}) {
  const statics = new Map();   // root -> { until, unpatch }
  let scene = null;
  let pendingFullWalk = true;
  let frame = 0;
  const stats = { enabled: !!enabled, statics: 0, walkedRoots: 0, walkedStatics: 0, fullWalks: 0, lastMs: 0 };

  function markDirty(root) {
    const entry = statics.get(root);
    if (entry) entry.until = 0;
  }

  return {
    stats,
    get enabled() { return stats.enabled; },
    attach(target) {
      scene = target;
      if (!stats.enabled || !scene) return false;
      scene.matrixWorldAutoUpdate = false;
      pendingFullWalk = true;
      return true;
    },
    // Roots whose own transforms do not change frame to frame: terrain, forest meshes, structures.
    skip(...objects) {
      for (const object of objects) {
        if (!object || statics.has(object)) continue;
        const undo = [];
        // Depth matters: terrain streams its chunks into a group under its root, so patching the
        // root alone would not see them arrive.
        const patch = (node) => {
          const add = node.add, remove = node.remove;
          node.add = function (...children) { markDirty(object); for (const child of children) if (child?.isObject3D) patch(child); return add.apply(this, children); };
          node.remove = function (...args) { markDirty(object); return remove.apply(this, args); };
          undo.push(() => { node.add = add; node.remove = remove; });
          for (const child of node.children) patch(child);
        };
        patch(object);
        statics.set(object, { until: 0, unpatch: () => { for (const fn of undo) fn(); } });
      }
      stats.statics = statics.size;
    },
    unskip(...objects) {
      for (const object of objects) { statics.get(object)?.unpatch(); statics.delete(object); }
      stats.statics = statics.size;
    },
    // Next update walks the whole scene once: an origin rebase moves the static roots too.
    touchAll() { pendingFullWalk = true; },
    // Once per frame, before the render. A no-op when the flag is off, so the page calls it
    // unconditionally and three keeps doing the walk itself.
    update(now = () => performance.now()) {
      if (!stats.enabled || !scene) return 0;
      const t0 = now();
      frame++;
      let walked = 0, walkedStatics = 0;
      if (pendingFullWalk) {
        pendingFullWalk = false;
        scene.updateMatrixWorld(true);
        for (const entry of statics.values()) entry.until = frame + refreshEvery;
        stats.fullWalks++;
      } else {
        // Deliberately not scene.updateMatrixWorld(): that recurses into every child, which is the
        // walk being avoided. The scene's own matrix was set by the full walk and does not change.
        for (const child of scene.children) {
          const entry = statics.get(child);
          if (entry && frame < entry.until) continue;
          if (entry) { entry.until = frame + refreshEvery + (walkedStatics++ % 7); child.updateMatrixWorld(true); }
          else { child.updateMatrixWorld(false); walked++; }
        }
      }
      stats.walkedRoots = walked;
      stats.walkedStatics = walkedStatics;
      stats.lastMs = now() - t0;
      return walked;
    },
    // Hands the walk back to three; used when the flag is toggled off at runtime.
    detach() {
      for (const entry of statics.values()) entry.unpatch();
      statics.clear();
      stats.statics = 0;
      if (scene) { scene.matrixWorldAutoUpdate = true; scene.updateMatrixWorld(true); }
      scene = null;
    },
  };
}
