// blast-debris.js — draws the arrays blast-debris-sim.js keeps: shrapnel (tetrahedra + additive glow
// shells), rubble (dodecahedra + glow shells + a fixed pool of point lights on the hottest pieces),
// sparks (triangular prisms), and the debris smoke (soft billboards). One InstancedMesh per kind,
// filled immediate-mode from the sim every frame; `mesh.count` is the live length so nothing has to
// be hidden. The geometry choices are html-game-v2's (src/game/main.js:215-395); the smoke is the one
// departure — theirs is low-poly spheres with a flat-colour shader, ours is the same instanced sprite
// pool effect-renderer.js and demos/volumetric-smoke.html already prove under WebGPU.
//
// Colours arriving from the sim are sRGB floats; they are converted here.

import { MeshBasicNodeMaterial, MeshStandardNodeMaterial, SpriteNodeMaterial } from 'three/webgpu';
import { attribute, texture } from 'three/tsl';

export function createDebrisRenderer({ THREE, scene, sim, lightCount = 8, softTexture = null }) {
  const cap = sim.caps;
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
  const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();
  const SRGB = THREE.SRGBColorSpace;

  function instanced(geo, mat, n, order) {
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.renderOrder = order;
    scene.add(mesh);
    return mesh;
  }
  const glowMat = (opacity) => new MeshBasicNodeMaterial({
    transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, fog: false,
  });

  const shrapnelMesh = instanced(new THREE.TetrahedronGeometry(1, 0),
    new MeshBasicNodeMaterial({ fog: true }), cap.shrapnel, 5);
  const shrapnelGlow = instanced(new THREE.SphereGeometry(1, 7, 5), glowMat(0.5), cap.shrapnel, 10);
  const rubbleMesh = instanced(new THREE.DodecahedronGeometry(1, 0),
    new MeshStandardNodeMaterial({ roughness: 0.95, metalness: 0.04 }), cap.rubble, 4);
  const rubbleGlow = instanced(new THREE.SphereGeometry(1, 8, 6), glowMat(0.58), cap.rubble, 10);
  const sparkMesh = instanced(new THREE.CylinderGeometry(1, 1, 1, 3),
    new MeshBasicNodeMaterial({ fog: false, toneMapped: false }), cap.sparks, 9);

  // Rubble lights: html-game-v2's eight, kept in the scene at zero intensity so the light count in
  // the shader never changes.
  const lights = Array.from({ length: lightCount }, () => {
    const l = new THREE.PointLight(0xff5a18, 0, 4.8);
    l.position.set(0, -999, 0);
    scene.add(l);
    return l;
  });

  // Smoke: instanced soft billboards, the makePool shape.
  const tex = softTexture || makeSoft(THREE);
  const smoke = (() => {
    const n = cap.smoke;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n), alpha = new Float32Array(n);
    geo.setAttribute('instPos', new THREE.InstancedBufferAttribute(pos, 3));
    geo.setAttribute('instColor', new THREE.InstancedBufferAttribute(col, 3));
    geo.setAttribute('instSize', new THREE.InstancedBufferAttribute(size, 1));
    geo.setAttribute('instAlpha', new THREE.InstancedBufferAttribute(alpha, 1));
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    const mat = new SpriteNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.NormalBlending, fog: true });
    mat.positionNode = attribute('instPos', 'vec3');
    mat.scaleNode = attribute('instSize', 'float');
    mat.colorNode = attribute('instColor', 'vec3');
    mat.opacityNode = attribute('instAlpha', 'float').mul(texture(tex).a);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; mesh.updateMatrix(); mesh.renderOrder = 12;
    scene.add(mesh);
    return { geo, mat, mesh, pos, col, size, alpha };
  })();

  const show = { shrapnel: true, rubble: true, sparks: true, smoke: true, glow: true, lights: true };
  const stats = { shrapnel: 0, rubble: 0, sparks: 0, smoke: 0, lights: 0 };

  function writeShrapnel() {
    const list = sim.shrapnel;
    let n = 0, gn = 0;
    if (show.shrapnel) {
      for (let i = 0; i < list.length; i++) {
        const p = list[i];
        _e.set(p.rx, p.ry, p.rz); _q.setFromEuler(_e);
        _p.set(p.x, p.y, p.z); _s.setScalar(p.scale * p.fade);
        _m.compose(_p, _q, _s);
        shrapnelMesh.setMatrixAt(n, _m);
        _c.setRGB(p.r, p.g, p.b, SRGB); shrapnelMesh.setColorAt(n, _c);
        n++;
        if (show.glow && p.glowNow > 0) {
          _s.setScalar(p.glowNow); _m.compose(_p, _q, _s);
          shrapnelGlow.setMatrixAt(gn, _m);
          _c.setRGB(p.gr, p.gg, p.gb, SRGB); shrapnelGlow.setColorAt(gn, _c);
          gn++;
        }
      }
    }
    shrapnelMesh.count = n; shrapnelGlow.count = gn;
    if (n) { shrapnelMesh.instanceMatrix.needsUpdate = true; shrapnelMesh.instanceColor.needsUpdate = true; }
    if (gn) { shrapnelGlow.instanceMatrix.needsUpdate = true; shrapnelGlow.instanceColor.needsUpdate = true; }
    stats.shrapnel = n;
  }

  function writeRubble() {
    const list = sim.rubble;
    let n = 0, gn = 0;
    if (show.rubble) {
      for (let i = 0; i < list.length; i++) {
        const r = list[i];
        _e.set(r.rx, r.ry, r.rz); _q.setFromEuler(_e);
        _p.set(r.x, r.y, r.z); _s.set(r.scaleX * r.fade, r.scaleY * r.fade, r.scaleZ * r.fade);
        _m.compose(_p, _q, _s);
        rubbleMesh.setMatrixAt(n, _m);
        _c.setRGB(r.r, r.g, r.b, SRGB); rubbleMesh.setColorAt(n, _c);
        n++;
        if (show.glow && r.glowNow > 0) {
          _p.set(r.x, r.y + r.radius * 0.24, r.z); _s.setScalar(r.glowNow); _q.identity();
          _m.compose(_p, _q, _s);
          rubbleGlow.setMatrixAt(gn, _m);
          _c.setRGB(r.gr, r.gg, r.gb, SRGB); rubbleGlow.setColorAt(gn, _c);
          gn++;
        }
      }
    }
    rubbleMesh.count = n; rubbleGlow.count = gn;
    if (n) { rubbleMesh.instanceMatrix.needsUpdate = true; rubbleMesh.instanceColor.needsUpdate = true; }
    if (gn) { rubbleGlow.instanceMatrix.needsUpdate = true; rubbleGlow.instanceColor.needsUpdate = true; }
    stats.rubble = n;
    // Lights follow the hottest pieces; the rest park out of the way at zero.
    const hot = show.rubble && show.lights ? sim.hottestRubble(lights.length) : [];
    for (let i = 0; i < lights.length; i++) {
      const l = lights[i], r = hot[i];
      if (r) {
        l.position.set(r.x, r.y + r.radius * 0.45, r.z);
        l.color.setRGB(1, r.lightG ?? 0.3, 0.06, SRGB);
        l.intensity = r.light; l.distance = r.lightDist;
      } else { l.intensity = 0; l.position.set(0, -999, 0); }
    }
    stats.lights = hot.length;
  }

  function writeSparks() {
    const list = sim.sparks;
    let n = 0;
    if (show.sparks) {
      for (let i = 0; i < list.length; i++) {
        const p = list[i], f = p.life / p.maxLife;
        _e.set(p.rx, p.ry, p.rz); _q.setFromEuler(_e);
        _p.set(p.x, p.y, p.z); _s.set(p.radiusScale * f, p.heightScale * f, p.radiusScale * f);
        _m.compose(_p, _q, _s);
        sparkMesh.setMatrixAt(n, _m);
        _c.setRGB(p.r, p.g, p.b, SRGB); sparkMesh.setColorAt(n, _c);
        n++;
      }
    }
    sparkMesh.count = n;
    if (n) { sparkMesh.instanceMatrix.needsUpdate = true; sparkMesh.instanceColor.needsUpdate = true; }
    stats.sparks = n;
  }

  function writeSmoke() {
    const list = sim.smoke;
    let n = 0;
    if (show.smoke) {
      for (let i = 0; i < list.length; i++) {
        const p = list[i], t = 1 - p.life / p.maxLife;
        const a = Math.max(0, p.life / p.maxLife) * p.baseOpacity;
        if (a <= 0.005) continue;
        // A sphere of radius s reads as a sprite roughly 2s wide.
        const size = p.baseScale * (1 + t * p.expandRate) * 2;
        _c.setRGB(p.r, p.g, p.b, SRGB);
        smoke.pos[n * 3] = p.x; smoke.pos[n * 3 + 1] = p.y; smoke.pos[n * 3 + 2] = p.z;
        smoke.col[n * 3] = _c.r; smoke.col[n * 3 + 1] = _c.g; smoke.col[n * 3 + 2] = _c.b;
        smoke.size[n] = size; smoke.alpha[n] = a;
        n++;
      }
    }
    smoke.geo.instanceCount = n;
    smoke.mesh.visible = n > 0;
    if (n) for (const k of ['instPos', 'instColor', 'instSize', 'instAlpha']) smoke.geo.attributes[k].needsUpdate = true;
    stats.smoke = n;
  }

  function sync() { writeShrapnel(); writeRubble(); writeSparks(); writeSmoke(); }

  function dispose() {
    for (const m of [shrapnelMesh, shrapnelGlow, rubbleMesh, rubbleGlow, sparkMesh, smoke.mesh]) {
      scene.remove(m); m.geometry.dispose(); m.material.dispose();
    }
    for (const l of lights) scene.remove(l);
  }

  return { sync, show, stats, dispose, meshes: { shrapnelMesh, shrapnelGlow, rubbleMesh, rubbleGlow, sparkMesh, smoke: smoke.mesh }, lights };
}

// Radial white→transparent puff, same as effect-renderer.js's makeSoftTexture.
function makeSoft(THREE) {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
