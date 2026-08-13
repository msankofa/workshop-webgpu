// Maps a 9-char bot state code (bot-state-code.js) to activation levels of seven
// functional mind regions. Pure and THREE-free so the mapping is testable in Node.
import { decodeBotState, describeBotState } from './bot-state-code.js';

export const REGIONS = [
  { id: 'perception', label: 'perception', pos: [0, 0.38, 0.85], color: 0x39c5ff,
    blurb: 'how alarmed the bot is: alert tier and escalation score' },
  { id: 'intent', label: 'intent', pos: [0, 0.95, 0.1], color: 0xffd23f,
    blurb: 'the ladder state: what the bot is trying to do right now' },
  { id: 'movement', label: 'movement', pos: [0, -0.1, -0.78], color: 0x4dff88,
    blurb: 'locomotion drive; in replay this is the measured speed' },
  { id: 'weapon', label: 'weapon skill', pos: [0.75, 0.12, 0.2], color: 0xff5c5c,
    blurb: 'aiming, firing, reloading, blade work; fed by the ammo slot' },
  { id: 'social', label: 'squad sense', pos: [-0.75, 0.12, 0.2], color: 0xc77dff,
    blurb: 'role, push element, medic duty' },
  { id: 'body', label: 'body monitor', pos: [0, -0.72, 0.15], color: 0xff9f45,
    blurb: 'health band, held packs, healing' },
  { id: 'commit', label: 'commitments', pos: [0, 0.18, 0.05], color: 0x9efcf0,
    blurb: 'latched decisions the bot is holding onto (its working memory)' },
];

// Edges name real influence paths: alerts drive state, duty overrides state,
// health gates flee/heal, latches hold state, sight gates fire.
export const EDGES = [
  ['perception', 'intent'], ['intent', 'movement'], ['intent', 'weapon'],
  ['social', 'intent'], ['body', 'intent'], ['commit', 'intent'],
  ['perception', 'weapon'],
];

// Observed in bot-states/bot-state-trace-20260729-101218.tsv, one per ladder state.
export const DEMO_STATES = [
  { code: 'P00r-4410', caption: 'The bot patrols while calm. The mind is mostly dark.' },
  { code: 'S00r-4410', caption: 'The bot seeks a last-known position.' },
  { code: 'U00r-2310', caption: 'The bot pursues a visible target.' },
  { code: 'A00r-441G', caption: 'The bot aims, holding the sight-grace latch on a target it just lost.' },
  { code: 'F00r-4410', caption: 'The bot fires. Weapon skill is at full.' },
  { code: 'C32r-4412', caption: 'The bot breaks for cover at the defensive tier with the cover commit latched.' },
  { code: 'G00r-4312', caption: 'The bot holds a cover anchor.' },
  { code: 'E00r-4210', caption: 'The bot flees as its health falls.' },
  { code: 'H00r-4210', caption: 'The bot holds still to heal. The body monitor is at full.' },
  { code: 'M32m-4420', caption: 'The medic moves to a wounded ally. Squad sense is at full.' },
  { code: 'T00m-4420', caption: 'The medic channels a heal or revive.' },
  { code: 'D00r--000', caption: 'The bot is dead. Every region is at zero.' },
];

const INTENT_BY_CLASS = { idle: 0.35, search: 0.6, engage: 1, survive: 0.9, defend: 0.8, support: 0.85, terminal: 0 };
const MOVE_BY_STATE = { P: 0.4, S: 0.7, U: 0.9, E: 1, C: 0.9, M: 0.9, K: 0.8, H: 0, G: 0.1, A: 0.1, F: 0.1, T: 0, D: 0 };
// vis_gate letters, from bot-viewer-v2.html botTargetVisGate
const GATE_TEXT = { y: 'in sight', w: 'behind a wall', f: 'outside the view cone', r: 'beyond sight range' };

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const q = (v) => Math.round(clamp01(v) * 20) / 20; // slot bands are coarse; keep levels coarse too

// measured-speed movement, shared by mindActivations and the view's per-frame fast path
export function movementMeasured(speed, path = '') {
  return { level: q(Math.min(1, speed / 5)), detail: `Moving at ${speed.toFixed(1)} m/s, from the trace.${path}` };
}

// mindActivations(code, ctx?) -> { code, decoded, doing, regions: {id: {level, detail}} }
// ctx (replay/live rows only): { speed, targetId, targetDist, visGate, goalDist, pathMode,
// pathLen, squadId, squadRank, leaderId }. Levels stay code-driven except measured speed;
// row columns enrich the detail strings.
export function mindActivations(code, ctx = null) {
  const d = decodeBotState(code);
  if (!d) return null;
  const dead = d.stateChar === 'D';
  const r = {};

  let seeing = '';
  if (!dead && ctx) {
    seeing = ctx.targetId
      ? ` Watching ${ctx.targetId}${Number.isFinite(ctx.targetDist) ? ` at ${ctx.targetDist.toFixed(1)}m` : ''}${GATE_TEXT[ctx.visGate] ? `; it is ${GATE_TEXT[ctx.visGate]}` : ''}.`
      : ' It sees no target.';
  }
  r.perception = dead
    ? { level: 0, detail: '—' }
    : { level: q(Math.max(d.score / 9, +d.tierChar / 4)), detail: `Alert tier ${d.tier}, escalation ${d.score} of 9.${seeing}` };

  const goal = !dead && ctx && Number.isFinite(ctx.goalDist) ? ` The goal is ${ctx.goalDist.toFixed(0)}m away.` : '';
  r.intent = { level: dead ? 0 : q(INTENT_BY_CLASS[d.stateClass] ?? 0.5), detail: `${d.state} (${d.stateClass}).${goal}` };

  const measured = ctx && Number.isFinite(ctx.speed);
  const path = !dead && ctx?.pathMode ? ` The ${ctx.pathMode} path has ${ctx.pathLen ?? 0} nodes.` : '';
  r.movement = dead
    ? { level: 0, detail: '—' }
    : measured ? movementMeasured(ctx.speed, path)
    : { level: q(MOVE_BY_STATE[d.stateChar] ?? 0), detail: 'Estimated from the state.' + path };

  const weaponLevel = dead || d.ammoChar === '-' ? 0
    : d.ammoChar === 'R' ? 0.9
    : d.stateChar === 'F' ? 1
    : d.stateChar === 'A' ? 0.8
    : d.stateChar === 'K' ? 0.7
    : 0.1 + 0.05 * (d.ammoBand ?? 0);
  r.weapon = { level: q(weaponLevel), detail: dead ? '—' : d.ammo };

  const onDuty = d.stateChar === 'M' || d.stateChar === 'T';
  let squad = null;
  if (!dead && ctx?.squadId) {
    squad = ctx.squadRank === 0 ? `It leads ${ctx.squadId}.`
      : ctx.squadRank > 0 && ctx.leaderId ? `It follows ${ctx.leaderId} in ${ctx.squadId}.`
      : `It is in ${ctx.squadId}.`;
  }
  r.social = {
    level: dead ? 0 : q(onDuty ? 1 : d.elementChar !== '-' ? 0.8 : ctx?.squadRank === 0 ? 0.6 : d.roleChar === 'm' ? 0.5 : 0.15),
    detail: dead ? '—' : [`The bot is a ${d.role}.`, squad,
      d.elementChar !== '-' ? `It is in the ${d.element} element.` : null,
      onDuty ? 'It is on medic duty.' : null].filter(Boolean).join(' '),
  };

  const carrying = d.packs || d.hasKit
    ? ` It carries ${d.packs ? `${d.packs} pack${d.packs > 1 ? 's' : ''}` : ''}${d.packs && d.hasKit ? ' and ' : ''}${d.hasKit ? 'a revive kit' : ''}.`
    : '';
  r.body = {
    level: dead ? 0 : d.stateChar === 'H' ? 1 : q(0.1 + ((4 - d.health) / 4) * 0.9),
    detail: dead ? '—' : `Health is ${d.healthRange}.${carrying}`,
  };

  r.commit = {
    level: dead ? 0 : q(d.latches.length / 5),
    detail: dead || !d.latches.length ? 'No latches are held.' : `It is holding: ${d.latches.join(', ')}.`,
  };

  return { code, decoded: d, doing: describeBotState(code), regions: r };
}

// attentionBearing(self, target) -> degrees the target sits off the bot's facing, in (-180, 180].
// Forward is (sin yaw, cos yaw) in world x/z (bot-trace-viewer.html:729); yaw in degrees.
export function attentionBearing(self, target) {
  if (!self || !target) return null;
  const { x, z, yaw } = self;
  if (![x, z, yaw, target.x, target.z].every(Number.isFinite)) return null;
  const bearing = Math.atan2(target.x - x, target.z - z) * 180 / Math.PI;
  let rel = (bearing - yaw) % 360;
  if (rel <= -180) rel += 360;
  if (rel > 180) rel -= 360;
  return rel;
}
