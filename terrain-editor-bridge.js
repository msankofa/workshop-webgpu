// terrain-editor-bridge.js — same-origin postMessage bridge between Base Game
// (host) and an embedded terrain-generator-v5.html (editor). Pure: takes window-
// like objects so it runs under Node with fakes. Both sides check origin, source
// window, message shape and requestId; the host re-normalizes any project it
// receives — the editor is never an authority boundary.

export const BRIDGE_PREFIX = 'terrain-v5:';
export const MSG = Object.freeze({
  LOAD_PROJECT: `${BRIDGE_PREFIX}load-project`,   // host -> editor
  READY: `${BRIDGE_PREFIX}ready`,                 // editor -> host
  APPLY_PROJECT: `${BRIDGE_PREFIX}apply-project`, // editor -> host
  CLOSE: `${BRIDGE_PREFIX}close`,                 // editor -> host
});
const EDITOR_TO_HOST = new Set([MSG.READY, MSG.APPLY_PROJECT, MSG.CLOSE]);
const HOST_TO_EDITOR = new Set([MSG.LOAD_PROJECT]);

export class BridgeError extends Error {
  constructor(message) { super(message); this.name = 'BridgeError'; }
}

// Shape check only; project content is validated by terrain-project-v5.js on the host.
export function validateBridgeMessage(data, direction) {
  if (!data || typeof data !== 'object' || typeof data.type !== 'string') return null;
  if (!data.type.startsWith(BRIDGE_PREFIX)) return null;
  const allowed = direction === 'toHost' ? EDITOR_TO_HOST : HOST_TO_EDITOR;
  if (!allowed.has(data.type)) throw new BridgeError(`unexpected message ${data.type} for direction ${direction}`);
  if (data.type !== MSG.READY && (typeof data.requestId !== 'string' || !data.requestId)) throw new BridgeError(`${data.type} needs a requestId`);
  // load-project may carry project: null ("keep your current project, start a session").
  if (data.type === MSG.APPLY_PROJECT && (!data.project || typeof data.project !== 'object')) throw new BridgeError(`${data.type} needs a project object`);
  if (data.type === MSG.LOAD_PROJECT && data.project !== null && (!data.project || typeof data.project !== 'object')) throw new BridgeError(`${data.type} needs a project object or null`);
  return data;
}

function guard(event, expectedOrigin, expectedSource) {
  if (event.origin !== expectedOrigin) return false;
  if (expectedSource && event.source !== expectedSource) return false;
  return true;
}

// Base Game side. `editorWindow` is the iframe's contentWindow; `listenOn` is the
// host window (addEventListener/removeEventListener). Ignores messages from any
// other origin or window; malformed ones are reported through onError.
export function createBridgeHost({ editorWindow, origin, listenOn, onReady, onApply, onClose, onError, nextId }) {
  if (!editorWindow || !origin || !listenOn) throw new BridgeError('editorWindow, origin and listenOn are required');
  let counter = 0;
  let currentRequestId = null;
  let ready = false;
  const makeId = nextId || (() => `req-${++counter}`);

  const handler = (event) => {
    if (!guard(event, origin, editorWindow)) return;
    let msg;
    try { msg = validateBridgeMessage(event.data, 'toHost'); } catch (err) { onError && onError(err); return; }
    if (!msg) return;
    if (msg.type === MSG.READY) { ready = true; onReady && onReady(); return; }
    if (msg.requestId !== currentRequestId) { onError && onError(new BridgeError(`stale requestId ${msg.requestId}`)); return; }
    if (msg.type === MSG.APPLY_PROJECT) onApply && onApply(msg.project, msg.requestId);
    else if (msg.type === MSG.CLOSE) onClose && onClose(msg.requestId);
  };
  listenOn.addEventListener('message', handler);

  return {
    get ready() { return ready; },
    get currentRequestId() { return currentRequestId; },
    loadProject(project) {
      currentRequestId = makeId();
      editorWindow.postMessage({ type: MSG.LOAD_PROJECT, requestId: currentRequestId, project }, origin);
      return currentRequestId;
    },
    dispose() { listenOn.removeEventListener('message', handler); currentRequestId = null; },
  };
}

// Editor side. `hostWindow` is window.parent; replies go only to that window/origin.
// `onLoadProject(project, requestId)` is the editor's load hook.
export function createBridgeEditor({ hostWindow, origin, listenOn, onLoadProject, onError }) {
  if (!hostWindow || !origin || !listenOn) throw new BridgeError('hostWindow, origin and listenOn are required');
  let currentRequestId = null;

  const handler = (event) => {
    if (!guard(event, origin, hostWindow)) return;
    let msg;
    try { msg = validateBridgeMessage(event.data, 'toEditor'); } catch (err) { onError && onError(err); return; }
    if (!msg) return;
    currentRequestId = msg.requestId;
    onLoadProject && onLoadProject(msg.project, msg.requestId);
  };
  listenOn.addEventListener('message', handler);

  const send = (payload) => hostWindow.postMessage(payload, origin);
  return {
    get currentRequestId() { return currentRequestId; },
    ready() { send({ type: MSG.READY }); },
    applyProject(project) {
      if (!currentRequestId) throw new BridgeError('no active host request to apply against');
      send({ type: MSG.APPLY_PROJECT, requestId: currentRequestId, project });
    },
    close() {
      if (!currentRequestId) throw new BridgeError('no active host request to close');
      send({ type: MSG.CLOSE, requestId: currentRequestId });
    },
    dispose() { listenOn.removeEventListener('message', handler); currentRequestId = null; },
  };
}

// True when this page is framed by a same-origin host (editor decides embedded mode).
export function isEmbedded(win) {
  try { return !!win && win.parent && win.parent !== win && win.location.origin === win.parent.location.origin; }
  catch { return false; }
}
