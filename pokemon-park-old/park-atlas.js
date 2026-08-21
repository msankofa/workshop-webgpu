// One Pokemon per draw call. The Stadium models are ~690 triangles split across 10-18 primitives,
// one per material, one texture each — so an unmerged creature costs 10-18 draws for nothing.

/** Shelf-pack rectangles into a square power-of-two atlas. Pure. */
export function packTiles(sizes, { padding = 1, maxSize = 1024 } = {}) {
  const order = sizes.map((s, i) => ({ i, w: s.w + padding * 2, h: s.h + padding * 2 }))
    .sort((a, b) => b.h - a.h || b.w - a.w);
  for (let size = 16; size <= maxSize; size *= 2) {
    const tiles = new Array(sizes.length);
    let x = 0, y = 0, shelf = 0, ok = true;
    for (const r of order) {
      if (r.w > size || r.h > size) { ok = false; break; }
      if (x + r.w > size) { x = 0; y += shelf; shelf = 0; }
      if (y + r.h > size) { ok = false; break; }
      tiles[r.i] = { x: x + padding, y: y + padding, w: r.w - padding * 2, h: r.h - padding * 2 };
      x += r.w;
      shelf = Math.max(shelf, r.h);
    }
    if (ok) return { size, tiles };
  }
  return null;
}

/** A tile's [u, v, du, dv] in atlas space, inset by half a texel so linear filtering cannot bleed. */
export function tileRect(tile, size) {
  const h = 0.5 / size;
  return [tile.x / size + h, tile.y / size + h, tile.w / size - h * 2, tile.h / size - h * 2];
}

/**
 * Merge parts sharing one skeleton into a single geometry, tagging each vertex with its atlas tile.
 * Every Stadium primitive carries the same attribute set, which is what makes this safe.
 */
export function mergeAtlasGeometry(THREE, parts) {
  const ATTRS = ['position', 'normal', 'uv', 'skinIndex', 'skinWeight'];
  let verts = 0, indices = 0;
  for (const p of parts) {
    verts += p.geometry.attributes.position.count;
    indices += p.geometry.index ? p.geometry.index.count : p.geometry.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  const sizeOf = { position: 3, normal: 3, uv: 2, skinIndex: 4, skinWeight: 4 };
  const dst = {};
  for (const a of ATTRS) dst[a] = new Float32Array(verts * sizeOf[a]);
  const tiles = new Float32Array(verts * 4);
  const idx = verts > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);

  let vBase = 0, iBase = 0;
  for (const p of parts) {
    const g = p.geometry;
    const n = g.attributes.position.count;
    for (const a of ATTRS) {
      const src = g.attributes[a];
      const w = sizeOf[a];
      if (!src) { dst[a].fill(0, vBase * w, (vBase + n) * w); continue; }
      for (let k = 0; k < n; k++) {
        for (let c = 0; c < w; c++) dst[a][(vBase + k) * w + c] = src.getComponent(k, c);
      }
    }
    for (let k = 0; k < n; k++) for (let c = 0; c < 4; c++) tiles[(vBase + k) * 4 + c] = p.tile[c];
    if (g.index) for (let k = 0; k < g.index.count; k++) idx[iBase + k] = g.index.getX(k) + vBase;
    else for (let k = 0; k < n; k++) idx[iBase + k] = k + vBase;
    iBase += g.index ? g.index.count : n;
    vBase += n;
  }

  out.setAttribute('position', new THREE.BufferAttribute(dst.position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(dst.normal, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(dst.uv, 2));
  out.setAttribute('skinIndex', new THREE.BufferAttribute(dst.skinIndex, 4));
  out.setAttribute('skinWeight', new THREE.BufferAttribute(dst.skinWeight, 4));
  out.setAttribute('atlasTile', new THREE.BufferAttribute(tiles, 4));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

/**
 * The atlas material. The clamp is per fragment on purpose: every source sampler is CLAMP_TO_EDGE and
 * a quarter of the UVs run outside 0..1, so baking the clamp into the vertices restretches those faces.
 */
export function atlasMaterial({ TSL, MeshStandardNodeMaterial, atlas, side, transparent }) {
  const { attribute, texture, uv } = TSL;
  const tile = attribute('atlasTile', 'vec4');
  const sample = texture(atlas, tile.xy.add(uv().clamp(0, 1).mul(tile.zw)));
  const material = new MeshStandardNodeMaterial({
    side, metalness: 0, roughness: 0.9,
    transparent: !!transparent,
    alphaTest: transparent ? 0 : 0.5,
  });
  material.colorNode = sample;
  material.opacityNode = sample.a;
  return material;
}

/** Meshes that can share one draw: same sidedness, same blend mode. */
export function groupKey(material) {
  return `${material.side}|${material.transparent ? 'blend' : 'mask'}`;
}

/**
 * Collapse one loaded species into as few skinned draws as its materials allow.
 * Returns { before, after, meshes, textures } or null when the meshes are not safe to merge.
 */
export function atlasSkinnedRoot(THREE, root, { TSL, MeshStandardNodeMaterial, padding = 4, maxSize = 1024 } = {}) {
  const meshes = [];
  root.traverse((o) => { if (o.isSkinnedMesh) meshes.push(o); });
  if (meshes.length < 2) return null;

  // Everything must hang off one parent with one skeleton, or the merged vertices land in the wrong space.
  const parent = meshes[0].parent;
  const skeleton = meshes[0].skeleton;
  for (const m of meshes) {
    if (m.parent !== parent || m.skeleton !== skeleton) return null;
    if (!m.matrix.equals(meshes[0].matrix)) return null;
  }

  const groups = new Map();
  for (const m of meshes) {
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    if (!mat?.map?.image) return null;
    const key = groupKey(mat);
    if (!groups.has(key)) groups.set(key, { side: mat.side, transparent: !!mat.transparent, parts: [] });
    groups.get(key).parts.push({ mesh: m, mat });
  }

  const made = [];
  const textures = [];
  for (const g of groups.values()) {
    // One tile per distinct image, so a texture shared by four primitives is packed once.
    const images = [];
    const slotOf = new Map();
    for (const p of g.parts) {
      const img = p.mat.map.image;
      if (!slotOf.has(img)) { slotOf.set(img, images.length); images.push(img); }
    }
    const packed = packTiles(images.map((im) => ({ w: im.width, h: im.height })), { padding, maxSize });
    if (!packed) return null;

    const canvas = document.createElement('canvas');
    canvas.width = packed.size; canvas.height = packed.size;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    for (let i = 0; i < images.length; i++) {
      const t = packed.tiles[i];
      // Stretched first, exact on top: the overspill is the edge-replicated border the mips read.
      ctx.drawImage(images[i], t.x - padding, t.y - padding, t.w + padding * 2, t.h + padding * 2);
      ctx.drawImage(images[i], t.x, t.y, t.w, t.h);
    }
    const atlas = new THREE.CanvasTexture(canvas);
    atlas.colorSpace = THREE.SRGBColorSpace;
    atlas.flipY = false;
    atlas.anisotropy = 4;
    atlas.needsUpdate = true;
    textures.push(atlas);

    const geometry = mergeAtlasGeometry(THREE, g.parts.map((p) => ({
      geometry: p.mesh.geometry,
      tile: tileRect(packed.tiles[slotOf.get(p.mat.map.image)], packed.size),
    })));

    const material = atlasMaterial({
      TSL, MeshStandardNodeMaterial, atlas, side: g.side, transparent: g.transparent,
    });

    const merged = new THREE.SkinnedMesh(geometry, material);
    merged.name = `${root.name || 'species'}-atlas`;
    merged.castShadow = g.parts[0].mesh.castShadow;
    merged.receiveShadow = g.parts[0].mesh.receiveShadow;
    merged.frustumCulled = g.parts[0].mesh.frustumCulled;
    merged.matrix.copy(g.parts[0].mesh.matrix);
    merged.matrix.decompose(merged.position, merged.quaternion, merged.scale);
    merged.bindMode = g.parts[0].mesh.bindMode;
    parent.add(merged);
    merged.bind(skeleton, g.parts[0].mesh.bindMatrix);
    made.push(merged);
  }

  for (const m of meshes) {
    m.removeFromParent();
    m.geometry.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat?.dispose();
  }
  return { before: meshes.length, after: made.length, meshes: made, textures };
}
