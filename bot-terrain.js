// bot-terrain.js — pure, seeded height field + mesh arrays for the bot viewer's uneven ground.
// No THREE import: Node-testable (test-bot-terrain.mjs). The viewer feeds the arrays into a
// BufferGeometry that joins mapRoot, so the existing BVH map collider handles slopes for free.

export const BOT_TERRAIN_DEFAULTS = {
  enabled: false,
  seed: 1,
  hillAmp: 0.9,      // m, peak-to-flat height of the broad hill/depression band
  hillScale: 16,     // m, wavelength of the broad band
  hillOctaves: 3,    // fBm octaves layered onto the broad band
  landform: 'rolling',   // rolling | ridged | billowy -- the shape of the broad band
  warpAmp: 0,        // m the sample point is pushed sideways before the hills are read (0 = off)
  warpScale: 40,     // m, wavelength of that push
  terraceSteps: 0,   // benches carved into the hills (0 = off) -- mesas and defined edges
  terraceSharpness: 0.6, // 0 = untouched ramp, 1 = hard tread
  rippleAmp: 0.12,   // m, mid-frequency surface band
  rippleScale: 4.0,  // m, ripple wavelength
  rippleMode: 'isotropic', // isotropic | dunes
  erosionAmp: 0,     // m of incision a full-grown drainage channel cuts (0 = off; bake mode only)
  erosionArea: 300,  // grid cells a channel must drain before it reaches that full depth
  erosionSmooth: 0.5, // 0..1, how far a channel widens from a V-notch into a walkable valley
  erosionFillPits: true, // route drainage over filled depressions, so gullies connect into routes
  featureCount: 0,   // placed landforms stamped into the ground (0 = off; bake mode only)
  featureMix: 'mixed', // mixed | plateau | ravine | escarpment
  featureHeight: 2.5, // m, the rise or depth a placed feature is built around
  connectPasses: true, // carve a pass into ground the landforms fenced off (bake mode only)
  passWidth: 2.4,    // m, width of a carved pass
  noiseAmp: 0.05,    // m, fine per-step grain
  noiseScale: 1.2,   // m, grain wavelength
  meshCell: 0.4,     // m, terrain triangle pitch
  maxSegments: 220,  // per-axis cap so a huge map can't blow up the collider triangle budget
  maxSlope: 0.85,    // rise/run above which nav cells stop being walkable (~40 deg)
  flattenFalloff: 2.0, // m the blend from a flatten pad's rim back out to raw terrain
  shadeRock: 0.25,     // vertex-colour lift on steep faces (0 = flat-coloured ground)
  shadeChannel: 0.35,  // vertex-colour darkening in drainage channels
  shadeAltitude: 0.25, // vertex-colour spread between the lowest and highest ground
  fieldCell: 0.5,      // m, baked height-grid pitch (bake mode only -- see createTerrainField)
  maxFieldSegments: 1024, // per-axis cap on the baked grid, so a huge map can't eat memory
};

const TAU = Math.PI * 2;
const PAD_BUCKET = 8;   // m, flatten-pad index cell (see createTerrainField)
const BAKE_MARGIN = 4;  // m the baked grid extends past the layout, covering the floor mesh's own pad
const PAD_BLEND_BAND = 0.2;  // how close to the strongest pad's weight a rival must be to blend in
// Per-sample scratch for the pad blend: heightAt is the hottest function here and must not allocate.
const padW = new Float64Array(24);
const padY = new Float64Array(24);

function hash2(ix, iz, seed) {
  let h = (Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ Math.imul(seed | 0, 2654435761)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Smoothstep-interpolated value noise in 0..1.
function valueNoise(x, z, seed) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz, seed), b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed), d = hash2(ix + 1, iz + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

// Signed fBm in roughly -1..1: hills above zero, depressions below.
function fbm(x, z, seed, octaves) {
  let sum = 0, norm = 0, amp = 1, freq = 1;
  for (let o = 0; o < octaves; o++) {
    sum += (valueNoise(x * freq, z * freq, seed + o * 101) * 2 - 1) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}

// Shape of the broad band, each mapping signed fBm back into -1..1 so the amplitude a caller asked
// for is the amplitude it gets, and every landform still has depressions as well as hills.
export const LANDFORMS = {
  rolling: (n) => n,                    // symmetric dunes and hollows -- the original band
  ridged: (n) => 1 - 2 * Math.abs(n),   // sharp crests, broad valleys: spines to fight along
  billowy: (n) => 2 * Math.abs(n) - 1,  // rounded hilltops over flat-bottomed basins
};
export const RIPPLE_MODES = ['isotropic', 'dunes'];

// Quantize into benches with a smoothly-eased tread. Monotonic, so a terraced hill keeps the same
// up/down structure as the hill it came from -- it just gains flat ground to stand and fight on.
function terrace(n, steps, sharpness) {
  const s = (n + 1) * 0.5 * steps;
  const i = Math.floor(s);
  const f = s - i;
  let eased = f;
  for (let k = 0; k < 3; k++) eased = eased * eased * (3 - 2 * eased);
  return ((i + f + (eased - f) * sharpness) / steps) * 2 - 1;
}

export function normalizeTerrainParams(params = {}) {
  const p = { ...BOT_TERRAIN_DEFAULTS, ...params };
  p.hillScale = Math.max(0.5, p.hillScale);
  p.rippleScale = Math.max(0.2, p.rippleScale);
  p.noiseScale = Math.max(0.1, p.noiseScale);
  p.hillOctaves = Math.max(1, Math.min(6, Math.round(p.hillOctaves)));
  p.meshCell = Math.max(0.05, p.meshCell);
  p.maxSegments = Math.max(2, Math.round(p.maxSegments));
  p.flattenFalloff = Math.max(0.01, p.flattenFalloff);
  p.fieldCell = Math.max(0.05, p.fieldCell);
  p.maxFieldSegments = Math.max(2, Math.round(p.maxFieldSegments));
  if (!LANDFORMS[p.landform]) p.landform = 'rolling';
  if (!RIPPLE_MODES.includes(p.rippleMode)) p.rippleMode = 'isotropic';
  p.warpAmp = Math.max(0, p.warpAmp);
  p.warpScale = Math.max(1, p.warpScale);
  p.terraceSteps = Math.max(0, Math.round(p.terraceSteps));
  p.terraceSharpness = Math.min(1, Math.max(0, p.terraceSharpness));
  p.erosionAmp = Math.max(0, p.erosionAmp);
  p.erosionArea = Math.max(1, Math.round(p.erosionArea));
  p.erosionSmooth = Math.min(1, Math.max(0, p.erosionSmooth));
  p.shadeRock = Math.max(0, p.shadeRock);
  p.shadeChannel = Math.max(0, p.shadeChannel);
  p.shadeAltitude = Math.max(0, p.shadeAltitude);
  p.featureCount = Math.max(0, Math.round(p.featureCount));
  if (p.featureMix !== 'mixed' && !FEATURE_KINDS.includes(p.featureMix)) p.featureMix = 'mixed';
  p.featureHeight = Math.max(0, p.featureHeight);
  p.connectPasses = !!p.connectPasses;
  p.passWidth = Math.max(0.5, p.passWidth);
  return p;
}

// A field object rather than a bare function so the viewer can swap params without rewiring
// every callsite that closed over heightAt.
// `flatten` is a list of {x, z, radius} pads (spawns, cover footprints, building slabs): inside
// the radius the ground is level at the raw height of the pad center, then smoothly rejoins the
// terrain over flattenFalloff. Without it a spawn can land on a 40-deg face and a cover box has
// to be sunk so far its top clears the hillside.
//
// Pass `opts.bounds` to bake: the field is evaluated once onto a Float32Array grid and every
// later query is a bilinear lookup. This is not a cache -- it is the enabling move. A rebuild
// spends ~80% of its time re-evaluating noise for the central differences behind slopeAt and
// normalAt (4 evals each, per nav cell and per mesh vertex); against a baked grid those become
// four array reads. Without bounds the field stays purely analytic and behaves exactly as before.
export function createTerrainField(params = {}, flatten = [], opts = {}) {
  const p = normalizeTerrainParams(params);
  const ripplePhase = hash2(7, 13, p.seed) * TAU;

  const shape = LANDFORMS[p.landform];
  const warping = p.warpAmp > 0;
  const terraced = p.terraceSteps > 0;
  // Dune direction is drawn from the seed instead of hardcoded. The old band summed two sines on
  // fixed axes, so every map ever generated wore the same diagonal corduroy; worse, it read as a
  // rendering artifact rather than ground. A per-map angle keeps the corrugation coherent (a
  // position-varying one would blow up the gradient far from the origin) while un-sticking it.
  const duneAngle = hash2(31, 17, p.seed) * TAU;
  const duneCos = Math.cos(duneAngle), duneSin = Math.sin(duneAngle);

  function rawHeight(x, z) {
    if (!p.enabled) return 0;
    let hx = x, hz = z;
    if (warping) {
      // Push the sample point sideways before reading the hills: straight-edged fBm blobs become
      // sinuous ridges and hooked valleys, which is most of what makes terrain read as landscape.
      hx += (valueNoise(x / p.warpScale, z / p.warpScale, p.seed + 313) * 2 - 1) * p.warpAmp;
      hz += (valueNoise(x / p.warpScale + 5.7, z / p.warpScale - 3.1, p.seed + 727) * 2 - 1) * p.warpAmp;
    }
    let n = shape(fbm(hx / p.hillScale, hz / p.hillScale, p.seed, p.hillOctaves));
    if (terraced) n = terrace(n, p.terraceSteps, p.terraceSharpness);
    let h = n * p.hillAmp;
    if (p.rippleAmp !== 0) {
      if (p.rippleMode === 'dunes') {
        const a = (x * duneCos + z * duneSin) / p.rippleScale;
        const b = (x * -duneSin + z * duneCos) / p.rippleScale;
        h += (Math.sin(a * TAU) + Math.sin(b * TAU * 0.73 + ripplePhase)) * 0.5 * p.rippleAmp;
      } else {
        h += fbm(x / p.rippleScale, z / p.rippleScale, p.seed + 401, 2) * p.rippleAmp;
      }
    }
    if (p.noiseAmp !== 0) {
      h += (valueNoise(x / p.noiseScale, z / p.noiseScale, p.seed + 977) * 2 - 1) * p.noiseAmp;
    }
    return h;
  }

  // Bake the bare landform first, erode it, and only then resolve pads against the result. Order
  // matters: pads exist to guarantee level build sites, so a drainage channel must not be allowed
  // to cut through the ground a spawn or a building slab is standing on.
  const grid = p.enabled && opts.bounds ? bakeGrid(p, opts, rawHeight) : null;
  const features = grid ? generateFeatures(opts.bounds, p) : [];
  if (features.length) stampFeatures(grid, features, p.featureHeight * 1.5);
  if (grid && p.erosionAmp > 0) erodeGrid(grid, p);
  // Last thing done to the bare landform: whatever the bands, features and channels left behind,
  // the walkable ground has to be one piece. Runs only when it isn't, and costs nothing when the
  // terrain was never fragmented.
  const connectivity = grid ? connectGrid(grid, p, opts.bounds) : null;

  // Pad levels resolve once against the surface beneath them: sampling heightAt here would be
  // recursive, and overlapping pads would otherwise drift depending on evaluation order.
  // `reach` is precomputed so the per-sample loop rejects distant pads with two comparisons —
  // heightAt runs per mesh vertex and per nav cell, against every pad on the map.
  const baseAt = grid ? (x, z) => readGrid(grid, x, z, rawHeight) : rawHeight;
  // `y` and `falloff` are both optional: omit y and the pad levels to the ground it sits on, omit
  // falloff and it uses the global rim. A pad that supplies its own y RAISES the ground to it, and
  // its own falloff is what decides whether the rim is walkable -- a smoothstep rim peaks at
  // 1.5 * rise / falloff, so a mesa and a climbable berm differ only in that ratio.
  const pads = (p.enabled ? flatten : []).map((f) => {
    const radius = Math.max(0.01, f.radius);
    const falloff = Math.max(0.01, f.falloff ?? p.flattenFalloff);
    return { x: f.x, z: f.z, radius, falloff, y: f.y ?? baseAt(f.x, f.z), reach: radius + falloff };
  });

  // Uniform bucket index over the pads. A structure-heavy map carries a hundred of them and
  // heightAt runs hundreds of thousands of times per rebuild, so the loop must not be O(pads).
  const padBuckets = new Map();
  const bucketKey = (x, z) => (Math.floor(x / PAD_BUCKET) & 0xffff) * 65536 + (Math.floor(z / PAD_BUCKET) & 0xffff);
  for (const pad of pads) {
    const c0 = Math.floor((pad.x - pad.reach) / PAD_BUCKET), c1 = Math.floor((pad.x + pad.reach) / PAD_BUCKET);
    const r0 = Math.floor((pad.z - pad.reach) / PAD_BUCKET), r1 = Math.floor((pad.z + pad.reach) / PAD_BUCKET);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const k = (c & 0xffff) * 65536 + (r & 0xffff);
        const list = padBuckets.get(k);
        if (list) list.push(pad); else padBuckets.set(k, [pad]);
      }
    }
  }

  // Level `h` toward any pads covering (x, z). Split out from the height lookup because the bake
  // has to apply it to grid nodes that already carry eroded heights, not to a fresh raw sample.
  function padBlend(x, z, h) {
    if (pads.length === 0) return h;
    const near = padBuckets.get(bucketKey(x, z));
    if (near === undefined) return h;
    // Weight every nearby pad, then take the level from those within PAD_BLEND_BAND of the
    // strongest. A plain argmax jumps the ground the instant the winner changes -- three
    // overlapping cover pads produced a 753 mm step across 5 cm, a wall the nav gate then marked
    // unwalkable. The band ramps a joiner in from zero, so the surface stays continuous while a
    // pad with no close rival still levels its own footprint exactly.
    let bestW = 0, count = 0;
    for (let i = 0; i < near.length; i++) {
      const pad = near[i];
      const dx = x - pad.x, dz = z - pad.z;
      if (dx > pad.reach || dx < -pad.reach || dz > pad.reach || dz < -pad.reach) continue;
      const d = Math.hypot(dx, dz);
      if (d >= pad.reach) continue;
      const t = d <= pad.radius ? 0 : (d - pad.radius) / pad.falloff;
      const w = 1 - t * t * (3 - 2 * t);   // smoothstep, 1 at the pad, 0 at the rim
      padW[count] = w; padY[count] = pad.y; count++;
      if (w > bestW) bestW = w;
      if (count === padW.length) break;   // scratch is full; the strongest pads are already in
    }
    if (bestW <= 0) return h;
    const floor = bestW - PAD_BLEND_BAND;
    let sumW = 0, sumY = 0;
    for (let i = 0; i < count; i++) {
      const t = (padW[i] - floor) / PAD_BLEND_BAND;
      if (t <= 0) continue;
      const contrib = t >= 1 ? 1 : t * t * (3 - 2 * t);   // smoothstep in: zero slope where a rival joins
      sumW += contrib; sumY += contrib * padY[i];
    }
    return h + (sumY / sumW - h) * bestW;
  }

  // The analytic reference: raw bands, then pads. Erosion lives only on the grid, so outside the
  // baked window (BAKE_MARGIN past the layout, i.e. off-map) the ground is un-eroded.
  function analyticHeight(x, z) { return padBlend(x, z, rawHeight(x, z)); }

  // Stamp the pads into the grid, so a baked lookup needs no per-query pad work at all.
  if (grid && pads.length) {
    const H = grid.heights;
    for (let r = 0; r < grid.rows; r++) {
      const z = grid.minZ + r * grid.step;
      for (let c = 0; c < grid.cols; c++) {
        const k = r * grid.cols + c;
        H[k] = padBlend(grid.minX + c * grid.step, z, H[k]);
      }
    }
  }

  function sampleGrid(x, z) { return readGrid(grid, x, z, analyticHeight); }

  const heightAt = grid ? sampleGrid : analyticHeight;

  // Central-difference gradient; deterministic in (x,z) so mesh and nav agree.
  // Baked mode widens a too-small epsilon to the grid pitch: sampling both probes inside one
  // bilinear patch would return that patch's constant gradient and shade the hill in facets.
  const minEps = grid ? grid.step : 0;
  function gradientAt(x, z, e = 0.25) {
    if (e < minEps) e = minEps;
    const dx = (heightAt(x + e, z) - heightAt(x - e, z)) / (2 * e);
    const dz = (heightAt(x, z + e) - heightAt(x, z - e)) / (2 * e);
    return { dx, dz };
  }

  function slopeAt(x, z, e) {
    const g = gradientAt(x, z, e);
    return Math.hypot(g.dx, g.dz);
  }

  function normalAt(x, z, out = [0, 1, 0]) {
    const g = gradientAt(x, z);
    const inv = 1 / (Math.hypot(-g.dx, 1, -g.dz) || 1);
    out[0] = -g.dx * inv; out[1] = inv; out[2] = -g.dz * inv;
    return out;
  }

  return { params: p, pads, features, grid, connectivity, baked: grid !== null, heightAt, analyticHeight, rawHeight, gradientAt, slopeAt, normalAt };
}

// ── placed landform features ────────────────────────────────────────────────
// Noise gives you ground; it does not give you a landmark. These are deliberate shapes with a
// tactical job: a mesa is high ground with a defined approach, a ravine is a sunken route or a
// barrier, an escarpment is a wall with flankable ends. They are stamped into the baked grid
// *before* erosion, so drainage answers to them -- water runs off a plateau rim and along a ravine
// floor, which is what stops them reading as objects dropped onto the terrain.
export const FEATURE_KINDS = ['plateau', 'ravine', 'escarpment'];

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function distToSegment(px, pz, ax, az, bx, bz) {
  const vx = bx - ax, vz = bz - az;
  const len2 = vx * vx + vz * vz;
  let t = len2 > 0 ? ((px - ax) * vx + (pz - az) * vz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
}

// Rejection-sampled placement with a separation gap, so features stay legible as separate
// landmarks instead of merging into one lump.
export function generateFeatures(bounds, params) {
  const p = params;
  if (p.featureCount <= 0 || p.featureHeight <= 0) return [];
  const w = bounds.maxX - bounds.minX, d = bounds.maxZ - bounds.minZ;
  const span = Math.min(w, d);
  if (!(span > 0)) return [];
  const rng = mulberry32((p.seed ^ 0x5f356495) >>> 0);
  const kinds = p.featureMix === 'mixed' ? FEATURE_KINDS : [p.featureMix];
  const gap = span * 0.13;
  const out = [];
  const range = (lo, hi) => lo + rng() * (hi - lo);

  for (let attempt = 0, guard = p.featureCount * 40; out.length < p.featureCount && attempt < guard; attempt++) {
    const kind = kinds[Math.min(kinds.length - 1, (rng() * kinds.length) | 0)];
    const x = bounds.minX + rng() * w, z = bounds.minZ + rng() * d;
    let clear = true;
    for (const f of out) if (Math.hypot(x - f.x, z - f.z) < gap) { clear = false; break; }
    if (!clear) continue;

    if (kind === 'plateau') {
      const radius = range(span * 0.05, span * 0.10);
      out.push({ kind, x, z, radius, edge: range(1.5, 3.5), rise: p.featureHeight * range(0.6, 1.0), reach: radius + 4 });
    } else {
      const angle = rng() * TAU;
      const len = range(span * 0.2, span * 0.45) * 0.5;
      const ax = x - Math.cos(angle) * len, az = z - Math.sin(angle) * len;
      const bx = x + Math.cos(angle) * len, bz = z + Math.sin(angle) * len;
      if (kind === 'ravine') {
        const half = range(1.5, 3.5);
        out.push({ kind, x, z, ax, az, bx, bz, half, edge: range(1.5, 3), depth: p.featureHeight * range(0.5, 0.9), reach: len + half + 4 });
      } else {
        const run = range(2, 4.5);
        out.push({ kind, x, z, ax, az, bx, bz, len, run, rise: p.featureHeight * range(0.5, 1.0), reach: len + run + 4 });
      }
    }
  }
  return out;
}

// Stamp features into a baked grid, in place. Cost is the features' own footprints, not the map.
// `limit` bounds how far the whole set may move any one cell: two overlapping escarpments used to
// add up to a 5 m wall from a 2.5 m setting, which is not what asking for 2.5 m features means.
export function stampFeatures(grid, features, limit = Infinity) {
  const H = grid.heights, cols = grid.cols, rows = grid.rows, step = grid.step;
  const before = Number.isFinite(limit) ? Float32Array.from(H) : null;
  for (const f of features) {
    const c0 = Math.max(0, Math.floor((f.x - f.reach - grid.minX) / step));
    const c1 = Math.min(cols - 1, Math.ceil((f.x + f.reach - grid.minX) / step));
    const r0 = Math.max(0, Math.floor((f.z - f.reach - grid.minZ) / step));
    const r1 = Math.min(rows - 1, Math.ceil((f.z + f.reach - grid.minZ) / step));
    if (c1 < c0 || r1 < r0) continue;
    // A mesa is levelled to one height, so its top is ground you can hold rather than a raised
    // copy of the bumps underneath it.
    const level = f.kind === 'plateau' ? readGrid(grid, f.x, f.z, () => 0) + f.rise : 0;

    for (let r = r0; r <= r1; r++) {
      const z = grid.minZ + r * step;
      for (let c = c0; c <= c1; c++) {
        const x = grid.minX + c * step;
        const k = r * cols + c;
        if (f.kind === 'plateau') {
          const t = 1 - smoothClamp((Math.hypot(x - f.x, z - f.z) - f.radius) / f.edge);
          if (t > 0) H[k] += (level - H[k]) * t;
        } else if (f.kind === 'ravine') {
          const t = 1 - smoothClamp((distToSegment(x, z, f.ax, f.az, f.bx, f.bz) - f.half) / f.edge);
          if (t > 0) H[k] -= f.depth * t;
        } else {
          // Signed side of the line, tapered to nothing past the ends so the wall has flanks.
          const vx = f.bx - f.ax, vz = f.bz - f.az;
          const inv = 1 / (Math.hypot(vx, vz) || 1);
          const side = ((x - f.ax) * -vz + (z - f.az) * vx) * inv;
          const along = ((x - f.ax) * vx + (z - f.az) * vz) * inv;
          const taper = 1 - smoothClamp((Math.abs(along - f.len) - f.len * 0.75) / (f.len * 0.25 + 1e-6));
          if (taper <= 0) continue;
          H[k] += f.rise * (1 - smoothClamp((side + f.run) / (f.run * 2))) * taper;
        }
      }
    }
  }
  if (before) {
    for (let i = 0; i < H.length; i++) {
      const d = H[i] - before[i];
      if (d > limit) H[i] = before[i] + limit;
      else if (d < -limit) H[i] = before[i] - limit;
    }
  }
  return grid;
}

// smoothstep with the clamp folded in: 0 at or below 0, 1 at or above 1.
function smoothClamp(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return t * t * (3 - 2 * t);
}

const D8_DC = [1, -1, 0, 0, 1, 1, -1, -1];
const D8_DR = [0, 0, 1, -1, 1, -1, 1, -1];
const D8_INV = [1, 1, 1, 1, Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2, Math.SQRT1_2];
const SORT_BUCKETS = 4096;
const FILL_EPS = 1e-4;   // m of fall forced across a filled flat, so it still has a drainage direction

// Priority-flood: return a routing surface in which every cell has a downhill path off the map.
// Flood inward from the border, always from the lowest frontier cell; a cell below the level the
// water arrived at is raised to it. Rolling fBm is full of closed basins, and without this the
// first pit swallows the drainage -- routes ran 5 m before dead-ending, which is useless for the
// thing erosion is here to produce. The fill is used only to decide where water goes; the carve
// still cuts the real surface, so basins stay basins and simply gain an outlet gully.
function fillDepressions(grid) {
  const H = grid.heights, cols = grid.cols, rows = grid.rows, n = cols * rows;
  const W = new Float32Array(n);
  const seen = new Uint8Array(n);
  const key = new Float64Array(n + 1), val = new Int32Array(n + 1);
  let size = 0;

  function push(k, v) {
    let i = ++size;
    key[i] = k; val[i] = v;
    while (i > 1) {
      const par = i >> 1;
      if (key[par] <= key[i]) break;
      const tk = key[par], tv = val[par];
      key[par] = key[i]; val[par] = val[i]; key[i] = tk; val[i] = tv;
      i = par;
    }
  }
  function pop() {
    const top = val[1];
    key[1] = key[size]; val[1] = val[size]; size--;
    let i = 1;
    for (;;) {
      const l = i << 1, r = l + 1;
      let m = i;
      if (l <= size && key[l] < key[m]) m = l;
      if (r <= size && key[r] < key[m]) m = r;
      if (m === i) break;
      const tk = key[m], tv = val[m];
      key[m] = key[i]; val[m] = val[i]; key[i] = tk; val[i] = tv;
      i = m;
    }
    return top;
  }
  const seed = (i) => { if (!seen[i]) { seen[i] = 1; W[i] = H[i]; push(H[i], i); } };
  for (let c = 0; c < cols; c++) { seed(c); seed((rows - 1) * cols + c); }
  for (let r = 1; r < rows - 1; r++) { seed(r * cols); seed(r * cols + cols - 1); }

  while (size > 0) {
    const i = pop();
    const r = (i / cols) | 0, c = i - r * cols;
    const lip = W[i] + FILL_EPS;
    for (let k = 0; k < 8; k++) {
      const nc = c + D8_DC[k], nr = r + D8_DR[k];
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const j = nr * cols + nc;
      if (seen[j]) continue;
      seen[j] = 1;
      W[j] = H[j] > lip ? H[j] : lip;
      push(W[j], j);
    }
  }
  return W;
}

// Drainage-network erosion, in place on a baked grid.
//
// Rain one unit on every cell, walk the cells from highest to lowest passing each cell's water to
// its steepest downhill neighbour, then cut each cell by the square root of what drains through it.
// Sqrt is the standard hydraulic scaling and it is what makes the result read as a landscape: a
// branching network of gullies feeding valleys, rather than noise with dents in it. For the map
// that means natural sunken routes between high ground -- cover and approach lanes the generator
// never had to place.
//
// Ordering is a counting sort on quantised height. A comparator sort of 130k cells costs more than
// every other stage of the bake combined, and cells within one 4096th of the relief are close
// enough that mis-ordering them changes nothing.
export function erodeGrid(grid, params) {
  const p = params;
  const H = grid.heights, cols = grid.cols, rows = grid.rows, n = cols * rows;
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < n; i++) { const h = H[i]; if (h < min) min = h; if (h > max) max = h; }
  if (!(max > min)) return null;   // dead flat: nothing to drain

  // Route on the depression-filled surface, carve the real one.
  const R = p.erosionFillPits ? fillDepressions(grid) : H;
  if (R !== H) {
    min = Infinity; max = -Infinity;
    for (let i = 0; i < n; i++) { const h = R[i]; if (h < min) min = h; if (h > max) max = h; }
    if (!(max > min)) return null;
  }

  const qs = (SORT_BUCKETS - 1) / (max - min);
  const counts = new Int32Array(SORT_BUCKETS);
  const bucket = new Int32Array(n);
  for (let i = 0; i < n; i++) { const b = ((R[i] - min) * qs) | 0; bucket[i] = b; counts[b]++; }
  const cursor = new Int32Array(SORT_BUCKETS);
  for (let b = SORT_BUCKETS - 1, at = 0; b >= 0; b--) { cursor[b] = at; at += counts[b]; }
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[cursor[bucket[i]]++] = i;

  const flow = new Float32Array(n).fill(1);
  for (let o = 0; o < n; o++) {
    const i = order[o];
    const r = (i / cols) | 0, c = i - r * cols;
    const h = R[i];
    let best = -1, bestDrop = 0;
    for (let k = 0; k < 8; k++) {
      const nc = c + D8_DC[k], nr = r + D8_DR[k];
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const j = nr * cols + nc;
      const drop = (h - R[j]) * D8_INV[k];
      if (drop > bestDrop) { bestDrop = drop; best = j; }
    }
    if (best >= 0) flow[best] += flow[i];   // only a border cell has nowhere left to send it
  }

  // Measured against a cell that drains nothing but itself, so erosionAmp is the depth of a full
  // channel below unchannelled ground rather than below a uniform lowering of the whole map.
  const invArea = 1 / p.erosionArea;
  const floor = Math.sqrt(invArea);
  const span = Math.max(1e-6, 1 - floor);
  const depth = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (Math.sqrt(flow[i] * invArea) - floor) / span;
    depth[i] = t <= 0 ? 0 : t > 1 ? 1 : t;
    H[i] -= p.erosionAmp * depth[i];
  }

  // Widen what was cut. A pure incision is a one-cell V that reads as a crack and that no bot can
  // walk; two smoothing passes weighted by channel strength turn it into a valley floor while
  // leaving the ridges between channels untouched.
  if (p.erosionSmooth > 0) {
    const src = new Float32Array(n);
    for (let pass = 0; pass < 2; pass++) {
      src.set(H);
      for (let r = 1; r < rows - 1; r++) {
        for (let c = 1; c < cols - 1; c++) {
          const i = r * cols + c;
          const w = p.erosionSmooth * depth[i];
          if (w <= 0) continue;
          const avg = (src[i - 1] + src[i + 1] + src[i - cols] + src[i + cols]
            + src[i - cols - 1] + src[i - cols + 1] + src[i + cols - 1] + src[i + cols + 1]) * 0.125;
          H[i] = src[i] + (avg - src[i]) * w;
        }
      }
    }
  }

  grid.flow = flow;     // kept for terrain shading: channels are where sediment shows
  grid.channel = depth; // 0..1 channel strength per cell
  return grid;
}

// ── connectivity: carved passes ─────────────────────────────────────────────
// Erosion and placed landforms both build barriers -- a ravine wall, an escarpment face, a channel
// cut through a ridge -- and nothing until now checked that the ground they left was still one
// piece. It usually was not: the eroded-highlands preset routinely fenced off 700 m2 of otherwise
// good ground behind slopes the nav gate marks unwalkable. A bot spawned in there can walk around
// its island but every goal it wants is outside, so A* returns nothing and every goal handler in
// the viewer answers an empty path by zeroing velocity. It stands in a valley doing nothing.
//
// So: find the stranded components and cut a pass into each one, the way a road crosses a ridge.
// This runs only when the ground is actually fragmented, and the result is verified rather than
// assumed -- `connectGrid` re-labels at the end and reports what it could not fix.
// Graded well under the limit, and with a flat floor rather than a knife-edge, because the
// consumer does not sample where this carves: the nav grid tests cell centres, half a field cell
// off the nodes written here, so a pass built exactly to the limit fails on the ground that
// matters. Headroom is cheaper than a second stranded region.
const PASS_GRADE_SAFETY = 0.5;   // fraction of maxSlope a carved pass is graded to
const PASS_FLOOR_FRAC = 0.55;    // inner fraction of the pass width cut flat before the rim tapers
const PASS_MASK_MARGIN = 0.95;   // fraction of maxSlope a cell must beat to count as connected here
// Under 1, so the sides of a cut are themselves walkable. At 1.4 they were not, and a pass could
// pinch off a fresh sliver against the old hillside -- the carve then spent every later round
// chasing strandings it had just created, and never converged.
const PASS_RIM_GRADE = 0.85;     // multiple of maxSlope the sides of a cut fall at
const PASS_RIM_MAX_TAPER = 5;    // m, so a very deep cut still reads as a pass and not a crater
const PASS_FILL_MAX = 1.5;       // m a pass may fill above its lower end -- a gully bridge, not a causeway
const PASS_MIN_COMPONENT = 12;   // cells; below this a stranding is a ledge, not somewhere a bot goes
const PASS_MAX_ROUNDS = 3;       // carve/re-label rounds before giving up (seeds converge in 1-2)
const PASS_SEARCH_CAP = 60000;   // cells one pass search may expand before it is abandoned

let passScratchLen = 0, passGen = 0;
let passDist = null, passPrev = null, passDone = null, passStamp = null;
let passHeapKey = null, passHeapVal = null;
function acquirePassScratch(n) {
  if (passScratchLen < n) {
    passScratchLen = n;
    passDist = new Float64Array(n);
    passPrev = new Int32Array(n);
    passDone = new Uint8Array(n);
    passStamp = new Int32Array(n);
    passHeapKey = new Float64Array(n + 1);
    passHeapVal = new Int32Array(n + 1);
    passGen = 0;   // fresh stamps read 0, so generations must start above it
  }
  passGen++;
  if (passGen >= 0x7fffffff) { passStamp.fill(0); passGen = 1; }
  return passGen;
}

function gridSlope(H, cols, rows, step, c, r) {
  const i = r * cols + c;
  const dx = c > 0 && c < cols - 1 ? (H[i + 1] - H[i - 1]) / (2 * step)
    : c > 0 ? (H[i] - H[i - 1]) / step : (H[i + 1] - H[i]) / step;
  const dz = r > 0 && r < rows - 1 ? (H[i + cols] - H[i - cols]) / (2 * step)
    : r > 0 ? (H[i] - H[i - cols]) / step : (H[i + cols] - H[i]) / step;
  return Math.hypot(dx, dz);
}

// Walkable-cell mask matching what the viewer's nav gate will decide: same central-difference
// slope at the same epsilon, and restricted to the layout bounds, since the baked grid's margin
// is off-map ground no nav cell covers. A mask that routed through the margin would call a map
// connected that the nav grid still splits.
// Hot: it runs over every grid node on every map, including the ones that were never fragmented,
// so the loop compares squared gradients (no sqrt, no hypot) and resolves the bounds window into
// index ranges once instead of testing two coordinates per cell.
function passableMask(grid, maxSlope, bounds) {
  const { heights: H, cols, rows, step, minX, minZ } = grid;
  const mask = new Uint8Array(cols * rows);
  const limit = maxSlope * PASS_MASK_MARGIN;
  const lim2 = limit * limit;
  const inv2 = 1 / (2 * step);
  let c0 = 1, c1 = cols - 2, r0 = 1, r1 = rows - 2;   // one-sided edges are the bake margin: skip
  if (bounds) {
    c0 = Math.max(c0, Math.ceil((bounds.minX - minX) / step));
    c1 = Math.min(c1, Math.floor((bounds.maxX - minX) / step));
    r0 = Math.max(r0, Math.ceil((bounds.minZ - minZ) / step));
    r1 = Math.min(r1, Math.floor((bounds.maxZ - minZ) / step));
  }
  let blocked = 0;
  for (let r = r0; r <= r1; r++) {
    const row = r * cols;
    for (let c = c0; c <= c1; c++) {
      const i = row + c;
      const dx = (H[i + 1] - H[i - 1]) * inv2;
      const dz = (H[i + cols] - H[i - cols]) * inv2;
      if (dx * dx + dz * dz <= lim2) mask[i] = 1; else blocked++;
    }
  }
  // No blocked cell inside the map means one component by construction -- worth knowing, because
  // the shipped open-field preset is exactly that and would otherwise pay for a flood fill that
  // can only ever return the answer "yes, still connected".
  return { mask, blocked };
}

// 8-connected components with A*'s corner rule, so a label never claims a route the search can't walk.
function componentLabels(grid, mask) {
  const { cols, rows } = grid;
  const n = cols * rows;
  const label = new Int32Array(n).fill(-1);
  const sizes = [];
  // Typed stack: a plain array of ~100k boxed indices costs more than the fill itself.
  const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (!mask[s] || label[s] >= 0) continue;
    const id = sizes.length;
    let count = 0;
    let top = 0;
    label[s] = id; stack[top++] = s;
    while (top > 0) {
      const k = stack[--top];
      count++;
      const r = (k / cols) | 0, c = k - r * cols;
      for (let i = 0; i < 8; i++) {
        const nc = c + D8_DC[i], nr = r + D8_DR[i];
        if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
        const nk = nr * cols + nc;
        if (!mask[nk] || label[nk] >= 0) continue;
        if (D8_DC[i] !== 0 && D8_DR[i] !== 0 && (!mask[r * cols + nc] || !mask[nr * cols + c])) continue;
        label[nk] = id; stack[top++] = nk;
      }
    }
    sizes.push(count);
  }
  let main = -1, best = 0;
  for (let i = 0; i < sizes.length; i++) if (sizes[i] > best) { best = sizes[i]; main = i; }
  return { label, sizes, main };
}

// Cheapest route from every cell of `from` to any cell of `to`, over ground that is mostly not
// walkable -- so the cost of a cell is how badly it exceeds the slope limit. That picks the
// thinnest, gentlest part of the barrier, which is where a pass belongs. Bounded: a stranding
// with no plausible crossing is left alone rather than allowed to sweep the map.
function findPassRoute(grid, mask, label, from, to, maxSlope, bounds) {
  const { heights: H, cols, rows, step, minX, minZ } = grid;
  const n = cols * rows;
  // Generation-stamped scratch: a fragmented map wants a dozen of these searches, and allocating
  // (and zeroing) four full-grid arrays each time costs more than the searches themselves.
  const gen = acquirePassScratch(n);
  const dist = passDist, prev = passPrev, done = passDone, stamp = passStamp;
  const hk = passHeapKey, hv = passHeapVal;
  let size = 0;
  const push = (k, v) => {
    let i = ++size; hk[i] = k; hv[i] = v;
    while (i > 1) {
      const par = i >> 1;
      if (hk[par] <= hk[i]) break;
      const tk = hk[par], tv = hv[par];
      hk[par] = hk[i]; hv[par] = hv[i]; hk[i] = tk; hv[i] = tv;
      i = par;
    }
  };
  const pop = () => {
    const top = hv[1];
    hk[1] = hk[size]; hv[1] = hv[size]; size--;
    let i = 1;
    for (;;) {
      const l = i << 1, r = l + 1;
      let m = i;
      if (l <= size && hk[l] < hk[m]) m = l;
      if (r <= size && hk[r] < hk[m]) m = r;
      if (m === i) break;
      const tk = hk[m], tv = hv[m];
      hk[m] = hk[i]; hv[m] = hv[i]; hk[i] = tk; hv[i] = tv;
      i = m;
    }
    return top;
  };
  for (let i = 0; i < n; i++) {
    if (label[i] !== from) continue;
    stamp[i] = gen; dist[i] = 0; prev[i] = -1; done[i] = 0;
    push(0, i);
  }
  let expanded = 0;
  while (size > 0) {
    const i = pop();
    if (done[i]) continue;
    done[i] = 1;
    if (++expanded > PASS_SEARCH_CAP) return null;
    if (label[i] === to) {
      const path = [];
      for (let k = i; k >= 0; k = prev[k]) path.push(k);
      return path;   // main-component end first, stranded end last
    }
    const r = (i / cols) | 0, c = i - r * cols;
    for (let d = 0; d < 4; d++) {   // 4-connected: a carved corridor should not step diagonally
      const nc = c + D8_DC[d], nr = r + D8_DR[d];
      if (nc < 1 || nr < 1 || nc >= cols - 1 || nr >= rows - 1) continue;
      const x = minX + nc * step, z = minZ + nr * step;
      if (bounds && (x < bounds.minX || x > bounds.maxX || z < bounds.minZ || z > bounds.maxZ)) continue;
      const j = nr * cols + nc;
      const seen = stamp[j] === gen;
      if (seen && done[j]) continue;
      // Free inside a component, priced by excess steepness outside one.
      const excess = mask[j] ? 0 : gridSlope(H, cols, rows, step, nc, nr) / maxSlope - 1;
      const w = step * (1 + 8 * Math.max(0, excess));
      const nd = dist[i] + w;
      if (!seen || nd < dist[j]) {
        if (!seen) { stamp[j] = gen; done[j] = 0; }
        dist[j] = nd; prev[j] = i; push(nd, j);
      }
    }
  }
  return null;
}

// Grade the route to something a bot can walk, and widen it into a corridor.
//
// The profile is the double cone rising at `grade` from each end. Ground above it is cut away;
// ground below it is filled in -- both are needed, and finding that out cost a round of debugging:
// the strandings that survived every carve were not ringed by ridges at all but by a one-cell
// erosion gully, a hole two metres from walkable ground. Lowering a hole does nothing, so those
// passes were carved and re-carved to no effect.
//
// Filling is capped at PASS_FILL_MAX above the lower end, which is what keeps this from turning a
// long route across a ravine into a causeway. The cap only ever lowers the cone, so the profile
// stays grade-limited.
function carveRoute(grid, route, params, grade) {
  const { heights: H, cols, rows, step } = grid;
  const L = route.length - 1;
  if (L < 1) return;
  const hA = H[route[0]], hB = H[route[L]];
  const maxDelta = grade * step;
  const fillCeiling = Math.min(hA, hB) + PASS_FILL_MAX;
  const flat = Math.max(step * 1.5, params.passWidth * 0.5) * PASS_FLOOR_FRAC;
  // Strongest influence wins per cell, resolved after the sweep rather than during it, so
  // overlapping discs along the route can't undo each other depending on visit order.
  const bestW = new Map(), bestTarget = new Map();
  for (let i = 0; i <= L; i++) {
    const k0 = route[i];
    const cone = Math.min(hA + i * maxDelta, hB + (L - i) * maxDelta, fillCeiling);
    // The rim tapers in proportion to how far the ground moves here. A fixed half-metre taper
    // turns a 3 m cut into a knife edge, which is a wall in its own right -- and the sliver caught
    // between that edge and the old hillside is a fresh stranding the next round has to chase.
    const move = Math.abs(H[k0] - cone);
    const taper = Math.min(PASS_RIM_MAX_TAPER, Math.max(step, move / (PASS_RIM_GRADE * params.maxSlope)));
    const radius = flat + taper;
    const cellR = Math.ceil(radius / step);
    const r0 = (k0 / cols) | 0, c0 = k0 - r0 * cols;
    for (let dr = -cellR; dr <= cellR; dr++) {
      const r = r0 + dr;
      if (r < 0 || r >= rows) continue;
      for (let dc = -cellR; dc <= cellR; dc++) {
        const c = c0 + dc;
        if (c < 0 || c >= cols) continue;
        const d = Math.hypot(dc, dr) * step;
        if (d > radius) continue;
        const w = 1 - smoothClamp((d - flat) / taper);   // flat floor, then a walkable rim
        if (w <= 0) continue;
        const k = r * cols + c;
        if (w > (bestW.get(k) ?? 0)) { bestW.set(k, w); bestTarget.set(k, cone); }
      }
    }
  }
  const touched = new Set();
  for (const [k, w] of bestW) {
    const next = H[k] + (bestTarget.get(k) - H[k]) * w;
    if (next !== H[k]) { H[k] = next; touched.add(k); }
  }
  // Two smoothing passes over the cut and its rim: the discs leave scallops where they overlap,
  // and a notch inside the corridor is exactly the kind of one-cell wall this is here to remove.
  if (touched.size === 0) return;
  const ring = new Set(touched);
  for (const k of touched) {
    const r = (k / cols) | 0, c = k - r * cols;
    for (let i = 0; i < 8; i++) {
      const nc = c + D8_DC[i], nr = r + D8_DR[i];
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      ring.add(nr * cols + nc);
    }
  }
  const src = new Float32Array(H.length);
  for (let pass = 0; pass < 2; pass++) {
    src.set(H);
    for (const k of ring) {
      const r = (k / cols) | 0, c = k - r * cols;
      if (c < 1 || r < 1 || c >= cols - 1 || r >= rows - 1) continue;
      const avg = (src[k - 1] + src[k + 1] + src[k - cols] + src[k + cols]
        + src[k - cols - 1] + src[k - cols + 1] + src[k + cols - 1] + src[k + cols + 1]) * 0.125;
      H[k] = src[k] + (avg - src[k]) * 0.5;
    }
  }
}

// Guarantee the walkable ground is one piece, by carving a pass into every stranding worth
// reaching. Returns a report; `stranded` > 0 in it means the map is still split and the caller
// should know rather than find out from a bot standing in a hole.
export function connectGrid(grid, params, bounds = null) {
  const p = params;
  if (!grid || !p.connectPasses || !(p.maxSlope > 0)) return null;
  const grade = p.maxSlope * PASS_GRADE_SAFETY;
  const report = { rounds: 0, carved: 0, stranded: 0, strandedCells: 0, components: 1 };
  // One round past the carve budget, so the numbers reported are measured after the last cut
  // rather than before it.
  for (let round = 0; round <= PASS_MAX_ROUNDS; round++) {
    const { mask, blocked } = passableMask(grid, p.maxSlope, bounds);
    report.rounds = round;
    if (blocked === 0) break;   // nothing to be fenced off by
    const lab = componentLabels(grid, mask);
    report.components = lab.sizes.length;
    report.stranded = 0; report.strandedCells = 0;
    const targets = [];
    for (let id = 0; id < lab.sizes.length; id++) {
      if (id === lab.main || lab.sizes[id] < PASS_MIN_COMPONENT) continue;
      report.stranded++; report.strandedCells += lab.sizes[id];
      targets.push(id);
    }
    if (targets.length === 0 || round === PASS_MAX_ROUNDS) break;
    let cut = 0;
    for (const id of targets) {
      const route = findPassRoute(grid, mask, lab.label, id, lab.main, p.maxSlope, bounds);
      if (!route) continue;
      carveRoute(grid, route, p, grade);
      report.carved++; cut++;
    }
    if (cut === 0) break;   // nothing left that a pass can reach; report it as stranded
  }
  return report;
}

// Bilinear read off a baked grid; anything outside it defers to `outside` so a query past the map
// edge stays correct rather than clamping to the border row.
function readGrid(grid, x, z, outside) {
  const fx = (x - grid.minX) * grid.inv, fz = (z - grid.minZ) * grid.inv;
  if (!(fx >= 0) || !(fz >= 0)) return outside(x, z);   // negated so NaN falls through
  const c = fx | 0, r = fz | 0;
  if (c >= grid.cols - 1 || r >= grid.rows - 1) return outside(x, z);
  const tx = fx - c, tz = fz - r;
  const k = r * grid.cols + c, H = grid.heights;
  const a = H[k], b = H[k + 1], d = H[k + grid.cols], e = H[k + grid.cols + 1];
  return (a + (b - a) * tx) * (1 - tz) + (d + (e - d) * tx) * tz;
}

// One analytic evaluation per node, then everything else reads the array. Cell pitch is the
// coarser of fieldCell and whatever maxFieldSegments allows, so the grid stays uniform in x and z
// (a non-square cell would make gradientAt's single epsilon wrong on one axis).
function bakeGrid(p, opts, sample) {
  const b = opts.bounds;
  const margin = opts.margin ?? BAKE_MARGIN;
  const minX = b.minX - margin, minZ = b.minZ - margin;
  const w = (b.maxX + margin) - minX, d = (b.maxZ + margin) - minZ;
  if (!(w > 0) || !(d > 0)) return null;
  const step = Math.max(opts.cell ?? p.fieldCell, w / p.maxFieldSegments, d / p.maxFieldSegments);
  const cols = Math.max(2, Math.floor(w / step) + 2);
  const rows = Math.max(2, Math.floor(d / step) + 2);
  const heights = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    const z = minZ + r * step;
    for (let c = 0; c < cols; c++) heights[r * cols + c] = sample(minX + c * step, z);
  }
  return { heights, cols, rows, step, inv: 1 / step, minX, minZ };
}

// Lowest/highest ground under an axis-aligned footprint, sampled on a small grid. Used to sink
// wall and cover boxes into the hillside instead of letting them float over a dip.
export function footprintRange(field, x, z, w, d, samples = 3) {
  const n = Math.max(2, samples | 0);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < n; i++) {
    const sx = x - w / 2 + (w * i) / (n - 1);
    for (let j = 0; j < n; j++) {
      const sz = z - d / 2 + (d * j) / (n - 1);
      const h = field.heightAt(sx, sz);
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  return { min, max };
}

// Indexed grid mesh over `bounds`, displaced by the field. Returns plain typed arrays so the
// caller owns all THREE objects.
export function buildTerrainMeshArrays(bounds, field, opts = {}) {
  const p = field.params;
  const cell = Math.max(0.05, opts.meshCell ?? p.meshCell);
  const maxSeg = Math.max(2, Math.round(opts.maxSegments ?? p.maxSegments));
  const width = Math.max(1e-3, bounds.maxX - bounds.minX);
  const depth = Math.max(1e-3, bounds.maxZ - bounds.minZ);
  const segX = Math.max(1, Math.min(maxSeg, Math.round(width / cell)));
  const segZ = Math.max(1, Math.min(maxSeg, Math.round(depth / cell)));
  const vertsX = segX + 1, vertsZ = segZ + 1;

  const positions = new Float32Array(vertsX * vertsZ * 3);
  const normals = new Float32Array(vertsX * vertsZ * 3);
  const n = [0, 1, 0];
  for (let j = 0; j < vertsZ; j++) {
    const z = bounds.minZ + (depth * j) / segZ;
    for (let i = 0; i < vertsX; i++) {
      const x = bounds.minX + (width * i) / segX;
      const k = (j * vertsX + i) * 3;
      positions[k] = x;
      positions[k + 1] = field.heightAt(x, z);
      positions[k + 2] = z;
      field.normalAt(x, z, n);
      normals[k] = n[0]; normals[k + 1] = n[1]; normals[k + 2] = n[2];
    }
  }

  // Vertex colours: a multiplier on whatever the material's own colour is, so the map's theme
  // still owns the palette and this only says which ground is which. Without it every landform
  // and drainage channel below renders as one flat shade and the player cannot read the terrain.
  const colors = new Float32Array(vertsX * vertsZ * 3);
  const grid = field.grid || null;
  const channel = grid && grid.channel ? grid.channel : null;
  let minY = Infinity, maxY = -Infinity;
  for (let k = 1; k < positions.length; k += 3) {
    const y = positions[k];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const invRange = maxY > minY ? 1 / (maxY - minY) : 0;
  const ROCK_START = 0.35, ROCK_FULL = 1.1;   // rise/run over which bare rock takes over from soil
  for (let v = 0, verts = vertsX * vertsZ; v < verts; v++) {
    const k = v * 3;
    const ny = normals[k + 1] || 1;
    const slope = Math.hypot(normals[k], normals[k + 2]) / ny;
    let t = (slope - ROCK_START) / (ROCK_FULL - ROCK_START);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const rock = t * t * (3 - 2 * t);
    const alt = (positions[k + 1] - minY) * invRange;
    let wet = 0;
    if (channel) {
      const c = Math.round((positions[k] - grid.minX) * grid.inv);
      const r = Math.round((positions[k + 2] - grid.minZ) * grid.inv);
      if (c >= 0 && r >= 0 && c < grid.cols && r < grid.rows) wet = channel[r * grid.cols + c];
    }
    const base = 1 - p.shadeAltitude * 0.5 + alt * p.shadeAltitude;
    const lift = rock * p.shadeRock, sink = wet * p.shadeChannel;
    const cr = base + lift - sink * 0.85;
    const cg = base + lift * 0.88 - sink * 0.95;
    const cb = base + lift * 0.72 - sink * 1.05;
    colors[k] = cr > 0 ? cr : 0;
    colors[k + 1] = cg > 0 ? cg : 0;
    colors[k + 2] = cb > 0 ? cb : 0;
  }

  const quads = segX * segZ;
  const indices = quads * 6 > 65535 || vertsX * vertsZ > 65535
    ? new Uint32Array(quads * 6) : new Uint16Array(quads * 6);
  let t = 0;
  for (let j = 0; j < segZ; j++) {
    for (let i = 0; i < segX; i++) {
      const a = j * vertsX + i, b = a + 1, c = a + vertsX, d = c + 1;
      indices[t++] = a; indices[t++] = c; indices[t++] = b;
      indices[t++] = b; indices[t++] = c; indices[t++] = d;
    }
  }
  return { positions, normals, colors, indices, segX, segZ, triangleCount: quads * 2 };
}

// The height of the RENDERED ground, as opposed to the field it was built from.
//
// The mesh above is a triangulated approximation: it agrees with heightAt exactly at its own grid
// vertices and departs from it everywhere in between, by however much the ground curves across one
// cell. In a hollow the flat triangle sits ABOVE the field it interpolates. So anything that has to
// lie ON the visible ground -- a road ribbon, a painted strip, any draped decal -- must sample this
// and not the field: a fixed lift above the field is not a lift above the surface, and wherever the
// gap exceeds it the terrain comes through.
//
// Takes the same `bounds` passed to buildTerrainMeshArrays and the object it returned, so the
// triangle split is read off the real vertex buffer rather than re-derived and left to drift.
// Outside the bounds it clamps: past the sheet's edge there is no rendered ground to sit on.
export function createMeshSurface(bounds, mesh) {
  const { positions, segX, segZ } = mesh;
  const vertsX = segX + 1;
  const width = Math.max(1e-3, bounds.maxX - bounds.minX);
  const depth = Math.max(1e-3, bounds.maxZ - bounds.minZ);
  const cellX = width / segX, cellZ = depth / segZ;
  const h = (i, j) => positions[(j * vertsX + i) * 3 + 1];

  function heightAt(x, z) {
    let u = ((x - bounds.minX) / width) * segX;
    let v = ((z - bounds.minZ) / depth) * segZ;
    u = u < 0 ? 0 : u > segX ? segX : u;
    v = v < 0 ? 0 : v > segZ ? segZ : v;
    let i = Math.floor(u), j = Math.floor(v);
    if (i >= segX) i = segX - 1;
    if (j >= segZ) j = segZ - 1;
    const fu = u - i, fv = v - j;
    const a = h(i, j), b = h(i + 1, j), c = h(i, j + 1), d = h(i + 1, j + 1);
    // Matches the index buffer's split exactly: quads emit (a, c, b) then (b, c, d), so the
    // diagonal runs b->c and the first triangle owns the half where fu + fv <= 1.
    return fu + fv <= 1
      ? a + (b - a) * fu + (c - a) * fv
      : d + (c - d) * (1 - fu) + (b - d) * (1 - fv);
  }

  // Highest the ground gets within `radius` of (x, z). A flat quad laid on the ground has to clear
  // the ground's PEAKS inside its own footprint, not the height at its corners -- otherwise a
  // terrace lip or an erosion bank inside the quad cuts straight through it. On a piecewise-linear
  // surface the maximum over a box is attained at a grid node inside it or on its boundary, so
  // scanning the enclosed nodes plus the box's own corners finds it.
  function maxNear(x, z, radius) {
    let best = -Infinity;
    // Grid nodes fully inside the box: on a piecewise-linear surface these are where the peaks are.
    const i0 = Math.max(0, Math.ceil((x - radius - bounds.minX) / cellX));
    const i1 = Math.min(segX, Math.floor((x + radius - bounds.minX) / cellX));
    const j0 = Math.max(0, Math.ceil((z - radius - bounds.minZ) / cellZ));
    const j1 = Math.min(segZ, Math.floor((z + radius - bounds.minZ) / cellZ));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const v = h(i, j);
        if (v > best) best = v;
      }
    }
    // A ridge crossing the box can peak on the box's own boundary rather than at any enclosed node,
    // so sweep a lattice over the box as well, fine enough that no cell is stepped over.
    const steps = Math.max(2, Math.ceil((radius * 2) / Math.min(cellX, cellZ)) + 1);
    for (let a = 0; a <= steps; a++) {
      const px = x - radius + (radius * 2 * a) / steps;
      for (let b = 0; b <= steps; b++) {
        const v = heightAt(px, z - radius + (radius * 2 * b) / steps);
        if (v > best) best = v;
      }
    }
    return best;
  }

  return { heightAt, maxNear };
}
