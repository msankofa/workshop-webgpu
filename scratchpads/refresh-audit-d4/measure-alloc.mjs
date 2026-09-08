// Approximate allocation + cost comparison: old audit (versions snapshot) vs new.
const which = process.argv[2];
const mod = which === 'old'
  ? await import('../../versions/render-refresh-audit-before-noobservedchange-20260908-080112.js')
  : await import('../../render-refresh-audit.js');

import { PerformanceObserver } from 'node:perf_hooks';
let scavenges = 0;
new PerformanceObserver(list => { for (const e of list.getEntries()) scavenges++; }).observe({ entryTypes: ['gc'] });

const mat4 = () => ({ elements: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1] });
const cam = { name: 'main', type: 'PerspectiveCamera', matrixWorldInverse: mat4(), projectionMatrix: mat4() };
function obj(name){ return { name, type:'Mesh', visible:true, layers:{mask:1}, castShadow:false, receiveShadow:true,
  matrixWorld: mat4(), geometry:{ id:7, attributes:{ position:{id:1,version:0} } } }; }
function ro(object){
  const uniforms = [{name:'u0',value:1,getValue(){return this.value;}},{name:'u1',value:{x:1,y:2,z:3},getValue(){return this.value;}}];
  const group = { name:'objectGroup', bindings:[{uniforms}] };
  return { object, material:{type:'NodeMaterial',version:0,opacity:1,color:{r:1,g:1,b:1}}, geometry:object.geometry,
    camera:cam, context:{id:1}, lightsNode:{getCacheKey:()=>'lights'}, getBindings:()=>[group] };
}
const backend = { updateBinding(){}, updateAttribute(){} };
const renderer = { _nodes:{ nodeFrame:{frameId:0,renderId:0}, needsRefresh(){return true;} },
  _bindings:{ updateForRender(){} }, backend,
  encode(r){ if (this._nodes.needsRefresh(r)) this._bindings.updateForRender(r); } };

const audit = mod.createRefreshAudit({ now: () => Number(process.hrtime.bigint())/1e6 });
audit.attach(renderer);
const list = [];
for (let i=0;i<200;i++){ const o=obj('wall-'+i); audit.declare(o); list.push(ro(o)); }

const FRAMES = 500;
for (let f=0;f<20;f++){ for (const r of list) renderer.encode(r); audit.take(); }  // warm
global.gc?.(); const h0 = process.memoryUsage().heapUsed;
const s0 = scavenges;
const t0 = process.hrtime.bigint();
let last;
for (let f=0;f<FRAMES;f++){ for (const r of list) renderer.encode(r); last = audit.take(); }
const ms = Number(process.hrtime.bigint()-t0)/1e6;
const h1 = process.memoryUsage().heapUsed;
const audits = FRAMES*list.length;
await new Promise(r => setTimeout(r, 50));
console.log(JSON.stringify({ which, audits,
  gcEvents: scavenges - s0, heapGrowthBytes: h1-h0,
  wallMsTotal: +ms.toFixed(1), wallMsPerAudit: +(ms/audits).toFixed(5),
  auditMsPerObject: last.auditMsPerObject }, null, 0));
