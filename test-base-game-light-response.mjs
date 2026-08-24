// test-base-game-light-response.mjs — the weather light response in base-game.html's updateWorld,
// which runs every frame and therefore must be idempotent.
//
// This exists because it was not. The ambient lift shipped as `rig.ambLight.intensity *= 1 + …`,
// which looked safe: both day/night branches call rig.setAmbientIntensity every frame, so the
// multiply should have been undone each time. It was not, because createLightingRig's set() bails
// on an unchanged REQUESTED value and tracks that separately from the live light — so a static
// slider means the setter does nothing and the multiply stacks. At 1.15x per frame the screen is
// white inside a second. Anything that writes a rig-owned light directly needs this test.
import * as THREE from 'three';
import { createLightingRig } from './lights.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('ok  ', m); } else { fail++; console.log('FAIL', m); } };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

const FRAMES = 600;   // ten seconds at 60 fps

// ---- 1. the rig's setter really does bail, which is the trap ------------------------------------
{
  const rig = createLightingRig({ scene: new THREE.Scene(), ui: false, ambientIntensity: 0.6 });
  rig.setAmbientIntensity(0.6);
  rig.ambLight.intensity = 99;              // pretend a caller wrote the light behind the rig's back
  rig.setAmbientIntensity(0.6);             // the same request again
  ok(rig.ambLight.intensity === 99, 'the rig does NOT restore a light written behind its back on an unchanged request');
  rig.setAmbientIntensity(0.61);
  ok(near(rig.ambLight.intensity, 0.61), 'and only a CHANGED request writes the light');
}

// ---- 2. the shipped response, run for ten seconds of frames --------------------------------------
// Mirrors updateWorld: request the base ambient through the rig, then apply the weather lift.
function runResponse({ frames = FRAMES, weatherRain = 1, ambientLiftPerRain = 0.15, sunDimPerRain = 0.72, ambientBase = 0.6, sunBase = 1.8 }) {
  const rig = createLightingRig({ scene: new THREE.Scene(), ui: false, ambientIntensity: ambientBase });
  let sun = 0;
  for (let i = 0; i < frames; i++) {
    rig.setAmbientIntensity(ambientBase);
    sun = sunBase * (1 - sunDimPerRain * weatherRain);
    rig.setSunIntensity(sun);
    // The shipped line: an assignment from the value just requested, not a multiply on the light.
    rig.ambLight.intensity = ambientBase * (1 + ambientLiftPerRain * weatherRain);
  }
  return { ambient: rig.ambLight.intensity, sun: rig.dirLight.intensity };
}

{
  const one = runResponse({ frames: 1 });
  const many = runResponse({ frames: FRAMES });
  ok(near(one.ambient, many.ambient), `the ambient after ${FRAMES} frames equals the ambient after one (${many.ambient.toFixed(4)})`);
  ok(near(many.ambient, 0.6 * 1.15), 'and it is the base lifted once, not compounded');
  ok(many.ambient < 1, 'a full storm lifts the ambient by a fraction, not by orders of magnitude');
  ok(near(many.sun, 1.8 * 0.28), 'the key light is dimmed to 28% at full weather');
  ok(many.sun < 1.8, 'weather takes the key light down, never up');
}

// The regression itself: the multiply that shipped would have failed this.
{
  const rig = createLightingRig({ scene: new THREE.Scene(), ui: false, ambientIntensity: 0.6 });
  for (let i = 0; i < 60; i++) {
    rig.setAmbientIntensity(0.6);
    rig.ambLight.intensity *= 1.15;          // the old line, kept here as the thing being guarded against
  }
  ok(rig.ambLight.intensity > 1000, `the old multiply really did run away (${rig.ambLight.intensity.toFixed(0)}x after one second)`);
}

// ---- 3. dry weather changes nothing at all -------------------------------------------------------
{
  const dry = runResponse({ weatherRain: 0 });
  ok(near(dry.ambient, 0.6), 'no weather leaves the ambient exactly where the slider put it');
  ok(near(dry.sun, 1.8), 'and leaves the key light alone');
}

// ---- 4. the response is monotonic in the master ---------------------------------------------------
{
  const at = rain => runResponse({ frames: 1, weatherRain: rain });
  ok(at(1).ambient > at(0.5).ambient && at(0.5).ambient > at(0).ambient, 'ambient rises with the master');
  ok(at(1).sun < at(0.5).sun && at(0.5).sun < at(0).sun, 'the key light falls with it');
  ok(at(1).sun > 0, 'and never goes negative at the slider ceiling');
}

// ---- 5. what the page actually ships -------------------------------------------------------------
{
  const html = await (await import('fs/promises')).readFile('./base-game.html', 'utf8');
  ok(!/ambLight\.intensity\s*\*=/.test(html), 'the page multiplies no rig-owned light in the frame loop');
  ok(/rig\.ambLight\.intensity = ambientBase \*/.test(html), 'the ambient lift assigns from the base it just requested');
  // Indented four spaces: the two branch assignments, not the `let` declaration above them.
  ok((html.match(/^ {4}ambientBase =/gm) || []).length === 2, 'both day/night branches set that base');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
