# Relay map publish: exporting terrain-generator-v4 maps to the hosted game

## Purpose

`terrain-generator-v4.html`'s density panel can already export a real map (GLB +
`-data.json` + a `map-config.json` entry) via `serve.py`'s `/api/save-map` endpoint — but
only when the page is served locally. On the hosted GitHub Pages build, there is no
backend to receive that POST, so the export button falls back to a plain browser
download and the map never becomes available in the hosted game (`start-screen.js` loads
`maps/map-config.json` via a same-origin relative `fetch`, so a map has to physically
land in the `sp1-webgpu-renderer-migration` branch — the confirmed GitHub Pages source
branch — to ever be reachable there).

This spec adds a second export path: a "Publish to game" button that sends the same
export payload to the already-deployed multiplayer relay server
(`server/server.js`, on Render at `wss://workshop-webgpu.onrender.com`), which commits
the GLB/`-data.json`/`map-config.json` update directly into the GitHub repo via the
GitHub REST API. That commit lands on the Pages source branch, which triggers the same
automatic Pages rebuild already observed after ordinary pushes — no manual file
placement or local server required.

## Non-goals

- **Not replacing local export yet.** The existing "Save to maps/" button (local
  `serve.py` → `/api/save-map`) stays as-is for now, for quick local iteration before
  publishing. Once the publish flow is proven reliable, it should be removed so there's
  only one export path — tracked as a follow-up below, not part of this work.
- **No user accounts / per-user auth.** A single shared secret gates the endpoint. This
  tool has one operator (the repo owner); it is not a multi-tenant publishing service.
- **No UI for editing/removing published maps.** Only adds new maps (or updates an
  existing GLB in place if the same folder/name is reused) — same scope as the existing
  local export.
- **No change to how the hosted game loads maps.** `start-screen.js`'s
  `fetch('maps/map-config.json')` is untouched; this spec only changes how files arrive
  in that folder.
- **No octokit/SDK dependency.** The GitHub Git Data API calls are a handful of plain
  REST requests; `server/package.json` currently has exactly one dependency (`ws`), and
  `serve.py` is stdlib-only — this stays consistent with that minimal-dependency style
  using Node's built-in `fetch`.
- **No CI/build-status polling.** The client reports "published, commit `<sha>`" and a
  rough "live in about a minute" message; it does not poll GitHub Pages' deployment
  status API to confirm the rebuild finished.

## Architecture

### `server/server.js` becomes an HTTP server + WebSocket server, not WebSocket-only

Currently `new WebSocketServer({ port })` opens its own internal HTTP server with no
request-handling hook. It's restructured to create the HTTP server explicitly and attach
the WebSocket server to it, so a normal request handler can coexist with the WS upgrade
handling:

```js
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { handlePublishRequest } from './publish-map.js';

const PORT = process.env.PORT || 8080;

const httpServer = http.createServer((req, res) => {
  handlePublishRequest(req, res).catch(err => {
    console.error('publish-map request failed:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'internal error' }));
    }
  });
});

const wss = new WebSocketServer({ server: httpServer });
// ...existing rooms/getOrCreate/pruneRoom/send/wss.on('connection', ...) unchanged...

httpServer.listen(PORT, () => console.log(`relay listening on :${PORT}`));
```

All existing room/relay logic (`rooms`, `getOrCreate`, `pruneRoom`, `send`, the
`wss.on('connection', ...)` handler) is untouched — only the `port` option moves from
`WebSocketServer` to `httpServer.listen`, and `console.log` moves to the listen callback.

### New module: `server/publish-map.js`

All the new logic lives in its own module, separate from `server.js`, so the GitHub-API
orchestration and the pure validation/merge helpers can be unit-tested without spinning
up a real HTTP server or hitting the real GitHub API (mirrors this repo's existing
pattern of pulling logic out into a plain, test-friendly module — see `forest-cull.js`,
`light-cluster.js`, `post-grade.js` as the established precedent for CPU-testable
counterparts to server/GPU-side code).

```js
import crypto from 'node:crypto';

export const MAX_BODY_BYTES = 60_000_000; // same cap as serve.py's /api/save-map
const SAFE_SEGMENT = /^[A-Za-z0-9 _-]+$/;

export function validateSegment(value) {
  return typeof value === 'string' && SAFE_SEGMENT.test(value.trim()) && value.trim().length > 0;
}

// Constant-time compare; guards the length-mismatch case explicitly because
// crypto.timingSafeEqual throws (rather than returning false) when buffer
// lengths differ, which would otherwise leak length info via a thrown/caught
// exception path and is easy to get wrong.
export function validateSecret(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Mirrors serve.py's _handle_save_map upsert rule: only add the key if absent,
// same default entry shape as map_bundle.write()/serve.py already produce.
export function mergeMapConfig(existingConfigText, mapKey, name) {
  let cfg;
  try {
    cfg = JSON.parse(existingConfigText);
    if (typeof cfg !== 'object' || cfg === null) cfg = {};
  } catch {
    cfg = {};
  }
  if (typeof cfg.maps !== 'object' || cfg.maps === null) cfg.maps = {};
  if (!(mapKey in cfg.maps)) {
    const display = name.replace(/_/g, ' ').replace(/-/g, ' ').trim()
      .replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
    cfg.maps[mapKey] = {
      displayName: display, gameName: display, image: '',
      playable: true, mapScale: 1, snapStep: 0.5,
    };
  }
  return cfg;
}

export function buildCommitMessage(folder, name) {
  return `Publish map: ${folder}/${name} (via terrain-generator-v4)`;
}

async function githubRequest(fetchImpl, token, method, path, body) {
  const res = await fetchImpl(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`GitHub API ${method} ${path} -> ${res.status}: ${json?.message ?? 'unknown error'}`);
  }
  return json;
}

// Atomic publish: builds one commit touching the GLB, the -data.json sidecar, and the
// merged map-config.json, then fast-forwards the branch ref to it. Retries the whole
// read-modify-write sequence once if the ref update rejects as non-fast-forward (409/422
// -- another publish landed in between); fails after the second attempt rather than
// looping, since a repeatedly-conflicting branch means something else is wrong.
export async function publishMap({ folder, name, glbBase64, mapData }, { token, repo, branch, fetchImpl = fetch }) {
  const mapKey = `${folder}/${name}.glb`;
  const dataText = JSON.stringify(mapData, null, 2);

  for (let attempt = 0; attempt < 2; attempt++) {
    const refPath = `/repos/${repo}/git/ref/heads/${branch}`;
    const ref = await githubRequest(fetchImpl, token, 'GET', refPath);
    const baseCommitSha = ref.object.sha;

    const commit = await githubRequest(fetchImpl, token, 'GET', `/repos/${repo}/git/commits/${baseCommitSha}`);
    const baseTreeSha = commit.tree.sha;

    let existingConfigText = '{}';
    try {
      const existing = await githubRequest(
        fetchImpl, token, 'GET',
        `/repos/${repo}/contents/maps/map-config.json?ref=${branch}`,
      );
      existingConfigText = Buffer.from(existing.content, 'base64').toString('utf-8');
    } catch {
      // No existing map-config.json (or a transient read error) -- mergeMapConfig
      // already treats unparsable/missing text as {}, so this is safe to swallow.
    }
    const mergedConfig = mergeMapConfig(existingConfigText, mapKey, name);

    const [glbBlob, dataBlob, configBlob] = await Promise.all([
      githubRequest(fetchImpl, token, 'POST', `/repos/${repo}/git/blobs`, { content: glbBase64, encoding: 'base64' }),
      githubRequest(fetchImpl, token, 'POST', `/repos/${repo}/git/blobs`, { content: dataText, encoding: 'utf-8' }),
      githubRequest(fetchImpl, token, 'POST', `/repos/${repo}/git/blobs`, { content: JSON.stringify(mergedConfig, null, 2), encoding: 'utf-8' }),
    ]);

    const tree = await githubRequest(fetchImpl, token, 'POST', `/repos/${repo}/git/trees`, {
      base_tree: baseTreeSha,
      tree: [
        { path: `maps/${folder}/${name}.glb`, mode: '100644', type: 'blob', sha: glbBlob.sha },
        { path: `maps/${folder}/${name}-data.json`, mode: '100644', type: 'blob', sha: dataBlob.sha },
        { path: 'maps/map-config.json', mode: '100644', type: 'blob', sha: configBlob.sha },
      ],
    });

    const newCommit = await githubRequest(fetchImpl, token, 'POST', `/repos/${repo}/git/commits`, {
      message: buildCommitMessage(folder, name),
      tree: tree.sha,
      parents: [baseCommitSha],
    });

    try {
      await githubRequest(fetchImpl, token, 'PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: newCommit.sha });
      return { mapKey, commitSha: newCommit.sha };
    } catch (err) {
      if (attempt === 0) continue; // one retry from a fresh ref/tree read
      throw err;
    }
  }
}

// HTTP-layer glue: parses the request, checks the secret and content-length cap,
// validates folder/name, calls publishMap, and writes the JSON response. Split from
// publishMap so tests can call publishMap directly with a mocked fetchImpl instead of
// spinning up a real server.
export async function handlePublishRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Export-Key',
    });
    res.end();
    return;
  }
  if (req.method !== 'POST' || req.url !== '/api/publish-map') {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
    return;
  }

  const send = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(payload));
  };

  if (!validateSecret(req.headers['x-export-key'], process.env.EXPORT_SECRET)) {
    send(401, { ok: false, error: 'bad or missing X-Export-Key' });
    return;
  }

  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength <= 0 || contentLength > MAX_BODY_BYTES) {
    send(400, { ok: false, error: 'bad content length' });
    return;
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) { send(400, { ok: false, error: 'payload too large' }); return; }
    chunks.push(chunk);
  }

  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    send(400, { ok: false, error: 'invalid JSON body' });
    return;
  }

  const folder = String(body.folder || '').trim();
  const name = String(body.name || '').trim();
  if (!validateSegment(folder) || !validateSegment(name)) {
    send(400, { ok: false, error: 'folder/name must be non-empty and use only letters, digits, spaces, underscores, or hyphens' });
    return;
  }

  try {
    const result = await publishMap(
      { folder, name, glbBase64: body.glbBase64 || '', mapData: body.mapData || {} },
      { token: process.env.GITHUB_TOKEN, repo: process.env.GITHUB_REPO, branch: process.env.GITHUB_BRANCH || 'sp1-webgpu-renderer-migration' },
    );
    send(200, { ok: true, ...result });
  } catch (err) {
    send(502, { ok: false, error: err.message });
  }
}
```

### Env vars (Render + `server/render.yaml`)

Four new environment variables on the `creature-relay` Render service:

- `EXPORT_SECRET` — the shared secret the client must send in `X-Export-Key`. Generated
  and set by the user directly in the Render dashboard (never committed).
- `GITHUB_TOKEN` — a classic GitHub Personal Access Token with `repo` (contents write)
  scope. Same: user-generated, set as a Render secret env var, never logged or returned
  in any response.
- `GITHUB_REPO` — `owner/name`, e.g. `msankofa/workshop-webgpu`.
- `GITHUB_BRANCH` — defaults to `sp1-webgpu-renderer-migration` in code if unset, but
  settable so it doesn't silently break if the Pages source branch ever changes.

`server/render.yaml` gains these as plain `envVars` entries (Render prompts for the
actual secret values in its dashboard when `sync: false` is used, so real values are
never written into the repo):

```yaml
envVars:
  - key: PORT
    fromGroup: render
  - key: EXPORT_SECRET
    sync: false
  - key: GITHUB_TOKEN
    sync: false
  - key: GITHUB_REPO
    value: msankofa/workshop-webgpu
  - key: GITHUB_BRANCH
    value: sp1-webgpu-renderer-migration
```

### CORS

The endpoint is called cross-origin (from `msankofa.github.io` or `localhost`, to
`workshop-webgpu.onrender.com`). Since the request carries a custom header
(`X-Export-Key`) and a JSON content type, the browser sends a preflight `OPTIONS`
request first — handled above by responding `204` with
`Access-Control-Allow-Origin: *` / `-Methods` / `-Headers`, and the same
`Access-Control-Allow-Origin: *` header is included on every actual response. Origin is
intentionally left unrestricted (`*`) because the real access control is the shared
secret, not the calling origin — restricting origin would add no real security here and
would break local testing from `file://`/`127.0.0.1` origins for no benefit.

### `terrain-generator-v4.html` client changes

The existing GLB-building logic (currently duplicated inline in the
`density-export-btn` click handler: `GLTFExporter` import + `parse` + `buildDensityMapData()`)
is extracted into a shared helper so both buttons reuse it instead of copy-pasting:

```js
async function buildExportPayload() {
  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const glbBuffer = await new Promise((resolve, reject) => {
    new GLTFExporter().parse(densityMesh, resolve, reject, { binary: true });
  });
  const mapData = buildDensityMapData();
  return { glbBuffer, mapData };
}
```

`density-export-btn`'s handler is updated to call `buildExportPayload()` instead of
inlining the same three lines; behavior is otherwise unchanged.

A new button is added next to it in the Export sub-section:

```html
<button class="action" id="density-publish-btn">Publish to game</button>
<p class="lede" id="density-publish-status"></p>
```

```js
const PUBLISH_URL = 'https://workshop-webgpu.onrender.com/api/publish-map';

function getPublishKey(forcePrompt = false) {
  const STORAGE_KEY = 'terrainGenPublishKey';
  if (!forcePrompt) {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
  }
  const entered = prompt('Enter the publish key for the hosted relay:');
  if (!entered) return null;
  localStorage.setItem(STORAGE_KEY, entered);
  return entered;
}

document.getElementById('density-publish-btn').addEventListener('click', async () => {
  const statusEl = document.getElementById('density-publish-status');
  const folder = document.getElementById('density-export-folder').value;
  const name = document.getElementById('density-export-name').value;
  if (!validateMapSegment(folder) || !validateMapSegment(name)) {
    statusEl.textContent = 'Folder and name must be non-empty and use only letters, digits, spaces, underscores, or hyphens.';
    return;
  }
  if (!densityLastGrid) { statusEl.textContent = 'Nothing to export yet.'; return; }

  const key = getPublishKey();
  if (!key) { statusEl.textContent = 'Publish cancelled -- no key entered.'; return; }

  statusEl.textContent = 'Publishing...';
  const { glbBuffer, mapData } = await buildExportPayload();

  try {
    const response = await fetch(PUBLISH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Export-Key': key },
      body: JSON.stringify({ folder: folder.trim(), name: name.trim(), glbBase64: arrayBufferToBase64(glbBuffer), mapData }),
    });
    const body = await response.json();
    if (response.status === 401) {
      localStorage.removeItem('terrainGenPublishKey');
      throw new Error('publish key rejected');
    }
    if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`);
    statusEl.textContent = `Published maps/${body.mapKey} (commit ${body.commitSha.slice(0, 7)}) -- live on the hosted game in about a minute, once GitHub Pages rebuilds.`;
  } catch (err) {
    downloadBlob(`${name.trim()}.glb`, new Blob([glbBuffer], { type: 'model/gltf-binary' }));
    downloadBlob(`${name.trim()}-data.json`, new Blob([JSON.stringify(mapData, null, 2)], { type: 'application/json' }));
    statusEl.textContent = `Publish failed (${err.message}) -- downloaded ${name.trim()}.glb and ${name.trim()}-data.json instead.`;
  }
});
```

## Error handling

- **Bad/missing secret** → server responds `401`; client clears the (wrong) cached key
  and falls back to download, same as any other failure, so the user isn't stuck.
- **Ref update conflict** (two publishes racing) → one retry from a fresh read; second
  failure surfaces as a normal error, falls back to download.
- **GitHub API network/rate-limit/auth failure** → surfaces as `502` with the underlying
  message, falls back to download.
- **Oversized payload** → rejected before any GitHub calls are made (`400`), matching
  `serve.py`'s existing content-length guard.
- All failure paths funnel into the exact same client-side fallback (browser download)
  that local export already uses — no new failure UX to design.

## Testing

New `test-publish-map.mjs` at the repo root (flat, no framework, matching this repo's
existing `test-*.mjs` convention), covering the pure/mockable pieces of
`server/publish-map.js`:

- `validateSegment` accepts letters/digits/spaces/underscores/hyphens, rejects empty
  strings and path-escape attempts (`../`, `/`).
- `validateSecret` returns `true` only for an exact match, `false` for length mismatches
  and wrong values (and never throws, including on empty/undefined input).
- `mergeMapConfig` adds a new key with the expected default shape
  (`displayName`/`gameName` title-cased from `name`, `playable: true`, `mapScale: 1`,
  `snapStep: 0.5`) when absent, and leaves an existing key's fields untouched when the
  key is already present; also handles missing/unparsable input as `{}`.
- `publishMap` with a mocked `fetchImpl` (a small in-memory fake that returns canned
  responses per GitHub endpoint/method) asserts: the right sequence of calls (ref → base
  commit → contents → 3 blobs → tree → commit → ref update), that the tree entries use
  the expected paths/shas, and that a single simulated ref-update conflict (409 once,
  success on the second attempt) is retried transparently, while two consecutive
  conflicts propagate as an error.

No test coverage for the real GitHub network calls or Render deployment (mocked in the
unit tests above); verified once manually end-to-end against the real API/repo after
deploying, the same way `/api/save-map` was verified this repo — a real publish from a
locally-served `terrain-generator-v4.html` pointed at the deployed relay, confirming the
commit appears on GitHub and the map shows up in `maps/map-config.json` on that branch.

## Docs / logging

- `docs/subsystems/multiplayer.md`: update the `server/server.js` row/description — no
  longer "pure relay, never touches simulation logic" only; add a paragraph describing
  the new `/api/publish-map` HTTP endpoint, its env vars, and the shared-secret security
  model. Update the line count.
- `docs/subsystems/biomes.md`: mention that the density panel's export now has two
  targets — local `serve.py` save and "Publish to game" (commits to GitHub via the
  relay) for the hosted site.
- `code-map.html`: update `server/server.js`'s node description and line count; the
  `terrain-generator-v4.html` node's description gains a mention of the publish path.
- One `agent_log.csv` row, subsystem `multi` (spans `multiplayer` and `terrain`), files
  `server/server.js;server/publish-map.js;server/render.yaml;terrain-generator-v4.html;test-publish-map.mjs;docs/subsystems/multiplayer.md;docs/subsystems/biomes.md;code-map.html`.

## Follow-up (not in this plan)

Once "Publish to game" has been used successfully a few times and is trusted, remove the
local "Save to maps/" button and its `serve.py` `/api/save-map` endpoint, leaving publish
as the only export path. Not done now because the publish path depends on infra
(Render env vars, a real GitHub token) that needs to be set up and proven working first.
