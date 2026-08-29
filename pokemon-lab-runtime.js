// The seam a game reads the lab through.
//
// This is the whole contract between the annotation work and anything that moves a creature. It is
// deliberately the thinnest file in the subsystem, and it is thin because everything it needs already
// exists: `pokemon-rig.js` measures the model, `pokemon-annotation.js` holds the decisions and already
// knows how to turn bone names into node ids. This adds the loading, and nothing else.
//
// Three rules, all of them the reason this file exists rather than the game importing the lab directly:
//
// - **No `serve.py`.** The lab file is fetched as a plain static JSON. A game that needed the workshop's
//   Python server running would not ship.
// - **No lab UI.** Nothing here imports `disk-store.js`, the page, or anything that assumes a browser
//   with a panel in it.
// - **No THREE.** It hands back glTF **node ids** and lets the caller drive its own scene graph. A
//   runtime that returned Object3Ds would decide the caller's renderer for them, and the whole point of
//   node ids is that both `gltf.parser.associations` and a raw glTF walk can resolve them.
//
// Which together mean the import path is testable in Node, end to end, without a browser or a GPU —
// `test-pokemon-lab-runtime.mjs` does exactly that.

import { readRigFromGLB } from './pokemon-rig.js';
import { emptyAnnotation, resolveAnnotation, ANNOTATION_VERSION } from './pokemon-annotation.js';

/** Where the lab file sits when it is served as a static asset. */
export const LAB_URL = '/stadium-saves/pokemon-lab.json';

/**
 * Read the one lab file.
 *
 * Throws on a failed load rather than returning empty, because a game that silently renders unannotated
 * creatures is one where nobody finds out for a week that the file 404s. Everything AFTER loading is
 * tolerant; the load itself is not.
 */
export async function loadLab(fetchImpl = fetch, url = LAB_URL) {
  const res = await fetchImpl(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`the lab file did not load: HTTP ${res.status} on ${url}`);
  const lab = await res.json();
  if (!lab || typeof lab !== 'object') throw new Error(`${url} is not a lab file`);
  if (lab.version !== ANNOTATION_VERSION) {
    throw new Error(`the lab file is version ${lab.version}, and this runtime reads version ${ANNOTATION_VERSION}`);
  }
  return lab;
}

/** Which species the file actually has something to say about. */
export function speciesInLab(lab) {
  return Object.keys(lab?.species || {}).sort();
}

/**
 * Everything a mover needs about one species, in node ids.
 *
 * `source` is either the model's GLB bytes or a rig already read from them — a game that has loaded the
 * model anyway should not pay to parse it twice.
 *
 * An unannotated species comes back in the same SHAPE with empty parts rather than as null, so a caller
 * never has to branch on whether the file happened to mention it; `annotated` says which it was. Same
 * for `staleRig`: a model re-exported since the annotation was made is reported, not thrown, because
 * only the caller knows whether a creature standing wrong is worse than no creature at all.
 */
export function rigFor(lab, species, source) {
  const facts = source && source.nodeOf ? source : readRigFromGLB(source, { source: species }).rig;
  const stored = lab?.species?.[species] || null;
  const annotation = stored || emptyAnnotation(species, facts);
  return {
    ...resolveAnnotation(annotation, facts),
    facts,
    annotated: !!stored,
    staleRig: !!(stored?.rigHash && facts?.hash && stored.rigHash !== facts.hash),
  };
}

/**
 * Put the neutral pose onto a scene graph the caller owns.
 *
 * `set(nodeId, { p, q, s })` is the caller's business — that callback is what keeps THREE out of this
 * file. Returns how many bones were placed, which is the difference between "there is no neutral pose"
 * and "the neutral pose named bones this model does not have".
 */
export function applyNeutral(resolved, set) {
  const bones = resolved?.neutral?.bones || {};
  let n = 0;
  for (const [node, trs] of Object.entries(bones)) {
    set(Number(node), trs);
    n++;
  }
  return n;
}

/**
 * The bones a mover may not have, listed rather than assumed.
 *
 * NOT a gate — it applies no per-class rule and passes no judgement, it only says which of the five
 * things the contract hands back are empty. A walker with no legs is a fact a caller can act on; whether
 * that makes the annotation wrong is `pokemon-gates.js`'s question.
 */
export function missingParts(resolved) {
  const out = [];
  if (resolved.root === null) out.push('root');
  if (!resolved.spine.length) out.push('spine');
  if (!resolved.appendages.length) out.push('appendages');
  if (!resolved.contacts.length) out.push('contacts');
  if (!resolved.locomotion) out.push('locomotion');
  return out;
}
