import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compressBuffer } from './compress.mjs';
import { inspectBuffer } from './inspect.mjs';
import { PRESETS, resolveSettings, getPresetHint } from '../glb-shrink-presets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const GUNS_DIR = path.join(ROOT, 'models', 'guns');
const PORT = Number(process.env.PORT) || 3847;

// Mirrors serve.py's _safe_under_maps: resolve, then require the result to stay under GUNS_DIR.
function resolveGlbPath(relPath) {
  if (typeof relPath !== 'string' || !relPath.toLowerCase().endsWith('.glb')) {
    throw new Error('path must be a .glb file');
  }
  const cleaned = relPath.replace(/^models[\\/]guns[\\/]/, '');
  const abs = path.resolve(GUNS_DIR, cleaned);
  if (abs !== GUNS_DIR && !abs.startsWith(GUNS_DIR + path.sep)) {
    throw new Error('path escapes models/guns/');
  }
  return abs;
}

function archiveDirFor(absPath) {
  return path.join(GUNS_DIR, '.glb-shrink', path.basename(absPath, '.glb'));
}

async function exists(p) {
  return fs.access(p).then(() => true, () => false);
}
async function readIndex(archiveDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(archiveDir, 'index.json'), 'utf-8'));
  } catch {
    return [];
  }
}
async function writeIndex(archiveDir, records) {
  await fs.writeFile(path.join(archiveDir, 'index.json'), JSON.stringify(records, null, 2));
}
function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.get('/api/presets', (_req, res) => {
  res.json(PRESETS.map(({ id, label, hint, quality }) => ({ id, label, hint, quality })));
});

app.post('/api/inspect', async (req, res) => {
  try {
    const abs = resolveGlbPath(req.body.path);
    const buffer = await fs.readFile(abs);
    const stats = await inspectBuffer(buffer);
    res.json({ path: req.body.path, fileSize: buffer.length, ...stats });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.get('/api/history', async (req, res) => {
  try {
    const abs = resolveGlbPath(req.query.path);
    const archiveDir = archiveDirFor(abs);
    const records = await readIndex(archiveDir);
    const hasOriginal = await exists(path.join(archiveDir, 'original.glb'));
    res.json({ hasOriginal, records });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/compress', async (req, res) => {
  try {
    const abs = resolveGlbPath(req.body.path);
    const archiveDir = archiveDirFor(abs);
    const runsDir = path.join(archiveDir, 'runs');
    await fs.mkdir(runsDir, { recursive: true });

    // Always compress from the pristine original, never from whatever's currently live --
    // otherwise re-compressing an already-simplified/WebP'd mesh compounds quality loss.
    const originalPath = path.join(archiveDir, 'original.glb');
    if (!(await exists(originalPath))) await fs.copyFile(abs, originalPath);

    const settings = resolveSettings(req.body.quality);
    const { quality, ...profile } = settings;
    const sourceBuffer = await fs.readFile(originalPath);
    const { buffer, stats } = await compressBuffer(sourceBuffer, profile);

    const preset = PRESETS.find(p => p.quality === Math.round(quality));
    const label = preset ? preset.id : `q${Math.round(quality)}`;
    const runFile = `${timestampId()}-${label}.glb`;
    await fs.writeFile(path.join(runsDir, runFile), buffer);
    await fs.copyFile(path.join(runsDir, runFile), abs);

    const records = await readIndex(archiveDir);
    const record = {
      timestamp: new Date().toISOString(),
      action: 'compress',
      quality,
      profile,
      sourceSize: sourceBuffer.length,
      outputSize: buffer.length,
      sourceTris: stats.sourceTris,
      finalTris: stats.finalTris,
      runFile,
    };
    records.push(record);
    await writeIndex(archiveDir, records);

    res.json({ ok: true, record, hint: getPresetHint(quality) });
  } catch (err) {
    console.error('compress failed:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/restore', async (req, res) => {
  try {
    const abs = resolveGlbPath(req.body.path);
    const archiveDir = archiveDirFor(abs);
    const runFile = req.body.runFile;
    let sourcePath;
    if (runFile === 'original.glb') {
      sourcePath = path.join(archiveDir, 'original.glb');
    } else {
      const records = await readIndex(archiveDir);
      if (!records.some(r => r.runFile === runFile)) throw new Error('unknown run file');
      sourcePath = path.join(archiveDir, 'runs', runFile);
    }
    await fs.copyFile(sourcePath, abs);

    const records = await readIndex(archiveDir);
    records.push({ timestamp: new Date().toISOString(), action: 'restore', restoredFrom: runFile });
    await writeIndex(archiveDir, records);

    const stats = await inspectBuffer(await fs.readFile(abs));
    res.json({ ok: true, stats });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`glb-shrink-server listening on http://127.0.0.1:${PORT}`);
});
