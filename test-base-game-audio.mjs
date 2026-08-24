// Node tests for base-game-audio.js (sound director rules) against a fake audio controller.
// Run: node test-base-game-audio.mjs
import { createBaseGameAudioDirector, weaponFireEvent } from './base-game-audio.js';

let failed = 0;
function ok(cond, msg) { if (!cond) { failed++; console.error('FAIL:', msg); } }

function harness({ samples = [], synth = [], listener = { x: 0, y: 0, z: 0 }, settings = {} } = {}) {
  const log = [];
  let t = 0;
  const audio = {
    play: (id, vol) => log.push({ id, kind: 'play', vol }),
    playAt: (id, pos, vol, profile) => log.push({ id, kind: 'playAt', pos: { ...pos }, vol, profile }),
    hasSfxEvent: id => samples.includes(id),
    playSynthAt: (voice, pos, opts) => log.push({ id: voice.id, kind: 'synth', pos, opts }),
  };
  const director = createBaseGameAudioDirector({
    audio, settings, getListenerPosition: () => listener, now: () => t,
    synthVoice: id => (synth.includes(id) ? { id } : null),
  });
  return { director, log, tick: ms => { t += ms; } };
}

// ---- weapon map ----
ok(weaponFireEvent('m24') === 'sniper_shoot', 'm24 -> sniper_shoot');
ok(weaponFireEvent('nope') === 'pistol_shoot', 'unknown weapon -> pistol_shoot');
ok(weaponFireEvent(null) === 'pistol_shoot', 'null weapon -> pistol_shoot');

// ---- local footsteps: one per bob half-cycle, alternating sides, none while airborne or slow ----
{
  const { director, log, tick } = harness({ samples: ['footstep'] });
  const right = { x: 1, y: 0, z: 0 };
  const pos = { x: 10, y: 2, z: 5 };
  let phase = 0;
  for (let i = 0; i < 100; i++) { tick(100); phase += 0.1 * 7; director.updateLocal(0.1, { speed: 3, grounded: true, bobPhase: phase, position: pos, right }); }
  const steps = log.filter(e => e.id === 'footstep');
  // 70 rad of bob phase = 22.3 half-cycles; the first moving frame only sets the phase.
  ok(steps.length >= 21 && steps.length <= 22, `70 rad of bob phase plays ~22 footsteps (got ${steps.length})`);
  ok(steps.every(e => e.kind === 'playAt'), 'local footsteps are positional beside the player');
  const sides = steps.map(e => Math.sign(e.pos.x - pos.x));
  ok(sides.every((s, i) => i === 0 || s !== sides[i - 1]), 'steps alternate left/right');
  ok(steps.every(e => Math.abs(Math.abs(e.pos.x - pos.x) - 0.32) < 1e-9 && Math.abs(e.pos.y - 2.16) < 1e-9), 'step lands 0.32 m beside and 0.16 m above the feet');
  ok(steps.every(e => Math.abs(e.profile.stereoPan) === 0.18 && e.profile.rolloffFactor === 0), 'own-step profile: +-0.18 pan, no rolloff');
  ok(steps.every(e => Math.sign(e.profile.stereoPan) === Math.sign(e.pos.x - pos.x)), 'pan matches the side');
  log.length = 0;
  for (let i = 0; i < 50; i++) { tick(100); phase += 0.7; director.updateLocal(0.1, { speed: 0.2, grounded: true, bobPhase: phase, position: pos, right }); }
  ok(log.length === 0, 'creeping below minStepSpeed plays nothing even though the bob idles');
  for (let i = 0; i < 50; i++) { tick(100); phase += 0.7; director.updateLocal(0.1, { speed: 3, grounded: false, bobPhase: phase, position: pos, right }); }
  ok(log.filter(e => e.id === 'footstep').length === 0, 'airborne plays no footsteps');
  log.length = 0;
  director.updateLocal(0.1, { speed: 3, grounded: true, bobPhase: phase, position: pos, right });
  ok(log.filter(e => e.id === 'footstep').length === 0, 'the first moving frame re-syncs to the phase instead of stepping');
  const plain = harness({ samples: ['footstep'] });
  let ph = 0;
  for (let i = 0; i < 20; i++) { ph += 0.7; plain.director.updateLocal(0.1, { speed: 3, grounded: true, bobPhase: ph }); }
  ok(plain.log.length > 0 && plain.log.every(e => e.kind === 'play'), 'without a position the step is non-positional');
}

// ---- local footsteps from real foot plants (the body's gait state) ----
{
  const { director, log, tick } = harness({ samples: ['footstep'] });
  const feet = {
    left: { side: -1, stepping: false, current: { x: -0.2, y: 1, z: 0 } },
    right: { side: 1, stepping: false, current: { x: 0.2, y: 1, z: 0 } },
  };
  const frame = () => { tick(50); return director.updateLocal(0.05, { speed: 2, grounded: true, feet, bobPhase: 99 }); };
  frame(); frame();
  ok(log.length === 0, 'feet at rest play nothing');
  feet.left.stepping = true; frame(); frame();
  ok(log.length === 0, 'a foot in the air has not stepped yet');
  feet.left.stepping = false; feet.left.current = { x: -0.3, y: 1.2, z: 1.4 }; frame();
  ok(log.length === 1 && log[0].id === 'footstep', 'the frame a foot stops stepping is one footstep');
  ok(log[0].pos.x === -0.3 && Math.abs(log[0].pos.y - 1.36) < 1e-9 && log[0].pos.z === 1.4, 'placed at that foot');
  ok(log[0].profile.stereoPan === -0.18, 'left foot pans left');
  feet.right.stepping = true; frame(); feet.right.stepping = false; frame();
  ok(log.length === 2 && log[1].profile.stereoPan === 0.18, 'right foot pans right');
  frame(); frame();
  ok(log.length === 2, 'bob phase is ignored while feet are supplied');
  log.length = 0;
  feet.left.stepping = true; director.updateLocal(0.05, { speed: 0.1, grounded: true, feet });
  feet.left.stepping = false; director.updateLocal(0.05, { speed: 0.1, grounded: true, feet });
  ok(log.length === 0, 'a settling shuffle while standing still is not a step');
}

// ---- jump / landing need a real jump and a real fall, not a bump ----
{
  const { director, log } = harness({ samples: ['jump', 'landing'] });
  const air = (frames, vy) => { for (let i = 0; i < frames; i++) director.updateLocal(0.016, { grounded: false, verticalSpeed: vy }); };
  director.updateLocal(0.016, { grounded: true });
  director.updateLocal(0.016, { grounded: true });
  ok(log.length === 0, 'resting on the ground plays nothing');
  director.updateLocal(0.016, { grounded: false, verticalSpeed: 5 });
  ok(log.length === 1 && log[0].id === 'jump', 'leaving the ground at jump speed plays jump');
  air(20, -8);
  ok(log.length === 1, 'staying airborne plays nothing more');
  director.updateLocal(0.016, { grounded: true });
  ok(log.length === 2 && log[1].id === 'landing', 'touching down after a real fall plays landing');
  ok(log[1].vol > 0.65, 'landing volume scales with the fall');

  // The bug this guards: walking over uneven ground lifts the capsule off the terrain each step.
  log.length = 0;
  for (let step = 0; step < 6; step++) {
    air(12, -0.8);                                        // long enough for minAirTime, far too slow to be a fall
    director.updateLocal(0.016, { grounded: true });
  }
  ok(log.length === 0, 'bumps over uneven ground are neither jumps nor landings');

  log.length = 0;
  director.updateLocal(0.016, { grounded: false, verticalSpeed: 1.2 });
  ok(log.length === 0, 'drifting off a lip below jump speed is not a jump');
  director.resetLocal();
  director.updateLocal(0.016, { grounded: true });
  ok(log.length === 0, 'after a reset the first frame sets state without a landing');
}

// ---- sample first, synth second ----
{
  const { director, log } = harness({ samples: [], synth: ['weapon_reload'] });
  director.localReload();
  ok(log.length === 1 && log[0].kind === 'synth' && log[0].id === 'weapon_reload', 'no sample -> synth fallback');
  const off = harness({ samples: [], synth: ['weapon_reload'], settings: { synthFallback: false } });
  off.director.localReload();
  ok(off.log.length === 0, 'synth fallback can be disabled');
  const both = harness({ samples: ['weapon_reload'], synth: ['weapon_reload'] });
  both.director.localReload();
  ok(both.log.length === 1 && both.log[0].kind === 'play', 'a loaded sample wins over the synth');
}

// ---- remote players: positional, culled, per-action-tick ----
{
  const { director, log, tick } = harness({ samples: ['footstep', 'weapon_reload', 'rifle_shoot', 'landing', 'jump'] });
  director.updateRemote('a', { position: { x: 5, y: 0, z: 0 }, grounded: true, action: 0, actionTick: 0 });
  for (let i = 1; i <= 20; i++) { tick(50); director.updateRemote('a', { position: { x: 5 + i * 0.2, y: 0, z: 0 }, grounded: true, action: 0, actionTick: 0 }); }
  const steps = log.filter(e => e.id === 'footstep');
  ok(steps.length === 2, `4 m of remote travel plays 2 footsteps (got ${steps.length})`);
  ok(steps.every(e => e.kind === 'playAt' && e.profile?.refDistance === 2.5), 'remote footsteps are positional with the step profile');
  log.length = 0;
  director.updateRemote('a', { position: { x: 9, y: 0, z: 0 }, grounded: true, action: 1, actionTick: 7 });
  director.updateRemote('a', { position: { x: 9, y: 0, z: 0 }, grounded: true, action: 1, actionTick: 7 });
  ok(log.filter(e => e.id === 'weapon_reload').length === 1, 'a reload action plays once per action tick');
  log.length = 0;
  director.updateRemote('a', { position: { x: 9, y: 0, z: 0 }, grounded: true, action: 2, actionTick: 8, weapon: 'cz_805_bren' });
  ok(log.length === 1 && log[0].id === 'rifle_shoot' && log[0].profile?.refDistance === 8, 'a fire action plays the weapon report with the gunshot profile');
  log.length = 0;
  director.updateRemote('far', { position: { x: 200, y: 0, z: 0 }, grounded: true, action: 1, actionTick: 1 });
  director.updateRemote('far', { position: { x: 200, y: 0, z: 0 }, grounded: true, action: 1, actionTick: 2 });
  ok(log.length === 0, 'a player beyond the cull distance is silent');
  ok(director.remoteCount === 2, 'two remote records tracked');
  director.releaseRemote('far');
  ok(director.remoteCount === 1, 'released remote is dropped');
}

// ---- voice budget per 100 ms window ----
{
  const { director, log, tick } = harness({ samples: ['weapon_draw'] });
  for (let i = 0; i < 10; i++) director.localSlotChange();
  ok(log.length === 4, `10 draws in one window are capped at 4 (got ${log.length})`);
  tick(150);
  director.localSlotChange();
  ok(log.length === 5, 'the budget refills after the window');
}

// ---- master switches ----
{
  const { director, log } = harness({ samples: ['footstep', 'pause_open'], settings: { sfxEnabled: false } });
  director.menuOpen();
  for (let i = 0; i < 50; i++) director.updateLocal(0.1, { speed: 3, grounded: true, bobPhase: i * 0.7 });
  ok(log.length === 0, 'sfxEnabled=false silences everything');
  const noSteps = harness({ samples: ['footstep', 'pause_open'], settings: { footstepsEnabled: false } });
  for (let i = 0; i < 50; i++) noSteps.director.updateLocal(0.1, { speed: 3, grounded: true, bobPhase: i * 0.7 });
  noSteps.director.menuOpen();
  ok(noSteps.log.length === 1 && noSteps.log[0].id === 'pause_open', 'footstepsEnabled=false keeps the other events');
}

if (failed) { console.error(`base-game-audio: ${failed} assertion(s) failed`); process.exit(1); }
console.log('base-game-audio: all assertions passed.');
