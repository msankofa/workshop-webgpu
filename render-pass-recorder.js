// render-pass-recorder.js — what a frame's render calls actually were.
//
// `renderer.info.render.frameCalls` says how many whole scene renders a frame paid for, but not
// what they were, and a page that issues one render() can easily be paying for four. Three renames
// the scene to `Shadow Map [ <light> ]` for the duration of a shadow pass (ShadowNode.renderShadow),
// so the inspector hook it calls on every render context can read that name back and turn a bare
// count into a named list — including which light each shadow belongs to.
//
// Worth knowing while reading the output: ShadowNode.updateBefore gates only on
// `shadow.needsUpdate || shadow.autoUpdate`. It checks neither the light's intensity nor its
// `visible`, so a resident light switched off by ramping intensity to zero still renders a full
// shadow map every frame for as long as its castShadow is true.
//
// Wraps the renderer's existing inspector rather than assigning `renderer.inspector`, whose setter
// tears the current inspector down; three ships one by default and other tooling may be on it.

export function createRenderPassRecorder(renderer) {
  const counts = new Map();      // pass name -> renders this frame
  const out = [];                // reused: [{ name, count }, ...]
  const inspector = renderer && renderer.inspector;
  const original = inspector && inspector.beginRender;
  let installed = false;

  if (typeof original === 'function') {
    inspector.beginRender = function recordingBeginRender(uid, scene, camera, renderTarget) {
      // Read the name before three restores it — the rename lives only across the shadow render.
      const name = (scene && scene.name) || '(unnamed scene)';
      counts.set(name, (counts.get(name) || 0) + 1);
      return original.call(this, uid, scene, camera, renderTarget);
    };
    installed = true;
  }

  return {
    // False where there is no inspector to wrap; every read is then empty rather than wrong.
    get installed() { return installed; },
    // Drains the frame. The array and its rows are reused, so a per-frame reader allocates
    // nothing: read it, do not hold it.
    take() {
      out.length = 0;
      for (const [name, count] of counts) out.push({ name, count });
      counts.clear();
      return out;
    },
    // One line for a record or a HUD: "Scene x1, Shadow Map [ sun ] x1".
    summary() {
      const parts = [];
      for (const [name, count] of counts) parts.push(count > 1 ? `${name} x${count}` : name);
      return parts.join(', ');
    },
    dispose() {
      if (installed) inspector.beginRender = original;
      installed = false;
      counts.clear();
    },
  };
}
