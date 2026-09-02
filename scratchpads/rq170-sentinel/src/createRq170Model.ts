import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

type SdfVector = readonly [number, number, number];
type SdfTransform = { position?: SdfVector; translation?: SdfVector; rotation?: SdfVector; scale?: SdfVector };
type SdfPrimitive = {
  readonly id: string;
  readonly type: 'sphere' | 'capsule' | 'box' | 'cone' | 'ellipsoid';
  readonly center?: SdfVector;
  readonly radius?: number | SdfVector;
  readonly height?: number;
  readonly size?: SdfVector;
  readonly dimensions?: SdfVector;
  readonly radii?: SdfVector;
  readonly transform?: SdfTransform;
};
type SdfOperation = {
  readonly id?: string;
  readonly output?: string;
  readonly type: 'smooth-union' | 'subtract' | 'intersect';
  readonly left: string;
  readonly right: string;
  readonly radius?: number;
};
type SdfDescriptor = {
  readonly primitives: readonly SdfPrimitive[];
  readonly operations?: readonly SdfOperation[];
  readonly resolution: number;
  readonly bounds?: { readonly min: SdfVector; readonly max: SdfVector };
};
type SdfFunction = (point: THREE.Vector3) => number;

function sdfSphere(point: THREE.Vector3, radius: number): number {
  return point.length() - radius;
}

function sdfCapsule(point: THREE.Vector3, radius: number, height: number): number {
  const halfHeight = height * 0.5;
  const y = Math.max(-halfHeight, Math.min(halfHeight, point.y));
  return point.distanceTo(new THREE.Vector3(0, y, 0)) - radius;
}

function sdfBox(point: THREE.Vector3, size: SdfVector): number {
  const q = new THREE.Vector3(Math.abs(point.x), Math.abs(point.y), Math.abs(point.z))
    .sub(new THREE.Vector3(size[0] * 0.5, size[1] * 0.5, size[2] * 0.5));
  return q.clone().max(new THREE.Vector3()).length() + Math.min(Math.max(q.x, q.y, q.z), 0);
}

function sdfCone(point: THREE.Vector3, radius: number, height: number): number {
  const halfHeight = height * 0.5;
  const taper = radius * (1 - (point.y + halfHeight) / height);
  return Math.max(Math.hypot(point.x, point.z) - Math.max(0, taper), Math.abs(point.y) - halfHeight);
}

function sdfEllipsoid(point: THREE.Vector3, radii: SdfVector): number {
  const scaled = new THREE.Vector3(point.x / radii[0], point.y / radii[1], point.z / radii[2]);
  return (scaled.length() - 1) * Math.min(radii[0], radii[1], radii[2]);
}

function sdfRadii(primitive: SdfPrimitive): SdfVector {
  const radius = primitive.radius;
  if (primitive.radii) return primitive.radii;
  if (typeof radius === 'number') return [radius, radius, radius];
  return radius ?? [0.5, 0.5, 0.5];
}

function smin(left: number, right: number, radius: number): number {
  const blend = Math.max(radius - Math.abs(left - right), 0) / radius;
  return Math.min(left, right) - blend * blend * radius * 0.25;
}

function sdfLocalPoint(point: THREE.Vector3, primitive: SdfPrimitive): { point: THREE.Vector3; scale: number } {
  const transform = primitive.transform;
  const translation = transform?.position ?? transform?.translation ?? primitive.center ?? [0, 0, 0];
  const rotation = transform?.rotation ?? [0, 0, 0];
  const scale = transform?.scale ?? [1, 1, 1];
  const local = point.clone().sub(new THREE.Vector3(translation[0], translation[1], translation[2]));
  const inverseRotation = new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2]))
    .invert();
  local.applyQuaternion(inverseRotation);
  local.set(local.x / scale[0], local.y / scale[1], local.z / scale[2]);
  return { point: local, scale: Math.min(scale[0], scale[1], scale[2]) };
}

function sdfPrimitive(point: THREE.Vector3, primitive: SdfPrimitive): number {
  const local = sdfLocalPoint(point, primitive);
  let distance: number;
  switch (primitive.type) {
    case 'sphere':
      distance = sdfSphere(local.point, typeof primitive.radius === 'number' ? primitive.radius : 0.5);
      break;
    case 'capsule':
      distance = sdfCapsule(local.point, typeof primitive.radius === 'number' ? primitive.radius : 0.25, primitive.height ?? 1);
      break;
    case 'box':
      distance = sdfBox(local.point, primitive.size ?? primitive.dimensions ?? [1, 1, 1]);
      break;
    case 'cone':
      distance = sdfCone(local.point, typeof primitive.radius === 'number' ? primitive.radius : 0.5, primitive.height ?? 1);
      break;
    case 'ellipsoid':
      distance = sdfEllipsoid(local.point, sdfRadii(primitive));
      break;
  }
  return distance * local.scale;
}

function sdfSample(descriptor: SdfDescriptor): SdfFunction {
  const nodes = new Map<string, SdfFunction>();
  for (const primitive of descriptor.primitives) nodes.set(primitive.id, (point) => sdfPrimitive(point, primitive));
  let result = descriptor.primitives.length > 0 ? nodes.get(descriptor.primitives[0].id) : undefined;
  for (let index = 0; index < (descriptor.operations?.length ?? 0); index += 1) {
    const operation = descriptor.operations?.[index];
    if (!operation) continue;
    const left = nodes.get(operation.left);
    const right = nodes.get(operation.right);
    if (!left || !right) continue;
    let combined: SdfFunction;
    switch (operation.type) {
      case 'smooth-union':
        combined = (point) => smin(left(point), right(point), operation.radius ?? 0.1);
        break;
      case 'subtract':
        combined = (point) => Math.max(left(point), -right(point));
        break;
      case 'intersect':
        combined = (point) => Math.max(left(point), right(point));
        break;
    }
    nodes.set(operation.id ?? operation.output ?? `operation-${index}`, combined);
    result = combined;
  }
  return result ?? (() => Infinity);
}

function polygonizeSdf(descriptor: SdfDescriptor): THREE.BufferGeometry {
  // SURFACE NETS, not a voxel shell.
  //
  // This used to emit one axis-aligned quad per exposed voxel face, which is a Minecraft surface:
  // every face is axis-aligned, every edge is a 90-degree step, and the result is stair-stepped at
  // exactly the scale of the sampling grid. For a subject whose whole identity is smooth blended
  // organic form -- which is the only kind of subject anyone reaches for an implicit surface to
  // build -- that is worse than the assembled primitives it was meant to replace.
  //
  // Naive surface nets places ONE vertex per sign-changing cell, at the average of the linearly
  // interpolated crossings on that cell's edges, and joins the four cells around each crossing
  // edge into a quad. It is compact, manifold, and smooth, and it is a natural fit for a field
  // that can be sampled anywhere rather than only at corners.
  //
  // Normals come from the field GRADIENT, not from face averaging: the gradient is the exact
  // surface normal of the implicit surface, so shading no longer carries the grid's imprint.
  const resolution = Math.max(4, Math.min(64, Math.floor(descriptor.resolution)));
  const defaultBounds: { readonly min: SdfVector; readonly max: SdfVector } = { min: [-2, -2, -2], max: [2, 2, 2] };
  const bounds = descriptor.bounds ?? defaultBounds;
  const min = new THREE.Vector3(bounds.min[0], bounds.min[1], bounds.min[2]);
  const step = new THREE.Vector3(
    (bounds.max[0] - bounds.min[0]) / resolution,
    (bounds.max[1] - bounds.min[1]) / resolution,
    (bounds.max[2] - bounds.min[2]) / resolution,
  );
  const sample = sdfSample(descriptor);
  const scratch = new THREE.Vector3();

  // Corner grid: one more corner than cells on each axis.
  const side = resolution + 1;
  const field = new Float32Array(side * side * side);
  const cornerAt = (x: number, y: number, z: number): number => (z * side + y) * side + x;
  for (let z = 0; z < side; z += 1) {
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        scratch.set(min.x + x * step.x, min.y + y * step.y, min.z + z * step.z);
        field[cornerAt(x, y, z)] = sample(scratch);
      }
    }
  }

  // The 12 cell edges as corner-offset pairs.
  const CUBE_EDGES: readonly (readonly [number, number, number, number, number, number])[] = [
    [0, 0, 0, 1, 0, 0], [1, 0, 0, 1, 1, 0], [0, 1, 0, 1, 1, 0], [0, 0, 0, 0, 1, 0],
    [0, 0, 1, 1, 0, 1], [1, 0, 1, 1, 1, 1], [0, 1, 1, 1, 1, 1], [0, 0, 1, 0, 1, 1],
    [0, 0, 0, 0, 0, 1], [1, 0, 0, 1, 0, 1], [1, 1, 0, 1, 1, 1], [0, 1, 0, 0, 1, 1],
  ];

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const cellVertex = new Int32Array(resolution * resolution * resolution).fill(-1);
  const cellAt = (x: number, y: number, z: number): number => (z * resolution + y) * resolution + x;

  // Central-difference gradient, stepped at a fraction of a cell so it follows the field rather
  // than the grid.
  const epsilon = Math.min(step.x, step.y, step.z) * 0.25;
  const gradient = (point: THREE.Vector3): THREE.Vector3 => {
    const gx = sample(scratch.set(point.x + epsilon, point.y, point.z))
      - sample(scratch.set(point.x - epsilon, point.y, point.z));
    const gy = sample(scratch.set(point.x, point.y + epsilon, point.z))
      - sample(scratch.set(point.x, point.y - epsilon, point.z));
    const gz = sample(scratch.set(point.x, point.y, point.z + epsilon))
      - sample(scratch.set(point.x, point.y, point.z - epsilon));
    const normal = new THREE.Vector3(gx, gy, gz);
    // A point where the field is flat has no defined normal; +Y is arbitrary but finite, and
    // leaving a zero vector would poison every lighting calculation downstream.
    return normal.lengthSq() < 1e-20 ? new THREE.Vector3(0, 1, 0) : normal.normalize();
  };

  for (let z = 0; z < resolution; z += 1) {
    for (let y = 0; y < resolution; y += 1) {
      for (let x = 0; x < resolution; x += 1) {
        let crossings = 0;
        let sumX = 0;
        let sumY = 0;
        let sumZ = 0;
        for (const [ax, ay, az, bx, by, bz] of CUBE_EDGES) {
          const a = field[cornerAt(x + ax, y + ay, z + az)];
          const b = field[cornerAt(x + bx, y + by, z + bz)];
          if ((a <= 0) === (b <= 0)) continue;
          const t = a / (a - b);
          sumX += (ax + (bx - ax) * t);
          sumY += (ay + (by - ay) * t);
          sumZ += (az + (bz - az) * t);
          crossings += 1;
        }
        if (crossings === 0) continue;
        const px = min.x + (x + sumX / crossings) * step.x;
        const py = min.y + (y + sumY / crossings) * step.y;
        const pz = min.z + (z + sumZ / crossings) * step.z;
        cellVertex[cellAt(x, y, z)] = positions.length / 3;
        positions.push(px, py, pz);
        const normal = gradient(new THREE.Vector3(px, py, pz));
        normals.push(normal.x, normal.y, normal.z);
      }
    }
  }

  // One quad per sign-changing grid edge, joining the four cells that share it.
  //
  // Winding, worked out rather than guessed. For the +x edge from corner (x,y,z), the four cells
  // around it are (x, y-1, z-1), (x, y, z-1), (x, y, z), (x, y-1, z); in the (y,z) plane that
  // traversal is +y, +z, -y, whose cross product is +x. So when the corner is INSIDE and its
  // neighbour is outside, the unflipped order already faces out, and the flip belongs on the
  // opposite case. Getting this backwards is invisible in the normals -- those come from the
  // gradient and stay correct -- and shows only as back-face culling removing the front surface,
  // i.e. the model rendering as a hollow shell with its interior visible.
  const quad = (a: number, b: number, c: number, d: number, flip: boolean): void => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) indices.push(a, c, b, a, d, c);
    else indices.push(a, b, c, a, c, d);
  };
  // Each quad joins the FOUR cells sharing one grid edge, so every one of those cells must exist.
  // Bounding only the edge axis and the lower end of the other two let y/z reach `resolution`, which
  // is a corner index, not a cell index: `cellAt` then strides into an unrelated slot (with
  // resolution 8, `cellAt(3, 8, 1)` is 131 -- the slot for cell (3, 0, 2)) or past the end of the
  // array, where a typed-array read yields `undefined`. `undefined < 0` is false, so the guard in
  // `quad` passed it through to `setIndex`, which coerces it to 0. Measured on a sphere reaching its
  // own bounds at resolution 8: 60 out-of-range reads and 108 aliased reads. A surface that touches
  // the sampling box is therefore left OPEN at that face rather than closed with wrong triangles --
  // pad `bounds` past the surface to get a closed mesh.
  for (let z = 0; z < side; z += 1) {
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        const here = field[cornerAt(x, y, z)] <= 0;
        if (x + 1 < side && y > 0 && z > 0 && y < side - 1 && z < side - 1
          && here !== (field[cornerAt(x + 1, y, z)] <= 0)) {
          quad(
            cellVertex[cellAt(x, y - 1, z - 1)], cellVertex[cellAt(x, y, z - 1)],
            cellVertex[cellAt(x, y, z)], cellVertex[cellAt(x, y - 1, z)], !here,
          );
        }
        if (y + 1 < side && x > 0 && z > 0 && x < side - 1 && z < side - 1
          && here !== (field[cornerAt(x, y + 1, z)] <= 0)) {
          quad(
            cellVertex[cellAt(x - 1, y, z - 1)], cellVertex[cellAt(x - 1, y, z)],
            cellVertex[cellAt(x, y, z)], cellVertex[cellAt(x, y, z - 1)], !here,
          );
        }
        if (z + 1 < side && x > 0 && y > 0 && x < side - 1 && y < side - 1
          && here !== (field[cornerAt(x, y, z + 1)] <= 0)) {
          quad(
            cellVertex[cellAt(x - 1, y - 1, z)], cellVertex[cellAt(x, y - 1, z)],
            cellVertex[cellAt(x, y, z)], cellVertex[cellAt(x - 1, y, z)], !here,
          );
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

type TaperedStation = { position: [number, number, number]; rx: number; rz: number; twist?: number };

// Frames come from PARALLEL TRANSPORT, not from a Frenet frame. A Frenet frame is defined by
// the curve's normal, which flips sign wherever the path has an inflection or straightens out,
// and every flip twists the surface 180 degrees within one segment. Carrying the previous frame
// forward and removing only its along-path component keeps the twist continuous. THREE's own
// extrudePath and TubeGeometry do not expose this, which is why this is hand-built.
function buildTaperedSweepGeometry(
  sweep: { stations: TaperedStation[]; radialSegments?: number; capEnds?: boolean },
): THREE.BufferGeometry {
  const stations = sweep.stations;
  if (stations.length < 2) throw new Error('tapered-sweep needs at least two stations');
  const radial = Math.max(3, sweep.radialSegments ?? 10);
  const centres = stations.map((s) => new THREE.Vector3(...s.position));

  const tangents = centres.map((_, i) => {
    const prev = centres[Math.max(0, i - 1)];
    const next = centres[Math.min(centres.length - 1, i + 1)];
    const t = next.clone().sub(prev);
    // Coincident neighbours would normalise to NaN and poison every downstream vertex.
    return t.lengthSq() < 1e-12 ? new THREE.Vector3(0, 1, 0) : t.normalize();
  });

  // Seed a reference axis that is not parallel to the first tangent, or the first cross
  // product is degenerate and the whole sweep collapses to a line.
  let ref = new THREE.Vector3(0, 0, 1);
  if (Math.abs(tangents[0].dot(ref)) > 0.9) ref = new THREE.Vector3(1, 0, 0);

  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  let carried = ref.clone().sub(tangents[0].clone().multiplyScalar(ref.dot(tangents[0]))).normalize();
  for (let i = 0; i < tangents.length; i += 1) {
    const t = tangents[i];
    // Project the carried frame back onto the plane perpendicular to this tangent.
    const n = carried.clone().sub(t.clone().multiplyScalar(carried.dot(t)));
    if (n.lengthSq() < 1e-12) {
      const fallback = Math.abs(t.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      n.copy(fallback.sub(t.clone().multiplyScalar(fallback.dot(t))));
    }
    n.normalize();
    normals.push(n);
    binormals.push(new THREE.Vector3().crossVectors(t, n).normalize());
    carried = n;
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const ringStart: number[] = [];
  const isPoint: boolean[] = [];

  for (let i = 0; i < stations.length; i += 1) {
    const st = stations[i];
    const v = i / (stations.length - 1);
    ringStart.push(positions.length / 3);
    // A station whose section has collapsed emits ONE vertex, not a ring of radius zero.
    // A degenerate ring still carries `radial` coincident vertices and `radial` zero-area
    // triangles, so the lock ends in a blunt cap the width of the floating-point noise
    // rather than at a point -- and a hair lock, a horn or a blade tip has to reach a point.
    if (st.rx <= 1e-6 && st.rz <= 1e-6) {
      isPoint.push(true);
      positions.push(centres[i].x, centres[i].y, centres[i].z);
      uvs.push(0.5, v);
      continue;
    }
    isPoint.push(false);
    const twist = ((st.twist ?? 0) * Math.PI) / 180;
    for (let j = 0; j <= radial; j += 1) {
      const theta = (j / radial) * Math.PI * 2 + twist;
      const offset = normals[i].clone().multiplyScalar(Math.cos(theta) * st.rx)
        .add(binormals[i].clone().multiplyScalar(Math.sin(theta) * st.rz));
      const p = centres[i].clone().add(offset);
      positions.push(p.x, p.y, p.z);
      uvs.push(j / radial, v);
    }
  }

  for (let i = 0; i < stations.length - 1; i += 1) {
    const a0 = ringStart[i];
    const b0 = ringStart[i + 1];
    if (isPoint[i] && isPoint[i + 1]) continue;   // two collapsed stations bound nothing
    for (let j = 0; j < radial; j += 1) {
      // Wound so the face normal points radially OUTWARD.
      //
      // Ring vertices advance from `normal` toward `binormal`, and binormal is
      // tangent x normal, so increasing theta runs counter-clockwise seen from the
      // far end of the segment. Taking the ring-to-ring edge first therefore puts
      // the cross product on the inside. Measured as signed volume on the built
      // mesh: every tapered-sweep came out negative -- a torso at -0.0674 and a
      // tail at -0.0044 against a positive ellipsoid head -- so every sweep this
      // generator has ever emitted rendered its back faces, with normals pointing
      // into the solid and every lighting judgement made on the wrong surface.
      if (isPoint[i]) indices.push(a0, b0 + j + 1, b0 + j);
      else if (isPoint[i + 1]) indices.push(a0 + j, a0 + j + 1, b0);
      else indices.push(a0 + j, a0 + j + 1, b0 + j, a0 + j + 1, b0 + j + 1, b0 + j);
    }
  }

  if (sweep.capEnds ?? true) {
    for (const end of [0, stations.length - 1]) {
      if (isPoint[end]) continue;   // a point end is already closed
      const centreIndex = positions.length / 3;
      positions.push(centres[end].x, centres[end].y, centres[end].z);
      uvs.push(0.5, end === 0 ? 0 : 1);
      const base = ringStart[end];
      for (let j = 0; j < radial; j += 1) {
        if (end === 0) indices.push(centreIndex, base + j + 1, base + j);
        else indices.push(centreIndex, base + j, base + j + 1);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: RQ-170 Sentinel
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createRQ170SentinelModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "RQ-170 Sentinel";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["airframe"] = createSculptMaterial(
    "airframe",
    {"id": "airframe", "name": "Low-observable composite skin", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#BDB9B2", "color": "#BDB9B2", "albedo": {"dominant": "#BDB9B2", "secondary": ["#F5F5F5", "#FAFAF9", "#E1E1E0"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_albedo.png", "url": "pbr/airframe/airframe_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#F7F7F7", "#F5F5F5", "#FAFAF9", "#E1E1E0", "#EFEFEE"], "pattern": "reference-derived pixel palette", "amplitude": 0.0, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.315, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.218, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.094, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.68, "variation": 0.05, "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_roughness.png", "url": "pbr/airframe/airframe_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.175, "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_normal.png", "url": "pbr/airframe/airframe_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_height.png", "url": "pbr/airframe/airframe_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.01, "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_height.png", "url": "pbr/airframe/airframe_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_ao.png", "url": "pbr/airframe/airframe_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "roundel-stbd", "name": "Roundel starboard", "region": "roundel-stbd", "albedo": "#2B2C2E", "roughness": 0.6, "note": "decal, albedo only"}, {"id": "roundel-port", "name": "Roundel port", "region": "roundel-port", "albedo": "#2B2C2E", "roughness": 0.6, "note": "decal, albedo only"}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "referencePbr": {"version": "1.0", "sourceImage": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\matcrops\\airframe.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.743, "estimatedFidelity": 0.743, "targetThreshold": 0.6, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_albedo.png", "url": "pbr/airframe/airframe_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_roughness.png", "url": "pbr/airframe/airframe_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_height.png", "url": "pbr/airframe/airframe_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_normal.png", "url": "pbr/airframe/airframe_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_ao.png", "url": "pbr/airframe/airframe_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 100, "sourceHeight": 60, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 51, "width": 61, "height": 9}, "mask": {"backgroundColor": "#C0C0BE", "backgroundNoise": 17.321, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.0362}, "mapStats": {"valueRange": 0.0986, "heightP90Gradient": 0.01623, "roughnessBase": 0.68, "roughnessVariation": 0.05, "normalStrength": 0.175, "blurRadius": 21}, "palette": ["#F7F7F7", "#F5F5F5", "#FAFAF9", "#E1E1E0", "#EFEFEE"]}, "warnings": ["foreground mask is very small", "single-image inverse rendering cannot prove true physical PBR; confidence is capped", "low value range weakens height/roughness inference"]}},
    options
  );
  materialMap["dark-polymer"] = createSculptMaterial(
    "dark-polymer",
    {"id": "dark-polymer", "name": "Tyres, duct interiors, markings", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#2B2C2E", "color": "#2B2C2E", "albedo": {"dominant": "#2B2C2E", "secondary": ["#777776", "#ABABAB", "#333332"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\dark-polymer\\dark-polymer_albedo.png", "url": "pbr/dark-polymer/dark-polymer_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#919190", "#777776", "#ABABAB", "#333332", "#E6E6E6"], "pattern": "reference-derived pixel palette", "amplitude": 0.0, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.52, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.309, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.14, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.701, "variation": 0.067, "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\dark-polymer\\dark-polymer_roughness.png", "url": "pbr/dark-polymer/dark-polymer_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.201, "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\dark-polymer\\dark-polymer_normal.png", "url": "pbr/dark-polymer/dark-polymer_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\dark-polymer\\dark-polymer_height.png", "url": "pbr/dark-polymer/dark-polymer_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.017, "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\dark-polymer\\dark-polymer_height.png", "url": "pbr/dark-polymer/dark-polymer_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\dark-polymer\\dark-polymer_ao.png", "url": "pbr/dark-polymer/dark-polymer_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "referencePbr": {"version": "1.0", "sourceImage": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\matcrops\\dark-polymer.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.794, "estimatedFidelity": 0.794, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\dark-polymer\\dark-polymer_albedo.png", "url": "pbr/dark-polymer/dark-polymer_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\dark-polymer\\dark-polymer_roughness.png", "url": "pbr/dark-polymer/dark-polymer_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\dark-polymer\\dark-polymer_height.png", "url": "pbr/dark-polymer/dark-polymer_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\dark-polymer\\dark-polymer_normal.png", "url": "pbr/dark-polymer/dark-polymer_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\dark-polymer\\dark-polymer_ao.png", "url": "pbr/dark-polymer/dark-polymer_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 30, "sourceHeight": 30, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 30, "height": 30}, "mask": {"backgroundColor": "#3A3A3A", "backgroundNoise": 193.99, "transparentPixelFraction": 0.0, "foregroundCoverage": 1.0}, "mapStats": {"valueRange": 0.6863, "heightP90Gradient": 0.03778, "roughnessBase": 0.701, "roughnessVariation": 0.067, "normalStrength": 0.201, "blurRadius": 21}, "palette": ["#919190", "#777776", "#ABABAB", "#333332", "#E6E6E6"]}, "warnings": ["foreground mask is tiny; material extraction is likely unreliable", "image is not clearly isolated from background; using most pixels as material evidence", "object/background separation is weak", "single-image inverse rendering cannot prove true physical PBR; confidence is capped"]}},
    options
  );
  materialMap["gear-metal"] = createSculptMaterial(
    "gear-metal",
    {"id": "gear-metal", "name": "Gear struts and bogies", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#D6D6D3", "color": "#D6D6D3", "albedo": {"dominant": "#D6D6D3", "secondary": ["#90908E", "#9E9E9C", "#898987"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\gear-metal\\gear-metal_albedo.png", "url": "pbr/gear-metal/gear-metal_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#838381", "#90908E", "#9E9E9C", "#898987", "#797977"], "pattern": "reference-derived pixel palette", "amplitude": 0.0, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.336, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.234, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.103, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.68, "variation": 0.05, "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\gear-metal\\gear-metal_roughness.png", "url": "pbr/gear-metal/gear-metal_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.6, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.18, "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\gear-metal\\gear-metal_normal.png", "url": "pbr/gear-metal/gear-metal_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\gear-metal\\gear-metal_height.png", "url": "pbr/gear-metal/gear-metal_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.01, "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\gear-metal\\gear-metal_height.png", "url": "pbr/gear-metal/gear-metal_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\gear-metal\\gear-metal_ao.png", "url": "pbr/gear-metal/gear-metal_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "referencePbr": {"version": "1.0", "sourceImage": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\matcrops\\gear-metal.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.831, "estimatedFidelity": 0.831, "targetThreshold": 0.7, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\gear-metal\\gear-metal_albedo.png", "url": "pbr/gear-metal/gear-metal_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\gear-metal\\gear-metal_roughness.png", "url": "pbr/gear-metal/gear-metal_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\gear-metal\\gear-metal_height.png", "url": "pbr/gear-metal/gear-metal_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\gear-metal\\gear-metal_normal.png", "url": "pbr/gear-metal/gear-metal_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\gear-metal\\gear-metal_ao.png", "url": "pbr/gear-metal/gear-metal_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 15, "sourceHeight": 40, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 0, "width": 15, "height": 40}, "mask": {"backgroundColor": "#4D4D4B", "backgroundNoise": 29.445, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.1833}, "mapStats": {"valueRange": 0.1608, "heightP90Gradient": 0.02007, "roughnessBase": 0.68, "roughnessVariation": 0.05, "normalStrength": 0.18, "blurRadius": 21}, "palette": ["#838381", "#90908E", "#9E9E9C", "#898987", "#797977"]}, "warnings": ["single-image inverse rendering cannot prove true physical PBR; confidence is capped", "low value range weakens height/roughness inference"]}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_root_0 = makeAttachmentEndpoint(null);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "Centre body (hull, dorsal hump, carved intake, blunt tail)__pivot";
  node_root_0.scale.set(1, 1, 1);
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "Centre body (hull, dorsal hump, carved intake, blunt tail)", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "A blended lens with a dorsal hump and a blunt tail; only a smooth-union field gives the hump-to-hull fillet the render shows.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "sdf": {"primitives": [{"id": "hull", "type": "ellipsoid", "center": [0, -0.59, -0.7], "radii": [1.75, 0.44, 2.7]}, {"id": "tail", "type": "box", "center": [0, -0.28, 1.85], "size": [1.3, 0.5, 1.3]}, {"id": "hump-head", "type": "ellipsoid", "center": [0, -0.12, -1.4], "radii": [0.9, 0.62, 1.5]}, {"id": "hump-tail", "type": "ellipsoid", "center": [0, -0.15, 0.5], "radii": [0.62, 0.45, 1.9]}, {"id": "intake", "type": "box", "center": [0, 0.2, -2.5], "size": [0.7, 0.16, 0.4]}], "operations": [{"type": "smooth-union", "left": "hull", "right": "tail", "radius": 0.45, "output": "u0"}, {"type": "smooth-union", "left": "u0", "right": "hump-head", "radius": 0.35, "output": "u1"}, {"type": "smooth-union", "left": "u1", "right": "hump-tail", "radius": 0.35, "output": "u2"}, {"type": "subtract", "left": "u2", "right": "intake", "output": "body"}], "resolution": 64, "bounds": {"min": [-2.0, -1.2, -3.5], "max": [2.0, 0.7, 2.8]}}}, "parent": null, "attachment": null, "dimensions": {"width": 4.0, "height": 1.6, "depth": 6.6, "units": "meters", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "airframe", "materialLayers": ["airframe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "intake-mouth", "name": "Dorsal intake mouth", "kind": "hole", "description": "dark opening carved into the front face of the hump, 1.1 m aft of the nose"}, {"id": "hump-contour", "name": "Dorsal hump", "kind": "contour", "description": "steep front, long tail fairing to the trailing edge, peak 0.5 m above the wing at 2.3 m aft"}, {"id": "bay-door-outline", "name": "Bay dotted outline", "kind": "linework", "description": "dotted rectangular panel line on the belly aft of the nose gear"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["top-view", "front-view", "side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(189, 185, 178, 1.0)", "secondaryAlbedo": "rgba(160, 156, 150, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidence": "composite skin reads as matte light grey in both references"}};
  node_root_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = polygonizeSdf({"primitives": [{"id": "hull", "type": "ellipsoid", "center": [0, -0.59, -0.7], "radii": [1.75, 0.44, 2.7]}, {"id": "tail", "type": "box", "center": [0, -0.28, 1.85], "size": [1.3, 0.5, 1.3]}, {"id": "hump-head", "type": "ellipsoid", "center": [0, -0.12, -1.4], "radii": [0.9, 0.62, 1.5]}, {"id": "hump-tail", "type": "ellipsoid", "center": [0, -0.15, 0.5], "radii": [0.62, 0.45, 1.9]}, {"id": "intake", "type": "box", "center": [0, 0.2, -2.5], "size": [0.7, 0.16, 0.4]}], "operations": [{"type": "smooth-union", "left": "hull", "right": "tail", "radius": 0.45, "output": "u0"}, {"type": "smooth-union", "left": "u0", "right": "hump-head", "radius": 0.35, "output": "u1"}, {"type": "smooth-union", "left": "u1", "right": "hump-tail", "radius": 0.35, "output": "u2"}, {"type": "subtract", "left": "u2", "right": "intake", "output": "body"}], "resolution": 40, "bounds": {"min": [-2.0, -1.2, -3.5], "max": [2.0, 0.7, 2.8]}});
  if (!endpoint_root_0) {
    mesh_root_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    createSculptMaterial("airframe", {"id": "airframe", "name": "Low-observable composite skin", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#BDB9B2", "color": "#BDB9B2", "albedo": {"dominant": "#BDB9B2", "secondary": ["#F5F5F5", "#FAFAF9", "#E1E1E0"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_albedo.png", "url": "pbr/airframe/airframe_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#F7F7F7", "#F5F5F5", "#FAFAF9", "#E1E1E0", "#EFEFEE"], "pattern": "reference-derived pixel palette", "amplitude": 0.0, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.315, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.218, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.094, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.68, "variation": 0.05, "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_roughness.png", "url": "pbr/airframe/airframe_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.175, "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_normal.png", "url": "pbr/airframe/airframe_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_height.png", "url": "pbr/airframe/airframe_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.01, "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_height.png", "url": "pbr/airframe/airframe_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_ao.png", "url": "pbr/airframe/airframe_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "roundel-stbd", "name": "Roundel starboard", "region": "roundel-stbd", "albedo": "#2B2C2E", "roughness": 0.6, "note": "decal, albedo only"}, {"id": "roundel-port", "name": "Roundel port", "region": "roundel-port", "albedo": "#2B2C2E", "roughness": 0.6, "note": "decal, albedo only"}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "referencePbr": {"version": "1.0", "sourceImage": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\matcrops\\airframe.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.743, "estimatedFidelity": 0.743, "targetThreshold": 0.6, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_albedo.png", "url": "pbr/airframe/airframe_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_roughness.png", "url": "pbr/airframe/airframe_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_height.png", "url": "pbr/airframe/airframe_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_normal.png", "url": "pbr/airframe/airframe_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_ao.png", "url": "pbr/airframe/airframe_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 100, "sourceHeight": 60, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 51, "width": 61, "height": 9}, "mask": {"backgroundColor": "#C0C0BE", "backgroundNoise": 17.321, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.0362}, "mapStats": {"valueRange": 0.0986, "heightP90Gradient": 0.01623, "roughnessBase": 0.68, "roughnessVariation": 0.05, "normalStrength": 0.175, "blurRadius": 21}, "palette": ["#F7F7F7", "#F5F5F5", "#FAFAF9", "#E1E1E0", "#EFEFEE"]}, "warnings": ["foreground mask is very small", "single-image inverse rendering cannot prove true physical PBR; confidence is capped", "low value range weakens height/roughness inference"]}}, options, true)
  );
  mesh_root_0.name = "Centre body (hull, dorsal hump, carved intake, blunt tail)";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "Centre body (hull, dorsal hump, carved intake, blunt tail)", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "A blended lens with a dorsal hump and a blunt tail; only a smooth-union field gives the hump-to-hull fillet the render shows.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "sdf": {"primitives": [{"id": "hull", "type": "ellipsoid", "center": [0, -0.59, -0.7], "radii": [1.75, 0.44, 2.7]}, {"id": "tail", "type": "box", "center": [0, -0.28, 1.85], "size": [1.3, 0.5, 1.3]}, {"id": "hump-head", "type": "ellipsoid", "center": [0, -0.12, -1.4], "radii": [0.9, 0.62, 1.5]}, {"id": "hump-tail", "type": "ellipsoid", "center": [0, -0.15, 0.5], "radii": [0.62, 0.45, 1.9]}, {"id": "intake", "type": "box", "center": [0, 0.2, -2.5], "size": [0.7, 0.16, 0.4]}], "operations": [{"type": "smooth-union", "left": "hull", "right": "tail", "radius": 0.45, "output": "u0"}, {"type": "smooth-union", "left": "u0", "right": "hump-head", "radius": 0.35, "output": "u1"}, {"type": "smooth-union", "left": "u1", "right": "hump-tail", "radius": 0.35, "output": "u2"}, {"type": "subtract", "left": "u2", "right": "intake", "output": "body"}], "resolution": 64, "bounds": {"min": [-2.0, -1.2, -3.5], "max": [2.0, 0.7, 2.8]}}}, "parent": null, "attachment": null, "dimensions": {"width": 4.0, "height": 1.6, "depth": 6.6, "units": "meters", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "airframe", "materialLayers": ["airframe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "intake-mouth", "name": "Dorsal intake mouth", "kind": "hole", "description": "dark opening carved into the front face of the hump, 1.1 m aft of the nose"}, {"id": "hump-contour", "name": "Dorsal hump", "kind": "contour", "description": "steep front, long tail fairing to the trailing edge, peak 0.5 m above the wing at 2.3 m aft"}, {"id": "bay-door-outline", "name": "Bay dotted outline", "kind": "linework", "description": "dotted rectangular panel line on the belly aft of the nose gear"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["top-view", "front-view", "side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(189, 185, 178, 1.0)", "secondaryAlbedo": "rgba(160, 156, 150, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidence": "composite skin reads as matte light grey in both references"}};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);

  const endpoint_wing_stbd_1 = makeAttachmentEndpoint(null);
  const node_wing_stbd_1 = new THREE.Group();
  node_wing_stbd_1.name = "Wing (starboard)__pivot";
  node_wing_stbd_1.scale.set(1, 1, 1);
  if (endpoint_wing_stbd_1) {
    node_wing_stbd_1.position.copy(endpoint_wing_stbd_1.start);
    node_wing_stbd_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wing_stbd_1.position.set(0.0, 0.0, 0.0);
    node_wing_stbd_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_wing_stbd_1.userData.sculptComponent = {"id": "wing-stbd", "name": "Wing (starboard)", "level": "macro", "role": "wing", "importance": 1.0, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "One continuous lifting surface from centreline to a pointed tip; chord and thickness both taper, which no constant-section primitive can express.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, -0.475, -0.57], "rx": 3.13, "rz": 0.475, "twist": 0.0}, {"position": [0.35, -0.465, -0.57], "rx": 2.4534, "rz": 0.465, "twist": 0.0}, {"position": [1.0, -0.4464, -0.0063], "rx": 2.6592, "rz": 0.4464, "twist": 0.0}, {"position": [1.75, -0.425, -0.1008], "rx": 2.3292, "rz": 0.425, "twist": 0.0}, {"position": [2.5, -0.3694, 0.1589], "rx": 2.0038, "rz": 0.3694, "twist": 0.0}, {"position": [3.3, -0.31, 0.3109], "rx": 1.6667, "rz": 0.31, "twist": 0.0}, {"position": [4.5, -0.2656, 0.7732], "rx": 1.3657, "rz": 0.2656, "twist": 0.0}, {"position": [6.0, -0.21, 1.515], "rx": 1.1765, "rz": 0.21, "twist": 0.0}, {"position": [7.5, -0.18, 2.2501], "rx": 0.9885, "rz": 0.18, "twist": 0.0}, {"position": [9.0, -0.15, 2.9824], "rx": 0.8011, "rz": 0.15, "twist": 0.0}, {"position": [9.6, -0.12, 3.197], "rx": 0.4463, "rz": 0.12, "twist": 0.0}, {"position": [10.0, -0.0, 3.35], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 24, "capEnds": true}}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "wing-stbd-mount", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 10.0, "height": 0.95, "depth": 7.5, "units": "meters", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "airframe", "materialLayers": ["airframe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "elevon-lines-stbd", "name": "Outboard elevon panel lines", "kind": "linework", "description": "two chordwise lines at 60 % and 88 % span bounding the elevon"}, {"id": "root-seam-stbd", "name": "Wing-root panel seam", "kind": "seam", "description": "chordwise seam where the wing skin meets the body fairing at 1.75 m"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["top-view", "front-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(189, 185, 178, 1.0)", "secondaryAlbedo": "rgba(160, 156, 150, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidence": "composite skin reads as matte light grey in both references"}};
  node_wing_stbd_1.userData.actionProfile = {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_wing_stbd_1);
  nodes["wing-stbd"] = node_wing_stbd_1;
  const mesh_wing_stbd_1Geometry = endpoint_wing_stbd_1
    ? new THREE.CylinderGeometry(endpoint_wing_stbd_1.endRadius, endpoint_wing_stbd_1.baseRadius, endpoint_wing_stbd_1.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.475, -0.57], "rx": 3.13, "rz": 0.475, "twist": 0.0}, {"position": [0.35, -0.465, -0.57], "rx": 2.4534, "rz": 0.465, "twist": 0.0}, {"position": [1.0, -0.4464, -0.0063], "rx": 2.6592, "rz": 0.4464, "twist": 0.0}, {"position": [1.75, -0.425, -0.1008], "rx": 2.3292, "rz": 0.425, "twist": 0.0}, {"position": [2.5, -0.3694, 0.1589], "rx": 2.0038, "rz": 0.3694, "twist": 0.0}, {"position": [3.3, -0.31, 0.3109], "rx": 1.6667, "rz": 0.31, "twist": 0.0}, {"position": [4.5, -0.2656, 0.7732], "rx": 1.3657, "rz": 0.2656, "twist": 0.0}, {"position": [6.0, -0.21, 1.515], "rx": 1.1765, "rz": 0.21, "twist": 0.0}, {"position": [7.5, -0.18, 2.2501], "rx": 0.9885, "rz": 0.18, "twist": 0.0}, {"position": [9.0, -0.15, 2.9824], "rx": 0.8011, "rz": 0.15, "twist": 0.0}, {"position": [9.6, -0.12, 3.197], "rx": 0.4463, "rz": 0.12, "twist": 0.0}, {"position": [10.0, -0.0, 3.35], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 24, "capEnds": true});
  if (!endpoint_wing_stbd_1) {
    mesh_wing_stbd_1Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_wing_stbd_1 = new THREE.Mesh(
    mesh_wing_stbd_1Geometry,
    materialMap["airframe"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wing_stbd_1.name = "Wing (starboard)";
  if (endpoint_wing_stbd_1) {
    mesh_wing_stbd_1.position.copy(endpoint_wing_stbd_1.midpoint);
    mesh_wing_stbd_1.quaternion.copy(endpoint_wing_stbd_1.quaternion);
  }
  mesh_wing_stbd_1.castShadow = options.castShadow ?? true;
  mesh_wing_stbd_1.receiveShadow = options.receiveShadow ?? true;
  mesh_wing_stbd_1.userData.sculptComponent = {"id": "wing-stbd", "name": "Wing (starboard)", "level": "macro", "role": "wing", "importance": 1.0, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "One continuous lifting surface from centreline to a pointed tip; chord and thickness both taper, which no constant-section primitive can express.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, -0.475, -0.57], "rx": 3.13, "rz": 0.475, "twist": 0.0}, {"position": [0.35, -0.465, -0.57], "rx": 2.4534, "rz": 0.465, "twist": 0.0}, {"position": [1.0, -0.4464, -0.0063], "rx": 2.6592, "rz": 0.4464, "twist": 0.0}, {"position": [1.75, -0.425, -0.1008], "rx": 2.3292, "rz": 0.425, "twist": 0.0}, {"position": [2.5, -0.3694, 0.1589], "rx": 2.0038, "rz": 0.3694, "twist": 0.0}, {"position": [3.3, -0.31, 0.3109], "rx": 1.6667, "rz": 0.31, "twist": 0.0}, {"position": [4.5, -0.2656, 0.7732], "rx": 1.3657, "rz": 0.2656, "twist": 0.0}, {"position": [6.0, -0.21, 1.515], "rx": 1.1765, "rz": 0.21, "twist": 0.0}, {"position": [7.5, -0.18, 2.2501], "rx": 0.9885, "rz": 0.18, "twist": 0.0}, {"position": [9.0, -0.15, 2.9824], "rx": 0.8011, "rz": 0.15, "twist": 0.0}, {"position": [9.6, -0.12, 3.197], "rx": 0.4463, "rz": 0.12, "twist": 0.0}, {"position": [10.0, -0.0, 3.35], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 24, "capEnds": true}}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "wing-stbd-mount", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 10.0, "height": 0.95, "depth": 7.5, "units": "meters", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "airframe", "materialLayers": ["airframe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "elevon-lines-stbd", "name": "Outboard elevon panel lines", "kind": "linework", "description": "two chordwise lines at 60 % and 88 % span bounding the elevon"}, {"id": "root-seam-stbd", "name": "Wing-root panel seam", "kind": "seam", "description": "chordwise seam where the wing skin meets the body fairing at 1.75 m"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["top-view", "front-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(189, 185, 178, 1.0)", "secondaryAlbedo": "rgba(160, 156, 150, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidence": "composite skin reads as matte light grey in both references"}};
  node_wing_stbd_1.add(mesh_wing_stbd_1);
  meshes["wing-stbd"] = mesh_wing_stbd_1;
  colliders["wing-stbd"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_wing_stbd_1);

  const endpoint_wing_port_2 = makeAttachmentEndpoint(null);
  const node_wing_port_2 = new THREE.Group();
  node_wing_port_2.name = "Wing (port)__pivot";
  node_wing_port_2.scale.set(1, 1, 1);
  if (endpoint_wing_port_2) {
    node_wing_port_2.position.copy(endpoint_wing_port_2.start);
    node_wing_port_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_wing_port_2.position.set(0.0, 0.0, 0.0);
    node_wing_port_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_wing_port_2.userData.sculptComponent = {"id": "wing-port", "name": "Wing (port)", "level": "macro", "role": "wing", "importance": 1.0, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "One continuous lifting surface from centreline to a pointed tip; chord and thickness both taper, which no constant-section primitive can express.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [-0.0, -0.475, -0.57], "rx": 3.13, "rz": 0.475, "twist": 0.0}, {"position": [-0.35, -0.465, -0.57], "rx": 2.4534, "rz": 0.465, "twist": 0.0}, {"position": [-1.0, -0.4464, -0.0063], "rx": 2.6592, "rz": 0.4464, "twist": 0.0}, {"position": [-1.75, -0.425, -0.1008], "rx": 2.3292, "rz": 0.425, "twist": 0.0}, {"position": [-2.5, -0.3694, 0.1589], "rx": 2.0038, "rz": 0.3694, "twist": 0.0}, {"position": [-3.3, -0.31, 0.3109], "rx": 1.6667, "rz": 0.31, "twist": 0.0}, {"position": [-4.5, -0.2656, 0.7732], "rx": 1.3657, "rz": 0.2656, "twist": 0.0}, {"position": [-6.0, -0.21, 1.515], "rx": 1.1765, "rz": 0.21, "twist": 0.0}, {"position": [-7.5, -0.18, 2.2501], "rx": 0.9885, "rz": 0.18, "twist": 0.0}, {"position": [-9.0, -0.15, 2.9824], "rx": 0.8011, "rz": 0.15, "twist": 0.0}, {"position": [-9.6, -0.12, 3.197], "rx": 0.4463, "rz": 0.12, "twist": 0.0}, {"position": [-10.0, -0.0, 3.35], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 24, "capEnds": true}}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "wing-port-mount", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 10.0, "height": 0.95, "depth": 7.5, "units": "meters", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "airframe", "materialLayers": ["airframe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "elevon-lines-port", "name": "Outboard elevon panel lines", "kind": "linework", "description": "two chordwise lines at 60 % and 88 % span bounding the elevon"}, {"id": "root-seam-port", "name": "Wing-root panel seam", "kind": "seam", "description": "chordwise seam where the wing skin meets the body fairing at 1.75 m"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["top-view", "front-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(189, 185, 178, 1.0)", "secondaryAlbedo": "rgba(160, 156, 150, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidence": "composite skin reads as matte light grey in both references"}};
  node_wing_port_2.userData.actionProfile = {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_wing_port_2);
  nodes["wing-port"] = node_wing_port_2;
  const mesh_wing_port_2Geometry = endpoint_wing_port_2
    ? new THREE.CylinderGeometry(endpoint_wing_port_2.endRadius, endpoint_wing_port_2.baseRadius, endpoint_wing_port_2.length, 16, 6)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.0, -0.475, -0.57], "rx": 3.13, "rz": 0.475, "twist": 0.0}, {"position": [-0.35, -0.465, -0.57], "rx": 2.4534, "rz": 0.465, "twist": 0.0}, {"position": [-1.0, -0.4464, -0.0063], "rx": 2.6592, "rz": 0.4464, "twist": 0.0}, {"position": [-1.75, -0.425, -0.1008], "rx": 2.3292, "rz": 0.425, "twist": 0.0}, {"position": [-2.5, -0.3694, 0.1589], "rx": 2.0038, "rz": 0.3694, "twist": 0.0}, {"position": [-3.3, -0.31, 0.3109], "rx": 1.6667, "rz": 0.31, "twist": 0.0}, {"position": [-4.5, -0.2656, 0.7732], "rx": 1.3657, "rz": 0.2656, "twist": 0.0}, {"position": [-6.0, -0.21, 1.515], "rx": 1.1765, "rz": 0.21, "twist": 0.0}, {"position": [-7.5, -0.18, 2.2501], "rx": 0.9885, "rz": 0.18, "twist": 0.0}, {"position": [-9.0, -0.15, 2.9824], "rx": 0.8011, "rz": 0.15, "twist": 0.0}, {"position": [-9.6, -0.12, 3.197], "rx": 0.4463, "rz": 0.12, "twist": 0.0}, {"position": [-10.0, -0.0, 3.35], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 24, "capEnds": true});
  if (!endpoint_wing_port_2) {
    mesh_wing_port_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_wing_port_2 = new THREE.Mesh(
    mesh_wing_port_2Geometry,
    materialMap["airframe"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_wing_port_2.name = "Wing (port)";
  if (endpoint_wing_port_2) {
    mesh_wing_port_2.position.copy(endpoint_wing_port_2.midpoint);
    mesh_wing_port_2.quaternion.copy(endpoint_wing_port_2.quaternion);
  }
  mesh_wing_port_2.castShadow = options.castShadow ?? true;
  mesh_wing_port_2.receiveShadow = options.receiveShadow ?? true;
  mesh_wing_port_2.userData.sculptComponent = {"id": "wing-port", "name": "Wing (port)", "level": "macro", "role": "wing", "importance": 1.0, "confidence": 0.85, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "One continuous lifting surface from centreline to a pointed tip; chord and thickness both taper, which no constant-section primitive can express.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [-0.0, -0.475, -0.57], "rx": 3.13, "rz": 0.475, "twist": 0.0}, {"position": [-0.35, -0.465, -0.57], "rx": 2.4534, "rz": 0.465, "twist": 0.0}, {"position": [-1.0, -0.4464, -0.0063], "rx": 2.6592, "rz": 0.4464, "twist": 0.0}, {"position": [-1.75, -0.425, -0.1008], "rx": 2.3292, "rz": 0.425, "twist": 0.0}, {"position": [-2.5, -0.3694, 0.1589], "rx": 2.0038, "rz": 0.3694, "twist": 0.0}, {"position": [-3.3, -0.31, 0.3109], "rx": 1.6667, "rz": 0.31, "twist": 0.0}, {"position": [-4.5, -0.2656, 0.7732], "rx": 1.3657, "rz": 0.2656, "twist": 0.0}, {"position": [-6.0, -0.21, 1.515], "rx": 1.1765, "rz": 0.21, "twist": 0.0}, {"position": [-7.5, -0.18, 2.2501], "rx": 0.9885, "rz": 0.18, "twist": 0.0}, {"position": [-9.0, -0.15, 2.9824], "rx": 0.8011, "rz": 0.15, "twist": 0.0}, {"position": [-9.6, -0.12, 3.197], "rx": 0.4463, "rz": 0.12, "twist": 0.0}, {"position": [-10.0, -0.0, 3.35], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 24, "capEnds": true}}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "wing-port-mount", "localStart": [0, 0, 0], "localEnd": [0, 0, 0], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 10.0, "height": 0.95, "depth": 7.5, "units": "meters", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "airframe", "materialLayers": ["airframe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "elevon-lines-port", "name": "Outboard elevon panel lines", "kind": "linework", "description": "two chordwise lines at 60 % and 88 % span bounding the elevon"}, {"id": "root-seam-port", "name": "Wing-root panel seam", "kind": "seam", "description": "chordwise seam where the wing skin meets the body fairing at 1.75 m"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["top-view", "front-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(189, 185, 178, 1.0)", "secondaryAlbedo": "rgba(160, 156, 150, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidence": "composite skin reads as matte light grey in both references"}};
  node_wing_port_2.add(mesh_wing_port_2);
  meshes["wing-port"] = mesh_wing_port_2;
  colliders["wing-port"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_wing_port_2);

  const endpoint_exhaust_3 = makeAttachmentEndpoint(null);
  const node_exhaust_3 = new THREE.Group();
  node_exhaust_3.name = "Trailing-edge exhaust__pivot";
  node_exhaust_3.scale.set(1, 1, 1);
  if (endpoint_exhaust_3) {
    node_exhaust_3.position.copy(endpoint_exhaust_3.start);
    node_exhaust_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_exhaust_3.position.set(0.0, -0.08, 2.3);
    node_exhaust_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_exhaust_3.userData.sculptComponent = {"id": "exhaust", "name": "Trailing-edge exhaust", "level": "meso", "role": "nozzle", "importance": 0.7, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A dark box sunk into the blunt tail end, flush with the trailing-edge face.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "exhaust-mount", "localStart": [0, -0.08, 2.3], "localEnd": [0, -0.08, 2.3], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.95, "height": 0.26, "depth": 0.4, "units": "meters", "confidence": 0.8}, "transform": {"position": [0, -0.08, 2.3], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-polymer", "materialLayers": ["dark-polymer"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "exhaust-inset", "name": "Trailing-edge exhaust slot", "kind": "decal", "description": "rectangular dark slot at the centre trailing edge"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["top-view", "render-top"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 44, 46, 1.0)", "secondaryAlbedo": "rgba(70, 70, 72, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.75, "evidence": "tyres and duct interiors"}};
  node_exhaust_3.userData.actionProfile = {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_exhaust_3);
  nodes["exhaust"] = node_exhaust_3;
  const mesh_exhaust_3Geometry = endpoint_exhaust_3
    ? new THREE.CylinderGeometry(endpoint_exhaust_3.endRadius, endpoint_exhaust_3.baseRadius, endpoint_exhaust_3.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_exhaust_3) {
    mesh_exhaust_3Geometry.scale(0.95, 0.26, 0.4);
  }
  const mesh_exhaust_3 = new THREE.Mesh(
    mesh_exhaust_3Geometry,
    materialMap["dark-polymer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_exhaust_3.name = "Trailing-edge exhaust";
  if (endpoint_exhaust_3) {
    mesh_exhaust_3.position.copy(endpoint_exhaust_3.midpoint);
    mesh_exhaust_3.quaternion.copy(endpoint_exhaust_3.quaternion);
  }
  mesh_exhaust_3.castShadow = options.castShadow ?? true;
  mesh_exhaust_3.receiveShadow = options.receiveShadow ?? true;
  mesh_exhaust_3.userData.sculptComponent = {"id": "exhaust", "name": "Trailing-edge exhaust", "level": "meso", "role": "nozzle", "importance": 0.7, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "A dark box sunk into the blunt tail end, flush with the trailing-edge face.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "exhaust-mount", "localStart": [0, -0.08, 2.3], "localEnd": [0, -0.08, 2.3], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.95, "height": 0.26, "depth": 0.4, "units": "meters", "confidence": 0.8}, "transform": {"position": [0, -0.08, 2.3], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-polymer", "materialLayers": ["dark-polymer"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "exhaust-inset", "name": "Trailing-edge exhaust slot", "kind": "decal", "description": "rectangular dark slot at the centre trailing edge"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["top-view", "render-top"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 44, 46, 1.0)", "secondaryAlbedo": "rgba(70, 70, 72, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.75, "evidence": "tyres and duct interiors"}};
  node_exhaust_3.add(mesh_exhaust_3);
  meshes["exhaust"] = mesh_exhaust_3;
  colliders["exhaust"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_exhaust_3);

  const endpoint_blister_stbd_4 = makeAttachmentEndpoint(null);
  const node_blister_stbd_4 = new THREE.Group();
  node_blister_stbd_4.name = "Sensor fairing (stbd)__pivot";
  node_blister_stbd_4.scale.set(1, 1, 1);
  if (endpoint_blister_stbd_4) {
    node_blister_stbd_4.position.copy(endpoint_blister_stbd_4.start);
    node_blister_stbd_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_blister_stbd_4.position.set(1.67, -0.02, -0.45);
    node_blister_stbd_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_blister_stbd_4.userData.sculptComponent = {"id": "blister-stbd", "name": "Sensor fairing (stbd)", "level": "meso", "role": "fairing", "importance": 0.8, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "A teardrop that fairs into the skin: rounded front, tapered tail, blended base.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "sdf": {"primitives": [{"id": "head", "type": "ellipsoid", "center": [0, 0, -0.7], "radii": [0.5, 0.42, 0.65]}, {"id": "tail", "type": "ellipsoid", "center": [0, -0.08, 0.3], "radii": [0.34, 0.28, 1.0]}], "operations": [{"type": "smooth-union", "left": "head", "right": "tail", "radius": 0.3, "output": "blister"}], "resolution": 40, "bounds": {"min": [-0.6, -0.5, -1.45], "max": [0.6, 0.5, 1.4]}}}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "blister-stbd-mount", "localStart": [1.67, -0.02, -0.45], "localEnd": [1.67, -0.02, -0.45], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 1.0, "height": 0.45, "depth": 2.4, "units": "meters", "confidence": 0.8}, "transform": {"position": [1.67, -0.02, -0.45], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "airframe", "materialLayers": ["airframe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["top-view", "front-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(189, 185, 178, 1.0)", "secondaryAlbedo": "rgba(160, 156, 150, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidence": "composite skin reads as matte light grey in both references"}};
  node_blister_stbd_4.userData.actionProfile = {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_blister_stbd_4);
  nodes["blister-stbd"] = node_blister_stbd_4;
  const mesh_blister_stbd_4Geometry = polygonizeSdf({"primitives": [{"id": "head", "type": "ellipsoid", "center": [0, 0, -0.7], "radii": [0.5, 0.42, 0.65]}, {"id": "tail", "type": "ellipsoid", "center": [0, -0.08, 0.3], "radii": [0.34, 0.28, 1.0]}], "operations": [{"type": "smooth-union", "left": "head", "right": "tail", "radius": 0.3, "output": "blister"}], "resolution": 40, "bounds": {"min": [-0.6, -0.5, -1.45], "max": [0.6, 0.5, 1.4]}});
  if (!endpoint_blister_stbd_4) {
    mesh_blister_stbd_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_blister_stbd_4 = new THREE.Mesh(
    mesh_blister_stbd_4Geometry,
    createSculptMaterial("airframe", {"id": "airframe", "name": "Low-observable composite skin", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#BDB9B2", "color": "#BDB9B2", "albedo": {"dominant": "#BDB9B2", "secondary": ["#F5F5F5", "#FAFAF9", "#E1E1E0"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_albedo.png", "url": "pbr/airframe/airframe_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#F7F7F7", "#F5F5F5", "#FAFAF9", "#E1E1E0", "#EFEFEE"], "pattern": "reference-derived pixel palette", "amplitude": 0.0, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.315, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.218, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.094, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.68, "variation": 0.05, "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_roughness.png", "url": "pbr/airframe/airframe_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.175, "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_normal.png", "url": "pbr/airframe/airframe_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_height.png", "url": "pbr/airframe/airframe_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.01, "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_height.png", "url": "pbr/airframe/airframe_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_ao.png", "url": "pbr/airframe/airframe_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "roundel-stbd", "name": "Roundel starboard", "region": "roundel-stbd", "albedo": "#2B2C2E", "roughness": 0.6, "note": "decal, albedo only"}, {"id": "roundel-port", "name": "Roundel port", "region": "roundel-port", "albedo": "#2B2C2E", "roughness": 0.6, "note": "decal, albedo only"}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "referencePbr": {"version": "1.0", "sourceImage": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\matcrops\\airframe.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.743, "estimatedFidelity": 0.743, "targetThreshold": 0.6, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_albedo.png", "url": "pbr/airframe/airframe_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_roughness.png", "url": "pbr/airframe/airframe_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_height.png", "url": "pbr/airframe/airframe_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_normal.png", "url": "pbr/airframe/airframe_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_ao.png", "url": "pbr/airframe/airframe_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 100, "sourceHeight": 60, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 51, "width": 61, "height": 9}, "mask": {"backgroundColor": "#C0C0BE", "backgroundNoise": 17.321, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.0362}, "mapStats": {"valueRange": 0.0986, "heightP90Gradient": 0.01623, "roughnessBase": 0.68, "roughnessVariation": 0.05, "normalStrength": 0.175, "blurRadius": 21}, "palette": ["#F7F7F7", "#F5F5F5", "#FAFAF9", "#E1E1E0", "#EFEFEE"]}, "warnings": ["foreground mask is very small", "single-image inverse rendering cannot prove true physical PBR; confidence is capped", "low value range weakens height/roughness inference"]}}, options, true)
  );
  mesh_blister_stbd_4.name = "Sensor fairing (stbd)";
  if (endpoint_blister_stbd_4) {
    mesh_blister_stbd_4.position.copy(endpoint_blister_stbd_4.midpoint);
    mesh_blister_stbd_4.quaternion.copy(endpoint_blister_stbd_4.quaternion);
  }
  mesh_blister_stbd_4.castShadow = options.castShadow ?? true;
  mesh_blister_stbd_4.receiveShadow = options.receiveShadow ?? true;
  mesh_blister_stbd_4.userData.sculptComponent = {"id": "blister-stbd", "name": "Sensor fairing (stbd)", "level": "meso", "role": "fairing", "importance": 0.8, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "A teardrop that fairs into the skin: rounded front, tapered tail, blended base.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "sdf": {"primitives": [{"id": "head", "type": "ellipsoid", "center": [0, 0, -0.7], "radii": [0.5, 0.42, 0.65]}, {"id": "tail", "type": "ellipsoid", "center": [0, -0.08, 0.3], "radii": [0.34, 0.28, 1.0]}], "operations": [{"type": "smooth-union", "left": "head", "right": "tail", "radius": 0.3, "output": "blister"}], "resolution": 40, "bounds": {"min": [-0.6, -0.5, -1.45], "max": [0.6, 0.5, 1.4]}}}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "blister-stbd-mount", "localStart": [1.67, -0.02, -0.45], "localEnd": [1.67, -0.02, -0.45], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 1.0, "height": 0.45, "depth": 2.4, "units": "meters", "confidence": 0.8}, "transform": {"position": [1.67, -0.02, -0.45], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "airframe", "materialLayers": ["airframe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["top-view", "front-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(189, 185, 178, 1.0)", "secondaryAlbedo": "rgba(160, 156, 150, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidence": "composite skin reads as matte light grey in both references"}};
  node_blister_stbd_4.add(mesh_blister_stbd_4);
  meshes["blister-stbd"] = mesh_blister_stbd_4;
  colliders["blister-stbd"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_blister_stbd_4);

  const endpoint_blister_port_5 = makeAttachmentEndpoint(null);
  const node_blister_port_5 = new THREE.Group();
  node_blister_port_5.name = "Sensor fairing (port)__pivot";
  node_blister_port_5.scale.set(1, 1, 1);
  if (endpoint_blister_port_5) {
    node_blister_port_5.position.copy(endpoint_blister_port_5.start);
    node_blister_port_5.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_blister_port_5.position.set(-1.67, -0.02, -0.45);
    node_blister_port_5.rotation.set(0.0, 0.0, 0.0);
  }
  node_blister_port_5.userData.sculptComponent = {"id": "blister-port", "name": "Sensor fairing (port)", "level": "meso", "role": "fairing", "importance": 0.8, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "A teardrop that fairs into the skin: rounded front, tapered tail, blended base.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "sdf": {"primitives": [{"id": "head", "type": "ellipsoid", "center": [0, 0, -0.7], "radii": [0.5, 0.42, 0.65]}, {"id": "tail", "type": "ellipsoid", "center": [0, -0.08, 0.3], "radii": [0.34, 0.28, 1.0]}], "operations": [{"type": "smooth-union", "left": "head", "right": "tail", "radius": 0.3, "output": "blister"}], "resolution": 40, "bounds": {"min": [-0.6, -0.5, -1.45], "max": [0.6, 0.5, 1.4]}}}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "blister-port-mount", "localStart": [-1.67, -0.02, -0.45], "localEnd": [-1.67, -0.02, -0.45], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 1.0, "height": 0.45, "depth": 2.4, "units": "meters", "confidence": 0.8}, "transform": {"position": [-1.67, -0.02, -0.45], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "airframe", "materialLayers": ["airframe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["top-view", "front-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(189, 185, 178, 1.0)", "secondaryAlbedo": "rgba(160, 156, 150, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidence": "composite skin reads as matte light grey in both references"}};
  node_blister_port_5.userData.actionProfile = {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_blister_port_5);
  nodes["blister-port"] = node_blister_port_5;
  const mesh_blister_port_5Geometry = polygonizeSdf({"primitives": [{"id": "head", "type": "ellipsoid", "center": [0, 0, -0.7], "radii": [0.5, 0.42, 0.65]}, {"id": "tail", "type": "ellipsoid", "center": [0, -0.08, 0.3], "radii": [0.34, 0.28, 1.0]}], "operations": [{"type": "smooth-union", "left": "head", "right": "tail", "radius": 0.3, "output": "blister"}], "resolution": 40, "bounds": {"min": [-0.6, -0.5, -1.45], "max": [0.6, 0.5, 1.4]}});
  if (!endpoint_blister_port_5) {
    mesh_blister_port_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_blister_port_5 = new THREE.Mesh(
    mesh_blister_port_5Geometry,
    createSculptMaterial("airframe", {"id": "airframe", "name": "Low-observable composite skin", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#BDB9B2", "color": "#BDB9B2", "albedo": {"dominant": "#BDB9B2", "secondary": ["#F5F5F5", "#FAFAF9", "#E1E1E0"], "samplingNotes": "Reference-derived from foreground pixels; de-lit to reduce baked shadows/highlights.", "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_albedo.png", "url": "pbr/airframe/airframe_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}}, "colorVariation": {"palette": ["#F7F7F7", "#F5F5F5", "#FAFAF9", "#E1E1E0", "#EFEFEE"], "pattern": "reference-derived pixel palette", "amplitude": 0.0, "heightCorrelation": 0.42}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1.0, 1.0], "anisotropy": 8, "texelDensityIntent": "Preserve stable world/object-scale detail; do not stretch micro detail with component scale."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 2.0, "amplitude": 0.315, "role": "reference-derived broad albedo and height breakup"}, {"id": "meso", "frequency": 14.0, "amplitude": 0.218, "role": "reference-derived cracks, ridges, pores, grain, or leaf clusters"}, {"id": "micro", "frequency": 72.0, "amplitude": 0.094, "role": "reference-derived micro highlight breakup under grazing light"}], "roughness": {"base": 0.68, "variation": 0.05, "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_roughness.png", "url": "pbr/airframe/airframe_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "localResponse": "reference-derived roughness estimate; cavities and textured zones trend rougher, bright highlights trend smoother"}, "metalness": {"base": 0.0, "variation": 0.0}, "normal": {"pattern": "reference-derived height-gradient normal map", "strength": 0.175, "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_normal.png", "url": "pbr/airframe/airframe_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "heightSource": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_height.png", "url": "pbr/airframe/airframe_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "space": "tangent"}, "bump": {"pattern": "reference-derived height field", "amplitude": 0.01, "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_height.png", "url": "pbr/airframe/airframe_height.png", "channel": "height", "source": "reference-pixel-extraction"}}, "displacement": {"pattern": "none", "amplitude": 0.0, "scale": 1.0, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.38, "contactShadowBias": 0.35, "map": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_ao.png", "url": "pbr/airframe/airframe_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}, "notes": "Reference-derived cavity estimate from local height minima; verify against grazing-light screenshot."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "roundel-stbd", "name": "Roundel starboard", "region": "roundel-stbd", "albedo": "#2B2C2E", "roughness": 0.6, "note": "decal, albedo only"}, {"id": "roundel-port", "name": "Roundel port", "region": "roundel-port", "albedo": "#2B2C2E", "roughness": 0.6, "note": "decal, albedo only"}, {"id": "reference-pbr-pixel-evidence", "type": "material-map-evidence", "evidenceRefs": ["full-object"], "channels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "notes": "Use generated maps as material evidence, then refine after browser screenshot comparison."}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there.", "Reference-derived maps are estimates from image pixels; verify with neutral, grazing, and reference-matched renders.", "Do not treat baked image shadows as final albedo; rerun extraction with a tighter material crop if highlights/shadows pollute the maps."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "referencePbr": {"version": "1.0", "sourceImage": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\matcrops\\airframe.png", "extractor": "stage1_intake/extract_pbr_evidence.py", "method": "single-image pixel evidence with de-lighting estimate; not photogrammetry", "usable": true, "verdict": "pass", "confidence": 0.743, "estimatedFidelity": 0.743, "targetThreshold": 0.6, "hardLimit": "A single image cannot uniquely recover true albedo/roughness/normal/AO; maps are reference-derived estimates.", "maps": {"albedo": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_albedo.png", "url": "pbr/airframe/airframe_albedo.png", "channel": "albedo", "source": "reference-pixel-extraction"}, "roughness": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_roughness.png", "url": "pbr/airframe/airframe_roughness.png", "channel": "roughness", "source": "reference-pixel-extraction"}, "height": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_height.png", "url": "pbr/airframe/airframe_height.png", "channel": "height", "source": "reference-pixel-extraction"}, "normal": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_normal.png", "url": "pbr/airframe/airframe_normal.png", "channel": "normal", "source": "reference-pixel-extraction"}, "ao": {"path": "G:\\My Drive\\Scripts\\procedural-creature\\workshop-webgpu\\scratchpads\\rq170-sentinel\\pbr\\airframe\\airframe_ao.png", "url": "pbr/airframe/airframe_ao.png", "channel": "ao", "source": "reference-pixel-extraction"}}, "diagnostics": {"sourceWidth": 100, "sourceHeight": 60, "mapSize": 1024, "cropBBoxPixels": {"x": 0, "y": 51, "width": 61, "height": 9}, "mask": {"backgroundColor": "#C0C0BE", "backgroundNoise": 17.321, "transparentPixelFraction": 0.0, "foregroundCoverage": 0.0362}, "mapStats": {"valueRange": 0.0986, "heightP90Gradient": 0.01623, "roughnessBase": 0.68, "roughnessVariation": 0.05, "normalStrength": 0.175, "blurRadius": 21}, "palette": ["#F7F7F7", "#F5F5F5", "#FAFAF9", "#E1E1E0", "#EFEFEE"]}, "warnings": ["foreground mask is very small", "single-image inverse rendering cannot prove true physical PBR; confidence is capped", "low value range weakens height/roughness inference"]}}, options, true)
  );
  mesh_blister_port_5.name = "Sensor fairing (port)";
  if (endpoint_blister_port_5) {
    mesh_blister_port_5.position.copy(endpoint_blister_port_5.midpoint);
    mesh_blister_port_5.quaternion.copy(endpoint_blister_port_5.quaternion);
  }
  mesh_blister_port_5.castShadow = options.castShadow ?? true;
  mesh_blister_port_5.receiveShadow = options.receiveShadow ?? true;
  mesh_blister_port_5.userData.sculptComponent = {"id": "blister-port", "name": "Sensor fairing (port)", "level": "meso", "role": "fairing", "importance": 0.8, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "A teardrop that fairs into the skin: rounded front, tapered tail, blended base.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "sdf": {"primitives": [{"id": "head", "type": "ellipsoid", "center": [0, 0, -0.7], "radii": [0.5, 0.42, 0.65]}, {"id": "tail", "type": "ellipsoid", "center": [0, -0.08, 0.3], "radii": [0.34, 0.28, 1.0]}], "operations": [{"type": "smooth-union", "left": "head", "right": "tail", "radius": 0.3, "output": "blister"}], "resolution": 40, "bounds": {"min": [-0.6, -0.5, -1.45], "max": [0.6, 0.5, 1.4]}}}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "blister-port-mount", "localStart": [-1.67, -0.02, -0.45], "localEnd": [-1.67, -0.02, -0.45], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 1.0, "height": 0.45, "depth": 2.4, "units": "meters", "confidence": 0.8}, "transform": {"position": [-1.67, -0.02, -0.45], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "airframe", "materialLayers": ["airframe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["top-view", "front-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(189, 185, 178, 1.0)", "secondaryAlbedo": "rgba(160, 156, 150, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidence": "composite skin reads as matte light grey in both references"}};
  node_blister_port_5.add(mesh_blister_port_5);
  meshes["blister-port"] = mesh_blister_port_5;
  colliders["blister-port"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_blister_port_5);

  const attachment_nose_strut_6 = {"parentId": "root", "parentSocket": "nose-strut-mount", "localStart": [0, -1.2, -1.7], "localEnd": [0, -1.2, -1.7], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01};
  const endpoint_nose_strut_6 = makeAttachmentEndpoint(attachment_nose_strut_6);
  const node_nose_strut_6 = new THREE.Group();
  node_nose_strut_6.name = "Nose gear strut__pivot";
  node_nose_strut_6.scale.set(1, 1, 1);
  if (endpoint_nose_strut_6) {
    node_nose_strut_6.position.copy(endpoint_nose_strut_6.start);
    node_nose_strut_6.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_nose_strut_6.position.set(0.0, -1.2, -1.7);
    node_nose_strut_6.rotation.set(0.0, 0.0, 0.0);
  }
  node_nose_strut_6.userData.sculptComponent = {"id": "nose-strut", "name": "Nose gear strut", "level": "meso", "role": "gear", "importance": 0.5, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Machined oleo leg.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "nose-strut-mount", "localStart": [0, -1.2, -1.7], "localEnd": [0, -1.2, -1.7], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.12, "height": 0.7, "depth": 0.12, "units": "meters", "confidence": 0.8}, "transform": {"position": [0, -1.2, -1.7], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "gear-metal", "materialLayers": ["gear-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front-view", "side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(214, 214, 211, 1.0)", "secondaryAlbedo": "rgba(150, 150, 148, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7, "evidence": "gear struts in the render sheet"}};
  node_nose_strut_6.userData.actionProfile = {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_nose_strut_6);
  nodes["nose-strut"] = node_nose_strut_6;
  const mesh_nose_strut_6Geometry = endpoint_nose_strut_6
    ? new THREE.CylinderGeometry(endpoint_nose_strut_6.endRadius, endpoint_nose_strut_6.baseRadius, endpoint_nose_strut_6.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_nose_strut_6) {
    mesh_nose_strut_6Geometry.scale(0.12, 0.7, 0.12);
  }
  const mesh_nose_strut_6 = new THREE.Mesh(
    mesh_nose_strut_6Geometry,
    materialMap["gear-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_nose_strut_6.name = "Nose gear strut";
  if (endpoint_nose_strut_6) {
    mesh_nose_strut_6.position.copy(endpoint_nose_strut_6.midpoint);
    mesh_nose_strut_6.quaternion.copy(endpoint_nose_strut_6.quaternion);
  }
  mesh_nose_strut_6.castShadow = options.castShadow ?? true;
  mesh_nose_strut_6.receiveShadow = options.receiveShadow ?? true;
  mesh_nose_strut_6.userData.sculptComponent = {"id": "nose-strut", "name": "Nose gear strut", "level": "meso", "role": "gear", "importance": 0.5, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Machined oleo leg.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "nose-strut-mount", "localStart": [0, -1.2, -1.7], "localEnd": [0, -1.2, -1.7], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.12, "height": 0.7, "depth": 0.12, "units": "meters", "confidence": 0.8}, "transform": {"position": [0, -1.2, -1.7], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "gear-metal", "materialLayers": ["gear-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front-view", "side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(214, 214, 211, 1.0)", "secondaryAlbedo": "rgba(150, 150, 148, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7, "evidence": "gear struts in the render sheet"}};
  node_nose_strut_6.add(mesh_nose_strut_6);
  meshes["nose-strut"] = mesh_nose_strut_6;
  colliders["nose-strut"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_nose_strut_6);

  const attachment_nose_wheel_7 = {"parentId": "root", "parentSocket": "nose-wheel-mount", "localStart": [0, -1.6, -1.7], "localEnd": [0, -1.6, -1.7], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01};
  const endpoint_nose_wheel_7 = makeAttachmentEndpoint(attachment_nose_wheel_7);
  const node_nose_wheel_7 = new THREE.Group();
  node_nose_wheel_7.name = "Nose wheel__pivot";
  node_nose_wheel_7.scale.set(1, 1, 1);
  if (endpoint_nose_wheel_7) {
    node_nose_wheel_7.position.copy(endpoint_nose_wheel_7.start);
    node_nose_wheel_7.rotation.set(0.0, 0.0, 1.5707963267948966);
  } else {
    node_nose_wheel_7.position.set(0.0, -1.6, -1.7);
    node_nose_wheel_7.rotation.set(0.0, 0.0, 1.5707963267948966);
  }
  node_nose_wheel_7.userData.sculptComponent = {"id": "nose-wheel", "name": "Nose wheel", "level": "meso", "role": "wheel", "importance": 0.5, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "A tyre is a short cylinder on a lateral axle.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "nose-wheel-mount", "localStart": [0, -1.6, -1.7], "localEnd": [0, -1.6, -1.7], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.52, "height": 0.18, "depth": 0.52, "units": "meters", "confidence": 0.8}, "transform": {"position": [0, -1.6, -1.7], "rotation": [0, 0, 1.5707963267948966]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-polymer", "materialLayers": ["dark-polymer"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front-view", "side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 44, 46, 1.0)", "secondaryAlbedo": "rgba(70, 70, 72, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.75, "evidence": "tyres and duct interiors"}};
  node_nose_wheel_7.userData.actionProfile = {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_nose_wheel_7);
  nodes["nose-wheel"] = node_nose_wheel_7;
  const mesh_nose_wheel_7Geometry = endpoint_nose_wheel_7
    ? new THREE.CylinderGeometry(endpoint_nose_wheel_7.endRadius, endpoint_nose_wheel_7.baseRadius, endpoint_nose_wheel_7.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_nose_wheel_7) {
    mesh_nose_wheel_7Geometry.scale(0.52, 0.18, 0.52);
  }
  const mesh_nose_wheel_7 = new THREE.Mesh(
    mesh_nose_wheel_7Geometry,
    materialMap["dark-polymer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_nose_wheel_7.name = "Nose wheel";
  if (endpoint_nose_wheel_7) {
    mesh_nose_wheel_7.position.copy(endpoint_nose_wheel_7.midpoint);
    mesh_nose_wheel_7.quaternion.copy(endpoint_nose_wheel_7.quaternion);
  }
  mesh_nose_wheel_7.castShadow = options.castShadow ?? true;
  mesh_nose_wheel_7.receiveShadow = options.receiveShadow ?? true;
  mesh_nose_wheel_7.userData.sculptComponent = {"id": "nose-wheel", "name": "Nose wheel", "level": "meso", "role": "wheel", "importance": 0.5, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "A tyre is a short cylinder on a lateral axle.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "nose-wheel-mount", "localStart": [0, -1.6, -1.7], "localEnd": [0, -1.6, -1.7], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.52, "height": 0.18, "depth": 0.52, "units": "meters", "confidence": 0.8}, "transform": {"position": [0, -1.6, -1.7], "rotation": [0, 0, 1.5707963267948966]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-polymer", "materialLayers": ["dark-polymer"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front-view", "side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 44, 46, 1.0)", "secondaryAlbedo": "rgba(70, 70, 72, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.75, "evidence": "tyres and duct interiors"}};
  node_nose_wheel_7.add(mesh_nose_wheel_7);
  meshes["nose-wheel"] = mesh_nose_wheel_7;
  colliders["nose-wheel"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_nose_wheel_7);

  const endpoint_nose_door_8 = makeAttachmentEndpoint(null);
  const node_nose_door_8 = new THREE.Group();
  node_nose_door_8.name = "Nose gear door__pivot";
  node_nose_door_8.scale.set(1, 1, 1);
  if (endpoint_nose_door_8) {
    node_nose_door_8.position.copy(endpoint_nose_door_8.start);
    node_nose_door_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_nose_door_8.position.set(0.32, -1.35, -1.7);
    node_nose_door_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_nose_door_8.userData.sculptComponent = {"id": "nose-door", "name": "Nose gear door", "level": "meso", "role": "door", "importance": 0.4, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Thin hinged panel hanging beside the leg.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "nose-door-mount", "localStart": [0.32, -1.35, -1.7], "localEnd": [0.32, -1.35, -1.7], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.04, "height": 0.75, "depth": 0.95, "units": "meters", "confidence": 0.8}, "transform": {"position": [0.32, -1.35, -1.7], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "airframe", "materialLayers": ["airframe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(189, 185, 178, 1.0)", "secondaryAlbedo": "rgba(160, 156, 150, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidence": "composite skin reads as matte light grey in both references"}};
  node_nose_door_8.userData.actionProfile = {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_nose_door_8);
  nodes["nose-door"] = node_nose_door_8;
  const mesh_nose_door_8Geometry = endpoint_nose_door_8
    ? new THREE.CylinderGeometry(endpoint_nose_door_8.endRadius, endpoint_nose_door_8.baseRadius, endpoint_nose_door_8.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_nose_door_8) {
    mesh_nose_door_8Geometry.scale(0.04, 0.75, 0.95);
  }
  const mesh_nose_door_8 = new THREE.Mesh(
    mesh_nose_door_8Geometry,
    materialMap["airframe"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_nose_door_8.name = "Nose gear door";
  if (endpoint_nose_door_8) {
    mesh_nose_door_8.position.copy(endpoint_nose_door_8.midpoint);
    mesh_nose_door_8.quaternion.copy(endpoint_nose_door_8.quaternion);
  }
  mesh_nose_door_8.castShadow = options.castShadow ?? true;
  mesh_nose_door_8.receiveShadow = options.receiveShadow ?? true;
  mesh_nose_door_8.userData.sculptComponent = {"id": "nose-door", "name": "Nose gear door", "level": "meso", "role": "door", "importance": 0.4, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Thin hinged panel hanging beside the leg.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "nose-door-mount", "localStart": [0.32, -1.35, -1.7], "localEnd": [0.32, -1.35, -1.7], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.04, "height": 0.75, "depth": 0.95, "units": "meters", "confidence": 0.8}, "transform": {"position": [0.32, -1.35, -1.7], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "airframe", "materialLayers": ["airframe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(189, 185, 178, 1.0)", "secondaryAlbedo": "rgba(160, 156, 150, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidence": "composite skin reads as matte light grey in both references"}};
  node_nose_door_8.add(mesh_nose_door_8);
  meshes["nose-door"] = mesh_nose_door_8;
  colliders["nose-door"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_nose_door_8);

  const attachment_main_strut_stbd_9 = {"parentId": "root", "parentSocket": "main-strut-stbd-mount", "localStart": [1.85, -1.15, 0.5], "localEnd": [1.85, -1.15, 0.5], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01};
  const endpoint_main_strut_stbd_9 = makeAttachmentEndpoint(attachment_main_strut_stbd_9);
  const node_main_strut_stbd_9 = new THREE.Group();
  node_main_strut_stbd_9.name = "Main gear strut (stbd)__pivot";
  node_main_strut_stbd_9.scale.set(1, 1, 1);
  if (endpoint_main_strut_stbd_9) {
    node_main_strut_stbd_9.position.copy(endpoint_main_strut_stbd_9.start);
    node_main_strut_stbd_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_main_strut_stbd_9.position.set(1.85, -1.15, 0.5);
    node_main_strut_stbd_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_main_strut_stbd_9.userData.sculptComponent = {"id": "main-strut-stbd", "name": "Main gear strut (stbd)", "level": "meso", "role": "gear", "importance": 0.5, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Machined oleo leg.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "main-strut-stbd-mount", "localStart": [1.85, -1.15, 0.5], "localEnd": [1.85, -1.15, 0.5], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.14, "height": 0.6, "depth": 0.14, "units": "meters", "confidence": 0.8}, "transform": {"position": [1.85, -1.15, 0.5], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "gear-metal", "materialLayers": ["gear-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front-view", "side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(214, 214, 211, 1.0)", "secondaryAlbedo": "rgba(150, 150, 148, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7, "evidence": "gear struts in the render sheet"}};
  node_main_strut_stbd_9.userData.actionProfile = {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_main_strut_stbd_9);
  nodes["main-strut-stbd"] = node_main_strut_stbd_9;
  const mesh_main_strut_stbd_9Geometry = endpoint_main_strut_stbd_9
    ? new THREE.CylinderGeometry(endpoint_main_strut_stbd_9.endRadius, endpoint_main_strut_stbd_9.baseRadius, endpoint_main_strut_stbd_9.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_main_strut_stbd_9) {
    mesh_main_strut_stbd_9Geometry.scale(0.14, 0.6, 0.14);
  }
  const mesh_main_strut_stbd_9 = new THREE.Mesh(
    mesh_main_strut_stbd_9Geometry,
    materialMap["gear-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_main_strut_stbd_9.name = "Main gear strut (stbd)";
  if (endpoint_main_strut_stbd_9) {
    mesh_main_strut_stbd_9.position.copy(endpoint_main_strut_stbd_9.midpoint);
    mesh_main_strut_stbd_9.quaternion.copy(endpoint_main_strut_stbd_9.quaternion);
  }
  mesh_main_strut_stbd_9.castShadow = options.castShadow ?? true;
  mesh_main_strut_stbd_9.receiveShadow = options.receiveShadow ?? true;
  mesh_main_strut_stbd_9.userData.sculptComponent = {"id": "main-strut-stbd", "name": "Main gear strut (stbd)", "level": "meso", "role": "gear", "importance": 0.5, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Machined oleo leg.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "main-strut-stbd-mount", "localStart": [1.85, -1.15, 0.5], "localEnd": [1.85, -1.15, 0.5], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.14, "height": 0.6, "depth": 0.14, "units": "meters", "confidence": 0.8}, "transform": {"position": [1.85, -1.15, 0.5], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "gear-metal", "materialLayers": ["gear-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front-view", "side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(214, 214, 211, 1.0)", "secondaryAlbedo": "rgba(150, 150, 148, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7, "evidence": "gear struts in the render sheet"}};
  node_main_strut_stbd_9.add(mesh_main_strut_stbd_9);
  meshes["main-strut-stbd"] = mesh_main_strut_stbd_9;
  colliders["main-strut-stbd"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_main_strut_stbd_9);

  const endpoint_main_bogie_stbd_10 = makeAttachmentEndpoint(null);
  const node_main_bogie_stbd_10 = new THREE.Group();
  node_main_bogie_stbd_10.name = "Main gear bogie beam (stbd)__pivot";
  node_main_bogie_stbd_10.scale.set(1, 1, 1);
  if (endpoint_main_bogie_stbd_10) {
    node_main_bogie_stbd_10.position.copy(endpoint_main_bogie_stbd_10.start);
    node_main_bogie_stbd_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_main_bogie_stbd_10.position.set(1.85, -1.45, 0.5);
    node_main_bogie_stbd_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_main_bogie_stbd_10.userData.sculptComponent = {"id": "main-bogie-stbd", "name": "Main gear bogie beam (stbd)", "level": "meso", "role": "gear", "importance": 0.3, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Beam carrying the tandem wheels.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "main-bogie-stbd-mount", "localStart": [1.85, -1.45, 0.5], "localEnd": [1.85, -1.45, 0.5], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.1, "height": 0.1, "depth": 1.0, "units": "meters", "confidence": 0.8}, "transform": {"position": [1.85, -1.45, 0.5], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "gear-metal", "materialLayers": ["gear-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(214, 214, 211, 1.0)", "secondaryAlbedo": "rgba(150, 150, 148, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7, "evidence": "gear struts in the render sheet"}};
  node_main_bogie_stbd_10.userData.actionProfile = {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_main_bogie_stbd_10);
  nodes["main-bogie-stbd"] = node_main_bogie_stbd_10;
  const mesh_main_bogie_stbd_10Geometry = endpoint_main_bogie_stbd_10
    ? new THREE.CylinderGeometry(endpoint_main_bogie_stbd_10.endRadius, endpoint_main_bogie_stbd_10.baseRadius, endpoint_main_bogie_stbd_10.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_main_bogie_stbd_10) {
    mesh_main_bogie_stbd_10Geometry.scale(0.1, 0.1, 1.0);
  }
  const mesh_main_bogie_stbd_10 = new THREE.Mesh(
    mesh_main_bogie_stbd_10Geometry,
    materialMap["gear-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_main_bogie_stbd_10.name = "Main gear bogie beam (stbd)";
  if (endpoint_main_bogie_stbd_10) {
    mesh_main_bogie_stbd_10.position.copy(endpoint_main_bogie_stbd_10.midpoint);
    mesh_main_bogie_stbd_10.quaternion.copy(endpoint_main_bogie_stbd_10.quaternion);
  }
  mesh_main_bogie_stbd_10.castShadow = options.castShadow ?? true;
  mesh_main_bogie_stbd_10.receiveShadow = options.receiveShadow ?? true;
  mesh_main_bogie_stbd_10.userData.sculptComponent = {"id": "main-bogie-stbd", "name": "Main gear bogie beam (stbd)", "level": "meso", "role": "gear", "importance": 0.3, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Beam carrying the tandem wheels.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "main-bogie-stbd-mount", "localStart": [1.85, -1.45, 0.5], "localEnd": [1.85, -1.45, 0.5], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.1, "height": 0.1, "depth": 1.0, "units": "meters", "confidence": 0.8}, "transform": {"position": [1.85, -1.45, 0.5], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "gear-metal", "materialLayers": ["gear-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(214, 214, 211, 1.0)", "secondaryAlbedo": "rgba(150, 150, 148, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7, "evidence": "gear struts in the render sheet"}};
  node_main_bogie_stbd_10.add(mesh_main_bogie_stbd_10);
  meshes["main-bogie-stbd"] = mesh_main_bogie_stbd_10;
  colliders["main-bogie-stbd"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_main_bogie_stbd_10);

  const attachment_main_wheel_stbd_fwd_11 = {"parentId": "root", "parentSocket": "main-wheel-stbd-fwd-mount", "localStart": [1.85, -1.56, 0.08], "localEnd": [1.85, -1.56, 0.08], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01};
  const endpoint_main_wheel_stbd_fwd_11 = makeAttachmentEndpoint(attachment_main_wheel_stbd_fwd_11);
  const node_main_wheel_stbd_fwd_11 = new THREE.Group();
  node_main_wheel_stbd_fwd_11.name = "Main wheel (stbd, fwd)__pivot";
  node_main_wheel_stbd_fwd_11.scale.set(1, 1, 1);
  if (endpoint_main_wheel_stbd_fwd_11) {
    node_main_wheel_stbd_fwd_11.position.copy(endpoint_main_wheel_stbd_fwd_11.start);
    node_main_wheel_stbd_fwd_11.rotation.set(0.0, 0.0, 1.5707963267948966);
  } else {
    node_main_wheel_stbd_fwd_11.position.set(1.85, -1.56, 0.08);
    node_main_wheel_stbd_fwd_11.rotation.set(0.0, 0.0, 1.5707963267948966);
  }
  node_main_wheel_stbd_fwd_11.userData.sculptComponent = {"id": "main-wheel-stbd-fwd", "name": "Main wheel (stbd, fwd)", "level": "meso", "role": "wheel", "importance": 0.5, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "A tyre is a short cylinder on a lateral axle.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "main-wheel-stbd-fwd-mount", "localStart": [1.85, -1.56, 0.08], "localEnd": [1.85, -1.56, 0.08], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.6, "height": 0.24, "depth": 0.6, "units": "meters", "confidence": 0.8}, "transform": {"position": [1.85, -1.56, 0.08], "rotation": [0, 0, 1.5707963267948966]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-polymer", "materialLayers": ["dark-polymer"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front-view", "side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 44, 46, 1.0)", "secondaryAlbedo": "rgba(70, 70, 72, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.75, "evidence": "tyres and duct interiors"}};
  node_main_wheel_stbd_fwd_11.userData.actionProfile = {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_main_wheel_stbd_fwd_11);
  nodes["main-wheel-stbd-fwd"] = node_main_wheel_stbd_fwd_11;
  const mesh_main_wheel_stbd_fwd_11Geometry = endpoint_main_wheel_stbd_fwd_11
    ? new THREE.CylinderGeometry(endpoint_main_wheel_stbd_fwd_11.endRadius, endpoint_main_wheel_stbd_fwd_11.baseRadius, endpoint_main_wheel_stbd_fwd_11.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_main_wheel_stbd_fwd_11) {
    mesh_main_wheel_stbd_fwd_11Geometry.scale(0.6, 0.24, 0.6);
  }
  const mesh_main_wheel_stbd_fwd_11 = new THREE.Mesh(
    mesh_main_wheel_stbd_fwd_11Geometry,
    materialMap["dark-polymer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_main_wheel_stbd_fwd_11.name = "Main wheel (stbd, fwd)";
  if (endpoint_main_wheel_stbd_fwd_11) {
    mesh_main_wheel_stbd_fwd_11.position.copy(endpoint_main_wheel_stbd_fwd_11.midpoint);
    mesh_main_wheel_stbd_fwd_11.quaternion.copy(endpoint_main_wheel_stbd_fwd_11.quaternion);
  }
  mesh_main_wheel_stbd_fwd_11.castShadow = options.castShadow ?? true;
  mesh_main_wheel_stbd_fwd_11.receiveShadow = options.receiveShadow ?? true;
  mesh_main_wheel_stbd_fwd_11.userData.sculptComponent = {"id": "main-wheel-stbd-fwd", "name": "Main wheel (stbd, fwd)", "level": "meso", "role": "wheel", "importance": 0.5, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "A tyre is a short cylinder on a lateral axle.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "main-wheel-stbd-fwd-mount", "localStart": [1.85, -1.56, 0.08], "localEnd": [1.85, -1.56, 0.08], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.6, "height": 0.24, "depth": 0.6, "units": "meters", "confidence": 0.8}, "transform": {"position": [1.85, -1.56, 0.08], "rotation": [0, 0, 1.5707963267948966]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-polymer", "materialLayers": ["dark-polymer"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front-view", "side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 44, 46, 1.0)", "secondaryAlbedo": "rgba(70, 70, 72, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.75, "evidence": "tyres and duct interiors"}};
  node_main_wheel_stbd_fwd_11.add(mesh_main_wheel_stbd_fwd_11);
  meshes["main-wheel-stbd-fwd"] = mesh_main_wheel_stbd_fwd_11;
  colliders["main-wheel-stbd-fwd"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_main_wheel_stbd_fwd_11);

  const attachment_main_wheel_stbd_aft_12 = {"parentId": "root", "parentSocket": "main-wheel-stbd-aft-mount", "localStart": [1.85, -1.56, 0.92], "localEnd": [1.85, -1.56, 0.92], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01};
  const endpoint_main_wheel_stbd_aft_12 = makeAttachmentEndpoint(attachment_main_wheel_stbd_aft_12);
  const node_main_wheel_stbd_aft_12 = new THREE.Group();
  node_main_wheel_stbd_aft_12.name = "Main wheel (stbd, aft)__pivot";
  node_main_wheel_stbd_aft_12.scale.set(1, 1, 1);
  if (endpoint_main_wheel_stbd_aft_12) {
    node_main_wheel_stbd_aft_12.position.copy(endpoint_main_wheel_stbd_aft_12.start);
    node_main_wheel_stbd_aft_12.rotation.set(0.0, 0.0, 1.5707963267948966);
  } else {
    node_main_wheel_stbd_aft_12.position.set(1.85, -1.56, 0.92);
    node_main_wheel_stbd_aft_12.rotation.set(0.0, 0.0, 1.5707963267948966);
  }
  node_main_wheel_stbd_aft_12.userData.sculptComponent = {"id": "main-wheel-stbd-aft", "name": "Main wheel (stbd, aft)", "level": "meso", "role": "wheel", "importance": 0.5, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "A tyre is a short cylinder on a lateral axle.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "main-wheel-stbd-aft-mount", "localStart": [1.85, -1.56, 0.92], "localEnd": [1.85, -1.56, 0.92], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.6, "height": 0.24, "depth": 0.6, "units": "meters", "confidence": 0.8}, "transform": {"position": [1.85, -1.56, 0.92], "rotation": [0, 0, 1.5707963267948966]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-polymer", "materialLayers": ["dark-polymer"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front-view", "side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 44, 46, 1.0)", "secondaryAlbedo": "rgba(70, 70, 72, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.75, "evidence": "tyres and duct interiors"}};
  node_main_wheel_stbd_aft_12.userData.actionProfile = {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_main_wheel_stbd_aft_12);
  nodes["main-wheel-stbd-aft"] = node_main_wheel_stbd_aft_12;
  const mesh_main_wheel_stbd_aft_12Geometry = endpoint_main_wheel_stbd_aft_12
    ? new THREE.CylinderGeometry(endpoint_main_wheel_stbd_aft_12.endRadius, endpoint_main_wheel_stbd_aft_12.baseRadius, endpoint_main_wheel_stbd_aft_12.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_main_wheel_stbd_aft_12) {
    mesh_main_wheel_stbd_aft_12Geometry.scale(0.6, 0.24, 0.6);
  }
  const mesh_main_wheel_stbd_aft_12 = new THREE.Mesh(
    mesh_main_wheel_stbd_aft_12Geometry,
    materialMap["dark-polymer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_main_wheel_stbd_aft_12.name = "Main wheel (stbd, aft)";
  if (endpoint_main_wheel_stbd_aft_12) {
    mesh_main_wheel_stbd_aft_12.position.copy(endpoint_main_wheel_stbd_aft_12.midpoint);
    mesh_main_wheel_stbd_aft_12.quaternion.copy(endpoint_main_wheel_stbd_aft_12.quaternion);
  }
  mesh_main_wheel_stbd_aft_12.castShadow = options.castShadow ?? true;
  mesh_main_wheel_stbd_aft_12.receiveShadow = options.receiveShadow ?? true;
  mesh_main_wheel_stbd_aft_12.userData.sculptComponent = {"id": "main-wheel-stbd-aft", "name": "Main wheel (stbd, aft)", "level": "meso", "role": "wheel", "importance": 0.5, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "A tyre is a short cylinder on a lateral axle.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "main-wheel-stbd-aft-mount", "localStart": [1.85, -1.56, 0.92], "localEnd": [1.85, -1.56, 0.92], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.6, "height": 0.24, "depth": 0.6, "units": "meters", "confidence": 0.8}, "transform": {"position": [1.85, -1.56, 0.92], "rotation": [0, 0, 1.5707963267948966]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-polymer", "materialLayers": ["dark-polymer"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front-view", "side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 44, 46, 1.0)", "secondaryAlbedo": "rgba(70, 70, 72, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.75, "evidence": "tyres and duct interiors"}};
  node_main_wheel_stbd_aft_12.add(mesh_main_wheel_stbd_aft_12);
  meshes["main-wheel-stbd-aft"] = mesh_main_wheel_stbd_aft_12;
  colliders["main-wheel-stbd-aft"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_main_wheel_stbd_aft_12);

  const endpoint_main_door_stbd_13 = makeAttachmentEndpoint(null);
  const node_main_door_stbd_13 = new THREE.Group();
  node_main_door_stbd_13.name = "Main gear bay door (stbd)__pivot";
  node_main_door_stbd_13.scale.set(1, 1, 1);
  if (endpoint_main_door_stbd_13) {
    node_main_door_stbd_13.position.copy(endpoint_main_door_stbd_13.start);
    node_main_door_stbd_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_main_door_stbd_13.position.set(2.35, -1.3, 0.5);
    node_main_door_stbd_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_main_door_stbd_13.userData.sculptComponent = {"id": "main-door-stbd", "name": "Main gear bay door (stbd)", "level": "meso", "role": "door", "importance": 0.4, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Large flat panel hanging outboard of the leg.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "main-door-stbd-mount", "localStart": [2.35, -1.3, 0.5], "localEnd": [2.35, -1.3, 0.5], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.04, "height": 0.7, "depth": 1.3, "units": "meters", "confidence": 0.8}, "transform": {"position": [2.35, -1.3, 0.5], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "airframe", "materialLayers": ["airframe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(189, 185, 178, 1.0)", "secondaryAlbedo": "rgba(160, 156, 150, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidence": "composite skin reads as matte light grey in both references"}};
  node_main_door_stbd_13.userData.actionProfile = {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_main_door_stbd_13);
  nodes["main-door-stbd"] = node_main_door_stbd_13;
  const mesh_main_door_stbd_13Geometry = endpoint_main_door_stbd_13
    ? new THREE.CylinderGeometry(endpoint_main_door_stbd_13.endRadius, endpoint_main_door_stbd_13.baseRadius, endpoint_main_door_stbd_13.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_main_door_stbd_13) {
    mesh_main_door_stbd_13Geometry.scale(0.04, 0.7, 1.3);
  }
  const mesh_main_door_stbd_13 = new THREE.Mesh(
    mesh_main_door_stbd_13Geometry,
    materialMap["airframe"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_main_door_stbd_13.name = "Main gear bay door (stbd)";
  if (endpoint_main_door_stbd_13) {
    mesh_main_door_stbd_13.position.copy(endpoint_main_door_stbd_13.midpoint);
    mesh_main_door_stbd_13.quaternion.copy(endpoint_main_door_stbd_13.quaternion);
  }
  mesh_main_door_stbd_13.castShadow = options.castShadow ?? true;
  mesh_main_door_stbd_13.receiveShadow = options.receiveShadow ?? true;
  mesh_main_door_stbd_13.userData.sculptComponent = {"id": "main-door-stbd", "name": "Main gear bay door (stbd)", "level": "meso", "role": "door", "importance": 0.4, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Large flat panel hanging outboard of the leg.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "main-door-stbd-mount", "localStart": [2.35, -1.3, 0.5], "localEnd": [2.35, -1.3, 0.5], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.04, "height": 0.7, "depth": 1.3, "units": "meters", "confidence": 0.8}, "transform": {"position": [2.35, -1.3, 0.5], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "airframe", "materialLayers": ["airframe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(189, 185, 178, 1.0)", "secondaryAlbedo": "rgba(160, 156, 150, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidence": "composite skin reads as matte light grey in both references"}};
  node_main_door_stbd_13.add(mesh_main_door_stbd_13);
  meshes["main-door-stbd"] = mesh_main_door_stbd_13;
  colliders["main-door-stbd"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_main_door_stbd_13);

  const attachment_main_strut_port_14 = {"parentId": "root", "parentSocket": "main-strut-port-mount", "localStart": [-1.85, -1.15, 0.5], "localEnd": [-1.85, -1.15, 0.5], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01};
  const endpoint_main_strut_port_14 = makeAttachmentEndpoint(attachment_main_strut_port_14);
  const node_main_strut_port_14 = new THREE.Group();
  node_main_strut_port_14.name = "Main gear strut (port)__pivot";
  node_main_strut_port_14.scale.set(1, 1, 1);
  if (endpoint_main_strut_port_14) {
    node_main_strut_port_14.position.copy(endpoint_main_strut_port_14.start);
    node_main_strut_port_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_main_strut_port_14.position.set(-1.85, -1.15, 0.5);
    node_main_strut_port_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_main_strut_port_14.userData.sculptComponent = {"id": "main-strut-port", "name": "Main gear strut (port)", "level": "meso", "role": "gear", "importance": 0.5, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Machined oleo leg.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "main-strut-port-mount", "localStart": [-1.85, -1.15, 0.5], "localEnd": [-1.85, -1.15, 0.5], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.14, "height": 0.6, "depth": 0.14, "units": "meters", "confidence": 0.8}, "transform": {"position": [-1.85, -1.15, 0.5], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "gear-metal", "materialLayers": ["gear-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front-view", "side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(214, 214, 211, 1.0)", "secondaryAlbedo": "rgba(150, 150, 148, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7, "evidence": "gear struts in the render sheet"}};
  node_main_strut_port_14.userData.actionProfile = {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_main_strut_port_14);
  nodes["main-strut-port"] = node_main_strut_port_14;
  const mesh_main_strut_port_14Geometry = endpoint_main_strut_port_14
    ? new THREE.CylinderGeometry(endpoint_main_strut_port_14.endRadius, endpoint_main_strut_port_14.baseRadius, endpoint_main_strut_port_14.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_main_strut_port_14) {
    mesh_main_strut_port_14Geometry.scale(0.14, 0.6, 0.14);
  }
  const mesh_main_strut_port_14 = new THREE.Mesh(
    mesh_main_strut_port_14Geometry,
    materialMap["gear-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_main_strut_port_14.name = "Main gear strut (port)";
  if (endpoint_main_strut_port_14) {
    mesh_main_strut_port_14.position.copy(endpoint_main_strut_port_14.midpoint);
    mesh_main_strut_port_14.quaternion.copy(endpoint_main_strut_port_14.quaternion);
  }
  mesh_main_strut_port_14.castShadow = options.castShadow ?? true;
  mesh_main_strut_port_14.receiveShadow = options.receiveShadow ?? true;
  mesh_main_strut_port_14.userData.sculptComponent = {"id": "main-strut-port", "name": "Main gear strut (port)", "level": "meso", "role": "gear", "importance": 0.5, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Machined oleo leg.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "main-strut-port-mount", "localStart": [-1.85, -1.15, 0.5], "localEnd": [-1.85, -1.15, 0.5], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.14, "height": 0.6, "depth": 0.14, "units": "meters", "confidence": 0.8}, "transform": {"position": [-1.85, -1.15, 0.5], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "gear-metal", "materialLayers": ["gear-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front-view", "side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(214, 214, 211, 1.0)", "secondaryAlbedo": "rgba(150, 150, 148, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7, "evidence": "gear struts in the render sheet"}};
  node_main_strut_port_14.add(mesh_main_strut_port_14);
  meshes["main-strut-port"] = mesh_main_strut_port_14;
  colliders["main-strut-port"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_main_strut_port_14);

  const endpoint_main_bogie_port_15 = makeAttachmentEndpoint(null);
  const node_main_bogie_port_15 = new THREE.Group();
  node_main_bogie_port_15.name = "Main gear bogie beam (port)__pivot";
  node_main_bogie_port_15.scale.set(1, 1, 1);
  if (endpoint_main_bogie_port_15) {
    node_main_bogie_port_15.position.copy(endpoint_main_bogie_port_15.start);
    node_main_bogie_port_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_main_bogie_port_15.position.set(-1.85, -1.45, 0.5);
    node_main_bogie_port_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_main_bogie_port_15.userData.sculptComponent = {"id": "main-bogie-port", "name": "Main gear bogie beam (port)", "level": "meso", "role": "gear", "importance": 0.3, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Beam carrying the tandem wheels.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "main-bogie-port-mount", "localStart": [-1.85, -1.45, 0.5], "localEnd": [-1.85, -1.45, 0.5], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.1, "height": 0.1, "depth": 1.0, "units": "meters", "confidence": 0.8}, "transform": {"position": [-1.85, -1.45, 0.5], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "gear-metal", "materialLayers": ["gear-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(214, 214, 211, 1.0)", "secondaryAlbedo": "rgba(150, 150, 148, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7, "evidence": "gear struts in the render sheet"}};
  node_main_bogie_port_15.userData.actionProfile = {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_main_bogie_port_15);
  nodes["main-bogie-port"] = node_main_bogie_port_15;
  const mesh_main_bogie_port_15Geometry = endpoint_main_bogie_port_15
    ? new THREE.CylinderGeometry(endpoint_main_bogie_port_15.endRadius, endpoint_main_bogie_port_15.baseRadius, endpoint_main_bogie_port_15.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_main_bogie_port_15) {
    mesh_main_bogie_port_15Geometry.scale(0.1, 0.1, 1.0);
  }
  const mesh_main_bogie_port_15 = new THREE.Mesh(
    mesh_main_bogie_port_15Geometry,
    materialMap["gear-metal"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_main_bogie_port_15.name = "Main gear bogie beam (port)";
  if (endpoint_main_bogie_port_15) {
    mesh_main_bogie_port_15.position.copy(endpoint_main_bogie_port_15.midpoint);
    mesh_main_bogie_port_15.quaternion.copy(endpoint_main_bogie_port_15.quaternion);
  }
  mesh_main_bogie_port_15.castShadow = options.castShadow ?? true;
  mesh_main_bogie_port_15.receiveShadow = options.receiveShadow ?? true;
  mesh_main_bogie_port_15.userData.sculptComponent = {"id": "main-bogie-port", "name": "Main gear bogie beam (port)", "level": "meso", "role": "gear", "importance": 0.3, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Beam carrying the tandem wheels.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "main-bogie-port-mount", "localStart": [-1.85, -1.45, 0.5], "localEnd": [-1.85, -1.45, 0.5], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.1, "height": 0.1, "depth": 1.0, "units": "meters", "confidence": 0.8}, "transform": {"position": [-1.85, -1.45, 0.5], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "gear-metal", "materialLayers": ["gear-metal"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(214, 214, 211, 1.0)", "secondaryAlbedo": "rgba(150, 150, 148, 1.0)", "materialClass": "metal", "materialClassConfidence": 0.7, "evidence": "gear struts in the render sheet"}};
  node_main_bogie_port_15.add(mesh_main_bogie_port_15);
  meshes["main-bogie-port"] = mesh_main_bogie_port_15;
  colliders["main-bogie-port"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_main_bogie_port_15);

  const attachment_main_wheel_port_fwd_16 = {"parentId": "root", "parentSocket": "main-wheel-port-fwd-mount", "localStart": [-1.85, -1.56, 0.08], "localEnd": [-1.85, -1.56, 0.08], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01};
  const endpoint_main_wheel_port_fwd_16 = makeAttachmentEndpoint(attachment_main_wheel_port_fwd_16);
  const node_main_wheel_port_fwd_16 = new THREE.Group();
  node_main_wheel_port_fwd_16.name = "Main wheel (port, fwd)__pivot";
  node_main_wheel_port_fwd_16.scale.set(1, 1, 1);
  if (endpoint_main_wheel_port_fwd_16) {
    node_main_wheel_port_fwd_16.position.copy(endpoint_main_wheel_port_fwd_16.start);
    node_main_wheel_port_fwd_16.rotation.set(0.0, 0.0, 1.5707963267948966);
  } else {
    node_main_wheel_port_fwd_16.position.set(-1.85, -1.56, 0.08);
    node_main_wheel_port_fwd_16.rotation.set(0.0, 0.0, 1.5707963267948966);
  }
  node_main_wheel_port_fwd_16.userData.sculptComponent = {"id": "main-wheel-port-fwd", "name": "Main wheel (port, fwd)", "level": "meso", "role": "wheel", "importance": 0.5, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "A tyre is a short cylinder on a lateral axle.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "main-wheel-port-fwd-mount", "localStart": [-1.85, -1.56, 0.08], "localEnd": [-1.85, -1.56, 0.08], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.6, "height": 0.24, "depth": 0.6, "units": "meters", "confidence": 0.8}, "transform": {"position": [-1.85, -1.56, 0.08], "rotation": [0, 0, 1.5707963267948966]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-polymer", "materialLayers": ["dark-polymer"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front-view", "side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 44, 46, 1.0)", "secondaryAlbedo": "rgba(70, 70, 72, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.75, "evidence": "tyres and duct interiors"}};
  node_main_wheel_port_fwd_16.userData.actionProfile = {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_main_wheel_port_fwd_16);
  nodes["main-wheel-port-fwd"] = node_main_wheel_port_fwd_16;
  const mesh_main_wheel_port_fwd_16Geometry = endpoint_main_wheel_port_fwd_16
    ? new THREE.CylinderGeometry(endpoint_main_wheel_port_fwd_16.endRadius, endpoint_main_wheel_port_fwd_16.baseRadius, endpoint_main_wheel_port_fwd_16.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_main_wheel_port_fwd_16) {
    mesh_main_wheel_port_fwd_16Geometry.scale(0.6, 0.24, 0.6);
  }
  const mesh_main_wheel_port_fwd_16 = new THREE.Mesh(
    mesh_main_wheel_port_fwd_16Geometry,
    materialMap["dark-polymer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_main_wheel_port_fwd_16.name = "Main wheel (port, fwd)";
  if (endpoint_main_wheel_port_fwd_16) {
    mesh_main_wheel_port_fwd_16.position.copy(endpoint_main_wheel_port_fwd_16.midpoint);
    mesh_main_wheel_port_fwd_16.quaternion.copy(endpoint_main_wheel_port_fwd_16.quaternion);
  }
  mesh_main_wheel_port_fwd_16.castShadow = options.castShadow ?? true;
  mesh_main_wheel_port_fwd_16.receiveShadow = options.receiveShadow ?? true;
  mesh_main_wheel_port_fwd_16.userData.sculptComponent = {"id": "main-wheel-port-fwd", "name": "Main wheel (port, fwd)", "level": "meso", "role": "wheel", "importance": 0.5, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "A tyre is a short cylinder on a lateral axle.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "main-wheel-port-fwd-mount", "localStart": [-1.85, -1.56, 0.08], "localEnd": [-1.85, -1.56, 0.08], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.6, "height": 0.24, "depth": 0.6, "units": "meters", "confidence": 0.8}, "transform": {"position": [-1.85, -1.56, 0.08], "rotation": [0, 0, 1.5707963267948966]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-polymer", "materialLayers": ["dark-polymer"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front-view", "side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 44, 46, 1.0)", "secondaryAlbedo": "rgba(70, 70, 72, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.75, "evidence": "tyres and duct interiors"}};
  node_main_wheel_port_fwd_16.add(mesh_main_wheel_port_fwd_16);
  meshes["main-wheel-port-fwd"] = mesh_main_wheel_port_fwd_16;
  colliders["main-wheel-port-fwd"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_main_wheel_port_fwd_16);

  const attachment_main_wheel_port_aft_17 = {"parentId": "root", "parentSocket": "main-wheel-port-aft-mount", "localStart": [-1.85, -1.56, 0.92], "localEnd": [-1.85, -1.56, 0.92], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01};
  const endpoint_main_wheel_port_aft_17 = makeAttachmentEndpoint(attachment_main_wheel_port_aft_17);
  const node_main_wheel_port_aft_17 = new THREE.Group();
  node_main_wheel_port_aft_17.name = "Main wheel (port, aft)__pivot";
  node_main_wheel_port_aft_17.scale.set(1, 1, 1);
  if (endpoint_main_wheel_port_aft_17) {
    node_main_wheel_port_aft_17.position.copy(endpoint_main_wheel_port_aft_17.start);
    node_main_wheel_port_aft_17.rotation.set(0.0, 0.0, 1.5707963267948966);
  } else {
    node_main_wheel_port_aft_17.position.set(-1.85, -1.56, 0.92);
    node_main_wheel_port_aft_17.rotation.set(0.0, 0.0, 1.5707963267948966);
  }
  node_main_wheel_port_aft_17.userData.sculptComponent = {"id": "main-wheel-port-aft", "name": "Main wheel (port, aft)", "level": "meso", "role": "wheel", "importance": 0.5, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "A tyre is a short cylinder on a lateral axle.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "main-wheel-port-aft-mount", "localStart": [-1.85, -1.56, 0.92], "localEnd": [-1.85, -1.56, 0.92], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.6, "height": 0.24, "depth": 0.6, "units": "meters", "confidence": 0.8}, "transform": {"position": [-1.85, -1.56, 0.92], "rotation": [0, 0, 1.5707963267948966]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-polymer", "materialLayers": ["dark-polymer"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front-view", "side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 44, 46, 1.0)", "secondaryAlbedo": "rgba(70, 70, 72, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.75, "evidence": "tyres and duct interiors"}};
  node_main_wheel_port_aft_17.userData.actionProfile = {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_main_wheel_port_aft_17);
  nodes["main-wheel-port-aft"] = node_main_wheel_port_aft_17;
  const mesh_main_wheel_port_aft_17Geometry = endpoint_main_wheel_port_aft_17
    ? new THREE.CylinderGeometry(endpoint_main_wheel_port_aft_17.endRadius, endpoint_main_wheel_port_aft_17.baseRadius, endpoint_main_wheel_port_aft_17.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_main_wheel_port_aft_17) {
    mesh_main_wheel_port_aft_17Geometry.scale(0.6, 0.24, 0.6);
  }
  const mesh_main_wheel_port_aft_17 = new THREE.Mesh(
    mesh_main_wheel_port_aft_17Geometry,
    materialMap["dark-polymer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_main_wheel_port_aft_17.name = "Main wheel (port, aft)";
  if (endpoint_main_wheel_port_aft_17) {
    mesh_main_wheel_port_aft_17.position.copy(endpoint_main_wheel_port_aft_17.midpoint);
    mesh_main_wheel_port_aft_17.quaternion.copy(endpoint_main_wheel_port_aft_17.quaternion);
  }
  mesh_main_wheel_port_aft_17.castShadow = options.castShadow ?? true;
  mesh_main_wheel_port_aft_17.receiveShadow = options.receiveShadow ?? true;
  mesh_main_wheel_port_aft_17.userData.sculptComponent = {"id": "main-wheel-port-aft", "name": "Main wheel (port, aft)", "level": "meso", "role": "wheel", "importance": 0.5, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "A tyre is a short cylinder on a lateral axle.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "main-wheel-port-aft-mount", "localStart": [-1.85, -1.56, 0.92], "localEnd": [-1.85, -1.56, 0.92], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.6, "height": 0.24, "depth": 0.6, "units": "meters", "confidence": 0.8}, "transform": {"position": [-1.85, -1.56, 0.92], "rotation": [0, 0, 1.5707963267948966]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-polymer", "materialLayers": ["dark-polymer"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front-view", "side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 44, 46, 1.0)", "secondaryAlbedo": "rgba(70, 70, 72, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.75, "evidence": "tyres and duct interiors"}};
  node_main_wheel_port_aft_17.add(mesh_main_wheel_port_aft_17);
  meshes["main-wheel-port-aft"] = mesh_main_wheel_port_aft_17;
  colliders["main-wheel-port-aft"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_main_wheel_port_aft_17);

  const endpoint_main_door_port_18 = makeAttachmentEndpoint(null);
  const node_main_door_port_18 = new THREE.Group();
  node_main_door_port_18.name = "Main gear bay door (port)__pivot";
  node_main_door_port_18.scale.set(1, 1, 1);
  if (endpoint_main_door_port_18) {
    node_main_door_port_18.position.copy(endpoint_main_door_port_18.start);
    node_main_door_port_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_main_door_port_18.position.set(-2.35, -1.3, 0.5);
    node_main_door_port_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_main_door_port_18.userData.sculptComponent = {"id": "main-door-port", "name": "Main gear bay door (port)", "level": "meso", "role": "door", "importance": 0.4, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Large flat panel hanging outboard of the leg.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "main-door-port-mount", "localStart": [-2.35, -1.3, 0.5], "localEnd": [-2.35, -1.3, 0.5], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.04, "height": 0.7, "depth": 1.3, "units": "meters", "confidence": 0.8}, "transform": {"position": [-2.35, -1.3, 0.5], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "airframe", "materialLayers": ["airframe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(189, 185, 178, 1.0)", "secondaryAlbedo": "rgba(160, 156, 150, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidence": "composite skin reads as matte light grey in both references"}};
  node_main_door_port_18.userData.actionProfile = {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_main_door_port_18);
  nodes["main-door-port"] = node_main_door_port_18;
  const mesh_main_door_port_18Geometry = endpoint_main_door_port_18
    ? new THREE.CylinderGeometry(endpoint_main_door_port_18.endRadius, endpoint_main_door_port_18.baseRadius, endpoint_main_door_port_18.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_main_door_port_18) {
    mesh_main_door_port_18Geometry.scale(0.04, 0.7, 1.3);
  }
  const mesh_main_door_port_18 = new THREE.Mesh(
    mesh_main_door_port_18Geometry,
    materialMap["airframe"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_main_door_port_18.name = "Main gear bay door (port)";
  if (endpoint_main_door_port_18) {
    mesh_main_door_port_18.position.copy(endpoint_main_door_port_18.midpoint);
    mesh_main_door_port_18.quaternion.copy(endpoint_main_door_port_18.quaternion);
  }
  mesh_main_door_port_18.castShadow = options.castShadow ?? true;
  mesh_main_door_port_18.receiveShadow = options.receiveShadow ?? true;
  mesh_main_door_port_18.userData.sculptComponent = {"id": "main-door-port", "name": "Main gear bay door (port)", "level": "meso", "role": "door", "importance": 0.4, "confidence": 0.8, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Large flat panel hanging outboard of the leg.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "main-door-port-mount", "localStart": [-2.35, -1.3, 0.5], "localEnd": [-2.35, -1.3, 0.5], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.04, "height": 0.7, "depth": 1.3, "units": "meters", "confidence": 0.8}, "transform": {"position": [-2.35, -1.3, 0.5], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "airframe", "materialLayers": ["airframe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["side-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(189, 185, 178, 1.0)", "secondaryAlbedo": "rgba(160, 156, 150, 1.0)", "materialClass": "plastic", "materialClassConfidence": 0.7, "evidence": "composite skin reads as matte light grey in both references"}};
  node_main_door_port_18.add(mesh_main_door_port_18);
  meshes["main-door-port"] = mesh_main_door_port_18;
  colliders["main-door-port"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_main_door_port_18);

  const attachment_roundel_stbd_19 = {"parentId": "wing-stbd", "parentSocket": "roundel-stbd-mount", "localStart": [5.0, 0.004, 0.9443], "localEnd": [5.0, 0.004, 0.9443], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01};
  const endpoint_roundel_stbd_19 = makeAttachmentEndpoint(attachment_roundel_stbd_19);
  const node_roundel_stbd_19 = new THREE.Group();
  node_roundel_stbd_19.name = "National roundel (stbd)__pivot";
  node_roundel_stbd_19.scale.set(1, 1, 1);
  if (endpoint_roundel_stbd_19) {
    node_roundel_stbd_19.position.copy(endpoint_roundel_stbd_19.start);
    node_roundel_stbd_19.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_roundel_stbd_19.position.set(5.0, 0.004, 0.9443);
    node_roundel_stbd_19.rotation.set(0.0, 0.0, 0.0);
  }
  node_roundel_stbd_19.userData.sculptComponent = {"id": "roundel-stbd", "name": "National roundel (stbd)", "level": "micro", "role": "marking", "importance": 0.4, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "surface-relief", "topologyRationale": "A flat disc a few millimetres proud of the skin stands in for the decal until the material pass.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wing-stbd", "attachment": {"parentId": "wing-stbd", "parentSocket": "roundel-stbd-mount", "localStart": [5.0, 0.004, 0.9443], "localEnd": [5.0, 0.004, 0.9443], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.8, "height": 0.008, "depth": 0.8, "units": "meters", "confidence": 0.8}, "transform": {"position": [5.0, 0.004, 0.9443], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-polymer", "materialLayers": ["dark-polymer"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "roundel-decal-stbd", "name": "Star-and-bars roundel", "kind": "decal", "description": "US national insignia at 50 % span, mid-chord"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["top-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 44, 46, 1.0)", "secondaryAlbedo": "rgba(70, 70, 72, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.75, "evidence": "tyres and duct interiors"}};
  node_roundel_stbd_19.userData.actionProfile = {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["wing-stbd"] ?? root).add(node_roundel_stbd_19);
  nodes["roundel-stbd"] = node_roundel_stbd_19;
  const mesh_roundel_stbd_19Geometry = endpoint_roundel_stbd_19
    ? new THREE.CylinderGeometry(endpoint_roundel_stbd_19.endRadius, endpoint_roundel_stbd_19.baseRadius, endpoint_roundel_stbd_19.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_roundel_stbd_19) {
    mesh_roundel_stbd_19Geometry.scale(0.8, 0.008, 0.8);
  }
  const mesh_roundel_stbd_19 = new THREE.Mesh(
    mesh_roundel_stbd_19Geometry,
    materialMap["dark-polymer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_roundel_stbd_19.name = "National roundel (stbd)";
  if (endpoint_roundel_stbd_19) {
    mesh_roundel_stbd_19.position.copy(endpoint_roundel_stbd_19.midpoint);
    mesh_roundel_stbd_19.quaternion.copy(endpoint_roundel_stbd_19.quaternion);
  }
  mesh_roundel_stbd_19.castShadow = options.castShadow ?? true;
  mesh_roundel_stbd_19.receiveShadow = options.receiveShadow ?? true;
  mesh_roundel_stbd_19.userData.sculptComponent = {"id": "roundel-stbd", "name": "National roundel (stbd)", "level": "micro", "role": "marking", "importance": 0.4, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "surface-relief", "topologyRationale": "A flat disc a few millimetres proud of the skin stands in for the decal until the material pass.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wing-stbd", "attachment": {"parentId": "wing-stbd", "parentSocket": "roundel-stbd-mount", "localStart": [5.0, 0.004, 0.9443], "localEnd": [5.0, 0.004, 0.9443], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.8, "height": 0.008, "depth": 0.8, "units": "meters", "confidence": 0.8}, "transform": {"position": [5.0, 0.004, 0.9443], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-polymer", "materialLayers": ["dark-polymer"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "roundel-decal-stbd", "name": "Star-and-bars roundel", "kind": "decal", "description": "US national insignia at 50 % span, mid-chord"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["top-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 44, 46, 1.0)", "secondaryAlbedo": "rgba(70, 70, 72, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.75, "evidence": "tyres and duct interiors"}};
  node_roundel_stbd_19.add(mesh_roundel_stbd_19);
  meshes["roundel-stbd"] = mesh_roundel_stbd_19;
  colliders["roundel-stbd"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_roundel_stbd_19);

  const endpoint_vent_stbd_20 = makeAttachmentEndpoint(null);
  const node_vent_stbd_20 = new THREE.Group();
  node_vent_stbd_20.name = "Wing vent slot (stbd)__pivot";
  node_vent_stbd_20.scale.set(1, 1, 1);
  if (endpoint_vent_stbd_20) {
    node_vent_stbd_20.position.copy(endpoint_vent_stbd_20.start);
    node_vent_stbd_20.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vent_stbd_20.position.set(4.55, 0.005, 0.1029);
    node_vent_stbd_20.rotation.set(0.0, 0.0, 0.0);
  }
  node_vent_stbd_20.userData.sculptComponent = {"id": "vent-stbd", "name": "Wing vent slot (stbd)", "level": "micro", "role": "vent", "importance": 0.2, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "A shallow dark slot in the skin.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wing-stbd", "attachment": {"parentId": "wing-stbd", "parentSocket": "vent-stbd-mount", "localStart": [4.55, 0.005, 0.1029], "localEnd": [4.55, 0.005, 0.1029], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.14, "height": 0.01, "depth": 0.06, "units": "meters", "confidence": 0.8}, "transform": {"position": [4.55, 0.005, 0.1029], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-polymer", "materialLayers": ["dark-polymer"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "vent-groove-stbd", "name": "Vent slot", "kind": "groove", "description": "small rectangular slot inboard of the roundel"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["top-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 44, 46, 1.0)", "secondaryAlbedo": "rgba(70, 70, 72, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.75, "evidence": "tyres and duct interiors"}};
  node_vent_stbd_20.userData.actionProfile = {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["wing-stbd"] ?? root).add(node_vent_stbd_20);
  nodes["vent-stbd"] = node_vent_stbd_20;
  const mesh_vent_stbd_20Geometry = endpoint_vent_stbd_20
    ? new THREE.CylinderGeometry(endpoint_vent_stbd_20.endRadius, endpoint_vent_stbd_20.baseRadius, endpoint_vent_stbd_20.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_vent_stbd_20) {
    mesh_vent_stbd_20Geometry.scale(0.14, 0.01, 0.06);
  }
  const mesh_vent_stbd_20 = new THREE.Mesh(
    mesh_vent_stbd_20Geometry,
    materialMap["dark-polymer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vent_stbd_20.name = "Wing vent slot (stbd)";
  if (endpoint_vent_stbd_20) {
    mesh_vent_stbd_20.position.copy(endpoint_vent_stbd_20.midpoint);
    mesh_vent_stbd_20.quaternion.copy(endpoint_vent_stbd_20.quaternion);
  }
  mesh_vent_stbd_20.castShadow = options.castShadow ?? true;
  mesh_vent_stbd_20.receiveShadow = options.receiveShadow ?? true;
  mesh_vent_stbd_20.userData.sculptComponent = {"id": "vent-stbd", "name": "Wing vent slot (stbd)", "level": "micro", "role": "vent", "importance": 0.2, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "A shallow dark slot in the skin.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wing-stbd", "attachment": {"parentId": "wing-stbd", "parentSocket": "vent-stbd-mount", "localStart": [4.55, 0.005, 0.1029], "localEnd": [4.55, 0.005, 0.1029], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.14, "height": 0.01, "depth": 0.06, "units": "meters", "confidence": 0.8}, "transform": {"position": [4.55, 0.005, 0.1029], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-polymer", "materialLayers": ["dark-polymer"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "vent-groove-stbd", "name": "Vent slot", "kind": "groove", "description": "small rectangular slot inboard of the roundel"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["top-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 44, 46, 1.0)", "secondaryAlbedo": "rgba(70, 70, 72, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.75, "evidence": "tyres and duct interiors"}};
  node_vent_stbd_20.add(mesh_vent_stbd_20);
  meshes["vent-stbd"] = mesh_vent_stbd_20;
  colliders["vent-stbd"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vent_stbd_20);

  const attachment_roundel_port_21 = {"parentId": "wing-port", "parentSocket": "roundel-port-mount", "localStart": [-5.0, 0.004, 0.9443], "localEnd": [-5.0, 0.004, 0.9443], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01};
  const endpoint_roundel_port_21 = makeAttachmentEndpoint(attachment_roundel_port_21);
  const node_roundel_port_21 = new THREE.Group();
  node_roundel_port_21.name = "National roundel (port)__pivot";
  node_roundel_port_21.scale.set(1, 1, 1);
  if (endpoint_roundel_port_21) {
    node_roundel_port_21.position.copy(endpoint_roundel_port_21.start);
    node_roundel_port_21.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_roundel_port_21.position.set(-5.0, 0.004, 0.9443);
    node_roundel_port_21.rotation.set(0.0, 0.0, 0.0);
  }
  node_roundel_port_21.userData.sculptComponent = {"id": "roundel-port", "name": "National roundel (port)", "level": "micro", "role": "marking", "importance": 0.4, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "surface-relief", "topologyRationale": "A flat disc a few millimetres proud of the skin stands in for the decal until the material pass.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wing-port", "attachment": {"parentId": "wing-port", "parentSocket": "roundel-port-mount", "localStart": [-5.0, 0.004, 0.9443], "localEnd": [-5.0, 0.004, 0.9443], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.8, "height": 0.008, "depth": 0.8, "units": "meters", "confidence": 0.8}, "transform": {"position": [-5.0, 0.004, 0.9443], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-polymer", "materialLayers": ["dark-polymer"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "roundel-decal-port", "name": "Star-and-bars roundel", "kind": "decal", "description": "US national insignia at 50 % span, mid-chord"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["top-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 44, 46, 1.0)", "secondaryAlbedo": "rgba(70, 70, 72, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.75, "evidence": "tyres and duct interiors"}};
  node_roundel_port_21.userData.actionProfile = {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["wing-port"] ?? root).add(node_roundel_port_21);
  nodes["roundel-port"] = node_roundel_port_21;
  const mesh_roundel_port_21Geometry = endpoint_roundel_port_21
    ? new THREE.CylinderGeometry(endpoint_roundel_port_21.endRadius, endpoint_roundel_port_21.baseRadius, endpoint_roundel_port_21.length, 16, 6)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 24, 8);
  if (!endpoint_roundel_port_21) {
    mesh_roundel_port_21Geometry.scale(0.8, 0.008, 0.8);
  }
  const mesh_roundel_port_21 = new THREE.Mesh(
    mesh_roundel_port_21Geometry,
    materialMap["dark-polymer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_roundel_port_21.name = "National roundel (port)";
  if (endpoint_roundel_port_21) {
    mesh_roundel_port_21.position.copy(endpoint_roundel_port_21.midpoint);
    mesh_roundel_port_21.quaternion.copy(endpoint_roundel_port_21.quaternion);
  }
  mesh_roundel_port_21.castShadow = options.castShadow ?? true;
  mesh_roundel_port_21.receiveShadow = options.receiveShadow ?? true;
  mesh_roundel_port_21.userData.sculptComponent = {"id": "roundel-port", "name": "National roundel (port)", "level": "micro", "role": "marking", "importance": 0.4, "confidence": 0.8, "primitive": "cylinder", "topologyClass": "surface-relief", "topologyRationale": "A flat disc a few millimetres proud of the skin stands in for the decal until the material pass.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wing-port", "attachment": {"parentId": "wing-port", "parentSocket": "roundel-port-mount", "localStart": [-5.0, 0.004, 0.9443], "localEnd": [-5.0, 0.004, 0.9443], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.8, "height": 0.008, "depth": 0.8, "units": "meters", "confidence": 0.8}, "transform": {"position": [-5.0, 0.004, 0.9443], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-polymer", "materialLayers": ["dark-polymer"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "roundel-decal-port", "name": "Star-and-bars roundel", "kind": "decal", "description": "US national insignia at 50 % span, mid-chord"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["top-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 44, 46, 1.0)", "secondaryAlbedo": "rgba(70, 70, 72, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.75, "evidence": "tyres and duct interiors"}};
  node_roundel_port_21.add(mesh_roundel_port_21);
  meshes["roundel-port"] = mesh_roundel_port_21;
  colliders["roundel-port"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_roundel_port_21);

  const endpoint_vent_port_22 = makeAttachmentEndpoint(null);
  const node_vent_port_22 = new THREE.Group();
  node_vent_port_22.name = "Wing vent slot (port)__pivot";
  node_vent_port_22.scale.set(1, 1, 1);
  if (endpoint_vent_port_22) {
    node_vent_port_22.position.copy(endpoint_vent_port_22.start);
    node_vent_port_22.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_vent_port_22.position.set(-4.55, 0.005, 0.1029);
    node_vent_port_22.rotation.set(0.0, 0.0, 0.0);
  }
  node_vent_port_22.userData.sculptComponent = {"id": "vent-port", "name": "Wing vent slot (port)", "level": "micro", "role": "vent", "importance": 0.2, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "A shallow dark slot in the skin.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wing-port", "attachment": {"parentId": "wing-port", "parentSocket": "vent-port-mount", "localStart": [-4.55, 0.005, 0.1029], "localEnd": [-4.55, 0.005, 0.1029], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.14, "height": 0.01, "depth": 0.06, "units": "meters", "confidence": 0.8}, "transform": {"position": [-4.55, 0.005, 0.1029], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-polymer", "materialLayers": ["dark-polymer"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "vent-groove-port", "name": "Vent slot", "kind": "groove", "description": "small rectangular slot inboard of the roundel"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["top-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 44, 46, 1.0)", "secondaryAlbedo": "rgba(70, 70, 72, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.75, "evidence": "tyres and duct interiors"}};
  node_vent_port_22.userData.actionProfile = {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["wing-port"] ?? root).add(node_vent_port_22);
  nodes["vent-port"] = node_vent_port_22;
  const mesh_vent_port_22Geometry = endpoint_vent_port_22
    ? new THREE.CylinderGeometry(endpoint_vent_port_22.endRadius, endpoint_vent_port_22.baseRadius, endpoint_vent_port_22.length, 16, 6)
    : new THREE.BoxGeometry(1, 1, 1, 4, 4, 4);
  if (!endpoint_vent_port_22) {
    mesh_vent_port_22Geometry.scale(0.14, 0.01, 0.06);
  }
  const mesh_vent_port_22 = new THREE.Mesh(
    mesh_vent_port_22Geometry,
    materialMap["dark-polymer"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_vent_port_22.name = "Wing vent slot (port)";
  if (endpoint_vent_port_22) {
    mesh_vent_port_22.position.copy(endpoint_vent_port_22.midpoint);
    mesh_vent_port_22.quaternion.copy(endpoint_vent_port_22.quaternion);
  }
  mesh_vent_port_22.castShadow = options.castShadow ?? true;
  mesh_vent_port_22.receiveShadow = options.receiveShadow ?? true;
  mesh_vent_port_22.userData.sculptComponent = {"id": "vent-port", "name": "Wing vent slot (port)", "level": "micro", "role": "vent", "importance": 0.2, "confidence": 0.8, "primitive": "box", "topologyClass": "surface-relief", "topologyRationale": "A shallow dark slot in the skin.", "geometryDescriptor": {"topologyIntent": "low-poly blockout with bevel-ready edges", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "wing-port", "attachment": {"parentId": "wing-port", "parentSocket": "vent-port-mount", "localStart": [-4.55, 0.005, 0.1029], "localEnd": [-4.55, 0.005, 0.1029], "contactType": "flush", "embedDepth": 0.05, "gapTolerance": 0.01}, "dimensions": {"width": 0.14, "height": 0.01, "depth": 0.06, "units": "meters", "confidence": 0.8}, "transform": {"position": [-4.55, 0.005, 0.1029], "rotation": [0, 0, 0]}, "actionProfile": {"animationRole": "child", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.5}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "dark-polymer", "materialLayers": ["dark-polymer"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "vent-groove-port", "name": "Vent slot", "kind": "groove", "description": "small rectangular slot inboard of the roundel"}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["top-view"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(43, 44, 46, 1.0)", "secondaryAlbedo": "rgba(70, 70, 72, 1.0)", "materialClass": "rubber", "materialClassConfidence": 0.75, "evidence": "tyres and duct interiors"}};
  node_vent_port_22.add(mesh_vent_port_22);
  meshes["vent-port"] = mesh_vent_port_22;
  colliders["vent-port"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Replace with sphere/capsule/compound proxy when the object shape demands it."};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_vent_port_22);

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createRQ170SentinelLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "RQ-170 Sentinel look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [{"id": "key", "type": "directional", "role": "key", "direction": [-0.4, -1.0, -0.3], "color": "#FFF6E8", "intensity": 2.2, "evidence": "shadows under the wings fall down-left in the render sheet"}, {"id": "fill", "type": "hemisphere", "role": "fill", "skyColor": "#DCE4EE", "groundColor": "#8C8478", "intensity": 0.8, "evidence": "soft studio fill; no hard secondary shadow"}, {"id": "rim", "type": "directional", "role": "rim", "direction": [0.6, -0.3, 0.8], "color": "#FFFFFF", "intensity": 0.6, "evidence": "edge highlight along the leading edges"}, {"id": "exposure", "type": "exposure", "toneMapping": "ACESFilmic", "exposure": 1.0, "note": "neutral studio exposure; the reference is a product render"}, {"id": "ground-shadow", "type": "contact-shadow", "note": "soft ground shadow under the airframe and wheels, as in the render sheet"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createRQ170SentinelEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameRQ170SentinelCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createRQ170SentinelPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureRQ170SentinelRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createRQ170SentinelInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
