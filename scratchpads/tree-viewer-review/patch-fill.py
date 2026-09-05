import os
root = os.path.join(os.path.dirname(__file__), '..', '..')

p = os.path.join(root, 'tree-lod-preview.js')
s = open(p, encoding='utf-8').read()

def rep(a, b):
    global s
    assert s.count(a) == 1, a[:80]
    s = s.replace(a, b)

rep("""  let labels = [];
  let stats = [];
  let bakeToken = 0;""", """  let labels = [];
  let stats = [];
  let bakeToken = 0;
  let fillBillboards = [];   // { mesh, positions, scales } — instanced quads re-yawed in update()
  let billBrightness = 1;
  const billMats = [];""")

rep("""    materials = []; billboards = []; billboardTextures = []; stats = [];""",
    """    materials = []; billboards = []; billboardTextures = []; stats = []; fillBillboards = []; billMats.length = 0;""")

# brightness: the bake lights at 1.2/0.4, the live scene is brighter — same ratio env-viewer applies
rep("""  // Builds the clusters. `params` = { branchLods,""", """  function billMaterial(tex) {
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide });
    mat.color.setScalar(billBrightness);
    materials.push(mat); billMats.push(mat);
    return mat;
  }
  function setBillboardBrightness(v) {
    billBrightness = Math.max(0.05, v);
    for (const m of billMats) m.color.setScalar(billBrightness);
  }

  // Builds the clusters. `params` = { branchLods,""")

rep("""        const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.5, side: THREE.DoubleSide });
        materials.push(mat);
        const mesh = new THREE.Mesh(billboardGeo(size, center), mat);""",
    """        const mesh = new THREE.Mesh(billboardGeo(size, center), billMaterial(tex));""")

# fill layout: a forest across the whole LOD range, tiers assigned by distance the way the cull does
rep("""  async function build({ opts, texSet, n = 3, params, layout = 'rings', distance = 100, leafShadowPct = 0.3 }) {
    const token = ++bakeToken;
    disposeAll();
    const species = [{ ...opts }];
    palette = createForestPalette({
      createTree, masterSeed: opts.seed >>> 0, variantsPerSpecies: n, texSet,
      params: {
        speciesTable: species, leafShadowPct, branchLods: params.branchLods,
        coarseLeafRatio: params.coarseLeafRatio, coarseLeafSizeMult: params.coarseLeafSizeMult,
      },
    });
    const tierCount = params.billboards ? 4 : 3;""",
    """  async function build({ opts, texSet, n = 3, params, layout = 'rings', distance = 100, leafShadowPct = 0.3, density = 120 }) {
    const token = ++bakeToken;
    disposeAll();
    const species = [{ ...opts }];
    palette = createForestPalette({
      createTree, masterSeed: opts.seed >>> 0, variantsPerSpecies: n, texSet,
      params: {
        speciesTable: species, leafShadowPct, branchLods: params.branchLods,
        coarseLeafRatio: params.coarseLeafRatio, coarseLeafSizeMult: params.coarseLeafSizeMult,
      },
    });
    if (layout === 'fill') return buildFill({ opts, texSet, params, density, token });
    const tierCount = params.billboards ? 4 : 3;""")

rep("""  // Cylindrical facing: yaw toward the camera, stay upright — what instanceNodesBillboard does.
  const _w = new THREE.Vector3();
  function update(camera) {
    for (const b of billboards) {
      b.getWorldPosition(_w);
      b.rotation.y = Math.atan2(camera.position.x - _w.x, camera.position.z - _w.z);
    }
  }""", """  // Fill: one instanced mesh per (variant, tier, part) across a jittered grid that runs from the eye
  // out to the last ring (1.5 x R2 with billboards, the game's max draw radius). Tier k is whatever
  // ring the tree's distance from the origin falls in — the same bucketing forest-gpu's cull does.
  async function buildFill({ opts, texSet, params, density, token }) {
    const rings = params.rings;
    const tierCount = params.billboards ? 4 : 3;
    const zMax = params.billboards ? rings[2] * 1.5 : rings[2];
    const width = Math.max(40, zMax * 0.7);
    const spacing = Math.sqrt(10000 / Math.max(1, density));
    const rng = mulberry(opts.seed >>> 0);
    const V = palette.variants.length;
    // per variant, per tier: arrays of [x, z, yaw, scale]
    const buckets = Array.from({ length: V }, () => Array.from({ length: tierCount }, () => []));
    const counts = new Array(tierCount).fill(0);
    for (let z = 4; z < zMax; z += spacing) {
      for (let x = -width / 2; x < width / 2; x += spacing) {
        const px = x + (rng() - 0.5) * spacing * 0.9, pz = z + (rng() - 0.5) * spacing * 0.9;
        const d = Math.hypot(px, pz);
        let k = d <= rings[0] ? 0 : d <= rings[1] ? 1 : d <= rings[2] ? 2 : 3;
        if (k >= tierCount) continue;
        const v = Math.floor(rng() * V);
        buckets[v][k].push([px, pz, rng() * Math.PI * 2, 0.85 + rng() * 0.3]);
        counts[k]++;
      }
    }
    stats = [];
    for (let k = 0; k < tierCount; k++) {
      stats.push({ name: TIER_NAMES[k], tris: 0, leaves: 0, count: counts[k],
        distance: k === 0 ? 0 : rings[k - 1] });
    }
    const barkL0 = makeMat(texSet, false, false), leafL0 = makeMat(texSet, true, true);
    const barkL1 = makeMat(texSet, false, false), leafL1 = makeMat(texSet, true, false);
    const barkL2 = makeMat(texSet, false, false), leafL2 = makeMat(texSet, true, false);
    const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0);
    const instanced = (geo, mat, list, castShadow) => {
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach(([x, z, yaw, sc], i) => {
        _q.setFromAxisAngle(_up, yaw); _p.set(x, 0, z); _s.setScalar(sc);
        im.setMatrixAt(i, _m.compose(_p, _q, _s));
      });
      im.castShadow = castShadow; im.receiveShadow = true;
      im.frustumCulled = false;
      root.add(im);
      return im;
    };
    palette.variants.forEach((v, vi) => {
      const b = buckets[vi];
      const parts = [
        [0, v.branches, barkL0, true], [0, v.leaves, leafL0, false], [0, v.shadow, leafL0, true],
        [1, v.branchesLod1 ?? v.branches, barkL1, true], [1, v.leaves, leafL1, false],
        [2, v.branchesLod2 ?? v.branches, barkL2, true], [2, v.leavesCoarse, leafL2, false],
      ];
      for (const [k, geo, mat, cast] of parts) {
        if (!b[k].length) continue;
        instanced(geo, mat, b[k], cast);
        stats[k].tris += tris(geo) * b[k].length;
        if (mat === leafL0 || mat === leafL1 || mat === leafL2) stats[k].leaves += leafCount(geo) * b[k].length;
      }
    });
    if (params.billboards) {
      for (let vi = 0; vi < V; vi++) {
        const list = buckets[vi][3];
        if (!list.length) continue;
        const { tex, size, center } = await bakeBillboard(palette.variants[vi], texSet);
        if (token !== bakeToken) return stats;
        const im = new THREE.InstancedMesh(billboardGeo(size, center), billMaterial(tex), list.length);
        im.frustumCulled = false;
        root.add(im);
        fillBillboards.push({ mesh: im, list });
        stats[3].tris += 2 * list.length;
      }
    }
    if (typeof document !== 'undefined') {
      for (let k = 0; k < tierCount - 1; k++) {
        const z = rings[k];
        const label = makeLabel(`${TIER_NAMES[k]} → ${TIER_NAMES[k + 1]} · ${Math.round(z)} m`, z);
        label.position.set(-width / 2 - label.scale.x * 0.6, opts.length[0] * 0.8, z);
        root.add(label); labels.push(label);
      }
    }
    return stats;
  }

  // Cylindrical facing: yaw toward the camera, stay upright — what instanceNodesBillboard does.
  const _w = new THREE.Vector3(), _fm = new THREE.Matrix4(), _fq = new THREE.Quaternion(), _fp = new THREE.Vector3(), _fs = new THREE.Vector3(), _fup = new THREE.Vector3(0, 1, 0);
  function update(camera) {
    for (const b of billboards) {
      b.getWorldPosition(_w);
      b.rotation.y = Math.atan2(camera.position.x - _w.x, camera.position.z - _w.z);
    }
    for (const { mesh, list } of fillBillboards) {
      list.forEach(([x, z, , sc], i) => {
        _fq.setFromAxisAngle(_fup, Math.atan2(camera.position.x - x, camera.position.z - z));
        _fp.set(x, 0, z); _fs.setScalar(sc);
        mesh.setMatrixAt(i, _fm.compose(_fp, _fq, _fs));
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
  }""")

rep("""  return { build, update, bounds, dispose, get stats() { return stats; }, get tierNames() { return TIER_NAMES; } };""",
    """  return { build, update, bounds, dispose, setBillboardBrightness, get stats() { return stats; }, get tierNames() { return TIER_NAMES; } };""")

rep("""function tris(geo) {""", """function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function tris(geo) {""")
open(p, 'w', encoding='utf-8', newline='\n').write(s)

# ---- the page ----
p = os.path.join(root, 'tree-viewer.html')
s = open(p, encoding='utf-8').read()
rep("""  n: 3, layout: 'rings', distance: 100, preset: 'base game',""", """  n: 3, layout: 'rings', distance: 100, density: 120, preset: 'base game',""")
rep("""  lodPreview.build({ opts: applyAge(opts, previewAge), texSet, n: lodSettings.n, layout: lodSettings.layout,
    distance: lodSettings.distance, leafShadowPct: lodSettings.leafShadowPct,""",
    """  lodPreview.build({ opts: applyAge(opts, previewAge), texSet, n: lodSettings.n, layout: lodSettings.layout,
    distance: lodSettings.distance, density: lodSettings.density, leafShadowPct: lodSettings.leafShadowPct,""")
rep("""  const z = lodSettings.layout === 'rings' ? lodSettings.rings[1] : lodSettings.distance;""",
    """  const z = lodSettings.layout === 'side' ? lodSettings.distance : lodSettings.rings[1];""")
rep("""selectControl('Layout', ['rings', 'side'], () => lodSettings.layout, v => { lodSettings.layout = v; }, lodRelayout);""",
    """selectControl('Layout', ['rings', 'side', 'fill'], () => lodSettings.layout, v => { lodSettings.layout = v; }, lodRelayout);
rangeControl('Fill density (trees/ha)', 5, 400, 5, () => lodSettings.density, v => { lodSettings.density = v; }, fi, lodRegen);""")
rep("""      dbgEl.textContent += `\\n${st.name} at ${(st.distance - camZ).toFixed(0)} m  tris ${st.tris}  leaves ${st.leaves}` +""",
    """      dbgEl.textContent += `\\n${st.name} at ${(st.distance - camZ).toFixed(0)} m  ` + (st.count != null ? `trees ${st.count}  ` : '') + `tris ${st.tris}  leaves ${st.leaves}` +""")
# billboard brightness follows the live sun/ambient the way env-viewer's billBrightness() does
rep("""let sunColor = '#fff4e0', sunIntensity = 4, ambientColor = '#8ab4e8', ambientIntensity = 1.05;""",
    """let sunColor = '#fff4e0', sunIntensity = 4, ambientColor = '#8ab4e8', ambientIntensity = 1.05;
// Billboards are baked unlit at sun 1.2 / ambient 0.4; scale them to the live rig like environment-viewer does.
function syncBillboardBrightness() { lodPreview.setBillboardBrightness((sunIntensity + ambientIntensity * 0.5) / (1.2 + 0.4 * 0.5)); }
syncBillboardBrightness();""")
rep("""rangeControl('Sun intensity', 0, 4, 0.05, () => sunIntensity, v => { sunIntensity = v; rig.setSunIntensity(v); }, f2, () => {});
rangeControl('Ambient intensity', 0, 2, 0.05, () => ambientIntensity, v => { ambientIntensity = v; rig.setAmbientIntensity(v); }, f2, () => {});""",
    """rangeControl('Sun intensity', 0, 4, 0.05, () => sunIntensity, v => { sunIntensity = v; rig.setSunIntensity(v); }, f2, syncBillboardBrightness);
rangeControl('Ambient intensity', 0, 2, 0.05, () => ambientIntensity, v => { ambientIntensity = v; rig.setAmbientIntensity(v); }, f2, syncBillboardBrightness);""")
open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('patched')
