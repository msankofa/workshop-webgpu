// Node test for the shared combat audio budget. Pure logic -- no AudioContext needed.
import assert from 'node:assert/strict';
import { createAudioBudget, AUDIO_PRIORITY, loopVoiceCap } from './combat-audio-budget.js';

const P = AUDIO_PRIORITY;

// --- counting ---------------------------------------------------------------
{
  const b = createAudioBudget();
  const t1 = b.reserve('ballistic', P.ballisticImpact);
  const t2 = b.reserve('voice', P.voiceBark);
  assert.ok(t1 && t2, 'reservations under cap succeed');
  assert.equal(b.activeCount(), 2);
  assert.equal(b.activeCount('ballistic'), 1);
  assert.equal(b.activeCount('voice'), 1);
  assert.equal(b.release(t1), true);
  assert.equal(b.release(t1), false, 'release is idempotent-safe on a spent token');
  assert.equal(b.release(9999), false, 'unknown token releases cleanly');
  assert.equal(b.activeCount(), 1);
  assert.equal(b.release(null), false, 'null token is a safe no-op');
}

// --- category cap refuses without side effects ------------------------------
{
  const b = createAudioBudget({ categoryCaps: { ballistic: 2, voice: 6, damage: 10 } });
  assert.ok(b.reserve('ballistic', P.ballisticImpact));
  assert.ok(b.reserve('ballistic', P.ballisticImpact));
  assert.equal(b.reserve('ballistic', P.ballisticImpact), null, 'refused at category cap');
  assert.equal(b.activeCount('ballistic'), 2, 'a refused reserve changes nothing');
  assert.ok(b.reserve('voice', P.voiceBark), 'other categories are unaffected');
}

// --- global cap -------------------------------------------------------------
{
  const b = createAudioBudget({ globalCap: 3, categoryCaps: { ballistic: 99, voice: 99, damage: 99 } });
  b.reserve('ballistic', P.ballisticGunshot);
  b.reserve('ballistic', P.ballisticGunshot);
  b.reserve('ballistic', P.ballisticGunshot);
  assert.equal(b.reserve('voice', P.voiceBark), null, 'global cap blocks a fresh category');
}

// --- preemption: a death siren cuts through a wall of impacts ---------------
{
  const b = createAudioBudget({ globalCap: 4, categoryCaps: { ballistic: 4, voice: 4, damage: 4 } });
  const low = [];
  for (let i = 0; i < 4; i++) low.push(b.reserve('ballistic', P.ballisticImpact, { i }));
  assert.equal(b.reserve('damage', P.death), null, 'plain reserve never displaces');

  const got = b.reserveOrPreempt('damage', P.death, { kind: 'siren' });
  assert.ok(got, 'death priority preempts');
  assert.equal(got.evicted, low[0], 'evicts the OLDEST qualifying voice, not an arbitrary one');
  assert.deepEqual(got.evictedMeta, { i: 0 }, 'caller gets the victim meta back to stop its voice');
  assert.equal(b.activeCount(), 4, 'preemption is a swap, not a net add');
}

// --- preemption refuses when nothing is lower priority ----------------------
{
  const b = createAudioBudget({ globalCap: 2, categoryCaps: { damage: 2 } });
  b.reserve('damage', P.death);
  b.reserve('damage', P.death);
  assert.equal(b.reserveOrPreempt('damage', P.death), null, 'equal priority does not displace');
  assert.equal(b.activeCount(), 2, 'a refused preempt leaves the victim in place');
  assert.equal(b.reserveOrPreempt('damage', P.damageLoop), null, 'lower priority does not displace');
  assert.equal(b.activeCount(), 2);
}

// --- a grenade warning cuts through ambient chatter -------------------------
{
  const b = createAudioBudget({ categoryCaps: { voice: 2 } });
  const barks = [b.reserve('voice', P.voiceBark), b.reserve('voice', P.voiceBark)];
  const warn = b.reserveOrPreempt('voice', P.voiceAlert, { line: 'grenade' });
  assert.ok(warn, 'alert-tier voice preempts an ambient bark');
  assert.equal(warn.evicted, barks[0]);
}

// --- sustained voices have their own ceiling --------------------------------
{
  const b = createAudioBudget({ globalCap: 99, categoryCaps: { damage: 99 }, loopCap: 3 });
  const loops = [];
  for (let i = 0; i < 3; i++) loops.push(b.reserve('damage', P.damageLoop, { i }, { sustained: true }));
  assert.ok(loops.every(Boolean));
  assert.equal(b.sustainedCount(), 3);
  assert.equal(b.reserve('damage', P.damageLoop, null, { sustained: true }), null, 'loop cap holds');
  assert.ok(b.reserve('damage', P.damageHit), 'one-shots are unaffected by the loop cap');

  const siren = b.reserveOrPreempt('damage', P.death, null, { sustained: true });
  assert.ok(siren, 'a death siren displaces an ambient damage loop');
  assert.equal(siren.evicted, loops[0]);
  assert.equal(b.sustainedCount(), 3, 'still at the loop ceiling after the swap');
}

// --- preempting a one-shot must not be used to satisfy a loop-cap block -----
{
  const b = createAudioBudget({ globalCap: 99, categoryCaps: { damage: 99 }, loopCap: 1 });
  b.reserve('damage', P.damageLoop, null, { sustained: true });
  b.reserve('damage', P.ballisticImpact);   // low priority, but NOT sustained
  const got = b.reserveOrPreempt('damage', P.death, null, { sustained: true });
  assert.ok(got, 'the sustained voice is the one displaced');
  assert.equal(b.sustainedCount(), 1, 'evicting a one-shot would not have freed the loop slot');
}

// --- setLimits reclamps without invalidating held tokens --------------------
{
  const b = createAudioBudget({ categoryCaps: { voice: 4 } });
  const held = [b.reserve('voice', P.voiceBark), b.reserve('voice', P.voiceBark)];
  b.setLimits({ categoryCaps: { voice: 1 } });
  assert.equal(b.activeCount('voice'), 2, 'tokens already held survive a tightened cap');
  assert.equal(b.reserve('voice', P.voiceBark), null, 'new reservations respect the new cap');
  assert.equal(b.release(held[0]), true, 'held tokens still release normally');
  assert.equal(b.getLimits().categoryCaps.voice, 1);
}

// --- defaults are sane ------------------------------------------------------
{
  const b = createAudioBudget();
  const limits = b.getLimits();
  assert.equal(limits.loopCap, loopVoiceCap(), 'environment-audio.js shares this exact ceiling');
  assert.ok(limits.globalCap >= limits.categoryCaps.ballistic, 'category caps fit inside the global cap');
  assert.ok(P.death > P.ballisticImpact, 'a death outranks an impact');
  assert.ok(P.voiceAlert > P.voiceBark, 'a warning outranks a bark');
}

console.log('combat-audio-budget: all assertions passed.');
