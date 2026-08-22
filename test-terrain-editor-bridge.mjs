// Checks for the Base Game <-> embedded v5 editor message bridge with fake windows.
// Run: node test-terrain-editor-bridge.mjs
import { createBridgeHost, createBridgeEditor, validateBridgeMessage, MSG, BridgeError, isEmbedded } from './terrain-editor-bridge.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

// Minimal window fake: an event target plus a postMessage that delivers to a peer
// as a 'message' event carrying origin + source.
function fakeWindow(name) {
  const listeners = new Set();
  const w = {
    name, origin: 'http://127.0.0.1:8080', peer: null, sent: [],
    addEventListener(type, fn) { if (type === 'message') listeners.add(fn); },
    removeEventListener(type, fn) { listeners.delete(fn); },
    dispatch(event) { for (const fn of [...listeners]) fn(event); },
    // Real semantics: target.postMessage(data) fires 'message' ON the target with source = the caller.
    postMessage(data, targetOrigin) {
      w.sent.push({ data, targetOrigin });
      w.dispatch({ data, origin: w.peer ? w.peer.origin : w.origin, source: w.peer });
    },
  };
  return w;
}
const ORIGIN = 'http://127.0.0.1:8080';
function pair() {
  const host = fakeWindow('host'), editor = fakeWindow('editor');
  host.peer = editor;
  editor.peer = host;
  return { host, editor };
}

console.log('\n[1] message validation');
{
  ok(validateBridgeMessage({ type: 'other:thing' }, 'toHost') === null, 'unrelated message ignored (null)');
  ok(validateBridgeMessage('nope', 'toHost') === null, 'non-object ignored');
  let e = null; try { validateBridgeMessage({ type: MSG.LOAD_PROJECT, requestId: 'r', project: {} }, 'toHost'); } catch (x) { e = x; }
  ok(e instanceof BridgeError, 'host-bound load-project rejected (wrong direction)');
  e = null; try { validateBridgeMessage({ type: MSG.APPLY_PROJECT, project: {} }, 'toHost'); } catch (x) { e = x; }
  ok(e instanceof BridgeError, 'apply without requestId rejected');
  e = null; try { validateBridgeMessage({ type: MSG.APPLY_PROJECT, requestId: 'r' }, 'toHost'); } catch (x) { e = x; }
  ok(e instanceof BridgeError, 'apply without project rejected');
  ok(validateBridgeMessage({ type: MSG.READY }, 'toHost').type === MSG.READY, 'ready needs no requestId');
}

console.log('\n[2] happy path: load -> ready -> apply -> close');
{
  const { host, editor } = pair();
  const got = {};
  const h = createBridgeHost({
    editorWindow: editor, origin: ORIGIN, listenOn: host,
    onReady: () => { got.ready = true; },
    onApply: (p, id) => { got.apply = { p, id }; },
    onClose: (id) => { got.close = id; },
    onError: (err) => { got.error = err; },
  });
  const ed = createBridgeEditor({
    hostWindow: host, origin: ORIGIN, listenOn: editor,
    onLoadProject: (p, id) => { got.load = { p, id }; },
  });
  ed.ready();
  ok(got.ready === true && h.ready === true, 'ready reached host');
  const id = h.loadProject({ cfg: { seed: 7 } });
  ok(got.load && got.load.id === id && got.load.p.cfg.seed === 7, 'editor received the project with the request id');
  ok(host.sent[0].targetOrigin === ORIGIN, 'host posts to the exact origin');
  ed.applyProject({ cfg: { seed: 8 } });
  ok(got.apply && got.apply.id === id && got.apply.p.cfg.seed === 8, 'host received apply with matching request id');
  ed.close();
  ok(got.close === id, 'host received close');
  ok(!got.error, 'no bridge errors');
  h.dispose(); ed.dispose();
  host.dispatch({ data: { type: MSG.CLOSE, requestId: id }, origin: ORIGIN, source: editor });
  ok(got.close === id, 'disposed host ignores further messages');
}

console.log('\n[3] cross-origin, wrong-source, stale and malformed messages are rejected');
{
  const { host, editor } = pair();
  const got = { errors: [] };
  const h = createBridgeHost({
    editorWindow: editor, origin: ORIGIN, listenOn: host,
    onApply: (p, id) => { got.apply = id; },
    onClose: (id) => { got.close = id; },
    onError: (err) => { got.errors.push(err.message); },
  });
  const id = h.loadProject({ cfg: {} });
  host.dispatch({ data: { type: MSG.APPLY_PROJECT, requestId: id, project: {} }, origin: 'https://evil.example', source: editor });
  ok(!got.apply, 'cross-origin apply ignored');
  host.dispatch({ data: { type: MSG.APPLY_PROJECT, requestId: id, project: {} }, origin: ORIGIN, source: fakeWindow('other') });
  ok(!got.apply, 'same-origin but foreign window ignored');
  host.dispatch({ data: { type: MSG.APPLY_PROJECT, requestId: 'old-id', project: {} }, origin: ORIGIN, source: editor });
  ok(!got.apply && got.errors.some(m => m.includes('stale requestId')), 'stale requestId rejected with error');
  host.dispatch({ data: { type: MSG.APPLY_PROJECT, requestId: id }, origin: ORIGIN, source: editor });
  ok(!got.apply && got.errors.some(m => m.includes('needs a project')), 'malformed apply rejected with error');
  host.dispatch({ data: { type: MSG.CLOSE, requestId: id }, origin: ORIGIN, source: editor });
  ok(got.close === id, 'valid close after rejections still works');
  // a second loadProject invalidates the first id
  const id2 = h.loadProject({ cfg: {} });
  host.dispatch({ data: { type: MSG.APPLY_PROJECT, requestId: id, project: {} }, origin: ORIGIN, source: editor });
  ok(!got.apply, 'previous request id is stale after a new load');
  host.dispatch({ data: { type: MSG.APPLY_PROJECT, requestId: id2, project: {} }, origin: ORIGIN, source: editor });
  ok(got.apply === id2, 'current request id accepted');
  h.dispose();
}

console.log('\n[4] editor side guards');
{
  const { host, editor } = pair();
  const got = { errors: [] };
  const ed = createBridgeEditor({ hostWindow: host, origin: ORIGIN, listenOn: editor, onLoadProject: (p, id) => { got.load = id; }, onError: (e) => got.errors.push(e.message) });
  let e = null; try { ed.applyProject({}); } catch (x) { e = x; }
  ok(e instanceof BridgeError, 'apply before any load throws');
  editor.dispatch({ data: { type: MSG.LOAD_PROJECT, requestId: 'x', project: {} }, origin: 'https://evil.example', source: host });
  ok(!got.load, 'cross-origin load ignored');
  editor.dispatch({ data: { type: MSG.LOAD_PROJECT, requestId: 'x' }, origin: ORIGIN, source: host });
  ok(!got.load && got.errors.length === 1, 'load without project rejected');
  editor.dispatch({ data: { type: MSG.LOAD_PROJECT, requestId: 'n', project: null }, origin: ORIGIN, source: host });
  ok(got.load === 'n' && ed.currentRequestId === 'n', 'load with project: null opens a session');
  editor.dispatch({ data: { type: MSG.LOAD_PROJECT, requestId: 'x', project: {} }, origin: ORIGIN, source: host });
  ok(got.load === 'x' && ed.currentRequestId === 'x', 'valid load accepted');
  ed.dispose();
}

console.log('\n[5] isEmbedded');
{
  const top = { location: { origin: ORIGIN } }; top.parent = top;
  ok(isEmbedded(top) === false, 'top-level window is not embedded');
  const child = { location: { origin: ORIGIN }, parent: { location: { origin: ORIGIN } } };
  ok(isEmbedded(child) === true, 'same-origin child is embedded');
  const foreign = { location: { origin: ORIGIN }, parent: { get location() { throw new Error('cross-origin'); } } };
  ok(isEmbedded(foreign) === false, 'cross-origin parent is not embedded');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
