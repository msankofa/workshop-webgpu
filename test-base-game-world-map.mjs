// The windowed bake. The overlay that draws it is world-map.js's and is not retested here; what is
// tested is that this bake is shaped exactly like the one that overlay already consumes, because a
// missing field would draw nothing and look like a blank map.
// Run: node test-base-game-world-map.mjs

// Canvas and ImageData, stubbed: the bake builds two canvases and the overlay blits them.
globalThis.ImageData = class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } };
globalThis.document = {
  createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({ putImageData(img) { this.img = img; } }),
  }),
};
const { mapWindow, needsRebake, bakeWindowCanvas, createWindowedBake } = await import('./base-game-world-map.js');

let failed = 0;
function ok(cond, msg, detail = '') { if (!cond) { failed++; console.error('FAIL:', msg, detail); } }
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ── the window ──────────────────────────────────────────────────────────────
const win = mapWindow([1000, 12, -500], 400, 256);
ok(near(win.sxu, 800 / 256) && near(win.szv, 800 / 256), 'cell size is the window over the resolution', String(win.sxu));
ok(near(win.wx0, 600) && near(win.wz0, -900), 'the corner is half a window back from the middle', `${win.wx0},${win.wz0}`);
ok(win.worldX === 800 && win.worldZ === 800, 'the window is square and the size asked for', `${win.worldX}x${win.worldZ}`);

// The overlay reads these six off the bake to place it. A rename here draws a blank map.
const OVERLAY_FIELDS = ['worldX', 'worldZ', 'wx0', 'wz0', 'sxu', 'szv'];
for (const f of OVERLAY_FIELDS) ok(Number.isFinite(win[f]), `the window carries ${f}, which the overlay reads`, String(win[f]));

// ── when to bake again ──────────────────────────────────────────────────────
ok(needsRebake(null, [0, 0, 0], 60), 'with no bake yet, bake');
ok(!needsRebake(win, [1000, 12, -500], 60), 'standing still does not re-bake');
ok(!needsRebake(win, [1030, 12, -500], 60), 'a short walk does not', 'moved 30 of 60');
ok(needsRebake(win, [1061, 12, -500], 60), 'a long walk does', 'moved 61 of 60');
ok(!needsRebake(win, [1000, 9999, -500], 60), 'flying straight up does not', 'height is not distance');

// ── the bake, in the shape the overlay consumes ─────────────────────────────
{
  const out = bakeWindowCanvas(mapWindow([0, 0, 0], 100, 16), {
    sampleHeight: (x, z) => 20 * Math.sin(x * 0.01) + 10 * Math.cos(z * 0.01),
    sampleColor: () => [80, 120, 70],
  });
  for (const f of [...OVERLAY_FIELDS, 'canvas', 'terrainDetailCanvas']) {
    ok(out[f] !== undefined && out[f] !== null, `the bake carries ${f}`, String(out[f]));
  }
  ok(out.canvas.width === 16 && out.canvas.height === 16, 'the colour canvas is res by res', `${out.canvas.width}x${out.canvas.height}`);
  ok(out.terrainDetailCanvas.width === 16, 'and so is the relief layer', String(out.terrainDetailCanvas.width));
  ok(out.missing === 0, 'nothing missing when every sample answers', String(out.missing));
  const px = out.canvas.getContext().putImageData ? null : null;
  void px;
}

// Unresolved ground must fall back, not crash or hole.
{
  const out = bakeWindowCanvas(mapWindow([0, 0, 0], 100, 8), {
    sampleHeight: (x) => (x < 0 ? null : 10),
    sampleColor: (x) => (x < 0 ? null : [90, 90, 90]),
  });
  ok(out.missing === 8 * 8 / 2, 'the half that did not answer is counted', `${out.missing} of ${8 * 8}`);
}

// ── the page's wiring ───────────────────────────────────────────────────────
{
  let bakes = 0;
  const b = createWindowedBake({
    sampleHeight: () => { return 5; },
    sampleColor: () => [1, 2, 3],
    res: 8, halfSize: 100, rebakeEvery: 50,
    seaLevel: () => { bakes++; return 0; },   // a live getter, since water level is a setting
  });
  ok(b.getBake() === null, 'nothing is baked before the first step');
  // The bake is ~165k terrain samples and stalls the frame it runs in. With the map shut it must
  // never run: the first version stepped it unconditionally in the frame loop and froze the game
  // every 60 m of walking, with no map on screen.
  ok(b.step([0, 0, 0], false) === false, 'a shut map never bakes');
  ok(b.getBake() === null, 'and leaves nothing behind');
  ok(bakes === 0, 'it does not even ask for the sea level', String(bakes));
  ok(b.step([0, 0, 0], true) === true, 'opening it bakes once');
  ok(b.getBake() !== null, 'and there is a bake to hand the overlay');
  ok(bakes === 1, 'a seaLevel getter is called, not stringified', String(bakes));
  ok(b.step([10, 0, 0], true) === false, 'a short walk does not re-bake');
  ok(b.step([60, 0, 0], true) === true, 'a long one does');
  ok(b.step([9000, 0, 0], false) === false, 'and walking a mile with it shut still does not');
  ok(b.step(null, true) === false, 'no position, no bake');
  b.clear();
  ok(b.getBake() === null, 'clear drops it');
}

console.log(failed ? `\nbase-game-world-map: ${failed} failure(s)` : '\nbase-game-world-map: all tests passed');
process.exit(failed ? 1 : 0);
