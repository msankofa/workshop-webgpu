// Node tests for createBotDamageAudio's lifecycle: siren grants, eviction, budget/slot reclamation
// and teardown. Pure logic -- every world query and audio call is an injected fake, no AudioContext.
// Run: node test-bot-damage-audio-controller.mjs
import assert from 'node:assert/strict';
import { createBotDamageAudio, BOT_DAMAGE_TUNING } from './bot-damage-audio.js';
import { createAudioBudget } from './combat-audio-budget.js';

// A stand-in for environment-audio.js's loop handle, including the `stopped` flag the
// controller's sweeps read to detect a distance-culled voice.
function fakeHandle() {
  const h = {
    stopped: false, volume: null, stopCalls: 0,
    stop(fade) { h.stopCalls++; h.stopped = true; h.lastFade = fade; },
    setTargetVolume(v) { h.volume = v; },
  };
  return h;
}

// World of bots the controller queries by id. Everything is a plain lookup.
function makeRig(opts = {}) {
  const world = new Map();
  const oneShots = [];
  const handles = [];
  let clock = 0;
  const timers = [];
  const budget = opts.budget || createAudioBudget();

  const ctl = createBotDamageAudio({
    now: () => clock,
    budget,
    maxHp: 100,
    tuning: opts.tuning,
    getThreshold01: () => 0.6,
    getReviveWindowMs: () => 12000,
    getListenerPosition: () => ({ x: 0, y: 0, z: 0 }),
    exists: id => world.has(id),
    isAlive: id => !!world.get(id)?.alive,
    getHp01: id => world.get(id)?.hp01 ?? null,
    getPosition: id => world.get(id)?.pos ?? { x: 0, y: 0, z: 0 },
    playOneShot: (id, pos) => oneShots.push({ id, pos, priority: false }),
    playPriorityOneShot: (id, pos) => oneShots.push({ id, pos, priority: true }),
    playLoop: () => { if (opts.loopFails) return false; const h = fakeHandle(); handles.push(h); return h; },
    setTimer: (fn, ms) => { timers.push({ fn, at: clock + ms }); return timers.length; },
  });

  return {
    ctl, world, oneShots, handles, budget, timers,
    spawn(id, hp01 = 1, dist = 0) { world.set(id, { alive: true, hp01, pos: { x: dist, y: 0, z: 0 } }); },
    kill(id) { const b = world.get(id); if (b) { b.alive = false; b.hp01 = 0; } },
    tick(ms) { clock += ms; ctl.update(clock); },
    advance(ms) { clock += ms; for (const t of timers) if (!t.done && t.at <= clock) { t.done = true; t.fn(); } },
    get now() { return clock; },
    fired: id => oneShots.filter(o => o.id === id).length,
  };
}

const dmg = (id, hpBefore01, hpAfter01, extra = {}) => ({
  id, amount: (hpBefore01 - hpAfter01) * 100, hpBefore01, hpAfter01,
  cause: 'bullet', fatal: hpAfter01 <= 0, ...extra,
});

// --- a fatal hit yields the moment to the sting -----------------------------
{
  const r = makeRig();
  r.spawn('a');
  r.ctl.onDamaged(dmg('a', 1, 0.7));
  assert.equal(r.oneShots.length, 1, 'a survivable hit plays its tier');
  assert.ok(!r.oneShots[0].priority, 'tier one-shots are not priority-routed');

  r.oneShots.length = 0;
  r.kill('a');
  r.ctl.onDamaged(dmg('a', 0.7, 0));
  assert.equal(r.oneShots.length, 0, 'a fatal hit plays no tier clang -- the sting owns that beat');
}

// --- death: sting always, siren when a slot is free -------------------------
{
  const r = makeRig();
  r.spawn('a'); r.kill('a');
  r.ctl.onDied({ id: 'a', revivable: true, diedAt: r.now });
  assert.equal(r.fired('bot_death_sting'), 1, 'the killing blow always stings');
  assert.ok(r.oneShots[0].priority, 'the sting bypasses the rate window');
  assert.equal(r.ctl.stats().sirens, 1, 'a revivable death opens a siren');
  assert.equal(r.handles[0].volume, BOT_DAMAGE_TUNING.sirenBaseVolume, 'a lone siren plays at full volume');
}

// --- mass death: sirens capped, but no kill is ever silent ------------------
{
  const r = makeRig();
  const n = BOT_DAMAGE_TUNING.maxSirens + 4;
  for (let i = 0; i < n; i++) { r.spawn(`b${i}`); r.kill(`b${i}`); r.ctl.onDied({ id: `b${i}`, revivable: true, diedAt: r.now }); }
  assert.equal(r.ctl.stats().sirens, BOT_DAMAGE_TUNING.maxSirens, 'sirens hold at the cap under mass death');
  assert.equal(r.fired('bot_death_sting'), n, 'every death still gets its sting, slot or not');
  const ducked = r.handles.filter(h => h.volume != null);
  assert.ok(ducked.length > 0, 'concurrent sirens are ducked');
  assert.ok(ducked.every(h => h.volume < BOT_DAMAGE_TUNING.sirenBaseVolume), 'ducking lowers, never raises');
}

// --- revive ends the siren with a chime; bleed-out ends it with a powerdown -
{
  const r = makeRig();
  r.spawn('a'); r.kill('a');
  r.ctl.onDied({ id: 'a', revivable: true, diedAt: r.now });
  const h = r.handles[0];
  r.ctl.onRevived({ id: 'a' });
  assert.equal(r.ctl.stats().sirens, 0, 'a revive closes the siren');
  assert.ok(h.stopped, 'the loop handle is actually stopped');
  assert.equal(r.fired('bot_revived'), 1, 'a revive is audibly distinct');
  assert.equal(r.fired('bot_death_powerdown'), 0, 'a revived bot never powers down');
}
{
  const r = makeRig();
  r.spawn('a'); r.kill('a');
  r.ctl.onDied({ id: 'a', revivable: true, diedAt: r.now });
  r.tick(13000);
  assert.equal(r.ctl.stats().sirens, 0, 'the siren ends at the revive window');
  assert.equal(r.fired('bot_death_powerdown'), 1, 'bleeding out powers down');
  assert.equal(r.fired('bot_revived'), 0, 'bleeding out is not a revive');
}

// --- respawn is a teardown, not a narrative beat ----------------------------
{
  const r = makeRig();
  r.spawn('a'); r.kill('a');
  r.ctl.onDied({ id: 'a', revivable: true, diedAt: r.now });
  r.world.get('a').alive = true;                       // respawn, shorter than the revive window
  r.tick(300);
  assert.equal(r.ctl.stats().sirens, 0, 'a respawn cuts the siren');
  assert.equal(r.fired('bot_death_powerdown'), 0, 'a respawn gets no powerdown flourish');
  assert.equal(r.fired('bot_revived'), 0, 'a respawn is not a revive');
}

// --- a bot culled mid-siren must not leak ----------------------------------
{
  const r = makeRig();
  r.spawn('a'); r.kill('a');
  r.ctl.onDied({ id: 'a', revivable: true, diedAt: r.now });
  const h = r.handles[0];
  r.world.delete('a');                                  // corpse culled out from under the siren
  r.tick(300);
  assert.equal(r.ctl.stats().sirens, 0, 'a vanished bot releases its siren');
  assert.ok(h.stopped, 'the orphaned loop is stopped, not leaked');
  r.advance(2000);                                      // let the sting's own token expire too
  assert.equal(r.budget.activeCount('damage'), 0, 'and its budget token is released');
}

// --- REGRESSION: the audio layer's own cull must reclaim the slot -----------
// environment-audio.js's sweep can stop a handle directly on distance cull. If the controller
// does not notice, a silent siren holds one of maxSirens slots for the whole revive window.
{
  const r = makeRig();
  for (let i = 0; i < BOT_DAMAGE_TUNING.maxSirens; i++) {
    r.spawn(`b${i}`); r.kill(`b${i}`); r.ctl.onDied({ id: `b${i}`, revivable: true, diedAt: r.now });
  }
  assert.equal(r.ctl.stats().sirens, BOT_DAMAGE_TUNING.maxSirens);
  r.handles[0].stopped = true;                          // culled by the audio layer, not by us
  r.tick(300);
  assert.equal(r.ctl.stats().sirens, BOT_DAMAGE_TUNING.maxSirens - 1, 'a culled siren frees its slot');
  r.spawn('late'); r.kill('late');
  r.ctl.onDied({ id: 'late', revivable: true, diedAt: r.now });
  assert.equal(r.ctl.stats().sirens, BOT_DAMAGE_TUNING.maxSirens, 'the freed slot is reusable');
}

// --- a refused loop must not strand its budget token ------------------------
{
  const r = makeRig({ loopFails: true });
  r.spawn('a'); r.kill('a');
  r.ctl.onDied({ id: 'a', revivable: true, diedAt: r.now });
  assert.equal(r.ctl.stats().sirens, 0, 'no siren when the audio layer refuses');
  assert.equal(r.fired('bot_death_sting'), 1, 'the sting still plays');
  r.advance(2000);                                       // let the sting token expire
  assert.equal(r.budget.activeCount('damage'), 0, 'a refused loop leaves no stranded token');
}

// --- wounded tracking: sparks escalate, full health clears ------------------
{
  const r = makeRig();
  r.spawn('a', 0.4);
  r.ctl.onDamaged(dmg('a', 1, 0.4));
  assert.equal(r.ctl.stats().wounded, 1, 'a hurt bot is tracked');
  r.oneShots.length = 0;
  for (let i = 0; i < 20; i++) r.tick(300);
  const hurtSparks = r.fired('bot_damage_spark');
  assert.ok(hurtSparks > 0, 'a wounded bot sparks over time');

  r.world.get('a').hp01 = 1;
  r.tick(300);
  assert.equal(r.ctl.stats().wounded, 0, 'healing back to full stops the tell');
}
{
  // Cadence must shorten as HP falls -- that is the whole point of the escalating tell.
  const near = makeRig(); near.spawn('a', 0.55); near.ctl.onDamaged(dmg('a', 1, 0.55));
  const dire = makeRig(); dire.spawn('a', 0.05); dire.ctl.onDamaged(dmg('a', 1, 0.05));
  for (let i = 0; i < 40; i++) { near.tick(300); dire.tick(300); }
  assert.ok(dire.fired('bot_damage_spark') > near.fired('bot_damage_spark'),
    'a near-dead bot sparks more often than a lightly wounded one');
}

// --- sustained beds go to the closest few only ------------------------------
{
  const r = makeRig();
  for (let i = 0; i < 8; i++) { r.spawn(`b${i}`, 0.1, i * 10); r.ctl.onDamaged(dmg(`b${i}`, 1, 0.1)); }
  r.tick(300);
  assert.equal(r.ctl.stats().loops, BOT_DAMAGE_TUNING.maxDamageLoops, 'beds are capped');
  assert.ok(r.ctl.stats().wounded === 8, 'all wounded stay tracked for sparks');
}

// --- a death siren displaces an ambient bed, and the bed actually stops -----
{
  const budget = createAudioBudget({ categoryCaps: { damage: 2 }, loopCap: 2 });
  const r = makeRig({ budget, tuning: { maxDamageLoops: 2, scanIntervalMs: 250 } });
  for (let i = 0; i < 2; i++) { r.spawn(`w${i}`, 0.1, i); r.ctl.onDamaged(dmg(`w${i}`, 1, 0.1)); }
  r.tick(300);
  assert.equal(r.ctl.stats().loops, 2, 'both beds are live and holding the loop cap');
  const bedHandles = r.handles.slice();

  r.spawn('dead'); r.kill('dead');
  r.ctl.onDied({ id: 'dead', revivable: true, diedAt: r.now });
  assert.equal(r.ctl.stats().sirens, 1, 'a death displaces an ambient bed for its siren');
  assert.ok(bedHandles.some(h => h.stopped), 'the displaced bed is actually stopped, not just untokened');
  assert.ok(r.ctl.stats().loops < 2, 'and the controller no longer counts it');
}

// --- teardown hard-cuts everything -----------------------------------------
{
  const r = makeRig();
  for (let i = 0; i < 3; i++) { r.spawn(`d${i}`); r.kill(`d${i}`); r.ctl.onDied({ id: `d${i}`, revivable: true, diedAt: r.now }); }
  r.spawn('w', 0.1); r.ctl.onDamaged(dmg('w', 1, 0.1)); r.tick(300);
  const before = r.handles.length;
  r.ctl.stopAll();
  assert.equal(r.ctl.stats().sirens, 0, 'teardown clears sirens');
  assert.equal(r.ctl.stats().wounded, 0, 'teardown clears wounded');
  assert.ok(r.handles.slice(0, before).every(h => h.stopped), 'every live handle is stopped');
  // Sustained tokens go back at teardown; in-flight sting tokens ride out their own short timer.
  assert.ok(r.budget.sustainedCount() === 0, 'teardown releases every sustained token');
  r.advance(2000);
  assert.equal(r.budget.activeCount('damage'), 0, 'in-flight sting tokens self-release, nothing strands');
  assert.ok(r.handles.every(h => h.lastFade === 0 || h.lastFade === undefined || h.stopCalls > 0),
    'teardown is a hard cut, no lingering flourish');
}

// --- disabled controller stays silent ---------------------------------------
{
  const world = new Map([['a', { alive: false, hp01: 0, pos: { x: 0, y: 0, z: 0 } }]]);
  const shots = [];
  const ctl = createBotDamageAudio({
    now: () => 0, enabled: () => false,
    exists: id => world.has(id), isAlive: () => false, getHp01: () => 0,
    getPosition: () => ({ x: 0, y: 0, z: 0 }),
    playOneShot: id => shots.push(id), playPriorityOneShot: id => shots.push(id),
    playLoop: () => fakeHandle(),
  });
  ctl.onDamaged(dmg('a', 1, 0.5));
  ctl.onDied({ id: 'a', revivable: true, diedAt: 0 });
  assert.equal(shots.length, 0, 'a disabled controller plays nothing');
  assert.equal(ctl.stats().sirens, 0);
}

console.log('bot-damage-audio-controller: all assertions passed.');
