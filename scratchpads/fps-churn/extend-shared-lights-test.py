# Inserts the review-coverage section into test-three-shared-light-uniforms.mjs before the flag-off section.
p = 'test-three-shared-light-uniforms.mjs'
lines = open(p, encoding='utf-8').read().split('\n')
idx = next(i for i, l in enumerate(lines) if 'upstream behaviour (flag off)' in l)
if any('correctness coverage (Astra review' in l for l in lines):
    print('already extended'); raise SystemExit
block = r'''console.log('\ncorrectness coverage (Astra review, 2026-09-09)');
{
  THREE.setSharedLightUniforms(true);
  // Two lights never share: the cache is per light.
  const a = new THREE.PointLight(0xff0000, 1, 10, 2), b = new THREE.PointLight(0x00ff00, 1, 20, 1);
  const na = new THREE.PointLightNode(a), nb = new THREE.PointLightNode(b);
  check('different lights get different shared nodes', na.colorNode !== nb.colorNode && na.cutoffDistanceNode !== nb.cutoffDistanceNode);
  // Property mutation reaches every node instance through the one shared value.
  const n1 = new THREE.PointLightNode(a), n2 = new THREE.PointLightNode(a);
  a.distance = 33; a.decay = 0.5; a.intensity = 4;
  n1.update({});
  check('a mutated light property is read on update by every node sharing it', n2.cutoffDistanceNode.value === 33 && n2.decayExponentNode.value === 0.5 && Math.abs(n2.colorNode.value.r - 4) < 1e-6);
  // Shadow-casting spot: cone, penumbra and colour nodes shared per light, reading live values.
  const spot = new THREE.SpotLight(0xffffff, 1); spot.castShadow = true;
  const s1 = new THREE.SpotLightNode(spot), s2 = new THREE.SpotLightNode(spot);
  check('spot cone, penumbra and colour nodes are shared per light', s1.coneCosNode === s2.coneCosNode && s1.penumbraCosNode === s2.penumbraCosNode && s1.colorNode === s2.colorNode);
  spot.angle = 0.4; s1.update({});
  check('a changed spot angle reaches the shared cone node', Math.abs(s2.coneCosNode.value - Math.cos(0.4)) < 1e-9);
  // Two different material graphs lit by one light set: the light's shared nodes are the same objects in both.
  const { meshes, build } = rig();
  const phong = new THREE.MeshPhongNodeMaterial({ color: 0x445566 });
  const other = new THREE.InstancedMesh(meshes[0].geometry, phong, 4); other.receiveShadow = true;
  const ba = build(meshes[0]), bo = build(other);
  const ida = new Set(renderIds(ba)), ido = renderIds(bo);
  const sharedCount = ido.filter(id => ida.has(id)).length;
  check('a Standard and a Phong material lit by the same lights share the light uniform nodes', sharedCount >= 6, `${sharedCount} shared of ${ido.length}`);
  check('but their render groups are not identical (different graphs)', !same(renderIds(ba), ido));
  // Disposal and recreation: the shared nodes live on the light, not on the node.
  const before = n1.colorNode; n1.dispose(); const n3 = new THREE.PointLightNode(a);
  check('after disposing a light node, a new node for the same light reuses the shared uniforms', n3.colorNode === before);
  const fresh = new THREE.PointLight(0xffffff, 1); const nf = new THREE.PointLightNode(fresh);
  check('a fresh light gets fresh nodes', nf.colorNode !== before && nf.colorNode.value.r === 0);
  // Flag off after nodes exist: new nodes are private again; existing shared ones are untouched.
  THREE.setSharedLightUniforms(false);
  const p1 = new THREE.PointLightNode(a), p2 = new THREE.PointLightNode(a);
  check('with the flag off, new nodes for the same light are private, as upstream', p1.colorNode !== p2.colorNode && p1.colorNode !== before);
  THREE.setSharedLightUniforms(true);
  check('the accessor reports the flag', THREE.getSharedLightUniforms() === true);
}
// Not covered here, stated: the render bind group is cached per render context, so a shadow pass and
// the main pass never share a buffer, and camera-dependent light values (view position) were already
// per-light nodes upstream with onRenderUpdate; both are exercised only in the browser.
'''
lines[idx:idx] = block.split('\n')
open(p, 'w', encoding='utf-8', newline='').write('\n'.join(lines))
print('test extended')
