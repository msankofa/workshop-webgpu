// The one load path for a Stadium species, so every reader obeys the same stance: apply the stance, map
// the POSED file, pin roles over detection. Reading is injected so Node and the browser share it. Pure.

import { mapStadiumRig, pivotTree } from './stadium-rig-map.js';
import { rolesFromMap, compileRoles } from './stadium-rig-roles.js';
import { nodeWorldMatrices } from './stadium-glb.js';
import { emptyLibrary, getStance, isEmptyStance, stanceJson, stanceStamp } from './stadium-stance.js';

/** Where the authoritative stances live, relative to the repo root. */
export const STANCE_PATH = 'stadium-saves/stadium-stances.json';

/** The library, or an empty one. No file is the ordinary state, not an error. */
export async function loadStanceLibrary(readText, path = STANCE_PATH) {
  let text = null;
  try { text = await readText(path); } catch { text = null; }
  if (!text) return emptyLibrary();
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && parsed.stances ? parsed : emptyLibrary();
  } catch {
    return emptyLibrary();
  }
}

/** `readText` for Node, given that script's own `fs`. */
export const nodeReader = (fs) => (path) => (fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : null);

/** `readText` for a page served by serve.py; a 404 means no stances yet. */
export const fetchReader = (fetchImpl = fetch) => async (path) => {
  const res = await fetchImpl(`/${path}`, { cache: 'no-store' });
  return res.ok ? res.text() : null;
};

/** Freeze the detected legs into role form. Run on the AUTHORED rest, before a pose can move the feet. */
export function pinDetectedLegs(json, map, species = null) {
  const tree = pivotTree(json, nodeWorldMatrices(json));
  const parent = {}, names = {};
  for (const p of tree.pivots) {
    parent[p] = tree.parent.get(p) ?? -1;
    names[p] = json.nodes[p]?.name ?? `node${p}`;
  }
  return compileRoles(rolesFromMap(map, species), { parent, names });
}

/** Everything a walker needs, with the stance in it. `json` is the POSED document, so meshes match. */
export function mapSpecies(json, bin, { stance = null, roles = null, species = null } = {}) {
  const warnings = [];
  const posed = isEmptyStance(stance) ? json : stanceJson(json, bin, stance);
  const opts = roles && roles.legs?.length ? { roles } : {};
  const map = mapStadiumRig(posed, bin, { ...opts, source: species });
  if (roles?.warnings?.length) warnings.push(...roles.warnings);

  // Only worth the second map when a stance actually moved something.
  if (!isEmptyStance(stance)) {
    const bare = mapStadiumRig(json, bin, opts);
    if (bare.legs.length !== map.legs.length) {
      warnings.push(
        `the stance changed the leg count from ${bare.legs.length} to ${map.legs.length}` +
        (roles?.legs?.length ? '' : ' — pin the detected legs as roles before posing'));
    }
  }
  return {
    json: posed,
    bin,
    map,
    stance: stance ?? null,
    stamp: stanceStamp(stance ?? { bones: {} }),
    warnings: warnings.concat(map.warnings || []),
  };
}

/** `mapSpecies` with the stance looked up by name and its pinned legs compiled against the authored rig. */
export function mapSpeciesFromLibrary(json, bin, species, library, rolesOverride = null) {
  const stance = getStance(library, species);
  let roles = rolesOverride;
  if (!roles && stance.roles) {
    const tree = pivotTree(json, nodeWorldMatrices(json));
    const parent = {}, names = {};
    for (const p of tree.pivots) {
      parent[p] = tree.parent.get(p) ?? -1;
      names[p] = json.nodes[p]?.name ?? `node${p}`;
    }
    roles = compileRoles(stance.roles, { parent, names });
  }
  return mapSpecies(json, bin, { stance, roles, species });
}
