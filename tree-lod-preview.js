// tree-lod-preview.js — shows one species at every LOD tier the game draws, as clusters of plain
// meshes, so the tiers can be compared and their switch distances judged by eye.
//
// The tiers come from forest-palette.js's own bake (a one-species table, n variants), so the
// geometry is exactly what forest-gpu.js would instance: LOD0 full branches + leaves + shadow
// leaves (DoubleSide), LOD1 branchLods[0] branches + full leaves (FrontSide), LOD2 branchLods[1]
// branches + coarse leaves, LOD3 an upright camera-facing billboard baked the way
// environment-viewer.html bakes its 'cross' impostor (one orthographic capture, sun 1.2 / ambient 0.4).
import * as THREE from 'three';
import { createForestPalette } from './forest-palette.js';

export const HOST_PRESETS = Object.freeze({
  'base game': Object.freeze({
    rings: [60, 140, 260], billboards: false,
    branchLods: [{ sectionStride: 2, segmentScale: 0.67 }, { sectionStride: 3, segmentScale: 0.5 }],
    coarseLeafRatio: 0.25, coarseLeafSizeMult: 2.5,
  }),
  'environment viewer': Object.freeze({
    rings: [258, 400, 583], billboards: true,
    branchLods: [{ sectionStride: 1, segmentScale: 1 }, { sectionStride: 1, segmentScale: 1 }],
    coarseLeafRatio: 0.25, coarseLeafSizeMult: 2.5,
  }),
});

const BAKE_SUN = 1.2, BAKE_AMB = 0.4, BILL_SIZE = 256;
const TIER_NAMES = ['LOD0', 'LOD1', 'LOD2', 'LOD3'];

function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function tris(geo) { return geo?.index ? geo.index.count / 3 : 0; }
function leafCount(geo) { return geo?.index ? geo.index.count / 6 : 0; }   // two triangles per card

// Cluster slots: a hex-ish ring around the centre, spacing from the trunk length.
function clusterOffsets(n, spacing) {
  const out = [[0, 0]];
  for (let i = 1; i < n; i++) {
    const ring = Math.ceil((Math.sqrt(1 + 8 * i / 6) - 1) / 2) || 1;
    const a = (i / n) * Math.PI * 2 * 1.618;
    out.push([Math.cos(a) * spacing * ring, Math.sin(a) * spacing * ring]);
  }
  return out;
}

export function createLodPreview({ renderer, scene, createTree }) {
  const root = new THREE.Group();
  scene.add(root);
  let palette = null;
  let materials = [];
  let billboards = [];      // { mesh } — turned to face the camera in update()
  let billboardTextures = [];
  let labels = [];
  let stats = [];
  let bakeToken = 0;
  let fillBillboards = [];   // { mesh, positions, scales } — instanced quads re-yawed in update()
  let billBrightness = 1;
  const billMats = [];
  // Appearance of the impostor: how it is lit at capture time, and how it is cut out and tinted live.
  const billLook = { bakeSun: BAKE_SUN, bakeAmbient: BAKE_AMB, bakeTint: 0xffffff, alphaTest: 0.5, pitch: 0.1, gain: 1 };

  function disposeAll() {
    root.clear();
    if (palette) {
      for (const v of palette.variants) {
        for (const g of [v.branches, v.branchesLod1, v.branchesLod2, v.leaves, v.shadow, v.leavesCoarse]) g?.dispose();
      }
      palette = null;
    }
    for (const m of materials) m.dispose();
    for (const l of labels) l.userData.dispose();
    labels = [];
    for (const t of billboardTextures) t.dispose();
    materials = []; billboards = []; billboardTextures = []; stats = []; fillBillboards = []; billMats.length = 0;
  }

  function bindTextures(mat, texSet, isLeaf) {
    const ready = texSet && texSet.ready;
    if (isLeaf) {
      mat.map = ready ? (texSet.leafMap || null) : null;
      mat.alphaTest = ready ? (texSet.leafAlphaTest ?? 0.5) : 0;
    } else {
      mat.map = ready ? (texSet.barkMap || null) : null;
      mat.normalMap = ready ? (texSet.barkNormalMap || null) : null;
    }
  }

  function makeMat(texSet, isLeaf, doubleSide) {
    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: isLeaf ? 1.0 : 0.9, metalness: 0,
      side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    });
    bindTextures(mat, texSet, isLeaf);
    materials.push(mat);
    return mat;
  }

  // One orthographic capture per variant into a PNG-free CanvasTexture, matching the game's bake.
  async function bakeBillboard(variant, texSet) {
    const target = new THREE.RenderTarget(BILL_SIZE, BILL_SIZE, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType });
    const bakeScene = new THREE.Scene();
    const branchMat = new THREE.MeshStandardMaterial({ vertexColors: true });
    const leafMat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide });
    bindTextures(branchMat, texSet, false); bindTextures(leafMat, texSet, true);
    const branchMesh = new THREE.Mesh(variant.branches, branchMat);
    const leafMesh = new THREE.Mesh(variant.leaves, leafMat);
    bakeScene.add(branchMesh, leafMesh);
    const sun = new THREE.DirectionalLight(billLook.bakeTint, billLook.bakeSun); sun.position.set(2, 4, 3);
    bakeScene.add(sun, new THREE.AmbientLight(billLook.bakeTint, billLook.bakeAmbient));

    const box = new THREE.Box3().setFromObject(branchMesh).expandByObject(leafMesh);
    const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    const halfH = size.y * 0.55, halfW = Math.max(size.x, size.z) * 0.55;
    const cam = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.1, 500);
    const dist = Math.max(size.x, size.z) * 2;
    cam.position.set(center.x, center.y + size.y * billLook.pitch, center.z + dist);
    cam.lookAt(center);

    const oldClear = new THREE.Color(); renderer.getClearColor(oldClear);
    const oldAlpha = renderer.getClearAlpha();
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(target);
    renderer.clear(true, true, true);
    await renderer.renderAsync(bakeScene, cam);
    renderer.setRenderTarget(null);
    renderer.setClearColor(oldClear, oldAlpha);
    const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, BILL_SIZE, BILL_SIZE);
    target.dispose(); branchMat.dispose(); leafMat.dispose();

    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = BILL_SIZE;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(BILL_SIZE, BILL_SIZE);
    img.data.set(pixels.subarray(0, BILL_SIZE * BILL_SIZE * 4));
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = true;
    billboardTextures.push(tex);
    return { tex, size, center };
  }

  // A canvas-text sprite beside each cluster, sized with its distance so it reads at every ring.
function makeLabel(text, distance) {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(20,24,30,0.7)'; ctx.fillRect(0, 0, 512, 128);
  ctx.font = 'bold 64px system-ui, sans-serif'; ctx.fillStyle = '#e8edf3';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(text, 256, 64);
  const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  const w = Math.max(4, distance * 0.08);
  sprite.scale.set(w, w / 4, 1);
  sprite.userData.dispose = () => { tex.dispose(); mat.dispose(); };
  return sprite;
}

function billboardGeo(size, center) {
    const g = new THREE.PlaneGeometry(Math.max(size.x, size.z) * 1.15, size.y * 1.05);
    g.translate(0, center.y, 0);
    return g;
  }

  function billMaterial(tex) {
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: billLook.alphaTest, side: THREE.DoubleSide });
    mat.color.setScalar(billBrightness * billLook.gain);
    materials.push(mat); billMats.push(mat);
    return mat;
  }
  function setBillboardBrightness(v) {
    billBrightness = Math.max(0.05, v);
    for (const m of billMats) m.color.setScalar(billBrightness * billLook.gain);
  }
  // Live keys (gain, alphaTest) apply at once; bake keys (bakeSun, bakeAmbient, bakeTint, pitch) need a rebuild.
  function setBillboardLook(patch) {
    Object.assign(billLook, patch);
    for (const m of billMats) {
      m.color.setScalar(billBrightness * billLook.gain);
      if (m.alphaTest !== billLook.alphaTest) { m.alphaTest = billLook.alphaTest; m.needsUpdate = true; }
    }
  }

  // Builds the clusters. `params` = { branchLods, coarseLeafRatio, coarseLeafSizeMult, rings,
  // billboards }. `layout` 'rings' puts tier k at rings[k] along +Z (LOD3 at rings[2] * 1.25);
  // 'side' puts every tier at `distance`, spread along X. Returns per-tier stats.
  async function build({ opts, texSet, n = 3, params, layout = 'rings', distance = 100, leafShadowPct = 0.3, density = 120 }) {
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
    const tierCount = params.billboards ? 4 : 3;
    const spacing = Math.max(6, opts.length[0] * 1.2);
    const offsets = clusterOffsets(n, spacing);
    const groups = [];
    stats = [];
    for (let k = 0; k < tierCount; k++) {
      const g = new THREE.Group(); g.name = TIER_NAMES[k];
      const z = layout === 'rings' ? (k < 3 ? params.rings[k] : params.rings[2] * 1.25) : distance;
      const x = layout === 'rings' ? 0 : (k - (tierCount - 1) / 2) * spacing * (Math.ceil(Math.sqrt(n)) + 1);
      g.position.set(x, 0, z);
      root.add(g); groups.push(g);
      stats.push({ name: TIER_NAMES[k], tris: 0, leaves: 0, distance: z });
      if (typeof document !== 'undefined') {
        const label = makeLabel(`${TIER_NAMES[k]} · ${Math.round(z)} m`, z);
        const clusterR = spacing * (Math.ceil(Math.sqrt(n)) + 0.5);
        label.position.set(clusterR + label.scale.x * 0.5, opts.length[0] * 0.6, 0);
        g.add(label); labels.push(label);
      }
    }
    const barkL0 = makeMat(texSet, false, false), leafL0 = makeMat(texSet, true, true);
    const barkL1 = makeMat(texSet, false, false), leafL1 = makeMat(texSet, true, false);
    const barkL2 = makeMat(texSet, false, false), leafL2 = makeMat(texSet, true, false);
    palette.variants.forEach((v, i) => {
      const [ox, oz] = offsets[i];
      const place = (mesh, group) => { mesh.position.set(ox, 0, oz); mesh.castShadow = mesh.receiveShadow = true; group.add(mesh); };
      place(new THREE.Mesh(v.branches, barkL0), groups[0]);
      place(new THREE.Mesh(v.leaves, leafL0), groups[0]);
      place(new THREE.Mesh(v.shadow, leafL0), groups[0]);
      place(new THREE.Mesh(v.branchesLod1 ?? v.branches, barkL1), groups[1]);
      place(new THREE.Mesh(v.leaves, leafL1), groups[1]);
      place(new THREE.Mesh(v.branchesLod2 ?? v.branches, barkL2), groups[2]);
      place(new THREE.Mesh(v.leavesCoarse, leafL2), groups[2]);
      stats[0].tris += tris(v.branches) + tris(v.leaves) + tris(v.shadow);
      stats[0].leaves += leafCount(v.leaves) + leafCount(v.shadow);
      stats[1].tris += tris(v.branchesLod1 ?? v.branches) + tris(v.leaves);
      stats[1].leaves += leafCount(v.leaves);
      stats[2].tris += tris(v.branchesLod2 ?? v.branches) + tris(v.leavesCoarse);
      stats[2].leaves += leafCount(v.leavesCoarse);
    });
    if (params.billboards) {
      for (let i = 0; i < palette.variants.length; i++) {
        const { tex, size, center } = await bakeBillboard(palette.variants[i], texSet);
        if (token !== bakeToken) return stats;   // a newer build replaced this one mid-bake
        const mesh = new THREE.Mesh(billboardGeo(size, center), billMaterial(tex));
        const [ox, oz] = offsets[i];
        mesh.position.set(ox, 0, oz);
        groups[3].add(mesh);
        billboards.push(mesh);
        stats[3].tris += 2;
      }
    }
    return stats;
  }

  // Fill: one instanced mesh per (variant, tier, part) across a jittered grid that runs from the eye
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
  }

  function bounds() { return new THREE.Box3().setFromObject(root); }
  // Frees every baked resource but keeps the (empty) root in the scene so the next build can use it.
  function dispose() { disposeAll(); }

  return { build, update, bounds, dispose, setBillboardBrightness, setBillboardLook, billLook, get stats() { return stats; }, get tierNames() { return TIER_NAMES; } };
}
