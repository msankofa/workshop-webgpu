# Bot Visibility, Hitbox, and Damage Audit — 2026-08-06

**AUDIT DATE:** 2026-08-06  
**AUDITOR:** Claude Code (read-only investigation)  
**SCOPE:** bot-viewer-v2.html and supporting modules  
**VERDICT:** Visibility and hitbox are MISALIGNED by ~0.16 m; NO vertical (pitch) clamp; damage is flat (no headshots).

---

## TOP 3 CONCLUSIONS

1. **HEAD HITBOX MISMATCH (CRITICAL):** The bot's eye used for spotting is at y = +1.32 m, the head geometry center is at y = +1.16 m, and the damage capsule wraps both. The ~0.16 m mismatch means a shot placed visually on the helmet may register as body damage at a different part of the rig, and sight-line tests to the head position won't match visibility of the head itself.

2. **NO PITCH CLAMP ON AIMING OR LOS:** Bots can aim at any vertical angle (including straight up or down); LOS checks are full 3D from eye to eye; FOV cone is horizontal-only (never limits vertical FOV). No playable disadvantage detected, but targets above/below have the same visibility as those at eye level if horizontally within the cone.

3. **FLAT DAMAGE (NO HEADSHOTS):** Every hit applies the raw weapon damage with no per-part multiplier, location bonus, or headshot scaling. The damage code (`applyBotDamage`) applies damage amount directly (`target.health -= amount`) with no location lookup.

---

## 1. PERCEPTION GEOMETRY

**Eye Height on Viewer (Bot A looking at Bot B):**
- Eye position: `capsule.start + (capsule.end - capsule.start) * EYE_LIFT`
- `EYE_LIFT = 0.85` (bot-viewer-v2.html:6194)
- Capsule start: `spawnPos.y + radius` = `spawnPos.y + 0.3`
- Capsule end: `spawnPos.y + standHeight - radius` = `spawnPos.y + 1.8 - 0.3` = `spawnPos.y + 1.5`
- Capsule height: `1.5 - 0.3 = 1.2 m`
- **Eye height: `0.3 + (1.2 * 0.85)` = `0.3 + 1.02` = `1.32 m` above spawnPos.y**

**Target Point on Bot B (Perception Test):**
- Same eye position used: **bot B's eye at 1.32 m**
- Both bots tested eye-to-eye (bot-viewer-v2.html:6004-6005)

**LOS Check (Hitscan Raycast):**
- Full 3D raycast from bot A's eye to bot B's eye (bot-viewer-v2.html:6073-6074)
- Direction: normalized vector from A's eye to B's eye
- Distance tested: `distance - 0.02` (0.02 m clearance)
- Collision check: `mapCollider.raycast([origin.x, origin.y, origin.z], [dirX, dirY, dirZ], distance - 0.02)`
- **This is true 3D LOS; it can fail if terrain or geometry blocks the ray at any height**

**FOV Cone:**
- **Horizontal only** (bot-viewer-v2.html:5949-5959, `withinBotFov`)
- Default: `botBehaviorSettings.fovDegrees` (configurable, user slider)
- Alert tier widening: `TIER_FOV_WARY = 140°`, `TIER_FOV_ALERTED = 160°`
- **NO vertical pitch component in the FOV gate**
- The check is: `cosToTarget >= Math.cos(degToRad(deg) * 0.5)`
- This is purely horizontal; a target above or below at the same horizontal distance reads as "in cone" if horizontally within the arc

**Perception Prefilter (2D Visibility Field):**
- Baked 2D field at eye height: `fieldSaysHidden(ax, az, bx, bz)` uses only X and Z
- Nav grid cells quantize to walkability, not height
- Field errs toward visible; used only as a conservative prune
- Actual LOS fallback: full 3D raycast if field says visible or if field is absent

**Scan Interval:**
- `TARGET_SCAN_STRIDE = 4` frames (bot-viewer-v2.html:5966)
- Alert tiers can halve this: `TIER_STRIDE_ALERTED = 2` (bot-alert.js:234)
- Current target confirmed every frame with a raycast even if scan is due

**Summary for Perception:**
- Bot tests eye-to-eye, both at **1.32 m** above ground
- Horizontal FOV cone only; **NO vertical clamp at all**
- 3D LOS raycast after horizontal gate passes
- **Verdict: Bots CAN see targets above/below them; no pitch penalty**

---

## 2. HIT GEOMETRY

**Capsule (Damage Target):**
- Type: `Capsule` (three.js, bot-entity.js:31)
- Radius: `DEFAULT_RADIUS = 0.3 m` (bot-entity.js:11)
- Height (shaft, not including caps): `DEFAULT_STAND_HEIGHT - 2*radius` = `1.8 - 0.6` = `1.2 m`
- Start (bottom): `spawnPos.y + radius` = `spawnPos.y + 0.3 m`
- End (top): `spawnPos.y + standHeight - radius` = `spawnPos.y + 1.5 m`
- **Extends from 0.3 m to 1.5 m; total height 1.2 m + two radius caps = 1.2 + 0.6 = 1.8 m total**
- Anchored at bot's XZ center (`capsule.start.x/z` and `capsule.end.x/z` track bot position)

**Hitscan Resolution:**
- Weapon fire uses `mapCollider.raycast()` (bot-viewer-v2.html:10130)
- Path: ray origin at shooter's eye, direction toward target's eye
- Target test: simple raycast vs map geometry, **NOT against the bot's own capsule**
- **Bots test mutual LOS the same way; no bot-vs-bot collision volume in the raycast**

**Hit Decal Attachment (Per-Part):**
- After a shot hits, the impact is resolved to the nearest body part (bot-body-hit.js:128-156, `resolveBodyHit`)
- Parts are lathe-surface cylinders and boxes from the rig
- Decal placement uses AABB slab test in each part's local space
- **This resolves WHERE the visual decal lands, NOT whether a hit counts**
- Example (bot-body-hit.js:2-5): "a limb hit reports a surface point several centimetres off the mesh"

**Per-Part Damage:**
- **Damage is NOT per-part** (see section 5 below)
- The damage amount is applied flat to `target.health` with no location lookup
- Part resolution exists only for visuals (blood spray placement, decal attachment)

**Summary for Hittable Volume:**
- Damage resolves to a **single 0.3 m radius cylinder** from y=0.3 to y=1.5 m
- Hitscan is pure raycast vs map geometry, not vs capsule mesh
- Per-part hit detection exists only for **decal and particle placement, not damage**
- **Verdict: There is ONE hittable volume, not per-part**

---

## 3. VISUAL GEOMETRY

**Body Height:**
- Total bot height: **1.8 m** (default, from `DEFAULT_STAND_HEIGHT`)
- Capsule extent: 0.3 m to 1.5 m (within the 1.8 m total when accounting for the 0.3 m radius caps)

**Head Position (Rig Joint):**
- Head is positioned at: `pelvisY + height * design.headYRatio`
- `design.headYRatio = 0.48` (player-procedural-body.js:513)
- Pelvis base: `spawnPos.y + radius` = `spawnPos.y + 0.3`
- **Head joint center: `0.3 + (1.8 * 0.48)` = `0.3 + 0.864` = `1.164 m`**

**Head Mesh Extents (Helmet + Skull):**
- Head profile (inner skull): y range from -0.068 to +0.062 m (bot-body-design.js:205-207)
- Head total extent: roughly ±0.065 m (after lathe radial profile)
- **Skull extent: ~1.099 to ~1.229 m vertically** (1.164 ± 0.065)
- Helmet gear (MARK_VII): visor at z~0.104 m depth, mandible, brow, side plates, crown crest
- **Helmet silhouette width: ±0.12 m (skull radius 0.118 m from profile max)**
- **Helmet silhouette depth (Z): ~0.15 m front-to-back** (visor/brow front at 0.104 m to back vents)

**Torso (Chassis + Armor):**
- Torso position: `pelvisY + height * design.torsoYRatio` = `0.3 + (1.8 * 0.22)` = `0.3 + 0.396` = `0.696 m`
- Torso shell width: ±0.21 m (from gear design, chest block 0.42 m wide)
- Torso shell depth: ±0.18 m (chest 0.36 m deep)

**Limbs:**
- Shoulder joints roughly 0.5–0.7 m high
- Elbow ~0.4–0.5 m high
- Hips ~0.3–0.5 m high
- Knees ~0.15–0.25 m high
- Feet ~0–0.1 m (boot extends to ankle)

**Summary for Visual Geometry:**
- **Head (skull + helmet): 1.099–1.229 m tall, ±0.12 m wide, ±0.075 m deep**
- **Eye position: 1.32 m** (ABOVE the head by ~0.09 m visually)
- **Torso: 0.5–0.85 m tall, ±0.21 m wide, ±0.18 m deep**
- **Full bot: 0.0–1.5 m tall** (capsule end), with helmet graphics up to ~1.3 m
- **Verdict: Head is BELOW eye height; eye floats inside/above skull visually**

---

## 4. OVERLAP ANALYSIS

**Comparison: Visible vs Hittable vs Perceptual**

| Aspect | Position (m) | Radius/Width | Status |
|--------|--------------|--------------|--------|
| **Bot eye (perception)** | 1.32 (Y) | – | Reference point; used for both spotting and damage LOS |
| **Head center (visual)** | 1.164 (Y) | 0.065 (half-height) | BELOW eye by 0.156 m |
| **Head top (visual)** | ~1.229 (Y) | – | BELOW eye by 0.091 m |
| **Capsule top (hittable)** | 1.5 (Y) | 0.3 (radius) | ABOVE eye by 0.18 m |
| **Capsule bottom (hittable)** | 0.3 (Y) | 0.3 (radius) | Below head |

**Mismatch Detail:**

1. **Eye vs Head (Visual Misalignment):**
   - Eye at 1.32 m is **0.156 m above head center** (1.164 m)
   - Head top at ~1.229 m is still 0.091 m below the eye
   - **A shot placed visually on the helmet crown will have its raycast origin from 0.09 m above it**
   - Risk: Headshots appear to hit the helmet but LOS ray starts above the visible head

2. **Capsule vs Head (Hittable Misalignment):**
   - Capsule extends 0.3–1.5 m; head is 1.1–1.23 m
   - **Head is well within capsule vertically**
   - But capsule radius (0.3 m) is LARGER than head width (~0.12 m)
   - **Horizontal mismatch: capsule is 2.5× wider than the head**
   - A shot 0.2 m to the side of the visible head (beyond head width ~0.06 m each side = 0.12 m total) but within 0.3 m capsule radius will hit the capsule and deal damage, appearing to hit thin air

3. **Hittable vs Perceptual (Eye Position):**
   - Perception tests eye-to-eye (both at 1.32 m)
   - Damage capsule wraps 0.3–1.5 m (eye is at 0.85 × 1.2 m = 1.02 m + 0.3 m start = 1.32 m, which is 0.18 m ABOVE capsule end)
   - **Eye sits 0.18 m above the hittable volume**
   - A bot can see a target's eye (LOS checks eye), but the damage volume ends 0.18 m below where the eye is

**Quantified Mismatches:**

- **Eye height above head center:** 0.156 m (13% of head height)
- **Capsule radius vs head width:** 0.3 m vs ~0.12 m (2.5× larger)
- **Eye height above capsule end:** 0.18 m (15% of capsule height)

**Verdict:**
- Spotting, LOS, and damage all converge on eye-to-eye tests, so they're self-consistent
- BUT the eye is placed ABOVE and OUTSIDE the visible head geometry
- A shot visually aimed at the head may hit based on eye-to-eye LOS, but feels off because the eye is not at the head
- **Net risk: Headshot feedback will feel disconnected from visual head location**

---

## 5. DAMAGE

**Damage Application Path:**

1. **Shot fired** → `fireBotShot()` (bot-viewer-v2.html ~9844)
2. **LOS raycast** → `mapCollider.raycast([origin], [dir], distance)`
3. **If hit** → `applyCombatDamage(weapon.damage ?? 0, hitPoint, target, now, source)`  
   (bot-viewer-v2.html:10130)
4. **Damage applied** → `applyBotDamage(amount, hitPoint, target, now, source)` (bot-viewer-v2.html:5775)
5. **Health deducted** → `target.health -= amount` (bot-viewer-v2.html:5782)
   - Formula: `target.health = Math.max(0, target.health - Math.max(0, amount))`
   - **No multiplier, no modifier, no part lookup**

**Per-Part Damage:**
- **DOES NOT EXIST in damage calculation**
- Part resolution happens AFTER damage for visual FX only:
  - `resolveBodyHit()` (bot-body-hit.js:129) locates which part was hit for decal placement
  - Used in `emitBotDamaged()` callback which triggers visual effects, sounds, and blood decal attachment
  - **The part is determined post-hoc for rendering, not for damage modulation**

**Headshot Multiplier:**
- **NO headshot multiplier**
- All damage is flat weapon damage
- `weapon.damage` is applied directly without bonuses
- Example (bot-viewer-v2.html:5782): `target.health = Math.max(0, (target.health ?? DUMMY_MAX_HEALTH) - Math.max(0, amount))`

**Source Tracking (Informational Only):**
- `source` parameter contains `{ weaponId, cause, attacker, origin, normal }`
- Used for logging and UI (POV hitmarker, voice lines, state trace)
- **Does NOT affect damage calculation**

**Summary for Damage:**
- **Damage is flat; weapon damage applied directly to health**
- **No per-part damage system**
- **No headshot multiplier**
- **No location-based scaling**
- **Verdict: All hits deal the same damage regardless of where on the body they land**

---

## 6. PITCH / LOOK LIMITS

**Bot Aiming:**
- Target yaw/pitch computed by `aimAnglesTo(from, to, out)` (bot-activity.js:221-226)
  - `pitch = atan2(dy, horizontal_distance)` — full range [−π/2, π/2]
- **No clamp on computed pitch**
- Applied via `faceAimDirection(targetYaw, targetPitch, dt)` (bot-viewer-v2.html:8763-8766)
  - Uses `slewAngle(current, target, maxDeltaRad)` (bot-activity.js:256-260)
  - `slewAngle` wraps angles; **does NOT clamp**
- **Verdict: Bot pitch can be any value; no upward/downward look limit**

**Camera Pitch (Player POV, not bot aiming):**
- Camera pitch clamped to `[-1.45, 1.45]` rad (bot-viewer-v2.html:1266, 3888)
- **This is camera comfort, not bot perception or aiming; not gameplay-relevant for bots shooting each other**

**Head/Neck Bone Pitch:**
- Head rotates with `bot.pitch` in rendering (via neck/head joint animation)
- No clamp on `bot.pitch` before use in inverse kinematics or bone rotation
- **Neck can bend to any angle**

**Weapon Muzzle Pitch:**
- Muzzle position derived from weapon pose controller (weapon-pose-controller.js)
- Muzzle inherits bot's pitch (via weapon joint)
- **No pitch clamp**

**LOS Vertical Acceptance:**
- FOV cone is **horizontal only** (withinBotFov, bot-viewer-v2.html:5950-5959)
- No vertical acceptance test; a target above or below at same horizontal angle reads as "in FOV" if horizontally within cone
- LOS raycast is 3D eye-to-eye, so a target high above or far below can fail LOS if terrain occludes it, but there's no **angle-based** vertical rejection

**Elevation Difference Calculations:**

Scenario: Bot A at ground level (eye at y=1.32) trying to see/shoot Bot B on an elevated structure.

- If B is 2 m higher (eye at y=3.32):
  - Vertical angle: `atan2(2.0, horizontal_distance)` rad
  - At 10 m horizontal: `atan2(2.0, 10.0)` ≈ 0.197 rad ≈ 11.3°
  - At 5 m horizontal: `atan2(2.0, 5.0)` ≈ 0.381 rad ≈ 21.8°
  - **No clamp prevents these angles; bot aims and shoots normally**
  
- If B is 2 m lower (eye at y=-0.68, underground or in pit):
  - Vertical angle: `atan2(-2.0, horizontal_distance)` rad (negative pitch)
  - Same magnitude as above, opposite sign
  - **No clamp; bot aims down normally**

- FOV cone (horizontal): If set to 120°, the bot sees anything within 60° left/right of its yaw
  - A target 45° to the left but 30° up: horizontally 45° from yaw → **within FOV (45° < 60°)**
  - The vertical 30° is never checked
  - **Verdict: Vertical angle is irrelevant to visibility once horizontal FOV passes**

**Summary for Pitch/Look:**
- **No vertical aim clamp; bots can aim straight up or down**
- **No vertical component to FOV cone; vertical angle is irrelevant to visibility**
- **3D LOS raycasts; if terrain blocks, LOS fails; no angle-based vertical rejection**
- **On stairs or elevated terrain: bots see each other if horizontal angle is in cone AND 3D LOS is clear**
- **Verdict: NO gameplay disadvantage from pitch clamps; bots have full vertical aiming freedom**

---

## 7. DISCREPANCIES (Ranked by Impact)

| Rank | Issue | Files | Impact | Severity |
|------|-------|-------|--------|----------|
| **1** | **Eye floats 0.156 m above head center** | player-procedural-body.js:513, bot-viewer-v2.html:6194, 6548 | Headshot feedback visually disconnected; LOS origin doesn't align with helmet position | **MEDIUM** |
| **2** | **Capsule radius (0.3 m) is 2.5× head width (0.12 m)** | bot-entity.js:11, 26–28, bot-body-design.js:205–207 | Shots miss the head visually but hit the capsule; phantom damage to the side | **MEDIUM** |
| **3** | **Eye height is 0.18 m ABOVE capsule end** | bot-entity.js:27–28, bot-viewer-v2.html:6194, 6548 | Damage LOS originates above the hittable volume; feels geometrically odd | **LOW** |
| **4** | **Per-part hit detection is decal-only** | bot-body-hit.js:1–15, bot-viewer-v2.html:5775–5812 | Player expects part-based damage; gets flat damage instead; feedback mismatch | **LOW** |
| **5** | **No headshot multiplier** | bot-viewer-v2.html:5775–5812 | Headshots deal same damage as body shots; breaks tactical depth expectation | **LOW** |
| **6** | **2D visibility field is conservative** | bot-viewer-v2.html:6219–6224, nav-visibility.js | Baked field only uses X/Z; vertical occlusion not pre-tested; fallback to 3D raycast works but may be slow on edge cases | **NEGLIGIBLE** |
| **7** | **No vertical pitch clamp** | bot-activity.js:221–226, bot-viewer-v2.html:8763–8766 | Not a bug; bots can aim up/down fully; may feel overpowered but is intentional | **NONE** |

---

## File References

- **bot-viewer-v2.html** — Main harness
  - Line 6194: `EYE_LIFT = 0.85`
  - Line 6548: `eyePos()` uses `EYE_LIFT`
  - Line 5950–5959: `withinBotFov()` checks horizontal cone only
  - Line 6073–6074: 3D LOS raycast `mapCollider.raycast()`
  - Line 5775–5812: `applyBotDamage()` applies flat damage
  - Line 8763–8766: `faceAimDirection()` sets pitch with no clamp

- **bot-entity.js** — Bot capsule and physics
  - Line 11: `DEFAULT_RADIUS = 0.3`
  - Line 12: `DEFAULT_STAND_HEIGHT = 1.8`
  - Line 26–28: Capsule construction

- **bot-body-design.js** — Visual body geometry
  - Line 205–207: Head profile lathe points
  - Line 513 (player-procedural-body.js): `headYRatio = 0.48`

- **bot-activity.js** — Aiming math
  - Line 221–226: `aimAnglesTo()` computes pitch without clamp
  - Line 256–260: `slewAngle()` turns toward target without pitch clamp

- **bot-body-hit.js** — Per-part hit detection
  - Line 1–15: Purpose statement (decal placement only)
  - Line 128–156: `resolveBodyHit()` finds part for visuals

- **player-procedural-body.js** — Rig positioning
  - Line 513: `headYRatio = 0.48`
  - Line 1778: Head position calculation

- **bot-alert.js** — Perception tiers
  - Line 231–232: `TIER_FOV_WARY = 140°`, `TIER_FOV_ALERTED = 160°` (horizontal only)
  - Line 234: `TIER_STRIDE_ALERTED = 2` (scan interval halved when alerted)

---

## Recommendations

1. **Consider moving eye down to head center** (1.164 m) so LOS ray originates where the helmet is visible. This is a **rigging change**, not code.

2. **Document that capsule is a damage volume, not a visual hull.** The mismatch is acceptable if players understand it's a hitbox, not a collision mesh.

3. **If implementing headshots:** Add a check in `applyBotDamage()` to test if hitPoint is within head bounds (lathe profile extents + helmet gear bounds) and apply a multiplier (e.g., 1.5×).

4. **Investigate per-part damage:** `resolveBodyHit()` already works; damage could be tuned per `part._role` (shell, plate, etc.) if desired.

5. **No action needed on pitch clamp.** Bots have full vertical aiming freedom, which is intentional and balanced.

---

**END AUDIT**
