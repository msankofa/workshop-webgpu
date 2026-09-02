// The wheel's geometry and its selection rule. These are the parts that can be wrong in a way no
// screenshot shows: a wedge that is one place out, or a ring that changes group when it should be
// locked. The DOM half is not tested here and cannot be without a browser.
// Run: node test-wheel-menu.mjs
import { wedgeIndexAt, wedgePosition, wheelSelect } from './wheel-menu.js';

let failed = 0;
function ok(cond, msg, detail = '') { if (!cond) { failed++; console.error('FAIL:', msg, detail); } }
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ── which wedge a direction points at ───────────────────────────────────────
// Wedge 0 is at 12 o'clock and they go clockwise, which is what the layout draws.
ok(wedgeIndexAt(0, -100, 4) === 0, 'up is wedge 0');
ok(wedgeIndexAt(100, 0, 4) === 1, 'right is wedge 1 of 4');
ok(wedgeIndexAt(0, 100, 4) === 2, 'down is wedge 2 of 4');
ok(wedgeIndexAt(-100, 0, 4) === 3, 'left is wedge 3 of 4');
ok(wedgeIndexAt(0, -100, 5) === 0, 'up is wedge 0 of 5 too');
ok(wedgeIndexAt(-1, -100, 5) === 0, 'and a hair off up still is');

// Every direction lands on exactly one wedge, and each wedge is reachable.
for (const count of [2, 3, 4, 5, 6, 10]) {
  const seen = new Set();
  for (let deg = 0; deg < 360; deg++) {
    const a = (deg * Math.PI) / 180;
    const i = wedgeIndexAt(Math.sin(a) * 50, -Math.cos(a) * 50, count);
    ok(Number.isInteger(i) && i >= 0 && i < count, `count ${count} deg ${deg} gives a real index`, String(i));
    seen.add(i);
  }
  ok(seen.size === count, `every one of ${count} wedges is reachable`, `${seen.size} reached`);
}
ok(wedgeIndexAt(0, -100, 0) === -1, 'an empty ring selects nothing');

// ── where a wedge is drawn ──────────────────────────────────────────────────
let p = wedgePosition(0, 4, 100);
ok(near(p.x, 0) && near(p.y, -100), 'wedge 0 is drawn at the top', JSON.stringify(p));
p = wedgePosition(1, 4, 100);
ok(near(p.x, 100) && near(p.y, 0), 'wedge 1 of 4 is drawn to the right', JSON.stringify(p));
// Drawing and picking have to agree, or the highlight sits on the wrong label.
for (const count of [3, 4, 5, 7]) {
  for (let i = 0; i < count; i++) {
    const q = wedgePosition(i, count, 120);
    ok(wedgeIndexAt(q.x, q.y, count) === i, `drawing and picking agree for ${i} of ${count}`);
  }
}

// ── the selection rule ──────────────────────────────────────────────────────
const GROUPS = [
  { id: 'weapon', label: 'Weapon' },                                             // no options
  { id: 'bots', label: 'Bots', options: [{ id: 'rifleman' }, { id: 'medic' }, { id: 'sniper' }] },
  { id: 'lights', label: 'Lights', options: [{ id: 'lantern' }, { id: 'ember' }] },
  { id: 'air', label: 'Aircraft', options: [{ id: 'low' }, { id: 'high' }] },
];
const start = { groupIndex: 1, optionIndex: 0, locked: -1, dist: 0 };

// A light touch changes nothing, so releasing straight away is a safe no-op.
let s = wheelSelect(start, GROUPS, 3, -4);
ok(s.groupIndex === 1 && s.optionIndex === 0 && s.locked === -1, 'under the threshold nothing moves');

// Inside the split, direction picks the group.
s = wheelSelect(start, GROUPS, 0, -40);
ok(s.groupIndex === 0 && s.locked === -1, 'up picks the first group', String(s.groupIndex));
s = wheelSelect(start, GROUPS, 40, 0);
ok(s.groupIndex === 1, 'right picks the second');

// Past the split, the group LOCKS and direction picks the option instead. This is the whole reason
// two rings work: the options span the full circle, which they could not if the angle still had to
// mean a group as well.
const onBots = { groupIndex: 1, optionIndex: 0, locked: -1, dist: 0 };
s = wheelSelect(onBots, GROUPS, 0, -100);
ok(s.locked === 1, 'pushing out locks the group it was on', String(s.locked));
ok(s.groupIndex === 1, 'and the group does not change');
ok(s.optionIndex === 0, 'up in the outer ring is the first option');
s = wheelSelect(s, GROUPS, 100, 0);
ok(s.groupIndex === 1, 'sweeping the outer ring never changes the group', String(s.groupIndex));
ok(s.optionIndex === 1, 'but it does change the option', String(s.optionIndex));
s = wheelSelect(s, GROUPS, -100, 0);
ok(s.groupIndex === 1 && s.optionIndex === 2, 'the far side of the outer ring is the third option', `${s.groupIndex}/${s.optionIndex}`);

// Coming back inside unlocks, so you can change your mind without letting go of the key.
s = wheelSelect(s, GROUPS, -40, 0);
ok(s.locked === -1, 'coming back in unlocks');
ok(s.groupIndex === 3, 'and the direction picks a group again', String(s.groupIndex));

// A group with no options never locks, however far out you push.
const onWeapon = { groupIndex: 0, optionIndex: 0, locked: -1, dist: 0 };
s = wheelSelect(onWeapon, GROUPS, 0, -400);
ok(s.locked === -1, 'a group with no options never locks');
ok(s.groupIndex === 0, 'and stays selected');

// Switching group carries that group's own current option, not the last one's index.
const withActive = [
  { id: 'a', label: 'A', options: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }], activeIndex: 0 },
  { id: 'b', label: 'B', options: [{ id: 'b1' }, { id: 'b2' }], activeIndex: 1 },
];
s = wheelSelect({ groupIndex: 0, optionIndex: 2, locked: -1, dist: 0 }, withActive, 0, 40);
ok(s.groupIndex === 1, 'moved to the second group', String(s.groupIndex));
ok(s.optionIndex === 1, 'and took that group\'s own option, not index 2', String(s.optionIndex));

// The option index can never point past the end of a shorter list.
for (const [dx, dy] of [[0, -100], [100, 0], [0, 100], [-100, 0], [70, 70], [-70, -70]]) {
  const r = wheelSelect({ groupIndex: 2, optionIndex: 0, locked: 2, dist: 0 }, GROUPS, dx, dy);
  const len = GROUPS[r.groupIndex].options?.length ?? 0;
  ok(r.optionIndex < Math.max(1, len), `option stays inside the list at ${dx},${dy}`, `${r.optionIndex} of ${len}`);
}

// ── the shape base-game.html actually builds ────────────────────────────────
// Five groups, and the option counts the dev gun really has. The thing that would quietly ruin this
// is an option no gesture can reach -- the fifth bot role, say -- which no screenshot would show.
const DEV = [
  { id: 'off', label: 'Weapon' },
  { id: 'bots', label: 'Bots', options: 'rifleman medic squadleader sniper technical'.split(' ').map((id) => ({ id })) },
  { id: 'lights', label: 'Lights', options: 'lantern ember floater flare'.split(' ').map((id) => ({ id })) },
  { id: 'vehicles', label: 'Ground craft', options: 'ugv buggy'.split(' ').map((id) => ({ id })) },
  { id: 'sentinel', label: 'Aircraft', options: 'low high'.split(' ').map((id) => ({ id })) },
];
// Sweep the whole circle at an inner radius: every group must come up, including the way out.
{
  const reached = new Set();
  for (let deg = 0; deg < 360; deg++) {
    const a = (deg * Math.PI) / 180;
    const r = wheelSelect({ groupIndex: 0, optionIndex: 0, locked: -1, dist: 0 }, DEV, Math.sin(a) * 40, -Math.cos(a) * 40);
    reached.add(DEV[r.groupIndex].id);
  }
  ok(reached.size === DEV.length, 'every dev-gun group is reachable from the inner ring', [...reached].join(' '));
  ok(reached.has('off'), 'including the way back to your weapon');
}
// And inside each group, sweep the outer ring: every option must come up.
for (let g = 0; g < DEV.length; g++) {
  const options = DEV[g].options;
  if (!options) continue;
  const reached = new Set();
  for (let deg = 0; deg < 360; deg++) {
    const a = (deg * Math.PI) / 180;
    const r = wheelSelect({ groupIndex: g, optionIndex: 0, locked: g, dist: 0 }, DEV, Math.sin(a) * 200, -Math.cos(a) * 200);
    ok(r.groupIndex === g, `sweeping ${DEV[g].id} never leaves it`, DEV[r.groupIndex].id);
    reached.add(options[r.optionIndex].id);
  }
  ok(reached.size === options.length, `every option of ${DEV[g].id} is reachable`, `${reached.size} of ${options.length}: ${[...reached].join(' ')}`);
}

console.log(failed ? `\nwheel-menu: ${failed} failure(s)` : '\nwheel-menu: all tests passed');
process.exit(failed ? 1 : 0);
