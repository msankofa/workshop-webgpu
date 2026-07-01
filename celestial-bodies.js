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

// Multi-band procedural ring system: several concentric bands of varying width/brightness with
// gaps between them (Cassini-division-style), instead of two fixed-width solid strokes. All
// parameters are optional on `body` (ringColor/ringTilt/ringInner/ringOuter/ringBandCount/
// ringDensity) — a missing field falls back to a sensible default, so older/synthetic body
// descriptors (e.g. the smoke test's) still render. Callers draw the [0, PI) half before the
// planet disc is painted and the [PI, 2*PI) half after, so the disc's opaque pixels occlude
// whichever half of the ring geometrically passes behind it (otherwise both "sides" of the
// ring show fully, since nothing else in this canvas-2D pipeline does depth occlusion).
function paintRings(g, cx, cy, R, S, body, a0, a1) {
  const color = body.ringColor || body.color;
  const tilt = body.ringTilt ?? -0.5;
  const inner = R * (body.ringInner ?? 1.3);
  const outer = R * (body.ringOuter ?? 1.75);
  const bandCount = Math.max(1, body.ringBandCount ?? 5);
  const density = body.ringDensity ?? 1;
  const seed = (body.seed || 0) * 97.3 + 41;
  g.save(); g.translate(cx, cy); g.rotate(tilt); g.scale(1, 0.32);
  for (let i = 0; i < bandCount; i++) {
    const t0 = i / bandCount, t1 = (i + 0.8) / bandCount; // ~20% gap between bands
    const rIn = inner + (outer - inner) * t0;
    const rOut = inner + (outer - inner) * t1;
    const bandNoise = hash3(i, 0, 0, seed);
    const alpha = Math.min(1, (0.2 + bandNoise * 0.5) * density);
    const bandColor = bandNoise > 0.5 ? lighten(color, 0.3 * bandNoise) : darken(color, 0.35 * (1 - bandNoise));
    g.strokeStyle = hexA(bandColor, alpha);
    g.lineWidth = Math.max(1, rOut - rIn);
    g.beginPath(); g.arc(0, 0, (rIn + rOut) / 2, a0, a1); g.stroke();
  }
  g.restore();
}

// Soft multi-stop atmospheric glow (a flat 2-stop gradient reads as a hard-edged disc of
// light rather than a haze). Configurable via glowColor/glowRadius/glowIntensity (optional,
// defaults preserve the pre-existing look for bodies that don't set them).
function paintGlow(g, cx, cy, R, S, body) {
  const color = body.glowColor || body.color;
  const intensity = body.glowIntensity ?? 0.5;
  const radius = Math.min(R * (body.glowRadius ?? 1.35), S * 0.49);
  // Gradient starts exactly at the disc edge (R), not inside it (an earlier version started
  // at R*0.78 — since the disc overwrites everything within R anyway, that wasted the first
  // ~22% of the gradient's falloff on an invisible region, so the visible part began already
  // ~73% of the way to peak brightness right at the edge, reading as a hard bright rim rather
  // than a gradual fade). Starting at R lets the whole stop range fade across the whole
  // visible span.
  const gl = g.createRadialGradient(cx, cy, R, cx, cy, radius);
  gl.addColorStop(0, hexA(color, intensity));
  gl.addColorStop(0.4, hexA(color, intensity * 0.45));
  gl.addColorStop(1, hexA(color, 0));
  g.fillStyle = gl; g.fillRect(0, 0, S, S);
}

// ---- fractal/cellular noise for the HD painter (canvas-only; no TSL/GPU dependency) ----
function hash3(x, y, z, seed) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed * 91.7) * 43758.5453;
  return s - Math.floor(s);
}
function lerp(a, b, t) { return a + (b - a) * t; }
function noise3(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const n000 = hash3(xi, yi, zi, seed), n100 = hash3(xi + 1, yi, zi, seed);
  const n010 = hash3(xi, yi + 1, zi, seed), n110 = hash3(xi + 1, yi + 1, zi, seed);
  const n001 = hash3(xi, yi, zi + 1, seed), n101 = hash3(xi + 1, yi, zi + 1, seed);
  const n011 = hash3(xi, yi + 1, zi + 1, seed), n111 = hash3(xi + 1, yi + 1, zi + 1, seed);
  const x00 = lerp(n000, n100, u), x10 = lerp(n010, n110, u);
  const x01 = lerp(n001, n101, u), x11 = lerp(n011, n111, u);
  const y0 = lerp(x00, x10, v), y1 = lerp(x01, x11, v);
  return lerp(y0, y1, w);
}
function fbm3(x, y, z, seed, octaves) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise3(x * freq, y * freq, z * freq, seed) * amp;
    norm += amp;
    amp *= 0.5; freq *= 2.15;
  }
  return sum / norm;
}
function smoothstep(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }
function mixRGB(c0, c1, t) { return [lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t)]; }
// Worley F1 (distance to nearest jittered point) — isolated round blobs, used for craters.
function worleyF1(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let best = 1e9;
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = xi + dx, cy = yi + dy, cz = zi + dz;
    const jx = hash3(cx, cy, cz, seed), jy = hash3(cx, cy, cz, seed + 17.3), jz = hash3(cx, cy, cz, seed + 41.9);
    const px = cx + jx, py = cy + jy, pz = cz + jz;
    const ddx = px - x, ddy = py - y, ddz = pz - z;
    const d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
    if (d < best) best = d;
  }
  return best;
}
// Worley F1/F2 (distance to nearest AND second-nearest point) — F2-F1 is ~0 on cell
// boundaries, giving a connected crack/vein network, used for ice cracks and lava veins.
function worleyF1F2(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let best1 = 1e9, best2 = 1e9;
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = xi + dx, cy = yi + dy, cz = zi + dz;
    const jx = hash3(cx, cy, cz, seed), jy = hash3(cx, cy, cz, seed + 17.3), jz = hash3(cx, cy, cz, seed + 41.9);
    const px = cx + jx, py = cy + jy, pz = cz + jz;
    const ddx = px - x, ddy = py - y, ddz = pz - z;
    const d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
    if (d < best1) { best2 = best1; best1 = d; } else if (d < best2) { best2 = d; }
  }
  return [best1, best2];
}
const LX = -0.55, LY = 0.6, LZ = 0.6;
const LLEN = Math.hypot(LX, LY, LZ);
const lightDir = [LX / LLEN, LY / LLEN, LZ / LLEN];

// Tunable visual constants, read at paint time (not captured as literals) so
// stellar-viewer.html's sliders mutate this object and the next repaint reflects it.
// Production code (createCelestialBodies) never writes to this object.
export const PAINTER_TUNING = {
  terrestrial: { cloudThreshold: [0.56, 0.78], iceCapLatitude: [0.74, 0.9], continentThreshold: [0.46, 0.52], specularPower: 50 },
  gas:         { warpAmount: 1.4, warpFreq: 2.5, bandFreq: 6.5, bandThreshold: [0.3, 0.7] },
  ice:         { crackFreq: 4.5, crackWidth: 0.06 },
  volcanic:    { veinFreq: 4, veinWidth: 0.05, hotWidth: 0.025, ambient: 0.12 },
  rocky:       { craterFreq: 5, rimBand: [0.32, 0.22], floorBand: [0.14, 0.05], continentThreshold: [0.42, 0.58] },
};

// Per-pixel atmosphere tint for the Fresnel rim glow — only kinds with a real
// atmosphere get one (gas giants already get the existing halo via body.glow).
const ATMO_COLOR = {
  terrestrial: [159, 208, 255],
  ice: [210, 230, 255],
};

function paintBodyHD(body) {
  // Higher resolution than paintBodySimple: this painter is only used for detail: 'high'
  // bodies (the near planet + its moons, or anything shown in stellar-viewer.html), which get
  // viewed up close/scaled up — 256px was visibly blurry once magnified. This is a one-time
  // bake cost per body (not per-frame), so the extra canvas-fill work is cheap to afford.
  const S = 512;
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const cx = S / 2, cy = S / 2, R = S * 0.26;
  const seed = (body.seed || 0) * 53.7;
  const kind = body.kind;
  const tuning = PAINTER_TUNING[kind] || PAINTER_TUNING.rocky;
  const atmo = ATMO_COLOR[kind];

  const base = parse(body.color);
  // NOTE: lighten()/darken() return CSS "rgb(...)" strings for canvas fillStyle use —
  // NOT hex, so they can't be round-tripped through parse(). Compute the same math
  // (mix toward white/black) directly as numeric [r,g,b] via mixRGB instead.
  const hi = mixRGB(base, [255, 255, 255], 0.45);
  const lo = mixRGB(base, [0, 0, 0], 0.55);
  // Secondary hue (falls back to the primary if a body predates color2) — blended in per-patch
  // below so a body shows genuine multi-hue mineral/terrain variety (like Io's sulfur patches
  // or Callisto's mottled terrain) instead of only ever varying the lightness of one hue.
  const base2 = parse(body.color2 || body.color);
  const hi2 = mixRGB(base2, [255, 255, 255], 0.45);
  const lo2 = mixRGB(base2, [0, 0, 0], 0.55);

  if (body.glow) paintGlow(g, cx, cy, R, S, body);
  // Back half of the ring, drawn before the disc so the sphere-shading pass below occludes it.
  if (body.rings) paintRings(g, cx, cy, R, S, body, 0, Math.PI);

  const bx0 = Math.max(0, Math.floor(cx - R) - 1), by0 = Math.max(0, Math.floor(cy - R) - 1);
  const bw = Math.min(S, Math.ceil(R * 2) + 2), bh = Math.min(S, Math.ceil(R * 2) + 2);
  const img = g.getImageData(bx0, by0, bw, bh);
  const data = img.data;

  for (let py = 0; py < bh; py++) {
    for (let px = 0; px < bw; px++) {
      const x = bx0 + px, y = by0 + py;
      const nx = (x + 0.5 - cx) / R, ny = (y + 0.5 - cy) / R;
      const d2 = nx * nx + ny * ny;
      if (d2 > 1) continue;
      const nz = Math.sqrt(Math.max(0, 1 - d2));

      // Per-pixel secondary-hue patch mask — every kind below mixes its normal base/hi/lo
      // endpoints with this patch's local pbase/phi/plo so terrain shapes stay the same but
      // their color can land on either hue depending on which mineral patch they fall in.
      const patchN = fbm3(nx * 1.7 + seed * 3.3, ny * 1.7 + seed * 3.3, nz * 1.7 + seed * 3.3, seed + 27, 3);
      const patch = smoothstep(0.4, 0.6, patchN);
      const pbase = mixRGB(base, base2, patch);
      const phi = mixRGB(hi, hi2, patch);
      const plo = mixRGB(lo, lo2, patch);

      let r, gC, b, emissive = [0, 0, 0];

      if (kind === 'terrestrial') {
        const ct = tuning.continentThreshold;
        const land = fbm3(nx * 2.3 + seed, ny * 2.3 + seed, nz * 2.3 + seed, seed, 5);
        const continent = smoothstep(ct[0], ct[1], land);
        const biome = fbm3(nx * 3.7 + seed * 7, ny * 3.7 + seed * 7, nz * 3.7 + seed * 7, seed + 9, 3);
        const landColor = mixRGB(plo, phi, smoothstep(0.3, 0.7, biome));
        [r, gC, b] = mixRGB(pbase, landColor, continent);
        const lat = Math.abs(ny);
        const capT = tuning.iceCapLatitude;
        const iceCap = smoothstep(capT[0], capT[1], lat);
        [r, gC, b] = mixRGB([r, gC, b], [238, 243, 250], iceCap);
        const cloudT = tuning.cloudThreshold;
        const cloudN = fbm3(nx * 3.1 + seed * 13, ny * 3.1 + seed * 13, nz * 3.1 + seed * 13, seed + 13, 4);
        const cloud = smoothstep(cloudT[0], cloudT[1], cloudN);
        [r, gC, b] = mixRGB([r, gC, b], [255, 255, 255], cloud * 0.8);
        const hx = lightDir[0], hy = lightDir[1], hz = lightDir[2] + 1;
        const hlen = Math.hypot(hx, hy, hz) || 1;
        const ndoth = Math.max(0, (nx * hx + ny * hy + nz * hz) / hlen);
        const spec = Math.pow(ndoth, tuning.specularPower) * (1 - continent) * (1 - cloud);
        emissive = [spec * 255, spec * 255, spec * 255];
      } else if (kind === 'gas') {
        const warp = (noise3(nx * tuning.warpFreq + seed, ny * tuning.warpFreq + seed, nz * tuning.warpFreq + seed, seed + 11) - 0.5) * tuning.warpAmount;
        const n = fbm3((nx + warp) * 1.2, (ny + warp * 0.6) * tuning.bandFreq, (nz - warp) * 1.2, seed, 4);
        const bt = tuning.bandThreshold;
        const t = smoothstep(bt[0], bt[1], n);
        [r, gC, b] = mixRGB(plo, phi, t);
        [r, gC, b] = mixRGB([r, gC, b], pbase, 0.25);
        const sx = nx - 0.25, sy = ny + 0.1;
        const spot = smoothstep(0.16, 0.08, Math.hypot(sx, sy * 1.8));
        [r, gC, b] = mixRGB([r, gC, b], plo, spot * 0.6);
      } else if (kind === 'ice') {
        const [f1, f2] = worleyF1F2(nx * tuning.crackFreq + seed, ny * tuning.crackFreq + seed, nz * tuning.crackFreq + seed, seed + 3);
        const crack = smoothstep(tuning.crackWidth, 0.0, f2 - f1);
        [r, gC, b] = mixRGB(pbase, phi, crack);
      } else if (kind === 'volcanic') {
        const crust = fbm3(nx * 2.6 + seed, ny * 2.6 + seed, nz * 2.6 + seed, seed, 4);
        [r, gC, b] = mixRGB(plo, pbase, smoothstep(0.3, 0.7, crust));
        const [f1, f2] = worleyF1F2(nx * tuning.veinFreq + seed, ny * tuning.veinFreq + seed, nz * tuning.veinFreq + seed, seed + 3);
        const vein = smoothstep(tuning.veinWidth, 0.0, f2 - f1);
        const hot = smoothstep(tuning.hotWidth, 0.0, f2 - f1);
        emissive = mixRGB(mixRGB([0, 0, 0], [255, 130, 20], vein), [255, 220, 90], hot);
      } else {
        // rocky (also the only kind reaching this branch now — ice/volcanic have their own above).
        const ct = tuning.continentThreshold || PAINTER_TUNING.rocky.continentThreshold;
        const land = fbm3(nx * 2.1 + seed, ny * 2.1 + seed, nz * 2.1 + seed, seed, 4);
        const continent = smoothstep(ct[0], ct[1], land);
        [r, gC, b] = mixRGB(plo, pbase, continent);
        const craterFreq = tuning.craterFreq || PAINTER_TUNING.rocky.craterFreq;
        const wd = worleyF1(nx * craterFreq + seed, ny * craterFreq + seed, nz * craterFreq + seed, seed + 5);
        const rb = tuning.rimBand || PAINTER_TUNING.rocky.rimBand, fb = tuning.floorBand || PAINTER_TUNING.rocky.floorBand;
        const rim = smoothstep(rb[0], rb[1], wd), floor = smoothstep(fb[0], fb[1], wd);
        [r, gC, b] = mixRGB([r, gC, b], phi, rim * 0.4);
        [r, gC, b] = mixRGB([r, gC, b], plo, floor * 0.7);
      }

      const diffuse = Math.max(0, nx * lightDir[0] + ny * lightDir[1] + nz * lightDir[2]);
      const ambient = kind === 'volcanic' ? tuning.ambient : 0.22;
      const shade = ambient + (1 - ambient) * diffuse;
      const limb = 0.55 + 0.45 * Math.pow(nz, 0.6);
      const k = shade * limb;

      let rimGlow = [0, 0, 0];
      if (atmo) {
        const fres = Math.pow(1 - nz, 4) * Math.max(0.15, diffuse);
        rimGlow = [atmo[0] * fres * 0.7, atmo[1] * fres * 0.7, atmo[2] * fres * 0.7];
      }

      const idx = (py * bw + px) * 4;
      data[idx] = clamp8(r * k + emissive[0] + rimGlow[0]);
      data[idx + 1] = clamp8(gC * k + emissive[1] + rimGlow[1]);
      data[idx + 2] = clamp8(b * k + emissive[2] + rimGlow[2]);
      data[idx + 3] = 255;
    }
  }
  g.putImageData(img, bx0, by0);

  // Front half of the ring, drawn on top of the now-finished disc.
  if (body.rings) paintRings(g, cx, cy, R, S, body, Math.PI, Math.PI * 2);
  return markTex(new THREE.CanvasTexture(cv));
}

// A soft shaded sphere (moon/rocky planet) with optional bands/rings/glow.
function paintBodySimple(body) {
  const S = 256;
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d');
  // Keep the disc small enough that the glow + rings fade out before the canvas edge —
  // otherwise the radial gradients clip to the square and show a hard rectangular halo.
  const cx = S / 2, cy = S / 2, R = S * 0.26;
  // atmospheric glow
  if (body.glow) paintGlow(g, cx, cy, R, S, body);
  // Back half of the ring, drawn before the disc so its opaque fill occludes it.
  if (body.rings) paintRings(g, cx, cy, R, S, body, 0, Math.PI);
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
  // Front half of the ring, drawn on top of the now-finished disc.
  if (body.rings) paintRings(g, cx, cy, R, S, body, Math.PI, Math.PI * 2);
  return markTex(new THREE.CanvasTexture(cv));
}

export function createCelestialBodies(bodyData) {
  const group = new THREE.Group();
  for (const body of bodyData) {
    const tex = body.detail === 'high' ? paintBodyHD(body) : paintBodySimple(body);
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
