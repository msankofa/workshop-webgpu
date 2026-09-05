# Plan: Advanced Pokémon Movement

## Implementation status

Phase 1 is implemented: annotation version 2 stores sparse per-species walker settings; the Lab exposes
the movement-character, stance, cadence and expert foot-safety controls; slider input retunes the running
walker without rebuilding it; Compare mode applies the same sparse overrides to both mappings; and the
panel shows derived, override and effective values. Presets and copy/paste/export tools remain for the
next phase.

The right approach is to expose the Stadium walker’s existing normalized tuning—not copy the Port Creature’s body-generation controls wholesale. Pokémon geometry is fixed, while Port Creatures can rebuild their bodies.

## 1. Add per-species movement settings

Extend each Pokémon annotation with sparse overrides:

    movement: {
      walker: {
        gait: walk,
        tuning: {
          speedScale: 1,
          strideScale: 1,
          stepDurationScale: 1,
          stepLiftScale: 1
        }
      }
    }

Only changed values are saved. Missing values continue using geometry-derived defaults, so future improvements to the walker are not frozen by old save files.

This requires updating pokemon-annotation.js:25 and its migration path in pokemon-lab-io.js:72.

## 2. Add an Advanced Movement panel

Keep Gait, Speed, and Direction as the simple controls. Add a collapsible section with four groups.

### Movement character

- Speed scale
- Stride length
- Step duration
- Step lift

### Stance and reach

- Standing extension/body height
- Maximum leg extension
- Knee swing limit
- Upright support

### Cadence

- Concurrent-step scale
- Step cooldown
- Re-step threshold
- Minimum step time

### Foot safety

- Placement margin
- Reach margin
- Reach-stress threshold
- Point/contact-patch feet
- Contact-patch scale
- Stray-foot behavior

The first ten are the useful everyday controls. Foot safety should be under an **Expert** subsection because bad combinations can destabilize the solver.

## 3. Show derived and effective values

The Pokémon walker calculates safe values from the actual model, including shortest-leg span, stride envelope, settled height, maximum speed, and minimum step duration.

The panel should show:

    Derived → Override → Effective
    Speed        0.42 → ×1.20 → 0.50 m/s
    Step time    0.16 → ×1.30 → 0.21 s
    Stride       0.08 → ×0.90 → 0.07 m
    Ride height  0.31 → 0.85 extension → 0.29 m

This is more useful than presenting unexplained raw numbers. The data already exists in stadium-walker.js:291.

## 4. Apply changes live

Most slider changes can call the existing walker.retune() without rebuilding the model or restarting movement. That seam is already present at stadium-walker.js:512.

Mapping or movement-class changes still rebuild the session. Gait changes could initially rebuild as they do now; live gait switching can follow later.

In Compare mode, both walkers receive identical overrides so differences remain attributable to their rig mappings.

## 5. Enforce safe relationships

The settings layer should prevent impossible combinations:

- standExtension < maxExtension
- reachMargin < reachStress
- Contact/support counts cannot exceed available legs
- Durations and stride envelopes cannot reach zero
- Biped and paired-gait support behavior remains valid
- Reset removes overrides and returns to the model-derived baseline

These rules should live in a small DOM-free module such as pokemon-movement-settings.js, rather than being scattered through event handlers.

## 6. Add presets and transfer tools

Initial presets:

- **Derived** — current measured defaults
- **Stable** — shorter stride, slower cadence, more support
- **Lively** — faster/lighter steps
- **Heavy** — slower steps, lower lift, stronger stance
- **Custom**

Also add:

- Reset species
- Copy settings
- Paste settings
- Export effective configuration

I would not initially add Port Creature-style randomization. Random movement parameters are useful for procedural bodies, but risky for authored Pokémon rigs.

## 7. Preserve diagnostics

Extend the current movement diagnostics with:

- Effective tuning values
- Airborne leg count
- Step cadence
- Derived speed ceiling
- Stride-envelope utilization
- Active safety clamps
- Which overrides differ from defaults

The existing foot slip, target gap, knee-flip, support-margin, and overlays remain unchanged.

## 8. Validate collaboratively

Automated checks should cover schema migration, clamping, persistence, and retune() calculations. Visual quality should use the workflow that succeeded on textures:

1. Display the effective values and live movement metrics.
2. Test representative Pokémon together.
3. Use visual observations to identify the failing mechanism.
4. Adjust one control or rule at a time.

Initial visual set:

- Bulbasaur — ordinary quadruped
- Pikachu — biped
- Rattata — nearly straight legs
- Growlithe — unequal front/hind leg spans
- Seel or Sandslash — splayed stance
- A large and a very small walker

## Scope boundary

This first implementation should cover walkers only. Flying, swimming, hopping, slithering, rolling, and floating are declared but still lack controllers in pokemon-movement.js:22.

Port Creature behavior modes—wander, follow, forage, combat, race—belong later in Pokémon Park. The Lab should remain the controlled place for authoring and validating how an individual Pokémon moves.
