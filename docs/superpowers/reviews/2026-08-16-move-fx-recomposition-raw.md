# Move-effect recomposition swarm — raw agent reports

Companion to `2026-08-16-move-fx-recomposition.md`. Verbatim Sonnet output, A then B per module.

---

# fx-bolt — A

## Parts inventory (`moves/fx-bolt.js`)

**Geometry**
- `boltGeometry(strands)` (106-133) — cached `InstancedBufferGeometry`: a `(t, side)` ladder strip, one instance per filament via `aStrand`. Params: `O.nodes` (segments), `strands` (instance count, capped by `O.maxStrands`). Never culled (`boundingSphere` set to 1e4) because it's placed entirely in-shader.
- `flashGeo` (135) — shared `IcosahedronGeometry(1,2)` for muzzle/impact flash spheres. Free-standing.
- `sparkGeometry()` (138-147) — two perpendicular crossed quads so a point sprite never vanishes edge-on. Free-standing, reusable for any CPU particle.

**TSL shape helpers (tightly coupled to each other + the `u` uniform bundle)**
- `hash11` (156-161) — cheap hash. Free-standing.
- `vnoise(x, seed)` (164-167) — *linear* value noise, hard corners on purpose. Free-standing, parametrized by seed/frequency.
- `kink(t, seed)` (174-188) — 5-octave fractal jitter offset in the plane perpendicular to the axis. Reads `uJitterScale/uSpan/uCrawl/uJitterFalloff/uOctaves`. Coupled to `boltPoint`.
- `boltPoint(t, seed, radial)` (190-201) — axis `mix(uOrigin,uTarget,t)` + sag, endpoint pin/converge via `uPinch/uConverge`, kink offset, twist/spread fan (`uTwist/uTwistSpeed/uSpread/uSpreadNear/uSpreadCurve`). This is the shape kernel; only reusable as a whole (or as a template to copy/modify).
- `strandSeed()` (205) — the "restrike" mechanic: snaps every filament to a new shape `uRestrike` times/sec, `kink`'s `crawl` slides continuously in between. Reusable pattern for any filament bundle needing periodic re-randomization.
- `radialOf()` (206), `flashOf()` (207) — per-strand position-in-bundle, and quantized per-strand flicker.

**Ribbon rendering (free-standing techniques)**
- `positionNode` (217-241) — camera-facing ribbon: finite-difference tangent (mirrored at the far end), `binormal = cross(tangent, toCamera)`, half-width composed from tip-taper × per-radial core-width × flicker × fade. Generic "turn any parametrized curve into a camera-facing ribbon" building block.
- `profileOf()` (245-248) — cross-ribbon `pow(1-|v|, sharpness)` falloff. Generic ribbon cross-section.
- `drawnOf()` (249-252) — tip clip via `uProgress`, i.e. "growing front is a clip, not a scale." Generic growth technique.
- `colorNode` (254-263) — 3-tier color ramp (outer→inner→core) + additive front-glow term.
- `opacityNode` (265-271) — profile × drawn × global flicker × per-strand flash × fade × edge-strand dimming (`uBranchDim`).
- `boltMaterial(u, isGlow)` (169-274) — factory producing the halo-pass/core-pass pair from one shared graph. The "wide additive halo + hot core, same geometry, two materials" pattern is itself a reusable structural idea.
- `additiveMaterial(color)` (276-285) — trivial flash material (additive, untone-mapped, opacity uniform).

**Rig / pooling**
- `buildRig(palName)` (293-340) — one group per palette: 2 ribbon meshes, muzzle flash, impact flash, spark `InstancedMesh`. `~35`-entry uniform bundle `u` is built here from `O` (factory-level options), **not** from per-cast args — see Observations.
- `takeRig`/`giveRig` + `pool` Map (342-355) — per-palette object pool so a repeated cast doesn't recompile shaders.

**CPU sparks subsystem** (404-469, mostly free-standing given an axis function)
- `axisPoint(s, out)` (404-410) — CPU twin of the shader's axis term only (no kink), so sparks sit near the bolt.
- `bundleRadius(s)` (411) — CPU twin of the spread/fan radius.
- `emitSparks`/`updateSparks` (421-469) — rate-limited (`createRateEmitter`), gravity+drag integrated, life-tinted crossed-quad `InstancedMesh`.

**Flashes / light**
- `popFlash(mesh, at, size, age, life)` (473-481) — generic outCubic-scale/inQuad-fade pop, independent of bolt shape.
- `lightShimmer(age)` (491-495) — hard quantized stutter (distinct style from stream's/fissure's sinusoidal flicker).
- `driveLight(s, fade, boost)` (497-502) — moves one pooled light along `axisPoint`.

**Orchestration**
- Phase-machine callbacks (526-560) — the "recipe": spawn burst → travel trickle (sparks+light) → impact burst (flash+sparks+light boost) → fade that hangs (`t<1`) then blows out cubically (`t>1`). Free-standing as a timeline pattern, reusable on any axis.

**Coupling summary**: `kink`+`boltPoint`+`strandSeed`+`radialOf`+`flashOf` only make sense together (share `u`). `profileOf`/`drawnOf`/ribbon `positionNode` are generic and portable to any curve. The spark subsystem is portable to any axis function as long as its CPU twin is kept in sync manually.

## Recompositions

**1. Spark** — *Effort S, confidence highest.*
Recipe: pure retune of existing bolt parts — `boltGeometry`/`boltMaterial` unchanged, new palette (white-blue), `DEFAULTS` overrides only: near-zero `sag`, `spreadNear≈spread` (tight bundle), tiny `travelTime`, `restrike` cranked, `sparkRate`/`impactSize` boosted. No new code beyond a second `createBoltFx(deps, {...})` instance or a palette + option row.
Risk: none structural; only risk is it reading indistinguishable from Thunderbolt if under-tuned (a "look," not an "effect," per the doc's own distinction).

**2. Discharge** — *Effort M.*
Recipe: reuse `boltGeometry`/`boltMaterial`/rig-pooling wholesale; borrow the ring-sampling idea from `fx-aurora.js`'s `buildRing` (aurora.js:84-95) to pick N points around the attacker, then call `cast()` N times with `line`s from attacker to each ring point (a starburst of short bolts instead of one attacker→target bolt).
New code: a small wrapper that computes ring points and issues multiple `boltFx.cast()` calls, staggered by a frame or two.
Risk: the demo/harness only wires single attacker→target hit resolution (`castMove` in `pokemon-moves.html:167-193`); multi-target damage needs harness changes — contract gap, not a bolt-module problem. Also 6-light pool (`pokemon-moves.html:138-143`) could be exhausted by N simultaneous `lights.acquire()` calls; `driveLight`/light acquire already null-guards so it degrades gracefully but some spokes go unlit.

**3. Thunder (sky strike)** — *Effort M.*
Recipe: keep `boltPoint`/`kink`/ribbon/material entirely as-is; only change how `origin` is computed at cast time (currently `line.origin + dir*originForward` at fx-bolt.js:372-376) to a point high above the target instead of near the attacker's mouth, then straight-line down. Optionally chain 2-3 staggered casts (restrike-as-separate-casts) for the "multiple strikes" read.
New code: an `overhead: true` cast option that swaps the origin/target computation block; reuses `machine`/sparks/light untouched.
Risk: `axisPoint` (404-410) and `bundleRadius` (411) are CPU-side duplicates of the GPU axis — if the new origin math isn't mirrored exactly in both places, sparks will drift off the visible bolt (the CPU/GPU-twin trap this repo already documents elsewhere). Also `sourceY` semantics change meaning (no longer "mouth height") — needs a naming/contract note.

**4. Thunder Wave** — *Effort M.*
Recipe: `boltPoint`'s existing `uPinch`/`uConverge` already support pinning *both* ends solid (fx-bolt.js:193-195), which is exactly a tether/Jacob's-ladder look. Set long `impactTime` (sustained hold), low `sag`, and drive it as a status effect rather than instant damage.
New code: essentially none in the module — mostly a `DEFAULTS` retune (long hold, minimal restrike). The real gap is at the contract layer: `move-registry.js`/`move-core.js` have no "no damage" or "status" flag, and the harness's `onImpact` always calls `hit()` (pokemon-moves.html:189, 259-265). A `move.status = true` (or `power = 0`) convention would need to be added.
Risk: contract-fit, not rendering risk — could look correct in isolation but the harness will still deduct HP unless wired to skip `hit()`.

**5. Light Screen / Barrier (self dome)** — *Effort L.*
Recipe: borrow `fx-aurora.js`'s ring-around-caster placement (`buildRing`, aurora.js:84-95) for anchor points, but render each ring-to-apex-and-back arc using bolt's `boltPoint`/`kink`/ribbon material instead of aurora's cloth sway — i.e., N short "boltPoint" arcs from ring point up to a shared apex above the attacker, forming a crackling dome. Uses `self: true` casting, which the harness already supports (pokemon-moves.html:176, 185).
New code: a variant of `boltPoint` whose `uOrigin`/`uTarget` are per-arc ring-point/apex pairs (needs either per-instance uniforms via an attribute, or N separate small bolt rigs like Discharge).
Risk: largest structural change — `boltPoint`'s uniforms (`uOrigin`, `uTarget`, `uN1/uN2`) are currently per-rig, not per-instance, so N arcs either mean N cheap rigs (fine, mirrors Discharge) or extending the geometry to carry per-arc origin/target as instanced attributes (more invasive). Visual risk: a dome built from straight filament arcs may read as "cage" rather than "shield" unless density/twist is tuned up.

**6. Wrap / Bind (coiling tendril)** — *Effort L.*
Recipe: reuse the ladder-strip geometry, `kink`, `profileOf`/ribbon `positionNode`, but replace `boltPoint`'s straight `mix(origin,target,t)` axis with a helical path around a fixed anchor near the target (spiral radius shrinking as `t→1`), keeping the "hard-corner" linear noise off (`jitter≈0`) so it reads as a vine, not lightning. Muted brown/green palette; drop `flashOf`/quantized flicker (doesn't suit an organic move); optionally borrow `fx-crystals.js`'s chip-pop-on-breach idea (fx-crystals.js:328) for small debris where the tendril first grips.
New code: substantial — `boltPoint`'s axis term must become a helix function, and the tendril needs to persist coiled around the target's model rather than clip/fade at a point, which the geometry (`t` from 0..1 tip clip) doesn't naturally support for a "wraps and stays" hold phase.
Risk: highest visual risk — no depth-aware wrap-around-mesh occlusion, so the tendril may clip through the target's body since it only knows the target's body-center point (`t/targetY`), not its silhouette.

**7. True forking Thunder** — *Effort L, lowest confidence.*
Recipe: borrow `fx-fissure.js`'s branch-growth algorithm (`growBranches`/`walkCrack`, fissure.js:161-196) to generate real forking polylines in 3D (not ground-locked), then re-target bolt's ribbon material to sample per-vertex from a baked polyline (`aDist`/`aSide`-style attributes, as fissure does) instead of the pure procedural `axis = mix(origin,target,t)`.
New code: most of the module's elegance ("positionNode does everything, nothing is CPU geometry") is lost — this needs a CPU-built branching geometry like fissure's `buildRibbonGeometry`, plus adapting `kink`/`profileOf`/`opacityNode` to work off baked-in attributes.
Risk: biggest deviation from the module's documented design principle (deliberately no CPU geometry beyond the ladder strip); doubles the amount of code to maintain in parallel with `fx-fissure.js`'s branch code; WGSL attribute-count/perf risk from combining fissure-scale branch counts with bolt's dual-pass (halo+core) draw.

## Observations

- **Shape params are baked at factory construction, not per-cast.** `buildRig` (293-311) reads `O.*` (the `options` passed once to `createBoltFx`) to build every uniform except color, seed, width and spread scaling (which `cast()` does touch, lines 395-401). So two moves that need genuinely different `jitter`/`twist`/`sag`/`restrike` (e.g., Thunderbolt vs. a slack Wrap) cannot share one factory instance — each needs its own `createBoltFx(deps, {...})` call, doubling geometry/material/pool overhead. This is workable (the module is fully deps-injected) but is a real constraint any recomposition plan should budget for up front.
- **CPU/GPU axis twins must be kept in sync by hand.** `axisPoint`/`bundleRadius` (404-411) duplicate only the *axis* term of `boltPoint`, not the kink/twist. Any recomposition that changes the GPU axis (sky-strike, helix, branches) needs a matching CPU update or sparks/light will visibly drift off the ribbon — this repo's own "CPU/GPU math twins" caution (noted at the top-level CLAUDE.md) applies locally here too, informally.
- **No multi-target or no-damage move types.** The harness (`pokemon-moves.html:167-193, 259-265`) assumes one attacker, one target, always-damaging, single `onImpact`. Discharge (multi-target) and Thunder Wave (status/no-damage) both need this widened — not a fx-bolt.js problem, but every ambitious recomposition here runs into it.
- **`boltPoint`'s pinch/converge is an underused, genuinely reusable primitive** for anything wanting both ends pinned (tethers, cages, dome spokes) — worth calling out explicitly since it's the cleanest lever for #4 and #5.
- **Light pool is shared and small (6, in `pokemon-moves.html:138-143`).** Any multi-instance recomposition (#2, #5) should expect graceful degradation (unlit spokes), not a hard failure, since `lights.acquire()` returns `null` when exhausted and `driveLight`/rig code already null-guards.
- **Geometry cache is keyed by strand count only** (`geoCache`, 106-108), so power-driven strand-count changes are cheap and share geometry across palettes — a real efficiency in favor of any recomposition that just varies `power`/strand density rather than axis shape.

---

# fx-bolt — B

## Parts inventory

- **`boltGeometry(strands)`** (106-133) — cached `InstancedBufferGeometry`: a parameter-space ladder strip (`position.x = t`, `.y = ±1 side`), one instance per filament via `aStrand`. Params: `O.nodes` (steps along), `strands` (instance count, capped by `O.maxStrands`). Free-standing — any ribbon-in-parameter-space effect can reuse this exact geometry builder.
- **`hash11` / `vnoise`** (156-167) — cheap hash and *linear* (hard-cornered) value noise TSL helpers. Fully free-standing; no dependency on bolt-specific state. Reusable anywhere a jagged, non-smoothstepped wobble is wanted.
- **`kink(t, seed)`** (174-188) — 5-octave layered `vnoise` displacement in a 2D plane, scrolling via `uCrawl`. Exposes `uJitterScale`, `uSpan`, `uCrawl`, `uOctaves`, `uJitterFalloff`. Depends only on `hash11`/`vnoise` — reusable for any "jittery offset from a spine" shape (roots, cracks, tentacles), not just lightning.
- **`boltPoint(t, seed, radial)`** (190-201) — the shape function: axis `mix(uOrigin, uTarget, t)` + sag, pinch/converge end-clamping, `kink()` offset, twist/spread fan. This is the single lever that defines what the ribbon traces — swap the axis term (e.g. to a ring) and everything downstream (ribbon, materials, sparks) still works. Tightly coupled to `kink`; loosely coupled to everything after it.
- **Camera-facing ribbon extrusion** (`material.positionNode`, 217-241) — turns a centreline point into a quad by finite-difference tangent × `cross(tangent, toCamera)` binormal, offset by `halfWidth`. Technique is free-standing (works on any parametric curve function); as written it's wired to `boltPoint`.
- **Width profile stack** (`halfWidth`, 235-238) — composes `uWidth`, tip taper (`uWidthTip`/`uWidthCurve`), core-vs-glow ratio (`uCoreWidth`), flicker (`flashOf`), and `uFade`. Free-standing composition pattern for any tapered ribbon.
- **Cross-ribbon falloff `profileOf()`** (245-248) — `pow(1-|v|, sharpness)`. Generic ribbon-glow shaping, no bolt-specific coupling.
- **Progress clip `drawnOf()`** (249-252) — smoothstep clip of the undrawn tip against `uProgress`, so the shape never rescales as it travels. Same idea as stream's `uProgress`/`uTail` clip; fully portable to any t-parametrized geometry.
- **Three-stop color ramp + front glow** (`colorNode`, 254-263) — halo→outer→inner→core gradient plus a `uProgress`-driven leading-edge glow. Coupled to `profileOf()`/`uProgress` but the ramp shape itself is generic.
- **Quantized flicker** (`opacityNode` flicker term, 265-271; `flashOf`, 207; `strandSeed`, 205) — `hash(floor(time·rate))` stepped brightness, driving both per-strand flash and the "restrike": the whole bolt re-seeds on a `floor(time·uRestrike)` cadence while `kink`'s `uCrawl` slides continuously between restrikes. This restrike/crawl pairing is Bolt's signature identity move, distinct from Stream's continuous scroll — free-standing as a "stutter vs. flow" technique.
- **Two-pass halo+core draw** (315-321) — one geometry, two materials (`isGlow` toggles `widthScale`/`glowFalloff`/`glowOpacity`). Free-standing "additive glow behind a hot core" doubling pattern, applicable to any ribbon shader.
- **Muzzle/impact flash spheres** (`additiveMaterial`, 276-285; `popFlash`, 472-481; `flashGeo`, 135) — pooled `Icosahedron`, scale/opacity driven by an age timer. Completely free-standing — reusable for any impact regardless of ribbon shape.
- **Flickering traveling light** (`driveLight`/`lightShimmer`, 483-502; `axisPoint`, 402-411) — moves a pooled `PointLight` along a CPU mirror of the axis (mix+sag, **no kink**) with a quantized shimmer. Free-standing rig for "a light that rides a moving/sagged line."
- **CPU spark emitter** (`sparkGeometry`, 137-147; `emitSparks`/`updateSparks`, 413-469; `bundleRadius`, 411) — ring-buffer gravity/drag particles as crossed quads, placed via `axisPoint`+`bundleRadius`. Free-standing gravity-particle system, decoupled from the GPU ribbon except for placement.
- **Rig pooling by palette** (`buildRig`/`takeRig`/`giveRig`, 291-355) — structural, shared pattern across all fx modules; `cast()` fully re-seeds every uniform so no cross-cast leakage.
- **Palette table** (47-64) — `core/inner/outer/halo/spark/light/muzzle/impact`. Cheapest extension point: a new look is just a new palette entry, zero shader work.

**Coupling summary**: `boltGeometry` + `boltPoint` + `kink` + the camera-facing positionNode are one shape-defining unit (swap the axis term inside `boltPoint`, keep the rest). `strandSeed`/restrike and `kink`'s `uCrawl` are mutually coupled (restrike reseeds, crawl slides between). Flash spheres, the traveling light, and the spark emitter are all independent of the ribbon and of each other — they only share placement helpers (`axisPoint`).

## Recompositions

**1. Zap Cannon (charge-up variant)**
Recipe: unchanged bolt ribbon/materials/sparks; expose the currently-hardcoded `easeIn: 0.01` (line 527) as an option and set it to ~0.6-1.0s so the strike front barely advances while `onSpawn`'s spark burst (532) and `driveLight` boost (533/544) ramp up at the origin — reads as a charging orb before the ribbon whips out. New code: one line (make `easeIn` a DEFAULTS field, thread through `O.easeIn`).
Effort: S — one options plumbing change, zero new shaders.
Risk: very low; worst case is retuning `sparkRate`/`lightIntensity` numbers once seen in-browser.

**2. Wild Charge (self body-aura + release tackle)**
Recipe: cast a normal Bolt `line` whose `to` is a synthetic point directly above `from` (vertical mini-segment via `makeLine`) so `boltPoint`'s axis becomes a short vertical spine on the attacker instead of attacker→target; crank `uRestrike`/`uRestrike`-crawl and strand count for a chaotic full-body arc during a hold phase, then on a timer fire a second, ordinary bolt cast (existing behavior, unmodified) from attacker to target as the "tackle" strike. Everything is stock bolt geometry/materials — only the orchestration (two sequential `cast()` calls with different endpoints) is new.
Effort: M — no shader changes, but needs a small wrapper in the calling module (or a thin new `fx-wildcharge.js`) to sequence the two casts and reposition the aura's endpoints to the attacker's current position each frame (attacker may be walking).
Risk: the aura's vertical line is very short, so `uSpan`/`uJitterScale` (kink frequency is `per-metre × uSpan`, line 177) need re-tuning or the kinks will look too dense/sparse; also two simultaneous lights/rigs draw against the shared 6-light pool.

**3. Discharge (self, radiating multi-bolt burst)**
Recipe: reuse `fx-bolt.js`'s `cast()` unmodified, called N times (N small, 3-5) with `line`s built from the attacker's origin to points scattered on a circle — borrowing **`fx-aurora.js`'s `buildRing`** (lines 84-95) purely as a "sample points around the caster" utility (not its curtain shader) to pick the burst directions. Each mini-bolt is short, high-restrike, low-strand-count.
Effort: M — no shader/geometry changes, but adds a small allocator that manages N rig lifetimes together and staggers their `onSpawn` slightly so they don't all restrike in lockstep.
Risk: **structural limit** — every strand in one bolt rig shares a single `uOrigin`/`uTarget` uniform (line 296-297), so a true single-draw-call starburst isn't possible; this recomposition is N separate draw calls/rigs, which multiplies light-pool pressure (each rig wants its own `PointLight`, but the demo pool is only 6 total, shared with every other live effect — see `demos/pokemon-moves.html` lines 138-147). Must budget lights explicitly (e.g. only the "hit" bolt acquires a light, the rest go dark) or it will starve other effects during auto-battle.

**4. Thunder Fang (bolt strike that cracks the ground)**
Recipe: unchanged bolt travel/impact; on `instance.onImpact` (already an exposed hook, line 545/559), trigger a **`fx-fissure.js`** cast (borrow module: `fissure` part = its impact-burst crack generator, `growBurst`/ribbon, lines 198-210 and 217-253) with a near-zero-length line at the impact point and a fast `travelSpeed` so it "insta-opens" — giving lightning-strikes-ground scorch cracks instead of (or alongside) bolt's own muzzle/impact flash spheres.
Effort: M — pure composition of two already-independent modules through the existing `onImpact` hook; no new shader code, just cross-module wiring in a new `fx-thunderfang.js` that owns both `createBoltFx` and `createFissureFx` instances.
Risk: two independently-tuned phase machines need their timing hand-matched (fissure's own `travelTime` must resolve near-instantly, its `impactTime`/`fadeTime` chosen so the crack outlives the bolt's flash); also doubles the light-pool draw (bolt's traveling light + fissure's ember lights, `O.lightCount`, line 73) in one move.

**5. Chain Lightning / "Parabolic Charge" bounce**
Recipe: two `boltPoint` shape instances back to back — cast a normal Bolt attacker→target, then on `onImpact` cast a second Bolt target→(a second nearby entity or a random point), each using unchanged geometry/materials/restrike but a different `uSeed` so the elbow doesn't look identical. New code: only the sequencing/target-selection logic (which the harness doesn't currently support — it always passes exactly one attacker/target pair).
Effort: M/L — the two-hop targeting logic is genuinely new (the current contract's `cast({line,...})` is single-segment only), plus a visible seam to sell at the joint.
Risk: no natural "elbow blend" exists in `boltPoint` (each segment is independently sagged/kinked), so the joint may read as two disconnected bolts rather than one chain unless the second segment's `uOrigin` snaps exactly to the first's `uTarget` and `originForward` (line 373, currently hardcoded to push off "the mouth") is disabled for the second hop.

**6. Thunder Wave (persistent paralysis tether)**
Recipe: stock ribbon/materials with `uConverge = 1` (both ends pinned, line 195) and `uProgress` held at 1 immediately (skip TRAVEL, or set `travelTime` ~0) so it reads as a standing arc between attacker and target rather than a thrown bolt, then simply hold through a long `impactTime`.
Effort: S — pure options tuning (`converge`, `travelTime`≈0, long `holdTime`), no new code.
Risk: **contract gap** — `createPhaseMachine` always auto-advances IMPACT→FADE→DONE on fixed timers (`move-core.js` 123-134); there's no "hold until told" phase, so a genuinely persistent (paralysis-duration) tether can't be expressed without either a very long hard-coded `holdTime` or a change to `move-core.js` itself, which is out of scope for a bolt-only recomposition.

## Observations

- **The one real lever is `boltPoint`'s axis term.** `mix(uOrigin, uTarget, t).add(sag)` (line 191) is the only place that "knows" the shape is a straight line. Everything downstream — geometry, ribbon extrusion, width/color/opacity, sparks, flashes — is shape-agnostic. Any recomposition that keeps a single point-to-point (or point-to-static-point) axis is nearly free; anything that wants a genuinely different topology (a ring, a branching tree, multiple simultaneous targets) runs into the fact that **one rig has exactly one `uOrigin`/`uTarget` pair shared by every strand** (296-297) — a true single-draw-call starburst or branch would need per-strand endpoint attributes that don't exist today.
- **`easeIn` is hardcoded** to `0.01` in `cast()` (line 527), not in `DEFAULTS`. Any "charge-up" idea (Zap Cannon, Wild Charge) needs this promoted to an option — a two-line change, but worth flagging since it's currently invisible to `options` overrides.
- **The CPU spark/flash placement (`axisPoint`, 402-411) deliberately omits `kink`** — it only mirrors `mix+sag`, not the noise displacement, "so CPU sparks sit on the bolt the GPU draws" per the header comment, but this is only true when jitter is small. Recompositions that crank `uJitter`/`uJitterScale` for a wilder look (Wild Charge's aura, Discharge's short bursts) will visibly detach sparks/lights from the rendered ribbon — a real risk, not hypothetical, given several proposals above increase jitter.
- **Light-pool contention is the dominant risk across every multi-cast idea** (Discharge, Wild Charge, Thunder Fang). The demo hands out only 6 shared `PointLight`s total (`demos/pokemon-moves.html` 138-147) across *all* concurrently-live effects, and Bolt already acquires one per cast (line 484). Any recomposition that fires more than one Bolt rig at once, or pairs Bolt with another module's lights, needs an explicit budget (e.g. only one rig in the group ever acquires a light) or it will silently starve unrelated effects during auto-battle.
- **Palette extension is free** (47-64): a new look needs only a new palette entry, no code — the cheapest possible "new move" and the honest baseline every proposal above should be compared against for effort.
- Per the subsystem doc's Open Threads, **nothing in this module has been seen rendered yet** — every number in the recompositions above (jitter scale on a short vertical line, restrike rate for an aura, timing offsets for chained bolts) is a guess that will need retuning once WGSL actually compiles and runs.

---

# fx-stream — A

## Parts inventory

All references are to `moves/fx-stream.js`.

| Part | What it does | Lines | Params/uniforms exposed |
|---|---|---|---|
| **PALETTES table** | Per-look tunables: colors, cone shape, noise, puff physics, burst, decal, light | 40–89 | ~40 fields per palette (`radiusNear/Far/Curve`, `noiseScale`, `flow`, `wander`, `sag`, `streak*`, `sparkle`, `puff*`, `burst*`, `light*`) — fully overridable via `options.palettes` (156) |
| **DEFAULTS** | Factory-level (not per-palette) shape/perf knobs | 91–94 | `travelSpeed/impactTime/fadeTime`, `tubeSegments/tubeRings`, `puffCap`, `burstTime`, `decalRadius`, `widthScale`, `poolPerPalette` |
| **paramsFor()** | Merges palette base with per-cast override | 154–158 | free-standing helper |
| **Gram-Schmidt axis frame** | Builds `dir/n1/n2` from `u.start`/`u.end` | 172–178 | `u.start`, `u.end` uniforms |
| **Param-space grid + noise cone** | `(t, ang)` unit grid → `wob/dA/dB` scrolling noise, catenary `sag`, cone `radius` | 179–196 | `P.flow/noiseScale/bands/wobble/sag/wander`, `u.seed`, `u.width` |
| **Varyings (vT/vAng/vFacing)** | Feed fragment stage from the same t/ang/normal | 198–200 | none new |
| **Shading: facing/streak/spark/mouth/heat** | axis-vs-rim falloff, scrolling filament streaks, sparkle, mouth glow, 3-color heat ramp | 202–219 | `P.coreSharp/edgePower/streak*/sparkle/mouthGlow/mouthLen`, `u.cCore/cMid/cEdge` |
| **Front/tail double-clip (`drawn`)** | Travel front and shutoff tail both clip the shape, never scale it | 221–227 | `u.progress`, `u.tail`, `P.tipSoft` |
| **Tube mesh assembly** | Unit `PlaneGeometry`, `MeshBasicNodeMaterial`, additive/normal blend switch | 229–238 | `P.additive`, `P.opacity` |
| **Puff instanced geometry** | Instanced quad + `aPos/aLife/aSize/aSeed` buffers | 242–261 | `O.puffCap` |
| **Puff shading** | grow-then-shrink disc, `SpriteNodeMaterial` billboard, life-based color/opacity | 262–278 | `P.puffAspect`, `u.cPuffA/cPuffB` — **free-standing**, no dependency on the tube |
| **emitPuff / stepPuffs** | CPU emitter+integrator: pos/vel/life/rate/size/seed, swap-remove pooling | 97–139 | `P.puffGravity/puffDrag`, called via `kit`/`P` — **free-standing**, generic particle kit |
| **Impact burst dome** | Noise-displaced additive sphere, rim-lit | 282–293 | `P.burstScale/burstFlatten/burstNoise`, `u.burst` |
| **Ground decal** | `CircleGeometry` with radial falloff + mottle noise | 295–304 | `P.decal/decalOpacity`, `u.decal` — **free-standing** |
| **Kit pooling** | `acquireKit/releaseKit/destroyKit`, keyed per palette | 319–342 | `O.poolPerPalette` |
| **frontAt() CPU mirror** | Re-derives nozzle position (incl. sag) on CPU for lights/puff spawn, mirroring the vertex shader | 378–384 | tightly coupled to `sx/sy/sz/ex/ey/ez/P.sag` |
| **spray()** | Rate-driven puff emission along the nozzle | 386–395 | `P.puffRate`, `P.puffSpeed/Spread` |
| **Phase-machine hooks** | onTravel (progress+spray+light), onImpact (radial burst puffs), onFade (mouth-still-open vs tail-retract split at t≤1 / t>1) | 397–441 | `O.travelSpeed/impactTime/fadeTime`, `O.burstTime` |
| **Pooled point light + flicker** | acquire/release from `lights`, sine flicker gated by progress | 372–373, 402, 432, 438 | `P.light/lightIntensity/lightDistance/flicker` |

**Tightly coupled:** axis frame → noise cone → varyings → shading (one continuous expression tree sharing `u`); front/tail clip is baked into both the position math's `drawn` term and the alpha, so it can't be swapped independently of the tube.
**Free-standing:** puff emitter/stepper, decal, burst dome, kit pooling, light-flicker driver — each takes plain scalars/positions and has no reference to the tube's node graph.

## Recompositions

Ordered most → least confident.

**1. Icy Wind / Powder Snow** (ice)
Recipe: skip the tube mesh entirely (don't add `tube` to `group`, or drive `u.fade`≈0 permanently); drive only the **puff layer** (242–280) with `emitPuff`/`stepPuffs` (97–139) as a single cone-shaped burst at `onSpawn`/short `onTravel`, using existing `P.puffSpread/puffSpeed/puffGravity`. Decal (295–304) optional, faint.
Effort: **S** — every part used already exists unmodified; only the cast()/machine wiring changes to skip tube draws.
Risk: low. Watch that `frustumCulled=false` tube mesh isn't silently still rendered if only hidden via opacity (should actually `visible=false` to save the draw call).

**2. Toxic** (poison, stacking puddle)
Recipe: new palette (thick viscous colors, `additive:false`, high `decalOpacity`, low `puffGravity`, long `puffLife`); small new code so the decal doesn't fully clear in FADE (change `u.decal.value = P.decalOpacity*(1-k)` at 437 to floor at a `P.decalResidue`, or expose a "persistent" flag).
Effort: **S/M** — mostly palette-only (near-zero-code path the doc already supports), plus one small edit to the fade formula.
Risk: leaving a permanently-visible decal group means `dispose()` (338–342) must still be called or it leaks a mesh in `scene` forever — needs the demo's `onDone` to detach the decal separately from the rest, which the current single-`group` teardown (306–307) doesn't support cleanly.

**3. Will-O-Wisp** (fire, lobbed ember)
Recipe: reuse the column exactly, but flip `P.sag` sign/magnitude for a visible parabolic arc (190, 380–381 already both read the same `P.sag`, so CPU and GPU stay in sync for free); make `radiusNear≈radiusFar` tiny (thin wisp) with a bright core at the tip via `mouthGlow`/`tipSoft` reused backwards (glow at the *front* instead of mouth — needs swapping which end `mouth`/`tipSoft` favor, small shader edit at 214/222–223); borrow **fx-bolt's** muzzle/impact flash sphere pattern (`additiveMaterial` + `popFlash`, fx-bolt.js 276–285, 471–481) for a floating ember cap instead of stream's burst dome.
Effort: **M** — sag reuse is free, but the "glow leads instead of trails" tweak touches the core position/opacity expressions, and importing bolt's flash-sphere helper means duplicating ~15 lines rather than a clean import (modules don't export internals).
Risk: TSL — changing which end `mouth`/`drawn` favors is easy to get backwards and silently invert (renders full-opacity in FADE instead of TRAVEL); verify only in-browser per the doc's open thread.

**4. Fire Spin / Sand Tomb** (trapping vortex)
Recipe: reuse the whole tube pipeline but replace the straight `centre = mix(u.start, u.end, t)` (191) with a helix: keep `t` progression but drive the existing `n1.mul(dA).add(n2.mul(dB)).mul(ends.mul(P.wander))` offset term (192) with a deterministic `sin(t*coilFreq+time*spin)` instead of noise, i.e. repurpose the *wander* term's slot rather than adding a new one. Puffs (240–280), decal (295–304), light (372–373) unchanged. `line.target` becomes the vortex center instead of an endpoint (attacker orbits it, so `u.start`/`u.end` both sit near the target at different heights).
Effort: **M** — the injection point exists (the wander term is already additive and separable from radius/streak), but it's one expression inside a large `Fn`-free node tree, not a pluggable callback, so editing risks touching neighboring terms.
Risk: `frontAt()` (378–384) must be updated to mirror the same helix on CPU or puffs/light will spawn off the visible tube — this is the same "CPU mirrors vertex shader" trap the module's own docblock warns about (line 404 comment).

**5. Acid Spray** (poison, corrosive splatter)
Recipe: tube+puffs unchanged; swap the **impact layer** from stream's noise-displaced burst dome (282–293) for **fx-crystals'** chip debris system (`chipGeo`/`emitChips`/`updateChips`, fx-crystals.js 133, 249–277, 279–300) — hexagonal/tetrahedron shard pop-and-bounce instead of a dome, reading acid palette colors instead of crystal chip colors.
Effort: **M/L** — the chip system is self-contained (own Float32Arrays + InstancedMesh) so it drops in structurally, but it must be woven into stream's `kit`/pool lifecycle (309–317, 319–342) and its own `dispose()` path, doubling the geometry/material bookkeeping for a single effect.
Risk: cross-module borrow means copying rather than importing (no shared export surface between fx-*.js files per the contract, doc line 48); kit pooling assumes a fixed mesh set per palette (310) — adding a variable-size chip InstancedMesh into that pool needs care that `poolPerPalette` reuse doesn't get materials-mismatched.

**6. Whirlpool** (water, ring trap around target)
Recipe: borrow **fx-aurora's** seamless closed-ring builder (`buildRing`, aurora.js 84–95, and its integer-harmonic seam trick, lines 38–42/110–114) centered on `line.target` instead of `line.origin`; sweep stream's cone-radius formula (193–196) and noise scroll (182–188) around the ring instead of along a line, so the "hose" becomes a vertical funnel wall; keep stream's puffs (droplets thrown outward) and decal (wet ring on the ground) unchanged.
Effort: **L** — genuinely new geometry (a ring-swept version of the t/ang grid, 229) is needed; this isn't parameter reuse, it's a new `buildCurtainGeometry`-style function combining two modules' math.
Risk: highest WebGPU risk in this set — new geometry + reused noise-cone shading is untested territory, and per the doc's own open thread nothing here has been seen rendered yet, so a geometry-level change is the least safe to ship without a browser check.

**7. Discharge** (electric, radial self-burst)
Recipe: borrow **fx-bolt's** multi-strand instancing pattern (`InstancedBufferGeometry` + `aStrand`, fx-bolt.js 107–133) to fire N short copies of stream's tube (172–238) radially outward from the attacker instead of one tube point-to-point; each "spoke" reuses the cone/noise/streak shading verbatim with a per-instance rotation instead of a per-cast `u.start/u.end`.
Effort: **L** — requires promoting the tube's `u.start`/`u.end`/`u.seed` uniforms into per-instance attributes (currently they're single uniforms shared by the whole mesh, 162–170), which is a structural rewrite of the positionNode, not an option toggle.
Risk: highest structural risk — the tube's node graph was written assuming one shared axis; making it per-instance touches nearly every line in the column section (172–238) and could break the frontAt()/CPU-mirror assumptions used by puffs and light entirely.

## Observations

- The axis/shape math (172–196) is one continuous expression tree keyed to `u.start`/`u.end`/`u.seed`/`u.width` — there's no seam to swap in an alternate path function (straight vs. arc vs. helix) without editing inline expressions. Extracting `centre`/`radius` into named, overridable sub-functions would make recompositions #4, #6, #7 much safer.
- `frontAt()` (378–384) hand-duplicates the vertex shader's axis+sag math on the CPU so puffs/light track the visible tube. Any recomposition that changes the GPU-side path (helix, arc, ring) must remember to update this CPU mirror too — it's an easy place for the two to silently diverge (the module's own docblock flags this exact trap for the reference codebase).
- The puff system (`emitPuff`/`stepPuffs`, 97–139) and the decal/burst layers are genuinely free-standing — no dependency on the tube's uniforms beyond position — and are the safest parts to reuse or drop for new effects (#1 above).
- Geometry resolution (`tubeSegments/tubeRings`, `puffCap`) lives in `DEFAULTS` (91–94), a factory-level option, not in `PALETTES`. `move-registry.js` only forwards `palette/power/travelSpeed/travelTime` to `cast()` (registry.js has no field for it, demo passes only those, pokemon-moves.html 178–182), so two moves sharing the `stream` fx key can't currently get different tube resolutions through the registry — only through separate `createStreamFx(deps, options)` factory instances, which the demo builds once per fx key (152–158), not per move.
- Kit pooling is keyed per palette name (330, `pools.get(kit.key)`), and `paramsFor` falls back to the base table plus any override (154–158), so **pure new-palette moves are near-zero-risk** — the pooling/lifecycle code needs no changes at all, only a `PALETTES` entry and a `MOVES` row. This makes options like Toxic (#2) safe even though they're listed at S/M effort mainly for the decal-persistence tweak, not the palette itself.
- Nothing in this module has been seen rendered (per the subsystem doc's open threads) — any recomposition touching the shared node-graph structure (#4, #6, #7) carries unverified-WGGPU-compile risk beyond what's stated per-recipe above.

---

# fx-stream — B

## Parts inventory

**PALETTES table** (lines 40–89). Four named looks (fire/water/dragon/ice), ~50 fields each: 7 colors, blend mode (`additive`/`opacity`), column shape (`radiusNear/Far/curve`, `sag`, `wobble`, `bands`, `noiseScale`, `flow`, `wander`), surface detail (`streak*`, `sparkle`, `rim`, `fill`, `coreSharp`, `edgePower`, `mouthGlow/Len`, `tipSoft`), puff physics (`puffRate/Size/Life/Aspect/Gravity/Drag/Spread/Speed/Spin`), burst (`burstPuffs/Scale/Flatten/Noise`), light (`light`, `lightIntensity/Distance`, `flicker`). Free-standing pure data; every field is overridable per-instance via `options.palettes`.

**Gram-Schmidt frame** (lines 173–177). `dir = normalize(end−start)`, `n1 = normalize(cross(dir, ref))`, `n2 = cross(dir, n1)`. Free-standing — any tube/ribbon-around-an-axis effect needs exactly this. Feeds the column shader and nothing else.

**Column positionNode — the hose** (lines 172–197, esp. 190–196). Unit `(t, angle)` `PlaneGeometry` grid placed via `mix(start,end,t)` + catenary `sag`, cone `radius(t)` modulated by `mx_noise_float` wobble, low-freq axis `wander` pinned at both ends (`ends = sin(t·π)`). Tightly coupled to the Gram-Schmidt frame and to `u.start/u.end/u.width/u.seed`.

**Column colorNode/opacityNode — heat + streaks + the double clip** (lines 198–227). `vFacing` (camera-facing dot) drives `axisward`/`rim`; downstream-scrolling `mx_noise_float` streaks and a hotter `sparkle` layer; `mouth` glow near the nozzle. `drawn = clip(uProgress) · clip(uTail)` — the front is a **clip, never a scale** (line 222–223), and shutting off mirrors it from the tail end. This clip-not-scale idiom is the single most reusable idea in the module — it's what lets a beam "hold" without stretching.

**Puff particle system** (lines 96–139 for CPU integration, 240–280 for GPU side). `InstancedBufferGeometry` quad + `SpriteNodeMaterial` with **instanced attributes, not `InstancedMesh`** (documented reason: `positionNode` on `InstancedMesh` discards `instanceMatrix` under WebGPU). CPU arrays (`pPos/pVel/pLife/pRate/pSize/pSeed`) with swap-remove death (111–139), `emitPuff` fire-into-slot (96–108). Free-standing — this is a complete, general-purpose camera-facing particle emitter usable by any effect, not stream-specific at all.

**Impact burst dome** (lines 282–293). Noise-displaced additive icosphere-ish sphere (`SphereGeometry`), rim shading, driven purely by `u.burst` uniform and non-uniform `kit.burst.scale`. Free-standing flash primitive.

**Ground decal** (lines 295–304). `CircleGeometry` disc, radial falloff × noise mottle, opacity from `u.decal`. Free-standing scorch/wet-mark primitive; always circular, always horizontal (`rotation.x = -π/2` at 303).

**Nozzle tracker / spray driver** (lines 378–395). `frontAt(u)` mirrors the vertex-shader axis math on the CPU (including sag) so puffs and the light sit exactly where the visible column is — anything that changes the column's axis shape (e.g. a curve or helix) must have this function kept in sync or puffs/light desync from the shape.

**Kit pooling** (lines 319–342, keyed by `key = palette name` at 344). Infrastructure only. Note: the pool key is the palette name, not a shape variant — a recomposition that needs a structurally different kit (different geometry/material graph) cannot just add a palette entry; it needs its own `buildKit`-equivalent function.

**Phase-machine wiring** (lines 397–441). `onTravel` feeds `u.progress` + sprays + flickers the light; `onImpact` fires the burst; `onFade` branches on `t<=1` (still-open hose feeding the splash) vs `t>1` (tail clip + fade) — this IMPACT-still-feeds-the-splash behavior is specific to "a hose held open," distinct from bolt/fissure's impact-then-cool pattern.

Coupling summary: frame → column position/color are tightly bound (can't reuse column shading without the frame). Puffs, burst, decal, and the light are all independently reusable and only loosely coupled through shared uniforms/palette values.

## Recompositions

**1. Sludge Bomb / Acid Spray** (poison)
Recipe: pure palette addition — `additive:false`, opaque `mid`/`edge` in sickly green-brown, `puffGravity` positive and large (dripping), `sag` high, `sparkle:0`, `light:0`. One new code touch: today the decal only fades opacity, never grows — add a `decal` scale ramp (mirror `burst.scale` pattern at 420–424) so the acid visibly spreads/eats the ground over FADE.
Effort: S — 95% palette values, ~5 lines of new code for decal growth.
Risk: low; normal-blend transparency sort order vs. burst dome (already solved by water).

**2. Sandstorm / Sand Tomb** (ground)
Recipe: palette only — flat tan colors, `radiusNear` big/`radiusFar` bigger (a hugging dust column not a taper), `wobble`/`noiseScale` high for grit, `streak` low, `additive:false`, `light:0`, puffs with `puffGravity≈0`, wide `puffSpread`. No new code.
Effort: S — palette-table-only recomposition, proves the kit's range without touching shaders.
Risk: minimal; risk is just "looks too similar to water" if not tuned distinctly (opacity/noise scale need real separation).

**3. Toxic / Night Shade — inverted beam** (poison/ghost)
Recipe: swap which color mixes with `axisward` vs `rim` in `tubeColor` (line 217–219) — dark core (`cEdge`), bright violet-green rim — so the beam reads as a void with a glowing skin rather than a hot core. Everything else (puffs, burst, decal, light) is palette reuse.
Effort: S/M — one small edit to the `mix()` chain guarded by a palette flag (e.g. `P.invertHeat`), rest is palette values.
Risk: `axisward`/`rim` falloff curves (`coreSharp`/`edgePower`) were tuned for hot-core reading; inverting may need re-tuning so the rim doesn't look washed out at grazing angles — a real WebGPU-only thing to eyeball since it can't be checked in Node.

**4. Discharge / Spark (electric hose)**
Recipe: stream's column (frame, clip, cone) with `wander`/`noiseScale` cranked and driven by a sharper, more strobing noise (borrow the *idea*, not code, of bolt's linear `vnoise` hard-corner noise — `fx-bolt.js` lines 163–167 — applied to the column's `wob`/wander instead of `mx_noise_float`, since linear noise reads as "electric" the way smooth noise reads as "gas"). Puffs recolored electric, `puffSpin` high; optionally acquire a second light for a strobe (palette-driven `flicker` already supports this).
Effort: M — needs a real new noise function (`vnoise`-style) wired into the column's `wob`/`dA`/`dB` terms in place of `mx_noise_float`, which means re-deriving `boltPoint`-style linear interpolation inside TSL for this module.
Risk: linear (hard-corner) noise inside a soft cone shape may look like an artifact rather than "electric" unless mixed carefully with the existing smooth `wob`; must be checked in-browser (WGSL-only failure mode); doubles noise-eval cost per vertex.

**5. Razor Leaf / Leaf Storm (spiral puff-primary stream)**
Recipe: keep the Gram-Schmidt frame and `frontAt()` nozzle tracker, but make the puffs the primary visual instead of the tube: emit them with angular offset around `(n1,n2)` at increasing radius as `t` advances (spiral), using `puffAspect`-elongated sprites with a leaf-shaped alpha mask replacing the `disc` falloff (line 263, `smoothstep(0.5,0.06,...)`) with an anisotropic falloff. Tube itself either near-invisible (`opacity` ~0.1, thin) or dropped (skip adding `tube` to the group, borrow fx-crystals' idea of "no shader, just instances" for cheapness).
Effort: M — new emission pattern in `spray()` (angular placement, not just along-axis jitter) and a new alpha-mask term in `puffMat.opacityNode`; no new geometry needed since it's still `SpriteNodeMaterial` quads.
Risk: dropping the tube changes the kit's silhouette enough that impact/burst/decal timing (tuned assuming a visible column leads them) may read as sparse; needs power/puffRate re-tuning; medium GPU cost from more puffs doing more visual work.

**6. Whirlpool (targeted water vortex)**
Recipe: reinterpret the cast line's `target` as a vortex center rather than a hose endpoint — the column's `axis` becomes a helix around a vertical axis at the target instead of `mix(start,end,t)`, borrowing fx-aurora's ring-building approach (`buildRing`, lines 84–95 of fx-aurora.js) for the base circle and stream's radial cone modulation for the funnel wall taper. Puffs orbit and fall inward; impact burst/decal reuse as-is.
Effort: L — the column's positionNode axis math is the module's core assumption (straight line, lines 190–196); replacing it with a helix means `frontAt()` (CPU mirror, 378–384) needs a matching rewrite too, and `u.progress`/`u.tail` clip semantics need reinterpretation for a closed loop instead of an open line.
Risk: biggest recomposition here — breaks the "travel along a line" contract expectation (like aurora's `self:true` did), noise/wander terms tuned for a straight axis may fight the helix, and CPU/GPU desync (frontAt vs shader) is the classic trap called out in the module's own docblock if not kept in lockstep.

**7. Confuse Ray (single-target ring stream, non-self)**
Recipe: keep column/puffs entirely, but drive `radius(t)` with a pulsing sine (concentric expanding rings traveling outward from a fixed point at the target) instead of a monotonic cone — needs a new radius function replacing lines 193–194's `mix(radiusNear,radiusFar,...)` with `radiusBase + sin(t·freq − time·speed)·amp`. Borrows nothing structurally from other modules; palette psychic-ish colors.
Effort: M — new radius function only, everything else (frame, puffs, burst, decal, pooling, phase wiring) reused verbatim.
Risk: pulsing radius combined with the existing `wobble` noise term may look muddy; the `drawn` clip (uProgress) was designed for a monotonic shape so a pulsing radius crossing zero could pinch the ribbon to nothing at trough frames — needs a min-radius floor.

**8. Dragon Rage — pooled dual-hose restrike** (weakest/most speculative)
Recipe: cast two `stream` kits per move (reuse `cast()` twice with offset seeds/short delay) so two intertwined hoses spiral around one shared axis, evoking a "rage" burst rather than one steady beam. No shader changes — pure orchestration at the harness/registry level (two `fx.stream.cast()` calls with a phase offset).
Effort: S for the trick itself, but it lives outside the module (in the move-registry/harness cast-once contract, which currently assumes one `cast()` → one instance) — effectively this is a harness feature, not really "recomposing fx-stream," which is why it's ranked last.
Risk: the contract (`docs/subsystems/pokemon-moves.md` lines 50–55) implies one `cast()` per move; doubling instances doubles light-pool pressure (only 6 pooled `PointLight`s total — line 138 of the demo) and doubles puff/particle budget, risking the pool starving other simultaneous effects.

## Observations

- **Pool key = palette name only** (line 344–345, `const key = PALETTES[palette] ? palette : 'fire'`). Any recomposition needing a structurally different kit (different puff shape, different burst geometry, helix axis) can't just add a palette row — it needs a new key namespace or a parallel `buildKit`-like path, since `buildKit` bakes geometry/material graph and palette-driven numbers together in one function. Recipes 5 and 6 above hit this directly.
- **Burst is always a sphere, decal is always a horizontal circle** (lines 283, 295, 303). Nothing in `P.*` parameterizes their shape, only their material response. A move wanting a directional splat (e.g. a cone-shaped burst, or a linear scorch) needs new geometry, not new palette values.
- **CPU/GPU duplication is a real trap, not hypothetical.** `frontAt()` (378–384) is a hand-written mirror of the vertex-shader axis math; the module's own docblock (fx-bolt.js line 34, and implicit in fx-stream's design) already flags this class of bug. Any recomposition that changes the column's axis shape (helix, rings, spiral) must edit both places or puffs/light will visibly float off the beam — undetectable in Node since Node never compiles WGSL (per the contract doc's "Open threads" section).
- **The clip-not-scale idiom (`uProgress`/`uTail`) is the module's best free-standing idea** and transfers cleanly to any new stream-shaped move; it's already palette-agnostic and needs zero new code to reuse.
- **`puffAspect` is underused as a cheap "new look" lever.** Elongating/rotating puffs (already exposed per-palette, line ~47) gets you leaf/spark/droplet-shaped reads without touching the disc alpha mask — cheaper than recipe 5's new alpha mask, worth trying first before adding shader code.
- **No contract gap found** — `cast()`'s signature and the `{group, machine, update, dispose, onImpact, onDone}` instance shape match `move-core.js`/the demo harness exactly; every recomposition above fits the existing `createXFx(deps, options)` factory shape without needing changes to `move-core.js` or the registry beyond a new `MOVES` row and possibly a `FX_PALETTES.stream` entry.

---

# fx-crystals — A

## Parts inventory

**Palette table `PALETTES`** (lines 36–58) — three named looks (`ice`, `stone`, `psychic`), each a bag of material knobs (`kind: 'physical'|'standard'`, base/attenuation/emissive colors, `transmission`, `ior`, `thickness`, `iridescence`, `dispersion`, chip colors, optional `light`). `kind` is the only structural switch; everything else is just numbers fed to `materialsFor`. Free-standing — swapping in a 4th palette needs no code change.

**`DEFAULTS`** (60–76) — every placement/timing/motion number as flat options: count/maxCount, travelSpeed/holdTime, shatterDelay/sinkTime, riseTime/riseStagger, height/heightNear/heightCurve, radius/width curves, peak/peakWidth/crown (the dome), frontBias/clumping/scatter/impactFraction (band shape), rubbleChance/rubbleScale, lean/leanJitter/twist, chip params, light params. All consumed by name inside `cast()`, so any subset can be overridden per move via `options`.

**`makeCrystalGeometry(THREE, rnd)`** (95–123) — hexagonal quartz-point builder: jittered facet columns, taper, off-axis apex, non-indexed for flat facets. Free-standing — takes only an RNG, knows nothing about the cast or the line. `sides = 6` and the shaft/taper/apex ranges are hardcoded local consts, not parameters, so it only ever produces one shape family (quartz-like). `VARIANTS = 3` (line 31) controls how many geometries are pre-baked at factory time (line 130–132), shared across every cast.

**`materialsFor(name, pal)`** (136–161) — builds/caches the crystal + chip node materials per palette name. Coupled to the `PALETTES` shape (`pal.kind`) but otherwise free-standing; a new palette just needs the same fields.

**Spike placement loop** (163–247, inside `cast`) — the "band that opens toward the target" algorithm: `along` position via `frontBias`-biased index, lateral offset via `clumping`+`scatter`, a separate sqrt-radial ring distribution for the impact cluster (`impactFraction`, lines 202–208), height via `heightCurve`+`peak` swell +`crown` doming, lean/twist orientation via quaternion (221–230), and the palette-tint-in-instance-color trick (238–245: material stays white, hue/sat/lightness jitter goes into `setColorAt`). This is the least reusable-as-is part: placement, record bookkeeping (`baseY`, `quat`, `variant`/`slot`), and instance-color tinting are all fused into one loop rather than a swappable placement strategy.

**Eruption/retract state machine** (`triggerUpTo`, `emergence`, `poseSpikes`, lines 302–336) — per-spike stagger + `Easing.outBack` rise from a buried offset, and a shared `retract` (`Easing.inCubic`) sink. Genuinely reusable as a motion primitive ("buried → punch up → stand → sink") independent of *why* a spike is where it is — but `emergence` keys off `r.along` compared against `this.u` (the line-front progress), so it implicitly assumes triggers propagate caster→target along the line. Coupled to that assumption, not to the placement math itself.

**Chip debris pool** (`emitChips`/`updateChips`, 249–300) — CPU-driven `InstancedMesh` of tetrahedra with gravity + ground bounce, round-robin reuse. Fully free-standing: takes `(x, y, z, n, speed)`, no knowledge of spikes or the line. The cleanest reusable part in the module.

**Light-follow-front** (338–351, 374–398) — one pooled `PointLight` positioned via `line.pointAt(u)` and driven by a flash curve keyed to `t` in `onFade`. Tightly coupled to "front travels along a line"; would need rework for a ring or self-centered cast (contrast with `fx-aurora.js`'s multi-light-around-a-ring approach).

**Phase-machine wiring** (`onTravel`/`onImpact`/`onFade`/`onDestroy`, 369–404) — orchestrates all of the above against `createPhaseMachine`. This is the connective tissue, not a reusable part per se, but shows the contract every recomposition must satisfy.

Notably, `fx-crystals.js` never destructures `TSL` from `deps` (line 126: only `THREE, NODES, scene, terrainHeight, lights`) — it is the one effect module with **no custom shader code**, only instance-matrix/instance-color animation on stock node materials.

## Recompositions

**1. Spikes** (ground/rock hazard, self-cast at attacker's own back line)
Recipe: 100% existing code, `impactFraction: 1` so the whole field spawns as the ring-around-target cluster (lines 202–208 already do this), `holdTime` long, `shatterDelay` long or the retract phase simply never reached within a typical fight. Just a `MOVES` row + option overrides.
Effort: **S** — zero new code, only `DEFAULTS` overrides and a registry row.
Risk: Low. Only risk is the impact-cluster math (`reach = halfWidth(1) * 1.25 * radial`) looking sparse at `impactFraction: 1` since it was tuned assuming ~22% of the field, not 100% — needs a quick visual check of density.

**2. Rock Tomb** (rock cage that rings the target)
Recipe: keep `makeCrystalGeometry`, `materialsFor`, `emergence`/`poseSpikes`/chip pool verbatim. Replace the placement loop (190–230) with a closed-ring generator around `line.target`, structurally borrowed from `fx-aurora.js`'s `buildRing()` (lines 84–95: sample points on a circle, normal up, side = radial outward) instead of the along/lat band math. Spikes lean inward (negate the outward lean term at 223–226) so it reads as a cage closing in. New code: the ring-sampling loop + inward lean, maybe 40 lines.
Effort: **M** — new placement function, but every other subsystem (geometry, eruption, chips, light) is untouched.
Risk: `triggerUpTo`'s `r.along > limit` gate (line 307) assumes trigger order runs 0→1 along the cast line; for a ring there's no natural "along," so triggers need a new key (e.g., angle-from-nearest-approach, or all-at-once on impact). Getting this wrong makes the cage pop in all at once instead of encircling — a real risk, not just cosmetic.

**3. Icicle Spear / Stone Spear** (single large crystal thrown as a projectile)
Recipe: reuse `makeCrystalGeometry` at spear proportions (stretch via matrix scale, not new geometry), reuse `materialsFor`, chip pool, and the light. Drop the instanced field entirely — one non-instanced `Mesh` whose matrix is driven every frame like `fx-bolt.js`'s `axisPoint(s, out)` (bolt lines 404–410) or `fx-stream.js`'s `frontAt(uu)` (stream lines 379–384): lerp position along the line with `machine.u`, add spin. On impact, reuse `emitChips` for a shatter burst and reuse the light's flash curve from `onFade`.
Effort: **M** — new per-frame transform code (borrowed pattern, not borrowed code, since bolt/stream's helpers are closed over their own module state) plus removing the InstancedMesh/records machinery for this path.
Risk: A single big crystal is a much smaller draw than a 60-spike field, so this cannibalizes most of the module's actual content (the placement algorithm) — the "genuinely new code" fraction is high relative to reused code, meaning less validation from the existing module. Embedding depth/rotation-on-impact needs care to avoid clipping through the target mesh.

**4. Iron Defense / Barrier** (self-buff, armor plates hugging the caster)
Recipe: depends on #2's ring-placement code existing, just centered on `line.origin` (the self-cast case already routes `to: from` at the call site in `demos/pokemon-moves.html` line 176) with a small radius and spikes leaning outward from the body instead of inward. Very long `holdTime`, minimal or no chips (armor shouldn't shed debris while worn).
Effort: **S/M** — cheap once #2's ring code exists, otherwise ties to its cost.
Risk: `terrainHeight` per-spike (used at line 233, `terrainHeight(x, z)`) is flat ground in this demo, but if the caster is mid-stride the ring will float/clip relative to the animated rig, since spikes are placed once at cast time (per the module's own docblock, line 21) — a self-buff that's meant to track the body would violate that "positions never move" design assumption. Likely needs an explicit non-goal note or a body-anchor exception.

**5. Diamond Storm** (crystal shards raining onto the target area)
Recipe: reuse geometry variants, materials, chip pool, and the outBack "settle" half of `emergence`. New code: replace "buried → erupt upward" with "falling → land," i.e., each shard's `y` interpolates from a random height above down to `baseY` (ease-in, not outBack) before the existing punch-through/chip-burst triggers on landing. Trigger timing needs to key off arrival time instead of `r.along`/`machine.u`, similar to the risk noted in #2.
Effort: **M/L** — a second motion mode (`fall` vs `erupt`) has to coexist with `poseSpikes`, and per-shard fall duration/stagger is new bookkeeping not present today.
Risk: WebGPU/TSL is not implicated (no shaders here), but a from-above trajectory needs its own light/impact-dust for each landing shard, which the current single pooled light (338) can't service — visually it may read as "boulders teleporting down" rather than falling unless a fall-streak or motion blur is added, and that's new visual work outside the module's current toolkit.

**6. Toxic Spikes** (crystal field that continuously seeps colored gas while standing)
Recipe: keep the field placement/eruption/chips as-is; add a continuous puff emitter at each standing spike's tip, structurally borrowed from `fx-stream.js`'s instanced-puff layer (`SpriteNodeMaterial` + `aPos/aLife/aSize/aSeed` attributes, `emitPuff`/`stepPuffs`, stream lines 240–279, 96–139) — but this module currently imports no TSL at all, so building a `SpriteNodeMaterial` with node-based `positionNode`/`opacityNode` is genuinely new plumbing here, not a copy-paste.
Effort: **L** — first time this module needs TSL, and a whole second particle system (puffs) alongside the existing chip system.
Risk: WGSL construction can't be verified in Node per the doc's own "Open threads" (only WGSL generation is unverified until browser-tested); combining two instanced systems (crystal field + puff field) risks draw-call/cost creep the doc's "Open threads" already flags for other modules (no soft-particle depth fade). Lowest confidence of the set.

**7. Psycho Cut — "erupt then launch"** (spikes rise then fly at the target as a barrage)
Recipe: combine #2's ring placement with #3's projectile-motion idea — spikes erupt in place (existing `poseSpikes`) then, once fully emerged, their matrices switch from the static per-record pose to a ballistic path toward `line.target`.
Effort: **L** — requires a per-record phase flag (erupted → launching) layered on top of the existing `eruptTime`/`breached` bookkeeping, essentially a third motion mode.
Risk: Highest of the set — mixing "instances that never move once placed" (the module's core simplifying assumption, docblock line 21) with "instances that fly across the arena" doubles the state each record carries and is the most likely to look wrong (pop, wrong facing during flight, chips lagging the wrong position). Listed last on confidence.

## Observations

- **Placement is fused, not pluggable.** The band/along-the-line placement math (163–247) is inlined directly in `cast()` alongside record bookkeeping and instance-color tinting. Every recomposition that changes *where* spikes go (ring, fall, projectile) means forking most of `cast()` rather than swapping a strategy function. Extracting a `placeSpike(i) -> {x,z,baseY,height,radius,quat,triggerKey}` function would make #2, #4, #5 all cheaper and less error-prone.
- **Trigger timing is hardcoded to line-progress.** `emergence`/`triggerUpTo` compare `r.along` against `this.u` (the phase machine's line-front fraction). Any placement that isn't "band toward the target" (ring, self-centered, falling) needs a different trigger key, and today there's no seam for that — it's the single biggest structural gap for reuse.
- **Geometry shape is not parameterized.** `makeCrystalGeometry`'s `sides = 6`, taper range, and apex jitter are local consts (97–100), not options. A spear (#3) or boulder (different shard family) needs either a second geometry function or exposing those as parameters — the module's `VARIANTS` constant (3) already assumes one shape family with facet-count variety, not shape-family variety.
- **The light-follow pattern assumes a line.** `light.position` is driven by `line.pointAt(u)` throughout (343, 375, 382, 396). A ring or self-buff cast has no meaningful "front," so any recomposition without a directional cast needs its own light-driving code — `fx-aurora.js`'s multi-light-around-a-ring pattern (lights spaced by ring angle) is the natural donor here, not anything already in this module.
- **Chip pool and geometry/material caching are the strongest reusable parts** — both are already generic (`emitChips(x,y,z,n,speed)`, `materialsFor(name, pal)`) and need no changes for any of the seven proposals.
- **No TSL today.** This is the only effect module with zero custom shader nodes — every visual is instance transform + instance color on stock node materials. That's an asset (cheap, well-understood, Node-testable) for proposals 1–5, but a real cost for proposal 6, which is the first to need genuine TSL authorship in this file.

---

# fx-crystals — B

## Parts inventory

All line numbers refer to `moves/fx-crystals.js`.

| Part | Lines | What it does | Params/uniforms | Coupling |
|---|---|---|---|---|
| `makeCrystalGeometry(THREE, rnd)` | 95–123 | Non-indexed hexagonal quartz-point mesh: jittered facet columns, taper, off-axis apex, base at y=0, height 1. | `sides=6` hard-coded; baseR/shaftH/taper/apex ranges hard-coded inside, only seedable via `rnd`. Not exposed through `DEFAULTS`. | Free-standing — pure geometry factory, no dependency on placement/timing. |
| `VARIANTS=3` geometry pool | 31, 130–132 | Three geometry variants built once per factory (fixed seed `0xc0ffee`), round-robined across spikes for facet diversity. | none exposed | Free-standing, but shared across *all* palettes/casts from one factory instance — geometry shape is not palette-specific. |
| `PALETTES` (ice/stone/psychic) + `materialsFor` | 36–58, 136–161 | Builds `{crystal, chip}` node materials per palette: `physical` (transmissive/iridescent glass) or `standard` (flat opaque/emissive). Cached by palette name. | `kind, base, attenuation, emissive, emissiveIntensity, hueJitter, satMul, transmission, roughness, ior, thickness, iridescence, dispersion, chip, chipEmissive, light{color,mul}` | Decoupled — only needs a palette object; independent of placement/geometry. |
| Instance-color tint | 238–245 | Jitters palette base color into per-instance `instanceColor` (HSL hue/sat/lightness noise) instead of tinting the shared material, avoiding double-multiplication. | `hueJitter, satMul` | Coupled to the placement loop (runs inside record generation) but conceptually portable to any InstancedMesh. |
| Band placement / record generation | 163 (`cast` sig)–246 | Computes each spike's `(x,z)` via `line.pointAt(along)` + lateral offset, `along` biased forward (`frontBias`), impact-fraction spikes clustered on a sqrt-radius disc at the target, height curve+crown dome+peak swell, lean/twist quaternion (223–230). | `count/maxCount, width, widthNear, widthCurve, height, heightNear, heightCurve, radius, radiusJitter, heightJitter, frontBias, clumping, scatter, impactFraction, rubbleChance, rubbleScale, peak, peakWidth, crown, lean, leanJitter, twist` | Tightly coupled to the `records[]` schema (`along, impact, x, z, baseY, height, radius, quat, stagger, eruptTime, breached, variant, slot`) that eruption/render consume next — but the *coordinate generator* itself is swappable if you keep that schema. |
| Eruption timing: `triggerUpTo` / `emergence` / `poseSpikes` | 302–336 | Schedules per-spike `eruptTime` staggered off the phase-machine front; `outBack` growth curve; `inCubic` sink/retract; composes instance matrices only (no shader). | `riseTime, riseStagger, shatterDelay, sinkTime` | Tightly coupled to the `records[]` schema, but decoupled from *how* `(x,z,height,radius,quat)` were derived — this is the real reusable engine ("things erupt from/sink into ground on a timer"). |
| Chip debris pool | 133, 249–300 | CPU-integrated tetrahedron instances: position/velocity/gravity/bounce/spin arrays, round-robin reuse, `emitChips(x,y,z,n,speed)` / `updateChips(dt)`. | `chips, chipsPerSpike, maxChips, chipSize, chipSpeed, chipGravity, chipLife` | Fully free-standing — only needs an emit point, count, and speed. Reusable by any effect wanting ground debris. |
| Light rig | 338–351, plus updates in the phase machine (374–398) | Acquires one pooled `PointLight`, follows `line.pointAt(u)` during travel, flash curve on impact/fade, released on destroy. | `lightIntensity, lightDistance, lightHeight`, `pal.light.color/mul` | Free-standing, generic "one light follows the front" pattern already used near-identically in bolt/fissure. |
| Phase-machine wiring | 369–404 | `onTravel` triggers spikes up to `u`; `onImpact` triggers remainder + impact cluster + big chip burst; `onFade` splits `shatterDelay` (hold) then `sinkTime` (retract) out of the single `fadeTime` window. | `travelSpeed, holdTime, shatterDelay, sinkTime` | Glue code — depends on all the above being present but is otherwise the thinnest, most reusable layer (just calls into the other parts). |

**Key structural note**: everything except geometry/materials is defined as closures inside `cast()` — nothing is exported at module scope. Recomposing means copy-adapting code into a new `fx-<name>.js`, not importing helpers directly (same is true of `fx-bolt.js`, `fx-stream.js`, `fx-fissure.js`; only `PALETTES`/`DEFAULTS`-shaped data is importable).

## Recompositions

**1. Stealth Rock** (ground, self-ish hazard)
- Recipe: crystals' full pipeline unchanged — band placement (188–246), eruption (302–336), chips, light. Cast it like a normal move (attacker→target line) but override `holdTime` to a very large value and `sinkTime`/`shatterDelay` short, so the field erupts and simply stays instead of retracting. New code: none — a `MOVES` row + maybe a `stone`-based palette variant (denser, lower `height`, higher `rubbleChance`) via `options`.
- Effort: **S** — pure data/config, no code changes.
- Risk: low. Only worry is the phase machine still runs `FADE`→`DONE` eventually and disposes the group, so "stays forever" really means "stays for `holdTime` seconds" — fine for a demo hit, not a true persistent hazard without harness changes.

**2. Freeze-Dry mist layer** (ice palette enhancement)
- Recipe: crystals unchanged, plus fx-stream.js's puff system (fx-stream.js 240–278: `InstancedBufferGeometry` quads + `SpriteNodeMaterial` with `aPos/aLife/aSize/aSeed`) added as a new layer that emits cold-mist puffs from each spike's base while it stands, driven off the same `records[]`/`emergence()` state.
- Effort: **S/M** — the puff machinery is proven and copyable near-verbatim; new code is just the emission loop tied to `poseSpikes`.
- Risk: low — this is exactly the pattern the doc's Open Threads (line 135–136) recommends for billboard thinness, applied proactively rather than as a fix. Adds one more draw-call group (5 total vs. today's 4).

**3. Spikes** (ring hazard around self, ice/rock)
- Recipe: keep eruption/poseSpikes/chips/light (302–351) and the `records[]` schema, but replace the band-placement block (188–246) with a ring generator modeled on fx-aurora.js's `buildRing` (fx-aurora.js 84–95) — scatter spike origins evenly around `line.origin` at fixed radius, remap `along` to ring-angle so `triggerUpTo`'s stagger sweeps around the circle instead of down a line (aurora already treats `machine.u` as ring angle, so the phase-machine wiring transfers directly, fx-aurora.js 341–350).
- Effort: **M** — new coordinate generator, no shader work, records schema stays intact.
- Risk: low-medium. No WebGPU trap (still CPU matrix composition only); main risk is tuning stagger/height so it doesn't read as "band effect bent into a circle" rather than a genuine ring hazard.

**4. Icicle Spear / Icicle Crash** (fall-from-above variant)
- Recipe: same geometry/palette/chips/light, but `poseSpikes` gets a "fall" mode: spikes start at `baseY + dropHeight`, ease down (`Easing.outCubic` fall + `outBack` bounce-settle on landing) instead of emerging upward through the ground plane, landing/embedding triggers the existing `emitChips` burst.
- Effort: **M** — new Y-motion branch in `poseSpikes`/`emergence`, same record bookkeeping.
- Risk: medium. Risk of visual pop between "falling" and "embedded" states if the bounce easing isn't tuned; landing timing must still track `eruptTime`/`riseStagger` for the front-follows-line feel.

**5. Crystal Armor (Iron Defense reflavor)** self-buff
- Recipe: eruption/poseSpikes/chips/materials reused; placement generator scatters spike origins on/near a sphere around the attacker's body height (`sourceY`) with lean sourced from radial-outward direction instead of `line.dir`/`line.side` (mirrors the lean math at 221–230 but with a different reference vector).
- Effort: **M** — new placement generator + lean-vector change; timing/eruption code untouched.
- Risk: **contract gap** — `deps`/`cast()` never receives the attacker's `Object3D`/bone transforms, only `line`, `sourceY`, `targetY` (see `demos/pokemon-moves.html` 178–182); the crystals `group` is added straight to `scene` (fx-crystals.js 407), not parented to the walker. So body-mounted spikes anchor to the body's *root position* at cast time but will not follow idle-animation sway — acceptable for a single flourish, wrong for a held buff.

**6. Rock Slide** (crack-network placement)
- Recipe: keep crystals' eruption/render/chips, but generate spike origins by walking a branching crack network like fx-fissure.js's `walkCrack`/`growBranches` (fx-fissure.js 160–196) instead of the straight band. These helpers are **not exported** from `fx-fissure.js`, so the walk algorithm must be reimplemented/copied, not imported.
- Effort: **M/L** — copy+adapt ~40 lines of branch-walking, then reconcile with crystals' `wanted`/`VARIANTS` precomputed slot counts (branch walking produces a variable, stochastic point count that doesn't map cleanly onto the current fixed-`slots`-per-`InstancedMesh` sizing).
- Risk: medium-high — instance-count budgeting (`maxCount` ceiling, `slots = ceil(wanted/VARIANTS)`) currently assumes a known `wanted` up front; a stochastic path walk needs either a two-pass count-then-fill or an over-allocated pool.

**7. Diamond Storm** (thrown volley)
- Recipe: give each spike a pre-emergence "flight" state that interpolates from a muzzle cluster to its final planted `(x,z)` with an arc (conceptually like fx-bolt.js's axis/spread math, fx-bolt.js 190–201, but reimplemented as CPU per-instance matrix lerps rather than a vertex-shader ribbon, since crystals has no shader at all — "Only instance matrices animate," fx-crystals.js line 93), landing into the existing embed/eruption animation.
- Effort: **L** — a genuinely new per-instance lifecycle (`fly → embed → hold → retract`) layered on top of the existing `eruptTime`/`emergence` state machine.
- Risk: highest of the set — timing the flight phase against the phase machine's single `front`/`u` value (currently 1:1 with "erupt when front passes") needs a second, independent per-instance clock; also thematically Diamond Storm is normally a downward rain of shards, so recommend reframing as a variant of recomposition #4 (fall-from-above) rather than a horizontal throw, which reuses more code and avoids the new flight state.

## Observations

- **Reusable logic is trapped in closures.** Everything past geometry/materials (placement, eruption, chips, light, phase wiring) lives inside `createCrystalsFx`'s `cast()` function body, not exported. Every recomposition above means forking into a new `fx-<name>.js` per the doc's "Adding a move" convention (`docs/subsystems/pokemon-moves.md` 122–128), not importing a shared utility — there is no shared placement/eruption toolkit in `move-core.js` despite three modules (crystals, fissure, aurora) independently reinventing "generate points along/around a path, animate them in on a timer."
- **Geometry is palette-agnostic by construction.** All three palettes (ice/stone/psychic) share the exact same three crystal-geometry variants (fixed seed `0xc0ffee`, line 130) — only material/tint differs. A recomposition wanting genuinely different silhouettes per look (e.g., long ice spears vs. blocky rock slabs) needs a second `makeCrystalGeometry`-style generator with its own shape params, which don't currently exist (`sides=6` and all taper/apex ranges are hard-coded inside the function, not in `DEFAULTS`).
- **Chip shape is single and shared** (`chipGeo = new THREE.TetrahedronGeometry(0.5)`, line 133) across every palette — only chip *color* varies. Ice shards and rock rubble currently throw identical-shaped debris.
- **The `records[]` schema is the real extension point.** Any recomposition that keeps the fields `{x, z, baseY, height, radius, quat, stagger, eruptTime, breached, variant, slot}` can swap only the coordinate-generation block (188–246) and get eruption/render/chips/light for free — this is the cheapest, lowest-risk path for #1, #2 (additive), #3, #4, and #6 above.
- **No body/bone attachment in the contract.** `cast({ line, seed, palette, power, sourceY, targetY })` has no way to receive a moving transform, and the effect group is parented to `scene`, not to the caster's rig. Any "grows on the body" idea (armor, buffs anchored to a moving creature) is capped at "anchor once at cast time" unless the harness is changed to reparent effect groups under the attacker's `Object3D`.
- **Nothing here has been rendered yet** (per the subsystem doc's Open Threads, line 132) — all risk assessments above are structural/code-level, not visually verified; WGSL-specific traps (if any recomposition touches TSL, e.g. combining with stream's puffs) remain unverified until run in a browser.

---

# fx-fissure — A

## Parts inventory

**`walkCrack(x, z, dirX, dirZ, maxWalk, curvature, baseDist, rank)`** (lines 161–174). Generic curved-path stepper: walks from a seed point in a direction, drifting by `curvature` rad/step, sampling `terrainHeight` each step. Free-standing — no crack-specific semantics, only `O.pathStep` from the outer closure. The most reusable primitive in the module.

**`buildPath(line)`** (145–158). Turns `line.samples` into the main-crack point list (tangent, side, cumulative `dist`). Free-standing, only needs a `makeLine()`-shaped object.

**`growBranches(main, rnd, total, power)`** (177–196). Orchestrates `walkCrack` into alternating-side forks off the main path, spaced/angled by magic numbers baked in the function body (not in `O`). Coupled to `buildPath`'s point shape (`tx/tz/dist`) and `walkCrack`.

**`growBurst(target, rnd, total, power)`** (199–210). Radial ring of short `walkCrack` runs around a point, ranked so culling always keeps them. Only needs a point + `rnd`; not coupled to the main line at all — a general "radial spray of curved cracks around a point" placer.

**`buildRibbonGeometry(segments, total, rnd)`** (217–253). Path-list → indexed ribbon with `aSide/aAcross/aDist/aJit/aWalk/aMaxWalk/aRank`; needle taper (`PINCH_MAX`, line 79) on main-path ends, uniform width applied later in-shader. Tightly coupled by attribute-name contract to `branchFactors` and both materials.

**`branchFactors(u)`** (258–267). Shared TSL fragment: branch-selection (`sel`), tip-taper, needle dimming, all keyed off `u.branchFrac/u.lenFrac/u.total`. Reusable node-graph piece for any "growing network" shader, but only in combination with the ribbon's attribute names.

**`buildCoreMaterial(u, pal)`** (271–303) / **`buildUnderMaterial(u, pal)`** (306–326). Blackbody seam→warm→hot→peak ramp core, and a wider additive halo underneath. Both consume `branchFactors` + `u.grown/pulse/flash/cool/heat`. The ramp shape and additive/non-additive choice are entirely palette-driven — the most "reskinnable" part of the module.

**Rock-lip system**: `makeRockGeometry`/`getRockGeos` (99–119, jittered flattened box, 3 variants), placement loop in `cast()` (368–412, alternating flip along `main`), `poseRocks` (454–475, static position, `Easing.outBack` scale pop keyed to `grown - r.birth`). Static-position debris that pops through the surface as the front passes.

**Ember particle system**: geometry/material via `getShared().ember` (128–136, radial-falloff quad, additive or not), pool + `spawnEmber`/`updateEmbers` (477–534, rise/drag/gravity CPU integration, hot↔cool tint by palette). InstancedMesh but the material has no `positionNode`, so it's safe under WebGPU (contrast with stream's sprite trap noted below).

**Light spill** (434–449 spawn, 536–545 `updateLights`): acquires up to `O.lightCount` pooled lights, distributes along path fraction, flicker via summed sines, "ignite" ramp when `grown` passes each light's `dist`, extra boost on the last light tied to `flash`.

**Phase-machine wiring** (547–558): `grown = machine.u * total` during TRAVEL; during FADE, `grown` keeps climbing past `total` into the pre-baked burst geometry (`burstReach * Easing.outCubic`) — reveals the impact burst with **zero extra draw calls**. The signature trick of the module; assumes monotonically increasing `grown`.

**`PALETTES`** (30–58) and **`DEFAULTS`** (61–76). Data-only reskin surface: ramp colors, `coreAdditive`, glow color/gain, rock tint/roughness, light color/gain, ember hot/cool/rise/size/life/drag/gravity/additive. Covers "different substance" (magma/shadow/earth) without touching code, but ember *physics character* (rising vs pooling vs flying) is only coefficient-tunable, not swappable — the integration model itself (`updateEmbers`, 505–531) is fixed.

## Recompositions

**1. Bulldoze** (ground)
Recipe: no new code — a `dust` palette (`coreAdditive: false`, dull tan ramp, `lightGain: 0`) plus `DEFAULTS` overrides (`width` up, `rocksPerMeter` up, `travelSpeed` down, `emberAdditive: false`, higher `emberGravity`/`emberDrag` so embers read as flung dirt clods instead of sparks).
Effort: **S** — palette + options only, same code path as `earth`.
Risk: low; "dirt clod" read depends entirely on ember drag/gravity tuning, unverified until rendered.

**2. Explosion** (normal, self-centered blast)
Recipe: cast with a degenerate line (`from===to`, which `makeLine`'s `minLength` fallback already handles); skip `buildPath`/`growBranches`, build the ribbon from `growBurst(line.target,...)` segments only; reuse core/under materials, rock lips and embers unmodified around the single point; near-instant `travelTime` so TRAVEL is imperceptible.
Effort: **S/M** — mostly wiring a `burstOnly` path through `cast()`.
Risk: `total` becomes tiny (≈`minLength`), and `branchFactors`'s taper/pinch math is tuned for real crack lengths — burst-only visuals need power to drive burst radius independently of `total`, unverified.

**3. Magnitude** (ground, repeated tremors)
Recipe: single cast, but during the IMPACT hold, retrigger the existing `flash`/light-boost/ember-burst plumbing 2–5 times at random intervals instead of once, reusing `u.flash`, `spill[].light.intensity` boost, and an ember burst call — no new geometry.
Effort: **S/M** — new timer state in the `cast()` closure driving existing triggers.
Risk: light-spill `ignite` is already saturated after full growth, so repeated intensity boosts stack multiplicatively on top of each other — possible over-bright pulses (ACES tone mapping in the harness should absorb it, but untested).

**4. Sludge Wave** (poison)
Recipe: new `sludge` palette (sickly green/purple ramp, `coreAdditive: false`), rock lips reused as glob mounds (hue shift only); embers swapped for camera-facing sprites borrowed from `fx-stream.js`'s puff pattern (its `SpriteNodeMaterial` + `aPos/aLife/aSize/aSeed`, stream lines 259–278) instead of fissure's flat quads, addressing the doc's own "motes/embers thin edge-on" open thread.
Effort: **M** — palette is cheap, but replacing the ember mesh/update loop with a sprite-attribute system is real new integration code.
Risk: must keep the borrowed sprite mesh a plain `Mesh` over `InstancedBufferGeometry` (as stream does), **not** an `InstancedMesh` — stream's own header (fx-stream.js line 82–84) flags that setting `positionNode`/attribute-driven position on an `InstancedMesh` discards `instanceMatrix` under WebGPU. Fissure's current embers dodge this because their material has no `positionNode`; a sprite swap must dodge it deliberately.

**5. Earth Power** (ground, geyser)
Recipe: keep crack+burst+embers+lights as-is; add one extra mesh — the noise-displaced additive dome from `fx-stream.js` (`positionLocal.add(normalLocal.mul(bump))` + fresnel rim, stream lines 283–293) — stretched vertically and driven by fissure's own `u.flash`/`u.cool` instead of stream's `u.burst`.
Effort: **M** — adapting a foreign material block and wiring its lifecycle to fissure's uniforms.
Risk: two additive layers (ribbon + dome) stacking near the camera can overexpose; the borrowed geometry/material needs its own disposal in fissure's `dispose()`.

**6. Thousand Arrows** (ground, spike volley)
Recipe: use `buildPath`+`growBranches` for the layout, but at each branch/main sample, place an eruption-animated crystal spike (borrow `fx-crystals.js`'s `makeCrystalGeometry`, lines 95–123, and its `Easing.outBack` emergence curve, lines 312–319) driven off fissure's own `grown` value the way rock lips currently are, instead of / alongside the flat basalt rocks.
Effort: **L** — genuine glue code reconciling two different "record" shapes (fissure's rock records vs. crystals' spike records); `makeCrystalGeometry` isn't currently exported, so it'd need exporting or duplicating.
Risk: crystal material (`MeshPhysicalNodeMaterial` with transmission/dispersion) is heavier than fissure's own materials — stacking it onto fissure's already-multi-pass draw (core + underglow + rocks + embers) is a real per-cast cost risk.

**7. Precipice Blades** (ground signature)
Recipe: fissure's main+branch path used purely as a placement curve, feeding fx-crystals' whole along-the-band spike-placement algorithm (halfWidth/lean/along logic, fx-crystals.js 188–236) to erupt large jagged blades flanking the crack, with fissure's core ribbon kept underneath as the visible glowing seam.
Effort: **L** — heaviest hybrid; effectively needs factoring crystals' placement loop out of its own `cast()` or duplicating it.
Risk: highest of the set — two independently-tuned visual systems (glow width vs. blade height/lean) competing for the same ground strip; per the subsystem doc, nothing here has been seen rendered yet, so this needs real in-browser iteration, not just numbers.

## Observations

- `growBranches`'s spacing/angle constants (0.3+rnd·0.5, 0.55+rnd·0.7, etc., lines 180–191) and `PINCH_MAX`/`ROCK_VARIANTS` (78–79) are hard-coded, not in `DEFAULTS` — anyone wanting denser/straighter branches or more rock variety has to edit code, not pass options.
- `walkCrack` and `growBurst` are the cleanest reusable primitives (a curved-path stepper and a radial-curve-burst placer) but aren't exported or shared via `move-core.js` — other modules (aurora's `buildRing`, crystals' placement) reinvent similar radial/curve logic independently rather than sharing it.
- `buildRibbonGeometry` + `branchFactors` + the two materials are a tightly-coupled triad keyed by attribute-name strings (`aWalk`, `aRank`, `aDist`, …) with no schema check — recomposing with a foreign path source (e.g. aurora's ring, crystals' spike records) requires exactly matching this contract, and a mismatch only surfaces as a WGSL compile failure in-browser (per the subsystem doc, Node tests can't catch that).
- The best reusable trick is baking future geometry (the burst) at cast time and revealing it by advancing one monotonic uniform (`uGrown`, onFade lines 552–554) with zero extra draw calls — great for Explosion/Thousand Arrows, but it assumes `grown` only increases, so anything wanting *repeated* reveals (Magnitude) has to ride on `flash`/ember bursts instead, not `grown` itself.
- The palette shape covers color/behavior-coefficient reskinning (fire→dust→ooze) well, but ember *physics character* (rising sparks vs. pooling ooze vs. flying debris) is only coefficient-tunable inside a fixed integration model (`updateEmbers`) — a genuinely different motion (e.g., orbiting, bouncing) needs new code, not new palette numbers.

---

# fx-fissure — B

## Parts inventory

**Palette table** (`PALETTES`, L30–59) — `seam/warm/hot/peak` blackbody stops, `heat`, `coreAdditive`, `glow`/`glowGain` (halo), `rock`/`rockHue`/`rockRough`, `light`/`lightGain`, and a 6-field ember spec (`emberHot/Cool/Additive/Rise/Size/Life/Drag/Gravity`). Free-standing data; every other part reads from it but doesn't need it structurally.

**`DEFAULTS`** (L61–76) — ~25 tunables (width, branch/burst counts, rock/ember rates, light count). Only reachable via `options` passed to `createFissureFx()` at factory time — **not** per-cast. `cast()` only takes `power`, which scales a subset of these multiplicatively (L333, 346–350).

**`makeRockGeometry`/`getRockGeos`** (L99–119) — one-time jagged flattened-box generator, 3 variants cached module-wide. Free-standing: needs only an `rnd()` source, no path/palette coupling.

**`getShared`** (L122–140) — per-palette rock (`MeshStandardNodeMaterial`) + ember (`MeshBasicNodeMaterial`, radial `uv()` falloff × `aEmberCol`) materials, cached across casts. Free-standing given a palette object.

**`buildPath`** (L145–158) — turns `line.samples` into `{x,y,z,tx,tz,sx,sz,dist}` points with tangent/side computed by finite difference. Free-standing; works on any polyline, not just the cast line.

**`walkCrack`** (L161–174) — generic random-walk line generator from a seed point/direction/curvature. The single most reusable part: both branches and the burst are just different call sites of this. Takes no dependency on palette or the main path.

**`growBranches`** (L177–196) / **`growBurst`** (L199–210) — domain-specific wrappers around `walkCrack`: alternating-side branches off the main path, and N radial cracks from a point. Coupled only to `walkCrack` + RNG + `O`.

**`buildRibbonGeometry`** (L217–253) — merges main+branches+burst into one indexed ribbon, baking `aSide/aAcross/aDist/aJit/aWalk/aMaxWalk/aRank`. Tightly coupled to the attribute contract consumed by `branchFactors`/`buildCoreMaterial`/`buildUnderMaterial` — this quartet is one unit.

**`branchFactors`** (L258–268) — shared TSL node logic (branch selection via `aRank` vs `uBranchFrac`, tip taper, needle-point dimming). Reused verbatim by both ribbon materials.

**`buildCoreMaterial`** (L271–303) — the lit crack: `positionNode` widens across `aSide`, `colorNode` is the blackbody ramp with travelling pulse + flicker + front glow + burst flash, `opacityNode` gates on `uGrown` vs `aDist` (openness) and `sel`. This `uGrown`-vs-`aDist` comparison is the trick that makes branches+burst "grow" for free — genuinely elegant but assumes every path segment shares one linear `dist` space rooted at the caster.

**`buildUnderMaterial`** (L306–326) — same attribute reads, wider halo, additive-only, `pal.glowGain`-gated. Structurally a clone of the core material with different width/opacity math — could be factored into a generic "ribbon halo" part.

**Rock lips** (L368–412, animated by `poseRocks` L454–475) — placed once at cast along `main` only (not branches/burst), alternating sides, `Easing.outBack` eruption keyed to `grown - r.birth`. Loosely coupled: only needs points with tangent/side, could ride any path.

**Embers** (L414–534) — instanced quad pool (`InstancedMesh` + per-instance `aEmberCol` vec4), spawn-rate scaled by open crack length × `cool` (L487), sampled from `allPts` filtered by `dist/rank/walked` against current `grown`/`branchFrac`/`lenFrac` (L491–492). Uses flat quads, explicitly flagged in the doc as thinning edge-on — a known weak point.

**Light spill** (L434–449, `updateLights` L536–545) — up to `O.lightCount` pooled lights placed at fractional points along `main`, flicker via double-sine, gated by `pal.lightGain`.

**Phase-machine wiring** (`cast` L547–558) — `onTravel` sets `grown = u*total`; `onImpact` snaps `grown=total`, fires `flash=1`; `onFade` extends `grown` past `total` by `burstReach` (this is what tears the burst open with zero extra draw calls) and ramps `cool`. This orchestration pattern (grown/cool/flash driving everything downstream) is the part most worth copying conceptually into a new effect even where the geometry differs.

**Important structural note**: none of `buildPath`, `walkCrack`, `growBranches`, `growBurst`, `buildRibbonGeometry`, `branchFactors`, `makeRockGeometry` are exported — only `createFissureFx` is. A new module reusing them literally copies the code (matches this repo's existing "ported, not imported" convention), it doesn't `import` them.

## Recompositions

**1. Magnitude** (Ground, self)
Recipe: self-cast fissure — origin = attacker only, no target line. Skip `growBranches`/main-path entirely; drive `growBurst(line.origin, rnd, 0, power)` outward from the caster in all directions, feed straight into existing `buildRibbonGeometry`/`buildCoreMaterial`/`buildUnderMaterial`/rock-lip/ember/light machinery unchanged. Phase machine: no TRAVEL front needed — spawn straight into a short IMPACT-like grow (mirror aurora's `self: true` `travelTime`-only pattern from `fx-aurora.js` L181–199, 341–351) so `grown` ramps 0→`total` over `travelTime` instead of following `u` along a line.
Effort: **S** — reuses every geometry/material/instancing part as-is; only new code is "burst from origin, no main path" (a thin wrapper) plus phase-machine self-cast wiring already proven by `fx-aurora.js`.
Risk: `total` for burst-only cracks is small, so `pinch`/needle-taper math (L220, L229) tuned for long lines may over-taper short radial spikes — needs a width-floor check. Low WebGPU risk since node graph is untouched.

**2. Precipice Blades** (Ground)
Recipe: instead of one `main` path + branches, call `buildPath` on 3–5 parallel lines offset by `line.side * k*spacing` (new code: `buildParallelPaths`), each fed as a `main` into `growBurst`-less `buildRibbonGeometry` (skip `growBranches`, since the corridor itself supplies the branching look). Reuse rock lips (denser, `O.rocksPerMeter` up) and ember/light systems unchanged, with a "stone" palette variant (dim `glowGain`, cool `heat`) rather than `magma`.
Effort: **M** — new path-generation function is small, but `buildRibbonGeometry`/`branchFactors` assume one `main`+branches+burst set sharing one `total`; multiple independent mains need either N separate `uGrown`/`total` uniforms or a shared `total` with per-lane `dist` offset bookkeeping — some rework of `branchFactors`'s `aRank`/`aDist` semantics.
Risk: 3-5x the ribbon vertex count if not careful with segment count; `frustumCulled=false` on every mesh (already the pattern here) means this is pure vertex-shader cost, likely fine, but rock lips scale linearly with lane count and could blow past `O.maxRocks` — needs the cap raised or per-lane budget split.

**3. Sandsear Storm** (Ground/Fire)
Recipe: cracks that *converge inward* on the target rather than radiate from the caster — new function `growInbound(target, rnd, total, power)` mirroring `growBurst` (L199–210) but seeded at points around the target and walking *toward* it (reverse `dirX/dirZ`), each crack's `aDist` measured backward from `total` so `uGrown` (still advancing 0→total from the caster's `machine.u`) reveals them in reverse order — needs an `aDist' = total - aDist` remap in `branchFactors`/`buildCoreMaterial`, or a second uniform space. Add a fire-ish ember burst at the convergence point using existing ember rise/gravity fields with `emberGravity` near 0 for float-up "storm" motion. Borrow nothing from other modules — this is fissure alone, restructured.
Effort: **M** — the new walker is a copy-paste-and-flip of `growBurst`; the distance-remap is the real work since `uGrown`-vs-`aDist` (L283, 318) is baked into both materials.
Risk: getting the "openness" direction backwards is an easy sign-flip bug that would show as the crack appearing fully-grown instantly or never opening — only visible in-browser (Node tests won't catch TSL sign errors per the doc's own "Open threads" caveat).

**4. Rock Slide** (Rock)
Recipe: drop `makeRockGeometry`/`getRockGeos` chunks from above along the line instead of heaving them from the ground — replace `poseRocks`'s `outBack` ground-eruption pose with a fall-and-bounce integrator borrowed from **`fx-crystals.js`'s `updateChips`** (L279–300: gravity, ground-plane bounce with restitution, per-instance spin). No crack ribbon, no ember system, no lights beyond a single dust-impact flash (reuse `buildUnderMaterial`'s falloff shape, retargeted to a flat ground decal like **`fx-stream.js`'s decal disc**, L295–304).
Effort: **M** — rock geometry/instancing is a straight lift; the fall/bounce loop is a straight lift from crystals; the glue (spawn rocks in the air along the line at cast time, release on ground contact) is new.
Risk: dropped-rock initial positions need a "sky" anchor with no existing part providing one (line samples are ground height) — must invent an offset-above-terrain seed position; instance count (up to `O.maxRocks`=90) falling simultaneously could look sparse for a "slide" without tuning up the count/geometry variety.

**5. Will-O-Wisp** (Fire/Ghost)
Recipe: make the ember system (L414–534) the *only* visual — no ribbon, no rock lips. Spawn 3–6 large "wisp" embers that drift along the line toward the target using the existing rise/drag/gravity integrator, but replace the flat-quad `emberGeo`/`PlaneGeometry` (L415) with **`fx-stream.js`'s `SpriteNodeMaterial` instanced-attribute pattern** (L265–278) so the flames billboard instead of thinning edge-on — this directly resolves the doc's own flagged weakness ("Open threads": motes/embers/sparks are flat quads). Each wisp carries its own flickering light (reuse the light-spill pattern, 1 light per wisp not per seam-position).
Effort: **M** — ember spawn/integrate logic is a near-direct reuse; swapping geometry type from `InstancedMesh`+`PlaneGeometry` to `SpriteNodeMaterial`+`InstancedBufferGeometry` (per `fx-stream.js`'s documented WebGPU trap, L82–84 of that file) is a real material rewrite, not a parameter change.
Risk: the exact trap `fx-stream.js`'s own docblock warns about — `positionNode` on an `InstancedMesh` material discards `instanceMatrix` under WebGPU — must be avoided by following stream's non-`InstancedMesh` `SpriteNodeMaterial` approach exactly, not fissure's ember approach.

**6. Spikes** (Ground, hazard)
Recipe: rock lips alone, no ribbon or embers — scatter rock instances in a patch on the target's side using `growBurst`'s radial-walk points purely as *placement seeds* (ignore the crack-drawing use of its output), feed positions straight into the existing rock instancing + `poseRocks` eruption, skip everything else.
Effort: **S** — smallest new-code footprint of the six, since it deletes more than it adds.
Risk: this is a persistent-hazard move concept (stays on the field after the caster's turn) but the module's `Phase` machine (IDLE→TRAVEL→IMPACT→FADE→DONE, L38 of `move-core.js`) is built for a transient cast — Spikes would need to hold in IMPACT indefinitely or the harness would need a "persistent effect" concept it doesn't currently have (`demos/pokemon-moves.html` disposes on `!alive`, L339–343). Contract fit is the real risk here, not the graphics.

## Observations

- **Per-cast customization is thinner than the parts suggest.** `cast({line, seed, palette, power})` only exposes `power` as a continuous knob (L333, 346–350); everything in `DEFAULTS` (branch count, rock density, ember rate, path step) is fixed at `createFissureFx(deps, options)` factory time. Recompositions that want a structurally different look (fewer/no branches, parallel lanes, inbound instead of outbound) either need a second factory instance with different `options`, or the internal functions extracted into a shared file so a sibling module (`fx-<name>.js`) can call them with its own parameters rather than fork the whole file.
- **Internal helpers are private.** `walkCrack`, `buildPath`, `growBranches`, `growBurst`, `buildRibbonGeometry`, `branchFactors`, `makeRockGeometry` are not exported. Every recomposition above that "reuses" them really means copy-pasting them into a new module, same as this module itself was ported rather than imported from the GeometryPainterThreeJS reference. Worth extracting `walkCrack` + the rock/ember instancing helpers into a shared util if more than one or two of these recompositions get built, since they're genuinely path-agnostic.
- **The `uGrown`-vs-`aDist` reveal trick is the module's best idea and its biggest constraint.** It's what lets branches and the burst open in the same draw call with no extra cost (L283, L318), but it hard-assumes one monotonic distance space rooted at the caster reaching outward. Any "reversed" or "multi-source" recomposition (Sandsear Storm, Precipice Blades) has to either fight that assumption or duplicate the ribbon/material pair per distance-space, which is the main effort driver in those two proposals.
- **Palette contract has an undocumented required shape for reuse.** New palettes for a converging/self/dropped variant still need every field `getShared`/`buildCoreMaterial`/light code reads (`pal.rockHue`, `pal.lightGain`, `pal.emberRise` etc., L36–58) even if the recomposition doesn't use, say, embers — otherwise `pal.emberRise[0]` (L496) throws. A recomposition that drops a whole part (e.g. Spikes dropping embers/lights) should either still stub those palette fields or the cast code must skip the corresponding update calls, which today aren't individually toggleable (ember/light updates run unconditionally once the instance exists, L568–570).
- **Width and glow width are uniform-driven, not baked into geometry** (`u.width`, `u.glowWidth`, L346–347), so re-theming crack thickness for a corridor/blade look (Precipice Blades) is cheap — no geometry rebuild needed for width changes, only for path topology changes.

---

# fx-aurora — A

## Parts inventory

**`buildRing(segments, radius, ox, oy, oz, terrainHeight)`** — `fx-aurora.js:84-95`. Produces a closed polar-sampled ring of points around a center, terrain-snapped, each carrying `{x,y,z,u,sx,sz}` (u = angle fraction 0..1, sx/sz = radial outward unit vector). Params: `segments`, `radius`, center (currently hardcoded to `line.origin` at the call site, line 193). Free-standing — no dependency on curtain/hem code. Feeds `buildCurtainGeometry`, `buildHemGeometry`, and the CPU mote/light placement, so it's the shared substrate everything else sits on.

**`buildCurtainGeometry(THREE, ring, rows, jitPhase)`** — `fx-aurora.js:98-138`. Ring×height grid with `aSide` (radial dir), `aU` (angle), `aV` (height 0..1), `aColJit` (per-column crest jitter, baked from `jitPhase`). Tightly coupled to `buildRing`'s output shape and to `curtainMaterial`'s attribute names.

**`buildHemGeometry(THREE, ring)`** — `fx-aurora.js:141-169`. Two-row ring strip flat on the terrain (`aSide`, `aAcross`, `aU`). Independent of the curtain — only needs `ring`.

**`curtainMaterial(phase, stature, dim)`** — `fx-aurora.js:215-261`, a factory closure. The core shading kit: unfurl-front clip (`smoothstep` on `uGrown - aU`, line 228), hem-pinned lift (`lift`, line 229), layered sine sway/ripple keyed to `foldPhase` (lines 231-237), fold-light that reuses `foldPhase` for brightness (line 244), vertical ray striations (line 245-246), hem/mid/top gradient vs. spectrum-cycle color blend (lines 249-253), fade-thin opacity (lines 258-259). Parameterized by `phase` (temporal offset, lets one geometry be drawn twice as de-synced front/back sheets, lines 263-264), `stature`/`dim` (scale down a second sheet). Tightly coupled to `buildCurtainGeometry`'s attribute names but the shading math itself (sway/ripple/gradient) is portable to any `(aU, aV)`-parameterized surface.

**Hem glow material** — `fx-aurora.js:267-283`, inline (not factored into a function). Flat additive ground ring, falloff on `aAcross`, shimmer via `cos` on `aU*FOLD_FREQ`. Depends only on `buildHemGeometry`'s attributes; easy to extract into its own function.

**Integer-harmonic seam trick** — `FOLD_FREQ/SWAY_FREQ/RIPPLE_FREQ/RAY_FREQ` (lines 39-42) plus the `jitPhase` seeded-sine sum (lines 111-114). Not parameters (module consts), but the *technique* — every periodic term is an integer multiple of ring angle so a closed loop has no seam — is the single most reusable idea in the file, applicable to anything ring/dome-shaped.

**Motes** — geometry/material `fx-aurora.js:287-318`, CPU update `353-369`. `InstancedMesh` of flat `PlaneGeometry` quads, GPU twinkle from `hash(instanceIndex)` (line 293-295), CPU-placed on the ring with height clustered toward the hem (`Math.pow(rnd(),1.4)`, line 311) and swaying via a scalar mirror of the vertex-shader sway. Loosely coupled — only needs `ring`, `grown`, `fade`, `height`.

**Light spill** — setup `320-335`, update `371-380`. Pooled `PointLight`s (`lightPool.acquire/release`) placed around the ring at `radius*0.9`, alternating `warm`/`cool` palette colors, breathing intensity, gated by `grown`. Loosely coupled — only needs ring angle + `grown`/`fade`.

**Phase-machine wiring** — `339-351`. Reinterprets `machine.u` as *angle swept around the loop* rather than distance along a line (`onTravel` sets `grown = max(grown, this.u)`), and continues advancing `grown` past 1 during FADE to unfurl slightly further before sinking. This is a distinct pattern from every other module (all of which treat `u` as linear travel) — good for anything that "closes a loop" rather than "arrives somewhere."

**Palettes** — `44-49`: `{hem, mid, top, spectrum}` — a 3-stop gradient plus an optional spectrum-cycle toggle (`uSpectrum`, blended in at line 253 via `mix(grad, spec, uSpectrum)`).

**`DEFAULTS`** — `51-70`. Every geometric/behavioral knob (`radius, height, wave, flow, rays, brightness, motes, lightSpill, segments, heightSegs, hemWidth, unfurlWidth`, timing) is override-able through `options` at factory level — good coverage, see Observations for what's *not* here.

## Recompositions

**1. Screech / Roar** — sound-shock startle, self-buff-shaped but read as an outward pulse.
Recipe: reuse `buildHemGeometry` + the inline hem material (`fx-aurora.js:141-169`, `267-283`) only. Spawn 3-4 hem rings at cast time with a staggered start time and drive each one's `uHemW`/opacity on its own timer instead of `uGrown`. New code: a small per-ring stagger driver (~15 lines), harsh white/grey palette entry. No curtain, no motes, no lights.
Effort: S — reuses one proven geometry+shader pair verbatim, only adds a tiny CPU stagger loop.
Risk: lowest of the set. Only wrinkle: faking radial expansion via `group.scale` instead of rebuilding geometry per ring will also scale `uHemW` (a world-space uniform, line 276), so width would grow unintentionally with radius — needs `uHemW.value /= scale` correction.

**2. Light Screen / Reflect** — psychic wall, dome or partial-arc curtain instead of full ring.
Recipe: new `buildArc(segments, angleSpan, radius, ...)`, a ~20-30 line variant of `buildRing` (84-95) that samples a sub-range of angle and doesn't close the loop (no repeated first/last point). Feed it into unmodified `buildCurtainGeometry` + `curtainMaterial` (front sheet only, or front+back for parallax) and the hem material for a ground anchor line. New palette (silver/pale blue "screen": low `rays`, higher `brightness`). `motes` optional (sparkle) or dropped.
Effort: S/M — one new geometry function; shading math untouched.
Risk: low. `unfurl = smoothstep(0, unfurlWidth, uGrown - aU)` (line 228) and the ray/fold phase math assume `aU` spans a known range — over a partial arc this still works, but light-spill placement (currently `u = i/lightCount` around a full TAU, line 326) needs to be re-scaled to the arc's angular span or lights cluster on the wrong side.

**3. Toxic Spikes** — ground hazard ring cast on the opponent's side instead of self.
Recipe: swap `line.origin` → `line.target` at the two call sites (`fx-aurora.js:190, 193`) behind a `centerOn` option. Keep the hem ring (recolored toxic purple/green), collapse curtain `height` to near-zero (short murk wisps) or drop it. Borrow **fx-crystals'** `makeCrystalGeometry` (`fx-crystals.js:95-123`) to instance a handful of barbed spike-lets at `ring` positions, erupting via `Easing.outBack` keyed off aurora's own `grown` (mirroring fx-crystals' `emergence()` pattern at `fx-crystals.js:313-319`, but driven by aurora's timeline instead of crystals' own machine). Motes recolored into slow toxic bubbles.
Effort: M — the center swap is trivial; the crystal-instance cross-import is real integration work (new adapter code, no existing seam between the two modules' data shapes).
Risk: real spikes-type moves are a *persistent* field hazard (stays for many turns), but `move-core.js`'s phase machine always ends in DONE→dispose (`move-core.js:129-136`, harness disposes on `!alive`, `demos/pokemon-moves.html:339-343`). There's no "leave a residual mesh behind" contract — treat this as a single-cast visual only, not true persistence, and say so.

**4. Safeguard** — protective dome overhead instead of an open ring curtain.
Recipe: new `buildDomeGeometry` (lat/long shell instead of ring×height), reusing `curtainMaterial`'s sway/ripple math (lines 233-237) by re-pointing which axis it perturbs (radial `aSide` → a new spherical-normal attribute). Keep hem ring at the base, keep light spill, drop or shrink motes. Pale gold/white palette.
Effort: M — genuine new geometry, but the shading logic ports almost verbatim.
Risk: the seamless-ring trick only covers the equator seam; the poles (all longitude lines meeting at the zenith) need explicit degenerate-triangle handling, and an unlit `DoubleSide` additive dome risks looking flat/washed-out from inside — unverified until rendered, per the module's stated "nothing here has been seen rendered yet" caveat.

**5. Iron Defense / Cotton Guard** — rigid armor plates erupting around the caster.
Recipe: use `buildRing` purely for anchor placement (not for shading). At each anchor, instance a flattened variant of **fx-crystals'** `makeCrystalGeometry` (`fx-crystals.js:95-123`), oriented tangent-to-ring using **fx-fissure's** `makeBasis`-from-tangent trick (`fx-fissure.js:388-392`) instead of pointing straight up. Growth staggered off aurora's `grown` front, `Easing.outBack` per plate (fx-crystals' `emergence()` idea, `fx-crystals.js:313-319`). Metallic palette, `MeshStandardNodeMaterial` (not aurora's unlit `MeshBasicNodeMaterial`).
Effort: L — combines aurora's shader-ribbon approach with crystals' rigid-instance approach; almost none of `curtainMaterial` survives, only `buildRing`'s layout and the phase timing.
Risk: switching to a lit material means the pooled point lights (decorative in aurora) become load-bearing for visibility — needs real tuning to not look flat. Also doubles cast-time CPU cost (ring anchors + per-plate records).

**6. Trick Room** — warped overhead grid, field-wide.
Recipe: replace `buildCurtainGeometry`'s single ring×height grid with a new `buildDiscGridGeometry(rings, spokes)` (radial disc, not vertical curtain), reusing the sway math from `curtainMaterial` (lines 233-237) with `lift` zeroed and the perturbation applied in-plane (XZ) instead of Y. Add a checkerboard term to `colorNode` via `mod(floor(u*spokes)+floor(r*rings), 2)`. Dark purple "warp" palette.
Effort: L — a new 2D grid geometry plus new shading math.
Risk: `mod`/`floor` combos for a checker pattern aren't used anywhere in these five modules — per the project's own "verify TSL node names against the build" lesson, this is unverified TSL surface. A large flat additive disc overhead with `depthWrite:false` also risks double-blending oddly when the camera looks through it from underneath.

**7. Rain Dance** — arena-wide, multi-turn weather.
Recipe: scale `buildRing` to the arena radius (9m, matching `demos/pokemon-moves.html:129`), drop the curtain, repurpose motes as falling raindrops using **fx-stream's** velocity/gravity/drag integrator (`fx-stream.js:111-139`) instead of aurora's twinkle-in-place drift, and swap the flat-quad `InstancedMesh` motes for **fx-stream's** `SpriteNodeMaterial` instanced-attribute billboarding (`fx-stream.js:265-278`) — which also happens to fix the doc's known "motes thin edge-on" flaw (`pokemon-moves.md:135-136`).
Effort: L — new particle integrator, new material approach, and a structural mismatch (see risk).
Risk: this is a genuine **contract gap**, not just implementation risk. Real weather persists for several turns; `move-core.js`'s `IDLE→TRAVEL→IMPACT→FADE→DONE` machine (`move-core.js:17,38`) and the harness's dispose-on-`!alive` loop (`demos/pokemon-moves.html:339-343`) only support one bounded animation per cast. Doing this properly needs either a new "ambient/persistent" phase or a harness-level concept for field effects that doesn't exist anywhere in the subsystem yet.

## Observations

- **Harmonic constants aren't options.** `FOLD_FREQ/SWAY_FREQ/RIPPLE_FREQ/RAY_FREQ` (`fx-aurora.js:39-42`) live as module consts, not in `DEFAULTS`. Any recomposition wanting a calmer or more chaotic wave character (e.g. Safeguard vs. Cosmic Power) has to edit source, not pass `options`.
- **Center is hardcoded to `line.origin`.** `cast()` (line 190, 193) never reads `line.target`, so self-buff-shaped code can't currently draw on the opponent without a source edit — a one-line gap given the registry already has a `self` flag to key off of.
- **No material pooling.** Unlike `fx-bolt`'s `takeRig/giveRig` pool (`fx-bolt.js:291-355`) or `fx-stream`'s `acquireKit/releaseKit` pool (`fx-stream.js:319-336`), `curtainMaterial()` builds fresh `NodeMaterial`s every cast (materials pushed into a local `materials[]` array, never cached by palette). A recomposition that fires often (e.g., a re-triggered shield) will pay repeated WGSL compilation that the sibling modules specifically avoid.
- **Motes are flat quads, not billboards** (`moteGeo = new THREE.PlaneGeometry(1,1)`, line 179) — the same edge-on-thinning flaw the subsystem doc already flags (`pokemon-moves.md:135-136`). `fx-stream`'s `SpriteNodeMaterial` instanced-attribute pattern (`fx-stream.js:265-278`) is the documented, drop-in fix and reuses the same `hash(instanceIndex)` twinkle.
- **The ring-closure phase trick is undocumented at the contract level.** Treating `machine.u` as "angle around a closed loop" rather than "distance along a line" (`onTravel`, line 343) is a genuinely reusable idea for any loop-closing effect, but it's a local reinterpretation baked into this file — `move-core.js`'s doc comment only describes the linear-travel meaning. A future module wanting the same trick has to reverse-engineer it from `fx-aurora.js` rather than from the contract doc.
- **Parts are free-standing but not exported.** `buildRing`, `buildCurtainGeometry`, `buildHemGeometry`, `curtainMaterial`, and the inline hem material are all decoupled enough to lift into a smaller effect (e.g. Screech only needs the hem pair) — but nothing here is exported for reuse by another module; every recomposition above has to copy code rather than import it.
- **Scratch state is a shared module-level singleton** (`_m4,_v3,_sc,_zero`, `initScratch`, lines 73-81), seeded once from the first `THREE` seen. Fine in isolation, but a naive merge of aurora with crystals/fissure (which each declare their own similarly-purposed `S`/scratch objects) would need renaming to avoid collisions if ever consolidated into one file.

---

# fx-aurora — B

## Parts inventory

- **`buildRing`** (lines 84–95) — samples a closed circle of `radius` around an `{ox,oy,oz}` origin on the terrain, returns `cols = segments+1` points in *local* space `{x,y,z,u,sx,sz}` (`u` = normalized angle, `sx/sz` = radial outward unit vector). Free-standing: only needs `segments`, `radius`, an origin, and `terrainHeight`. Nothing else in the file depends on it being centered on `line.origin` specifically — it's handed raw coordinates.
- **`buildCurtainGeometry`** (98–138) — turns a ring into a `cols × rows` grid (`aSide`, `aU`, `aV`, `aColJit` attributes), every vertex pinned at the hem (`y = ring.y`); height happens entirely in the vertex shader. Coupled to `buildRing`'s output shape and to the `jitPhase` 3-tuple (crest-jitter seeds, itself a free-standing bit of math at 110–114: three integer-harmonic sines summed, no smoothstep needed since it's per-column not per-vertex).
- **`buildHemGeometry`** (141–169) — a flat two-row ring strip (`aSide`, `aAcross`, `aU`) lying on the terrain, width applied in the vertex stage. Independent of the curtain grid — only needs `ring`. Reusable for *any* ground-hugging glow along a closed or open path.
- **`curtainMaterial(phase, stature, dim)`** (215–261) — the core shaping function. Takes three cheap params (phase de-sync for a second sheet, height-scale "stature", brightness "dim") and returns a `MeshBasicNodeMaterial` with:
  - `positionNode`: `lift` (unfurl-front-gated height rise, 229) + `sway`/`ripple` (fold + secondary sway + ripple, 231–241), all indexed by integer harmonics of ring angle (seamless close).
  - `colorNode`: hem→mid→top gradient, `folds` term reusing the *same* `foldPhase` as the vertex sway (243–244, the "glow rides the moving cloth" trick), `rays` striations, `hemBoost`, optional `spectrum` rainbow cycle (251–253) blended in via `uSpectrum`.
  - `opacityNode`: unfurl mask × feather flicker × fade-thin (257–259).
  Tightly coupled to the attribute set from `buildCurtainGeometry` and to the uniform block below; not usable standalone without that geometry.
- **Uniform block** (198–210): `uGrown` (unfurl front, 0–1 angle), `uFade`, `uHeight`, `uWave`, `uFlow`, `uRays`, `uBright`, `uSpectrum`, `uHemW`, `uHem/uMid/uTop` colors. All live-tunable per frame; this is the actual "API surface" of the curtain look.
- **Integer harmonic constants** `FOLD_FREQ=6`, `SWAY_FREQ=11`, `RIPPLE_FREQ=22`, `RAY_FREQ=34` (39–42) — module-level, **not** exposed through `options`/`DEFAULTS`. This is what makes the closed ring seamless (a test asserts it per the doc). Free-standing idea (integer-harmonic angular noise for closed loops) but hardcoded, not parameterized.
- **Hem-glow material** (267–282) — standalone additive strip, only needs `ring` + `uGrown`/`uFade`/`uHemW`/colors. Genuinely decoupled from the curtain.
- **Motes** (287–318 build, 353–369 `updateMotes`) — `InstancedMesh` of flat `PlaneGeometry` quads, GPU twinkle via `hash(instanceIndex)` in `colorNode`/`opacityNode` (293–300), CPU places them on the ring and approximates the same sway/lift math per-instance (360–362) so they read as part of the same silk. Free-standing dust/spark system for any ring-shaped placement. **Known flaw** (per subsystem doc's open threads): flat quads thin out edge-on; not billboarded.
- **Light spill** (321–335 build, 371–380 `updateLights`) — up to `lightCount` pooled `PointLight`s placed around the ring at `radius*0.9`, igniting as `grown` passes their angle, alternating warm/cool tint, sine "breathe". Coupled to the `grown`/`u` angular-sweep semantics but the ignite-by-arrival pattern generalizes to any front-driven set of lights.
- **Phase-machine wiring** (339–410) — the distinctive part: `machine.u` is used as an **angle around a closed ring**, not distance along a line (`line.target` is unused, self-buff only). `onFade` keeps advancing `grown` *past* 1 by `unfurlWidth` so the unfurl-front math doubles as the retract-front math (346) — a nice zero-extra-state trick, but it hardwires "ring only shrinks, never regrows."
- **`PALETTES`** (44–49) — `hem/mid/top` gradient + `spectrum` flag (0/1) that switches the rainbow-cycle blend on. Data-only, freely swappable.
- **`DEFAULTS`** (51–70) — most tunables are exposed; notably the `power` scaling curves in `cast()` (`Math.pow(power, 0.3)` for radius, `0.35` for height, line 184–186) are **not** in `DEFAULTS`/`options`, so they can't be overridden per-move without editing the module.

## Recompositions

**1. Curse** — S — most confident, smallest diff from what exists.
Recipe: same ring/curtain/hem/motes/lights kit verbatim, dark `shadow`-style palette (`spectrum: 0`, near-black hem, blood-red top). New code: one `invert` flag threaded into `curtainMaterial`'s `lift` term (229) so the curtain rises from a sunk state instead of falling from a hem, and `onFade`/`onTravel` reworked so the ring sinks first (ritual buildup) and *flares* on `onImpact` rather than the current monotonic unfurl→hold→sink. Reuses `foldPhase`-locked glow (243–244) unchanged for the "pulsing rune" read.
Risk: low — it's parameter/sign changes inside an already-working node graph, no new geometry, no new attributes.

**2. Sing** — S — very confident, but intentionally shallow.
Recipe: drop the curtain and hem meshes entirely; keep only `buildRing` (as a placement path) + the motes system (287–318/353–369, repalette as soft sparkles instead of dust) + one or two lights from the light-spill pool. Pastel palette, `radius` small, long slow `flow`.
Risk: this directly hits the doc's flagged flaw — flat, unbillboarded quads thin out edge-on (open thread) — more noticeable here since motes are now the *entire* visual, not a garnish on a curtain. Also least "central" recomposition since it discards the module's signature part (the curtain).

**3. Sandstorm** — S/M — confident, mostly subtractive.
Recipe: drop the curtain; keep `buildHemGeometry` scaled to a large `radius` (whole arena) for a ground-hugging haze ring, plus motes repurposed as blowing sand (much higher count, drifting outward instead of hem-clustered), plus dimmed light spill. New code: the phase machine currently has fixed `impactTime`/`fadeTime` durations (340–350) — a persistent weather effect needs a "hold indefinitely, dispose on command" mode, which isn't in `createPhaseMachine`'s contract (IDLE→TRAVEL→IMPACT→FADE→DONE always terminates). Would need either an artificially huge `impactTime` or a small opt-in "hold forever" affordance in `move-core.js`.
Risk: mostly parameter/count changes are safe; the open-ended-hold requirement is a genuine contract gap (see Observations).

**4. Safeguard** — M — moderate confidence, real new geometry but low new-math risk.
Recipe: keep `buildRing`, `buildHemGeometry`, motes, light spill unchanged; add a **new dome-cap geometry** (latitude/longitude patch whose equator matches the ring, closing overhead) driven by an extension of the same `curtainMaterial` position logic — `lift` becomes "distance to pole" instead of "row index v", reusing the identical `foldPhase`/`sway`/`ripple` terms so the dome shimmers the same way the curtain does. Motes converge upward to "seal" the dome at `onImpact`.
Risk: WGSL correctness of a sphere-cap parameterization built by hand (not from a THREE.SphereGeometry, to keep the seamless-angle trick) is the real unknown; moderate compile/appearance risk, no contract issues.

**5. Will-O-Wisp** — M — moderate confidence, cross-module borrow.
Recipe: keep `buildRing` (orbit path), light spill (breathing point lights, repalette fire), and the phase machine's ring-angle semantics; **replace** the curtain+motes with an orbiting flame system borrowed from `fx-stream.js`'s puff pattern (there: `SpriteNodeMaterial` + instanced `aPos/aLife/aSize/aSeed`, CPU-integrated with velocity/gravity/drag). Here the "velocity" is angular (orbit around the ring) rather than a jet. Hem glow stays as scorch-on-ground under each flame.
Risk: the subsystem doc explicitly flags the trap this must respect — `positionNode` on an `InstancedMesh` material discards `instanceMatrix` under WebGPU, which is exactly why `fx-stream.js` uses a plain `Mesh` + `SpriteNodeMaterial` with instanced attributes instead of `InstancedMesh` for its puffs (fx-stream.js doc comment, ~80–84). Aurora's own motes *do* use `InstancedMesh` today (302) because they only touch `setMatrixAt`, never `positionNode` — so this borrow must follow stream's pattern, not aurora's, or it silently breaks.

**6. Trick Room** — M — lower confidence, needs a genuinely new shading idea.
Recipe: replace the curtain with a **new filled disc** (not a curtain wall — a horizontal spinning floor plate), built the way `fx-stream.js`'s impact decal is built (`CircleGeometry` + radial `uv()` falloff, fx-stream.js ~295–304) but driven by aurora's integer-harmonic angle math for a spinning checkerboard (`step()` grid on angle × radius bands instead of `sin()` billow). Keep the hem-glow ring, unmodified, as the disc's rim light.
Risk: mixing a *filled* radial UV space with the *ring's* per-column angle attribute means re-deriving a radius attribute that doesn't exist anywhere in this module today (everything here is defined at a fixed `radius`); getting a seamless checker (no angular tearing, no radial popping as the "grown" front sweeps outward) is nontrivial new TSL.

**7. Icy Wind / Chilling Shockwave** — L — least confident, biggest structural break.
Recipe: an expanding ring shockwave that travels from caster toward target — this violates the module's core assumption that `line.target` is unused and the ring is static at cast time. Would reuse `curtainMaterial`'s billow/fold shading verbatim, but `buildRing`/`buildCurtainGeometry` would need to be built once at *max* radius and then revealed via a `uGrown`-style radial uniform (mirroring how `fx-fissure.js` reveals a pre-built ribbon via `uGrown` rather than rebuilding geometry per frame, fx-fissure.js 283/319) instead of aurora's current angular reveal. Also needs the ring plane to bias toward the target direction rather than being rotationally symmetric.
Risk: highest — repurposing "grown" from angular-sweep to radial-sweep changes the geometry-reveal math throughout `curtainMaterial`, `buildHemGeometry`'s reveal, and motes' `m.u > grown` gating (357) all at once; any one left on the old angular semantics will look broken. Also cost: a full-radius ring built up front is heavier than the small self-buff ring this module was sized for.

## Observations

- **Harmonic frequencies are hardcoded, not options.** `FOLD_FREQ/SWAY_FREQ/RIPPLE_FREQ/RAY_FREQ` (39–42) live outside `DEFAULTS`, so any recomposition wanting a calmer or busier weave (Curse's slow dread vs. Sing's light flutter) has to edit the module rather than pass `options`. Worth promoting into `DEFAULTS` before building several palette-siblings off this file.
- **`power` scaling curves are inline, not tunable.** The `Math.pow(power, 0.3)`/`0.35` exponents for radius/height (184–186) aren't in `DEFAULTS`. Every recomposition above that wants a different power-response curve (e.g. Safeguard should probably barely grow with power, Sandstorm should grow a lot) needs a code edit, not an options override.
- **The self-only assumption is load-bearing, not incidental.** `line.target`/`line.dir` are genuinely never read; `buildRing` bakes the origin once at cast time. Any "traveling" recomposition (#7) is fighting the grain of the module, not extending it — flagged accordingly with L effort.
- **No open-ended hold mode.** `createPhaseMachine` always terminates via FADE→DONE; a persistent field effect (Sandstorm) needs either a very large `impactTime` (hacky) or a small contract addition (e.g., `impactTime: Infinity`-safe handling, or a `hold` flag) in `move-core.js` — a shared gap, not aurora-specific, but this module is the one that would first want it.
- **Motes' flat-quad limitation is inherited by every recomposition that leans on them** (Sing, Sandstorm, Will-O-Wisp's embers) — worth fixing once (billboard via `SpriteNodeMaterial`, the pattern `fx-stream.js` already uses) rather than working around it per-move.
- **`curtainMaterial`'s `phase/stature/dim` parameters (215)** are already a clean small seam for variation — the back-sheet trick (263–264: same geometry, second material instance with different phase/stature/dim) is directly reusable for e.g. Safeguard's dome-vs-ring split without new geometry code, just a third `curtainMaterial(...)` call.
