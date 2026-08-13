// test-audio-http-music.mjs
//
// Covers the 'http' music source in environment-audio.js: the served sfx/music/ listing that
// bot-viewer-v2.html uses so music needs no File System Access folder pick. Runs the real
// controller against minimal DOM/audio stubs -- no AudioContext is provided, so playback stops
// at the `new Audio(url)` boundary, which is exactly the URL-building behaviour under test.

import assert from 'node:assert/strict';

const created = [];   // every Audio(src) the controller constructed, in order

function installStubs(files, { listUrl = '/api/list-music' } = {}) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  globalThis.window = {};                       // no AudioContext -> initAudio() returns false
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.Audio = class {
    constructor(src) {
      this.src = src; this.paused = true; this.volume = 0; this.loop = false;
      created.push(src);
    }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
    load() {}
    addEventListener() {}
    removeAttribute() {}
  };
  globalThis.fetch = async (url) => {
    if (String(url) === listUrl) return { ok: true, json: async () => ({ ok: true, files }) };
    return { ok: false, json: async () => ({}) };
  };
}

const THREE = {
  Vector3: class { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } },
};

async function makeController(files, opts = {}) {
  created.length = 0;
  installStubs(files);
  const { createEnvironmentAudio } = await import('./environment-audio.js');
  return createEnvironmentAudio({ THREE, autoplayOnGesture: false, ...opts });
}

const TRACKS = ['a-song.mp3', 'b song with spaces.ogg', 'notes.txt', 'テレパシー.mp3'];

// --- 1. listing -> playlist, unsupported extensions dropped, source untouched by default ---
{
  const audio = await makeController(TRACKS);
  assert.equal(audio.getState().musicSource, 'game');
  assert.equal(await audio.loadMusicHttp(), true);

  const state = audio.getState();
  assert.equal(state.musicHttpTrackCount, 3, 'notes.txt is not a music file');
  assert.equal(state.musicSource, 'game', 'plain load must not switch the active source');
  assert.deepEqual(state.playlist, [], 'game source has no tracks assigned');

  // The http playlist only becomes visible once http is the active source.
  audio.setMusicSource('http');
  const httpState = audio.getState();
  assert.equal(httpState.musicSource, 'http');
  assert.deepEqual(httpState.playlist.map(t => t.eventId), ['music_http', 'music_http', 'music_http']);
  assert.deepEqual(httpState.playlist.map(t => t.path), ['a-song.mp3', 'b song with spaces.ogg', 'テレパシー.mp3']);
  assert.deepEqual(httpState.playlist.map(t => t.label), ['a-song', 'b song with spaces', 'テレパシー']);
}

// --- 2. select: switches source without starting playback; activate: starts the first track ---
{
  const audio = await makeController(TRACKS);
  await audio.loadMusicHttp({ select: true });
  assert.equal(audio.getState().musicSource, 'http');
  assert.deepEqual(created, [], 'select must not start a track');

  audio.noteGesture();   // autoplayOnGesture:false -> a gesture alone still starts nothing
  assert.deepEqual(created, [], 'gesture must not start a track when autoplay is off');

  const activated = await makeController(TRACKS);
  await activated.loadMusicHttp({ activate: true });
  assert.equal(created.length, 1, 'activate plays the first listed track');
  assert.equal(created[0], './sfx/music/a-song.mp3');
  assert.equal(activated.getState().currentTrackPath, 'a-song.mp3');
}

// --- 3. URLs are per-segment encoded; playTrack/next/prev walk the served list ---
{
  const audio = await makeController(TRACKS);
  await audio.loadMusicHttp({ select: true });
  const playlist = audio.getState().playlist;

  audio.playTrack(playlist[1]);
  assert.equal(created.at(-1), './sfx/music/b%20song%20with%20spaces.ogg', 'spaces are encoded');

  audio.nextTrack();
  assert.equal(created.at(-1), `./sfx/music/${encodeURIComponent('テレパシー.mp3')}`);
  assert.equal(audio.getState().currentTrackPath, 'テレパシー.mp3');

  audio.nextTrack();   // wraps
  assert.equal(audio.getState().currentTrackPath, 'a-song.mp3');
  audio.prevTrack();
  assert.equal(audio.getState().currentTrackPath, 'テレパシー.mp3');

  // A custom base URL is honoured verbatim.
  const custom = await makeController(TRACKS);
  await custom.loadMusicHttp({ baseUrl: '/media/tracks/' });
  custom.setMusicSource('http');
  custom.playTrack(custom.getState().playlist[0]);
  assert.equal(created.at(-1), '/media/tracks/a-song.mp3');
}

// --- 4. empty / unavailable listings are refused, and cannot become the active source ---
{
  const empty = await makeController(['readme.md']);
  assert.equal(await empty.loadMusicHttp(), false);
  empty.setMusicSource('http');
  assert.equal(empty.getState().musicSource, 'game', 'no tracks -> source stays put');

  const offline = await makeController(TRACKS);
  globalThis.fetch = async () => { throw new Error('offline'); };
  assert.equal(await offline.loadMusicHttp(), false);
  assert.equal(offline.getState().musicHttpTrackCount, 0);
}

// --- 5. the pre-existing sources still behave: 'game' needs an SFX folder handle, so http
//        loading must not have made game music playable on its own ---
{
  const audio = await makeController(TRACKS);
  await audio.loadMusicHttp({ select: true });
  audio.setMusicSource('game');
  assert.equal(audio.getState().musicSource, 'game');
  assert.deepEqual(audio.getState().playlist, []);
  audio.setMusicSource('nonsense');
  assert.equal(audio.getState().musicSource, 'game', 'unknown source ids are ignored');
}

// --- 6. shuffle: opt-in per viewer, covers every track, and reshuffles on wrap ---------------
{
  const ordered = await makeController(TRACKS);
  await ordered.loadMusicHttp({ select: true });
  assert.equal(ordered.getState().shuffle, false, 'shuffle is off unless the viewer asks for it');

  const many = ['1.mp3', '2.mp3', '3.mp3', '4.mp3', '5.mp3', '6.mp3'];
  const audio = await makeController(many, { shuffle: true });
  await audio.loadMusicHttp({ select: true });
  assert.equal(audio.getState().shuffle, true);

  // A full pass visits every track exactly once -- shuffle must permute, not sample.
  audio.togglePlayback();                       // starts from a shuffled pick, not track 1
  const pass = [audio.getState().currentTrackPath];
  for (let i = 1; i < many.length; i++) {
    audio.nextTrack();
    pass.push(audio.getState().currentTrackPath);
  }
  assert.deepEqual([...pass].sort(), [...many].sort(), 'every track played once per pass');

  // togglePlayback starts at the head of the pass, so the loop above ended on its last entry:
  // one more step wraps into a fresh pass, which must not open on the track just heard.
  const beforeWrap = audio.getState().currentTrackPath;
  audio.nextTrack();
  assert.notEqual(audio.getState().currentTrackPath, beforeWrap, 'no back-to-back repeat on wrap');

  // Inside a pass, prev undoes next.
  const head = audio.getState().currentTrackPath;
  audio.nextTrack();
  assert.notEqual(audio.getState().currentTrackPath, head);
  audio.prevTrack();
  assert.equal(audio.getState().currentTrackPath, head, 'prev undoes next in the shuffled order');

  // Turning shuffle off restores listing order from wherever playback is.
  audio.setShuffle(false);
  assert.equal(audio.getState().shuffle, false);
  const from = audio.getState().currentTrackPath;
  audio.nextTrack();
  const expected = many[(many.indexOf(from) + 1) % many.length];
  assert.equal(audio.getState().currentTrackPath, expected, 'sequential order once shuffle is off');
}

// --- 7. a single-track playlist is stable under shuffle (the real sfx/music/ case today) -----
{
  const audio = await makeController(['only.mp3'], { shuffle: true });
  await audio.loadMusicHttp({ activate: true });
  assert.equal(audio.getState().currentTrackPath, 'only.mp3');
  audio.nextTrack();
  assert.equal(audio.getState().currentTrackPath, 'only.mp3');
}

console.log('test-audio-http-music: all assertions passed');
