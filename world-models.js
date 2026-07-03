import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const DEG = Math.PI / 180;
const AIM_STEPS = 256;
const AIM_MAX_DIST = 200;

function makeEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text != null) el.textContent = text;
  return el;
}

function fmt(value, digits = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : '--';
}

function fileLabel(file, path) {
  return path || file.webkitRelativePath || file.name;
}

async function collectGlbHandles(directoryHandle, prefix, out) {
  for await (const [name, handle] of directoryHandle.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (handle.kind === 'directory') {
      await collectGlbHandles(handle, path, out);
    } else if (/\.glb$/i.test(name)) {
      const file = await handle.getFile();
      out.push({ file, path });
    }
  }
}

function pickDirectoryFallback() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.glb,model/gltf-binary';
    input.setAttribute('webkitdirectory', '');
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const files = [...input.files]
        .filter(file => /\.glb$/i.test(file.name))
        .map(file => ({ file, path: file.webkitRelativePath || file.name }));
      input.remove();
      resolve(files);
    }, { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

function setPreviewMaterials(root) {
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    const cloneOne = (mat) => {
      const m = mat?.clone ? mat.clone() : new THREE.MeshStandardMaterial({ color: 0x77c8a1 });
      m.transparent = true;
      m.opacity = 0.46;
      m.depthWrite = false;
      return m;
    };
    obj.material = Array.isArray(obj.material) ? obj.material.map(cloneOne) : cloneOne(obj.material);
  });
}

function prepareModelRoot(root, { preview = false } = {}) {
  const model = root.clone(true);
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const wrapper = new THREE.Group();
  wrapper.name = preview ? 'model-placement-preview' : 'placed-glb-model';

  if (!box.isEmpty()) {
    const center = new THREE.Vector3();
    box.getCenter(center);
    model.position.x -= center.x;
    model.position.y -= box.min.y;
    model.position.z -= center.z;
  }

  model.traverse((obj) => {
    if (!obj.isMesh) return;
    obj.castShadow = true;
    obj.receiveShadow = true;
  });
  if (preview) setPreviewMaterials(model);
  wrapper.add(model);
  return wrapper;
}

export function createWorldModelPanel({ scene, camera, terrainHeight, raycastAim, isWalkMode } = {}) {
  const host = document.getElementById('models-section-host');
  if (!host) return null;

  const loader = new GLTFLoader();
  const state = {
    assets: [],
    instances: [],
    selectedAsset: null,
    selectedInstance: null,
    placementArmed: false,
    preview: null,
    previewAsset: null,
    loadingPreview: false,
    instanceSeq: 0,
    transform: {
      scale: 1,
      yaw: 0,
      pitch: 0,
      roll: 0,
      heightOffset: 0,
      snapToGround: true,
    },
  };

  function status(text) {
    statusEl.textContent = text || '';
  }

  function localAim() {
    if (typeof raycastAim === 'function') return raycastAim();
    const dir = new THREE.Vector3();
    camera.getWorldDirection(dir);
    const origin = camera.position;
    for (let i = 1; i <= AIM_STEPS; i++) {
      const t = (i / AIM_STEPS) * AIM_MAX_DIST;
      const x = origin.x + dir.x * t;
      const y = origin.y + dir.y * t;
      const z = origin.z + dir.z * t;
      const groundY = terrainHeight(x, z);
      if (y <= groundY) return { x, y: groundY, z, hit: true };
    }
    return { hit: false };
  }

  function applyTransform(instance) {
    if (!instance) return;
    const tr = instance.transform;
    const y = tr.snapToGround ? terrainHeight(instance.x, instance.z) : instance.y;
    instance.group.position.set(instance.x, y + tr.heightOffset, instance.z);
    instance.group.rotation.set(tr.pitch * DEG, tr.yaw * DEG, tr.roll * DEG);
    instance.group.scale.setScalar(tr.scale);
  }

  function syncTransformFromSelected() {
    if (state.selectedInstance) Object.assign(state.transform, state.selectedInstance.transform);
    refreshTransformControls();
  }

  async function loadAsset(asset) {
    if (asset.gltf) return asset.gltf;
    if (asset.promise) return asset.promise;
    asset.status = 'loading';
    refreshAssets();
    asset.promise = asset.file.arrayBuffer().then(buffer => new Promise((resolve, reject) => {
      loader.parse(buffer, '', resolve, reject);
    })).then((gltf) => {
      asset.gltf = gltf;
      asset.status = 'ready';
      refreshAssets();
      return gltf;
    }).catch((err) => {
      asset.status = 'error';
      asset.error = err?.message || String(err);
      refreshAssets();
      throw err;
    });
    return asset.promise;
  }

  async function ensurePreview() {
    const asset = state.selectedAsset;
    if (!asset || state.loadingPreview) return;
    if (state.preview && state.previewAsset === asset) return;
    clearPreview();
    state.loadingPreview = true;
    try {
      const gltf = await loadAsset(asset);
      state.preview = prepareModelRoot(gltf.scene, { preview: true });
      state.preview.visible = false;
      scene.add(state.preview);
      state.previewAsset = asset;
    } catch (err) {
      status(`Could not load ${asset.name}: ${err?.message || err}`);
    } finally {
      state.loadingPreview = false;
    }
  }

  function clearPreview() {
    if (!state.preview) return;
    scene.remove(state.preview);
    state.preview.traverse((obj) => {
      if (!obj.isMesh) return;
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of materials) mat?.dispose?.();
    });
    state.preview = null;
    state.previewAsset = null;
  }

  function updatePreview() {
    if (!state.placementArmed || !state.selectedAsset) {
      if (state.preview) state.preview.visible = false;
      return;
    }
    void ensurePreview();
    if (!state.preview) return;
    const hit = localAim();
    state.preview.visible = !!hit.hit;
    if (!hit.hit) return;
    const tr = state.transform;
    state.preview.position.set(hit.x, hit.y + tr.heightOffset, hit.z);
    state.preview.rotation.set(tr.pitch * DEG, tr.yaw * DEG, tr.roll * DEG);
    state.preview.scale.setScalar(tr.scale);
  }

  async function placeAtAim() {
    const asset = state.selectedAsset;
    if (!asset) {
      status('Select a GLB first.');
      return false;
    }
    const hit = localAim();
    if (!hit.hit) {
      status('No terrain under aim.');
      return false;
    }
    try {
      const gltf = await loadAsset(asset);
      const group = prepareModelRoot(gltf.scene);
      const transform = { ...state.transform };
      const instance = {
        id: ++state.instanceSeq,
        name: asset.name,
        asset,
        group,
        x: hit.x,
        y: hit.y,
        z: hit.z,
        transform,
      };
      scene.add(group);
      state.instances.push(instance);
      selectInstance(instance);
      applyTransform(instance);
      refreshInstances();
      status(`Placed ${asset.name}.`);
      return true;
    } catch (err) {
      status(`Could not place ${asset.name}: ${err?.message || err}`);
      return false;
    }
  }

  function selectAsset(asset) {
    state.selectedAsset = asset;
    refreshAssets();
    status(asset ? `Selected ${asset.name}.` : '');
    if (state.placementArmed) void ensurePreview();
  }

  function selectInstance(instance) {
    state.selectedInstance = instance;
    syncTransformFromSelected();
    refreshInstances();
  }

  function deleteSelected() {
    const instance = state.selectedInstance;
    if (!instance) return;
    scene.remove(instance.group);
    state.instances = state.instances.filter(item => item !== instance);
    state.selectedInstance = null;
    refreshInstances();
    status(`Deleted ${instance.name}.`);
  }

  async function connectModels() {
    try {
      status('Opening folder picker...');
      let files = [];
      if ('showDirectoryPicker' in window) {
        const dir = await window.showDirectoryPicker({ mode: 'read' });
        await collectGlbHandles(dir, '', files);
      } else {
        files = await pickDirectoryFallback();
      }
      state.assets = files
        .sort((a, b) => fileLabel(a.file, a.path).localeCompare(fileLabel(b.file, b.path)))
        .map((entry, index) => ({
          id: index + 1,
          file: entry.file,
          path: entry.path,
          name: entry.file.name.replace(/\.glb$/i, ''),
          status: 'idle',
          gltf: null,
          promise: null,
        }));
      state.selectedAsset = state.assets[0] || null;
      clearPreview();
      refreshAssets();
      status(state.assets.length ? `${state.assets.length} GLB file(s) connected.` : 'No GLB files found in that folder.');
      if (state.placementArmed && state.selectedAsset) void ensurePreview();
    } catch (err) {
      if (err?.name === 'AbortError') status('Folder selection cancelled.');
      else status(`Folder selection failed: ${err?.message || err}`);
    }
  }

  function setPlacementArmed(armed) {
    state.placementArmed = armed;
    aimBtn.textContent = armed ? 'Stop Aiming' : 'Aim Place';
    aimBtn.classList.toggle('primary', armed);
    if (armed) {
      status(typeof isWalkMode === 'function' && !isWalkMode() ? 'Aim preview follows the camera. Press F for crosshair placement.' : 'Left-click places the selected model.');
      void ensurePreview();
    } else {
      if (state.preview) state.preview.visible = false;
    }
  }

  function refreshAssets() {
    assetList.innerHTML = '';
    if (!state.assets.length) {
      assetList.appendChild(makeEl('div', 'wui-empty', 'Connect a folder containing .glb files.'));
      return;
    }
    for (const asset of state.assets) {
      const row = makeEl('button', 'wui-list-item');
      row.type = 'button';
      row.classList.toggle('active', asset === state.selectedAsset);
      row.innerHTML = `<strong></strong><small></small>`;
      row.querySelector('strong').textContent = asset.name;
      row.querySelector('small').textContent = `${asset.status} - ${fileLabel(asset.file, asset.path)}`;
      row.addEventListener('click', () => selectAsset(asset));
      assetList.appendChild(row);
    }
  }

  function refreshInstances() {
    instanceList.innerHTML = '';
    if (!state.instances.length) {
      instanceList.appendChild(makeEl('div', 'wui-empty', 'Placed models will appear here.'));
      deleteBtn.disabled = true;
      return;
    }
    deleteBtn.disabled = !state.selectedInstance;
    for (const instance of state.instances) {
      const row = makeEl('button', 'wui-list-item');
      row.type = 'button';
      row.classList.toggle('active', instance === state.selectedInstance);
      row.innerHTML = `<strong></strong><small></small>`;
      row.querySelector('strong').textContent = `${instance.id}. ${instance.name}`;
      row.querySelector('small').textContent = `x ${fmt(instance.x, 1)}, y ${fmt(instance.group.position.y, 1)}, z ${fmt(instance.z, 1)}`;
      row.addEventListener('click', () => selectInstance(instance));
      instanceList.appendChild(row);
    }
  }

  const shell = makeEl('div');
  const library = makeEl('div', 'wui-card');
  library.appendChild(makeEl('div', 'wui-card-title', 'Model library'));
  const libraryBody = makeEl('div', 'wui-card-body');
  const actions = makeEl('div', 'wui-actions');
  const connectBtn = makeEl('button', 'wui-btn primary', 'Connect Models');
  connectBtn.type = 'button';
  const aimBtn = makeEl('button', 'wui-btn', 'Aim Place');
  aimBtn.type = 'button';
  actions.append(connectBtn, aimBtn);
  const assetList = makeEl('div', 'wui-list');
  libraryBody.append(actions, assetList);
  library.appendChild(libraryBody);

  const transform = makeEl('div', 'wui-card');
  transform.appendChild(makeEl('div', 'wui-card-title', 'Placement transform'));
  const transformBody = makeEl('div', 'wui-card-body');
  const controlRefreshers = [];
  function addSlider(label, key, min, max, step, digits = 2) {
    const row = makeEl('label', 'wui-field');
    const name = makeEl('span', '', label);
    const out = makeEl('output');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min;
    input.max = max;
    input.step = step;
    row.append(name, out, input);
    input.addEventListener('input', () => {
      state.transform[key] = parseFloat(input.value);
      if (state.selectedInstance) {
        state.selectedInstance.transform[key] = state.transform[key];
        applyTransform(state.selectedInstance);
        refreshInstances();
      }
      refreshTransformControls();
    });
    controlRefreshers.push(() => {
      input.value = state.transform[key];
      out.textContent = fmt(state.transform[key], digits);
    });
    transformBody.appendChild(row);
  }
  function refreshTransformControls() {
    for (const refresh of controlRefreshers) refresh();
    snapInput.checked = state.transform.snapToGround;
  }
  addSlider('Scale', 'scale', 0.05, 20, 0.05, 2);
  addSlider('Yaw', 'yaw', -180, 180, 1, 0);
  addSlider('Pitch', 'pitch', -180, 180, 1, 0);
  addSlider('Roll', 'roll', -180, 180, 1, 0);
  addSlider('Height', 'heightOffset', -20, 20, 0.1, 1);
  const snapRow = makeEl('label', 'wui-check');
  snapRow.appendChild(makeEl('span', '', 'Snap to ground'));
  const snapInput = document.createElement('input');
  snapInput.type = 'checkbox';
  snapInput.addEventListener('change', () => {
    state.transform.snapToGround = snapInput.checked;
    if (state.selectedInstance) {
      state.selectedInstance.transform.snapToGround = snapInput.checked;
      applyTransform(state.selectedInstance);
      refreshInstances();
    }
  });
  snapRow.appendChild(snapInput);
  transformBody.appendChild(snapRow);
  transform.appendChild(transformBody);

  const placed = makeEl('div', 'wui-card');
  placed.appendChild(makeEl('div', 'wui-card-title', 'Placed models'));
  const placedBody = makeEl('div', 'wui-card-body');
  const placedActions = makeEl('div', 'wui-actions');
  const placeBtn = makeEl('button', 'wui-btn primary', 'Place at Aim');
  placeBtn.type = 'button';
  const deleteBtn = makeEl('button', 'wui-btn warn', 'Delete Selected');
  deleteBtn.type = 'button';
  placedActions.append(placeBtn, deleteBtn);
  const instanceList = makeEl('div', 'wui-list');
  const statusEl = makeEl('div', 'wui-status');
  placedBody.append(placedActions, instanceList, statusEl);
  placed.appendChild(placedBody);

  shell.append(library, transform, placed);
  host.appendChild(shell);

  connectBtn.addEventListener('click', connectModels);
  aimBtn.addEventListener('click', () => setPlacementArmed(!state.placementArmed));
  placeBtn.addEventListener('click', () => { void placeAtAim(); });
  deleteBtn.addEventListener('click', deleteSelected);

  refreshAssets();
  refreshInstances();
  refreshTransformControls();

  return {
    update: updatePreview,
    handlePrimaryDown() {
      if (!state.placementArmed || !state.selectedAsset) return false;
      void placeAtAim();
      return true;
    },
    dispose() {
      clearPreview();
      for (const instance of state.instances) scene.remove(instance.group);
      host.textContent = '';
    },
  };
}