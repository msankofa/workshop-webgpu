// celestial-bodies.js
// TSL rendering of extra moons + distant/near planets as camera-following sprites.
// Body descriptors come from sky-field.js generateCelestialBodies(); this file owns the
// canvas painters and sprite assembly. Canvas textures are flagged for disposal.
import * as THREE from 'three';
import { SpriteNodeMaterial } from 'three/webgpu';

function markTex(tex) {
  tex.userData.proceduralSkyTexture = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// A soft shaded sphere (moon/rocky planet) with optional bands/rings/glow.
function paintBody(body) {
  const S = 256;
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d');
  // Keep the disc small enough that the glow + rings fade out before the canvas edge —
  // otherwise the radial gradients clip to the square and show a hard rectangular halo.
  const cx = S / 2, cy = S / 2, R = S * 0.26;
  // atmospheric glow
  if (body.glow) {
    const gl = g.createRadialGradient(cx, cy, R * 0.8, cx, cy, Math.min(R * 1.8, S * 0.49));
    gl.addColorStop(0, hexA(body.color, 0.5)); gl.addColorStop(1, hexA(body.color, 0));
    g.fillStyle = gl; g.fillRect(0, 0, S, S);
  }
  // body disc with lit upper-left
  const sh = g.createRadialGradient(cx - R * 0.4, cy - R * 0.4, R * 0.1, cx, cy, R);
  sh.addColorStop(0, lighten(body.color, 0.35));
  sh.addColorStop(0.7, body.color);
  sh.addColorStop(1, darken(body.color, 0.55));
  g.fillStyle = sh;
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
  // surface detail
  g.save(); g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();
  if (body.gas) {
    for (let i = 0; i < 6; i++) {
      const y = cy - R + (i + 0.5) * (2 * R / 6);
      g.fillStyle = (i % 2 ? lighten(body.color, 0.12) : darken(body.color, 0.18));
      g.fillRect(cx - R, y - R / 8, 2 * R, R / 4);
    }
    g.fillStyle = darken(body.color, 0.3);
    g.beginPath(); g.ellipse(cx + R * 0.3, cy + R * 0.2, R * 0.18, R * 0.1, 0, 0, Math.PI * 2); g.fill();
  } else {
    for (let i = 0; i < 7; i++) {
      const a = Math.random() * Math.PI * 2, rr = Math.random() * R * 0.8;
      g.fillStyle = darken(body.color, 0.2 + Math.random() * 0.2);
      g.beginPath(); g.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, R * (0.06 + Math.random() * 0.12), 0, Math.PI * 2); g.fill();
    }
  }
  g.restore();
  // limb darkening
  const ld = g.createRadialGradient(cx, cy, R * 0.6, cx, cy, R);
  ld.addColorStop(0, 'rgba(0,0,0,0)'); ld.addColorStop(1, 'rgba(0,0,0,0.45)');
  g.fillStyle = ld; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
  // rings
  if (body.rings) {
    g.save(); g.translate(cx, cy); g.rotate(-0.5); g.scale(1, 0.32);
    g.strokeStyle = hexA(lighten(body.color, 0.3), 0.7); g.lineWidth = S * 0.026;
    g.beginPath(); g.arc(0, 0, R * 1.4, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = hexA(body.color, 0.5); g.lineWidth = S * 0.013;
    g.beginPath(); g.arc(0, 0, R * 1.62, 0, Math.PI * 2); g.stroke();
    g.restore();
  }
  return markTex(new THREE.CanvasTexture(cv));
}

export function createCelestialBodies(bodyData) {
  const group = new THREE.Group();
  for (const body of bodyData) {
    const tex = paintBody(body);
    const mat = new SpriteNodeMaterial({ map: tex, transparent: true, depthWrite: false });
    mat.fog = false;
    const spr = new THREE.Sprite(mat);
    spr.position.set(body.position.x, body.position.y, body.position.z);
    const s = body.size * (body.rings ? 5 : body.glow ? 3.6 : 2.9);
    spr.scale.set(s, s, 1);
    spr.renderOrder = -996;
    group.add(spr);
  }
  return group;
}

// ---- small color helpers (hex string → adjusted rgba) ----
function parse(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function clamp8(v) { return Math.max(0, Math.min(255, v | 0)); }
function lighten(hex, t) { const [r, g, b] = parse(hex); return `rgb(${clamp8(r + (255 - r) * t)},${clamp8(g + (255 - g) * t)},${clamp8(b + (255 - b) * t)})`; }
function darken(hex, t) { const [r, g, b] = parse(hex); return `rgb(${clamp8(r * (1 - t))},${clamp8(g * (1 - t))},${clamp8(b * (1 - t))})`; }
function hexA(color, a) {
  if (color.startsWith('rgb')) return color.replace('rgb(', 'rgba(').replace(')', `,${a})`);
  const [r, g, b] = parse(color); return `rgba(${r},${g},${b},${a})`;
}
