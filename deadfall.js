// deadfall.js -- fallen logs (fresh/mossy/rotten decay), stumps with root flare, ground/shelf
// mushrooms: the Phase 4 (merged-plan row #8) fungi/deadfall geometry + material host. Adapts
// fable5-world-demo src/vegetation/Deadfall.ts (the DECAY LAW -- sag, cross-section squish,
// steeper taper, capped ends, moss/rot weight fresh 0.15 / mossy 0.8 / rotten 1.0) and
// Dressing.ts buildMushroom (lathed cap + gill disk + stem), REIMPLEMENTED here (the TS is
// reference only). Logs/stumps are swept-tube ring meshes in the spirit of trees.js's
// _generateBranch ring emission; the deadwood material reuses the ONE shared dressing law
// (moss-tint.js mossWeight()) already used by the terrain (#3) and rock (#7) materials.
//
// TYPES ARE DATA-DRIVEN: createDeadfallPalette({ types }) takes an array of arbitrary length --
// any number of log/stump/mushroom TYPES and decay seeds, with zero hardcoded type-count caps
// or switch-arms. Ship a handful as starters (DEFAULT_DEADFALL_TYPES); grow the table with zero
// code changes. The only fixed thing is the per-frame INSTANCE budget/cull, enforced by the
// dressing-gpu.js host, not by this file.
//
// Standalone module: NOT wired into environment-viewer.html yet (deferred coordinated
// integration -- see docs/subsystems/vegetation.md "Deadfall/fungi integration" and the
// dressing-gpu.js contract in docs/subsystems/rocks.md). Deadfall renders on the SAME
// dressing-gpu.js host rocks use.
//
// Vertex aux channels baked into every geometry (two generic float attributes, each material
// interprets its own):
//   aC0 -- deadwood: decay/moss-rot weight in [0,1] (fresh 0.15 / mossy 0.8 / rotten 1.0);
//          mushroom: part id (0 stem, 0.5 gills, 1 cap top).
//   aC1 -- deadwood: shelf-fungus flag (0 bark, 1 shelf cap -- baked ONLY on mossy/rotten logs);
//          mushroom: cap tone 0..1 (per-instance-free tint lever).
import * as THREE from 'three';
import { MeshStandardNodeMaterial } from 'three/webgpu';
import {
  float, vec3, mix, clamp, smoothstep, attribute, positionWorld, normalWorld,
  dot, sin, fract,
} from 'three/tsl';
import { mossWeight } from './moss-tint.js';
import { rngFrom } from './forest-placement.js';
import { DEFAULT_MOISTURE } from './moisture-proxy.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// decay-state name -> baked moss/rot weight (fable5 Deadfall.ts:63).
export const DECAY_WEIGHT = { fresh: 0.15, mossy: 0.8, rotten: 1.0 };

// ---- tiny self-contained ring-sweep mesher (MeshGrower-style, like trees.js's _generateBranch
// emission but standalone so geometry stays pure `three` and Node-testable). Pushes explicit
// per-vertex normals (no computeVertexNormals) so lighting never depends on winding order --
// the up-facing normal drives the moss gate, so it must be correct regardless of index order.
class Grower {
  constructor() {
    this.pos = []; this.nrm = []; this.uv = []; this.c0 = []; this.c1 = []; this.idx = [];
  }
  vertex(x, y, z, nx, ny, nz, u, v, c0 = 0, c1 = 0) {
    const len = Math.hypot(nx, ny, nz) || 1;
    const i = this.pos.length / 3;
    this.pos.push(x, y, z);
    this.nrm.push(nx / len, ny / len, nz / len);
    this.uv.push(u, v);
    this.c0.push(c0); this.c1.push(c1);
    return i;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aC0', new THREE.Float32BufferAttribute(this.c0, 1));
    g.setAttribute('aC1', new THREE.Float32BufferAttribute(this.c1, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
  get triCount() { return this.idx.length / 3; }
}

// normalize a 3-vector in place-ish
function norm3(x, y, z) { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; }
function cross3(ax, ay, az, bx, by, bz) { return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx]; }

// Sweep an elliptical cross-section (horizontal radius r, vertical radius r*squish) along a
// polyline of centerline points, capping both ends. `weightC0`/`weightC1` are baked into every
// swept vertex. Returns nothing (writes into `g`).
function sweepTube(g, centers, radii, squish, ringSegs, weightC0, weightC1) {
  const n = centers.length;
  const ringIds = [];
  for (let i = 0; i < n; i++) {
    // tangent from finite difference
    const p = centers[i];
    const a = centers[Math.max(0, i - 1)], b = centers[Math.min(n - 1, i + 1)];
    let [tx, ty, tz] = norm3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    // reference up; if tangent ~ vertical use X as reference
    const refUp = Math.abs(ty) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let [nx, ny, nz] = norm3(...cross3(refUp[0], refUp[1], refUp[2], tx, ty, tz)); // side axis N
    let [bx, by, bz] = norm3(...cross3(tx, ty, tz, nx, ny, nz));                    // up-ish axis B
    const r = radii[i];
    const ids = [];
    for (let k = 0; k < ringSegs; k++) {
      const ang = (k / ringSegs) * Math.PI * 2;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const ox = nx * ca * r + bx * sa * r * squish;
      const oy = ny * ca * r + by * sa * r * squish;
      const oz = nz * ca * r + bz * sa * r * squish;
      // ellipse outward normal: N*(squish*cos) + B*sin, normalized
      const enx = nx * squish * ca + bx * sa;
      const eny = ny * squish * ca + by * sa;
      const enz = nz * squish * ca + bz * sa;
      ids.push(g.vertex(p[0] + ox, p[1] + oy, p[2] + oz, enx, eny, enz, k / ringSegs, i / (n - 1), weightC0, weightC1));
    }
    ringIds.push({ ids, tx, ty, tz });
  }
  for (let i = 0; i < n - 1; i++) {
    const a = ringIds[i].ids, b = ringIds[i + 1].ids;
    for (let k = 0; k < ringSegs; k++) {
      const k2 = (k + 1) % ringSegs;
      g.quad(a[k], b[k], b[k2], a[k2]);
    }
  }
  // caps (both ends): center fan, normal along -tangent (start) / +tangent (end)
  const capEnd = (ringInfo, sign) => {
    const p = centers[sign < 0 ? 0 : n - 1];
    const t = ringInfo;
    const c = g.vertex(p[0], p[1], p[2], t.tx * sign, t.ty * sign, t.tz * sign, 0.5, sign < 0 ? 0 : 1, weightC0, weightC1);
    const ring = ringInfo.ids;
    for (let k = 0; k < ringSegs; k++) {
      const k2 = (k + 1) % ringSegs;
      if (sign < 0) g.tri(c, ring[k2], ring[k]); else g.tri(c, ring[k], ring[k2]);
    }
  };
  capEnd(ringIds[0], -1);
  capEnd(ringIds[n - 1], 1);
}

// ---- shelf fungus: a small horizontal half-bracket protruding from a log's side, baked into
// the SAME geometry (aC1=1 so the deadwood material paints it a pale fungus tone). This is how
// the demo keeps shelf fungi "live" cheaply -- part of the log mesh, not a separate scatter.
function addShelf(g, cx, cy, cz, dirAng, radius, decayC0) {
  const rows = 3, seg = 6;
  const dx = Math.cos(dirAng), dz = Math.sin(dirAng); // outward horizontal direction
  const px = -dz, pz = dx;                            // perpendicular (chord) direction
  const rowIds = [];
  for (let ri = 0; ri <= rows; ri++) {
    const t = ri / rows;                    // 0 at trunk, 1 at outer rim
    const rr = radius * Math.sin(t * Math.PI * 0.5);   // dome-ish out-reach
    const lift = radius * 0.35 * Math.sin(t * Math.PI); // slight upward curl
    const ids = [];
    for (let k = 0; k <= seg; k++) {
      const s = (k / seg - 0.5) * 2;         // -1..1 across the half-cap chord
      const chord = radius * (1 - t * 0.15) * s;
      const x = cx + dx * rr + px * chord;
      const z = cz + dz * rr + pz * chord;
      const y = cy + lift;
      ids.push(g.vertex(x, y, z, 0, 1, 0, t, k / seg, decayC0, 1)); // aC1=1 => shelf fungus
    }
    rowIds.push(ids);
  }
  for (let ri = 0; ri < rows; ri++) {
    const a = rowIds[ri], b = rowIds[ri + 1];
    for (let k = 0; k < seg; k++) g.quad(a[k], b[k], b[k + 1], a[k + 1]);
  }
}

// opts: { rng (rngFrom instance), decay ('fresh'|'mossy'|'rotten' | number 0..1), shelf (bool;
//         forced false for 'fresh' regardless), ringSegs=13 }.
// Local frame: log lies along X, resting so its lowest point ~ y=0 (instance places base on the
// seated ground height). Returns { geometry, length } -- `length` is the local X span, used by
// deadfall-placement.js's collision-circle export.
export function buildLog(opts = {}) {
  const rng = opts.rng || rngFrom(1);
  const decayName = typeof opts.decay === 'string' ? opts.decay : null;
  const decayC0 = decayName ? (DECAY_WEIGHT[decayName] ?? 0.5) : clamp01(opts.decay ?? 0.5);
  const ringSegs = opts.ringSegs ?? 13;
  const len = 2.6 + rng.next() * 2.6;
  const r0 = 0.16 + rng.next() * 0.16;
  const segs = 9;
  // Grade the cross-section squish + length-taper CONTINUOUSLY by decay weight so the three
  // states read as a monotone silhouette progression at ~5 m (fresh round -> rotten slumped),
  // not just a tint change. fable5 only squished 'rotten'; grading makes 'mossy' visibly
  // intermediate too (fresh 1.0 / mossy ~0.79 / rotten 0.72 vertical squish).
  const dw = (decayC0 - 0.15) / 0.85;                 // 0 at fresh, ~0.76 mossy, 1 rotten
  const squish = 1.0 - 0.28 * clamp01(dw);
  const taper = 0.94 - 0.06 * clamp01(dw);
  const wob = rng.next() * Math.PI * 2;
  const restY = r0 * squish;                 // lowest ellipse point ~ 0
  const centers = [], radii = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const sag = Math.sin(t * Math.PI) * 0.03;
    centers.push([
      (t - 0.5) * len,
      restY - sag + Math.sin(t * 7 + wob) * 0.015,
      Math.sin(t * 2.2 + wob) * len * 0.05,
    ]);
    radii.push(r0 * (1 - t * (1 - taper)) * (1 + Math.sin(t * 13 + wob) * 0.05));
  }
  const g = new Grower();
  sweepTube(g, centers, radii, squish, ringSegs, decayC0, 0);

  // shelf fungi ride mossy/rotten logs only (fresh logs never get them -- acceptance criterion)
  const wantShelf = opts.shelf !== false && !!decayName && decayName !== 'fresh';
  if (wantShelf) {
    const nShelf = 1 + Math.floor(rng.next() * 3); // 1..3 brackets
    for (let s = 0; s < nShelf; s++) {
      const ti = 1 + Math.floor(rng.next() * (segs - 1));  // interior segment
      const c = centers[ti];
      const r = radii[ti];
      const side = rng.next() < 0.5 ? 1 : -1;              // protrude to +Z or -Z side, angled up
      const dirAng = Math.PI * 0.5 * side + rng.range(-0.4, 0.4);
      addShelf(g, c[0], c[1] + r * 0.5, c[2], dirAng, r * (1.4 + rng.next() * 1.2), Math.max(decayC0, 0.85));
    }
  }
  return { geometry: g.build(), length: len };
}

// opts: { rng, decay (number 0..1; default 0.5 + rng*0.3, the fable5 stump moss default),
//         flare { amp=0.85, heightFrac=0.55, lobes=5, phase } (root buttress), ringSegs=14 }.
// Vertical broken stub with a lobed root flare near the base. Returns { geometry, height }.
export function buildStump(opts = {}) {
  const rng = opts.rng || rngFrom(1);
  const ringSegs = opts.ringSegs ?? 14;
  const h = 0.5 + rng.next() * 0.6;
  const r0 = 0.22 + rng.next() * 0.14;
  const decayC0 = clamp01(opts.decay ?? (0.5 + rng.next() * 0.3));
  const fl = opts.flare || {};
  const amp = fl.amp ?? 0.85;
  const flareH = h * (fl.heightFrac ?? 0.55);
  const lobes = fl.lobes ?? 5;
  const phase = fl.phase ?? rng.next() * Math.PI * 2;
  const segs = 6;
  const g = new Grower();
  const ringIds = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const y = t * h;
    const baseR = r0 * (1 - t * 0.18);
    // root flare: near the base (y < flareH) the radius swells in `lobes` buttresses
    const flareT = Math.max(0, 1 - y / Math.max(flareH, 1e-4));
    const ids = [];
    for (let k = 0; k < ringSegs; k++) {
      const ang = (k / ringSegs) * Math.PI * 2;
      const lobe = 0.5 + 0.5 * Math.sin(lobes * ang + phase);
      const r = baseR * (1 + amp * flareT * flareT * lobe);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      // outward normal tilts slightly with the flare swell but radial dominates
      const nx = ca, nz = sa, ny = flareT * 0.3;
      ids.push(g.vertex(ca * r, y, sa * r, nx, ny, nz, k / ringSegs, t, decayC0, 0));
    }
    ringIds.push(ids);
  }
  for (let i = 0; i < segs; i++) {
    const a = ringIds[i], b = ringIds[i + 1];
    for (let k = 0; k < ringSegs; k++) {
      const k2 = (k + 1) % ringSegs;
      g.quad(a[k], b[k], b[k2], a[k2]);
    }
  }
  // jagged broken top cap (flat-ish fan with slight height jitter for a snapped look)
  const top = ringIds[segs];
  const cTop = g.vertex(0, h + r0 * 0.05, 0, 0, 1, 0, 0.5, 1, decayC0, 0);
  for (let k = 0; k < ringSegs; k++) {
    const k2 = (k + 1) % ringSegs;
    g.tri(cTop, top[k], top[k2]);
  }
  return { geometry: g.build(), height: h };
}

// opts: { rng, kind ('cap' ground-standing full dome | 'shelf' half-cap), tone (0..1 aC1 tint
//         lever; default rng) }. Lathed cap (dome + slight lip) + gill disk + stem tube.
// aC0 part channel: 0 stem, 0.5 gills, 1 cap top (mushroom material colors by part).
export function buildMushroom(opts = {}) {
  const rng = opts.rng || rngFrom(1);
  const kind = opts.kind === 'shelf' ? 'shelf' : 'cap';
  const tone = clamp01(opts.tone ?? rng.next());
  const g = new Grower();
  const capR = kind === 'cap' ? 0.05 + rng.next() * 0.06 : 0.06 + rng.next() * 0.08;
  const capH = capR * (kind === 'cap' ? 0.55 + rng.next() * 0.45 : 0.3);
  const stemH = kind === 'cap' ? capR * (1.2 + rng.next() * 1.4) : 0;
  const SEG = 10;
  const arc = kind === 'cap' ? Math.PI * 2 : Math.PI;
  const rows = 4;
  const rowIds = [];
  for (let i = 0; i <= rows; i++) {
    const t = i / rows;
    const ang = t * Math.PI * 0.5;
    // dome radius with a slight outward lip near the rim (t small) for a mushroom silhouette
    const lip = 1 + (1 - t) * 0.08;
    const r = capR * Math.cos(ang) * lip;
    const y = stemH + Math.sin(ang) * capH;
    const ids = [];
    for (let k = 0; k <= SEG; k++) {
      const a = (k / SEG) * arc;
      const nx = Math.cos(a) * Math.cos(ang);
      const nz = Math.sin(a) * Math.cos(ang);
      const ny = Math.sin(ang) * 0.8 + 0.2;
      ids.push(g.vertex(Math.cos(a) * r, y, Math.sin(a) * r, nx, ny, nz, k / SEG, t, 1, tone));
    }
    rowIds.push(ids);
  }
  for (let i = 0; i < rows; i++) {
    const a = rowIds[i], b = rowIds[i + 1];
    for (let k = 0; k < SEG; k++) g.quad(a[k], b[k], b[k + 1], a[k + 1]);
  }
  // gill underside disc (part = 0.5), facing down
  const rim = rowIds[0];
  const center = g.vertex(0, stemH * 0.98, 0, 0, -1, 0, 0.5, 0.5, 0.5, tone);
  for (let k = 0; k < SEG; k++) g.tri(center, rim[k + 1], rim[k]);
  // stem tube (part = 0), only for ground-standing caps
  if (stemH > 0) {
    const sr = capR * 0.28;
    const sIds = [];
    for (let i = 0; i <= 2; i++) {
      const t = i / 2;
      const ids = [];
      for (let k = 0; k <= 6; k++) {
        const a = (k / 6) * Math.PI * 2;
        const rr = sr * (1.25 - t * 0.25);
        ids.push(g.vertex(Math.cos(a) * rr, t * stemH, Math.sin(a) * rr, Math.cos(a), 0.1, Math.sin(a), k / 6, t, 0, tone));
      }
      sIds.push(ids);
    }
    for (let i = 0; i < 2; i++) {
      const a = sIds[i], b = sIds[i + 1];
      for (let k = 0; k < 6; k++) g.quad(a[k], b[k], b[k + 1], a[k + 1]);
    }
  }
  return { geometry: g.build() };
}

// ---- materials ----
// cheap world-space hash brush (no texture tap -- keeps the deadwood material at ZERO samplers,
// same trick rocks.js uses), for the moss break-up noise.
const hashNoise3 = (p) => fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))).mul(43758.5453));

// Deadwood material: bark-ish MeshStandardNodeMaterial (stays on the node-material family so it
// picks up clustered lights) tinted by the ONE shared mossWeight() law, driven by the baked
// decay weight (aC0). Pure expression nodes (no If() at material scope -- select()/mix() only),
// opaque (no transparent sorting, no emissive). Shelf-fungus verts (aC1=1) paint a pale tone.
// opts: { moistureNode (TSL float; the dressing-gpu wiring supplies nodes.extra -- per-instance
//         moisture -- defaults to DEFAULT_MOISTURE for previews), brushScale=0.7,
//         nodes / upnessNode (TSL float; the dressing-gpu wiring supplies nodes.nWorld -- the
//         INSTANCE-ROTATED world normal -- pass `nodes` (the { nWorld, ... } object handed to
//         buildMaterial) or `upnessNode` directly (e.g. nodes.nWorld.y) so tilted logs gate moss
//         off their true post-tilt "up", not the pre-rotation authored-local normalWorld; both
//         omitted => standalone/preview path, falls back to normalWorld.y) }.
export function buildDeadwoodMaterial(opts = {}) {
  const moistureNode = opts.moistureNode ?? float(DEFAULT_MOISTURE);
  const brushScale = opts.brushScale ?? 0.7;
  const mat = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 });

  const decay = attribute('aC0', 'float');
  const shelf = attribute('aC1', 'float');
  const upnessSource = opts.upnessNode ?? opts.nodes?.nWorld?.y ?? normalWorld.y;
  const upness = clamp(upnessSource, 0.0, 1.0);
  const brush = clamp(hashNoise3(positionWorld.mul(brushScale)), 0.0, 1.0);

  // fresh bark -> rotten (greyer, darker) purely by decay: a silhouette-independent tone cue
  const freshBark = vec3(0.34, 0.24, 0.15);
  const rottenBark = vec3(0.29, 0.27, 0.24);
  let base = mix(freshBark, rottenBark, decay);

  // moss gated by moisture x upness (shared law), with the baked decay weight fed as the
  // cavity/openness input so more-decayed wood holds visibly more moss (rotten reads mossy in a
  // wet forest, fresh stays mostly bare) -- this is the "moss coverage, not just tint" cue.
  const moss = mossWeight(moistureNode, upness, decay, brush);
  const mossAlbedo = vec3(0.24, 0.38, 0.18);
  base = mix(base, mossAlbedo, moss);

  // shelf fungus: pale tan bracket, overrides bark where aC1=1
  const shelfAlbedo = vec3(0.80, 0.72, 0.52);
  base = mix(base, shelfAlbedo, shelf);

  mat.colorNode = base;
  mat.roughnessNode = mix(float(1.0), float(0.9), moss);
  return mat;
}

// Mushroom material: opaque, part-colored (cap/gills/stem via aC0), NO emissive/glow (the
// "never fake AAA with glow" rule). opts: { capColor=[r,g,b], gillColor, stemColor }.
export function buildMushroomMaterial(opts = {}) {
  const cap = opts.capColor || [0.62, 0.20, 0.16];
  const gill = opts.gillColor || [0.86, 0.80, 0.68];
  const stem = opts.stemColor || [0.90, 0.86, 0.74];
  const mat = new MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
  const part = attribute('aC0', 'float');   // 0 stem, 0.5 gills, 1 cap
  const tone = attribute('aC1', 'float');
  const capN = vec3(cap[0], cap[1], cap[2]);
  const gillN = vec3(gill[0], gill[1], gill[2]);
  const stemN = vec3(stem[0], stem[1], stem[2]);
  // part<0.5 -> lerp stem..gills ; part>=0.5 -> lerp gills..cap
  const low = mix(stemN, gillN, clamp(part.mul(2.0), 0.0, 1.0));
  const high = mix(gillN, capN, clamp(part.sub(0.5).mul(2.0), 0.0, 1.0));
  const isCap = smoothstep(0.49, 0.51, part);
  let base = mix(low, high, isCap);
  // subtle per-instance/per-cap tone variation so a cluster isn't uniform (multiplicative)
  base = base.mul(float(0.85).add(tone.mul(0.3)));
  mat.colorNode = base;
  return mat;
}

// ---- palette (fully data-driven, open-ended) ----
// Starter content: 3 log decay states x 2 seeds, 2 stump seeds, 3 mushrooms. Each TYPE descriptor:
//   { key, kind ('log'|'stump'|'mushroom'), seedsPerType=1,
//     log:   { decay ('fresh'|'mossy'|'rotten'), shelf },
//     stump: { flare } (optional overrides),
//     mushroom: { mushKind ('cap'|'shelf'), tone, capColor,gillColor,stemColor } }
export const DEFAULT_DEADFALL_TYPES = [
  { key: 'logFresh', kind: 'log', seedsPerType: 2, log: { decay: 'fresh', shelf: false } },
  { key: 'logMossy', kind: 'log', seedsPerType: 2, log: { decay: 'mossy', shelf: true } },
  { key: 'logRotten', kind: 'log', seedsPerType: 2, log: { decay: 'rotten', shelf: true } },
  { key: 'stump', kind: 'stump', seedsPerType: 2 },
  { key: 'mushroomRed', kind: 'mushroom', seedsPerType: 3, mushroom: { mushKind: 'cap', capColor: [0.66, 0.18, 0.14] } },
];

// createDeadfallPalette({ types = DEFAULT_DEADFALL_TYPES, masterSeed = 1 }) ->
//   { variants: [{ geometry, kind, decayClass?, length?, height?, mushKind?, capColor?,... }],
//     types: [{ key, kind, decayClass?, startIdx, count }], masterSeed }.
// `variants[i]` are baked once; `types[i].startIdx/.count` index into `variants` for that type's
// seeds -- identical structure to createRockPalette so the same wiring pattern applies.
export function createDeadfallPalette(opts = {}) {
  const specs = opts.types || DEFAULT_DEADFALL_TYPES;
  const masterSeed = opts.masterSeed ?? 1;
  const variants = [];
  const types = [];
  for (let t = 0; t < specs.length; t++) {
    const spec = specs[t];
    const key = spec.key || `deadfall${t}`;
    const kind = spec.kind || 'log';
    const seedsPerType = Math.max(1, spec.seedsPerType ?? 1);
    const startIdx = variants.length;
    let decayClass;
    for (let v = 0; v < seedsPerType; v++) {
      const rng = rngFrom(masterSeed + t * 9791 + v * 641 + 1);
      if (kind === 'log') {
        const decay = spec.log?.decay ?? 'mossy';
        decayClass = decay;
        const { geometry, length } = buildLog({ rng, decay, shelf: spec.log?.shelf });
        variants.push({ geometry, kind, decayClass: decay, length, key });
      } else if (kind === 'stump') {
        const { geometry, height } = buildStump({ rng, flare: spec.stump?.flare });
        variants.push({ geometry, kind, height, key });
      } else { // mushroom
        const mushKind = spec.mushroom?.mushKind || 'cap';
        const { geometry } = buildMushroom({ rng, kind: mushKind, tone: spec.mushroom?.tone });
        variants.push({
          geometry, kind, mushKind, key,
          capColor: spec.mushroom?.capColor, gillColor: spec.mushroom?.gillColor, stemColor: spec.mushroom?.stemColor,
        });
      }
    }
    types.push({ key, kind, decayClass, startIdx, count: seedsPerType });
  }
  return { variants, types, masterSeed };
}
