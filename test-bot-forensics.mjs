// test-bot-forensics.mjs — Node smoke tests for bot-forensics.js, the BB-004 physics ring recorder,
// and for stepBotPhysics's new opt-in `forensics` hook. Runs with a stub collider — no GPU, no BVH,
// no browser. Same shape as test-bot-entity-rescue.mjs, which this deliberately mirrors.
import { registerHooks } from 'node:module';

// The repo's local `three` install ships empty examples/jsm stubs (the browser loads addons from a
// CDN importmap), so bot-entity.js's Capsule import is redirected to a minimal equivalent here.
const CAPSULE_STUB = 'data:text/javascript,' + encodeURIComponent(`export class Capsule {
  constructor(start, end, radius) { this.start = start; this.end = end; this.radius = radius; }
  translate(v) { this.start.add(v); this.end.add(v); return this; }
}`);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'three/addons/math/Capsule.js') return { url: CAPSULE_STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
const { createBotEntity, stepBotPhysics } = await import('./bot-entity.js');
const {
  createBotForensics, FORENSIC_RING, FORENSIC_MAX_SLOTS, FORENSIC_STRIDE, FORENSIC_COLUMNS,
  F_T, F_DT_MS, F_PRE_Y, F_POST_Y, F_VEL_Y, F_GROUND_Y, F_X, F_Z, F_VEL_X, F_VEL_Z,
  F_STATE_KEY, F_FLAGS,
  FLAG_ON_FLOOR_IN, FLAG_GROUNDED_RAW, FLAG_ON_FLOOR_OUT, FLAG_RESCUED,
  FLAG_HAS_COLLIDER, FLAG_HAS_GROUND_REF,
} = await import('./bot-forensics.js');

let fail = 0, pass = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };
const near = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

// Rescue warnings are the feature working, not test noise: count them instead of printing.
let warnCount = 0;
const realWarn = console.warn;
console.warn = () => { warnCount++; };

const REF_Y = 4;                       // flat reference ground for every case below
const flatGround = () => REF_Y;
const collider = (grounded) => ({ resolveCapsule: () => ({ grounded }) });
function placeFeet(bot, feetY) {
  const h = bot.capsule.end.y - bot.capsule.start.y;
  bot.capsule.start.y = feetY + bot.capsule.radius;
  bot.capsule.end.y = bot.capsule.start.y + h;
}
function freshBot(id, feetY) {
  const bot = createBotEntity(id, { x: 2, y: REF_Y, z: -3 });
  placeFeet(bot, feetY);
  bot.onFloor = true;                  // suppress the gravity term so each case's geometry is exact
  bot.velocity.set(0, 0, 0);
  return bot;
}
// A THREE-free stand-in for the direct sample() cases: the recorder only reads plain numbers.
function stubBot(id, { x = 0, y = 1, z = 0, r = 0.5 } = {}) {
  return {
    id,
    capsule: { start: { x, y, z }, end: { x, y: y + 1, z }, radius: r },
    velocity: { x: 0, y: 0, z: 0 },
  };
}
// Read sample `k` (0 = oldest) out of a slot's ring, straight from the typed arrays.
function readSample(f, slot, k) {
  const n = f.count[slot];
  const start = n < f.ring ? 0 : f.writeIdx[slot];
  const b = (slot * f.ring + ((start + k) % f.ring)) * FORENSIC_STRIDE;
  return {
    t: f.i32[b + F_T], dtMs: f.f32[b + F_DT_MS], preY: f.f32[b + F_PRE_Y], postY: f.f32[b + F_POST_Y],
    velY: f.f32[b + F_VEL_Y], groundY: f.f32[b + F_GROUND_Y], x: f.f32[b + F_X], z: f.f32[b + F_Z],
    velX: f.f32[b + F_VEL_X], velZ: f.f32[b + F_VEL_Z],
    stateKey: f.i32[b + F_STATE_KEY], flags: f.i32[b + F_FLAGS],
  };
}
// TSV helpers: header comments are '#'-prefixed, then one column line, then the data rows.
const bodyOf = (tsv) => tsv.split('\n').filter(l => !l.startsWith('#'));
const dataRows = (tsv) => bodyOf(tsv).slice(1).map(l => l.split('\t'));
const colAt = (name) => FORENSIC_COLUMNS.indexOf(name);

// ---- 1: construction ----
{
  const f = createBotForensics();
  ok(f.ring === FORENSIC_RING && f.maxSlots === FORENSIC_MAX_SLOTS && f.stride === FORENSIC_STRIDE,
    '1: defaults are the exported ring/slot/stride constants');
  ok(f.buffer.byteLength === FORENSIC_MAX_SLOTS * FORENSIC_RING * FORENSIC_STRIDE * 4,
    '1: buffer is maxSlots * ring * stride * 4 bytes');
  ok(f.f32.buffer === f.buffer && f.i32.buffer === f.buffer,
    '1: the Float32 and Int32 views share one underlying buffer');
  ok(f.f32.length === f.i32.length && f.f32.length === f.buffer.byteLength / 4,
    '1: both views span the whole buffer');
  ok(f.free.length === FORENSIC_MAX_SLOTS && f.stats.slotsInUse === 0,
    '1: every slot starts free and none are in use');
  ok(f.ids.every(id => id === null), '1: no slot carries an id before the first sample');
  ok(f.snapshot.pending === false && f.pendingId() === null && f.exportSnapshot() === null,
    '1: no take is pending on a fresh recorder');
}

// ---- 2: slot lifecycle, recycling and the stale-slot guard ----
{
  const f = createBotForensics({ maxSlots: 4, ring: 8 });
  const a = stubBot('a', { r: 0.42 });
  f.setNow(100);
  f.sample(a, 1 / 60, 1, 0, 0, 0);
  ok(a.forensicSlot === 0 && f.ids[0] === 'a', '2: the first sample lazily assigns a slot');
  ok(near(f.radius[0], 0.42) && f.count[0] === 1 && f.stats.slotsInUse === 1,
    '2: assignment stamps the radius and starts the ring counters');

  f.sample(a, 1 / 60, 1, 0, 0, 0);
  ok(f.count[0] === 2, '2: a second sample reuses the same slot');

  ok(f.release(a) === true && f.ids[0] === null && f.free.includes(0) && f.stats.slotsInUse === 0,
    '2: release returns the slot to the free list');
  ok(a.forensicSlot == null, '2: release clears the bot-side slot handle');

  const b = stubBot('b');
  f.sample(b, 1 / 60, 1, 0, 0, 0);
  ok(b.forensicSlot === 0 && f.count[0] === 1,
    '2: a recycled slot starts at count 0 — no ghost history from the previous occupant');

  // Stale handle: `a` still points at slot 0, which `b` now owns. The id compare must reassign.
  a.forensicSlot = 0;
  f.sample(a, 1 / 60, 1, 0, 0, 0);
  ok(a.forensicSlot !== 0 && f.ids[a.forensicSlot] === 'a' && f.ids[0] === 'b',
    '2: the stale-slot guard reassigns rather than writing into another bot\'s ring');
  ok(f.count[0] === 1, '2: the stale write did not land in the other bot\'s ring');
}

// ---- 3: callers that do not opt in see zero behaviour change (twin comparison) ----
{
  const cases = [
    ['grounded, no rescue', REF_Y - 0.3, true, { mapCollider: collider(true), rescueHeightAt: flatGround }],
    ['tunnelled, rescued', REF_Y - 3, false, { mapCollider: collider(true), rescueHeightAt: flatGround }],
    ['free-faller', REF_Y - 60, false, { mapCollider: collider(false), rescueHeightAt: flatGround }],
    ['heightAt fallback', REF_Y - 2, false, { heightAt: flatGround }],
    ['airborne fallback', REF_Y + 5, false, { heightAt: flatGround }],
    ['no ground reference', REF_Y - 400, true, { mapCollider: collider(true) }],
  ];
  const f = createBotForensics({ maxSlots: 8, ring: 8 });
  let identical = true;
  for (const [label, feetY, onFloor, opts] of cases) {
    const plain = freshBot(`plain-${label}`, feetY);
    const rec = freshBot(`rec-${label}`, feetY);
    for (const bot of [plain, rec]) { bot.onFloor = onFloor; bot.velocity.set(1.5, -7, -2.5); }
    stepBotPhysics(plain, 1 / 60, opts);
    stepBotPhysics(rec, 1 / 60, { ...opts, forensics: f });
    const same = plain.capsule.start.x === rec.capsule.start.x
      && plain.capsule.start.y === rec.capsule.start.y
      && plain.capsule.start.z === rec.capsule.start.z
      && plain.capsule.end.y === rec.capsule.end.y
      && plain.velocity.x === rec.velocity.x && plain.velocity.y === rec.velocity.y
      && plain.velocity.z === rec.velocity.z
      && plain.onFloor === rec.onFloor && plain.floorRescues === rec.floorRescues
      && plain.floorRescueWarnAt === rec.floorRescueWarnAt;
    if (!same) { identical = false; console.error('  differs:', label); }
  }
  ok(identical, '3: with and without `forensics`, capsule/velocity/onFloor/floorRescues are identical');

  // And a caller that passes no `forensics` writes nothing at all.
  const before = f.stats.samples;
  const quiet = freshBot('quiet', REF_Y - 3);
  stepBotPhysics(quiet, 1 / 60, { mapCollider: collider(true), rescueHeightAt: flatGround });
  ok(f.stats.samples === before && quiet.forensicSlot === undefined,
    '3: omitting `forensics` records nothing and never stamps a slot');
}

// ---- 4: sample correctness against hand-computed values, both ground branches ----
{
  const f = createBotForensics({ maxSlots: 4, ring: 8 });
  f.setNow(12345.6);
  const bot = freshBot('bot-4', REF_Y);          // resting exactly on the reference ground
  bot.onFloor = false;                           // so the gravity term is exercised
  bot.velocity.set(2, 0, -1);
  const preY = bot.capsule.start.y;
  stepBotPhysics(bot, 1 / 60, { mapCollider: collider(true), rescueHeightAt: flatGround, forensics: f });
  const s = readSample(f, bot.forensicSlot, 0);
  ok(s.t === 12346, '4: t is the rounded per-frame clock from setNow, not performance.now()');
  ok(near(s.dtMs, 1000 / 60, 1e-3), '4: dt_ms is the dt actually passed in');
  ok(near(s.preY, preY), '4: pre_y is capsule.start.y at entry');
  ok(near(s.velY, -30 / 60), '4: vel_y is the post-gravity velocity that was integrated');
  ok(near(s.postY, bot.capsule.start.y), '4: post_y is capsule.start.y at exit');
  ok(near(s.groundY, REF_Y), '4: ground_y is the rescueHeightAt reading, radius excluded');
  ok(near(s.x, bot.capsule.start.x) && near(s.z, bot.capsule.start.z), '4: x/z are the post-step position');
  ok(near(s.velX, 2) && near(s.velZ, -1), '4: vel_x/vel_z are the post-step horizontal velocity');
  ok(s.stateKey === -1, '4: state_key defaults to -1 when the host never stamped one');
  ok(s.flags === (FLAG_GROUNDED_RAW | FLAG_ON_FLOOR_OUT | FLAG_HAS_COLLIDER | FLAG_HAS_GROUND_REF),
    '4: flags — airborne in, collider-grounded out, ground reference read, no rescue');

  // heightAt fallback branch: no collider, so has_collider must be clear.
  const g = createBotForensics({ maxSlots: 4, ring: 8 });
  g.setNow(500);
  const fb = freshBot('bot-4b', REF_Y - 2);
  fb.velocity.set(0, -5, 0);
  stepBotPhysics(fb, 1 / 60, { heightAt: flatGround, forensics: g });
  const t = readSample(g, fb.forensicSlot, 0);
  ok(near(t.groundY, REF_Y) && near(t.postY, REF_Y + fb.capsule.radius),
    '4: fallback branch records the heightAt reading and the snapped exit height');
  ok(t.flags === (FLAG_ON_FLOOR_IN | FLAG_GROUNDED_RAW | FLAG_ON_FLOOR_OUT | FLAG_HAS_GROUND_REF),
    '4: fallback flags clear has_collider and still report a ground reference');

  // Neither option: no ground reference at all, and ground_y stays NaN.
  const h = createBotForensics({ maxSlots: 4, ring: 8 });
  const none = freshBot('bot-4c', REF_Y - 400);
  stepBotPhysics(none, 1 / 60, { mapCollider: collider(true), forensics: h });
  const u = readSample(h, none.forensicSlot, 0);
  ok(Number.isNaN(u.groundY) && !(u.flags & FLAG_HAS_GROUND_REF),
    '4: with no height function, ground_y is NaN and has_ground_ref is clear');
}

// ---- 5: the rescue frame, the auto-freeze, and its first-take-wins policy ----
{
  const f = createBotForensics({ maxSlots: 4, ring: 8 });
  f.setNow(1000);
  const bot = freshBot('bot-5', REF_Y);
  const opts = { mapCollider: collider(true), rescueHeightAt: flatGround, forensics: f };
  stepBotPhysics(bot, 1 / 60, opts);            // a couple of ordinary frames of lead-up first
  f.setNow(1016);
  stepBotPhysics(bot, 1 / 60, opts);
  ok(f.snapshot.pending === false, '5: ordinary frames do not freeze a take');

  placeFeet(bot, REF_Y - 3);                    // tunnelled: the next step must rescue
  bot.onFloor = false;
  bot.velocity.set(0, -40, 0);
  f.setNow(1033);
  warnCount = 0;
  stepBotPhysics(bot, 1 / 60, opts);
  const slot = bot.forensicSlot;
  const r = readSample(f, slot, f.count[slot] - 1);
  ok(bot.floorRescues === 1 && (r.flags & FLAG_RESCUED) !== 0, '5: the rescue frame carries the rescued bit');
  ok(near(r.postY, REF_Y + bot.capsule.radius), '5: post_y on the rescue frame is the lifted height');
  ok(near(r.velY, -40 - 30 / 60), '5: vel_y latches the pre-rescue velocity, not the zeroed one');
  ok(bot.velocity.y === 0, '5: ...while the live capsule really was zeroed by the rescue');
  ok(f.snapshot.pending === true && f.pendingId() === 'bot-5' && f.snapshot.takenAt === 1033,
    '5: the rescue froze a take, named after the bot that fell');
  ok(f.snapshot.count === f.count[slot], '5: the frozen take holds the whole ring as of the rescue');
  ok(f.lastRescue.id === 'bot-5' && f.lastRescue.total === 1, '5: lastRescue points at the falling bot');
  ok((r.flags & FLAG_GROUNDED_RAW) !== 0 && (r.flags & FLAG_ON_FLOOR_OUT) !== 0,
    '5: grounded_raw survives the rescue forcing onFloor — a catch-slab REST reads grounded before the lift');

  // The other BB-004 shape: a capsule that tunnelled the slab too. Same rescued bit, but the collider
  // never found ground, so grounded_raw is what tells a slab rest apart from an uncaught free fall.
  {
    const faller = freshBot('bot-5-fall', REF_Y - 60);
    faller.onFloor = false;
    faller.velocity.set(0, -40, 0);
    stepBotPhysics(faller, 1 / 60, { mapCollider: collider(false), rescueHeightAt: flatGround, forensics: f });
    const fr = readSample(f, faller.forensicSlot, 0);
    ok((fr.flags & FLAG_RESCUED) !== 0 && !(fr.flags & FLAG_GROUNDED_RAW) && (fr.flags & FLAG_ON_FLOOR_OUT) !== 0,
      '5: an uncaught free-faller is rescued with grounded_raw clear — distinguishable from a slab rest');
  }

  // The newest frozen row is the rescue frame itself.
  const frozen = dataRows(f.exportSnapshot());
  ok(frozen[frozen.length - 1][colAt('rescued')] === '1',
    '5: the frozen take\'s newest row is the rescue frame');
  ok(f.snapshot.pending === false, '5: exporting re-arms the freeze');

  // A second rescue while a take is pending updates lastRescue but must not overwrite the take.
  placeFeet(bot, REF_Y - 3);
  f.setNow(2000);
  stepBotPhysics(bot, 1 / 60, opts);            // freezes take #2
  ok(f.snapshot.pending === true && f.snapshot.takenAt === 2000, '5: the next rescue freezes again');
  const freezesBefore = f.stats.freezes;
  const other = freshBot('bot-5b', REF_Y - 3);
  f.setNow(2100);
  stepBotPhysics(other, 1 / 60, opts);
  ok(f.stats.freezes === freezesBefore && f.snapshot.id === 'bot-5' && f.snapshot.takenAt === 2000,
    '5: a rescue while a take is pending does not overwrite it (first unexported rescue wins)');
  ok(f.lastRescue.id === 'bot-5b' && f.lastRescue.at === 2100,
    '5: ...but lastRescue still follows the newest rescue');
  ok(warnCount > 0, '5: the rescues still logged through bot-entity.js\'s own throttle');

  // A frozen take survives the release of the bot it came from.
  f.release(bot);
  ok(f.snapshot.pending === true && f.exportSnapshot() !== null,
    '5: releasing the bot does not destroy its pending take');
}

// ---- 6: Int32 key fidelity above 2^24 (guards a refactor into the float view) ----
{
  const f = createBotForensics({ maxSlots: 2, ring: 8 });
  // 43,679,999 is the real maximum of bot-state-code.js's packed key
  // (13*5*10*2*3*7*5*10*32 - 1); 33,554,433 = 2^25+1 has low bits float32 provably cannot keep.
  for (const key of [43679999, 33554433, 16777217, 0, -1]) {
    const bot = stubBot(`key-${key}`);
    bot.forensicStateKey = key;
    f.sample(bot, 1 / 60, 0, 0, 0, 0);
    const s = readSample(f, bot.forensicSlot, 0);
    ok(s.stateKey === key, `6: state_key ${key} round-trips byte-exact through the Int32 view`);
    f.release(bot);
  }
  ok(Math.fround(33554433) !== 33554433 && Math.fround(43679999) !== 43679999,
    '6: sanity — both probe values really are unrepresentable in float32');
  const probe = new Float32Array(1);
  probe[0] = 43679999;
  ok(probe[0] !== 43679999, '6: ...so the float view would have silently corrupted the same key');
}

// ---- 7: ring wrap ----
{
  const RING = 8;
  const f = createBotForensics({ maxSlots: 2, ring: RING });
  const bot = stubBot('wrap');
  for (let i = 0; i < 20; i++) {
    f.setNow(1000 + i * 16);
    bot.capsule.start.y = i;                     // a value that identifies which sample this is
    f.sample(bot, 1 / 60, i, 0, 0, 0);
  }
  ok(f.count[bot.forensicSlot] === RING, '7: the ring caps at its size, however many samples arrive');
  const rows = dataRows(f.exportLive(bot));
  ok(rows.length === RING, '7: export returns exactly `ring` rows after a wrap');
  const ts = rows.map(r => Number(r[colAt('t_ms')]));
  ok(ts.every((t, i) => i === 0 || t >= ts[i - 1]), '7: timestamps are non-decreasing across the wrap seam');
  ok(ts[0] === 1000 + 12 * 16 && ts[ts.length - 1] === 1000 + 19 * 16,
    '7: the surviving window is the newest `ring` samples, oldest first');
  const ys = rows.map(r => Number(r[colAt('post_y')]));
  ok(ys.join(',') === '12,13,14,15,16,17,18,19',
    '7: overwritten samples are gone, not duplicated or reordered');
}

// ---- 8: export TSV shape and the derived columns ----
{
  const f = createBotForensics({ maxSlots: 2, ring: 8 });
  const R = 0.5;
  const bot = stubBot('tsv', { r: R });
  f.setNow(10);
  // Frame 1: on the ground, ground reference present.
  bot.capsule.start.y = 4.5; bot.velocity.x = 3; bot.velocity.z = 4;
  f.sample(bot, 1 / 60, 4.5, -0.5, 4, FLAG_HAS_GROUND_REF | FLAG_ON_FLOOR_OUT);
  // Frame 2: entry Y is 0.25 BELOW where frame 1 left it — an external pushout, the ext_dy signal.
  f.setNow(26);
  bot.capsule.start.y = 4.1;
  f.sample(bot, 1 / 60, 4.25, -0.9, 4, FLAG_HAS_GROUND_REF);
  // Frame 3: no ground reference at all, so ground_y (and gap) must render blank.
  f.setNow(42);
  bot.capsule.start.y = 3.9;
  f.sample(bot, 1 / 60, 4.1, -1.2, NaN, 0);

  const tsv = f.exportLive(bot);
  const head = bodyOf(tsv)[0].split('\t');
  ok(head.join('\t') === FORENSIC_COLUMNS.join('\t'), '8: the column line is FORENSIC_COLUMNS');
  const rows = dataRows(tsv);
  ok(rows.length === 3 && rows.every(r => r.length === FORENSIC_COLUMNS.length),
    '8: every data row has exactly as many cells as there are columns');
  ok(tsv.split('\n').filter(l => l.startsWith('#')).length >= 3
    && tsv.includes('bot tsv') && tsv.includes('slot 0'),
    '8: the header comments name the bot and slot in the existing export style');

  ok(rows[0][colAt('ext_dy')] === '', '8: ext_dy is blank on the first row');
  ok(near(Number(rows[1][colAt('ext_dy')]), -0.25),
    '8: ext_dy = pre_y[n] - post_y[n-1] — the outside-stepBotPhysics displacement');
  ok(near(Number(rows[2][colAt('ext_dy')]), 0), '8: ext_dy is 0 when nothing moved the capsule between frames');
  ok(near(Number(rows[0][colAt('gap')]), 4 + R - 4.5), '8: gap = ground_y + radius - post_y');
  ok(rows[2][colAt('ground_y')] === '' && rows[2][colAt('gap')] === '',
    '8: a NaN ground reference renders as a blank cell, not the string "NaN"');
  ok(near(Number(rows[0][colAt('speed_xz')]), 5), '8: speed_xz is hypot(vel_x, vel_z)');
  ok(rows[0][colAt('on_floor_out')] === '1' && rows[1][colAt('on_floor_out')] === '0'
    && rows[0][colAt('has_ground_ref')] === '1' && rows[2][colAt('has_ground_ref')] === '0',
    '8: the decoded flag columns match the stored bitfield');
  ok(f.exportLiveById('tsv') !== null && f.exportLiveById('nobody') === null,
    '8: exportLiveById resolves a live ring by bot id and returns null for an unknown one');
  ok(f.exportLiveById(null) === null && f.exportLiveById(undefined) === null,
    '8: exportLiveById does not match a free slot when handed a missing id');
}

// ---- 9: slot exhaustion degrades quietly ----
{
  const f = createBotForensics({ maxSlots: 2, ring: 8 });
  const a = stubBot('a'), b = stubBot('b'), c = stubBot('c');
  for (const bot of [a, b, c]) f.sample(bot, 1 / 60, 0, 0, 0, 0);
  ok(a.forensicSlot === 0 && b.forensicSlot === 1, '9: the first maxSlots bots get slots');
  ok(c.forensicSlot === -1 && f.stats.droppedBots === 1, '9: the overflow bot is dropped, and counted');
  const samplesBefore = f.stats.samples;
  for (let i = 0; i < 5; i++) f.sample(c, 1 / 60, 0, 0, 0, 0);
  ok(f.stats.droppedBots === 1 && f.stats.samples === samplesBefore,
    '9: a dropped bot no-ops silently and is not re-counted every frame');
  ok(f.exportLive(c) === null, '9: exporting a dropped bot returns null rather than throwing');
}

// ---- 10: edge-case safety ----
{
  const f = createBotForensics({ maxSlots: 4, ring: 8 });
  const bot = stubBot('edge');
  // No setNow has ever been called: rows must still be written, with a sane t.
  f.sample(bot, 0, 1, 0, NaN, 0);
  const s = readSample(f, bot.forensicSlot, 0);
  ok(s.t === 0 && s.dtMs === 0 && Number.isNaN(s.groundY),
    '10: sampling before setNow, with dt 0 and a NaN ground reference, writes a sane row');
  f.setNow(NaN);
  f.sample(bot, 0, 1, 0, NaN, 0);
  ok(readSample(f, bot.forensicSlot, 1).t === 0, '10: a NaN clock stores 0, not garbage');
  ok(f.exportLive(bot) !== null && f.release(bot) === true, '10: that ring still exports and releases');
  ok(f.release(stubBot('never-sampled')) === false, '10: releasing a bot that never sampled is a no-op');
  ok(f.release(null) === false && f.release(undefined) === false, '10: release tolerates a missing bot');

  // A real physics step with dt 0 and a NaN reference height must not corrupt anything either.
  const g = createBotForensics({ maxSlots: 4, ring: 8 });
  const real = freshBot('edge-2', REF_Y - 50);
  stepBotPhysics(real, 0, { mapCollider: collider(true), rescueHeightAt: () => NaN, forensics: g });
  const e = readSample(g, real.forensicSlot, 0);
  ok(real.floorRescues === 0 && !(e.flags & FLAG_RESCUED) && (e.flags & FLAG_HAS_GROUND_REF) !== 0,
    '10: a NaN reference height is still a no-op, and is recorded as an attempted read');
}

console.warn = realWarn;
console.log(`bot forensics ring: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
