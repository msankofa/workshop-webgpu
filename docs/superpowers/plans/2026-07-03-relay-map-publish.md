# Relay map publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `terrain-generator-v4.html`'s density-panel export publish straight to the hosted GitHub Pages game, by extending the deployed multiplayer relay (`server/server.js`) with an HTTP endpoint that commits the exported map into the GitHub repo via the GitHub REST API.

**Architecture:** `server/server.js` gains an explicit `http.createServer()` (replacing the WebSocketServer's implicit one) so it can serve `POST /api/publish-map` alongside the existing WS relay. A new `server/publish-map.js` module holds the pure/testable logic (secret check, path validation, map-config merge, GitHub Git Data API orchestration for one atomic commit). `terrain-generator-v4.html` gets a second "Publish to game" button next to the existing local-export button, sharing the existing GLB-build helper.

**Tech Stack:** Node built-ins only (`node:http`, `node:crypto`, global `fetch`) — no new npm dependencies. Plain `test-*.mjs` Node scripts, no test framework, matching the rest of the repo.

---

### Task 1: `mergeMapConfig` + `validateSegment` + `validateSecret` (pure helpers, TDD)

**Files:**
- Create: `server/publish-map.js`
- Test: `test-publish-map.mjs`

- [ ] **Step 1: Write the failing test for the three pure helpers**

Create `test-publish-map.mjs`:

```js
import { validateSegment, validateSecret, mergeMapConfig } from './server/publish-map.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('FAIL:', m); } };

// --- validateSegment ---
ok(validateSegment('workshop') === true, '1: accepts plain word');
ok(validateSegment('cave world 2') === true, '1: accepts spaces');
ok(validateSegment('a_b-c') === true, '1: accepts underscore/hyphen');
ok(validateSegment('') === false, '1: rejects empty string');
ok(validateSegment('   ') === false, '1: rejects whitespace-only');
ok(validateSegment('../etc') === false, '1: rejects path traversal');
ok(validateSegment('a/b') === false, '1: rejects slash');
ok(validateSegment(undefined) === false, '1: rejects non-string');

// --- validateSecret ---
ok(validateSecret('right', 'right') === true, '2: exact match passes');
ok(validateSecret('wrong', 'right') === false, '2: mismatch fails');
ok(validateSecret('rig', 'right') === false, '2: length mismatch fails, does not throw');
ok(validateSecret('', 'right') === false, '2: empty provided fails');
ok(validateSecret('right', '') === false, '2: empty expected fails (never auto-passes when unset)');
ok(validateSecret(undefined, 'right') === false, '2: undefined provided fails, does not throw');

// --- mergeMapConfig ---
const fresh = mergeMapConfig('{}', 'workshop/new-map.glb', 'new_map');
ok(fresh.maps['workshop/new-map.glb'].displayName === 'New Map', '3: title-cases name into displayName');
ok(fresh.maps['workshop/new-map.glb'].gameName === 'New Map', '3: gameName matches displayName');
ok(fresh.maps['workshop/new-map.glb'].playable === true, '3: playable defaults true');
ok(fresh.maps['workshop/new-map.glb'].mapScale === 1 && fresh.maps['workshop/new-map.glb'].snapStep === 0.5, '3: default scale/snapStep');

const existingText = JSON.stringify({ maps: { 'workshop/old.glb': { displayName: 'Custom Name', gameName: 'Custom Name', image: 'x.png', playable: false, mapScale: 2, snapStep: 1 } } });
const untouched = mergeMapConfig(existingText, 'workshop/old.glb', 'old');
ok(untouched.maps['workshop/old.glb'].displayName === 'Custom Name', '4: existing key left untouched');
ok(untouched.maps['workshop/old.glb'].image === 'x.png', '4: existing custom fields preserved');

const added = mergeMapConfig(existingText, 'workshop/new2.glb', 'new2');
ok(Object.keys(added.maps).length === 2, '4: adds new key alongside existing one');

const brokenJson = mergeMapConfig('not json', 'workshop/a.glb', 'a');
ok(brokenJson.maps['workshop/a.glb'].playable === true, '5: unparsable input treated as {}');

const nullMaps = mergeMapConfig(JSON.stringify({ maps: null }), 'workshop/b.glb', 'b');
ok(nullMaps.maps['workshop/b.glb'].playable === true, '5: null maps field treated as {}');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: Run test to verify it fails (module doesn't exist yet)**

Run: `node test-publish-map.mjs`
Expected: FAIL — `Cannot find module './server/publish-map.js'`

- [ ] **Step 3: Write `server/publish-map.js` with just the three pure helpers**

```js
import crypto from 'node:crypto';

export const MAX_BODY_BYTES = 60_000_000; // same cap as serve.py's /api/save-map
const SAFE_SEGMENT = /^[A-Za-z0-9 _-]+$/;

export function validateSegment(value) {
  return typeof value === 'string' && SAFE_SEGMENT.test(value.trim()) && value.trim().length > 0;
}

// Constant-time compare; guards the length-mismatch case explicitly because
// crypto.timingSafeEqual throws (rather than returning false) when buffer
// lengths differ.
export function validateSecret(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Mirrors serve.py's _handle_save_map upsert rule: only add the key if absent,
// same default entry shape serve.py already produces.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-publish-map.mjs`
Expected: `18 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add server/publish-map.js test-publish-map.mjs
git commit -m "feat(multiplayer): add pure validation/merge helpers for relay map publish"
```

---

### Task 2: `publishMap` GitHub Git Data API orchestration (TDD with mocked fetch)

**Files:**
- Modify: `server/publish-map.js`
- Test: `test-publish-map.mjs`

- [ ] **Step 1: Write the failing test for `publishMap`**

Append to `test-publish-map.mjs` (before the final `console.log`/`process.exit` lines — move those two lines to the very end after this block):

```js
import { publishMap, buildCommitMessage } from './server/publish-map.js';

// --- buildCommitMessage ---
ok(buildCommitMessage('workshop', 'my_map') === 'Publish map: workshop/my_map (via terrain-generator-v4)', '6: commit message format');

// --- publishMap: mocked GitHub API, happy path ---
function makeFakeGithub(overrides = {}) {
  const calls = [];
  const responses = {
    'GET /repos/o/r/git/ref/heads/main': { object: { sha: 'base-commit-sha' } },
    'GET /repos/o/r/git/commits/base-commit-sha': { tree: { sha: 'base-tree-sha' } },
    'GET /repos/o/r/contents/maps/map-config.json?ref=main': { content: Buffer.from('{}').toString('base64') },
    'POST /repos/o/r/git/blobs': { sha: 'blob-sha' },
    'POST /repos/o/r/git/trees': { sha: 'new-tree-sha' },
    'POST /repos/o/r/git/commits': { sha: 'new-commit-sha' },
    'PATCH /repos/o/r/git/refs/heads/main': { ok: true },
    ...overrides,
  };
  const fetchImpl = async (url, opts) => {
    const path = url.replace('https://api.github.com', '');
    const method = opts?.method || 'GET';
    calls.push({ method, path, body: opts?.body ? JSON.parse(opts.body) : null });
    const key = `${method} ${path}`;
    const entry = typeof responses[key] === 'function' ? responses[key](calls.length) : responses[key];
    if (entry === undefined) throw new Error(`unmocked call: ${key}`);
    if (entry instanceof Error) return { ok: false, status: 409, json: async () => ({ message: entry.message }) };
    return { ok: true, status: 200, json: async () => entry };
  };
  return { fetchImpl, calls };
}

const { fetchImpl: happyFetch, calls: happyCalls } = makeFakeGithub();
const result = await publishMap(
  { folder: 'workshop', name: 'test-map', glbBase64: 'AAAA', mapData: { a: 1 } },
  { token: 't', repo: 'o/r', branch: 'main', fetchImpl: happyFetch },
);
ok(result.mapKey === 'workshop/test-map.glb', '7: returns expected mapKey');
ok(result.commitSha === 'new-commit-sha', '7: returns new commit sha');
ok(happyCalls.some(c => c.method === 'POST' && c.path === '/repos/o/r/git/trees' && c.body.tree.some(t => t.path === 'maps/workshop/test-map.glb')), '7: tree includes the glb path');
ok(happyCalls.some(c => c.method === 'POST' && c.path === '/repos/o/r/git/trees' && c.body.tree.some(t => t.path === 'maps/workshop/test-map-data.json')), '7: tree includes the data.json path');
ok(happyCalls.some(c => c.method === 'POST' && c.path === '/repos/o/r/git/trees' && c.body.tree.some(t => t.path === 'maps/map-config.json')), '7: tree includes map-config.json');
ok(happyCalls.some(c => c.method === 'PATCH' && c.path === '/repos/o/r/git/refs/heads/main' && c.body.sha === 'new-commit-sha'), '7: ref updated to new commit sha');

// --- publishMap: one ref-update conflict, retried and succeeds ---
let refAttempts = 0;
const { fetchImpl: retryFetch, calls: retryCalls } = makeFakeGithub({
  'PATCH /repos/o/r/git/refs/heads/main': () => {
    refAttempts++;
    return refAttempts === 1 ? new Error('conflict') : { ok: true };
  },
});
const retryResult = await publishMap(
  { folder: 'workshop', name: 'retry-map', glbBase64: 'AAAA', mapData: {} },
  { token: 't', repo: 'o/r', branch: 'main', fetchImpl: retryFetch },
);
ok(retryResult.commitSha === 'new-commit-sha', '8: succeeds after one retry');
ok(retryCalls.filter(c => c.method === 'GET' && c.path === '/repos/o/r/git/ref/heads/main').length === 2, '8: re-reads ref on retry');

// --- publishMap: two consecutive conflicts, propagates error ---
const { fetchImpl: alwaysConflictFetch } = makeFakeGithub({
  'PATCH /repos/o/r/git/refs/heads/main': () => new Error('conflict'),
});
let threw = false;
try {
  await publishMap(
    { folder: 'workshop', name: 'fail-map', glbBase64: 'AAAA', mapData: {} },
    { token: 't', repo: 'o/r', branch: 'main', fetchImpl: alwaysConflictFetch },
  );
} catch { threw = true; }
ok(threw === true, '9: propagates error after exhausting retry');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test-publish-map.mjs`
Expected: FAIL — `publishMap is not a function` / import error (not yet exported)

- [ ] **Step 3: Add `publishMap` + `buildCommitMessage` + internal `githubRequest` to `server/publish-map.js`**

Append to `server/publish-map.js`:

```js
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
// read-modify-write sequence once if the ref update rejects as non-fast-forward
// (another publish landed in between); fails after the second attempt.
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test-publish-map.mjs`
Expected: `28 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add server/publish-map.js test-publish-map.mjs
git commit -m "feat(multiplayer): add publishMap GitHub Git Data API orchestration"
```

---

### Task 3: `handlePublishRequest` HTTP-layer glue

**Files:**
- Modify: `server/publish-map.js`

No new automated test for this step — it's thin request/response glue around
already-tested `publishMap`/`validateSecret`/`validateSegment`, verified manually in
Task 5's end-to-end check (this repo's existing precedent for HTTP-handler code, same as
`serve.py`'s handlers).

- [ ] **Step 1: Add `handlePublishRequest` to `server/publish-map.js`**

Append:

```js
// HTTP-layer glue: parses the request, checks the secret and content-length cap,
// validates folder/name, calls publishMap, and writes the JSON response.
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

- [ ] **Step 2: Run the existing test suite to confirm nothing broke**

Run: `node test-publish-map.mjs`
Expected: `28 passed, 0 failed` (unchanged — this step adds no new assertions)

- [ ] **Step 3: Commit**

```bash
git add server/publish-map.js
git commit -m "feat(multiplayer): add HTTP request handler for /api/publish-map"
```

---

### Task 4: Wire `server/server.js` to serve HTTP + WebSocket together

**Files:**
- Modify: `server/server.js:1-3` (imports + WebSocketServer construction), `server/server.js:83` (final `console.log`)

- [ ] **Step 1: Replace the top of `server/server.js`**

Change:

```js
import { WebSocketServer } from 'ws';

const wss = new WebSocketServer({ port: process.env.PORT || 8080 });
```

to:

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
```

Everything between this block and the final line (`rooms`, `getOrCreate`, `pruneRoom`,
`send`, `wss.on('connection', ...)`) is unchanged.

- [ ] **Step 2: Replace the final line**

Change:

```js
console.log(`relay listening on :${process.env.PORT || 8080}`);
```

to:

```js
httpServer.listen(PORT, () => console.log(`relay listening on :${PORT}`));
```

- [ ] **Step 3: Smoke-test locally**

Run (from `server/`, in one terminal, with dummy env vars since no real GitHub call is being made yet):

```bash
cd server && EXPORT_SECRET=test123 GITHUB_TOKEN=x GITHUB_REPO=o/r PORT=8081 node server.js
```

Expected output: `relay listening on :8081`, process stays running (Ctrl+C to stop).

In a second terminal, verify the WebSocket path still works (existing behavior) and the
new HTTP path responds:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:8081/api/publish-map -H "Content-Type: application/json" -H "X-Export-Key: wrong" -d '{}'
```

Expected: `401` (bad secret rejected, proving the HTTP handler is wired up and reachable
on the same port the WebSocket server listens on).

- [ ] **Step 4: Commit**

```bash
git add server/server.js
git commit -m "feat(multiplayer): serve /api/publish-map HTTP endpoint alongside the WebSocket relay"
```

---

### Task 5: `server/render.yaml` env vars

**Files:**
- Modify: `server/render.yaml`

- [ ] **Step 1: Add the four new env var entries**

Change:

```yaml
    envVars:
      - key: PORT
        fromGroup: render
```

to:

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

- [ ] **Step 2: Commit**

```bash
git add server/render.yaml
git commit -m "chore(multiplayer): add relay-publish env vars to render.yaml"
```

- [ ] **Step 3: Manual step (not committed to git) — tell the user to set real secret values**

After this deploys, `EXPORT_SECRET` and `GITHUB_TOKEN` will show up in the Render
dashboard as unset (`sync: false` means Render prompts rather than storing a value in
the repo). The user needs to:
1. Generate a GitHub classic Personal Access Token with `repo` scope.
2. In the Render dashboard for the `creature-relay` service, set `GITHUB_TOKEN` to that
   token and `EXPORT_SECRET` to a password of their choosing.
3. Redeploy (or Render may auto-redeploy on the env var save).

This step cannot be done by an agent — flag it clearly when this task is reached, don't
attempt to fabricate or guess values.

---

### Task 6: `terrain-generator-v4.html` — extract shared export-payload helper

**Files:**
- Modify: `terrain-generator-v4.html:897-928` (the `density-export-btn` click handler)

- [ ] **Step 1: Extract `buildExportPayload()`**

Immediately above the existing `document.getElementById('density-export-btn').addEventListener(...)` block, add:

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

- [ ] **Step 2: Update the existing click handler to use it**

Change:

```js
    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const glbBuffer = await new Promise((resolve, reject) => {
      new GLTFExporter().parse(densityMesh, resolve, reject, { binary: true });
    });
    const mapData = buildDensityMapData();
```

to:

```js
    const { glbBuffer, mapData } = await buildExportPayload();
```

- [ ] **Step 3: Manual verification**

Run `python serve.py`, open `http://127.0.0.1:8080/terrain-generator-v4.html`, go to the
Density field panel, click "Export to maps/" with a fresh name. Expected: identical
behavior to before this change (writes files, shows the same success message) — this
step is a pure refactor, not a behavior change.

- [ ] **Step 4: Commit**

```bash
git add terrain-generator-v4.html
git commit -m "refactor(terrain): extract shared buildExportPayload helper for map export"
```

---

### Task 7: `terrain-generator-v4.html` — add "Publish to game" button

**Files:**
- Modify: `terrain-generator-v4.html:357-358` (Export sub-section HTML), and the script block after Task 6's edit

- [ ] **Step 1: Add the button + status line to the HTML**

Change:

```html
    <button class="action" id="density-export-btn">Export to maps/</button>
    <p class="lede" id="density-export-status"></p>
```

to:

```html
    <button class="action" id="density-export-btn">Export to maps/</button>
    <p class="lede" id="density-export-status"></p>
    <button class="action" id="density-publish-btn">Publish to game</button>
    <p class="lede" id="density-publish-status"></p>
```

- [ ] **Step 2: Add the publish button's click handler**

Immediately after the existing `density-export-btn` click handler's closing `});`, add:

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

- [ ] **Step 3: Manual verification (requires Task 5's Render env vars to be set for a full pass)**

Open `terrain-generator-v4.html` (local or hosted), go to the Density panel, click
"Publish to game". Expected: prompted once for the key (enter the value set in Render's
`EXPORT_SECRET`), status shows "Publishing..." then "Published maps/...". Confirm on
GitHub that a new commit landed on `sp1-webgpu-renderer-migration` touching the GLB,
`-data.json`, and `map-config.json`. If the Render env vars aren't set yet, expect a
`502` and the download fallback — that's the correct behavior for an unconfigured
server, not a bug.

- [ ] **Step 4: Commit**

```bash
git add terrain-generator-v4.html
git commit -m "feat(terrain): add Publish to game button for hosted map export via the relay"
```

---

### Task 8: Update docs + `code-map.html` + `agent_log.csv`

**Files:**
- Modify: `docs/subsystems/multiplayer.md`, `docs/subsystems/biomes.md`, `code-map.html`, `agent_log.csv`

- [ ] **Step 1: Update `docs/subsystems/multiplayer.md`**

In the Files table, change the `server/server.js` row's description from:

```
| `server/server.js` | Relay backend (Node, `ws` library): room registry, host↔guest message forwarding, room presence queries | 82 |
```

to:

```
| `server/server.js` | Relay backend (Node, `ws` library + built-in `http`): room registry, host↔guest message forwarding, room presence queries, plus an `/api/publish-map` HTTP endpoint (`server/publish-map.js`) that commits hosted map exports to GitHub | ~15 |
```

(Line count reflects `server.js` shrinking since the publish logic moved into
`server/publish-map.js` — check the actual line count with `wc -l server/server.js` and
use the real number instead of the placeholder above.)

Add a new subsection after the existing "Deployment context" paragraph:

```markdown
### Hosted map publishing (`server/publish-map.js`)

`terrain-generator-v4.html`'s density panel can export a map two ways: a local
`serve.py` `/api/save-map` POST (unchanged, for local iteration), or a "Publish to game"
button that POSTs the same payload to this relay's `/api/publish-map` endpoint. The
relay commits the GLB, `-data.json`, and an updated `map-config.json` directly to the
GitHub repo via the Git Data API (one atomic commit: read the branch ref/tree, create
three blobs, create a tree, create a commit, fast-forward the ref — retried once on a
non-fast-forward conflict), which lands on `sp1-webgpu-renderer-migration` and triggers
the same automatic GitHub Pages rebuild that any other push does.

Security is a single shared secret (`X-Export-Key` header, checked against the
`EXPORT_SECRET` env var with a constant-time compare) — there's no per-user auth, no
origin restriction (CORS is `Access-Control-Allow-Origin: *`, since the secret is the
actual gate). Required env vars on the Render service: `EXPORT_SECRET`, `GITHUB_TOKEN`
(a repo-scoped PAT), `GITHUB_REPO`, `GITHUB_BRANCH`. See
`docs/superpowers/specs/2026-07-03-relay-map-publish-design.md` for the full design.
```

- [ ] **Step 2: Update `docs/subsystems/biomes.md`**

In the paragraph describing `terrain-generator-v4.html`'s export button (the one ending
"...via a local `serve.py` endpoint -- the same `maps/` directory `terrain-loader.js`
reads at runtime."), add a sentence:

```markdown
> A second "Publish to game" button sends the same export to the deployed multiplayer
> relay, which commits it directly into the GitHub repo so it becomes available on the
> hosted GitHub Pages build too, not just local `serve.py` sessions.
```

- [ ] **Step 3: Update `code-map.html`**

Find the `server/server.js` node entry (around line 277) and update its `lines` value
and `desc` field to mention the new HTTP endpoint (mirroring the multiplayer.md wording
from Step 1). Find the `terrain-generator-v4.html` node entry and add a short mention of
the publish path to its `desc` field.

- [ ] **Step 4: Append to `agent_log.csv`**

Add one row (check the current last row number first with a quick read, since this file
is append-only and must not renumber or rewrite existing rows):

```csv
2026-07-03T16:00,multi,"server/server.js;server/publish-map.js;server/render.yaml;terrain-generator-v4.html;test-publish-map.mjs;docs/subsystems/multiplayer.md;docs/subsystems/biomes.md;code-map.html","Added a Publish to game button to terrain-generator-v4.html and a new /api/publish-map endpoint on the multiplayer relay that commits map exports directly to GitHub via the Git Data API, so hosted GitHub Pages exports no longer need a local serve.py."
```

- [ ] **Step 5: Commit**

```bash
git add docs/subsystems/multiplayer.md docs/subsystems/biomes.md code-map.html agent_log.csv
git commit -m "docs(multiplayer): document relay map-publish endpoint and update agent log"
```

---

### Task 9: Final verification pass

- [ ] **Step 1: Run the full relevant test suite**

```bash
node test-publish-map.mjs
```

Expected: all assertions passing (28 from Tasks 1-2).

- [ ] **Step 2: Confirm no other test file references anything renamed/moved**

```bash
grep -rn "server/server.js\|publish-map" test-*.mjs
```

Expected: only `test-publish-map.mjs` references these — no other test file imports
from `server/`.

- [ ] **Step 3: Re-read the diff of every file touched in this plan**

```bash
git diff main --stat
```

Expected: `server/server.js`, `server/publish-map.js` (new), `server/render.yaml`,
`terrain-generator-v4.html`, `test-publish-map.mjs` (new), `docs/subsystems/multiplayer.md`,
`docs/subsystems/biomes.md`, `code-map.html`, `agent_log.csv` — nothing unexpected.

- [ ] **Step 4: Report completion**

Summarize for the user: what was built, that `EXPORT_SECRET`/`GITHUB_TOKEN` still need
to be set in the Render dashboard before publishing will actually work (Task 5, Step 3),
and that the local "Save to maps/" button remains as a fallback until the publish path
has been proven reliable (per the spec's Follow-up section).
