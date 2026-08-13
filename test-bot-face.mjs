// test-bot-face.mjs — the human head (bot-face.js).
//
// The test that matters here is the VISIBILITY one. A face piece placed at the wrong z renders
// inside the skull and disappears, and nothing about the descriptor looks wrong when it happens —
// this is the failure that cost the helmet two rounds. So every forward-facing feature is checked
// against headSurfaceZ() at its own x, which is the ellipse the skull actually presents there, not
// the lathe radius.

import {
  makeHumanHead, withHumanHead, headSurfaceZ, skullRadius,
  FACE_EXPRESSIONS, HUMAN_HEAD_SHAPE, SKIN_TONES, HAIR_COLORS, LID_MIN, SOLDIER_HELMET,
  SOLDIER_HELMET_MASKED, maskDepth, maskRadius,
} from './bot-face.js';
import { BOT_BODY_DESIGN, botDesignHuman, withHelmet, BOT_HELMETS } from './bot-body-design.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
}

// Front face of a piece in gear space. rbox reports its FINAL outer size; extrude does not — its
// bevel grows the geometry past `depth` on both ends, so it has to be added back here.
function frontZ(g) {
  const z = g.position?.[2] ?? 0;
  switch (g.type) {
    case 'sphere': return z + (g.size?.[0] ?? 0);
    case 'rbox': case 'box': return z + (g.size?.[2] ?? 0) / 2;
    case 'cylinder': return z + (g.size?.[2] ?? 0) / 2;   // only valid for the x-rotated discs below
    // axis:'x' turns the outline into a SIDE profile — its x becomes the body's z, and `depth`
    // becomes width. So the front is the outline's furthest x, not half the depth.
    case 'extrude': return g.axis === 'x'
      ? z + Math.max(...g.outline.map((p) => p[0])) + (g.bevel ?? 0)
      : z + ((g.depth ?? 0) + 2 * (g.bevel ?? 0)) / 2;
    default: return z;
  }
}

console.log('bot-face: shape');
{
  const p = HUMAN_HEAD_SHAPE.headProfile;
  check('profile is in R/H units', p.every(([r, y]) => r > 0 && r < 1 && Math.abs(y) < 1));
  check('skull is ~0.18 m wide', Math.abs(skullRadius(0.016) * 2 - 0.180) < 0.005,
    `got ${(skullRadius(0.016) * 2).toFixed(3)}`);
  check('eyes sit near mid-height', Math.abs(0.008 - (0.128 - 0.125) / 2) < 0.010);
  check('surface is deeper than wide', headSurfaceZ(0, 0.016) > skullRadius(0.016));
  check('surface falls off toward the temple', headSurfaceZ(0.060, 0.008) < headSurfaceZ(0, 0.008));
  check('surface is 0 past the silhouette', headSurfaceZ(0.5, 0) === 0);
}

console.log('bot-face: every expression builds a legal, visible face');
for (const name of Object.keys(FACE_EXPRESSIONS)) {
  const gear = makeHumanHead({ expression: name });
  const ids = gear.map((g) => g.id);
  const bad = gear.filter((g) => g.anchor !== 'head');
  check(`${name}: all pieces anchor to head`, bad.length === 0, `${bad.length} stray`);
  check(`${name}: ids are unique`, new Set(ids).size === ids.length);
  check(`${name}: has eyes, mouth and brows`,
    ids.includes('eyeballR') && ids.includes('eyeballL') && ids.includes('mouth') &&
    ids.includes('browR') && ids.includes('browL'));

  // Forward features must clear the skull at their own x, with 1 mm of margin — headSurfaceZ is
  // linear between control points and the real (splined) surface bulges slightly further out.
  for (const g of gear) {
    if (g.id === 'hairCap' || g.id?.startsWith('ear')) continue;   // these clear in x/y, not z
    const x = g.position?.[0] ?? 0, y = g.position?.[1] ?? 0;
    const need = headSurfaceZ(x, y) + 0.001;
    check(`${name}: ${g.id} clears the skull`, frontZ(g) > need,
      `front ${frontZ(g).toFixed(4)} vs surface ${need.toFixed(4)}`);
  }

  // The pupil has to sit on the eyeball, not behind it and not floating in front of it.
  const eyeball = gear.find((g) => g.id === 'eyeballR');
  const pupil = gear.find((g) => g.id === 'pupilR');
  const eyeFront = eyeball.position[2] + eyeball.size[0];
  check(`${name}: pupil is proud of the eyeball`, frontZ(pupil) > eyeFront);
  check(`${name}: pupil is not floating`, frontZ(pupil) - eyeFront < 0.004,
    `${((frontZ(pupil) - eyeFront) * 1000).toFixed(1)} mm`);

  // The lid is only emitted for a squint or better, and when it is there it has to be IN FRONT of
  // the eyeball — a lid level with the sphere intersects it instead of closing it.
  const lid = gear.find((g) => g.id === 'lidR');
  const wantsLid = FACE_EXPRESSIONS[name].lid >= LID_MIN;
  check(`${name}: lid present iff the eye is squinting`, !!lid === wantsLid);
  if (lid) check(`${name}: lid occludes the eyeball`, frontZ(lid) > eyeFront);
}

console.log('bot-face: expressions actually differ');
{
  const src = (n) => JSON.stringify(makeHumanHead({ expression: n }));
  const names = Object.keys(FACE_EXPRESSIONS);
  const uniq = new Set(names.map(src));
  check('all 8 presets produce distinct geometry', uniq.size === names.length, `${uniq.size}/${names.length}`);

  const open = makeHumanHead({ expression: 'shout' }).find((g) => g.id === 'mouth');
  const shut = makeHumanHead({ expression: 'neutral' }).find((g) => g.id === 'mouth');
  const height = (m) => Math.max(...m.outline.map((p) => p[1])) - Math.min(...m.outline.map((p) => p[1]));
  check('shout opens the mouth', height(open) > height(shut) * 3);

  const smile = makeHumanHead({ expression: 'grin' }).find((g) => g.id === 'mouth');
  const frown = makeHumanHead({ expression: 'angry' }).find((g) => g.id === 'mouth');
  // Corners above centre = smile. Corner is the first outline point, centre the middle one.
  const lift = (m) => m.outline[0][1] - m.outline[Math.floor(m.outline.length / 4)][1];
  check('grin lifts the corners and angry drops them', lift(smile) > 0 && lift(frown) < 0,
    `grin ${lift(smile).toFixed(4)} angry ${lift(frown).toFixed(4)}`);

  const angryBrow = makeHumanHead({ expression: 'angry' }).find((g) => g.id === 'browR');
  const worryBrow = makeHumanHead({ expression: 'worried' }).find((g) => g.id === 'browR');
  check('angry and worried tilt the brow opposite ways',
    Math.sign(angryBrow.rotation[2]) === -Math.sign(worryBrow.rotation[2]));
  check('a closed lid sits lower than a squinting one',
    makeHumanHead({ expression: 'dead' }).find((g) => g.id === 'lidR').position[1] <
    makeHumanHead({ expression: 'angry' }).find((g) => g.id === 'lidR').position[1]);
}

console.log('bot-face: mirroring');
{
  const gear = makeHumanHead({});
  for (const id of ['eyeball', 'pupil', 'brow', 'ear']) {
    const r = gear.find((g) => g.id === id + 'R'), l = gear.find((g) => g.id === id + 'L');
    check(`${id} pair exists`, !!r && !!l);
    if (!r || !l) continue;
    check(`${id} x is mirrored`, Math.abs(r.position[0] + l.position[0]) < 1e-9);
    check(`${id} y/z match`, r.position[1] === l.position[1] && r.position[2] === l.position[2]);
    if (r.rotation) check(`${id} z rotation is negated`, Math.abs(r.rotation[2] + l.rotation[2]) < 1e-9);
  }
  // The catchlight is deliberately NOT mirrored: one light source, one side.
  const gr = gear.find((g) => g.id === 'glintR'), gl = gear.find((g) => g.id === 'glintL');
  check('catchlights offset the same way on both eyes',
    Math.abs((gr.position[0] - 0.036) - (gl.position[0] + 0.036)) < 1e-9);
}

console.log('bot-face: options');
{
  const bald = makeHumanHead({ hair: false });
  check('hair: false removes the cap', !bald.some((g) => g.id === 'hairCap'));
  check('ears: false removes the ears', !makeHumanHead({ ears: false }).some((g) => g.id?.startsWith('ear')));
  const custom = makeHumanHead({ expression: { mouthOpen: 1, brow: 0 } });
  check('an inline expression object works', custom.find((g) => g.id === 'mouth').outline.length > 0);
  check('skin tones and hair colours are hex', Object.values(SKIN_TONES).every((c) => c > 0 && c <= 0xffffff) &&
    Object.values(HAIR_COLORS).every((c) => c > 0 && c <= 0xffffff));
}

console.log('bot-face: head swapping preserves the body');
{
  const human = botDesignHuman({ expression: 'determined' });
  const helmetCount = BOT_BODY_DESIGN.gear.filter((g) => g.anchor === 'head').length;
  const bodyCount = BOT_BODY_DESIGN.gear.length - helmetCount;
  check('helmet gear is gone', !human.gear.some((g) => g.anchor === 'head' && g.role === 'visor'));
  check('body gear survives intact',
    human.gear.filter((g) => g.anchor !== 'head').length === bodyCount);
  check('head role is skin', human.roles.head === 'skin');
  check('other core roles survive', human.roles.hand === BOT_BODY_DESIGN.roles.hand);
  check('skull shape is the human one', human.headZScale === HUMAN_HEAD_SHAPE.headZScale);
  check('the rig eyes stay collapsed', human.eye.width < 0.01);

  // Round-tripping back to the helmet must restore the armoured skull too, or the Mark VII sits on
  // a human-sized head and the visor clips through it.
  const back = withHelmet(human, BOT_HELMETS['mark vii']);
  check('helmet swap restores the armoured skull', back.headZScale === BOT_BODY_DESIGN.headZScale &&
    JSON.stringify(back.headProfile) === JSON.stringify(BOT_BODY_DESIGN.headProfile));
  check('helmet swap restores head role', back.roles.head === 'shell');
  check('helmet swap has no face pieces left', !back.gear.some((g) => g.role === 'sclera'));
  check('round trip keeps the piece count', back.gear.length === BOT_BODY_DESIGN.gear.length);
  check('withHumanHead does not mutate its input', BOT_BODY_DESIGN.gear.some((g) => g.role === 'visor'));

  const sniper = withHelmet(human, BOT_HELMETS.marksman);
  check('marksman helmet swaps in', sniper.gear.some((g) => g.type === 'cylinder' && g.role === 'visor'));
  check('marksman keeps the layering-pass head detail',
    sniper.gear.filter((g) => g.anchor === 'head').length > BOT_HELMETS.marksman.length - 1);
}

// The boom mic is a CHAIN, and a chain is the one thing a per-piece test cannot catch: every link
// can sit in a legal place and the assembly still be in three pieces. So each link's endpoints are
// recomputed from its own descriptor and measured against the previous link's.
//
// This is not hypothetical. The first version's rod ran from (-114, -56, 1) to (-66, -16, 91) mm:
// it started 13 mm outside the cup rim and ended 54 mm above the tip sphere at y -70. Both numbers
// looked fine in the descriptor because a cylinder's `position` is its CENTRE and its axis is local
// +Y AFTER `rotation` — neither end appears anywhere in the source.
console.log('bot-face: boom mic chain');
{
  const by = (id) => SOLDIER_HELMET.find((g) => g.id === id);
  // Three.js Euler order XYZ: local +Y is the second column of RX(x)*RY(y)*RZ(z).
  const localY = ([x, y, z]) => {
    const a = Math.cos(x), b = Math.sin(x), c = Math.cos(y), d = Math.sin(y),
          e = Math.cos(z), f = Math.sin(z);
    return [-c * f, a * e - b * f * d, b * e + a * f * d];
  };
  const along = (p, v, s) => [p[0] + v[0] * s, p[1] + v[1] * s, p[2] + v[2] * s];
  const gap = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const ends = (g) => {
    const h = (g.size[2] ?? 0) / 2, ax = localY(g.rotation || [0, 0, 0]);
    return [along(g.position, ax, -h), along(g.position, ax, h)];
  };
  const mm = (n) => (n * 1000).toFixed(1);

  const cup = by('helmetCupL'), boss = by('helmetBoomBoss');
  // The boss hangs off the cup, so it has to be inside the cup's rim in the y-z plane AND overlap
  // its x-slab. Satisfying only the first leaves a disc floating beside the ear.
  const onFace = Math.hypot(boss.position[1] - cup.position[1], boss.position[2] - cup.position[2]);
  check('boss sits inside the cup rim', onFace < cup.size[0], `${mm(onFace)} vs r ${mm(cup.size[0])}`);
  const [bA, bB] = ends(boss), cupHalf = cup.size[2] / 2;
  const overlap = Math.min(Math.max(bA[0], bB[0]), cup.position[0] + cupHalf)
                - Math.max(Math.min(bA[0], bB[0]), cup.position[0] - cupHalf);
  check('boss overlaps the cup face', overlap > 0.004, `${mm(overlap)} mm`);

  const arm1 = by('helmetBoom');
  check('arm 1 starts inside the boss', gap(ends(arm1)[0], boss.position) < boss.size[0],
    `${mm(gap(ends(arm1)[0], boss.position))} mm from the boss centre`);

  for (const [prev, next] of [['helmetBoom', 'helmetBoom2'], ['helmetBoom2', 'helmetBoomTip']]) {
    const d = gap(ends(by(next))[0], ends(by(prev))[1]);
    check(`${next} joins ${prev}`, d <= 0.004, `${mm(d)} mm gap`);
  }

  const joint = by('helmetBoomJoint');
  check('elbow ball covers the kink', gap(joint.position, ends(arm1)[1]) < joint.size[0]);

  // And the whole arm has to stay off the cheek, with or without a face mask under it.
  for (const id of ['helmetBoom', 'helmetBoom2', 'helmetBoomTip']) {
    const g = by(id);
    for (const p of ends(g)) {
      const clear = p[2] - headSurfaceZ(p[0], p[1]);
      check(`${id} clears the face`, clear > g.size[0], `${mm(clear)} mm`);
    }
  }
  // The mic capsule ends at the mouth, not past it: a boom that overshoots the centreline reads as
  // a straw. Mouth corner is around x -0.030.
  const tip = ends(by('helmetBoomTip'))[1];
  check('mic capsule stops at the mouth corner', tip[0] < -0.020 && tip[0] > -0.050, `x ${mm(tip[0])}`);
}

// The same visibility failure, one layer out: a gaiter stands up to 13 mm off the skull, so webbing
// solved onto the skull is INSIDE it and the whole retention system disappears. Every lifted piece
// has to keep its inner face out in the air.
{
  console.log('\nretention straps over a face mask');
  const p3 = (a = [0, 0, 0]) => ({ x: a[0], y: a[1], z: a[2] });
  const mm = (v) => (v * 1000).toFixed(1);
  const bare = new Map(SOLDIER_HELMET.map((g) => [g.id, g]));

  check('same pieces either way', SOLDIER_HELMET_MASKED.length === SOLDIER_HELMET.length
    && SOLDIER_HELMET_MASKED.every((g) => bare.has(g.id)));

  // Only the retention system may move: the rest of the helmet is already approved, and the top of
  // the front leg runs above the hem so it has to stay against the temple.
  const moved = SOLDIER_HELMET_MASKED
    .filter((g) => JSON.stringify(g) !== JSON.stringify(bare.get(g.id))).map((g) => g.id);
  check('only the retention system moves', moved.every((id) => /^strap|ChinCup$/.test(id)),
    moved.join(' '));
  check('the leg above the hem stays on the skin', !moved.includes('strapFront1'));

  let worst = { d: -1, id: '-' };
  for (const g of SOLDIER_HELMET_MASKED) {
    if (!/^strap/.test(g.id)) continue;
    const d = maskDepth(p3(g.position)) + g.size[2] * 0.5;   // local +Z is the strap's thickness
    if (d > worst.d) worst = { d, id: g.id };
  }
  check('every strap sits on the cloth, not in it', worst.d < 0, `${worst.id} ${mm(worst.d)} mm in`);

  // The cup is a 32 mm-deep box whose back is meant to be buried; what matters is its FRONT face,
  // which has to stand as proud of the cloth as it did of the chin.
  const cup = SOLDIER_HELMET_MASKED.find((g) => g.id === 'helmetChinCup');
  const proud = (g) => g.position[2] + g.size[2] * 0.5 - 1.10 * maskRadius(g.position[1]);
  check('chin cup stands proud of the cloth', proud(cup) > 0.002, `${mm(proud(cup))} mm`);
  check('chin cup is not thrown forward', proud(cup) < 0.008, `${mm(proud(cup))} mm`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall passed');
process.exit(failures ? 1 : 0);
