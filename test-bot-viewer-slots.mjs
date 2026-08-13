// node test-bot-viewer-slots.mjs
// Covers the storage + state-merge half of bot-viewer-slots.js. The panel widget half needs a DOM
// and is left to browser QA.
import { readFile } from 'node:fs/promises';
import {
  readSlots, writeSlots, saveSlot, loadSlot, deleteSlot, pickKeys, assignKnown, SLOT_COUNT,
  PRESET_PREFIX, isPresetValue,
} from './bot-viewer-slots.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ''}`);
}

// Minimal localStorage stand-in.
function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

console.log('storage round-trip');
{
  const s = fakeStorage();
  check('empty group reads as {}', Object.keys(readSlots('maze', s)).length === 0);
  const entry = saveSlot('maze', 2, 'wide halls', { mazeCols: 12, mazeSeed: 7 }, s, '2026-07-25T10:00');
  check('saveSlot returns the entry', entry && entry.name === 'wide halls');
  check('entry carries the timestamp', entry.savedAt === '2026-07-25T10:00');
  const loaded = loadSlot('maze', 2, s);
  check('loadSlot returns the data', loaded && loaded.data.mazeCols === 12);
  check('empty index loads as null', loadSlot('maze', 3, s) === null);
  check('groups are independent', loadSlot('bots', 2, s) === null);
  check('stored under a namespaced key', [...s._map.keys()][0] === 'pcw:bv2:slots:maze');

  saveSlot('maze', 2, 'renamed', { mazeCols: 30 }, s);
  check('re-save overwrites in place', loadSlot('maze', 2, s).data.mazeCols === 30);
  check('re-save keeps one entry', Object.keys(readSlots('maze', s)).length === 1);

  deleteSlot('maze', 2, s);
  check('deleteSlot clears the slot', loadSlot('maze', 2, s) === null);
}

console.log('corrupt / hostile storage');
{
  const s = fakeStorage();
  s.setItem('pcw:bv2:slots:ui', '{not json');
  check('unparseable payload degrades to {}', Object.keys(readSlots('ui', s)).length === 0);
  s.setItem('pcw:bv2:slots:ui', '[1,2,3]');
  check('array payload degrades to {}', Object.keys(readSlots('ui', s)).length === 0);
  s.setItem('pcw:bv2:slots:ui', 'null');
  check('null payload degrades to {}', Object.keys(readSlots('ui', s)).length === 0);

  const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
  check('read on a throwing store degrades to {}', Object.keys(readSlots('ui', throwing)).length === 0);
  check('write on a throwing store reports false', writeSlots('ui', {}, throwing) === false);
  check('saveSlot on a full store returns null', saveSlot('ui', 1, 'x', {}, throwing) === null);

  const s2 = fakeStorage();
  s2.setItem('pcw:bv2:slots:bots', JSON.stringify({ 1: { name: 'no data' } }));
  check('entry with no data loads as null', loadSlot('bots', 1, s2) === null);
}

console.log('name handling');
{
  const s = fakeStorage();
  check('blank name falls back to "slot N"', saveSlot('ui', 4, '', {}, s).name === 'slot 4');
  check('long names are clamped to 40', saveSlot('ui', 5, 'x'.repeat(80), {}, s).name.length === 40);
  check('SLOT_COUNT is exported', Number.isInteger(SLOT_COUNT) && SLOT_COUNT > 0);
}

console.log('pickKeys');
{
  const src = { a: 1, b: false, c: undefined, d: 'x' };
  const out = pickKeys(src, ['a', 'b', 'c', 'missing']);
  check('picks present keys', out.a === 1 && out.b === false);
  check('skips undefined', !('c' in out));
  check('skips absent', !('missing' in out));
  check('skips unlisted', !('d' in out));
  check('null source yields {}', Object.keys(pickKeys(null, ['a'])).length === 0);
}

console.log('assignKnown');
{
  const live = { turnStiffness: 30, runMultiplier: 1.7, retreatEnabled: true };
  const n = assignKnown(live, { turnStiffness: 44, runMultiplier: 2.2, retreatEnabled: false });
  check('assigns every matching key', n === 3 && live.turnStiffness === 44 && live.retreatEnabled === false);

  const live2 = { threshold01: 0.6, retreatEnabled: true };
  assignKnown(live2, { threshold01: 'nope', retreatEnabled: 1 });
  check('type mismatch is dropped (string over number)', live2.threshold01 === 0.6);
  check('type mismatch is dropped (number over boolean)', live2.retreatEnabled === true);

  const live3 = { a: 1 };
  assignKnown(live3, { a: null, b: undefined });
  check('null/undefined are skipped', live3.a === 1 && !('b' in live3));

  const live4 = { a: 1 };
  assignKnown(live4, { a: 2, extra: 9 });
  check('unknown keys on the slot still land (forward compat)', live4.a === 2 && live4.extra === 9);

  const live5 = { a: 1, b: 2 };
  assignKnown(live5, { a: 9, b: 9 }, ['a']);
  check('an explicit key list is respected', live5.a === 9 && live5.b === 2);

  check('null target is a no-op', assignKnown(null, { a: 1 }) === 0);
  check('null source is a no-op', assignKnown({ a: 1 }, null) === 0);
}

console.log('preset value namespace');
{
  check('a preset value is recognised', isPresetValue(PRESET_PREFIX + 'all-1'));
  // The whole point of the prefix: a numbered slot and a preset can never resolve to each other,
  // so a shipped file can never overwrite what a user saved into slot 1.
  check('a numbered slot is not a preset', !isPresetValue('1'));
  check('a bare id is not a preset', !isPresetValue('all-1'));
  check('the prefix is stable', PRESET_PREFIX === 'preset:');
}

console.log('shipped presets file');
{
  const raw = await readFile(new URL('./bot-viewer-presets.json', import.meta.url), 'utf8');
  let file = null;
  try { file = JSON.parse(raw); } catch (err) { check('parses as JSON', false, err.message); }
  const presets = file?.presets || [];
  check('parses as JSON', !!file);
  check('carries at least one preset', presets.length > 0);
  check('every preset has an id, group and data',
    presets.every(p => p && typeof p.id === 'string' && p.id && typeof p.group === 'string' && p.data));
  check('ids are unique', new Set(presets.map(p => p.id)).size === presets.length);
  // Two defaults would make which one seeds a first-time visitor depend on array order.
  check('exactly one preset is the default', presets.filter(p => p.isDefault).length === 1);
  // An id that parses as a slot number would collide in the dropdown once the prefix is stripped.
  check('no id looks like a slot number', presets.every(p => !/^\d+$/.test(p.id)));
  const allGroup = presets.filter(p => p.group === 'all');
  check('the "all" group is populated', allGroup.length > 0);
  check('every "all" preset carries maze, bots and ui',
    allGroup.every(p => p.data.maze && p.data.bots && p.data.ui));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
