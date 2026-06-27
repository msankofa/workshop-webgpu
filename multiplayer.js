// RELAY_URL: override with ?relay=wss://... for production
const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
export const RELAY_URL = params.get('relay') || 'ws://localhost:8080';

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
        feet:  ca.feet.map((f, j) => cb.feet[j]  ? _lerpV3(f, cb.feet[j],  alpha) : f),
        hands: ca.hands.map((h, j) => cb.hands[j] ? _lerpV3(h, cb.hands[j], alpha) : h),
      };
    }),
    players: a.players.map((pa, i) => {
      const pb = b.players[i];
      if (!pb) return pa;
      return { id: pa.id, p: _lerpV3(pa.p, pb.p, alpha), q: _slerpQ(pa.q, pb.q, alpha) };
    }),
  };
}
