// test-audio-levels.mjs
//
// The band split that drives audio-reactive lighting (bot-viewer-visuals.js accent lights +
// bloom). spectrumBands() is exported pure precisely so it can be checked here without a Web
// Audio graph; the analyser plumbing around it is browser-only.

import assert from 'node:assert/strict';
import { spectrumBands, SPECTRUM_BANDS, spectrumBars } from './environment-audio.js';

const SAMPLE_RATE = 48000;
const FFT = 2048;
const BIN_HZ = SAMPLE_RATE / FFT;          // 23.4375 Hz
const BINS = FFT / 2;                      // frequencyBinCount

// A spectrum with `value` across [fromHz, toHz], using the same outward bin rounding the
// implementation does, so "exactly this band" fills exactly the bins that band averages over.
function spectrumAt(fromHz, toHz, value = 255) {
  const bins = new Uint8Array(BINS);
  const from = Math.max(0, Math.floor(fromHz / BIN_HZ));
  const to = Math.min(BINS - 1, Math.ceil(toHz / BIN_HZ));
  for (let i = from; i <= to; i++) bins[i] = value;
  return bins;
}

const bandsOf = bins => spectrumBands(bins, SAMPLE_RATE, FFT);

// --- 1. energy lands in the band it belongs to -----------------------------------------------
{
  // Bands round outward to whole bins, so neighbours share an edge bin or two -- a bass-only
  // spectrum shows a couple of percent in mid. That is the floor on separation, not a bug.
  const bass = bandsOf(spectrumAt(...SPECTRUM_BANDS.bass));
  assert.equal(bass.bass, 1, 'a full bass band reads 1');
  assert.ok(bass.mid < 0.05, `bass leaks <5% into mid (got ${bass.mid.toFixed(3)})`);
  assert.equal(bass.treble, 0, 'bass does not reach treble at all');

  const mid = bandsOf(spectrumAt(300, 1200));
  assert.ok(mid.mid > 0.4, `mid-band energy reads mid ${mid.mid}`);
  assert.equal(mid.bass, 0, 'nothing below 160 Hz');
  assert.equal(mid.treble, 0, 'nothing above 2 kHz');

  const treble = bandsOf(spectrumAt(3000, 6000));
  assert.ok(treble.treble > 0.4, `treble energy reads treble ${treble.treble}`);
  assert.equal(treble.bass, 0, 'nothing in the bass band');
}

// --- 2. scale: silence is 0, full-scale is 1, half amplitude is half ---------------------------
{
  const silence = bandsOf(new Uint8Array(BINS));
  assert.deepEqual(
    [silence.bass, silence.mid, silence.treble, silence.level], [0, 0, 0, 0],
    'an empty spectrum is silent, not NaN',
  );

  const full = bandsOf(spectrumAt(0, SAMPLE_RATE / 2));
  assert.ok(full.bass > 0.99 && full.mid > 0.99 && full.treble > 0.99, 'full-scale bins read ~1');
  assert.ok(Math.abs(full.level - 1) < 0.01, 'level is the mean of the three bands');

  const half = bandsOf(spectrumAt(0, SAMPLE_RATE / 2, 128));
  assert.ok(Math.abs(half.level - 128 / 255) < 0.01, `half amplitude reads ~0.5, got ${half.level}`);
}

// --- 3. writes into the caller's object (per-frame use must not allocate) ----------------------
{
  const out = { bass: 9, mid: 9, treble: 9, level: 9, beat: 0.5, playing: true };
  const returned = spectrumBands(spectrumAt(...SPECTRUM_BANDS.bass), SAMPLE_RATE, FFT, out);
  assert.equal(returned, out, 'returns the same object it was handed');
  assert.equal(out.bass, 1);
  assert.equal(out.treble, 0);
  assert.equal(out.beat, 0.5, 'unrelated fields on the target are left alone');
  assert.equal(out.playing, true);
}

// --- 4. degenerate inputs are silent rather than NaN -------------------------------------------
{
  for (const [bins, rate, fft] of [
    [new Uint8Array(0), SAMPLE_RATE, FFT],
    [null, SAMPLE_RATE, FFT],
    [spectrumAt(20, 160), 0, FFT],
    [spectrumAt(20, 160), SAMPLE_RATE, 0],
  ]) {
    const out = spectrumBands(bins, rate, fft);
    assert.deepEqual([out.bass, out.mid, out.treble, out.level], [0, 0, 0, 0],
      `degenerate input (${rate}/${fft}) reads silent`);
  }
}

// --- 5. the band table is the documented split and does not overlap ----------------------------
{
  assert.deepEqual(SPECTRUM_BANDS, { bass: [20, 160], mid: [160, 2000], treble: [2000, 8000] });
  assert.equal(SPECTRUM_BANDS.bass[1], SPECTRUM_BANDS.mid[0], 'bands are contiguous');
  assert.equal(SPECTRUM_BANDS.mid[1], SPECTRUM_BANDS.treble[0]);
}

// --- 6. spectrumBars: the log-spaced display bars ---------------------------------------------
{
  const bars = n => spectrumBars(spectrumAt(0, SAMPLE_RATE / 2), SAMPLE_RATE, FFT, new Float32Array(n));

  // Flat full-scale input lights every bar -- no bar may be starved by rounding, which is the
  // failure mode of naive log spacing (narrow low bars can round to an empty bin range).
  for (const n of [8, 16, 28, 64]) {
    const out = bars(n);
    assert.equal(out.length, n);
    for (let i = 0; i < n; i++) {
      assert.ok(out[i] > 0.9, `bar ${i}/${n} reads ${out[i].toFixed(3)} on a full-scale spectrum`);
    }
  }

  // Log spacing: a fixed low band occupies more bars than the same-width band up high.
  const low = spectrumBars(spectrumAt(40, 200), SAMPLE_RATE, FFT, new Float32Array(28));
  const high = spectrumBars(spectrumAt(8000, 8160), SAMPLE_RATE, FFT, new Float32Array(28));
  const litCount = arr => arr.reduce((n, v) => n + (v > 0.2 ? 1 : 0), 0);
  assert.ok(litCount(low) > litCount(high),
    `160 Hz of bass spans more bars (${litCount(low)}) than 160 Hz of treble (${litCount(high)})`);

  // Energy shows up at the correct end of the display.
  const bassOnly = spectrumBars(spectrumAt(40, 120), SAMPLE_RATE, FFT, new Float32Array(16));
  assert.ok(bassOnly[0] > 0.5, 'bass lights the left of the display');
  assert.equal(bassOnly[15], 0, 'and not the right');

  const trebleOnly = spectrumBars(spectrumAt(9000, 12000), SAMPLE_RATE, FFT, new Float32Array(16));
  assert.ok(trebleOnly[15] > 0.5, 'treble lights the right of the display');
  assert.equal(trebleOnly[0], 0, 'and not the left');

  // Degenerate inputs zero the bars instead of writing NaN into a canvas height.
  for (const [bins, rate, fft] of [[null, SAMPLE_RATE, FFT], [spectrumAt(40, 120), 0, FFT]]) {
    const out = spectrumBars(bins, rate, fft, new Float32Array([0.5, 0.5, 0.5]));
    assert.deepEqual([...out], [0, 0, 0]);
  }
  assert.deepEqual([...spectrumBars(spectrumAt(40, 120), SAMPLE_RATE, FFT, new Float32Array(0))], []);
}

console.log('test-audio-levels: all assertions passed');
