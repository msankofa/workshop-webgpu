// RELAY_URL: override with ?relay=wss://... for production
const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
export const RELAY_URL = params.get('relay') || 'wss://workshop-webgpu.onrender.com';

// A/B: ?flushlod=0 restores the old always-refresh flush. On, a bot whose IK solve was strided
// this frame skips the ~170-node matrix walk and re-emits the pose it already holds.
let FLUSH_LOD = params.get('flushlod') !== '0';

// A/B: ?botcull=0 disables. A bot strictly behind the camera skips its flush, so it is absent from
// the immediate-mode pools and never drawn. Only STRICTLY behind (not the frustum sides) so a fast
// turn cannot outrun it, and never within BOT_CULL_NEAR2 whatever the angle. The IK solve still
// runs on its normal stride — this buys the triangles and the matrix walk, not the simulation, and
// keeps a spun-round camera from finding a stale pose.
let BOT_CULL_BEHIND = params.get('botcull') !== '0';
const BOT_CULL_NEAR2 = 8 * 8;

// A/B: ?rboxlod=1 enables (default OFF), ?rboxlodDist=<metres> moves the threshold. Past it a bot
// swaps its rbox armour to a seg=1 twin, ~96 K -> ~44 K triangles. This CHANGES HOW BOTS LOOK --
// chamfer highlights flatten -- so it stays off until the appearance is signed off. The 2 m band
// is hysteresis: without it a bot walking the threshold swaps every frame.
let RBOX_LOD = params.get('rboxlod') === '1';
let RBOX_LOD_D = Number(params.get('rboxlodDist') ?? 25);
let RBOX_LOD_IN2 = 0, RBOX_LOD_OUT2 = 0;
// The 2 m gap between in and out is the hysteresis band.
function refreshRboxBands() {
  RBOX_LOD_IN2 = (RBOX_LOD_D + 2) ** 2;
  RBOX_LOD_OUT2 = Math.max(0, RBOX_LOD_D - 2) ** 2;
}
refreshRboxBands();

/** Live values for a UI that labels its own buttons. */
export function getBotRenderTuning() {
  return { flushLod: FLUSH_LOD, cullBehind: BOT_CULL_BEHIND, rboxLod: RBOX_LOD, rboxLodDist: RBOX_LOD_D };
}

// Wave 2/B1: optional remote procedural walking body (see docs/subsystems/
// procedural-body-weapon-contracts.md, Contract 2). Static import is safe under
// plain Node (this module never touches THREE/DOM at import time; THREE is
// injected at call time), so it does not break multiplayer-test.mjs /
// test-ghost-renderer.mjs / test-multiplayer-guns.mjs.
import { createProceduralPlayerBody } from './player-procedural-body.js';
import { createBodyPartBatches } from './body-part-batches.js';
// Phase E death ragdolls. Both modules are pure (no THREE/DOM at import time; THREE is injected),
// so this stays safe under plain Node for multiplayer-test.mjs / test-ghost-renderer.mjs.
import { stepRagdoll, kineticEnergy } from './ragdoll.js';
import { ragdollFromBody, applyDeathImpulse } from './ragdoll-body.js';

// Team identity for bot bodies, mirroring bot-viewer-v2's BOT_TEAM_DEFS so a bot reads the same
// side in both viewers (alpha = green family, bravo = red family).
// `accent` is carried explicitly: it does NOT fall back to trim. mergeStyle fills it from
// DEFAULT_STYLE first, so `palette.accent ?? palette.trim` never fires and every accent piece —
// mast light, helmet patch, warhead cones — rendered the same pale grey on both sides here while
// bot-viewer-v2 showed them in team colour.
export const BOT_TEAM_STYLES = {
  alpha: { shell: 0x1f5b3a, plate: 0x101410, trim: 0x57d68d, accent: 0x53d68d },
  bravo: { shell: 0x64252a, plate: 0x171012, trim: 0xff8a80, accent: 0xff7b72 },
};

// Scale a packed hex color's channels (subtle per-bot brightness variation inside a team family).
function _shadeHex(hex, f) {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * f));
  const b = Math.min(255, Math.round((hex & 255) * f));
  return (r << 16) | (g << 8) | b;
}

// Body style for one bot: the team palette with an id-keyed brightness jitter so a squad reads as
// one side while individuals stay distinguishable. A bot with no replicated `team` (old peer, or a
// spawner that never stamped one) falls back to the original distinct-hue-per-id scheme.
function botBodyStyle(THREE, id, team) {
  const def = BOT_TEAM_STYLES[team];
  if (def) {
    const f = 0.86 + (_hashId(id) % 29) / 100; // 0.86 .. 1.14
    return { shell: _shadeHex(def.shell, f), plate: _shadeHex(def.plate, f),
      trim: _shadeHex(def.trim, f), accent: _shadeHex(def.accent, f) };
  }
  const hue = (_hashId(id) % 360) / 360;
  const shell = new THREE.Color().setHSL(hue, 0.55, 0.44).getHex();
  const plate = new THREE.Color().setHSL(hue, 0.50, 0.15).getHex();
  const trim  = new THREE.Color().setHSL(hue, 0.42, 0.62).getHex();
  // Teamless fallback: accent tracks the hue too, or the mast light is grey on a coloured bot.
  return { shell, plate, trim, accent: trim };
}

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
      // Stance weights interpolate like `h`; absent on both sides leaves them absent (upright).
      crouch: pa.crouch != null && pb.crouch != null ? pa.crouch + (pb.crouch - pa.crouch) * alpha : pb.crouch,
      prone: pa.prone != null && pb.prone != null ? pa.prone + (pb.prone - pa.prone) * alpha : pb.prone,
      standFullHeight: pb.standFullHeight ?? pa.standFullHeight,
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
      s: mb.s ?? ma.s ?? 1, // per-mob scale multiplier (default 1 when absent)
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
const FALL_MS = 450; // duration of the death-pose tip-over animation

// --- Phase E: bot death ragdolls (bot-viewer-v2 parity) ---------------------
const RAGDOLL_SLEEP_ENERGY = 1e-4;  // kineticEnergy below this counts as settled
const RAGDOLL_SLEEP_MS = 500;       // ...held that long, the corpse stops simulating
const RAGDOLL_MAX_LIVE = 12;        // awake corpses stepped per frame; overflow deaths tip over instead
const RAGDOLL_MAX_DT = 0.05;        // clamp a stalled frame so the solver can't spiral
const RAGDOLL_MAX_IMPULSE = 18;     // m/s cap on the replicated death impulse
const RAGDOLL_FALLBACK_IMPULSE = 4; // shove along facing when no hit direction was replicated
const RAGDOLL_GRAVITY = 25;

// --- Phase E: overhead indicators -------------------------------------------
const OVERLAY_HIDE_D2 = 60 * 60;    // squared XZ distance past which bars/marks are hidden
const OVERLAY_LIFT = 0.40;          // metres above the capsule crown
const HP_BAR_W = 0.78, HP_FILL_W = 0.70;
const ALERT_MARK_COLORS = { seen: 0xff5252, heard: 0xffd93d, push: 0x66ff66, base: 0xffffff, near: 0x4fc3f7 };
// Overhead role markers. Kept as a plain table rather than an import so this module stays free of
// bot-roles.js; the ids and shapes match its `insignia` field, and an unlisted role simply gets none.
const INSIGNIA_KINDS = { rifleman: 'diamond', medic: 'cross', squadleader: 'chevron', sniper: 'ring', technical: 'triangle' };
const INSIGNIA_COLORS = { diamond: 0xb0bec5, cross: 0xff5a5a, chevron: 0xffd54f, ring: 0x6fe3ff, triangle: 0xff8a3d };

// Deterministic light-pastel tint for a player id, shared by the remote ghost body/
// orbs and the local first-person viewmodel so your hands match your own ghost.
export function playerTintHSL(id) {
  return [(_hashId(id) % 360) / 360, 0.45, 0.72];
}

export class GhostRenderer {
  // options:
  //   terrainHeight(x, z) -> y   default () => 0. Passed straight through to
  //     createProceduralPlayerBody for foot planting; environment-viewer.html
  //     will wire the real terrain sampler later.
  //   useProceduralBody: boolean  default false. When false, behavior is
  //     byte-for-byte the existing capsule ghost (nothing below is exercised).
  //     When true, each remote player also gets a createProceduralPlayerBody
  //     instance (mode:'remote') driven from the interpolated wire pose, and
  //     the old capsule/eyes/orb-hands are hidden (still created, so flipping
  //     the flag at runtime would still work, though it is a constructor-only
  //     option today).
  constructor(scene, THREE, options = {}) {
    this._scene    = scene;
    this._THREE    = THREE;
    this._terrainHeight = options.terrainHeight || (() => 0);
    this._useProceduralBody = options.useProceduralBody === true;
    // getDesign(item) -> design object | null. Lets the host pick a per-bot appearance spec (role
    // kit) without this module importing bot-body-design.js — multiplayer.js stays THREE-free and
    // Node-testable, and the bot art stays owned by the caller.
    this._getDesign = typeof options.getDesign === 'function' ? options.getDesign : null;
    // Opt-in cyclic locomotion layer (body-locomotion.js) for BOT bodies only. Off by default so
    // every existing caller is unchanged; human ghosts keep the plain gait either way.
    this._botLocomotion = options.botLocomotion === true;
    // Bots-only render LOD: camera-distance accessor + squared-distance tiers. When set, distant
    // bot bodies run their procedural solve on a stride and hide entirely past hideD2. Humans/local
    // are exempt (few of them; popping on real players is more noticeable).
    this._getCameraPos = options.getCameraPos || null;
    // Optional sibling of getCameraPos. Without it the behind-camera cull simply never fires.
    this._getCameraFwd = options.getCameraForward || null;
    this._botLod = options.botLod || null; // { nearD2, midD2, hideD2 }
    this._lodFrame = 0;
    this._camPos = null;
    // Phase 4: instance bot bodies into a shared InstancedMesh pool (per-part draw call instead of
    // ~31 per bot). Created lazily on the first bot body. Bots only; humans/local keep the mesh path.
    this._instanceBots = options.instanceBots === true;
    this._bodyBatches = null;
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
    // Death pose: tip the upright yaw quaternion -90 deg around its own local X axis so a dead
    // player/bot capsule falls face-forward instead of just vanishing or standing inert.
    this._uprightQ = new THREE.Quaternion();
    this._fallTipQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    // Phase E: bots ragdoll on death instead of tipping over; humans keep the tip-over above.
    this._ragdollDeaths = options.ragdollDeaths !== false;
    this._ragdollMaxLive = options.maxLiveRagdolls ?? RAGDOLL_MAX_LIVE;
    this._ragdollAwake = 0;      // exact count of corpses still being stepped (see _retireRagdoll)
    this._ragdollLastT = null;
    this._ragdollDt = 0;
    this._ragdollStepOpts = { gravity: RAGDOLL_GRAVITY, groundHeight: (x, z) => this._terrainHeight(x, z) };
    // Phase E: overhead health bars + alert "!" marks. Assets are built lazily on the first bot
    // that needs one, so a renderer with no bots (and the Node tests) never allocates them.
    this._ov = null;
    this._overlayD2 = options.overlayHideD2 ?? Math.min(OVERLAY_HIDE_D2, this._botLod?.hideD2 ?? Infinity);
    this._axisX = new THREE.Vector3(1, 0, 0);
    this._axisY = new THREE.Vector3(0, 1, 0);
    this._bbYawQ = new THREE.Quaternion();
    this._bbPitchQ = new THREE.Quaternion();
  }

  update(state) {
    this._updateSet(state.creatures ?? [], this._creatures, this._cGeo, this._cMat,
      c => c.id, c => c.p, c => c.q);
    // ClaudeCraft mobs: guest render path (host renders GLB visuals directly). Same
    // interpolated wire shape { id, tid, p, q, hp, dead } as the host publishes.
    this._updateSet(state.mobs ?? [], this._mobs, this._mGeo, this._mMat,
      m => m.id, m => m.p, m => m.q, m => m.s);
    this._updatePlayers(state.players ?? []);
  }

  // id -> Group, for external raycasting/picking (bot inspector click-to-select).
  playerGroups() { return this._players; }

  /** Runtime A/B for the render-cost toggles. Pass only the fields you are changing. */
  setBotRenderTuning({ flushLod, cullBehind, rboxLod, rboxLodDist } = {}) {
    if (flushLod !== undefined) FLUSH_LOD = !!flushLod;
    if (cullBehind !== undefined) BOT_CULL_BEHIND = !!cullBehind;
    if (rboxLodDist !== undefined) { RBOX_LOD_D = rboxLodDist; refreshRboxBands(); }
    if (rboxLod !== undefined) {
      RBOX_LOD = !!rboxLod;
      // Turning it off has to walk every live body back to full detail: the per-bot swap only
      // runs while the flag is on, so a body left cheap would stay cheap forever.
      if (!RBOX_LOD) for (const g of this._players.values()) g.userData.bodyProc?.setGearLod?.(0);
    }
  }

  _updateSet(items, map, geo, mat, getId, getP, getQ, getScale) {
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
      } else if (getScale) {
        const s = getScale(item); // per-mob scale multiplier (default 1)
        mesh.scale.setScalar(s != null && s > 0 ? s : 1);
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
    this._lodFrame++;
    this._camPos = this._getCameraPos ? this._getCameraPos() : null;
    this._camFwd = this._getCameraFwd ? this._getCameraFwd() : null;
    // One shared clock for every corpse this frame (update() is per-frame on host, per-rAF on guest).
    const nowMs = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    this._ragdollDt = this._ragdollLastT != null
      ? Math.min(RAGDOLL_MAX_DT, Math.max(0, (nowMs - this._ragdollLastT) / 1000)) : 0;
    this._ragdollLastT = nowMs;
    // Immediate-mode instancing: zero the pool, every visible bot re-adds its parts below, upload
    // at the end. Runs every frame on the host (updateHostPlayerGhosts drives update() per frame).
    if (this._bodyBatches) this._bodyBatches.beginFrame();
    for (const item of items) {
      const id = item.id;
      seen.add(id);
      let g = this._players.get(id);
      if (!g) { g = this._makePlayer(id); this._scene.add(g); this._players.set(id, g); }
      const [px, py, pz] = item.p;
      const [qx, qy, qz, qw] = item.q;
      const r = item.r ?? 0.3;
      const h = item.h ?? 1.2;
      const isDead = item.alive === false;
      const ud = g.userData;
      if (isDead) {
        if (!ud.dead) {
          // Just died: capture the current (upright) pose as the fall's start point and let
          // tick() animate from there -- _updatePlayers itself only maintains the resting
          // target below, it never snaps the visible transform directly while dead.
          ud.dead = true;
          ud.fallStartAt = null; // set on tick()'s first frame after this, using its own clock
          ud.fallFromQ.copy(g.quaternion);
          ud.fallFromP.copy(g.position);
          this._startBotRagdoll(g, item); // bots flop for real; everything else keeps the tip-over
        }
        if (ud.ragdoll) {
          this._stepBotRagdoll(ud, nowMs);
        } else {
          // Drop from mid-capsule height to resting-on-side height (the capsule's long axis is
          // now horizontal), and tip forward along whatever direction it was last facing.
          this._uprightQ.set(qx, qy, qz, qw);
          ud.fallTargetQ.copy(this._uprightQ).multiply(this._fallTipQ);
          ud.fallTargetP.set(px, py - h * 0.5 + r, pz);
        }
      } else {
        if (ud.ragdoll) this._retireRagdoll(ud); // respawned into the same ghost id
        ud.dead = false;
        g.quaternion.set(qx, qy, qz, qw);
        g.position.set(px, py, pz);
      }
      g.userData.body.scale.set(r / 0.3, (h + r * 2) / 1.8, r / 0.3);
      this._placeEyes(g, r, h);
      this._placeHands(g, r, h);
      this._placeHeldItem(g, r, h, item);
      this._updateOverlays(g, item, r, h);
      // Dead actors retain the existing capsule fall pose; a ragdolling corpse is drawn by the
      // procedural body instead, so it keeps the procedural path. Living actors always do.
      const useProc = this._useProceduralBody && (!isDead || !!ud.ragdoll);
      g.userData.body.visible = !useProc;
      g.userData.held.visible = !useProc && g.userData.held.visible;
      // Extremities look wrong sideways on a fallen capsule -- hide them once dead (held item is
      // already hidden by _placeHeldItem's own alive check below).
      g.userData.left.visible = g.userData.right.visible = !isDead && !useProc;
      g.userData.leftHand.visible = g.userData.rightHand.visible = !isDead && !useProc;
      if (this._useProceduralBody) {
        this._updateProceduralBodyLod(g, item);
      }
    }
    for (const [id, g] of this._players) {
      if (!seen.has(id)) {
        if (g.userData.ragdoll) this._retireRagdoll(g.userData);
        if (g.userData.bodyProc) g.userData.bodyProc.destroy();
        this._scene.remove(g); g.userData.bodyMat.dispose(); this._players.delete(id);
      }
    }
    if (this._bodyBatches) this._bodyBatches.endFrame();
  }

  // Wave 2/B1: drive a per-player createProceduralPlayerBody follower from the
  // interpolated wire pose. Visual only — never writes back into `item`/state.
  // Velocity is derived from the position delta since the last call (there is
  // no replicated velocity field and remote feet/hands are never replicated,
  // per the contract doc's global guardrails), so the gait is a local guess,
  // not a replay of the sender's real feet.
  // Bots-only distance LOD gate around _updateProceduralBody. Alive bots past hideD2 are hidden and
  // skipped; nearer ones run the full solve on a per-bot-staggered stride (near=every frame,
  // mid=every 2nd, far=every 4th). Humans/local and dead actors always take the full path.
  // Strictly behind the camera, in XZ to match the LOD distance convention below. Bots only —
  // the local player's own body must never vanish from a mirror/reflection pass.
  _behindCamera(px, pz) {
    const f = this._camFwd, c = this._camPos;
    if (!BOT_CULL_BEHIND || !f || !c) return false;
    const dx = px - c.x, dz = pz - c.z;
    if (dx * dx + dz * dz < BOT_CULL_NEAR2) return false;
    return dx * f.x + dz * f.z < 0;
  }

  _updateProceduralBodyLod(g, item) {
    const ud = g.userData;
    const lod = this._botLod, camPos = this._camPos;
    // A ragdolling corpse is posed from the solver, never from the gait/IK solve. It still obeys the
    // body's hide distance and still flushes every frame (the batch is zeroed each beginFrame).
    // bodyProc can be null here even with a live ragdoll: rebuildBotBodies() throws every body away
    // mid-flight. It retires the ragdoll too, but this branch is also reached from update() paths that
    // run before the next rebuild completes, so it must not assume a rig exists.
    if (ud.ragdoll && ud.bodyProc) {
      if (lod && camPos) {
        const dx = item.p[0] - camPos.x, dz = item.p[2] - camPos.z;
        if (dx * dx + dz * dz > lod.hideD2) {
          if (!ud.bodyHidden) { ud.bodyProc.setVisible(false); ud.bodyHidden = true; }
          return;
        }
      }
      if (ud.bodyHidden) { ud.bodyProc.setVisible(true); ud.bodyHidden = false; }
      // Asleep: the pose is frozen, so skip the re-pose and let flush reuse last frame's matrices.
      if (!ud.ragdollAsleep) ud.bodyProc.setRagdollPose(ud.ragdollPose);
      if (item.isBot && this._behindCamera(item.p[0], item.p[2])) return;
      if (ud.bodyProc.flush) ud.bodyProc.flush(this._bodyBatches, !ud.ragdollAsleep);
      return;
    }
    if (!lod || !camPos || !item.isBot || item.alive === false || !ud.bodyProc) {
      if (ud.bodyProc && ud.bodyHidden) { ud.bodyProc.setVisible(true); ud.bodyHidden = false; }
      this._updateProceduralBody(g, item);
      if (ud.bodyProc && ud.bodyProc.flush) ud.bodyProc.flush(this._bodyBatches);
      return;
    }
    const px = item.p[0], pz = item.p[2];
    const dx = px - camPos.x, dz = pz - camPos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > lod.hideD2) {
      if (!ud.bodyHidden) { ud.bodyProc.setVisible(false); ud.bodyHidden = true; }
      return; // hidden bodies cost nothing this frame (and are not flushed → absent from the batch)
    }
    if (ud.bodyHidden) { ud.bodyProc.setVisible(true); ud.bodyHidden = false; }
    const stride = d2 < lod.nearD2 ? 1 : d2 < lod.midD2 ? 2 : 4;
    const solved = stride === 1 || ((this._lodFrame + (ud.lodPhase || 0)) % stride) === 0;
    if (solved) this._updateProceduralBody(g, item);
    if (RBOX_LOD && ud.bodyProc.setGearLod) {
      if (d2 > RBOX_LOD_IN2) ud.bodyProc.setGearLod(1);
      else if (d2 < RBOX_LOD_OUT2) ud.bodyProc.setGearLod(0);
    }
    if (this._behindCamera(px, pz)) return;   // solved above, simply not drawn this frame
    // Flush every frame even when the IK solve was strided, so the held pose persists in the batch
    // (beginFrame zeroed it). Strided frames skip the matrix walk -- nothing moved.
    if (ud.bodyProc.flush) ud.bodyProc.flush(this._bodyBatches, solved || !FLUSH_LOD);
  }

  // Alive -> dead edge for a bot: seed a Verlet ragdoll from the rig's live joint world positions
  // (so the corpse flops from where it died) and kick it along the replicated death impulse. Bails
  // to the capsule tip-over when there is no rig to seed from or the live-corpse budget is full.
  _startBotRagdoll(g, item) {
    const ud = g.userData;
    if (!this._ragdollDeaths || !item.isBot || !ud.bodyProc) return;
    if (this._ragdollAwake >= this._ragdollMaxLive) return;
    const px = item.p[0], pz = item.p[2];
    const yaw = _yawFromQuat(item.q);
    const { rd, pose } = ragdollFromBody(this._THREE, ud.bodyProc, {
      origin: { x: px, y: this._terrainHeight(px, pz), z: pz }, yaw,
    });
    // Direction of the killing blow when the sender stamped one (magnitude = m/s), else the bot's
    // own last motion, else a small shove down its facing axis so it never falls perfectly straight.
    const imp = item.deathImpulse;
    let dx = 0, dy = 0, dz = 0;
    if (Array.isArray(imp)) { dx = imp[0] || 0; dy = imp[1] || 0; dz = imp[2] || 0; }
    else if (Array.isArray(item.velocity)) { dx = item.velocity[0] || 0; dz = item.velocity[2] || 0; }
    let strength = Math.hypot(dx, dy, dz);
    if (!(strength > 0.05)) { dx = Math.sin(yaw); dy = 0; dz = Math.cos(yaw); strength = RAGDOLL_FALLBACK_IMPULSE; }

    applyDeathImpulse(rd, { dir: { x: dx, y: dy, z: dz }, strength: Math.min(RAGDOLL_MAX_IMPULSE, strength) });
    ud.ragdoll = rd;
    ud.ragdollPose = pose;
    ud.ragdollSettledSince = null;
    ud.ragdollAsleep = false;
    this._ragdollAwake++;
  }

  // Advance one corpse; once its kinetic energy has stayed under the sleep threshold for
  // RAGDOLL_SLEEP_MS it stops simulating and just holds its final pose until the record disappears.
  _stepBotRagdoll(ud, nowMs) {
    if (ud.ragdollAsleep) return;
    stepRagdoll(ud.ragdoll, this._ragdollDt, this._ragdollStepOpts);
    if (kineticEnergy(ud.ragdoll) < RAGDOLL_SLEEP_ENERGY) {
      if (ud.ragdollSettledSince == null) ud.ragdollSettledSince = nowMs;
      else if (nowMs - ud.ragdollSettledSince >= RAGDOLL_SLEEP_MS) {
        ud.ragdollAsleep = true;
        this._ragdollAwake--;
      }
    } else {
      ud.ragdollSettledSince = null;
    }
  }

  // Drop a corpse's ragdoll (respawn into the same ghost id, or the ghost going away).
  _retireRagdoll(ud) {
    if (!ud.ragdollAsleep) this._ragdollAwake--;
    ud.ragdoll = null;
    ud.ragdollPose = null;
    ud.ragdollSettledSince = null;
    ud.ragdollAsleep = false;
    // The gait solve was skipped for the whole corpse's life; re-anchor its clock so the first
    // frame back doesn't feed update() a multi-second dt (and a bogus velocity with it).
    ud.bodyLastT = null;
    ud.bodyLastPos = null;
  }

  _updateProceduralBody(g, item) {
    const THREE = this._THREE;
    const ud = g.userData;
    if (!ud.bodyProc) {
      const instanceThis = this._instanceBots && item.isBot;
      if (instanceThis && !this._bodyBatches) {
        // See bot-viewer-v2: 4 instances/bot in the heaviest bucket, so 2048 covers 500+ bots.
        this._bodyBatches = createBodyPartBatches({ THREE, scene: this._scene, capacity: 2048 });
      }
      ud.bodyProc = createProceduralPlayerBody({ THREE, scene: this._scene, terrainHeight: this._terrainHeight,
        mode: 'remote', adaptGaitToSpeed: true, movementDynamics: true,
        // Team colors (both the instanced and mesh bot paths); humans keep the tinted default style.
        style: item.isBot ? botBodyStyle(THREE, item.id, item.team) : {},
        // Appearance spec (armour + role kit). Null keeps the bare default rig, which is what every
        // caller got before this hook existed — so a caller that does not pass getDesign is
        // unchanged. Humans are never given a bot design.
        design: (item.isBot && this._getDesign) ? this._getDesign(item) : null,
        naturalLocomotion: this._botLocomotion && item.isBot,
        batches: instanceThis ? this._bodyBatches : null,
      });
      if (!item.isBot) {
        const [th, ts, tl] = playerTintHSL(item.id);
        ud.bodyProc.setTint({ h: th, s: ts, l: tl });
      }
    }

    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const dt = ud.bodyLastT != null ? Math.max(0, (now - ud.bodyLastT) / 1000) : 0;
    const [px, py, pz] = item.p;
    let vx = 0, vz = 0;
    if (ud.bodyLastPos && dt > 0) {
      vx = (px - ud.bodyLastPos.x) / dt;
      vz = (pz - ud.bodyLastPos.z) / dt;
    }
    ud.bodyLastPos = { x: px, y: py, z: pz };
    if (Array.isArray(item.velocity)) {
      vx = Number.isFinite(item.velocity[0]) ? item.velocity[0] : vx;
      vz = Number.isFinite(item.velocity[2]) ? item.velocity[2] : vz;
    }
    ud.bodyLastT = now;

    // Yaw from the wire quaternion. `player_state`'s q is documented (see
    // multiplayer.md's angle-convention section) as pure yaw around Y, so this
    // general formula reduces exactly to `y` for q = (0, sin(y/2), 0, cos(y/2));
    // written generally rather than the 2*atan2(qy,qw) shortcut so it stays
    // correct even if a caller's q ever carries tiny roll/pitch noise.
    const yaw = _yawFromQuat(item.q);

    ud.bodyProc.update(dt, {
      id: item.id,
      position: new THREE.Vector3(px, py, pz),
      yaw,
      aimPitch: item.aimPitch || 0,
      // h is the capsule's straight middle; include its two rounded caps for the rig. A sender that
      // shrinks the capsule for stance also sends `standFullHeight` -- pose from that, or the rig's
      // own crouch channel doubles up on an already-shortened body.
      height: item.standFullHeight ?? item.fullHeight ?? ((item.h ?? 1.2) + (item.r ?? 0.3) * 2),
      radius: item.r ?? 0.3,
      velocity: new THREE.Vector3(vx, 0, vz),
      onFloor: item.onFloor !== false,
      // Stance pose weights (bot-stance.js) when the sender carries them; absent = upright.
      crouch: Number.isFinite(item.crouch) ? item.crouch : 0,
      prone: Number.isFinite(item.prone) ? item.prone : 0,
      alive: item.alive !== false,
      weapon: item.weapon,
      tool: item.tool,
    });
    return dt;
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
      lodPhase: _hashId(id) % 4, // stagger the far-body update stride so bots don't all solve on the same frame
      bodyHidden: false,         // true while this bot is past the LOD hide distance
      handX: 0.33, handY: 0.18, handZ: -0.47, // base offsets, set by _placeHands
      heldFlashUntil: 0,
      lastX: 0, lastZ: 0, lastNow: null,      // for speed-based sway
      bodyProc: null, bodyLastPos: null, bodyLastT: null, // Wave 2/B1 procedural body
      // Death-pose fall animation (tick()-driven, see FALL_MS): `dead` is the edge-detected
      // state, `fallStartAt` is set on the first tick() after death, `fallFromQ`/`fallFromP` are
      // the last upright pose (captured once at the moment of death) that the fall lerps away
      // from, and `fallTargetQ`/`fallTargetP` are the resting fallen pose _updatePlayers keeps
      // refreshed (harmless to recompute every call since a dead bot's wire pose is frozen).
      dead: false, fallStartAt: null,
      fallFromQ: new THREE.Quaternion(), fallFromP: new THREE.Vector3(),
      fallTargetQ: new THREE.Quaternion(), fallTargetP: new THREE.Vector3(),
      // Phase E: bot death ragdoll (null until the alive->dead edge) + overhead indicator group.
      ragdoll: null, ragdollPose: null, ragdollSettledSince: null, ragdollAsleep: false,
      overlay: null,
    };
    if (this._useProceduralBody) {
      // Keep the capsule/eyes/orb-hands meshes (so nothing else in this class
      // has to special-case their absence) but hide them — the procedural body
      // renders instead. Held-item placeholder stays visible (unposed follow-up).
      body.visible = false;
      left.visible = false;
      right.visible = false;
      leftHand.visible = false;
      rightHand.visible = false;
    }
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
    if (item.alive === false) { ud.held.visible = false; return; }
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

  // Shared overhead-indicator geometry/materials, built on the first bot that needs one. Box (not
  // plane) geometry keeps this usable from the Node ghost tests' minimal THREE stub.
  _overlayAssets() {
    if (this._ov) return this._ov;
    const THREE = this._THREE;
    const flat = (color, extra) => new THREE.MeshBasicMaterial({ color, depthWrite: false, toneMapped: false, ...extra });
    this._ov = {
      barGeo: new THREE.BoxGeometry(HP_BAR_W, 0.10, 0.012),
      fillGeo: new THREE.BoxGeometry(HP_FILL_W, 0.058, 0.012),
      exBarGeo: new THREE.BoxGeometry(0.07, 0.24, 0.02),
      exDotGeo: new THREE.BoxGeometry(0.07, 0.07, 0.02),
      bgMat: flat(0x161a20, { transparent: true, opacity: 0.9 }),
      hpMats: [flat(0x63e6a4), flat(0xffd166), flat(0xff6b6b)], // healthy / hurt / critical
      alertMats: Object.fromEntries(Object.entries(ALERT_MARK_COLORS).map(([m, c]) => [m, flat(c)])),
      // Role insignia. Box geometry throughout (not plane/ring/circle) so the Node ghost tests'
      // minimal THREE stub can still build these; the shapes read the same at overhead size.
      insBarGeo: new THREE.BoxGeometry(0.22, 0.07, 0.02),
      insCrossHGeo: new THREE.BoxGeometry(0.26, 0.08, 0.02),
      insCrossVGeo: new THREE.BoxGeometry(0.08, 0.26, 0.02),
      insBlockGeo: new THREE.BoxGeometry(0.16, 0.16, 0.02),
      insMats: Object.fromEntries(Object.entries(INSIGNIA_COLORS).map(([k, c]) => [k, flat(c)])),
    };
    return this._ov;
  }

  // The overhead role marker for a role id, or null for a role with none. Shapes mirror the
  // harness's: diamond rifleman, cross medic, chevron squad leader, ring sniper, triangle technical.
  _makeInsignia(role) {
    const kind = INSIGNIA_KINDS[role];
    if (!kind) return null;
    const THREE = this._THREE, ov = this._overlayAssets();
    const group = new THREE.Group();
    const mat = ov.insMats[kind] || ov.insMats.diamond;
    if (kind === 'cross') {
      group.add(new THREE.Mesh(ov.insCrossHGeo, mat), new THREE.Mesh(ov.insCrossVGeo, mat));
    } else if (kind === 'chevron') {
      const left = new THREE.Mesh(ov.insBarGeo, mat);
      left.position.x = -0.075; left.rotation.z = 0.85;
      const right = new THREE.Mesh(ov.insBarGeo, mat);
      right.position.x = 0.075; right.rotation.z = -0.85;
      group.add(left, right);
    } else {   // diamond / ring / triangle: one block, rolled so each reads differently
      const m = new THREE.Mesh(ov.insBlockGeo, mat);
      m.rotation.z = kind === 'diamond' ? Math.PI / 4 : kind === 'triangle' ? Math.PI : 0;
      group.add(m);
    }
    group.renderOrder = 6;
    return group;
  }

  // One indicator group per bot, parented to its ghost container so it lives and dies with it.
  _makeOverlay(g) {
    const THREE = this._THREE, ov = this._overlayAssets();
    const group = new THREE.Group();
    const bar = new THREE.Group();
    const bg = new THREE.Mesh(ov.barGeo, ov.bgMat);
    const fill = new THREE.Mesh(ov.fillGeo, ov.hpMats[0]);
    fill.position.set(0, 0, 0.008);
    bar.add(bg); bar.add(fill);
    const mark = new THREE.Group();
    const exBar = new THREE.Mesh(ov.exBarGeo, ov.alertMats.seen);
    exBar.position.set(0, 0.11, 0);
    const exDot = new THREE.Mesh(ov.exDotGeo, ov.alertMats.seen);
    exDot.position.set(0, -0.09, 0);
    mark.add(exBar); mark.add(exDot);
    mark.position.set(0, 0.34, 0);
    group.add(bar); group.add(mark);
    group.renderOrder = 6; // harness parity: overlays draw last so they don't z-fight the body
    g.add(group);
    const o = { group, bar, fill, mark, exBar, exDot, hpTier: -1, alertMode: null,
      insignia: null, insigniaRole: undefined };
    g.userData.overlay = o;
    return o;
  }

  // Health bar (while damaged) + alert "!" (while a cue is live) above a bot's head, billboarded at
  // the camera and hidden past _overlayD2. Bots only; humans and the local player carry neither.
  _updateOverlays(g, item, r, h) {
    const ud = g.userData;
    if (!item.isBot) { if (ud.overlay) ud.overlay.group.visible = false; return; }
    const alive = item.alive !== false;
    const maxHp = item.maxHp > 0 ? item.maxHp : 100;
    const hp01 = Number.isFinite(item.hp) ? Math.max(0, Math.min(1, item.hp / maxHp)) : 1;
    const mode = alive ? (item.alertTier || null) : null;
    const showHp = alive && hp01 < 0.999;
    const camPos = this._camPos;
    let inRange = true;
    if (camPos) {
      const dx = item.p[0] - camPos.x, dz = item.p[2] - camPos.z;
      inRange = dx * dx + dz * dz <= this._overlayD2;
    }
    const showRole = alive && !!INSIGNIA_KINDS[item.role];
    if (!inRange || (!showHp && !mode && !showRole)) { if (ud.overlay) ud.overlay.group.visible = false; return; }
    const o = ud.overlay || this._makeOverlay(g);
    o.group.visible = true;
    o.bar.visible = showHp;
    o.mark.visible = !!mode;
    // Role insignia sits above the "!" so the two never overlap. Rebuilt only when the role changes.
    if (o.insigniaRole !== item.role) {
      if (o.insignia) { o.group.remove(o.insignia); o.insignia = null; }
      o.insigniaRole = item.role ?? null;
      o.insignia = this._makeInsignia(item.role);
      if (o.insignia) { o.insignia.position.set(0, 0.62, 0); o.group.add(o.insignia); }
    }
    if (o.insignia) o.insignia.visible = showRole;
    o.group.position.set(0, h * 0.5 + r + OVERLAY_LIFT, 0);
    if (showHp) {
      o.fill.scale.x = hp01;
      o.fill.position.x = -(HP_FILL_W * 0.5) * (1 - hp01);
      const tier = hp01 > 0.55 ? 0 : hp01 > 0.30 ? 1 : 2;
      if (tier !== o.hpTier) { o.hpTier = tier; o.fill.material = this._ov.hpMats[tier]; }
    }
    if (mode && mode !== o.alertMode) {
      o.alertMode = mode;
      const mat = this._ov.alertMats[mode] || this._ov.alertMats.base;
      o.exBar.material = mat; o.exDot.material = mat;
    }
    // Billboard: face the camera in world space, minus the container's own yaw (this is a child of
    // it). No camera quaternion needed -- the look direction is derived from the two positions.
    if (camPos) {
      const wy = item.p[1] + h * 0.5 + r + OVERLAY_LIFT;
      const dx = camPos.x - item.p[0], dy = camPos.y - wy, dz = camPos.z - item.p[2];
      const flat = Math.sqrt(dx * dx + dz * dz) || 1e-6;
      const yaw = Math.atan2(dx, dz) - _yawFromQuat(item.q);
      o.group.quaternion.copy(this._bbYawQ.setFromAxisAngle(this._axisY, yaw))
        .multiply(this._bbPitchQ.setFromAxisAngle(this._axisX, -Math.atan2(dy, flat)));
    }
  }

  // Per-frame blink driver â€” update() only runs on network events, so blink has
  // to be driven separately. Squashes eye scale.y 1 -> ~0.1 -> 1 over BLINK_MS.
  tick(nowMs) {
    const now = nowMs ?? 0;
    for (const g of this._players.values()) {
      const ud = g.userData;
      if (ud.dead && !ud.ragdoll) {
        // Smoothly animate the fall rather than snapping straight to the resting pose --
        // _updatePlayers only maintains fallFrom*/fallTarget*, this is the only place that
        // writes g.quaternion/g.position while dead.
        if (ud.fallStartAt == null) ud.fallStartAt = now;
        const t = Math.min(1, (now - ud.fallStartAt) / FALL_MS);
        g.quaternion.copy(ud.fallFromQ).slerp(ud.fallTargetQ, t);
        g.position.lerpVectors(ud.fallFromP, ud.fallTargetP, t);
      }
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

  /**
   * The procedural body currently attached to a ghost id, or null. Lets the host resolve a hit
   * against the rig the viewer is actually drawing (bot-body-hit.js) instead of the sim capsule, and
   * keep a wound stain riding the part it was left on. Read-only: nothing here mutates the body.
   *
   * Note it does not distinguish a live rig from one being posed by a ragdoll — a killing blow can
   * therefore attach its stain to a corpse's rig, which is where that wound belongs anyway.
   */
  bodyFor(id) { return this._players.get(id)?.userData?.bodyProc ?? null; }

  /**
   * Throw away every procedural body so the next update() rebuilds it from getDesign(). Needed
   * because a body reads its design ONCE at construction: changing what getDesign returns (the
   * armoured/soldier switch) leaves live bots wearing the old one forever otherwise.
   *
   * Not filtered to bots. There is no isBot flag on the ghost — it only exists on the wire item —
   * and rebuilding a human ghost is harmless: it gets design null either way, which is what it had.
   */
  rebuildBotBodies() {
    for (const g of this._players.values()) {
      const ud = g.userData;
      if (!ud.bodyProc) continue;
      // A corpse mid-ragdoll is posed FROM this rig every frame. Dropping the rig without retiring
      // the ragdoll left `ud.ragdoll` set with `bodyProc` null, which threw on the next frame's
      // setRagdollPose/flush -- and leaked a slot from the live-corpse budget, since only
      // _retireRagdoll decrements it. That is the "switched body kind and it froze" crash.
      if (ud.ragdoll) this._retireRagdoll(ud);
      ud.bodyProc.destroy();
      ud.bodyProc = null;
      // Same reason as the ragdoll revive path: without this the rebuilt body's first frame gets a
      // dt spanning the whole gap since the last solve, and a nonsense velocity derived from it.
      ud.bodyLastT = null;
      ud.bodyLastPos = null;
    }
  }

  destroy() {
    for (const m of this._creatures.values()) this._scene.remove(m);
    for (const g of this._players.values())   {
      if (g.userData.bodyProc) g.userData.bodyProc.destroy();
      this._scene.remove(g); g.userData.bodyMat.dispose();
    }
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
    if (this._ov) {
      const ov = this._ov;
      for (const gGeo of [ov.barGeo, ov.fillGeo, ov.exBarGeo, ov.exDotGeo,
        ov.insBarGeo, ov.insCrossHGeo, ov.insCrossVGeo, ov.insBlockGeo]) gGeo.dispose();
      ov.bgMat.dispose();
      for (const m of ov.hpMats) m.dispose();
      for (const m of Object.values(ov.alertMats)) m.dispose();
      for (const m of Object.values(ov.insMats)) m.dispose();
      this._ov = null;
    }
  }
}

// Yaw around Y from a wire quaternion. The general form (not the 2*atan2(qy,qw) shortcut) so it
// stays correct if a caller's pure-yaw q ever carries tiny roll/pitch noise.
function _yawFromQuat(q) {
  const [qx, qy, qz, qw] = q;
  return Math.atan2(2 * (qw * qy + qx * qz), 1 - 2 * (qy * qy + qz * qz));
}

// Small deterministic string hash for staggering per-player blink timers.
function _hashId(id) {
  const s = String(id);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
}
