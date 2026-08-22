// Checks for Base Game's terrain project store (draft vs active, Apply transaction,
// state round-trip) and the Terrain Studio overlay against a tiny DOM stub.
// Run: node test-base-game-terrain-studio.mjs
import { DEFAULT_CONFIG, DENSITY_DEFAULT_CONFIG } from './terrain-generator-js.js';
import { defaultStack } from './terrain-stack.js';
import { hashProject, normalizeProject, migrateProjectToUnbounded, PROJECT_APP } from './terrain-project-v5.js';
import { createTerrainProjectStore, createBaseGameTerrainStudio, TERRAIN_STATE_FORMAT } from './base-game-terrain-studio.js';
import { MSG } from './terrain-editor-bridge.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const raw = (seed) => ({ app: PROJECT_APP, version: 1, cfg: { ...DEFAULT_CONFIG, seed }, density: { ...DENSITY_DEFAULT_CONFIG }, stack: defaultStack(), paint: null, imports: {} });

console.log('\n[1] draft intake and discard');
{
  const changes = [];
  const store = createTerrainProjectStore({ onChange: (s) => changes.push(s.status) });
  ok(store.state.status === 'unchanged' && !store.state.hasDraft, 'starts unchanged');
  const s = store.receiveDraft(raw(5), 'test');
  ok(store.state.status === 'draft' && store.state.hasDraft && s.seed === 5, 'draft accepted, not active');
  ok(store.activeProject === null && store.draftProject.cfg.seed === 5, 'active untouched');
  let threw = false; try { store.receiveDraft({ app: 'nope' }); } catch { threw = true; }
  ok(threw && store.draftProject.cfg.seed === 5, 'invalid draft rejected and previous draft kept');
  store.discardDraft();
  ok(store.state.status === 'unchanged' && !store.state.hasDraft, 'discard clears the draft');
  ok(changes.join(',') === 'draft,unchanged', `onChange fired (${changes.join(',')})`);
}

console.log('\n[2] Apply is a transaction; unsupported runtime leaves active untouched');
{
  const store = createTerrainProjectStore();
  store.receiveDraft(raw(9));
  const r = await store.apply();
  ok(r.ok === false && store.state.status === 'failed' && /v5-unbounded-1/.test(r.reason), `apply refused with precise reason: ${r.reason}`);
  ok(store.activeProject === null && store.draftProject.cfg.seed === 9, 'draft kept, active still null');
  const none = createTerrainProjectStore();
  const r2 = await none.apply();
  ok(r2.ok === false && /Nothing to apply/.test(r2.reason), 'apply with no draft is a no-op failure');
}

console.log('\n[3] Apply with a runtime hook swaps active only on success');
{
  const unbounded = (seed) => migrateProjectToUnbounded(normalizeProject(raw(seed)).project);
  const failing = createTerrainProjectStore({ applySource: async () => { throw new Error('boom'); } });
  failing.receiveDraft(unbounded(3));
  const r = await failing.apply();
  ok(r.ok === false && /boom/.test(r.reason) && failing.activeProject === null && failing.draftProject.cfg.seed === 3, 'hook failure keeps active null and the draft');
  const applied = [];
  const store = createTerrainProjectStore({ applySource: async (project, cls) => { applied.push([project.cfg.seed, cls.runtimeSupported]); } });
  store.receiveDraft(unbounded(4));
  const r2 = await store.apply();
  ok(r2.ok === true && store.state.status === 'active' && store.activeProject.cfg.seed === 4 && !store.state.hasDraft, 'successful apply promotes the draft to active');
  ok(applied.length === 1 && applied[0][0] === 4 && applied[0][1] === true, 'hook received the project and its classification');
  ok(/Not applied at runtime/.test(store.state.message), `status names the omitted stages: ${store.state.message.slice(0, 80)}`);
  ok(store.receiveDraft(unbounded(4)).hash === hashProject(store.activeProject) && !store.state.hasDraft, 'a draft equal to the active project collapses');
  const noHook = createTerrainProjectStore();
  noHook.receiveDraft(unbounded(5));
  const r3 = await noHook.apply();
  ok(r3.ok === false && /no runtime source hook/.test(r3.reason), 'streamable draft without a hook fails with a precise reason');
}

console.log('\n[4] state capture/restore round-trips full projects and verifies hashes');
{
  const store = createTerrainProjectStore();
  store.receiveDraft(raw(11));
  const cap = JSON.parse(JSON.stringify(store.capture()));
  ok(cap.format === TERRAIN_STATE_FORMAT && cap.draft.project.cfg.seed === 11 && cap.active === null, 'capture embeds the full draft project + hash');
  const back = createTerrainProjectStore();
  back.restore(cap);
  ok(back.state.status === 'draft' && back.draftProject.cfg.seed === 11 && hashProject(back.draftProject) === cap.draft.hash, 'restore rebuilds the draft with the same hash');
  const tampered = JSON.parse(JSON.stringify(cap)); tampered.draft.project.cfg.seed = 12;
  let threw = false; try { back.restore(tampered); } catch (e) { threw = /hash/.test(e.message); }
  ok(threw && back.draftProject.cfg.seed === 11, 'hash mismatch rejected; previous state kept');
  threw = false; try { back.restore({ format: 'other' }); } catch { threw = true; }
  ok(threw, 'wrong format rejected');
  back.restore(undefined);
  ok(back.draftProject.cfg.seed === 11, 'missing terrain block is a no-op');
  const sum = back.summary();
  ok(sum.status === 'draft' && sum.draft.hash === cap.draft.hash && !('project' in sum.draft), 'summary carries hash/version only, no project body');
}

console.log('\n[5] Terrain Studio overlay: open pauses, apply becomes a draft, close restores');
{
  // Minimal DOM/window stubs: enough for createElement/append/hidden and postMessage events.
  const listeners = new Set();
  const made = [];
  const mk = (tag) => {
    const n = { tag, children: [], hidden: false, className: '', textContent: '', listeners: {}, contentWindow: null,
      append(...c) { this.children.push(...c); if (tag === 'div' || tag === 'body') c.forEach(x => { if (x.tag === 'iframe') x.contentWindow = frameWin; }); },
      remove() {}, addEventListener(t, f) { this.listeners[t] = f; } };
    made.push(n); return n;
  };
  const body = mk('body'), head = mk('head');
  const doc = { body, head, createElement: mk, getElementById: () => null };
  const frameWin = { name: 'frame', postMessage(data) { frameWin.sent.push(data); }, sent: [] };
  const win = { location: { origin: 'http://x' }, addEventListener(t, f) { listeners.add(f); }, removeEventListener(t, f) { listeners.delete(f); } };
  const deliver = (data) => { for (const f of [...listeners]) f({ data, origin: 'http://x', source: frameWin }); };

  const store = createTerrainProjectStore();
  const events = [];
  const studio = createBaseGameTerrainStudio({ store, doc, win, editorUrl: './editor.html', onOpen: () => events.push('open'), onClose: () => events.push('close') });
  ok(studio.open === false, 'starts closed');
  studio.show();
  const frame = made.find(n => n.tag === 'iframe');
  ok(studio.open && frame && frame.src === './editor.html' && events.join() === 'open', 'open creates the iframe and fires onOpen');
  ok(frameWin.sent.length === 0, 'nothing sent before the editor is ready');
  deliver({ type: MSG.READY });
  ok(frameWin.sent.length === 1 && frameWin.sent[0].type === MSG.LOAD_PROJECT && frameWin.sent[0].project === null, 'ready triggers load-project with null (no project yet)');
  const reqId = frameWin.sent[0].requestId;
  deliver({ type: MSG.APPLY_PROJECT, requestId: reqId, project: raw(21) });
  ok(store.state.status === 'draft' && store.draftProject.cfg.seed === 21, 'editor apply lands as a draft');
  ok(studio.open === false && events.join() === 'open,close', 'apply closes the studio and fires onClose');
  studio.show();
  ok(frameWin.sent.length === 2 && frameWin.sent[1].project.cfg.seed === 21, 'reopen re-sends the draft project');
  deliver({ type: MSG.CLOSE, requestId: frameWin.sent[1].requestId });
  ok(studio.open === false && store.draftProject.cfg.seed === 21, 'editor close leaves the draft unchanged');
  studio.show();
  deliver({ type: MSG.APPLY_PROJECT, requestId: 'stale', project: raw(99) });
  ok(store.draftProject.cfg.seed === 21 && studio.open, 'stale request ignored; studio stays open');
  studio.destroy();
}

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
