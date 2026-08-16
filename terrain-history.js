// Full-state snapshot undo/redo for terrain-generator-v5 (the ZyFou ProjectHistoryManager
// shape: a capped stack of deep-cloned states, cursor moves on undo/redo, redo tail is cut
// on a new record). `getState()` must return JSON-safe data; `restoreState(state)` applies it.
// Pure JS, Node-testable.

export class History {
  constructor({ getState, restoreState, limit = 60 }) {
    this.getState = getState; this.restoreState = restoreState; this.limit = limit;
    this.entries = []; this.cursor = -1; this.restoring = false;
    this.listeners = new Set();
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit() { for (const fn of this.listeners) fn(this); }

  // Record the current state under `label`. Call after a change is complete (a finished
  // slider drag or a whole brush stroke), never per pointer event.
  record(label = 'edit') {
    if (this.restoring) return;
    const state = clone(this.getState());
    if (this.cursor >= 0 && sameJson(this.entries[this.cursor].state, state)) return;
    this.entries.splice(this.cursor + 1);
    this.entries.push({ label, state });
    if (this.entries.length > this.limit) this.entries.shift();
    this.cursor = this.entries.length - 1;
    this._emit();
  }

  canUndo() { return this.cursor > 0; }
  canRedo() { return this.cursor < this.entries.length - 1; }

  undo() {
    if (!this.canUndo()) return false;
    this.cursor--; this._apply(); return true;
  }
  redo() {
    if (!this.canRedo()) return false;
    this.cursor++; this._apply(); return true;
  }
  _apply() {
    this.restoring = true;
    try { this.restoreState(clone(this.entries[this.cursor].state)); }
    finally { this.restoring = false; }
    this._emit();
  }

  labels() { return this.entries.map((e, i) => ({ label: e.label, current: i === this.cursor })); }
  clear() { this.entries = []; this.cursor = -1; this._emit(); }
}

function clone(v) { return JSON.parse(JSON.stringify(v)); }
function sameJson(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
