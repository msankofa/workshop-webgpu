import { grassWindOffset, grassFadeKeep } from './grass.js';
let fail = 0; const ok = (c,m)=>{ console.log((c?'ok  ':'FAIL ')+m); if(!c) fail++; };
const w = (x)=>grassWindOffset(x, 1.0, 2.0, 10.0, 1/30);
ok(w(30.0) === w(30.0), 'wind deterministic');
ok(Math.abs(w(29.99) - w(30.01)) < 0.05, 'wind continuous across a chunk boundary');
ok(grassFadeKeep(0, 50, 100) === 1, 'near keeps full height');
ok(grassFadeKeep(100, 50, 100) === 0, 'far collapses to base');
ok(grassFadeKeep(75, 50, 100) > 0 && grassFadeKeep(75,50,100) < 1, 'mid partially collapsed');
console.log(fail? fail+' FAIL':'ALL PASS'); process.exit(fail?1:0);
