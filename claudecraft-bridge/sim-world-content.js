// claudecraft-bridge/sim-world-content.js
// Builds a minimal ClaudeCraft WorldContent for the workshop: one flat zone
// spanning the play area, no NPCs / ground objects / roads / props, camps placed
// from workshop coordinates converted to sim yards. Terrain height is injected
// separately (setHeightProvider), so the zone's biome shape is irrelevant — the
// zone exists only to satisfy the WorldContent contract (world.ts reads
// zones[].zMin/zMax for its z-bounds) and to give mob spawn placement a band.
//
// The shape here is matched EXACTLY to the `WorldContent` interface in
// claudecraft-sim/types.ts (line ~2029). Required fields: zones, camps, npcs,
// groundObjects, roads, props, playerStart. `waterLevel` is optional but we set
// it (read through waterLevel() in world.ts, and asserted by the test).
//
// Notes on the interface (checked against the vendored source, not the plan):
//   - `props` (ZonePropsDef) is REQUIRED — colliders.ts reads content.props and
//     iterates every array on it, so all arrays must exist (empty is fine). We
//     inline the exact `emptyZoneProps()` shape from types.ts.
//   - ZoneDef REQUIRES id, name, zMin, zMax, levelRange, biome, hub (with a
//     `name`), graveyard, lakes, pois, welcome. We provide a complete, valid one.
//   - There is NO top-level `camps_meta` and no per-zone-only invented fields;
//     they are omitted. Optional WorldContent fields we don't need
//     (terrainEdits, placements, blockers, biomePaint) are omitted rather than
//     given null placeholders, since their types are non-null when present.
export function buildClaudecraftWorldContent({
  scale,
  waterLevelWorld,
  playerStartWorld,
  camps,
  zoneHalfExtentWorld = 4000,
}) {
  const half = scale.toSim(zoneHalfExtentWorld);
  return {
    zones: [
      {
        id: 'workshop',
        name: 'Workshop',
        zMin: -half,
        zMax: half,
        levelRange: [1, 60],
        biome: 'vale',
        hub: { x: 0, z: 0, radius: 1, name: 'Workshop' },
        graveyard: { x: 0, z: 0 },
        lakes: [],
        pois: [],
        welcome: '',
      },
    ],
    camps: camps.map((c) => ({
      mobId: c.mobId,
      center: { x: scale.toSim(c.centerWorld.x), z: scale.toSim(c.centerWorld.z) },
      radius: scale.toSim(c.radiusWorld),
      count: c.count,
    })),
    npcs: {},
    groundObjects: [],
    roads: [],
    props: emptyZoneProps(),
    playerStart: { x: scale.toSim(playerStartWorld.x), z: scale.toSim(playerStartWorld.z) },
    waterLevel: scale.toSim(waterLevelWorld),
  };
}

// A neutral, empty-but-valid ZonePropsDef. Mirrors emptyZoneProps() in
// claudecraft-sim/types.ts exactly — every array colliders.ts iterates is
// present (buildings, wells, stalls, mines, docks, tents, crates, campfires,
// mudHuts, ruinRings, fences, graveyards). delveMarkers is optional and omitted.
function emptyZoneProps() {
  return {
    buildings: [],
    wells: [],
    stalls: [],
    mines: [],
    docks: [],
    tents: [],
    crates: [],
    campfires: [],
    mudHuts: [],
    ruinRings: [],
    fences: [],
    graveyards: [],
  };
}
