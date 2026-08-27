// scope-overlay.js — the optical sight picture, as a DOM overlay over the canvas.
//
// Ported from environment-viewer.html's updateScopeOverlay. The FOV zoom and the eye dolly that go
// with it already live in the page (they are three lines of trigonometry); this is the part that
// makes a scope read as a scope: a hard black surround with a feathered edge, and an optional blur
// on everything outside the glass.
//
// Two things differ from the original, both about cost. The original rebuilt both gradient strings
// every frame while aiming; here they are rewritten only when the numbers that shape them actually
// change, because a CSS gradient reparse per frame is real work for a picture that holds still.
// And `backdrop-filter` is only attached when a weapon authors blur, since a full-screen backdrop
// filter is one of the more expensive things a browser can be asked to do each frame.
//
// DOM only: no THREE, no renderer. The geometry is pure and unit-tested in test-scope-overlay.mjs.

export const SCOPE_DEFAULTS = Object.freeze({
  minRadiusPx: 20,     // a scope smaller than this is not a sight picture, it is a dot
  featherPx: 24,       // soft edge inside the glass, so the rim is not aliased
  rimPx: 50,           // distance over which the surround reaches near-black
  blackPx: 150,        // ... and then full black
  blurScale: 10,       // weapon.scopeBlur 0..1 -> pixels of peripheral blur
});

// Everything the two gradients need, from the weapon and the viewport. Pure.
export function scopeGeometry(weapon, viewportHeight, settings = SCOPE_DEFAULTS) {
  const height = Math.max(0, Number(viewportHeight) || 0);
  const radius = Math.max(settings.minRadiusPx, (Number(weapon?.scopeRadius) || 0.34) * height);
  const centre = Array.isArray(weapon?.scopeCenter) ? weapon.scopeCenter : [0.5, 0.5];
  const x = Number.isFinite(centre[0]) ? centre[0] : 0.5;
  const y = Number.isFinite(centre[1]) ? centre[1] : 0.5;
  return {
    radius,
    x: x * 100,
    y: y * 100,
    blurPx: Math.max(0, Number(weapon?.scopeBlur) || 0) * settings.blurScale,
  };
}

// True when this weapon should show a sight picture at all. Iron sights zoom; they do not black out
// the world, and drawing a scope ring around a set of iron sights looks like a bug.
export function hasOpticalSight(weapon) {
  return weapon?.sightType === 'optical';
}

export function createScopeOverlay({ document: doc, mount = null, settings = null } = {}) {
  if (!doc?.createElement) throw new TypeError('createScopeOverlay needs a document');
  const cfg = { ...SCOPE_DEFAULTS, ...(settings || {}) };
  const root = doc.createElement('div');
  root.id = 'scope';
  root.style.cssText = 'position:fixed;inset:0;pointer-events:none;display:none;z-index:9';
  const blur = doc.createElement('div');
  blur.style.cssText = 'position:absolute;inset:0';
  const vignette = doc.createElement('div');
  vignette.style.cssText = 'position:absolute;inset:0';
  root.append(blur, vignette);
  (mount ?? doc.body)?.appendChild(root);

  let shownKey = '', visible = false;

  // amount: 0..1 aim blend. weapon: the weapons.js entry. viewportHeight in CSS pixels.
  function update(amount, weapon, viewportHeight) {
    const on = amount > 0.01 && hasOpticalSight(weapon);
    if (!on) {
      if (visible) { visible = false; root.style.display = 'none'; }
      return false;
    }
    const g = scopeGeometry(weapon, viewportHeight, cfg);
    // Rebuild the gradients only when their shape changes; opacity is cheap and rides every frame.
    const key = `${Math.round(g.radius)}:${g.x.toFixed(1)}:${g.y.toFixed(1)}:${g.blurPx.toFixed(1)}`;
    if (key !== shownKey) {
      shownKey = key;
      const at = `${g.x}% ${g.y}%`;
      const inner = g.radius - cfg.featherPx;
      vignette.style.background = `radial-gradient(circle ${g.radius}px at ${at}, rgba(0,0,0,0) 0, rgba(0,0,0,0) ${inner}px, `
        + `rgba(0,0,0,0.55) ${g.radius}px, rgba(0,0,0,0.98) ${g.radius + cfg.rimPx}px, #000 ${g.radius + cfg.blackPx}px)`;
      const mask = `radial-gradient(circle ${g.radius}px at ${at}, rgba(0,0,0,0) 0, rgba(0,0,0,0) ${inner}px, #000 ${g.radius}px)`;
      const filter = g.blurPx > 0.05 ? `blur(${g.blurPx.toFixed(1)}px)` : 'none';
      blur.style.backdropFilter = filter;
      blur.style.webkitBackdropFilter = filter;
      blur.style.maskImage = mask;
      blur.style.webkitMaskImage = mask;
    }
    if (!visible) { visible = true; root.style.display = 'block'; }
    root.style.opacity = amount.toFixed(3);
    return true;
  }

  function dispose() { root.remove(); }

  return { element: root, update, dispose, get visible() { return visible; } };
}
