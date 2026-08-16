/**
 * move-registry.js — the table of Pokémon moves the demo can cast, and which effect draws each one.
 *
 * A move is a name, a type, an effect key (`fx`), a palette that effect knows, and a few numbers the
 * effect reads at cast time. Nothing here draws; the harness looks up `fx` in the map of effect
 * factories it built (see `demos/pokemon-moves.html`) and hands the rest through `cast()`.
 *
 * `power` scales the effect (count, width, brightness); `travelSpeed` is metres per second along the
 * line, and `travelTime` (seconds) wins over it when set. `self` marks moves that play on the attacker.
 *
 * Pure data; `test-move-registry.mjs` checks every row names an effect and a palette that exist.
 */

export const TYPE_COLORS = Object.freeze({
  electric: '#f5d33b', fire: '#ee7a3a', water: '#4f8fe8', ice: '#8fd8e0', rock: '#b8a05a', ground: '#d9b46a',
  psychic: '#ee5aa0', dark: '#6b5a7a', fairy: '#f2a5d8', dragon: '#7a5ae8', ghost: '#7460a8', normal: '#b8b8a8',
});

/** Effect keys and the palettes each one ships. Kept here so a typo in a move row is caught in Node. */
export const FX_PALETTES = Object.freeze({
  bolt: ['electric', 'dark', 'fairy'],
  stream: ['fire', 'water', 'dragon', 'ice'],
  crystals: ['ice', 'stone', 'psychic'],
  fissure: ['magma', 'shadow', 'earth'],
  aurora: ['aurora', 'spectrum', 'ice'],
});

export const MOVES = Object.freeze([
  { name: 'Thunderbolt', type: 'electric', fx: 'bolt', palette: 'electric', power: 1.0, travelTime: 0.12,
    blurb: 'A bolt of filaments from the mouth to the target, then a restrike or two.' },
  { name: 'Dark Pulse', type: 'dark', fx: 'bolt', palette: 'dark', power: 1.1, travelTime: 0.2,
    blurb: 'The same bolt strip in black and violet, slower and fatter.' },
  { name: 'Dazzling Gleam', type: 'fairy', fx: 'bolt', palette: 'fairy', power: 0.9, travelTime: 0.1,
    blurb: 'Pink-white filaments with a bright flash at both ends.' },

  { name: 'Flamethrower', type: 'fire', fx: 'stream', palette: 'fire', power: 1.0, travelSpeed: 9,
    blurb: 'A cone of fire that reaches the target and holds there.' },
  { name: 'Water Gun', type: 'water', fx: 'stream', palette: 'water', power: 0.9, travelSpeed: 11,
    blurb: 'A translucent jet that sags under gravity and splashes on arrival.' },
  { name: 'Dragon Breath', type: 'dragon', fx: 'stream', palette: 'dragon', power: 1.1, travelSpeed: 8,
    blurb: 'Violet and teal, additive, wider than fire.' },
  { name: 'Ice Beam', type: 'ice', fx: 'stream', palette: 'ice', power: 0.9, travelSpeed: 14,
    blurb: 'A tight pale beam with sparkle.' },

  { name: 'Ice Shard', type: 'ice', fx: 'crystals', palette: 'ice', power: 0.8, travelSpeed: 10,
    blurb: 'Crystals tear out of the ground along the line, small near the feet, blades at the far end.' },
  { name: 'Stone Edge', type: 'rock', fx: 'crystals', palette: 'stone', power: 1.2, travelSpeed: 8,
    blurb: 'The same eruption in rock, bigger and slower.' },
  { name: 'Psyshock', type: 'psychic', fx: 'crystals', palette: 'psychic', power: 0.9, travelSpeed: 12,
    blurb: 'Glowing magenta shards.' },

  { name: 'Fissure', type: 'ground', fx: 'fissure', palette: 'magma', power: 1.0, travelSpeed: 6,
    blurb: 'A crack tears open toward the target, glowing white-hot at the front, and bursts under it.' },
  { name: 'Earthquake', type: 'ground', fx: 'fissure', palette: 'earth', power: 1.3, travelSpeed: 7,
    blurb: 'A dull brown crack with dust and no glow.' },
  { name: 'Night Daze', type: 'dark', fx: 'fissure', palette: 'shadow', power: 0.9, travelSpeed: 8,
    blurb: 'A violet-black rift.' },

  { name: 'Aurora Veil', type: 'ice', fx: 'aurora', palette: 'aurora', power: 1.0, self: true,
    blurb: 'Curtains of light unfurl in a ring around the attacker and hold.' },
  { name: 'Cosmic Power', type: 'psychic', fx: 'aurora', palette: 'spectrum', power: 1.0, self: true,
    blurb: 'The same curtains cycling through the spectrum.' },
  { name: 'Mist', type: 'ice', fx: 'aurora', palette: 'ice', power: 0.8, self: true,
    blurb: 'Pale white-blue veils.' },
]);

export const MOVES_BY_NAME = Object.freeze(Object.fromEntries(MOVES.map(m => [m.name, m])));

/** Rows grouped by type in registry order, for a menu. */
export function movesByType(list = MOVES) {
  const out = new Map();
  for (const m of list) { if (!out.has(m.type)) out.set(m.type, []); out.get(m.type).push(m); }
  return out;
}

/** Everything wrong with the table, as strings. Empty means the table is sound. */
export function validateMoves(list = MOVES, palettes = FX_PALETTES) {
  const bad = [];
  const seen = new Set();
  for (const m of list) {
    if (!m.name) bad.push('a move has no name');
    if (seen.has(m.name)) bad.push(`${m.name}: duplicate name`);
    seen.add(m.name);
    if (!palettes[m.fx]) bad.push(`${m.name}: unknown fx '${m.fx}'`);
    else if (!palettes[m.fx].includes(m.palette)) bad.push(`${m.name}: fx '${m.fx}' has no palette '${m.palette}'`);
    if (!TYPE_COLORS[m.type]) bad.push(`${m.name}: unknown type '${m.type}'`);
    if (!(m.power > 0)) bad.push(`${m.name}: power must be > 0`);
    if (!m.self && !(m.travelSpeed > 0) && !(m.travelTime > 0)) bad.push(`${m.name}: needs travelSpeed or travelTime`);
  }
  return bad;
}
