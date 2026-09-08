// Stats-tab section: the user's allocation-sampling profiles of 2026-09-08 (before tasks 11 and 12).
import fs from 'node:fs';
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const PROFILES = [
  ['standing, no trees', 'research/stats/sitting still no trees Heap-20260908T190051.heapprofile'],
  ['standing, no trees (2)', 'research/stats/2sitting still no trees Heap-20260908T190051.heapprofile'],
  ['running, no trees', 'research/stats/running no treesHeap-20260908T190217.heapprofile'],
  ['standing, trees on, grass off', 'research/stats/sitting no grass trees Heap-20260908T190217.heapprofile'],
  ['standing, trees on, grass off (3)', 'research/stats/3sitting no grass trees Heap-20260908T190217.heapprofile'],
  ['tasks 11+12 first build, default scene (walking)', 'research/stats/post 11 12 - default- Heap-20260908T191225.heapprofile'],
  ['tasks 11+12 first build, no plants (walking)', 'research/stats/post 11 12 - no plants- Heap-20260908T191225.heapprofile'],
];
// What each nearest own frame is, in words, for the table.
const OWNERS = [
  ['Three: uniform update ranges', n => /updateVector3|updateMatrix4|updateVector4|updateColor|updateNumber|addUniformUpdateRange/.test(n) && /three\.webgpu/.test(n)],
  ['terrain batch visibility (syncBatchVisibility, applyMaterials)', n => /syncBatchVisibility|applyMaterials/.test(n)],
  ['kill plane: volumetric density scan (worldKillPlaneY)', n => /worldKillPlaneY|hashedCell3|fbm3@|densityAt/.test(n)],
  ['ground probes and capsule collision (map-collision, world-query)', n => /raycastAll|intersectsTriangle|resolveCapsule|rayCandidates|groundProbe|normalizeHit|collectRayHits|moveAndCollide/.test(n)],
  ['field derivation and road queries (task 12 path)', n => /clearanceAt|distancePointToPolylineXZ|queryEdges|queryNodes|derive@flora-field|nearestDistance/.test(n)],
  ['player bodies, weapons, part batches', n => /player-procedural-body|base-game-player-bodies|weapon-mount|body-part-batches|updateMatrixWorld/.test(n)],
];
function load(file) {
  const prof = JSON.parse(fs.readFileSync(file, 'utf8'));
  const nodes = new Map(), parentOf = new Map();
  (function walk(n, p) { nodes.set(n.id, n); parentOf.set(n.id, p); for (const c of n.children || []) walk(c, n); })(prof.head, null);
  const fr = n => { const f = n.callFrame; const u = (f.url || '').split('/').pop(); return `${f.functionName || '(anon)'}@${u}${f.lineNumber >= 0 ? ':' + (f.lineNumber + 1) : ''}`; };
  const w = new Map(); let total = 0;
  for (const s of prof.samples || []) { w.set(s.nodeId, (w.get(s.nodeId) || 0) + s.size); total += s.size; }
  const owners = new Map(); const other = [];
  for (const [id, bytes] of w) {
    const chain = []; for (let p = nodes.get(id); p && chain.length < 12; p = parentOf.get(p.id)) chain.push(fr(p));
    const joined = chain.join(' < ');
    let hit = null;
    for (const [name, test] of OWNERS) { if (chain.some(test)) { hit = name; break; } }
    if (!hit) { hit = 'everything else'; other.push([bytes, joined]); }
    owners.set(hit, (owners.get(hit) || 0) + bytes);
  }
  return { total, owners, samples: (prof.samples || []).length };
}
export function heapSection() {
  const rows = [];
  for (const [label, file] of PROFILES) { if (!fs.existsSync(file)) continue; try { rows.push({ label, ...load(file) }); } catch (e) { rows.push({ label, error: String(e.message) }); } }
  if (!rows.length) return '';
  const names = [...OWNERS.map(o => o[0]), 'everything else'];
  const table = `<table><thead><tr><th>profile</th><th>sampled MB</th>${names.map(n => `<th>${esc(n)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => r.error ? `<tr><td>${esc(r.label)}</td><td colspan="${names.length + 1}">${esc(r.error)}</td></tr>` : `<tr><td>${esc(r.label)}</td><td>${(r.total / 1048576).toFixed(0)}</td>${names.map(n => { const v = r.owners.get(n) || 0; return `<td>${(v / 1048576).toFixed(0)} <span class="dim">(${(100 * v / r.total).toFixed(0)}%)</span></td>`; }).join('')}</tr>`).join('')}</tbody></table>`;
  return `
<h3>Who allocates: allocation-sampling profiles (2026-09-08 19:00 to 19:14Z)</h3>
<p>Chrome's sampling heap profiler, recorded by the user with objects discarded by collection included (the sampled total equals what was live at the end, so these are allocations over the run, not a retained set). Each sample carries a byte weight; sums are allocation weight attributed up the recorded stack, grouped here by the nearest frame that names a subsystem. Boxed doubles count: a hash or matrix routine that returns a non-integer allocates a 16-byte number when it escapes, which is how <code>hashedCell3</code> and <code>multiplyMatrices</code> appear at all. Profile durations are not recorded, so columns compare shares, not rates.</p>
${table}
<p class="fnote">The largest single allocator standing still is Three's uniform update bookkeeping: <code>addUniformUpdateRange</code> creates a range object and a Map entry for every uniform that changed on every object every frame (three.webgpu.js:61815-61830), 15 to 17% of the run. The rest is ours: the per-frame terrain batch-visibility walk spreads a key array and builds iterator and residency objects each frame; the kill-plane check evaluates the volumetric density field for the player's column every frame; the ground probes for the procedural legs collect every ray hit as objects and arrays; and the field-derivation road queries, whose Sets, arrays and records task 12 has since removed. The two "first build" rows were taken on the first build of task 12, before its two fixes: road queries reached 32 and 45% of the run because a tile that had landed but not yet been delivered was neither queued nor in flight, so the window re-requested it every frame and duplicate builds and derivations fed the backlog (trees stopped spawning, grass lost its cover). Fixed by keeping landed tiles in the dedupe (5803a70's successor) and by indexing segment runs (e052abd). No profile of the fixed build yet.</p>`;
}
