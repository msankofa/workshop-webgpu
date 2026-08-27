// The Glass Plankton hybrid draws one SVG twice: as trail polylines and as an extruded glass solid.
// They only read as the same object if both land in the same box, and each gets there differently --
// the trail negates Y per point, the solid rotates 180 degrees about X (a mirror would invert its
// normals). A mismatch here still renders, it just quietly draws the trail flipped against the logo.
import * as THREE from 'three';

let failures = 0;
const check = (name, ok, detail = '') => {
  if (!ok) { failures++; console.error(`FAIL ${name} ${detail}`); }
  else console.log(`ok   ${name}`);
};

// Deliberately asymmetric in both axes, in SVG's Y-down space, so a flip cannot hide.
const outline = [
  [0, 0], [100, 0], [100, 20], [40, 20], [40, 90], [0, 90],
];

const xs = outline.map((p) => p[0]);
const ys = outline.map((p) => p[1]);
const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
const shapeSize = 60;
const scale = shapeSize / extent;

// Path A: what parseSharedShape does to each outline point.
const trail = outline.map(([x, y]) => [(x - cx) * scale, -(y - cy) * scale]);

// Path B: what buildGlassMesh does to the extruded solid.
const depthWorld = 14;
const depthSVG = depthWorld / scale;
const shape = new THREE.Shape();
shape.moveTo(outline[0][0], outline[0][1]);
for (let i = 1; i < outline.length; i++) shape.lineTo(outline[i][0], outline[i][1]);
shape.closePath();

const geometry = new THREE.ExtrudeGeometry([shape], { depth: depthSVG, bevelEnabled: false });
geometry.translate(-cx, -cy, -depthSVG / 2);
geometry.scale(scale, scale, scale);
geometry.rotateX(Math.PI);
geometry.computeBoundingBox();
const box = geometry.boundingBox;

const trailMinX = Math.min(...trail.map((p) => p[0]));
const trailMaxX = Math.max(...trail.map((p) => p[0]));
const trailMinY = Math.min(...trail.map((p) => p[1]));
const trailMaxY = Math.max(...trail.map((p) => p[1]));

const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

check('silhouette min X matches', near(box.min.x, trailMinX), `${box.min.x} vs ${trailMinX}`);
check('silhouette max X matches', near(box.max.x, trailMaxX), `${box.max.x} vs ${trailMaxX}`);
check('silhouette min Y matches', near(box.min.y, trailMinY), `${box.min.y} vs ${trailMinY}`);
check('silhouette max Y matches', near(box.max.y, trailMaxY), `${box.max.y} vs ${trailMaxY}`);

// The long edge sits at SVG y=0, which is +Y after the flip. Both paths must agree on which side.
const trailLongEdgeY = trail[0][1];
check('trail puts the long edge on +Y', trailLongEdgeY > 0, `${trailLongEdgeY}`);

const pos = geometry.attributes.position;
let widestY = null;
let widestSpan = -Infinity;
const rows = new Map();
for (let i = 0; i < pos.count; i++) {
  const y = Math.round(pos.getY(i) * 1e4) / 1e4;
  const x = pos.getX(i);
  const row = rows.get(y) || { min: Infinity, max: -Infinity };
  row.min = Math.min(row.min, x);
  row.max = Math.max(row.max, x);
  rows.set(y, row);
}
for (const [y, row] of rows) {
  const span = row.max - row.min;
  if (span > widestSpan + 1e-9) { widestSpan = span; widestY = y; }
}
check('solid puts the long edge on +Y too', widestY > 0, `widest row at y=${widestY}`);
check('long edge lands at the same Y', near(widestY, trailLongEdgeY, 1e-3), `${widestY} vs ${trailLongEdgeY}`);

// The extrusion must straddle z=0, or the trail would meet the front face instead of the middle.
check('extrusion is centred on z', near(box.min.z, -depthWorld / 2, 1e-6) && near(box.max.z, depthWorld / 2, 1e-6),
  `${box.min.z}..${box.max.z}`);

// rotateX is a proper rotation, so winding survives; a mirror would have flipped it.
const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
let frontFacing = 0, backFacing = 0;
for (let t = 0; t < pos.count; t += 3) {   // ExtrudeGeometry is non-indexed
  a.fromBufferAttribute(pos, t);
  b.fromBufferAttribute(pos, t + 1);
  c.fromBufferAttribute(pos, t + 2);
  const nz = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(a.z - box.max.z) < 1e-6 && Math.abs(b.z - box.max.z) < 1e-6 && Math.abs(c.z - box.max.z) < 1e-6) {
    if (nz > 0) frontFacing++; else backFacing++;
  }
}
check('front cap winds outward', frontFacing > 0 && backFacing === 0, `${frontFacing} ccw / ${backFacing} cw`);

console.log(failures === 0 ? '\nall alignment checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
