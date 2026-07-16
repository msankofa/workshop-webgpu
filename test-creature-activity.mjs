// Node tests for creature-activity.js (pure wild-creature activity FSM decision math).
// Run: node test-creature-activity.mjs
import {
  ACT_WANDER, ACT_SLEEP, ACT_HUNT, ACT_SOCIALIZE, ACT_GRAZE,
  HUNT_SENSE, SOCIAL_SENSE, THREAT_NEAR, ACT_DURATION,
  defaultTemperament, chooseActivity, activitySteer,
  TEMPERAMENTS, sampleTemperament, TEMPERAMENT_COLORS,
} from './creature-activity.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// activities distinct
ok(new Set([ACT_WANDER, ACT_SLEEP, ACT_HUNT, ACT_SOCIALIZE, ACT_GRAZE]).size === 5, 'activities distinct');

// defaultTemperament: plain weight table, wander >= others
{
  const w = defaultTemperament();
  ok(w[ACT_WANDER] >= w[ACT_SLEEP] && w[ACT_WANDER] >= w[ACT_HUNT], 'wander weight is not lower than others');
  ok(Object.keys(w).length === 5, 'temperament covers all five activities');
}

// prey gating: out-of-range prey never yields ACT_HUNT across many draws
{
  const rand = mulberry(1);
  let sawHunt = false;
  for (let i = 0; i < 500; i++) {
    const { activity } = chooseActivity({ ctx: { preyDist: HUNT_SENSE + 5 }, rand });
    if (activity === ACT_HUNT) sawHunt = true;
  }
  ok(!sawHunt, 'hunt never chosen when preyDist beyond HUNT_SENSE');
}
// prey in range: hunt is reachable (not asserting frequency, just possibility)
{
  const rand = mulberry(2);
  let sawHunt = false;
  for (let i = 0; i < 500; i++) {
    const { activity } = chooseActivity({ ctx: { preyDist: HUNT_SENSE - 1 }, rand });
    if (activity === ACT_HUNT) sawHunt = true;
  }
  ok(sawHunt, 'hunt reachable when preyDist within HUNT_SENSE');
}

// kin gating: out-of-range kin never yields ACT_SOCIALIZE
{
  const rand = mulberry(3);
  let sawSocial = false;
  for (let i = 0; i < 500; i++) {
    const { activity } = chooseActivity({ ctx: { kinDist: SOCIAL_SENSE + 5 }, rand });
    if (activity === ACT_SOCIALIZE) sawSocial = true;
  }
  ok(!sawSocial, 'socialize never chosen when kinDist beyond SOCIAL_SENSE');
}
{
  const rand = mulberry(4);
  let sawSocial = false;
  for (let i = 0; i < 500; i++) {
    const { activity } = chooseActivity({ ctx: { kinDist: SOCIAL_SENSE - 1 }, rand });
    if (activity === ACT_SOCIALIZE) sawSocial = true;
  }
  ok(sawSocial, 'socialize reachable when kinDist within SOCIAL_SENSE');
}

// threat interrupt: never returns a resting activity when threat is near, even with prey/kin in range
{
  const rand = mulberry(5);
  let sawResting = false;
  for (let i = 0; i < 1000; i++) {
    const { activity } = chooseActivity({
      ctx: { threatDist: THREAT_NEAR - 1, preyDist: 1, kinDist: 1, hp01: 0.1, restedness: 0 },
      rand,
    });
    if (activity === ACT_SLEEP || activity === ACT_GRAZE) sawResting = true;
  }
  ok(!sawResting, 'no resting activity returned when threatDist < THREAT_NEAR');
}
// threat exactly at boundary (not < THREAT_NEAR) does not force the interrupt
{
  const rand = mulberry(6);
  let sawResting = false;
  for (let i = 0; i < 2000; i++) {
    const { activity } = chooseActivity({
      ctx: { threatDist: THREAT_NEAR, hp01: 0.1, restedness: 0 },
      rand,
    });
    if (activity === ACT_SLEEP || activity === ACT_GRAZE) sawResting = true;
  }
  ok(sawResting, 'resting activity reachable when threatDist === THREAT_NEAR (boundary is not "near")');
}

// low-hp raises sleep frequency vs high-hp over many seeded draws (same restedness)
{
  const randLow = mulberry(10);
  const randHigh = mulberry(10); // same seed sequence, only ctx differs
  let lowSleeps = 0, highSleeps = 0;
  const N = 3000;
  for (let i = 0; i < N; i++) {
    const lo = chooseActivity({ ctx: { hp01: 0.05, restedness: 0.5 }, rand: randLow });
    if (lo.activity === ACT_SLEEP) lowSleeps++;
  }
  for (let i = 0; i < N; i++) {
    const hi = chooseActivity({ ctx: { hp01: 1, restedness: 0.5 }, rand: randHigh });
    if (hi.activity === ACT_SLEEP) highSleeps++;
  }
  ok(lowSleeps > highSleeps, `low-hp sleeps more often than high-hp (low=${lowSleeps}, high=${highSleeps})`);
}

// high restedness lowers sleep frequency vs low restedness (same hp01)
{
  const randRested = mulberry(11);
  const randTired = mulberry(11);
  let restedSleeps = 0, tiredSleeps = 0;
  const N = 3000;
  for (let i = 0; i < N; i++) {
    const r = chooseActivity({ ctx: { hp01: 0.3, restedness: 1 }, rand: randRested });
    if (r.activity === ACT_SLEEP) restedSleeps++;
  }
  for (let i = 0; i < N; i++) {
    const r = chooseActivity({ ctx: { hp01: 0.3, restedness: 0 }, rand: randTired });
    if (r.activity === ACT_SLEEP) tiredSleeps++;
  }
  ok(tiredSleeps > restedSleeps, `low restedness sleeps more often than high restedness (tired=${tiredSleeps}, rested=${restedSleeps})`);
}

// durations always within ACT_DURATION bounds, across all activities
{
  const rand = mulberry(20);
  for (let i = 0; i < 2000; i++) {
    const { activity, duration } = chooseActivity({
      ctx: { preyDist: 1, kinDist: 1, hp01: Math.random ? 0.5 : 0.5, restedness: 0.5 },
      rand,
    });
    const [minS, maxS] = ACT_DURATION[activity];
    ok(duration >= minS - 1e-9 && duration <= maxS + 1e-9, `duration for ${activity} within [${minS},${maxS}] (got ${duration})`);
  }
}

// determinism: same seeded rand sequence -> same sequence of results
{
  const ctx = { preyDist: 5, kinDist: 5, threatDist: 100, hp01: 0.6, restedness: 0.4 };
  const a = [], b = [];
  const randA = mulberry(99), randB = mulberry(99);
  for (let i = 0; i < 50; i++) a.push(chooseActivity({ ctx, rand: randA }));
  for (let i = 0; i < 50; i++) b.push(chooseActivity({ ctx, rand: randB }));
  let same = true;
  for (let i = 0; i < 50; i++) {
    if (a[i].activity !== b[i].activity || a[i].duration !== b[i].duration) same = false;
  }
  ok(same, 'chooseActivity is deterministic given a seeded rand');
}

// always returns a valid activity, even with all weights zeroed
{
  const rand = mulberry(30);
  const zeroWeights = { [ACT_WANDER]: 0, [ACT_SLEEP]: 0, [ACT_HUNT]: 0, [ACT_SOCIALIZE]: 0, [ACT_GRAZE]: 0 };
  const { activity, duration } = chooseActivity({ ctx: {}, weights: zeroWeights, rand });
  ok(activity === ACT_WANDER, 'falls back to ACT_WANDER when all weights are zero');
  ok(Number.isFinite(duration), 'fallback still returns a finite duration');
}

// activitySteer mapping
{
  ok(activitySteer(ACT_WANDER).steer === 'wander' && activitySteer(ACT_WANDER).restPose === 0, 'wander steer mapping');
  ok(activitySteer(ACT_SLEEP).steer === 'stay' && activitySteer(ACT_SLEEP).restPose === 1, 'sleep steer mapping');
  ok(activitySteer(ACT_GRAZE).steer === 'stay' && activitySteer(ACT_GRAZE).restPose === 0.6, 'graze steer mapping');
  ok(activitySteer(ACT_HUNT).steer === 'hunt' && activitySteer(ACT_HUNT).restPose === 0, 'hunt steer mapping');
  ok(activitySteer(ACT_SOCIALIZE).steer === 'socialize' && activitySteer(ACT_SOCIALIZE).restPose === 0, 'socialize steer mapping');
  const fallback = activitySteer('unknown-activity');
  ok(fallback.steer === 'wander' && fallback.restPose === 0, 'unknown activity falls back to wander steer');
}

// sampleTemperament: valid archetype name, full weight table, deterministic, positive weights
{
  const rand = mulberry(7);
  const t = sampleTemperament(rand);
  ok(TEMPERAMENTS[t.name], `sampled temperament name "${t.name}" is a known archetype`);
  ok(Object.keys(t.weights).length === 5, 'sampled weights cover all five activities');
  ok(Object.values(t.weights).every((w) => w > 0), 'sampled weights are all positive');
}
// determinism: same seed -> same archetype + weights
{
  const a = sampleTemperament(mulberry(42));
  const b = sampleTemperament(mulberry(42));
  ok(a.name === b.name && JSON.stringify(a.weights) === JSON.stringify(b.weights), 'sampleTemperament deterministic given seed');
}
// jitter=0 returns the base archetype weights unchanged
{
  const rand = mulberry(8);
  const t = sampleTemperament(rand, 0);
  ok(JSON.stringify(t.weights) === JSON.stringify(TEMPERAMENTS[t.name]), 'jitter=0 yields the base archetype weights');
}
// a predator temperament hunts more than a sleepy one (personality actually biases choice)
{
  const N = 4000;
  let predHunts = 0, sleepyHunts = 0, sleepySleeps = 0, predSleeps = 0;
  const rp = mulberry(55), rs = mulberry(55);
  const ctx = { preyDist: HUNT_SENSE - 2, kinDist: SOCIAL_SENSE - 2, hp01: 0.7, restedness: 0.5 };
  for (let i = 0; i < N; i++) {
    if (chooseActivity({ ctx, weights: TEMPERAMENTS.predator, rand: rp }).activity === ACT_HUNT) predHunts++;
    const s = chooseActivity({ ctx, weights: TEMPERAMENTS.sleepy, rand: rs }).activity;
    if (s === ACT_HUNT) sleepyHunts++;
    if (s === ACT_SLEEP) sleepySleeps++;
  }
  const rp2 = mulberry(56);
  for (let i = 0; i < N; i++) if (chooseActivity({ ctx, weights: TEMPERAMENTS.predator, rand: rp2 }).activity === ACT_SLEEP) predSleeps++;
  ok(predHunts > sleepyHunts, `predator hunts more than sleepy (predator=${predHunts}, sleepy=${sleepyHunts})`);
  ok(sleepySleeps > predSleeps, `sleepy sleeps more than predator (sleepy=${sleepySleeps}, predator=${predSleeps})`);
}

// TEMPERAMENT_COLORS: one distinct 24-bit color per archetype
{
  const names = Object.keys(TEMPERAMENTS);
  ok(names.every((n) => Number.isInteger(TEMPERAMENT_COLORS[n]) && TEMPERAMENT_COLORS[n] >= 0 && TEMPERAMENT_COLORS[n] <= 0xffffff), 'every archetype has a valid 24-bit color');
  ok(new Set(names.map((n) => TEMPERAMENT_COLORS[n])).size === names.length, 'archetype colors are all distinct');
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('creature-activity: all assertions passed');
