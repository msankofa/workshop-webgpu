// bot-viewer-visuals.js — the look system for bot-viewer-v2.html.
// Owns everything the viewer *sees* but doesn't simulate: a procedural TSL sky dome (stars,
// nebula, planet, sun glow), the three map materials (floor grid + scan ring, wall neon trim +
// travelling pulse + fresnel rim, cover hazard stripes), the light rig, fog, IBL reflections and
// the post stack. Pure look data (themes, palettes, the procedural theme roller) lives in
// bot-viewer-visuals-style.js so it stays Node-testable; this file only builds nodes and DOM.
//
// Usage:
//   const visuals = createVisualSystem({ THREE, renderer, scene, camera, postFX, rig, overheadLight });
//   box(visuals.materials.wall, ...);           // materials are stable objects, retinted per theme
//   visuals.setBounds(activeBounds);            // per layout: recenters grid/scan/accent lights
//   visuals.update(dt);                         // per frame: dome follows camera, accents pulse
//   ctrl.append(...visuals.buildPanel());
import { MeshStandardNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, uniform, uv, attribute, positionLocal, positionWorld, normalLocal, normalWorld, cameraPosition, time,
  float, vec2, vec3, sin, cos, floor, fract, abs, min, max, clamp, mix, smoothstep, step,
  dot, length, normalize, pow, sqrt,
} from 'three/tsl';
// Namespace import purely so a missing member degrades at runtime instead of failing the module
// link (a bad *named* import throws before a single line of the viewer runs).
import * as TSL from 'three/tsl';
import {
  THEMES, THEME_KEYS, DEFAULT_THEME, getTheme, cloneTheme, togglesFor, randomTheme,
  normalizeTheme, flashCurve, pickLightSlotsInto, poolScaleForHeight, cycleHueHex, fitShadowBox,
  REACTIVE_TARGETS, REACTIVE_KEYS, defaultReactiveTargets, reactiveGain, advanceAudioMix,
  concreteFor,
} from './bot-viewer-visuals-style.js';
// The one moss law in the repo: env-viewer's terrain, rocks and deadwood all read the same Fn,
// so concrete that grows over follows the same rules those surfaces do.
import { mossWeight } from './moss-tint.js';
import { createSoilShade, soilFor } from './soil-shade.js';

const DEG = Math.PI / 180;
const SKY_RADIUS = 150;   // < camera.far (200); the dome is re-centred on the camera each frame
const BOT_FX_CAP = 512;   // instances per bot-FX pool (ground pools, flashlight cones)
// The entire real-dynamic-light budget, shared by every flash on screen. These stay resident (see
// updateDynamicLights), and the WebGPU forward path evaluates every visible light per fragment with
// no early-out at intensity 0 — so each slot is a permanent per-pixel tax, not a pay-per-flash one.
// Two covers a firefight: flashes live ~60 ms, so three that overlap AND are all worth lighting is
// vanishingly rare, and the 3rd-brightest one is the one you'd never notice missing.
const DYN_LIGHT_COUNT = 2;
// Vertical span the key light's shadow box has to cover: 3 m walls, terrain relief under them, and
// headroom. Only widens the ortho box, so overshooting costs shadow resolution, never correctness.
const SHADOW_HEIGHT = 10;
const FLASH_CAP = 64;       // in-flight flash records; the ring overwrites the oldest
const EMPTY = [];           // frozen stand-in so the per-frame slot pick never allocates

// NodeMaterial multiplies an InstancedMesh's per-instance colour into the DIFFUSE term for us, but
// nothing feeds it to an emissiveNode — that has to read the varying InstanceNode writes.
const instanceTint = TSL.varyingProperty
  ? TSL.varyingProperty('vec3', 'vInstanceColor')
  : vec3(1, 1, 1);

// ─── shared TSL noise ───────────────────────────────────────────────────────

const hash13 = /*@__PURE__*/ Fn(([p]) => fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))).mul(43758.5453)));

const noise3 = /*@__PURE__*/ Fn(([p]) => {
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

// Two octaves, not three: the dome covers every background pixel, so each extra octave is 8 more
// hash evaluations across the whole screen. Two is enough for soft gas at this scale.
const fbm2 = (p) => noise3(p).mul(0.66).add(noise3(p.mul(2.31)).mul(0.34));

// ─── procedural cast concrete ───────────────────────────────────────────────
// Turns a surface's flat themed colour into weathered concrete: a form-panel grid with recessed
// joints and tie holes, horizontal board grain, exposed aggregate, rain streaking off the top
// edge, and growth. Walls and cover each own a set of these, so the two weather independently.
//
// COST NOTE: this evaluates 3 value-noise taps per fragment on every theme, not just the ones
// with concrete.gain > 0 -- `gain` is a uniform, so the graph can't be branched away, and the
// alternative (a second material swapped in per theme) would mean a pipeline recompile on every
// theme switch, which this file exists to avoid. If it ever shows up in a profile, the swap is
// the fix, not a cheaper noise.
function makeConcreteUniforms(THREE) {
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

function concreteAlbedo(c, baseColor) {
  // Every box in the map is axis-aligned (unit BoxGeometry, scale-and-translate instance
  // transforms only), so the local normal names a world axis directly -- no tangent frame, and
  // world XZ/Y can be used as the surface's own coordinates.
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

  // Board-form grain: a line at each board edge, plus a per-board tone offset. The tone offset
  // is what actually sells board forming -- every board pours a slightly different shade, and
  // without it the lines alone read as a decal rather than as a construction method.
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

  // Exposed aggregate over slow patina blotching. `patina` is deliberately shared with the moss
  // break-up below rather than each taking its own fbm -- one fewer pair of noise taps, and the
  // moss wanting to sit where the surface is already blotchy is if anything more correct.
  // The speckle runs at ~42 cycles per metre, which is far finer than a pixel by the time a wall
  // is across the arena. Procedural noise has no mip chain, so left alone it aliases into a
  // crawling shimmer as the camera moves; fading it out with distance is the cheap fix (one
  // length() shared with nothing else here) and it is detail you cannot resolve at range anyway.
  const camD = length(positionWorld.sub(cameraPosition));
  const speckle = smoothstep(0.55, 0.86, noise3(positionWorld.mul(42.0)))
    .mul(smoothstep(18.0, 4.0, camD));
  const patina = fbm2(positionWorld.mul(2.2));

  // Rain streaks: noise that varies only along the wall run, so it reads as vertical columns
  // rather than as blotches, faded downward from the top edge over a per-column length.
  // uv().y is 0 at the bottom of each box's side faces and 1 at the top.
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

  // Growth. mossWeight() hard-zeros below normalY 0.45 by design -- moss holds on tops, not on
  // cliffs -- so it drives the CAPS only. The damp green creeping up the base of a vertical face
  // in the references is a separate, simpler term, rather than a fake `upness` fed into a shared
  // law to make it do something it says it doesn't.
  const capMoss = mossWeight(float(0.85), clamp(normalWorld.y, 0, 1), seam.mul(0.6).add(0.4), patina)
    .mul(c.mossGain).mul(capMask);
  const algae = smoothstep(c.algaeHeight, 0.0, uv().y)
    .mul(smoothstep(0.35, 0.75, patina)).mul(c.algaeGain).mul(sideMask);
  col = mix(col, c.mossColor, clamp(capMoss.add(algae), 0, 1));

  return mix(baseColor, col, c.gain);
}

// Writes a theme's optional `concrete` block into one uniform set. An absent block resolves to
// CONCRETE_OFF, whose gain is 0 -- which is what keeps the six pre-concrete themes unchanged.
function applyConcrete(c, matBlock, on) {
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

function dirFromAngles(THREE, azimuthDeg, elevationDeg) {
  const a = azimuthDeg * DEG, e = elevationDeg * DEG;
  return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)).normalize();
}

// ─── system ─────────────────────────────────────────────────────────────────

// `onLookChange` fires whenever the whole look is re-applied (a theme switch, a look-slot load) or
// the flora toggle moves. It exists for state this module does not own -- bot-flora.js's meshes are
// built from the theme's `flora` block but live in the host's scene graph, so the host has to be
// told when that block has been swapped out from under it.
export function createVisualSystem({ THREE, renderer, scene, camera, postFX, rig, overheadLight, getAudioLevels = null, onLookChange = () => {} }) {
  let theme = cloneTheme(getTheme(DEFAULT_THEME));
  // A theme supplies DEFAULTS for the toggles; anything the user has explicitly clicked is an
  // override that outlives theme switches. Without this split, picking a preset silently undoes
  // every toggle decision you'd made -- "planet off" comes back on the moment you try another look.
  let toggleOverrides = {};
  let toggles = togglesFor(theme);
  function resolveToggles() { toggles = { ...togglesFor(theme), ...toggleOverrides }; }
  const master = { brightness: 1.0, saturation: 1.0, bloom: 1.0, fogScale: 1.0, neon: 1.0 };
  // Weather overlay, outside the theme so a theme switch keeps the storm: dim 0..1 darkens key and
  // ambient, fogBoost multiplies the theme fog, overcast lids the sky.
  const weather = { overcast: 0, dim: 0, fogBoost: 1 };
  let keyBase = 0, lightningLevel = 0;
  let bounds = { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
  let randomSeed = 1;
  let elapsed = 0;

  const C = (hex) => new THREE.Color(hex);

  // ── uniforms ──────────────────────────────────────────────────────────────
  // Everything the shaders read is a uniform, so a theme switch is a value write, never a
  // material rebuild (which on WebGPU means a pipeline recompile hitch).
  const u = {
    // sky
    horizon: uniform(C(0)), zenith: uniform(C(0)), ground: uniform(C(0)),
    nebA: uniform(C(0)), nebB: uniform(C(0)), nebGain: uniform(0), nebScale: uniform(2.5), nebTilt: uniform(0.5),
    starGain: uniform(1), starDensity: uniform(1), starTwinkle: uniform(1), starWrap: uniform(1),
    sunColor: uniform(C(0)), sunGain: uniform(0), sunSize: uniform(0.02), sunDir: uniform(new THREE.Vector3(0, 1, 0)),
    planetColor: uniform(C(0)), planetAtmo: uniform(C(0)), planetDir: uniform(new THREE.Vector3(1, 0, 0)),
    planetCos: uniform(0.99), planetSin: uniform(0.14), planetBands: uniform(0.5), planetHaloCos: uniform(0.98),
    planetOn: uniform(0), skyDrift: uniform(0),
    // weather (set by setWeather / setLightning from the page's rain wiring)
    overcast: uniform(0), lightning: uniform(0),
    // floor
    floorColor: uniform(C(0)), floorVig: uniform(0.3),
    floorMossColor: uniform(C(0x4a6b32)), floorMossGain: uniform(0), floorMossScale: uniform(0.55),
    gridColor: uniform(C(0)), gridPitch: uniform(4), gridWidth: uniform(0.03), gridGain: uniform(0), gridFade: uniform(60),
    scanColor: uniform(C(0)), scanGain: uniform(0), scanPeriod: uniform(6), scanSpeed: uniform(9), scanWidth: uniform(1.2),
    arenaCenter: uniform(new THREE.Vector2(0, 0)), arenaRadius: uniform(12),
    // wall
    wallColor: uniform(C(0)),
    trimColor: uniform(C(0)), trimGain: uniform(0), trimTop: uniform(0.94), trimBottom: uniform(0.05), trimWidth: uniform(0.03),
    pulseGain: uniform(0), pulseSpeed: uniform(1.2), pulseScale: uniform(0.14),
    wallRimColor: uniform(C(0)), wallRimGain: uniform(0), wallRimPower: uniform(3),
    // cover
    coverColor: uniform(C(0)),
    stripeColor: uniform(C(0)), stripeGain: uniform(0), stripePitch: uniform(0.45),
    capColor: uniform(C(0)), capGain: uniform(0),
    // bots
    shellGlow: uniform(0), plateGlow: uniform(0), trimGlow: uniform(0),
    eyeColor: uniform(C(0)), eyeGlow: uniform(0),
    // visor glass sheen — falls back to the theme's eye colour unless a theme overrides it
    visorColor: uniform(C(0xffa83c)), visorGain: uniform(1.5),
    botRimColor: uniform(C(0)), botRimGain: uniform(0), botRimPower: uniform(3),
    poolGain: uniform(0), beamColor: uniform(C(0)), beamGain: uniform(0),
  };

  // ── sky dome ──────────────────────────────────────────────────────────────
  const skyMat = new MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, toneMapped: true });
  skyMat.fog = false;

  skyMat.colorNode = Fn(() => {
    const dir = normalize(positionLocal);
    // Slow yaw drift so a long harness session never looks frozen.
    const ca = cos(u.skyDrift), sa = sin(u.skyDrift);
    const d = vec3(dir.x.mul(ca).sub(dir.z.mul(sa)), dir.y, dir.x.mul(sa).add(dir.z.mul(ca)));

    // vertical gradient, with a separate tint below the horizon (the dome shows under open maps)
    const h = clamp(d.y.mul(0.5).add(0.5), 0, 1);
    const upper = mix(u.horizon, u.zenith, pow(h.mul(2).sub(1).max(0), 0.7));
    const lower = mix(u.ground, u.horizon, pow(h.mul(2).max(0), 1.4));
    let col = mix(lower, upper, step(0.5, h));

    // nebula: layered noise confined to a tilted galactic band. The band is deliberately narrow
    // and high-contrast (pow 3) -- a wide, low-contrast one just washes the whole sky flat.
    const plane = d.y.mul(cos(u.nebTilt)).sub(d.z.mul(sin(u.nebTilt)));
    const band = smoothstep(0.38, 0.0, abs(plane));
    const n = fbm2(d.mul(u.nebScale));
    const cloud = pow(n, 3.0);
    const dust = smoothstep(0.0, 0.06, abs(plane.add(n.mul(0.08).sub(0.04))));
    col = col.add(mix(u.nebA, u.nebB, cloud).mul(band).mul(cloud).mul(dust).mul(u.nebGain));

    // Three star layers, each a jittered point per occupied grid cell. Getting this to read as a
    // night sky rather than TV static comes down to three things, all of which it got wrong first
    // time round: keep the OCCUPANCY LOW (a few percent of cells, not a quarter), give MAGNITUDE a
    // steep falloff so most stars are faint and only a handful are bright, and TINT them -- a field
    // of identical white dots at identical brightness is indistinguishable from sensor noise.
    // angRadius = sizeMul/scale radians; at ~20 px/deg a bright core wants ~0.0025 rad (~3 px).
    const starThresh = float(1).sub(u.starDensity.mul(0.045)).clamp(0.0, 0.999);
    const starSpan = float(1).sub(starThresh).max(1e-3);
    const COOL = vec3(0.62, 0.76, 1.0), WARM = vec3(1.0, 0.84, 0.64);
    const starLayer = (scale, sizeMul, gain) => {
      const p = d.mul(scale);
      const c = floor(p);
      const rx = hash13(c);
      const ry = hash13(c.add(vec3(1.7, 9.2, 3.1)));
      const rz = hash13(c.add(vec3(5.3, 2.8, 7.4)));
      const rb = hash13(c.add(vec3(11.1, 3.3, 9.9)));
      const sdir = normalize(c.add(vec3(rx, ry, rz)));
      const ang = length(d.sub(sdir));
      const alive = smoothstep(starThresh, starThresh.add(0.004), rb);
      // remap the surviving hash range to [0,1], then a steep power -> a real magnitude spread
      const mag = pow(rb.sub(starThresh).div(starSpan).clamp(0, 1), 2.2);
      const radius = float(sizeMul).div(scale).mul(mag.mul(0.65).add(0.45));
      const core = smoothstep(radius, 0.0, ang);
      const halo = smoothstep(radius.mul(4.0), 0.0, ang).mul(0.16);   // bloom catches this
      const tw = sin(time.mul(u.starTwinkle.mul(1.9)).add(rb.mul(51.0))).mul(0.5).add(0.5);
      const tint = mix(COOL, WARM, rz);
      return tint.mul(core.add(halo)).mul(alive).mul(mag).mul(mix(float(0.45), float(1.0), tw)).mul(gain);
    };
    const stars = starLayer(30, 0.075, 1.0).add(starLayer(80, 0.13, 0.5)).add(starLayer(190, 0.22, 0.26));
    // starWrap 1 = the field wraps right around below the horizon (the map is a slab floating in
    // space, so there is no "down"); 0 = it fades at the horizon because there is ground down there.
    const belowFade = mix(smoothstep(-0.25, 0.05, d.y), float(1), u.starWrap);
    col = col.add(stars.mul(u.starGain).mul(belowFade));

    // sun / distant star glow
    const sd = clamp(dot(d, u.sunDir), 0, 1);
    const disc = smoothstep(float(1).sub(u.sunSize), float(1).sub(u.sunSize.mul(0.55)), sd);
    const glow = pow(sd, float(90).div(u.sunSize.add(0.005).mul(40).add(1)));
    col = col.add(u.sunColor.mul(disc.mul(3.0).add(glow.mul(0.55))).mul(u.sunGain));

    // planet: lit sphere + limb terminator + atmospheric halo
    const cd = dot(d, u.planetDir);
    const pdisc = smoothstep(u.planetCos, u.planetCos.add(0.0012), cd).mul(u.planetOn);
    const sinT = sqrt(max(float(1).sub(cd.mul(cd)), 0.0));
    const t = clamp(sinT.div(u.planetSin.max(1e-4)), 0, 1);
    const nz = sqrt(max(float(1).sub(t.mul(t)), 0.0));
    const tang = normalize(d.sub(u.planetDir.mul(cd)).add(vec3(1e-5, 1e-5, 1e-5)));
    const nrm = normalize(u.planetDir.mul(nz).add(tang.mul(t)));
    const lam = clamp(dot(nrm, u.sunDir), 0, 1);
    // Analytic latitude banding rather than another fbm: a gas-giant read for two sin() instead
    // of 16 hashes, evaluated for every background pixel whether the planet is on screen or not.
    const lat = nrm.y;
    const bandsN = sin(lat.mul(u.planetBands.mul(22).add(5))).mul(0.5).add(0.5)
      .mul(sin(lat.mul(37.0).add(1.7)).mul(0.22).add(0.78));
    const surface = mix(u.planetColor, u.planetColor.mul(1.9).add(0.02), bandsN);
    const planetCol = surface.mul(lam.mul(0.95).add(0.05))
      .add(u.planetAtmo.mul(pow(t, 7.0)).mul(lam.mul(0.8).add(0.2)).mul(0.9));
    col = mix(col, planetCol, pdisc);
    const halo = smoothstep(u.planetHaloCos, u.planetCos, cd).mul(pdisc.oneMinus()).mul(u.planetOn);
    col = col.add(u.planetAtmo.mul(halo.mul(halo)).mul(0.5));

    // Overcast: a low cloud lid, tinted by the theme's own horizon so it still belongs to the look,
    // covering stars/nebula/sun alike; lightning brightens the lid from inside.
    const lid = mix(vec3(0.20, 0.22, 0.26), u.horizon, 0.35).mul(float(1).add(u.lightning.mul(2.5)));
    col = mix(col, lid, u.overcast);

    return col;
  })();

  const skyMesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 48, 32), skyMat);
  skyMesh.frustumCulled = false;
  // Drawn LAST among the opaques, not first. This is the most expensive shader in the frame (two
  // noise octaves, three star layers, a lit planet) and at renderOrder -1000 it ran for every
  // screen pixel before the map painted over most of them. The material is depthWrite:false with
  // depthTest on, so deferring it lets wall/floor/bot depth reject every covered fragment — in a
  // maze that is most of the screen. It stays ahead of the transparent queue (the FX pools), since
  // three sorts opaque before transparent regardless of renderOrder.
  skyMesh.renderOrder = 1000;
  skyMesh.matrixAutoUpdate = true;

  // ── map materials ─────────────────────────────────────────────────────────

  // Moss carpeting the GROUND, which is where every reference actually puts it -- wall caps are a
  // 0.3 m strip you can barely see. Gated on upness through the shared mossWeight law, so it takes
  // the flats and channels and leaves the steep faces bare. One noise tap, not an fbm: this runs
  // over most of the screen.
  function groundMoss(base) {
    const n = noise3(positionWorld.mul(u.floorMossScale));
    const w = mossWeight(float(0.8), clamp(normalWorld.y, 0, 1), float(0.7), smoothstep(0.34, 0.72, n));
    return mix(base, u.floorMossColor, clamp(w.mul(u.floorMossGain), 0, 1));
  }

  // Optional soil dressing (soil-shade.js: damp patches, dry cracks) over both ground materials.
  // One instance, so the flat floor and the uneven terrain read the same fields; default-off.
  const soil = createSoilShade();
  function dressGround(col) {
    const d = soil.nodes.apply({ col, rough: float(1), worldXZ: positionWorld.xz, normalWorld });
    return d;
  }
  // The dressed {col, rough, normalWorld} graphs, so a wrapper (rain's applyWetSurface) can build
  // on them instead of replacing the soil/moss/vignette work.
  const groundNodes = { floor: null, terrain: null };
  const floorMat = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  {
    const d = dressGround(Fn(() => {
      const r = length(positionWorld.xz.sub(u.arenaCenter));
      const vig = float(1).sub(u.floorVig.mul(clamp(r.div(u.arenaRadius.max(1)), 0, 1)));
      return groundMoss(u.floorColor.mul(vig));
    })());
    floorMat.colorNode = d.col;
    floorMat.roughnessNode = d.rough;
    floorMat.normalNode = TSL.transformNormalToView(d.normalWorld);
    groundNodes.floor = d;
  }
  // Uneven ground gets its own material: same themed colour and vignette, multiplied by the
  // per-vertex terrain shading bot-terrain.js bakes (rock on steep faces, sediment in channels,
  // altitude spread). A separate material rather than a flag on floorMat because the flat slab
  // and the catch slab carry no colour attribute and must keep rendering exactly as they do now.
  const terrainMat = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });
  {
    const d = dressGround(Fn(() => {
      const r = length(positionWorld.xz.sub(u.arenaCenter));
      const vig = float(1).sub(u.floorVig.mul(clamp(r.div(u.arenaRadius.max(1)), 0, 1)));
      return groundMoss(u.floorColor.mul(vig).mul(attribute('color', 'vec3')));
    })());
    terrainMat.colorNode = d.col;
    terrainMat.roughnessNode = d.rough;
    terrainMat.normalNode = TSL.transformNormalToView(d.normalWorld);
    groundNodes.terrain = d;
  }

  floorMat.emissiveNode = Fn(() => {
    // world-space grid: distance to the nearest cell line, widened in world metres
    const g = positionWorld.xz.div(u.gridPitch);
    const dxy = vec2(0.5, 0.5).sub(abs(fract(g).sub(0.5)));
    const dline = min(dxy.x, dxy.y).mul(u.gridPitch);          // back to metres
    const line = smoothstep(u.gridWidth, 0.0, dline);
    // every 4th line reads brighter, so the floor scans as a plan rather than graph paper
    const cellIdx = floor(g);
    const majorX = smoothstep(0.12, 0.0, fract(cellIdx.x.div(4)));
    const majorZ = smoothstep(0.12, 0.0, fract(cellIdx.y.div(4)));
    const major = max(majorX, majorZ).mul(0.55).add(0.45);
    const camD = length(positionWorld.sub(cameraPosition));
    const fade = smoothstep(u.gridFade, u.gridFade.mul(0.15), camD);
    const grid = line.mul(major).mul(fade).mul(u.gridGain);

    // expanding scan ring from the arena centre
    const r = length(positionWorld.xz.sub(u.arenaCenter));
    const phase = fract(time.div(u.scanPeriod.max(0.5)));
    const front = phase.mul(u.arenaRadius.mul(1.5));
    const ring = smoothstep(u.scanWidth, 0.0, abs(r.sub(front))).mul(phase.oneMinus());

    return u.gridColor.mul(grid).add(u.scanColor.mul(ring).mul(u.scanGain));
  })();

  // Walls and cover weather independently (cover sits in the wet at ground level and takes more
  // growth), so each owns its own set rather than sharing one.
  const wallConcrete = makeConcreteUniforms(THREE);
  const coverConcrete = makeConcreteUniforms(THREE);

  const wallMat = new MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  wallMat.colorNode = Fn(() => concreteAlbedo(wallConcrete, u.wallColor))();
  wallMat.emissiveNode = Fn(() => {
    // BoxGeometry side faces carry uv.y = 0 at the bottom, 1 at the top — so trim bands are
    // authored as fractions of each box's own height and survive terrain-sunk walls.
    const sideMask = step(abs(normalLocal.y), 0.5);
    const t = uv().y;
    const bands = max(
      smoothstep(u.trimWidth, 0.0, abs(t.sub(u.trimTop))),
      smoothstep(u.trimWidth, 0.0, abs(t.sub(u.trimBottom))),
    ).mul(sideMask);
    // energy travelling along the wall run
    const along = positionWorld.x.add(positionWorld.z);
    const wave = sin(along.mul(u.pulseScale).sub(time.mul(u.pulseSpeed))).mul(0.5).add(0.5);
    const trim = bands.mul(u.trimGain).mul(float(1).add(pow(wave, 4.0).mul(u.pulseGain)));
    // fresnel rim picks out silhouettes against the dark deck
    const V = normalize(cameraPosition.sub(positionWorld));
    const fres = pow(clamp(dot(normalize(normalWorld), V), 0, 1).oneMinus(), u.wallRimPower);
    return u.trimColor.mul(trim).add(u.wallRimColor.mul(fres.mul(u.wallRimGain)));
  })();

  const coverMat = new MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
  coverMat.colorNode = Fn(() => concreteAlbedo(coverConcrete, u.coverColor))();
  coverMat.emissiveNode = Fn(() => {
    const sideMask = step(abs(normalLocal.y), 0.5);
    const capMask = smoothstep(0.5, 0.9, normalLocal.y);
    // diagonal hazard stripes, banded to the top third of the piece
    const s = fract(positionWorld.x.sub(positionWorld.y).add(positionWorld.z.mul(0.3)).div(u.stripePitch.max(0.05)));
    const stripe = smoothstep(0.20, 0.30, abs(s.sub(0.5)));
    const belt = smoothstep(0.55, 0.80, uv().y);
    return u.stripeColor.mul(stripe.mul(belt).mul(sideMask).mul(u.stripeGain))
      .add(u.capColor.mul(capMask).mul(u.capGain));
  })();

  // ── bot materials ─────────────────────────────────────────────────────────
  // The map is bright because it EMITS; the bots only ever reflected, which is exactly why they
  // disappeared once the dim themes turned the rig down. These are the same role materials
  // body-part-batches.js would have built (identical roughness/metalness so the shading matches),
  // plus an emissive term keyed to each bot's own instance colour and a fresnel rim. Cost is one
  // extra term in a shader that already runs — no lights, no extra draws.
  // rimScale/glowScale exist for the FACE roles. Armour can afford to self-illuminate; skin cannot.
  // At full gain the face emits its own skin colour and the whole head flattens to one pale value —
  // brows, mouth and eye sockets all wash out and the head reads as a blank mask. Held at ~a fifth,
  // the face still lifts off the background on the dark themes without losing its shading.
  function botRoleMaterial(roughness, metalness, glow, { rimScale = 1, glowScale = 1 } = {}) {
    const m = new MeshStandardNodeMaterial({ color: 0xffffff, roughness, metalness });
    m.emissiveNode = Fn(() => {
      const V = normalize(cameraPosition.sub(positionWorld));
      const fres = pow(clamp(dot(normalize(normalWorld), V), 0, 1).oneMinus(), u.botRimPower);
      // The rim leans toward the bot's own colour so teams stay apart even in the silhouette.
      const rim = mix(u.botRimColor, instanceTint, 0.35).mul(fres.mul(u.botRimGain).mul(rimScale));
      return instanceTint.mul(glow).mul(glowScale).add(rim);
    })();
    return m;
  }

  // Untinted hardware roles: no instance colour, so they read as real materials (bare metal,
  // matte rubber) against the team-tinted shell instead of taking the team hue.
  function botHardwareMaterial(color, roughness, metalness, rimGain) {
    const m = new MeshStandardNodeMaterial({ color, roughness, metalness });
    m.emissiveNode = Fn(() => {
      const V = normalize(cameraPosition.sub(positionWorld));
      const fres = pow(clamp(dot(normalize(normalWorld), V), 0, 1).oneMinus(), u.botRimPower);
      return u.botRimColor.mul(fres.mul(u.botRimGain).mul(rimGain));
    })();
    return m;
  }

  const botMaterials = {
    shell: botRoleMaterial(0.65, 0.05, u.shellGlow),
    plate: botRoleMaterial(0.55, 0.10, u.plateGlow),
    trim: botRoleMaterial(0.40, 0.15, u.trimGlow),
    accent: botRoleMaterial(0.50, 0.20, u.trimGlow),
    // metalness must stay LOW here. IBL/PMREM is off by default (see the env block below), and a
    // near-1.0 metalness material with no environment to reflect renders BLACK — every metal seam,
    // vent and lens housing on the bots was rendering as a void instead of bright hardware.
    metal: botHardwareMaterial(0x6f7681, 0.42, 0.25, 1.10),
    rubber: botHardwareMaterial(0x101317, 0.95, 0.0, 0.45),
    // tan webbing: the mid-value band between team shell and bare metal. Without it the model is
    // shell-vs-grey with nothing bridging, which reads toy-like.
    fabric: botHardwareMaterial(0x8d7c58, 0.98, 0.0, 0.55),
    // Visor glass. A DARK amber base with a strong fresnel sheen, not a bright fill: a flat
    // light-valued visor reads as a bandage or censor bar taped over the face, because real
    // ballistic glass is darker than the shell around it and only lights up at grazing angles.
    // The +0.10 floor keeps it from going pure black when viewed dead-on.
    visor: (() => {
      const m = new MeshStandardNodeMaterial({ color: 0x231803, roughness: 0.10, metalness: 0.30 });
      m.emissiveNode = Fn(() => {
        const V = normalize(cameraPosition.sub(positionWorld));
        const fres = pow(clamp(dot(normalize(normalWorld), V), 0, 1).oneMinus(), 2.2);
        return u.visorColor.mul(fres.mul(u.visorGain).add(0.10));
      })();
      return m;
    })(),
    // The eye has no instance colour allocated (body-part-batches leaves that bucket flat), so it
    // takes theme.bots.eyeColor directly: a lit visor rather than the old flat-black dot.
    eye: new MeshBasicNodeMaterial({ side: THREE.DoubleSide }),
    // ---- human face roles (bot-face.js) ----
    // skin and hair take the per-instance tint, so a squad varies in skin tone for free. Their
    // glow is held right down — see botRoleMaterial: a self-lit face is a blank mask.
    skin: botRoleMaterial(0.72, 0.0, u.shellGlow, { glowScale: 0.15, rimScale: 0.30 }),
    hair: botRoleMaterial(0.85, 0.0, u.plateGlow, { glowScale: 0.15, rimScale: 0.25 }),
    // Eye and mouth rims are held down hard for the same reason, and harder: a fresnel rim on a
    // 9 mm pupil washes it to mid-grey at grazing angles, and the eye is the one feature that has
    // to stay dark to read at all.
    sclera: botHardwareMaterial(0xe6ded0, 0.35, 0.0, 0.20),
    pupil: botHardwareMaterial(0x141110, 0.30, 0.0, 0.06),
    mouth: botHardwareMaterial(0x6b3630, 0.55, 0.0, 0.20),
    // Uniform fabric. Glow is held even lower than skin and the rim is nearly off: at armour gain a
    // pale uniform blew out to a flat glowing mint and read as spandex, and a blown-out surface has
    // no shading, so the limb profiles underneath it were invisible. Cloth absorbs; it does not lift.
    cloth: botRoleMaterial(0.94, 0.0, u.shellGlow, { glowScale: 0.08, rimScale: 0.15 }),
  };
  botMaterials.eye.colorNode = u.eyeColor.mul(u.eyeGlow);

  // ── bot FX pools ──────────────────────────────────────────────────────────
  // Immediate mode, same contract as body-part-batches: begin, add per bot, end + upload. Both
  // pools are ONE draw call for the whole roster.
  // Bounds an attribute's GPU upload to [0, count) — same helper body-part-batches.js uses. Without
  // it, `needsUpdate` re-uploads all BOT_FX_CAP instances every frame whether 5 bots are alive or
  // 200. No-op on builds whose backend doesn't honour update ranges.
  function setUpdateRange(attr, count) {
    if (attr.clearUpdateRanges) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, count);
    } else if (attr.updateRange) {
      attr.updateRange.offset = 0;
      attr.updateRange.count = count;
    }
  }

  function makeFxPool(geometry, material) {
    const mesh = new THREE.InstancedMesh(geometry, material, BOT_FX_CAP);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 3;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(mesh);
    let n = 0;
    return {
      mesh,
      begin() { n = 0; },
      add(matrix, color) {
        if (n >= BOT_FX_CAP) return;
        mesh.setMatrixAt(n, matrix);
        if (color && mesh.setColorAt) mesh.setColorAt(n, color);
        n++;
      },
      end(on) {
        mesh.count = on ? n : 0;
        mesh.visible = !!on && n > 0;
        if (!mesh.count) return;
        // add() rewrites [0, n) fresh every frame, so that's the entire live range.
        setUpdateRange(mesh.instanceMatrix, mesh.count * 16);
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) {
          setUpdateRange(mesh.instanceColor, mesh.count * 3);
          mesh.instanceColor.needsUpdate = true;
        }
      },
    };
  }

  // Ground pool: a soft additive disc under each bot. Fakes the contact light a real per-bot lamp
  // would cast, grounds bots that otherwise float over a dark deck, and reads stance from above.
  const poolMat = new MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: true,
  });
  poolMat.fog = false;   // additive geometry + fog just adds haze to the scene
  poolMat.colorNode = Fn(() => {
    const d = length(uv().sub(vec2(0.5, 0.5))).mul(2);
    // smoothstep, not a bare 1-d: a linear rolloff clips against the additive ceiling and the
    // pool reads as a hard-edged solid disc rather than light falling on the floor.
    const f = pow(smoothstep(1.0, 0.0, d), 2.4);
    return vec3(f, f, f).mul(u.poolGain);
  })();
  const poolGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const pools = makeFxPool(poolGeo, poolMat);

  // Flashlight cone: fake volumetrics, one instanced cone per bot. A real SpotLight per bot is the
  // same non-starter as a real point light per bot; only the focused bot gets an actual light.
  // Geometry is authored apex-at-origin opening down +Z so the instance matrix is just a basis.
  const beamGeo = new THREE.ConeGeometry(1, 1, 20, 1, true)
    .translate(0, -0.5, 0)
    .rotateX(-Math.PI / 2);
  const beamMat = new MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending, toneMapped: true,
  });
  beamMat.fog = false;
  beamMat.colorNode = Fn(() => {
    const t = clamp(positionLocal.z, 0, 1);                 // 0 at the lens, 1 at the far cap
    const falloff = pow(t.oneMinus(), 1.6);
    // Grazing the cone wall is brighter than looking through it — without this the beam reads as
    // a hard-edged solid triangle instead of light in air.
    const V = cameraPosition.sub(positionWorld);
    const graze = clamp(dot(normalize(normalWorld), normalize(V)), 0, 1).oneMinus();
    // Additive volume + a camera sitting inside it = a white screen. Fade the cone out as it
    // approaches the near plane so following a bot closely never whites the frame out.
    const near = smoothstep(0.25, 1.6, length(V));
    return u.beamColor.mul(falloff.mul(graze.mul(0.7).add(0.3)).mul(near)).mul(u.beamGain);
  })();
  const beams = makeFxPool(beamGeo, beamMat);

  // ── lights ────────────────────────────────────────────────────────────────
  const rimLight = new THREE.DirectionalLight(0xffffff, 0);
  rimLight.name = 'botViewerRimLight';
  scene.add(rimLight);

  const ACCENT_COUNT = 4;
  const accentLights = [];
  for (let i = 0; i < ACCENT_COUNT; i++) {
    const l = new THREE.PointLight(0xffffff, 0, 20, 2);
    l.name = `botViewerAccentLight${i}`;
    l.userData.phase = (i / ACCENT_COUNT) * Math.PI * 2;
    scene.add(l);
    accentLights.push(l);
  }

  // ── dynamic light budget ──────────────────────────────────────────────────
  // Not one light per bot — a fixed pool of real point lights that events borrow for a few frames.
  // Muzzle flashes and blasts are what actually want a light (a firefight should strobe the walls),
  // and they're transient, so a handful of slots covers a whole engagement at bounded cost.
  const dynLights = [];
  for (let i = 0; i < DYN_LIGHT_COUNT; i++) {
    const l = new THREE.PointLight(0xffffff, 0, 10, 2);
    l.name = `botViewerDynLight${i}`;
    l.visible = false;
    scene.add(l);
    dynLights.push(l);
  }

  // Ring of reusable flash records: a new flash overwrites the oldest slot, so a sustained
  // full-auto exchange never allocates.
  const flashRing = [];
  for (let i = 0; i < FLASH_CAP; i++) {
    flashRing.push({
      x: 0, y: 0, z: 0, color: C(0xffffff),
      intensity: 0, distance: 0, life: 0, age: 0, weight: 0, curve: 0, active: false,
    });
  }
  let flashCursor = 0;
  const _liveFlashes = [];
  const _pickedFlashes = [];

  // The flash colour, sampled at the moment of the shot. Default is the theme's warm propellant
  // colour (or whatever the caller asked for — blasts pass their own). With `flashTint` on, the
  // tint wins over BOTH, including explosions: half-tinted combat would just read as a bug. When
  // flashTintCycle is non-zero the tint walks the hue wheel, so a burst comes out as a gradient.
  function flashColorFor(opts) {
    const b = theme.bots;
    if (!toggles.flashTint) return opts?.color ?? b.flashColor;
    return cycleHueHex(b.flashTintColor, b.flashTintCycle ? elapsed * b.flashTintCycle : 0);
  }

  // pos: anything with x/y/z. opts overrides the theme's flash colour/intensity/distance/life.
  function flash(pos, opts) {
    if (!toggles.dynamicLights || !pos) return;
    const b = theme.bots;
    const f = flashRing[flashCursor];
    flashCursor = (flashCursor + 1) % FLASH_CAP;
    f.x = pos.x; f.y = pos.y; f.z = pos.z;
    f.color.set(flashColorFor(opts));
    // Stored unscaled: master.brightness is applied when the slot is written, so dragging the
    // brightness slider mid-firefight moves flashes already in flight instead of only new ones.
    f.intensity = opts?.intensity ?? b.flashIntensity;
    f.distance = opts?.distance ?? b.flashDistance;
    f.life = opts?.life ?? b.flashLife;
    f.age = 0;
    f.active = true;
  }

  function updateDynamicLights(dt) {
    _liveFlashes.length = 0;
    for (const f of flashRing) {
      if (!f.active) continue;
      f.age += dt;
      f.curve = flashCurve(f.age, f.life);
      if (f.curve <= 0) { f.active = false; continue; }
      // Brighter and nearer wins the slot; distance is soft so a far-off firefight still registers.
      const dx = f.x - camera.position.x, dy = f.y - camera.position.y, dz = f.z - camera.position.z;
      f.weight = (f.intensity * f.curve) / (1 + Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.25);
      _liveFlashes.push(f);
    }
    const picked = pickLightSlotsInto(
      toggles.dynamicLights ? _liveFlashes : EMPTY, dynLights.length, _pickedFlashes);
    // NEVER touch `.visible` here. On the WebGPU backend the set of visible lights feeds the lights
    // hash that keys the render pipeline, so a light appearing or disappearing recompiles EVERY
    // material in the scene. Flipping that on and off per muzzle flash is a recompile storm that
    // drops a firefight to single-digit fps. Visibility is structural; intensity is a uniform, and
    // an unused slot idles at intensity 0. `applyBots()` owns `.visible`, and only on a toggle.
    for (let i = 0; i < dynLights.length; i++) {
      const l = dynLights[i], f = picked[i];
      if (!f) { l.intensity = 0; continue; }
      l.position.set(f.x, f.y, f.z);
      l.color.copy(f.color);
      l.distance = f.distance;
      l.intensity = f.intensity * f.curve * master.brightness;
    }
  }

  // The one genuinely real flashlight, spent on whichever bot the user is watching.
  const focusSpot = new THREE.SpotLight(0xffffff, 0, 14, 0.3, 0.45, 1.2);
  focusSpot.name = 'botViewerFocusSpot';
  focusSpot.visible = false;
  focusSpot.castShadow = false;
  scene.add(focusSpot);
  scene.add(focusSpot.target);
  let focusSpotBase = 0;

  // ── env reflections (IBL) ─────────────────────────────────────────────────
  // Off by default: PMREM on the WebGPU backend is a one-off render of the dome into a mip
  // chain. If it isn't available in this build it degrades to "no reflections" rather than
  // taking the viewer down.
  let pmrem = null;
  let envRT = null;
  let envBusy = false;
  async function rebuildEnv() {
    if (!toggles.reflections) {
      scene.environment = null;
      applyFloorFinish();
      return;
    }
    if (envBusy) return;
    envBusy = true;
    try {
      if (!pmrem) pmrem = new THREE.PMREMGenerator(renderer);
      const holder = new THREE.Scene();
      const proxy = new THREE.Mesh(skyMesh.geometry, skyMat);
      holder.add(proxy);
      // near/far must straddle SKY_RADIUS -- PMREM's default far (100) is inside the dome.
      const rt = pmrem.fromSceneAsync
        ? await pmrem.fromSceneAsync(holder, 0, 1, SKY_RADIUS * 2)
        : pmrem.fromScene(holder, 0, 1, SKY_RADIUS * 2);
      envRT?.dispose();
      envRT = rt;
      scene.environment = rt.texture;
      scene.environmentIntensity = theme.env.intensity * master.brightness;
    } catch (err) {
      console.warn('[visuals] env reflections unavailable:', err);
      toggles.reflections = false;
      scene.environment = null;
    } finally {
      envBusy = false;
      applyFloorFinish();
      syncPanel();
    }
  }

  // Reflective deck only makes sense with an env map to reflect.
  function applyFloorFinish() {
    const f = theme.mats.floor;
    const on = toggles.reflections && !!scene.environment;
    floorMat.metalness = on ? f.reflectMetalness : f.metalness;
    floorMat.roughness = on ? f.reflectRoughness : f.roughness;
    terrainMat.metalness = floorMat.metalness;
    terrainMat.roughness = floorMat.roughness;
  }

  // ── theme application ─────────────────────────────────────────────────────

  function applySky() {
    const s = theme.sky;
    u.horizon.value.set(s.horizon); u.zenith.value.set(s.zenith); u.ground.value.set(s.groundTint);
    u.nebA.value.set(s.nebulaA); u.nebB.value.set(s.nebulaB);
    u.nebGain.value = toggles.nebula ? s.nebulaGain : 0;
    u.nebScale.value = s.nebulaScale; u.nebTilt.value = s.nebulaTilt;
    u.starGain.value = toggles.stars ? s.starGain : 0;
    u.starDensity.value = s.starDensity; u.starTwinkle.value = s.starTwinkle;
    u.starWrap.value = s.starWrap;
    u.sunColor.value.set(s.sunColor);
    u.sunGain.value = toggles.sunGlow ? s.sunGain : 0;
    u.sunSize.value = s.sunSize;
    u.sunDir.value.copy(dirFromAngles(THREE, theme.lights.key.azimuth, theme.lights.key.elevation));

    const p = s.planet;
    u.planetColor.value.set(p.color); u.planetAtmo.value.set(p.atmo);
    u.planetDir.value.copy(dirFromAngles(THREE, p.azimuth, p.elevation));
    const ang = Math.max(0.01, p.size);              // angular radius in radians
    u.planetCos.value = Math.cos(ang);
    u.planetSin.value = Math.max(1e-3, Math.sin(ang));
    u.planetHaloCos.value = Math.cos(Math.min(Math.PI * 0.5, ang * 1.35));
    u.planetBands.value = p.bands;
    u.planetOn.value = toggles.planet ? 1 : 0;

    skyMesh.visible = toggles.sky;
    scene.background = toggles.sky ? null : C(theme.bg);
    captureBase(SKY_KEYS, skyBase);   // audio pumps these; it must scale the value just written
  }

  function applyMaterials() {
    const f = theme.mats.floor, w = theme.mats.wall, c = theme.mats.cover;
    const neon = master.neon;

    u.floorColor.value.set(f.color);
    u.floorVig.value = f.vignette;
    u.floorMossColor.value.set(f.mossColor ?? 0x4a6b32);
    u.floorMossGain.value = toggles.concrete ? (f.mossGain ?? 0) : 0;
    u.floorMossScale.value = f.mossScale ?? 0.55;
    soil.set(soilFor(f.soil));   // theme.mats.floor.soil: optional soil-shade block, absent = off
    u.gridColor.value.set(f.gridColor);
    u.gridPitch.value = f.gridPitch; u.gridWidth.value = f.gridWidth; u.gridFade.value = f.gridFade;
    u.gridGain.value = toggles.grid ? f.gridGain * neon : 0;
    u.scanColor.value.set(f.scanColor);
    u.scanGain.value = toggles.scan ? f.scanGain * neon : 0;
    u.scanPeriod.value = f.scanPeriod; u.scanWidth.value = f.scanWidth;
    applyFloorFinish();

    u.wallColor.value.set(w.color);
    wallMat.roughness = w.roughness; wallMat.metalness = w.metalness;
    u.trimColor.value.set(w.trimColor);
    u.trimGain.value = toggles.trim ? w.trimGain * neon : 0;
    u.trimTop.value = w.trimTop; u.trimBottom.value = w.trimBottom; u.trimWidth.value = w.trimWidth;
    u.pulseGain.value = toggles.pulse ? w.pulseGain : 0;
    u.pulseSpeed.value = w.pulseSpeed; u.pulseScale.value = w.pulseScale;
    u.wallRimColor.value.set(w.rimColor);
    u.wallRimGain.value = toggles.rim ? w.rimGain : 0;
    u.wallRimPower.value = w.rimPower;
    applyConcrete(wallConcrete, w, toggles.concrete);

    u.coverColor.value.set(c.color);
    coverMat.roughness = c.roughness; coverMat.metalness = c.metalness;
    u.stripeColor.value.set(c.stripeColor);
    u.stripeGain.value = toggles.trim ? c.stripeGain * neon : 0;
    u.stripePitch.value = c.stripePitch;
    u.capColor.value.set(c.capColor);
    u.capGain.value = toggles.trim ? c.capGain * neon : 0;
    applyConcrete(coverConcrete, c, toggles.concrete);
    captureBase(NEON_KEYS, neonBase);
  }

  function applyBots() {
    const b = theme.bots, neon = master.neon;
    const glow = toggles.botGlow ? neon : 0;
    u.shellGlow.value = b.shellGlow * glow;
    u.plateGlow.value = b.plateGlow * glow;
    u.trimGlow.value = b.trimGlow * glow;
    u.eyeColor.value.set(b.eyeColor);
    u.eyeGlow.value = b.eyeGlow * glow;
    // visor sheen is NOT gated on botGlow: the glass has to stay legible with neon effects off.
    u.visorColor.value.set(b.visorColor ?? 0xffa83c);
    u.visorGain.value = b.visorGain ?? 1.5;
    u.botRimColor.value.set(b.rimColor);
    u.botRimGain.value = toggles.botRim ? b.rimGain * neon : 0;
    u.botRimPower.value = b.rimPower;
    u.poolGain.value = toggles.groundPools ? b.poolGain * neon : 0;
    u.beamColor.value.set(b.beamColor);
    u.beamGain.value = toggles.flashlights ? b.beamGain * neon : 0;
    // The only place light VISIBILITY changes: a panel toggle, which is allowed to cost one
    // recompile. Everything per-frame drives intensity instead (see updateDynamicLights).
    for (const l of dynLights) l.visible = toggles.dynamicLights;
    // u.beamGain is already toggle- and neon-resolved above, so this drops the spot out of the
    // per-fragment light loop whenever the cones aren't being drawn either.
    const beamsOn = u.beamGain.value > 0 && b.beamIntensity > 0;
    focusSpot.visible = beamsOn;
    focusSpot.color.set(b.beamColor);
    focusSpot.angle = Math.min(Math.PI / 2 - 0.01, b.beamAngle * DEG);
    focusSpot.distance = b.beamLength * 1.4;
    focusSpotBase = beamsOn ? b.beamIntensity * master.brightness : 0;
    captureBase(BOT_KEYS, botBase);
  }

  // Parks the key light relative to the CURRENT arena and fits its shadow box to it. A
  // DirectionalLight's shadow camera is an ortho box anchored at the light and aimed at its target,
  // so both have to move with the map: the shipped rig had a fixed +/-12 m box aimed at the origin
  // with a far plane of 40 while the light sat 50 m out, which put the whole scene behind the far
  // plane — the shadow pass rendered a 2048^2 map of nothing, every frame, on every layout.
  function fitKeyLight() {
    const t = rig.dirLight.target;
    if (!t.parent) scene.add(t);          // matrixWorld only tracks the light for scene members
    const f = fitShadowBox(bounds, SHADOW_HEIGHT);
    const dir = dirFromAngles(THREE, theme.lights.key.azimuth, theme.lights.key.elevation);
    t.position.set(f.cx, f.cy, f.cz);
    t.updateMatrixWorld();
    rig.dirLight.position.set(f.cx + dir.x * f.dist, f.cy + dir.y * f.dist, f.cz + dir.z * f.dist);
    const cam = rig.dirLight.shadow.camera;
    cam.left = -f.radius; cam.right = f.radius; cam.top = f.radius; cam.bottom = -f.radius;
    cam.near = f.near; cam.far = f.far;
    cam.updateProjectionMatrix();         // LightShadow.updateMatrices does NOT do this for us
  }

  function applyLights() {
    const L = theme.lights, b = master.brightness;
    rig.dirLight.color.set(L.key.color);
    keyBase = L.key.intensity * b * (1 - 0.65 * weather.dim);
    rig.dirLight.intensity = keyBase + lightningLevel * 3;
    fitKeyLight();
    rig.dirLight.castShadow = toggles.shadows;
    rig.ambLight.color.set(L.ambient.color);
    rig.ambLight.intensity = L.ambient.intensity * b * (1 - 0.3 * weather.dim);

    overheadLight.color.set(L.overhead.color);
    overheadLight.intensity = L.overhead.intensity * b;
    overheadLight.distance = L.overhead.distance;
    overheadLight.position.y = L.overhead.height;

    const rimDir = dirFromAngles(THREE, L.rim.azimuth, L.rim.elevation);
    rimLight.color.set(L.rim.color);
    rimLight.intensity = L.rim.intensity * b;
    rimLight.position.copy(rimDir).multiplyScalar(40);
    // Same gate placeAccentLights uses: a zero-intensity light is still evaluated per fragment, and
    // `hangar` ships rim.intensity 0. Safe to flip here — this is theme/slider time, never a frame.
    rimLight.visible = L.rim.intensity > 0;

    placeAccentLights();
    if (scene.environment) scene.environmentIntensity = theme.env.intensity * b;
  }

  // Accent lights sit just inside the arena corners at the theme's height — they give the map
  // coloured bounce that the single overhead point light can't.
  function placeAccentLights() {
    const A = theme.lights.accents;
    const cx = (bounds.minX + bounds.maxX) / 2, cz = (bounds.minZ + bounds.maxZ) / 2;
    const hx = Math.max(2, (bounds.maxX - bounds.minX) / 2 - 1.5);
    const hz = Math.max(2, (bounds.maxZ - bounds.minZ) / 2 - 1.5);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (let i = 0; i < accentLights.length; i++) {
      const l = accentLights[i];
      const [sx, sz] = corners[i % 4];
      l.position.set(cx + sx * hx, A.height, cz + sz * hz);
      l.color.set(i % 2 === 0 ? A.colorA : A.colorB);
      l.distance = A.radius;
      l.userData.base = A.intensity * master.brightness;
      l.intensity = l.userData.base;
      l.visible = A.intensity > 0;
    }
  }

  const RAIN_FOG = C(0x59616b);
  function applyFog() {
    if (!toggles.fog || theme.fog.density <= 0) { scene.fog = null; return; }
    const d = theme.fog.density * master.fogScale * weather.fogBoost;
    if (!(scene.fog instanceof THREE.FogExp2)) scene.fog = new THREE.FogExp2(theme.fog.color, d);
    scene.fog.color.set(theme.fog.color).lerp(RAIN_FOG, weather.dim * 0.6);
    scene.fog.density = d;
  }
  // Rain wiring calls this with what it fans out of one slider; each field is optional.
  function setWeather({ overcast, dim, fogBoost } = {}) {
    if (Number.isFinite(overcast)) weather.overcast = overcast;
    if (Number.isFinite(dim)) weather.dim = dim;
    if (Number.isFinite(fogBoost)) weather.fogBoost = fogBoost;
    u.overcast.value = weather.overcast;
    applyLights(); applyFog();
  }
  // Per-frame lightning level 0..1+: key light jumps and the cloud lid brightens; no re-apply.
  function setLightning(v) {
    lightningLevel = Math.max(0, v || 0);
    u.lightning.value = lightningLevel;
    rig.dirLight.intensity = keyBase + lightningLevel * 3;
  }

  let appliedTone = null;
  function applyPost() {
    const p = theme.post;
    // setToneMapping rebuilds the post graph (a pipeline recompile) -- only on a real change.
    if (p.tone !== appliedTone) { postFX.setToneMapping(p.tone); appliedTone = p.tone; }
    postFX.setExposure(p.exposure);
    postFX.setBloom(p.bloom.strength * master.bloom, p.bloom.radius, p.bloom.threshold);
    postFX.setGrade({
      brightness: 0,
      contrast: p.grade.contrast,
      gamma: p.grade.gamma,
      gain: 1,
      saturation: p.grade.saturation * master.saturation,
      temperature: p.grade.temperature,
      tint: p.grade.tint,
      vignette: p.grade.vignette,
      vignetteSoft: p.grade.vignetteSoft,
    });
  }

  function applyAll() {
    applySky();
    applyMaterials();
    applyBots();
    applyLights();
    applyFog();
    applyPost();
    // Last, so anything the host rebuilds in response sees the finished theme.
    onLookChange();
  }

  function setTheme(next) {
    // normalizeTheme, not cloneTheme: a look slot saved before a section existed would otherwise
    // reach applyBots() with theme.bots undefined and throw.
    theme = normalizeTheme(next);
    resolveToggles();   // new theme defaults, but the user's explicit toggles still win
    applyAll();
    if (toggles.reflections) rebuildEnv();
    else { scene.environment = null; applyFloorFinish(); }
    syncPanel();
  }

  function setThemeKey(key) {
    setTheme(key === 'random' ? randomTheme(randomSeed) : getTheme(key));
    currentKey = key;
    syncPanel();
  }

  function rollRandomTheme() {
    randomSeed = (Math.random() * 0xffffffff) >>> 0;
    currentKey = 'random';
    setTheme(randomTheme(randomSeed));
    syncPanel();
  }

  // Whole-look snapshot for the panel's save/load slots. The theme object is stored verbatim
  // rather than by key: sliders edit it in place, so a key alone would lose every hand-tweak.
  function getLookState() {
    return {
      themeKey: currentKey,
      randomSeed,
      theme: cloneTheme(theme),
      pinnedToggles: { ...toggleOverrides },
      master: { ...master },
      audioReactive,
      audioDrive,
      audioTargets: { ...audioTargets },
    };
  }

  function applyLookState(state) {
    if (!state || typeof state !== 'object') return false;
    if (state.master) for (const k of Object.keys(master)) if (typeof state.master[k] === 'number') master[k] = state.master[k];
    if (typeof state.audioReactive === 'boolean') audioReactive = state.audioReactive;
    if (Number.isFinite(state.audioDrive)) audioDrive = state.audioDrive;
    // Slots saved before per-target routing existed carry no targets — those keep the defaults.
    if (state.audioTargets) {
      for (const k of REACTIVE_KEYS) {
        if (typeof state.audioTargets[k] === 'boolean') audioTargets[k] = state.audioTargets[k];
      }
    }
    toggleOverrides = { ...(state.pinnedToggles || {}) };
    if (Number.isFinite(state.randomSeed)) randomSeed = state.randomSeed;
    if (state.theme) { currentKey = state.themeKey || currentKey; setTheme(state.theme); }
    else if (state.themeKey) setThemeKey(state.themeKey);
    else { resolveToggles(); applyAll(); }
    syncPanel();
    return true;
  }

  let currentKey = DEFAULT_THEME;

  // ── per-frame bot FX ──────────────────────────────────────────────────────
  // Immediate mode: begin, one addBotFx per living bot, end. Everything here is scratch-based —
  // this runs 200+ times a frame under the Test condition, so it must not allocate.
  const _mtx = new THREE.Matrix4();
  const _pos = new THREE.Vector3();
  const _scl = new THREE.Vector3();
  const _fwd = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _up = new THREE.Vector3();
  const _UP = new THREE.Vector3(0, 1, 0);
  const _tint = C(0xffffff);
  const _q = new THREE.Quaternion();
  let focusBeamSet = false;

  function beginBotFx() {
    pools.begin();
    beams.begin();
    focusBeamSet = false;
  }

  // yaw/pitch in radians, matching the viewer's own convention (forward = sin(yaw), cos(yaw)).
  // Both gates read the RESOLVED uniform, not the raw theme value: u.poolGain/u.beamGain already
  // fold in the toggle and master.neon, so with neon at 0 this correctly builds nothing instead of
  // submitting 200 instances that shade to pure black.
  function addBotFx(x, footY, z, height, yaw, pitch, colorHex, isFocus) {
    const b = theme.bots;
    if (u.poolGain.value > 0) {
      const r = b.poolRadius * poolScaleForHeight(height);
      _pos.set(x, footY + 0.03, z);
      _scl.set(r * 2, 1, r * 2);
      _mtx.compose(_pos, _q.identity(), _scl);
      _tint.set(colorHex);
      pools.add(_mtx, _tint);
    }
    if (u.beamGain.value > 0) {
      const cp = Math.cos(pitch || 0);
      _fwd.set(Math.sin(yaw) * cp, Math.sin(pitch || 0), Math.cos(yaw) * cp).normalize();
      _right.crossVectors(_UP, _fwd);
      // Straight up/down would collapse the basis; bots aim near-horizontal, but a ragdoll can not.
      if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0); else _right.normalize();
      _up.crossVectors(_fwd, _right).normalize();
      const len = b.beamLength;
      const rad = len * Math.tan(b.beamAngle * DEG);
      _pos.set(x, footY + height * 0.82, z).addScaledVector(_fwd, 0.18);
      _mtx.makeBasis(_right, _up, _fwd);
      _mtx.scale(_scl.set(rad, rad, len));
      _mtx.setPosition(_pos);
      beams.add(_mtx, null);
      if (isFocus && !focusBeamSet) {
        focusBeamSet = true;
        focusSpot.position.copy(_pos);
        focusSpot.target.position.copy(_pos).addScaledVector(_fwd, len);
        focusSpot.target.updateMatrixWorld();
      }
    }
  }

  function endBotFx() {
    pools.end(u.poolGain.value > 0);
    beams.end(u.beamGain.value > 0);
    // Intensity only, for the same reason as the dynamic lights above — the focused bot changes
    // often enough that toggling this light's visibility would recompile on every focus change.
    focusSpot.intensity = focusBeamSet ? focusSpotBase : 0;
  }

  // ── per-frame ─────────────────────────────────────────────────────────────
  // ── audio-reactive drive ──────────────────────────────────────────────────
  // Music drives five groups of look values, each on its own band mix (REACTIVE_TARGETS in the
  // style module, where the routing maths is Node-tested). Every group MULTIPLIES the theme's own
  // numbers rather than setting them: the slider you moved is still the ceiling, and anything the
  // theme leaves at 0 stays off however loud the track is. Each group writes only while it is
  // actually pumping, plus one restoring write when it stops, so nothing fights the panel.
  let audioReactive = false;
  let audioDrive = 1.0;
  let audioTargets = defaultReactiveTargets();
  const audioMix = { bass: 0, mid: 0, treble: 0, level: 0, beat: 0 };
  // Per-target enable, ramped rather than switched: flipping a group off mid-track should fade it
  // back to the theme value over ~an eighth of a second, not cut.
  const targetWeight = {};
  for (const k of REACTIVE_KEYS) targetWeight[k] = audioTargets[k] ? 1 : 0;

  // Theme-resolved values captured by the applyX() functions, so a per-frame write always scales
  // the CURRENT panel state instead of compounding off its own previous output.
  const NEON_KEYS = ['gridGain', 'scanGain', 'trimGain', 'stripeGain', 'capGain', 'pulseGain'];
  const BOT_KEYS = ['shellGlow', 'plateGlow', 'trimGlow', 'eyeGlow', 'botRimGain', 'poolGain'];
  const SKY_KEYS = ['nebGain', 'starGain', 'sunGain'];
  // `live` is the subset whose base is non-zero. 0 * anything is 0, so pumping a uniform the theme
  // has switched off would dirty that material's uniform buffer every frame to write the same 0.
  const neonBase = { live: [], vals: {} }, botBase = { live: [], vals: {} }, skyBase = { live: [], vals: {} };
  const pumped = { neon: false, bots: false, sky: false, bloom: false };
  function captureBase(keys, base) {
    base.live.length = 0;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i], v = u[k].value;
      base.vals[k] = v;
      if (v !== 0) base.live.push(k);
    }
  }

  function gainFor(key) {
    const w = targetWeight[key];
    return w > 0 ? reactiveGain(audioMix, REACTIVE_TARGETS[key], audioDrive) * w : 0;
  }

  function pumpGroup(key, base) {
    const g = gainFor(key);
    const on = g > 0.001;
    if (!on && !pumped[key]) return;      // idle: not one uniform write per frame
    const m = 1 + g;
    const live = base.live;
    for (let i = 0; i < live.length; i++) u[live[i]].value = base.vals[live[i]] * m;
    pumped[key] = on;
  }

  function updateAudio(dt) {
    // The mix decays on null levels, which is what makes switching the feature off ramp down.
    advanceAudioMix(audioMix, audioReactive && getAudioLevels ? getAudioLevels() : null, dt);
    const kw = Math.min(1, dt * 8);
    for (let i = 0; i < REACTIVE_KEYS.length; i++) {
      const k = REACTIVE_KEYS[i];
      targetWeight[k] += ((audioReactive && audioTargets[k] ? 1 : 0) - targetWeight[k]) * kw;
    }
  }

  function update(dt) {
    elapsed += dt;
    skyMesh.position.copy(camera.position);
    u.skyDrift.value = elapsed * 0.004;
    updateAudio(dt);
    // Accent lights: the existing sine breathe plus the music term. No restore needed — this loop
    // rewrites intensity from `base` every frame regardless.
    const pump = gainFor('lights');
    for (const l of accentLights) {
      if (!l.visible) continue;
      l.intensity = l.userData.base * (1 + 0.18 * Math.sin(elapsed * 0.9 + l.userData.phase) + pump);
    }
    pumpGroup('neon', neonBase);
    pumpGroup('bots', botBase);
    pumpGroup('sky', skyBase);
    const bloom = gainFor('bloom');
    if (bloom > 0.001 || pumped.bloom) {
      const p = theme.post;
      postFX.setBloom(p.bloom.strength * master.bloom * (1 + bloom), p.bloom.radius, p.bloom.threshold);
      pumped.bloom = bloom > 0.001;
    }
    updateDynamicLights(dt);
  }

  function setBounds(b) {
    bounds = b;
    const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
    u.arenaCenter.value.set(cx, cz);
    u.arenaRadius.value = Math.max(4, Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ) / 2);
    placeAccentLights();
    fitKeyLight();
  }

  scene.add(skyMesh);
  applyAll();

  // ── control panel ─────────────────────────────────────────────────────────
  // Built in the viewer's own #ctrl idiom (.ttl headings, full-width buttons, .row sliders) so
  // it drops straight into the existing panel column.
  const syncers = [];
  function syncPanel() { for (const s of syncers) s(); }

  const el = (tag, props) => Object.assign(document.createElement(tag), props || {});
  const labelSpan = (t) => el('span', { textContent: t });

  // Clicking pins the toggle: it becomes an override that survives every later theme switch, and
  // gets a left accent bar so you can see at a glance which ones you own vs. which the theme
  // still drives. Shift+click hands it back to the theme.
  function makeToggle(label, key, onChange) {
    const btn = el('button');
    const sync = () => {
      const pinned = key in toggleOverrides;
      btn.textContent = `${label}: ${toggles[key] ? 'On' : 'Off'}`;
      btn.style.borderLeft = pinned ? '3px solid var(--wui-accent)' : '';
      btn.title = pinned
        ? 'Pinned — themes will not change this. Shift+click to hand it back to the theme.'
        : 'Follows the theme. Click to pin your own value across theme switches.';
    };
    btn.addEventListener('click', (event) => {
      if (event.shiftKey) delete toggleOverrides[key];       // back under theme control
      else toggleOverrides[key] = !toggles[key];
      resolveToggles();
      (onChange || applyAll)();
      syncPanel();
    });
    syncers.push(sync);
    return btn;
  }

  function makeSlider(label, min, max, step, decimals, get, set, title) {
    const row = el('div', { className: 'row' }); row.style.display = 'block';
    const valueEl = el('span', { className: 'v' }); valueEl.style.cssFloat = 'right';
    const input = el('input', { type: 'range', min, max, step, title: title || '' });
    input.style.width = '100%';
    const show = (v) => { valueEl.textContent = Number(v).toFixed(decimals); };
    input.addEventListener('input', () => { set(Number(input.value)); show(input.value); });
    syncers.push(() => { input.value = String(get()); show(get()); });
    row.append(labelSpan(label), valueEl, input);
    return row;
  }

  // A native <input type="color"> — which IS the OS colour wheel/picker, for zero maintenance.
  // get/set deal in packed 0xRRGGBB ints, like every colour in the theme data.
  function makeColorRow(label, get, set, title) {
    const row = el('div', { className: 'row' });
    const input = el('input', { type: 'color', title: title || '' });
    input.style.cssText = 'flex:1;margin-left:6px;height:22px;padding:0;border:0;background:none;cursor:pointer';
    input.addEventListener('input', () => set(parseInt(input.value.slice(1), 16) >>> 0));
    syncers.push(() => { input.value = `#${((get() >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`; });
    row.append(labelSpan(label), input);
    return row;
  }

  // `heading: false` when the host panel already labels the section it drops these nodes into.
  function buildPanel({ heading = true } = {}) {
    const out = [];
    if (heading) {
      const ttl = el('div', { className: 'ttl', textContent: 'Visuals' });
      ttl.style.marginTop = '10px';
      out.push(ttl);
    }

    // theme picker
    const themeRow = el('div', { className: 'row' });
    const sel = el('select');
    sel.style.cssText = 'flex:1;margin-left:6px';
    for (const k of THEME_KEYS) sel.append(el('option', { value: k, textContent: THEMES[k].label }));
    sel.append(el('option', { value: 'random', textContent: 'Random (seeded)' }));
    sel.addEventListener('change', () => setThemeKey(sel.value));
    syncers.push(() => { sel.value = currentKey; });
    themeRow.append(labelSpan('theme'), sel);
    out.push(themeRow);

    const rollBtn = el('button', { textContent: '🎲 Roll a new look' });
    rollBtn.title = 'Generates a coherent random palette, sky, light rig and post stack from one seed';
    rollBtn.addEventListener('click', rollRandomTheme);
    out.push(rollBtn);

    const resetBtn = el('button', { textContent: 'Reset theme defaults' });
    resetBtn.title = 'Unpins every toggle and returns the master sliders to 1 — the theme drives everything again';
    resetBtn.addEventListener('click', () => {
      master.brightness = 1; master.saturation = 1; master.bloom = 1; master.fogScale = 1; master.neon = 1;
      toggleOverrides = {};
      setThemeKey(currentKey);
    });
    out.push(resetBtn);

    // master look sliders
    out.push(makeSlider('brightness', 0, 3, 0.01, 2,
      () => master.brightness, (v) => { master.brightness = v; applyLights(); applyBots(); }, 'Scales every light in the rig'));
    out.push(makeSlider('saturation', 0, 2, 0.01, 2,
      () => master.saturation, (v) => { master.saturation = v; applyPost(); }, 'Post-grade saturation (not a CSS filter)'));
    out.push(makeSlider('bloom', 0, 3, 0.01, 2,
      () => master.bloom, (v) => { master.bloom = v; applyPost(); }, 'Scales the theme bloom strength'));
    out.push(makeSlider('neon gain', 0, 3, 0.01, 2,
      () => master.neon, (v) => { master.neon = v; applyMaterials(); applyBots(); },
      'Scales every emissive trim/grid/stripe — on the map and on the bots'));
    out.push(makeSlider('fog density', 0, 4, 0.01, 2,
      () => master.fogScale, (v) => { master.fogScale = v; applyFog(); }, 'Scales the theme fog density'));

    // tone mapping
    const toneRow = el('div', { className: 'row' });
    const toneSel = el('select');
    toneSel.style.cssText = 'flex:1;margin-left:6px';
    for (const t of ['agx', 'aces', 'reinhard', 'neutral', 'none']) toneSel.append(el('option', { value: t, textContent: t }));
    toneSel.addEventListener('change', () => { theme.post.tone = toneSel.value; applyPost(); });
    syncers.push(() => { toneSel.value = theme.post.tone; });
    toneRow.append(labelSpan('tone map'), toneSel);
    out.push(toneRow);

    out.push(makeSlider('exposure', 0.2, 2.5, 0.01, 2,
      () => theme.post.exposure, (v) => { theme.post.exposure = v; applyPost(); }));
    out.push(makeSlider('contrast', 0.5, 2, 0.01, 2,
      () => theme.post.grade.contrast, (v) => { theme.post.grade.contrast = v; applyPost(); }));
    out.push(makeSlider('vignette', 0, 1, 0.01, 2,
      () => theme.post.grade.vignette, (v) => { theme.post.grade.vignette = v; applyPost(); }));

    // toggles
    const toggleTtl = el('div', { className: 'ttl', textContent: 'Visual toggles' });
    toggleTtl.style.marginTop = '8px';
    out.push(toggleTtl);
    out.push(makeToggle('Sky dome', 'sky', () => { applySky(); }));
    out.push(makeToggle('Stars', 'stars', () => { applySky(); }));
    out.push(makeToggle('Nebula', 'nebula', () => { applySky(); }));
    out.push(makeToggle('Planet', 'planet', () => { applySky(); }));
    out.push(makeToggle('Sun glow', 'sunGlow', () => { applySky(); }));
    out.push(makeToggle('Fog', 'fog', () => { applyFog(); }));
    out.push(makeToggle('Floor grid', 'grid', () => { applyMaterials(); }));
    out.push(makeToggle('Scan pulse', 'scan', () => { applyMaterials(); }));
    out.push(makeToggle('Neon trim', 'trim', () => { applyMaterials(); }));
    out.push(makeToggle('Trim travel pulse', 'pulse', () => { applyMaterials(); }));
    out.push(makeToggle('Edge rim light', 'rim', () => { applyMaterials(); }));
    out.push(makeToggle('Concrete weathering', 'concrete', () => { applyMaterials(); }));
    // Flora lives outside this module (bot-flora.js owns the meshes), so the toggle just
    // reports the change and the host decides what to rebuild.
    out.push(makeToggle('Flora (grass / plants / vines)', 'flora', () => { onLookChange(); }));
    out.push(makeToggle('Shadows', 'shadows', () => { applyLights(); }));
    out.push(makeToggle('Reflections (IBL)', 'reflections', () => { rebuildEnv(); }));

    // bot lighting
    const botTtl = el('div', { className: 'ttl', textContent: 'Bot lighting' });
    botTtl.style.marginTop = '8px';
    out.push(botTtl);
    out.push(makeToggle('Bot glow (emissive)', 'botGlow', () => { applyBots(); }));
    out.push(makeToggle('Bot edge rim', 'botRim', () => { applyBots(); }));
    out.push(makeToggle('Ground pools', 'groundPools', () => { applyBots(); }));
    out.push(makeToggle('Dynamic lights (flashes)', 'dynamicLights', () => { applyBots(); }));
    out.push(makeToggle('Coloured flashes', 'flashTint', () => { applyBots(); }));

    // Audio reactivity is driven from here but its controls live in the Audio panel section --
    // see setAudioReactive/setAudioDrive on the returned API.
    out.push(makeToggle('Flashlights', 'flashlights', () => { applyBots(); }));

    // The shell parts are where the team colour actually lives in this rig — plate and trim are
    // authored near-black — so shell is the knob that matters and the others are fine tuning.
    out.push(makeSlider('body glow', 0, 4, 0.01, 2,
      () => theme.bots.shellGlow, (v) => { theme.bots.shellGlow = v; applyBots(); },
      'Emission on the bot\'s shell parts, tinted by its own team colour'));
    out.push(makeSlider('plate glow', 0, 2, 0.01, 2,
      () => theme.bots.plateGlow, (v) => { theme.bots.plateGlow = v; applyBots(); }));
    out.push(makeSlider('trim glow', 0, 4, 0.01, 2,
      () => theme.bots.trimGlow, (v) => { theme.bots.trimGlow = v; applyBots(); }));
    out.push(makeSlider('visor glow', 0, 4, 0.01, 2,
      () => theme.bots.eyeGlow, (v) => { theme.bots.eyeGlow = v; applyBots(); }));
    out.push(makeColorRow('visor colour', () => theme.bots.eyeColor,
      (v) => { theme.bots.eyeColor = v; applyBots(); },
      'Independent of the bot rim colour, so a theme can pair (say) an amber rim with a cyan visor'));
    out.push(makeSlider('bot rim gain', 0, 3, 0.01, 2,
      () => theme.bots.rimGain, (v) => { theme.bots.rimGain = v; applyBots(); },
      'Fresnel edge light — separates bots from dark walls when the key light is behind them'));
    out.push(makeSlider('pool gain', 0, 3, 0.01, 2,
      () => theme.bots.poolGain, (v) => { theme.bots.poolGain = v; applyBots(); }));
    out.push(makeSlider('pool radius', 0.2, 2, 0.01, 2,
      () => theme.bots.poolRadius, (v) => { theme.bots.poolRadius = v; }, 'Metres, before the stance widening'));
    out.push(makeSlider('flash intensity', 0, 120, 1, 0,
      () => theme.bots.flashIntensity, (v) => { theme.bots.flashIntensity = v; },
      `Muzzle/blast light strength — ${DYN_LIGHT_COUNT} real lights are shared by the loudest flashes on screen`));
    out.push(makeSlider('flash falloff', 2, 30, 0.5, 1,
      () => theme.bots.flashDistance, (v) => { theme.bots.flashDistance = v; }, 'Point-light distance, in metres'));
    out.push(makeColorRow('flash tint', () => theme.bots.flashTintColor,
      (v) => { theme.bots.flashTintColor = v; },
      'Used by every flash while "Coloured flashes" is on — muzzle and blast alike'));
    out.push(makeSlider('flash hue cycle', 0, 2, 0.01, 2,
      () => theme.bots.flashTintCycle, (v) => { theme.bots.flashTintCycle = v; },
      'Turns per second around the hue wheel. 0 holds the picked colour; each shot samples the wheel when it fires, so a burst comes out as a gradient'));
    out.push(makeSlider('beam gain', 0, 3, 0.01, 2,
      () => theme.bots.beamGain, (v) => { theme.bots.beamGain = v; applyBots(); }, 'Brightness of the fake flashlight cones'));
    out.push(makeSlider('beam length', 2, 25, 0.5, 1,
      () => theme.bots.beamLength, (v) => { theme.bots.beamLength = v; applyBots(); }));
    out.push(makeSlider('beam angle', 4, 40, 0.5, 1,
      () => theme.bots.beamAngle, (v) => { theme.bots.beamAngle = v; applyBots(); }, 'Half-angle in degrees'));

    // sky detail
    const skyTtl = el('div', { className: 'ttl', textContent: 'Sky detail' });
    skyTtl.style.marginTop = '8px';
    out.push(skyTtl);
    out.push(makeSlider('star gain', 0, 3, 0.01, 2,
      () => theme.sky.starGain, (v) => { theme.sky.starGain = v; applySky(); }));
    out.push(makeSlider('star density', 0, 3, 0.01, 2,
      () => theme.sky.starDensity, (v) => { theme.sky.starDensity = v; applySky(); }));
    out.push(makeSlider('stars below horizon', 0, 1, 0.01, 2,
      () => theme.sky.starWrap, (v) => { theme.sky.starWrap = v; applySky(); },
      '1 = the field wraps all the way around (a slab floating in space); 0 = stars stop at the horizon'));
    out.push(makeSlider('nebula gain', 0, 2, 0.01, 2,
      () => theme.sky.nebulaGain, (v) => { theme.sky.nebulaGain = v; applySky(); }));
    out.push(makeSlider('planet size', 0.02, 0.9, 0.01, 2,
      () => theme.sky.planet.size, (v) => { theme.sky.planet.size = v; applySky(); }, 'Angular radius in radians'));
    out.push(makeSlider('planet azimuth', 0, 360, 1, 0,
      () => theme.sky.planet.azimuth, (v) => { theme.sky.planet.azimuth = v; applySky(); }));
    out.push(makeSlider('planet elevation', -10, 80, 1, 0,
      () => theme.sky.planet.elevation, (v) => { theme.sky.planet.elevation = v; applySky(); }));

    syncPanel();
    return out;
  }

  return {
    materials: { floor: floorMat, terrain: terrainMat, wall: wallMat, cover: coverMat },
    groundNodes,
    setWeather, setLightning,
    // soil-shade.js instance behind floor/terrain; live set(), values persist in theme.mats.floor.soil
    soil,
    // Handed to createBodyPartBatches so the instanced bots get the emissive/rim treatment.
    botMaterials,
    flash,
    beginBotFx, addBotFx, endBotFx,
    get theme() { return theme; },
    get themeKey() { return currentKey; },
    get toggles() { return toggles; },
    get pinnedToggles() { return { ...toggleOverrides }; },
    themeKeys: [...THEME_KEYS, 'random'],
    setTheme, setThemeKey, rollRandomTheme,
    // Music-reactive lighting. The controls for these live in the Audio section of
    // bot-viewer-v2.html's panel, not in buildPanel() -- audio reactivity is not a look property.
    // `reactiveTargets` is the routing table itself, so the panel builds its per-group buttons
    // from the same source the update loop reads (labels and hints included).
    reactiveTargets: REACTIVE_TARGETS,
    get audioReactive() { return audioReactive; },
    get audioDrive() { return audioDrive; },
    get audioTargets() { return { ...audioTargets }; },
    setAudioReactive: (v) => { audioReactive = !!v; },
    setAudioDrive: (v) => { if (Number.isFinite(v)) audioDrive = v; },
    setAudioTarget: (key, on) => { if (key in audioTargets) audioTargets[key] = !!on; },
    getLookState, applyLookState,
    setBounds, update, buildPanel,
    refresh: applyAll,
    skyMesh,
  };
}
