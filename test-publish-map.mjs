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

import { publishMap, buildCommitMessage, validateProjectArtifact } from './server/publish-map.js';
import { createHash } from 'node:crypto';

// --- buildCommitMessage ---
ok(buildCommitMessage('workshop', 'my_map') === 'Publish map: workshop/my_map (via terrain-generator-v5)', '6: commit message format');

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
ok(result.projectKey === null && !happyCalls.some(c => c.path === '/repos/o/r/git/trees' && c.body.tree.some(t => t.path.endsWith('-project.json'))), '7: no project artifact without a project');

// --- validateProjectArtifact + project blob in the tree ---
const projectText = '{"app":"terrain-generator-v5","cfg":{"seed":7},"version":1}';
const projectHash = createHash('sha256').update(projectText).digest('hex');
ok(validateProjectArtifact(undefined, undefined) === null, '10: absent project is null');
ok(validateProjectArtifact(projectText, projectHash).hash === projectHash, '10: matching hash accepted');
ok(validateProjectArtifact(projectText, projectHash.toUpperCase()).hash === projectHash, '10: hash compare is case-insensitive');
let pThrew = '';
try { validateProjectArtifact(projectText, 'deadbeef'); } catch (e) { pThrew = e.message; }
ok(pThrew.includes('does not match'), '10: wrong hash rejected');
pThrew = '';
try { validateProjectArtifact('{"app":"other"}', createHash('sha256').update('{"app":"other"}').digest('hex')); } catch (e) { pThrew = e.message; }
ok(pThrew.includes('not a terrain-generator-v5'), '10: wrong app rejected');
pThrew = '';
try { validateProjectArtifact('not json', 'x'); } catch (e) { pThrew = e.message; }
ok(pThrew.includes('not valid JSON'), '10: invalid JSON rejected');
pThrew = '';
try { validateProjectArtifact(42, 'x'); } catch (e) { pThrew = e.message; }
ok(pThrew.includes('must be strings'), '10: non-string rejected');

const { fetchImpl: projFetch, calls: projCalls } = makeFakeGithub();
const projResult = await publishMap(
  { folder: 'workshop', name: 'test-map', glbBase64: 'AAAA', mapData: { a: 1 }, project: validateProjectArtifact(projectText, projectHash) },
  { token: 't', repo: 'o/r', branch: 'main', fetchImpl: projFetch },
);
ok(projResult.projectKey === 'workshop/test-map-project.json' && projResult.projectHash === projectHash, '11: returns projectKey + hash');
const projBlob = projCalls.find(c => c.method === 'POST' && c.path === '/repos/o/r/git/blobs' && c.body.encoding === 'base64' && c.body.content !== 'AAAA');
ok(projBlob && Buffer.from(projBlob.body.content, 'base64').toString('utf-8') === projectText, '11: project blob bytes are the canonical text, unchanged');
ok(projCalls.some(c => c.path === '/repos/o/r/git/trees' && c.body.tree.some(t => t.path === 'maps/workshop/test-map-project.json')), '11: tree includes the -project.json path');

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
