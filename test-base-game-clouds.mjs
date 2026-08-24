// test-base-game-clouds.mjs — the cloud decks: the octave generalisation against the original
// two-tap constants, the deck lifecycle (rebuild on an octave change, uniforms otherwise), the
// render-origin offset, the tint, and a headless GLSL build of the material at each octave count.
import * as THREE from 'three';
import { Clouds } from './clouds.js';
import { createBaseGameClouds, deckHorizonAngle, CLOUD_DECK_DEFAULTS } from './base-game-clouds.js';
import { buildMaterial } from './tsl-build-check.mjs';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('ok  ', m); } else { fail++; console.log('FAIL', m); } };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

// ---- octave constants -------------------------------------------------------------------------
// The generalisation is frequency 5·2^i and time divisor 40/(1 + i/3); octaves 0 and 1 must land
// exactly on the original snoise(uv·5/puff + t/40) + snoise(uv·10/puff + t/30) pair.
const freqAt = i => 5 * 2 ** i;
const tdivAt = i => 40 / (1 + i / 3);
const ampAt = i => (i < 2 ? 1 : 0.5 ** (i - 1));
ok(freqAt(0) === 5 && freqAt(1) === 10, 'octaves 0 and 1 keep the original 5 and 10 frequencies');
ok(near(tdivAt(0), 40) && near(tdivAt(1), 30), 'octaves 0 and 1 keep the original 40 and 30 time divisors');
ok(ampAt(0) === 1 && ampAt(1) === 1, 'the first two octaves keep weight 1, so the old look is unchanged');
ok(ampAt(2) === 0.5 && ampAt(3) === 0.25, 'later octaves halve');
ok(freqAt(5) === 160 && tdivAt(5) > 0, 'the divisor stays positive out to the top of the slider range');

// ---- Clouds options ---------------------------------------------------------------------------
{
  const c = new Clouds();
  ok(c.octaves === 2, 'Clouds defaults to the original two octaves');
  ok(c.material._uOvercast.value === 0, 'overcast defaults to 0, so the default colour is the plain tint');
  ok(c.material._uTint.value.getHex() === 0xffffff, 'tint defaults to white');
  c.setOffset(1234, -99);
  ok(c.material._uOffset.value.x === 1234 && c.material._uOffset.value.y === -99, 'setOffset writes the render-origin uniform');
  c.setOvercast(0.4); ok(near(c.material._uOvercast.value, 0.4), 'setOvercast writes its uniform');
  c.setTint(new THREE.Color(0.5, 0.25, 0.125));
  ok(near(c.material._uTint.value.r, 0.5) && near(c.material._uTint.value.b, 0.125), 'setTint writes its uniform');
  ok(new Clouds({ octaves: 5 }).octaves === 5, 'the octave option is carried');
  ok(new Clouds({ octaves: 0 }).octaves === 1, 'octaves clamps to at least one');
}

// ---- where the deck ends, and whether that rim is visible -------------------------------------
// alpha = cloud · opacity · haze · edge, and edge = smoothstep(1, edgeStart, norm) with
// norm = |xz − camera| / (extent/2). So alpha is exactly 0 at norm ≥ 1: the deck fades out on a
// circle inscribed in the square, and the square's own corners (norm = √2) are already past zero.
// The plane's straight edge can therefore never be seen; what can be seen is that circle's
// elevation in the sky.
{
  const alphaEdge = (norm, edgeStart) => {
    const t = Math.min(1, Math.max(0, (norm - 1) / (edgeStart - 1)));
    return t * t * (3 - 2 * t);
  };
  ok(near(alphaEdge(1, 0.85), 0), 'alpha is zero on the inscribed circle');
  ok(near(alphaEdge(Math.SQRT2, 0.85), 0), 'the plane corners are already fully transparent');
  ok(alphaEdge(0.85, 0.85) === 1, 'inside the rim the deck is at full strength');
  ok(alphaEdge(0.92, 0.85) > 0 && alphaEdge(0.92, 0.85) < 1, 'the rim fades rather than cutting');
  ok(alphaEdge(0.5, 0.3) < 1 && alphaEdge(0.5, 0.85) === 1,
    'an early rim start begins fading much further in, which is the no-visible-edge setting');

  // The rim's elevation is what a player actually sees, and the defaults put it several degrees up.
  ok(near(deckHorizonAngle({ height: 900, extent: 20000 }), 5.14, 0.01), 'deck A default rim sits ~5.1 deg above the horizon');
  ok(near(deckHorizonAngle({ height: 2200, extent: 40000 }), 6.28, 0.01), 'deck B default rim sits ~6.3 deg above the horizon');
  ok(deckHorizonAngle({ height: 900, extent: 60000 }) < 2, 'the widest extent brings deck A under 2 deg');
  ok(deckHorizonAngle({ height: 300, extent: 60000 }) < 0.6, 'a low deck at full extent is under a degree');
  ok(deckHorizonAngle({ height: 900, extent: 20000 }) > deckHorizonAngle({ height: 900, extent: 40000 }),
    'widening the extent lowers the rim');
  ok(deckHorizonAngle({ height: 2000, extent: 20000 }) > deckHorizonAngle({ height: 900, extent: 20000 }),
    'raising the deck lifts the rim');
}

// ---- deck wiring ------------------------------------------------------------------------------
{
  const scene = new THREE.Scene();
  const clouds = createBaseGameClouds({ scene, deckCount: 2 });
  ok(clouds.decks.length === 2, 'two decks are built');
  ok(scene.children.length === 2, 'both decks are added to the scene');
  ok(clouds.decks[1].cfg.height > clouds.decks[0].cfg.height, 'deck B sits above deck A');
  ok(clouds.decks[0].cfg.octaves === CLOUD_DECK_DEFAULTS.octaves, 'deck A takes the module defaults');

  const beforeMaterial = clouds.decks[0].mesh.material;
  clouds.setDeck(0, { cover: 0.7 });
  ok(clouds.decks[0].mesh.material === beforeMaterial, 'a coverage change does not rebuild the material');
  ok(near(clouds.decks[0].mesh.material._uCoverage.value, 0.7), 'a coverage change reaches the uniform');
  clouds.setDeck(0, { fadeFloor: 0, edgeStart: 0.3 });
  ok(near(clouds.decks[0].mesh.material._uFadeFloor.value, 0), 'the dimming floor reaches its uniform');
  ok(near(clouds.decks[0].mesh.material._uEdgeStart.value, 0.3), 'the rim start reaches its uniform');
  clouds.decks[0].mesh.setEdgeStart(1);
  ok(clouds.decks[0].mesh.material._uEdgeStart.value < 1,
    'the rim start is held below 1, where the smoothstep would have equal edges');
  clouds.setDeck(0, { edgeStart: 0.85, fadeFloor: 0.25 });
  clouds.setDeck(0, { octaves: 5 });
  ok(clouds.decks[0].mesh.material !== beforeMaterial, 'an octave change rebuilds the material');
  ok(clouds.decks[0].mesh.octaves === 5, 'the rebuilt deck carries the new octave count');
  ok(near(clouds.decks[0].mesh.material._uCoverage.value, 0.7), 'the rebuild re-applies the other settings');
  ok(near(clouds.decks[0].mesh.material._uEdgeStart.value, 0.85), 'the rebuild re-applies the rim settings too');
  ok(scene.children.length === 2, 'a rebuild leaves exactly one mesh per deck in the scene');

  // far extent: the corner of the widest visible deck, and nothing at all when disabled
  const expected = Math.hypot(clouds.decks[1].cfg.extent / 2, clouds.decks[1].cfg.height);
  ok(near(clouds.farExtent, expected, 1e-6), 'far extent is the farthest deck corner');
  clouds.setEnabled(false);
  ok(clouds.farExtent === 0, 'a disabled deck asks for no far plane');
  ok(clouds.decks[0].mesh.visible === false, 'disabling hides the meshes');
  clouds.setEnabled(true);
  clouds.setDeck(1, { visible: false });
  ok(near(clouds.farExtent, Math.hypot(clouds.decks[0].cfg.extent / 2, clouds.decks[0].cfg.height), 1e-6),
    'an invisible deck does not hold the far plane out');
  clouds.setDeck(1, { visible: true });

  // render origin: the offset uniform tracks it and the deck's Y compensates
  const origin = [4000, 12, -7000];
  const rebasing = createBaseGameClouds({ scene: new THREE.Scene(), worldCoordinates: { getOrigin: () => origin } });
  const camera = { position: new THREE.Vector3(3, 5, 9) };
  rebasing.update(0.016, camera, { sunColor: new THREE.Color(1, 0.5, 0.25), nightness: 0 });
  const deck = rebasing.decks[0];
  ok(deck.mesh.material._uOffset.value.x === 4000 && deck.mesh.material._uOffset.value.y === -7000,
    'the deck carries the render origin into the noise field');
  ok(near(deck.mesh.position.y, deck.cfg.height - origin[1]), 'the deck height is render-local');
  ok(deck.mesh.position.x === 3 && deck.mesh.position.z === 9, 'the deck follows the camera in XZ');

  // tint: sun colour, dimmed by nightness
  ok(near(deck.mesh.material._uTint.value.r, 1) && near(deck.mesh.material._uTint.value.g, 0.5),
    'daylight takes the key light colour unchanged');
  rebasing.update(0.016, camera, { sunColor: new THREE.Color(1, 1, 1), nightness: 1 });
  ok(near(deck.mesh.material._uTint.value.r, 1 - rebasing.shared.nightDim),
    'full night dims the tint by nightDim');
  rebasing.setShared({ tintFollowsSun: false, tint: '#204080' });
  rebasing.update(0.016, camera, { sunColor: new THREE.Color(1, 1, 1), nightness: 0 });
  ok(near(deck.mesh.material._uTint.value.r, new THREE.Color('#204080').r),
    'with the sun link off the manual tint is used');

  // overcast is scaled by the shared grey amount, so the slider cannot exceed the authored look
  rebasing.setShared({ overcastTint: 0.5 });
  rebasing.setOvercast(1);
  ok(near(deck.mesh.material._uOvercast.value, 0.5), 'full overcast reaches only as far as the grey amount');
  rebasing.setOvercast(2);
  ok(near(deck.mesh.material._uOvercast.value, 0.5), 'overcast clamps at 1 before scaling');

  rebasing.dispose();
  clouds.dispose();
  ok(scene.children.length === 0, 'dispose empties the scene');
}

// ---- C2: the sky dome's overcast lid ------------------------------------------------------------
// sky.js paints its discs onto a 2D canvas, so a headless build needs a DOM stub; the repo already
// runs the creature sim this way. What is under test is that the dome graph still compiles with the
// lid in it, that the lid reaches the uniform, and that scene.background (which the fog tint reads)
// greys with it.
{
  const noop = () => {};
  const ctxStub = new Proxy({}, {
    get: (t, k) => {
      if (k === 'createRadialGradient' || k === 'createLinearGradient') return () => ({ addColorStop: noop });
      if (k === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) });
      return noop;
    },
    set: () => true,
  });
  const canvas = (size) => ({ width: size, height: size, getContext: () => ctxStub, toDataURL: () => '' });
  globalThis.document = { createElement: (tag) => (tag === 'canvas' ? canvas(512) : { style: {}, appendChild: noop }) };
  globalThis.window = { devicePixelRatio: 1 };

  const { createSky } = await import('./sky.js');
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101020);
  const sky = createSky({ scene, camera: new THREE.PerspectiveCamera() });
  const dome = sky.group.children.find(o => o.isMesh && o.material?.colorNode);
  ok(!!dome, 'the sky dome mesh is there to test');

  sky.setOvercast(0);
  sky.updateDome(30);
  const clear = scene.background.clone();
  sky.setOvercast(0.7);
  ok(sky.overcast === 0.7, 'setOvercast reaches the dome uniform');
  sky.updateDome(30);
  const lidded = scene.background.clone();
  ok(!clear.equals(lidded), 'the lid moves scene.background, which is what a sky-tracking fog reads');
  const chroma = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
  ok(chroma(lidded) < chroma(clear), 'the lidded sky is less saturated than the clear one');
  sky.setOvercast(2);
  ok(sky.overcast === 1, 'overcast clamps at 1');
  sky.setOvercast(0.7);

  try {
    await buildMaterial(dome.material, dome.geometry);
    ok(true, 'the dome material builds headless with the overcast lid');
  } catch (error) {
    ok(false, `the dome material builds headless with the overcast lid: ${error.message}`);
  }
}

// ---- headless material build ------------------------------------------------------------------
for (const octaves of [1, 2, 4, 6]) {
  try {
    const c = new Clouds({ octaves });
    await buildMaterial(c.material, c.geometry);
    ok(true, `the cloud material builds at ${octaves} octave(s)`);
  } catch (error) {
    ok(false, `the cloud material builds at ${octaves} octave(s): ${error.message}`);
  }
}

// ---- C2: the atmosphere fan-out ----------------------------------------------------------------
// The master multiplies through response sliders instead of writing them, so these are the exact
// expressions the page uses. Checked here because getting a response backwards is invisible on screen
// until someone drags the master to an extreme.
{
  const overcastAmount = (s) => Math.min(1, s.weatherOvercast + s.weatherRain * s.overcastPerRain);
  const fogDensity = (s) => (s.weatherFogEnabled ? s.weatherFogBase + s.weatherRain * s.weatherFogPerRain : 0);
  const base = { weatherOvercast: 0, weatherRain: 0, overcastPerRain: 1.25, weatherFogEnabled: true, weatherFogBase: 0, weatherFogPerRain: 0.0015 };

  ok(overcastAmount(base) === 0, 'no weather leaves the sky clear');
  ok(near(overcastAmount({ ...base, weatherRain: 0.4 }), 0.5), 'the master drives overcast through its response');
  ok(overcastAmount({ ...base, weatherRain: 1 }) === 1, 'a full storm caps the lid at 1, not 1.25');
  ok(near(overcastAmount({ ...base, weatherOvercast: 0.3 }), 0.3), 'the manual slider works with no weather');
  ok(near(overcastAmount({ ...base, weatherOvercast: 0.3, weatherRain: 0.2 }), 0.55), 'manual and master add');
  ok(overcastAmount({ ...base, weatherRain: 1, overcastPerRain: 0 }) === 0,
    'a zeroed response takes the master out of the loop, which is the point of separating them');

  ok(fogDensity(base) === 0, 'clear weather is clear by default');
  ok(near(fogDensity({ ...base, weatherRain: 1 }), 0.0015), 'a full storm reaches the per-unit fog density');
  ok(fogDensity({ ...base, weatherRain: 1, weatherFogEnabled: false }) === 0, 'the fog toggle wins over the master');
  ok(fogDensity({ ...base, weatherFogBase: 0.0002 }) === 0.0002, 'a clear-weather haze is independent of the master');

  // exp2 fog is 1 - exp(-(d*z)^2). This is why the cloud decks keep `fog: false`: at any density a
  // player would notice at ground range, the deck rim 10-20 km out is already fully fogged, so scene
  // fog would erase the decks rather than soften their rim. The dome's overcast lid does that job.
  const fogAt = (d, z) => 1 - Math.exp(-(d * d * z * z));
  ok(fogAt(0.0002, 500) < 0.02, 'the lightest haze is invisible at 500 m');
  ok(fogAt(0.0002, 10000) > 0.95, 'that same haze is total at deck A rim distance');
  ok(fogAt(0.0015, 660) > 0.6 && fogAt(0.0015, 660) < 0.68, 'the storm default reaches ~63% at 1/density metres');
  ok(fogAt(0.0015, 20000) > 0.999, 'a storm fog is total well before deck B rim distance');
}

// ---- the page's own assertion, checked in Node -------------------------------------------------
// base-game.html throws at load if a DEFAULT_SETTINGS key has no panel control. That is a browser-only
// failure, so mirror it here: read the file, collect the weather keys it defaults, and confirm each is
// either registered by name or produced by the two-deck loop.
{
  const html = await (await import('fs/promises')).readFile('./base-game.html', 'utf8');
  const settingsBlock = html.match(/const DEFAULT_SETTINGS = Object\.freeze\(\{([\s\S]*?)\n\}\);/)?.[1] ?? '';
  // Several keys share a line, and the block carries comments, so strip those and match anywhere.
  const settingsCode = settingsBlock.split('\n').filter(line => !line.trim().startsWith('//')).join('\n');
  const weatherKeys = [...settingsCode.matchAll(/\b(cloud[A-Za-z]+|weather[A-Za-z]+)\s*:/g)].map(m => m[1]);
  const loopSuffixes = [...html.matchAll(/add(?:Toggle|Range)\(sec, `\$\{prefix\}(\w+)`/g)].map(m => m[1]);
  const literal = new Set([...html.matchAll(/add(?:Toggle|Range|Select|Color)\([\w.]+, '([\w]+)'/g)].map(m => m[1]));
  const covered = key => literal.has(key)
    || (/^cloud[AB]/.test(key) && loopSuffixes.includes(key.slice(6)));
  const missing = weatherKeys.filter(k => !covered(k));
  ok(weatherKeys.length >= 37, `the page defaults every weather setting (found ${weatherKeys.length})`);
  ok(loopSuffixes.length === 12, `the deck loop builds all twelve per-deck controls (found ${loopSuffixes.length})`);
  ok(missing.length === 0, `every weather setting has a panel control${missing.length ? `: missing ${missing.join(', ')}` : ''}`);

  const limitsBlock = html.match(/const NUMBER_LIMITS = Object\.freeze\(\{([\s\S]*?)\n\}\);/)?.[1] ?? '';
  const limited = new Set([...limitsBlock.matchAll(/(\w+):\s*\[/g)].map(m => m[1]));
  // Booleans and strings are validated by their own branch in assignLoadedSettings, not by limits.
  const numericWeather = weatherKeys.filter(k => !/Visible$|Enabled$|DepthWrite$|FollowsSun$|Tint$|Source$|Color$/.test(k));
  const unlimited = numericWeather.filter(k => !limited.has(k));
  ok(unlimited.length === 0, `every numeric weather setting is clamped on load${unlimited.length ? `: missing ${unlimited.join(', ')}` : ''}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
