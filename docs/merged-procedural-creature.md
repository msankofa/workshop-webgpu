# The Merged Procedural Creature

Status: design exploration, 2026-07-29. No code exists yet. This doc records what a merge
of the two live systems could unlock, and where the merge seam sits in today's code.

Companion docs:

- `docs/procedural-creature-model.md` — the four-part model (body, mind, senses, environment).
- `docs/subsystems/creature.md` — the environment-viewer creature system as built.
- `docs/subsystems/bots.md` — the bot-viewer system as built.

## The two systems in one line each

The environment-viewer creatures are a physics-first life sim. Their feet drive the body.
The bot-viewer bots are a tactical combat sim. A capsule drives the body, and the rig follows.

Each system is deep where the other is shallow. The creatures own the body. The bots own the mind.

## Side by side

| | Creatures (env viewer) | Bots (bot viewer) |
|---|---|---|
| Body | Parametric body plans: any leg count, randomized gait and style, temperaments | One fixed humanoid rig (`player-procedural-body.js`) |
| Locomotion | Feet drive the body. Fixed-timestep physics, terrain contact spring, leg-step arcs | Capsule controller moves the bot. The rig is cosmetic and never writes back |
| Navigation | Steering forces only. No pathfinding | `nav-grid.js` A*, floodFill goal scoring, goal claims, spatial hash |
| Combat | Melee. IK punch with windup/strike/recover | Ranged. Ammo, LOS raycasts, spread, grenades, cover |
| Mind | Behavior modes + roles + a wild-activity FSM (sleep/hunt/socialize/graze) | A priority-ladder FSM with alerts, cover, stances, roles, squads |
| Senses | Plain distance radii. No line of sight | FOV cones, occlusion LOS, notice time, alert propagation |
| Death | `dying` state, then dispose | Verlet ragdoll (`ragdoll.js`) |
| Rendering | `createCreaturePartBatches` instancing, LOD tiers | `body-part-batches.js` + `weapon-part-batches.js` instancing, rig LOD |

## Shared DNA

The systems are cousins. Four things already line up:

- The FABRIK solver is a copy. `player-procedural-body.js` carries a "narrow copy, not import"
  of the creature `KinematicChain`. Its header comment names the reason: creature `physicsStep()`
  moves the body from its own feet, which would fight the player controller. That comment states
  the core difference between the systems.
- Both render through the same instancing pattern. `body-part-batches.js` is a deliberate
  sibling of `createCreaturePartBatches`.
- Both split decision math into pure, THREE-free, Node-tested modules.
- Both are host-authoritative in multiplayer. Guests render interpolated ghosts.

## What the merge unlocks

### Near-term: seams already exist

**Tactical wildlife.** Give creatures the bot layers. A wolf pack could alert each other
(squad-alert propagation), flank through trees (nav-grid + visibility field), and flee around
cover when weak (floodFill flee goals). Today a weak creature flees in a straight line —
the exact naive behavior `findFleeGoal` replaced on the bot side.

**Commandable squads.** The pet-command layer (`follow`/`stay`/`goto`/`attack`) is a player
order system that today commands animals. The bot side has squads and formations with no
player input at all. Merged, the go-to key becomes "squad, take that position." The unbuilt
`CMD_ATTACK` (`TODO(F3)`) gets filled by the bot targeting stack.

**Melee and ranged in one fight.** The bot FSM has a knife state. Creatures have real IK melee
plus a grab/carry/stow arm pipeline for `Grabbable` objects. The bot world drops pickups
(health packs, weapons). A creature that scavenges a corpse, or picks up a dropped gun,
is mostly wiring.

### The big one: locomotion damage

Neither system can build this alone. Bot movement is a capsule, so damage can only change a
number. Creature movement is foot-driven physics, so damage can change how the body works.
Shoot a leg off a six-legged creature and it should limp, wobble, and slow down — emergently.
The machinery already runs per frame as diagnostics: `dragAvg`, `wobbleDeg`, COM-outside-support,
the support polygon. In a merged system those stop being bug detectors and become the injury model.
The mechanism exists today; only the wiring is speculative.

### Needs real design work

**Arbitrary-morphology combatants.** Bot roles as body plans: a sniper as a tall tripod, a
technical as a spider-walker gun platform. Blocker: the weapon stack (`weapon-hold-resolver.js`,
the stance table, mount frames) assumes a humanoid. The creature arm system could serve as the
mount, but Contract 6's stance-by-locomotion resolve needs a per-plan generalization.

**Temperament-flavored soldiers, role-flavored animals.** Temperament weights biasing the FSM
ladder; bot roles applied to creatures (`bot-medic.js` is pure and body-agnostic — it just ranks
candidates by path cost). Mostly wiring; the hard part is tuning it to read as personality.

**Mounts.** A rideable creature is where the two locomotion philosophies collide head-on. The
fix is inverting authority: the player stops being a capsule and becomes a steering input to the
creature's own physics. High effort. It is the same seam the tactical-wildlife merge opens.

## The merge seam

The clean split is already visible in the code:

- The bot stack decides **where**: FSM state → nav-grid path → next waypoint.
- The creature stack decides **how**: the waypoint feeds `computeSteering` as a target point,
  and foot-driven physics does the rest.

`computeSteering` already consumes behavior + target-point inputs, so a bot brain on a creature
body is a new steering branch, not a rewrite. The reverse direction is also additive: creature
activities (graze, socialize, sleep) become low-priority rungs under the bot FSM ladder, which
is a pure first-match ladder.

## Costs

- **Perception must unify.** Distance radii and FOV/LOS/notice-time are different models. The
  bot model should win — it is what makes stalking and cover meaningful.
- **Per-agent cost.** A full IK creature costs far more than a bot capsule + rig. The 90-bot
  scale from the perf profile will not survive naive substitution. The creature LOD tiers
  (full IK near, body-only mid, hidden far) must become the default posture, with the bot side's
  think-stagger on top. Both LOD systems exist. Neither has run against the other's load.

## Build order: everything depends on the merge

The merged creature-bot system is the foundation. The environment viewer that carries it
becomes **environment viewer v2**. Nothing new ships except on top of it.

The chain:

1. **Port the v2 bot system into the environment viewer.** The plan exists
   (`docs/superpowers/plans/2026-07-26-bot-v2-env-viewer-port-plan.md`) but the port has not
   started. Two decision gates are open: D1 (shoot-house-first or not) and D2 (the fate of the
   env-viewer's existing Phase 1 squad system).
2. **Merge the ported bot stack with the creature system.** This is the seam above: bot layers
   decide where, creature physics decides how, one unified perception model. The result is
   environment viewer v2.
3. **Generalize locomotion** on the merged system (the per-mode integrator dispatch).
4. **Then** build new body plans and non-combat gameplay on top.

Building a new creature type on today's un-merged creature system would mean migrating it
twice — once when the port lands, again when the merge lands.

One exception, consistent with how this repo works: standalone harness prototypes stay
legitimate at any time. The v2 bot system itself grew in `bot-viewer.html` before any wiring.
A harness that proves a new locomotor touches nothing in the chain and de-risks step 3 while
steps 1–2 proceed. The rule is narrow: nothing ships into the environment viewer except on
top of the merged system.

## The bot viewer survives as bot viewer v3

The merge does not dissolve the harness. The bot viewer continues past the port as
**bot viewer v3**: an independent app, free to change as bot development demands. Its role
is fixed, though: it exists so that bots developed there port cleanly into environment
viewer v2.

That works only if the existing discipline holds:

- Behavior lives in shared, pure, Node-tested modules that both apps import. There are no
  diverged copies today; v3 must keep it that way.
- Harness-only code (its maps, panels, cameras, visuals) stays clearly separated from
  portable code, as the port plan's "Do NOT port" list already draws the line.
- When the harness and the game disagree on shared behavior, that is a bug in one of them,
  not a fork.

The contract flows both ways. When the merge reshapes the bot architecture — the where/how
steering seam, the unified perception model, an extracted brain module — v3 must adopt those
same changes. Shared modules propagate automatically (both apps import the same files); the
architectural changes must be actively back-ported into v3's inline harness code. After that,
v3's capsule locomotion is one interchangeable "how" backend behind the same seam the creature
bodies use. A v3 that keeps iterating on the pre-merge architecture no longer ports cleanly,
which defeats its purpose.

## Out of scope for this doc

Non-combat gameplay directions and new body plans (birds, fish, worms) are under discussion
and will be added once settled.
