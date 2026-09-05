import os
os.chdir(os.path.join(os.path.dirname(__file__), '..', '..'))

def patch(path, pairs):
    s = open(path, encoding='utf-8').read()
    for old, new in pairs:
        assert old in s, (path, old[:60])
        s = s.replace(old, new, 1)
    open(path, 'w', encoding='utf-8').write(s)

patch('terrain-generator-js.js', [
("""const MATERIAL_COLORS = {
  grass: [92, 156, 72], forest: [50, 104, 54], dirt: [128, 94, 62],
  sand: [210, 190, 122], rock: [126, 126, 132], snow: [235, 241, 246],
};""",
"""export const MATERIAL_COLORS = Object.freeze({
  grass: [92, 156, 72], forest: [50, 104, 54], dirt: [128, 94, 62],
  sand: [210, 190, 122], rock: [126, 126, 132], snow: [235, 241, 246], water: [28, 66, 130],
});

// Preview colour per cell from the masks and a 0..255 colour table (a page swaps the table for the
// average colours of the ground textures a project chose, so the preview shows the same look).
export function materialRgbaFromMasks(masks, colors = MATERIAL_COLORS, out = null) {
  const n = masks.water.length;
  const rgba = out && out.length === n * 4 ? out : new Uint8ClampedArray(n * 4);
  const water = colors.water ?? MATERIAL_COLORS.water;
  for (let i = 0; i < n; i++) {
    let r = 0, g = 0, b = 0, total = 0;
    for (const key of ['grass', 'forest', 'dirt', 'sand', 'rock', 'snow']) {
      const wgt = masks[key][i];
      const [cr, cg, cb] = colors[key] ?? MATERIAL_COLORS[key];
      r += cr * wgt; g += cg * wgt; b += cb * wgt; total += wgt;
    }
    if (total > 1e-4) { r /= total; g /= total; b /= total; }
    const wv = masks.water[i];
    rgba[i * 4] = r * (1 - wv) + water[0] * wv;
    rgba[i * 4 + 1] = g * (1 - wv) + water[1] * wv;
    rgba[i * 4 + 2] = b * (1 - wv) + water[2] * wv;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}"""),
("""  const masks = { grass, forest, dirt, sand, rock, snow, water };
  const rgba = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    let r = 0, g = 0, b = 0, total = 0;
    for (const key of ['grass', 'forest', 'dirt', 'sand', 'rock', 'snow']) {
      const wgt = masks[key][i];
      const [cr, cg, cb] = MATERIAL_COLORS[key];
      r += cr * wgt; g += cg * wgt; b += cb * wgt; total += wgt;
    }
    if (total > 1e-4) { r /= total; g /= total; b /= total; }
    const wv = water[i];
    r = r * (1 - wv) + 28 * wv;
    g = g * (1 - wv) + 66 * wv;
    b = b * (1 - wv) + 130 * wv;
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
  }

  return { masks, rgba };""",
"""  const masks = { grass, forest, dirt, sand, rock, snow, water };
  return { masks, rgba: materialRgbaFromMasks(masks) };"""),
])

patch('terrain-generator-v5.html', [
# import
("""    buildHeightfieldMesh, divergingColor, signedColor, heightColor, flowColor, slopeColor, maskColor,""",
 """    buildHeightfieldMesh, divergingColor, signedColor, heightColor, flowColor, slopeColor, maskColor, materialRgbaFromMasks, MATERIAL_COLORS,"""),
# recolour on grid arrival
("""      lastGrid = r.grid;
      statusEl.textContent = `Grid ${r.grid.resolution}×${r.grid.resolution} in ${r.ms.toFixed(0)} ms (worker)`;""",
 """      lastGrid = r.grid;
      recolourMaterial(lastGrid);
      statusEl.textContent = `Grid ${r.grid.resolution}×${r.grid.resolution} in ${r.ms.toFixed(0)} ms (worker)`;"""),
# legend + averages
("""  const MATERIAL_LEGEND_COLORS = { grass: [92, 156, 72], forest: [50, 104, 54], dirt: [128, 94, 62], sand: [210, 190, 122], rock: [126, 126, 132], snow: [235, 241, 246], water: [28, 66, 130] };""",
 """  // Preview colours: the average of each chosen ground texture, so a moon project looks grey here
  // too. Forest has no runtime slot; the game draws it with the grass texture, so it is grass darkened.
  const textureAverages = {};       // folder -> [r, g, b] 0..255, filled as images load
  function materialColorTable() {
    const t = { ...MATERIAL_COLORS };
    for (const slot of MATERIAL_SLOTS) {
      const avg = textureAverages[materialSlots[slot] ?? slot];
      if (avg) t[slot] = avg;
    }
    t.forest = t.grass.map(v => v * 0.62);
    return t;
  }
  function recolourMaterial(grid) {
    if (!grid?.materialMasks) return;
    materialRgbaFromMasks(grid.materialMasks, materialColorTable(), grid.materialRgba);
  }
  function averageOfImage(img) {
    const c = document.createElement('canvas'); c.width = 8; c.height = 8;
    const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0, 8, 8);
    const d = ctx.getImageData(0, 0, 8, 8).data; let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    return [r / 64, g / 64, b / 64];
  }
  function loadTextureAverage(folder) {
    if (textureAverages[folder] !== undefined) return;
    textureAverages[folder] = null;
    const img = new Image();
    img.onload = () => { try { textureAverages[folder] = averageOfImage(img); } catch { return; } refreshMaterialLook(); };
    img.src = `textures/ground/${folder}/color.jpg`;
  }
  function refreshMaterialLook() {
    renderMaterialLegend();
    if (!lastGrid) return;
    recolourMaterial(lastGrid);
    drawMaterialPanel(lastGrid);
    if (hfState.mode === 'heightfield' && hfModeSelect.value === 'material') applyHeightfieldColors(lastGrid);
  }
  function renderMaterialLegend() {
    const t = materialColorTable();
    document.getElementById('material-legend').innerHTML = Object.entries(t).map(([n, [r, g, b]]) => `<p><span class="swatch" style="background:rgb(${r | 0},${g | 0},${b | 0})"></span>${n}</p>`).join('');
  }"""),
("""  document.getElementById('material-legend').innerHTML = Object.entries(MATERIAL_LEGEND_COLORS).map(([n, [r, g, b]]) => `<p><span class="swatch" style="background:rgb(${r},${g},${b})"></span>${n}</p>`).join('');
""",
 """  renderMaterialLegend();
"""),
# slot render: load averages and refresh look
("""      row.appendChild(swatch);
      rows.appendChild(row);
    }
    status.textContent = groundTextureFolders""",
 """      row.appendChild(swatch);
      rows.appendChild(row);
      loadTextureAverage(chosen || slot);
    }
    refreshMaterialLook();
    status.textContent = groundTextureFolders"""),
])
print('patched')
