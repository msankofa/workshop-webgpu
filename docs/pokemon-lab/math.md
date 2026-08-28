# Pokémon Lab: the math

Every number the lab quotes, what computes it, and how far it can be trusted.

The code is `pokemon-pose.js`, tested by `test-pokemon-pose.mjs` (29 checks). It was a scratchpad probe
until 2026-08-28, which was itself a problem — the figures below were unreproducible the moment a temp
directory got cleaned.

Each claim is marked **measured** (computed from the files), **inferred** (a reading of measured numbers) or
**eyeballed** (a person looking at a printed curve). Treat them differently.

> **Three corrections landed on 2026-08-28**, all detailed in §6. The metric did not align orientation, so
> a pose facing elsewhere read as far away; fixing it moved almost every figure here, in one case by 3×.
> It compared single frames, so two poses moving in opposite directions scored as identical; windows fixed
> that. And the Pikachu conclusion in an earlier version of this document was stated backwards.

---

## 1. The pose metric

The question it answers: *how far apart are two poses?* Everything about states, transitions and
reachability is built on it.

A pose is one (clip, frame) pair. Frames may be fractional.

### 1.1 Forward kinematics to world positions

Each bone carries a rest local transform — translation `p`, rotation quaternion `q`, scale `s` — read from
its glTF node. A clip may override any of the three. Compose and walk the hierarchy:

```
local(bone)  = T(p) · R(q) · S(s)          # from the clip if animated, else from rest
world(bone)  = world(parent) · local(bone)
world(root)  = pre · local(root)
```

**`pre` is a trap worth stating first.** The pivot tree starts partway down the glTF node tree, and Stadium
files put a **0.1 scale on an ancestor above the root bone**. Composing from the root's own local transform
ignores it and every distance comes out ten times too large:

```
pre = restWorld(root) · inverse(restLocal(root))
```

A uniform scale does not change the *ranking* of poses, so this mistake produces numbers that are
internally consistent and all wrong. `checkRestPose(rig)` is the guard: with no clip applied the computed
positions must reproduce `bone.restWorld`. Worst error on four species is below `1e-6`, and a test asserts
that the un-prefixed version is out by a factor of ten rather than a little.

### 1.2 Interpolation

LERP for translation and scale, SLERP for rotation, between the two surrounding keys.

Three **measured** facts across the whole dex make this safe:

| Fact | Value |
|---|---|
| Interpolation modes in use | `LINEAR` on all **54,503 tracks** in all 1,171 clips. No `STEP`, no `CUBICSPLINE`. |
| Key spacing | Uniform on every track. Worst deviation from a track's own first gap: **0.000000 s**. |
| Tracks with fewer keys than the clip has frames | **11,051 of 54,503 (20.3%)** |

The first means LERP/SLERP is exactly what `AnimationMixer` does, so an offline distance describes what the
viewer shows. The third is why `pokemon-pose.js` has its own `sampleAt` rather than reusing
`pokemon-rig.js`'s `sampleClip`: that one *steps to the nearest key at or before the time*, which is right
for taking a pose a person drew and wrong for measuring one between keys.

### 1.3 Alignment

**This is the step that is easy to leave out, and this document previously did.**

Two poses of the same body can differ only in which way it is facing and where it stands. Those are not
differences in pose. So before measuring, solve for the ground-plane transform — a yaw about the vertical
axis plus a translation in x and z — that **minimises** the distance, and measure under it.

Following Kovar, Gleicher & Pighin, *Motion Graphs* (2002). Translation drops out by centring both clouds
on their weighted xz centroid, which leaves one angle:

```
θ = atan2( Σ wᵢ (aᵢx·bᵢz − aᵢz·bᵢx),  Σ wᵢ (aᵢx·bᵢx + aᵢz·bᵢz) )
```

over the centred coordinates. Both sums vanish only for a cloud with no horizontal extent, where any yaw is
as good as another and zero is used.

**Height is deliberately not aligned.** Crouching is not standing, and sliding poses vertically to match
would erase the difference. A test asserts that lifting a pose by a quarter of body height scores exactly
0.25, while turning it any number of degrees scores zero.

Because the minimisation is over a family that includes "no rotation at all", **an aligned distance can
never exceed the root-centred one**. A test checks that over 100+ pairs.

### 1.4 Windows, which is how direction gets in

A single frame carries no direction. Two poses can match exactly while moving in opposite directions — the
top of a jump matches the top of a fall — and splicing them produces a visible pop that the distance gave
no warning about.

The fix is to compare a run of `k` consecutive frames as one point cloud, with **one** alignment solved over
the whole window rather than one per frame. That shared transform is the part that matters: a window
turning left cannot be matched to one turning right, because the same yaw has to serve every frame in it.

No new distance function is needed. Concatenate `k` poses and tile the bone weights `k` times, and §1.3 and
§1.5 operate on the larger cloud unchanged.

A window that does not fit inside its clip is **null**, not clamped or shortened. Repeating the last frame
would make the end of every clip look motionless and match anything else motionless, and a short window is
not comparable to a full one. A frame near the end of a clip simply has nothing to blend with, and saying
so is the honest answer. The cost is `k − 1` frames per clip.

`step: -1` reads a window backwards, which is how the same pose leaving in the other direction is measured.

**Default `length` is 5** (0.17 s at 30fps). Kovar uses roughly 0.25–0.33 s; shorter is chosen here because
Stadium clips are short and some states are brief, and because 5 already separates direction cleanly
(§3.7). It is a parameter, and §3.7 shows what changes across 1, 3, 5, 9 and 15.

### 1.5 Weighted RMS displacement

```
              ┌                          ┐
              │  Σᵢ wᵢ · ‖aᵢ − bᵢ‖²      │  ½
d(A, B)  =    │  ───────────────────     │      ÷  height
              │       Σᵢ wᵢ              │
              └                          ┘
```

- `aᵢ`, `bᵢ` — world position of bone `i`, after §1.3
- `wᵢ` — vertex count of the mesh skinned to bone `i`
- `height` — `rig.units.height`, which is `topY − floorY` over all skinned vertices at rest

**A value is the mass-weighted RMS bone displacement as a fraction of body height.** `d = 0.22` means
bones sit, in RMS, 22% of the creature's height away from where the other pose puts them.

The weights are sound in a way that is easy to miss: **skinning is rigid on all 151 models — one bone per
vertex at weight 1.0** — so each bone owns a definite, unambiguous lump of mesh. What the weight is *not*
is mass: it is mesh density, so a finely tessellated face outvotes a coarse torso (§5.2). A rig with no
skinned geometry falls back to weighting every bone equally.

---

## 2. Units: one frame of motion

A raw distance is hard to read. The natural unit is how much that species moves in a frame:

> **one frame of motion** = median of `d(f, f+1)` over every adjacent frame pair in every clip

**Measured**, aligned:

| Species | One frame of motion | Root-centred, for comparison |
|---|---|---|
| Squirtle | **0.0196** | 0.0333 |
| Pikachu | **0.0057** | 0.0066 |

Squirtle moves about 3.4× as far per frame as Pikachu, which is why this cannot be a shared constant.

Every "N frames of motion" figure is `d ÷ (one frame of motion)`. Read it as a rough blend length: at 30fps,
9 frames is 0.3 seconds. It says how long a transition would have to run to look like it belongs to that
creature's natural pace.

---

## 3. What has actually been measured

All figures **aligned**. Squirtle's target pose is `attack_5` frame 51, inside the shell.

### 3.1 Distance to the in-shell pose, nearest frame per clip

**Measured.**

```
0.175  entrance        @27      ~9 frames of motion
0.194  faint           @54     ~10
0.275  attack_2        @23     ~14
0.290  attack_default   @5     ~15
0.302  attack_4         @8     ~15
0.320  attack          @46     ~16
0.324  attack_3         @8     ~17
0.340  idle            @15     ~17
0.340  anim1           @15     ~17
```

Baseline: the mean distance between two arbitrary Squirtle frames is **0.687**, max **2.320**.

### 3.2 Isolation, which is the statistic that matters

**Inferred.** How reachable a pose is depends on how it compares to that species' own spread, not on the
raw number:

```
isolation = (nearest frame elsewhere) ÷ (mean distance between two arbitrary frames)
```

| Pose | Nearest | Mean pair | Isolation |
|---|---|---|---|
| Squirtle in-shell | 0.175 | 0.687 | **0.25** |
| Pikachu fainted | 0.183 | 0.190 | **0.96** |

The two raw distances are nearly identical. The difference is entirely in context: Squirtle has poses far
closer to its shell than a random pose would be, and Pikachu has essentially nothing closer to its fainted
pose than chance. **Reachability varies enormously between states, so a transition system needs both a
blend path and an authored path rather than one strategy.**

In frames of motion — how long a blend would have to run at the creature's own pace — the shell is about
**9 frames** and fainted about **32**.

### 3.3 The curve along `attack_5`

**Measured** (`d(f, target)`, every third frame):

```
 0:0.36   3:0.32   6:0.35   9:0.68  12:0.76  15:0.71  18:0.22  21:0.08
24:0.05  27:0.03  30:0.05  33:0.02  36:0.05  39:0.02  42:0.02  45:0.02
48:0.00  51:0.00
```

Two readings, both **inferred**:

- **The hold starts around frame 20.** From there the value stays between 0.00 and 0.08.
- **Squirtle moves away from the pose before landing in it** — 0.76 at frame 12, against 0.36 at rest. The
  authored transition takes about 20 frames where a direct blend would take 9. **Prefer an authored segment
  over a computed blend**: the animator was not taking the short path, and the short path is not what it
  should look like.

The **internal spread** of a hold is the min and max of this curve over the held frames — a range, not a
variance. For the shell hold it is 0.00–0.08.

### 3.4 The curve along `entrance`

**Measured:**

```
 0:0.36   6:0.59  12:0.28  18:0.31  24:0.20  30:0.18  36:1.08  42:0.45
45:0.22  48:0.20  54:0.21  60:0.24  66:0.29  72:0.21  78:0.34  84:0.36
90:0.29  96:0.29 102:0.38 108:0.40
```

**Inferred:** apart from a real spike at frames 36–39, most of this clip sits 0.18–0.30 from the shell pose
— a broad region rather than a single approach. The minimum is 0.175 at frame 27.

**This is where the metric stops being able to help.** It can say a region is near; it cannot say whether
those frames *are* the in-shell state, a crouch, or something else. No threshold decides that, which is
precisely why a state has to be annotated rather than computed — the same argument as which bones are a
leg.

### 3.5 Pikachu, for contrast

**Measured.** Target is the last frame of `faint`.

| | Aligned |
|---|---|
| Nearest frame in any other clip | **0.183** (`attack_3` @20), about **32 frames of motion** |
| Mean distance between two arbitrary frames | 0.190 |
| Max | 1.360 |

Along `faint` itself the distance sits at 0.33–0.42 for the first ninety frames and only falls to zero over
the last twenty-five, so the clip spends most of its length elsewhere and arrives at the end.

### 3.6 What windowing changes, and what it does not

**Measured.** Nearest frame to the target, at several window lengths. The target frame backs up as the
window grows, because it has to fit.

Squirtle, in-shell:

| Window | Target | Nearest | Mean pair | Isolation | Blend |
|---|---|---|---|---|---|
| 1 | @51 | 0.175 `entrance`@27 | 0.684 | 0.26 | 9f |
| 3 | @50 | 0.176 `entrance`@26 | 0.691 | 0.26 | 9f |
| **5** | @48 | **0.177 `entrance`@26** | 0.734 | **0.24** | 9f |
| 9 | @44 | 0.185 `entrance`@24 | 0.765 | 0.24 | 9f |
| 15 | @38 | 0.208 `faint`@54 | 0.850 | 0.24 | 11f |

Pikachu, fainted:

| Window | Nearest | Mean pair | Isolation | Blend |
|---|---|---|---|---|
| 1 | 0.183 `attack_3`@20 | 0.190 | 0.96 | 32f |
| **5** | **0.186 `attack_3`@18** | 0.207 | **0.90** | 33f |
| 15 | 0.194 `attack_3`@18 | 0.249 | 0.78 | 34f |

**The headline findings are stable.** Both targets sit inside a hold, so their windows are nearly static
and a statically-near frame stays near. That is a check that had not been done before rather than a
foregone conclusion.

Isolation drifts down as the window grows, because the mean pair distance rises faster than the nearest
does. It is therefore window-dependent and only comparable at a fixed length.

### 3.7 The gap was real in the data

**Measured.** Taking every sampled pair that matches as single frames (`d < 0.06`) and re-measuring it as a
5-frame window:

| | Squirtle (142 pairs) | Pikachu (1,546 pairs) |
|---|---|---|
| median window distance | 0.054 | 0.044 |
| over 0.20 | 9.9% | 2.8% |
| over 0.30 | 4.9% | 1.7% |
| max | 0.707 | 0.674 |

**Most static matches are genuine** — the median is close to the single-frame value, so windowing usually
confirms rather than contradicts. The problem is the tail: a few percent are wrong by more than ten times
the median.

Worst individual cases:

```
Squirtle  attack_3@39   vs  attack_3@61        frame 0.009 -> window 0.714   (x82)
Squirtle  attack_default@6 vs attack_default@84 frame 0.042 -> window 0.669   (x16)
Pikachu   attack_4@14   vs  attack_8@10        frame 0.038 -> window 0.670   (x18)
```

Squirtle's `attack_3` passes through effectively the same pose at frames 39 and 61 — 0.009 apart, which is
half a frame of motion — and goes somewhere different each time. A single-frame metric would splice them
with full confidence.

**A 2–5% error rate understates the risk at the point of use.** A search for the *nearest* frame selects on
low distance, which is exactly what a false match scores. The minimiser is drawn toward them.

### 3.8 "Standing reads about 0.36"

**Eyeballed and unverified.** Most Squirtle clips sit at 0.32–0.36 at their start and end, so that is
probably the neutral standing pose. Nothing has checked this against the rendered model. It is the softest
claim in this document and nothing should depend on it.

---

## 4. What has NOT been measured

Squirtle and Pikachu only. Two species out of 151, chosen because they had interesting states, not because
they are representative. The per-species unit already varies 3.4× between them. **Do not assume any
absolute figure here generalises.**

---

## 5. Remaining limitations

In rough order of how likely each is to bite. Two entries that used to head this list are fixed: the
orientation gap (§1.3) and the missing velocity (§1.4).

### 5.1 The weights are mesh density, not mass

Vertex count per bone is exact, since skinning is rigid, but a finely tessellated head counts more than a
coarsely modelled body. Bounding-box or convex-hull volume from `geometry.points` would be closer to mass
and is available.

### 5.2 Every frame of a window counts equally

A window weights its first and last frame the same. Kovar tapers, so the frames nearest the join matter
most, which is closer to what a blend actually does. Adding a per-frame falloff would be a change to
`tileWeights` alone.

### 5.3 A window is a fixed number of frames, not a fixed duration

Every clip in the dex is 30fps (§7), so the two are the same thing here. They would not be for a model
extracted at another rate.

### 5.4 Alignment is global, not per-part

One yaw is solved for the whole body. A creature whose upper body faces one way and lower body another gets
a compromise angle. No Stadium model has obviously needed better.

### 5.5 Isolation uses a sampled baseline

The mean pair distance in §3.2 is computed over a sparse sample of pairs, not all of them. It is a scale
reference, not a precise statistic.

---

## 6. What changed on 2026-08-28, and what was wrong

Recorded because both errors produced confident, plausible output.

### 6.1 The metric did not align orientation

It subtracted the root bone's position and measured. A pose that was merely turned scored as far away.

| | Root-centred | Aligned | Change |
|---|---|---|---|
| Squirtle, one frame of motion | 0.0333 | 0.0196 | **−41%** |
| Squirtle, nearest to in-shell | 0.221 (`entrance`@73) | 0.175 (`entrance`@27) | different frame |
| Squirtle, mean pair | 0.894 | 0.687 | −23% |
| Squirtle, max pair | 4.520 | 2.320 | −49% |
| Pikachu, nearest to fainted | 0.326 (`attack_2`@58) | 0.183 (`attack_3`@20) | **−44%, different clip** |
| Pikachu, mean pair | 0.449 | 0.190 | **−58%** |

Consequences worth naming:

- **41% of what was being counted as Squirtle's frame-to-frame motion was the creature turning.** Every
  "frames of motion" figure was correspondingly deflated.
- **The `entrance` curve was mostly wrong.** It was reported as rising to 2.36 and then settling into a
  basin — "fifty frames of a sustained pose". The rise was rotation. Under alignment those frames are
  0.18–0.28 from the shell, and the shape of the curve is different enough that the basin reading no longer
  stands as stated.
- **Nearest-frame identities moved.** Squirtle's `faint`@54 went from last place to second. Root-centring
  had hidden it because the pose is rotated.

### 6.2 It compared single frames, so it could not see direction

A frame is a shape with no motion attached, so two poses moving apart scored as identical. Fixed with
windows (§1.4), default length 5.

The headline figures barely moved (§3.6) — both measured targets sit inside a hold, so their windows are
nearly static. What the fix bought is protection against a small, severe tail: a few percent of
statically-matching pairs are wrong by over ten times the median (§3.7), and a nearest-frame search selects
on exactly the score a false match gets.

The clearest case in the dex: Squirtle's `attack_3` passes through the same pose at frames 39 and 61, 0.009
apart — half a frame of motion — and leaves in different directions. As 5-frame windows they are 0.714
apart, 82× further. A test pins that pair.

### 6.3 The Pikachu conclusion was stated backwards

The previous version said the fainted pose was *further from every other frame than two random Pikachu
frames are from each other*, citing a nearest of 0.326 against a mean pair distance of 0.449. **0.326 is
smaller than 0.449.** The comparison was read the wrong way round, and the claim was false on its own
numbers before alignment was ever considered.

The finding survives on the isolation ratio in §3.2, which is the statistic that should have been used:
0.96 for Pikachu's faint against 0.25 for Squirtle's shell. That is a real and large difference. The
original sentence was not.

---

## 7. The other measured quantities

Numbers the lab relies on elsewhere, all **measured**, all in `pokemon-rig.js`.

### Frame count and frame rate

```
frames = max(number of keys) over the clip's tracks
fps    = (frames − 1) / duration        when frames > 1 and duration > 0
```

Nothing writes 30 down. The dex happens to be **exactly 30fps on all 1,171 clips** — the manifest's
`seconds` is `frames / 30` rounded to three decimals with no exceptions — but a clip that was not would
report its own rate rather than play at the wrong speed. Frames are well defined because key spacing is
uniform on every track (§1.2).

### `massFraction` on a chain

```
massFraction = (Σ vertex counts in the subtree below the chain's first bone) / totalVertices
```

**3,496 chains across the dex, of which 1,772 carry more than 2%** (median 11 a species, range 3–24). The
2% figure is a caller's threshold, not a fact.

### The rig hash

FNV-1a over `key<parent:vertexCount;` for every bone, in order. 32-bit, hex. It identifies topology, so a
re-extracted model invalidates its annotations loudly rather than applying them to bones that moved.

### The mirror suggestion distance

For each bone, find the bone whose rest centroid is nearest to the x-mirrored centroid:

```
d = ‖(o.x + c.x, o.y − c.y, o.z − c.z)‖ / height
```

Note the `+` on x — that is the mirror. Centroid comes from the bone's skinned vertices, falling back to
its rest world origin, because **bone origins in these files are not anatomical**. Matches beyond
`maxDistance` (default 0.25 body heights) are reported as misses rather than accepted. On Rattata it
matches 4 of 4 with a worst error of 1.0% of body height.

A **suggestion**: it saves clicking, it does not decide, and the declared pair is what gets stored.

---

## 8. Using it

```js
import { readRigFromGLB } from './pokemon-rig.js';
import {
  readPose, poseWeights, poseDistance, frameOfMotion, readAllPoses, nearestPerClip, checkRestPose,
} from './pokemon-pose.js';

const { rig } = readRigFromGLB(fs.readFileSync('models/stadium/007_squirtle.glb'));
if (checkRestPose(rig) > 1e-6) throw new Error('the FK disagrees with the rig');

const weights = poseWeights(rig);
const height = rig.units.height;
const unit = frameOfMotion(rig);                       // this species' own scale

const target = readPose(rig, rig.clips[7], 51);        // in the shell
const rows = nearestPerClip(rig, readAllPoses(rig), target, { skipClip: 7 });
console.log(rows[0].distance / unit, 'frames of motion away');
```

Windowed, which is what anything picking a transition should use:

```js
import { readWindow, readAllWindows, tileWeights } from './pokemon-pose.js';

const LENGTH = 5;
const tiled = tileWeights(weights, LENGTH);            // NOT the plain weights
const target = readWindow(rig, rig.clips[7], 48, { length: LENGTH });
if (!target) throw new Error('no window fits there');  // too near the end of the clip
const rows = nearestPerClip(rig, readAllWindows(rig, { length: LENGTH }), target,
  { weights: tiled, height, skipClip: 7 });
```

`nearestPerClip` takes single poses or windows — the entries have the same shape — but a window must be
given tiled weights, and its default of `poseWeights(rig)` is wrong for one.

`poseDistance(a, b, { weights, height, align: false })` reproduces the old root-centred behaviour. It is
kept only so the difference can be measured, and nothing should be built on it.
