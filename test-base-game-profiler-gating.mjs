// Static integration guard for capture-only detailed profiling in Base Game.
// Run: node test-base-game-profiler-gating.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./base-game.html', import.meta.url), 'utf8');

assert.match(html, /createFrameProfiler\(\{ enabled: GPU_TIMESTAMPS \}\)/,
  'pass timing starts disabled unless GPU timestamps were explicitly requested');
assert.doesNotMatch(html, /latestPerformanceFrame/,
  'idle frames do not retain or allocate a detailed sample object');
assert.doesNotMatch(html, /frameProfiler\.(?:time|timeAsync)\(/,
  'the hot loop does not allocate timer callback closures');
assert.match(html, /const profileFrame = frameProfiler\.enabled;[\s\S]{0,80}if \(profileFrame\) frameProfiler\.beginFrame\(\)/);
assert.match(html, /const tSim = profileFrame \? performance\.now\(\) : 0/);
assert.match(html, /if \(profileFrame\) \{[\s\S]{0,180}frameProfiler\.mark\('postRender'/);

const recorder = html.match(/function recordPerformanceFrame\(frameStart, frameMs\) \{[\s\S]*?\n\}/)?.[0] ?? '';
assert.ok(recorder, 'performance-frame recorder exists');
assert.match(recorder, /if \(!capture\) return;/, 'idle frames return before allocating a sample');
assert.match(recorder, /passes: frameProfiler\.snapshot\(BASE_GAME_PASS_PREFIXES\)/,
  'captured frames still include pass timing');
assert.match(recorder, /frameProfiler\.setEnabled\(GPU_TIMESTAMPS\)/,
  'detailed CPU timing switches off when capture ends');

const clickHandler = html.match(/recordPerformanceButton\.addEventListener\('click',[\s\S]*?\n\}\);/)?.[0] ?? '';
assert.ok(clickHandler, 'record button handler exists');
assert.match(clickHandler, /frameProfiler\.setEnabled\(true\);[\s\S]{0,80}activePerformanceCapture = capture/,
  'recording enables timing before the first captured frame');
assert.doesNotMatch(clickHandler, /latestPerformanceFrame|requestedWindowSeconds === 0/,
  'instantaneous capture waits for one newly profiled frame');

assert.match(html, /const dropped = frameProfiler\.droppedFrames/,
  'the basic HUD reads dropped frames without allocating a pass snapshot');

console.log('base-game profiler gating tests passed');
