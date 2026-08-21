# Move-effect recomposition swarm — 2026-08-16

Ten Sonnet agents, five pairs, one effect module per pair, identical prompt within a pair (only the
assigned file name differed). Each read the whole `moves/` subsystem and the harness, then proposed
5–8 new moves built from its module's parts, borrowing from the other four where useful. Read-only.

## Convergence across all five pairs

These came up in nearly every report, unprompted:

1. **Nothing is exported.** Every module's helpers (`walkCrack`, `buildRing`, the puff kit, `makeCrystalGeometry`, `boltPoint`…) are closure-private, so "reuse" means copy-paste. Several agents proposed a shared `move-parts.js` (ring/path/particle kits) in `move-core`'s style.
2. **CPU/GPU twins are the trap.** Bolt's `axisPoint` (no kink) and stream's `frontAt` (sag only) mirror the vertex shader by hand; any recomposition that changes the axis (helix, arc, ring, sky-strike) must edit both or sparks/puffs/lights float off the drawn shape.
3. **The 6-light pool is the ceiling** for every multi-cast idea (Discharge, chained bolts, bolt+fissure).
4. **Contract gaps** named repeatedly: no hold-forever/persistent phase (hazards, weather); no status/no-damage flag (harness always calls `hit()`); no multi-target; no body attachment (`group` goes to `scene`, so buffs don't follow the rig); `DEFAULTS` are factory-time, only `power` varies per cast.
5. **Universal donors:** stream's `SpriteNodeMaterial` puff kit for anything that must billboard (with the InstancedMesh-`positionNode` trap restated by 6+ agents), and aurora's `buildRing` for anything ring-shaped.
6. **Hard-coded numbers that should be options:** bolt `easeIn` (line 527), aurora harmonic frequencies and `power` exponents, fissure `growBranches` spacing constants, crystals `sides=6`/taper ranges.

## Per-pair verdicts

| Module | Both proposed (same idea) | Same name, different recipe | Only A | Only B | Effort disagreement |
|---|---|---|---|---|---|
| **bolt** | Discharge (N casts on aurora ring, light-pool warning); Thunder Wave (pinch/converge, status-flag gap); "boltPoint's axis term is the one lever"; per-rig single origin/target | — | Thunder sky-strike, Light Screen dome, Wrap helix, forking Thunder via fissure branches | Zap Cannon charge-up (easeIn), Wild Charge two-cast, Thunder Fang (bolt→fissure onImpact), Chain Lightning | Thunder Wave: A M, B S |
| **stream** | Whirlpool (aurora ring, L, frontAt desync); poison decal that persists (Toxic/Sludge); pool key = palette so structural variants need a new kit; burst is always a sphere, decal always a disc | Discharge — A: per-instance tubes (L); B: linear-noise column (M) | Icy Wind puffs-only, Will-O-Wisp arc, Fire Spin helix, Acid Spray + crystal chips | Sandstorm palette-only, inverted-heat beam, Razor Leaf spiral puffs, Confuse Ray pulsing radius, dual-hose | — |
| **crystals** | Hazard-in-place (Spikes / Stealth Rock, S); ring around target via aurora ring; armor self-buff blocked on body-anchor gap; Diamond Storm (L); placement fused in `cast()`, `records[]` schema is the seam; trigger keyed to `r.along`; no TSL in module | Icicle Spear — A: thrown along the line; B: falls from above | Psycho Cut erupt-then-launch | Rock Slide on fissure `walkCrack`, chip shape shared across palettes | Stream-puff layer: A "Toxic Spikes" **L** (first TSL in file); B "Freeze-Dry" **S/M** (copy verbatim) |
| **fissure** | Self-centred burst-only (A "Explosion", B "Magnitude"); ember swap to stream sprites; `walkCrack`/`growBurst` most reusable; `uGrown`-vs-`aDist` reveal is best trick and hard constraint (monotonic, one distance space) | Precipice Blades — A: crystals blades along the crack (L); B: parallel lanes (M). Magnitude — A: retrigger flash (S/M); B: self burst (S) | Bulldoze palette, Earth Power + stream dome, Thousand Arrows + crystals | Sandsear Storm inbound cracks, Rock Slide + crystals bounce, Will-O-Wisp embers-only, Spikes lips-only, palette required-fields trap (`pal.emberRise` throws) | — |
| **aurora** | Safeguard dome (M, reuse `curtainMaterial` sway, new geometry); Trick Room disc + checker; persistent weather blocked on hold mode (A Rain Dance, B Sandstorm); harmonic consts not options; motes flat quads; `u`-as-angle trick undocumented | — | Screech hem rings, Light Screen arc, Toxic Spikes at target + crystals, Iron Defense, no material pooling, centre hard-coded to origin | Curse inverted lift, Sing motes-only, Will-O-Wisp orbiting stream puffs, Icy Wind radial shockwave, `power` exponents inline | Trick Room: A L, B M |

Pattern in the divergence: in every pair one agent leaned **orchestration/subtraction** (sequence casts, drop parts, retune) and the other leaned **topology change** (helix, dome, inbound, parallel). Bolt B / stream A / fissure B / aurora B were the subtractive ones. Effort estimates only disagreed where one agent counted "first TSL in this file" as a cost and the other counted lines copied.

## Names that recurred across pairs

Discharge (bolt×2, stream×2) · Will-O-Wisp (stream A, fissure B, aurora B) · Spikes/Toxic Spikes/Stealth Rock (crystals×2, fissure B, aurora A) · Iron Defense (crystals×2, aurora A) · Sandstorm (stream B, aurora B) · Rock Slide (crystals B, fissure B) · Light Screen/Safeguard (bolt A, aurora×2).

## Cheapest wins (S, agreed or unopposed)

- crystals: **Stealth Rock / Spikes** — `impactFraction`/`holdTime` overrides + a registry row.
- stream: **Sandstorm / Sludge Bomb** — palette-only.
- fissure: **Bulldoze** — palette + options; **Explosion/Magnitude** — burst-only path.
- bolt: **Spark** — palette + `DEFAULTS`; **Zap Cannon** — promote `easeIn` to an option.
- aurora: **Screech** — hem rings only; **Curse** — inverted lift + dark palette.

## Suggested prep before building any of the M/L ones

1. `moves/move-parts.js`: export `buildRing`, `walkCrack`/`growBurst`, the sprite puff kit, `makeCrystalGeometry`.
2. Promote the hard-coded constants above into each module's `DEFAULTS`.
3. `move-core.js`: a `hold` mode on the phase machine; `move.status` in the registry so the harness skips `hit()`.

---

# Raw reports

Verbatim agent output is in `2026-08-16-move-fx-recomposition-raw.md`.

---

# Candidate modules and their move rosters

The recompositions above collapse into eleven new effect modules. Each one is a fork of an existing
module with one structural change, and each can then carry a family of moves the way `bolt` carries
Thunderbolt, Dark Pulse and Dazzling Gleam — palette rows rather than new code. Types in brackets.

## 1. `fx-orb` — forks `stream`
The column becomes a small travelling sphere with a puff trail. Burst dome, ground decal, pooled
light and the puff kit are reused unchanged; only the axis geometry is replaced.

Shadow Ball [ghost] · Energy Ball [grass] · Sludge Bomb [poison] · Focus Blast [fighting] ·
Aura Sphere [fighting] · Electro Ball [electric] · Mud Bomb [ground] · Will-O-Wisp [fire] ·
Weather Ball [normal] · Zap Cannon [electric]
Palettes: shadow, verdant, sludge, aura, ember.

## 2. `fx-cloud` — forks `stream`
Drop the tube; drive only the puff layer as a cone or a spreading field. Lowest-risk fork, because
the puff kit is already free-standing.

Icy Wind · Powder Snow [ice] · Smokescreen · Sweet Scent [normal] · Poison Gas · Poison Powder
[poison] · Sleep Powder · Stun Spore [grass] · Heat Wave [fire] · Sand Attack [ground] ·
Ominous Wind [ghost] · Bubble [water]
Palettes: frost, smoke, spore, cinder, dust.

## 3. `fx-vortex` — forks `stream`
The straight axis becomes a helix around a vertical axis at the target. `frontAt` must be rewritten
to match or the puffs and light leave the funnel.

Fire Spin · Magma Storm [fire] · Whirlpool [water] · Sand Tomb [ground] · Wrap · Bind [normal] ·
Leaf Tornado [grass] · Twister [dragon] · Hurricane [flying] · Infestation [bug]
Palettes: flame, water, sand, leaf, gale.

## 4. `fx-tether` — forks `bolt`
Both ends pinned (`pinch`/`converge` at 1), travel skipped, held through a long impact. Drain moves
add motes streaming back along the link toward the caster.

Thunder Wave · Parabolic Charge [electric] · Absorb · Mega Drain · Giga Drain [grass] ·
Leech Life [bug] · Dream Eater [psychic] · Spirit Shackle [ghost] · Mean Look [dark] ·
Lock-On [normal]
Palettes: paralysis, drain, spectral.
Gated on: the hold mode and the status/no-damage flag.

## 5. `fx-skyfall` — forks `crystals`
Records start above the ground and fall instead of erupting; chips fire on landing. Needs a sky
anchor, which no part currently provides (line samples are all ground height).

Rock Slide · Rock Throw · Diamond Storm [rock] · Icicle Crash · Avalanche [ice] ·
Draco Meteor [dragon] · Meteor Beam [rock]
Palettes: stone, ice, meteor.

## 6. `fx-ring` — forks `crystals` placement onto `aurora`'s `buildRing`
Ring placement around a chosen centre, with the trigger sweep keyed to angle instead of `along`.
The one fork that serves both hazards (centred on the target) and buffs (centred on the caster).

Rock Tomb [rock] · Spikes [ground] · Toxic Spikes [poison] · Stealth Rock [rock] ·
Sticky Web [bug] · Iron Defense [steel] · Barrier [psychic] · Withdraw · Harden [normal] ·
Cotton Guard [grass]
Palettes: stone, toxic, web, steel, glass.
Gated on: hold mode for the hazards; body anchoring for the buffs to track a walking rig.

## 7. `fx-dome` — forks `aurora`
The curtain grid becomes a sphere cap closing overhead, with the hem ring kept as its base. The
sway, ripple and fold-lit colour terms port over unchanged.

Protect [normal] · Safeguard [normal] · Light Screen · Reflect · Magic Coat [psychic] ·
Barrier [psychic] · Wide Guard [rock] · King's Shield [steel] · Aqua Ring [water]
Palettes: screen, reflect, safeguard, protect.

## 8. `fx-shock` — forks `fissure` (burst-only) with `aurora`'s hem rings
Expanding rings from a centre, no main path. Both fissure agents proposed the burst-only path
independently, which makes this the best-evidenced of the new modules.

Explosion · Self-Destruct · Boomburst · Hyper Voice · Screech · Round [normal] · Magnitude ·
Bulldoze · Earthquake [ground] · Discharge [electric] · Surf · Muddy Water [water] ·
Petal Blizzard [grass]
Palettes: blast, quake, sonic, wave.

## 9. `fx-field` — forks `aurora`
A flat disc or overlay covering the arena that holds rather than sweeping. The widest roster and
the one most blocked by the contract.

Trick Room · Gravity · Magic Room · Wonder Room [psychic] · Rain Dance [water] · Sunny Day [fire] ·
Sandstorm [rock] · Hail [ice] · Electric Terrain [electric] · Grassy Terrain [grass] ·
Misty Terrain [fairy] · Psychic Terrain [psychic]
Palettes: warp, rain, sun, sand, hail, terrain.
Gated on: the hold mode; nothing here works as a bounded cast.

## 10. `fx-blade` — forks `bolt`'s camera-facing ribbon
A short arc swept across the target instead of a filament bundle: same extrusion and clip, no kink,
no restrike.

Slash · Fury Cutter [normal] · Night Slash [dark] · Psycho Cut [psychic] · Air Slash ·
Aerial Ace [flying] · X-Scissor [bug] · Cross Poison [poison] · Sacred Sword [fighting] ·
Razor Shell [water] · Precipice Blades [ground]
Palettes: steel, shadow, psychic, wind.

## 11. `fx-aura` — forks `aurora` at body scale, with `bolt`'s spine for the electric looks
A self buff hugging the caster rather than ringing the ground.

Swords Dance · Work Up · Agility [normal] · Calm Mind [psychic] · Bulk Up [fighting] ·
Nasty Plot [dark] · Dragon Dance [dragon] · Growth [grass] · Charge [electric] ·
Focus Energy [normal] · Curse [ghost] · Wild Charge [electric]
Palettes: might, mind, malice, draconic.
Gated on: body anchoring, or the aura sits where the caster stood at cast time.

## Where a new module is not warranted

Several proposals read as new moves but are palette or option rows on what already exists, and
should be tried there first: Sandstorm and Sludge Bomb on `stream`, Spark and Zap Cannon on `bolt`,
Bulldoze on `fissure`, Stealth Rock on `crystals`, Curse and Mist on `aurora`. Each is a `MOVES` row
plus a palette, which is the honest baseline every module above should be measured against.

## Ordering

`fx-cloud` and `fx-shock` first — both are subtractive forks of proven parts with no contract work.
Then `fx-orb`, `fx-blade` and `fx-ring`, which need new placement or geometry but no core changes.
`fx-dome`, `fx-vortex` and `fx-skyfall` need genuinely new geometry or a rewritten CPU twin.
`fx-tether`, `fx-field` and `fx-aura` should wait for the hold mode, the status flag and body
anchoring, since without those they can only fake what they are meant to express.
