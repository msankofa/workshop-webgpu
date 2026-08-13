// bake-ez-tree-presets.mjs
// Regenerates tree-presets.js from the upstream ez-tree preset JSONs.
//
//   node bake-ez-tree-presets.mjs            # fetch from GitHub
//   node bake-ez-tree-presets.mjs <dir>      # read <dir>/<name>.json instead
//
// trees.js is a port of ez-tree's generator, so nearly every field maps across 1:1. What does
// NOT map is written down in MAPPING_NOTES below and echoed into the generated file, because a
// silent approximation in baked data is impossible to spot later.
import { writeFileSync, readFileSync } from 'node:fs';
import { createTree } from './trees.js';

const SRC = 'https://raw.githubusercontent.com/dgreenheck/ez-tree/main/src/lib/presets';
const OUT = new URL('./tree-presets.js', import.meta.url);

// family key -> display name; species are the preset files in the listed order.
const FAMILIES = [
  { key: 'ash',     name: 'Ash',     presets: ['ash_small', 'ash_medium', 'ash_large'] },
  { key: 'aspen',   name: 'Aspen',   presets: ['aspen_small', 'aspen_medium', 'aspen_large'] },
  { key: 'oak',     name: 'Oak',     presets: ['oak_small', 'oak_medium', 'oak_large'] },
  { key: 'pine',    name: 'Pine',    presets: ['pine_small', 'pine_medium', 'pine_large'] },
  { key: 'bush',    name: 'Bush',    presets: ['bush_1', 'bush_2', 'bush_3'] },
  { key: 'trellis', name: 'Trellis', presets: ['trellis'] },
];

// tree-textures.js packs the leaf PNGs into a 2x2 atlas in this order.
const LEAF_CELL = { oak: 0, aspen: 1, ash: 2, pine: 3 };

const MAPPING_NOTES = [
  'bark.type / leaves.type name ez-tree texture files. tree-textures.js instead packs the four',
  'leaf PNGs into one 2x2 atlas and uses a single bark set, so leaves.type becomes a pinned',
  'atlas cell and bark.type is dropped (there is only one bark set to pick).',
  'branch.radius[level>0] is a MULTIPLIER on the parent radius in ez-tree, but an absolute cap in',
  'trees.js (radius = min(cap, parentRadius * 0.85)). The numbers are carried across unchanged:',
  'ez-tree multipliers sit near 1, so both land in the same range, but deep levels come out a',
  'little thicker here than upstream.',
  'bark.textureScale is dropped: the viewer overwrites bark.vScale from the active texture set.',
  'trellis.* is dropped entirely. trees.js has no trellis frame, so that preset bakes to the vine',
  'without anything to climb.',
];

async function loadPreset(name, dir) {
  if (dir) return JSON.parse(readFileSync(`${dir}/${name}.json`, 'utf8'));
  const res = await fetch(`${SRC}/${name}.json`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  return res.json();
}

// ez-tree stores per-level values as objects keyed by level ("0".."3"); trees.js wants arrays.
// Missing keys clamp to the previous level, matching trees.js's own short-array behaviour.
function levelArray(obj, first) {
  const out = [first];
  for (let i = 1; i <= 3; i++) out.push(obj?.[i] ?? out[i - 1]);
  return out;
}

function toTreeOpts(ez) {
  const b = ez.branch, l = ez.leaves;
  const mapped = {
    seed: ez.seed,
    levels: b.levels,
    evergreen: ez.type === 'evergreen',
    length: levelArray(b.length, b.length[0]),
    radius: levelArray(b.radius, b.radius[0]),
    taper: levelArray(b.taper, b.taper[0]),
    children: levelArray(b.children, b.children[0]),
    branchStart: levelArray(b.start, 0),
    angle: levelArray(b.angle, 0),
    gnarliness: levelArray(b.gnarliness, b.gnarliness[0]),
    twist: levelArray(b.twist, b.twist[0]),
    sections: levelArray(b.sections, b.sections[0]),
    segments: levelArray(b.segments, b.segments[0]),
    force: {
      direction: [b.force.direction.x, b.force.direction.y, b.force.direction.z],
      strength: b.force.strength,
    },
    bark: { color: ez.bark.tint, flatShading: !!ez.bark.flatShading },
    leaves: {
      count: l.count,
      size: l.size,
      sizeVariance: l.sizeVariance,
      start: l.start,
      angle: l.angle,
      doubleBillboard: l.billboard === 'double',
      tint: l.tint,
      alphaTest: l.alphaTest,
      atlas: LEAF_CELL[l.type] === undefined ? null : { cols: 2, rows: 2, cell: LEAF_CELL[l.type] },
    },
  };
  // Round-trip through trees.js so the baked opts is a COMPLETE options object (every slider in
  // tree-viewer.html binds to a path in it) rather than only the fields ez-tree happens to name.
  const tree = createTree(mapped);
  const full = structuredClone(tree.options);
  tree.dispose();
  return full;
}

const titleCase = s => s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// JSON.stringify, but numeric arrays stay on one line — a 4-entry per-level table is far easier
// to read and diff across presets as [15, 11, 7, 3] than as six lines.
function format(value, indent) {
  const pad = ' '.repeat(indent), padIn = ' '.repeat(indent + 2);
  if (Array.isArray(value)) {
    if (value.every(v => typeof v === 'number')) return `[${value.join(', ')}]`;
    return `[\n${value.map(v => padIn + format(v, indent + 2)).join(',\n')},\n${pad}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    return `{\n${keys.map(k => `${padIn}${JSON.stringify(k)}: ${format(value[k], indent + 2)}`).join(',\n')},\n${pad}}`;
  }
  return JSON.stringify(value);
}

const dir = process.argv[2] || null;
const families = [];
for (const fam of FAMILIES) {
  const species = [];
  for (const preset of fam.presets) {
    species.push({
      id: `ez-${preset}`,
      name: titleCase(preset),
      opts: toTreeOpts(await loadPreset(preset, dir)),
      parentSpeciesId: null,
      biomes: [],          // empty = every biome (see forest-placement.js placementRecords)
      density: 1,
      sizeRange: [0.8, 1.2],
      ageRange: [1, 1],
    });
  }
  // family ids are namespaced apart from species ids: the trellis family holds one preset of
  // the same name, and the viewer seeds on family id.
  families.push({ id: `ez-family-${fam.key}`, name: fam.name, species });
}

const header = [
  '// tree-presets.js',
  '// GENERATED by bake-ez-tree-presets.mjs — do not hand-edit; re-run the baker instead.',
  '//',
  '// The 16 stock presets from dgreenheck/ez-tree (MIT), converted to trees.js options and',
  '// grouped into families. tree-viewer.html seeds an empty families list with these so the',
  '// Species tab opens on the same starting set the upstream editor ships.',
  '//',
  '// What did not survive the conversion:',
  ...MAPPING_NOTES.map(line => `//   ${line}`),
  '',
  'export const EZ_TREE_FAMILIES = ' + format(families, 0) + ';',
  '',
  'export default EZ_TREE_FAMILIES;',
  '',
].join('\n');

writeFileSync(OUT, header);
console.log(`wrote tree-presets.js: ${families.length} families, ${families.reduce((n, f) => n + f.species.length, 0)} species`);
