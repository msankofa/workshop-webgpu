// Phase 4 flora wiring in base-game-flora.js: a structure (the spawn building) wraps the terrain
// samplers inside its rectangle, and an occluder root feeds the compute grass's depth test.
// Run from the repo root ONLY when no other session has base-game-flora.js open.
const fs = require('fs');
const file = 'base-game-flora.js';
let s = fs.readFileSync(file, 'utf8');
const rx = (a) => new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\r?\n/g, '\\r?\\n'));
const rep = (a, b) => { const r = rx(a); if (!r.test(s)) throw new Error('missing: ' + a.slice(0, 90)); s = s.replace(r, () => b); };

rep(`import { Fn, float, vec2, uniform, select, mix, length } from 'three/tsl';`,
    `import { Fn, float, vec2, uniform, select, mix, length, texture, clamp, step } from 'three/tsl';
import { createFloraOcclusion } from './flora-occlusion.js';`);

rep(`  let grass = null, grassModule = null, onMeshCb = null, uCoverGate = null, uCoverFloor = null;`,
    `  let grass = null, grassModule = null, onMeshCb = null, uCoverGate = null, uCoverFloor = null;
  // A structure (the spawn building): inside its global rectangle the density and height come
  // from its painted textures, a planter biome, and the terrain samplers stop applying. The
  // textures are read through nodes whose values swap on setStructure, so no graph rebuild.
  let structure = null;
  const uStructOn = uniform(0);
  const uStructMin = uniform(new injectedTHREE.Vector2());
  const uStructSize = uniform(new injectedTHREE.Vector2(1, 1));
  const placeholderTex = new injectedTHREE.DataTexture(new Float32Array([0]), 1, 1, injectedTHREE.RedFormat, injectedTHREE.FloatType);
  placeholderTex.minFilter = placeholderTex.magFilter = injectedTHREE.NearestFilter;   // r32float is unfilterable
  placeholderTex.needsUpdate = true;
  const structDensityNode = texture(placeholderTex);
  const structHeightNode = texture(placeholderTex);
  // The occluder depth image the cull kernels test against; built on the first setOccluders.
  let occlusion = null, occluderRoot = null;
  function wrapStructure(samplers) {
    const originXZ = vec2(uRenderOrigin.x, uRenderOrigin.z);
    const inside = (g) => {
      const t = g.sub(uStructMin).div(uStructSize);
      return uStructOn.greaterThan(0.5)
        .and(t.x.greaterThan(0)).and(t.x.lessThan(1)).and(t.y.greaterThan(0)).and(t.y.lessThan(1));
    };
    const uvOf = (g) => clamp(g.sub(uStructMin).div(uStructSize), 0, 1);
    const terrainDensity = samplers.densityNode || Fn(() => float(1));
    const densityNode = Fn(([x, z]) => {
      const g = vec2(x, z).add(originXZ);
      return select(inside(g), structDensityNode.sample(uvOf(g)).r, terrainDensity(x, z));
    });
    const heightNode = Fn(([x, z]) => {
      const g = vec2(x, z).add(originXZ);
      return select(inside(g), structHeightNode.sample(uvOf(g)).r.sub(uRenderOrigin.y), samplers.heightNode(x, z));
    });
    return { ...samplers, densityNode, heightNode };
  }`);

rep(`    const samplers = buildSamplers();`, `    const samplers = wrapStructure(buildSamplers());`);

rep(`      frustumCull: cfg.grassFrustumCull,`, `      frustumCull: cfg.grassFrustumCull,
      occlusion: occlusion ? occlusion.state : null,`);

rep(`      await grass.update(seconds);`, `      if (occlusion && occlusion.state.enabled) occlusion.update();
      await grass.update(seconds);`);

rep(`    onMesh(fn) { onMeshCb = fn; if (grass) fn(grass.mesh); },`,
    `    onMesh(fn) { onMeshCb = fn; if (grass) fn(grass.mesh); },
    // { bounds: {minX, minZ, worldX, worldZ}, densityTex, heightTex } in GLOBAL metres, or null.
    // Live: the uniforms and texture nodes swap without a rebuild.
    setStructure(next) {
      structure = next || null;
      uStructOn.value = structure ? 1 : 0;
      if (structure) {
        uStructMin.value.set(structure.bounds.minX, structure.bounds.minZ);
        uStructSize.value.set(Math.max(1e-3, structure.bounds.worldX), Math.max(1e-3, structure.bounds.worldZ));
        structDensityNode.value = structure.densityTex;
        structHeightNode.value = structure.heightTex;
      } else {
        structDensityNode.value = placeholderTex;
        structHeightNode.value = placeholderTex;
      }
      grass?.forceRecull?.();
    },
    // The group whose opaque meshes occlude blades. The kernels compile the test in at build, so
    // the first call before the grass exists is free; a later first call rebuilds the field.
    setOccluders(root) {
      occluderRoot = root || null;
      if (!occluderRoot) { if (occlusion) occlusion.setEnabled(false); return; }
      if (!occlusion) {
        occlusion = createFloraOcclusion({ renderer, scene, camera });
        if (grass) rebuild();
      }
      occlusion.setEnabled(true);
      occlusion.markOccluders(occluderRoot);
    },
    setOcclusionEnabled(on) { if (occlusion) occlusion.setEnabled(!!on); },
    get occlusion() { return occlusion ? occlusion.state : null; },`);

rep(`      if (grass) { scene.remove(grass.mesh); grass.dispose(); grass = null; }`,
    `      if (grass) { scene.remove(grass.mesh); grass.dispose(); grass = null; }
      if (occlusion) { occlusion.dispose(); occlusion = null; }
      placeholderTex.dispose();`);

fs.writeFileSync(file, s);
console.log('base-game-flora.js: structure samplers and occluders wired');
