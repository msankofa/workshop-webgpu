// post-fx.js
// SP4c — configurable node post-processing stack on the WebGPU backend. Composes three's
// PostProcessing node pipeline: scene pass → bloom → tone mapping (runtime-switchable) →
// color grade → output. Live params are uniforms; switching the tone-mapping operator rebuilds
// the output graph (rare, on dropdown change). v1 = bloom + tonemap + grade; GTAO (AO) is added
// in v2 (needs MRT normal). Grade math twin: post-grade.js (Node-tested).
import * as THREE from 'three';
import { PostProcessing } from 'three/webgpu';
import { pass, renderOutput, uniform, float, vec3, dot, mix, clamp, length, screenUV } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

const TONE = {
  agx: THREE.AgXToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  reinhard: THREE.ReinhardToneMapping,
  neutral: THREE.NeutralToneMapping,
  none: THREE.NoToneMapping,
};

export function createPostFX(opts) {
  const { renderer, scene, camera } = opts;
  const p = opts.params || {};

  const pp = new PostProcessing(renderer);
  const scenePass = pass(scene, camera);
  const scenePassColor = scenePass.getTextureNode();
  // threshold ~0.85 so only bright emitters (lights/embers/glints) bloom, not the dark terrain.
  const bloomPass = bloom(scenePassColor, p.bloomStrength ?? 0.5, p.bloomRadius ?? 0.6, p.bloomThreshold ?? 0.85);

  // grade uniforms (live)
  const uContrast = uniform(p.contrast ?? 1.0);
  const uSaturation = uniform(p.saturation ?? 1.1);
  const uVignette = uniform(p.vignette ?? 0.2);

  // grade node (transcribes post-grade.js): contrast(pivot 0.5) → saturation(luma) → vignette
  const gradeNode = (color) => {
    const c = color.sub(0.5).mul(uContrast).add(0.5);
    const luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
    const sat = mix(vec3(luma), c, uSaturation);
    const d = clamp(length(screenUV.sub(0.5).mul(2.0)), 0.0, 1.0);
    const vig = float(1.0).sub(uVignette.mul(d.mul(d)));
    return sat.mul(vig);
  };

  renderer.toneMappingExposure = p.exposure ?? 1.0;

  // (re)build the output graph for a given tone-mapping operator. renderOutput applies the
  // renderer's tone mapping + output color space; grade runs on the resulting display color.
  function build(name) {
    renderer.toneMapping = TONE[name] ?? THREE.AgXToneMapping;
    const hdr = scenePassColor.add(bloomPass);
    pp.outputNode = gradeNode(renderOutput(hdr));
    pp.needsUpdate = true;
  }
  build(p.tone ?? 'agx');

  let enabled = p.enabled ?? true;
  return {
    get enabled() { return enabled; },
    setEnabled(v) { enabled = !!v; },
    async renderAsync() { await pp.renderAsync(); },
    setToneMapping(name) { build(name); },
    setExposure(e) { renderer.toneMappingExposure = e; },
    setBloom(strength, radius, threshold) {
      bloomPass.strength.value = strength;
      bloomPass.radius.value = radius;
      bloomPass.threshold.value = threshold;
    },
    setGrade(contrast, saturation, vignette) {
      uContrast.value = contrast; uSaturation.value = saturation; uVignette.value = vignette;
    },
    resize() { /* PassNode tracks the renderer drawing-buffer size automatically */ },
    dispose() { if (pp.dispose) pp.dispose(); },
  };
}
