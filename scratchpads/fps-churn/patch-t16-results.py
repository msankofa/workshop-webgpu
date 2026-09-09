# Task 16 results: the movement cost is the bindings stage, and the extra writes are render-group
# uniforms rewritten once per instanced object because three keys their builder state by uuid.
import json

def patch(path, pairs):
    s = open(path, encoding='utf-8').read()
    for o, n in pairs:
        assert s.count(o) == 1, (path, o[:80]); s = s.replace(o, n)
    open(path, 'w', encoding='utf-8', newline='').write(s); print('patched', path)

p = 'docs/render-tasks.json'
d = json.load(open(p, encoding='utf-8')); by = {t['id']: t for t in d['tasks']}
t = by['t16-trace-pair-fixed']; t['status'] = 'done'; t['doneAt'] = '2026-09-09T00:27:00Z'
t['outcome'] = ('Read, seven captures 00:24 to 00:26Z, plants and structures off, 92 to 132 objects. Standing: the bindings stage of the main scene is 2 ms with 36 uniform writes a frame. Moving: 9 to 18 ms with 117 to 197 writes, the same objects. The extra writes are the camera view matrix and the light positions, written once per body-part, weapon and debris batch (18 times for the cloth material alone) instead of once per frame. Mechanism, read in Three’s source: those live in the shared render group, but Three appends the object uuid to the material cache key for every instanced mesh (a TODO citing PR 29066), so each instanced mesh gets its own node build, its own light uniform nodes, and therefore its own render bind group; the sharing that would write them once never engages. The four standing per-object writes are water and cloud numbers plus one terrain batch number, small and ours. Decision on the instanced-mesh sharing is task 17.')
if 't17-render-group-sharing' not in by:
    d['tasks'].append({'id': 't17-render-group-sharing', 'createdAt': '2026-09-09T01:30:00Z', 'status': 'open', 'doneAt': None, 'notes': '', 'files': [],
      'title': 'Decide how to stop rewriting camera and light uniforms per instanced mesh',
      'criteria': 'Say A, B, C, or ask. A: patch our vendored three.webgpu.js so instanced meshes with the same material share one node build and one render bind group (a local change to Three, carried across upgrades; Node-tested against the trace counters, then a walking capture). B: move the body, weapon and debris batches off InstancedMesh onto storage-buffer-driven meshes, the way the forest and grass already draw, so Three shares their build without a patch (larger: body-part-batches and weapon-part-batches rewrite, raycast picking by instance id to redo). C: leave it, and accept 7 to 16 ms of bindings work while moving at this scene.',
      'why': 'Measured: while moving, the bindings stage grows from 2 to 9 to 18 ms with the same 92 objects, and the growth is 80 to 160 redundant writes of camera and light uniforms, one per instanced batch. This is the largest single movement cost found so far, and it is the camera-data separation Astra raised, now with a named mechanism in Three’s source. Both A and B keep every image identical; they change only how many times the same bytes are written. I would start with A behind a flag, because it is small and reversible, and because B is a rewrite of two working modules.'})
d['updatedAt'] = '2026-09-09T01:30:00.000Z'
json.dump(d, open(p, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)

p = 'docs/render-progress-log.json'
d = json.load(open(p, encoding='utf-8'))
d['entries'].append({'at': '2026-09-09T01:30Z', 'title': 'The movement cost is the bindings stage: camera and light uniforms rewritten once per instanced mesh',
  'body': 'Seven ?trace=1 captures, plants and structures off. Standing: main-scene bindings stage 2 ms, 36 writes a frame. Moving: 9 to 18 ms and 117 to 197 writes with the same 92 objects. The rows name the writes: cameraViewMatrix and the light position Vector3s in the render group, written 18 times for the cloth material, once per body-part batch, and likewise per weapon and debris batch. Three’s source explains it: the render group is shared by uniform-node identity, but getMaterialCacheKey appends object.uuid for every InstancedMesh (three.webgpu.js:30160 area, TODO citing PR 29066), so each instanced mesh gets its own node build, its own light uniform nodes and its own render bind group. Standing per-object writes are ours and small (water and cloud numbers, one terrain batch number). Task 17 asks for a decision: patch the vendored Three (A), move the batches to storage-driven meshes (B), or accept (C). This is the camera-data separation Astra proposed, now measured at 7 to 16 ms of a moving frame at this scene.', 'commits': []})
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False); open(p, 'a', encoding='utf-8').write('\n')

patch('docs/render-pipeline-map.html', [
("Task 13 is the walk on the fixed build; task 14 the structures A/B.||",
 "Task 13 is the walk on the fixed build; task 14 the structures A/B.|Trace pair 00:24 to 00:26Z: standing, the bindings stage is 2 ms with 36 uniform writes; moving, 9 to 18 ms with 117 to 197 writes on the same 92 objects. The extra writes are the camera view matrix and light positions written once per instanced batch (18 times for the cloth material) because Three keys an instanced mesh's node build by its uuid, so the shared render bind group never engages. Task 17: patch the vendored Three, move the batches off InstancedMesh, or accept.||"),
("GC allocators named; field starvation fixed</text>", "moving: bindings 2 to 9-18 ms, per-batch camera writes</text>"),
("2. structures on / off</text>", "2. share the render group (A/B/C)</text>"),
("one tile per frame, one unit</text>", "7 to 16 ms of a moving frame</text>"),
])

# stats: a trace-pair table for the 00:24 captures
patch('scratchpads/fps-churn/stats-evening.mjs', [
("export function eveningSection(entries) {",
 """export function tracePairSection(entries) {
  const caps = entries.filter(e => e.capturedAt >= '2026-09-09T00:20' && e.capturedAt < '2026-09-09T00:30' && e.context?.render?.trace?.enabled);
  if (!caps.length) return '';
  const rows = caps.map(e => {
    const lf = e.context.render.trace.lastFrame || {}, main = (lf.scenes || []).find(s => s.name === 'Scene') || {}, pa = e.performance.passes || {};
    const moving = rowsOf(e.performance).some(r => r.speed > 0.5);
    const top = (main.uniformWriteRows || []).slice(0, 3).map(r => `${r.count}× ${r.name.split(' @')[0]}${r.name.includes(' @') ? ' @' + r.name.split(' @')[1].split('/')[0] : ''}`).join('; ');
    return `<tr><td>${hhmm(e.capturedAt)}</td><td>${moving ? 'moving' : 'standing'}</td><td>${r1(e.performance.frameMs.p50)}</td><td>${r0(main.objects)}</td><td>${r1(main.encodeMs)}</td><td>${r1(main.bindingsMs)}</td><td>${r1(pa.passTraceBindingsMs?.p50)}</td><td>${r1(pa.passTraceBindingsMs?.p95)}</td><td>${r0(main.bindingWrites)}</td><td>${esc(top)}</td></tr>`;
  }).join('');
  return `
<h3>Standing against moving with the trace on (2026-09-09, 00:24 to 00:26Z; plants and structures off)</h3>
<p>The same scene, first still, then walking, then still. "bindings" is the stage of the object encode that diffs and writes uniform buffers; "writes" is how many uniform buffers the backend was asked to write in the last frame of the capture, and the last column names the most-written uniforms with the object encoding them.</p>
<table><thead><tr><th>time</th><th></th><th>frame p50</th><th>main-scene objects</th><th>encode (last frame)</th><th>bindings (last frame)</th><th>bindings p50</th><th>p95</th><th>uniform writes</th><th>most written</th></tr></thead><tbody>${rows}</tbody></table>
<p class="fnote">Moving quadruples the bindings stage on the same objects, and the added writes are the camera view matrix and the light positions, each written once per instanced batch rather than once per frame: Three keys an instanced mesh's node build by its uuid (getMaterialCacheKey, a TODO citing PR 29066), so the light uniform nodes are rebuilt per mesh and the shared render bind group's identity check fails. The standing per-object writes (water and cloud numbers, one terrain batch number) are ours and small.</p>`;
}

export function eveningSection(entries) {"""),
])
patch('scratchpads/fps-churn/build-stats-tab.mjs', [
("import { eveningSection } from './stats-evening.mjs';", "import { eveningSection, tracePairSection } from './stats-evening.mjs';"),
("${eveningSection(entries)}\n${heapSection()}", "${eveningSection(entries)}\n${tracePairSection(entries)}\n${heapSection()}"),
])
print('t16 results written')
