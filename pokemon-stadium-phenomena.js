/**
 * Pokémon Stadium texture animation playback.
 *
 * Both blinks and tail flames use textures already embedded in each Pokémon GLB.
 * The timing and animation selection come from the Stadium ROM/decompilation.
 */

const DEFAULT_FPS = 30;
const DEFAULT_TRIGGER_FRAMES = 60;
const DEBUG_PANEL_ID = 'pokemon-phenomena-debug';

const positiveMod = (value, modulus) => ((value % modulus) + modulus) % modulus;

function createDiagnosticsPanel(label, enabled = false) {
  if (typeof document === 'undefined') return { set() {}, setEnabled() {}, remove() {} };
  let panel = null;
  let lastLines = [];
  let lastWarning = false;

  function remove() {
    if (panel?.isConnected) panel.remove();
    panel = null;
  }

  function render() {
    if (!enabled) return;
    if (!panel) {
      document.getElementById(DEBUG_PANEL_ID)?.remove();
      panel = document.createElement('div');
      panel.id = DEBUG_PANEL_ID;
      Object.assign(panel.style, {
        position: 'fixed',
        left: '12px',
        bottom: '12px',
        zIndex: '10000',
        minWidth: '310px',
        maxWidth: 'min(520px, calc(100vw - 24px))',
        padding: '10px 12px',
        border: '1px solid #61d88a',
        borderRadius: '6px',
        background: 'rgba(4, 9, 13, .94)',
        color: '#d8ffe4',
        font: '12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace',
        whiteSpace: 'pre-wrap',
        pointerEvents: 'none',
        boxShadow: '0 4px 24px rgba(0, 0, 0, .45)',
      });
      document.body.appendChild(panel);
    }
    panel.style.borderColor = lastWarning ? '#ff6b6b' : '#61d88a';
    panel.style.color = lastWarning ? '#ffd6d6' : '#d8ffe4';
    panel.textContent = ['POKEMON PHENOMENA DEBUG — ' + label, ...lastLines].join('\n');
  }

  return {
    set(lines, warning = false) {
      lastLines = lines;
      lastWarning = warning;
      render();
    },
    setEnabled(next) {
      enabled = !!next;
      if (enabled) render();
      else remove();
    },
    remove,
  };
}

/** Pick the ROM texture-stream frame used by the viewer's 60-frame ambient trigger. */
export function ambientFrameAt(
  animation,
  seconds,
  { fps = DEFAULT_FPS, triggerFrames = DEFAULT_TRIGGER_FRAMES } = {},
) {
  if (!animation?.frameCount) return 0;
  const stadiumFrame = Math.max(0, Math.floor((Number(seconds) || 0) * fps));
  if (stadiumFrame < triggerFrames) return 0;
  const phase = positiveMod(stadiumFrame, triggerFrames);
  return phase < animation.frameCount ? phase : 0;
}

export function textureIndexAt(channel, frame) {
  const frames = channel?.textures || [];
  if (!frames.length) return null;
  return frames[Math.max(0, Math.min(frames.length - 1, Math.floor(frame) || 0))];
}

function materialSlotsForIndex(gltf, materialIndex, fallback = null) {
  const slots = [];
  const targetName = gltf.parser.json?.materials?.[materialIndex]?.name;
  gltf.scene.traverse?.((object) => {
    if (!object.isMesh) return;
    const objectAssociation = gltf.parser.associations?.get(object);
    const primitiveMaterialIndex = gltf.parser.json?.meshes?.[objectAssociation?.meshes]
      ?.primitives?.[objectAssociation?.primitives]?.material;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach((material, slot) => {
      if (!material) return;
      const association = gltf.parser.associations?.get(material);
      const isMatch = association?.materials === materialIndex
        || material === fallback
        || (!!targetName && material.name === targetName)
        || (materials.length === 1 && primitiveMaterialIndex === materialIndex);
      if (isMatch) slots.push({ object, slot, original: material });
    });
  });
  return slots;
}

function assignMaterial(slot, material) {
  if (Array.isArray(slot.object.material)) {
    const materials = slot.object.material.slice();
    materials[slot.slot] = material;
    slot.object.material = materials;
  } else {
    slot.object.material = material;
  }
}

async function createMaterialSequence(gltf, materialIndex, textureIndices, getTexture) {
  const fallback = await gltf.parser.getDependency('material', materialIndex);
  const slots = materialSlotsForIndex(gltf, materialIndex, fallback);
  if (!slots.length) {
    console.warn('[Pokemon phenomena] no rendered slots matched material', {
      materialIndex,
      materialName: gltf.parser.json?.materials?.[materialIndex]?.name,
      textureIndices,
    });
    return null;
  }

  const originalTextureIndex = gltf.parser.json?.materials?.[materialIndex]
    ?.pbrMetallicRoughness?.baseColorTexture?.index;
  const indices = [...new Set(textureIndices || [])];
  const textures = new Map();
  const originalColorSpace = slots.find(slot => slot.original.map)?.original.map.colorSpace;
  for (const index of indices) {
    const texture = await getTexture(index);
    // GLTFLoader assigns sRGB while attaching a texture to a base-color material. These animation frames
    // are otherwise-unused dependencies, so loading them directly skips that semantic assignment.
    if (originalColorSpace && texture.colorSpace !== originalColorSpace) {
      texture.colorSpace = originalColorSpace;
      texture.needsUpdate = true;
    }
    textures.set(index, texture);
  }

  const variants = slots.map((slot) => {
    const byTexture = new Map();
    for (const index of indices) {
      if (index === originalTextureIndex) continue;
      const material = slot.original.clone();
      material.name = `${slot.original.name || `material-${materialIndex}`}-texture-${index}`;
      material.map = textures.get(index);
      material.needsUpdate = true;
      byTexture.set(index, material);
    }
    return byTexture;
  });
  let current = null;

  return {
    materialIndex,
    materialName: gltf.parser.json?.materials?.[materialIndex]?.name || fallback.name || '(unnamed)',
    slotCount: slots.length,
    textureIndices: indices,
    apply(textureIndex) {
      if (textureIndex == null || textureIndex === current) return;
      slots.forEach((slot, index) => {
        const material = textureIndex === originalTextureIndex
          ? slot.original
          : variants[index].get(textureIndex);
        if (material) assignMaterial(slot, material);
      });
      current = textureIndex;
    },
    restore() {
      slots.forEach(slot => assignMaterial(slot, slot.original));
      current = null;
    },
    dispose() {
      this.restore();
      for (const byTexture of variants) {
        for (const material of byTexture.values()) material.dispose();
      }
    },
  };
}

/**
 * Bind one parsed GLTF to its generated Stadium phenomena record.
 * Unused embedded textures are loaded lazily by GLTFLoader.
 */
export async function createPokemonPhenomena({
  gltf,
  spec,
  species = null,
  name = null,
  startupError = null,
  debug = false,
}) {
  const label = name || (species == null ? 'unknown species' : '#' + String(species).padStart(3, '0'));
  let debugEnabled = !!debug;
  const diagnostics = createDiagnosticsPanel(label, debugEnabled);
  const debugInfo = (...args) => { if (debugEnabled) console.info(...args); };
  debugInfo('[Pokemon phenomena] initializing', { label, species, hasSpec: !!spec, spec });
  if (!spec) {
    const message = startupError
      ? String(startupError.stack || startupError.message || startupError)
      : 'no sidecar record was supplied';
    diagnostics.set(startupError ? [
      'STARTUP ERROR:',
      message,
      'See [Pokemon phenomena] and [lab] in the console.',
    ] : [
      'ERROR: no sidecar record was supplied',
      'ambient bindings: 0',
      'effect bindings: 0',
    ], true);
    if (startupError) {
      console.error('[Pokemon phenomena] startup failed', { label, species, error: startupError });
    } else {
      console.warn('[Pokemon phenomena] no sidecar record', { label, species });
    }
    return {
      update() {},
      setEnabled() {},
      setDebug(next) {
        debugEnabled = !!next;
        diagnostics.setEnabled(debugEnabled);
        debugInfo('[Pokemon phenomena] diagnostics enabled', { label, species, hasSpec: false });
      },
      dispose() { diagnostics.remove(); },
      active: false,
    };
  }

  const texturePromises = new Map();
  const getTexture = (index) => {
    if (!texturePromises.has(index)) {
      texturePromises.set(index, gltf.parser.getDependency('texture', index));
    }
    return texturePromises.get(index);
  };

  const animation = spec.textureAnimations?.[spec.ambientTextureAnimation] || null;
  const ambientBindings = [];
  let missingAmbientBindings = 0;
  if (animation) {
    for (const channel of animation.channels || []) {
      for (const materialIndex of channel.materials || []) {
        const sequence = await createMaterialSequence(
          gltf,
          materialIndex,
          channel.textures,
          getTexture,
        );
        if (sequence) ambientBindings.push({ channel, sequence });
        else missingAmbientBindings += 1;
      }
    }
  }

  const effectBindings = [];
  let missingEffectBindings = 0;
  for (const effect of spec.effects || []) {
    if (effect.type !== 'material-texture-cycle') continue;
    const sequence = await createMaterialSequence(
      gltf,
      effect.material,
      effect.textures,
      getTexture,
    );
    if (sequence) effectBindings.push({ effect, sequence });
    else missingEffectBindings += 1;
  }

  let enabled = true;
  let lastStadiumFrame = null;
  let lastAmbientPlaying = false;
  let lastConsoleSecond = -1;

  const bindingSummary = {
    selector: spec.ambientTextureAnimationSelector,
    ambientAnimation: spec.ambientTextureAnimation,
    ambientFrames: animation?.frameCount || 0,
    ambientBindings: ambientBindings.map(binding => ({
      material: binding.sequence.materialIndex,
      materialName: binding.sequence.materialName,
      slots: binding.sequence.slotCount,
      textures: binding.channel.textures,
    })),
    missingAmbientBindings,
    effects: effectBindings.map(binding => ({
      role: binding.effect.role,
      material: binding.sequence.materialIndex,
      materialName: binding.sequence.materialName,
      slots: binding.sequence.slotCount,
      textures: binding.effect.textures,
    })),
    missingEffectBindings,
  };
  debugInfo('[Pokemon phenomena] ready', bindingSummary);
  if (!animation) console.warn('[Pokemon phenomena] ROM selector did not resolve to an animation', bindingSummary);
  if (missingAmbientBindings || missingEffectBindings) {
    console.warn('[Pokemon phenomena] one or more material bindings failed', bindingSummary);
  }

  function restoreAll() {
    for (const binding of ambientBindings) binding.sequence.restore();
    for (const binding of effectBindings) binding.sequence.restore();
  }

  return {
    active: !!(ambientBindings.length || effectBindings.length),
    update(seconds) {
      if (!enabled) return;
      const stadiumFrame = Math.max(0, Math.floor((Number(seconds) || 0) * DEFAULT_FPS));
      if (stadiumFrame === lastStadiumFrame) return;
      lastStadiumFrame = stadiumFrame;

      if (animation) {
        const triggerFrames = spec.ambientTriggerFrames || DEFAULT_TRIGGER_FRAMES;
        const phase = positiveMod(stadiumFrame, triggerFrames);
        const isPlaying = stadiumFrame >= triggerFrames && phase < animation.frameCount;
        if (isPlaying !== lastAmbientPlaying) {
          debugInfo('[Pokemon phenomena] ambient texture animation ' + (isPlaying ? 'started' : 'ended'), {
            stadiumFrame,
            animation: spec.ambientTextureAnimation,
            phase,
          });
          lastAmbientPlaying = isPlaying;
        }
        for (const binding of ambientBindings) {
          if (isPlaying) {
            binding.sequence.apply(textureIndexAt(binding.channel, phase));
          } else {
            binding.sequence.restore();
          }
        }
      }

      const effectFrames = [];
      for (const { effect, sequence } of effectBindings) {
        const frameRate = effect.frameRate || DEFAULT_FPS;
        const frame = Math.floor((Number(seconds) || 0) * frameRate);
        const effectFrame = positiveMod(frame, effect.textures.length);
        const texture = effect.textures[effectFrame];
        sequence.apply(texture);
        effectFrames.push(effect.role + ': frame ' + effectFrame + ' texture ' + texture);
      }

      const triggerFrames = spec.ambientTriggerFrames || DEFAULT_TRIGGER_FRAMES;
      const ambientPhase = animation ? positiveMod(stadiumFrame, triggerFrames) : null;
      const ambientPlaying = !!animation
        && stadiumFrame >= triggerFrames
        && ambientPhase < animation.frameCount;
      const ambientTextures = ambientPlaying
        ? ambientBindings.map(binding => textureIndexAt(binding.channel, ambientPhase)).join(', ')
        : 'resting';
      diagnostics.set([
        'selector: ' + String(spec.ambientTextureAnimationSelector),
        'ambient animation: ' + String(spec.ambientTextureAnimation)
          + ' (' + String(animation?.frameCount || 0) + ' frames)',
        'ambient bindings: ' + ambientBindings.length + '  missing: ' + missingAmbientBindings,
        'effect bindings: ' + effectBindings.length + '  missing: ' + missingEffectBindings,
        'stadium frame: ' + stadiumFrame,
        'ambient: ' + (ambientPlaying ? 'PLAY frame ' + ambientPhase + ' texture ' + ambientTextures : 'idle'),
        ...(effectFrames.length ? effectFrames : ['effects: none']),
      ], !ambientBindings.length && !effectBindings.length);

      const currentSecond = Math.floor(stadiumFrame / DEFAULT_FPS);
      if (currentSecond !== lastConsoleSecond) {
        lastConsoleSecond = currentSecond;
        debugInfo('[Pokemon phenomena] heartbeat', {
          stadiumFrame,
          ambient: ambientPlaying ? { frame: ambientPhase, textures: ambientTextures } : 'idle',
          effects: effectFrames,
        });
      }
    },
    setEnabled(next) {
      enabled = !!next;
      lastStadiumFrame = null;
      if (!enabled) {
        restoreAll();
        diagnostics.set(['disabled; original materials restored']);
        debugInfo('[Pokemon phenomena] disabled; original materials restored');
      } else {
        debugInfo('[Pokemon phenomena] enabled');
      }
    },
    setDebug(next) {
      debugEnabled = !!next;
      diagnostics.setEnabled(debugEnabled);
      debugInfo('[Pokemon phenomena] diagnostics enabled', bindingSummary);
    },
    dispose() {
      for (const binding of ambientBindings) binding.sequence.dispose();
      for (const binding of effectBindings) binding.sequence.dispose();
      ambientBindings.length = 0;
      effectBindings.length = 0;
      diagnostics.remove();
      debugInfo('[Pokemon phenomena] disposed', { label, species });
    },
  };
}
