// test-base-game-clouds.mjs — the cloud decks: the octave generalisation against the original
// two-tap constants, the deck lifecycle (rebuild on an octave change, uniforms otherwise), the
// render-origin offset, the tint, and a headless GLSL build of the material at each octave count.
import * as THREE from 'three';
import { Clouds } from './clouds.js';
import { createBaseGameClouds, CLOUD_DECK_DEFAULTS } from './base-game-clouds.js';
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
  clouds.setDeck(0, { octaves: 5 });
  ok(clouds.decks[0].mesh.material !== beforeMaterial, 'an octave change rebuilds the material');
  ok(clouds.decks[0].mesh.octaves === 5, 'the rebuilt deck carries the new octave count');
  ok(near(clouds.decks[0].mesh.material._uCoverage.value, 0.7), 'the rebuild re-applies the other settings');
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
  ok(weatherKeys.length >= 27, `the page defaults every weather setting (found ${weatherKeys.length})`);
  ok(loopSuffixes.length === 10, `the deck loop builds all ten per-deck controls (found ${loopSuffixes.length})`);
  ok(missing.length === 0, `every weather setting has a panel control${missing.length ? `: missing ${missing.join(', ')}` : ''}`);

  const limitsBlock = html.match(/const NUMBER_LIMITS = Object\.freeze\(\{([\s\S]*?)\n\}\);/)?.[1] ?? '';
  const limited = new Set([...limitsBlock.matchAll(/(\w+):\s*\[/g)].map(m => m[1]));
  const numericWeather = weatherKeys.filter(k => !/Visible$|Enabled$|DepthWrite$|FollowsSun$|Tint$/.test(k));
  const unlimited = numericWeather.filter(k => !limited.has(k));
  ok(unlimited.length === 0, `every numeric weather setting is clamped on load${unlimited.length ? `: missing ${unlimited.join(', ')}` : ''}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
