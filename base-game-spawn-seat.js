// base-game-spawn-seat.js -- when the spawn building is reseated, and what happens to a player
// standing on it. Pure: the page hands in the building, the ground it should seat on, and the
// player hooks; the room server never needs this (it seats once per world).
//
// The seat depends on every input spawnSite reads: the world mode, the terrain source, whether the
// ground is the density surface (volumetric) or the heightfield, and the sea level. The page
// compares this record once per world update, after the volumetric switch and the water settings
// have been applied, and rebuilds only when it changed. A rebuild that throws leaves the record
// unpublished so the next update retries.
//
// Usage:
//   const player = createSpawnSeatPlayer({ controller, worldQuery, safeSpawn, active });
//   const seat = createSpawnSeatSync({ building, ground, wanted, onSeated, player });
//   seat.sync();   // at the end of updateWorld, after terrain.setVolumetric

export function spawnSeatState({ worldMode, source = null, volumetric = false, seaLevel = 0 }) {
  return worldMode === 'terrain'
    ? { worldMode, source, volumetric: !!volumetric, seaLevel: Number.isFinite(seaLevel) ? seaLevel : 0 }
    : { worldMode, source: null, volumetric: false, seaLevel: 0 };
}
export function spawnSeatChanged(prev, next) {
  if (!prev) return true;
  return prev.worldMode !== next.worldMode || prev.source !== next.source
    || prev.volumetric !== next.volumetric || prev.seaLevel !== next.seaLevel;
}

// A grounded player on the building floor stays on it when the floor moves; anyone else is left
// where they are unless the new building embeds them, when they go to the safe spawn.
export const FLOOR_TOLERANCE = 0.5;
export function playerAfterReseat({ position, wasOnFloor, onFloor, newFloor, headroom, safeSpawn }) {
  if (wasOnFloor) {
    const to = [position[0], newFloor, position[2]];
    return headroom(to) ? { action: 'floor', position: to } : { action: 'spawn', position: safeSpawn() };
  }
  if (onFloor && position[1] < newFloor - FLOOR_TOLERANCE) return { action: 'spawn', position: safeSpawn() };
  return { action: 'keep', position };
}

// The page's hooks around a rebuild. `active()` says the local body is the thing to move (solo,
// not in a vehicle or flying a drone). Headroom resolves the player's live stance capsule at the
// candidate foot position: any displacement, a ceiling, or a query failure means it does not fit.
export function createSpawnSeatPlayer({ controller, worldQuery, safeSpawn, active = () => true, slopeLimitCos = 0.5, iterations = 4 }) {
  function headroom(to) {
    try {
      const c = controller.getCapsule();
      const dy = to[1] - controller.getPosition()[1];
      const capsule = { start: [to[0], c.start[1] + dy, to[2]], end: [to[0], c.end[1] + dy, to[2]], radius: c.radius };
      const probe = worldQuery.resolveCapsule({ capsule, velocity: [0, 0, 0], slopeLimitCos, iterations, walkableVerticalResolution: true });
      const moved = Math.hypot(probe.capsule.start[0] - capsule.start[0], probe.capsule.start[1] - capsule.start[1], probe.capsule.start[2] - capsule.start[2]);
      return moved < 1e-4 && !probe.ceiling;
    } catch { return false; }
  }
  return {
    capture(building) {
      if (!active() || !controller.grounded) return null;
      const here = controller.getPosition();
      const wasOnFloor = building.footprintContains(here[0], here[2]) && Math.abs(here[1] - building.stats.baseY) <= FLOOR_TOLERANCE;
      return { wasOnFloor };
    },
    settle(building, before) {
      if (!active()) return null;
      const position = controller.getPosition();
      const r = playerAfterReseat({
        position, wasOnFloor: !!before?.wasOnFloor, onFloor: building.footprintContains(position[0], position[2]),
        newFloor: building.stats.baseY, headroom, safeSpawn,
      });
      if (r.action !== 'keep') controller.reset(r.position);
      return r;
    },
  };
}

export function createSpawnSeatSync({ building, ground, wanted, onSeated = null, player = null, onError = null, initial = null }) {
  let applied = initial;
  let failed = 0;
  const stats = { rebuilds: 0, failures: 0 };
  function sync() {
    const g = ground();
    let reseated = false;
    if (spawnSeatChanged(applied, g.state)) {
      const before = player?.capture?.(building) ?? null;
      try {
        building.rebuild(g.heightAt, g.seaLevel, g.options);
        applied = g.state;
        failed = 0;
        stats.rebuilds++;
        reseated = true;
      } catch (err) {
        stats.failures++;
        if (failed++ === 0) onError?.(err);
      }
      if (reseated) { onSeated?.(g.state); player?.settle?.(building, before); }
    }
    building.setVisible(wanted());
    return reseated;
  }
  return { sync, stats, get applied() { return applied; } };
}
