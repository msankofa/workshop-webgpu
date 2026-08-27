// The reticle: the cone-to-pixels geometry, and the overlay it builds against a DOM stub. The
// interesting half is the geometry — a gap that does not track the camera FOV is a reticle that
// lies about accuracy the moment anyone aims down a scope.
import { readFileSync } from 'node:fs';
import { createReticle, reticleGapPx, RETICLE_DEFAULTS } from './reticle.js';
import { createTriggerState, stepTrigger, spreadHalfAngleFor } from './base-game-fire.js';
import { createAmmoStore } from './player-ammo.js';

let pass = 0, fail = 0;
const ok = (condition, message) => { if (condition) pass++; else { fail++; console.error('FAIL:', message); } };

// ---- geometry ----
const H = 900, FOV = 50;
ok(reticleGapPx({ halfAngleRad: 0, viewportHeight: H, fovYDeg: FOV }) === RETICLE_DEFAULTS.baseGapPx, 'a perfectly accurate weapon still shows the base gap');
ok(reticleGapPx({}) === RETICLE_DEFAULTS.baseGapPx, 'no viewport yet gives the base gap rather than NaN');
{
  const narrow = reticleGapPx({ halfAngleRad: 0.02, viewportHeight: H, fovYDeg: FOV });
  const wide = reticleGapPx({ halfAngleRad: 0.06, viewportHeight: H, fovYDeg: FOV });
  ok(wide > narrow && narrow > RETICLE_DEFAULTS.baseGapPx, 'a wider cone opens the gap');
  // The whole point of going through the FOV: the same cone is a bigger share of a zoomed screen.
  const zoomed = reticleGapPx({ halfAngleRad: 0.02, viewportHeight: H, fovYDeg: 20 });
  ok(zoomed > narrow, 'the same cone reads wider when the camera is zoomed in');
  const taller = reticleGapPx({ halfAngleRad: 0.02, viewportHeight: H * 2, fovYDeg: FOV });
  ok(taller > narrow, 'a taller viewport means more pixels for the same angle');
  // The exact projection, not just the ordering: half the screen height scaled by the tangent ratio.
  const expect = RETICLE_DEFAULTS.baseGapPx + (H * 0.5) * Math.tan(0.02) / Math.tan(FOV * Math.PI / 360);
  ok(Math.abs(narrow - expect) < 1e-9, 'the gap is the cone projected through the vertical FOV');
}
ok(reticleGapPx({ halfAngleRad: 3, viewportHeight: H, fovYDeg: FOV }) === RETICLE_DEFAULTS.maxGapPx, 'an absurd cone clamps instead of running off screen');
ok(reticleGapPx({ halfAngleRad: -1, viewportHeight: H, fovYDeg: FOV }) === RETICLE_DEFAULTS.baseGapPx, 'a negative cone is treated as none');
ok(reticleGapPx({ halfAngleRad: 0.02, viewportHeight: H, fovYDeg: 0 }) > RETICLE_DEFAULTS.baseGapPx, 'a nonsense FOV still produces a finite gap');

// ---- the cone the reticle is drawing comes from the same place the shot does ----
{
  const trigger = createTriggerState(), ammo = createAmmoStore();
  const still = spreadHalfAngleFor(trigger, { weaponId: 'cz_805_bren', tick: 1 });
  ok(still > 0, 'a settled rifle still has a cone');
  ok(spreadHalfAngleFor(trigger, { weaponId: 'cz_805_bren', tick: 1, moveSpeed01: 1 }) > still, 'running opens it');
  ok(spreadHalfAngleFor(trigger, { weaponId: null, tick: 1 }) === 0, 'no weapon, no cone');
  for (let tick = 1; tick <= 30; tick++) stepTrigger(trigger, ammo, { playerId: 'p', weaponId: 'cz_805_bren', tick, fire: true, reload: false, aim: true });
  ok(trigger.bloomDeg > 0, 'a burst leaves recoil bloom on the trigger');
  // Compared against the SAME trigger with the bloom cleared: the first-shot term has been decaying
  // over those 30 ticks too, so comparing against the settled cone would measure both at once.
  const bloomed = spreadHalfAngleFor(trigger, { weaponId: 'cz_805_bren', tick: 31 });
  const unbloomed = spreadHalfAngleFor({ ...trigger, bloomDeg: 0 }, { weaponId: 'cz_805_bren', tick: 31 });
  ok(bloomed > unbloomed, 'the reticle shows the recoil bloom, not just the base cone');
}

// ---- the overlay, against a DOM stub ----
function stubDocument() {
  const make = (tag) => {
    const node = {
      tagName: tag, children: [], className: '', id: '', textContent: '',
      style: { cssText: '', _props: {} },
      classList: { list: new Set(), add(...c) { for (const x of c) this.list.add(x); }, remove(...c) { for (const x of c) this.list.delete(x); }, contains(c) { return this.list.has(c); } },
      offsetWidth: 0,
      appendChild(child) { this.children.push(child); return child; },
      remove() { removed.push(this); },
    };
    // style.foo = 'x' has to be observable; a plain object is enough for what the module writes.
    return node;
  };
  const removed = [];
  const doc = { createElement: make, head: make('head'), body: make('body'), removed };
  return doc;
}
{
  const doc = stubDocument();
  const reticle = createReticle({ document: doc });
  ok(doc.body.children.length === 1 && doc.head.children.length === 1, 'the reticle mounts one root and one stylesheet');
  ok(reticle.element.style.cssText.includes('pointer-events:none'), 'the overlay never eats clicks');
  ok(reticle.visible === false, 'it starts hidden');
  reticle.setVisible(true);
  ok(reticle.visible === true && reticle.element.style.display === 'block', 'showing it sets display');
  reticle.setVisible(true);
  ok(reticle.visible === true, 'showing it twice is a no-op');

  const layer = reticle.element.children[0];
  reticle.update({ x: 640.4, y: 360.6, gapPx: 12, ready: true });
  ok(layer.style.transform === 'translate(640px, 361px)', 'the whole reticle moves as one transform, rounded to whole pixels');
  const bars = layer.children.slice(0, 4);
  ok(bars[0].style.top === '-20px' && bars[1].style.top === '12px', 'the vertical bars sit a gap plus a bar length out');
  ok(bars[2].style.left === '-20px' && bars[3].style.left === '12px', 'and the horizontal ones mirror them');
  const dot = layer.children[4];
  ok(dot.style.display === 'block', 'a legal shot shows the centre dot');
  reticle.update({ x: 640.4, y: 360.6, gapPx: 12, ready: false, blocked: true });
  ok(dot.style.display === 'none', 'a blocked trigger takes the dot away, so ready is not carried by colour alone');
  ok(bars[0].style.background === RETICLE_DEFAULTS.blockedColor, 'and the bars go amber');
  reticle.update({ x: 640.4, y: 360.6, gapPx: 12, dead: true });
  ok(bars[0].style.background === RETICLE_DEFAULTS.deadColor, 'dead reads differently again');

  const hitmarker = layer.children[5];
  ok(hitmarker.children.length === 4, 'the hitmarker is four strokes');
  reticle.hit({ fatal: false });
  ok(hitmarker.classList.contains('hit-pop') && !hitmarker.classList.contains('hit-kill'), 'a hit pops the marker');
  reticle.hit({ fatal: true });
  ok(hitmarker.classList.contains('hit-kill'), 'a fatal hit marks it as a kill');
  reticle.hit({ fatal: false });
  ok(!hitmarker.classList.contains('hit-kill'), 'the next non-fatal hit clears the kill state');

  reticle.dispose();
  ok(doc.removed.length === 2, 'disposing removes the overlay and its stylesheet');
}
ok((() => { try { createReticle({}); return false; } catch { return true; } })(), 'createReticle refuses to run without a document');

// ---- wiring ----
{
  const html = readFileSync(new URL('./base-game.html', import.meta.url), 'utf8');
  for (const marker of ['reticle.js', 'createReticle(', 'updateReticle(', 'reticleGapPx(', 'spreadHalfAngleFor(', 'reticle.hit(', "'reticleEnabled'"]) {
    ok(html.includes(marker), `base-game.html wires ${marker}`);
  }
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
