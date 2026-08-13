import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const DECODER_PATH = 'https://cdn.jsdelivr.net/npm/three@0.184.0/examples/jsm/libs/draco/gltf/';
let shared = null;

// Weapon GLBs compressed via the weapon-viewer-v2.html Compress panel (glb-shrink-server) carry
// KHR_draco_mesh_compression -- GLTFLoader.parse() throws "No DRACOLoader instance provided" on
// them without this attached, so every loader that might load a weapon model needs it.
export function attachDracoLoader(gltfLoader) {
  if (!shared) {
    shared = new DRACOLoader();
    shared.setDecoderPath(DECODER_PATH);
  }
  gltfLoader.setDRACOLoader(shared);
  return gltfLoader;
}
