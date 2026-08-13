// Shared procedural primitive vocabulary.
//
// Extracted from player-procedural-body.js so more than the humanoid rig can use it. Bots were the
// first consumer, not the only intended one: the model studio targets (props, weapons, creatures)
// build from this same nine-type vocabulary, which is what lets one validator reason about the cost
// of any of them.
//
// THE CACHE KEY IS THE COST MODEL. Every distinct key mints a geometry, and every geometry mints an
// InstancedMesh bucket downstream that is never evicted — so two plates differing only in bevel are
// two buckets. A unique-geometry budget is therefore checkable, not advisory.
//
// A descriptor is built in three stages: base primitive, then the ordered `modifiers` stack, then
// the `csg` stack. Primitives are free at runtime; the other two are not, so triangle budgets have
// to be measured on the finished geometry rather than on the primitive that started it.

import { applyModifiers } from './model-modifiers.js';
import { csgOp } from './model-csg.js';

export const PRIMITIVE_TYPES = Object.freeze([
  'rbox', 'dome', 'lathe', 'extrude', 'sphere', 'cylinder', 'capsule', 'torus', 'cone', 'tube',
]);

// Tessellation of the cheap rbox twin used by setGearLod(1). seg=1 is 156 triangles against the
// authored seg=3's 828, for the same silhouette with a flatter chamfer highlight.
export const GEAR_LOD_SEG = 1;

export function triangleCount(geo) {
  if (!geo) return 0;
  return geo.index ? geo.index.count / 3 : (geo.attributes?.position?.count ?? 0) / 3;
}

// One cache per factory by default. Growth is bounded two ways: the nuclear clear() (safe only when
// no consumer is alive), or refcount + sweep() for a permanently-alive consumer (the NPC suite).
// A consumer wraps its build in beginRecord()/endRecord() to retain exactly the geometry it touched,
// releaseAll()s that handle on teardown, and sweep()s to dispose only what no live consumer holds.
export function createGeometryCache() {
  const map = new Map();     // key -> geometry
  const refs = new Map();    // key -> live-holder count; absent/0 means unreferenced
  const touch = new Map();   // key -> monotonic seq (LRU ordering for sweep's keep pool)
  let seq = 0;
  let recording = null;      // Set of keys touched in the active record span; construction is synchronous + non-reentrant

  function retain(key) { refs.set(key, (refs.get(key) || 0) + 1); }
  function release(key) {
    const n = (refs.get(key) || 0) - 1;
    if (n > 0) refs.set(key, n);
    else { refs.delete(key); touch.set(key, ++seq); }  // now unreferenced -> eligible for sweep
  }

  return {
    map,
    get(key, build) {
      let g = map.get(key);
      if (!g) { g = build(); g.userData.shared = true; map.set(key, g); }
      touch.set(key, ++seq);
      if (recording) recording.add(key);
      return g;
    },
    // Record every key touched between begin/endRecord as one holder. endRecord retains them once
    // each and returns the handle; liveness is thus declared at BUILD, covering LOD twins, amputated
    // limbs and hidden bodies whose geometry a draw-derived signal would never see.
    beginRecord() { recording = new Set(); },
    endRecord() {
      const keys = recording ? [...recording] : [];
      recording = null;
      for (const k of keys) retain(k);
      return keys;
    },
    retain, release,
    releaseAll(keys) { if (keys) for (const k of keys) release(k); },
    // Dispose only unreferenced geometry, keeping the `keep` most-recently-used zero-ref entries as a
    // rebuild scratch pool. The safe, bounded replacement for clear() under a live consumer.
    // onDispose(geo) fires per dropped geometry before its dispose() — the seam the NPC suite uses to
    // drop the matching InstancedMesh bucket (batches.dropBucket) in the same tick.
    sweep(keep = 0, onDispose = null) {
      const dead = [];
      for (const key of map.keys()) if (!refs.get(key)) dead.push(key);
      dead.sort((a, b) => (touch.get(a) || 0) - (touch.get(b) || 0));  // oldest first
      const drop = keep > 0 ? dead.slice(0, Math.max(0, dead.length - keep)) : dead;
      for (const key of drop) {
        const geo = map.get(key);
        if (onDispose) onDispose(geo);
        geo.dispose(); map.delete(key); refs.delete(key); touch.delete(key);
      }
      return drop.length;
    },
    refcount(key) { return refs.get(key) || 0; },
    clear() {
      for (const geo of map.values()) geo.dispose();
      map.clear(); refs.clear(); touch.clear(); recording = null;
    },
    stats() {
      let tris = 0;
      for (const geo of map.values()) tris += triangleCount(geo);
      return { geometries: map.size, triangles: tris };
    },
  };
}

/**
 * `defaults` supplies the authoring fallbacks a descriptor may omit — currently `outlineSmooth`
 * (extrude) and `profileSmooth` (lathe resampling). They are options rather than descriptor fields
 * because they are a house style, not a property of the piece.
 */
export function createPrimitiveFactory({ THREE, cache = createGeometryCache(), defaults = {} }) {
  const sharedGeo = (key, build) => cache.get(key, build);

  function extrudeOutline(points, depth, segments, bevel, smooth = defaults.outlineSmooth) {
    const shape = new THREE.Shape();
    shape.moveTo(points[0][0], points[0][1]);
    if (smooth) {
      // splineThru curves the whole outline through the control points instead of cutting corners.
      shape.splineThru(points.slice(1).map(([x, y]) => new THREE.Vector2(x, y)));
    } else {
      for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
    }
    shape.closePath();
    return new THREE.ExtrudeGeometry(shape, {
      depth, steps: 1, curveSegments: segments,
      bevelEnabled: true, bevelSegments: segments, bevelThickness: bevel, bevelSize: bevel,
    });
  }

  // Resamples a [r, y] control polygon through a Catmull-Rom spline so a lathe's VERTICAL
  // silhouette is smooth too — radial segments only ever smoothed the horizontal direction.
  function smoothProfile(profile, count) {
    if (!(count > profile.length)) return profile;
    const curve = new THREE.SplineCurve(profile.map(([r, y]) => new THREE.Vector2(r, y)));
    return curve.getPoints(count - 1).map((p) => [p.x, p.y]);
  }

  function latheGeometry(profile, radialSegments = 18, profileSmooth = defaults.profileSmooth) {
    const pts = profileSmooth ? smoothProfile(profile, profileSmooth) : profile;
    return sharedGeo(`lathe|${radialSegments}|${pts.map((p) => p.join(',')).join(';')}`, () => {
      const points = pts.map(([r, y]) => new THREE.Vector2(Math.max(0.001, r), y));
      const geo = new THREE.LatheGeometry(points, radialSegments);
      geo.computeVertexNormals();
      return geo;
    });
  }

  // The base primitive, before modifiers and CSG, and deliberately UNCACHED: this is also how a CSG
  // cutter gets built, and a cutter is never rendered, so letting one into the cache would inflate
  // the geometry count the budget gate reads.
  function buildBase(g, segOverride = null) {
    {
      const s = g.size || [];
      switch (g.type) {
        case 'lathe': {
          const pts = (g.profile || [[0.05, -0.05], [0.05, 0.05]]).map(([r, y]) => new THREE.Vector2(Math.max(0.001, r), y));
          const geo = new THREE.LatheGeometry(pts, g.radial || 16);
          geo.computeVertexNormals();
          return geo;
        }
        // Rounded/chamfered box — the armour primitive. A raw BoxGeometry reads as a hard-edged
        // cube; this rounds the four outline corners AND bevels the extrusion edges, so plates
        // catch light on their chamfers like real armour. `size` is the FINAL outer size: the
        // shape is inset by the bevel so the bevel grows it back to exactly `size`.
        case 'rbox': {
          const w = s[0] ?? 0.1, h = s[1] ?? 0.1, d = s[2] ?? 0.1;
          const seg = segOverride ?? (g.seg || 3);
          // Keep the default chamfer TIGHT. A generous radius rounds plate into pillow and the
          // armour reads as inflated plastic rather than hard mil-spec plate.
          const bev = Math.min(g.bevel ?? Math.min(w, h, d) * 0.07, w * 0.45, h * 0.45, d * 0.45);
          const sw = Math.max(1e-4, w - bev * 2), sh = Math.max(1e-4, h - bev * 2);
          const r = Math.min(g.corner ?? Math.min(sw, sh) * 0.10, sw * 0.49, sh * 0.49);
          const shape = new THREE.Shape();
          const hw = sw * 0.5 - r, hh = sh * 0.5 - r;
          shape.moveTo(-hw, -sh * 0.5);
          shape.lineTo(hw, -sh * 0.5);
          shape.absarc(hw, -hh, r, -Math.PI / 2, 0);
          shape.lineTo(sw * 0.5, hh);
          shape.absarc(hw, hh, r, 0, Math.PI / 2);
          shape.lineTo(-hw, sh * 0.5);
          shape.absarc(-hw, hh, r, Math.PI / 2, Math.PI);
          shape.lineTo(-sw * 0.5, -hh);
          shape.absarc(-hw, -hh, r, Math.PI, Math.PI * 1.5);
          const depth = Math.max(1e-4, d - bev * 2);
          const geo = new THREE.ExtrudeGeometry(shape, {
            depth, steps: Math.max(1, g.lengthSeg || 1), curveSegments: seg * 2,
            bevelEnabled: true, bevelSegments: seg, bevelThickness: bev, bevelSize: bev,
          });
          geo.translate(0, 0, -depth * 0.5);
          geo.computeVertexNormals();
          return geo;
        }
        // A lathe whose bottom edge VARIES WITH AZIMUTH.
        //
        // A surface of revolution has one radius per height, so a `lathe` rim is a level ring at
        // every angle — same height at the front, the back and both sides. A combat helmet's
        // defining feature is the opposite: the edge sits above the brow at the front, sweeps up
        // over the ear, and drops at the nape. Built from `lathe` that shape is unreachable, so it
        // gets faked with a second part bolted on the back — and then reads as two objects stuck
        // together rather than one shell.
        //
        // `rim` is a cyclic [turn, y] table. turn 0 is +Z and turn 0.25 is +X, matching
        // LatheGeometry's phi origin so a profile can be moved between the two types unchanged.
        // The surface is the SAME revolution as `lathe` would produce, cut at a different height
        // all the way round. `wall` adds an inner face and a rim band, so the edge has visible
        // thickness and the piece isn't a bowl you can see up into.
        case 'dome': {
          const prof = (g.profile || [[0.05, 0], [0.001, 0.05]]).map(([r, y]) => [Math.max(5e-4, r), y]);
          const rimTable = g.rim || [[0, prof[0][1]]];
          const wall = g.wall ?? 0.006;
          const R = Math.max(6, g.radial || 28), S = Math.max(2, g.seg || 16);
          const yTop = prof[prof.length - 1][1];
          const radiusAt = (y) => {
            if (y <= prof[0][1]) return prof[0][0];
            for (let i = 1; i < prof.length; i++) {
              if (y <= prof[i][1]) {
                const t = (y - prof[i - 1][1]) / Math.max(1e-9, prof[i][1] - prof[i - 1][1]);
                return prof[i - 1][0] + t * (prof[i][0] - prof[i - 1][0]);
              }
            }
            return prof[prof.length - 1][0];
          };
          // Cyclic: the span from the last sample wraps forward to the first, so a table only has
          // to cover one turn and never has to repeat its opening value at 1.0.
          const rimAt = (turn) => {
            const u = ((turn % 1) + 1) % 1;
            for (let i = 0; i < rimTable.length; i++) {
              const a = rimTable[i], b = rimTable[(i + 1) % rimTable.length];
              const a0 = a[0], b0 = b[0] > a0 ? b[0] : b[0] + 1;
              const uu = u >= a0 ? u : u + 1;
              if (uu >= a0 && uu <= b0) return a[1] + ((uu - a0) / Math.max(1e-9, b0 - a0)) * (b[1] - a[1]);
            }
            return rimTable[0][1];
          };
          const pos = [], idx = [];
          const stride = (S + 1) * 2;                       // outer column then inner column
          for (let j = 0; j < R; j++) {                     // no duplicate seam ring: shared
            const phi = (j / R) * Math.PI * 2;              // vertices let computeVertexNormals
            const sin = Math.sin(phi), cos = Math.cos(phi); // average across the front seam
            const y0 = rimAt(j / R);
            for (let pass = 0; pass < 2; pass++) {
              for (let i = 0; i <= S; i++) {
                const y = y0 + (yTop - y0) * (i / S);
                const r = pass ? Math.max(5e-4, radiusAt(y) - wall) : radiusAt(y);
                pos.push(r * sin, y, r * cos);
              }
            }
          }
          const vo = (j, i) => j * stride + i;
          const vi = (j, i) => j * stride + (S + 1) + i;
          for (let j = 0; j < R; j++) {
            const n = (j + 1) % R;
            for (let i = 0; i < S; i++) {
              idx.push(vo(j, i), vo(n, i), vo(n, i + 1), vo(j, i), vo(n, i + 1), vo(j, i + 1));
              idx.push(vi(j, i), vi(n, i + 1), vi(n, i), vi(j, i), vi(j, i + 1), vi(n, i + 1));
            }
            // rim band: the visible edge thickness, skewed to follow the wavy bottom edge
            idx.push(vo(j, 0), vi(j, 0), vi(n, 0), vo(j, 0), vi(n, 0), vo(n, 0));
          }
          // Both surfaces converge on one apex, so the wall vanishes where nothing can see it and
          // the solid closes without a separate crown cap.
          const apex = pos.length / 3;
          pos.push(0, yTop, 0);
          for (let j = 0; j < R; j++) {
            const n = (j + 1) % R;
            idx.push(vo(j, S), vo(n, S), apex);
            idx.push(vi(n, S), vi(j, S), apex);
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
          geo.setIndex(idx);
          geo.computeVertexNormals();
          return geo;
        }
        // Outline-shaped gear (soles, panels, plates): the same extruder the boot/glove use, so
        // detail pieces can follow a silhouette instead of being boxes.
        case 'extrude': {
          const geo = extrudeOutline(g.outline || [[0, 0], [0.05, 0], [0.05, 0.05]], g.depth ?? 0.05, g.seg || 2, g.bevel ?? 0.004, g.smooth ?? defaults.outlineSmooth);
          if (g.axis === 'x') geo.rotateY(-Math.PI / 2);   // outline X becomes +Z (fore/aft)
          geo.computeBoundingBox();
          const c = geo.boundingBox.getCenter(new THREE.Vector3());
          geo.translate(g.axis === 'x' ? -c.x : 0, 0, g.axis === 'x' ? 0 : -c.z);
          geo.computeVertexNormals();
          return geo;
        }
        // A cross-section swept along a curve. Cables, hoses, slings, straps, railings, exhausts,
        // tails and vines are all this shape, and none of them are reachable from a surface of
        // revolution. The fake — a chain of cylinders — costs MORE geometries and still reads as
        // segments rather than as one continuous run.
        //
        // `section` is a closed [x, y] polygon in the frame plane, so a strap (flat) and a cable
        // (round) are the same primitive. Omitting it gives a circle of `radial` points.
        case 'tube': {
          const pts = (g.path || [[0, 0, 0], [0, 0.1, 0]]).map(([x, y, z]) => new THREE.Vector3(x, y, z));
          const loop = !!g.closed;
          const curve = new THREE.CatmullRomCurve3(pts, loop, g.curve || 'catmullrom', g.tension ?? 0.5);
          const tub = Math.max(1, g.seg ?? 16);
          const radius = s[0] ?? 0.02;
          const R = Math.max(3, g.radial || 8);
          const section = g.section || Array.from({ length: R }, (_, i) => {
            const a = (i / R) * Math.PI * 2;
            return [Math.cos(a), Math.sin(a)];
          });
          const M = section.length;
          const frames = curve.computeFrenetFrames(tub, loop);
          const rings = loop ? tub : tub + 1;
          const pos = [], idx = [];
          for (let i = 0; i < rings; i++) {
            const P = curve.getPointAt(i / tub);
            const N = frames.normals[i], B = frames.binormals[i];
            for (let j = 0; j < M; j++) {
              const cx = section[j][0] * radius, cy = section[j][1] * radius;
              pos.push(P.x + N.x * cx + B.x * cy, P.y + N.y * cx + B.y * cy, P.z + N.z * cx + B.z * cy);
            }
          }
          for (let i = 0; i < tub; i++) {
            const i0 = i * M, i1 = ((i + 1) % rings) * M;
            for (let j = 0; j < M; j++) {
              const j1 = (j + 1) % M;
              idx.push(i0 + j, i1 + j1, i1 + j, i0 + j, i0 + j1, i1 + j1);
            }
          }
          // Caps close the solid so it has a volume; an open tube is see-through from the ends.
          if (!loop && g.cap !== false) {
            const last = (rings - 1) * M;
            const a0 = pos.length / 3;
            const p0 = curve.getPointAt(0); pos.push(p0.x, p0.y, p0.z);
            const a1 = pos.length / 3;
            const p1 = curve.getPointAt(1); pos.push(p1.x, p1.y, p1.z);
            for (let j = 0; j < M; j++) {
              const j1 = (j + 1) % M;
              idx.push(a0, j1, j);
              idx.push(a1, last + j, last + j1);
            }
          }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
          geo.setIndex(idx);
          geo.computeVertexNormals();
          return geo;
        }
        case 'sphere': return new THREE.SphereGeometry(s[0] ?? 0.05, g.radial || 16, g.seg || 12);
        // lengthSeg exists for the modifier stack: a bend or a twist has nothing to move without
        // intermediate rings along the axis it acts on.
        case 'cylinder': return new THREE.CylinderGeometry(s[0] ?? 0.05, s[1] ?? s[0] ?? 0.05, s[2] ?? 0.1, g.radial || 14, g.lengthSeg || 1);
        case 'capsule': return new THREE.CapsuleGeometry(s[0] ?? 0.04, s[1] ?? 0.1, 4, g.radial || 10, g.lengthSeg || 1);
        case 'torus': return new THREE.TorusGeometry(s[0] ?? 0.08, s[1] ?? 0.02, g.seg || 10, g.radial || 20);
        case 'cone': return new THREE.ConeGeometry(s[0] ?? 0.05, s[1] ?? 0.1, g.radial || 14, g.lengthSeg || 1);
        default: {
          const n = g.lengthSeg || 1;
          return new THREE.BoxGeometry(s[0] ?? 0.1, s[1] ?? 0.1, s[2] ?? 0.1, n, n, n);
        }
      }
    }
  }

  // Builds and positions one CSG cutter. The cutter is a descriptor in its own right, so a hole can
  // be any shape the vocabulary can make, not just a cylinder.
  function cutterGeometry(entry) {
    const geo = buildBase(entry.shape || {});
    const m = new THREE.Matrix4();
    const p = entry.position || [0, 0, 0];
    const r = entry.rotation || [0, 0, 0];
    const sc = entry.scale ?? 1;
    const scale = Array.isArray(sc) ? sc : [sc, sc, sc];
    m.compose(
      new THREE.Vector3(p[0], p[1], p[2]),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0], r[1], r[2])),
      new THREE.Vector3(scale[0], scale[1], scale[2]),
    );
    geo.applyMatrix4(m);
    return geo;
  }

  function applyCsgStack(geo, stack) {
    let out = geo;
    for (const entry of stack) {
      const cutter = cutterGeometry(entry);
      const next = csgOp(THREE, entry.op || 'subtract', out, cutter);
      out.dispose();
      cutter.dispose();
      out = next;
    }
    out.computeBoundingBox();
    out.computeBoundingSphere();
    return out;
  }

  // segOverride builds a cheaper twin of the same piece (see GEAR_LOD_SEG). It is part of the cache
  // key, so the twin is shared across consumers exactly like the full-detail geometry.
  function geometryFor(g, segOverride = null) {
    // Every field the builders read must be in the key, or two pieces differing only by (say) a
    // bevel or a taper would silently share one cached geometry.
    const key = 'gear|' + JSON.stringify([
      g.type, g.profile, g.outline, g.size, g.radial, g.seg, g.bevel, g.corner, g.depth, g.axis,
      g.smooth, g.rim, g.wall, g.lengthSeg,
      g.path, g.section, g.closed, g.cap, g.curve, g.tension,
      g.modifiers, g.csg,
      segOverride,
    ]);
    return sharedGeo(key, () => {
      let geo = buildBase(g, segOverride);
      if (g.modifiers && g.modifiers.length) geo = applyModifiers(geo, g.modifiers);
      if (g.csg && g.csg.length) geo = applyCsgStack(geo, g.csg);
      return geo;
    });
  }

  return { geometryFor, buildBase, extrudeOutline, latheGeometry, smoothProfile, sharedGeo, cache };
}
