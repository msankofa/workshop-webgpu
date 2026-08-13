// test-bot-bleed.mjs — ongoing bleeding, stumps, and the corpse pool.
// Run: node test-bot-bleed.mjs

import {
  BLEED_DEFAULTS, SITE_WOUND, SITE_STUMP, createBleedState, openBleedSite, closeBleedSites,
  closeBleedSitesOn, markBleedDead, stepBleed, bleedRateFor, dropsFor, bleedingSiteCount,
} from './bot-bleed.js';

let failures = 0;
const check = (name, actual, expected) => {
  const ok = Object.is(actual, expected);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${actual}${ok ? '' : ` (expected ${expected})`}`);
};
const checkTrue = (name, cond, detail = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond ? '' : ` -- ${detail}`}`);
};

// ---- 1. a wound drips at its rate ----
{
  const s = createBleedState();
  openBleedSite(s, { limb: 'core', segment: 'torso', kind: SITE_WOUND }, 0);
  check('wound: it drips immediately on opening', stepBleed(s, 0).drips.length, 1);
  check('wound: not again on the next frame', stepBleed(s, 16).drips.length, 0);
  const gap = 1000 / BLEED_DEFAULTS.woundRate;
  check('wound: again once its interval has passed', stepBleed(s, gap + 1).drips.length, 1);
  check('wound: a stump bleeds harder than a wound',
    bleedRateFor({ kind: SITE_STUMP }) > bleedRateFor({ kind: SITE_WOUND }), true);
  checkTrue('wound: and throws more per drip',
    dropsFor({ kind: SITE_STUMP }) > dropsFor({ kind: SITE_WOUND }));
}

// ---- 2. no backlog after a stall ----
{
  const s = createBleedState();
  openBleedSite(s, { limb: 'leftArm', kind: SITE_STUMP }, 0);
  stepBleed(s, 0);
  check('stall: ten seconds of hidden tab is still one drip, not forty', stepBleed(s, 10000).drips.length, 1);
}

// ---- 3. many wounds, bounded ----
{
  const s = createBleedState();
  for (let i = 0; i < 20; i++) openBleedSite(s, { limb: `l${i}`, kind: SITE_WOUND }, 0);
  check('cap: a riddled bot holds at maxSites', bleedingSiteCount(s), BLEED_DEFAULTS.maxSites);
  check('cap: and the oldest is the one dropped', s.sites[0].limb, 'l14');
}

// ---- 4. a stump replaces the wounds on that limb ----
{
  const s = createBleedState();
  openBleedSite(s, { limb: 'leftArm', kind: SITE_WOUND }, 0);
  openBleedSite(s, { limb: 'leftArm', kind: SITE_WOUND }, 10);
  openBleedSite(s, { limb: 'rightLeg', kind: SITE_WOUND }, 20);
  openBleedSite(s, { limb: 'leftArm', kind: SITE_STUMP }, 30);
  check('stump: it takes over that limb', s.sites.filter((x) => x.limb === 'leftArm').length, 1);
  check('stump: and the limb it took over is a stump', s.sites.find((x) => x.limb === 'leftArm').kind, SITE_STUMP);
  check('stump: other limbs are untouched', s.sites.filter((x) => x.limb === 'rightLeg').length, 1);
  check('stump: a later wound on a stump is ignored',
    openBleedSite(s, { limb: 'leftArm', kind: SITE_WOUND }, 40), null);
}

// ---- 5. healing seals everything ----
{
  const s = createBleedState();
  openBleedSite(s, { limb: 'core', kind: SITE_WOUND }, 0);
  openBleedSite(s, { limb: 'leftArm', kind: SITE_STUMP }, 0);
  closeBleedSites(s);
  check('heal: no sites left', bleedingSiteCount(s), 0);
  check('heal: and nothing drips', stepBleed(s, 5000).drips.length, 0);
  closeBleedSitesOn(createBleedState(), 'core');   // must not throw on an empty state
}

// ---- 6. clotting, when it is switched on ----
{
  const cfg = { ...BLEED_DEFAULTS, clotSeconds: 4 };
  const s = createBleedState();
  openBleedSite(s, { limb: 'core', kind: SITE_WOUND }, 0, cfg);
  checkTrue('clot: it bleeds before the clot time', stepBleed(s, 1000, cfg).drips.length === 1);
  check('clot: and stops after it', stepBleed(s, 5000, cfg).drips.length, 0);
  check('clot: the site is retired, not left inert', bleedingSiteCount(s), 0);
  check('clot: off by default, so a wound bleeds until healed', BLEED_DEFAULTS.clotSeconds, 0);
}

// ---- 7. the corpse pool ----
{
  const s = createBleedState();
  openBleedSite(s, { limb: 'core', kind: SITE_WOUND }, 0);
  check('pool: a living bot makes none', stepBleed(s, 5000).pool, 0);
  markBleedDead(s, 5000);
  check('pool: nothing during the delay', stepBleed(s, 5000 + BLEED_DEFAULTS.poolDelaySeconds * 1000 - 1).pool, 0);
  const after = stepBleed(s, 5000 + (BLEED_DEFAULTS.poolDelaySeconds + 2) * 1000).pool;
  checkTrue('pool: it spreads once the delay is up', after > 0, `${after}`);
  const late = stepBleed(s, 5000 + 600_000).pool;
  check('pool: and stops at poolMax', late, BLEED_DEFAULTS.poolMax);
  check('pool: bleedout ends the dripping', stepBleed(s, 5000 + 600_000).drips.length, 0);
  checkTrue('pool: but the pool it made stays', stepBleed(s, 5000 + 900_000).pool === BLEED_DEFAULTS.poolMax);

  const dry = createBleedState();
  markBleedDead(dry, 0);
  check('pool: a corpse with no open wound never pools', stepBleed(dry, 60_000).pool, 0);
}

// ---- 8. robustness ----
{
  check('robust: a null state is inert', stepBleed(null, 0).drips.length, 0);
  check('robust: opening on a null state returns null', openBleedSite(null, { limb: 'core' }, 0), null);
  check('robust: counting a null state is zero', bleedingSiteCount(null), 0);
  const s = createBleedState();
  markBleedDead(s, 100);
  markBleedDead(s, 900);
  check('robust: death is recorded once, so the pool clock cannot be reset', s.deadAt, 100);
}

console.log(failures === 0 ? '\nAll bleed checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
