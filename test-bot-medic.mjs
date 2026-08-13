// Node tests for bot-medic.js (pure medic triage / cohesion decisions).
// Run: node test-bot-medic.mjs
import {
  MEDIC_MOVE, MEDIC_TEND, MEDIC_DEFAULTS,
  selectHealTarget, selectReviveTarget, decideMedicAction, teamCentroid, cohesionTarget,
  medicChaseSpeedFactor, medicTendRadiusFor,
  MEDIC_CHASE_SPEED_FACTOR, MEDIC_FLEE_CHASE_SPEED_FACTOR, MEDIC_FLEE_TEND_RADIUS,
} from './bot-medic.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const self = { x: 0, z: 0 };

// heal target: nearest ally under threshold within range
{
  const allies = [
    { id: 'far', x: 30, z: 0, hp01: 0.2 },   // hurt but out of responseRadius
    { id: 'ok', x: 2, z: 0, hp01: 0.9 },     // in range but healthy
    { id: 'hurtNear', x: 5, z: 0, hp01: 0.4 },
    { id: 'hurtFar', x: 10, z: 0, hp01: 0.3 },
  ];
  const t = selectHealTarget(self, allies);
  ok(t && t.id === 'hurtNear', 'picks the nearest wounded ally within range');
  ok(selectHealTarget(self, [{ id: 'a', x: 1, z: 0, hp01: 0.99 }]) === null, 'healthy allies are ignored');
  ok(selectHealTarget(self, [{ id: 'a', x: 30, z: 0, hp01: 0.1 }]) === null, 'wounded but out-of-range is ignored');
}

// wall-aware: a supplied nav path `cost` overrides straight-line proximity and gates the range
{
  const allies = [
    { id: 'behindWall', x: 2, z: 0, hp01: 0.3, cost: 25 }, // 2m straight, 25m by path (> responseRadius)
    { id: 'sameRoom', x: 6, z: 0, hp01: 0.3, cost: 6 },
  ];
  ok(selectHealTarget(self, allies).id === 'sameRoom', 'picks the reachable-by-path ally over a wall-adjacent one');
  ok(selectHealTarget(self, [{ id: 'w', x: 1, z: 0, hp01: 0.2, cost: 30 }]) === null, 'out of range by PATH is excluded even if straight-line-near');
  const byPath = selectHealTarget(self, [{ id: 'a', x: 10, z: 0, hp01: 0.3, cost: 11 }, { id: 'b', x: 4, z: 0, hp01: 0.3, cost: 14 }]);
  ok(byPath.id === 'a', 'nearest by path wins even when farther in a straight line');
  const throughWall = decideMedicAction({ self, allies: [{ id: 'w', x: 1, z: 0, hp01: 0.3, cost: 8 }], hasCharge: true, now: 0 });
  ok(throughWall.state === MEDIC_MOVE, 'straight-line-adjacent but path-far -> MOVE, never tend through a wall');
}

// danger `bias` ranks candidates but never gates range or the tend radius (the revive-blocker bug:
// a death paints danger on the corpse's own cell, so a bias folded into `cost` made TEND unreachable)
{
  const now = 0;
  const onTopOfCorpse = decideMedicAction({
    self, corpses: [{ id: 'down', x: 0.2, z: 0, diedAt: 0, cost: 0.2, bias: 4 }], hasKit: true, now,
  });
  ok(onTopOfCorpse.state === MEDIC_TEND, 'a dangerous corpse underfoot still enters TEND');
  const farByDanger = decideMedicAction({
    self, corpses: [{ id: 'down', x: 13, z: 0, diedAt: 0, cost: 13, bias: 8 }], hasKit: true, now,
  });
  ok(farByDanger && farByDanger.kind === 'revive', 'danger bias does not push a corpse out of revive range');
  const ranked = selectReviveTarget(self, [
    { id: 'hot', x: 4, z: 0, diedAt: 0, cost: 4, bias: 8 },
    { id: 'quiet', x: 7, z: 0, diedAt: 0, cost: 7, bias: 0 },
  ], now);
  ok(ranked.id === 'quiet', 'between two reachable corpses the safer one wins on bias');
}

// revive target: within window + radius
{
  const now = 100000;
  const corpses = [
    { id: 'stale', x: 1, z: 0, diedAt: now - (MEDIC_DEFAULTS.reviveWindowMs + 1) }, // too old
    { id: 'freshFar', x: 40, z: 0, diedAt: now - 1000 },                            // out of radius
    { id: 'fresh', x: 3, z: 0, diedAt: now - 2000 },
  ];
  const r = selectReviveTarget(self, corpses, now);
  ok(r && r.id === 'fresh', 'picks a fresh corpse within the revive radius');
  ok(selectReviveTarget(self, corpses, now + MEDIC_DEFAULTS.reviveWindowMs) === null, 'all corpses expire past the window');
}

// decideMedicAction: revive outranks heal, gated by resources, MOVE vs TEND by distance
{
  const now = 0;
  const allies = [{ id: 'wounded', x: 5, z: 0, hp01: 0.3 }];
  const corpses = [{ id: 'down', x: 8, z: 0, diedAt: 0 }];

  const both = decideMedicAction({ self, allies, corpses, hasKit: true, hasCharge: true, now });
  ok(both.kind === 'revive' && both.targetId === 'down', 'revive is prioritised over healing');
  ok(both.state === MEDIC_MOVE, 'a distant target means MOVE');

  const noKit = decideMedicAction({ self, allies, corpses, hasKit: false, hasCharge: true, now });
  ok(noKit.kind === 'heal' && noKit.targetId === 'wounded', 'without a kit, falls back to healing');

  const dry = decideMedicAction({ self, allies, corpses, hasKit: false, hasCharge: false, now });
  ok(dry === null, 'no kit and no charge -> no medic action');

  const adjacent = decideMedicAction({ self, allies: [{ id: 'w', x: 1, z: 0, hp01: 0.3 }], hasCharge: true, now });
  ok(adjacent.state === MEDIC_TEND, 'an in-reach ally means TEND');
}

// S12 medic-in-cover: an exposed tend spot downgrades TEND -> MOVE(seekConcealment) toward the same target
{
  const now = 0;
  const nearAlly = [{ id: 'w', x: 1, z: 0, hp01: 0.3 }];
  const nearCorpse = [{ id: 'd', x: 1, z: 0, diedAt: 0 }];
  // Regression: absent / undefined / false `exposed` reproduces the legacy action field for field.
  const legacyHeal = decideMedicAction({ self, allies: nearAlly, hasCharge: true, now });
  for (const exposed of [undefined, false, null, 0]) {
    const a = decideMedicAction({ self, allies: nearAlly, hasCharge: true, now, exposed });
    ok(a.state === MEDIC_TEND && a.kind === 'heal' && a.targetId === 'w' && a.x === 1 && a.z === 0 && a.dist === 1,
      `exposed=${exposed} leaves the tend decision untouched`);
    ok(!('seekConcealment' in a), `exposed=${exposed} adds no seekConcealment flag`);
  }
  ok(legacyHeal.state === MEDIC_TEND, 'baseline: an in-reach ally is tended');
  const movingHeal = decideMedicAction({ self, allies: [{ id: 'w', x: 9, z: 0, hp01: 0.3 }], hasCharge: true, now, exposed: true });
  ok(movingHeal.state === MEDIC_MOVE && !movingHeal.seekConcealment,
    'an already-MOVE action is not flagged: exposure only downgrades a TEND');
  // The downgrade itself.
  const hidden = decideMedicAction({ self, allies: nearAlly, hasCharge: true, now, exposed: true });
  ok(hidden.state === MEDIC_MOVE, 'an exposed tend spot becomes a MOVE, not a stationary channel');
  ok(hidden.seekConcealment === true, 'the downgrade is flagged for the caller to re-route');
  ok(hidden.kind === 'heal' && hidden.targetId === 'w' && hidden.x === 1 && hidden.z === 0 && hidden.dist === 1,
    'the downgraded action still points at the same patient (the caller conceals within tendRadius of it)');
  const revive = decideMedicAction({ self, corpses: nearCorpse, hasKit: true, now, exposed: true });
  ok(revive.state === MEDIC_MOVE && revive.seekConcealment === true && revive.kind === 'revive',
    'an exposed revive channel downgrades the same way (revives are the longer, more lethal channel)');
  ok(decideMedicAction({ self, corpses: nearCorpse, hasKit: true, now }).state === MEDIC_TEND,
    'regression: the revive tend is unchanged without the exposed flag');
  ok(decideMedicAction({ self, allies: [], corpses: [], hasCharge: true, hasKit: true, now, exposed: true }) === null,
    'exposure never invents an action out of nothing');
}

// MED-2: a fleeing patient outran the medic, so MEDIC_TEND was unreachable mid-flee
{
  const now = 0;
  ok(medicChaseSpeedFactor(false) === MEDIC_CHASE_SPEED_FACTOR, 'a stationary patient keeps the old chase speed');
  ok(medicChaseSpeedFactor(undefined) === MEDIC_CHASE_SPEED_FACTOR, 'an unknown flee state keeps the old chase speed');
  ok(medicChaseSpeedFactor(true) === MEDIC_FLEE_CHASE_SPEED_FACTOR, 'a fleeing patient gets the sprint factor');
  // The harness numbers this has to beat: flee-heal runs at 1.24x, cover-move at 1.12x base speed.
  ok(MEDIC_FLEE_CHASE_SPEED_FACTOR > 1.24, 'the chase factor actually outruns the 1.24x flee-heal patient');
  ok(MEDIC_FLEE_CHASE_SPEED_FACTOR - 1.24 >= 0.2, 'net closure is at least 0.2x base speed (~0.5 m/s at 2.4 m/s)');
  ok(MEDIC_FLEE_CHASE_SPEED_FACTOR < 1.7, 'it stays under the run multiplier: a sprinting patient can still break off');
  ok(MEDIC_CHASE_SPEED_FACTOR < 1.24, 'pre-fix control: the old factor genuinely lost ground to a fleeing patient');
  ok(medicTendRadiusFor(false) === MEDIC_DEFAULTS.tendRadius, 'a stationary patient keeps the 1.7 m tend radius');
  ok(medicTendRadiusFor(undefined) === MEDIC_DEFAULTS.tendRadius, 'an unknown flee state keeps the default radius');
  ok(medicTendRadiusFor(true) === MEDIC_FLEE_TEND_RADIUS, 'a fleeing patient widens the tend radius');
  ok(MEDIC_FLEE_TEND_RADIUS > MEDIC_DEFAULTS.tendRadius, 'the flee radius is a widening, not a narrowing');
  ok(MEDIC_FLEE_TEND_RADIUS < MEDIC_DEFAULTS.responseRadius, 'it stays far inside the response radius (no tending across the room)');
  ok(medicTendRadiusFor(true, { ...MEDIC_DEFAULTS, tendRadius: 5 }) === MEDIC_FLEE_TEND_RADIUS, 'the flee radius ignores a custom cfg radius');
  ok(medicTendRadiusFor(false, { ...MEDIC_DEFAULTS, tendRadius: 5 }) === 5, 'the stationary radius honours a custom cfg');
  // The flag rides through selection into the action so the caller can pick a chase speed per patient.
  const gap = 2.2; // outside tendRadius(1.7), inside MEDIC_FLEE_TEND_RADIUS(2.6)
  const still = decideMedicAction({ self, allies: [{ id: 'w', x: gap, z: 0, hp01: 0.3 }], hasCharge: true, now });
  ok(still.state === MEDIC_MOVE && still.fleeing === false, 'a stationary patient at 2.2 m is still approached, not tended');
  const running = decideMedicAction({ self, allies: [{ id: 'w', x: gap, z: 0, hp01: 0.3, fleeing: true }], hasCharge: true, now });
  ok(running.state === MEDIC_TEND, 'the same gap to a FLEEING patient latches the channel (MED-2)');
  ok(running.fleeing === true, 'the action reports the flee state so the caller can pick the chase factor');
  ok(selectHealTarget(self, [{ id: 'w', x: 3, z: 0, hp01: 0.3, fleeing: true }]).fleeing === true, 'selection carries the flee flag');
  ok(selectHealTarget(self, [{ id: 'w', x: 3, z: 0, hp01: 0.3 }]).fleeing === false, 'absent flee flag reads as false, never undefined');
  // Regression: the widened radius must not tend a patient that is simply far away.
  const far = decideMedicAction({ self, allies: [{ id: 'w', x: 4, z: 0, hp01: 0.3, fleeing: true }], hasCharge: true, now });
  ok(far.state === MEDIC_MOVE, 'a fleeing patient past the widened radius is still chased, not tended at range');
  // Corpses never flee: the revive gate keeps the tight radius.
  const corpseGap = decideMedicAction({ self, corpses: [{ id: 'd', x: gap, z: 0, diedAt: 0 }], hasKit: true, now });
  ok(corpseGap.state === MEDIC_MOVE, 'the revive tend gate is unchanged (a corpse cannot run)');
  // Both fixes compose: a fleeing patient in the open still refuses the exposed channel.
  const exposedRunner = decideMedicAction({ self, allies: [{ id: 'w', x: gap, z: 0, hp01: 0.3, fleeing: true }], hasCharge: true, now, exposed: true });
  ok(exposedRunner.state === MEDIC_MOVE && exposedRunner.seekConcealment === true && exposedRunner.fleeing === true,
    'a wider tend band still yields to the exposure downgrade');
}

// cohesion: LOCAL group only (within cohesionNeighborRadius), regroup past cohesionRadius, stop short
{
  ok(teamCentroid([]) === null, 'no teammates -> no centroid');
  ok(cohesionTarget(self, []) === null, 'alone -> no cohesion goal');
  const near = cohesionTarget(self, [{ x: 4, z: 0 }]); // centroid 4m away, inside cohesionRadius(9)
  ok(near === null, 'already grouped -> no cohesion goal');
  const far = cohesionTarget(self, [{ x: 20, z: 0 }]); // only teammate is beyond perception(16)
  ok(far === null, 'no teammate within perception -> null (patrol), never a homing pull across the map');
  // a teammate just inside perception DOES pull (local group forms)
  const rejoin = cohesionTarget(self, [{ x: 14, z: 0 }]);
  ok(rejoin && approx(rejoin.x, 14 - MEDIC_DEFAULTS.cohesionDeadzone), 'a teammate inside perception forms a local group and pulls');
  const centroid = teamCentroid([{ x: 2, z: 0 }, { x: 4, z: 4 }]);
  ok(approx(centroid.x, 3) && approx(centroid.z, 2), 'centroid averages teammate positions');

  // two groups across the map: local group wins, medic does NOT march to the empty global midpoint
  {
    const nearGroup = [{ x: 11, z: 0 }, { x: 13, z: 0 }]; // ~12m away, within perception(16)
    const farGroup = [{ x: -60, z: 0 }, { x: -62, z: 0 }]; // across the map, outside perception
    const goal = cohesionTarget(self, [...nearGroup, ...farGroup]);
    // global centroid would be ~ -24 (empty midpoint); local centroid is +12 -> goal is toward +x
    ok(goal && goal.x > 0, 'joins the nearby group, not the empty global midpoint');
    ok(approx(goal.x, 12 - MEDIC_DEFAULTS.cohesionDeadzone), 'goal closes on the local group centroid');
  }
  // a teammate just inside perception forms a local group; already within cohesionRadius -> hold
  ok(cohesionTarget(self, [{ x: 8, z: 0 }]) === null, 'within cohesionRadius of the local group -> hold');
}

// ---- a squadded medic prefers its own squad's casualties ----
{
  const self = { x: 0, z: 0 };
  const hurt = (id, x, squadmate) => ({ id, x, z: 0, hp01: 0.4, squadmate });

  // Nearer stranger vs slightly farther squadmate: the squad wins.
  const near = selectHealTarget(self, [hurt('stranger', 4, false), hurt('mate', 5, true)]);
  ok(near.id === 'mate', 'a medic passes a nearer stranger for its own squadmate');

  // ...but not at any distance. Past the penalty the stranger is simply the sensible call.
  const far = selectHealTarget(self, [hurt('stranger', 2, false), hurt('mate', 12, true)]);
  ok(far.id === 'stranger', 'a much closer stranger still gets treated');

  // The preference must not shrink the medic's reach or stop the channel latching.
  const edge = selectHealTarget(self, [hurt('stranger', 15, false)]);
  ok(edge && edge.id === 'stranger', 'the squad preference does not shrink responseRadius');
  ok(Math.abs(edge.dist - 15) < 1e-9, 'the reported distance is the true one, not the weighted score');
  const touching = decideMedicAction({ self, allies: [hurt('stranger', 1, false)], hasCharge: true });
  ok(touching.state === MEDIC_TEND, 'a stranger within tend radius is tended, not walked toward');

  // Unsquadded medics keep the plain nearest-first behaviour (flag absent, not false).
  const plain = selectHealTarget(self, [hurt('a', 4, undefined), hurt('b', 5, undefined)]);
  ok(plain.id === 'a', 'an unsquadded medic just takes the nearest');

  // Revives get the same weighting.
  const corpses = [{ id: 'stranger', x: 4, z: 0, diedAt: 0, squadmate: false },
    { id: 'mate', x: 5, z: 0, diedAt: 0, squadmate: true }];
  ok(selectReviveTarget(self, corpses, 100).id === 'mate', 'revives prefer the medic\'s own squad too');
}

if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log('bot-medic: all assertions passed');
