// shoot-house.js -- Three.js builder + loadedMap adapter for the procedural CQB kill-house.
// Consumes shoot-house-layout.js's pure descriptor; browser/WebGPU only, no Node test.
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { generateShootHouse } from './shoot-house-layout.js';

const MATERIAL_COLOR = {
  floor: 0x2a2a2c,
  wall: 0x8a8a86,
  trim: 0xa8a8a4,
  stair: 0x6e6e6c,
};

const LIGHT_DEFAULT_COLOR = '#fff2d8';
const LIGHT_DEFAULT_INTENSITY = 16;

export function createShootHouse({ scene, THREE, seed = 1, opts = {} }) {
  const layout = generateShootHouse(seed, opts);
  const { bounds, primitives, lights: lightDefs, spawn } = layout;

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
    const mat = new MeshStandardNodeMaterial({
      color: MATERIAL_COLOR[material] ?? 0x808080,
      roughness: 0.9,
      metalness: 0,
    });
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    root.add(mesh);
    meshes.push(mesh);
    materials.push(mat);
  }

  // interior point lights, shared color/intensity
  let lightColor = LIGHT_DEFAULT_COLOR;
  let lightIntensity = LIGHT_DEFAULT_INTENSITY;
  const pointLights = lightDefs.map((l) => {
    const light = new THREE.PointLight(lightColor, lightIntensity, l.radius * 2);
    light.position.set(l.x, l.y, l.z);
    light.castShadow = false;
    root.add(light);
    return light;
  });

  if (scene) scene.add(root);

  function setLightColor(hex) {
    lightColor = hex;
    for (const l of pointLights) l.color.set(hex);
  }

  function setLightIntensity(v) {
    lightIntensity = v;
    for (const l of pointLights) l.intensity = v;
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
    worldYMin: bounds.yMin,
    worldYMax: bounds.yMax,
    seaLevel: bounds.yMin - 10,
    resolution: Math.max(64, Math.ceil(Math.max(worldX, worldZ))),
    heightAt() { return 0; },
    spawn,
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
