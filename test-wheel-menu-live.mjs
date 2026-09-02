// The wheel driven end to end against a DOM stub: open, move, click, release. The geometry test
// covers the maths; this covers the thing the maths cannot, which is whether a gesture actually
// commits the right group and option. Run: node test-wheel-menu-live.mjs
import { createWheelMenu } from './wheel-menu.js';

let failed = 0;
function ok(cond, msg, detail = '') { if (!cond) { failed++; console.error('FAIL:', msg, detail); } }

// Enough DOM for the module: elements, a body to append to, and dispatchable mousedown.
function stubDoc() {
  const make = (tag) => ({
    tag, children: [], style: { cssText: '' }, listeners: {},
    className: '', type: '', _text: '', _html: '',
    set textContent(v) { this._text = v; },
    get textContent() { return this._text; },
    set innerHTML(v) { this._html = v; this.children.length = 0; },
    get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    remove() {},
    click() { for (const fn of this.listeners.mousedown || []) fn({ preventDefault() {} }); },
  });
  return { createElement: make, body: make('body') };
}

const GROUPS = () => [
  { id: 'off', label: 'Weapon' },
  { id: 'bots', label: 'Bots', activeIndex: 2, options: [{ id: 'rifleman', label: 'rifleman' }, { id: 'medic', label: 'medic' }, { id: 'sniper', label: 'sniper' }] },
  { id: 'lights', label: 'Lights', activeIndex: 0, options: [{ id: 'lantern', label: 'lantern' }, { id: 'ember', label: 'ember' }] },
  { id: 'air', label: 'Aircraft', activeIndex: 1, options: [{ id: 'low', label: 'low' }, { id: 'high', label: 'high' }] },
];

function wheel(active = { groupId: 'off', optionId: null }) {
  const doc = stubDoc();
  const commits = [];
  const w = createWheelMenu({ doc, getGroups: GROUPS, getActive: () => active, onCommit: (s) => commits.push(s), onCancel: () => commits.push('cancelled') });
  return { w, commits, doc };
}
const move = (w, x, y) => w.handleMouseMove({ movementX: x, movementY: y });

// ── a tap that never moves re-picks what was already there ──────────────────
{
  const { w, commits } = wheel({ groupId: 'lights', optionId: 'ember' });
  w.open();
  w.close(true);
  ok(commits.length === 1, 'a tap commits once', String(commits.length));
  ok(commits[0].groupId === 'lights' && commits[0].optionId === 'ember', 'and commits what was already selected', JSON.stringify(commits[0]));
}

// ── the whole gesture: out to a group, further out to its option, release ───
{
  const { w, commits } = wheel();
  w.open();
  move(w, 0, 40);                       // down: the third group of four is 'lights'
  ok(w.selection.groupId === 'lights', 'inner ring picked the group', w.selection.groupId);
  move(w, 0, 60);                       // further down, past the ring split: locks and picks
  ok(w.selection.groupId === 'lights', 'the group stays locked on the way out', w.selection.groupId);
  ok(w.selection.optionId === 'ember', 'the outer ring picked the option', w.selection.optionId);
  w.close(true);
  ok(commits.length === 1 && commits[0].groupId === 'lights' && commits[0].optionId === 'ember',
    'release commits both rings at once', JSON.stringify(commits[0]));
}

// ── coming back in changes group again ──────────────────────────────────────
// Deltas ACCUMULATE from the open; they do not reset per move. Down 100 then up 70 is still 30 down
// and still the same wedge, which is what the hand actually does.
{
  const { w } = wheel();
  w.open();
  move(w, 0, 100);                                    // out to lights' options
  ok(w.selection.groupId === 'lights', 'went out on lights', w.selection.groupId);
  move(w, 0, -70);                                    // net 30 down: inside the ring, same wedge
  ok(w.selection.groupId === 'lights', 'a partial pull back stays on the wedge', w.selection.groupId);
  move(w, 0, -70);                                    // net 40 up: a different wedge
  ok(w.selection.groupId === 'off', 'pulling past the middle picks a new group', w.selection.groupId);
}

// ── the way out is one pick ─────────────────────────────────────────────────
{
  const { w, commits } = wheel({ groupId: 'bots', optionId: 'sniper' });
  w.open();
  move(w, 0, -40);                                    // straight up is the first wedge
  ok(w.selection.groupId === 'off', 'up is the way out', w.selection.groupId);
  w.close(true);
  ok(commits[0].groupId === 'off', 'and one release puts the weapon back', JSON.stringify(commits[0]));
}

// ── a click on a wedge commits there and then, as the source's buttons do ───
{
  const { w, commits, doc } = wheel();
  w.open();
  const root = doc.body.children[0];
  const buttons = root.children;
  ok(buttons.length === 4, 'four groups drew four buttons', String(buttons.length));
  buttons[3].click();                                 // 'Aircraft'
  ok(!w.isOpen, 'a click closes the wheel');
  ok(commits.length === 1 && commits[0].groupId === 'air', 'and commits that group', JSON.stringify(commits[0]));
  ok(commits[0].optionId === 'high', 'with that group\'s own current option', String(commits[0].optionId));
}

// ── the outer ring is drawn for the selected group, and its buttons commit ──
{
  const { w, commits, doc } = wheel({ groupId: 'bots', optionId: 'rifleman' });
  w.open();
  const root = doc.body.children[0];
  ok(root.children.length === 4 + 3, 'the selected group draws its option ring too', String(root.children.length));
  root.children[4 + 1].click();                       // 'medic'
  ok(commits[0].groupId === 'bots' && commits[0].optionId === 'medic', 'an option button commits that option', JSON.stringify(commits[0]));
}

// ── cancelling commits nothing ──────────────────────────────────────────────
{
  const { w, commits } = wheel();
  w.open();
  move(w, 40, 0);
  w.close(false);
  ok(commits[0] === 'cancelled', 'a cancelled close commits nothing', JSON.stringify(commits));
}

// ── closing twice, and moving while shut, do nothing ────────────────────────
{
  const { w, commits } = wheel();
  w.open();
  w.close(true);
  w.close(true);
  ok(commits.length === 1, 'closing twice commits once', String(commits.length));
  move(w, 500, 500);
  ok(!w.isOpen && commits.length === 1, 'a move while shut is ignored');
}

// ── it reads the group list fresh on every open ─────────────────────────────
{
  const doc = stubDoc();
  let live = [{ id: 'a', label: 'A' }];
  const w = createWheelMenu({ doc, getGroups: () => live, getActive: () => ({ groupId: 'a' }), onCommit: () => {} });
  w.open();
  ok(doc.body.children[0].children.length === 1, 'one group, one button');
  w.close(false);
  live = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }];
  w.open();
  ok(doc.body.children[0].children.length === 3, 'a changed list is picked up on the next open', String(doc.body.children[0].children.length));
}

console.log(failed ? `\nwheel-menu live: ${failed} failure(s)` : '\nwheel-menu live: all tests passed');
process.exit(failed ? 1 : 0);
