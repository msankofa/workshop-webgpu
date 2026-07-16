// Validates the phase-2 cover vocabulary (shoot-house-pieces.js): each piece emits well-formed boxes
// with known materials, a dark body + an emissive accent, and honors the `accent` override.
import { holoBarrier, lightPillar, halfWallBaffle, holoPlatform, portalDoor, PIECES } from './shoot-house-pieces.js';
import { MATERIALS } from './shoot-house-style.js';

let fail = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fail++; };

const wellFormed = (prims) => prims.every(p =>
  ['kind', 'material', 'cx', 'cy', 'cz', 'sx', 'sy', 'sz'].every(k => k in p) &&
  p.sx > 0 && p.sy > 0 && p.sz > 0 && Number.isFinite(p.cx + p.cy + p.cz));
const knownMats = (prims) => prims.every(p => p.material in MATERIALS);
const emissive = (prims) => prims.some(p => MATERIALS[p.material]?.em);
const bodyOf = (prims) => prims.find(p => !MATERIALS[p.material]?.em);
const top = (p) => p.cy + p.sy / 2;

// ---- registry ----
ok(Object.keys(PIECES).length === 5, 'PIECES registry has all 5 pieces');
ok(['holoBarrier', 'lightPillar', 'halfWallBaffle', 'holoPlatform', 'portalDoor'].every(k => typeof PIECES[k] === 'function'), 'each registry entry is a function');

// ---- holo-barrier ----
{
  const p = holoBarrier({ cx: 2, cz: -1, orient: 'x', len: 3, h: 1.1 });
  ok(wellFormed(p) && knownMats(p), 'barrier: well-formed, known materials');
  ok(emissive(p) && p.some(b => b.material === 'cover'), 'barrier: dark cover body + emissive lip');
  const body = bodyOf(p), lip = p.find(b => MATERIALS[b.material]?.em);
  ok(Math.abs(body.sx - 3) < 1e-6 && Math.abs(top(body) - 1.1) < 1e-6, 'barrier: body length + chest height correct');
  ok(top(lip) > top(body), 'barrier: lip sits on top of the body');
}

// ---- light-pillar ----
{
  const p = lightPillar({ cx: -3, cz: 2, H: 4 });
  ok(wellFormed(p) && knownMats(p), 'pillar: well-formed, known materials');
  const body = bodyOf(p);
  ok(Math.abs(top(body) - 4) < 1e-6, 'pillar: body is full wall height');
  ok(p.filter(b => MATERIALS[b.material]?.em).length === 4, 'pillar: four vertical neon strips');
}

// ---- half-wall baffle ----
{
  const p = halfWallBaffle({ cx: 0, cz: 0, orient: 'z', len: 3.2 });
  ok(wellFormed(p) && knownMats(p), 'baffle: well-formed, known materials');
  const body = bodyOf(p);
  ok(top(body) > 1.3, 'baffle: taller than vault height (cannot be vaulted)');
  ok(Math.abs(body.sz - 3.2) < 1e-6, 'baffle: length along z correct');
  ok(p.filter(b => MATERIALS[b.material]?.em).length === 2, 'baffle: emissive seam on each end');
}

// ---- holo-platform ----
{
  const p = holoPlatform({ cx: 0, cz: 5, w: 6, d: 4, access: 'front' });
  ok(wellFormed(p) && knownMats(p), 'platform: well-formed, known materials');
  ok(p.some(b => b.material === 'deck' && b.kind === 'platform'), 'platform: has a deck slab');
  ok(p.some(b => b.kind === 'step'), 'platform: has an access ramp of steps');
  ok(p.some(b => b.kind === 'railing'), 'platform: has railing');
  const deck = p.find(b => b.kind === 'platform');
  // access edge (front / -z) must be railing-free so the ramp can meet the deck
  const frontRail = p.some(b => b.kind === 'railing' && b.cz < deck.cz - deck.sz / 2 + 0.2);
  ok(!frontRail, 'platform: no railing on the open access edge');
  // an overwatch deck must clear player head height (1.8) — you climb up to look DOWN, not stand level
  ok(deck.cy + deck.sy / 2 > 1.8, 'platform: deck top clears player standing height (real vantage)');
  // and its underside should clear a standing player so they can pass beneath it (mezzanine feel)
  ok(deck.cy - deck.sy / 2 > 1.8, 'platform: underside is walkable beneath (deck floats above head)');
}

// ---- portal door ----
{
  const p = portalDoor({ along: 'x', facePos: -6, cx: 0, doorW: 2.7, doorH: 3.6 });
  ok(wellFormed(p) && knownMats(p), 'portal: well-formed, known materials');
  ok(p.length === 3 && p.every(b => MATERIALS[b.material]?.em), 'portal: three emissive frame members (2 jambs + header)');
  ok(p.every(b => Math.abs(b.cz - -6) < 1e-6), 'portal: frame sits on the given face plane');
}

// ---- accent override threads through ----
{
  const p = holoBarrier({ cx: 0, cz: 0, accent: 'placard' });
  ok(p.some(b => b.material === 'placard'), 'accent override swaps the emissive material key');
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
