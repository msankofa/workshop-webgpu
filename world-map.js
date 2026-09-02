// World map HUD: bakes the authored terrain map into a biome-colored, hill-shaded image
// and projects it into the heading-up minimap and the north-up full-screen (`M`) map.
//
// The pure functions (bakeMapPixels, minimapImageAffine, bigMapImageAffine, worldToBigMap)
// carry the load-bearing projection math and are unit-tested in test-world-map.mjs against
// the finder's own marker formula so terrain and friend dots stay glued together. The
// browser-only wrappers (bakeMapCanvas, createWorldMapOverlay) touch canvas/DOM.
//
// Convention (shared with playerViewHeading/worldBearing in environment-viewer.html):
// clockwise compass, N = +Z, E = -X in three.js Y-up coords.

import { BIOME_COLORS } from './biome-classifier-js.js';
import { heightColor, slopeColor } from './terrain-generator-js.js';

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function normalizeAngle(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

// Small multi-stop RGB ramp (stops sorted by position 0..1, colors 0..255).
function rampColor(t, stops) {
  t = clamp(t, 0, 1);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [p0, c0] = stops[i - 1];
      const [p1, c1] = stops[i];
      const f = (t - p0) / Math.max(1e-6, p1 - p0);
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
    }
  }
  return stops[stops.length - 1][1].slice();
}
const DENSITY_RAMP = [[0, [24, 30, 28]], [0.5, [70, 122, 60]], [1, [154, 224, 112]]];
const TREE_RAMP = [[0, [24, 30, 28]], [0.5, [42, 92, 52]], [1, [96, 172, 96]]];
const WATER_RAMP = [[0, [128, 186, 214]], [0.5, [46, 112, 172]], [1, [14, 42, 96]]];

// --- pure: pixel bake --------------------------------------------------------------------

// Lambert hillshade light: from the upper-left (west + north) and above. Subtle relief.
const LIGHT = (() => {
  const v = [-0.5, 0.82, -0.28];
  const len = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
})();

// Build an RGBA image (res x res) coloring each cell by biome and multiplying by a hillshade
// derived from the height gradient. `sampleBiomeColor(ix,iz)` -> [r,g,b]; `sampleHeight`
// returns world height and must clamp its own indices; `isWater` (optional) flattens the
// shade on water so lakes/ocean read flat. `cellWorld` is world units per cell (for slope).
export function bakeMapPixels({ res, cellWorld, sampleBiomeColor, sampleHeight, isWater, shaded = true }) {
  const data = new Uint8ClampedArray(res * res * 4);
  const inv2c = 1 / (2 * cellWorld);
  for (let iz = 0; iz < res; iz++) {
    for (let ix = 0; ix < res; ix++) {
      let shade = 1;
      // Data overlays (slope, density, water depth) pass shaded:false so their color ramp
      // reads at face value; biome/elevation/material get the Lambert relief.
      if (shaded) {
        const gx = (sampleHeight(ix + 1, iz) - sampleHeight(ix - 1, iz)) * inv2c;
        const gz = (sampleHeight(ix, iz + 1) - sampleHeight(ix, iz - 1)) * inv2c;
        // surface normal (-gx, 1, -gz) normalized, dotted with the light
        const nlen = Math.hypot(gx, 1, gz);
        let nl = (-gx * LIGHT[0] + LIGHT[1] - gz * LIGHT[2]) / nlen;
        nl = clamp(nl, 0, 1);
        shade = 0.62 + 0.62 * nl; // ~[0.62, 1.24]
        if (isWater && isWater(ix, iz)) shade = shade * 0.15 + 0.85; // flatten water
      }
      const [r, g, b] = sampleBiomeColor(ix, iz);
      const o = (iz * res + ix) * 4;
      data[o] = r * shade;
      data[o + 1] = g * shade;
      data[o + 2] = b * shade;
      data[o + 3] = 255;
    }
  }
  return { width: res, height: res, data };
}

// --- pure: projections -------------------------------------------------------------------

// Affine [a,b,c,d,e,f] (canvas setTransform order) mapping a baked-map image pixel (ix,iz)
// to heading-up minimap screen coords. Derived to agree exactly with the finder marker
// formula: X = cx - s*cosh*(wx-px) - s*sinh*(wz-pz); Y = cy + s*sinh*(wx-px) - s*cosh*(wz-pz),
// with wx = wx0 + sxu*ix, wz = wz0 + szv*iz. `s` = px per world unit, `heading` = view heading.
export function minimapImageAffine({ s, heading, px, pz, cx, cy, wx0, wz0, sxu, szv }) {
  const ch = Math.cos(heading), sh = Math.sin(heading);
  const a = -s * ch * sxu;
  const b = s * sh * sxu;
  const c = -s * sh * szv;
  const d = -s * ch * szv;
  const e = cx - s * ch * (wx0 - px) - s * sh * (wz0 - pz);
  const f = cy + s * sh * (wx0 - px) - s * ch * (wz0 - pz);
  return [a, b, c, d, e, f];
}

// North-up full-screen map: N = +Z is up, E = -X is right (same handedness as the compass).
export function worldToBigMap(wx, wz, { scale, cx, cy }) {
  return { x: cx - scale * wx, y: cy - scale * wz };
}

// Affine to blit the baked image into the north-up big map.
export function bigMapImageAffine({ scale, cx, cy, wx0, wz0, sxu, szv }) {
  return [-scale * sxu, 0, 0, -scale * szv, cx - scale * wx0, cy - scale * wz0];
}

// --- overlays: selectable minimap data layers --------------------------------------------

// The layers offered by the minimap layer menu, in display order. Every entry here is
// derivable from a loaded authored map (terrain-loader.js samplers). The terrain generator
// also previews continentalness/temperature/humidity/flowNorm, but those noise grids are not
// carried in the exported map data, so they are not available here without a re-export.
export const MAP_OVERLAYS = [
  { id: 'biome', label: 'Biome' },
  { id: 'elevation', label: 'Elevation' },
  { id: 'slope', label: 'Slope' },
  { id: 'material', label: 'Material' },
  { id: 'water', label: 'Water depth' },
  { id: 'grass', label: 'Grass density' },
  { id: 'tree', label: 'Tree density' },
];

// Returns { shaded, color(x,z)->[r,g,b] (0..255) } for the given overlay id, sampling the
// loaded map. Reuses the terrain generator's own heightColor/slopeColor so the in-game map
// matches the generator preview. Pure (no DOM) so it is unit-testable with a fake map.
export function overlayColorizer(loadedMap, overlayId) {
  const seaLevel = Number(loadedMap.seaLevel ?? 0);
  switch (overlayId) {
    case 'elevation':
      return { shaded: true, color: (x, z) => heightColor(loadedMap.heightAt(x, z), seaLevel) };
    case 'slope': {
      const step = Math.max(1, (loadedMap.worldX || 1200) / Math.max(2, loadedMap.resolution || 96));
      return {
        shaded: false,
        color: (x, z) => {
          const gx = (loadedMap.heightAt(x + step, z) - loadedMap.heightAt(x - step, z)) / (2 * step);
          const gz = (loadedMap.heightAt(x, z + step) - loadedMap.heightAt(x, z - step)) / (2 * step);
          return slopeColor(Math.hypot(gx, gz), 1.5);
        },
      };
    }
    case 'material':
      return {
        shaded: true,
        color: (x, z) => {
          const c = loadedMap.surfaceField ? loadedMap.surfaceField(x, z).materialColor : [0.4, 0.5, 0.3];
          return [c[0] * 255, c[1] * 255, c[2] * 255];
        },
      };
    case 'water':
      return {
        shaded: false,
        color: (x, z) => {
          const depth = seaLevel - loadedMap.heightAt(x, z);
          if (depth <= 0) return [30, 34, 40];
          return rampColor(clamp(depth / 45, 0, 1), WATER_RAMP);
        },
      };
    case 'grass':
      return { shaded: false, color: (x, z) => rampColor(clamp(loadedMap.grassDensityAt(x, z), 0, 1), DENSITY_RAMP) };
    case 'tree':
      return { shaded: false, color: (x, z) => rampColor(clamp(loadedMap.treeDensityAt ? loadedMap.treeDensityAt(x, z) : 0, 0, 1), TREE_RAMP) };
    case 'biome':
    default:
      return { shaded: true, color: (x, z) => BIOME_COLORS[loadedMap.biomeAt(x, z)] || [128, 128, 128] };
  }
}

// --- browser: bake a canvas from a loaded authored map -----------------------------------

// Samples loadedMap (from terrain-loader.js) on a res x res grid and returns a ready-to-blit
// canvas plus the world->pixel metadata the affines need. res upsamples past the ~96-cell
// source grid for a crisp big map. `overlayId` selects the data layer (see MAP_OVERLAYS).
// The relief-and-contour layer blitted over the colour bake. Split out of bakeMapCanvas so a
// windowed bake (base-game-world-map.js) produces the same layer instead of a second copy.
export function bakeDetailCanvas({ res, sxu, szv, sampleHeight, seaLevel = 0, minHeight, maxHeight }) {
  const rawStep = Math.max(1, (maxHeight - minHeight) / 14);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const contourStep = Math.max(1, Math.round(rawStep / magnitude) * magnitude);
  const canvas = document.createElement('canvas');
  canvas.width = res; canvas.height = res;
  const detailData = new Uint8ClampedArray(res * res * 4);
  for (let iz = 0; iz < res; iz++) for (let ix = 0; ix < res; ix++) {
    const o = (iz * res + ix) * 4;
    const h = sampleHeight(ix, iz);
    if (h < seaLevel - 0.05) continue;
    const gx = (sampleHeight(ix + 1, iz) - sampleHeight(ix - 1, iz)) / (2 * sxu);
    const gz = (sampleHeight(ix, iz + 1) - sampleHeight(ix, iz - 1)) / (2 * szv);
    const invLength = 1 / Math.hypot(gx, 1, gz);
    const shade = clamp(0.52 + ((-gx * 0.42 + 0.78 - gz * 0.46) * invLength) * 0.48, 0.35, 1);
    const contourBand = Math.abs(h / contourStep - Math.round(h / contourStep));
    const contourAlpha = contourBand < 0.055 ? (Math.round(h / contourStep) % 5 === 0 ? 105 : 66) : 0;
    detailData[o] = 5; detailData[o + 1] = 8; detailData[o + 2] = 10;
    detailData[o + 3] = Math.max(Math.round((1 - shade) * 65), contourAlpha);
  }
  canvas.getContext('2d').putImageData(new ImageData(detailData, res, res), 0, 0);
  return canvas;
}

export function bakeMapCanvas(loadedMap, { res = 384, overlayId = 'biome' } = {}) {
  const worldX = loadedMap.worldX, worldZ = loadedMap.worldZ;
  const sxu = worldX / res, szv = worldZ / res;
  const wx0 = -worldX * 0.5, wz0 = -worldZ * 0.5;
  const seaLevel = Number(loadedMap.seaLevel ?? 0);
  const worldXY = (ix, iz) => [wx0 + (clamp(ix, 0, res - 1) + 0.5) * sxu, wz0 + (clamp(iz, 0, res - 1) + 0.5) * szv];
  const sampleHeight = (ix, iz) => { const [x, z] = worldXY(ix, iz); return loadedMap.heightAt(x, z); };
  const overlay = overlayColorizer(loadedMap, overlayId);
  const sampleBiomeColor = (ix, iz) => { const [x, z] = worldXY(ix, iz); return overlay.color(x, z); };
  const isWater = (ix, iz) => sampleHeight(ix, iz) < seaLevel - 0.05;

  const { data } = bakeMapPixels({ res, cellWorld: sxu, sampleBiomeColor, sampleHeight, isWater, shaded: overlay.shaded });
  let minHeight = Infinity, maxHeight = -Infinity;
  for (let iz = 0; iz < res; iz += 4) for (let ix = 0; ix < res; ix += 4) {
    const h = sampleHeight(ix, iz); minHeight = Math.min(minHeight, h); maxHeight = Math.max(maxHeight, h);
  }
  const terrainDetailCanvas = bakeDetailCanvas({ res, sxu, szv, sampleHeight, seaLevel, minHeight, maxHeight });
  const canvas = document.createElement('canvas');
  canvas.width = res; canvas.height = res;
  canvas.getContext('2d').putImageData(new ImageData(data, res, res), 0, 0);
  return { canvas, terrainDetailCanvas, worldX, worldZ, wx0, wz0, sxu, szv, res, overlayId };
}

// --- browser: full-screen map overlay (M) ------------------------------------------------

// Exported so base-game-world-map.js draws the same arrow rather than keeping a second copy.
export function drawArrow(ctx, x, y, angle, size, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, -size);
  ctx.lineTo(size * 0.62, size * 0.72);
  ctx.lineTo(0, size * 0.34);
  ctx.lineTo(-size * 0.62, size * 0.72);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// getBake() -> bake object or null; getLocal() -> {p:[x,y,z]}; getRemotes() -> [{id,p,q}];
// getHeading() -> radians (view heading); getFacing(player) -> radians (their forward bearing).
export function createWorldMapOverlay({ getBake, getLocal, getRemotes, getHeading, getFacing }) {
  const style = document.createElement('style');
  style.textContent = `
    #world-map { position: fixed; inset: 0; z-index: 90; display: none; align-items: center;
      justify-content: center; background: rgba(6,8,11,0.72); backdrop-filter: blur(3px); }
    #world-map.open { display: flex; }
    #world-map canvas { border: 1px solid rgba(255,255,255,0.16); border-radius: 6px;
      box-shadow: 0 12px 48px rgba(0,0,0,0.5); background: rgba(9,12,16,0.9); cursor: crosshair; }
  `;
  document.head.appendChild(style);
  const root = document.createElement('div');
  root.id = 'world-map';
  const canvas = document.createElement('canvas');
  root.append(canvas);
  document.body.appendChild(root);

  let open = false;
  let zoom = 1;
  let hover = null;
  const MIN_ZOOM = 0.7, MAX_ZOOM = 4;

  function draw() {
    const side = Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.82);
    if (canvas.width !== side) { canvas.width = side; canvas.height = side; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, side, side);
    ctx.fillStyle = 'rgba(9,12,16,0.92)';
    ctx.fillRect(0, 0, side, side);

    const bake = getBake();
    if (!bake) {
      ctx.fillStyle = '#8b95a3';
      ctx.font = '14px system-ui, sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('No authored map loaded', side / 2, side / 2);
      return;
    }

    const pad = 14;
    const scale = ((side - pad * 2) / Math.max(bake.worldX, bake.worldZ)) * zoom;
    const cx = side / 2, cy = side / 2;
    const hoveredWorld = hover && hover.x >= pad && hover.x <= side - pad && hover.y >= pad && hover.y <= side - pad
      ? { x: (cx - hover.x) / scale, z: (cy - hover.y) / scale } : null;
    const hoverOnMap = hoveredWorld && hoveredWorld.x >= bake.wx0 && hoveredWorld.x <= bake.wx0 + bake.worldX
      && hoveredWorld.z >= bake.wz0 && hoveredWorld.z <= bake.wz0 + bake.worldZ;

    ctx.save();
    ctx.beginPath(); ctx.rect(pad, pad, side - pad * 2, side - pad * 2); ctx.clip();
    const m = bigMapImageAffine({ scale, cx, cy, wx0: bake.wx0, wz0: bake.wz0, sxu: bake.sxu, szv: bake.szv });
    ctx.imageSmoothingEnabled = true;
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.drawImage(bake.canvas, 0, 0);
    ctx.drawImage(bake.terrainDetailCanvas, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    const proj = { scale, cx, cy };
    for (const p of getRemotes()) {
      if (!p?.p) continue;
      const { x, y } = worldToBigMap(p.p[0], p.p[2], proj);
      drawArrow(ctx, x, y, getFacing(p), 9, '#ffcc44');
    }
    const local = getLocal();
    if (local?.p) {
      const { x, y } = worldToBigMap(local.p[0], local.p[2], proj);
      drawArrow(ctx, x, y, getHeading(), 11, '#77c8a1');
    }
    ctx.restore();

    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.strokeRect(pad + 0.5, pad + 0.5, side - pad * 2 - 1, side - pad * 2 - 1);
    ctx.fillStyle = '#cfd6e0';
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText('N', cx, pad + 4);

    if (hoverOnMap) {
      ctx.save();
      ctx.beginPath(); ctx.rect(pad, pad, side - pad * 2, side - pad * 2); ctx.clip();
      ctx.strokeStyle = 'rgba(236,242,249,0.8)'; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(pad, hover.y + 0.5); ctx.lineTo(side - pad, hover.y + 0.5);
      ctx.moveTo(hover.x + 0.5, pad); ctx.lineTo(hover.x + 0.5, side - pad);
      ctx.stroke();
      ctx.restore();
      const label = `X ${Math.round(hoveredWorld.x)}  Z ${Math.round(hoveredWorld.z)}`;
      ctx.font = '12px ui-monospace, SFMono-Regular, Consolas, monospace';
      const labelW = ctx.measureText(label).width + 12;
      const labelX = clamp(hover.x + 12, pad + 4, side - pad - labelW - 4);
      const labelY = clamp(hover.y + 12, pad + 4, side - pad - 25);
      ctx.fillStyle = 'rgba(9,12,16,0.88)';
      ctx.fillRect(labelX, labelY, labelW, 21);
      ctx.strokeStyle = 'rgba(255,255,255,0.20)'; ctx.strokeRect(labelX + 0.5, labelY + 0.5, labelW - 1, 20);
      ctx.fillStyle = '#e7edf4'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(label, labelX + 6, labelY + 10.5);
    }
  }
  canvas.addEventListener('mousemove', (event) => {
    const rect = canvas.getBoundingClientRect();
    hover = {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
    draw();
  });
  canvas.addEventListener('mouseleave', () => { hover = null; draw(); });
  root.addEventListener('wheel', (event) => {
    if (!open) return;
    event.preventDefault();
    const nextZoom = clamp(zoom * (event.deltaY > 0 ? 1 / 1.15 : 1.15), MIN_ZOOM, MAX_ZOOM);
    if (nextZoom === zoom) return;
    zoom = nextZoom;
    draw();
  }, { passive: false });

  return {
    isOpen: () => open,
    close() { open = false; root.classList.remove('open'); },
    toggle() { open = !open; root.classList.toggle('open', open); if (open) draw(); },
    update() { if (open) draw(); },
  };
}
