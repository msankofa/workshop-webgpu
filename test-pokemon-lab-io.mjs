// Checks on pokemon-lab-io.js. Run with `node test-pokemon-lab-io.mjs`.
//
// Two things here are cross-checks rather than unit tests, and they are the ones worth having. The
// filename the page saves to is matched against `serve.py`'s own whitelist regex, because a page that
// saves to a name the server rejects looks like it is working right up until you reload. And the
// manifest's clip list is compared against the actual .glb animations across the whole dex, because every
// label in the browse view is taken by index and would silently point at the wrong animation if that
// alignment ever broke.

import fs from 'node:fs';
import { readRigFromGLB } from './pokemon-rig.js';
import {
  emptyAnnotation, setSegment, setDone, putAnnotation, wholeClip, resolveSegment, ANNOTATION_VERSION,
} from './pokemon-annotation.js';
import {
  LAB_FILE, LAB_READ_URL, LAB_WRITE_URL, createLabStore, migrateLibrary, readLibrary, loadManifest,
  dexEntries, modelURL, clipLabels, suggestedIdle, speciesStatus, labSummary, STATUS_ORDER, STATUS_LABELS,
  rigMismatch, snapshotFilename, snapshotWriteURL,
} from './pokemon-lab-io.js';

let failures = 0;
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(`  ok   ${name}`); }
  catch (e) { failures++; results.push(`  FAIL ${name}\n       ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const eq = (a, b, msg) => assert(a === b, `${msg}: got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)}`);

const manifest = JSON.parse(fs.readFileSync('models/stadium/manifest.json', 'utf8'));
const dex = dexEntries(manifest);

console.log('\n--- the dex list ---');

await check('all 151 species come back, in dex order', () => {
  eq(dex.length, 151, 'species count');
  for (let i = 0; i < dex.length; i++) eq(dex[i].dex, i + 1, `entry ${i} dex number`);
});

await check('every species key is unique and names a file that exists', () => {
  const seen = new Set();
  for (const e of dex) {
    assert(!seen.has(e.species), `${e.species} appears twice`);
    seen.add(e.species);
    assert(fs.existsSync(`models/stadium/${e.species}.glb`), `no .glb for ${e.species}`);
    eq(e.file, `${e.species}.glb`, `${e.species} file name`);
  }
});

await check('the model URL is what the page will actually fetch', () => {
  eq(modelURL('025_pikachu'), './models/stadium/025_pikachu.glb', 'model url');
});

await check('every species has bones, triangles and at least six animations', () => {
  for (const e of dex) {
    assert(e.bones > 0, `${e.species} has no bones in the manifest`);
    assert(e.tris > 0, `${e.species} has no triangles in the manifest`);
    assert(e.clips.length >= 6, `${e.species} has only ${e.clips.length} clips`);
  }
});

console.log('\n--- clip labels, taken by index ---');

await check('the manifest clip list matches the .glb animations across the whole dex', () => {
  let compared = 0;
  for (const e of dex) {
    const { rig } = readRigFromGLB(fs.readFileSync(`models/stadium/${e.species}.glb`));
    eq(rig.clips.length, e.clips.length, `${e.species} clip count`);
    const labels = clipLabels(e);
    for (let i = 0; i < rig.clips.length; i++) {
      eq(labels[i].name, rig.clips[i].name, `${e.species} clip ${i} name`);
      const drift = Math.abs(labels[i].seconds - rig.clips[i].duration);
      assert(drift < 0.05, `${e.species} clip ${i} lasts ${rig.clips[i].duration}s, manifest says ${labels[i].seconds}s`);
      compared++;
    }
  }
  console.log(`       ${compared} clips compared against their .glb`);
});

await check('a label splits into a name and the note the manifest added', () => {
  const pikachu = dex.find(e => e.species === '025_pikachu');
  const c = clipLabels(pikachu)[0];
  eq(c.name, 'idle', 'first clip name');
  eq(c.note, 'standby loop', 'first clip note');
  eq(c.loop, true, 'idle loops');
  eq(c.frames, 40, 'idle frames');
});

await check('every species has a suggestible idle, and it is only a suggestion', () => {
  for (const e of dex) {
    const s = suggestedIdle(e);
    assert(s, `${e.species} has nothing to suggest as an idle`);
    assert(/^idle/.test(s.name), `${e.species} suggests ${s.name}, which is not an idle`);
  }
  // The suggestion never reaches the file on its own: a fresh annotation names no segments at all.
  eq(Object.keys(emptyAnnotation('025_pikachu').segments).length, 0, 'a fresh annotation names no segments');
});

await check('every clip in the dex runs at exactly 30fps, so a frame readout is meaningful', () => {
  // `seconds` is `frames / 30` rounded to three decimals on all 1,171 clips with no exceptions, which is
  // why the transport can show a frame number at all. The page still derives the rate per clip rather than
  // writing 30 down, so a model that broke this would show its own rate instead of a wrong frame count.
  let checked = 0;
  for (const e of dex) for (const c of clipLabels(e)) {
    const expected = Math.round((c.frames / 30) * 1000) / 1000;
    assert(Math.abs(c.seconds - expected) < 1e-9,
      `${e.species} clip ${c.index}: ${c.frames} frames in ${c.seconds}s is not 30fps`);
    assert(Math.round(c.frames / c.seconds) === 30 || c.seconds === 0,
      `${e.species} clip ${c.index} derives ${c.frames / c.seconds}fps`);
    checked++;
  }
  console.log(`       ${checked} clips, all 30fps`);
});

console.log('\n--- the file ---');

await check('the write filename matches the whitelist in serve.py', () => {
  const py = fs.readFileSync('serve.py', 'utf8');
  const block = py.match(/_SAFE_STADIUM_FILENAME = re\.compile\(\s*([\s\S]*?)\)\n/)?.[1];
  assert(block, 'could not find _SAFE_STADIUM_FILENAME in serve.py');
  const source = [...block.matchAll(/r'([^']*)'/g)].map(m => m[1]).join('');
  assert(source, 'could not read the regex source');
  const re = new RegExp(source);
  assert(re.test(LAB_FILE), `serve.py would reject ${LAB_FILE}`);
  const snap = snapshotFilename(new Date(2026, 7, 28, 9, 5, 3));
  eq(snap, 'pokemon-lab-20260828-090503.json', 'snapshot filename');
  assert(re.test(snap), `serve.py would reject the snapshot name ${snap}`);
  // And the names the walker already uses must still pass, since the regex is shared.
  for (const n of ['stadium-tuning.json', 'stadium-stances.json', 'stadium-trials.json']) {
    assert(re.test(n), `widening the regex broke ${n}`);
  }
  assert(!re.test('pokemon-lab.json.bak'), 'the regex accepts a name it should not');
  assert(!re.test('../pokemon-lab.json'), 'the regex accepts a traversal');
});

await check('the read and write URLs point at the same file', () => {
  assert(LAB_READ_URL.endsWith(`/${LAB_FILE}`), `read url is ${LAB_READ_URL}`);
  assert(LAB_WRITE_URL.includes(`filename=${LAB_FILE}`), `write url is ${LAB_WRITE_URL}`);
  eq(snapshotWriteURL('pokemon-lab-20260828-090503.json'),
    '/api/save-stadium?filename=pokemon-lab-20260828-090503.json', 'snapshot write url');
});

await check('the store reads the file, and falls back to the browser copy when there is no server', async () => {
  const doc = JSON.stringify({ version: 1, species: { '025_pikachu': { species: '025_pikachu', clips: { idle: 3 } } } });
  const served = createLabStore({ fetchImpl: async (url) => {
    assert(url === LAB_READ_URL, `fetched ${url}`);
    return { ok: true, status: 200, text: async () => doc };
  } });
  await served.load();
  eq(readLibrary(served).library.species['025_pikachu'].segments.idle.clip, 3, 'idle read from disk');

  const cache = { getItem: () => doc, setItem: () => {} };
  const offline = createLabStore({ storage: cache, fetchImpl: async () => ({ ok: false, status: 404 }) });
  await offline.load();
  eq(offline.status.source, 'cache', 'source with no file on disk');
  eq(readLibrary(offline).library.species['025_pikachu'].segments.idle.clip, 3, 'idle read from the browser copy');
});

await check('a save posts the document to the write URL', async () => {
  let posted = null;
  const store = createLabStore({ debounceMs: 0, fetchImpl: async (url, opts) => {
    if (!opts) return { ok: false, status: 404 };
    posted = { url, body: opts.body };
    return { ok: true, status: 200, json: async () => ({ ok: true, path: 'stadium-saves/pokemon-lab.json' }) };
  } });
  await store.load();
  store.setJSON({ version: 1, species: {} });
  const res = await store.flush();
  assert(res.ok, `the write failed: ${res.error}`);
  eq(posted.url, LAB_WRITE_URL, 'posted url');
  eq(JSON.parse(posted.body).version, 1, 'posted body');
});

console.log('\n--- reading a file somebody edited by hand ---');

await check('nothing at all becomes an empty library', () => {
  eq(migrateLibrary(null).library.version, ANNOTATION_VERSION, 'version');
  eq(Object.keys(migrateLibrary(null).library.species).length, 0, 'species');
  eq(migrateLibrary(undefined).notes.length, 0, 'a missing file is not worth a note');
});

await check('a file that is not an object is ignored out loud', () => {
  const bad = migrateLibrary([1, 2, 3]);
  eq(Object.keys(bad.library.species).length, 0, 'species');
  eq(bad.notes.length, 1, 'notes');
  assert(bad.notes[0].includes('not a JSON object'), `note was ${bad.notes[0]}`);
});

await check('a newer version is kept and reported, not discarded', () => {
  const raw = { version: ANNOTATION_VERSION + 5, species: { x: { species: 'x', locomotion: 'walker' } } };
  const out = migrateLibrary(raw);
  eq(out.library.species.x.locomotion, 'walker', 'the annotation survived');
  assert(out.notes.some(n => n.includes('newer')) || out.notes.some(n => n.includes('version')),
    `expected a version note, got ${JSON.stringify(out.notes)}`);
});

await check('a half-written entry is filled in rather than crashing a reader', () => {
  const out = migrateLibrary({ version: 1, species: { '019_rattata': { species: '019_rattata', locomotion: 'walker' } } });
  const a = out.library.species['019_rattata'];
  assert(Array.isArray(a.parts.spine), 'spine is a list');
  assert(Array.isArray(a.parts.appendages), 'appendages is a list');
  eq(a.parts.root, null, 'root');
  eq(a.neutral.ground, null, 'ground is undecided, not false');
  eq(a.done, false, 'done');
  eq(typeof a.notes, 'string', 'notes');
});

await check('the key wins over a species field that disagrees with it', () => {
  const out = migrateLibrary({ version: 1, species: { '019_rattata': { species: '025_pikachu', locomotion: 'walker' } } });
  assert(out.library.species['019_rattata'], 'kept under the key');
  eq(out.library.species['019_rattata'].species, '019_rattata', 'species field');
  assert(!out.library.species['025_pikachu'], 'did not move under the other name');
  assert(out.notes.some(n => n.includes('019_rattata')), 'said so');
});

await check('junk in the species map is dropped and named', () => {
  const out = migrateLibrary({ version: 1, species: { a: 5, b: null, c: { species: 'c', done: true } } });
  eq(Object.keys(out.library.species).join(','), 'c', 'kept');
  eq(out.notes.length, 2, `notes were ${JSON.stringify(out.notes)}`);
});

await check('a blank annotation is not written back to the file', () => {
  const out = migrateLibrary({ version: 1, species: { '019_rattata': { species: '019_rattata' } } });
  eq(Object.keys(out.library.species).length, 0, 'a blank entry is dropped');
});

await check('a real annotation survives a round trip through the file', () => {
  let lib = { version: ANNOTATION_VERSION, species: {} };
  const a = setSegment(emptyAnnotation('025_pikachu'), 'idle', { clip: 3, from: 4, to: 20, ends: 'hold' });
  lib = putAnnotation(lib, a);
  const back = migrateLibrary(JSON.parse(JSON.stringify(lib))).library;
  eq(back.species['025_pikachu'].segments.idle.clip, 3, 'the clip survived');
  eq(back.species['025_pikachu'].segments.idle.from, 4, 'the in point survived');
  eq(back.species['025_pikachu'].segments.idle.to, 20, 'the out point survived');
  eq(back.species['025_pikachu'].segments.idle.ends, 'hold', 'the ending survived');
  eq(migrateLibrary(JSON.parse(JSON.stringify(lib))).notes.length, 0, 'no notes on a clean file');
});

console.log('\n--- segments, and the shape the file used before them ---');

await check('a whole-clip role from the old file becomes a segment covering the whole clip', () => {
  // v1's first form was `clips: { idle: 3 }`. It converts exactly rather than being discarded, and the
  // conversion needs no idea how long clip 3 is, because a null out point means the last frame.
  const out = migrateLibrary({ version: 1, species: { '007_squirtle': { species: '007_squirtle', clips: { idle: 3 } } } });
  const seg = out.library.species['007_squirtle'].segments.idle;
  eq(seg.clip, 3, 'clip');
  eq(seg.from, 0, 'from');
  eq(seg.to, null, 'to stays open so it follows the clip length');
  eq(seg.ends, 'loop', 'a whole clip loops');
  assert(!out.library.species['007_squirtle'].clips, 'the old key should not survive');
  assert(out.notes.some(n => n.includes('whole-clip')), `expected a note, got ${JSON.stringify(out.notes)}`);
});

await check('a file that already has segments is left exactly as it is', () => {
  const raw = { version: 1, species: { '007_squirtle': { species: '007_squirtle',
    segments: { enter_shell: { clip: 7, from: 0, to: 8, ends: 'hold' } } } } };
  const out = migrateLibrary(JSON.parse(JSON.stringify(raw)));
  eq(JSON.stringify(out.library.species['007_squirtle'].segments),
    JSON.stringify(raw.species['007_squirtle'].segments), 'segments');
  eq(out.notes.length, 0, `expected no notes, got ${JSON.stringify(out.notes)}`);
});

await check('a segment that is not a clip and a range is dropped and named', () => {
  const out = migrateLibrary({ version: 1, species: { x: { species: 'x',
    segments: { good: { clip: 1, from: 0, to: 5 }, bad: 'the whole thing', worse: { from: 2 } } } } });
  eq(Object.keys(out.library.species.x.segments).join(','), 'good', 'kept');
  eq(out.notes.length, 2, `notes were ${JSON.stringify(out.notes)}`);
  assert(out.notes.every(n => n.includes('x')), 'the notes should name the species');
});

await check('a reversed segment survives the file, since that is how an exit is stored', () => {
  const raw = { version: 1, species: { '007_squirtle': { species: '007_squirtle',
    segments: { exit_shell: { clip: 7, from: 8, to: 0, ends: 'hold' } } } } };
  const seg = migrateLibrary(raw).library.species['007_squirtle'].segments.exit_shell;
  eq(seg.from, 8, 'from');
  eq(seg.to, 0, 'to');
  assert(resolveSegment(seg, 52).reversed, 'it should resolve as reversed');
});

await check('a species with only segments counts as touched on the board', () => {
  const lib = putAnnotation({ version: ANNOTATION_VERSION, species: {} },
    setSegment(emptyAnnotation('007_squirtle'), 'enter_shell', { clip: 7, from: 0, to: 8, ends: 'hold' }));
  eq(speciesStatus(lib.species['007_squirtle']).state, 'progress', 'status');
  eq(labSummary(lib, dex).untouched, 150, 'untouched');
});

console.log('\n--- the board ---');

await check('an unsaid species is untouched, and gates that never ran cannot make it ready', () => {
  eq(speciesStatus(null).state, 'untouched', 'no annotation');
  eq(speciesStatus(emptyAnnotation('x')).state, 'untouched', 'a blank annotation');
  const a = setSegment(emptyAnnotation('x'), 'idle', wholeClip(0));
  eq(speciesStatus(a).state, 'progress', 'annotated, gates not run');
  eq(speciesStatus(a, []).state, 'ready', 'annotated, gates pass');
  eq(speciesStatus(a, ['a finding']).state, 'progress', 'annotated, gates fail');
});

await check('done is a person marking it, and a failing gate does not hide either fact', () => {
  const a = setDone(setSegment(emptyAnnotation('x'), 'idle', wholeClip(0)), true);
  eq(speciesStatus(a).state, 'done', 'done, gates not run');
  eq(speciesStatus(a, []).state, 'done', 'done, gates pass');
  eq(speciesStatus(a, ['x', 'y']).state, 'done-findings', 'done over failing gates');
  eq(speciesStatus(a, ['x', 'y']).findings, 2, 'the findings are still counted');
});

await check('every board state has a label the page can print', () => {
  for (const s of STATUS_ORDER) assert(STATUS_LABELS[s], `no label for ${s}`);
  eq(STATUS_ORDER.length, 5, 'board states');
});

await check('the summary counts the whole dex, whatever is in the library', () => {
  let lib = { version: ANNOTATION_VERSION, species: {} };
  lib = putAnnotation(lib, setSegment(emptyAnnotation('025_pikachu'), 'idle', wholeClip(0)));
  lib = putAnnotation(lib, setDone(setSegment(emptyAnnotation('019_rattata'), 'idle', wholeClip(0)), true));
  const counts = labSummary(lib, dex);
  eq(counts.untouched, 149, 'untouched');
  eq(counts.progress, 1, 'in progress');
  eq(counts.done, 1, 'done');
  eq(Object.values(counts).reduce((a, b) => a + b, 0), dex.length, 'every species is counted exactly once');
});

console.log('\n--- the rig hash ---');

await check('an annotation made against another version of the model is flagged, not applied silently', () => {
  const { rig } = readRigFromGLB(fs.readFileSync('models/stadium/025_pikachu.glb'));
  const fresh = emptyAnnotation('025_pikachu', rig);
  eq(fresh.rigHash, rig.hash, 'a fresh annotation stamps the rig it was made against');
  assert(!rigMismatch(fresh, rig), 'the same rig is not a mismatch');
  assert(rigMismatch({ rigHash: 'deadbeef' }, rig), 'a different rig is a mismatch');
  assert(!rigMismatch({ rigHash: null }, rig), 'an unstamped annotation is not a mismatch');
  // The stamp is only worth anything if it survives the file, which is the whole re-extraction guard.
  const lib = putAnnotation({ version: ANNOTATION_VERSION, species: {} }, setSegment(fresh, 'idle', wholeClip(0)));
  const back = migrateLibrary(JSON.parse(JSON.stringify(lib))).library;
  eq(back.species['025_pikachu'].rigHash, rig.hash, 'the rig hash survived the round trip');
  assert(!rigMismatch(back.species['025_pikachu'], rig), 'and still matches the model it was made against');
});

console.log('\n' + results.join('\n'));
console.log(`\n${results.length - failures} of ${results.length} checks passed.\n`);
process.exit(failures ? 1 : 0);
