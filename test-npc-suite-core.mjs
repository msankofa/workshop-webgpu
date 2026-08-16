// Node test for the GPU-free suite core (npc-suite-core.js): change-bus split, undo stack, tracked
// teardown (A2), and mode-switch motion ownership (P3). Run: node test-npc-suite-core.mjs
import { createChangeBus, createUndoStack, createTrackedScope, createModeManager } from './npc-suite-core.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  FAIL:', m); } };
const asyncMain = async () => {

// --- change bus: kinds are isolated; 'any' sees everything ---
{
  const bus = createChangeBus();
  let geo = 0, mat = 0, anyN = 0, lastKind = null;
  bus.on('geometry', () => geo++);
  bus.on('material', () => mat++);
  bus.on('any', (kind) => { anyN++; lastKind = kind; });
  bus.emit('material', {});
  ok(mat === 1 && geo === 0, 'a material change does not wake a geometry subscriber (A5)');
  ok(anyN === 1 && lastKind === 'material', "'any' sees the material change with its kind");
  bus.emit('geometry', {});
  ok(geo === 1 && mat === 1 && anyN === 2, 'geometry change routes only to geometry + any');
  let threw = false; try { bus.emit('bogus', {}); } catch { threw = true; }
  ok(threw, 'emitting an unknown kind throws rather than silently no-op');
}

// --- undo stack: linear history, redo cleared by a new edit ---
{
  const u = createUndoStack();
  u.init({ v: 0 });
  ok(!u.canUndo() && !u.canRedo(), 'fresh stack has no history');
  u.push({ v: 1 }); u.push({ v: 2 });
  ok(u.current().v === 2 && u.canUndo(), 'current tracks the latest pushed state');
  ok(u.undo().v === 1, 'undo returns the previous state');
  ok(u.redo().v === 2, 'redo returns forward');
  u.undo();                       // back to v:1, future = [v:2]
  u.push({ v: 9 });               // a new edit must clear the redo future
  ok(!u.canRedo(), 'a new edit clears the redo future');
  const snap = u.current(); snap.v = 777;
  ok(u.current().v === 9, 'current() returns a clone — mutating it cannot corrupt history');
}

// --- tracked scope: releaseAll drops every registered resource exactly once (A2) ---
{
  const removed = [], released = [], cleared = [];
  const fakeTarget = { added: [], addEventListener(e, f) { this.added.push([e, f]); }, removeEventListener(e, f) { removed.push([e, f]); } };
  const scope = createTrackedScope({
    onReleaseObject: (o) => released.push(o),
    addEventListener: (t, e, f) => t.addEventListener(e, f),
    removeEventListener: (t, e, f) => t.removeEventListener(e, f),
    setTimer: () => 'timer-id',
    clearTimer: (id) => cleared.push(id),
  });
  scope.addListener(fakeTarget, 'click', () => {});
  const obj = scope.add({ name: 'mesh' });
  scope.addTimer(() => {}, 100);
  ok(JSON.stringify(scope.counts()) === JSON.stringify({ listeners: 1, objects: 1, timers: 1 }), 'scope counts every registered resource');
  scope.releaseAll();
  ok(removed.length === 1 && released[0] === obj && cleared[0] === 'timer-id', 'releaseAll removes listener, releases object, clears timer');
  ok(JSON.stringify(scope.counts()) === JSON.stringify({ listeners: 0, objects: 0, timers: 0 }), 'scope is empty after release');
}

// --- mode manager: switch tears down the old scope before building the new; motion ownership ---
{
  const events = [];
  const scopes = [];
  const mgr = createModeManager({
    makeContext: (name) => {
      const scope = createTrackedScope({ onReleaseObject: () => events.push(`release:${name}`) });
      scope.add({});                       // each mode leaves one tracked object behind
      scopes.push({ name, scope });
      return { ctx: { name, scope }, scope };
    },
  });
  mgr.register('design', (ctx) => ({ drivesMotion: false, init() { events.push(`init:${ctx.name}`); }, dispose() { events.push(`dispose:${ctx.name}`); } }));
  mgr.register('ragdoll', (ctx) => ({ drivesMotion: true, tick() {}, init() { events.push(`init:${ctx.name}`); }, dispose() { events.push(`dispose:${ctx.name}`); } }));

  await mgr.switchTo('design');
  ok(mgr.activeName() === 'design' && mgr.drivesMotion() === false, 'design mode active, does not own motion');
  await mgr.switchTo('ragdoll');
  ok(events.indexOf('dispose:design') < events.indexOf('init:ragdoll'), 'old mode disposed before new mode inits');
  ok(events.includes('release:design'), "old mode's tracked objects were auto-released on switch (A2)");
  ok(mgr.drivesMotion() === true, 'ragdoll mode owns motion (P3)');
  await mgr.switchTo('ragdoll');
  ok(!events.includes('dispose:ragdoll'), 're-selecting the active mode is a no-op (no teardown churn)');

  let threw = false; try { await mgr.switchTo('nope'); } catch { threw = true; }
  ok(threw, 'switching to an unregistered mode throws');
}

// --- mode manager: a failing init releases the scope so a broken mode cannot leak ---
{
  const released = [];
  const mgr = createModeManager({
    makeContext: () => { const scope = createTrackedScope({ onReleaseObject: () => released.push(1) }); scope.add({}); return { ctx: { scope }, scope }; },
    onError: () => null,
  });
  mgr.register('broken', () => ({ init() { throw new Error('boom'); } }));
  const r = await mgr.switchTo('broken');
  ok(r === null && released.length === 1, 'a mode whose init throws has its scope released and does not become active');
  ok(mgr.activeName() === null, 'no active mode after a failed switch');
}

console.log(`npc-suite-core: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
};
asyncMain();
