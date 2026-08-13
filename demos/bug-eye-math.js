/**
 * The eye styles' pure geometry, written ONCE for two backends.
 *
 * Everything here is expressed with method chaining and four injected constructors, so the same source
 * runs on TSL nodes in the browser and on plain numbers in Node. That is the point of the file: this repo
 * already carries three hand-synced CPU/GPU twins (`forest-cull.js`, `light-cluster.js`, `post-grade.js`)
 * and a fourth was not worth adding for maths whose bugs are invisible in a still frame. See
 * `demos/README.md` for what each function is for.
 */

/** Hex lattice spacing: one unit across, sqrt(3) up. */
const HEX_S = [1.0, 1.7320508075688772];
/** Unit normal of a hex's slanted edge, so the edge distance is one dot product. */
const HEX_N = [0.5, 0.8660254037844386];

/**
 * @param {object} ctor - `{ vec2, vec3, float, atan2 }` from TSL, or the numeric shim used by the tests.
 */
export function createEyeMath({ vec2, vec3, float, atan2 }) {
  if (!vec2 || !vec3 || !float || !atan2) throw new Error('createEyeMath needs { vec2, vec3, float, atan2 }');

  const S = () => vec2(HEX_S[0], HEX_S[1]);

  /** Positive modulo, by methods only. */
  const fmod = (x, y) => x.sub(y.mul(x.div(y).floor()));

  /** Component-wise lerp that works for scalars and vectors alike. */
  const lerp = (a, b, t) => a.add(b.sub(a).mul(t));

  /**
   * 1 when `style` names `index`, 0 otherwise.
   *
   * Here rather than inline because the chained comparison is REORDERED: `x.step(edge)` is
   * `step(edge, x)`, so `d.step(0.5)` reads "d >= 0.5" and selects every style EXCEPT the one meant. Both
   * uses of this were written that way round first, and no graph-building test can see it — the shader
   * still compiles, it just applies the wrong style. So the predicate lives where numbers can check it.
   */
  const isStyle = (style, index) => float(0.5).step(style.sub(index).abs());

  /**
   * Where the eyeball is mounted: on the face, or out at the end of a stalk.
   *
   * `on` is a 0/1 flag rather than a style index, because the mount is INDEPENDENT of the appearance —
   * a stalked eye can be any of the twelve. Kept here so the flag's sense is checked on numbers; a
   * reversed flag would mount the stalk on the other fourteen combinations and look deliberate.
   */
  const mountCentre = (base, fwd, on, len, reach) => lerp(base, base.add(fwd.mul(len.mul(reach))), on);

  /**
   * The eye's own frame: `fwd` points out of the face, so the pupil lands where a pupil belongs and the
   * azimuth seam falls on the back of the eyeball where it cannot be seen.
   *
   * `side` is -1 or +1 and may be a node, which is why the basis is built rather than tabulated.
   */
  function eyeBasis(side) {
    const fwd = vec3(side.mul(0.55), float(0.10), float(0.83)).normalize();
    // Gram-Schmidt against world up. The eye never points straight up, so no degenerate case exists.
    const up = vec3(0, 1, 0).sub(fwd.mul(fwd.dot(vec3(0, 1, 0)))).normalize();
    const right = up.cross(fwd);
    return { fwd, right, up };
  }

  /**
   * Azimuthal equidistant projection of the eye's surface normal: an angle from `fwd`, carried out along
   * the bearing it came from.
   *
   * Equal-angle rather than equal-area on purpose. A pattern laid out in these coordinates compresses
   * toward the eye's rim exactly the way a real eye's facets do, whereas one laid out in the tangent
   * plane would keep them the same size on screen all the way to the silhouette.
   */
  function angularDisc(en, basis) {
    const phi = en.dot(basis.fwd).clamp(-1, 1).acos();
    const bearing = vec2(en.dot(basis.right), en.dot(basis.up));
    // Guarded: at phi = 0 the bearing is 0/0, and the answer there is the origin either way.
    const len = bearing.length().max(1e-6);
    const q = bearing.div(len).mul(phi);
    return { phi, q, r: phi };
  }

  /**
   * Which hexagon of a unit lattice a point falls in.
   *
   * Two offset square lattices, keeping whichever candidate centre is nearer — the standard trick, and
   * cheaper than the 27-cell loop `mx_worley_noise_vec3` runs, which returns sorted distances and so
   * cannot name the cell a point belongs to anyway.
   *
   * @returns `{ local, id, edge }` - offset from the cell's centre, the cell's integer-ish name, and the
   *   distance to the nearest cell edge (0 at a border, 0.5 at the centre).
   */
  function hexCell(p) {
    const s = S();
    const idA = p.div(s).floor().add(0.5);
    const localA = p.sub(idA.mul(s));
    const idB = p.sub(vec2(0.5, 1.0)).div(s).floor().add(0.5);
    const localB = p.sub(idB.add(0.5).mul(s));

    const dA = localA.dot(localA);
    const dB = localB.dot(localB);
    // 1 when A is the nearer centre. `step(edge, x)` is x >= edge, so this is dB >= dA.
    const pickA = dB.step(dA);

    const local = lerp(localB, localA, pickA);
    const id = lerp(idB.add(0.5), idA, pickA);

    const a = local.abs();
    const edge = float(0.5).sub(a.dot(vec2(HEX_N[0], HEX_N[1])).max(a.x));
    return { local, id, edge };
  }

  /**
   * Where the view ray ends up after bending at the cornea, in the eye's own frame.
   *
   * Snell's law spelled out rather than GLSL's `refract`, so the one expression serves both backends.
   * This is what buys an iris that shifts under the cornea as the camera moves, with no extra geometry
   * and no second distance evaluation.
   *
   * @param en - outward surface normal, unit. @param rd - view direction, unit, pointing into the surface.
   * @param radius - the eyeball's radius. @param depth - how far behind the centre the iris plane sits.
   * @param eta - ratio of refractive indices, about 1/1.38 for a cornea.
   * @returns `{ q, r, ok }` - iris-plane coordinates, radius from the pupil, and 0 when the bent ray
   *   never reaches the plane.
   */
  function irisPlaneHit(en, rd, basis, radius, depth, eta) {
    const cosI = rd.dot(en).negate();
    const sinT2 = eta.mul(eta).mul(float(1).sub(cosI.mul(cosI)));
    const cosT = float(1).sub(sinT2).max(0).sqrt();
    const bent = rd.mul(eta).add(en.mul(eta.mul(cosI).sub(cosT)));

    const alongFwd = bent.dot(basis.fwd);
    const start = en.mul(radius);
    // Only rays travelling backwards reach the plane; the floor keeps the divide finite for the rest.
    const ok = alongFwd.negate().step(1e-3);
    const t = depth.negate().sub(start.dot(basis.fwd)).div(alongFwd.min(-1e-3));
    const hit = start.add(bent.mul(t));
    const q = vec2(hit.dot(basis.right), hit.dot(basis.up));
    return { q, r: q.length(), ok, bent };
  }

  /**
   * Fold a point into one wedge of an N-fold ring about the eye's forward axis.
   *
   * This is what makes a spider's eye cluster cost one sphere evaluation instead of N: the field is
   * asked about a point rotated into a single canonical sector, so one primitive is seen N times. It is
   * only a valid distance for primitives that stay inside their own wedge, which is why the ring radius
   * and the ocellus radius are checked against each other in the test.
   */
  function ocelliFold(rel, basis, count) {
    const along = rel.dot(basis.fwd);
    const x = rel.dot(basis.right);
    const y = rel.dot(basis.up);
    const radial = vec2(x, y).length();

    const sector = float(Math.PI * 2).div(count);
    const a = atan2(y, x);
    const folded = fmod(a.add(sector.mul(0.5)), sector).sub(sector.mul(0.5));

    const perp = basis.right.mul(folded.cos()).add(basis.up.mul(folded.sin()));
    return perp.mul(radial).add(basis.fwd.mul(along));
  }

  return {
    eyeBasis, angularDisc, hexCell, irisPlaneHit, ocelliFold, mountCentre,
    lerp, fmod, isStyle, HEX_S, HEX_N,
  };
}
