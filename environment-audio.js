// environment-audio.js
//
// Self-contained audio controller extracted from the arena shooter
// (`html-game-v2/src/game/main.js` audio block, ~lines 1624-3314) so the
// environment viewer can reuse the SFX + music system WITHOUT importing the
// shooter runtime. See docs/superpowers/plans/2026-07-05-environment-audio-import.md
// and the source `HTML_GAME.md` audio sections for the compatibility contract.
//
// All viewer state is injected through `options` (THREE, scene, camera,
// getPlayerPosition, isGameplayActive, optional isDucked, optional
// getSpeakerTargets, workletUrl) -- there are no shooter globals and no
// dependency on main.js. Status/UI updates flow through subscribe()/getState()
// instead of touching the DOM.

import { SOUND_EVENTS } from './sound-events.js';
import { getFileByKey, extensionOf } from './asset-paths.js';
import { createHandleStore } from './file-handles.js';
import { subscribeLiveUpdates, rememberLiveMessage } from './live-updates.js';
import { loopVoiceCap } from './combat-audio-budget.js';

// [ADAPTATION] Local constants replacing imports from the source config.js
// (src/game/config.js:722-734).
const audioMasterReferenceGain = 0.22;
const audioDefaultSettings = {
  masterVol: 1,
  musicVol: 1,
  sfxVol: 1,
  masterMuted: false,
  musicMuted: false,
  sfxMuted: false,
};

// [ADAPTATION] Panner profiles kept from the source but exported so environment
// events can choose a profile without depending on shooter weapon code.
export const positionalSfxProfiles = {
  default: { distanceModel: 'inverse', refDistance: 22, maxDistance: 170, rolloffFactor: 0.55 },
  gunshot: { distanceModel: 'inverse', refDistance: 25, maxDistance: 250, rolloffFactor: 0.35 },
  heavyGunshot: { distanceModel: 'inverse', refDistance: 32, maxDistance: 290, rolloffFactor: 0.28 },
  launch: { distanceModel: 'inverse', refDistance: 24, maxDistance: 220, rolloffFactor: 0.4 },
  explosion: { distanceModel: 'inverse', refDistance: 30, maxDistance: 280, rolloffFactor: 0.32 },
  largeExplosion: { distanceModel: 'inverse', refDistance: 38, maxDistance: 1100, rolloffFactor: 0.15 },
  alert: { distanceModel: 'inverse', refDistance: 18, maxDistance: 140, rolloffFactor: 0.65 },
  minor: { distanceModel: 'inverse', refDistance: 12, maxDistance: 100, rolloffFactor: 0.85 },
  short: { distanceModel: 'inverse', refDistance: 8, maxDistance: 60, rolloffFactor: 1.1 },
  spawn: { distanceModel: 'inverse', refDistance: 24, maxDistance: 220, rolloffFactor: 0.4 },
};

const positionalSfxVolumeScale = 2.0;

// Band split for audio-reactive visuals, kept pure and exported so it is testable in Node without
// a Web Audio graph (same reasoning as the CPU/GPU math twins documented in CLAUDE.md).
// `bins` is AnalyserNode.getByteFrequencyData output (0-255 per bin, bin i covers
// i * sampleRate / fftSize Hz). Writes into `out` rather than allocating -- this runs per frame.
export const SPECTRUM_BANDS = { bass: [20, 160], mid: [160, 2000], treble: [2000, 8000] };

export function spectrumBands(bins, sampleRate, fftSize, out = { bass: 0, mid: 0, treble: 0, level: 0 }) {
  const binHz = sampleRate / fftSize;
  if (!bins?.length || !Number.isFinite(binHz) || binHz <= 0) {
    out.bass = out.mid = out.treble = out.level = 0;
    return out;
  }
  for (const band of ['bass', 'mid', 'treble']) {
    const [fromHz, toHz] = SPECTRUM_BANDS[band];
    const from = Math.max(0, Math.floor(fromHz / binHz));
    const to = Math.min(bins.length - 1, Math.ceil(toHz / binHz));
    let sum = 0;
    for (let i = from; i <= to; i++) sum += bins[i];
    out[band] = to >= from ? sum / ((to - from + 1) * 255) : 0;
  }
  out.level = (out.bass + out.mid + out.treble) / 3;
  return out;
}

// Log-spaced band magnitudes for a spectrum-analyser display: `out.length` bars spanning
// [fromHz, toHz], each 0-1. Log spacing is what makes it look like a stereo's analyser rather
// than one fat bass bar and 15 empty ones. Pure + fills `out` in place; Node-tested.
export function spectrumBars(bins, sampleRate, fftSize, out, { fromHz = 40, toHz = 12000 } = {}) {
  if (!out?.length) return out;
  const binHz = sampleRate / fftSize;
  if (!bins?.length || !Number.isFinite(binHz) || binHz <= 0 || toHz <= fromHz) {
    for (let i = 0; i < out.length; i++) out[i] = 0;
    return out;
  }
  const ratio = toHz / fromHz;
  const nyquistBin = bins.length - 1;
  for (let i = 0; i < out.length; i++) {
    const lo = fromHz * Math.pow(ratio, i / out.length);
    const hi = fromHz * Math.pow(ratio, (i + 1) / out.length);
    const from = Math.min(nyquistBin, Math.max(0, Math.floor(lo / binHz)));
    // Narrow low bars can round to an empty range; widen to at least one bin so they still read.
    const to = Math.min(nyquistBin, Math.max(from, Math.ceil(hi / binHz) - 1));
    let sum = 0;
    for (let b = from; b <= to; b++) sum += bins[b];
    out[i] = sum / ((to - from + 1) * 255);
  }
  return out;
}

export function createEnvironmentAudio(options = {}) {
  const THREE = options.THREE;
  if (!THREE) throw new Error('createEnvironmentAudio requires options.THREE');
  const scene = options.scene || null;
  const camera = options.camera || null;
  const getPlayerPosition = typeof options.getPlayerPosition === 'function'
    ? options.getPlayerPosition
    : () => (camera ? camera.position : new THREE.Vector3());
  const isGameplayActive = typeof options.isGameplayActive === 'function'
    ? options.isGameplayActive
    : () => true;
  const isDucked = typeof options.isDucked === 'function' ? options.isDucked : () => false;
  // getSpeakerTargets is accepted for a future creature-follow speaker behavior.
  const getSpeakerTargets = typeof options.getSpeakerTargets === 'function'
    ? options.getSpeakerTargets
    : null;
  const workletUrl = options.workletUrl || './music-pitch-processor.js?v=1';
  // When false, the first user gesture only resumes music that was already playing or blocked --
  // it never starts a track on its own. Viewers with an always-populated playlist want this off.
  const autoplayOnGesture = options.autoplayOnGesture !== false;
  const startShuffled = options.shuffle === true;

  const perfNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const clamp01 = v => Math.max(0, Math.min(1, Number(v) || 0));

  // ---- Viewer-specific persistence keys ([ADAPTATION]) ----
  const audioSettingsStorageKey = 'environment-viewer-audio-settings';
  const sfxHandleDbName = 'environment-audio-handles';
  const sfxHandleStoreName = 'handles';
  const sfxRootHandleKey = 'sfx-root-directory';
  const sfxPickerId = 'environment-audio-sfx-folder';
  const musicRootHandleKey = 'music-root-directory';
  const musicPickerId = 'environment-audio-music-folder';
  const liveSfxChannelName = 'sfx-game';
  const liveSfxStorageKey = 'sfx-game-update';
  const sfxHandleStore = createHandleStore(sfxHandleDbName, sfxHandleStoreName);

  const soundEventIds = new Set(SOUND_EVENTS);
  const musicEventIds = new Set(['music_menu', 'music_game']);
  const musicFileExtensions = new Set(['.wav', '.mp3', '.ogg', '.m4a', '.flac']);

  // ---- Mixer / context state ----
  let audioCtx = null;
  let masterGain = null;
  let sfxGain = null;
  let sfxDirHandle = null;
  let sfxBuffers = {};
  let musicPaths = {};
  let currentMusic = null;
  let musicRequestId = 0;
  let persistentSfxStatus = '';
  let statusText = '';
  let pendingMusicRetry = false;
  let desiredMusicEventId = '';
  let desiredMusicPath = '';
  let musicUserPaused = false;
  let musicSourceMode = 'game';
  let musicOutputMode = 'global';
  let musicSpeakerBehavior = 'front';
  let musicFolderHandle = null;
  let musicFolderPaths = [];
  // 'http' music source: a served track listing, no File System Access handle needed.
  let musicHttpBase = '';
  let musicHttpPaths = [];
  // Spectrum tap for audio-reactive visuals. Music only: the SFX bus is a separate chain, and
  // gunfire driving the room lights would swamp anything the music is doing.
  let musicAnalyser = null;
  let analyserBins = null;
  const audioLevels = { bass: 0, mid: 0, treble: 0, level: 0, beat: 0, playing: false };
  let bassBaseline = 0;
  let lastBeatAt = 0;
  let lastLevelsAt = 0;
  let musicShuffle = startShuffled;
  let shuffleOrder = [];    // playlist paths in shuffled order
  let shuffleKey = '';      // playlist identity shuffleOrder was built for
  let lastGameplayActive = null;
  const musicEffectSettings = {
    bass: 0,
    echo: 0,
    reverb: 0,
    attenuation: 100,
    tempo: 100,
    pitch: 0,
  };
  let musicReverbImpulse = null;
  let musicPitchWorkletPromise = null;
  let musicPitchWorkletAvailable = true;
  let musicSpeakerOrb = null;
  const musicUrlCache = new Map();
  const liveSfxSeen = new Set();
  let liveSfxChannel = null;
  let disposed = false;

  // Live sustained voices (sirens, damage beds) -- swept every frame, capped hard.
  const activeLoops = new Set();
  let nextLoopId = 1;

  // ---- Subscription / status ----
  const listeners = new Set();

  function isMusicPlaying() {
    return !!(currentMusic?.audio && !musicUserPaused && !currentMusic.audio.paused);
  }

  // Read contract shared with the Audio tab in environment-ui.js (Task 3).
  function getState() {
    return {
      masterVolume: audioSettings.masterVol,
      musicVolume: audioSettings.musicVol,
      sfxVolume: audioSettings.sfxVol,
      masterMuted: audioSettings.masterMuted,
      musicMuted: audioSettings.musicMuted,
      sfxMuted: audioSettings.sfxMuted,
      musicOutput: musicOutputMode,
      musicSource: musicSourceMode,
      shuffle: musicShuffle,
      speakerBehavior: musicSpeakerBehavior,
      effects: { ...musicEffectSettings },
      sfxFolderStatus: statusText,
      musicFolderStatus: musicFolderHandle
        ? `${musicFolderHandle.name} - ${musicFolderPaths.length} track${musicFolderPaths.length === 1 ? '' : 's'}`
        : 'No music folder loaded.',
      currentTrackLabel: currentMusic?.label || '',
      currentTrackPath: currentMusicPlaylistPath(),
      musicPlaying: isMusicPlaying(),
      // Extra fields retained for internal/diagnostic use.
      ready: !!audioCtx,
      sfxFolderName: sfxDirHandle?.name || '',
      musicFolderName: musicFolderHandle?.name || '',
      musicFolderTrackCount: musicFolderPaths.length,
      musicHttpTrackCount: musicHttpPaths.length,
      loadedEvents: Object.keys(sfxBuffers).length,
      loadedMusicEvents: Object.keys(musicPaths).length,
      playlist: activeMusicPlaylist(),
      pendingMusicRetry,
      pitchAvailable: musicPitchWorkletAvailable,
    };
  }

  function notify() {
    if (!listeners.size) return;
    const snapshot = getState();
    listeners.forEach(listener => {
      try { listener(snapshot); } catch { /* listener errors are non-fatal */ }
    });
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};
    listeners.add(listener);
    try { listener(getState()); } catch { /* ignore */ }
    return () => listeners.delete(listener);
  }

  function showSfxStatus(text) {
    statusText = text;
    notify();
  }

  function showPersistentSfxStatus(text) {
    persistentSfxStatus = text;
    showSfxStatus(text);
  }

  // [ADAPTATION] Source appendDebugLog() calls are routed to the status channel.
  function appendDebugLog(message) {
    showSfxStatus(message);
  }

  // ---- Settings load / save ----
  function loadAudioSettings() {
    const settings = { ...audioDefaultSettings };
    try {
      const raw = localStorage.getItem(audioSettingsStorageKey);
      if (raw) {
        const parsed = JSON.parse(raw) || {};
        for (const key of ['masterVol', 'musicVol', 'sfxVol']) {
          const v = Number(parsed[key]);
          if (Number.isFinite(v)) settings[key] = clamp01(v);
        }
        for (const key of ['masterMuted', 'musicMuted', 'sfxMuted']) {
          if (typeof parsed[key] === 'boolean') settings[key] = parsed[key];
        }
      }
    } catch {
      // Corrupt or unavailable storage falls back to defaults.
    }
    return settings;
  }

  function saveAudioSettings() {
    try {
      localStorage.setItem(audioSettingsStorageKey, JSON.stringify(audioSettings));
    } catch {
      // Non-critical preference storage can fail in private/restricted contexts.
    }
  }

  const audioSettings = loadAudioSettings();

  function effectiveMasterVol() { return audioSettings.masterMuted ? 0 : audioSettings.masterVol; }
  function effectiveMusicVol() { return audioSettings.musicMuted ? 0 : audioSettings.musicVol; }
  function effectiveSfxVol() { return audioSettings.sfxMuted ? 0 : audioSettings.sfxVol; }

  function applyAudioSettings() {
    if (masterGain) setAudioParamValue(masterGain.gain, audioMasterReferenceGain * effectiveMasterVol());
    if (sfxGain) setAudioParamValue(sfxGain.gain, effectiveSfxVol());
    saveAudioSettings();
    if (currentMusic?.audio) {
      fadeAudio(currentMusic.audio, targetMusicVolume(), 0.18);
    } else if (effectiveMasterVol() > 0 && effectiveMusicVol() > 0) {
      syncMusicForState(0.2);
    }
    notify();
  }

  // ---- Audio context / core playback ----
  function initAudio() {
    if (disposed) return false;
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return false;

    if (!audioCtx) {
      audioCtx = new AudioContextCtor();
      masterGain = audioCtx.createGain();
      sfxGain = audioCtx.createGain();
      sfxGain.connect(masterGain);
      masterGain.connect(audioCtx.destination);
      applyAudioSettings();
      updateAudioListener();
    }

    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }

    return true;
  }

  function playBuffer(buf, vol = 1) {
    if (!initAudio() || !buf || !masterGain) return null;
    const src = audioCtx.createBufferSource();
    const gain = audioCtx.createGain();
    src.buffer = buf;
    gain.gain.value = vol;
    src.connect(gain);
    gain.connect(sfxGain);
    src.start(audioCtx.currentTime);
    return src;
  }

  function setAudioParamValue(param, value) {
    if (!param) return;
    if (typeof param.setValueAtTime === 'function' && audioCtx) {
      param.setValueAtTime(value, audioCtx.currentTime);
    } else {
      param.value = value;
    }
  }

  function isAudioPosition(position) {
    return position
      && Number.isFinite(position.x)
      && Number.isFinite(position.y)
      && Number.isFinite(position.z);
  }

  // [ADAPTATION] Uses the injected camera, not a module global.
  // Scratch vectors: this runs every frame on every page.
  const _listenerForward = new THREE.Vector3();
  const _listenerUp = new THREE.Vector3();
  function updateAudioListener() {
    if (!audioCtx || !camera) return;
    const listener = audioCtx.listener;
    const forward = _listenerForward.set(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
    const up = _listenerUp.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();

    if (listener.positionX) {
      setAudioParamValue(listener.positionX, camera.position.x);
      setAudioParamValue(listener.positionY, camera.position.y);
      setAudioParamValue(listener.positionZ, camera.position.z);
      setAudioParamValue(listener.forwardX, forward.x);
      setAudioParamValue(listener.forwardY, forward.y);
      setAudioParamValue(listener.forwardZ, forward.z);
      setAudioParamValue(listener.upX, up.x);
      setAudioParamValue(listener.upY, up.y);
      setAudioParamValue(listener.upZ, up.z);
    } else {
      listener.setPosition?.(camera.position.x, camera.position.y, camera.position.z);
      listener.setOrientation?.(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  function configurePanner(panner, opts = {}) {
    panner.panningModel = opts.panningModel || 'HRTF';
    panner.distanceModel = opts.distanceModel || positionalSfxProfiles.default.distanceModel;
    panner.refDistance = opts.refDistance ?? positionalSfxProfiles.default.refDistance;
    panner.maxDistance = opts.maxDistance ?? positionalSfxProfiles.default.maxDistance;
    panner.rolloffFactor = opts.rolloffFactor ?? positionalSfxProfiles.default.rolloffFactor;
  }

  function setPannerPosition(panner, position) {
    if (panner.positionX) {
      setAudioParamValue(panner.positionX, position.x);
      setAudioParamValue(panner.positionY, position.y);
      setAudioParamValue(panner.positionZ, position.z);
    } else {
      panner.setPosition?.(position.x, position.y, position.z);
    }
  }

  function connectSpatialOutput(inputNode, position, opts = {}) {
    const panner = audioCtx.createPanner();
    configurePanner(panner, opts);
    setPannerPosition(panner, position);
    inputNode.connect(panner);

    const stereoPan = Number(opts.stereoPan);
    if (Number.isFinite(stereoPan) && typeof audioCtx.createStereoPanner === 'function') {
      const stereo = audioCtx.createStereoPanner();
      setAudioParamValue(stereo.pan, Math.max(-1, Math.min(1, stereoPan)));
      panner.connect(stereo);
      stereo.connect(sfxGain);
      return { panner, stereo };
    }

    panner.connect(sfxGain);
    return { panner };
  }

  function playBufferAt(buf, position, vol = 1, opts = {}) {
    if (!isAudioPosition(position)) return playBuffer(buf, vol);
    if (!initAudio() || !buf || !masterGain) return null;

    const sourcePosition = position.clone?.() || new THREE.Vector3(position.x, position.y, position.z);
    const maxDistance = opts.maxDistance ?? positionalSfxProfiles.default.maxDistance;
    const cullDistance = opts.cullDistance ?? maxDistance * 1.5;
    if (camera && sourcePosition.distanceTo(camera.position) > cullDistance) return null;

    const src = audioCtx.createBufferSource();
    const gain = audioCtx.createGain();
    src.buffer = buf;
    gain.gain.value = vol * (opts.volumeScale ?? positionalSfxVolumeScale);
    src.connect(gain);
    connectSpatialOutput(gain, sourcePosition, opts);
    src.start(audioCtx.currentTime);
    return src;
  }

  // ---- SFX / music entry helpers ----
  function normalizeAudioList(value) {
    if (Array.isArray(value)) return value.filter(Boolean);
    return value ? [value] : [];
  }

  function normalizeSfxVolume(value) {
    const volume = Number(value);
    if (!Number.isFinite(volume)) return 1;
    return Math.max(0, Math.min(2, volume));
  }

  function createSfxEntry(buffers, mode = 'random', volume = 1) {
    return {
      buffers: buffers.filter(Boolean),
      mode: mode === 'sequence' ? 'sequence' : 'random',
      volume: normalizeSfxVolume(volume),
      nextIndex: 0,
    };
  }

  function createMusicEntry(paths, mode = 'random', volume = 1) {
    return {
      paths: paths.filter(Boolean),
      mode: mode === 'sequence' ? 'sequence' : 'random',
      volume: normalizeSfxVolume(volume),
      nextIndex: 0,
    };
  }

  function sfxEntryVolume(eventId) {
    return normalizeSfxVolume(sfxBuffers[eventId]?.volume);
  }

  function pickSfxBuffer(eventId) {
    const entry = sfxBuffers[eventId];
    if (entry && !entry.buffers) return entry;
    if (!entry?.buffers?.length) return null;

    if (entry.mode === 'sequence') {
      const buffer = entry.buffers[entry.nextIndex % entry.buffers.length];
      entry.nextIndex = (entry.nextIndex + 1) % entry.buffers.length;
      return buffer;
    }
    return entry.buffers[Math.floor(Math.random() * entry.buffers.length)];
  }

  function playSfxEvent(eventId, volume = 0.75) {
    const buffer = pickSfxBuffer(eventId);
    if (!buffer) return false;
    playBuffer(buffer, volume * sfxEntryVolume(eventId));
    return true;
  }

  function playSfxEventAt(eventId, position, volume = 0.75, opts = {}) {
    const buffer = pickSfxBuffer(eventId);
    if (!buffer) return false;
    playBufferAt(buffer, position, volume * sfxEntryVolume(eventId), opts);
    return true;
  }

  // Decode into THIS context. An AudioBuffer belongs to the context that created it, so callers
  // that want to schedule their own sources (baked voice takes) cannot decode on a private context.
  async function decodeAudio(arrayBuffer) {
    if (disposed || !audioCtx || !arrayBuffer) return null;
    try { return await audioCtx.decodeAudioData(arrayBuffer); } catch { return null; }
  }

  // True when a decoded buffer is loaded for this event id. Never loads, never throws pre-init.
  function hasSfxEvent(eventId) {
    const entry = sfxBuffers[eventId];
    if (!entry) return false;
    if (!entry.buffers) return true;
    return entry.buffers.length > 0;
  }

  // Procedural fallback voice: builds the same panner+gain chain a positional sample gets, then
  // hands the chain input to `build(ctx, destination, startTime)` to schedule its own nodes.
  // Returns true only when a voice actually started.
  function playSynthAt(build, position, opts = {}) {
    if (typeof build !== 'function') return false;
    if (disposed || !audioCtx || !sfxGain) return false;
    // Gesture-unlock rule: play into an already-running context only, never force a resume.
    if (audioCtx.state !== 'running') return false;
    if (effectiveMasterVol() <= 0 || effectiveSfxVol() <= 0) return false;

    const profile = opts.profile || {};
    const volume = normalizeSfxVolume(opts.volume === undefined ? 0.75 : opts.volume);
    const positional = isAudioPosition(position);

    let sourcePosition = null;
    if (positional) {
      sourcePosition = position.clone?.() || new THREE.Vector3(position.x, position.y, position.z);
      const maxDistance = profile.maxDistance ?? positionalSfxProfiles.default.maxDistance;
      const cullDistance = opts.cullDistance ?? maxDistance * 1.5;
      if (camera && sourcePosition.distanceTo(camera.position) > cullDistance) return false;
    }

    const gain = audioCtx.createGain();
    gain.gain.value = volume * (positional ? (opts.volumeScale ?? positionalSfxVolumeScale) : 1);
    const spatial = positional ? connectSpatialOutput(gain, sourcePosition, profile) : null;
    if (!positional) gain.connect(sfxGain);

    const teardown = () => {
      try { gain.disconnect(); } catch { /* already torn down */ }
      try { spatial?.panner?.disconnect(); } catch { /* already torn down */ }
      try { spatial?.stereo?.disconnect(); } catch { /* already torn down */ }
    };

    let duration = 0;
    try {
      duration = Number(build(audioCtx, gain, audioCtx.currentTime));
    } catch {
      duration = 0;
    }

    // A builder that scheduled nothing usable must not leave a live chain behind.
    if (!Number.isFinite(duration) || duration <= 0) {
      teardown();
      return false;
    }

    // Small tail margin covers filter/panner ring-out past the builder's last scheduled stop.
    setTimeout(teardown, (duration + 0.25) * 1000);
    return true;
  }

  // Sustained sibling of playSynthAt. A siren ends on an event (revived / bled out / culled),
  // not after a known duration, so the builder returns a stop handle instead of a length.
  // Builder contract: `build(ctx, destination, t0) => { stop(atCtxTime) }`.
  // Returns a controller handle, or false when nothing started.
  function playSynthLoop(build, position, opts = {}) {
    if (typeof build !== 'function') return false;
    if (disposed || !audioCtx || !sfxGain) return false;
    if (audioCtx.state !== 'running') return false;
    if (effectiveMasterVol() <= 0 || effectiveSfxVol() <= 0) return false;
    if (activeLoops.size >= loopVoiceCap()) return false;

    const profile = opts.profile || {};
    const volume = normalizeSfxVolume(opts.volume === undefined ? 0.75 : opts.volume);
    const positional = isAudioPosition(position);
    const maxDistance = profile.maxDistance ?? positionalSfxProfiles.default.maxDistance;
    const cullDistance = opts.cullDistance ?? maxDistance * 1.5;

    let sourcePosition = null;
    if (positional) {
      sourcePosition = position.clone?.() || new THREE.Vector3(position.x, position.y, position.z);
      if (camera && sourcePosition.distanceTo(camera.position) > cullDistance) return false;
    }

    const baseScale = positional ? (opts.volumeScale ?? positionalSfxVolumeScale) : 1;
    const gain = audioCtx.createGain();
    gain.gain.value = volume * baseScale;
    const spatial = positional ? connectSpatialOutput(gain, sourcePosition, profile) : null;
    if (!positional) gain.connect(sfxGain);

    let inner = null;
    try {
      inner = build(audioCtx, gain, audioCtx.currentTime);
    } catch {
      inner = null;
    }

    if (!inner || typeof inner.stop !== 'function') {
      try { gain.disconnect(); } catch { /* already torn down */ }
      try { spatial?.panner?.disconnect(); } catch { /* already torn down */ }
      try { spatial?.stereo?.disconnect(); } catch { /* already torn down */ }
      return false;
    }

    let stopped = false;
    const handle = {
      id: nextLoopId++,
      isAlive: opts.isAlive || null,
      getPosition: opts.getPosition || null,
      cullDistance,
      // Ramps the shared gain down, lets the voice stop itself, then drops the chain.
      stop(fadeOutS = 0.15) {
        if (stopped) return;
        stopped = true;
        activeLoops.delete(handle);
        const fade = Math.max(0, Number(fadeOutS) || 0);
        const now = audioCtx.currentTime;
        try {
          gain.gain.cancelScheduledValues?.(now);
          gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), now);
          if (fade > 0) gain.gain.linearRampToValueAtTime(0.0001, now + fade);
          else gain.gain.setValueAtTime(0.0001, now);
        } catch { /* param automation unavailable */ }
        try { inner.stop(now + fade); } catch { /* voice already stopped */ }
        setTimeout(() => {
          try { gain.disconnect(); } catch { /* already torn down */ }
          try { spatial?.panner?.disconnect(); } catch { /* already torn down */ }
          try { spatial?.stereo?.disconnect(); } catch { /* already torn down */ }
        }, (fade + 0.25) * 1000);
      },
      // Callers duck a pile-up of sirens through this rather than rebuilding the voice.
      setTargetVolume(v, rampS = 0.2) {
        if (stopped) return;
        const target = Math.max(0.0001, normalizeSfxVolume(v) * baseScale);
        const now = audioCtx.currentTime;
        try {
          gain.gain.cancelScheduledValues?.(now);
          gain.gain.setValueAtTime(Math.max(gain.gain.value, 0.0001), now);
          gain.gain.linearRampToValueAtTime(target, now + Math.max(0.01, rampS));
        } catch { /* param automation unavailable */ }
      },
      updatePosition(pos) {
        if (stopped || !spatial?.panner || !isAudioPosition(pos)) return;
        setPannerPosition(spatial.panner, pos);
      },
      get stopped() { return stopped; },
    };

    activeLoops.add(handle);
    return handle;
  }

  // Backstop for the unclean paths: corpse culled mid-siren, scene reset, owner GC'd out from
  // under a stale closure. The owning module still stops its own loops on the paths it controls,
  // because only it knows whether the ending deserves a fade or a power-down.
  function sweepActiveLoops() {
    if (!activeLoops.size) return;
    for (const handle of [...activeLoops]) {
      if (handle.isAlive && !handle.isAlive()) { handle.stop(0); continue; }
      if (!handle.getPosition || !camera) continue;
      const pos = handle.getPosition();
      if (!isAudioPosition(pos)) continue;
      const dx = pos.x - camera.position.x;
      const dy = pos.y - camera.position.y;
      const dz = pos.z - camera.position.z;
      if (dx * dx + dy * dy + dz * dz > handle.cullDistance * handle.cullDistance) handle.stop(0.1);
      else handle.updatePosition(pos);
    }
  }

  function musicEntryPaths(entry) {
    if (!entry) return [];
    if (typeof entry === 'string') return [entry];
    return entry.paths || [];
  }

  function pickMusicPath(eventId) {
    const entry = musicPaths[eventId];
    if (typeof entry === 'string') return entry;
    if (!entry?.paths?.length) return null;

    if (entry.mode === 'sequence') {
      const path = entry.paths[entry.nextIndex % entry.paths.length];
      entry.nextIndex = (entry.nextIndex + 1) % entry.paths.length;
      return path;
    }
    return entry.paths[Math.floor(Math.random() * entry.paths.length)];
  }

  function isMusicEvent(eventId) {
    return musicEventIds.has(eventId);
  }

  // [ADAPTATION] Viewer callback replacing shooter desiredMusicEvent().
  // Gameplay does NOT fall back to music_menu when music_game is unassigned -- silence
  // during gameplay is preferred over the menu track bleeding into actual play.
  function desiredMusicEvent() {
    if (isGameplayActive?.()) return musicEntryPaths(musicPaths.music_game).length ? 'music_game' : '';
    return 'music_menu';
  }

  function musicEntryVolume(eventId) {
    if (eventId === 'music_folder') return 1;
    return normalizeSfxVolume(musicPaths[eventId]?.volume);
  }

  // [ADAPTATION] Environment base music volumes: 0.14 gameplay / 0.16 menu,
  // with optional ducking through options.isDucked().
  function targetMusicVolume(eventId = currentMusic?.eventId || desiredMusicEvent()) {
    const masterVol = effectiveMasterVol();
    const musicVol = effectiveMusicVol();
    if (masterVol <= 0 || musicVol <= 0) return 0;
    const baseVolume = isDucked() ? 0.06 : isGameplayActive() ? 0.14 : 0.16;
    return baseVolume * musicEntryVolume(eventId) * masterVol * musicVol;
  }

  // ---- Speaker orb (environment-only behaviors) ----
  function createMusicSpeakerOrb() {
    const group = new THREE.Group();
    const shellMat = new THREE.MeshStandardMaterial({
      color: 0x17384a,
      emissive: 0x0b7599,
      emissiveIntensity: 1.15,
      metalness: 0.62,
      roughness: 0.28,
    });
    const glowMat = new THREE.MeshBasicMaterial({
      color: 0x6ee8ff,
      transparent: true,
      opacity: 0.72,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const darkMat = new THREE.MeshStandardMaterial({
      color: 0x02080c,
      emissive: 0x061820,
      emissiveIntensity: 0.55,
      metalness: 0.35,
      roughness: 0.5,
    });

    const shell = new THREE.Mesh(new THREE.SphereGeometry(0.42, 20, 14), shellMat);
    group.add(shell);

    const core = new THREE.Mesh(new THREE.SphereGeometry(0.19, 14, 10), glowMat);
    core.position.z = 0.34;
    group.add(core);

    const speaker = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.13, 0.16, 18), darkMat);
    speaker.rotation.x = Math.PI / 2;
    speaker.position.z = 0.39;
    group.add(speaker);

    const ringA = new THREE.Mesh(new THREE.TorusGeometry(0.56, 0.025, 8, 28), glowMat.clone());
    const ringB = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.018, 8, 28), glowMat.clone());
    ringA.rotation.x = Math.PI / 2;
    ringB.rotation.y = Math.PI / 2;
    group.add(ringA, ringB);

    group.userData.musicSpeakerCore = core;
    group.userData.musicSpeakerRingA = ringA;
    group.userData.musicSpeakerRingB = ringB;
    group.visible = false;
    scene?.add(group);
    return group;
  }

  function ensureMusicSpeakerOrb() {
    if (!musicSpeakerOrb) musicSpeakerOrb = createMusicSpeakerOrb();
    return musicSpeakerOrb;
  }

  function musicSpeakerPosition() {
    if (musicSpeakerOrb?.visible) return musicSpeakerOrb.position;
    const base = camera ? camera.position : getPlayerPosition();
    const right = new THREE.Vector3(1, 0, 0);
    if (camera) right.applyQuaternion(camera.quaternion);
    right.y = 0;
    if (right.lengthSq() <= 0.0001) right.set(1, 0, 0);
    return base.clone().add(right.normalize().multiplyScalar(2.2));
  }

  // [ADAPTATION] Only global/speaker output remains; airship output removed.
  function musicOutputPosition() {
    return musicSpeakerPosition();
  }

  function musicAttenuationScale() {
    return THREE.MathUtils.clamp(musicEffectSettings.attenuation / 100, 0, 2);
  }

  function updateMusicEffectNodes(track = currentMusic) {
    if (!track) return;
    const echoAmount = THREE.MathUtils.clamp(musicEffectSettings.echo / 100, 0, 1);
    const reverbAmount = THREE.MathUtils.clamp(musicEffectSettings.reverb / 100, 0, 1);
    if (track.bassFilter) setAudioParamValue(track.bassFilter.gain, musicEffectSettings.bass);
    if (track.echoWetGain) setAudioParamValue(track.echoWetGain.gain, echoAmount * 0.72);
    if (track.echoFeedback) setAudioParamValue(track.echoFeedback.gain, 0.18 + echoAmount * 0.38);
    if (track.reverbWetGain) setAudioParamValue(track.reverbWetGain.gain, reverbAmount * 0.68);
    updateMusicPitchAndTempo(track);
  }

  function updateMusicPitchAndTempo(track = currentMusic) {
    const audio = track?.audio;
    if (!audio) return;
    const tempoRatio = THREE.MathUtils.clamp(musicEffectSettings.tempo / 100, 0.5, 2);
    const pitchSemitones = THREE.MathUtils.clamp(musicEffectSettings.pitch, -12, 12);
    const pitchRatio = Math.pow(2, pitchSemitones / 12);
    audio.preservesPitch = true;
    audio.webkitPreservesPitch = true;
    audio.mozPreservesPitch = true;
    audio.playbackRate = tempoRatio;
    if (track.pitchWorklet?.parameters) {
      setAudioParamValue(track.pitchWorklet.parameters.get('pitchRatio'), pitchRatio);
    }
  }

  // [ADAPTATION] Worklet module URL is the injected local workletUrl.
  function ensureMusicPitchWorklet() {
    if (!audioCtx?.audioWorklet || typeof AudioWorkletNode === 'undefined') {
      musicPitchWorkletAvailable = false;
      return Promise.resolve(false);
    }
    if (!musicPitchWorkletPromise) {
      musicPitchWorkletPromise = audioCtx.audioWorklet
        .addModule(workletUrl)
        .then(() => true)
        .catch(err => {
          musicPitchWorkletAvailable = false;
          appendDebugLog(`music pitch worklet unavailable: ${err?.message || err}`);
          return false;
        });
    }
    return musicPitchWorkletPromise;
  }

  function updateMusicTrackOutput(track = currentMusic) {
    if (!track) return;
    const positional = musicOutputMode === 'speaker';
    const attenuation = musicAttenuationScale();
    if (track.globalGain) setAudioParamValue(track.globalGain.gain, positional ? 0 : 1);
    if (track.speakerGain) setAudioParamValue(track.speakerGain.gain, positional ? 1 : 0);
    if (track.spatialPanner) {
      configurePanner(track.spatialPanner, {
        distanceModel: 'inverse',
        refDistance: 2.4,
        maxDistance: 52,
        rolloffFactor: 1.05 * attenuation,
      });
      setPannerPosition(track.spatialPanner, musicOutputPosition());
    }
  }

  function getMusicReverbImpulse() {
    if (musicReverbImpulse || !audioCtx) return musicReverbImpulse;
    const duration = 2.4;
    const length = Math.max(1, Math.floor(audioCtx.sampleRate * duration));
    const impulse = audioCtx.createBuffer(2, length, audioCtx.sampleRate);
    for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        const decay = Math.pow(1 - i / length, 2.6);
        data[i] = (Math.random() * 2 - 1) * decay;
      }
    }
    musicReverbImpulse = impulse;
    return impulse;
  }

  async function connectMusicTrackOutput(track) {
    if (!track?.audio || !initAudio()) return;
    let source = null;
    try {
      source = audioCtx.createMediaElementSource(track.audio);
      const workletReady = await ensureMusicPitchWorklet();
      if (track.released) {
        source.disconnect();
        return;
      }
      const pitchWorklet = workletReady
        ? new AudioWorkletNode(audioCtx, 'music-pitch-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        })
        : null;
      const bassFilter = audioCtx.createBiquadFilter();
      const effectMix = audioCtx.createGain();
      const effectLimiter = audioCtx.createDynamicsCompressor();
      const echoDelay = audioCtx.createDelay(1.5);
      const echoFeedback = audioCtx.createGain();
      const echoWetGain = audioCtx.createGain();
      const reverbConvolver = audioCtx.createConvolver();
      const reverbWetGain = audioCtx.createGain();
      const globalGain = audioCtx.createGain();
      const speakerGain = audioCtx.createGain();
      const spatialLimiter = audioCtx.createDynamicsCompressor();
      const spatialPanner = audioCtx.createPanner();
      bassFilter.type = 'lowshelf';
      bassFilter.frequency.value = 180;
      echoDelay.delayTime.value = 0.3;
      reverbConvolver.buffer = getMusicReverbImpulse();
      effectLimiter.threshold.value = -8;
      effectLimiter.knee.value = 8;
      effectLimiter.ratio.value = 12;
      effectLimiter.attack.value = 0.003;
      effectLimiter.release.value = 0.18;
      spatialLimiter.threshold.value = -5;
      spatialLimiter.knee.value = 6;
      spatialLimiter.ratio.value = 16;
      spatialLimiter.attack.value = 0.002;
      spatialLimiter.release.value = 0.16;
      configurePanner(spatialPanner, {
        distanceModel: 'inverse',
        refDistance: 2.4,
        maxDistance: 52,
        rolloffFactor: 1.05,
      });
      if (pitchWorklet) {
        source.connect(pitchWorklet);
        pitchWorklet.connect(bassFilter);
      } else {
        source.connect(bassFilter);
      }
      bassFilter.connect(effectMix);
      bassFilter.connect(echoDelay);
      echoDelay.connect(echoWetGain);
      echoWetGain.connect(effectMix);
      echoDelay.connect(echoFeedback);
      echoFeedback.connect(echoDelay);
      bassFilter.connect(reverbConvolver);
      reverbConvolver.connect(reverbWetGain);
      reverbWetGain.connect(effectMix);
      effectMix.connect(effectLimiter);
      effectLimiter.connect(globalGain);
      globalGain.connect(audioCtx.destination);
      // Spectrum tap: post-effects, pre-output, so what the visuals see is what you hear.
      // releaseMusicTrack's effectLimiter.disconnect() drops this along with everything else.
      const analyser = ensureMusicAnalyser();
      if (analyser) effectLimiter.connect(analyser);
      effectLimiter.connect(speakerGain);
      speakerGain.connect(spatialLimiter);
      spatialLimiter.connect(spatialPanner);
      spatialPanner.connect(audioCtx.destination);
      track.mediaSource = source;
      track.pitchWorklet = pitchWorklet;
      track.bassFilter = bassFilter;
      track.effectMix = effectMix;
      track.effectLimiter = effectLimiter;
      track.echoDelay = echoDelay;
      track.echoFeedback = echoFeedback;
      track.echoWetGain = echoWetGain;
      track.reverbConvolver = reverbConvolver;
      track.reverbWetGain = reverbWetGain;
      track.globalGain = globalGain;
      track.speakerGain = speakerGain;
      track.spatialLimiter = spatialLimiter;
      track.spatialPanner = spatialPanner;
      updateMusicEffectNodes(track);
      updateMusicTrackOutput(track);
    } catch (err) {
      try {
        source?.connect(audioCtx.destination);
      } catch {
        // The browser may reject reconnecting a partially constructed media source.
      }
      appendDebugLog(`music processing fallback: ${err?.message || err}`);
    }
  }

  // [ADAPTATION] front/behind/orbit/above only; enemies behavior removed.
  function musicSpeakerBehaviorTarget(timestamp) {
    const playerPos = getPlayerPosition();
    const right = new THREE.Vector3(1, 0, 0);
    const forward = new THREE.Vector3(0, 0, -1);
    if (camera) {
      right.applyQuaternion(camera.quaternion);
      forward.applyQuaternion(camera.quaternion);
    }
    right.y = 0;
    forward.y = 0;
    if (right.lengthSq() <= 0.0001) right.set(1, 0, 0);
    if (forward.lengthSq() <= 0.0001) forward.set(0, 0, -1);
    right.normalize();
    forward.normalize();

    const bob = Math.sin(timestamp * 0.0024) * 0.18;
    if (musicSpeakerBehavior === 'behind') {
      return playerPos.clone().add(forward.multiplyScalar(-2.7)).add(new THREE.Vector3(0, 0.55 + bob, 0));
    }
    if (musicSpeakerBehavior === 'orbit') {
      const angle = timestamp * 0.00055;
      return playerPos.clone().add(new THREE.Vector3(
        Math.cos(angle) * 3.1,
        0.35 + Math.sin(timestamp * 0.0021) * 0.32,
        Math.sin(angle) * 3.1,
      ));
    }
    if (musicSpeakerBehavior === 'above') {
      return playerPos.clone().add(new THREE.Vector3(0, 3.5, 0));
    }
    return playerPos.clone().add(forward.multiplyScalar(2.8)).add(new THREE.Vector3(0, 0.55 + bob, 0));
  }

  function updateMusicSpeakerOrb(timestamp = perfNow()) {
    const active = musicOutputMode === 'speaker';
    if (!musicSpeakerOrb && !active) return;
    const orb = ensureMusicSpeakerOrb();
    const wasVisible = orb.visible;
    orb.visible = active;

    if (active) {
      const target = musicSpeakerBehaviorTarget(timestamp);
      const followRate = musicSpeakerBehavior === 'orbit' ? 0.08 : 0.12;
      if (wasVisible && musicSpeakerBehavior !== 'above') orb.position.lerp(target, followRate);
      else orb.position.copy(target);
      orb.rotation.y += 0.012;
      orb.userData.musicSpeakerRingA.rotation.z += 0.018;
      orb.userData.musicSpeakerRingB.rotation.x -= 0.014;
      orb.userData.musicSpeakerCore.scale.setScalar(0.92 + Math.sin(timestamp * 0.006) * 0.12);
    }

    if (currentMusic?.spatialPanner) setPannerPosition(currentMusic.spatialPanner, musicOutputPosition());
  }

  // ---- Music playback ----
  function fadeAudio(audio, targetVolume, duration = 0.6, onDone = null) {
    if (!audio) return;
    cancelAnimationFrame(audio._musicFadeFrame || 0);

    const startVolume = Math.max(0, Math.min(1, Number(audio.volume) || 0));
    const endVolume = Math.max(0, Math.min(1, Number(targetVolume) || 0));
    const startTime = perfNow();
    const durationMs = Math.max(1, duration * 1000);

    const step = now => {
      const t = Math.min(1, (now - startTime) / durationMs);
      audio.volume = Math.max(0, Math.min(1, startVolume + (endVolume - startVolume) * t));
      if (t < 1) {
        audio._musicFadeFrame = requestAnimationFrame(step);
      } else {
        audio._musicFadeFrame = 0;
        onDone?.();
      }
    };

    audio._musicFadeFrame = requestAnimationFrame(step);
  }

  function releaseMusicTrack(track) {
    if (!track) return;
    track.released = true;
    cancelAnimationFrame(track.audio?._musicFadeFrame || 0);
    track.mediaSource?.disconnect?.();
    track.pitchWorklet?.disconnect?.();
    track.bassFilter?.disconnect?.();
    track.effectMix?.disconnect?.();
    track.effectLimiter?.disconnect?.();
    track.echoDelay?.disconnect?.();
    track.echoFeedback?.disconnect?.();
    track.echoWetGain?.disconnect?.();
    track.reverbConvolver?.disconnect?.();
    track.reverbWetGain?.disconnect?.();
    track.globalGain?.disconnect?.();
    track.speakerGain?.disconnect?.();
    track.spatialLimiter?.disconnect?.();
    track.spatialPanner?.disconnect?.();
    track.audio.pause();
    track.audio.removeAttribute('src');
    track.audio.load();
    if (!track.cached) URL.revokeObjectURL(track.url);
  }

  function clearMusicUrlCache() {
    musicUrlCache.forEach(entry => URL.revokeObjectURL(entry.url));
    musicUrlCache.clear();
  }

  function folderMusicCacheKey(relPath) {
    return `music-folder:${relPath}`;
  }

  function resetMusicPlayback() {
    musicRequestId++;
    pendingMusicRetry = false;
    desiredMusicEventId = '';
    desiredMusicPath = '';
    if (currentMusic) {
      releaseMusicTrack(currentMusic);
      currentMusic = null;
    }
    clearMusicUrlCache();
  }

  async function cacheMusicPath(relPath) {
    if (!relPath || !sfxDirHandle) return null;
    const cached = musicUrlCache.get(relPath);
    if (cached) return cached;
    const fileHandle = await getFileByKey(sfxDirHandle, relPath);
    const file = await fileHandle.getFile();
    const entry = { url: URL.createObjectURL(file) };
    musicUrlCache.set(relPath, entry);
    return entry;
  }

  async function cacheFolderMusicPath(relPath) {
    if (!relPath || !musicFolderHandle) return null;
    const key = folderMusicCacheKey(relPath);
    const cached = musicUrlCache.get(key);
    if (cached) return cached;
    const fileHandle = await getFileByKey(musicFolderHandle, relPath);
    const file = await fileHandle.getFile();
    const entry = { url: URL.createObjectURL(file) };
    musicUrlCache.set(key, entry);
    return entry;
  }

  async function warmMusicPaths(paths) {
    let failed = 0;
    for (const relPath of [...new Set(paths.filter(Boolean))]) {
      try {
        await cacheMusicPath(relPath);
      } catch {
        failed++;
      }
    }
    return failed;
  }

  async function warmAvailableMusicPaths(relPaths, sourcePaths) {
    const paths = [];
    let failed = 0;
    const count = Math.max(relPaths.length, sourcePaths.length);
    for (let i = 0; i < count; i++) {
      const candidates = [relPaths[i], sourcePaths[i]].filter(Boolean);
      let loaded = false;
      for (const relPath of candidates) {
        if (paths.includes(relPath)) {
          loaded = true;
          break;
        }
        try {
          await cacheMusicPath(relPath);
          paths.push(relPath);
          loaded = true;
          break;
        } catch {
          // Try the source path before counting the track as unavailable.
        }
      }
      if (!loaded && candidates.length) failed++;
    }
    return { paths, failed };
  }

  function isAutoplayBlock(err) {
    const text = `${err?.name || ''} ${err?.message || ''}`.toLowerCase();
    return text.includes('notallowed') || text.includes('interact') || text.includes('user activation');
  }

  function handleMusicPlaySuccess() {
    pendingMusicRetry = false;
    if (persistentSfxStatus && statusText.startsWith('Music ready')) {
      showSfxStatus(persistentSfxStatus);
    }
    notify();
  }

  function handleMusicPlayFailure(err) {
    if (isAutoplayBlock(err)) {
      pendingMusicRetry = true;
      if (isGameplayActive()) {
        showSfxStatus('Music ready - click or press any key to play');
      } else if (persistentSfxStatus) {
        showSfxStatus(persistentSfxStatus);
      } else {
        showSfxStatus('Music ready');
      }
      return;
    }
    pendingMusicRetry = false;
    showSfxStatus(`Music failed: ${err?.message || err?.name || 'play failed'}`);
  }

  function startMusicTrack(track, fadeDuration = 0.7) {
    if (!track?.audio || currentMusic !== track) return;
    if (musicUserPaused) {
      track.audio.pause();
      fadeAudio(track.audio, 0, Math.min(0.18, fadeDuration));
      notify();
      return;
    }

    if (!track.audio.paused && !pendingMusicRetry) {
      fadeAudio(track.audio, targetMusicVolume(), fadeDuration);
      return;
    }

    const requestId = musicRequestId;
    const playResult = track.audio.play();
    if (playResult?.then) {
      playResult
        .then(() => {
          if (requestId === musicRequestId && currentMusic === track) handleMusicPlaySuccess();
        })
        .catch(err => {
          if (requestId === musicRequestId && currentMusic === track) handleMusicPlayFailure(err);
        });
    } else {
      handleMusicPlaySuccess();
    }
    fadeAudio(track.audio, targetMusicVolume(), fadeDuration);
  }

  function stopMusic(fadeDuration = 0.5) {
    musicRequestId++;
    pendingMusicRetry = false;
    const track = currentMusic;
    currentMusic = null;
    if (!track) return;
    fadeAudio(track.audio, 0, fadeDuration, () => releaseMusicTrack(track));
  }

  function activateMusicTrack(requestId, eventId, relPath, cached, fadeDuration, opts = {}) {
    if (requestId !== musicRequestId || desiredMusicEventId !== eventId || desiredMusicPath !== relPath) return;

    if (currentMusic?.eventId === eventId && currentMusic.path === relPath) {
      startMusicTrack(currentMusic, fadeDuration);
      return;
    }

    const previous = currentMusic;
    currentMusic = null;
    if (previous) {
      fadeAudio(previous.audio, 0, fadeDuration, () => releaseMusicTrack(previous));
    }

    const audio = new Audio(cached.url);
    const track = {
      eventId,
      path: relPath,
      sourcePath: opts.sourcePath || relPath,
      label: opts.label || musicTrackLabel(opts.sourcePath || relPath),
      audio,
      url: cached.url,
      cached: true,
    };
    audio.loop = false;
    audio.volume = 0;
    audio.preload = 'auto';
    audio.addEventListener('ended', () => {
      if (currentMusic === track && !musicUserPaused) playNextMusicTrack(0.35);
    });

    currentMusic = track;
    connectMusicTrackOutput(track);
    startMusicTrack(track, fadeDuration);
    notify();
  }

  function playMusicEvent(eventId, fadeDuration = 0.7) {
    const entry = musicPaths[eventId];
    const paths = musicEntryPaths(entry);
    desiredMusicEventId = eventId || '';
    if (!eventId || !paths.length || !sfxDirHandle) {
      desiredMusicPath = '';
      stopMusic(fadeDuration);
      return;
    }

    const relPath = currentMusic?.eventId === eventId && paths.includes(currentMusic.path)
      ? currentMusic.path
      : desiredMusicEventId === eventId && paths.includes(desiredMusicPath)
        ? desiredMusicPath
        : pickMusicPath(eventId);
    if (!relPath) {
      desiredMusicPath = '';
      stopMusic(fadeDuration);
      return;
    }

    desiredMusicPath = relPath;
    const requestId = ++musicRequestId;
    if (currentMusic?.eventId === eventId && currentMusic.path === relPath) {
      startMusicTrack(currentMusic, fadeDuration);
      return;
    }

    const cached = musicUrlCache.get(relPath);
    if (cached) {
      activateMusicTrack(requestId, eventId, relPath, cached, fadeDuration);
      return;
    }

    cacheMusicPath(relPath)
      .then(entry => {
        if (!entry) throw new Error('No music file');
        activateMusicTrack(requestId, eventId, relPath, entry, fadeDuration);
      })
      .catch(() => {
        if (requestId === musicRequestId && desiredMusicEventId === eventId && desiredMusicPath === relPath) {
          showSfxStatus(`Music missing ${eventId}`);
        }
      });
  }

  function syncMusicForState(fadeDuration = 0.7) {
    if (musicSourceMode === 'folder') {
      const currentPath = currentMusic?.eventId === 'music_folder' && musicFolderPaths.includes(currentMusic.path)
        ? currentMusic.path
        : initialTrackPath(activeMusicPlaylist());
      if (currentPath) playFolderMusicPath(currentPath, fadeDuration);
      else stopMusic(fadeDuration);
      return;
    }
    if (musicSourceMode === 'http') {
      const currentPath = currentMusic?.eventId === 'music_http' && musicHttpPaths.includes(currentMusic.path)
        ? currentMusic.path
        : initialTrackPath(activeMusicPlaylist());
      if (currentPath) playHttpMusicPath(currentPath, fadeDuration);
      else stopMusic(fadeDuration);
      return;
    }
    playMusicEvent(desiredMusicEvent(), fadeDuration);
  }

  function syncMusicAfterGesture() {
    initAudio();
    if (musicUserPaused) return;
    if (!autoplayOnGesture && !currentMusic && !pendingMusicRetry) return;
    if (pendingMusicRetry || !currentMusic || currentMusic.audio.paused) {
      syncMusicForState(0.2);
    }
  }

  function musicTrackLabel(path) {
    const raw = String(path || '').split('/').pop() || 'NO TRACK';
    return raw
      .replace(/\.[^.]+$/, '')
      .replace(/^music_(menu|game)__(music_)?/i, '')
      .replace(/^music_(menu|game)$/i, '$1')
      .replace(/_/g, ' ')
      .trim() || raw;
  }

  function activeMusicPlaylist() {
    if (musicSourceMode === 'folder') {
      return musicFolderPaths.map(path => ({ eventId: 'music_folder', path, label: musicTrackLabel(path) }));
    }
    if (musicSourceMode === 'http') {
      return musicHttpPaths.map(path => ({ eventId: 'music_http', path, label: musicTrackLabel(path) }));
    }
    const eventId = desiredMusicEvent();
    return musicEntryPaths(musicPaths[eventId]).map(path => ({ eventId, path, label: musicTrackLabel(path) }));
  }

  function currentMusicPlaylistPath() {
    return currentMusic?.path || '';
  }

  // Transport position for a progress bar. Polled per-frame by a UI, so it stays out of
  // getState()/notify() -- those only fire on real state changes.
  function getMusicProgress() {
    const audio = currentMusic?.audio;
    const duration = Number(audio?.duration);
    return {
      label: currentMusic?.label || '',
      path: currentMusicPlaylistPath(),
      currentTime: Number(audio?.currentTime) || 0,
      duration: Number.isFinite(duration) ? duration : 0,
      playing: isMusicPlaying(),
    };
  }

  function ensureMusicAnalyser() {
    if (musicAnalyser || !audioCtx) return musicAnalyser;
    musicAnalyser = audioCtx.createAnalyser();
    musicAnalyser.fftSize = 2048;              // ~23 Hz bins at 48 kHz -- enough to isolate bass
    musicAnalyser.smoothingTimeConstant = 0.72;
    analyserBins = new Uint8Array(musicAnalyser.frequencyBinCount);
    return musicAnalyser;
  }

  // getByteFrequencyData rebuilds the magnitude spectrum on every call, and a viewer typically
  // wants it twice in the same frame (getAudioLevels for the lights, getSpectrum for the display).
  // One read per 4 ms serves every caller: above 250 fps two callers may share a frame's bins,
  // which for a VU meter is invisible.
  let binsReadAt = -Infinity;
  function refreshAnalyserBins() {
    const now = perfNow();
    if (now - binsReadAt < 4) return;
    binsReadAt = now;
    musicAnalyser.getByteFrequencyData(analyserBins);
  }

  // Per-frame spectrum for visuals. Returns a REUSED object (never allocates) with 0..1 bands, an
  // overall `level`, and `beat`: a decaying envelope kicked when bass jumps above its own running
  // baseline. Everything reads 0 when no music is audible.
  function getAudioLevels() {
    const now = perfNow();
    const dt = Math.min(0.25, Math.max(0, (now - lastLevelsAt) / 1000)) || 0.016;
    lastLevelsAt = now;
    audioLevels.playing = isMusicPlaying();
    if (!musicAnalyser || !analyserBins || !audioCtx || !audioLevels.playing) {
      // Decay rather than snap, so pausing fades the lights out instead of dropping them.
      const decay = Math.exp(-dt * 6);
      audioLevels.bass *= decay; audioLevels.mid *= decay; audioLevels.treble *= decay;
      audioLevels.level *= decay; audioLevels.beat *= decay;
      return audioLevels;
    }
    refreshAnalyserBins();
    spectrumBands(analyserBins, audioCtx.sampleRate, musicAnalyser.fftSize, audioLevels);
    // Slow baseline + a refractory window: a kick reads as one beat, not one per frame it decays over.
    bassBaseline += (audioLevels.bass - bassBaseline) * Math.min(1, dt * 1.6);
    const isTransient = audioLevels.bass > bassBaseline * 1.25 + 0.02 && audioLevels.bass > 0.12;
    if (isTransient && now - lastBeatAt > 120) { lastBeatAt = now; audioLevels.beat = 1; }
    else audioLevels.beat *= Math.exp(-dt * 7);
    return audioLevels;
  }

  // Fills `out` (any array-like) with log-spaced band magnitudes for a spectrum display. When
  // nothing is audible the bars fall away instead of snapping flat.
  function getSpectrum(out) {
    if (!out?.length) return out;
    if (!musicAnalyser || !analyserBins || !audioCtx || !isMusicPlaying()) {
      for (let i = 0; i < out.length; i++) out[i] *= 0.82;
      return out;
    }
    refreshAnalyserBins();
    return spectrumBars(analyserBins, audioCtx.sampleRate, musicAnalyser.fftSize, out);
  }

  // fraction is 0..1 of the track's duration; a no-op until the browser knows the duration.
  function seekMusic(fraction) {
    const audio = currentMusic?.audio;
    const duration = Number(audio?.duration);
    if (!audio || !Number.isFinite(duration) || duration <= 0) return false;
    audio.currentTime = THREE.MathUtils.clamp(Number(fraction) || 0, 0, 1) * duration;
    return true;
  }

  // Which track a from-scratch start plays: the top of the list, or a shuffled pick.
  function initialTrackPath(tracks) {
    if (!tracks.length) return '';
    if (musicShuffle && tracks.length > 1) {
      ensureShuffleOrder(tracks);
      return shuffleOrder[0];
    }
    return tracks[0].path;
  }

  function playGameMusicPath(eventId, relPath, fadeDuration = 0.35) {
    if (!eventId || !relPath || !sfxDirHandle) return false;
    desiredMusicEventId = eventId;
    desiredMusicPath = relPath;
    const requestId = ++musicRequestId;
    if (currentMusic?.eventId === eventId && currentMusic.path === relPath) {
      startMusicTrack(currentMusic, fadeDuration);
      notify();
      return true;
    }
    const activate = cached => activateMusicTrack(requestId, eventId, relPath, cached, fadeDuration);
    const cached = musicUrlCache.get(relPath);
    if (cached) {
      activate(cached);
      return true;
    }
    cacheMusicPath(relPath)
      .then(entry => {
        if (!entry) throw new Error('No music file');
        activate(entry);
      })
      .catch(() => {
        if (requestId === musicRequestId) showSfxStatus(`Music missing ${eventId}`);
      });
    return true;
  }

  function playFolderMusicPath(relPath, fadeDuration = 0.35) {
    if (!relPath || !musicFolderHandle || !musicFolderPaths.includes(relPath)) return false;
    desiredMusicEventId = 'music_folder';
    desiredMusicPath = relPath;
    const requestId = ++musicRequestId;
    if (currentMusic?.eventId === 'music_folder' && currentMusic.path === relPath) {
      startMusicTrack(currentMusic, fadeDuration);
      notify();
      return true;
    }
    const activate = cached => activateMusicTrack(requestId, 'music_folder', relPath, cached, fadeDuration, {
      sourcePath: relPath,
      label: musicTrackLabel(relPath),
    });
    const cached = musicUrlCache.get(folderMusicCacheKey(relPath));
    if (cached) {
      activate(cached);
      return true;
    }
    cacheFolderMusicPath(relPath)
      .then(entry => {
        if (!entry) throw new Error('No music file');
        activate(entry);
      })
      .catch(() => {
        if (requestId === musicRequestId) showSfxStatus(`Music missing ${musicTrackLabel(relPath)}`);
      });
    return true;
  }

  // Served track: the URL is the file itself, so there is nothing to cache or revoke.
  function playHttpMusicPath(relPath, fadeDuration = 0.35) {
    if (!relPath || !musicHttpPaths.includes(relPath)) return false;
    desiredMusicEventId = 'music_http';
    desiredMusicPath = relPath;
    const requestId = ++musicRequestId;
    if (currentMusic?.eventId === 'music_http' && currentMusic.path === relPath) {
      startMusicTrack(currentMusic, fadeDuration);
      notify();
      return true;
    }
    const url = musicHttpBase + relPath.split('/').map(encodeURIComponent).join('/');
    activateMusicTrack(requestId, 'music_http', relPath, { url }, fadeDuration, {
      sourcePath: relPath,
      label: musicTrackLabel(relPath),
    });
    return true;
  }

  function playMusicPlaylistEntry(entry, fadeDuration = 0.35) {
    if (!entry) return false;
    musicUserPaused = false;
    if (entry.eventId === 'music_folder') return playFolderMusicPath(entry.path, fadeDuration);
    if (entry.eventId === 'music_http') return playHttpMusicPath(entry.path, fadeDuration);
    return playGameMusicPath(entry.eventId, entry.path, fadeDuration);
  }

  function playlistIdentity(tracks) {
    return tracks.map(track => `${track.eventId}|${track.path}`).join('\n');
  }

  // Fisher-Yates over the playlist's paths. `avoidFirst` keeps a fresh pass from repeating the
  // track that just played as its opening pick.
  function buildShuffleOrder(tracks, avoidFirst = '') {
    const order = tracks.map(track => track.path);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    if (order.length > 1 && avoidFirst && order[0] === avoidFirst) {
      [order[0], order[1]] = [order[1], order[0]];
    }
    shuffleOrder = order;
    shuffleKey = playlistIdentity(tracks);
  }

  // Rebuilds only when the playlist itself changed, so the order survives track changes.
  function ensureShuffleOrder(tracks) {
    if (shuffleKey !== playlistIdentity(tracks) || shuffleOrder.length !== tracks.length) {
      buildShuffleOrder(tracks, currentMusicPlaylistPath());
    }
  }

  function setShuffle(enabled) {
    const next = !!enabled;
    if (next === musicShuffle) return;
    musicShuffle = next;
    shuffleKey = '';   // a fresh order next time we step, seeded off whatever is playing now
    notify();
  }

  function stepMusicTrack(direction, fadeDuration = 0.35) {
    const tracks = activeMusicPlaylist();
    if (!tracks.length) return false;
    const currentPath = currentMusicPlaylistPath();
    if (musicShuffle && tracks.length > 1) {
      ensureShuffleOrder(tracks);
      const index = shuffleOrder.indexOf(currentPath);
      const target = index + direction;
      // Running off the end starts a fresh pass rather than replaying the same permutation.
      // Stepping back off the start does not reshuffle -- within a pass, prev must undo next.
      const reshuffle = index < 0 || target >= shuffleOrder.length;
      if (reshuffle) buildShuffleOrder(tracks, currentPath);
      const nextPath = reshuffle
        ? shuffleOrder[direction < 0 ? shuffleOrder.length - 1 : 0]
        : shuffleOrder[(target + shuffleOrder.length) % shuffleOrder.length];
      const entry = tracks.find(track => track.path === nextPath);
      if (entry) return playMusicPlaylistEntry(entry, fadeDuration);
    }
    const currentIndex = Math.max(0, tracks.findIndex(track => track.path === currentPath));
    const nextIndex = (currentIndex + direction + tracks.length) % tracks.length;
    return playMusicPlaylistEntry(tracks[nextIndex], fadeDuration);
  }

  function playNextMusicTrack(fadeDuration = 0.35) {
    return stepMusicTrack(1, fadeDuration);
  }

  function togglePlayback() {
    if (!currentMusic?.audio) {
      const tracks = activeMusicPlaylist();
      const startPath = initialTrackPath(tracks);
      const first = tracks.find(track => track.path === startPath);
      if (first) playMusicPlaylistEntry(first, 0.2);
      notify();
      return;
    }
    if (musicUserPaused || currentMusic.audio.paused) {
      musicUserPaused = false;
      startMusicTrack(currentMusic, 0.18);
    } else {
      musicUserPaused = true;
      currentMusic.audio.pause();
    }
    notify();
  }

  function prevTrack() {
    stepMusicTrack(-1);
  }

  function nextTrack() {
    stepMusicTrack(1);
  }

  function setMusicEffect(key, value) {
    if (!(key in musicEffectSettings)) return;
    const limits = key === 'bass'
      ? [0, 18]
      : key === 'attenuation' || key === 'tempo'
        ? [key === 'tempo' ? 50 : 0, 200]
        : key === 'pitch'
          ? [-12, 12]
          : [0, 100];
    const next = THREE.MathUtils.clamp(Number(value) || 0, limits[0], limits[1]);
    musicEffectSettings[key] = next;
    updateMusicEffectNodes();
    if (key === 'attenuation') updateMusicTrackOutput();
    if (key === 'pitch' && !musicPitchWorkletAvailable && next !== 0) {
      showSfxStatus('Independent pitch requires AudioWorklet support');
    }
    notify();
  }

  function setMusicOutput(mode) {
    if (mode !== 'global' && mode !== 'speaker') return;
    musicOutputMode = mode;
    updateMusicTrackOutput();
    updateMusicSpeakerOrb();
    notify();
  }

  function setMusicSpeakerBehavior(behavior) {
    if (!['front', 'behind', 'orbit', 'above'].includes(behavior)) return;
    musicSpeakerBehavior = behavior;
    updateMusicSpeakerOrb();
    notify();
  }

  function setMusicSource(mode) {
    if (!['game', 'folder', 'http'].includes(mode)) return;
    if (mode === 'folder' && !musicFolderPaths.length) {
      showSfxStatus('Choose a music folder first');
      return;
    }
    if (mode === 'http' && !musicHttpPaths.length) {
      showSfxStatus('No served music tracks');
      return;
    }
    if (musicSourceMode === mode) return;
    musicSourceMode = mode;
    musicUserPaused = false;
    syncMusicForState(0.35);
    notify();
  }

  // ---- Served music listing (no File System Access) ----
  // serve.py's GET /api/list-music lists sfx/music/, so a viewer gets a full playlist with no
  // folder pick and no sound-map assignment. Unlike the 'game' source this needs no sfxDirHandle.
  // `select` makes 'http' the active source without starting playback (autoplay stays opt-in,
  // same policy as the SFX loaders); `activate` also starts the first track.
  async function loadMusicHttp({ listUrl = '/api/list-music', baseUrl = './sfx/music/', activate = false, select = false } = {}) {
    let files = [];
    try {
      const res = await fetch(listUrl, { cache: 'no-store' });
      if (!res.ok) throw new Error('listing unavailable');
      const data = await res.json();
      files = Array.isArray(data?.files) ? data.files.filter(Boolean) : [];
    } catch {
      showSfxStatus('Served music listing unavailable');
      notify();
      return false;
    }
    files = files.filter(name => musicFileExtensions.has(extensionOf(name)));
    if (!files.length) {
      if (musicSourceMode === 'http') stopMusic(0.25);
      musicHttpPaths = [];
      notify();
      return false;
    }
    musicHttpBase = baseUrl;
    musicHttpPaths = files;
    if (activate || select) {
      musicSourceMode = 'http';
      musicUserPaused = false;
      if (activate) syncMusicForState(0.25);
    }
    notify();
    return true;
  }

  // ---- Specific music folder loading ----
  async function scanMusicFolder(dirHandle, dirPath = '') {
    const paths = [];
    for await (const entry of dirHandle.values()) {
      const relPath = dirPath ? `${dirPath}/${entry.name}` : entry.name;
      if (entry.kind === 'file' && musicFileExtensions.has(extensionOf(entry.name))) {
        paths.push(relPath);
      } else if (entry.kind === 'directory') {
        paths.push(...await scanMusicFolder(entry, relPath));
      }
    }
    return paths.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  async function loadMusicFolder(dirHandle, { activate = true } = {}) {
    const paths = await scanMusicFolder(dirHandle);
    if (!paths.length) {
      if (musicSourceMode === 'folder') stopMusic(0.25);
      showSfxStatus(`${dirHandle.name} has no supported music files`);
      notify();
      return;
    }
    resetMusicPlayback();
    musicFolderHandle = dirHandle;
    musicFolderPaths = paths;
    await sfxHandleStore.save(musicRootHandleKey, dirHandle);
    showSfxStatus(`Music folder ${dirHandle.name}: ${musicFolderPaths.length} track${musicFolderPaths.length === 1 ? '' : 's'}`);
    if (activate) {
      musicSourceMode = 'folder';
      musicUserPaused = false;
      syncMusicForState(0.25);
    }
    notify();
  }

  async function pickMusicFolder() {
    if (!window.showDirectoryPicker) {
      showSfxStatus('Music folder picker requires Chrome or Edge');
      return;
    }
    try {
      const opts = { mode: 'read', id: musicPickerId };
      const stored = await sfxHandleStore.get(musicRootHandleKey);
      if (stored && await stored.queryPermission({ mode: 'read' }) === 'granted') {
        opts.startIn = stored;
      }
      const handle = await window.showDirectoryPicker(opts);
      await loadMusicFolder(handle, { activate: true });
    } catch (err) {
      if (err.name !== 'AbortError') showSfxStatus('Music folder load failed');
    }
  }

  async function restoreMusicFolder() {
    const stored = await sfxHandleStore.get(musicRootHandleKey);
    if (!stored) return;
    try {
      const perm = await stored.queryPermission({ mode: 'read' });
      if (perm === 'granted') {
        await loadMusicFolder(stored, { activate: true });
      }
    } catch {
      // Music folder restoration is optional.
    }
  }

  // ---- SFX folder loading + sound-map.json ----
  async function decodeSfxFile(dirHandle, relPath) {
    const wavHandle = await getFileByKey(dirHandle, relPath);
    const file = await wavHandle.getFile();
    return audioCtx.decodeAudioData(await file.arrayBuffer());
  }

  async function decodeFirstAvailableSfxFile(dirHandle, relPaths) {
    let lastError = null;
    for (const relPath of relPaths.filter(Boolean)) {
      try {
        return await decodeSfxFile(dirHandle, relPath);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('No sound paths to load');
  }

  // ---- SFX loading over http (no folder picker) ----
  // Same sound-map.json shape as loadSfxSounds, fetched from the server instead of a picked
  // FileSystemDirectoryHandle, so SFX play without the user granting folder access first.
  async function decodeSfxUrl(baseUrl, relPath) {
    const res = await fetch(baseUrl + relPath, { cache: 'no-store' });
    if (!res.ok) throw new Error(`sfx fetch failed: ${relPath}`);
    return audioCtx.decodeAudioData(await res.arrayBuffer());
  }

  async function decodeFirstAvailableSfxUrl(baseUrl, relPaths) {
    let lastError = null;
    for (const relPath of relPaths.filter(Boolean)) {
      try {
        return await decodeSfxUrl(baseUrl, relPath);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error('No sound paths to load');
  }

  async function loadSfxSoundsHttp(baseUrl = './sfx/') {
    resetMusicPlayback();
    sfxDirHandle = null;
    sfxBuffers = {};
    musicPaths = {};

    if (!initAudio()) {
      showPersistentSfxStatus('Audio unavailable');
      return false;
    }

    let map;
    try {
      const res = await fetch(baseUrl + 'sound-map.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('not found');
      map = await res.json();
    } catch {
      showPersistentSfxStatus('No sound-map.json found');
      return false;
    }

    const validIds = new Set(SOUND_EVENTS);
    const events = map.events || {};
    const sources = map.sources || {};
    const modes = map.modes || {};
    const volumes = map.volumes || {};
    const entries = Object.entries(events)
      .filter(([eventId]) => validIds.has(eventId))
      .map(([eventId, relPaths]) => [
        eventId,
        normalizeAudioList(relPaths),
        normalizeAudioList(sources[eventId]),
        modes[eventId] === 'sequence' ? 'sequence' : 'random',
        normalizeSfxVolume(volumes[eventId]),
      ]);

    let loadedEvents = 0;
    let loadedSounds = 0;
    let failed = (await ensureMusicEntriesReady(entries)).failed;

    for (const [eventId, relPaths, sourcePaths, mode, volume] of entries) {
      if (isMusicEvent(eventId)) continue;
      const buffers = [];
      const count = Math.max(relPaths.length, sourcePaths.length);
      for (let i = 0; i < count; i++) {
        try {
          buffers.push(await decodeFirstAvailableSfxUrl(baseUrl, [relPaths[i], sourcePaths[i]]));
        } catch {
          failed++;
        }
      }
      if (buffers.length) {
        sfxBuffers[eventId] = createSfxEntry(buffers, mode, volume);
        loadedEvents++;
        loadedSounds += buffers.length;
      }
    }

    const failedText = failed ? `, ${failed} missing` : '';
    showPersistentSfxStatus(`SFX ${loadedEvents} event${loadedEvents !== 1 ? 's' : ''}, ${loadedSounds} sound${loadedSounds !== 1 ? 's' : ''} loaded from ${baseUrl}${failedText}`);
    // No syncMusicForState() here -- loading buffers must not itself start playback. Menu
    // autoplay is start-screen.js's job (its own <audio> from sfx/music/); envAudio only plays
    // music in response to an explicit user action (Audio tab) or a real gameplay-state change.
    notify();
    return loadedEvents > 0;
  }

  async function ensureMusicPathReady(eventId, relPaths, sourcePaths, mode, volume = 1) {
    if (!relPaths.length && !sourcePaths.length) return { count: 0, failed: 0 };
    const { paths, failed } = await warmAvailableMusicPaths(relPaths, sourcePaths);
    if (!paths.length) return { count: 0, failed };
    musicPaths[eventId] = createMusicEntry(paths, mode, volume);
    return { count: paths.length, failed };
  }

  async function ensureMusicEntriesReady(entries) {
    let count = 0;
    let failed = 0;
    for (const [eventId, relPaths, sourcePaths, mode, volume] of entries) {
      if (!isMusicEvent(eventId)) continue;
      const result = await ensureMusicPathReady(eventId, relPaths, sourcePaths, mode, volume);
      count += result.count;
      failed += result.failed;
    }
    return { count, failed };
  }

  async function loadSfxSounds(dirHandle) {
    resetMusicPlayback();
    sfxDirHandle = dirHandle;
    sfxBuffers = {};
    musicPaths = {};

    if (!initAudio()) {
      showPersistentSfxStatus('Audio unavailable');
      return;
    }

    let mapHandle;
    try {
      mapHandle = await dirHandle.getFileHandle('sound-map.json');
    } catch {
      showPersistentSfxStatus('No sound-map.json found');
      return;
    }

    let map;
    try {
      map = JSON.parse(await (await mapHandle.getFile()).text());
    } catch {
      showPersistentSfxStatus('Invalid sound-map.json');
      return;
    }

    const validIds = new Set(SOUND_EVENTS);
    const events = map.events || {};
    const sources = map.sources || {};
    const modes = map.modes || {};
    const volumes = map.volumes || {};
    const entries = Object.entries(events)
      .filter(([eventId]) => validIds.has(eventId))
      .map(([eventId, relPaths]) => [
        eventId,
        normalizeAudioList(relPaths),
        normalizeAudioList(sources[eventId]),
        modes[eventId] === 'sequence' ? 'sequence' : 'random',
        normalizeSfxVolume(volumes[eventId]),
      ]);
    let loadedEvents = 0;
    let loadedSounds = 0;
    let loadedMusic = 0;
    let failed = 0;
    const musicLoad = await ensureMusicEntriesReady(entries);
    loadedMusic = musicLoad.count;
    failed += musicLoad.failed;

    for (const [eventId, relPaths, sourcePaths, mode, volume] of entries) {
      if (isMusicEvent(eventId)) continue;

      const buffers = [];
      const count = Math.max(relPaths.length, sourcePaths.length);
      for (let i = 0; i < count; i++) {
        try {
          buffers.push(await decodeFirstAvailableSfxFile(dirHandle, [relPaths[i], sourcePaths[i]]));
        } catch {
          failed++;
          // Missing or invalid sound files are simply skipped.
        }
      }

      if (buffers.length) {
        sfxBuffers[eventId] = createSfxEntry(buffers, mode, volume);
        loadedEvents++;
        loadedSounds += buffers.length;
      }
    }

    await sfxHandleStore.save(sfxRootHandleKey, dirHandle);
    const failedText = failed ? `, ${failed} missing` : '';
    showPersistentSfxStatus(`SFX ${loadedEvents} event${loadedEvents !== 1 ? 's' : ''}, ${loadedSounds} sound${loadedSounds !== 1 ? 's' : ''}, ${loadedMusic} music track${loadedMusic !== 1 ? 's' : ''} loaded${failedText}`);
    // No syncMusicForState() here either -- see loadSfxHttp's comment above.
    notify();
  }

  async function pickSfxFolder() {
    if (!window.showDirectoryPicker) {
      showSfxStatus('SFX folder picker requires Chrome or Edge');
      return;
    }
    try {
      const opts = { mode: 'readwrite', id: sfxPickerId };
      const stored = await sfxHandleStore.get(sfxRootHandleKey);
      if (stored && await stored.queryPermission({ mode: 'readwrite' }) === 'granted') {
        opts.startIn = stored;
      }
      const handle = await window.showDirectoryPicker(opts);
      await loadSfxSounds(handle);
    } catch (err) {
      if (err.name !== 'AbortError') showSfxStatus('SFX load failed');
    }
  }

  // Prefers a previously picked+granted folder (live-editable via sfx-browser.html); falls
  // back to fetching the repo's sfx/ folder over http so SFX play with zero setup.
  async function restoreSfxFolder() {
    const stored = await sfxHandleStore.get(sfxRootHandleKey);
    if (stored) {
      try {
        const perm = await stored.queryPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
          await loadSfxSounds(stored);
          return;
        }
      } catch {
        // fall through to the http fallback below
      }
    }
    await loadSfxSoundsHttp();
  }

  // ---- Live SFX updates (Task 6) ----
  const rememberLiveSfxMessage = payload => rememberLiveMessage(liveSfxSeen, payload);

  async function reloadSfxEvent(eventId, relPaths = [`assets/${eventId}.wav`], mode = 'random', volume = 1) {
    if (!sfxDirHandle || !soundEventIds.has(eventId)) return;
    const paths = normalizeAudioList(relPaths);
    if (isMusicEvent(eventId)) {
      musicPaths[eventId] = createMusicEntry(paths, mode, volume);
      await warmMusicPaths(paths);
      showSfxStatus(`Music updated ${eventId}`);
      if (musicSourceMode === 'game' && (currentMusic?.eventId === eventId || desiredMusicEvent() === eventId)) {
        playMusicEvent(eventId, 0.4);
      }
      notify();
      return;
    }

    if (!initAudio()) return;

    const buffers = [];
    let failed = 0;
    for (const relPath of paths) {
      try {
        buffers.push(await decodeSfxFile(sfxDirHandle, relPath));
      } catch {
        failed++;
      }
    }

    try {
      if (!buffers.length) throw new Error('No sounds loaded');
      sfxBuffers[eventId] = createSfxEntry(buffers, mode, volume);
      const failedText = failed ? ` (${failed} missing)` : '';
      showSfxStatus(`SFX updated ${eventId}${failedText}`);
    } catch {
      delete sfxBuffers[eventId];
      showSfxStatus(`SFX missing ${eventId}`);
    }
  }

  function updateLoadedSfxVolume(eventId, volume = 1) {
    const normalized = normalizeSfxVolume(volume);
    if (isMusicEvent(eventId)) {
      if (musicPaths[eventId]) musicPaths[eventId].volume = normalized;
      if (currentMusic?.eventId === eventId) {
        fadeAudio(currentMusic.audio, targetMusicVolume(eventId), 0.08);
      }
      showSfxStatus(`Music volume ${eventId} ${Math.round(normalized * 100)}%`);
      return;
    }

    const entry = sfxBuffers[eventId];
    if (entry?.buffers) entry.volume = normalized;
    showSfxStatus(`SFX volume ${eventId} ${Math.round(normalized * 100)}%`);
  }

  async function handleLiveSfxMessage(payload) {
    if (!payload || payload.source !== 'sfx-browser') return;
    if (rememberLiveSfxMessage(payload)) return;
    if (!soundEventIds.has(payload.eventId)) return;

    if (payload.type === 'sfx-updated') {
      await reloadSfxEvent(
        payload.eventId,
        payload.paths || payload.path || `assets/${payload.eventId}.wav`,
        payload.mode,
        payload.volume,
      );
    } else if (payload.type === 'sfx-volume') {
      updateLoadedSfxVolume(payload.eventId, payload.volume);
    } else if (payload.type === 'sfx-removed') {
      if (isMusicEvent(payload.eventId)) {
        delete musicPaths[payload.eventId];
        if (musicSourceMode === 'game' && (currentMusic?.eventId === payload.eventId || desiredMusicEvent() === payload.eventId)) {
          syncMusicForState(0.4);
        }
        showSfxStatus(`Music removed ${payload.eventId}`);
        notify();
        return;
      }

      delete sfxBuffers[payload.eventId];
      showSfxStatus(`SFX removed ${payload.eventId}`);
    }
  }

  function setupLiveSfxUpdates() {
    if (liveSfxChannel) return;
    liveSfxChannel = subscribeLiveUpdates(liveSfxChannelName, liveSfxStorageKey, handleLiveSfxMessage);
  }

  // ---- Public controller methods ----
  function init() {
    const ok = initAudio();
    setupLiveSfxUpdates();
    lastGameplayActive = !!isGameplayActive();
    notify();
    return ok;
  }

  function noteGesture() {
    syncMusicAfterGesture();
  }

  // [ADAPTATION] Listener update runs once per viewer frame; positional/speaker
  // orb follow the injected camera/player.
  function update(timestampMs = perfNow()) {
    updateAudioListener();
    const nowActive = !!isGameplayActive();
    if (nowActive !== lastGameplayActive) {
      lastGameplayActive = nowActive;
      if (currentMusic?.audio) fadeAudio(currentMusic.audio, targetMusicVolume(), 0.4);
      syncMusicForState(0.4);
    }
    updateMusicSpeakerOrb(timestampMs);
    sweepActiveLoops();
  }

  function setVolume(kind, value) {
    if (!['master', 'music', 'sfx'].includes(kind)) return;
    audioSettings[`${kind}Vol`] = clamp01(value);
    applyAudioSettings();
  }

  function setMuted(kind, muted) {
    if (!['master', 'music', 'sfx'].includes(kind)) return;
    audioSettings[`${kind}Muted`] = !!muted;
    applyAudioSettings();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const handle of [...activeLoops]) handle.stop(0);
    activeLoops.clear();
    resetMusicPlayback();
    clearMusicUrlCache();

    if (musicSpeakerOrb) {
      scene?.remove(musicSpeakerOrb);
      musicSpeakerOrb.traverse(node => {
        node.geometry?.dispose?.();
        const mat = node.material;
        if (Array.isArray(mat)) mat.forEach(m => m?.dispose?.());
        else mat?.dispose?.();
      });
      musicSpeakerOrb = null;
    }

    try { sfxGain?.disconnect(); } catch { /* ignore */ }
    try { masterGain?.disconnect(); } catch { /* ignore */ }

    if (liveSfxChannel) {
      try { liveSfxChannel.close?.(); } catch { /* ignore */ }
      liveSfxChannel = null;
    }

    if (audioCtx) {
      try { audioCtx.close?.(); } catch { /* ignore */ }
    }

    sfxBuffers = {};
    musicPaths = {};
    listeners.clear();
  }

  return {
    init,
    noteGesture,
    update,
    loadSfxFolder: loadSfxSounds,
    loadSfxHttp: loadSfxSoundsHttp,
    pickSfxFolder,
    restoreSfxFolder,
    loadMusicFolder,
    loadMusicHttp,
    pickMusicFolder,
    restoreMusicFolder,
    setMusicSource,
    setShuffle,
    getMusicProgress,
    getAudioLevels,
    getSpectrum,
    seekMusic,
    play: playSfxEvent,
    playAt: playSfxEventAt,
    hasSfxEvent,
    decodeAudio,
    playSynthAt,
    playSynthLoop,
    activeLoopCount: () => activeLoops.size,
    setVolume,
    setMuted,
    setMusicOutput,
    setMusicSpeakerBehavior,
    setMusicEffect,
    getState,
    subscribe,
    dispose,
    prevTrack,
    togglePlayback,
    nextTrack,
    playTrack: playMusicPlaylistEntry,
  };
}
