// Support adapter for the procedural player body in Base Game. The body asks for ground height
// through a `terrainHeight(x, z)` callback; this adapter answers it with the existing
// `worldQuery.groundProbe()` so bridges, stacked floors, tunnels and caves resolve correctly.
//
// Every probe starts a bounded distance above the body's current global foot Y and searches only
// a bounded distance below it. It never scans a whole vertical column, so a foot on a bridge deck
// cannot find the ground six metres below merely because it shares the same X/Z. Render-local in,
// render-local out; the reference is global, so a render-origin rebase changes nothing.

const DEFAULTS = Object.freeze({
  above: 1.0,
  below: 0.9,
  slopeLimitDegrees: 50,
});

export function createBodySupportAdapter({ worldQuery, worldCoordinates, above, below, slopeLimitDegrees } = {}) {
  if (typeof worldQuery?.groundProbe !== 'function') throw new TypeError('body support adapter requires worldQuery.groundProbe()');
  if (typeof worldCoordinates?.toGlobal !== 'function' || typeof worldCoordinates?.toRenderLocal !== 'function') {
    throw new TypeError('body support adapter requires a world-coordinate space');
  }
  const cfg = {
    above: above ?? DEFAULTS.above,
    below: below ?? DEFAULTS.below,
    slopeLimitCos: Math.cos((slopeLimitDegrees ?? DEFAULTS.slopeLimitDegrees) * Math.PI / 180),
  };
  const referenceGlobal = [0, 0, 0];
  let referenceSet = false;
  const _global = [0, 0, 0];
  const _local = [0, 0, 0];
  const _origin = [0, 0, 0];
  let probes = 0;
  let misses = 0;
  let lastHit = null;

  // The body's authoritative global foot position for this frame (the capsule's foot plane).
  function setReference(globalFoot) {
    referenceGlobal[0] = globalFoot[0];
    referenceGlobal[1] = globalFoot[1];
    referenceGlobal[2] = globalFoot[2];
    referenceSet = true;
  }

  // terrainHeight-compatible: render-local x/z in, render-local support Y out. With no support in
  // the window the capsule's own foot plane is returned (not a world floor); the body's airborne
  // behaviour is driven by `onFloor`, not by this value.
  function terrainHeight(x, z) {
    probes++;
    _local[0] = x; _local[1] = 0; _local[2] = z;
    worldCoordinates.toGlobal(_local, _global);
    const referenceY = referenceSet ? referenceGlobal[1] : _global[1];
    _origin[0] = _global[0]; _origin[1] = referenceY + cfg.above; _origin[2] = _global[2];
    const hit = worldQuery.groundProbe({
      origin: _origin,
      maxDistance: cfg.above + cfg.below,
      slopeLimitCos: cfg.slopeLimitCos,
    });
    if (!hit) {
      misses++;
      lastHit = null;
      worldCoordinates.toRenderLocal([_global[0], referenceY, _global[2]], _local);
      return _local[1];
    }
    lastHit = hit;
    worldCoordinates.toRenderLocal(hit.point, _local);
    return _local[1];
  }

  return {
    terrainHeight,
    setReference,
    get reference() { return [...referenceGlobal]; },
    get lastHit() { return lastHit; },
    get diagnostics() { return { probes, misses }; },
    resetCounters() { probes = 0; misses = 0; },
  };
}
