// Robust Canvas-2D charting toolkit for the creature stats panel: framed plots with
// margins, nice-rounded gridline ticks, axis titles, legends, colorbars, and a
// regression-capable scatter. Tuned for the dark workshop UI. Depends only on
// niceTicks (pure) from stats-math.js; all rendering is self-contained.
import { niceTicks } from './stats-math.js';

// Distinct categorical palette (bright mid-tones that read on a dark panel).
export const CAT_PALETTE = ['#5b9df0', '#5ecb9e', '#f2c14e', '#ef8a5b', '#e0607e', '#a175d6', '#4ec9c9', '#b6c454'];
const AXIS = 'rgba(255,255,255,0.28)';
const GRID = 'rgba(255,255,255,0.08)';
const TEXT = 'rgba(255,255,255,0.62)';
const TEXT_DIM = 'rgba(255,255,255,0.42)';
const FONT = '10px system-ui, sans-serif';

// Sequential magnitude ramp (dark-blue -> cyan -> yellow -> orange-red) for t in [0,1].
const RAMP_STOPS = [[44, 62, 136], [59, 143, 181], [99, 201, 160], [232, 213, 78], [232, 104, 74]];
export function rampColor(t) {
  const c = Math.max(0, Math.min(1, isFinite(t) ? t : 0));
  const s = c * (RAMP_STOPS.length - 1);
  const i = Math.min(RAMP_STOPS.length - 2, Math.floor(s));
  const f = s - i, a = RAMP_STOPS[i], b = RAMP_STOPS[i + 1];
  const mix = j => Math.round(a[j] + (b[j] - a[j]) * f);
  return `rgb(${mix(0)},${mix(1)},${mix(2)})`;
}
export function catColorFor(cat, categories) {
  if (!cat) return 'rgba(220,225,235,0.5)';
  const i = categories.indexOf(cat);
  return CAT_PALETTE[(i < 0 ? 0 : i) % CAT_PALETTE.length];
}

function fmtNum(v, step) {
  if (v === 0) return '0';
  const decimals = step != null ? Math.max(0, Math.min(3, Math.ceil(-Math.log10(step)) + (step < 1 ? 0 : 0))) : 2;
  const a = Math.abs(v);
  if (step == null) { if (a >= 100) return v.toFixed(0); if (a >= 1) return v.toFixed(1); return v.toFixed(2); }
  return v.toFixed(decimals);
}

// Set up a DPI-correct canvas and return the drawing context + inner plot rect.
function frame(canvas, m = {}) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const padL = m.padL ?? 44, padR = m.padR ?? 14, padT = m.padT ?? 12, padB = m.padB ?? 32;
  return { ctx, w, h, x0: padL, y0: padT, x1: w - padR, y1: h - padB };
}
function emptyNote(ctx, w, h, text) {
  ctx.fillStyle = TEXT_DIM; ctx.font = FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);
}

// Draw x/y gridlines + ticks + axis titles for a numeric plot.
function drawFrame(fr, xd, yd, xLabel, yLabel) {
  const { ctx, x0, y0, x1, y1 } = fr;
  ctx.font = FONT; ctx.textBaseline = 'middle';
  // y gridlines + labels
  ctx.textAlign = 'right';
  for (const t of yd.ticks) {
    if (t < yd.niceMin - 1e-9 || t > yd.niceMax + 1e-9) continue;
    const y = y1 - (t - yd.niceMin) / (yd.niceMax - yd.niceMin) * (y1 - y0);
    ctx.strokeStyle = GRID; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
    ctx.fillStyle = TEXT; ctx.fillText(fmtNum(t, yd.step), x0 - 6, y);
  }
  // x gridlines + labels
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const t of xd.ticks) {
    if (t < xd.niceMin - 1e-9 || t > xd.niceMax + 1e-9) continue;
    const x = x0 + (t - xd.niceMin) / (xd.niceMax - xd.niceMin) * (x1 - x0);
    ctx.strokeStyle = GRID; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    ctx.fillStyle = TEXT; ctx.fillText(fmtNum(t, xd.step), x, y1 + 5);
  }
  // axes
  ctx.strokeStyle = AXIS; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0, y1); ctx.lineTo(x1, y1); ctx.stroke();
  // titles
  ctx.fillStyle = TEXT; ctx.textBaseline = 'alphabetic';
  if (xLabel) { ctx.textAlign = 'center'; ctx.fillText(xLabel, (x0 + x1) / 2, fr.h - 4); }
  if (yLabel) {
    ctx.save(); ctx.translate(11, (y0 + y1) / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.fillText(yLabel, 0, 0); ctx.restore();
  }
}
function drawLegend(ctx, x, y, entries) {
  ctx.font = FONT; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  entries.forEach((e, i) => {
    const yy = y + i * 14;
    ctx.fillStyle = e.color; ctx.fillRect(x, yy - 4, 9, 9);
    ctx.fillStyle = TEXT; ctx.fillText(e.label, x + 13, yy);
  });
}
function drawColorbar(ctx, x, y, w, h, min, max, label) {
  const steps = 24;
  for (let i = 0; i < steps; i++) {
    ctx.fillStyle = rampColor(i / (steps - 1));
    ctx.fillRect(x, y + h - (i + 1) / steps * h, w, h / steps + 1);
  }
  ctx.strokeStyle = AXIS; ctx.lineWidth = 1; ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = TEXT; ctx.font = FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(fmtNum(max), x + w + 4, y + 3);
  ctx.fillText(fmtNum(min), x + w + 4, y + h - 3);
  if (label) { ctx.save(); ctx.translate(x + w + 22, y + h / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(label, 0, 0); ctx.restore(); }
}

// Scatter with numeric X/Y axes. opts: { points:[{x,y,color,label}], xLabel, yLabel,
// regression:{slope,intercept}, annotations:[str], legend:[{label,color}], colorbar:{min,max,label} }
export function scatterPlot(canvas, opts) {
  const pts = opts.points || [];
  const padR = opts.colorbar ? 60 : (opts.legend ? 96 : 14);
  const fr = frame(canvas, { padR });
  const { ctx, w, h, x0, y0, x1, y1 } = fr;
  if (pts.length < 1) { emptyNote(ctx, w, h, opts.empty || 'No data'); return; }
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const xd = niceTicks(Math.min(...xs), Math.max(...xs), 5);
  const yd = niceTicks(Math.min(...ys), Math.max(...ys), 5);
  const sx = v => x0 + (v - xd.niceMin) / (xd.niceMax - xd.niceMin) * (x1 - x0);
  const sy = v => y1 - (v - yd.niceMin) / (yd.niceMax - yd.niceMin) * (y1 - y0);
  drawFrame(fr, xd, yd, opts.xLabel, opts.yLabel);
  // regression line, clipped to plot
  if (opts.regression && isFinite(opts.regression.slope)) {
    const { slope, intercept } = opts.regression;
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(sx(xd.niceMin), sy(slope * xd.niceMin + intercept));
    ctx.lineTo(sx(xd.niceMax), sy(slope * xd.niceMax + intercept)); ctx.stroke(); ctx.setLineDash([]);
  }
  // points
  for (const p of pts) {
    ctx.fillStyle = p.color || '#5b9df0';
    ctx.beginPath(); ctx.arc(sx(p.x), sy(p.y), 4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.stroke();
  }
  if (pts.length <= 20) {
    ctx.fillStyle = TEXT_DIM; ctx.font = FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    for (const p of pts) if (p.label) ctx.fillText(p.label, sx(p.x) + 6, sy(p.y) - 3);
  }
  // annotations (top-left inside plot)
  if (opts.annotations) {
    ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.font = FONT;
    opts.annotations.forEach((s, i) => {
      const ty = y0 + 3 + i * 13;
      ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(x0 + 3, ty - 1, ctx.measureText(s).width + 6, 12);
      ctx.fillStyle = '#e8ecf2'; ctx.fillText(s, x0 + 6, ty);
    });
  }
  if (opts.legend) drawLegend(ctx, x1 + 12, y0 + 6, opts.legend);
  if (opts.colorbar) drawColorbar(ctx, x1 + 12, y0, 10, y1 - y0, opts.colorbar.min, opts.colorbar.max, opts.colorbar.label);
}

// Vertical bar chart. items:[{label,value,color?,n?,spread?}], yLabel. Optional per-bar
// spread (error whisker) and n annotation for grouped-mean use.
export function barPlot(canvas, opts) {
  const items = opts.items || [];
  const fr = frame(canvas, { padB: 40 });
  const { ctx, w, h, x0, y0, x1, y1 } = fr;
  if (!items.length) { emptyNote(ctx, w, h, opts.empty || 'No data'); return; }
  const vals = items.map(i => i.value);
  const spreads = items.map(i => i.spread || 0);
  const top = Math.max(...vals.map((v, i) => v + spreads[i]), 0);
  const bot = Math.min(...vals.map((v, i) => v - spreads[i]), 0);
  const yd = niceTicks(bot, top, 5);
  const sy = v => y1 - (v - yd.niceMin) / (yd.niceMax - yd.niceMin) * (y1 - y0);
  drawFrame({ ...fr, y1 }, { ticks: [], niceMin: 0, niceMax: 1, step: 1 }, yd, null, opts.yLabel);
  const n = items.length, slot = (x1 - x0) / n, bw = Math.min(46, slot * 0.66);
  ctx.font = FONT;
  items.forEach((it, i) => {
    const cx = x0 + slot * (i + 0.5);
    const yv = sy(it.value), y0b = sy(0);
    ctx.fillStyle = it.color || '#5b9df0';
    ctx.fillRect(cx - bw / 2, Math.min(yv, y0b), bw, Math.abs(yv - y0b));
    if (it.spread) { // error whisker
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(cx, sy(it.value - it.spread)); ctx.lineTo(cx, sy(it.value + it.spread));
      ctx.moveTo(cx - 4, sy(it.value + it.spread)); ctx.lineTo(cx + 4, sy(it.value + it.spread));
      ctx.moveTo(cx - 4, sy(it.value - it.spread)); ctx.lineTo(cx + 4, sy(it.value - it.spread)); ctx.stroke();
    }
    ctx.fillStyle = TEXT; ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom'; ctx.fillText(fmtNum(it.value, yd.step), cx, Math.min(yv, y0b) - 3);
    // x label (wrap/rotate if crowded)
    ctx.fillStyle = TEXT; ctx.textBaseline = 'top';
    const lbl = it.label + (it.n != null ? ` (n=${it.n})` : '');
    if (slot < 54 && lbl.length > 6) { ctx.save(); ctx.translate(cx, y1 + 4); ctx.rotate(-Math.PI / 5); ctx.textAlign = 'right'; ctx.fillText(lbl, 0, 0); ctx.restore(); }
    else ctx.fillText(lbl, cx, y1 + 5);
  });
}

// Histogram of raw values into `bins`. opts: { values, bins, xLabel }.
export function histPlot(canvas, opts) {
  const values = opts.values || [], bins = opts.bins || 10;
  const fr = frame(canvas, {});
  const { ctx, w, h, x0, y0, x1, y1 } = fr;
  if (values.length < 1) { emptyNote(ctx, w, h, opts.empty || 'No data'); return; }
  const min = Math.min(...values), max = Math.max(...values), span = (max - min) || 1;
  const counts = new Array(bins).fill(0);
  for (const v of values) { let b = Math.floor((v - min) / span * bins); if (b >= bins) b = bins - 1; if (b < 0) b = 0; counts[b]++; }
  const cd = niceTicks(0, Math.max(...counts), 4);
  const xd = niceTicks(min, max, 5);
  const sx = v => x0 + (v - xd.niceMin) / (xd.niceMax - xd.niceMin) * (x1 - x0);
  const sy = c => y1 - (c - cd.niceMin) / (cd.niceMax - cd.niceMin) * (y1 - y0);
  drawFrame(fr, xd, cd, opts.xLabel, 'count');
  const bwPx = (x1 - x0) / bins;
  counts.forEach((c, i) => {
    const bx = x0 + (min + (i / bins) * span - xd.niceMin) / (xd.niceMax - xd.niceMin) * (x1 - x0);
    ctx.fillStyle = '#5ecb9e';
    ctx.fillRect(bx + 1, sy(c), Math.max(1, bwPx - 2), y1 - sy(c));
  });
}

// Simple time-series line for the live trace. opts: { samples, yLabel, color }.
export function linePlot(canvas, opts) {
  const s = opts.samples || [];
  const fr = frame(canvas, { padL: 44, padB: 18 });
  const { ctx, w, h, x0, y0, x1, y1 } = fr;
  if (s.length < 2) { emptyNote(ctx, w, h, opts.empty || 'Select a creature'); return; }
  const yd = niceTicks(Math.min(...s), Math.max(...s), 4);
  const sy = v => y1 - (v - yd.niceMin) / (yd.niceMax - yd.niceMin) * (y1 - y0);
  drawFrame(fr, { ticks: [], niceMin: 0, niceMax: 1, step: 1 }, yd, null, opts.yLabel);
  ctx.strokeStyle = opts.color || '#5ecb9e'; ctx.lineWidth = 1.5; ctx.beginPath();
  s.forEach((v, i) => { const x = x0 + (i / (s.length - 1)) * (x1 - x0); const y = sy(v); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
}
