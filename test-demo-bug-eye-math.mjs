/**
 * The eye maths, run on plain numbers.
 *
 * `demos/bug-eye-math.js` is written in method-chaining style against four injected constructors, so the
 * shim below hands it real numbers and the same source that runs on the GPU runs here. No twin to keep in
 * sync, and the parts whose bugs are invisible in a still frame get checked arithmetically.
 */
import { createEyeMath } from './demos/bug-eye-math.js';

let pass = 0, fail = 0;
const ok = (cond, label, why) => {
  if (cond) { pass++; } else { fail++; console.log(`  FAIL ${label}${why ? '\n        ' + why : ''}`); }
};
const near = (a, b, tol, label) => ok(Math.abs(a - b) <= tol, label, `got ${a}, wanted ${b} +/- ${tol}`);
const section = (t) => console.log('\n' + t);

// ---------------------------------------------------------------------------------------------------
// The shim. Every method here exists on a TSL node with the same meaning, INCLUDING the reordered ones:
// `x.step(edge)` is `step(edge, x)`, so `a.step(b)` reads "a >= b". Getting that backwards is silent.
// ---------------------------------------------------------------------------------------------------
const raw = (v) => (v instanceof S || v instanceof V ? v.v : v);

class S {
  constructor(v) { this.v = v; }
  add(o) { return new S(this.v + raw(o)); }
  sub(o) { return new S(this.v - raw(o)); }
  mul(o) { return new S(this.v * raw(o)); }
  div(o) { return new S(this.v / raw(o)); }
  negate() { return new S(-this.v); }
  oneMinus() { return new S(1 - this.v); }
  abs() { return new S(Math.abs(this.v)); }
  floor() { return new S(Math.floor(this.v)); }
  sqrt() { return new S(Math.sqrt(this.v)); }
  sin() { return new S(Math.sin(this.v)); }
  cos() { return new S(Math.cos(this.v)); }
  acos() { return new S(Math.acos(this.v)); }
  max(o) { return new S(Math.max(this.v, raw(o))); }
  min(o) { return new S(Math.min(this.v, raw(o))); }
  clamp(lo, hi) { return new S(Math.min(Math.max(this.v, raw(lo)), raw(hi))); }
  step(edge) { return new S(this.v >= raw(edge) ? 1 : 0); }
}

class V {
  constructor(v) { this.v = v; }
  get x() { return new S(this.v[0]); }
  get y() { return new S(this.v[1]); }
  get z() { return new S(this.v[2]); }
  #zip(o, f) {
    const b = raw(o);
    return new V(this.v.map((a, i) => f(a, Array.isArray(b) ? b[i] : b)));
  }
  add(o) { return this.#zip(o, (a, b) => a + b); }
  sub(o) { return this.#zip(o, (a, b) => a - b); }
  mul(o) { return this.#zip(o, (a, b) => a * b); }
  div(o) { return this.#zip(o, (a, b) => a / b); }
  abs() { return new V(this.v.map(Math.abs)); }
  floor() { return new V(this.v.map(Math.floor)); }
  negate() { return new V(this.v.map((a) => -a)); }
  dot(o) { const b = raw(o); return new S(this.v.reduce((s, a, i) => s + a * b[i], 0)); }
  length() { return new S(Math.hypot(...this.v)); }
  normalize() { const l = Math.hypot(...this.v) || 1; return new V(this.v.map((a) => a / l)); }
  cross(o) {
    const [a, b, c] = this.v, [d, e, f] = raw(o);
    return new V([b * f - c * e, c * d - a * f, a * e - b * d]);
  }
}

const shim = {
  vec2: (x, y) => new V([raw(x), raw(y)]),
  vec3: (x, y, z) => (Array.isArray(raw(x)) ? new V(raw(x).slice()) : new V([raw(x), raw(y), raw(z)])),
  float: (x) => new S(raw(x)),
  atan2: (y, x) => new S(Math.atan2(raw(y), raw(x))),
};
const M = createEyeMath(shim);
const v2 = shim.vec2, v3 = shim.vec3, f = shim.float;

// ---------------------------------------------------------------------------------------------------
section('1. the shim itself, because a wrong shim would quietly pass everything');
near(f(3).sub(1).mul(2).v, 4, 0, 'scalar chain');
near(f(0.5).step(0.4).v, 1, 0, 'a.step(b) is a >= b');
near(f(0.3).step(0.4).v, 0, 0, 'and 0 otherwise');
near(v2(3, 4).length().v, 5, 1e-12, 'vec2 length');
near(v3(1, 0, 0).cross(v3(0, 1, 0)).v[2], 1, 1e-12, 'right-handed cross');
near(v2(7.3, -1.2).floor().v[0], 7, 0, 'floor down');
near(v2(7.3, -1.2).floor().v[1], -2, 0, 'and floor of a negative goes down, not toward zero');

// ---------------------------------------------------------------------------------------------------
section('1b. the style predicate, which was inverted when first written');
{
  // `x.step(edge)` is `step(edge, x)`, so the natural-looking `|d|.step(0.5)` selects every style EXCEPT
  // the one intended. Both uses shipped that way round and every graph-building test still passed, because
  // the shader compiles either way — it just applies the wrong style. Hence a numeric check per index.
  for (let want = 0; want < 15; want++) {
    let wrong = [];
    for (let have = 0; have < 15; have++) {
      const got = M.isStyle(f(have), f(want)).v;
      const expect = have === want ? 1 : 0;
      if (got !== expect) wrong.push(`style ${have} gave ${got}`);
    }
    ok(wrong.length === 0, `isStyle picks out ${want} and nothing else`, wrong.join(', '));
  }
  ok(M.isStyle(f(3), f(3)).v === 1, 'a match is 1, not 0');
  ok(M.isStyle(f(3), f(4)).v === 0, 'and its neighbour is 0, not 1');
  // Half-integer noise must not straddle two styles.
  ok(M.isStyle(f(3.4), f(3)).v === 1 && M.isStyle(f(3.6), f(3)).v === 0,
    'the 0.5 window does not overlap the next style');
}

// ---------------------------------------------------------------------------------------------------
section('2. the eye basis is orthonormal on both sides');
for (const side of [-1, 1]) {
  const b = M.eyeBasis(f(side));
  near(b.fwd.length().v, 1, 1e-9, `side ${side}: fwd is unit`);
  near(b.up.length().v, 1, 1e-9, `side ${side}: up is unit`);
  near(b.right.length().v, 1, 1e-9, `side ${side}: right is unit`);
  near(b.fwd.dot(b.up).v, 0, 1e-9, `side ${side}: fwd . up`);
  near(b.fwd.dot(b.right).v, 0, 1e-9, `side ${side}: fwd . right`);
  near(b.up.dot(b.right).v, 0, 1e-9, `side ${side}: up . right`);
  ok(b.up.v[1] > 0, `side ${side}: up actually points up`);
  ok(Math.sign(b.fwd.v[0]) === side, `side ${side}: fwd leans to its own side of the head`);
  ok(b.fwd.v[2] > 0, `side ${side}: fwd looks forward, not back into the skull`);
}

// ---------------------------------------------------------------------------------------------------
section('3. the angular disc');
{
  const b = M.eyeBasis(f(1));
  const atFwd = M.angularDisc(b.fwd, b);
  near(atFwd.phi.v, 0, 1e-7, 'looking straight down the axis gives angle 0');
  near(atFwd.q.length().v, 0, 1e-5, 'and lands on the origin rather than dividing by zero');

  // A normal tilted by a known angle must come back with exactly that angle.
  for (const deg of [5, 22, 60, 89]) {
    const rad = (deg * Math.PI) / 180;
    const en = b.fwd.mul(Math.cos(rad)).add(b.right.mul(Math.sin(rad)));
    const d = M.angularDisc(en, b);
    near(d.phi.v, rad, 1e-7, `${deg} deg tilt round-trips`);
    near(d.q.v[0], rad, 1e-6, `${deg} deg tilt lands on the +right axis`);
    near(d.q.v[1], 0, 1e-6, `${deg} deg tilt has no up component`);
  }
  // Equal angles must give equal radii whatever the bearing: that is what "equidistant" has to mean.
  const radii = [0, 1, 2, 3, 4, 5].map((k) => {
    const th = (k / 6) * Math.PI * 2, rad = 0.7;
    const en = b.fwd.mul(Math.cos(rad))
      .add(b.right.mul(Math.sin(rad) * Math.cos(th)))
      .add(b.up.mul(Math.sin(rad) * Math.sin(th)));
    return M.angularDisc(en, b).q.length().v;
  });
  ok(Math.max(...radii) - Math.min(...radii) < 1e-6, 'the projection is isotropic',
    `radii spread ${(Math.max(...radii) - Math.min(...radii)).toExponential(2)}`);
}

// ---------------------------------------------------------------------------------------------------
section('4. the hex grid tiles without gaps or overlaps');
{
  // Every sample must land in SOME cell with a non-negative edge distance. A negative edge distance means
  // the point is outside the hexagon the lookup claims it is in, which is the failure mode that shows up
  // as a grid of cracks.
  let worstEdge = 1, cells = new Map(), samples = 0;
  for (let i = 0; i < 120; i++) {
    for (let j = 0; j < 120; j++) {
      const p = v2(-3 + (i / 120) * 6, -3 + (j / 120) * 6);
      const c = M.hexCell(p);
      worstEdge = Math.min(worstEdge, c.edge.v);
      const key = `${c.id.v[0].toFixed(4)},${c.id.v[1].toFixed(4)}`;
      cells.set(key, (cells.get(key) || 0) + 1);
      samples++;
    }
  }
  ok(worstEdge >= -1e-9, 'no sample falls outside its own hexagon',
    `worst edge distance ${worstEdge.toExponential(3)}`);
  ok(cells.size > 30, `the sweep covered many cells (${cells.size})`);

  // Equal cell areas, judged only on cells the sample box fully contains — cells clipped by the edge of
  // the sweep hold fewer samples for a reason that has nothing to do with the lattice.
  const interior = [];
  for (const [key, n] of cells) {
    const [cx, cy] = key.split(',').map(Number);
    if (Math.abs(cx) < 1.6 && Math.abs(cy) < 1.6) interior.push(n);
  }
  interior.sort((a, b) => a - b);
  const spread = interior[interior.length - 1] / interior[0];
  ok(interior.length > 15 && spread < 1.15, `the ${interior.length} interior cells are of equal area`,
    `population ratio ${spread.toFixed(3)}`);
  // The lattice area per cell is 1 x sqrt(3) / 2 = 0.8660, which is the area of a hexagon of INRADIUS 0.5
  // (2*sqrt(3)*r^2), not of circumradius 0.5. That is what fixes the scale of `edge`.
  near((1 * Math.sqrt(3)) / 2, 2 * Math.sqrt(3) * 0.25, 1e-12, 'lattice area per cell matches inradius 0.5');

  // Sampled finely enough to actually cross borders, the id must change sometimes and hold most of the time.
  let flips = 0, steps = 0;
  let prev = M.hexCell(v2(-2, 0.31));
  for (let i = 1; i <= 4000; i++) {
    const c = M.hexCell(v2(-2 + (i / 4000) * 4, 0.31));
    if (c.id.v[0] !== prev.id.v[0] || c.id.v[1] !== prev.id.v[1]) flips++;
    prev = c; steps++;
  }
  ok(flips >= 4 && flips <= 12, 'a 4-unit traverse crosses a handful of cells, as a unit lattice must',
    `${flips} id changes in ${steps} steps`);

  // The centre of a cell must be the farthest point from its edges, and the vertex must sit on one.
  const c0 = M.hexCell(v2(0.02, 0.03));
  ok(c0.edge.v > 0.4, 'a point near a centre is far from every edge', `edge ${c0.edge.v.toFixed(3)}`);
  // Straight up from a centre, the border is the VERTEX at 1/sqrt(3) — measured, not assumed.
  near(M.hexCell(v2(0.5, 0.8660254 + 1 / Math.sqrt(3) - 1e-4)).edge.v, 0.0, 2e-4,
    'the vertex above a centre sits on a border');
  near(M.hexCell(v2(0.5 + 0.5 - 1e-4, 0.8660254)).edge.v, 0.0, 2e-4,
    'and so does the flat edge beside it, at the inradius');
}

// ---------------------------------------------------------------------------------------------------
section('5. the refracted iris');
{
  const b = M.eyeBasis(f(1));
  const R = 0.086, depth = 0.05, eta = 1 / 1.38;

  // Straight on, down the axis: the bent ray must not bend at all, and must land dead centre.
  {
    const en = b.fwd, rd = b.fwd.negate();
    const h = M.irisPlaneHit(en, rd, b, f(R), f(depth), f(eta));
    near(h.ok.v, 1, 0, 'an axial ray reaches the plane');
    near(h.r.v, 0, 1e-7, 'and lands on the pupil centre');
  }
  // Off axis: the hit must move off centre, and it must move LESS than an unrefracted ray would.
  {
    const rad = 0.5;
    const en = b.fwd.mul(Math.cos(rad)).add(b.right.mul(Math.sin(rad)));
    const rd = b.fwd.negate();
    const h = M.irisPlaneHit(en, rd, b, f(R), f(depth), f(eta));
    ok(h.ok.v === 1, 'an off-axis ray still reaches the plane');
    ok(h.r.v > 1e-4, 'and lands off the pupil centre', `r ${h.r.v}`);
    const straight = M.irisPlaneHit(en, rd, b, f(R), f(depth), f(1.0));
    ok(h.r.v < straight.r.v, 'refraction pulls the hit inward compared with no refraction',
      `refracted ${h.r.v.toFixed(4)} vs straight ${straight.r.v.toFixed(4)}`);
  }
  // The parallax claim itself: moving the camera must move the iris under a FIXED surface point.
  {
    const rad = 0.35;
    const en = b.fwd.mul(Math.cos(rad)).add(b.up.mul(Math.sin(rad)));
    const seen = [];
    for (const tilt of [-0.3, 0, 0.3]) {
      const rd = b.fwd.negate().mul(Math.cos(tilt)).add(b.right.mul(Math.sin(tilt))).normalize();
      const h = M.irisPlaneHit(en, rd, b, f(R), f(depth), f(eta));
      seen.push(h.q.v[0]);
    }
    const swing = Math.max(...seen) - Math.min(...seen);
    ok(swing > 1e-3, 'the iris shifts as the view moves, which is the whole point of refracting',
      `swing ${swing.toExponential(2)}`);
    ok(seen[0] < seen[1] && seen[1] < seen[2], 'and shifts monotonically with the view angle');
  }
  // A grazing ray must be reported as a miss rather than dividing by a near-zero denominator.
  {
    const en = b.right, rd = b.fwd.negate();
    const h = M.irisPlaneHit(en, rd, b, f(R), f(depth), f(eta));
    ok(Number.isFinite(h.r.v), 'a grazing ray still produces a finite number', `r ${h.r.v}`);
  }
}

// ---------------------------------------------------------------------------------------------------
section('6. the ocelli fold');
{
  const b = M.eyeBasis(f(1));
  const N = 6, ringR = 0.05;
  // N points spread round the ring must all fold onto the SAME place. That is the saving: one primitive,
  // seen N times.
  const folded = [];
  for (let k = 0; k < N; k++) {
    const th = (k / N) * Math.PI * 2;
    const rel = b.right.mul(ringR * Math.cos(th)).add(b.up.mul(ringR * Math.sin(th)));
    folded.push(M.ocelliFold(rel, b, f(N)));
  }
  const first = folded[0].v;
  let worst = 0;
  for (const g of folded) worst = Math.max(worst, Math.hypot(g.v[0] - first[0], g.v[1] - first[1], g.v[2] - first[2]));
  ok(worst < 1e-9, `all ${N} ring positions fold to one point`, `worst disagreement ${worst.toExponential(2)}`);

  // The fold must preserve distance from the eye centre, or the folded field is not a distance any more.
  for (const [rr, aa] of [[0.03, 0.4], [0.08, 2.1], [0.12, -1.7]]) {
    const rel = b.right.mul(rr * Math.cos(aa)).add(b.up.mul(rr * Math.sin(aa))).add(b.fwd.mul(0.02));
    const g = M.ocelliFold(rel, b, f(N));
    near(g.length().v, rel.length().v, 1e-9, `fold preserves radius at r=${rr}`);
  }
  // Off-axis component must survive too.
  {
    const rel = b.fwd.mul(0.07).add(b.right.mul(0.02));
    const g = M.ocelliFold(rel, b, f(N));
    near(g.dot(b.fwd).v, 0.07, 1e-9, 'the along-axis component is untouched');
  }
  // A wedge must be wide enough to hold its ocellus, or neighbours bleed and the field lies.
  {
    const sector = (Math.PI * 2) / N;
    const halfWidth = ringR * Math.sin(sector / 2);
    ok(halfWidth > 0.02, `a ${N}-fold ring at r=${ringR} leaves ${(halfWidth * 1000).toFixed(1)}mm of half-wedge`,
      'an ocellus wider than this would cross into its neighbour and the fold would no longer be a distance');
  }
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
