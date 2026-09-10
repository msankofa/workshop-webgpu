import sys, json, pathlib
sys.path.insert(0, 'scratchpads/fps-churn')
from importlib import import_module
m = import_module('compare-no-plants-traces'.replace('-', '_')) if False else None
import importlib.util
spec = importlib.util.spec_from_file_location('cmp', 'scratchpads/fps-churn/compare-no-plants-traces.py'); cmp = importlib.util.module_from_spec(spec); spec.loader.exec_module(cmp)
files = ['research/stats/Trace-20260909T221243.json.gz', 'research/stats/Trace-20260909T221638.json.gz', 'research/stats/running w trees - Trace-20260909T222012.json', 'research/stats/default - Trace-20260909T224650.json']
out = []
for f in files:
    r = cmp.analyze(pathlib.Path(f)); out.append(r)
    print('\n==', r['file'], 'start', r['start'], 'span', r['profileSpanSec'], 's')
    print('  rAF intervals', r['rafIntervals'], 'p50/p95/p99/max', r['intervalP50P95P99Max'], '>50', r['intervalsOver50'], '| long tasks', r['longTaskCount'], 'mean wall/cpu', r['longTaskMeanWallCpu'], '| normal', r['normalRafTaskCount'], r['normalMeanWallCpu'], '| GC', r['gc'])
    print('  steady samples inclusive', r['wholeSteadySamples']['inclusiveMs'])
    print('  nearest app (steady):', r['wholeSteadySamples']['nearestAppMs'][:8])
    for t in r['worstTasks'][:4]:
        print('  worst task @', t['offset'], 'wall', t['wallMs'], 'cpu', t['cpuMs'], 'offcpu', t['offCpuMs'], 'gc', t['gcMs'], 'raf', t['hasRAF'], '| nested', t['nested'][:3], '| app', t['samples']['nearestAppMs'][:4], '| incl', {k: v for k, v in t['samples']['inclusiveMs'].items()})
pathlib.Path('research/stats/trees-on-trace-review-20260909.json').write_text(json.dumps(out, indent=2), encoding='utf-8')
