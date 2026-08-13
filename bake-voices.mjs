// Bakes the bot voice lexicon to audio files, one per line, via a pluggable TTS backend.
// Takes are baked DRY: the radio chain and the robot vocoder are runtime inserts, so the same
// take can play over comms or out loud, as a human or as a machine. Never bake a channel in.
//
//   node bake-voices.mjs --list                          what is available and what is baked
//   node bake-voices.mjs --engine=eleven --voice=harry
//   node bake-voices.mjs --engine=eleven --voice=all     the curated combat set
//   node bake-voices.mjs --engine=kokoro --voice=all
//   node bake-voices.mjs --engine=kokoro --voice=every   all 28, ~10 min
//
// ElevenLabs key comes from ELEVENLABS_API_KEY or a gitignored .eleven-key at the repo root.
// kokoro-js is resolved from PCW_TTS_HOME because npm cannot install into a Google Drive folder
// (rename/rmdir fail with EPERM/EBADF), and this repo lives on one.
import { writeFile, mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { applyParamOverrides } from './sound-params.js';
import { lineIds, lineText, lineVariants, voiceLexiconVariants } from './bot-voice.js';

// Studio-authored lines live in sound-params.json, not in the code, so without this the bake sees
// only the built-in lexicon and silently skips exactly the line you added it for. Node's fetch
// cannot read a file: URL, which is why loadSoundParams() is not usable here.
async function applyOverrideDoc() {
  if (!existsSync('./sound-params.json')) return;
  try {
    const res = applyParamOverrides(JSON.parse(await readFile('./sound-params.json', 'utf8')));
    for (const w of res.warnings || []) console.warn(`sound-params.json: ${w}`);
  } catch (err) {
    console.warn(`sound-params.json ignored: ${err.message}`);
  }
}
await applyOverrideDoc();

const OUT_ROOT = './sfx/voice';
const TTS_HOME = process.env.PCW_TTS_HOME || 'C:/Users/msankofa/AppData/Local/pcw-tts';

// ---- ElevenLabs -------------------------------------------------------------------------------

// Low stability buys urgency; combat barks are the one place you want delivery to vary.
const ELEVEN_SETTINGS = { stability: 0.4, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true };
// v3, not v2: the whole point of an intensity variant is inflection (whispered vs. shouted), and
// v2's stability/style knobs only buy subtle variation on identical wording. v3 adds inline
// delivery tags -- [whispers], [shouts] -- inserted directly into a variant's text. Confirmed
// against ElevenLabs' own docs (elevenlabs.io/docs, help.elevenlabs.io) before this changed: model
// id is exactly `eleven_v3`, reachable through the same /v1/text-to-speech/{voice_id} endpoint this
// file already calls, so no request-shape change beyond the model id itself.
const ELEVEN_MODEL = 'eleven_v3';
const ELEVEN_FORMAT = 'mp3_44100_128';
// Voices worth having in a firefight, out of whatever the account carries.
const ELEVEN_COMBAT = ['harry', 'adam', 'daniel', 'river', 'callum', 'bill', 'brian', 'charlie', 'sarah', 'alice'];

export async function elevenKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  if (existsSync('./.eleven-key')) return (await readFile('./.eleven-key', 'utf8')).trim();
  throw new Error('no API key: set ELEVENLABS_API_KEY or create .eleven-key (gitignored)');
}

// Read the account rather than hardcoding ids, so a voice added in the dashboard just works.
export async function elevenCatalog(key) {
  const res = await fetch('https://api.elevenlabs.io/v2/voices?page_size=100', { headers: { 'xi-api-key': key } });
  if (!res.ok) throw new Error(`voice list: http ${res.status}`);
  const out = new Map();
  for (const v of (await res.json()).voices || []) {
    const slug = v.name.split(/[\s-]/)[0].toLowerCase();
    const l = v.labels || {};
    out.set(slug, { id: v.voice_id, note: [l.gender, l.age, l.accent, l.descriptive].filter(Boolean).join(', ') });
  }
  return out;
}

// Index 0 of a line's variants always writes to the plain `${lineId}.ext` filename that has
// existed since before variants did, so a set baked before this feature shipped stays valid with
// zero re-baking. Index i > 0 writes to `${lineId}__vi.ext`. Order must never be reshuffled after
// baking -- bot-voice-bank.js resolves a variant by this same index, and a deleted or reordered
// variant desyncs an already-baked file from the text it no longer matches (see the plan doc's
// Appendix B append-only note).
export function variantFilename(lineId, index) {
  return index > 0 ? `${lineId}__v${index}` : lineId;
}

function prevFile(dir, filename) { return `${dir}/.prev/${filename}.mp3`; }

// `${lineId}__default` -- the shared/default lexicon's take, protected in its own filename FOREVER
// separate from variant 0. Before this existed, index 0 of a line's variants shared the exact same
// plain `${lineId}.ext` filename the original shared-lexicon bake had already written, so
// customizing and generating variant 0 for a voice silently overwrote the only recording of what
// that voice's DEFAULT line sounded like -- there was no way back to it. Never touched by variant
// baking; only bakeDefaultEleven writes here.
export function defaultFilename(lineId) { return `${lineId}__default`; }

// Fetch + write + single-slot backup, given an EXPLICIT filename -- shared by bakeOneEleven
// (variant slots) and bakeDefaultEleven (the protected default slot) so there is exactly one
// implementation of "call ElevenLabs, back up whatever was there, write the result, and put the
// backup back if the call failed", not two that could drift.
async function bakeToFile({ dir, filename, elevenVoiceId, key, text, label }) {
  await mkdir(dir, { recursive: true });
  await mkdir(`${dir}/.prev`, { recursive: true });
  const file = `${dir}/${filename}.mp3`;
  if (existsSync(file)) await rename(file, prevFile(dir, filename));

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${elevenVoiceId}?output_format=${ELEVEN_FORMAT}`,
    { method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: ELEVEN_MODEL, voice_settings: ELEVEN_SETTINGS }) });
  if (!res.ok) {
    // The paid call failed after the previous take was already moved aside -- put it straight back
    // rather than leaving the slot looking un-baked when a perfectly good take still exists.
    if (existsSync(prevFile(dir, filename))) await rename(prevFile(dir, filename), file);
    throw new Error(`${label}: http ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

// One API call, one file write, to a variant slot. Pulled out of bakeEleven's loop so a single
// variant can be (re-)generated on demand -- the line-authoring tool's GENERATE button calls this
// exact function through voice-bake-server.mjs, rather than re-baking a voice's entire lexicon just
// to pick up one new or edited line.
export async function bakeOneEleven({ slug, elevenVoiceId, key, lineId, variantIndex, text }) {
  return bakeToFile({
    dir: `${OUT_ROOT}/eleven/${slug}`, filename: variantFilename(lineId, variantIndex),
    elevenVoiceId, key, text, label: `${lineId} variant ${variantIndex}`,
  });
}

// One API call, one file write, to the protected default slot -- always the CURRENT shared-lexicon
// text (lineVariants(lineId)[0], not voiceLexiconVariants, which would resolve to a customization
// if one exists). Real, paid, on demand: there is no way to conjure "what this voice's default
// sounded like" for free once a variant 0 has already overwritten the old shared plain file, so
// this simply establishes a fresh, correct default going forward rather than trying to recover one.
export async function bakeDefaultEleven({ slug, elevenVoiceId, key, lineId, text }) {
  return bakeToFile({
    dir: `${OUT_ROOT}/eleven/${slug}`, filename: defaultFilename(lineId),
    elevenVoiceId, key, text, label: `${lineId} default`,
  });
}

// Swaps a live file and its `.prev` backup -- "undo" and "redo" are the same operation, since a
// second swap puts things back exactly as they were. Throws if there is nothing to swap, so the
// caller (the relay server) can tell the studio "there is no previous take" rather than silently
// doing nothing. Shared by variant slots and the default slot -- both use the same `.prev`
// convention, just a different filename.
async function restorePrevious({ dir, filename }) {
  const file = `${dir}/${filename}.mp3`;
  const prev = prevFile(dir, filename);
  if (!existsSync(prev)) throw new Error(`no previous take for ${dir}/${filename}`);
  const tmp = `${dir}/.prev/.swap-${filename}.mp3`;
  if (existsSync(file)) await rename(file, tmp);
  await rename(prev, file);
  if (existsSync(tmp)) await rename(tmp, prev);
  return file;
}

export async function restorePreviousEleven({ slug, lineId, variantIndex }) {
  return restorePrevious({ dir: `${OUT_ROOT}/eleven/${slug}`, filename: variantFilename(lineId, variantIndex) });
}

export async function restorePreviousDefaultEleven({ slug, lineId }) {
  return restorePrevious({ dir: `${OUT_ROOT}/eleven/${slug}`, filename: defaultFilename(lineId) });
}

async function bakeEleven(slug, meta, key) {
  const voiceId = `eleven/${slug}`;
  let takes = 0;
  for (const lineId of lineIds()) {
    const variants = voiceLexiconVariants(voiceId, lineId);
    for (let i = 0; i < variants.length; i++) {
      await bakeOneEleven({ slug, elevenVoiceId: meta.id, key, lineId, variantIndex: i, text: variants[i].text });
      takes++;
    }
  }
  console.log(`  eleven/${slug.padEnd(10)} ${takes} takes across ${lineIds().length} lines  (${meta.note})`);
}

// ---- Kokoro -----------------------------------------------------------------------------------

async function loadKokoro() {
  try { return await import('kokoro-js'); } catch { /* not installed beside the repo */ }
  const local = `${TTS_HOME}/node_modules/kokoro-js/dist/kokoro.js`;
  if (!existsSync(local)) {
    throw new Error(`kokoro-js not found. Install it OFF Google Drive:\n`
      + `  mkdir -p "${TTS_HOME}" && cd "${TTS_HOME}"\n`
      + `  echo '{"type":"module"}' > package.json && npm install kokoro-js`);
  }
  return await import(pathToFileURL(local).href);
}

let kokoroTTS = null;
async function kokoroEngine() {
  if (kokoroTTS) return kokoroTTS;
  const m = await loadKokoro();
  console.log('loading Kokoro-82M (q8)...');
  kokoroTTS = await m.KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
  return kokoroTTS;
}

// Kokoro is out of scope for per-voice lexicons (see the plan doc's Appendix B) -- it always bakes
// the shared/default lexicon's own variants (lineVariants, not voiceLexiconVariants), the same
// wording-diversity axis every engine gets, just never a Kokoro-specific rewrite.
async function bakeKokoro(voice) {
  const tts = await kokoroEngine();
  const dir = `${OUT_ROOT}/kokoro/${voice}`;
  await mkdir(dir, { recursive: true });
  let takes = 0;
  for (const lineId of lineIds()) {
    const variants = lineVariants(lineId);
    for (let i = 0; i < variants.length; i++) {
      const audio = await tts.generate(variants[i].text, { voice });
      await writeFile(`${dir}/${variantFilename(lineId, i)}.wav`, Buffer.from(await audio.toWav()));
      takes++;
    }
  }
  const grade = tts.voices[voice]?.overallGrade || '?';
  console.log(`  kokoro/${voice.padEnd(10)} ${takes} takes across ${lineIds().length} lines  (grade ${grade})`);
}

// ---- manifest ---------------------------------------------------------------------------------

// The studio reads this instead of probing a hardcoded list, so baking a new voice makes it appear
// with no code edit anywhere. Exported so voice-bake-server.mjs can refresh it after an on-demand
// generate, without the browser tool needing a separate "now run --manifest" step.
export async function writeManifest() {
  const sets = [];
  for (const engine of ['eleven', 'kokoro']) {
    const root = `${OUT_ROOT}/${engine}`;
    if (!existsSync(root)) continue;
    for (const voice of await readdir(root)) {
      const dir = `${root}/${voice}`;
      const files = (await readdir(dir)).filter(f => /\.(mp3|wav)$/.test(f));
      if (!files.length) continue;
      // Which files have a recoverable previous take, so the studio can show "undo" only where
      // there is actually something to undo to, rather than on every baked variant unconditionally.
      const prevDir = `${dir}/.prev`;
      const prev = existsSync(prevDir)
        ? (await readdir(prevDir)).filter(f => /\.(mp3|wav)$/.test(f)).map(f => f.replace(/\.[^.]+$/, ''))
        : [];
      sets.push({ set: `${engine}/${voice}`, engine, voice,
        ext: files[0].split('.').pop(),
        // A variant file is named `${lineId}__vN`, the protected default `${lineId}__default`;
        // strip either suffix before checking membership, or every one of them looks like an
        // unknown line and gets silently dropped.
        lines: files.map(f => f.replace(/\.[^.]+$/, '')).filter(id => lineIds().includes(id.replace(/__v\d+$|__default$/, ''))),
        prev });
    }
  }
  await writeFile(`${OUT_ROOT}/manifest.json`,
    JSON.stringify({ generated: new Date().toISOString(), lineIds: lineIds(), sets }, null, 2));
  console.log(`manifest: ${sets.length} sets, ${sets.reduce((n, s) => n + s.lines.length, 0)} takes`);
}

// ---- cli --------------------------------------------------------------------------------------
// Guarded so importing this module (voice-bake-server.mjs reuses elevenKey/elevenCatalog/
// bakeOneEleven/writeManifest) never triggers a bake as a side effect -- process.argv in a server
// process is the server's own flags, not bake ones, and this block used to run unconditionally on
// any import, defaulting to --engine=eleven --voice=all: a full paid bake of every combat voice
// the instant something else imported this file.

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const engine = arg('engine', 'eleven');
const want = arg('voice', 'all');

if (args.includes('--list')) {
  console.log(`${lineIds().length} lines, ${lineIds().reduce((n, id) => n + lineText(id).length, 0)} characters per set\n`);
  try {
    const cat = await elevenCatalog(await elevenKey());
    console.log('eleven (account):');
    for (const [slug, m] of cat) console.log(`  ${slug.padEnd(10)} ${ELEVEN_COMBAT.includes(slug) ? '[combat set] ' : ''}${m.note}`);
  } catch (err) { console.log(`eleven: unavailable (${err.message})`); }
  try {
    const tts = await kokoroEngine();
    console.log('\nkokoro:');
    for (const [n, v] of Object.entries(tts.voices)) console.log(`  ${n.padEnd(12)} ${v.gender} grade ${v.overallGrade}`);
  } catch (err) { console.log(`\nkokoro: unavailable (${err.message})`); }
} else if (args.includes('--manifest')) {
  await writeManifest();
} else if (engine === 'eleven') {
  const key = await elevenKey();
  const cat = await elevenCatalog(key);
  const list = want === 'every' ? [...cat.keys()]
    : want === 'all' ? ELEVEN_COMBAT.filter(v => cat.has(v))
    : [want];
  for (const v of list) {
    if (!cat.has(v)) { console.error(`  skip ${v}: not on the account`); continue; }
    await bakeEleven(v, cat.get(v), key);
  }
  await writeManifest();
} else if (engine === 'kokoro') {
  const tts = await kokoroEngine();
  const all = Object.keys(tts.voices);
  // Kokoro publishes a quality grade per voice; anything D or worse is not worth a slot.
  const good = all.filter(v => /^[ABC]/.test(tts.voices[v].overallGrade || ''));
  const list = want === 'every' ? all : want === 'all' ? good : [want];
  for (const v of list) {
    if (!all.includes(v)) { console.error(`  skip ${v}: unknown voice`); continue; }
    await bakeKokoro(v);
  }
  await writeManifest();
} else {
  console.error(`unknown engine ${engine}`);
  process.exit(1);
}

}
