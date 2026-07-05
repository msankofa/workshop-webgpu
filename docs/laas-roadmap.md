# LAAS v2 Fidelity Roadmap — `workshop-webgpu`

**Purpose:** prioritized build order to close the gap between the current `workshop-webgpu`
renderer and the PROJECT LAAS v2 spec (fully-procedural UE5-fidelity WebGPU open world).
Ordered by **fidelity-per-effort on top of the chassis we already have**, not by spec phase order.

Source audit: three-agent survey of the codebase, 2026-07-04. See scorecard below.

---

## Ground truth: what already exists (the chassis)

Do **not** rebuild these. Build on them.

- **CDLOD terrain streaming** (`cdlod-terrain.js`) — GPU quadtree LOD selection + morphing, crack-free, indirect draws.
- **GPU-instanced vegetation** (`forest-gpu.js`, `grass-compute.js`, `plants-gpu.js`) — deterministic seeded placement, compute-driven, 4-ring LOD, per-instance size/yaw/variant jitter.
- **Clustered forward+ lighting** (`clustered-lights.js`) — up to 256 dynamic point lights, real Cook-Torrance GGX. Direct light only, no bounce.
- **Post/tonemap chain** (`post-fx.js`, `post-grade.js`) — AgX/ACES/Reinhard, full grade chain (gain/contrast/gamma/white-balance/saturation/vignette), bloom. All live-tunable, all Node-tested. **Unopinionated** — no enforced look.
- **Lake water** (`water.js`) — real reflection (`ReflectorNode`), screen-space refraction, procedural caustics. Lakes only, flat bed.
- **Grass wind** (`grass.js`/`grass-compute.js`) — real per-vertex sine sway + cloud-shadow noise. The only working vegetation motion.
- **CPU/GPU math twins** (`forest-cull.js`, `light-cluster.js`, `post-grade.js`) — Node-testable mirrors of GPU math. Keep in sync manually.

## Scorecard (current state vs LAAS v2)

| Pillar | Score | One-line state |
|---|---|---|
| A. Geometry, not textures | 2/10 | Vegetation is real geometry; ground is texture-splat on a 6-sine analytic heightfield. No rock/cobble/litter meshes. |
| B. Light transport | 1/10 | One PCF shadow map + flat ambient constant. No GI, GTAO, bounce, or translucency. Shadows read gray. |
| C. Nothing is bare | 1.5/10 | No moss/vines/ferns/debris/dressing. 2-band slope→material texture swap only. |
| D. Distance holds | 1/10 | Good LOD plumbing, no craggy content, flat billboard impostors, no volumetric clouds/far-detail synthesis. |
| E. Art direction | 1.5/10 | Good grade machinery but no ToD color script, auto-exposure, value structure, or composition system. |
| F. The world moves | 2.5/10 | Grass wind + lake water are real. Trees/plants static, no shared wind field, no streams, wrong particle species. |

Floors: 4×4km world **~2/10** · GPU-sim eroded heightfield **0** · 5M tris/frame **1** · 200k-tri hero rocks **0** · Hillaire atmosphere **0** · volumetric clouds **1** · GI probes **0** · CSM+PCSS **2** · meshlet/Hi-Z cull **3** · composition/flythrough **0**.

---

## Roadmap — prioritized by fidelity-per-effort

### Tier 1 — Cheapest high-impact wins (reuse existing machinery, days–weeks)

These reuse chassis that already exists and move multiple pillars off the floor fast.

**T1.1 — Time-of-day color script + auto-exposure + composition** · Pillars E, (B) · effort **S** · leverage: grade chain already built & tested
- Map sun elevation → per-ToD grade presets (dawn/noon/golden/dusk/night), enforce the teal-orange split-tone (warm lit / cool shadow) automatically instead of via manual sliders.
- Add EV-based auto-exposure (histogram or illuminance-scaled sun) replacing the flat manual multiplier.
- Add ≥9 authored camera bookmarks (`1`–`9`) + a ≥90s flythrough (`C`) crossing ≥3 biomes. No camera-path system exists today — build one.
- Payoff: turns an unopinionated instrument panel into a *directed look*. Cheapest 2-point jump on the board.

**T1.2 — Sky-driven ambient + no-black-shadows first slice** · Pillar B · effort **S–M** · leverage: clustered-lights injection path, existing ambient
- Replace the single flat `AmbientLight` constant with a hemispheric / SH sky-irradiance term (blue up, terrain-bounce tint down) driven by the current sky palette.
- Add a foliage translucency/transmission term (leaves let sun through) — grep confirms zero exists today.
- Payoff: directly attacks the "shadowed foliage reads gray" failure. No probe volume yet — this is the cheap 80%.

**T1.3 — Wind on trees & plants via a shared gust field** · Pillar F · effort **S–M** · leverage: grass wind shader as template
- Author one shared global wind field (direction + gust-noise texture) sampled by ALL vegetation, not grass's private local sine.
- Wire hierarchical sway into `trees.js` (trunk→branch→leaf) and `plants.js` (both fully static today).
- Payoff: "frozen frame one second from motion" — currently only true where grass is on screen.

### Tier 2 — Medium builds on the instancing/compute engine (weeks)

**T2.1 — GTAO + screen-space contact shadows** · Pillar B · effort **M** · prereq: MRT normal buffer (already flagged as the missing piece in `post-fx.js`)
- Implement the GTAO pass that `post-fx.js:5-6` stubs as "v2." Add short-raymarch contact shadows so every pebble/grass clump is grounded.

**T2.2 — Ground dressing + near-field debris** · Pillars C, A · effort **M–L** · leverage: GPU instancing/scatter pipeline
- Scatter cobbles/pebbles (3+ size classes, water-rounded near streams), twigs, leaf-litter cards, bark chips — floor is ≥80k near-field instances; today it's 0.
- Add per-surface dressing: cliff moss/vines/ledge ferns/dirt streaks, tree-base root flare/litter rings/fungi, stream-margin wet darkening.
- Add per-instance hue/value/age jitter + a dry/broken/dead fraction (`tree-age.js` exists but is unwired).
- Payoff: kills "bare terrain texture within 10m" — the single biggest Pillar A/C failure.

**T2.3 — CSM cascades + PCSS** · Pillar B · effort **M** · leverage: existing shadow-map setup
- Upgrade the single fixed-frustum 2048² map to 4 texel-snapped CSM cascades + PCSS contact hardening.

### Tier 3 — Large builds, high fidelity ceiling (weeks–months each)

**T3.1 — Simulated + eroded heightfield with rivers** · Pillars A, D · effort **L** · replaces analytic `terrainHeightAt`
- GPU hydraulic (pipe-model) + thermal erosion ≥500 iters on a ≥4096² grid; flow-accumulation → river network → channel carve → moisture field. This is the geology foundation everything else sits on. Gate behind a `?scene=terrain` before/after split view.

**T3.2 — Rock/cliff geometry + far-detail synthesis + cobbled streambeds** · Pillars A, D · effort **L**
- Hero rock/cliff generator (≥200k tris LOD0, ≥6 displacement octaves, craggy silhouettes).
- In-shader distance re-amplification so 10km peaks stay serrated (ridged detail in normal/height domain).
- Fully-cobbled streambed geometry (needs T3.1 rivers + T2.2 debris).

**T3.3 — Hillaire atmosphere + raymarched volumetric clouds + cloud shadows** · Pillars D, B, E · effort **L**
- Hillaire-style transmittance + multi-scatter LUTs driving sky, aerial perspective, and IBL (replaces the gradient dome + flat `THREE.Fog`).
- Raymarched Worley–Perlin 2-layer clouds with temporal reprojection, able to sit below peaks; project cloud shadows onto terrain. Today: one unlit 2D noise plane.

**T3.4 — Irradiance probe volume GI + screen-space bounce** · Pillar B · effort **L** · completes T1.2
- Per-chunk irradiance probe volume (≥24×24×6), async GPU-updated from sky+sun+terrain bounce; + screen-space color bleed. The full no-black-shadows law.

### Tier 4 — Throughput to actually hit the floors (after content exists)

**T4.1 — Meshlet/Hi-Z cluster culling + octahedral impostors + triangle-budget HUD** · floors · effort **L** · leverage: indirect-draw infra already present
- ~64-tri cluster culling with frustum + Hi-Z occlusion → compacted indirect draws (per-instance frustum cull was deliberately dropped; occlusion is absent).
- Octahedral impostors (≥8×8 views, albedo+normal+depth) replacing the single flat billboard.
- HUD triangle counter to verify the ≥5M forest / ≥3M vista floors. Only meaningful once T3.1–T3.2 produce the geometry to cull.

---

## Sequencing notes

- **Do Tier 1 first regardless.** It's cheap, it moves E/B/F off the floor, and T1.1's composition bookmarks + T1.2's ambient give you the review surface (composed shots, non-black shadows) needed to judge everything after.
- **T2.2 (dressing/debris) depends on nothing** and pays the biggest Pillar-A/C dividend short of the heightfield rebuild — it can run parallel to Tier 1.
- **Tier 3 is a hard dependency chain:** T3.1 (eroded terrain) unblocks T3.2 (rock/streambeds) and improves T2.2 placement. T3.3 and T3.4 are independent of the terrain rebuild and can run in parallel.
- **T4.1 is last on purpose** — culling and triangle floors are meaningless until Tier 3 produces enough geometry to need them.
- Keep the **CPU/GPU math twins** in sync for any new TSL math (dressing scatter, cloud density, probe sampling) so it stays Node-testable.

## Effort legend

**S** ≈ days · **M** ≈ 1–2 weeks · **L** ≈ multiple weeks to months. Pillars in parentheses are secondary beneficiaries.
