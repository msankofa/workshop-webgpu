import os
p = os.path.join(os.path.dirname(__file__), '..', '..', 'tree-viewer.html')
s = open(p, encoding='utf-8').read()

def rep(a, b):
    global s
    assert s.count(a) == 1, a[:80]
    s = s.replace(a, b)

rep("import { EZ_TREE_FAMILIES } from './tree-presets.js';",
    "import { EZ_TREE_FAMILIES } from './tree-presets.js';\nimport { createLodPreview, HOST_PRESETS } from './tree-lod-preview.js';")

rep("let mode = 'solo';        // 'solo' | 'grid'", "let mode = 'solo';        // 'solo' | 'grid' | 'lod'")

rep("""let soloTree = null;
let gridTrees = [];""", """let soloTree = null;
let gridTrees = [];
// LOD mode: clusters of n trees at every tier the game draws, baked by forest-palette.js itself.
const lodPreview = createLodPreview({ renderer, scene, createTree });
const lodSettings = {
  n: 3, layout: 'rings', distance: 100, preset: 'base game',
  rings: [...HOST_PRESETS['base game'].rings], billboards: HOST_PRESETS['base game'].billboards,
  branchLods: structuredClone(HOST_PRESETS['base game'].branchLods),
  coarseLeafRatio: 0.25, coarseLeafSizeMult: 2.5, leafShadowPct: 0.3,
};
function applyHostPreset(name) {
  const h = HOST_PRESETS[name];
  lodSettings.preset = name;
  lodSettings.rings = [...h.rings]; lodSettings.billboards = h.billboards;
  lodSettings.branchLods = structuredClone(h.branchLods);
  lodSettings.coarseLeafRatio = h.coarseLeafRatio; lodSettings.coarseLeafSizeMult = h.coarseLeafSizeMult;
}
let lodBuildPending = false;
function buildLod(refit) {
  const t0 = performance.now();
  lodBuildPending = true;
  lodPreview.build({ opts: applyAge(opts, previewAge), texSet, n: lodSettings.n, layout: lodSettings.layout,
    distance: lodSettings.distance, leafShadowPct: lodSettings.leafShadowPct,
    params: { branchLods: lodSettings.branchLods, coarseLeafRatio: lodSettings.coarseLeafRatio,
      coarseLeafSizeMult: lodSettings.coarseLeafSizeMult, rings: lodSettings.rings, billboards: lodSettings.billboards } })
    .then(() => { lodBuildPending = false; lastBuildMs = performance.now() - t0; if (refit) fitCameraToLod(); });
}
// Eye at the origin, 1.7 m up, looking down +Z at the LOD1 cluster (or the compare distance).
function fitCameraToLod() {
  const z = lodSettings.layout === 'rings' ? lodSettings.rings[1] : lodSettings.distance;
  const h = lodPreview.bounds().getSize(new THREE.Vector3()).y || 10;
  camera.position.set(0, 1.7, 0);
  controls.target.set(0, h * 0.4, z);
  controls.update();
}""")

rep("function liveTrees() { return mode === 'solo' ? (soloTree ? [soloTree] : []) : gridTrees; }",
    "function liveTrees() { return mode === 'solo' ? (soloTree ? [soloTree] : []) : mode === 'grid' ? gridTrees : []; }")

rep("""    `height ${treeMetrics.height.toFixed(1)} m  width ${treeMetrics.width.toFixed(1)} m  ` +
    `footprint ${treeMetrics.area.toFixed(1)} m²  hull volume ${treeMetrics.volume.toFixed(0)} m³`;""",
"""    `height ${treeMetrics.height.toFixed(1)} m  width ${treeMetrics.width.toFixed(1)} m  ` +
    `footprint ${treeMetrics.area.toFixed(1)} m²  hull volume ${treeMetrics.volume.toFixed(0)} m³`;
  if (mode === 'lod') {
    const camZ = camera.position.z;
    for (const st of lodPreview.stats) {
      dbgEl.textContent += `\\n${st.name} at ${(st.distance - camZ).toFixed(0)} m  tris ${st.tris}  leaves ${st.leaves}` +
        (st.name === 'LOD0' ? '' : `  (${(100 * st.tris / Math.max(1, lodPreview.stats[0].tris)).toFixed(0)}% of LOD0)`);
    }
    if (lodBuildPending) dbgEl.textContent += '\\nbaking…';
  }""")

rep("""  if (mode === 'solo') { for (const t of gridTrees) disposeTree(t); gridTrees = []; regenerateSolo(refit); }
  else { if (soloTree) { disposeTree(soloTree); soloTree = null; } buildGrid(refit); }
  computeTreeMetrics(liveTrees());
  refreshExport();
}""", """  if (mode !== 'grid') { for (const t of gridTrees) disposeTree(t); gridTrees = []; }
  if (mode !== 'solo' && soloTree) { disposeTree(soloTree); soloTree = null; }
  if (mode === 'solo') regenerateSolo(refit);
  else if (mode === 'grid') buildGrid(refit);
  else buildLod(refit);
  if (mode !== 'lod') lodPreview.dispose();
  computeTreeMetrics(liveTrees());
  refreshExport();
}""")

rep("""function regenerateAll() {
  if (mode === 'solo') regenerateSolo(needsRefit);
  else buildGrid(needsRefit);""", """function regenerateAll() {
  if (mode === 'solo') regenerateSolo(needsRefit);
  else if (mode === 'grid') buildGrid(needsRefit);
  else buildLod(needsRefit);""")

rep("""selectControl('Mode', ['solo', 'grid'], () => mode, v => { mode = v; }, () => {
  gridSizeWrap.style.display = mode === 'grid' ? '' : 'none';
  refreshSeedLabel();
  rebuildView();
});""", """selectControl('Mode', ['solo', 'grid', 'lod'], () => mode, v => { mode = v; }, () => {
  gridSizeWrap.style.display = mode === 'grid' ? '' : 'none';
  refreshSeedLabel();
  rebuildView();
});""")

# the panel goes after Safeguards
rep("""panelSection('texture', 'Texture', null);""", """panelSection('lod', 'LOD', null);
const lodRegen = () => { if (mode === 'lod') scheduleRegenerate(); };
const lodRelayout = () => { if (mode === 'lod') scheduleRegenerate(true); };
rangeControl('Cluster size', 1, 9, 1, () => lodSettings.n, v => { lodSettings.n = Math.round(v); }, fi, lodRegen);
selectControl('Layout', ['rings', 'side'], () => lodSettings.layout, v => { lodSettings.layout = v; }, lodRelayout);
rangeControl('Compare distance', 5, 900, 1, () => lodSettings.distance, v => { lodSettings.distance = v; }, fi, lodRelayout);
selectControl('Host preset', Object.keys(HOST_PRESETS), () => lodSettings.preset, v => { applyHostPreset(v); refreshAllControls(); }, lodRelayout);
rangeControl('LOD0 to 1 (m)', 5, 900, 1, () => lodSettings.rings[0], v => { lodSettings.rings[0] = v; }, fi, lodRelayout);
rangeControl('LOD1 to 2 (m)', 5, 900, 1, () => lodSettings.rings[1], v => { lodSettings.rings[1] = v; }, fi, lodRelayout);
rangeControl('LOD2 to billboard (m)', 5, 900, 1, () => lodSettings.rings[2], v => { lodSettings.rings[2] = v; }, fi, lodRelayout);
toggleControl('Billboard tier', () => lodSettings.billboards, v => { lodSettings.billboards = v; }, lodRegen);
rangeControl('LOD1 ring stride', 1, 6, 1, () => lodSettings.branchLods[0].sectionStride, v => { lodSettings.branchLods[0].sectionStride = Math.round(v); }, fi, lodRegen);
rangeControl('LOD1 segment scale', 0.1, 1, 0.01, () => lodSettings.branchLods[0].segmentScale, v => { lodSettings.branchLods[0].segmentScale = v; }, f2, lodRegen);
rangeControl('LOD2 ring stride', 1, 6, 1, () => lodSettings.branchLods[1].sectionStride, v => { lodSettings.branchLods[1].sectionStride = Math.round(v); }, fi, lodRegen);
rangeControl('LOD2 segment scale', 0.1, 1, 0.01, () => lodSettings.branchLods[1].segmentScale, v => { lodSettings.branchLods[1].segmentScale = v; }, f2, lodRegen);
rangeControl('Coarse leaf ratio', 0.05, 1, 0.01, () => lodSettings.coarseLeafRatio, v => { lodSettings.coarseLeafRatio = v; }, f2, lodRegen);
rangeControl('Coarse leaf size x', 1, 5, 0.1, () => lodSettings.coarseLeafSizeMult, v => { lodSettings.coarseLeafSizeMult = v; }, f2, lodRegen);
rangeControl('Shadow leaf fraction', 0, 1, 0.01, () => lodSettings.leafShadowPct, v => { lodSettings.leafShadowPct = v; }, pct, lodRegen);
buttonControl('Copy LOD settings JSON', () => {
  const out = { rings: lodSettings.rings, billboards: lodSettings.billboards, branchLods: lodSettings.branchLods,
    coarseLeafRatio: lodSettings.coarseLeafRatio, coarseLeafSizeMult: lodSettings.coarseLeafSizeMult, leafShadowPct: lodSettings.leafShadowPct };
  navigator.clipboard?.writeText(JSON.stringify(out, null, 2)).catch(() => {});
});

panelSection('texture', 'Texture', null);""")

rep("""  controls.update();
  renderer.render(scene, camera);
  if (++dbgFrames % 10 === 0) refreshDebugPanel();""", """  controls.update();
  if (mode === 'lod') lodPreview.update(camera);
  renderer.render(scene, camera);
  if (++dbgFrames % 10 === 0) refreshDebugPanel();""")

open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('patched')
