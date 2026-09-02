// The annotation: what a person decided each part of a skeleton is. Pure, no THREE, no DOM.
//
// This is the truth of the whole project — nothing re-derives structure at load time. A suggestion from
// a mapper is a draft that becomes an annotation only when someone accepts it, which is what `author`
// records. Everything unannotated is decoration that inherits its parent, which is what makes the job
// finite: median 11 things to say per species, not 42.
//
// Every edit returns a NEW annotation rather than mutating, so undo is a stack of references.

export const ANNOTATION_VERSION = 1;

// `serpent` and `worm` are separate on purpose: Onix is a rigid segmented body that steers, Caterpie
// inches by travelling a wave down itself, and a v2 solver cannot treat those as one thing.
export const LOCOMOTION = ['walker', 'flyer', 'swimmer', 'hopper', 'serpent', 'worm', 'roller', 'floater', 'burrower', 'static'];
export const POSTURES = ['biped', 'quadruped', 'hexapod', 'octopod', 'other'];
export const APPENDAGE_TYPES = ['leg', 'wing', 'fin', 'arm', 'tail', 'tentacle', 'ear', 'antenna', 'other'];
export const SIDES = ['L', 'R', 'C'];
export const AUTHORS = ['hand', 'suggested', 'accepted'];

/** Classes whose creatures never touch the ground, so contacts and grounding are wrong for them. */
export const AIRBORNE = new Set(['flyer', 'floater', 'swimmer']);

// ===================== construction =====================

export function emptyAnnotation(species, rig = null) {
  return {
    version: ANNOTATION_VERSION,
    species,
    rigHash: rig?.hash ?? null,
    locomotion: null,
    posture: null,
    parts: { root: null, spine: [], head: [], appendages: [], contacts: [] },
    neutral: { bones: {}, ground: null, source: null },
    segments: {},
    done: false,
    notes: '',
  };
}

/** Key order matches `emptyAnnotation` so a copied annotation diffs cleanly against an authored one. */
export function copyAnnotation(a) {
  if (!a) return null;
  return {
    ...a,
    parts: {
      root: a.parts?.root ?? null,
      spine: [...(a.parts?.spine || [])],
      head: [...(a.parts?.head || [])],
      appendages: (a.parts?.appendages || []).map(ap => ({ ...ap, chain: [...(ap.chain || [])] })),
      contacts: [...(a.parts?.contacts || [])],
    },
    neutral: {
      // The TRS arrays are copied, not spread: sharing them makes an undo stack mutate its own history.
      bones: Object.fromEntries(Object.entries(a.neutral?.bones || {}).map(([k, v]) => [k, copyTRS(v)])),
      ground: a.neutral?.ground ?? null,
      source: a.neutral?.source ?? null,
    },
    segments: Object.fromEntries(Object.entries(a.segments || {}).map(([k, v]) => [k, { ...v }])),
  };
}

function copyTRS(t) {
  return { p: [...(t?.p || [0, 0, 0])], q: [...(t?.q || [0, 0, 0, 1])], s: [...(t?.s || [1, 1, 1])] };
}

/** Nothing has been said yet — used to decide whether a species is worth writing to the file at all. */
export function isBlank(a) {
  if (!a) return true;
  const p = a.parts || {};
  return !a.locomotion && !p.root && !p.spine?.length && !p.head?.length
    && !p.appendages?.length && !p.contacts?.length
    && !Object.keys(a.neutral?.bones || {}).length && !Object.keys(a.segments || {}).length
    && !a.done && !a.notes;
}

// ===================== bone ordering =====================

/** Depth from the root, so bones can be ordered without the caller knowing the hierarchy. */
export function depthOf(rig, key) {
  let d = 0, cur = rig.byKey.get(key)?.parent ?? null;
  while (cur) { d++; cur = rig.byKey.get(cur)?.parent ?? null; }
  return d;
}

/**
 * Put bones in root-to-tip order.
 *
 * The UI lets bones be picked in any order — that is the point of having a bone gesture at all — so the
 * chain order a limb needs is established here rather than being the user's problem.
 */
export function orderBones(rig, bones) {
  return [...new Set(bones)]
    .filter(b => rig.byKey.has(b))
    .sort((a, b) => depthOf(rig, a) - depthOf(rig, b) || (rig.byKey.get(a).node - rig.byKey.get(b).node));
}

// ===================== editing =====================

export function setLocomotion(a, locomotion, posture = null) {
  const next = copyAnnotation(a);
  next.locomotion = locomotion || null;
  // Posture only means something for a walker; carrying a stale one would misreport the body plan.
  next.posture = locomotion === 'walker' ? (posture ?? next.posture ?? null) : null;
  return next;
}

export function setRoot(a, bone) {
  const next = copyAnnotation(a);
  next.parts.root = bone || null;
  return next;
}

export function setSpine(a, rig, bones) {
  const next = copyAnnotation(a);
  next.parts.spine = orderBones(rig, bones || []);
  return next;
}

export function setHead(a, rig, bones) {
  const next = copyAnnotation(a);
  next.parts.head = orderBones(rig, bones || []);
  return next;
}

let idCounter = 0;
/** A stable id for a new appendage, unique within this annotation. */
export function nextAppendageId(a, type = 'part', side = '') {
  const used = new Set((a.parts?.appendages || []).map(ap => ap.id));
  const base = `${type}${side}`;
  if (!used.has(base)) return base;
  for (let i = 2; i < 1000; i++) if (!used.has(`${base}${i}`)) return `${base}${i}`;
  return `${base}_${++idCounter}`;
}

export function addAppendage(a, rig, spec = {}) {
  const next = copyAnnotation(a);
  const type = APPENDAGE_TYPES.includes(spec.type) ? spec.type : 'other';
  const side = SIDES.includes(spec.side) ? spec.side : 'C';
  next.parts.appendages.push({
    id: spec.id || nextAppendageId(next, type, side === 'C' ? '' : side),
    type, side,
    row: Number.isInteger(spec.row) ? spec.row : 0,
    chain: orderBones(rig, spec.chain || []),
    mirror: spec.mirror ?? null,
    author: AUTHORS.includes(spec.author) ? spec.author : 'hand',
  });
  return next;
}

export function updateAppendage(a, rig, id, patch = {}) {
  const next = copyAnnotation(a);
  const ap = next.parts.appendages.find(x => x.id === id);
  if (!ap) return next;
  if (patch.type !== undefined) ap.type = APPENDAGE_TYPES.includes(patch.type) ? patch.type : ap.type;
  if (patch.side !== undefined) ap.side = SIDES.includes(patch.side) ? patch.side : ap.side;
  if (patch.row !== undefined) ap.row = Number.isInteger(patch.row) ? patch.row : ap.row;
  if (patch.chain !== undefined) ap.chain = orderBones(rig, patch.chain);
  if (patch.author !== undefined && AUTHORS.includes(patch.author)) ap.author = patch.author;
  if (patch.mirror !== undefined) ap.mirror = patch.mirror || null;
  return next;
}

export function removeAppendage(a, id) {
  const next = copyAnnotation(a);
  next.parts.appendages = next.parts.appendages.filter(x => x.id !== id);
  // A mirror pointing at a part that no longer exists would fail validation on someone else's machine.
  for (const ap of next.parts.appendages) if (ap.mirror === id) ap.mirror = null;
  return next;
}

/**
 * Add or remove bones on one appendage — the single primitive behind both selection gestures.
 *
 * The bone gesture passes one key; the chain gesture passes a chain's worth. Because both land here and
 * the result is always an ordered bone list, there is no mode to be in and no chain reference to go
 * stale when a single bone is corrected afterwards.
 */
export function toggleBones(a, rig, id, bones, force = null) {
  const next = copyAnnotation(a);
  const ap = next.parts.appendages.find(x => x.id === id);
  if (!ap) return next;
  const list = Array.isArray(bones) ? bones : [bones];
  const have = new Set(ap.chain);
  const adding = force === null ? !list.every(b => have.has(b)) : force;
  for (const b of list) { if (adding) have.add(b); else have.delete(b); }
  ap.chain = orderBones(rig, [...have]);
  return next;
}

export function setContacts(a, rig, bones) {
  const next = copyAnnotation(a);
  next.parts.contacts = orderBones(rig, bones || []);
  return next;
}

export function toggleContact(a, rig, bones, force = null) {
  const list = Array.isArray(bones) ? bones : [bones];
  const have = new Set(a.parts?.contacts || []);
  const adding = force === null ? !list.every(b => have.has(b)) : force;
  for (const b of list) { if (adding) have.add(b); else have.delete(b); }
  return setContacts(a, rig, [...have]);
}

/** Declare two appendages a mirror pair. Reciprocal by construction, so validation cannot fail on it. */
export function declareMirror(a, idA, idB) {
  const next = copyAnnotation(a);
  const A = next.parts.appendages.find(x => x.id === idA);
  const B = idB ? next.parts.appendages.find(x => x.id === idB) : null;
  if (!A) return next;
  // Break whatever either side pointed at before, or the old partner keeps a one-way reference.
  for (const ap of next.parts.appendages) {
    if (ap.mirror === A.id || (B && ap.mirror === B.id)) ap.mirror = null;
  }
  A.mirror = B ? B.id : null;
  if (B) B.mirror = A.id;
  return next;
}

export function setNeutralBone(a, bone, trs) {
  const next = copyAnnotation(a);
  if (!trs) delete next.neutral.bones[bone];
  else next.neutral.bones[bone] = copyTRS(trs);
  return next;
}

export function clearNeutral(a) {
  const next = copyAnnotation(a);
  next.neutral = { bones: {}, ground: next.neutral.ground, source: null };
  return next;
}

/** Take a clip frame as the neutral pose, recording where it came from so it can be re-derived. */
export function neutralFromClip(a, rig, clipIndex, time, sampler) {
  const clip = rig.clips[clipIndex];
  if (!clip) return copyAnnotation(a);
  const frame = sampler(clip, time);
  const next = copyAnnotation(a);
  next.neutral.bones = {};
  for (const [bone, partial] of Object.entries(frame)) {
    const rest = rig.byKey.get(bone)?.rest;
    if (!rest) continue;
    next.neutral.bones[bone] = {
      p: [...(partial.p || rest.p)],
      q: [...(partial.q || rest.q)],
      s: [...(partial.s || rest.s)],
    };
  }
  next.neutral.source = `${clip.name}@${time.toFixed(3)}`;
  return next;
}

/** Grounding defaults by class: dropping a Gastly onto the floor would be actively wrong. */
export function defaultGrounding(locomotion) {
  return !AIRBORNE.has(locomotion);
}

export function setGrounding(a, ground) {
  const next = copyAnnotation(a);
  next.neutral.ground = ground === null ? null : !!ground;
  return next;
}

export function groundingOf(a) {
  return a?.neutral?.ground ?? defaultGrounding(a?.locomotion);
}

// ===================== segments =====================
//
// A segment is a named slice of a ROM clip. The Stadium animations are compound performances -- Squirtle's
// withdraw is eight frames of pulling in followed by forty-four sitting in the shell -- so the useful
// animation is often a range rather than a whole clip. Which frames mean what is a DECISION, the same kind
// as which bones are a leg, so it lives here rather than in a solver.
//
// `to: null` means the last frame, which keeps a whole-clip segment honest if the model is re-extracted at
// a different length. `from` greater than `to` plays backwards, which is what makes an exit the entrance
// reversed for free.

/** How a segment finishes. Two values, because only two things are being said: a state, or a transition. */
export const SEGMENT_ENDS = ['loop', 'hold'];

/** The whole of a clip under one name. */
export function wholeClip(clipIndex, ends = 'loop') {
  return { clip: clipIndex, from: 0, to: null, ends };
}

/** Fill in a segment's defaults without deciding anything: an absent `to` stays absent. */
export function normaliseSegment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const clip = Number(raw.clip);
  if (!Number.isInteger(clip) || clip < 0) return null;
  const frame = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : null);
  return {
    clip,
    from: frame(raw.from) ?? 0,
    to: raw.to === null || raw.to === undefined ? null : frame(raw.to),
    ends: SEGMENT_ENDS.includes(raw.ends) ? raw.ends : 'loop',
  };
}

export function setSegment(a, name, segment) {
  const next = copyAnnotation(a);
  const key = String(name || '').trim();
  if (!key) return next;
  const seg = normaliseSegment(segment);
  if (!seg) delete next.segments[key];
  else next.segments[key] = seg;
  return next;
}

export function removeSegment(a, name) {
  const next = copyAnnotation(a);
  delete next.segments[String(name || '').trim()];
  return next;
}

export function renameSegment(a, from, to) {
  const next = copyAnnotation(a);
  const oldKey = String(from || '').trim();
  const newKey = String(to || '').trim();
  if (!newKey || !next.segments[oldKey] || oldKey === newKey) return next;
  next.segments[newKey] = next.segments[oldKey];
  delete next.segments[oldKey];
  return next;
}

/** Named segments in a stable order, so two readers of the same file agree on what they see. */
export function segmentsOf(a) {
  return Object.entries(a?.segments || {}).sort(([x], [y]) => x.localeCompare(y));
}

// ===================== states =====================
//
// A state is a segment a creature can stay in; a transition is one that leaves it somewhere else. Nothing
// records this, because the range already says it: a range that loops sustains, a single frame held is a
// pose, and anything else runs out and stops somewhere new. Deriving it means a segment cannot disagree
// with its own label.
//
// State NAMES are the part that is a decision. A runtime asks 151 different skeletons for `idle` and has to
// get the same idea back, so the vocabulary below is offered as suggestions everywhere a name is typed.
// It does not restrict anything: `in_shell` belongs to Squirtle and to no list.

export const COMMON_STATES = [
  'idle', 'walk', 'run', 'crouch', 'sleep', 'hurt', 'fainted', 'airborne', 'guard', 'attack',
];

/**
 * Whether a segment sustains or leads somewhere. Read from the range, never stored.
 *
 * Exact on a `resolveSegment` result. On raw data an open `to: null` cannot be compared against `from`,
 * so a held whole-clip reads as a transition, which is what it almost always is.
 */
export function segmentKind(segment) {
  const seg = normaliseSegment(segment);
  if (!seg) return null;
  if (seg.ends === 'loop') return 'state';
  return seg.to !== null && seg.from === seg.to ? 'state' : 'transition';
}

export function statesOf(a) {
  return segmentsOf(a).filter(([, seg]) => segmentKind(seg) === 'state');
}

export function transitionsOf(a) {
  return segmentsOf(a).filter(([, seg]) => segmentKind(seg) === 'transition');
}

/** A single frame, held: the smallest thing that counts as a state. */
export function poseAt(clipIndex, frame) {
  const f = Math.max(0, Math.round(Number(frame) || 0));
  return { clip: clipIndex, from: f, to: f, ends: 'hold' };
}

/**
 * A segment with its bounds made concrete against a clip's real length.
 *
 * `frames` is the clip's frame count, which `pokemon-rig.js` measures rather than assuming. Bounds are
 * clamped rather than rejected, so a segment authored against a longer version of a clip still plays.
 */
export function resolveSegment(segment, frames) {
  const seg = normaliseSegment(segment);
  if (!seg) return null;
  const last = Math.max(0, (Number(frames) || 1) - 1);
  const clamp = (v) => Math.min(last, Math.max(0, v));
  const from = clamp(seg.from);
  const to = clamp(seg.to === null ? last : seg.to);
  return {
    clip: seg.clip, from, to, ends: seg.ends,
    reversed: from > to,
    length: Math.abs(to - from) + 1,
    truncated: seg.from > last || (seg.to !== null && seg.to > last),
  };
}

export function setDone(a, done, notes = undefined) {
  const next = copyAnnotation(a);
  next.done = !!done;
  if (notes !== undefined) next.notes = String(notes);
  return next;
}

// ===================== reading =====================

/** Every bone the annotation names, whatever part it is in. */
export function claimedBones(a) {
  const out = new Set();
  const p = a?.parts || {};
  if (p.root) out.add(p.root);
  for (const b of p.spine || []) out.add(b);
  for (const b of p.head || []) out.add(b);
  for (const b of p.contacts || []) out.add(b);
  for (const ap of p.appendages || []) for (const b of ap.chain || []) out.add(b);
  return out;
}

/**
 * Bones nothing has been said about.
 *
 * Not a to-do list: an unaddressed bone is decoration by default and that is a complete answer. The list
 * exists so a person can see what they are defaulting, and it is weighted by geometry so a spike and a
 * missed limb do not look the same.
 */
export function unaddressed(a, rig, { minMassFraction = 0 } = {}) {
  const claimed = claimedBones(a);
  const total = rig.units.totalVertices || 1;
  return rig.bones
    .filter(b => !claimed.has(b.key))
    .map(b => ({ key: b.key, mass: (rig.geometry.get(b.key)?.count ?? 0) / total }))
    .filter(b => b.mass >= minMassFraction)
    .sort((x, y) => y.mass - x.mass);
}

/**
 * Which contacts belong to a given appendage — derived, so a contact is never stored twice.
 *
 * With a rig, a marked contact may sit below the authored limb chain. This is the normal case for a
 * branching foot: the leg names the driven joints and Mark feet names the sole/toe bones separately.
 * Without a rig this preserves the older exact-membership query used by lightweight callers.
 */
export function contactsOf(a, appendageId, rig = null) {
  const ap = (a?.parts?.appendages || []).find(x => x.id === appendageId);
  if (!ap) return [];
  const chain = new Set(ap.chain || []);
  return (a?.parts?.contacts || []).filter(contact => {
    let bone = contact;
    while (bone) {
      if (chain.has(bone)) return true;
      if (!rig) return false;
      bone = rig.byKey.get(bone)?.parent ?? null;
    }
    return false;
  });
}

/** Contacts belonging to no appendage — a Caterpie's belly, a Voltorb's underside. */
export function bodyContacts(a, rig = null) {
  const limbContacts = new Set((a?.parts?.appendages || [])
    .flatMap(ap => contactsOf(a, ap.id, rig)));
  return (a?.parts?.contacts || []).filter(b => !limbContacts.has(b));
}

export function appendagesOfType(a, type) {
  return (a?.parts?.appendages || []).filter(ap => ap.type === type);
}

// ===================== validation =====================

/**
 * Structural integrity of the annotation against its rig. Class rules live in `pokemon-gates.js`.
 *
 * Never throws and never repairs: it reports, and the caller decides. A findings list that a person can
 * act on beats a silent correction that moves their work.
 */
export function validateAnnotation(a, rig) {
  const findings = [];
  const say = (level, code, text) => findings.push({ level, code, text });
  if (!a) { say('error', 'missing', 'no annotation'); return { findings, errors: 1, warnings: 0 }; }

  if (a.rigHash && rig?.hash && a.rigHash !== rig.hash) {
    say('error', 'stale-rig', `annotated against a different version of this model (${a.rigHash} vs ${rig.hash}) — the bones may have moved`);
  }
  if (a.locomotion && !LOCOMOTION.includes(a.locomotion)) say('error', 'bad-class', `unknown locomotion class "${a.locomotion}"`);
  if (a.posture && !POSTURES.includes(a.posture)) say('error', 'bad-posture', `unknown posture "${a.posture}"`);
  if (a.posture && a.locomotion !== 'walker') say('warn', 'posture-ignored', `posture "${a.posture}" is only read for a walker`);

  const known = (b) => rig?.byKey?.has(b);
  const checkList = (bones, where) => {
    for (const b of bones || []) if (!known(b)) say('error', 'unknown-bone', `${where} names "${b}", which is not a bone of this model`);
  };

  const p = a.parts || {};
  if (p.root && !known(p.root)) say('error', 'unknown-bone', `root names "${p.root}", which is not a bone of this model`);
  checkList(p.spine, 'spine');
  checkList(p.head, 'head');
  checkList(p.contacts, 'contacts');

  const seen = new Map();
  for (const ap of p.appendages || []) {
    checkList(ap.chain, `appendage ${ap.id}`);
    if (!APPENDAGE_TYPES.includes(ap.type)) say('error', 'bad-type', `appendage ${ap.id} has unknown type "${ap.type}"`);
    if (!SIDES.includes(ap.side)) say('error', 'bad-side', `appendage ${ap.id} has unknown side "${ap.side}"`);
    if (!ap.chain?.length) say('warn', 'empty-part', `appendage ${ap.id} has no bones`);
    if (rig && ap.chain?.length && !isChain(rig, ap.chain)) {
      say('error', 'broken-chain', `appendage ${ap.id} is not one unbroken run of bones — a limb cannot skip a joint`);
    }
    for (const b of ap.chain || []) {
      if (seen.has(b)) say('error', 'double-claim', `${b} is in both ${seen.get(b)} and ${ap.id}`);
      else seen.set(b, ap.id);
    }
  }

  const ids = (p.appendages || []).map(ap => ap.id);
  if (new Set(ids).size !== ids.length) say('error', 'duplicate-id', 'two appendages share an id');
  for (const ap of p.appendages || []) {
    if (!ap.mirror) continue;
    const other = (p.appendages || []).find(x => x.id === ap.mirror);
    if (!other) say('error', 'dangling-mirror', `${ap.id} mirrors "${ap.mirror}", which does not exist`);
    else if (other.mirror !== ap.id) say('error', 'one-way-mirror', `${ap.id} mirrors ${other.id} but ${other.id} does not mirror it back`);
    else if (other.side === ap.side) say('warn', 'same-side-mirror', `${ap.id} and ${other.id} are a mirror pair but both say side ${ap.side}`);
  }

  for (const b of Object.keys(a.neutral?.bones || {})) {
    if (!known(b)) say('error', 'unknown-bone', `the neutral pose moves "${b}", which is not a bone of this model`);
  }
  for (const [name, raw] of Object.entries(a.segments || {})) {
    const seg = normaliseSegment(raw);
    if (!seg) { say('error', 'bad-segment', `segment "${name}" is not a clip and a frame range`); continue; }
    const clip = rig?.clips?.[seg.clip];
    if (!clip) { say('error', 'bad-clip', `segment "${name}" points at clip ${seg.clip}, which this model does not have`); continue; }
    const last = Math.max(0, (clip.frames || 1) - 1);
    if (seg.from > last || (seg.to !== null && seg.to > last)) {
      say('error', 'bad-segment', `segment "${name}" names frames past the end of ${clip.name}, which is ${clip.frames} frames long`);
    }
    if (seg.to !== null && seg.to === seg.from && seg.ends === 'loop') {
      say('warn', 'bad-segment', `segment "${name}" is a single frame set to loop, which will not appear to move`);
    }
  }

  return {
    findings,
    errors: findings.filter(f => f.level === 'error').length,
    warnings: findings.filter(f => f.level === 'warn').length,
  };
}

/** Whether bones form an unbroken parent-to-child run in the order given. */
export function isChain(rig, bones) {
  if (!bones?.length) return false;
  for (let i = 1; i < bones.length; i++) if (rig.byKey.get(bones[i])?.parent !== bones[i - 1]) return false;
  return true;
}

// ===================== the mirror suggestion =====================

/**
 * Propose the opposite-side bones for a limb. A SUGGESTION, not a fact — hence the per-bone distance.
 *
 * The declared pair is what gets stored; this only saves the clicking. Matching is on mirrored rest
 * geometry rather than the node graph, because bone origins in these files are not anatomical and two
 * mirrored limbs are routinely built from different numbers of bones.
 */
/**
 * Which side of the body a group of bones sits on, from where its mesh actually is.
 *
 * A SUGGESTION, like `suggestMirror` below, and it is here rather than in `pokemon-rig.js` because that
 * module holds only facts. The fact it rests on is documented: these models stand on y = 0 and face +z,
 * so with y up the creature's own left is +x. What is a judgement is how near the middle counts as
 * centre, which is why `deadband` is a parameter and why nothing here writes itself into a file.
 *
 * The mean is unweighted. Weighting by vertex count would be defensible, but every bone of a limb is on
 * the same side of the body, so it would not change an answer.
 */
export function suggestSide(rig, bones, { deadband = 0.01 } = {}) {
  const scale = rig?.units?.height || 1;
  let sum = 0, n = 0;
  for (const b of bones || []) {
    const g = rig.geometry.get(b);
    const m = rig.byKey.get(b)?.restWorld;
    const x = g ? g.centroid.x : (m ? m[12] : null);
    if (x == null) continue;
    sum += x; n++;
  }
  if (!n) return 'C';
  const mean = sum / n / scale;
  return Math.abs(mean) < deadband ? 'C' : (mean > 0 ? 'L' : 'R');
}

/** The other side of a side. Centre has no other side, and says so rather than picking one. */
export function flipSide(side) {
  return side === 'L' ? 'R' : side === 'R' ? 'L' : 'C';
}

export function suggestMirror(rig, bones, { exclude = [], maxDistance = 0.25 } = {}) {
  const skip = new Set([...bones, ...exclude]);
  const scale = rig.units.height || 1;
  const centre = (key) => {
    const g = rig.geometry.get(key);
    if (g) return g.centroid;
    const m = rig.byKey.get(key)?.restWorld;
    return m ? { x: m[12], y: m[13], z: m[14] } : null;
  };
  const out = [];
  for (const b of bones) {
    const c = centre(b);
    if (!c) { out.push({ bone: b, match: null, distance: Infinity }); continue; }
    let best = null, bestD = Infinity;
    for (const other of rig.bones) {
      if (skip.has(other.key)) continue;
      const o = centre(other.key);
      if (!o) continue;
      const d = Math.hypot(o.x + c.x, o.y - c.y, o.z - c.z) / scale;
      if (d < bestD) { bestD = d; best = other.key; }
    }
    out.push({ bone: b, match: bestD <= maxDistance ? best : null, distance: bestD });
  }
  return {
    bones: out,
    // Ordered so the caller can hand it straight to `addAppendage`; misses are simply absent.
    chain: orderBones(rig, out.map(x => x.match).filter(Boolean)),
    misses: out.filter(x => !x.match).map(x => x.bone),
    worst: out.reduce((m, x) => Math.max(m, x.match ? x.distance : 0), 0),
  };
}

// ===================== the file =====================

export const emptyLibrary = () => ({ version: ANNOTATION_VERSION, species: {} });

export function getAnnotation(library, species) {
  return library?.species?.[species] ? copyAnnotation(library.species[species]) : null;
}

/** Writing a blank annotation back removes it, so the file only holds decisions somebody made. */
export function putAnnotation(library, annotation) {
  const next = { version: ANNOTATION_VERSION, species: { ...(library?.species || {}) } };
  if (!annotation?.species) return next;
  if (isBlank(annotation)) delete next.species[annotation.species];
  else next.species[annotation.species] = copyAnnotation(annotation);
  return next;
}

export const annotatedSpecies = (library) => Object.keys(library?.species || {}).sort();

/** Content hash, so a trial or an export can say which annotation it was measured against. */
export function annotationStamp(a) {
  if (!a || isBlank(a)) return 'blank';
  let h = 0x811c9dc5;
  const feed = (s) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } };
  const p = a.parts || {};
  feed(`${a.locomotion}|${a.posture}|${p.root}|`);
  feed(`${(p.spine || []).join(',')}|${(p.head || []).join(',')}|${[...(p.contacts || [])].sort().join(',')}|`);
  for (const ap of [...(p.appendages || [])].sort((x, y) => x.id.localeCompare(y.id))) {
    feed(`${ap.id}:${ap.type}:${ap.side}:${ap.row}:${(ap.chain || []).join(',')}:${ap.mirror}|`);
  }
  for (const k of Object.keys(a.neutral?.bones || {}).sort()) {
    const t = a.neutral.bones[k];
    const r = (v) => Math.round(v * 1e4) / 1e4;
    feed(`${k}:${t.p.map(r)}:${t.q.map(r)}:${t.s.map(r)}|`);
  }
  feed(`${groundingOf(a)}|${segmentsOf(a).map(([k, v]) => `${k}=${v.clip}:${v.from}-${v.to}:${v.ends}`).join(',')}`);
  return h.toString(16).padStart(8, '0');
}

/**
 * Resolve bone keys to node ids for a consumer that has to drive a scene graph.
 *
 * The file speaks in names because names are readable and diffable; a runtime speaks in node ids because
 * that is what a loader hands it. This is the only place the two meet.
 */
export function resolveAnnotation(a, rig) {
  const id = (key) => rig.nodeOf.get(key) ?? null;
  const list = (keys) => (keys || []).map(id).filter(n => n !== null);
  const p = a?.parts || {};
  return {
    species: a?.species ?? null,
    locomotion: a?.locomotion ?? null,
    posture: a?.posture ?? null,
    root: p.root ? id(p.root) : null,
    spine: list(p.spine),
    head: list(p.head),
    contacts: list(p.contacts),
    appendages: (p.appendages || []).map(ap => ({
      id: ap.id, type: ap.type, side: ap.side, row: ap.row, mirror: ap.mirror,
      chain: list(ap.chain),
      contacts: list(contactsOf(a, ap.id, rig)),
    })),
    neutral: {
      ground: groundingOf(a),
      bones: Object.fromEntries(Object.entries(a?.neutral?.bones || {})
        .map(([k, v]) => [id(k), v]).filter(([n]) => n !== null)),
    },
    // Segments come back with concrete bounds, since a runtime should never have to work out what the
    // last frame of a clip is before it can play one. `kind` is resolved here too, where an open `to` has
    // already become a number.
    segments: Object.fromEntries(segmentsOf(a)
      .map(([name, seg]) => [name, resolveSegment(seg, rig?.clips?.[seg.clip]?.frames)])
      .filter(([, seg]) => seg)
      .map(([name, seg]) => [name, { ...seg, kind: segmentKind(seg) }])),
    stamp: annotationStamp(a),
  };
}
