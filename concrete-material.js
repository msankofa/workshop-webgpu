// concrete-material.js -- procedural cast concrete as a TSL colour graph, shared by the bot viewer's
// look system and the Base Game spawn building. Moved out of bot-viewer-visuals.js on 2026-09-03 so
// a page without that look system (Base Game has its own sun, rain and vision modes) can build the
// same surface. The graph assumes axis-aligned boxes: the local normal names a world axis, so world
// XZ/Y serve as the surface's own coordinates and no tangent frame is needed.
//
// Usage:
//   const c = makeConcreteUniforms(THREE);
//   material.colorNode = Fn(() => concreteAlbedo(c, uniform(color)))();
//   applyConcrete(c, { concrete: block }, true);      // block fields: see CONCRETE_OFF in bot-viewer-visuals-style.js
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  Fn, uniform, uv, positionWorld, normalLocal, normalWorld, cameraPosition,
  float, vec2, vec3, sin, floor, fract, abs, min, clamp, mix, smoothstep, step, dot, length,
} from 'three/tsl';
import { concreteFor } from './bot-viewer-visuals-style.js';
import { mossWeight } from './moss-tint.js';

// ─── shared TSL noise ───────────────────────────────────────────────────────

export const hash13 = /*@__PURE__*/ Fn(([p]) => fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))).mul(43758.5453)));

export const noise3 = /*@__PURE__*/ Fn(([p]) => {
  const i = floor(p), f = fract(p);
  const u = f.mul(f).mul(float(3).sub(f.mul(2)));
  const n000 = hash13(i.add(vec3(0, 0, 0))), n100 = hash13(i.add(vec3(1, 0, 0)));
  const n010 = hash13(i.add(vec3(0, 1, 0))), n110 = hash13(i.add(vec3(1, 1, 0)));
  const n001 = hash13(i.add(vec3(0, 0, 1))), n101 = hash13(i.add(vec3(1, 0, 1)));
  const n011 = hash13(i.add(vec3(0, 1, 1))), n111 = hash13(i.add(vec3(1, 1, 1)));
  const x00 = mix(n000, n100, u.x), x10 = mix(n010, n110, u.x);
  const x01 = mix(n001, n101, u.x), x11 = mix(n011, n111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
});

// Two octaves: enough for slow patina, and each extra octave is eight more hashes per fragment.
export const fbm2 = (p) => noise3(p).mul(0.66).add(noise3(p.mul(2.31)).mul(0.34));

// ─── procedural cast concrete ───────────────────────────────────────────────
// A form-panel grid with recessed joints and tie holes, horizontal board grain, exposed aggregate,
// rain streaking off the top edge, and growth. Each surface family owns a uniform set so walls and
// low cover can weather differently. `gain` is a uniform, so the graph cannot be branched away:
// every material built on it pays three noise taps per fragment whether or not the concrete is on.

export function makeConcreteUniforms(THREE) {
  const C = (hex) => new THREE.Color(hex);
  return {
    gain: uniform(0),
    panel: uniform(new THREE.Vector2(2.4, 1.8)),
    seamWidth: uniform(0.018), seamDark: uniform(0.4),
    boardPitch: uniform(0.22), boardWidth: uniform(0.01),
    boardGain: uniform(0), boardToneVar: uniform(0.06),
    tieGain: uniform(0), tieRadius: uniform(0.032), tieSpacing: uniform(new THREE.Vector2(1.2, 0.9)),
    grainGain: uniform(0), mottleGain: uniform(0),
    stainColor: uniform(C(0)), stainGain: uniform(0), stainLength: uniform(0.5),
    mossColor: uniform(C(0)), mossGain: uniform(0),
    algaeGain: uniform(0), algaeHeight: uniform(0.28),
  };
}

export function concreteAlbedo(c, baseColor) {
  const nx = abs(normalLocal.x), ny = abs(normalLocal.y), nz = abs(normalLocal.z);
  const sideMask = step(ny, 0.5);                      // the four vertical faces
  const capMask = smoothstep(0.3, 0.75, normalLocal.y); // the up-facing cap, generously
  const isCap = step(0.5, ny);
  // Horizontal run across whichever vertical face this is; vertical is always world Y. On the
  // caps there is no "up the wall", so the grid runs in XZ instead.
  const h = mix(positionWorld.z, positionWorld.x, step(nx, nz));
  const gh = mix(h, positionWorld.x, isCap);
  const gv = mix(positionWorld.y, positionWorld.z, isCap);

  // Form-panel grid: a thin recessed joint wherever two form panels met.
  const dH = float(0.5).sub(abs(fract(gh.div(c.panel.x)).sub(0.5))).mul(c.panel.x);
  const dV = float(0.5).sub(abs(fract(gv.div(c.panel.y)).sub(0.5))).mul(c.panel.y);
  const seam = smoothstep(c.seamWidth, 0.0, min(dH, dV));

  // Board-form grain: a line at each board edge plus a per-board tone offset, which is what
  // sells board forming; the lines alone read as a decal.
  const bT = positionWorld.y.div(c.boardPitch.max(0.01));
  const dB = float(0.5).sub(abs(fract(bT).sub(0.5))).mul(c.boardPitch);
  const boardLine = smoothstep(c.boardWidth, 0.0, dB).mul(sideMask);
  const boardTone = hash13(vec3(floor(bT), 3.7, 1.3)).sub(0.5).mul(c.boardToneVar).mul(sideMask);

  // Form-tie holes on their own coarser grid.
  const tf = vec2(
    fract(gh.div(c.tieSpacing.x)).sub(0.5).mul(c.tieSpacing.x),
    fract(gv.div(c.tieSpacing.y)).sub(0.5).mul(c.tieSpacing.y),
  );
  const tie = smoothstep(c.tieRadius, c.tieRadius.mul(0.45), length(tf)).mul(sideMask);

  // Exposed aggregate over slow patina blotching; the speckle fades with distance because it is
  // far finer than a pixel at range and procedural noise has no mip chain.
  const camD = length(positionWorld.sub(cameraPosition));
  const speckle = smoothstep(0.55, 0.86, noise3(positionWorld.mul(42.0)))
    .mul(smoothstep(18.0, 4.0, camD));
  const patina = fbm2(positionWorld.mul(2.2));

  // Rain streaks: noise that varies only along the wall run, faded down from the top edge.
  const colN = noise3(vec3(h.mul(5.5), 0.0, h.mul(1.9)));
  const colLen = c.stainLength.mul(hash13(vec3(floor(h.mul(5.5)), 7.1, 2.4)).mul(0.7).add(0.5));
  const streak = smoothstep(0.42, 0.92, colN)
    .mul(smoothstep(colLen, 0.0, uv().y.oneMinus())).mul(sideMask);

  let col = baseColor.mul(float(1).add(boardTone));
  col = col.mul(float(1).sub(seam.mul(c.seamDark)));
  col = col.mul(float(1).sub(boardLine.mul(c.boardGain).mul(0.5)));
  col = col.mul(float(1).sub(tie.mul(c.tieGain)));
  col = col.mul(float(1).sub(speckle.mul(c.grainGain)));
  col = col.mul(float(1).add(patina.sub(0.5).mul(c.mottleGain)));
  col = mix(col, c.stainColor, streak.mul(c.stainGain));

  // Growth: the shared moss law drives the caps only; the damp green up a vertical face's base
  // is its own simpler term.
  const capMoss = mossWeight(float(0.85), clamp(normalWorld.y, 0, 1), seam.mul(0.6).add(0.4), patina)
    .mul(c.mossGain).mul(capMask);
  const algae = smoothstep(c.algaeHeight, 0.0, uv().y)
    .mul(smoothstep(0.35, 0.75, patina)).mul(c.algaeGain).mul(sideMask);
  col = mix(col, c.mossColor, clamp(capMoss.add(algae), 0, 1));

  return mix(baseColor, col, c.gain);
}

// Writes a theme's optional `concrete` block into one uniform set. An absent block resolves to
// CONCRETE_OFF, whose gain is 0.
export function applyConcrete(c, matBlock, on) {
  const k = concreteFor(matBlock);
  c.gain.value = on ? k.gain : 0;
  c.panel.value.set(Math.max(0.05, k.panelW), Math.max(0.05, k.panelH));
  c.seamWidth.value = k.seamWidth; c.seamDark.value = k.seamDark;
  c.boardPitch.value = k.boardPitch; c.boardWidth.value = k.boardWidth;
  c.boardGain.value = k.boardGain; c.boardToneVar.value = k.boardToneVar;
  c.tieGain.value = k.tieGain; c.tieRadius.value = k.tieRadius;
  c.tieSpacing.value.set(Math.max(0.05, k.tieH), Math.max(0.05, k.tieV));
  c.grainGain.value = k.grainGain; c.mottleGain.value = k.mottleGain;
  c.stainColor.value.set(k.stainColor);
  c.stainGain.value = k.stainGain; c.stainLength.value = k.stainLength;
  c.mossColor.value.set(k.mossColor); c.mossGain.value = k.mossGain;
  c.algaeGain.value = k.algaeGain; c.algaeHeight.value = k.algaeHeight;
}

// A ready material: standard PBR with the concrete colour graph over a flat colour uniform.
// `block` is a concrete block (the fields CONCRETE_OFF lists); the uniforms stay live on the
// returned material as `material.userData.concrete`.
export function createConcreteMaterial({ THREE, color = 0x9c9e9a, block = null, roughness = 0.95 } = {}) {
  const c = makeConcreteUniforms(THREE);
  const uColor = uniform(new THREE.Color(color));
  const material = new MeshStandardNodeMaterial({ roughness, metalness: 0 });
  material.colorNode = Fn(() => concreteAlbedo(c, uColor))();
  applyConcrete(c, { concrete: block || {} }, !!block);
  material.userData.concrete = c;
  material.userData.concreteColor = uColor;
  return material;
}
