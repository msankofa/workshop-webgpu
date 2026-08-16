// npc-suite-core.js
//
// GPU-free scaffolding for the NPC design suite shell (docs/subsystems/npc-suite.md). No THREE
// import, so the load-bearing logic — mode teardown, undo, the split change bus, motion ownership —
// is unit-testable in Node (test-npc-suite-core.mjs). The shell (npc-suite-shell.js) wires these to
// a real renderer, one persistent NPC, and the injected geometry cache + batch pool from P1/P1b.

// Design edits flow through the shell's one chokepoint (applyDesignChange) and fan out on this bus,
// split so a colour tweak (material) doesn't wake a subscriber that only cares about geometry (A5).
export const CHANGE_KINDS = Object.freeze(['geometry', 'material', 'gait']);

export function createChangeBus() {
  const subs = { geometry: new Set(), material: new Set(), gait: new Set() };
  const any = new Set();
  return {
    // on('geometry'|'material'|'gait', fn) or on('any', fn). Returns an unsubscribe fn.
    on(kind, fn) {
      const set = kind === 'any' ? any : subs[kind];
      if (!set) throw new Error(`unknown change kind: ${kind}`);
      set.add(fn);
      return () => set.delete(fn);
    },
    emit(kind, payload) {
      if (!subs[kind]) throw new Error(`unknown change kind: ${kind}`);
      for (const fn of subs[kind]) fn(payload);
      for (const fn of any) fn(kind, payload);
    },
  };
}

// One undo stack over design snapshots, owned by the shell so it spans every mode (A9). The shell's
// applyDesignChange is the sole writer, so recording here can never miss an edit or double-count one.
export function createUndoStack({ clone = (x) => structuredClone(x), limit = 100 } = {}) {
  let past = [], present = null, future = [];
  return {
    init(state) { present = state == null ? null : clone(state); past = []; future = []; },
    // Call AFTER present has been advanced by an edit; pushes the prior state onto the past.
    push(state) {
      if (present !== null) past.push(present);
      present = clone(state);
      future = [];
      if (past.length > limit) past.shift();
    },
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    undo() { if (!past.length) return null; future.push(present); present = past.pop(); return clone(present); },
    redo() { if (!future.length) return null; past.push(present); present = future.pop(); return clone(present); },
    current: () => (present === null ? null : clone(present)),
  };
}

// A tracked resource scope handed to each mode as part of ctx. Modes register listeners, scene
// objects and timers THROUGH it; the shell releases everything on unmount (A2), so a mode that
// forgets a cleanup cannot leak a listener or an orphaned Object3D into the next mode. GPU-free:
// object removal is delegated to onReleaseObject so the shell decides how to detach from the scene.
// The event/timer hooks default to the DOM/global ones but are injectable for tests.
export function createTrackedScope({
  onReleaseObject = () => {},
  addEventListener = (t, e, f, o) => t.addEventListener(e, f, o),
  removeEventListener = (t, e, f, o) => t.removeEventListener(e, f, o),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
} = {}) {
  const listeners = [], objects = [], timers = [];
  return {
    addListener(target, ev, fn, opts) {
      addEventListener(target, ev, fn, opts);
      listeners.push({ target, ev, fn, opts });
      return fn;
    },
    add(obj) { objects.push(obj); return obj; },
    addTimer(fn, ms) { const id = setTimer(fn, ms); timers.push(id); return id; },
    counts: () => ({ listeners: listeners.length, objects: objects.length, timers: timers.length }),
    releaseAll() {
      for (const { target, ev, fn, opts } of listeners) removeEventListener(target, ev, fn, opts);
      for (const obj of objects) onReleaseObject(obj);
      for (const id of timers) clearTimer(id);
      listeners.length = 0; objects.length = 0; timers.length = 0;
    },
  };
}

// Mode registry + switch. On switch it disposes the old mode and releases its scope BEFORE building
// the new one, so two modes' resources never coexist. Motion ownership (P3) is a read here: only the
// active mode may drive the NPC, and only if it declared drivesMotion — the shell's loop consults
// drivesMotion() before letting tick() move the NPC.
export function createModeManager({ makeContext, onError = (e) => { throw e; } }) {
  const modes = new Map();
  let activeName = null, active = null, activeScope = null;

  async function teardownActive() {
    if (!active) return;
    try { await active.dispose?.(); } finally { activeScope?.releaseAll(); }
    active = null; activeScope = null; activeName = null;
  }

  return {
    register(name, factory) { modes.set(name, factory); return this; },
    has: (name) => modes.has(name),
    names: () => [...modes.keys()],
    activeName: () => activeName,
    current: () => active,
    drivesMotion: () => !!(active && active.drivesMotion),
    async switchTo(name) {
      if (!modes.has(name)) throw new Error(`unknown mode: ${name}`);
      if (name === activeName) return active;
      await teardownActive();
      const { ctx, scope } = makeContext(name);
      try {
        const mode = modes.get(name)(ctx);
        await mode.init?.();
        active = mode; activeScope = scope; activeName = name;
        return active;
      } catch (e) {
        scope.releaseAll();
        return onError(e);
      }
    },
    tick(dt) { active?.tick?.(dt); },
    async dispose() { await teardownActive(); },
  };
}
