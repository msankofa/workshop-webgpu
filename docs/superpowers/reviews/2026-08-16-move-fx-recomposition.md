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
