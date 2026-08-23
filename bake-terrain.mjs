// bake-terrain.mjs — turn a Terrain Generator v5 project into ground the flight sim can fly over.
//
//   node bake-terrain.mjs maps/alpine-project.json
//   node bake-terrain.mjs maps/alpine-project.json --out alpine --size 16384 --height-scale 1.4
//   node bake-terrain.mjs maps/alpine-project.json --stream   # infinite, but noise layers only
//   node bake-terrain.mjs --analytic --out waves               # bake the sim's own wave field, for tests
//
// Writes terrain-bakes/<name>.json (metadata) + terrain-bakes/<name>.bin (Float32 heights), or with
// --stream the metadata plus <name>.project.json and no heights at all.
//
// The two modes are a real choice, not a fast path and a slow one:
//   bake    finite square, but carries erosion, hydrology and paint
//   stream  infinite, but noise layers only — the omitted stages are grid simulations
// See the "Minecraft" note in docs/subsystems/flight.md for why that split exists at all.
//
// It runs `generateFullGridV5` — the EDITOR's pipeline — not `terrain-source-v5.js`. That matters:
// the runtime source refuses any project with paint or imports and silently omits erosion and
// hydrology, because those stages are not point functions and a streaming source can only call a
// point function. Baking has no such limit, which is the whole reason to bake. What you saw in the
// generator is what lands in the sim.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeProject, describeProject, hashProject, classifyProject } from './terrain-project-v5.js';
import { generateFullGridV5 } from './terrain-generator-js.js';
import { evaluateStackGrid } from './terrain-stack.js';
import { base64ToBytes } from './terrain-paint.js';
import { analyticHeightAt } from './flight-terrain.js';
import { BAKE_VERSION, bakeHeights, bakeRange, bakeToBytes, bakeStep } from './flight-terrain-baked.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'terrain-bakes');

function parseArgs(argv) {
  const out = { project: null, name: null, res: 1025, size: null, heightScale: 1, seaShift: true, seaLevel: null, analytic: false, stream: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--analytic') out.analytic = true;
    else if (a === '--stream') out.stream = true;
    else if (a === '--no-sea-shift') out.seaShift = false;
    else if (a === '--out') out.name = argv[++i];
    else if (a === '--res') out.res = Number(argv[++i]);
    else if (a === '--size') out.size = Number(argv[++i]);
    else if (a === '--height-scale') out.heightScale = Number(argv[++i]);
    else if (a === '--sea-level') out.seaLevel = Number(argv[++i]);
    else if (a.startsWith('--')) throw new Error(`unknown flag ${a}`);
    else out.project = a;
  }
  if (!out.project && !out.analytic) throw new Error('give a *-project.json path, or --analytic');
  if (!Number.isInteger(out.res) || out.res < 2) throw new Error('--res must be an integer >= 2');
  return out;
}

// paint/import grids ride in the project as base64 float32 at their own authoring resolution
function decodeFloat32(b64) { return new Float32Array(base64ToBytes(b64).buffer); }

// Exported so test-flight-terrain-baked.mjs can run the real pipeline on a synthetic project
// instead of a copy of it. `raw` is the parsed *-project.json.
export function bakeProjectObject(raw, args = {}) {
  const opts = { res: 1025, size: null, heightScale: 1, seaShift: true, seaLevel: null, project: '(inline)', ...args };
  return bakeProject(opts, raw);
}

function bakeProject(args, rawIn = null) {
  const raw = rawIn ?? JSON.parse(readFileSync(args.project, 'utf8'));
  const { project } = normalizeProject(raw);
  const cfg = project.cfg;

  // Paint was authored on one specific grid and is a per-cell delta, so it only lines up at that
  // resolution. Follow it rather than resampling someone's hand-carved valley.
  let res = args.res;
  if (project.paint && project.paint.resolution !== res) {
    console.warn(`note: project has paint at ${project.paint.resolution}, baking at that resolution instead of ${res}`);
    res = project.paint.resolution;
  }

  const imports = {};
  for (const [id, imp] of Object.entries(project.imports || {})) {
    imports[id] = { resolution: imp.resolution, data: decodeFloat32(imp.data) };
  }
  const paintHeight = project.paint?.heightDelta ? decodeFloat32(project.paint.heightDelta) : null;
  const biomeOverride = project.paint?.biomeOverride ? base64ToBytes(project.paint.biomeOverride) : null;

  const stackEval = (classicHeight) => evaluateStackGrid(project.stack, {
    resolution: res, worldX: cfg.world_x, worldZ: cfg.world_z, seed: cfg.seed, classicHeight, imports,
  });

  const t0 = Date.now();
  const grid = generateFullGridV5(cfg, res, stackEval, { paintHeight, biomeOverride, unbounded: true });
  const ms = Date.now() - t0;

  if (cfg.world_x !== cfg.world_z) {
    console.warn(`note: project world is ${cfg.world_x} x ${cfg.world_z} m; baking as square using world_x`);
  }
  const size = args.size ?? cfg.world_x;
  const sea = args.seaLevel ?? (args.seaShift ? cfg.sea_level : 0);

  // The sim's water plane is nailed to y = 0, so the project's sea level becomes the new zero.
  // Without this a project that called sea level 62 m would put the entire map underwater.
  const heights = Float32Array.from(grid.height, (h) => (h - sea) * args.heightScale);

  return {
    heights, res, size,
    meta: {
      source: 'v5-project',
      project: project.name || basename(args.project),
      projectFile: args.project,
      // The .bin is a build artifact. Recording the project's content hash is what makes it one:
      // it can be rebuilt, and a bake that no longer matches its project can be spotted.
      projectHash: hashProject(project),
      algorithmVersion: project.algorithmVersion,
      seaLevel: sea,
      heightScale: args.heightScale,
      worldX: cfg.world_x,
      stretched: size !== cfg.world_x,
      describe: describeProject(project).summary ?? undefined,
      buildMs: ms,
    },
  };
}

function bakeAnalytic(args) {
  const res = args.res;
  const size = args.size ?? 16384;
  const originX = -size / 2, originZ = -size / 2;
  const heights = bakeHeights((x, z) => analyticHeightAt(x, z) * args.heightScale, { res, size, originX, originZ });
  return { heights, res, size, meta: { source: 'analytic', heightScale: args.heightScale } };
}

// --stream writes no heights at all: the project itself is the artifact, and the viewer generates
// ground around the plane forever. Erosion, hydrology and paint cannot come along (they are grid
// simulations, not point functions), so refuse rather than silently ship a different terrain than
// the one the author approved.
function writeStream(args) {
  const raw = JSON.parse(readFileSync(args.project, 'utf8'));
  const { project } = normalizeProject(raw);
  const cls = classifyProject(project);
  if (!cls.runtimeSupported) {
    console.error(`cannot stream this project: ${cls.reasons.join('; ')}`);
    console.error('bake it instead (drop --stream) — a bake keeps every stage the editor showed.');
    process.exitCode = 1;
    return;
  }
  const name = (args.name || project.name || basename(args.project)).replace(/[^A-Za-z0-9_-]+/g, '-');
  const sea = args.seaLevel ?? (args.seaShift ? project.cfg.sea_level : 0);
  const meta = {
    version: BAKE_VERSION,
    name,
    mode: 'stream',
    source: 'v5-project',
    project: project.name || name,
    projectFile: args.project,
    projectHash: hashProject(project),
    algorithmVersion: project.algorithmVersion,
    seaLevel: sea,
    heightScale: args.heightScale,
    omitted: cls.omitted,
    bakedAt: new Date().toISOString(),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${name}.json`), `${JSON.stringify(meta, null, 2)}\n`);
  writeFileSync(join(OUT_DIR, `${name}.project.json`), `${JSON.stringify(project)}\n`);
  console.log(`streamable terrain-bakes/${name}: no heights written, the viewer generates them`);
  console.log(`  omitted at runtime: ${cls.omitted.join('; ')}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.stream) {
    if (args.analytic) throw new Error('--stream needs a project; the wave field is already infinite');
    writeStream(args);
    return;
  }
  const built = args.analytic ? bakeAnalytic(args) : bakeProject(args);
  const { heights, res, size } = built;
  const name = (args.name || built.meta.project || 'terrain').replace(/[^A-Za-z0-9_-]+/g, '-');
  const range = bakeRange(heights);

  const meta = {
    version: BAKE_VERSION,
    name,
    res,
    size,
    originX: -size / 2,
    originZ: -size / 2,
    step: bakeStep(size, res),
    min: range.min,
    max: range.max,
    bakedAt: new Date().toISOString(),
    ...built.meta,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, `${name}.json`), `${JSON.stringify(meta, null, 2)}\n`);
  writeFileSync(join(OUT_DIR, `${name}.bin`), Buffer.from(bakeToBytes(heights)));

  const mb = (heights.byteLength / 1048576).toFixed(1);
  console.log(`baked terrain-bakes/${name}: ${res}x${res} posts, ${size} m across, ${meta.step.toFixed(2)} m spacing, ${mb} MB`);
  console.log(`  heights ${range.min.toFixed(1)} .. ${range.max.toFixed(1)} m (water plane at 0)`);
}

// Only when run as a command; importing this for bakeProjectObject must not write files.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
