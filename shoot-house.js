// shoot-house.js -- Three.js builder + loadedMap adapter for the procedural CQB kill-house.
// Consumes shoot-house-layout.js's pure descriptor; browser/WebGPU only, no Node test.
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { generateShootHouse, generateDemoRoom, generateRoomGallery } from './shoot-house-layout.js';
import { MATERIALS, DEFAULT_MATERIAL } from './shoot-house-style.js';
import { toShootHouseLayout, validateLayout } from './layout-interchange.js';

const LIGHT_DEFAULT_COLOR = '#fff2d8';
const LIGHT_DEFAULT_INTENSITY = 16;

// type: 'demo' (internetcore reference room) | 'rooms' (phase-3 archetype gallery) |
//       'house' (legacy v2 procedural kill-house).
// `interchange` (or opts.layout) -- a pcw-layout document (layout-interchange.js) -- overrides
// `type` entirely: a bot-viewer-authored world builds through this same mesh + adapter path.
export function createShootHouse({ scene, THREE, seed = 1, type = 'house', opts = {}, interchange = null }) {
  const doc = interchange || opts.layout || null;
  if (doc) {
    const check = validateLayout(doc);
    if (!check.ok) throw new Error(`invalid pcw-layout: ${check.errors.join('; ')}`);
    for (const w of check.warnings) console.warn(`[shoot-house] layout warning: ${w}`);
  }
  const layout = doc ? toShootHouseLayout(doc)
    : type === 'demo' ? generateDemoRoom(opts)
    : type === 'rooms' ? generateRoomGallery({ ...opts, seed })
    : generateShootHouse(seed, opts);
  const { bounds, primitives, lights: lightDefs, spawn, spawns = null } = layout;

  const root = new THREE.Group();
  root.name = 'shoot-house';

  // bucket + merge boxes by material -> one draw call per bucket
  const buckets = new Map();
  for (const p of primitives) {
    const geo = new THREE.BoxGeometry(p.sx, p.sy, p.sz);
    geo.translate(p.cx, p.cy, p.cz);
    if (!buckets.has(p.material)) buckets.set(p.material, []);
    buckets.get(p.material).push(geo);
  }

  const meshes = [];
  const materials = [];
  for (const [material, geos] of buckets) {
    const merged = mergeGeometries(geos, false);
    for (const g of geos) g.dispose();
    if (!merged) continue;
    const spec = MATERIALS[material] ?? DEFAULT_MATERIAL;
    const mat = new MeshStandardNodeMaterial({
      color: spec.color,
      roughness: spec.roughness,
      metalness: spec.metalness,
    });
    if (spec.em) { mat.emissive.set(spec.color); mat.emissiveIntensity = spec.emissiveIntensity ?? 2.2; }
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    root.add(mesh);
    meshes.push(mesh);
    materials.push(mat);
  }

  // interior point lights. Each may carry a per-light `color` (room tint) and `intensity` multiplier
  // (dim/dark rooms). The global panel color only overrides lights with no explicit color; the global
  // intensity slider scales every light by its own multiplier.
  let lightColor = LIGHT_DEFAULT_COLOR;
  let lightIntensity = LIGHT_DEFAULT_INTENSITY;
  const pointLights = lightDefs.map((l) => {
    const baseColor = l.color ?? null;
    const mult = l.intensity ?? 1;
    const light = new THREE.PointLight(baseColor ?? lightColor, lightIntensity * mult, l.radius * 2);
    light.position.set(l.x, l.y, l.z);
    light.castShadow = false;
    light.userData.baseColor = baseColor;
    light.userData.mult = mult;
    root.add(light);
    return light;
  });

  if (scene) scene.add(root);

  function setLightColor(hex) {
    lightColor = hex;
    for (const l of pointLights) if (!l.userData.baseColor) l.color.set(hex);
  }

  function setLightIntensity(v) {
    lightIntensity = v;
    for (const l of pointLights) l.intensity = v * l.userData.mult;
  }

  let panel = null;
  if (typeof document !== 'undefined') panel = buildPanel(lightColor, lightIntensity, setLightColor, setLightIntensity);

  const worldX = bounds.maxX - bounds.minX;
  const worldZ = bounds.maxZ - bounds.minZ;

  function dispose() {
    root.removeFromParent();
    for (const m of meshes) m.geometry.dispose();
    for (const m of materials) m.dispose();
    for (const l of pointLights) l.removeFromParent();
    panel?.remove();
    panel = null;
  }

  return {
    kind: 'shoot-house',
    root,
    worldX,
    worldZ,
    // Absolute footprint (unlike worldX/worldZ, which are just widths) -- used to bake the
    // combat-bot nav grid over the real floor area (see environment-viewer.html's bot wiring).
    bounds: { minX: bounds.minX, maxX: bounds.maxX, minZ: bounds.minZ, maxZ: bounds.maxZ },
    // Raw generator boxes ({kind,cx,cy,cz,sx,sy,sz,material}), kind tags intact -- the bot
    // visibility/corner bakes need the AABB rect list the merged meshes throw away.
    primitives,
    worldYMin: bounds.yMin,
    worldYMax: bounds.yMax,
    seaLevel: bounds.yMin - 10,
    resolution: Math.max(64, Math.ceil(Math.max(worldX, worldZ))),
    heightAt() { return 0; },
    spawn,
    // Full authored spawn list (roles: player/bot/dummy/patrol) when the map came from a
    // pcw-layout document; null for the generators, which only author one player spawn.
    spawns,
    setLightColor,
    setLightIntensity,
    dispose,
    makeChunks: () => [],
    makeAllChunks: () => [],
    grassDensityAt: () => 0,
    treeDensityAt: () => 0,
    biomeAt: () => 'meadow',
    surfaceField: () => ({ materialColor: [0.3, 0.3, 0.32], materialWeights: null, moisture: 0, upness: 1, density: 0 }),
    grassDensityGrid: undefined,
  };
}

// ─── control panel ──────────────────────────────────────────────────────────

function buildPanel(color, intensity, setColor, setIntensity) {
  const panel = document.createElement('div');
  panel.style.cssText = `
    position:fixed; bottom:16px; right:16px; z-index:9999;
    font:12px/1.4 system-ui,sans-serif; color:#ddd;
    background:rgba(10,10,10,0.82); border-radius:8px;
    padding:8px 12px; display:flex; align-items:center; gap:8px;
    backdrop-filter:blur(8px);
  `;

  const label = document.createElement('span');
  label.textContent = 'Lights';
  label.style.cssText = 'opacity:.6;';

  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = color;
  colorInput.style.cssText = 'width:28px; height:20px; border:none; background:none; cursor:pointer; padding:0;';
  colorInput.addEventListener('input', () => setColor(colorInput.value));

  const rangeInput = document.createElement('input');
  rangeInput.type = 'range';
  rangeInput.min = 0; rangeInput.max = 40; rangeInput.step = 0.5;
  rangeInput.value = intensity;
  rangeInput.style.cssText = 'width:90px; accent-color:#7ec8e3; cursor:pointer;';
  rangeInput.addEventListener('input', () => setIntensity(parseFloat(rangeInput.value)));

  panel.append(label, colorInput, rangeInput);
  document.body.append(panel);
  return panel;
}
