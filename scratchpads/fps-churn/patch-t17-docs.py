# Option A shipped: docs, task 17 outcome, task 18, log.
import json
p = 'docs/subsystems/infra.md'; s = open(p, encoding='utf-8').read()
o = "| `uniformWriteRows` |"
n = ("| `three` (capture context) | Which Three the page ran: `vendor/three-0.184` with `REVISION` and `sharedLightUniforms`. Base Game serves its own copy of the 0.184 build from `vendor/three-0.184/` (importmap for `three`, `three/webgpu`, `three/tsl`; addons and three-mesh-bvh still come from the CDN and resolve `three` through the map) with one local patch, applied by `scratchpads/fps-churn/patch-three-shared-lights.py` to a fresh copy of `node_modules/three/build/three.webgpu.js`: light and shadow uniform nodes are cached per light (`lightSharedUniform`, `sharedRenderReference`), so instanced meshes of one material share one render bind group and camera and light uniforms are written once a frame, not once per object. `setSharedLightUniforms(false)` / `?sharedlights=0` restores upstream behaviour. `test-three-shared-light-uniforms.mjs` proves the node identity across two instanced builds, flag on and off | Re-apply the patch script after any Three upgrade; the root `three.webgpu.js` is an unpatched grep copy |\n"
     "| `uniformWriteRows` |")
assert s.count(o) == 1; open(p, 'w', encoding='utf-8', newline='').write(s.replace(o, n))

p = 'docs/render-tasks.json'; d = json.load(open(p, encoding='utf-8')); by = {t['id']: t for t in d['tasks']}
t = by['t17-render-group-sharing']; t['status'] = 'done'; t['doneAt'] = '2026-09-09T02:30:00Z'
t['notes'] = (t['notes'] + ' ' if t['notes'] else '') + '[user: try a]'
t['outcome'] = 'A shipped. Base Game now serves its own copy of Three 0.184 from vendor/three-0.184 with one patch: the light and shadow uniform nodes that each material build used to create afresh are cached per light, so instanced meshes of one material share one render bind group. Node test: two instanced builds of one material get identical render-group uniform nodes with the patch on and different ones with it off. ?sharedlights=0 turns the patch off for an A/B. Unseen in a browser; task 18 is the check.'
if 't18-shared-lights-check' not in by:
    d['tasks'].append({'id': 't18-shared-lights-check', 'createdAt': '2026-09-09T02:30:00Z', 'status': 'open', 'doneAt': None, 'notes': '', 'files': [],
      'title': 'Check the shared light uniforms: look, then the trace pair, then the A/B',
      'criteria': 'Reload (the page now loads Three from vendor/three-0.184). First look: lighting, the flashlight and its shadow, the sun shadow, bodies and weapons must look as before; note anything dark, flickering or unlit. Then base-game.html?trace=1, plants and structures off: one capture standing, one walking. Then the same two with base-game.html?trace=1&sharedlights=0. Four captures.',
      'why': 'The patch changes which uniform nodes a light hands each material build; the images should be identical, but that is a claim until you see them. The walking capture is the measurement: uniform writes a frame should fall from 117 to 197 toward the 37 of standing still, and the bindings stage from 9 to 18 ms toward 2 to 3. The sharedlights=0 pair is the control on the same build.'})
d['updatedAt'] = '2026-09-09T02:30:00.000Z'
json.dump(d, open(p, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)

p = 'docs/render-progress-log.json'; d = json.load(open(p, encoding='utf-8'))
d['entries'].append({'at': '2026-09-09T02:30Z', 'title': 'Option A shipped: a vendored Three with shared light uniforms',
  'body': 'The page loaded Three from the CDN, so the patch needed a served copy: vendor/three-0.184 (three.webgpu.js, three.core.js, three.tsl.js from node_modules) with scratchpads/fps-churn/patch-three-shared-lights.py applied. The patch caches per light the uniform nodes AnalyticLightNode, PointLightNode, SpotLightNode, HemisphereLightNode and RectAreaLightNode created per build (colour, cone, penumbra, cutoff, decay, half extents) and per shadow the reference nodes the shadow filters created per build (mapSize, radius, bias, blurSamples, intensity, normalBias, camera near and far), so the bind-group identity key matches across builds and instanced meshes of one material share one render bind group. setSharedLightUniforms(false) and ?sharedlights=0 restore upstream. test-three-shared-light-uniforms.mjs: identical render-group node ids across two instanced builds with the flag on, different with it off; the light colour updates through the shared node; a light with its own colorNode keeps it. base-game.html importmap now points at the vendored build and the capture context records it. Unseen in a browser; task 18 asks for the look, the trace pair and the sharedlights=0 control.',
  'commits': []})
json.dump(d, open(p, 'w', encoding='utf-8'), indent=2, ensure_ascii=False); open(p, 'a', encoding='utf-8').write('\n')
print('docs, tasks, log ok')
