// Node checks for the species atlas: the packer, the geometry merge, and the UV remap, run against
// real Stadium primitives rather than a synthetic stand-in.

import fs from 'node:fs';
import * as THREE from 'three';
import { parseGLB, readAccessor } from './stadium-glb.js';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import * as TSL from 'three/tsl';
import { packTiles, tileRect, mergeAtlasGeometry, groupKey, atlasMaterial } from './park-atlas.js';
import { buildMaterial } from './tsl-build-check.mjs';

let pass = 0, fail = 0;
const problems = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; }
  else { fail++; problems.push(`${name}${detail ? ' — ' + detail : ''}`); }
}

// ===================== the packer =====================

{
  const sizes = [{ w: 32, h: 32 }, { w: 64, h: 32 }, { w: 24, h: 40 }, { w: 4, h: 4 }, { w: 256, h: 256 }];
  const r = packTiles(sizes);
  check('a mixed set packs', !!r);
  check('the atlas is a power of two', (r.size & (r.size - 1)) === 0, `${r.size}`);
  check('every tile keeps its size', r.tiles.every((t, i) => t.w === sizes[i].w && t.h === sizes[i].h));
  check('and stays inside the sheet',
    r.tiles.every((t) => t.x >= 0 && t.y >= 0 && t.x + t.w <= r.size && t.y + t.h <= r.size));

  let overlaps = 0;
  for (let i = 0; i < r.tiles.length; i++) {
    for (let j = i + 1; j < r.tiles.length; j++) {
      const a = r.tiles[i], b = r.tiles[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlaps++;
    }
  }
  check('no two tiles overlap', overlaps === 0, `${overlaps} overlapping pairs`);

  const again = packTiles(sizes);
  check('packing is deterministic', JSON.stringify(again) === JSON.stringify(r));
  check('an oversized image is refused rather than silently clipped',
    packTiles([{ w: 4096, h: 4096 }], { maxSize: 1024 }) === null);
  check('an empty set is still a valid atlas', packTiles([])?.tiles.length === 0);
}

{
  const { size, tiles } = packTiles([{ w: 32, h: 32 }, { w: 32, h: 32 }]);
  const [u, v, du, dv] = tileRect(tiles[0], size);
  check('a tile rect is inside the sheet', u >= 0 && v >= 0 && u + du <= 1 && v + dv <= 1);
  check('and is inset, so linear filtering cannot reach the neighbour',
    du < 32 / size && dv < 32 / size, `${du.toFixed(5)} vs ${(32 / size).toFixed(5)}`);
}

// ===================== the merge, on real primitives =====================

const FILE = 'models/stadium/025_pikachu.glb';
check('the model under test exists', fs.existsSync(FILE), FILE);

if (fs.existsSync(FILE)) {
  const bytes = new Uint8Array(fs.readFileSync(FILE));
  const { json, bin } = parseGLB(bytes);
  const prims = json.meshes.flatMap((m) => m.primitives);
  check('the model really is split per material', prims.length > 4, `${prims.length} primitives`);

  const geoOf = (p) => {
    const g = new THREE.BufferGeometry();
    const put = (name, attr, size) => {
      const a = readAccessor(json, bin, p.attributes[attr]);
      g.setAttribute(name, new THREE.BufferAttribute(Float32Array.from(a), size));
    };
    put('position', 'POSITION', 3);
    put('normal', 'NORMAL', 3);
    put('uv', 'TEXCOORD_0', 2);
    put('skinIndex', 'JOINTS_0', 4);
    put('skinWeight', 'WEIGHTS_0', 4);
    g.setIndex(Array.from(readAccessor(json, bin, p.indices)));
    return g;
  };

  const parts = prims.map((p, i) => ({
    geometry: geoOf(p),
    tile: tileRect({ x: (i % 4) * 40 + 1, y: Math.floor(i / 4) * 40 + 1, w: 32, h: 32 }, 256),
  }));

  const merged = mergeAtlasGeometry(THREE, parts);
  const vTotal = parts.reduce((a, p) => a + p.geometry.attributes.position.count, 0);
  const iTotal = parts.reduce((a, p) => a + p.geometry.index.count, 0);

  check('every vertex survives the merge', merged.attributes.position.count === vTotal,
    `${merged.attributes.position.count} of ${vTotal}`);
  check('and every triangle', merged.index.count === iTotal, `${merged.index.count} of ${iTotal}`);
  check('the index width matches the vertex count',
    vTotal <= 65535 ? merged.index.array instanceof Uint16Array : merged.index.array instanceof Uint32Array);

  let outOfRange = 0;
  for (let i = 0; i < merged.index.count; i++) if (merged.index.getX(i) >= vTotal) outOfRange++;
  check('no index points past the end', outOfRange === 0, `${outOfRange}`);

  // Rebasing is the whole job: part N's indices must have moved up by the vertices before it.
  let vBase = 0, iBase = 0, wrongBase = 0;
  for (const p of parts) {
    for (let k = 0; k < p.geometry.index.count; k++) {
      if (merged.index.getX(iBase + k) !== p.geometry.index.getX(k) + vBase) wrongBase++;
    }
    iBase += p.geometry.index.count;
    vBase += p.geometry.attributes.position.count;
  }
  check('each part is rebased onto its own vertices', wrongBase === 0, `${wrongBase} wrong`);

  let movedVert = 0, lostWeight = 0, wrongTile = 0;
  vBase = 0;
  for (const p of parts) {
    const n = p.geometry.attributes.position.count;
    for (let k = 0; k < n; k++) {
      for (let c = 0; c < 3; c++) {
        if (Math.abs(merged.attributes.position.getComponent(vBase + k, c) - p.geometry.attributes.position.getComponent(k, c)) > 1e-6) movedVert++;
      }
      for (let c = 0; c < 4; c++) {
        if (merged.attributes.skinWeight.getComponent(vBase + k, c) !== p.geometry.attributes.skinWeight.getComponent(k, c)) lostWeight++;
        if (merged.attributes.atlasTile.getComponent(vBase + k, c) !== p.tile[c]) wrongTile++;
      }
    }
    vBase += n;
  }
  check('no vertex moved', movedVert === 0, `${movedVert} components differ`);
  check('the skin binding is intact', lostWeight === 0, `${lostWeight} weights differ`);
  check('every vertex carries its own tile', wrongTile === 0, `${wrongTile} components wrong`);

  // The shader does tile.xy + clamp(uv, 0, 1) * tile.zw. A quarter of these UVs run outside 0..1,
  // which is legal because every source sampler is CLAMP_TO_EDGE — so the clamp belongs in the shader,
  // not baked into the vertices, or a triangle that stretched one edge texel now stretches the texture.
  let escaped = 0, outside = 0;
  const uvA = merged.attributes.uv, tileA = merged.attributes.atlasTile;
  for (let k = 0; k < uvA.count; k++) {
    const u = uvA.getX(k), v = uvA.getY(k);
    if (u < -1e-3 || u > 1 + 1e-3 || v < -1e-3 || v > 1 + 1e-3) outside++;
    const tx = tileA.getX(k), ty = tileA.getY(k), tw = tileA.getZ(k), th = tileA.getW(k);
    const au = tx + Math.min(1, Math.max(0, u)) * tw;
    const av = ty + Math.min(1, Math.max(0, v)) * th;
    if (au < tx - 1e-6 || au > tx + tw + 1e-6 || av < ty - 1e-6 || av > ty + th + 1e-6) escaped++;
  }
  check('this model does have UVs outside 0..1, so the clamp is load-bearing', outside > 0, `${outside} of ${uvA.count}`);
  check('and no remapped UV escapes its tile', escaped === 0, `${escaped} escaped`);

  console.log(`  ${FILE.split('/').pop()}: ${prims.length} primitives -> 1 geometry, ${vTotal} vertices, ${iTotal / 3} triangles, ${outside} UVs outside 0..1`);
}

// ===================== the shader =====================

{
  // A graph that does not compile is a black creature in the browser and nothing at all here.
  const atlas = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  atlas.needsUpdate = true;
  const geometry = mergeAtlasGeometry(THREE, [{
    geometry: (() => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(9), 3));
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(6), 2));
      g.setAttribute('skinIndex', new THREE.BufferAttribute(new Float32Array(12), 4));
      g.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array(12), 4));
      g.setIndex([0, 1, 2]);
      return g;
    })(),
    tile: [0.1, 0.1, 0.4, 0.4],
  }]);

  for (const transparent of [false, true]) {
    const mat = atlasMaterial({ TSL, MeshStandardNodeMaterial, atlas, side: THREE.DoubleSide, transparent });
    let built = null, err = null;
    try { built = await buildMaterial(mat, geometry); } catch (e) { err = e; }
    check(`the atlas material compiles (${transparent ? 'blend' : 'mask'})`, !!built,
      err ? String(err.message).slice(0, 200) : '');
    if (built) {
      check(`and reads the per-vertex tile (${transparent ? 'blend' : 'mask'})`,
        /atlasTile/.test(built.vertex), 'the attribute must reach the vertex stage');
      check(`and the clamp survived into the fragment shader (${transparent ? 'blend' : 'mask'})`,
        /clamp/.test(built.fragment), 'without it a quarter of the faces sample the neighbouring tile');
      check(`and the lighting path survived (${transparent ? 'blend' : 'mask'})`,
        /diffuse|irradiance|reflectedLight/i.test(built.fragment));
    }
  }
}

// ===================== grouping =====================

{
  const front = { side: 0, transparent: false };
  const back = { side: 2, transparent: false };
  const blend = { side: 0, transparent: true };
  check('sidedness splits a group', groupKey(front) !== groupKey(back));
  check('blending splits a group', groupKey(front) !== groupKey(blend));
  check('and matching materials share one', groupKey(front) === groupKey({ side: 0, transparent: false }));
}

// ===================== the whole library =====================

{
  const dir = 'models/stadium';
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.glb'));
  let worst = 0, worstFile = '', unpackable = 0, prims = 0, groups = 0;
  for (const f of files) {
    const { json, bin } = parseGLB(new Uint8Array(fs.readFileSync(`${dir}/${f}`)));
    const sizes = [];
    for (const im of json.images || []) {
      const bv = json.bufferViews[im.bufferView];
      const head = bin.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + 40);
      if (!(head[0] === 0x89 && head[1] === 0x50)) continue;
      const dv = new DataView(head.buffer, head.byteOffset);
      sizes.push({ w: dv.getUint32(16), h: dv.getUint32(20) });
    }
    const packed = packTiles(sizes);
    if (!packed) { unpackable++; continue; }
    if (packed.size > worst) { worst = packed.size; worstFile = f; }
    prims += json.meshes.reduce((a, m) => a + m.primitives.length, 0);
    groups += new Set((json.materials || []).map((m) => `${!!m.doubleSided}|${m.alphaMode || 'OPAQUE'}`)).size;
  }
  check('every species packs into an atlas', unpackable === 0, `${unpackable} models do not fit`);
  check('and none needs a sheet over 1024', worst <= 1024, `${worst} for ${worstFile}`);
  console.log(`  ${files.length} models: ${prims} primitives -> at most ${groups} draws (${(prims / groups).toFixed(1)}x fewer), largest atlas ${worst}px (${worstFile})`);
}

console.log(`\npark atlas: ${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('\nPROBLEMS:');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
