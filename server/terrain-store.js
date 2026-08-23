// terrain-store.js — content-addressed store of Terrain Generator v5 projects for Base Game rooms.
// A project is published once (base:terrain_put) and rooms refer to it by hash; joiners that lack
// the body fetch it (base:terrain_get). Kept in memory and mirrored to disk as <hash>.json so a
// relay restart keeps what was published. Pure: no sockets here.

import fs from 'node:fs';
import path from 'node:path';
import { normalizeProject, hashProject, classifyProject, canonicalProjectJson } from '../terrain-project-v5.js';

export const TERRAIN_STORE_MAX_BYTES = 512 * 1024;

export function createTerrainStore({ dir = null, maxBytes = TERRAIN_STORE_MAX_BYTES, maxEntries = 512 } = {}) {
  const projects = new Map();   // hash -> { project, json, bytes, publishedAt }
  let loaded = false;

  function loadFromDisk() {
    loaded = true;
    if (!dir) return 0;
    let names = [];
    try { names = fs.readdirSync(dir).filter(n => /^[0-9a-f]{64}\.json$/.test(n)); } catch { return 0; }
    let count = 0;
    for (const name of names) {
      try {
        const text = fs.readFileSync(path.join(dir, name), 'utf8');
        const { project } = normalizeProject(JSON.parse(text));
        const hash = hashProject(project);
        if (hash !== name.slice(0, 64)) continue;   // tampered or renamed file
        projects.set(hash, { project, json: canonicalProjectJson(project), bytes: Buffer.byteLength(text), publishedAt: 0 });
        count++;
      } catch { /* skip unreadable files */ }
    }
    return count;
  }

  function persist(hash, json) {
    if (!dir) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFile(path.join(dir, `${hash}.json`), json, () => {});
    } catch { /* disk is a mirror, not the source of truth */ }
  }

  // Validates, normalizes, classifies (must be streamable) and stores. Returns { projectHash, project } or { error }.
  function put(projectLike, at = Date.now()) {
    if (!loaded) loadFromDisk();
    let text;
    try { text = JSON.stringify(projectLike); } catch { return { error: 'project is not serializable' }; }
    if (!text || text.length > maxBytes) return { error: `project exceeds ${maxBytes} bytes` };
    let project;
    try { project = normalizeProject(projectLike).project; } catch (err) { return { error: `bad v5 project: ${err.message}` }; }
    const cls = classifyProject(project);
    if (!cls.runtimeSupported) return { error: `v5 project is not streamable: ${cls.reasons.join('; ')}` };
    const projectHash = hashProject(project);
    if (!projects.has(projectHash)) {
      if (projects.size >= maxEntries) {
        // drop the oldest published entry; rooms holding it keep their in-memory world
        let oldest = null;
        for (const [h, e] of projects) if (!oldest || e.publishedAt < oldest[1].publishedAt) oldest = [h, e];
        if (oldest) projects.delete(oldest[0]);
      }
      const json = canonicalProjectJson(project);
      projects.set(projectHash, { project, json, bytes: Buffer.byteLength(json), publishedAt: at });
      persist(projectHash, json);
    }
    return { projectHash, project: projects.get(projectHash).project };
  }

  function get(projectHash) {
    if (!loaded) loadFromDisk();
    return projects.get(projectHash)?.project ?? null;
  }

  return {
    put,
    get,
    has: hash => { if (!loaded) loadFromDisk(); return projects.has(hash); },
    get size() { if (!loaded) loadFromDisk(); return projects.size; },
    loadFromDisk,
  };
}
