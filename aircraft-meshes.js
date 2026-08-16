// aircraft-meshes.js — a layout, drawn.
//
// The counterpart to `aircraft-layout.js`: that file measures a shape, this one builds it, and both
// read the SAME corner functions so the aircraft you fly and the aircraft you see cannot part
// company. That was the whole failure this subsystem exists to fix — `flight-meshes.js` draws a
// 29.9 m2 wing on a plane the physics flies with 16 m2, and nothing could tell.
//
// Materials come from the caller as `{ standard(color, emissive), basic(color, opacity) }`, the same
// contract `flight-meshes.js` uses, because the flight sim runs node materials and other pages do
// not.
//
// EVERY PART IS NAMED, and named with its ANCHOR name. That is what makes the studio's inspection
// tools possible: the bot design studio's `focusPart`/`measurePart`/`auditVisibility` all reach
// through `slot.body.joints`, a humanoid joint dictionary, which is why none of them work on
// anything that is not a person. Here they resolve against `group.userData.parts`, which is keyed by
// the same names `anchorsOf(layout)` returns.

import * as THREE from 'three';
import { registerCraftMesh } from './flight-meshes.js';
import { panelCorners, finCorners, hardpointsOf, exhaustsOf, mountsOf } from './aircraft-layout.js';

const ROLE_COLOR = { skin: null, dark: 0x2a3038, glass: 0x121a24, blade: 0x1d2228, trim: 0x6d757d };

function roleMaterial(role, tint, m) {
  if (role === 'glass') return m.standard(ROLE_COLOR.glass, 0x0a1520);
  const c = ROLE_COLOR[role];
  return m.standard(c == null ? tint : c);
}

// ---------------------------------------------------------------------------
// A tapered slab, from the same corners the bounds are measured off.
//
// Not a scaled box: a box cannot taper, and taper is most of what distinguishes a wing from a plank.
// Corner order per side is [rootBack, rootFront, tipBack, tipFront] at -t then +t.
// ---------------------------------------------------------------------------

function slabFromCorners(c8, flip) {
  const pos = new Float32Array(24);
  for (let i = 0; i < 8; i++) { pos[i * 3] = c8[i][0]; pos[i * 3 + 1] = c8[i][1]; pos[i * 3 + 2] = c8[i][2]; }
  // 0..3 lower face, 4..7 upper face, each as [rootBack, rootFront, tipBack, tipFront]
  const idx = [
    0, 2, 3, 0, 3, 1,     // lower
    4, 7, 6, 4, 5, 7,     // upper
    0, 1, 5, 0, 5, 4,     // root
    2, 6, 7, 2, 7, 3,     // tip
    1, 3, 7, 1, 7, 5,     // trailing edge
    0, 4, 6, 0, 6, 2,     // leading edge
  ];
  // A mirrored panel has its winding reversed by the mirroring, so its faces would point inward and
  // the whole left wing would render as holes from outside. Reverse the triangles back.
  if (flip) for (let i = 0; i < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------

export function buildAircraftMesh(layout, tint = 0xc9d4e2, m, opts = {}) {
  const g = new THREE.Group();
  const parts = {};
  const rotors = [];
  const wings = [];
  const hardpoints = {};
  const add = (name, mesh) => { parts[name] = mesh; g.add(mesh); return mesh; };

  const f = layout.fuselage;
  if (!f) {
    // Every aircraft has a root anchor whether or not it has a fuselage — a multirotor's body is
    // its hull pod, but `body` still has to be a thing the studio can point a camera at.
    add('body', new THREE.Object3D());
  }
  if (f) {
    const body = roleMaterial('skin', tint, m);
    let fuse;
    if (f.shape === 'ellipsoid') {
      fuse = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), body);
      fuse.scale.set(f.radius, f.height ?? f.radius, f.length / 2);
    } else {
      fuse = new THREE.Mesh(new THREE.CapsuleGeometry(f.radius, f.length, 6, 12), body);
      fuse.rotation.x = Math.PI / 2;
    }
    add('body', fuse);
    const half = f.shape === 'ellipsoid' ? f.length / 2 : f.length / 2 + f.radius;
    // `tail` is an anchor, not a part: it is where an exhaust or a tail store attaches
    const tail = new THREE.Object3D(); tail.position.z = half; add('tail', tail);
    if (f.noseLength) {
      const nose = new THREE.Mesh(new THREE.ConeGeometry(f.tailRadius ?? f.radius, f.noseLength, 12), body);
      nose.rotation.x = -Math.PI / 2;
      nose.position.z = -(half + f.noseLength / 2);
      add('nose', nose);
    } else {
      const nose = new THREE.Object3D(); nose.position.z = -half; add('nose', nose);
    }
  }

  for (const w of layout.wings || []) {
    const c = panelCorners(w);
    const mat = roleMaterial(w.role || 'skin', tint, m);
    // one mesh per side, each under its own pivot, so a flapping layout has something to rotate
    for (const [i, side] of [[0, 1], [1, -1]]) {
      const pivot = new THREE.Group();
      pivot.position.set(w.x || 0, w.y || 0, w.z || 0);
      const local = c.slice(i * 8, i * 8 + 8).map((p) => [p[0] - (w.x || 0), p[1] - (w.y || 0), p[2] - (w.z || 0)]);
      const mesh = new THREE.Mesh(slabFromCorners(local, side < 0), mat);
      pivot.add(mesh);
      g.add(pivot);
      parts[`${w.id}.${side > 0 ? 'r' : 'l'}`] = mesh;
      if (w.lifting !== false) wings.push({ pivot, side, wing: mesh });
    }
    const root = new THREE.Object3D();
    root.position.set(w.x || 0, w.y || 0, w.z || 0);
    add(`${w.id}.root`, root);
    const tip = new THREE.Object3D();
    tip.position.set((w.x || 0) + w.span / 2, (w.y || 0) + Math.tan(w.dihedral || 0) * (w.span / 2),
      (w.z || 0) + Math.tan(w.sweep || 0) * (w.span / 2));
    add(`${w.id}.tip`, tip);
  }

  for (const s of layout.fins || []) {
    const c = finCorners(s);
    // ALWAYS FLIPPED. A fin's basis is (thickness +x, span +y, chord +z) where a wing's is
    // (thickness +y, span +x, chord +z) — opposite handedness — so the same corner ordering winds
    // the fin inside out. It renders as a hole from outside and as a solid fin from within the
    // fuselage, which is not a view anybody checks.
    const mesh = new THREE.Mesh(slabFromCorners(c, true), roleMaterial(s.role || 'skin', tint, m));
    add(s.id, mesh);
    const root = new THREE.Object3D(); root.position.set(s.x || 0, s.y || 0, s.z || 0);
    add(`${s.id}.root`, root);
    const tip = new THREE.Object3D();
    tip.position.set(s.x || 0, (s.y || 0) + s.height, (s.z || 0) + Math.tan(s.sweep || 0) * s.height);
    add(`${s.id}.tip`, tip);
  }

  for (const p of layout.pods || []) {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(p.radius, p.radius, p.length, 12),
      roleMaterial(p.role || 'skin', tint, m));
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set(p.x || 0, p.y || 0, p.z || 0);
    add(p.id, mesh);
  }

  for (const r of layout.rotors || []) {
    const dark = roleMaterial('blade', tint, m);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(r.radius * 0.16, r.radius * 0.16, r.radius * 0.26, 8), dark);
    hub.position.set(r.x || 0, r.y || 0, r.z || 0);
    add(r.id, hub);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(r.radius, r.radius, r.radius * 0.035, 16),
      m.basic(0xbfd8ee, 0.30));
    disc.position.set(r.x || 0, (r.y || 0) + r.radius * 0.02, r.z || 0);
    g.add(disc);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(r.radius * 1.9, r.radius * 0.035, r.radius * 0.16), dark);
    blade.position.copy(disc.position);
    g.add(blade);
    rotors.push(blade);
  }

  // Stores hang here. Empty anchors rather than meshes, because what hangs on one is a weapon
  // descriptor's business, not the airframe's.
  for (const hp of hardpointsOf(layout)) {
    const o = new THREE.Object3D();
    o.position.set(hp.p[0], hp.p[1], hp.p[2]);
    add(hp.id, o);
    hardpoints[hp.id] = o;
    if (opts.showHardpoints) {
      const pyl = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, hp.chord * 0.4), roleMaterial('trim', tint, m));
      pyl.position.y = 0.08;
      o.add(pyl);
    }
  }

  // Side-gun mounts: a barrel along the mount's boresight, out of the same `pos`/`dir` the sim
  // fires from, so a drawn barrel and a fired round cannot disagree about where the muzzle is. The
  // barrel mesh is what a gunner-camera later trains, so it is a part, not just an anchor.
  const mounts = {};
  for (const mt of mountsOf(layout)) {
    const o = new THREE.Object3D();
    o.position.set(mt.pos[0], mt.pos[1], mt.pos[2]);
    add(mt.id, o);
    const len = mt.barrel ?? 1.6;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, len, 8), roleMaterial('dark', tint, m));
    // a cylinder stands on +y; point it along dir and slide it half out of the hull
    barrel.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3().fromArray(mt.dir));
    barrel.position.set(mt.dir[0] * len * 0.5, mt.dir[1] * len * 0.5, mt.dir[2] * len * 0.5);
    o.add(barrel);
    mounts[mt.id] = o;
  }
  if (Object.keys(mounts).length) g.userData.mounts = mounts;

  // Exhaust flames. `poseMesh` in the flight sim dispatches on these userData keys rather than on
  // the airframe name, so a layout-built craft animates without the viewer knowing it exists.
  // A LIST, because a twin-engined aircraft has two and the first version of this could only say
  // one — which is the kind of thing you only discover by building a second aircraft.
  const flames = [];
  for (const e of exhaustsOf(layout)) {
    const flame = new THREE.Mesh(new THREE.ConeGeometry(e.radius, e.length, 10), m.basic(0x8fd0ff, 0.85));
    flame.rotation.x = Math.PI / 2;
    flame.position.set(e.x || 0, e.y || 0, e.z || 0);
    add(e.id, flame);
    flames.push(flame);
  }
  if (flames.length) g.userData.flame = flames;

  if (rotors.length) g.userData.rotors = rotors;
  if (wings.length && layout.class === 'bird') g.userData.wings = wings;
  g.userData.parts = parts;
  g.userData.hardpoints = hardpoints;
  g.userData.layout = layout;
  g.traverse((o) => { o.frustumCulled = false; });
  return g;
}

// Resolves a part name the way a studio's inspection tools need to: an anchor name, a side-suffixed
// panel, or a bare wing id meaning both of its sides.
// Registers a layout with `flight-meshes.js` so the sim can build it by name. This is what makes a
// studio-authored aircraft VISIBLE as well as flyable.
export function registerLayoutMesh(key, layout) {
  return registerCraftMesh(key, (tint, materials) => buildAircraftMesh(layout, tint, materials));
}

export function partsNamed(group, name) {
  const parts = group.userData.parts || {};
  if (parts[name]) return [parts[name]];
  const both = [parts[`${name}.r`], parts[`${name}.l`]].filter(Boolean);
  if (both.length) return both;
  return [];
}
