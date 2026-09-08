# One-off: the map takes in the first Tasks-tab results (2026-09-08 evening). Idempotent by assertion.
p = 'docs/render-pipeline-map.html'
s = open(p, encoding='utf-8').read()

def rep(o, n):
    global s
    assert s.count(o) == 1, o[:70]
    s = s.replace(o, n)

rep('''  <g data-tip="Audit built and Node-tested; the skip itself is a design.|Next: a browser run with the audit on the moving route. Zero disagreements is evidence for those objects and frames, not proof, because updateAfter and side effects outside bindings, attributes and uniforms are not in the oracle.">
    <rect class="node" x="1060" y="496" width="310" height="70" rx="6" fill="#fef2f2" stroke="#b91c1c" stroke-width="1.6" stroke-dasharray="5 3"/>
    <text x="1215" y="522" font-size="12.5" text-anchor="middle" fill="#111827">audit shipped; skip not built</text>
    <text x="1215" y="540" font-size="11" text-anchor="middle" fill="#4b5563">needs a browser capture first</text>''',
'''  <g data-tip="The audit ran about 33,000 frames on the user's route: zero cases where a skip would have been wrong, but almost every declared object changed every frame anyway.|Its per-object uniform group carries modelViewMatrix, which depends on the camera, so while the camera moves the refresh writes a binding for every static object, and that write is necessary. Only when standing still did an object come back unchanged.|The audit's own check cost 0.4 to 0.6 ms per object in the browser, against roughly 0.06 to 0.1 ms of refresh work it could save.|Verdict: not worth building in this form. The audit stays as instrumentation.||?refreshaudit=1 captures 14:08 to 14:55Z; reasons bindingWrite + uniformValue, changed camera + bindings.">
    <rect class="node" x="1060" y="496" width="310" height="70" rx="6" fill="#ffffff" stroke="#1f2937" stroke-width="1.6"/>
    <text x="1215" y="522" font-size="12.5" text-anchor="middle" fill="#111827">audit ran: skip not worth building</text>
    <text x="1215" y="540" font-size="11" text-anchor="middle" fill="#4b5563">camera motion makes every write necessary</text>''')

rep('''  <g data-tip="Coded and compiled headless; never rendered.|Not recommended from draw counts: the invocation ratio is arithmetic, not GPU timing, and parity is unseen.|Browser order: variants vs pulled-compact first (pixel diff, forced-failure check of the fallback), then a GPU timestamp comparison. The padded slot mode is a diagnostic control.">
    <rect class="node" x="1060" y="586" width="310" height="70" rx="6" fill="#fef3c7" stroke="#b45309" stroke-width="1.6"/>
    <text x="1215" y="612" font-size="12.5" text-anchor="middle" fill="#111827">prototype; nothing rendered</text>
    <text x="1215" y="630" font-size="11" text-anchor="middle" fill="#4b5563">tail guard + fallback lifecycle in review</text>''',
'''  <g data-tip="The device grants 8 storage buffers in the vertex stage (compatibility mode off), so the pulled modes are admitted on this machine.|The size of the prize is now measured end to end: switching the tree LOD rungs off dropped the standing frame from about 24 to 16 ms, about 80 us per forest mesh, so merging one role (16 meshes) is worth about 1.3 ms and all seven roles about 7 ms.|Compact mode has still not been rendered: the user's forest run toggled the LOD rungs instead, so the comparison is reassigned.||deviceLimits in the 13:17Z captures; LOD toggles 14:48 to 14:55Z, trace off.">
    <rect class="node" x="1060" y="586" width="310" height="70" rx="6" fill="#fef3c7" stroke="#b45309" stroke-width="1.6"/>
    <text x="1215" y="612" font-size="12.5" text-anchor="middle" fill="#111827">admitted by the device; ~80 µs per mesh</text>
    <text x="1215" y="630" font-size="11" text-anchor="middle" fill="#4b5563">compact still unrendered</text>''')

rep('''    <text x="520" y="956" font-size="11" text-anchor="middle" fill="#4b5563">long tasks + worker activity; some pure gaps</text>
    <text x="520" y="974" font-size="11" text-anchor="middle" fill="#4b5563">session-to-session drift unexplained</text>''',
'''    <text x="520" y="956" font-size="11" text-anchor="middle" fill="#4b5563">persist with trees and grass off</text>
    <text x="520" y="974" font-size="11" text-anchor="middle" fill="#4b5563">gaps + busy workers; drift unexplained</text>''')

rep('''<g data-tip="In the 2026-09-08 sessions, spike frames still carried long tasks and more terrain jobs in flight and busy workers than ordinary frames, at 2 threads.|One session's spikes were pure gaps between frames with nothing in our slots and no long task recorded.|The whole session also ran slower than the day before at the same settings: real, unexplained, and not a progressive drift mechanism.||Series columns terrainInFlight, terrainBusyWorkers, betweenMs, longTaskMs; spikes.slots meanInSpikes vs meanInOthers.">''',
'''<g data-tip="With trees and grass off and the frame at 15 to 17 ms standing, walking still dips.|Spike frames carry 20 to 30 ms of gap between frames against 2 ms in ordinary frames, small long tasks, and 1.4 to 1.7 busy terrain workers against 0.2 to 0.3. So at the minimal scene the dip is terrain streaming: worker activity plus frames the browser did not schedule.|Whether those gaps are GPU-side (terrain uploads) or scheduling is the next question: a walking A/B at one worker and GPU timestamps on.|Sessions also drift against each other at the same settings; observed, not explained.||14:50 to 14:55Z captures; series columns betweenMs, longTaskMs, terrainInFlight, terrainBusyWorkers.">''')

rep('''    <text x="190" y="1098" font-size="13" font-weight="600" text-anchor="middle" fill="#111827">1. trace pair</text>
    <text x="190" y="1116" font-size="11" text-anchor="middle" fill="#4b5563">?trace=1, then &amp;tracephases=0</text>''',
'''    <text x="190" y="1098" font-size="13" font-weight="600" text-anchor="middle" fill="#111827">1. forest: variants vs compact</text>
    <text x="190" y="1116" font-size="11" text-anchor="middle" fill="#4b5563">the one comparison not yet run</text>''')
rep('''    <text x="520" y="1098" font-size="13" font-weight="600" text-anchor="middle" fill="#111827">2. drones, vehicles, grass</text>
    <text x="520" y="1116" font-size="11" text-anchor="middle" fill="#4b5563">parity of the shipped changes</text>''',
'''    <text x="520" y="1098" font-size="13" font-weight="600" text-anchor="middle" fill="#111827">2. walking A/B: 1 worker vs 2</text>
    <text x="520" y="1116" font-size="11" text-anchor="middle" fill="#4b5563">on the minimal scene, trees off</text>''')
rep('''    <text x="850" y="1098" font-size="13" font-weight="600" text-anchor="middle" fill="#111827">3. refresh audit</text>
    <text x="850" y="1116" font-size="11" text-anchor="middle" fill="#4b5563">?refreshaudit=1, then capture</text>''',
'''    <text x="850" y="1098" font-size="13" font-weight="600" text-anchor="middle" fill="#111827">3. GPU timestamps while walking</text>
    <text x="850" y="1116" font-size="11" text-anchor="middle" fill="#4b5563">are the gaps GPU or scheduling?</text>''')
rep('''    <text x="1200" y="1098" font-size="13" font-weight="600" text-anchor="middle" fill="#111827">4. forest: variants vs compact</text>
    <text x="1200" y="1116" font-size="11" text-anchor="middle" fill="#4b5563">last, and only after 1 to 3</text>''',
'''    <text x="1200" y="1098" font-size="13" font-weight="600" text-anchor="middle" fill="#111827">4. push decision</text>
    <text x="1200" y="1116" font-size="11" text-anchor="middle" fill="#4b5563">once 1 looks right</text>''')

rep('''<li><b>Answer the refresh question ourselves for objects we can prove static.</b> For buildings, structures and roads, snapshot every input that could change their shader data and skip the refresh when none did. Getting this wrong shows stale geometry, so the first step is an audit that never skips and only reports where a skip would have been wrong.</li>''',
'''<li><b>Answer the refresh question ourselves for objects we can prove static.</b> Tried as a non-skipping audit first. The audit ran 33,000 frames and found that while the camera moves, every static object's refresh writes a necessary uniform (its model-view matrix depends on the camera), and the check itself cost more than the work it could skip. Marked not worth building in this form; the object-count lever above is where the same saving is real.</li>''')

open(p, 'w', encoding='utf-8', newline='').write(s)
print('map updated')
