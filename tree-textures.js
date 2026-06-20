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
//  PROCEDURAL — textureless WebGPU path (no CanvasTexture uploads)
// ============================================================================
function proceduralSet() {
  return {
    mode: 'procedural', ready: true,
    leafMap: null, leafAtlas: { ...LEAF_ATLAS }, leafAlphaTest: 0,
    barkMap: null, barkNormalMap: null,
    barkVScale: BARK_VSCALE,
    dispose() {},
  };
}

// ============================================================================
export function createTextureSource(mode, { onReady } = {}) {
  return mode === 'authored' ? authoredSet(onReady) : proceduralSet();
}

export default createTextureSource;
