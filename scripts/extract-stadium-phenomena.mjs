#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Matrix4, Vector3 } from 'three';
import { readRig } from '../pokemon-rig.js';

const MODEL_ARCHIVE_START = 0x920000;
const FRAGMENT_VADDR_MIN = 0x81000000;
const FRAGMENT_VADDR_MAX = 0x90000000;
const FRAME_RATE = 30;

function u16(data, offset) {
  return data.readUInt16BE(offset);
}

function s16(data, offset) {
  return data.readInt16BE(offset);
}

function u32(data, offset) {
  return data.readUInt32BE(offset);
}

function ptrOffset(value) {
  if (value >= FRAGMENT_VADDR_MIN && value < FRAGMENT_VADDR_MAX) return value & 0xfffff;
  return value;
}

export function decompressYay0(source) {
  if (source.subarray(0, 8).toString('ascii') === 'PERS-SZP') {
    const headerSize = u32(source, 8);
    return decompressYay0(source.subarray(headerSize));
  }
  if (source.subarray(0, 4).toString('ascii') !== 'Yay0') return Buffer.from(source);
  const size = u32(source, 4);
  let maskOffset = 16;
  let linkOffset = u32(source, 8);
  let chunkOffset = u32(source, 12);
  let mask = 0;
  let bitsLeft = 0;
  let outputOffset = 0;
  const output = Buffer.alloc(size);

  while (outputOffset < size) {
    if (bitsLeft === 0) {
      mask = u32(source, maskOffset);
      maskOffset += 4;
      bitsLeft = 32;
    }
    if ((mask & 0x80000000) !== 0) {
      output[outputOffset++] = source[chunkOffset++];
    } else {
      const link = u16(source, linkOffset);
      linkOffset += 2;
      const distance = (link & 0x0fff) + 1;
      let length = link >>> 12;
      if (length === 0) length = source[chunkOffset++] + 18;
      else length += 2;
      for (let i = 0; i < length && outputOffset < size; i += 1) {
        output[outputOffset] = output[outputOffset - distance];
        outputOffset += 1;
      }
    }
    mask = (mask << 1) >>> 0;
    bitsLeft -= 1;
  }
  return output;
}

export function readBinArchive(rom, start = MODEL_ARCHIVE_START) {
  const flags = u16(rom, start);
  const fragmentId = u16(rom, start + 2);
  const dataOffset = u32(rom, start + 4);
  const totalSize = u32(rom, start + 8);
  const fileCount = u32(rom, start + 12);
  const files = [];
  for (let index = 0; index < fileCount; index += 1) {
    const entry = start + 16 + index * 16;
    const offset = u32(rom, entry);
    const size = u32(rom, entry + 4);
    files.push({ index, offset, size, data: rom.subarray(start + dataOffset + offset, start + dataOffset + offset + size) });
  }
  return { flags, fragmentId, dataOffset, totalSize, fileCount, files };
}

export function relocateFragment(source) {
  const data = Buffer.from(source);
  if (data.subarray(8, 16).toString('ascii') !== 'FRAGMENT') throw new Error('Not a Stadium FRAGMENT');
  const relocOffset = u32(data, 0x14);
  const sizeInRam = u32(data, 0x1c);
  const relocationCount = u32(data, relocOffset);
  const relocations = [];
  for (let i = 0; i < relocationCount; i += 1) {
    const word = u32(data, relocOffset + 4 + i * 4);
    relocations.push({ type: (word >>> 24) & 0x7f, offset: word & 0xffffff });
  }
  return { data, relocOffset, sizeInRam, relocations };
}

function rootOffset(fragment) {
  // Every model entry point is the tiny `lui/addiu/jr` getter emitted by the
  // Stadium linker. Decode its returned pointer instead of emulating MIPS.
  for (let offset = 0x20; offset < 0x50; offset += 4) {
    const lui = u32(fragment, offset);
    if ((lui >>> 26) !== 0x0f) continue;
    const register = (lui >>> 16) & 0x1f;
    for (let next = offset + 4; next <= offset + 12; next += 4) {
      const instruction = u32(fragment, next);
      const opcode = instruction >>> 26;
      const sourceRegister = (instruction >>> 21) & 0x1f;
      const targetRegister = (instruction >>> 16) & 0x1f;
      if ((opcode === 0x09 || opcode === 0x0d) && sourceRegister === register && targetRegister === register) {
        const low = opcode === 0x09 ? s16(fragment, next + 2) : u16(fragment, next + 2);
        return ptrOffset((((lui & 0xffff) << 16) + low) >>> 0);
      }
    }
  }
  throw new Error('Could not decode model fragment root pointer');
}

function pointerArray(data, offset, expectedCount = 0) {
  const result = [];
  const limit = expectedCount || 512;
  for (let i = 0; i < limit; i += 1) {
    const value = u32(data, offset + i * 4);
    if (value === 0) break;
    result.push(ptrOffset(value));
  }
  return result;
}

export function inspectModelFragment(compressed, species = 0) {
  const unpacked = decompressYay0(compressed);
  const { data, relocOffset, sizeInRam, relocations } = relocateFragment(unpacked);
  const root = rootOffset(data);
  const skeletalCount = data[root + 4];
  const auxiliaryCount = data[root + 5];
  const modelPointers = pointerArray(data, ptrOffset(u32(data, root + 8)), data[root + 3]);
  const skeletalPointers = pointerArray(data, ptrOffset(u32(data, root + 12)), skeletalCount);
  const auxiliaryPointers = pointerArray(data, ptrOffset(u32(data, root + 16)), auxiliaryCount);
  return {
    species,
    unpackedBytes: unpacked.length,
    relocOffset,
    sizeInRam,
    root,
    skeletalCount,
    auxiliaryCount,
    modelPointers,
    skeletalPointers,
    auxiliaryPointers,
    relocations,
    data,
  };
}

export function parseAuxiliaryAnimation(data, offset, textureCount = 256) {
  if (offset == null || offset < 0 || offset + 20 > data.length) return null;
  const flags = s16(data, offset);
  const start = s16(data, offset + 4);
  const loop = s16(data, offset + 6);
  const channelCount = u16(data, offset + 8);
  const frameCount = u16(data, offset + 10);
  const channelMap = ptrOffset(u32(data, offset + 12));
  const frameData = ptrOffset(u32(data, offset + 16));
  if (channelCount < 1 || channelCount > 32 || frameCount < 1 || frameCount > 4096) return null;
  if (channelMap + channelCount * 4 > data.length || frameData + frameCount > data.length) return null;
  const channels = [];
  for (let channel = 0; channel < channelCount; channel += 1) {
    const length = u16(data, channelMap + channel * 4);
    const frameOffset = u16(data, channelMap + channel * 4 + 2);
    const indices = [];
    for (let frame = 0; frame < frameCount; frame += 1) {
      const sourceFrame = Math.min(frame, Math.max(0, length - 1)) + frameOffset;
      indices.push(data[frameData + sourceFrame]);
    }
    channels.push({ channel, length, frameOffset, textures: indices, valid: indices.every(index => index < textureCount) });
  }
  return { flags, start, loop, frameCount, channels };
}

export function parseGLB(bytes) {
  if (u32(bytes, 0) !== 0x676c5446) throw new Error('Not a GLB');
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8').replace(/\0+$/u, ''));
  const binHeader = 20 + jsonLength;
  const binLength = bytes.readUInt32LE(binHeader);
  return { json, bin: bytes.subarray(binHeader + 8, binHeader + 8 + binLength) };
}

function textureMaterials(json, textures) {
  const wanted = new Set(textures);
  const exact = new Set([textures[0]]);
  const candidates = [];
  for (let index = 0; index < (json.materials?.length || 0); index += 1) {
    const texture = json.materials[index]?.pbrMetallicRoughness?.baseColorTexture?.index;
    if (wanted.has(texture)) candidates.push({ index, texture, exact: exact.has(texture) });
  }
  const exactMatches = candidates.filter(candidate => candidate.exact);
  return (exactMatches.length ? exactMatches : candidates).map(candidate => candidate.index);
}

function ambientScore(animation) {
  if (!animation.channels.length || animation.channels.some(channel => !channel.valid || !channel.materials.length)) return -Infinity;
  const distinct = new Set(animation.channels.flatMap(channel => channel.textures)).size;
  if (distinct < 2 || distinct > 8 || animation.frameCount > 90) return -Infinity;
  const returnsHome = animation.channels.every(channel => channel.textures.at(-1) === channel.textures[0]);
  return (returnsHome ? 1000 : 0) - animation.frameCount - distinct * 2;
}

function inferTailFlame(json, bin, rig) {
  const tail = rig.chains
    .filter(chain => rig.geometry.get(chain.tip)?.count)
    .sort((a, b) => rig.geometry.get(a.tip).centroid.z - rig.geometry.get(b.tip).centroid.z)[0];
  if (!tail) return null;
  const boneKey = tail.tip;
  const bone = rig.byKey.get(boneKey);
  const geometry = rig.geometry.get(boneKey);
  if (!geometry || !bone) return null;
  // The exporter kept Stadium's billboard as an 8-vertex BLEND primitive on the final tail bone. It is
  // useful as attachment metadata even though the runtime replaces its visible sheet: its centroid is
  // the original flame centre and its bounds carry the artist-authored effect scale.
  const point = new Vector3(geometry.centroid.x, geometry.centroid.y, geometry.centroid.z);
  point.applyMatrix4(new Matrix4().fromArray(bone.restWorld).invert());
  const extent = Math.max(
    geometry.max.x - geometry.min.x,
    geometry.max.y - geometry.min.y,
    geometry.max.z - geometry.min.z,
  );
  const replacesMaterials = (json.materials || [])
    .map((material, index) => ({ material, index }))
    .filter(({ material }) => material.alphaMode === 'BLEND' && material.doubleSided)
    .map(({ index }) => index);
  return {
    type: 'tail-flame',
    anchor: { bone: boneKey, node: bone.node, offset: point.toArray(), source: 'exported-flame-quad-centroid' },
    scale: Number((extent * 0.72).toFixed(5)),
    replacesMaterials,
    source: 'authored-effect-from-rom-attachment-phenomenon',
  };
}

export function extractSpeciesPhenomena(model, glbBytes, dex) {
  const { json, bin } = parseGLB(glbBytes);
  const animations = [];
  for (let index = 0; index < model.auxiliaryPointers.length; index += 1) {
    const parsed = parseAuxiliaryAnimation(model.data, model.auxiliaryPointers[index], json.textures?.length || 0);
    if (!parsed) continue;
    const channels = parsed.channels.map(channel => ({
      channel: channel.channel,
      textures: channel.textures,
      materials: textureMaterials(json, channel.textures),
      valid: channel.valid,
    }));
    animations.push({ index, flags: parsed.flags, start: parsed.start, loop: parsed.loop, frameCount: parsed.frameCount, channels });
  }
  const eligible = animations.map((animation, index) => ({ index, score: ambientScore(animation) }))
    .filter(candidate => Number.isFinite(candidate.score))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const rig = readRig(json, bin);
  const effects = [4, 5, 6].includes(dex) ? [inferTailFlame(json, bin, rig)].filter(Boolean) : [];
  return {
    rigHash: rig.hash,
    textureAnimations: animations,
    ambientTextureAnimation: eligible[0]?.index ?? null,
    effects,
  };
}

function parseArgs(argv) {
  const args = { rom: null, out: 'models/stadium/phenomena.json', inspect: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--rom') args.rom = argv[++i];
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--inspect') args.inspect = Number(argv[++i]);
    else if (!args.rom) args.rom = argv[i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.rom) throw new Error('Usage: node scripts/extract-stadium-phenomena.mjs --rom <Pokemon Stadium US.z64> [--out file]');
  const romPath = resolve(args.rom);
  const rom = await readFile(romPath);
  const archive = readBinArchive(rom);
  if (args.inspect) {
    const index = args.inspect - 1;
    const model = inspectModelFragment(archive.files[index].data, args.inspect);
    const summary = { ...model, data: undefined, relocations: model.relocations.slice(-24) };
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const manifestPath = resolve('models/stadium/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const output = {
    version: 1,
    source: { game: 'Pokemon Stadium (USA)', rom: basename(romPath), archiveOffset: MODEL_ARCHIVE_START, frameRate: FRAME_RATE },
    species: {},
  };
  for (let dex = 1; dex <= 151; dex += 1) {
    const entry = manifest[String(dex).padStart(3, '0')];
    if (!entry) continue;
    const model = inspectModelFragment(archive.files[dex - 1].data, dex);
    const glb = await readFile(resolve('models/stadium', entry.file));
    const phenomena = extractSpeciesPhenomena(model, glb, dex);
    if (phenomena.textureAnimations.length || phenomena.effects.length) {
      output.species[String(dex).padStart(3, '0')] = phenomena;
    }
  }
  await writeFile(resolve(args.out), `${JSON.stringify(output, null, 2)}\n`);
  console.log(`Wrote ${args.out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}
