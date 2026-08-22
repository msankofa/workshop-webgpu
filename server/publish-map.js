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

export function buildCommitMessage(folder, name) {
  return `Publish map: ${folder}/${name} (via terrain-generator-v5)`;
}

// Mirrors serve.py's validate_project_artifact: the client sends canonical project
// JSON text plus the sha256 of those bytes; we verify and store the bytes unchanged.
export function validateProjectArtifact(projectJson, projectHash) {
  if (projectJson == null) return null;
  if (typeof projectJson !== 'string' || typeof projectHash !== 'string') throw new Error('projectJson and projectHash must be strings');
  const bytes = Buffer.from(projectJson, 'utf-8');
  if (bytes.length > MAX_BODY_BYTES) throw new Error('project too large');
  let parsed;
  try { parsed = JSON.parse(projectJson); } catch { throw new Error('projectJson is not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || parsed.app !== 'terrain-generator-v5') throw new Error('projectJson is not a terrain-generator-v5 project');
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  if (digest !== projectHash.toLowerCase()) throw new Error('projectHash does not match projectJson bytes');
  return { text: projectJson, hash: digest };
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
export async function publishMap({ folder, name, glbBase64, mapData, project = null }, { token, repo, branch, fetchImpl = fetch }) {
  const mapKey = `${folder}/${name}.glb`;
  const dataText = JSON.stringify(mapData, null, 2);
  const projectKey = project ? `${folder}/${name}-project.json` : null;

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

    const [glbBlob, dataBlob, configBlob, projectBlob] = await Promise.all([
      githubRequest(fetchImpl, token, 'POST', `/repos/${repo}/git/blobs`, { content: glbBase64, encoding: 'base64' }),
      githubRequest(fetchImpl, token, 'POST', `/repos/${repo}/git/blobs`, { content: dataText, encoding: 'utf-8' }),
      githubRequest(fetchImpl, token, 'POST', `/repos/${repo}/git/blobs`, { content: JSON.stringify(mergedConfig, null, 2), encoding: 'utf-8' }),
      project ? githubRequest(fetchImpl, token, 'POST', `/repos/${repo}/git/blobs`, { content: Buffer.from(project.text, 'utf-8').toString('base64'), encoding: 'base64' }) : null,
    ]);

    const treeEntries = [
      { path: `maps/${folder}/${name}.glb`, mode: '100644', type: 'blob', sha: glbBlob.sha },
      { path: `maps/${folder}/${name}-data.json`, mode: '100644', type: 'blob', sha: dataBlob.sha },
      { path: 'maps/map-config.json', mode: '100644', type: 'blob', sha: configBlob.sha },
    ];
    if (projectBlob) treeEntries.push({ path: `maps/${projectKey}`, mode: '100644', type: 'blob', sha: projectBlob.sha });
    const tree = await githubRequest(fetchImpl, token, 'POST', `/repos/${repo}/git/trees`, { base_tree: baseTreeSha, tree: treeEntries });

    const newCommit = await githubRequest(fetchImpl, token, 'POST', `/repos/${repo}/git/commits`, {
      message: buildCommitMessage(folder, name),
      tree: tree.sha,
      parents: [baseCommitSha],
    });

    try {
      await githubRequest(fetchImpl, token, 'PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: newCommit.sha });
      return { mapKey, commitSha: newCommit.sha, projectKey, projectHash: project ? project.hash : null };
    } catch (err) {
      if (attempt === 0) continue; // one retry from a fresh ref/tree read
      throw err;
    }
  }
}

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

  let project = null;
  try { project = validateProjectArtifact(body.projectJson, body.projectHash); }
  catch (err) { send(400, { ok: false, error: err.message }); return; }

  try {
    const result = await publishMap(
      { folder, name, glbBase64: body.glbBase64 || '', mapData: body.mapData || {}, project },
      { token: process.env.GITHUB_TOKEN, repo: process.env.GITHUB_REPO, branch: process.env.GITHUB_BRANCH || 'sp1-webgpu-renderer-migration' },
    );
    send(200, { ok: true, ...result });
  } catch (err) {
    send(502, { ok: false, error: err.message });
  }
}
