# Shoot House Redesign Plan — "Internetcore Arena"

Baseline: the v2 shoot house is topologically correct and tested, but visually it's greybox and its
content is incoherent random clutter. This plan is a **redesign**, not a polish pass: a committed
aesthetic + an intentional layout language. It supersedes the earlier de-slop draft.

## Direction (locked)

- **Aesthetic: modern-futuristic "internetcore."** Dark glossy surfaces, emissive **neon trim**, a
  glowing **floor grid**, gradient/holographic accents, heavy bloom, reflections, atmospheric haze.
  The emissive glow is the primary light source, not white lamps.
- **Roof stays OFF — the starfield is the ceiling.** Design *into* the open top: an open-air neon
  arena/platform under the night sky. Wall-top emissive edges frame the stars.
- **Layout is redesigned for intent.** Kill the random crates/tables/chairs/shelving. Cover becomes a
  small legible vocabulary, composed deliberately around doors and sightlines. Every element has an
  obvious identity and reason to exist.

### Palette (proposed default — confirm or redirect)

| Role | Hex | Use |
|---|---|---|
| Base / void | `#0a0b12` | floor, wall bodies (near-black, semi-gloss) |
| Primary neon (cyan) | `#39f0ff` | floor grid, main trim, "cyan wing" |
| Secondary neon (magenta) | `#ff3df0` | accent trim, "magenta wing" |
| Tertiary (electric violet) | `#8b5cff` | gradients, transitional zones |
| Warning (amber) | `#ffb020` | hazard/objective markers only (sparse) |

Two-tone zoning: left wing cyan, right wing magenta, corridor violet — reinforces the asymmetry we
already generate and gives the eye a color map of the space.

## Aesthetic system (the "internetcore" look, concretely)

Materials (WebGPU/TSL, asset-free — procedural, no textures needed):
- **Floor** — near-black, low-roughness (semi-reflective) with an emissive **world-space grid** (thin
  cyan lines, subtle glow) via TSL. Screen-space or planar reflection doubles the neon. This single
  element carries most of the "internetcore" read.
- **Walls** — dark matte panels with **emissive edge trim**: glowing strip along the top lip and the
  base, and a **portal frame** (emissive surround) around every doorway. Faint glowing panel-seam lines.
- **Cover / props** — dark bodies with a **bright emissive top edge** + corner accents, so a barrier
  reads instantly as "cover" and glows in the dark.
- **Pillars** — full-height dark columns with **vertical neon light-strips**.

Lighting & post:
- Interior lit mostly by **emissive trim + a few colored area/point lights** matching the neon (cyan
  left, magenta right). Kill the flat white lamps and the invisible floating sources.
- **Bloom** (strong on emissives), **AO/contact shadows** (grounding), **fog/haze** (so neon glows and
  depth reads), tuned exposure/filmic tone. Confirm `post-fx.js` runs under `NO_ENVIRONMENT`.
- Optional shadow-casting keys for silhouette; reflective floor for the money shot.

Fix the current confetti: signs become **wall-mounted emissive placards** at correct scale (~0.4 m),
integrated into the portal frames — not subpixel floor specks.

## Layout redesign (fix "sloppy + wtf are the cubes")

Keep the strong bones (central corridor spine, side rooms, verticality) but replace random content with
an **intentional composition system**.

**1. A tight cover vocabulary — legible, purposeful, on-theme. Remove crates/tables/chairs/shelving.**

| Element | Form | Role |
|---|---|---|
| **Holo-barrier** | chest-high dark block, glowing top lip | peek/vault cover; defines a firing lane |
| **Light-pillar** | full-height column, vertical neon strip | hard cover you flank around; rhythm/landmarks |
| **Half-wall baffle** | waist-to-chest angled/straight segment | breaks sightlines, forces movement |
| **Holo-platform** | raised deck, glowing edge, light railing | verticality/overwatch (replaces ad-hoc mezzanine) |
| **Portal door** | emissive doorway frame | reads the opening, threat indicator |

**2. Room archetypes — each a *designed* cover composition, not random scatter.** Seed varies the
parameters (spacing, mirroring, which lane), not whether cover exists. A curated set, e.g.:
- **Gauntlet** — staggered baffles forming a serpentine lane from door to far side.
- **Atrium** — central light-pillar cluster with radial low cover; open sightlines around it.
- **Crossfire** — two flanking half-walls creating overlapping lanes onto the entry.
- **Overwatch** — a holo-platform over low approach cover; vertical threat.
- **Open** — deliberately empty breathing room (still needed for pacing).

**3. Composition rules, not rejection sampling.** Cover is placed *relative to* the room's doorways and
the corridor sightline: create a peek position covering each entry, a flank route, and cover-to-cover
bounds. Symmetric/rhythmic arrangements read as intentional. Deterministic and legible.

**4. Clean up the bolted-on feel.** Fold vestibule/stairs/platforms into the archetype language so they
read as designed rooms, not appendages. Proportion pass by eye for the aesthetic (strong clean lines,
wider lanes).

## Phased execution (ROI order)

| Phase | Scope | Impact | Effort |
|---|---|---|---|
| **0 Prereqs** | Confirm palette; restore see-it loop (browser or screenshots); confirm post-fx runs. | — | — |
| **1 Aesthetic foundation** | Floor grid + reflection, wall emissive trim + portal frames, dark glossy PBR, neon lights, bloom/AO/fog/tone. **This births the look.** | ★★★★★ | Med |
| **2 Layout redesign** | New cover vocabulary + room archetypes + composition rules; delete random clutter; fix signage. **This fixes the "sloppy" content.** | ★★★★★ | Med–High |
| **3 Zoning & detail** | Two-tone wing palette, panel seams, holo-platforms, light-pillars, per-archetype tuning. | ★★★★☆ | Med |
| **4 Polish** | Color grade, volumetrics, curated beauty spawn, reflection tuning. | ★★★☆☆ | Low–Med |

Do 1 and 2 together for the first reviewable jump — the look and the layout reinforce each other
(neon trim only reads well on intentional geometry; intentional cover only reads well when it glows).

## Definition of done

From the **FPS eye**: a first-time viewer reads a sleek open-air neon CQB arena under the stars —
glowing floor grid, portal-framed doors, legible glowing cover arranged with obvious tactical intent,
color-zoned wings — not a grey floor plan with random cubes. Every change judged against a screenshot.

## Open decisions (need from you)

1. **Palette**: cyan/magenta/violet as above, or a different neon set?
2. **Layout bones**: keep the corridor-killhouse spine, or go more open-arena (fewer walls, more
   platform + cover, since the roof-off starfield already reads "arena")?
3. **See-it loop**: re-enable browser automation so I iterate on screenshots, or you post shots?
