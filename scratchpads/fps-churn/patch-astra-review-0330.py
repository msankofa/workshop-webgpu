# Astra's review of the shared-light results: withdraw the general claim, reframe task 20, propose the next
# supported implementation (static refresh skip for storage-driven meshes) as task 21.
import json

def patch(path, pairs):
    s = open(path, encoding='utf-8').read()
    for o, n in pairs:
        assert s.count(o) == 1, (path, o[:80]); s = s.replace(o, n)
    open(path, 'w', encoding='utf-8', newline='').write(s); print('patched', path)

p = 'docs/render-tasks.json'; d = json.load(open(p, encoding='utf-8')); by = {t['id']: t for t in d['tasks']}
t13 = by['t13-verify-resumable']
t13['outcome'] = t13['outcome'].replace('and the dips over 50 ms come back only with plants on.', 'and in this session the frames over 50 ms appeared only with plants on; earlier sessions on this build had over-50 frames with plants off (collections, the reply handler), so this is what this session showed, not a general rule.')
t20 = by['t20-forest-object-count']
t20['title'] = 'Optional: forest look settings that also cut object count (your preference, not a prerequisite)'
t20['criteria'] = 'Nothing required. If you ever want a lighter forest, the Tree look panel has variants per species, the LOD rungs and leaf shadows, and each object dropped is worth about 0.1 ms of walking frame by the traced ratio. The implementation route that keeps the picture is task 21.'
t20['why'] = 'Astra’s point, agreed: acceptable frame rate through reduced quality must not be the default answer. The forest’s cost while walking is per-object encode work, and task 21 removes most of that work without removing objects.'
t20['status'] = 'done'; t20['doneAt'] = '2026-09-09T03:40:00Z'; t20['outcome'] = 'Reframed as optional after review; the implementation route is task 21.'
if 't21-static-refresh-skip' not in by:
    d['tasks'].append({'id': 't21-static-refresh-skip', 'createdAt': '2026-09-09T03:40:00Z', 'status': 'open', 'doneAt': None, 'notes': '', 'files': [],
      'title': 'Decide: skip the per-object refresh for the forest’s meshes (identical picture)',
      'criteria': 'Say yes, no, or ask. Yes means a second local change to the vendored Three, behind its own flag (?staticskip=0 restores upstream): a node material may honour object.static, so a mesh marked static is refreshed once per material per render and skipped otherwise; forest-gpu marks its meshes static. Node tests on the gate’s rules; then the same traced plants-on walk.',
      'why': 'The plants-on trace says where the plant cost is: 186 main-scene objects, 68 uniform writes, none of them from the forest’s 144 meshes, yet 6.2 ms diffing bindings and 5.5 ms updating nodes across all of them, about 65 µs per object of refresh work that changes nothing. Three refreshes every object with a node material every frame; it honours object.static only for plain materials. The forest’s meshes are safe to skip: their positions come from storage buffers, their model-view matrix is composed in the shader from a shared camera matrix, they share seven materials, and the first object per material per render still refreshes, which keeps the shared render group and shared buffer uploads current. Expected by arithmetic, not measured: about 9 ms of the 17 to 18 ms plants-on encode. Correctness to prove: first initialisation always refreshes, a material change makes a new render object, the once-per-material rule, and the flag off restores upstream.'})
d['updatedAt'] = '2026-09-09T03:40:00.000Z'
json.dump(d, open(p, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)

p = 'docs/render-progress-log.json'; d = json.load(open(p, encoding='utf-8'))
d['entries'].append({'at': '2026-09-09T03:40Z', 'title': 'Review applied: coverage test for the light patch, task 20 reframed, the refresh skip proposed for the forest',
  'body': 'Astra: patch correctness needs coverage beyond a default-scene look; task 20 must not make quality cuts the prerequisite; "plants are the only source of frames over 50 ms" is this session’s observation, not a rule. Done: test-three-shared-light-uniforms.mjs now covers different lights not sharing, property mutation reaching every node, a shadow-casting spot, two material graphs sharing the light nodes (their render groups came out identical, recorded), disposal and recreation, a fresh light, and the flag off after nodes exist; 15 checks. The claim is reworded in task 13. Task 20 reframed as optional. The plants-on trace read again for the implementation route: 186 objects and 68 writes, none from the forest’s 144 meshes, yet 6.2 ms of bindings diffing and 5.5 ms of node updates; Three refreshes every node-material object every frame (NodeMaterialObserver.needsRefresh returns true on hasNode before it looks at object.static), model-view is composed in the shader from the shared camera matrix so the object group is camera-independent, the forest uses seven shared materials, and the observer already refreshes the first object per material per render. Task 21 proposes honouring object.static for node materials behind a flag and marking the forest meshes static; expected about 9 ms of the plants-on encode by arithmetic.', 'commits': []})
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False); open(p, 'a', encoding='utf-8').write('\n')

patch('docs/subsystems/infra.md', [
("`test-three-shared-light-uniforms.mjs` proves the node identity across two instanced builds, flag on and off |",
 "`test-three-shared-light-uniforms.mjs` proves the node identity across two instanced builds, flag on and off, and covers distinct lights not sharing, property mutation, a shadow-casting spot, two material graphs, disposal and recreation, and the flag turned off after nodes exist (15 checks) |"),
])
patch('docs/render-pipeline-map.html', [
("Task 20 asks which forest objects to give up.||",
 "Plants-on trace read for the route: the forest's 144 meshes write no uniforms at all, yet the frame spends 6.2 ms diffing bindings and 5.5 ms updating nodes across 186 objects, because Three refreshes every node-material object every frame and honours object.static only for plain materials. Task 21 proposes honouring it for node materials behind a flag, with the forest's meshes marked static: once per material per render, skipped otherwise, identical picture.||"),
("2. forest object count (task 20)</text>", "2. static refresh skip (task 21)</text>"),
("plants = +100 objects = +16 ms walking</text>", "forest: 144 objects, 0 writes, ~65 µs each</text>"),
])
print('review applied')
