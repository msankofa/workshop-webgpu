import { listStates, saveState, deleteState } from './slider-state.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (cond) pass++; else fail++;
}

// Node has no localStorage global — stub it before calling anything that touches it.
globalThis.localStorage = (() => {
  let store = {};
  return {
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
  };
})();

ok(Object.keys(listStates()).length === 0, 'listStates starts empty');

saveState('sunset', { 'params.count': 18, 'rigP.elevation': 12 });
let states = listStates();
ok(Object.keys(states).length === 1, 'saveState adds one entry');
ok(states.sunset.values['rigP.elevation'] === 12, 'saveState stores the values object');
ok(typeof states.sunset.savedAt === 'string' && states.sunset.savedAt.length > 0, 'saveState stamps savedAt');

saveState('sunset', { 'params.count': 99 });
states = listStates();
ok(Object.keys(states).length === 1, 'saveState overwrites an existing name in place');
ok(states.sunset.values['params.count'] === 99, 'overwrite replaces the values object');

saveState('noon', { 'params.count': 5 });
ok(Object.keys(listStates()).length === 2, 'a second distinct name adds a second entry');

deleteState('sunset');
states = listStates();
ok(Object.keys(states).length === 1 && !states.sunset, 'deleteState removes only the named entry');
ok(!!states.noon, 'deleteState leaves other entries untouched');

deleteState('does-not-exist');
ok(Object.keys(listStates()).length === 1, 'deleteState on an unknown name is a no-op');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
