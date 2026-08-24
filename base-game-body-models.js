// Pure player-model identity registry. Render composition stays in base-game-player-bodies.js;
// the room server imports only this whitelist and the gameplay hit-profile id.

export const BASE_GAME_DEFAULT_BODY_MODEL = 'default';
export const DEFAULT_BASE_GAME_BODY_MODEL = BASE_GAME_DEFAULT_BODY_MODEL;
export const BASE_GAME_DEFAULT_HIT_PROFILE = 'humanoid-default';

export const BASE_GAME_BODY_MODELS = Object.freeze([
  ['default', 'default rig (no gear)'],
  ['v1', 'v1 blockout'],
  ['v2', 'v2 armoured'],
  ['v3', 'v3 slit helmet'],
  ['v4', 'v4 helmet mk8'],
  ['current', 'v5 current'],
  ['human', 'human (unarmoured)'],
  ['soldier:rifleman', 'soldier rifleman'],
  ['soldier:medic', 'soldier medic'],
  ['soldier:technical', 'soldier technical'],
  ['soldier:sniper', 'soldier sniper'],
  ['soldier:squadleader', 'soldier squadleader'],
].map(([key, label]) => Object.freeze({ key, label, hitProfile: BASE_GAME_DEFAULT_HIT_PROFILE })));
export const BASE_GAME_BODY_MODEL_IDS = Object.freeze(BASE_GAME_BODY_MODELS.map(model => model.key));

const MODEL_BY_ID = new Map(BASE_GAME_BODY_MODELS.map(model => [model.key, model]));

export function bodyModelById(value) {
  return typeof value === 'string' ? MODEL_BY_ID.get(value) ?? null : null;
}

export function sanitizeBaseGameBodyModel(value) {
  return bodyModelById(value)?.key ?? BASE_GAME_DEFAULT_BODY_MODEL;
}

export function hitProfileForBodyModel(value) {
  return bodyModelById(value)?.hitProfile ?? BASE_GAME_DEFAULT_HIT_PROFILE;
}
