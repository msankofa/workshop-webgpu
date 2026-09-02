// wheel-menu.js — environment-viewer.html's toolRadial (:7201-7250) as a module, plus a second ring.
// A port: angle maths, 92 px radius, 14 px dead zone, button markup, click-to-commit, centre dot and
// colours are the source's. New: the outer option ring, the sublabel, and the callbacks.
const TAU = Math.PI * 2;

// The source's pick maths: wedge 0 at 12 o'clock, clockwise.
export function wedgeIndexAt(dx, dy, count) {
  if (!(count > 0)) return -1;
  const angle = Math.atan2(dy, dx) + Math.PI / 2;
  return Math.round((((angle + TAU) % TAU) / TAU) * count) % count;
}

// The source's layout maths.
export function wedgePosition(i, count, radius) {
  const a = -Math.PI / 2 + (i / Math.max(1, count)) * TAU;
  return { x: Math.cos(a) * radius, y: Math.sin(a) * radius };
}

// Inner ring picks the group; past ringThreshold the group locks and the outer ring picks the option.
export function wheelSelect(state, groups, dx, dy, { moveThreshold = 14, ringThreshold = 74 } = {}) {
  const dist = Math.hypot(dx, dy);
  const out = { groupIndex: state.groupIndex, optionIndex: state.optionIndex, locked: state.locked, dist };
  if (dist < moveThreshold) { out.locked = -1; return out; }
  const group = groups[out.groupIndex] || null;
  const options = group && group.options ? group.options : null;
  if (dist < ringThreshold || !options || !options.length) {
    out.groupIndex = wedgeIndexAt(dx, dy, groups.length);
    out.locked = -1;
    // A new group carries its own current option, not the last group's index.
    if (out.groupIndex !== state.groupIndex) out.optionIndex = groups[out.groupIndex]?.activeIndex ?? 0;
    return out;
  }
  out.locked = state.locked >= 0 ? state.locked : out.groupIndex;
  out.groupIndex = out.locked;
  const lockedOptions = groups[out.locked]?.options || [];
  if (lockedOptions.length) out.optionIndex = wedgeIndexAt(dx, dy, lockedOptions.length);
  return out;
}

function wedgeCss(x, y, on, dim) {
  const border = on ? 'rgba(255,216,120,.9)' : 'rgba(255,255,255,.2)';
  const background = on ? 'rgba(70,58,26,.92)' : 'rgba(18,22,28,.9)';
  return `position:absolute;left:calc(50% + ${x}px);top:calc(50% + ${y}px);transform:translate(-50%,-50%);`
    + `min-width:86px;padding:8px 10px;border-radius:8px;border:1px solid ${border};background:${background};`
    + `color:#d7dde7;font:12px system-ui,sans-serif;pointer-events:auto;${dim ? 'opacity:.55;' : ''}`;
}

// getGroups() -> [{ id, label, sublabel?, activeIndex?, options?: [{ id, label, sublabel? }] }]
export function createWheelMenu({
  getGroups,
  getActive = () => ({ groupId: null, optionId: null }),
  onCommit = () => {},
  onCancel = () => {},
  onOpen = () => {},
  radius = 92,
  outerRadius = 178,
  moveThreshold = 14,
  ringThreshold = 74,
  className = 'walk-ui',
  doc = typeof document !== 'undefined' ? document : null,
} = {}) {
  const root = doc ? doc.createElement('div') : null;
  if (root) {
    root.className = className;
    root.style.cssText = 'position:fixed;inset:0;z-index:70;display:none;pointer-events:none;font:12px/1.2 system-ui,sans-serif;color:#d7dde7';
    doc.body.appendChild(root);
  }

  let open = false;
  let groups = [];
  let state = { groupIndex: 0, optionIndex: 0, locked: -1, dist: 0 };
  let mx = 0, my = 0;
  const api = {};

  function currentGroup() { return groups[state.groupIndex] || null; }
  function currentOption() {
    const g = currentGroup();
    return g && g.options && g.options.length ? g.options[state.optionIndex] || null : null;
  }

  function wedge(label, sublabel, x, y, on, dim, commit) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.style.cssText = wedgeCss(x, y, on, dim);
    if (sublabel) {
      const s = doc.createElement('span');
      s.style.cssText = 'display:block;margin-top:2px;font-size:10px;opacity:.72';
      s.textContent = sublabel;
      btn.appendChild(s);
    }
    btn.addEventListener('mousedown', (e) => { e.preventDefault?.(); commit(); });
    root.appendChild(btn);
  }

  function render() {
    if (!root) return;
    root.innerHTML = '<div style="position:absolute;left:50%;top:50%;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:rgba(255,255,255,.72)"></div>';
    groups.forEach((g, i) => {
      const p = wedgePosition(i, groups.length, radius);
      const on = i === state.groupIndex;
      const sub = on && currentOption() ? currentOption().label : g.sublabel;
      wedge(g.label, sub, p.x, p.y, on, false, () => {
        state.groupIndex = i;
        state.optionIndex = g.activeIndex ?? 0;
        api.close(true);
      });
    });
    const g = currentGroup();
    const options = g && g.options ? g.options : null;
    if (options && options.length) {
      options.forEach((o, i) => {
        const p = wedgePosition(i, options.length, outerRadius);
        wedge(o.label, o.sublabel, p.x, p.y, state.locked >= 0 && i === state.optionIndex, state.locked < 0, () => {
          state.optionIndex = i;
          api.close(true);
        });
      });
    }
  }

  // defineProperties, not Object.assign: assign copies a getter's VALUE, which froze isOpen at
  // false and selection at null for the life of the wheel.
  Object.defineProperties(api, {
    isOpen: { enumerable: true, get: () => open },
    selection: {
      enumerable: true,
      get() {
        const g = currentGroup(), o = currentOption();
        return { groupId: g ? g.id : null, optionId: o ? o.id : null };
      },
    },
  });
  Object.assign(api, {
    open() {
      groups = (typeof getGroups === 'function' ? getGroups() : []) || [];
      if (!groups.length) return false;
      const active = getActive() || {};
      const gi = Math.max(0, groups.findIndex((x) => x.id === active.groupId));
      const opts = groups[gi]?.options || [];
      const oi = Math.max(0, opts.findIndex((o) => o.id === active.optionId));
      state = { groupIndex: gi, optionIndex: oi, locked: -1, dist: 0 };
      mx = 0; my = 0;
      open = true;
      if (root) root.style.display = 'block';
      render();
      onOpen();
      return true;
    },
    // Deltas, not a position: the page is in pointer lock.
    handleMouseMove(event) {
      if (!open) return;
      mx += event.movementX || 0;
      my += event.movementY || 0;
      const next = wheelSelect(state, groups, mx, my, { moveThreshold, ringThreshold });
      const changed = next.groupIndex !== state.groupIndex || next.optionIndex !== state.optionIndex || next.locked !== state.locked;
      state = next;
      if (changed) render();
    },
    close(commit = true) {
      if (!open) return;
      open = false;
      if (root) root.style.display = 'none';
      if (commit) onCommit(api.selection); else onCancel();
    },
    destroy() { root?.remove?.(); },
  });
  return api;
}
