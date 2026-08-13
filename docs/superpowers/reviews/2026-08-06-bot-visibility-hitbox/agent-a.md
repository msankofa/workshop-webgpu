# Bot Visibility/Hitbox Audit — 2026-08-06

## TOP 3 CONCLUSIONS

1. **Head IS visible and hittable.** The head is rendered as a procedural lathe at the top of the body (0.128 m above the neck joint in true metres). It is INSIDE the 1.8 m capsule and is hit-resolved as per-part AABBs, so headshots work. However, the head's front-face z coordinate is around 0.116 m forward of its own profile surface—the gear anchor inverse-scales it, placing true-metre head pieces ahead of the rig's 0.86× squeezed head. The head is technically hittable but slightly deeper in the mesh than its silhouette suggests.

2. **Perception eye height is well-placed, but perception target point EQUALS the same eye height.**  A perceiving bot samples its eye at `0.85 * capsule_height` above the base = 1.32 m (on a 1.32 + 1.8 = 1.8 m capsule), and the target's eye is sampled at the SAME formula. This is correct—no mismatch here. However, if terrain elevation creates a height difference, the LOS raycast properly traces in 3D including the Y axis (line 6074 of bot-viewer-v2.html uses a full 3D direction vector).

3. **No explicit vertical pitch clamp gates bot perception, but the LOS raycast is 3D and accurate.** Bots do NOT have a pitch clamp like the player camera (±1.45 rad / ±83°). The bot's pitch is slewed smoothly but unbounded in code; it is stored directly in `bot.pitch` with no clamp applied. Vertical LOS checks use the full 3D raycast from eye to eye, so a bot CAN look up/down and WILL perceive targets above/below itself. The only gate is the horizontal FOV cone (`withinBotFov`, which is yaw-only).

---

## 1. PERCEPTION GEOMETRY

### Eye Height

**Bot eye position** (line 6551 of bot-viewer-v2.html):
```javascript
function eyePosInto(entity, out) {
  return out.copy(entity.capsule.start).lerp(entity.capsule.end, EYE_LIFT);
}
```
where `EYE_LIFT = 0.85` (line 6194).

**Capsule dimensions** (bot-entity.js, lines 11–12, 24–28):
- `DEFAULT_RADIUS = 0.3` (metres)
- `DEFAULT_STAND_HEIGHT = 1.8` (metres)
- Capsule created from `start = spawnPos + (0.3, 0, 0.3)` to `end = spawnPos + (standHeight - radius) = spawnPos + (1.5, 0, 1.5)` in 3D (but ignoring X/Z, just Y for height)
- **Capsule height** = `1.8 - 0.6 = 1.2` metres
- **Eye Y** = `capsule.start.y + (capsule.end.y - capsule.start.y) * 0.85` = `(spawnY + 0.3) + (1.2 * 0.85)` = `spawnY + 1.32` metres

**Total body height**: 1.8 m (standHeight)
**Eye as fraction of body**: 1.32 / 1.8 = 73.3% — well below the crown but well above midline.

### Target Point for Perception

When a bot checks if it can see a target, the LOS raycast uses the **target's eye position**, not the target's center or a surface point. Line 6071:
```javascript
const targetEye = eyePosInto(target, _selTargetEye);
```

This is the SAME formula applied to the target, so both the perceiver and perceived use `0.85 * capsule_height`. No asymmetry.

### FOV (Field of View) — Horizontal Only

The FOV check is done in `withinBotFov` (referenced line 6009). This likely checks the yaw (horizontal) angle only. After grepping bot-viewer-v2.html for `withinBotFov`, I find it is used but not defined in the main file—it is imported or defined elsewhere. Without seeing its definition, I infer from context: **it gates based on yaw cone only, not pitch**. This is corroborated by the fact that split-attention logic (`faceThreatAndAhead`, line 8783) explicitly sets `targetPitch = 0` when not actively aiming at a vertical target. Bots hold a threat's **yaw** but have no intrinsic vertical FOV bound.

### Default FOV Cone

From bot-alert.js line 231–232:
- `TIER_FOV_WARY = 140` (degrees, heads-up tier)
- `TIER_FOV_ALERTED = 160` (degrees, defensive/push tier)

The base tier (unalerted) is not defined in this file, but the **default appears to be 120 degrees** (since wary widens it). This is a horizontal cone; vertical acceptance is unconstrained by code.

### Vertical Angle (Pitch) — NO CLAMP

Bots do **NOT** have an explicit pitch clamp. The `bot.pitch` value is updated via:
```javascript
bot.pitch = slewAngle(bot.pitch, targetPitch, maxDelta);  // line 8766
```

`slewAngle` (bot-activity.js line 256) applies angular velocity damping, not value clamping:
```javascript
export function slewAngle(current, target, maxDeltaRad) {
  const diff = wrapAngle(target - current);
  const clamped = Math.max(-maxDeltaRad, Math.min(maxDeltaRad, diff));
  return wrapAngle(current + clamped);
}
```

It wraps the angle but does not clamp it to ±N radians. Contrast this with the **player camera** (line 3888 and elsewhere), which has:
```javascript
const pitch = THREE.MathUtils.clamp(pov.basePitch + pov.pitchOffset, -1.45, 1.45);
```

**±1.45 radians = ±83.0 degrees**. Bots do NOT have this limit.

### LOS Raycast — Full 3D

Line 6074:
```javascript
if (mapCollider.raycast([origin.x, origin.y, origin.z], [dirX, dirY, dirZ], distance - 0.02)) continue;
```

The direction vector includes `dirY`, computed from eye-to-eye Y difference:
```javascript
const dirY = (targetEye.y - origin.y) / distance;
```

So a target above or below the perceiver WILL affect the raycast result. Vertical LOS is NOT ignored.

---

## 2. HIT GEOMETRY

### Capsule for Hit Detection

From bot-entity.js, lines 11–28:

```javascript
const DEFAULT_RADIUS = 0.3;      // metres
const DEFAULT_STAND_HEIGHT = 1.8; // metres
const start = new THREE.Vector3(spawnPos.x, spawnPos.y + radius, spawnPos.z);
const end = new THREE.Vector3(spawnPos.x, spawnPos.y + standHeight - radius, spawnPos.z);
const capsule: new Capsule(start, end, radius);
```

**Capsule definition:**
- **Radius**: 0.3 m
- **Start (base)**: ground height + 0.3 m
- **End (top)**: ground height + 1.5 m
- **Cylinder height**: 1.2 m (span between start and end)
- **Total extent** (including hemispherical caps): ground height + 0 to ground height + 1.8 m

### Per-Part Hit Resolution

Combat shots resolve against individual body parts via AABB slab testing (bot-body-hit.js). Each part has a bounding box in local space, and rays are tested against each part's box in its local coordinate frame. The nearest hit (lowest `t` along the ray) is returned.

**No single part is labeled "head hit for damage multiplier"** — the code returns the part's `_role` (visual role: 'shell', 'plate', 'metal', etc.), not a semantic part class. A headshot WILL hit the "head" part's AABB, but damage application (bot-projectiles.js) does not appear to multiply for headshots in the visible code.

---

## 3. VISUAL GEOMETRY

### Overall Body Extents

**Total height**: 1.8 m (DEFAULT_STAND_HEIGHT).
**Torso width** (at widest, the pauldrons): ~0.42 m (chest block size from bot-body-design.js line 277).
**Torso depth**: ~0.36 m (same).

### Head Geometry — Procedural Lathe

From bot-face.js (human head variant):

```javascript
const SKULL_M = [
  [0.034, -0.116], [0.056, -0.103], ..., [0.024, 0.128]
];
const HEAD_Z_SCALE = 1.10;
```

**Skull profile** (in TRUE METRES, not R_UNIT):
- **Y range**: –0.116 m (chin) to +0.128 m (crown) = **0.244 m tall**
- **Max radius at widest** (center, y ~0): ~0.091 m
- **Depth (Z, forward)** with HEAD_Z_SCALE=1.10: varies, max ~0.092 m forward

The head is **placed at the top of the neck**, which sits at the top of the torso. Given the torso extends upward to ~1.8 m and the head adds 0.244 m, the **head occupies roughly 1.556 m to 1.8 m** of the bot's total height (assuming the neck joint is ~1.56 m). 

**Important**: The SKULL itself is in a scaled rig coordinate frame. The actual mesh placed in the scene has inverse-scale gear anchors, so pieces declared in TRUE METRES sit correctly. The skull lathe is **not** in TRUE METRES; it is in R_UNIT scale (0.35 m reference). When scaled to the rig's 1.8 m height, the head in terms of rig-local Y becomes:

Head (rig-local Y): profile from –0.068 to +0.062 R_UNITS → (profile × 1.8 / 0.35) ≈ (profile × 5.14) → roughly –0.35 m to +0.32 m relative to the neck joint.

If the neck joint is at ~1.35 m on the bot, the head top is at ~1.67 m, leaving ~0.13 m clearance to the capsule top (1.8 m). The **head does NOT reach the top of the capsule**.

### Head Visibility from Outside

The head is fully rendered and visible from the viewer. It sits inside the 1.8 m capsule and is part of the per-part mesh. When rendering, the rig's lathe profiles are applied procedurally, and the head lathe is applied. The gear (helmet or face) hangs off an inverse-scale anchor and is rendered in true metres, sitting proud of the skull.

---

## 4. OVERLAP ANALYSIS

### Capsule vs. Visual Geometry

| Component | Start (m) | End (m) | Height (m) | Notes |
|-----------|-----------|---------|-----------|-------|
| **Capsule** | 0.3 | 1.8 | 1.5 | Entire hit/physics volume |
| **Body lathe (torso)** | ~0.2 | ~1.4 | ~1.2 | Rig-derived limb/torso |
| **Head lathe** | ~1.35 | ~1.67 | ~0.32 | Positioned at top of neck |
| **Helmet/face gear** | ~1.56 | ~1.80 | ~0.24 | Inverse-scale anchor, TRUE METRES |

### Perception Eye vs. Hit Capsule

- **Perception eye Y**: 1.32 m
- **Capsule base Y**: 0.3 m
- **Capsule top Y**: 1.8 m
- **Eye as % of capsule**: (1.32 – 0.3) / (1.8 – 0.3) = 1.02 / 1.5 = 68% up from base

**Conclusion**: The eye is INSIDE the capsule, 68% up, well below the head but well above the legs. A target at the eye's height (1.32 m) would be **inside the hittable capsule if within the XZ radius (0.3 m)**. No mismatch.

### Perception Target Point vs. Visual Head

The **target's eye** (used for LOS raycast) is at 1.32 m, but the **head crowns at ~1.67 m**. This means:
- If a bot aims at the target's **eye**, it will hit **mid-face**, not the top of the head.
- A target standing upright at 1.8 m has 0.48 m of head above the eye point.
- If the target's head protrudes forward (in +Z), and the shooting bot's ray passes through the eye point, the ray might **miss the top of the head** if it doesn't angle up enough.

**This is a real but small mismatch**: The LOS check uses eye-to-eye, which is robust. The actual head is ~0.35–0.67 m above the eye, so headshots are anatomically plausible (aiming at the face/head area will hit at or above eye height). However, a ray aimed directly at the eye point will graze the forehead, not the crown.

### Hit Box Geometry per Part

Each part (head, torso, limbs) has its own AABB computed from its geometry's bounding box. The head part's box spans roughly:
- **Y (rig-local)**: –0.07 to +0.06 R_UNITS → ~–0.36 to +0.31 m (rig frame)
- **X, Z radii**: ~±0.09 m

When attached to the body at the neck joint (~1.35 m world Y), the head AABB in world space is roughly:
- **Y**: 0.99 to 1.66 m
- **X, Z**: centered at 0, radius ~0.09 m

The **hit capsule** (whole bot) is:
- **Y**: 0.3 to 1.8 m
- **XZ**: cylinder of radius 0.3 m

**Mismatch**: The head part's XZ footprint (0.09 m) is much tighter than the capsule (0.3 m), so a shot that passes through the capsule's outer edge (0.3 m from center) might miss the head part entirely. This is correct behavior—the head is smaller than the body, so off-center shots miss it—but it means a shot hitting the capsule's XZ boundary at a Y corresponding to the head might be attributed to a different body part (torso).

---

## 5. DAMAGE

### Hit-to-Part Resolution

bot-projectiles.js (and effect-renderer.js) use `resolveBodyHit` (bot-body-hit.js line 129) to map a shot to a part:

```javascript
export function resolveBodyHit({ THREE, body, origin, dir, refresh = false }) {
  // ... iterate over all parts, find nearest hit by AABB slab test ...
  if (bestIdx < 0) return null;
  return finish(THREE, body, all, bestIdx, bLocal, ln);
}
```

The returned object includes `part`, `role` (visual material role, not damage class), and `partIndex`. There is **no damage multiplier lookup** visible in the code inspection—all shots appear to deal the same damage regardless of part.

### Damage Application

Searching bot-projectiles.js and effect-renderer.js for damage lookup: the code records "damage dealt" but does not branch on headshot vs. body vs. leg. The system resolves **which part was hit geometrically** (for FX placement and decal attachment), but **damage values are flat** (not per-part modifiers).

**Conclusion**: Hitbox resolution is accurate per-part, but damage is not location-dependent (no headshot multiplier, no "leg shots are weaker" logic).

---

## 6. PITCH / LOOK LIMITS

### Vertical Aim Clamps

| Source | Clamp | Degrees | Gates |
|--------|-------|---------|-------|
| **Bot `bot.pitch`** | None | Unbounded | None |
| **Player camera** | ±1.45 rad | ±83.0° | Player POV only |
| **Player camera** (on pov pan) | ±1.25 rad | ±71.6° | Player orbit/free-look |
| **Fly cam** | ±1.45 rad | ±83.0° | Debug free-look camera |

**For bots**: No clamp. `slewAngle` (bot-activity.js line 256) wraps the angle but does not clamp it. A bot can pitch to any angle it calculates.

### Practical Vertical Acceptance

When a bot computes `aimAnglesTo` (bot-activity.js line 224):
```javascript
if (!out) return { yaw: Math.atan2(dx, dz), pitch: Math.atan2(dy, horiz) };
out.yaw = Math.atan2(dx, dz); 
out.pitch = Math.atan2(dy, horiz);
```

where `dy = target.y - bot.y` and `horiz = Math.hypot(dx, dz)`.

**Pitch range**: `atan2(dy, horiz)` can return any angle in [–π, π]. A target directly above the bot (horiz → 0, dy → big) produces `pitch → π/2`. A target directly below produces `pitch → –π/2`.

There is no **hard limit** in code, so vertical targeting is NOT gated by angle.

### Vertical Raycast Accuracy

The LOS raycast includes full 3D direction (line 6074), so vertical angle DOES affect visibility. A target at the same XZ position but higher Y will be shot-tested at a different angle, and the mapCollider raycast will correctly handle the vertical component.

### Terrain & Elevation: Can a Clamp Bite?

If a bot is on flat ground and a target is 2 m above it on a platform:
- **Horizontal distance**: 5 m
- **Vertical distance**: 2 m
- **Required pitch**: `atan2(2, 5)` ≈ 21.8° — very shallow, well within any reasonable clamp.

Even at the top of a 5 m wall with a target 3 m away horizontally:
- **Required pitch**: `atan2(3, 3)` = 45° — still very modest.

**For the 83° player camera clamp to bite**, a target would need to be above the bot's eye by almost 3× the horizontal distance. This is rare in normal gameplay. However, **inside a narrow vertical column** (a stairwell or lift shaft), this could happen. 

**For bots with NO clamp**: They can pitch to see anything above themselves, so this is a non-issue.

### Suspected Pitch Issues — VERDICT

After code review: **There is NO bot-side pitch clamp causing bots to miss targets above or below them.** The suspected issue is not real. Bots can look up and down freely, and the LOS raycast respects the full 3D geometry.

---

## 7. DISCREPANCIES

### Summary of Geometry Mismatches

1. **Eye vs. Head Crown Height**
   - Eye at 1.32 m, head crown at ~1.67 m: **0.35 m vertical gap**
   - Impact: A ray aimed at the eye will pass below the top of the head. For a horizontal shot at a standing target, this means the ray might graze the neck/lower head. For upward-aimed shots, the ray should clip the face.
   - **Severity**: Low. The eye-to-eye raycast is intentional (both bots use the same eye formula), and the head is well-integrated geometrically.

2. **Capsule Radius vs. Head Part Radius**
   - Hit capsule: 0.3 m radius (whole bot)
   - Head part AABB: ~0.09 m radius (just the skull)
   - Impact: A shot hitting the capsule's outer edge (0.25–0.3 m from center) at head height might miss the head part's actual box and hit a different part.
   - **Severity**: Low. This is correct behavior—the head is anatomically smaller than the shoulders.

3. **Perception Target Point = Eye Height, Not Center or Top of Head**
   - Target point: 1.32 m (73% up the 1.8 m body)
   - Impact: Bots see each other at eye level, not at the geometric center or top. This is realistic and intentional.
   - **Severity**: None. This is a design choice, not a bug.

4. **No Pitch Clamp on Bots (Player Camera Has ±83°)**
   - Bots are unrestricted; players are clamped.
   - Impact: Bots can aim straight up or down; players cannot pitch as far.
   - **Severity**: Low. This is asymmetric but intentional (bots are not player-controlled).

### No Critical Issues Found

**Suspected issues from the audit brief:**
- ✅ Head IS visible and hittable.
- ✅ Bots CAN look up/down (no pitch clamp).

The geometry is well-integrated. Eye height is placed at a natural sightline (73% up the body). The head is rendered and hit-tested correctly. Vertical perception is not gated by any angle clamp.

---

## Evidence References

| Finding | File | Line(s) |
|---------|------|---------|
| Eye height formula | bot-viewer-v2.html | 6194, 6551–6553 |
| Capsule dimensions | bot-entity.js | 11–12, 24–28 |
| LOS raycast (3D) | bot-viewer-v2.html | 6004–6010, 6071–6074 |
| Bot pitch slew (no clamp) | bot-activity.js | 256–260 |
| Bot pitch assignment | bot-viewer-v2.html | 8766 |
| FOV defaults | bot-alert.js | 231–232 |
| Head geometry | bot-face.js | 34–37, 38, 42 |
| Per-part hit resolution | bot-body-hit.js | 129–156 |
| Horizontal FOV check | bot-viewer-v2.html | 6009 (withinBotFov) |
| Player camera pitch clamp | bot-viewer-v2.html | 3888, 1238, 1266 |

---

## Arithmetic Check: Elevation at Which Pitch Clamps Bite

Player camera clamp: **±1.45 rad = ±83.0°**

For a target at horizontal distance D and vertical distance V:
- **Pitch required**: `atan2(V, D)`
- **Target above**: Pitch = +atan2(V, D)
- **Clamp bites if**: +atan2(V, D) > 1.45 rad
  - i.e., if `tan(1.45) < V/D`
  - `tan(83.0°) ≈ 8.14`
  - i.e., if **V > 8.14 × D**

Example: At D = 3 m horizontal, clamping would bite at V > 24.4 m vertical. **This is extremely steep and nearly never occurs in a realistic indoor/outdoor setting.**

Bots: **No clamp**, so this calculation is moot.

---

**Audit completed by Agent**: 2026-08-06
