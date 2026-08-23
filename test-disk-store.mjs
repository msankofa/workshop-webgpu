// Tests for disk-store.js: the file is the source of truth, the browser copy is only a fallback.
import { createDiskStore, describeStatus } from './disk-store.js';

let pass = 0, fail = 0;
const problems = [];
const ok = (cond, label, detail = '') => {
  if (cond) { pass++; return true; }
  fail++; problems.push(`${label}${detail ? ' — ' + detail : ''}`);
  return false;
};
const eq = (a, b, label) => ok(a === b, label, `got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);
const tick = () => new Promise(r => setTimeout(r, 5));

function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
}

/** A stand-in server: `file` is what GET returns, `posts` records every write. */
function fakeServer({ file = null, failWrite = null, getStatus = null } = {}) {
  const posts = [];
  const fetchImpl = async (url, opts = {}) => {
    if (!opts.method) {
      if (getStatus) return { ok: false, status: getStatus };
      if (file == null) return { ok: false, status: 404 };
      return { ok: true, status: 200, text: async () => file };
    }
    posts.push(opts.body);
    if (failWrite) return { ok: true, status: 200, json: async () => ({ ok: false, error: failWrite }) };
    file = opts.body;
    return { ok: true, status: 200, json: async () => ({ ok: true, path: 'saves/doc.json' }) };
  };
  return { fetchImpl, posts, get file() { return file; } };
}

const make = (server, storage, extra = {}) => createDiskStore({
  read: '/saves/doc.json', write: '/api/save?filename=doc.json',
  storage, key: 'pcw:doc', fetchImpl: server.fetchImpl, debounceMs: 0, ...extra,
});

// --- loading ---------------------------------------------------------------------------------------
{
  const server = fakeServer({ file: '{"a":1}' });
  const store = make(server, fakeStorage({ 'pcw:doc': '{"a":999}' }));
  await store.load();
  eq(store.json().a, 1, 'disk wins over the browser copy when both exist');
  eq(store.status.source, 'disk', 'and the status says where it came from');
}

{
  // No file written yet: the browser copy is all there is, and it must not be thrown away.
  const server = fakeServer({ file: null });
  const store = make(server, fakeStorage({ 'pcw:doc': '{"a":7}' }));
  await store.load();
  eq(store.json().a, 7, 'a missing file falls back to the browser copy');
  eq(store.status.source, 'cache', 'and says so, so the page can warn');
}

{
  // Opened over file:// — fetch rejects outright rather than returning a status.
  const store = createDiskStore({
    read: '/saves/doc.json', write: '/api/save', storage: fakeStorage({ 'pcw:doc': '{"a":3}' }),
    key: 'pcw:doc', fetchImpl: async () => { throw new Error('Failed to fetch'); }, debounceMs: 0,
  });
  await store.load();
  eq(store.json().a, 3, 'no server at all still loads the browser copy');
  eq(store.status.source, 'cache', 'source is the cache');
}

{
  const server = fakeServer({ file: '<!doctype html><h1>Index of /saves</h1>' });
  const store = make(server, fakeStorage());
  await store.load();
  eq(store.json(), null, 'a directory listing is not mistaken for a document');
}

// --- saving ----------------------------------------------------------------------------------------
{
  const server = fakeServer({ file: null });
  const storage = fakeStorage();
  const store = make(server, storage);
  await store.load();
  store.setJSON({ a: 1 });
  eq(storage.map.get('pcw:doc'), '{"a":1}', 'the browser copy is written before the POST, not after');
  ok(store.dirty, 'and the store knows the file does not have it yet');
  await store.flush();
  eq(server.posts.length, 1, 'one write reached the server');
  eq(server.file, '{"a":1}', 'and the file now holds it');
  ok(!store.dirty, 'nothing is outstanding');
  eq(store.status.state, 'saved', 'status is saved');
}

{
  const server = fakeServer({ file: '{"a":1}' });
  const store = make(server, fakeStorage());
  await store.load();
  eq(store.setJSON({ a: 1 }), false, 'writing the same document again is a no-op');
  const r = await store.flush();
  ok(r.skipped, 'and flushing it writes nothing');
  eq(server.posts.length, 0, 'no POST was made');
}

{
  // Several edits in a row are one write, which is the whole point of autosaving on change.
  const server = fakeServer({ file: null });
  const store = make(server, fakeStorage(), { debounceMs: 20 });
  await store.load();
  store.setJSON({ n: 1 });
  store.setJSON({ n: 2 });
  store.setJSON({ n: 3 });
  eq(server.posts.length, 0, 'nothing is written during the quiet period');
  await new Promise(r => setTimeout(r, 40));
  eq(server.posts.length, 1, 'a burst of edits collapses into one write');
  eq(server.file, '{"n":3}', 'and the last one is what landed');
}

{
  const server = fakeServer({ file: null, failWrite: 'disk full' });
  const storage = fakeStorage();
  const store = make(server, storage);
  await store.load();
  store.setJSON({ a: 5 });
  const r = await store.flush();
  ok(!r.ok, 'a rejected write reports failure');
  eq(store.status.state, 'error', 'and the status shows it, rather than claiming saved');
  eq(storage.map.get('pcw:doc'), '{"a":5}', 'the browser copy still holds the work');
  ok(store.dirty, 'and the store still counts it as unwritten');
}

{
  // An edit made while a write is in flight must not be lost, and must not race it.
  const posts = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const store = createDiskStore({
    read: '/saves/doc.json', write: '/api/save', debounceMs: 0,
    fetchImpl: async (url, opts) => {
      if (!opts?.method) return { ok: false, status: 404 };
      posts.push(opts.body);
      if (posts.length === 1) await gate;
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  await store.load();
  store.setJSON({ n: 1 });
  const first = store.flush();
  await tick();
  store.setJSON({ n: 2 });
  const second = store.flush();
  release();
  await Promise.all([first, second]);
  eq(posts.length, 2, 'the edit made mid-write is written after it, not dropped');
  eq(posts[1], '{"n":2}', 'and it is the newer document');
  ok(!store.dirty, 'nothing outstanding at the end');
}

// --- the localStorage shim -------------------------------------------------------------------------
{
  const server = fakeServer({ file: '{"rows":[1,2]}' });
  const store = make(server, fakeStorage());
  await store.load();
  const shim = store.asStorage();
  eq(shim.getItem('anything'), '{"rows":[1,2]}', 'the shim reads the loaded document');
  shim.setItem('anything', '{"rows":[1,2,3]}');
  await store.flush();
  eq(server.file, '{"rows":[1,2,3]}', 'and a setItem through it reaches the file');
}

// --- the status line ---------------------------------------------------------------------------------
{
  eq(describeStatus({ state: 'saving', source: 'disk' }, { file: 'x.json' }), 'saving to x.json…',
    'saving reads plainly');
  ok(describeStatus({ state: 'error', error: 'nope', source: 'cache' }).includes('NOT saved'),
    'a failed save says so in words, not a colour');
  ok(describeStatus({ state: 'idle', source: 'cache' }).includes('start the server'),
    'a cache-only load tells the user what to do about it');
  eq(describeStatus({ state: 'idle', source: 'disk', pending: true }), 'unsaved changes',
    'pending work outranks the last success');
}

console.log(`${pass}/${pass + fail} disk-store checks passed`);
if (fail) {
  console.log('\nPROBLEMS:');
  for (const p of problems) console.log('  - ' + p);
  process.exit(1);
}
