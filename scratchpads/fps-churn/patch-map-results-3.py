# One-off: the map takes in tasks 6-8 (forest pair rendered, worker A/B, GPU timestamps) and the heap finding.
p = 'docs/render-pipeline-map.html'
s = open(p, encoding='utf-8').read()

def rep(o, n):
    global s
    assert s.count(o) == 1, o[:70]
    s = s.replace(o, n)

# forest node
rep('''|Compact mode has still not been rendered: the user's forest run toggled the LOD rungs instead, so the comparison is reassigned.||deviceLimits in the 13:17Z captures; LOD toggles 14:48 to 14:55Z, trace off.">''',
'''|Rendered 19:42 to 19:45Z at one spot, no flags: both merged modes drew with no fallback, all 16 variants visible, no visual difference seen. Forest draws 97 to 82 (the 16 far-branch meshes to 1); frame p50 18.1 ms at variants against 19.4 (slots) and 20.3 (compact), p95 23.8 against 42.2 and 31.2, within run noise. The 50M reported triangles is the declared ceiling (index count times the geometry's instance ceiling, three.webgpu.js:81505), not GPU work; GPU time for the pair was not captured.|Verdict: merging one role does not pay at this object count. Default-off, not recommended, closed.||deviceLimits in the 13:17Z captures; pair 19:42 to 19:45Z.">''')
rep('''    <rect class="node" x="1060" y="586" width="310" height="70" rx="6" fill="#fef3c7" stroke="#b45309" stroke-width="1.6"/>''',
'''    <rect class="node" x="1060" y="586" width="310" height="70" rx="6" fill="#ffffff" stroke="#1f2937" stroke-width="1.6"/>''')
rep('''admitted by the device; forest ≤ ~8 ms</text>''', '''rendered: 15 fewer draws, no gain</text>''')
rep('''compact still unrendered</text>''', '''frame 1 to 2 ms slower; closed</text>''')

# dips node
rep('''|A one-worker against two-worker walk tests the setting's effect; GPU timestamps say whether GPU time rises in those frames. Neither attributes the gap by itself; that needs the aligned frame timeline or a DevTools trace.|Sessions also drift against each other at the same settings; observed, not explained.||14:50 to 14:55Z captures; series columns betweenMs, longTaskMs, terrainInFlight, terrainBusyWorkers.">''',
'''|One worker against two (19:48 to 19:55Z, trees and grass off): p50 20.3 and 22.4 ms against 27.9, 22.8 and 16.8; spikes 5% of frames in every run. No effect distinguishable from run-to-run variation.|GPU timestamps (20:03 to 20:08Z): render passes p50 0.33 to 0.46 ms, worst 1.9 ms. GPU pass execution is not where the 40 to 130 ms frames go; the render call is 11 to 16 ms of main-thread time at 180 to 260 draws. Timestamps are a frame late, quantized at about 65 us, and exclude presentation.|New: the JS heap grows 22 to 46 MB/s in every capture, standing still included, with GC-sized drops of about 24 MB every second or so; spike frames carry a drop 3 to 10 times more often than ordinary frames, though most spikes have none. Association; the allocating code is unnamed.|Spike frames also carry 45 to 100 ms long tasks that none of our slots hold. Attribution needs a DevTools recording (task 10).||series columns betweenMs, longTaskMs, heapMB, terrainInFlight, terrainBusyWorkers.">''')
rep('''persist with trees and grass off</text>''', '''CPU-bound: GPU ≤ 2 ms, workers no effect</text>''')
rep('''associated with worker activity; cause open</text>''', '''unslotted long tasks + GC drops; cause open</text>''')

# next steps
rep('''1. forest: variants vs compact</text>''', '''1. allocation sampling, standing</text>''')
rep('''the one comparison not yet run</text>''', '''who allocates 30 MB/s at rest?</text>''')
rep('''2. walking A/B: 1 worker vs 2</text>''', '''2. DevTools recording, walking</text>''')
rep('''on the minimal scene, trees off</text>''', '''what fills the 45 to 100 ms tasks?</text>''')
rep('''3. GPU timestamps while walking</text>''', '''3. push decision</text>''')
rep('''are the gaps GPU or scheduling?</text>''', '''forest modes stay off; risk is low</text>''')
rep('''4. push decision</text>''', '''4. per-draw CPU cost</text>''')
rep('''once 1 looks right</text>''', '''11 to 16 ms for 180 to 260 draws</text>''')

# problem tab
rep('''Turning the forest off entirely saved about 8 ms, which bounds the prize; what one merged role saves is unknown until the same-content comparison runs. The prototype exists behind a default-off option; it must first be shown to render identically and to cost less on the GPU than the draws it saves.</li>''',
'''Turning the forest off entirely saved about 8 ms, which bounds the prize. The same-content comparison ran on 2026-09-08: merging the far-branch role removed 15 draws, rendered identically as far as the eye could tell, and gained nothing (the standing frame was 1 to 2 ms slower, within noise). The option stays default-off and is not recommended; the lever is real only at a much larger reduction in draws than one role offers.</li>''')
rep('''<li><b>Measure first.</b> The trace now splits the render step into its six stages, counts refreshes and writes, names any shader compile, and records what the device granted. Nothing above is accepted until a browser capture agrees with the Node results.</li>''',
'''<li><b>Measure first.</b> The trace now splits the render step into its six stages, counts refreshes and writes, names any shader compile, and records what the device granted. Nothing above is accepted until a browser capture agrees with the Node results.</li>
<li><b>Where this stands after 2026-09-08.</b> GPU pass time is under 2 ms in every frame measured; the frame is main-thread time, 11 to 16 ms in the render call for 180 to 260 draws with plants off, and its dips are frames the browser did not run plus 45 to 100 ms long tasks that none of our timers hold. The heap grows 22 to 46 MB/s even standing still, with collections landing in some spike frames. The next two measurements are a DevTools allocation profile and a DevTools performance recording; they name code, which the capture cannot.</li>''')

open(p, 'w', encoding='utf-8', newline='').write(s)
print('map updated for tasks 6-8')
