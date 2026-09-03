// eco-gen.js -- pure generator for eco-brutalist structures, in metres, no THREE.
// Every rect is { x, z, w, d, y, h } with y the BASE (like bot-structures slabs).
// Lists: walls (concrete, weathers lightly), covers (concrete, weathers hard), bars (light steel),
// planters ({ x, z, w, d, y, rim, depth }: rim boxes are emitted into covers, soil sits at y + depth),
// water ({ x, z, w, d, y }). See intake-analysis.md for where each number came from.

export const ECO_KINDS = ['complex', 'spawn', 'atrium', 'lobby', 'pergola', 'slotgarden', 'pavilion'];

export const ECO_DEFAULTS = Object.freeze({
  wallT: 0.5, slabT: 0.5, rimT: 0.22, rimH: 0.45, soilDrop: 0.06,
  atriumWell: 26, atriumRing: 5, atriumLevels: 4, atriumPitch: 4.2, atriumLattice: 2.0,
  // lobbyFloor is the shared floor level: every room plinth, hallway walkway and threshold sits on it.
  lobbyW: 32, lobbyD: 24, lobbyH: 12, lobbyMezz: 4.3, lobbyBeamPitch: 3.2, lobbyPierPitch: 8, lobbyFloor: 0.45, lobbyPlaza: 7,
  pergolaWallH: 12, pergolaH: 5.5, pergolaSlatPitch: 0.45, pergolaFinPitch: 0.7, terraceRise: 1.8,
  doorH: 4.2,
  slotWallH: 12, slotGap: 8, slotLen: 26, slotWalk: 1.4,
  pavDeckW: 18, pavDeckD: 10, pavRoofH: 4.4, pavPondD: 12,
  hallNorth: 20, hallEast: 18,
});

export function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

function R(x, z, w, d, y, h) { return { x, z, w, d, y, h }; }

function makeOut() { return { walls: [], covers: [], bars: [], planters: [], water: [], spawn: null }; }

// A wall along one axis with an optional opening (a gap plus a lintel up to the wall top).
function wallRun(out, axis, fixed, from, to, t, h, y, gap = null) {
  const box = (mid, len, yy, hh) => (axis === 'x' ? R(mid, fixed, len, t, yy, hh) : R(fixed, mid, t, len, yy, hh));
  if (!gap) { out.walls.push(box((from + to) / 2, to - from, y, h)); return; }
  const a = gap.at - gap.w / 2, b = gap.at + gap.w / 2;
  if (a - from > 1e-6) out.walls.push(box((from + a) / 2, a - from, y, h));
  if (to - b > 1e-6) out.walls.push(box((b + to) / 2, to - b, y, h));
  if (gap.h < h - 1e-6) out.walls.push(box(gap.at, gap.w, y + gap.h, h - gap.h));
}

// A straight stair as stacked blocks: step i tops out at y + (i + 1) * rise.
function stair(out, { x, z, width, along, dir, steps, rise, tread, y = 0 }) {
  for (let i = 0; i < steps; i++) {
    const off = (i + 0.5) * tread * dir;
    const h = (i + 1) * rise;
    out.covers.push(along === 'z' ? R(x, z + off, width, tread, y, h) : R(x + off, z, tread, width, y, h));
  }
  return y + steps * rise;
}

function planter(out, x, z, w, d, y, p, { rim = p.rimH, depth = null } = {}) {
  const soil = depth ?? Math.max(0.02, rim - p.soilDrop);
  out.planters.push({ x, z, w, d, y, rim, depth: soil });
  if (rim > 0.02) {
    const t = p.rimT;
    out.covers.push(R(x, z - d / 2 + t / 2, w, t, y, rim), R(x, z + d / 2 - t / 2, w, t, y, rim));
    out.covers.push(R(x - w / 2 + t / 2, z, t, d - 2 * t, y, rim), R(x + w / 2 - t / 2, z, t, d - 2 * t, y, rim));
  }
}

function pool(out, x, z, w, d, y, p, curb = 0.15) {
  out.water.push({ x, z, w, d, y: y + 0.02 });
  if (curb > 0) {
    const t = 0.25;
    out.covers.push(R(x, z - d / 2 - t / 2, w + 2 * t, t, y, curb), R(x, z + d / 2 + t / 2, w + 2 * t, t, y, curb));
    out.covers.push(R(x - w / 2 - t / 2, z, t, d, y, curb), R(x + w / 2 + t / 2, z, t, d, y, curb));
  }
}

function lattice(out, x, z, w, d, y, pitch, bar = 0.12) {
  const nx = Math.round(w / pitch), nz = Math.round(d / pitch);
  for (let i = 0; i <= nx; i++) out.bars.push(R(x - w / 2 + (i * w) / nx, z, bar, d, y, bar));
  for (let j = 0; j <= nz; j++) out.bars.push(R(x, z - d / 2 + (j * d) / nz, w, bar, y + bar, bar));
  out.walls.push(R(x, z - d / 2, w + 0.6, 0.3, y - 0.3, 0.6), R(x, z + d / 2, w + 0.6, 0.3, y - 0.3, 0.6));
  out.walls.push(R(x - w / 2, z, 0.3, d, y - 0.3, 0.6), R(x + w / 2, z, 0.3, d, y - 0.3, 0.6));
}

function floorSlab(out, x, z, w, d) { out.walls.push(R(x, z, w, d, -0.3, 0.3)); }

// ---- kinds ----

export function buildAtrium(cx, cz, p, rng, out = makeOut()) {
  const W = p.atriumWell, D = p.atriumRing, S = W + 2 * D, L = p.atriumLevels, P = p.atriumPitch, t = p.wallT;
  const top = L * P + 0.6, F = p.lobbyFloor;
  floorSlab(out, cx, cz, S, S);
  out.walls.push(R(cx, cz, S - 2 * t, S - 2 * t, 0, F));
  for (let k = 1; k <= L; k++) {
    const y = k * P - p.slabT;
    out.walls.push(R(cx, cz - W / 2 - D / 2, S, D, y, p.slabT), R(cx, cz + W / 2 + D / 2, S, D, y, p.slabT));
    out.walls.push(R(cx - W / 2 - D / 2, cz, D, W, y, p.slabT), R(cx + W / 2 + D / 2, cz, D, W, y, p.slabT));
    const e = W / 2 + 0.1;
    out.walls.push(R(cx, cz - e, W + 0.4, 0.2, k * P, 1.1), R(cx, cz + e, W + 0.4, 0.2, k * P, 1.1));
    out.walls.push(R(cx - e, cz, 0.2, W, k * P, 1.1), R(cx + e, cz, 0.2, W, k * P, 1.1));
  }
  const n = Math.round(W / 5.2), c = 0.8, e = W / 2 + 0.6;
  for (let i = 0; i <= n; i++) {
    const s = -W / 2 + (i * W) / n;
    out.walls.push(R(cx + s, cz - e, c, c, 0, top), R(cx + s, cz + e, c, c, 0, top));
    if (i > 0 && i < n) out.walls.push(R(cx - e, cz + s, c, c, 0, top), R(cx + e, cz + s, c, c, 0, top));
  }
  const o = S / 2 - t / 2;
  wallRun(out, 'x', cz - o, cx - S / 2, cx + S / 2, t, top, 0);
  wallRun(out, 'x', cz + o, cx - S / 2, cx + S / 2, t, top, 0, { at: cx, w: 6, h: F + p.doorH });
  wallRun(out, 'z', cx - o, cz - S / 2 + t, cz + S / 2 - t, t, top, 0);
  wallRun(out, 'z', cx + o, cz - S / 2 + t, cz + S / 2 - t, t, top, 0, { at: cz, w: 3, h: F + 3.2 });
  lattice(out, cx, cz, S, S, top, p.atriumLattice);
  const path = 2.6, q = (W - path - 2 * 1.2) / 2, off = path / 2 + q / 2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    planter(out, cx + sx * off, cz + sz * off, q, q, F, p, { rim: 0.5 });
    out.covers.push(R(cx + sx * (path / 2 - 0.35), cz + sz * 3.2, 0.45, 1.6, F, 0.45));
  }
  out.spawn = [cx, F, cz];
  return finish(out, cx, cz);
}

export function buildLobby(cx, cz, p, rng, out = makeOut(), { roof = 'slab', backGap = null, eastGap = null, westGap = null } = {}) {
  const W = p.lobbyW, D = p.lobbyD, H = p.lobbyH, F = p.lobbyFloor, Q = p.lobbyPlaza, t = p.wallT;
  const x0 = cx - W / 2, x1 = cx + W / 2, z0 = cz - D / 2, z1 = cz + D / 2;
  const pz = cz + D / 2 - Q / 2 - 4;
  floorSlab(out, cx, cz, W, D);
  // Raised floor, inset to the wall inner faces so a hallway threshold can fill each doorway.
  const ix0 = x0 + t, ix1 = x1 - t, iz0 = z0 + t;
  out.walls.push(R((ix0 + ix1) / 2, (iz0 + pz - Q / 2) / 2, ix1 - ix0, pz - Q / 2 - iz0, 0, F));
  out.walls.push(R((ix0 + ix1) / 2, (pz + Q / 2 + z1) / 2, ix1 - ix0, z1 - pz - Q / 2, 0, F));
  out.walls.push(R((ix0 + cx - Q / 2) / 2, pz, cx - Q / 2 - ix0, Q, 0, F), R((cx + Q / 2 + ix1) / 2, pz, ix1 - cx - Q / 2, Q, 0, F));
  for (const sx of [-1, 1]) {
    out.covers.push(R(cx + sx * (Q / 2 - 0.3), pz - Q / 2 + 0.3, 0.55, 0.55, 0, 0.5), R(cx + sx * (Q / 2 - 0.3), pz + Q / 2 - 0.3, 0.55, 0.55, 0, 0.5));
    out.covers.push(R(cx + sx * (Q / 2 - 0.3), pz, 0.45, 2.4, 0, 0.42));
  }
  wallRun(out, 'x', z0 + t / 2, x0, x1, t, H, 0, backGap);
  wallRun(out, 'z', x0 + t / 2, z0 + t, z1, t, H, 0, westGap);
  wallRun(out, 'z', x1 - t / 2, z0 + t, z1, t, H, 0, eastGap);
  // Mezzanine along the back wall, high enough that the back doorway passes under it.
  const mz = p.lobbyMezz, md = 5, mt = 0.35, front = z0 + t + md, mezzTop = mz + mt;
  out.walls.push(R(cx, z0 + t + md / 2, W - 2 * t, md, mz, mt));
  // Stair: two straight flights and a landing, rising north to the mezzanine edge.
  const sx0 = cx + 5.5, sw = 3.2, steps = 24, rise = (mezzTop - F) / steps, tread = 0.3, landing = 1.6;
  const half = steps / 2, flightLen = half * tread, stairEnd = front + 2 * flightLen + landing;
  for (let k = 0; k < half; k++) out.covers.push(R(sx0, stairEnd - (k + 0.5) * tread, sw, tread, F, (k + 1) * rise));
  out.covers.push(R(sx0, front + flightLen + landing / 2, sw, landing, F, half * rise));
  for (let k = half; k < steps; k++) out.covers.push(R(sx0, front + flightLen - (k - half + 0.5) * tread, sw, tread, F, (k + 1) * rise));
  // Mezzanine rail with a gap over the stair head.
  const railY = mezzTop, gapA = sx0 - sw / 2 - 0.2, gapB = sx0 + sw / 2 + 0.2;
  for (const [a, b] of [[x0 + t, gapA], [gapB, x1 - t]]) {
    out.walls.push(R((a + b) / 2, front, b - a, 0.1, railY + 0.35, 0.12), R((a + b) / 2, front, b - a, 0.1, railY + 0.8, 0.12));
  }
  for (let i = 0; i < 6; i++) {
    const px = x0 + t + (i + 0.5) * (W - 2 * t) / 6;
    if (px > gapA && px < gapB) continue;
    out.walls.push(R(px, front, 0.12, 0.1, railY, 0.95));
  }
  planter(out, sx0 - 4.2, front + 1.6, 4.4, 3.2, F, p, { rim: 0.5 });
  planter(out, sx0 - 5.4, front + 4.6, 6.8, 2.8, F, p, { rim: 0.35 });
  planter(out, sx0 + 3.6, front + 2.2, 3.6, 4.4, F, p, { rim: 0.5 });
  planter(out, sx0 + 3.6, front + 6.6, 3.6, 3.6, F, p, { rim: 0.4 });
  planter(out, cx - 11.5, z1 - 4.5, 4.5, 3.2, F, p, { rim: 0.45 });
  for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) {
    const x = x0 + t + 4 + i * p.lobbyPierPitch, z = z0 + t + 4 + j * p.lobbyPierPitch;
    if (Math.abs(x - cx) < Q / 2 + 1.2 && Math.abs(z - pz) < Q / 2 + 1.2) continue;
    if (Math.abs(x - sx0) < sw / 2 + 1.2 && z > front - 0.5 && z < stairEnd + 0.5) continue;
    out.walls.push(R(x, z, 1.0, 1.0, 0, H));
  }
  if (roof === 'lattice') lattice(out, cx, cz, W, D, H, p.atriumLattice);
  else {
    out.walls.push(R(cx, cz, W, D, H, p.slabT));
    const bd = 0.55, bw = 0.35, nb = Math.round(W / p.lobbyBeamPitch), nd = Math.round(D / p.lobbyBeamPitch);
    for (let i = 1; i < nb; i++) out.walls.push(R(x0 + (i * W) / nb, cz, bw, D, H - bd, bd));
    for (let j = 1; j < nd; j++) out.walls.push(R(cx, z0 + (j * D) / nd, W, bw, H - bd, bd));
  }
  out.spawn = [cx, 0, pz];
  return finish(out, cx, cz);
}

export function buildPergola(cx, cz, p, rng, out = makeOut()) {
  const H = p.pergolaWallH, t = 0.6, F = p.lobbyFloor;
  floorSlab(out, cx + 1.5, cz, 27, 22);
  // Plinth at the shared floor level, from the west wall's inner face to the stair foot.
  out.walls.push(R((cx - 12 + t / 2 + cx + 4) / 2, cz, 16 - t / 2, 20 - t, 0, F));
  wallRun(out, 'z', cx - 12, cz - 10, cz + 10, t, H, 0, { at: cz + 5, w: 2.4, h: F + p.doorH });
  wallRun(out, 'x', cz - 10, cx - 12, cx + 4, t, H, 0);
  out.walls.push(R(cx - 4, cz - 6.5, 16.6, 7, 6.2, 0.6));
  const ph = p.pergolaH;
  for (const px of [cx - 6, cx + 2]) for (const pz of [cz - 1, cz + 6]) out.bars.push(R(px, pz, 0.3, 0.3, F, ph - F));
  out.walls.push(R(cx - 2, cz - 1, 8.6, 0.3, ph, 0.3), R(cx - 2, cz + 6, 8.6, 0.3, ph, 0.3));
  const ns = Math.round(8 / p.pergolaSlatPitch);
  for (let i = 0; i <= ns; i++) out.walls.push(R(cx - 6 + (i * 8) / ns, cz + 2.5, 0.12, 7.6, ph + 0.3, 0.12));
  for (const [za, zb] of [[cz - 9, cz - 2.6], [cz + 6.6, cz + 9.6]]) {
    const nf = Math.max(1, Math.round((zb - za) / p.pergolaFinPitch));
    for (let i = 0; i <= nf; i++) out.walls.push(R(cx + 3.6, za + (i * (zb - za)) / nf, 0.8, 0.2, 0, H));
  }
  const steps = 10, rise = (p.terraceRise - F) / steps, tread = 0.32;
  stair(out, { x: cx + 4, z: cz + 2, width: 8, along: 'x', dir: 1, steps, rise, tread, y: F });
  out.walls.push(R(cx + 4 + steps * tread + 3.4, cz, 6.8, 20, 0, p.terraceRise));
  out.walls.push(R(cx + 4 + steps * tread + 6.7, cz, 0.2, 20, p.terraceRise, 1.0));
  planter(out, cx - 9, cz + 6, 4.9, 8, F, p, { rim: 0.08, depth: 0.05 });
  pool(out, cx - 9, cz - 3.6, 4.9, 10.4, F, p, 0.1);
  out.spawn = [cx - 2, F, cz + 2.5];
  return finish(out, cx, cz);
}

// axis 'x' builds the garden along z and reflects it across the diagonal through (cx, cz), so
// the walkway ends up at z = cz + 0.6 and the end wall, if any, at the west end.
// `extra` is how far each end's threshold runs past the garden's end, north then south, so a
// hallway's threshold reaches the inner face of the room wall it lands in.
export function buildSlotGarden(cx, cz, p, rng, out = makeOut(), { openSouth = true, endWall = true, length = p.slotLen, axis = 'z', extra = [0, 0] } = {}) {
  const local = makeOut();
  const H = p.slotWallH, G = p.slotGap, Lz = length, t = 0.7, F = p.lobbyFloor;
  floorSlab(local, cx, cz, G + 2 * t, Lz);
  const [eN, eS] = extra;
  local.walls.push(R(cx, cz - Lz / 2 + (1 - eN) / 2, G, 1 + eN, 0, F), R(cx, cz + Lz / 2 - (1 - eS) / 2, G, 1 + eS, 0, F));
  local.walls.push(R(cx - G / 2 - t / 2, cz, t, Lz, 0, H), R(cx + G / 2 + t / 2, cz, t, Lz, 0, H));
  if (endWall) wallRun(local, 'x', cz - Lz / 2 + t / 2, cx - G / 2 - t, cx + G / 2 + t, t, H, 0, { at: cx + 1.5, w: 1.6, h: H });
  local.walls.push(R(cx, cz + Lz / 2 - 2, G + 2 * t, 4, H - 2.5, 2.5));
  local.walls.push(R(cx, cz - Lz / 2 + 2, G + 2 * t, 4, H - 2, 2));
  const wx = cx + 0.6;
  local.walls.push(R(wx, cz, p.slotWalk, Lz - 2, F - 0.3, 0.3));
  slotGardenInterior(local, cx, cz, p, G, Lz, wx);
  local.spawn = [wx, 0.45, cz + Lz / 2 - 2];
  if (axis === 'x') reflectDiagonal(local, cx, cz);
  merge(out, local);
  out.spawn = local.spawn;
  return finish(out, cx, cz);
}

function slotGardenInterior(out, cx, cz, p, G, Lz, wx) {
  const pw = wx - p.slotWalk / 2 - 0.15 - (cx - G / 2);
  pool(out, cx - G / 2 + pw / 2, cz, pw, Lz - 2, 0, p, 0);
  const rx = cx - G / 2 + 1.5;
  out.covers.push(R(rx, cz - 6, 1.2, 0.9, 0, 0.8), R(rx + 0.9, cz - 5.2, 0.8, 0.7, 0, 0.55), R(rx + 0.4, cz + 7, 1.4, 1.0, 0, 0.7));
  const bw = cx + G / 2 - (wx + p.slotWalk / 2 + 0.15);
  planter(out, cx + G / 2 - bw / 2, cz, bw, Lz - 2, 0, p, { rim: 0, depth: 0.3 });
}

function reflectDiagonal(out, cx, cz) {
  const flip = (r) => { const x = cx + (r.z - cz), z = cz + (r.x - cx); r.x = x; r.z = z; const w = r.w; r.w = r.d; r.d = w; };
  for (const k of ['walls', 'covers', 'bars', 'planters', 'water']) for (const r of out[k]) flip(r);
  if (out.spawn) out.spawn = [cx + (out.spawn[2] - cz), out.spawn[1], cz + (out.spawn[0] - cx)];
}

export function buildPavilion(cx, cz, p, rng, out = makeOut(), { backGap = { at: -4, w: 4, h: 3.2 }, apron = true } = {}) {
  const W = p.pavDeckW, D = p.pavDeckD, H = p.pavRoofH, t = p.wallT;
  if (apron) floorSlab(out, cx, cz, W + 10, D + p.pavPondD + 6);
  else floorSlab(out, cx, cz + (p.pavPondD + 3 + t / 2) / 2, W + 10, D + p.pavPondD + 3 - t / 2);
  out.walls.push(R(cx, cz, W, D, 0, 0.6));
  wallRun(out, 'x', cz - D / 2 + t / 2, cx - W / 2, cx + W / 2, t, H, 0, backGap ? { ...backGap, at: cx + backGap.at } : null);
  out.walls.push(R(cx, cz + 0.5, W + 4, D + 3, H, 0.8));
  out.walls.push(R(cx + 2, cz + 1, 0.8, 0.8, 0.6, H - 0.6));
  out.walls.push(R(cx + 4.5, cz - 2, 13, 6, H + 0.8, 4));
  const sx = cx + W / 2 - 0.25, rows = Math.floor(H / 0.5), cols = Math.floor(D / 0.9);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    out.walls.push(R(sx, cz - D / 2 + 0.45 + c * 0.9, 0.5, 0.6, r * 0.5, 0.3));
  }
  out.walls.push(R(sx, cz, 0.5, D, rows * 0.5, H - rows * 0.5 + 0.01));
  pool(out, cx, cz + D / 2 + p.pavPondD / 2, W + 8, p.pavPondD, 0, p, 0.12);
  out.walls.push(R(cx - 6, cz + D / 2 + p.pavPondD / 2, 2.6, p.pavPondD + 0.5, 0.35, 0.25));
  out.spawn = [cx - 2, 0.6, cz];
  return finish(out, cx, cz);
}

// The spawn area: slot garden (north) into the lobby under a lattice, out through the pavilion
// and over its pond into the world (south).
export function buildSpawn(cx, cz, p, rng, out = makeOut()) {
  const lobbyBack = cz - p.lobbyD / 2;
  buildSlotGarden(cx, lobbyBack - p.slotLen / 2 + 0.2, p, rng, out, { openSouth: true });
  const lobby = makeOut();
  buildLobby(cx, cz, p, rng, lobby, { roof: 'lattice', backGap: { at: cx + 0.6, w: 2.4, h: 4.2 } });
  merge(out, lobby);
  buildPavilion(cx, cz + p.lobbyD / 2 + p.pavDeckD / 2 - 0.25, p, rng, out, { backGap: { at: 0, w: 5, h: 3.4 }, apron: false });
  out.spawn = lobby.spawn;
  return finish(out, cx, cz);
}

// One building: atrium north, a slot-garden hallway down into the lobby, a second hallway east
// to the pergola court, and the pavilion with its pond off the lobby's open south side.
export function buildComplex(cx, cz, p, rng, out = makeOut()) {
  const S = p.atriumWell + 2 * p.atriumRing;
  const z0 = cz - p.lobbyD / 2, x1 = cx + p.lobbyW / 2;
  const hallN = p.hallNorth, hallE = p.hallEast, walkZ = cz + 2;
  buildAtrium(cx, z0 + 0.2 - hallN - S / 2, p, rng, out);
  // Each hallway overlaps 0.2 m into the room walls it meets; the thresholds run on to the inner faces.
  buildSlotGarden(cx, z0 + 0.2 - hallN / 2, p, rng, out, { endWall: false, length: hallN, extra: [p.wallT - 0.2, p.wallT - 0.2] });
  const lobby = makeOut();
  buildLobby(cx, cz, p, rng, lobby, {
    roof: 'lattice',
    backGap: { at: cx + 0.6, w: 2.4, h: 4.2 },
    eastGap: { at: walkZ, w: 2.4, h: 4.2 },
  });
  merge(out, lobby);
  buildSlotGarden(x1 - 0.2 + hallE / 2, walkZ - 0.6, p, rng, out, { endWall: false, length: hallE, axis: 'x', extra: [p.wallT - 0.2, 0.6 - 0.2] });
  buildPergola(x1 - 0.2 + hallE + 12.3, walkZ - 5, p, rng, out);
  buildPavilion(cx, cz + p.lobbyD / 2 + p.pavDeckD / 2 - 0.25, p, rng, out, { backGap: { at: 0, w: 5, h: 3.4 }, apron: false });
  out.spawn = lobby.spawn;
  return finish(out, cx, cz);
}

function merge(a, b) { for (const k of ['walls', 'covers', 'bars', 'planters', 'water']) a[k].push(...b[k]); return a; }

function finish(out, cx, cz) {
  let r = 0;
  for (const list of [out.walls, out.covers, out.bars]) for (const b of list) {
    r = Math.max(r, Math.hypot(Math.abs(b.x - cx) + b.w / 2, Math.abs(b.z - cz) + b.d / 2));
  }
  out.radius = r;
  return out;
}

const BUILDERS = { complex: buildComplex, spawn: buildSpawn, atrium: buildAtrium, lobby: buildLobby, pergola: buildPergola, slotgarden: buildSlotGarden, pavilion: buildPavilion };

export function generateEco(kind, params = {}, seed = 1, { x = 0, z = 0 } = {}) {
  const build = BUILDERS[kind];
  if (!build) throw new Error(`unknown eco kind ${kind}`);
  return build(x, z, { ...ECO_DEFAULTS, ...params }, makeRng(seed));
}

// Soil top at (x, z) if inside a planter, else null. The viewer's ground callback for flora.
export function soilTopAt(planters, x, z) {
  for (const q of planters) {
    if (Math.abs(x - q.x) <= q.w / 2 - 0.06 && Math.abs(z - q.z) <= q.d / 2 - 0.06) return q.y + q.depth;
  }
  return null;
}
