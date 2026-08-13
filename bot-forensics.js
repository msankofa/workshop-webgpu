// bot-forensics.js — pure, THREE-free per-bot physics ring recorder for BB-004 (capsules tunnelling
// the thin terrain sheet in bot-viewer-v2.html). bot-entity.js's floor rescue RECOVERS that state;
// this captures the ~17 s of physics leading INTO it so the trigger can be diagnosed from real data.
// Node-tested in test-bot-forensics.mjs; re-exported by bot-entity.js the way bot-separation.js is,
// so consumers keep a single entity-module import.
//
// One ArrayBuffer, two views (Float32Array + Int32Array) over the same memory, allocated once at
// creation and never grown: the write path allocates nothing per frame. Time comes from an explicit
// setNow(ms) call once per frame from the host loop rather than performance.now() per bot, so the
// module stays deterministic and Node-testable.
//
// `t`, `state_key` and `flags` go through the INT32 view on purpose. The packed 9-slot FSM key
// (bot-state-code.js) has a real maximum of 43,679,999; float32 represents integers exactly only up
// to 2^24 = 16,777,216, so storing the key in the float view WOULD silently corrupt real, reachable
// state combinations. Do not "simplify" those fields into the float view — test-bot-forensics.mjs
// case 6 exists to catch exactly that refactor.

export const FORENSIC_RING = 1024;      // samples per bot: ~17 s at 60 fps, >=10 s up to ~100 fps
export const FORENSIC_MAX_SLOTS = 128;  // concurrent recorded entities; 128 * 1024 * 12 * 4B = 6.29 MB
export const FORENSIC_STRIDE = 12;      // fields per sample

// Field offsets within one sample. INT32 view: T, STATE_KEY, FLAGS. FLOAT32 view: everything else.
export const F_T = 0;          // ms, host frame clock (Int32: wraps after ~24 days of uptime)
export const F_DT_MS = 1;      // the clamped dt actually passed into stepBotPhysics
export const F_PRE_Y = 2;      // capsule.start.y at entry, before gravity/translate
export const F_POST_Y = 3;     // capsule.start.y at exit, after collider + rescue
export const F_VEL_Y = 4;      // velocity.y after the gravity increment, BEFORE the rescue zeroes it
export const F_GROUND_Y = 5;   // the rescueHeightAt/heightAt reading for this frame; NaN when neither ran
export const F_X = 6;
export const F_Z = 7;
export const F_VEL_X = 8;
export const F_VEL_Z = 9;
export const F_STATE_KEY = 10; // packed FSM state key, or -1 when the host never stamped one
export const F_FLAGS = 11;

export const FLAG_ON_FLOOR_IN = 1;      // bot.onFloor at entry
export const FLAG_GROUNDED_RAW = 2;     // the branch's own grounded verdict BEFORE the rescue forced it
export const FLAG_ON_FLOOR_OUT = 4;     // bot.onFloor at exit
export const FLAG_RESCUED = 8;          // the below-terrain rescue fired this frame
export const FLAG_HAS_COLLIDER = 16;    // a mapCollider resolved this frame (vs. the heightAt fallback)
export const FLAG_HAS_GROUND_REF = 32;  // a ground-height function ran (its value may still be NaN)

// Export columns. gap/ext_dy/speed_xz are derived here, at export time, never stored per sample.
const COLUMNS = ['t_ms', 'dt_ms', 'pre_y', 'post_y', 'ext_dy', 'vel_y', 'ground_y', 'gap',
  'x', 'z', 'vel_x', 'vel_z', 'speed_xz', 'state_key', 'flags',
  'on_floor_in', 'grounded_raw', 'on_floor_out', 'rescued', 'has_collider', 'has_ground_ref'];
export const FORENSIC_COLUMNS = COLUMNS;

// Blank, not "NaN": a missing ground reference must read as an empty cell in the pasted TSV.
const num = (v, d) => (Number.isFinite(v) ? v.toFixed(d) : '');

function pow2AtLeast(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

export function createBotForensics(opts = {}) {
  const ring = pow2AtLeast(Math.max(2, Math.floor(opts.ring ?? FORENSIC_RING)));
  const maxSlots = Math.max(1, Math.floor(opts.maxSlots ?? FORENSIC_MAX_SLOTS));
  const ringMask = ring - 1;
  const slotFloats = ring * FORENSIC_STRIDE;

  const buffer = new ArrayBuffer(maxSlots * slotFloats * 4);
  const f32 = new Float32Array(buffer);
  const i32 = new Int32Array(buffer);
  // Per-slot metadata, written only on assign/release — never per frame.
  const ids = new Array(maxSlots).fill(null);
  const radius = new Float32Array(maxSlots);
  const writeIdx = new Uint32Array(maxSlots);
  const count = new Uint32Array(maxSlots);
  const free = [];
  for (let s = maxSlots - 1; s >= 0; s--) free.push(s);   // pop() hands out slot 0 first

  // Rescue auto-freeze: one preallocated take (48 KB at the default ring) so the fall that matters
  // survives the ~17 s the live ring would otherwise overwrite before anyone presses a key.
  const snapBuffer = new ArrayBuffer(slotFloats * 4);
  const snapF32 = new Float32Array(snapBuffer);
  const snapI32 = new Int32Array(snapBuffer);
  const snapshot = { pending: false, id: null, slot: -1, radius: 0, takenAt: 0, count: 0, writeIdx: 0 };
  // Mutated in place, never reallocated: a bot re-tunnelling every frame must not allocate per frame.
  const lastRescue = { id: null, at: 0, total: 0 };
  const stats = { droppedBots: 0, slotsInUse: 0, samples: 0, freezes: 0 };
  let nowMs = 0;

  function setNow(ms) { nowMs = Math.round(ms) | 0; }

  function assign(bot) {
    if (!free.length) {
      // Sticky: a dropped bot no-ops from here on, so droppedBots counts distinct bots, not frames.
      bot.forensicSlot = -1;
      stats.droppedBots++;
      return -1;
    }
    const slot = free.pop();
    ids[slot] = bot.id;
    radius[slot] = bot.capsule?.radius ?? 0;
    writeIdx[slot] = 0;
    count[slot] = 0;          // a recycled slot starts empty: no ghost history from the last occupant
    stats.slotsInUse++;
    bot.forensicSlot = slot;
    return slot;
  }

  // Called once per stepBotPhysics call, from inside it — the only place preY, the integrated velY,
  // the raw grounded verdict and the already-computed ground reference all exist at once.
  function sample(bot, dt, preY, velY, groundY, flags) {
    let slot = bot.forensicSlot;
    if (slot === -1) return;                        // dropped at the slot cap
    // Lazy assign on the first sample, so recording covers a bot's FIRST fall, not just later ones.
    // The id compare is the stale-slot guard: a missed release can't make one bot write another's ring.
    if (slot == null || ids[slot] !== bot.id) {
      slot = assign(bot);
      if (slot < 0) return;
    }
    const cap = bot.capsule, vel = bot.velocity;
    const p = writeIdx[slot];
    const base = (slot * ring + p) * FORENSIC_STRIDE;
    i32[base + F_T] = nowMs;
    f32[base + F_DT_MS] = dt * 1000;
    f32[base + F_PRE_Y] = preY;
    f32[base + F_POST_Y] = cap.start.y;
    f32[base + F_VEL_Y] = velY;
    f32[base + F_GROUND_Y] = groundY;
    f32[base + F_X] = cap.start.x;
    f32[base + F_Z] = cap.start.z;
    f32[base + F_VEL_X] = vel.x;
    f32[base + F_VEL_Z] = vel.z;
    i32[base + F_STATE_KEY] = bot.forensicStateKey ?? -1;
    i32[base + F_FLAGS] = flags;
    writeIdx[slot] = (p + 1) & ringMask;
    if (count[slot] < ring) count[slot]++;
    stats.samples++;
    if (flags & FLAG_RESCUED) {
      lastRescue.id = bot.id;
      lastRescue.at = nowMs;
      lastRescue.total++;
      // First unexported rescue wins. Exporting re-arms, so a stuck bot costs one 48 KB memcpy
      // total until the pending take is collected, not one per frame.
      if (!snapshot.pending) freeze(slot, bot.id);
    }
  }

  function freeze(slot, id) {
    const from = slot * slotFloats;
    snapF32.set(f32.subarray(from, from + slotFloats));
    snapshot.pending = true;
    snapshot.id = id;
    snapshot.slot = slot;
    snapshot.radius = radius[slot];
    snapshot.takenAt = nowMs;
    snapshot.count = count[slot];
    snapshot.writeIdx = writeIdx[slot];
    stats.freezes++;
  }

  // Called from the host's per-actor teardown. A frozen take is a copy, so it survives the release
  // of the bot it came from — a bot that dies right after a fall still has its forensics.
  function release(bot) {
    const slot = bot?.forensicSlot;
    if (slot == null || slot < 0) return false;
    if (ids[slot] === bot.id) {                     // never double-free a slot already recycled
      ids[slot] = null;
      radius[slot] = 0;
      writeIdx[slot] = 0;
      count[slot] = 0;
      free.push(slot);
      stats.slotsInUse--;
    }
    bot.forensicSlot = null;
    return true;
  }

  function header(id, slot, radiusM, n, takenAt, live) {
    return [
      `# bot-viewer-v2 fall forensics · ${new Date().toISOString()} · bot ${id} · slot ${slot}`
      + ` · radius ${radiusM.toFixed(3)} m · ${n} samples · ${live ? 'live ring' : `frozen at t=${takenAt} ms`}`,
      `# One row per stepBotPhysics call, oldest first. t_ms is the host frame clock (Int32 ms).`,
      `# gap = ground_y + radius - post_y — exactly what the rescue thresholds against`
      + ` (FLOOR_RESCUE_DEPTH = 0.75 m); a gap above that is the frame the rescue fired.`,
      `# ext_dy = pre_y[n] - post_y[n-1]. Nonzero means something OUTSIDE stepBotPhysics moved the`
      + ` capsule between frames (pair-pushout re-resolve, stance capsule scaling, a teleport)`
      + ` rather than the integrator stepping through the sheet in one frame. Blank on the first row.`,
      `# ground_y blank = no ground reference ran, or the height field returned NaN (has_ground_ref`
      + ` tells the two apart). state_key is the packed 9-slot FSM code (bot-state-code.js); -1 only`
      + ` before this bot's first commitBotActor call this session (dummies never get one).`,
    ];
  }

  function tsv(vf32, vi32, base0, n, wIdx, radiusM, lines) {
    const out = lines;
    out.push(COLUMNS.join('\t'));
    const start = n < ring ? 0 : wIdx;              // oldest sample: 0 until the ring has wrapped
    let prevPostY = NaN;
    for (let k = 0; k < n; k++) {
      const b = base0 + ((start + k) & ringMask) * FORENSIC_STRIDE;
      const preY = vf32[b + F_PRE_Y], postY = vf32[b + F_POST_Y], groundY = vf32[b + F_GROUND_Y];
      const velX = vf32[b + F_VEL_X], velZ = vf32[b + F_VEL_Z];
      const flags = vi32[b + F_FLAGS];
      out.push([
        vi32[b + F_T], num(vf32[b + F_DT_MS], 3), num(preY, 4), num(postY, 4),
        num(k === 0 ? NaN : preY - prevPostY, 4), num(vf32[b + F_VEL_Y], 3),
        num(groundY, 4), num(groundY + radiusM - postY, 4),
        num(vf32[b + F_X], 3), num(vf32[b + F_Z], 3), num(velX, 3), num(velZ, 3),
        num(Math.sqrt(velX * velX + velZ * velZ), 3),
        vi32[b + F_STATE_KEY], flags,
        (flags & FLAG_ON_FLOOR_IN) ? 1 : 0, (flags & FLAG_GROUNDED_RAW) ? 1 : 0,
        (flags & FLAG_ON_FLOOR_OUT) ? 1 : 0, (flags & FLAG_RESCUED) ? 1 : 0,
        (flags & FLAG_HAS_COLLIDER) ? 1 : 0, (flags & FLAG_HAS_GROUND_REF) ? 1 : 0,
      ].join('\t'));
      prevPostY = postY;
    }
    return out.join('\n');
  }

  // The frozen take, if one is pending. Exporting re-arms the freeze for the next rescue.
  function exportSnapshot() {
    if (!snapshot.pending) return null;
    const text = tsv(snapF32, snapI32, 0, snapshot.count, snapshot.writeIdx, snapshot.radius,
      header(snapshot.id, snapshot.slot, snapshot.radius, snapshot.count, snapshot.takenAt, false));
    snapshot.pending = false;
    return text;
  }

  function exportLive(bot) {
    const slot = bot?.forensicSlot;
    if (slot == null || slot < 0 || ids[slot] !== bot.id || !count[slot]) return null;
    return tsv(f32, i32, slot * slotFloats, count[slot], writeIdx[slot], radius[slot],
      header(bot.id, slot, radius[slot], count[slot], nowMs, true));
  }

  function exportLiveById(id) {
    if (!id) return null;                           // else indexOf(null) would match a free slot
    const slot = ids.indexOf(id);
    if (slot < 0 || !count[slot]) return null;
    return tsv(f32, i32, slot * slotFloats, count[slot], writeIdx[slot], radius[slot],
      header(id, slot, radius[slot], count[slot], nowMs, true));
  }

  function pendingId() { return snapshot.pending ? snapshot.id : null; }

  return {
    ring, maxSlots, stride: FORENSIC_STRIDE,
    buffer, f32, i32, ids, radius, writeIdx, count, free,
    snapshot, lastRescue, stats,
    setNow, sample, release, exportSnapshot, exportLive, exportLiveById, pendingId,
  };
}
