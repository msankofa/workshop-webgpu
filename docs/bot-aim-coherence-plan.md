# Bot aim coherence — plan

Authored 2026-08-11 after a read of the aim path in `bot-viewer-v3.html` and
`player-procedural-body.js`.

> **STATUS 2026-08-12 — all five tracks shipped** in `bot-viewer-v3.html`, `player-procedural-body.js`
> and the new pure module `bot-aim-blend.js`, behind `bots ▸ Aim coherence` (master toggle plus one per
> track). 330 Node assertions in `test-bot-aim-blend.mjs`; full suite 196 green. The numbers are
> untuned — chosen from the rig's geometry, not from watching a bot use them. What actually shipped,
> and the two rig constraints that turned out to matter, is written up in
> `docs/subsystems/bots.md` § "Aim coherence". One deliberate narrowing: **Track D's lead applies
> flight time only**, so hitscan weapons get no lead at all (aiming an instant round ahead of a runner
> misses ahead by exactly the lead). The latency term is a slider defaulting to 0. The turn
> settle/overshoot from Track D was not built — the torso channel's own ease supplies the weight.

**The complaint:** bots don't read as aiming. The weapon rotates onto the target and the body
follows it around.

**The diagnosis:** that is literally what the code does. The barrel solve is the aiming mechanism,
and it is instantaneous; the body is a slow, unrelated follower; the torso has no aim input at all.

---

## 1. What aims today

| Channel | Driven by | Rate | Reaches the target? |
|---|---|---|---|
| Body yaw | `faceAimDirection` → `bot.yaw` | 4.5 rad/s, × stance (0.55 kneel, 0.35 prone), then a spring (`turnCfg` 30/10, maxSpeed 6) | yes, slowly |
| Body pitch | `faceAimDirection` → `bot.pitch` → `state.aimPitch` | same slew | **head only** (`player-procedural-body.js:1775`) |
| Spine / torso | `_spineLean` / `_spineYaw`, fed only by `loco.*` | — | **no** |
| Shoulders | `_shoulderQ` = body yaw + `loco.shoulderYaw` | — | **no** |
| Weapon | `alignMountedWeaponToPoint` | **unbounded, unsmoothed, every frame** | yes, instantly |
| Head yaw | `targetYaw − visualYaw`, the body's own turn residual | rate 18, ±45° | **no** — it anticipates the turn, then recentres |
| Head pitch | `state.aimPitch` | slew | yes |
| Hands | IK from `weaponView` | — | follows the weapon, by stretching |

The author's own comment at `:11550` states the core fact: `updateBotWeaponMount` *"is the only thing
that ever puts pitch on the weapon rig."*

**Why it reads wrong.** On target acquisition the gun is locked on in frame 1. The body needs ~0.7 s
standing, ~1.3 s kneeling, plus spring settle, to catch up. Throughout that window the weapon points
at the target while the torso faces elsewhere and the chest stays vertical regardless of elevation.
The arms bridge the gap by extending, because the shoulders never rotated or pitched.

Three smaller decouplings:

- The mount takes `visualYaw + headYaw`, so pre-solve the gun carries the *head's* anticipation
  offset, not the torso's facing.
- Firing gates on `aimError(bot.yaw, bot.pitch, …) ≤ 0.03 rad` — the entity's angles, derived from
  the **eye**. The round leaves the **barrel**, at the hand. Different origin, different angle.
- Losing sight clears `botHasAimPoint`, the solve stops, and the gun snaps back to its authored hold
  in one frame with no blend.

---

## 2. The reframe

> The barrel solve should stop being the aiming mechanism and become an error-nulling trim.

If the body and torso carry the weapon to within a few degrees, the residual correction is small and
its snap is imperceptible. Every track below serves that one sentence.

---

## 3. Tracks

### Track B — torso aim contribution (the real fix; do this first)

The rig already has the mechanism. `spineOrient(out, frac)` distributes a lean (X) and a yaw (Y)
across waist/torso/neck by a height-ratio gradient (`_spineFrac`, `spineCfg.falloff`). It has no aim
input — only `loco.torsoLean` / `loco.shoulderYaw`.

Add an aim channel to the rig state (`state.aimYaw` relative to body yaw, reusing `state.aimPitch`)
and feed it into the spine alongside the locomotion terms.

**Two constraints found while reading, both of which will bite silently:**

1. **Do not gate it on `_spineLw`.** That weight is `loco ? (1 − pw)(1 − kw) : 0`, so it collapses to
   zero when kneeling or prone — exactly the stances where a braced torso matters most, and exactly
   where the turn rate is slowest and the decoupling worst. The aim contribution needs its own
   weight, independent of the locomotion gate.
2. **`_shoulderQ` must take the same yaw.** Shoulder sockets are placed from `_orient` (+ the
   locomotion shoulder yaw), *not* from `_upperQ`. Twisting the spine without twisting the sockets
   detaches the arms from the chest.

**Do not reparent the weapon mount to the torso joint.** That was tried and documented as a failure
(Contract 6): the torso already carries the stance drop, so mounting to it double-counts every
stance and puts the gun through the floor. Instead, add the torso's *aim rotation only* to the
mount's existing ground-anchored transform — position stays where it is, the gun rides the twist.

Payoff beyond the look: the hands stop stretching, because the shoulders now move toward the target.

Suggested authority split, to be tuned by eye: torso ±35° yaw / ±25° pitch, body yaw takes the
remainder, barrel solve takes only what is left.

### Track C — head look-at (smallest, do it alongside B)

Give the head a real target-tracking yaw instead of only turn anticipation. Add a `state.lookYaw`,
clamped by the existing ±45°, and **blend** with the anticipation term rather than replacing it —
patrol and idle scanning behaviour must not change. Precedence: look at the aim point when there is
one, otherwise keep today's behaviour.

Note the head already inherits `_upperQ`, so once Track B lands the head's own channel must be
expressed *relative* to the twisted spine or the two will sum and overshoot.

### Track A — demote the barrel solve (only after B)

- **A1.** Slerp the correction toward its target at a bounded angular rate instead of applying it
  whole. The muzzle should still move faster than the torso — a real shooter's does — just not
  infinitely faster.
- **A2.** Gate firing on the **rendered barrel's** error rather than the entity's yaw/pitch. This is
  a correctness fix independent of the look: it closes the eye-vs-barrel parallax gap that `:11547`
  already documents as a live problem. Worth doing early even if the rest slips.
- **A3.** Blend the solve out over a few frames when the aim point clears, instead of snapping.

Sequencing matters: A1 before B makes bots slower to land the first shot with nothing gained, because
the residual the solve has to cover is still the whole aim angle.

### Track D — polish (last)

- Lead the aim point by target velocity (`botTarget.velocity` is already to hand); currently the aim
  point is the target's *current* eye, so tracking a mover is a pure follow.
- A small settle/overshoot on the body turn, so acquisition reads as human rather than as a servo.
- Recoil into the body — a brief spine pitch impulse on fire. Recoil is presently weapon-local only,
  so the body does not react to its own gun at all.

---

## 4. Cross-viewer discipline

`player-procedural-body.js` is shared by `environment-viewer.html`, `environment-viewer-v2.html`,
`bot-viewer.html` / `-v2` / `-v3`, `body-preview*.html`, and `bot-design-studio.html`. New state
channels must default to 0 / off so unmigrated callers render exactly as they do now — the same
discipline the kneel work used (default-off flags, trailing optional arguments). Only
`bot-viewer-v3.html` opts in first.

## 5. Testability

Put the authority split — how much of the aim angle goes to body vs. torso vs. head vs. barrel — in
a **pure, THREE-free module** (`bot-aim-blend.js`), matching the repo's existing pattern. Then assert
in Node, without a GPU:

- the channels sum to the commanded bearing, at every clamp boundary;
- each channel stays inside its own clamp;
- the barrel residual tends to zero as body + torso converge (the whole point of the reframe);
- every channel at zero reproduces today's output exactly, so the unmigrated viewers are pinned.

## 6. What testing cannot settle

Whether it *reads* as aiming. The numbers above are starting points chosen from the rig's geometry,
not from having watched a bot use them. Expect to tune the authority split by eye.

---

## Suggested order

1. **A2** — fire on the barrel's error. Small, self-contained, fixes a real accuracy bug now.
2. **B** — torso aim, with the two constraints above. The change that actually fixes the complaint.
3. **C** — head look-at, tuned against B.
4. **A1 / A3** — demote the solve to a trim once there is little left for it to do.
5. **D** — lead, settle, recoil.
