// Reads a DevTools performance trace (Chrome trace-event JSON) and attributes long main-thread
// frames: nested slices, minor GCs, sampling-profile self time, worker tasks, GPU tasks.
import fs from 'node:fs';
const file = process.argv[2];
const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const ev = raw.traceEvents;
const threads = {}, procs = {};
for (const e of ev) {
  if (e.ph === 'M' && e.name === 'thread_name') threads[e.pid + ':' + e.tid] = e.args.name;
  if (e.ph === 'M' && e.name === 'process_name') procs[e.pid] = e.args.name;
}
const tname = e => threads[e.pid + ':' + e.tid] || '?';
const X = ev.filter(e => e.ph === 'X' && e.dur != null);
const main = X.filter(e => tname(e) === 'CrRendererMain');
const frames = main.filter(e => e.name === 'FireAnimationFrame').sort((a, b) => a.ts - b.ts);
console.log('main-thread rAF frames', frames.length, 'long (>=50ms)', frames.filter(f => f.dur >= 50000).length);
const inside = (e, f) => e.ts >= f.ts && e.ts + e.dur <= f.ts + f.dur;

// 1. Nested slices inside long frames vs normal frames, by name (self-ish: top-level names only).
const longF = frames.filter(f => f.dur >= 50000), normF = frames.filter(f => f.dur < 25000);
function nestedByName(fs_) {
  const acc = {}; let n = 0;
  const idx = main.slice().sort((a, b) => a.ts - b.ts);
  for (const f of fs_) {
    n++;
    for (const e of idx) { if (e.ts > f.ts + f.dur) break; if (e === f || !inside(e, f)) continue; if (['RunTask', 'v8.callFunction', 'FunctionCall', 'v8::Debugger::AsyncTaskRun', 'PageAnimator::serviceScriptedAnimations'].includes(e.name)) continue; acc[e.name] = acc[e.name] || { ms: 0, count: 0 }; acc[e.name].ms += e.dur / 1000; acc[e.name].count++; }
  }
  return Object.entries(acc).map(([name, v]) => ({ name, msPerFrame: +(v.ms / n).toFixed(2), perFrame: +(v.count / n).toFixed(1) })).sort((a, b) => b.msPerFrame - a.msPerFrame).slice(0, 14);
}
console.log('\n[1] nested slices per LONG frame (>=50ms), avg over', longF.length); 


// 2. Minor GC on main: total, per second, inside long frames.
const gcs = main.filter(e => e.name === 'MinorGC');
let tmin = Infinity, tmax = 0; for (const e of ev) { if (e.ts) { if (e.ts < tmin) tmin = e.ts; if (e.ts > tmax) tmax = e.ts; } } const span = (tmax - tmin) / 1e6;
console.log('\n[2] MinorGC on main:', gcs.length, 'total ms', (gcs.reduce((a, e) => a + e.dur, 0) / 1000).toFixed(0), 'per second', (gcs.length / span).toFixed(1), 'avg ms', (gcs.reduce((a, e) => a + e.dur, 0) / 1000 / gcs.length).toFixed(2), 'max ms', (gcs.reduce((a, e) => Math.max(a, e.dur), 0) / 1000).toFixed(1));
const major = main.filter(e => /MajorGC|V8.GCFinalizeMC|V8.GCIncrementalMarking/.test(e.name));
console.log('MajorGC-ish on main:', major.length, 'total ms', (major.reduce((a, e) => a + e.dur, 0) / 1000).toFixed(0), 'max', (major.reduce((a, e) => Math.max(a, e.dur), 0) / 1000).toFixed(1));

// 3. Sampling profile: self time by function inside long frames vs normal frames.
const profiles = ev.filter(e => e.name === 'ProfileChunk' && tname(e) === 'CrRendererMain');
console.log('\n[3] ProfileChunk events on main:', profiles.length);
if (profiles.length) {
  const nodes = new Map(); let t = 0; const samples = [];  // [ts, nodeId]
  const starts = ev.filter(e => e.name === 'Profile' && tname(e) === 'CrRendererMain');
  const startTs = starts.length ? starts[0].args.data.startTime : null;
  for (const p of profiles.sort((a, b) => a.ts - b.ts)) {
    const d = p.args.data.cpuProfile || {};
    for (const n of d.nodes || []) nodes.set(n.id, n);
    const td = p.args.data.timeDeltas || [];
    const ss = d.samples || [];
    for (let i = 0; i < ss.length; i++) { t += td[i] || 0; samples.push([(startTs ?? 0) + t, ss[i]]); }
  }
  console.log('samples', samples.length, 'nodes', nodes.size);
  const fname = id => { const n = nodes.get(id); if (!n) return '?'; const cf = n.callFrame || {}; return (cf.functionName || '(anonymous)') + ' ' + (cf.url || '').split('/').pop() + ':' + (cf.lineNumber ?? ''); };
  const parentOf = new Map(); for (const n of nodes.values()) for (const c of n.children || []) parentOf.set(c, n.id);
  function agg(fs_, label) {
    const self = {}; let n = 0;
    let si = 0; samples.sort((a, b) => a[0] - b[0]);
    for (const f of fs_) { while (si < samples.length && samples[si][0] < f.ts) si++; let j = si; while (j < samples.length && samples[j][0] <= f.ts + f.dur) { const k = fname(samples[j][1]); self[k] = (self[k] || 0) + 1; n++; j++; } }
    console.log(`\n[3] self samples inside ${label} (${fs_.length} frames, ${n} samples):`);
    console.table(Object.entries(self).sort((a, b) => b[1] - a[1]).slice(0, 18).map(([k, v]) => ({ fn: k.slice(0, 70), share: +(100 * v / n).toFixed(1) })));
    // ancestors: attribute each sample to the first frame whose url is one of ours (not three)
    const ours = {};
    si = 0;
    for (const f of fs_) { while (si < samples.length && samples[si][0] < f.ts) si++; let j = si; while (j < samples.length && samples[j][0] <= f.ts + f.dur) { let id = samples[j][1], hit = null; while (id != null) { const nn = nodes.get(id); const url = nn?.callFrame?.url || ''; if (url && !/three|^$/.test(url)) { hit = fname(id); break; } id = parentOf.get(id); } ours[hit || '(three/browser only)'] = (ours[hit || '(three/browser only)'] || 0) + 1; j++; } }
    console.log(`[3] nearest OUR-code frame on the stack, ${label}:`);
    console.table(Object.entries(ours).sort((a, b) => b[1] - a[1]).slice(0, 16).map(([k, v]) => ({ fn: k.slice(0, 80), share: +(100 * v / n).toFixed(1) })));
  }
  agg(longF, 'LONG frames');
  agg(normF, 'NORMAL frames');
}

// 4. Workers: long tasks per worker and overlap with long main frames.
const workers = X.filter(e => tname(e) === 'DedicatedWorker thread' && e.name === 'RunTask' && e.dur >= 20000);
const byTid = {}; for (const w of workers) { const k = w.pid + ':' + w.tid; byTid[k] = byTid[k] || { n: 0, ms: 0, max: 0 }; byTid[k].n++; byTid[k].ms += w.dur / 1000; byTid[k].max = Math.max(byTid[k].max, w.dur / 1000); }
console.log('\n[4] worker RunTasks >= 20ms by thread:'); console.table(Object.entries(byTid).map(([k, v]) => ({ thread: k, tasks: v.n, totalMs: +v.ms.toFixed(0), maxMs: +v.max.toFixed(0) })));
const wurl = {}; for (const e of ev) { if (e.args?.data?.url && /worker/.test(e.args.data.url)) { wurl[e.args.data.url.split('/').pop()] = (wurl[e.args.data.url.split('/').pop()] || 0) + 1; } }
console.log('worker urls seen:', JSON.stringify(wurl));
let overl = 0; for (const f of longF) { if (workers.some(w => w.ts < f.ts + f.dur && w.ts + w.dur > f.ts)) overl++; }
let overlN = 0; for (const f of normF) { if (workers.some(w => w.ts < f.ts + f.dur && w.ts + w.dur > f.ts)) overlN++; }
console.log('long main frames overlapping a worker task >=20ms:', overl, 'of', longF.length, '| normal frames:', overlN, 'of', normF.length);

// 5. GPU process tasks.
const gpu = X.filter(e => e.name === 'GPUTask');
console.log('\n[5] GPUTask:', gpu.length, 'total ms', (gpu.reduce((a, e) => a + e.dur, 0) / 1000).toFixed(0), 'busy share', ((gpu.reduce((a, e) => a + e.dur, 0) / 1e6) / span).toFixed(2), 'max ms', (gpu.reduce((a, e) => Math.max(a, e.dur), 0) / 1000).toFixed(1));
