// trees.js
// Procedural tree generator for three.js, in the style of dgreenheck/ez-tree.
//
// A tree is a recursive swept-tube skeleton: every branch is a tapered tube
// whose growth direction wanders (gnarliness) and bends toward a force
// direction; child branches bud off the parent's surface; the whole tree is
// flattened into a few merged meshes (branches + non-shadow leaves + shadow-
// casting leaves) for cheap rendering. leaves.shadowFraction sets the split.
//
// Usage from a host script:
//   import { Tree, createTree } from './trees.js';
//   const tree = createTree({ seed: 7, levels: 4 });
//   tree.position.set(x, terrainHeight(x, z), z);
//   scene.add(tree);
//   // later: tree.regenerate({ seed: 8 });
//
// Everything is CPU-side geometry; no textures are required.

import * as THREE from 'three';

// ---------- seeded RNG (mulberry32) so a seed reproduces the same tree ----------
function makeRNG(seed) {
  let s = (seed >>> 0) || 1;
  const next = () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, range: (a, b) => a + (b - a) * next() };
}

// ---------- defaults. Arrays are indexed by branch level (0 = trunk). ----------
// `children` is indexed by the PARENT level; every other per-level array is
// indexed by the branch's own level. Short arrays clamp to their last entry.
const DEFAULTS = {
  seed: 1,
  levels: 3,                              // recursion depth; 0 = trunk only
  length:     [15, 11, 7, 3],             // branch length per level
  radius:     [1.2, 0.55, 0.3, 0.16],     // base radius per level
  taper:      [0.72, 0.75, 0.8, 0.85],    // fraction of radius lost along length
  children:   [6, 5, 3, 2],               // # children spawned BY a level-L branch
  branchStart:[0, 0.35, 0.35, 0.35],      // where children begin along the parent (0..1)
  angle:      [0, 58, 52, 48],            // tilt (deg) of a branch off its parent axis
  gnarliness: [0.10, 0.18, 0.28, 0.30],   // random wander of growth direction
  twist:      [0, 0, 0, 0],               // constant twist about the branch axis (rad/section)
  sections:   [10, 8, 6, 4],              // rings along the length
  segments:   [8, 6, 5, 4],               // sides around the circumference
  force: { direction: [0, 1, 0], strength: 0.03 }, // growth bias (e.g. up = phototropism)
  bark:   { color: 0x6b4f2e, roughness: 0.9, flatShading: false, map: null, normalMap: null, vScale: 0.4 },
  leaves: {
    enabled: true,
    count: 10,            // leaves per leaf-bearing branch
    size: 1.3,
    sizeVariance: 0.5,    // 0..1 random size spread
    start: 0.25,          // where on the branch leaves begin (0..1)
    spread: 0,            // 0 = terminal only; 1 = all outer branch levels
    angle: 55,            // tilt (deg) of leaf off the branch
    doubleBillboard: true,// two perpendicular quads per leaf
    roundedNormals: true, // bend leaf normals outward so the canopy lights as a volume
    shape: 'quad',        // 'quad' = atlas card, 'simple' = textureless leaf polygon
    atlas: null,          // {cols,rows} to pick a random cell per leaf from a sprite sheet;
                          // add {cell:n} to pin every leaf to one cell (e.g. one species)
    shadowFraction: 0,    // 0..1 of leaves that cast shadows (billboards are muddy, so default off)
    tint: 0x4f7a3a,
    roughness: 1.0,
    map: null,            // optional THREE.Texture; if set, alpha-tested
    alphaTest: 0.5,
  },
};

// deep-merge user options over defaults (arrays/primitives replace; objects merge)
function merge(base, over) {
  if (over == null) return Array.isArray(base) ? base.slice() : base;
  if (base == null || Array.isArray(base) || typeof base !== 'object') return over;
  const out = {};
  for (const k of new Set([...Object.keys(base), ...Object.keys(over)])) {
    out[k] = k in over ? merge(base[k], over[k]) : base[k];
  }
  return out;
}

const at = (arr, level) => arr[Math.min(level, arr.length - 1)];
const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);

// Scratch objects reused across generation. The queue processes one branch
// fully before the next (no re-entrancy), so sharing these is safe and avoids
// the tens-of-thousands of transient Vector3/Quaternion allocations per tree
// that otherwise drove GC spikes when rebuilding a whole forest.
const _forceDir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _dir = new THREE.Vector3();
const _v = new THREE.Vector3();
const _adv = new THREE.Vector3();
const _qs = new THREE.Quaternion();
const _qtwist = new THREE.Quaternion();
const _qforce = new THREE.Quaternion();
const _up = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _cq = new THREE.Quaternion();
const _cqa = new THREE.Quaternion();
const _cqb = new THREE.Quaternion();
const _lq = new THREE.Quaternion();
const _lq2 = new THREE.Quaternion();
const _lqa = new THREE.Quaternion();
const _lqb = new THREE.Quaternion();
const _lorigin = new THREE.Vector3();
const _lnormal = new THREE.Vector3();
const _lp = new THREE.Vector3();
const _loff = new THREE.Vector3();
const _lface = new THREE.Vector3();
const LEAF_CORNERS = [[-1, 0], [1, 0], [1, 1], [-1, 1]];
const LEAF_SHAPE = [
  [0, 0],
  [-0.48, 0.22],
  [-0.34, 0.58],
  [-0.12, 0.86],
  [0, 1],
  [0.12, 0.86],
  [0.34, 0.58],
  [0.48, 0.22],
];

export class Tree extends THREE.Group {
  constructor(options = {}) {
    super();
    this.options = merge(DEFAULTS, options);

    const bo = this.options.bark;
    this.branchMat = new THREE.MeshStandardMaterial({
      color: bo.color,
      roughness: bo.roughness,
      flatShading: bo.flatShading,
      map: bo.map || null,
      normalMap: bo.normalMap || null,
    });
    for (const t of [bo.map, bo.normalMap]) if (t) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    const lo = this.options.leaves;
    this.leafMat = new THREE.MeshStandardMaterial({
      color: lo.tint,
      roughness: lo.roughness,
      side: THREE.DoubleSide,
      map: lo.map || null,
      transparent: !!lo.map,
      alphaTest: lo.map ? lo.alphaTest : 0,
    });

    this.branchesMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.branchMat);
    // Leaves split into two meshes so a fraction (leaves.shadowFraction) can cast
    // shadows while the rest skip the muddy, expensive shadow pass.
    this.leavesMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.leafMat);
    this.leavesShadowMesh = new THREE.Mesh(new THREE.BufferGeometry(), this.leafMat);
    this.branchesMesh.castShadow = this.branchesMesh.receiveShadow = true;
    this.leavesMesh.castShadow = false;
    this.leavesShadowMesh.castShadow = true;
    this.add(this.branchesMesh, this.leavesMesh, this.leavesShadowMesh);

    this.generate();
  }

  regenerate(options) {
    if (options) this.options = merge(this.options, options);
    this.generate();
  }

  regenerateLeaves(leafOpts) {
    if (leafOpts) this.options = merge(this.options, { leaves: leafOpts });
    const o = this.options;
    this.rng = makeRNG(o.seed);
    this.leafShadowRng = makeRNG((o.seed ^ 0x9e3779b9) >>> 0);
    this.leaf = { verts: [], normals: [], uvs: [], indices: [] };
    this.leafShadow = { verts: [], normals: [], uvs: [], indices: [] };
    this.queue = [this._trunkEntry()];
    while (this.queue.length) this._generateBranch(this.queue.shift(), true);
    this._commit(this.leavesMesh.geometry, this.leaf);
    this._commit(this.leavesShadowMesh.geometry, this.leafShadow);
  }

  generate() {
    const o = this.options;
    this.rng = makeRNG(o.seed);
    this.branch = { verts: [], normals: [], uvs: [], indices: [] };
    this.leaf = { verts: [], normals: [], uvs: [], indices: [] };
    this.leafShadow = { verts: [], normals: [], uvs: [], indices: [] };
    // Separate stream for the cast/no-cast decision so changing shadowFraction
    // never perturbs the geometry RNG (tree shape stays identical).
    this.leafShadowRng = makeRNG((o.seed ^ 0x9e3779b9) >>> 0);

    // breadth-first queue, seeded with the trunk
    this.queue = [this._trunkEntry()];
    while (this.queue.length) this._generateBranch(this.queue.shift());

    this._commit(this.branchesMesh.geometry, this.branch);
    this._commit(this.leavesMesh.geometry, this.leaf);
    this._commit(this.leavesShadowMesh.geometry, this.leafShadow);
  }

  _trunkEntry() {
    const o = this.options;
    return {
      origin: new THREE.Vector3(0, 0, 0),
      orientation: new THREE.Euler(0, 0, 0),
      length: at(o.length, 0),
      radius: at(o.radius, 0),
      level: 0,
      sectionCount: at(o.sections, 0),
      segmentCount: at(o.segments, 0),
    };
  }

  // ---- build one branch's tube, then spawn its children or leaves ----
  _generateBranch(branch, leavesOnly = false) {
    const o = this.options;
    const segs = branch.segmentCount;
    const vertsPerRing = segs + 1; // +1 duplicated seam vertex for clean UV wrap
    const indexOffset = leavesOnly ? 0 : this.branch.verts.length / 3;

    const orientation = branch.orientation.clone();
    const origin = branch.origin.clone();
    const sectionLength = branch.length / branch.sectionCount;
    const forceDir = _forceDir.fromArray(o.force.direction).normalize();
    const wrapsX = Math.max(1, Math.round(branch.radius)); // texture wraps ~ thickness
    const twist = at(o.twist, branch.level);

    const sections = [];

    for (let i = 0; i <= branch.sectionCount; i++) {
      // taper down the length; collapse the very tip of terminal branches
      let radius = branch.radius * (1 - at(o.taper, branch.level) * (i / branch.sectionCount));
      if (i === branch.sectionCount && branch.level === o.levels) radius = 0.001;

      _q.setFromEuler(orientation);
      const vCoord = i * sectionLength * (o.bark.vScale || 0.4);
      if (!leavesOnly) {
        for (let j = 0; j < segs; j++) {
          const a = (2 * Math.PI * j) / segs;
          _dir.set(Math.cos(a), 0, Math.sin(a)).applyQuaternion(_q);
          _v.copy(_dir).multiplyScalar(radius).add(origin);
          this.branch.verts.push(_v.x, _v.y, _v.z);
          this.branch.normals.push(_dir.x, _dir.y, _dir.z);
          this.branch.uvs.push((j / segs) * wrapsX, vCoord);
        }
        // seam vertex (duplicate of j=0) at u = wrapsX
        _dir.set(1, 0, 0).applyQuaternion(_q);
        _v.copy(_dir).multiplyScalar(radius).add(origin);
        this.branch.verts.push(_v.x, _v.y, _v.z);
        this.branch.normals.push(_dir.x, _dir.y, _dir.z);
        this.branch.uvs.push(wrapsX, vCoord);
      }

      sections.push({ origin: origin.clone(), orientation: orientation.clone(), radius });

      // advance origin along the current growth direction
      origin.add(_adv.set(0, sectionLength, 0).applyEuler(orientation));

      // wander: thinner branches wiggle more
      const g = Math.max(1, 1 / Math.sqrt(Math.max(radius, 1e-3))) * at(o.gnarliness, branch.level);
      orientation.x += this.rng.range(-g, g);
      orientation.z += this.rng.range(-g, g);

      // twist about own axis, then bend toward the force direction
      _qs.setFromEuler(orientation).multiply(_qtwist.setFromAxisAngle(UP, twist));
      _up.copy(UP).applyQuaternion(_qs);
      _axis.crossVectors(_up, forceDir);
      const sinFull = _axis.length();
      if (sinFull > 1e-6) {
        _axis.divideScalar(sinFull);
        const full = Math.atan2(sinFull, _up.dot(forceDir));
        const step = o.force.strength / Math.max(radius, 1e-3);
        const clamped = Math.max(-full, Math.min(full, step));
        _qs.premultiply(_qforce.setFromAxisAngle(_axis, clamped));
      }
      orientation.setFromQuaternion(_qs);
    }

    // skin the tube: two triangles per quad between consecutive rings
    if (!leavesOnly) {
      for (let i = 0; i < branch.sectionCount; i++) {
        for (let j = 0; j < segs; j++) {
          const a = indexOffset + i * vertsPerRing + j;
          const b = a + 1;
          const c = a + vertsPerRing;
          const d = c + 1;
          this.branch.indices.push(a, c, b, b, c, d);
        }
      }
    }

    // A branch is terminal (grows leaves) at the depth limit or when it has
    // no children of its own; otherwise it spawns children.
    const terminal = branch.level >= o.levels || at(o.children, branch.level) <= 0;
    const leafMinLevel = Math.max(1, Math.floor(o.levels * (1 - (o.leaves.spread || 0))));
    const leafBearing = o.leaves.enabled && (terminal || branch.level >= leafMinLevel);
    if (!terminal) {
      this._spawnChildren(branch, sections);
      if (leafBearing) this._spawnLeaves(branch, sections);
    } else if (leafBearing) {
      this._spawnLeaves(branch, sections);
    }
  }

  _spawnChildren(branch, sections) {
    const o = this.options;
    const childLevel = branch.level + 1;
    const count = at(o.children, branch.level);
    if (count <= 0) return;

    const startMin = at(o.branchStart, childLevel);
    const span = 1 - startMin;
    const step = span / count;
    const angle = at(o.angle, childLevel) * DEG;
    const childLen = at(o.length, childLevel);
    const childRadCap = at(o.radius, childLevel);

    for (let k = 0; k < count; k++) {
      // stratified height along the parent, jittered within its slot
      const frac = startMin + (k + this.rng.next()) * step;
      const fi = Math.min(frac * (sections.length - 1), sections.length - 1.0001);
      const si = Math.floor(fi);
      const t = fi - si;
      const s0 = sections[si], s1 = sections[si + 1] || s0;

      const origin = new THREE.Vector3().lerpVectors(s0.origin, s1.origin, t);
      const parentRadius = s0.radius * (1 - t) + s1.radius * t;
      const radius = Math.min(childRadCap, parentRadius * 0.85);

      // stratified azimuth around the branch axis, jittered
      const azimuth = ((k + this.rng.range(-0.4, 0.4)) / count) * Math.PI * 2;
      _cq.setFromEuler(s0.orientation)
        .multiply(_cqa.setFromAxisAngle(UP, azimuth))
        .multiply(_cqb.setFromAxisAngle(RIGHT, angle));

      this.queue.push({
        origin,
        orientation: new THREE.Euler().setFromQuaternion(_cq),
        length: childLen * this.rng.range(0.8, 1.0),
        radius,
        level: childLevel,
        sectionCount: at(o.sections, childLevel),
        segmentCount: at(o.segments, childLevel),
      });
    }
  }

  _spawnLeaves(branch, sections) {
    const o = this.options, lo = o.leaves;
    const startMin = lo.start;
    const tilt = lo.angle * DEG;
    for (let k = 0; k < lo.count; k++) {
      const frac = startMin + (k + this.rng.next()) * ((1 - startMin) / lo.count);
      const fi = Math.min(frac * (sections.length - 1), sections.length - 1.0001);
      const si = Math.floor(fi);
      const t = fi - si;
      const s0 = sections[si], s1 = sections[si + 1] || s0;
      const origin = _lorigin.lerpVectors(s0.origin, s1.origin, t);

      const spin = this.rng.range(0, Math.PI * 2);
      _lq.setFromEuler(s0.orientation)
        .multiply(_lqa.setFromAxisAngle(UP, spin))
        .multiply(_lqb.setFromAxisAngle(RIGHT, tilt));

      const size = lo.size * (1 + this.rng.range(-1, 1) * lo.sizeVariance);
      // pick an atlas cell (sprite-sheet sub-rectangle) for this leaf, or the full sheet
      let uv = [0, 0, 1, 1];
      if (lo.atlas && lo.atlas.cols * lo.atlas.rows > 1) {
        const cols = lo.atlas.cols, rows = lo.atlas.rows;
        // pin to a fixed cell (per-species leaf) when given, else pick randomly
        const cell = Number.isFinite(lo.atlas.cell)
          ? ((lo.atlas.cell % (cols * rows)) + cols * rows) % (cols * rows)
          : Math.floor(this.rng.next() * cols * rows);
        const cx = cell % cols, cy = Math.floor(cell / cols), du = 1 / cols, dv = 1 / rows;
        uv = [cx * du, cy * dv, (cx + 1) * du, (cy + 1) * dv];
      }
      // Both billboards of one leaf share a bucket so the leaf casts (or not) as a whole.
      const target = this.leafShadowRng.next() < lo.shadowFraction ? this.leafShadow : this.leaf;
      this._leaf(origin, _lq, size, uv, target);
      if (lo.doubleBillboard) {
        _lq2.copy(_lq).multiply(_lqa.setFromAxisAngle(UP, Math.PI / 2));
        this._leaf(origin, _lq2, size, uv, target);
      }
    }
  }

  _leaf(origin, q, size, uv, target = this.leaf) {
    if (this.options.leaves.shape === 'simple') this._leafShape(origin, q, size, target);
    else this._leafQuad(origin, q, size, uv, target);
  }

  // a single leaf card: width-by-height quad growing outward from `origin`.
  // uv = [u0,v0,u1,v1] sub-rectangle (atlas cell, or full 0..1).
  _leafQuad(origin, q, size, uv, target = this.leaf) {
    const w = size * 0.6, h = size;
    const rounded = this.options.leaves.roundedNormals;
    _lface.set(0, 0, 1).applyQuaternion(q);     // billboard facing direction
    const base = target.verts.length / 3;
    for (const [mx, my] of LEAF_CORNERS) {
      _loff.set(mx * w, my * h, 0).applyQuaternion(q);   // rotated local offset from origin
      _lp.copy(_loff).add(origin);
      target.verts.push(_lp.x, _lp.y, _lp.z);
      // rounded: bend the normal outward toward this corner so the canopy lights as a volume
      if (rounded) _lnormal.copy(_lface).add(_loff).normalize();
      else _lnormal.copy(_lface);
      target.normals.push(_lnormal.x, _lnormal.y, _lnormal.z);
    }
    const [u0, v0, u1, v1] = uv;                 // corners: BL, BR, TR, TL
    target.uvs.push(u0, v0, u1, v0, u1, v1, u0, v1);
    target.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  // a textureless leaf silhouette. The polygon itself carries the leaf shape so
  // procedural mode does not need an alpha atlas.
  _leafShape(origin, q, size, target = this.leaf) {
    const w = size * 0.54, h = size;
    const rounded = this.options.leaves.roundedNormals;
    _lface.set(0, 0, 1).applyQuaternion(q);
    const base = target.verts.length / 3;
    for (const [mx, my] of LEAF_SHAPE) {
      _loff.set(mx * w, my * h, 0).applyQuaternion(q);
      _lp.copy(_loff).add(origin);
      target.verts.push(_lp.x, _lp.y, _lp.z);
      if (rounded) _lnormal.copy(_lface).addScaledVector(_loff, 0.45).normalize();
      else _lnormal.copy(_lface);
      target.normals.push(_lnormal.x, _lnormal.y, _lnormal.z);
      target.uvs.push(mx * 0.5 + 0.5, my);
    }
    for (let i = 1; i < LEAF_SHAPE.length - 1; i++) {
      target.indices.push(base, base + i, base + i + 1);
    }
  }

  _commit(geometry, data) {
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(data.verts, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(data.normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(data.uvs, 2));
    geometry.setIndex(data.indices);
    geometry.computeBoundingSphere();
  }

  dispose() {
    this.branchesMesh.geometry.dispose();
    this.leavesMesh.geometry.dispose();
    this.leavesShadowMesh.geometry.dispose();
    this.branchMat.dispose();
    this.leafMat.dispose();
  }
}

export function createTree(options) {
  return new Tree(options);
}

export default Tree;
