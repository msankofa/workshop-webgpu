// flight-hud.js — the green head-up display the flight sim draws, as a module any page with a 2D
// canvas can call. Two pictures: `drawFlightHud` for something you are flying (pitch ladder, flight
// path marker, speed and height tapes, heading, throttle) and `drawSensorHud` for a sensor or
// seeker looking at a point on the ground (crosshair, blast ring, range and time of flight).
//
// It knows nothing about THREE or about any particular aircraft. The caller passes vectors as plain
// arrays and one `project(x, y, z)` that turns a world point into canvas pixels, so the same code
// draws over a WebGPU scene, over a WebGL one, or over nothing at all in a test.

export const HUD_GREEN = 'rgba(126,240,160,0.92)';
export const HUD_RED = 'rgba(255,110,110,0.92)';
export const HUD_FONT = '11px ui-monospace, SFMono-Regular, Menlo, monospace';

const DEG = 180 / Math.PI;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const len = (v) => Math.hypot(v[0], v[1], v[2]);

// Pixels per radian at this field of view. Every angular thing on the display is placed with it.
export function pixelsPerRadian(height, fovDeg) {
  return (height * 0.5) / Math.tan((fovDeg / DEG) * 0.5);
}

// The pitch ladder and the marker both hang off the boresight, so a camera that is not looking down
// the nose (the chase view, which trails behind a turn) still draws a true horizon.
function boresightFrame(s, w, h) {
  const p = s.position, f = s.forward, u = s.up;
  const far = [p[0] + f[0] * 9000, p[1] + f[1] * 9000, p[2] + f[2] * 9000];
  const bs = s.project(far[0], far[1], far[2]);
  const upRef = s.project(far[0] + u[0] * 900, far[1] + u[1] * 900, far[2] + u[2] * 900);
  const phi = Math.atan2(upRef.x - bs.x, -(upRef.y - bs.y));
  return {
    bs, phi,
    uHat: { x: Math.sin(phi), y: -Math.cos(phi) },
    rHat: { x: Math.cos(phi), y: Math.sin(phi) },
    pxPerRad: pixelsPerRadian(h, s.fovDeg),
    pitch: Math.asin(clamp(f[1], -1, 1)),
  };
}

function tape(ctx, x, y, value, label) {
  ctx.save();
  ctx.strokeRect(x - 42, y - 11, 84, 22);
  ctx.textAlign = 'center';
  ctx.fillText(value.toFixed(Math.abs(value) > 999 ? 0 : 1), x, y);
  ctx.globalAlpha = 0.6;
  ctx.fillText(label, x, y - 22);
  ctx.globalAlpha = 1;
  ctx.restore();
}

// `state`: { position, forward, up, velocity (all [x,y,z] world), fovDeg, project(x,y,z),
//            agl, throttle, boost, label, warnings: [string], color }
export function drawFlightHud(ctx, w, h, state) {
  const s = state;
  const color = s.color || HUD_GREEN;
  const speed = len(s.velocity || [0, 0, 0]);
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.4;
  ctx.font = HUD_FONT;
  ctx.textBaseline = 'middle';

  const fr = boresightFrame(s, w, h);
  const { bs, uHat, rHat, pxPerRad, phi } = fr;

  // Pitch ladder. Below the horizon is dashed, as every HUD does it, so which way is up survives
  // a view with no ground texture in it.
  ctx.globalAlpha = 0.9;
  for (let deg = -90; !bs.behind && deg <= 90; deg += 5) {
    // The line for `deg` sits (deg - pitch) radians ABOVE the boresight, and uHat points up the
    // screen, so the offset is added along uHat with that sign. Writing it the other way round
    // draws the whole ladder mirrored about the boresight: level flight still looks right, which is
    // why the sim carried it for a long time, but a climb puts the horizon above the nose.
    const off = (deg / DEG - fr.pitch) * pxPerRad;
    if (Math.abs(off) > h * 0.62) continue;
    const cx = bs.x + uHat.x * off, cy = bs.y + uHat.y * off;
    if (cx < -w || cx > 2 * w) continue;
    const wide = deg === 0 ? 190 : 74;
    const gap = deg === 0 ? 26 : 20;
    ctx.setLineDash(deg < 0 ? [7, 6] : []);
    ctx.beginPath();
    ctx.moveTo(cx - rHat.x * wide, cy - rHat.y * wide);
    ctx.lineTo(cx - rHat.x * gap, cy - rHat.y * gap);
    ctx.moveTo(cx + rHat.x * gap, cy + rHat.y * gap);
    ctx.lineTo(cx + rHat.x * wide, cy + rHat.y * wide);
    ctx.stroke();
    ctx.setLineDash([]);
    if (deg !== 0 && deg % 10 === 0) {
      ctx.save();
      ctx.translate(cx + rHat.x * (wide + 12), cy + rHat.y * (wide + 12));
      ctx.rotate(phi);
      ctx.fillText(String(deg), -6, 0);
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;

  // Flight path marker: where the craft is actually going, which is the whole point of the display.
  if (speed > 1) {
    const v = s.velocity, p = s.position, k = 9000 / speed;
    const fpm = s.project(p[0] + v[0] * k, p[1] + v[1] * k, p[2] + v[2] * k);
    if (!fpm.behind) {
      ctx.beginPath();
      ctx.arc(fpm.x, fpm.y, 7, 0, Math.PI * 2);
      ctx.moveTo(fpm.x - 7, fpm.y); ctx.lineTo(fpm.x - 17, fpm.y);
      ctx.moveTo(fpm.x + 7, fpm.y); ctx.lineTo(fpm.x + 17, fpm.y);
      ctx.moveTo(fpm.x, fpm.y - 7); ctx.lineTo(fpm.x, fpm.y - 14);
      ctx.stroke();
    }
  }

  // Boresight cross
  ctx.globalAlpha = 0.55;
  ctx.beginPath();
  ctx.moveTo(w / 2 - 9, h / 2); ctx.lineTo(w / 2 + 9, h / 2);
  ctx.moveTo(w / 2, h / 2 - 9); ctx.lineTo(w / 2, h / 2 + 9);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Tapes: speed on the left, height on the right, as in the sim.
  const cy = h / 2;
  tape(ctx, 74, cy, speed, 'M/S');
  tape(ctx, w - 74, cy, s.position[1], 'ALT M');
  ctx.textAlign = 'left';
  if (Number.isFinite(s.agl)) ctx.fillText(`AGL ${Math.round(s.agl)}`, w - 116, cy + 44);
  ctx.fillText(`VS ${s.velocity[1] >= 0 ? '+' : ''}${s.velocity[1].toFixed(1)}`, w - 116, cy + 60);
  ctx.fillText(`${(speed * 3.6).toFixed(0)} KM/H`, 34, cy + 44);

  // Heading tape
  const hdg = ((Math.atan2(-s.forward[0], -s.forward[2]) * DEG) + 360) % 360;
  ctx.textAlign = 'center';
  ctx.strokeRect(w / 2 - 32, 22, 64, 18);
  ctx.fillText(hdg.toFixed(0).padStart(3, '0'), w / 2, 31);
  for (let d = -60; d <= 60; d += 10) {
    const t = ((hdg + d) % 360 + 360) % 360;
    const x = w / 2 + d * 2.6;
    ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.moveTo(x, 48); ctx.lineTo(x, 54); ctx.stroke();
    ctx.fillText(t.toFixed(0), x, 63);
    ctx.globalAlpha = 1;
  }

  // Bottom block: throttle bar, then whatever the caller wants named.
  ctx.textAlign = 'left';
  const bx = 34, by = h - 96;
  if (Number.isFinite(s.throttle)) {
    ctx.fillText(`THR ${(s.throttle * 100).toFixed(0)}%${s.boost ? '  AB' : ''}`, bx, by);
    ctx.strokeRect(bx, by + 10, 110, 8);
    ctx.fillRect(bx, by + 10, 110 * clamp(s.throttle, 0, 1), 8);
  }
  if (s.label) ctx.fillText(s.label, bx, by + 34);

  drawWarnings(ctx, w, h, s.warnings);
  ctx.restore();
}

// The sensor picture: a crosshair on the middle of the screen, because the camera looks straight
// down the aim and the aim's ground point IS the middle of the screen. Nothing to project.
//
// `state`: { range, timeToGo, blastRadius, fovDeg, valid, label, lines: [string], warnings, color }
export function drawSensorHud(ctx, w, h, state) {
  const s = state;
  const cx = w / 2, cy = h / 2;
  const color = s.color || (s.valid === false ? 'rgba(200,200,200,0.8)' : HUD_GREEN);
  ctx.save();
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.5;
  ctx.font = HUD_FONT;
  ctx.textBaseline = 'middle';

  ctx.beginPath();
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    ctx.moveTo(cx + dx * 14, cy + dy * 14);
    ctx.lineTo(cx + dx * 60, cy + dy * 60);
  }
  ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();

  // What the warhead covers, at this range: a dashed ring the size of the blast on the picture.
  if (s.blastRadius > 0 && s.range > 1) {
    const r = Math.min(w, (s.blastRadius / s.range) * pixelsPerRadian(h, s.fovDeg));
    ctx.setLineDash([4, 6]);
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }

  // Corner blocks
  ctx.textAlign = 'left';
  let y = 34;
  if (s.label) { ctx.font = 'bold 12px ui-monospace, monospace'; ctx.fillText(s.label, 30, y); ctx.font = HUD_FONT; y += 20; }
  if (Number.isFinite(s.range)) { ctx.fillText(`RNG ${(s.range / 1000).toFixed(2)} KM`, 30, y); y += 16; }
  if (Number.isFinite(s.timeToGo)) { ctx.fillText(`TOF ${s.timeToGo.toFixed(1)} S`, 30, y); y += 16; }
  for (const line of s.lines || []) { ctx.fillText(line, 30, y); y += 16; }
  if (Number.isFinite(s.fovDeg)) { ctx.textAlign = 'right'; ctx.fillText(`FOV ${Math.round(s.fovDeg)}°`, w - 30, 34); }

  drawWarnings(ctx, w, h, s.warnings);
  ctx.restore();
}

// Blinking, because a warning that does not move is furniture after ten seconds.
function drawWarnings(ctx, w, h, warnings) {
  if (!warnings || !warnings.length) return;
  const blink = ((Date.now() / 260) | 0) % 2 === 0;
  if (!blink) return;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.font = 'bold 15px ui-monospace, monospace';
  ctx.fillStyle = HUD_RED;
  let y = h * 0.32;
  for (const text of warnings) { ctx.fillText(text, w / 2, y); y += 22; }
  ctx.restore();
}
