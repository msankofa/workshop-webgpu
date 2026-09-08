# Three.js abstraction costs and extension strategy (base-game.html)

Scope: is the ~11-18ms encode cost (202 objects, plants off still 11-12ms) coming from how
base-game.html *uses* Three, or from fixed per-object work inside r184's WebGPU renderer
internals — and what's the right lever.

Method note up front: I did not run the browser. Everything below is either (a) reading
`node_modules/three/build/three.webgpu.js` (83,969 lines, same build the CDN serves) with line
numbers, or (b) numbers already in `research/stats/base-game-performance-log.json` and
`research/stats/trace-review-20260907.md`. I ran no new instrumentation — `render-trace.js`
already exists and wraps the same functions I read; I did not execute it. Where I say "cost is
small" that is a read of the code shape (loop bounds, map lookups vs string building), not a
measured microsecond figure. Treat every per-object estimate as an order-of-magnitude guess.

## The path, with line numbers

`renderer.render(scene, camera)` → `_renderScene` (three.webgpu.js:59184) → `_projectObject`
(60817) walks the scene graph and pushes into `RenderList` → `_renderObjects` (61020) iterates
the render list and calls `_currentRenderObjectFunction` per entry → default is `renderObject`
(61155) → `_handleObjectFunction` (aliased to `_renderObjectDirect`, 61284) → per object:

1. `this._objects.get(...)` (30399) — chained-WeakMap (`ChainMap`, 29288) lookup keyed on
   `[object, material, renderContext, lightsNode]`, or creates a new `RenderObject` (29455).
2. On a cache hit, `renderObject.needsUpdate` getter (30246) calls `getDynamicCacheKey()`
   (30257), which calls `this._nodes.getCacheKey(scene, lightsNode)` (54718).
3. `this._nodes.needsRefresh(renderObject)` (55101) → `monitor.needsRefresh(...)`.
4. If refresh needed: `_nodes.updateBefore` (55023), `_geometries.updateForRender` (30915),
   `_nodes.updateForRender` (55082), `_bindings.updateForRender` (32148 range).
5. `_pipelines.updateForRender` (unconditional every object, every frame) then
   `_pipelines.isReady` gates `backend.draw`.

## Findings

### F1 — `_projectObject` walks the whole scene graph and recomputes frustum tests every frame
- **Evidence**: 60817-60911. No coarse spatial reject before the per-object
  `frustum.intersectsObject` call (60869); `sortObjects` path also recomputes
  `geometry.boundingSphere` transform per object (60875-60881) when sorting is on.
- **Classification**: code-supported architectural weakness, in the sense that it's Three's
  documented per-frame design, not a bug. Whether it's *our* bottleneck at 202 objects is an
  untested hypothesis — 202 frustum tests is not intrinsically expensive; I have no per-call
  timing to say what fraction of the 11-18ms this is.
- **Application-side lever**: this is where object *count* matters most. If groups of
  small static meshes (rocks/props/decals) could be one `InstancedMesh`/merged `BufferGeometry`,
  this stage's cost drops with instance count regardless of internals. This is a usage fix, not
  a renderer fix, and belongs with whichever area owns rock/prop/decal placement — don't double
  count against this area's scope.
- **Priority/scope**: safe direct improvement, but needs the count breakdown (how many of the
  202 are candidates for merging) from the terrain/vegetation/rocks areas, not this one.

### F2 — `needsUpdate`/cache-key recomputation is per-object, not per-frame, but the underlying node cache key IS memoized per render pass
- **Evidence**: `RenderObjects.get` (30399) calls `renderObject.needsUpdate` (30246) on every
  cache hit, i.e. every object every frame. That getter calls `getDynamicCacheKey` (30257) →
  `this._nodes.getCacheKey(scene, lightsNode)` (54718). I first suspected this recomputes the
  full lights/fog/environment cache key per *object* (expensive), but the memo key is
  `this.renderer.info.calls` (54723), and `info.calls++` happens once per `_renderScene` call
  (59260, 60475) — i.e. once per pass, not per object or even per frame if there's one pass. So
  `getEnvironmentNode`/`getFogNode`/`lightsNode.getCacheKey`/`hashArray` (54729-54741) run once
  per pass and are cheap (WeakMap-chained lookup) on every other object in that pass.
  What *is* still per-object, unconditionally: the `ChainMap.get` walk (4 nested WeakMap
  lookups), `getDynamicCacheKey`'s own `hash$1` calls for camera/receiveShadow/contextNode
  version (30270-30284), and the `renderObject.version !== material.version` check.
- **Classification**: code-read; I initially got this wrong (assumed per-object recompute) and
  corrected it against the actual increment site — flagging because it's the kind of claim that
  looks plausible but isn't, and is worth re-checking if anyone else reasons about this path from
  memory instead of the build.
- **Verdict**: not a redundancy worth chasing. The per-object fixed cost here is a handful of
  WeakMap lookups and integer hashes — sub-microsecond scale per object, not a credible source
  of double-digit milliseconds at 202 objects.
- **Priority/scope**: no action.

### F3 — `_pipelines.updateForRender` and `Bindings.updateForRender` run unconditionally per object per frame, gated only by internal dirty flags
- **Evidence**: 61302-61325 — `needsRefresh` (a monitor check, 55101) gates
  `_nodes.updateBefore/updateForRender` and `_bindings.updateForRender`, but
  `_pipelines.updateForRender` (61315) runs every object every frame regardless of
  `needsRefresh`, then `_pipelines.isReady` gates the actual draw. I did not read
  `Pipelines.updateForRender`'s body (it's outside the range I pulled; likely a cheap "is the
  GPU pipeline object still valid" check plus possible pipeline-cache lookup by cache-key
  string), so I can't say whether it's a map lookup or does string-key hashing per object per
  frame. This is the most likely site for the "per-object binding/uniform update path" a peer
  already attributed cost to, but I have not confirmed it by line.
- **Classification**: untested hypothesis — flagging the exact function to instrument, not a
  confirmed cost.
- **What would confirm it**: wrap `Pipelines.prototype.updateForRender` and
  `Bindings.prototype.updateForRender` the same way `render-trace.js` already wraps
  `_renderObjectDirect` (see `render-trace.js:189-213` for the pattern — timestamp before/after,
  accumulate into a per-frame entry), run with `?trace=1` on the live page, and compare total ms
  in that wrapper against the already-measured 11-18ms encode window. This reuses the existing
  hook mechanism (`renderer._renderObjectDirect` monkey-patch); no new machinery.
- **Priority/scope**: bounded experiment — instrumentation only, no renderer change yet. Do this
  before proposing any renderer-internals fix; right now it's a hypothesis, not a defect.

### F4 — needsUpdate detection is content-driven, not usage-pattern-driven
- **Evidence**: `monitor.needsRefresh` (55101-55108) and the `RenderObject.needsUpdate` getter
  (30246-30250) key off material version and a computed dynamic cache key, not off any flag our
  code sets. There is no `object.static` fast path currently honored (30243 has a commented-out
  `this.object.static !== true` check — literally dead in this build, a maintainer left it
  commented, meaning Three itself considered and shelved a static-object fast path).
- **Classification**: code-read, confirms a documented Three limitation rather than something
  specific to base-game.html.
- **Application-side lever**: none available today — we can't opt a static rock/terrain patch
  out of this check from userland; the commented `static` flag isn't wired up in r184. Not
  something our usage pattern can fix by itself.

### F5 — application usage: per-object materials and TSL node graphs
- Not independently re-verified here (out of my time budget) but consistent with F1-F3: every
  unique `NodeMaterial` instance gets its own `RenderObject`/pipeline/binding set — the `get()`
  chain-map is keyed per `[object, material, ...]`, so if base-game.html or a vegetation/rock
  module creates one material instance per mesh instead of sharing a material across instances,
  each one walks the full create-or-fetch path independently on first appearance and keeps a
  separate binding group thereafter. I did not grep base-game.html itself for per-object material
  construction (that's this area's boundary with the modules that actually build the 202
  objects — vegetation/rocks/terrain own that count and their own material-sharing choices).
  Flagging the mechanism, not claiming it's present.
- **Classification**: untested hypothesis (mechanism confirmed by code, presence in this app not
  checked).
- **What would confirm it**: `?trace=1` in `render-trace.js` already counts calls per phase
  (`objectsMs`/`objectsCalls`, see `render-trace.js:293-294`) — add a per-material-identity
  dedup count (how many unique material objects vs how many meshes) to that trace, or grep
  base-game.html / vegetation/rocks modules for `new MeshBasicNodeMaterial`/`new
  MeshStandardNodeMaterial` inside a per-instance loop vs a shared module-level material.

## Strategy comparison

**(a) Improve our usage only** (merge/instance static geometry per F1, share materials per F5,
confirm F3's actual cost before touching anything else). No compatibility cost, no upgrade
burden, no duplicated machinery. This is the only strategy with concrete evidence pointing at it
right now (F1, F5 are real mechanisms, just unconfirmed as *our* bottleneck). Should go first.

**(b) Narrow extension via an existing hook** — `setRenderObjectFunction` exists at
three.webgpu.js:60427 and swaps `this._renderObjectFunction`, which becomes
`_currentRenderObjectFunction` and is what `_renderObjects` (61026) calls per list entry. This is
a real, documented extension point (used internally for `compileAsync`'s
`_createObjectPipeline`, 61343). A custom render-object function could skip `needsRefresh`
re-checks for objects flagged static by our own convention, or batch-submit groups sharing a
pipeline. Cost: it fully replaces per-object dispatch — any future r184→next-version change to
`renderObject`'s internals (new arguments, new required calls to `_nodes`/`_bindings`/`_pipelines`
in a specific order) breaks silently until re-verified against the new build, because we'd be
reimplementing lines 61155-61250, not calling them. `onBeforeRender`/`onAfterRender` hooks
(61165, 61248) are per-object already and don't reduce Three's own bookkeeping around them — not
useful for this problem, only for injecting app logic. **Verdict**: viable as a bounded
experiment only after F3 confirms real per-object fixed cost worth skipping; until then it's
solving an unmeasured problem.

**(c) Maintained patch of the vendored build** — would mean forking off the CDN load (the
importmap in `environment-viewer.html`/`base-game.html` currently points at jsDelivr; CLAUDE.md
notes the local `node_modules/three/build/three.webgpu.js` copy is used for reference/tests, not
served). Every Three release (they ship often) would need the patch manually rebased against a
83,969-line file with no diff tooling in this repo for it. High maintenance burden for a target
that (per F2/F3) isn't yet shown to be the dominant cost. Not justified by current evidence.

**(d) Custom submission path for specific content** (e.g. terrain/forest own WebGPU pass via
`renderer.backend.device`) — I did not check what `backend` exposes in r184's WebGPU backend
class in this session (out of budget); this needs its own read before it's actionable. It also
directly overlaps with terrain upload and forest/grass instancing work other areas own — a
custom pass bypassing `_renderObjectDirect` would need to independently manage bind groups,
pipeline cache, and node-graph updates that Three currently does for us, which is real
duplicated machinery, not a small change. Only justified if F1/F3 confirm the generic per-object
path is the dominant cost for exactly that content (terrain/forest chunks), which is unconfirmed.

## Overlap with other areas

- F1's fix (merging static props into instanced/merged geometry) belongs to whichever area owns
  rock/prop/decal placement counts — don't duplicate that recommendation there.
- F3/F5's confirmation work (extending `render-trace.js`) overlaps with whatever area is already
  reading `frame-profiler.js`/`gpu-pipeline-meter.js` output — check before adding a second
  parallel instrumentation pass.
- Terrain/forest uploads (draw calls, buffer writes) are explicitly out of scope here; strategy
  (d) is the only place this area touches them, and only as a "don't build this yet" call.

## Priority summary

1. Safe direct improvement: confirm F5 (material sharing) by grepping the modules that build the
   202 objects — cheap, no code change to Three's path.
2. Bounded experiment: instrument `Pipelines.updateForRender`/`Bindings.updateForRender` (F3)
   using the existing `render-trace.js` wrap pattern; this is the one number that would justify
   or kill strategy (b).
3. Larger redesign: strategy (b) (`setRenderObjectFunction`) only if (2) shows real per-object
   fixed cost concentrated in a stage we can legally skip for static content. Strategies (c) and
   (d) are not justified by anything found here.

## What I could not verify

- Whether F1's frustum-culling/scene-walk cost, F3's pipeline/binding update cost, or F5's
  per-material bookkeeping is actually the majority contributor to the measured 11-18ms encode
  window — no browser run, no line-level timing beyond what `render-trace.js` already collects
  (which I did not execute).
- The body of `Pipelines.updateForRender` and `Bindings.updateForRender` (I found the call sites,
  not their implementations) — could not confirm whether they do string-based cache-key hashing
  per object per frame or a cheap WeakMap check.
- What `renderer.backend.device`/the WebGPU backend class expose for a hand-written pass
  (strategy d) — not read this session.
- Whether base-game.html or the vegetation/rocks/terrain modules construct one material instance
  per mesh instance (F5's premise) — not grepped this session.
- Any GPU-side cost; the performance log already says GPU is ~1ms and this review only looked at
  CPU-side renderer code.
