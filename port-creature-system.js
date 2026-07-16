import * as THREE from 'three';
import {
  ROLE_WILD, ROLE_PET, ROLE_HOSTILE,
  CMD_FOLLOW, CMD_STAY, CMD_GOTO, CMD_ATTACK,
  followDesire, hostileDesire, meleeHitsPlayer, wildlifeSpawnPlan, pickRoamTarget,
} from './creature-interaction.js';
import {
  ACT_WANDER, ACT_SLEEP, ACT_HUNT, ACT_SOCIALIZE, ACT_GRAZE, ACT_DURATION,
  HUNT_SENSE, SOCIAL_SENSE, THREAT_NEAR, chooseActivity, activitySteer,
  defaultTemperament, sampleTemperament, TEMPERAMENT_COLORS,
} from './creature-activity.js';

export function createPortCreatureSystem({ scene, terrainHeight, resolveTrunks = null, nearbyTrunks = null, terrainSettings, rebuildTerrain, camera = null, lod = {}, getPlayerPose = null, damagePlayer = null, getWorldBounds = null }) {
const CREATURE_INSTANCING_MODE = new URLSearchParams(globalThis.location?.search || '').get('creatureInstancing') || 'parts';
const creaturePerf = {
  detailDistance: lod.detailDistance ?? lod.near ?? 120,
  bodyOnlyDistance: lod.bodyOnlyDistance ?? lod.mid ?? 210,
  hideDistance: lod.hideDistance ?? lod.far ?? 360,
  fullUpdateStride: Math.max(1, Math.round(lod.fullUpdateStride ?? 1)),
  bodyUpdateStride: Math.max(1, Math.round(lod.bodyUpdateStride ?? lod.midStride ?? 2)),
  farUpdateStride: Math.max(1, Math.round(lod.farUpdateStride ?? lod.farStride ?? 4)),
  ikDistance: lod.ikDistance ?? lod.near ?? 120,
  shadowDistance: lod.shadowDistance ?? lod.near ?? 120,
};
const LOD_BODY_ONLY_TIER = 1;
const _cameraPos = new THREE.Vector3();
const _normal = new THREE.Vector3();
function terrainNormal(x, z, out = _normal) {
  const e = 0.12;
  return out.set(
    terrainHeight(x - e, z) - terrainHeight(x + e, z),
    2 * e,
    terrainHeight(x, z - e) - terrainHeight(x, z + e)
  ).normalize();
}

// ===================== body plans and gaits =====================
const FOOT_GROUND = 0.06;
const SEP_RADIUS = 2.3, MIN_GAP = 1.55;
const TRUNK_AVOID_MARGIN = 1.2;   // how far out creatures start steering around a trunk
const WANDER_W = 1.0, SEP_W = 2.2;
const ROAM_MIN_STEP = 6, ROAM_MAX_STEP = 20; // meters; a few-to-~15s walk at gait.maxSpeed (0.35-2.6)
const _temperamentMats = new Map(); // shared MeshBasicMaterial per temperament badge color
function temperamentMat(name) {
  const hex = TEMPERAMENT_COLORS[name] ?? TEMPERAMENT_COLORS.balanced;
  let m = _temperamentMats.get(hex);
  if (!m) { m = new THREE.MeshBasicMaterial({ color: hex }); m.userData.shared = true; _temperamentMats.set(hex, m); }
  return m;
}
const GRAV = 10.0, KP = 60, KD = 16, H_DRAG = 1.15, BOUNCE = 0.25, BODY_MIN_CLEAR = 0.30;
const BODY_VOLUME_CLEAR = 0.10, BODY_COLLISION_PAD = 0.28;
const ORIENT_LERP = 0.08;

const initA = Math.PI / 5;
const upOut = new THREE.Vector3(0.35, -0.35, 0).normalize();
const forward = new THREE.Vector3(0, 0, 1);

function segment(length, dir = forward) {
  return { length, initDirection: dir.clone() };
}

function pair(attachment, rest, segments) {
  const left = {
    attachment: new THREE.Vector3(-attachment.x, attachment.y, attachment.z),
    rest: new THREE.Vector3(-rest.x, rest.y, rest.z),
    side: -1,
    row: 0,
    segments: segments.map(s => ({ length: s.length, initDirection: s.initDirection.clone() }))
  };
  const right = {
    attachment: new THREE.Vector3(attachment.x, attachment.y, attachment.z),
    rest: new THREE.Vector3(rest.x, rest.y, rest.z),
    side: 1,
    row: 0,
    segments: segments.map(s => ({ length: s.length, initDirection: new THREE.Vector3(-s.initDirection.x, s.initDirection.y, s.initDirection.z) }))
  };
  return [left, right];
}

function finalizePlan(plan) {
  plan.legs.sort((a, b) => b.rest.z - a.rest.z || a.side - b.side);
  const rows = [...new Set(plan.legs.map(l => l.rest.z))].sort((a, b) => b - a);
  for (const leg of plan.legs) leg.row = rows.indexOf(leg.rest.z);
  return plan;
}

const BODY_PLANS = {
  quadbot: finalizePlan({
    label: 'Quad Bot',
    bodyHeight: 1.08,
    bodyScale: new THREE.Vector3(0.62, 0.40, 0.82),
    head: true,
    legs: [
      ...pair(new THREE.Vector3(0.28, -0.24, 0.32), new THREE.Vector3(0.86, 0, 0.86), [
        segment(0.42, upOut), segment(0.46, forward), segment(0.34, forward)
      ]),
      ...pair(new THREE.Vector3(0.30, -0.24, -0.34), new THREE.Vector3(0.95, 0, -1.02), [
        segment(0.44, upOut), segment(0.50, forward), segment(0.38, forward)
      ])
    ]
  }),
  hexbot: finalizePlan({
    label: 'Hex Bot',
    bodyHeight: 1.10,
    bodyScale: new THREE.Vector3(0.66, 0.38, 1.12),
    head: true,
    legs: [
      ...pair(new THREE.Vector3(0.28, -0.25, 0.52), new THREE.Vector3(0.92, 0, 1.22), [
        segment(0.42, upOut), segment(0.46, forward), segment(0.34, forward)
      ]),
      ...pair(new THREE.Vector3(0.32, -0.25, 0.00), new THREE.Vector3(1.08, 0, 0.02), [
        segment(0.44, upOut), segment(0.48, forward), segment(0.36, forward)
      ]),
      ...pair(new THREE.Vector3(0.30, -0.25, -0.50), new THREE.Vector3(1.00, 0, -1.28), [
        segment(0.46, upOut), segment(0.52, forward), segment(0.40, forward)
      ])
    ]
  }),
  octobot: finalizePlan({
    label: 'Octo Bot',
    bodyHeight: 1.14,
    bodyScale: new THREE.Vector3(0.68, 0.38, 1.34),
    head: true,
    legs: [
      ...pair(new THREE.Vector3(0.28, -0.25, 0.74), new THREE.Vector3(0.92, 0, 1.52), [
        segment(0.42, upOut), segment(0.46, forward), segment(0.34, forward)
      ]),
      ...pair(new THREE.Vector3(0.33, -0.25, 0.28), new THREE.Vector3(1.10, 0, 0.62), [
        segment(0.42, upOut), segment(0.48, forward), segment(0.36, forward)
      ]),
      ...pair(new THREE.Vector3(0.33, -0.25, -0.24), new THREE.Vector3(1.10, 0, -0.62), [
        segment(0.44, upOut), segment(0.50, forward), segment(0.38, forward)
      ]),
      ...pair(new THREE.Vector3(0.28, -0.25, -0.74), new THREE.Vector3(0.98, 0, -1.56), [
        segment(0.46, upOut), segment(0.54, forward), segment(0.40, forward)
      ])
    ]
  }),
  crawler: finalizePlan({
    label: 'Crawler',
    bodyHeight: 1.0,
    bodyScale: new THREE.Vector3(0.72, 0.44, 0.88),
    head: false,
    legs: [
      ...pair(new THREE.Vector3(0.18, -0.26, 0.18), new THREE.Vector3(0.95, 0, 0.72), [
        segment(0.50, new THREE.Vector3(Math.sin(initA), -0.42, Math.cos(initA)).normalize()),
        segment(0.56, forward)
      ]),
      ...pair(new THREE.Vector3(0.18, -0.26, -0.18), new THREE.Vector3(1.00, 0, -0.86), [
        segment(0.52, new THREE.Vector3(Math.sin(initA), -0.42, -Math.cos(initA)).normalize()),
        segment(0.60, forward)
      ])
    ]
  })
};

const GAITS = {
  walk: {
    label: 'Walk',
    maxSpeed: 1.05,
    turnSpeed: 1.85,
    stationaryHeight: 1.00,
    movingHeight: 1.08,
    stationaryTrigger: { h: 0.28, v: 0.36 },
    movingTrigger: { h: 0.78, v: 0.44 },
    comfort: { h: 1.22, v: 0.78 },
    stepDuration: 0.20,
    stepLift: 0.24,
    lookAhead: 0.20,
    scanHeight: 1.75,
    scanDepth: 3.8,
    scanGrid: 0.22,
    scanHeightBias: 0.34,
    maxConcurrentFraction: 0.24,
    samePairCooldown: 0.16,
    crossPairCooldown: 0.10,
    uncomfortableSpeedMultiplier: 0.28,
    rowPairSteps: false,
    rotationLerp: 0.16,
    preferredRotationLerp: 0.14,
    preferredPitchLeeway: Math.PI / 7
  },
  gallop: {
    label: 'Gallop',
    maxSpeed: 1.65,
    turnSpeed: 1.55,
    stationaryHeight: 1.06,
    movingHeight: 1.30,
    stationaryTrigger: { h: 0.36, v: 0.44 },
    movingTrigger: { h: 1.10, v: 0.58 },
    comfort: { h: 1.55, v: 0.98 },
    stepDuration: 0.15,
    stepLift: 0.34,
    lookAhead: 0.30,
    scanHeight: 2.1,
    scanDepth: 4.4,
    scanGrid: 0.24,
    scanHeightBias: 0.46,
    maxConcurrentFraction: 0.50,
    samePairCooldown: 0.09,
    crossPairCooldown: 0.16,
    uncomfortableSpeedMultiplier: 0.58,
    rowPairSteps: true,
    rotationLerp: 0.16,
    preferredRotationLerp: 0.14,
    preferredPitchLeeway: Math.PI / 8
  }
};

function cloneGait(gait) {
  return {
    ...gait,
    stationaryTrigger: { ...gait.stationaryTrigger },
    movingTrigger: { ...gait.movingTrigger },
    comfort: { ...gait.comfort }
  };
}

const gaitSettings = Object.fromEntries(Object.entries(GAITS).map(([key, gait]) => [key, cloneGait(gait)]));

const OPTION_DEFS = [
  { label: 'Speed', path: ['maxSpeed'], min: 0.35, max: 2.6, step: 0.05 },
  { label: 'Body', path: ['movingHeight'], min: 0.75, max: 1.7, step: 0.02 },
  { label: 'Trigger', path: ['movingTrigger', 'h'], min: 0.18, max: 1.55, step: 0.02 },
  { label: 'Comfort', path: ['comfort', 'h'], min: 0.55, max: 2.1, step: 0.02 },
  { label: 'Lift', path: ['stepLift'], min: 0.04, max: 0.65, step: 0.01 },
  { label: 'Step', path: ['stepDuration'], min: 0.08, max: 0.34, step: 0.01 },
  { label: 'Scan', path: ['scanDepth'], min: 1.4, max: 6.0, step: 0.1 },
  { label: 'Pairs', path: ['maxConcurrentFraction'], min: 0.14, max: 0.62, step: 0.02 },
  { label: 'Cooldown', path: ['samePairCooldown'], min: 0.00, max: 0.32, step: 0.01 },
  { label: 'Rotate', path: ['rotationLerp'], min: 0.04, max: 0.36, step: 0.01 }
];

const PERF_DEFS = [
  { label: 'Full detail dist', key: 'detailDistance', min: 10, max: 500, step: 5 },
  { label: 'Body-only dist', key: 'bodyOnlyDistance', min: 10, max: 700, step: 5 },
  { label: 'Hide dist', key: 'hideDistance', min: 20, max: 900, step: 5 },
  { label: 'Full anim stride', key: 'fullUpdateStride', min: 1, max: 8, step: 1, integer: true },
  { label: 'Body anim stride', key: 'bodyUpdateStride', min: 1, max: 16, step: 1, integer: true },
  { label: 'Far anim stride', key: 'farUpdateStride', min: 1, max: 24, step: 1, integer: true },
  { label: 'IK dist', key: 'ikDistance', min: 0, max: 500, step: 5 },
  { label: 'Shadow dist', key: 'shadowDistance', min: 0, max: 500, step: 5 }
];

const MODEL_DEFS = [
  { label: 'Scale', key: 'scale', min: 0.65, max: 1.65, step: 0.05 },
  { label: 'Body W', key: 'bodyWidth', min: 0.45, max: 1.9, step: 0.05 },
  { label: 'Body H', key: 'bodyThickness', min: 0.35, max: 1.8, step: 0.05 },
  { label: 'Body D', key: 'bodyDepth', min: 0.45, max: 2.1, step: 0.05 },
  { label: 'Ride H', key: 'bodyHeight', min: 0.45, max: 1.9, step: 0.05 },
  { label: 'Leg X', key: 'restX', min: 0.45, max: 2.2, step: 0.05 },
  { label: 'Leg Z', key: 'restZ', min: 0.45, max: 2.2, step: 0.05 },
  { label: 'Hip X', key: 'hipX', min: 0.45, max: 1.9, step: 0.05 },
  { label: 'Hip Y', key: 'hipY', min: 0.45, max: 1.9, step: 0.05 },
  { label: 'Segments', key: 'segmentScale', min: 0.45, max: 2.4, step: 0.05 }
];

const ARM_DEFS = [
  { label: 'Arm Count', key: 'armCount', min: 0, max: 8, step: 1 },
  { label: 'Arm Length', key: 'armLength', min: 0.35, max: 2.6, step: 0.05 },
  { label: 'Grab R', key: 'armGrabRadius', min: 0.08, max: 0.8, step: 0.02 },
  { label: 'Interest', key: 'armInterest', min: 0.0, max: 2.2, step: 0.05 },
  { label: 'Carry H', key: 'armCarryHeight', min: -0.2, max: 1.4, step: 0.05 },
  { label: 'Bend', key: 'armBend', min: 0.0, max: 0.7, step: 0.02 }
];

const SELECTED_BODY_DEFS = [
  { label: 'Body W', key: 'bodyScaleX', min: 0.25, max: 3.5, step: 0.05 },
  { label: 'Body H', key: 'bodyScaleY', min: 0.18, max: 2.5, step: 0.05 },
  { label: 'Body D', key: 'bodyScaleZ', min: 0.25, max: 3.8, step: 0.05 },
  { label: 'Ride H', key: 'bodyHeight', min: 0.25, max: 3.5, step: 0.05 }
];

const SELECTED_ARM_DEFS = [
  { label: 'Arm Count', key: 'count', min: 0, max: 8, step: 1, integer: true },
  { label: 'Arm Length', key: 'length', min: 0.35, max: 2.6, step: 0.05 },
  { label: 'Grab R', key: 'grabRadius', min: 0.08, max: 0.8, step: 0.02 },
  { label: 'Interest', key: 'interest', min: 0.0, max: 2.2, step: 0.05 },
  { label: 'Carry H', key: 'carryHeight', min: -0.2, max: 1.4, step: 0.05 },
  { label: 'Bend', key: 'bend', min: 0.0, max: 0.7, step: 0.02 }
];

const ARM_PLANS = {
  none: { label: 'No Arms' },
  front: { label: 'Front Arms' },
  side: { label: 'Side Arms' },
  claws: { label: 'Short Claws' },
  tentacle: { label: 'Tentacles' }
};

const TERRAIN_DEFS = [
  { label: 'Land Amp', key: 'amplitude', min: 0.0, max: 2.6, step: 0.05 },
  { label: 'Land Freq', key: 'frequency', min: 0.25, max: 3.0, step: 0.05 },
  { label: 'Rough', key: 'roughness', min: 0.0, max: 3.5, step: 0.05 },
  { label: 'Ridge', key: 'ridge', min: -1.2, max: 1.2, step: 0.05 },
  { label: 'Land Size', key: 'size', min: 24, max: 120, step: 2 },
  { label: 'Mesh Res', key: 'resolution', min: 24, max: 220, step: 4 },
  { label: 'Lake', key: 'lake', min: 0.0, max: 0.95, step: 0.01 },
  { label: 'Lake Depth', key: 'lakeDepth', min: 0.0, max: 6.0, step: 0.1 },
  { label: 'Water Level', key: 'waterLevel', min: -3.0, max: 1.0, step: 0.05 }
];

const MODEL_STYLES = {
  block: { label: 'Block Bot', limb: 'box', shell: 0x55606c, plate: 0x2f363f, trim: 0x91a0ad, lightA: 0x66ffd1, lightB: 0xffd166 },
  stealth: { label: 'Stealth', limb: 'box', shell: 0x30343a, plate: 0x171b20, trim: 0x67717d, lightA: 0x79a8ff, lightB: 0xd067ff },
  organic: { label: 'Organic', limb: 'capsule', shell: 0x6f8f6d, plate: 0x415a42, trim: 0xa6c49a, lightA: 0xe8ffd0, lightB: 0xffb86b },
  custom: { label: 'Random Look', limb: 'box', shell: 0x55606c, plate: 0x2f363f, trim: 0x91a0ad, lightA: 0x66ffd1, lightB: 0xffd166 }
};

const modelSettings = {
  scale: 1,
  bodyWidth: 1,
  bodyThickness: 1,
  bodyDepth: 1,
  bodyHeight: 1,
  restX: 1,
  restZ: 1,
  hipX: 1,
  hipY: 1,
  segmentScale: 1,
  armPlan: 'front',
  armCount: 2,
  armLength: 1,
  armGrabRadius: 0.32,
  armInterest: 0.75,
  armCarryHeight: 0.34,
  armBend: 0.22,
  legPairs: 3,
  segmentCount: 3,
  style: 'block',
  customStyle: null
};

function seededRandom(seed) {
  let t = (Math.floor(Number(seed) || 1) >>> 0) || 1;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function randRange(rng, min, max) {
  return min + (max - min) * rng();
}

function randInt(rng, min, max) {
  return Math.floor(randRange(rng, min, max + 1));
}

function randChoice(rng, items) {
  return items[Math.floor(rng() * items.length)];
}

function hslHex(h, s, l) {
  return new THREE.Color().setHSL((h % 1 + 1) % 1, s, l).getHex();
}

function currentSeed(offset = 0) {
  return (Number(document.getElementById('seed')?.value) || 1) + offset;
}

function advanceSeed(offset = 1) {
  const input = document.getElementById('seed');
  const next = (Number(input?.value) || 1) + offset;
  if (input) input.value = String(next);
  return next;
}

function currentStyle() {
  return modelSettings.style === 'custom' && modelSettings.customStyle
    ? modelSettings.customStyle
    : MODEL_STYLES[modelSettings.style];
}

function cloneStyle(style) {
  return { ...style };
}

function armSettingsFromModel(settings = modelSettings) {
  return {
    plan: ARM_PLANS[settings.armPlan] ? settings.armPlan : 'front',
    count: Math.max(0, Math.round(Number(settings.armCount) || 0)),
    length: Math.max(0.05, Number(settings.armLength) || 1),
    grabRadius: Math.max(0.02, Number(settings.armGrabRadius) || GRAB_RADIUS),
    interest: Math.max(0, Number(settings.armInterest) || 0),
    carryHeight: Number(settings.armCarryHeight) || 0,
    bend: Math.max(0, Number(settings.armBend) || 0)
  };
}

function cloneArmSettings(settings) {
  const base = settings || armSettingsFromModel();
  return {
    plan: ARM_PLANS[base.plan] ? base.plan : 'front',
    count: Math.max(0, Math.round(Number(base.count) || 0)),
    length: Math.max(0.05, Number(base.length) || 1),
    grabRadius: Math.max(0.02, Number(base.grabRadius) || GRAB_RADIUS),
    interest: Math.max(0, Number(base.interest) || 0),
    carryHeight: Number(base.carryHeight) || 0,
    bend: Math.max(0, Number(base.bend) || 0)
  };
}

function valueAtPath(obj, path) {
  return path.reduce((target, key) => target[key], obj);
}

function setAtPath(obj, path, value) {
  let target = obj;
  for (let i = 0; i < path.length - 1; i++) target = target[path[i]];
  target[path[path.length - 1]] = value;
}

function currentGait() {
  return gaitSettings[currentGaitKey];
}

function clonePlan(plan) {
  return finalizePlan({
    label: plan.label,
    bodyHeight: plan.bodyHeight,
    bodyScale: plan.bodyScale.clone(),
    head: plan.head,
    legs: plan.legs.map(leg => ({
      attachment: leg.attachment.clone(),
      rest: leg.rest.clone(),
      side: leg.side,
      row: leg.row,
      segments: leg.segments.map(s => ({ length: s.length, initDirection: s.initDirection.clone() }))
    }))
  });
}

function generateBodyPlan(rng) {
  const pairCount = LEG_PAIRS_PARAM.sampleCount(rng);
  const segmentCount = SEGMENTS_PARAM.sampleCount(rng);
  const bodyDepth = randRange(rng, 0.72, 1.68);
  const bodyWidth = randRange(rng, 0.48, 0.92);
  const bodyHeight = randRange(rng, 0.86, 1.35);
  const plan = {
    label: 'Generated',
    bodyHeight,
    bodyScale: new THREE.Vector3(bodyWidth, randRange(rng, 0.30, 0.58), bodyDepth),
    head: rng() > 0.18,
    legs: []
  };

  for (let i = 0; i < pairCount; i++) {
    const t = pairCount === 1 ? 0.5 : i / (pairCount - 1);
    const z = lerp(bodyDepth * 0.82, -bodyDepth * 0.92, t);
    const restZ = z + randRange(rng, -0.45, 0.45) + (t < 0.5 ? 0.35 : -0.35);
    const hip = new THREE.Vector3(randRange(rng, 0.14, 0.36), randRange(rng, -0.38, -0.12), z * randRange(rng, 0.38, 0.62));
    const rest = new THREE.Vector3(randRange(rng, 0.78, 1.55), 0, restZ);
    const segments = [];
    for (let s = 0; s < segmentCount; s++) {
      const length = randRange(rng, 0.28, 0.62) * (s === segmentCount - 1 ? randRange(rng, 0.72, 1.2) : 1);
      const lift = s === 0 ? randRange(rng, -0.55, -0.16) : randRange(rng, -0.12, 0.16);
      segments.push(segment(length, new THREE.Vector3(randRange(rng, 0.08, 0.55), lift, z >= 0 ? 0.72 : -0.72).normalize()));
    }
    plan.legs.push(...pair(hip, rest, segments));
  }

  return finalizePlan(plan);
}

function installGeneratedPlan(plan) {
  BODY_PLANS.generated = plan;
  const select = document.getElementById('preset');
  if (select && !select.querySelector('option[value="generated"]')) {
    const opt = document.createElement('option');
    opt.value = 'generated';
    opt.textContent = 'Generated';
    select.appendChild(opt);
  }
  currentPlanKey = 'generated';
  if (select) select.value = currentPlanKey;
}

function serializePlan(plan) {
  if (!plan) return null;
  return {
    label: plan.label,
    bodyHeight: plan.bodyHeight,
    bodyScale: plan.bodyScale.toArray(),
    head: plan.head,
    legs: plan.legs.map(leg => ({
      attachment: leg.attachment.toArray(),
      rest: leg.rest.toArray(),
      side: leg.side,
      row: leg.row,
      segments: leg.segments.map(segment => ({
        length: segment.length,
        initDirection: segment.initDirection.toArray()
      }))
    }))
  };
}

function deserializePlan(data) {
  return finalizePlan({
    label: data.label || 'Generated',
    bodyHeight: data.bodyHeight,
    bodyScale: new THREE.Vector3().fromArray(data.bodyScale),
    head: data.head !== false,
    legs: data.legs.map(leg => ({
      attachment: new THREE.Vector3().fromArray(leg.attachment),
      rest: new THREE.Vector3().fromArray(leg.rest),
      side: leg.side,
      row: leg.row,
      segments: leg.segments.map(segment => ({
        length: segment.length,
        initDirection: new THREE.Vector3().fromArray(segment.initDirection)
      }))
    }))
  });
}

function editedPlan() {
  const plan = clonePlan(BODY_PLANS[currentPlanKey]);
  return editPlanWithSettings(plan, modelSettings);
}

function editPlanWithSettings(plan, settings) {
  plan.bodyHeight *= settings.scale * settings.bodyHeight;
  plan.bodyScale.multiplyScalar(settings.scale);
  plan.bodyScale.x *= settings.bodyWidth;
  plan.bodyScale.y *= settings.bodyThickness;
  plan.bodyScale.z *= settings.bodyDepth;
  for (const leg of plan.legs) {
    leg.attachment.multiplyScalar(settings.scale);
    leg.attachment.x *= settings.hipX;
    leg.attachment.y *= settings.hipY;
    leg.rest.multiplyScalar(settings.scale);
    leg.rest.x *= settings.restX;
    leg.rest.z *= settings.restZ;
    for (const segment of leg.segments) segment.length *= settings.scale * settings.segmentScale;
  }
  return finalizePlan(plan);
}

// ===================== geometry helpers =====================
const _upAxis = new THREE.Vector3(0, 1, 0), _mid = new THREE.Vector3(), _seg = new THREE.Vector3();
function placeSegment(mesh, a, b) {
  _mid.addVectors(a, b).multiplyScalar(0.5);
  _seg.subVectors(b, a);
  const len = _seg.length();
  mesh.position.copy(_mid);
  mesh.scale.set(1, len / mesh.userData.base, 1);
  mesh.quaternion.setFromUnitVectors(_upAxis, _seg.normalize());
}

const _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3(), _basis = new THREE.Matrix4();
function orientFromUpForward(up, fwd, out) {
  _by.copy(up).normalize();
  _bx.crossVectors(_by, fwd);
  if (_bx.lengthSq() < 1e-6) _bx.set(1, 0, 0);
  _bx.normalize();
  _bz.crossVectors(_bx, _by).normalize();
  _basis.makeBasis(_bx, _by, _bz);
  return out.setFromRotationMatrix(_basis);
}

function easeInOut(t) { return t * t * (3 - 2 * t); }
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function rotateXZ(local, yaw, out = new THREE.Vector3()) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  return out.set(
    local.x * cy + local.z * sy,
    local.y,
    -local.x * sy + local.z * cy
  );
}

function averageVec(points, out = new THREE.Vector3()) {
  out.set(0, 0, 0);
  if (!points.length) return out;
  for (const p of points) out.add(p);
  return out.multiplyScalar(1 / points.length);
}

function horizontalDistance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function groundTarget(x, z) {
  return new THREE.Vector3(x, terrainHeight(x, z) + FOOT_GROUND, z);
}

function updateLineGeometry(line, points) {
  line.geometry.dispose();
  line.geometry = new THREE.BufferGeometry().setFromPoints(points);
  line.visible = points.length >= 2;
}

function addCircleSegments(points, center, radius, segments = 28) {
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const b = ((i + 1) / segments) * Math.PI * 2;
    points.push(
      new THREE.Vector3(center.x + Math.cos(a) * radius, center.y, center.z + Math.sin(a) * radius),
      new THREE.Vector3(center.x + Math.cos(b) * radius, center.y, center.z + Math.sin(b) * radius)
    );
  }
}

// ===================== support-polygon geometry (XZ) =====================
// Support-polygon convex hull, pooled (creature-perf-analysis/plan.md 2.2): writes
// the hull into the caller's reused `out` array instead of allocating p/lo/up and a
// concat every call. `out` holds references to the same point objects passed in
// (from _groundedBuf), valid only until the next convexHull call. Comparator and
// cross-product are hoisted to module scope so they aren't re-created per call.
const _hullSort = (a, b) => a.x - b.x || a.z - b.z;
const _hullCross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
const _hullP = [], _hullLo = [], _hullUp = [];
function convexHull(pts, count, out) {
  out.length = 0;
  if (count < 3) { for (let i = 0; i < count; i++) out.push(pts[i]); return out; }
  const p = _hullP; p.length = 0;
  for (let i = 0; i < count; i++) p.push(pts[i]);
  p.sort(_hullSort);
  const lo = _hullLo; lo.length = 0;
  for (const q of p) {
    while (lo.length >= 2 && _hullCross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  const up = _hullUp; up.length = 0;
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (up.length >= 2 && _hullCross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  lo.pop();
  up.pop();
  for (let i = 0; i < lo.length; i++) out.push(lo[i]);
  for (let i = 0; i < up.length; i++) out.push(up[i]);
  return out;
}

function pointInPoly(px, pz, poly) {
  if (poly.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const c = (b.x - a.x) * (pz - a.z) - (b.z - a.z) * (px - a.x);
    if (Math.abs(c) < 1e-9) continue;
    const s = Math.sign(c);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

function nearestOnPoly(px, pz, poly, out) {
  let bd = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1e-9;
    let t = ((px - a.x) * dx + (pz - a.z) * dz) / L2;
    t = clamp(t, 0, 1);
    const qx = a.x + t * dx, qz = a.z + t * dz, d = (qx - px) ** 2 + (qz - pz) ** 2;
    if (d < bd) { bd = d; out.x = qx; out.z = qz; }
  }
  return out;
}

// ===================== FABRIK chain =====================
class KinematicChain {
  constructor(segments) {
    this.lengths = segments.map(s => s.length);
    this.totalLength = this.lengths.reduce((s, n) => s + n, 0);
    this.initDirections = segments.map(s => s.initDirection.clone());
    this.points = [];
    this.maxIterations = 12;
    this.tolerance = 0.0001;
  }

  reset(root, orientation) {
    this.points = [root.clone()];
    for (let i = 0; i < this.lengths.length; i++) {
      const dir = this.initDirections[i].clone().applyQuaternion(orientation).normalize();
      this.points.push(this.points[i].clone().addScaledVector(dir, this.lengths[i]));
    }
  }

  solve(root, target, orientation) {
    if (this.points.length !== this.lengths.length + 1) this.reset(root, orientation);

    this.points[0].copy(root);
    const total = this.totalLength;
    const distance = root.distanceTo(target);

    if (distance >= total - 1e-5) {
      _fabrikDir.subVectors(target, root).normalize();
      for (let i = 0; i < this.lengths.length; i++) {
        this.points[i + 1].copy(this.points[i]).addScaledVector(_fabrikDir, this.lengths[i]);
      }
      return this.points;
    }

    for (let i = 1; i < this.points.length; i++) {
      if (this.points[i].distanceToSquared(this.points[i - 1]) < 1e-8) {
        _fabrikDir.copy(this.initDirections[i - 1]).applyQuaternion(orientation).normalize();
        this.points[i].copy(this.points[i - 1]).addScaledVector(_fabrikDir, this.lengths[i - 1]);
      }
    }

    for (let iter = 0; iter < this.maxIterations; iter++) {
      this.points[this.points.length - 1].copy(target);
      for (let i = this.points.length - 2; i >= 0; i--) {
        _fabrikDir.subVectors(this.points[i], this.points[i + 1]).normalize();
        this.points[i].copy(this.points[i + 1]).addScaledVector(_fabrikDir, this.lengths[i]);
      }

      this.points[0].copy(root);
      for (let i = 0; i < this.lengths.length; i++) {
        _fabrikDir.subVectors(this.points[i + 1], this.points[i]).normalize();
        this.points[i + 1].copy(this.points[i]).addScaledVector(_fabrikDir, this.lengths[i]);
      }

      if (this.points[this.points.length - 1].distanceToSquared(target) < this.tolerance) break;
    }

    return this.points;
  }
}

// ===================== Creature =====================
const whiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2 });
const debugPolyMat = new THREE.LineBasicMaterial({ color: 0x77c8a1, transparent: true, opacity: 0.85 });
const debugNormalMat = new THREE.LineBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.9 });
const debugComMat = new THREE.MeshBasicMaterial({ color: 0xffd166 });
const debugRestMat = new THREE.MeshBasicMaterial({ color: 0x79a8ff });
const debugLookMat = new THREE.MeshBasicMaterial({ color: 0x5fd6d0 });
const debugTargetMat = new THREE.MeshBasicMaterial({ color: 0x7bd88f });
const debugStrandedMat = new THREE.MeshBasicMaterial({ color: 0xff6b6b });
const debugScanMat = new THREE.LineBasicMaterial({ color: 0x5fd6d0, transparent: true, opacity: 0.48 });
const debugZoneMat = new THREE.LineBasicMaterial({ color: 0x9aa4b2, transparent: true, opacity: 0.26 });
const debugLinkMat = new THREE.LineBasicMaterial({ color: 0xd8dee9, transparent: true, opacity: 0.34 });
const debugArmReachMat = new THREE.LineBasicMaterial({ color: 0xd18cff, transparent: true, opacity: 0.22 });
const debugArmLinkMat = new THREE.LineBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.42 });
const debugPunchStrikeMat = new THREE.MeshBasicMaterial({ color: 0xff5d5d });
const debugPunchContactMat = new THREE.MeshBasicMaterial({ color: 0x7bd88f });
const debugPunchLinkMat = new THREE.LineBasicMaterial({ color: 0xff5d5d, transparent: true, opacity: 0.7 });
const debugArmStateMats = {
  idle: new THREE.MeshBasicMaterial({ color: 0x9aa4b2 }),
  reach: new THREE.MeshBasicMaterial({ color: 0x5fd6d0 }),
  grab: new THREE.MeshBasicMaterial({ color: 0xffd166 }),
  carry: new THREE.MeshBasicMaterial({ color: 0x7bd88f }),
  recover: new THREE.MeshBasicMaterial({ color: 0x79a8ff })
};
const blockGeo = new THREE.BoxGeometry(1, 1, 1);
blockGeo.userData.shared = true;
const pointGeo = new THREE.SphereGeometry(0.045, 8, 6);
pointGeo.userData.shared = true;
const geometryCache = new Map();
function geometryKey(type, ...values) {
  return `${type}:${values.map(v => Number(v).toFixed(4)).join(':')}`;
}
function sharedGeometry(key, create) {
  let geometry = geometryCache.get(key);
  if (!geometry) {
    geometry = create();
    geometry.userData.shared = true;
    geometryCache.set(key, geometry);
  }
  return geometry;
}
function boxGeometry(x, y, z) {
  return sharedGeometry(geometryKey('box', x, y, z), () => new THREE.BoxGeometry(x, y, z));
}
function sphereGeometry(r, widthSegments = 12, heightSegments = 10) {
  return sharedGeometry(geometryKey('sphere', r, widthSegments, heightSegments), () => new THREE.SphereGeometry(r, widthSegments, heightSegments));
}
function capsuleGeometry(radius, length, capSegments = 4, radialSegments = 10) {
  return sharedGeometry(geometryKey('capsule', radius, length, capSegments, radialSegments), () => new THREE.CapsuleGeometry(radius, length, capSegments, radialSegments));
}
const robotPalette = {
  shell: 0x55606c,
  plate: 0x2f363f,
  trim: 0x91a0ad,
  lightA: 0x66ffd1,
  lightB: 0xffd166
};
const _rotated = new THREE.Vector3(), _fwd = new THREE.Vector3(), _n = new THREE.Vector3(), _q = new THREE.Quaternion();
const _wander = new THREE.Vector3(), _sep = new THREE.Vector3(), _away = new THREE.Vector3(), _steer = new THREE.Vector3();
const _followOut = {}, _hostileOut = {}; // reusable outputs for followDesire/hostileDesire (no per-frame alloc)
const _chooseContact = new THREE.Vector3(); // holds the chosen punch-arm contact (proxy targets reuse one scratch)
const _com = { x: 0, z: 0 }, _near = { x: 0, z: 0 };
const _frontAvg = new THREE.Vector3(), _backAvg = new THREE.Vector3(), _leftAvg = new THREE.Vector3(), _rightAvg = new THREE.Vector3();
const _fabrikDir = new THREE.Vector3();
const _clearEuler = new THREE.Euler(), _clearQ = new THREE.Quaternion(), _clearV = new THREE.Vector3();
const _legRestGround = new THREE.Vector3(), _legMoveDir = new THREE.Vector3(), _legLookAhead = new THREE.Vector3();
const _armAxis = new THREE.Vector3(), _armPole = new THREE.Vector3(), _armPreferred = new THREE.Vector3();
const _groundedBuf = Array.from({ length: 16 }, () => ({ x: 0, y: 0, z: 0 }));
const _hullOut = [];
const _nearbyScratch = [];
const _trunkScratch = [];
const _instMatrix = new THREE.Matrix4();
const _instLocal = new THREE.Matrix4();
const _instPos = new THREE.Vector3();
const _instScale = new THREE.Vector3();
const _instQuat = new THREE.Quaternion();
const _instColor = new THREE.Color();
const _forageClaims = new Set();
const _forageTargets = new Map();
const _forageObjects = new Map();
const _activeCreatures = [];

function materialColor(material) {
  return material?.color || whiteMat.color;
}

function composeWorldMatrix(position, quaternion, scale, out = _instMatrix) {
  return out.compose(position, quaternion, scale);
}

function composeGroupLocalMatrix(group, part, out = _instMatrix) {
  part.updateMatrix();
  return out.multiplyMatrices(group.matrixWorld, part.matrix);
}

function composeBodyShadowMatrix(creature, out = _instMatrix) {
  _instPos.set(0, creature.plan.bodyScale.y * 0.04, 0);
  _instQuat.identity();
  _instScale.set(
    creature.plan.bodyScale.x * 1.72,
    Math.max(0.12, creature.plan.bodyScale.y * 0.88),
    creature.plan.bodyScale.z * 1.62
  );
  _instLocal.compose(_instPos, _instQuat, _instScale);
  return out.multiplyMatrices(creature.group.matrixWorld, _instLocal);
}

function createCreaturePartBatches({ scene, capacity = 4096 }) {
  const geometries = {
    box: new THREE.BoxGeometry(1, 1, 1),
    sphere: new THREE.SphereGeometry(1, 12, 10),
    capsule: new THREE.CapsuleGeometry(1, 1, 4, 10),
  };
  const buckets = {};
  const pickables = [];
  const defs = {
    shellBox: { geometry: geometries.box, material: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.58, metalness: 0.08 }) },
    plateBox: { geometry: geometries.box, material: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.64, metalness: 0.04 }) },
    trimBox: { geometry: geometries.box, material: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.44, metalness: 0.12 }) },
    lightBox: { geometry: geometries.box, material: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.45, roughness: 0.25 }) },
    footBox: { geometry: geometries.box, material: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.72 }) },
    jointSphere: { geometry: geometries.sphere, material: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.58 }) },
    limbSegment: { geometry: geometries.capsule, material: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.62 }) },
    shadowBox: { geometry: geometries.box, material: new THREE.MeshBasicMaterial({ color: 0x000000 }) },
  };
  defs.shadowBox.material.colorWrite = false;

  for (const [name, def] of Object.entries(defs)) {
    const mesh = new THREE.InstancedMesh(def.geometry, def.material, capacity);
    mesh.name = `CreatureBatch:${name}`;
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.userData.creatureBatch = true;
    mesh.userData.batchName = name;
    if (name === 'shadowBox') {
      mesh.castShadow = true;
      mesh.receiveShadow = false;
    } else {
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      pickables.push(mesh);
    }
    scene.add(mesh);
    buckets[name] = { mesh, owners: new Array(capacity), count: 0 };
  }

  function add(bucketName, matrix, color, owner = null) {
    const bucket = buckets[bucketName];
    if (!bucket || bucket.count >= capacity) return false;
    const i = bucket.count++;
    bucket.mesh.setMatrixAt(i, matrix);
    if (color && bucket.mesh.setColorAt) bucket.mesh.setColorAt(i, color);
    bucket.owners[i] = owner;
    return true;
  }

  return {
    stats: { boxes: 0, limbs: 0, joints: 0, handsFeet: 0, shadows: 0 },
    meshes: Object.values(buckets).map(bucket => bucket.mesh),
    pickables,
    beginFrame() {
      for (const bucket of Object.values(buckets)) {
        bucket.count = 0;
        bucket.owners.fill(null);
      }
      this.stats.boxes = 0;
      this.stats.limbs = 0;
      this.stats.joints = 0;
      this.stats.handsFeet = 0;
      this.stats.shadows = 0;
    },
    addBox(bucketName, matrix, color, owner) {
      if (add(bucketName, matrix, color, owner)) this.stats.boxes++;
    },
    addLimb(matrix, color, owner) {
      if (add('limbSegment', matrix, color, owner)) this.stats.limbs++;
    },
    addJoint(matrix, color, owner) {
      if (add('jointSphere', matrix, color, owner)) this.stats.joints++;
    },
    addHandFoot(matrix, color, owner) {
      if (add('footBox', matrix, color, owner)) this.stats.handsFeet++;
    },
    addShadow(matrix, owner) {
      if (add('shadowBox', matrix, null, owner)) this.stats.shadows++;
    },
    ownerForHit(hit) {
      const bucket = buckets[hit.object?.userData?.batchName];
      return bucket ? bucket.owners[hit.instanceId] : null;
    },
    endFrame() {
      for (const bucket of Object.values(buckets)) {
        bucket.mesh.count = bucket.count;
        bucket.mesh.instanceMatrix.needsUpdate = true;
        if (bucket.mesh.instanceColor) bucket.mesh.instanceColor.needsUpdate = true;
      }
    },
    dispose() {
      const disposedGeometries = new Set();
      for (const bucket of Object.values(buckets)) {
        scene.remove(bucket.mesh);
        if (!disposedGeometries.has(bucket.mesh.geometry)) {
          bucket.mesh.geometry.dispose();
          disposedGeometries.add(bucket.mesh.geometry);
        }
        bucket.mesh.material.dispose();
      }
    },
  };
}

const creatureBatches = CREATURE_INSTANCING_MODE === 'off'
  ? null
  : createCreaturePartBatches({ scene, capacity: 8192 });

class SpatialGrid {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.invCell = 1 / cellSize;
    this.cells = new Map();
  }
  _key(ix, iz) { return (ix + 200) * 1000 + (iz + 200); }
  clear() { this.cells.clear(); }
  add(c) {
    const p = c.pos || c.position;
    const k = this._key(Math.floor(p.x * this.invCell), Math.floor(p.z * this.invCell));
    let cell = this.cells.get(k);
    if (!cell) { cell = []; this.cells.set(k, cell); }
    cell.push(c);
  }
  nearby(x, z, out) {
    const ix = Math.floor(x * this.invCell), iz = Math.floor(z * this.invCell);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const cell = this.cells.get(this._key(ix + di, iz + dj));
        if (cell) for (const c of cell) out.push(c);
      }
    }
  }
}
const creatureGrid = new SpatialGrid(5.0);
const targetMarker = new THREE.Mesh(
  new THREE.CylinderGeometry(0.28, 0.28, 0.035, 24),
  new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.72 })
);
targetMarker.visible = false;
scene.add(targetMarker);
const raceVisualGroup = new THREE.Group();
const raceLineMat = new THREE.LineBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.44 });
const raceStartMat = new THREE.MeshBasicMaterial({ color: 0x77c8a1, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false });
const raceEndMat = new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.78, side: THREE.DoubleSide, depthWrite: false });
const raceMarkerGeo = new THREE.RingGeometry(0.26, 0.34, 28);
raceVisualGroup.visible = false;
scene.add(raceVisualGroup);
const contactPulses = [];
const pulseGeo = new THREE.RingGeometry(0.08, 0.11, 28);
const pulseMat = new THREE.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
const selectionHelper = new THREE.BoxHelper(new THREE.Object3D(), 0xffd166);
selectionHelper.visible = false;
scene.add(selectionHelper);

const GRAB_RADIUS = 0.32;
const OBJECT_RADIUS = 0.22;
const OBJECT_SPAWN_PAD = 0.42;
const FORAGE_ATTEMPT_TIMEOUT = 2.6;
const FORAGE_IGNORE_TIME = 3.8;
const MAX_HEALTH = 100;
const WEAK_HEALTH = 34;
const HEAL_AMOUNT = 24;
const SLEEP_REGEN = 3.2; // HP/sec while ACT_SLEEP
const GRAZE_REGEN = 1.1; // HP/sec while ACT_GRAZE (lighter than sleep)
const EAT_COOLDOWN = 0.75;
const ATTACK_DAMAGE = 16;
const ATTACK_COOLDOWN = 0.5;
const ATTACK_WINDUP = 0.15;
const ATTACK_RECOVER = 0.22;
const PUNCH_RADIUS = 0.20;
const DEATH_FALL_TIME = 1.05;
const TEAM_COLORS = [0x66ffd1, 0xffd166, 0xd18cff, 0xff6b6b, 0x79a8ff, 0x7bd88f];
const objectGeo = new THREE.BoxGeometry(OBJECT_RADIUS * 2, OBJECT_RADIUS * 2, OBJECT_RADIUS * 2);
const objectMaterials = [
  new THREE.MeshStandardMaterial({ color: 0xffd166, roughness: 0.52, metalness: 0.04 }),
  new THREE.MeshStandardMaterial({ color: 0x77c8a1, roughness: 0.56, metalness: 0.04 }),
  new THREE.MeshStandardMaterial({ color: 0x79a8ff, roughness: 0.50, metalness: 0.06 }),
  new THREE.MeshStandardMaterial({ color: 0xd18cff, roughness: 0.58, metalness: 0.03 })
];
const grabbables = [];
const objectGrid = new SpatialGrid(5.0);
const creatureStats = {
  updateMs: 0,
  lodMs: 0,
  objectsMs: 0,
  behaviorMs: 0,
  steeringMs: 0,
  physicsMs: 0,
  renderMs: 0,
  selectionMs: 0,
  perfDetailDistance: creaturePerf.detailDistance,
  perfBodyOnlyDistance: creaturePerf.bodyOnlyDistance,
  perfHideDistance: creaturePerf.hideDistance,
  perfFullUpdateStride: creaturePerf.fullUpdateStride,
  perfBodyUpdateStride: creaturePerf.bodyUpdateStride,
  perfFarUpdateStride: creaturePerf.farUpdateStride,
  perfIkDistance: creaturePerf.ikDistance,
  perfShadowDistance: creaturePerf.shadowDistance,
  count: 0,
  visible: 0,
  sim: 0,
  rendered: 0,
  tiers: [0, 0, 0, 0],
  bodyOnly: 0,
  armsActive: 0,
  shadowCasters: 0,
  ikFull: 0,
  ikCheap: 0,
  instancingMode: CREATURE_INSTANCING_MODE,
  instancedBoxes: 0,
  instancedLimbs: 0,
  instancedJoints: 0,
  instancedHandsFeet: 0,
  instancedShadows: 0
};

function rebuildObjectGrid() {
  objectGrid.clear();
  for (const object of grabbables) {
    if (!object.heldBy && !object.stowedBy) objectGrid.add(object);
  }
}

function refreshObjectCount() {
  const input = document.getElementById('objectCount');
  if (input) input.value = String(grabbables.length);
}

function removeGrabbable(object) {
  if (!object) return;
  for (const creature of creatures) {
    if (!creature.arms) continue;
    for (const arm of creature.arms) {
      if (arm.focus === object) arm.focus = null;
      if (arm.holding === object) arm.holding = null;
    }
  }
  const index = grabbables.indexOf(object);
  if (index >= 0) grabbables.splice(index, 1);
  object.heldBy = null;
  object.reservedBy = null;
  object.stowedBy = null;
  object.stowLocal = null;
  object.dispose();
  refreshObjectCount();
}

const _roamOut = { x: 0, z: 0 };
// Self-relative wander pick (anti-backtrack + world bounds); updates creature.roamTarget/roamPrev in place.
function nextRoamTarget(creature) {
  const bounds = getWorldBounds ? getWorldBounds() : null;
  pickRoamTarget(creature.pos.x, creature.pos.z, creature.roamPrev.x, creature.roamPrev.z, ROAM_MIN_STEP, ROAM_MAX_STEP, bounds, Math.random, _roamOut);
  creature.roamPrev.copy(creature.pos);
  creature.roamTarget.set(_roamOut.x, 0, _roamOut.z);
  return creature.roamTarget;
}

function addContactPulse(position) {
  if (contactPulses.length > 90) return;
  const mesh = new THREE.Mesh(pulseGeo, pulseMat.clone());
  mesh.position.set(position.x, terrainHeight(position.x, position.z) + 0.018, position.z);
  mesh.rotation.x = -Math.PI / 2;
  mesh.userData.age = 0;
  scene.add(mesh);
  contactPulses.push(mesh);
}

function updateContactPulses(dt) {
  for (let i = contactPulses.length - 1; i >= 0; i--) {
    const pulse = contactPulses[i];
    pulse.userData.age += dt;
    const t = pulse.userData.age / 0.55;
    pulse.scale.setScalar(1 + t * 3.4);
    pulse.material.opacity = Math.max(0, 0.55 * (1 - t));
    if (t >= 1) {
      scene.remove(pulse);
      pulse.material.dispose();
      contactPulses.splice(i, 1);
    }
  }
}

class Grabbable {
  constructor(position, materialIndex = 0) {
    this.position = position.clone();
    this.velocity = new THREE.Vector3();
    this.materialIndex = materialIndex % objectMaterials.length;
    this.heldBy = null;
    this.reservedBy = null;
    this.stowedBy = null;
    this.stowLocal = null;
    this.mesh = new THREE.Mesh(objectGeo, objectMaterials[this.materialIndex]);
    this.mesh.castShadow = false;
    this.mesh.userData.grabbable = this;
    this.mesh.position.copy(this.position);
    scene.add(this.mesh);
  }

  dispose() {
    scene.remove(this.mesh);
  }

  update(dt) {
    if (this.stowedBy) {
      this.velocity.set(0, 0, 0);
      return;
    }

    if (this.heldBy) {
      this.position.copy(this.heldBy.hand.position);
      this.mesh.position.copy(this.position);
      this.velocity.set(0, 0, 0);
      return;
    }

    this.velocity.y -= GRAV * dt;
    this.position.addScaledVector(this.velocity, dt);
    const floor = terrainHeight(this.position.x, this.position.z) + OBJECT_RADIUS;
    if (this.position.y < floor) {
      this.position.y = floor;
      this.velocity.y = Math.max(0, -this.velocity.y * 0.18);
      this.velocity.x *= 0.88;
      this.velocity.z *= 0.88;
    }
    this.mesh.position.copy(this.position);
    this.mesh.rotation.x += this.velocity.z * dt * 0.45;
    this.mesh.rotation.z -= this.velocity.x * dt * 0.45;
  }
}

function objectCountValue() {
  const input = document.getElementById('objectCount');
  const count = Math.max(0, Math.round(Number(input.value) || 0));
  input.value = String(count);
  return count;
}

function clearGrabbables() {
  for (const creature of creatures) {
    if (!creature.arms) continue;
    for (const arm of creature.arms) resetArmState(arm);
  }
  for (const object of grabbables) object.dispose();
  grabbables.length = 0;
}

function spawnRandomObjects(count = objectCountValue()) {
  clearGrabbables();
  const rng = seededRandom(currentSeed(64000) + count * 31);
  const size = Math.max(8, Math.abs(Number(terrainSettings.size) || 66));
  const half = size * 0.42;
  for (let i = 0; i < count; i++) {
    let x, z;
    if (creatures.length && i < creatures.length * 2) {
      const creature = creatures[i % creatures.length];
      const side = i % 2 === 0 ? -1 : 1;
      const local = new THREE.Vector3(
        side * randRange(rng, 0.85, 1.35) * creature.plan.bodyScale.x,
        0,
        randRange(rng, 0.75, 1.35) * creature.plan.bodyScale.z
      );
      rotateXZ(local, creature.yaw, _rotated);
      x = creature.pos.x + _rotated.x;
      z = creature.pos.z + _rotated.z;
    } else {
      x = randRange(rng, -half, half);
      z = randRange(rng, -half, half);
    }
    const y = terrainHeight(x, z) + OBJECT_RADIUS + OBJECT_SPAWN_PAD + randRange(rng, 0, 0.35);
    grabbables.push(new Grabbable(new THREE.Vector3(x, y, z), i));
  }
}

function spawnObjectsFromConfig(configs) {
  clearGrabbables();
  if (!Array.isArray(configs)) return;
  for (const config of configs) {
    const x = Number(config.x) || 0;
    const z = Number(config.z) || 0;
    const y = Number.isFinite(Number(config.y)) ? Number(config.y) : terrainHeight(x, z) + OBJECT_RADIUS;
    const object = new Grabbable(new THREE.Vector3(x, y, z), Number(config.material) || 0);
    if (Number.isInteger(config.stowedBy) && creatures[config.stowedBy] && Array.isArray(config.stowLocal)) {
      object.stowedBy = creatures[config.stowedBy];
      object.stowLocal = new THREE.Vector3().fromArray(config.stowLocal);
    }
    grabbables.push(object);
  }
  refreshObjectCount();
}

function objectsToConfig() {
  return grabbables.map(object => ({
    x: object.position.x,
    y: object.position.y,
    z: object.position.z,
    material: object.materialIndex,
    stowedBy: object.stowedBy ? creatures.indexOf(object.stowedBy) : null,
    stowLocal: object.stowLocal ? object.stowLocal.toArray() : null
  }));
}

function dropAllObjects() {
  for (const creature of creatures) {
    const dropVelocity = creature.vel.clone().add(new THREE.Vector3(0, 0.45, 0));
    if (!creature.arms) continue;
    for (const arm of creature.arms) {
      resetArmState(arm, dropVelocity);
    }
    if (creature.dropStowedObjects) creature.dropStowedObjects(dropVelocity);
  }
}

function updateGrabbables(dt) {
  for (const object of grabbables) object.update(dt);
}

function reheightFreeObjects() {
  for (const object of grabbables) {
    if (object.heldBy || object.stowedBy) continue;
    object.position.y = Math.max(object.position.y, terrainHeight(object.position.x, object.position.z) + OBJECT_RADIUS);
    object.mesh.position.copy(object.position);
  }
}

function resetArmState(arm, dropVelocity = null) {
  if (arm.focus && arm.focus.reservedBy === arm) arm.focus.reservedBy = null;
  if (arm.holding) {
    arm.holding.heldBy = null;
    arm.holding.reservedBy = null;
    arm.holding.stowedBy = null;
    arm.holding.stowLocal = null;
    if (dropVelocity) arm.holding.velocity.copy(dropVelocity);
    arm.holding = null;
  }
  arm.focus = null;
  arm.state = 'idle';
  arm.stateTime = 0;
}

function nearestFreeObject(position, maxDistance, owner = null) {
  let best = null;
  let bestD = maxDistance * maxDistance;
  for (const object of grabbables) {
    if (object.heldBy || object.stowedBy) continue;
    if (object.reservedBy && object.reservedBy !== owner) continue;
    const d = position.distanceToSquared(object.position);
    if (d < bestD) {
      bestD = d;
      best = object;
    }
  }
  return best;
}

function objectAvailableForCreature(object, creature) {
  if (!object || object.heldBy || object.stowedBy) return false;
  if (!creature?.arms?.length) return false;
  if (creature.forageIgnore?.get(object) > 0) return false;
  if (object.reservedBy && object.reservedBy.owner !== creature) return false;
  return true;
}

function forageObjectForCreature(creature, claimed = null) {
  let best = null;
  let bestScore = Infinity;
  _nearbyScratch.length = 0;
  objectGrid.nearby(creature.pos.x, creature.pos.z, _nearbyScratch);
  const candidates = _nearbyScratch.length > 0 ? _nearbyScratch : grabbables;
  for (const object of candidates) {
    if (!objectAvailableForCreature(object, creature)) continue;
    if (claimed?.has(object) && object.reservedBy?.owner !== creature) continue;
    const distance = Math.hypot(object.position.x - creature.pos.x, object.position.z - creature.pos.z);
    const reservedBonus = object.reservedBy?.owner === creature ? -2.2 : 0;
    const score = distance + reservedBonus;
    if (score < bestScore) {
      bestScore = score;
      best = object;
    }
  }
  return best;
}

function armSpecsForPlan(plan, settings) {
  const specs = [];
  if (!settings || settings.plan === 'none' || settings.count <= 0) return specs;

  const pairs = Math.max(1, Math.ceil(settings.count / 2));
  for (let i = 0; i < settings.count; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const row = Math.floor(i / 2);
    const t = pairs === 1 ? 0 : row / (pairs - 1);
    let attachZ = lerp(plan.bodyScale.z * 0.54, plan.bodyScale.z * -0.34, t);
    let restZ = attachZ + plan.bodyScale.z * 0.30;
    let attachX = plan.bodyScale.x * 0.76;
    let restX = plan.bodyScale.x * 1.14;
    let attachY = plan.bodyScale.y * 0.03;
    let restY = -0.25;
    let lengthMult = settings.length;
    let bend = new THREE.Vector3(side * 0.82, -0.46, 0.18).normalize();
    let segments = [
      { length: 0.58, initDirection: new THREE.Vector3(side * 0.70, -0.28, 0.38).normalize() },
      { length: 0.48, initDirection: new THREE.Vector3(side * 0.34, -0.58, 0.28).normalize() },
      { length: 0.32, initDirection: new THREE.Vector3(side * 0.18, -0.24, 0.72).normalize() }
    ];

    if (settings.plan === 'side') {
      attachZ = lerp(plan.bodyScale.z * 0.54, plan.bodyScale.z * -0.54, t);
      restZ = attachZ;
      restX = plan.bodyScale.x * 1.36;
      bend = new THREE.Vector3(side * 1.0, -0.34, 0.02).normalize();
    } else if (settings.plan === 'claws') {
      attachZ = lerp(plan.bodyScale.z * 0.70, plan.bodyScale.z * 0.42, t);
      restZ = attachZ + plan.bodyScale.z * 0.20;
      restX = plan.bodyScale.x * 1.02;
      restY = -0.18;
      lengthMult *= 0.72;
      bend = new THREE.Vector3(side * 0.78, -0.26, 0.36).normalize();
      segments = [
        { length: 0.42, initDirection: new THREE.Vector3(side * 0.76, -0.18, 0.40).normalize() },
        { length: 0.34, initDirection: new THREE.Vector3(side * 0.34, -0.42, 0.50).normalize() },
        { length: 0.22, initDirection: new THREE.Vector3(side * 0.16, -0.12, 0.82).normalize() }
      ];
    } else if (settings.plan === 'tentacle') {
      attachZ = lerp(plan.bodyScale.z * 0.58, plan.bodyScale.z * -0.46, t);
      restZ = attachZ + plan.bodyScale.z * 0.40;
      restX = plan.bodyScale.x * 1.22;
      restY = -0.30;
      lengthMult *= 1.24;
      bend = new THREE.Vector3(side * 0.54, -0.60, 0.32).normalize();
      segments = [
        { length: 0.42, initDirection: new THREE.Vector3(side * 0.50, -0.20, 0.46).normalize() },
        { length: 0.36, initDirection: new THREE.Vector3(side * 0.32, -0.42, 0.42).normalize() },
        { length: 0.30, initDirection: new THREE.Vector3(side * 0.22, -0.34, 0.58).normalize() },
        { length: 0.24, initDirection: new THREE.Vector3(side * 0.12, -0.18, 0.78).normalize() }
      ];
    }

    const scale = Math.max(0.62, Math.min(1.7, plan.bodyScale.x * 0.42 + plan.bodyScale.z * 0.26)) * lengthMult;
    const carryT = pairs === 1 ? 0.5 : t;
    const carryX = side * plan.bodyScale.x * 0.28;
    const carryY = plan.bodyScale.y * (0.58 + settings.carryHeight);
    const carryZ = -plan.bodyScale.z * lerp(0.34, 0.78, carryT);
    specs.push({
      index: i,
      side,
      attachmentLocal: new THREE.Vector3(side * attachX, attachY, attachZ),
      restLocal: new THREE.Vector3(side * restX, restY, restZ),
      carryLocal: new THREE.Vector3(carryX, carryY, carryZ),
      bendLocal: bend,
      bendStrength: settings.bend,
      grabRadius: settings.grabRadius,
      interest: settings.interest,
      segments: segments.map(segment => ({
        length: segment.length * scale,
        initDirection: segment.initDirection
      }))
    });
  }
  return specs;
}

class Creature {
  constructor(spawn, yaw, hue, plan, style, gait, behavior = null, config = null) {
    this.plan = plan;
    this.style = style;
    this.gait = gait;
    this.behavior = null;
    this.role = ROLE_WILD;       // player-interaction role: wild | pet | hostile
    this.petCommand = CMD_FOLLOW; // active pet command when role === pet
    this.petTarget = null;       // goto point / attack target for pet commands
    this._followPhase = Math.random() * Math.PI * 2; // stable ring slot so grouped followers fan out
    this.config = config;
    this.armSettings = cloneArmSettings(config?.arms || armSettingsFromModel());
    this.teamId = Number.isFinite(Number(config?.teamId)) ? Math.max(0, Math.round(Number(config.teamId))) : 0;
    this.health = Number.isFinite(Number(config?.health)) ? clamp(Number(config.health), 0, MAX_HEALTH) : MAX_HEALTH;
    this.combatTarget = null;
    this.attackState = 'ready';
    this.attackTimer = 0;
    this.attackCooldown = Math.random() * 0.35;
    this.attackApplied = false;
    this.punchArm = null;
    this.punchTarget = new THREE.Vector3();
    this.punchContact = new THREE.Vector3();
    this.punchStrikePoint = new THREE.Vector3();
    this.hitFlash = 0;
    this.eatCooldown = Math.random() * 0.4;
    this.healFlash = 0;
    this.healingTarget = null;
    this.deathTimer = 0;
    this.deathLootSpawned = false;
    this.removeAfterDeath = false;
    if (this.health <= 0) this.attackState = 'down';
    const skinC = new THREE.Color().setHSL(hue, 0.45, 0.58);
    const skin = new THREE.MeshStandardMaterial({ color: skinC, roughness: 0.46, metalness: 0.04 });
    this.limbMat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(hue, 0.40, 0.34), roughness: 0.62 });
    this.jointMat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(hue, 0.36, 0.43), roughness: 0.58 });
    this.footMat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(hue, 0.35, 0.20), roughness: 0.72 });
    this.shellMat = new THREE.MeshStandardMaterial({ color: style.shell, roughness: 0.58, metalness: 0.08 });
    this.plateMat = new THREE.MeshStandardMaterial({ color: style.plate, roughness: 0.64, metalness: 0.04 });
    this.trimMat = new THREE.MeshStandardMaterial({ color: style.trim, roughness: 0.44, metalness: 0.12 });
    this.lightMats = [
      new THREE.MeshStandardMaterial({ color: style.lightA, emissive: style.lightA, emissiveIntensity: 0.55, roughness: 0.25 }),
      new THREE.MeshStandardMaterial({ color: style.lightB, emissive: style.lightB, emissiveIntensity: 0.40, roughness: 0.25 })
    ];
    this.blinkers = [];
    this.blinkPhase = Math.random() * 10;
    this.teamMat = new THREE.MeshBasicMaterial({ color: TEAM_COLORS[this.teamId % TEAM_COLORS.length] });
    this.healthBackMat = new THREE.MeshBasicMaterial({ color: 0x20242a, transparent: true, opacity: 0.72 });
    this.healthMat = new THREE.MeshBasicMaterial({ color: 0x7bd88f });
    this.hitMat = new THREE.MeshBasicMaterial({ color: 0xff6b6b, transparent: true, opacity: 0.0 });
    this._rigidBodyParts = [];
    this._instancedBoxes = [];
    this.shadowBodyMeshes = [];

    this.group = new THREE.Group();
    this.group.rotation.order = 'YXZ';
    scene.add(this.group);

    this.teamMarker = new THREE.Mesh(boxGeometry(0.28, 0.055, 0.16), this.teamMat);
    this.teamMarker.position.set(-plan.bodyScale.x * 0.58, plan.bodyScale.y * 0.66 + 0.17, plan.bodyScale.z * 0.36);
    this.group.add(this.teamMarker);

    this.healthBack = new THREE.Mesh(boxGeometry(0.82, 0.035, 0.05), this.healthBackMat);
    this.healthBack.position.set(0, plan.bodyScale.y * 0.70 + 0.28, -plan.bodyScale.z * 0.18);
    this.group.add(this.healthBack);
    this.healthBar = new THREE.Mesh(boxGeometry(0.78, 0.042, 0.06), this.healthMat);
    this.healthBar.position.copy(this.healthBack.position).add(new THREE.Vector3(0, 0.004, 0.002));
    this.group.add(this.healthBar);
    this.hitFlashMesh = new THREE.Mesh(boxGeometry(plan.bodyScale.x * 1.62, 0.05, plan.bodyScale.z * 1.52), this.hitMat);
    this.hitFlashMesh.position.set(0, plan.bodyScale.y * 0.50 + 0.12, 0);
    this.group.add(this.hitFlashMesh);

    this._box(new THREE.Vector3(0, -0.02, 0), new THREE.Vector3(plan.bodyScale.x * 1.55, plan.bodyScale.y * 0.72, plan.bodyScale.z * 1.46), this.shellMat);
    this._box(new THREE.Vector3(0, 0.16, 0), new THREE.Vector3(plan.bodyScale.x * 1.18, 0.14, plan.bodyScale.z * 1.10), this.plateMat);
    this._box(new THREE.Vector3(0, -0.25, 0), new THREE.Vector3(plan.bodyScale.x * 1.32, 0.18, plan.bodyScale.z * 1.22), this.plateMat);
    for (const sx of [-1, 1]) {
      this._box(new THREE.Vector3(sx * plan.bodyScale.x * 0.86, -0.02, 0), new THREE.Vector3(0.08, 0.18, plan.bodyScale.z * 1.16), this.trimMat);
      const light = this._box(new THREE.Vector3(sx * plan.bodyScale.x * 0.90, 0.14, plan.bodyScale.z * 0.24), new THREE.Vector3(0.045, 0.07, 0.14), this.lightMats[0]);
      this.blinkers.push(light);
    }
    const plateCount = Math.max(2, Math.min(7, Math.round(plan.bodyScale.z * 4.2)));
    for (let i = 0; i < plateCount; i++) {
      const t = plateCount === 1 ? 0.5 : i / (plateCount - 1);
      const z = lerp(plan.bodyScale.z * 0.62, -plan.bodyScale.z * 0.62, t);
      this._box(new THREE.Vector3(0, plan.bodyScale.y * 0.42 + 0.08, z), new THREE.Vector3(plan.bodyScale.x * 0.52 * (1 - Math.abs(t - 0.5) * 0.5), 0.08, 0.10), this.trimMat);
    }
    for (const sx of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        const z = lerp(plan.bodyScale.z * 0.45, -plan.bodyScale.z * 0.45, i / 2);
        this._box(new THREE.Vector3(sx * plan.bodyScale.x * 0.72, plan.bodyScale.y * 0.22, z), new THREE.Vector3(0.06, 0.06, 0.06), this.lightMats[i % 2]);
      }
    }

    if (plan.head) {
      this._box(new THREE.Vector3(0, 0.10, plan.bodyScale.z * 0.80), new THREE.Vector3(0.40, 0.30, 0.34), skin);
      for (const sx of [-1, 1]) {
        const eye = this._box(new THREE.Vector3(sx * 0.11, 0.16, plan.bodyScale.z * 0.80 + 0.18), new THREE.Vector3(0.08, 0.06, 0.035), this.lightMats[0]);
        this.blinkers.push(eye);
      }
      for (const sx of [-1, 1]) {
        const sensor = this._box(new THREE.Vector3(sx * 0.18, 0.30, plan.bodyScale.z * 0.80 + 0.05), new THREE.Vector3(0.035, 0.22, 0.035), this.trimMat);
        sensor.rotation.z = sx * 0.45;
      }
    }
    this._mergeRigidBodyParts();

    this.legs = plan.legs.map((d, index) => {
      const instancedParts = creatureBatches && CREATURE_INSTANCING_MODE === 'parts';
      const hipBall = instancedParts ? new THREE.Object3D() : new THREE.Mesh(sphereGeometry(0.10, 12, 10), this.jointMat);
      hipBall.castShadow = false;
      hipBall.position.copy(d.attachment);
      hipBall.userData.radius = 0.10;
      hipBall.userData.creature = this;
      hipBall.userData.material = this.jointMat;
      if (!instancedParts) this.group.add(hipBall);

      const foot = instancedParts ? new THREE.Object3D() : new THREE.Mesh(boxGeometry(0.22, FOOT_GROUND * 2, 0.34), this.footMat);
      foot.castShadow = false;
      foot.userData.creature = this;
      foot.userData.size = new THREE.Vector3(0.22, FOOT_GROUND * 2, 0.34);
      foot.userData.material = this.footMat;
      if (!instancedParts) scene.add(foot);

      return {
        index,
        row: d.row,
        side: d.side,
        attachmentLocal: d.attachment.clone(),
        hipBall,
        restLocal: d.rest.clone(),
        phase: (d.row + (d.side > 0 ? 1 : 0)) % 2,
        chain: new KinematicChain(d.segments),
        segments: d.segments.map(s => this._cap(s.length, 0.066 + Math.min(0.028, s.length * 0.028))),
        joints: d.segments.slice(0, -1).map(() => this._joint(0.078)),
        foot,
        end: new THREE.Vector3(),
        stepStart: new THREE.Vector3(),
        stepEnd: new THREE.Vector3(),
        target: new THREE.Vector3(),
        groundPosition: new THREE.Vector3(),
        lookAhead: new THREE.Vector3(),
        scanStart: new THREE.Vector3(),
        scanEnd: new THREE.Vector3(),
        targetGrounded: true,
        stepping: false,
        t: 0,
        timeSinceBeginMove: 999,
        timeSinceStopMove: 999,
        canMove: false,
        primary: false,
        wants: false,
        uncomfortable: false,
        restX: 0,
        restY: 0,
        restZ: 0,
        // Phase 1 perf caches (creature-perf-analysis/plan.md 1.4, 1.6):
        _hipWorld: new THREE.Vector3(),       // reused localToWorld target (1.6)
        _footQuat: new THREE.Quaternion(),    // cached foot orientation (1.4)
        _normSampleX: Infinity,               // where _footQuat was last computed
        _normSampleZ: Infinity,
        _normYaw: 999
      };
    });

    this.arms = armSpecsForPlan(plan, this.armSettings).map(spec => {
      const instancedParts = creatureBatches && CREATURE_INSTANCING_MODE === 'parts';
      const shoulder = instancedParts ? new THREE.Object3D() : new THREE.Mesh(sphereGeometry(0.075, 12, 10), this.jointMat);
      shoulder.castShadow = false;
      shoulder.position.copy(spec.attachmentLocal);
      shoulder.userData.radius = 0.075;
      shoulder.userData.creature = this;
      shoulder.userData.material = this.jointMat;
      if (!instancedParts) this.group.add(shoulder);

      const hand = instancedParts ? new THREE.Object3D() : new THREE.Mesh(boxGeometry(0.18, 0.11, 0.18), this.footMat);
      hand.castShadow = false;
      hand.userData.creature = this;
      hand.userData.size = new THREE.Vector3(0.18, 0.11, 0.18);
      hand.userData.material = this.footMat;
      if (!instancedParts) scene.add(hand);

      return {
        index: spec.index,
        side: spec.side,
        owner: this,
        shoulder,
        attachmentLocal: shoulder.position.clone(),
        restLocal: spec.restLocal.clone(),
        carryLocal: spec.carryLocal.clone(),
        chain: new KinematicChain(spec.segments),
        segments: spec.segments.map(s => this._cap(s.length, 0.044 + Math.min(0.014, s.length * 0.02))),
        joints: spec.segments.slice(0, -1).map(() => this._joint(0.052)),
        hand,
        state: 'idle',
        stateTime: 0,
        acquireCooldown: 0,
        focus: null,
        holding: null,
        aim: new THREE.Vector3(),
        desiredTarget: new THREE.Vector3(),
        target: new THREE.Vector3(),
        prevHand: new THREE.Vector3(),
        bendLocal: spec.bendLocal.clone(),
        bendStrength: spec.bendStrength,
        grabRadius: spec.grabRadius,
        interest: spec.interest,
        reach: spec.segments.reduce((sum, s) => sum + s.length, 0),
        // Phase 2 perf (creature-perf-analysis/plan.md 2.1): pooled scratch vectors
        // for the per-frame arm IK/constraint pipeline, reused in place of .clone().
        // Each is fully consumed before the next reuse within a single arm's render.
        _shoulderWorld: new THREE.Vector3(),  // localToWorld(attachmentLocal), live for the whole arm render
        _restWorld: new THREE.Vector3(),      // armRestTarget / carry localToWorld target
        _localScratch: new THREE.Vector3(),   // constrainArmTarget worldToLocal temp
        _pointScratch: new THREE.Vector3(),   // constrainArmPoint worldToLocal temp (per IK point)
        _carryWorld: new THREE.Vector3()      // renderArms carry-target localToWorld
      };
    });

    // --- Phase 1 perf caches (creature-perf-analysis/plan.md) ---
    // 1.1: collision/melee radii and max arm reach are pure functions of
    // construction-immutable data (leg.restLocal, arm.reach, plan.bodyScale — none
    // mutate at runtime), so compute once instead of on every pairwise separation /
    // collision check. The methods below become thin accessors.
    let _legReach = 0;
    for (const leg of this.legs) _legReach = Math.max(_legReach, Math.hypot(leg.restLocal.x, leg.restLocal.z));
    this._collisionRadius = Math.max(this.plan.bodyScale.x * 1.05, this.plan.bodyScale.z * 0.92, _legReach * 0.42) + BODY_COLLISION_PAD;
    let _armReach = 0;
    for (const arm of this.arms) _armReach = Math.max(_armReach, arm.reach);
    this._maxArmReach = _armReach;
    this._meleeRadius = Math.max(this.plan.bodyScale.x * 0.86, this.plan.bodyScale.z * 0.76) + BODY_VOLUME_CLEAR;
    // 1.3: leg row/side topology is fixed at construction, so precompute partner
    // lists here rather than re-deriving them (with fresh Sets/arrays) per leg per
    // fixed step inside scheduleSteps.
    for (const leg of this.legs) {
      leg.adjacentPartnersCached = this.adjacentPartners(leg);
      leg.diagonalPartnersCached = this.diagonalPartners(leg);
      leg.rowMateCached = this.legBy(leg.row, -leg.side);
      leg.crossRowsCached = this.legs.filter(l => Math.abs(l.row - leg.row) === 1);
    }

    this.pos = spawn.clone();
    this.vel = new THREE.Vector3();
    this.yaw = yaw;
    this.pitch = 0;
    this.roll = 0;
    this.preferredPitch = 0;
    this.preferredRoll = 0;
    this.roamPrev = spawn.clone();
    this.roamTarget = new THREE.Vector3();
    nextRoamTarget(this);
    this.desiredDir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    this._prevPos = spawn.clone(); // odometer anchor (updated per physicsStep)
    this.metrics = { // locomotion diagnostics; only updated while lodShouldSim
      speed: 0, speedAvg: 0, maxSpeed: 0, effAvg: 0,
      headingErr: 0, headingErrAvg: 0, groundedFrac: 0, groundedAvg: 0,
      uncomfortable: 0, distance: 0, simTime: 0, stallTime: 0, stallFrac: 0,
      // Stage 2 richer diagnostics
      dragAvg: 0, scanFailPct: 0, stuckPct: 0, comOutsidePct: 0, wobbleDeg: 0,
      pitchMean: 0, pitchVar: 0, rollMean: 0, rollVar: 0 // internal EMA state for wobble
    };
    this.forageTarget = null;
    this.forageCloseTime = 0;
    this.forageIgnore = new Map();
    this.forageCrouch = 0;
    this.activity = ACT_WANDER; // wild-activity FSM (Phase 2)
    this.temperament = config?.temperament?.weights || defaultTemperament(); // per-creature activity bias (Phase 3)
    this.temperamentName = config?.temperament?.name || 'balanced';
    this.temperamentPip = new THREE.Mesh(boxGeometry(0.16, 0.16, 0.16), temperamentMat(this.temperamentName)); // in-world personality badge
    this.temperamentPip.position.set(plan.bodyScale.x * 0.58, plan.bodyScale.y * 0.66 + 0.17, plan.bodyScale.z * 0.36);
    this.group.add(this.temperamentPip);
    this.activityTimer = ACT_DURATION[ACT_WANDER][0] + Math.random() * (ACT_DURATION[ACT_WANDER][1] - ACT_DURATION[ACT_WANDER][0]); // desync
    this.huntTarget = null;
    this.socialTarget = null;
    this.restPose = 0;
    this._forageTargetScratch = new THREE.Vector3();
    this._raceTargetScratch = new THREE.Vector3();
    this._raceStartScratch = new THREE.Vector3();
    this.debugData = null;
    this.lodTier = 0;
    this.lodStride = 1;
    this.lodFrameOffset = Math.floor(Math.random() * creaturePerf.farUpdateStride);
    this.lodShouldSim = true;
    this.lodArmsActive = true;
    this.lodDebugActive = false;
    this.lodFullIk = true;
    this.lodVisible = true;
    this.lodCastsShadow = true;
    this.forceFootTargetRefresh = true;
    this.debugGroup = this._makeDebugGroup();

    for (const arm of this.arms) {
      rotateXZ(arm.restLocal, yaw, _rotated);
      arm.hand.position.set(this.pos.x + _rotated.x, this.pos.y + arm.restLocal.y, this.pos.z + _rotated.z);
      arm.prevHand.copy(arm.hand.position);
    }

    for (const leg of this.legs) {
      rotateXZ(leg.restLocal, yaw, _rotated);
      const wx = this.pos.x + _rotated.x;
      const wz = this.pos.z + _rotated.z;
      leg.end.set(wx, terrainHeight(wx, wz) + FOOT_GROUND, wz);
      leg.target.copy(leg.end);
      leg.groundPosition.copy(leg.end);
      leg.lookAhead.copy(leg.end);
      leg.scanStart.copy(leg.end).add(new THREE.Vector3(0, 1.2, 0));
      leg.scanEnd.copy(leg.end).add(new THREE.Vector3(0, -1.2, 0));
    }
  }

  _box(position, scale, material) {
    if (creatureBatches) {
      const part = new THREE.Object3D();
      part.position.copy(position);
      part.scale.copy(scale);
      part.material = material;
      part.userData.creature = this;
      part.userData.bucket = material === this.plateMat
        ? 'plateBox'
        : material === this.trimMat
          ? 'trimBox'
          : this.lightMats.includes(material)
            ? 'lightBox'
            : 'shellBox';
      const castsBodyShadow = material === this.shellMat || material === this.plateMat;
      part.castShadow = castsBodyShadow;
      this._instancedBoxes.push(part);
      if (castsBodyShadow) this.shadowBodyMeshes.push(part);
      return part;
    }
    const mesh = new THREE.Mesh(blockGeo, material);
    mesh.position.copy(position);
    mesh.scale.copy(scale);
    const castsBodyShadow = material === this.shellMat || material === this.plateMat;
    mesh.castShadow = castsBodyShadow;
    mesh.userData.creature = this;
    this.group.add(mesh);
    if (castsBodyShadow) this.shadowBodyMeshes.push(mesh);
    if (material === this.shellMat || material === this.plateMat || material === this.trimMat) {
      this._rigidBodyParts.push(mesh);
    }
    return mesh;
  }

  _mergeRigidBodyParts() {
    if (creatureBatches) return;
    if (!this._rigidBodyParts.length) return;
    const byMaterial = new Map();
    for (const mesh of this._rigidBodyParts) {
      if (this.blinkers.includes(mesh)) continue;
      let list = byMaterial.get(mesh.material);
      if (!list) { list = []; byMaterial.set(mesh.material, list); }
      list.push(mesh);
    }
    for (const [material, parts] of byMaterial) {
      if (parts.length < 2) continue;
      const positions = [];
      const normals = [];
      const uvs = [];
      for (const part of parts) {
        part.updateMatrix();
        const geo = part.geometry.toNonIndexed();
        geo.applyMatrix4(part.matrix);
        const p = geo.getAttribute('position');
        const n = geo.getAttribute('normal');
        const uv = geo.getAttribute('uv');
        for (let i = 0; i < p.count; i++) positions.push(p.getX(i), p.getY(i), p.getZ(i));
        for (let i = 0; i < n.count; i++) normals.push(n.getX(i), n.getY(i), n.getZ(i));
        for (let i = 0; i < uv.count; i++) uvs.push(uv.getX(i), uv.getY(i));
        geo.dispose();
      }
      const merged = new THREE.BufferGeometry();
      merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
      merged.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = material === this.shellMat || material === this.plateMat;
      mesh.userData.creature = this;
      this.group.add(mesh);
      for (const part of parts) {
        this.group.remove(part);
        if (!part.geometry.userData.shared) part.geometry.dispose();
      }
    }
    this.shadowBodyMeshes = this.group.children.filter(mesh =>
      mesh.isMesh && (mesh.material === this.shellMat || mesh.material === this.plateMat)
    );
  }

  _cap(nom, r) {
    if (creatureBatches && CREATURE_INSTANCING_MODE === 'parts') {
      const m = new THREE.Object3D();
      m.castShadow = false;
      m.userData.base = nom;
      m.userData.radius = r;
      m.userData.creature = this;
      m.userData.material = this.limbMat;
      return m;
    }
    const geometry = this.style.limb === 'capsule'
      ? capsuleGeometry(r, Math.max(0.01, nom - 2 * r), 4, 10)
      : boxGeometry(r * 1.7, nom, r * 1.7);
    const m = new THREE.Mesh(geometry, this.limbMat);
    m.castShadow = false;
    m.userData.base = nom;
    m.userData.creature = this;
    scene.add(m);
    return m;
  }

  _joint(r) {
    if (creatureBatches && CREATURE_INSTANCING_MODE === 'parts') {
      const m = new THREE.Object3D();
      m.castShadow = false;
      m.userData.radius = r;
      m.userData.creature = this;
      m.userData.material = this.jointMat;
      return m;
    }
    const m = new THREE.Mesh(sphereGeometry(r, 12, 10), this.jointMat);
    m.castShadow = false;
    m.userData.creature = this;
    scene.add(m);
    return m;
  }

  _makeDebugGroup() {
    const group = new THREE.Group();
    const poly = new THREE.LineLoop(new THREE.BufferGeometry(), debugPolyMat);
    const normal = new THREE.Line(new THREE.BufferGeometry(), debugNormalMat);
    const com = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 8), debugComMat);
    const scans = new THREE.LineSegments(new THREE.BufferGeometry(), debugScanMat);
    const zones = new THREE.LineSegments(new THREE.BufferGeometry(), debugZoneMat);
    const links = new THREE.LineSegments(new THREE.BufferGeometry(), debugLinkMat);
    const armReach = new THREE.LineSegments(new THREE.BufferGeometry(), debugArmReachMat);
    const armLinks = new THREE.LineSegments(new THREE.BufferGeometry(), debugArmLinkMat);
    const rest = [];
    const look = [];
    const target = [];
    const armTarget = [];
    for (const leg of this.legs) {
      const restMarker = new THREE.Mesh(pointGeo, debugRestMat);
      const lookMarker = new THREE.Mesh(pointGeo, debugLookMat);
      const targetMarker = new THREE.Mesh(pointGeo, debugTargetMat);
      restMarker.scale.setScalar(leg.side < 0 ? 1.05 : 0.9);
      lookMarker.scale.setScalar(0.82);
      targetMarker.scale.setScalar(1.25);
      rest.push(restMarker);
      look.push(lookMarker);
      target.push(targetMarker);
      group.add(restMarker, lookMarker, targetMarker);
    }
    for (const arm of this.arms) {
      const marker = new THREE.Mesh(pointGeo, debugArmStateMats.idle);
      marker.scale.setScalar(1.45);
      armTarget.push(marker);
      group.add(marker);
    }
    const punchLink = new THREE.Line(new THREE.BufferGeometry(), debugPunchLinkMat);
    const punchStrike = new THREE.Mesh(pointGeo, debugPunchStrikeMat);
    const punchContact = new THREE.Mesh(pointGeo, debugPunchContactMat);
    punchStrike.scale.setScalar(1.8);
    punchContact.scale.setScalar(1.3);
    punchStrike.visible = false;
    punchContact.visible = false;
    punchLink.visible = false;
    group.add(scans, zones, links, armReach, armLinks, poly, normal, com, punchLink, punchStrike, punchContact);
    group.visible = false;
    scene.add(group);
    return { group, poly, normal, com, scans, zones, links, armReach, armLinks, rest, look, target, armTarget, punchLink, punchStrike, punchContact };
  }

  updateStowedObject(object) {
    if (!object.stowLocal) return;
    const position = this.group.localToWorld(object.stowLocal.clone());
    object.position.copy(position);
    object.mesh.position.copy(position);
    object.mesh.quaternion.copy(this.group.quaternion);
    object.velocity.set(0, 0, 0);
  }

  updateStowedObjects() {
    for (const object of grabbables) {
      if (object.stowedBy === this) this.updateStowedObject(object);
    }
  }

  stowArmObject(arm) {
    if (!arm.holding) return;
    const object = arm.holding;
    object.heldBy = null;
    object.reservedBy = null;
    object.stowedBy = this;
    object.stowLocal = arm.carryLocal.clone();
    arm.holding = null;
    arm.focus = null;
    arm.acquireCooldown = 0.75;
    this.updateStowedObject(object);
    this.setArmState(arm, 'recover');
    arm.desiredTarget.copy(this.armRestTarget(arm));
    arm.aim.copy(arm.desiredTarget);
    arm.target.copy(arm.desiredTarget);
    arm.chain.reset(this.group.localToWorld(arm.attachmentLocal.clone()), this.group.quaternion);
  }

  dropStowedObjects(dropVelocity = null) {
    for (const object of grabbables) {
      if (object.stowedBy !== this) continue;
      this.updateStowedObject(object);
      object.stowedBy = null;
      object.stowLocal = null;
      if (dropVelocity) object.velocity.copy(dropVelocity);
    }
  }

  dispose() {
    this.dropStowedObjects();
    scene.remove(this.group);
    scene.remove(this.debugGroup.group);
    this.debugGroup.group.traverse(o => {
      if (o.geometry && o.geometry !== pointGeo) o.geometry.dispose();
    });
    this.group.traverse(o => {
      if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
      if (o.material && !Array.isArray(o.material) && !o.material.userData.shared) o.material.dispose();
    });
    const removeLoosePart = part => {
      scene.remove(part);
      if (part.geometry && !part.geometry.userData.shared) part.geometry.dispose();
      if (part.material && !Array.isArray(part.material)) part.material.dispose();
    };
    for (const leg of this.legs) {
      removeLoosePart(leg.foot);
      for (const mesh of leg.segments) removeLoosePart(mesh);
      for (const mesh of leg.joints) removeLoosePart(mesh);
    }
    for (const arm of this.arms) {
      resetArmState(arm);
      removeLoosePart(arm.hand);
      for (const mesh of arm.segments) removeLoosePart(mesh);
      for (const mesh of arm.joints) removeLoosePart(mesh);
    }
  }

  isGrounded(leg) {
    return !leg.stepping && leg.targetGrounded;
  }

  // Cached at construction (see constructor Phase 1 block): pure functions of
  // immutable leg/arm/bodyScale data, hoisted out of the separation/collision loops.
  collisionRadius() {
    return this._collisionRadius;
  }

  maxArmReach() {
    return this._maxArmReach;
  }

  // Tight radius used only between active combat opponents so they can close to
  // body-contact distance (where arms can actually reach) instead of being held
  // apart by the full padded collisionRadius().
  meleeRadius() {
    return this._meleeRadius;
  }

  isMeleeOpponent(other) {
    return currentBehavior === 'combat'
      && other !== this
      && this.teamId !== other.teamId
      && this.isCombatActive()
      && other.isCombatActive();
  }

  forageCloseDistance() {
    return Math.max(0.65, Math.min(1.65, this.maxArmReach() * 0.62 + this.collisionRadius() * 0.18));
  }

  forageStopDistance() {
    return Math.max(0.34, Math.min(0.82, this.maxArmReach() * 0.34 + 0.18));
  }

  isWeak() {
    return this.health <= WEAK_HEALTH;
  }

  // Injured creatures move slower: full speed at full health, down to ~45% near death.
  healthSpeedScale() {
    return 0.45 + 0.55 * clamp(this.health / MAX_HEALTH, 0, 1);
  }

  isFleeing() {
    return currentBehavior === 'combat' && this.isWeak() && !!this.combatTarget && this.isCombatActive();
  }

  needsHealing() {
    return this.isCombatActive() && this.health < MAX_HEALTH;
  }

  canEat() {
    return this.needsHealing() && !this.isFleeing() && this.attackState !== 'dying';
  }

  wantsHealingForage() {
    return this.canEat() && !this.isWeak();
  }

  stowedFood() {
    return grabbables.find(object => object.stowedBy === this) || null;
  }

  updateEating(dt) {
    this.eatCooldown = Math.max(0, this.eatCooldown - dt);
    this.healFlash = Math.max(0, this.healFlash - dt);
    if (!this.canEat() || this.eatCooldown > 0) return;
    const food = this.stowedFood();
    if (!food) return;
    removeGrabbable(food);
    this.health = Math.min(MAX_HEALTH, this.health + HEAL_AMOUNT);
    this.healFlash = 0.45;
    this.eatCooldown = EAT_COOLDOWN;
  }

  isCombatActive() {
    return this.health > 0;
  }

  attackRange() {
    return this.collisionRadius() + Math.max(0.75, this.maxArmReach() * 0.58) + 0.35;
  }

  bodyHalfExtents(pad = 0) {
    return new THREE.Vector3(
      this.plan.bodyScale.x * 0.86 + pad,
      this.plan.bodyScale.y * 0.46 + pad,
      this.plan.bodyScale.z * 0.76 + pad
    );
  }

  syncBodyTransform() {
    this.group.position.copy(this.pos);
    this.group.rotation.set(this.pitch, this.yaw, this.roll);
    this.group.updateMatrixWorld(true);
  }

  bodyContactPointFrom(attacker, pad = PUNCH_RADIUS * 0.45) {
    return this.bodyContactToward(attacker.pos, pad);
  }

  // Closest point on this body's surface to an arbitrary world point (e.g. a
  // specific shoulder) so each arm can aim at the spot it can actually reach,
  // not just the point nearest the attacker's center.
  bodyContactToward(fromWorld, pad = PUNCH_RADIUS * 0.45) {
    this.syncBodyTransform();
    const local = this.group.worldToLocal(fromWorld.clone());
    const ext = this.bodyHalfExtents(pad);
    local.x = clamp(local.x, -ext.x, ext.x);
    local.y = clamp(local.y, -ext.y * 0.35, ext.y);
    local.z = clamp(local.z, -ext.z, ext.z);

    const dx = ext.x - Math.abs(local.x);
    const dy = ext.y - Math.abs(local.y);
    const dz = ext.z - Math.abs(local.z);
    if (dx <= dy && dx <= dz) local.x = Math.sign(local.x || fromWorld.x - this.pos.x || 1) * ext.x;
    else if (dz <= dx && dz <= dy) local.z = Math.sign(local.z || fromWorld.z - this.pos.z || 1) * ext.z;
    else local.y = ext.y;
    return this.group.localToWorld(local);
  }

  localPointInBody(worldPoint, pad = 0) {
    this.syncBodyTransform();
    const local = this.group.worldToLocal(worldPoint.clone());
    const ext = this.bodyHalfExtents(pad);
    return Math.abs(local.x) <= ext.x && Math.abs(local.y) <= ext.y && Math.abs(local.z) <= ext.z;
  }

  sweptHandHitsBody(prevWorld, nextWorld, enemy, radius = PUNCH_RADIUS) {
    const steps = Math.max(3, Math.ceil(prevWorld.distanceTo(nextWorld) / Math.max(0.06, radius * 0.45)));
    const probe = new THREE.Vector3();
    for (let i = 0; i <= steps; i++) {
      probe.lerpVectors(prevWorld, nextWorld, i / steps);
      if (enemy.localPointInBody(probe, radius)) return true;
    }
    return false;
  }

  // Returns { arm, contact } for the best punching arm, where contact is the
  // surface point nearest that arm's own shoulder, or null if none can reach.
  choosePunchArm(target) {
    if (!this.arms.length || !target) return null;
    let best = null;
    let bestScore = Infinity;
    for (const arm of this.arms) {
      if (arm.holding || arm.state === 'carry') continue;
      const shoulder = this.group.localToWorld(arm.attachmentLocal.clone());
      const contact = target.bodyContactToward(shoulder);
      const reachSlack = Math.max(0.12, arm.grabRadius * 0.7);
      if (shoulder.distanceTo(contact) > arm.reach + reachSlack) continue;
      const localTarget = this.group.worldToLocal(contact.clone());
      const sidePenalty = localTarget.x * arm.side < 0 ? 0.55 : 0;
      const score = Math.abs(localTarget.x - arm.restLocal.x) + Math.abs(localTarget.z - arm.restLocal.z) * 0.35 + sidePenalty;
      if (score < bestScore) {
        bestScore = score;
        // Copy into a dedicated scratch: proxy targets reuse one Vector3 for every contact call,
        // so storing the raw reference would alias the last-iterated arm's contact. Consumed
        // synchronously by the sole caller before the next choosePunchArm.
        best = { arm, contact: _chooseContact.copy(contact) };
      }
    }
    return best;
  }

  beginDeath(attacker = null) {
    if (this.attackState === 'dying' || this.removeAfterDeath) return;
    this.health = 0;
    this.attackState = 'dying';
    this.attackTimer = 0;
    this.deathTimer = 0;
    this.attackApplied = true;
    this.combatTarget = null;
    this.punchArm = null;
    this.dropStowedObjects(this.vel.clone().add(new THREE.Vector3(0, 0.55, 0)));
    for (const arm of this.arms) resetArmState(arm, this.vel.clone().add(new THREE.Vector3(0, 0.35, 0)));
    if (attacker) {
      const dx = this.pos.x - attacker.pos.x;
      const dz = this.pos.z - attacker.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      this.vel.x += (dx / d) * 1.6;
      this.vel.z += (dz / d) * 1.6;
    }
  }

  updateDeath(dt) {
    if (this.attackState !== 'dying') return;
    this.deathTimer += dt;
    this.currentMaxSpeed = 0;
    this.vel.x *= Math.max(0, 1 - dt * 2.2);
    this.vel.z *= Math.max(0, 1 - dt * 2.2);
    if (this.deathTimer >= DEATH_FALL_TIME) {
      this.spawnDeathLoot();
      this.removeAfterDeath = true;
    }
  }

  spawnDeathLoot() {
    if (this.deathLootSpawned) return;
    this.deathLootSpawned = true;
    const p = this.pos.clone();
    p.y = terrainHeight(p.x, p.z) + OBJECT_RADIUS + 0.45;
    const object = new Grabbable(p, this.teamId % objectMaterials.length);
    object.velocity.set((Math.random() - 0.5) * 0.8, 1.0, (Math.random() - 0.5) * 0.8);
    grabbables.push(object);
    refreshObjectCount();
  }

  enemyTarget(list) {
    if (!this.isCombatActive()) return null;
    let best = null;
    let bestScore = Infinity;
    _nearbyScratch.length = 0;
    creatureGrid.nearby(this.pos.x, this.pos.z, _nearbyScratch);
    const candidates = _nearbyScratch.length > 0 ? _nearbyScratch : list;
    for (const other of candidates) {
      if (other === this || !other.isCombatActive() || other.teamId === this.teamId) continue;
      const d = Math.hypot(other.pos.x - this.pos.x, other.pos.z - this.pos.z);
      const weakBonus = other.isWeak() ? -0.9 : 0;
      const score = d + weakBonus;
      if (score < bestScore) {
        bestScore = score;
        best = other;
      }
    }
    return best;
  }

  // Wild-activity FSM (Phase 2): senses prey/kin/threat via the spatial grid, (re)picks an
  // activity on timer expiry or threat-interrupt, latches hunt/social targets, eases restPose.
  updateActivity(all, dt) {
    this.activityTimer -= dt;
    let preyBestScore = Infinity, preyCandidate = null, preyDist = Infinity;
    let kinDist = Infinity, kinCandidate = null;
    let threatDist = Infinity;
    _nearbyScratch.length = 0;
    creatureGrid.nearby(this.pos.x, this.pos.z, _nearbyScratch);
    for (const other of _nearbyScratch) {
      if (other === this) continue;
      const d = Math.hypot(other.pos.x - this.pos.x, other.pos.z - this.pos.z);
      if (d <= HUNT_SENSE && other.teamId !== this.teamId && other.isCombatActive()) {
        const score = d + (other.isWeak() ? -0.9 : 0); // prefer weaker prey when close (mirrors enemyTarget)
        if (score < preyBestScore) { preyBestScore = score; preyCandidate = other; preyDist = d; }
      }
      if (d <= SOCIAL_SENSE && other.teamId === this.teamId && d < kinDist) { kinDist = d; kinCandidate = other; }
      if (d <= THREAT_NEAR && other.role === ROLE_HOSTILE && d < threatDist) threatDist = d;
    }
    if (hasLivePlayer()) {
      const dp = Math.hypot(_playerPos.x - this.pos.x, _playerPos.z - this.pos.z);
      if (dp <= THREAT_NEAR && dp < threatDist) threatDist = dp;
    }

    const threatInterrupt = threatDist < THREAT_NEAR && (this.activity === ACT_SLEEP || this.activity === ACT_GRAZE);
    if (this.activityTimer <= 0 || threatInterrupt) {
      const ctx = { preyDist, kinDist, threatDist, hp01: this.health / MAX_HEALTH, restedness: 1 };
      const { activity, duration } = chooseActivity({ current: this.activity, ctx, weights: this.temperament, rand: Math.random });
      this.activity = activity;
      this.activityTimer = duration;
      this.huntTarget = activity === ACT_HUNT ? preyCandidate : null;
      this.socialTarget = activity === ACT_SOCIALIZE ? kinCandidate : null;
    }
    if (this.activity === ACT_HUNT && (!this.huntTarget || !this.huntTarget.isCombatActive())) {
      this.huntTarget = null;
      this.activityTimer = 0; // re-decide next frame
    }
    if (this.activity === ACT_SOCIALIZE && this.socialTarget && !this.socialTarget.isCombatActive()) {
      this.socialTarget = null;
      this.activityTimer = 0;
    }

    const poseAlpha = 1 - Math.pow(0.035, Math.max(0.001, dt));
    this.restPose += (activitySteer(this.activity).restPose - this.restPose) * poseAlpha;
    if (this.activity === ACT_SLEEP) this.health = Math.min(MAX_HEALTH, this.health + SLEEP_REGEN * dt);
    else if (this.activity === ACT_GRAZE) this.health = Math.min(MAX_HEALTH, this.health + GRAZE_REGEN * dt);
  }

  takeDamage(amount, attacker = null) {
    if (!this.isCombatActive()) return;
    this.health = Math.max(0, this.health - amount);
    this.hitFlash = 0.28;
    if (this.activity === ACT_SLEEP || this.activity === ACT_GRAZE) this.activityTimer = 0; // wake and re-decide
    if (attacker) {
      const dx = this.pos.x - attacker.pos.x;
      const dz = this.pos.z - attacker.pos.z;
      const d = Math.hypot(dx, dz) || 1;
      this.vel.x += (dx / d) * 1.25;
      this.vel.z += (dz / d) * 1.25;
      this.vel.y += 0.45;
    }
    if (this.health <= 0) {
      this.beginDeath(attacker);
    }
  }

  updateCombat(all, dt, active = false) {
    this.attackCooldown = Math.max(0, this.attackCooldown - dt);
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    this.updateDeath(dt);
    if (!active) {
      this.combatTarget = null;
      if (this.attackState !== 'down' && this.attackState !== 'dying') {
        this.attackState = 'ready';
        this.attackTimer = 0;
        this.attackApplied = false;
        this.punchArm = null;
      }
      return;
    }
    if (!this.isCombatActive()) {
      this.combatTarget = null;
      this.currentMaxSpeed = 0;
      return;
    }

    const target = this.role === ROLE_HOSTILE ? (hasLivePlayer() ? _playerProxy : null)
      : (this.activity === ACT_HUNT && this.huntTarget ? this.huntTarget : this.enemyTarget(all));
    this.combatTarget = target;
    if (this.wantsHealingForage() && (this.healingTarget || this.stowedFood())) {
      if (this.attackState !== 'ready') {
        this.attackState = 'ready';
        this.attackTimer = 0;
        this.attackApplied = false;
        this.punchArm = null;
      }
      return;
    }
    if (!target || this.isWeak()) {
      if (this.attackState !== 'ready') {
        this.attackState = 'ready';
        this.attackTimer = 0;
        this.attackApplied = false;
        this.punchArm = null;
      }
      return;
    }

    const distance = Math.hypot(target.pos.x - this.pos.x, target.pos.z - this.pos.z);
    if (this.attackState === 'ready') {
      if (this.attackCooldown <= 0 && distance <= this.attackRange()) {
        const punch = this.choosePunchArm(target);
        if (punch) {
          this.attackState = 'windup';
          this.attackTimer = 0;
          this.attackApplied = false;
          this.punchArm = punch.arm;
          this.punchTarget.copy(punch.contact);
          this.punchContact.copy(punch.contact);
        }
      }
    } else if (this.attackState === 'windup') {
      this.attackTimer += dt;
      const shoulder = this.group.localToWorld(this.punchArm.attachmentLocal.clone());
      this.punchTarget.copy(target.bodyContactToward(shoulder));
      this.punchContact.copy(this.punchTarget);
      if (this.attackTimer >= ATTACK_WINDUP) {
        this.attackState = 'recover';
        this.attackTimer = 0;
      }
    } else if (this.attackState === 'recover') {
      this.attackTimer += dt;
      if (this.attackTimer >= ATTACK_RECOVER) {
        this.attackState = 'ready';
        this.attackTimer = 0;
        this.attackCooldown = ATTACK_COOLDOWN;
        this.attackApplied = false;
        this.punchArm = null;
      }
    }
  }

  updateForageState(object, dt) {
    for (const [ignored, remaining] of [...this.forageIgnore.entries()]) {
      const next = remaining - dt;
      if (next <= 0 || ignored.stowedBy || ignored.heldBy) this.forageIgnore.delete(ignored);
      else this.forageIgnore.set(ignored, next);
    }

    let crouchTarget = 0;
    if (!object || object.stowedBy === this || object.heldBy?.owner === this) {
      this.forageTarget = null;
      this.forageCloseTime = 0;
    } else if (objectAvailableForCreature(object, this)) {
      if (this.forageTarget !== object) {
        this.forageTarget = object;
        this.forageCloseTime = 0;
      }

      const distance = Math.hypot(object.position.x - this.pos.x, object.position.z - this.pos.z);
      if (distance <= this.forageCloseDistance()) {
        this.forageCloseTime += dt;
        crouchTarget = 1;
        if (this.forageCloseTime >= FORAGE_ATTEMPT_TIMEOUT) {
          this.giveUpForageObject(object);
          crouchTarget = 0;
        }
      } else {
        this.forageCloseTime = Math.max(0, this.forageCloseTime - dt * 0.65);
      }
    } else if (this.forageTarget === object) {
      this.forageTarget = null;
      this.forageCloseTime = 0;
    }

    const crouchAlpha = 1 - Math.pow(0.035, Math.max(0.001, dt));
    this.forageCrouch += (crouchTarget - this.forageCrouch) * crouchAlpha;
  }

  giveUpForageObject(object) {
    this.forageIgnore.set(object, FORAGE_IGNORE_TIME);
    this.forageTarget = null;
    this.forageCloseTime = 0;
    for (const arm of this.arms) {
      if (arm.focus === object) {
        this.releaseArmFocus(arm);
        this.setArmState(arm, 'recover');
        arm.desiredTarget.copy(this.armRestTarget(arm));
        arm.aim.copy(arm.desiredTarget);
        arm.target.copy(arm.desiredTarget);
      }
    }
  }

  applyBodyTerrainClearance() {
    const sx = this.plan.bodyScale.x * 0.88;
    const sz = this.plan.bodyScale.z * 0.84;
    const bottom = -Math.max(0.16, this.plan.bodyScale.y * 0.52);
    _clearEuler.set(this.pitch, this.yaw, this.roll, 'YXZ');
    _clearQ.setFromEuler(_clearEuler);
    let lift = 0;
    const pts = [
      0, bottom, 0,
      -sx, bottom, -sz,  sx, bottom, -sz, -sx, bottom, sz,  sx, bottom, sz,
      -sx, bottom, 0,    sx, bottom, 0,   0, bottom, -sz,   0, bottom, sz
    ];
    for (let i = 0; i < pts.length; i += 3) {
      _clearV.set(pts[i], pts[i + 1], pts[i + 2]).applyQuaternion(_clearQ).add(this.pos);
      const floor = terrainHeight(_clearV.x, _clearV.z) + BODY_VOLUME_CLEAR;
      lift = Math.max(lift, floor - _clearV.y);
    }
    if (lift > 0) {
      this.pos.y += lift;
      if (this.vel.y < 0) this.vel.y *= -BOUNCE;
      return lift;
    }
    return 0;
  }

  computeSteering(all, gait, behavior, targetPoint, directionYaw, raceStart = null) {
    if (!this.isCombatActive()) {
      _wander.set(0, 0, 0);
    } else if (behavior === 'stay') {
      _wander.set(0, 0, 0);
    } else if (behavior === 'target') {
      _wander.set(targetPoint.x - this.pos.x, 0, targetPoint.z - this.pos.z);
      const stopDistance = all.length > 1 ? 1.7 : 0.6;
      if (_wander.length() <= stopDistance) _wander.set(0, 0, 0);
      else _wander.normalize();
    } else if (behavior === 'follow') {
      if (hasLivePlayer()) {
        const standoff = 2.2 + (this._followPhase / (Math.PI * 2)) * 0.8; // ~2.2-3.0m, per-creature
        followDesire(this.pos.x, this.pos.z, _playerPos.x, _playerPos.z, standoff, this._followPhase, _followOut);
        _wander.set(_followOut.dx, 0, _followOut.dz);
      } else {
        _wander.set(this.roamTarget.x - this.pos.x, 0, this.roamTarget.z - this.pos.z);
        if (_wander.length() < 0.8) {
          nextRoamTarget(this);
          _wander.set(this.roamTarget.x - this.pos.x, 0, this.roamTarget.z - this.pos.z);
        }
        if (_wander.lengthSq() > 1e-6) _wander.normalize();
      }
    } else if (behavior === 'hostile') {
      if (hasLivePlayer()) {
        // Stop close enough that an arm can actually reach (mirrors team-combat close distance),
        // not at the full attackRange() which the windup gate uses.
        const stopDist = Math.max(0.32, Math.min(this.attackRange() * 0.62, this.maxArmReach() * 0.72 + this.collisionRadius() * 0.22));
        hostileDesire(this.pos.x, this.pos.z, _playerPos.x, _playerPos.z, stopDist, this.isWeak(), _hostileOut);
        _wander.set(_hostileOut.dx, 0, _hostileOut.dz);
      } else {
        _wander.set(this.roamTarget.x - this.pos.x, 0, this.roamTarget.z - this.pos.z);
        if (_wander.length() < 0.8) {
          nextRoamTarget(this);
          _wander.set(this.roamTarget.x - this.pos.x, 0, this.roamTarget.z - this.pos.z);
        }
        if (_wander.lengthSq() > 1e-6) _wander.normalize();
      }
    } else if (behavior === 'forage') {
      if (targetPoint) {
        _wander.set(targetPoint.x - this.pos.x, 0, targetPoint.z - this.pos.z);
        const stopDistance = this.forageStopDistance();
        if (_wander.length() <= stopDistance) _wander.set(0, 0, 0);
        else _wander.normalize();
      } else {
        _wander.set(this.roamTarget.x - this.pos.x, 0, this.roamTarget.z - this.pos.z);
        if (_wander.length() < 0.8) {
          nextRoamTarget(this);
          _wander.set(this.roamTarget.x - this.pos.x, 0, this.roamTarget.z - this.pos.z);
        }
        if (_wander.lengthSq() > 1e-6) _wander.normalize();
      }
    } else if (behavior === 'combat') {
      const enemy = this.combatTarget || this.enemyTarget(all);
      if (enemy && this.isWeak()) {
        _wander.set(this.pos.x - enemy.pos.x, 0, this.pos.z - enemy.pos.z);
        if (_wander.lengthSq() > 1e-6) _wander.normalize();
      } else if (enemy) {
        _wander.set(enemy.pos.x - this.pos.x, 0, enemy.pos.z - this.pos.z);
        const stopDistance = Math.max(0.32, Math.min(this.attackRange() * 0.62, this.maxArmReach() * 0.72 + this.collisionRadius() * 0.22));
        if (_wander.length() <= stopDistance) _wander.set(0, 0, 0);
        else _wander.normalize();
      } else {
        _wander.set(0, 0, 0);
      }
    } else if (behavior === 'hunt') {
      const prey = this.huntTarget;
      if (prey && prey.isCombatActive()) {
        _wander.set(prey.pos.x - this.pos.x, 0, prey.pos.z - this.pos.z);
        const stopDistance = Math.max(0.32, Math.min(this.attackRange() * 0.62, this.maxArmReach() * 0.72 + this.collisionRadius() * 0.22));
        if (_wander.length() <= stopDistance) _wander.set(0, 0, 0);
        else _wander.normalize();
      } else {
        _wander.set(this.roamTarget.x - this.pos.x, 0, this.roamTarget.z - this.pos.z);
        if (_wander.length() < 0.8) {
          nextRoamTarget(this);
          _wander.set(this.roamTarget.x - this.pos.x, 0, this.roamTarget.z - this.pos.z);
        }
        if (_wander.lengthSq() > 1e-6) _wander.normalize();
      }
    } else if (behavior === 'race') {
      const start = raceStart || this.pos;
      const finish = targetPoint;
      const lx = finish.x - start.x;
      const lz = finish.z - start.z;
      const len = Math.hypot(lx, lz) || 1;
      const fx = lx / len, fz = lz / len;
      const px = this.pos.x - start.x;
      const pz = this.pos.z - start.z;
      const along = clamp(px * fx + pz * fz, 0, len);
      const laneX = start.x + fx * along;
      const laneZ = start.z + fz * along;
      const lateralX = laneX - this.pos.x;
      const lateralZ = laneZ - this.pos.z;
      const lateral = Math.hypot(lateralX, lateralZ);
      const finishRemaining = Math.hypot(finish.x - this.pos.x, finish.z - this.pos.z);
      if (finishRemaining < 0.8) {
        _wander.set(0, 0, 0);
      } else {
        _wander.set(fx, 0, fz);
        if (lateral > 0.05) _wander.add(_steer.set(lateralX, 0, lateralZ).multiplyScalar(1.4));
        _wander.normalize();
      }
    } else if (behavior === 'direction') {
      _wander.set(Math.sin(directionYaw), 0, Math.cos(directionYaw));
    } else {
      _wander.set(this.roamTarget.x - this.pos.x, 0, this.roamTarget.z - this.pos.z);
      if (_wander.length() < 0.8) {
        nextRoamTarget(this);
        _wander.set(this.roamTarget.x - this.pos.x, 0, this.roamTarget.z - this.pos.z);
      }
      if (_wander.lengthSq() > 1e-6) _wander.normalize();
    }

    _sep.set(0, 0, 0);
    _nearbyScratch.length = 0;
    creatureGrid.nearby(this.pos.x, this.pos.z, _nearbyScratch);
    for (const o of _nearbyScratch) {
      if (o === this) continue;
      _away.set(this.pos.x - o.pos.x, 0, this.pos.z - o.pos.z);
      const d = _away.length();
      const melee = this.isMeleeOpponent(o);
      const sepRadius = melee
        ? this.meleeRadius() + o.meleeRadius()
        : Math.max(SEP_RADIUS, this.collisionRadius() + o.collisionRadius() + 0.8);
      if (d > 0 && d < sepRadius) {
        _away.multiplyScalar(1 / d);
        _sep.addScaledVector(_away, (sepRadius - d) / sepRadius);
        const minGap = melee ? this.meleeRadius() + o.meleeRadius() : Math.max(MIN_GAP, this.collisionRadius() + o.collisionRadius());
        if (d < minGap) _sep.addScaledVector(_away, (minGap - d) * 2.0);
      }
    }

    // Steer around tree trunks the same way creatures steer around each other (same
    // falloff + close-range boost), folded into the separation term. The hard push-out
    // in physicsStep stays as a backstop so they never actually clip a trunk.
    if (nearbyTrunks) {
      const trunks = nearbyTrunks(this.pos.x, this.pos.z, _trunkScratch);
      for (const t of trunks) {
        _away.set(this.pos.x - t.x, 0, this.pos.z - t.z);
        const d = _away.length();
        const avoidR = this.collisionRadius() + t.r + TRUNK_AVOID_MARGIN;
        if (d > 0 && d < avoidR) {
          _away.multiplyScalar(1 / d);
          _sep.addScaledVector(_away, (avoidR - d) / avoidR);
          const minGap = this.collisionRadius() + t.r;
          if (d < minGap) _sep.addScaledVector(_away, (minGap - d) * 2.0);
        }
      }
    }

    const sepScale = behavior === 'race' ? 0.35 : (behavior === 'combat' || behavior === 'hunt') ? 0.7 : 1.0;
    _steer.copy(_wander).multiplyScalar(behavior === 'stay' ? 0 : WANDER_W).addScaledVector(_sep, SEP_W * sepScale);
    if (_steer.lengthSq() > 1e-6) this.desiredDir.copy(_steer).normalize();
    else this.desiredDir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));

    if (!this.isCombatActive()) this.currentMaxSpeed = 0;
    else {
      const fleeBoost = behavior === 'combat' && this.isWeak() ? 1.28 : 1;
      this.currentMaxSpeed = behavior === 'stay' ? 0 : gait.maxSpeed * fleeBoost * this.healthSpeedScale();
    }
  }

  legBy(row, side) {
    return this.legs.find(l => l.row === row && l.side === side) || null;
  }

  diagonalPartners(leg) {
    const rows = [...new Set(this.legs.map(l => l.row))].sort((a, b) => a - b);
    if (rows.length < 2) return [];
    const idx = rows.indexOf(leg.row);
    const candidates = [];
    const prev = rows[Math.max(0, idx - 1)];
    const next = rows[Math.min(rows.length - 1, idx + 1)];
    for (const row of new Set([prev, next])) {
      if (row !== leg.row) {
        const found = this.legBy(row, -leg.side);
        if (found) candidates.push(found);
      }
    }
    return candidates;
  }

  adjacentPartners(leg) {
    const partners = [];
    const sameRow = this.legBy(leg.row, -leg.side);
    if (sameRow) partners.push(sameRow);
    for (const other of this.legs) {
      if (other === leg) continue;
      if (other.side === leg.side && Math.abs(other.row - leg.row) === 1) partners.push(other);
    }
    return partners;
  }

  legDisplacement(leg) {
    return horizontalDistance(leg.end, leg.target);
  }

  canWalkLegMove(leg, gait) {
    if (!leg.wants || leg.stepping) return false;
    if (!leg.targetGrounded) return true;

    const adjacent = leg.adjacentPartnersCached;
    if (adjacent.some(l => l.targetGrounded && !this.isGrounded(l))) return false;
    if (adjacent.some(l => l.targetGrounded && l.timeSinceStopMove < gait.crossPairCooldown)) return false;

    const diagonals = leg.diagonalPartnersCached;
    if (diagonals.some(l => l.targetGrounded && l.timeSinceBeginMove < gait.samePairCooldown)) return false;

    const grounded = this.legs.some(l => this.isGrounded(l));
    const alreadyAtTarget = leg.end.distanceToSquared(leg.target) < 0.01;
    return grounded && !alreadyAtTarget;
  }

  canGallopLegMove(leg, gait) {
    if (!leg.wants || leg.stepping) return false;
    if (!leg.targetGrounded) return true;
    if (!this.legs.some(l => this.isGrounded(l))) return false;

    const rowMate = leg.rowMateCached;
    leg.primary = leg.phase === 0 || !rowMate || !rowMate.targetGrounded;
    if (!leg.primary) {
      return rowMate?.stepping && rowMate.timeSinceBeginMove >= gait.samePairCooldown;
    }

    const crossRows = leg.crossRowsCached;
    if (crossRows.some(l => l.targetGrounded && l.timeSinceBeginMove < gait.crossPairCooldown)) return false;
    return true;
  }

  scheduleSteps(gait) {
    for (const leg of this.legs) {
      leg.canMove = gait.rowPairSteps ? this.canGallopLegMove(leg, gait) : this.canWalkLegMove(leg, gait);
    }

    const moving = this.legs.filter(l => l.stepping);
    const maxConcurrent = Math.max(1, Math.floor(this.legs.length * gait.maxConcurrentFraction));
    if (moving.length >= maxConcurrent) return;

    const candidates = this.legs
      .filter(l => l.canMove)
      .sort((a, b) => this.legDisplacement(b) - this.legDisplacement(a));

    if (!candidates.length) return;

    if (gait.rowPairSteps) {
      const row = candidates[0].row;
      const rowLegs = candidates
        .filter(l => l.row === row)
        .sort((a, b) => Number(b.primary) - Number(a.primary) || this.legDisplacement(b) - this.legDisplacement(a))
        .slice(0, maxConcurrent - moving.length);
      for (const leg of rowLegs) this.startStep(leg, gait);
      return;
    }

    const activePhases = new Set(moving.map(l => l.phase));
    for (const leg of candidates) {
      if (this.legs.filter(l => l.stepping).length >= maxConcurrent) break;
      if (activePhases.has(leg.phase) && this.legs.length <= 4) continue;
      this.startStep(leg, gait);
      activePhases.add(leg.phase);
    }
  }

  startStep(leg, gait) {
    leg.stepping = true;
    leg.t = 0;
    leg.timeSinceBeginMove = 0;
    leg.stepStart.copy(leg.end);
    leg.stepEnd.copy(leg.target);
  }

  updateLegTarget(leg, gait, triggerH, fullScan = true) {
    rotateXZ(leg.restLocal, this.yaw, _rotated);
    const restX = this.pos.x + _rotated.x;
    const restZ = this.pos.z + _rotated.z;
    _legRestGround.set(restX, terrainHeight(restX, restZ) + FOOT_GROUND, restZ);
    leg.restX = _legRestGround.x;
    leg.restY = _legRestGround.y;
    leg.restZ = _legRestGround.z;

    if (this.vel.lengthSq() > 0.0001) {
      _legMoveDir.copy(this.vel).setY(0).normalize();
    } else {
      _legMoveDir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    }
    _legLookAhead.copy(_legRestGround).addScaledVector(_legMoveDir, triggerH * gait.lookAhead * 3.0);
    leg.lookAhead.copy(_legLookAhead);
    leg.scanStart.set(_legLookAhead.x, _legLookAhead.y + gait.scanHeight, _legLookAhead.z);
    leg.scanEnd.set(_legLookAhead.x, _legLookAhead.y - gait.scanDepth, _legLookAhead.z);

    if (!fullScan) {
      const y = terrainHeight(_legLookAhead.x, _legLookAhead.z) + FOOT_GROUND;
      leg.target.set(_legLookAhead.x, y, _legLookAhead.z);
      leg.groundPosition.copy(leg.target);
      leg.targetGrounded = true;
      return _legRestGround;
    }

    let bestScore = Infinity, bestX = 0, bestY = 0, bestZ = 0, hasBest = false;
    const sg = gait.scanGrid;
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const x = _legLookAhead.x + di * sg;
        const z = _legLookAhead.z + dj * sg;
        const y = terrainHeight(x, z) + FOOT_GROUND;
        if (y > leg.scanStart.y || y < leg.scanEnd.y) continue;

        const comfortH = Math.hypot(x - _legRestGround.x, z - _legRestGround.z);
        const comfortV = Math.abs(y - _legRestGround.y);
        if (comfortH > gait.comfort.h || comfortV > gait.comfort.v + 0.15) continue;

        const dlx = x - _legLookAhead.x, dly = y - _legLookAhead.y, dlz = z - _legLookAhead.z;
        let score = dlx * dlx + dly * dly + dlz * dlz;
        const ahead = (x - _legRestGround.x) * _legMoveDir.x + (z - _legRestGround.z) * _legMoveDir.z;
        if (ahead < 0) score += Math.abs(ahead) * gait.scanHeightBias;
        if (score < bestScore) { bestScore = score; bestX = x; bestY = y; bestZ = z; hasBest = true; }
      }
    }

    if (hasBest) {
      leg.target.set(bestX, bestY, bestZ);
      leg.groundPosition.set(bestX, bestY, bestZ);
      leg.targetGrounded = true;
    } else {
      leg.target.copy(_legLookAhead);
      leg.target.y = _legRestGround.y;
      leg.targetGrounded = false;
    }

    return _legRestGround;
  }

  physicsStep(h, gait, debug = false) {
    const activeMaxSpeed = this.currentMaxSpeed ?? gait.maxSpeed;
    const speedFraction = clamp(Math.hypot(this.vel.x, this.vel.z) / Math.max(0.001, gait.maxSpeed), 0, 1);
    const crouch = clamp((this.forageCrouch || 0) + (this.restPose || 0), 0, 1); // forage + FSM rest-pose settle
    const bodyHeight = this.plan.bodyHeight * lerp(gait.stationaryHeight, gait.movingHeight, speedFraction) * lerp(1, 0.54, crouch);
    const triggerH = lerp(gait.stationaryTrigger.h, gait.movingTrigger.h, speedFraction);
    const triggerV = lerp(gait.stationaryTrigger.v, gait.movingTrigger.v, speedFraction);

    const anyPinnedUncomfortable = this.legs.some(l => l.uncomfortable && !l.stepping);
    const steerDir = anyPinnedUncomfortable
      ? _fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw))
      : this.desiredDir;
    const desiredYaw = Math.atan2(steerDir.x, steerDir.z);
    let diff = Math.atan2(Math.sin(desiredYaw - this.yaw), Math.cos(desiredYaw - this.yaw));
    this.yaw += clamp(diff, -gait.turnSpeed * h, gait.turnSpeed * h);

    const fullFootScan = this.lodFullIk || this.lodDebugActive || this.forceFootTargetRefresh;
    for (const leg of this.legs) {
      leg.timeSinceBeginMove += h;
      leg.timeSinceStopMove += h;

      const restGround = this.updateLegTarget(leg, gait, triggerH, fullFootScan);
      if (fullFootScan) creatureStats.ikFull++;
      else creatureStats.ikCheap++;

      const dh = horizontalDistance(leg.end, leg.target);
      const dv = Math.abs(leg.end.y - leg.target.y);
      const comfortDh = horizontalDistance(leg.end, restGround);
      const comfortDv = Math.abs(leg.end.y - restGround.y);
      leg.uncomfortable = dh > gait.comfort.h || dv > gait.comfort.v;
      if (comfortDh > gait.comfort.h || comfortDv > gait.comfort.v) leg.uncomfortable = true;

      if (leg.stepping) {
        leg.t += h / gait.stepDuration;
        const tc = Math.min(leg.t, 1), e = easeInOut(tc);
        leg.end.lerpVectors(leg.stepStart, leg.stepEnd, e);
        leg.end.y += Math.sin(Math.PI * tc) * gait.stepLift;
        if (leg.t >= 1) {
          leg.stepping = false;
          leg.end.copy(leg.stepEnd);
          leg.timeSinceStopMove = 0;
          addContactPulse(leg.end);
        }
        leg.wants = false;
      } else {
        leg.wants = !leg.targetGrounded || dh > triggerH || dv > triggerV;
      }
    }
    this.forceFootTargetRefresh = false;

    this.scheduleSteps(gait);

    let cx = 0, cy = 0, cz = 0;
    for (const leg of this.legs) {
      cx += leg.end.x;
      cy += leg.end.y;
      cz += leg.end.z;
    }
    cx /= this.legs.length;
    cy /= this.legs.length;
    cz /= this.legs.length;
    _com.x = (cx + this.pos.x) * 0.5;
    _com.z = (cz + this.pos.z) * 0.5;
    const comY = (cy + this.pos.y) * 0.5 + 0.01;

    let groundedCount = 0, firstGroundedEnd = null, polyY = 0;
    for (const leg of this.legs) {
      if (!leg.stepping && leg.targetGrounded) {
        if (groundedCount === 0) firstGroundedEnd = leg.end;
        const pt = _groundedBuf[groundedCount];
        pt.x = leg.end.x; pt.y = leg.end.y; pt.z = leg.end.z;
        polyY += leg.end.y;
        groundedCount++;
      }
    }
    const fG = groundedCount / this.legs.length;
    let comInside = false, haveSupport = false; // COM vs support-polygon (stability metric)
    let nx = 0, ny = 1, nz = 0, haveNormal = groundedCount > 0;
    // Reuse the pooled hull buffer; empty unless groundedCount >= 2 fills it below.
    let poly = _hullOut; poly.length = 0;

    if (groundedCount === 1) {
      const g = firstGroundedEnd;
      nx = _com.x - g.x;
      ny = comY - g.y;
      nz = _com.z - g.z;
    } else if (groundedCount >= 2) {
      poly = convexHull(_groundedBuf, groundedCount, _hullOut);
      polyY /= groundedCount;
      haveSupport = poly.length >= 3;
      comInside = haveSupport && pointInPoly(_com.x, _com.z, poly);
      if (comInside) {
        nx = 0;
        ny = 1;
        nz = 0;
      } else {
        nearestOnPoly(_com.x, _com.z, poly, _near);
        nx = _com.x - _near.x;
        ny = comY - polyY;
        nz = _com.z - _near.z;
      }
    }

    if (haveNormal) {
      const L = Math.hypot(nx, ny, nz) || 1;
      nx /= L; ny /= L; nz /= L;
    }

    this.vel.y -= GRAV * h;
    if (haveNormal) {
      const preferredY = cy + bodyHeight;
      let mag = GRAV + KP * (preferredY - this.pos.y) - KD * this.vel.y;
      mag = clamp(mag, 0, GRAV * 4 * fG);
      let ax = nx * mag, ay = ny * mag, az = nz * mag;
      if (Math.hypot(ax, az) > ay) { ax = 0; ay = 0; az = 0; }
      this.vel.x += ax * h;
      this.vel.y += ay * h;
      this.vel.z += az * h;
    }

    const anyUncomfortable = this.legs.some(l => l.uncomfortable && !l.stepping);
    const speed = activeMaxSpeed
      * (0.35 + 0.65 * Math.max(0, Math.cos(diff)))
      * (anyUncomfortable ? gait.uncomfortableSpeedMultiplier : 1);
    const drive = 6.0 * fG;
    this.vel.x += (Math.sin(this.yaw) * speed - this.vel.x) * drive * h;
    this.vel.z += (Math.cos(this.yaw) * speed - this.vel.z) * drive * h;
    this.vel.x *= (1 - H_DRAG * h);
    this.vel.z *= (1 - H_DRAG * h);

    this.pos.addScaledVector(this.vel, h);

    // Lateral push-out of tree trunks (XZ only); trunks are solid for creatures too.
    if (resolveTrunks) {
      const tr = resolveTrunks(this.pos.x, this.pos.z, this.collisionRadius());
      if (tr && tr.pushed) { this.pos.x = tr.x; this.pos.z = tr.z; }
    }

    const floorY = terrainHeight(this.pos.x, this.pos.z) + BODY_MIN_CLEAR;
    if (this.pos.y < floorY) {
      this.pos.y = floorY;
      if (this.vel.y < 0) this.vel.y *= -BOUNCE;
    }
    this.applyBodyTerrainClearance();

    this.updateBodyOrientation(gait);

    // --- basic locomotion metrics (smoothed for a stable readout) ---
    const m = this.metrics;
    const spd = Math.hypot(this.vel.x, this.vel.z);
    const desired = activeMaxSpeed;
    const eff = desired > 0.02 ? clamp(spd / desired, 0, 2) : 0;
    const headErr = Math.abs(diff); // radians; steering error before this step's turn
    m.distance += Math.hypot(this.pos.x - this._prevPos.x, this.pos.z - this._prevPos.z);
    this._prevPos.set(this.pos.x, this.pos.y, this.pos.z);
    m.simTime += h;
    if (desired > 0.05 && spd < 0.12) m.stallTime += h; // wants to move but nearly still
    m.speed = spd;
    m.maxSpeed = desired;
    m.groundedFrac = fG;
    m.headingErr = headErr;
    m.uncomfortable = anyUncomfortable ? 1 : 0;
    const a = clamp(h / 0.5, 0, 1); // EMA, ~0.5s time constant
    m.speedAvg += (spd - m.speedAvg) * a;
    m.effAvg += (eff - m.effAvg) * a;
    m.headingErrAvg += (headErr - m.headingErrAvg) * a;
    m.groundedAvg += (fG - m.groundedAvg) * a;
    m.stallFrac = m.simTime > 0 ? m.stallTime / m.simTime : 0;

    // Stage 2: limb-drag (planted-foot overextension), scan-fail, stuck legs, balance, wobble.
    let nGround = 0, dragSum = 0, scanFail = 0, stuck = 0;
    for (const leg of this.legs) {
      if (!leg.targetGrounded) scanFail++;
      if (leg.wants && !leg.canMove) stuck++;
      if (!leg.stepping && leg.targetGrounded) {
        nGround++;
        dragSum += Math.hypot(leg.end.x - leg.restX, leg.end.z - leg.restZ);
      }
    }
    m.dragAvg += ((nGround ? dragSum / nGround : 0) - m.dragAvg) * a;
    m.scanFailPct += ((scanFail / this.legs.length) * 100 - m.scanFailPct) * a;
    m.stuckPct += ((stuck / this.legs.length) * 100 - m.stuckPct) * a;
    if (haveSupport) m.comOutsidePct += ((comInside ? 0 : 100) - m.comOutsidePct) * a;
    m.pitchMean += (this.pitch - m.pitchMean) * a;
    m.pitchVar += ((this.pitch - m.pitchMean) ** 2 - m.pitchVar) * a;
    m.rollMean += (this.roll - m.rollMean) * a;
    m.rollVar += ((this.roll - m.rollMean) ** 2 - m.rollVar) * a;
    m.wobbleDeg = Math.sqrt(m.pitchVar + m.rollVar) * 180 / Math.PI;

    if (debug) {
      let origin = null;
      if (groundedCount === 1 && firstGroundedEnd) {
        origin = new THREE.Vector3(firstGroundedEnd.x, firstGroundedEnd.y, firstGroundedEnd.z);
      } else if (groundedCount >= 2) {
        if (poly.length >= 3 && pointInPoly(_com.x, _com.z, poly)) {
          origin = new THREE.Vector3(_com.x, polyY, _com.z);
        } else {
          origin = new THREE.Vector3(_near.x, polyY, _near.z);
        }
      }
      this.debugData = {
        poly: poly.map(p => new THREE.Vector3(p.x, p.y + 0.05, p.z)),
        com: new THREE.Vector3(_com.x, comY, _com.z),
        origin,
        normal: new THREE.Vector3(nx, ny, nz),
        legs: this.legs.map(leg => ({
          rest: new THREE.Vector3(leg.restX, leg.restY + 0.06, leg.restZ),
          lookAhead: leg.lookAhead.clone().add(new THREE.Vector3(0, 0.08, 0)),
          target: leg.target.clone().add(new THREE.Vector3(0, 0.10, 0)),
          scanStart: leg.scanStart.clone(),
          scanEnd: leg.scanEnd.clone(),
          grounded: leg.targetGrounded,
          canMove: leg.canMove,
          wants: leg.wants,
          triggerH,
          comfortH: gait.comfort.h
        }))
      };
    } else {
      this.debugData = null;
    }
  }

  updateBodyOrientation(gait) {
    _frontAvg.set(0, 0, 0); _backAvg.set(0, 0, 0);
    _leftAvg.set(0, 0, 0);  _rightAvg.set(0, 0, 0);
    let nF = 0, nB = 0, nL = 0, nR = 0;
    for (const leg of this.legs) {
      const e = leg.end;
      if (leg.restLocal.z > 0) { _frontAvg.x += e.x; _frontAvg.y += e.y; _frontAvg.z += e.z; nF++; }
      else                      { _backAvg.x  += e.x; _backAvg.y  += e.y; _backAvg.z  += e.z; nB++; }
      if (leg.side < 0)         { _leftAvg.x  += e.x; _leftAvg.y  += e.y; _leftAvg.z  += e.z; nL++; }
      else                      { _rightAvg.x += e.x; _rightAvg.y += e.y; _rightAvg.z += e.z; nR++; }
    }
    if (!nF || !nB || !nL || !nR) return;
    if (nF > 1) _frontAvg.multiplyScalar(1 / nF);
    if (nB > 1) _backAvg.multiplyScalar(1 / nB);
    if (nL > 1) _leftAvg.multiplyScalar(1 / nL);
    if (nR > 1) _rightAvg.multiplyScalar(1 / nR);

    const fvY = _frontAvg.y - _backAvg.y;
    const fvH = Math.hypot(_frontAvg.x - _backAvg.x, _frontAvg.z - _backAvg.z) || 1e-3;
    const svY = _rightAvg.y - _leftAvg.y;
    const svH = Math.hypot(_rightAvg.x - _leftAvg.x, _rightAvg.z - _leftAvg.z) || 1e-3;

    const pitchT = -Math.atan2(fvY, fvH);
    const rollT = Math.atan2(svY, svH);

    this.preferredPitch += (pitchT - this.preferredPitch) * gait.preferredRotationLerp;
    this.preferredRoll += (rollT - this.preferredRoll) * gait.preferredRotationLerp;

    const pitchTarget = clamp(this.preferredPitch, -gait.preferredPitchLeeway, gait.preferredPitchLeeway);
    const rollTarget = clamp(this.preferredRoll, -Math.PI / 5, Math.PI / 5);
    this.pitch += (pitchTarget - this.pitch) * gait.rotationLerp;
    this.roll += (rollTarget - this.roll) * gait.rotationLerp;
  }

  setArmState(arm, state) {
    if (arm.state === state) return;
    arm.state = state;
    arm.stateTime = 0;
  }

  armRestTarget(arm) {
    // Returns the arm's pooled _restWorld buffer; every caller consumes it
    // immediately (.copy / lerpVectors source) or overwrites it before reading.
    const target = this.group.localToWorld(arm._restWorld.copy(arm.restLocal));
    target.y = Math.max(target.y, terrainHeight(target.x, target.z) + OBJECT_RADIUS * 0.55);
    return target;
  }

  chooseArmObject(arm, shoulderWorld) {
    const maxDistance = arm.reach + arm.interest;
    let best = null;
    let bestScore = Infinity;
    _nearbyScratch.length = 0;
    objectGrid.nearby(shoulderWorld.x, shoulderWorld.z, _nearbyScratch);
    const candidates = _nearbyScratch.length > 0 ? _nearbyScratch : grabbables;
    for (const object of candidates) {
      if (!objectAvailableForCreature(object, this)) continue;
      const distance = shoulderWorld.distanceTo(object.position);
      if (distance > maxDistance) continue;
      const local = this.group.worldToLocal(object.position.clone());
      let score = distance;
      if (local.x * arm.side < -0.05) score += 1.2;
      if (local.z < -this.plan.bodyScale.z * 0.35) score += 0.7;
      score += Math.abs(local.x - arm.restLocal.x) * 0.22;
      if (score < bestScore) {
        bestScore = score;
        best = object;
      }
    }
    return best;
  }

  releaseArmFocus(arm) {
    if (arm.focus && arm.focus.reservedBy === arm) arm.focus.reservedBy = null;
    arm.focus = null;
  }

  constrainArmTarget(arm, target) {
    target.y = Math.max(target.y, terrainHeight(target.x, target.z) + OBJECT_RADIUS * 0.48);
    const local = this.group.worldToLocal(arm._localScratch.copy(target));
    const bodyX = this.plan.bodyScale.x * 0.88;
    const bodyZ = this.plan.bodyScale.z * 0.78;
    const bodyTop = this.plan.bodyScale.y * 0.48;
    const bodyBottom = -this.plan.bodyScale.y * 0.54;
    if (Math.abs(local.x) < bodyX && Math.abs(local.z) < bodyZ && local.y > bodyBottom && local.y < bodyTop) {
      local.x = arm.side * bodyX;
      target.copy(this.group.localToWorld(local));
      target.y = Math.max(target.y, terrainHeight(target.x, target.z) + OBJECT_RADIUS * 0.48);
    }
    return target;
  }

  constrainArmPoint(arm, point) {
    point.y = Math.max(point.y, terrainHeight(point.x, point.z) + 0.08);
    const local = this.group.worldToLocal(arm._pointScratch.copy(point));
    const bodyX = this.plan.bodyScale.x * 0.92;
    const bodyZ = this.plan.bodyScale.z * 0.82;
    const bodyTop = this.plan.bodyScale.y * 0.54;
    const bodyBottom = -this.plan.bodyScale.y * 0.58;

    if (Math.abs(local.x) < bodyX && Math.abs(local.z) < bodyZ && local.y > bodyBottom && local.y < bodyTop) {
      const sidePush = arm.side * bodyX;
      const frontBackPush = Math.sign(local.z || arm.restLocal.z || 1) * bodyZ;
      if (Math.abs(bodyX - Math.abs(local.x)) < Math.abs(bodyZ - Math.abs(local.z))) {
        local.x = sidePush;
      } else {
        local.z = frontBackPush;
      }
      point.copy(this.group.localToWorld(local));
      point.y = Math.max(point.y, terrainHeight(point.x, point.z) + 0.08);
    }
    return point;
  }

  updateArmState(arm, shoulderWorld, dt) {
    arm.stateTime += dt;
    arm.acquireCooldown = Math.max(0, (arm.acquireCooldown || 0) - dt);

    if ((currentBehavior === 'combat' || this.role === ROLE_HOSTILE) && this.punchArm === arm && this.attackState !== 'ready') {
      this.releaseArmFocus(arm);
      // Drive the hand to near-full extension along the shoulder->contact line so
      // the arm straightens and the HAND leads the strike. Aiming straight at a
      // contact point closer than the arm is long makes IK fold the arm, so the
      // elbow reaches the enemy first.
      const dir = this.punchTarget.clone().sub(shoulderWorld);
      const dist = dir.length() || 1;
      dir.multiplyScalar(1 / dist);
      const strike = shoulderWorld.clone().addScaledVector(dir, Math.max(dist, arm.reach * 0.97));
      this.punchStrikePoint.copy(strike);
      const windupBack = this.armRestTarget(arm);
      if (this.attackState === 'windup') {
        const t = easeInOut(clamp(this.attackTimer / ATTACK_WINDUP, 0, 1));
        const backLocal = arm.restLocal.clone().add(new THREE.Vector3(-arm.side * this.plan.bodyScale.x * 0.28, 0.20, -this.plan.bodyScale.z * 0.18));
        windupBack.copy(this.group.localToWorld(backLocal));
        const windupT = t < 0.62 ? 0 : easeInOut((t - 0.62) / 0.38);
        arm.desiredTarget.lerpVectors(windupBack, strike, windupT);
      } else if (this.attackState === 'recover') {
        const t = easeInOut(clamp(this.attackTimer / ATTACK_RECOVER, 0, 1));
        arm.desiredTarget.lerpVectors(strike, this.armRestTarget(arm), t);
      } else {
        arm.desiredTarget.copy(this.armRestTarget(arm));
      }
      return this.constrainArmTarget(arm, arm.desiredTarget);
    }

    if (arm.holding && arm.state !== 'carry') this.setArmState(arm, 'carry');

    if (arm.state === 'recover') {
      this.releaseArmFocus(arm);
      arm.desiredTarget.copy(this.armRestTarget(arm));
      if (arm.stateTime > 0.42) this.setArmState(arm, 'idle');
    } else if (arm.state === 'idle') {
      arm.desiredTarget.copy(this.armRestTarget(arm));
      if (arm.stateTime > 0.12 && arm.acquireCooldown <= 0) {
        const object = this.chooseArmObject(arm, shoulderWorld);
        if (object) {
          arm.focus = object;
          object.reservedBy = arm;
          this.setArmState(arm, 'reach');
        }
      }
    } else if (arm.state === 'reach') {
      if (!arm.focus || arm.focus.heldBy || arm.focus.stowedBy || (arm.focus.reservedBy && arm.focus.reservedBy !== arm)) {
        this.releaseArmFocus(arm);
        this.setArmState(arm, 'idle');
        arm.desiredTarget.copy(this.armRestTarget(arm));
      } else if (shoulderWorld.distanceTo(arm.focus.position) > arm.reach + arm.interest + 0.2) {
        this.releaseArmFocus(arm);
        this.setArmState(arm, 'idle');
        arm.desiredTarget.copy(this.armRestTarget(arm));
      } else {
        arm.desiredTarget.copy(arm.focus.position);
        if (arm.hand.position.distanceTo(arm.focus.position) <= arm.grabRadius * 1.25 && arm.stateTime > 0.08) {
          this.setArmState(arm, 'grab');
        }
      }
    } else if (arm.state === 'grab') {
      if (!arm.focus || arm.focus.heldBy || arm.focus.stowedBy) {
        this.releaseArmFocus(arm);
        this.setArmState(arm, 'idle');
        arm.desiredTarget.copy(this.armRestTarget(arm));
      } else {
        arm.desiredTarget.copy(arm.focus.position);
        if (arm.hand.position.distanceTo(arm.focus.position) <= arm.grabRadius * 1.7 || arm.stateTime > 0.24) {
          arm.holding = arm.focus;
          arm.holding.heldBy = arm;
          arm.holding.reservedBy = null;
          arm.focus = null;
          this.setArmState(arm, 'carry');
        }
      }
    } else if (arm.state === 'carry') {
      if (!arm.holding) {
        this.setArmState(arm, 'idle');
        arm.desiredTarget.copy(this.armRestTarget(arm));
      } else {
        arm.desiredTarget.copy(this.group.localToWorld(arm._restWorld.copy(arm.carryLocal)));
      }
    } else {
      this.setArmState(arm, 'idle');
      arm.desiredTarget.copy(this.armRestTarget(arm));
    }

    return this.constrainArmTarget(arm, arm.desiredTarget);
  }

  shapeArmJoints(arm, points, shoulderWorld, handPoint, orientation) {
    if (points.length <= 2) return;
    _armAxis.subVectors(handPoint, shoulderWorld);
    const length = _armAxis.length();
    if (length < 1e-4) return;
    _armAxis.multiplyScalar(1 / length);
    _armPole.copy(arm.bendLocal).applyQuaternion(orientation);
    _armPole.addScaledVector(_armAxis, -_armPole.dot(_armAxis));
    if (_armPole.lengthSq() < 1e-5) _armPole.set(arm.side, -0.25, 0).applyQuaternion(orientation);
    _armPole.normalize();

    for (let i = 1; i < points.length - 1; i++) {
      const t = i / (points.length - 1);
      _armPreferred.lerpVectors(shoulderWorld, handPoint, t)
        .addScaledVector(_armPole, Math.sin(Math.PI * t) * arm.reach * arm.bendStrength);
      _armPreferred.y = Math.max(_armPreferred.y, terrainHeight(_armPreferred.x, _armPreferred.z) + 0.08);
      points[i].lerp(_armPreferred, 0.38);
    }
  }

  renderArms(orientation, dt = 1 / 60) {
    for (const arm of this.arms) {
      arm.prevHand.copy(arm.hand.position);
      const shoulderWorld = this.group.localToWorld(arm._shoulderWorld.copy(arm.attachmentLocal));
      const desired = this.updateArmState(arm, shoulderWorld, dt);
      if (arm.aim.lengthSq() < 1e-8) arm.aim.copy(desired);
      const snapState = arm.state === 'reach' || arm.state === 'grab'
        || ((currentBehavior === 'combat' || this.role === ROLE_HOSTILE) && this.punchArm === arm && this.attackState !== 'ready');
      if (snapState) {
        arm.aim.copy(desired);
      } else {
        const aimAlpha = 1 - Math.pow(0.035, Math.max(0.001, dt));
        arm.aim.lerp(desired, aimAlpha);
      }
      const target = arm.target.copy(arm.aim);
      const points = arm.chain.solve(shoulderWorld, target, orientation);
      this.shapeArmJoints(arm, points, shoulderWorld, points[points.length - 1], orientation);
      for (let i = 1; i < points.length; i++) this.constrainArmPoint(arm, points[i]);

      for (let i = 0; i < arm.segments.length; i++) {
        const endPoint = points[i + 1];
        placeSegment(arm.segments[i], points[i], endPoint);
        const joint = arm.joints[i];
        if (joint) joint.position.copy(endPoint);
      }

      const handPoint = points[points.length - 1];
      arm.hand.position.copy(handPoint);
      arm.hand.quaternion.copy(this.group.quaternion);

      if ((currentBehavior === 'combat' || this.role === ROLE_HOSTILE)
          && this.punchArm === arm
          && this.attackState === 'windup'
          && !this.attackApplied
          && this.combatTarget
          && this.combatTarget.isCombatActive()
          && this.sweptHandHitsBody(arm.prevHand, handPoint, this.combatTarget, PUNCH_RADIUS)) {
        this.combatTarget.takeDamage(ATTACK_DAMAGE, this);
        this.attackApplied = true;
        addContactPulse(handPoint);
      }

      if (arm.holding) {
        const carryTarget = this.group.localToWorld(arm._carryWorld.copy(arm.carryLocal));
        const carryDistance = handPoint.distanceTo(carryTarget);
        const closeEnough = carryDistance <= Math.max(0.34, arm.grabRadius * 2.2);
        const settledLongEnough = arm.state === 'carry' && arm.stateTime > 0.55;
        if (arm.state === 'carry' && arm.stateTime > 0.18 && (closeEnough || settledLongEnough)) {
          this.stowArmObject(arm);
          const recoverPoints = arm.chain.solve(shoulderWorld, arm.target, orientation);
          this.shapeArmJoints(arm, recoverPoints, shoulderWorld, recoverPoints[recoverPoints.length - 1], orientation);
          for (let i = 1; i < recoverPoints.length; i++) this.constrainArmPoint(arm, recoverPoints[i]);
          for (let i = 0; i < arm.segments.length; i++) {
            const endPoint = recoverPoints[i + 1];
            placeSegment(arm.segments[i], recoverPoints[i], endPoint);
            const joint = arm.joints[i];
            if (joint) joint.position.copy(endPoint);
          }
          arm.hand.position.copy(recoverPoints[recoverPoints.length - 1]);
        } else {
          arm.holding.position.copy(handPoint);
          arm.holding.mesh.position.copy(handPoint);
          arm.holding.mesh.quaternion.copy(this.group.quaternion);
        }
      }
    }
  }

  submitBodyInstances() {
    if (!creatureBatches) return;
    for (const part of this._instancedBoxes) {
      if (part.visible === false) continue;
      creatureBatches.addBox(part.userData.bucket, composeGroupLocalMatrix(this.group, part), materialColor(part.material), this);
    }
  }

  submitShadowProxy() {
    if (!creatureBatches || !this.lodCastsShadow) return;
    creatureBatches.addShadow(composeBodyShadowMatrix(this), this);
  }

  submitInstancedSegment(segment) {
    const radius = segment.userData.radius || 0.06;
    const length = Math.max(radius * 2.05, (segment.userData.base || 1) * Math.max(0.001, segment.scale.y || 1));
    _instScale.set(radius, length / 3, radius);
    creatureBatches.addLimb(composeWorldMatrix(segment.position, segment.quaternion, _instScale), materialColor(segment.userData.material), this);
  }

  submitInstancedJoint(joint) {
    const radius = joint.userData.radius || 0.06;
    _instScale.set(radius, radius, radius);
    _instQuat.identity();
    creatureBatches.addJoint(composeWorldMatrix(joint.position, _instQuat, _instScale), materialColor(joint.userData.material), this);
  }

  submitInstancedLocalJoint(joint) {
    const radius = joint.userData.radius || 0.06;
    joint.scale.set(radius, radius, radius);
    creatureBatches.addJoint(composeGroupLocalMatrix(this.group, joint), materialColor(joint.userData.material), this);
  }

  submitInstancedHandFoot(part) {
    const size = part.userData.size || _instScale.set(0.16, 0.10, 0.16);
    _instScale.copy(size);
    creatureBatches.addHandFoot(composeWorldMatrix(part.position, part.quaternion, _instScale), materialColor(part.userData.material), this);
  }

  submitLegInstances() {
    if (!creatureBatches || CREATURE_INSTANCING_MODE !== 'parts' || this.lodTier >= LOD_BODY_ONLY_TIER) return;
    for (const leg of this.legs) {
      if (leg.foot.visible === false) continue;
      this.submitInstancedLocalJoint(leg.hipBall);
      for (const segment of leg.segments) this.submitInstancedSegment(segment);
      for (const joint of leg.joints) if (joint) this.submitInstancedJoint(joint);
      this.submitInstancedHandFoot(leg.foot);
    }
  }

  submitArmInstances() {
    if (!creatureBatches || CREATURE_INSTANCING_MODE !== 'parts' || !this.lodArmsActive) return;
    for (const arm of this.arms) {
      if (arm.hand.visible === false) continue;
      this.submitInstancedLocalJoint(arm.shoulder);
      for (const segment of arm.segments) this.submitInstancedSegment(segment);
      for (const joint of arm.joints) if (joint) this.submitInstancedJoint(joint);
      this.submitInstancedHandFoot(arm.hand);
    }
  }

  render(showDebug, dt = 1 / 60, animateParts = true) {
    this.group.position.copy(this.pos);
    const deathT = this.attackState === 'dying' ? easeInOut(clamp(this.deathTimer / DEATH_FALL_TIME, 0, 1)) : 0;
    const fallSide = this.teamId % 2 === 0 ? 1 : -1;
    this.group.rotation.set(this.pitch + deathT * 0.18, this.yaw, this.roll + deathT * fallSide * Math.PI * 0.52);
    this.group.updateMatrixWorld(true);
    this.updateStowedObjects();
    const healthFrac = clamp(this.health / MAX_HEALTH, 0, 1);
    this.healthBar.scale.x = healthFrac;
    this.healthBar.position.x = this.healthBack.position.x - 0.39 * (1 - healthFrac);
    this.healthMat.color.setHex(this.healFlash > 0 ? 0x66ffd1 : healthFrac > 0.55 ? 0x7bd88f : healthFrac > 0.28 ? 0xffd166 : 0xff6b6b);
    this.healthBack.visible = this.health < MAX_HEALTH || currentBehavior === 'combat';
    this.healthBar.visible = this.healthBack.visible && this.health > 0;
    this.teamMarker.material = this.teamMat;
    this.hitMat.opacity = this.hitFlash > 0 ? Math.min(0.55, this.hitFlash * 2.2) : 0;
    this.hitFlashMesh.visible = this.hitMat.opacity > 0.01;
    const blink = Math.sin(performance.now() * 0.004 + this.blinkPhase) > 0.35;
    for (const mesh of this.blinkers) mesh.material = blink ? this.lightMats[1] : this.lightMats[0];

    _fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)).normalize();
    const orientation = this.group.quaternion;

    if (animateParts && this.lodTier < LOD_BODY_ONLY_TIER) {
      for (const leg of this.legs) {
        const hipWorld = this.group.localToWorld(leg._hipWorld.copy(leg.attachmentLocal));
        const points = leg.chain.solve(hipWorld, leg.end, orientation);

        for (let i = 0; i < leg.segments.length; i++) {
          const endPoint = i === leg.segments.length - 1 ? leg.end : points[i + 1];
          placeSegment(leg.segments[i], points[i], endPoint);
          const joint = leg.joints[i];
          if (joint) joint.position.copy(points[i + 1]);
        }

        leg.foot.position.copy(leg.end);
        // A planted, stationary foot's ground normal cannot change, so only recompute
        // the foot orientation (4 terrainHeight samples via terrainNormal) when the
        // foot moved or the creature turned since the last sample. (1.4)
        const dnx = leg.end.x - leg._normSampleX, dnz = leg.end.z - leg._normSampleZ;
        if (dnx * dnx + dnz * dnz > 1e-4 || Math.abs(this.yaw - leg._normYaw) > 0.01) {
          terrainNormal(leg.end.x, leg.end.z, _n);
          orientFromUpForward(_n, _fwd, _q);
          leg._footQuat.copy(_q);
          leg._normSampleX = leg.end.x;
          leg._normSampleZ = leg.end.z;
          leg._normYaw = this.yaw;
        }
        leg.foot.quaternion.copy(leg._footQuat);
      }
    }

    if (animateParts && this.lodArmsActive) this.renderArms(orientation, dt);
    this.submitBodyInstances();
    this.submitLegInstances();
    this.submitArmInstances();
    this.submitShadowProxy();

    this.renderDebug(showDebug);
  }

  renderDebug(showDebug) {
    const dbg = this.debugGroup;
    dbg.group.visible = showDebug && !!this.debugData;
    if (!dbg.group.visible) return;

    const poly = this.debugData.poly;
    if (poly.length >= 2) {
      dbg.poly.geometry.dispose();
      dbg.poly.geometry = new THREE.BufferGeometry().setFromPoints(poly);
      dbg.poly.visible = true;
    } else {
      dbg.poly.visible = false;
    }

    dbg.com.position.copy(this.debugData.com);

    const scanPoints = [];
    const zonePoints = [];
    const linkPoints = [];
    const armReachPoints = [];
    const armLinkPoints = [];
    for (let i = 0; i < this.debugData.legs.length; i++) {
      const leg = this.debugData.legs[i];
      const restMarker = dbg.rest[i];
      const lookMarker = dbg.look[i];
      const targetMarker = dbg.target[i];

      restMarker.position.copy(leg.rest);
      lookMarker.position.copy(leg.lookAhead);
      targetMarker.position.copy(leg.target);
      targetMarker.material = leg.grounded ? debugTargetMat : debugStrandedMat;
      targetMarker.scale.setScalar(leg.canMove ? 1.55 : leg.wants ? 1.25 : 0.95);

      scanPoints.push(leg.scanStart, leg.scanEnd);
      linkPoints.push(leg.rest, leg.lookAhead, leg.lookAhead, leg.target);
      addCircleSegments(zonePoints, leg.rest, leg.triggerH, 20);
      addCircleSegments(zonePoints, leg.rest, leg.comfortH, 28);
    }

    for (let i = 0; i < this.arms.length; i++) {
      const arm = this.arms[i];
      const marker = dbg.armTarget[i];
      if (!marker) continue;
      const shoulder = this.group.localToWorld(arm.attachmentLocal.clone());
      const target = arm.target.lengthSq() > 1e-8 ? arm.target.clone() : this.armRestTarget(arm);
      const ringCenter = new THREE.Vector3(shoulder.x, terrainHeight(shoulder.x, shoulder.z) + 0.11, shoulder.z);
      const grabCenter = new THREE.Vector3(arm.hand.position.x, terrainHeight(arm.hand.position.x, arm.hand.position.z) + 0.13, arm.hand.position.z);
      marker.visible = true;
      marker.position.copy(target);
      marker.material = debugArmStateMats[arm.state] || debugArmStateMats.idle;
      marker.scale.setScalar(arm.holding ? 1.85 : arm.focus ? 1.55 : 1.25);
      armLinkPoints.push(shoulder, target, arm.hand.position, target);
      addCircleSegments(armReachPoints, ringCenter, arm.reach + arm.interest, 36);
      addCircleSegments(armReachPoints, grabCenter, arm.grabRadius, 20);
      if (arm.focus) armLinkPoints.push(arm.hand.position, arm.focus.position);
      if (arm.holding) armLinkPoints.push(arm.hand.position, arm.holding.position);
    }
    for (let i = this.arms.length; i < dbg.armTarget.length; i++) dbg.armTarget[i].visible = false;

    // Punch debug: red = where the hand is driven (extended strike), green = the
    // body-surface contact point it is aiming through, red line = shoulder->strike.
    const punching = (currentBehavior === 'combat' || this.role === ROLE_HOSTILE) && this.punchArm && this.attackState !== 'ready';
    dbg.punchStrike.visible = punching;
    dbg.punchContact.visible = punching;
    dbg.punchLink.visible = punching;
    if (punching) {
      const shoulder = this.group.localToWorld(this.punchArm.attachmentLocal.clone());
      dbg.punchStrike.position.copy(this.punchStrikePoint);
      dbg.punchContact.position.copy(this.punchContact);
      updateLineGeometry(dbg.punchLink, [shoulder, this.punchStrikePoint]);
    }

    updateLineGeometry(dbg.scans, scanPoints);
    updateLineGeometry(dbg.zones, zonePoints);
    updateLineGeometry(dbg.links, linkPoints);
    updateLineGeometry(dbg.armReach, armReachPoints);
    updateLineGeometry(dbg.armLinks, armLinkPoints);

    if (this.debugData.origin) {
      const end = this.debugData.origin.clone().addScaledVector(this.debugData.normal, 0.9);
      updateLineGeometry(dbg.normal, [this.debugData.origin, end]);
    } else {
      dbg.normal.visible = false;
    }
  }
}

// ===================== scene state =====================
let creatures = [];
let currentPlanKey = 'hexbot';
let currentGaitKey = 'walk';
let currentBehavior = 'wander';
let sceneMode = 'uniform';
let loadedCreatureConfigs = null;
let selectedCreature = null;
let networkCreatureSnapshot = [];
let creatureEditScope = 'all';
let directionYaw = 0;

// Ambient wildlife spawner state (F4): ring-spawns/culls ROLE_WILD creatures around the player.
const _wildlife = { enabled: false, target: 8, ringMin: 40, ringMax: 70, cullRadius: 120, hardMax: 40, interval: 1.5, _timer: 0, _seq: 0 };

// Player-interaction state (foundation). Refreshed from getPlayerPose() at the top of update();
// all role/pet/hostile/wildlife code reads this snapshot, never getPlayerPose() on hot loops.
const _playerPos = new THREE.Vector3();
let _hasPlayer = false;
let _playerAlive = true;
let _playerYaw = 0;
let _playerRadius = 0.35;
let _playerHeight = 1.6;
function refreshPlayerSnapshot() {
  const pose = getPlayerPose ? getPlayerPose() : null;
  if (!pose) { _hasPlayer = false; return; }
  _playerPos.set(pose.x || 0, pose.y || 0, pose.z || 0);
  _playerYaw = pose.yaw || 0;
  _playerAlive = pose.alive !== false;
  _playerRadius = pose.radius || 0.35;
  _playerHeight = pose.height || 1.6;
  _hasPlayer = true;
}
function hasLivePlayer() { return _hasPlayer && _playerAlive; }

const _proxyContact = new THREE.Vector3(); // scratch for _playerProxy.bodyContactToward (no per-hit alloc)
const HOSTILE_PLAYER_DAMAGE = 7; // per-hit damage a ROLE_HOSTILE creature deals to the player
// Duck-types as a Creature combat target so hostile creatures reuse the existing punch/IK pipeline
// (choosePunchArm/updateCombat/sweptHandHitsBody) unchanged — they just see "an enemy".
const _playerProxy = {
  isPlayerProxy: true,
  pos: _playerPos, // shares the live snapshot Vector3, tracks the player automatically
  isCombatActive() { return hasLivePlayer(); },
  // Surface point on the player capsule toward `fromWorld` (mirrors Creature.bodyContactToward).
  bodyContactToward(fromWorld, pad = 0) {
    const dx = fromWorld.x - _playerPos.x, dz = fromWorld.z - _playerPos.z;
    const d = Math.hypot(dx, dz) || 1;
    const r = _playerRadius + pad * 0.5;
    const y = Math.max(_playerPos.y - _playerHeight * 0.5, Math.min(_playerPos.y + _playerHeight * 0.5, fromWorld.y));
    return _proxyContact.set(_playerPos.x + (dx / d) * r, y, _playerPos.z + (dz / d) * r);
  },
  // Whether a probe point is inside the player capsule (mirrors Creature.localPointInBody).
  localPointInBody(worldPoint, pad = 0) {
    return hasLivePlayer() && meleeHitsPlayer({ handX: worldPoint.x, handY: worldPoint.y, handZ: worldPoint.z, playerX: _playerPos.x, playerY: _playerPos.y, playerZ: _playerPos.z, playerRadius: _playerRadius, playerHeight: _playerHeight, margin: pad });
  },
  takeDamage(_amount, _attacker) { if (damagePlayer) damagePlayer(HOSTILE_PLAYER_DAMAGE, _playerProxy.pos); },
};

function setCreatureRole(creature, role) {
  if (!creature) return;
  creature.role = (role === ROLE_PET || role === ROLE_HOSTILE || role === ROLE_WILD) ? role : ROLE_WILD;
}
const simTarget = new THREE.Vector3(0, terrainHeight(0, 0) + 0.08, 0);

function teamSizeValue() {
  const input = document.getElementById('teamSize');
  const value = Math.max(1, Math.round(Number(input?.value) || 1));
  if (input) input.value = String(value);
  return value;
}

function teamIdForIndex(index) {
  return Math.floor(index / teamSizeValue());
}

function formatOption(value) {
  return Number(value).toFixed(value < 0.5 ? 2 : 1).replace(/\.0$/, '');
}

function numericControl(def, value, onValue) {
  const label = document.createElement('label');
  const head = document.createElement('span');
  head.className = 'control-head';
  const name = document.createElement('span');
  name.textContent = def.label;
  head.append(name);

  const wrap = document.createElement('span');
  wrap.className = 'numeric-control';
  const range = document.createElement('input');
  range.type = 'range';
  range.min = String(def.min);
  range.max = String(def.max);
  range.step = String(def.step);
  range.value = String(clamp(Number(value), def.min, def.max));

  const number = document.createElement('input');
  number.type = 'number';
  number.step = String(def.step);
  number.value = String(value);

  const apply = raw => {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    number.value = String(value);
    range.value = String(clamp(value, def.min, def.max));
    onValue(value);
  };

  range.addEventListener('input', () => apply(range.value));
  number.addEventListener('change', () => apply(number.value));
  number.addEventListener('keydown', e => {
    if (e.key === 'Enter') number.blur();
  });

  wrap.append(range, number);
  label.append(head, wrap);
  return label;
}

function renderCreatureScope() {
  const root = document.getElementById('creatureScope');
  if (!root) return;
  if (creatureEditScope === 'selected' && !selectedCreature) creatureEditScope = 'all';
  root.innerHTML = '';
  const buttons = document.createElement('div');
  buttons.className = 'scope-buttons';

  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.textContent = 'All';
  allBtn.classList.toggle('active', creatureEditScope === 'all');
  allBtn.addEventListener('click', () => {
    creatureEditScope = 'all';
    renderOptions();
    renderModelOptions();
    renderCreatureScope();
  });

  const selectedBtn = document.createElement('button');
  selectedBtn.type = 'button';
  selectedBtn.textContent = 'Selected';
  selectedBtn.disabled = !selectedCreature;
  selectedBtn.classList.toggle('active', creatureEditScope === 'selected');
  selectedBtn.addEventListener('click', () => {
    if (!selectedCreature) return;
    creatureEditScope = 'selected';
    ensureSelectedEditMode();
    renderOptions();
    renderModelOptions();
    renderCreatureScope();
  });

  const status = document.createElement('div');
  status.className = 'scope-status';
  const selectedIndex = selectedCreature ? creatures.indexOf(selectedCreature) + 1 : 0;
  status.textContent = creatureEditScope === 'selected'
    ? `Editing creature ${selectedIndex}`
    : (selectedCreature ? `Selected creature ${selectedIndex}; broad edits apply to all` : 'Broad edits apply to all creatures');

  buttons.append(allBtn, selectedBtn);
  root.append(buttons, status);
}

function selectedHint(text = 'Select a creature to edit it directly.') {
  const hint = document.createElement('div');
  hint.style.cssText = 'grid-column:1/-1;color:var(--pc-muted);padding:7px 0';
  hint.textContent = text;
  return hint;
}

function ensureSelectedEditMode() {
  if (!selectedCreature) return false;
  if (sceneMode !== 'varied') {
    // Uniform mode drives all creatures from currentGait() at update time, so
    // their per-creature gait snapshots can be stale. Preserve the visible
    // broad settings as the baseline before selected edits switch to varied.
    for (const creature of creatures) {
      creature.gait = cloneGait(currentGait());
    }
    sceneMode = 'varied';
    const sceneModeSelect = document.getElementById('sceneMode');
    if (sceneModeSelect) sceneModeSelect.value = sceneMode;
    updateLoadedCreatureConfigsFromScene();
  }
  return true;
}

function refreshSelectedInspector() {
  if (!selectedCreature) return;
  const title = document.getElementById('inspectorTitle');
  const summary = document.getElementById('inspectorSummary');
  const text = document.getElementById('selectedConfig');
  const index = creatures.indexOf(selectedCreature);
  const legCount = selectedCreature.legs.length;
  const segmentCount = selectedCreature.legs[0]?.segments.length ?? 0;
  if (title) title.textContent = `Creature ${index + 1}`;
  if (summary) {
    const tName = selectedCreature.temperamentName || 'balanced';
    const tHex = '#' + (TEMPERAMENT_COLORS[tName] ?? TEMPERAMENT_COLORS.balanced).toString(16).padStart(6, '0');
    const tSwatch = `<span style="display:inline-block;width:9px;height:9px;background:${tHex};border-radius:2px;margin:0 4px -1px 0"></span>`;
    summary.innerHTML = [
      `legs: ${legCount}`,
      `segments/leg: ${segmentCount}`,
      `team: ${selectedCreature.teamId + 1}`,
      `health: ${Math.round(selectedCreature.health)}/${MAX_HEALTH}`,
      `speed: ${formatOption(selectedCreature.gait.maxSpeed)}`,
      `mode: ${currentBehavior}`,
      `temperament: ${tSwatch}${tName}`,
      `activity: <span id="inspectorActivity">${selectedCreature.activity}</span>`,
      `style: ${selectedCreature.style.label || 'custom'}`
    ].join('<br>');
  }
  if (text) text.value = selectedConfigJson();
  selectionHelper.visible = true;
  selectionHelper.setFromObject(selectedCreature.group);
}

function renderOptions() {
  const panel = document.getElementById('options');
  panel.innerHTML = '';
  if (creatureEditScope === 'selected') {
    if (!selectedCreature) {
      panel.appendChild(selectedHint());
      return;
    }
    let target = selectedCreature;
    for (const def of OPTION_DEFS) {
      panel.appendChild(numericControl(def, valueAtPath(target.gait, def.path), value => {
        if (!ensureSelectedEditMode()) return;
        setAtPath(target.gait, def.path, value);
        if (def.path[0] === 'movingTrigger') target.gait.stationaryTrigger.h = Math.max(0.12, value * 0.42);
        if (def.path[0] === 'comfort') target.gait.comfort.v = Math.max(0.45, value * 0.72);
        target.config = creatureToConfig(target);
        updateLoadedCreatureConfigsFromScene();
        refreshSelectedInspector();
      }));
    }
    return;
  }
  const gait = currentGait();
  for (const def of OPTION_DEFS) {
    panel.appendChild(numericControl(def, valueAtPath(gait, def.path), value => {
      setAtPath(gait, def.path, value);
      if (def.path[0] === 'movingTrigger') gait.stationaryTrigger.h = Math.max(0.12, value * 0.42);
      if (def.path[0] === 'comfort') gait.comfort.v = Math.max(0.45, value * 0.72);
    }));
  }

  const perfHead = document.createElement('div');
  perfHead.style.cssText = 'grid-column:1/-1;margin-top:6px;color:var(--pc-muted);font-size:10px;text-transform:uppercase;letter-spacing:.04em';
  perfHead.textContent = 'Performance';
  panel.appendChild(perfHead);
  for (const def of PERF_DEFS) {
    panel.appendChild(numericControl(def, creaturePerf[def.key], value => {
      creaturePerf[def.key] = def.integer ? Math.max(1, Math.round(value)) : value;
      if (def.key === 'bodyOnlyDistance') creaturePerf.bodyOnlyDistance = Math.max(creaturePerf.detailDistance, creaturePerf.bodyOnlyDistance);
      if (def.key === 'hideDistance') creaturePerf.hideDistance = Math.max(creaturePerf.bodyOnlyDistance, creaturePerf.hideDistance);
      if (def.key === 'detailDistance') creaturePerf.detailDistance = Math.min(creaturePerf.detailDistance, creaturePerf.bodyOnlyDistance);
    }));
  }
}

function replaceEditedCreature(creature, config) {
  const index = creatures.indexOf(creature);
  if (index < 0) return creature;
  config.index = index;
  config.spawn = creature.pos.toArray();
  config.yaw = creature.yaw;
  config.health = creature.health;
  config.teamId = creature.teamId;
  const replacement = createCreatureFromConfig(config);
  replacement.vel.copy(creature.vel);
  creatures[index] = replacement;
  creature.dispose();
  selectedCreature = replacement;
  updateLoadedCreatureConfigsFromScene();
  refreshSelectedInspector();
  return replacement;
}

function selectedPlanValue(creature, key) {
  if (key === 'bodyScaleX') return creature.plan.bodyScale.x;
  if (key === 'bodyScaleY') return creature.plan.bodyScale.y;
  if (key === 'bodyScaleZ') return creature.plan.bodyScale.z;
  if (key === 'bodyHeight') return creature.plan.bodyHeight;
  return 0;
}

function setSelectedPlanValue(config, key, value) {
  const plan = deserializePlan(config.plan);
  if (key === 'bodyScaleX') plan.bodyScale.x = value;
  if (key === 'bodyScaleY') plan.bodyScale.y = value;
  if (key === 'bodyScaleZ') plan.bodyScale.z = value;
  if (key === 'bodyHeight') plan.bodyHeight = value;
  config.plan = serializePlan(finalizePlan(plan));
}

function renderModelOptions() {
  const panel = document.getElementById('modelOptions');
  panel.innerHTML = '';
  renderCreatureScope();

  if (creatureEditScope === 'selected') {
    if (!selectedCreature) {
      panel.appendChild(selectedHint());
      return;
    }
    ensureSelectedEditMode();
    let target = selectedCreature;

    const heading = document.createElement('div');
    heading.style.cssText = 'grid-column:1/-1;color:var(--pc-muted);font-size:10px;text-transform:uppercase;letter-spacing:.04em';
    heading.textContent = 'Selected body';
    panel.appendChild(heading);

    for (const def of SELECTED_BODY_DEFS) {
      panel.appendChild(numericControl(def, selectedPlanValue(target, def.key), value => {
        let config = creatureToConfig(target);
        setSelectedPlanValue(config, def.key, value);
        target = replaceEditedCreature(target, config);
      }));
    }

    const armPlanLabel = document.createElement('label');
    armPlanLabel.textContent = 'Arm Plan';
    const armPlanSelect = document.createElement('select');
    for (const [key, plan] of Object.entries(ARM_PLANS)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = plan.label;
      opt.selected = key === target.armSettings.plan;
      armPlanSelect.appendChild(opt);
    }
    armPlanSelect.addEventListener('change', () => {
      const config = creatureToConfig(target);
      config.arms.plan = armPlanSelect.value;
      target = replaceEditedCreature(target, config);
    });
    armPlanLabel.appendChild(armPlanSelect);
    panel.appendChild(armPlanLabel);

    for (const def of SELECTED_ARM_DEFS) {
      panel.appendChild(numericControl(def, target.armSettings[def.key], value => {
        const config = creatureToConfig(target);
        config.arms[def.key] = def.integer ? Math.max(0, Math.round(value)) : value;
        target = replaceEditedCreature(target, config);
      }));
    }
    return;
  }

  const styleLabel = document.createElement('label');
  styleLabel.textContent = 'Style';
  const styleSelect = document.createElement('select');
  for (const [key, style] of Object.entries(MODEL_STYLES)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = style.label;
    opt.selected = key === modelSettings.style;
    styleSelect.appendChild(opt);
  }
  styleSelect.addEventListener('change', () => {
    modelSettings.style = styleSelect.value;
    if (modelSettings.style !== 'custom') modelSettings.customStyle = null;
    loadedCreatureConfigs = null;
    resetCreatures();
  });
  styleLabel.appendChild(styleSelect);
  panel.appendChild(styleLabel);

  const armPlanLabel = document.createElement('label');
  armPlanLabel.textContent = 'Arm Plan';
  const armPlanSelect = document.createElement('select');
  for (const [key, plan] of Object.entries(ARM_PLANS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = plan.label;
    opt.selected = key === modelSettings.armPlan;
    armPlanSelect.appendChild(opt);
  }
  armPlanSelect.addEventListener('change', () => {
    modelSettings.armPlan = armPlanSelect.value;
    loadedCreatureConfigs = null;
    resetCreatures();
  });
  armPlanLabel.appendChild(armPlanSelect);
  panel.appendChild(armPlanLabel);

  panel.appendChild(numericControl(
    { label: 'Direction', min: -720, max: 720, step: 5 },
    Math.round(THREE.MathUtils.radToDeg(directionYaw)),
    value => { directionYaw = THREE.MathUtils.degToRad(value); }
  ));

  for (const def of MODEL_DEFS) {
    panel.appendChild(numericControl(def, modelSettings[def.key], value => {
      modelSettings[def.key] = value;
      loadedCreatureConfigs = null;
      resetCreatures();
    }));
  }

  for (const def of ARM_DEFS) {
    panel.appendChild(numericControl(def, modelSettings[def.key], value => {
      modelSettings[def.key] = def.key === 'armCount' ? Math.max(0, Math.round(value)) : value;
      loadedCreatureConfigs = null;
      resetCreatures();
    }));
  }

  for (const def of TERRAIN_DEFS) {
    panel.appendChild(numericControl(def, terrainSettings[def.key], value => {
      terrainSettings[def.key] = value;
      rebuildTerrain(true);
    }));
  }
}

function populateSelects() {
  const preset = document.getElementById('preset');
  const gait = document.getElementById('gait');
  for (const [key, plan] of Object.entries(BODY_PLANS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = plan.label;
    if (key === currentPlanKey) opt.selected = true;
    preset.appendChild(opt);
  }
  for (const [key, g] of Object.entries(GAITS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = g.label;
    if (key === currentGaitKey) opt.selected = true;
    gait.appendChild(opt);
  }
}

function resetCreatures() {
  selectCreature(null);
  for (const c of creatures) c.dispose();
  creatures = [];

  const countInput = document.getElementById('count');
  const count = Math.max(1, Math.round(Number(countInput.value) || 1));
  countInput.value = String(count);

  if (sceneMode === 'varied') {
    const configs = loadedCreatureConfigs && loadedCreatureConfigs.length === count
      ? loadedCreatureConfigs
      : Array.from({ length: count }, (_, i) => variedCreatureConfig(i, count));
    loadedCreatureConfigs = configs;
    for (const config of configs) creatures.push(createCreatureFromConfig(config));
    rebuildRaceVisuals();
    return;
  }

  loadedCreatureConfigs = null;
  for (let i = 0; i < count; i++) {
    creatures.push(createCreatureFromConfig(creatureConfigFromCurrent(i, count)));
  }
  rebuildRaceVisuals();
}

function exportSceneConfig({ forceCreatures = false } = {}) {
  if (currentBehavior === 'race') updateLoadedCreatureConfigsFromScene();
  return {
    preset: currentPlanKey,
    gait: currentGaitKey,
    behavior: currentBehavior,
    sceneMode,
    count: Number(document.getElementById('count').value),
    teamSize: teamSizeValue(),
    seed: Number(document.getElementById('seed').value),
    directionDeg: Math.round(THREE.MathUtils.radToDeg(directionYaw)),
    target: { x: simTarget.x, z: simTarget.z },
    model: { ...modelSettings },
    terrain: { ...terrainSettings },
    objects: objectsToConfig(),
    gaits: gaitSettings,
    generatedPlan: currentPlanKey === 'generated' ? serializePlan(BODY_PLANS.generated) : null,
    creatures: forceCreatures || sceneMode === 'varied' ? creatures.map(forceCreatures ? creatureToSharedConfig : creatureToConfig) : null
  };
}

function exportSharedNpcConfig() {
  const data = exportSceneConfig({ forceCreatures: true });
  data.sceneMode = 'varied';
  data.count = creatures.length;
  data.creatures = creatures.map(creatureToSharedConfig);
  // Drop live grabbable positions from the shared NPC config: they move every frame
  // (which would defeat the host's change-detection and make config resend every
  // tick), and the guest ignores them anyway — applySharedNpcConfig applies with
  // applyObjects:false. Grabbables are not part of shared NPC identity.
  delete data.objects;
  return data;
}

function exportConfig() {
  const text = document.getElementById('configText');
  text.value = JSON.stringify(exportSceneConfig(), null, 2);
  document.getElementById('configPanel').style.display = 'block';
}

function applySceneConfig(data, { applyTerrain = true, applyObjects = true, rebuild = true, forceVaried = false } = {}) {
  if (!data) return false;
  if (data.generatedPlan) installGeneratedPlan(deserializePlan(data.generatedPlan));
  if (data.preset && BODY_PLANS[data.preset]) currentPlanKey = data.preset;
  if (data.gait && gaitSettings[data.gait]) currentGaitKey = data.gait;
  if (data.behavior) currentBehavior = data.behavior;
  if (data.sceneMode) sceneMode = data.sceneMode;
  if (forceVaried) sceneMode = 'varied';
  if (data.directionDeg != null) directionYaw = THREE.MathUtils.degToRad(Number(data.directionDeg));
  if (data.target) simTarget.set(Number(data.target.x) || 0, simTarget.y, Number(data.target.z) || 0);
  if (data.model) Object.assign(modelSettings, data.model);
  if (modelSettings.spread != null) {
    modelSettings.restX = modelSettings.spread;
    modelSettings.restZ = modelSettings.spread;
    delete modelSettings.spread;
  }
  if (applyTerrain && data.terrain) Object.assign(terrainSettings, data.terrain);
  simTarget.y = terrainHeight(simTarget.x, simTarget.z) + 0.08;
  if (data.gaits) {
    for (const [key, value] of Object.entries(data.gaits)) {
      if (gaitSettings[key]) Object.assign(gaitSettings[key], cloneGait(value));
    }
  }
  if (data.count) document.getElementById('count').value = String(data.count);
  if (data.teamSize) document.getElementById('teamSize').value = String(Math.max(1, Math.round(Number(data.teamSize) || 1)));
  loadedCreatureConfigs = Array.isArray(data.creatures) ? data.creatures : null;
  if (data.seed != null) document.getElementById('seed').value = String(data.seed);
  document.getElementById('preset').value = currentPlanKey;
  document.getElementById('gait').value = currentGaitKey;
  document.getElementById('behavior').value = currentBehavior;
  document.getElementById('sceneMode').value = sceneMode;
  renderOptions();
  renderModelOptions();
  if (rebuild) rebuildTerrain(false);
  resetCreatures();
  if (applyObjects) {
    if (Array.isArray(data.objects)) spawnObjectsFromConfig(data.objects);
    else reheightFreeObjects();
  }
  return true;
}

function applySharedNpcConfig(data) {
  if (!data || !Array.isArray(data.creatures)) return false;
  return applySceneConfig(
    { ...data, sceneMode: 'varied', count: data.creatures.length },
    { applyTerrain: false, applyObjects: false, rebuild: false, forceVaried: true }
  );
}

function importConfig() {
  const text = document.getElementById('configText');
  document.getElementById('configPanel').style.display = 'block';
  if (!text.value.trim()) return;
  applySceneConfig(JSON.parse(text.value));
}

// Spread-aware uniform sampler. spread === 1 reproduces randRange(min, max)
// exactly (same value, same single rng draw); spread > 1 widens the range
// symmetrically around its midpoint so larger (and smaller) values appear.
function randRangeSpread(rng, min, max, spread = 1) {
  const mid = (min + max) / 2;
  const half = (max - min) / 2;
  return mid + (rng() * 2 - 1) * half * spread;
}

// Same, but clamped to [0,1] for HSL channels (no-op at spread === 1).
function spreadUnit(rng, min, max, spread = 1) {
  return clamp(randRangeSpread(rng, min, max, spread), 0, 1);
}

// Make sure modelSettings holds an editable custom style we can tweak per-part.
function ensureCustomStyle() {
  if (modelSettings.style !== 'custom' || !modelSettings.customStyle) {
    const base = currentStyle();
    modelSettings.style = 'custom';
    modelSettings.customStyle = { ...base, label: 'Random Look', limb: base.limb || 'box' };
  }
  return modelSettings.customStyle;
}

// ---- parameter registries -----------------------------------------------
// Every randomizable value is a "param" carrying its own editable min, max and
// spread. apply(rng, mult) samples randRangeSpread(min, max, spread * mult) and
// stores it via set(). Params with hasRange === false (Plan, colors) ignore
// min/max; hasSpread === false (Plan) ignore spread.
function numParam(letter, label, get, set, min, max, opts = {}) {
  return {
    letter, label, min, max, spread: 1, hasRange: true, hasSpread: true, get, set,
    sample(rng, mult = 1) {
      let v = randRangeSpread(rng, this.min, this.max, this.spread * mult);
      if (opts.int) v = Math.round(v);
      if (opts.floor != null) v = Math.max(opts.floor, v);
      return v;
    },
    apply(rng, mult = 1) {
      const v = this.sample(rng, mult);
      set(v);
      if (opts.derive) opts.derive(v);
    }
  };
}

function gaitParam(letter, label, path, min, max, opts = {}) {
  return numParam(letter, label,
    () => valueAtPath(currentGait(), path),
    v => setAtPath(currentGait(), path, v),
    min, max, opts);
}

function spreadParam(letter, label, fn) {
  return {
    letter, label, spread: 1, hasRange: false, hasSpread: true,
    apply(rng, mult = 1) { fn(rng, this.spread * mult); }
  };
}

const BODY_NUM = [
  { key: 'scale',         letter: 'S', label: 'Scale',    min: 0.72, max: 1.45 },
  { key: 'bodyWidth',     letter: 'W', label: 'Width',    min: 0.75, max: 1.35 },
  { key: 'bodyThickness', letter: 'T', label: 'Thick',    min: 0.72, max: 1.45 },
  { key: 'bodyDepth',     letter: 'D', label: 'Depth',    min: 0.78, max: 1.42 },
  { key: 'bodyHeight',    letter: 'R', label: 'Ride',     min: 0.78, max: 1.35 },
  { key: 'restX',         letter: 'X', label: 'Leg X',    min: 0.75, max: 1.55 },
  { key: 'restZ',         letter: 'Z', label: 'Leg Z',    min: 0.72, max: 1.55 },
  { key: 'hipX',          letter: 'I', label: 'Hip X',    min: 0.72, max: 1.35 },
  { key: 'hipY',          letter: 'Y', label: 'Hip Y',    min: 0.70, max: 1.35 },
  { key: 'segmentScale',  letter: 'E', label: 'Segments', min: 0.78, max: 1.45 }
];

const BODY_NUM_PARAMS = BODY_NUM.map(d => {
  const p = numParam(d.letter, d.label,
    () => modelSettings[d.key], v => { modelSettings[d.key] = v; }, d.min, d.max);
  p.key = d.key;
  return p;
});

// Structural integer counts (leg pairs, segments per leg). generateBodyPlan
// draws these from the editable min/max; set min === max to force an exact
// count (e.g. 3..3 = always 6 legs). Clicking the button regenerates the plan
// so the new count takes effect. hardMin/hardMax clamp the drawn value.
function countParam(letter, label, get, set, min, max, hardMin, hardMax) {
  return {
    letter, label, min, max, step: 1, hasRange: true, hasSpread: false, get, set,
    sampleCount(rng) {
      const v = Math.round(randRangeSpread(rng, this.min, this.max, 1));
      return clamp(v, hardMin, hardMax);
    },
    apply: rng => installGeneratedPlan(generateBodyPlan(rng))
  };
}

const LEG_PAIRS_PARAM = countParam('#', 'Leg Pairs',
  () => modelSettings.legPairs, v => { modelSettings.legPairs = v; }, 1, 5, 1, 8);
const SEGMENTS_PARAM = countParam('J', 'Joints',
  () => modelSettings.segmentCount, v => { modelSettings.segmentCount = v; }, 2, 5, 1, 6);

const BODY_PARAMS = [
  { letter: 'P', label: 'Plan', hasRange: false, hasSpread: false,
    apply: rng => installGeneratedPlan(generateBodyPlan(rng)) },
  LEG_PAIRS_PARAM,
  SEGMENTS_PARAM,
  ...BODY_NUM_PARAMS
];

const ARM_PLAN_PARAM = {
  letter: 'P', label: 'Plan', hasRange: false, hasSpread: false,
  apply: rng => { modelSettings.armPlan = randChoice(rng, Object.keys(ARM_PLANS)); }
};

const ARM_PARAMS = [
  ARM_PLAN_PARAM,
  numParam('#', 'Count', () => modelSettings.armCount, v => { modelSettings.armCount = v; }, 0, 6, { int: true, floor: 0 }),
  numParam('L', 'Length', () => modelSettings.armLength, v => { modelSettings.armLength = v; }, 0.55, 1.85, { floor: 0.05 }),
  numParam('G', 'Grab R', () => modelSettings.armGrabRadius, v => { modelSettings.armGrabRadius = v; }, 0.16, 0.52, { floor: 0.02 }),
  numParam('I', 'Interest', () => modelSettings.armInterest, v => { modelSettings.armInterest = v; }, 0.25, 1.55, { floor: 0 }),
  numParam('C', 'Carry H', () => modelSettings.armCarryHeight, v => { modelSettings.armCarryHeight = v; }, 0.18, 0.78),
  numParam('B', 'Bend', () => modelSettings.armBend, v => { modelSettings.armBend = v; }, 0.08, 0.46, { floor: 0 })
];

function armSettingsFromSeed(rng, spread = 1) {
  const sample = param => param.sample ? param.sample(rng, spread) : null;
  const countParam = ARM_PARAMS[1];
  const planKeys = countParam.max <= 0 ? ['none'] : Object.keys(ARM_PLANS).filter(key => key !== 'none');
  const count = countParam.max <= 0 ? 0 : Math.max(2, sample(countParam));
  return cloneArmSettings({
    plan: randChoice(rng, planKeys),
    count,
    length: sample(ARM_PARAMS[2]),
    grabRadius: sample(ARM_PARAMS[3]),
    interest: sample(ARM_PARAMS[4]),
    carryHeight: sample(ARM_PARAMS[5]),
    bend: sample(ARM_PARAMS[6])
  });
}

const GAIT_PARAMS = [
  gaitParam('V', 'Speed',     ['maxSpeed'], 0.55, 2.15),
  gaitParam('U', 'Turn',      ['turnSpeed'], 0.85, 2.6),
  gaitParam('h', 'St Hgt',    ['stationaryHeight'], 0.82, 1.18),
  gaitParam('H', 'Mv Hgt',    ['movingHeight'], 0.92, 1.58),
  gaitParam('T', 'Trig H',    ['movingTrigger', 'h'], 0.42, 1.35,
    { derive: v => { currentGait().stationaryTrigger.h = Math.max(0.16, v * 0.45); } }),
  gaitParam('Y', 'Trig V',    ['movingTrigger', 'v'], 0.28, 0.78,
    { derive: v => { currentGait().stationaryTrigger.v = v * 0.83; } }),
  gaitParam('C', 'Cmf H',     ['comfort', 'h'], 0.6, 2.4),
  gaitParam('c', 'Cmf V',     ['comfort', 'v'], 0.52, 1.25),
  gaitParam('D', 'Step Dur',  ['stepDuration'], 0.10, 0.28),
  gaitParam('L', 'Step Lift', ['stepLift'], 0.10, 0.58),
  gaitParam('A', 'Look Ahd',  ['lookAhead'], 0.12, 0.42),
  gaitParam('N', 'Scan D',    ['scanDepth'], 2.3, 5.8),
  gaitParam('n', 'Scan H',    ['scanHeight'], 1.1, 2.8),
  gaitParam('P', 'Concur',    ['maxConcurrentFraction'], 0.18, 0.5, { floor: 0.1 }),
  gaitParam('S', 'Same CD',   ['samePairCooldown'], 0.02, 0.22, { floor: 0 }),
  gaitParam('X', 'Cross CD',  ['crossPairCooldown'], 0.02, 0.24, { floor: 0 }),
  gaitParam('R', 'Rotate',    ['rotationLerp'], 0.07, 0.30, { floor: 0.02 }),
  gaitParam('r', 'Pref Rot',  ['preferredRotationLerp'], 0.08, 0.26, { floor: 0.02 })
];

const LOOK_PARAMS = [
  spreadParam('P', 'Palette', (rng, s) => applyRandomLook(rng, s)),
  spreadParam('M', 'Limb', rng => { ensureCustomStyle().limb = rng() > 0.35 ? 'box' : 'capsule'; }),
  spreadParam('G', 'Lights', (rng, s) => {
    const st = ensureCustomStyle();
    const a = rng();
    st.lightA = hslHex(a, spreadUnit(rng, 0.62, 0.95, s), spreadUnit(rng, 0.54, 0.72, s));
    st.lightB = hslHex(a + randRange(rng, 0.08, 0.24), spreadUnit(rng, 0.62, 0.95, s), spreadUnit(rng, 0.48, 0.68, s));
  }),
  spreadParam('C', 'Coat', (rng, s) => {
    const st = ensureCustomStyle();
    const h = rng();
    st.shell = hslHex(h, spreadUnit(rng, 0.20, 0.58, s), spreadUnit(rng, 0.34, 0.58, s));
    st.plate = hslHex(h + randRange(rng, -0.04, 0.04), spreadUnit(rng, 0.18, 0.52, s), spreadUnit(rng, 0.16, 0.32, s));
    st.trim = hslHex(h + randRange(rng, -0.08, 0.08), spreadUnit(rng, 0.10, 0.42, s), spreadUnit(rng, 0.58, 0.78, s));
  })
];

const TERRAIN_PARAMS = [
  numParam('A', 'Amp',   () => terrainSettings.amplitude, v => { terrainSettings.amplitude = v; }, 0.25, 2.25, { floor: 0 }),
  numParam('F', 'Freq',  () => terrainSettings.frequency, v => { terrainSettings.frequency = v; }, 0.55, 2.35, { floor: 0.1 }),
  numParam('R', 'Rough', () => terrainSettings.roughness, v => { terrainSettings.roughness = v; }, 0.25, 2.8, { floor: 0 }),
  numParam('D', 'Ridge', () => terrainSettings.ridge, v => { terrainSettings.ridge = v; }, -0.45, 0.95)
];

// Reuse the body Scale param object so its min/max/spread is a single shared
// state — editing it from the Body submenu or the Scale button is the same.
const SCALE_PARAMS = [BODY_NUM_PARAMS.find(p => p.key === 'scale')];

function runParams(params, rng, mult = 1) { for (const p of params) p.apply(rng, mult); }

function applyRandomLook(rng, spread = 1) {
  const h = rng();
  const accent = (h + randChoice(rng, [0.08, 0.16, 0.50, 0.62])) % 1;
  modelSettings.style = 'custom';
  modelSettings.customStyle = {
    label: 'Random Look',
    limb: rng() > 0.35 ? 'box' : 'capsule',
    shell: hslHex(h, spreadUnit(rng, 0.20, 0.58, spread), spreadUnit(rng, 0.34, 0.58, spread)),
    plate: hslHex(h + randRange(rng, -0.04, 0.04), spreadUnit(rng, 0.18, 0.52, spread), spreadUnit(rng, 0.16, 0.32, spread)),
    trim: hslHex(h + randRange(rng, -0.08, 0.08), spreadUnit(rng, 0.10, 0.42, spread), spreadUnit(rng, 0.58, 0.78, spread)),
    lightA: hslHex(accent, spreadUnit(rng, 0.62, 0.95, spread), spreadUnit(rng, 0.54, 0.72, spread)),
    lightB: hslHex(accent + randRange(rng, 0.08, 0.24), spreadUnit(rng, 0.62, 0.95, spread), spreadUnit(rng, 0.48, 0.68, spread))
  };
}

// Primary random buttons + their right-click param menus. `whole` (when set)
// runs a combined randomize for the primary button; otherwise every param runs.
// The submenu always exposes the individual params (editable min/max/spread).
const RANDOM_GROUPS = [
  { id: 'all', letter: 'A', label: 'Random all', salt: 101, base: 0, params: null,
    whole: (rng, s) => { runParams(BODY_PARAMS, rng, s); runParams(ARM_PARAMS, rng, s); runParams(GAIT_PARAMS, rng, s); applyRandomLook(rng, s); runParams(TERRAIN_PARAMS, rng, s); } },
  { id: 'body', letter: 'B', label: 'Random body', salt: 11, base: 1000, params: BODY_PARAMS },
  { id: 'arms', letter: 'H', label: 'Random arms', salt: 17, base: 1500, params: ARM_PARAMS },
  { id: 'gait', letter: 'G', label: 'Random gait', salt: 13, base: 2000, params: GAIT_PARAMS },
  { id: 'look', letter: 'L', label: 'Random look', salt: 19, base: 3000, params: LOOK_PARAMS,
    whole: (rng, s) => applyRandomLook(rng, s) },
  { id: 'terrain', letter: 'T', label: 'Random terrain', salt: 23, base: 4000, params: TERRAIN_PARAMS },
  { id: 'scale', letter: 'S', label: 'Random scale', salt: 29, base: 5000, params: SCALE_PARAMS }
];

function mutateNumber(value, rng, amount = 0.10) {
  return value * randRange(rng, 1 - amount, 1 + amount);
}

function mutateSelectedCreature(rng) {
  if (!selectedCreature || !ensureSelectedEditMode()) return false;
  let config = creatureToConfig(selectedCreature);
  const plan = deserializePlan(config.plan);
  plan.bodyHeight = mutateNumber(plan.bodyHeight, rng, 0.10);
  plan.bodyScale.x = mutateNumber(plan.bodyScale.x, rng, 0.10);
  plan.bodyScale.y = mutateNumber(plan.bodyScale.y, rng, 0.10);
  plan.bodyScale.z = mutateNumber(plan.bodyScale.z, rng, 0.10);
  config.plan = serializePlan(finalizePlan(plan));
  for (const key of ['length','grabRadius','interest','carryHeight','bend']) {
    config.arms[key] = Math.max(0, mutateNumber(config.arms[key], rng, 0.10));
  }
  if (rng() > 0.78) config.arms.count = Math.max(0, Math.round(mutateNumber(config.arms.count, rng, 0.25)));
  for (const def of OPTION_DEFS) {
    const current = valueAtPath(config.gait, def.path);
    setAtPath(config.gait, def.path, mutateNumber(current, rng, 0.10));
  }
  replaceEditedCreature(selectedCreature, config);
  renderOptions();
  renderModelOptions();
  renderCreatureScope();
  return true;
}

function mutateConfig() {
  const rng = seededRandom(advanceSeed(17) + 5000);
  if (creatureEditScope === 'selected' && mutateSelectedCreature(rng)) return;
  for (const key of ['scale','bodyWidth','bodyThickness','bodyDepth','bodyHeight','restX','restZ','hipX','hipY','segmentScale']) {
    modelSettings[key] = mutateNumber(modelSettings[key], rng, 0.10);
  }
  for (const key of ['armLength','armGrabRadius','armInterest','armCarryHeight','armBend']) {
    modelSettings[key] = Math.max(0, mutateNumber(modelSettings[key], rng, 0.10));
  }
  if (rng() > 0.78) modelSettings.armCount = Math.max(0, Math.round(mutateNumber(modelSettings.armCount, rng, 0.25)));
  for (const key of ['amplitude','frequency','roughness','ridge']) {
    terrainSettings[key] = mutateNumber(terrainSettings[key], rng, 0.12);
  }
  for (const def of OPTION_DEFS) {
    const current = valueAtPath(currentGait(), def.path);
    setAtPath(currentGait(), def.path, mutateNumber(current, rng, 0.10));
  }
  renderOptions();
  renderModelOptions();
  if (sceneMode === 'varied') {
    for (const creature of creatures) {
      creature.gait = cloneGait(currentGait());
      creature.config = creatureToConfig(creature);
    }
    updateLoadedCreatureConfigsFromScene();
    rebuildTerrain(false);
    reheightCreaturesForTerrain();
  } else {
    rebuildTerrain(true);
  }
}

// Re-sync UI + scene after any randomize. One path for both scene modes: drop
// the cached configs and rebuild from the current source of truth (uniform =
// current settings, varied = per-creature draws from the shared param ranges),
// so edited ranges always take effect. Terrain only adjusts existing creatures
// to the new ground since it is not a per-creature property.
function refreshAfterRandom(id) {
  renderOptions();
  renderModelOptions();
  if (id === 'terrain') {
    rebuildTerrain(false);
    reheightCreaturesForTerrain();
    return;
  }
  if (id === 'all') rebuildTerrain(false);
  loadedCreatureConfigs = null;
  resetCreatures();
}

function runRandomGroup(group, spread) {
  const rng = seededRandom(advanceSeed(group.salt) + group.base);
  if (creatureEditScope === 'selected' && selectedCreature && group.id !== 'terrain') {
    mutateSelectedCreature(rng);
    return;
  }
  if (group.whole) group.whole(rng, spread);
  else runParams(group.params, rng, spread);
  refreshAfterRandom(group.id);
}

function runRandomParam(group, param) {
  const rng = seededRandom(advanceSeed(group.salt) + group.base + 777);
  if (creatureEditScope === 'selected' && selectedCreature && group.id !== 'terrain') {
    mutateSelectedCreature(rng);
    return;
  }
  param.apply(rng, 1);
  refreshAfterRandom(group.id);
}

// Current spread multiplier for a random group (the number under its button).
function groupSpread(id) {
  const g = RANDOM_GROUPS.find(x => x.id === id);
  return (g && g.spread) || 1;
}

// Ring radius creatures spawn on, shared by uniform and varied builders.
function spawnRing(count) {
  return count <= 3 ? 7.0 : count <= 6 ? 9.5 : Math.min(20, 9.5 + count * 0.32);
}

function raceLane(index, count) {
  const size = Math.max(20, Math.abs(Number(terrainSettings.size) || 66));
  const startX = -size * 0.40;
  const finishX = size * 0.40;
  const span = size * 0.70;
  const z = count <= 1 ? 0 : lerp(-span * 0.5, span * 0.5, index / (count - 1));
  return {
    spawn: new THREE.Vector3(startX, 0, z),
    target: new THREE.Vector3(finishX, 0, z),
    yaw: Math.PI / 2,
    direction: Math.PI / 2
  };
}

function applyRaceLane(config, index, count) {
  const lane = raceLane(index, count);
  const plan = deserializePlan(config.plan);
  lane.spawn.y = terrainHeight(lane.spawn.x, lane.spawn.z) + plan.bodyHeight;
  lane.target.y = terrainHeight(lane.target.x, lane.target.z) + 0.08;
  config.spawn = lane.spawn.toArray();
  config.raceTarget = lane.target.toArray();
  config.yaw = lane.yaw;
  config.direction = lane.direction;
  return config;
}

function rebuildRaceVisuals() {
  while (raceVisualGroup.children.length) {
    const child = raceVisualGroup.children.pop();
    if (child.geometry && child.geometry !== raceMarkerGeo) child.geometry.dispose();
    raceVisualGroup.remove(child);
  }

  const linePoints = [];
  for (const creature of creatures) {
    const start = creature.config?.spawn ? new THREE.Vector3().fromArray(creature.config.spawn) : creature.pos.clone();
    const end = creature.config?.raceTarget ? new THREE.Vector3().fromArray(creature.config.raceTarget) : null;
    if (!end) continue;
    start.y = terrainHeight(start.x, start.z) + 0.07;
    end.y = terrainHeight(end.x, end.z) + 0.07;
    linePoints.push(start, end);

    const startMarker = new THREE.Mesh(raceMarkerGeo, raceStartMat);
    startMarker.position.copy(start);
    startMarker.rotation.x = -Math.PI / 2;
    raceVisualGroup.add(startMarker);

    const endMarker = new THREE.Mesh(raceMarkerGeo, raceEndMat);
    endMarker.position.copy(end);
    endMarker.rotation.x = -Math.PI / 2;
    raceVisualGroup.add(endMarker);
  }

  const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(linePoints), raceLineMat);
  lines.visible = linePoints.length >= 2;
  raceVisualGroup.add(lines);
}

function styleFromSeed(rng, spread = 1) {
  const previousStyle = modelSettings.style;
  const previousCustom = modelSettings.customStyle ? { ...modelSettings.customStyle } : null;
  applyRandomLook(rng, spread);
  const style = currentStyle();
  modelSettings.style = previousStyle;
  modelSettings.customStyle = previousCustom;
  return cloneStyle(style);
}

function variedCreatureConfig(index, count) {
  const rng = seededRandom(currentSeed(10000 + index * 97));
  const plan = generateBodyPlan(rng);
  const style = styleFromSeed(rng, groupSpread('look'));
  // Randomize this creature's gait from the editable GAIT_PARAMS (same ranges
  // the toolbar exposes), targeting a temporary gait via currentGait().
  const gait = cloneGait(currentGait());
  const oldKey = currentGaitKey;
  const tempKey = `__tmp_${index}`;
  gaitSettings[tempKey] = gait;
  currentGaitKey = tempKey;
  runParams(GAIT_PARAMS, rng);
  currentGaitKey = oldKey;
  delete gaitSettings[tempKey];

  // Body proportions drawn from the editable BODY_NUM_PARAMS ranges.
  const localModel = {};
  for (const p of BODY_NUM_PARAMS) localModel[p.key] = p.sample(rng);
  const edited = editPlanWithSettings(plan, localModel);
  const direction = randRange(rng, -Math.PI, Math.PI);
  const a = (index / count) * Math.PI * 2;
  const ring = spawnRing(count);
  const spawn = new THREE.Vector3(Math.cos(a) * ring, 0, Math.sin(a) * ring);
  spawn.y = terrainHeight(spawn.x, spawn.z) + edited.bodyHeight;

  const config = {
    index,
    spawn: spawn.toArray(),
    yaw: randRange(rng, -Math.PI, Math.PI),
    hue: randRange(rng, 0.20, 0.66),
    teamId: teamIdForIndex(index),
    health: MAX_HEALTH,
    plan: serializePlan(edited),
    style,
    gait,
    arms: armSettingsFromSeed(rng, groupSpread('arms')),
    behavior: null,
    direction,
    temperament: sampleTemperament(rng)
  };
  return currentBehavior === 'race' ? applyRaceLane(config, index, count) : config;
}

function creatureConfigFromCurrent(index, count) {
  const plan = editedPlan();
  const style = cloneStyle(currentStyle());
  const gait = cloneGait(currentGait());
  const a = (index / count) * Math.PI * 2;
  const ring = spawnRing(count);
  const spawn = new THREE.Vector3(Math.cos(a) * ring, terrainHeight(Math.cos(a) * ring, Math.sin(a) * ring) + plan.bodyHeight, Math.sin(a) * ring);
  const config = {
    index,
    spawn: spawn.toArray(),
    yaw: Math.random() * Math.PI * 2,
    hue: 0.30 + (index / Math.max(1, count - 1)) * 0.22,
    teamId: teamIdForIndex(index),
    health: MAX_HEALTH,
    plan: serializePlan(plan),
    style,
    gait,
    arms: cloneArmSettings(armSettingsFromModel()),
    behavior: null,
    direction: directionYaw
  };
  return currentBehavior === 'race' ? applyRaceLane(config, index, count) : config;
}

function createCreatureFromConfig(config) {
  const plan = deserializePlan(config.plan);
  const style = cloneStyle(config.style);
  const gait = cloneGait(config.gait);
  const spawn = new THREE.Vector3().fromArray(config.spawn);
  spawn.y = terrainHeight(spawn.x, spawn.z) + plan.bodyHeight;
  const arms = cloneArmSettings(config.arms || armSettingsFromModel());
  const index = Number.isFinite(Number(config.index)) ? Number(config.index) : 0;
  return new Creature(spawn, config.yaw, config.hue, plan, style, gait, null, {
    ...config,
    teamId: config.teamId ?? teamIdForIndex(index),
    health: config.health ?? MAX_HEALTH,
    arms,
    behavior: null
  });
}

function reheightCreaturesForTerrain() {
  for (const creature of creatures) {
    creature.pos.y = terrainHeight(creature.pos.x, creature.pos.z) + creature.plan.bodyHeight;
    for (const leg of creature.legs) {
      leg.end.y = terrainHeight(leg.end.x, leg.end.z) + FOOT_GROUND;
      leg.target.y = terrainHeight(leg.target.x, leg.target.z) + FOOT_GROUND;
    }
    creature.config = creatureToConfig(creature);
  }
  updateLoadedCreatureConfigsFromScene();
  rebuildRaceVisuals();
}

function layoutRaceCreatures() {
  for (let i = 0; i < creatures.length; i++) {
    const creature = creatures[i];
    const config = applyRaceLane(creatureToConfig(creature), i, creatures.length);
    const spawn = new THREE.Vector3().fromArray(config.spawn);
    creature.pos.copy(spawn);
    creature.vel.set(0, 0, 0);
    creature.yaw = config.yaw;
    creature.config = config;
    for (const leg of creature.legs) {
      rotateXZ(leg.restLocal, creature.yaw, _rotated);
      const wx = creature.pos.x + _rotated.x;
      const wz = creature.pos.z + _rotated.z;
      leg.end.set(wx, terrainHeight(wx, wz) + FOOT_GROUND, wz);
      leg.target.copy(leg.end);
      leg.groundPosition.copy(leg.end);
    }
  }
  updateLoadedCreatureConfigsFromScene();
  if (currentBehavior === 'race') rebuildRaceVisuals();
}

function resolveCreatureCollisions(list) {
  const _nb = _nearbyScratch;
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    _nb.length = 0;
    creatureGrid.nearby(a.pos.x, a.pos.z, _nb);
    for (const b of _nb) {
      if (b._gridIdx <= a._gridIdx) continue;
      const minDist = a.isMeleeOpponent(b)
        ? a.meleeRadius() + b.meleeRadius()
        : a.collisionRadius() + b.collisionRadius();
      let dx = b.pos.x - a.pos.x;
      let dz = b.pos.z - a.pos.z;
      let d = Math.hypot(dx, dz);
      if (d < 1e-5) {
        const angle = (a._gridIdx * 12.9898 + b._gridIdx * 78.233) % (Math.PI * 2);
        dx = Math.cos(angle);
        dz = Math.sin(angle);
        d = 1;
      }
      const overlap = minDist - d;
      if (overlap <= 0) continue;

      const nx = dx / d, nz = dz / d;
      const push = overlap * 0.5;
      a.pos.x -= nx * push;
      a.pos.z -= nz * push;
      b.pos.x += nx * push;
      b.pos.z += nz * push;
      // Only creatures actually shoved by a collision need the second body-terrain
      // clearance pass below; flag them so the rest skip it. (1.2)
      a._collisionMoved = true;
      b._collisionMoved = true;

      const rvx = b.vel.x - a.vel.x;
      const rvz = b.vel.z - a.vel.z;
      const inward = rvx * nx + rvz * nz;
      if (inward < 0) {
        const impulse = inward * 0.5;
        a.vel.x += nx * impulse;
        a.vel.z += nz * impulse;
        b.vel.x -= nx * impulse;
        b.vel.z -= nz * impulse;
      }
    }
  }
}

function removeDeadCreatures() {
  for (let i = creatures.length - 1; i >= 0; i--) {
    const creature = creatures[i];
    if (!creature.removeAfterDeath) continue;
    if (selectedCreature === creature) selectCreature(null);
    creatures.splice(i, 1);
    creature.dispose();
  }
  updateLoadedCreatureConfigsFromScene();
}

// Spawns one wild creature at (x,z) with a freshly randomized body/style; `_seq` keeps every
// wildlife spawn visually varied instead of repeating the roster's index-based look.
function spawnCreatureAt(x, z, opts = {}) {
  const config = variedCreatureConfig(_wildlife._seq++, Math.max(4, _wildlife.target));
  config.spawn = [x, 0, z];
  const c = createCreatureFromConfig(config);
  c.role = ROLE_WILD;
  c._wildlife = !!opts.wildlife;
  creatures.push(c);
  return c;
}

// Mirrors removeDeadCreatures' splice/dispose pattern for a single creature. Returns false if
// the creature is no longer in the roster (already despawned/removed elsewhere).
function despawnCreature(creature) {
  const idx = creatures.indexOf(creature);
  if (idx === -1) return false;
  if (selectedCreature === creature) selectCreature(null);
  creatures.splice(idx, 1);
  creature.dispose();
  return true;
}

function creatureToConfig(creature) {
  return {
    index: creatures.indexOf(creature),
    spawn: creature.pos.toArray(),
    yaw: creature.yaw,
    hue: creature.config?.hue ?? 0.38,
    teamId: creature.teamId,
    health: creature.health,
    plan: serializePlan(creature.plan),
    style: cloneStyle(creature.style),
    gait: cloneGait(creature.gait),
    arms: cloneArmSettings(creature.armSettings),
    direction: creature.config?.direction ?? directionYaw,
    temperament: creature.config?.temperament
  };
}

function creatureToSharedConfig(creature) {
  const base = creature.config || {};
  return {
    index: creatures.indexOf(creature),
    spawn: Array.isArray(base.spawn) ? base.spawn.slice() : creature.pos.toArray(),
    yaw: Number.isFinite(Number(base.yaw)) ? Number(base.yaw) : creature.yaw,
    hue: base.hue ?? 0.38,
    teamId: creature.teamId,
    health: Number.isFinite(Number(base.health)) ? Number(base.health) : MAX_HEALTH,
    plan: serializePlan(creature.plan),
    style: cloneStyle(creature.style),
    gait: cloneGait(creature.gait),
    arms: cloneArmSettings(creature.armSettings),
    direction: base.direction ?? directionYaw,
    temperament: base.temperament
  };
}

function selectedConfigJson() {
  return selectedCreature ? JSON.stringify(creatureToConfig(selectedCreature), null, 2) : '';
}

function updateLoadedCreatureConfigsFromScene() {
  if (sceneMode === 'varied') loadedCreatureConfigs = creatures.map(creatureToConfig);
}

function selectCreature(creature) {
  selectedCreature = creature;
  const inspector = document.getElementById('inspector');

  if (!creature) {
    inspector.style.display = 'none';
    selectionHelper.visible = false;
    renderCreatureScope();
    renderOptions();
    renderModelOptions();
    return;
  }

  inspector.style.display = 'block';
  refreshSelectedInspector();
  renderCreatureScope();
  renderOptions();
  renderModelOptions();
}

function cloneSelectedCreature() {
  if (!selectedCreature) return;
  let config = creatureToConfig(selectedCreature);
  const text = document.getElementById('selectedConfig').value.trim();
  if (text) {
    try { config = JSON.parse(text); }
    catch { config = creatureToConfig(selectedCreature); }
  }
  config.spawn[0] += 1.2;
  config.spawn[2] += 1.2;
  config.yaw += 0.35;
  config.hue = (config.hue + 0.04) % 1;
  const clone = createCreatureFromConfig(config);
  creatures.push(clone);
  document.getElementById('count').value = String(creatures.length);
  sceneMode = 'varied';
  document.getElementById('sceneMode').value = sceneMode;
  updateLoadedCreatureConfigsFromScene();
  selectCreature(clone);
}

function deleteSelectedCreature() {
  if (!selectedCreature) return;
  const index = creatures.indexOf(selectedCreature);
  if (index >= 0) creatures.splice(index, 1);
  selectedCreature.dispose();
  selectedCreature = null;
  document.getElementById('count').value = String(creatures.length);
  updateLoadedCreatureConfigsFromScene();
  selectCreature(null);
}

function saveSelectedCreature() {
  if (!selectedCreature) return;
  const json = selectedConfigJson();
  const configText = document.getElementById('configText');
  configText.value = json;
  document.getElementById('configPanel').style.display = 'block';
  localStorage.setItem('proceduralCreature.selectedConfig', json);
}

function setupPanel(panelId) {
  const panel = document.getElementById(panelId);
  const head = panel.querySelector('.panel-head');
  const min = panel.querySelector('.panel-min');
  const storeKey = `proceduralCreature.panel.${panelId}`;

  try {
    const saved = JSON.parse(localStorage.getItem(storeKey) || 'null');
    if (saved) {
      if (Number.isFinite(saved.left)) {
        panel.style.left = `${saved.left}px`;
        panel.style.right = 'auto';
      }
      if (Number.isFinite(saved.top)) {
        panel.style.top = `${saved.top}px`;
        panel.style.bottom = 'auto';
      }
      panel.classList.toggle('minimized', !!saved.minimized);
      if (min) min.textContent = saved.minimized ? '+' : '-';
      if (saved.display) panel.style.display = saved.display;
    }
  } catch {}

  function persist() {
    const rect = panel.getBoundingClientRect();
    localStorage.setItem(storeKey, JSON.stringify({
      left: rect.left,
      top: rect.top,
      minimized: panel.classList.contains('minimized'),
      display: panel.style.display || getComputedStyle(panel).display
    }));
  }

  let drag = null;
  head.addEventListener('pointerdown', e => {
    if (e.target === min) return;
    const rect = panel.getBoundingClientRect();
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.style.zIndex = String(10 + Date.now() % 1000);
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', e => {
    if (!drag) return;
    const x = clamp(e.clientX - drag.dx, 0, window.innerWidth - 40);
    const y = clamp(e.clientY - drag.dy, 0, window.innerHeight - 30);
    panel.style.left = `${x}px`;
    panel.style.top = `${y}px`;
  });
  head.addEventListener('pointerup', e => {
    if (!drag) return;
    drag = null;
    try { head.releasePointerCapture(e.pointerId); } catch {}
    persist();
  });
  min.addEventListener('click', () => {
    panel.classList.toggle('minimized');
    min.textContent = panel.classList.contains('minimized') ? '+' : '-';
    persist();
  });
}

// ===================== random buttons + sub-menus =====================
let openRandomMenu = null;
function closeRandomMenu() {
  if (openRandomMenu) { openRandomMenu.classList.remove('open'); openRandomMenu = null; }
}

// A compact numeric field for the menu (min / max / spread).
function numField(value, title, onChange, opts = {}) {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'rand-range';
  input.value = String(value);
  input.title = title;
  input.step = String(opts.step ?? 0.05);
  if (opts.min != null) input.min = String(opts.min);
  input.addEventListener('change', () => {
    const v = Number(input.value);
    if (Number.isFinite(v) && (opts.min == null || v > 0 || opts.allowNeg)) onChange(v);
    else input.value = String(value);
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
  input.addEventListener('pointerdown', e => e.stopPropagation());
  return input;
}

// The group-level spread multiplier shown under each primary button.
function makeRangeInput(initial, onChange) {
  return numField(initial, 'Spread multiplier (1 = default, higher = wider)',
    v => { if (v <= 0) return; onChange(v); }, { min: 0.25, step: 0.25 });
}

function buildRandomMenu(group) {
  const menu = document.createElement('div');
  menu.className = 'rand-menu';
  const head = document.createElement('div');
  head.className = 'rand-menu-head';
  head.textContent = 'tap = roll · min · max · spread';
  menu.appendChild(head);

  for (const param of group.params) {
    param.spread = param.spread ?? 1;
    const cell = document.createElement('div');
    cell.className = 'rand-param';

    const btn = document.createElement('button');
    btn.className = 'rand-pbtn';
    btn.textContent = param.letter;
    btn.title = `Randomize ${param.label}`;
    btn.addEventListener('click', e => { e.stopPropagation(); runRandomParam(group, param); });

    const meta = document.createElement('div');
    meta.className = 'rand-pmeta';
    const name = document.createElement('div');
    name.className = 'rand-label';
    name.textContent = param.label;
    const fields = document.createElement('div');
    fields.className = 'rand-fields';
    if (param.hasRange) {
      const fieldStep = param.step ?? 0.05;
      fields.appendChild(numField(param.min, `${param.label} min`, v => { param.min = v; }, { allowNeg: true, step: fieldStep }));
      fields.appendChild(numField(param.max, `${param.label} max`, v => { param.max = v; }, { allowNeg: true, step: fieldStep }));
    }
    if (param.hasSpread) {
      fields.appendChild(numField(param.spread, `${param.label} spread`, v => { if (v > 0) param.spread = v; }, { min: 0.25, step: 0.25 }));
    }
    meta.append(name, fields);
    cell.append(btn, meta);
    menu.appendChild(cell);
  }
  return menu;
}

function buildRandomButtons() {
  const row = document.getElementById('randomButtons');
  row.innerHTML = '';
  closeRandomMenu();
  for (const group of RANDOM_GROUPS) {
    group.spread = group.spread ?? 1;
    const stack = document.createElement('div');
    stack.className = 'rand-stack';
    const hasMenu = !!group.params;

    const btn = document.createElement('button');
    btn.textContent = group.letter;
    btn.title = group.label + (hasMenu ? ' — right-click to tune parts' : '');
    btn.addEventListener('click', () => runRandomGroup(group, group.spread));

    stack.append(btn, makeRangeInput(group.spread, v => { group.spread = v; }));

    if (hasMenu) {
      const menu = buildRandomMenu(group);
      stack.appendChild(menu);
      btn.addEventListener('contextmenu', e => {
        e.preventDefault();
        const wasOpen = menu.classList.contains('open');
        closeRandomMenu();
        if (!wasOpen) { menu.classList.add('open'); openRandomMenu = menu; }
      });
    }
    row.appendChild(stack);
  }
}

document.addEventListener('pointerdown', e => {
  if (openRandomMenu && !openRandomMenu.parentElement.contains(e.target)) closeRandomMenu();
});

populateSelects();
renderOptions();
renderModelOptions();
buildRandomButtons();
for (const id of ['optionsPanel', 'modelPanel', 'inspector', 'configPanel']) setupPanel(id);
document.getElementById('optionsToggle').checked = true;
document.getElementById('optionsPanel').style.display = 'block';
document.getElementById('modelPanel').style.display = 'block';
resetCreatures();
spawnRandomObjects();

document.getElementById('preset').addEventListener('change', e => {
  currentPlanKey = e.target.value;
  resetCreatures();
});
document.getElementById('gait').addEventListener('change', e => {
  currentGaitKey = e.target.value;
  renderOptions();
});
document.getElementById('behavior').addEventListener('change', e => {
  currentBehavior = e.target.value;
  if (currentBehavior === 'race') layoutRaceCreatures();
  else resetCreatures();
});
document.getElementById('sceneMode').addEventListener('change', e => {
  sceneMode = e.target.value;
  loadedCreatureConfigs = null;
  resetCreatures();
});
document.getElementById('count').addEventListener('change', resetCreatures);
document.getElementById('teamSize').addEventListener('change', () => {
  teamSizeValue();
  loadedCreatureConfigs = null;
  resetCreatures();
});
document.getElementById('objectCount').addEventListener('change', () => spawnRandomObjects());
document.getElementById('reset').addEventListener('click', resetCreatures);
document.getElementById('randomObjects').addEventListener('click', () => spawnRandomObjects());
document.getElementById('dropObjects').addEventListener('click', dropAllObjects);
document.getElementById('mutateConfig').addEventListener('click', mutateConfig);
document.getElementById('exportConfig').addEventListener('click', exportConfig);
document.getElementById('importConfig').addEventListener('click', () => {
  try { importConfig(); }
  catch (err) {
    document.getElementById('configPanel').style.display = 'block';
    document.getElementById('configText').value = `Invalid JSON: ${err.message}`;
  }
});
document.getElementById('cloneCreature').addEventListener('click', cloneSelectedCreature);
document.getElementById('deleteCreature').addEventListener('click', deleteSelectedCreature);
document.getElementById('saveCreature').addEventListener('click', saveSelectedCreature);
document.getElementById('closeInspector').addEventListener('click', () => selectCreature(null));
document.getElementById('optionsToggle').addEventListener('change', e => {
  document.getElementById('optionsPanel').style.display = e.target.checked ? 'block' : 'none';
  document.getElementById('modelPanel').style.display = e.target.checked ? 'block' : 'none';
});



  const FIXED = 1 / 60;
  let acc = 0;
  let frameIndex = 0;
  let _inspActivityTimer = 0;

  function updateCreatureLod() {
    if (camera) camera.getWorldPosition(_cameraPos);
    const detailSq = creaturePerf.detailDistance * creaturePerf.detailDistance;
    const bodyOnlySq = Math.max(creaturePerf.detailDistance, creaturePerf.bodyOnlyDistance) ** 2;
    const hideSq = Math.max(creaturePerf.bodyOnlyDistance, creaturePerf.hideDistance) ** 2;
    const ikSq = creaturePerf.ikDistance * creaturePerf.ikDistance;
    const shadowSq = creaturePerf.shadowDistance * creaturePerf.shadowDistance;
    creatureStats.count = creatures.length;
    creatureStats.visible = 0;
    creatureStats.sim = 0;
    creatureStats.rendered = 0;
    creatureStats.tiers.fill(0);
    creatureStats.bodyOnly = 0;
    creatureStats.armsActive = 0;
    creatureStats.shadowCasters = 0;
    creatureStats.ikFull = 0;
    creatureStats.ikCheap = 0;
    creatureStats.instancingMode = CREATURE_INSTANCING_MODE;
    creatureStats.instancedBoxes = 0;
    creatureStats.instancedLimbs = 0;
    creatureStats.instancedJoints = 0;
    creatureStats.instancedHandsFeet = 0;
    creatureStats.instancedShadows = 0;
    creatureStats.perfDetailDistance = creaturePerf.detailDistance;
    creatureStats.perfBodyOnlyDistance = creaturePerf.bodyOnlyDistance;
    creatureStats.perfHideDistance = creaturePerf.hideDistance;
    creatureStats.perfFullUpdateStride = creaturePerf.fullUpdateStride;
    creatureStats.perfBodyUpdateStride = creaturePerf.bodyUpdateStride;
    creatureStats.perfFarUpdateStride = creaturePerf.farUpdateStride;
    creatureStats.perfIkDistance = creaturePerf.ikDistance;
    creatureStats.perfShadowDistance = creaturePerf.shadowDistance;
    for (const c of creatures) {
      const d2 = camera ? c.pos.distanceToSquared(_cameraPos) : 0;
      const oldTier = c.lodTier;
      if (d2 > hideSq) {
        c.lodTier = 3;
        c.lodStride = creaturePerf.farUpdateStride;
        c.lodArmsActive = false;
        c.lodVisible = false;
      } else if (d2 > bodyOnlySq) {
        c.lodTier = 2;
        c.lodStride = creaturePerf.farUpdateStride;
        c.lodArmsActive = false;
        c.lodVisible = true;
      } else if (d2 > detailSq) {
        c.lodTier = 1;
        c.lodStride = creaturePerf.bodyUpdateStride;
        c.lodArmsActive = false;
        c.lodVisible = true;
      } else {
        c.lodTier = 0;
        c.lodStride = creaturePerf.fullUpdateStride;
        c.lodArmsActive = d2 <= ikSq;
        c.lodVisible = true;
      }
      c.lodFullIk = c.lodVisible && c.lodTier === 0 && d2 <= ikSq;
      if (oldTier !== 0 && c.lodTier === 0) c.forceFootTargetRefresh = true;
      c.lodShouldSim = c.lodVisible && ((frameIndex + c.lodFrameOffset) % c.lodStride === 0);
      creatureStats.tiers[c.lodTier]++;
      if (c.lodVisible) creatureStats.visible++;
      if (c.lodShouldSim) creatureStats.sim++;
      if (c.lodVisible && c.lodTier >= LOD_BODY_ONLY_TIER) creatureStats.bodyOnly++;
      if (c.lodArmsActive) creatureStats.armsActive++;
      c.group.visible = c.lodVisible;
      const castsShadow = c.lodVisible && d2 <= shadowSq;
      c.lodCastsShadow = castsShadow;
      if (castsShadow) creatureStats.shadowCasters += creatureBatches ? 1 : c.shadowBodyMeshes.length;
      for (const mesh of c.shadowBodyMeshes) mesh.castShadow = creatureBatches ? false : castsShadow;
      const showLegs = c.lodVisible && c.lodTier < LOD_BODY_ONLY_TIER;
      for (const leg of c.legs) {
        leg.foot.visible = showLegs;
        leg.foot.castShadow = false;
        for (const mesh of leg.segments) {
          mesh.visible = showLegs;
          mesh.castShadow = !creatureBatches && castsShadow && showLegs;
        }
        for (const mesh of leg.joints) {
          mesh.visible = showLegs;
          mesh.castShadow = false;
        }
        if (!creatureBatches && castsShadow && showLegs) creatureStats.shadowCasters += leg.segments.length;
      }
      for (const arm of c.arms) {
        const showArm = c.lodVisible && c.lodArmsActive;
        arm.hand.visible = showArm;
        arm.hand.castShadow = false;
        arm.shoulder.castShadow = false;
        for (const mesh of arm.segments) {
          mesh.visible = showArm;
          mesh.castShadow = false;
        }
        for (const mesh of arm.joints) {
          mesh.visible = showArm;
          mesh.castShadow = false;
        }
      }
    }
  }

  // Wild-activity FSM eligibility: ambient wildlife always runs it; other wild creatures only under the default 'wander' Mode.
  function fsmEligible(c) { return c.role === ROLE_WILD && (c._wildlife || currentBehavior === 'wander'); }

  function update(dt) {
    const updateStart = performance.now();
    frameIndex++;
    refreshPlayerSnapshot();
    _inspActivityTimer += dt; // live-refresh only the inspector's activity span (~5Hz), not the editable config textarea
    if (selectedCreature && _inspActivityTimer >= 0.2) {
      _inspActivityTimer = 0;
      const el = document.getElementById('inspectorActivity');
      if (el && el.textContent !== selectedCreature.activity) el.textContent = selectedCreature.activity;
    }
    if (_wildlife.enabled && hasLivePlayer()) {
      _wildlife._timer += dt;
      if (_wildlife._timer >= _wildlife.interval) {
        _wildlife._timer = 0;
        const existing = [];
        for (const c of creatures) if (c._wildlife && c.role === ROLE_WILD) existing.push({ id: c, x: c.pos.x, z: c.pos.z });
        const plan = wildlifeSpawnPlan({
          playerX: _playerPos.x, playerZ: _playerPos.z, existing,
          target: _wildlife.target, ringMin: _wildlife.ringMin, ringMax: _wildlife.ringMax,
          cullRadius: _wildlife.cullRadius, rand: Math.random, maxSpawnPerCall: 2,
        });
        for (const id of plan.despawnIds) despawnCreature(id);
        for (const s of plan.spawns) if (creatures.length < _wildlife.hardMax) spawnCreatureAt(s.x, s.z, { wildlife: true });
      }
    }
    let stageStart = updateStart;
    updateCreatureLod();
    creatureStats.lodMs = performance.now() - stageStart;
    stageStart = performance.now();
    acc += dt;
    updateContactPulses(dt);
    updateGrabbables(dt);
    rebuildObjectGrid();
    creatureStats.objectsMs = performance.now() - stageStart;

    stageStart = performance.now();
    const debug = document.getElementById('debug').checked;
    for (const c of creatures) c.lodDebugActive = debug && c === selectedCreature;
    targetMarker.visible = currentBehavior === 'target';
    raceVisualGroup.visible = currentBehavior === 'race' && debug;
    if (targetMarker.visible) {
      targetMarker.position.copy(simTarget);
      targetMarker.rotation.x = Math.PI / 2;
    }

    _forageClaims.clear();
    _forageTargets.clear();
    _forageObjects.clear();
    for (const c of creatures) c.healingTarget = null;
    if (currentBehavior === 'forage' || currentBehavior === 'combat') {
      for (const c of creatures) {
        if (!c.lodShouldSim || !c.lodArmsActive) continue;
        if (c.role === ROLE_PET || c.role === ROLE_HOSTILE) continue; // pets/hostiles never forage/heal-hijack
        if (currentBehavior === 'combat' && !c.wantsHealingForage()) continue;
        const object = forageObjectForCreature(c, _forageClaims);
        if (object) {
          c.healingTarget = currentBehavior === 'combat' ? object : null;
          _forageObjects.set(c, object);
          _forageTargets.set(c, c._forageTargetScratch.copy(object.position));
          _forageClaims.add(object);
        }
      }
    }

    for (const c of creatures) if (c.lodShouldSim && fsmEligible(c)) c.updateActivity(creatures, dt);
    for (const c of creatures) if (c.lodShouldSim) c.updateCombat(creatures, dt, (currentBehavior === 'combat' && c.role !== ROLE_PET) || c.role === ROLE_HOSTILE || (c.role === ROLE_WILD && c.activity === ACT_HUNT));
    for (const c of creatures) if (c.lodShouldSim) c.updateEating(dt);
    creatureStats.behaviorMs = performance.now() - stageStart;

    stageStart = performance.now();
    for (const c of creatures) {
      if (!c.lodShouldSim) continue;
      c.updateForageState((currentBehavior === 'forage' || c.healingTarget) ? _forageObjects.get(c) || null : null, dt);
      const gait = sceneMode === 'varied' ? c.gait : currentGait();
      const dir = sceneMode === 'varied' ? (c.config?.direction ?? directionYaw) : directionYaw;
      let steerBehavior, steerTarget;
      if (c.role === ROLE_PET) {
        // Tamed pets ignore the global Mode entirely and follow their own command.
        if (c.petCommand === CMD_GOTO && c.petTarget) { steerBehavior = 'target'; steerTarget = c.petTarget; }
        else if (c.petCommand === CMD_STAY) { steerBehavior = 'stay'; steerTarget = null; }
        else { steerBehavior = 'follow'; steerTarget = null; } // CMD_FOLLOW, and CMD_ATTACK // TODO(F3): pet attack
      } else if (c.role === ROLE_HOSTILE) {
        steerBehavior = 'hostile'; steerTarget = null;
      } else if (fsmEligible(c)) {
        // Wild-activity FSM: ambient wildlife always, other wild creatures only under the default 'wander' Mode.
        if (c.activity === ACT_HUNT) { steerBehavior = 'hunt'; steerTarget = null; }
        else if (c.activity === ACT_SOCIALIZE && c.socialTarget) { steerBehavior = 'target'; steerTarget = c.socialTarget.pos; }
        else { steerBehavior = activitySteer(c.activity).steer; steerTarget = null; }
      } else {
        steerTarget = currentBehavior === 'race' && c.config?.raceTarget
          ? c._raceTargetScratch.fromArray(c.config.raceTarget)
          : (currentBehavior === 'forage' || (currentBehavior === 'combat' && c.healingTarget))
            ? _forageTargets.get(c) || null
          : simTarget;
        steerBehavior = currentBehavior === 'combat' && c.healingTarget ? 'forage' : currentBehavior;
      }
      const raceStart = currentBehavior === 'race' && c.config?.spawn
        ? c._raceStartScratch.fromArray(c.config.spawn)
        : null;
      c.computeSteering(creatures, gait, steerBehavior, steerTarget, dir, raceStart);
    }
    creatureGrid.clear();
    for (let i = 0; i < creatures.length; i++) { creatures[i]._gridIdx = i; creatureGrid.add(creatures[i]); }
    creatureStats.steeringMs = performance.now() - stageStart;

    stageStart = performance.now();
    _activeCreatures.length = 0;
    for (const c of creatures) if (c.lodVisible && c.lodShouldSim) _activeCreatures.push(c);
    let steps = 0;
    while (acc >= FIXED && steps < 5) {
      // physicsStep already runs applyBodyTerrainClearance once per creature (incl.
      // re-clearing after trunk push-out). The second pass below is only needed for
      // creatures moved by resolveCreatureCollisions, so clear the dirty flag here,
      // let collision resolution set it, and skip clearance for everyone else. (1.2)
      for (const c of creatures) if (c.lodShouldSim) { c._collisionMoved = false; c.physicsStep(FIXED, sceneMode === 'varied' ? c.gait : currentGait(), debug && c.lodDebugActive); }
      resolveCreatureCollisions(_activeCreatures);
      for (const c of creatures) if (c.lodShouldSim && c._collisionMoved) c.applyBodyTerrainClearance();
      acc -= FIXED;
      steps++;
    }
    if (steps === 5) acc = 0;
    creatureStats.physicsMs = performance.now() - stageStart;

    stageStart = performance.now();
    if (creatureBatches) creatureBatches.beginFrame();
    for (const c of creatures) {
      if (!c.lodVisible) continue;
      c.render(debug && c.lodDebugActive, dt, c.lodShouldSim);
      creatureStats.rendered++;
    }
    if (creatureBatches) {
      creatureBatches.endFrame();
      creatureStats.instancedBoxes = creatureBatches.stats.boxes;
      creatureStats.instancedLimbs = creatureBatches.stats.limbs;
      creatureStats.instancedJoints = creatureBatches.stats.joints;
      creatureStats.instancedHandsFeet = creatureBatches.stats.handsFeet;
      creatureStats.instancedShadows = creatureBatches.stats.shadows;
    }
    creatureStats.renderMs = performance.now() - stageStart;
    stageStart = performance.now();
    removeDeadCreatures();
    if (selectedCreature && creatures.includes(selectedCreature)) {
      selectionHelper.visible = true;
      selectionHelper.setFromObject(selectedCreature.group);
    } else {
      selectionHelper.visible = false;
    }
    creatureStats.selectionMs = performance.now() - stageStart;
    creatureStats.updateMs = performance.now() - updateStart;
  }

  function clearRenderBatches() {
    if (!creatureBatches) return;
    creatureBatches.beginFrame();
    creatureBatches.endFrame();
    creatureStats.instancedBoxes = 0;
    creatureStats.instancedLimbs = 0;
    creatureStats.instancedJoints = 0;
    creatureStats.instancedHandsFeet = 0;
    creatureStats.instancedShadows = 0;
  }

  function pickCreatureFromRaycaster(raycaster) {
    const pickables = [];
    if (creatureBatches) pickables.push(...creatureBatches.pickables);
    for (const creature of creatures) {
      creature.group.traverse(o => { if (o.isMesh) pickables.push(o); });
      for (const leg of creature.legs) {
        pickables.push(leg.foot, ...leg.segments, ...leg.joints);
      }
      for (const arm of creature.arms) {
        pickables.push(arm.hand, arm.shoulder, ...arm.segments, ...arm.joints);
      }
    }
    const hit = raycaster.intersectObjects(pickables, false).find(h =>
      h.object.userData.creature || h.object.userData.creatureBatch
    );
    return hit?.object.userData.creatureBatch
      ? creatureBatches.ownerForHit(hit)
      : hit?.object.userData.creature || null;
  }

  function selectFromRaycaster(raycaster) {
    selectCreature(pickCreatureFromRaycaster(raycaster) || null);
  }

  // Tame the wild creature under the crosshair (raycaster), else the nearest wild creature within
  // maxDist of the player. Returns { tamed, creature, nearestDist } so the caller can show feedback.
  function tameFromView(raycaster, maxDist = 16) {
    let target = raycaster ? pickCreatureFromRaycaster(raycaster) : null;
    if (target && (target.role !== ROLE_WILD || !target.isCombatActive())) target = null;
    let nearestDist = Infinity;
    if (!target && hasLivePlayer()) {
      let bestD = maxDist;
      for (const c of creatures) {
        if (c.role !== ROLE_WILD || !c.isCombatActive()) continue;
        const d = Math.hypot(c.pos.x - _playerPos.x, c.pos.z - _playerPos.z);
        if (d < nearestDist) nearestDist = d;
        if (d <= bestD) { bestD = d; target = c; }
      }
    }
    if (target) { setPetCommand(target, CMD_FOLLOW); return { tamed: true, creature: target, nearestDist: 0 }; }
    return { tamed: false, creature: null, nearestDist };
  }

  function applyNetworkCreatureSnapshot(items) {
    networkCreatureSnapshot = Array.isArray(items) ? items : [];
  }

  function applyNetworkCreaturePose(creature, state) {
    if (!creature || !state) return;
    if (Array.isArray(state.p)) creature.pos.set(state.p[0] || 0, state.p[1] || 0, state.p[2] || 0);
    if (Array.isArray(state.ypr)) {
      creature.yaw = Number(state.ypr[0]) || 0;
      creature.pitch = Number(state.ypr[1]) || 0;
      creature.roll = Number(state.ypr[2]) || 0;
    } else if (Array.isArray(state.q)) {
      _clearQ.set(state.q[0] || 0, state.q[1] || 0, state.q[2] || 0, state.q[3] ?? 1);
      _clearEuler.setFromQuaternion(_clearQ, 'YXZ');
      creature.pitch = _clearEuler.x;
      creature.yaw = _clearEuler.y;
      creature.roll = _clearEuler.z;
    }
    if (Number.isFinite(Number(state.hp))) creature.health = clamp(Number(state.hp) * MAX_HEALTH, 0, MAX_HEALTH);
    creature.vel.set(0, 0, 0);
    const feet = Array.isArray(state.feet) ? state.feet : [];
    for (let i = 0; i < creature.legs.length; i++) {
      const p = feet[i];
      if (!Array.isArray(p)) continue;
      const leg = creature.legs[i];
      leg.end.set(p[0] || 0, p[1] || 0, p[2] || 0);
      leg.target.copy(leg.end);
      leg.groundPosition.copy(leg.end);
    }
    const hands = Array.isArray(state.hands) ? state.hands : [];
    for (let i = 0; i < creature.arms.length; i++) {
      const p = hands[i];
      if (!Array.isArray(p)) continue;
      const arm = creature.arms[i];
      arm.aim.set(p[0] || 0, p[1] || 0, p[2] || 0);
      arm.target.copy(arm.aim);
      arm.hand.position.copy(arm.aim);
      arm.prevHand.copy(arm.hand.position);
    }
  }

  function updateNetworkCreatures(dt) {
    const updateStart = performance.now();
    frameIndex++;
    const byId = new Map(networkCreatureSnapshot.map((state, index) => [state.id ?? index, state]));
    for (let i = 0; i < creatures.length; i++) applyNetworkCreaturePose(creatures[i], byId.get(i) || networkCreatureSnapshot[i]);
    const lodStart = performance.now();
    updateCreatureLod();
    creatureStats.lodMs = performance.now() - lodStart;
    creatureStats.objectsMs = 0;
    creatureStats.behaviorMs = 0;
    creatureStats.steeringMs = 0;
    creatureStats.physicsMs = 0;
    const renderStart = performance.now();
    if (creatureBatches) creatureBatches.beginFrame();
    for (const c of creatures) {
      if (!c.lodVisible) continue;
      c.render(false, dt, true);
      creatureStats.rendered++;
    }
    if (creatureBatches) {
      creatureBatches.endFrame();
      creatureStats.instancedBoxes = creatureBatches.stats.boxes;
      creatureStats.instancedLimbs = creatureBatches.stats.limbs;
      creatureStats.instancedJoints = creatureBatches.stats.joints;
      creatureStats.instancedHandsFeet = creatureBatches.stats.handsFeet;
      creatureStats.instancedShadows = creatureBatches.stats.shadows;
    }
    creatureStats.renderMs = performance.now() - renderStart;
    creatureStats.selectionMs = 0;
    creatureStats.sim = 0;
    creatureStats.updateMs = performance.now() - updateStart;
  }

  function setTargetPoint(point) {
    simTarget.copy(point);
    simTarget.y = terrainHeight(simTarget.x, simTarget.z) + 0.08;
    currentBehavior = 'target';
    document.getElementById('behavior').value = 'target';
  }

  function setBehavior(b) {
    currentBehavior = b;
    const el = document.getElementById('behavior');
    if (el) el.value = b;
  }

  // Tames/commands a creature: role -> pet, sets its active command, and (for goto) a
  // terrain-snapped target point. `point` null clears the goto target.
  function setPetCommand(creature, cmd, point = null) {
    if (!creature) return;
    creature.role = ROLE_PET;
    creature.petCommand = (cmd === CMD_STAY || cmd === CMD_GOTO || cmd === CMD_ATTACK) ? cmd : CMD_FOLLOW;
    if (point) {
      if (!creature.petTarget) creature.petTarget = new THREE.Vector3();
      creature.petTarget.set(point.x, terrainHeight(point.x, point.z) + 0.08, point.z);
    } else {
      creature.petTarget = null;
    }
  }

  function tameNearestToPlayer(maxDist = 6) {
    if (!hasLivePlayer()) return null;
    let best = null, bestD = maxDist;
    for (const c of creatures) {
      if (c.role !== ROLE_WILD || !c.isCombatActive()) continue; // skip non-wild and dead/dying
      const d = Math.hypot(c.pos.x - _playerPos.x, c.pos.z - _playerPos.z);
      if (d <= bestD) { bestD = d; best = c; }
    }
    if (!best) return null;
    setPetCommand(best, CMD_FOLLOW);
    return best;
  }

  function commandAllPets(cmd, point = null) {
    for (const c of creatures) if (c.role === ROLE_PET) setPetCommand(c, cmd, point);
  }

  function untamePet(creature) {
    if (!creature) return;
    creature.role = ROLE_WILD;
    creature.petCommand = CMD_FOLLOW;
    creature.petTarget = null;
  }

  // Turns every alive wild creature hostile toward the player (dev/test trigger). Returns count.
  function aggroAllWild() {
    let n = 0;
    for (const c of creatures) if (c.role === ROLE_WILD && c.isCombatActive()) { c.role = ROLE_HOSTILE; n++; }
    return n;
  }

  // Reverts every hostile creature back to wild and clears its combat/attack state.
  function calmAllHostile() {
    for (const c of creatures) {
      if (c.role !== ROLE_HOSTILE) continue;
      c.role = ROLE_WILD;
      c.combatTarget = null;
      c.punchArm = null;
      if (c.attackState !== 'dying') {
        c.attackState = 'ready';
        c.attackTimer = 0;
        c.attackApplied = false;
      }
    }
  }

  // Shallow-merges validated numeric/boolean fields into _wildlife (unknown/invalid keys ignored);
  // returns a shallow copy of the public fields for the caller to read back the applied state.
  function setWildlife(opts = {}) {
    if (typeof opts.enabled === 'boolean') _wildlife.enabled = opts.enabled;
    if (Number.isFinite(opts.target)) _wildlife.target = Math.max(0, Math.round(opts.target));
    if (Number.isFinite(opts.ringMin)) _wildlife.ringMin = Math.max(0, opts.ringMin);
    if (Number.isFinite(opts.ringMax)) _wildlife.ringMax = Math.max(_wildlife.ringMin, opts.ringMax);
    if (Number.isFinite(opts.cullRadius)) _wildlife.cullRadius = Math.max(_wildlife.ringMax, opts.cullRadius);
    if (Number.isFinite(opts.hardMax)) _wildlife.hardMax = Math.max(1, Math.round(opts.hardMax));
    return { enabled: _wildlife.enabled, target: _wildlife.target, ringMin: _wildlife.ringMin, ringMax: _wildlife.ringMax, cullRadius: _wildlife.cullRadius, hardMax: _wildlife.hardMax };
  }

  return {
    update,
    updateNetworkCreatures,
    resetCreatures,
    clearRenderBatches,
    spawnRandomObjects,
    selectFromRaycaster,
    setTargetPoint,
    setBehavior,
    setCreatureRole,
    setPetCommand,
    tameNearestToPlayer,
    tameFromView,
    pickCreatureFromRaycaster,
    commandAllPets,
    untamePet,
    aggroAllWild,
    calmAllHostile,
    setWildlife,
    spawnCreatureAt,
    despawnCreature,
    exportSharedNpcConfig,
    applySharedNpcConfig,
    applyNetworkCreatureSnapshot,
    get stats() { return creatureStats; },
    get creatures() { return creatures; },
    get selected() { return selectedCreature; },
    // select a creature (or null to clear) — shows/hides the selection box; ignores despawned refs
    select(creature) { selectCreature(creature && creatures.includes(creature) ? creature : null); },
    get pets() { return creatures.filter(c => c.role === ROLE_PET); },
    get playerThreats() { return creatures.filter(c => c.role === ROLE_HOSTILE && c.isCombatActive()).length; },
    get reflectionMeshes() { return creatureBatches ? creatureBatches.meshes : []; },
    get currentBehavior() { return currentBehavior; },
    get wildlife() { return { enabled: _wildlife.enabled, target: _wildlife.target, ringMin: _wildlife.ringMin, ringMax: _wildlife.ringMax, cullRadius: _wildlife.cullRadius, hardMax: _wildlife.hardMax }; },
    get wildlifeCount() { return creatures.filter(c => c._wildlife && c.role === ROLE_WILD).length; },
  };
}
