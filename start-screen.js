import { RELAY_URL } from './multiplayer.js';

export async function showStartScreen() {
  const config = await fetch('maps/map-config.json')
    .then(r => r.ok ? r.json() : { maps: {} })
    .catch(() => ({ maps: {} }));

  const overlay = document.createElement('div');
  Object.assign(overlay.style, {
    position: 'fixed', inset: '0', zIndex: '1000',
    display: 'grid', placeItems: 'center',
    background: '#12161d', color: '#eef3f8',
    fontFamily: 'system-ui, sans-serif',
    padding: '32px', boxSizing: 'border-box',
  });
  document.body.appendChild(overlay);

  const { mpRole, roomCode, guestMapKey, mpWorldMode } = await _roleStep(overlay);

  let mapKey;
  if (mpRole === 'guest') {
    mapKey = guestMapKey;
  } else {
    mapKey = await _mapStep(overlay, config, mpRole, roomCode);
  }

  const { setStatus } = _loadingStep(overlay, { mapKey, mpRole, roomCode, mpWorldMode });

  return {
    mapKey,
    mpRole,
    roomCode,
    mpWorldMode,
    setStatus,
    dismiss: () => overlay.remove(),
  };
}

// ---------------------------------------------------------------------------

function _clear(overlay) {
  while (overlay.firstChild) overlay.removeChild(overlay.firstChild);
}

function _shell() {
  const el = document.createElement('div');
  Object.assign(el.style, { width: 'min(860px, 100%)', display: 'grid', gap: '18px' });
  return el;
}

function _title(text) {
  const h1 = document.createElement('h1');
  h1.textContent = text;
  Object.assign(h1.style, { margin: '0', fontSize: '28px', fontWeight: '650' });
  return h1;
}

function _mapCard(label, detail, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  Object.assign(btn.style, {
    minHeight: '92px', border: '1px solid #354050', borderRadius: '8px',
    background: '#1a2029', color: '#eef3f8', padding: '16px',
    textAlign: 'left', cursor: 'pointer', width: '100%',
  });
  btn.innerHTML = '<div style="font-weight:650;font-size:15px;margin-bottom:6px"></div><div style="font-size:12px;color:#98a5b5"></div>';
  btn.children[0].textContent = label;
  btn.children[1].textContent = detail;
  btn.addEventListener('mouseenter', () => { btn.style.borderColor = '#6aa7ff'; });
  btn.addEventListener('mouseleave', () => { btn.style.borderColor = '#354050'; });
  btn.addEventListener('click', onClick);
  return btn;
}

function _input(placeholder) {
  const el = document.createElement('input');
  Object.assign(el.style, {
    padding: '6px 8px', border: '1px solid #354050', borderRadius: '5px',
    background: '#20252d', color: '#d8dee9', fontSize: '13px',
    textTransform: 'uppercase', width: '100%', boxSizing: 'border-box',
  });
  el.placeholder = placeholder;
  el.maxLength = 6;
  el.addEventListener('input', () => { el.value = el.value.toUpperCase(); });
  return el;
}

function _actionBtn(label) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = label;
  Object.assign(btn.style, {
    padding: '6px 12px', border: '1px solid #354050', borderRadius: '5px',
    background: '#20252d', color: '#d8dee9', cursor: 'pointer', fontSize: '12px',
    alignSelf: 'flex-start',
  });
  return btn;
}

function _errorEl() {
  const el = document.createElement('div');
  Object.assign(el.style, { fontSize: '11px', color: '#e05c5c', display: 'none' });
  return el;
}

function _rolePanel(titleText, detail, inputPlaceholder, btnLabel) {
  const wrap = document.createElement('div');
  Object.assign(wrap.style, {
    border: '1px solid #354050', borderRadius: '8px',
    background: '#1a2029', padding: '16px',
    display: 'flex', flexDirection: 'column', gap: '8px',
  });
  const h = document.createElement('div');
  h.textContent = titleText;
  Object.assign(h.style, { fontWeight: '650', fontSize: '15px' });
  const d = document.createElement('div');
  d.textContent = detail;
  Object.assign(d.style, { fontSize: '12px', color: '#98a5b5' });
  const inp = _input(inputPlaceholder);
  const err = _errorEl();
  const btn = _actionBtn(btnLabel);
  wrap.append(h, d, inp, err, btn);
  return { wrap, inp, err, btn };
}

// ---------------------------------------------------------------------------

async function _roleStep(overlay) {
  return new Promise(resolve => {
    _clear(overlay);
    const s = _shell();
    s.appendChild(_title('Creature Workshop'));

    const grid = document.createElement('div');
    Object.assign(grid.style, {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
      gap: '10px',
    });

    // Solo
    grid.appendChild(_mapCard('Solo', 'Play alone, choose your own map', () => {
      resolve({ mpRole: 'solo', roomCode: null, guestMapKey: null, mpWorldMode: 'independent' });
    }));

    // Host
    const { wrap: hw, inp: hi, err: he, btn: hb } = _rolePanel(
      'Host', 'Create a room, then choose your map', 'Room code (e.g. WOLF)', 'Host →'
    );
    const modeLabel = document.createElement('label');
    Object.assign(modeLabel.style, { display: 'grid', gap: '4px', fontSize: '11px', color: '#98a5b5' });
    modeLabel.textContent = 'World settings';
    const modeSelect = document.createElement('select');
    Object.assign(modeSelect.style, {
      padding: '6px 8px', border: '1px solid #354050', borderRadius: '5px',
      background: '#20252d', color: '#d8dee9', fontSize: '12px',
    });
    for (const [value, label] of [['shared', 'Shared with guests'], ['independent', 'Independent per player']]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      modeSelect.appendChild(opt);
    }
    modeLabel.appendChild(modeSelect);
    hw.insertBefore(modeLabel, hb);

    hb.addEventListener('click', () => {
      const code = hi.value.trim().toUpperCase();
      if (!code) { he.textContent = 'Enter a room code'; he.style.display = ''; return; }
      he.style.display = 'none';
      resolve({ mpRole: 'host', roomCode: code, guestMapKey: null, mpWorldMode: modeSelect.value });
    });
    grid.appendChild(hw);

    // Join
    const { wrap: jw, inp: ji, err: je, btn: jb } = _rolePanel(
      'Join', "Enter a host's code — their map loads automatically", 'Enter room code', 'Join →'
    );
    jb.addEventListener('click', async () => {
      const code = ji.value.trim().toUpperCase();
      if (!code) { je.textContent = 'Enter a room code'; je.style.display = ''; return; }
      je.style.display = 'none';
      jb.disabled = true;
      jb.textContent = 'Checking…';
      try {
        const { hasHost, mapKey, worldMode } = await _queryRoom(code);
        if (!hasHost) {
          je.textContent = 'No active room with that code';
          je.style.display = '';
          jb.disabled = false;
          jb.textContent = 'Join →';
          return;
        }
        resolve({ mpRole: 'guest', roomCode: code, guestMapKey: mapKey, mpWorldMode: worldMode || 'shared' });
      } catch {
        je.textContent = 'Could not connect to relay server';
        je.style.display = '';
        jb.disabled = false;
        jb.textContent = 'Join →';
      }
    });
    grid.appendChild(jw);

    s.appendChild(grid);
    overlay.appendChild(s);
  });
}

async function _queryRoom(code) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(RELAY_URL);
    const t = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'query', room: code }));
    ws.onmessage = ev => {
      clearTimeout(t);
      ws.close();
      const msg = JSON.parse(ev.data);
      resolve({ hasHost: msg.hasHost, mapKey: msg.mapKey, worldMode: msg.worldMode });
    };
    ws.onerror = () => { clearTimeout(t); ws.close(); reject(new Error('connection failed')); };
  });
}

async function _mapStep(overlay, config, mpRole, roomCode) {
  return new Promise(resolve => {
    _clear(overlay);
    const s = _shell();
    const header = mpRole === 'host' ? `Host · ${roomCode}` : 'Choose Map';
    s.appendChild(_title(header));

    const grid = document.createElement('div');
    Object.assign(grid.style, {
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
      gap: '10px',
    });

    grid.appendChild(_mapCard('Infinite World', 'Procedural terrain, grass, and GPU forest', () => resolve(null)));

    const maps = config.maps || {};
    for (const [key, meta] of Object.entries(maps)) {
      if (meta && meta.playable === false) continue;
      grid.appendChild(_mapCard(
        meta?.displayName || key,
        'Authored terrain with runtime GPU trees',
        () => resolve(key)
      ));
    }

    s.appendChild(grid);
    overlay.appendChild(s);
  });
}

function _loadingStep(overlay, { mapKey, mpRole, roomCode, mpWorldMode }) {
  _clear(overlay);
  const s = _shell();

  const parts = [mapKey || 'Infinite World'];
  if (mpRole === 'host') parts.push(`Host · ${roomCode}`);
  if (mpRole === 'guest') parts.push(`Guest · ${roomCode}`);
  if (mpRole === 'host' && mpWorldMode === 'shared') parts.push('Shared settings');
  if (mpRole === 'host' && mpWorldMode === 'independent') parts.push('Independent settings');
  s.appendChild(_title(parts.join(' · ')));

  const statusEl = document.createElement('div');
  Object.assign(statusEl.style, { fontSize: '13px', color: '#98a5b5', marginTop: '8px' });
  statusEl.textContent = 'Initializing…';
  s.appendChild(statusEl);

  overlay.appendChild(s);
  return { setStatus: msg => { statusEl.textContent = msg; } };
}
