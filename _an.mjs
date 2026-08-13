import { decodeBotState } from 'file:///G:/My Drive/Scripts/procedural-creature/workshop-webgpu/bot-state-code.js';
import { readFileSync } from 'fs';
const lines = readFileSync(process.argv[2],'utf8').trim().split('\n');
const rows = lines.slice(1).map(l=>{const [t,id,team,code,ch]=l.split('\t');return {t:+t,id,team,code,ch};});
console.log(`rows=${rows.length}  span=${(Math.max(...rows.map(r=>r.t))/1000).toFixed(1)}s  bots=${new Set(rows.map(r=>r.id)).size}`);
const bad = rows.filter(r=>{const d=decodeBotState(r.code); return !d || !d.legal;});
console.log(`illegal/malformed rows: ${bad.length}` + (bad.length?`  e.g. ${bad.slice(0,3).map(b=>b.id+' '+b.code+' '+(decodeBotState(b.code)?.illegalReason||'malformed')).join(', ')}`:''));
const by = new Map();
for (const r of rows){ if(!by.has(r.id)) by.set(r.id,[]); by.get(r.id).push(r); }
const stat=[];
for (const [id,rs] of by){
  const d = rs.map(r=>({...r, d:decodeBotState(r.code)}));
  const states = {}; for(const x of d) states[x.d.stateChar]=(states[x.d.stateChar]||0)+1;
  const hp = new Set(d.map(x=>x.d.healthChar)), am = new Set(d.map(x=>x.d.ammoChar));
  const first=d[0], last=d[d.length-1];
  // dwell per state
  const dwell={}; for(let i=0;i<d.length;i++){const end=(i+1<d.length?d[i+1].t:last.t); dwell[d[i].d.stateChar]=(dwell[d[i].d.stateChar]||0)+(end-d[i].t);}
  stat.push({id,team:first.team,n:d.length,t0:first.t,t1:last.t,span:last.t-first.t,states,dwell,
    fired:!!states.F, dead:!!states.D, hpSet:[...hp].join(''), amSet:[...am].join(''),
    maxTier:Math.max(...d.map(x=>+x.d.tierChar)), coverMs:(dwell.C||0)+(dwell.G||0), fireMs:dwell.F||0, aimMs:dwell.A||0});
}
stat.sort((a,b)=>b.span-a.span);
console.log('\nid            team   rows  span_s  fired  dead  states(dwell ms)                     hp     ammo   maxTier');
for(const s of stat){
  const dw = Object.entries(s.dwell).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}:${v}`).join(' ');
  console.log(`${s.id.padEnd(12)} ${s.team.padEnd(6)} ${String(s.n).padStart(4)} ${(s.span/1000).toFixed(1).padStart(6)}  ${s.fired?'YES':'no '}   ${s.dead?'yes':'no '}  ${dw.padEnd(36)} ${s.hpSet.padEnd(6)} ${s.amSet.padEnd(6)} ${s.maxTier}`);
}
console.log('\n--- POW candidates: >=5s tracked, never F, health band never changed ---');
for(const s of stat) if(s.span>=5000 && !s.fired && s.hpSet.length===1 && !s.dead)
  console.log(`  ${s.id} (${s.team})  ${(s.span/1000).toFixed(1)}s  cover ${(s.coverMs/1000).toFixed(1)}s  aim ${(s.aimMs/1000).toFixed(1)}s  hp=${s.hpSet} ammo=${s.amSet}`);
