// base-game-terrain-studio.js — Base Game's terrain configuration owner.
// `createTerrainProjectStore` is pure (draft vs. active project, Apply transaction,
// state-file capture/restore). `createBaseGameTerrainStudio` is the full-screen
// overlay that hosts terrain-generator-v5.html in a same-origin iframe through
// terrain-editor-bridge.js. Neither touches the player, camera or networking.

import { normalizeProject, hashProject, classifyProject, describeProject, verifyProjectHash, TerrainProjectError } from './terrain-project-v5.js';
import { createBridgeHost } from './terrain-editor-bridge.js';

export const TERRAIN_STATE_FORMAT = 'pcw-base-game-terrain';
export const TERRAIN_STATE_VERSION = 1;
export const APPLY_STATUS = Object.freeze(['unchanged', 'draft', 'validating', 'rebuilding', 'active', 'failed']);

// Holds the active (applied) project and an unapplied draft. `applySource` is the
// runtime hook (Phase 7 terrain-source-v5.js); until one is supplied, Apply fails
// with a precise status and the active project is left untouched.
export function createTerrainProjectStore({ applySource = null, onChange = null } = {}) {
  let active = null;      // { project, hash, summary }
  let draft = null;       // { project, hash, summary }
  let status = 'unchanged';
  let message = 'No terrain project. Open Terrain Studio to author one.';
  const emit = () => { onChange && onChange(store.state); };

  function entry(project) {
    return { project, hash: hashProject(project), summary: describeProject(project) };
  }

  const store = {
    get state() {
      return {
        status, message,
        active: active ? active.summary : null,
        draft: draft ? draft.summary : null,
        hasDraft: !!draft,
      };
    },
    get activeProject() { return active ? active.project : null; },
    get draftProject() { return draft ? draft.project : null; },

    // Accept a project from the editor (or a file) as a draft. Throws on invalid input.
    receiveDraft(raw, origin = 'editor') {
      const { project, report } = normalizeProject(raw);
      draft = entry(project);
      if (active && active.hash === draft.hash) {
        draft = null;
        status = active ? 'active' : 'unchanged';
        message = `Project from ${origin} matches the active terrain (hash ${active.hash.slice(0, 12)}).`;
      } else {
        status = 'draft';
        const filled = report.filledDefaults.length ? ` ${report.filledDefaults.length} field(s) filled from defaults.` : '';
        message = `Draft from ${origin} (hash ${draft.hash.slice(0, 12)}), not applied.${filled}`;
      }
      emit();
      return draft ? draft.summary : active.summary;
    },

    discardDraft() {
      draft = null;
      status = active ? 'active' : 'unchanged';
      message = active ? `Draft discarded; active terrain ${active.hash.slice(0, 12)} unchanged.` : 'Draft discarded.';
      emit();
    },

    // The Apply transaction: validate + classify, build a candidate through
    // `applySource`, and only then replace `active`. Never mutates on failure.
    async apply() {
      if (!draft) { message = 'Nothing to apply.'; emit(); return { ok: false, reason: message }; }
      status = 'validating'; message = 'Validating draft…'; emit();
      const cls = classifyProject(draft.project);
      if (!cls.runtimeSupported || !applySource) {
        status = 'failed';
        message = `Apply unavailable: ${cls.runtimeSupported ? 'no runtime source hook' : cls.reasons.join('; ')}. Draft kept.`;
        emit();
        return { ok: false, reason: message, classification: cls };
      }
      status = 'rebuilding'; message = 'Generating candidate terrain…'; emit();
      try {
        await applySource(draft.project, cls);
      } catch (err) {
        status = 'failed';
        message = `Apply failed: ${err && err.message ? err.message : err}. Active terrain kept.`;
        emit();
        return { ok: false, reason: message };
      }
      active = draft; draft = null;
      status = 'active'; message = `Terrain ${active.hash.slice(0, 12)} active. Not applied at runtime: ${cls.omitted.join(', ')}.`;
      emit();
      return { ok: true, hash: active.hash };
    },

    // Full projects go into the state file; the perf record gets only `summary()`.
    capture() {
      return {
        format: TERRAIN_STATE_FORMAT, version: TERRAIN_STATE_VERSION,
        status,
        active: active ? { hash: active.hash, project: active.project } : null,
        draft: draft ? { hash: draft.hash, project: draft.project } : null,
      };
    },

    // Restores through the same validation the editor path uses; a hash mismatch
    // or invalid project is rejected rather than partially assigned.
    restore(data) {
      if (data == null) return;
      if (typeof data !== 'object' || data.format !== TERRAIN_STATE_FORMAT) throw new TerrainProjectError(`unsupported terrain state ${data && data.format}`);
      const load = (slot) => {
        if (!slot) return null;
        const { project } = normalizeProject(slot.project);
        verifyProjectHash(project, slot.hash);
        return entry(project);
      };
      const nextActive = load(data.active);
      const nextDraft = load(data.draft);
      active = nextActive; draft = nextDraft;
      status = draft ? 'draft' : active ? 'active' : 'unchanged';
      message = draft ? `Draft ${draft.hash.slice(0, 12)} restored, not applied.` : active ? `Terrain ${active.hash.slice(0, 12)} restored.` : 'No terrain project.';
      emit();
    },

    summary() {
      return {
        status,
        active: active ? active.summary : null,
        draft: draft ? { hash: draft.hash, version: draft.summary.version, algorithmVersion: draft.summary.algorithmVersion } : null,
      };
    },
  };
  return store;
}

const STUDIO_STYLE_ID = 'base-game-terrain-studio-styles';
function installStyles(doc) {
  if (doc.getElementById(STUDIO_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STUDIO_STYLE_ID;
  style.textContent = `
    .bgts-overlay { position:fixed; inset:0; z-index:1100; display:grid; grid-template-rows:auto 1fr; background:#05090f; color:#eef4ff; font-family:system-ui,sans-serif; }
    .bgts-overlay[hidden] { display:none; }
    .bgts-bar { display:flex; align-items:center; gap:12px; padding:8px 14px; border-bottom:1px solid rgba(159,195,255,.25); background:#0d1624; font-size:13px; }
    .bgts-bar strong { font-size:15px; }
    .bgts-bar .bgts-status { flex:1; color:#9fb0c8; }
    .bgts-bar button { padding:7px 13px; border:1px solid #4d6f9e; border-radius:7px; background:#203553; color:#eef5ff; cursor:pointer; }
    .bgts-frame { width:100%; height:100%; border:0; background:#07101e; }
  `;
  doc.head.append(style);
}

// Full-screen Terrain Studio. The iframe is created on first open and kept so
// reopening is instant; every open re-sends the current project through the bridge.
export function createBaseGameTerrainStudio({
  store, editorUrl = './terrain-generator-v5.html', doc = document, win = window,
  onOpen = null, onClose = null, onError = null,
} = {}) {
  if (!store) throw new Error('createBaseGameTerrainStudio needs a project store');
  installStyles(doc);
  const overlay = doc.createElement('div');
  overlay.className = 'bgts-overlay';
  overlay.hidden = true;
  const bar = doc.createElement('div');
  bar.className = 'bgts-bar';
  const title = doc.createElement('strong');
  title.textContent = 'Terrain Studio';
  const status = doc.createElement('span');
  status.className = 'bgts-status';
  const closeButton = doc.createElement('button');
  closeButton.textContent = 'Back to game';
  bar.append(title, status, closeButton);
  overlay.append(bar);
  doc.body.append(overlay);

  let frame = null;
  let bridge = null;
  let pendingLoad = false;

  function setStatus(text) { status.textContent = text; }

  function sendProject() {
    if (!bridge || !bridge.ready) { pendingLoad = true; return; }
    pendingLoad = false;
    const project = store.draftProject || store.activeProject;
    if (project) { bridge.loadProject(project); setStatus(`Editing ${store.draftProject ? 'draft' : 'active'} project. Apply in the editor to send it back as a draft.`); }
    else { bridge.loadProject(null); setStatus('No project yet. Build one and press Apply to Base Game.'); }
  }

  function ensureFrame() {
    if (frame) return;
    frame = doc.createElement('iframe');
    frame.className = 'bgts-frame';
    frame.title = 'Terrain Generator v5';
    frame.src = editorUrl;
    overlay.append(frame);
    bridge = createBridgeHost({
      editorWindow: frame.contentWindow, origin: win.location.origin, listenOn: win,
      onReady: () => { if (pendingLoad) sendProject(); },
      onApply: (project) => {
        try { const s = store.receiveDraft(project, 'Terrain Studio'); setStatus(`Draft ${s.hash.slice(0, 12)} received.`); api.hide(); }
        catch (err) { setStatus(`Editor project rejected: ${err.message}`); onError && onError(err); }
      },
      onClose: () => api.hide(),
      onError: (err) => { setStatus(`Bridge: ${err.message}`); onError && onError(err); },
    });
  }

  const api = {
    get open() { return !overlay.hidden; },
    show() {
      if (!overlay.hidden) return;
      overlay.hidden = false;
      ensureFrame();
      sendProject();
      onOpen && onOpen();
    },
    hide() {
      if (overlay.hidden) return;
      overlay.hidden = true;
      onClose && onClose();
    },
    destroy() {
      bridge && bridge.dispose();
      overlay.remove();
      frame = null; bridge = null;
    },
  };
  closeButton.addEventListener('click', () => api.hide());
  return api;
}
