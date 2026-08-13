// Save/load slots for the bot-viewer control panel.
//
// This module owns storage + the slot widget only. The caller owns capture()/apply(), because
// only the viewer knows how to read its own state back out and re-run the right rebuild syncers.

const STORE_PREFIX = 'pcw:bv2:slots:';
export const SLOT_COUNT = 6;

function storeOf(storage) {
  return storage || (typeof localStorage !== 'undefined' ? localStorage : null);
}

// ─── storage ────────────────────────────────────────────────────────────────
// A corrupt / quota-blocked store must never take the viewer down, so every path is try/catch'd
// and degrades to "no slots" rather than throwing into the panel build.

export function readSlots(group, storage) {
  const s = storeOf(storage);
  if (!s) return {};
  try {
    const parsed = JSON.parse(s.getItem(STORE_PREFIX + group) || 'null');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

export function writeSlots(group, slots, storage) {
  const s = storeOf(storage);
  if (!s) return false;
  try { s.setItem(STORE_PREFIX + group, JSON.stringify(slots)); return true; }
  catch { return false; }
}

export function saveSlot(group, index, name, data, storage, now) {
  const slots = readSlots(group, storage);
  const entry = { name: String(name || `slot ${index}`).slice(0, 40), savedAt: now || new Date().toISOString(), data };
  slots[String(index)] = entry;
  return writeSlots(group, slots, storage) ? entry : null;
}

export function loadSlot(group, index, storage) {
  const entry = readSlots(group, storage)[String(index)];
  return entry && entry.data ? entry : null;
}

export function deleteSlot(group, index, storage) {
  const slots = readSlots(group, storage);
  delete slots[String(index)];
  writeSlots(group, slots, storage);
  return slots;
}

// ─── state helpers ──────────────────────────────────────────────────────────

// Snapshot just `keys` off `source`, skipping anything undefined.
export function pickKeys(source, keys) {
  const out = {};
  if (!source) return out;
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

// Copy `keys` from a loaded slot onto a live settings object. Values whose type doesn't match the
// live one are dropped: a slot written before a tunable changed shape must not poison the sim.
export function assignKnown(target, source, keys) {
  if (!target || !source) return 0;
  let applied = 0;
  for (const key of (keys || Object.keys(source))) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (target[key] !== undefined && typeof value !== typeof target[key]) continue;
    target[key] = value;
    applied++;
  }
  return applied;
}

// ─── panel widget ───────────────────────────────────────────────────────────

const el = (tag, props) => Object.assign(document.createElement(tag), props || {});

function slotLabel(index, entry) {
  if (!entry) return `${index} · empty`;
  const stamp = String(entry.savedAt || '').slice(5, 16).replace('T', ' ');
  return `${index} · ${entry.name}${stamp ? ` (${stamp})` : ''}`;
}

/**
 * Build one labelled save/load row group in the viewer's own #ctrl idiom.
 * `capture()` returns a JSON-serializable snapshot; `apply(data)` puts it back and resyncs the UI.
 * Returns { nodes, refresh } -- `nodes` is spread into the panel, `refresh` re-reads storage.
 */
export function createSlotSection({ group, label, capture, apply, slots = SLOT_COUNT, storage, onSaved }) {
  const row = el('div', { className: 'row' });
  const select = el('select', { title: `${label} save slots` });
  select.style.cssText = 'flex:1;margin-left:6px';
  for (let i = 1; i <= slots; i++) select.append(el('option', { value: String(i) }));
  row.append(el('span', { textContent: label }), select);

  const nameInput = el('input', { type: 'text', placeholder: `${label} slot name`, maxLength: 40 });
  nameInput.style.cssText = 'width:100%;margin:3px 0';

  const buttons = el('div');
  buttons.style.cssText = 'display:flex;gap:4px;margin:0 0 6px';
  const saveBtn = el('button', { textContent: 'Save', title: `Write the current ${label} state into the selected slot` });
  const loadBtn = el('button', { textContent: 'Load', title: `Apply the selected ${label} slot` });
  const delBtn = el('button', { textContent: '✕', title: 'Clear the selected slot' });
  for (const btn of [saveBtn, loadBtn, delBtn]) { btn.style.margin = '0'; buttons.appendChild(btn); }
  delBtn.style.flex = '0 0 30px';

  const status = el('div');
  status.style.cssText = 'color:var(--wui-muted);font-size:11px;margin:-3px 0 6px;min-height:14px';

  let cache = readSlots(group, storage);
  function refresh(message) {
    cache = readSlots(group, storage);
    for (const option of select.options) {
      const entry = cache[option.value];
      option.textContent = slotLabel(option.value, entry);
    }
    const current = cache[select.value];
    loadBtn.disabled = !current;
    delBtn.disabled = !current;
    if (message !== undefined) status.textContent = message;
    return cache;
  }

  select.addEventListener('change', () => {
    const entry = cache[select.value];
    nameInput.value = entry ? entry.name : '';
    refresh('');
  });
  saveBtn.addEventListener('click', () => {
    let data;
    try { data = capture(); } catch (err) { refresh(`capture failed: ${err.message}`); return; }
    const entry = saveSlot(group, select.value, nameInput.value || `${label} ${select.value}`, data, storage);
    if (entry) nameInput.value = entry.name;   // an auto-named save must not leave the field blank
    refresh(entry ? `saved to slot ${select.value}` : 'save failed (storage full?)');
    // Mirroring the save elsewhere must never be able to fail the save itself.
    if (entry && onSaved) { try { onSaved(group, select.value, entry); } catch { /* ignore */ } }
  });
  loadBtn.addEventListener('click', () => {
    const entry = loadSlot(group, select.value, storage);
    if (!entry) { refresh('slot is empty'); return; }
    try { apply(entry.data); } catch (err) { refresh(`load failed: ${err.message}`); return; }
    nameInput.value = entry.name;
    refresh(`loaded "${entry.name}"`);
  });
  delBtn.addEventListener('click', () => {
    deleteSlot(group, select.value, storage);
    nameInput.value = '';
    refresh(`cleared slot ${select.value}`);
  });

  refresh('');
  const initial = cache[select.value];
  nameInput.value = initial ? initial.name : '';
  return { nodes: [row, nameInput, buttons, status], refresh };
}
