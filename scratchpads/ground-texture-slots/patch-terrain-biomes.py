import os
os.chdir(os.path.join(os.path.dirname(__file__), '..', '..'))

def patch(path, pairs):
    s = open(path, encoding='utf-8').read()
    for old, new in pairs:
        assert old in s, (path, old[:70])
        s = s.replace(old, new, 1)
    open(path, 'w', encoding='utf-8').write(s)

patch('base-game-terrain.js', [
("import { Fn, float, vec3, mix as tslMix, clamp as tslClamp, select, uniform as tslUniform } from 'three/tsl';",
 "import { Fn, float, vec3, mix as tslMix, clamp as tslClamp, select, uniform as tslUniform } from 'three/tsl';"),
# state next to splat state
("""  let splatWater = null;              // the water module's groundShade (wet band + caustics)
  let splatRain = null;               // the rain module's groundShade (wetness, puddles, ripples)
  function splatFor(index) {
    if (!splatMaterial || !splatTextures) return null;
    let m = splatInstances.get(index);
    if (!m) {
      const self = index === 0 ? coverExact : coverLevels[index - 1];
      const finer = index === 0 ? null : (index === 1 ? coverExact : coverLevels[index - 2]);
      m = createStreamedSplatMaterial(splatTextures, splatMaterial.userData.streamedSplat.cfg, { lod: { self, finer }, water: splatWater, rain: splatRain });
      splatInstances.set(index, m);
    }
    m.wireframe = wireframe;
    return m;
  }""",
 """  let splatWater = null;              // the water module's groundShade (wet band + caustics)
  let splatRain = null;               // the rain module's groundShade (wetness, puddles, ripples)
  // Per-biome ground (a project's material.biomes): the splat reads the biome id from the
  // placement field window, indexed globally, so the instances carry the render origin.
  const uSplatOriginXZ = tslUniform(new THREE.Vector2());
  let splatBiomes = null;             // { textures, table, rules } once a project asks for them
  let splatFieldRelease = null;       // the ground's own hold on the field window while biomes are on
  function biomeBinding() {
    if (!splatBiomes) return null;
    const w = fieldWindow();
    if (!w || !w.fields.includes('biomeIds')) return null;
    const sampler = w.gpuSampler('biomeIds');
    return { window: w, idNode: Fn(([xz]) => sampler(xz.add(uSplatOriginXZ), float(-1000))) };
  }
  function splatFor(index) {
    if (!splatMaterial || !splatTextures) return null;
    const binding = biomeBinding();
    let m = splatInstances.get(index);
    if (m && m.userData.splatBiomeWindow !== (binding?.window ?? null)) { m.dispose(); splatInstances.delete(index); m = null; }
    if (!m) {
      const self = index === 0 ? coverExact : coverLevels[index - 1];
      const finer = index === 0 ? null : (index === 1 ? coverExact : coverLevels[index - 2]);
      m = createStreamedSplatMaterial(splatTextures, splatMaterial.userData.streamedSplat.cfg, { lod: { self, finer }, water: splatWater, rain: splatRain, biome: binding ? { idNode: binding.idNode } : null });
      m.userData.splatBiomeWindow = binding?.window ?? null;
      if (splatBiomes) updateStreamedSplat(m, { biomeTable: splatBiomes.table, biomeRules: splatBiomes.rules, biomeAverages: splatBiomes.textures?.averages ?? [] });
      splatInstances.set(index, m);
    }
    m.wireframe = wireframe;
    return m;
  }"""),
# origin sync on init + rebase
("""  const stopRebase = worldCoordinates.onRebase(event => { root.position.add(new THREE.Vector3().fromArray(event.delta)); });""",
 """  const syncSplatOrigin = () => { const o = worldCoordinates.getOrigin(); uSplatOriginXZ.value.set(o[0], o[2]); };
  syncSplatOrigin();
  const stopRebase = worldCoordinates.onRebase(event => { root.position.add(new THREE.Vector3().fromArray(event.delta)); syncSplatOrigin(); });"""),
# public API next to swapSplatTextures
("""    get splatSlots() { return splatTextures?.slots ?? null; },""",
 """    get splatSlots() { return splatTextures?.slots ?? null; },
    // Per-biome overrides: `textures` from loadStreamedSplatBiomeArray (or null for rules only),
    // `table` from biomeLayerTable, `rules` from biomeRuleTable. Null drops the binding.
    setSplatBiomes(next) {
      const sameTextures = !!splatBiomes && !!next && splatBiomes.textures === (next.textures ?? null);
      if (!next) {
        splatBiomes = null;
        if (splatTextures) splatTextures.biomes = null;
        splatFieldRelease?.(); splatFieldRelease = null;
      } else {
        splatBiomes = { textures: next.textures ?? null, table: next.table, rules: next.rules };
        if (splatTextures) splatTextures.biomes = splatBiomes.textures;
        if (!splatFieldRelease) splatFieldRelease = acquireFields();
      }
      if (sameTextures) {
        for (const m of splatInstances.values()) updateStreamedSplat(m, { biomeTable: next.table, biomeRules: next.rules, biomeAverages: next.textures?.averages ?? [] });
        return;
      }
      for (const m of splatInstances.values()) m.dispose();
      splatInstances.clear();
      applyMaterials();
    },
    get splatBiomes() { return splatBiomes; },"""),
# setSplatMaterial keeps biome textures on the new set
("""    setSplatMaterial(material, textures = null) {
      splatMaterial = material ?? null;
      splatTextures = textures;""",
 """    setSplatMaterial(material, textures = null) {
      splatMaterial = material ?? null;
      splatTextures = textures;
      if (splatTextures && splatBiomes) splatTextures.biomes = splatBiomes.textures;"""),
# dispose releases the hold
("""    dispose() {
      stopRebase();
      for (const handle of fieldHandles) handle.release();""",
 """    dispose() {
      stopRebase();
      splatFieldRelease?.(); splatFieldRelease = null;
      for (const handle of fieldHandles) handle.release();"""),
])

patch('base-game.html', [
("import { loadStreamedSplatTextures, createStreamedSplatMaterial, updateStreamedSplat, splatSlotFolders, splatConfigFromProject, STREAMED_SPLAT_LAYERS } from './terrain-splat-streamed.js';",
 "import { loadStreamedSplatTextures, createStreamedSplatMaterial, updateStreamedSplat, splatSlotFolders, splatConfigFromProject, STREAMED_SPLAT_LAYERS, biomeLayerTable, biomeRuleTable, loadStreamedSplatBiomeArray } from './terrain-splat-streamed.js';"),
("""async function applyGroundTextureSlots(slots) {
  if (!(await groundTextureLoad)) return false;
  const wanted = splatSlotFolders(slots);
  const have = terrain.splatSlots;
  if (have && STREAMED_SPLAT_LAYERS.every(n => have[n] === wanted[n])) return false;
  return terrain.swapSplatTextures(await loadStreamedSplatTextures({ slots: wanted }));
}""",
 """async function applyGroundTextureSlots(slots) {
  if (!(await groundTextureLoad)) return false;
  const wanted = splatSlotFolders(slots);
  const have = terrain.splatSlots;
  if (have && STREAMED_SPLAT_LAYERS.every(n => have[n] === wanted[n])) return false;
  return terrain.swapSplatTextures(await loadStreamedSplatTextures({ slots: wanted }));
}
// Per-biome textures and rules. The array is reloaded only when the folder list changes; a
// project with no biome overrides drops the binding so the ground is the plain five-slot one.
let groundBiomeEntries = '';
let groundBiomeTextures = null;
async function applyGroundBiomes(project) {
  if (!(await groundTextureLoad)) return false;
  const material = project?.material ?? null;
  if (!material?.biomes || !Object.keys(material.biomes).length) { groundBiomeEntries = ''; groundBiomeTextures = null; terrain.setSplatBiomes(null); return true; }
  const { entries, table } = biomeLayerTable(material);
  const rules = biomeRuleTable(project);
  const key = entries.join('|');
  if (key !== groundBiomeEntries) {
    groundBiomeTextures = entries.length ? await loadStreamedSplatBiomeArray(entries) : null;
    groundBiomeEntries = key;
  }
  terrain.setSplatBiomes({ textures: groundBiomeTextures, table, rules });
  return true;
}"""),
("""  if (terrainStore.activeProject) terrain.updateSplat(splatConfigFromProject(terrainStore.activeProject));
  return tex;""",
 """  if (terrainStore.activeProject) {
    terrain.updateSplat(splatConfigFromProject(terrainStore.activeProject));
    applyGroundBiomes(terrainStore.activeProject).catch(err => console.warn(`per-biome ground not applied: ${err.message}`));
  }
  return tex;"""),
("""  applyGroundTextureSlots(project.material?.slots ?? null).catch(err => console.warn(`ground texture slots not applied: ${err.message}`));
  terrain.updateSplat(splatConfigFromProject(project));""",
 """  applyGroundTextureSlots(project.material?.slots ?? null).catch(err => console.warn(`ground texture slots not applied: ${err.message}`));
  terrain.updateSplat(splatConfigFromProject(project));
  applyGroundBiomes(project).catch(err => console.warn(`per-biome ground not applied: ${err.message}`));"""),
])
print('patched')
