// Checking the two things the whole tuning apparatus takes on faith.
//
// Everything measured about these gaits — stride envelopes, drag fractions, the search, the plots — is
// computed from two assumptions that nothing has ever tested:
//
//   1. THE MAPPER PICKED THE RIGHT BONES. `mapStadiumRig` guesses which of forty-odd unnamed `boneNN`
//      nodes are legs, which joint is the knee, and which end is the foot. If it is wrong, the leg span
//      is wrong, so the Froude scaling is wrong, so the step duration and top speed are wrong, and every
//      normalised metric is a fraction of the wrong denominator. The gait would still be tunable; it just
//      would not be a gait for this animal.
//
//   2. THE CLIP PLAYING ON THE SPINE IS COMPATIBLE WITH WALKING. It is not a cosmetic layer. The walker
//      writes leg bones after the mixer, so whatever the clip does to the spine is carried into the hips
//      the legs hang off — the clip is an INPUT to the gait. The viewer strips tracks that target leg
//      bones, but not tracks that target the bone a leg is attached to, and on Rattata the last spine
//      bone IS the attach for the front legs.
//
// Neither is checkable by looking at the screen, and the absence of a mapper warning is not evidence:
// across all fourteen shipped models the mapper emits no warnings at all.
//
// Pure — takes parsed glTF and a rig map, returns findings. No THREE, no DOM.

const V = (x = 0, y = 0, z = 0) => ({ x, y, z });

/** Parent index per node, from the children lists glTF stores instead. */
export function parentMap(json) {
  const parent = new Array((json.nodes || []).length).fill(-1);
  (json.nodes || []).forEach((n, i) => { for (const c of n.children || []) parent[c] = i; });
  return parent;
}

/** Every ancestor of `node`, nearest first. */
export function ancestorsOf(node, parent) {
  const out = [];
  for (let p = parent[node]; p >= 0; p = parent[p]) {
    out.push(p);
    if (out.length > 64) break;   // a cycle in the hierarchy would otherwise hang the audit
  }
  return out;
}

// ===================== small matrix helpers =====================
// Written out rather than pulled from THREE so this module stays free of it and can be tested in Node.

function trsMatrix(node) {
  if (node.matrix) return node.matrix.slice();
  const t = node.translation || [0, 0, 0];
  const r = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
  return composeTRS(t, r, s);
}

export function composeTRS(t, r, s) {
  const [x, y, z, w] = r;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  // Column-major, as glTF stores it.
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    t[0], t[1], t[2], 1,
  ];
}

export function multiply(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

const translationOf = (m) => V(m[12], m[13], m[14]);

/** World transform of `node`, given per-node local matrices. */
export function worldOf(node, parent, locals) {
  let m = locals[node];
  for (let p = parent[node]; p >= 0; p = parent[p]) m = multiply(locals[p], m);
  return m;
}

// ===================== animation =====================

/** Sampler output at time `t`, LINEAR or STEP; quaternions are normalised after lerping. */
function sampleTrack(times, values, stride, t, interpolation) {
  const n = times.length;
  if (!n) return null;
  if (t <= times[0]) return values.slice(0, stride);
  if (t >= times[n - 1]) return values.slice((n - 1) * stride, n * stride);
  let i = 1;
  while (i < n && times[i] < t) i++;
  const t0 = times[i - 1], t1 = times[i];
  const a = values.slice((i - 1) * stride, i * stride);
  const b = values.slice(i * stride, (i + 1) * stride);
  if (interpolation === 'STEP') return a;
  const f = (t - t0) / Math.max(1e-9, t1 - t0);
  const out = a.map((v, k) => v + (b[k] - v) * f);
  if (stride === 4) {
    // Not slerp. For the amplitudes this audit reports, the difference between lerp and slerp is far
    // below the threshold at which a clip is called disruptive, and saying so is cheaper than pretending.
    const len = Math.hypot(...out) || 1;
    for (let k = 0; k < 4; k++) out[k] /= len;
  }
  return out;
}

/**
 * Which nodes each clip touches, and over what time span.
 *
 * `readAccessor(json, bin, index)` is injected so this module does not depend on the GLB reader.
 */
export function clipChannels(json, bin, readAccessor) {
  return (json.animations || []).map((anim, index) => {
    const tracks = [];
    let duration = 0;
    for (const ch of anim.channels || []) {
      const node = ch.target?.node;
      const path = ch.target?.path;
      if (node === undefined || !path || path === 'weights') continue;
      const sampler = anim.samplers[ch.sampler];
      const times = Array.from(readAccessor(json, bin, sampler.input));
      const values = Array.from(readAccessor(json, bin, sampler.output));
      const stride = path === 'rotation' ? 4 : 3;
      duration = Math.max(duration, times[times.length - 1] || 0);
      tracks.push({ node, path, times, values, stride, interpolation: sampler.interpolation || 'LINEAR' });
    }
    return { index, name: anim.name || `clip${index}`, duration, tracks, nodes: new Set(tracks.map(t => t.node)) };
  });
}

/**
 * One frame of a clip, as partial local TRS keyed by node id: `{ 12: { q: [...] }, ... }`.
 *
 * Steps to the nearest key at or before `time` rather than interpolating, because the caller is picking a
 * pose to start from and an authored key is a pose somebody drew. Only the paths a track actually targets
 * are filled in, so a caller must fall back to the node's own rest for the rest.
 */
export function sampleClipAt(clip, time) {
  const out = {};
  const KEY = { rotation: 'q', translation: 'p', scale: 's' };
  for (const track of clip?.tracks || []) {
    const { times, values, stride, node, path } = track;
    const key = KEY[path];
    if (!key || !times?.length || !values?.length) continue;
    let k = 0;
    while (k < times.length - 1 && times[k + 1] <= time) k++;
    const v = Array.from(values).slice(k * stride, k * stride + stride);
    if (v.length !== stride) continue;
    (out[node] ??= {})[key] = v;
  }
  return out;
}

/**
 * How far a clip moves the points the legs hang off.
 *
 * THE NUMBER THIS WHOLE FILE EXISTS FOR. Reported in leg spans, because a hip that wanders a tenth of a
 * leg while the creature is supposedly standing still is a disturbance the gait has to absorb, and one
 * that wanders a thousandth is not — and "millimetres" cannot tell those apart across models four times
 * different in size.
 *
 * `strip` is the set of node indices whose tracks the viewer removes before playing (the leg bones), so
 * the audit measures what actually reaches the rig rather than what the file contains.
 */
export function clipDisturbance(json, map, clip, { samples = 48, strip = new Set() } = {}) {
  const parent = parentMap(json);
  const nodes = json.nodes || [];
  const rest = nodes.map(trsMatrix);
  const byNode = new Map();
  for (const tr of clip.tracks) {
    if (strip.has(tr.node)) continue;
    if (!byNode.has(tr.node)) byNode.set(tr.node, []);
    byNode.get(tr.node).push(tr);
  }

  const attaches = [...new Set(map.legs.map(l => l.attach))];
  const spans = map.legs.map(l => l.span);
  const span = Math.max(...spans, 1e-6);
  const track = attaches.map(node => ({ node, min: V(Infinity, Infinity, Infinity), max: V(-Infinity, -Infinity, -Infinity) }));

  const dt = clip.duration > 0 ? clip.duration / (samples - 1) : 0;
  for (let s = 0; s < samples; s++) {
    const t = s * dt;
    const locals = rest.slice();
    for (const [node, tracks] of byNode) {
      const n = nodes[node];
      let T = n.translation || [0, 0, 0], R = n.rotation || [0, 0, 0, 1], S = n.scale || [1, 1, 1];
      for (const tr of tracks) {
        const v = sampleTrack(tr.times, tr.values, tr.stride, t, tr.interpolation);
        if (!v) continue;
        if (tr.path === 'translation') T = v;
        else if (tr.path === 'rotation') R = v;
        else if (tr.path === 'scale') S = v;
      }
      locals[node] = composeTRS(T, R, S);
    }
    for (const a of track) {
      const p = translationOf(worldOf(a.node, parent, locals));
      a.min.x = Math.min(a.min.x, p.x); a.max.x = Math.max(a.max.x, p.x);
      a.min.y = Math.min(a.min.y, p.y); a.max.y = Math.max(a.max.y, p.y);
      a.min.z = Math.min(a.min.z, p.z); a.max.z = Math.max(a.max.z, p.z);
    }
  }

  const perAttach = track.map(a => ({
    node: a.node,
    // Reported per axis as well as combined: a clip that only bobs vertically is a different problem from
    // one that swings the hips fore and aft, and the second is far worse for a foot scan.
    dx: (a.max.x - a.min.x) / span,
    dy: (a.max.y - a.min.y) / span,
    dz: (a.max.z - a.min.z) / span,
  }));
  const worst = perAttach.reduce((m, a) => Math.max(m, Math.hypot(a.dx, a.dy, a.dz)), 0);
  return { clip: clip.name, duration: clip.duration, worst, perAttach, touchesAttach: attaches.some(n => clip.nodes.has(n)) };
}

/**
 * Geometric sanity of the mapping, from the rest pose alone.
 *
 * Every check is something a correct mapping must satisfy and a wrong one usually will not. None of them
 * proves the mapping right — a leg mapped one joint short still puts a "foot" near the floor — but each
 * failure is a concrete thing to go and look at, which is more than the current zero warnings offer.
 */
export function auditMapping(map, json) {
  const findings = [];
  const legs = map.legs;
  const floorY = map.units?.floorY ?? 0;
  const height = map.units?.height || 1;
  const say = (level, code, text) => findings.push({ level, code, text });

  if (!legs.length) { say('error', 'no-legs', 'the mapper found no legs at all'); return { findings, legs: [] }; }

  // 1. Feet belong on the floor. A "foot" well above it is usually a chain that stopped one joint short.
  for (const l of legs) {
    const above = (l.foot.y - floorY) / height;
    if (above > 0.12) say('error', 'foot-high',
      `${l.name || `${l.row}${l.side < 0 ? 'L' : 'R'}`} foot sits ${(above * 100).toFixed(0)}% of body height above the floor`);
  }

  // 2. Left and right of a row should be near mirror images. A pair whose spans differ a lot is usually
  //    two different chains that were paired by position rather than by structure.
  const rows = new Map();
  for (const l of legs) {
    const r = rows.get(l.row) || {};
    r[l.side < 0 ? 'L' : 'R'] = l;
    rows.set(l.row, r);
  }
  for (const [row, pair] of rows) {
    if (!pair.L || !pair.R) { say('warn', 'unpaired', `row ${row} has only one side`); continue; }
    const rel = Math.abs(pair.L.span - pair.R.span) / Math.max(pair.L.span, pair.R.span);
    if (rel > 0.12) say('error', 'asymmetric-span',
      `row ${row} spans differ by ${(rel * 100).toFixed(0)}% (${pair.L.span.toFixed(2)} vs ${pair.R.span.toFixed(2)})`);
    const dy = Math.abs(pair.L.hip.y - pair.R.hip.y) / height;
    if (dy > 0.06) say('warn', 'asymmetric-hip', `row ${row} hips differ ${(dy * 100).toFixed(0)}% of body height in Y`);
  }

  // 3. A knee that splits the chain into a sliver and a stick has probably been put in the wrong place —
  //    and `l1`/`l2` are exactly what the two-bone solver's annulus is built from.
  for (const l of legs) {
    const ratio = Math.max(l.l1, l.l2) / Math.max(1e-9, Math.min(l.l1, l.l2));
    if (ratio > 4) say('warn', 'lopsided-knee',
      `${l.name || l.row} has segments ${l.l1.toFixed(2)} and ${l.l2.toFixed(2)} — a ${ratio.toFixed(1)}:1 split`);
  }

  // 3b. TWO LEGS THAT ARE ONE LIMB. Found by eye on Sandslash, whose four "legs" share the first three
  //     bones in pairs — the mapper walked one forelimb out to two different claws and called them two
  //     legs. Nothing else here catches it: both chains reach the floor, both are the right length, and
  //     the left/right spans match beautifully, because they are the same limb.
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const shared = legs[i].bones.filter(b => legs[j].bones.includes(b));
      if (!shared.length) continue;
      const frac = shared.length / Math.min(legs[i].bones.length, legs[j].bones.length);
      say(frac > 0.5 ? 'error' : 'warn', 'shared-bones',
        `${legs[i].name || legs[i].row} and ${legs[j].name || legs[j].row} share ${shared.length} bone(s)`
        + ` — ${(frac * 100).toFixed(0)}% of the shorter chain, so they are probably one limb with two toes`);
    }
  }

  // 3c. A pair whose chains are different lengths. Pikachu's left leg is six bones and its right is four,
  //     which means one of them ran on into something that is not a leg. The spans still matched, so the
  //     symmetry check above passed it.
  for (const [row, pair] of rows) {
    if (!pair.L || !pair.R) continue;
    if (pair.L.bones.length !== pair.R.bones.length) {
      say('error', 'asymmetric-chain',
        `row ${row} has ${pair.L.bones.length} bones on the left and ${pair.R.bones.length} on the right`);
    }
  }

  // 4. Bones near the floor that no leg claimed. On a model with 67 bones and 10 in legs, a missed limb
  //    is entirely possible and nothing else would report it.
  const claimed = new Set(legs.flatMap(l => [...l.bones, l.attach, l.tipMarker]).filter(b => b !== undefined));
  const rest = map.restWorld || {};
  const lowUnclaimed = [];
  for (const [idxStr, m] of Object.entries(rest)) {
    const idx = Number(idxStr);
    if (claimed.has(idx)) continue;
    if (map.spine?.includes(idx) || map.tail?.bones?.includes(idx) || map.head?.bones?.includes(idx)) continue;
    const y = Array.isArray(m) ? m[13] : m?.[13];
    if (y === undefined) continue;
    if ((y - floorY) / height < 0.12) lowUnclaimed.push(map.names[idx] ?? idx);
  }
  if (lowUnclaimed.length) say('warn', 'unclaimed-low',
    `${lowUnclaimed.length} bone(s) near the floor are in no leg: ${lowUnclaimed.slice(0, 8).join(', ')}`);

  // 5. A leg longer than the animal is tall, or shorter than a tenth of it, is a chain that ran away.
  for (const l of legs) {
    const rel = l.span / height;
    if (rel > 1.1) say('error', 'span-huge', `${l.name || l.row} spans ${(rel * 100).toFixed(0)}% of body height`);
    if (rel < 0.08) say('warn', 'span-tiny', `${l.name || l.row} spans only ${(rel * 100).toFixed(0)}% of body height`);
  }

  return {
    findings,
    legs: legs.map(l => ({
      name: l.name || `${l.row}${l.side < 0 ? 'L' : 'R'}`,
      bones: l.bones.map(b => map.names[b] ?? b),
      attach: map.names[l.attach] ?? l.attach,
      span: l.span, l1: l.l1, l2: l.l2,
      footAbove: (l.foot.y - floorY) / height,
    })),
    errors: findings.filter(f => f.level === 'error').length,
    warnings: findings.filter(f => f.level === 'warn').length,
  };
}

/**
 * Rank a model's clips by how little they disturb the legs.
 *
 * "Best" here means least disruptive to the gait, which is not the same as best-looking and is the only
 * sense the walker can act on. A clip that never touches a leg attach at all is ideal; one that swings
 * the hips half a leg is unusable underneath a walk however good it looks standing still.
 */
export function rankClips(disturbances) {
  return [...disturbances].sort((a, b) => a.worst - b.worst);
}
