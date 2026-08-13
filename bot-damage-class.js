// Damage class: what language a bot's injuries are spoken in — blood, sparks, smoke, which audio
// bank, what happens when it dies. Pure data, no THREE, no DOM, Node-testable.
//
// This exists so the four damage-FX features (wound-centred blood, limb loss, blood pools, robot
// fire) can each read a capability off one table instead of each growing its own
// `if (bodyKind === 'armoured')` branch. bot-roles.js is the model: a DEFAULTS object merged into
// named rows, and the hard rule that NO CALL SITE ANYWHERE branches on a class id string. Every
// consumer reads `getDamageClass(id).<field>`. Adding a fourth class is one new row.
//
// Damage class is deliberately NOT the same axis as body kind. Body kind is geometry and is still a
// single global (bot-body-design.js's _bodyKind), so mixed-geometry fights are impossible today.
// Damage class only has to answer "what is this thing made of" per hit, and the hit path already
// runs per target — so a mixed-damage-language field is reachable well before mixed geometry is.
// classForActor() bridges the two until an explicit per-actor override exists.

export const DAMAGE_CLASS_DEFAULTS = {
  blood: 'always',         // 'always' | 'lowHealthOnly' | 'never'
  bloodThreshold01: null,  // hp fraction at or below which blood starts; only read for 'lowHealthOnly'
  sparks: false,           // hit_spark on every hit, independent of blood
  smoke: 'never',          // 'never' | 'lowHealthOnly' | 'always' — smoke_puff wisps on hit
  spasms: false,           // pre-death twitch overlay; render-time only, never an FSM state
  haywireOnDeath: false,   // death-flourish variant layered on the existing ragdoll branch
  hitAudio: 'flesh',       // 'flesh' | 'metal' — which bot-damage-audio bank plays on hit
  deathAudio: 'flesh',     // 'flesh' | 'metal' — which bank plays on death
};

// Only the fields that differ from the defaults are written, so a new default reaches every row.
export const DAMAGE_CLASSES = {
  human: {
    blood: 'always',
  },
  // Armour takes the hit first: sparks off the plate from the start, blood only once the plate is
  // compromised. 0.35 sits below botHealthSettings.threshold01 (0.60, the heal-retreat trigger), so
  // a bot starts pulling back to heal before it starts visibly bleeding.
  armouredHuman: {
    blood: 'lowHealthOnly', bloodThreshold01: 0.35, sparks: true, smoke: 'lowHealthOnly',
    hitAudio: 'metal', deathAudio: 'flesh',
  },
  // Unreachable until a per-actor override or robot geometry exists; the row is here so consumers
  // can be written and tested against it now.
  robot: {
    blood: 'never', sparks: true, smoke: 'always',
    spasms: true, haywireOnDeath: true, hitAudio: 'metal', deathAudio: 'metal',
  },
};

export const DAMAGE_CLASS_IDS = Object.keys(DAMAGE_CLASSES);
export const DEFAULT_DAMAGE_CLASS = 'human';

// Merged rows are built once. Consumers get a frozen object so a caller cannot mutate the table for
// everyone else by writing through a returned row.
const _merged = new Map();
for (const [id, row] of Object.entries(DAMAGE_CLASSES)) {
  _merged.set(id, Object.freeze({ id, ...DAMAGE_CLASS_DEFAULTS, ...row }));
}

/** The class row for an id. An unknown id falls back rather than throwing (bot-roles.js's getRole). */
export function getDamageClass(id) {
  return _merged.get(id) || _merged.get(DEFAULT_DAMAGE_CLASS);
}

/**
 * Which class an actor speaks. Precedence: an explicit per-actor/per-entity override first, then
 * today's global body kind. The override is the seam a mixed fight arrives through — nothing sets
 * it yet, so every bot resolves off body kind for now.
 */
export function classForActor(actor, bodyKind = null) {
  const id = actor?.damageClass || actor?.entity?.damageClass;
  if (id && _merged.has(id)) return id;
  const kind = bodyKind ?? actor?.bodyKind ?? null;
  if (kind === 'soldier') return 'human';
  if (kind === 'armoured') return 'armouredHuman';
  return DEFAULT_DAMAGE_CLASS;
}

/**
 * Does this hit draw blood, and is the armour breached afterwards?
 *
 * Extracted as a pure function so the decision is testable without the 14k-line viewer, the same way
 * bot-state-code.js keeps healthBand/tierSlot out of the host file.
 *
 * `breached` is a ONE-WAY LATCH, not a hysteresis band. Blood gating is evaluated once per discrete
 * hit, not per frame, so the usual enter/exit band (botHealthSettings' 0.60/0.72) solves a problem
 * that doesn't arise here. What a plain threshold WOULD get wrong is a healed bot: armour once
 * breached does not un-breach, so a medic topping a bot back up must not make it stop bleeding.
 * Caller stores the returned `breached` back on the actor and passes it in next time.
 */
export function shouldShowBlood(cls, hpAfter01, alreadyBreached = false) {
  const c = cls && typeof cls === 'object' ? cls : getDamageClass(cls);
  if (c.blood === 'never') return { show: false, breached: false };
  if (c.blood === 'always') return { show: true, breached: !!alreadyBreached };
  // 'lowHealthOnly'
  const hp = Number.isFinite(hpAfter01) ? hpAfter01 : 1;
  const t = Number.isFinite(c.bloodThreshold01) ? c.bloodThreshold01 : 0;
  const breached = !!alreadyBreached || hp <= t;
  return { show: breached, breached };
}

/** Does this hit throw smoke? Same low-health rule as blood, read off its own field. */
export function shouldShowSmoke(cls, hpAfter01, alreadyBreached = false) {
  const c = cls && typeof cls === 'object' ? cls : getDamageClass(cls);
  if (c.smoke === 'never') return false;
  if (c.smoke === 'always') return true;
  const hp = Number.isFinite(hpAfter01) ? hpAfter01 : 1;
  const t = Number.isFinite(c.bloodThreshold01) ? c.bloodThreshold01 : 0;
  return !!alreadyBreached || hp <= t;
}
