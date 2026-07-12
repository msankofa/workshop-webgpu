// effect-renderer.js — draws the serialized 'effect' entities (bullet tracers + impact
// sparks) produced by entity-types/effect.js. Additive lines + points, rebuilt each frame
// from the entity list. Fade is wall-clock, keyed by entity id (firstSeen), so host and
// guest fade identically regardless of when the entity first arrived over the wire.
//
// sync(list, nowMs): `list` is serialized effect wire objects; call every render frame.

const SPARK_RAYS = 6;

// Small deterministic hash → [0,1) so spark jitter is stable per entity id.
function hash01(str, salt) {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

export function createEffectRenderer({ THREE, scene, maxSegments = 2048, maxPoints = 512 }) {
  const segPos = new Float32Array(maxSegments * 2 * 3);
  const segCol = new Float32Array(maxSegments * 2 * 3);
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(segPos, 3));
  lineGeo.setAttribute('color', new THREE.BufferAttribute(segCol, 3));
  const lineMat = new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  lines.frustumCulled = false;
  scene.add(lines);

  const ptPos = new Float32Array(maxPoints * 3);
  const ptCol = new Float32Array(maxPoints * 3);
  const ptGeo = new THREE.BufferGeometry();
  ptGeo.setAttribute('position', new THREE.BufferAttribute(ptPos, 3));
  ptGeo.setAttribute('color', new THREE.BufferAttribute(ptCol, 3));
  const ptMat = new THREE.PointsMaterial({
    size: 0.35, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, sizeAttenuation: true,
  });
  const points = new THREE.Points(ptGeo, ptMat);
  points.frustumCulled = false;
  scene.add(points);

  const firstSeen = new Map(); // id -> nowMs first observed

  let segCount = 0, ptCount = 0;
  const pushSeg = (ax, ay, az, bx, by, bz, cr, cg, cb) => {
    if (segCount >= maxSegments) return;
    const i = segCount * 6;
    segPos[i] = ax; segPos[i + 1] = ay; segPos[i + 2] = az;
    segPos[i + 3] = bx; segPos[i + 4] = by; segPos[i + 5] = bz;
    segCol[i] = cr; segCol[i + 1] = cg; segCol[i + 2] = cb;
    segCol[i + 3] = cr; segCol[i + 4] = cg; segCol[i + 5] = cb;
    segCount++;
  };
  const pushPoint = (x, y, z, cr, cg, cb) => {
    if (ptCount >= maxPoints) return;
    const i = ptCount * 3;
    ptPos[i] = x; ptPos[i + 1] = y; ptPos[i + 2] = z;
    ptCol[i] = cr; ptCol[i + 1] = cg; ptCol[i + 2] = cb;
    ptCount++;
  };

  function sync(list, nowMs) {
    segCount = 0; ptCount = 0;
    const live = new Set();

    for (const e of (list || [])) {
      if (!e || e.type !== 'effect' || !Array.isArray(e.p)) continue;
      live.add(e.id);
      let seen = firstSeen.get(e.id);
      if (seen === undefined) { seen = nowMs; firstSeen.set(e.id, nowMs); }
      const lifeMs = (Number(e.life) || 0.1) * 1000;
      const a = 1 - Math.min(1, Math.max(0, (nowMs - seen) / lifeMs));
      if (a <= 0) continue;
      const col = e.color || [1, 0.85, 0.45];
      const cr = col[0] * a, cg = col[1] * a, cb = col[2] * a;

      if (e.kind === 'explosion') {
        // Expanding fireball: rays burst outward from center, growing over the effect's
        // life and scaled by blast radius. Center point flares bright then fades with `a`.
        const R = Math.max(1, Number(e.radius) || 6);
        const grow = R * (0.25 + (1 - a) * 0.9); // sphere expands as it ages
        const RAYS = 14;
        for (let k = 0; k < RAYS; k++) {
          let dx = hash01(e.id, k * 3 + 1) - 0.5;
          let dy = hash01(e.id, k * 3 + 2) - 0.5;
          let dz = hash01(e.id, k * 3 + 3) - 0.5;
          const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
          pushSeg(e.p[0], e.p[1], e.p[2],
            e.p[0] + dx * grow, e.p[1] + dy * grow, e.p[2] + dz * grow, cr, cg, cb);
          pushPoint(e.p[0] + dx * grow, e.p[1] + dy * grow, e.p[2] + dz * grow, cr, cg, cb);
        }
        pushPoint(e.p[0], e.p[1], e.p[2], cr, cg, cb);
      } else if (e.kind === 'hit_spark') {
        const n = e.normal || [0, 1, 0];
        const grow = 0.18 + (1 - a) * 1.1;
        for (let k = 0; k < SPARK_RAYS; k++) {
          const jx = hash01(e.id, k * 3 + 1) - 0.5;
          const jy = hash01(e.id, k * 3 + 2) - 0.5;
          const jz = hash01(e.id, k * 3 + 3) - 0.5;
          let dx = n[0] + jx * 1.6, dy = n[1] + jy * 1.6, dz = n[2] + jz * 1.6;
          const l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
          pushSeg(e.p[0], e.p[1], e.p[2],
            e.p[0] + dx * grow, e.p[1] + dy * grow, e.p[2] + dz * grow, cr, cg, cb);
        }
        pushPoint(e.p[0], e.p[1], e.p[2], cr, cg, cb);
      } else {
        const p1 = e.p1 || e.p;
        pushSeg(e.p[0], e.p[1], e.p[2], p1[0], p1[1], p1[2], cr, cg, cb);
        pushPoint(e.p[0], e.p[1], e.p[2], cr, cg, cb); // muzzle glow at the origin
      }
    }

    // Drop fade state for ids no longer present.
    if (firstSeen.size > live.size) {
      for (const id of firstSeen.keys()) if (!live.has(id)) firstSeen.delete(id);
    }

    lineGeo.setDrawRange(0, segCount * 2);
    lineGeo.attributes.position.needsUpdate = true;
    lineGeo.attributes.color.needsUpdate = true;
    ptGeo.setDrawRange(0, ptCount);
    ptGeo.attributes.position.needsUpdate = true;
    ptGeo.attributes.color.needsUpdate = true;
    lines.visible = segCount > 0;
    points.visible = ptCount > 0;
  }

  function dispose() {
    scene.remove(lines); scene.remove(points);
    lineGeo.dispose(); lineMat.dispose(); ptGeo.dispose(); ptMat.dispose();
  }

  return { sync, dispose };
}
