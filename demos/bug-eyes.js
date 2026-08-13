/**
 * Fifteen eyes for `sdf-bug-v2.html`.
 *
 * Twelve are shading only: they read the eyeball's surface normal, which the field already produced, and
 * cost no extra distance evaluations. Three change the field. `EYE_STYLES` is the running order and the
 * index IS the uniform value, so the dropdown, the shader branches and the tests all agree by
 * construction. The techniques are written up in `demos/README.md`.
 */
import {
  vec2, vec3, float, If, Fn,
  normalize, dot, cross, length, min, max, abs, clamp, mix, smoothstep, step, sign, fract, floor,
  sqrt, sin, cos, acos, pow, exp, posterize, mx_atan2, mx_hsvtorgb, mx_fractal_noise_float, fwidth,
} from 'three/tsl';
import { createEyeMath } from './bug-eye-math.js';

const EM = createEyeMath({ vec2, vec3, float, atan2: mx_atan2 });

/**
 * The twelve appearances. Running order, and the index IS the uniform value.
 *
 * Appearance only: none of these changes the geometry, so any of them combines with any of the mounts
 * below. That separation was not the first design — the three mounts were dropdown entries alongside
 * these, which forced a choice between having a stalk and having any of the twelve looks on it. They are
 * different questions and are now asked separately.
 */
export const EYE_STYLES = [
  { key: 'bead',     label: 'Glossy bead (original)' },
  { key: 'compound', label: 'Compound / ommatidia' },
  { key: 'pseudo',   label: 'Pseudopupil' },
  { key: 'iris',     label: 'Iris with parallax' },
  { key: 'slit',     label: 'Slit pupil' },
  { key: 'toon',     label: 'Toon' },
  { key: 'irid',     label: 'Iridescent film' },
  { key: 'milky',    label: 'Milky / blind' },
  { key: 'sensor',   label: 'Glowing sensor' },
  { key: 'aperture', label: 'Mechanical aperture' },
  { key: 'matcap',   label: 'Matcap' },
  { key: 'wet',      label: 'Wet meniscus' },
];

/**
 * The three structural modifiers, each an independent 0/1 flag. All eight combinations are legal and all
 * eight compose with all twelve styles, so there are 96 eyes rather than 15.
 *
 * `cost` is what switching one on adds to the march, which is the only reason they are separated from the
 * styles at all.
 */
export const EYE_MODIFIERS = [
  { key: 'stalk',  label: 'Stalked mount',   cost: 'two extra segment evaluations' },
  { key: 'ocelli', label: 'Ocelli cluster',  cost: 'one sphere, whatever the count, because the domain folds' },
  { key: 'gem',    label: 'Cut-gem facets',  cost: 'five max operations, no extra march steps' },
];

export const STYLE_INDEX = Object.fromEntries(EYE_STYLES.map((s, i) => [s.key, i]));
export const MODIFIER_KEYS = EYE_MODIFIERS.map((m) => m.key);

/** How far along the eye's own forward axis a stalk carries the eyeball, in authored units. */
export const STALK_REACH = 0.20;
/** Ring radius and count for the ocelli cluster. Checked against each other in the test. */
export const OCELLI = { count: 6, ring: 0.055, radius: 0.020, centre: 0.026, fitFraction: 0.80 };

/**
 * The largest ocellus that still fits inside its own wedge, which is what keeps the folded field a
 * distance. At the authored radius it holds to 8 eyes and fails at 9, and the count is a slider that goes
 * to 10, so the radius is derived from the count rather than fixed.
 */
export function ocellusRadius(count, eyeSizeValue = 1) {
  const half = OCELLI.ring * Math.sin(Math.PI / count);
  return Math.min(OCELLI.radius * eyeSizeValue, half * OCELLI.fitFraction);
}
/** Cut-gem plane normals, in the eye's own frame. */
export const GEM_PLANES = [
  [0.0, 0.0, 1.0], [0.0, 0.72, 0.69], [0.0, -0.72, 0.69], [0.68, 0.35, 0.64], [-0.68, 0.35, 0.64],
];

const _hash2 = (p) => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453));

/**
 * @param {object} o
 * @param {{at: number[], r: number}} o.EYE - the authored eyeball, shared with the page's field code.
 */
export function createBugEyes({ EYE }) {
  if (!EYE?.at || typeof EYE.r !== 'number') throw new Error('createBugEyes needs { EYE: { at, r } }');

  /**
   * Reject missing arguments loudly.
   *
   * TSL builds a graph out of `undefined` without complaining, so a forgotten argument produced a shader
   * that compiled and drew nonsense — and a test asserting "the graph builds" passed on the strength of
   * it. This is what makes that assertion mean something.
   */
  const need = (args, names, where) => {
    const missing = names.filter((n) => args[n] === undefined || args[n] === null);
    if (missing.length) throw new Error(`${where} is missing: ${missing.join(', ')}`);
  };
  const MOUNT_ARGS = ['eyeSize', 'stalkOn', 'stalkLen', 'ocelliOn', 'ocelliCount'];

  /** Where the eyeball is mounted. Only the stalk moves it, and it is a flag, not a style. */
  const eyeCentre = (side, bob, stalkOn, stalkLen) => {
    const base = vec3(side.mul(EYE.at[0]), float(EYE.at[1]).add(bob), float(EYE.at[2]));
    const basis = EM.eyeBasis(side);
    const centre = EM.mountCentre(base, basis.fwd, stalkOn, stalkLen, float(STALK_REACH));
    return { centre, base, basis };
  };

  /**
   * The ONE seam between the field and the shading: which eyeball a point belongs to, and how big it is.
   *
   * Both halves call this, so a mount can never move the geometry without also moving the highlights that
   * sit on it. `rel` is the offset from whichever eyeball is nearest — the folded one when the cluster is
   * on — which is exactly what every appearance needs and all any of them asks for.
   */
  const eyeLocal = (args) => {
    need(args, ['p', 'side', 'bob', ...MOUNT_ARGS], 'eyeLocal');
    const { p, side, bob, eyeSize, stalkOn, stalkLen, ocelliOn, ocelliCount } = args;
    const { centre, base, basis } = eyeCentre(side, bob, stalkOn, stalkLen);
    const radius = float(EYE.r).mul(eyeSize);

    const relPlain = p.sub(centre);
    // The fold is about the mounted centre, so a cluster rides the stalk instead of staying on the face.
    const folded = EM.ocelliFold(p.sub(centre), basis, ocelliCount);
    const seat = basis.right.mul(OCELLI.ring).add(basis.fwd.mul(OCELLI.centre));
    // The same fit as `ocellusRadius`: an ocellus wider than its wedge bleeds into its neighbour and the
    // folded field then reports less than the true distance.
    const fit = float(OCELLI.ring).mul(sin(float(Math.PI).div(ocelliCount))).mul(OCELLI.fitFraction);
    const ocelliR = min(float(OCELLI.radius).mul(eyeSize), fit);

    return {
      basis, centre, base, radius, ocelliR, seat,
      rel: EM.lerp(relPlain, folded.sub(seat), ocelliOn),
      r: EM.lerp(radius, ocelliR, ocelliOn),
      relPlain,
    };
  };

  /**
   * The eyeball's distance, with the three mounts composed in a fixed order: mount moves the centre, the
   * cluster folds the domain about it, the cuts apply to whatever eyeball that produced, and the shaft is
   * unioned on last. Every combination is a legal SDF — `min` is exact for a union and `max` never
   * overshoots for an intersection, so sphere tracing stays safe.
   */
  const eyeDistance = (args) => {
    need(args, ['pm', 'side', 'bob', 'gemOn', ...MOUNT_ARGS], 'eyeDistance');
    const { pm, side, bob, eyeSize, stalkOn, stalkLen, ocelliOn, ocelliCount, gemOn } = args;
    const L = eyeLocal({ p: pm, side, bob, eyeSize, stalkOn, stalkLen, ocelliOn, ocelliCount });
    const d = length(L.rel).sub(L.r).toVar();

    // Cut gem: intersecting half-spaces, applied to each eyeball the fold produced.
    If(gemOn.greaterThan(0.5), () => {
      const cut = d.toVar();
      for (const n of GEM_PLANES) {
        const nn = L.basis.right.mul(n[0]).add(L.basis.up.mul(n[1])).add(L.basis.fwd.mul(n[2]));
        cut.assign(max(cut, dot(L.rel, normalize(nn)).sub(L.r.mul(0.82))));
      }
      d.assign(cut);
    });

    // The cluster keeps one larger eye in the middle of the ring.
    If(ocelliOn.greaterThan(0.5), () => {
      d.assign(min(d, length(L.relPlain).sub(L.radius.mul(0.52))));
    });

    // Stalked: a tapered shaft from the face out to wherever the eyeball ended up.
    If(stalkOn.greaterThan(0.5), () => {
      const ab = L.centre.sub(L.base);
      const t = clamp(dot(pm.sub(L.base), ab).div(max(dot(ab, ab), float(1e-9))), 0, 1);
      const onAxis = L.base.add(ab.mul(t));
      const shaftR = mix(L.radius.mul(0.34), L.radius.mul(0.52), t);
      d.assign(min(d, length(pm.sub(onAxis)).sub(shaftR)));
    });

    return d;
  };

  /**
   * The eye's colour, replacing whatever the general shading produced.
   *
   * Everything is in AUTHORED space: the bands are angles measured from a centre that is authored there,
   * so a world-space point against it collapses them to a constant. `rdA` and `LA` are the view and key
   * directions rotated into the same frame, which a rotation leaves the dot products of unchanged.
   */
  const eyeStyleBodies = (args) => {
    need(args, [
      'pA', 'rdA', 'LA', 'nA', 'bob', 'side', 'style', 'sh', 'time', 'bounceCol',
      'gemOn', 'tint', 'gloss', 'pupil', 'facets', ...MOUNT_ARGS,
    ], 'eyeColour');
    const {
      pA, rdA, LA, nA, bob, side, style, eyeSize, sh, time, bounceCol,
      stalkOn, stalkLen, ocelliOn, ocelliCount, gemOn,
      tint, gloss, pupil, facets,
    } = args;
    const L = eyeLocal({ p: pA, side, bob, eyeSize, stalkOn, stalkLen, ocelliOn, ocelliCount });
    const { basis } = L;
    const radius = L.r;

    // The cluster shades each folded eye separately, which falls out of sharing `eyeLocal` with the field.
    // For a cut gem the analytic sphere normal is WRONG — the surface is flat there — so the field's own
    // normal is used instead, and every style's highlights land on the facets rather than on a ghost
    // sphere. `gemOn` being 0 or 1 makes the lerp an exact selection.
    const enSphere = normalize(L.rel);
    const en = normalize(EM.lerp(enSphere, nA, gemOn));
    const disc = EM.angularDisc(en, basis);
    const facing = clamp(dot(en, rdA.negate()), 0, 1);
    const halfway = normalize(LA.sub(rdA));
    // 1 - the original. Two fixed bands plus the leaf's bounce, unchanged from the shipped bead.
    const glintA = normalize(vec3(-0.42, 0.62, 0.66));
    const glintB = normalize(vec3(0.55, -0.30, 0.78));
    const bead = vec3(0.014, 0.013, 0.019).toVar();
    bead.addAssign(vec3(2.4, 2.35, 2.2).mul(smoothstep(float(0.968), float(0.994), dot(en, glintA))));
    bead.addAssign(vec3(0.22, 0.26, 0.30).mul(smoothstep(float(0.72), float(0.99), dot(en, glintA))));
    bead.addAssign(vec3(0.30, 0.44, 0.16).mul(smoothstep(float(0.80), float(0.995), dot(en, glintB))));
    bead.addAssign(bounceCol.mul(pow(clamp(float(1).add(dot(rdA, en)), 0, 1), float(2.0))).mul(1.1));

    // Each appearance is a NAMED FUNCTION that the branch merely calls, not an inline If body.
    // If callbacks are stored and replayed during the shader build, never run at construction, so an
    // inline body is unreachable from Node and cannot be tested at all — three separate canaries passed
    // against code that was never executed. Called by name they run for real, while the shader keeps the
    // cheap single branch.
    const bodies = {};
    bodies.bead = () => bead;
    // 4 and 5 - the iris, seen through a refracting cornea so it shifts as the camera moves.
    const irisLike = (aniso) => {
      const hit = EM.irisPlaneHit(en, rdA, basis, radius, radius.mul(0.55), float(1 / 1.38));
      const q = vec2(hit.q.x.div(aniso), hit.q.y);
      const r = length(q).div(max(radius, float(1e-5)));
      const pupilR = pupil.mul(0.9);
      const inPupil = smoothstep(pupilR, pupilR.add(0.06), r).oneMinus();
      // Radial fibres, and rings that read as the iris' depth.
      const th = mx_atan2(q.y, q.x);
      const fibre = sin(th.mul(38.0)).mul(0.5).add(0.5).mul(smoothstep(pupilR, float(1.0), r));
      const ring = sin(r.mul(26.0)).mul(0.5).add(0.5);
      const iris = tint.mul(fibre.mul(0.45).add(0.55)).mul(ring.mul(0.22).add(0.82));
      const sclera = vec3(0.62, 0.60, 0.56).mul(max(dot(en, LA), float(0)).mul(0.6).add(0.4));
      const body = mix(iris, sclera, smoothstep(float(0.95), float(1.25), r));
      const withPupil = mix(body, vec3(0.008, 0.008, 0.010), inPupil);
      // The corneal glint sits on the OUTER surface, so it uses the surface normal, not the iris plane.
      const cornea = pow(max(dot(en, halfway), float(0)), float(220.0)).mul(gloss).mul(1.6).mul(sh);
      return withPupil.mul(hit.ok.mul(0.85).add(0.15)).add(vec3(cornea));
    };
    bodies.iris = () => irisLike(float(1.0));
    // The same iris with an anisotropic pupil radius, which is all a slit pupil is.
    bodies.slit = () => irisLike(float(0.34));

    // 2 - compound. A hex lattice in equal-angle coordinates, so facets compress toward the rim.
    bodies.compound = () => {
      const cell = EM.hexCell(disc.q.mul(facets));
      // Each facet is a flat lens pointing down its own cell's axis, which is what splits the highlight.
      const cq = cell.id.mul(vec2(EM.HEX_S[0], EM.HEX_S[1])).div(facets);
      const ca = length(cq).min(1.55);
      const cdir = cq.div(max(length(cq), float(1e-6)));
      const facetN = basis.fwd.mul(cos(ca))
        .add(basis.right.mul(cdir.x.mul(sin(ca))))
        .add(basis.up.mul(cdir.y.mul(sin(ca))));
      const jitter = _hash2(cell.id).mul(0.34).add(0.66);
      const lens = pow(max(dot(facetN, halfway), float(0)), float(48.0)).mul(gloss).mul(sh);
      const body = tint.mul(jitter).mul(max(dot(facetN, LA), float(0)).mul(0.7).add(0.3));
      const border = smoothstep(float(0), float(0.10), cell.edge);
      // The dark spot that seems to follow the camera: the facets aimed at you show you their own shadow.
      const pseudo = smoothstep(float(0.90), float(0.999), facing).mul(0.85);
      return (body.mul(border).mul(float(1).sub(pseudo)).add(vec3(lens).mul(border)));
    };

    // 3 - pseudopupil alone, on a plain amber eye. One dot product for the whole effect.
    bodies.pseudo = () => {
      const spot = smoothstep(float(0.86), float(0.999), facing);
      const body = tint.mul(max(dot(en, LA), float(0)).mul(0.65).add(0.35));
      const glint = pow(max(dot(en, halfway), float(0)), float(90.0)).mul(gloss).mul(sh);
      return (mix(body, vec3(0.01, 0.008, 0.006), spot).add(vec3(glint)));
    };

    // 6 - toon. Quantised light and HARD edges, because a soft cel shade is not a cel shade.
    bodies.toon = () => {
      const band = posterize(max(dot(en, LA), float(0)), float(3.0));
      const body = tint.mul(band.mul(0.55).add(0.45));
      const hi = step(float(0.986), dot(en, glintA));
      const rim = step(float(0.55), float(1).sub(facing)).mul(0.35);
      return (mix(body, vec3(0.02), rim).add(vec3(1.0, 0.98, 0.94).mul(hi)));
    };

    // 7 - iridescent film. Hue from the view angle, which is what thin-film interference does.
    bodies.irid = () => {
      const bands = pow(float(1).sub(facing), float(1.4)).mul(3.2).add(time.mul(0.05));
      const film = mx_hsvtorgb(vec3(fract(bands), float(0.72), float(1.0)));
      const shade = max(dot(en, LA), float(0)).mul(0.55).add(0.30);
      const glint = pow(max(dot(en, halfway), float(0)), float(120.0)).mul(gloss).mul(sh);
      return (vec3(0.02, 0.02, 0.03).add(film.mul(shade).mul(gloss.mul(0.5).add(0.6))).add(vec3(glint)));
    };

    // 8 - milky. Cloud in the field rather than a texture, and almost no specular: that reads as blind.
    bodies.milky = () => {
      const cloud = mx_fractal_noise_float(en.mul(5.5), 3, 2.0, 0.5, 1.0).mul(0.5).add(0.5);
      const wrap = dot(en, LA).mul(0.5).add(0.5);
      const body = mix(vec3(0.34, 0.35, 0.33), vec3(0.72, 0.74, 0.70), cloud);
      return (body.mul(wrap.mul(0.7).add(0.45)).add(vec3(0.06, 0.07, 0.08).mul(float(1).sub(facing))));
    };

    // 9 - sensor. Written HDR so the depth-of-field gather blooms it into real bokeh for free.
    bodies.sensor = () => {
      const core = smoothstep(pupil.mul(1.4), float(0.0), disc.phi);
      const halo = smoothstep(float(1.2), float(0.0), disc.phi).mul(0.22);
      const bezel = smoothstep(float(0.9), float(1.25), disc.phi);
      const glow = tint.mul(core.mul(6.0).add(halo).mul(gloss.mul(1.6).add(0.4)));
      return (mix(glow, vec3(0.02, 0.02, 0.025), bezel));
    };

    // 10 - mechanical aperture. Rings, blades folded from the azimuth, and an iris that breathes.
    bodies.aperture = () => {
      const r = disc.phi.div(1.45);
      const blades = clamp(floor(facets), float(4.0), float(12.0));
      const sector = float(Math.PI * 2).div(blades);
      const th = mx_atan2(disc.q.y, disc.q.x);
      const fold = abs(th.sub(sector.mul(floor(th.div(sector)).add(0.5))));
      const apR = mix(pupil.mul(0.6), pupil.mul(1.5), sin(time.mul(0.7)).mul(0.5).add(0.5));
      // A blade's straight edge is a constant distance in the folded frame, not a constant radius.
      const blade = r.mul(cos(fold)).sub(apR);
      const rings = sin(r.mul(34.0)).mul(0.5).add(0.5).mul(0.18);
      const metal = vec3(0.30, 0.31, 0.34).mul(rings.add(0.72))
        .mul(max(dot(en, LA), float(0)).mul(0.7).add(0.35));
      const spec = pow(max(dot(en, halfway), float(0)), float(70.0)).mul(gloss).mul(sh);
      return (mix(vec3(0.006, 0.006, 0.008), metal.add(vec3(spec)), smoothstep(float(0), float(0.02), blade)));
    };

    // 11 - matcap. The frame is built from the view direction, so the highlight never leaves the camera.
    bodies.matcap = () => {
      const vr = normalize(cross(basis.up, rdA));
      const vu = cross(rdA, vr);
      const m = vec2(dot(en, vr), dot(en, vu));
      const lobe = smoothstep(float(0.95), float(0.15), length(m.sub(vec2(-0.42, 0.46))));
      const fillLobe = smoothstep(float(1.30), float(0.30), length(m.sub(vec2(0.35, -0.30))));
      const rim = smoothstep(float(0.72), float(1.0), length(m));
      const body = tint.mul(fillLobe.mul(0.5).add(0.18)).add(vec3(1.0, 0.98, 0.93).mul(pow(lobe, float(2.4)).mul(gloss)));
      return (body.add(vec3(0.35, 0.42, 0.30).mul(rim).mul(0.5)));
    };

    // 12 - wet meniscus. A screen-width arc, so it stays a hairline at any resolution or zoom.
    bodies.wet = () => {
      const upness = dot(en, basis.up);
      // fwidth of a raymarched quantity blows up at silhouettes, so the width has an object-space floor.
      const w = max(fwidth(upness).mul(1.5), float(0.012));
      const arc = smoothstep(w, float(0), abs(upness.sub(0.62))).mul(smoothstep(float(-0.1), float(0.25), facing));
      return (bead.add(vec3(1.0, 0.99, 0.96).mul(arc).mul(gloss.mul(1.2).add(0.4))));
    };

    // The three mounts need no branch of their own: they reach every style through `eyeLocal` and `en`.
    // A cluster shades each folded eye separately, a stalk carries the highlights out with the eyeball,
    // and a cut gem swaps in the field's flat normal, so all twelve appearances work on all eight mounts.

    return bodies;
  };

  /**
   * The eye's colour: pick one appearance and evaluate only that one.
   *
   * The branch is on a uniform, so every lane in the draw takes the same path and a twelve-way dropdown
   * costs one style — the same argument the page already makes for `u.quality`. The bodies themselves are
   * named functions rather than inline `If` callbacks, because a callback is stored and replayed during
   * the shader build and can therefore never be reached from a test.
   */
  const eyeColour = (args) => {
    const bodies = eyeStyleBodies(args);
    const out = vec3(0).toVar();
    out.assign(bodies.bead());
    for (const [i, st] of EYE_STYLES.entries()) {
      if (i === 0) continue;   // the bead is the fall-through, so it needs no branch
      If(args.style.sub(i).abs().lessThan(0.5), () => { out.assign(bodies[st.key]()); });
    }
    return out;
  };

  return {
    eyeColour, eyeStyleBodies, eyeDistance, eyeCentre, eyeLocal,
    EYE_STYLES, EYE_MODIFIERS, STYLE_INDEX,
  };
}
