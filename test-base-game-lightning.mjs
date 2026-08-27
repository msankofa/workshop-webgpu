// test-base-game-lightning.mjs — the derived strike schedule (weather phase R4).
//
// Nothing about lightning crosses the network: every client computes the same bolt from the shared
// seed and the lockstep clock. That claim is only worth making if it survives clients that run at
// different frame rates, join at different times, and drag the rain slider mid-storm — which is
// what most of this file checks.
import * as THREE from 'three';
import {
  strikeHash, strikeTime, strikePlacement, strikesBetween,
  createBaseGameLightning, LIGHTNING_DEFAULTS,
} from './base-game-lightning.js';
import { BASE_GAME_SHARED_KEYS } from './base-game-protocol.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('ok  ', m); } else { fail++; console.log('FAIL', m); } };

const CFG = { seed: 7, interval: 9, intervalSpread: 0.7, distMin: 800, distMax: 4000 };

// Walk the schedule the way a client does: in frames, collecting what fires.
function walk(config, { from = 0, to = 600, dt = 1 / 60 } = {}) {
  const fired = [];
  const scratch = [];
  let t = from;
  while (t < to) {
    const next = Math.min(to, t + dt);
    for (const index of strikesBetween(config, t, next, scratch)) fired.push(index);
    t = next;
  }
  return fired;
}

// ---- 1. the hash ---------------------------------------------------------------------------------
{
  ok(strikeHash(7, 0) === strikeHash(7, 0), 'the hash is a function, not a generator');
  ok(strikeHash(7, 0) !== strikeHash(7, 1), 'consecutive indices differ');
  ok(strikeHash(7, 0) !== strikeHash(8, 0), 'so do consecutive seeds');
  ok(strikeHash(7, 0, 1) !== strikeHash(7, 0, 2), 'and the salt separates the fields of one strike');
  let lo = 1, hi = 0, sum = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) { const h = strikeHash(7, i); lo = Math.min(lo, h); hi = Math.max(hi, h); sum += h; }
  ok(lo >= 0 && hi < 1, `the hash stays in [0, 1) (${lo.toFixed(4)} .. ${hi.toFixed(4)})`);
  ok(Math.abs(sum / N - 0.5) < 0.01, `and is centred (mean ${(sum / N).toFixed(4)})`);
  // Big indices must not collapse: a room open for hours reaches high strike numbers.
  ok(strikeHash(7, 1e6) !== strikeHash(7, 1e6 + 1), 'a millionth strike still varies');
}

// ---- 2. the grid ---------------------------------------------------------------------------------
{
  let monotonic = true, minGap = Infinity;
  for (let i = 0; i < 100000; i++) {
    const a = strikeTime(i, CFG), b = strikeTime(i + 1, CFG);
    if (b < a) monotonic = false;
    minGap = Math.min(minGap, b - a);
  }
  ok(monotonic, 'strike times never go backwards, over 100k strikes');
  ok(minGap >= 0, `and never overlap (tightest gap ${minGap.toFixed(3)} s)`);

  // Each strike lands inside its own slot, which is what makes the window search O(1).
  let inSlot = true;
  for (let i = 0; i < 5000; i++) {
    const t = strikeTime(i, CFG);
    if (t < i * CFG.interval || t > (i + 1) * CFG.interval) inSlot = false;
  }
  ok(inSlot, 'every strike falls inside its own slot');

  const metronome = { ...CFG, intervalSpread: 0 };
  const gaps = [];
  for (let i = 0; i < 50; i++) gaps.push(strikeTime(i + 1, metronome) - strikeTime(i, metronome));
  ok(gaps.every(g => Math.abs(g - CFG.interval) < 1e-9), 'zero spread is an exact metronome');

  const fired = walk(CFG, { to: 900 });
  const expected = 900 / CFG.interval;
  ok(Math.abs(fired.length - expected) <= 2, `about one strike per interval over 900 s (${fired.length} vs ~${expected})`);
}

// ---- 3. every client computes the same storm -------------------------------------------------------
{
  const a = walk(CFG, { to: 600, dt: 1 / 60 });     // 60 fps
  const b = walk(CFG, { to: 600, dt: 1 / 144 });    // 144 fps
  const c = walk(CFG, { to: 600, dt: 1 / 24 });     // a struggling client
  ok(a.join(',') === b.join(','), 'a 60 fps and a 144 fps client see the same strikes');
  ok(a.join(',') === c.join(','), 'and so does one running at 24 fps');
  ok(new Set(a).size === a.length, 'no strike fires twice');

  // A late joiner: it starts the clock at 500 s and must agree from there on, without being told
  // anything about what it missed.
  const late = walk(CFG, { from: 500, to: 600 });
  const sameWindow = a.filter(i => strikeTime(i, CFG) > 500);
  ok(late.join(',') === sameWindow.join(','), 'a client joining at 500 s is immediately in phase');

  // A different seed is a different storm.
  const other = walk({ ...CFG, seed: 8 }, { to: 600 });
  const sameTimes = other.every(i => Math.abs(strikeTime(i, CFG) - strikeTime(i, { ...CFG, seed: 8 })) < 1e-9);
  ok(!sameTimes, 'a different seed moves the strikes');
}

// ---- 4. the deviation from the plan, and why -------------------------------------------------------
// The plan wanted the gap to shorten with the rain. That makes strike n's time depend on the whole
// history of the slider, so an owner dragging it mid-storm would move strikes that had already
// happened. The grid depends only on shared schedule terms; rain gates whether a strike fires.
{
  const before = strikeTime(42, CFG);
  const after = strikeTime(42, CFG);   // the config carries no rain term at all
  ok(before === after, 'a strike time does not depend on the rain, so dragging the slider cannot move it');
  ok(!('rain' in CFG), 'and the schedule config has no rain term to depend on');

  // Interval and spread DO move it, which is exactly why both are owner-owned.
  ok(strikeTime(42, { ...CFG, interval: 12 }) !== before, 'the interval moves it, so it is shared');
  ok(strikeTime(42, { ...CFG, intervalSpread: 0.1 }) !== before, 'so does the spread');
}

// ---- 5. where they land ------------------------------------------------------------------------------
{
  let minD = Infinity, maxD = 0, minB = 360, maxB = 0;
  const rings = [0, 0, 0, 0];
  for (let i = 0; i < 20000; i++) {
    const { bearingDeg, distance } = strikePlacement(i, CFG);
    minD = Math.min(minD, distance); maxD = Math.max(maxD, distance);
    minB = Math.min(minB, bearingDeg); maxB = Math.max(maxB, bearingDeg);
    // Equal-area rings: a uniform disc puts the same count in each.
    const t = (distance * distance - CFG.distMin ** 2) / (CFG.distMax ** 2 - CFG.distMin ** 2);
    rings[Math.min(3, Math.floor(t * 4))]++;
  }
  ok(minD >= CFG.distMin - 1e-6 && maxD <= CFG.distMax + 1e-6, `distances stay in range (${minD.toFixed(0)}..${maxD.toFixed(0)} m)`);
  ok(minB >= 0 && maxB < 360, 'bearings cover the compass without wrapping past it');
  const spread = Math.max(...rings) / Math.min(...rings);
  ok(spread < 1.1, `strikes are uniform over the annulus, not crowded at the inner edge (ring spread ${spread.toFixed(3)})`);

  const tight = strikePlacement(3, { seed: 7, distMin: 500, distMax: 500 });
  ok(Number.isFinite(tight.distance), 'a zero-width distance band does not divide by zero');
  const inverted = strikePlacement(3, { seed: 7, distMin: 4000, distMax: 800 });
  ok(inverted.distance >= 800 && inverted.distance <= 4000, 'min and max the wrong way round still yields a legal distance');
}

// ---- 6. the window search does not grow with the age of the room -------------------------------------
{
  const scratch = [];
  const early = () => strikesBetween(CFG, 10, 10.02, scratch);
  const late = () => strikesBetween(CFG, 4_000_000, 4_000_000.02, scratch);
  const time = fn => { const t0 = process.hrtime.bigint(); for (let i = 0; i < 20000; i++) fn(); return Number(process.hrtime.bigint() - t0) / 20000; };
  early(); late();
  const a = time(early), b = time(late);
  ok(b < a * 4, `a room open for 46 days searches as fast as a fresh one (${a.toFixed(0)} ns vs ${b.toFixed(0)} ns)`);
  ok(strikesBetween(CFG, 100, 100, scratch).length === 0, 'an empty window yields nothing');
  ok(strikesBetween(CFG, 100, 99, scratch).length === 0, 'and so does a backwards one');
}

// ---- 7. the runtime ------------------------------------------------------------------------------------
{
  const flashes = [];
  const rain = { system: { flash: (s, d) => flashes.push({ s, d }) } };
  const terrain = { seaDepth: { heightAt: () => 12 } };
  const scene = new THREE.Scene();
  const lightning = createBaseGameLightning({ scene, terrain, rain });
  lightning.set({ ...CFG, enabled: true, rain: 1, threshold: 0.3, soundSpeed: 340, cloudBase: 900, flash: 1, decay: 3.5, sunLift: 4 });
  const listener = new THREE.Vector3(0, 2, 0);

  const claps = [];
  const onThunder = distance => claps.push(distance);
  // The first update only takes a clock reference; it must not fire everything since t=0.
  lightning.update(1 / 60, 300, listener, { onThunder });
  ok(lightning.stats.strikes === 0, 'the first frame takes a clock reference rather than firing 300 s of storm');

  let t = 300;
  for (let i = 0; i < 60 * 120; i++) { t += 1 / 60; lightning.update(1 / 60, t, listener, { onThunder }); }
  ok(lightning.stats.strikes > 8 && lightning.stats.strikes < 20, `two minutes of storm struck ${lightning.stats.strikes} times`);
  ok(flashes.length === lightning.stats.strikes, 'every strike flashed the drops');
  ok(lightning.stats.thunder > 0, `and ${lightning.stats.thunder} claps arrived`);
  ok(claps.every(d => d >= CFG.distMin - 1 && d <= CFG.distMax + 1), 'each clap carried a legal distance');
  ok(lightning.lastStrike && Math.abs(lightning.lastStrike.groundY - 12) < 1e-9, 'the bolt ends on the ground the window reports');

  // A clock jump (a pause, a tab switch, a reconciliation) must resync, not unleash a barrage.
  const before = lightning.stats.strikes;
  lightning.update(1 / 60, t + 600, listener, { onThunder });
  ok(lightning.stats.strikes === before, 'a ten-minute clock jump fires nothing');
  const afterJump = lightning.stats.strikes;
  let t2 = t + 600;
  for (let i = 0; i < 60 * 60; i++) { t2 += 1 / 60; lightning.update(1 / 60, t2, listener, { onThunder }); }
  ok(lightning.stats.strikes > afterJump, 'and the storm carries on from the new time');

  // Below the threshold nothing strikes, however long you wait.
  lightning.set({ rain: 0.1 });
  const quiet = lightning.stats.strikes;
  for (let i = 0; i < 60 * 120; i++) { t2 += 1 / 60; lightning.update(1 / 60, t2, listener, { onThunder }); }
  ok(lightning.stats.strikes === quiet, 'a drizzle below the threshold never strikes');
  lightning.set({ rain: 1, enabled: false });
  for (let i = 0; i < 60 * 120; i++) { t2 += 1 / 60; lightning.update(1 / 60, t2, listener, { onThunder }); }
  ok(lightning.stats.strikes === quiet, 'and lightning turned off stays off in a full storm');
  lightning.set({ enabled: true });

  // Thunder is delayed by the distance, which is the whole effect.
  const fresh = createBaseGameLightning({ scene, terrain, rain });
  fresh.set({ ...CFG, soundSpeed: 340, distMin: 3400, distMax: 3400, rain: 1, threshold: 0 });
  const heard = [];
  fresh.strike(0, listener, { onThunder: d => heard.push(d) });
  ok(heard.length === 0, 'the clap does not arrive with the flash');
  let elapsed = 0;
  while (elapsed < 12 && heard.length === 0) { fresh.update(1 / 60, undefined, listener, { onThunder: d => heard.push(d) }); elapsed += 1 / 60; }
  ok(heard.length === 1, `it arrives once (after ${elapsed.toFixed(2)} s)`);
  ok(Math.abs(elapsed - 10) < 0.05, `at distance / speed of sound: 3400 m at 340 m/s is 10 s (heard at ${elapsed.toFixed(2)})`);

  // The sun lift decays rather than latching on.
  ok(lightning.sunLift >= 0, 'the sun lift is never negative');
  const lifted = createBaseGameLightning({ scene, terrain, rain });
  lifted.set({ ...CFG, sunLift: 4, decay: 3.5, rain: 1, threshold: 0 });
  lifted.strike(0, listener, {});
  ok(lifted.sunLift > 3, 'a strike lifts the sun');
  for (let i = 0; i < 60 * 10; i++) lifted.update(1 / 60, undefined, listener, {});
  ok(lifted.sunLift < 0.05, `and it decays away (${lifted.sunLift.toFixed(4)})`);

  lightning.dispose(); fresh.dispose(); lifted.dispose();
}

// ---- 8. what the room owns ----------------------------------------------------------------------------
{
  for (const key of ['weatherSeed', 'lightningEnabled', 'lightningThreshold', 'lightningInterval',
    'lightningIntervalSpread', 'lightningDistMin', 'lightningDistMax']) {
    ok(BASE_GAME_SHARED_KEYS.includes(key), `${key} is shared: it is an input to the derived schedule`);
  }
  for (const key of ['lightningFlash', 'lightningDecay', 'lightningBoltScale', 'lightningSunLift', 'weatherSoundSpeed']) {
    ok(!BASE_GAME_SHARED_KEYS.includes(key), `${key} stays local: it is how a bolt looks, not when it happens`);
  }
  ok(LIGHTNING_DEFAULTS.threshold === 0.3 && LIGHTNING_DEFAULTS.soundSpeed === 340, 'the module defaults match the plan');
}

// ---- 9. the page wires the sun lift through the rig, not onto the light ------------------------------
{
  const html = await (await import('fs/promises')).readFile('./base-game.html', 'utf8');
  // It used to be `sunIntensity += lightning.sunLift`, which was two bugs in one line: the lift
  // (4 by default) is compared against a moon that caps at 0.35, so every night strike flipped
  // ownership to the sun and repainted the sky warm, aimed from under the horizon. Now the lift is
  // added to whichever body already owns the key light, and never decides which. See
  // test-base-game-light-response.mjs sections 4-6.
  ok(!/sunIntensity \+= lightning\.sunLift;/.test(html), 'the flash is not folded into sunIntensity before ownership is decided');
  ok(/const keyLift = lightning\.sunLift;/.test(html), 'it is held separately');
  ok(/rig\.setSunIntensity\(moonIntensity \+ keyLift\)/.test(html) && /rig\.setSunIntensity\(sunIntensity \+ keyLift\)/.test(html),
    'and added to the intensity the rig is then given, whichever body that is');
  ok(!/dirLight\.intensity\s*[*+]=/.test(html), 'and no rig-owned light is written directly in the loop');
  ok(/lightning\.update\(dt, playerController\.waterTime/.test(html), 'lightning runs on the lockstep clock, not a local one');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
