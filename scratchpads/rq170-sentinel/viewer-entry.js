// Viewer entry, bundled by build.sh into viewer.js so the page and the factory share one copy of three.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createRQ170SentinelModel } from './src/createRq170Model.ts';

const view = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9a9082);
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 500);
const controls = new OrbitControls(camera, renderer.domElement);
scene.add(new THREE.HemisphereLight(0xdce4ee, 0x8c8478, 0.9));
const key = new THREE.DirectionalLight(0xfff6e8, 2.2); key.position.set(-6, 14, -5); scene.add(key);
const rim = new THREE.DirectionalLight(0xffffff, 0.6); rim.position.set(8, 4, 10); scene.add(rim);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.MeshStandardMaterial({ color: 0x8f8677, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = -1.86; scene.add(ground);

const model = createRQ170SentinelModel({});
scene.add(model);
const gearParts = []; model.traverse((o) => { if (/gear|wheel|bogie|door/i.test(o.name)) gearParts.push(o); });
document.getElementById('status').textContent = 'ready';

const PRESETS = {
  'three-quarter': [14, 9, -16], top: [0, 40, 0.01], front: [0, 1.5, -34], side: [-34, 1.2, 0], underside: [10, -9, -14],
};
function setPreset(name) {
  camera.position.set(...PRESETS[name]);
  controls.target.set(0, -0.5, 0);
  controls.update();
}
document.getElementById('preset').addEventListener('change', (e) => setPreset(e.target.value));
let wire = false;
document.getElementById('wire').addEventListener('click', () => {
  wire = !wire; model.traverse((o) => { if (o.isMesh) o.material.wireframe = wire; });
});
let gearOn = true;
document.getElementById('gear').addEventListener('click', (e) => {
  gearOn = !gearOn; for (const g of gearParts) g.visible = gearOn; e.target.textContent = gearOn ? 'hide gear' : 'show gear';
});
document.getElementById('shot').addEventListener('click', async () => {
  renderer.render(scene, camera);
  const png = renderer.domElement.toDataURL('image/png');
  const name = document.getElementById('preset').value;
  const r = await fetch('/shot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, png }) });
  document.getElementById('status').textContent = 'saved ' + (await r.json()).saved;
});
function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize(); setPreset('three-quarter');
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
