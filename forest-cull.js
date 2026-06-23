// forest-cull.js — pure cull predicate for forest instances. v1 is camera-centered
// distance culling (mirrors the SP2 grass result that per-instance frustum culling was
// unnecessary). The TSL compute in forest-gpu.js transcribes this exactly:
//   dx*dx + dz*dz <= maxDist*maxDist
export function cullInstance(rec, cam, maxDist) {
  const dx = rec.x - cam.x, dz = rec.z - cam.z;
  return dx * dx + dz * dz <= maxDist * maxDist;
}
