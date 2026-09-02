# Animal movement and behavior: paper notes and repository applications

These notes cover the ten PDFs supplied on 2026-08-30. One of them (`978-3-030-89029-2_13.pdf`) was also supplied in the preceding request; it is reviewed once here. The purpose is not just to summarize the papers, but to separate demonstrated results from proposals, preserve useful methods and equations, and map the useful parts onto this repository's existing movement stack.

One source-handling caveat: `Collective_Intelligence_of_Autonomous_Animals_in_VR_Hunting.pdf` has corrupt embedded text encoding. Its pages were inspected visually, and its contents are also reproduced in the corresponding chapters of `AI Game Design in VR Hunting.pdf`, whose authorship statement identifies the publication. Those thesis chapters were used to cross-check the detailed equations and algorithms. Technical procedures, equations, names, and definitions below are faithfully transcribed or normalized into consistent notation; surrounding prose is summarized rather than copied at length. Obvious source inconsistencies are called out instead of silently preserved.

## Executive findings

1. **Do not build another walker.** `stadium-walker.js` and `creature-locomotion.js` already implement gait timing, stance and swing phases, terrain sampling, support polygons, contact patches, stride constraints, and Stadium-specific world-matrix retargeting. The immediate missing piece is an adapter from a Lab annotation to the map object expected by `createStadiumWalker()`.

2. **Use one walker and compare two inputs.** Run the existing guessed output from `stadium-rig-map.js` and an annotation-derived map through the same walker and `gait-diagnostics.js`. That isolates whether the annotation improves the mapping. Writing a new walker would confound mapper quality with new locomotion code.

3. **Keep locomotion, steering, navigation, and decisions separate.** The VR-hunting work's most reusable idea is its four-layer architecture: locomotion realizes motion; steering produces bounded local accelerations; navigation selects intermediate destinations; decisions choose goals. This matches the repo better than a single behavior function that directly changes both pose and world position.

4. **Foot locking is the first visual criterion.** Multiple papers converge on stance feet remaining fixed in world space, with a simple lifted arc during swing. Complex foot polynomials did not clearly outperform simple arcs. The repo already contains the correct foundation; the Lab proof should measure slip, reach, support, and joint continuity rather than add gait ornamentation.

5. **FABRIK is useful but not proof of anatomical correctness.** It is fast and general, yet can converge to the wrong posture, deadlock, violate segment lengths when constraints are applied poorly, or bend backward when its initialization/pole is wrong. The Lab annotation needs enough semantic information to derive or override a bend plane, and diagnostics must test segment-length invariance and joint continuity.

6. **Behavior blending should be bounded and inspectable.** Arrival, pursuit, flee, separation, leader following, and collision avoidance can all be expressed as preferred velocities or forces. Combine them with explicit weights and a force/acceleration cap, and expose the components to diagnostics. Avoid importing two source errors: distance-proportional threat weighting and ambiguous “exponential” collision weights.

7. **The evidence is uneven.** Some documents report quantitative tests; several are demonstrations, theses, a one-page proposal, or a work-in-progress without participant evaluation. Use their algorithms as design references, not as proof that the resulting animal motion or behavior is perceptually convincing.

8. **Reinforcement learning is later work.** The RL quadruped paper demonstrates a viable controller, but it couples learned locomotion to a simplified pursuit task and requires millions of simulated steps. It is not a sensible substitute for the existing deterministic walker or the annotation adapter. Its value here is in later residual control, recovery, or parameter tuning after deterministic baselines and metrics exist.

## Documents and evidence level

| # | Document | What it actually is | Evidence strength |
|---|---|---|---|
| 1 | `Collective_Intelligence_of_Autonomous_Animals_in_VR_Hunting.pdf` | Published autonomous-animal steering/group-behavior work, also reproduced in the thesis | Algorithms plus visual/trajectory demonstrations; limited formal evaluation |
| 2 | `978-3-030-89029-2_13.pdf` | “Reinforcement Learning for Quadruped Locomotion” | Simulation training and a small reported task comparison; limited statistics |
| 3 | `paper_1.pdf` | “Steering Autonomous Animals in VR Hunting” | One-page outline/extended abstract, not a complete method or experiment |
| 4 | `Blending_Collision_Avoidance_Animation_in_Synthetically_Generated_Locomotion.pdf` | Procedural collision-avoidance animation paper | Timing measurements and demonstrations; weak perceptual evaluation |
| 5 | `AI Game Design in VR Hunting.pdf` | Kangqiao Zhao's 2021 NTU master's thesis | Full architecture and methods; integrates papers 1, 2, and 3's subject matter |
| 6 | `Pedipulation-in-Quadruped-Robots-Using-a-Heuristic-Inverse-Kinematics-Solver-2.pdf` | Heuristic constrained FABRIK inside a whole-body quadruped controller | Simulation target sweep and physical Go1 demonstrations |
| 7 | `Towards_Full_Body_Co-Embodiment_of_Human_and_Non-Human_Avatars_in_Virtual_Reality.pdf` | Work-in-progress full-body co-embodiment prototype | Proof of concept; explicitly not yet evaluated |
| 8 | `Khokhlova_2019_J._Phys.%3A_Conf._Ser._1399_033074.pdf` | AR-600 biped walking-pattern generation using ZMP preview and FABRIK | Simulation timings and generated trajectories |
| 9 | `26231d8f-8b77-4ec1-84af-9f5fde8a0450.pdf` | UCL project report on an immersive VR avatar animation tool | Prototype comparison and design observations; planned dataset judged insufficient |
| 10 | `Inverse_Kinematics_model_lower_body-Motion.pdf` | Wladimir Nabok's 2019 bachelor thesis on lower-body FABRIK from motion capture | Recorded motion trials and numerical reconstruction errors |

### Source key and page locator

Page citations below use the one-indexed **PDF page**, not a journal's printed page number. This avoids ambiguity in documents with covers and front matter.

| Key | Authors / short title | Pages used for the main technical notes |
|---|---|---|
| P1 | Zhao, Lin, and Seah, *Collective Intelligence of Autonomous Animals in VR Hunting* | architecture and dynamics pp. 1–3; individual behavior pp. 3–5; group behavior and evaluation pp. 5–8 |
| P2 | Zhao, Lin, and Seah, *Reinforcement Learning for Quadruped Locomotion* | model and RL method pp. 3–7; experiment and discussion pp. 8–10 |
| P3 | Zhao, Lin, and Seah, *Steering Autonomous Animals in VR Hunting* | p. 1 (the entire extended abstract) |
| P4 | Kalatzis and Moustakas, *Blending Collision Avoidance Animation in Synthetically Generated Locomotion* | definitions and implementation pp. 1–3; results, limits, and conclusion pp. 3–4 |
| P5 | Zhao, *AI Game Design in VR Hunting* | decision layer pp. 23–33; CEM pp. 36–41; animal behaviors pp. 42–59; quadruped IK/RL pp. 64–78 |
| P6 | Tabita, Recchiuto, Simetti, and Sgorbissa, *Pedipulation in Quadruped Robots Using a Heuristic Inverse Kinematics Solver* | constrained FABRIK and controller pp. 3–5; experiments/results pp. 5–7 |
| P7 | Podkosova and Brument, *Towards Full Body Co-Embodiment of Human and Non-Human Avatars in Virtual Reality* | definitions p. 1; implementations pp. 2–3; limitations and proposals pp. 3–4 |
| P8 | Khokhlova, Zhdanov, Bureev, and Kosteley, *Design of the Walking Pattern Generation Software of AR-600 Anthropomorphic Platform* | definitions pp. 2–3; method pp. 3–5; results pp. 6–7 |
| P9 | Bag, *Designing an Immersive Virtual Reality Avatar Animation Software* | problem/IK pp. 3–7; procedural methods pp. 8–12; motion matching and comparison pp. 13–16 |
| P10 | Nabok, *An Inverse Kinematics Model for the Lower Body Motion* | definitions/FABRIK pp. 5–11; capture pipeline pp. 11–18; results and discussion pp. 22–35 |

## Shared architecture and vocabulary

The papers use overlapping words for different levels of control. The following separation keeps the implementation understandable:

- **Decision/behavior selection:** chooses a goal or activity: hunt, flee, graze, follow, sleep, attack.
- **Navigation:** chooses a route or intermediate target around large-scale obstacles.
- **Steering/local motion planning:** converts the current goal and nearby agents/obstacles into a preferred velocity, force, or acceleration.
- **Locomotion:** turns desired body motion into contacts, foot trajectories, body placement, and joint transforms.
- **Inverse kinematics (IK):** solves joint positions or rotations so an end effector reaches a target.
- **Contact scheduling:** decides when each foot is in stance (planted) or swing (moving).
- **Foot locking:** keeps a stance foot fixed in world space while the body moves over it.
- **Support polygon:** convex region spanned by stance contacts; commonly used as a stability approximation.
- **Procedural animation:** produces or modifies motion at runtime instead of playing a complete pre-authored clip.
- **Blending:** mixes two controllers, poses, targets, or forces using an explicit weight.
- **Co-embodiment:** multiple users jointly control one avatar, often with per-part weighted contributions.
- **Pedipulation:** using a leg/foot for manipulation rather than support or locomotion.

### Canonical FABRIK method

Several papers use FABRIK (Forward And Backward Reaching Inverse Kinematics). For joint positions `p_0 ... p_n`, fixed segment lengths `d_i = ||p_{i+1}-p_i||`, root `b`, and target `t`:

1. If the target is unreachable, place every segment along the root-to-target direction:

   `p_{i+1} = p_i + d_i normalize(t - p_i)`

2. Otherwise iterate:

   - Set end effector: `p_n = t`.
   - Backward pass, for `i=n-1...0`:

     `p_i = p_{i+1} + d_i normalize(p_i - p_{i+1})`

   - Restore root: `p_0 = b`.
   - Forward pass, for `i=0...n-1`:

     `p_{i+1} = p_i + d_i normalize(p_{i+1} - p_i)`

   - Stop when `||p_n-t|| <= epsilon` or an iteration limit is reached.

The length-preserving projections are the central invariant. Joint constraints should project a proposed point/direction into a legal region without changing `d_i`. The lower-body thesis shows that constraint implementations can accidentally break this invariant by many centimeters.

## 1. Collective Intelligence of Autonomous Animals in VR Hunting

### Research question and scientific method

The work asks how individual and collective animal behaviors can make VR hunting targets look responsive and coordinated without relying on fixed animation paths. It constructs a layered autonomous-agent system, demonstrates behaviors such as pursuit, flee, group pursuit, group flee, separation, and leader following, and examines generated trajectories in VR scenarios. [P1, pp. 1–8]

The method is primarily **design-and-demonstration**, not a controlled behavioral-science experiment:

1. Define a dynamic animal abstraction with bounded force, torque, velocity, and angular velocity.
2. Implement individual steering behaviors.
3. Compose group behaviors from individual steering plus neighbor information.
4. Connect those behaviors to navigation and locomotion layers.
5. Demonstrate animals responding to hunters and other animals in VR scenes.

The output establishes feasibility and provides reusable algorithms. It does not establish, with participant statistics, that the motion is more believable or that one combination rule is optimal.

### Core model: controlled ellipsoid model (CEM)

An animal is approximated as an ellipsoid with:

- mass `m`;
- moment of inertia `I`;
- position `p` and velocity `v`;
- orientation, angular velocity `omega`;
- bounded steering force `SF` and torque `ST`;
- maximum linear and angular speeds.

Linear update:

`a_t = SF_t / m`

`v_t = clampMagnitude(v_0 + a_t Delta t, v_max)`

`p_t = p_0 + ((v_0 + v_t) / 2) Delta t`

Angular update:

`alpha_t = ST_t / I`

`omega_t = clampMagnitude(omega_0 + alpha_t Delta t, omega_max)`

To request an expected velocity in one time step, the equivalent steering impulse is:

`SF = (m / Delta t) (v_expected - v_0)`

For an ellipsoid rotating about its vertical axis, the paper uses:

`I_zz = m(a^2 + b^2) / 5`

and the corresponding angular impulse/torque request is:

`ST = (I / Delta t) (omega_expected - omega_0)`

To reduce foot sliding during a large mismatch between current heading `h` and velocity `v`, it scales the speed limit by half the included angle `beta`:

`v_max_adjusted = v_max cos(beta / 2)`

`cos(beta / 2) = sqrt((1 + h dot (v / ||v||)) / 2)`

This makes full speed available when heading and velocity agree, slows a perpendicular mismatch, and approaches zero when they oppose. [P1, pp. 2–3]

This distinction is valuable: steering asks for bounded body motion, while locomotion realizes that motion with legs.

### Individual behavior methods

**Navigation/seek.** Set expected velocity to `v_max` in the target direction and derive the force required to change current momentum toward it. The source does **not** specify a slowing/arrival radius; adding an arrival band is a repository refinement needed to prevent overshoot or orbiting. [P1, pp. 3–4]

**Pursuit.** Predict where a moving target will be rather than seeking its current position. One prediction horizon used in the thesis is:

`T = ||p_target - p_agent|| / (v_max + ||v_target||)`

`p_predicted = p_target + v_target T`

The denominator prevents an unrealistically long lead when target speed is low and accounts for the pursuer's own speed limit.

**Flee.** Predict the pursuer's future position and invert the expected direction away from it. In the paper's complete system, threat sight/detection activates the behavior; that activation rule is separate from the steering-force equation. [P1, p. 4]

**Hover.** Maintain a target on a circle ahead of the animal. Add bounded random jitter to the local target, renormalize it to the circle radius, transform it into world coordinates using the current velocity direction and a forward length, then navigate toward it. [P1, pp. 4–5]

**Separation.** Accumulate repulsion from nearby neighbors, commonly weighted by inverse distance:

`F_sep += normalize(p_agent - p_neighbor) / ||p_agent - p_neighbor||`

The singularity must be guarded with a minimum distance or squared-distance epsilon.

### Group behavior methods

**Group pursuit/flanking.** Use multiple virtual targets around the prey: a direct target plus left/right offset targets. Assign pursuers to these targets so a group surrounds instead of forming one tail-chasing line. The prose says the offset is inversely proportional to distance, but the printed algorithm uses `0.7 * distance`; this is another source contradiction and should be resolved by an explicit, capped formation radius rather than copied literally. [P1, pp. 5–6]

**Group flee.** Combine responses to several threats. The source prose says nearer predators should matter more, but its printed weighting is proportional to distance:

`w_i = d_i / sum_j d_j`

That formula gives *farther* threats greater weight and contradicts the stated intention. A compatible correction is inverse-distance normalization:

`w_i = (1 / max(d_i, epsilon)) / sum_j (1 / max(d_j, epsilon))`

The pseudocode also appears to use velocity where position is required while accumulating a group centroid. The intended centroid is:

`c = (1/N) sum_i p_i`

not a sum of velocities.

**Leader following.** Follow an offset point behind a leader, arrive rather than overshoot, and add separation so followers do not collapse into the same location.

**Combination.** Blend steering components and enforce one physical cap:

`F = clampMagnitude(sum_k w_k F_k, F_max)`

The paper discusses weighted blending and prioritized/randomized selection. For this repository, deterministic weighted forces are easier to diagnose; priority should be reserved for hard safety constraints such as imminent collision.

### Applicability here

- Split the current behavior path into decision, steering, and locomotion contracts rather than allowing `creature.js` to mix target selection, boundary response, separation, and actual movement.
- Keep `creature-activity.js` and `creature-interaction.js` as decision sources. Have them emit goals or preferred velocity, not bone transforms.
- Express roam, follow, flee, attack approach, separation, and boundary avoidance as named steering terms with visible weights.
- Clamp the combined acceleration/turn rate before passing desired velocity into locomotion.
- Add pursuit prediction for hunting/attack approach and use inverse-distance threat weighting for group flee.
- Use flanking only after the basic pursuit controller has a diagnostic trail; it is behavior-layer work, unrelated to the Lab annotation adapter.

### What not to copy

- Do not copy the distance-proportional threat weighting.
- Do not infer naturalistic “collective intelligence” from trajectory screenshots alone.
- Do not let behavior steering directly author gait phase or foot positions.

## 2. Reinforcement Learning for Quadruped Locomotion

### Research question and scientific method

The paper asks whether a deep-RL controller can generate quadruped locomotion that catches a moving target in simulation. It constructs an articulated quadruped, trains policies using PPO and SAC across multiple terrains, and compares pursuit time against a benchmark condition. [P2, pp. 3–10]

Experimental outline:

1. Build a quadruped with 13 meshes, 12 configurable joints, and continuous joint control.
2. Observe body/joint state, target relation, and terrain-related inputs.
3. Produce 39 continuous action values.
4. Train PPO and SAC agents for about 15 million steps, with nine parallel terrains.
5. Reward velocity aligned with the target direction; reward catching the target; terminate and penalize invalid body-ground or foot behavior.
6. Evaluate catch time over 100 episodes against a benchmark.

Reported controller dimensions:

- 243 observations;
- 39 continuous actions;
- three fully connected hidden layers of 512 units;
- nine parallel training environments;
- approximately 15 million training steps.

There is an internal reporting mismatch across the related thesis: its configuration prose gives 204 observations and 36 actions, while its experiment section—and the standalone paper—give 243 observations and 39 actions. Treat 243/39 as the reported experimental network shape, but do not claim the setup is fully reproducible without resolving that discrepancy. [P2, pp. 7–8; P5, pp. 75–76]

### Reward and target behavior

The locomotion reward centers on alignment between body velocity and the heading toward the target. In normalized form:

`r_heading proportional to v_body dot normalize(p_target - p_body)`

Additional terminal rewards/penalties are described as:

- `+1` for catching the target, then terminate;
- `-1` for body-ground collision or prohibited foot behavior, then terminate.

The target uses classical behaviors—hover, flee, and collision avoidance—rather than another learned controller. This means the result tests a learned pursuer against a handcrafted target and terrain, not general animal behavior learning.

For PPO, the central clipped surrogate objective is conventionally:

`L_CLIP(theta) = E_t[min(r_t(theta) A_t, clip(r_t(theta), 1-epsilon, 1+epsilon) A_t)]`

where `r_t(theta)` is the new/old policy probability ratio and `A_t` is the estimated advantage. Clipping limits excessively large policy updates.

### Results and limits

The paper reports a training reward around 2200 compared with a benchmark around 2000. Across 100 pursuit episodes, reported mean catch time is about `6.1141 s` for the learned agent versus `8.1658 s` for the benchmark—roughly a 25% reduction. [P2, pp. 8–9]

Important limits:

- no variance, confidence intervals, or significance test are reported for the catch-time comparison;
- target policy, controller, and locomotion quality are entangled in one task score;
- the body is a purpose-built simulation quadruped, not one of the heterogeneous Stadium rigs;
- millions of training steps and reward design make iteration far more expensive and opaque than the existing procedural walker;
- a higher reward is not direct evidence of perceptual realism.

### Applicability here

Not the first movement implementation. The repo already has a deterministic walker with inspectable failures. RL becomes useful later for:

- residual corrections on top of the procedural gait;
- recovery from pushes or bad terrain;
- automatic tuning of stride, duty factor, body height, and turn parameters;
- choosing behaviors when classical rules become brittle.

Before any RL experiment, preserve deterministic metrics: foot slip, support margin, reach error, body-ground penetration, joint discontinuity, speed tracking, and energy/rotation change. Otherwise a scalar reward can improve while motion quality silently worsens.

## 3. Steering Autonomous Animals in VR Hunting (`paper_1.pdf`)

### What this document is

This is a one-page outline or extended abstract, not a full paper. It introduces the problem and the intended architecture but defers detailed methods and results. The complete related implementation is documented in the VR-hunting thesis and collective-intelligence paper. [P3, p. 1]

### Scientific method

The page proposes a design:

- autonomous animals receive behavior goals;
- steering converts goals into responsive local motion;
- locomotion animates the creature;
- collective behaviors make groups react to hunters and one another.

It does not provide sufficient experimental procedure, independent equations, datasets, controlled conditions, or numerical results to reproduce or validate the claims. It should be cited as an architectural summary only.

### Applicability here

Its value is the clean layer boundary, not a new algorithm. It reinforces the repository direction:

`activity/interaction decision -> steering request -> existing locomotion -> rig transforms`

Do not treat the one-page document as additional evidence on top of the thesis; it describes the same research line.

## 4. Blending Collision Avoidance Animation in Synthetically Generated Locomotion

### Research question and scientific method

The paper asks whether collision avoidance can be added to an already generated locomotion animation by blending a small procedural IK response into selected body chains. It demonstrates the method on a quadruped avoiding rocks/blocks and a biped reacting to a sword or projectile, then reports per-frame computation time. [P4, pp. 1–4]

Method:

1. Preserve the base locomotion animation.
2. Define three FABRIK chains sharing the spine: one ending at the head and two ending at the front feet/hands.
3. Place an artificial target/end effector in front of the head to anticipate collision.
4. Detect an obstacle within a maximum activation distance.
5. Solve avoidance targets with FABRIK.
6. Blend the collision-avoidance pose with the base locomotion using a distance-dependent weight.
7. Measure solve cost and visually inspect the transitions.

The solver uses ten FABRIK iterations per rendered frame and reportedly maintains 60 FPS with about `0.05–0.45 ms` of avoidance work per frame in the demonstrated scenes. The timing table appears to transpose the biped/quadruped task labels relative to the experiment prose, so preserve the range but not those per-character labels without clarification. [P4, p. 3]

### Concepts and equations

**Layered/procedural correction.** Avoidance does not replace locomotion. It adds a local pose correction to the head/front limbs while the base gait continues.

**Anticipatory end effector.** A point in front of the head supplies a look-ahead volume. This is more useful than waiting for the rendered mesh to penetrate an obstacle.

**Distance blend.** The printed expression resembles:

`weight = K(-distance / maxDistance)`

while the prose describes an exponential function and gives a large constant around `K=5000`. The notation is not sufficiently specified to reproduce confidently: it is unclear whether `K(...)` denotes a kernel/function or multiplication, and the range normalization is not explicit.

For this repo, use an explicit bounded curve, for example:

`x = clamp(1 - distance / maxDistance, 0, 1)`

`weight = x^2 (3 - 2x)`

This smoothstep is zero outside the range, one at contact, continuous at both endpoints, cheap, and inspectable.

**Pose blend.** If `q_base` and `q_avoid` are joint rotations, blend rotations with spherical interpolation rather than componentwise linear interpolation:

`q = slerp(q_base, q_avoid, weight)`

For target positions, ordinary interpolation is sufficient:

`p = (1-weight) p_base + weight p_avoid`

### Results and limits

The method is computationally small and shows that a few IK chains can create recognizable evasive movement. Reported limitations matter:

- rapid activation can create abnormal transition poses;
- the quadruped's front legs can look unnatural;
- irregular obstacle geometry is not analyzed thoroughly;
- visual demonstrations do not establish perceived naturalness;
- a head-centered avoidance chain cannot replace world-space navigation or body collision planning.

### Applicability here

This is useful **after** the existing walker is driven by annotations:

- add a look-ahead probe based on velocity and body size;
- steer the whole creature around avoidable obstacles first;
- use a bounded procedural pose layer only for near misses, ducking, bracing, or stepping over small obstacles;
- route each selected chain through `pokemon-drive.js` as a named temporary controller rather than overwriting the neutral pose or the base gait;
- record activation weight and reach error in diagnostics.

The paper supports controller layering. It does not justify putting obstacle avoidance inside the Lab annotation format or writing a second locomotion solver.

## 5. AI Game Design in VR Hunting

### Research question and scientific method

This 2021 master's thesis is the most complete document in the set. It asks how to create autonomous animals for VR hunting by integrating decision making, navigation, steering, procedural quadruped locomotion, collective behavior, and learned control. [P5, pp. 16–17, 23–78]

The thesis follows a system-building method:

1. Review classical game-AI, steering, IK, procedural animation, and RL methods.
2. Define a four-layer animal architecture.
3. Implement rule-based individual and group animal behavior in Unity.
4. Implement a generalized quadruped IK/locomotion model.
5. Train a quadruped pursuit controller with PPO/SAC.
6. Demonstrate integrated hunting scenarios and report selected performance/task measures.

Because it combines several publications, some content overlaps documents 1–3. It is the best source for their full algorithms, but repeated claims should not be counted as independent replications.

### Four-layer architecture

1. **Decision layer:** behavior trees select high-level actions.
2. **Navigation layer:** identifies destinations/routes in the environment.
3. **Steering layer:** produces moment-to-moment force and torque requests.
4. **Locomotion layer:** converts desired body motion into animated movement.

Behavior-tree definitions:

- **Selector:** try children until one succeeds; represents alternatives.
- **Sequence:** run children in order until one fails; represents required steps.
- **Condition:** inspect world/agent state.
- **Action:** perform work and return running/success/failure.

This architecture is more important here than the exact Unity implementation. Each layer can be tested independently, and debug output can state “why the creature chose this,” “where it intends to go,” “what velocity it requested,” and “whether its feet realized that request.”

### Generalized quadruped inverse-kinematics model

The thesis divides each leg cycle into:

- **stance:** foot remains fixed relative to the world while the body advances;
- **swing:** foot lifts, travels forward, and returns to ground.

The swing path has a lift portion and a fall portion around an apex. It is parameterized by stride length, step height, timing, and phase. Fixed example values for the wolf include roughly `0.76 m` complete stride, `0.38 m` horizontal travel to the apex, and `0.10 m` vertical lift. [P5, pp. 67–69]

Those values are model-specific examples, not universal animal constants. In this repo, dimensions should be derived from leg span, body scale, terrain clearance, and a dimensionless gait parameter rather than copied per species.

The main animation defect being attacked is **foot sliding**: a foot visibly moves across the ground during the portion of the gait when it should support the body. The correct constraint is world-space contact locking during stance.

### Behavior and collective methods

The thesis supplies the detailed CEM, pursuit, flee, separation, leader-following, group-pursuit, and group-flee methods summarized in paper 1's section above. It also uses behavior trees to select among these behaviors.

The most useful combination is:

`goal selection -> bounded steering -> desired body velocity -> stance/swing scheduler -> IK/world transforms`

The least useful shortcut is allowing a behavior-tree action such as “flee” to directly choose bone rotations. That couples ecological behavior to a particular rig and makes both parts harder to diagnose.

### RL study

The quadruped RL setup and reported catch-time result are the same research line as document 2: 13 body meshes, 12 configurable joints, 39 actions, 243 observations, three 512-unit hidden layers, PPO/SAC, and roughly 15 million steps. See that section for the reward and evidence limits.

### Applicability here

The thesis maps well onto existing repository modules:

| Thesis layer | Existing or intended repository role |
|---|---|
| Decision | `creature-activity.js`, `creature-interaction.js` |
| Navigation | route/target generation; currently partial and mixed into creature code |
| Steering | wander, separation, boundary avoidance, flee, follow, pursuit |
| Locomotion | `creature-locomotion.js`, `stadium-walker.js` |
| Rig semantics | Lab annotation + `pokemon-lab-runtime.js` |
| Diagnostics | `gait-diagnostics.js` and visual overlays |

Near-term implications:

- Complete the annotation-to-walker adapter before expanding behavior.
- Derive stride and lift from measured geometry; do not paste wolf constants into Pokémon.
- Let the Lab describe semantic facts—limb chain, side, row, contact/foot, root, spine—not gait policy.
- Keep behavior-tree adoption optional. The essential contract is layer separation, not a particular tree library.
- When behavior work resumes, begin with explicit preferred-velocity components and debug trails rather than RL.

## 6. Pedipulation in Quadruped Robots Using a Heuristic Inverse Kinematics Solver

### Research question and scientific method

The paper asks whether a quadruped can use one foot as a manipulation end effector while the other three legs maintain support, using a fast heuristic IK solver integrated into a hierarchical whole-body controller. [P6, pp. 1, 3–7]

Method:

1. Use FABRIK's forward pass to pull the manipulation leg toward a target.
2. During the backward pass, project joints onto constraint planes and saturate illegal configurations.
3. Add a compensation phase intended to escape slow convergence or local minima created by constraints.
4. Place the manipulation task in a hierarchical quadratic programming (HQP) controller with floating-base dynamics, balance, stance contacts, friction, body pose, and leg posture tasks.
5. Test 200 random targets in a `30 cm` cube in simulation.
6. Demonstrate physical tasks on a Unitree Go1 and report end-effector error.

### Heuristic constrained FABRIK

Plain FABRIK alternates end-to-root and root-to-end length projections. The heuristic version changes the constraint treatment:

- the forward phase finds an ideal target-reaching configuration;
- the backward phase restores the base while projecting proposed joints into legal planes/regions;
- saturation stops a joint at a limit rather than accepting an impossible position;
- a compensation pass adjusts preceding joints when constraints prevent the end effector from reaching the target.

The important term is **local minimum**: an iterative solver can stop improving even though a better legal configuration exists. The paper shows initialization and constraint ordering affect success.

### Whole-body task equation

For generalized coordinates `y`, task-space state `x`, task Jacobian `J`, and desired task acceleration `x_ddot*`, a feedback-linearized task is expressed as:

`J y_ddot = x_ddot* - K_p (x - x*) - K_d (x_dot - x_dot*) - J_dot y_dot`

The HQP assigns priorities so lower-priority tasks cannot violate higher-priority requirements. A representative ordering is:

1. floating-base dynamics;
2. balance/stability inequalities;
3. stance contact and friction constraints;
4. body-pose tracking;
5. manipulation-foot tracking/posture.

This is valuable conceptually: “do not fall” outranks “reach the paw target.” It is much heavier than the present game-animation needs.

### Quintic trajectory

A normalized quintic ease between endpoints uses:

`s(tau) = 10 tau^3 - 15 tau^4 + 6 tau^5`, for `tau in [0,1]`

`p(t) = p_0 + (p_1 - p_0) s(tau)`

It has zero velocity and acceleration at both ends and is appropriate for deliberate paw placement, an attack wind-up, or a body transition. It is not automatically the best cyclic foot path.

### Results and limits

Simulation:

- 200 targets sampled in a 30 cm cube;
- 180 reached;
- 19 of the 20 failures judged physically unreachable;
- one failure attributed to a local minimum;
- average error about `4 mm`;
- average about `1.76` iterations.

Physical Go1 demonstrations show centimeter-scale errors, roughly `31–75 mm` depending on task/axis. The paper notes:

- initial configuration affects convergence;
- the method does not include obstacle detection;
- physical state-estimation drift reduces accuracy;
- reachability and constraint satisfaction must be distinguished from solver failure.

### Applicability here

The best immediate use is diagnostic design:

- classify an unreachable foot target separately from non-convergence;
- report iteration count and end-effector error;
- preserve segment lengths after every constraint projection;
- store/derive a bend plane or pole and inspect it visually;
- initialize from the current/rest pose rather than a generic straight chain.

Later, the task-priority idea can support a paw swipe, pickup, digging action, or other move while stance contacts remain locked. Do **not** port the full HQP controller for ordinary walking; `stadium-walker.js` already has a game-appropriate support and contact system.

## 7. Towards Full Body Co-Embodiment of Human and Non-Human Avatars in Virtual Reality

### Research question and scientific method

This work-in-progress asks how two people can share control of either a full human avatar or a deliberately non-human avatar. It contributes two implemented designs, describes their tracking-to-IK mappings, identifies locomotion problems, and proposes future user studies. It explicitly says the prototypes have **not yet been evaluated**, so it is a design report rather than evidence that the mappings preserve embodiment or agency. [P7, pp. 1–4]

The proposed future experiments are:

1. Test full-body human co-embodiment in a task combining upper- and lower-body coordination and vary per-part control weights.
2. Test different limb assignments on the non-human avatar, such as left/right versus upper/lower splits.
3. Compare human and non-human shared avatars after the first two studies establish workable designs. [P7, p. 3]

### Terms and definitions

- **Embodiment:** the subjective experience of using and having a body.
- **Sense of embodiment (SoE):** an umbrella construct containing self-location, body ownership, and agency.
- **Self-location:** feeling located inside the represented body.
- **Body ownership:** attributing the represented body to oneself.
- **Agency:** feeling motor control over the represented body and its actions.
- **Co-embodiment:** sharing one virtual avatar with another entity, which may be a person, robot, or autonomous agent. [P7, p. 1]

### Full-body human method

Each user supplies six tracked poses: HMD, two hand controllers, lower-back tracker, and two foot trackers. A six-point IK system animates the avatar. The implementation applies several distinct ownership rules rather than averaging everything globally: [P7, p. 2]

- The two users' body-part weights sum to 100 percent and can be uniform, customized per body part, or split across a horizontal/vertical body division.
- Camera pose stays local to each user to reduce cybersickness and out-of-body motion.
- Avatar scale is calibrated per local user rather than synchronized.
- Global horizontal position follows the local user's tracking origin.
- Head yaw is weighted to avoid severe disagreement with torso yaw.
- Torso height and yaw are weighted because the waist drives lower-body IK.
- Hand and foot end-effector poses are combined in waist-relative coordinates, not raw world coordinates.

A clean positional formulation of the paper's weighting rule is:

`p_shared = w p_A + (1-w) p_B`, with `0 <= w <= 1`

For rotations the game implementation should use:

`q_shared = slerp(q_A, q_B, 1-w)`

The second expression is the repository-appropriate rotation implementation of the paper's weighted-control concept; it is not printed as an equation in the paper.

### Non-human method and locomotion zones

The non-human avatar is an upright slug-like body with two eye stalks and two pairs of tentacles. Each user controls one eye/HMD and one pair of tentacles/controllers. FABRIK drives the tentacle and eye-stalk chains. The avatar body advances only when an eye moves far enough from the torso. Four zones add hysteresis: [P7, p. 3]

- **Blue:** idle; the body remains still.
- **Green outer boundary:** start pulling the torso toward the eyes.
- **Red:** stop/re-align so both stalks have comparable angles to the forward vector.
- **Yellow:** transitional memory zone; behavior depends on the zone crossed previously.

This is effectively a small state machine with hysteresis. It prevents the body from toggling between moving and stopped at one exact distance threshold.

### Limits

- Human users facing very different directions can produce implausible torso/limb poses.
- The system does not ensure plausible shared footsteps.
- Opposing user motion can cancel the non-human body's pull while the cameras continue to separate.
- Visual feedback may be insufficient for a user to understand why their motion has little influence.
- There are no participant results yet. [P7, pp. 3–4]

### Applicability here

The paper is relevant to **control ownership and blending**, not autonomous animal intelligence:

- Use explicit per-chain ownership/weights when ROM animation, procedural walking, player input, hit reaction, and AI look-at all want the same bones.
- Keep camera/root authority separate from limb targets; never average first-person camera motion with an autonomous controller.
- Use local body-relative coordinates before blending end-effectors from different controllers.
- Add hysteresis bands to locomotion activation, foot replanting, look-at release, and near-obstacle pose overlays.
- Treat `pokemon-drive.js`'s `clip`, `posed`, and `limp` modes as coarse ownership states; a future controller stack may need a temporary weighted owner per chain.

Do not use this paper as evidence that shared or blended control will feel natural. Its contribution is a concrete prototype and a useful list of failure modes.

## 8. Design of the Walking Pattern Generation Software of AR-600 Anthropomorphic Platform

### Research question and scientific method

The paper asks whether zero-moment-point preview control plus FABRIK can generate stable real-time walking for the AR-600 humanoid. The authors implement a standalone C++/Qt library, integrate it into the robot control software, test it in the 3DLK simulator on specified PC hardware, vary trajectory and timing parameters, and report calculation time and selected walking limits. [P8, pp. 2–6]

The modeled platform is 1,442 mm tall, 65 kg, has 59 degrees of freedom, and uses 12 lower-limb degrees of freedom. The reported work is primarily simulation and control-software validation, not a human-motion perceptual study. [P8, p. 3]

### Terms and definitions

- **Stance phase:** the foot contacts the ground; its role is body advancement and posture support.
- **Transfer/swing phase:** the foot is airborne and moves to the next support location.
- **Static walking:** the body remains statically stable at every instant.
- **Dynamic walking:** the projected center of mass may leave the current support polygon, requiring a new support contact to prevent falling.
- **Zero moment point (ZMP):** a ground-contact point about which the dynamic reaction force has no horizontal moment; equivalently in the paper's description, horizontal inertia and gravity moments balance. It is used as a dynamic-stability criterion.
- **Preview control:** choose current center-of-mass control using a window of upcoming desired ZMP samples rather than only the current sample. [P8, pp. 2–3]

### Walking-pattern method

The paper's pipeline is: [P8, pp. 4–5]

1. Plan desired foot coordinates and which leg supplies support.
2. Put the desired ZMP at the center of the current stance foot so it remains on the support surface.
3. Build a ZMP trajectory from planned footsteps and stance switches.
4. Feed that future trajectory to a preview controller to generate the center-of-mass path.
5. Express foot paths relative to the resulting center-of-mass/pelvis path.
6. Generate vertical swing-foot motion from either an adaptable polynomial or a half-circle.
7. Solve lower-limb joint configurations with constrained FABRIK.
8. Send the joint angles to the motion system at a fixed sample interval.

The method assumes a constant pelvis/center-of-mass height and neglects center-of-mass changes caused by limb motion. Those simplifications are material when interpreting the stability claim. [P8, p. 5]

### Results and limits

The tuned controller uses: [P8, p. 6]

- `N = 400` samples in the process-controller buffer;
- 100 samples per step;
- sample time `T = 0.011 s`;
- maximum reported natural step length about `0.50 m` without a large preliminary knee bend;
- speed about `0.455 m/s` at that setting;
- average motion-cycle calculation time about `8 ms`;
- roughly `1 s` for a complete step.

Too many samples make matrix calculations expensive; too few create large angle changes and visible discontinuity. The tested polynomial curves did not improve speed, stability, or naturalness, so the authors selected the simpler half-circle swing trajectory. Rapid maneuvers and uneven terrain still require feedback, which they identify as future work. [P8, pp. 6–7]

### Applicability here

- The stance/swing and planned-contact sequence reinforces the existing `creature-locomotion.js` and `stadium-walker.js` design.
- The half-circle result supports keeping swing arcs simple until a diagnostic shows a specific deficiency.
- A preview window is useful for looking several footfalls ahead on uneven terrain, but full ZMP control is unnecessary for kinematic game creatures.
- The sample-count tradeoff suggests adapting solver substeps/iterations to motion speed and error rather than using an arbitrarily large constant.
- The repo already computes support information in `bodySupport()`; prefer extending that measurement before adding humanoid robotics machinery.

## 9. Designing an Immersive Virtual Reality Avatar Animation Software

### Research question and scientific method

This undergraduate project asks how a full avatar, especially its legs, can be animated from only three tracked points: HMD and two controllers. It implements an upper-body IK prototype, develops two procedural lower-body strategies, reviews a motion-matching alternative, attempts a small motion-capture collection, and compares the approaches qualitatively. [P9, pp. 3–16]

The author planned and recorded approximately five minutes each from five volunteers performing turns, squats, jumps, forward/backward walks and runs, circles, and pointing. The report concludes that this dataset was too small relative to existing databases and does not present a trained model from it. Consequently, the motion-matching claims mostly summarize another method rather than validate a new one. [P9, p. 15]

### Terms and definitions

- **Forward kinematics:** compute an end-effector transform from known link lengths and joint states.
- **Inverse kinematics:** compute intermediate joint states from a base, target/end effector, and link constraints.
- **Inverted-pendulum model:** approximate the body center of mass over a supporting leg/foot and initiate a corrective step when the projection leaves a stable region.
- **Motion matching:** query a recorded motion database for the pose and future trajectory that best resemble the live request.
- **Foot lock:** hold a stance foot at a fixed world point until the animation legitimately changes support. [P9, pp. 6, 9–14]

### Upper-body method

The HMD and controllers are mapped to a head target and two hand targets. Unity two-bone IK solves the arms, a multi-parent constraint relates head and body, calibration offsets account for grip/body differences, and torso rotation is smoothed so it follows head yaw gradually rather than snapping. [P9, p. 8]

### Procedural lower-body methods

**Method 1: support-region stepping.** Approximate the center of mass by HMD position. When that point leaves an ellipse between/around the feet, select a new foot placement to restore support. Raycast to find terrain height and normal, keep feet above ground, and interpolate the step over multiple frames. [P9, pp. 9–10]

Its main failures are floor sliding and failure to adapt gait shape to speed.

**Method 2: velocity-scaled semi-ellipse.** Move the swing foot along a semi-elliptical arc, and scale stride length from measured avatar velocity. This fixes the flat sliding path and gives different walk/run amplitudes, but direct lateral motion can cross the legs, crouching remains crude, and the result looks robotic from a third-person view. [P9, pp. 11–12]

A convenient implementation parameterization is:

`x(phi) = x_start + stride * phi`

`y(phi) = y_ground + lift * sin(pi * phi)`, for `phi in [0,1]`

This is a normalized repository formulation of the report's semi-ellipse concept, not a verbatim printed equation.

### Motion-matching method described

The reviewed design uses tracker velocities and rotations as neural-network inputs, two 32-unit ReLU hidden layers to predict body orientation, a database reported as roughly 500,000 poses / 2.4 hours, a motion-matching search every ten frames, upper-body IK for exact hands/head, and foot locking for contact. [P9, pp. 13–14]

The crucial hybrid principle is:

`recorded whole-body motion + exact IK constraints + stance-foot locking`

Recorded motion supplies natural correlations; IK supplies exact tracked endpoints; the lock prevents a visually dominant contact error.

### Results and limits

The report's final comparison is qualitative. It judges motion matching better for gait transitions, head/torso decoupling, crouching/toe behavior, and idle motion. It does not report a controlled participant study, quantitative reconstruction errors, or a completed trained model. The cited 80-percent contact-stability result belongs to another source, not this project's experiment. [P9, pp. 12, 16]

### Applicability here

- `player-procedural-body.js` already has velocity-adaptive gait parameters, terrain targets, world-space feet, and torso/limb pose logic; compare against these criteria rather than rebuilding the report's prototype.
- Preserve head/torso decoupling so looking around does not rotate the whole body or trigger tiny walking cycles.
- Explicitly test lateral and diagonal travel for leg crossing, not only forward walking.
- Reuse terrain sampling and foot locks for both player and creature rigs.
- Motion matching is a later enhancement for human bodies or a small number of well-recorded species. It is a poor first answer for 151 heterogeneous, semantically unnamed Stadium rigs.

## 10. An Inverse Kinematics Model for the Lower Body Motion

### Research question and scientific method

This bachelor thesis asks how accurately variants of FABRIK reconstruct lower-body marker trajectories and builds a reusable benchmark pipeline around that question. It records motion capture, constructs four- and five-joint leg chains, runs unconstrained and constrained solver variants, writes solved `.c3d` plus `.csv` diagnostics, visualizes trajectories, and compares solved markers against captured markers frame by frame. [P10, pp. 3, 11–18]

The motion set includes ordinary and crossed jumping jacks plus treadmill walking/running at `3`, `5`, and `7 km/h`. It uses both a baseline lower-body marker set and the Rizzoli Lower Body Protocol. The thesis does not clearly report the number of captured participants, so its errors describe the recorded datasets, not a population. [P10, pp. 12–15]

### Terms and definitions

- **Sagittal plane:** forward/back and vertical motion plane.
- **Coronal/frontal plane:** side-to-side and vertical motion plane.
- **Transverse plane:** horizontal plane.
- **Kinematic chain:** rigid links connected by joints.
- **End effector:** the terminal joint/point whose target is prescribed.
- **Constraint deadlock/local minimum:** the solver cannot reduce target error further because its projection/constraint sequence returns it to the same configuration.
- **Delta:** Euclidean distance between a captured marker and its reconstructed position. [P10, pp. 5–6, 23]

For captured point `x_i` and solved point `xhat_i`:

`delta_i = ||x_i - xhat_i||_2`

For `N` frames, a useful aggregate is:

`RMSE = sqrt((1/N) sum_i ||x_i - xhat_i||_2^2)`

The thesis mainly reports component errors, magnitudes, means, extrema, and standard deviations; RMSE is discussed when comparing with earlier upper-body work. [P10, pp. 23, 31–32]

### FABRIK and benchmark method

The implemented solver uses the conventional FABRIK method already specified in this notebook: place the end effector on the target, perform end-to-root length projections, restore the root, perform root-to-end projections, and stop at a tolerance. Constraints limit possible joint motion in one or two planes. [P10, pp. 9–11]

The benchmark pipeline is unusually applicable here:

1. Capture or load reference joint positions per frame.
2. Select and order the chain explicitly.
3. Run a named solver/constraint configuration.
4. Save solved positions without overwriting the source.
5. Save segment lengths for every frame.
6. Save per-axis and magnitude deltas.
7. Visualize the source and result together.
8. Compare solver variants on the same data and targets. [P10, pp. 11, 16–18]

### Results and limits

Important reported observations include: [P10, pp. 22–35]

- Unconstrained FABRIK preserved link lengths in the shown trial.
- The constrained implementation allowed one segment to vary from below `8 cm` to about `42 cm`, which violates the defining rigid-link invariant.
- For one jogging knee marker, the four-marker constrained model's mean error was about `10.6 cm`, while the five-marker constrained model was about `35 cm`.
- A faster-walk trial reported mean knee x-error around `16.38 cm`.
- Common jumping-jack knee error was reported with mean about `18 cm`; heel mean about `19 cm`.
- Different constraint directions help different motions; one fixed constraint set performs well on one motion and poorly on another.
- More joints and constraints did not automatically improve accuracy and introduced deadlocks.

The thesis concludes that reconstruction is fast but insufficiently accurate for its intended tracking pipeline. That negative result is scientifically valuable: a constrained IK solver can look anatomically plausible while numerically corrupting link lengths or following the wrong branch.

### Applicability here

- Add segment-length invariance as a hard assertion to `pokemon-ik.js`, `creature-locomotion.js`, and annotation-driven rig tests.
- Compare auto-mapped and manually annotated rigs using identical target traces and solver settings.
- Record per-axis errors as well as one scalar; lateral errors reveal crossed legs while vertical errors reveal ground penetration.
- Preserve source/rest data and write solver output into a separate pose/controller layer.
- Treat added joints and constraints as hypotheses that must beat the simpler model on the same benchmark.
- Use explicit chain ordering from Lab annotations; never depend on incidental map/object iteration order.

## Repository survey: what already exists

The papers do not arrive in an empty project. The relevant repository systems already cover most of the locomotion algorithms they recommend.

| Repository system | Existing responsibility | Relation to the papers |
|---|---|---|
| `pokemon-ik.js` | Pure FABRIK, relative tolerance, unreachable-chain straightening, collinearity handling, swing/twist limits, segment-to-rotation conversion | Implements the common IK baseline; needs invariant/initialization diagnostics when used on new chains |
| `creature-locomotion.js` | Gait definitions, terrain sampling, stance/swing scheduling, support polygon, two-bone solve, foot arcs, contact scheduling | Already contains the core procedural gait described across papers 5, 8, and 9 |
| `stadium-walker.js` | Stadium-specific walker, dimensional/Froude scaling, stride envelope, minimum step duration, terrain contacts, contact patches, world-matrix retargeting | The correct existing consumer; handles the exported-origin problem the generic paper solvers do not |
| `foot-sdf.js` | Foot/contact-patch geometry | More informative than treating every foot as a single mathematical point |
| `gait-diagnostics.js` | Measurements and visual diagnostics for walking | Natural home for slip, reach, support, and continuity comparisons |
| `stadium-rig-map.js` | Guesses the semantic rig map from geometry/naming | Baseline to replace or compare against, not the walker itself |
| `pokemon-lab-runtime.js` | Loads Lab data, resolves annotation names to glTF node IDs, applies neutral pose, reports missing parts | Existing seam from authored semantics to runtime data |
| `pokemon-drive.js` | Per-bone choice among clip, held pose, and ragdoll | Foundation for later layered collision reactions or partial procedural controllers |
| `creature-activity.js` | Activity/goal selection such as wander, sleep, hunt, socialize, graze | Decision layer |
| `creature-interaction.js` | Follow/stay/goto/attack, hostile/flee, roam targets | Decision and target layer; some steering concerns are currently mixed in |
| `creature.js` | Combines movement concerns including wander, separation, and boundary response | Candidate for later separation into named steering terms |
| `demos/stadium-walker-v2.html` | Live harness using `createStadiumWalker()` with diagnostics and species roster | Correct place to prove annotation-derived mappings before inventing a destination app |

The practical consequence is unambiguous: **the next movement task is data adaptation and comparison, not gait design.**

## Immediate movement proof: Lab annotation to existing walker

### Objective

Convert a sufficiently described Lab annotation plus measured rig geometry into the map shape consumed by `createStadiumWalker()`, then run that map in `demos/stadium-walker-v2.html` beside the existing guessed mapping.

The adapter should be pure and independently testable. Conceptually:

`mapFromLab(annotationRig, measuredRig, geometryFacts) -> stadiumWalkerMap`

The Lab supplies human decisions. Geometry supplies measurements. The adapter derives walker-specific values. The walker remains unchanged unless comparison exposes an actual missing contract.

### Information supplied by the annotation

The authored facts should include only semantic decisions that geometry cannot safely guess:

- root;
- spine;
- appendage/limb chains;
- limb type;
- limb side;
- limb row;
- paired/mirrored relationship;
- contact or foot bones;
- neutral pose when authored;
- locomotion class.

This is why unassigned decorative bones are not automatically a defect. The walker needs movement semantics, not a name for every mesh influence.

### Information measured or derived

The walker map contains geometry such as:

- model units and forward direction;
- body centroid and ride height;
- rest-world positions;
- attachment point;
- hip, knee, ankle, and foot proxy positions;
- segment lengths `l1`, `l2`, and total span;
- rest direction and bend pole;
- foot frame/contact patch;
- per-row and per-side gait placement.

Fields used by the current walker include top-level values such as `units`, `forward`, `bodyCentroid`, `rideHeight`, `names`, and `restWorld`, and per-leg values such as `attach`, `bones`, `kneeIndex`, `hip`, `knee`, `foot`, `restDir`, `pole`, `l1`, `l2`, `span`, `row`, `side`, `footBones`, `ankleIndex`, `footProxy`, and `footFrame`.

Most of those are not new annotation fields. They should be derived using the same measured-geometry routines already trusted by the existing mapper/walker. The annotation replaces uncertain classification: which chain is the limb, which end contacts the floor, and how it is paired/ordered.

### Bend direction

The supplied papers repeatedly show that the target and segment lengths do not uniquely determine a plausible knee. A bend pole should first be derived from the annotated chain's rest geometry:

1. Let `a` be hip, `b` an interior knee candidate, and `c` the foot.
2. Project `b-a` onto the hip-to-foot axis.
3. Use the residual direction as the rest bend direction/pole.
4. If the residual is nearly zero, use a stable body-relative fallback and flag low confidence.
5. Expose the pole in the demo and permit a future annotation override only for real failures.

Do not require every user to author a pole preemptively. First measure how often rest geometry is ambiguous.

### Comparison design

For the same species and same walker parameters:

1. Build map A using `stadium-rig-map.js`.
2. Build map B using the Lab annotation adapter.
3. Run both through `createStadiumWalker()`.
4. Use the same terrain, target velocity, gait, start pose, timestep, and duration.
5. Record diagnostics rather than relying only on “looks better.”

Minimum metrics:

- stance-foot world slip distance;
- requested versus solved contact error;
- unreachable-target count;
- IK iteration count where applicable;
- segment-length error;
- joint-transform discontinuity per frame;
- body-ground penetration;
- support-polygon margin or time outside support;
- actual versus requested forward speed;
- number of inferred versus annotated semantic decisions;
- warnings for ambiguous bend pole, missing contact, or stale rig.

Visual checks still matter because a numerically stable knee can face backward. The demo should show both the mesh and compact overlays for foot targets, locked contacts, limb chains, poles, and support polygon.

### Small adversarial trial set

One straight walk is not enough. Run each annotation through:

1. stand/idle without drift;
2. start from rest;
3. constant forward motion;
4. stop without foot skating;
5. slow and fast speeds inside the valid stride envelope;
6. turn left and right;
7. reverse or reject reverse explicitly;
8. cross-slope and uphill terrain;
9. a small step/height discontinuity;
10. a temporarily unreachable contact target;
11. a sharp frame-time disturbance while locomotion uses fixed internal steps;
12. a nonstandard rig: asymmetric limb chain, serpent/worm, roller/floater, or more than four legs.

This is the “real moving model” proof the Lab needs. Gates can then distinguish schema completeness from observed movement validation instead of claiming an annotation is correct merely because required fields exist.

## Behavior work after the movement proof

Once annotation-derived walking works, adopt the VR-hunting architecture without copying its source bugs.

### Proposed runtime contract

Each stage should return an inspectable object:

1. **Decision:** `{ activity, target, reason, urgency }`
2. **Navigation:** `{ destination, path, nextPoint }`
3. **Steering:** `{ preferredVelocity, preferredFacing, components }`
4. **Locomotion:** `{ achievedVelocity, contacts, gaitPhase, diagnostics }`

Steering components might include:

`components = { seek, arrive, pursue, flee, separation, boundary, obstacle }`

Combine them with explicit weights and one cap:

`a_desired = clampMagnitude(sum_k w_k a_k, a_max)`

Update body velocity with a fixed or bounded timestep, then send desired velocity/facing to the walker. Locomotion can report failure or saturation when the requested turn/speed cannot be realized.

### Behavior implementation order

1. **Arrive and roam:** stable destination following without overshoot.
2. **Separation:** inverse-distance or smoothly bounded neighbor repulsion.
3. **Flee:** limited threat radius, inverse-distance weighting for multiple threats.
4. **Pursuit:** predicted interception target rather than current-position seek.
5. **Leader following:** offset target plus separation.
6. **Group pursuit/flanking:** virtual left/right targets and assignment.
7. **Local obstacle steering:** body-path avoidance.
8. **Procedural pose avoidance:** only for near-body reactions that navigation cannot express.

At every stage, draw the target, component vectors, combined vector, acceleration cap, and chosen reason. The earlier Claude session's vague “gait philosophy” problem is avoided by making every addition answer a specific observed failure and fit a real contract.

## Paper-to-repository application matrix

| Source | Use now | Use later | Do not infer/copy |
|---|---|---|---|
| Collective animals / VR hunting | Layer boundary; bounded steering equations; pursuit and separation definitions | flee, leader following, flanking | distance-proportional threat weights; realism claims from demos |
| RL quadruped | Define metrics that a future reward would need | residual recovery/tuning after deterministic baseline | a new learned walker as first implementation |
| Steering one-page outline | Architectural terminology | none independently | treat as a separate validated experiment |
| Collision-avoidance blending | explicit smooth blend and controller layering | duck/brace/step-over reactions | ambiguous printed weight; IK as global path planning |
| AI Game Design thesis | four-layer integrated plan; stance/swing and foot-locking rationale | behavior trees or RL if justified | wolf-specific constants across species |
| Pedipulation | reachability, iteration, and local-minimum diagnostics | prioritized paw/attack/manipulation tasks | full robot HQP for ordinary game walking |
| Co-embodiment | semantic effectors; per-part ownership; realignment state | multi-controller/non-human VR embodiment | perceptual success without evaluation |
| AR-600 ZMP/FABRIK | fixed-step scheduling; simple swing arc; future contact awareness | stabilization where support diagnostics demand it | biped ZMP constants as universal gait model |
| VR avatar animation | foot lock; hybrid clip/procedural approach; adversarial motion corpus | motion retrieval only if a locomotion corpus exists | motion matching from missing Stadium walk clips |
| Lower-body IK thesis | segment-length, initialization, error, and deadlock tests | evaluate constraint alternatives | “more constraints means better motion” |

## What not to build yet

- No second walker.
- No per-species locomotion implementation.
- No universal quadruped assumptions in the Lab schema.
- No RL policy before deterministic comparison metrics exist.
- No motion-matching system without an appropriate locomotion corpus.
- No ZMP/HQP whole-body controller unless support failures demonstrate a need.
- No complex swing curve until the simple arc fails a named test.
- No collision-avoidance pose layer before ordinary steering and walking are connected.
- No gate that equates “all bones named” with “movement annotation complete.”

## Recommended sequence

1. Implement a pure Lab-annotation-to-walker-map adapter.
2. Unit-test its semantic mapping and geometry invariants on real rigs.
3. Add it as an alternate input in `demos/stadium-walker-v2.html`.
4. Compare guessed and annotated maps with identical walker parameters and diagnostics.
5. Fix only the annotation fields, adapter derivations, or UI operations that actual movement exposes as missing.
6. Define gates that separately report structural completeness and movement validation.
7. Then separate behavior decisions, navigation, steering, and locomotion contracts.
8. Add arrive, separation, flee, and predictive pursuit in that order, with visible component vectors.
9. Add local procedural collision reactions and higher-level group behaviors only after the baseline is measurable.

The immediate deliverable is therefore small and specific: **adapt the Lab's verified semantic choices into the existing Stadium walker's input and use the existing diagnostic harness to find out whether those choices improve real movement.**
