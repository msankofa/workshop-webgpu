// RELAY_URL: override with ?relay=wss://... for production
const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
export const RELAY_URL = params.get('relay') || 'wss://workshop-webgpu.onrender.com';

// ---------------------------------------------------------------------------
// InterpolationBuffer â€” ring of 3 snapshots, sample at arbitrary time
// ---------------------------------------------------------------------------

export class InterpolationBuffer {
  constructor() { this._snaps = []; }

  /** @param {object} state @param {number} [t] timestamp ms (default: performance.now()) */
  push(state, t = performance.now()) {
    this._snaps.push({ t, state });
    if (this._snaps.length > 3) this._snaps.shift();
  }

  /** @param {number} renderTime ms â€” returns interpolated state or null */
  sample(renderTime) {
    const s = this._snaps;
    if (s.length === 0) return null;
    if (s.length === 1) return s[0].state;
    // clamp below first
    if (renderTime <= s[0].t) return s[0].state;
    // clamp above last
    if (renderTime >= s[s.length - 1].t) return s[s.length - 1].state;
    for (let i = 1; i < s.length; i++) {
      if (renderTime <= s[i].t) {
        const alpha = (renderTime - s[i-1].t) / (s[i].t - s[i-1].t);
        return _lerpState(s[i-1].state, s[i].state, alpha);
      }
    }
    return s[s.length - 1].state;
  }
}

function _lerpV3(a, b, t) {
  return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];
}

function _slerpQ(a, b, t) {
  let dot = a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3];
  dot = Math.max(-1, Math.min(1, dot));
  if (dot < 0) { b = [-b[0],-b[1],-b[2],-b[3]]; dot = -dot; }
  if (dot > 0.9995) return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t, a[3]+(b[3]-a[3])*t];
  const th = Math.acos(dot);
  const sth = Math.sin(th);
  const wa = Math.sin((1-t)*th)/sth, wb = Math.sin(t*th)/sth;
  return [a[0]*wa+b[0]*wb, a[1]*wa+b[1]*wb, a[2]*wa+b[2]*wb, a[3]*wa+b[3]*wb];
}

// ---------------------------------------------------------------------------
// createHostSession â€” connects as host, broadcasts state at 20 Hz,
//                     dispatches 'mp:guest_input' events for guest inputs
// ---------------------------------------------------------------------------

const BROADCAST_MS = 50; // 20 Hz

// ---------------------------------------------------------------------------
// Host broadcast backpressure guard
//
// `ws.send()` never blocks: bytes the relay hasn't drained pile up in the
// socket's outbound buffer (`ws.bufferedAmount`). The host emits a full
// O(creatures) snapshot every 50 ms, so on a saturated uplink the buffer grows
// without bound and â€” because every hostâ†’guest world event (avatar, lights,
// roster) rides this one ordered socket inside `sim_state` â€” head-of-line-blocks
// all of them together, freezing guests while guestâ†’host input stays fine.
//
// Fix: skip a tick when the buffer is already backed up. We SKIP (coalesce to
// the next fresh `getState()`), never terminate â€” this socket is the host's only
// relay link and reconnect/backoff already exists. The cap is a small multiple of
// one worst-case frame, so a healthy link (buffer â‰ˆ 0 each tick) never trips it;
// a saturated link degrades to a lower snapshot rate with bounded latency instead
// of an unbounded queue. See multiplayer-jam-analysis/plan.md.
// ---------------------------------------------------------------------------
export const HOST_MAX_BUFFERED_BYTES = 128 * 1024; // â‰ˆ 1â€“2 worst-case frames

/** True when the socket's unflushed buffer is small enough to enqueue another frame. */
export function shouldSendSnapshot(bufferedAmount, limit = HOST_MAX_BUFFERED_BYTES) {
  return bufferedAmount <= limit;
}

// One broadcast tick. Exported + side-effect-injected so the skip-BEFORE-getState
// ordering is unit-testable without a browser socket. The skip must precede
// getState() because getState() has send-marking side effects (it drains the
// entity-registry removal tombstones and stamps the shared settings/config packets
// as sent), so a built-but-unsent frame would silently lose data. Returns true if a
// frame was sent, false if skipped. `1` is WebSocket.OPEN (avoids a global dep in Node).
export function hostBroadcastTick(ws, getState, sendFrame, onSkip) {
  if (!ws || ws.readyState !== 1) return false;
  if (!shouldSendSnapshot(ws.bufferedAmount)) { onSkip?.(); return false; }
  sendFrame(getState());
  return true;
}

/**
 * @param {string} roomCode
 * @param {() => object} getState  â€” callback returning { creatures, players }
 * @returns {{ destroy(): void }}
 */
export function createHostSession(roomCode, mapKey, getState, options = {}) {
  let ws = null;
  let intervalId = null;
  let reconnectDelay = 1000;
  let seq = 0;
  let skippedTicks = 0;
  let lastBackpressureReport = 0;
  let lastSizeLog = 0;

  // Opt-in wire-size probe (?netstats): throttled to once / 2 s so it can size real
  // frames at real creature counts without spamming the console. Reuses the payload
  // string already built for the send â€” no extra stringify.
  const NET_STATS = params.has('netstats');
  function logSnapshotSize(payload, state) {
    if (!NET_STATS) return;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - lastSizeLog < 2000) return;
    lastSizeLog = now;
    const kb = o => o == null ? 0 : Math.round(JSON.stringify(o).length / 1024);
    console.log(
      `[mp] sim_state ${Math.round(payload.length / 1024)} KB | ` +
      `creatures(${state.creatures?.length ?? 0}) ${kb(state.creatures)} | ` +
      `players ${kb(state.players)} | entities ${kb(state.entities)} | ` +
      `buffered ${Math.round((ws?.bufferedAmount ?? 0) / 1024)} KB`,
    );
  }

  // Throttled (â‰¤ once / 2 s) signal that the uplink is saturated and frames are
  // being dropped, so the perf HUD / console can show it instead of silent freezing.
  function reportBackpressure() {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    if (now - lastBackpressureReport < 2000) return;
    lastBackpressureReport = now;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('mp:backpressure', {
        detail: { skippedTicks, bufferedAmount: ws?.bufferedAmount ?? 0 },
      }));
    }
  }

  function connect() {
    ws = new WebSocket(RELAY_URL);
    ws.onopen = () => {
      reconnectDelay = 1000;
      ws.send(JSON.stringify({ type: 'host', room: roomCode, mapKey: mapKey ?? null, worldMode: options.worldMode || 'shared' }));
      intervalId = setInterval(() => {
        hostBroadcastTick(
          ws,
          getState,
          state => {
            const payload = JSON.stringify({ type: 'sim_state', seq: seq++, ...state });
            logSnapshotSize(payload, state);
            ws.send(payload);
          },
          () => { skippedTicks++; reportBackpressure(); },
        );
      }, BROADCAST_MS);
      window.dispatchEvent(new CustomEvent('mp:connected', { detail: { role: 'host', room: roomCode } }));
    };
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      window.dispatchEvent(new CustomEvent('mp:guest_input', { detail: msg }));
    };
    ws.onclose = () => {
      clearInterval(intervalId);
      intervalId = null;
      setTimeout(connect, Math.min(reconnectDelay, 30000));
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    };
  }

  connect();
  return {
    broadcast(msg) {
      if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(msg)); return true; }
      return false;
    },
    destroy() { clearInterval(intervalId); ws?.close(); },
  };
}

// ---------------------------------------------------------------------------
// createGuestSession â€” connects as guest, feeds InterpolationBuffer,
//                      drives onState(interpolatedState) via rAF
// ---------------------------------------------------------------------------

/**
 * @param {string} roomCode
 * @param {(state: object) => void} onState â€” called each rAF with interpolated state
 * @returns {{ sendInput(msg: object): void, destroy(): void }}
 */
export function createGuestSession(roomCode, onState) {
  let ws = null;
  let reconnectDelay = 1000;
  let rafId = null;
  const buffer = new InterpolationBuffer();

  function connect() {
    ws = new WebSocket(RELAY_URL);
    ws.onopen = () => {
      reconnectDelay = 1000;
      ws.send(JSON.stringify({ type: 'join', room: roomCode }));
    };
    ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'sim_state') {
        buffer.push(msg, performance.now());
      } else {
        window.dispatchEvent(new CustomEvent('mp:' + msg.type, { detail: msg }));
      }
    };
    ws.onclose = () => {
      setTimeout(connect, Math.min(reconnectDelay, 30000));
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    };
  }

  function tick() {
    const state = buffer.sample(performance.now() - 100);
    if (state) onState(state);
    rafId = requestAnimationFrame(tick);
  }

  connect();
  rafId = requestAnimationFrame(tick);

  return {
    sendInput(msg) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    destroy() {
      cancelAnimationFrame(rafId);
      ws?.close();
    },
  };
}

// ---------------------------------------------------------------------------
// helpers (used by InterpolationBuffer._lerpState)
// ---------------------------------------------------------------------------

// Entity interpolation (replaces the old light-only _lerpLights). Matches
// upserts by id; a b-upsert with no a-predecessor by its own id but carrying
// `spawnedFrom` (a projectile that just impacted and became a light) borrows
// the projectile's last-known record as its lerp predecessor so the landing
// doesn't pop â€” see entity-types/projectile.js / light.js header notes.
// `removes` pass through from b as-is (no interpolation of tombstones).
function _lerpEntities(a, b, alpha) {
  const aUpserts = a?.upserts ?? [];
  const bUpserts = b?.upserts ?? [];
  const prev = new Map(aUpserts.map(e => [e.id, e]));
  const upserts = bUpserts.map(eb => {
    let ea = prev.get(eb.id);
    if (!ea && eb.spawnedFrom) ea = prev.get(eb.spawnedFrom);
    if (!ea) return eb;
    return {
      ...eb,
      p: Array.isArray(ea.p) && Array.isArray(eb.p) ? _lerpV3(ea.p, eb.p, alpha) : eb.p,
      radius: ea.radius != null && eb.radius != null ? ea.radius + (eb.radius - ea.radius) * alpha : eb.radius,
      intensity: ea.intensity != null && eb.intensity != null ? ea.intensity + (eb.intensity - ea.intensity) * alpha : eb.intensity,
      lifespan: ea.lifespan != null && eb.lifespan != null ? ea.lifespan + (eb.lifespan - ea.lifespan) * alpha : eb.lifespan,
    };
  });
  return { full: b?.full ?? true, since: b?.since ?? 0, version: b?.version ?? 0, upserts, removes: b?.removes ?? [] };
}

function _lerpPlayers(aPlayers = [], bPlayers = [], alpha) {
  const ids = new Set([...aPlayers, ...bPlayers].map(p => p.id));
  return [...ids].map(id => {
    const pa = aPlayers.find(p => p.id === id);
    const pb = bPlayers.find(p => p.id === id);
    if (!pa) return pb;
    if (!pb) return pa;
    return {
      ...pb,
      p: _lerpV3(pa.p, pb.p, alpha),
      q: _slerpQ(pa.q, pb.q, alpha),
      h: pa.h != null && pb.h != null ? pa.h + (pb.h - pa.h) * alpha : pb.h,
      r: pa.r != null && pb.r != null ? pa.r + (pb.r - pa.r) * alpha : pb.r,
      hp: pa.hp != null && pb.hp != null ? pa.hp + (pb.hp - pa.hp) * alpha : pb.hp,
      maxHp: pb.maxHp ?? pa.maxHp,
      alive: pb.alive ?? pa.alive,
      weapon: pb.weapon ?? pa.weapon,
      tool: pb.tool ?? pa.tool,
      ammoMag: pb.ammoMag ?? pa.ammoMag,
      ammoReserve: pb.ammoReserve ?? pa.ammoReserve,
      magazineSize: pb.magazineSize ?? pa.magazineSize,
      reloading: pb.reloading ?? false,
      firing: pb.firing ?? false,
      fireSeq: pb.fireSeq ?? pa.fireSeq,
      lastShotAt: pb.lastShotAt ?? pa.lastShotAt,
      aimPitch: pb.aimPitch ?? pa.aimPitch,
    };
  }).filter(Boolean);
}
// ClaudeCraft mob interpolation. Matches mobs by id (like players), lerps position +
// hp, slerps the pure-yaw quaternion, and carries tid/dead from the newer snapshot.
// Unmatched ids pass through from whichever snapshot has them (union), mirroring the
// player lerp so a mob mid-despawn doesn't pop before GhostRenderer removes it.
function _lerpMobs(aMobs = [], bMobs = [], alpha) {
  const aById = new Map(aMobs.map((m) => [m.id, m]));
  const bById = new Map(bMobs.map((m) => [m.id, m]));
  const ids = new Set([...aById.keys(), ...bById.keys()]);
  return [...ids].map((id) => {
    const ma = aById.get(id);
    const mb = bById.get(id);
    if (!ma) return mb;
    if (!mb) return ma;
    return {
      ...mb,
      p: _lerpV3(ma.p, mb.p, alpha),
      q: _slerpQ(ma.q, mb.q, alpha),
      hp: ma.hp != null && mb.hp != null ? ma.hp + (mb.hp - ma.hp) * alpha : mb.hp,
      tid: mb.tid ?? ma.tid,
      dead: mb.dead ?? ma.dead,
    };
  }).filter(Boolean);
}
function _lerpState(a, b, alpha) {
  const aCreatures = a.creatures ?? [];
  const bCreatures = b.creatures ?? [];
  return {
    creatures: aCreatures.map((ca, i) => {
      const cb = bCreatures[i];
      if (!cb) return ca;
      return {
        id: ca.id,
        p: _lerpV3(ca.p, cb.p, alpha),
        q: _slerpQ(ca.q, cb.q, alpha),
        hp: ca.hp + (cb.hp - ca.hp) * alpha,
        ypr: ca.ypr && cb.ypr ? ca.ypr.map((v, j) => v + (cb.ypr[j] - v) * alpha) : ca.ypr,
        feet:  ca.feet.map((f, j) => cb.feet[j]  ? _lerpV3(f, cb.feet[j],  alpha) : f),
        hands: ca.hands.map((h, j) => cb.hands[j] ? _lerpV3(h, cb.hands[j], alpha) : h),
      };
    }),
    entities: _lerpEntities(a.entities, b.entities, alpha),
    worldMode: b.worldMode ?? a.worldMode,
    players: _lerpPlayers(a.players, b.players, alpha),
    mobs: _lerpMobs(a.mobs, b.mobs, alpha),
  };
}

// ---------------------------------------------------------------------------
// GhostRenderer â€” lightweight ghost meshes for creatures and remote players
//   Accepts THREE as a constructor param to avoid a static import
//   (keeps this module usable in Node.js tests that don't have three).
//   Creature ghosts: a semi-transparent box at body position
//   Player ghosts:   a solid capsule (a Group holding the body + two eyes) so
//                    you can tell where a remote player is facing. The player's
//                    quaternion is pure yaw, so local -Z is their forward; the
//                    eyes sit on that face and blink on independent timers.
// ---------------------------------------------------------------------------

const BLINK_MS = 120;                      // duration of one blink (down then up)
const BLINK_MIN_MS = 3000, BLINK_MAX_MS = 6000; // idle gap between blinks

// Floating orb hands: idle bob + a fore/aft walk-sway scaled by horizontal speed.
const ORB_R = 0.12;                        // orb radius at the default 0.3 capsule radius
const HAND_BOB_HZ = 1.1, HAND_BOB_AMP = 0.02;
const HAND_SWAY_HZ = 2.2, HAND_SWAY_MAX = 0.12, HAND_SWAY_PER_SPEED = 0.06;
const HELD_FLASH_MS = 140;

// Deterministic light-pastel tint for a player id, shared by the remote ghost body/
// orbs and the local first-person viewmodel so your hands match your own ghost.
export function playerTintHSL(id) {
  return [(_hashId(id) % 360) / 360, 0.45, 0.72];
}

export class GhostRenderer {
  constructor(scene, THREE) {
    this._scene    = scene;
    this._THREE    = THREE;
    this._creatures = new Map(); // id(number) â†’ Mesh
    this._players   = new Map(); // clientId(string) â†’ Group (container)
    this._mobs      = new Map(); // ClaudeCraft mob id(number) â†’ Mesh (guest render path)
    this._mGeo = new THREE.BoxGeometry(0.8, 1.6, 0.8);
    this._mMat = new THREE.MeshStandardMaterial({ color: 0xcc6644 });
    this._cGeo = new THREE.BoxGeometry(0.7, 0.5, 1.0);
    this._pGeo = new THREE.CapsuleGeometry(0.3, 1.2, 4, 8);
    this._eyeGeo = new THREE.SphereGeometry(1, 8, 8);
    this._heldBodyGeo = new THREE.BoxGeometry(1, 1, 1);
    this._heldBarrelGeo = new THREE.BoxGeometry(1, 1, 1);
    this._cMat = new THREE.MeshStandardMaterial({ color: 0x88ccff, transparent: true, opacity: 0.5 });
    this._pMat = new THREE.MeshStandardMaterial({ color: 0xf0ece2, roughness: 0.7 });
    this._eyeMat = new THREE.MeshBasicMaterial({ color: 0x111111 }); // unlit flat black
    this._glintMat = new THREE.MeshBasicMaterial({ color: 0xffffff }); // eye highlight
    this._heldMat = new THREE.MeshStandardMaterial({ color: 0x2f3540, roughness: 0.58, metalness: 0.15 });
    this._heldMuzzleMat = new THREE.MeshBasicMaterial({ color: 0xffd66b });
    this._lightToolMat = new THREE.MeshBasicMaterial({ color: 0xffb84a });
  }

  update(state) {
    this._updateSet(state.creatures ?? [], this._creatures, this._cGeo, this._cMat,
      c => c.id, c => c.p, c => c.q);
    // ClaudeCraft mobs: guest render path (host renders GLB visuals directly). Same
    // interpolated wire shape { id, tid, p, q, hp, dead } as the host publishes.
    this._updateSet(state.mobs ?? [], this._mobs, this._mGeo, this._mMat,
      m => m.id, m => m.p, m => m.q);
    this._updatePlayers(state.players ?? []);
  }

  _updateSet(items, map, geo, mat, getId, getP, getQ) {
    const THREE = this._THREE;
    const seen = new Set();
    for (const item of items) {
      const id = getId(item);
      seen.add(id);
      let mesh = map.get(id);
      if (!mesh) {
        mesh = new THREE.Mesh(geo, mat);
        this._scene.add(mesh);
        map.set(id, mesh);
      }
      const [px, py, pz] = getP(item);
      mesh.position.set(px, py, pz);
      const [qx, qy, qz, qw] = getQ(item);
      mesh.quaternion.set(qx, qy, qz, qw);
      if (item.h != null || item.r != null) {
        const r = item.r ?? 0.3;
        const h = item.h ?? 1.2;
        mesh.scale.set(r / 0.3, (h + r * 2) / 1.8, r / 0.3);
      } else {
        mesh.scale.set(1, 1, 1);
      }
    }
    for (const [id, mesh] of map) {
      if (!seen.has(id)) { this._scene.remove(mesh); map.delete(id); }
    }
  }

  // Player ghosts are containers (Group) so the eyes stay round while the body
  // keeps its non-uniform h/r scale. The container carries position + orientation.
  _updatePlayers(items) {
    const seen = new Set();
    for (const item of items) {
      const id = item.id;
      seen.add(id);
      let g = this._players.get(id);
      if (!g) { g = this._makePlayer(id); this._scene.add(g); this._players.set(id, g); }
      const [px, py, pz] = item.p;
      g.position.set(px, py, pz);
      const [qx, qy, qz, qw] = item.q;
      g.quaternion.set(qx, qy, qz, qw);
      const r = item.r ?? 0.3;
      const h = item.h ?? 1.2;
      g.userData.body.scale.set(r / 0.3, (h + r * 2) / 1.8, r / 0.3);
      this._placeEyes(g, r, h);
      this._placeHands(g, r, h);
      this._placeHeldItem(g, r, h, item);
    }
    for (const [id, g] of this._players) {
      if (!seen.has(id)) { this._scene.remove(g); g.userData.bodyMat.dispose(); this._players.delete(id); }
    }
  }

  _makePlayer(id) {
    const THREE = this._THREE;
    const g = new THREE.Group();
    // Per-player body tint: a light pastel keyed by the id hash so players are
    // easy to tell apart while staying bright enough for the black eyes to read.
    const bodyMat = this._pMat.clone();
    const [th, ts, tl] = playerTintHSL(id);
    bodyMat.color.setHSL(th, ts, tl);
    const body = new THREE.Mesh(this._pGeo, bodyMat);
    const left = new THREE.Mesh(this._eyeGeo, this._eyeMat);
    const right = new THREE.Mesh(this._eyeGeo, this._eyeMat);
    g.add(body); g.add(left); g.add(right);
    // Two floating orb hands, tinted to match the body (same per-player material),
    // animated in tick(). Reuse the shared unit sphere geometry.
    const leftHand = new THREE.Mesh(this._eyeGeo, bodyMat);
    const rightHand = new THREE.Mesh(this._eyeGeo, bodyMat);
    g.add(leftHand); g.add(rightHand);
    const held = new THREE.Group();
    const heldBody = new THREE.Mesh(this._heldBodyGeo, this._heldMat);
    const heldBarrel = new THREE.Mesh(this._heldBarrelGeo, this._heldMat);
    const heldMuzzle = new THREE.Mesh(this._eyeGeo, this._heldMuzzleMat);
    const heldLight = new THREE.Mesh(this._eyeGeo, this._lightToolMat);
    held.add(heldBody); held.add(heldBarrel); held.add(heldMuzzle); held.add(heldLight);
    g.add(held);
    // White highlight glint, parented to each eye (in eye-local space) so it sits
    // just in front of the black, near the top, and closes with the eye on blink.
    const lg = new THREE.Mesh(this._eyeGeo, this._glintMat);
    const rg = new THREE.Mesh(this._eyeGeo, this._glintMat);
    left.add(lg); right.add(rg);
    lg.scale.set(0.4, 0.4, 0.4); rg.scale.set(0.4, 0.4, 0.4);
    lg.position.set(0.25, 0.42, -1.05);   // toward top; -z is the front face
    rg.position.set(-0.25, 0.42, -1.05);
    // nextBlinkAt is initialised lazily on the first tick (we don't know the
    // clock here); the id hash staggers players so they don't blink in unison.
    g.userData = {
      id, body, bodyMat, left, right, leftHand, rightHand,
      held, heldBody, heldBarrel, heldMuzzle, heldLight,
      eyeH: 0.14, nextBlinkAt: null, blinkStart: -1,
      handPhase: (_hashId(id) % 628) / 100, // 0..~2Ï€ so hands don't bob in unison
      handX: 0.33, handY: 0.18, handZ: -0.47, // base offsets, set by _placeHands
      heldFlashUntil: 0,
      lastX: 0, lastZ: 0, lastNow: null,      // for speed-based sway
    };
    return g;
  }

  // Eyes sit on the front (-Z) face, upper-middle, sized/spread with the capsule.
  _placeEyes(g, r, h) {
    const s = r / 0.3;
    const ex = 0.13 * s, ey = h * 0.42, ez = -(r + 0.02);
    const ew = 0.09 * s, eh = 0.14 * s, ed = 0.06 * s;
    const { left, right } = g.userData;
    left.position.set(-ex, ey, ez);
    right.position.set(ex, ey, ez);
    left.scale.set(ew, eh, ed);
    right.scale.set(ew, eh, ed);
    g.userData.eyeH = eh; // open height; tick() squashes scale.y during a blink
  }

  // Orb hands float to the sides in front of the body. Base offsets live in
  // userData; tick() adds bob + sway. Positions set here too so a just-spawned
  // player looks right before the first tick.
  _placeHands(g, r, h) {
    const s = r / 0.3;
    const orbR = ORB_R * s;
    const ud = g.userData;
    ud.handX = r * 1.1;
    ud.handY = h * 0.15;
    ud.handZ = -(r + orbR + 0.05);
    ud.leftHand.scale.set(orbR, orbR, orbR);
    ud.rightHand.scale.set(orbR, orbR, orbR);
    ud.leftHand.position.set(-ud.handX, ud.handY, ud.handZ);
    ud.rightHand.position.set(ud.handX, ud.handY, ud.handZ);
  }

  _placeHeldItem(g, r, h, item) {
    const ud = g.userData;
    const tool = item.tool || item.weapon || 'm1911';
    const isLight = tool === 'light';
    const isWeapon = !isLight && !!item.weapon;
    ud.held.visible = isLight || isWeapon;
    ud.heldBody.visible = isWeapon;
    ud.heldBarrel.visible = isWeapon;
    ud.heldLight.visible = isLight;
    ud.heldMuzzle.visible = isWeapon && !!item.firing;
    if (!ud.held.visible) return;

    const longGun = item.weapon === 'm24';
    const s = r / 0.3;
    ud.held.position.set(0, h * 0.12, -(r + 0.22 * s));
    ud.heldBody.position.set(0, 0, 0);
    ud.heldBody.scale.set((longGun ? 0.52 : 0.28) * s, 0.08 * s, 0.1 * s);
    ud.heldBarrel.position.set(0, 0, -(longGun ? 0.36 : 0.22) * s);
    ud.heldBarrel.scale.set(0.05 * s, 0.045 * s, (longGun ? 0.5 : 0.26) * s);
    ud.heldMuzzle.position.set(0, 0, -(longGun ? 0.64 : 0.38) * s);
    ud.heldMuzzle.scale.set(0.055 * s, 0.055 * s, 0.055 * s);
    ud.heldLight.position.set(0, 0, -0.08 * s);
    ud.heldLight.scale.set(0.11 * s, 0.11 * s, 0.11 * s);
    if (item.firing) ud.heldFlashUntil = (typeof performance !== 'undefined' ? performance.now() : 0) + HELD_FLASH_MS;
  }

  // Per-frame blink driver â€” update() only runs on network events, so blink has
  // to be driven separately. Squashes eye scale.y 1 -> ~0.1 -> 1 over BLINK_MS.
  tick(nowMs) {
    const now = nowMs ?? 0;
    for (const g of this._players.values()) {
      const ud = g.userData;
      if (ud.nextBlinkAt == null) ud.nextBlinkAt = now + (_hashId(ud.id) % BLINK_MIN_MS);
      let f = 1;
      if (ud.blinkStart >= 0) {
        const t = now - ud.blinkStart;
        if (t >= BLINK_MS) {
          ud.blinkStart = -1;
          ud.nextBlinkAt = now + BLINK_MIN_MS + Math.random() * (BLINK_MAX_MS - BLINK_MIN_MS);
        } else {
          const half = BLINK_MS / 2;
          f = t < half ? 1 - (t / half) * 0.9 : 0.1 + ((t - half) / half) * 0.9;
        }
      } else if (now >= ud.nextBlinkAt) {
        ud.blinkStart = now;
        f = 1;
      }
      const y = ud.eyeH * f;
      ud.left.scale.y = y;
      ud.right.scale.y = y;

      // Orb hands: horizontal speed from container position delta drives the sway.
      let speed = 0;
      if (ud.lastNow != null) {
        const dtS = Math.max(1e-3, (now - ud.lastNow) / 1000);
        speed = Math.hypot(g.position.x - ud.lastX, g.position.z - ud.lastZ) / dtS;
      }
      ud.lastX = g.position.x; ud.lastZ = g.position.z; ud.lastNow = now;
      const t = now / 1000;
      const bob = Math.sin(2 * Math.PI * HAND_BOB_HZ * t + ud.handPhase) * HAND_BOB_AMP;
      const swayAmp = Math.min(HAND_SWAY_MAX, speed * HAND_SWAY_PER_SPEED);
      const sway = Math.sin(2 * Math.PI * HAND_SWAY_HZ * t + ud.handPhase) * swayAmp;
      ud.leftHand.position.set(-ud.handX, ud.handY + bob, ud.handZ + sway);
      ud.rightHand.position.set(ud.handX, ud.handY - bob, ud.handZ - sway);
      if (ud.heldMuzzle) ud.heldMuzzle.visible = now < ud.heldFlashUntil;
    }
  }

  destroy() {
    for (const m of this._creatures.values()) this._scene.remove(m);
    for (const g of this._players.values())   { this._scene.remove(g); g.userData.bodyMat.dispose(); }
    this._creatures.clear();
    this._players.clear();
    this._cGeo.dispose();
    this._pGeo.dispose();
    this._eyeGeo.dispose();
    this._heldBodyGeo.dispose();
    this._heldBarrelGeo.dispose();
    this._cMat.dispose();
    this._pMat.dispose();
    this._eyeMat.dispose();
    this._glintMat.dispose();
    this._heldMat.dispose();
    this._heldMuzzleMat.dispose();
    this._lightToolMat.dispose();
  }
}

// Small deterministic string hash for staggering per-player blink timers.
function _hashId(id) {
  const s = String(id);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
}
