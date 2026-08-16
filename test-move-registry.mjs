import { MOVES, MOVES_BY_NAME, FX_PALETTES, movesByType, validateMoves } from './moves/move-registry.js';

let fails = 0;
function check(name, fn) { try { fn(); console.log(`  ok   ${name}`); } catch (e) { fails++; console.log(`  FAIL ${name}\n       ${e.message}`); } }
const assert = (c, m) => { if (!c) throw new Error(m); };

check('every move names an effect and palette that exist', () => {
  const bad = validateMoves();
  assert(bad.length === 0, bad.join('; '));
});

check('every effect has at least one move, so nothing ships unused', () => {
  const used = new Set(MOVES.map(m => m.fx));
  for (const fx of Object.keys(FX_PALETTES)) assert(used.has(fx), `${fx} has no move`);
});

check('the validator catches a bad row', () => {
  const bad = validateMoves([{ name: 'X', type: 'lava', fx: 'bolt', palette: 'nope', power: 0 }]);
  assert(bad.length >= 3, `only caught: ${bad.join('; ')}`);
});

check('lookup and grouping agree with the list', () => {
  assert(MOVES_BY_NAME.Thunderbolt.fx === 'bolt', 'lookup');
  const groups = movesByType();
  assert([...groups.values()].flat().length === MOVES.length, 'grouping lost a move');
});

console.log(fails ? `\n${fails} check(s) failed` : '\nall checks passed');
process.exit(fails ? 1 : 0);
