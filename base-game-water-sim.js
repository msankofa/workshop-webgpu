// base-game-water-sim.js — the water the physics sees. Sea level plus the Gerstner surface built
// from the room's wave keys, evaluated at a lockstep tick time. The page and the room server both
// import this one module, so the client's prediction and the server's simulation swim in exactly
// the same sea. No renderer, no terrain: the surface is a pure function of (x, z, t).
//
// The render damps waves in water shallower than the surface's shallowFade (base-game-water.js);
// physics does not, because the depth samples the two sides have are not bit-identical. The gap is
// bounded by the wave amplitude and only appears in the last couple of metres before a beach.

import { buildWaveTable, surfaceAt, WAVE_DEFAULTS } from './water-waves.js';

export function createBaseGameWaterSim({ level = 0, waves = null, enabled = true } = {}) {
  const options = { ...WAVE_DEFAULTS, ...(waves || {}) };
  let table = buildWaveTable(options);
  let seaLevel = Number.isFinite(level) ? level : 0;
  let on = enabled !== false;
  const scratch = {};

  return {
    get level() { return seaLevel; },
    get enabled() { return on; },
    get waves() { return { ...options }; },
    get table() { return table; },
    setLevel(next) {
      if (!Number.isFinite(next) || next === seaLevel) return false;
      seaLevel = next;
      return true;
    },
    setEnabled(flag) {
      const next = flag !== false;
      if (next === on) return false;
      on = next;
      return true;
    },
    // Wave table inputs (water-waves.js names, from waveOptionsFromWorld). Returns whether it moved.
    setWaves(next) {
      let changed = false;
      for (const [key, value] of Object.entries(next || {})) {
        if (!(key in options) || options[key] === value) continue;
        options[key] = value;
        changed = true;
      }
      if (changed) table = buildWaveTable(options);
      return changed;
    },
    // Displaced surface height above global (x, z) at t seconds, or null when there is no sea.
    heightAt(x, z, t) {
      if (!on) return null;
      return seaLevel + surfaceAt(table, x, z, Number.isFinite(t) ? t : 0, 1, 4, scratch).y;
    },
    // The hook shape the player controller wants.
    surfaceFn() {
      return (x, z, t) => this.heightAt(x, z, t);
    },
  };
}
