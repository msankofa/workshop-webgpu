// reticle.js — the aiming reticle, as a DOM overlay over the canvas.
//
// Ported from bot-viewer-v3's POV crosshair: four bars whose gap tracks the live spread cone, a
// centre dot that appears only when the shot is actually legal, and the classic hitmarker X, red
// when the hit was fatal. Two things differ here, and both come from the base game having a
// third-person camera that v3's POV mode does not:
//
//   1. The reticle is POSITIONED, not pinned to screen centre. A round leaves the player's head
//      along the look direction, and in third person the camera sits behind and beside that head,
//      so screen centre is metres from where the shot lands. The page projects the real shot ray's
//      hit point and passes it in.
//   2. The gap is a real angle. `reticleGapPx` converts the cone half-angle through the camera's
//      own vertical FOV, so the bars enclose the ground the rounds can actually reach; a fixed
//      pixel gap would claim the same accuracy at 50 degrees and while scoped.
//
// DOM only: no THREE, no renderer. The geometry is pure and unit-tested in test-reticle.mjs.

export const RETICLE_DEFAULTS = Object.freeze({
  baseGapPx: 5,            // the gap at zero spread, so the centre stays readable
  maxGapPx: 220,           // a cone wider than this is already useless; the bars only get sillier
  barLength: 8,
  barThickness: 2,
  color: 'rgba(255,255,255,0.88)',
  blockedColor: 'rgba(255,180,90,0.85)',   // reloading, swapping or dry: the trigger will do nothing
  deadColor: 'rgba(255,90,90,0.55)',
});

// Cone half-angle -> half-gap in pixels, through the camera's vertical FOV. Clamped, and never
// smaller than the base gap: a perfectly accurate weapon still needs a reticle you can see.
export function reticleGapPx({ halfAngleRad = 0, viewportHeight = 0, fovYDeg = 50,
  baseGapPx = RETICLE_DEFAULTS.baseGapPx, maxGapPx = RETICLE_DEFAULTS.maxGapPx } = {}) {
  const half = Math.max(0, Number(halfAngleRad) || 0);
  const height = Math.max(0, Number(viewportHeight) || 0);
  const fov = Math.max(1, Math.min(179, Number(fovYDeg) || 50));
  if (!(height > 0) || half <= 0) return baseGapPx;
  // Past a quarter turn the tangent stops meaning anything on screen; clamp before it flips sign.
  const clamped = Math.min(half, Math.PI * 0.49);
  const px = (height * 0.5) * Math.tan(clamped) / Math.tan(fov * Math.PI / 360);
  return Math.max(baseGapPx, Math.min(maxGapPx, baseGapPx + px));
}

export function createReticle({ document: doc, mount = null, style = null } = {}) {
  if (!doc?.createElement) throw new TypeError('createReticle needs a document');
  const cfg = { ...RETICLE_DEFAULTS, ...(style || {}) };
  const root = doc.createElement('div');
  root.id = 'reticle';
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:11;display:none';
  const layer = doc.createElement('div');   // moved as a unit, so the bars need no per-frame maths
  layer.style.cssText = 'position:absolute;left:0;top:0;will-change:transform';
  root.appendChild(layer);

  const bars = [];
  for (const dir of ['up', 'down', 'left', 'right']) {
    const bar = doc.createElement('div');
    const vertical = dir === 'up' || dir === 'down';
    bar.style.cssText = 'position:absolute;background:' + cfg.color + ';box-shadow:0 0 2px rgba(0,0,0,.8);'
      + 'width:' + (vertical ? cfg.barThickness : cfg.barLength) + 'px;'
      + 'height:' + (vertical ? cfg.barLength : cfg.barThickness) + 'px';
    layer.appendChild(bar);
    bars.push({ el: bar, dir });
  }
  // Centre dot: a SHAPE cue for "this shot will happen", so ready never rides on hue alone.
  const dot = doc.createElement('div');
  dot.style.cssText = 'position:absolute;left:-2px;top:-2px;width:4px;height:4px;border-radius:50%;'
    + 'background:rgba(255,255,255,.95);box-shadow:0 0 3px rgba(0,0,0,.9);display:none';
  layer.appendChild(dot);
  // Hitmarker: four diagonal strokes forming an X with a centre gap (v3's shape and timing).
  const hitmarker = doc.createElement('div');
  hitmarker.className = 'hitmarker';
  hitmarker.style.cssText = 'position:absolute;left:-15px;top:-15px;width:30px;height:30px;opacity:0';
  for (const stroke of [[3, 3, 45], [16, 3, -45], [3, 16, -45], [16, 16, 45]]) {
    const span = doc.createElement('span');
    span.style.cssText = 'position:absolute;width:3px;height:11px;border-radius:1px;background:#fff;'
      + 'box-shadow:0 0 3px rgba(0,0,0,.9);left:' + stroke[0] + 'px;top:' + stroke[1] + 'px;'
      + 'transform:rotate(' + stroke[2] + 'deg)';
    hitmarker.appendChild(span);
  }
  layer.appendChild(hitmarker);

  const sheet = doc.createElement('style');
  sheet.textContent = [
    '@keyframes reticleHitPop {',
    '  0% { opacity: 1; transform: scale(1.35); }',
    '  70% { opacity: .9; }',
    '  100% { opacity: 0; transform: scale(.9); }',
    '}',
    '#reticle .hit-pop { animation: reticleHitPop .28s ease-out; }',
    '#reticle .hit-kill span { background: #ff4040; }',
    '#reticle .hit-kill.hit-pop { animation-duration: .45s; }',
  ].join('\n');
  (doc.head ?? doc.body ?? mount)?.appendChild(sheet);
  (mount ?? doc.body)?.appendChild(root);

  let shownGap = -1, shownColor = '', shownDot = null, shownX = null, shownY = null, visible = false;

  function setVisible(next) {
    if (visible === !!next) return;
    visible = !!next;
    root.style.display = visible ? 'block' : 'none';
  }

  // x/y in CSS pixels from the top-left of the viewport; gapPx from reticleGapPx.
  function update({ x = 0, y = 0, gapPx = cfg.baseGapPx, ready = true, blocked = false, dead = false } = {}) {
    const px = Math.round(x), py = Math.round(y);
    if (px !== shownX || py !== shownY) {
      shownX = px; shownY = py;
      layer.style.transform = 'translate(' + px + 'px, ' + py + 'px)';
    }
    const color = dead ? cfg.deadColor : blocked ? cfg.blockedColor : cfg.color;
    const gap = Math.round(gapPx);
    if (gap !== shownGap || color !== shownColor) {
      shownGap = gap; shownColor = color;
      const half = cfg.barThickness / 2;
      for (const bar of bars) {
        bar.el.style.background = color;
        if (bar.dir === 'up') { bar.el.style.left = (-half) + 'px'; bar.el.style.top = (-gap - cfg.barLength) + 'px'; }
        else if (bar.dir === 'down') { bar.el.style.left = (-half) + 'px'; bar.el.style.top = gap + 'px'; }
        else if (bar.dir === 'left') { bar.el.style.left = (-gap - cfg.barLength) + 'px'; bar.el.style.top = (-half) + 'px'; }
        else { bar.el.style.left = gap + 'px'; bar.el.style.top = (-half) + 'px'; }
      }
    }
    const wantDot = !!ready && !dead;
    if (wantDot !== shownDot) { shownDot = wantDot; dot.style.display = wantDot ? 'block' : 'none'; }
  }

  function hit({ fatal = false } = {}) {
    hitmarker.classList.remove('hit-pop', 'hit-kill');
    void hitmarker.offsetWidth;   // restart the animation on rapid consecutive hits
    if (fatal) hitmarker.classList.add('hit-kill');
    hitmarker.classList.add('hit-pop');
  }

  function dispose() { root.remove(); sheet.remove(); }

  return { element: root, setVisible, update, hit, dispose, get visible() { return visible; } };
}
