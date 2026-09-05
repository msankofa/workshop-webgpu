import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { vegetationDebugLines, freshVegetationCount, compareVegetationSamples, createVegetationDebugHud } from './vegetation-debug-hud.js';
const base = { now: 1000, fps: 60, worstMs: 20, draws: 100, triangles: 10000,
  grass: { enabled: true, built: true, drawn: 120, capacity: 100, dispatch: 200, expected: 180,
    drawnSample: { atMs: 900, occlusion: false, view: [0, 1] },
    cull: { survivors: 120, planar: 40, density: 20, ground: 10, view: 5, occlusion: 5, overflow: 20 } },
  trees: { enabled: true, trees: 1000, instances: 900, dropped: 100, lod0: 10, lod1: 20, lod2: 30 },
  occlusion: { enabled: false, size: 512, renders: 10, skipped: 20, lastRenderCpuMs: 0.1 },
  configuration: 'same', view: [0, 1], gpuRequested: false, gpuResolved: 0 };
assert.ok(freshVegetationCount(base));
const lines = vegetationDebugLines(base);
assert.match(lines, /100 drawn \/ 120 survivors/);
assert.match(lines, /CAP REACHED/);
assert.match(lines, /CPU estimates/);
assert.match(lines, /NOT occlusion rejects/);
assert.match(lines, /80 \/ 200 rejected \(40.0%\)/);
assert.match(lines, /depth occlusion 5 \(2.5%\)/);
assert.match(lines, /capacity overflow 20/);
assert.match(lines, /can lower FPS/);
assert.match(lines, /not GPU time/);
assert.match(lines, /GPU timestamps OFF/);
assert.match(vegetationDebugLines({ ...base, grass: { enabled: false }, trees: { enabled: false }, occlusion: null }), /Grass OFF[\s\S]*Trees OFF/);
const on = structuredClone(base);
on.now = 4000; on.grass.drawn = 60; on.occlusion.enabled = true;
on.grass.drawnSample = { atMs: 3900, occlusion: true, view: [0, 1] };
assert.match(compareVegetationSamples(base, on), /60 fewer survivors \(50.0%\)/);
assert.match(compareVegetationSamples(on, base), /60 fewer survivors/);
assert.match(compareVegetationSamples(base, { ...on, view: [1, 1] }), /fresh GPU count/);
assert.match(compareVegetationSamples(base, { ...on, configuration: 'changed' }), /Comparison invalid/);
assert.match(compareVegetationSamples(base, base), /Toggle occlusion/);
assert.ok(!freshVegetationCount({ ...base, now: 4000 }));
assert.ok(!freshVegetationCount({ ...base, occlusion: { enabled: true } }));
class Element {
  children = []; style = {}; listeners = {}; hidden = false;
  append(...children) { this.children.push(...children); }
  addEventListener(event, fn) { this.listeners[event] = fn; }
  remove() { this.removed = true; }
}
const document = { createElement: () => new Element(), body: new Element() };
let sampled = 0, toggled = 0;
const host = new Element();
const hud = createVegetationDebugHud({ document, host, sample: () => { sampled++; return base; }, toggleOcclusion: () => toggled++ });
hud.refresh(); assert.equal(sampled, 1);
const root = host.children[0], [toggle, body] = root.children;
assert.equal(document.body.children.length, 0, 'HUD mounts in the existing debug dock');
assert.doesNotMatch(root.style.cssText, /position:fixed|top:70px/);
assert.match(root.style.cssText, /max-height:20vh/);
toggle.listeners.click(); assert.equal(hud.visible, false); assert.equal(body.hidden, true);
hud.refresh(); assert.equal(sampled, 1, 'hidden HUD never requests stats');
toggle.listeners.click(); hud.refresh(); assert.equal(sampled, 2);
body.children[3].listeners.click(); assert.equal(toggled, 1);
hud.dispose(); assert.ok(root.removed);
const html = readFileSync(new URL('./base-game.html', import.meta.url), 'utf8');
assert.match(html, /host: document.getElementById\('debug-dock'\)/);
assert.match(html, /if \(fpsElapsed < 500\) return;[\s\S]{0,250}vegetationDebugHud.refresh\(\)/);
assert.match(html, /occlusion: flora.occlusion \? \{ ...flora.occlusionStats/);
const script = html.match(/<script[^>]*type=[^>]*module[^>]*>([\s\S]*?)<\/script>/)[1];
const { spawnSync } = await import('node:child_process');
const syntax = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: script, encoding: 'utf8' });
assert.equal(syntax.status, 0, syntax.stderr);
console.log('vegetation HUD counts, labels, stale samples, A/B guards, visibility, cadence and page syntax passed');
