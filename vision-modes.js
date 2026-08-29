// vision-modes.js — RGB / NVG / thermal for a WebGPU scene, where heat is a property of THINGS.
//
// The cheap thermal is a luma remap of the lit frame, and it is wrong in the one way that matters:
// sunlit grass reads hot and a shadowed engine reads cold, because it is measuring light, not heat.
// So this does not do that. Every material carries a heat value, and under IR the material emits
// that heat as grey and its diffuse goes black, so lighting cannot reach the picture at all. The
// composite then maps grey to white-hot or black-hot, adds the sensor's noise and vignette, and that
// is the whole thermal path: heat in, heat out, sun irrelevant.
//
// The seam is `heatTag(material, heat)`. It sets `colorNode` / `emissiveNode` in terms of the
// material's OWN `materialColor` / `materialEmissive` nodes, which include the map and keep tracking
// `.color`, `.emissive`, `.opacity` — so a pooled particle whose colour is set per emit still fades
// and tints under RGB, and reads as its pool's heat under IR. Materials that already own a colorNode
// (a terrain with a TSL colour graph, a sky) opt in with `heatMix()` inside their own graph.
//
// NVG is an intensifier tube: monochrome luminance with gain, a noise floor and a bloom-ish halo,
// in that phosphor green. On a daylight scene it is a green daylight scene, and that is honest.
//
// The composite needs a GPU; the tagging and the palettes do not, and are what the test covers.

import { PostProcessing } from 'three/webgpu';
import {
  pass, renderOutput, uniform, float, vec3, vec4, mix, dot, clamp, length, screenUV, hash, time,
  materialColor, materialEmissive, materialRoughness, materialMetalness, select, Fn,
  fract, pow, max, min, oneMinus,
} from 'three/tsl';

export const VISION_MODES = ['rgb', 'nvg', 'whot', 'bhot'];
export const VISION_LABEL = { rgb: 'RGB', nvg: 'NVG', whot: 'IR WHT', bhot: 'IR BLK' };

// 1 under either thermal palette, 0 otherwise. Materials read this; the composite reads uMode.
export const uIR = uniform(0);
export const uMode = uniform(0);

// The one place the mode becomes uniform values. Returns the index it settled on.
export function setVisionMode(name) {
  const i = Math.max(0, VISION_MODES.indexOf(name));
  uMode.value = i;
  uIR.value = i >= 2 ? 1 : 0;
  return i;
}
export function visionMode() { return VISION_MODES[uMode.value]; }

// Heat is 0..1 of the sensor's range. These are the conventions the demo tags with; a thing that
// is not tagged gets DEFAULT_HEAT, which is "cool object" — visible, not glowing.
export const HEAT = {
  sky: 0.02, water: 0.08, cloud: 0.14, terrain: 0.30, cold: 0.22,
  structure: 0.34, skin: 0.50, missile: 0.62, warm: 0.45, engine: 0.85, exhaust: 1.0,
  fire: 1.0, tracer: 1.0, smoke: 0.42,
};
export const DEFAULT_HEAT = 0.30;

// Blends an RGB node toward a heat grey under IR — for materials that build their own colour graph.
export function heatMix(rgbNode, heat) {
  return mix(rgbNode, vec3(heat), uIR);
}

// Tags a node material. `heat` may be a number or a uniform node. Returns the material.
export function heatTag(material, heat = DEFAULT_HEAT) {
  if (!material || material.userData.irTagged) return material;
  material.userData.irTagged = true;
  material.userData.heat = heat;
  const h = vec3(heat);
  // A material that already owns a colour graph is WRAPPED rather than overwritten. Writing colorNode
  // from the material's flat `.color` would throw a terrain splat or a sky gradient away in EVERY
  // mode, not just under IR — a broken page rather than a wrong-looking heat frame.
  //
  // vec4() of a vec3 node pads alpha with 1 (three does the same conversion on colorNode itself), so
  // one line covers both widths. toVar() matters: without it the wrapped graph is inlined once for
  // .rgb and again for .a, and on the terrain that is the whole splat computed twice.
  const prior = material.colorNode ? vec4(material.colorNode).toVar() : null;
  const priorRGB = prior ? prior.rgb : materialColor.rgb;
  const priorA = prior ? prior.a : materialColor.a;
  material.userData.irWrapped = !!prior;
  if (material.isMeshStandardNodeMaterial || material.isMeshPhysicalNodeMaterial
    || material.isMeshLambertNodeMaterial || material.isMeshPhongNodeMaterial) {
    // lit: kill the diffuse, emit the heat, flatten the specular so the sun cannot glint through
    material.colorNode = vec4(mix(priorRGB, vec3(0.0), uIR), priorA);
    material.emissiveNode = mix(material.emissiveNode ?? materialEmissive, h, uIR);
    if (material.isMeshStandardNodeMaterial || material.isMeshPhysicalNodeMaterial) {
      material.roughnessNode = mix(material.roughnessNode ?? materialRoughness, float(1.0), uIR);
      material.metalnessNode = mix(material.metalnessNode ?? materialMetalness, float(0.0), uIR);
    }
  } else if (material.isNodeMaterial) {
    // unlit (basic, line, points, sprite): the colour IS the output
    material.colorNode = vec4(mix(priorRGB, h, uIR), priorA);
  } else {
    // a classic material cannot take a node; the renderer converts it and we cannot reach in.
    // Left as-is and reported, so a scene author can swap it for the node twin.
    material.userData.irTagged = false;
    material.userData.irUntaggable = true;
    return material;
  }
  material.needsUpdate = true;
  return material;
}

// Tags every untagged material in a scene with the default heat. Returns how many it touched and
// which classic materials it could not — those are the ones that will read as lit colour under IR.
export function tagScene(root, defaultHeat = DEFAULT_HEAT) {
  let tagged = 0;
  const untaggable = [];
  root.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      if (m.userData.irTagged || m.userData.irUntaggable) continue;
      heatTag(m, defaultHeat);
      if (m.userData.irTagged) tagged++;
      else untaggable.push(o.name || o.type);
    }
  });
  return { tagged, untaggable };
}

// ---------------------------------------------------------------------------
// The composite: what each mode does to the frame. Pure functions of (luma, rgb) first, so the
// palettes can be checked in Node without a renderer, then the TSL graph that applies them.
// ---------------------------------------------------------------------------

export function lumaOf(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

// CPU twins of the palettes below. Keep in sync by hand — same rule as post-grade.js.
export const PALETTE = {
  nvg(l) { const g = Math.min(1, Math.pow(Math.max(0, l * 2.6), 0.8)); return [g * 0.16, g, g * 0.30]; },
  whot(l) { const v = Math.min(1, Math.max(0, (l - 0.03) * 1.12)); return [v, v, v]; },
  bhot(l) { const v = 1 - Math.min(1, Math.max(0, (l - 0.03) * 1.12)); return [v, v, v]; },
};

// The palette as a node, for a page that already owns its pipeline (base-game has one for depth of
// field, and a second pipeline would mean a second scene pass). `color` must be display-referred —
// renderOutput already applied — which is also why the pipeline it goes into must have
// outputColorTransform off. Returns a vec4.
export function visionNode(color) {
  return Fn(() => {
    const rgb = color.rgb;
    const l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
    // sensor noise: a hash of the pixel and the frame, low amplitude, so a still scene still crawls
    const n = hash(screenUV.x.mul(1731.0).add(screenUV.y.mul(977.0)).add(fract(time.mul(7.13)).mul(131.0))).sub(0.5);
    const d = clamp(length(screenUV.sub(0.5).mul(2.0)), 0.0, 1.0);
    const vig = oneMinus(pow(d, 3.0).mul(0.55));

    // NVG — palette.nvg
    const gN = min(float(1.0), pow(max(l.mul(2.6), 0.0), 0.8)).add(n.mul(0.06)).mul(vig);
    const nvg = vec3(gN.mul(0.16), gN, gN.mul(0.30));
    // white hot — palette.whot; black hot is its inverse
    const v = clamp(l.sub(0.03).mul(1.12), 0.0, 1.0).add(n.mul(0.035)).mul(vig);
    const whot = vec3(v);
    const bhot = vec3(oneMinus(v));

    const out = select(uMode.lessThan(0.5), rgb,
      select(uMode.lessThan(1.5), nvg,
        select(uMode.lessThan(2.5), whot, bhot)));
    return vec4(out, 1.0);
  })();
}

export function createVisionComposite(renderer, scene, camera) {
  const pp = new PostProcessing(renderer);
  // renderOutput is applied by hand inside the node, so the pipeline must not apply it again on the
  // way out — otherwise RGB mode would not match the plain render it is supposed to be identical to.
  pp.outputColorTransform = false;
  const scenePass = pass(scene, camera);
  pp.outputNode = visionNode(renderOutput(scenePass.getTextureNode()));

  return {
    setMode: setVisionMode,
    get mode() { return visionMode(); },
    render() { pp.render(); },   // renderAsync is deprecated since r181; the demo awaits renderer.init()
  };
}
