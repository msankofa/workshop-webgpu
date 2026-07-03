// RELAY_URL: override with ?relay=wss://... for production
const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
export const RELAY_URL = params.get('relay') || 'wss://workshop-webgpu.onrender.com';

// ---------------------------------------------------------------------------
// InterpolationBuffer — ring of 3 snapshots, sample at arbitrary time
// ---------------------------------------------------------------------------

export class InterpolationBuffer {
  constructor() { this._snaps = []; }

  /** @param {object} state @param {number} [t] timestamp ms (default: performance.now()) */
  push(state, t = performance.now()) {
    this._snaps.push({ t, state });
    if (this._snaps.length > 3) this._snaps.shift();
  }

  /** @param {number} renderTime ms — returns interpolated state or null */
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
// createHostSession — connects as host, broadcasts state at 20 Hz,
//                     dispatches 'mp:guest_input' events for guest inputs
// ---------------------------------------------------------------------------

const BROADCAST_MS = 50; // 20 Hz

/**
 * @param {string} roomCode
 * @param {() => object} getState  — callback returning { creatures, players }
 * @returns {{ destroy(): void }}
 */
export function createHostSession(roomCode, mapKey, getState, options = {}) {
  let ws = null;
  let intervalId = null;
  let reconnectDelay = 1000;
  let seq = 0;

  function connect() {
    ws = new WebSocket(RELAY_URL);
    ws.onopen = () => {
      reconnectDelay = 1000;
      ws.send(JSON.stringify({ type: 'host', room: roomCode, mapKey: mapKey ?? null, worldMode: options.worldMode || 'shared' }));
      intervalId = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const state = getState();
        ws.send(JSON.stringify({ type: 'sim_state', seq: seq++, ...state }));
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
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    destroy() { clearInterval(intervalId); ws?.close(); },
  };
}

// ---------------------------------------------------------------------------
// createGuestSession — connects as guest, feeds InterpolationBuffer,
//                      drives onState(interpolatedState) via rAF
// ---------------------------------------------------------------------------

/**
 * @param {string} roomCode
 * @param {(state: object) => void} onState — called each rAF with interpolated state
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
// doesn't pop — see entity-types/projectile.js / light.js header notes.
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
    };
  }).filter(Boolean);
}
function _lerpState(a, b, alpha) {
  return {
    creatures: a.creatures.map((ca, i) => {
      const cb = b.creatures[i];
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
    worldSettings: b.worldSettings ?? a.worldSettings,
    creatureConfig: b.creatureConfig ?? a.creatureConfig,
    players: _lerpPlayers(a.players, b.players, alpha),
  };
}

// ---------------------------------------------------------------------------
// GhostRenderer — lightweight ghost meshes for creatures and remote players
//   Accepts THREE as a constructor param to avoid a static import
//   (keeps this module usable in Node.js tests that don't have three).
//   Creature ghosts: a semi-transparent box at body position
//   Player ghosts:   a capsule at player position
// ---------------------------------------------------------------------------

export class GhostRenderer {
  constructor(scene, THREE) {
    this._scene    = scene;
    this._THREE    = THREE;
    this._creatures = new Map(); // id(number) → Mesh
    this._players   = new Map(); // clientId(string) → Mesh
    this._cGeo = new THREE.BoxGeometry(0.7, 0.5, 1.0);
    this._pGeo = new THREE.CapsuleGeometry(0.3, 1.2, 4, 8);
    this._cMat = new THREE.MeshStandardMaterial({ color: 0x88ccff, transparent: true, opacity: 0.5 });
    this._pMat = new THREE.MeshStandardMaterial({ color: 0xffcc44, transparent: true, opacity: 0.7 });
  }

  update(state) {
    this._updateSet(state.creatures ?? [], this._creatures, this._cGeo, this._cMat,
      c => c.id, c => c.p, c => c.q);
    this._updateSet(state.players ?? [], this._players, this._pGeo, this._pMat,
      p => p.id, p => p.p, p => p.q);
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

  destroy() {
    for (const m of this._creatures.values()) this._scene.remove(m);
    for (const m of this._players.values())   this._scene.remove(m);
    this._creatures.clear();
    this._players.clear();
    this._cGeo.dispose();
    this._pGeo.dispose();
    this._cMat.dispose();
    this._pMat.dispose();
  }
}
