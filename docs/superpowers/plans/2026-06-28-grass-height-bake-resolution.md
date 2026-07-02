# Grass Height Bake Resolution Fix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix grass floating above the ground on steep hills in authored terrain maps by scaling the height texture bake resolution to match world dimensions.

**Architecture:** The GPU grass compute shader places blades by sampling a pre-baked float height texture (`loadedMap.heightTex`). Each texel is already accurately raycasted against the real GLTF mesh via `mapCollider.raycastDown` — the error is not in the sample values but in the GPU bilinear interpolation *between* texels. On steep slopes, adjacent texels can differ by many units; the bilinear midpoint between them is a poor estimate of the mesh surface at that point. Halving the world-units-per-texel ratio halves the max interpolation error. Currently the bake is fixed at 512×512 regardless of world size. Scaling to `ceil(max(worldX, worldZ))` capped at 2048 gives roughly 1 texel/world-unit, reducing bilinear error to sub-0.1 units on typical terrain slopes.

**Tech Stack:** Three.js WebGPU, `environment-viewer.html` inline script module, `grass-compute.js` TSL height texture sampling

---

## Background

`bakeHeightTexture(terrainHeight, hBounds, resolution = 512)` at `environment-viewer.html:274` builds a `DataTexture` by calling `terrainHeight(wx, wz)` for each of `resolution²` texel centres. `terrainHeight` (line 263) already routes through `mapCollider.raycastDown` when a collider is available, so each texel is exact. The problem is downstream: the GPU bilinear filter in `grass-compute.js:138–143` interpolates between those texels. Error = `slope × (worldUnitsPerTexel / 2)`. At 512 texels over a 512-unit world, max error on a 45° slope ≈ 0.5 m — large relative to an 0.8 m grass blade. At 1 texel/world-unit (capped at 2048) the error drops to ≤ 0.125 m.

There are no other files to touch: the GPU grass shader already handles non-default texture resolutions correctly (UV math uses world bounds, not pixel counts).

---

## File Map

| File | Change |
|------|--------|
| `environment-viewer.html` | Two-line change at the `bakeHeightTexture` call site (~line 299) |

---

### Task 1: Scale bake resolution to world size

**Files:**
- Modify: `environment-viewer.html` (lines 290–300, the `if (loadedMap)` bake block)

- [ ] **Step 1: Locate the call site**

Open `environment-viewer.html` and find this block (around line 290):

```javascript
if (loadedMap) {
  showStatus('baking height texture for grass...');
  await nextPaint();
  const hBounds = {
    minX: -loadedMap.worldX * 0.5,
    minZ: -loadedMap.worldZ * 0.5,
    worldX: loadedMap.worldX,
    worldZ: loadedMap.worldZ,
  };
  loadedMap.heightTex = bakeHeightTexture(terrainHeight, hBounds);
  loadedMap.heightTexBounds = hBounds;
}
```

- [ ] **Step 2: Add the resolution calculation and pass it**

Replace the `loadedMap.heightTex` line only (leave everything else unchanged):

```javascript
if (loadedMap) {
  showStatus('baking height texture for grass...');
  await nextPaint();
  const hBounds = {
    minX: -loadedMap.worldX * 0.5,
    minZ: -loadedMap.worldZ * 0.5,
    worldX: loadedMap.worldX,
    worldZ: loadedMap.worldZ,
  };
  const bakeRes = Math.min(2048, Math.max(512, Math.ceil(Math.max(loadedMap.worldX, loadedMap.worldZ))));
  loadedMap.heightTex = bakeHeightTexture(terrainHeight, hBounds, bakeRes);
  loadedMap.heightTexBounds = hBounds;
}
```

`bakeHeightTexture` already accepts `resolution` as its third argument (defaulting to 512) — no changes needed to that function.

- [ ] **Step 3: Verify in browser**

Open `environment-viewer.html?map=<your-map-key>` in Chrome.

Check the console for any errors. Load time may increase slightly (more raycasts during bake) — that is expected and acceptable.

Walk to a steep hill section and confirm grass blades sit closer to the ground surface than before. On moderately steep hills (30–45°) the floating should be substantially reduced or eliminated. On very steep cliff faces (>60°) some residual floating may remain — this is expected given bilinear limits.

- [ ] **Step 4: Confirm no frame-rate regression**

Check the FPS counter. Baking is a one-time load-time cost; runtime grass rendering is unaffected (same texture sampling path, same shader).

- [ ] **Step 5: Commit**

```bash
git add environment-viewer.html
git commit -m "fix(grass): scale height bake resolution to world size to reduce slope floating"
```

---

## Self-Review

**Spec coverage:** The single requirement — grass floats on steep hills on authored terrain — is addressed by reducing bilinear interpolation error. ✓

**Placeholder scan:** No TBD/TODO phrases. All code is complete and exact. ✓

**Type consistency:** `bakeHeightTexture(fn, bounds, resolution)` signature is unchanged; the new call passes a computed integer as the third argument, matching the existing default parameter. ✓

**Limitation documented:** Very steep cliff faces (>60°) may still show some floating — this is a fundamental limit of bilinear texture sampling and would require a fully different approach (e.g. raycasting per-blade on the CPU, which isn't feasible for GPU-placed blades). The fix covers the common case the user reported. ✓
