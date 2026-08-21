// The field and the bake behind `demos/sdf-pikachu.html`, in a module so Node can compile the TSL and
// check the boxes without a browser. See the page's header comment for what the spike is for.
//
// The idea in one line: every vertex in a Stadium model belongs to exactly one bone at full weight, so the
// SKIN falls apart into rigid chunks, and each chunk becomes one oriented round box the ray can march.

import * as THREE from 'three';
import {
  Fn, Loop, Break, If, uniform, uniformArray, uv, vec2, vec3, vec4, float, int,
  normalize, dot, length, min, max, abs, clamp, mix, pow, exp, select, texture3D,
} from 'three/tsl';
import { nodeWorldMatrices, readAccessor } from '../stadium-glb.js';
import { boneGeometry } from '../stadium-rig-map.js';
import { fitRoundBox } from '../foot-sdf.js';
import {
  skinnedTriangles, normaliseTriangles, trianglesByBone, insideField, bakeTile, tileExtent, toHalf,
} from './sdf-mesh-bake.js';

export const MAX_BONES = 96;
export const MAX_SHRINK = 1.1;    // the box-size slider's ceiling, and what the skip sphere is sized for
export const STRIDE = 7;          // centre+span, 3 axes+half, colour+radius, tile slot, tile extents
export const MARCH_STEPS = 110;
export const MAX_T = 12.0;
export const HIT_EPS = 0.0012;

// The exact tier: one cube of distances per bone, tiled into a single 3-D texture.
export const TILE_RES = 24;
export const TILE_PAD = 0.03;     // how far past the fitted box a tile reaches, in model heights
export const SIGN_RES = 128;      // the inside/outside grid the tiles take their sign from
export const MAX_THICKEN = 0.02;  // the skin-thickness slider's ceiling, and what the skip sphere allows
export const ATLAS_NX = 12;
export const ATLAS_NY = 8;
export const ATLAS_W = ATLAS_NX * TILE_RES;
export const ATLAS_H = ATLAS_NY * TILE_RES;
export const ATLAS_D = TILE_RES;

// ---------------------------------------------------------------------------
// Bake
// ---------------------------------------------------------------------------

/** Mean base colour of each bone's own vertices, looked up through their UVs. Needs decoded images. */
export function boneColours(json, bin, images) {
  const acc = new Map();
  const imageOfMaterial = (mi) => {
    const tex = json.materials?.[mi]?.pbrMetallicRoughness?.baseColorTexture?.index;
    if (tex == null) return null;
    return images?.[json.textures?.[tex]?.source] ?? null;
  };
  for (const node of json.nodes || []) {
    if (node.mesh == null || node.skin == null) continue;
    const joints = json.skins[node.skin].joints;
    for (const prim of json.meshes[node.mesh].primitives || []) {
      const a = prim.attributes;
      if (a.JOINTS_0 == null || a.WEIGHTS_0 == null) continue;
      const jnt = readAccessor(json, bin, a.JOINTS_0);
      const wgt = readAccessor(json, bin, a.WEIGHTS_0);
      const uvs = a.TEXCOORD_0 != null ? readAccessor(json, bin, a.TEXCOORD_0) : null;
      const img = imageOfMaterial(prim.material);
      const n = jnt.length / 4;
      for (let i = 0; i < n; i++) {
        let best = 0;
        for (let k = 1; k < 4; k++) if (wgt[i * 4 + k] > wgt[i * 4 + best]) best = k;
        const leaf = joints[jnt[i * 4 + best]];
        let e = acc.get(leaf);
        if (!e) acc.set(leaf, e = { r: 0, g: 0, b: 0, n: 0 });
        if (!img || !uvs) continue;
        // Wrapped, because these UVs run outside 0..1 on the tiled parts.
        const wrap = (v) => { const f = v - Math.floor(v); return f < 0 ? f + 1 : f; };
        const px = Math.min(img.width - 1, Math.floor(wrap(uvs[i * 2]) * img.width));
        const py = Math.min(img.height - 1, Math.floor(wrap(uvs[i * 2 + 1]) * img.height));
        const o = (py * img.width + px) * 4;
        if (img.data[o + 3] < 8) continue;
        e.r += img.data[o]; e.g += img.data[o + 1]; e.b += img.data[o + 2]; e.n++;
      }
    }
  }
  const out = new Map();
  for (const [leaf, e] of acc) {
    const srgb = (v) => Math.pow(v / 255, 2.2);
    out.set(leaf, e.n ? [srgb(e.r / e.n), srgb(e.g / e.n), srgb(e.b / e.n)] : [0.55, 0.55, 0.55]);
  }
  return out;
}

/**
 * One round box per bone, in a frame with the model one unit tall standing on y = 0.
 *
 * Normalised here rather than in the shader so every knob on the panel is in the same units whichever
 * species is loaded — these models differ in scale by more than 3x.
 */
export function bake(json, bin, images = null) {
  const ctx = nodeWorldMatrices(json);
  const geo = boneGeometry(json, bin, ctx);
  const cols = boneColours(json, bin, images);

  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const [, g] of geo) for (let i = 0; i < g.count; i++) for (let a = 0; a < 3; a++) {
    const v = g.points[i * 3 + a];
    if (v < lo[a]) lo[a] = v;
    if (v > hi[a]) hi[a] = v;
  }
  const height = Math.max(1e-6, hi[1] - lo[1]);
  const scale = 1 / height;
  const mid = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2];

  const bones = [];
  for (const [pivot, g] of geo) {
    if (!g || g.count < 3) continue;
    const pts = new Float64Array(g.count * 3);
    for (let i = 0; i < g.count; i++) for (let a = 0; a < 3; a++) {
      pts[i * 3 + a] = (g.points[i * 3 + a] - mid[a]) * scale;
    }
    let span = 0;
    for (let a = 0; a < 3; a++) {
      let l = Infinity, h = -Infinity;
      for (let i = 0; i < g.count; i++) { const v = pts[i * 3 + a]; if (v < l) l = v; if (v > h) h = v; }
      span = Math.max(span, h - l);
    }
    const box = fitRoundBox(pts, g.count, { radius: 0 });
    // Sized to the BOX, not to the vertices. The march skips a bone when this sphere cannot beat the
    // running minimum, and a box corner reaches past the furthest vertex it was fitted to — so a
    // vertex-radius sphere is not a lower bound on the box, and the skip would carve holes in the model.
    let sphere = Math.hypot(box.half[0], box.half[1], box.half[2]) * MAX_SHRINK;
    // Big enough for the volume tile too, which is that same box grown by the tile's pad.
    sphere = Math.max(sphere, Math.hypot(
      box.half[0] + TILE_PAD, box.half[1] + TILE_PAD, box.half[2] + TILE_PAD));
    for (let i = 0; i < g.count; i++) {
      sphere = Math.max(sphere, Math.hypot(
        pts[i * 3] - box.center[0], pts[i * 3 + 1] - box.center[1], pts[i * 3 + 2] - box.center[2]));
    }
    bones.push({ pivot, box, span, sphere, colour: cols.get(g.leaf) ?? [0.6, 0.6, 0.6], verts: g.count });
  }
  // Biggest first, so the slot cap drops the least of the creature if a model ever exceeds it.
  bones.sort((a, b) => b.verts - a.verts);
  return {
    bones: bones.slice(0, MAX_BONES),
    dropped: Math.max(0, bones.length - MAX_BONES),
    height, scale, mid,
  };
}

/**
 * The same bake, plus the mesh itself converted: a cube of signed distances per bone.
 *
 * The boxes are still produced, because the tile lives in a box's frame and the march still uses the box's
 * bounding sphere to skip. What changes is what the shader asks for the distance — a fitted shape, or the
 * measured distance to the triangles.
 */
export function bakeVolume(json, bin, images = null, { res = TILE_RES, signRes = SIGN_RES } = {}) {
  const baked = bake(json, bin, images);
  const ctx = nodeWorldMatrices(json);
  const tris = normaliseTriangles(skinnedTriangles(json, bin, ctx), baked.mid, baked.scale);
  const byBone = trianglesByBone(tris);

  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.count * 3; i++) for (let a = 0; a < 3; a++) {
    const v = tris.xyz[i * 3 + a];
    if (v < lo[a]) lo[a] = v;
    if (v > hi[a]) hi[a] = v;
  }
  // A margin, so the outermost skin never lands on the very edge cell of the sign grid.
  for (let a = 0; a < 3; a++) { lo[a] -= 0.02; hi[a] += 0.02; }
  const inside = insideField(tris, lo, hi, signRes);

  const atlas = new Uint16Array(ATLAS_NX * res * ATLAS_NY * res * res);
  atlas.fill(toHalf(4.0));
  const tint = images ? new Uint8Array(atlas.length * 4) : null;

  let empty = 0;
  for (let b = 0; b < baked.bones.length; b++) {
    const bone = baked.bones[b];
    const triIdx = byBone.get(bone.pivot);
    const half = triIdx?.length
      ? tileExtent(tris, triIdx, bone.box, TILE_PAD)
      : bone.box.half.map((h) => h + TILE_PAD);
    bone.tile = {
      col: b % ATLAS_NX, row: Math.floor(b / ATLAS_NX), tris: triIdx ? triIdx.length : 0, half,
    };
    // The skip sphere now has to clear the tile, which is wider than the box wherever a seam pokes out,
    // and the thickness slider, which moves the surface outward by up to its ceiling.
    bone.sphere = Math.max(bone.sphere, Math.hypot(half[0], half[1], half[2])) + MAX_THICKEN;
    if (!triIdx || !triIdx.length) { empty++; continue; }
    const cube = bakeTile(tris, triIdx, bone.box, { res, half, inside, images });
    const ox = bone.tile.col * res, oy = bone.tile.row * res;
    for (let k = 0; k < res; k++) for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      const from = (k * res + j) * res + i;
      const to = (k * (ATLAS_NY * res) + (oy + j)) * (ATLAS_NX * res) + (ox + i);
      atlas[to] = toHalf(cube.dist[from]);
      if (!tint || !cube.rgb) continue;
      // A voxel with no reading keeps the bone's averaged colour, so a missing texture degrades rather
      // than turning that chunk black.
      const fallback = cube.rgb[from * 4 + 3] === 0;
      for (let a = 0; a < 3; a++) {
        tint[to * 4 + a] = fallback
          ? Math.round(Math.min(1, bone.colour[a]) * 255)
          : cube.rgb[from * 4 + a];
      }
      tint[to * 4 + 3] = 255;
    }
  }

  return { ...baked, tiles: { data: atlas, rgb: tint, res }, tris, inside, emptyTiles: empty };
}

// ---------------------------------------------------------------------------
// Field
// ---------------------------------------------------------------------------

export function createField() {
  const u = {
    boneCount: uniform(1, 'int'),
    ro: uniform(new THREE.Vector3(0, 0.5, 2.6)),
    fwd: uniform(new THREE.Vector3(0, 0, -1)),
    right: uniform(new THREE.Vector3(1, 0, 0)),
    up: uniform(new THREE.Vector3(0, 1, 0)),
    tanHalf: uniform(0.45),
    aspect: uniform(1),
    // Zero, and the page keeps it there for the volume. Measured on Pikachu, a blend of 0.05 — 5% of body
    // height on a model normalised to 1 — puts the surface 1.31% off the mesh against 0.13% at zero. It is
    // there to close seams a rotated bone tears open, and nothing on this page rotates a bone.
    blend: uniform(0),
    round: uniform(0.05),
    shrink: uniform(1),
    colourOn: uniform(1),
    hullR: uniform(1.2),
    hullY: uniform(0.5),
    volume: uniform(0),
    // Measured: 0.006 costs 0.65% on its own, five times the base error. Just enough for a thin fin.
    thicken: uniform(0.002),
  };

  const boneData = uniformArray(
    Array.from({ length: MAX_BONES * STRIDE }, () => new THREE.Vector4()), 'vec4');

  // Every bone's distance cube in one 3-D texture, tiled across x and y. Half floats, so it filters.
  const atlasTex = new THREE.Data3DTexture(
    new Uint16Array(ATLAS_W * ATLAS_H * ATLAS_D).fill(0x4400), ATLAS_W, ATLAS_H, ATLAS_D);
  atlasTex.format = THREE.RedFormat;
  atlasTex.type = THREE.HalfFloatType;
  // And the colour, in the same grid at the same coordinate: the marking a voxel sits under, in linear
  // bytes. Sampling it costs one more fetch at the hit instead of a per-pixel search through 176 triangles.
  const tintTex = new THREE.Data3DTexture(
    new Uint8Array(ATLAS_W * ATLAS_H * ATLAS_D * 4).fill(140), ATLAS_W, ATLAS_H, ATLAS_D);
  tintTex.format = THREE.RGBAFormat;
  tintTex.type = THREE.UnsignedByteType;
  for (const t of [atlasTex, tintTex]) {
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
    t.colorSpace = THREE.NoColorSpace;
    t.needsUpdate = true;
  }

  /** Exact signed distance to one bone's oriented round box. */
  const sdBoneBox = Fn(([p, base]) => {
    const c = boneData.element(base);
    const a0 = boneData.element(base.add(int(1)));
    const a1 = boneData.element(base.add(int(2)));
    const a2 = boneData.element(base.add(int(3)));
    const d = p.sub(c.xyz);
    const rr = c.w.mul(u.round).add(float(0.0004));
    // Clamped to what the skip sphere was sized for, so a slider cannot outgrow its own bound.
    const h = max(vec3(a0.w, a1.w, a2.w).mul(min(u.shrink, float(MAX_SHRINK))).sub(rr), vec3(0.0));
    const q = vec3(abs(dot(d, a0.xyz)), abs(dot(d, a1.xyz)), abs(dot(d, a2.xyz))).sub(h);
    return length(max(q, vec3(0.0))).add(min(max(q.x, max(q.y, q.z)), float(0.0))).sub(rr);
  });

  /** Where a point lands in the atlas, inside its own bone's tile. Both volumes share this coordinate. */
  const tileUVW = Fn(([p, base]) => {
    const c = boneData.element(base);
    const a0 = boneData.element(base.add(int(1)));
    const a1 = boneData.element(base.add(int(2)));
    const a2 = boneData.element(base.add(int(3)));
    const slot = boneData.element(base.add(int(5)));
    const h = boneData.element(base.add(int(6))).xyz;
    const d = p.sub(c.xyz);
    const q = vec3(dot(d, a0.xyz), dot(d, a1.xyz), dot(d, a2.xyz));
    // Corner voxels sit exactly on the tile's faces, so 0..1 maps onto texel 0.5 .. res-0.5.
    const local = clamp(q.div(h).mul(0.5).add(0.5), 0.0, 1.0).mul(float(TILE_RES - 1)).add(0.5);
    return vec3(
      slot.x.mul(float(TILE_RES)).add(local.x).div(float(ATLAS_W)),
      slot.y.mul(float(TILE_RES)).add(local.y).div(float(ATLAS_H)),
      local.z.div(float(ATLAS_D)),
    );
  });

  /**
   * Distance read straight out of the bone's baked cube — the mesh itself, not a shape standing in for it.
   *
   * Past the tile the texture has nothing to say, and the answer there is analytic: a point that far outside
   * the tile box cannot be nearer the skin than that distance plus the tile's pad, because every triangle of
   * the chunk lies inside the box the tile was grown from.
   */
  const sdBoneVol = Fn(([p, base]) => {
    const c = boneData.element(base);
    const a0 = boneData.element(base.add(int(1)));
    const a1 = boneData.element(base.add(int(2)));
    const a2 = boneData.element(base.add(int(3)));
    const slot = boneData.element(base.add(int(5)));
    const h = boneData.element(base.add(int(6))).xyz;
    const d = p.sub(c.xyz);
    const q = vec3(dot(d, a0.xyz), dot(d, a1.xyz), dot(d, a2.xyz));
    const e = abs(q).sub(h);
    const outer = length(max(e, vec3(0.0))).add(min(max(e.x, max(e.y, e.z)), float(0.0)));
    const sampled = texture3D(atlasTex, tileUVW(p, base)).level(0).r;
    // Thickened, because a wing or a fin thinner than one voxel has no interior for the sign grid to find,
    // and would march as a field that never quite reaches zero. This pushes the whole surface out instead.
    return select(outer.greaterThan(float(0.0)), outer.add(slot.z), sampled)
      .sub(min(u.thicken, float(MAX_THICKEN)));
  });

  const sdBone = Fn(([p, base]) => {
    const out = float(0).toVar('boneDist');
    If(u.volume.greaterThan(0.5), () => { out.assign(sdBoneVol(p, base)); })
      .Else(() => { out.assign(sdBoneBox(p, base)); });
    return out;
  });

  /** The marking a point sits under, from the colour volume — or the bone's average, with no volume. */
  const boneTint = Fn(([p, base]) => {
    const out = vec3(0.6).toVar('boneTint');
    If(u.volume.greaterThan(0.5), () => {
      out.assign(texture3D(tintTex, tileUVW(p, base)).level(0).xyz);
    }).Else(() => { out.assign(boneData.element(base.add(int(4))).xyz); });
    return out;
  });

  /** Smooth union — the blend that closes a rigid-skinned joint. */
  const smin = Fn(([a, b, k]) => {
    const h = clamp(float(0.5).add(float(0.5).mul(b.sub(a)).div(k)), 0.0, 1.0);
    return mix(b, a, h).sub(k.mul(h).mul(float(1.0).sub(h)));
  });

  /** The same union, carrying colour. */
  const sminCol = Fn(([a, b, k]) => {
    const h = clamp(float(0.5).add(float(0.5).mul(b.x.sub(a.x)).div(k)), 0.0, 1.0);
    const d = mix(b.x, a.x, h).sub(k.mul(h).mul(float(1.0).sub(h)));
    return vec4(d, mix(b.yzw, a.yzw, h));
  });

  /**
   * Distance alone — what the march and the normal need.
   *
   * Split from the colour deliberately: the march runs this up to 110 times per pixel, and carrying the
   * tint through it would fetch the colour volume on every one of those steps to use exactly one of them.
   */
  const map = Fn(([p]) => {
    const res = float(MAX_T).toVar();
    const k = max(u.blend, float(0.0002));
    Loop(u.boneCount, ({ i }) => {
      // Named var, or the march loop's own counter shadows this one and every step reads the wrong bone.
      const bi = i.toVar('boneIndex');
      const base = bi.mul(int(STRIDE));
      const c = boneData.element(base);
      const col = boneData.element(base.add(int(4)));
      // The bone's bounding sphere is a lower bound on its field, so a bone that cannot win is skipped.
      const lower = length(p.sub(c.xyz)).sub(col.w);
      If(lower.lessThan(res), () => { res.assign(smin(res, sdBone(p, base), k)); });
    });
    return res;
  });

  /** Distance and colour together, evaluated once at the hit. */
  const shade = Fn(([p]) => {
    const res = vec4(float(MAX_T), vec3(0.6)).toVar();
    const k = max(u.blend, float(0.0002));
    Loop(u.boneCount, ({ i }) => {
      const bi = i.toVar('shadeIndex');
      const base = bi.mul(int(STRIDE));
      const c = boneData.element(base);
      const col = boneData.element(base.add(int(4)));
      const lower = length(p.sub(c.xyz)).sub(col.w);
      If(lower.lessThan(res.x), () => {
        const tint = mix(vec3(0.62), boneTint(p, base), u.colourOn);
        res.assign(sminCol(res, vec4(sdBone(p, base), tint), k));
      });
    });
    return res;
  });

  const calcNormal = Fn(([p]) => {
    const e = float(0.0016);
    const dx = map(p.add(vec3(e, 0, 0))).sub(map(p.sub(vec3(e, 0, 0))));
    const dy = map(p.add(vec3(0, e, 0))).sub(map(p.sub(vec3(0, e, 0))));
    const dz = map(p.add(vec3(0, 0, e))).sub(map(p.sub(vec3(0, 0, e))));
    return normalize(vec3(dx, dy, dz));
  });

  /** Where a ray crosses the model's own bounding sphere, so an empty pixel costs nothing. */
  const hullSpan = Fn(([ro, rd]) => {
    const oc = ro.sub(vec3(0, u.hullY, 0));
    const b = dot(oc, rd);
    const c = dot(oc, oc).sub(u.hullR.mul(u.hullR));
    const disc = b.mul(b).sub(c);
    const s = max(disc, float(0.0)).sqrt();
    return vec3(disc, b.negate().sub(s), b.negate().add(s));
  });

  const scenePass = Fn(() => {
    const p = uv().sub(0.5).mul(2.0);
    const rd = normalize(u.fwd
      .add(u.right.mul(p.x.mul(u.aspect).mul(u.tanHalf)))
      .add(u.up.mul(p.y.mul(u.tanHalf))));
    const ro = u.ro;

    const sky = mix(vec3(0.045, 0.055, 0.070), vec3(0.10, 0.115, 0.135), uv().y.mul(0.9).add(0.1));
    const col = sky.toVar();
    const hitAny = float(0).toVar();

    const span = hullSpan(ro, rd);
    If(span.x.greaterThan(0.0).and(span.z.greaterThan(0.0)), () => {
      const t = max(span.y, float(0.001)).toVar();
      const tEnd = min(span.z, float(MAX_T));
      Loop(MARCH_STEPS, () => {
        If(t.greaterThan(tEnd), () => { Break(); });
        const r = map(ro.add(rd.mul(t)));
        If(r.lessThan(float(HIT_EPS).mul(t).add(float(0.0006))), () => {
          hitAny.assign(1.0);
          Break();
        });
        // Under-relaxed, because a smooth union is not a true distance and a full step overshoots it.
        t.addAssign(max(r.mul(0.85), float(0.0006)));
      });

      If(hitAny.greaterThan(0.5), () => {
        const pos = ro.add(rd.mul(t));
        const albedo = shade(pos).yzw;
        const n = calcNormal(pos);
        const key = normalize(vec3(0.55, 0.8, 0.35));
        const fill = normalize(vec3(-0.6, 0.25, -0.4));
        const lam = max(dot(n, key), float(0.0));
        const bounce = max(dot(n, fill), float(0.0)).mul(0.28);
        const skyLight = max(n.y, float(0.0)).mul(0.22);
        const rim = pow(clamp(float(1.0).add(dot(n, rd)), 0.0, 1.0), float(2.4)).mul(0.5);
        col.assign(albedo.mul(lam.mul(1.05).add(bounce).add(skyLight).add(0.12))
          .add(vec3(0.35, 0.45, 0.6).mul(rim)));
      });
    });

    // A soft contact shadow on the floor, only where the creature was not hit.
    const denom = select(abs(rd.y).lessThan(float(1e-4)), float(1e-4), rd.y);
    const tg = float(-0.02).sub(ro.y).div(denom);
    If(tg.greaterThan(float(0.0)).and(hitAny.lessThan(float(0.5))), () => {
      const g = ro.add(rd.mul(tg));
      const r = length(vec2(g.x, g.z));
      col.assign(mix(col, vec3(0.02, 0.025, 0.03), exp(r.mul(r).negate().mul(1.6)).mul(0.5)));
    });

    return vec4(pow(clamp(col, 0.0, 1.0), vec3(0.4545)), 1.0);
  });

  return { u, boneData, atlasTex, tintTex, scenePass, map, shade };
}

/** Write a bake into the uniform block, and return the bounding sphere the march is confined to. */
export function upload(field, baked) {
  const { u, boneData } = field;
  u.boneCount.value = baked.bones.length;
  for (let i = 0; i < MAX_BONES; i++) {
    const b = baked.bones[i];
    const base = i * STRIDE;
    // An unused slot must be INERT, not merely unvisited: left at zero its sphere sits at the origin
    // with radius 0 and its box is a point the march can hit. Parked far under the floor instead.
    if (!b) {
      boneData.array[base + 0].set(0, -1e4, 0, 0);
      for (let a = 0; a < 3; a++) boneData.array[base + 1 + a].set(a === 0 ? 1 : 0, a === 1 ? 1 : 0, a === 2 ? 1 : 0, 0);
      boneData.array[base + 4].set(0, 0, 0, 0);
      boneData.array[base + 5].set(0, 0, TILE_PAD, 0);
      // Pad, not zero: a zero-sized tile divides by its own half extents.
      boneData.array[base + 6].set(TILE_PAD, TILE_PAD, TILE_PAD, 0);
      continue;
    }
    boneData.array[base + 0].set(b.box.center[0], b.box.center[1], b.box.center[2], b.span);
    for (let a = 0; a < 3; a++) {
      boneData.array[base + 1 + a].set(b.box.axes[a][0], b.box.axes[a][1], b.box.axes[a][2], b.box.half[a]);
    }
    // The bounding-sphere radius rides in the colour slot's spare channel: it is the loop's skip test.
    boneData.array[base + 4].set(b.colour[0], b.colour[1], b.colour[2], b.sphere);
    boneData.array[base + 5].set(i % ATLAS_NX, Math.floor(i / ATLAS_NX), TILE_PAD, 0);
    const th = b.tile?.half ?? b.box.half.map((h) => h + TILE_PAD);
    boneData.array[base + 6].set(th[0], th[1], th[2], 0);
  }
  let far = 0;
  for (const b of baked.bones) {
    far = Math.max(far, Math.hypot(b.box.center[0], b.box.center[1] - 0.5, b.box.center[2]) + b.sphere);
  }
  u.hullR.value = far * 1.15 + 0.1;
  u.hullY.value = 0.5;
  return u.hullR.value;
}

/** Push a volume bake's tiles into the atlas textures. Boxes still come from `upload`. */
export function uploadVolume(field, baked) {
  if (!baked.tiles) throw new Error('that bake has no tiles — use bakeVolume');
  if (baked.tiles.res !== TILE_RES) throw new Error(`tiles are ${baked.tiles.res}, the atlas is ${TILE_RES}`);
  field.atlasTex.image.data.set(baked.tiles.data);
  field.atlasTex.needsUpdate = true;
  let bytes = baked.tiles.data.byteLength;
  if (baked.tiles.rgb) {
    field.tintTex.image.data.set(baked.tiles.rgb);
    field.tintTex.needsUpdate = true;
    bytes += baked.tiles.rgb.byteLength;
  }
  return bytes;
}
