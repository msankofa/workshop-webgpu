import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  ambientFrameAt, createPokemonPhenomena, textureIndexAt,
} from './pokemon-phenomena.js';
import { parseAuxiliaryAnimation } from './scripts/extract-stadium-phenomena.mjs';

let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks += 1; };

// The ROM structure consumed by func_800175E8/func_800176DC: one descriptor, one channel map, and bytes.
const raw = Buffer.alloc(96);
raw.writeInt16BE(2, 0);
raw.writeInt16BE(0, 4);
raw.writeInt16BE(0, 6);
raw.writeUInt16BE(1, 8);
raw.writeUInt16BE(10, 10);
raw.writeUInt32BE(0x8ff00020, 12);
raw.writeUInt32BE(0x8ff00030, 16);
raw.writeUInt16BE(10, 0x20);
raw.writeUInt16BE(0, 0x22);
Buffer.from([2, 2, 3, 3, 4, 4, 4, 3, 3, 2]).copy(raw, 0x30);
const parsed = parseAuxiliaryAnimation(raw, 0, 5);
check(parsed.frameCount === 10, 'reads the ROM frame count');
check(parsed.channels.length === 1, 'reads the ROM channel count');
check(parsed.channels[0].valid, 'accepts texture indices present in the GLB');
assert.deepEqual(parsed.channels[0].textures, [2, 2, 3, 3, 4, 4, 4, 3, 3, 2]); checks += 1;

check(ambientFrameAt({ frameCount: 10 }, 0) === 0, 'rests on the base texture between blinks');
check(ambientFrameAt({ frameCount: 10 }, 3.7) === 1, 'advances at the Stadium 30 fps rate');
check(ambientFrameAt({ frameCount: 10 }, 3.999) === 9, 'reaches the final blink frame');
check(textureIndexAt({ textures: [2, 3, 4] }, 99) === 4, 'clamps texture stream reads');

const original = { name: 'original' };
const material = { map: original };
const renderedMaterial = { map: original };
const renderedMesh = { isMesh: true, material: renderedMaterial };
const textures = new Map([[2, { name: 'open' }], [3, { name: 'closed' }]]);
const gltf = {
  parser: {
    associations: new Map([[renderedMesh, { meshes: 0, primitives: 0 }]]),
    json: { meshes: [{ primitives: [{ material: 0 }] }] },
    getDependency: async (kind, index) => kind === 'material' ? material : textures.get(index),
  },
  scene: { traverse: visitor => visitor(renderedMesh) },
};
const controller = await createPokemonPhenomena({
  THREE: {}, gltf,
  spec: {
    ambientTextureAnimation: 0,
    textureAnimations: [{ frameCount: 3, channels: [{ textures: [2, 3, 2], materials: [0] }] }],
    effects: [],
  },
});
check(controller.active, 'activates when a material has a ROM texture stream');
controller.update(0);
check(renderedMaterial.map === textures.get(2), 'applies the resting texture to the rendered primitive material');
controller.update(3.95);
check(renderedMaterial.map === textures.get(3), 'applies the blink texture to a loader-cloned material');
check(material.map === original, 'does not mistake the parser base material for the rendered clone');
controller.dispose();
check(renderedMaterial.map === original, 'restores the rendered GLTF material on disposal');

const sidecar = JSON.parse(await readFile('models/stadium/phenomena.json', 'utf8'));
check(sidecar.source.archiveOffset === 0x920000, 'records the verified Pokémon model archive offset');
check(Object.keys(sidecar.species).length >= 140, 'extracts auxiliary records for essentially the full dex');
const charmander = sidecar.species['004'];
assert.deepEqual(
  charmander.textureAnimations[0].channels[0].textures,
  [2, 2, 3, 3, 4, 4, 4, 3, 3, 2],
  'preserves Charmander’s documented open/half/closed eye stream',
); checks += 1;
check(charmander.textureAnimations[0].channels[0].materials.includes(2), 'routes that stream to Charmander material 2');
check(charmander.effects[0].anchor.node === 23 && charmander.effects[0].replacesMaterials.includes(9),
  'stores Charmander’s tail attachment and the placeholder material it replaces');
check(sidecar.species['025'].textureAnimations.some(animation => animation.channels.length > 1), 'preserves Pikachu multi-channel face animation');

console.log(`pokemon phenomena: ${checks} checks passed`);
