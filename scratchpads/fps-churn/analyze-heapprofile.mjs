// Reads Chrome allocation-sampling profiles (.heapprofile) and ranks allocators.
// node scratchpads/fps-churn/analyze-heapprofile.mjs <file> [topN]
import fs from 'node:fs';

const file = process.argv[2], TOP = +(process.argv[3] || 25);
const prof = JSON.parse(fs.readFileSync(file, 'utf8'));
const nodes = new Map();
const parentOf = new Map();
(function walk(n, parent) { nodes.set(n.id, n); parentOf.set(n.id, parent); for (const c of n.children || []) walk(c, n); })(prof.head, null);

const frameOf = n => { const f = n.callFrame; const url = (f.url || '').split('/').slice(-1)[0]; return `${f.functionName || '(anonymous)'} ${url}${f.lineNumber >= 0 ? ':' + (f.lineNumber + 1) : ''}`; };
const shortUrl = n => (n.callFrame.url || '').split('/').slice(-1)[0];
const isOurs = n => { const u = shortUrl(n); return u && !/^three|^chrome|^extensions/.test(u) && (n.callFrame.url || '').includes('127.0.0.1'); };

// Self bytes held live at the end (head tree) and sampled bytes over the run (samples array).
let liveTotal = 0; for (const n of nodes.values()) liveTotal += n.selfSize || 0;
const sampled = new Map(); let sampledTotal = 0, sampleCount = 0;
for (const s of prof.samples || []) { sampled.set(s.nodeId, (sampled.get(s.nodeId) || 0) + s.size); sampledTotal += s.size; sampleCount++; }

console.log(`file: ${file.split('/').pop()}`);
console.log(`nodes ${nodes.size}, samples ${sampleCount}, sampled ${(sampledTotal / 1048576).toFixed(1)} MB, live at end ${(liveTotal / 1048576).toFixed(1)} MB`);

function rank(weightOf, title) {
  // by leaf frame
  const byFrame = new Map();
  for (const [id, w] of weightOf) { const n = nodes.get(id); if (!n || !w) continue; const k = frameOf(n); byFrame.set(k, (byFrame.get(k) || 0) + w); }
  // by nearest frame in our own modules (walking up the stack)
  const byOurs = new Map();
  const bySubsystem = new Map();
  for (const [id, w] of weightOf) {
    let n = nodes.get(id); if (!n || !w) continue;
    let owner = null;
    for (let p = n; p; p = parentOf.get(p.id)) { if (isOurs(p)) { owner = p; break; } }
    const k = owner ? frameOf(owner) : '(no frame of ours on the stack: ' + frameOf(n) + ')';
    byOurs.set(k, (byOurs.get(k) || 0) + w);
    const file = owner ? shortUrl(owner) : (shortUrl(n) || '(native)');
    bySubsystem.set(file, (bySubsystem.get(file) || 0) + w);
  }
  const total = [...weightOf.values()].reduce((a, b) => a + b, 0) || 1;
  const show = (m, label) => { console.log(`\n${title}: ${label}`); [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP).forEach(([k, v]) => console.log(`  ${(v / 1048576).toFixed(2).padStart(8)} MB ${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`)); };
  show(bySubsystem, 'by file (nearest frame of ours)');
  show(byOurs, 'by nearest function of ours');
  show(byFrame, 'by allocating frame');
}
rank(sampled, 'SAMPLED over the run');
const live = new Map(); for (const n of nodes.values()) if (n.selfSize) live.set(n.id, n.selfSize);
rank(live, 'LIVE at the end');
