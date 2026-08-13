// A small local relay so voice-line-studio.html can generate real ElevenLabs audio with a button
// click instead of a copy-pasted terminal command. Same shape as glb-shrink-server/ (a browser tool
// calling a local server for the one piece of work the browser cannot safely do itself) -- built on
// plain node:http rather than express/cors specifically to avoid a fresh npm install on this
// Drive-hosted repo, where large installs are unreliable (see CLAUDE.md).
//
// The ElevenLabs key never reaches the browser: this process reads it the same way bake-voices.mjs
// does (ELEVENLABS_API_KEY or the gitignored .eleven-key) and holds it server-side for the life of
// the process. /generate is a real, paid API call every time -- there is no dry-run mode, because
// the whole point is generating audio the studio can actually play back. /save just writes
// sound-params.json to disk -- free, and the only way the studio's in-memory edits survive a
// reload, since a static-served page has no other way to write a local file.
//
//   node voice-bake-server.mjs [port]   # defaults to 8097
//
// Then open voice-line-studio.html (served by serve.py) with this running alongside it.

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { applyParamOverrides } from './sound-params.js';
import {
  elevenKey, elevenCatalog, bakeOneEleven, bakeDefaultEleven,
  restorePreviousEleven, restorePreviousDefaultEleven, writeManifest,
} from './bake-voices.mjs';
import { lineVariants } from './bot-voice.js';

async function applyOverrideDoc() {
  if (!existsSync('./sound-params.json')) return;
  try {
    const res = applyParamOverrides(JSON.parse(await readFile('./sound-params.json', 'utf8')));
    for (const w of res.warnings || []) console.warn(`sound-params.json: ${w}`);
  } catch (err) {
    console.warn(`sound-params.json ignored: ${err.message}`);
  }
}

// Fetched fresh per request rather than cached: a cached catalog would reject a voice added on the
// account after this process started until a manual restart, and this is a free GET, not the paid
// call -- there is no real cost to paying it every time.
async function catalog(key) {
  return elevenCatalog(key);
}

// The studio calls this on every edit (debounced) and, unconditionally, right before /generate --
// the browser tool holds authored text/tone in memory only, so without this, a page refresh (or a
// crash) loses everything that was not manually exported, and generating a brand-new event before
// ever exporting bakes a real, paid file the manifest writer cannot see (it reads lineIds() from
// whatever is on disk, not from the browser's live memory).
async function save(doc) {
  if (!doc || typeof doc !== 'object') throw new Error('need { doc }');
  await writeFile('./sound-params.json', JSON.stringify(doc, null, 2));
  return { path: './sound-params.json' };
}

const PORT = Number(process.argv[2] || process.env.PORT) || 8097;

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    // Local tool talking to a page served on a different port -- CORS has to be explicit.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

// `text` comes straight from the request, not a lookup here against sound-params.json on disk --
// the studio holds its edits in memory until you explicitly save, and this server is a separate
// process with no visibility into that in-browser state. Sending the exact text the tool is
// currently showing is what guarantees the generated audio matches what you see, not whatever was
// last saved to disk.
async function generate({ voiceId, lineId, variantIndex, text }) {
  if (!voiceId || !lineId || !Number.isInteger(variantIndex) || !text) {
    throw new Error('need { voiceId, lineId, variantIndex, text }');
  }
  const slug = String(voiceId).replace(/^eleven\//, '');
  const key = await elevenKey();
  const cat = await catalog(key);
  const meta = cat.get(slug);
  if (!meta) throw new Error(`"${slug}" is not a voice on this ElevenLabs account`);
  const file = await bakeOneEleven({ slug, elevenVoiceId: meta.id, key, lineId, variantIndex, text });
  // The manifest filters baked files by lineIds(), which reads SOUND_PARAMS.voiceLines -- reload
  // the override doc first so a brand-new event (added but not yet saved to sound-params.json)
  // still gets recognised as a real line rather than silently dropped from the manifest.
  await applyOverrideDoc();
  await writeManifest();
  return { file, text };
}

// Swaps the live take and its single-slot backup back to how they were before the last generate.
// A second call swaps again, so this is also "redo" -- no separate endpoint needed for that.
async function restore({ voiceId, lineId, variantIndex }) {
  if (!voiceId || !lineId || !Number.isInteger(variantIndex)) {
    throw new Error('need { voiceId, lineId, variantIndex }');
  }
  const slug = String(voiceId).replace(/^eleven\//, '');
  const file = await restorePreviousEleven({ slug, lineId, variantIndex });
  await writeManifest();
  return { file };
}

// Bakes the PROTECTED default slot -- always the current shared-lexicon text, never whatever a
// voice's own variant 0 currently says. `text` is resolved server-side here, not sent by the
// studio like /generate's is: the whole point of this slot is "the one true default", not
// whatever happens to be in a text box, so it reads the shared lexicon itself
// (lineVariants(lineId)[0]) rather than trusting a client-supplied value that could drift from it.
async function generateDefault({ voiceId, lineId }) {
  if (!voiceId || !lineId) throw new Error('need { voiceId, lineId }');
  const slug = String(voiceId).replace(/^eleven\//, '');
  const key = await elevenKey();
  const cat = await catalog(key);
  const meta = cat.get(slug);
  if (!meta) throw new Error(`"${slug}" is not a voice on this ElevenLabs account`);
  await applyOverrideDoc();
  const text = lineVariants(lineId)[0]?.text;
  if (!text) throw new Error(`no shared default text for line "${lineId}"`);
  const file = await bakeDefaultEleven({ slug, elevenVoiceId: meta.id, key, lineId, text });
  await writeManifest();
  return { file, text };
}

async function restoreDefault({ voiceId, lineId }) {
  if (!voiceId || !lineId) throw new Error('need { voiceId, lineId }');
  const slug = String(voiceId).replace(/^eleven\//, '');
  const file = await restorePreviousDefaultEleven({ slug, lineId });
  await writeManifest();
  return { file };
}

const ROUTES = {
  '/generate': generate, '/save': ({ doc }) => save(doc), '/restore': restore,
  '/generate-default': generateDefault, '/restore-default': restoreDefault,
};

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { json(res, 204, {}); return; }
  const handler = req.method === 'POST' ? ROUTES[req.url] : null;
  if (!handler) { json(res, 404, { error: `POST one of: ${Object.keys(ROUTES).join(', ')}` }); return; }
  try {
    const body = await readBody(req);
    const result = await handler(body);
    json(res, 200, { ok: true, ...result });
  } catch (err) {
    json(res, 500, { ok: false, error: err.message || String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`voice-bake-server listening on :${PORT}`);
  console.log('POST /generate          { voiceId: "eleven/harry", lineId: "contact", variantIndex: 1, text }');
  console.log('POST /save              { doc: <exportParams() result> }');
  console.log('POST /restore           { voiceId: "eleven/harry", lineId: "contact", variantIndex: 1 }');
  console.log('POST /generate-default  { voiceId: "eleven/harry", lineId: "contact" }');
  console.log('POST /restore-default   { voiceId: "eleven/harry", lineId: "contact" }');
});
