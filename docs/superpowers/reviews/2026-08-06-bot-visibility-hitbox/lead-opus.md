# Bot visibility vs. hit volume vs. damage — lead audit (Opus)

Read-only code audit of `bot-viewer-v2.html` and its modules, 2026-08-06. Every number below is
computed from constants read in the code, not estimated. Arithmetic reproduced in section 4.

## TOP 3 CONCLUSIONS

1. **The head is entirely outside the hit capsule.** The visible skull spans y = 1.786 → 2.020 m
   above the feet (2.053 m with the Mark VII crest). The hit capsule tops out at y = 1.800 m.
   The head is neither hittable nor usable as a LOS target — it is decoration on top of the hitbox.
2. **Spotting and hitting both collapse to one point at 1.32 m.** LOS is a single ray, eye→eye, both
   at `EYE_LIFT = 0.85` up the capsule shaft. There is no head sample, no torso sample, no
   multi-point visibility. A bot whose head and shoulders clear a wall is invisible if the 1.32 m
   point is blocked, and a bot whose 1.32 m point clears a gap is fully visible even if 90% of it is
   behind cover.
3. **The pitch-clamp suspicion is false.** There is no vertical clamp anywhere in the bot perception
   or aim path. `withinBotFov` is horizontal-only by construction; `bot.pitch` is slewed with no
   bound. The vertical clamps that exist (±1.45 rad) are camera-only and gate nothing about bots.

Damage is flat: no headshot multiplier, no per-part scaling, and — separately — a bot can only hit
the one entity it has selected as `botTarget`.

---

## 1. Perception geometry

`bot-viewer-v2.html:9377-9394` is the whole visibility test:

```js
const botEye    = eyePosInto(bot, _sentryEye);
const targetEye = eyePosInto(botTarget, _sentryTargetEye);
const dist = botEye.distanceTo(targetEye);
if (dist <= botSightDistance() && dist > 1e-4) {
  const dir     = _sentryDir.copy(targetEye).sub(botEye).multiplyScalar(1 / dist);
  const blocked = mapCollider.raycast([...botEye], [...dir], dist - 0.05);
  const inFov   = withinBotFov(bot.yaw, botEye, targetEye);
  visible = !blocked && inFov;
}
```

- **Eye point (both ends):** `bot-viewer-v2.html:6548-6552`,
  `capsule.start.lerp(capsule.end, EYE_LIFT)` with `EYE_LIFT = 0.85` (`:6194`).
  On a default bot that is **y = 1.320 m** above the feet.
- **Sample count:** one ray, one point on each end. No head/torso/limb samples anywhere.
- **FOV:** `withinBotFov` (`:5950-5959`) projects onto the XZ plane and compares against
  `cos(deg/2)`. `deg = max(botBehaviorSettings.fovDegrees, tierPerception.fovDegrees)`.
  **There is no pitch term.** The shared `perception.js:28` implementation says so in its own
  comment: "Horizontal vision cone … No pitch term."
- **Vertical limit:** none. Elevation only affects perception through `dist` (3D) and through what
  the LOS ray happens to intersect.
- **Occluders:** `mapCollider` only (`map-collision.js:69`, built from `mapRoot`, which includes
  the bot-terrain displaced floor). Other bots do not block LOS.

## 2. Hit geometry

`fireBotShot` (`bot-viewer-v2.html:10069`) resolves the shot through `combat.js:172 resolveHitscan`:

```js
players: botTarget?.alive ? [combatCapsuleFor(botTarget)] : [],
heightAt: () => -1e6, normalAt: () => [0, 1, 0],
occluder: (o, d, range) => mapCollider.raycast(o, d, range),
```

- **Shape:** one vertical capsule per target. `combatCapsuleFor` (`:2302-2306`) hands over
  `{ p: capsule midpoint, r: capsule.radius, h: end.y - start.y }`.
- **`rayCapsuleHit` convention** (`combat.js:29-35`): `p` is the centre, `h` is the *straight
  section* between the two sphere centres, and the caps add `r` at each end. So the tested volume
  runs from `p.y - h/2 - r` to `p.y + h/2 + r`.
- **Numbers** (`bot-entity.js:11-28`, `bot-viewer-v2.html:2182`): `radius = 0.3`,
  `standHeight = 1.8`, `start.y = ground + 0.3`, `end.y = ground + 1.5`.
  **Hit volume: y ∈ [0.0, 1.8], radius 0.3 m.**
- **Source of the numbers:** hardcoded `DEFAULT_RADIUS = 0.3` / `DEFAULT_STAND_HEIGHT = 1.8`. They
  are *not* derived from the rig. The rig is handed the capsule's height afterwards
  (`:3475 st.height = standHeight + radius*2 = 1.8`), so the flow is capsule → rig, and the rig's
  own proportions decide where the geometry actually lands.
- **Stance is handled correctly.** `applyStanceHeight` (`:7062-7078`) scales the capsule by the same
  eased `stanceWeights` the visible pose uses, via `stanceCapsuleHeightScale` (`bot-stance.js:191`).
  The crouch/prone silhouette and the crouch/prone hitbox stay in agreement.
- **Per-part hit resolution exists but is not wired to combat.** `bot-body-hit.js resolveBodyHit`
  does a proper ray/AABB test against every rig part. Its only callers are
  `damage-simulator.html:323` and `:330` — a standalone tuning harness. `bot-viewer-v2.html` never
  imports it. Its own header comment states the purpose: placing blood decals on the right limb,
  because "combat hitscan tests one ~0.3 m capsule for the whole bot."

## 3. Visual geometry

Bots default to `botBody=armoured` → `BOT_BODY_DESIGN` (`bot-body-design.js:192`), merged over
`BODY_DESIGN_DEFAULTS` (`player-procedural-body.js:494`). `BOT_BODY_DESIGN` does not override the
Y ratios, so they come from the defaults at `:513`:
`torsoYRatio 0.22, neckYRatio 0.37, headYRatio 0.48`, `pelvisHeightRatio 0.58` (`:56`).

Placement (`player-procedural-body.js:1629, 1761-1780`), with `H = 1.8`, `R = 0.35` (`:684-685`) and
profiles scaled `[r, y] → [R*r, H*y]` (`:883`):

| Landmark | World Y (m above feet) |
|---|---|
| pelvis | 1.044 |
| torso anchor | 1.440 |
| neck anchor | 1.710 |
| **head anchor** | **1.908** |
| head bottom (profile −0.068·H) | 1.786 |
| head top (profile +0.062·H) | 2.020 |
| Mark VII crest top (`bot-body-design.js:101`, +0.134 +0.011 in true metres) | 2.053 |

Head max radius: `0.245 · R = 0.086 m`. Helmet shell sits outside that.

## 4. Overlap analysis

```
node -e '...'   # reproduced from the constants above
pelvisY 1.044 | head anchor 1.908 | head world y 1.786 -> 2.020 | head max radius 0.086
capsule spheres 0.3 / 1.5, radius 0.3 -> volume y 0.0 -> 1.8 | eye (0.85 lerp) 1.320
capsule cross-radius at y=1.786: 0.0918
```

- **Vertical mismatch: the visible bot is 2.02 m tall (2.05 m with the crest); the hit capsule is
  1.80 m.** The top **0.22–0.25 m — 11–12% of body height — is visible but not hittable**, and that
  region is exactly the head.
- Only the bottom **1.4 cm** of the 23.4 cm skull falls inside the capsule, and there the capsule's
  cross-section has narrowed to 0.092 m — barely wider than the 0.086 m skull. In practice: **you
  cannot shoot a bot in the head.**
- The other direction: the capsule is **0.3 m in radius everywhere**, while the head is 0.086 m and
  the limbs are thinner still. Around the head/shoulders the capsule is roughly 3.5× too wide, so
  shots that visibly pass beside a bot register as hits. Below the pelvis the legs are two thin
  cylinders inside a 0.6 m-wide cylinder, so the same over-generosity applies to leg shots.
- **The perception point (1.320 m) is inside the capsule and inside the torso.** That part is
  consistent — but it sits 0.12 m below the torso anchor and 0.59 m below the head, so LOS is a
  chest-height test on a body whose most exposed part over cover is the head.

## 5. Damage

Flat, everywhere.

- `fireBotShot:10128` → `applyCombatDamage(weapon.damage ?? 0, hitPoint, target, …)`. `weapon.damage`
  is a per-weapon scalar; `hitPoint` is passed for FX and audio only.
- `applyCombatDamage` (`:5814`) → `applyBotDamage` (`:5775`). Neither reads the hit location for
  damage magnitude.
- Blast damage (`detonateBlast:10021`) scales by radial falloff from the capsule midpoint. That is
  the only positional damage in the system.
- **No `headshot`, `damageMultiplier`, `partMultiplier`, or `hitZone` symbol exists in the codebase**
  outside a comment in `ragdoll-body.js:91` describing impulse direction, not damage.
- Consequence: even if the head were inside the capsule, hitting it would not matter.

**Separate but serious:** `players: botTarget?.alive ? [combatCapsuleFor(botTarget)] : []`
(`:10106`). The hitscan list contains **only the shooter's currently selected target**. A bullet
cannot hit any other bot, friendly or hostile, no matter where it travels. Crossfire, friendly fire
and stray-round hits are all impossible by construction.

## 6. Pitch / look limits

Every vertical clamp in the file, and what it gates:

| Location | Clamp | Gates |
|---|---|---|
| `:1238` `pov.pitchOffset` | ±1.25 rad | POV camera free-look offset |
| `:1266`, `:3662` `flyCam.pitch` | ±1.45 rad | debug fly camera |
| `:3888` `pov.basePitch + pitchOffset` | ±1.45 rad | POV camera render direction |
| `:8766` `bot.pitch = slewAngle(...)` | **none** | the bot's actual aim |

- `aimAnglesTo` (`bot-activity.js`, called at `:9411`) returns the true 3D bearing to the target eye.
- `slewAngle` rate-limits how fast pitch changes; it does not bound the value.
- `bot-aim.js` contains no pitch handling at all — only reaction delay, spread and dispersion.
- `withinBotFov` has no vertical term, so elevation never rejects a target.
- The fired ray comes from `botMountedBarrelRay()` (`:9962`), the rendered weapon's muzzle, which is
  solved onto `botAimPoint` by `alignMountedWeaponToPoint` (`:9977`, called at `:1912`). That solve
  is a free `setFromUnitVectors` rotation with no angular limit.

**Answer: no. A bot cannot fail to see or hit an elevated or sunken target because of a clamp.**
There is no elevation difference at which any clamp starts to bite — the number does not exist.

What *does* bite on terrain is section 1's single ray. On a slope or a stairway the eye-to-eye line
at 1.32 m clips the crest while the target's whole upper body is in the open, and vice versa. That
is a sampling failure, not a clamp.

One related note: `heightAt: () => -1e6` in the hitscan means the raymarched heightfield never blocks
a bullet. Terrain occlusion for shots depends entirely on the bot-terrain floor mesh being inside
`mapCollider`'s BVH (it is, via `mapRoot`). Worth remembering if terrain is ever moved out of
`mapRoot`.

## 7. Discrepancies, ranked

1. **Head is visible but not hittable and not a LOS target** (0.22–0.25 m, 11–12% of the body, the
   most tactically exposed part). Capsule tops out at 1.80; head runs 1.786 → 2.053.
2. **Only one entity is hittable per shot.** `players: [combatCapsuleFor(botTarget)]` makes every
   other bot in the world bullet-transparent.
3. **Single-point LOS at 1.32 m** decides both spotting and firing. No head sample means peeking over
   cover confers full invisibility; no torso/limb sample means a sliver of exposed chest confers full
   visibility. This is the mechanism behind "bots don't see each other around cover."
4. **Capsule is ~3.5× too wide at head height and ~2× too wide at the limbs.** Visible misses count
   as hits.
5. **Damage is flat**, so there is no gameplay reason to aim anywhere in particular — which is also
   why (1) and (4) have gone unnoticed.
6. **`RIG_HEAD_TOP_FACTOR = 0.48` in `bot-stance.js:181` is misnamed.** 0.48 is `headYRatio`, the head
   *anchor*, not the head *top*. `stanceCapsuleHeightScale` therefore computes `standTop` about
   0.11 m short, so crouch/prone capsule scales are derived from a body that is modelled as shorter
   than it renders. Small effect, but it is a real off-by-a-head in the stance math.

## Method notes / confidence

- Sections 1, 2, 5, 6, 7 are read directly from source. High confidence.
- Section 3 and 4's numbers are computed from constants I read; the arithmetic is reproduced above
  and is deterministic. I did not render a bot to confirm the head lands where the math says. What
  would settle it in one look: draw the `combatCapsuleFor` capsule as a wireframe next to a standing
  bot in the viewer.
- I did not audit the human/`soldier` body kind (`bot-human-body.js:473` uses `headYRatio 0.459`,
  so its head sits ~0.038 m lower — the conclusion does not change).
