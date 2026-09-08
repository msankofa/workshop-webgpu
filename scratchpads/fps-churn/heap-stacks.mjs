// Top allocating stacks (leaf + 7 callers) for one profile, optionally only under a named owner frame.
import fs from 'node:fs';
const [file, owner = '', topN = '20'] = process.argv.slice(2);
const prof = JSON.parse(fs.readFileSync(file, 'utf8'));
const nodes = new Map(), parentOf = new Map();
(function walk(n, p) { nodes.set(n.id, n); parentOf.set(n.id, p); for (const c of n.children || []) walk(c, n); })(prof.head, null);
const fr = n => { const f = n.callFrame; const u = (f.url || '').split('/').pop(); return `${f.functionName || '(anon)'}@${u}${f.lineNumber >= 0 ? ':' + (f.lineNumber + 1) : ''}`; };
const w = new Map(); for (const s of prof.samples || []) w.set(s.nodeId, (w.get(s.nodeId) || 0) + s.size);
const rows = [];
for (const [id, bytes] of w) {
  const chain = []; let hit = !owner;
  for (let p = nodes.get(id); p && chain.length < 9; p = parentOf.get(p.id)) { chain.push(fr(p)); if (owner && fr(p).startsWith(owner)) hit = true; }
  if (!hit) continue;
  rows.push([bytes, chain.join(' < ')]);
}
rows.sort((a, b) => b[0] - a[0]);
const total = rows.reduce((s, r) => s + r[0], 0);
console.log(`${file.split('/').pop()} owner=${owner || '(all)'} total ${(total / 1048576).toFixed(1)} MB`);
for (const [b, c] of rows.slice(0, +topN)) console.log(`${(b / 1048576).toFixed(1).padStart(7)} MB  ${c}`);
