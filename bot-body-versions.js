// bot-body-versions.js
//
// BODY and HEAD as independent axes. A bot design is really two decisions — what it wears from the
// neck down, and what its head is — and until now they were welded together: every head lived
// inside one BOT_BODY_DESIGN, so comparing the human head against the armour meant editing the
// armour, and comparing two body iterations meant dragging their heads along with them.
//
// `composeBot(bodyKey, headKey, headOpts)` crosses the two lists. It works because head gear is
// exactly the set of `anchor: 'head'` pieces, so a head is separable from any body by construction.
//
// THE SKULL TRAVELS WITH THE HEAD, not the body. `headProfile`/`headRadial`/`headZScale`/`eye` are
// top-level design fields, not gear, so a swap that moved only the gear would leave (say) the human
// face hanging on a 0.086 m armoured skull. Each body's own skull is captured here as part of its
// 'as authored' head, and every other head brings its own.

import { BODY_DESIGN_DEFAULTS } from './player-procedural-body.js';
import { BOT_BODY_DESIGN, BOT_HELMETS, BOT_DESIGN_ADDONS } from './bot-body-design.js';
import { BOT_BODY_DESIGN as V1 } from './bot-bodies/v1-blockout.js';
import { BOT_BODY_DESIGN as V2 } from './bot-bodies/v2-armoured.js';
import { BOT_BODY_DESIGN as V3 } from './bot-bodies/v3-slit-helmet.js';
import { BOT_BODY_DESIGN as V4 } from './bot-bodies/v4-helmet-mk8.js';
import { withHumanHead } from './bot-face.js';
import { HUMAN_BODY_DESIGN, HUMAN_HEAD_SCALE } from './bot-human-body.js';

// `branch: 'armour'` is one line of descent, oldest first, so that part of the list reads as the
// design's history. `default rig` is the bare player-procedural-body — no gear at all, the thing
// every bot design started as. The clothed human is a SEPARATE branch, not a later version of the
// mech, and is marked as such so nothing treats the list as one timeline.
export const BOT_BODIES = Object.freeze([
  { key: 'default', label: 'default rig (no gear)', branch: 'armour', design: BODY_DESIGN_DEFAULTS },
  { key: 'v1', label: 'v1 blockout', branch: 'armour', design: V1 },
  { key: 'v2', label: 'v2 armoured', branch: 'armour', design: V2 },
  { key: 'v3', label: 'v3 slit helmet', branch: 'armour', design: V3 },
  { key: 'v4', label: 'v4 helmet mk8', branch: 'armour', design: V4 },
  { key: 'current', label: 'v5 current', branch: 'armour', design: BOT_BODY_DESIGN },
  // HEADLESS BY DESIGN: this one carries no headProfile at all, so it MUST be paired with a head
  // from the head axis. On 'as authored' it falls back to the rig default and gets a mannequin head.
  { key: 'human', label: 'human (unarmoured)', branch: 'human', design: HUMAN_BODY_DESIGN },
]);

/** The armoured line of descent, oldest first. */
export const BOT_BODY_HISTORY = Object.freeze(BOT_BODIES.filter((b) => b.branch === 'armour'));

/** True when a body brings no skull and therefore relies entirely on the head axis. */
export const isHeadless = (design) => design.headProfile === undefined;

export const BOT_HEAD_KEYS = Object.freeze(['as authored', 'human', ...Object.keys(BOT_HELMETS)]);

// Falls back to the SHIPPED design by key, not to whatever is last in the list — adding a branch to
// the end silently changed what an unknown key resolved to, which is exactly the kind of drift a
// positional default invites.
const bodyEntry = (key) => BOT_BODIES.find((b) => b.key === key)
  || BOT_BODIES.find((b) => b.key === 'current');

/** A design's own head: its head gear plus the skull fields that gear was authored against. */
export function headOf(design) {
  return {
    gear: (design.gear || []).filter((g) => g.anchor === 'head'),
    shape: {
      headProfile: design.headProfile,
      headRadial: design.headRadial,
      headZScale: design.headZScale,
      eye: design.eye,
    },
    role: design.roles?.head ?? null,
  };
}

/** Everything from the neck down, with the head stripped off. */
export function bodyOf(design) {
  return (design.gear || []).filter((g) => g.anchor !== 'head');
}

/** Kit is the third axis: the pack and role markers that layer on top of any body. */
export const BOT_KITS = Object.freeze(['none', ...Object.keys(BOT_DESIGN_ADDONS)]);

/**
 * Cross a body version with a head and a kit.
 * @param {string}   bodyKey   a BOT_BODIES key
 * @param {string}   headKey   'as authored' | 'human' | a BOT_HELMETS key
 * @param {object}   [headOpts]  passed through to makeHumanHead for the human head
 * @param {string[]} [kits]      BOT_DESIGN_ADDONS names layered on, in order
 */
export function composeBot(bodyKey, headKey = 'as authored', headOpts = {}, kits = []) {
  const body = bodyEntry(bodyKey).design;
  const extra = kits.flatMap((k) => BOT_DESIGN_ADDONS[k] || []);
  const withKit = (d) => (extra.length ? { ...d, gear: [...(d.gear || []), ...extra] } : d);

  // The head scales WITH the body it lands on. Without this the clothed human, whose lengths are
  // scaled up to fill the player capsule, would wear a head sized for the unscaled rig.
  if (headKey === 'human') {
    const scale = headOpts.scale ?? (bodyKey === 'human' ? HUMAN_HEAD_SCALE : 1);
    return withKit(withHumanHead(body, { ...headOpts, scale }));
  }

  // 'as authored' with no kit is the identity case and has to return the stored design UNTOUCHED —
  // recomposing it from its own parts would be a no-op that could still drift if a field were
  // missed, and this list's whole point is that the old versions are trustworthy references.
  if (headKey === 'as authored') return withKit(body);

  const helmet = BOT_HELMETS[headKey];
  if (!helmet) return withKit(body);
  // A helmet is authored against the CURRENT design's skull, so bring that skull with it rather
  // than leaving whatever the body version happened to have — a Mark VII on v1's head clips.
  const shape = headOf(BOT_BODY_DESIGN).shape;
  return withKit({
    ...body, ...shape,
    roles: { ...(body.roles || null), head: 'shell' },
    gear: [...helmet, ...bodyOf(body)],
  });
}
