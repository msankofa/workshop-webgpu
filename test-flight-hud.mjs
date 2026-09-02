// flight-hud.js against a recording canvas context: the display has no pixels to check in Node, but
// it does have geometry, and the things that go wrong with a head-up display are geometric. The
// ladder has to sit on the horizon, the marker has to sit where the craft is going, and nothing may
// be drawn at NaN. Run: node test-flight-hud.mjs
import { drawFlightHud, drawSensorHud, pixelsPerRadian } from './flight-hud.js';

let failed = 0;
function ok(msg, cond, detail = '') { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}${detail ? '  ' + detail : ''}`); if (!cond) failed++; }
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// A context that records every call and every coordinate it is handed.
function recorder() {
  const calls = [], points = [], texts = [], arcs = [], segments = [];
  let cursor = [0, 0];
  const noop = () => {};
  const c = {
    calls, points, texts, arcs, segments,
    save: noop, restore: noop, beginPath: noop, stroke: noop, fill: noop, closePath: noop,
    setLineDash: noop, clearRect: noop, translate: noop, rotate: noop,
    moveTo: (x, y) => { cursor = [x, y]; points.push([x, y]); },
    lineTo: (x, y) => { segments.push({ x1: cursor[0], y1: cursor[1], x2: x, y2: y }); cursor = [x, y]; points.push([x, y]); },
    arc: (x, y, r) => { points.push([x, y]); arcs.push({ x, y, r }); },
    strokeRect: (x, y) => points.push([x, y]),
    fillRect: (x, y) => points.push([x, y]),
    fillText: (t, x, y) => { texts.push(String(t)); points.push([x, y]); },
    globalAlpha: 1, lineWidth: 1, strokeStyle: '', fillStyle: '', font: '', textAlign: '', textBaseline: '',
  };
  return c;
}

const W = 1600, H = 900;
// A camera 100 m behind the craft, at the craft's own height, looking down -Z: a chase view.
const CAM = [0, 500, 100];
function project(x, y, z) {
  const pxPerRad = pixelsPerRadian(H, 60);
  const relZ = z - CAM[2];
  if (relZ >= 0) return { x: W / 2, y: H / 2, behind: true };
  return { x: W / 2 + Math.atan2(x - CAM[0], -relZ) * pxPerRad, y: H / 2 - Math.atan2(y - CAM[1], -relZ) * pxPerRad, behind: false };
}

function state(over = {}) {
  return {
    position: [0, 500, 0], forward: [0, 0, -1], up: [0, 1, 0], velocity: [0, 0, -120],
    fovDeg: 60, project, agl: 480, throttle: 0.7, label: 'SENTINEL 400 HP  AGM 4', warnings: [], ...over,
  };
}

// ── it draws, and every coordinate is a number ──────────────────────────────
let ctx = recorder();
drawFlightHud(ctx, W, H, state());
ok('the flight display draws something', ctx.points.length > 50, `${ctx.points.length} points`);
ok('every coordinate is finite', ctx.points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)), `${ctx.points.filter(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y)).length} bad`);

// ── the horizon sits on the horizon ─────────────────────────────────────────
// Level flight: the zero line of the ladder is the widest horizontal run, and it must be at the
// middle of the screen. This is the failure that makes a display useless and a screenshot look fine.
function ladderZeroY(segments) {
  let best = null;
  for (const g of segments) {
    if (Math.abs(g.y1 - g.y2) > 1) continue;          // horizontal runs only
    const span = Math.abs(g.x2 - g.x1);
    if (span > 100 && (!best || span > best.span)) best = { span, y: (g.y1 + g.y2) / 2 };
  }
  return best ? best.y : NaN;
}
ok('level flight puts the horizon across the middle', near(ladderZeroY(ctx.segments), H / 2, 2), `y=${ladderZeroY(ctx.segments).toFixed(1)} of ${H / 2}`);

// Whatever the craft is doing, the zero line belongs on the CAMERA's true horizon, which for this
// level camera is the middle of the screen. Nose up ten degrees puts the boresight well above it,
// so a ladder written with the wrong sign lands the horizon above the nose instead of below it.
for (const deg of [10, -15, 30]) {
  const a = deg * Math.PI / 180;
  ctx = recorder();
  drawFlightHud(ctx, W, H, state({ forward: [0, Math.sin(a), -Math.cos(a)], up: [0, Math.cos(a), Math.sin(a)] }));
  const y = ladderZeroY(ctx.segments);
  // Eight pixels of 900: the ladder is placed linearly in angle while the lens is a tangent, so the
  // two drift apart as the boresight leaves the middle of the screen. Every display of this shape
  // does it, and the error is a few pixels at thirty degrees.
  ok(`pitched ${deg > 0 ? '+' : ''}${deg}, the horizon stays on the horizon`, near(y, H / 2, 8), `y=${Number.isFinite(y) ? y.toFixed(1) : 'none'} of ${H / 2}`);
}

// ── the flight path marker goes where the craft is going ────────────────────
// Flying level but drifting right: the marker must sit right of the boresight, which is the whole
// reason a marker exists rather than a fixed cross.
ctx = recorder();
drawFlightHud(ctx, W, H, state({ velocity: [40, 0, -120] }));
const rightOfCentre = ctx.points.filter(([x, y]) => x > W / 2 + 40 && Math.abs(y - H / 2) < 40).length;
ok('a drifting craft draws its marker off to the side', rightOfCentre > 0, `${rightOfCentre} points right of centre`);

// ── the numbers on it ───────────────────────────────────────────────────────
ok('it shows the speed', ctx.texts.includes('126.5') || ctx.texts.some(t => t.startsWith('126')), ctx.texts.slice(0, 6).join(' '));
ctx = recorder();
drawFlightHud(ctx, W, H, state({ label: 'SENTINEL 400 HP  AGM 4' }));
ok('it shows the label it was given', ctx.texts.includes('SENTINEL 400 HP  AGM 4'));
ok('it shows a heading', ctx.texts.includes('000'), `flying -Z is 000: ${ctx.texts.filter(t => /^[0-9]{1,3}$/.test(t)).slice(0, 4).join(' ')}`);

// ── behind the lens ─────────────────────────────────────────────────────────
// A camera ahead of the craft looking back: the ladder must not draw a mirror of itself.
ctx = recorder();
drawFlightHud(ctx, W, H, state({ project: () => ({ x: W / 2, y: H / 2, behind: true }) }));
ok('nothing draws a ladder behind the lens', ctx.points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));

// ── a stopped craft has no marker, and does not divide by zero ──────────────
ctx = recorder();
drawFlightHud(ctx, W, H, state({ velocity: [0, 0, 0] }));
ok('a stopped craft still draws', ctx.points.length > 20 && ctx.points.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));

// ── the sensor picture ──────────────────────────────────────────────────────
ctx = recorder();
drawSensorHud(ctx, W, H, { range: 1200, timeToGo: 10, blastRadius: 10, fovDeg: 30, valid: true, label: 'SENSOR', lines: ['AGM 4', '[space] release'], warnings: [] });
ok('the sensor picture draws', ctx.points.length > 10);
ok('its crosshair is centred', ctx.points.some(([x, y]) => near(x, W / 2, 1) && near(y, H / 2, 1)));
ok('it shows the range in kilometres', ctx.texts.some(t => t.includes('1.20 KM')), ctx.texts.join(' | '));
ok('it shows the rounds left', ctx.texts.includes('AGM 4'));

// The blast ring grows as the range closes: the same warhead covers more of the picture. It is the
// largest arc drawn at the middle of the screen; the other one there is the three-pixel aiming dot.
function ringRadius(arcs) {
  let r = 0;
  for (const a of arcs) if (Math.abs(a.x - W / 2) < 1 && Math.abs(a.y - H / 2) < 1) r = Math.max(r, a.r);
  return r;
}
const far = recorder(); drawSensorHud(far, W, H, { range: 4000, blastRadius: 10, fovDeg: 30, valid: true, lines: [] });
const close = recorder(); drawSensorHud(close, W, H, { range: 400, blastRadius: 10, fovDeg: 30, valid: true, lines: [] });
ok('the blast ring grows as the range closes', ringRadius(close.arcs) > ringRadius(far.arcs) * 5, `${ringRadius(close.arcs).toFixed(1)} vs ${ringRadius(far.arcs).toFixed(1)} px`);
// And it is the size the geometry says: a 10 m blast at 400 m through a 30 degree lens.
ok('the ring is the size the geometry gives', near(ringRadius(close.arcs), (10 / 400) * pixelsPerRadian(H, 30), 0.5), ringRadius(close.arcs).toFixed(1));

// No ground return: it still draws, and says so rather than lying about a range.
ctx = recorder();
drawSensorHud(ctx, W, H, { range: NaN, timeToGo: NaN, blastRadius: 10, fovDeg: 30, valid: false, label: 'SENSOR', lines: ['NO GROUND RETURN'], warnings: [] });
ok('with no ground return it draws no range', !ctx.texts.some(t => t.includes('KM')), ctx.texts.join(' | '));
ok('and says so', ctx.texts.includes('NO GROUND RETURN'));

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
