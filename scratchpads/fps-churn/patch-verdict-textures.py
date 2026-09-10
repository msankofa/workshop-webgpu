# Authored tree textures make TextureNode object-typed (its uv matrix uniform): allow it and watch the texture's matrix and version in the mark.
p = 'forest-gpu.js'; s = open(p, encoding='utf-8').read()
old = """  if (type === 'MaterialReferenceNode') return null;   // material values; tracked by material.version
  return type;
}"""
new = """  if (type === 'MaterialReferenceNode') return null;   // material values; tracked by material.version
  // An authored map's node is object-typed for its uv matrix uniform (three.webgpu.js:12467); the value is the texture's, so the mark watches texture.matrix and texture.version instead.
  if (type === 'TextureNode' && node.value?.isTexture) return null;
  return type;
}"""
assert s.count(old) == 1; s = s.replace(old, new)
old = """  for (const node of state.updateNodes ?? []) {
    const updateType = node.getUpdateType?.() ?? node.updateType;"""
new = """  const textures = [];
  for (const node of state.updateNodes ?? []) {
    const updateType = node.getUpdateType?.() ?? node.updateType;
    if (updateType === 'object' && node.constructor?.type === 'TextureNode' && node.value?.isTexture && !textures.includes(node.value)) textures.push(node.value);"""
assert s.count(old) == 1; s = s.replace(old, new)
old = """    if (refused) return { ok: false, reason: `${refused} is not on the object-group allowlist` };
  }
  return { ok: true, reason: null };
}"""
new = """    if (refused) return { ok: false, reason: `${refused} is not on the object-group allowlist` };
  }
  return { ok: true, reason: null, textures };
}"""
assert s.count(old) == 1; s = s.replace(old, new)
old = """    m.matrix.set(object.matrixWorld.elements);
    m.pending = true;            // only the commit hook clears this, after the work actually ran"""
new = """    m.matrix.set(object.matrixWorld.elements);
    const textures = verdict?.textures ?? [];
    if (!m.tex || m.tex.length !== textures.length) m.tex = textures.map(() => ({ version: -1, matrix: new Float64Array(9) }));
    for (let i = 0; i < textures.length; i++) { m.tex[i].version = textures[i].version; m.tex[i].matrix.set(textures[i].matrix.elements); }
    m.pending = true;            // only the commit hook clears this, after the work actually ran"""
assert s.count(old) == 1; s = s.replace(old, new)
old = """      for (let i = 0; i < 16; i++) if (m.matrix[i] !== e[i]) return mark(renderObject);
      ctx.stats.skipped++;"""
new = """      for (let i = 0; i < 16; i++) if (m.matrix[i] !== e[i]) return mark(renderObject);
      // A texture's uv transform or image change would go into every mesh's own UBO; neither bumps material.version.
      const textures = verdict.textures ?? [];
      for (let t = 0; t < textures.length; t++) {
        const tex = textures[t], rec = m.tex[t];
        if (rec.version !== tex.version) return mark(renderObject);
        const te = tex.matrix.elements;
        for (let i = 0; i < 9; i++) if (rec.matrix[i] !== te[i]) return mark(renderObject);
      }
      ctx.stats.skipped++;"""
assert s.count(old) == 1; s = s.replace(old, new)
open(p, 'w', encoding='utf-8', newline='').write(s)

p = 'test-forest-object-group.mjs'; t = open(p, encoding='utf-8').read()
old = "section('a graph with a per-object updateBefore or updateAfter node is refused');"
new = """section('authored tree textures, as on the page: the map nodes are object-typed and allowed');
{
  // The page binds bark, bark-normal and leaf maps; three gives each map node a uv-matrix uniform in the object group, which made the verdict refuse every graph on 2026-09-10.
  const shadowScene = new THREE.Scene();
  const sun = new THREE.DirectionalLight(); sun.castShadow = true; shadowScene.add(sun);
  const set = { mode: 'authored', barkMap: new THREE.Texture(), barkNormalMap: new THREE.Texture(), leafMap: new THREE.Texture(), leafAlphaTest: 0.5 };
  const f = makeBaseGameForest({});
  f.applyTextureSet((b, l) => bindTreeMaterials(b, l, set));
  for (const role of ['branchesL0', 'leavesL0']) {
    const mesh = f.variantMeshes(0).find(m => m.name === `forest:v0:${role}`);
    const b = THREE.WebGPUBackend.prototype.createNodeBuilder(mesh, renderer);
    b.scene = shadowScene; b.camera = camera; b.material = mesh.material;
    b.lightsNode = new THREE.LightsNode().setLights([sun]);
    b.environmentNode = null; b.fogNode = null; b.clippingContext = null; b.build();
    const texNodes = b.updateNodes.filter(n => n.constructor?.type === 'TextureNode' && (n.getUpdateType?.() ?? n.updateType) === 'object');
    check(`${role}: the graph carries an object-typed TextureNode`, texNodes.length >= 1, String(texNodes.length));
    const v = forestGraphVerdict(stateOf(b));
    check(`${role}: the verdict allows it`, v.ok === true, v.reason ?? '');
    check(`${role}: and lists its textures for the mark`, v.textures.length === texNodes.length && v.textures.every(x => x.isTexture), String(v.textures?.length));
  }
  f.dispose();
}

section('a graph with a per-object updateBefore or updateAfter node is refused');"""
assert t.count(old) == 1; t = t.replace(old, new)
open(p, 'w', encoding='utf-8', newline='').write(t)

p = 'test-forest-static-observer.mjs'; t = open(p, encoding='utf-8').read()
old = "section('the same mesh in three passes keeps three sets of books');"
new = """section('an authored texture: its uv transform and image changes refresh the second mesh too');
{
  // Neither texture.matrix nor texture.version bumps material.version, and the map's uv-matrix uniform lives in each mesh's own UBO.
  const rT = makeRenderer();
  const set = { mode: 'authored', barkMap: new THREE.Texture(), barkNormalMap: new THREE.Texture(), leafMap: new THREE.Texture(), leafAlphaTest: 0.5 };
  const fT = makeForest(rT);
  fT.applyTextureSet((b, l) => bindTreeMaterials(b, l, set));
  const m0 = fT.variantMeshes(0).find(m => m.name === 'forest:v0:branchesL0');
  const m1 = fT.variantMeshes(1).find(m => m.name === 'forest:v1:branchesL0');
  const bT = buildObserver(rT, m0);
  const a = makeRenderObject(m0, bT, 'a'), c = makeRenderObject(m1, bT, 'c');
  const renderT = () => { const f = frame(rT), log = []; renderObjectDirect(rT, a, f, { log }); renderObjectDirect(rT, c, f, { log }); return log; };
  renderT(); renderT();
  check('settled: one refresh', JSON.stringify(renderT()) === '["a"]');
  set.barkMap.repeat.set(2, 2); set.barkMap.updateMatrix();
  check('a uv transform change refreshes both', JSON.stringify(renderT()) === '["a","c"]');
  check('and settles', JSON.stringify(renderT()) === '["a"]');
  set.barkMap.needsUpdate = true;
  check('an image change (needsUpdate) refreshes both', JSON.stringify(renderT()) === '["a","c"]');
  check('and settles', JSON.stringify(renderT()) === '["a"]');
  fT.dispose();
}

section('the same mesh in three passes keeps three sets of books');"""
assert t.count(old) == 1; t = t.replace(old, new)
open(p, 'w', encoding='utf-8', newline='').write(t)
print('patched')
