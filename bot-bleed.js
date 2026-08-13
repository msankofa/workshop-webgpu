// Ongoing bleeding: wounds and stumps emit until healed, corpses pool out. Pure, no THREE, no DOM.
// The caller owns the FX and the damage-class gate; this only decides what is due and when.

export const BLEED_DEFAULTS = {
  woundRate: 1.3,        // drips per second from a bullet wound
  stumpRate: 4.5,        // drips per second from a severed limb
  woundDrops: 3,         // droplets per drip
  stumpDrops: 9,
  maxSites: 6,           // oldest is dropped past this, so a riddled bot has a bounded cost
  clotSeconds: 0,        // 0 = bleeds until healed; above 0 a wound seals itself after this long
  poolDelaySeconds: 0.8, // after death, before a pool starts spreading
  poolGrowth: 0.09,      // metres of radius per second
  poolMax: 0.55,
  bleedoutSeconds: 30,   // corpse stops bleeding at this point, pool frozen at whatever it reached
};

export const SITE_WOUND = 'wound';
export const SITE_STUMP = 'stump';

export function createBleedState() {
  return { sites: [], nextId: 1, dead: false, deadAt: 0, pool: 0, poolAt: null };
}

// Drips per second for one site.
export function bleedRateFor(site, cfg = BLEED_DEFAULTS) {
  return site?.kind === SITE_STUMP ? cfg.stumpRate : cfg.woundRate;
}

export function dropsFor(site, cfg = BLEED_DEFAULTS) {
  return site?.kind === SITE_STUMP ? cfg.stumpDrops : cfg.woundDrops;
}

/**
 * Open a bleeding site. `attach` is the body-part handle the drip rides, so it follows the limb.
 * A second wound on a limb that already has a stump is ignored: the stump already bleeds harder.
 */
export function openBleedSite(state, { limb, segment, attach, local, kind = SITE_WOUND }, now, cfg = BLEED_DEFAULTS) {
  if (!state) return null;
  if (kind === SITE_WOUND && state.sites.some((s) => s.limb === limb && s.kind === SITE_STUMP)) return null;
  if (kind === SITE_STUMP) closeBleedSitesOn(state, limb);
  const site = { id: state.nextId++, limb, segment, attach, local, kind, openedAt: now, nextAt: now };
  state.sites.push(site);
  while (state.sites.length > cfg.maxSites) state.sites.shift();
  return site;
}

export function closeBleedSitesOn(state, limb) {
  if (state) state.sites = state.sites.filter((s) => s.limb !== limb);
}

// A heal seals every wound. Death is not undone by this; reviving calls createBleedState instead.
export function closeBleedSites(state) {
  if (state) state.sites.length = 0;
}

export function markBleedDead(state, now) {
  if (!state || state.dead) return;
  state.dead = true;
  state.deadAt = now;
}

export function bleedingSiteCount(state) {
  return state ? state.sites.length : 0;
}

/**
 * Advance to `now` and report what is due: the sites that should drip this step, and the corpse
 * pool's current radius (0 when there is none).
 *
 * At most one drip per site per step, so a long stall or a hidden tab cannot dump a backlog of
 * decals in one frame.
 */
export function stepBleed(state, now, cfg = BLEED_DEFAULTS) {
  const out = { drips: [], pool: 0 };
  if (!state) return out;
  const bleedingOut = state.dead && (now - state.deadAt) / 1000 >= cfg.bleedoutSeconds;
  if (!bleedingOut) {
    for (const site of state.sites) {
      if (cfg.clotSeconds > 0 && (now - site.openedAt) / 1000 >= cfg.clotSeconds) continue;
      if (now < site.nextAt) continue;
      const rate = Math.max(0.01, bleedRateFor(site, cfg));
      site.nextAt = now + 1000 / rate;
      out.drips.push(site);
    }
    if (cfg.clotSeconds > 0) {
      state.sites = state.sites.filter((s) => (now - s.openedAt) / 1000 < cfg.clotSeconds);
    }
  }
  if (state.dead && state.sites.length > 0) {
    const since = (now - state.deadAt) / 1000 - cfg.poolDelaySeconds;
    const capped = Math.min(since, cfg.bleedoutSeconds);
    if (capped > 0) state.pool = Math.min(cfg.poolMax, capped * cfg.poolGrowth);
  }
  out.pool = state.pool;
  return out;
}
