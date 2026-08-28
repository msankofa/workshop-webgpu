// The one file Pokemon Lab writes, and the dex list its browse grid is built from.
//
// Everything a person decides in the lab lands in `stadium-saves/pokemon-lab.json` — a real file, in the
// repo, that git backs up and diffs. `localStorage` is kept only as the copy of last resort, which is what
// a page opened without `python serve.py` reads and what survives a failed write.
//
// No THREE and no DOM: both sides of the store are injected, so this whole module runs under Node and the
// filename the page saves to can be checked against the server's whitelist by a test.

import { createDiskStore } from './disk-store.js';
import { ANNOTATION_VERSION, emptyLibrary, isBlank, normaliseSegment, wholeClip } from './pokemon-annotation.js';

export const LAB_FILE = 'pokemon-lab.json';
export const LAB_READ_URL = `/stadium-saves/${LAB_FILE}`;
export const LAB_WRITE_URL = `/api/save-stadium?filename=${LAB_FILE}`;
export const MANIFEST_URL = './models/stadium/manifest.json';
export const MODEL_DIR = './models/stadium/';

/** An explicit snapshot, alongside the live document. Kept in step with `serve.py`'s stadium whitelist. */
export function snapshotFilename(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`
    + `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `pokemon-lab-${stamp}.json`;
}

export const snapshotWriteURL = (filename) => `/api/save-stadium?filename=${filename}`;

export function createLabStore({ storage = null, fetchImpl = null, debounceMs = 700 } = {}) {
  return createDiskStore({
    read: LAB_READ_URL, write: LAB_WRITE_URL,
    storage, key: 'pcw:pokemonLab', fetchImpl, debounceMs,
  });
}

// ===================== the document =====================

/**
 * A library from whatever the file actually held.
 *
 * Never throws and never drops a species silently: anything unusable is reported in `notes` so the page
 * can say so out loud. A hand-edited file is expected — the whole point of saving to disk is that it can
 * be read and edited by a person.
 */
export function migrateLibrary(raw) {
  const notes = [];
  if (raw == null) return { library: emptyLibrary(), notes };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { library: emptyLibrary(), notes: ['the saved file is not a JSON object, so it was ignored'] };
  }
  const version = Number(raw.version) || 0;
  if (version > ANNOTATION_VERSION) {
    notes.push(`the file says version ${version} and this page understands ${ANNOTATION_VERSION};`
      + ' anything it does not recognise will be dropped when you next save');
  }
  const species = {};
  const entries = raw.species && typeof raw.species === 'object' && !Array.isArray(raw.species) ? raw.species : {};
  if (raw.species && entries !== raw.species) notes.push('`species` was not an object, so no annotations were read');
  for (const [key, value] of Object.entries(entries)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      notes.push(`${key} is not an annotation object and was dropped`);
      continue;
    }
    const a = normaliseAnnotation(key, value, notes);
    if (!isBlank(a)) species[key] = a;
  }
  return { library: { version: ANNOTATION_VERSION, species }, notes };
}

/** Fill in what a hand-edited entry may be missing, so the page never reads through a null. */
function normaliseAnnotation(key, value, notes) {
  const parts = value.parts && typeof value.parts === 'object' ? value.parts : {};
  const neutral = value.neutral && typeof value.neutral === 'object' ? value.neutral : {};
  const list = (v) => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : []);
  if (value.species && value.species !== key) {
    notes.push(`${key} calls itself ${value.species}; the key wins`);
  }
  return {
    version: ANNOTATION_VERSION,
    species: key,
    rigHash: typeof value.rigHash === 'string' ? value.rigHash : null,
    locomotion: typeof value.locomotion === 'string' ? value.locomotion : null,
    posture: typeof value.posture === 'string' ? value.posture : null,
    parts: {
      root: typeof parts.root === 'string' ? parts.root : null,
      spine: list(parts.spine),
      head: list(parts.head),
      appendages: (Array.isArray(parts.appendages) ? parts.appendages : [])
        .filter(ap => ap && typeof ap === 'object' && typeof ap.id === 'string')
        .map(ap => ({ ...ap, chain: list(ap.chain) })),
      contacts: list(parts.contacts),
    },
    neutral: {
      bones: neutral.bones && typeof neutral.bones === 'object' ? neutral.bones : {},
      ground: typeof neutral.ground === 'boolean' ? neutral.ground : null,
      source: typeof neutral.source === 'string' ? neutral.source : null,
    },
    segments: readSegments(key, value, notes),
    done: !!value.done,
    notes: typeof value.notes === 'string' ? value.notes : '',
  };
}

/**
 * Named segments, upgrading the shape the file used before segments existed.
 *
 * v1's first form was `clips: { idle: 3 }` — a name pointing at a whole clip. That is a segment covering
 * the whole of clip 3, so it converts exactly rather than being thrown away. A `to` of null means the last
 * frame, which is why the conversion does not need to know how long the clip is.
 */
function readSegments(key, value, notes) {
  const out = {};
  const source = value.segments && typeof value.segments === 'object' && !Array.isArray(value.segments)
    ? value.segments
    : (value.clips && typeof value.clips === 'object' && !Array.isArray(value.clips) ? value.clips : {});
  let upgraded = 0;
  for (const [name, raw] of Object.entries(source)) {
    if (Number.isInteger(raw)) { out[name] = wholeClip(raw); upgraded++; continue; }
    const seg = normaliseSegment(raw);
    if (seg) out[name] = seg;
    else notes.push(`${key} has a segment "${name}" that is not a clip and a frame range; it was dropped`);
  }
  if (upgraded) notes.push(`${key}: ${upgraded} whole-clip role(s) became segments covering the whole clip`);
  return out;
}

/** The library the store currently holds, migrated. */
export function readLibrary(store) {
  return migrateLibrary(store.json(null));
}

// ===================== the dex =====================

export async function loadManifest(fetchImpl = fetch, url = MANIFEST_URL) {
  const res = await fetchImpl(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`the model manifest did not load: HTTP ${res.status}`);
  return res.json();
}

/**
 * The 151, in dex order, as the browse grid wants them.
 *
 * `species` is the annotation key and the .glb basename at once — the file is what a re-extraction would
 * change, so keying on it means a renamed model shows up as a missing species rather than as a silently
 * mismatched one.
 */
export function dexEntries(manifest) {
  return Object.entries(manifest || {})
    .map(([key, m]) => ({
      key,
      dex: Number(m.dex) || Number(key) || 0,
      name: m.name || m.slug || key,
      slug: m.slug || '',
      file: m.file || `${key}.glb`,
      species: String(m.file || '').replace(/\.glb$/i, ''),
      bones: Number(m.bones) || 0,
      tris: Number(m.tris) || 0,
      bytes: Number(m.bytes) || 0,
      clips: Array.isArray(m.clips) ? m.clips : [],
    }))
    .sort((a, b) => a.dex - b.dex);
}

export const modelURL = (species, dir = MODEL_DIR) => `${dir}${species}.glb`;

/**
 * Clip labels for one species, by index.
 *
 * The manifest's clip list matches the .glb animation list exactly — same count, same order, same names,
 * and durations agreeing to within a frame on all 1,171 clips in the dex — so a label can be taken by
 * position. `test-pokemon-lab-io.mjs` asserts that, because the day it stops being true every label in the
 * page would point at the wrong animation without anything looking broken.
 */
export function clipLabels(entry) {
  return (entry?.clips || []).map((c, i) => {
    const label = String(c.label || `anim${i}`);
    const cut = label.indexOf(' ');
    return {
      index: i,
      label,
      name: cut === -1 ? label : label.slice(0, cut),
      note: cut === -1 ? '' : label.slice(cut + 1).replace(/^\(|\)$/g, ''),
      frames: Number(c.frames) || 0,
      seconds: Number(c.seconds) || 0,
      loop: !!c.loop,
    };
  });
}

/** The clip the manifest calls the idle — a suggestion for the browse view, never a recorded decision. */
export function suggestedIdle(entry) {
  const clips = clipLabels(entry);
  return clips.find(c => c.name === 'idle') || clips.find(c => /^idle/.test(c.name)) || clips[0] || null;
}

// ===================== status =====================

export const STATUS_ORDER = ['untouched', 'progress', 'ready', 'done', 'done-findings'];

export const STATUS_LABELS = {
  untouched: 'untouched',
  progress: 'in progress',
  ready: 'ready',
  done: 'done',
  'done-findings': 'done, with findings',
};

/**
 * Where a species stands on the board.
 *
 * Two independent signals, not one: whether a person marked it done, and whether the gates are happy.
 * `findings` is null until the gates exist, and a null is not the same as an empty list — nothing can be
 * called ready on the strength of checks that never ran.
 */
export function speciesStatus(annotation, findings = null) {
  const count = Array.isArray(findings) ? findings.length : null;
  if (!annotation || isBlank(annotation)) return { state: 'untouched', findings: count };
  if (annotation.done) return { state: count ? 'done-findings' : 'done', findings: count };
  if (count === 0) return { state: 'ready', findings: 0 };
  return { state: 'progress', findings: count };
}

/** How many species sit in each state, for the one line above the grid. */
export function labSummary(library, entries, findingsFor = null) {
  const counts = Object.fromEntries(STATUS_ORDER.map(s => [s, 0]));
  for (const e of entries || []) {
    const a = library?.species?.[e.species] || null;
    counts[speciesStatus(a, findingsFor ? findingsFor(e.species, a) : null).state]++;
  }
  return counts;
}

/** True when the model has been re-extracted since the annotation was made, so its bone names may have moved. */
export function rigMismatch(annotation, rig) {
  return !!(annotation?.rigHash && rig?.hash && annotation.rigHash !== rig.hash);
}
