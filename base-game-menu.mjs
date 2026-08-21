import { normalizeBaseGameRoomCode } from './base-game-protocol.mjs';

function installStyles() {
  if (document.getElementById('base-game-menu-styles')) return;
  const style = document.createElement('style');
  style.id = 'base-game-menu-styles';
  style.textContent = `
    .bgm-overlay { position:fixed; inset:0; z-index:1000; display:grid; place-items:center;
      padding:24px; box-sizing:border-box; background:rgba(7,12,22,.94); color:#eef4ff;
      font-family:system-ui,sans-serif; }
    .bgm-overlay.bgm-start { background:#07101e; }
    .bgm-overlay[hidden] { display:none; }
    .bgm-panel { width:min(680px,100%); padding:30px; box-sizing:border-box;
      border:1px solid rgba(159,195,255,.25); border-radius:14px;
      background:linear-gradient(180deg,rgba(23,34,53,.98),rgba(12,19,31,.98));
      box-shadow:0 24px 80px rgba(0,0,0,.5); }
    .bgm-panel h1 { margin:0 0 6px; font-size:32px; font-weight:650; letter-spacing:.02em; }
    .bgm-subtitle { margin:0 0 24px; color:#9fb0c8; }
    .bgm-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
    .bgm-card { min-height:112px; padding:15px; text-align:left; border:1px solid #344866;
      border-radius:9px; color:#e8f0fc; background:#182437; cursor:pointer; }
    .bgm-card:hover,.bgm-card:focus-visible { border-color:#7fb2ff; background:#20314a; outline:none; }
    .bgm-card.selected { border-color:#7fb2ff; box-shadow:0 0 0 1px #7fb2ff inset; }
    .bgm-card strong { display:block; margin-bottom:7px; font-size:16px; }
    .bgm-card span { color:#9fb0c8; font-size:12px; line-height:1.45; }
    .bgm-room { display:grid; grid-template-columns:1fr auto auto; gap:8px; margin-top:14px; }
    .bgm-room input { min-width:0; padding:10px 12px; border:1px solid #405675; border-radius:7px;
      background:#0e1725; color:#f2f7ff; font:14px ui-monospace,monospace; text-transform:uppercase; }
    .bgm-button { padding:10px 15px; border:1px solid #4d6f9e; border-radius:7px;
      background:#203553; color:#eef5ff; cursor:pointer; }
    .bgm-button:hover,.bgm-button:focus-visible { background:#2b4b76; outline:none; }
    .bgm-button.danger { border-color:#91545b; background:#46262c; }
    .bgm-button:disabled,.bgm-room input:disabled { opacity:.5; cursor:wait; }
    .bgm-status { min-height:20px; margin-top:12px; color:#a9bbd2; font-size:13px; }
    .bgm-status.error { color:#ffaaa9; }
    .bgm-pause-panel { width:min(360px,100%); text-align:center; }
    .bgm-pause-actions { display:grid; gap:9px; margin-top:22px; }
    .bgm-pause-actions .bgm-button { width:100%; padding:12px; font-size:15px; }
    .bgm-session-label { min-height:18px; color:#8fb9f2; font:12px ui-monospace,monospace; }
    @media(max-width:620px) { .bgm-grid { grid-template-columns:1fr; }
      .bgm-room { grid-template-columns:1fr 1fr; }.bgm-room input { grid-column:1/-1; } }
  `;
  document.head.append(style);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function showBaseGameStartMenu({ connect } = {}) {
  installStyles();
  return new Promise(resolve => {
    const overlay = el('div', 'bgm-overlay bgm-start');
    const panel = el('div', 'bgm-panel');
    panel.append(el('h1', '', 'Base Game'));
    panel.append(el('p', 'bgm-subtitle', 'A clean world foundation'));

    const grid = el('div', 'bgm-grid');
    const solo = el('button', 'bgm-card');
    solo.append(el('strong', '', 'Solo'), el('span', '', 'Run locally. Pausing stops the world clock.'));
    const create = el('button', 'bgm-card');
    create.append(el('strong', '', 'Create Room'), el('span', '', 'Create a server-owned world and administer its shared settings.'));
    const join = el('button', 'bgm-card');
    join.append(el('strong', '', 'Join Room'), el('span', '', 'Enter an existing server-owned world.'));
    grid.append(solo, create, join);
    panel.append(grid);

    const roomRow = el('div', 'bgm-room');
    const input = el('input');
    input.placeholder = 'ROOM CODE'; input.maxLength = 16; input.autocomplete = 'off';
    const createButton = el('button', 'bgm-button', 'Create');
    const joinButton = el('button', 'bgm-button', 'Join');
    roomRow.append(input, createButton, joinButton);
    panel.append(roomRow);
    const status = el('div', 'bgm-status', 'Choose Solo, or enter a room code.');
    panel.append(status);
    overlay.append(panel);
    document.body.append(overlay);

    let busy = false;
    let roomAction = 'join';
    const controls = [solo, create, join, input, createButton, joinButton];
    function setBusy(value, message) {
      busy = value;
      controls.forEach(control => { control.disabled = value; });
      status.classList.remove('error');
      status.textContent = message;
    }
    async function choose(mode) {
      if (busy) return;
      const roomCode = mode === 'solo' ? null : normalizeBaseGameRoomCode(input.value);
      if (mode !== 'solo' && !roomCode) {
        status.classList.add('error');
        status.textContent = 'Use 2-16 letters, numbers, _ or - for the room code.';
        input.focus();
        return;
      }
      setBusy(true, mode === 'solo' ? 'Starting solo world…' : `${mode === 'create' ? 'Creating' : 'Joining'} ${roomCode}…`);
      try {
        const session = mode === 'solo' ? null : await connect?.({ mode, roomCode });
        overlay.remove();
        resolve({ mode, roomCode, session });
      } catch (error) {
        setBusy(false, '');
        status.classList.add('error');
        status.textContent = error?.message || 'Could not start the session.';
      }
    }
    function selectRoomAction(mode) {
      roomAction = mode;
      create.classList.toggle('selected', mode === 'create');
      join.classList.toggle('selected', mode === 'join');
      status.textContent = mode === 'create' ? 'Enter a new room code.' : 'Enter the existing room code.';
      input.focus();
    }
    solo.addEventListener('click', () => choose('solo'));
    create.addEventListener('click', () => {
      if (normalizeBaseGameRoomCode(input.value)) choose('create');
      else selectRoomAction('create');
    });
    join.addEventListener('click', () => {
      if (normalizeBaseGameRoomCode(input.value)) choose('join');
      else selectRoomAction('join');
    });
    createButton.addEventListener('click', () => { roomAction = 'create'; choose('create'); });
    joinButton.addEventListener('click', () => { roomAction = 'join'; choose('join'); });
    input.addEventListener('keydown', event => { if (event.key === 'Enter') choose(roomAction); });
  });
}

export function createBaseGamePauseMenu({ onResume, onSettings, onMainMenu } = {}) {
  installStyles();
  const overlay = el('div', 'bgm-overlay');
  overlay.hidden = true;
  const panel = el('div', 'bgm-panel bgm-pause-panel');
  panel.append(el('h1', '', 'Paused'));
  const sessionLabel = el('div', 'bgm-session-label');
  panel.append(sessionLabel);
  const actions = el('div', 'bgm-pause-actions');
  const resume = el('button', 'bgm-button', 'Resume');
  const settings = el('button', 'bgm-button', 'Settings');
  const mainMenu = el('button', 'bgm-button danger', 'Main Menu');
  actions.append(resume, settings, mainMenu);
  panel.append(actions); overlay.append(panel); document.body.append(overlay);

  const api = {
    get open() { return !overlay.hidden; },
    show(label = '') { sessionLabel.textContent = label; overlay.hidden = false; resume.focus(); },
    hide() { overlay.hidden = true; },
    destroy() { overlay.remove(); },
  };
  resume.addEventListener('click', () => { api.hide(); onResume?.(); });
  settings.addEventListener('click', () => { api.hide(); onSettings?.(); });
  mainMenu.addEventListener('click', () => { api.hide(); onMainMenu?.(); });
  return api;
}
