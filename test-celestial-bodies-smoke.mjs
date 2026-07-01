// test-celestial-bodies-smoke.mjs
// Exercises the REAL celestial-bodies.js (not a copy) with a minimal canvas stub —
// catches thrown exceptions in any kind's paint path without needing a browser/GPU.
// Does not assert pixel content: that's verified visually via stellar-viewer.html.
function makeCtx() {
  return new Proxy({}, {
    get(target, prop) {
      if (prop === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      if (prop === 'createRadialGradient') return () => ({ addColorStop: () => {} });
      return (...args) => undefined;
    },
  });
}
function makeCanvas() {
  let w = 0, h = 0;
  return {
    get width() { return w; }, set width(v) { w = v; },
    get height() { return h; }, set height(v) { h = v; },
    getContext: () => makeCtx(),
  };
}
global.document = { createElement: (tag) => (tag === 'canvas' ? makeCanvas() : {}) };

const { makeRng, makePalette, generateCelestialBodies } = await import('./sky-field.js');
const { createCelestialBodies } = await import('./celestial-bodies.js');

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };

const bodies = generateCelestialBodies(1000, makePalette(), makeRng(42));
const group = createCelestialBodies(bodies);
ok(group.children.length === bodies.length, 'one sprite per generated body');
ok(group.children.every(s => s.isSprite), 'every child is a THREE.Sprite');
ok(group.children.every(s => s.material.map && s.material.map.isTexture), 'every sprite has a texture map');

// Every kind must paint without throwing, at both detail levels, regardless of what
// generateCelestialBodies happened to roll above.
for (const kind of ['terrestrial', 'gas', 'ice', 'volcanic', 'rocky']) {
  for (const detail of ['high', 'low']) {
    const body = { type: 'planet', scaleClass: detail === 'high' ? 'near' : 'distant', kind, detail,
      gas: kind === 'gas', position: { x: 500, y: 300, z: 400 }, radius: 700,
      size: 50, color: '#8899aa', rings: false, glow: false, seed: 0.42 };
    let threw = false;
    try { createCelestialBodies([body]); } catch (e) { threw = true; console.error(e); }
    ok(!threw, `kind=${kind} detail=${detail} paints without throwing`);
  }
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
