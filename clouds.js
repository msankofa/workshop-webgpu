// clouds.js
// Overhead cloud plane for three.js / WebGPU.  A large quad is rendered with an
// unlit MeshBasicNodeMaterial whose colorNode/opacityNode are built entirely from
// TSL node expressions — no onBeforeCompile, no GLSL strings.  The visual
// behaviour is a faithful port of the previous onBeforeCompile GLSL shader.
//
// GLSL → TSL correspondence (cloud effects):
//
//  DRIFT (time-scrolled UV)
//    GLSL: snoise(vUv * (5.0 / uPuff) + uTime / 40.0)
//          + snoise(vUv * (10.0 / uPuff) + uTime / 30.0)
//    TSL:  snoise(uvCoord.mul(float(5).div(uPuff)).add(uTime.div(40)))
//          .add(snoise(uvCoord.mul(float(10).div(uPuff)).add(uTime.div(30))))
//    Note: scalar + vec2 broadcasts in both GLSL and TSL.
//
//  COVERAGE / SOFTNESS  (smoothstep threshold)
//    GLSL: smoothstep(0.5 - uSoftness, 0.5 + uSoftness, 0.5*n + uCoverage)
//    TSL:  smoothstep(float(0.5).sub(uSoftness),
//                     float(0.5).add(uSoftness),
//                     float(0.5).mul(n).add(uCoverage))
//
//  PUFF (cloud scale / frequency)
//    GLSL: vUv * (5.0 / uPuff)  (larger puff → lower frequency → bigger puffs)
//    TSL:  uvCoord.mul(float(5).div(uPuff))
//
//  HORIZON FADE
//    GLSL: diffuseColor.a = cloud * opacity / (uFade * length(vWorldPosition))
//    TSL:  opacityNode = cloudVal.mul(uOpacity).div(uFade.mul(length(positionWorld)))
//    Note: positionWorld is the interpolated world position of each fragment on the
//          plane (equivalent to the GLSL vWorldPosition varying for a flat mesh).
//
//  COLOR
//    GLSL: diffuseColor = vec4(1,1,1, …alpha…)
//    TSL:  colorNode = vec3(1,1,1)   +  opacityNode = alpha
//
//  SIMPLEX NOISE (permute + snoise) — exact arithmetic port, line by line:
//    permute(x)  = mod(((x*34)+1)*x, 289)         → permute3 Fn node
//    snoise(v)   — see inline comments below       → snoise Fn node
//
// Usage (unchanged from the GLSL version):
//   import { Clouds } from './clouds.js';
//   const clouds = new Clouds();
//   clouds.rotation.x = -Math.PI / 2;
//   clouds.position.y = 400;
//   scene.add(clouds);
//   // each frame:
//   clouds.update(performance.now() / 1000);

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  uniform, positionWorld,
  Fn, vec2, vec3, float,
  floor, fract, dot, abs, max, mod, smoothstep, select, length, greaterThan,
} from 'three/tsl';

// ---- Module-level TSL function nodes (pure math; safe to share across instances) ----

// GLSL: vec3 permute(vec3 x) { return mod(((x*34.0)+1.0)*x, 289.0); }
const permute3 = Fn(([x]) => mod(x.mul(34.0).add(1.0).mul(x), 289.0));

// 2D simplex noise — arithmetic-exact port of the GLSL snoise() that appeared in
// the previous GLSL-based clouds.js.  Input: vec2.  Output: float ≈ [-1, 1].
//
// Correspondence to GLSL snoise(vec2 v):
//
//   const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
//   vec2 i  = floor(v + dot(v, C.yy));
//     → floor(v.add(dot(v, vec2(Cy, Cy))))
//
//   vec2 x0 = v - i + dot(i, C.xx);
//     → v.sub(i).add(dot(i, vec2(Cx, Cx)))
//
//   i1 = (x0.x > x0.y) ? vec2(1,0) : vec2(0,1);
//     → select(greaterThan(x0.x, x0.y), vec2(1,0), vec2(0,1))
//
//   vec4 x12 = x0.xyxy + C.xxzz; x12.xy -= i1;
//     → x12_xy = x0.add(vec2(Cx,Cx)).sub(i1)   (x12.xy part)
//        x12_zw = x0.add(vec2(Cz,Cz))            (x12.zw part)
//
//   i = mod(i, 289.0);
//   vec3 p = permute(permute(i.y + vec3(0,i1.y,1)) + i.x + vec3(0,i1.x,1));
//     → permute3(permute3(imod.y.add(vec3(0,i1.y,1))).add(imod.x).add(vec3(0,i1.x,1)))
//
//   vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
//   m = m*m; m = m*m;  (raises to power 4)
//     → m_raw = max(float(0.5).sub(vec3(dot(x0,x0), dot(x12_xy,x12_xy), dot(x12_zw,x12_zw))), 0.0)
//        m4 = m_raw.mul(m_raw).mul(m_raw.mul(m_raw))
//   Note: m4 is computed by squaring m_raw to get m2, then squaring m2 to get m4.
//         The alias m_sq is used to name the intermediate square.
//
//   vec3 x = 2.0 * fract(p * C.www) - 1.0;
//     → fract(p.mul(Cw)).mul(2.0).sub(1.0)
//
//   vec3 h = abs(x) - 0.5; vec3 ox = floor(x + 0.5); vec3 a0 = x - ox;
//     → abs(x).sub(0.5); floor(x.add(0.5)); x.sub(ox)
//
//   m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
//     → m4.mul(float(1.79284291400159).sub(float(0.85373472095314).mul(a0.mul(a0).add(h.mul(h)))))
//
//   g.x  = a0.x * x0.x  + h.x  * x0.y;
//   g.yz = a0.yz * x12.xz + h.yz * x12.yw;
//     → gx = a0.x.mul(x0.x).add(h.x.mul(x0.y))
//        gy = a0.y.mul(x12_xy.x).add(h.y.mul(x12_xy.y))   [x12.x, x12.y]
//        gz = a0.z.mul(x12_zw.x).add(h.z.mul(x12_zw.y))   [x12.z, x12.w]
//   Note: x12.xz = [x12_xy.x, x12_zw.x]; x12.yw = [x12_xy.y, x12_zw.y]
//
//   return 130.0 * dot(m, g);
//     → float(130.0).mul(dot(mfinal, vec3(gx, gy, gz)))
const snoise = Fn(([v]) => {
  // Simplex skewing constants (vec4 C in the GLSL)
  const Cx = 0.211324865405187;
  const Cy = 0.366025403784439;
  const Cz = -0.577350269189626;
  const Cw = 0.024390243902439;

  // Skew v into simplex space and find the integer cell corner
  const i  = floor(v.add(dot(v, vec2(Cy, Cy))));
  // Relative position within the simplex cell
  const x0 = v.sub(i).add(dot(i, vec2(Cx, Cx)));

  // Which triangle: choose the second corner offset
  const i1 = select(greaterThan(x0.x, x0.y), vec2(1.0, 0.0), vec2(0.0, 1.0));

  // Positions of the other two simplex corners relative to x0:
  //   x12.xy = x0 + C.xx - i1   (corner 1)
  //   x12.zw = x0 + C.zz        (corner 2; C.zz = -0.5 - 2*C.xx)
  const x12_xy = x0.add(vec2(Cx, Cx)).sub(i1);
  const x12_zw = x0.add(vec2(Cz, Cz));

  // Permute to get gradient indices
  const imod = mod(i, 289.0);
  const p    = permute3(
    permute3(imod.y.add(vec3(0.0, i1.y, 1.0))).add(imod.x).add(vec3(0.0, i1.x, 1.0))
  );

  // Kernel weights — radial basis falloff, raised to 4th power
  const dists = vec3(dot(x0, x0), dot(x12_xy, x12_xy), dot(x12_zw, x12_zw));
  const m_raw = max(float(0.5).sub(dists), 0.0);
  const m_sq  = m_raw.mul(m_raw);   // m^2
  const m4    = m_sq.mul(m_sq);     // m^4

  // Gradient directions from permuted hashes
  const x  = fract(p.mul(Cw)).mul(2.0).sub(1.0);
  const h  = abs(x).sub(0.5);
  const ox = floor(x.add(0.5));
  const a0 = x.sub(ox);

  // Normalise gradients implicitly by scaling m
  const mfinal = m4.mul(
    float(1.79284291400159).sub(float(0.85373472095314).mul(a0.mul(a0).add(h.mul(h))))
  );

  // Compute gradient dot products
  //   g.x  = a0.x * x0.x  + h.x  * x0.y
  //   g.yz = a0.yz * x12.xz + h.yz * x12.yw  (where x12.xz=[x12_xy.x, x12_zw.x],
  //                                                    x12.yw=[x12_xy.y, x12_zw.y])
  const gx = a0.x.mul(x0.x).add(h.x.mul(x0.y));
  const gy = a0.y.mul(x12_xy.x).add(h.y.mul(x12_xy.y));
  const gz = a0.z.mul(x12_zw.x).add(h.z.mul(x12_zw.y));

  return float(130.0).mul(dot(mfinal, vec3(gx, gy, gz)));
});

// ---- Clouds class ----

export class Clouds extends THREE.Mesh {
  constructor() {
    super();

    // drift speed multiplier + a self-accumulated clock, so changing speed at
    // runtime nudges the rate without jumping the noise phase
    this.speed = 1.0;
    this._scaledTime = 0;
    this._lastTime = undefined;

    // ---- TSL uniform handles ----
    const uTime      = uniform(0.0,  'float');   // scaled elapsed time (seconds)
    const uCoverage  = uniform(0.4,  'float');   // noise bias → cloud cover
    const uPuff      = uniform(1.0,  'float');   // noise frequency divisor → puff size
    const uSoftness  = uniform(0.3,  'float');   // smoothstep half-width
    const uFade      = uniform(0.01, 'float');   // horizon-fade rate
    const uOpacity   = uniform(0.9,  'float');   // base alpha multiplier
    const uCameraXZ  = uniform(new THREE.Vector2(), 'vec2'); // camera XZ for horizon fade

    // World-space XZ position normalised to ~1 unit per 1000 world units.
    // Using positionWorld instead of UV keeps the noise frequency fixed in world
    // space, so clouds don't stretch when the plane is scaled via setExtent().
    const uvCoord = positionWorld.xz.div(1000.0);

    // ---- Two-octave simplex noise with time drift ----
    // GLSL: float n = snoise(vUv*(5/uPuff) + uTime/40) + snoise(vUv*(10/uPuff) + uTime/30)
    // Scalar uTime/40 broadcasts to both UV components (same in GLSL and TSL).
    const n = snoise(uvCoord.mul(float(5.0).div(uPuff)).add(uTime.div(40.0)))
               .add(snoise(uvCoord.mul(float(10.0).div(uPuff)).add(uTime.div(30.0))));

    // ---- Soft cloud coverage threshold ----
    // GLSL: float cloud = smoothstep(0.5 - uSoftness, 0.5 + uSoftness, 0.5*n + uCoverage)
    const cloudVal = smoothstep(
      float(0.5).sub(uSoftness),
      float(0.5).add(uSoftness),
      float(0.5).mul(n).add(uCoverage)
    );

    // ---- Horizon fade by XZ distance from the camera ----
    // Measures how far each fragment is from the camera horizontally, so the fade
    // is always camera-centred regardless of where in the world the camera sits.
    // +1 avoids division-by-zero directly overhead.
    const horizDist = length(positionWorld.xz.sub(uCameraXZ)).add(1.0);
    const alpha = cloudVal.mul(uOpacity).div(uFade.mul(horizDist));

    // ---- Assemble unlit material ----
    const mat = new MeshBasicNodeMaterial({
      transparent: true,
      side: THREE.DoubleSide,
      fog: false,   // clouds use their own horizon fade; scene fog (far=terrain size) would clamp them to the map edge
    });
    // Clouds are pure white; all shading is in the alpha channel.
    mat.colorNode   = vec3(1, 1, 1);
    mat.opacityNode = alpha;

    // Expose uniform handles so the public setters can update them live
    mat._uTime     = uTime;
    mat._uCoverage = uCoverage;
    mat._uPuff     = uPuff;
    mat._uSoftness = uSoftness;
    mat._uFade     = uFade;
    mat._uOpacity  = uOpacity;
    mat._uCameraXZ = uCameraXZ;

    this.material = mat;

    // Large flat quad overhead — same geometry as the GLSL version
    this.geometry = new THREE.PlaneGeometry(2000, 2000);
    this.frustumCulled = false;
  }

  // Advance the scrolling-time uniform.  Call once per frame with elapsed seconds.
  // cameraPosition (THREE.Vector3) keeps the horizon fade centred on the camera.
  update(elapsedTime, cameraPosition) {
    if (this._lastTime !== undefined) this._scaledTime += (elapsedTime - this._lastTime) * this.speed;
    this._lastTime = elapsedTime;
    this.material._uTime.value = this._scaledTime;
    if (cameraPosition) this.material._uCameraXZ.value.set(cameraPosition.x, cameraPosition.z);
  }

  // Public API — same signatures as the GLSL version; now write to TSL uniform handles.
  setSpeed(speed)       { this.speed = speed; }
  setOpacity(opacity)   { this.material._uOpacity.value = opacity; }
  setCoverage(coverage) { this.material._uCoverage.value = coverage; }
  setPuff(puff)         { this.material._uPuff.value = puff; }
  setSoftness(softness) { this.material._uSoftness.value = softness; }
  setFade(fade)         { this.material._uFade.value = fade; }
  setExtent(worldUnits) {
    const s = worldUnits / 2000;
    // Mesh is laid flat via rotation.x=-PI/2, so the plane spans local X and Y
    // (local Z is the normal). Scale both in-plane axes, not X/Z.
    this.scale.set(s, s, 1);
  }
}

export default Clouds;
