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
import { lerpHex } from './sky-field.js';

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

// ---- 4. the key light's COLOUR crosses over, it does not switch ---------------------------------
// It used to: `moonOwnsShadow = moonIntensity > sunIntensity` chose the colour as well as the
// shadow, so at sun elevation -0.20 deg the key light -- and the clouds, which take this very
// colour -- jumped from #ffb066 to #aec6ff in one frame. Direction still switches, because r184
// disposes a light's ShadowNode when castShadow flips; colour has no such constraint.
{
  const TOD_SUN_WARM = '#ffb066', TOD_SUN_NEUTRAL = '#fff4e0', TOD_MOON_LIGHT = '#aec6ff';
  const TOD_MOON_MAX = 0.35;
  const ss = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const rgb = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const dist = (a, b) => { const A = rgb(a), B = rgb(b); return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]); };

  // The shipped blend, over a clear night sky (nightness 1, moon high) as the sun sets.
  const shipped = (elev) => {
    const sun = 4 * ss(-2, 8, elev);
    const share = TOD_MOON_MAX / (sun + TOD_MOON_MAX);
    return lerpHex(lerpHex(TOD_SUN_WARM, TOD_SUN_NEUTRAL, ss(0, 12, elev)), TOD_MOON_LIGHT, share);
  };
  // What it did before: a boolean on the same comparison.
  const before = (elev) => {
    const sun = 4 * ss(-2, 8, elev);
    return TOD_MOON_MAX > sun ? TOD_MOON_LIGHT : lerpHex(TOD_SUN_WARM, TOD_SUN_NEUTRAL, ss(0, 12, elev));
  };

  let worstNow = 0, worstBefore = 0, atNow = 0, atBefore = 0;
  for (let e = 3; e > -3; e -= 0.01) {
    const dNow = dist(shipped(e), shipped(e - 0.01));
    const dBefore = dist(before(e), before(e - 0.01));
    if (dNow > worstNow) { worstNow = dNow; atNow = e; }
    if (dBefore > worstBefore) { worstBefore = dBefore; atBefore = e; }
  }
  ok(worstBefore > 100, `the old switch jumped ${worstBefore.toFixed(0)}/255 of colour in one 0.01 deg step, at ${atBefore.toFixed(2)} deg`);
  ok(worstNow < 8, `the blend's largest step is ${worstNow.toFixed(1)}/255, at ${atNow.toFixed(2)} deg`);
  ok(shipped(-2.5) === TOD_MOON_LIGHT, 'below the sun cutoff the key light is exactly the moon colour');
  ok(dist(shipped(30), TOD_SUN_NEUTRAL) < 14, 'high above the horizon it is essentially the sun colour');
  ok(before(-2.5) === TOD_MOON_LIGHT, 'and the night endpoint is unchanged: this is a transition, not a recolouring');
}

// ---- 5. a lightning flash cannot decide which body owns the sky ---------------------------------
{
  const html = await (await import('fs/promises')).readFile('./base-game.html', 'utf8');
  ok(!/sunIntensity \+= lightning\.sunLift;/.test(html),
    'the lift is no longer folded into sunIntensity before the ownership test');
  ok(/const keyLift = lightning\.sunLift;/.test(html), 'it is held separately');
  const rest = html.slice(html.indexOf('const moonOwnsShadow'));
  ok(/rig\.setSunIntensity\(moonIntensity \+ keyLift\)/.test(rest) && /rig\.setSunIntensity\(sunIntensity \+ keyLift\)/.test(rest),
    'and added to whichever body owns the key light');
  ok(!/rig\.setSunColor\(TOD_MOON_LIGHT\)/.test(html), 'the hard colour switch is gone');
  ok(/lerpHex\(lerpHex\(TOD_SUN_WARM, TOD_SUN_NEUTRAL, _sunWarmth\), TOD_MOON_LIGHT, moonShare\)/.test(html),
    'replaced by a blend of both bodies by their share of the light');
  ok(/moonOwnsShadow = moonIntensity > sunIntensity/.test(html), 'ownership still compares the pre-lift intensities');
}

// ---- 6. the flash reaches the clouds as a flash, not as a hue accident --------------------------
{
  const html = await (await import('fs/promises')).readFile('./base-game.html', 'utf8');
  ok(/flash: rain\.uniforms\.uLightning\.value \* settings\.cloudLightningLift/.test(html),
    'the clouds are given the same 0..1 flash the drops brighten on');
  const clouds = await (await import('fs/promises')).readFile('./base-game-clouds.js', 'utf8');
  const upd = clouds.slice(clouds.indexOf('update(dt, camera, {'));
  const dimAt = upd.indexOf('multiplyScalar(1 - shared.nightDim');
  const flashAt = upd.indexOf('tint.lerp(flashTint');
  ok(dimAt >= 0 && flashAt > dimAt,
    'and the lift is applied AFTER the night dim, so a bolt is not scaled down by 0.85 at night');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
