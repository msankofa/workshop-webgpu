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
