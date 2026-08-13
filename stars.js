// stars.js
// TSL rendering of the star field + Milky Way for the WebGPU sky. Geometry/attributes
// come from sky-field.js (pure, Node-tested); this file only builds node materials.
// Twinkle runs entirely on the GPU via the built-in `time` node — no per-frame JS.
import * as THREE from 'three';
import { PointsNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu';
import { Fn, attribute, uniform, float, vec3, vec4, sin, cos, floor, fract, abs, pow,
  length, smoothstep, mix, positionLocal, normalize, max, dot, time, varying } from 'three/tsl';

// Shared builder: a Points cloud with per-star twinkle attributes → GPU-animated size +
// brightness, soft round sprites. `data` is a generateStars()/generateMilkyWay() result.
function buildPoints(data, { color, opacity, twinkle, renderOrder }) {
  const count = data.count ?? data.bandCount;
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
  geom.setAttribute('aBright', new THREE.BufferAttribute(data.brightness, 1));
  geom.setAttribute('aPhase',  new THREE.BufferAttribute(data.phase, 1));
  geom.setAttribute('aSpeed',  new THREE.BufferAttribute(data.speed, 1));
  geom.setAttribute('aSize',   new THREE.BufferAttribute(data.size, 1));
  // strength is foreground-only; default to a constant for the band.
  const strengthArr = data.strength || new Float32Array(count).fill(twinkle);
  geom.setAttribute('aStrength', new THREE.BufferAttribute(strengthArr, 1));

  const mat = new PointsNodeMaterial({ transparent: true, depthWrite: false });
  mat.fog = false;
  const uColor = uniform(new THREE.Color(color));
  const uOpacity = uniform(opacity);

  // NOTE: on the WebGPU backend, THREE.Points renders 1px point primitives — sizeNode is
  // ignored and there is no point-sprite coordinate (pointUV -> gl_PointCoord, which is not
  // valid WGSL). So we cannot vary size or draw a round falloff here; we twinkle via
  // brightness/alpha instead. Per-vertex values consumed in the fragment stage must be
  // wrapped in varying() or the generated WGSL is invalid.
  const tw = float(1).add(attribute('aStrength').mul(sin(time.mul(attribute('aSpeed')).add(attribute('aPhase')))));
  const vFactor = varying(attribute('aBright').mul(max(tw, float(0.0))));
  mat.colorNode = vec4(uColor.mul(vFactor), vFactor.mul(uOpacity));

  const pts = new THREE.Points(geom, mat);
  pts.frustumCulled = false;
  pts.renderOrder = renderOrder;
  pts.material._uColor = uColor;
  pts.material._uOpacity = uOpacity;
  return pts;
}

// Foreground sky stars (strong twinkle). renderOrder -997 sits IN FRONT of the Milky Way
// (band -998, gas -999) but BEHIND the celestial bodies (-996) and sun/moon disc (-995), so
// opaque planets occlude the background star field instead of stars twinkling over them.
export function createSkyStars(starData, palette) {
  return buildPoints(starData, {
    color: palette.starColor, opacity: palette.starOpacity, twinkle: 0.3, renderOrder: -997,
  });
}

// value-noise hash → smooth 3D noise (compact, GPU-cheap; enough for soft gas)
const hash = Fn(([p]) => fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))).mul(43758.5453)));
const noise3 = Fn(([p]) => {
  const i = floor(p), f = fract(p);
  const u = f.mul(f).mul(float(3).sub(f.mul(2)));
  const n000 = hash(i.add(vec3(0,0,0))), n100 = hash(i.add(vec3(1,0,0)));
  const n010 = hash(i.add(vec3(0,1,0))), n110 = hash(i.add(vec3(1,1,0)));
  const n001 = hash(i.add(vec3(0,0,1))), n101 = hash(i.add(vec3(1,0,1)));
  const n011 = hash(i.add(vec3(0,1,1))), n111 = hash(i.add(vec3(1,1,1)));
  const x00 = mix(n000, n100, u.x), x10 = mix(n010, n110, u.x);
  const x01 = mix(n001, n101, u.x), x11 = mix(n011, n111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z);
});

// Milky Way: a dim back-side gas sphere (layered noise) + the dense band points.
export function createMilkyWay(milkyData, palette) {
  if (!milkyData) return null;
  const group = new THREE.Group();
  const radius = Math.hypot(milkyData.position[0], milkyData.position[1], milkyData.position[2]) / 0.82;

  // ---- Gas inner sphere ----
  const gas = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false,
    side: THREE.BackSide, blending: THREE.AdditiveBlending });
  gas.fog = false;
  const uIntensity = uniform(palette.milkyWayIntensity);
  const uTilt = uniform(milkyData.tilt);
  const warm = new THREE.Color('#5a4636'), cool = new THREE.Color('#2c3a5a');
  gas.colorNode = Fn(() => {
    const dir = normalize(positionLocal);
    // distance from the tilted galactic plane (band about X axis tilted by uTilt)
    const plane = dir.y.mul(cos(uTilt)).sub(dir.z.mul(sin(uTilt)));
    const band = smoothstep(0.22, 0.0, abs(plane));
    const p = dir.mul(2.8);
    const n = noise3(p).mul(0.6).add(noise3(p.mul(2.3)).mul(0.28)).add(noise3(p.mul(4.7)).mul(0.12));
    const cloud = pow(n, float(2.0));                // contrast → patchy clouds, not a solid lobe
    const dust = smoothstep(0.0, 0.05, abs(plane.add(n.mul(0.06).sub(0.03)))); // dark central lane
    const col = mix(vec3(cool.r, cool.g, cool.b), vec3(warm.r, warm.g, warm.b), cloud);
    return col.mul(band).mul(cloud).mul(dust).mul(uIntensity).mul(0.6);
  })();
  gas.opacityNode = float(1);
  const gasMesh = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.995, 40, 18), gas);
  gasMesh.renderOrder = -999; gasMesh.frustumCulled = false;
  gasMesh.material._uIntensity = uIntensity;

  // ---- Band points ----
  const band = buildPoints(milkyData, {
    color: palette.starColor, opacity: 0.9, twinkle: 0.15, renderOrder: -998,
  });

  group.add(gasMesh, band);
  group.userData.gas = gasMesh;
  return group;
}
