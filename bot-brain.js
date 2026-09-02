// bot-brain.js — the bot-viewer-v3 brain as a server-safe module. GENERATED from
// bot-viewer-v3.html by tools/bot-brain-gen/ (2026-08-27): the function bodies are the harness's,
// verbatim, apart from the two PATCHES the generator lists; the host surface at the bottom is
// hand-written there too. Regenerate rather than editing the bodies here. No THREE, no DOM: the
// world is injected (heightAt, raycast), effects are hooks, and the bot record is a plain capsule
// the host moves between ticks and reads back as intent (velocity, yaw, stance, fire hook).
// Plan: docs/superpowers/plans/2026-08-27-base-game-npc-bots.md.

import { AIM_TOLERANCE_RAD, BOT_AIM, BOT_COVER_HOLD, BOT_COVER_MOVE, BOT_FIRE, BOT_FLEE, BOT_HEAL, BOT_KNIFE, BOT_PATROL, BOT_PURSUE, BOT_SEEK, CLOSE_THREAT_RADIUS, SEEK_SPREAD_RING_M, TURN_RATE_RAD_S, aimAnglesTo, aimError, botSeedFromId, chooseBotStateName, healUnsafeBand, pursueBreakThreshold, resetVisibleDebounce, shouldTopOffReload, slewAngle, spreadAnchor, spreadAnchorRadius, stepVisibleDebounce } from './bot-activity.js';
import { AIM_BLEND_DEFAULTS, aimLeadSeconds, directionError } from './bot-aim-blend.js';
import { AIM_DEFAULTS, decayBloomDeg, reactionDelayMs } from './bot-aim.js';
import { ALERT_DEFENSIVE_SCORE, ALERT_PUSH_SCORE, CONTACT_SHARE_RADIUS, ESCALATION_RADIUS, NEAR_MISS_KIND, SEMI_ALERT_SHARE_RADIUS, SEMI_ALERT_WARY_MS, SUPPORT_GROUP_MIN, SUPPORT_RADIUS, alertEscalation, alertTierChannels, alertWindowMs, attentionSweep, exposedToThreat, isContact, isNearMiss, latestAlertNear, latestContactNear, latestNearMiss, latestSelfThreat, patrolScanOffset, perceptionForTier, recordContact, stepAlertHold, stepAttention, sweepPhaseMs } from './bot-alert.js';
import { createContactMemory, markContactsUnseen, recordContactSighting } from './bot-contacts.js';
import { PEEK_APPROACH_SPEED, approachXZ, blacklistCover, coverBlacklisted, coverCommitTimedOut, coverCornerValid as coverCornerValidPure, coverHoldExitReason, coverInBand, coverSeatBand, coverSwitchAllowed, createCoverBlacklist, createPeekCycle, fleeCandidateScore, fleePathExposureFromParents, noteCoverSwitch, peekAiming, peekExposed, peekPhaseOffsetS, peekPosition, pickCoverCorner, stepCoverGate, stepPeekCycle } from './bot-cover.js';
import { DANGER_DEATH_WEIGHT, DANGER_FLEE_SCALE, DANGER_HIT_WEIGHT, DANGER_PACK_SCALE, DANGER_PATROL_SCALE, cellNeighbors8, createDangerField, dangerBlocksCover, dangerPenalty, hasDanger, recordDanger } from './bot-danger.js';
import { DRONE_BOMBER, DRONE_DEFS, DRONE_LOITER, OPERATOR_DEFAULTS } from './bot-drones.js';
import { blendSeparationDir, createGoalClaims, separationXZHashed, waypointContestedHashed } from './bot-entity.js';
import { GRENADE_DEFAULTS, chooseGrenadeThrow, grenadeEvade, throwCountFor } from './bot-grenade.js';
import { addPack, canHold, consumeRevivePacks, drawFromPacks, hasHealResource, hasReviveMaterials, makePack, packClaimIntent, packRunSafe } from './bot-health-packs.js';
import { MEDIC_CONTACT_CREEP, MEDIC_CONTACT_RADIUS, MEDIC_DEFAULTS, MEDIC_MOVE, MEDIC_TEND, cohesionTarget, decideMedicAction, medicChaseSpeedFactor, medicTendRadiusFor, teamCentroid } from './bot-medic.js';
import { sampleArcPoints, solveBallisticArc } from './bot-projectiles.js';
import { interceptPoint, investigationRadius, pincerOffsets, standoffPoint } from './bot-pursuit.js';
import { DEFAULT_ROLE, ROLE_DRONE_OPERATOR, ROLE_MEDIC, boundingRole, getRole, pickSquadLeader, squadRanks } from './bot-roles.js';
import { SIDEARM_LULL_MS, outOfAllAmmo, pickSidearmId } from './bot-sidearm.js';
import { createBotSpatialHash } from './bot-spatial-hash.js';
import { clampToGarrison, createSpawnMarkerStore, garrisonSlot, spawnMarkerById } from './bot-spawn-markers.js';
import { BUSY_DRONE_SERVICE, SQUAD_DEFAULTS, SQUAD_MERGE_RADIUS, squadHaltRequest, squadMemberGoal } from './bot-squad.js';
import { STANCE_CROUCH, STANCE_DEFAULTS, STANCE_KNEEL, STANCE_STAND, chooseBotStance, resolveStanceOverride, stanceSpeedFactor, stanceTurnRateScale, stepStanceTransition, stepStanceWeights } from './bot-stance.js';
import { LATCH_COVER, LATCH_FLEE, LATCH_HEAL_FLEE } from './bot-state-code.js';
import { BOT_TERRAIN_DEFAULTS, createTerrainField } from './bot-terrain.js';
import { canFight, canHeal, woundSpeedFactor, woundTurnRateScale } from './bot-wound.js';
import { advancePath, cellToWorld, cellToWorldInto, findPath, floodFill, floodPath, isWalkableCell, lineWalkable, regionAt, smoothPath, worldToCell, worldToCellInto } from './nav-grid.js';
import { cellIndexAt } from './nav-visibility.js';
import { createRainSystem } from './rain.js';
import { getWeapon } from './weapons.js';

// Minimal Vector3 stand-in: the brain only sets, copies, adds, scales, lerps and measures.
export class Vec3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
  clone() { return new Vec3(this.x, this.y, this.z); }
  add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
  sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
  multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
  lerp(v, t) { this.x += (v.x - this.x) * t; this.y += (v.y - this.y) * t; this.z += (v.z - this.z) * t; return this; }
  length() { return Math.hypot(this.x, this.y, this.z); }
  lengthSq() { return this.x * this.x + this.y * this.y + this.z * this.z; }
  normalize() { const l = this.length() || 1; return this.multiplyScalar(1 / l); }
  distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
  distanceToSquared(v) { const dx = this.x - v.x, dy = this.y - v.y, dz = this.z - v.z; return dx * dx + dy * dy + dz * dz; }
  dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
}
const THREE = { Vector3: Vec3, MathUtils: { degToRad: (d) => d * Math.PI / 180, radToDeg: (r) => r * 180 / Math.PI, clamp: (v, a, b) => Math.max(a, Math.min(b, v)) } };
// Render-side leftovers in verbatim bodies (a debug LOS line) land here and do nothing.
const sink = new Proxy(function () {}, { get: () => sink, set: () => true, apply: () => sink });

// A bot record shaped like bot-entity.js's createBotEntity, without THREE. `spawn` is the
// ground-contact point; the brain writes velocity and yaw, and the host reads them as intent.
export function createBrainBot(id, spawn, { radius = 0.35, standHeight = 1.8, team = 'alpha' } = {}) {
  return {
    id, team, isBot: true,
    capsule: { start: new Vec3(spawn.x, spawn.y + radius, spawn.z), end: new Vec3(spawn.x, spawn.y + standHeight - radius, spawn.z), radius },
    velocity: new Vec3(), onFloor: true, yaw: 0, pitch: 0, weapon: null, tool: null, alive: true, health: 100,
  };
}

export function createBotBrain({ world, hooks = {}, settings = {} } = {}) {

  // Effects the harness does inline and the host does its own way (or not at all).
  const blastExposure = (...a) => hooks.blastExposure ? hooks.blastExposure(...a) : undefined;
  const blastRadiusFor = (...a) => hooks.blastRadiusFor ? hooks.blastRadiusFor(...a) : undefined;
  const botAirTarget = (...a) => hooks.botAirTarget ? hooks.botAirTarget(...a) : undefined;
  const botMountedBarrelRay = (...a) => hooks.botMountedBarrelRay ? hooks.botMountedBarrelRay(...a) : undefined;
  const botStateDescriptor = (...a) => hooks.botStateDescriptor ? hooks.botStateDescriptor(...a) : undefined;
  const buildRoleInsignia = (...a) => hooks.buildRoleInsignia ? hooks.buildRoleInsignia(...a) : undefined;
  const decalY = (...a) => hooks.decalY ? hooks.decalY(...a) : undefined;
  const fireBotKnife = (...a) => hooks.fireBotKnife ? hooks.fireBotKnife(...a) : undefined;
  const fireBotShot = (...a) => hooks.fireBotShot ? hooks.fireBotShot(...a) : undefined;
  const placeBotXZ = (...a) => hooks.placeBotXZ ? hooks.placeBotXZ(...a) : undefined;
  const recordBotEvent = (...a) => hooks.recordBotEvent ? hooks.recordBotEvent(...a) : undefined;
  const recordBotStateChange = (...a) => hooks.recordBotStateChange ? hooks.recordBotStateChange(...a) : undefined;
  const releaseGrenade = (...a) => hooks.releaseGrenade ? hooks.releaseGrenade(...a) : undefined;
  const removeWorldHealthPack = (...a) => hooks.removeWorldHealthPack ? hooks.removeWorldHealthPack(...a) : undefined;
  const reviveCombatBot = (...a) => hooks.reviveCombatBot ? hooks.reviveCombatBot(...a) : undefined;
  const sayBotContact = (...a) => hooks.sayBotContact ? hooks.sayBotContact(...a) : undefined;
  const sayBotLine = (...a) => hooks.sayBotLine ? hooks.sayBotLine(...a) : undefined;
  const sealBotWounds = (...a) => hooks.sealBotWounds ? hooks.sealBotWounds(...a) : undefined;
  const setBotEquippedWeapon = (...a) => hooks.setBotEquippedWeapon ? hooks.setBotEquippedWeapon(...a) : undefined;
  const tickDroneOperator = (...a) => hooks.tickDroneOperator ? hooks.tickDroneOperator(...a) : undefined;
  const traceBotStateCode = (...a) => hooks.traceBotStateCode ? hooks.traceBotStateCode(...a) : undefined;
  const updateBotVoiceState = (...a) => hooks.updateBotVoiceState ? hooks.updateBotVoiceState(...a) : undefined;
  const updateBotWeaponMount = (...a) => hooks.updateBotWeaponMount ? hooks.updateBotWeaponMount(...a) : undefined;
  const updateBotWeaponSlot = (...a) => hooks.updateBotWeaponSlot ? hooks.updateBotWeaponSlot(...a) : undefined;
  const setSquadLeaderMark = (...a) => hooks.setSquadLeaderMark ? hooks.setSquadLeaderMark(...a) : undefined;
  const refreshGrenadeThreats = (...a) => hooks.refreshGrenadeThreats ? hooks.refreshGrenadeThreats(...a) : undefined;

  // World bindings: the ground, the sight ray, and weather.
  const groundHeight = (x, z) => world.heightAt(x, z);
  const weatherSightScale = () => (world.sightScale ? world.sightScale() : 1);

  // Declarations lifted from bot-viewer-v3.html (line refs are 2026-08-27).
  // v3:647
  let commandDoubleTime = false;   // movement style toggle, orthogonal to the move/hold goal buttons
  // v3:652
  let commandBreakContact = false;
  // v3:834  (host-owned)
  let rain = null;
  // v3:849  (host-owned)
  let weather = null;
  // v3:946  (host-owned)
  let terrainSettings = null;
  // v3:951  (initialiser dropped: needs terrainPads)
  let terrainField = null;
  // v3:1113  (host-owned)
  let mapCollider = null;
  // v3:1365
  let bot = null;
  // v3:1445
  let simPreMs = 0, simSentryMs = 0, simBotMs = 0, simPostMs = 0, simSelMs = 0;
  // v3:1449
  let senAMs = 0, senBMs = 0, senCMs = 0, senDMs = 0;
  // v3:1451
  const senDByState = new Map();
  // v3:1452
  let senDTailMs = 0;
  // v3:1453
  const botActors = [];
  // v3:1455
  const botHash = createBotSpatialHash(2);
  // v3:1456
  const _hashLiving = [];              // reused rebuild input, never re-allocated
  // v3:1457
  const botActorById = new Map();      // entity/actor id -> actor, replaces the linear .find scans (M7)
  // v3:1458
  const deadBotActors = new Set();     // corpses (not in botHash) for the medic revive scan
  // v3:1461
  const squads = new Map();
  // v3:1466
  let botSquadSettings = { ...SQUAD_DEFAULTS, slotRepath: 1.0, corridorProbeMs: 300, mergeRadius: SQUAD_MERGE_RADIUS };
  // v3:1484  (host-owned)
  let spawnMarkers = null;
  // v3:1486
  let botGarrisonEnabled = true;        // a squad spawned at a marker holds it until ordered off
  // v3:1487
  const GARRISON_CHASE_SLACK = 6;       // m past the ring a garrisoned bot may chase an intruder
  // v3:1623
  let nextBotId = 1;
  // v3:1624
  let activeBotActor = null;
  // v3:1630
  let botStanceOverride = 'auto';
  // v3:1631
  let botMesh = null;
  // v3:1632
  let botProceduralBody = null;
  // v3:1983
  let botStateRecording = false;
  // v3:1986
  let botStateRecordFrameNow = 0;
  // v3:2005
  let botWeaponUiDirty = false; // per-bot reload start/finish events coalesce to one button rebuild per frame (M8)
  // v3:2014
  let botWeaponId = 'cz_805_bren';
  // v3:2015
  const BOT_RELOAD_FALLBACK_MS = 1800;
  // v3:2016
  let botReloadUntil = null;
  // v3:2017
  let botReloadWeaponId = null;
  // v3:2018
  let botAutoRefillOnReload = false;
  // v3:2019
  let botNoAmmoEnabled = false;
  // v3:2020
  let botKnifeSecondaryEnabled = true;
  // v3:2021
  let botSidearmEnabled = true; // every bot carries a pistol behind its primary (bot-sidearm.js)
  // v3:2022
  let botMovementSettings = {
    turnStiffness: 30,
    turnDamping: 10,
    maxForwardLead: 0.32,
    // Which GAIT_MODELS entry the rig's speed->gait fit comes from, for A/B against the shipped one.
    gaitModel: 'shipped',
    // Fraction of a swing's hip travel the feet aim ahead by. 0 is the shipped behaviour.
    stepLeadScale: 0,
    workspaceWidthScale: 1,
    workspaceForwardScale: 1,
    bobScale: 1,
    swayScale: 1,
    bodyFollowRate: 11,
    runMultiplier: 1.7,
    // Cyclic locomotion layer (body-locomotion.js): stride phase locked to real footfalls drives
    // arm swing, hip roll/yaw, counter-rotating shoulders, ankle roll-through and a continuous bob.
    locoEnabled: 1,
    locoAmount: 1,        // scales every cyclic amplitude at once, for A/B against the old look
    stepOverlap: 0.22,    // how much of a swing may overlap the next foot's lift; 0 = strict alternation
    spineFalloff: 1,      // how the twist spreads up the spine: >1 keeps it in the chest
  }
  // v3:2046
  let botStanceSettings = { ...STANCE_DEFAULTS, kneelEnabled: true };
  // v3:2361
  const _slotCtx = { active: 'primary', hasSidearm: false, swapping: false, inGunfight: false, quietMs: Infinity,
    primary: null, sidearm: null, swapOnDryMag: true, closeRange: 0, targetDist: Infinity }
  // v3:2363
  const _ammoFlags = { autoRefill: false, noAmmo: false };
  // v3:2504
  let botWeaponMount = null;
  // v3:2505
  let botWeaponMountToken = 0;
  // v3:3377
  const _frameEnemyTeams = [];
  // v3:3378
  const _frameEnemyArrays = [];
  // v3:3379
  const _emptyEnemyList = [];
  // v3:3380
  let botFrameCounter = 0; // drives the staggered target re-scan in selectBotTarget
  // v3:3385
  let botThinkStaggerMode = 'auto'; // 'auto' | 1 | 2 | 3; ?stagger=auto|1|2|3 overrides (A/B runs)
  // v3:3413  (initialiser dropped: needs URLSearchParams, location)
  let BOT_CONFIRM_STRIDE = null;
  // v3:3500
  const botDiag = {
    targetPickBest: 0,               // acquired an enemy it can actually see
    targetPickRetained: 0,           // kept an occluded but living target (intended)
    targetPickFallbackSuppressed: 0, // P1: old code handed out the shared array-order enemy here
    targetPickNone: 0,               // P1 fixed: holds nothing, re-scans next frame
    patrolNoRoute: 0,                // P2: no patrol point shares this bot's nav region
    patrolLocalFallback: 0,          // P2 fixed: walked to an in-region goal instead of freezing
    patrolIsolated: 0,               // P2 residue: no in-region goal either, genuinely sealed in
    patrolEscaped: 0,                // escape hatch found a real route out of the pocket
    patrolStranded: 0,               // ...and how many bots it PROVED cannot leave (symptom, not fix)
    squadHoldBroken: 0,              // followers that gave up holding a slot behind a motionless leader
    targetRetentionExpired: 0,       // living-but-long-unseen targets dropped so the bot can re-acquire
    knifeOutOfReach: 0,              // P3: knife committed with the target far beyond blade range
    knifeReloadUnblocked: 0,         // P3 fixed: reloaded while holding the knife (was impossible)
    knifeTimeout: 0,                 // P3 fixed: knife commit abandoned after the cap
  }
  // v3:5164
  const PERCEIVED_ENEMY_MAX = 8; // in-cone candidates whose identities survive the scan
  // v3:5550  (host-owned)
  let dummyTargets = null;
  // v3:5561
  const DUMMY_MAX_HEALTH = 100;
  // v3:5807
  const worldHealthPacks = []; // { group, x, z, pack:{charge01}, seq, droppedAt, capsule }
  // v3:5812
  const packHash = createBotSpatialHash(8);
  // v3:5813
  let packHashDirty = true;
  // v3:6020
  const _packEye = new THREE.Vector3();
  // v3:6037
  const _packSeekCell = { c: 0, r: 0 };
  // v3:6038
  let _psBot = null, _psHurt = false, _psBest = null; // hash-visit scratch, consumed per call
  // v3:6039
  let _psNow = 0, _psTeam = null, _psDanger = false;  // H3 danger read: hoisted per call, not per pack
  // v3:6067
  const _puNear = []; // in-radius candidates, drained per call
  // v3:6068
  let _puX = 0, _puZ = 0;
  // v3:6095
  const recentAllyHits = []; // { victimId, team, x, z, threat:{x,z}, at, lethal, kind? }
  // v3:6101
  let allyRingVersion = 0;
  // v3:6102
  const _allyAgg = { version: -1, casualties: [], contacts: [], nearMisses: [], nonContacts: [] };
  // v3:6168
  const _alertMe = { id: null, team: null, x: 0, z: 0 }; // scratch: latestAlertNear reads it synchronously
  // v3:6176
  let _saMe = null, _saNow = 0, _saPx = 0, _saPz = 0, _saBest = null;
  // v3:6192
  let _ltMe = null, _ltRadius = 0, _ltPx = 0, _ltPz = 0, _ltCount = 0;
  // v3:6206
  const _sqMembers = [];
  // v3:6229
  const PUSH_HOLD_LEASE_MS = 500;
  // v3:6267
  const _haltMembers = [];
  // v3:6882
  const _selOrigin = new THREE.Vector3();
  // v3:6883
  const _selTargetEye = new THREE.Vector3();
  // v3:6884
  const _selCandidates = [];  // reusable candidate buffer (parallel arrays) -- nearest-first until the
  // v3:6885
  const _selCandidateDistSq = [];  // risk sort below reorders it in place for the raycast-and-pick loop
  // v3:6886
  const _selRisk = [];
  // v3:6887
  const _selContactXZ = { x: 0, z: 0 }; // scratch out-param for contact-memory position writes
  // v3:6888
  const _selSeenIds = new Set();        // scratch: this scan's confirmed-sighting id set
  // v3:6889
  const TARGET_SCAN_STRIDE = 4; // frames between full candidate re-scans per bot
  // v3:6890
  const TARGET_STICK_RISK_MARGIN = 1.3; // newcomer needs >=30% more risk to steal a visible target
  // v3:6894
  const TARGET_COMMIT_MIN_MS = 1500;
  // v3:6898
  const TARGET_DANGER_SELF_BONUS = 2.5;  // this candidate is shooting ME (latestSelfThreat.attackerId)
  // v3:6899
  const TARGET_DANGER_ALLY_BONUS = 1.2;  // this candidate is shooting a teammate near me (latestAllyHitNear)
  // v3:6903
  const TARGET_PILE_ON_STEP = 0.25;   // ally-danger discount per squadmate already committed to that attacker
  // v3:6904
  const TARGET_PILE_ON_FLOOR = 0.4;   // never discount below this -- someone still has to answer the shooter
  // v3:7136
  const EYE_LIFT = 0.85; // fraction up the capsule used as eye/muzzle height, both bot and dummy
  // v3:7137
  let botState = BOT_PATROL;
  // v3:7138
  let botTargetVisible = false;
  // v3:7139
  let botTargetDistance = Infinity; // 3D eye-to-eye distance the ladder actually branches on
  // v3:7140
  let botTargetVisGate = '-';       // which gate resolved sight: y=visible w=wall f=outside FOV r=beyond sight -=no target
  // v3:7141
  let lastShotAt = -Infinity;
  // v3:7143
  let botAimTarget = { yaw: 0, pitch: 0 };
  // v3:7144
  let botAimPoint = new THREE.Vector3();
  // v3:7145
  let botHasAimPoint = false;
  // v3:7156
  let USE_FIELD_LOS_PREFILTER = true; // skip LOS raycasts when the baked field says hidden; pure prune (the field errs toward visible)
  // v3:7157
  const INVESTIGATE_LOS_BONUS = 0.25; // frontier-ordering bump for cells that can see the last-known cell
  // v3:7167
  let botBlockedShotStreak = 0;
  // v3:7168
  let botMissStreak = 0; // consecutive fired shots that didn't hit the target; drives pursue-on-miss
  // v3:7169
  const MISS_STREAK_SIGHT_RESET_MS = 1500; // sight lost this long: the streak is about an engagement that ended
  // v3:7170
  const KNIFE_COMMIT_MAX_MS = 8000;        // longest a knife charge may run before it is abandoned
  // v3:7171
  const KNIFE_COMMIT_COOLDOWN_MS = 5000;   // and how long before the same bot may commit again
  // v3:7172
  const SQUAD_HOLD_MAX_MS = 12000;         // longest a follower holds a slot before doing its own thing
  // v3:7173
  const TARGET_RETAIN_MAX_MS = 6000;       // longest an unseen but living target is held before re-acquiring
  // v3:7174
  let botCombatStandoff = 5.0; // per-tick weapon-derived preferred fighting distance (see botWeaponStandoff)
  // v3:7175
  let botMuzzleRecoveryTarget = null;
  // v3:7176
  let botRecoveryIssueActive = false;
  // v3:7177
  let botMuzzleRecoveryVisitedCells = new Set();
  // v3:7595
  const DECK_CLEARANCE = 0.75;
  // v3:7613
  const _xzScratchA = { x: 0, z: 0 };
  // v3:7614
  const _sentryEye = new THREE.Vector3();
  // v3:7615
  const _sentryTargetEye = new THREE.Vector3();
  // v3:7616
  const _leadAimPoint = new THREE.Vector3();   // aim point once the target's motion is led
  // v3:7617
  const _sentryDir = new THREE.Vector3();
  // v3:7618
  const _fireEye = new THREE.Vector3();
  // v3:7619
  const _aimAngles = { yaw: 0, pitch: 0 };
  // v3:7620
  const _packCell = { c: 0, r: 0 };
  // v3:7621
  const _escMe = { x: 0, z: 0, team: null };
  // v3:7622
  const _coverThreatXZ = { x: 0, z: 0 };
  // v3:7623
  const _botHereXZ = { x: 0, z: 0 };
  // v3:7624
  const _holdSeatXZ = { x: 0, z: 0 };
  // v3:7625
  const _alertBake = { field: null, navGrid: null }; // reused wrapper for exposedToThreat's bake argument
  // v3:7626
  const _tierChannels = { coverAlert: null, holdAlert: null }; // reused out-param for alertTierChannels
  // v3:7627
  const _contactMe = { id: null, team: null, x: 0, z: 0 }; // scratch reporter/reader for recordContact + latestContactNear
  // v3:7628
  const _spinAt = new THREE.Vector3();  // H6a scratch aim point for the close-self-threat spin
  // v3:7629
  const _topOff = { magFrac: 0, targetVisible: false, concealed: false }; // A9 shouldTopOffReload argument
  // v3:7630
  const _secondaryXZ = { x: 0, z: 0 };  // H6b second-shooter position handed to the cover veto
  // v3:7631
  const _hideRC = { c: 0, r: 0 };       // S12 concealment ring-scan centre cell
  // v3:7632
  const _hideXZ = { x: 0, z: 0 };       // S12 concealment goal, consumed by updateMedicMoveMovement
  // v3:7633
  const _fsmCtx = {};
  // v3:7634
  const _stanceCtx = {};                // chooseBotStance argument, refilled per bot per frame
  // v3:7635
  const _dangerNb = new Int32Array(8); // cellNeighbors8 out-param, consumed inside one recordDanger call
  // v3:7636
  const _fleeScore = { threatDistance: 0, pathDist: 0, covered: false, exposure01: 0, centroidDistance: null, coverScore: 0 };
  // v3:7637
  const _fleeSquad = []; // living teammates near the flee source, drained per findFleeGoal call
  // v3:7638
  let _fsqTeam = null, _fsqId = null, _fsqX = 0, _fsqZ = 0; // _fleeSquad hash-visit scratch
  // v3:7651
  const NAV_CELL = 0.5;
  // v3:7701  (host-owned)
  let navGrid = null;
  // v3:7702  (host-owned)
  let visField = null;
  // v3:7703  (host-owned)
  let cornerMap = null;
  // v3:7705
  const goalClaims = createGoalClaims((id) => { const a = botActorById.get(id); return !!a && a.entity.alive !== false; });
  // v3:7707
  const botDangerField = createDangerField();
  // v3:8179
  let BOT_MOVE_SPEED = 2.4;
  // v3:8180
  const WAYPOINT_REACH = 0.35;
  // v3:8181
  const SEPARATION_RADIUS = 1.5; // m, neighbors inside this repel during path-following
  // v3:8182
  const SEPARATION_WEIGHT = 0.5; // blend factor of the separation force into the move direction
  // v3:8183
  const SEPARATION_PROBE_M = 0.45;    // m, look-ahead for the separation walkability gate
  // v3:8184
  const WAYPOINT_CONTEST_RANGE = 0.75; // m, neighbor distance that counts as blocking the waypoint
  // v3:8185
  const WAYPOINT_CONTEST_RELAX = 0.45; // m, extra reach allowed when the waypoint is crowd-blocked
  // v3:8186
  const NAV_REPATH_COOLDOWN_MS = 350;  // throttle for followPath's off-line recovery re-path
  // v3:8187
  const SMOOTH_LOOKAHEAD = 16;         // waypoint cap on smoothPath's string-pull, bounds its O(k^2) DDA retraces (M3)
  // v3:8188
  const PATROL_STALL_DIST_M = 0.35;    // net progress below this counts as stalled
  // v3:8189
  const PATROL_STALL_GIVEUP_MS = 2500; // stalled this long -> abandon the leg for the next goal
  // v3:8190
  const COVER_SEARCH_RADIUS = 10;    // m, corner candidate radius around the bot
  // v3:8191
  const ALLY_ALERT_RADIUS = 12;      // m, an ally hit within this recently triggers a cover break / alert hold
  // v3:8254
  let botBehaviorSettings = {
    pursueDistance: 7.0,
    pursueExitBuffer: 0.6,
    pursueMissStreak: 3, // fire this many non-hitting shots in a row before deciding to close distance
    pursueHealthThreshold01: 0.60, // only pursue (close distance / chase lost target) while above this HP fraction
    preferredCombatDistance: 5.0, // fallback standoff; live value is weapon-derived (see botWeaponStandoff)
    standoffFactor: 0.09, // preferred standoff = weapon.range * this, clamped to sight range; 0 = no weapon linking
    fleeStandoffFraction: 0.5, // kite/back-off trigger = standoff * this (near edge of the fire band)
    fleeDistance: 2.2, // floor for the weapon-derived kite/back-off trigger
    fleeExitBuffer: 0.6,
    knifeEngagementDistance: 8.0,
    sightDistance: 50,
    fovDegrees: 150, // horizontal vision cone centered on bot.yaw; 360 = omnidirectional (no blind spot)
    fleeSearchRadius: 5,
    fleeGoalMemory: 3,
  }
  // v3:8273
  let botAimSettings = { ...AIM_DEFAULTS };
  // v3:8276
  const botAimBlend = { ...AIM_BLEND_DEFAULTS };
  // v3:8277
  let botHealthSettings = {
    retreatEnabled: true,
    threshold01: 0.60,
    resume01: 0.72,
    healPerSecond: 18,
    safeDistance: 8.5,
    safeHoldMs: 500,
    retreatSearchRadius: 10,
    coverScore: 12,
  }
  // v3:8287
  let botPackSettings = {
    pickupRadius: 0.7,      // walk within this of a dropped pack to auto-collect it
    shortProximity: 4.0,    // a healthy bot only detours for a pack this close; a hurt bot ignores this
    dropScatter: 0.45,      // horizontal spread of packs dropped by a dying bot
    pickupCrouchMs: 450,    // brief crouch dip when a bot bends down to grab a pack
  }
  // v3:8310
  let botMedicSettings = {
    healAllyPerSecond: 22,   // HP/s a medic transfers from its packs into a wounded ally
    reviveChannelMs: 2500,   // how long the medic must tend a corpse before it stands back up
    reviveHp: 50,            // HP a revived ally comes back with
    healHoldRadius: 6.0,     // once a medic is this close, its heal target holds position so it can close/channel
    healHoldLeaseMs: 500,    // how long a heal-hold lasts without refresh (so the ally resumes when the medic leaves)
    medicClaimLeaseMs: 700,  // how long a medic's claim on a patient lasts without refresh (spreads medics out)
  }
  // v3:8320
  const MEDIC_TEND_COMBAT_MS = 5000;
  // v3:8321
  let botInvestigationSettings = {
    durationMs: 12000,
    initialRadius: 1.25,
    // A7: was 0.55 m/s against a 3.5-4 m/s target -- the bubble was cleared long after the target had
    // left it. maxRadius keeps the fast bubble from swallowing the map (and the seeding BFS with it).
    expansionMetresPerSecond: 2.5,
    maxRadius: 12,
  }
  // v3:8329
  let botCombatMoveGoal = null;
  // v3:8330
  let botFleeGoalHistory = [];
  // v3:8356
  let botInvestigation = null;
  // v3:8358  (host-owned)
  let patrolPoints = null;
  // v3:8359
  let patrolIdx = 0;
  // v3:8360
  let currentPath = [];      // waypoint queue for whichever movement mode is active
  // v3:8361
  let pathMode = null;       // 'patrol' | 'seek' | null
  // v3:8362
  let lastKnownTarget = null; // {x,z} last position the target was seen at, or null
  // v3:8363
  let lastKnownTargetMotion = null; // normalized XZ direction while last visible
  // v3:8364
  let lastKnownTargetAt = null; // animation timestamp of that observation
  // v3:8365
  let botPatrolResumeGoal = null; // {x,z,index}, selected when combat investigation ends
  // v3:8366
  let botHealRequested = false;
  // v3:8367
  let botHealArrived = false;
  // v3:8368
  let botHealSafetySince = null;
  // v3:8369
  let botHealThreatId = null;
  // v3:8370
  let botHealStartedAt = null;
  // v3:8371
  let botPatrolTravelHeading = { x: 0, z: 1 };
  // v3:8372
  let botTarget = null;
  // v3:8373
  let lastKnifeAt = -Infinity;
  // v3:8582
  const _fpXZ = { x: 0, z: 0 };       // followPath scratch: consumed within one followPath call
  // v3:8583
  const _fpOwnCell = { c: 0, r: 0 };
  // v3:8584
  const _navAheadCell = { c: 0, r: 0 };
  // v3:8586
  let _fpEntity = null, _fpLegNext = null, _fpLegOk = false;
  // v3:8587
  const _fpContested = (wp, dist) => waypointContestedHashed(_fpEntity, botHash, wp, dist, WAYPOINT_CONTEST_RANGE);
  // v3:8589
  const _fpNextLeg = (from, next) => {
    if (_fpLegNext !== next) { _fpLegNext = next; _fpLegOk = lineWalkable(navGrid, from, next); }
    return _fpLegOk;
  }
  // v3:8594
  const _fpOpts = { relaxRadius: WAYPOINT_CONTEST_RELAX, contested: _fpContested, canSkipTo: null };
  // v3:8641
  const SLOPE_SPEED_CLIMB = 0.55;   // fraction of speed lost per unit of uphill grade
  // v3:8642
  const SLOPE_SPEED_DESCENT = 0.12; // ... gained per unit of downhill grade
  // v3:8669
  const REPLAN_COOLDOWN_MS = 300;      // per-entity floor between goal re-paths
  // v3:8670
  const REPLAN_BUDGET_PER_FRAME = 8;   // global A* searches served per frame (reset in updateAllBots)
  // v3:8671
  const FLEE_SEARCH_BACKOFF_MS = 400;  // latch after a failed non-heal findFleeGoal (it has no arrival latch)
  // v3:8672
  const FLEE_SQUAD_RADIUS = 16;        // m; living teammates inside this define the S9 centroid pull
  // v3:8673
  const COVER_PROBE_BACKOFF_MS = 250;  // latch after a cover-corner probe finds nothing (M2)
  // v3:8674
  let replanBudgetLeft = REPLAN_BUDGET_PER_FRAME;
  // v3:8712
  const INVEST_NB_DC = [1, -1, 0, 0, 1, 1, -1, -1];
  // v3:8713
  const INVEST_NB_DR = [0, 0, 1, -1, 1, -1, 1, -1];
  // v3:8963
  const PATROL_LOCAL_MIN_M = 4;   // far enough that the fallback is a real leg, not a shuffle
  // v3:8964
  const _patrolLocalProbe = { x: 0, z: 0 };   // scratch for the in-region cell sweep
  // v3:8999
  const PATROL_ESCAPE_MS = 6000;      // orbiting this long without a target before trying to leave
  // v3:9000
  const PATROL_ESCAPE_RETRY_MS = 8000; // and how often to re-try after a failure
  // v3:9105
  const PATROL_RESUME_REPLAN_COST = 4;
  // v3:9372
  const _pursuitTargetXZ = { x: 0, z: 0 };
  // v3:9373
  const _pursuitSelfXZ = { x: 0, z: 0 };
  // v3:9374
  const PINCER_OFFSETS = pincerOffsets();
  // v3:9603
  let botGrenadesEnabled = true;
  // v3:9604
  let botGrenadeSettings = { ...GRENADE_DEFAULTS };
  // v3:9623
  const GRENADE_WINDUP_MS = 420;          // wind-up before release; the bot is frozen and facing the throw
  // v3:9624
  const GRENADE_DECIDE_INTERVAL_MS = 500; // per-bot throttle on the (roster-scanning) throw decision
  // v3:9625
  const GRENADE_EVADE_REPLAN_MS = 400;
  // v3:9626
  const teamLastGrenadeAt = new Map();     // team -> ms, feeds the squad-wide volley cooldown
  // v3:9627
  const _grenadeEnemies = [], _grenadeAllies = [], _grenadeThreats = [];
  // v3:9628
  const _grenadeOrigin = new THREE.Vector3();
  // v3:9629
  const _grenadeFrom = [0, 0, 0];
  // v3:9640
  const _grenadeAimPoint = new THREE.Vector3();
  // v3:9641
  const _grenadeRoughAimArr = [0, 0, 0];
  // v3:9863
  const EVADE_SHADOW_BONUS = 9;        // cell is out of the blast's line at all
  // v3:9864
  const EVADE_DEPTH_BONUS = 2.6;       // per probe direction that is ALSO hidden (0..4)
  // v3:9865
  const EVADE_EXPOSURE_PENALTY = 7;    // cell is visible to the threat this bot is fighting
  // v3:9866
  const EVADE_TRAVEL_WEIGHT = 0.35;    // straight-line cost of getting there
  // v3:9867
  const EVADE_EDGE_PENALTY = 1.2;      // per metre of shortfall inside the clearance margin
  // v3:9868
  const EVADE_CLEAR_MARGIN = 2.5;      // m past the blast ring that counts as properly clear
  // v3:9869
  const EVADE_NOISE = 1.5;             // jitter amplitude, deterministic per bot + cell
  // v3:9870
  const EVADE_SEARCH_CELLS = 12;       // half-width of the scan box (6 m at a 0.5 m cell)
  // v3:9871
  const EVADE_SEARCH_STRIDE = 2;       // sample every Nth cell: 1 m granularity is plenty to hide in
  // v3:9872
  const EVADE_PROBE_CELLS = 3;         // how far the shadow-depth probes reach (1.5 m)
  // v3:9873
  const EVADE_PROBE_DIRS = [[EVADE_PROBE_CELLS, 0], [-EVADE_PROBE_CELLS, 0], [0, EVADE_PROBE_CELLS], [0, -EVADE_PROBE_CELLS]];
  // v3:9874
  const _evadeFrom = { x: 0, z: 0 }, _evadeCand = { x: 0, z: 0 }, _evadeStart = { c: 0, r: 0 };
  // v3:9949
  const GRENADE_EVADE_POSE_LINGER_MS = 600;
  // v3:9950
  const GRENADE_GOAL_REACH = 0.8;   // m from the chosen cell that counts as arrived
  // v3:9951
  const _grenadeSelf = [0, 0, 0];
  // v3:10313
  const SECONDARY_THREAT_MIN_SEPARATION = 3; // m from the primary before a second contact is a second shooter
  // v3:10314
  const _secEye = new THREE.Vector3();
  // v3:10315
  const _secTargetEye = new THREE.Vector3();
  // v3:10343
  const COVER_GROUP_RADIUS = 8;       // m between holders that still counts as one cover group
  // v3:10344
  const COVER_GROUP_THREAT_EPS = 3;   // m of threat-position slop that still counts as the same shooter
  // v3:10345
  let _giActor = null, _giTeam = null, _giX = 0, _giZ = 0, _giTx = 0, _giTz = 0, _giCount = 0;
  // v3:10467  (initialiser dropped: needs THREE.*)
  let losMat = sink;
  // v3:10468  (initialiser dropped: needs THREE.*)
  let losGeom = sink;
  // v3:10469  (initialiser dropped: needs THREE.*)
  let losLine = sink;
  // v3:10516
  const MEDIC_NAV_FLOOD_MS = 200;
  // v3:10557
  let _mdActor = null, _mdNow = 0, _mdSx = 0, _mdSz = 0, _mdRespSq = 0, _mdTeam = null, _mdAllies = null;
  // v3:10558
  let _mdSquadId = null;   // the medic's own roster, so its squad's casualties outrank a stranger's
  // v3:10764
  let _mcActor = null, _mcTeam = null, _mcOut = null;
  // v3:10773
  const _squadSelfXZ = { x: 0, z: 0 };
  // v3:10861
  const COMMAND_ARRIVE_M = 1.0;
  // v3:10862
  let commandTargetId = null;
  // v3:10863
  let commandGoal = null;
  // v3:10864
  let commandGoalState = 'move';   // 'move' | 'hold'
  // v3:10897
  const GARRISON_ARRIVE_M = 1.2;
  // v3:10898
  const _garrisonSlot = { x: 0, z: 0 };
  // v3:11011
  const AIM_PRIMED_WINDOW_MS = 4000;
  // v3:11012
  const AIM_UNDER_FIRE_MS = 4000;
  // v3:12852
  let botDroneSettings = {
    enabled: true,
    bomberAlt: DRONE_DEFS[DRONE_BOMBER].cruiseAlt,
    loiterAlt: DRONE_DEFS[DRONE_LOITER].cruiseAlt,
    speed: DRONE_DEFS[DRONE_BOMBER].speed,
    bombs: DRONE_DEFS[DRONE_BOMBER].bombs,
    reloadS: DRONE_DEFS[DRONE_BOMBER].reloadS,
    bombDamage: DRONE_DEFS[DRONE_BOMBER].damage,
    bombBlast: DRONE_DEFS[DRONE_BOMBER].blastRadius,
    loiterStock: OPERATOR_DEFAULTS.loiterStock,
    loiterLife: DRONE_DEFS[DRONE_LOITER].life,
    diveDamage: DRONE_DEFS[DRONE_LOITER].damage,
    diveBlast: DRONE_DEFS[DRONE_LOITER].blastRadius,
    bomberCooldownMs: OPERATOR_DEFAULTS.bomberCooldownMs,
    loiterCooldownMs: OPERATOR_DEFAULTS.loiterCooldownMs,
    hoverDropSpeedGate: DRONE_DEFS[DRONE_BOMBER].hoverDropSpeedGate,
    hoverDropAlt: DRONE_DEFS[DRONE_BOMBER].hoverDropAlt,
    aloftMax: OPERATOR_DEFAULTS.aloftMax,
    bomberHp: DRONE_DEFS[DRONE_BOMBER].hp,
    loiterHp: DRONE_DEFS[DRONE_LOITER].hp,
    airEngageRange: 35,    // how far a bot on the ground will shoot at a drone
    airNoticeMs: 500,      // how long it takes a bot to react to one overhead
    bomberReplacements: 1, // spare bomb drones per operator, after which losing it is permanent
    deadstickChance: 0.34, // odds a shot-down drone stops being flown rather than coming apart
    deadstickWild: 0.5,    // of those, the share that flies off out of control rather than dropping
    threatFleeShare: 0.6,  // of bots caught under a committed drone, the share that runs rather than shoots
    scanRadius: 45,        // how far a drone's own camera reaches once it is airborne
    seedRadius: 12,        // how far from the operator's target a bombing cluster may be gathered
    meshScale: 1,
  }
  // v3:13079
  const DRONE_SERVICE_LEASE_MS = 300;   // re-granted every frame the drone is in his hands

  function configure(patch) { for (const [k, v] of Object.entries(patch)) { if (k in setters) setters[k](v); else throw new Error(`bot-brain configure: unknown key ${k}`); } }
  const setters = {
    BOT_CONFIRM_STRIDE: (v) => { BOT_CONFIRM_STRIDE = v; },
    BOT_MOVE_SPEED: (v) => { BOT_MOVE_SPEED = v; },
    USE_FIELD_LOS_PREFILTER: (v) => { USE_FIELD_LOS_PREFILTER = v; },
    botAimSettings: (v) => { botAimSettings = { ...botAimSettings, ...v }; },
    botAutoRefillOnReload: (v) => { botAutoRefillOnReload = v; },
    botBehaviorSettings: (v) => { botBehaviorSettings = v; },
    botDroneSettings: (v) => { botDroneSettings = v; },
    botGrenadeSettings: (v) => { botGrenadeSettings = v; },
    botGrenadesEnabled: (v) => { botGrenadesEnabled = v; },
    botHealthSettings: (v) => { botHealthSettings = v; },
    botInvestigationSettings: (v) => { botInvestigationSettings = v; },
    botMedicSettings: (v) => { botMedicSettings = v; },
    botMovementSettings: (v) => { botMovementSettings = v; },
    botNoAmmoEnabled: (v) => { botNoAmmoEnabled = v; },
    botPackSettings: (v) => { botPackSettings = v; },
    botSidearmEnabled: (v) => { botSidearmEnabled = v; },
    botSquadSettings: (v) => { botSquadSettings = v; },
    botStanceSettings: (v) => { botStanceSettings = v; },
    cornerMap: (v) => { cornerMap = v; },
    dummyTargets: (v) => { dummyTargets = v; },
    losGeom: (v) => { losGeom = v; },
    losLine: (v) => { losLine = v; },
    losMat: (v) => { losMat = v; },
    mapCollider: (v) => { mapCollider = v; },
    navGrid: (v) => { navGrid = v; },
    patrolPoints: (v) => { patrolPoints = v; },
    rain: (v) => { rain = v; },
    spawnMarkers: (v) => { spawnMarkers = v; },
    terrainField: (v) => { terrainField = v; },
    terrainSettings: (v) => { terrainSettings = v; },
    visField: (v) => { visField = v; },
    weather: (v) => { weather = v; },
  };
  configure(settings);

  // Host-owned entities that are not brain bots (players): targets and threats, never actors.
  let worldEntities = [];

  // v3:2273
  function currentBotWeapon() {
    return getWeapon(bot?.weapon || botWeaponId) || getWeapon('cz_805_bren');
  }

  // v3:2281
  function botWeaponStandoff(weapon) {
    const range = weapon?.range ?? 100;
    const maxStandoff = Math.max(4, botSightDistance() - 4);
    const scale = getRole(activeBotActor?.role).standoffScale;
    return Math.min(maxStandoff, Math.max(4, range * botBehaviorSettings.standoffFactor * scale));
  }

  // v3:2290
  function botSightDistanceFor(actor) {
    return botBehaviorSettings.sightDistance * getRole(actor?.role).sightScale * weatherSightScale();
  }

  // v3:2293
  function botSightDistance() { return botSightDistanceFor(activeBotActor); }

  // v3:2333
  function sidearmForRole(roleId, primaryId, seed) {
    const named = getRole(roleId).sidearm;
    if (named && named !== primaryId) return named;
    return pickSidearmId(primaryId, seed);
  }

  // v3:2341
  function botHasSidearm() { return botSidearmEnabled && !!bot?.sidearm; }

  // v3:2342
  function botOnSidearm() { return !!bot?.sidearm && bot.weapon === bot.sidearm; }

  // v3:2343
  function botSwapping(now) { return (activeBotActor?.swapUntil ?? 0) > now; }

  // v3:2396
  function botOutOfAllAmmo() {
    _ammoFlags.autoRefill = botAutoRefillOnReload;
    _ammoFlags.noAmmo = botNoAmmoEnabled;
    const onSidearm = botOnSidearm();
    return outOfAllAmmo({
      active: ensureBotAmmo(bot.weapon),
      other: ensureBotAmmo(onSidearm ? (bot.primaryWeapon ?? bot.weapon) : (bot.sidearm ?? bot.weapon)),
      hasSidearm: botHasSidearm(),
    }, _ammoFlags);
  }

  // v3:2414
  function defaultBotAmmoFor(weapon = currentBotWeapon()) {
    const magazineSize = Math.max(0, Math.round(weapon?.magazineSize ?? 0));
    return botNoAmmoEnabled ? { mag: 0, reserve: 0, magazineSize } : { mag: magazineSize, reserve: Math.max(0, Math.round(weapon?.reserveAmmo ?? 0)), magazineSize };
  }

  // v3:2418
  function ensureBotAmmo(weaponId = bot?.weapon || botWeaponId) {
    if (!bot) return defaultBotAmmoFor(getWeapon(weaponId));
    bot.ammoByWeapon ??= new Map();
    let ammo = bot.ammoByWeapon.get(weaponId);
    if (!ammo) {
      ammo = defaultBotAmmoFor(getWeapon(weaponId));
      bot.ammoByWeapon.set(weaponId, ammo);
    }
    return ammo;
  }

  // v3:2428
  function reloadBotWeapon(now = performance.now()) {
    // Knife no longer blocks a reload: it was one half of a deadlock -- knife is entered only when dry,
    // and a dry bot could never refill while holding it, so the state was permanent. bot.weapon is still
    // the gun slot (the knife is only what's equipped), so this reloads the firearm as normal.
    if (!bot || botReloadUntil != null || botNoAmmoEnabled) return false;
    if (botState === BOT_KNIFE) botDiag.knifeReloadUnblocked++;
    if (botSwapping(now)) return false; // hands are busy drawing the other gun
    const ammo = ensureBotAmmo();
    if (ammo.mag >= ammo.magazineSize || (!botAutoRefillOnReload && ammo.reserve <= 0)) return false;
    const sequence = botWeaponMount?.weaponId === bot.weapon ? botWeaponMount.reloadSequence : null;
    const durationMs = Math.max(1, Math.round((sequence?.duration ?? BOT_RELOAD_FALLBACK_MS / 1000) * 1000));
    botReloadUntil = now + durationMs;
    botReloadWeaponId = bot.weapon;
    if (sequence) botWeaponMount.controller.play('reload');
    botWeaponUiDirty = true;
    sayBotLine(bot, activeBotActor, 'reloading', now);
    return true;
  }

  // v3:2446
  function updateBotReload(now, suppressStart = false) {
    if (!bot) return;
    if (botReloadUntil != null && now >= botReloadUntil) {
      const ammo = ensureBotAmmo(botReloadWeaponId);
      if (botAutoRefillOnReload) {
        ammo.mag = ammo.magazineSize;
      } else {
        const moved = Math.min(ammo.magazineSize - ammo.mag, ammo.reserve);
        ammo.mag += moved;
        ammo.reserve -= moved;
      }
      botReloadUntil = null;
      botReloadWeaponId = null;
      botWeaponUiDirty = true;
    }
    if (!suppressStart && botReloadUntil == null) {
      const ammo = ensureBotAmmo();
      if (ammo.mag <= 0 && (botAutoRefillOnReload || ammo.reserve > 0)) reloadBotWeapon(now);
    }
  }

  // v3:2916
  function combatEntityById(id) {
    const dummyTarget = dummyTargets.find((target) => target.id === id) || worldEntities.find((target) => target.id === id);
    return dummyTarget || botActorById.get(id)?.entity || null;
  }

  // v3:3493
  function botThinkStride(livingCount) {
    if (botThinkStaggerMode !== 'auto') return botThinkStaggerMode;
    return livingCount > 80 ? 3 : livingCount > 40 ? 2 : 1;
  }

  // v3:3612
  function frameEnemyList(team) {
    for (let i = 0; i < _frameEnemyTeams.length; i++) if (_frameEnemyTeams[i] === team) return _frameEnemyArrays[i];
    return _emptyEnemyList;
  }

  // v3:3616
  function rebuildFrameEnemyLists() {
    for (let i = 0; i < _frameEnemyArrays.length; i++) _frameEnemyArrays[i].length = 0;
    for (const actor of botActors) {
      // Seed from every actor (dead ones too) so a revived bot's team bucket always exists.
      if (frameEnemyList(actor.entity.team) === _emptyEnemyList) { _frameEnemyTeams.push(actor.entity.team); _frameEnemyArrays.push([]); }
    }
    for (let i = 0; i < _frameEnemyArrays.length; i++) {
      for (const target of dummyTargets) if (target.alive) _frameEnemyArrays[i].push(target);
      for (const target of worldEntities) if (target.alive && target.team !== _frameEnemyTeams[i]) _frameEnemyArrays[i].push(target);
    }
    for (const actor of botActors) {
      const entity = actor.entity;
      if (entity.alive === false) continue;
      for (let i = 0; i < _frameEnemyArrays.length; i++) if (_frameEnemyTeams[i] !== entity.team) _frameEnemyArrays[i].push(entity);
    }
  }

  // v3:3633
  function rebuildBotHash() {
    _hashLiving.length = 0;
    for (const actor of botActors) {
      if (actor.entity.alive === false || actor.ragdoll) continue;
      _hashLiving.push(actor.entity);
    }
    botHash.rebuild(_hashLiving);
    return _hashLiving;
  }

  // v3:5636
  function invalidateTargetMemoryAfterDeath(target, now) {
    if (!target) return;
    for (const observer of botActors) {
      const isActiveObserver = observer === activeBotActor && botTarget?.id === target.id;
      if (observer.entity.alive === false || (!isActiveObserver && observer.target?.id !== target.id)) continue;
      observer.target = null;
      observer.lastKnownTarget = null;
      observer.lastKnownTargetMotion = null;
      observer.lastKnownTargetAt = null;
      observer.investigation = null;
      goalClaims.release(observer.id, 'seek'); // unbound observers never reach finishInvestigation
      observer.path = [];
      observer.pathMode = null;
      observer.combatMoveGoal = null;
      recordBotEvent(observer, `target eliminated: ${target.id}`, now);
      if (observer !== activeBotActor) continue;
      botTarget = null;
      lastKnownTarget = null;
      lastKnownTargetMotion = null;
      lastKnownTargetAt = null;
      botInvestigation = null;
      currentPath = [];
      pathMode = null;
      botCombatMoveGoal = null;
      botState = BOT_PATROL;
      recordBotStateChange(observer, botState, now);
    }
  }

  // v3:5758
  function beginBotHealthRetreat(target, threatId, now) {
    const actor = target?.botActor;
    // The bound actor's truth lives in the globals; its actor fields are stale until commit.
    const alreadyRequested = actor === activeBotActor ? botHealRequested : actor?.healRequested;
    if (!actor || alreadyRequested || !botHealthSettings.retreatEnabled) return;
    const hp01 = (target.health ?? DUMMY_MAX_HEALTH) / DUMMY_MAX_HEALTH;
    // A bot with no arms left cannot shoot back at any health, so it retreats on capability rather
    // than on the usual health threshold.
    if (hp01 > botHealthSettings.threshold01 && canFight(actor.wound)) return;
    // The currently-bound actor must be written through the globals, or commitBotActor
    // clobbers these fields with stale values at tick end (self-blast damage resolves in-tick).
    if (actor === activeBotActor) {
      botHealRequested = true;
      botHealArrived = false;
      botHealSafetySince = null;
      botHealThreatId = threatId || null;
      botHealStartedAt = now;
      botMuzzleRecoveryTarget = null;
      botRecoveryIssueActive = false;
      currentPath = [];
      pathMode = null;
      botCombatMoveGoal = null;
      return;
    }
    actor.healRequested = true;
    actor.healArrived = false;
    actor.healSafetySince = null;
    actor.healThreatId = threatId || null;
    actor.healStartedAt = now;
    // Shot recovery only improves a firing position. A wounded bot must give its health
    // retreat priority, so discard any pending recovery route.
    actor.muzzleRecoveryTarget = null;
    actor.recoveryIssueActive = false;
    actor.path = [];
    actor.pathMode = null;
    actor.combatMoveGoal = null;
  }

  // v3:5796
  function clearBotHealthRetreat() {
    botHealRequested = false;
    botHealArrived = false;
    botHealSafetySince = null;
    botHealThreatId = null;
    botHealStartedAt = null;
  }

  // v3:5815
  function packHashEnsure() {
    if (!packHashDirty) return;
    packHashDirty = false;
    packHash.rebuild(worldHealthPacks);
  }

  // v3:6021
  function botCanSeePack(bot, record) {
    const eye = eyePosInto(bot, _packEye);
    const dx = record.x - eye.x, dz = record.z - eye.z;
    const dist = Math.hypot(dx, dz);
    if (dist > botSightDistanceFor(bot.botActor)) return { visible: false, dist };
    if (dist < 1e-4) return { visible: true, dist };
    if (USE_FIELD_LOS_PREFILTER && fieldSaysHidden(eye.x, eye.z, record.x, record.z)) return { visible: false, dist };
    const target = { x: record.x, y: decalY(record.x, record.z, 0.15), z: record.z };
    const dir = { x: (target.x - eye.x), y: (target.y - eye.y), z: (target.z - eye.z) };
    const len = Math.hypot(dir.x, dir.y, dir.z);
    const blocked = mapCollider?.raycast([eye.x, eye.y, eye.z], [dir.x / len, dir.y / len, dir.z / len], len - 0.05);
    return { visible: !blocked, dist };
  }

  // v3:6040
  function _psVisit(record) {
    const cell = worldToCellInto(navGrid, record.x, record.z, _packSeekCell);
    const cellIdx = cellIdxOf(cell.c, cell.r);
    if (goalClaims.isClaimedByOther(cellIdx, _psBot.id)) return;
    const seen = botCanSeePack(_psBot, record);
    if (!seen.visible) return;
    if (!_psHurt && seen.dist > botPackSettings.shortProximity) return;
    // Selection runs on danger-inflated distance; `dist` stays the raw metres callers expect.
    const cmp = _psDanger ? seen.dist + dangerPenalty(botDangerField, _psTeam, cellIdx, _psNow, DANGER_PACK_SCALE) : seen.dist;
    // Strict < plus lowest-seq tiebreak replicates the old array-order first-wins scan exactly.
    if (!_psBest || cmp < _psBest.cmp || (cmp === _psBest.cmp && record.seq < _psBest.record.seq)) _psBest = { record, dist: seen.dist, cmp };
  }

  // v3:6052
  function nearestSeekablePack(bot, actor, hurt) {
    if (!worldHealthPacks.length || !canHold(actor?.healthPacks, actor?.maxPacks)) return null;
    packHashEnsure();
    _psBot = bot; _psHurt = hurt; _psBest = null;
    _psTeam = bot.team; _psNow = botStateRecordFrameNow || performance.now();
    _psDanger = hasDanger(botDangerField, _psTeam);
    // sightDistance bounds visibility inside botCanSeePack, so the hash query covers the old full scan.
    packHash.forEachNear(bot.capsule.start.x, bot.capsule.start.z, botSightDistanceFor(actor), _psVisit);
    const best = _psBest;
    _psBot = null; _psBest = null;
    return best;
  }

  // v3:6069
  function _puVisit(record) {
    if (Math.hypot(record.x - _puX, record.z - _puZ) <= botPackSettings.pickupRadius) _puNear.push(record);
  }

  // v3:6072
  function collectPacksUnderfoot(bot, actor, now) {
    const packs = actor?.healthPacks;
    if (!packs || !worldHealthPacks.length) return false;
    packHashEnsure();
    _puX = bot.capsule.start.x; _puZ = bot.capsule.start.z;
    _puNear.length = 0;
    packHash.forEachNear(_puX, _puZ, botPackSettings.pickupRadius, _puVisit);
    if (_puNear.length > 1) _puNear.sort((a, b) => b.seq - a.seq); // match the old tail-first scan order
    let collected = false;
    for (const record of _puNear) {
      if (!canHold(packs, actor?.maxPacks)) break;
      if (addPack(packs, record.pack, actor?.maxPacks)) {
        removeWorldHealthPack(record);
        collected = true;
        actor.packPickupCrouchUntil = now + botPackSettings.pickupCrouchMs; // brief crouch to grab it
        recordBotEvent(actor, `picked up pack (${Math.round(record.pack.charge01 * 100)}%) -> holding ${packs.length}`, now);
      }
    }
    _puNear.length = 0;
    return collected;
  }

  // v3:6103
  function allyAgg() {
    if (_allyAgg.version !== allyRingVersion) {
      _allyAgg.casualties.length = 0; _allyAgg.contacts.length = 0;
      _allyAgg.nearMisses.length = 0; _allyAgg.nonContacts.length = 0;
      for (const rep of recentAllyHits) {
        if (isContact(rep)) { _allyAgg.contacts.push(rep); continue; }
        _allyAgg.nonContacts.push(rep);
        if (isNearMiss(rep)) _allyAgg.nearMisses.push(rep); else _allyAgg.casualties.push(rep);
      }
      _allyAgg.version = allyRingVersion;
    }
    return _allyAgg;
  }

  // v3:6116
  function pushAllyReport(rep) {
    recentAllyHits.push(rep);
    if (recentAllyHits.length > 64) recentAllyHits.shift();
    allyRingVersion++;
  }

  // v3:6121
  function recordAllyHit(victim, attacker, now) {
    if (!attacker?.alive) return;
    const v = botXZ(victim), a = botXZ(attacker);
    // H3: weaker evidence than a death and no neighbour spread — one cell only.
    if (navGrid) recordDanger(botDangerField, victim.team, cellIndexAt(navGrid, v.x, v.z), DANGER_HIT_WEIGHT, now);
    // Caller decrements health before reporting, so a killing blow reads as lethal here.
    // attackerId turns the report from a bearing into an attribution: contact memory needs to know
    // WHO shot, not just from where, to rank a shooter above a bystander.
    pushAllyReport({ victimId: victim.id, team: victim.team, x: v.x, z: v.z, attackerId: attacker.id,
      threat: { x: a.x, z: a.z }, at: now, lethal: (victim.health ?? 1) <= 0 });
  }

  // v3:6169
  function latestAllyHitNear(me, now) {
    _alertMe.id = me.id; _alertMe.team = me.team;
    _alertMe.x = me.capsule.start.x; _alertMe.z = me.capsule.start.z;
    return latestAlertNear(allyAgg().casualties, _alertMe, now, ALLY_ALERT_RADIUS);
  }

  // v3:6177
  function _saVisit(other) {
    if (other === _saMe || other.alive === false || other.team !== _saMe.team) return;
    const rep = other.botActor?.alertReport;
    if (!rep || _saNow - rep.at > alertWindowMs(rep)) return;
    if (Math.hypot(other.capsule.start.x - _saPx, other.capsule.start.z - _saPz) > SEMI_ALERT_SHARE_RADIUS) return;
    if (!_saBest || rep.at > _saBest.at) _saBest = rep;
  }

  // v3:6184
  function sharedAllyAlertNear(me, now) {
    _saMe = me; _saNow = now; _saPx = me.capsule.start.x; _saPz = me.capsule.start.z; _saBest = null;
    botHash.forEachNear(_saPx, _saPz, SEMI_ALERT_SHARE_RADIUS, _saVisit);
    _saMe = null;
    const best = _saBest;
    _saBest = null;
    return best;
  }

  // v3:6193
  function _ltVisit(other) {
    if (other.alive === false || other.team !== _ltMe.team) return;
    if (Math.hypot(other.capsule.start.x - _ltPx, other.capsule.start.z - _ltPz) <= _ltRadius) _ltCount++;
  }

  // v3:6197
  function livingTeammatesNear(me, radius) {
    _ltMe = me; _ltRadius = radius; _ltPx = me.capsule.start.x; _ltPz = me.capsule.start.z; _ltCount = 0;
    botHash.forEachNear(_ltPx, _ltPz, radius, _ltVisit); // includes self (me is in the living hash)
    _ltMe = null;
    return _ltCount;
  }

  // v3:6207
  function _sqVisit(other) {
    if (other.alive === false || other.team !== _ltMe.team) return;
    if (Math.hypot(other.capsule.start.x - _ltPx, other.capsule.start.z - _ltPz) > _ltRadius) return;
    const actor = botActorById.get(other.id);
    if (actor) _sqMembers.push(actor);
  }

  // v3:6213
  function squadMembersNear(me, radius) {
    _ltMe = me; _ltRadius = radius; _ltPx = me.capsule.start.x; _ltPz = me.capsule.start.z;
    _sqMembers.length = 0;
    botHash.forEachNear(_ltPx, _ltPz, radius, _sqVisit);
    _ltMe = null;
    return _sqMembers;
  }

  // v3:6230
  function applyPushElement(now, threatXZ, canSeeThreat) {
    // A rostered bot already has a rank from this frame's squad tick; an unsquadded one falls back to
    // the original emergent group (a hash sweep + sort, per bot per frame -- the reason rosters are cheaper).
    const roster = activeBotActor.squadId ? squads.get(activeBotActor.squadId) : null;
    let rank;
    if (roster?.leaderId) {
      rank = activeBotActor.squadRank;
      activeBotActor.squadLeaderId = roster.leaderId;
    } else {
      const near = squadMembersNear(bot, SUPPORT_RADIUS);
      const leader = pickSquadLeader(near);
      rank = squadRanks(near, leader?.id).indexOf(String(bot.id));
      activeBotActor.squadLeaderId = leader?.id ?? null;
    }
    activeBotActor.pushStartedAt ??= now;
    // Support never draws the maneuver element: a medic taking its turn to bound forward is a medic
    // leading the assault. It stays with the base element (and follows when it has no firing position,
    // via the canOverwatch downgrade below) instead of alternating like a rifle.
    const element = getRole(activeBotActor.role).support
      ? 'base' : boundingRole(rank, now - activeBotActor.pushStartedAt);
    const canOverwatch = canSeeThreat || !!activeBotActor.coverCorner;
    activeBotActor.pushElement = element === 'base' && canOverwatch ? 'base' : 'move';
    if (activeBotActor.pushElement === 'base') {
      commandBotHold(activeBotActor, now + PUSH_HOLD_LEASE_MS, 'overwatch', threatXZ);
    }
  }

  // v3:6262
  function markBotBusy(actor, reason, until) {
    if (!actor) return;
    actor.busyReason = reason;
    actor.busyUntil = until;
  }

  // v3:6269
  function squadHaltFor(actor, now) {
    const squad = actor?.squadId ? squads.get(actor.squadId) : null;
    if (!squad) return null;
    if (squad.haltComputedAt === now) return squad.halt ?? null;
    squad.haltComputedAt = now;
    _haltMembers.length = 0;
    for (const id of squad.memberIds) {
      const m = botActorById.get(id);
      if (!m) continue;
      _haltMembers.push({ id, busyReason: m.busyReason, busyUntil: m.busyUntil, alive: m.entity.alive !== false });
    }
    squad.halt = squadHaltRequest(_haltMembers, now, squad.halt || {});
    return squad.halt;
  }

  // v3:6286
  function commandBotHold(actor, until, reason, facingXZ) {
    if (!actor) return false;
    const now = performance.now();
    if (actor.holdUntil > now && actor.holdReason === 'heal' && reason !== 'heal') return false;
    // Leases are re-granted every frame, so a lapsed hold restarts the clock: elapsed-held time is the
    // only signal that distinguishes a sustained pin from a one-frame stop (the prone gate reads it).
    if (!(actor.holdUntil > now)) actor.holdSince = now;
    actor.holdUntil = until;
    actor.holdReason = reason;
    actor.holdFacingXZ = facingXZ || null;
    return true;
  }

  // v3:6871
  function withinBotFov(yaw, fromPos, toPos) {
    // A6: an alert tier may only WIDEN the cone (max), never narrow the slider; lags the tier by one frame.
    const deg = Math.max(botBehaviorSettings.fovDegrees, activeBotActor?.tierPerception?.fovDegrees ?? 0);
    if (deg >= 360) return true;
    const dx = toPos.x - fromPos.x, dz = toPos.z - fromPos.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return true;
    const cosToTarget = (Math.sin(yaw) * dx + Math.cos(yaw) * dz) / len;
    return cosToTarget >= Math.cos(THREE.MathUtils.degToRad(deg) * 0.5);
  }

  // v3:6905
  function dangerDecay(ageMs, windowMs) { return Math.max(0, 1 - ageMs / windowMs); }

  // v3:6907
  function selectBotTarget() {
    const live = frameEnemyList(bot?.team);
    if (!live.length) { botTarget = null; return; }
    if (!bot || bot.alive === false) {
      botTarget = botTarget?.alive ? botTarget : null; // a revived bot re-acquires, it doesn't inherit
      return;
    }
    // Staggered acquisition: full re-scan every 4th frame per bot (the confirm ray below still runs
    // every frame for the current target); a dead target forces a scan now so nobody stares at a corpse.
    // A6: an alert tier may only SHORTEN the stride (min), so an alerted bot re-acquires faster.
    const scanDue = ((botFrameCounter + (activeBotActor?.scanPhase ?? 0)) %
      Math.min(TARGET_SCAN_STRIDE, activeBotActor?.tierPerception?.scanStride ?? TARGET_SCAN_STRIDE)) === 0;
    if (!scanDue && botTarget?.alive) return; // no target now counts as "scan now", same as a dead one
    const origin = eyePosInto(bot, _selOrigin);
    const sightSq = botSightDistance() ** 2;
    let count = 0;
    let firstLive = null;
    for (const target of live) {
      if (target.alive === false) continue; // died earlier this frame; the list is frame-scoped
      if (!firstLive) firstLive = target;
      const targetEye = eyePosInto(target, _selTargetEye);
      const dx = targetEye.x - origin.x, dy = targetEye.y - origin.y, dz = targetEye.z - origin.z;
      const distanceSq = dx * dx + dy * dy + dz * dz;
      if (distanceSq < 1e-8 || distanceSq > sightSq) continue;
      // Blind spot: an enemy outside the FOV cone can't be freshly acquired (parallels the LOS gate below).
      if (!withinBotFov(bot.yaw, origin, targetEye)) continue;
      if (USE_FIELD_LOS_PREFILTER && fieldSaysHidden(origin.x, origin.z, targetEye.x, targetEye.z)) continue;
      _selCandidates[count] = target; _selCandidateDistSq[count] = distanceSq; count++;
    }
    if (activeBotActor) activeBotActor.enemyCandidates = count; // in-cone/in-range enemies this scan, for the POV HUD
    // Insertion-sort nearest-first so the ray loop can stop at the first clear line of sight.
    for (let i = 1; i < count; i++) {
      const target = _selCandidates[i], distanceSq = _selCandidateDistSq[i];
      let j = i - 1;
      while (j >= 0 && _selCandidateDistSq[j] > distanceSq) { _selCandidateDistSq[j + 1] = _selCandidateDistSq[j]; _selCandidates[j + 1] = _selCandidates[j]; j--; }
      _selCandidateDistSq[j + 1] = distanceSq; _selCandidates[j + 1] = target;
    }
    // Candidate identities survive the scan (nearest-first, entity refs guarded by .alive at read
    // time -- same retention convention as actor.target). The single-slot pick below still discards
    // all but one; this list is what the POV HUD marks, and what a future contact memory feeds on.
    if (activeBotActor) {
      const perceived = activeBotActor.perceivedEnemies ??= [];
      const kept = Math.min(count, PERCEIVED_ENEMY_MAX);
      for (let i = 0; i < kept; i++) {
        const entry = perceived[i] ??= { entity: null, distSq: 0 };
        entry.entity = _selCandidates[i];
        entry.distSq = _selCandidateDistSq[i];
      }
      perceived.length = kept;
    }
    const now = botStateRecordFrameNow || performance.now();
    // Persistent contact memory: a candidate here passed FOV + range + the field LOS prefilter, which
    // errs toward visible (USE_FIELD_LOS_PREFILTER's comment) -- an approximation of "seen", not a
    // raycast-confirmed one. Good enough for a memory of roughly where an enemy was; the raycast below
    // is still the sole authority on whether `botTarget` can actually be fired at. Not yet consumed by
    // anything -- this just keeps the record so a later pass can weigh remembered-but-hidden enemies.
    if (activeBotActor) {
      const contacts = activeBotActor.contacts ??= createContactMemory();
      _selSeenIds.clear();
      for (let i = 0; i < count; i++) {
        const c = _selCandidates[i];
        _selSeenIds.add(c.id);
        botXZInto(c, _selContactXZ);
        recordContactSighting(contacts, c.id, _selContactXZ.x, _selContactXZ.z, now);
      }
      markContactsUnseen(contacts, _selSeenIds, now);
    }
    // Score every candidate by risk (proximity x danger) and reorder the shared buffers in place,
    // highest risk first, so the raycast-and-pick loop below finds the most dangerous VISIBLE enemy
    // instead of the nearest one. Order no longer matters to anything above this point -- the
    // nearest-first perceivedEnemies snapshot was already taken.
    const selfThreat = latestSelfThreat(allyAgg().nonContacts, bot, now);
    const allyThreat = latestAllyHitNear(bot, now);
    let allyPileOn = 0;
    if (allyThreat && allyThreat.attackerId != null) {
      for (const ally of squadMembersNear(bot, SUPPORT_RADIUS)) {
        if (ally.id !== bot.id && ally.target?.id === allyThreat.attackerId) allyPileOn++;
      }
    }
    const sightDist = Math.sqrt(sightSq);
    for (let i = 0; i < count; i++) {
      const id = _selCandidates[i].id;
      const proximity = sightDist / (sightDist + Math.sqrt(_selCandidateDistSq[i]));
      let danger = 1;
      if (selfThreat && id === selfThreat.attackerId) {
        danger += TARGET_DANGER_SELF_BONUS * dangerDecay(now - selfThreat.at, alertWindowMs(selfThreat));
      } else if (allyThreat && id === allyThreat.attackerId) {
        const pileOnFactor = Math.max(TARGET_PILE_ON_FLOOR, 1 - allyPileOn * TARGET_PILE_ON_STEP);
        danger += TARGET_DANGER_ALLY_BONUS * dangerDecay(now - allyThreat.at, alertWindowMs(allyThreat)) * pileOnFactor;
      }
      _selRisk[i] = proximity * danger;
    }
    for (let i = 1; i < count; i++) {
      const target = _selCandidates[i], distanceSq = _selCandidateDistSq[i], risk = _selRisk[i];
      let j = i - 1;
      while (j >= 0 && _selRisk[j] < risk) {
        _selCandidates[j + 1] = _selCandidates[j]; _selCandidateDistSq[j + 1] = _selCandidateDistSq[j]; _selRisk[j + 1] = _selRisk[j]; j--;
      }
      _selCandidates[j + 1] = target; _selCandidateDistSq[j + 1] = distanceSq; _selRisk[j + 1] = risk;
    }
    let best = null, bestRisk = -Infinity;
    for (let i = 0; i < count; i++) {
      const target = _selCandidates[i];
      const targetEye = eyePosInto(target, _selTargetEye);
      const distance = Math.sqrt(_selCandidateDistSq[i]);
      const dirX = (targetEye.x - origin.x) / distance, dirY = (targetEye.y - origin.y) / distance, dirZ = (targetEye.z - origin.z) / distance;
      if (mapCollider.raycast([origin.x, origin.y, origin.z], [dirX, dirY, dirZ], distance - 0.02)) continue;
      best = target;
      bestRisk = _selRisk[i];
      break;
    }
    // Stickiness: stealing the slot resets the paid A10 acquisition, so a marginally riskier enemy
    // must not take it every scan. Keep the incumbent unless it lost its own line of sight or the
    // newcomer is decisively (>=30%) riskier AND the commit dwell on the incumbent has expired.
    if (best && best !== botTarget && botTarget?.alive) {
      const committedAt = activeBotActor?.targetCommittedAt;
      const dwellHolding = committedAt != null && now - committedAt < TARGET_COMMIT_MIN_MS;
      for (let i = 0; i < count; i++) {
        if (_selCandidates[i] !== botTarget) continue;
        if (!dwellHolding && bestRisk > TARGET_STICK_RISK_MARGIN * _selRisk[i]) break;
        const targetEye = eyePosInto(botTarget, _selTargetEye);
        const distance = Math.sqrt(_selCandidateDistSq[i]);
        const dirX = (targetEye.x - origin.x) / distance, dirY = (targetEye.y - origin.y) / distance, dirZ = (targetEye.z - origin.z) / distance;
        if (!mapCollider.raycast([origin.x, origin.y, origin.z], [dirX, dirY, dirZ], distance - 0.02)) best = botTarget;
        break;
      }
    }
    for (let i = 0; i < count; i++) _selCandidates[i] = null; // drop entity refs between frames
    // Keep an occluded target so the existing investigate/chase path can use its last position, but
    // never invent one. The old `: firstLive` tail handed every bot that failed acquisition the same
    // array-order enemy (lowest spawn id), so a whole team converged on one bot ~46 m away and sat in
    // SEEK while enemies stood beside them. No target is the honest answer; the ladder already maps it
    // to last-known/patrol, and the !scanDue early-out below now lets a targetless bot re-scan at once.
    // Retention is bounded. Keeping an occluded target lets investigate/chase use its last position,
    // but only the DEAD case was covered before: a bot could hold a living target it had not seen for
    // minutes and never look at the enemy beside it (30.6% of target switches in the 07-29 trace were
    // onto an unseen target whose predecessor was still alive). Dropping it does NOT end the search --
    // `lastKnownTarget` is separate and still drives SEEK -- it only frees the bot to acquire someone
    // it can actually see.
    const unseen = activeBotActor?.targetUnseenSince;
    const stale = unseen != null && now - unseen > TARGET_RETAIN_MAX_MS;
    if (best) botDiag.targetPickBest++;
    else if (botTarget?.alive && !stale) botDiag.targetPickRetained++;
    else if (botTarget?.alive && stale) botDiag.targetRetentionExpired++;
    else if (firstLive) botDiag.targetPickFallbackSuppressed++; // where the old bug used to fire
    else botDiag.targetPickNone++;
    const keep = botTarget?.alive && !stale ? botTarget : null;
    const next = best || keep;
    if (next !== botTarget && activeBotActor) {
      activeBotActor.targetUnseenSince = null;  // new target, fresh clock
      activeBotActor.targetCommittedAt = now; // starts this target's dwell
    }
    botTarget = next;
  }

  // v3:7161
  function fieldSaysHidden(ax, az, bx, bz) {
    if (!visField || !navGrid) return false;
    const a = cellIndexAt(navGrid, ax, az), b = cellIndexAt(navGrid, bx, bz);
    if (a === -1 || b === -1 || navGrid.cells[a] !== 1 || navGrid.cells[b] !== 1) return false;
    return !visField.canSee(a, b);
  }

  // v3:7590
  function eyePosInto(entity, out) {
    return out.copy(entity.capsule.start).lerp(entity.capsule.end, EYE_LIFT);
  }

  // v3:7599
  function bodySurfaceY(entity) {
    if (!navGrid?.levels) return undefined;
    const feet = entity.capsule.start.y - entity.capsule.radius;
    return feet - groundHeight(entity.capsule.start.x, entity.capsule.start.z) > DECK_CLEARANCE ? feet : undefined;
  }

  // v3:7604
  function botXZ(entity) {
    return { x: entity.capsule.start.x, z: entity.capsule.start.z, y: bodySurfaceY(entity) };
  }

  // v3:7608
  function botXZInto(entity, out) {
    out.x = entity.capsule.start.x; out.z = entity.capsule.start.z; out.y = bodySurfaceY(entity);
    return out;
  }

  // v3:7708
  function cellIdxOf(c, r) { return r * navGrid.cols + c; }

  // v3:8197
  function currentBotMoveSpeed() {
    return BOT_MOVE_SPEED * stanceSpeedFactor(activeBotActor?.stance ?? STANCE_STAND, botStanceSettings, botMovementSettings.runMultiplier)
      * woundSpeedFactor(activeBotActor?.wound);   // a missing leg limps; both is a crawl
  }

  // v3:8202
  function botTurnRateRadS() {
    return TURN_RATE_RAD_S * stanceTurnRateScale(activeBotActor?.stance ?? STANCE_STAND, botStanceSettings)
      * woundTurnRateScale(activeBotActor?.wound);
  }

  // v3:8210
  function poseStanceFor(actor) {
    if (!botStanceSettings.enabled) return actor?.stanceForcedCrouch ? STANCE_CROUCH : STANCE_STAND;
    return actor?.stance ?? STANCE_STAND;
  }

  // v3:8332
  function trimFleeGoalHistory() {
    const keep = Math.max(0, Math.floor(botBehaviorSettings.fleeGoalMemory));
    botFleeGoalHistory.splice(keep);
  }

  // v3:8339
  function rememberFleeGoal(goal) {
    if (!goal || !navGrid || botBehaviorSettings.fleeGoalMemory <= 0) return;
    const cell = worldToCell(navGrid, goal.x, goal.z);
    const key = navCellKey(cell.c, cell.r);
    const existing = botFleeGoalHistory.findIndex((entry) => entry.key === key);
    if (existing >= 0) botFleeGoalHistory.splice(existing, 1);
    botFleeGoalHistory.unshift({ key, x: goal.x, z: goal.z });
    trimFleeGoalHistory();
  }

  // v3:8348
  function isRecentFleeGoal(c, r) {
    if (botBehaviorSettings.fleeGoalMemory <= 0) return false;
    return botFleeGoalHistory.some((entry) => entry.key === navCellKey(c, r));
  }

  // v3:8375
  function createBotActor(entity, mesh, roleId = DEFAULT_ROLE) {
    const role = getRole(roleId);
    const actor = {
      id: entity.id,
      scanPhase: nextBotId & 3, // stable spawn-order offset so target re-scans stagger across bots
      role: role.id, maxPacks: role.maxPacks,
      droneKit: null,   // drone rack + launch clocks; built on the operator's first tick, off the live stock slider
      entity, mesh, body: null, weaponMount: null, weaponMountToken: 0, equippedWeapon: entity.weapon,
      reloadUntil: null, reloadWeaponId: null,
      stow: null, stowKey: null,   // weapon-mount.js stow set: low-part copies of the guns not in hand (back/hip)
      swapUntil: 0,               // sidearm draw timer: no firing or reloading until it expires
      lastGunfightAt: null,       // last frame with contact; the lull past it re-holsters the pistol
      lastSelfThreatAt: null,     // last frame someone shot at us, read by the "in a gunfight" test
      shotsFired: 0, hitsLanded: 0, kills: 0, deaths: 0,   // lifetime, actor-direct (no global mirror)
      aliveSince: performance.now(), // re-stamped on revive; drives the POV debug readout's life clock
      state: BOT_PATROL, targetVisible: false, targetDistance: Infinity, targetVisGate: '-', lastShotAt: -Infinity, lastKnifeAt: -Infinity,
      knifeSince: null, knifeBlockUntil: null, patrolLocalGoal: null, // knife commit cap + in-region patrol fallback
      patrolLocalSince: null, patrolEscapeNextAt: 0, patrolStranded: false,  // escape-hatch bookkeeping
      squadHoldSince: null, squadHoldBroken: false,   // bounded formation hold
      targetUnseenSince: null,   // when the current target was last visible; drives retention expiry
      targetCommittedAt: null,   // when the current target was locked in; drives the anti-flicker dwell
      perceivedEnemies: [],      // last scan's in-cone candidates ({entity,distSq}, nearest-first)
      contacts: createContactMemory(),  // persistent per-enemy sighting memory (id -> {x,z,lastSeenAt,visible})
      aimTarget: { yaw: 0, pitch: 0 }, aimPoint: new THREE.Vector3(), hasAimPoint: false,
      blockedShotStreak: 0, missStreak: 0, muzzleRecoveryTarget: null, recoveryIssueActive: false, muzzleRecoveryVisitedCells: new Set(),
      lastTargetId: null, lastTargetSeenAt: null, // actor-direct (no global mirror): miss-streak reset bookkeeping
      combatMoveGoal: null, fleeGoalHistory: [], investigation: null,
      coverCorner: null, coverThreat: null, coverStartedAt: null, coverMoveSince: null, coverBlacklist: createCoverBlacklist(), peek: null,
      visDebounce: { lastTrueAt: null }, healUnsafePrev: false,
      coverGate: { invalidSince: null, switchedAt: null }, peekMissStreak: 0, coverHoldSince: null,
      coverPeekOffsetS: 0,        // S10 one-shot peek stagger, consumed when the hold builds its cycle
      attention: null,            // split-attention dwell/sweep state (threat bearing vs travel heading)
      patrolScan: null,           // A4 walking-scan sweep state, separate from `attention` (nulled while moving)
      tierPerception: null,       // A6 tier-scaled {fovDegrees, scanStride}; null fields = keep the defaults
      patrolIndex: patrolPoints.length ? nextBotId % patrolPoints.length : 0, // stagger the shared ring (L7)
      path: [], pathMode: null, lastKnownTarget: null, lastKnownTargetMotion: null, lastKnownTargetAt: null,
      patrolResumeGoal: null, patrolTravelHeading: { x: 0, z: 1 }, target: null,
      healRequested: false, healArrived: false, healSafetySince: null, healThreatId: null, healStartedAt: null,
      healthPacks: Array.from({ length: role.startingPacks }, () => makePack(1)), // dropped (w/ remaining charge) on death
      reviveKits: 0,              // medics fuse 3 packs into one; spends it to revive a fallen ally
      grenades: throwCountFor(botGrenadeSettings) + role.bonusGrenades, // stock, independent of the primary's ammo
      lastGrenadeAt: null, grenadeThrow: null, grenadeEvadeAt: null, grenadeCheckAt: null,
      grenadeEvadeId: null, grenadeGoal: null, evadeSeed: null,  // threat being evaded + the cell picked to sit out its blast
      droneReactionId: null, droneReactionFlee: false, droneReactionRoll: 0,   // run-or-shoot under a committed drone
      airTargetId: null, airSeenAt: null, airBlockedAt: null,   // the drone it is shooting at, and its LOS grace
      evadingUntil: 0,            // self-expiring dash-pose stamp; outlives the threat by the linger
      carryBlend: null,           // eased {position,rotation} walk/run/dash delta on the stance hold
      carryLocomotion: null,      // last resolved carry name, so a switch can free/reclaim the off hand
      heldPackMesh: null,         // lazily-built in-hand pack visual, shown only while healing/tending
      heldKitMesh: null,          // same, for the cyan revive kit -- shown only during a revive channel
      packSeekGoal: null,         // {x,z} of a dropped pack this bot is walking to collect
      packPickupCrouchUntil: 0,   // timestamp until which the bot dips into a crouch to grab a pack
      // Stance. Actor-direct, no register mirror: only this bot's own seams read it, so nothing leaks
      // between bots through the bind/commit globals.
      stance: STANCE_STAND,       // effective stance this frame, resolved once in updateBotSentry
      stanceLatch: null,          // {stance,changedAt,blockedUntil} hysteresis state for stepStanceTransition
      stanceWeights: null,        // {crouch01,prone01} eased pose weights shared by the rig and the capsule
      stanceForcedCrouch: false,  // raw heal/pack-dip predicate, kept so the pose survives a disabled decider
      standHeight: entity.capsule.end.y - entity.capsule.start.y, // straight section at spawn; stance scales from this
      poseMode: 'none',           // 'none' | 'rifleHeal' | 'medicHold' | 'medicAid' -- which arm override is active
      tendUnderFire: false,       // medic: is the fight still live? gun-up standing tend vs holstered kneel
      medicAction: null,          // current medic duty {state,kind,targetId,x,z} or null (medics only)
      medicTendTargetId: null,    // id being channelled + when the channel started (revive timing)
      medicTendStartedAt: 0,
      // S13: the one bot->bot command channel. Was heal-only; now any caller can pin a bot briefly
      // (medic servicing it, or its own squad's base-of-fire element). Actor-direct, no register mirror.
      // A10 aim state. Actor-direct, no register mirror: only this bot's own fire path reads it.
      aimContactAt: null,         // when the current unbroken sight of the target began
      aimReadyAt: 0,              // ...and when the recognition delay expires and it may shoot
      aimLostAt: null,            // when sight broke, for the re-acquire grace
      aimTargetId: null,          // which target the acquisition above describes
      aimPrimedUntil: 0,          // A10b: fresh contacts before this pay the attention-shift discount
      spreadBloomDeg: 0,          // recoil climb from sustained fire, decays while not shooting
      holdUntil: 0,               // hold position until here
      holdSince: null,            // when the current unbroken hold started; the prone gate reads elapsed
      holdReason: null,           // 'heal' | 'overwatch' -- heal outranks, a channel must not be cut
      holdFacingXZ: null,         // where to look while held, when there's no visible enemy
      pushStartedAt: null,        // S11: when this bot's current push tier began (drives the bound clock)
      pushElement: null,          // 'base' | 'move' this bound, or null outside a push
      squadLeaderId: null,        // whoever pickSquadLeader returned for the nearby group, for debug readouts
      squadId: null,              // persistent roster this bot belongs to, or null when independent
      squadRank: -1,              // rank among the squad's LIVING members (0 = leader); restamped each tick
      medicClaimBy: null,         // (as a patient) id of the medic that has committed to us, with a lease
      medicClaimUntil: 0,         // so other medics spread across the wounded instead of piling on one
      medicFlood: null,           // cached nav flood-fill (path distances) for wall-aware ally selection
      medicFloodAt: 0,            // when the cached flood was computed (throttled recompute)
      medicFloodBuf: null,        // this medic's own flood buffers (the shared pool can't survive frames)
      roleInsignia: null,         // lazily-built overhead class marker (e.g. medic cross), built at spawn
      leaderInsignia: null,       // separate overhead chevron, independent of class -- see setSquadLeaderMark
      alertMark: null,            // overhead "!" shown while the squad alert is actionable
      alertReport: null,          // this bot's FIRSTHAND alert report (what semi-alerts inherit)
      alertMarkMode: null,        // 'full' | 'semi' | 'wary' | 'push' | 'near' | null, stamped per sentry frame
      alertScore: 0,              // local escalation score shown as the digit beside the "!"
      alertTierLast: null,        // last frame's tier, read by the A10 reaction delay
      commitBits: 0,              // flee/cover/heal-flee FSM commits, stamped for the state code only
      stateCode: null, stateCodeKey: -1,  // last 9-slot code and its packed integer, for change detection
      traceLastPos: null, traceTickAt: null,  // trace motion columns: last sampled XZ and heartbeat stamp
      alertWarySince: null,       // when the current alert episode began (wary flinch timer)
      diedAt: null,               // timestamp of death, for the medic revive window
      goalDebug: null,            // both debug overlays are built lazily, on first display
      investigationDebug: null,
      ragdoll: null, ragdollPose: null,
      ragdollSettledSince: null,  // when the corpse first fell under RAGDOLL_SLEEP_ENERGY (null = awake)
    };
    entity.botActor = actor;
    return actor;
  }

  // v3:8483
  function bindBotActor(actor) {
    activeBotActor = actor;
    bot = actor?.entity ?? null;
    botMesh = actor?.mesh ?? null;
    botProceduralBody = actor?.body ?? null;
    botWeaponMount = actor?.weaponMount ?? null;
    botWeaponMountToken = actor?.weaponMountToken ?? 0;
    botReloadUntil = actor?.reloadUntil ?? null;
    botReloadWeaponId = actor?.reloadWeaponId ?? null;
    botState = actor?.state ?? BOT_PATROL;
    botTargetVisible = actor?.targetVisible ?? false;
    botTargetDistance = actor?.targetDistance ?? Infinity;
    botTargetVisGate = actor?.targetVisGate ?? '-';
    lastShotAt = actor?.lastShotAt ?? -Infinity;
    lastKnifeAt = actor?.lastKnifeAt ?? -Infinity;
    botAimTarget = actor?.aimTarget ?? { yaw: 0, pitch: 0 };
    botAimPoint = actor?.aimPoint ?? new THREE.Vector3();
    botHasAimPoint = actor?.hasAimPoint ?? false;
    botBlockedShotStreak = actor?.blockedShotStreak ?? 0;
    botMissStreak = actor?.missStreak ?? 0;
    botMuzzleRecoveryTarget = actor?.muzzleRecoveryTarget ?? null;
    botRecoveryIssueActive = actor?.recoveryIssueActive ?? false;
    botMuzzleRecoveryVisitedCells = actor?.muzzleRecoveryVisitedCells ?? new Set();
    botCombatMoveGoal = actor?.combatMoveGoal ?? null;
    botFleeGoalHistory = actor?.fleeGoalHistory ?? [];
    botInvestigation = actor?.investigation ?? null;
    patrolIdx = actor?.patrolIndex ?? 0;
    currentPath = actor?.path ?? [];
    pathMode = actor?.pathMode ?? null;
    lastKnownTarget = actor?.lastKnownTarget ?? null;
    lastKnownTargetMotion = actor?.lastKnownTargetMotion ?? null;
    lastKnownTargetAt = actor?.lastKnownTargetAt ?? null;
    botPatrolResumeGoal = actor?.patrolResumeGoal ?? null;
    botPatrolTravelHeading = actor?.patrolTravelHeading ?? { x: 0, z: 1 };
    botHealRequested = actor?.healRequested ?? false;
    botHealArrived = actor?.healArrived ?? false;
    botHealSafetySince = actor?.healSafetySince ?? null;
    botHealThreatId = actor?.healThreatId ?? null;
    botHealStartedAt = actor?.healStartedAt ?? null;
    botTarget = actor?.target ?? null;
  }

  // v3:8525
  function commitBotActor(actor = activeBotActor) {
    if (!actor) return;
    actor.body = botProceduralBody;
    actor.weaponMount = botWeaponMount;
    actor.weaponMountToken = botWeaponMountToken;
    actor.reloadUntil = botReloadUntil;
    actor.reloadWeaponId = botReloadWeaponId;
    actor.state = botState;
    actor.targetVisible = botTargetVisible;
    actor.targetDistance = botTargetDistance;
    actor.targetVisGate = botTargetVisGate;
    actor.lastShotAt = lastShotAt;
    actor.lastKnifeAt = lastKnifeAt;
    actor.aimTarget = botAimTarget;
    actor.aimPoint = botAimPoint;
    actor.hasAimPoint = botHasAimPoint;
    actor.blockedShotStreak = botBlockedShotStreak;
    actor.missStreak = botMissStreak;
    actor.muzzleRecoveryTarget = botMuzzleRecoveryTarget;
    actor.recoveryIssueActive = botRecoveryIssueActive;
    actor.muzzleRecoveryVisitedCells = botMuzzleRecoveryVisitedCells;
    actor.combatMoveGoal = botCombatMoveGoal;
    actor.fleeGoalHistory = botFleeGoalHistory;
    actor.investigation = botInvestigation;
    actor.patrolIndex = patrolIdx;
    actor.path = currentPath;
    actor.pathMode = pathMode;
    actor.lastKnownTarget = lastKnownTarget;
    actor.lastKnownTargetMotion = lastKnownTargetMotion;
    actor.lastKnownTargetAt = lastKnownTargetAt;
    actor.patrolResumeGoal = botPatrolResumeGoal;
    actor.patrolTravelHeading = botPatrolTravelHeading;
    actor.target = botTarget;
    actor.healRequested = botHealRequested;
    actor.healArrived = botHealArrived;
    actor.healSafetySince = botHealSafetySince;
    actor.healThreatId = botHealThreatId;
    actor.healStartedAt = botHealStartedAt;
    // Every per-frame global has landed on the actor, so this is where the state code is exact.
    const commitNow = botStateRecordFrameNow || performance.now();
    botStateDescriptor(actor, commitNow);   // unconditional: forensicStateKey must stay live with the recorder off (BB-004 review)
    if (botStateRecording) traceBotStateCode(actor, commitNow);
  }

  // v3:8569
  function withBotActor(actor, fn) {
    const previous = activeBotActor;
    if (previous) commitBotActor(previous);
    bindBotActor(actor);
    try { return fn(); }
    finally {
      commitBotActor(actor);
      bindBotActor(previous);
    }
  }

  // v3:8595
  function followPath(entity, path, speed) {
    const p = botXZInto(entity, _fpXZ);
    _fpEntity = entity; _fpLegNext = null;
    _fpOpts.canSkipTo = navGrid ? _fpNextLeg : null;
    while (path.length > 0) {
      const target = advancePath(p, path, WAYPOINT_REACH, _fpOpts);
      if (!target) break;
      const dx = target.x - p.x, dz = target.z - p.z;
      const dist = Math.hypot(dx, dz);
      // Own cell nav-blocked (shoved into the wall margin): recovery mode. lineWalkable from a
      // blocked start cell is false by construction, so legality checks/re-paths only thrash --
      // steer straight for the waypoint (post-re-path it's the snapped walkable cell center).
      const ownCell = navGrid ? worldToCellInto(navGrid, p.x, p.z, _fpOwnCell) : null;
      const ownBlocked = !!ownCell && !isWalkableCell(navGrid, ownCell.c, ownCell.r);
      // Pushout can strand a bot off the path line where bot->waypoint clips a wall: skip or re-path.
      if (navGrid && !ownBlocked && !lineWalkable(navGrid, p, target)) {
        if (path.length > 1 && _fpNextLeg(p, path[1])) { path.shift(); continue; }
        const nowMs = performance.now();
        if (!(entity.navRepathAt > nowMs)) {
          entity.navRepathAt = nowMs + NAV_REPATH_COOLDOWN_MS;
          const fresh = requestPath(entity, path[path.length - 1]);
          if (fresh.length > 0) { path.length = 0; path.push(...fresh); continue; }
        }
      }
      let mx = dx / dist, mz = dz / dist;
      // Soft separation: steer away from living neighbors so bots don't grind on the hard pushout.
      const sep = separationXZHashed(entity, botHash, SEPARATION_RADIUS);
      if (sep) {
        // Walkability gate: crowds may deflect the heading along the hall, never into a wall.
        const m = blendSeparationDir(mx, mz, sep, SEPARATION_WEIGHT,
          (bx, bz) => navBlockedAhead(p, bx, bz));
        mx = m.x; mz = m.z;
      }
      // Crowd-spike reversal stays allowed (it is what dissolves corner jams) but damped: backing
      // away from the waypoint is a shuffle, not a full-speed sprint (kills the jam oscillation).
      const spd = ((mx * (dx / dist) + mz * (dz / dist)) < 0 ? speed * 0.4 : speed) * terrainSpeedFactor(p, mx, mz);
      entity.velocity.x = mx * spd;
      entity.velocity.z = mz * spd;
      if (entity === bot) { botPatrolTravelHeading.x = dx / dist; botPatrolTravelHeading.z = dz / dist; }
      return false;
    }
    entity.velocity.x = 0; entity.velocity.z = 0;
    return true;
  }

  // v3:8643
  function terrainSpeedFactor(p, mx, mz) {
    if (!terrainSettings.enabled) return 1;
    const g = terrainField.gradientAt(p.x, p.z, 0.35);
    const grade = g.dx * mx + g.dz * mz;   // positive = heading uphill
    const f = grade >= 0 ? 1 - SLOPE_SPEED_CLIMB * grade : 1 + SLOPE_SPEED_DESCENT * -grade;
    return f < 0.4 ? 0.4 : f > 1.15 ? 1.15 : f;
  }

  // v3:8652
  function navBlockedAhead(p, mx, mz) {
    if (!navGrid) return false;
    const cell = worldToCellInto(navGrid, p.x + mx * SEPARATION_PROBE_M, p.z + mz * SEPARATION_PROBE_M, _navAheadCell);
    return !isWalkableCell(navGrid, cell.c, cell.r);
  }

  // v3:8657
  function requestPath(entity, toXZ) {
    const from = botXZ(entity);
    const raw = findPath(navGrid, from, toXZ);
    if (!raw) return [];
    const smoothed = smoothPath(navGrid, raw, SMOOTH_LOOKAHEAD);
    // Pushed into the wall margin (own cell nav-blocked): keep the snapped start waypoint so the
    // bot steps back onto the grid first; otherwise drop the waypoint at its own current cell.
    const cell = worldToCell(navGrid, from.x, from.z);
    return isWalkableCell(navGrid, cell.c, cell.r) ? smoothed.slice(1) : smoothed;
  }

  // v3:8676
  function replanJitterMs(entity) {
    return (entity.replanJitter ??= ((parseInt(String(entity.id).replace(/\D/g, ''), 10) || 0) % 8) * 25);
  }

  // v3:8682
  function requestPathBudgeted(entity, toXZ, now = botStateRecordFrameNow || performance.now()) {
    if (!entity || !navGrid) return null;
    if (now < (entity.nextReplanAt ?? -Infinity)) return null;
    if (replanBudgetLeft <= 0) return null;
    replanBudgetLeft--;
    entity.nextReplanAt = now + REPLAN_COOLDOWN_MS + replanJitterMs(entity);
    return requestPath(entity, toXZ);
  }

  // v3:8690
  function navCellKey(c, r) { return `${c},${r}`; }

  // v3:8692
  function normalizeXZ(vector) {
    if (!vector) return null;
    const length = Math.hypot(vector.x, vector.z);
    return length > 1e-4 ? { x: vector.x / length, z: vector.z / length } : null;
  }

  // v3:8698
  function nearestWalkableNavCell(cell) {
    if (!navGrid) return null;
    if (isWalkableCell(navGrid, cell.c, cell.r)) return cell;
    for (let radius = 1; radius <= 4; radius++) {
      for (let dr = -radius; dr <= radius; dr++) for (let dc = -radius; dc <= radius; dc++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== radius) continue;
        const candidate = { c: cell.c + dc, r: cell.r + dr };
        if (isWalkableCell(navGrid, candidate.c, candidate.r)) return candidate;
      }
    }
    return null;
  }

  // v3:8716
  function investigationRegionCeiling() {
    // + 2 * ring: the H5 spread widens the admission gate, so the BFS must collect that far too.
    return investigationRadius(botInvestigationSettings.durationMs / 1000, botInvestigationSettings) +
      NAV_CELL + 2 * SEEK_SPREAD_RING_M;
  }

  // v3:8722
  function reachableInvestigationCells(start, anchor = start) {
    const startCell = nearestWalkableNavCell(worldToCell(navGrid, start.x, start.z));
    if (!startCell) return [];
    const ceiling = investigationRegionCeiling();
    // The region gate measures from the anchor, not from the bot: walk a start-centred envelope
    // wide enough to contain the whole anchor region, and collect only what the gate can admit.
    const travelLimit = Math.hypot(anchor.x - start.x, anchor.z - start.z) + ceiling;
    const cells = [];
    const visited = new Set([cellIdxOf(startCell.c, startCell.r)]);
    const queue = [startCell];
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index];
      const here = cellToWorld(navGrid, current.c, current.r);
      if (Math.hypot(here.x - anchor.x, here.z - anchor.z) <= ceiling) cells.push(current);
      for (let k = 0; k < 8; k++) {
        const dc = INVEST_NB_DC[k], dr = INVEST_NB_DR[k];
        const c = current.c + dc, r = current.r + dr;
        if (!isWalkableCell(navGrid, c, r)) continue; // bounds-checks first, so the key below is unique
        if (visited.has(cellIdxOf(c, r))) continue;
        if (dc !== 0 && dr !== 0 &&
            (!isWalkableCell(navGrid, current.c + dc, current.r) || !isWalkableCell(navGrid, current.c, current.r + dr))) continue;
        const point = cellToWorld(navGrid, c, r);
        if (Math.hypot(point.x - start.x, point.z - start.z) > travelLimit) continue;
        visited.add(cellIdxOf(c, r));
        queue.push({ c, r });
      }
    }
    return cells;
  }

  // v3:8752
  function clearMuzzleRecoveryEpisode() {
    botMuzzleRecoveryTarget = null;
    if (bot) goalClaims.release(bot.id, 'recover');
    botRecoveryIssueActive = false;
    botMuzzleRecoveryVisitedCells.clear();
    botBlockedShotStreak = 0;
  }

  // v3:8779
  function floodWaypointsTo(flood, from, c, r) {
    const raw = floodPath(navGrid, flood, c, r);
    if (!raw) return null;
    const smoothed = smoothPath(navGrid, raw, SMOOTH_LOOKAHEAD);
    const cell = worldToCell(navGrid, from.x, from.z);
    return isWalkableCell(navGrid, cell.c, cell.r) ? smoothed.slice(1) : smoothed;
  }

  // v3:8853
  function updateMuzzleRecoveryMovement() {
    if (!botMuzzleRecoveryTarget) return false;
    let refused = false;
    if (pathMode !== 'muzzleRecovery') {
      const fresh = requestPathBudgeted(bot, botMuzzleRecoveryTarget);
      if (fresh) { currentPath = fresh; pathMode = 'muzzleRecovery'; }
      else refused = true; // throttled: hold the episode open, retry when due
    }
    if (refused && currentPath.length === 0) { bot.velocity.x = 0; bot.velocity.z = 0; return true; }
    if (currentPath.length === 0 || followPath(bot, currentPath, currentBotMoveSpeed())) {
      botMuzzleRecoveryTarget = null;
      goalClaims.release(bot.id, 'recover');
      pathMode = null;
      botBlockedShotStreak = 0;
      return false;
    }
    return true;
  }

  // v3:8946
  function advanceToReachablePatrolPoint() {
    if (!navGrid || !navGrid.regions || patrolPoints.length === 0) return true;
    const here = botXZInto(bot, _xzScratchA);
    const mine = regionAt(navGrid, here.x, here.z, 4, here.y ?? null);
    if (mine < 0) return true;   // off-grid: let the search decide, as before
    for (let i = 0; i < patrolPoints.length; i++) {
      const p = patrolPoints[patrolIdx];
      if (regionAt(navGrid, p.x, p.z, 4, p.y ?? null) === mine) return true;
      patrolIdx = (patrolIdx + 1) % patrolPoints.length;
    }
    return false;   // none of them are reachable from here
  }

  // v3:8965
  function localPatrolFallbackGoal() {
    if (!navGrid || !navGrid.regions) return null;
    const here = botXZInto(bot, _xzScratchA);
    const mine = regionAt(navGrid, here.x, here.z, 4, here.y ?? null);
    if (mine < 0) return null;
    const cached = activeBotActor.patrolLocalGoal;
    if (cached && Math.hypot(cached.x - here.x, cached.z - here.z) > WAYPOINT_REACH) return cached;
    const total = navGrid.rows * navGrid.cols;
    const start = botSeedFromId(activeBotActor.id) % total;
    let bestC = -1, bestR = -1, bestDist = 0;
    for (let i = 0; i < total; i++) {
      const idx = (start + i) % total;
      const r = (idx / navGrid.cols) | 0, c = idx % navGrid.cols;
      if (!isWalkableCell(navGrid, c, r)) continue;
      const p = cellToWorldInto(navGrid, c, r, _patrolLocalProbe);   // scratch: the scan can touch many cells
      if (regionAt(navGrid, p.x, p.z) !== mine) continue;
      const d = Math.hypot(p.x - here.x, p.z - here.z);
      if (d > bestDist) { bestC = c; bestR = r; bestDist = d; }
      if (bestDist >= PATROL_LOCAL_MIN_M) break; // good enough; don't sweep the whole grid
    }
    const best = bestC < 0 ? null : cellToWorld(navGrid, bestC, bestR);   // one allocation, kept on the actor
    activeBotActor.patrolLocalGoal = best;
    return best;
  }

  // v3:9001
  function tryPatrolEscape(now) {
    const a = activeBotActor;
    if (now < (a.patrolEscapeNextAt ?? 0)) return a.patrolStranded ? 'stranded' : null;
    a.patrolEscapeNextAt = now + PATROL_ESCAPE_RETRY_MS;
    const here = botXZInto(bot, _xzScratchA);
    const mine = regionAt(navGrid, here.x, here.z, 4, here.y ?? null);
    for (let i = 0; i < patrolPoints.length; i++) {
      const p = patrolPoints[i];
      if (regionAt(navGrid, p.x, p.z, 4, p.y ?? null) === mine) continue;   // same region: not what we are escaping
      const fresh = requestPathBudgeted(bot, p);
      if (fresh && fresh.length) {
        currentPath = fresh; pathMode = 'patrolEscape'; botCombatMoveGoal = p; patrolIdx = i;
        a.patrolStranded = false;
        botDiag.patrolEscaped++;
        return 'escaped';
      }
    }
    if (!a.patrolStranded) {
      a.patrolStranded = true;
      botDiag.patrolStranded++;
      console.warn(`[nav] ${a.id} is stranded: its nav region holds no patrol point and no route leaves it. `
        + 'It is orbiting a local goal, which is a fallback, NOT a fix -- the layout has a sealed pocket.');
    }
    return 'stranded';
  }

  // v3:9027
  function updatePatrolMovement() {
    if (patrolPoints.length === 0) return;
    const now = botStateRecordFrameNow || performance.now();
    // Re-entry goal the budget refused at finishInvestigation time: ask again now that we are patrolling.
    if (activeBotActor?.patrolResumePending && !botPatrolResumeGoal) {
      const retry = choosePatrolResumeGoal(now);
      if (retry) { botPatrolResumeGoal = retry; botCombatMoveGoal = { x: retry.x, z: retry.z }; }
    }
    const reentering = !!botPatrolResumeGoal;
    let localGoal = null;
    if (!reentering && !advanceToReachablePatrolPoint()) {
      botDiag.patrolNoRoute++;
      // Time spent with no reachable ring point is what triggers the escape attempt.
      activeBotActor.patrolLocalSince ??= now;
      if (now - activeBotActor.patrolLocalSince > PATROL_ESCAPE_MS && tryPatrolEscape(now) === 'escaped') {
        return;   // a real route out exists; walk it instead of orbiting
      }
      localGoal = localPatrolFallbackGoal();
      if (!localGoal) { botDiag.patrolIsolated++; bot.velocity.x = 0; bot.velocity.z = 0; return; }
      botDiag.patrolLocalFallback++;
    } else {
      activeBotActor.patrolLocalSince = null;
      activeBotActor.patrolStranded = false;
    }
    const goal = localGoal ?? (reentering ? botPatrolResumeGoal : patrolPoints[patrolIdx]);
    // 'patrolStranded' vs 'patrolLocal' is the whole point of the escape attempt: the first means we
    // PROVED no route out exists, the second only that we have not asked yet.
    const mode = localGoal ? (activeBotActor.patrolStranded ? 'patrolStranded' : 'patrolLocal')
      : reentering ? 'patrolReentry' : 'patrol';
    let refused = false;
    if (pathMode !== mode || currentPath.length === 0) {
      const fresh = requestPathBudgeted(bot, goal);
      if (!fresh) refused = true; // throttled: keep walking the stale path, retry when due
      else {
        currentPath = fresh;
        pathMode = mode;
        if (currentPath.length === 0) {
          if (localGoal) activeBotActor.patrolLocalGoal = null; // unreachable after all: pick another
          else if (reentering) { botPatrolResumeGoal = null; botCombatMoveGoal = null; }
          else patrolIdx = (patrolIdx + 1) % patrolPoints.length;
          return;
        }
      }
    }
    if (refused && currentPath.length === 0) { bot.velocity.x = 0; bot.velocity.z = 0; return; }
    // Anti-stall give-up: a leg with no net progress (e.g. queued behind a corner-holding
    // teammate in a one-lane hall) is abandoned for the next patrol goal instead of grinding.
    const here = botXZInto(bot, _xzScratchA);
    const stall = activeBotActor.patrolStall ??= { x: here.x, z: here.z, at: performance.now() };
    const nowMs = performance.now();
    if (Math.hypot(here.x - stall.x, here.z - stall.z) > PATROL_STALL_DIST_M) {
      stall.x = here.x; stall.z = here.z; stall.at = nowMs;
    } else if (nowMs - stall.at > PATROL_STALL_GIVEUP_MS) {
      stall.x = here.x; stall.z = here.z; stall.at = nowMs;
      if (localGoal) activeBotActor.patrolLocalGoal = null;
      else if (reentering) { botPatrolResumeGoal = null; botCombatMoveGoal = null; }
      else patrolIdx = (patrolIdx + 1) % patrolPoints.length;
      currentPath = []; pathMode = null;
      return;
    }
    const arrived = followPath(bot, currentPath, currentBotMoveSpeed());
    if (!arrived) {
      const speed = Math.hypot(bot.velocity.x, bot.velocity.z);
      if (speed > 1e-4) { botPatrolTravelHeading.x = bot.velocity.x / speed; botPatrolTravelHeading.z = bot.velocity.z / speed; }
      return;
    }
    if (localGoal) {
      activeBotActor.patrolLocalGoal = null; // reached it: next call picks a fresh in-region leg
    } else if (reentering) {
      patrolIdx = (botPatrolResumeGoal.index + 1) % patrolPoints.length;
      botPatrolResumeGoal = null;
      botCombatMoveGoal = null;
    } else {
      patrolIdx = (patrolIdx + 1) % patrolPoints.length;
    }
    pathMode = null;
  }

  // v3:9106
  function choosePatrolResumeGoal(now = botStateRecordFrameNow || performance.now()) {
    if (!bot || !navGrid || patrolPoints.length === 0) return null;
    // Budgeted like every other nav call. A refusal parks the request on the actor; updatePatrolMovement
    // retries it next think tick, so the bot re-enters at the right waypoint a few hundred ms later.
    if (now < (bot.nextReplanAt ?? -Infinity) || replanBudgetLeft < PATROL_RESUME_REPLAN_COST) {
      if (activeBotActor) activeBotActor.patrolResumePending = true;
      return null;
    }
    replanBudgetLeft -= PATROL_RESUME_REPLAN_COST;
    bot.nextReplanAt = now + REPLAN_COOLDOWN_MS + replanJitterMs(bot);
    if (activeBotActor) activeBotActor.patrolResumePending = false;
    const start = botXZ(bot);
    // One unbounded Dijkstra replaces the old A*-per-patrol-point scan; paths come out of its parents.
    const flood = floodFill(navGrid, start, {});
    if (!flood) return null;
    let bestForward = null;
    let bestFallback = null;
    const dangerNow = botStateRecordFrameNow || performance.now();
    const dangerLive = hasDanger(botDangerField, bot.team); // hoisted: skip the lookup for a clean team
    for (let index = 0; index < patrolPoints.length; index++) {
      const goal = patrolPoints[index];
      const dx = goal.x - start.x, dz = goal.z - start.z;
      const distance = Math.hypot(dx, dz);
      if (distance < WAYPOINT_REACH) continue;
      // findPath snaps an off-grid goal to the nearest walkable cell; mirror that here.
      const cell = nearestWalkableNavCell(worldToCell(navGrid, goal.x, goal.z));
      if (!cell || flood.dist[cellIdxOf(cell.c, cell.r)] === Infinity) continue;
      const path = floodWaypointsTo(flood, start, cell.c, cell.r);
      if (!path || path.length === 0) continue;
      const first = path[0];
      const firstDx = first.x - start.x, firstDz = first.z - start.z;
      const firstDistance = Math.hypot(firstDx, firstDz);
      const alignment = firstDistance > 1e-4 ? (firstDx * botPatrolTravelHeading.x + firstDz * botPatrolTravelHeading.z) / firstDistance : -1;
      let score = flood.dist[cellIdxOf(cell.c, cell.r)] - alignment * 0.5;
      // Minimized score: danger ADDS here (a waypoint the team keeps dying at reads as farther).
      if (dangerLive) score += dangerPenalty(botDangerField, bot.team, cellIdxOf(cell.c, cell.r), dangerNow, DANGER_PATROL_SCALE);
      const candidate = { x: goal.x, z: goal.z, index, score };
      if (alignment >= -0.1) {
        if (!bestForward || score < bestForward.score) bestForward = candidate;
      } else if (!bestFallback || score < bestFallback.score) {
        bestFallback = candidate;
      }
    }
    // Reverse only when every reachable patrol route reverses.
    return bestForward || bestFallback;
  }

  // v3:9153
  function finishInvestigation(now = botStateRecordFrameNow || performance.now()) {
    // A teammate's live contact must not re-arm the search the frame it ends (or per-frame on
    // an unreachable anchor) -- rest before accepting another secondhand seed.
    if (activeBotActor) activeBotActor.contactSeedBlockUntil = now + 5000;
    const investigatedTargetId = botInvestigation?.targetId ?? null;
    const reentry = choosePatrolResumeGoal(now);
    botPatrolResumeGoal = reentry;
    botCombatMoveGoal = reentry ? { x: reentry.x, z: reentry.z } : null;
    lastKnownTarget = null;
    lastKnownTargetMotion = null;
    lastKnownTargetAt = null;
    // An investigation owns an occluded-target lock only for its own lifetime. Once it
    // completes or expires, do not let that old unseen target recreate the same search.
    if (investigatedTargetId && botTarget?.id === investigatedTargetId) botTarget = null;
    currentPath = [];
    pathMode = null;
    botInvestigation = null;
    if (bot) goalClaims.release(bot.id, 'seek');
    if (botState === BOT_SEEK) {
      botState = BOT_PATROL;
      recordBotStateChange(activeBotActor, botState, now);
    }
  }

  // v3:9177
  function investigationSearchRadius(investigation, now) {
    return investigationRadius((now - investigation.startedAt) / 1000, botInvestigationSettings);
  }

  // v3:9181
  function investigationCellIsWithinRegion(investigation, cell, now) {
    const point = cellToWorld(navGrid, cell.c, cell.r);
    // Widened by this bot's H5 displacement: without it a high-seed bot stalls waiting for its own ring-0 cell.
    return Math.hypot(point.x - investigation.anchor.x, point.z - investigation.anchor.z) <=
      investigationSearchRadius(investigation, now) + (investigation.spreadRadius ?? 0) + NAV_CELL * 0.5;
  }

  // v3:9188
  function investigationHasUnattemptedCells(investigation) {
    const pending = investigation.pending;
    for (let i = investigation.pendingIndex; i < pending.length; i++) {
      if (!investigation.attempted.has(pending[i].key)) return true;
    }
    return false;
  }

  // v3:9195
  function beginInvestigation(now) {
    if (botInvestigation || !bot || !lastKnownTarget || !navGrid) return;
    // H5: every bot gets the same last-known point, so each searches its own offset of it instead.
    // Solo searchers take the true anchor; groups use the 8 spiral slots (slot 0 = ring 0 covered).
    const spreadSeed = activeBotActor ? (activeBotActor.spreadSeed ??= botSeedFromId(activeBotActor.id)) : botSeedFromId(bot.id);
    const effSeed = livingTeammatesNear(bot, SUPPORT_RADIUS) <= 1 ? 0 : (spreadSeed & 7);
    const spread = spreadAnchor(lastKnownTarget, effSeed, SEEK_SPREAD_RING_M);
    const anchorCell = worldToCell(navGrid, spread.x, spread.z);
    const directFromBot = normalizeXZ({
      x: lastKnownTarget.x - bot.capsule.start.x,
      z: lastKnownTarget.z - bot.capsule.start.z,
    });
    botInvestigation = {
      targetId: botTarget?.id ?? null,
      startedAt: now,
      expiresAt: now + botInvestigationSettings.durationMs,
      lastSeenAt: lastKnownTargetAt ?? now,
      motion: normalizeXZ(lastKnownTargetMotion),
      anchor: { ...lastKnownTarget },
      spread,                                            // per-bot offset point the frontier sorts around
      spreadRadius: spreadAnchorRadius(effSeed, SEEK_SPREAD_RING_M),
      anchorCell,
      cells: reachableInvestigationCells(botXZ(bot), lastKnownTarget),
      attempted: new Set(),
      preferredDirection: normalizeXZ(lastKnownTargetMotion) || directFromBot,
      pending: [],
      pendingIndex: 0,
      flankSign: 1,
      lastSeekGoal: null,
    };
    orderInvestigationFrontier(botInvestigation);
  }

  // v3:9228
  function findClosestReachableGoal(target) {
    if (!bot || !target || !navGrid) return null;
    const rawPath = findPath(navGrid, botXZ(bot), target);
    if (!rawPath?.length) return null;
    const goal = rawPath[rawPath.length - 1];
    return { x: goal.x, z: goal.z, path: smoothPath(navGrid, rawPath, SMOOTH_LOOKAHEAD).slice(1) };
  }

  // v3:9236
  function orderInvestigationFrontier(investigation) {
    const pending = [];
    // Small additive preference for cells that can actually see the last-known cell (baked field);
    // an unwalkable anchor cell just disables the bonus (canSee is false everywhere).
    const anchorIdx = visField && investigation.anchor ? cellIndexAt(navGrid, investigation.anchor.x, investigation.anchor.z) : -1;
    // Distance/alignment measure from the per-bot spread point; the LOS bonus below stays on the
    // true last-known anchor (that's what a bot actually wants eyes on).
    const centre = investigation.spread ?? investigation.anchor;
    for (const cell of investigation.cells) {
      const key = cellIdxOf(cell.c, cell.r); // integer cell key; `attempted` is keyed the same way
      if (investigation.attempted.has(key)) continue;
      const dc = cell.c - investigation.anchorCell.c;
      const dr = cell.r - investigation.anchorCell.r;
      const ring = Math.max(Math.abs(dc), Math.abs(dr));
      const point = cellToWorld(navGrid, cell.c, cell.r);
      const dx = point.x - centre.x;
      const dz = point.z - centre.z;
      const distanceSq = dx * dx + dz * dz;
      const distance = Math.sqrt(distanceSq);
      let alignment = investigation.preferredDirection && distance > 1e-4
        ? (dx * investigation.preferredDirection.x + dz * investigation.preferredDirection.z) / distance
        : 0;
      if (anchorIdx !== -1 && visField.canSee(cellIdxOf(cell.c, cell.r), anchorIdx)) alignment += INVESTIGATE_LOS_BONUS;
      pending.push({ ...cell, key, ring, alignment, distanceSq });
    }
    pending.sort((a, b) =>
      a.ring - b.ring ||
      b.alignment - a.alignment ||
      a.distanceSq - b.distanceSq ||
      a.r - b.r || a.c - b.c,
    );
    investigation.pending = pending;
    investigation.pendingIndex = 0;
  }

  // v3:9271
  function chooseNextInvestigationCell(investigation, now) {
    while (investigation.pendingIndex < investigation.pending.length) {
      const cell = investigation.pending[investigation.pendingIndex];
      if (investigation.attempted.has(cell.key)) { investigation.pendingIndex++; continue; }
      // Pending cells remain queued until the expanding uncertainty region reaches them.
      if (!investigationCellIsWithinRegion(investigation, cell, now)) return null;
      investigation.pendingIndex++;
      return cell;
    }
    return null;
  }

  // v3:9283
  function planNextInvestigationGoal(investigation, now) {
    // Each cell is marked before planning. If A* rejects one, it cannot be selected again.
    for (;;) {
      const cell = chooseNextInvestigationCell(investigation, now);
      if (!cell) return null;
      // Another bot is already headed here: skip without marking attempted (recovered only if the frontier reorders).
      if (goalClaims.isClaimedByOther(cell.key, bot.id)) continue;
      investigation.attempted.add(cell.key);
      const goal = cellToWorld(navGrid, cell.c, cell.r);
      const plan = findClosestReachableGoal(goal);
      if (plan) return { ...plan, cell };
    }
  }

  // v3:9297
  function updateInvestigationPreferenceAfterFlee(fleeGoal) {
    const investigation = botInvestigation;
    if (!investigation?.lastSeekGoal || !fleeGoal) return;
    const retreat = normalizeXZ({
      x: fleeGoal.x - investigation.lastSeekGoal.x,
      z: fleeGoal.z - investigation.lastSeekGoal.z,
    });
    if (!retreat) return;
    // The seek->flee vector identifies the blocked approach. Its alternating perpendiculars rank
    // the next shell's flank cells first; they never suppress other reachable cells.
    investigation.preferredDirection = {
      x: -retreat.z * investigation.flankSign,
      z: retreat.x * investigation.flankSign,
    };
    investigation.flankSign *= -1;
    orderInvestigationFrontier(investigation);
  }

  // v3:9315
  function updateSeekMovement(now) {
    if (!lastKnownTarget) { bot.velocity.x = 0; bot.velocity.z = 0; return; }
    if (botInvestigation && botInvestigation.targetId !== (botTarget?.id ?? null)) {
      // The remembered point belongs to the previous target. Never reuse it as the
      // anchor for a newly selected but still unseen target.
      finishInvestigation(now);
      return;
    }
    beginInvestigation(now);
    const investigation = botInvestigation;
    if (!investigation) { finishInvestigation(now); return; }
    if (now >= investigation.expiresAt) {
      recordBotEvent(activeBotActor, 'search window expired', now);
      finishInvestigation(now);
      return;
    }
  
    if (pathMode !== 'seek') {
      const plan = planNextInvestigationGoal(investigation, now);
      if (!plan) {
        if (!investigationHasUnattemptedCells(investigation)) {
          recordBotEvent(activeBotActor, 'search region exhausted', now);
          finishInvestigation(now);
        } else {
          // The next cells are outside the current uncertainty radius; wait for it to expand.
          bot.velocity.x = 0; bot.velocity.z = 0;
          pathMode = null; currentPath = []; botCombatMoveGoal = null;
        }
        return;
      }
      currentPath = plan.path;
      pathMode = 'seek';
      botCombatMoveGoal = { x: plan.x, z: plan.z };
      investigation.lastSeekGoal = { x: plan.x, z: plan.z };
      goalClaims.claim(bot.id, 'seek', plan.cell.key);
    }
    const arrived = currentPath.length === 0 || followPath(bot, currentPath, currentBotMoveSpeed());
    if (!arrived) return;
    currentPath = [];
    pathMode = null;
    botCombatMoveGoal = null;
  }

  // v3:9359
  function standoffGoalFromTarget(target, range) {
    let dx = bot.capsule.start.x - target.x, dz = bot.capsule.start.z - target.z;
    let distance = Math.hypot(dx, dz);
    if (distance < 1e-4) {
      dx = -Math.sin(bot.yaw); dz = -Math.cos(bot.yaw); distance = 1;
    }
    return { x: target.x + dx / distance * range, z: target.z + dz / distance * range };
  }

  // v3:9368
  function goalChanged(goal, threshold = 0.65) {
    return !botCombatMoveGoal || Math.hypot(goal.x - botCombatMoveGoal.x, goal.z - botCombatMoveGoal.z) > threshold;
  }

  // v3:9380
  function pursuitStandoffGoal(target, range) {
    const self = botXZInto(bot, _pursuitSelfXZ);
    const direct = standoffPoint(target, self, range, 0, bot.yaw);
    if (!navGrid) return direct;
    for (const offset of PINCER_OFFSETS) {
      const candidate = offset === 0 ? direct : standoffPoint(target, self, range, offset, bot.yaw);
      const cell = worldToCell(navGrid, candidate.x, candidate.z);
      if (!isWalkableCell(navGrid, cell.c, cell.r)) continue;
      const idx = cellIdxOf(cell.c, cell.r);
      if (goalClaims.isClaimedByOther(idx, bot.id)) continue;
      goalClaims.claim(bot.id, 'pursue', idx);
      return candidate;
    }
    return direct;
  }

  // v3:9396
  function updatePursuitMovement() {
    if (!botTarget?.alive) return;
    const targetXZ = botXZInto(botTarget, _pursuitTargetXZ);
    // A7: chase where the target is going. Aim and fire stay on the present position (hitscan), so
    // this only moves the feet -- it's the difference between intercepting and trailing forever.
    const lead = interceptPoint(targetXZ, botTarget.velocity, botXZInto(bot, _pursuitSelfXZ),
      { speed: currentBotMoveSpeed(), closeDistance: botCombatStandoff });
    // Only lead into space the target could actually run through: a prediction that clips a corner
    // sends the chaser at the wall the target is about to disappear behind.
    const chaseAt = lead.leadSeconds > 0 && (!navGrid || lineWalkable(navGrid, targetXZ, lead)) ? lead : targetXZ;
    // Aim inside the ladder's exit buffer -- the bare standoff distance never satisfies the exit
    // check (targetDistance <= pursueDistance - buffer), so a bot that reaches it freezes in PURSUE.
    // A garrisoned bot chases an intruder only as far as its ring: it still fights, it just doesn't
    // abandon the marker it is holding to run the length of the map.
    const goal = clampBotGoalToGarrison(activeBotActor,
      pursuitStandoffGoal(chaseAt, Math.max(0, botCombatStandoff - botBehaviorSettings.pursueExitBuffer)));
    let refused = false;
    if (pathMode !== 'pursue' || goalChanged(goal) || currentPath.length === 0) {
      const fresh = requestPathBudgeted(bot, goal);
      if (fresh) { currentPath = fresh; pathMode = 'pursue'; botCombatMoveGoal = goal; }
      else refused = true; // throttled: keep the stale path/goal, retry when the cooldown clears
    }
    if (currentPath.length === 0) {
      if (refused) { bot.velocity.x = 0; bot.velocity.z = 0; return; }
      pathMode = null;
      botCombatMoveGoal = null;
      return;
    }
    if (followPath(bot, currentPath, currentBotMoveSpeed())) {
      pathMode = null;
      botCombatMoveGoal = null;
    }
  }

  // v3:9430
  function updateKnifeMovement(targetDistance) {
    const knife = getWeapon('knife');
    if (!botTarget?.alive || !knife) return;
    if (targetDistance <= knife.range) {
      bot.velocity.x = 0; bot.velocity.z = 0;
      pathMode = null; currentPath = []; botCombatMoveGoal = null;
      return;
    }
    const goal = standoffGoalFromTarget(botXZInto(botTarget, _xzScratchA), Math.max(0.25, knife.range * 0.72));
    let refused = false;
    if (pathMode !== 'knife' || goalChanged(goal, 0.35) || currentPath.length === 0) {
      const fresh = requestPathBudgeted(bot, goal);
      if (fresh) { currentPath = fresh; pathMode = 'knife'; botCombatMoveGoal = goal; }
      else refused = true; // throttled: keep the stale path/goal, retry when the cooldown clears
    }
    if (currentPath.length === 0) {
      if (refused) { bot.velocity.x = 0; bot.velocity.z = 0; return; }
      pathMode = null;
      botCombatMoveGoal = null;
      return;
    }
    if (followPath(bot, currentPath, currentBotMoveSpeed())) {
      pathMode = null;
      botCombatMoveGoal = null;
    }
  }

  // v3:9456
  function currentFleeThreat() {
    const remembered = botHealRequested && botHealThreatId ? combatEntityById(botHealThreatId) : null;
    return remembered?.alive ? remembered : botTarget?.alive ? botTarget : null;
  }

  // v3:9462
  function _fsqVisit(other) {
    if (other.alive === false || other.team !== _fsqTeam || other.id === _fsqId) return;
    if (Math.hypot(other.capsule.start.x - _fsqX, other.capsule.start.z - _fsqZ) > FLEE_SQUAD_RADIUS) return;
    _fleeSquad.push({ x: other.capsule.start.x, z: other.capsule.start.z });
  }

  // v3:9467
  function findFleeGoal() {
    const threatTarget = currentFleeThreat();
    if (!bot || !threatTarget || !navGrid) return null;
    const source = botXZ(bot);
    const threat = botXZ(threatTarget);
    const maxSearchRadius = botHealRequested ? Math.max(botBehaviorSettings.fleeSearchRadius, botHealthSettings.retreatSearchRadius) : botBehaviorSettings.fleeSearchRadius;
    // One bounded Dijkstra scores every reachable cell; the old shape ran a full A* per cell.
    const flood = floodFill(navGrid, source, { maxRadius: maxSearchRadius });
    if (!flood) return null;
    const startCell = flood.start;
    // Baked-field cover bonus for every candidate; disabled if the threat quantizes to an
    // unwalkable/off-grid cell (canSee would report "hidden" everywhere — a false all-covered).
    const threatCell = visField ? cellIndexAt(navGrid, threat.x, threat.z) : -1;
    const coverEligible = threatCell !== -1 && navGrid.cells[threatCell] === 1;
    const now = botStateRecordFrameNow || performance.now();
    const dangerLive = hasDanger(botDangerField, bot.team); // hoisted: skip the lookup for a clean team
    // Squad centroid once per call (findFleeGoal is backoff-rate-limited, so this never runs per frame).
    _fleeSquad.length = 0;
    _fsqTeam = bot.team; _fsqId = bot.id; _fsqX = source.x; _fsqZ = source.z;
    botHash.forEachNear(source.x, source.z, FLEE_SQUAD_RADIUS, _fsqVisit);
    const squad = teamCentroid(_fleeSquad);
    _fleeSquad.length = 0; _fsqTeam = null; _fsqId = null;
    const candidates = [];
    for (let dr = -maxSearchRadius; dr <= maxSearchRadius; dr++) {
      for (let dc = -maxSearchRadius; dc <= maxSearchRadius; dc++) {
        if (dc === 0 && dr === 0) continue;
        const c = startCell.c + dc, r = startCell.r + dr;
        if (!isWalkableCell(navGrid, c, r)) continue;
        const key = r * navGrid.cols + c;
        if (flood.dist[key] === Infinity) continue;
        if (goalClaims.isClaimedByOther(key, bot.id)) continue;
        const goal = cellToWorld(navGrid, c, r);
        const covered = coverEligible && !visField.canSee(threatCell, key);
        // Reused scratch skips fleeCandidateScore's destructuring defaults: set every field.
        _fleeScore.threatDistance = Math.hypot(goal.x - threat.x, goal.z - threat.z);
        _fleeScore.pathDist = flood.dist[key];
        _fleeScore.covered = covered;
        _fleeScore.exposure01 = coverEligible
          ? fleePathExposureFromParents(visField, navGrid, threatCell, flood.parent, flood.startKey, key) : 0;
        _fleeScore.centroidDistance = squad ? Math.hypot(goal.x - squad.x, goal.z - squad.z) : null;
        _fleeScore.coverScore = botHealthSettings.coverScore;
        let score = fleeCandidateScore(_fleeScore);
        if (dangerLive) score -= dangerPenalty(botDangerField, bot.team, key, now, DANGER_FLEE_SCALE);
        candidates.push({ ...goal, c, r, score, covered });
      }
    }
    if (candidates.length === 0) return null;
    let best = null;
    let recentFallback = null;
    for (const candidate of candidates) {
      if (isRecentFleeGoal(candidate.c, candidate.r)) {
        if (!recentFallback || candidate.score > recentFallback.score) recentFallback = candidate;
      } else if (!best || candidate.score > best.score) {
        best = candidate;
      }
    }
    // Avoid recently completed retreat cells unless every local candidate is remembered.
    const chosen = best || recentFallback;
    if (!chosen) return null;
    const raw = floodPath(navGrid, flood, chosen.c, chosen.r);
    if (!raw) return null;
    chosen.path = smoothPath(navGrid, raw, SMOOTH_LOOKAHEAD).slice(1);
    return chosen;
  }

  // v3:9535
  function updatePackSeekMovement(now, speed = currentBotMoveSpeed()) {
    const goal = activeBotActor?.packSeekGoal;
    if (!goal) return false;
    const stale = pathMode !== 'packseek' || !botCombatMoveGoal || currentPath.length === 0 ||
      Math.hypot(botCombatMoveGoal.x - goal.x, botCombatMoveGoal.z - goal.z) > 0.5;
    let refused = false;
    if (stale) {
      const fresh = requestPathBudgeted(bot, goal, now);
      if (fresh) {
        currentPath = fresh;
        pathMode = 'packseek';
        botCombatMoveGoal = { x: goal.x, z: goal.z };
        recordBotEvent(activeBotActor, `seeking pack at (${goal.x.toFixed(2)}, ${goal.z.toFixed(2)})`, now);
      } else refused = true; // throttled: keep the stale path/goal, retry when the cooldown clears
    }
    if (currentPath.length === 0) {
      if (refused) { bot.velocity.x = 0; bot.velocity.z = 0; return true; } // hold, don't drop the errand
      pathMode = null; botCombatMoveGoal = null; return false;
    }
    if (followPath(bot, currentPath, speed)) { pathMode = null; botCombatMoveGoal = null; }
    return true;
  }

  // v3:9558
  function updateFleeMovement(now) {
    // A wounded bot with no pack routes to the nearest visible dropped pack instead of generic cover.
    if (botHealRequested && !hasHealResource(activeBotActor?.healthPacks) && activeBotActor?.packSeekGoal) {
      if (updatePackSeekMovement(now, currentBotMoveSpeed() * 1.24)) return;
    }
    if (botHealRequested && botHealArrived) {
      bot.velocity.x = 0; bot.velocity.z = 0;
      return;
    }
    if (pathMode !== 'flee' || !botCombatMoveGoal || currentPath.length === 0) {
      // Kite-flee has no arrival latch, so a failing search re-ran the flood every frame: back it off.
      const blocked = !botHealRequested && now < (activeBotActor.fleeSearchBlockedUntil ?? -Infinity);
      const plan = blocked ? null : findFleeGoal();
      if (!plan) {
        if (botHealRequested) recordBotEvent(activeBotActor, 'heal-flee: no reachable retreat goal', now);
        goalClaims.release(bot.id, 'flee');
        bot.velocity.x = 0; bot.velocity.z = 0;
        if (botHealRequested) { botHealArrived = true; botHealSafetySince = null; }
        else if (!blocked) activeBotActor.fleeSearchBlockedUntil = now + FLEE_SEARCH_BACKOFF_MS;
        return;
      }
      currentPath = plan.path;
      if (botHealRequested) recordBotEvent(activeBotActor, `heal-flee goal: (${plan.x.toFixed(2)}, ${plan.z.toFixed(2)})  covered:${plan.covered ? 'yes' : 'no'}`, now);
      pathMode = 'flee';
      botCombatMoveGoal = { x: plan.x, z: plan.z };
      goalClaims.claim(bot.id, 'flee', cellIdxOf(plan.c, plan.r));
    }
    if (followPath(bot, currentPath, currentBotMoveSpeed() * (botHealRequested ? 1.24 : 1.12))) {
      goalClaims.release(bot.id, 'flee');
      const completedGoal = { x: botCombatMoveGoal.x, z: botCombatMoveGoal.z };
      if (botHealRequested) recordBotEvent(activeBotActor, `heal-flee arrived: (${completedGoal.x.toFixed(2)}, ${completedGoal.z.toFixed(2)})`, now);
      updateInvestigationPreferenceAfterFlee(completedGoal);
      rememberFleeGoal(completedGoal);
      pathMode = null;
      botCombatMoveGoal = null;
      // A health retreat reached its selected safe node. Hold position long enough to
      // evaluate actual local danger; only updateBotSentry's unsafe branch may release
      // this latch and select another retreat goal.
      if (botHealRequested) { botHealArrived = true; botHealSafetySince = null; }
    }
  }

  // v3:9630
  function grenadeSpec() { return getWeapon('grenade')?.projectile || null; }

  // v3:9631
  function grenadeBody(e) {
    const mid = e.capsule.start.y + (e.capsule.end.y - e.capsule.start.y) * 0.5;
    return { id: e.id, p: [e.capsule.start.x, mid, e.capsule.start.z], cap: e.capsule };
  }

  // v3:9642
  function _grenadeRoughAim(x, z) { _grenadeRoughAimArr[0] = x; _grenadeRoughAimArr[2] = z; return _grenadeRoughAimArr; }

  // v3:9643
  function blastReachesBody(aimPoint, entry) {
    if (!entry?.cap) return true;   // no capsule to test: fall back to the plain radius ring
    _grenadeAimPoint.set(aimPoint[0], groundHeight(aimPoint[0], aimPoint[2]) + 0.15, aimPoint[2]);
    return blastExposure(_grenadeAimPoint, entry.cap) > 0;
  }

  // v3:9649
  function grenadeBodyInto(e, out) {
    out[0] = e.capsule.start.x;
    out[1] = e.capsule.start.y + (e.capsule.end.y - e.capsule.start.y) * 0.5;
    out[2] = e.capsule.start.z;
    return out;
  }

  // v3:9736
  function solveGrenadeThrow(fromVec, aimPoint) {
    const spec = grenadeSpec();
    if (!spec) return null;
    _grenadeFrom[0] = fromVec.x; _grenadeFrom[1] = fromVec.y; _grenadeFrom[2] = fromVec.z;
    // Aim at the ground under the target, not its chest: a lob solved to chest height passes through
    // and lands many metres long. bot-grenade carries the body Y through, so the drop happens here.
    const grounded = [aimPoint[0], groundHeight(aimPoint[0], aimPoint[2]) + 0.15, aimPoint[2]];
    const flat = Math.hypot(grounded[0] - fromVec.x, grounded[2] - fromVec.z);
    let vel = solveBallisticArc(_grenadeFrom, grounded, spec.speed, spec.gravity);
    if (!vel) return null;
    const flightS = flat / Math.max(0.1, Math.hypot(vel.vx, vel.vz));
    if (spec.gravity > 0) {
      const lifted = [grounded[0], grounded[1] + 0.5 * spec.gravity * (1 / 60) * flightS, grounded[2]];
      vel = solveBallisticArc(_grenadeFrom, lifted, spec.speed, spec.gravity) || vel;
    }
    const pts = sampleArcPoints(_grenadeFrom, vel, spec.gravity, 6, flightS);
    for (let i = 0; i < pts.length - 2; i++) {   // last leg may legitimately end in a wall/floor
      const a = pts[i], b = pts[i + 1];
      let dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-4) continue;
      if (mapCollider.raycast([a[0], a[1], a[2]], [dx / len, dy / len, dz / len], len)) return null;
    }
    return { vel, flightS };
  }

  // v3:9762
  function grenadeCandidate(now) {
    const actor = activeBotActor;
    if (!botGrenadesEnabled || !actor || !botTarget || (actor.grenades ?? 0) <= 0) return null;
    // A veto (friendly in the ring, wrong range) leaves the cooldown untouched, so without this the
    // roster scan below would re-run every frame for every bot that will never throw.
    if (actor.grenadeCheckAt != null && now - actor.grenadeCheckAt < GRENADE_DECIDE_INTERVAL_MS) return null;
    actor.grenadeCheckAt = now;
    if (actor.lastGrenadeAt != null && now - actor.lastGrenadeAt < botGrenadeSettings.cooldownMs) return null;
    const teamAt = teamLastGrenadeAt.get(bot.team);
    if (teamAt != null && now - teamAt < botGrenadeSettings.teamCooldownMs) return null;
    // Conservative range/staleness pre-gate so the roster scan below is skipped in the common case.
    // Slack covers the aim lead, so this can only reject throws chooseGrenadeThrow would also reject.
    const blastR = blastRadiusFor(getWeapon('grenade'));   // live tuning: the veto rings follow the slider
    const aimX = botTargetVisible ? botTarget.capsule.start.x : lastKnownTarget?.x;
    const aimZ = botTargetVisible ? botTarget.capsule.start.z : lastKnownTarget?.z;
    if (aimX == null || aimZ == null) return null;
    if (!botTargetVisible && !(now - lastKnownTargetAt <= botGrenadeSettings.blindThrowMaxAgeMs)) return null;
    const slack = botGrenadeSettings.aimLeadS * BOT_MOVE_SPEED * botMovementSettings.runMultiplier;
    const roughDist = Math.hypot(aimX - bot.capsule.start.x, aimZ - bot.capsule.start.z);
    if (roughDist > botGrenadeSettings.maxRange + slack) return null;
    // Self pre-gate, now occlusion-aware so it keeps the "can only reject what chooseGrenadeThrow would
    // also reject" invariant. Without the reach test this would veto every short throw before the real
    // gate ever saw it, silently undoing the corner-cook the self veto now allows.
    if (roughDist + slack <= blastR * botGrenadeSettings.selfRadiusScale
      && blastReachesBody(_grenadeRoughAim(aimX, aimZ), { cap: bot.capsule })) return null;
    _grenadeEnemies.length = 0; _grenadeAllies.length = 0;
    for (const other of botActors) {
      const e = other.entity;
      if (e.alive === false || !e.capsule) continue;
      if (e.team === bot.team) { if (e.id !== bot.id) _grenadeAllies.push(grenadeBody(e)); }
      else _grenadeEnemies.push(grenadeBody(e));
    }
    for (const t of dummyTargets) if (t.alive !== false && t.capsule) _grenadeEnemies.push(grenadeBody(t));
    const lastKnownP = lastKnownTarget
      ? [lastKnownTarget.x, groundHeight(lastKnownTarget.x, lastKnownTarget.z) + 1, lastKnownTarget.z] : null;
    const selfBody = grenadeBody(bot);
    return chooseGrenadeThrow({
      self: { id: bot.id, team: bot.team, p: selfBody.p, cap: selfBody.cap },
      target: {
        id: botTarget.id, p: grenadeBody(botTarget).p, visible: botTargetVisible,
        lastKnownP, lastKnownAt: lastKnownTargetAt,
        velocity: botTarget.velocity ? { x: botTarget.velocity.x, z: botTarget.velocity.z } : null,
      },
      enemies: _grenadeEnemies, allies: _grenadeAllies,
      blastRadius: blastR,
      grenadesLeft: actor.grenades, lastThrowAt: actor.lastGrenadeAt,
      lastTeamThrowAt: teamAt ?? null, now,
      blastReaches: blastReachesBody,   // same occlusion the blast itself will use
    }, botGrenadeSettings);
  }

  // v3:9827
  function updateGrenadeThrow(dt, now) {
    const actor = activeBotActor;
    if (!actor) return false;
    let pending = actor.grenadeThrow;
    if (!pending && botState !== BOT_FLEE && botState !== BOT_HEAL) {
      const choice = grenadeCandidate(now);
      if (choice) {
        const solved = solveGrenadeThrow(eyePosInto(bot, _grenadeOrigin), choice.aimPoint);
        if (solved) {
          pending = actor.grenadeThrow = { ...choice, vel: solved.vel, releaseAt: now + GRENADE_WINDUP_MS };
          recordBotStateChange(actor, 'grenade', now);
        }
      }
    }
    if (!pending) return false;
    bot.velocity.x = 0; bot.velocity.z = 0;
    pathMode = null; currentPath = []; botCombatMoveGoal = null;
    faceTargetXZ({ x: pending.aimPoint[0], z: pending.aimPoint[2] }, dt);
    if (now >= pending.releaseAt) {
      releaseGrenade(actor, pending, now);
      actor.grenadeThrow = null;
    }
    return true;
  }

  // v3:9875
  function navCellIdx(c, r) {
    if (c < 0 || r < 0 || c >= navGrid.cols || r >= navGrid.rows) return -1;
    return r * navGrid.cols + c;
  }

  // v3:9883
  function evadeShadowDepth(blastCell, c, r) {
    let n = 0;
    for (const [dc, dr] of EVADE_PROBE_DIRS) {
      const idx = navCellIdx(c + dc, r + dr);
      if (idx >= 0 && !visField.canSee(blastCell, idx)) n++;
    }
    return n;
  }

  // v3:9892
  function evadeJitter(seed, cellIdx) {
    let h = (seed * 374761393 + cellIdx * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }

  // v3:9897
  function grenadeEvadeGoal(fromP, blastRadius, actor) {
    if (!navGrid) return null;
    _evadeFrom.x = bot.capsule.start.x; _evadeFrom.z = bot.capsule.start.z;
    const start = worldToCellInto(navGrid, _evadeFrom.x, _evadeFrom.z, _evadeStart);
    const blastCell = visField ? cellIndexAt(navGrid, fromP[0], fromP[2]) : -1;
    // The shooter this bot is actually dealing with. Seen position if it can see it, else its last known
    // point -- the same memory the rest of the FSM steers on.
    const threatXZ = botTargetVisible && botTarget?.capsule
      ? { x: botTarget.capsule.start.x, z: botTarget.capsule.start.z } : lastKnownTarget;
    const enemyCell = visField && threatXZ ? cellIndexAt(navGrid, threatXZ.x, threatXZ.z) : -1;
    const seed = actor.evadeSeed ??= (Math.random() * 1e9) | 0;
    let bestX = 0, bestZ = 0, bestScore = -Infinity, bestHidden = false;
    // Second-best tracked separately: the best candidate reachable in a STRAIGHT line. The winner may
    // need a path solve, and requestPathBudgeted can refuse (300 ms per bot, 8 A* per frame shared).
    // Without a sprintable fallback a refused solve leaves the path empty, and followPath zeroes
    // velocity -- the bot stands still in the blast. lineWalkable is traced only for a candidate that
    // would actually become the fallback, so it fires a handful of times per scan, not once per cell.
    let lineX = 0, lineZ = 0, lineScore = -Infinity, lineHidden = false;
    for (let dr = -EVADE_SEARCH_CELLS; dr <= EVADE_SEARCH_CELLS; dr += EVADE_SEARCH_STRIDE) {
      for (let dc = -EVADE_SEARCH_CELLS; dc <= EVADE_SEARCH_CELLS; dc += EVADE_SEARCH_STRIDE) {
        if (dc === 0 && dr === 0) continue;   // "evade" must never resolve to standing still
        const c = start.c + dc, r = start.r + dr;
        if (!isWalkableCell(navGrid, c, r)) continue;
        const idx = navCellIdx(c, r);
        const w = cellToWorldInto(navGrid, c, r, _evadeCand);
        const fromBlast = Math.hypot(w.x - fromP[0], w.z - fromP[2]);
        let score = fromBlast
          - Math.hypot(w.x - _evadeFrom.x, w.z - _evadeFrom.z) * EVADE_TRAVEL_WEIGHT
          + evadeJitter(seed, idx) * EVADE_NOISE;
        // Don't park just outside the ring: that is an edge to be pushed off, same as the shadow edge.
        const clear = blastRadius + EVADE_CLEAR_MARGIN;
        if (fromBlast < clear) score -= (clear - fromBlast) * EVADE_EDGE_PENALTY;
        const hidden = blastCell >= 0 && idx >= 0 && !visField.canSee(blastCell, idx);
        if (hidden) score += EVADE_SHADOW_BONUS + EVADE_DEPTH_BONUS * evadeShadowDepth(blastCell, c, r);
        if (enemyCell >= 0 && idx >= 0 && visField.canSee(enemyCell, idx)) score -= EVADE_EXPOSURE_PENALTY;
        if (score > lineScore && lineWalkable(navGrid, _evadeFrom, w)) {
          lineScore = score; lineX = w.x; lineZ = w.z; lineHidden = hidden;
        }
        if (score <= bestScore) continue;
        bestScore = score; bestX = w.x; bestZ = w.z; bestHidden = hidden;
      }
    }
    if (bestScore === -Infinity) return null;
    return {
      x: bestX, z: bestZ, hidden: bestHidden,
      direct: lineScore === bestScore,   // the winner is sprintable; no path solve needed
      straight: lineScore === -Infinity ? null : { x: lineX, z: lineZ, hidden: lineHidden },
    };
  }

  // v3:9952
  function clearGrenadeEvade(actor) {
    actor.grenadeEvadeAt = null; actor.voiceEvadeId = null;
    actor.grenadeEvadeId = null; actor.grenadeGoal = null;
  }

  // v3:9958
  function reportGrenadeThreat(actor, threatId, now) {
    const threat = _grenadeThreats.find(g => g.id === threatId);
    if (!threat) return;
    const thrower = threat.throwerId != null ? combatEntityById(threat.throwerId) : null;
    // A teammate's grenade is a reason to move, never a bearing on the enemy -- reporting it would
    // point the squad at itself.
    if (thrower && thrower.team === bot.team) return;
    // Prefer the thrower's own position; a dead or unknown thrower still leaves the grenade itself as a
    // direction worth investigating, with no attribution (every attackerId consumer null-guards).
    const live = !!thrower && thrower.alive !== false;
    const from = live ? botXZ(thrower) : { x: threat.p[0], z: threat.p[2] };
    const v = botXZ(bot);
    pushAllyReport({
      victimId: bot.id, team: bot.team, x: v.x, z: v.z,
      attackerId: live ? thrower.id : null,
      threat: { x: from.x, z: from.z }, at: now, lethal: false,
    });
  }

  // v3:9976
  function updateGrenadeEvade(dt, now) {
    const actor = activeBotActor;
    if (!actor) return false;
    // Grenades being off does not put a drone back in the air: the list carries both now.
    if (_grenadeThreats.length === 0) { clearGrenadeEvade(actor); return false; }
    const self = grenadeBodyInto(bot, _grenadeSelf);
    const evade = grenadeEvade(self, _grenadeThreats, botGrenadeSettings, actor.grenadeEvadeId);
    if (!evade) { clearGrenadeEvade(actor); return false; }
    const threatId = evade.id ?? 'blast';
    // Run or shoot. A grenade can only be run from; a drone can be shot down, so the squad under one
    // does both. Which a given bot does is a question of how close the thing is: at the edge of the
    // ring nobody runs, and the nearer it gets the more of them break. Declining to run drops through
    // to the normal chain, where air defence picks the drone up -- so "not running" IS "shooting".
    const airThreat = _grenadeThreats.find(g => g.id === threatId && g.air);
    if (airThreat) {
      const dist = Math.hypot(bot.capsule.start.x - evade.from[0], bot.capsule.start.z - evade.from[2]);
      const nearness = Math.max(0, Math.min(1, 1 - dist / Math.max(0.01, evade.radius)));
      if (actor.droneReactionId !== threatId) {
        actor.droneReactionId = threatId;
        actor.droneReactionRoll = Math.random();   // this bot's nerve, fixed for this one drone
        actor.droneReactionFlee = false;
      }
      // Escalate only. A bot already running does not talk itself back into standing there while it is
      // still inside the ring, which is what a re-rolled decision every frame would look like. Running
      // ENDS by leaving the ring: grenadeEvade drops the threat past blast x evadeExitScale, and the
      // next frame's chain finds the bot with nothing to run from and a drone to shoot at.
      if (!actor.droneReactionFlee
        && actor.droneReactionRoll < botDroneSettings.threatFleeShare * Math.sqrt(nearness)) {
        actor.droneReactionFlee = true;
      }
      if (!actor.droneReactionFlee) { clearGrenadeEvade(actor); return false; }
    }
    // A different grenade is a fresh problem: the spot picked against the old one may face the wrong way.
    if (actor.grenadeEvadeId !== threatId) {
      actor.grenadeEvadeId = threatId;
      actor.grenadeGoal = null;
      actor.grenadeEvadeAt = null;
    }
    if (actor.voiceEvadeId !== threatId) {
      actor.voiceEvadeId = threatId;
      sayBotLine(bot, actor, 'grenade_warn', now, `grenade_warn:${threatId}`);
      reportGrenadeThreat(actor, threatId, now);   // being thrown at is evidence, whether or not it lands
    }
    actor.evadingUntil = now + GRENADE_EVADE_POSE_LINGER_MS;  // read by next frame's stance resolve
    actor.grenadeThrow = null;   // drop a wind-up: not the moment to be standing still
    const goal = actor.grenadeGoal;
    // Arrived at a spot the blast cannot see: sit it out rather than shuffling back into the open.
    if (goal?.hidden && Math.hypot(goal.x - bot.capsule.start.x, goal.z - bot.capsule.start.z) <= GRENADE_GOAL_REACH) {
      bot.velocity.x = 0; bot.velocity.z = 0;
      pathMode = null; currentPath = []; botCombatMoveGoal = null;
      faceTargetXZ({ x: bot.capsule.start.x * 2 - evade.from[0], z: bot.capsule.start.z * 2 - evade.from[2] }, dt);
      return true;
    }
    if (!actor.grenadeEvadeAt || now - actor.grenadeEvadeAt > GRENADE_EVADE_REPLAN_MS || currentPath.length === 0) {
      const pick = grenadeEvadeGoal(evade.from, evade.radius, actor);
      // Straight sprint when the winner is reachable in a line (the common case); a path solve only when
      // it is behind geometry, which is exactly when it is worth paying for. A refused solve falls back
      // to the best sprintable cell rather than to nothing -- standing still in a blast is never the
      // right answer, and "no path this frame" is a budget state, not a tactical one.
      let chosen = null;
      if (pick?.direct) {
        currentPath = [{ x: pick.x, z: pick.z }];
        chosen = pick;
      } else if (pick) {
        const fresh = requestPathBudgeted(bot, { x: pick.x, z: pick.z }, now);
        if (fresh) { currentPath = fresh; chosen = pick; }
        else if (pick.straight) { currentPath = [{ x: pick.straight.x, z: pick.straight.z }]; chosen = pick.straight; }
      }
      if (chosen) {
        pathMode = 'grenade';
        botCombatMoveGoal = { x: chosen.x, z: chosen.z };
        actor.grenadeGoal = chosen;
        actor.grenadeEvadeAt = now;
      }
    }
    followPath(bot, currentPath, BOT_MOVE_SPEED * botMovementSettings.runMultiplier); // always a sprint
    faceMovement(dt);
    return true;
  }

  // v3:10291
  function coverCornerValid(rec, threatPos, secondaryThreat = null) {
    if (!visField || !navGrid) return false;
    return coverCornerValidPure({ field: visField, navGrid }, rec, threatPos, secondaryThreat);
  }

  // v3:10298
  function findCoverCorner(bot, threatPos, secondaryThreat = null) {
    if (!bot || !threatPos || !visField || !cornerMap || !navGrid) return null;
    const nowMs = botStateRecordFrameNow || performance.now();
    // Danger is a hard veto here, not a penalty: a scarce corner must not win on distance alone.
    const skip = (rec) => coverBlacklisted(activeBotActor?.coverBlacklist, rec.anchorCell, nowMs) ||
      goalClaims.isClaimedByOther(rec.anchorCell, bot.id) ||
      dangerBlocksCover(botDangerField, bot.team, rec.anchorCell, nowMs, 0.35); // 0.35: neighbour spread (0.4) vetoes too
    return pickCoverCorner({ corners: cornerMap.corners, field: visField, navGrid, searchRadius: COVER_SEARCH_RADIUS, skip },
      botXZInto(bot, _xzScratchA), threatPos, secondaryThreat);
  }

  // v3:10316
  function secondVisibleThreat(primaryXZ, contact = null) {
    if (!bot || !primaryXZ) return null;
    const eye = eyePosInto(bot, _secEye);
    const sightSq = botSightDistance() ** 2;
    const sepSq = SECONDARY_THREAT_MIN_SEPARATION * SECONDARY_THREAT_MIN_SEPARATION;
    let bestX = 0, bestZ = 0, bestSq = Infinity;
    for (const e of frameEnemyList(bot.team)) {
      if (e.alive === false || e === botTarget || !e.capsule) continue;
      const px = e.capsule.start.x, pz = e.capsule.start.z;
      if ((px - primaryXZ.x) ** 2 + (pz - primaryXZ.z) ** 2 <= sepSq) continue; // same shooter, different label
      const targetEye = eyePosInto(e, _secTargetEye);
      const dSq = targetEye.distanceToSquared(eye);
      if (dSq > sightSq || dSq >= bestSq) continue;
      if (!withinBotFov(bot.yaw, eye, targetEye)) continue;
      if (USE_FIELD_LOS_PREFILTER && fieldSaysHidden(eye.x, eye.z, targetEye.x, targetEye.z)) continue;
      bestSq = dSq; bestX = px; bestZ = pz;
    }
    if (bestSq === Infinity) {
      if (!contact || (contact.threat.x - primaryXZ.x) ** 2 + (contact.threat.z - primaryXZ.z) ** 2 <= sepSq) return null;
      bestX = contact.threat.x; bestZ = contact.threat.z;
    }
    _secondaryXZ.x = bestX; _secondaryXZ.z = bestZ;
    return _secondaryXZ;
  }

  // v3:10346
  function _giVisit(e) {
    const other = e.botActor;
    if (!other || other === _giActor || e.team !== _giTeam || !other.coverCorner) return;
    if (Math.hypot(e.capsule.start.x - _giX, e.capsule.start.z - _giZ) > COVER_GROUP_RADIUS) return;
    const t = other.coverThreat;
    if (!t || Math.hypot(t.x - _giTx, t.z - _giTz) > COVER_GROUP_THREAT_EPS) return;
    _giCount++;
  }

  // v3:10354
  function coverGroupIndex(actor, threatPos) {
    if (!threatPos || !bot) return 0;
    _giActor = actor; _giTeam = bot.team; _giX = bot.capsule.start.x; _giZ = bot.capsule.start.z;
    _giTx = threatPos.x; _giTz = threatPos.z; _giCount = 0;
    botHash.forEachNear(_giX, _giZ, COVER_GROUP_RADIUS, _giVisit);
    _giActor = null; _giTeam = null;
    return _giCount;
  }

  // v3:10363
  function commitCoverCorner(rec, threatPos, now) {
    const actor = activeBotActor;
    if (!actor || !rec) return;
    if (actor.coverCorner !== rec && pathMode === 'cover') { currentPath = []; pathMode = null; botCombatMoveGoal = null; }
    // A different corner restarts the peek cycle/miss streak/drought clock/travel timer and stamps the cooldown.
    if (actor.coverCorner !== rec) {
      actor.peek = null; actor.peekMissStreak = 0; actor.coverHoldSince = null; actor.coverMoveSince = now; noteCoverSwitch(actor.coverGate, now);
      actor.coverPeekOffsetS = peekPhaseOffsetS(coverGroupIndex(actor, threatPos)); // S10: stagger against the group already here
    }
    actor.coverCorner = rec;
    actor.coverThreat = { x: threatPos.x, z: threatPos.z };
    actor.coverStartedAt = now;
    goalClaims.claim(bot.id, 'cover', rec.anchorCell);
  }

  // v3:10378
  function releaseCoverCorner() {
    const actor = activeBotActor;
    if (!actor) return;
    goalClaims.release(bot.id, 'cover');
    actor.coverCorner = null;
    actor.coverThreat = null;
    actor.coverStartedAt = null;
    actor.peek = null;
    actor.peekMissStreak = 0;
    actor.coverHoldSince = null;
    actor.coverPeekOffsetS = 0; // the stagger described a group this bot has now left
    actor.coverGate.invalidSince = null; // switchedAt survives: it rate-limits the next entry too
    if (pathMode === 'cover') { currentPath = []; pathMode = null; botCombatMoveGoal = null; }
  }

  // v3:10394
  function updateCoverMoveMovement() {
    const rec = activeBotActor?.coverCorner;
    if (activeBotActor) { activeBotActor.peek = null; activeBotActor.coverHoldSince = null; } // re-pathing restarts cycle + drought clock
    if (!rec) { bot.velocity.x = 0; bot.velocity.z = 0; return; }
    const stale = pathMode !== 'cover' || !botCombatMoveGoal || currentPath.length === 0 ||
      Math.hypot(botCombatMoveGoal.x - rec.anchorPos.x, botCombatMoveGoal.z - rec.anchorPos.z) > 0.1;
    let refused = false;
    if (stale) {
      const fresh = requestPathBudgeted(bot, rec.anchorPos);
      if (fresh) { currentPath = fresh; pathMode = 'cover'; botCombatMoveGoal = { x: rec.anchorPos.x, z: rec.anchorPos.z }; }
      else refused = true; // throttled: keep the current cover approach, retry when the cooldown clears
    }
    if (currentPath.length === 0) { bot.velocity.x = 0; bot.velocity.z = 0; if (!refused) { pathMode = null; botCombatMoveGoal = null; } return; }
    if (followPath(bot, currentPath, currentBotMoveSpeed() * 1.12)) { pathMode = null; botCombatMoveGoal = null; }
  }

  // v3:10413
  function faceAimDirection(targetYaw, targetPitch, dt) {
    const maxDelta = botTurnRateRadS() * dt;
    bot.yaw = slewAngle(bot.yaw, targetYaw, maxDelta);
    bot.pitch = slewAngle(bot.pitch, targetPitch, maxDelta);
  }

  // v3:10420
  function bearingToXZ(target) {
    if (!target) return null;
    const dx = target.x - bot.capsule.start.x, dz = target.z - bot.capsule.start.z;
    return Math.hypot(dx, dz) < 1e-4 ? null : Math.atan2(dx, dz);
  }

  // v3:10426
  function faceTargetXZ(target, dt) {
    const yaw = bearingToXZ(target);
    if (yaw != null) faceAimDirection(yaw, 0, dt);
  }

  // v3:10433
  function faceThreatAndAhead(threat, dt, now) {
    const att = activeBotActor.attention ??= { phase: null, until: 0, sweepSince: null };
    const moving = Math.hypot(bot.velocity.x, bot.velocity.z) >= 0.05;
    if (moving) att.sweepSince = null; // restart the standing sweep centred next time
    // A5/S7: seed the standing sweep at a per-bot phase so co-located bots never share one blind bearing.
    else att.sweepSince ??= now - sweepPhaseMs(activeBotActor.spreadSeed ??= botSeedFromId(activeBotActor.id));
    const threatYaw = bearingToXZ(threat);
    if (threatYaw == null) { faceMovement(dt); return; }
    if (stepAttention(att, moving, now) === 'ahead') faceAimDirection(Math.atan2(bot.velocity.x, bot.velocity.z), 0, dt);
    else faceAimDirection(threatYaw + (moving ? 0 : attentionSweep(att, now)), 0, dt);
  }

  // v3:10445
  function faceMovement(dt) {
    const speed = Math.hypot(bot.velocity.x, bot.velocity.z);
    if (speed < 0.05) return;
    const targetYaw = Math.atan2(bot.velocity.x, bot.velocity.z);
    const maxDelta = botTurnRateRadS() * dt;
    bot.yaw = slewAngle(bot.yaw, targetYaw, maxDelta);
    bot.pitch = slewAngle(bot.pitch, 0, maxDelta);
  }

  // v3:10456
  function faceMovementScanning(dt, now) {
    const speed = Math.hypot(bot.velocity.x, bot.velocity.z);
    if (speed < 0.05) return;
    const st = activeBotActor.patrolScan ??= { sweepSince: null };
    const seed = activeBotActor.spreadSeed ??= botSeedFromId(activeBotActor.id);
    const targetYaw = Math.atan2(bot.velocity.x, bot.velocity.z) + patrolScanOffset(st, seed, now);
    const maxDelta = botTurnRateRadS() * dt;
    bot.yaw = slewAngle(bot.yaw, targetYaw, maxDelta);
    bot.pitch = slewAngle(bot.pitch, 0, maxDelta);
  }

  // v3:10473
  function updateHealSafety(now, visible, targetDistance) {
    if (!botHealRequested || !botHealArrived) {
      botHealSafetySince = null;
      if (activeBotActor) activeBotActor.healUnsafePrev = false;
      return { ready: false, unsafe: false };
    }
    // Banded verdict: a target hovering at safeDistance can no longer pump HEAL<->FLEE each tick.
    const unsafe = visible && healUnsafeBand(targetDistance, !!activeBotActor?.healUnsafePrev, botHealthSettings.safeDistance);
    if (activeBotActor) activeBotActor.healUnsafePrev = unsafe;
    if (unsafe) {
      botHealSafetySince = null;
      return { ready: false, unsafe: true };
    }
    if (botHealSafetySince == null) {
      botHealSafetySince = now;
      recordBotEvent(activeBotActor, `heal-safe hold started: ${botTarget?.id ?? 'no target'} ${Number.isFinite(targetDistance) ? `${targetDistance.toFixed(2)}m` : ''}`.trim(), now);
    }
    return { ready: now - botHealSafetySince >= botHealthSettings.safeHoldMs, unsafe: false };
  }

  // v3:10493
  function updateBotHealing(dt) {
    bot.velocity.x = 0;
    bot.velocity.z = 0;
    const packs = activeBotActor?.healthPacks;
    if (!hasHealResource(packs)) { clearBotHealthRetreat(); return; } // no pack -> can't heal, drop the retreat
    const wanted = Math.min(botHealthSettings.healPerSecond * dt, Math.max(0, DUMMY_MAX_HEALTH - (bot.health ?? DUMMY_MAX_HEALTH)));
    const applied = drawFromPacks(packs, wanted); // spends pack charge; a partial heal leaves a partial pack
    bot.health = Math.min(DUMMY_MAX_HEALTH, (bot.health ?? DUMMY_MAX_HEALTH) + applied);
    if (applied > 0) sealBotWounds(bot);
    if (packs.length === 0) recordBotEvent(activeBotActor, 'last pack depleted mid-heal', botStateRecordFrameNow);
    // Stop at the resume threshold (packs are rarely fully spent) or when the inventory runs dry.
    if (bot.health / DUMMY_MAX_HEALTH >= botHealthSettings.resume01 || !hasHealResource(packs)) {
      clearBotHealthRetreat();
    }
  }

  // v3:10517
  function medicNavFlood(actor, selfXZ, now) {
    if (!navGrid) return null;
    if (actor.medicFlood && now - actor.medicFloodAt < MEDIC_NAV_FLOOD_MS) return actor.medicFlood;
    const reach = Math.max(MEDIC_DEFAULTS.responseRadius, MEDIC_DEFAULTS.reviveRadius);
    if (!actor.medicFloodBuf) actor.medicFloodBuf = {};
    actor.medicFlood = floodFill(navGrid, selfXZ, { maxRadius: Math.ceil(reach / navGrid.cellSize) + 1, out: actor.medicFloodBuf });
    actor.medicFloodAt = now;
    return actor.medicFlood;
  }

  // v3:10528
  function medicNavCost(flood, x, z) {
    const cell = nearestWalkableNavCell(worldToCell(navGrid, x, z));
    if (!cell) return Infinity;
    const d = flood.dist[cell.r * navGrid.cols + cell.c];
    return Number.isFinite(d) ? d : Infinity;
  }

  // v3:10540
  function attachMedicNavCost(actor, selfXZ, now, allies, corpses) {
    if (!allies.length && !corpses.length) return;
    const flood = medicNavFlood(actor, selfXZ, now);
    if (!flood) return;
    for (const list of [allies, corpses]) {
      for (let i = list.length - 1; i >= 0; i--) {
        const c = medicNavCost(flood, list[i].x, list[i].z);
        if (!Number.isFinite(c)) { list.splice(i, 1); continue; } // unreachable -> not a candidate
        list[i].cost = c;
        list[i].bias = navGrid ? dangerPenalty(botDangerField, actor.entity.team, cellIndexAt(navGrid, list[i].x, list[i].z), now, DANGER_PATROL_SCALE) : 0;
      }
    }
  }

  // v3:10561
  function _mdSquadmate(other) { return _mdSquadId ? other.squadId === _mdSquadId : undefined; }

  // v3:10562
  function _mdAllyVisit(e) {
    const other = e.botActor;
    if (!other || other === _mdActor || e.team !== _mdTeam) return;
    // Never tend fellow medics: support units self-heal from their own packs, and medic-on-medic
    // healing makes them converge (and can deadlock two into a mutual heal) -- that's the clustering.
    if (other.role === ROLE_MEDIC) return;
    // Skip a patient another living medic has already committed to (claim lease), so medics spread
    // across the wounded instead of stacking on one. Our own claim never excludes us.
    if (other.medicClaimUntil > _mdNow && other.medicClaimBy != null && other.medicClaimBy !== _mdActor.id) return;
    const hp01 = (e.health ?? DUMMY_MAX_HEALTH) / DUMMY_MAX_HEALTH;
    if (hp01 > MEDIC_DEFAULTS.healAllyThreshold01) return;
    const x = e.capsule.start.x, z = e.capsule.start.z;
    // MED-2: a patient in FLEE outruns the default chase, so the tend band + chase speed widen for it.
    if ((x - _mdSx) ** 2 + (z - _mdSz) ** 2 <= _mdRespSq) {
      _mdAllies.push({ id: e.id, x, z, hp01, fleeing: other.state === BOT_FLEE, squadmate: _mdSquadmate(other) });
    }
  }

  // v3:10581
  function decideMedicDuty(now, threatXZ = null) {
    const actor = activeBotActor;
    // Healing is two-handed: the heal pose holds the pack in one hand and dabs with the other. Losing
    // EITHER arm ends a medic's duty entirely, so it drops back to being an ordinary rifleman.
    if (!canHeal(actor?.wound)) return null;
    const selfXZ = botXZ(bot);
    const allies = [];
    const corpses = [];
    // Euclidean is a valid superset prefilter (path distance >= straight-line), keeping the candidate
    // set -- and the flood-fill below -- small; the wall-aware path cost then tightens the range.
    const revSq = MEDIC_DEFAULTS.reviveRadius * MEDIC_DEFAULTS.reviveRadius;
    _mdActor = actor; _mdNow = now; _mdSx = selfXZ.x; _mdSz = selfXZ.z; _mdTeam = bot.team;
    _mdRespSq = MEDIC_DEFAULTS.responseRadius * MEDIC_DEFAULTS.responseRadius;
    _mdAllies = allies;
    _mdSquadId = actor.squadId && squads.has(actor.squadId) ? actor.squadId : null;
    botHash.forEachNear(selfXZ.x, selfXZ.z, MEDIC_DEFAULTS.responseRadius, _mdAllyVisit);
    _mdActor = null; _mdAllies = null;
    // Corpses aren't in the hash (it holds the living roster), so they come from the death-site set.
    for (const other of deadBotActors) {
      if (other === actor || other.entity.team !== bot.team || other.diedAt == null) continue;
      if (other.medicClaimUntil > now && other.medicClaimBy != null && other.medicClaimBy !== actor.id) continue;
      const e = other.entity;
      const x = other.deathXZ?.x ?? e.capsule.start.x, z = other.deathXZ?.z ?? e.capsule.start.z;
      if ((x - selfXZ.x) ** 2 + (z - selfXZ.z) ** 2 <= revSq) {
        corpses.push({ id: e.id, x, z, diedAt: other.diedAt, squadmate: _mdSquadmate(other) });
      }
    }
    // Wall-aware ranking: attach a nav path cost to each candidate and drop the unreachable ones, so a
    // medic never picks (or pins against a wall trying to reach) an ally that's close only in a straight
    // line. One bounded flood-fill from the medic covers every candidate; throttled + only when needed.
    attachMedicNavCost(actor, selfXZ, now, allies, corpses);
    maybeBuildReviveKit(now, corpses, selfXZ);
    // TEND is only ever chosen inside tendRadius, so the medic's own cell IS the prospective tend spot.
    // Only report exposure when somewhere better actually exists nearby: otherwise the downgrade would
    // strand the medic standing beside an untended patient with nowhere to re-route to.
    let exposed = false;
    if (threatXZ && visField && navGrid) {
      _alertBake.field = visField; _alertBake.navGrid = navGrid;
      exposed = exposedToThreat(_alertBake, selfXZ, threatXZ);
    }
    let action = decideMedicAction({
      self: selfXZ, allies, corpses,
      hasKit: actor.reviveKits > 0, hasCharge: hasHealResource(actor.healthPacks),
      now, cfg: MEDIC_DEFAULTS,
    });
    if (!action) action = stickyHealTend(actor, selfXZ); // finish topping up an ally past the select threshold
    // S12, post-decision so gate and route share ONE centre (the patient): an exposed tend converts
    // to a move onto a concealed cell in tend range; no such cell -> tend anyway (never freeze).
    if (action && action.state === MEDIC_TEND && exposed && threatXZ) {
      const hide = nearestConcealedCellNear(action.x, action.z, threatXZ.x, threatXZ.z, medicTendRadiusFor(!!action.fleeing, MEDIC_DEFAULTS));
      if (hide) { action.state = MEDIC_MOVE; action.seekConcealment = true; action.hideX = hide.x; action.hideZ = hide.z; }
    }
    if (action) {
      const targetActor = botActorById.get(action.targetId);
      if (targetActor) {
        // Claim the patient so other medics look elsewhere this frame (sequential actor updates make it stick).
        targetActor.medicClaimBy = actor.id;
        targetActor.medicClaimUntil = now + botMedicSettings.medicClaimLeaseMs;
        // Ask a heal target to hold once we're close by PATH (or already tending) so we can reach it.
        if (action.kind === 'heal' &&
            (action.state === MEDIC_TEND || (action.dist ?? Infinity) <= botMedicSettings.healHoldRadius)) {
          commandBotHold(targetActor, now + botMedicSettings.healHoldLeaseMs, 'heal', { x: selfXZ.x, z: selfXZ.z });
        }
      }
    }
    actor.medicAction = action;
    if (!action) actor.medicTendTargetId = null;
    return action;
  }

  // v3:10653
  function stickyHealTend(actor, selfXZ) {
    if (!actor.medicTendTargetId || !hasHealResource(actor.healthPacks)) return null;
    const cur = botActorById.get(actor.medicTendTargetId);
    if (!cur || cur.entity.alive === false) return null;
    const p = botXZ(cur.entity);
    const hp01 = (cur.entity.health ?? DUMMY_MAX_HEALTH) / DUMMY_MAX_HEALTH;
    if (hp01 >= MEDIC_DEFAULTS.allyResumeHp01) return null;
    const fleeing = cur.state === BOT_FLEE; // MED-2: same widened band the select path uses
    if (Math.hypot(p.x - selfXZ.x, p.z - selfXZ.z) > medicTendRadiusFor(fleeing, MEDIC_DEFAULTS)) return null;
    return { state: MEDIC_TEND, kind: 'heal', targetId: cur.entity.id, x: p.x, z: p.z, fleeing };
  }

  // v3:10667
  function maybeBuildReviveKit(now, corpses, selfXZ) {
    const actor = activeBotActor;
    if (actor.reviveKits > 0 || !hasReviveMaterials(actor.healthPacks)) return;
    const corpseNear = corpses.some((c) => now - c.diedAt <= MEDIC_DEFAULTS.reviveWindowMs &&
      Math.hypot(c.x - selfXZ.x, c.z - selfXZ.z) <= MEDIC_DEFAULTS.reviveRadius);
    if (actor.healthPacks.length >= actor.maxPacks || corpseNear) {
      if (consumeRevivePacks(actor.healthPacks)) { actor.reviveKits += 1; recordBotEvent(actor, 'fused 3 packs into a revive kit', now); }
    }
  }

  // v3:10679
  function nearestConcealedCellNear(px, pz, tx, tz, radius) {
    if (!navGrid || !visField) return null;
    const threatCell = cellIndexAt(navGrid, tx, tz);
    if (threatCell < 0) return null;
    const centre = worldToCellInto(navGrid, px, pz, _hideRC);
    const span = Math.max(1, Math.min(6, Math.round(radius / navGrid.cellSize)));
    const spanSq = span * span;
    let bestC = -1, bestR = -1, bestSq = Infinity;
    for (let dr = -span; dr <= span; dr++) {
      for (let dc = -span; dc <= span; dc++) {
        const d2 = dc * dc + dr * dr;
        if (d2 > spanSq || d2 >= bestSq) continue; // cell-space distance: cellSize is uniform
        const c = centre.c + dc, r = centre.r + dr;
        if (!isWalkableCell(navGrid, c, r)) continue;
        if (visField.canSee(threatCell, cellIdxOf(c, r))) continue;
        bestSq = d2; bestC = c; bestR = r;
      }
    }
    return bestC < 0 ? null : cellToWorldInto(navGrid, bestC, bestR, _hideXZ);
  }

  // v3:10702
  function updateMedicMoveMovement(now, speed = currentBotMoveSpeed() * medicChaseSpeedFactor(activeBotActor?.medicAction?.fleeing)) {
    const action = activeBotActor?.medicAction;
    if (!action) return false;
    // S12: the hide cell was chosen at decision time (same centre as the gate); just route to it.
    const goal = action.seekConcealment && action.hideX != null
      ? { x: action.hideX, z: action.hideZ } : { x: action.x, z: action.z };
    const stale = pathMode !== 'medic' || !botCombatMoveGoal || currentPath.length === 0 ||
      Math.hypot(botCombatMoveGoal.x - goal.x, botCombatMoveGoal.z - goal.z) > 0.5;
    // A refused (throttled) request leaves the stale path/goal alone; the empty-path case below already holds.
    if (stale) { const fresh = requestPathBudgeted(bot, goal, now); if (fresh) { currentPath = fresh; pathMode = 'medic'; botCombatMoveGoal = goal; } }
    if (currentPath.length === 0) { bot.velocity.x = 0; bot.velocity.z = 0; return true; }
    if (followPath(bot, currentPath, speed)) { pathMode = null; botCombatMoveGoal = null; }
    return true;
  }

  // v3:10721
  function creepToContact(patientXZ) {
    const dx = patientXZ.x - bot.capsule.start.x, dz = patientXZ.z - bot.capsule.start.z;
    const d = Math.hypot(dx, dz);
    if (!(d > MEDIC_CONTACT_RADIUS)) { bot.velocity.x = 0; bot.velocity.z = 0; return; }
    const speed = currentBotMoveSpeed() * MEDIC_CONTACT_CREEP;
    bot.velocity.x = (dx / d) * speed; bot.velocity.z = (dz / d) * speed;
  }

  // v3:10732
  function updateMedicTend(dt, now) {
    bot.velocity.x = 0; bot.velocity.z = 0;
    const actor = activeBotActor;
    const action = actor?.medicAction;
    if (!action) return;
    creepToContact(action);
    const targetActor = botActorById.get(action.targetId);
    if (!targetActor) { actor.medicTendTargetId = null; return; }
    if (action.kind === 'revive') {
      if (actor.medicTendTargetId !== action.targetId) { actor.medicTendTargetId = action.targetId; actor.medicTendStartedAt = now; }
      if (now - actor.medicTendStartedAt >= botMedicSettings.reviveChannelMs) {
        reviveCombatBot(targetActor, now);
        actor.medicTendTargetId = null;
        actor.medicAction = null;
      }
      return;
    }
    // heal: draw from the medic's own packs into the ally
    actor.medicTendTargetId = action.targetId;
    const ally = targetActor.entity;
    const wanted = Math.min(botMedicSettings.healAllyPerSecond * dt, Math.max(0, DUMMY_MAX_HEALTH - (ally.health ?? DUMMY_MAX_HEALTH)));
    const applied = drawFromPacks(actor.healthPacks, wanted);
    ally.health = Math.min(DUMMY_MAX_HEALTH, (ally.health ?? DUMMY_MAX_HEALTH) + applied);
    if (applied > 0) sealBotWounds(ally);
    // Topped back up by the medic: drop the ally's own heal-retreat latch so it doesn't flee once released.
    if ((ally.health ?? DUMMY_MAX_HEALTH) / DUMMY_MAX_HEALTH >= botHealthSettings.resume01 && targetActor.healRequested) {
      targetActor.healRequested = false; targetActor.healArrived = false; targetActor.healSafetySince = null;
      targetActor.healThreatId = null; targetActor.healStartedAt = null;
    }
    if (!hasHealResource(actor.healthPacks)) recordBotEvent(actor, `out of charge tending ${ally.id}`, now);
  }

  // v3:10765
  function _mcVisit(e) {
    const other = e.botActor;
    if (!other || other === _mcActor || e.team !== _mcTeam || other.role === ROLE_MEDIC) return;
    _mcOut.push({ x: e.capsule.start.x, z: e.capsule.start.z });
  }

  // v3:10774
  function updateSquadFormationMovement(now) {
    const actor = activeBotActor;
    const squad = actor.squadId ? squads.get(actor.squadId) : null;
    if (!squad?.hasLeaderPos || !(actor.squadRank > 0)) return false;
    const goal = squadMemberGoal({
      kind: squad.kind, leaderPos: squad.leaderPos, headingRad: squad.leaderYaw,
      rank: actor.squadRank, count: squad.liveCount, spacing: botSquadSettings.spacing,
      selfPos: botXZInto(bot, _squadSelfXZ), arriveRadius: botSquadSettings.slotArrive,
      leash: botSquadSettings.leash,
    });
    if (!goal) return false;
    if (goal.arrived) {
      // Holding the slot is correct while the squad is doing something. It is not correct forever: a
      // follower's movement is entirely parasitic on its leader, so a leader that stops moving used to
      // freeze its whole squad for the rest of the session with no timeout anywhere (bot-52 in the
      // 07-29 take inherited a 4.5 m box this way from a leader stuck on patrolLocal). Past the cap the
      // follower stops holding and falls through to its own patrol, and the squad re-forms the moment
      // the leader moves again.
      const held = (actor.squadHoldSince ??= now);
      if (now - held > SQUAD_HOLD_MAX_MS) {
        if (!actor.squadHoldBroken) { actor.squadHoldBroken = true; botDiag.squadHoldBroken++; }
        if (pathMode === 'squad') { pathMode = null; currentPath = []; botCombatMoveGoal = null; }
        return false;   // let updatePatrolMovement give this bot something of its own to do
      }
      bot.velocity.x = 0; bot.velocity.z = 0;
      if (pathMode === 'squad') { pathMode = null; currentPath = []; botCombatMoveGoal = null; }
      return true;   // in place: hold the slot rather than falling through to a patrol goal
    }
    actor.squadHoldSince = null;   // moving to a slot is not holding one
    actor.squadHoldBroken = false;
    const stale = pathMode !== 'squad' || !botCombatMoveGoal || currentPath.length === 0 ||
      Math.hypot(botCombatMoveGoal.x - goal.x, botCombatMoveGoal.z - goal.z) > botSquadSettings.slotRepath;
    let refused = false;
    if (stale) {
      const fresh = requestPathBudgeted(bot, goal, now);
      if (fresh) { currentPath = fresh; pathMode = 'squad'; botCombatMoveGoal = { x: goal.x, z: goal.z }; }
      else refused = true;   // throttled: keep the stale path, retry when the cooldown clears
    }
    if (currentPath.length === 0) {
      if (refused) { bot.velocity.x = 0; bot.velocity.z = 0; return true; }
      pathMode = null; botCombatMoveGoal = null; return false;   // slot unreachable: patrol instead
    }
    if (followPath(bot, currentPath, currentBotMoveSpeed())) { pathMode = null; botCombatMoveGoal = null; }
    return true;
  }

  // v3:10822
  function updateMedicCohesionMovement(now) {
    const actor = activeBotActor;
    const selfXZ = botXZ(bot);
    // Anchor on the fighting line, not on other support: exclude fellow medics so two medics don't
    // pair-bond and drift off together. An all-medic team simply has no cohesion pull.
    const teammates = [];
    // cohesionTarget only counts teammates inside cohesionNeighborRadius, so that's the covering query.
    _mcActor = actor; _mcTeam = bot.team; _mcOut = teammates;
    botHash.forEachNear(selfXZ.x, selfXZ.z, MEDIC_DEFAULTS.cohesionNeighborRadius, _mcVisit);
    _mcActor = null; _mcOut = null;
    const goal = cohesionTarget(selfXZ, teammates, MEDIC_DEFAULTS);
    if (!goal) { if (pathMode === 'cohesion') { pathMode = null; currentPath = []; botCombatMoveGoal = null; } return false; }
    const stale = pathMode !== 'cohesion' || !botCombatMoveGoal || currentPath.length === 0 ||
      Math.hypot(botCombatMoveGoal.x - goal.x, botCombatMoveGoal.z - goal.z) > 1.0;
    let refused = false;
    if (stale) {
      const fresh = requestPathBudgeted(bot, goal, now);
      if (fresh) { currentPath = fresh; pathMode = 'cohesion'; botCombatMoveGoal = { x: goal.x, z: goal.z }; }
      else refused = true; // throttled: keep the stale path/goal, retry when the cooldown clears
    }
    if (currentPath.length === 0) {
      if (refused) { bot.velocity.x = 0; bot.velocity.z = 0; return true; } // hold, don't drop the regroup
      pathMode = null; botCombatMoveGoal = null; return false;
    }
    if (followPath(bot, currentPath, currentBotMoveSpeed())) { pathMode = null; botCombatMoveGoal = null; }
    return true;
  }

  // v3:10865
  function updateCommandMovement(now) {
    const actor = activeBotActor;
    if (!commandGoal || actor.id !== commandTargetId) return false;
    const here = botXZ(bot);
    if (Math.hypot(here.x - commandGoal.x, here.z - commandGoal.z) <= COMMAND_ARRIVE_M) {
      bot.velocity.x = 0; bot.velocity.z = 0;
      if (pathMode === 'command') { pathMode = null; currentPath = []; botCombatMoveGoal = null; }
      if (commandGoalState === 'hold') return true;   // parked: keep holding this exact spot indefinitely
      commandGoal = null; commandTargetId = null;
      return false;   // arrived: fall through to formation/patrol this same frame
    }
    const stale = pathMode !== 'command' || !botCombatMoveGoal || currentPath.length === 0 ||
      Math.hypot(botCombatMoveGoal.x - commandGoal.x, botCombatMoveGoal.z - commandGoal.z) > 1.0;
    let refused = false;
    if (stale) {
      const fresh = requestPathBudgeted(bot, commandGoal, now);
      if (fresh) { currentPath = fresh; pathMode = 'command'; botCombatMoveGoal = { x: commandGoal.x, z: commandGoal.z }; }
      else refused = true;
    }
    if (currentPath.length === 0) {
      if (refused) { bot.velocity.x = 0; bot.velocity.z = 0; return true; }
      pathMode = null; botCombatMoveGoal = null; return false;
    }
    if (followPath(bot, currentPath, currentBotMoveSpeed())) { pathMode = null; botCombatMoveGoal = null; }
    return true;
  }

  // v3:10899
  function garrisonMarkerFor(actor) {
    if (!botGarrisonEnabled || !actor?.squadId) return null;
    const squad = squads.get(actor.squadId);
    if (!squad?.garrisonMarkerId) return null;
    return spawnMarkerById(spawnMarkers, squad.garrisonMarkerId);
  }

  // v3:10913
  function clampBotGoalToGarrison(actor, goal) {
    const marker = goal && garrisonMarkerFor(actor);
    return marker ? clampToGarrison(marker, goal, GARRISON_CHASE_SLACK) : goal;
  }

  // v3:10917
  function updateGarrisonMovement(now) {
    const actor = activeBotActor;
    const marker = garrisonMarkerFor(actor);
    if (!marker) return false;
    const squad = squads.get(actor.squadId);
    // squadRank is restamped every tick with 0 = leader, so the ring assignment is stable per bot.
    const rank = actor.squadRank > 0 ? actor.squadRank : 0;
    const slot = garrisonSlot(marker, rank, Math.max(1, squad.liveCount), _garrisonSlot);
    const here = botXZ(bot);
    if (Math.hypot(here.x - slot.x, here.z - slot.z) <= GARRISON_ARRIVE_M) {
      bot.velocity.x = 0; bot.velocity.z = 0;
      if (pathMode === 'garrison') { pathMode = null; currentPath = []; botCombatMoveGoal = null; }
      return true;   // parked on the marker; never falls through to patrol
    }
    const stale = pathMode !== 'garrison' || !botCombatMoveGoal || currentPath.length === 0 ||
      Math.hypot(botCombatMoveGoal.x - slot.x, botCombatMoveGoal.z - slot.z) > 1.0;
    let refused = false;
    if (stale) {
      const fresh = requestPathBudgeted(bot, slot, now);
      if (fresh) { currentPath = fresh; pathMode = 'garrison'; botCombatMoveGoal = { x: slot.x, z: slot.z }; }
      else refused = true;
    }
    // An unreachable slot still holds the bot here: patrolling away from a garrison it cannot path
    // back to is strictly worse than standing on the spot it already occupies.
    if (currentPath.length === 0) {
      bot.velocity.x = 0; bot.velocity.z = 0;
      if (!refused) { pathMode = null; botCombatMoveGoal = null; }
      return true;
    }
    if (followPath(bot, currentPath, currentBotMoveSpeed())) { pathMode = null; botCombatMoveGoal = null; }
    return true;
  }

  // v3:11000
  function resetAimAcquisition(actor) {
    if (!actor) return;
    actor.aimContactAt = null;
    actor.aimReadyAt = 0;
    actor.aimLostAt = null;
    actor.aimTargetId = null;
  }

  // v3:11013
  function primeAimAcquisition(actor, now) {
    if (actor?.aimContactAt != null) {
      actor.aimPrimedUntil = now + AIM_PRIMED_WINDOW_MS;
      actor.aimResetAt = now; // POV HUD flashes the ring grey so a torn-down acquisition is visible
    }
  }

  // v3:11020
  function updateAimAcquisition(now, dt, visible, distance) {
    const actor = activeBotActor;
    if (!actor) return;
    actor.spreadBloomDeg = decayBloomDeg(actor.spreadBloomDeg, dt, botAimSettings);
    const targetId = botTarget?.id ?? null;
    if (!visible) {
      if (actor.aimContactAt == null) return;
      actor.aimLostAt ??= now;
      if (now - actor.aimLostAt > botAimSettings.reacquireGraceMs) {
        primeAimAcquisition(actor, now);
        resetAimAcquisition(actor);
      }
      return;
    }
    actor.aimLostAt = null;
    if (actor.aimContactAt != null && actor.aimTargetId === targetId) return;
    // Fresh contact: pay the delay once. The alert tier is a frame old (same convention as A6);
    // taking fire personally counts as alerted even before any squad report scores a tier.
    actor.aimTargetId = targetId;
    actor.aimContactAt = now;
    actor.aimReadyAt = now + reactionDelayMs(distance, {
      alerted: !!actor.alertTierLast || now - (actor.lastSelfThreatAt ?? -Infinity) < AIM_UNDER_FIRE_MS,
      primed: now < (actor.aimPrimedUntil ?? 0),
      jitter01: Math.random(),
    }, botAimSettings);
  }

  // v3:11052
  function botAimReady(now) {
    if (!botAimSettings.reactionEnabled || !activeBotActor) return true;
    return activeBotActor.aimContactAt != null && now >= activeBotActor.aimReadyAt;
  }

  // v3:11088
  function updateBotSentry(dt, now) {
    if (!bot || bot.alive === false) {
      botState = BOT_PATROL; botTargetVisible = false; botTargetDistance = Infinity; botTargetVisGate = '-'; losLine.visible = false;
      pathMode = null; currentPath = []; lastKnownTarget = null; lastKnownTargetMotion = null; lastKnownTargetAt = null; clearMuzzleRecoveryEpisode();
      botInvestigation = null; botPatrolResumeGoal = null; botCombatMoveGoal = null;
      // Drop a half-thrown grenade so a revived bot doesn't resume it against a stale aim point.
      if (activeBotActor) { activeBotActor.grenadeThrow = null; clearGrenadeEvade(activeBotActor); }
      return;
    }
    const _sp0 = performance.now();
    const _st = _sp0;
    selectBotTarget();
    simSelMs += performance.now() - _st;
    // A miss streak is evidence about ONE opponent: a new target starts clean.
    const sentryTargetId = botTarget?.id ?? null;
    if (activeBotActor.lastTargetId !== sentryTargetId) {
      activeBotActor.lastTargetId = sentryTargetId;
      activeBotActor.lastTargetSeenAt = null;
      botMissStreak = 0;
      activeBotActor.voiceContactId = null;             // a new opponent is a new call-out
      resetVisibleDebounce(activeBotActor.visDebounce); // occlusion grace describes one opponent only
      primeAimAcquisition(activeBotActor, now);         // a retarget is an attention shift, not a fresh fight
      resetAimAcquisition(activeBotActor);              // ...but the paid-for acquisition still describes one opponent
    }
    let visible = false, err = Infinity, targetYaw = bot.yaw, targetPitch = bot.pitch, targetDistance = Infinity;
    botTargetVisGate = '-'; // no live target this frame unless the block below runs
    updateBotReload(now, true);
    if (botTarget?.alive) {
      const botEye = eyePosInto(bot, _sentryEye);
      const targetEye = eyePosInto(botTarget, _sentryTargetEye);
      losLine.visible = true;
      const posAttr = losGeom.attributes.position;
      posAttr.setXYZ(0, botEye.x, botEye.y, botEye.z);
      posAttr.setXYZ(1, targetEye.x, targetEye.y, targetEye.z);
      posAttr.needsUpdate = true;
  
      const dist = botEye.distanceTo(targetEye);
      targetDistance = dist;
      botTargetVisGate = 'r'; // beyond sight range unless the tests below resolve it
      if (dist <= botSightDistance() && dist > 1e-4) {
        const dir = _sentryDir.copy(targetEye).sub(botEye).multiplyScalar(1 / dist);
        let blocked;
        if (!BOT_CONFIRM_STRIDE) {
          blocked = mapCollider.raycast([botEye.x, botEye.y, botEye.z], [dir.x, dir.y, dir.z], dist - 0.05);
        } else {
          // Alternating cast/reuse per bot; a target change always pays for a fresh ray.
          const cs = activeBotActor.confirmRay ??= { fresh: false, blocked: false, targetId: null };
          if (cs.targetId !== botTarget.id || !cs.fresh) {
            cs.blocked = !!mapCollider.raycast([botEye.x, botEye.y, botEye.z], [dir.x, dir.y, dir.z], dist - 0.05);
            cs.targetId = botTarget.id;
            cs.fresh = true;
          } else {
            cs.fresh = false;
          }
          blocked = cs.blocked;
        }
        const inFov = withinBotFov(bot.yaw, botEye, targetEye);
        visible = !blocked && inFov;
        botTargetVisGate = visible ? 'y' : blocked ? 'w' : 'f'; // wall beats FOV when both reject
      }
      losLine.material.color.setHex(visible ? 0x30a46c : 0x8a3a3a);
      if (visible) {
        botInvestigation = null;
        botPatrolResumeGoal = null;
        lastKnownTarget = botXZ(botTarget);
        lastKnownTargetAt = now;
        // S2: call the contact out to the squad on RAW acquisition (recordContact rate-limits the ring).
        _contactMe.id = bot.id; _contactMe.team = bot.team;
        _contactMe.x = bot.capsule.start.x; _contactMe.z = bot.capsule.start.z;
        recordContact(allyAgg().contacts, _contactMe, lastKnownTarget, now, pushAllyReport, botTarget.id);
        sayBotContact(activeBotActor, bot, botTarget.id, now);
        const targetSpeed = Math.hypot(botTarget.velocity.x, botTarget.velocity.z);
        if (targetSpeed > 0.05) {
          lastKnownTargetMotion = { x: botTarget.velocity.x / targetSpeed, z: botTarget.velocity.z / targetSpeed };
        }
        // D: lead a moving target by the round's flight time. Hitscan weapons get no lead at all --
        // an instant round aimed ahead is a guaranteed miss -- so this only bites on rockets/grenades.
        const flightWeapon = currentBotWeapon();
        const lead = aimLeadSeconds(dist,
          flightWeapon?.mode === 'projectile' ? flightWeapon.projectile?.speed : 0, botAimBlend);
        const aimAt = lead > 0 && botTarget.velocity
          ? _leadAimPoint.copy(targetEye).addScaledVector(botTarget.velocity, lead) : targetEye;
        const angles = aimAnglesTo(botEye, aimAt, _aimAngles);
        targetYaw = angles.yaw;
        targetPitch = angles.pitch;
        botAimTarget.yaw = targetYaw;
        botAimTarget.pitch = targetPitch;
        botAimPoint.copy(aimAt);
        botHasAimPoint = true;
        err = aimError(bot.yaw, bot.pitch, targetYaw, targetPitch);
      }
    } else {
      losLine.visible = false;
      botHasAimPoint = false;   // never solve the barrel onto a dead/removed target's last position
      // No live target remains. This is not a failed navigation: discard the stale frontier rather
      // than having a bot investigate the last position of a dead/removed dummy. A report-seeded
      // anchor survives (it never described an entity); finishInvestigation retires it instead.
      if (!lastKnownTarget?.fromReport) {
        lastKnownTarget = null;
        lastKnownTargetMotion = null;
        lastKnownTargetAt = null;
        botInvestigation = null;
      }
      botMissStreak = 0; // fresh engagement starts with a clean slate
      resetVisibleDebounce(activeBotActor.visDebounce); // grace never outlives its target
    }
    botTargetVisible = visible;
    botTargetDistance = targetDistance;
    // Ladder-only debounce: a sub-250ms occlusion flicker must not tear down AIM into SEEK (and a
    // frontier rebuild); aiming/firing keep using raw `visible` -- you cannot shoot the occluded.
    const visibleSettled = stepVisibleDebounce(activeBotActor.visDebounce ??= { lastTrueAt: null }, visible, now);
    // Sight lost long enough that the shots which built the streak no longer describe this fight.
    if (visible) activeBotActor.targetUnseenSince = null;
    else if (botTarget?.alive) activeBotActor.targetUnseenSince ??= now;
    if (visible) activeBotActor.lastTargetSeenAt = now;
    else if (activeBotActor.lastTargetSeenAt != null && now - activeBotActor.lastTargetSeenAt > MISS_STREAK_SIGHT_RESET_MS) {
      activeBotActor.lastTargetSeenAt = null;
      botMissStreak = 0;
    }
    // A brief occlusion (cover, a teammate stepping into the sightline, the target ducking) is not
    // "lost the enemy" -- it happens constantly mid-fight, and MISS_STREAK_SIGHT_RESET_MS (1.5s) is
    // tuned for the miss streak, not for whether a re-sighting is actually news. Re-arming the
    // callout on that same short timer meant "contact!" repeated every few seconds for the length of
    // an entire firefight against one enemy who was never actually lost. Use the same bar target
    // SELECTION already uses for "has this target gone stale" (TARGET_RETAIN_MAX_MS) instead, so the
    // voice line and the AI agree on what counts as a genuine re-acquire.
    if (!visible && activeBotActor.voiceContactId != null && activeBotActor.targetUnseenSince != null
        && now - activeBotActor.targetUnseenSince > TARGET_RETAIN_MAX_MS) {
      activeBotActor.voiceContactId = null;
    }
    // A10: age the recognition timer and let recoil bloom recover. Raw `visible`, not the debounced
    // ladder value -- you cannot acquire what you cannot see.
    updateAimAcquisition(now, dt, visible, targetDistance);
    // --- health packs: collect anything underfoot, then decide whether to go seek a dropped pack ---
    collectPacksUnderfoot(bot, activeBotActor, now);
    const hp01 = (bot.health ?? DUMMY_MAX_HEALTH) / DUMMY_MAX_HEALTH;
    const wantsHeal = botHealRequested || hp01 <= botHealthSettings.threshold01; // "hurt" -> ignores proximity limit
    const hasPack = hasHealResource(activeBotActor?.healthPacks);
    // Go get a pack when either wounded-and-empty (survival, at any visible range) or healthy-with-room
    // (opportunistic top-up, only when close). A wounded bot that already holds a pack heals instead.
    const wantsPack = wantsHeal ? !hasPack : canHold(activeBotActor?.healthPacks, activeBotActor?.maxPacks);
    // Claim only from a state that will actually walk to the pack (last tick's state: one-tick lag
    // beats phantom claims from FIRE/COVER that starve wounded bots), and never via a run that
    // closes on the live threat (the commonest pack source is a corpse at the enemy's feet).
    const packThreat = botTarget?.alive ? botTarget.capsule.start : lastKnownTarget;
    let seekable = (wantsPack && packClaimIntent(botState, wantsHeal, hasPack))
      ? nearestSeekablePack(bot, activeBotActor, wantsHeal) : null;
    if (seekable && !packRunSafe(bot.capsule.start, seekable.record, packThreat)) seekable = null;
    activeBotActor.packSeekGoal = seekable ? { x: seekable.record.x, z: seekable.record.z } : null;
    if (seekable) {
      const packCell = worldToCellInto(navGrid, seekable.record.x, seekable.record.z, _packCell);
      goalClaims.claim(bot.id, 'pack', cellIdxOf(packCell.c, packCell.r));
    } else {
      goalClaims.release(bot.id, 'pack');
    }
    const healStatus = updateHealSafety(now, visible, targetDistance);
    // A wounded, packless bot that reached safety with no pack in sight gives up on healing and
    // rejoins the fight (a later hit re-triggers the retreat). Avoids a permanent packless flee-lock.
    if (botHealRequested && !hasPack && !seekable && healStatus.ready) {
      recordBotEvent(activeBotActor, 'heal abandoned: safe but no pack available', now);
      clearBotHealthRetreat();
    }
    if (botHealRequested && botHealArrived && healStatus.unsafe) {
      // The first retreat cell did not actually break danger. Keep the health intent, but
      // release that arrival latch so FLEE selects the next (preferably covered) nav goal.
      recordBotEvent(activeBotActor, `heal-flee retry: visible ${botTarget?.id ?? 'target'} at ${targetDistance.toFixed(2)}m`, now);
      botHealArrived = false;
      botHealSafetySince = null;
      currentPath = [];
      pathMode = null;
      botCombatMoveGoal = null;
    }
    if (botHealRequested && botMuzzleRecoveryTarget) clearMuzzleRecoveryEpisode();
    if (botMuzzleRecoveryTarget) {
      if (updateMuzzleRecoveryMovement()) {
        // Repositioning abandons the previous errand: free its claims so others can use them,
        // and let a dry mag reload during the walk (the early return skips the tail call).
        goalClaims.release(bot.id, 'flee');
        goalClaims.release(bot.id, 'seek');
        if (activeBotActor.coverCorner) releaseCoverCorner();
        botState = 'reposition';
        recordBotStateChange(activeBotActor, botState, now);
        faceMovement(dt);
        updateBotReload(now);
        senAMs += performance.now() - _sp0;   // early exit still closes its phase
        return;
      }
    }
  
    // Sidearm slot, decided before anything reads the weapon: a dry mag with someone shooting means
    // draw the pistol, not stand there reloading. "In a gunfight" outlives line of sight by the lull
    // window -- an enemy that just ducked behind a corner is still an enemy.
    const contactAgeMs = lastKnownTargetAt != null ? now - lastKnownTargetAt : Infinity;
    const inGunfight = visible || contactAgeMs < SIDEARM_LULL_MS ||
      now - (activeBotActor.lastSelfThreatAt ?? -Infinity) < SIDEARM_LULL_MS;
    updateBotWeaponSlot(now, inGunfight, targetDistance);
    const swapping = botSwapping(now);
  
    const ammo = ensureBotAmmo();
    // botAimReady is the A10 recognition gate: seeing a target is no longer the same as being able
    // to shoot it. The FSM still reads `visible`, so a bot mid-delay still turns, closes, and takes cover.
    const readyToFire = visible && botAimReady(now) && botReloadUntil == null && !swapping && ammo.mag > 0 &&
      (now - lastShotAt >= currentBotWeapon().fireIntervalMs);
    // Out of ammo means BOTH guns: a dry rifle with a loaded pistol is still a fighting bot.
    const attackerOutOfAmmo = botOutOfAllAmmo();
    // No distance gate: a dry bot with a knife charges (updateKnifeMovement closes the gap); the old gate left far bots camping AIM.
    // Backstop: the knife rung outranks nearly the whole ladder, so a charge that never lands must expire.
    // One bot held it 652 s against a target a median 43 m away, 0% of samples ever inside blade range.
    if (botState !== BOT_KNIFE) { activeBotActor.knifeSince = null; }
    else {
      activeBotActor.knifeSince ??= now;
      const knife = getWeapon('knife');
      if (knife && targetDistance > knife.range * 3) botDiag.knifeOutOfReach++;
      if (now - activeBotActor.knifeSince > KNIFE_COMMIT_MAX_MS) {
        activeBotActor.knifeBlockUntil = now + KNIFE_COMMIT_COOLDOWN_MS; // else it re-enters next frame
        activeBotActor.knifeSince = null;
        botDiag.knifeTimeout++;
      }
    }
    const knifeBlocked = now < (activeBotActor.knifeBlockUntil ?? -Infinity);
    const knifeRequested = botKnifeSecondaryEnabled && visible && !botHealRequested && botReloadUntil == null && attackerOutOfAmmo && !knifeBlocked;
    // A selected flee path is an active action. Keep it intact until followPath reaches its
    // terminal waypoint; transient LOS loss may change perception, but not the committed route.
    const fleeCommitted = botState === BOT_FLEE && pathMode === 'flee' &&
      currentPath.length > 0 && !!botCombatMoveGoal;
    const previousState = botState;
    const pursueHealthOk = (bot.health ?? DUMMY_MAX_HEALTH) / DUMMY_MAX_HEALTH > botBehaviorSettings.pursueHealthThreshold01;
    const spreadSeed = (activeBotActor.spreadSeed ??= botSeedFromId(activeBotActor.id));
    // L6: per-bot break threshold so a squad whiffing on one target doesn't all charge on one tick.
    const keepsMissing = botMissStreak >= pursueBreakThreshold(botBehaviorSettings.pursueMissStreak, spreadSeed);
    // Weapon-linked engagement band: a longer-range gun holds a farther standoff. The standoff is
    // both where pursue stops (start firing) and the movement goal; the bot kites back (flee) once
    // an enemy crosses inside half of it.
    botCombatStandoff = botWeaponStandoff(currentBotWeapon());
    const weaponFleeDistance = Math.max(botBehaviorSettings.fleeDistance, botCombatStandoff * botBehaviorSettings.fleeStandoffFraction);
    // --- cover: validate/repair the committed corner, then probe for a fresh one (entry) ---
    // Threat = the engaged target (last-known while occluded), else a nearby ally's attacker.
    // A casualty report arrives firsthand (seen within ALLY_ALERT_RADIUS) or secondhand (relayed
    // by an alerted teammate in contact range); the response is source-blind, tiered purely by
    // the escalation score: wary flinch / defensive hold+cover / group-backed push on the threat.
    const firsthand = latestAllyHitNear(bot, now);
    activeBotActor.alertReport = firsthand; // firsthand only: semi-alerts propagate one hop
    const report = firsthand || sharedAllyAlertNear(bot, now);
    _escMe.x = bot.capsule.start.x; _escMe.z = bot.capsule.start.z; _escMe.team = bot.team;
    const esc = alertEscalation(allyAgg().casualties, _escMe, now, ESCALATION_RADIUS);
    senAMs += performance.now() - _sp0;   // phase boundary: perception done
    const _sp1 = performance.now();
    let alertTier = null;
    if (report) {
      activeBotActor.alertWarySince ??= now;
      if (esc.score >= ALERT_PUSH_SCORE && livingTeammatesNear(bot, SUPPORT_RADIUS) >= SUPPORT_GROUP_MIN) {
        alertTier = 'push';
        if (!lastKnownTarget) {
          lastKnownTarget = { x: report.threat.x, z: report.threat.z, fromReport: true };
          lastKnownTargetAt = report.at;
          lastKnownTargetMotion = null;
        }
        applyPushElement(now, report.threat, visible);
      } else if (esc.score >= ALERT_DEFENSIVE_SCORE) {
        alertTier = 'defensive';
      } else if (now - activeBotActor.alertWarySince < SEMI_ALERT_WARY_MS) {
        alertTier = 'wary';
      }
    } else {
      activeBotActor.alertWarySince = null;
    }
    if (alertTier !== 'push') { activeBotActor.pushStartedAt = null; activeBotActor.pushElement = null; }
    // Weakest cue, only when nothing stronger is live: a round that whistled past this bot itself.
    // Firsthand but not a casualty — it drives the alert hold only (no cover break, no propagation).
    const nearMiss = alertTier ? null : latestNearMiss(allyAgg().nearMisses, bot, now);
    // Being shot AT or HIT myself: the one cue no tier may suppress and no state may ignore. Drives
    // facing everywhere (see threatFacing), so a bot mid-heal still turns on whoever is shooting it.
    const selfThreat = latestSelfThreat(allyAgg().nonContacts, bot, now);
    if (selfThreat) {
      activeBotActor.lastSelfThreatAt = now; // read next frame by the sidearm "in a gunfight" test
      (activeBotActor.lastSelfThreatXZ ??= { x: 0, z: 0 }).x = selfThreat.threat.x; // copied: the report record is pooled
      activeBotActor.lastSelfThreatXZ.z = selfThreat.threat.z;
    }
    // H6a: shot from inside CLOSE_THREAT_RADIUS but outside the cone -- spin onto it, preempting a
    // committed aim. Latched until nearly aimed (not merely in-cone), or yaw parks at the cone edge.
    const closeThreatNear = !!selfThreat?.threat &&
      Math.hypot(selfThreat.threat.x - bot.capsule.start.x, selfThreat.threat.z - bot.capsule.start.z) <= CLOSE_THREAT_RADIUS;
    let closeSelfThreat = false;
    if (closeThreatNear) {
      const threatYaw = Math.atan2(selfThreat.threat.x - bot.capsule.start.x, selfThreat.threat.z - bot.capsule.start.z);
      if (!withinBotFov(bot.yaw, bot.capsule.start, selfThreat.threat)) activeBotActor.spinLatched = true;
      if (activeBotActor.spinLatched) closeSelfThreat = aimError(bot.yaw, 0, threatYaw, 0) > 0.4;
      if (!closeSelfThreat) activeBotActor.spinLatched = false;
    } else {
      activeBotActor.spinLatched = false;
    }
    activeBotActor.alertMarkMode = alertTier === 'push' ? (activeBotActor.pushElement === 'base' ? 'base' : 'push')
      : alertTier ? (firsthand ? 'seen' : 'heard') : nearMiss ? 'near' : null;
    activeBotActor.alertScore = alertTier ? esc.score : 0;
    activeBotActor.alertTierLast = alertTier; // A10 reads it next frame: an alerted bot reacts faster
    // A6: the perceptual half of the tier (wider cone, shorter scan stride); read next frame by
    // withinBotFov/selectBotTarget, so a fresh tier widens perception one frame late.
    perceptionForTier(alertTier, activeBotActor.tierPerception ??= { fovDegrees: null, scanStride: null });
    const { coverAlert, holdAlert } = alertTierChannels(alertTier, report, _tierChannels);
    // Shot from an unseen bearing: seed the search anchor so the SEEK machinery, not patrol, runs next.
    // Near misses stay facing-only cues; an anchor at the bot's own feet (own blast splash) is noise.
    if (selfThreat && selfThreat.kind !== NEAR_MISS_KIND && !visible && !lastKnownTarget
        && Math.hypot(selfThreat.threat.x - bot.capsule.start.x, selfThreat.threat.z - bot.capsule.start.z) > 1.5) {
      lastKnownTarget = { x: selfThreat.threat.x, z: selfThreat.threat.z, fromReport: true };
      lastKnownTargetAt = selfThreat.at;
      lastKnownTargetMotion = null;
    }
    // S2: a squadmate's sighting is the weakest lead -- it only fills a slot nothing firsthand holds.
    _contactMe.id = bot.id; _contactMe.team = bot.team;
    _contactMe.x = bot.capsule.start.x; _contactMe.z = bot.capsule.start.z;
    const contact = latestContactNear(allyAgg().contacts, _contactMe, now, CONTACT_SHARE_RADIUS);
    if (!lastKnownTarget && contact && now >= (activeBotActor.contactSeedBlockUntil ?? 0)) {
      lastKnownTarget = { x: contact.threat.x, z: contact.threat.z, fromReport: true };
      lastKnownTargetAt = contact.at;
      lastKnownTargetMotion = null;
    }
    let coverThreat = botTarget?.alive ? (visible ? botXZInto(botTarget, _coverThreatXZ) : lastKnownTarget) : null;
    // An ally-reported shooter is out of the bot's own engagement: skip the weapon band gates for
    // it (a distant hallway shooter must still drive nearby squadmates to corners, not past them).
    const threatIsAllyReport = !coverThreat && (!!coverAlert || !!contact);
    if (!coverThreat && coverAlert) coverThreat = coverAlert.threat;
    if (!coverThreat && contact) coverThreat = contact.threat;
    // H6b: the corner veto's second shooter -- nearest other acquirable enemy, else a contact report
    // describing someone clearly elsewhere. Only computed when a cover query can actually use it.
    const secondaryThreat = coverThreat ? secondVisibleThreat(coverThreat, contact) : null;
    let coverCommitted = (botState === BOT_COVER_MOVE || botState === BOT_COVER_HOLD) && !!activeBotActor.coverCorner;
    let coverValid = false;
    const botHere = botXZInto(bot, _botHereXZ);
    const coverThreatDist = coverThreat ? Math.hypot(coverThreat.x - botHere.x, coverThreat.z - botHere.z) : Infinity;
    const coverGate = activeBotActor.coverGate;
    if (coverCommitted) {
      // Timeout measures time TRAVELING to the anchor (coverMoveSince), not time since commit --
      // a long-held corner nudged by ally pushout must not read as an instantly-expired commit.
      const timedOut = botState === BOT_COVER_MOVE && coverCommitTimedOut(activeBotActor.coverMoveSince, now);
      // Out-of-band threat: fall through the ladder so pursue can close the gap (no re-pick).
      const inBand = threatIsAllyReport || coverInBand(coverThreatDist, botCombatStandoff, true, botBehaviorSettings.pursueExitBuffer);
      // Wall-clock exits: 'stale' = live threat unseen too long (go investigate), 'drought' = held without a shot (blacklist).
      const lastSeenMs = Math.max(lastKnownTargetAt ?? -Infinity, report?.at ?? -Infinity);
      const holdExit = coverHoldExitReason({ nowMs: now,
        holdSinceMs: botState === BOT_COVER_HOLD ? activeBotActor.coverHoldSince : null,
        lastShotAtMs: lastShotAt, lastSeenAtMs: Number.isFinite(lastSeenMs) ? lastSeenMs : null,
        targetVisible: visible, targetAlive: !!botTarget?.alive,
        // S8: a squadmate dying from a materially different bearing means this corner faces the wrong
        // way. Edge-triggered: each lethal report breaks a hold at most once, or a 2 s-fresh report
        // re-fires every frame, thrashing cover and resetting the drought clock forever.
        allyDownAt: report?.lethal && report.at > (activeBotActor.allyDownHandledAt ?? -Infinity) ? report.at : null,
        allyDownFrom: report?.threat ?? null,
        heldThreat: activeBotActor.coverThreat, holderPos: botHere });
      if (timedOut || !inBand || holdExit) {
        // Report-only threats exempt from the drought blacklist: no shots fired at a rumour is not a bad corner.
        if (timedOut || (holdExit === 'drought' && !threatIsAllyReport)) blacklistCover(activeBotActor.coverBlacklist, activeBotActor.coverCorner.anchorCell, now);
        if (holdExit === 'allyDown') {
          activeBotActor.allyDownHandledAt = report.at;
          coverThreat = report.threat; // the re-pick this frame hides from the bearing that broke the hold
        }
        releaseCoverCorner();
        coverCommitted = false;
      } else {
        // Debounced validity: sustained invalidity earns one cooldown-gated re-pick, then falls through.
        const g = stepCoverGate(coverGate, coverCornerValid(activeBotActor.coverCorner, coverThreat, secondaryThreat), now);
        coverValid = g.holdValid;
        if (coverValid && coverThreat) activeBotActor.coverThreat = { x: coverThreat.x, z: coverThreat.z };
        if (!coverValid && coverThreat && g.maySwitch) {
          const next = findCoverCorner(bot, coverThreat, secondaryThreat);
          if (next && next !== activeBotActor.coverCorner) { commitCoverCorner(next, coverThreat, now); coverValid = true; }
        }
        if (!coverValid) {
          releaseCoverCorner();
          coverCommitted = false;
        }
      }
    }
    // Entry needs an in-band threat and a clear switch cooldown (no instant re-entry after a thrash).
    // A probe that finds nothing also latches: noteCoverSwitch only stamps on a successful commit (M2).
    const coverEntryOk = !!coverThreat && (threatIsAllyReport || coverInBand(coverThreatDist, botCombatStandoff, false)) &&
      (visible || !!coverAlert || botReloadUntil != null) && // only probe when a ladder rung could consume it
      coverSwitchAllowed(coverGate, now) &&
      now - (activeBotActor.coverProbeFailedAt ?? -Infinity) >= COVER_PROBE_BACKOFF_MS;
    const coverProbe = !coverCommitted && coverEntryOk ? findCoverCorner(bot, coverThreat, secondaryThreat) : null;
    if (!coverCommitted && coverEntryOk && !coverProbe) activeBotActor.coverProbeFailedAt = now;
    const coverAvailable = coverCommitted || !!coverProbe;
    // An active peek slides the bot ~1.1m off the anchor; "at anchor" tracks the slide's expected
    // seat on the anchor->peek line so a mid-peek bot doesn't read as off-station and re-path.
    const coverSeat = activeBotActor.peek && activeBotActor.coverCorner
      ? peekPosition(activeBotActor.peek, activeBotActor.coverCorner.anchorPos, activeBotActor.coverCorner.peekPos)
      : activeBotActor.coverCorner?.anchorPos;
    // Banded seat test: enter at REACH, leave past LEAVE, so ally pushout can't flap HOLD<->MOVE.
    const atCoverAnchor = coverCommitted && !!coverSeat &&
      coverSeatBand(Math.hypot(coverSeat.x - botHere.x, coverSeat.z - botHere.z), botState === BOT_COVER_HOLD);
    // One reused ctx object per frame across all bots (M1): every field is overwritten below.
    const c = _fsmCtx;
    // A2: the ladder's AIM->FIRE rung reads the same error the trigger does, so the FIRE state means
    // the gun is on target rather than the eye is. Falls back to the entity error when the barrel has
    // nothing meaningful to measure (no mount, weapon still coming up).
    // Only measured on a visible target: the barrel ray costs two matrix walks, and with nothing in
    // sight `err` is already Infinity and the ladder never reaches the aim rung.
    const gateError = visible && botAimBlend.enabled !== false && botAimBlend.barrelGate !== false
      ? (botBarrelAimError() ?? err) : err;
    c.targetVisible = visibleSettled; c.aimError = gateError; c.readyToFire = readyToFire; c.hasLastKnown = !!lastKnownTarget;
    c.targetDistance = targetDistance; c.pursueDistance = botCombatStandoff;
    c.pursueExitBuffer = botBehaviorSettings.pursueExitBuffer;
    c.keepsMissing = keepsMissing; c.pursueHealthOk = pursueHealthOk;
    c.fleeDistance = weaponFleeDistance;
    c.fleeExitBuffer = botBehaviorSettings.fleeExitBuffer; c.fleeCommitted = fleeCommitted; c.knifeRequested = knifeRequested;
    c.healRequested = botHealRequested;
    c.healFleeCommitted = botHealRequested && botState === BOT_FLEE && pathMode === 'flee' && currentPath.length > 0;
    c.healReady = healStatus.ready; c.healUnsafe = healStatus.unsafe; c.hasHealResource = hasPack;
    c.coverAvailable = coverAvailable; c.atCoverAnchor = atCoverAnchor; c.coverValid = coverValid;
    c.allyHitNearby = !!coverAlert; c.coverCommitted = coverCommitted;
    // Break contact: this bot personally under the toggle, or squadmate of whichever bot is (mirrors
    // the doubleTime propagation below). See the orderOverride rung in bot-activity.js.
    c.orderOverride = commandBreakContact && !!commandGoal && (activeBotActor.id === commandTargetId ||
      (activeBotActor.squadId != null && activeBotActor.squadId === botActorById.get(commandTargetId)?.squadId));
    // The commit latches live only in this ctx; stash them so the state code can read them at commit time.
    activeBotActor.commitBits = (fleeCommitted ? LATCH_FLEE : 0) | (coverCommitted ? LATCH_COVER : 0)
      | (c.healFleeCommitted ? LATCH_HEAL_FLEE : 0);
    c.fireCapable = !attackerOutOfAmmo; c.knifeCapable = botKnifeSecondaryEnabled;
    c.closeSelfThreat = closeSelfThreat; c.reloading = botReloadUntil != null;
    // A9 top-off input (not a rung): nothing can shoot back while the target is unseen or we're tucked in.
    const concealedFromTarget = !visible || activeBotActor.peek?.phase === 'in';
    let state = chooseBotStateName(botState, c);
    senBMs += performance.now() - _sp1;   // phase boundary: alerts + cover choice done
    const _sp2 = performance.now();
    // H6a: that AIM is a spin onto whoever just shot us from behind, not onto botTarget.
    if (state === BOT_AIM && closeSelfThreat) {
      const eye = eyePosInto(bot, _sentryEye);
      _spinAt.set(selfThreat.threat.x, eye.y, selfThreat.threat.z);
      aimAnglesTo(eye, _spinAt, _aimAngles);
      targetYaw = _aimAngles.yaw; targetPitch = _aimAngles.pitch;
    }
    // Medic duty layers on top of the combat FSM: a medic breaks toward a wounded/fallen ally (and
    // still fires while moving/tending). Own-survival (flee/self-heal) and a committed kite-flee/knife
    // outrank it; cohesion is handled in the patrol branch below.
    if (activeBotActor.role === ROLE_MEDIC && !botHealRequested && state !== BOT_FLEE && state !== BOT_KNIFE) {
      const duty = decideMedicDuty(now, coverThreat || selfThreat?.threat || null);
      if (duty) state = duty.state;
    } else if (activeBotActor.role === ROLE_MEDIC) {
      activeBotActor.medicAction = null;
      activeBotActor.medicTendTargetId = null;
    }
    // Drone operator: the aircraft do the fighting (bot-drones.js), so this is a launch decision and
    // nothing else -- the operator keeps whatever state the ladder gave it and its role standoff is
    // what keeps it behind the line.
    if (activeBotActor.role === ROLE_DRONE_OPERATOR) tickDroneOperator(now, visible ? botTarget : null, lastKnownTarget);
    // Is this medic working a casualty under fire? Drives both the stance rung and the tend pose: gun
    // up and standing while anything is shooting, holstered and kneeling when the fight has moved on.
    // An enemy seen within MEDIC_TEND_COMBAT_MS still counts -- a lull is not the end of a firefight.
    if (activeBotActor.role === ROLE_MEDIC) {
      activeBotActor.tendUnderFire = !!(visible || selfThreat || coverThreat ||
        (activeBotActor.targetUnseenSince != null && now - activeBotActor.targetUnseenSince <= MEDIC_TEND_COMBAT_MS));
    }
    // Cover lifecycle before botState stamps: the invariant "cover state => committed corner" self-heals to an actionable state.
    if (state === BOT_COVER_MOVE || state === BOT_COVER_HOLD) {
      if (!activeBotActor.coverCorner && coverProbe) commitCoverCorner(coverProbe, coverThreat, now);
      if (!activeBotActor.coverCorner) state = visible ? BOT_AIM : (lastKnownTarget ? BOT_SEEK : BOT_PATROL);
    } else if (activeBotActor.coverCorner) {
      releaseCoverCorner();
    }
    // Squad alert (movement-level stamp like muzzle 'reposition'): a patroller with a fresh
    // ally-hit report holds where it stands, gun trained on the reported threat, until the alert
    // expires -- never walk blind into a live kill zone. Capped + cooled down in bot-alert.js as
    // a freeze backstop; cover/combat rungs above always outrank the hold.
    const alertSt = activeBotActor.alertHold ??= { holdSince: null, cooldownUntil: null };
    const alertThreat = holdAlert || nearMiss || selfThreat; // these orient, but never took a cover rung
    // Facing priority for every non-aiming state: whoever is shooting me outranks the errand I am on.
    const threatFacing = (fallback) => selfThreat?.threat || fallback || alertThreat?.threat || lastKnownTarget;
    // PATROL despite a live alert means the ladder found no better action (no corner, or dry gun).
    // Only hold where the reported threat cannot see us; standing exposed keeps whatever the ladder chose.
    let alertExposed = false;
    if (state === BOT_PATROL && !visible && alertThreat && visField && navGrid) {
      _alertBake.field = visField; _alertBake.navGrid = navGrid;
      alertExposed = exposedToThreat(_alertBake, botHere, alertThreat.threat);
    }
    const wantAlertHold = state === BOT_PATROL && !visible && !!alertThreat && !alertExposed;
    if (stepAlertHold(alertSt, wantAlertHold, now)) state = 'alert';
    // Servicing the drone is hands-on: the operator stops, kneels, and his squad waits for him. The
    // lease is re-granted every frame the drone is actually in his hands, so it lapses on its own.
    const servicingDrone = activeBotActor.role === ROLE_DRONE_OPERATOR && !visible &&
      now < (activeBotActor.droneServiceUntil ?? 0);
    if (servicingDrone) {
      markBotBusy(activeBotActor, BUSY_DRONE_SERVICE, now + DRONE_SERVICE_LEASE_MS);
      commandBotHold(activeBotActor, now + DRONE_SERVICE_LEASE_MS, 'service', activeBotActor.droneDockXZ);
    }
    // S15: hold for a squadmate who is mid-task. The busy member holds itself (above); this is
    // everyone else deciding not to walk away from it.
    const squadWait = squadHaltFor(activeBotActor, now);
    if (squadWait && squadWait.memberId !== activeBotActor.id) {
      const busyActor = botActorById.get(squadWait.memberId);
      commandBotHold(activeBotActor, Math.min(squadWait.until, now + 1000), 'wait',
        busyActor ? botXZ(busyActor.entity) : null);
    }
    // S13 hold, hoisted above the stance resolve (consumed again for locomotion below): a pinned bot
    // is stationary, which is exactly what the stance decider wants to know.
    const holding = activeBotActor.holdUntil > now &&
      (state === BOT_PATROL || state === BOT_SEEK || state === BOT_PURSUE);
    // Stance resolve: the one point where the final state is known and nothing has consumed it yet.
    // auto pick -> hysteresis latch -> UI force-override, then stamped on the actor for every seam.
    const forcedCrouch = state === BOT_HEAL ||
      activeBotActor.packPickupCrouchUntil > now;   // any self-heal + the brief pack-pickup dip
    activeBotActor.stanceForcedCrouch = forcedCrouch;
    let autoStance = STANCE_STAND;
    if (botStanceSettings.enabled) {
      const sc = _stanceCtx;  // one reused ctx across all bots (M1): every field is overwritten here
      sc.forcedCrouch = forcedCrouch;
      sc.holding = holding;
      sc.holdElapsedMs = holding && activeBotActor.holdSince != null ? now - activeBotActor.holdSince : 0;
      sc.peekPhase = activeBotActor.peek?.phase ?? null;
      sc.peekExposed = activeBotActor.peek ? peekExposed(activeBotActor.peek) : false;
      sc.targetVisible = visibleSettled;
      sc.targetDistance = targetDistance;
      sc.distanceToLastKnown = lastKnownTarget                       // no last-known point reads as "far"
        ? Math.hypot(lastKnownTarget.x - bot.capsule.start.x, lastKnownTarget.z - bot.capsule.start.z) : Infinity;
      sc.alertHeld = state === 'alert';
      // No medic fields here any more: every tend kneels, so the stance table needs nothing role-specific.
      // (That comment predated the kneel stance by a while; as of the kneel wiring it is literally true.)
      // `activeBotActor.tendUnderFire` still drives POSE selection (gun out vs holstered), just not posture.
      // Set by LAST frame's updateGrenadeEvade, which runs below this resolve. A self-expiring stamp
      // rather than a boolean: the evade handler early-returns once the threat list empties, so a flag
      // it owned would latch the dash on forever.
      sc.evading = activeBotActor.evadingUntil > now;
      // Read the LATCH's stance, not activeBotActor.stance (that's last frame's post-override value,
      // a few lines below) -- the hysteresis belongs to the auto decision, not a UI force-override.
      sc.alreadyCrouched = activeBotActor.stanceLatch?.stance === STANCE_CROUCH;
      sc.alreadyKneeling = activeBotActor.stanceLatch?.stance === STANCE_KNEEL;
      // Double time: this bot personally under the movement-style toggle, or squadmate of whichever bot is.
      sc.doubleTime = commandDoubleTime && !!commandGoal && (activeBotActor.id === commandTargetId ||
        (activeBotActor.squadId != null && activeBotActor.squadId === botActorById.get(commandTargetId)?.squadId));
      const desired = chooseBotStance(state, sc, botStanceSettings);
      const latch = activeBotActor.stanceLatch ??= { stance: STANCE_STAND, changedAt: now, blockedUntil: 0 };
      autoStance = stepStanceTransition(latch, desired, now, botStanceSettings);
    } else activeBotActor.stanceLatch = null;   // a disabled system carries no latch into a re-enable
    activeBotActor.stance = resolveStanceOverride(botStanceOverride, servicingDrone ? STANCE_KNEEL : autoStance);
    // Travel timer for the cover commit-timeout: stamped on every entry into COVER_MOVE.
    if (state === BOT_COVER_MOVE && botState !== BOT_COVER_MOVE) activeBotActor.coverMoveSince = now;
    else if (state !== BOT_COVER_MOVE) activeBotActor.coverMoveSince = null;
    updateBotVoiceState(activeBotActor, bot, botState, state, attackerOutOfAmmo, now); // before the stamp: needs both states
    botState = state;
    recordBotStateChange(activeBotActor, botState, now);
    if (state !== BOT_FLEE) goalClaims.release(bot.id, 'flee'); // any flee exit path frees the claimed cell
    if (state !== BOT_SEEK) goalClaims.release(bot.id, 'seek'); // same for a search cell the bot left
    if (state !== BOT_PURSUE) goalClaims.release(bot.id, 'pursue'); // S14: free the approach bearing
  
    // S13: a commanded hold -- a medic servicing this bot, or its own squad's base-of-fire element.
    // Only pure locomotion yields: AIM/FIRE/KNIFE and COVER_HOLD are already stationary, COVER_MOVE
    // resolves to a hold on its own, and the bot's own self-heal keeps priority. FLEE never yields --
    // a retreat under fire must not freeze the bot in the shooter's lane (the medic re-plans instead).
    // (`holding` is computed above the stance resolve, which reads it.)
    senCMs += performance.now() - _sp2;   // phase boundary: state resolution done
    const _sp3 = performance.now();
    let _dLabel = state;   // the branches below that aren't keyed on `state` relabel themselves
    // A live grenade outranks every other consideration; a wind-up outranks everything but that.
    if (updateGrenadeEvade(dt, now)) { _dLabel = 'gEvade'; }
    else if (updateGrenadeThrow(dt, now)) { _dLabel = 'gThrow'; }
    else if (holding) {
      _dLabel = 'hold';
      bot.velocity.x = 0; bot.velocity.z = 0;
      pathMode = null; currentPath = []; botCombatMoveGoal = null;
      if (visible) {
        faceAimDirection(targetYaw, targetPitch, dt); // still defend while held -- overwatch IS this
        if (readyToFire && botAimGateOk(err) && fireBotShot(eyePosInto(bot, _fireEye), now)) lastShotAt = now;
      } else {
        faceThreatAndAhead(threatFacing(null) || activeBotActor.holdFacingXZ, dt, now); // shooter first, else the caller's point
      }
    } else if (state === BOT_AIM || state === BOT_FIRE) {
      bot.velocity.x = 0; bot.velocity.z = 0;
      pathMode = null; currentPath = []; botCombatMoveGoal = null;
      faceAimDirection(targetYaw, targetPitch, dt);
      if (state === BOT_FIRE && fireBotShot(eyePosInto(bot, _fireEye), now)) {
        lastShotAt = now;
      }
    } else if (state === BOT_KNIFE) {
      updateKnifeMovement(targetDistance);
      faceAimDirection(targetYaw, targetPitch, dt);
      fireBotKnife(targetDistance, now);  } else if (state === BOT_PURSUE) {
      updatePursuitMovement();
      faceAimDirection(targetYaw, targetPitch, dt);
    } else if (state === BOT_FLEE) {
      updateFleeMovement(now);
      faceAimDirection(targetYaw, targetPitch, dt);
      if (readyToFire && botAimGateOk(err) && fireBotShot(eyePosInto(bot, _fireEye), now)) lastShotAt = now;
    } else if (state === BOT_HEAL) {
      updateBotHealing(dt);
      faceThreatAndAhead(threatFacing(null) || botCombatMoveGoal, dt, now);
    } else if (state === MEDIC_MOVE) {
      // Approach a wounded/fallen ally; still aim and fire at any visible enemy en route (like flee).
      updateMedicMoveMovement(now);
      if (visible) { faceAimDirection(targetYaw, targetPitch, dt); if (readyToFire && botAimGateOk(err) && fireBotShot(eyePosInto(bot, _fireEye), now)) lastShotAt = now; }
      else faceThreatAndAhead(selfThreat?.threat, dt, now); // null threat falls through to plain face-movement
    } else if (state === MEDIC_TEND) {
      // Channel a heal/revive on the ally; fire-while-tend (pack in the off hand, sidearm in the other).
      updateMedicTend(dt, now);
      if (visible) { faceAimDirection(targetYaw, targetPitch, dt); if (readyToFire && botAimGateOk(err) && fireBotShot(eyePosInto(bot, _fireEye), now)) lastShotAt = now; }
      else faceThreatAndAhead(threatFacing(null) || activeBotActor?.medicAction, dt, now); // shooter first, else the patient
    } else if (state === BOT_COVER_MOVE) {
      // Run for the anchor; keep firing on a visible threat en route (like flee).
      updateCoverMoveMovement();
      if (visible) { faceAimDirection(targetYaw, targetPitch, dt); if (readyToFire && botAimGateOk(err) && fireBotShot(eyePosInto(bot, _fireEye), now)) lastShotAt = now; }
      else faceThreatAndAhead(selfThreat?.threat, dt, now); // null threat falls through to plain face-movement
    } else if (state === BOT_COVER_HOLD) {
      bot.velocity.x = 0; bot.velocity.z = 0;
      pathMode = null; currentPath = []; botCombatMoveGoal = null;
      const rec = activeBotActor.coverCorner;
      activeBotActor.coverHoldSince ??= now; // drought clock starts when the hold does
      // S10: the group stagger is a one-shot on the FIRST hold of this corner; the phase then persists.
      if (!activeBotActor.peek) {
        activeBotActor.peek = createPeekCycle(Math.random, activeBotActor.coverPeekOffsetS ?? 0);
        activeBotActor.coverPeekOffsetS = 0;
      }
      const peek = activeBotActor.peek;
      stepPeekCycle(peek, dt);
      // Position-driven slide along the baked anchor->peek line; re-seats after any pushout shove
      // (deliberately no separation blend here, so a passing ally can't drag the holder off line).
      if (rec) placeBotXZ(bot, approachXZ(botXZInto(bot, _holdSeatXZ), peekPosition(peek, rec.anchorPos, rec.peekPos), PEEK_APPROACH_SPEED * dt));
      if (peekAiming(peek) && visible && !closeSelfThreat) {
        faceAimDirection(targetYaw, targetPitch, dt);
        // Fire only fully exposed, through the same aim/cooldown gate AIM->FIRE uses.
        if (peekExposed(peek) && readyToFire && botAimGateOk(err) && fireBotShot(eyePosInto(bot, _fireEye), now)) lastShotAt = now;
      } else {
        // A knife-range attacker behind us outranks the far target: threatFacing turns on it while we hold.
        faceThreatAndAhead(threatFacing(activeBotActor?.coverThreat), dt, now);
      }
    } else if (state === BOT_SEEK) {
      updateSeekMovement(now);
      faceThreatAndAhead(threatFacing(botCombatMoveGoal), dt, now);
    } else if (state === 'alert') {
      // Hold the concealed spot, weapon trained on the reported threat direction (swept, not pinned).
      bot.velocity.x = 0; bot.velocity.z = 0;
      pathMode = null; currentPath = []; botCombatMoveGoal = null;
      faceThreatAndAhead(threatFacing(null), dt, now);
    } else {
      // Out of combat: grab a nearby pack, else (medics) regroup toward the team, else patrol.
      if (updatePackSeekMovement(now)) { /* seeking a pack */ }
      else if (updateCommandMovement(now)) { /* under a manual point command */ }
      else if (updateGarrisonMovement(now)) { /* holding the spawn marker this squad garrisons */ }
      else if (updateSquadFormationMovement(now)) { /* holding a formation slot */ }
      else if (activeBotActor.role === ROLE_MEDIC && updateMedicCohesionMovement(now)) { /* regrouping */ }
      else updatePatrolMovement();
      faceMovementScanning(dt, now); // A4: glance off-axis while walking instead of staring down the heading
      _dLabel = 'patrol';
    }
    // Air defence, after the movement chain and outranked by every ground engagement: with nothing
    // visible to shoot at, a bot puts rounds into the drone overhead instead of ignoring it.
    const airEngage = botAirTarget(now, visible);
    activeBotActor.airEngaging = !!airEngage;   // read by updateBotWeaponMount: the gun comes up for it
    if (airEngage) {
      _dLabel = 'air';
      faceAimDirection(airEngage.yaw, airEngage.pitch, dt);
      botAimPoint.copy(airEngage.point); botHasAimPoint = true;
      botAimTarget.yaw = airEngage.yaw; botAimTarget.pitch = airEngage.pitch;
      const airAmmo = ensureBotAmmo();
      const airReady = botReloadUntil == null && !botSwapping(now) && airAmmo.mag > 0 &&
        now - lastShotAt >= currentBotWeapon().fireIntervalMs;
      if (airReady && botAimGateOk(aimError(bot.yaw, bot.pitch, airEngage.yaw, airEngage.pitch))
        && fireBotShot(eyePosInto(bot, _fireEye), now)) lastShotAt = now;
    }
    const _sp4 = performance.now();
    senDByState.set(_dLabel, (senDByState.get(_dLabel) || 0) + (_sp4 - _sp3));
    // Knife is a true last resort: it only comes out once the primary AND the pistol are spent.
    // bot.weapon is already the swapped-to slot, so the mount follows the pistol on its own.
    setBotEquippedWeapon(activeBotActor.grenadeThrow ? 'grenade'
      : botKnifeSecondaryEnabled && attackerOutOfAmmo ? 'knife' : bot.weapon);
    // Re-decide the slot on this frame's post-fire ammo: the shot that emptied the mag swaps the
    // pistol in now, instead of starting a reload the next frame would immediately cancel.
    // Reload/slot re-decide now runs on the knife too: skipping it was the other half of the deadlock.
    // The close-range self-splash gate reads the distance to what is being SHOT AT. Feeding it only
    // the ground target left it at Infinity in exactly the case air defence runs in, so a technical
    // kept the RPG and rocketed a drone hovering 11 m over its own head, well inside an 8.2 m blast.
    updateBotWeaponSlot(now, inGunfight, Math.min(targetDistance, airEngage ? airEngage.dist : Infinity));
    updateBotReload(now);
    // A9: top off a partial mag during a lull. reloadBotWeapon already no-ops while reloading, on a
    // full mag, with no reserve, or on the knife -- this only supplies the "mag < 30%" trigger.
    const heldAmmo = ensureBotAmmo(); // re-read: the tail swap above may have changed what's in hand
    if (state !== BOT_KNIFE && botReloadUntil == null && heldAmmo.magazineSize > 0) {
      _topOff.magFrac = heldAmmo.mag / heldAmmo.magazineSize;
      _topOff.targetVisible = visible;
      _topOff.concealed = concealedFromTarget;
      // A peeking holder only tops off when the remaining concealed hold covers the reload; the
      // hold is then extended to match, or the cycle slides the bot out mid-reload, unable to fire.
      let peekReloadOk = true;
      const holdPeek = botState === BOT_COVER_HOLD ? activeBotActor.peek : null;
      if (holdPeek) {
        const seq = botWeaponMount?.weaponId === bot.weapon ? botWeaponMount.reloadSequence : null;
        const reloadS = (seq?.duration ?? BOT_RELOAD_FALLBACK_MS / 1000) + 0.15;
        peekReloadOk = holdPeek.phase === 'in';
        if (peekReloadOk && shouldTopOffReload(_topOff) && reloadBotWeapon(now)) {
          holdPeek.inHoldS = Math.max(holdPeek.inHoldS, holdPeek.t + reloadS);
        }
      } else if (shouldTopOffReload(_topOff)) reloadBotWeapon(now);
    }
    const _dEnd = performance.now();
    senDTailMs += _dEnd - _sp4;
    senDMs += _dEnd - _sp3;
  }

  // v3:11789
  function botBarrelAimError() {
    if (!botHasAimPoint || !botWeaponMount?.placed) return null;
    // A barrel left in a carry/reload pose is not a failed aim, it is a weapon that is not up yet:
    // gate that on the entity as before rather than reading a pose that was never solved.
    // Rig LOD solves a distant bot's mount only every 4th frame, so the window has to clear that.
    if ((botFrameCounter - (botWeaponMount?.aimTrimSolvedFrame ?? -999)) > 6) return null;
    const barrel = botMountedBarrelRay();
    if (!barrel) return null;
    return directionError(
      barrel.direction.x, barrel.direction.y, barrel.direction.z,
      botAimPoint.x - barrel.origin.x, botAimPoint.y - barrel.origin.y, botAimPoint.z - barrel.origin.z);
  }

  // v3:11802
  function botAimGateOk(entityError) {
    if (botAimBlend.enabled === false || botAimBlend.barrelGate === false) return entityError <= AIM_TOLERANCE_RAD;
    const barrelError = botBarrelAimError();
    return (barrelError == null ? entityError : barrelError) <= AIM_TOLERANCE_RAD;
  }

  // ---- host surface (hand-written; not from the harness) -------------------------------------
  // The roster half of v3's spawnBots without meshes: a brain bot, its actor, the registers.
  function spawn({ id = null, team = 'alpha', roleId = DEFAULT_ROLE, weaponId = 'cz_805_bren', at, health = DUMMY_MAX_HEALTH } = {}) {
    const role = getRole(roleId);
    const entity = createBrainBot(id ?? `bot-${nextBotId++}`, at, { team });
    entity.weapon = role.weapon ?? weaponId;
    entity.primaryWeapon = entity.weapon;
    entity.sidearm = sidearmForRole(roleId, entity.weapon, botSeedFromId(entity.id));
    entity.tool = entity.weapon;
    entity.health = health;
    entity.alive = true;
    const actor = createBotActor(entity, null, roleId);
    botActors.push(actor);
    botActorById.set(actor.id, actor);
    if (!activeBotActor) bindBotActor(actor);
    return actor;
  }
  function remove(actor) {
    const i = botActors.indexOf(actor);
    if (i >= 0) botActors.splice(i, 1);
    botActorById.delete(actor.id);
    deadBotActors.delete(actor);
    goalClaims.release?.(actor.id);
    if (activeBotActor === actor) bindBotActor(botActors[0] ?? null);
  }
  // v3's updateAllBots minus rendering, physics and squads: think for every living actor. The host
  // moves the bodies between calls and reads each entity's velocity/yaw as its intent.
  function stepAll(dt, now) {
    botStateRecordFrameNow = now;
    botFrameCounter++;
    replanBudgetLeft = REPLAN_BUDGET_PER_FRAME;
    rebuildFrameEnemyLists();
    const thinkStride = botThinkStride(rebuildBotHash().length);
    refreshGrenadeThreats();
    hooks.beforeActors?.(now);
    const focus = activeBotActor;
    if (focus) commitBotActor(focus);
    for (const actor of botActors) {
      if (actor.entity.alive === false) continue;
      bindBotActor(actor);
      actor.thinkDtAcc = (actor.thinkDtAcc ?? 0) + dt;
      if (thinkStride === 1 || actor === focus || (botFrameCounter + (actor.scanPhase ?? 0)) % thinkStride === 0) {
        updateBotSentry(actor.thinkDtAcc, now);
        actor.thinkDtAcc = 0;
      }
      if (activeBotActor) {
        activeBotActor.stanceWeights = stepStanceWeights(
          activeBotActor.stanceWeights ??= { crouch01: 0, kneel01: 0, prone01: 0 },
          poseStanceFor(activeBotActor), dt, botStanceSettings);
      }
      commitBotActor(actor);
    }
    rebuildBotHash();
    bindBotActor(botActors.includes(focus) ? focus : (botActors[0] ?? null));
  }
  // The host tells the brain about a hit: v3's applyBotDamage minus wounds, FX and scoring. The
  // host has already changed target.health (it is the HP authority); this records the evidence.
  function damaged(target, attacker, amount, now) {
    if (!target) return;
    if (attacker?.alive) recordAllyHit(target, attacker, now);
    if (target.botActor && target.health > 0) beginBotHealthRetreat(target, attacker?.id ?? null, now);
    if (target.health <= 0 && target.alive !== false) killed(target, now);
  }
  // v3's killCombatBot minus ragdoll, meshes and the scoreboard.
  function killed(target, now) {
    target.alive = false;
    goalClaims.release(target.id);
    invalidateTargetMemoryAfterDeath(target, now);
    target.velocity.set(0, 0, 0);
    const actor = target.botActor;
    if (!actor) return;
    deadBotActors.add(actor);
    actor.healRequested = false;
    const diedCoverCorner = actor.coverCorner;
    actor.coverCorner = null; actor.coverThreat = null; actor.coverStartedAt = null; actor.coverMoveSince = null; actor.coverBlacklist?.clear(); actor.peek = null;
    actor.coverGate = { invalidSince: null, switchedAt: null }; actor.peekMissStreak = 0; actor.coverHoldSince = null;
    actor.coverPeekOffsetS = 0;
    const deathXZ = botXZ(target);
    actor.alertReport = null; actor.alertMarkMode = null; actor.alertWarySince = null; actor.alertScore = 0;
    actor.attention = null; actor.patrolScan = null; actor.tierPerception = null; actor.packSeekGoal = null;
    actor.medicAction = null; actor.medicTendTargetId = null; actor.poseMode = 'none';
    actor.diedAt = now;
    actor.deathXZ = { x: deathXZ.x, z: deathXZ.z };
    if (navGrid) {
      const deathCell = cellIndexAt(navGrid, deathXZ.x, deathXZ.z);
      if (deathCell >= 0) {
        const n = cellNeighbors8(deathCell, navGrid.cols, navGrid.rows, _dangerNb);
        recordDanger(botDangerField, target.team, deathCell, DANGER_DEATH_WEIGHT, now, _dangerNb, n);
      }
      if (diedCoverCorner) {
        recordDanger(botDangerField, target.team, diedCoverCorner.anchorCell, DANGER_DEATH_WEIGHT, now);
        if (diedCoverCorner.peekCell != null) recordDanger(botDangerField, target.team, diedCoverCorner.peekCell, DANGER_DEATH_WEIGHT, now);
      }
    }
    withBotActor(actor, () => { botState = BOT_PATROL; pathMode = null; currentPath = []; });
    hooks.died?.(target, actor, now);
  }
  // Respawn in place: the roster keeps the actor; the host has moved the capsule and reset health.
  function revived(target, now) {
    const actor = target.botActor;
    if (!actor) return;
    target.alive = true;
    deadBotActors.delete(actor);
    actor.diedAt = null; actor.deathXZ = null; actor.aliveSince = now;
    actor.state = BOT_PATROL; actor.path = []; actor.pathMode = null; actor.target = null;
    actor.lastKnownTarget = null; actor.lastKnownTargetMotion = null; actor.lastKnownTargetAt = null;
    actor.healRequested = false; actor.healArrived = false; actor.healThreatId = null;
    actor.reloadUntil = null; actor.reloadWeaponId = null;
    target.ammoByWeapon = null;
  }
  return {
    configure, spawn, remove, stepAll, damaged, killed, revived,
    setWorldEntities: (list) => { worldEntities = list; },
    createBotActor, bindBotActor, commitBotActor, withBotActor,
    updateBotSentry, selectBotTarget,
    actors: () => botActors, actorById: (id) => botActorById.get(id),
    // What a hook sees while it runs: the bound actor, its bot record and current target.
    bound: () => ({ actor: activeBotActor, bot, target: botTarget, state: botState, aimPoint: botHasAimPoint ? botAimPoint : null, reloadUntil: botReloadUntil }),
    aimSettings: () => ({ ...botAimSettings }),
    ammoFor: (entity, weaponId) => withBotActor(entity.botActor, () => ensureBotAmmo(weaponId ?? entity.weapon)),
    state: () => ({ navGrid, visField, cornerMap, goalClaims, botHash, botActorById, botActors, squads, recentAllyHits }),
  };
}
