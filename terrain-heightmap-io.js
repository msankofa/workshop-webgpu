// Heightmap import/export helpers for terrain-generator-v5. The pure parts (pixel decode,
// quantize, raw16 pack, Terrarium decode, slippy-tile maths) are Node-testable; the
// browser-only parts (Image/canvas/fetch) are isolated at the bottom and never imported
// by tests.

import { clamp } from './terrain-noise.js';

// RGBA pixels (Uint8ClampedArray, w x h) -> normalized [0,1] Float32Array luminance grid.
export function decodeGrayscalePixels(pixels, width, height) {
  const out = new Float32Array(width * height);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < width * height; i++) {
    const v = (pixels[i * 4] * 0.299 + pixels[i * 4 + 1] * 0.587 + pixels[i * 4 + 2] * 0.114) / 255;
    out[i] = v; if (v < lo) lo = v; if (v > hi) hi = v;
  }
  const span = Math.max(hi - lo, 1e-6);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) / span;
  return { data: out, resolution: width, width, height, min: lo, max: hi };
}

// Resample any w x h grid onto a square res x res grid (bilinear).
export function resampleToSquare(data, width, height, res) {
  const out = new Float32Array(res * res);
  for (let iz = 0; iz < res; iz++) {
    const gz = (iz / Math.max(1, res - 1)) * (height - 1);
    const z0 = Math.min(height - 2, Math.floor(gz)), tz = gz - z0;
    for (let ix = 0; ix < res; ix++) {
      const gx = (ix / Math.max(1, res - 1)) * (width - 1);
      const x0 = Math.min(width - 2, Math.floor(gx)), tx = gx - x0;
      const a = data[z0 * width + x0], b = data[z0 * width + x0 + 1];
      const c = data[(z0 + 1) * width + x0], d = data[(z0 + 1) * width + x0 + 1];
      out[iz * res + ix] = a * (1 - tx) * (1 - tz) + b * tx * (1 - tz) + c * (1 - tx) * tz + d * tx * tz;
    }
  }
  return out;
}

// Heights (world units) -> { u8: Uint8Array gray, u16: Uint16Array, min, max }.
export function quantizeHeights(heights, minIn = null, maxIn = null) {
  let lo = minIn, hi = maxIn;
  if (lo === null || hi === null) {
    lo = Infinity; hi = -Infinity;
    for (const h of heights) { if (h < lo) lo = h; if (h > hi) hi = h; }
  }
  const span = Math.max(hi - lo, 1e-6);
  const u8 = new Uint8Array(heights.length), u16 = new Uint16Array(heights.length);
  for (let i = 0; i < heights.length; i++) {
    const t = clamp((heights[i] - lo) / span, 0, 1);
    u8[i] = Math.round(t * 255); u16[i] = Math.round(t * 65535);
  }
  return { u8, u16, min: lo, max: hi };
}

// Little-endian 16-bit raw (Unity/Unreal .raw/.r16 convention).
export function packRaw16(u16) {
  const buf = new ArrayBuffer(u16.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < u16.length; i++) view.setUint16(i * 2, u16[i], true);
  return buf;
}

// AWS Terrain Tiles "terrarium" encoding: metres = R*256 + G + B/256 - 32768.
export function terrariumToMetres(r, g, b) { return r * 256 + g + b / 256 - 32768; }

export const MERCATOR_LAT_MAX = 85.051;
export function lonToTileX(lon, z) { return ((lon + 180) / 360) * Math.pow(2, z); }
export function latToTileY(lat, z) {
  const rad = clamp(lat, -MERCATOR_LAT_MAX, MERCATOR_LAT_MAX) * Math.PI / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * Math.pow(2, z);
}
// Bounding box for a square patch `sizeKm` wide centred on lat/lon.
export function bboxAround(lat, lon, sizeKm) {
  const dLat = (sizeKm / 2) / 111.32;
  const dLon = (sizeKm / 2) / (111.32 * Math.cos(lat * Math.PI / 180));
  return { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon };
}
// Highest zoom whose tile span for the bbox stays within maxTilesPerAxis.
export function pickZoom(bbox, maxTilesPerAxis = 6, maxZoom = 14) {
  for (let z = maxZoom; z >= 1; z--) {
    const nx = Math.ceil(lonToTileX(bbox.east, z)) - Math.floor(lonToTileX(bbox.west, z));
    const ny = Math.ceil(latToTileY(bbox.south, z)) - Math.floor(latToTileY(bbox.north, z));
    if (nx <= maxTilesPerAxis && ny <= maxTilesPerAxis) return z;
  }
  return 1;
}

export const CURATED_LOCATIONS = [
  { name: 'Grand Canyon, USA', lat: 36.10, lon: -112.11, sizeKm: 30 },
  { name: 'Matterhorn, Switzerland', lat: 45.976, lon: 7.658, sizeKm: 20 },
  { name: 'Mount Fuji, Japan', lat: 35.36, lon: 138.73, sizeKm: 30 },
  { name: 'Yosemite Valley, USA', lat: 37.73, lon: -119.58, sizeKm: 25 },
  { name: 'Isle of Skye, Scotland', lat: 57.25, lon: -6.20, sizeKm: 30 },
  { name: 'Uluru, Australia', lat: -25.34, lon: 131.03, sizeKm: 15 },
  { name: 'Iceland highlands', lat: 64.05, lon: -18.90, sizeKm: 40 },
  { name: 'Torres del Paine, Chile', lat: -50.94, lon: -73.00, sizeKm: 30 },
];

// ---- browser-only helpers below (Image / canvas / fetch) ----

export async function imageFileToGrid(file, maxRes = 1024) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const im = new Image(); im.onload = () => resolve(im); im.onerror = () => reject(new Error('image failed to decode')); im.src = url;
    });
    const scale = Math.min(1, maxRes / Math.max(img.width, img.height));
    const w = Math.max(2, Math.round(img.width * scale)), h = Math.max(2, Math.round(img.height * scale));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const dec = decodeGrayscalePixels(px, w, h);
    const res = Math.max(w, h);
    return { data: resampleToSquare(dec.data, w, h, res), resolution: res, source: file.name };
  } finally { URL.revokeObjectURL(url); }
}

// Fetch a real-world patch from AWS Terrain Tiles into a normalized square grid.
// Returns { data, resolution, minM, maxM, source }. Throws if no tile could be fetched.
export async function fetchTerrariumGrid(lat, lon, sizeKm, { maxTilesPerAxis = 6, onProgress } = {}) {
  const bbox = bboxAround(lat, lon, sizeKm);
  const z = pickZoom(bbox, maxTilesPerAxis);
  const tx0 = Math.floor(lonToTileX(bbox.west, z)), tx1 = Math.floor(lonToTileX(bbox.east, z));
  const ty0 = Math.floor(latToTileY(bbox.north, z)), ty1 = Math.floor(latToTileY(bbox.south, z));
  const nx = tx1 - tx0 + 1, ny = ty1 - ty0 + 1;
  const canvas = document.createElement('canvas'); canvas.width = nx * 256; canvas.height = ny * 256;
  const ctx = canvas.getContext('2d');
  let ok = 0, total = nx * ny, done = 0;
  const jobs = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${tx}/${ty}.png`;
    jobs.push((async () => {
      try {
        const img = await new Promise((resolve, reject) => {
          const im = new Image(); im.crossOrigin = 'anonymous';
          im.onload = () => resolve(im); im.onerror = () => reject(new Error('tile failed')); im.src = url;
        });
        ctx.drawImage(img, (tx - tx0) * 256, (ty - ty0) * 256); ok++;
      } catch { /* missing tile stays black (sea level) */ }
      done++; onProgress?.(done, total);
    })());
  }
  await Promise.all(jobs);
  if (ok === 0) throw new Error('no elevation tiles could be fetched (offline or blocked)');
  // Crop to the exact bbox in fractional tile space.
  const px0 = (lonToTileX(bbox.west, z) - tx0) * 256, px1 = (lonToTileX(bbox.east, z) - tx0) * 256;
  const py0 = (latToTileY(bbox.north, z) - ty0) * 256, py1 = (latToTileY(bbox.south, z) - ty0) * 256;
  const cw = Math.max(2, Math.round(px1 - px0)), ch = Math.max(2, Math.round(py1 - py0));
  const px = ctx.getImageData(Math.round(px0), Math.round(py0), cw, ch).data;
  const metres = new Float32Array(cw * ch);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < cw * ch; i++) {
    const m = terrariumToMetres(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
    metres[i] = m; if (m < lo) lo = m; if (m > hi) hi = m;
  }
  const span = Math.max(hi - lo, 1e-6);
  for (let i = 0; i < metres.length; i++) metres[i] = (metres[i] - lo) / span;
  const res = Math.min(1024, Math.max(cw, ch));
  return { data: resampleToSquare(metres, cw, ch, res), resolution: res, minM: lo, maxM: hi, zoom: z, tiles: ok, source: `terrarium ${lat.toFixed(3)},${lon.toFixed(3)} ${sizeKm}km z${z}` };
}

export function heightsToPngBlob(u8, res) {
  const c = document.createElement('canvas'); c.width = res; c.height = res;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(res, res);
  for (let i = 0; i < u8.length; i++) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = u8[i]; img.data[i * 4 + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
}
