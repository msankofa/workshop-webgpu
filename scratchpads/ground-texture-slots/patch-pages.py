import os
os.chdir(os.path.join(os.path.dirname(__file__), '..', '..'))

def patch(path, pairs):
    s = open(path, encoding='utf-8').read()
    for old, new in pairs:
        assert old in s, (path, old[:60])
        s = s.replace(old, new, 1)
    open(path, 'w', encoding='utf-8').write(s)

patch('base-game.html', [
("import { loadStreamedSplatTextures, createStreamedSplatMaterial, updateStreamedSplat } from './terrain-splat-streamed.js';",
 "import { loadStreamedSplatTextures, createStreamedSplatMaterial, updateStreamedSplat, splatSlotFolders, STREAMED_SPLAT_LAYERS } from './terrain-splat-streamed.js';"),
("""// Ground textures load in the background; the vertex tint shows until they arrive.
loadStreamedSplatTextures().then(tex => {
  terrain.setSplatMaterial(createStreamedSplatMaterial(tex, { tileMeters: settings.terrainTextureTile, fadeFar: settings.terrainTextureFade }), tex);
}).catch(err => console.warn(`ground textures unavailable, keeping the tint: ${err.message}`));""",
"""// Ground textures load in the background; the vertex tint shows until they arrive. The active
// project's material slots pick the folders; a later project swaps the images in place.
const groundTextureLoad = loadStreamedSplatTextures({ slots: terrainStore.activeProject?.material?.slots ?? null }).then(tex => {
  terrain.setSplatMaterial(createStreamedSplatMaterial(tex, { tileMeters: settings.terrainTextureTile, fadeFar: settings.terrainTextureFade }), tex);
  return tex;
}).catch(err => { console.warn(`ground textures unavailable, keeping the tint: ${err.message}`); return null; });
async function applyGroundTextureSlots(slots) {
  if (!(await groundTextureLoad)) return false;
  const wanted = splatSlotFolders(slots);
  const have = terrain.splatSlots;
  if (have && STREAMED_SPLAT_LAYERS.every(n => have[n] === wanted[n])) return false;
  return terrain.swapSplatTextures(await loadStreamedSplatTextures({ slots: wanted }));
}"""),
("""  terrain.setSource(descriptor);
  syncSpawnBuilding();
  activeTerrainDescriptor = descriptor;""",
"""  terrain.setSource(descriptor);
  syncSpawnBuilding();
  activeTerrainDescriptor = descriptor;
  applyGroundTextureSlots(project.material?.slots ?? null).catch(err => console.warn(`ground texture slots not applied: ${err.message}`));"""),
])

patch('terrain-generator-v5.html', [
("""    <p class="lede">Blended surface material from biome id, slope, and height.</p>
    <div class="gen-layout">
      <div class="canvas-frame">
        <canvas id="material-canvas" width="128" height="128" style="width:400px;height:400px;"></canvas>
        <div id="material-tooltip" class="tooltip hidden"></div>
      </div>
      <div class="controls" id="material-legend"></div>
    </div>""",
"""    <p class="lede">Blended surface material from biome id, slope, and height. The slots below choose which ground texture the Base Game draws for each blend; they are saved with the project.</p>
    <div class="gen-layout">
      <div class="canvas-frame">
        <canvas id="material-canvas" width="128" height="128" style="width:400px;height:400px;"></canvas>
        <div id="material-tooltip" class="tooltip hidden"></div>
      </div>
      <div class="controls" id="material-legend"></div>
      <div class="controls" id="material-slots"><p class="lede">Ground texture slots</p><div id="material-slot-rows"></div><p id="material-slot-status" class="lede"></p></div>
    </div>"""),
("""  let paint = new PaintLayers(genConfig.preview_resolution, genConfig.world_x, genConfig.world_z);
  const imports = {};            // layerId -> { data: Float32Array, resolution, source }""",
"""  let paint = new PaintLayers(genConfig.preview_resolution, genConfig.world_x, genConfig.world_z);
  const imports = {};            // layerId -> { data: Float32Array, resolution, source }
  // Ground texture slots (terrain-project-v5.js MATERIAL_SLOTS). Empty means the runtime's default folders.
  const materialSlots = {};
  const materialBlock = () => Object.keys(materialSlots).length ? { version: 1, slots: { ...materialSlots } } : null;
  function setMaterialSlots(next) { for (const k of Object.keys(materialSlots)) delete materialSlots[k]; Object.assign(materialSlots, next?.slots ?? {}); }"""),
("""    getState: () => ({ cfg: { ...genConfig }, stack: JSON.parse(JSON.stringify(stack)), paint: paint.serialize(), density: { ...densityConfig } }),
    restoreState: (s) => {
      Object.assign(genConfig, s.cfg);""",
"""    getState: () => ({ cfg: { ...genConfig }, stack: JSON.parse(JSON.stringify(stack)), paint: paint.serialize(), density: { ...densityConfig }, material: materialBlock() }),
    restoreState: (s) => {
      Object.assign(genConfig, s.cfg);
      setMaterialSlots(s.material); renderMaterialSlots();"""),
("""      cfg: { ...genConfig }, density: { ...densityConfig }, stack, paint: paint.serialize(),""",
"""      cfg: { ...genConfig }, density: { ...densityConfig }, stack, paint: paint.serialize(), material: materialBlock(),"""),
("""    paint = (project.paint && PaintLayers.deserialize(project.paint, genConfig.world_x, genConfig.world_z)) || new PaintLayers(genConfig.preview_resolution, genConfig.world_x, genConfig.world_z);
    if (project.name) document.getElementById('export-name').value = project.name;""",
"""    paint = (project.paint && PaintLayers.deserialize(project.paint, genConfig.world_x, genConfig.world_z)) || new PaintLayers(genConfig.preview_resolution, genConfig.world_x, genConfig.world_z);
    setMaterialSlots(project.material); renderMaterialSlots();
    if (project.name) document.getElementById('export-name').value = project.name;"""),
("""  document.getElementById('material-legend').innerHTML = Object.entries(MATERIAL_LEGEND_COLORS).map(([n, [r, g, b]]) => `<p><span class="swatch" style="background:rgb(${r},${g},${b})"></span>${n}</p>`).join('');
""",
"""  document.getElementById('material-legend').innerHTML = Object.entries(MATERIAL_LEGEND_COLORS).map(([n, [r, g, b]]) => `<p><span class="swatch" style="background:rgb(${r},${g},${b})"></span>${n}</p>`).join('');

  // ---- ground texture slots: one select per runtime layer, folders listed by serve.py ----
  let groundTextureFolders = null;   // [{ folder, title }] or null when the server is not there
  function renderMaterialSlots() {
    const rows = document.getElementById('material-slot-rows'); rows.innerHTML = '';
    const status = document.getElementById('material-slot-status');
    for (const slot of MATERIAL_SLOTS) {
      const row = document.createElement('div'); row.className = 'control-row';
      const label = document.createElement('label'); label.textContent = slot; row.appendChild(label);
      const select = document.createElement('select');
      const chosen = materialSlots[slot] ?? '';
      const options = [{ folder: '', title: `default (${slot})` }];
      if (groundTextureFolders) options.push(...groundTextureFolders);
      else if (chosen) options.push({ folder: chosen, title: chosen });
      for (const o of options) { const opt = document.createElement('option'); opt.value = o.folder; opt.textContent = o.folder ? `${o.title} (${o.folder})` : o.title; select.appendChild(opt); }
      select.value = chosen;
      select.addEventListener('change', () => {
        if (select.value) materialSlots[slot] = select.value; else delete materialSlots[slot];
        history.record(`texture slot ${slot}`);
        renderMaterialSlots();
      });
      row.appendChild(select);
      const swatch = document.createElement('img'); swatch.width = 28; swatch.height = 28; swatch.style.borderRadius = '4px'; swatch.alt = '';
      swatch.src = `textures/ground/${chosen || slot}/color.jpg`;
      row.appendChild(swatch);
      rows.appendChild(row);
    }
    status.textContent = groundTextureFolders ? `${groundTextureFolders.length} texture folders on disk.` : 'Texture list needs serve.py; the saved choice still applies in the game.';
  }
  renderMaterialSlots();
  fetch('/api/list-ground-textures').then(r => r.ok ? r.json() : null).then(body => {
    if (body?.ok) { groundTextureFolders = body.folders; renderMaterialSlots(); }
  }).catch(() => {});
"""),
])
print('patched')
