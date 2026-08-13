// node test-bot-spawn-markers.mjs
import {
  SPAWN_MARKER_DEFAULTS, createSpawnMarkerStore, addSpawnMarker, removeSpawnMarker, spawnMarkerNear,
  spawnMarkersForTeam, clearSpawnMarkers, pickSpawnMarker, spawnMarkerById, serializeSpawnMarkers,
  loadSpawnMarkers, markerRegion, garrisonSlot, garrisonSlots, withinGarrison, clampToGarrison,
  sideModeMarkers,
} from './bot-spawn-markers.js';

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) { console.log(`  ok  ${name}`); return; }
  failures++;
  console.log(`FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
}

const BOUNDS = { minX: -50, maxX: 50, minZ: -80, maxZ: 80 };

// ---- store CRUD ----
{
  const store = createSpawnMarkerStore();
  const a = addSpawnMarker(store, { team: 'alpha', x: 5, z: 5 });
  const b = addSpawnMarker(store, { team: 'bravo', x: -5, z: -5 });
  check('add assigns unique ids', a.id !== b.id, `${a.id} vs ${b.id}`);
  check('add applies the default radius', a.radius === SPAWN_MARKER_DEFAULTS.radius, String(a.radius));
  check('lookup by id', spawnMarkerById(store, b.id) === b);
  check('team filter', spawnMarkersForTeam(store, 'alpha').length === 1);
  check('remove returns the record', removeSpawnMarker(store, a.id) === a);
  check('remove of a gone id is null', removeSpawnMarker(store, a.id) === null);
  check('store shrank', store.markers.length === 1);
}

// ---- click hit-testing ----
{
  const store = createSpawnMarkerStore();
  const marker = addSpawnMarker(store, { team: 'alpha', x: 10, z: 0 });
  check('hit inside tolerance', spawnMarkerNear(store, 11, 0) === marker);
  check('miss outside tolerance', spawnMarkerNear(store, 20, 0) === null);
  check('team-scoped hit test skips other teams', spawnMarkerNear(store, 10, 0, 2.5, 'bravo') === null);
}

// ---- clearing keeps hand-placed markers when only side markers are dropped ----
{
  const store = createSpawnMarkerStore();
  addSpawnMarker(store, { team: 'alpha', x: 1, z: 1, origin: 'placed' });
  addSpawnMarker(store, { team: 'alpha', x: 2, z: 2, origin: 'side' });
  addSpawnMarker(store, { team: 'bravo', x: 3, z: 3, origin: 'side' });
  check('clear by origin removed both side markers', clearSpawnMarkers(store, { origin: 'side' }) === 2);
  check('the placed marker survived', store.markers.length === 1 && store.markers[0].origin === 'placed');
  clearSpawnMarkers(store);
  check('clear with no filter empties the store', store.markers.length === 0);
}

// ---- pick ----
{
  const store = createSpawnMarkerStore();
  check('pick with no markers is null', pickSpawnMarker(store, 'alpha') === null);
  addSpawnMarker(store, { team: 'alpha', x: 0, z: 0 });
  addSpawnMarker(store, { team: 'alpha', x: 9, z: 9 });
  addSpawnMarker(store, { team: 'bravo', x: 4, z: 4 });
  check('pick only ever returns the team own markers',
    [0, 0.5, 0.99].every((r) => pickSpawnMarker(store, 'alpha', () => r).team === 'alpha'));
  // rng === 1 would index past the end without the clamp in pickSpawnMarker.
  check('pick clamps a degenerate rng of 1', pickSpawnMarker(store, 'alpha', () => 1) !== undefined
    && pickSpawnMarker(store, 'alpha', () => 1) !== null);
}

// ---- serialize / load round trip ----
{
  const store = createSpawnMarkerStore();
  addSpawnMarker(store, { team: 'alpha', x: 1.5, z: -2.5, radius: 12, base: true });
  addSpawnMarker(store, { team: 'bravo', x: -8, z: 4, origin: 'side' });
  const data = serializeSpawnMarkers(store);
  const restored = createSpawnMarkerStore();
  check('load reports the count', loadSpawnMarkers(restored, data) === 2);
  check('round trip preserves fields',
    JSON.stringify(serializeSpawnMarkers(restored)) === JSON.stringify(data),
    JSON.stringify(serializeSpawnMarkers(restored)));
  check('load rejects junk rows',
    loadSpawnMarkers(restored, [{ team: 'alpha', x: 1 }, null, { x: 1, z: 1 }, { team: 'a', x: 1, z: 2 }]) === 1);
  check('load of a non-array empties the store', loadSpawnMarkers(restored, undefined) === 0);
  check('reload resets ids so two loads cannot collide',
    (loadSpawnMarkers(restored, data), restored.markers[0].id) === 'spawn-1');
}

// ---- compound orientation ----
{
  // Map is 100 x 160, so the long axis is z. A marker near the +z edge must open back toward -z.
  const north = markerRegion(BOUNDS, { team: 'alpha', x: 0, z: 70 });
  const south = markerRegion(BOUNDS, { team: 'bravo', x: 0, z: -70 });
  check('north marker splits on z', north.axis === 'z');
  check('north marker faces back toward the middle', north.facing === -1);
  check('south marker faces back toward the middle', south.facing === 1);
  const west = markerRegion(BOUNDS, { team: 'alpha', x: -40, z: 2 });
  check('a marker further along x splits on x', west.axis === 'x', west.axis);
  check('west marker opens east', west.facing === 1);
  check('region carries the marker position', west.x === -40 && west.z === 2);
}

// ---- garrison ----
{
  const marker = { id: 'spawn-1', team: 'alpha', x: 10, z: -4, radius: 9 };
  const slots = garrisonSlots(marker, 4);
  check('one slot per member', slots.length === 4);
  check('the leader parks on the marker', slots[0].x === 10 && slots[0].z === -4);
  check('every slot is inside the ring',
    slots.every((s) => withinGarrison(marker, s.x, s.z)),
    JSON.stringify(slots));
  check('slots are deterministic',
    JSON.stringify(garrisonSlots(marker, 4)) === JSON.stringify(slots));
  check('a single-member garrison is just the marker', garrisonSlots(marker, 1).length === 1);
  check('the single-slot helper matches the array',
    JSON.stringify(garrisonSlot(marker, 2, 4)) === JSON.stringify(slots[2]));
  const reused = { x: 0, z: 0 };
  check('the out-param is written and returned', garrisonSlot(marker, 1, 4, reused) === reused
    && reused.x === slots[1].x && reused.z === slots[1].z);

  check('inside the ring is in the garrison', withinGarrison(marker, 12, -4));
  check('outside the ring is not', !withinGarrison(marker, 30, -4));
  check('slack widens the ring', withinGarrison(marker, 30, -4, 12));

  const near = clampToGarrison(marker, { x: 12, z: -4 });
  check('a goal inside the ring is untouched', near.x === 12 && near.z === -4);
  const far = clampToGarrison(marker, { x: 110, z: -4 });
  check('a goal outside is pulled onto the ring edge',
    Math.abs(Math.hypot(far.x - marker.x, far.z - marker.z) - marker.radius) < 1e-9,
    JSON.stringify(far));
  check('the clamped goal keeps the bearing of the intruder', far.x > marker.x && Math.abs(far.z + 4) < 1e-9);
  check('clamping the marker itself does not divide by zero',
    JSON.stringify(clampToGarrison(marker, { x: 10, z: -4 })) === JSON.stringify({ x: 10, z: -4 }));
}

// ---- side mode markers ----
{
  const markers = sideModeMarkers(BOUNDS, ['alpha', 'bravo']);
  check('one marker per team', markers.length === 2);
  check('markers are tagged as auto-created', markers.every((m) => m.origin === 'side'));
  check('teams sit on opposite ends of the long axis',
    Math.sign(markers[0].z) === -Math.sign(markers[1].z),
    JSON.stringify(markers));
  check('markers stay inside the bounds',
    markers.every((m) => m.z > BOUNDS.minZ && m.z < BOUNDS.maxZ && m.x >= BOUNDS.minX && m.x <= BOUNDS.maxX));
}

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
