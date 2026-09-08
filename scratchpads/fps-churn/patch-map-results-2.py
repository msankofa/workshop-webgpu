# One-off: Astra's corrections to the first results (vegetation removal is not a per-object tax; dips: association, not cause).
p = 'docs/render-pipeline-map.html'
s = open(p, encoding='utf-8').read()

def rep(o, n):
    global s
    assert s.count(o) == 1, o[:70]
    s = s.replace(o, n)

rep('''The size of the prize is now measured end to end: switching the tree LOD rungs off dropped the standing frame from about 24 to 16 ms, about 80 us per forest mesh, so merging one role (16 meshes) is worth about 1.3 ms and all seven roles about 7 ms.|Compact mode has still not been rendered''',
'''Switching the tree LOD rungs off dropped the standing frame from about 24 to 16 ms. That is a vegetation-removal result: geometry, shading, shadows and culling went with the RenderObjects, so it is an upper bound on what any forest change can recover, not a per-object figure, and it does not predict what merging one role saves.|Compact mode has still not been rendered''')
rep('''    <text x="1215" y="612" font-size="12.5" text-anchor="middle" fill="#111827">admitted by the device; ~80 µs per mesh</text>''',
'''    <text x="1215" y="612" font-size="12.5" text-anchor="middle" fill="#111827">admitted by the device; forest ≤ ~8 ms</text>''')

rep('''Spike frames carry 20 to 30 ms of gap between frames against 2 ms in ordinary frames, small long tasks, and 1.4 to 1.7 busy terrain workers against 0.2 to 0.3. So at the minimal scene the dip is terrain streaming: worker activity plus frames the browser did not schedule.|Whether those gaps are GPU-side (terrain uploads) or scheduling is the next question: a walking A/B at one worker and GPU timestamps on.''',
'''Spike frames carry 20 to 30 ms of gap between frames against 2 ms in ordinary frames, small long tasks, and 1.4 to 1.7 busy terrain workers against 0.2 to 0.3. That excludes plants as necessary to the dips and associates them with terrain worker activity; it does not say why the next frame was late. A main thread can be busy elsewhere, blocked or descheduled, and the GPU may be involved.|A one-worker against two-worker walk tests the setting's effect; GPU timestamps say whether GPU time rises in those frames. Neither attributes the gap by itself; that needs the aligned frame timeline or a DevTools trace.''')
rep('''    <text x="520" y="974" font-size="11" text-anchor="middle" fill="#4b5563">gaps + busy workers; drift unexplained</text>''',
'''    <text x="520" y="974" font-size="11" text-anchor="middle" fill="#4b5563">associated with worker activity; cause open</text>''')

rep('''Marked not worth building in this form; the object-count lever above is where the same saving is real.</li>''',
'''Marked not worth building in this form. A separate, bounded idea remains open: keep camera and pass data apart from stable object transforms and combine them in the shader, so the per-object upload is not redone for camera motion; its shader, memory and Three-integration costs are unassessed.</li>''')

rep('''<li><b>Draw fewer objects.</b> Every object pays the tax, so merging the forest's far-branch meshes into one draw per role cuts the largest group from 144 meshes toward a handful. The prototype exists behind a default-off option; it must first be shown to render identically and to cost less on the GPU than the draws it saves.</li>''',
'''<li><b>Draw fewer objects.</b> Every object pays the per-object refresh, so merging the forest's far-branch meshes into one draw per role cuts the largest group from 144 meshes toward a handful. Turning the forest off entirely saved about 8 ms, which bounds the prize; what one merged role saves is unknown until the same-content comparison runs. The prototype exists behind a default-off option; it must first be shown to render identically and to cost less on the GPU than the draws it saves.</li>''')

open(p, 'w', encoding='utf-8', newline='').write(s)
print('map corrected')
