// base-game-world-map.js — a bake for world-map.js's `createWorldMapOverlay` over streamed terrain.
// The overlay, its projection, zoom, arrows, hover readout and panel are that module's and are used
// unchanged. Only the bake differs: bakeMapCanvas covers a bounded authored map once, and this page
// streams an unbounded window, so this bakes a square that follows the player.
import { bakeMapPixels, bakeDetailCanvas } from './world-map.js';

// The world square a bake covers, in the field names the overlay reads.
export function mapWindow(center, halfSize, res) {
  const worldX = halfSize * 2;
  return {
    cx: center[0], cz: center[2], res, worldX, worldZ: worldX,
    sxu: worldX / res, szv: worldX / res,
    wx0: center[0] - halfSize, wz0: center[2] - halfSize,
  };
}

// Has the player walked far enough to re-bake? res*res samples a frame is not free.
export function needsRebake(win, center, moveThreshold) {
  if (!win) return true;
  return Math.hypot(center[0] - win.cx, center[2] - win.cz) >= moveThreshold;
}

// A bake in the exact shape bakeMapCanvas returns, so the overlay cannot tell the two apart.
// The samplers take WORLD coordinates and may answer null outside the resident field; those cells
// come back as `unresolved` rather than as a hole.
export function bakeWindowCanvas(win, { sampleHeight, sampleColor, seaLevel = -Infinity, unresolved = [26, 30, 36] }) {
  const { res, sxu, szv, wx0, wz0 } = win;
  const edge = (i) => (i < 0 ? 0 : i > res - 1 ? res - 1 : i);
  const worldXY = (ix, iz) => [wx0 + (edge(ix) + 0.5) * sxu, wz0 + (edge(iz) + 0.5) * szv];
  let missing = 0;
  const height = (ix, iz) => { const [x, z] = worldXY(ix, iz); const h = sampleHeight(x, z); return Number.isFinite(h) ? h : 0; };
  const color = (ix, iz) => { const [x, z] = worldXY(ix, iz); const c = sampleColor(x, z); if (!c) { missing++; return unresolved; } return c; };
  const isWater = (ix, iz) => height(ix, iz) < seaLevel - 0.05;

  const { data } = bakeMapPixels({ res, cellWorld: sxu, sampleBiomeColor: color, sampleHeight: height, isWater });
  let minHeight = Infinity, maxHeight = -Infinity;
  for (let iz = 0; iz < res; iz += 4) for (let ix = 0; ix < res; ix += 4) {
    const h = height(ix, iz); minHeight = Math.min(minHeight, h); maxHeight = Math.max(maxHeight, h);
  }
  const terrainDetailCanvas = bakeDetailCanvas({
    res, sxu, szv, sampleHeight: height, minHeight, maxHeight,
    seaLevel: Number.isFinite(seaLevel) ? seaLevel : -1e9,
  });
  const canvas = document.createElement('canvas');
  canvas.width = res; canvas.height = res;
  canvas.getContext('2d').putImageData(new ImageData(data, res, res), 0, 0);
  return { ...win, canvas, terrainDetailCanvas, missing };
}

// What a page wires up: step() each frame with the player's global position, and hand getBake
// straight to createWorldMapOverlay.
// One bake is res*res cells and about ten terrain samples each: 165k samples at res 128. That is a
// visible stall, so it happens only while the map is open, never during play. `step` returns true
// when it baked, so a caller can say so.
export function createWindowedBake({ sampleHeight, sampleColor, seaLevel = -Infinity, res = 128, halfSize = 400, rebakeEvery = 120 } = {}) {
  let bake = null;
  return {
    getBake: () => bake,
    step(center, open = true) {
      if (!open || !center || !needsRebake(bake, center, rebakeEvery)) return false;
      // seaLevel may be a live getter: water level is a setting the player can move.
      const sea = typeof seaLevel === 'function' ? seaLevel() : seaLevel;
      bake = bakeWindowCanvas(mapWindow(center, halfSize, res), { sampleHeight, sampleColor, seaLevel: sea });
      return true;
    },
    clear() { bake = null; },
  };
}
