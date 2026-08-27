// The optical sight picture: the geometry that shapes it, and the overlay against a DOM stub. The
// FOV zoom and eye dolly are the page's and are checked in test-base-game-player.mjs.
import { readFileSync } from 'node:fs';
import { createScopeOverlay, scopeGeometry, hasOpticalSight, SCOPE_DEFAULTS } from './scope-overlay.js';
import { getWeapon } from './weapons.js';

let pass = 0, fail = 0;
const ok = (condition, message) => { if (condition) pass++; else { fail++; console.error('FAIL:', message); } };

// ---- which weapons get a sight picture ----
ok(hasOpticalSight(getWeapon('m24')), 'the sniper has an optical sight');
for (const id of ['m1911', 'five_seven', 'cz_805_bren', 'rpg', 'knife', 'grenade']) {
  ok(!hasOpticalSight(getWeapon(id)), `${id} has iron sights and draws no scope ring`);
}
ok(!hasOpticalSight(null) && !hasOpticalSight({}), 'no weapon, no sight picture');

// ---- geometry ----
{
  const m24 = getWeapon('m24');
  const g = scopeGeometry(m24, 1000);
  ok(Math.abs(g.radius - m24.scopeRadius * 1000) < 1e-9, 'the glass is scaled off the viewport height, not a fixed pixel size');
  // The m24's glass is authored slightly off centre (0.49, 0.46) -- read it rather than assume.
  ok(g.x === m24.scopeCenter[0] * 100 && g.y === m24.scopeCenter[1] * 100, 'the authored scope centre is carried through as a percentage');
  const tall = scopeGeometry(m24, 2000);
  ok(tall.radius === g.radius * 2, 'a taller window gives a proportionally bigger sight picture');
  ok(scopeGeometry(m24, 1).radius === SCOPE_DEFAULTS.minRadiusPx, 'a tiny window clamps to a usable minimum instead of a dot');
  ok(scopeGeometry({}, 1000).radius > 0 && scopeGeometry(null, 1000).radius > 0, 'a weapon with nothing authored still yields a valid ring');
  ok(scopeGeometry({ scopeCenter: [0.4, 0.6] }, 1000).x === 40, 'an off-centre scope is honoured');
  ok(scopeGeometry({ scopeCenter: ['x', null] }, 1000).x === 50, 'and nonsense centres fall back to the middle');
  ok(scopeGeometry({ scopeBlur: 0.5 }, 1000).blurPx === 5, 'blur scales from the authored 0..1');
  ok(scopeGeometry({ scopeBlur: -3 }, 1000).blurPx === 0, 'negative blur is treated as none');
}

// ---- the overlay ----
function stubDocument() {
  const removed = [];
  const make = () => ({
    children: [], id: '', style: { cssText: '' },
    append(...kids) { this.children.push(...kids); },
    appendChild(kid) { this.children.push(kid); return kid; },
    remove() { removed.push(this); },
  });
  return { createElement: make, body: make(), removed };
}
{
  const doc = stubDocument();
  const scope = createScopeOverlay({ document: doc });
  ok(doc.body.children.length === 1, 'the overlay mounts one root');
  ok(scope.element.style.cssText.includes('pointer-events:none'), 'it never eats clicks');
  ok(scope.visible === false && scope.element.style.cssText.includes('display:none'), 'and starts hidden');

  const m24 = getWeapon('m24'), pistol = getWeapon('m1911');
  ok(scope.update(0, m24, 1000) === false, 'not aiming shows nothing');
  ok(scope.update(1, pistol, 1000) === false, 'aiming iron sights shows nothing');
  ok(scope.visible === false, 'and neither of those made it visible');

  ok(scope.update(1, m24, 1000) === true, 'aiming the sniper raises the sight picture');
  ok(scope.visible === true && scope.element.style.display === 'block', 'the overlay is shown');
  const vignette = scope.element.children[1];
  ok(vignette.style.background.includes('radial-gradient') && vignette.style.background.includes('#000'), 'the surround is a radial gradient to black');
  ok(vignette.style.background.includes(`${Math.round(m24.scopeRadius * 1000)}px`), 'sized from the geometry');
  const blurLayer = scope.element.children[0];
  ok(blurLayer.style.maskImage.includes('radial-gradient'), 'the blur layer is masked to outside the glass');
  ok(blurLayer.style.backdropFilter === 'blur(1.9px)', 'the m24 authors a light blur, so the periphery is softened');
  ok(scope.update(1, { sightType: 'optical', scopeRadius: 0.3 }, 1000) && blurLayer.style.backdropFilter === 'none',
    'a weapon authoring no blur gets no backdrop filter at all, which is the expensive one to attach');

  // Opacity follows the aim blend so the picture fades in rather than appearing.
  scope.update(0.4, m24, 1000);
  ok(scope.element.style.opacity === '0.400', 'partial aim is a partial fade');

  // The expensive part is rewritten only when its shape changes.
  const before = vignette.style.background;
  scope.update(0.9, m24, 1000);
  ok(vignette.style.background === before, 'holding aim does not rebuild the gradient every frame');
  scope.update(0.9, m24, 1400);
  ok(vignette.style.background !== before, 'but a resized window does');

  ok(scope.update(1, { sightType: 'optical', scopeBlur: 0.6, scopeRadius: 0.31 }, 1000) === true, 'a weapon that authors heavier blur is accepted');
  ok(blurLayer.style.backdropFilter === 'blur(6.0px)', 'and gets a proportionally stronger backdrop filter');

  scope.update(0, m24, 1000);
  ok(scope.visible === false, 'releasing aim puts it away');
  scope.dispose();
  ok(doc.removed.length === 1, 'disposing removes it');
}
ok((() => { try { createScopeOverlay({}); return false; } catch { return true; } })(), 'createScopeOverlay refuses to run without a document');

// ---- wiring ----
{
  const html = readFileSync(new URL('./base-game.html', import.meta.url), 'utf8');
  for (const marker of ['scope-overlay.js', 'createScopeOverlay(', 'scopeOverlay.update(', 'scopeOverlay.visible']) {
    ok(html.includes(marker), `base-game.html wires ${marker}`);
  }
  ok(html.includes('magnification'), 'the FOV zoom still reads the weapon magnification');
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
