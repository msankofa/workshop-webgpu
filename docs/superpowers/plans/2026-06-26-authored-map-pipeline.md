# Authored Map Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire terrain-v3's export pipeline into the workshop-webgpu game so a designer can paint a map in the browser, export it, and play it with biome-correct grass and trees - with a start screen to choose between authored maps and the infinite procedural world.

**Architecture:** terrain-v3 exports three files per map (`<name>.glb` visual mesh, `<name>-data.json` heightmap + biome grid + grass density, `<name>-forest.glb` tree instances). The game detects a `?map=` URL param at startup, shows a start screen when absent, and swaps in a static-mesh terrain + biome-density grass texture + prebuilt forest GLB when a map is loaded.

**Tech Stack:** Python/Flask/trimesh/numpy (terrain-v3), Three.js 0.184.0 WebGPU / TSL (game), GLTFLoader, DataTexture.

**Repos:**
- terrain-v3: `G:\My Drive\Scripts\html game\html-game-v2\tools\terrain-v3\`
- game: `G:\My Drive\Scripts\procedural-creature\workshop-webgpu\`

---

## File Map

### terrain-v3 (new / modified)
| File | Change |
|------|--------|
| `terrain_v3/export/forest_export.py` | **new** - v3-biome-aware forest placement -> trimesh scene -> GLB bytes |
| `terrain_v3/export/map_bundle.py` | **modify** - also write `<name>-data.json` alongside the GLB |
| `server.py` | **modify** - `/v3/export/map` passes biome data; new `/v3/export/forest` endpoint |
| `tests/test_terrain_v3.py` | **modify** - add tests for forest_export and map_data |

### workshop-webgpu (new / modified)
| File | Change |
|------|--------|
| `terrain-loader.js` | **new** - loads GLB mesh + map-data.json; exposes `heightAt`, `biomeAt`, `grassDensityAt` |
| `start-screen.js` | **new** - map selection UI rendered before game init |
| `environment-viewer.html` | **modify** - startup mode dispatch; load terrain-loader in map mode; biome grass texture; skip/load forest per mode |
| `grass-compute.js` | **modify** - optional `biomeDensityTex` param; samples texture in cull shader to gate blades by biome |

---

## Phase 1 - terrain-v3: map-data bundle

### Task 1: Write map-data.json alongside terrain GLB

**Files:**
- Modify: `terrain_v3/export/map_bundle.py`
- Modify: `server.py` (export/map endpoint)
- Test: `tests/test_terrain_v3.py`

- [ ] **Step 1: Write the failing test**

Add to `tests/test_terrain_v3.py`:

```python
import json
import tempfile
from pathlib import Path
from terrain_v3.export import map_bundle

def test_write_saves_map_data_json():
    glb = b"GLBFAKE"
    biome_ids = [0, 1, 2, 3]
    biome_names = ["deep_ocean", "ocean", "beach", "plains"]
    grass_density = [0.0, 0.0, 0.15, 0.7]
    map_data = {
        "worldX": 100.0, "worldZ": 100.0, "seaLevel": 0.0,
        "resolution": 2,
        "biomeNames": biome_names,
        "biomeIds": biome_ids,
        "grassDensity": grass_density,
    }
    with tempfile.TemporaryDirectory() as tmpdir:
        key = map_bundle.write("test_folder", "test_map", glb, maps_dir=tmpdir, map_data=map_data)
        data_path = Path(tmpdir) / "test_folder" / "test_map-data.json"
        assert data_path.exists(), "map-data.json was not written"
        loaded = json.loads(data_path.read_text())
        assert loaded["resolution"] == 2
        assert loaded["biomeNames"] == biome_names
        assert loaded["biomeIds"] == biome_ids
        assert loaded["grassDensity"] == grass_density
        assert loaded["worldX"] == 100.0
```

- [ ] **Step 2: Run to confirm it fails**

```
cd "G:\My Drive\Scripts\html game\html-game-v2\tools\terrain-v3"
python -m pytest tests/test_terrain_v3.py::test_write_saves_map_data_json -v
```

Expected: `FAILED` - `write()` doesn't accept `map_data` yet.

- [ ] **Step 3: Implement - modify `map_bundle.write()`**

In `terrain_v3/export/map_bundle.py`, change the `write` signature and add the JSON write:

```python
def write(folder, name, glb_bytes, maps_dir=None, map_data=None):
    """Write <folder>/<name>.glb under models/maps, update map-config.json,
    and optionally write <folder>/<name>-data.json if map_data is provided."""
    maps_dir = Path(maps_dir) if maps_dir else REPO_ROOT / "models" / "maps"
    folder_path = _safe_under_maps(maps_dir, folder)
    if not _SAFE_SEGMENT.match(name):
        raise ValueError(f"unsafe name: {name!r}")

    folder_path.mkdir(parents=True, exist_ok=True)
    (folder_path / f"{name}.glb").write_bytes(bytes(glb_bytes))
    map_key = f"{folder}/{name}.glb"

    config_path = maps_dir / "map-config.json"
    if config_path.exists():
        cfg = json.loads(config_path.read_text(encoding="utf-8"))
    else:
        cfg = {}
    if not isinstance(cfg, dict):
        cfg = {}
    maps = cfg.setdefault("maps", {})
    if not isinstance(maps, dict):
        cfg["maps"] = maps = {}
    if map_key not in maps:
        display = name.replace("_", " ").replace("-", " ").strip().title()
        maps[map_key] = {
            "displayName": display,
            "gameName": display,
            "image": "",
            "playable": True,
            "mapScale": 1,
            "snapStep": 0.5,
        }
    _atomic_write_json(config_path, cfg)

    if map_data is not None:
        _atomic_write_json(folder_path / f"{name}-data.json", map_data)

    return map_key
```

- [ ] **Step 4: Run test to confirm it passes**

```
python -m pytest tests/test_terrain_v3.py::test_write_saves_map_data_json -v
```

Expected: `PASSED`

- [ ] **Step 5: Build biome -> grass density table and wire into `/v3/export/map`**

Create `terrain_v3/export/biome_density.py`:

```python
from __future__ import annotations
import numpy as np
from ..stages.biome_classifier import BIOME_INDEX

# Grass blade density per biome: 0.0 = no grass, 1.0 = full density.
GRASS_DENSITY: dict[str, float] = {
    "deep_ocean":      0.0,
    "ocean":           0.0,
    "beach":           0.15,
    "desert":          0.0,
    "badlands":        0.05,
    "savanna":         0.45,
    "plains":          0.75,
    "forest":          0.85,
    "dark_forest":     0.90,
    "jungle":          0.95,
    "swamp":           0.60,
    "taiga":           0.40,
    "snowy_taiga":     0.20,
    "snowy_plains":    0.10,
    "stony_peaks":     0.05,
    "snowy_peaks":     0.0,
    "windswept_hills": 0.20,
    "meadow":          0.80,
}

_DENSITY_LUT = np.array(
    [GRASS_DENSITY.get(name, 0.0) for name in sorted(BIOME_INDEX, key=BIOME_INDEX.get)],
    dtype=np.float32,
)


def grass_density_for_ids(biome_ids: np.ndarray) -> np.ndarray:
    """Map a (res, res) uint8 biome_id grid to a float32 grass density grid."""
    ids = np.asarray(biome_ids, dtype=np.uint8)
    return _DENSITY_LUT[ids]
```

Then in `server.py`, modify `export_map()` to build and pass `map_data`:

```python
from terrain_v3.export.biome_density import grass_density_for_ids
from terrain_v3.stages.biome_classifier import BIOMES

# Inside export_map(), after hf = compute_heightfield(...):
biome_ids_flat = hf["biome"]["biome_ids"].ravel().tolist()
grass_density = grass_density_for_ids(hf["biome"]["biome_ids"]).ravel().tolist()
map_data = {
    "worldX": hf["world_x"],
    "worldZ": hf["world_z"],
    "seaLevel": hf["sea_level"],
    "resolution": hf["res"],
    "heightMin": float(np.min(hf["height"])),
    "heightMax": float(np.max(hf["height"])),
    "biomeNames": list(BIOMES),
    "biomeIds": [int(v) for v in biome_ids_flat],
    "grassDensity": [round(float(v), 4) for v in grass_density],
}
map_key = map_bundle.write(folder, name, glb, map_data=map_data)
```

- [ ] **Step 6: Write test for grass_density_for_ids**

```python
from terrain_v3.export.biome_density import grass_density_for_ids
from terrain_v3.stages.biome_classifier import BIOME_INDEX
import numpy as np

def test_grass_density_for_ids_shape_and_range():
    ids = np.array([[BIOME_INDEX["plains"], BIOME_INDEX["deep_ocean"]],
                    [BIOME_INDEX["forest"], BIOME_INDEX["ocean"]]], dtype=np.uint8)
    density = grass_density_for_ids(ids)
    assert density.shape == (2, 2)
    assert density[0, 0] == 0.75   # plains
    assert density[0, 1] == 0.0    # deep_ocean
    assert density[1, 0] == 0.85   # forest
    assert density[1, 1] == 0.0    # ocean
```

Run: `python -m pytest tests/test_terrain_v3.py::test_grass_density_for_ids_shape_and_range -v`
Expected: `PASSED`

- [ ] **Step 7: Commit**

```bash
git add terrain_v3/export/biome_density.py terrain_v3/export/map_bundle.py server.py tests/test_terrain_v3.py
git commit -m "feat: write map-data.json (biome grid + grass density) alongside terrain GLB export"
```

---

### Task 2: Forest export endpoint

**Files:**
- Create: `terrain_v3/export/forest_export.py`
- Modify: `server.py`
- Test: `tests/test_terrain_v3.py`

The forest export reuses v3's biome_ids grid directly instead of re-running v1's noise fields. It calls v1's tree placement logic (copy the relevant functions locally to avoid a cross-repo import).

- [ ] **Step 1: Write failing test**

```python
def test_build_forest_glb_returns_bytes():
    import numpy as np
    from terrain_v3.export.forest_export import build_forest_glb
    from terrain_v3.stages.biome_classifier import BIOMES, BIOME_INDEX

    res = 16
    rng = np.random.default_rng(42)
    biome_ids = rng.integers(0, len(BIOMES), size=(res, res), dtype=np.uint8)
    height = rng.uniform(-5.0, 20.0, size=(res, res)).astype(np.float32)

    glb = build_forest_glb(
        biome_ids=biome_ids,
        height=height,
        world_x=200.0,
        world_z=200.0,
        sea_level=0.0,
        seed=42,
    )
    assert isinstance(glb, bytes)
    assert len(glb) > 0
    # GLB magic: first 4 bytes are b'glTF'
    assert glb[:4] == b"glTF"
```

Run: `python -m pytest tests/test_terrain_v3.py::test_build_forest_glb_returns_bytes -v`
Expected: `FAILED` - `forest_export` module doesn't exist yet.

- [ ] **Step 2: Create `terrain_v3/export/forest_export.py`**

```python
"""
Forest export: places trees on a v3 heightfield using v3 biome_ids,
mirroring v1's generate_forest placement logic without depending on v1's
noise fields (we already have the biome grid from v3's pipeline).
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

import numpy as np
import trimesh

from ..stages.biome_classifier import BIOMES, BIOME_INDEX

# v1 tree generators live in the sibling 'terrain' tool.
_V1_DIR = Path(__file__).resolve().parents[4] / "terrain"
if str(_V1_DIR) not in sys.path:
    sys.path.insert(0, str(_V1_DIR))

import generate_tree as gtree
import tree_presets


# ---------------------------------------------------------------------------
# Biome -> placement density (trees per world-unit^2)
# ---------------------------------------------------------------------------
TREE_DENSITY: dict[str, float] = {
    "forest":           0.012,
    "dark_forest":      0.016,
    "jungle":           0.014,
    "taiga":            0.010,
    "snowy_taiga":      0.008,
    "savanna":          0.006,
    "plains":           0.003,
    "meadow":           0.004,
    "windswept_hills":  0.005,
    "swamp":            0.005,
    "badlands":         0.002,
}


def _cell_hash(ix: np.ndarray, iz: np.ndarray, seed: int) -> np.ndarray:
    h = (ix.astype(np.uint64) * np.uint64(0x9E3779B97F4A7C15)
         + iz.astype(np.uint64) * np.uint64(0xBF58476D1CE4E5B9)
         + np.uint64(seed))
    h ^= h >> np.uint64(30)
    h = (h * np.uint64(0xBF58476D1CE4E5B9)) & np.uint64(0xFFFFFFFFFFFFFFFF)
    h ^= h >> np.uint64(27)
    h = (h * np.uint64(0x94D049BB133111EB)) & np.uint64(0xFFFFFFFFFFFFFFFF)
    h ^= h >> np.uint64(31)
    return (h & np.uint64(0xFFFFFFFFFFFFFFFF)).astype(np.float64) / float(2 ** 64)


def _sample_biome(biome_ids: np.ndarray, world_x: float, world_z: float,
                  xz: np.ndarray) -> np.ndarray:
    """Nearest-neighbour biome sample at (N, 2) world XZ points."""
    res_z, res_x = biome_ids.shape
    ix = np.clip(np.round((xz[:, 0] / world_x + 0.5) * (res_x - 1)).astype(int), 0, res_x - 1)
    iz = np.clip(np.round((xz[:, 1] / world_z + 0.5) * (res_z - 1)).astype(int), 0, res_z - 1)
    return biome_ids[iz, ix]


def _sample_height(height: np.ndarray, world_x: float, world_z: float,
                   xz: np.ndarray) -> np.ndarray:
    """Bilinear height sample at (N, 2) world XZ points."""
    res_z, res_x = height.shape
    fx = (xz[:, 0] / world_x + 0.5) * (res_x - 1)
    fz = (xz[:, 1] / world_z + 0.5) * (res_z - 1)
    x0 = np.clip(np.floor(fx).astype(int), 0, res_x - 2)
    z0 = np.clip(np.floor(fz).astype(int), 0, res_z - 2)
    tx = np.clip(fx - x0, 0.0, 1.0)
    tz = np.clip(fz - z0, 0.0, 1.0)
    return (height[z0, x0] * (1 - tx) * (1 - tz)
          + height[z0, x0 + 1] * tx * (1 - tz)
          + height[z0 + 1, x0] * (1 - tx) * tz
          + height[z0 + 1, x0 + 1] * tx * tz)


def _build_tree_library(species_set, variants_per_species: int, base_seed: int) -> dict:
    lib = {}
    for sp in species_set:
        variants = []
        for i in range(variants_per_species):
            cfg = sp(seed=base_seed + i * 97)
            scene, _ = gtree._run(cfg, save_frames=False, frames_dir=None, progress_cb=None)
            all_v, all_f, all_c = [], [], []
            offset = 0
            for g in scene.geometry.values():
                v = g.vertices.copy().astype(np.float32)
                f = g.faces.copy().astype(np.uint32)
                if g.visual.kind == "vertex":
                    c = g.visual.vertex_colors.copy().astype(np.uint8)
                else:
                    c = np.tile(np.array([160, 160, 160, 255], dtype=np.uint8), (v.shape[0], 1))
                all_v.append(v); all_f.append(f + offset); all_c.append(c)
                offset += v.shape[0]
            if all_v:
                variants.append((np.vstack(all_v), np.vstack(all_f), np.vstack(all_c)))
        lib[sp] = variants
    return lib


def build_forest_glb(
    biome_ids: np.ndarray,
    height: np.ndarray,
    world_x: float,
    world_z: float,
    sea_level: float = 0.0,
    seed: int = 42,
    grid_spacing: float = 14.0,
    variants_per_species: int = 3,
    max_trees: int = 2000,
    sink_depth: float = 0.3,
) -> bytes:
    """Return forest GLB bytes placed on the v3 heightfield using v3 biome data."""
    rng = np.random.default_rng(seed)

    # 1. Build placement grid
    nx = max(1, int(world_x / grid_spacing))
    nz = max(1, int(world_z / grid_spacing))
    ix_g, iz_g = np.meshgrid(np.arange(nx), np.arange(nz), indexing="xy")
    ix_g = ix_g.ravel(); iz_g = iz_g.ravel()
    jitter_x = (_cell_hash(ix_g, iz_g, seed + 1) - 0.5) * grid_spacing
    jitter_z = (_cell_hash(ix_g, iz_g, seed + 2) - 0.5) * grid_spacing
    cx = (ix_g + 0.5) * grid_spacing - world_x / 2.0 + jitter_x
    cz = (iz_g + 0.5) * grid_spacing - world_z / 2.0 + jitter_z
    candidates = np.column_stack([cx, cz])

    # 2. Sample biome and height at each candidate
    sampled_ids = _sample_biome(biome_ids, world_x, world_z, candidates)
    sampled_biomes = np.array([BIOMES[i] for i in sampled_ids], dtype=object)
    sampled_heights = _sample_height(height, world_x, world_z, candidates)

    # 3. Accept/reject by biome density + above sea level
    accept_roll = _cell_hash(ix_g, iz_g, seed + 3)
    densities = np.array([TREE_DENSITY.get(b, 0.0) * grid_spacing ** 2 for b in sampled_biomes])
    accept = (accept_roll < densities) & (sampled_heights > sea_level + 0.5)

    # Cap total trees
    n_accepted = int(accept.sum())
    if n_accepted > max_trees:
        keep_roll = _cell_hash(ix_g, iz_g, seed + 4)
        order = np.argsort(np.where(accept, keep_roll, np.inf))
        new_accept = np.zeros_like(accept)
        new_accept[order[:max_trees]] = True
        accept = new_accept

    # 4. Pre-pick species for each accepted cell
    pre_species: dict[int, object] = {}
    needed: set = set()
    for i in np.where(accept)[0]:
        biome_name = sampled_biomes[i]
        sp_list = tree_presets.BIOME_SPECIES.get(biome_name)
        if not sp_list:
            accept[i] = False
            continue
        cell_rng = np.random.default_rng(
            int(ix_g[i]) * 73856093 ^ int(iz_g[i]) * 19349663 ^ seed
        )
        weights = np.array([w for _, w in sp_list])
        weights /= weights.sum()
        sp = sp_list[cell_rng.choice(len(sp_list), p=weights)][0]
        pre_species[i] = sp
        needed.add(sp)

    if not needed:
        # No trees placed - return minimal valid empty GLB
        empty = trimesh.Scene()
        buf = io.BytesIO(); empty.export(file_obj=buf, file_type="glb")
        return buf.getvalue()

    library = _build_tree_library(needed, variants_per_species, seed)

    # 5. Instance trees
    by_species: dict[str, dict] = {}
    for i in np.where(accept)[0]:
        sp = pre_species.get(i)
        if sp is None:
            continue
        post_rng = np.random.default_rng(
            (int(ix_g[i]) * 73856093 ^ int(iz_g[i]) * 19349663 ^ seed) + 0xA5A5A5A5
        )
        variants = library[sp]
        if not variants:
            continue
        v, f, c = variants[post_rng.integers(0, len(variants))]
        scale = post_rng.uniform(0.8, 1.2)
        yaw = post_rng.uniform(0.0, 2 * np.pi)
        cos_a, sin_a = np.cos(yaw), np.sin(yaw)
        R = np.array([[cos_a, 0.0, sin_a], [0.0, 1.0, 0.0], [-sin_a, 0.0, cos_a]], dtype=np.float32)
        x, z = candidates[i]
        y = float(sampled_heights[i]) - sink_depth
        placed_v = (v * scale) @ R.T + np.array([x, y, z], dtype=np.float32)
        group = by_species.setdefault(sp.__name__, {"verts": [], "faces": [], "colors": [], "offset": 0})
        group["faces"].append(f + group["offset"])
        group["verts"].append(placed_v)
        group["colors"].append(c)
        group["offset"] += placed_v.shape[0]

    scene = trimesh.Scene()
    for sp_name, group in by_species.items():
        mesh = trimesh.Trimesh(
            vertices=np.vstack(group["verts"]),
            faces=np.vstack(group["faces"]),
            vertex_colors=np.vstack(group["colors"]),
            process=False,
        )
        scene.add_geometry(mesh, geom_name=f"forest__{sp_name}")

    buf = io.BytesIO()
    scene.export(file_obj=buf, file_type="glb")
    return buf.getvalue()
```

- [ ] **Step 3: Run test**

```
python -m pytest tests/test_terrain_v3.py::test_build_forest_glb_returns_bytes -v
```

Expected: `PASSED` (may take ~10s - tree generation is slow)

- [ ] **Step 4: Add `/v3/export/forest` endpoint to `server.py`**

```python
from terrain_v3.export.forest_export import build_forest_glb

@app.post("/v3/export/forest")
def export_forest():
    t0 = time.time()
    try:
        body = request.get_json(force=True) or {}
        cfg = coerce_config(body.get("config", {}))
        density_cfg = coerce_density_config(body.get("density", {}))
        author_layers = body.get("authorLayers")
        folder = str(body.get("folder", "")).strip()
        name = str(body.get("name", "")).strip()
        if not folder or not name:
            return jsonify({"error": "folder and name are required"}), 400

        hf = compute_heightfield(cfg, density_cfg, author_layers=author_layers)
        glb = build_forest_glb(
            biome_ids=hf["biome"]["biome_ids"],
            height=hf["height"],
            world_x=hf["world_x"],
            world_z=hf["world_z"],
            sea_level=hf["sea_level"],
            seed=int(cfg.seed),
        )
        try:
            forest_name = f"{name}-forest"
            map_key = map_bundle.write(folder, forest_name, glb)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        elapsed = time.time() - t0
        print(f"[export-forest] done key={map_key} bytes={len(glb):,} elapsed={elapsed:.3f}s", flush=True)
        return jsonify({"ok": True, "mapKey": map_key, "bytes": len(glb), "elapsed_s": round(elapsed, 3)})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"error": f"{type(exc).__name__}: {exc}"}), 500
```

- [ ] **Step 5: Smoke-test the endpoint**

With server running (`python server.py`):

```bash
curl -s -X POST http://127.0.0.1:5175/v3/export/forest \
  -H "Content-Type: application/json" \
  -d '{"config":{},"density":{"density_resolution":32},"folder":"test","name":"smoke"}' \
  | python -m json.tool
```

Expected: `{"ok": true, "mapKey": "test/smoke-forest.glb", ...}`

- [ ] **Step 6: Commit**

```bash
git add terrain_v3/export/forest_export.py server.py tests/test_terrain_v3.py
git commit -m "feat: forest export endpoint - biome-placed trees from v3 pipeline using v1 species"
```

---

### Task 3: Export UI panel in app.html

**Files:**
- Modify: `G:\My Drive\Scripts\html game\html-game-v2\tools\terrain-v3\app.html`

- [ ] **Step 1: Find the export section** - search app.html for `/v3/export/map`. If a button already exists, verify it works and skip ahead. If not, continue.

- [ ] **Step 2: Add export panel**

Find the section of app.html where other action buttons live (near "Generate" or the main toolbar). Add:

```html
<!-- Export panel -->
<div id="export-panel" style="margin-top:12px; padding:10px; border:1px solid #444; border-radius:6px; background:#1e1e1e;">
  <div style="color:#ccc; font-size:12px; font-weight:600; margin-bottom:8px;">Export Map</div>
  <label style="color:#aaa; font-size:11px; display:block; margin-bottom:4px;">Folder</label>
  <input id="export-folder" type="text" value="workshop" style="width:100%; box-sizing:border-box; background:#2a2a2a; border:1px solid #555; color:#eee; padding:4px 6px; border-radius:4px; margin-bottom:6px; font-size:12px;">
  <label style="color:#aaa; font-size:11px; display:block; margin-bottom:4px;">Name</label>
  <input id="export-name" type="text" value="my_map" style="width:100%; box-sizing:border-box; background:#2a2a2a; border:1px solid #555; color:#eee; padding:4px 6px; border-radius:4px; margin-bottom:6px; font-size:12px;">
  <button id="btn-export-terrain" style="width:100%; margin-bottom:4px; padding:6px; background:#2d5a8e; border:none; color:#fff; border-radius:4px; cursor:pointer; font-size:12px;">Export Terrain GLB</button>
  <button id="btn-export-forest" style="width:100%; padding:6px; background:#2d6e4f; border:none; color:#fff; border-radius:4px; cursor:pointer; font-size:12px;">Export Forest GLB</button>
  <div id="export-status" style="margin-top:6px; font-size:11px; color:#aaa;"></div>
</div>
```

- [ ] **Step 3: Add export JS**

In the app.html `<script>` section (or linked JS), add:

```javascript
function getExportPayload() {
  return {
    config: getCurrentConfig(),      // whatever fn the app uses to get current terrain config
    density: getCurrentDensity(),    // current density preview config
    authorLayers: getAuthorLayers(), // current paint layers
    folder: document.getElementById('export-folder').value.trim(),
    name: document.getElementById('export-name').value.trim(),
  };
}

document.getElementById('btn-export-terrain').addEventListener('click', async () => {
  const status = document.getElementById('export-status');
  status.textContent = 'Exporting terrain...';
  try {
    const res = await fetch('/v3/export/map', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(getExportPayload()),
    });
    const data = await res.json();
    if (data.ok) {
      status.textContent = `OK Terrain: ${data.mapKey} (${(data.bytes / 1024).toFixed(0)} KB, ${data.elapsed_s.toFixed(1)}s)`;
    } else {
      status.textContent = `ERR ${data.error}`;
    }
  } catch (e) {
    status.textContent = `ERR ${e.message}`;
  }
});

document.getElementById('btn-export-forest').addEventListener('click', async () => {
  const status = document.getElementById('export-status');
  status.textContent = 'Exporting forest (slow - builds trees)...';
  try {
    const res = await fetch('/v3/export/forest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(getExportPayload()),
    });
    const data = await res.json();
    if (data.ok) {
      status.textContent = `OK Forest: ${data.mapKey} (${(data.bytes / 1024).toFixed(0)} KB, ${data.elapsed_s.toFixed(1)}s)`;
    } else {
      status.textContent = `ERR ${data.error}`;
    }
  } catch (e) {
    status.textContent = `ERR ${e.message}`;
  }
});
```

> **Note:** Replace `getCurrentConfig()`, `getCurrentDensity()`, `getAuthorLayers()` with whatever the existing app uses. Grep `app.html` for `fetch('/v3/preview/2d'` to find where config is currently serialised - reuse the same pattern.

- [ ] **Step 4: Manual test** - Open http://127.0.0.1:5175/, fill in folder="workshop" name="test_export", click "Export Terrain GLB". Confirm status shows the map key and a GLB + `-data.json` appear in `models/maps/workshop/`.

- [ ] **Step 5: Commit**

```bash
git add app.html
git commit -m "feat: add export panel UI for terrain + forest GLB"
```

---

## Phase 2 - Game: authored-map terrain loader

### Task 4: terrain-loader.js

**Files:**
- Create: `G:\My Drive\Scripts\procedural-creature\workshop-webgpu\terrain-loader.js`

- [ ] **Step 1: Write the module**

```javascript
// terrain-loader.js
// Loads a terrain-v3 exported map: GLB visual mesh + map-data.json heightmap.
// Returns an API identical in shape to what environment-viewer.html needs to
// replace terrainHeight/terrainNormal without touching the procedural path.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export async function loadTerrainMap(mapKey, { scene }) {
  // mapKey = "folder/name.glb"  (relative to the maps/ serving root)
  const basePath = mapKey.replace(/\.glb$/, '');
  const glbUrl = `maps/${mapKey}`;
  const dataUrl = `maps/${basePath}-data.json`;

  const [gltf, mapData] = await Promise.all([
    new Promise((resolve, reject) => new GLTFLoader().load(glbUrl, resolve, undefined, reject)),
    fetch(dataUrl).then(r => { if (!r.ok) throw new Error(`map-data fetch failed: ${r.status}`); return r.json(); }),
  ]);

  // ---- visual mesh ----
  const terrainMesh = gltf.scene.children[0];
  terrainMesh.receiveShadow = true;
  terrainMesh.castShadow = false;
  // Replace the trimesh default material with a vertex-color standard material
  terrainMesh.material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.9,
    metalness: 0.0,
  });
  scene.add(terrainMesh);

  // ---- heightmap lookup ----
  const { worldX, worldZ, seaLevel, resolution, biomeNames, biomeIds, grassDensity } = mapData;
  const heights = new Float32Array(mapData.resolution * mapData.resolution);
  // Extract Y from the GLB vertex positions (they are in the same grid order as map-data)
  const pos = terrainMesh.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) heights[i] = pos.getY(i);

  function bilinear(grid, x, z) {
    const fx = (x / worldX + 0.5) * (resolution - 1);
    const fz = (z / worldZ + 0.5) * (resolution - 1);
    const ix = Math.max(0, Math.min(resolution - 2, Math.floor(fx)));
    const iz = Math.max(0, Math.min(resolution - 2, Math.floor(fz)));
    const tx = fx - ix, tz = fz - iz;
    const a = grid[iz * resolution + ix];
    const b = grid[iz * resolution + ix + 1];
    const c = grid[(iz + 1) * resolution + ix];
    const d = grid[(iz + 1) * resolution + ix + 1];
    return a * (1 - tx) * (1 - tz) + b * tx * (1 - tz) + c * (1 - tx) * tz + d * tx * tz;
  }

  const biomeGrid = new Uint8Array(biomeIds);
  const densityGrid = new Float32Array(grassDensity);

  function nearestIdx(x, z) {
    const ix = Math.round((x / worldX + 0.5) * (resolution - 1));
    const iz = Math.round((z / worldZ + 0.5) * (resolution - 1));
    return Math.max(0, Math.min(resolution * resolution - 1,
      Math.max(0, Math.min(resolution - 1, iz)) * resolution +
      Math.max(0, Math.min(resolution - 1, ix))
    ));
  }

  return {
    mesh: terrainMesh,
    worldX,
    worldZ,
    seaLevel,
    resolution,
    biomeNames,
    heightAt(x, z) { return bilinear(heights, x, z); },
    biomeAt(x, z) { return biomeNames[biomeGrid[nearestIdx(x, z)]] ?? 'plains'; },
    grassDensityAt(x, z) { return bilinear(densityGrid, x, z); },
    grassDensityGrid: densityGrid,   // raw flat Float32Array for GPU texture upload
  };
}
```

- [ ] **Step 2: Manual smoke-test** - Temporarily add to environment-viewer.html's top-level module script:

```javascript
import { loadTerrainMap } from './terrain-loader.js';
const loader = await loadTerrainMap('workshop/test_export.glb', { scene });
console.log('heightAt(0,0):', loader.heightAt(0, 0));
console.log('biomeAt(0,0):', loader.biomeAt(0, 0));
```

Open the viewer, check console. Expected: numeric height and a biome name. Remove the test lines when done.

- [ ] **Step 3: Commit**

```bash
git add terrain-loader.js
git commit -m "feat: terrain-loader.js - loads authored map GLB + heightmap + biome grid"
```

---

### Task 5: Dual-mode terrain in environment-viewer.html

**Files:**
- Modify: `environment-viewer.html` (lines ~100-200 init section + animate loop)

The game detects `?map=folder/name.glb`. When present it skips the procedural terrain and routes `terrainHeight` through the loader.

- [ ] **Step 1: Add URL param detection near the top of the module script**

After the existing `const GRASS_MODE = ...` block (line ~50):

```javascript
const MAP_KEY = new URLSearchParams(location.search).get('map') || null;
// When MAP_KEY is set: skip terrain-system, CDLOD mesh, procedural forest.
// terrainHeight/terrainNormal are replaced by the loader below.
```

- [ ] **Step 2: Import terrain-loader**

With the other imports at the top of the script:

```javascript
import { loadTerrainMap } from './terrain-loader.js';
```

- [ ] **Step 3: Replace terrain init block with dual-mode dispatch**

Find where `createTerrainSystem(...)` is called (search for `createTerrainSystem`). Wrap it:

```javascript
let loadedMap = null;

if (MAP_KEY) {
  // ---- Authored map mode ----
  loadedMap = await loadTerrainMap(MAP_KEY, { scene });
  // terrainHeight and terrainNormal shim - these are used by creatures, grass, water, etc.
  terrainHeight = (x, z) => loadedMap.heightAt(x, z);
  terrainNormal = terrainNormalAt;  // keep using the analytical approximation for now
  // Skip CDLOD and procedural terrain setup that follows this block.
} else {
  // ---- Infinite procedural world mode (existing code, unchanged) ----
  // ... existing createTerrainSystem, CDLOD, etc.
}
```

> **Note:** `terrainHeight` must be declared with `let` not `const` earlier in the file. Search for its current declaration and change to `let` if needed. `terrainNormalAt` from `terrain-system.js` uses finite differences - it will still approximate normals correctly from the loaded height function.

- [ ] **Step 4: Guard CDLOD and procedural forest behind `!MAP_KEY`**

Find `if (TERRAIN_MODE === 'gpu')` / `cdlodRef = ...` and `forestGPURef = ...` and wrap:

```javascript
if (!MAP_KEY && TERRAIN_MODE === 'gpu') {
  // ... existing CDLOD init
}
if (!MAP_KEY && FOREST_MODE === 'gpu') {
  // ... existing forest GPU init
}
```

- [ ] **Step 5: Load forest GLB in authored-map mode**

After the `loadedMap = await loadTerrainMap(...)` block:

```javascript
if (MAP_KEY) {
  const forestKey = MAP_KEY.replace(/\.glb$/, '-forest.glb');
  try {
    await new Promise((resolve, reject) =>
      new GLTFLoader().load(`maps/${forestKey}`, gltf => {
        gltf.scene.traverse(obj => { if (obj.isMesh) { obj.castShadow = true; obj.receiveShadow = true; } });
        scene.add(gltf.scene);
        resolve();
      }, undefined, reject)
    );
  } catch (e) {
    console.warn('[authored map] no forest GLB found, skipping:', e.message);
  }
}
```

- [ ] **Step 6: Manual test**

Export a map from terrain-v3 (Task 3). Copy `models/maps/workshop/` into the workshop-webgpu directory (or symlink). Serve workshop-webgpu with `python -m http.server 8080`. Open:

```
http://localhost:8080/environment-viewer.html?map=workshop/test_export.glb
```

Expected: authored terrain mesh visible, creatures walking on it, no CDLOD flickering.

- [ ] **Step 7: Commit**

```bash
git add environment-viewer.html
git commit -m "feat: dual-mode terrain - authored map via ?map= param replaces procedural terrain"
```

---

## Phase 3 - Biome-aware grass

### Task 6: Grass cull shader respects biome density texture

**Files:**
- Modify: `grass-compute.js`
- Modify: `environment-viewer.html` (grass init in map mode)

- [ ] **Step 1: Add optional `biomeDensityTex` param to `createComputeGrass`**

In `grass-compute.js`, after the existing uniform declarations (~line 90):

```javascript
// Optional biome density texture (Float32, resxres, single channel).
// When provided, each blade's keepRand must be < biomeDensity to survive cull.
// When absent, all blades pass the density gate (behaviour unchanged).
const uUseBiomeDensity = uniform(opts.biomeDensityTex ? 1 : 0);
const uBiomeDensityTex = opts.biomeDensityTex
  ? texture(opts.biomeDensityTex)
  : null;
const uWorldXHalf = uniform((opts.worldX ?? 200) / 2.0);
const uWorldZHalf = uniform((opts.worldZ ?? 200) / 2.0);
```

- [ ] **Step 2: Sample density in the cull kernel**

In the `cull` Fn body, after the existing `keepRand` line:

```javascript
// Biome density gate (only when texture provided)
let biomeDensity = float(1.0);
if (uBiomeDensityTex) {
  const uvX = wx.add(uWorldXHalf).div(uWorldXHalf.mul(2)).clamp(0.0, 1.0);
  const uvZ = wz.add(uWorldZHalf).div(uWorldZHalf.mul(2)).clamp(0.0, 1.0);
  biomeDensity = uBiomeDensityTex.uv(vec2(uvX, uvZ)).r;
}

const live = wy.greaterThan(uWaterMin)
  .and(dist.lessThan(uRadius))
  .and(keepRand.greaterThan(edge))
  .and(keepRand.lessThan(biomeDensity));   // <- new gate
```

- [ ] **Step 3: Wire in environment-viewer.html (map mode only)**

In the `createComputeGrass(...)` call inside the `!MAP_KEY` guard... wait - grass DOES run in map mode too. Find the `grassRef = createComputeGrass(...)` call and pass the texture when in map mode:

```javascript
let grassBiomeDensityTex = null;
if (MAP_KEY && loadedMap) {
  const { resolution, grassDensityGrid, worldX, worldZ } = loadedMap;
  grassBiomeDensityTex = new THREE.DataTexture(
    grassDensityGrid, resolution, resolution,
    THREE.RedFormat, THREE.FloatType,
  );
  grassBiomeDensityTex.needsUpdate = true;
}

grassRef = createComputeGrass({
  renderer, camera,
  // ... existing opts ...
  biomeDensityTex: grassBiomeDensityTex,
  worldX: loadedMap?.worldX,
  worldZ: loadedMap?.worldZ,
});
```

- [ ] **Step 4: Manual test**

Load the authored map (Task 5). Scrub the camera across different biome zones (ocean -> plains -> forest). Grass should be absent over water/ocean biomes and dense in forest zones.

- [ ] **Step 5: Commit**

```bash
git add grass-compute.js environment-viewer.html
git commit -m "feat: biome-aware grass - density texture gates blade survival in authored-map mode"
```

---

## Phase 4 - Start screen

### Task 7: Serve maps directory + map registry

**Files:**
- Create: `G:\My Drive\Scripts\procedural-creature\workshop-webgpu\serve.py`

The game needs to be served from localhost for WebGPU, and maps need to be accessible. The terrain-v3 tool writes maps to `models/maps/` in the html-game-v2 repo. We need a symlink or copy into workshop-webgpu's `maps/` directory, or configure terrain-v3 to write there directly.

- [ ] **Step 1: Create a simple local server**

```python
# serve.py  - run from workshop-webgpu/ to serve on localhost:8080
import http.server, sys, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
http.server.test(HandlerClass=http.server.SimpleHTTPRequestHandler, port=port, bind='127.0.0.1')
```

- [ ] **Step 2: Create `maps/` directory and point terrain-v3 at it**

```bash
mkdir "G:\My Drive\Scripts\procedural-creature\workshop-webgpu\maps"
```

In terrain-v3's `app.html`, change the default folder input to output into the workshop-webgpu maps dir - OR add an env var / config option:

Add to `server.py` at top:

```python
import os
MAPS_DIR = Path(os.environ.get(
    "TERRAIN_MAPS_DIR",
    str(HERE.parent.parent / "models" / "maps")   # default: html-game-v2/models/maps
))
```

Then in `export_map()`:

```python
map_key = map_bundle.write(folder, name, glb, maps_dir=MAPS_DIR, map_data=map_data)
```

Start terrain-v3 pointing at the workshop maps dir:

```bash
set TERRAIN_MAPS_DIR=G:\My Drive\Scripts\procedural-creature\workshop-webgpu\maps
python server.py
```

- [ ] **Step 3: Verify** - Export a map, confirm it appears in `workshop-webgpu/maps/workshop/`.

- [ ] **Step 4: Commit**

```bash
git add serve.py
git commit -m "feat: serve.py for localhost dev + TERRAIN_MAPS_DIR env var"
```

---

### Task 8: start-screen.js

**Files:**
- Create: `G:\My Drive\Scripts\procedural-creature\workshop-webgpu\start-screen.js`

- [ ] **Step 1: Write start-screen.js**

```javascript
// start-screen.js
// Renders a map-selection overlay before the game initialises.
// Resolves with { mode: 'infinite' } or { mode: 'map', mapKey: 'folder/name.glb' }.
//
// Usage:
//   import { showStartScreen } from './start-screen.js';
//   const choice = await showStartScreen();

export async function showStartScreen() {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.id = 'start-screen';
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', background: '#0d1117',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', zIndex: '100', fontFamily: 'system-ui, sans-serif',
      color: '#e6edf3', gap: '24px', padding: '32px', boxSizing: 'border-box',
    });

    const title = document.createElement('h1');
    title.textContent = 'Creature Workshop';
    Object.assign(title.style, { margin: '0', fontSize: '28px', fontWeight: '600', color: '#f0f6fc' });
    overlay.appendChild(title);

    const grid = document.createElement('div');
    Object.assign(grid.style, {
      display: 'flex', flexWrap: 'wrap', gap: '12px',
      justifyContent: 'center', maxWidth: '800px', width: '100%',
    });

    function makeCard(label, sub, onClick) {
      const card = document.createElement('button');
      Object.assign(card.style, {
        background: '#161b22', border: '1px solid #30363d', borderRadius: '8px',
        color: '#e6edf3', cursor: 'pointer', padding: '20px 24px',
        minWidth: '180px', textAlign: 'left', transition: 'border-color 0.15s',
      });
      card.onmouseenter = () => { card.style.borderColor = '#58a6ff'; };
      card.onmouseleave = () => { card.style.borderColor = '#30363d'; };
      const name = document.createElement('div');
      name.textContent = label;
      Object.assign(name.style, { fontWeight: '600', fontSize: '15px', marginBottom: '4px' });
      const desc = document.createElement('div');
      desc.textContent = sub;
      Object.assign(desc.style, { fontSize: '12px', color: '#8b949e' });
      card.appendChild(name); card.appendChild(desc);
      card.addEventListener('click', onClick);
      return card;
    }

    // Infinite world card
    grid.appendChild(makeCard('Infinite World', 'Procedural terrain + creatures', () => {
      overlay.remove();
      resolve({ mode: 'infinite' });
    }));

    // Map cards from map-config.json
    fetch('maps/map-config.json')
      .then(r => r.ok ? r.json() : { maps: {} })
      .catch(() => ({ maps: {} }))
      .then(cfg => {
        const maps = cfg.maps || {};
        for (const [key, meta] of Object.entries(maps)) {
          if (!meta.playable) continue;
          grid.appendChild(makeCard(
            meta.displayName || key,
            'Authored map',
            () => {
              overlay.remove();
              resolve({ mode: 'map', mapKey: key });
            }
          ));
        }
      });

    overlay.appendChild(grid);
    document.body.appendChild(overlay);
  });
}
```

- [ ] **Step 2: Wire into environment-viewer.html**

At the very top of the module script, before any renderer or scene setup:

```javascript
import { showStartScreen } from './start-screen.js';

// Show start screen unless ?map= is already in the URL (direct link bypasses it).
let _startChoice = null;
if (!MAP_KEY) {
  _startChoice = await showStartScreen();
  if (_startChoice.mode === 'map') {
    // Redirect to the same page with ?map= so the full init path runs cleanly.
    const url = new URL(location.href);
    url.searchParams.set('map', _startChoice.mapKey);
    location.replace(url.toString());
    // Page reloads - code below won't execute.
  }
  // mode === 'infinite': fall through to normal init
}
```

- [ ] **Step 3: Manual test**

Open `http://localhost:8080/environment-viewer.html`. The start screen should appear. Click "Infinite World" -> game starts normally. Re-open, click a map card -> page reloads with `?map=...`, game loads authored map.

- [ ] **Step 4: Commit**

```bash
git add start-screen.js environment-viewer.html
git commit -m "feat: start screen - choose infinite world or authored map"
```

---

## Self-review checklist

**Spec coverage:**
- [x] Finishing v3 - Tasks 1-3: map-data.json, forest endpoint, export UI
- [x] Connecting to the game - Tasks 4-5: terrain-loader + dual-mode env-viewer
- [x] Start screen - Tasks 7-8: serve.py + start-screen.js
- [x] Biome-correct grass - Task 6: biomeDensityTex in grass-compute
- [x] Biome-correct trees - Task 2 (forest_export uses v3 biome_ids + v1 species tables)

**Gaps / explicit deferrals:**
- **Caves & overhangs (marching cubes):** Not in this plan. The heightfield path (no overhangs) is the initial authored-map format; marching cubes is a separate follow-on.
- **Shadow map for loaded terrain:** The loaded GLB mesh will receive shadows automatically via `receiveShadow = true`. The directional light shadow camera bounds may need manual adjustment for large maps.
- **Terrain normals for creatures:** `terrainNormalAt` from `terrain-system.js` uses finite differences on `terrainHeight` - it will work correctly once `terrainHeight` is replaced by `heightAt` from the loader.
- **Water in authored-map mode:** `waterRef` uses `terrainHeight` internally for lake placement. It will use the loaded height function automatically. Sea level comes from `mapData.seaLevel`.
- **`terrainHeight` declaration:** Must be `let`, not `const`, in environment-viewer.html for Task 5's reassignment to work. Grep and fix if needed.
- **GLTFLoader import in environment-viewer.html:** Not currently imported. Add to imports alongside other `three/addons/` imports in Task 5.
