// Tests mind-map.js: demo codes are legal, every code observed in a real trace
// produces complete in-range activations, and key states map the way the doc claims.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { REGIONS, EDGES, DEMO_STATES, mindActivations, attentionBearing } from './mind-map.js';
import { isLegalCode, illegalReason } from './bot-state-code.js';

const ids = REGIONS.map((r) => r.id);
assert.equal(new Set(ids).size, 7, 'seven distinct regions');
for (const [a, b] of EDGES) {
  assert.ok(ids.includes(a) && ids.includes(b), `edge ${a}-${b} names real regions`);
}

for (const d of DEMO_STATES) {
  assert.ok(isLegalCode(d.code), `demo code ${d.code} legal (${illegalReason(d.code)})`);
}

function checkComplete(code, a, motion = null) {
  assert.ok(a, `activations for ${code}`);
  for (const id of ids) {
    const r = a.regions[id];
    assert.ok(r && Number.isFinite(r.level), `${code} ${id} level finite`);
    assert.ok(r.level >= 0 && r.level <= 1, `${code} ${id} level in [0,1], got ${r.level}`);
    assert.equal(typeof r.detail, 'string', `${code} ${id} has a detail string`);
  }
  assert.ok(a.doing.length > 0, `${code} has a plain reading`);
  return a;
}

// every distinct code from the newest shipped trace
const traces = readdirSync('bot-states').filter((f) => /^bot-state-trace-.*\.tsv$/.test(f)).sort();
assert.ok(traces.length, 'a trace file exists');
const lines = readFileSync(`bot-states/${traces.at(-1)}`, 'utf8').split(/\r?\n/).filter(Boolean);
const codeCol = lines[0].split('\t').indexOf('code');
const speedCol = lines[0].split('\t').indexOf('speed');
assert.ok(codeCol >= 0, 'trace has a code column');
const seen = new Set();
for (let i = 1; i < lines.length; i++) {
  const c = lines[i].split('\t');
  if (seen.has(c[codeCol])) continue;
  seen.add(c[codeCol]);
  checkComplete(c[codeCol], mindActivations(c[codeCol], { speed: +c[speedCol] || 0 }));
}
assert.ok(seen.size > 5, `trace exercised ${seen.size} distinct codes`);

// dead is fully dark
const dead = checkComplete('D00r--000', mindActivations('D00r--000'));
for (const id of ids) assert.equal(dead.regions[id].level, 0, `dead ${id} at zero`);

// a held latch shows in the commitments region
const cover = checkComplete('C32r-4412', mindActivations('C32r-4412'));
assert.ok(cover.regions.commit.level > 0, 'cover commit lights commitments');
assert.match(cover.regions.commit.detail, /cover/, 'commit detail names the latch');

// firing maxes weapon skill; unarmed zeroes it
assert.equal(mindActivations('F00r-4410').regions.weapon.level, 1, 'fire -> weapon 1');
assert.equal(mindActivations('H00r--210').regions.weapon.level, 0, 'unarmed -> weapon 0');

// measured motion overrides the state estimate
assert.equal(mindActivations('P00r-4410', { speed: 5 }).regions.movement.level, 1, 'measured speed drives movement');

// row context enriches details: target, gate, goal, path, squad leadership
const ctx = {
  speed: 2.1, targetId: 'bot-251', targetDist: 12.13, visGate: 'w',
  goalDist: 13.1, pathMode: 'seek', pathLen: 4,
  squadId: 'squad-55', squadRank: 0, leaderId: 'bot-240',
};
const rich = checkComplete('U43r-2310', mindActivations('U43r-2310', ctx));
assert.match(rich.regions.perception.detail, /Watching bot-251 at 12\.1m; it is behind a wall\./);
assert.match(rich.regions.intent.detail, /The goal is 13m away\./);
assert.match(rich.regions.movement.detail, /The seek path has 4 nodes\./);
assert.match(rich.regions.social.detail, /It leads squad-55\./);
const follower = mindActivations('U43r-2310', { ...ctx, squadRank: 2, leaderId: 'bot-239' });
assert.match(follower.regions.social.detail, /It follows bot-239 in squad-55\./);
assert.match(mindActivations('P00r-4410', { speed: 0 }).regions.perception.detail, /It sees no target\./);

// bearing: forward = (sin yaw, cos yaw); result relative to facing, (-180, 180]
assert.equal(attentionBearing({ x: 0, z: 0, yaw: 0 }, { x: 0, z: 5 }), 0);   // dead ahead
assert.equal(attentionBearing({ x: 0, z: 0, yaw: 0 }, { x: 5, z: 0 }), 90);  // to the right
assert.equal(attentionBearing({ x: 0, z: 0, yaw: 90 }, { x: 5, z: 0 }), 0);  // facing it
assert.equal(attentionBearing({ x: 0, z: 0, yaw: 350 }, { x: 0, z: 5 }), 10); // wraps
assert.ok(Math.abs(attentionBearing({ x: 0, z: 0, yaw: 0 }, { x: -0.001, z: -5 })) <= 180); // behind stays in range
assert.equal(attentionBearing({ x: 0, z: 0, yaw: null }, { x: 5, z: 0 }), null);
assert.equal(attentionBearing(null, { x: 5, z: 0 }), null);

// garbage in, null out
assert.equal(mindActivations('nonsense'), null);

console.log(`mind-map ok: 7 regions, ${EDGES.length} edges, ${DEMO_STATES.length} demo codes, ${seen.size} trace codes checked (${traces.at(-1)})`);
