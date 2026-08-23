// Stances: the neutral pose a species rests in, as a sparse per-bone TRS diff against the glTF's own
// rest. An input to mapStadiumRig, not a display setting. Pure. See docs/subsystems/stadium.md.

import { matIdentity, matMultiply, nodeLocalMatrix, nodeWorldMatrices, readSkinnedVertices } from './stadium-glb.js';

export const STANCE_VERSION = 1;

/** Mirror across the midline; these files are authored symmetric about x=0. */
const MIRROR = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

// ===================== matrix helpers =====================

/** Inverse of an affine 4x4, column-major, allowing non-uniform scale. */
export function invertAffine(m) {
  const a = m[0], b = m[4], c = m[8];
  const d = m[1], e = m[5], f = m[9];
  const g = m[2], h = m[6], i = m[10];
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!det) throw new Error('matrix is singular');
  const s = 1 / det;
  const n = [
    A * s, B * s, C * s, 0,
    (c * h - b * i) * s, (a * i - c * g) * s, (b * g - a * h) * s, 0,
    (b * f - c * e) * s, (c * d - a * f) * s, (a * e - b * d) * s, 0,
    0, 0, 0, 1,
  ];
  const [tx, ty, tz] = [m[12], m[13], m[14]];
  n[12] = -(n[0] * tx + n[4] * ty + n[8] * tz);
  n[13] = -(n[1] * tx + n[5] * ty + n[9] * tz);
  n[14] = -(n[2] * tx + n[6] * ty + n[10] * tz);
  return n;
}

/** Affine 4x4 back to TRS. A negative determinant folds into x scale so a double mirror round-trips. */
export function decomposeTRS(m) {
  const col = (k) => [m[k * 4], m[k * 4 + 1], m[k * 4 + 2]];
  const len = (v) => Math.hypot(v[0], v[1], v[2]);
  const x = col(0), y = col(1), z = col(2);
  let sx = len(x), sy = len(y), sz = len(z);
  const det =
    x[0] * (y[1] * z[2] - y[2] * z[1]) -
    y[0] * (x[1] * z[2] - x[2] * z[1]) +
    z[0] * (x[1] * y[2] - x[2] * y[1]);
  if (det < 0) sx = -sx;
  const r = [
    x[0] / sx, x[1] / sx, x[2] / sx,
    y[0] / sy, y[1] / sy, y[2] / sy,
    z[0] / sz, z[1] / sz, z[2] / sz,
  ];
  const [r00, r10, r20, r01, r11, r21, r02, r12, r22] = r;
  const trace = r00 + r11 + r22;
  let q;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(r21 - r12) / s, (r02 - r20) / s, (r10 - r01) / s, s / 4];
  } else if (r00 > r11 && r00 > r22) {
    const s = Math.sqrt(1 + r00 - r11 - r22) * 2;
    q = [s / 4, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s];
  } else if (r11 > r22) {
    const s = Math.sqrt(1 + r11 - r00 - r22) * 2;
    q = [(r01 + r10) / s, s / 4, (r12 + r21) / s, (r02 - r20) / s];
  } else {
    const s = Math.sqrt(1 + r22 - r00 - r11) * 2;
    q = [(r02 + r20) / s, (r12 + r21) / s, s / 4, (r10 - r01) / s];
  }
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return { p: [m[12], m[13], m[14]], q: [q[0] / n, q[1] / n, q[2] / n, q[3] / n], s: [sx, sy, sz] };
}

/** The 4x4 a `{p,q,s}` describes, built the way the glTF reader builds one. */
export function trsMatrix({ p = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1] } = {}) {
  return nodeLocalMatrix({ translation: p, rotation: q, scale: s });
}

// ===================== the stance document =====================

/** `roles` rides with the pose because leg detection runs on posed geometry and a pose can delete a leg. */
export function emptyStance(species = null) {
  return { version: STANCE_VERSION, species, bones: {}, roles: null, ground: true, note: '' };
}

export function copyStance(stance) {
  const bones = {};
  for (const [k, v] of Object.entries(stance.bones || {})) bones[k] = { p: [...v.p], q: [...v.q], s: [...v.s] };
  const roles = stance.roles ? JSON.parse(JSON.stringify(stance.roles)) : null;
  return { ...stance, bones, roles };
}

/** No pose. Says nothing about roles — see `isBlankStance` for "nothing authored at all". */
export const isEmptyStance = (stance) => !stance || !Object.keys(stance.bones || {}).length;

/** No pose and no pinned legs, so the library has no reason to keep the species. */
export const isBlankStance = (stance) =>
  isEmptyStance(stance) && !Object.keys(stance?.roles?.bones || {}).length;

export function setStanceRoles(stance, roles) {
  const next = copyStance(stance);
  next.roles = roles ? JSON.parse(JSON.stringify(roles)) : null;
  return next;
}

/** Overwrite one bone. Returns a new document; the caller decides when to save. */
export function setStanceBone(stance, name, trs) {
  const next = copyStance(stance);
  next.bones[name] = { p: [...(trs.p ?? [0, 0, 0])], q: [...(trs.q ?? [0, 0, 0, 1])], s: [...(trs.s ?? [1, 1, 1])] };
  return next;
}

export function clearStanceBone(stance, name) {
  const next = copyStance(stance);
  delete next.bones[name];
  return next;
}

/** Content hash, so a measurement can record which stance produced it. Deterministic, not a timestamp. */
export function stanceStamp(stance) {
  if (isBlankStance(stance)) return 'rest';
  const round = (n) => (Math.abs(n) < 5e-7 ? 0 : Number(n.toFixed(6)));
  const parts = [];
  for (const name of Object.keys(stance.bones || {}).sort()) {
    const b = stance.bones[name];
    parts.push(`${name}:${[...b.p, ...b.q, ...b.s].map(round).join(',')}`);
  }
  // Roles are in the stamp: reassigning legs changes the creature as much as posing it does.
  for (const bone of Object.keys(stance.roles?.bones || {}).sort()) {
    const r = stance.roles.bones[bone];
    parts.push(`r${bone}:${r.leg}/${r.role}`);
  }
  for (const key of Object.keys(stance.roles?.attach || {}).sort()) {
    parts.push(`a${key}:${stance.roles.attach[key]}`);
  }
  if (stance.ground === false) parts.push('!ground');
  let h = 0x811c9dc5;
  const text = parts.join(';');
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Bones the stance names that the model does not have — a stance carried to the wrong species. */
export function validateStance(stance, json) {
  const errors = [];
  const known = new Set((json.nodes || []).map(n => n.name).filter(Boolean));
  const unknown = Object.keys(stance?.bones || {}).filter(n => !known.has(n));
  if (unknown.length) errors.push(`${unknown.length} bone(s) not in this model: ${unknown.slice(0, 4).join(', ')}`);
  for (const [name, b] of Object.entries(stance?.bones || {})) {
    const nums = [...(b.p || []), ...(b.q || []), ...(b.s || [])];
    if (nums.length !== 10) errors.push(`${name}: expected 3+4+3 numbers, got ${nums.length}`);
    if (nums.some(n => !Number.isFinite(n))) errors.push(`${name}: non-finite value`);
  }
  return { ok: !errors.length, errors, unknown };
}

// ===================== applying it =====================

/** The glTF with the stance in its node transforms. New document; the caller keeps the authored rest. */
export function applyStance(json, stance) {
  const out = { ...json, nodes: (json.nodes || []).map(n => ({ ...n })) };
  if (isEmptyStance(stance)) return out;
  const index = new Map();
  out.nodes.forEach((n, i) => { if (n.name) index.set(n.name, i); });
  for (const [name, b] of Object.entries(stance.bones)) {
    const i = index.get(name);
    if (i === undefined) continue;
    const node = out.nodes[i];
    delete node.matrix;                                  // TRS wins; these files never carry one anyway
    node.translation = [...b.p];
    node.rotation = [...b.q];
    node.scale = [...b.s];
  }
  return out;
}

/** Drop the model back onto y=0 after a pose moved its lowest vertex; rideHeight is measured from it. */
export function groundJson(json, bin) {
  const verts = readSkinnedVertices(json, bin, nodeWorldMatrices(json));
  let lowest = Infinity;
  for (let i = 0; i < verts.count; i++) lowest = Math.min(lowest, verts.position[i * 3 + 1]);
  if (!Number.isFinite(lowest) || Math.abs(lowest) < 1e-9) return json;
  const out = { ...json, nodes: json.nodes.map(n => ({ ...n })) };
  const parent = new Array(out.nodes.length).fill(-1);
  out.nodes.forEach((n, i) => { for (const c of n.children || []) parent[c] = i; });
  const roots = [];
  for (const s of out.scenes || []) for (const r of s.nodes || []) roots.push(r);
  if (!roots.length) out.nodes.forEach((_, i) => { if (parent[i] === -1) roots.push(i); });
  for (const r of roots) {
    const node = out.nodes[r];
    if (node.matrix) { node.matrix = node.matrix.slice(); node.matrix[13] -= lowest; continue; }
    const t = node.translation ? [...node.translation] : [0, 0, 0];
    t[1] -= lowest;
    node.translation = t;
  }
  return out;
}

/** What a walker is built from. An empty stance returns the input ungrounded, keeping old parity. */
export function stanceJson(json, bin, stance) {
  if (isEmptyStance(stance)) return json;
  const posed = applyStance(json, stance);
  return stance.ground === false ? posed : groundJson(posed, bin);
}

// ===================== mirroring =====================

/** Bone to its opposite number, paired from the HIP end; unequal-length legs simply run out. */
export function mirrorTargets(map) {
  const out = {};
  const byRow = new Map();
  for (const leg of map.legs || []) {
    if (!byRow.has(leg.row)) byRow.set(leg.row, []);
    byRow.get(leg.row).push(leg);
  }
  for (const legs of byRow.values()) {
    if (legs.length !== 2) continue;
    const [a, b] = legs;
    const n = Math.min(a.bones.length, b.bones.length);
    for (let i = 0; i < n; i++) {
      const na = map.names[a.bones[i]], nb = map.names[b.bones[i]];
      if (!na || !nb || na === nb) continue;
      out[na] = nb;
      out[nb] = na;
    }
  }
  return out;
}

/** Mirrors the delta from rest in world space; `ctx` must be the unedited json. */
export function mirrorLocal(json, ctx, srcNode, dstNode, srcLocal) {
  const parentWorld = (node) => {
    const p = ctx.parent[node];
    return p >= 0 ? ctx.world[p] : matIdentity();
  };
  const worldNew = matMultiply(parentWorld(srcNode), trsMatrix(srcLocal));
  const delta = matMultiply(worldNew, invertAffine(ctx.world[srcNode]));
  const mirrored = matMultiply(MIRROR, matMultiply(delta, MIRROR));
  const dstWorld = matMultiply(mirrored, ctx.world[dstNode]);
  return decomposeTRS(matMultiply(invertAffine(parentWorld(dstNode)), dstWorld));
}

/** Write the mirror of one edited bone onto its partner. A no-op when there is no partner. */
export function mirrorStanceBone(stance, { json, ctx, map, name }) {
  const partner = mirrorTargets(map)[name];
  if (!partner) return stance;
  const index = new Map();
  (json.nodes || []).forEach((n, i) => { if (n.name) index.set(n.name, i); });
  const src = index.get(name), dst = index.get(partner);
  if (src === undefined || dst === undefined) return stance;
  const local = stance.bones[name] ?? decomposeTRS(nodeLocalMatrix(json.nodes[src]));
  return setStanceBone(stance, partner, mirrorLocal(json, ctx, src, dst, local));
}

/** The bone's authored rest, which is what "reset this bone" writes back. */
export function restTRS(json, name) {
  const node = (json.nodes || []).find(n => n.name === name);
  if (!node) return null;
  return decomposeTRS(nodeLocalMatrix(node));
}

// ===================== the library =====================

/** One file for every species, since the walker is the only editor and everything else looks up a name. */
export const emptyLibrary = () => ({ version: STANCE_VERSION, stances: {} });

export function getStance(library, species) {
  const found = library?.stances?.[species];
  return found ? { ...emptyStance(species), ...found, species } : emptyStance(species);
}

export function putStance(library, stance) {
  const lib = { ...emptyLibrary(), ...library, stances: { ...(library?.stances || {}) } };
  if (isBlankStance(stance)) delete lib.stances[stance.species];
  else lib.stances[stance.species] = { ...copyStance(stance), stamp: stanceStamp(stance) };
  return lib;
}

/** Species with an authored stance, so a reader can say what it is obeying. */
export const stancedSpecies = (library) => Object.keys(library?.stances || {}).sort();
