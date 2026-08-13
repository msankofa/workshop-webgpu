// The combined save/restore added 2026-08-07, after "one save button that saves all settings".
//
// Two things are checked here that nothing else can catch:
//   1. onSaved fires with the right arguments, and a throwing onSaved cannot fail the save --
//      the disk mirror is a side effect, and losing a save because the server is down would be
//      strictly worse than the problem it solves.
//   2. The export filename the client builds still matches the pattern serve.py will accept.
//      Those two live in different files and different languages; nothing links them but this.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSlotSection, readSlots } from './bot-viewer-slots.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
const check = (label, ok, detail) => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures++;
  console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`);
};

// ── a DOM thin enough to build the slot widget ────────────────────────────────
function stubDom() {
  const make = (tag) => {
    const el = {
      tagName: tag, children: [], options: [], style: {}, dataset: {},
      textContent: '', value: '', disabled: false, handlers: {},
      append(...kids) { for (const k of kids) { this.children.push(k); if (k.tagName === 'option') this.options.push(k); } },
      appendChild(k) { this.append(k); return k; },
      addEventListener(type, fn) { this.handlers[type] = fn; },
      click() { this.handlers.click?.(); },
    };
    return el;
  };
  globalThis.document = { createElement: make };
}
stubDom();

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

console.log('onSaved (the disk mirror hook)');
{
  const storage = fakeStorage();
  const seen = [];
  const section = createSlotSection({
    group: 'all', label: 'everything', storage,
    capture: () => ({ hello: 'world' }),
    apply: () => {},
    onSaved: (group, index, entry) => seen.push({ group, index, entry }),
  });
  const [row, nameInput, buttons] = section.nodes;
  const select = row.children[1];
  select.value = '2';
  nameInput.value = 'my setup';
  buttons.children[0].click();   // Save

  check('the slot is written to storage', !!readSlots('all', storage)['2']);
  check('onSaved fired exactly once', seen.length === 1, `fired ${seen.length}x`);
  check('onSaved gets the group', seen[0]?.group === 'all');
  check('onSaved gets the slot index', String(seen[0]?.index) === '2');
  check('onSaved gets the saved entry, data and all',
    seen[0]?.entry?.data?.hello === 'world' && seen[0]?.entry?.name === 'my setup');
}
{
  const storage = fakeStorage();
  const section = createSlotSection({
    group: 'all', label: 'everything', storage,
    capture: () => ({ a: 1 }), apply: () => {},
    onSaved: () => { throw new Error('server is down'); },
  });
  const [row, , buttons] = section.nodes;
  row.children[1].value = '1';
  let threw = false;
  try { buttons.children[0].click(); } catch { threw = true; }
  check('a failing mirror does not throw out of the save', !threw);
  check('a failing mirror still leaves the slot saved', !!readSlots('all', storage)['1']);
}

// ── client filename vs. the server's allowlist ────────────────────────────────
console.log('\nexport filename contract (bot-viewer-v3.html <-> serve.py)');
const serve = fs.readFileSync(path.join(here, 'serve.py'), 'utf8');
const html = fs.readFileSync(path.join(here, 'bot-viewer-v3.html'), 'utf8');

const rx = /_SAFE_SLOT_FILENAME = re\.compile\(r'([^']+)'\)/.exec(serve);
check('serve.py declares a slot-export filename pattern', !!rx);
if (rx) {
  const serverRe = new RegExp(rx[1]);
  // Rebuild a name the same way exportSlotToDisk does.
  const stamp = '20260807211842';
  for (const group of ['all', 'maze', 'bots', 'ui']) {
    for (const slot of ['1', '6']) {
      const name = `bv2-${group}-slot${slot}-${stamp.slice(0, 8)}-${stamp.slice(8)}.json`;
      check(`server accepts ${name}`, serverRe.test(name));
    }
  }
  check('server rejects a traversal attempt', !serverRe.test('bv2-all-slot1-20260807-211842.json/../x'));
  check('server rejects an unknown group', !serverRe.test('bv2-evil-slot1-20260807-211842.json'));
}
check('the client builds the name that way', /bv2-\$\{group\}-slot\$\{index\}-/.test(html));
check('the export endpoint matches the route serve.py registers',
  /'\/api\/save-slot-export\?filename=/.test(html.replace(/`/g, "'"))
  && /\/api\/save-slot-export/.test(serve));
check('the mirror is fire-and-forget', /save-slot-export[\s\S]{0,300}?\.catch\(\(\) => \{\}\)/.test(html));

// ── wiring ────────────────────────────────────────────────────────────────────
console.log('\ncombined save / restore wiring');
check('captureAllState covers all three groups',
  /function captureAllState\(\)[\s\S]*?maze: captureMazeState\(\)[\s\S]*?bots: captureBotState\(\)[\s\S]*?ui: captureUiState\(\)/.test(html));
check('applyAllState restores maze, then bots, then ui',
  /applyMazeState\(data\.maze\);\s*applyBotState\(data\.bots\);\s*applyUiState\(data\.ui\);/.test(html));
check('the combined row is built and comes first in the card',
  /const allSlots = createSlotSection\(\{[\s\S]*?group: 'all'/.test(html)
  && /slotsBody\.append\(restoreRow, restoreStatus,\s*\.\.\.allSlots\.nodes/.test(html));
check('every group mirrors to disk', (html.match(/onSaved: exportSlotToDisk/g) || []).length >= 3);
check('the autosave is debounced, not per-event', /clearTimeout\(autosaveTimer\)/.test(html));
check('the autosave also runs when the page goes away', /addEventListener\('pagehide', writeAutosave\)/.test(html));
check('restoring is offered, never automatic',
  /Restore last session/.test(html) && !/applyAllState\(readAutosave/.test(html));
check('a full quota cannot break the panel', /catch \{ \/\* quota or a capture mid-rebuild/.test(html));

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
