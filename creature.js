import * as THREE from 'three';

// ===================== body / leg geometry (origin = body centre) =====================
export const BODY_HEIGHT = 1.0;    // preferred height of body centre above the feet
const HIP_LOCAL_Y = -0.22;  // hips hang below the centre  (centre 1.0 up -> hips 0.78 up)
const UPPER_LEN = 0.50, LOWER_LEN = 0.50;
const SIDE = 0.42, FB = 0.36;
export const FOOT_GROUND = 0.06;
export const FIXED = 1 / 60;

const hipDefs = [
  { hip: new THREE.Vector3(-SIDE, HIP_LOCAL_Y,  FB), rest: new THREE.Vector3(-SIDE * 1.15, 0,  FB), pole:  1 }, // FL
  { hip: new THREE.Vector3( SIDE, HIP_LOCAL_Y,  FB), rest: new THREE.Vector3( SIDE * 1.15, 0,  FB), pole:  1 }, // FR
  { hip: new THREE.Vector3(-SIDE, HIP_LOCAL_Y, -FB), rest: new THREE.Vector3(-SIDE * 1.15, 0, -FB), pole: -1 }, // BL
  { hip: new THREE.Vector3( SIDE, HIP_LOCAL_Y, -FB), rest: new THREE.Vector3( SIDE * 1.15, 0, -FB), pole: -1 }, // BR
];

// ===================== IK + orientation helpers =====================
const _to = new THREE.Vector3(), _dir = new THREE.Vector3(), _perp = new THREE.Vector3(), _knee = new THREE.Vector3();
function solveKnee(hip, target, L1, L2, pole) {
  _to.subVectors(target, hip);
  let d = _to.length();
  d = Math.min(Math.max(d, Math.abs(L1 - L2) + 1e-4), L1 + L2 - 1e-4);
  _dir.copy(_to).normalize();
  let c = (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d); c = Math.min(1, Math.max(-1, c));
  const s = Math.sqrt(1 - c * c);
  _perp.copy(pole).addScaledVector(_dir, -pole.dot(_dir));
  if (_perp.lengthSq() < 1e-6) _perp.set(0, 1, 0).addScaledVector(_dir, -_dir.y);
  _perp.normalize();
  return _knee.copy(hip).addScaledVector(_dir, L1 * c).addScaledVector(_perp, L1 * s);
}
const _upAxis = new THREE.Vector3(0, 1, 0), _mid = new THREE.Vector3(), _seg = new THREE.Vector3();
function placeSegment(mesh, a, b) {
  _mid.addVectors(a, b).multiplyScalar(0.5);
  _seg.subVectors(b, a); const len = _seg.length();
  mesh.position.copy(_mid); mesh.scale.set(1, len / mesh.userData.base, 1);
  mesh.quaternion.setFromUnitVectors(_upAxis, _seg.normalize());
}
const _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3(), _basis = new THREE.Matrix4();
function orientFromUpForward(up, fwd, out) {
  _by.copy(up); _bx.crossVectors(_by, fwd);
  if (_bx.lengthSq() < 1e-6) _bx.set(1, 0, 0);
  _bx.normalize(); _bz.crossVectors(_bx, _by).normalize();
  _basis.makeBasis(_bx, _by, _bz);
  return out.setFromRotationMatrix(_basis);
}
function easeInOut(t) { return t * t * (3 - 2 * t); }

// ===================== support-polygon geometry (XZ) =====================
function convexHull(pts) {
  if (pts.length < 3) return pts.slice();
  const p = pts.slice().sort((a, b) => a.x - b.x || a.z - b.z);
  const cr = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const lo = []; for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  const up = []; for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  lo.pop(); up.pop(); return lo.concat(up);
}
function pointInPoly(px, pz, poly) {
  if (poly.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const c = (b.x - a.x) * (pz - a.z) - (b.z - a.z) * (px - a.x);
    if (Math.abs(c) < 1e-9) continue;
    const s = Math.sign(c);
    if (sign === 0) sign = s; else if (s !== sign) return false;
  }
  return true;
}
function nearestOnPoly(px, pz, poly, out) {
  let bd = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1e-9;
    let t = ((px - a.x) * dx + (pz - a.z) * dz) / L2; t = Math.max(0, Math.min(1, t));
    const qx = a.x + t * dx, qz = a.z + t * dz, d = (qx - px) ** 2 + (qz - pz) ** 2;
    if (d < bd) { bd = d; out.x = qx; out.z = qz; }
  }
  return out;
}

// ===================== steering / physics constants =====================
const DEFAULT_ARENA_R = 12.0;
const SEP_RADIUS = 2.0, MIN_GAP = 1.4;
const BASE_SPEED = 1.2, TURN_SPEED = 2.0, ARRIVE_R = 0.8;
const WANDER_W = 1.0, SEP_W = 2.0, BOUNDARY_GAIN = 4.0;

const GRAV = 10.0;                 // gravity (units/s^2)
const KP = 60, KD = 16;            // body-height PD gains
const HEIGHT_CAP = GRAV * 4;       // max upward support accel (x fraction grounded)
const WALK_GAIN = 6.0;             // how hard the body drives toward walk velocity
const H_DRAG = 1.2;                // horizontal drag
const BOUNCE = 0.25, BODY_MIN_CLEAR = 0.30;

const TRIGGER_H = 0.36, TRIGGER_V = 0.30;   // foot leaves this -> must step
const COMFORT_H = 0.62, COMFORT_V = 0.55;   // foot stretched past this -> body slows
const STEP_DURATION = 0.16, STEP_LIFT = 0.18, LOOKAHEAD = 0.16;
const MAX_CONCURRENT = 1;          // one foot at a time -> always 3 feet supporting
const ORIENT_LERP = 0.08;

function randomTarget(arenaRadius) {
  const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * arenaRadius;
  return new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r);
}

function terrainNormal(terrainHeight, x, z, out) {
  const e = 0.12;
  return out.set(terrainHeight(x - e, z) - terrainHeight(x + e, z), 2 * e,
                 terrainHeight(x, z - e) - terrainHeight(x, z + e)).normalize();
}

// ===================== Creature =====================
const diagonalPartner = [3, 2, 1, 0];
const whiteMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2 });
const _hipWorld = new THREE.Vector3(), _footPos = new THREE.Vector3(), _fwd = new THREE.Vector3(),
      _n = new THREE.Vector3(), _q = new THREE.Quaternion();
const _wander = new THREE.Vector3(), _sep = new THREE.Vector3(), _away = new THREE.Vector3(), _steer = new THREE.Vector3();
const _com = { x: 0, z: 0 }, _near = { x: 0, z: 0 };

export class Creature {
  constructor({ scene, terrainHeight, spawn, yaw, hue, arenaRadius = DEFAULT_ARENA_R }) {
    this._scene = scene;
    this._terrainHeight = terrainHeight;
    this._arenaRadius = arenaRadius;
    this._softEdge = arenaRadius + 1.0;

    const skinC = new THREE.Color().setHSL(hue, 0.50, 0.55);
    const skin   = new THREE.MeshStandardMaterial({ color: skinC, roughness: 0.5, metalness: 0.05 });
    this.limbMat  = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(hue, 0.45, 0.34), roughness: 0.6 });
    this.jointMat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(hue, 0.45, 0.40), roughness: 0.55 });
    this.footMat  = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(hue, 0.40, 0.20), roughness: 0.7 });

    this.group = new THREE.Group();
    this.group.rotation.order = 'YXZ';
    this._scene.add(this.group);

    const torso = new THREE.Mesh(new THREE.IcosahedronGeometry(0.55, 2), skin);
    torso.castShadow = true; this.group.add(torso);
    const collar = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12), this.limbMat);
    collar.position.y = -0.20; collar.scale.set(1, 0.45, 1); this.group.add(collar);

    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 2), skin);
    head.castShadow = true; head.position.set(0, 0.18, 0.55); this.group.add(head);
    for (const sx of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 16),
        new THREE.MeshStandardMaterial({ color: 0x0c0f12, roughness: 0.15, metalness: 0.1 }));
      eye.position.set(sx * 0.13, 0.23, 0.80); this.group.add(eye);
      const hl = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 8), whiteMat);
      hl.position.set(sx * 0.13 + 0.02, 0.255, 0.85); this.group.add(hl);
    }

    this.legs = hipDefs.map(d => {
      const hipBall = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), this.jointMat);
      hipBall.castShadow = true; hipBall.position.copy(d.hip); this.group.add(hipBall);
      const foot = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), this.footMat);
      foot.castShadow = true; foot.scale.set(0.11, FOOT_GROUND, 0.16); this._scene.add(foot);
      return {
        hipLocal: d.hip, rx: d.rest.x, rz: d.rest.z, poleSign: d.pole,
        upper: this._cap(UPPER_LEN, 0.085), lower: this._cap(LOWER_LEN, 0.07),
        knee: this._joint(0.095), foot,
        end: new THREE.Vector3(),          // current foot position (world)
        stepStart: new THREE.Vector3(), stepEnd: new THREE.Vector3(),
        stepping: false, t: 0, uncomfortable: false, wants: false,
      };
    });

    this.pos = spawn.clone();
    this.vel = new THREE.Vector3();
    this.yaw = yaw; this.pitch = 0; this.roll = 0;
    this.roamTarget = randomTarget(this._arenaRadius);
    this.desiredDir = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));

    // plant feet at their rest positions
    for (const leg of this.legs) {
      const wx = this.pos.x + (leg.rx * Math.cos(yaw) + leg.rz * Math.sin(yaw));
      const wz = this.pos.z + (-leg.rx * Math.sin(yaw) + leg.rz * Math.cos(yaw));
      leg.end.set(wx, this._terrainHeight(wx, wz) + FOOT_GROUND, wz);
    }
  }

  setArenaRadius(arenaRadius) {
    this._arenaRadius = arenaRadius;
    this._softEdge = arenaRadius + 1.0;
    if (this.roamTarget.length() > arenaRadius) this.roamTarget = randomTarget(arenaRadius);
  }

  _cap(nom, r) {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, nom - 2 * r, 4, 10), this.limbMat);
    m.castShadow = true; m.userData.base = nom; this._scene.add(m); return m;
  }
  _joint(r) { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), this.jointMat); m.castShadow = true; this._scene.add(m); return m; }

  isGrounded(leg) { return !leg.stepping; }

  computeSteering(all) {
    _wander.set(this.roamTarget.x - this.pos.x, 0, this.roamTarget.z - this.pos.z);
    if (_wander.length() < ARRIVE_R) { this.roamTarget = randomTarget(this._arenaRadius); _wander.set(this.roamTarget.x - this.pos.x, 0, this.roamTarget.z - this.pos.z); }
    if (_wander.lengthSq() > 1e-6) _wander.normalize();
    _sep.set(0, 0, 0);
    for (const o of all) {
      if (o === this) continue;
      _away.set(this.pos.x - o.pos.x, 0, this.pos.z - o.pos.z);
      const d = _away.length();
      if (d > 0 && d < SEP_RADIUS) {
        _away.multiplyScalar(1 / d);
        _sep.addScaledVector(_away, (SEP_RADIUS - d) / SEP_RADIUS);
        if (d < MIN_GAP) _sep.addScaledVector(_away, (MIN_GAP - d) * 2.0);
      }
    }
    _steer.copy(_wander).multiplyScalar(WANDER_W).addScaledVector(_sep, SEP_W);
    const dc = Math.hypot(this.pos.x, this.pos.z);
    if (dc > this._softEdge) _steer.addScaledVector(_away.set(-this.pos.x / dc, 0, -this.pos.z / dc), (dc - this._softEdge) * BOUNDARY_GAIN);
    if (_steer.lengthSq() > 1e-6) this.desiredDir.copy(_steer).normalize();
    else this.desiredDir.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  physicsStep(h) {
    // --- heading (kinematic, rate-limited) ---
    const desiredYaw = Math.atan2(this.desiredDir.x, this.desiredDir.z);
    let diff = Math.atan2(Math.sin(desiredYaw - this.yaw), Math.cos(desiredYaw - this.yaw));
    this.yaw += Math.max(-TURN_SPEED * h, Math.min(TURN_SPEED * h, diff));
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);

    // --- legs: rest targets, comfort, trigger, advance ongoing steps ---
    let anyUncomfortable = false;
    for (const leg of this.legs) {
      const wx = this.pos.x + (leg.rx * cy + leg.rz * sy);
      const wz = this.pos.z + (-leg.rx * sy + leg.rz * cy);
      const ry = this._terrainHeight(wx, wz) + FOOT_GROUND;
      leg.restX = wx; leg.restY = ry; leg.restZ = wz;
      const dh = Math.hypot(leg.end.x - wx, leg.end.z - wz), dv = Math.abs(leg.end.y - ry);
      leg.uncomfortable = dh > COMFORT_H || dv > COMFORT_V;
      if (leg.uncomfortable) anyUncomfortable = true;
      if (leg.stepping) {
        leg.t += h / STEP_DURATION;
        const tc = Math.min(leg.t, 1), e = easeInOut(tc);
        leg.end.lerpVectors(leg.stepStart, leg.stepEnd, e);
        leg.end.y += Math.sin(Math.PI * tc) * STEP_LIFT;
        if (leg.t >= 1) { leg.stepping = false; leg.end.copy(leg.stepEnd); }
        leg.wants = false;
      } else {
        leg.wants = dh > TRIGGER_H || dv > TRIGGER_V;
      }
    }
    // --- start at most one new step (most-displaced, partner grounded) ---
    if (this.legs.filter(l => l.stepping).length < MAX_CONCURRENT) {
      let pick = null, best = 0;
      for (let i = 0; i < this.legs.length; i++) {
        const leg = this.legs[i];
        if (!leg.wants || leg.stepping) continue;
        if (this.legs[diagonalPartner[i]].stepping) continue;
        const dh = Math.hypot(leg.end.x - leg.restX, leg.end.z - leg.restZ);
        if (dh > best) { best = dh; pick = leg; }
      }
      if (pick) {
        pick.stepping = true; pick.t = 0;
        pick.stepStart.copy(pick.end);
        const ex = pick.restX + this.vel.x * LOOKAHEAD, ez = pick.restZ + this.vel.z * LOOKAHEAD;
        pick.stepEnd.set(ex, this._terrainHeight(ex, ez) + FOOT_GROUND, ez);
      }
    }

    // --- centre of mass + support polygon (grounded feet) ---
    let cx = 0, cy2 = 0, cz = 0;
    for (const leg of this.legs) { cx += leg.end.x; cy2 += leg.end.y; cz += leg.end.z; }
    cx /= 4; cy2 /= 4; cz /= 4;
    _com.x = (cx + this.pos.x) * 0.5; _com.z = (cz + this.pos.z) * 0.5;
    const comY = (cy2 + this.pos.y) * 0.5 + 0.01;

    const grounded = this.legs.filter(l => this.isGrounded(l));
    const fG = grounded.length / 4;
    let nx = 0, ny = 1, nz = 0, haveNormal = grounded.length > 0;
    if (grounded.length === 1) {
      const g = grounded[0].end;
      nx = _com.x - g.x; ny = comY - g.y; nz = _com.z - g.z;
    } else if (grounded.length >= 2) {
      const poly = convexHull(grounded.map(l => ({ x: l.end.x, z: l.end.z })));
      const polyY = grounded.reduce((s, l) => s + l.end.y, 0) / grounded.length;
      if (pointInPoly(_com.x, _com.z, poly)) { nx = 0; ny = 1; nz = 0; }
      else { nearestOnPoly(_com.x, _com.z, poly, _near); nx = _com.x - _near.x; ny = comY - polyY; nz = _com.z - _near.z; }
    }
    if (haveNormal) { const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L; }

    // --- dynamics ---
    this.vel.y -= GRAV * h;
    if (haveNormal) {
      const preferredY = cy2 + BODY_HEIGHT;
      let mag = GRAV + KP * (preferredY - this.pos.y) - KD * this.vel.y;
      mag = Math.max(0, Math.min(HEIGHT_CAP * fG, mag));
      let ax = nx * mag, ay = ny * mag, az = nz * mag;
      if (Math.hypot(ax, az) > ay) { ax = 0; ay = 0; az = 0; }   // can't recover -> let it topple
      this.vel.x += ax * h; this.vel.y += ay * h; this.vel.z += az * h;
    }
    // walk drive (authority scales with how many feet are down)
    const speed = BASE_SPEED * (0.35 + 0.65 * Math.max(0, Math.cos(diff))) * (anyUncomfortable ? 0.2 : 1);
    this.vel.x += (sy * speed - this.vel.x) * WALK_GAIN * fG * h;
    this.vel.z += (cy * speed - this.vel.z) * WALK_GAIN * fG * h;
    this.vel.x *= (1 - H_DRAG * h); this.vel.z *= (1 - H_DRAG * h);

    this.pos.addScaledVector(this.vel, h);

    // body floor (don't sink through terrain)
    const floorY = this._terrainHeight(this.pos.x, this.pos.z) + BODY_MIN_CLEAR;
    if (this.pos.y < floorY) { this.pos.y = floorY; if (this.vel.y < 0) this.vel.y *= -BOUNCE; }

    // --- orientation from feet (pitch/roll), smoothed ---
    const f = this.legs, fr = f[0].end, frr = f[1].end, bl = f[2].end, br = f[3].end;
    const fvY = (fr.y + frr.y) - (bl.y + br.y);
    const fvH = Math.hypot((fr.x + frr.x) - (bl.x + br.x), (fr.z + frr.z) - (bl.z + br.z)) || 1e-3;
    const svY = (frr.y + br.y) - (fr.y + bl.y);
    const svH = Math.hypot((frr.x + br.x) - (fr.x + bl.x), (frr.z + br.z) - (fr.z + bl.z)) || 1e-3;
    const pitchT = -Math.atan2(fvY, fvH), rollT = Math.atan2(svY, svH);
    this.pitch += (pitchT - this.pitch) * ORIENT_LERP;
    this.roll  += (rollT  - this.roll)  * ORIENT_LERP;
  }

  render() {
    this.group.position.copy(this.pos);
    this.group.rotation.set(this.pitch, this.yaw, this.roll);
    this.group.updateMatrixWorld(true);
    _fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    for (const leg of this.legs) {
      _hipWorld.copy(this.group.localToWorld(leg.hipLocal.clone()));
      _footPos.copy(leg.end);
      const knee = solveKnee(_hipWorld, _footPos, UPPER_LEN, LOWER_LEN, _fwd.clone().multiplyScalar(leg.poleSign));
      placeSegment(leg.upper, _hipWorld, knee);
      placeSegment(leg.lower, knee, _footPos);
      leg.knee.position.copy(knee);
      leg.foot.position.copy(_footPos);
      terrainNormal(this._terrainHeight, _footPos.x, _footPos.z, _n);
      orientFromUpForward(_n, _fwd, _q);
      leg.foot.quaternion.copy(_q);
    }
  }
}

// Usage:
//   const creature = new Creature({
//     scene,
//     terrainHeight: (x, z) => terrainSystem.getHeight(x, z),
//     spawn,
//     yaw,
//     hue,
//   });
//   creature.computeSteering(allCreatures);
//   creature.physicsStep(FIXED);
//   creature.render();
