// Runs in Node.js. Tests the slot-pool diffing logic in light-entity-renderer.js
// against a stub clusteredLights that records calls instead of touching a GPU buffer.
import { createLightEntityRenderer } from './light-entity-renderer.js';

function makeStubClusteredLights() {
  const setCalls = [];
  const clearCalls = [];
  return {
    setLightDirect(i, params) { setCalls.push({ i, params }); },
    clearLight(i) { clearCalls.push(i); },
    setCalls,
    clearCalls,
  };
}

function entity(id, overrides = {}) {
  return {
    id,
    type: 'light',
    p: [1, 2, 3],
    color: [1, 0.5, 0.25],
    radius: 20,
    intensity: 40,
    lifespan: 5,
    totalLife: 5,
    ownerId: 'host',
    ...overrides,
  };
}

const FIRST_SLOT = 223;
const MAX_SLOTS = 33;

// --- Test 1: new ids get distinct slots in [223, 256) ---
{
  const stub = makeStubClusteredLights();
  const binder = createLightEntityRenderer({ clusteredLights: stub, firstSlot: FIRST_SLOT, maxSlots: MAX_SLOTS });

  binder.sync([entity('light-1'), entity('light-2'), entity('light-3')]);

  console.assert(stub.setCalls.length === 3, `FAIL: expected 3 setLightDirect calls, got ${stub.setCalls.length}`);
  const slots = stub.setCalls.map(c => c.i);
  console.assert(new Set(slots).size === 3, 'FAIL: slots should be distinct');
  for (const s of slots) {
    console.assert(s >= FIRST_SLOT && s < FIRST_SLOT + MAX_SLOTS, `FAIL: slot ${s} out of range`);
  }
  console.log('Test 1 passed: new ids get distinct slots in range.');
}

// --- Test 2: updating same id reuses its slot ---
{
  const stub = makeStubClusteredLights();
  const binder = createLightEntityRenderer({ clusteredLights: stub, firstSlot: FIRST_SLOT, maxSlots: MAX_SLOTS });

  binder.sync([entity('light-1')]);
  const firstSlotUsed = stub.setCalls[0].i;

  binder.sync([entity('light-1', { p: [9, 9, 9] })]);
  const secondCall = stub.setCalls[stub.setCalls.length - 1];

  console.assert(secondCall.i === firstSlotUsed, `FAIL: expected slot reuse ${firstSlotUsed}, got ${secondCall.i}`);
  console.assert(secondCall.params.x === 9, 'FAIL: updated position should be written');
  console.log('Test 2 passed: updating same id reuses its slot.');
}

// --- Test 3: vanished id triggers clearLight + slot reuse by a later id ---
{
  const stub = makeStubClusteredLights();
  const binder = createLightEntityRenderer({ clusteredLights: stub, firstSlot: FIRST_SLOT, maxSlots: MAX_SLOTS });

  binder.sync([entity('light-1')]);
  const slotUsed = stub.setCalls[0].i;

  // light-1 vanishes
  binder.sync([]);
  console.assert(stub.clearCalls.includes(slotUsed), `FAIL: expected clearLight(${slotUsed})`);

  // a new light should be able to reuse that freed slot
  binder.sync([entity('light-2')]);
  const reusedCall = stub.setCalls[stub.setCalls.length - 1];
  console.assert(reusedCall.i === slotUsed, `FAIL: expected freed slot ${slotUsed} reused, got ${reusedCall.i}`);
  console.log('Test 3 passed: vanished id clears + frees slot for reuse.');
}

// --- Test 4: pool exhaustion (34th entity) is skipped, not crashed, no eviction ---
{
  const stub = makeStubClusteredLights();
  const binder = createLightEntityRenderer({ clusteredLights: stub, firstSlot: FIRST_SLOT, maxSlots: MAX_SLOTS });

  const entities = [];
  for (let i = 0; i < MAX_SLOTS; i++) entities.push(entity(`light-${i}`));
  binder.sync(entities);
  console.assert(stub.setCalls.length === MAX_SLOTS, `FAIL: expected ${MAX_SLOTS} initial writes, got ${stub.setCalls.length}`);

  // Add a 34th entity alongside all existing ones — should not throw, should not evict.
  const overflowEntities = [...entities, entity('light-overflow')];
  let threw = false;
  try {
    binder.sync(overflowEntities);
  } catch (e) {
    threw = true;
  }
  console.assert(!threw, 'FAIL: pool exhaustion should not crash sync()');

  // None of the original 33 ids should have been cleared (no eviction).
  console.assert(stub.clearCalls.length === 0, `FAIL: expected no clearLight calls on overflow, got ${stub.clearCalls.length}`);

  console.log('Test 4 passed: pool exhaustion skips newest without crashing or evicting.');
}

// --- Test 5: dispose clears everything ---
{
  const stub = makeStubClusteredLights();
  const binder = createLightEntityRenderer({ clusteredLights: stub, firstSlot: FIRST_SLOT, maxSlots: MAX_SLOTS });

  binder.sync([entity('light-1'), entity('light-2'), entity('light-3')]);
  const usedSlots = stub.setCalls.map(c => c.i);

  binder.dispose();

  for (const s of usedSlots) {
    console.assert(stub.clearCalls.includes(s), `FAIL: dispose should clear slot ${s}`);
  }
  console.log('Test 5 passed: dispose clears all active slots.');
}

console.log('All light-entity-renderer tests passed.');
