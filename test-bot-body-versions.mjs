// test-bot-body-versions.mjs — body x head composition.
//
// The point of this layer is that the two axes are genuinely independent, so the tests are mostly
// cross-products: every body must accept every head, every head must land the same on every body,
// and 'as authored' must be a true identity — if it drifts even slightly, the frozen versions stop
// being trustworthy references and the whole list is worthless.

import { BOT_BODIES, BOT_BODY_HISTORY, BOT_HEAD_KEYS, BOT_KITS, composeBot, headOf, bodyOf, isHeadless } from './bot-body-versions.js';
import { BOT_BODY_DESIGN, BOT_HELMETS, BOT_DESIGN_ADDONS, BOT_BODY_KINDS, SOLDIER_ROLE_DESIGNS,
  botDesignForRole, setBotBodyKind, getBotBodyKind } from './bot-body-design.js';
import { SOLDIER_PACK, PLATE_CARRIER, SOLDIER_PACK_CROSS, SOLDIER_ANTENNA, SOLDIER_TUBES,
  SOLDIER_MEDIC_MARKS, SOLDIER_TEAM_BRASSARD } from './bot-human-body.js';
import { BOT_TEAM_STYLES } from './multiplayer.js';
import { BODY_DESIGN_DEFAULTS, GAIT_DEFAULTS } from './player-procedural-body.js';
import { maskDepth } from './bot-face.js';

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
};
const headGear = (d) => (d.gear || []).filter((g) => g.anchor === 'head');

console.log('versions: the list itself');
{
  check('every body declares a branch', BOT_BODIES.every((b) => !!b.branch));
  check('the armour branch is six long', BOT_BODY_HISTORY.length === 6);
  check('history starts at the bare rig', BOT_BODY_HISTORY[0].design === BODY_DESIGN_DEFAULTS);
  check('history ends at the live design',
    BOT_BODY_HISTORY[BOT_BODY_HISTORY.length - 1].design === BOT_BODY_DESIGN);
  check('keys are unique', new Set(BOT_BODIES.map((b) => b.key)).size === BOT_BODIES.length);
  check('labels are unique', new Set(BOT_BODIES.map((b) => b.label)).size === BOT_BODIES.length);
  check('the stored designs are frozen', BOT_BODIES.every((b) => Object.isFrozen(b.design)));
  // Growth is a property of ONE line of descent. Asserting it across the whole list would forbid
  // ever adding a branch, which is the opposite of what this layer is for.
  const counts = BOT_BODY_HISTORY.map((b) => (b.design.gear || []).length);
  check('gear count grows monotonically along the armour branch',
    counts.every((c, i) => i === 0 || c >= counts[i - 1]), counts.join(' -> '));
  check('heads are ["as authored", "human", ...helmets]',
    BOT_HEAD_KEYS[0] === 'as authored' && BOT_HEAD_KEYS[1] === 'human' &&
    Object.keys(BOT_HELMETS).every((k) => BOT_HEAD_KEYS.includes(k)));
}

console.log('versions: split');
for (const b of BOT_BODIES) {
  const total = (b.design.gear || []).length;
  check(`${b.key}: head + body accounts for every piece`,
    headOf(b.design).gear.length + bodyOf(b.design).length === total);
  check(`${b.key}: the split is disjoint`,
    !headOf(b.design).gear.some((g) => bodyOf(b.design).includes(g)));
  // A headless body is a legitimate kind — it just has to be honest about it, because 'as authored'
  // then silently falls back to the rig's default mannequin head.
  check(`${b.key}: skull presence matches isHeadless`,
    (headOf(b.design).shape.headProfile !== undefined) === !isHeadless(b.design));
}

console.log('versions: every body x every head');
for (const b of BOT_BODIES) {
  for (const h of BOT_HEAD_KEYS) {
    const d = composeBot(b.key, h);
    check(`${b.key} + ${h}: composes`, !!d && Array.isArray(d.gear));
    if (!d) continue;
    // The body below the neck must be untouched by ANY head choice.
    check(`${b.key} + ${h}: body gear is preserved`,
      bodyOf(d).length === bodyOf(b.design).length,
      `${bodyOf(d).length} vs ${bodyOf(b.design).length}`);
    if (h === 'human') {
      check(`${b.key} + human: has a face`, d.gear.some((g) => g.role === 'sclera'));
      check(`${b.key} + human: head role is skin`, d.roles.head === 'skin');
      check(`${b.key} + human: no helmet left`, !d.gear.some((g) => g.role === 'visor'));
    }
    if (h === 'mark vii' || h === 'marksman') {
      check(`${b.key} + ${h}: has a visor`, d.gear.some((g) => g.role === 'visor'));
      check(`${b.key} + ${h}: no face left`, !d.gear.some((g) => g.role === 'sclera'));
      // A helmet authored against the current skull must BRING that skull, or it clips.
      check(`${b.key} + ${h}: carries the armoured skull`, d.headZScale === BOT_BODY_DESIGN.headZScale);
    }
  }
}

console.log('versions: heads land identically regardless of body');
// The clothed human is the ONE exception, and deliberately so: its lengths are scaled up to fill the
// player capsule, so it takes a head scaled to match rather than one sized for the unscaled rig.
const SAME_HEAD = BOT_BODIES.filter((b) => b.key !== 'human');
for (const h of BOT_HEAD_KEYS.filter((k) => k !== 'as authored')) {
  const shapes = SAME_HEAD.map((b) => JSON.stringify(headGear(composeBot(b.key, h))));
  check(`${h}: same head gear on every unscaled body`, new Set(shapes).size === 1, `${new Set(shapes).size} variants`);
  const skulls = SAME_HEAD.map((b) => composeBot(b.key, h).headZScale);
  check(`${h}: same skull on every unscaled body`, new Set(skulls).size === 1);
}
{
  // The head-scale seam still exists and is still tested, but the clothed human no longer USES it —
  // it renders at scale 1 like everything else. Scaling it was an attempt to make the figure taller
  // that only bent its knees; see the legLenRatio note in bot-human-body.js.
  const base = composeBot('current', 'human'), tall = composeBot('human', 'human');
  const eyeB = base.gear.find((g) => g.id === 'eyeballR'), eyeT = tall.gear.find((g) => g.id === 'eyeballR');
  check('the human body takes an unscaled head', eyeT.size[0] === eyeB.size[0]);
  const asked = composeBot('current', 'human', { scale: 1.25 });
  const k = asked.gear.find((g) => g.id === 'eyeballR').size[0] / eyeB.size[0];
  check('an explicit scale still works', Math.abs(k - 1.25) < 0.01, `x${k.toFixed(3)}`);
  check('an explicit scale is uniform across the face', Math.abs(
    (asked.gear.find((g) => g.id === 'mouth').position[1] /
     base.gear.find((g) => g.id === 'mouth').position[1]) - k) < 0.01);
  check('skull scales with the face', Math.abs(
    (Math.max(...asked.headProfile.map((p) => p[0])) /
     Math.max(...base.headProfile.map((p) => p[0]))) - k) < 0.01);
}

// The rig places the pelvis at a FIXED fraction of height, so a design's leg bones must be long
// enough to reach the ground from there. Too short and the legs over-extend with the feet floating;
// too long and the knees sit in a permanent squat. Both shipped here before this check existed.
console.log('versions: legs can actually reach the ground');
for (const b of BOT_BODIES) {
  const legLenRatio = b.design.legLenRatio ?? BODY_DESIGN_DEFAULTS.legLenRatio;
  const slack = legLenRatio - GAIT_DEFAULTS.pelvisHeightRatio;
  check(`${b.key}: leg chain clears the hip height`, slack > 0.015,
    `slack ${(slack * 1.8).toFixed(3)} m — legs over-extend, feet float`);
  check(`${b.key}: not a permanent squat`, slack < 0.09,
    `slack ${(slack * 1.8).toFixed(3)} m — knees stay deeply bent`);
}

console.log('versions: "as authored" is an identity, not a rebuild');
for (const b of BOT_BODIES) {
  check(`${b.key}: returns the stored design itself`, composeBot(b.key, 'as authored') === b.design);
}

console.log('versions: the clothed human branch');
{
  const human = BOT_BODIES.find((b) => b.key === 'human');
  check('exists and is its own branch', human && human.branch === 'human');
  check('is headless, so the head axis is mandatory', isHeadless(human.design));
  check('paired with the human head it gets a real skull',
    composeBot('human', 'human').headProfile !== undefined);
  // Trousers, not legs: the shape rules invert at both ends.
  const t = human.design.thighProfile, s = human.design.shinProfile;
  check('the thigh does not hug the knee', t[t.length - 1][0] > 0.8, String(t[t.length - 1][0]));
  check('thigh and shin meet at the knee within 5%',
    Math.abs(t[t.length - 1][0] - s[0][0]) < 0.05, `${t[t.length - 1][0]} vs ${s[0][0]}`);
  // The blouse sits at the BOOT TOP, which measurement put ~0.10 along the shin, not at the ankle.
  // Below that the trouser is inside the boot and invisible, so it is free to taper away.
  const blouseIdx = s.reduce((best, p, i) => (p[0] > s[best][0] && p[1] > -0.05 ? i : best), 0);
  check('the blouse sits high, at the boot top, not at the ankle',
    s[blouseIdx][1] > 0.0 && s[blouseIdx][1] < 0.25, `yFrac ${s[blouseIdx][1]}`);
  // `cloth`, not `shell`: shell carries the armour's emissive gain and blows a pale uniform out to
  // a flat glowing surface, which destroys the very limb profiles this body exists to show.
  check('limbs are cloth, not skin and not armour shell', human.design.roles.limb === 'cloth');
  // The belt must be the WIDEST thing at hip height. When the pelvis out-measured it, the hip bulged
  // forward as its own lump between shirt and trousers and read as a nappy.
  const hipR = Math.max(...human.design.pelvisProfile.map((p) => p[0])) * 0.35;
  const chestR = Math.max(...human.design.torsoProfile.map((p) => p[0])) * 0.35;
  const waistR = human.design.torsoProfile[2][0] * 0.35;
  // The belt sits at the WAIST, so it has to clear the waist — not the hip. The old assertion said
  // hip, which was right only while curing the diaper and wrong for a proportioned body: on a real
  // figure the hips are WIDER than the belt.
  const beltR = human.design.gear.find((g) => g.id === 'belt').size[0];
  check('the belt caps the waist', beltR > waistR, `belt ${beltR.toFixed(3)} vs waist ${waistR.toFixed(3)}`);
  check('chest:waist is athletic, not comic-book', chestR / waistR < 1.45 && chestR / waistR > 1.15,
    `${(chestR / waistR).toFixed(2)}`);
  // The pelvis has to be in the same league as the legs hanging off it. At 1.8x narrower it pinched.
  const legSpan = 0.3 * 2 * 0.42 + Math.max(...human.design.thighProfile.map((p) => p[0]))
    * 0.35 * human.design.limbThicknessRatio;
  check('the hips are not pinched above the thighs', legSpan / (hipR * 2) < 1.35,
    `legs span ${(legSpan * 2000).toFixed(0)}mm vs hips ${(hipR * 2000).toFixed(0)}mm`);
  // An edge is a VALUE break, not a bump: trim pieces in the same material as the garment are
  // geometrically present and visually absent.
  for (const id of ['collar', 'sleeveCuff', 'belt', 'bootCuffLip']) {
    check(`${id} contrasts with the uniform`,
      human.design.gear.find((g) => g.id === id).role !== human.design.roles.limb);
  }
  check('boots break value against the trousers', human.design.roles.foot === 'rubber');
  // A garment is legible at its boundaries, and none of those are expressible in a lathe profile.
  const ids = human.design.gear.map((g) => g.id);
  for (const edge of ['belt', 'bootCuff', 'sleeveCuff', 'shirtHem', 'collar']) {
    check(`has a ${edge} edge piece`, ids.includes(edge));
  }
  check('the boot cuff laps over the leg', human.design.gear.find((g) => g.id === 'bootCuff').size[0] * 2
    > s[s.length - 2][0] * 0.112, 'cuff must be wider than the leg it gathers over');
  // The calf must not out-measure the thigh, or the legs read as chicken-legged.
  check('the thigh is wider than the calf',
    Math.max(...t.map((p) => p[0])) > Math.max(...s.map((p) => p[0])));
  // The blouse only reads if the step is large; the first attempt was 6% and came back as "a cone".
  const dip = Math.min(...s.filter((p) => p[1] > -0.05 && p[1] < s[blouseIdx][1]).map((p) => p[0]));
  const flare = s[blouseIdx][0];
  check('the blouse is a big step, not a nudge', (flare - dip) / dip > 0.15,
    `${(((flare - dip) / dip) * 100).toFixed(0)}%`);
  // Every boot-related piece must sit ABOVE the boot top, or it renders inside the shell. The boot
  // stands ~0.181 m above the ankle and the shin is 0.449 long, so anything past ~0.29 down the
  // shin from the knee is buried. This is the bug that produced the "bracelet" and the lumpy heel.
  // DERIVED, not hardcoded. The boot normalises to 2 units tall, then footLift shifts it, so its top
  // stands footScale.y * limbThickness * (2 + footLift) above the ankle. A literal here goes stale
  // the moment the boot is resized, which is precisely when this check matters most.
  const H = 1.8, R = 0.35;
  const limbThickness = R * human.design.limbThicknessRatio;
  const shinLen = H * human.design.legLenRatio * human.design.shinFrac;
  const bootTopAboveAnkle = human.design.footScale[1] * limbThickness * (2 + (human.design.footLift ?? -0.10));
  const BOOT_TOP_FROM_KNEE = shinLen - bootTopAboveAnkle;
  for (const g of human.design.gear.filter((x) => x.anchor === 'knee')) {
    check(`${g.id} clears the boot top`, g.position[1] < BOOT_TOP_FROM_KNEE + 0.02,
      `${g.position[1]} vs boot top ${BOOT_TOP_FROM_KNEE.toFixed(3)}`);
  }
  // A light detail on near-black hardware reads as a hole punched in it.
  for (const g of human.design.gear) {
    check(`${g.id} is not a light role on a dark part`, !(g.anchor === 'foot' && g.role === 'plate'));
  }
  const boot = human.design.footScale.map((v) => v * 0.112 * 2000);
  check('the boot is foot-sized, not a clog', boot[2] > 240, `${boot[2].toFixed(0)} mm long`);
  check('skin shows only where it should',
    human.design.roles.hand === 'skin' && human.design.roles.neck === 'skin');
}

console.log('versions: kit is a third independent axis');
{
  const kits = BOT_KITS.filter((k) => k !== 'none');
  check('kits are real addon names', kits.every((k) => Array.isArray(BOT_DESIGN_ADDONS[k])));
  for (const k of kits) {
    const add = BOT_DESIGN_ADDONS[k].length;
    for (const h of BOT_HEAD_KEYS) {
      const bare = composeBot('current', h);
      const kitted = composeBot('current', h, {}, [k]);
      check(`${k} on ${h}: adds exactly its own pieces`, kitted.gear.length === bare.gear.length + add,
        `${kitted.gear.length} vs ${bare.gear.length}+${add}`);
      check(`${k} on ${h}: leaves the head alone`,
        headGear(kitted).length === headGear(bare).length);
    }
  }
  // Kit must compose the same regardless of body, which is what makes it an axis rather than a case.
  const deltas = BOT_BODIES.map((b) =>
    composeBot(b.key, 'as authored', {}, ['packLarge']).gear.length - (b.design.gear || []).length);
  check('a kit adds the same count to every body', new Set(deltas).size === 1, deltas.join(','));
  check('several kits layer in order',
    composeBot('current', 'as authored', {}, ['packSmall', 'medicKit']).gear.length ===
    BOT_BODY_DESIGN.gear.length + BOT_DESIGN_ADDONS.packSmall.length + BOT_DESIGN_ADDONS.medicKit.length);
  check('an unknown kit is ignored, not fatal',
    composeBot('current', 'as authored', {}, ['nope']).gear.length === BOT_BODY_DESIGN.gear.length);
  check('no kit still returns the stored design itself',
    composeBot('current', 'as authored', {}, []) === BOT_BODY_DESIGN);
}

console.log('versions: nothing mutates its input');
{
  const before = BOT_BODIES.map((b) => JSON.stringify(b.design));
  for (const b of BOT_BODIES) for (const h of BOT_HEAD_KEYS) composeBot(b.key, h, { expression: 'angry' });
  check('every stored design is byte-identical after the full cross product',
    BOT_BODIES.every((b, i) => JSON.stringify(b.design) === before[i]));
}

console.log('versions: bad input degrades instead of throwing');
{
  check('unknown body falls back to the newest', composeBot('nope', 'as authored') === BOT_BODY_DESIGN);
  check('unknown head falls back to the body as authored',
    composeBot('current', 'nope') === BOT_BODY_DESIGN);
  check('a body with no gear still takes a head',
    composeBot('default', 'human').gear.some((g) => g.role === 'sclera'));
}

// -------------------------------------------------------------------------------------------
// BODY KIND: armoured mech vs human soldier.
//
// Both viewers reach the art through botDesignForRole() and nothing else, so this switch is the
// single place the two can disagree. The tests that matter are (a) the switch actually changes what
// comes back, (b) the memoisation is keyed by kind and not just by role - a cache that ignored the
// kind would hand a soldier viewer armoured designs for any role it had already built - and (c) no
// pack-mounted marker is ever emitted for a role that carries no pack.
console.log('versions: body kind');
{
  const ROLES = Object.keys(SOLDIER_ROLE_DESIGNS);
  const idOf = (arr) => new Set(arr.map((g) => JSON.stringify(g)));

  check('starts armoured', getBotBodyKind() === 'armoured');
  check('an unknown kind is rejected', setBotBodyKind('mecha') === false);
  check('re-selecting the current kind is a no-op', setBotBodyKind('armoured') === false);

  const armoured = Object.fromEntries(ROLES.map((r) => [r, botDesignForRole(r)]));
  check('armoured roles all carry the mech skull',
    ROLES.every((r) => armoured[r].headProfile === BOT_BODY_DESIGN.headProfile));

  check('switching kind reports the change', setBotBodyKind('soldier') === true);
  const soldier = Object.fromEntries(ROLES.map((r) => [r, botDesignForRole(r)]));

  // The bug this guards: a cache keyed on roleId alone returns the armoured design here, and the
  // symptom is a viewer that switches to soldiers for roles it has not rendered yet and stays
  // armoured for the ones it has.
  check('the cache is keyed by kind, not just role',
    ROLES.every((r) => soldier[r] !== armoured[r]));
  check('soldier roles wear the human skull',
    ROLES.every((r) => soldier[r].roles.head === 'skin' && soldier[r].headProfile.length === 10));
  // Eyes OR shades. withHeadKit deletes the eye pieces behind an opaque lens, so a sclera check
  // alone fails every role that wears sunglasses — the guard is against a BLANK head, not eyes.
  check('soldier roles have a face',
    ROLES.every((r) => soldier[r].gear.some((g) => g.role === 'sclera' || g.id === 'shadeLens')));
  check('every soldier wears the carrier',
    ROLES.every((r) => idOf(soldier[r].gear).has(JSON.stringify(PLATE_CARRIER[0]))));
  check('no soldier keeps mech gear',
    ROLES.every((r) => !soldier[r].gear.some((g) => g.role === 'visor')));

  // TEAM LEGIBILITY. A soldier is otherwise almost untinted - uniform and face are per-BODY roles,
  // carrier and boots are untinted - so without the brassard the only team colour on the whole
  // figure is three `plate` pieces on the helmet. `trim` is the vivid team role AND the one
  // botBodyStyle in multiplayer.js actually sets; `accent` is not, so it is not a substitute.
  check('every soldier role carries the team brassard',
    ROLES.every((r) => idOf(soldier[r].gear).has(JSON.stringify(SOLDIER_TEAM_BRASSARD[0]))));
  check('the brassard uses a team-tinted role botBodyStyle sets',
    SOLDIER_TEAM_BRASSARD.every((g) => g.role === 'trim'));
  check('no soldier is left without team-tinted gear',
    ROLES.every((r) => soldier[r].gear.filter((g) => g.role === 'trim' || g.role === 'shell').length >= 2));

  // Marker/pack coupling. SOLDIER_PACK_CROSS sits at z -0.344 against a pack rear face at -0.338,
  // the antenna roots in the left side pouch and the tubes clamp behind the pack: all three are
  // placed against pack surfaces, so any of them on a packless role hangs in free air.
  for (const [marks, arr] of [['medic', SOLDIER_PACK_CROSS], ['antenna', SOLDIER_ANTENNA], ['tubes', SOLDIER_TUBES]]) {
    const wearer = ROLES.find((r) => SOLDIER_ROLE_DESIGNS[r].marks === marks);
    if (!wearer) continue;
    const has = (r, piece) => idOf(soldier[r].gear).has(JSON.stringify(piece));
    check(marks + ' marker is only on roles that carry a pack',
      ROLES.every((r) => !has(r, arr[0]) || SOLDIER_ROLE_DESIGNS[r].pack === true));
    check(wearer + ' actually gets its ' + marks + ' marker', has(wearer, arr[0]));
  }
  check('the packless role has no pack gear',
    ROLES.filter((r) => !SOLDIER_ROLE_DESIGNS[r].pack)
      .every((r) => !idOf(soldier[r].gear).has(JSON.stringify(SOLDIER_PACK[0]))));

  // Medic's carrier crosses do NOT depend on the pack, so they must survive on their own terms.
  check('medic carries its carrier crosses',
    idOf(soldier.medic.gear).has(JSON.stringify(SOLDIER_MEDIC_MARKS[0])));
  // A cross is a role badge, so it must not be team-tinted - `eye` is one of the untinted roles.
  check('cross bars use an untinted role',
    SOLDIER_MEDIC_MARKS.filter((g) => g.role === 'eye').length === 6);
  // The mast light is the opposite case: it marks a SIDE, so it has to take the per-instance tint.
  // `eye`, `metal`, `rubber` and `fabric` are the roles body-part-batches leaves flat.
  check('mast light uses a team-tinted role',
    SOLDIER_ANTENNA.some((g) => g.type === 'sphere' && ['shell', 'plate', 'trim', 'accent'].includes(g.role)));
  // Both viewers have to agree on WHICH tinted role carries the team colour, or the light is team
  // green in one and pale grey in the other. bot-viewer-v2 forces trim near-black and puts the
  // colour on accent, so multiplayer's table has to carry accent too - it does not default to trim.
  check('every team style names an accent',
    Object.values(BOT_TEAM_STYLES).every((s) => typeof s.accent === 'number'),
    Object.keys(BOT_TEAM_STYLES).join(' '));

  // The head kit has to survive the trip through botDesignForRole, which is the ONLY function both
  // viewers use to reach the art. Checking bot-face.js in isolation says nothing about whether a
  // bot on the field gets it: buildSoldierDesign could stop calling withHeadKit and every test in
  // test-bot-face.mjs would still pass.
  for (const [role, spec] of Object.entries(SOLDIER_ROLE_DESIGNS)) {
    const ids = new Set(soldier[role].gear.map((g) => g.id));
    const kit = spec.head || {};
    check(`${role}: eyes match its eyewear`, ids.has('eyeballR') === !kit.glasses);
    check(`${role}: lens matches its eyewear`, ids.has('shadeLens') === !!kit.glasses);
    check(`${role}: nose is split only under a mask`, ids.has('noseMasked') === !!kit.mask);
    check(`${role}: nose is not doubled`, !(ids.has('nose') && ids.has('noseTop')));
    if (!kit.helmet || !kit.mask) continue;
    // Straps solved onto the skull sit inside a gaiter; a masked role has to get the lifted set.
    const worst = soldier[role].gear.filter((g) => /^strap/.test(g.id)).reduce(
      (w, g) => Math.max(w, maskDepth({ x: g.position[0], y: g.position[1], z: g.position[2] })
        + g.size[2] * 0.5), -1);
    check(`${role}: straps ride on the cloth`, worst < 0, `${(worst * 1000).toFixed(1)} mm in`);
  }

  check('memoisation still holds within a kind', botDesignForRole('medic') === soldier.medic);
  setBotBodyKind('armoured');
  check('switching back returns the original objects', botDesignForRole('medic') === armoured.medic);
  check('every declared kind builds',
    BOT_BODY_KINDS.every((k) => { setBotBodyKind(k); return botDesignForRole('rifleman').gear.length > 40; }));
  setBotBodyKind('armoured');
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall passed');
process.exit(failures ? 1 : 0);
