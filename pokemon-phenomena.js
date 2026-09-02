/**
 * Stadium texture swaps and persistent model-bound effects.
 *
 * Texture indices and frame streams come from the ROM-generated phenomena sidecar. Visual effects are
 * deliberately separate records because a tail flame is an effect attached to the model in Stadium,
 * not another texture in its GLB.
 */

const DEFAULT_FPS = 30;
const DEFAULT_CADENCE = 4;

const positiveMod = (value, modulus) => ((value % modulus) + modulus) % modulus;

/** Pick the ROM texture-stream frame used by an ambient one-shot such as a blink. */
export function ambientFrameAt(animation, seconds, { fps = DEFAULT_FPS, cadence = DEFAULT_CADENCE } = {}) {
  if (!animation?.frameCount) return 0;
  const duration = animation.frameCount / fps;
  const period = Math.max(cadence, duration + 1.5);
  const phase = positiveMod(Number(seconds) || 0, period);
  const start = period - duration;
  if (phase < start) return 0;
  return Math.min(animation.frameCount - 1, Math.floor((phase - start) * fps));
}

export function textureIndexAt(channel, frame) {
  const frames = channel?.textures || [];
  if (!frames.length) return null;
  return frames[Math.max(0, Math.min(frames.length - 1, Math.floor(frame) || 0))];
}

function objectForNode(gltf, nodeIndex) {
  for (const [object, ref] of gltf.parser.associations || []) {
    if (ref?.nodes === nodeIndex) return object;
  }
  return null;
}

/** Resolve a glTF material index to the material instances actually attached to rendered primitives. */
export function renderedMaterialsForIndex(gltf, materialIndex, fallback = null) {
  const found = new Set();
  gltf.scene.traverse?.((object) => {
    if (!object.isMesh) return;
    const objectAssociation = gltf.parser.associations?.get(object);
    const primitiveMaterialIndex = gltf.parser.json?.meshes?.[objectAssociation?.meshes]
      ?.primitives?.[objectAssociation?.primitives]?.material;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material) continue;
      const materialAssociation = gltf.parser.associations?.get(material);
      if (primitiveMaterialIndex === materialIndex
        || materialAssociation?.materials === materialIndex
        || material === fallback) found.add(material);
    }
  });
  if (!found.size && fallback) found.add(fallback);
  return [...found];
}

function flameTexture(THREE) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(32, 34, 2, 32, 34, 30);
  gradient.addColorStop(0, 'rgba(255,255,220,1)');
  gradient.addColorStop(0.18, 'rgba(255,244,92,1)');
  gradient.addColorStop(0.5, 'rgba(255,105,10,.9)');
  gradient.addColorStop(1, 'rgba(150,15,0,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createFlame(THREE, gltf, spec, sharedTexture) {
  const target = objectForNode(gltf, spec.anchor?.node);
  if (!target) return null;
  const anchor = new THREE.Group();
  anchor.name = 'pokemon-tail-flame';
  anchor.position.fromArray(spec.anchor.offset || [0, 0, 0]);
  target.add(anchor);
  const targetScale = new THREE.Vector3();
  const sceneScale = new THREE.Vector3();
  const layers = [
    { color: 0xff4b08, scale: 0.82, y: 0, opacity: 0.72 },
    { color: 0xffa412, scale: 0.56, y: 0.04, opacity: 0.9 },
    { color: 0xfff1a0, scale: 0.29, y: 0.08, opacity: 1 },
    { color: 0xff7210, scale: 0.24, y: 0.12, opacity: 0.65, rise: 0.58, phase: 0.12, speed: 0.78 },
    { color: 0xffb32b, scale: 0.18, y: 0.08, opacity: 0.62, rise: 0.68, phase: 0.57, speed: 0.91 },
  ];
  const sprites = layers.map((layer) => {
    const material = new THREE.SpriteMaterial({
      map: sharedTexture,
      color: layer.color,
      transparent: true,
      opacity: layer.opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.y = layer.y * spec.scale;
    sprite.scale.setScalar(spec.scale * layer.scale);
    sprite.userData.baseScale = spec.scale * layer.scale;
    sprite.userData.layer = layer;
    anchor.add(sprite);
    return sprite;
  });
  return {
    anchor,
    sprites,
    update(seconds) {
      // Keep the attachment parented to the moving bone (so movement clones inherit it), but cancel the
      // Stadium rig's internal scale leaves so the authored creature-relative flame size stays stable.
      target.getWorldScale(targetScale);
      gltf.scene.getWorldScale(sceneScale);
      anchor.scale.set(
        targetScale.x ? sceneScale.x / targetScale.x : 1,
        targetScale.y ? sceneScale.y / targetScale.y : 1,
        targetScale.z ? sceneScale.z / targetScale.z : 1,
      );
      for (let i = 0; i < sprites.length; i += 1) {
        const sprite = sprites[i];
        const layer = sprite.userData.layer;
        const flicker = 0.88 + 0.12 * Math.sin(seconds * (15 + i * 3) + i * 1.7);
        const stretch = 1.08 + 0.16 * Math.sin(seconds * (11 + i * 2) + i);
        const rise = layer.rise ? positiveMod(seconds * layer.speed + layer.phase, 1) : 0;
        const fade = 1 - rise * 0.52;
        sprite.scale.set(
          sprite.userData.baseScale * flicker * fade,
          sprite.userData.baseScale * stretch * (1 - rise * 0.28),
          1,
        );
        sprite.position.set(
          Math.sin(seconds * (7 + i) + i) * spec.scale * (layer.rise ? 0.11 : 0.035),
          (layer.y + rise * (layer.rise || 0)) * spec.scale,
          Math.cos(seconds * (5 + i) + i * 2.1) * spec.scale * (layer.rise ? 0.06 : 0.015),
        );
        sprite.material.opacity = layer.opacity * (1 - rise * 0.7);
      }
    },
    dispose() {
      target.remove(anchor);
      for (const sprite of sprites) sprite.material.dispose();
    },
  };
}

/**
 * Bind one parsed GLTF to its generated phenomena record.
 * Loading is asynchronous because unused embedded GLB textures are lazy dependencies in GLTFLoader.
 */
export async function createPokemonPhenomena({ THREE, gltf, spec }) {
  if (!spec) return { update() {}, setEnabled() {}, dispose() {}, active: false };
  const animation = spec.textureAnimations?.[spec.ambientTextureAnimation] || null;
  const bindings = [];
  if (animation) {
    for (const channel of animation.channels || []) {
      const textures = new Map();
      for (const index of new Set(channel.textures || [])) {
        textures.set(index, await gltf.parser.getDependency('texture', index));
      }
      for (const materialIndex of channel.materials || []) {
        const fallback = await gltf.parser.getDependency('material', materialIndex);
        for (const material of renderedMaterialsForIndex(gltf, materialIndex, fallback)) {
          bindings.push({ channel, textures, material, original: material.map, current: null });
        }
      }
    }
  }

  const hasEffects = (spec.effects || []).some(effect => effect.type === 'tail-flame');
  const sharedTexture = hasEffects ? flameTexture(THREE) : null;
  const effectPairs = (spec.effects || []).map(effectSpec => ({
    effectSpec,
    controller: effectSpec.type === 'tail-flame' ? createFlame(THREE, gltf, effectSpec, sharedTexture) : null,
  })).filter(pair => pair.controller);
  const effects = effectPairs.map(pair => pair.controller);
  const hiddenObjects = [];
  const hiddenIndices = new Set();
  const replacementMaterials = new Map();
  for (const { effectSpec } of effectPairs) {
    for (const materialIndex of effectSpec.replacesMaterials || []) {
      if (hiddenIndices.has(materialIndex)) continue;
      hiddenIndices.add(materialIndex);
      const material = await gltf.parser.getDependency('material', materialIndex);
      replacementMaterials.set(materialIndex, material);
    }
  }
  // GLTFLoader may clone the dependency material while preparing a primitive, so
  // hide the rendered primitive rather than mutating only the parser's base material.
  // Stadium's exported effect sheet is its own one-material mesh.
  gltf.scene.traverse?.((object) => {
    if (!object.isMesh) return;
    const objectAssociation = gltf.parser.associations?.get(object);
    const primitiveMaterialIndex = gltf.parser.json?.meshes?.[objectAssociation?.meshes]
      ?.primitives?.[objectAssociation?.primitives]?.material;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const isReplacement = hiddenIndices.has(primitiveMaterialIndex)
      || (materials.length > 0 && materials.every((material) => {
      const association = gltf.parser.associations?.get(material);
      return hiddenIndices.has(association?.materials)
        || [...replacementMaterials.values()].includes(material);
      }));
    if (!isReplacement) return;
    hiddenObjects.push({ object, visible: object.visible });
    object.visible = false;
  });
  let enabled = true;

  function applyTextureFrame(frame) {
    for (const binding of bindings) {
      const index = textureIndexAt(binding.channel, frame);
      if (index === binding.current) continue;
      const texture = binding.textures.get(index);
      if (!texture) continue;
      binding.material.map = texture;
      binding.material.needsUpdate = true;
      binding.current = index;
    }
  }

  return {
    active: !!(bindings.length || effects.length),
    update(seconds) {
      if (!enabled) return;
      if (animation) applyTextureFrame(ambientFrameAt(animation, seconds));
      for (const effect of effects) effect.update(seconds);
    },
    setEnabled(next) {
      enabled = !!next;
      for (const effect of effects) effect.anchor.visible = enabled;
      for (const entry of hiddenObjects) entry.object.visible = enabled ? false : entry.visible;
      if (!enabled) for (const binding of bindings) {
        binding.material.map = binding.original;
        binding.material.needsUpdate = true;
      }
      else if (animation) applyTextureFrame(0);
    },
    dispose() {
      for (const binding of bindings) {
        binding.material.map = binding.original;
        binding.material.needsUpdate = true;
      }
      for (const entry of hiddenObjects) entry.object.visible = entry.visible;
      for (const effect of effects) effect.dispose();
      sharedTexture?.dispose();
      bindings.length = 0;
      hiddenObjects.length = 0;
      effects.length = 0;
    },
  };
}
