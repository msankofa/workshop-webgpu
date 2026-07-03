// Runs in Node.js. Plain assertions, no test framework — mirrors multiplayer-test.mjs.
import { createEntityRegistry, MAX_LIGHT_ENTITIES } from './entity-registry.js';
import { LightEntity } from './entity-types/light.js';
import { ProjectileEntity } from './entity-types/projectile.js';

let failed = false;
function check(cond, msg) {
  if (!cond) {
    failed = true;
    console.error('FAIL:', msg);
  }
}

// --- helpers ---
function makeRegistry() {
  const reg = createEntityRegistry();
  reg.registerType(LightEntity);
  reg.registerType(ProjectileEntity);
  return reg;
}
const flatTerrain = () => 0;

// ---------------------------------------------------------------
// 1. create / update / destroy + version bumps
// ---------------------------------------------------------------
{
  const reg = makeRegistry();
  const e = reg.create('light', { x: 1, y: 2, z: 3, params: { lifespan: 5 } }, {});
  check(e && e.id === 'light-1', `create should allocate id light-1, got ${e && e.id}`);
  check(e.type === 'light', 'entity type should be light');
  check(e.transform.p[0] === 1 && e.transform.p[1] === 2 && e.transform.p[2] === 3, 'transform.p should match input xyz');
  const v1 = e.version;

  const updated = reg.update(e.id, { state: { radius: 99 } }, {});
  check(updated.state.radius === 99, 'update should shallow-merge into state');
  check(updated.version > v1, `update should bump version, ${updated.version} > ${v1}`);

  const gotten = reg.get(e.id);
  check(gotten === updated, 'get should return the same entity object');

  const destroyed = reg.destroy(e.id, 'test-reason', {});
  check(destroyed === true, 'destroy should return true for existing entity');
  check(reg.get(e.id) === null, 'get after destroy should return null');
  check(reg.destroy('nope', 'x', {}) === false, 'destroy of unknown id should return false');
}

// ---------------------------------------------------------------
// 2. snapshot() shape: full:true, upserts serialized, removes carry destroyed ids
// ---------------------------------------------------------------
{
  const reg = makeRegistry();
  const a = reg.create('light', { x: 0, y: 0, z: 0, params: {} }, {});
  const b = reg.create('light', { x: 5, y: 0, z: 0, params: {} }, {});
  reg.destroy(a.id, 'gone', {});

  const snap = reg.snapshot();
  check(snap.full === true, 'snapshot.full should be true');
  check(snap.since === 0, 'snapshot.since should be 0 (full snapshots only this milestone)');
  check(Array.isArray(snap.upserts), 'snapshot.upserts should be an array');
  check(snap.upserts.length === 1 && snap.upserts[0].id === b.id, `snapshot.upserts should only contain live entity ${b.id}`);
  check(snap.upserts[0].type === 'light', 'serialized upsert should carry type');
  check(Array.isArray(snap.removes) && snap.removes.length === 1 && snap.removes[0].id === a.id,
    `snapshot.removes should carry destroyed id ${a.id}`);

  // tombstone should be held exactly one cycle then dropped
  const snap2 = reg.snapshot();
  check(snap2.removes.length === 0, 'removes should be empty after being consumed once');
}

// ---------------------------------------------------------------
// 3. applySnapshot mirror convergence + never-ticked guard
// ---------------------------------------------------------------
{
  const host = makeRegistry();
  const a = host.create('light', { x: 1, y: 2, z: 3, params: { r: 255, g: 0, b: 0 } }, {});
  const snap1 = host.snapshot();

  const mirror = makeRegistry();
  mirror.applySnapshot(snap1);
  check(mirror.get(a.id) !== null, 'mirror should have the upserted entity after applySnapshot');
  check(mirror.list().length === 1, 'mirror should have exactly one entity');

  host.destroy(a.id, 'gone', {});
  const snap2 = host.snapshot();
  mirror.applySnapshot(snap2);
  check(mirror.get(a.id) === null, 'mirror should remove entity after applySnapshot with removes');

  // never-ticked guard: a registry that has been tick()ed must refuse applySnapshot
  const tickedReg = makeRegistry();
  tickedReg.tick(0.016, { terrainHeight: flatTerrain });
  let threw = false;
  try {
    tickedReg.applySnapshot(snap1);
  } catch (err) {
    threw = true;
  }
  check(threw, 'applySnapshot should throw on a registry instance that has been ticked');
}

// ---------------------------------------------------------------
// 4. light adapter lifespan -> self-destroy
// ---------------------------------------------------------------
{
  const reg = makeRegistry();
  // lgNormalizeParamsPacket clamps lifespan to a floor of 0.5s, so use dt that clears that floor.
  const e = reg.create('light', { x: 0, y: 5, z: 0, params: { lifespan: 0.5, float: true } }, {});
  check(reg.get(e.id) !== null, 'light should exist right after creation');
  reg.tick(0.6, { terrainHeight: flatTerrain }); // dt > lifespan
  check(reg.get(e.id) === null, 'light should self-destroy once lifespan <= 0');
  const snap = reg.snapshot();
  check(snap.removes.some(r => r.id === e.id), 'destroyed light should appear in snapshot removes');
}

// ---------------------------------------------------------------
// 5. projectile impact spawns a light (fake terrainHeight + spawn) and destroys itself;
//    spawned light carries spawnedFrom
// ---------------------------------------------------------------
{
  const reg = makeRegistry();
  // Fires straight down from y=10 onto terrain at y=0 -> should hit almost immediately.
  const proj = reg.create('projectile', {
    origin: [0, 10, 0],
    dir: [0, -1, 0],
    chargeRatio: 1,
    arc: false,
    payload: { type: 'light', params: { lifespan: 10, float: false } },
    ownerId: 'player-1',
  }, {});
  check(proj !== null, 'projectile create should succeed');

  const spawnCalls = [];
  const ctx = {
    terrainHeight: () => 0,
    spawn(type, init) {
      spawnCalls.push({ type, init });
      return reg.create(type, init, ctx);
    },
  };

  // Step until the projectile impacts (max speed at chargeRatio=1 is 60 u/s, so
  // a few ticks at 1/60s dt should be plenty to cross 10 units of height).
  for (let i = 0; i < 30 && reg.get(proj.id); i++) {
    reg.tick(1 / 30, ctx);
  }

  check(reg.get(proj.id) === null, 'projectile should destroy itself on impact');
  check(spawnCalls.length === 1, `ctx.spawn should be called exactly once, got ${spawnCalls.length}`);
  check(spawnCalls[0].type === 'light', 'projectile impact should spawn a light entity');
  check(spawnCalls[0].init.spawnedFrom === proj.id, 'spawned light init should carry spawnedFrom = projectile id');

  const lights = reg.list({ type: 'light' });
  check(lights.length === 1, 'registry should now contain exactly one light entity');
  const serialized = LightEntity.serialize(lights[0]);
  check(serialized.spawnedFrom === proj.id, `serialized spawned light should carry spawnedFrom = ${proj.id}, got ${serialized.spawnedFrom}`);
}

// ---------------------------------------------------------------
// 6. 33-entity cap rejects the 34th (lights + projectiles combined)
// ---------------------------------------------------------------
{
  const reg = makeRegistry();
  const created = [];
  for (let i = 0; i < MAX_LIGHT_ENTITIES; i++) {
    const e = reg.create('light', { x: i, y: 0, z: 0, params: { lifespan: 100, float: true } }, {});
    check(e !== null, `entity ${i} within cap should be created`);
    created.push(e);
  }
  check(reg.list({ type: 'light' }).length === MAX_LIGHT_ENTITIES, `registry should hold exactly ${MAX_LIGHT_ENTITIES} lights`);

  const overflow = reg.create('light', { x: 999, y: 0, z: 0, params: {} }, {});
  check(overflow === null, 'creating the 34th capped entity should be rejected (reject-newest)');

  // A projectile counts against the same shared cap.
  const projOverflow = reg.create('projectile', {
    origin: [0, 0, 0], dir: [0, 0, 1], chargeRatio: 0.5,
    payload: { type: 'light', params: {} },
  }, {});
  check(projOverflow === null, 'projectile creation should also be rejected when the shared cap is full');

  // Freeing one slot should allow a new one in.
  reg.destroy(created[0].id, 'test', {});
  reg.snapshot(); // consume tombstone, not required for cap logic but exercises the cycle
  const afterFree = reg.create('light', { x: 1000, y: 0, z: 0, params: {} }, {});
  check(afterFree !== null, 'creating after freeing a slot should succeed');
}

if (failed) {
  console.error('Entity registry tests FAILED.');
  process.exit(1);
} else {
  console.log('Entity registry tests passed.');
  process.exit(0);
}
