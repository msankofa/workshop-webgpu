// tree-textures.js
// Texture-source layer for the forest viewer. One entry point, two modes that
// return the SAME "texture set" shape so the viewer stays mode-agnostic:
//
//   createTextureSource('authored',   { onReady })  // load the ez-tree packs
//   createTextureSource('procedural', { onReady })  // synthesize at runtime
//
// A texture set:
//   {
//     mode, ready,                 // ready flips true once every map has decoded
//     leafMap, leafAtlas:{cols,rows}, leafAlphaTest,
//     barkMap, barkNormalMap, barkVScale,
//     dispose()
//   }
//
// Leaves are packed into a single 2x2 atlas (one shared map for the merged leaf
// mesh); the viewer pins each species to a cell. Bark is one set for the whole
// merged branch mesh. Authored loads are async: createTextureSource returns
// immediately with ready=false and calls onReady() when the last map decodes.

import * as THREE from 'three';

// Cell order in the 2x2 leaf atlas: cell index -> source file (authored mode).
// The viewer maps speciesIndex % 4 -> this cell.
export const LEAF_FILES = ['oak', 'aspen', 'ash', 'pine'];   // cells 0,1,2,3
export const LEAF_ATLAS = { cols: 2, rows: 2 };
const TEX_DIR = './textures';
const BARK_SET = 'Bark014_1K-JPG';   // a brown, fairly tileable bark
const BARK_VSCALE = 0.35;            // how fast bark repeats up the branch length

// ---- shared helpers ----------------------------------------------------------
function colorTex(tex) { tex.colorSpace = THREE.SRGBColorSpace; return tex; }
function repeatTex(tex) { tex.wrapS = tex.wrapT = THREE.RepeatWrapping; return tex; }

// ============================================================================
//  AUTHORED — load the real ez-tree texture packs from ./textures/
// ============================================================================
function authoredSet(onReady) {
  const cell = 512, cols = LEAF_ATLAS.cols, rows = LEAF_ATLAS.rows;
  const canvas = document.createElement('canvas');
  canvas.width = cols * cell; canvas.height = rows * cell;
  const ctx = canvas.getContext('2d');
  const leafMap = colorTex(new THREE.CanvasTexture(canvas));
  leafMap.anisotropy = 4;

  const loader = new THREE.TextureLoader();
  const barkMap = repeatTex(colorTex(loader.load(`${TEX_DIR}/bark/${BARK_SET}/${BARK_SET}_Color.jpg`, decoded)));
  const barkNormalMap = repeatTex(loader.load(`${TEX_DIR}/bark/${BARK_SET}/${BARK_SET}_NormalGL.jpg`, decoded));

  const set = {
    mode: 'authored', ready: false,
    leafMap, leafAtlas: { ...LEAF_ATLAS }, leafAlphaTest: 0.5,
    barkMap, barkNormalMap, barkVScale: BARK_VSCALE,
    dispose() { for (const t of [leafMap, barkMap, barkNormalMap]) t && t.dispose(); },
  };

  // 2 bark textures + 4 leaf images must all arrive before we report ready.
  let pending = 2 + LEAF_FILES.length;
  function decoded() { if (--pending === 0) finish(); }
  function finish() { set.ready = true; if (onReady) onReady(set); }

  // draw each leaf PNG into its atlas cell as it loads
  LEAF_FILES.forEach((name, i) => {
    const img = new Image();
    img.onload = () => {
      const cx = i % cols, cy = Math.floor(i / cols);
      ctx.clearRect(cx * cell, cy * cell, cell, cell);
      ctx.drawImage(img, cx * cell, cy * cell, cell, cell);
      leafMap.needsUpdate = true;
      decoded();
    };
    img.onerror = decoded;   // a missing leaf shouldn't deadlock readiness
    img.src = `${TEX_DIR}/leaves/${name}.png`;
  });

  return set;
}

// ============================================================================
//  PROCEDURAL — synthesize CanvasTextures at runtime (no assets needed)
// ============================================================================
function proceduralSet() {
  return {
    mode: 'procedural', ready: true,
    leafMap: colorTex(makeLeafAtlas()), leafAtlas: { ...LEAF_ATLAS }, leafAlphaTest: 0.45,
    barkMap: repeatTex(colorTex(makeBarkColor())), barkNormalMap: repeatTex(makeBarkNormal()),
    barkVScale: BARK_VSCALE,
    dispose() { for (const t of [this.leafMap, this.barkMap, this.barkNormalMap]) t && t.dispose(); },
  };
}

// a 2x2 atlas of white leaf silhouettes (alpha-masked); per-species tint colours
// them at render time, so the texture itself stays near-white with only a midrib
// and edge shading for form.
function makeLeafAtlas() {
  const cell = 256, cols = LEAF_ATLAS.cols, rows = LEAF_ATLAS.rows;
  const canvas = document.createElement('canvas');
  canvas.width = cols * cell; canvas.height = rows * cell;
  const ctx = canvas.getContext('2d');
  for (let i = 0; i < cols * rows; i++) {
    const cx = (i % cols) * cell, cy = Math.floor(i / cols) * cell;
    drawLeaf(ctx, cx, cy, cell, i);
  }
  return new THREE.CanvasTexture(canvas);
}

// one leaf: a teardrop pointing up, white fill with a faint midrib + rim shade.
// `variant` nudges width/lobing so the four cells aren't identical.
function drawLeaf(ctx, ox, oy, s, variant) {
  const cxp = ox + s / 2;
  const wide = 0.30 + 0.07 * ((variant % 2) ? 1 : -1);   // half-width fraction
  const tipY = oy + s * 0.06, baseY = oy + s * 0.96, midY = oy + s * 0.5;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(cxp, tipY);
  ctx.bezierCurveTo(cxp + s * wide, oy + s * 0.18, cxp + s * wide, midY + s * 0.18, cxp, baseY);
  ctx.bezierCurveTo(cxp - s * wide, midY + s * 0.18, cxp - s * wide, oy + s * 0.18, cxp, tipY);
  ctx.closePath();
  // soft fill so the rim is slightly darker than the centre (reads as curvature)
  const g = ctx.createRadialGradient(cxp, midY, s * 0.05, cxp, midY, s * 0.5);
  g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#cfd8c8');
  ctx.fillStyle = g; ctx.fill();
  // midrib
  ctx.strokeStyle = 'rgba(120,140,110,0.6)'; ctx.lineWidth = Math.max(1, s * 0.012);
  ctx.beginPath(); ctx.moveTo(cxp, tipY + s * 0.04); ctx.lineTo(cxp, baseY - s * 0.04); ctx.stroke();
  // a few veins
  ctx.lineWidth = Math.max(1, s * 0.006);
  for (let k = 1; k <= 3; k++) {
    const vy = tipY + (baseY - tipY) * (k / 4);
    ctx.beginPath(); ctx.moveTo(cxp, vy);
    ctx.lineTo(cxp + s * wide * 0.7, vy + s * 0.06); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cxp, vy);
    ctx.lineTo(cxp - s * wide * 0.7, vy + s * 0.06); ctx.stroke();
  }
  ctx.restore();
}

// value-noise so procedural bark has coherent vertical fibres, not white noise
function barkNoise(x, y) {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}
function fbmVert(x, y) {
  // stretch along y so streaks run up the trunk
  let v = 0, amp = 0.5, fx = x, fy = y * 0.25;
  for (let o = 0; o < 4; o++) {
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const a = barkNoise(ix, iy), b = barkNoise(ix + 1, iy), c = barkNoise(ix, iy + 1), d = barkNoise(ix + 1, iy + 1);
    const u = tx * tx * (3 - 2 * tx), w = ty * ty * (3 - 2 * ty);
    v += amp * ((a * (1 - u) + b * u) * (1 - w) + (c * (1 - u) + d * u) * w);
    fx *= 2; fy *= 2; amp *= 0.5;
  }
  return v;
}

// procedural bark colour: grayscale fibres so the per-tree brown vertex tint
// multiplies into believable bark with vertical grain.
function makeBarkColor() {
  const S = 256;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const n = fbmVert(x * 0.10, y * 0.10);
    const ridges = 0.5 + 0.5 * Math.sin((x * 0.18) + n * 6.0);   // bark plates
    const l = 90 + ridges * 110 + (n - 0.5) * 50;
    const i = (y * S + x) * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.max(40, Math.min(235, l));
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(canvas);
}

// a matching tangent-space normal map from the same fibre field (finite-diff)
function makeBarkNormal() {
  const S = 256;
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(S, S);
  const H = (x, y) => {
    const n = fbmVert(x * 0.10, y * 0.10);
    return 0.5 + 0.5 * Math.sin((x * 0.18) + n * 6.0);
  };
  const strength = 2.0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = (H(x + 1, y) - H(x - 1, y)) * strength;
    const dy = (H(x, y + 1) - H(x, y - 1)) * strength;
    let nx = -dx, ny = -dy, nz = 1;
    const len = Math.hypot(nx, ny, nz) || 1; nx /= len; ny /= len; nz /= len;
    const i = (y * S + x) * 4;
    img.data[i]     = Math.round((nx * 0.5 + 0.5) * 255);
    img.data[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
    img.data[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);   // normal map stays linear (no sRGB)
  return tex;
}

// ============================================================================
export function createTextureSource(mode, { onReady } = {}) {
  return mode === 'authored' ? authoredSet(onReady) : proceduralSet();
}

export default createTextureSource;
